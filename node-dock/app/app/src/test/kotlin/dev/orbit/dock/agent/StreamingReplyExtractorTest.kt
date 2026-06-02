package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * The plain-text sentence streamer that lets the dock start speaking before the
 * full reply has generated. Fed the cumulative assistant prose as it streams;
 * asserts which sentences come out and when.
 */
class StreamingReplyExtractorTest {

    /** Push a list of cumulative-text snapshots, collecting all sentences emitted. */
    private fun drive(snapshots: List<String>, flush: Boolean = true): List<String> {
        val ex = StreamingReplyExtractor()
        val out = mutableListOf<String>()
        for (s in snapshots) out += ex.push(s)
        if (flush) ex.flush()?.let { out += it }
        return out
    }

    /** Simulate streaming a final string in growing prefixes (1 char at a time). */
    private fun prefixes(full: String): List<String> =
        (1..full.length).map { full.substring(0, it) }

    @Test
    fun emitsFirstCompleteSentenceWhileMoreStreams() {
        val ex = StreamingReplyExtractor()
        // First sentence is complete (terminal punct + space); rest is partial.
        val out = ex.push("Hello there. And the")
        assertThat(out).containsExactly("Hello there.")
    }

    @Test
    fun doesNotEmitPartialSentence() {
        val ex = StreamingReplyExtractor()
        assertThat(ex.push("Hello the")).isEmpty()
    }

    @Test
    fun emitsSentencesAcrossChunksThenFlushesTail() {
        val out = drive(
            listOf(
                "One thing. ",
                "One thing. Two things! ",
                "One thing. Two things! A trailing bit",
            ),
        )
        // The two terminated sentences emit as boundaries appear; the trailing
        // clause (no terminal punctuation) comes out on flush.
        assertThat(out).containsExactly("One thing.", "Two things!", "A trailing bit").inOrder()
    }

    @Test
    fun handlesProseStreamedCharByChar() {
        val out = drive(prefixes("Hi there! How are you?"))
        assertThat(out).containsExactly("Hi there!", "How are you?").inOrder()
    }

    @Test
    fun doesNotResplitAlreadyEmittedSentences() {
        val ex = StreamingReplyExtractor()
        assertThat(ex.push("First. ")).containsExactly("First.")
        assertThat(ex.push("First. Second. ")).containsExactly("Second.") // not "First." again
    }

    @Test
    fun handlesEllipsisAndMultiPunct() {
        val ex = StreamingReplyExtractor()
        val out = ex.push("Wait… really?! Yes. ")
        assertThat(out).containsExactly("Wait…", "really?!", "Yes.").inOrder()
    }

    @Test
    fun flushReturnsTheTrailingClause() {
        val ex = StreamingReplyExtractor()
        ex.push("All done. ")                 // emits "All done."
        ex.push("All done. one more bit")     // trailing, no terminator
        assertThat(ex.flush()).isEqualTo("one more bit")
    }

    @Test
    fun flushReturnsNullWhenEverythingEmitted() {
        val ex = StreamingReplyExtractor()
        ex.push("All done. ")
        assertThat(ex.flush()).isNull()
    }

    @Test
    fun liveTextReturnsFullPrefixWithoutConsuming() {
        val ex = StreamingReplyExtractor()
        assertThat(ex.liveText("Hello the")).isEqualTo("Hello the")
        // liveText doesn't consume, so push still emits the sentence once done.
        assertThat(ex.push("Hello there. ")).containsExactly("Hello there.")
    }

    @Test
    fun liveTextNullWhenEmpty() {
        assertThat(StreamingReplyExtractor().liveText("")).isNull()
    }

    @Test
    fun flushIsIdempotent() {
        val ex = StreamingReplyExtractor()
        ex.push("Tail with no end")
        assertThat(ex.flush()).isEqualTo("Tail with no end")
        assertThat(ex.flush()).isNull()
        assertThat(ex.push("more")).isEmpty() // no output after flush
    }
}
