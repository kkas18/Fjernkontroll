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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Samsung Tizen (2016 og nyere) via fjernkontroll-API-et over WebSocket, samme som lib/samsung.mjs.
 * TV-er som krever token (de fleste fra 2018) bruker wss:// på port 8002 med et selvsignert sertifikat;
 * eldre bruker ws:// på port 8001. Første gang viser TV-en «Tillat/Avvis». Tokenet og sertifikatavtrykket
 * lagres (trust on first use), og en låst TV faller aldri tilbake til ukryptert ws://.
 *
 * All tilstand endres på én tråd, som i LgSession.
 */
class SamsungSession(
    private val keyStore: KeyStore,
    private val scope: CoroutineScope,
    private val log: (String) -> Unit = {},
    private val connectTimeoutMs: Long = 5000,
    private val pairingTimeoutMs: Long = 30_000,
    private val requestTimeoutMs: Long = 5000,
    private val reconnectDelays: List<Long> = listOf(1000, 2000, 4000, 8000, 16_000),
    private val wakeDelays: List<Long> = listOf(3000, 3000, 4000, 5000, 5000, 5000, 5000),
) {
    companion object {
        const val IDLE = "Frakoblet"
        const val CONNECTING = "Kobler til Samsung-TV …"
        const val RECONNECTING = "Forbindelsen falt ut. Kobler til igjen …"
        const val WAKING = "Slår på TV-en …"
        const val PAIRING = "Trykk «Tillat» på TV-skjermen."
        const val READY = "Tilkoblet"
        const val UNREACHABLE = "Fikk ikke kontakt med Samsung-TV-en. Sjekk at den er på, på samme Wi‑Fi, og at IP-adressen stemmer."
        const val PAIRING_TIMEOUT = "Tilkoblingen ble ikke godkjent i tide. Velg TV-en og prøv igjen."
        const val REJECTED = "TV-en avviste tilkoblingen. Tillat Fjern under Innstillinger → Generelt → Ekstern enhetsbehandling → Enhetstilkoblingsbehandling, og prøv igjen."
        const val LOST = "Samsung-TV-en ble frakoblet. Velg TV-en for å koble til igjen."
        const val CERT_CHANGED = "TV-ens sertifikat er endret siden forrige tilkobling. Det kan bety at noen utgir seg for TV-en. Par på nytt bare hvis TV-en er tilbakestilt eller oppdatert."
        const val NO_WAKE = "Slå på krever at TV-en har vært tilkoblet én gang, og at «Slå på med mobil» er aktivert (Innstillinger → Generelt → Nettverk → Ekspertinnstillinger)."

        /** Navnet som vises på TV-en i forespørselen og under «Enhetsbehandling». */
        val REMOTE_NAME: String = Base64.getEncoder().encodeToString("Fjern".toByteArray())
        const val YOUTUBE_APP_ID = "111299001912"

        // Tastenavn fra Samsungs fjernkontroll-API (samme liste som samsungtvws). Samsungs blå tast heter CYAN.
        val KEYS = mapOf(
            "Up" to "KEY_UP", "Down" to "KEY_DOWN", "Left" to "KEY_LEFT", "Right" to "KEY_RIGHT", "Select" to "KEY_ENTER",
            "Back" to "KEY_RETURN", "Home" to "KEY_HOME",
            "VolumeUp" to "KEY_VOLUP", "VolumeDown" to "KEY_VOLDOWN", "Mute" to "KEY_MUTE", "PowerOff" to "KEY_POWER",
            "Play" to "KEY_PLAY", "Pause" to "KEY_PAUSE", "Rewind" to "KEY_REWIND", "FastForward" to "KEY_FF",
            "ChannelUp" to "KEY_CHUP", "ChannelDown" to "KEY_CHDOWN", "Enter" to "KEY_ENTER",
            "Red" to "KEY_RED", "Green" to "KEY_GREEN", "Yellow" to "KEY_YELLOW", "Blue" to "KEY_CYAN",
            "Info" to "KEY_INFO", "Guide" to "KEY_GUIDE", "List" to "KEY_CH_LIST", "Dash" to "KEY_PLUS100", "Exit" to "KEY_EXIT",
            "Settings" to "KEY_MENU", "Subtitles" to "KEY_CAPTION", "Teletext" to "KEY_TTX_MIX", "Aspect" to "KEY_PICTURE_SIZE",
        ) + (0..9).associate { "Num$it" to "KEY_$it" }
        val EXTRA_KEYS = (0..9).map { "Num$it" } + listOf(
            "Red", "Green", "Yellow", "Blue", "Info", "Guide", "List", "Dash", "Exit", "Settings",
            "Subtitles", "Teletext", "Aspect", "Enter",
        )

        /** Tizen har ingen liste over innganger her, men egne taster for hver HDMI-port og kildemenyen. */
        val INPUTS = listOf(Input("KEY_SOURCE", "Kildemeny på TV-en")) + (1..4).map { Input("KEY_HDMI$it", "HDMI $it") }

        /** Lagres i samme nøkkelfil som LG, men under eget navn, så en IP-adresse som bytter TV ikke blandes. */
        fun storeKey(host: String) = "samsung:$host"

        fun remoteUrl(host: String, secure: Boolean, token: String? = null): String {
            val base = if (secure) "wss://$host:8002" else "ws://$host:8001"
            var query = "name=" + URLEncoder.encode(REMOTE_NAME, "UTF-8")
            if (secure && token != null) query += "&token=" + URLEncoder.encode(token, "UTF-8")
            return "$base/api/v2/channels/samsung.remote.control?$query"
        }

        fun keyMessage(key: String): JSONObject = JSONObject().put("method", "ms.remote.control").put(
            "params",
            JSONObject().put("Cmd", "Click").put("DataOfCmd", key).put("Option", "false").put("TypeOfRemote", "SendRemoteKey"),
        )

        fun emitMessage(event: String, data: JSONObject? = null): JSONObject {
            val params = JSONObject().put("event", event).put("to", "host")
            if (data != null) params.put("data", data)
            return JSONObject().put("method", "ms.channel.emit").put("params", params)
        }

        /** Grunninfo fra TV-ens REST-API (http://<ip>:8001/api/v2/). */
        fun parseInfo(body: String): SamsungInfo {
            val json = runCatching { JSONObject(body) }.getOrNull()
            val device = json?.optJSONObject("device") ?: throw UserError("Fant ingen Samsung-TV på denne adressen.", 502)
            fun clean(value: String?, max: Int) = value.orEmpty().replace(Regex("^\\[TV\\]\\s*"), "").trim().take(max).ifEmpty { null }
            val auth = device.optString("TokenAuthSupport")
            return SamsungInfo(
                name = clean(device.optString("name").ifEmpty { json.optString("name") }, 70),
                model = clean(device.optString("modelName"), 40),
                mac = Wol.normalizeMac(device.optString("wifiMac")),
                tokenAuth = when (auth) { "true" -> true; "false" -> false; else -> null },
                powerState = device.optString("PowerState").ifEmpty { null },
            )
        }

        /** Appliste fra «ed.installedApp.get»: gyldige id-er, med tak. app_type 2 åpnes som dyplenke. */
        fun parseApps(list: JSONArray?): List<Pair<App, String>> {
            val apps = mutableListOf<Pair<App, String>>()
            for (i in 0 until (list?.length() ?: 0)) {
                val item = list?.optJSONObject(i) ?: continue
                val id = runCatching { Validate.appId(item.optString("appId")) }.getOrNull() ?: continue
                val launch = if (item.optInt("app_type", 0) == 2) "DEEP_LINK" else "NATIVE_LAUNCH"
                apps += App(id, item.optString("name").ifEmpty { id }.take(80)) to launch
                if (apps.size >= Validate.MAX_APPS) break
            }
            return apps
        }

        private val restClient = OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .callTimeout(4, TimeUnit.SECONDS)
            .build()

        /** Henter grunninfo. Blokkerende: kalles på Dispatchers.IO. */
        fun info(host: String): SamsungInfo {
            restClient.newCall(Request.Builder().url("http://$host:8001/api/v2/").build()).execute().use { response ->
                if (!response.isSuccessful) throw UserError("Fant ingen Samsung-TV på denne adressen.", 502)
                val body = response.body ?: throw UserError("Fant ingen Samsung-TV på denne adressen.", 502)
                return parseInfo(String(Icons.readLimited(body.byteStream(), 64 * 1024), Charsets.UTF_8))
            }
        }

        /** For TV-søket: bekrefter at adressen er en Samsung-TV og henter navnet den har fått. */
        fun probe(host: String): Device = Device("samsung", host, info(host).name ?: "Samsung-TV")

        fun fingerprint(cert: X509Certificate): String =
            MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }
    }

    private class CertificateMismatch : Exception("Sertifikatet til TV-en er endret")

    private class Socket(val ws: WebSocket, val fingerprint: String?) {
        @Volatile var open = true
    }

    private data class Auto(val attempt: Int, val delays: List<Long>, val message: String)

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
    private var apps: List<Pair<App, String>> = emptyList()
    private var pairingJob: Job? = null
    private var reconnectJob: Job? = null
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject?>>()
    // Tizen har ingen spill/pause-status her. Første trykk pauser, siden det vanligste er å trykke ⏯ mens noe spilles.
    private var playing = true

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
        closeSocket(control)
        host = null; control = null; ready = false; status = IDLE; code = null; canWake = false; model = null; apps = emptyList()
    }

    suspend fun disconnect() = withContext(state) { resetLocked() }

    private fun scheduleReconnect(target: String, attempt: Int, delays: List<Long>, message: String = RECONNECTING) {
        if (attempt >= delays.size) {
            status = UNREACHABLE
            code = "unreachable"
            return
        }
        val gen = generation
        status = message
        reconnectJob?.cancel()
        reconnectJob = scope.launch(state) {
            delay(delays[attempt])
            if (!current(gen)) return@launch
            // connectLocked() avbryter reconnectJob; nullstill først, ellers avbryter jobben seg selv.
            reconnectJob = null
            connectLocked(target, Auto(attempt, delays, message))
        }
    }

    private fun send(message: JSONObject) {
        val socket = control
        if (!ready || socket == null || !socket.open) throw UserError(status, 409)
        socket.ws.send(message.toString())
    }

    /** Svar fra TV-en kommer som hendelser med samme navn som forespørselen. */
    private suspend fun emitAndWait(event: String, data: JSONObject? = null, timeoutMs: Long = requestTimeoutMs): JSONObject? {
        val deferred = CompletableDeferred<JSONObject?>()
        pending.put(event, deferred)?.completeExceptionally(UserError("Avbrutt av en ny forespørsel.", 409))
        try {
            send(emitMessage(event, data))
        } catch (e: Throwable) {
            pending.remove(event, deferred)
            throw e
        }
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            pending.remove(event, deferred)
            throw UserError("Samsung-TV-en svarte ikke.", 504)
        }
    }

    private suspend fun openRemote(target: String, stored: KeyStore.Entry?, info: SamsungInfo?, onMessage: (Socket, String) -> Unit, onClose: (Socket) -> Unit): Pair<Socket, Boolean> {
        val pinned = stored?.fingerprint
        val attempts = buildList {
            if (info?.tokenAuth != false) add(remoteUrl(target, secure = true, token = stored?.token))
            // En TV med låst sertifikat, eller som krever token, skal aldri nedgraderes til ukryptert forbindelse.
            if (pinned == null && info?.tokenAuth != true) add(remoteUrl(target, secure = false))
        }
        var last: Throwable? = null
        for (url in attempts) {
            val shown = url.replace(Regex("token=[^&]+"), "token=…")
            try {
                val socket = openSocket(url, if (url.startsWith("wss:")) pinned else null, onMessage, onClose)
                log("Samsung: tilkoblet $shown")
                return socket to url.startsWith("wss:")
            } catch (e: CertificateMismatch) {
                throw e
            } catch (e: Throwable) {
                e.rethrowCancellation()
                last = e
                log("Samsung: $shown feilet (${e.message})")
            }
        }
        throw last ?: IllegalStateException("Ingen forbindelse")
    }

    private fun onMessage(gen: Int, socket: Socket, raw: String) {
        if (!current(gen)) return
        val message = runCatching { JSONObject(raw) }.getOrNull() ?: return
        when (val event = message.optString("event")) {
            "ms.channel.connect" -> {
                pairingJob?.cancel()
                val token = message.optJSONObject("data")?.opt("token")?.toString()?.takeIf { Regex("^[\\w-]{1,64}$").matches(it) }
                // Avtrykket finnes bare for wss://; det låses til neste tilkobling.
                val fp = socket.fingerprint
                host?.let { target ->
                    if (token != null || fp != null) {
                        runCatching { keyStore.update(storeKey(target), token = token, fingerprint = fp) }
                            .onFailure { log("Samsung: kunne ikke lagre token (${it.message})") }
                    }
                }
                // Meldingen kan i sjeldne tilfeller komme før control er satt; den gjelder uansett denne forbindelsen.
                control = socket
                ready = true
                status = READY
                code = null
                log("Samsung: klar")
            }
            "ms.channel.unauthorized" -> {
                pairingJob?.cancel()
                log("Samsung: tilkoblingen ble avvist på TV-en")
                status = REJECTED
                code = "rejected"
                if (control === socket) control = null
                closeSocket(socket)
            }
            "ms.channel.timeOut" -> {
                pairingJob?.cancel()
                status = PAIRING_TIMEOUT
                if (control === socket) control = null
                closeSocket(socket)
            }
            else -> if (event.isNotEmpty()) pending.remove(event)?.complete(message.optJSONObject("data"))
        }
    }

    private suspend fun connectLocked(target: String, auto: Auto? = null) {
        resetLocked()
        val gen = generation
        host = target
        status = auto?.message ?: CONNECTING
        val stored = keyStore.get(storeKey(target))
        canWake = stored?.mac != null

        val info = try {
            withContext(Dispatchers.IO) { info(target) }
        } catch (e: Exception) {
            e.rethrowCancellation()
            // Svarer ikke REST-API-et, prøver vi likevel WebSocket (noen TV-er blokkerer port 8001 i hvilemodus).
            log("Samsung: fant ikke TV-info (${e.message})")
            null
        }
        if (!current(gen)) return
        info?.model?.let { model = "Samsung $it" }
        info?.mac?.let { mac ->
            canWake = true
            if (mac != stored?.mac) runCatching { keyStore.update(storeKey(target), mac = mac) }
        }

        val (socket, _) = try {
            openRemote(
                target,
                stored,
                info,
                onMessage = { s, raw -> onMessage(gen, s, raw) },
                onClose = { s ->
                    if (current(gen) && control === s) {
                        val wasReady = ready
                        pairingJob?.cancel()
                        rejectPending(LOST)
                        ready = false
                        control = null
                        if (wasReady) scheduleReconnect(target, 0, reconnectDelays)
                        else if (status != REJECTED && status != PAIRING_TIMEOUT) status = LOST
                    }
                },
            )
        } catch (e: CertificateMismatch) {
            log("Samsung: sertifikatet stemmer ikke med det som ble låst ved paring")
            if (current(gen)) {
                status = CERT_CHANGED
                code = "cert-changed"
            }
            return
        } catch (e: Throwable) {
            e.rethrowCancellation()
            if (!current(gen)) return
            if (auto != null) {
                scheduleReconnect(target, auto.attempt + 1, auto.delays, auto.message)
            } else {
                status = UNREACHABLE
                code = "unreachable"
            }
            return
        }
        if (!current(gen)) return closeSocket(socket)
        if (!ready) {
            control = socket
            status = PAIRING
        }
        // Med gyldig token svarer TV-en med en gang. Ellers venter den på at noen trykker «Tillat».
        pairingJob = scope.launch(state) {
            delay(pairingTimeoutMs)
            if (!current(gen) || ready) return@launch
            status = PAIRING_TIMEOUT
            control = null
            closeSocket(socket)
        }
    }

    suspend fun connect(target: String) = withContext(state) { connectLocked(target) }

    /**
     * Kalles når appen kommer i forgrunnen. Android fryser appen i bakgrunnen, og TV-en kan lukke
     * forbindelsen uten at vi merker det. Sjekk at den svarer, og koble til på nytt med lagret token hvis ikke.
     */
    suspend fun ensureConnected(target: String) = withContext(state) {
        if (host == target && status in setOf(CONNECTING, PAIRING, WAKING)) return@withContext
        // Tilstander som krever at brukeren gjør noe, skal ikke gi nye forespørsler på TV-en av seg selv.
        if (host == target && status in setOf(CERT_CHANGED, REJECTED, PAIRING_TIMEOUT)) return@withContext
        if (ready && host == target) {
            val alive = try {
                emitAndWait("ed.installedApp.get", timeoutMs = 1500)
                true
            } catch (e: Exception) {
                e.rethrowCancellation()
                false
            }
            if (alive) return@withContext
            log("Samsung: forbindelsen svarte ikke etter pause, kobler til igjen")
        } else {
            log("Samsung: kobler til igjen etter pause")
        }
        connectLocked(target, Auto(0, reconnectDelays, RECONNECTING))
    }

    suspend fun pauseReconnect() = withContext(state) {
        reconnectJob?.cancel()
        Unit
    }

    suspend fun command(key: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        if (key == "PlayPause") {
            send(keyMessage(if (playing) "KEY_PAUSE" else "KEY_PLAY"))
            playing = !playing
            return@withContext
        }
        val name = KEYS[key] ?: throw UserError("Denne kommandoen støttes ikke av Samsung.")
        if (key == "Play") playing = true
        if (key == "Pause") playing = false
        send(keyMessage(name))
    }

    suspend fun powerOn(target: String) = withContext(state) {
        val mac = keyStore.get(storeKey(target))?.mac ?: throw UserError(NO_WAKE, 409)
        withContext(Dispatchers.IO) { Wol.send(mac, target) }
        resetLocked()
        host = target
        canWake = true
        scheduleReconnect(target, 0, wakeDelays, WAKING)
    }

    /** Skriver i tekstfeltet som er åpent på TV-en (skjermtastaturet må vises). */
    suspend fun text(value: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        val encoded = Base64.getEncoder().encodeToString(value.toByteArray(Charsets.UTF_8))
        send(JSONObject().put("method", "ms.remote.control").put("params", JSONObject().put("Cmd", encoded).put("DataOfCmd", "base64").put("TypeOfRemote", "SendInputString")))
        send(JSONObject().put("method", "ms.remote.control").put("params", JSONObject().put("TypeOfRemote", "SendInputEnd")))
    }

    suspend fun apps(): List<App> = withContext(state) {
        if (!ready) throw UserError(status, 409)
        val data = emitAndWait("ed.installedApp.get")
        apps = parseApps(data?.optJSONArray("data"))
        apps.map { it.first }
    }

    suspend fun launch(id: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        val (app, type) = apps.firstOrNull { it.first.id == id } ?: throw UserError("Ukjent app.", 404)
        send(emitMessage("ed.apps.launch", JSONObject().put("appId", app.id).put("action_type", type)))
    }

    suspend fun inputs(): List<Input> = withContext(state) {
        if (!ready) throw UserError(status, 409)
        INPUTS
    }

    suspend fun switchInput(id: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        if (INPUTS.none { it.id == id }) throw UserError("Ukjent inngang.", 404)
        send(keyMessage(id))
    }

    /** YouTube på TV-en via DIAL (samme som «cast» fra mobilen). Svarer ikke DIAL, åpnes appen med dyplenke. */
    suspend fun playYoutube(videoId: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        val target = host ?: throw UserError(status, 409)
        log("Samsung: spiller YouTube-video $videoId")
        val dialOk = try {
            withContext(Dispatchers.IO) {
                val body = "v=$videoId".toRequestBody("text/plain; charset=utf-8".toMediaType())
                restClient.newCall(Request.Builder().url("http://$target:8080/ws/apps/YouTube").post(body).build()).execute().use { it.isSuccessful }
            }
        } catch (e: Exception) {
            e.rethrowCancellation()
            log("Samsung: DIAL feilet (${e.message}), bruker dyplenke")
            false
        }
        if (dialOk) return@withContext
        val id = apps.firstOrNull { (app, _) -> app.name.contains("youtube", ignoreCase = true) && !Regex("kids|music", RegexOption.IGNORE_CASE).containsMatchIn(app.name) }?.first?.id
            ?: YOUTUBE_APP_ID
        send(emitMessage("ed.apps.launch", JSONObject().put("appId", id).put("action_type", "DEEP_LINK").put("metaTag", "v=$videoId")))
    }

    fun forget(target: String) = keyStore.remove(storeKey(target))
}

data class SamsungInfo(val name: String?, val model: String?, val mac: String?, val tokenAuth: Boolean?, val powerState: String?)
