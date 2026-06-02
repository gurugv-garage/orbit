package dev.orbit.dock.body

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * The brain-side state catalog — the named-state → primitive-params mapping the
 * LLM's body moves resolve through. Previously untested. Covers lookup, the
 * states/parts surface, and `validatedAgainst` (the step that reconciles the
 * shipped catalog with whatever body actually connected: drop parts the body
 * doesn't expose, clamp params to the body's declared range).
 *
 * The catalog is built in-memory here (no Android assets needed), which is also
 * how a test mocks a catalog when no real body is connected.
 */
class BodyStateCatalogTest {

    private fun cmd(vararg p: Pair<String, Double>, ms: Int = 300) =
        BodyStateCatalog.PrimitiveCommand(params = mapOf(*p), durationMs = ms)

    private fun sampleCatalog() = BodyStateCatalog(
        mapOf(
            "neck" to BodyStateCatalog.PartCatalog(
                home = "center",
                states = mapOf(
                    "lookUp" to cmd("pulse_width_us" to 2200.0, ms = 350),
                    "center" to cmd("pulse_width_us" to 1500.0),
                ),
            ),
            "foot" to BodyStateCatalog.PartCatalog(
                home = "forward",
                states = mapOf("left" to cmd("pulse_width_us" to 1000.0, ms = 200)),
            ),
        ),
    )

    // ── lookup surface ────────────────────────────────────────────────────

    @Test
    fun resolveReturnsTheCommandWithParamsAndDuration() {
        val c = sampleCatalog().resolve("neck", "lookUp")
        assertThat(c).isNotNull()
        assertThat(c!!.durationMs).isEqualTo(350)
        assertThat(c.params["pulse_width_us"]).isEqualTo(2200.0)
    }

    @Test
    fun resolveUnknownIsNull() {
        val cat = sampleCatalog()
        assertThat(cat.resolve("neck", "spin")).isNull()
        assertThat(cat.resolve("arm", "wave")).isNull()
    }

    @Test
    fun statesAndPartsSurface() {
        val cat = sampleCatalog()
        assertThat(cat.parts).containsExactly("neck", "foot")
        assertThat(cat.statesOf("neck")).containsExactly("lookUp", "center")
        assertThat(cat.statesOf("arm")).isEmpty()
        assertThat(cat.homeOf("neck")).isEqualTo("center")
        assertThat(cat.homeOf("arm")).isNull()
    }

    // ── validatedAgainst(profile) ───────────────────────────────────────────

    private fun profile(parts: Map<String, PartCapabilityModel>) =
        BodyProfile(deviceId = "dev", name = "test", fwVersion = "0", parts = parts)

    private fun part(param: String, lo: Double, hi: Double, type: String = "float") =
        PartCapabilityModel(
            description = "",
            home = emptyMap(),
            params = mapOf(param to ParamSpecModel(type, "us", lo, hi, null, "")),
        )

    @Test
    fun dropsPartsTheBodyDoesNotExpose() {
        // Body has only a neck; the catalog's foot must be dropped.
        val validated = sampleCatalog().validatedAgainst(
            profile(mapOf("neck" to part("pulse_width_us", 1000.0, 2500.0))),
        )
        assertThat(validated.parts).containsExactly("neck")
        assertThat(validated.resolve("foot", "left")).isNull()
        assertThat(validated.resolve("neck", "lookUp")).isNotNull()
    }

    @Test
    fun clampsParamsToTheBodysDeclaredRange() {
        // Body's neck maxes out at 2000; the catalog's lookUp asks for 2200 → clamp.
        val validated = sampleCatalog().validatedAgainst(
            profile(
                mapOf(
                    "neck" to part("pulse_width_us", 1000.0, 2000.0),
                    "foot" to part("pulse_width_us", 500.0, 2500.0),
                ),
            ),
        )
        assertThat(validated.resolve("neck", "lookUp")!!.params["pulse_width_us"]).isEqualTo(2000.0)
        // In-range value is untouched.
        assertThat(validated.resolve("foot", "left")!!.params["pulse_width_us"]).isEqualTo(1000.0)
    }

    @Test
    fun dropsParamsTheBodyDoesNotKnow() {
        // Body's neck declares a DIFFERENT param name → the catalog's
        // pulse_width_us is unknown to it and gets dropped.
        val validated = sampleCatalog().validatedAgainst(
            profile(mapOf("neck" to part("angle_deg", 0.0, 180.0))),
        )
        val cmd = validated.resolve("neck", "lookUp")
        assertThat(cmd).isNotNull()
        assertThat(cmd!!.params).doesNotContainKey("pulse_width_us")
        assertThat(cmd.params).isEmpty()
        // Duration is preserved even when params are stripped.
        assertThat(cmd.durationMs).isEqualTo(350)
    }

    @Test
    fun emptyCatalogResolvesToNothing() {
        // The fallback an offline/mock body uses (no connection, no assets).
        val empty = BodyStateCatalog(emptyMap())
        assertThat(empty.parts).isEmpty()
        assertThat(empty.resolve("neck", "lookUp")).isNull()
        assertThat(empty.statesOf("neck")).isEmpty()
    }
}
