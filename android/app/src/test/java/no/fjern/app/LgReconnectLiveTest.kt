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
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Regresjonstest: etter at forbindelsen falt ut, avbrøt gjenoppkoblingsjobben seg selv (resetLocked
 * avbrøt reconnectJob), og appen ble stående på «Kobler til igjen …». Falsk LG-TV på 127.0.0.1:3000.
 */
class LgReconnectLiveTest {
    @Test fun lgReconnectsAfterDroppedConnection() = runBlocking {
        val controls = CopyOnWriteArrayList<WebSocket>()
        val all = CopyOnWriteArrayList<WebSocket>()
        val tv = MockWebServer()
        tv.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val pointer = request.path.orEmpty().startsWith("/pointer")
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        all += webSocket
                        if (!pointer) controls += webSocket
                    }
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (pointer) return
                        val message = JSONObject(text)
                        val id = message.optString("id")
                        if (message.optString("type") == "register") {
                            webSocket.send(JSONObject().put("type", "registered").put("id", id).put("payload", JSONObject().put("client-key", "k")).toString())
                            return
                        }
                        val payload = if (message.optString("uri").endsWith("getPointerInputSocket")) JSONObject().put("socketPath", "ws://127.0.0.1:3000/pointer")
                            else JSONObject().put("returnValue", true)
                        webSocket.send(JSONObject().put("type", "response").put("id", id).put("payload", payload).toString())
                    }
                })
            }
        }
        tv.start(InetAddress.getByName("127.0.0.1"), 3000)
        val dir = Files.createTempDirectory("fjern").toFile()
        val logs = CopyOnWriteArrayList<String>()
        val lg = LgSession(KeyStore(File(dir, "keys.json")), CoroutineScope(SupervisorJob() + Dispatchers.IO), { logs += it })
        try {
            lg.connect("127.0.0.1")
            var waited = 0
            while (!lg.ready && waited < 5000) { delay(50); waited += 50 }
            assertTrue("klar første gang: ${lg.status} $logs", lg.ready)
            controls.last().close(1000, "bye")
            waited = 0
            while (lg.ready && waited < 3000) { delay(20); waited += 20 }
            val start = System.currentTimeMillis()
            while (!lg.ready && System.currentTimeMillis() - start < 10000) delay(100)
            assertTrue("klar igjen: ${lg.status} $logs", lg.ready)
        } finally {
            lg.disconnect()
            all.forEach { runCatching { it.close(1000, null) } }
            delay(200)
            runCatching { tv.shutdown() }
            dir.deleteRecursively()
        }
    }
}
