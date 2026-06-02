package dev.orbit.dock

import android.app.Application
import timber.log.Timber

class DockApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) {
            Timber.plant(Timber.DebugTree())
        }
        Timber.d("DockApp onCreate")
    }
}
