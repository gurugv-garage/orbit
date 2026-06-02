package dev.orbit.dock.llm

import com.google.common.truth.Truth.assertThat
import kotlin.random.Random
import kotlin.test.Test

/**
 * The compute tool's evaluator — the dock's bounded "run code" stand-in. Must do
 * the arithmetic/random/branch a model needs ("pick a number, if >5 say hi") and
 * REJECT anything resembling general code (names, calls, statements).
 */
class SafeComputeTest {
    private val c = SafeCompute(Random(42))   // seeded → deterministic random

    @Test fun arithmeticWithPrecedence() {
        assertThat(c.eval("3 + 4 * 2")).isEqualTo("11")
        assertThat(c.eval("(3 + 4) * 2")).isEqualTo("14")
        assertThat(c.eval("10 / 4")).isEqualTo("2.5")
        assertThat(c.eval("10 % 3")).isEqualTo("1")
        assertThat(c.eval("-5 + 2")).isEqualTo("-3")
    }

    @Test fun comparisonsReturnBool() {
        assertThat(c.eval("7 > 5")).isEqualTo("true")
        assertThat(c.eval("3 >= 5")).isEqualTo("false")
        assertThat(c.eval("4 == 4")).isEqualTo("true")
        assertThat(c.eval("4 != 4")).isEqualTo("false")
    }

    @Test fun randomIsInRangeInclusive() {
        repeat(50) {
            val v = SafeCompute(Random(it.toLong())).eval("random(1,10)").toInt()
            assertThat(v).isAtLeast(1)
            assertThat(v).isAtMost(10)
        }
    }

    @Test fun randomBranchComparison() {
        // "random(1,10) > 5" → a boolean the model branches on.
        val r = c.eval("random(1,10) > 5")
        assertThat(r).isAnyOf("true", "false")
    }

    @Test fun rejectsGeneralCode() {
        assertThat(c.eval("import random")).startsWith("error")
        assertThat(c.eval("print('hi')")).startsWith("error")
        assertThat(c.eval("x = 5")).startsWith("error")
        assertThat(c.eval("os.system('rm')")).startsWith("error")
        assertThat(c.eval("")).startsWith("error")
    }

    @Test fun rejectsMalformed() {
        assertThat(c.eval("3 +")).startsWith("error")
        assertThat(c.eval("random(5,1)")).startsWith("error")   // a>b
        assertThat(c.eval("(3 + 4")).startsWith("error")        // unbalanced
    }
}
