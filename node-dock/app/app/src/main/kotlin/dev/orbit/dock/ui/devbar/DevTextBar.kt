package dev.orbit.dock.ui.devbar

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent

/**
 * Debug-only text injection bar.
 *
 * Sits above the status bar. Type a phrase + press IME action (Send) or "go"
 * → emits Transcript(text, isFinal=true) and a WakeWord("(dev)") so the
 * downstream pipeline (M4 agent) sees the same event as if the user had
 * spoken.
 *
 * Lives in src/debug only so release builds don't include the dev surface.
 */
@Composable
fun DevTextBar(modifier: Modifier = Modifier) {
    var value by remember { mutableStateOf(TextFieldValue("")) }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current

    fun send() {
        val text = value.text.trim()
        if (text.isEmpty()) return
        PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(dev)"))
        PerceptionBus.emit(PerceptionEvent.Transcript(text = text, isFinal = true))
        value = TextFieldValue("")
        // dismiss keyboard + release focus so the dock UI is unobstructed
        keyboard?.hide()
        focusManager.clearFocus(force = true)
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xFF1A2228).copy(alpha = 0.85f))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "dev",
            fontSize = 10.sp,
            color = Color(0xFFFFBE5C),
            modifier = Modifier.padding(end = 4.dp),
        )
        OutlinedTextField(
            value = value,
            onValueChange = { value = it },
            placeholder = {
                Text("type a transcript (Enter to send)", fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.4f))
            },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium,
            modifier = Modifier
                .weight(1f)
                .height(48.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = MaterialTheme.colorScheme.onBackground,
                unfocusedTextColor = MaterialTheme.colorScheme.onBackground,
                focusedBorderColor = Color(0xFF9DDDFF).copy(alpha = 0.4f),
                unfocusedBorderColor = Color.White.copy(alpha = 0.12f),
            ),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
        )
        TextButton(onClick = { send() }) {
            Text("go", fontSize = 12.sp)
        }
    }
}
