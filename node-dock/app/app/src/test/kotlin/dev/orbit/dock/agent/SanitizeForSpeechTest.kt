package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * Regression suite for [sanitizeForSpeech]. Each test pins a specific
 * pattern that real LLMs (mainly gemma4:e2b on Ollama, and chat-template
 * leakage on a few openrouter free models) have emitted into the `text`
 * argument of speak() — patterns that without sanitisation get read aloud
 * by TTS verbatim.
 */
class SanitizeForSpeechTest {

    @Test
    fun cleanInputPassesThrough() {
        assertThat(sanitizeForSpeech("The capital of France is Paris."))
            .isEqualTo("The capital of France is Paris.")
    }

    @Test
    fun emptyStaysEmpty() {
        assertThat(sanitizeForSpeech("")).isEqualTo("")
        assertThat(sanitizeForSpeech("   \n  ")).isEqualTo("")
    }

    @Test
    fun stripsChatTemplateDelimiters() {
        val input = """<|"|>I am an AI, not a mental entity, but I'm here to chat with you! What were you thinking about?<|"|>"""
        assertThat(sanitizeForSpeech(input))
            .isEqualTo("I am an AI, not a mental entity, but I'm here to chat with you! What were you thinking about?")
    }

    @Test
    fun stripsImStartImEndStyleTags() {
        val input = "<|im_start|>Hello there.<|im_end|>"
        assertThat(sanitizeForSpeech(input)).isEqualTo("Hello there.")
    }

    @Test
    fun unwrapsLabelledSpeakCall() {
        val input = """speak(text: "Hi there!")"""
        assertThat(sanitizeForSpeech(input)).isEqualTo("Hi there!")
    }

    @Test
    fun unwrapsEqualsSpeakCall() {
        val input = """speak(text="Hi there!")"""
        assertThat(sanitizeForSpeech(input)).isEqualTo("Hi there!")
    }

    @Test
    fun unwrapsBareSpeakCall() {
        // The bug we hit: gemma4:e2b emits speak("...") as its text arg.
        val input = """speak("I'm sorry, I feel a bit down right now.")"""
        assertThat(sanitizeForSpeech(input))
            .isEqualTo("I'm sorry, I feel a bit down right now.")
    }

    @Test
    fun unwrapsBareSingleQuotedSpeakCall() {
        val input = "speak('hello world')"
        assertThat(sanitizeForSpeech(input)).isEqualTo("hello world")
    }

    @Test
    fun unwrapsNestedSpeakCalls() {
        // Worst case — model nested it twice.
        val input = """speak("speak(\"hi there!\")")"""
        val out = sanitizeForSpeech(input)
        // After unwrap we should be left with `hi there!` (escape backslashes
        // may remain depending on how the model emitted them; we only need to
        // make sure the speak( wrapper is gone and the inner text is present).
        assertThat(out).doesNotContain("speak(")
        assertThat(out).contains("hi there")
    }

    @Test
    fun stripsCodeFences() {
        val input = "```\nHello there.\n```"
        assertThat(sanitizeForSpeech(input)).isEqualTo("Hello there.")
    }

    @Test
    fun stripsLanguageTaggedCodeFences() {
        val input = "```text\nHello there.\n```"
        assertThat(sanitizeForSpeech(input)).isEqualTo("Hello there.")
    }

    @Test
    fun stripsLeadingResponseLabel() {
        assertThat(sanitizeForSpeech("Response: hello"))
            .isEqualTo("hello")
        assertThat(sanitizeForSpeech("text: hello"))
            .isEqualTo("hello")
    }

    @Test
    fun stripsSurroundingQuotes() {
        assertThat(sanitizeForSpeech("\"Hello.\""))
            .isEqualTo("Hello.")
        assertThat(sanitizeForSpeech("'Hello.'"))
            .isEqualTo("Hello.")
    }

    @Test
    fun collapsesWhitespace() {
        assertThat(sanitizeForSpeech("Hello    world.\n\n\nNext."))
            .isEqualTo("Hello world. Next.")
    }

    @Test
    fun isIdempotent() {
        // Applying sanitize twice produces the same result as once.
        val messy = """<|"|>speak("Hi there!")<|"|>"""
        val once = sanitizeForSpeech(messy)
        val twice = sanitizeForSpeech(once)
        assertThat(twice).isEqualTo(once)
        assertThat(once).isEqualTo("Hi there!")
    }

    @Test
    fun preservesPunctuationAndApostrophes() {
        val input = "I can't help you, but I'll try!"
        assertThat(sanitizeForSpeech(input))
            .isEqualTo("I can't help you, but I'll try!")
    }

    @Test
    fun unwrapsSpeakWithTrailingToolCalls() {
        // Real leak from emulator smoke: gemma emits speak("...") setFace(...).
        val input = """speak("did you know that octopuses have three hearts?") setFace(surprised)"""
        assertThat(sanitizeForSpeech(input))
            .isEqualTo("did you know that octopuses have three hearts?")
    }

    @Test
    fun stripsBareSetFaceArtifact() {
        val input = """Hello there! setFace(happy)"""
        assertThat(sanitizeForSpeech(input)).isEqualTo("Hello there!")
    }

    @Test
    fun mixedLeakedAndClean() {
        // Real-world mash: chat-template + speak wrapper around real text.
        val input = """<|"|>speak("Two plus two equals four! Easy peasy.")<|"|>"""
        assertThat(sanitizeForSpeech(input))
            .isEqualTo("Two plus two equals four! Easy peasy.")
    }
}
