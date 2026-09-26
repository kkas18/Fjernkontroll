package no.fjern.app

import java.io.ByteArrayOutputStream
import java.io.InputStream

/** Appikoner fra TV-en: bare ekte bildefiler (avgjort ut fra innholdet) og med tak på størrelse. */
object Icons {
    const val MAX_BYTES = 256 * 1024

    fun sniff(bytes: ByteArray): String? {
        if (bytes.size < 12) return null
        fun ascii(from: Int, to: Int) = String(bytes, from, to - from, Charsets.ISO_8859_1)
        return when {
            bytes[0] == 0x89.toByte() && ascii(1, 4) == "PNG" -> "image/png"
            bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte() -> "image/jpeg"
            ascii(0, 4) == "GIF8" -> "image/gif"
            ascii(0, 4) == "RIFF" && ascii(8, 12) == "WEBP" -> "image/webp"
            else -> null
        }
    }

    fun readLimited(input: InputStream, max: Int = MAX_BYTES): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (out.size() + read > max) throw UserError("Ikonet er for stort.", 502)
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    /** Enkel LRU-buffer, så ikonene ikke hentes på nytt hver gang grensesnittet tegnes. */
    class Cache(private val max: Int = 96) {
        private val map = object : LinkedHashMap<String, Pair<String, ByteArray>>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Pair<String, ByteArray>>?) = size > max
        }
        fun get(key: String) = synchronized(map) { map[key] }
        fun put(key: String, value: Pair<String, ByteArray>) = synchronized(map) { map[key] = value }
    }
}
