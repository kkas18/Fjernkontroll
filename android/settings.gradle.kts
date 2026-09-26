pluginManagement {
    repositories {
        google()
        // Googles speil av Maven Central: færre avvisninger (HTTP 429) enn hovedserveren.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // Googles speil av Maven Central: færre avvisninger (HTTP 429) enn hovedserveren.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
    }
}
rootProject.name = "Fjern"
include(":app")
