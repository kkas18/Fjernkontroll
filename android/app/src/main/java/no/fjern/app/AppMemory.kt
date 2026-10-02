package no.fjern.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Minne per Android TV-boks for apper: lenken som åpnet hver app, og apper boksen har meldt at er åpne (lærte
 * apper). Samme innhold som data/androidtv-apps.json i Node-broen. Uten fil holdes alt i minnet (tester).
 */
class AppMemory(private val file: File? = null) {
    data class Learned(val pkg: String, val name: String)
    data class Entry(val links: Map<String, String> = emptyMap(), val learned: List<Learned> = emptyList())

    private val lock = Any()
    private var cache: JSONObject? = null

    private fun read(): JSONObject {
        cache?.let { return it }
        val json = try {
            if (file != null) JSONObject(file.readText()) else JSONObject()
        } catch (_: Exception) {
            JSONObject()
        }
        cache = json
        return json
    }

    private fun write(json: JSONObject) {
        cache = json
        val target = file ?: return
        target.parentFile?.mkdirs()
        val temp = File(target.parentFile, "${target.name}.${UUID.randomUUID()}.tmp")
        temp.writeText(json.toString(2))
        if (!temp.renameTo(target)) {
            temp.delete()
            throw java.io.IOException("Kunne ikke lagre appene")
        }
    }

    fun get(host: String): Entry = synchronized(lock) {
        val value = read().optJSONObject(host) ?: return Entry()
        val links = value.optJSONObject("links")?.let { obj -> obj.keys().asSequence().associateWith { obj.optString(it) }.filterValues { it.isNotEmpty() } }.orEmpty()
        val learned = value.optJSONArray("learned")?.let { array ->
            (0 until array.length()).mapNotNull { i ->
                val item = array.optJSONObject(i) ?: return@mapNotNull null
                val pkg = item.optString("package")
                if (pkg.isEmpty()) null else Learned(pkg, item.optString("name").ifEmpty { pkg })
            }
        }.orEmpty()
        return Entry(links, learned)
    }

    private fun update(host: String, change: (JSONObject) -> Unit) = synchronized(lock) {
        val all = read()
        val entry = all.optJSONObject(host) ?: JSONObject()
        change(entry)
        all.put(host, entry)
        write(all)
    }

    fun setLink(host: String, id: String, link: String?) = update(host) { entry ->
        val links = entry.optJSONObject("links") ?: JSONObject()
        if (link == null) links.remove(id) else links.put(id, link)
        entry.put("links", links)
    }

    /** Legger til en lært app. Gir false hvis den allerede finnes. */
    fun learn(host: String, pkg: String, name: String, max: Int): Boolean = synchronized(lock) {
        if (get(host).learned.any { it.pkg == pkg }) return false
        update(host) { entry ->
            val list = entry.optJSONArray("learned") ?: JSONArray()
            list.put(JSONObject().put("package", pkg).put("name", name))
            while (list.length() > max) list.remove(0)
            entry.put("learned", list)
        }
        true
    }
}
