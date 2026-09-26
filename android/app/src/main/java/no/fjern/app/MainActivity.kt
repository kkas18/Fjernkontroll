package no.fjern.app

import android.annotation.SuppressLint
import android.net.wifi.WifiManager
import android.os.Bundle
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import java.io.File

class MainActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var webView: WebView
    private lateinit var lg: LgSession

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        private const val START = "https://$HOST/index.html"

        // Samme sikkerhetshoder som Node-broen setter.
        private val SECURITY_HEADERS = mapOf(
            "Content-Security-Policy" to listOf(
                "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
                "connect-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'",
                "frame-ancestors 'none'", "form-action 'self'",
            ).joinToString("; "),
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "no-referrer",
        )
    }

    private fun log(message: String) {
        Log.i("Fjern", message)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val keyStore = KeyStore(File(filesDir, "lg-keys.json"))
        lg = LgSession(keyStore, scope, ::log)
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as? WifiManager
        val bridge = Bridge(lg, Ssdp(wifi), scope, ::log)

        webView = WebView(this)
        webView.setBackgroundColor(getColor(R.color.bg))
        setContentView(webView)

        // Systemlinjer: grensesnittet får polstring i stedet for å havne under status- og navigasjonsfeltet.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val assets = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/", SecureAssetHandler(WebViewAssetLoader.AssetsPathHandler(this)))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                // Bare appens egne filer lastes; alt annet blokkeres.
                if (url.host != HOST) return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), null)
                return assets.shouldInterceptRequest(url)
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = request.url.host != HOST
        }
        webView.addJavascriptInterface(NativeBridge(webView, bridge, scope), "FjernAndroid")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Tilbake lukker først et åpent ark i grensesnittet, deretter appen.
                webView.evaluateJavascript("window.__fjernBack ? window.__fjernBack() : false") { handled ->
                    if (handled != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })

        if (savedInstanceState == null) webView.loadUrl(START) else webView.restoreState(savedInstanceState)
    }

    /** Legger sikkerhetshoder på alle filer fra assets. */
    private class SecureAssetHandler(private val inner: WebViewAssetLoader.PathHandler) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            // Grensesnittet ligger i assets/www (kopiert fra public/ ved bygging).
            val response = inner.handle("www/" + path.ifEmpty { "index.html" }) ?: return null
            response.responseHeaders = (response.responseHeaders ?: emptyMap()) + SECURITY_HEADERS
            return response
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        scope.cancel()
        webView.destroy()
        super.onDestroy()
    }
}
