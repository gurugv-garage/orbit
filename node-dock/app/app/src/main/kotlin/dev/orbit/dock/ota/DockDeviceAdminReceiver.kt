package dev.orbit.dock.ota

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context

/**
 * Device-admin receiver for OTA self-update (docs/OTA.md §5.1).
 *
 * We don't use admin *policies*; this exists so the app can be made the
 * **device owner** via a one-time `adb shell dpm set-device-owner
 * dev.orbit.dock/.ota.DockDeviceAdminReceiver` on a fresh phone. Device-owner
 * status is what lets [OtaUpdater] install its downloaded APK SILENTLY (no
 * per-install confirm dialog) — the right behaviour for an always-on appliance.
 *
 * Harmless if never provisioned: [OtaUpdater] checks owner status and falls
 * back to the system's confirm-install flow.
 */
class DockDeviceAdminReceiver : DeviceAdminReceiver() {
    companion object {
        fun component(context: Context): ComponentName =
            ComponentName(context, DockDeviceAdminReceiver::class.java)
    }
}
