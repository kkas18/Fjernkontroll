package no.fjern.app

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * LG webOS via SSAP over WebSocket. Nyere firmware krever wss:// på port 3001 med et selvsignert
 * sertifikat; eldre modeller bruker ws:// på port 3000. Sertifikatet låses ved første paring
 * (trust on first use), og en låst TV faller aldri tilbake til ukryptert ws://.
 *
 * All tilstand endres på én tråd (som JavaScript-hendelsesløkken i Node-versjonen).
 */
class LgSession(
    private val keyStore: KeyStore,
    private val scope: CoroutineScope,
    private val log: (String) -> Unit = {},
    private val connectTimeoutMs: Long = 5000,
    private val pairingTimeoutMs: Long = 30_000,
    private val requestTimeoutMs: Long = 4000,
    private val reconnectDelays: List<Long> = listOf(1000, 2000, 4000, 8000, 16_000),
    private val wakeDelays: List<Long> = listOf(3000, 3000, 4000, 5000, 5000, 5000, 5000),
) {
    companion object {
        const val IDLE = "Frakoblet"
        const val CONNECTING = "Kobler til LG TV …"
        const val RECONNECTING = "Forbindelsen falt ut. Kobler til igjen …"
        const val WAKING = "Slår på TV-en …"
        const val PAIRING = "Godkjenn paringen på TV-skjermen."
        const val PREPARING = "Paring godkjent. Klargjør navigasjon …"
        const val READY = "Tilkoblet"
        const val UNREACHABLE = "Fikk ikke kontakt med LG TV. Sjekk at den er på og at IP-adressen stemmer."
        const val PAIRING_TIMEOUT = "Paringen ble ikke godkjent i tide. Velg TV-en og prøv igjen."
        const val REJECTED = "TV-en avviste paringen. Velg TV-en og prøv igjen."
        const val NO_POINTER = "TV-en ga ikke tilgang til navigasjon. Trykk «Par på nytt» og godkjenn forespørselen på TV-en."
        const val POINTER_LOST = "Navigasjonen ble frakoblet. Velg TV-en for å koble til igjen."
        const val LOST = "LG TV ble frakoblet. Velg TV-en for å koble til igjen."
        const val CERT_CHANGED = "TV-ens sertifikat er endret siden paringen. Det kan bety at noen utgir seg for TV-en. Par på nytt bare hvis TV-en er tilbakestilt eller oppdatert."
        const val NO_WAKE = "Slå på krever at TV-en har vært tilkoblet én gang, og at «Slå på via Wi‑Fi» er aktivert i TV-ens innstillinger."

        // Samme tillatelser som LG-biblioteket i Home Assistant (aiowebostv). CONTROL_MOUSE_AND_KEYBOARD
        // er påkrevd for pekersocketen (navigasjon); uten den svarer TV-en «401 insufficient permissions».
        val PERMISSIONS = listOf(
            "APP_TO_APP", "CLOSE", "CONTROL_AUDIO", "CONTROL_DISPLAY", "CONTROL_INPUT_JOYSTICK",
            "CONTROL_INPUT_MEDIA_PLAYBACK", "CONTROL_INPUT_MEDIA_RECORDING", "CONTROL_INPUT_TEXT", "CONTROL_INPUT_TV",
            "CONTROL_MOUSE_AND_KEYBOARD", "CONTROL_POWER", "CONTROL_TV_SCREEN", "LAUNCH", "LAUNCH_WEBAPP",
            "READ_APP_STATUS", "READ_COUNTRY_INFO", "READ_CURRENT_CHANNEL", "READ_INPUT_DEVICE_LIST",
            "READ_INSTALLED_APPS", "READ_LGE_SDX", "READ_LGE_TV_INPUT_EVENTS", "READ_NETWORK_STATE",
            "READ_NOTIFICATIONS", "READ_POWER_STATE", "READ_RUNNING_APPS", "READ_SETTINGS", "READ_TV_CHANNEL_LIST",
            "READ_TV_CURRENT_TIME", "READ_UPDATE_INFO", "SEARCH", "TEST_OPEN", "TEST_PROTECTED", "TEST_SECURE",
            "UPDATE_FROM_REMOTE_APP", "WRITE_NOTIFICATION_ALERT", "WRITE_NOTIFICATION_TOAST", "WRITE_SETTINGS",
        )

        /** Økes når tillatelsene endres; eldre nøkler gir ikke de nye tillatelsene, så da parer vi på nytt. */
        const val MANIFEST_REVISION = 2

        fun registrationPayload(stored: KeyStore.Entry?): JSONObject {
            val manifest = JSONObject()
                .put("manifestVersion", 1)
                .put("appVersion", "1.1")
                .put("permissions", JSONArray(PERMISSIONS))
            val payload = JSONObject().put("forcePairing", false).put("pairingType", "PROMPT").put("manifest", manifest)
            if (stored?.key != null && stored.rev == MANIFEST_REVISION) payload.put("client-key", stored.key)
            return payload
        }
        val BUTTONS = mapOf("Up" to "UP", "Down" to "DOWN", "Left" to "LEFT", "Right" to "RIGHT", "Select" to "ENTER", "Back" to "BACK", "Home" to "HOME")
        val REQUESTS: Map<String, Pair<String, JSONObject?>> = mapOf(
            "VolumeUp" to ("ssap://audio/volumeUp" to null),
            "VolumeDown" to ("ssap://audio/volumeDown" to null),
            "PowerOff" to ("ssap://system/turnOff" to null),
            "Play" to ("ssap://media.controls/play" to null),
            "Pause" to ("ssap://media.controls/pause" to null),
            "Rewind" to ("ssap://media.controls/rewind" to null),
            "FastForward" to ("ssap://media.controls/fastForward" to null),
            "ChannelUp" to ("ssap://tv/channelUp" to null),
            "ChannelDown" to ("ssap://tv/channelDown" to null),
            "Backspace" to ("ssap://com.webos.service.ime/deleteCharacters" to JSONObject().put("count", 1)),
        )

        fun fingerprint(cert: X509Certificate): String =
            MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }
    }

    private class CertificateMismatch : Exception("Sertifikatet til TV-en er endret")

    /** En åpen WebSocket med tilhørende sertifikatavtrykk (for wss). */
    private class Socket(val ws: WebSocket, val fingerprint: String?) {
        @Volatile var open = true
    }

    private val state = Dispatchers.IO.limitedParallelism(1)
    private val baseClient = OkHttpClient.Builder()
        .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    @Volatile var host: String? = null; private set
    @Volatile var ready = false; private set
    @Volatile var status: String = IDLE; private set
    @Volatile var code: String? = null; private set
    @Volatile var canWake = false; private set
    @Volatile var model: String? = null; private set

    private var generation = 0
    private var control: Socket? = null
    private var pointer: Socket? = null
    private var apps: List<App> = emptyList()
    private var pairingJob: Job? = null
    private var reconnectJob: Job? = null
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject?>>()
    private val sequence = AtomicInteger()

    private fun current(gen: Int) = gen == generation

    private fun clientFor(expected: String?, captured: AtomicReference<String?>): OkHttpClient {
        // Selvsignerte TV-sertifikater kan ikke verifiseres mot en CA. I stedet låses avtrykket.
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String?) {
                val fp = fingerprint(chain[0])
                captured.set(fp)
                if (expected != null && fp != expected) throw CertificateException("mismatch")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
        return baseClient.newBuilder()
            .sslSocketFactory(context.socketFactory, trust)
            .hostnameVerifier { _, _ -> true }
            .build()
    }

    private suspend fun openSocket(url: String, expected: String?, onMessage: (Socket, String) -> Unit, onClose: (Socket) -> Unit): Socket {
        val captured = AtomicReference<String?>(null)
        val opened = CompletableDeferred<Socket>()
        var socketRef: Socket? = null
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val socket = Socket(webSocket, captured.get())
                socketRef = socket
                opened.complete(socket)
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                socketRef?.let { socket -> scope.launch(state) { onMessage(socket, text) } }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closed()
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!opened.isCompleted) {
                    val mismatch = expected != null && captured.get() != null && captured.get() != expected
                    opened.completeExceptionally(if (mismatch) CertificateMismatch() else t)
                } else {
                    closed()
                }
            }
            private fun closed() {
                val socket = socketRef ?: return
                if (!socket.open) return
                socket.open = false
                scope.launch(state) { onClose(socket) }
            }
        }
        val client = if (url.startsWith("wss:")) clientFor(expected, captured) else baseClient
        val ws = client.newWebSocket(Request.Builder().url(url).build(), listener)
        return try {
            withTimeout(connectTimeoutMs + 1000) { opened.await() }
        } catch (e: TimeoutCancellationException) {
            ws.cancel()
            throw e
        }
    }

    private fun closeSocket(socket: Socket?) {
        socket ?: return
        socket.open = false
        runCatching { socket.ws.close(1000, null) }
    }

    private fun rejectPending(reason: String) {
        for (deferred in pending.values) deferred.completeExceptionally(UserError(reason, 502))
        pending.clear()
    }

    private fun resetLocked() {
        generation += 1
        pairingJob?.cancel()
        reconnectJob?.cancel()
        rejectPending(LOST)
        closeSocket(pointer)
        closeSocket(control)
        host = null; control = null; pointer = null; ready = false; status = IDLE; code = null; canWake = false; apps = emptyList(); model = null
    }

    suspend fun disconnect() = withContext(state) { resetLocked() }

    private fun scheduleReconnect(target: String, attempt: Int, delays: List<Long>, message: String = RECONNECTING) {
        if (attempt >= delays.size) {
            status = UNREACHABLE
            return
        }
        val gen = generation
        status = message
        reconnectJob?.cancel()
        reconnectJob = scope.launch(state) {
            delay(delays[attempt])
            if (current(gen)) connectLocked(target, Auto(attempt, delays, message))
        }
    }

    private data class Auto(val attempt: Int, val delays: List<Long>, val message: String)

    private suspend fun request(uri: String, payload: JSONObject? = null, timeoutMs: Long = requestTimeoutMs): JSONObject? {
        val socket = control
        if (socket == null || !socket.open) throw UserError(status, 409)
        val id = "req_${sequence.incrementAndGet()}"
        val deferred = CompletableDeferred<JSONObject?>()
        pending[id] = deferred
        val message = JSONObject().put("type", "request").put("id", id).put("uri", uri)
        if (payload != null) message.put("payload", payload)
        socket.ws.send(message.toString())
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            pending.remove(id)
            throw UserError("LG TV svarte ikke på kommandoen.", 504)
        }
    }

    private suspend fun openControl(target: String, pinned: String?, onMessage: (Socket, String) -> Unit, onClose: (Socket) -> Unit): Pair<Socket, Boolean> {
        val attempts = buildList {
            add("wss://$target:3001/")
            // En TV med låst sertifikat skal aldri nedgraderes til ukryptert forbindelse.
            if (pinned == null) add("ws://$target:3000/")
        }
        var last: Throwable? = null
        for (url in attempts) {
            try {
                val socket = openSocket(url, if (url.startsWith("wss:")) pinned else null, onMessage, onClose)
                log("LG: tilkoblet $url")
                return socket to url.startsWith("wss:")
            } catch (e: CertificateMismatch) {
                throw e
            } catch (e: Throwable) {
                last = e
                log("LG: $url feilet (${e.message})")
            }
        }
        throw last ?: IllegalStateException("Ingen forbindelse")
    }

    private suspend fun rememberMac(target: String) {
        try {
            val info = request("ssap://com.webos.service.connectionmanager/getinfo")
            val mac = Wol.normalizeMac(info?.optJSONObject("wifiInfo")?.optString("macAddress"))
                ?: Wol.normalizeMac(info?.optJSONObject("wiredInfo")?.optString("macAddress"))
            if (mac != null) {
                canWake = true
                keyStore.update(target, mac = mac)
            }
        } catch (e: Exception) {
            log("LG: fant ikke MAC-adresse (${e.message})")
        }
    }

    private suspend fun openPointer(gen: Int, retry: Boolean = true) {
        val path = try {
            request("ssap://com.webos.service.networkinput/getPointerInputSocket")?.optString("socketPath")
        } catch (e: Exception) {
            log("LG: pekersocket avvist (${e.message})")
            null
        }
        if (!current(gen)) return
        if (path == null || !Regex("^wss?://").containsMatchIn(path)) {
            status = NO_POINTER
            code = "needs-repair"
            return
        }
        try {
            val socket = openSocket(path, null, { _, _ -> }) { closedSocket ->
                if (!current(gen) || pointer !== closedSocket) return@openSocket
                ready = false
                pointer = null
                status = POINTER_LOST
                // Kontrollforbindelsen lever ofte videre: prøv å hente en ny pekersocket én gang.
                if (control?.open == true) scope.launch(state) {
                    delay(1000)
                    if (current(gen)) openPointer(gen, retry = false)
                }
            }
            if (!current(gen)) return closeSocket(socket)
            pointer = socket
            ready = true
            status = READY
            log("LG: klar (navigasjon tilkoblet)")
            if (retry) host?.let {
                rememberMac(it)
                rememberModel()
            }
        } catch (e: Exception) {
            log("LG: pekersocket feilet (${e.message})")
            if (current(gen)) status = POINTER_LOST
        }
    }

    private fun onMessage(gen: Int, socket: Socket, raw: String) {
        if (!current(gen)) return
        val message = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val id = message.optString("id")
        val waiting = pending.remove(id)
        if (waiting != null) {
            val payload = message.optJSONObject("payload")
            if (message.optString("type") == "error" || payload?.optBoolean("returnValue", true) == false) {
                log("LG: $id avvist (${message.optString("error").ifEmpty { payload?.optString("errorText") ?: "ukjent" }})")
                waiting.completeExceptionally(UserError("TV-en avviste kommandoen.", 502))
            } else {
                waiting.complete(payload)
            }
            return
        }
        if (id != "register_0") return
        when (message.optString("type")) {
            "registered" -> {
                pairingJob?.cancel()
                val key = message.optJSONObject("payload")?.optString("client-key")?.ifEmpty { null }
                val fp = socket.fingerprint
                host?.let { target ->
                    runCatching { keyStore.update(target, key = key, fingerprint = fp, rev = if (key != null) MANIFEST_REVISION else null) }
                        .onFailure { log("LG: kunne ikke lagre nøkkel (${it.message})") }
                }
                status = PREPARING
                log("LG: paring godkjent")
                scope.launch(state) { openPointer(gen) }
            }
            "error" -> {
                pairingJob?.cancel()
                log("LG: registrering avvist (${message.optString("error")})")
                status = REJECTED
            }
        }
    }

    private suspend fun connectLocked(target: String, auto: Auto? = null) {
        resetLocked()
        val gen = generation
        host = target
        status = auto?.message ?: CONNECTING
        val stored = keyStore.get(target)
        canWake = stored?.mac != null

        val (socket, _) = try {
            openControl(
                target,
                stored?.fingerprint,
                onMessage = { s, raw -> onMessage(gen, s, raw) },
                onClose = { s ->
                    if (current(gen) && control === s) {
                        val wasReady = ready || pointer != null
                        pairingJob?.cancel()
                        rejectPending(LOST)
                        ready = false
                        control = null
                        closeSocket(pointer)
                        pointer = null
                        if (wasReady) scheduleReconnect(target, 0, reconnectDelays)
                        else if (status != PAIRING_TIMEOUT) status = LOST
                    }
                },
            )
        } catch (e: CertificateMismatch) {
            log("LG: sertifikatet stemmer ikke med det som ble låst ved paring")
            if (current(gen)) {
                status = CERT_CHANGED
                code = "cert-changed"
            }
            return
        } catch (e: Throwable) {
            if (!current(gen)) return
            if (auto != null) scheduleReconnect(target, auto.attempt + 1, auto.delays, auto.message) else status = UNREACHABLE
            return
        }
        if (!current(gen)) return closeSocket(socket)
        control = socket

        val payload = registrationPayload(stored)
        status = PAIRING
        socket.ws.send(JSONObject().put("type", "register").put("id", "register_0").put("payload", payload).toString())
        pairingJob = scope.launch(state) {
            delay(pairingTimeoutMs)
            if (!current(gen) || ready || status != PAIRING) return@launch
            status = PAIRING_TIMEOUT
            control = null
            closeSocket(socket)
        }
    }

    suspend fun connect(target: String) = withContext(state) { connectLocked(target) }

    /**
     * Kalles når appen kommer i forgrunnen eller nettverket kommer tilbake. Android fryser appen i
     * bakgrunnen, og TV-en lukker da forbindelsen uten at vi merker det. Sjekk at den lever, og koble
     * til på nytt med lagret nøkkel hvis ikke (ingen ny godkjenning på TV-en).
     */
    suspend fun ensureConnected(target: String) = withContext(state) {
        if (host == target && status in setOf(CONNECTING, PAIRING, PREPARING, WAKING)) return@withContext
        // Tilstander som krever at brukeren gjør noe, skal ikke gi nye forespørsler på TV-en av seg selv.
        if (host == target && status in setOf(CERT_CHANGED, REJECTED, PAIRING_TIMEOUT, NO_POINTER)) return@withContext
        if (ready && host == target) {
            val alive = try {
                request("ssap://audio/getStatus", timeoutMs = 1500)
                pointer?.open == true
            } catch (_: Exception) {
                false
            }
            if (alive) return@withContext
            log("LG: forbindelsen svarte ikke etter pause, kobler til igjen")
        } else {
            log("LG: kobler til igjen etter pause")
        }
        connectLocked(target, Auto(0, reconnectDelays, RECONNECTING))
    }

    /** I bakgrunnen: ikke bruk batteri på gjenoppkoblingsforsøk som Android uansett blokkerer. */
    suspend fun pauseReconnect() = withContext(state) {
        reconnectJob?.cancel()
        Unit
    }

    private fun pressButton(name: String) {
        val socket = pointer
        if (!ready || socket == null || !socket.open) throw UserError(status, 409)
        socket.ws.send("type:button\nname:$name\n\n")
    }

    suspend fun command(key: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        BUTTONS[key]?.let { return@withContext pressButton(it) }
        if (key == "Mute") {
            // Les faktisk lydstatus, slik at appen ikke kommer i utakt med den vanlige fjernkontrollen.
            try {
                val muted = request("ssap://audio/getStatus")?.optBoolean("mute") ?: false
                request("ssap://audio/setMute", JSONObject().put("mute", !muted))
            } catch (_: Exception) {
                pressButton("MUTE")
            }
            return@withContext
        }
        val (uri, payload) = REQUESTS[key] ?: throw UserError("Denne kommandoen støttes ikke av LG.")
        request(uri, payload?.let { JSONObject(it.toString()) })
        Unit
    }

    suspend fun powerOn(target: String) = withContext(state) {
        val mac = keyStore.get(target)?.mac ?: throw UserError(NO_WAKE, 409)
        withContext(Dispatchers.IO) { Wol.send(mac, target) }
        resetLocked()
        host = target
        canWake = true
        scheduleReconnect(target, 0, wakeDelays, WAKING)
    }

    suspend fun text(value: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        request("ssap://com.webos.service.ime/insertText", JSONObject().put("text", value).put("replace", 0))
        Unit
    }

    suspend fun apps(): List<App> = withContext(state) {
        if (!ready) throw UserError(status, 409)
        val points = request("ssap://com.webos.applicationManager/listLaunchPoints")?.optJSONArray("launchPoints") ?: JSONArray()
        val list = mutableListOf<App>()
        for (i in 0 until points.length()) {
            val point = points.optJSONObject(i) ?: continue
            try {
                val id = Validate.appId(point.optString("id"))
                val color = point.optString("bgColor").takeIf { Regex("^#[0-9a-fA-F]{6}$").matches(it) }
                list += App(
                    id,
                    point.optString("title").ifEmpty { id }.take(80),
                    system = point.optBoolean("systemApp", false),
                    color = color,
                    // largeIcon er skarpere på telefoner med høy oppløsning.
                    icon = point.optString("largeIcon").ifEmpty { point.optString("icon") }.ifEmpty { null },
                )
            } catch (_: UserError) {
                // hopp over ugyldige id-er
            }
            if (list.size >= Validate.MAX_APPS) break
        }
        apps = list
        list
    }

    /** Modellnavnet brukes som TV-navn når brukeren ikke har valgt et eget. */
    private suspend fun rememberModel() {
        try {
            val name = request("ssap://system/getSystemInfo")?.optString("modelName")?.trim()?.take(40)
            if (!name.isNullOrEmpty()) model = "LG $name"
        } catch (e: Exception) {
            log("LG: fant ikke modellnavn (${e.message})")
        }
    }

    /** Henter et appikon, men bare fra TV-en selv (http eller https med TV-ens egne sertifikat). */
    suspend fun icon(id: String): ByteArray = withContext(state) {
        val url = apps.firstOrNull { it.id == id }?.icon ?: throw UserError("Fant ikke ikonet.", 404)
        val parsed = url.toHttpUrlOrNull() ?: throw UserError("Fant ikke ikonet.", 404)
        if (parsed.host != host) throw UserError("Fant ikke ikonet.", 404)
        withContext(Dispatchers.IO) {
            try {
                fetchIcon(parsed)
            } catch (e: Exception) {
                // TV-er som bare har kryptert port, serverer de samme ressursene på https://…:3001.
                if (parsed.isHttps) throw e
                fetchIcon(parsed.newBuilder().scheme("https").port(3001).build())
            }
        }
    }

    private fun fetchIcon(url: okhttp3.HttpUrl): ByteArray {
        val client = if (url.isHttps) clientFor(null, AtomicReference(null)) else baseClient
        return client.newBuilder().callTimeout(3, TimeUnit.SECONDS).build()
            .newCall(Request.Builder().url(url).build()).execute().use { response ->
                if (!response.isSuccessful) throw UserError("TV-en ga ikke ut ikonet.", 502)
                val body = response.body ?: throw UserError("TV-en ga ikke ut ikonet.", 502)
                Icons.readLimited(body.byteStream())
            }
    }

    suspend fun launch(id: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        if (apps.none { it.id == id }) throw UserError("Ukjent app.", 404)
        request("ssap://system.launcher/launch", JSONObject().put("id", id))
        Unit
    }

    fun forget(target: String) = keyStore.remove(target)
}
