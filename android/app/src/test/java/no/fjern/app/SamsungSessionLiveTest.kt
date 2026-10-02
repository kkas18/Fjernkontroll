package no.fjern.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Ekte OkHttp-WebSocket mot en falsk Samsung-TV på 127.0.0.1 (port 8001 og DIAL på 8080):
 * «Tillat», token, taster, apper, YouTube og automatisk gjenoppkobling.
 */
class SamsungSessionLiveTest {
    @Test fun samsungSessionAgainstFakeTv() = runBlocking {
        val received = CopyOnWriteArrayList<JSONObject>()
        val urls = CopyOnWriteArrayList<String>()
        val dial = CopyOnWriteArrayList<String>()
        var approve = false
        val tvSockets = CopyOnWriteArrayList<WebSocket>()
        val tv = MockWebServer()
        tv.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                if (path == "/api/v2/") return MockResponse().setBody(JSONObject().put("device", JSONObject()
                    .put("name", "[TV] Stue").put("modelName", "QE55Q80B").put("wifiMac", "A0:D0:5B:01:02:03").put("TokenAuthSupport", "false")).toString())
                urls += path
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        tvSockets += webSocket
                        // Med «Tillat» (eller gyldig token) svarer TV-en med en gang, før klienten har sendt noe.
                        if (approve) webSocket.send(JSONObject().put("event", "ms.channel.connect").put("data", JSONObject().put("token", 29384756)).toString())
                    }
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        val message = JSONObject(text)
                        received += message
                        if (message.optJSONObject("params")?.optString("event") == "ed.installedApp.get") {
                            webSocket.send(JSONObject().put("event", "ed.installedApp.get").put("data", JSONObject().put("data", JSONArray()
                                .put(JSONObject().put("appId", "3201907018807").put("app_type", 2).put("name", "Netflix")))).toString())
                        }
                    }
                })
            }
        }
        tv.start(InetAddress.getByName("127.0.0.1"), 8001)
        val dialServer = MockWebServer()
        dialServer.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                dial += "${request.method} ${request.path} ${request.body.readUtf8()}"
                return MockResponse().setResponseCode(201)
            }
        }
        dialServer.start(InetAddress.getByName("127.0.0.1"), 8080)

        val dir = Files.createTempDirectory("fjern").toFile()
        val store = KeyStore(File(dir, "keys.json"))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val logs = CopyOnWriteArrayList<String>()
        val samsung = SamsungSession(store, scope, { logs += it }, pairingTimeoutMs = 3000)
        try {
            // 1) Ingen «Tillat» ennå: venter på TV-en.
            samsung.connect("127.0.0.1")
            delay(200)
            assertEquals(SamsungSession.PAIRING, samsung.status)
            assertEquals("Samsung QE55Q80B", samsung.model)
            // TV-en godtar: hendelsen kommer på den åpne forbindelsen.
            tvSockets.last().send(JSONObject().put("event", "ms.channel.connect").put("data", JSONObject().put("token", "29384756")).toString())
            delay(200)
            assertTrue(samsung.ready)
            assertEquals(SamsungSession.READY, samsung.status)
            assertEquals("29384756", store.get(SamsungSession.storeKey("127.0.0.1"))?.token)
            assertEquals("a0:d0:5b:01:02:03", store.get(SamsungSession.storeKey("127.0.0.1"))?.mac)
            assertTrue(samsung.canWake)

            // 2) Taster, ⏯, tekst, apper, start og YouTube via DIAL.
            samsung.command("Up"); samsung.command("Blue"); samsung.command("PlayPause"); samsung.command("PlayPause")
            samsung.text("æøå")
            assertEquals(listOf("Netflix"), samsung.apps().map { it.name })
            samsung.launch("3201907018807")
            samsung.switchInput("KEY_HDMI2")
            samsung.playYoutube("n61ULEU7CO0")
            delay(200)
            val keys = received.mapNotNull { it.optJSONObject("params")?.takeIf { p -> p.optString("TypeOfRemote") == "SendRemoteKey" }?.getString("DataOfCmd") }
            assertEquals(listOf("KEY_UP", "KEY_CYAN", "KEY_PAUSE", "KEY_PLAY", "KEY_HDMI2"), keys)
            val input = received.first { it.getJSONObject("params").optString("TypeOfRemote") == "SendInputString" }
            assertEquals("æøå", String(java.util.Base64.getDecoder().decode(input.getJSONObject("params").getString("Cmd"))))
            val launch = received.first { it.getJSONObject("params").optString("event") == "ed.apps.launch" }
            assertEquals("DEEP_LINK", launch.getJSONObject("params").getJSONObject("data").getString("action_type"))
            assertEquals(listOf("POST /ws/apps/YouTube v=n61ULEU7CO0"), dial)

            // 3) TV-en lukker forbindelsen: kobler til igjen av seg selv, og TV-en svarer med en gang (token).
            approve = true
            tvSockets.last().close(1000, "bye")
            var waited = 0
            while (samsung.ready && waited < 3000) { delay(20); waited += 20 }
            val start = System.currentTimeMillis()
            while (!samsung.ready && System.currentTimeMillis() - start < 12000) delay(100)
            assertTrue("klar igjen: ${samsung.status} ${logs}", samsung.ready)
            assertTrue(urls.size >= 2)

            // 4) Ukjent kommando og ukjent inngang gir norske feil.
            try { samsung.command("Recent"); throw AssertionError("forventet feil") } catch (_: UserError) {}
            try { samsung.switchInput("KEY_POWER"); throw AssertionError("forventet feil") } catch (_: UserError) {}
        } finally {
            samsung.disconnect()
            tvSockets.forEach { runCatching { it.close(1000, null) } }
            delay(200)
            runCatching { tv.shutdown() }; runCatching { dialServer.shutdown() }
            dir.deleteRecursively()
        }
    }
}
