package io.bewly.download

object BewlyNative {
    init {
        System.loadLibrary("bewly_android")
    }

    external fun startService(dataDir: String, mode: String): Boolean
    external fun stopService(): Boolean
    external fun ping(): String
}
