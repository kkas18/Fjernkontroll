package no.fjern.app

import android.annotation.SuppressLint
import android.net.ConnectivityManager
import android.net.Uri
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import androidx.activity.result.contract.ActivityResultContracts
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.View
import android.widget.FrameLayout
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.io.ByteArrayInputStream
import java.io.File

class MainActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var webView: WebView
    private lateinit var lg: LgSession
    private lateinit var bridge: Bridge
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // Talesøk via telefonens egen talegjenkjenning (norsk). Registreres før aktiviteten starter.
    private var voiceCallback: ((String?) -> Unit)? = null
    private val voiceLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val text = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        voiceCallback?.invoke(if (result.resultCode == RESULT_OK) text else null)
        voiceCallback = null
    }
    private val voiceIntent
        get() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "nb-NO")
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Hva vil du se på YouTube?")
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    private val voiceInput = object : NativeBridge.VoiceInput {
        override fun available() = voiceIntent.resolveActivity(packageManager) != null
        override fun listen(onResult: (String?) -> Unit) {
            voiceCallback?.invoke(null)
            voiceCallback = onResult
            try {
                voiceLauncher.launch(voiceIntent)
            } catch (e: Exception) {
                log("Talesøk: ${e.message}")
                voiceCallback = null
                onResult(null)
            }
        }
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        private const val START = "https://$HOST/index.html"
        private const val MIN_TEXT_ZOOM = 85
        private const val MAX_TEXT_ZOOM = 115

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
        Diagnostics.add(message)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val keyStore = KeyStore(File(filesDir, "lg-keys.json"))
        lg = LgSession(keyStore, scope, ::log)
        val samsung = SamsungSession(keyStore, scope, ::log)
        // Appens eget klientsertifikat for Android TV ligger i privat lagring (utelatt fra sikkerhetskopi).
        val androidtv = AndroidTvSession(keyStore, File(filesDir, "androidtv-client.json"), scope, ::log)
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as? WifiManager
        bridge = Bridge(lg, samsung, androidtv, Ssdp(wifi), scope, ::log, about = "Fjern ${BuildConfig.VERSION_NAME} · Android ${android.os.Build.VERSION.RELEASE} · ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")

        webView = WebView(this)
        webView.setBackgroundColor(getColor(R.color.bg))
        // Fjernkontrollen står fast: ingen strekk-/glødeeffekt når man drar mot kanten, og ingen rullefelt.
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        // WebView-innhold ignorerer polstring, så den ligger i en ramme som får polstringen i stedet.
        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.bg))
            addView(webView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        setContentView(root)

        // Systemlinjer: grensesnittet havner under statuslinjen og over navigasjonsfeltet og tastaturet.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val assets = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/api/icon/", IconHandler(bridge))
            .addPathHandler("/api/ytthumb/", ThumbnailHandler(bridge))
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
            // Følger systemets skriftstørrelse, men med tak, så en stor systemskrift ikke sprenger oppsettet.
            textZoom = (resources.configuration.fontScale * 100).toInt().coerceIn(MIN_TEXT_ZOOM, MAX_TEXT_ZOOM)
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
        webView.addJavascriptInterface(NativeBridge(webView, bridge, scope, voiceInput), "FjernAndroid")

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

        // Når Wi‑Fi kommer tilbake (f.eks. etter dvale), koble til TV-en igjen.
        val connectivity = getSystemService(ConnectivityManager::class.java)
        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch { bridge.onForeground() }
            }
        }.also { callback ->
            runCatching {
                connectivity.registerNetworkCallback(
                    NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(),
                    callback,
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        scope.launch { bridge.onForeground() }
    }

    override fun onStop() {
        scope.launch { bridge.onBackground() }
        super.onStop()
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

    /** Appikoner fra TV-en, levert fra appens egen opprinnelse (CSP: img-src 'self'). */
    private class IconHandler(private val bridge: Bridge) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse {
            // shouldInterceptRequest kjører på en bakgrunnstråd, så det er trygt å vente her.
            return try {
                val (type, bytes) = runBlocking { bridge.icon(Uri.decode(path)) }
                WebResourceResponse(type, null, 200, "OK", SECURITY_HEADERS + ("Cache-Control" to "private, max-age=86400"), ByteArrayInputStream(bytes))
            } catch (e: Exception) {
                // Ikke stille: grunnen havner i feilsøkingsloggen, så manglende ikoner kan forklares.
                Diagnostics.add("Ikon $path: ${e.message}")
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", SECURITY_HEADERS, ByteArrayInputStream(ByteArray(0)))
            }
        }
    }

    /** Miniatyrbilder til YouTube-modus, levert fra appens egen opprinnelse (CSP: img-src 'self'). */
    private class ThumbnailHandler(private val bridge: Bridge) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse = try {
            val (type, bytes) = runBlocking { bridge.youtubeThumbnail(Uri.decode(path)) }
            WebResourceResponse(type, null, 200, "OK", SECURITY_HEADERS + ("Cache-Control" to "private, max-age=86400"), ByteArrayInputStream(bytes))
        } catch (e: Exception) {
            Diagnostics.add("YouTube-bilde $path: ${e.message}")
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", SECURITY_HEADERS, ByteArrayInputStream(ByteArray(0)))
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        networkCallback?.let { callback -> runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(callback) } }
        scope.cancel()
        webView.destroy()
        super.onDestroy()
    }
}
