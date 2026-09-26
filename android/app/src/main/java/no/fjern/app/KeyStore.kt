package no.fjern.app

import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Paringsnøkkel, sertifikatavtrykk og MAC per LG-TV. Filen ligger i appens private lagring
 * (ingen andre apper kan lese den) og er utelatt fra sikkerhetskopi. Skrivinger er serialisert.
 */
class KeyStore(private val file: File) {
    data class Entry(val key: String? = null, val fingerprint: String? = null, val mac: String? = null)

    private val lock = Any()

    private fun read(): JSONObject = try {
        JSONObject(file.readText())
    } catch (_: Exception) {
        JSONObject()
    }

    private fun write(json: JSONObject) {
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, "${file.name}.${UUID.randomUUID()}.tmp")
        temp.writeText(json.toString(2))
        if (!temp.renameTo(file)) {
            temp.delete()
            throw java.io.IOException("Kunne ikke lagre nøkkel")
        }
    }

    fun get(host: String): Entry? = synchronized(lock) {
        val value = read().optJSONObject(host) ?: return null
        Entry(value.optString("key").ifEmpty { null }, value.optString("fingerprint").ifEmpty { null }, value.optString("mac").ifEmpty { null })
    }

    fun update(host: String, key: String? = null, fingerprint: String? = null, mac: String? = null) = synchronized(lock) {
        val all = read()
        val entry = all.optJSONObject(host) ?: JSONObject()
        key?.let { entry.put("key", it) }
        fingerprint?.let { entry.put("fingerprint", it) }
        mac?.let { entry.put("mac", it) }
        all.put(host, entry)
        write(all)
    }

    fun remove(host: String) = synchronized(lock) {
        val all = read()
        all.remove(host)
        write(all)
    }
}
