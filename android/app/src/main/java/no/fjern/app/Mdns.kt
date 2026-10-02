package no.fjern.app

import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

/**
 * Søk etter Android TV med mDNS (DNS-SD), samme som lib/mdns.mjs: spør etter _androidtvremote2._tcp.local
 * fra en vilkårlig port, så enhetene svarer direkte til oss (RFC 6762 §6.7).
 */
object Mdns {
    const val SERVICE = "_androidtvremote2._tcp.local"
    private const val MULTICAST = "224.0.0.251"
    private const val PTR = 12

    fun query(service: String = SERVICE): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(ByteArray(12).also { it[5] = 1 }) // ett spørsmål
        for (label in service.split(".")) {
            val bytes = label.toByteArray(Charsets.UTF_8)
            out.write(bytes.size)
            out.write(bytes)
        }
        out.write(0)
        out.write(byteArrayOf(0, PTR.toByte(), 0x80.toByte(), 0x01)) // PTR, IN med ønske om direkte svar (QU)
        return out.toByteArray()
    }

    private fun u16(buffer: ByteArray, offset: Int) = ((buffer[offset].toInt() and 0xff) shl 8) or (buffer[offset + 1].toInt() and 0xff)

    /** Leser et DNS-navn med komprimering. Gir (navn, posisjon etter navnet). */
    fun readName(buffer: ByteArray, offset: Int): Pair<String, Int> {
        val labels = mutableListOf<String>()
        var position = offset
        var end: Int? = null
        repeat(32) {
            if (position >= buffer.size) throw IllegalArgumentException("Avkuttet DNS-navn")
            val length = buffer[position].toInt() and 0xff
            if (length == 0) return labels.joinToString(".") to (end ?: (position + 1))
            if (length and 0xc0 == 0xc0) {
                if (position + 1 >= buffer.size) throw IllegalArgumentException("Avkuttet DNS-peker")
                if (end == null) end = position + 2
                position = ((length and 0x3f) shl 8) or (buffer[position + 1].toInt() and 0xff)
                return@repeat
            }
            if (position + 1 + length > buffer.size) throw IllegalArgumentException("Avkuttet DNS-etikett")
            labels += String(buffer, position + 1, length, Charsets.UTF_8)
            position += 1 + length
        }
        throw IllegalArgumentException("For mange DNS-pekere")
    }

    /** Instansnavnene i et svar (for eksempel «Telia Play-boks»). */
    fun parseResponse(buffer: ByteArray, length: Int = buffer.size, service: String = SERVICE): List<String> {
        val data = buffer.copyOf(length)
        if (data.size < 12) return emptyList()
        val questions = u16(data, 4)
        val records = u16(data, 6) + u16(data, 8) + u16(data, 10)
        var offset = 12
        repeat(questions) { offset = readName(data, offset).second + 4 }
        val names = mutableListOf<String>()
        val suffix = ".$service".lowercase()
        for (i in 0 until records) {
            if (offset + 10 > data.size) break
            val (owner, after) = readName(data, offset)
            offset = after
            if (offset + 10 > data.size) break
            val type = u16(data, offset)
            val size = u16(data, offset + 8)
            val start = offset + 10
            offset = start + size
            if (type == PTR && owner.equals(service, ignoreCase = true)) {
                val target = readName(data, start).first
                if (target.lowercase().endsWith(suffix)) names += target.dropLast(suffix.length).take(70)
            }
        }
        return names
    }

    /** Sender spørringen to ganger (UDP kan gå tapt) og samler svar til fristen går ut. Blokkerende. */
    fun search(waitMs: Long = 3000): List<Device> {
        val found = LinkedHashMap<String, Device>()
        DatagramSocket().use { socket ->
            socket.soTimeout = 250
            val packet = query()
            val group = InetAddress.getByName(MULTICAST)
            val deadline = System.currentTimeMillis() + waitMs
            var sent = 0
            val buffer = ByteArray(4096)
            while (System.currentTimeMillis() < deadline) {
                if (sent < 2 && System.currentTimeMillis() >= deadline - waitMs + sent * 600L) {
                    runCatching { socket.send(DatagramPacket(packet, packet.size, group, 5353)) }
                    sent += 1
                }
                val incoming = DatagramPacket(buffer, buffer.size)
                try {
                    socket.receive(incoming)
                } catch (_: SocketTimeoutException) {
                    continue
                }
                val host = incoming.address.hostAddress ?: continue
                if (!Validate.isPrivateIPv4(host)) continue
                val names = runCatching { parseResponse(incoming.data, incoming.length) }.getOrDefault(emptyList())
                if (names.isEmpty()) continue
                if (found.size < Ssdp.MAX_DEVICES || host in found) found[host] = Device("androidtv", host, names.first().ifEmpty { "Android TV" })
            }
        }
        return found.values.toList()
    }
}
