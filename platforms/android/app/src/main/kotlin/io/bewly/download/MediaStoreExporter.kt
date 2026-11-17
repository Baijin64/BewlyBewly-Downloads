package io.bewly.download

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File

data class ExportedTarget(
    val uri: String,
    val displayLocation: String,
    val mimeType: String
)

object MediaStoreExporter {
    private const val TAG = "MediaStoreExporter"
    private const val PREFS_NAME = "bewly_exported_tasks"
    private const val KEY_AUTO_EXPORT = "auto_export_enabled"
    private const val STAGING_FOLDER = "downloads_staging"
    private const val TOOL_TEMP_FOLDER = "tool_temp"
    private val lock = Any()

    fun getStagingDir(context: Context): File {
        val dir = File(context.filesDir, STAGING_FOLDER)
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    fun getToolOutputDir(context: Context): File {
        val dir = File(context.filesDir, "tool_outputs")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    fun isAutoExportEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_AUTO_EXPORT, true)
    }

    fun setAutoExportEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_AUTO_EXPORT, enabled)
            .apply()
    }

    fun getExportedPrimary(context: Context, taskId: String): ExportedTarget? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString("task_$taskId", null) ?: return null
        return try {
            val obj = JSONObject(raw)
            val uri = obj.optString("uri", "")
            val display = obj.optString("display", "")
            val mime = obj.optString("mime", "*/*")
            if (uri.isEmpty()) null else ExportedTarget(uri, display, mime)
        } catch (_: Exception) {
            null
        }
    }

    fun exportCompletedTaskIfNeeded(
        context: Context,
        taskId: String,
        outputPath: String?,
        artifacts: Map<String, String>
    ): ExportedTarget? {
        if (!isAutoExportEnabled(context)) return null
        synchronized(lock) {
            getExportedPrimary(context, taskId)?.let { return it }

            val stagingRoot = getStagingDir(context).canonicalFile
            var primaryExport: ExportedTarget? = null

            if (!outputPath.isNullOrEmpty()) {
                val src = File(outputPath)
                if (src.isFile) {
                    val exported = exportFileToPublic(context, src)
                    if (exported != null) {
                        primaryExport = exported
                        if (isUnderDirectory(src, stagingRoot)) {
                            src.delete()
                            cleanEmptyParents(src.parentFile, stagingRoot)
                        }
                    }
                }
            }

            val exportedArtifacts = JSONObject()
            for ((kind, path) in artifacts) {
                if (path == outputPath) continue
                val src = File(path)
                if (!src.isFile) continue
                val exported = exportFileToPublic(context, src)
                if (exported != null) {
                    exportedArtifacts.put(kind, exported.uri)
                    if (isUnderDirectory(src, stagingRoot)) {
                        src.delete()
                        cleanEmptyParents(src.parentFile, stagingRoot)
                    }
                }
            }

            if (primaryExport != null || exportedArtifacts.length() > 0) {
                val payload = JSONObject().apply {
                    put("uri", primaryExport?.uri ?: "")
                    put("display", primaryExport?.displayLocation ?: "")
                    put("mime", primaryExport?.mimeType ?: "*/*")
                    put("artifacts", exportedArtifacts)
                }
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putString("task_$taskId", payload.toString())
                    .apply()
            }

            return primaryExport
        }
    }

    fun deleteExportedTaskFiles(context: Context, taskId: String) {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString("task_$taskId", null) ?: return
            try {
                val obj = JSONObject(raw)
                deleteUriOrPath(context, obj.optString("uri", ""))
                val artifacts = obj.optJSONObject("artifacts")
                if (artifacts != null) {
                    val keys = artifacts.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        deleteUriOrPath(context, artifacts.optString(key, ""))
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to clean exported files for $taskId", e)
            } finally {
                prefs.edit().remove("task_$taskId").apply()
            }
        }
    }

    fun exportToolFile(context: Context, sourceFile: File): ExportedTarget? {
        if (!sourceFile.isFile) return null
        val exported = exportFileToPublic(context, sourceFile) ?: return null
        sourceFile.delete()
        return exported
    }

    fun copyDocumentUriToTempFile(context: Context, uri: Uri, fallbackExt: String = ""): File? {
        return try {
            val displayName = resolveDisplayName(context, uri)
                ?: ("import_${System.currentTimeMillis()}$fallbackExt")
            val sanitized = displayName.replace(Regex("""[\\/:*?"<>|]"""), "_")
            val tempDir = File(context.cacheDir, TOOL_TEMP_FOLDER)
            if (!tempDir.exists()) tempDir.mkdirs()
            val outFile = File(tempDir, "${System.currentTimeMillis()}_$sanitized")
            context.contentResolver.openInputStream(uri)?.use { input ->
                outFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            } ?: return null
            outFile
        } catch (e: Exception) {
            Log.e(TAG, "Failed to copy document uri: $uri", e)
            null
        }
    }

    fun resolveDisplayName(context: Context, uri: Uri): String? {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) return cursor.getString(idx)
                }
            }
        return uri.lastPathSegment?.substringAfterLast('/')
    }

    fun mimeTypeFor(fileName: String): String {
        return when (fileName.substringAfterLast('.', "").lowercase()) {
            "mp4" -> "video/mp4"
            "mkv" -> "video/x-matroska"
            "mov" -> "video/quicktime"
            "m4a" -> "audio/mp4"
            "mp3" -> "audio/mpeg"
            "flac" -> "audio/flac"
            "mka" -> "audio/x-matroska"
            "aac" -> "audio/aac"
            "wav" -> "audio/wav"
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "webp" -> "image/webp"
            "srt" -> "application/x-subrip"
            "ass" -> "text/plain"
            "xml", "nfo" -> "text/xml"
            "txt" -> "text/plain"
            "json" -> "application/json"
            "csv" -> "text/csv"
            else -> "application/octet-stream"
        }
    }

    private fun exportFileToPublic(context: Context, source: File): ExportedTarget? {
        val fileName = source.name
        val ext = fileName.substringAfterLast('.', "").lowercase()
        val mime = mimeTypeFor(fileName)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val (collection, baseDir) = when (ext) {
                "mp4", "mkv", "mov" ->
                    MediaStore.Video.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_MOVIES
                "m4a", "mp3", "flac", "mka", "aac", "wav", "eac3" ->
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_MUSIC
                "jpg", "jpeg", "png", "webp" ->
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_PICTURES
                else ->
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_DOWNLOADS
            }
            val relPath = "$baseDir/BewlyBewly"
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, relPath)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val insertedUri = resolver.insert(collection, values) ?: return null
            return try {
                resolver.openOutputStream(insertedUri)?.use { out ->
                    source.inputStream().use { input ->
                        input.copyTo(out)
                    }
                } ?: throw IllegalStateException("openOutputStream returned null")

                val publishValues = ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }
                resolver.update(insertedUri, publishValues, null, null)
                ExportedTarget(
                    uri = insertedUri.toString(),
                    displayLocation = "$relPath/$fileName",
                    mimeType = mime
                )
            } catch (e: Exception) {
                Log.e(TAG, "MediaStore export failed for $fileName", e)
                try {
                    resolver.delete(insertedUri, null, null)
                } catch (_: Exception) {
                }
                null
            }
        } else {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.WRITE_EXTERNAL_STORAGE
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) return null

            val rootType = when (ext) {
                "mp4", "mkv", "mov" -> Environment.DIRECTORY_MOVIES
                "m4a", "mp3", "flac", "mka", "aac", "wav", "eac3" -> Environment.DIRECTORY_MUSIC
                "jpg", "jpeg", "png", "webp" -> Environment.DIRECTORY_PICTURES
                else -> Environment.DIRECTORY_DOWNLOADS
            }
            @Suppress("DEPRECATION")
            val destDir = File(Environment.getExternalStoragePublicDirectory(rootType), "BewlyBewly")
            if (!destDir.exists()) destDir.mkdirs()
            val destFile = uniqueTargetFile(destDir, fileName)
            return try {
                source.inputStream().use { input ->
                    destFile.outputStream().use { out ->
                        input.copyTo(out)
                    }
                }
                MediaScannerConnection.scanFile(context, arrayOf(destFile.absolutePath), arrayOf(mime), null)
                ExportedTarget(
                    uri = destFile.absolutePath,
                    displayLocation = "$rootType/BewlyBewly/${destFile.name}",
                    mimeType = mime
                )
            } catch (e: Exception) {
                Log.e(TAG, "Legacy public export failed for $fileName", e)
                null
            }
        }
    }

    private fun uniqueTargetFile(dir: File, fileName: String): File {
        var candidate = File(dir, fileName)
        if (!candidate.exists()) return candidate
        val dot = fileName.lastIndexOf('.')
        val stem = if (dot > 0) fileName.substring(0, dot) else fileName
        val ext = if (dot > 0) fileName.substring(dot) else ""
        var idx = 1
        while (candidate.exists()) {
            candidate = File(dir, "$stem ($idx)$ext")
            idx++
        }
        return candidate
    }

    private fun deleteUriOrPath(context: Context, uriOrPath: String) {
        if (uriOrPath.isEmpty()) return
        if (uriOrPath.startsWith("content://")) {
            try {
                context.contentResolver.delete(Uri.parse(uriOrPath), null, null)
            } catch (_: Exception) {
            }
        } else {
            try {
                File(uriOrPath).delete()
            } catch (_: Exception) {
            }
        }
    }

    private fun isUnderDirectory(file: File, root: File): Boolean {
        return try {
            val canonicalFile = file.canonicalPath
            val canonicalRoot = root.canonicalPath
            canonicalFile.startsWith(canonicalRoot + File.separator)
        } catch (_: Exception) {
            false
        }
    }

    private fun cleanEmptyParents(dir: File?, root: File) {
        var current = dir
        while (current != null && current.canonicalPath != root.canonicalPath) {
            val children = current.listFiles()
            if (children == null || children.isEmpty()) {
                current.delete()
                current = current.parentFile
            } else {
                break
            }
        }
    }
}
