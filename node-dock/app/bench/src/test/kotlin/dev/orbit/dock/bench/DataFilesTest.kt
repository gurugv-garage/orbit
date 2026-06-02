package dev.orbit.dock.bench

import kotlinx.serialization.json.Json
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/** The committed bench/ data files must parse + reference real images, so a
 *  malformed case is caught here, not 20 minutes into a live run. */
class DataFilesTest {
    private val json = Json { ignoreUnknownKeys = true }
    // Gradle runs tests with cwd = the module dir (bench/), so "." is the root;
    // the others cover running from the app/ or repo root.
    private val root = sequenceOf(File("."), File("bench"), File("app/bench"))
        .firstOrNull { File(it, "models.json").exists() } ?: File(".")

    @Test fun modelsJsonParses() {
        val f = File(root, "models.json")
        assertTrue(f.exists(), "models.json missing at ${f.absolutePath}")
        val models = json.decodeFromString<List<ModelConfig>>(f.readText())
        assertTrue(models.isNotEmpty())
        assertTrue(models.all { it.api == "ollama" || it.api == "openai" }, "api must be ollama|openai")
    }

    @Test fun everyCaseFileParsesAndImagesExist() {
        val dir = File(root, "cases")
        assertTrue(dir.isDirectory, "cases/ missing at ${dir.absolutePath}")
        val files = dir.listFiles { f -> f.extension == "json" }!!
        assertTrue(files.isNotEmpty())
        val imagesDir = File(root, "images")
        for (f in files) {
            val cf = json.decodeFromString<CaseFile>(f.readText())
            assertTrue(cf.cases.isNotEmpty(), "${f.name} has no cases")
            for (c in cf.cases) {
                c.image?.let {
                    assertTrue(File(imagesDir, it).exists(), "${cf.capability}/${c.id} references missing image $it")
                }
            }
        }
    }
}
