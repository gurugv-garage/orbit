package dev.orbit.dock

import android.app.Application
import timber.log.Timber

class DockApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Plant in release too: this is a self-hosted appliance, and field
        // logs (esp. OTA self-update progress) are worth more than the tiny
        // logcat cost. DebugTree tags by class.
        Timber.plant(Timber.DebugTree())
        Timber.d("DockApp onCreate")
    }
}
