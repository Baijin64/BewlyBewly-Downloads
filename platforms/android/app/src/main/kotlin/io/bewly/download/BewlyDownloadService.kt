package io.bewly.download

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File

class BewlyDownloadService : Service() {

    private val binder = LocalBinder()

    inner class LocalBinder : Binder() {
        fun getService(): BewlyDownloadService = this@BewlyDownloadService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        when (action) {
            ACTION_START -> {
                startForegroundNotification()
                val dataDir = filesDir.absolutePath
                val mode = intent?.getStringExtra(EXTRA_MODE) ?: "service"
                Thread {
                    val ok = BewlyNative.startService(dataDir, mode)
                    Log.i(TAG, "BewlyNative service started: $ok (dataDir=$dataDir, mode=$mode)")
                }.start()
            }
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    fun getConnectionInfo(): JSONObject? {
        val connFile = File(filesDir, "connection.json")
        if (!connFile.exists()) return null
        return try {
            val text = connFile.readText()
            JSONObject(text)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read connection.json", e)
            null
        }
    }

    private fun startForegroundNotification() {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("BewlyBewly 下载服务")
            .setContentText("Rust 核心下载引擎运行中")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "BewlyBewly 下载服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "BewlyBewly 后台核心下载常驻通知"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    companion object {
        const val TAG = "BewlyDownloadService"
        const val CHANNEL_ID = "bewly_download_channel"
        const val NOTIFICATION_ID = 1001

        const val ACTION_START = "io.bewly.download.action.START"
        const val ACTION_STOP = "io.bewly.download.action.STOP"
        const val EXTRA_MODE = "io.bewly.download.extra.MODE"

        fun start(context: Context, mode: String = "service") {
            val intent = Intent(context, BewlyDownloadService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_MODE, mode)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, BewlyDownloadService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }
}
