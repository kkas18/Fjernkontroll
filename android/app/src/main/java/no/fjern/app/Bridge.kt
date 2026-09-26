package no.fjern.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Samme API som Node-broen (server.mjs), men kalt direkte fra WebView-en i appen.
 * Svarer med (HTTP-lignende status, JSON), slik at grensesnittet er identisk på web og Android.
 */
class Bridge(
    private val lg: LgSession,
    private val ssdp: Ssdp,
    private val scope: CoroutineScope,
    private val log: (String) -> Unit = {},
    private val rokuHealthTtlMs: Long = 10_000,
) {
    private val lock = Mutex()
    private var selected: Device? = null
    private var rokuHealth = Triple<String?, Boolean, Long>(null, false, 0L)
    private var rokuApps: List<App> = emptyList()
    private var scan: Deferred<List<Device>>? = null

    private fun Device.toJson() = JSONObject().put("type", type).put("host", host).put("name", name)
    private fun List<App>.toJson() = JSONArray().also { array -> forEach { array.put(JSONObject().put("id", it.id).put("name", it.name)) } }

    private suspend fun rokuReachable(device: Device): Boolean {
        val (host, ok, at) = rokuHealth
        if (host == device.host && System.currentTimeMillis() - at < rokuHealthTtlMs) return ok
        val reachable = runCatching { withContext(Dispatchers.IO) { Roku.probe(device.host, 1500) } }.isSuccess
        rokuHealth = Triple(device.host, reachable, System.currentTimeMillis())
        return reachable
    }

    private fun markRoku(ok: Boolean) {
        selected?.let { rokuHealth = Triple(it.host, ok, System.currentTimeMillis()) }
    }

    private suspend fun <T> withRoku(action: () -> T): T = try {
        withContext(Dispatchers.IO) { action() }.also { markRoku(true) }
    } catch (e: Throwable) {
        if (e !is UserError) markRoku(false)
        throw e
    }

    private fun capabilities(device: Device) = if (device.type == "roku") {
        JSONObject().put("playPause", "toggle").put("channels", device.isTv != false).put("powerOn", device.isTv == true).put("apps", true)
    } else {
        JSONObject().put("playPause", "separate").put("channels", true).put("powerOn", lg.canWake).put("apps", true)
    }

    private suspend fun status(): JSONObject {
        val device = selected ?: return JSONObject().put("device", JSONObject.NULL).put("ready", false).put("state", "Ingen TV valgt.")
        val result = JSONObject().put("device", device.toJson()).put("capabilities", capabilities(device))
        return if (device.type == "roku") {
            val ok = rokuReachable(device)
            result.put("ready", ok)
                .put("state", if (ok) "Tilkoblet" else "Roku svarer ikke. Sjekk at TV-en er på og på samme Wi‑Fi.")
                .put("code", if (ok) JSONObject.NULL else "unreachable")
        } else {
            result.put("ready", lg.ready).put("state", lg.status).put("code", lg.code ?: JSONObject.NULL)
        }
    }

    private suspend fun discover(): List<Device> {
        val running = scan?.takeIf { it.isActive } ?: scope.async(Dispatchers.IO) {
            ssdp.search().map { d -> if (d.type == "roku") runCatching { Roku.probe(d.host) }.getOrDefault(d) else d }
        }.also { scan = it }
        return running.await()
    }

    /** Hovedinngang: rute og eventuell JSON-kropp inn, status og JSON ut. */
    suspend fun handle(route: String, body: String?): Pair<Int, JSONObject> = try {
        200 to dispatch(route, body?.let { JSONObject(it) })
    } catch (e: Throwable) {
        val message = toUserMessage(e)
        if (message.internal) log("Feil i $route: ${e.stackTraceToString()}")
        message.status to JSONObject().put("error", message.message)
    }

    private suspend fun dispatch(route: String, input: JSONObject?): JSONObject {
        if (route == "scan") {
            return JSONObject().put("devices", JSONArray().also { array -> discover().forEach { array.put(it.toJson()) } })
        }
        return lock.withLock { dispatchLocked(route, input) }
    }

    private suspend fun dispatchLocked(route: String, input: JSONObject?): JSONObject {
        if (route == "status") return status()
        if (route == "apps") {
            val device = selected ?: throw UserError("Velg en TV først.", 409)
            val apps = if (device.type == "lg") lg.apps() else withRoku { Roku.apps(device.host) }.also { rokuApps = it }
            return JSONObject().put("apps", apps.toJson())
        }
        val body = input ?: throw UserError("Metoden støttes ikke.", 405)
        return when (route) {
            "connect" -> {
                val raw = body.optJSONObject("device") ?: JSONObject()
                val device = Validate.device(raw.optString("type"), raw.optString("host"), raw.optString("name"))
                if (device.type == "roku") {
                    val probed = withContext(Dispatchers.IO) { Roku.probe(device.host) }
                    lg.disconnect()
                    selected = probed
                    rokuApps = emptyList()
                    markRoku(true)
                } else {
                    selected = device
                    lg.connect(device.host)
                }
                status()
            }
            "repair" -> {
                val device = selected?.takeIf { it.type == "lg" } ?: throw UserError("Bare LG-TV-er kan pares på nytt.", 409)
                withContext(Dispatchers.IO) { lg.forget(device.host) }
                lg.connect(device.host)
                status()
            }
            "launch" -> {
                val device = selected ?: throw UserError("Velg en TV først.", 409)
                val id = Validate.appId(body.optString("id"))
                if (device.type == "lg") lg.launch(id)
                else {
                    if (rokuApps.none { it.id == id }) throw UserError("Ukjent app.", 404)
                    withRoku { Roku.launch(device.host, id) }
                }
                JSONObject().put("ok", true)
            }
            "command" -> {
                val device = selected ?: throw UserError("Velg en TV først.", 409)
                val key = Validate.command(body.optString("key"))
                if (device.type == "lg") {
                    if (key == "PowerOn") lg.powerOn(device.host) else lg.command(key)
                } else {
                    withRoku { Roku.command(device.host, key) }
                }
                JSONObject().put("ok", true)
            }
            "text" -> {
                val device = selected ?: throw UserError("Velg en TV først.", 409)
                val text = Validate.text(body.optString("text"))
                if (device.type == "lg") lg.text(text) else withRoku { Roku.text(device.host, text) }
                JSONObject().put("ok", true)
            }
            else -> throw UserError("Ukjent adresse.", 404)
        }
    }
}
