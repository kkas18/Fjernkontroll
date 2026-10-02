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
import org.json.JSONObject
import java.io.File
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509TrustManager

/**
 * Android TV / Google TV (for eksempel Telia-boksen) via Android TV Remote-protokollen versjon 2, samme som
 * lib/androidtv.mjs. Paring på port 6467 med kode fra skjermen, fjernkontroll på port 6466 med appens
 * klientsertifikat. Boksens sertifikat låses etter første tilkobling.
 *
 * All tilstand endres på én tråd, som i LgSession; lesing fra nettverket skjer på egne IO-tråder.
 */
class AndroidTvSession(
    private val keyStore: KeyStore,
    private val identityFile: File,
    private val scope: CoroutineScope,
    private val log: (String) -> Unit = {},
    private val remotePort: Int = 6466,
    private val pairingPort: Int = 6467,
    private val connectTimeoutMs: Int = 5000,
    private val readyTimeoutMs: Long = 8000,
    private val pairingTimeoutMs: Long = 180_000,
    private val answerTimeoutMs: Long = 8000,
    private val reconnectDelays: List<Long> = listOf(1000, 2000, 4000, 8000, 16_000),
) {
    companion object {
        const val IDLE = "Frakoblet"
        const val CONNECTING = "Kobler til Android TV …"
        const val RECONNECTING = "Forbindelsen falt ut. Kobler til igjen …"
        const val PAIRING = "Starter paring. Se på TV-en …"
        const val NEEDS_CODE = "Skriv inn koden som vises på TV-en."
        const val CHECKING = "Sjekker koden …"
        const val READY = "Tilkoblet"
        const val UNREACHABLE = "Fikk ikke kontakt med Android TV-en. Sjekk at den er på, på samme Wi‑Fi, og at IP-adressen stemmer."
        const val PAIRING_FAILED = "Paringen ble avbrutt. Velg enheten og prøv igjen."
        const val PAIRING_TIMEOUT = "Koden ble ikke skrevet inn i tide. Velg enheten og prøv igjen."
        const val LOST = "Android TV-en ble frakoblet. Velg enheten for å koble til igjen."
        const val CERT_CHANGED = "Sertifikatet til Android TV-en er endret. Det kan bety at noen utgir seg for den. Par på nytt bare hvis enheten er tilbakestilt eller oppdatert."
        const val NO_POWER = "Android TV-en kan bare slås på mens appen er koblet til den. Bruk fjernkontrollen eller TV-en."
        const val NEEDS_FOCUS = "Åpne et tekstfelt på TV-en først, så skjermtastaturet vises."
        const val WRONG_CODE = "Feil kode. Sjekk koden på TV-en og prøv igjen."

        /** Android KeyEvent-koder. */
        val KEYS = mapOf(
            "Up" to 19, "Down" to 20, "Left" to 21, "Right" to 22, "Select" to 23, "Back" to 4, "Home" to 3,
            "VolumeUp" to 24, "VolumeDown" to 25, "Mute" to 164,
            "Play" to 126, "Pause" to 127, "PlayPause" to 85, "Rewind" to 89, "FastForward" to 90,
            "ChannelUp" to 166, "ChannelDown" to 167, "Enter" to 66, "Backspace" to 67,
            "Red" to 183, "Green" to 184, "Yellow" to 185, "Blue" to 186,
            "Info" to 165, "Guide" to 172, "Settings" to 176, "Subtitles" to 175, "Teletext" to 233, "Recent" to 187, "Search" to 84,
        ) + (0..9).associate { "Num$it" to 7 + it }
        private const val KEYCODE_POWER = 26
        val EXTRA_KEYS = (0..9).map { "Num$it" } + listOf(
            "Red", "Green", "Yellow", "Blue", "Info", "Guide", "Settings", "Subtitles", "Teletext", "Recent", "Search", "Enter",
        )

        /**
         * Protokollen har ingen appliste. Appene åpnes med pakkenavnet via market://launch?id=…, som Play-butikken
         * på boksen sender videre til appen (samme som androidtvremote2/Home Assistant). Nettadresser virker ikke
         * på alle bokser: uten nettleser tar ingen imot dem. Ikonene ligger i public/icons/apps/. Samme liste som
         * lib/androidtv.mjs.
         */
        data class AppEntry(val id: String, val name: String, val pkg: String) {
            val link get() = "market://launch?id=$pkg"
            val icon get() = "/icons/apps/$id.png"
        }
        val APPS = listOf(
            AppEntry("teliaplay", "Telia Play", "no.get.play.tv"),
            AppEntry("nrktv", "NRK TV", "no.nrk.tv"),
            AppEntry("tv2play", "TV 2 Play", "no.tv2.sumo"),
            AppEntry("netflix", "Netflix", "com.netflix.ninja"),
            AppEntry("youtube", "YouTube", "com.google.android.youtube.tv"),
            AppEntry("disneyplus", "Disney+", "com.disney.disneyplus"),
            AppEntry("max", "HBO Max", "com.wbd.stream"),
            AppEntry("primevideo", "Prime Video", "com.amazon.amazonvideo.livingroom"),
            AppEntry("viaplay", "Viaplay", "com.viaplay.android"),
            AppEntry("spotify", "Spotify", "com.spotify.tv.android"),
            AppEntry("appletv", "Apple TV", "com.apple.atve.androidtv.appletv"),
        )
        const val NO_APP_LINKS = "Boksen tillater ikke at fjernkontroller åpner apper. Bruk Hjem-knappen og velg appen på TV-en."

        fun storeKey(host: String) = "androidtv:$host"

        private const val STATUS_OK = 200L
        /** Funksjoner vi ber om (RemoteConfigure.code1): ping, taster, skjermtastatur, strøm, volum, applenker. */
        const val FEATURE_APP_LINK = 512
        const val FEATURES = 1 or 2 or 4 or 32 or 64 or FEATURE_APP_LINK // 615
        /** Vi bruker bare det både vi og boksen støtter. Oppgir ikke boksen noe, ber vi om alt. */
        fun activeFeatures(supported: Long) = if (supported == 0L) FEATURES else FEATURES and supported.toInt()
        private fun encoding() = Proto.encode(1 to 3, 2 to 6) // heksadesimal, seks tegn
        private fun outer(field: Int, payload: ByteArray) = Proto.encode(1 to 2, 2 to 200, field to payload)

        fun pairingRequest(clientName: String = "Fjern") = outer(10, Proto.encode(1 to "atvremote", 2 to clientName))
        fun pairingOptions() = outer(20, Proto.encode(1 to encoding(), 3 to 1))
        fun pairingConfiguration() = outer(30, Proto.encode(1 to encoding(), 2 to 1))
        fun pairingSecretMessage(secret: ByteArray) = outer(40, Proto.encode(1 to secret))

        fun remoteConfigure(features: Int = FEATURES) = Proto.encode(1 to Proto.encode(1 to features, 2 to Proto.encode(
            1 to "Fjern", 2 to "Fjern", 3 to 1, 4 to "1", 5 to "atvremote", 6 to "1.0.0",
        )))
        fun remoteSetActive(features: Int = FEATURES) = Proto.encode(2 to Proto.encode(1 to features))
        fun remotePingResponse(value: Long) = Proto.encode(9 to Proto.encode(1 to value))
        /** direction 3 = SHORT (trykk og slipp) */
        fun remoteKey(code: Int) = Proto.encode(10 to Proto.encode(1 to code, 2 to 3))
        fun remoteAppLink(link: String) = Proto.encode(90 to Proto.encode(1 to link))
        fun remoteText(value: String, ime: Long, field: Long): ByteArray {
            val end = value.length - 1
            return Proto.encode(21 to Proto.encode(
                1 to ime, 2 to field,
                3 to Proto.encode(1 to 1, 2 to Proto.encode(1 to end, 2 to end, 3 to value)),
            ))
        }

        /**
         * Paringskoden er seks heksadesimale tegn. De fire siste er tilfeldige; de to første er første byte av
         * SHA-256(klientmodulus ‖ klienteksponent ‖ boksmodulus ‖ bokseksponent ‖ de fire siste), som sjekk.
         * Gir null hvis koden ikke stemmer.
         */
        fun pairingSecret(clientKey: PublicKey, serverKey: PublicKey, code: String?): ByteArray? {
            val clean = code.orEmpty().trim().uppercase()
            if (!Regex("^[0-9A-F]{6}$").matches(clean)) throw UserError("Koden er seks tegn (0–9 og A–F), slik den vises på TV-en.")
            val bytes = clean.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            val (clientModulus, clientExponent) = X509.rsaNumbers(clientKey)
            val (serverModulus, serverExponent) = X509.rsaNumbers(serverKey)
            val hash = MessageDigest.getInstance("SHA-256").run {
                update(clientModulus); update(clientExponent); update(serverModulus); update(serverExponent)
                update(bytes, 1, 2)
                digest()
            }
            return if (hash[0] == bytes[0]) hash else null
        }

        fun fingerprint(cert: X509Certificate): String =
            MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }

        /** Appens eget sertifikat og nøkkel. Lages første gang og lagres i appens private lagring. */
        fun loadOrCreateIdentity(file: File): X509.Identity {
            runCatching {
                val json = JSONObject(file.readText())
                return X509.load(Base64.getDecoder().decode(json.getString("cert")), Base64.getDecoder().decode(json.getString("key")))
            }
            val identity = X509.create("Fjern")
            file.parentFile?.mkdirs()
            val temp = File(file.parentFile, "${file.name}.${UUID.randomUUID()}.tmp")
            temp.writeText(JSONObject()
                .put("cert", Base64.getEncoder().encodeToString(identity.certDer))
                .put("key", Base64.getEncoder().encodeToString(identity.keyDer)).toString())
            if (!temp.renameTo(file)) {
                temp.delete()
                throw java.io.IOException("Kunne ikke lagre klientsertifikatet")
            }
            return identity
        }
    }

    private class CertificateMismatch : Exception("Sertifikatet til Android TV-en er endret")

    /** En åpen TLS-forbindelse. Skrivinger er serialisert; lesing skjer på en egen tråd. */
    private class Conn(val socket: SSLSocket, val fingerprint: String?, val peerKey: PublicKey?) {
        @Volatile var open = true
        fun write(payload: ByteArray) = synchronized(this) {
            socket.outputStream.write(Proto.frame(payload))
            socket.outputStream.flush()
        }
        fun close() {
            open = false
            runCatching { socket.close() }
        }
    }

    private val state = Dispatchers.IO.limitedParallelism(1)
    private var identity: X509.Identity? = null

    @Volatile var host: String? = null; private set
    @Volatile var ready = false; private set
    @Volatile var status: String = IDLE; private set
    @Volatile var code: String? = null; private set
    @Volatile var model: String? = null; private set
    /** Pakkenavnet til appen som er åpen på boksen, når den melder det. */
    @Volatile var currentApp: String? = null; private set
    val canWake get() = ready

    private var generation = 0
    private var remote: Conn? = null
    private var pairing: Conn? = null
    private var serverKey: PublicKey? = null
    private var on: Boolean? = null
    private var ime: Pair<Long, Long>? = null
    private var features = FEATURES
    private var readyJob: Job? = null
    private var pairingJob: Job? = null
    private var reconnectJob: Job? = null
    private var secretWaiter: CompletableDeferred<Unit>? = null

    private fun current(gen: Int) = gen == generation

    private suspend fun identity(): X509.Identity =
        identity ?: withContext(Dispatchers.IO) { loadOrCreateIdentity(identityFile) }.also { identity = it }

    /** Åpner TLS med klientsertifikatet. Blokkerende; kalles på Dispatchers.IO. */
    private fun openTls(target: String, port: Int, id: X509.Identity, expected: String?): Conn {
        val keyManager = object : X509ExtendedKeyManager() {
            override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf("fjern")
            override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = "fjern"
            override fun chooseEngineClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = "fjern"
            override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
            override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
            override fun getCertificateChain(alias: String?) = arrayOf(id.certificate)
            override fun getPrivateKey(alias: String?): PrivateKey = id.privateKey
        }
        // Boksens sertifikat er selvsignert; i stedet for en CA låses avtrykket.
        val captured = AtomicReference<X509Certificate?>(null)
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String?) {
                captured.set(chain[0])
                if (expected != null && fingerprint(chain[0]) != expected) throw CertificateException("mismatch")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS").apply { init(arrayOf(keyManager), arrayOf(trust), SecureRandom()) }
        val raw = Socket()
        try {
            raw.connect(InetSocketAddress(target, port), connectTimeoutMs)
            raw.soTimeout = connectTimeoutMs
            val ssl = context.socketFactory.createSocket(raw, target, port, true) as SSLSocket
            try {
                ssl.startHandshake()
            } catch (e: Exception) {
                val cert = captured.get()
                if (expected != null && cert != null && fingerprint(cert) != expected) throw CertificateMismatch()
                throw e
            }
            ssl.soTimeout = 0
            val cert = captured.get() ?: (ssl.session.peerCertificates.firstOrNull() as? X509Certificate)
            return Conn(ssl, cert?.let { fingerprint(it) }, cert?.publicKey)
        } catch (e: Exception) {
            runCatching { raw.close() }
            throw e
        }
    }

    private fun isNetworkError(e: Throwable) =
        e is ConnectException || e is NoRouteToHostException || e is SocketTimeoutException || e is UnknownHostException

    /** Leser meldinger fra forbindelsen og behandler dem én og én på tilstandstråden. */
    private fun readLoop(conn: Conn, onMessage: (ByteArray) -> Unit, onClose: () -> Unit) {
        scope.launch(Dispatchers.IO) {
            val reader = Proto.FrameReader { payload ->
                scope.launch(state) {
                    // En skrivefeil mot en forbindelse som lukkes, skal ikke bli en ufanget feil.
                    try { onMessage(payload) } catch (e: Exception) { log("Android TV: ${e.message}") }
                }
            }
            try {
                val buffer = ByteArray(8192)
                val input = conn.socket.inputStream
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    reader.feed(buffer, read)
                }
            } catch (_: Exception) {
                // lukket eller ugyldig: behandles som frakobling
            } finally {
                conn.close()
                scope.launch(state) { onClose() }
            }
        }
    }

    private fun resetLocked() {
        generation += 1
        readyJob?.cancel()
        pairingJob?.cancel()
        reconnectJob?.cancel()
        secretWaiter?.completeExceptionally(UserError(LOST, 409))
        secretWaiter = null
        remote?.close()
        pairing?.close()
        host = null; remote = null; pairing = null; serverKey = null; ready = false; status = IDLE; code = null
        model = null; on = null; ime = null; features = FEATURES; currentApp = null
    }

    suspend fun disconnect() = withContext(state) { resetLocked() }

    private fun scheduleReconnect(target: String, attempt: Int) {
        if (attempt >= reconnectDelays.size) {
            status = UNREACHABLE
            code = "unreachable"
            return
        }
        val gen = generation
        status = RECONNECTING
        reconnectJob?.cancel()
        reconnectJob = scope.launch(state) {
            delay(reconnectDelays[attempt])
            if (!current(gen)) return@launch
            // connectLocked() avbryter reconnectJob; nullstill først, ellers avbryter jobben seg selv.
            reconnectJob = null
            connectLocked(target, attempt)
        }
    }

    private fun send(payload: ByteArray) {
        val conn = remote
        if (!ready || conn == null || !conn.open) throw UserError(status, 409)
        conn.write(payload)
    }

    // --- Fjernkontroll-kanalen ---

    private fun onRemoteMessage(gen: Int, conn: Conn, payload: ByteArray) {
        if (!current(gen)) return
        val fields = runCatching { Proto.decode(payload) }.getOrElse {
            log("Android TV: ugyldig melding (${it.message})")
            return
        }
        if (fields.has(1)) {
            // Boksen presenterer seg (modell og produsent) og venter på vår konfigurasjon.
            val info = fields.message(1)?.message(2)
            val name = listOf(info?.text(2).orEmpty(), info?.text(1).orEmpty()).filter { it.isNotEmpty() }.joinToString(" ").trim().take(40)
            if (name.isNotEmpty()) model = name
            val supported = fields.message(1)?.long(1) ?: 0L
            features = activeFeatures(supported)
            log("Android TV: boksen støtter funksjoner ${if (supported == 0L) "ukjent" else supported}, bruker $features")
            if ((features and FEATURE_APP_LINK) == 0) log("Android TV: boksen støtter ikke applenker")
            conn.write(remoteConfigure(features))
        }
        if (fields.has(2)) {
            conn.write(remoteSetActive(features))
            if (!ready) {
                readyJob?.cancel()
                ready = true
                status = READY
                code = null
                val target = host
                if (target != null && conn.fingerprint != null) {
                    runCatching { keyStore.update(storeKey(target), fingerprint = conn.fingerprint) }
                        .onFailure { log("Android TV: kunne ikke lagre (${it.message})") }
                }
                log("Android TV: klar")
            }
        }
        if (fields.has(3)) log("Android TV: boksen meldte feil")
        if (fields.has(8)) conn.write(remotePingResponse(fields.message(8)?.long(1) ?: 0))
        if (fields.has(40)) on = (fields.message(40)?.long(1) ?: 0L) != 0L
        if (fields.has(20)) {
            // Boksen forteller hvilken app som er åpen (pakkenavn). Logges for feilsøking.
            val app = fields.message(20)?.message(1)?.text(12)
            if (!app.isNullOrEmpty() && app != currentApp) {
                currentApp = app
                log("Android TV: åpen app ${app.take(80)}")
            }
        }
        if (fields.has(21)) {
            // Skjermtastaturet er åpent; tellerne må sendes tilbake når vi skriver tekst.
            val edit = fields.message(21)
            ime = (edit?.long(1) ?: 0L) to (edit?.long(2) ?: 0L)
        }
    }

    private suspend fun connectLocked(target: String, attempt: Int? = null) {
        resetLocked()
        val gen = generation
        host = target
        status = if (attempt != null) RECONNECTING else CONNECTING
        val stored = keyStore.get(storeKey(target))
        val conn = try {
            val id = identity()
            withContext(Dispatchers.IO) { openTls(target, remotePort, id, stored?.fingerprint) }
        } catch (e: CertificateMismatch) {
            log("Android TV: sertifikatet stemmer ikke med det som ble låst")
            if (current(gen)) {
                status = CERT_CHANGED
                code = "cert-changed"
            }
            return
        } catch (e: Throwable) {
            e.rethrowCancellation()
            if (!current(gen)) return
            if (isNetworkError(e)) {
                log("Android TV: fikk ikke kontakt (${e.message})")
                if (attempt != null) scheduleReconnect(target, attempt + 1)
                else {
                    status = UNREACHABLE
                    code = "unreachable"
                }
            } else {
                // Boksen avviser ukjente klientsertifikater under håndtrykket: da må vi pare.
                log("Android TV: ikke paret (${e.message}), starter paring")
                startPairingLocked(target, gen)
            }
            return
        }
        if (!current(gen)) return conn.close()
        remote = conn
        var received = false
        readLoop(conn, onMessage = { payload ->
            received = true
            onRemoteMessage(gen, conn, payload)
        }) {
            if (!current(gen) || remote !== conn) return@readLoop
            val wasReady = ready
            readyJob?.cancel()
            ready = false
            remote = null
            when {
                wasReady -> scheduleReconnect(target, 0)
                // Med TLS 1.3 avviser boksen et ukjent sertifikat først etter håndtrykket, ved å lukke uten å
                // sende noe. Det gjelder også en tilbakestilt boks som har glemt appen: da må vi pare (på nytt).
                !received -> {
                    log("Android TV: lukket før første melding, starter paring")
                    scope.launch(state) { if (current(gen)) startPairingLocked(target, gen) }
                }
                attempt != null -> scheduleReconnect(target, attempt + 1)
                else -> status = LOST
            }
        }
        readyJob = scope.launch(state) {
            delay(readyTimeoutMs)
            if (current(gen) && !ready) {
                log("Android TV: svarte ikke etter tilkobling")
                conn.close()
            }
        }
    }

    suspend fun connect(target: String) = withContext(state) { connectLocked(target) }

    /** Appen er tilbake i forgrunnen: koble til igjen hvis forbindelsen er borte (ingen ny kode trengs). */
    suspend fun ensureConnected(target: String) = withContext(state) {
        if (host == target && (ready || status in setOf(CONNECTING, PAIRING, NEEDS_CODE, CHECKING, RECONNECTING))) return@withContext
        if (host == target && status in setOf(CERT_CHANGED, PAIRING_FAILED, PAIRING_TIMEOUT)) return@withContext
        log("Android TV: kobler til igjen etter pause")
        connectLocked(target, 0)
    }

    suspend fun pauseReconnect() = withContext(state) {
        reconnectJob?.cancel()
        Unit
    }

    // --- Paring ---

    private suspend fun startPairingLocked(target: String, gen: Int) {
        if (!current(gen)) return
        status = PAIRING
        code = null
        val conn = try {
            val id = identity()
            withContext(Dispatchers.IO) { openTls(target, pairingPort, id, null) }
        } catch (e: Throwable) {
            e.rethrowCancellation()
            if (!current(gen)) return
            log("Android TV: paring feilet (${e.message})")
            status = UNREACHABLE
            code = "unreachable"
            return
        }
        if (!current(gen)) return conn.close()
        pairing = conn
        serverKey = conn.peerKey
        fun fail(message: String, reason: String) {
            if (!current(gen) || pairing !== conn) return
            log("Android TV: $reason")
            pairingJob?.cancel()
            secretWaiter?.completeExceptionally(UserError(if (message == PAIRING_FAILED) WRONG_CODE else message, 409))
            secretWaiter = null
            pairing = null
            status = message
            code = null
            conn.close()
        }
        readLoop(conn, onMessage = { payload ->
            if (!current(gen)) return@readLoop
            val fields = runCatching { Proto.decode(payload) }.getOrNull() ?: return@readLoop fail(PAIRING_FAILED, "ugyldig melding")
            val result = fields.long(2)
            when {
                result != STATUS_OK -> fail(PAIRING_FAILED, "paring avvist (status $result)")
                fields.has(11) -> conn.write(pairingOptions())
                fields.has(20) -> conn.write(pairingConfiguration())
                fields.has(31) -> {
                    status = NEEDS_CODE
                    code = "needs-code"
                    log("Android TV: venter på kode fra skjermen")
                }
                fields.has(41) -> {
                    pairingJob?.cancel()
                    log("Android TV: paret")
                    pairing = null
                    conn.close()
                    val waiter = secretWaiter
                    secretWaiter = null
                    scope.launch(state) {
                        try {
                            connectLocked(target)
                            waiter?.complete(Unit)
                        } catch (e: Throwable) {
                            waiter?.completeExceptionally(e)
                        }
                    }
                }
            }
        }) { fail(PAIRING_FAILED, "paringen ble lukket") }
        pairingJob = scope.launch(state) {
            delay(pairingTimeoutMs)
            fail(PAIRING_TIMEOUT, "koden ble ikke skrevet inn i tide")
        }
        conn.write(pairingRequest())
    }

    /** Brukeren har skrevet inn koden fra skjermen. Feil kode avvises lokalt før noe sendes. */
    suspend fun finishPairing(input: String) {
        val waiter = withContext(state) {
            val conn = pairing
            if (conn == null || code != "needs-code") throw UserError("Ingen paring venter på kode. Velg enheten på nytt.", 409)
            val id = identity()
            val server = serverKey ?: throw UserError(PAIRING_FAILED, 409)
            val secret = pairingSecret(id.certificate.publicKey, server, input) ?: run {
                log("Android TV: koden stemte ikke med sjekksummen, ble ikke sendt")
                throw UserError(WRONG_CODE)
            }
            log("Android TV: kode sendt til boksen")
            status = CHECKING
            code = null
            CompletableDeferred<Unit>().also {
                secretWaiter = it
                conn.write(pairingSecretMessage(secret))
            }
        }
        try {
            withTimeout(answerTimeoutMs) { waiter.await() }
        } catch (e: TimeoutCancellationException) {
            throw UserError("Android TV-en svarte ikke på koden.", 504)
        }
    }

    // --- Kommandoer ---

    suspend fun command(key: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        if (key == "PowerOff") {
            if (on != false) send(remoteKey(KEYCODE_POWER))
            return@withContext
        }
        val keyCode = KEYS[key] ?: throw UserError("Denne kommandoen støttes ikke av Android TV.")
        send(remoteKey(keyCode))
    }

    /** Android TV støtter ikke Wake-on-LAN, men en tilkoblet boks i hvilemodus våkner av strømtasten. */
    suspend fun powerOn() = withContext(state) {
        if (!ready) throw UserError(NO_POWER, 409)
        if (on != true) send(remoteKey(KEYCODE_POWER))
    }

    suspend fun text(value: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        val (imeCounter, fieldCounter) = ime ?: throw UserError(NEEDS_FOCUS, 409)
        send(remoteText(value, imeCounter, fieldCounter))
    }

    suspend fun apps(): List<App> = withContext(state) {
        if (!ready) throw UserError(status, 409)
        APPS.map { App(it.id, it.name, bundledIcon = it.icon) }
    }

    private fun ensureAppLinks() {
        if ((features and FEATURE_APP_LINK) == 0) throw UserError(NO_APP_LINKS, 409)
    }

    suspend fun launch(id: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        val app = APPS.firstOrNull { it.id == id } ?: throw UserError("Ukjent app.", 404)
        ensureAppLinks()
        log("Android TV: åpner ${app.pkg}")
        send(remoteAppLink(app.link))
    }

    suspend fun playYoutube(videoId: String) = withContext(state) {
        if (!ready) throw UserError(status, 409)
        ensureAppLinks()
        log("Android TV: spiller YouTube-video $videoId")
        send(remoteAppLink("https://www.youtube.com/watch?v=$videoId"))
    }

    fun forget(target: String) = keyStore.remove(storeKey(target))
}
