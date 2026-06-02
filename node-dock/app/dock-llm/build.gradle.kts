// :dock-llm — the dock's LLM TRANSPORT, shared by :app and :bench so there's one
// copy (no drift). Pure-JVM (kotlin-jvm, no Android): builds the dock's Ollama
// /api/chat (NDJSON) and OpenAI /v1 (SSE) requests + streams them into
// agent-core AssistantMessageEvents. Logging goes through a (String)->Unit hook
// so the caller picks Timber (app) or println/no-op (bench) without an Android
// dep here.
plugins {
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
    api(project(":agent-core"))
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)

    testImplementation(libs.kotlin.test.junit5)
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.truth)
}

tasks.test {
    useJUnitPlatform()
}
