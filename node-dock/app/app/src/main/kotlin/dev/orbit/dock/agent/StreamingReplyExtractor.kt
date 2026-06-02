package dev.orbit.dock.agent

/**
 * Emits speakable sentences from streaming assistant prose **as it arrives**, so
 * the dock starts talking before the whole reply has generated (the main
 * perceived-latency win on multi-second turns).
 *
 * [DockAgent] feeds the cumulative assistant text on each stream delta; [push]
 * returns any newly-completed sentences (in order), and [flush] yields the
 * trailing clause at end-of-stream (the last sentence often lacks terminal
 * punctuation). [liveText] gives the full text so far for the live subtitle.
 *
 * Pure (no Android/JSON/model deps) so the segmentation is unit-tested
 * ([StreamingReplyExtractorTest]) in isolation. Plain text in — the agentic loop
 * streams bare prose (tools carry the actions), so there's no JSON to decode.
 */
class StreamingReplyExtractor {

    private var emittedChars = 0   // how much of the cumulative text we've already spoken
    private var lastText = ""      // last cumulative text seen (for flush)
    private var flushed = false    // flush() ran → no more output

    /**
     * Feed the cumulative prose seen so far; returns sentences completed since
     * the last call (terminal punctuation followed by whitespace). Empty until
     * the first sentence boundary is reached.
     */
    fun push(textSoFar: String): List<String> {
        if (flushed) return emptyList()
        lastText = textSoFar
        val unseen = textSoFar.substring(emittedChars.coerceAtMost(textSoFar.length))
        val out = mutableListOf<String>()
        var consumed = 0
        for (boundary in sentenceBoundaries(unseen)) {
            val sentence = unseen.substring(consumed, boundary).trim()
            if (sentence.isNotEmpty()) out.add(sentence)
            consumed = boundary
        }
        emittedChars += consumed
        return out
    }

    /** Full cumulative text so far (for the live subtitle), or null if empty. */
    fun liveText(textSoFar: String): String? = textSoFar.takeIf { it.isNotEmpty() }

    /**
     * End of stream: return the trailing clause not yet emitted (the final
     * sentence usually has no terminal punctuation). Idempotent.
     */
    fun flush(): String? {
        if (flushed) return null
        flushed = true
        val tail = lastText.substring(emittedChars.coerceAtMost(lastText.length)).trim()
        return tail.ifEmpty { null }
    }

    /**
     * End offsets (exclusive) of complete sentences in [text]. A boundary is a
     * run of terminal punctuation (. ! ? …) followed by whitespace — the
     * trailing-whitespace requirement avoids splitting an abbreviation or a
     * mid-stream token that just happens to end the buffer.
     */
    private fun sentenceBoundaries(text: String): List<Int> {
        val out = mutableListOf<Int>()
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == '.' || c == '!' || c == '?' || c == '…') {
                var j = i
                while (j < text.length && (text[j] == '.' || text[j] == '!' || text[j] == '?' || text[j] == '…')) j++
                if (j < text.length && text[j].isWhitespace()) {
                    out.add(j)
                    i = j
                    continue
                }
            }
            i++
        }
        return out
    }
}
