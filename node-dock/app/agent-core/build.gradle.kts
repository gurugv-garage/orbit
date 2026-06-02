// :agent-core — pure-JVM agentic runtime (vendored from the standalone pi-kt).
//
// Deliberately NO Android, NO Ktor: the agent loop + tools + sessions are
// transport-free pure Kotlin, so `./gradlew :agent-core:test` runs the whole
// thing on the laptop in milliseconds (the property that made it trustworthy).
// Device concerns (Ollama transport, camera, TTS, servos) live in the app,
// which depends on this module — never the reverse. Reusable by any JVM/Android
// project.
plugins {
    // Apply WITHOUT versions: the Kotlin plugin is already on the build
    // classpath via the app module (kotlin-android), so re-requesting it with a
    // version fails ("already on the classpath"). Bare ids inherit that version.
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.serialization")
    `java-library`
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.kotlin.test.junit5)
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
    testImplementation(libs.kotlinx.coroutines.test)
}

tasks.test {
    useJUnitPlatform()
}
