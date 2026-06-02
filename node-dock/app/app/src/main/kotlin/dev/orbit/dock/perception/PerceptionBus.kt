package dev.orbit.dock.perception

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * Singleton in-process event bus for perception.
 *
 * Producers (MicCapture, SileroVad, PorcupineWakeWord, debug triggers) push
 * events here. Consumers (FaceController, agent, UI for live indicators)
 * collect. SharedFlow + DROP_OLDEST so the audio-level fire-hose doesn't
 * back-pressure slow consumers.
 */
object PerceptionBus {

    private val _events = MutableSharedFlow<PerceptionEvent>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    val events: SharedFlow<PerceptionEvent> = _events.asSharedFlow()

    fun emit(event: PerceptionEvent) {
        _events.tryEmit(event)
    }
}
