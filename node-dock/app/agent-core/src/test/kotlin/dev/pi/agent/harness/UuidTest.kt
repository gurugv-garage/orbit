package dev.pi.agent.harness

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Port of pi-agent-core test/harness/session-uuid.test.ts. */
class UuidTest {

    private val uuidV7Re = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    private val timestamp = 0x0123456789abL

    private fun parseTimestamp(uuid: String): Long =
        uuid.replace("-", "").substring(0, 12).toLong(16)

    @Test
    fun `uses the RFC 9562 layout and preserves monotonic order`() {
        // Same scripted random bytes as the TS test: first call seeds a high
        // sequence near rollover, next two within the same millisecond.
        val randomValues = ArrayDeque(
            listOf(
                byteArrayOf(0, 0, 0, 0, 0, 0, 0xff.toByte(), 0xff.toByte(), 0xff.toByte(), 0xfe.toByte(), 0x01, 0x11, 0x22, 0x33, 0x44, 0x55),
                ByteArray(16),
                ByteArray(16),
            ),
        )
        val gen = Uuidv7Generator(
            now = { timestamp },
            fillRandom = { dst ->
                val src = randomValues.removeFirstOrNull() ?: ByteArray(dst.size)
                System.arraycopy(src, 0, dst, 0, dst.size)
            },
        )

        val first = gen.next()
        val second = gen.next()
        val third = gen.next()

        assertEquals("01234567-89ab-7fff-bfff-f91122334455", first)
        assertEquals("01234567-89ab-7fff-bfff-fc0000000000", second)
        assertEquals("01234567-89ac-7000-8000-000000000000", third)
        assertTrue(uuidV7Re.matches(first))
        assertTrue(uuidV7Re.matches(second))
        assertTrue(uuidV7Re.matches(third))
        assertEquals(timestamp, parseTimestamp(first))
        assertEquals(timestamp, parseTimestamp(second))
        assertEquals(timestamp + 1, parseTimestamp(third))
        assertTrue(first < second)
        assertTrue(second < third)
    }
}
