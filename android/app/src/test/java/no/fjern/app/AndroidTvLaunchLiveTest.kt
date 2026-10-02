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
    private class FakeBox(val onLink: (String) -> String) : AutoCloseable {
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

        private fun reportApp(out: java.io.OutputStream) =
            out.write(Proto.frame(Proto.encode(20 to Proto.encode(1 to Proto.encode(1 to 1, 12 to currentApp)))))

        private fun serve(socket: Socket) = runCatching {
            socket.use {
                val out = socket.getOutputStream()
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

    private fun session(box: FakeBox, dir: File, scope: CoroutineScope, lines: MutableList<String>) = AndroidTvSession(
        KeyStore(File(dir, "keys.json")), File(dir, "client.json"), scope, { lines += it },
        remotePort = box.port, pairingPort = box.port, launchWaitMs = 400, reconnectWaitMs = 5000, reconnectDelays = listOf(50, 100, 200),
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
            assertTrue(atv.launch("nrktv"))
            assertEquals(listOf("nrktv://", "https://tv.nrk.no"), box.links.toList())
            assertTrue(lines.joinToString("\n"), lines.any { it.startsWith("Android TV: boksen meldte feil (avviste felt 90)") })
            assertTrue(atv.launch("nrktv"))
            assertEquals("https://tv.nrk.no", box.links.last())
            assertEquals(3, box.links.size)
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
            assertEquals(listOf("https://www.teliaplay.no", "market://launch?id=no.get.play.tv"), box.links.toList())
            assertTrue(lines.joinToString("\n"), "Android TV: market://launch?id=no.get.play.tv åpnet ikke appen (forbindelsen falt)" in lines)
            waitFor { atv.ready }
            atv.command("Home")
            atv.disconnect()
        }
        scope.cancel()
        dir.deleteRecursively()
    }
}
