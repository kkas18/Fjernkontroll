package no.fjern.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Gjenkjenner hvilken TV som står på en IP-adresse, så brukeren bare trenger å skrive inn adressen.
 * Samme regler som lib/probe.mjs: alle kjennetegn sjekkes samtidig, og det mest entydige vinner:
 * Roku (HTTP 8060) → Samsung (HTTP 8001) → Android TV (TCP 6466) → LG webOS (TCP 3001/3000).
 */
object Probe {
    val ANDROIDTV_PORTS = listOf(6466)
    val LG_PORTS = listOf(3001, 3000)
    const val NOT_FOUND = "Fant ingen TV som Fjern støtter på denne adressen. Sjekk at TV-en er på og på samme Wi‑Fi, og at adressen stemmer."

    /** Åpner og lukker en TCP-forbindelse. Blokkerende: kalles på Dispatchers.IO. */
    fun tcpOpen(host: String, port: Int, timeoutMs: Int = 1500): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(host, port), timeoutMs) }
        true
    } catch (_: Exception) {
        false
    }

    /** Selve avgjørelsen, skilt ut så den kan testes uten nettverk. */
    fun decide(host: String, roku: Device?, samsung: Device?, androidtv: Boolean, lg: Boolean): Device = when {
        roku != null -> roku
        samsung != null -> samsung
        androidtv -> Device("androidtv", host, "Android TV")
        lg -> Device("lg", host, "LG-TV")
        else -> throw UserError(NOT_FOUND, 404)
    }

    suspend fun identify(
        host: String,
        probeRoku: (String) -> Device = { Roku.probe(it) },
        probeSamsung: (String) -> Device = { SamsungSession.probe(it) },
        portOpen: (String, Int) -> Boolean = { h, p -> tcpOpen(h, p) },
    ): Device {
        if (!Validate.isPrivateIPv4(host)) throw UserError("Skriv en lokal IP-adresse, for eksempel 192.168.1.42.")
        return coroutineScope {
            val roku = async(Dispatchers.IO) { runCatching { probeRoku(host) }.getOrNull() }
            val samsung = async(Dispatchers.IO) { runCatching { probeSamsung(host) }.getOrNull() }
            val androidtv = ANDROIDTV_PORTS.map { port -> async(Dispatchers.IO) { portOpen(host, port) } }
            val lg = LG_PORTS.map { port -> async(Dispatchers.IO) { portOpen(host, port) } }
            decide(host, roku.await(), samsung.await(), androidtv.any { it.await() }, lg.any { it.await() })
        }
    }
}
