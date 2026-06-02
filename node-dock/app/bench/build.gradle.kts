// :bench — the dock-LLM benchmark harness. Pure-JVM, runnable:
//   ./gradlew :bench:run --args="--models local --n 10"
// Drives each model through the dock's REAL request path (:dock-llm transport +
// the real tool schemas) over N runs per case, scores objective predicates +
// latency, and writes bench/results/<ts>.json for the HTML viewer. No Android,
// no emulator — it's the "test suite for models", not for our code.
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

dependencies {
    implementation(project(":dock-llm"))     // transport + tool schemas (brings :agent-core + ktor)
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
