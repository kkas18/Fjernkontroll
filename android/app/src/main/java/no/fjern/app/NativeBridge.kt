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
) {
    private val routes = setOf("status", "scan", "connect", "repair", "apps", "launch", "command", "text", "diagnostics", "inputs", "input", "search")

    @JavascriptInterface
    fun request(id: String, route: String, body: String?) {
        scope.launch {
            val (status, json) = if (route in routes) bridge.handle(route, body) else 404 to JSONObject().put("error", "Ukjent adresse.")
            val result = JSONObject().put("status", status).put("body", json).toString()
            webView.post {
                webView.evaluateJavascript("window.__fjernNative && window.__fjernNative(${JSONObject.quote(id)}, $result)", null)
            }
        }
    }

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME
}
