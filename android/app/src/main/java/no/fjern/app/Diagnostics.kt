package no.fjern.app

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** De siste hendelsene i broen, slik at brukeren kan kopiere dem ved feilsøking. Ingen nøkler logges. */
object Diagnostics {
    private const val MAX_LINES = 150
    private val lines = ArrayDeque<String>()
    private val time = SimpleDateFormat("HH:mm:ss", Locale.ROOT)

    fun add(message: String) = synchronized(lines) {
        lines.addLast("${time.format(Date())} $message")
        while (lines.size > MAX_LINES) lines.removeFirst()
    }

    fun snapshot(): List<String> = synchronized(lines) { lines.toList() }
}
