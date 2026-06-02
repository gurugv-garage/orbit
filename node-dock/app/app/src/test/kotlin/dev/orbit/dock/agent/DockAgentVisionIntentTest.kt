package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import org.junit.Test

/**
 * The vision-intent gate that decides whether a turn gets the camera frame
 * (see DockAgent.gateImageToVisionIntent). Seeing-questions → image attached;
 * movement/chat → text-only (so small vision models don't fixate on the image
 * and ignore action commands).
 */
class DockAgentVisionIntentTest {

    private class FakeSpeaker : Speaker {
        override fun enqueueSentence(text: String) {}
        override fun stop() {}
    }

    private val agent = DockAgent(
        tools = DockTools(FaceController(), FakeSpeaker(), onSubtitle = {}, body = null),
        baseUrl = "", model = "", // not configured → no network; we only test the pure gate
    )

    @Test fun seeingQuestionsAttachImage() {
        listOf(
            "what do you see",
            "what do you see right now",
            "can you see me",
            "describe what's in front of you",
            "what is this",
            "what am I holding",
            "how do I look",
            "what colour is my shirt",
            "look at this",
            "who is this",
            "take a picture and tell me",
        ).forEach { assertThat(agent.isVisionIntent(it)).isTrue() }
    }

    @Test fun movementAndChatStayTextOnly() {
        listOf(
            "look up",
            "look down then center",
            "look to the left",
            "nod your head",
            "turn left then right",
            "wiggle a little",
            "say hi",
            "tell me a joke",
            "how are you",
            "what's two plus two",
        ).forEach { assertThat(agent.isVisionIntent(it)).isFalse() }
        agent.shutdown()
    }
}
