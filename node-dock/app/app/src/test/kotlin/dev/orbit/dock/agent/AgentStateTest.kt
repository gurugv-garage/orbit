package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class AgentStateTest {

    @Test
    fun idleShortLabel() {
        assertThat(AgentState.Idle.shortLabel).isEqualTo("idle")
    }

    @Test
    fun waitingShortLabelStripsProvider() {
        assertThat(AgentState.Waiting(model = "ollama/glm-4.7-flash:latest").shortLabel)
            .isEqualTo("waiting · glm-4.7-flash")
    }

    @Test
    fun thinkingShortLabelStripsProviderAndFreeSuffix() {
        val s = AgentState.Thinking(
            model = "nvidia/nemotron-3-super-120b-a12b:free",
            attempt = 2,
            of = 7,
        )
        assertThat(s.shortLabel).isEqualTo("thinking · nemotron-3-super-120b-a12b (2/7)")
    }

    @Test
    fun thinkingHandlesBareModelId() {
        val s = AgentState.Thinking(model = "openrouter/free", attempt = 1, of = 1)
        assertThat(s.shortLabel).isEqualTo("thinking · free (1/1)")
    }

    @Test
    fun toolCallingShortLabel() {
        assertThat(AgentState.ToolCalling("setFace").shortLabel).isEqualTo("tool · setFace")
    }

    @Test
    fun failedShortLabelIncludesMessage() {
        assertThat(AgentState.Failed("all models busy").shortLabel)
            .isEqualTo("error · all models busy")
    }

    @Test
    fun speakingShortLabel() {
        assertThat(AgentState.Speaking.shortLabel).isEqualTo("speaking")
    }
}
