package no.fjern.app

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/** Wake-on-LAN: «magisk pakke» som vekker en TV med «Slå på via Wi‑Fi» aktivert. */
object Wol {
    fun normalizeMac(mac: String?): String? {
        val hex = mac.orEmpty().replace(":", "").replace("-", "").lowercase()
        if (!Regex("^[0-9a-f]{12}$").matches(hex)) return null
        return hex.chunked(2).joinToString(":")
    }

    fun magicPacket(mac: String): ByteArray {
        val normalized = normalizeMac(mac) ?: throw UserError("Ugyldig MAC-adresse.")
        val address = normalized.split(":").map { it.toInt(16).toByte() }.toByteArray()
        return ByteArray(6) { 0xFF.toByte() } + (1..16).flatMap { address.toList() }.toByteArray()
    }

    fun send(mac: String, host: String) {
        val packet = magicPacket(mac)
        val targets = listOf("255.255.255.255", host.split(".").take(3).joinToString(".") + ".255")
        DatagramSocket().use { socket ->
            socket.broadcast = true
            for (target in targets) for (port in listOf(9, 7)) {
                runCatching { socket.send(DatagramPacket(packet, packet.size, InetAddress.getByName(target), port)) }
            }
        }
    }
}
