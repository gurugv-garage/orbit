package dev.pi.agent.harness

/**
 * Kotlin port of pi-agent-core `src/harness/utils/truncate.ts`.
 *
 * Truncation honors two independent limits — whichever is hit first wins:
 * a line limit and a UTF-8 byte limit. Never returns partial lines (except the
 * tail edge case where a single line exceeds the byte budget). Kotlin/JVM
 * strings are UTF-16 like JS, so the surrogate-aware byte math ports directly.
 */

const val DEFAULT_MAX_LINES = 2000
const val DEFAULT_MAX_BYTES = 50 * 1024
const val GREP_MAX_LINE_LENGTH = 500

data class TruncationResult(
    val content: String,
    val truncated: Boolean,
    val truncatedBy: String?, // "lines" | "bytes" | null
    val totalLines: Int,
    val totalBytes: Int,
    val outputLines: Int,
    val outputBytes: Int,
    val lastLinePartial: Boolean,
    val firstLineExceedsLimit: Boolean,
    val maxLines: Int,
    val maxBytes: Int,
)

private fun utf8ByteLength(content: String): Int {
    var bytes = 0
    var i = 0
    while (i < content.length) {
        val code = content[i].code
        when {
            code <= 0x7f -> bytes += 1
            code <= 0x7ff -> bytes += 2
            code in 0xd800..0xdbff && i + 1 < content.length -> {
                val next = content[i + 1].code
                if (next in 0xdc00..0xdfff) { bytes += 4; i++ } else bytes += 3
            }
            else -> bytes += 3
        }
        i++
    }
    return bytes
}

private fun replaceUnpairedSurrogates(content: String): String {
    val out = StringBuilder()
    var i = 0
    while (i < content.length) {
        val code = content[i].code
        when {
            code in 0xd800..0xdbff -> {
                if (i + 1 < content.length && content[i + 1].code in 0xdc00..0xdfff) {
                    out.append(content[i]); out.append(content[i + 1]); i++
                } else out.append('�')
            }
            code in 0xdc00..0xdfff -> out.append('�')
            else -> out.append(content[i])
        }
        i++
    }
    return out.toString()
}

fun formatSize(bytes: Int): String = when {
    bytes < 1024 -> "${bytes}B"
    bytes < 1024 * 1024 -> "${"%.1f".format(bytes / 1024.0)}KB"
    else -> "${"%.1f".format(bytes / (1024.0 * 1024.0))}MB"
}

fun truncateHead(content: String, maxLines: Int = DEFAULT_MAX_LINES, maxBytes: Int = DEFAULT_MAX_BYTES): TruncationResult {
    val totalBytes = utf8ByteLength(content)
    val lines = content.split("\n")
    val totalLines = lines.size

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return TruncationResult(content, false, null, totalLines, totalBytes, totalLines, totalBytes, false, false, maxLines, maxBytes)
    }

    val firstLineBytes = utf8ByteLength(lines[0])
    if (firstLineBytes > maxBytes) {
        return TruncationResult("", true, "bytes", totalLines, totalBytes, 0, 0, false, true, maxLines, maxBytes)
    }

    val outputLines = mutableListOf<String>()
    var outputBytesCount = 0
    var truncatedBy = "lines"
    var i = 0
    while (i < lines.size && i < maxLines) {
        val line = lines[i]
        val lineBytes = utf8ByteLength(line) + if (i > 0) 1 else 0
        if (outputBytesCount + lineBytes > maxBytes) { truncatedBy = "bytes"; break }
        outputLines.add(line)
        outputBytesCount += lineBytes
        i++
    }
    if (outputLines.size >= maxLines && outputBytesCount <= maxBytes) truncatedBy = "lines"

    val outputContent = outputLines.joinToString("\n")
    return TruncationResult(
        outputContent, true, truncatedBy, totalLines, totalBytes,
        outputLines.size, utf8ByteLength(outputContent), false, false, maxLines, maxBytes,
    )
}

fun truncateTail(content: String, maxLines: Int = DEFAULT_MAX_LINES, maxBytes: Int = DEFAULT_MAX_BYTES): TruncationResult {
    val totalBytes = utf8ByteLength(content)
    val lines = content.split("\n").toMutableList()
    if (lines.size > 1 && lines.last() == "") lines.removeAt(lines.size - 1)
    val totalLines = lines.size

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return TruncationResult(content, false, null, totalLines, totalBytes, totalLines, totalBytes, false, false, maxLines, maxBytes)
    }

    val outputLines = ArrayDeque<String>()
    var outputBytesCount = 0
    var truncatedBy = "lines"
    var lastLinePartial = false

    var i = lines.size - 1
    while (i >= 0 && outputLines.size < maxLines) {
        val line = lines[i]
        val lineBytes = utf8ByteLength(line) + if (outputLines.isNotEmpty()) 1 else 0
        if (outputBytesCount + lineBytes > maxBytes) {
            truncatedBy = "bytes"
            if (outputLines.isEmpty()) {
                val truncatedLine = truncateStringToBytesFromEnd(line, maxBytes)
                outputLines.addFirst(truncatedLine)
                outputBytesCount = utf8ByteLength(truncatedLine)
                lastLinePartial = true
            }
            break
        }
        outputLines.addFirst(line)
        outputBytesCount += lineBytes
        i--
    }
    if (outputLines.size >= maxLines && outputBytesCount <= maxBytes) truncatedBy = "lines"

    val outputContent = outputLines.joinToString("\n")
    return TruncationResult(
        outputContent, true, truncatedBy, totalLines, totalBytes,
        outputLines.size, utf8ByteLength(outputContent), lastLinePartial, false, maxLines, maxBytes,
    )
}

private fun truncateStringToBytesFromEnd(str: String, maxBytes: Int): String {
    if (maxBytes <= 0) return ""
    var outputBytes = 0
    var start = str.length
    var needsReplacement = false
    var i = str.length
    while (i > 0) {
        var characterStart = i - 1
        val code = str[characterStart].code
        val characterBytes: Int
        var unpairedSurrogate = false
        when {
            code in 0xdc00..0xdfff && characterStart > 0 -> {
                val previous = str[characterStart - 1].code
                if (previous in 0xd800..0xdbff) { characterStart--; characterBytes = 4 }
                else { characterBytes = 3; unpairedSurrogate = true }
            }
            code in 0xd800..0xdfff -> { characterBytes = 3; unpairedSurrogate = true }
            else -> characterBytes = if (code <= 0x7f) 1 else if (code <= 0x7ff) 2 else 3
        }
        if (outputBytes + characterBytes > maxBytes) break
        outputBytes += characterBytes
        start = characterStart
        needsReplacement = needsReplacement || unpairedSurrogate
        i = characterStart
    }
    val output = str.substring(start)
    return if (needsReplacement) replaceUnpairedSurrogates(output) else output
}

fun truncateLine(line: String, maxChars: Int = GREP_MAX_LINE_LENGTH): Pair<String, Boolean> =
    if (line.length <= maxChars) line to false
    else "${line.substring(0, maxChars)}... [truncated]" to true
