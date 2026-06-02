package dev.orbit.dock.body.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.body.BodyHostStore
import dev.orbit.dock.body.NetUtil

private val ACCENT = Color(0xFF9DDDFF)
private val YELLOW = Color(0xFFFCC72A)

/**
 * Connect dialog for the BodyLink host. Opened by tapping the body badge.
 *
 *  - Radio: IP (default) vs Address (hostname)
 *  - IP mode: 4 octet boxes prefilled from the phone's own subnet, numeric
 *    keypad, last octet focused; all 4 editable
 *  - Address mode: single hostname field
 *  - Port field (default 17317)
 *  - History: last 5 successful hosts, tap to connect, × to delete
 *  - Connect → onConnect("host:port")
 */
@Composable
fun BodyConnectDialog(
    store: BodyHostStore,
    currentHost: String,
    onConnect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    // Seed octets from the phone's own IP (same /24 as the XIAO, usually).
    val phoneIp = remember { NetUtil.localIpv4() }
    val seedOctets = remember { NetUtil.octetsOf(phoneIp) }
    val (seedHost, seedPort) = remember { NetUtil.splitHostPort(currentHost) }

    var mode by remember { mutableStateOf(Mode.IP) }
    var o0 by remember { mutableStateOf(seedOctets[0]) }
    var o1 by remember { mutableStateOf(seedOctets[1]) }
    var o2 by remember { mutableStateOf(seedOctets[2]) }
    var o3 by remember { mutableStateOf(seedOctets.getOrElse(3) { "" }) }
    var address by remember { mutableStateOf(if (seedHost.count { it == '.' } == 3) "" else seedHost) }
    var port by remember { mutableStateOf(seedPort.toString()) }
    var history by remember { mutableStateOf(store.history()) }

    fun buildHost(): String {
        val p = port.toIntOrNull() ?: 17317
        return if (mode == Mode.IP) "$o0.$o1.$o2.$o3:$p" else "${address.trim()}:$p"
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = { onConnect(buildHost()) }) {
                Text("Connect", color = ACCENT, fontWeight = FontWeight.Bold)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = Color.White.copy(alpha = 0.7f)) }
        },
        title = { Text("Connect to body", color = Color.White, fontSize = 16.sp) },
        text = {
            Column {
                // Radio row.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioChip("IP", mode == Mode.IP) { mode = Mode.IP }
                    Spacer(Modifier.width(8.dp))
                    RadioChip("Address", mode == Mode.ADDRESS) { mode = Mode.ADDRESS }
                }
                Spacer(Modifier.size(12.dp))

                if (mode == Mode.IP) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OctetBox(o0) { o0 = it }
                        Dot()
                        OctetBox(o1) { o1 = it }
                        Dot()
                        OctetBox(o2) { o2 = it }
                        Dot()
                        OctetBox(o3, focused = true) { o3 = it }
                    }
                } else {
                    OutlinedTextField(
                        value = address,
                        onValueChange = { address = it },
                        singleLine = true,
                        placeholder = { Text("dock.local", color = Color.White.copy(alpha = 0.4f)) },
                        colors = fieldColors(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                Spacer(Modifier.size(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Port", color = Color.White.copy(alpha = 0.7f), fontSize = 12.sp)
                    Spacer(Modifier.width(8.dp))
                    OutlinedTextField(
                        value = port,
                        onValueChange = { port = it.filter { c -> c.isDigit() }.take(5) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        colors = fieldColors(),
                        modifier = Modifier.width(110.dp),
                    )
                }

                if (history.isNotEmpty()) {
                    Spacer(Modifier.size(14.dp))
                    Text("Recent", color = YELLOW, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.size(4.dp))
                    for (h in history) {
                        HistoryRow(
                            host = h,
                            onConnect = { onConnect(h) },
                            onDelete = {
                                store.remove(h)
                                history = store.history()
                            },
                        )
                    }
                }
            }
        },
        containerColor = Color(0xFF15201A),
    )
}

private enum class Mode { IP, ADDRESS }

@Composable
private fun RadioChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(if (selected) ACCENT.copy(alpha = 0.25f) else Color.White.copy(alpha = 0.08f))
            .clickable { onClick() }
            .padding(horizontal = 14.dp, vertical = 7.dp),
    ) {
        Text(
            (if (selected) "● " else "○ ") + label,
            color = if (selected) ACCENT else Color.White.copy(alpha = 0.75f),
            fontSize = 13.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

@Composable
private fun OctetBox(value: String, focused: Boolean = false, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it.filter { c -> c.isDigit() }.take(3)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Number,
            imeAction = if (focused) ImeAction.Done else ImeAction.Next,
        ),
        colors = fieldColors(),
        textStyle = androidx.compose.ui.text.TextStyle(
            color = Color.White,
            fontFamily = FontFamily.Monospace,
            fontSize = 16.sp,
        ),
        modifier = Modifier.width(58.dp),
    )
}

@Composable
private fun Dot() {
    Text(".", color = Color.White, fontSize = 18.sp,
        modifier = Modifier.padding(horizontal = 2.dp))
}

@Composable
private fun HistoryRow(host: String, onConnect: () -> Unit, onDelete: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            host,
            color = ACCENT,
            fontSize = 13.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .clickable { onConnect() }
                .padding(vertical = 4.dp, horizontal = 4.dp),
        )
        Text(
            "✕",
            color = Color(0xFFFF7B7B),
            fontSize = 14.sp,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .clickable { onDelete() }
                .padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = Color.White,
    unfocusedTextColor = Color.White,
    focusedBorderColor = ACCENT.copy(alpha = 0.6f),
    unfocusedBorderColor = Color.White.copy(alpha = 0.15f),
    cursorColor = ACCENT,
)
