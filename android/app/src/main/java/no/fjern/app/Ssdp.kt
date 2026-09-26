package no.fjern.app

import android.net.wifi.WifiManager
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

/** TV-søk med SSDP. Android slipper bare gjennom multicast mens en MulticastLock holdes. */
class Ssdp(private val wifi: WifiManager?) {
    companion object {
        const val MAX_DEVICES = 32
        private const val MULTICAST = "239.255.255.250"
        private val TARGETS = listOf("roku:ecp", "urn:lge-com:service:webos-second-screen:1", "ssdp:all")

        fun classify(message: String, host: String): Device? {
            if (!Validate.isPrivateIPv4(host)) return null
            val text = message.lowercase()
            return when {
                "roku" in text -> Device("roku", host, "Roku")
                "webos" in text || "lge-com" in text -> Device("lg", host, "LG-TV")
                else -> null
            }
        }
    }

    /** Samler svar med tak på antall enheter. */
    class Collector(private val max: Int = MAX_DEVICES) {
        private val found = LinkedHashMap<String, Device>()
        fun add(message: String, host: String) {
            val device = classify(message, host) ?: return
            val key = "${device.type}:${device.host}"
            if (found.size < max || key in found) found[key] = device
        }
        fun devices(): List<Device> = found.values.toList()
    }

    fun search(waitMs: Long = 4500): List<Device> {
        val lock = wifi?.createMulticastLock("fjern-ssdp")?.apply { setReferenceCounted(false); acquire() }
        val collector = Collector()
        try {
            DatagramSocket().use { socket ->
                socket.soTimeout = 250
                val group = InetAddress.getByName(MULTICAST)
                for (target in TARGETS) {
                    val packet = "M-SEARCH * HTTP/1.1\r\nHOST: $MULTICAST:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: $target\r\n\r\n".toByteArray()
                    runCatching { socket.send(DatagramPacket(packet, packet.size, group, 1900)) }
                }
                val deadline = System.currentTimeMillis() + waitMs
                val buffer = ByteArray(2048)
                while (System.currentTimeMillis() < deadline) {
                    val incoming = DatagramPacket(buffer, buffer.size)
                    try {
                        socket.receive(incoming)
                        collector.add(String(incoming.data, 0, incoming.length, Charsets.UTF_8), incoming.address.hostAddress ?: continue)
                    } catch (_: SocketTimeoutException) {
                        // fortsett til fristen går ut
                    }
                }
            }
        } finally {
            lock?.release()
        }
        return collector.devices()
    }
}
