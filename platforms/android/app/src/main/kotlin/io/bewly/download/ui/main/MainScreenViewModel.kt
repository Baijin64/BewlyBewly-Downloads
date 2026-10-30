package io.bewly.download.ui.main

import android.content.Context
import android.os.Environment
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.bewly.download.BewlyDownloadService
import io.bewly.download.BewlyNative
import io.bewly.download.BewlyRpcClient
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
    val output: String?
)

enum class TaskFilter(val label: String) {
    ALL("全部"),
    ACTIVE("下载中"),
    COMPLETED("已完成"),
    FAILED("失败")
}

data class QualityOption(
    val quality: Int,
    val label: String
)

data class OutputOption(
    val mode: String,
    val label: String
)

val AVAILABLE_QUALITIES = listOf(
    QualityOption(80, "1080P 高清"),
    QualityOption(120, "4K 超清"),
    QualityOption(64, "720P"),
    QualityOption(32, "480P")
)

val AVAILABLE_OUTPUTS = listOf(
    OutputOption("video", "视频 (MP4)"),
    OutputOption("audio", "仅音频 (M4A)")
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
    val sessionCookie: String = "",
    val isSessionConfigured: Boolean = false,
    val selectedQuality: Int = 80,
    val selectedOutputMode: String = "video",
    val selectedFilter: TaskFilter = TaskFilter.ALL,
    val tasks: List<TaskItem> = emptyList()
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

    companion object {
        /**
         * Extracts a Bilibili BV ID or URL from raw clipboard / shared text.
         * 1. Matches BV[0-9A-Za-z]{10} anywhere in raw.
         * 2. Otherwise matches http(s) URL in raw.
         * 3. Otherwise returns raw.trim().
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

    fun setQuality(quality: Int) {
        _benchState.update { it.copy(selectedQuality = quality) }
    }

    fun setOutputMode(mode: String) {
        _benchState.update { it.copy(selectedOutputMode = mode) }
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

    fun onSessionCookieChange(cookie: String) {
        _benchState.update { it.copy(sessionCookie = cookie) }
    }

    fun saveSessionCookie(cookie: String) {
        val trimmed = cookie.trim()
        _benchState.update { it.copy(sessionCookie = trimmed) }
        viewModelScope.launch(Dispatchers.IO) {
            val client = rpcClient
            if (client != null) {
                when (val res = client.setSession(trimmed)) {
                    is RpcResult.Success -> {
                        _benchState.update {
                            it.copy(
                                isSessionConfigured = trimmed.isNotEmpty(),
                                isCookieDialogVisible = false,
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
        viewModelScope.launch(Dispatchers.IO) {
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

    fun checkServiceAndRpc(context: Context) {
        val targetDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.absolutePath
            ?: context.filesDir.absolutePath
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

        // Test RPC health
        when (val healthRes = client.health()) {
            is RpcResult.Success -> {
                _benchState.update {
                    it.copy(rpcHealth = "健康在线 (${healthRes.result})")
                }
                client.configure(targetDir)

                val cookie = _benchState.value.sessionCookie
                if (cookie.isNotEmpty()) {
                    client.setSession(cookie)
                }

                startPollingTasks()
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
                if (current == null || current.baseUrl != "http://127.0.0.1:$port") {
                    val newClient = BewlyRpcClient(port, token)
                    rpcClient = newClient
                    _benchState.update {
                        it.copy(
                            rpcEndpoint = newClient.baseUrl,
                            isServiceRunning = true
                        )
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
            delay(500)
            BewlyDownloadService.start(context)
            delay(1000)
            checkJniStatus()
            checkServiceAndRpc(context)
            _benchState.update { it.copy(statusMessage = "服务重启请求已发送") }
        }
    }

    fun parseAndDownload(context: Context, videoUrl: String = _benchState.value.videoInput) {
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
                            statusMessage = "下载服务未就绪，请稍后重试或在右上角诊断中重启服务"
                        )
                    }
                    return@launch
                }
                val targetDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.absolutePath
                    ?: context.filesDir.absolutePath
                client.configure(targetDir)

                when (val inspectRes = client.inspect(extracted)) {
                    is RpcResult.Success -> {
                        val info = inspectRes.result as? JSONObject
                        if (info == null) {
                            _benchState.update {
                                it.copy(isProcessing = false, statusMessage = "解析视频未返回有效数据")
                            }
                            return@launch
                        }

                        val title = info.optString("title", "未命名视频")
                        val pages = info.optJSONArray("pages")
                        if (pages == null || pages.length() == 0) {
                            _benchState.update {
                                it.copy(isProcessing = false, statusMessage = "视频没有可用分 P")
                            }
                            return@launch
                        }

                        val firstCid = pages.getJSONObject(0).optLong("cid", 0L)
                        _benchState.update {
                            it.copy(statusMessage = "已解析: $title (CID: $firstCid)，正在创建下载任务...")
                        }

                        val currentQuality = _benchState.value.selectedQuality
                        val currentMode = _benchState.value.selectedOutputMode
                        val options = JSONObject().apply {
                            put("quality", currentQuality)
                            put("codec", "auto")
                            put("audioQuality", "auto")
                            put("mode", if (currentMode == "audio") "audio" else "video")
                            put("outputs", JSONArray().apply { put(currentMode) })
                        }

                        when (val createRes = client.createTasks(info, listOf(firstCid), options)) {
                            is RpcResult.Success -> {
                                _benchState.update {
                                    it.copy(
                                        isProcessing = false,
                                        videoInput = "",
                                        statusMessage = "任务「$title」已成功加入下载队列！"
                                    )
                                }
                                fetchTasksNow()
                            }
                            is RpcResult.Error -> {
                                _benchState.update {
                                    it.copy(
                                        isProcessing = false,
                                        statusMessage = "创建任务失败: ${createRes.message}"
                                    )
                                }
                            }
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
                Log.e("MainScreenViewModel", "parseAndDownload error", e)
                _benchState.update {
                    it.copy(
                        isProcessing = false,
                        statusMessage = "异常: ${e.message}"
                    )
                }
            }
        }
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
        when (val res = client.queryTasks("all")) {
            is RpcResult.Success -> {
                val json = res.result as? JSONObject ?: return
                val itemsArray = json.optJSONArray("items") ?: JSONArray()
                val list = mutableListOf<TaskItem>()
                for (i in 0 until itemsArray.length()) {
                    val obj = itemsArray.optJSONObject(i) ?: continue
                    list.add(
                        TaskItem(
                            id = obj.optString("id"),
                            title = obj.optString("title", "未命名任务"),
                            bvid = obj.optString("bvid", ""),
                            status = obj.optString("status", "unknown"),
                            progress = obj.optDouble("progress", 0.0),
                            speed = obj.optLong("speed", 0L),
                            downloaded = obj.optLong("downloaded", 0L),
                            total = obj.optLong("total", 0L),
                            error = obj.optString("error", ""),
                            output = obj.optString("output").takeIf { it.isNotEmpty() }
                        )
                    )
                }
                _benchState.update { it.copy(tasks = list) }
            }
            is RpcResult.Error -> {
                // Ignore transient polling errors
            }
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

    fun deleteTask(id: String, status: String) {
        viewModelScope.launch(Dispatchers.IO) {
            if (status != "paused" && status != "failed" && status != "completed" && status != "cancelled") {
                rpcClient?.taskAction(id, "pause")
                delay(200)
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
}

sealed interface MainScreenUiState {
    object Loading : MainScreenUiState
    data class Error(val throwable: Throwable) : MainScreenUiState
    data class Success(val data: List<String>) : MainScreenUiState
}
