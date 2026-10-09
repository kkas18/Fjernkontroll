package no.fjern.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.Socket
import java.nio.file.Files
import java.security.KeyStore as JavaKeyStore
import java.security.cert.X509Certificate
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * Regresjon (2.10.3): på Telia-boksen startet ingen app, og market://-lenken fikk forbindelsen til å falle.
 * Falsk Android TV-boks over ekte TLS som bare åpner appen med én bestemt lenke, avviser én og faller ut på market://.
 */
class AndroidTvLaunchLiveTest {
    private class FakeBox(val reportApps: Boolean = true, val onLink: (String) -> String) : AutoCloseable {
        val links = CopyOnWriteArrayList<String>()
        @Volatile var currentApp = "com.google.android.tvlauncher"
        private val server: SSLServerSocket
        val port: Int

        init {
            val identity = X509.create("atvremote")
            val keys = JavaKeyStore.getInstance("PKCS12").apply {
                load(null, null)
                setKeyEntry("box", identity.privateKey, CharArray(0), arrayOf(identity.certificate))
            }
            val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keys, CharArray(0)) }.keyManagers
            val trustAll = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            val context = SSLContext.getInstance("TLS").apply { init(keyManagers, arrayOf(trustAll), null) }
            server = context.serverSocketFactory.createServerSocket(0, 10, InetAddress.getLoopbackAddress()) as SSLServerSocket
            server.wantClientAuth = true
            port = server.localPort
            thread(isDaemon = true) {
                while (!server.isClosed) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: break
                    thread(isDaemon = true) { serve(socket) }
                }
            }
        }

        private val outs = CopyOnWriteArrayList<java.io.OutputStream>()

        private fun reportApp(out: java.io.OutputStream, label: String = "") {
            if (reportApps) out.write(Proto.frame(Proto.encode(20 to Proto.encode(1 to Proto.encode(1 to 1, 10 to label.ifEmpty { null }, 12 to currentApp)))))
        }

        /** Boksen melder at en app er åpnet med fjernkontrollen på TV-en. */
        fun open(pkg: String, label: String = "") {
            currentApp = pkg
            outs.forEach { runCatching { reportApp(it, label) } }
        }

        private fun serve(socket: Socket) = runCatching {
            socket.use {
                val out = socket.getOutputStream()
                outs += out
                out.write(Proto.frame(Proto.encode(1 to Proto.encode(1 to 622, 2 to Proto.encode(1 to "Play-boks", 2 to "Telia")))))
                val reader = Proto.FrameReader { payload ->
                    val fields = Proto.decode(payload)
                    if (fields.has(1)) out.write(Proto.frame(Proto.encode(2 to Proto.encode(1 to 622))))
                    if (fields.has(2)) reportApp(out)
                    if (fields.has(90)) {
                        val link = fields.message(90)?.text(1).orEmpty()
                        links += link
                        when (val action = onLink(link)) {
                            "error" -> out.write(Proto.frame(Proto.encode(3 to Proto.encode(1 to 0, 2 to payload))))
                            "drop" -> socket.close()
                            else -> if (action.startsWith("open:")) { currentApp = action.removePrefix("open:"); reportApp(out) }
                        }
                    }
                }
                val buffer = ByteArray(8192)
                val input = socket.getInputStream()
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    reader.feed(buffer, read)
                }
            }
        }

        override fun close() = server.close()
    }

    private fun session(box: FakeBox, dir: File, scope: CoroutineScope, lines: MutableList<String>, memory: AppMemory = AppMemory()) = AndroidTvSession(
        KeyStore(File(dir, "keys.json")), File(dir, "client.json"), scope, { lines += it },
        remotePort = box.port, pairingPort = box.port, launchWaitMs = 400, reconnectWaitMs = 5000, reconnectDelays = listOf(50, 100, 200),
        appMemory = memory,
    )

    private suspend fun waitFor(ms: Long = 5000, check: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!check()) {
            if (System.currentTimeMillis() > end) fail("tidsavbrudd")
            delay(20)
        }
    }

    @Test fun triesLinksUntilTheBoxReportsTheAppAndRemembersTheOneThatWorked(): Unit = runBlocking {
        val dir = Files.createTempDirectory("fjern-atv").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val lines = CopyOnWriteArrayList<String>()
        FakeBox { link -> if (link == "https://tv.nrk.no") "open:no.nrk.tv" else if (link == "nrktv://") "error" else "" }.use { box ->
            val atv = session(box, dir, scope, lines)
            atv.connect("127.0.0.1")
            waitFor { atv.ready && atv.currentApp != null }
            assertEquals(AndroidTvSession.Companion.LaunchResult(verified = true, canRetry = false), atv.launch("nrktv"))
            assertEquals(listOf("nrktv://", "https://tv.nrk.no"), box.links.toList())
            assertTrue(lines.joinToString("\n"), lines.any { it.startsWith("Android TV: boksen meldte feil (avviste felt 90)") })
            // Appen er allerede åpen: bare lenken som virket, sendes.
            assertTrue(atv.launch("nrktv").verified)
            waitFor { box.links.size == 3 }
            assertEquals("https://tv.nrk.no", box.links.last())
            atv.disconnect()
        }
        scope.cancel()
        dir.deleteRecursively()
    }

    @Test fun boxThatDropsOnMarketLinksReconnectsAndTheUserIsTold(): Unit = runBlocking {
        val dir = Files.createTempDirectory("fjern-atv").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val lines = CopyOnWriteArrayList<String>()
        FakeBox { link -> if (link.startsWith("market://")) "drop" else "" }.use { box ->
            val atv = session(box, dir, scope, lines)
            atv.connect("127.0.0.1")
            waitFor { atv.ready && atv.currentApp != null }
            try {
                atv.launch("teliaplay")
                fail("forventet feil")
            } catch (e: UserError) {
                assertEquals(AndroidTvSession.appNotOpened("Telia Play"), e.message)
            }
            assertEquals(AndroidTvSession.APPS.first { it.id == "teliaplay" }.links, box.links.toList())
            assertTrue(lines.joinToString("\n"), "Android TV: market://launch?id=no.get.play.tv åpnet ikke appen (forbindelsen falt)" in lines)
            waitFor { atv.ready }
            atv.command("Home")
            atv.disconnect()
        }
        scope.cancel()
        dir.deleteRecursively()
    }

    @Test fun withoutAppReportsTheUserCanTryAnotherWayAndTheChoiceIsSaved(): Unit = runBlocking {
        val dir = Files.createTempDirectory("fjern-atv").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val lines = CopyOnWriteArrayList<String>()
        val memory = AppMemory(File(dir, "apps.json"))
        val tv2 = AndroidTvSession.APPS.first { it.id == "tv2play" }
        // Boksen melder ikke åpen app, avviser nettadressen og faller ut på market://.
        FakeBox(reportApps = false) { link -> if (link.startsWith("https://")) "error" else if (link.startsWith("market://")) "drop" else "" }.use { box ->
            val atv = session(box, dir, scope, lines, memory)
            atv.connect("127.0.0.1")
            waitFor { atv.ready }
            assertEquals(AndroidTvSession.Companion.LaunchResult(verified = false, canRetry = true), atv.launch("tv2play"))
            assertEquals(listOf("https://play.tv2.no", AndroidTvSession.intentLink("no.tv2.sumo")), box.links.toList())
            // Lagret i filen, og brukt av et nytt minne (som etter omstart av appen).
            assertEquals(AndroidTvSession.intentLink("no.tv2.sumo"), AppMemory(File(dir, "apps.json")).get("androidtv:127.0.0.1").links["tv2play"])
            atv.launch("tv2play")
            assertEquals(AndroidTvSession.intentLink("no.tv2.sumo"), box.links.last())
            assertEquals(3, box.links.size)
            // «Prøv en annen måte»: market:// får boksen til å falle ut, så ingen måte virket.
            try {
                atv.launch("tv2play", retry = true)
                fail("forventet feil")
            } catch (e: UserError) {
                assertEquals(AndroidTvSession.appNotOpened("TV 2 Play"), e.message)
            }
            assertEquals(tv2.links.last(), box.links.last())
            assertEquals(null, memory.get("androidtv:127.0.0.1").links["tv2play"])
            atv.disconnect()
        }
        scope.cancel()
        dir.deleteRecursively()
    }

    @Test fun appsTheBoxReportsAreLearnedAndOpenedWithTheIntentLink(): Unit = runBlocking {
        val dir = Files.createTempDirectory("fjern-atv").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val lines = CopyOnWriteArrayList<String>()
        FakeBox { link -> if (link.startsWith("intent:")) "open:" + Regex(";package=([\\w.]+);").find(link)!!.groupValues[1] else "" }.use { box ->
            val atv = session(box, dir, scope, lines)
            atv.connect("127.0.0.1")
            waitFor { atv.ready && atv.currentApp != null }
            for ((pkg, label) in listOf("no.example.kino" to "Kino Pluss", "com.android.tv.settings" to "", "no.nrk.tv" to "NRK TV", "com.plexapp.android" to "")) {
                box.open(pkg, label)
                waitFor { atv.currentApp == pkg }
            }
            delay(100)
            val learned = atv.apps().drop(AndroidTvSession.APPS.size)
            assertEquals(listOf(App("no.example.kino", "Kino Pluss"), App("com.plexapp.android", "Plexapp")), learned)
            assertTrue(lines.joinToString("\n"), "Android TV: lærte appen Kino Pluss (no.example.kino)" in lines)
            box.links.clear()
            assertTrue(atv.launch("no.example.kino").verified)
            assertEquals(listOf(AndroidTvSession.intentLink("no.example.kino")), box.links.toList())
            try {
                atv.launch("com.android.tv.settings")
                fail("forventet feil")
            } catch (e: UserError) {
                assertEquals("Ukjent app.", e.message)
            }
            atv.disconnect()
        }
        scope.cancel()
        dir.deleteRecursively()
    }
}
