package no.fjern.app

import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Kobler grensesnittet til Kotlin-broen. JavaScript kaller request() og får svaret tilbake
 * asynkront via window.__fjernNative(id, { status, body }), så UI-tråden aldri blokkeres.
 */
class NativeBridge(
    private val webView: WebView,
    private val bridge: Bridge,
    private val scope: CoroutineScope,
    private val voice: VoiceInput? = null,
) {
    /** Talegjenkjenning levert av aktiviteten (telefonens eget talesøk). */
    interface VoiceInput {
        fun available(): Boolean
        fun listen(onResult: (String?) -> Unit)
    }

    @JavascriptInterface
    fun voiceAvailable(): Boolean = voice?.available() == true

    /** Starter talesøk; svaret kommer via window.__fjernVoice(id, tekst). */
    @JavascriptInterface
    fun voice(id: String) {
        val input = voice
        if (input == null) {
            deliverVoice(id, null)
            return
        }
        webView.post { input.listen { text -> deliverVoice(id, text) } }
    }

    private fun deliverVoice(id: String, text: String?) {
        val value = if (text == null) "null" else JSONObject.quote(text.take(100))
        webView.post { webView.evaluateJavascript("window.__fjernVoice && window.__fjernVoice(${JSONObject.quote(id)}, $value)", null) }
    }

    @JavascriptInterface
    fun request(id: String, route: String, body: String?) {
        scope.launch {
            val (status, json) = if (route in Bridge.ROUTES) bridge.handle(route, body) else 404 to JSONObject().put("error", "Ukjent adresse.")
            val result = JSONObject().put("status", status).put("body", json).toString()
            webView.post {
                webView.evaluateJavascript("window.__fjernNative && window.__fjernNative(${JSONObject.quote(id)}, $result)", null)
            }
        }
    }

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME
}
