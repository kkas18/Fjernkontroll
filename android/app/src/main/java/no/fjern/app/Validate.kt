package no.fjern.app

/** Samme regler som lib/validate.mjs i Node-broen. */
object Validate {
    val COMMANDS = setOf(
        "Up", "Down", "Left", "Right", "Select", "Back", "Home",
        "VolumeUp", "VolumeDown", "Mute", "PowerOff",
        "Play", "Pause", "Rewind", "FastForward", "ChannelUp", "ChannelDown",
        "PowerOn", "Backspace", "Enter",
        "Num0", "Num1", "Num2", "Num3", "Num4", "Num5", "Num6", "Num7", "Num8", "Num9",
        "Red", "Green", "Yellow", "Blue",
        "Info", "Guide", "List", "Dash", "Exit", "Settings", "Subtitles", "Teletext", "Aspect", "Recent",
        "Search", "Replay",
    )
    const val MAX_QUERY_LENGTH = 100
    const val MAX_TEXT_LENGTH = 140
    const val MAX_APPS = 48
    private val IPV4 = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")
    private val APP_ID = Regex("""^[\w.:-]{1,80}$""")

    /** Kun private IPv4-nett (RFC 1918). */
    fun isPrivateIPv4(ip: String?): Boolean {
        if (ip == null || !IPV4.matches(ip)) return false
        val parts = ip.split(".").map { it.toInt() }
        if (parts.any { it > 255 }) return false
        val (a, b) = parts
        return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
    }

    fun device(type: String?, host: String?, name: String?): Device {
        if ((type != "roku" && type != "lg") || !isPrivateIPv4(host)) {
            throw UserError("Oppgi en gyldig lokal IP-adresse og TV-type.")
        }
        val fallback = if (type == "lg") "LG webOS" else "Roku"
        val clean = name?.trim()?.take(70).orEmpty().ifEmpty { fallback }
        return Device(type, host!!, clean)
    }

    fun command(key: String?): String {
        if (key == null || key !in COMMANDS) throw UserError("Ukjent kommando.")
        return key
    }

    fun text(value: String?): String {
        val text = value.orEmpty().take(MAX_TEXT_LENGTH)
        if (text.isBlank()) throw UserError("Skriv inn tekst først.")
        return text
    }

    fun query(value: String?): String {
        val query = value.orEmpty().trim().take(MAX_QUERY_LENGTH)
        if (query.isEmpty()) throw UserError("Skriv hva du vil søke etter.")
        return query
    }

    fun inputId(id: String?): String {
        if (id == null || !APP_ID.matches(id)) throw UserError("Ukjent inngang.")
        return id
    }

    fun appId(id: String?): String {
        if (id == null || !APP_ID.matches(id)) throw UserError("Ukjent app.")
        return id
    }
}

data class Device(val type: String, val host: String, val name: String, val isTv: Boolean? = null)

data class Input(val id: String, val name: String, val connected: Boolean = true)

data class App(
    val id: String,
    val name: String,
    val system: Boolean = false,
    val color: String? = null,
    /** Intern adresse til ikonet på TV-en; sendes aldri til grensesnittet. */
    val icon: String? = null,
)
