# Metoder som kalles fra JavaScript må beholdes med navn.
-keepclassmembers class no.fjern.app.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
