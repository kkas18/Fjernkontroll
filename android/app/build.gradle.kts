import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Versjonen hentes fra package.json, slik at web og Android alltid følger hverandre.
val webVersion = (JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>)["version"] as String
val versionParts = webVersion.split(".").map { it.toInt() }

// Signering: bruk en egen release-nøkkel når den er satt opp (miljøvariabler i CI),
// ellers den offentlige debug-nøkkelen i repoet, slik at alle bygg kan installeres over hverandre.
val releaseStore = System.getenv("FJERN_KEYSTORE")?.let { file(it) }

android {
    namespace = "no.fjern.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "no.fjern.app"
        minSdk = 26
        targetSdk = 35
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
        versionName = webVersion
    }

    signingConfigs {
        create("shared") {
            if (releaseStore != null && releaseStore.exists()) {
                storeFile = releaseStore
                storePassword = System.getenv("FJERN_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("FJERN_KEY_ALIAS")
                keyPassword = System.getenv("FJERN_KEY_PASSWORD")
            } else {
                storeFile = file("debug.keystore")
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("shared")
        }
        debug {
            signingConfig = signingConfigs.getByName("shared")
        }
    }

    // Grensesnittet er det samme som PWA-en: public/ kopieres inn som assets/www.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/www-assets"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

val copyWebAssets by tasks.registering(Sync::class) {
    from(rootProject.file("../public")) {
        exclude("sw.js", "screenshots/**")
    }
    into(layout.buildDirectory.dir("generated/www-assets/www"))
}
tasks.named("preBuild") { dependsOn(copyWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
}
