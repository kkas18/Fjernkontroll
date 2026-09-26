package no.fjern.app

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder

/** Roku External Control Protocol (ECP) på port 8060. */
object Roku {
    /** Appens kommandonavn → Roku ECP-taster. Roku har ingen egen pause-tast; Play veksler. */
    val KEYS = mapOf(
        "Up" to "Up", "Down" to "Down", "Left" to "Left", "Right" to "Right", "Select" to "Select",
        "Back" to "Back", "Home" to "Home", "VolumeUp" to "VolumeUp", "VolumeDown" to "VolumeDown",
        "Mute" to "VolumeMute", "PowerOff" to "PowerOff", "PowerOn" to "PowerOn",
        "Play" to "Play", "Pause" to "Play", "Rewind" to "Rev", "FastForward" to "Fwd",
        "ChannelUp" to "ChannelUp", "ChannelDown" to "ChannelDown", "Backspace" to "Backspace",
    )
    const val MAX_RESPONSE_BYTES = 64 * 1024

    private fun open(host: String, path: String, method: String, timeoutMs: Int): HttpURLConnection {
        val connection = URL("http://$host:8060$path").openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = timeoutMs
        connection.readTimeout = timeoutMs
        connection.instanceFollowRedirects = false
        if (method == "POST") {
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(0)
        }
        return connection
    }

    /** Svar fra lokalnettet leses med tak, slik at en feilaktig enhet ikke kan fylle minnet. */
    fun readLimited(connection: HttpURLConnection, max: Int = MAX_RESPONSE_BYTES): String {
        connection.inputStream.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (out.size() + read > max) throw UserError("For stort svar fra TV-en.", 502)
                out.write(buffer, 0, read)
            }
            return out.toString(Charsets.UTF_8.name())
        }
    }

    fun decodeXml(text: String) = text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
        .replace("&apos;", "'").replace("&amp;", "&")

    fun parseDeviceInfo(host: String, xml: String): Device {
        val raw = Regex("""<(?:user-device-name|friendly-device-name)>([^<]{1,120})</""", RegexOption.IGNORE_CASE).find(xml)?.groupValues?.get(1)
        val isTv = Regex("""<is-tv>\s*true\s*</is-tv>""", RegexOption.IGNORE_CASE).containsMatchIn(xml)
        return Device("roku", host, raw?.let { decodeXml(it).trim() } ?: "Roku", isTv)
    }

    fun probe(host: String, timeoutMs: Int = 2500): Device {
        val connection = try {
            open(host, "/query/device-info", "GET", timeoutMs).also { it.connect() }
        } catch (e: SocketTimeoutException) {
            throw e
        } catch (e: Exception) {
            throw UserError("Fikk ikke kontakt med Roku. Sjekk IP-adressen og at «Control by mobile apps» er på.", 502)
        }
        try {
            if (connection.responseCode !in 200..299) throw UserError("Roku avviste tilkoblingen. Aktiver «Control by mobile apps» på TV-en.", 502)
            return parseDeviceInfo(host, readLimited(connection))
        } finally {
            connection.disconnect()
        }
    }

    private fun keypress(host: String, key: String, timeoutMs: Int) {
        val connection = open(host, "/keypress/$key", "POST", timeoutMs)
        try {
            if (connection.responseCode !in 200..299) throw UserError("Roku avviste kommandoen.", 502)
        } finally {
            connection.disconnect()
        }
    }

    fun command(host: String, command: String) {
        val key = KEYS[command] ?: throw UserError("Denne kommandoen støttes ikke av Roku.")
        keypress(host, key, 2500)
    }

    /** Roku tar imot tekst ett tegn om gangen. Kort tidsavbrudd per tegn og stopp ved første feil. */
    fun text(host: String, text: String) {
        var i = 0
        while (i < text.length) {
            val codePoint = text.codePointAt(i)
            val char = String(Character.toChars(codePoint))
            keypress(host, "Lit_" + URLEncoder.encode(char, "UTF-8").replace("+", "%20"), 1200)
            i += Character.charCount(codePoint)
        }
    }

    fun parseApps(xml: String): List<App> {
        val apps = mutableListOf<App>()
        for (match in Regex("""<app\s+id="([^"]{1,80})"([^>]*)>([^<]{1,80})</app>""").findAll(xml)) {
            try {
                // type="tvin" er innganger (HDMI, antenne); de sorteres sammen med systemapper.
                val type = Regex("""type="([^"]*)"""").find(match.groupValues[2])?.groupValues?.get(1)
                apps += App(Validate.appId(match.groupValues[1]), decodeXml(match.groupValues[3]).trim(), system = type != null && type != "appl")
            } catch (_: UserError) {
                // hopp over ugyldige id-er
            }
            if (apps.size >= Validate.MAX_APPS) break
        }
        return apps
    }

    fun apps(host: String): List<App> {
        val connection = open(host, "/query/apps", "GET", 2500)
        try {
            if (connection.responseCode !in 200..299) throw UserError("Roku ga ikke ut applisten.", 502)
            return parseApps(readLimited(connection))
        } finally {
            connection.disconnect()
        }
    }

    fun launch(host: String, id: String) {
        val connection = open(host, "/launch/" + URLEncoder.encode(id, "UTF-8"), "POST", 4000)
        try {
            if (connection.responseCode !in 200..299) throw UserError("Roku kunne ikke åpne appen.", 502)
        } finally {
            connection.disconnect()
        }
    }

    fun icon(host: String, id: String): ByteArray {
        val connection = open(host, "/query/icon/" + URLEncoder.encode(id, "UTF-8"), "GET", 3000)
        try {
            if (connection.responseCode !in 200..299) throw UserError("Roku ga ikke ut ikonet.", 502)
            return connection.inputStream.use { Icons.readLimited(it) }
        } finally {
            connection.disconnect()
        }
    }
}
