package dev.orbit.dock.perception

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide latest result of the AEC self-test, so the debug UI can render it
 * without threading the [AecSelfTest] instance (which needs the Speaker, owned
 * by DockScreen) through composable params. [AecSelfTest] publishes here; the
 * debug DEBUG tab observes it.
 */
object AecTestState {
    private val _result = MutableStateFlow<AecSelfTest.Result?>(null)
    val result: StateFlow<AecSelfTest.Result?> = _result.asStateFlow()

    fun publish(result: AecSelfTest.Result) { _result.value = result }
}
