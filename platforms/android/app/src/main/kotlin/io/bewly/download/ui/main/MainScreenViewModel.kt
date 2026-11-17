package io.bewly.download.ui.main

import android.content.Context
import android.net.Uri
import android.os.Environment
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.bewly.download.BewlyDownloadService
import io.bewly.download.BewlyNative
import io.bewly.download.BewlyRpcClient
import io.bewly.download.MediaStoreExporter
import io.bewly.download.RpcResult
import io.bewly.download.data.DataRepository
import io.bewly.download.data.DefaultDataRepository
import io.bewly.download.ui.main.MainScreenUiState.Success
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class TaskItem(
    val id: String,
    val title: String,
    val bvid: String,
    val status: String,
    val progress: Double,
    val speed: Long,
    val downloaded: Long,
    val total: Long,
    val error: String,
    val output: String?,
    val artifacts: Map<String, String> = emptyMap(),
    val exportedUri: String? = null,
    val exportedDisplay: String? = null
)

enum class TaskFilter(val label: String) {
    ALL("全部"),
    ACTIVE("下载中"),
    PENDING("待下载"),
    COMPLETED("已完成"),
    FAILED("失败")
}

data class QualityOption(val quality: Int, val label: String)
data class CodecOption(val codec: String, val label: String)
data class AudioQualityOption(val audioQuality: String, val label: String)
data class OutputOption(val mode: String, val label: String)
data class AttachmentOption(val key: String, val label: String)

data class VideoPageItem(
    val cid: Long,
    val page: Int,
    val title: String,
    val duration: Long
)

data class CollectionVideoItem(
    val bvid: String,
    val cid: Long,
    val title: String,
    val available: Boolean
)

data class CollectionSectionItem(
    val title: String,
    val videos: List<CollectionVideoItem>
)

data class InspectedVideo(
    val rawInfo: JSONObject,
    val bvid: String,
    val title: String,
    val author: String,
    val requestedPage: Int,
    val pages: List<VideoPageItem>,
    val collectionTitle: String? = null,
    val collectionSections: List<CollectionSectionItem> = emptyList()
)

data class EngineSettingsState(
    val maxConcurrent: Int = 2,
    val filenameTemplate: String = "%title% [%bv%-%cid%]",
    val folderTemplate: String = "",
    val autoExportPublic: Boolean = true
)

data class PickedLocalFile(
    val uri: Uri,
    val name: String
)

data class ToolboxUiState(
    val convertInput: String = "",
    val convertResult: String? = null,
    val srtLineBreaks: Boolean = true,
    val exportFormat: String = "json",
    val pickedCcFile: PickedLocalFile? = null,
    val pickedSrtFile: PickedLocalFile? = null,
    val pickedAudioFile: PickedLocalFile? = null,
    val pickedMuxVideo: PickedLocalFile? = null,
    val pickedMuxAudio: PickedLocalFile? = null,
    val isBusy: Boolean = false,
    val resultMessage: String? = null,
    val resultFileUri: String? = null,
    val resultFileDisplay: String? = null,
    val resultFileMime: String? = null
)

val AVAILABLE_QUALITIES = listOf(
    QualityOption(0, "最高可用"),
    QualityOption(127, "8K 超高清"),
    QualityOption(120, "4K 超清"),
    QualityOption(116, "1080P 60帧"),
    QualityOption(112, "1080P 高码"),
    QualityOption(80, "1080P 高清"),
    QualityOption(64, "720P"),
    QualityOption(32, "480P")
)

val AVAILABLE_CODECS = listOf(
    CodecOption("auto", "自动编码"),
    CodecOption("avc", "AVC (H.264)"),
    CodecOption("hevc", "HEVC (H.265)"),
    CodecOption("av1", "AV1")
)

val AVAILABLE_AUDIO_QUALITIES = listOf(
    AudioQualityOption("auto", "最高可用"),
    AudioQualityOption("hires", "Hi-Res 无损"),
    AudioQualityOption("dolby", "杜比全景声"),
    AudioQualityOption("192", "192K"),
    AudioQualityOption("132", "132K"),
    AudioQualityOption("64", "64K")
)

val AVAILABLE_OUTPUTS = listOf(
    OutputOption("video", "视频 (MP4/MKV)"),
    OutputOption("silent", "无声视频"),
    OutputOption("audio", "原生音频"),
    OutputOption("mp3", "转码 MP3")
)

val AVAILABLE_ATTACHMENTS = listOf(
    AttachmentOption("cover", "封面"),
    AttachmentOption("xml", "XML 弹幕"),
    AttachmentOption("ass", "ASS 弹幕"),
    AttachmentOption("srt", "SRT 字幕"),
    AttachmentOption("nfo", "NFO 资料")
)

val FILENAME_PRESETS = listOf(
    "%title% [%bv%-%cid%]" to "默认标题+BV",
    "%title%" to "仅标题",
    "%upnn% - %title%" to "UP主 + 标题",
    "P%index% %part% - %title%" to "分P序号+名称"
)

data class BenchUiState(
    val jniStatus: String = "未检测",
    val isJniOk: Boolean = false,
    val isServiceRunning: Boolean = false,
    val rpcEndpoint: String = "未连接",
    val rpcHealth: String = "未检查",
    val downloadDirectory: String = "",
    val videoInput: String = "",
    val isProcessing: Boolean = false,
    val statusMessage: String? = null,
    val isDiagnosticsExpanded: Boolean = false,
    val isCookieDialogVisible: Boolean = false,
    val isWebLoginDialogVisible: Boolean = false,
    val sessionCookie: String = "",
    val isSessionConfigured: Boolean = false,
    val selectedQuality: Int = 0,
    val selectedCodec: String = "auto",
    val selectedAudioQuality: String = "auto",
    val selectedOutputMode: String = "video",
    val selectedAttachments: Set<String> = emptySet(),
    val selectedFilter: TaskFilter = TaskFilter.ALL,
    val tasks: List<TaskItem> = emptyList(),
    val inspectedVideo: InspectedVideo? = null,
    val selectedCids: Set<Long> = emptySet(),
    val settings: EngineSettingsState = EngineSettingsState(),
    val toolbox: ToolboxUiState = ToolboxUiState()
)

class MainScreenViewModel(
    dataRepository: DataRepository = DefaultDataRepository()
) : ViewModel() {

    val uiState: StateFlow<MainScreenUiState> =
        dataRepository.data
            .map<List<String>, MainScreenUiState>(::Success)
            .catch { emit(MainScreenUiState.Error(it)) }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), MainScreenUiState.Loading)

    private val _benchState = MutableStateFlow(BenchUiState())
    val benchState: StateFlow<BenchUiState> = _benchState.asStateFlow()

    private var rpcClient: BewlyRpcClient? = null
    private var pollJob: Job? = null
    private var appContext: Context? = null
    private var isForeground: Boolean = true

    companion object {
        private val ACTIVE_STATUSES = setOf(
            "downloading", "queued", "resolving", "muxing", "postprocessing"
        )

        /**
         * Extracts a Bilibili BV/AV ID or URL from raw clipboard / shared text.
         */
        fun extractBiliTarget(raw: String): String {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return ""

            val bvRegex = Regex("""BV[0-9A-Za-z]{10}""", RegexOption.IGNORE_CASE)
            val bvMatch = bvRegex.find(trimmed)
            if (bvMatch != null) {
                return bvMatch.value
            }

            val urlRegex = Regex("""https?://[^\s"<>\u4e00-\u9fa5]+""")
            val urlMatch = urlRegex.find(trimmed)
            if (urlMatch != null) {
                return urlMatch.value
            }

            return trimmed
        }
    }

    fun extractBiliTarget(raw: String): String = Companion.extractBiliTarget(raw)

    fun onVideoInputChange(input: String) {
        _benchState.update { it.copy(videoInput = input) }
    }

    fun onClearVideoInput() {
        _benchState.update { it.copy(videoInput = "") }
    }

    fun onPasteClipboard(clipboardText: String) {
        val extracted = extractBiliTarget(clipboardText)
        if (extracted.isNotEmpty()) {
            _benchState.update {
                it.copy(
                    videoInput = extracted,
                    statusMessage = "已从剪贴板识别: $extracted"
                )
            }
        } else {
            _benchState.update {
                it.copy(statusMessage = "剪贴板未识别到有效链接或 BV 号")
            }
        }
    }

    fun handleIncomingSharedText(context: Context, sharedText: String) {
        appContext = context.applicationContext
        val extracted = extractBiliTarget(sharedText)
        if (extracted.isNotEmpty()) {
            _benchState.update {
                it.copy(
                    videoInput = extracted,
                    statusMessage = "已接收分享链接: $extracted，正在解析..."
                )
            }
            inspectVideo(context, extracted)
        }
    }

    fun setForegroundActive(active: Boolean) {
        isForeground = active
        if (active) {
            if (rpcClient != null) {
                startPollingTasks()
            }
        } else {
            pollJob?.cancel()
            pollJob = null
        }
    }

    fun setQuality(quality: Int) {
        _benchState.update { it.copy(selectedQuality = quality) }
    }

    fun setCodec(codec: String) {
        _benchState.update { it.copy(selectedCodec = codec) }
    }

    fun setAudioQuality(audioQuality: String) {
        _benchState.update { it.copy(selectedAudioQuality = audioQuality) }
    }

    fun setOutputMode(mode: String) {
        _benchState.update { it.copy(selectedOutputMode = mode) }
    }

    fun toggleAttachment(key: String) {
        _benchState.update { state ->
            val next = state.selectedAttachments.toMutableSet()
            if (!next.add(key)) next.remove(key)
            state.copy(selectedAttachments = next)
        }
    }

    fun setFilter(filter: TaskFilter) {
        _benchState.update { it.copy(selectedFilter = filter) }
    }

    fun toggleDiagnostics() {
        _benchState.update { it.copy(isDiagnosticsExpanded = !it.isDiagnosticsExpanded) }
    }

    fun setDiagnosticsExpanded(expanded: Boolean) {
        _benchState.update { it.copy(isDiagnosticsExpanded = expanded) }
    }

    fun setCookieDialogVisible(visible: Boolean) {
        _benchState.update { it.copy(isCookieDialogVisible = visible) }
    }

    fun setWebLoginDialogVisible(visible: Boolean) {
        _benchState.update { it.copy(isWebLoginDialogVisible = visible) }
    }

    fun saveSessionCookie(cookie: String) {
        val trimmed = cookie.trim()
        _benchState.update { it.copy(sessionCookie = trimmed) }
        viewModelScope.launch(Dispatchers.IO) {
            val client = rpcClient ?: appContext?.let { getOrRefreshClient(it) }
            if (client != null) {
                when (val res = client.setSession(trimmed)) {
                    is RpcResult.Success -> {
                        _benchState.update {
                            it.copy(
                                isSessionConfigured = trimmed.isNotEmpty(),
                                isCookieDialogVisible = false,
                                isWebLoginDialogVisible = false,
                                statusMessage = if (trimmed.isNotEmpty()) "B 站账号 Cookie 已配置生效" else "已清除 Cookie"
                            )
                        }
                    }
                    is RpcResult.Error -> {
                        _benchState.update {
                            it.copy(statusMessage = "配置 Cookie 失败: ${res.message}")
                        }
                    }
                }
            } else {
                _benchState.update {
                    it.copy(
                        isSessionConfigured = trimmed.isNotEmpty(),
                        isCookieDialogVisible = false,
                        isWebLoginDialogVisible = false,
                        statusMessage = "服务未就绪，将在引擎连接后应用"
                    )
                }
            }
        }
    }

    fun clearStatusMessage() {
        _benchState.update { it.copy(statusMessage = null) }
    }

    fun initAndCheckStatus(context: Context) {
        appContext = context.applicationContext
        val autoExport = MediaStoreExporter.isAutoExportEnabled(context)
        val hasSavedSession = File(context.filesDir, "session.dat").let { it.exists() && it.length() > 0L }
        _benchState.update {
            it.copy(
                isSessionConfigured = it.isSessionConfigured || hasSavedSession,
                settings = it.settings.copy(autoExportPublic = autoExport)
            )
        }
        viewModelScope.launch(Dispatchers.IO) {
            // Retry briefly until both JNI service is running and fresh connection.json responds to health()
            repeat(12) { attempt ->
                checkJniStatus()
                if (BewlyDownloadService.getConnectionInfo(context) != null) {
                    checkServiceAndRpc(context)
                    if (_benchState.value.rpcHealth.startsWith("健康")) {
                        return@launch
                    }
                }
                if (attempt < 11) delay(400)
            }
            checkJniStatus()
            checkServiceAndRpc(context)
        }
    }

    fun checkJniStatus() {
        try {
            val pingRaw = BewlyNative.ping()
            val pingJson = JSONObject(pingRaw)
            val isPong = pingJson.optBoolean("pong", false)
            val isServiceRunning = pingJson.optBoolean("service_running", false)
            _benchState.update {
                it.copy(
                    jniStatus = pingRaw,
                    isJniOk = isPong,
                    isServiceRunning = isServiceRunning
                )
            }
        } catch (e: Throwable) {
            _benchState.update {
                it.copy(
                    jniStatus = "JNI 错误: ${e.message}",
                    isJniOk = false
                )
            }
        }
    }

    private fun resolveDownloadDir(context: Context, autoExport: Boolean): String {
        return if (autoExport) {
            MediaStoreExporter.getStagingDir(context).absolutePath
        } else {
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.absolutePath
                ?: context.filesDir.absolutePath
        }
    }

    fun checkServiceAndRpc(context: Context) {
        appContext = context.applicationContext
        val targetDir = resolveDownloadDir(context, _benchState.value.settings.autoExportPublic)
        _benchState.update { it.copy(downloadDirectory = targetDir) }

        val conn = BewlyDownloadService.getConnectionInfo(context)
        if (conn == null) {
            _benchState.update {
                it.copy(
                    rpcEndpoint = "未找到 connection.json (服务可能正在启动)",
                    rpcHealth = "未启动"
                )
            }
            return
        }

        val port = conn.optInt("port", 0)
        val token = conn.optString("token", "")
        if (port <= 0 || token.isEmpty()) {
            _benchState.update {
                it.copy(
                    rpcEndpoint = "connection.json 内容无效 (port=$port)",
                    rpcHealth = "无效参数"
                )
            }
            return
        }

        val client = BewlyRpcClient(port, token)
        rpcClient = client
        val endpoint = client.baseUrl

        _benchState.update {
            it.copy(
                rpcEndpoint = endpoint,
                isServiceRunning = true
            )
        }

        when (val healthRes = client.health()) {
            is RpcResult.Success -> {
                val healthJson = healthRes.result as? JSONObject
                val settingsObj = healthJson?.optJSONObject("settings")
                val version = healthJson?.optString("version", "") ?: ""
                _benchState.update { state ->
                    val updatedSettings = if (settingsObj != null) {
                        state.settings.copy(
                            maxConcurrent = settingsObj.optInt("maxConcurrent", state.settings.maxConcurrent)
                                .coerceIn(1, 4)
                        )
                    } else state.settings
                    state.copy(
                        rpcHealth = if (version.isNotEmpty()) "健康在线 (v$version)" else "健康在线",
                        settings = updatedSettings
                    )
                }
                client.configure(targetDir)

                val cookie = _benchState.value.sessionCookie
                if (cookie.isNotEmpty()) {
                    client.setSession(cookie)
                }

                if (isForeground) {
                    startPollingTasks()
                }
                fetchTasksNow()
            }
            is RpcResult.Error -> {
                _benchState.update {
                    it.copy(rpcHealth = "连接失败: ${healthRes.message}")
                }
            }
        }
    }

    private fun getOrRefreshClient(context: Context): BewlyRpcClient? {
        val conn = BewlyDownloadService.getConnectionInfo(context)
        if (conn != null) {
            val port = conn.optInt("port", 0)
            val token = conn.optString("token", "")
            if (port > 0 && token.isNotEmpty()) {
                val current = rpcClient
                if (current == null || current.baseUrl != "http://127.0.0.1:$port/rpc") {
                    val newClient = BewlyRpcClient(port, token)
                    rpcClient = newClient
                    _benchState.update {
                        it.copy(
                            rpcEndpoint = newClient.baseUrl,
                            isServiceRunning = true,
                            isJniOk = true,
                            rpcHealth = if (it.rpcHealth.startsWith("健康")) it.rpcHealth else "健康在线"
                        )
                    }
                    if (isForeground && pollJob == null) {
                        startPollingTasks()
                    }
                }
            }
        }
        return rpcClient
    }

    fun restartService(context: Context) {
        viewModelScope.launch(Dispatchers.IO) {
            _benchState.update { it.copy(statusMessage = "正在重启下载服务...") }
            BewlyDownloadService.stop(context)
            delay(600)
            BewlyDownloadService.start(context)
            delay(1000)
            checkJniStatus()
            checkServiceAndRpc(context)
            _benchState.update { it.copy(statusMessage = "服务已重启并重新连接") }
        }
    }

    /**
     * Inspects video metadata and opens the part & options selector sheet.
     */
    fun inspectVideo(context: Context, videoUrl: String = _benchState.value.videoInput) {
        appContext = context.applicationContext
        val extracted = extractBiliTarget(videoUrl).ifEmpty { videoUrl.trim() }
        if (extracted.isEmpty()) {
            _benchState.update { it.copy(statusMessage = "请输入有效的 BV 号或 B 站视频链接") }
            return
        }

        viewModelScope.launch(Dispatchers.IO) {
            _benchState.update { it.copy(isProcessing = true, statusMessage = "正在解析视频: $extracted ...") }
            try {
                val client = getOrRefreshClient(context)
                if (client == null) {
                    _benchState.update {
                        it.copy(
                            isProcessing = false,
                            statusMessage = "下载服务未就绪，请稍后或在设置页重启服务"
                        )
                    }
                    return@launch
                }

                when (val inspectRes = client.inspect(extracted)) {
                    is RpcResult.Success -> {
                        val info = inspectRes.result as? JSONObject
                        if (info == null) {
                            _benchState.update {
                                it.copy(isProcessing = false, statusMessage = "解析视频未返回有效数据")
                            }
                            return@launch
                        }
                        val inspected = parseInspectedVideo(info)
                        if (inspected.pages.isEmpty()) {
                            _benchState.update {
                                it.copy(isProcessing = false, statusMessage = "视频没有可用分 P")
                            }
                            return@launch
                        }
                        val defaultPage = inspected.pages.find { it.page == inspected.requestedPage }
                            ?: inspected.pages.first()
                        _benchState.update {
                            it.copy(
                                isProcessing = false,
                                statusMessage = null,
                                inspectedVideo = inspected,
                                selectedCids = setOf(defaultPage.cid)
                            )
                        }
                    }
                    is RpcResult.Error -> {
                        _benchState.update {
                            it.copy(
                                isProcessing = false,
                                statusMessage = "解析视频失败: ${inspectRes.message}"
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("MainScreenViewModel", "inspectVideo error", e)
                _benchState.update {
                    it.copy(
                        isProcessing = false,
                        statusMessage = "异常: ${e.message}"
                    )
                }
            }
        }
    }

    fun dismissInspectedVideo() {
        _benchState.update { it.copy(inspectedVideo = null, selectedCids = emptySet()) }
    }

    fun toggleCidSelection(cid: Long) {
        _benchState.update { state ->
            val next = state.selectedCids.toMutableSet()
            if (!next.add(cid)) next.remove(cid)
            state.copy(selectedCids = next)
        }
    }

    fun selectAllCids(selectAll: Boolean) {
        _benchState.update { state ->
            val pages = state.inspectedVideo?.pages.orEmpty()
            val next = if (selectAll) pages.map { it.cid }.toSet() else emptySet()
            state.copy(selectedCids = next)
        }
    }

    fun submitInspectedDownload(context: Context, startImmediately: Boolean) {
        val state = _benchState.value
        val inspected = state.inspectedVideo ?: return
        val cids = inspected.pages.map { it.cid }.filter { it in state.selectedCids }
        if (cids.isEmpty()) {
            _benchState.update { it.copy(statusMessage = "请至少选择一个分 P") }
            return
        }

        viewModelScope.launch(Dispatchers.IO) {
            _benchState.update { it.copy(isProcessing = true) }
            val client = getOrRefreshClient(context)
            if (client == null) {
                _benchState.update { it.copy(isProcessing = false, statusMessage = "下载服务未就绪") }
                return@launch
            }
            val targetDir = resolveDownloadDir(context, state.settings.autoExportPublic)
            client.configure(targetDir)

            val outputs = mutableListOf(state.selectedOutputMode)
            for (att in state.selectedAttachments) {
                if (att !in outputs) outputs.add(att)
            }
            val options = JSONObject().apply {
                put("quality", state.selectedQuality)
                put("codec", state.selectedCodec)
                put("audioQuality", state.selectedAudioQuality)
                put("mode", if (state.selectedOutputMode in listOf("audio", "mp3")) "audio" else "video")
                put("outputs", JSONArray().apply { outputs.forEach { put(it) } })
                put("filenameTemplate", state.settings.filenameTemplate)
                put("folderTemplate", state.settings.folderTemplate)
            }

            when (val res = client.createTasks(inspected.rawInfo, cids, options, start = startImmediately)) {
                is RpcResult.Success -> {
                    val actionLabel = if (startImmediately) "加入下载队列" else "加入待下载"
                    val cookieTip = if (startImmediately && !state.isSessionConfigured) {
                        "（未登录将使用游客流：最高 480P / 原生音频）"
                    } else ""
                    _benchState.update {
                        it.copy(
                            isProcessing = false,
                            inspectedVideo = null,
                            selectedCids = emptySet(),
                            videoInput = "",
                            statusMessage = "已将 ${cids.size} 个分 P $actionLabel$cookieTip"
                        )
                    }
                    fetchTasksNow()
                }
                is RpcResult.Error -> {
                    _benchState.update {
                        it.copy(
                            isProcessing = false,
                            statusMessage = "创建任务失败: ${res.message}"
                        )
                    }
                }
            }
        }
    }

    /**
     * Quick single-tap download for a known BV/URL (used by example button).
     */
    fun parseAndDownload(context: Context, videoUrl: String = _benchState.value.videoInput) {
        inspectVideo(context, videoUrl)
    }

    /**
     * Adds an episode from a collection into the download queue directly by inspecting its BV.
     */
    fun switchToCollectionEpisode(context: Context, bvid: String) {
        _benchState.update { it.copy(videoInput = bvid, inspectedVideo = null, selectedCids = emptySet()) }
        inspectVideo(context, bvid)
    }

    fun startPollingTasks() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                fetchTasksNow()
                delay(1500)
            }
        }
    }

    private fun fetchTasksNow() {
        val client = rpcClient ?: return
        val ctx = appContext
        when (val res = client.queryTasks("all", page = 1, pageSize = 100)) {
            is RpcResult.Success -> {
                val json = res.result as? JSONObject ?: return
                val itemsArray = json.optJSONArray("items") ?: JSONArray()
                val list = mutableListOf<TaskItem>()
                for (i in 0 until itemsArray.length()) {
                    val obj = itemsArray.optJSONObject(i) ?: continue
                    val id = obj.optString("id")
                    val status = obj.optString("status", "unknown")
                    val output = obj.optString("output").takeIf { it.isNotEmpty() }
                    val artifactsObj = obj.optJSONObject("artifacts")
                    val artifactsMap = mutableMapOf<String, String>()
                    if (artifactsObj != null) {
                        val keys = artifactsObj.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            val v = artifactsObj.optString(k, "")
                            if (v.isNotEmpty()) artifactsMap[k] = v
                        }
                    }

                    var exported = ctx?.let { MediaStoreExporter.getExportedPrimary(it, id) }
                    if (status == "completed" && ctx != null && exported == null && output != null) {
                        exported = MediaStoreExporter.exportCompletedTaskIfNeeded(ctx, id, output, artifactsMap)
                    }

                    list.add(
                        TaskItem(
                            id = id,
                            title = obj.optString("title", "未命名任务"),
                            bvid = obj.optString("bvid", ""),
                            status = status,
                            progress = obj.optDouble("progress", 0.0),
                            speed = obj.optLong("speed", 0L),
                            downloaded = obj.optLong("downloaded", 0L),
                            total = obj.optLong("total", 0L),
                            error = obj.optString("error", ""),
                            output = output,
                            artifacts = artifactsMap,
                            exportedUri = exported?.uri,
                            exportedDisplay = exported?.displayLocation
                        )
                    )
                }
                _benchState.update {
                    it.copy(
                        tasks = list,
                        isServiceRunning = true,
                        rpcHealth = if (it.rpcHealth.startsWith("健康")) it.rpcHealth else "健康在线"
                    )
                }
            }
            is RpcResult.Error -> {
                // Ignore transient polling errors
            }
        }
    }

    fun startPendingTask(id: String) {
        viewModelScope.launch(Dispatchers.IO) {
            rpcClient?.taskAction(id, "start")
            fetchTasksNow()
        }
    }

    fun pauseTask(id: String) {
        viewModelScope.launch(Dispatchers.IO) {
            rpcClient?.taskAction(id, "pause")
            fetchTasksNow()
        }
    }

    fun resumeTask(id: String) {
        viewModelScope.launch(Dispatchers.IO) {
            rpcClient?.taskAction(id, "resume")
            fetchTasksNow()
        }
    }

    fun retryTask(id: String) {
        viewModelScope.launch(Dispatchers.IO) {
            rpcClient?.taskAction(id, "retry")
            fetchTasksNow()
        }
    }

    fun startAllPending() {
        viewModelScope.launch(Dispatchers.IO) {
            rpcClient?.batchAction(action = "start", all = "pending")
            fetchTasksNow()
        }
    }

    fun pauseAllActive() {
        viewModelScope.launch(Dispatchers.IO) {
            rpcClient?.batchAction(action = "pause", all = "active")
            fetchTasksNow()
        }
    }

    fun deleteTask(context: Context, id: String, status: String, alsoDeleteFiles: Boolean) {
        viewModelScope.launch(Dispatchers.IO) {
            if (status in ACTIVE_STATUSES) {
                rpcClient?.taskAction(id, "pause")
                delay(250)
            }
            if (alsoDeleteFiles) {
                MediaStoreExporter.deleteExportedTaskFiles(context, id)
                rpcClient?.taskAction(id, "deleteFiles")
            }
            rpcClient?.taskAction(id, "remove")
            fetchTasksNow()
        }
    }

    fun clearCompletedTasks() {
        viewModelScope.launch(Dispatchers.IO) {
            rpcClient?.clearCompletedTasks()
            fetchTasksNow()
        }
    }

    // --- Settings Actions ---

    fun updateSettings(
        context: Context,
        maxConcurrent: Int,
        filenameTemplate: String,
        folderTemplate: String,
        autoExportPublic: Boolean
    ) {
        MediaStoreExporter.setAutoExportEnabled(context, autoExportPublic)
        val newDir = resolveDownloadDir(context, autoExportPublic)
        _benchState.update {
            it.copy(
                downloadDirectory = newDir,
                settings = EngineSettingsState(
                    maxConcurrent = maxConcurrent.coerceIn(1, 4),
                    filenameTemplate = filenameTemplate,
                    folderTemplate = folderTemplate,
                    autoExportPublic = autoExportPublic
                )
            )
        }
        viewModelScope.launch(Dispatchers.IO) {
            val client = getOrRefreshClient(context) ?: return@launch
            val patch = JSONObject().apply {
                put("directory", newDir)
                put("maxConcurrent", maxConcurrent.coerceIn(1, 4))
            }
            when (val res = client.configure(patch)) {
                is RpcResult.Success -> {
                    _benchState.update { it.copy(statusMessage = "设置已保存") }
                }
                is RpcResult.Error -> {
                    _benchState.update { it.copy(statusMessage = "保存设置失败: ${res.message}") }
                }
            }
        }
    }

    // --- Toolbox Actions ---

    fun updateConvertInput(text: String) {
        _benchState.update { it.copy(toolbox = it.toolbox.copy(convertInput = text)) }
    }

    fun setSrtLineBreaks(keep: Boolean) {
        _benchState.update { it.copy(toolbox = it.toolbox.copy(srtLineBreaks = keep)) }
    }

    fun setExportFormat(format: String) {
        _benchState.update { it.copy(toolbox = it.toolbox.copy(exportFormat = format)) }
    }

    fun setPickedCcFile(context: Context, uri: Uri?) {
        uri ?: return
        val name = MediaStoreExporter.resolveDisplayName(context, uri) ?: "subtitle.json"
        _benchState.update { it.copy(toolbox = it.toolbox.copy(pickedCcFile = PickedLocalFile(uri, name))) }
    }

    fun setPickedSrtFile(context: Context, uri: Uri?) {
        uri ?: return
        val name = MediaStoreExporter.resolveDisplayName(context, uri) ?: "subtitle.srt"
        _benchState.update { it.copy(toolbox = it.toolbox.copy(pickedSrtFile = PickedLocalFile(uri, name))) }
    }

    fun setPickedAudioFile(context: Context, uri: Uri?) {
        uri ?: return
        val name = MediaStoreExporter.resolveDisplayName(context, uri) ?: "audio.m4a"
        _benchState.update { it.copy(toolbox = it.toolbox.copy(pickedAudioFile = PickedLocalFile(uri, name))) }
    }

    fun setPickedMuxVideo(context: Context, uri: Uri?) {
        uri ?: return
        val name = MediaStoreExporter.resolveDisplayName(context, uri) ?: "video.mp4"
        _benchState.update { it.copy(toolbox = it.toolbox.copy(pickedMuxVideo = PickedLocalFile(uri, name))) }
    }

    fun setPickedMuxAudio(context: Context, uri: Uri?) {
        uri ?: return
        val name = MediaStoreExporter.resolveDisplayName(context, uri) ?: "audio.m4a"
        _benchState.update { it.copy(toolbox = it.toolbox.copy(pickedMuxAudio = PickedLocalFile(uri, name))) }
    }

    fun runConvertId(context: Context) {
        val input = _benchState.value.toolbox.convertInput.trim()
        if (input.isEmpty()) {
            _benchState.update { it.copy(toolbox = it.toolbox.copy(resultMessage = "请输入 BV 号或 AV 号")) }
            return
        }
        viewModelScope.launch(Dispatchers.IO) {
            _benchState.update { it.copy(toolbox = it.toolbox.copy(isBusy = true, resultMessage = null)) }
            val client = getOrRefreshClient(context)
            if (client == null) {
                _benchState.update { it.copy(toolbox = it.toolbox.copy(isBusy = false, resultMessage = "下载服务未就绪")) }
                return@launch
            }
            when (val res = client.tool("convertId", JSONObject().apply { put("input", input) })) {
                is RpcResult.Success -> {
                    val obj = res.result as? JSONObject
                    val status = obj?.optString("status", "")
                    if (status == "completed") {
                        val text = obj.optString("text", "")
                        _benchState.update {
                            it.copy(
                                toolbox = it.toolbox.copy(
                                    isBusy = false,
                                    convertResult = text,
                                    resultMessage = "转换成功: $text"
                                )
                            )
                        }
                    } else {
                        val err = obj?.optString("error", "转换失败") ?: "转换失败"
                        _benchState.update { it.copy(toolbox = it.toolbox.copy(isBusy = false, resultMessage = err)) }
                    }
                }
                is RpcResult.Error -> {
                    _benchState.update { it.copy(toolbox = it.toolbox.copy(isBusy = false, resultMessage = res.message)) }
                }
            }
        }
    }

    fun runCcToSrt(context: Context) {
        val picked = _benchState.value.toolbox.pickedCcFile ?: return
        runFileTool(context, "ccToSrt", listOf(picked to ".json")) { tempFiles ->
            JSONObject().apply {
                put("source", tempFiles[0].absolutePath)
                put("directory", MediaStoreExporter.getToolOutputDir(context).absolutePath)
            }
        }
    }

    fun runSrtToText(context: Context) {
        val picked = _benchState.value.toolbox.pickedSrtFile ?: return
        val keepBreaks = _benchState.value.toolbox.srtLineBreaks
        runFileTool(context, "srtToText", listOf(picked to ".srt")) { tempFiles ->
            JSONObject().apply {
                put("source", tempFiles[0].absolutePath)
                put("lineBreaks", keepBreaks)
                put("directory", MediaStoreExporter.getToolOutputDir(context).absolutePath)
            }
        }
    }

    fun runAudioToMp3(context: Context) {
        val picked = _benchState.value.toolbox.pickedAudioFile ?: return
        runFileTool(context, "audioToMp3", listOf(picked to ".m4a")) { tempFiles ->
            JSONObject().apply {
                put("source", tempFiles[0].absolutePath)
                put("directory", MediaStoreExporter.getToolOutputDir(context).absolutePath)
            }
        }
    }

    fun runMux(context: Context) {
        val v = _benchState.value.toolbox.pickedMuxVideo ?: return
        val a = _benchState.value.toolbox.pickedMuxAudio ?: return
        runFileTool(context, "mux", listOf(v to ".mp4", a to ".m4a")) { tempFiles ->
            JSONObject().apply {
                put("video", tempFiles[0].absolutePath)
                put("audio", tempFiles[1].absolutePath)
                put("directory", MediaStoreExporter.getToolOutputDir(context).absolutePath)
            }
        }
    }

    fun runExportHistory(context: Context) {
        val fmt = _benchState.value.toolbox.exportFormat
        runFileTool(context, "exportHistory", emptyList()) {
            JSONObject().apply {
                if (fmt != "bilidown") put("format", fmt)
                put("directory", MediaStoreExporter.getToolOutputDir(context).absolutePath)
            }
        }
    }

    private fun runFileTool(
        context: Context,
        op: String,
        inputs: List<Pair<PickedLocalFile, String>>,
        buildParams: (List<File>) -> JSONObject
    ) {
        viewModelScope.launch(Dispatchers.IO) {
            _benchState.update {
                it.copy(
                    toolbox = it.toolbox.copy(
                        isBusy = true,
                        resultMessage = "正在处理...",
                        resultFileUri = null,
                        resultFileDisplay = null
                    )
                )
            }
            val tempFiles = mutableListOf<File>()
            try {
                val client = getOrRefreshClient(context)
                if (client == null) {
                    _benchState.update { it.copy(toolbox = it.toolbox.copy(isBusy = false, resultMessage = "下载服务未就绪")) }
                    return@launch
                }
                for ((picked, fallbackExt) in inputs) {
                    val copied = MediaStoreExporter.copyDocumentUriToTempFile(context, picked.uri, fallbackExt)
                    if (copied == null) {
                        _benchState.update { it.copy(toolbox = it.toolbox.copy(isBusy = false, resultMessage = "无法读取所选文件: ${picked.name}")) }
                        return@launch
                    }
                    tempFiles.add(copied)
                }

                when (val res = client.tool(op, buildParams(tempFiles))) {
                    is RpcResult.Success -> {
                        val obj = res.result as? JSONObject
                        val outPath = obj?.optString("path", "") ?: ""
                        if (outPath.isNotEmpty()) {
                            val outFile = File(outPath)
                            val exported = MediaStoreExporter.exportToolFile(context, outFile)
                            _benchState.update {
                                it.copy(
                                    toolbox = it.toolbox.copy(
                                        isBusy = false,
                                        resultMessage = if (exported != null) {
                                            "处理完成！已保存到 ${exported.displayLocation}"
                                        } else {
                                            "处理完成！输出路径: $outPath"
                                        },
                                        resultFileUri = exported?.uri ?: outPath,
                                        resultFileDisplay = exported?.displayLocation ?: outPath,
                                        resultFileMime = exported?.mimeType ?: MediaStoreExporter.mimeTypeFor(outFile.name)
                                    )
                                )
                            }
                        } else {
                            _benchState.update { it.copy(toolbox = it.toolbox.copy(isBusy = false, resultMessage = "操作完成")) }
                        }
                    }
                    is RpcResult.Error -> {
                        _benchState.update { it.copy(toolbox = it.toolbox.copy(isBusy = false, resultMessage = "处理失败: ${res.message}")) }
                    }
                }
            } finally {
                tempFiles.forEach { it.delete() }
            }
        }
    }

    private fun parseInspectedVideo(info: JSONObject): InspectedVideo {
        val pagesJson = info.optJSONArray("pages") ?: JSONArray()
        val pages = mutableListOf<VideoPageItem>()
        for (i in 0 until pagesJson.length()) {
            val p = pagesJson.optJSONObject(i) ?: continue
            pages.add(
                VideoPageItem(
                    cid = p.optLong("cid", 0L),
                    page = p.optInt("page", i + 1),
                    title = p.optString("title", "P${i + 1}").ifEmpty { "P${i + 1}" },
                    duration = p.optLong("duration", 0L)
                )
            )
        }
        val collectionJson = info.optJSONObject("collection")
        val sections = mutableListOf<CollectionSectionItem>()
        if (collectionJson != null) {
            val secArr = collectionJson.optJSONArray("sections") ?: JSONArray()
            for (sIdx in 0 until secArr.length()) {
                val sObj = secArr.optJSONObject(sIdx) ?: continue
                val videosArr = sObj.optJSONArray("videos") ?: JSONArray()
                val videos = mutableListOf<CollectionVideoItem>()
                for (vIdx in 0 until videosArr.length()) {
                    val vObj = videosArr.optJSONObject(vIdx) ?: continue
                    videos.add(
                        CollectionVideoItem(
                            bvid = vObj.optString("bvid", ""),
                            cid = vObj.optLong("cid", 0L),
                            title = vObj.optString("title", ""),
                            available = vObj.optBoolean("available", true)
                        )
                    )
                }
                sections.add(
                    CollectionSectionItem(
                        title = sObj.optString("title", "正片"),
                        videos = videos
                    )
                )
            }
        }
        return InspectedVideo(
            rawInfo = info,
            bvid = info.optString("bvid", ""),
            title = info.optString("title", "未命名视频"),
            author = info.optString("author", ""),
            requestedPage = info.optInt("requestedPage", 1),
            pages = pages,
            collectionTitle = collectionJson?.optString("title")?.takeIf { it.isNotEmpty() },
            collectionSections = sections
        )
    }
}

sealed interface MainScreenUiState {
    object Loading : MainScreenUiState
    data class Error(val throwable: Throwable) : MainScreenUiState
    data class Success(val data: List<String>) : MainScreenUiState
}
