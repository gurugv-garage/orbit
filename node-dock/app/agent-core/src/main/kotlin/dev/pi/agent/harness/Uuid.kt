package dev.pi.agent.harness

import java.security.SecureRandom

/**
 * Kotlin port of pi-agent-core `src/harness/session/uuid.ts`.
 *
 * Monotonic UUIDv7: time-ordered, with a per-millisecond sequence counter so
 * ids generated in the same millisecond still sort in creation order. Mirrors
 * the JS bit layout exactly.
 *
 * [Uuidv7Generator] takes injectable clock + random sources so the monotonic
 * behavior is deterministically testable (the TS test stubs Date.now and
 * crypto.getRandomValues). The module-level [uuidv7] uses a system-backed
 * singleton.
 */
class Uuidv7Generator(
    private val now: () -> Long = { System.currentTimeMillis() },
    private val fillRandom: (ByteArray) -> Unit = { defaultRng.nextBytes(it) },
) {
    private var lastTimestamp = Long.MIN_VALUE
    private var sequence = 0L

    @Synchronized
    fun next(): String {
        val random = ByteArray(16)
        fillRandom(random)
        val timestamp = now()

        if (timestamp > lastTimestamp) {
            sequence = (
                (random[6].toLong() and 0xff) * 0x1000000 +
                    (random[7].toLong() and 0xff) * 0x10000 +
                    (random[8].toLong() and 0xff) * 0x100 +
                    (random[9].toLong() and 0xff)
                ) and 0xffffffffL
            lastTimestamp = timestamp
        } else {
            sequence = (sequence + 1) and 0xffffffffL
            if (sequence == 0L) lastTimestamp++
        }

        val ts = lastTimestamp
        val bytes = ByteArray(16)
        bytes[0] = ((ts / 0x10000000000L) and 0xff).toByte()
        bytes[1] = ((ts / 0x100000000L) and 0xff).toByte()
        bytes[2] = ((ts / 0x1000000L) and 0xff).toByte()
        bytes[3] = ((ts / 0x10000L) and 0xff).toByte()
        bytes[4] = ((ts / 0x100L) and 0xff).toByte()
        bytes[5] = (ts and 0xff).toByte()
        bytes[6] = (0x70 or ((sequence ushr 28).toInt() and 0x0f)).toByte()
        bytes[7] = ((sequence ushr 20).toInt() and 0xff).toByte()
        bytes[8] = (0x80 or ((sequence ushr 14).toInt() and 0x3f)).toByte()
        bytes[9] = ((sequence ushr 6).toInt() and 0xff).toByte()
        bytes[10] = (((sequence.toInt() and 0x3f) shl 2) or (random[10].toInt() and 0x03)).toByte()
        bytes[11] = random[11]
        bytes[12] = random[12]
        bytes[13] = random[13]
        bytes[14] = random[14]
        bytes[15] = random[15]

        return formatUuid(bytes)
    }

    companion object {
        private val defaultRng = SecureRandom()

        fun formatUuid(bytes: ByteArray): String {
            val hex = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
            return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-" +
                "${hex.substring(16, 20)}-${hex.substring(20, 32)}"
        }
    }
}

private val systemGenerator = Uuidv7Generator()

fun uuidv7(): String = systemGenerator.next()
