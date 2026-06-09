import java.util.Properties
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URI
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

android {
    namespace = "dev.orbit.dock"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.orbit.dock"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.1"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Read keys from local.properties (gitignored).
        val localProps = Properties().apply {
            val f = rootProject.file("local.properties")
            if (f.exists()) FileInputStream(f).use { load(it) }
        }
        buildConfigField(
            "String",
            "PORCUPINE_ACCESS_KEY",
            "\"${localProps.getProperty("PORCUPINE_ACCESS_KEY", "")}\"",
        )
        buildConfigField(
            "String",
            "OPENROUTER_API_KEY",
            "\"${localProps.getProperty("OPENROUTER_API_KEY", "")}\"",
        )
        // Google AI Studio key — for talking to Gemini DIRECTLY via Google's
        // OpenAI-compatible endpoint (generativelanguage.../v1beta/openai),
        // bypassing OpenRouter. Get one at aistudio.google.com. Empty = unset.
        buildConfigField(
            "String",
            "GEMINI_API_KEY",
            "\"${localProps.getProperty("GEMINI_API_KEY", "")}\"",
        )
        // Optional local Ollama endpoint (e.g. http://192.168.1.15:11434).
        // When set, DockAgent tries this first before falling back to
        // OpenRouter free models. Empty string disables.
        buildConfigField(
            "String",
            "OLLAMA_BASE_URL",
            "\"${localProps.getProperty("OLLAMA_BASE_URL", "")}\"",
        )
        buildConfigField(
            "String",
            "OLLAMA_MODEL",
            "\"${localProps.getProperty("OLLAMA_MODEL", "")}\"",
        )
        // LLM API style: "ollama" (native /api/chat NDJSON) or "openai"
        // (/v1/chat/completions SSE — llama.cpp, OpenRouter). Default ollama.
        buildConfigField(
            "String",
            "LLM_API",
            "\"${localProps.getProperty("LLM_API", "ollama")}\"",
        )
        // Attach the camera frame to turns? Off for text-only models (e.g.
        // Qwen3.6 has no vision). Default true (gemma can see).
        buildConfigField(
            "boolean",
            "LLM_VISION",
            localProps.getProperty("LLM_VISION", "true"),
        )
        // BodyLink sim/firmware host. Empty → BodyLink is disabled.
        // Example: ws://192.168.1.42:17317   or   ws://10.0.2.2:17317 (AVD → host).
        buildConfigField(
            "String",
            "BODY_HOST",
            "\"${localProps.getProperty("BODY_HOST", "")}\"",
        )
        // orbit-station (optional). Empty → no station; the dock runs standalone.
        // Example: ws://10.0.2.2:8099/ws (AVD → host) or ws://<laptop-lan>:8099/ws.
        buildConfigField(
            "String",
            "STATION_URL",
            "\"${localProps.getProperty("STATION_URL", "")}\"",
        )
        buildConfigField(
            "String",
            "DOCK_NAME",
            "\"${localProps.getProperty("DOCK_NAME", "anne-bot")}\"",
        )
    }

    // Release signing for OTA (docs/OTA.md §5.1). A stable key is required: the
    // OTA APK must be signed with the SAME key as the installed app or Android
    // refuses the update, and silent device-owner install needs a real identity
    // (not the throwaway debug key). The keystore lives OUTSIDE the repo; its
    // path + passwords come from local.properties (gitignored) — generate it
    // with orbit-station/scripts/gen-keystore.sh. If unconfigured, release falls
    // back to debug signing so a fresh checkout still builds (just not OTA-able).
    val signProps = Properties().apply {
        val f = rootProject.file("local.properties")
        if (f.exists()) FileInputStream(f).use { load(it) }
    }
    val releaseStoreFile = signProps.getProperty("RELEASE_STORE_FILE", "")
    val hasReleaseSigning = releaseStoreFile.isNotBlank() && rootProject.file(releaseStoreFile).exists()

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile)
                storePassword = signProps.getProperty("RELEASE_STORE_PASSWORD", "")
                keyAlias = signProps.getProperty("RELEASE_KEY_ALIAS", "")
                keyPassword = signProps.getProperty("RELEASE_KEY_PASSWORD", "")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                // No keystore configured → debug-signed so the build still works.
                // Not installable as an OTA update; run gen-keystore.sh first.
                logger.warn("node-dock: release signing not configured (RELEASE_STORE_FILE in local.properties) — using debug key. OTA updates require a real keystore; see docs/OTA.md §5.1.")
                signingConfigs.getByName("debug")
            }
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/INDEX.LIST",
                "/META-INF/io.netty.versions.properties",
                "/META-INF/DEPENDENCIES",
                "/META-INF/NOTICE",
                "/META-INF/NOTICE.txt",
                "/META-INF/NOTICE.md",
                "/META-INF/LICENSE",
                "/META-INF/LICENSE.txt",
                "/META-INF/LICENSE.md",
                "/META-INF/license.txt",
                "/META-INF/maven/**",
                "/META-INF/proguard/**",
                "/META-INF/native-image/**",
                "/META-INF/versions/**",
                "/META-INF/*.MF",
                "/META-INF/OSGI-INF/**",
            )
        }
    }

    sourceSets {
        getByName("debug") {
            kotlin.srcDir("src/debug/kotlin")
        }
        getByName("main") {
            kotlin.srcDir("src/main/kotlin")
        }
        getByName("test") {
            kotlin.srcDir("src/test/kotlin")
        }
        getByName("androidTest") {
            kotlin.srcDir("src/androidTest/kotlin")
        }
    }
}

// ── config bake ──────────────────────────────────────────────────────────────
// At build time, pull the station's current config and pack it into the app as
// assets/config-defaults.json, so the dock boots with up-to-date defaults even
// with NO station reachable later. If the station is down (or no URL is set),
// the COMMITTED config-defaults.json is kept — the build never fails on this.
//
// Set STATION_BAKE_URL in local.properties (e.g. http://192.168.1.10:8099) to
// enable the live fetch; otherwise the committed file is used as-is.
val bakeConfig by tasks.registering {
    description = "Fetch station config → assets/config-defaults.json (keeps committed file on failure)"
    val localProps = Properties().apply {
        val f = rootProject.file("local.properties")
        if (f.exists()) FileInputStream(f).use { load(it) }
    }
    val bakeUrl = localProps.getProperty("STATION_BAKE_URL", "").trimEnd('/')
    val out = file("src/main/assets/config-defaults.json")
    // Re-run whenever the URL changes; cheap network task otherwise.
    inputs.property("bakeUrl", bakeUrl)
    outputs.file(out)
    doLast {
        if (bakeUrl.isBlank()) {
            logger.lifecycle("bakeConfig: no STATION_BAKE_URL — using committed ${out.name}")
            return@doLast
        }
        try {
            val conn = URI("$bakeUrl/api/config/export").toURL().openConnection() as HttpURLConnection
            conn.connectTimeout = 2000; conn.readTimeout = 3000
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            // sanity: must be a JSON object (don't clobber the committed file with junk).
            groovy.json.JsonSlurper().parseText(text)
            out.writeText(text)
            logger.lifecycle("bakeConfig: baked fresh config from $bakeUrl (${text.length} bytes)")
        } catch (t: Throwable) {
            logger.warn("bakeConfig: fetch from $bakeUrl failed (${t.message}) — keeping committed ${out.name}")
        }
    }
}
// Run before assets are merged into the APK.
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(bakeConfig) }

dependencies {
    implementation(project(":agent-core"))  // pure-JVM agentic runtime (vendored pi-kt)
    // dock LLM transport (DockStreamFn/DockPrompt/DockToolSchemas/SafeCompute)
    // lives in src/main/kotlin/dev/orbit/dock/llm; :bench compiles that same
    // source dir directly (it can't depend on this Android module).
    implementation(libs.core.ktx)
    implementation(libs.lifecycle.runtime.ktx)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.service)
    implementation(libs.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.timber)

    // Perception
    implementation(libs.onnxruntime.android)
    implementation(libs.porcupine.android)

    // Agent
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.websockets)

    // Camera + face detection
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.mlkit.face.detection)

    // WebRTC: PeerConnectionFactory, ADM (APM-processed mic: AEC/NS/AGC/VAD),
    // VideoCapturer (camera frames into a stream we can render + later send).
    // Foundation for: clean audio + video processing now, peer streaming later.
    implementation(libs.webrtc.android)

    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    // Unit tests
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.truth)

    // Instrumented (on-device / emulator) tests
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.turbine)
    androidTestImplementation(libs.truth)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
}
