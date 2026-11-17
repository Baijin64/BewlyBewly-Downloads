package io.bewly.download

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.system.Os
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class BewlyDownloadService : Service() {

    private val binder = LocalBinder()
    private var monitorExecutor: ScheduledExecutorService? = null
    private var lastActiveCount: Int = 0

    inner class LocalBinder : Binder() {
        fun getService(): BewlyDownloadService = this@BewlyDownloadService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    override fun onDestroy() {
        stopMonitor()
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        when (action) {
            ACTION_START -> {
                startForeground(NOTIFICATION_ID, buildStatusNotification("Rust 核心下载引擎运行中", null, 0, false))
                val dataDir = filesDir.absolutePath
                val mode = intent?.getStringExtra(EXTRA_MODE) ?: "service"
                exposeBundledFfmpeg()
                val alreadyRunning = try {
                    JSONObject(BewlyNative.ping()).optBoolean("service_running", false)
                } catch (_: Throwable) {
                    false
                }
                if (!alreadyRunning) {
                    File(filesDir, "connection.json").delete()
                    File(filesDir, "service.lock").delete()
                }
                Thread {
                    val ok = BewlyNative.startService(dataDir, mode)
                    Log.i(TAG, "BewlyNative service started: $ok (dataDir=$dataDir, mode=$mode)")
                }.start()
                startMonitor()
            }
            ACTION_PAUSE_ALL -> {
                Thread {
                    createRpcClient(this)?.batchAction(action = "pause", all = "active")
                    pollAndUpdateNotification()
                }.start()
            }
            ACTION_STOP -> {
                stopMonitor()
                BewlyNative.stopService()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    fun getConnectionInfo(): JSONObject? = getConnectionInfo(this)

    private fun startMonitor() {
        if (monitorExecutor != null) return
        val exec = Executors.newSingleThreadScheduledExecutor()
        monitorExecutor = exec
        exec.scheduleWithFixedDelay(
            {
                try {
                    pollAndUpdateNotification()
                } catch (e: Exception) {
                    Log.w(TAG, "Notification monitor tick error", e)
                }
            },
            1500L,
            1500L,
            TimeUnit.MILLISECONDS
        )
    }

    private fun stopMonitor() {
        monitorExecutor?.shutdownNow()
        monitorExecutor = null
    }

    private fun pollAndUpdateNotification() {
        val client = createRpcClient(this) ?: return
        val res = client.queryTasks("all", page = 1, pageSize = 100)
        if (res !is RpcResult.Success) return
        val json = res.result as? JSONObject ?: return
        val items = json.optJSONArray("items") ?: JSONArray()

        var activeCount = 0
        var totalSpeed = 0L
        var leadTitle = ""
        var leadProgress = 0.0
        var totalProgressSum = 0.0

        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            val status = item.optString("status", "")
            if (status in ACTIVE_STATUSES) {
                activeCount++
                totalSpeed += item.optLong("speed", 0L)
                val p = item.optDouble("progress", 0.0).coerceIn(0.0, 100.0)
                totalProgressSum += p
                if (leadTitle.isEmpty() || status == "downloading") {
                    leadTitle = item.optString("title", "下载任务")
                    leadProgress = p
                }
            } else if (status == "completed") {
                val id = item.optString("id", "")
                val output = item.optString("output", "").takeIf { it.isNotEmpty() }
                if (id.isNotEmpty() && output != null) {
                    val artifactsObj = item.optJSONObject("artifacts")
                    val artifactMap = mutableMapOf<String, String>()
                    if (artifactsObj != null) {
                        val keys = artifactsObj.keys()
                        while (keys.hasNext()) {
                            val key = keys.next()
                            val path = artifactsObj.optString(key, "")
                            if (path.isNotEmpty()) artifactMap[key] = path
                        }
                    }
                    MediaStoreExporter.exportCompletedTaskIfNeeded(this, id, output, artifactMap)
                }
            }
        }

        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (activeCount > 0) {
            val avgProgress = if (activeCount > 1) {
                (totalProgressSum / activeCount).toInt().coerceIn(0, 100)
            } else {
                leadProgress.toInt().coerceIn(0, 100)
            }
            val speedText = formatSpeed(totalSpeed)
            val title = if (activeCount == 1) {
                "正在下载 · $avgProgress%"
            } else {
                "正在下载 $activeCount 个任务 · $avgProgress%"
            }
            val content = "$leadTitle ($speedText)"
            manager.notify(
                NOTIFICATION_ID,
                buildStatusNotification(title, content, avgProgress, true)
            )
        } else {
            if (lastActiveCount > 0) {
                postCompletionAlert(manager, lastActiveCount)
            }
            manager.notify(
                NOTIFICATION_ID,
                buildStatusNotification("BewlyBewly 下载服务", "引擎待命中，等待新任务", 0, false)
            )
        }
        lastActiveCount = activeCount
    }

    private fun postCompletionAlert(manager: NotificationManager, count: Int) {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val alert = NotificationCompat.Builder(this, EVENTS_CHANNEL_ID)
            .setContentTitle("下载队列已完成")
            .setContentText("$count 个任务已处理完毕，可在系统相册/下载目录查看")
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .build()
        manager.notify(EVENT_NOTIFICATION_ID, alert)
    }

    /**
     * FFmpeg ships as libffmpeg.so so the installer extracts it to the native library
     * directory, the only app location Android 10+ lets a process execute from. The
     * Rust core runs in this process and reads its path from BEWLY_FFMPEG.
     */
    private fun exposeBundledFfmpeg() {
        val ffmpeg = File(applicationInfo.nativeLibraryDir, "libffmpeg.so")
        if (ffmpeg.isFile) {
            Os.setenv("BEWLY_FFMPEG", ffmpeg.absolutePath, true)
        } else {
            Log.w(TAG, "Bundled FFmpeg missing at ${ffmpeg.absolutePath}; muxing falls back to single-file streams")
        }
    }

    private fun buildStatusNotification(
        title: String,
        content: String?,
        progress: Int,
        downloading: Boolean
    ): Notification {
        val openAppIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, BewlyDownloadService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content ?: "Rust 核心下载引擎运行中")
            .setSmallIcon(
                if (downloading) android.R.drawable.stat_sys_download
                else android.R.drawable.stat_sys_download_done
            )
            .setContentIntent(openAppIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        if (downloading) {
            builder.setProgress(100, progress, false)
            val pauseAllIntent = PendingIntent.getService(
                this,
                2,
                Intent(this, BewlyDownloadService::class.java).apply { action = ACTION_PAUSE_ALL },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            builder.addAction(0, "暂停全部", pauseAllIntent)
        }
        builder.addAction(0, "停止服务", stopIntent)

        return builder.build()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java) ?: return
            val serviceChannel = NotificationChannel(
                CHANNEL_ID,
                "BewlyBewly 下载服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "BewlyBewly 后台下载与实时进度通知"
            }
            val eventChannel = NotificationChannel(
                EVENTS_CHANNEL_ID,
                "下载完成提醒",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "下载任务全部完成时提醒"
            }
            manager.createNotificationChannel(serviceChannel)
            manager.createNotificationChannel(eventChannel)
        }
    }

    private fun formatSpeed(bytesPerSec: Long): String {
        if (bytesPerSec <= 0L) return "0 B/s"
        val units = arrayOf("B/s", "KB/s", "MB/s", "GB/s")
        var v = bytesPerSec.toDouble()
        var idx = 0
        while (v >= 1024.0 && idx < units.lastIndex) {
            v /= 1024.0
            idx++
        }
        return String.format(Locale.US, "%.1f %s", v, units[idx])
    }

    companion object {
        const val TAG = "BewlyDownloadService"
        const val CHANNEL_ID = "bewly_download_channel"
        const val EVENTS_CHANNEL_ID = "bewly_download_events_channel"
        const val NOTIFICATION_ID = 1001
        const val EVENT_NOTIFICATION_ID = 1002

        const val ACTION_START = "io.bewly.download.action.START"
        const val ACTION_STOP = "io.bewly.download.action.STOP"
        const val ACTION_PAUSE_ALL = "io.bewly.download.action.PAUSE_ALL"
        const val EXTRA_MODE = "io.bewly.download.extra.MODE"

        private val ACTIVE_STATUSES = setOf(
            "downloading", "queued", "resolving", "muxing", "postprocessing"
        )

        fun getConnectionInfo(context: Context): JSONObject? {
            val connFile = File(context.filesDir, "connection.json")
            if (!connFile.exists()) return null
            return try {
                JSONObject(connFile.readText())
            } catch (e: Exception) {
                Log.e(TAG, "Failed to read connection.json", e)
                null
            }
        }

        fun createRpcClient(context: Context): BewlyRpcClient? {
            val conn = getConnectionInfo(context) ?: return null
            val port = conn.optInt("port", 0)
            val token = conn.optString("token", "")
            return if (port > 0 && token.isNotEmpty()) BewlyRpcClient(port, token) else null
        }

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
