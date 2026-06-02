// :bench — the dock-LLM benchmark harness. Pure-JVM, runnable:
//   ./gradlew :bench:run --args="--models local --n 10"
// Drives each model through the dock's REAL request path (the dock LLM transport
// + the real tool schemas) over N runs per case, scores objective predicates +
// latency, and writes bench/results/<ts>.json for the HTML viewer. No Android,
// no emulator — it's the "test suite for models", not for our code.
//
// The transport (DockStreamFn/DockPrompt/DockToolSchemas/SafeCompute) lives in
// :app's source tree (src/main/kotlin/dev/orbit/dock/llm) — its natural home.
// :bench can't depend on the Android :app module, so it COMPILES THAT SAME
// SOURCE DIR directly (see sourceSets below). One copy, no drift, on a pure JVM.
plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.serialization")
    application
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

application {
    mainClass.set("dev.orbit.dock.bench.MainKt")
}

// Run from the module dir so the default --root resolves bench/ data files
// (models.json, cases/, images/, results/) relative to here.
tasks.named<JavaExec>("run") {
    workingDir = projectDir
}

// Compile the dock LLM transport straight from :app's source tree. This is the
// same code the running app uses — sharing the dir (not a copy) guarantees no
// drift, while keeping the files in their natural home under :app.
sourceSets {
    named("main") {
        java.srcDir("${rootDir}/app/src/main/kotlin/dev/orbit/dock/llm")
    }
}

dependencies {
    implementation(project(":agent-core"))   // pure-JVM agentic runtime (used by the transport)
    implementation(libs.ktor.client.core)     // transport's HTTP client
    implementation(libs.ktor.client.okhttp)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.kotlin.test.junit5)
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.truth)           // used by the moved llm transport tests
}

tasks.test {
    useJUnitPlatform()
}
