package no.fjern.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * YouTube-modus: søk på mobilen, spill av på TV-en.
 * Søket leser YouTubes offentlige søkeside (samme data som nettsiden viser), uten API-nøkkel.
 */
object YouTube {
    const val MAX_RESULTS = 20
    private const val MAX_PAGE_BYTES = 4 * 1024 * 1024
    private val VIDEO_ID = Regex("^[\\w-]{11}$")

    data class Video(val id: String, val title: String, val channel: String, val duration: String, val views: String)

    fun isVideoId(id: String?) = id != null && VIDEO_ID.matches(id)

    fun videoId(id: String?): String {
        if (id == null || !isVideoId(id)) throw UserError("Ukjent video.")
        return id
    }

    fun thumbnailUrl(id: String) = "https://i.ytimg.com/vi/${videoId(id)}/mqdefault.jpg"
    fun tvVideoTarget(id: String) = "https://www.youtube.com/tv?v=${videoId(id)}"

    private fun text(node: JSONObject?): String {
        node ?: return ""
        if (node.has("simpleText")) return node.optString("simpleText")
        val runs = node.optJSONArray("runs") ?: return ""
        return (0 until runs.length()).joinToString("") { runs.optJSONObject(it)?.optString("text").orEmpty() }
    }

    /** Finner alle videoRenderer-objekter, uansett hvor YouTube har plassert dem i strukturen. */
    private fun collect(node: Any?, out: MutableList<JSONObject>) {
        if (out.size >= MAX_RESULTS) return
        when (node) {
            is JSONObject -> {
                node.optJSONObject("videoRenderer")?.let { out += it; return }
                for (key in node.keys()) collect(node.opt(key), out)
            }
            is JSONArray -> for (i in 0 until node.length()) collect(node.opt(i), out)
        }
    }

    fun parseSearchPage(html: String): List<Video> {
        val marker = "var ytInitialData = "
        val start = html.indexOf(marker)
        val end = if (start >= 0) html.indexOf(";</script>", start) else -1
        if (start < 0 || end < 0) throw UserError("Fant ikke resultater fra YouTube akkurat nå.", 502)
        val data = try {
            JSONObject(html.substring(start + marker.length, end))
        } catch (e: Exception) {
            throw UserError("Fant ikke resultater fra YouTube akkurat nå.", 502)
        }
        val renderers = mutableListOf<JSONObject>()
        collect(data, renderers)
        return renderers.filter { isVideoId(it.optString("videoId")) }.map { video ->
            val length = text(video.optJSONObject("lengthText"))
            val live = length.isEmpty() && video.optJSONArray("badges")?.toString()?.contains("LIVE") == true
            Video(
                id = video.getString("videoId"),
                title = text(video.optJSONObject("title")).take(200),
                channel = text(video.optJSONObject("ownerText") ?: video.optJSONObject("longBylineText")).take(100),
                duration = if (live) "Direkte" else length.take(12),
                views = text(video.optJSONObject("shortViewCountText") ?: video.optJSONObject("viewCountText")).take(40),
            )
        }
    }

    fun search(query: String): List<Video> {
        val url = URL("https://www.youtube.com/results?search_query=${URLEncoder.encode(query, "UTF-8")}&hl=nb&gl=NO")
        val connection = url.openConnection() as HttpURLConnection
        connection.connectTimeout = 8000
        connection.readTimeout = 8000
        connection.setRequestProperty("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
        connection.setRequestProperty("Accept-Language", "nb-NO,nb;q=0.9,en;q=0.5")
        // Hopper over samtykkesiden YouTube viser i EØS.
        connection.setRequestProperty("Cookie", "SOCS=CAI; CONSENT=YES+")
        try {
            if (connection.responseCode !in 200..299) throw UserError("YouTube svarte ikke på søket.", 502)
            return parseSearchPage(Roku.readLimited(connection, MAX_PAGE_BYTES))
        } finally {
            connection.disconnect()
        }
    }

    fun thumbnail(id: String): ByteArray {
        val connection = URL(thumbnailUrl(id)).openConnection() as HttpURLConnection
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        try {
            if (connection.responseCode !in 200..299) throw UserError("Fant ikke bildet.", 404)
            return connection.inputStream.use { Icons.readLimited(it) }
        } finally {
            connection.disconnect()
        }
    }
}
