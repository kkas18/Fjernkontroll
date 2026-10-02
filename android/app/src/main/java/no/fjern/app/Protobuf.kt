package no.fjern.app

import java.io.ByteArrayOutputStream

/** Minimal protobuf-koding (wire format) for Android TV-protokollen, samme som lib/protobuf.mjs. */
object Proto {
    fun varint(value: Long): ByteArray {
        val out = ByteArrayOutputStream()
        var n = value
        do {
            var byte = (n and 0x7f).toInt()
            n = n ushr 7
            if (n != 0L) byte = byte or 0x80
            out.write(byte)
        } while (n != 0L)
        return out.toByteArray()
    }

    /** Leser en varint fra [offset]. Gir (verdi, lengde), eller null hvis bufferen ikke er komplett. */
    fun readVarint(buffer: ByteArray, offset: Int = 0, end: Int = buffer.size): Pair<Long, Int>? {
        var result = 0L
        var shift = 0
        var i = offset
        while (i < end && i < offset + 10) {
            val byte = buffer[i].toInt() and 0xff
            result = result or ((byte and 0x7f).toLong() shl shift)
            if (byte and 0x80 == 0) return result to (i - offset + 1)
            shift += 7
            i += 1
        }
        if (end - offset >= 10) throw IllegalArgumentException("Ugyldig varint")
        return null
    }

    /**
     * Bygger en melding av felt (nummer, verdi). Tall/bool blir varint, ByteArray/String lengdeprefiksert.
     * null hoppes over; en liste gir gjentatte felt.
     */
    fun encode(vararg fields: Pair<Int, Any?>): ByteArray {
        val out = ByteArrayOutputStream()
        for ((number, value) in fields) {
            val items = if (value is List<*>) value else listOf(value)
            for (item in items) {
                when (item) {
                    null -> Unit
                    is Int, is Long, is Boolean -> {
                        out.write(varint((number shl 3).toLong()))
                        out.write(varint(when (item) { is Boolean -> if (item) 1L else 0L; is Int -> item.toLong(); else -> item as Long }))
                    }
                    else -> {
                        val bytes = if (item is ByteArray) item else item.toString().toByteArray(Charsets.UTF_8)
                        out.write(varint(((number shl 3) or 2).toLong()))
                        out.write(varint(bytes.size.toLong()))
                        out.write(bytes)
                    }
                }
            }
        }
        return out.toByteArray()
    }

    /** Dekodede felt: nummer → verdier (Long for varint, ByteArray for lengdeprefiksert). */
    class Fields(private val map: Map<Int, List<Any>>) {
        fun has(number: Int) = map.containsKey(number)
        fun numbers(): List<Int> = map.keys.toList()
        fun long(number: Int): Long? = map[number]?.firstOrNull() as? Long
        fun bytes(number: Int): ByteArray? = map[number]?.firstOrNull() as? ByteArray
        fun message(number: Int): Fields? = bytes(number)?.let { decode(it) }
        fun text(number: Int): String = bytes(number)?.toString(Charsets.UTF_8) ?: ""
    }

    fun decode(buffer: ByteArray): Fields {
        val fields = LinkedHashMap<Int, MutableList<Any>>()
        var offset = 0
        while (offset < buffer.size) {
            val (key, keyLength) = readVarint(buffer, offset) ?: throw IllegalArgumentException("Avkuttet protobuf-melding")
            offset += keyLength
            val number = (key ushr 3).toInt()
            val value: Any = when ((key and 7).toInt()) {
                0 -> {
                    val (value, length) = readVarint(buffer, offset) ?: throw IllegalArgumentException("Avkuttet protobuf-melding")
                    offset += length
                    value
                }
                2 -> {
                    val (size, length) = readVarint(buffer, offset) ?: throw IllegalArgumentException("Avkuttet protobuf-melding")
                    offset += length
                    if (size < 0 || offset + size > buffer.size) throw IllegalArgumentException("Avkuttet protobuf-melding")
                    buffer.copyOfRange(offset, offset + size.toInt()).also { offset += size.toInt() }
                }
                5 -> { offset += 4; 0L }
                1 -> { offset += 8; 0L }
                else -> throw IllegalArgumentException("Ukjent protobuf-type")
            }
            fields.getOrPut(number) { mutableListOf() } += value
        }
        return Fields(fields)
    }

    /** Strømmen er en rekke meldinger, hver med varint-lengde foran. */
    fun frame(payload: ByteArray): ByteArray = varint(payload.size.toLong()) + payload

    /** Samler bytes fra strømmen og gir hele meldinger. */
    class FrameReader(private val max: Int = 64 * 1024, private val onMessage: (ByteArray) -> Unit) {
        private var buffer = ByteArray(0)

        fun feed(chunk: ByteArray, length: Int = chunk.size) {
            buffer += chunk.copyOf(length)
            while (true) {
                val (size, header) = readVarint(buffer) ?: return
                if (size < 0 || size > max) throw IllegalArgumentException("For stor melding fra TV-en")
                if (buffer.size < header + size) return
                val payload = buffer.copyOfRange(header, header + size.toInt())
                buffer = buffer.copyOfRange(header + size.toInt(), buffer.size)
                onMessage(payload)
            }
        }
    }
}
