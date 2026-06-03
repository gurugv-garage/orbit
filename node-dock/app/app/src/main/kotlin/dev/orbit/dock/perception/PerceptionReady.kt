package dev.orbit.dock.perception

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide "is the perception pipeline live?" flag.
 *
 * The wake-word / VAD / STT models take a few seconds to load on cold start
 * (and TTS warms up separately). Until then the face renders but the dock
 * can't actually hear — so the UI shows a brief "waking up…" state by
 * observing this. [PerceptionPipeline] sets it true once its models are
 * constructed, false when the pipeline stops.
 */
object PerceptionReady {
    private val _ready = MutableStateFlow(false)
    val ready: StateFlow<Boolean> = _ready.asStateFlow()

    fun set(ready: Boolean) { _ready.value = ready }
}
