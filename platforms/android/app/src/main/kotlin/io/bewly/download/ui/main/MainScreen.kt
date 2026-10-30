package io.bewly.download.ui.main

import android.content.Context
import android.content.Intent
import android.media.MediaScannerConnection
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.NavKey
import io.bewly.download.data.DefaultDataRepository
import io.bewly.download.ui.theme.BiliBlue
import io.bewly.download.ui.theme.BiliPink
import io.bewly.download.ui.theme.BewlyBewlyTheme
import java.util.Locale

@Composable
fun MainScreen(
    onItemClick: (NavKey) -> Unit = {},
    modifier: Modifier = Modifier,
    viewModel: MainScreenViewModel = viewModel { MainScreenViewModel(DefaultDataRepository()) },
) {
    val context = LocalContext.current
    val benchState by viewModel.benchState.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) {
        viewModel.initAndCheckStatus(context)
    }

    MainScreenContent(
        benchState = benchState,
        onVideoInputChange = viewModel::onVideoInputChange,
        onClearVideoInput = viewModel::onClearVideoInput,
        onPasteClipboard = viewModel::onPasteClipboard,
        onSelectQuality = viewModel::setQuality,
        onSelectOutputMode = viewModel::setOutputMode,
        onSelectFilter = viewModel::setFilter,
        onToggleDiagnostics = viewModel::toggleDiagnostics,
        onSetDiagnosticsExpanded = viewModel::setDiagnosticsExpanded,
        onSetCookieDialogVisible = viewModel::setCookieDialogVisible,
        onSaveSessionCookie = viewModel::saveSessionCookie,
        onRefreshStatus = { viewModel.initAndCheckStatus(context) },
        onRestartService = { viewModel.restartService(context) },
        onParseAndDownload = { viewModel.parseAndDownload(context, benchState.videoInput) },
        onTestDownload = {
            viewModel.onVideoInputChange("BV1xx411c7mD")
            viewModel.parseAndDownload(context, "BV1xx411c7mD")
        },
        onPauseTask = viewModel::pauseTask,
        onResumeTask = viewModel::resumeTask,
        onRetryTask = viewModel::retryTask,
        onDeleteTask = viewModel::deleteTask,
        onClearCompletedTasks = viewModel::clearCompletedTasks,
        onDismissStatusMessage = viewModel::clearStatusMessage,
        modifier = modifier
    )
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun MainScreenContent(
    benchState: BenchUiState,
    onVideoInputChange: (String) -> Unit,
    onClearVideoInput: () -> Unit = {},
    onPasteClipboard: (String) -> Unit = {},
    onSelectQuality: (Int) -> Unit = {},
    onSelectOutputMode: (String) -> Unit = {},
    onSelectFilter: (TaskFilter) -> Unit = {},
    onToggleDiagnostics: () -> Unit = {},
    onSetDiagnosticsExpanded: (Boolean) -> Unit = {},
    onSetCookieDialogVisible: (Boolean) -> Unit = {},
    onSaveSessionCookie: (String) -> Unit = {},
    onRefreshStatus: () -> Unit,
    onRestartService: () -> Unit,
    onParseAndDownload: () -> Unit,
    onTestDownload: () -> Unit,
    onPauseTask: (String) -> Unit,
    onResumeTask: (String) -> Unit,
    onRetryTask: (String) -> Unit = onResumeTask,
    onDeleteTask: (String, String) -> Unit,
    onClearCompletedTasks: () -> Unit = {},
    onDismissStatusMessage: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val clipboardManager = LocalClipboardManager.current

    // Cookie configuration dialog
    if (benchState.isCookieDialogVisible) {
        CookieDialog(
            currentCookie = benchState.sessionCookie,
            onSave = onSaveSessionCookie,
            onDismiss = { onSetCookieDialogVisible(false) }
        )
    }

    Scaffold(
        modifier = modifier,
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = "BewlyBewly 下载",
                            fontWeight = FontWeight.Bold,
                            fontSize = 18.sp
                        )
                        Text(
                            text = "Rust 高速分片引擎",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                actions = {
                    val isHealthy = benchState.isJniOk && benchState.isServiceRunning
                    val statusText = if (isHealthy) "引擎在线" else "点击诊断"
                    val dotColor = if (isHealthy) Color(0xFF2E7D32) else Color(0xFFE65100)
                    val bgTint = if (isHealthy) Color(0xFFE8F5E9) else Color(0xFFFFF3E0)

                    Surface(
                        onClick = onToggleDiagnostics,
                        shape = RoundedCornerShape(16.dp),
                        color = bgTint,
                        modifier = Modifier.padding(end = 12.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .background(dotColor, CircleShape)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = statusText,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = dotColor
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    titleContentColor = MaterialTheme.colorScheme.onSurface
                )
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Collapsible Engine Diagnostics Card (Hidden by default when healthy)
            AnimatedVisibility(
                visible = benchState.isDiagnosticsExpanded,
                enter = fadeIn(),
                exit = fadeOut()
            ) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surface
                    ),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                "引擎运行状态与诊断",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                            IconButton(
                                onClick = { onSetDiagnosticsExpanded(false) },
                                modifier = Modifier.size(28.dp)
                            ) {
                                Text(
                                    "✕",
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }

                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Column(
                                modifier = Modifier.padding(12.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                Text(
                                    "JNI Ping: ${benchState.jniStatus}",
                                    style = MaterialTheme.typography.bodySmall,
                                    fontFamily = FontFamily.Monospace
                                )
                                Text(
                                    "RPC 端点: ${benchState.rpcEndpoint}",
                                    style = MaterialTheme.typography.bodySmall,
                                    fontFamily = FontFamily.Monospace
                                )
                                Text(
                                    "RPC 健康: ${benchState.rpcHealth}",
                                    style = MaterialTheme.typography.bodySmall,
                                    fontWeight = FontWeight.Medium,
                                    color = if (benchState.rpcHealth.contains("在线") || benchState.rpcHealth.contains("ok"))
                                        Color(0xFF2E7D32) else MaterialTheme.colorScheme.error
                                )
                                if (benchState.downloadDirectory.isNotEmpty()) {
                                    Text(
                                        "存储路径: ${benchState.downloadDirectory}",
                                        style = MaterialTheme.typography.bodySmall,
                                        fontFamily = FontFamily.Monospace
                                    )
                                }
                                Text(
                                    "账号 Cookie: ${if (benchState.isSessionConfigured) "已配置" else "未配置 (普通清晰度)"}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (benchState.isSessionConfigured) BiliPink else MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.End
                        ) {
                            OutlinedButton(
                                onClick = onRefreshStatus,
                                modifier = Modifier.padding(end = 8.dp)
                            ) {
                                Text("刷新状态")
                            }
                            FilledTonalButton(
                                onClick = onRestartService
                            ) {
                                Text("重启引擎服务")
                            }
                        }
                    }
                }
            }

            // Card 1: 新建下载
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surface
                ),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            "新建下载",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            TextButton(
                                onClick = onTestDownload,
                                enabled = !benchState.isProcessing
                            ) {
                                Text("⚡ 一键示例", fontSize = 13.sp)
                            }
                            TextButton(
                                onClick = { onSetCookieDialogVisible(true) }
                            ) {
                                Text(
                                    if (benchState.isSessionConfigured) "🔑 Cookie(已配置)" else "🔑 账号 Cookie",
                                    fontSize = 13.sp,
                                    color = if (benchState.isSessionConfigured) BiliPink else MaterialTheme.colorScheme.primary
                                )
                            }
                        }
                    }

                    // Input TextField
                    OutlinedTextField(
                        value = benchState.videoInput,
                        onValueChange = onVideoInputChange,
                        placeholder = {
                            Text(
                                "粘贴 B 站分享口令、视频链接或 BV 号",
                                fontSize = 14.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                            )
                        },
                        trailingIcon = {
                            if (benchState.videoInput.isNotEmpty()) {
                                IconButton(onClick = onClearVideoInput) {
                                    Text(
                                        "✕",
                                        fontSize = 15.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        },
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = MaterialTheme.colorScheme.primary,
                            unfocusedBorderColor = MaterialTheme.colorScheme.outline
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    // Action buttons: Paste & Recognize + Immediate Download
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        OutlinedButton(
                            onClick = {
                                val clipText = clipboardManager.getText()?.text.orEmpty()
                                onPasteClipboard(clipText)
                            },
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("📋 粘贴并识别", fontWeight = FontWeight.Medium)
                        }

                        Button(
                            onClick = onParseAndDownload,
                            enabled = !benchState.isProcessing && benchState.videoInput.isNotBlank(),
                            shape = RoundedCornerShape(12.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.primary,
                                contentColor = MaterialTheme.colorScheme.onPrimary
                            ),
                            modifier = Modifier.weight(1f)
                        ) {
                            if (benchState.isProcessing) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = MaterialTheme.colorScheme.onPrimary
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                            }
                            Text("立即下载", fontWeight = FontWeight.Bold)
                        }
                    }

                    // Quality & Output Selection Chips
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        // Quality Chips
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(
                                "画质:",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(end = 4.dp)
                            )
                            AVAILABLE_QUALITIES.forEach { item ->
                                val selected = benchState.selectedQuality == item.quality
                                FilterChip(
                                    selected = selected,
                                    onClick = { onSelectQuality(item.quality) },
                                    label = { Text(item.label, fontSize = 12.sp) },
                                    colors = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                                        selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer
                                    ),
                                    shape = RoundedCornerShape(8.dp)
                                )
                            }
                        }

                        // Mode Chips
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(
                                "模式:",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(end = 4.dp)
                            )
                            AVAILABLE_OUTPUTS.forEach { item ->
                                val selected = benchState.selectedOutputMode == item.mode
                                FilterChip(
                                    selected = selected,
                                    onClick = { onSelectOutputMode(item.mode) },
                                    label = { Text(item.label, fontSize = 12.sp) },
                                    colors = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = MaterialTheme.colorScheme.secondaryContainer,
                                        selectedLabelColor = MaterialTheme.colorScheme.onSecondaryContainer
                                    ),
                                    shape = RoundedCornerShape(8.dp)
                                )
                            }
                        }
                    }

                    // Status / Feedback Banner
                    benchState.statusMessage?.let { msg ->
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
                            ) {
                                Text(
                                    text = msg,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                                    modifier = Modifier.weight(1f)
                                )
                                IconButton(
                                    onClick = onDismissStatusMessage,
                                    modifier = Modifier.size(24.dp)
                                ) {
                                    Text(
                                        "✕",
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = MaterialTheme.colorScheme.onPrimaryContainer
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Card 2: 任务管理器与分类列表
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surface
                ),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    val allTasks = benchState.tasks
                    val activeCount = allTasks.count {
                        it.status in listOf("downloading", "queued", "resolving", "muxing", "postprocessing", "pending")
                    }
                    val completedCount = allTasks.count { it.status == "completed" }
                    val failedCount = allTasks.count { it.status in listOf("failed", "cancelled") }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            "下载任务管理",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        if (completedCount > 0) {
                            TextButton(onClick = onClearCompletedTasks) {
                                Text("清理已完成", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }

                    // Category Tabs
                    val filters = listOf(
                        TaskFilter.ALL to "全部 (${allTasks.size})",
                        TaskFilter.ACTIVE to "下载中 ($activeCount)",
                        TaskFilter.COMPLETED to "已完成 ($completedCount)",
                        TaskFilter.FAILED to "失败 ($failedCount)"
                    )
                    val selectedIndex = filters.indexOfFirst { it.first == benchState.selectedFilter }.coerceAtLeast(0)

                    PrimaryTabRow(
                        selectedTabIndex = selectedIndex,
                        containerColor = Color.Transparent,
                        contentColor = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        filters.forEachIndexed { index, (filter, label) ->
                            Tab(
                                selected = selectedIndex == index,
                                onClick = { onSelectFilter(filter) },
                                text = {
                                    Text(
                                        text = label,
                                        fontSize = 13.sp,
                                        fontWeight = if (selectedIndex == index) FontWeight.Bold else FontWeight.Normal
                                    )
                                }
                            )
                        }
                    }

                    // Filtered Task List
                    val filteredTasks = when (benchState.selectedFilter) {
                        TaskFilter.ALL -> allTasks
                        TaskFilter.ACTIVE -> allTasks.filter {
                            it.status in listOf("downloading", "queued", "resolving", "muxing", "postprocessing", "pending")
                        }
                        TaskFilter.COMPLETED -> allTasks.filter { it.status == "completed" }
                        TaskFilter.FAILED -> allTasks.filter { it.status in listOf("failed", "cancelled") }
                    }

                    if (filteredTasks.isEmpty()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 32.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(
                                    text = when (benchState.selectedFilter) {
                                        TaskFilter.ALL -> "暂无任务，粘贴 B 站链接开始高速下载"
                                        TaskFilter.ACTIVE -> "当前没有正在下载的任务"
                                        TaskFilter.COMPLETED -> "暂无已完成的下载任务"
                                        TaskFilter.FAILED -> "太棒了，没有下载失败的任务"
                                    },
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    } else {
                        filteredTasks.forEach { task ->
                            TaskItemCard(
                                task = task,
                                onPause = { onPauseTask(task.id) },
                                onResume = { onResumeTask(task.id) },
                                onRetry = { onRetryTask(task.id) },
                                onDelete = { onDeleteTask(task.id, task.status) },
                                onCopyPath = { path ->
                                    clipboardManager.setText(AnnotatedString(path))
                                    Toast.makeText(context, "路径已复制到剪贴板", Toast.LENGTH_SHORT).show()
                                },
                                onOpenFile = { path ->
                                    openMediaFile(context, path)
                                }
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun TaskItemCard(
    task: TaskItem,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onRetry: () -> Unit,
    onDelete: () -> Unit,
    onCopyPath: (String) -> Unit,
    onOpenFile: (String) -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f)
        ),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // Title & Status Badge
            Row(
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = task.title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .padding(end = 8.dp)
                )
                StatusChip(status = task.status)
            }

            // Subtitle: BV ID badge + Downloaded / Total size
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth()
            ) {
                if (task.bvid.isNotEmpty()) {
                    Surface(
                        shape = RoundedCornerShape(6.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant
                    ) {
                        Text(
                            text = task.bvid,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                        )
                    }
                }
                Text(
                    text = "${formatBytes(task.downloaded)} / ${formatBytes(task.total)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Progress Bar & Speed (for active or partial downloads)
            val progressFraction = (task.progress / 100.0).toFloat().coerceIn(0f, 1f)
            LinearProgressIndicator(
                progress = { progressFraction },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(8.dp)
                    .clip(RoundedCornerShape(4.dp)),
                color = when (task.status) {
                    "completed" -> Color(0xFF2E7D32)
                    "failed" -> MaterialTheme.colorScheme.error
                    else -> MaterialTheme.colorScheme.primary
                },
                trackColor = MaterialTheme.colorScheme.surfaceVariant
            )

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = "${String.format(Locale.US, "%.1f", task.progress)}%",
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
                if (task.status == "downloading") {
                    Text(
                        text = "🚀 ${formatSpeed(task.speed)}",
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                        color = BiliBlue
                    )
                }
            }

            // Success banner when completed
            if (task.status == "completed" && !task.output.isNullOrEmpty()) {
                val outPath = task.output
                val fileName = outPath.substringAfterLast('/')
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = Color(0xFFE8F5E9),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Text(
                            text = "✓ $fileName",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.SemiBold,
                            color = Color(0xFF1B5E20),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.End,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            TextButton(
                                onClick = { onCopyPath(outPath) },
                                modifier = Modifier.padding(end = 6.dp)
                            ) {
                                Text("复制路径", fontSize = 11.sp, color = Color(0xFF1B5E20))
                            }
                            Button(
                                onClick = { onOpenFile(outPath) },
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D32)),
                                shape = RoundedCornerShape(8.dp)
                            ) {
                                Text("▶ 播放 / 打开", fontSize = 11.sp, color = Color.White)
                            }
                        }
                    }
                }
            }

            // Error banner when failed
            if (task.status == "failed" || task.error.isNotEmpty()) {
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = Color(0xFFFFECEB),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = "失败原因: ${task.error.ifEmpty { "下载中断或网络异常" }}",
                        style = MaterialTheme.typography.labelSmall,
                        color = Color(0xFFB71C1C),
                        modifier = Modifier.padding(8.dp)
                    )
                }
            }

            // Action Buttons
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                when (task.status) {
                    "downloading", "queued", "resolving", "muxing", "postprocessing" -> {
                        OutlinedButton(
                            onClick = onPause,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.padding(end = 8.dp)
                        ) {
                            Text("暂停", fontSize = 12.sp)
                        }
                    }
                    "paused" -> {
                        FilledTonalButton(
                            onClick = onResume,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.padding(end = 8.dp)
                        ) {
                            Text("继续", fontSize = 12.sp)
                        }
                    }
                    "failed", "cancelled" -> {
                        FilledTonalButton(
                            onClick = onRetry,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.padding(end = 8.dp)
                        ) {
                            Text("重试", fontSize = 12.sp)
                        }
                    }
                }

                Button(
                    onClick = onDelete,
                    shape = RoundedCornerShape(8.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.8f),
                        contentColor = MaterialTheme.colorScheme.onErrorContainer
                    )
                ) {
                    Text("删除", fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
fun StatusChip(status: String) {
    val (label, bg, fg) = when (status) {
        "downloading" -> Triple("下载中", Color(0xFFE1F5FE), Color(0xFF007BB2))
        "resolving" -> Triple("解析中", Color(0xFFFFF3E0), Color(0xFFE65100))
        "muxing" -> Triple("合成中", Color(0xFFEDE7F6), Color(0xFF5E35B1))
        "postprocessing" -> Triple("整理中", Color(0xFFE0F2F1), Color(0xFF00695C))
        "completed" -> Triple("已完成", Color(0xFFE8F5E9), Color(0xFF2E7D32))
        "paused" -> Triple("已暂停", Color(0xFFECEFF1), Color(0xFF546E7A))
        "failed" -> Triple("失败", Color(0xFFFFEBEE), Color(0xFFC62828))
        "cancelled" -> Triple("已取消", Color(0xFFEEEEEE), Color(0xFF757575))
        "queued" -> Triple("排队中", Color(0xFFFFF8E1), Color(0xFFF57F17))
        else -> Triple(status, Color(0xFFF5F5F5), Color(0xFF616161))
    }

    Box(
        modifier = Modifier
            .background(bg, shape = RoundedCornerShape(8.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Text(
            text = label,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = fg
        )
    }
}

@Composable
fun CookieDialog(
    currentCookie: String,
    onSave: (String) -> Unit,
    onDismiss: () -> Unit
) {
    var text by remember { mutableStateOf(currentCookie) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text("B 站账号 Cookie (可选)", fontWeight = FontWeight.Bold)
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = "输入 SESSDATA=... 或完整 Cookie，可解锁大会员 1080P60 / 4K 超清画质与专享视频。\nCookie 仅保存在本地设备 Rust 引擎沙盒，绝不上报。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text("粘贴 SESSDATA=xxxx 或完整 Cookie", fontSize = 12.sp) },
                    singleLine = false,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(8.dp)
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onSave(text) },
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
            ) {
                Text("保存并应用")
            }
        },
        dismissButton = {
            Row {
                if (currentCookie.isNotEmpty()) {
                    TextButton(onClick = { onSave("") }) {
                        Text("清除 Cookie", color = MaterialTheme.colorScheme.error)
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text("取消")
                }
            }
        }
    )
}

fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB")
    var value = bytes.toDouble()
    var unitIndex = 0
    while (value >= 1024 && unitIndex < units.lastIndex) {
        value /= 1024.0
        unitIndex++
    }
    return String.format(Locale.US, "%.1f %s", value, units[unitIndex])
}

fun formatSpeed(speed: Long): String = "${formatBytes(speed)}/s"

@Preview(showBackground = true)
@Composable
fun MainScreenPreview() {
    BewlyBewlyTheme {
        MainScreenContent(
            benchState = BenchUiState(
                jniStatus = "{\"pong\": true, \"engine\": \"rust\"}",
                isJniOk = true,
                isServiceRunning = true,
                rpcEndpoint = "http://127.0.0.1:52134/rpc",
                rpcHealth = "健康在线",
                downloadDirectory = "/storage/emulated/0/Download",
                tasks = listOf(
                    TaskItem(
                        id = "test-1",
                        title = "【猛男版】新宝岛 4K 60FPS 极清无损",
                        bvid = "BV1xx411c7mD",
                        status = "downloading",
                        progress = 72.6,
                        speed = 8847360,
                        downloaded = 42100000,
                        total = 58000000,
                        error = "",
                        output = "/storage/emulated/0/Download/新宝岛.mp4"
                    ),
                    TaskItem(
                        id = "test-2",
                        title = "天气之子 主题曲「爱能做到的还有什么」",
                        bvid = "BV1ab411b7vw",
                        status = "completed",
                        progress = 100.0,
                        speed = 0,
                        downloaded = 18400000,
                        total = 18400000,
                        error = "",
                        output = "/storage/emulated/0/Download/爱能做到的还有什么.m4a"
                    )
                )
            ),
            onVideoInputChange = {},
            onRefreshStatus = {},
            onRestartService = {},
            onParseAndDownload = {},
            onTestDownload = {},
            onPauseTask = {},
            onResumeTask = {},
            onDeleteTask = { _, _ -> }
        )
    }
}

fun openMediaFile(context: Context, filePath: String) {
    try {
        val file = File(filePath)
        if (!file.exists()) {
            Toast.makeText(context, "文件不存在: $filePath", Toast.LENGTH_SHORT).show()
            return
        }
        MediaScannerConnection.scanFile(context, arrayOf(filePath), null, null)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val mime = if (filePath.endsWith(".mp4", ignoreCase = true)) "video/*" else "audio/*"
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(intent, "播放文件"))
    } catch (e: Exception) {
        Toast.makeText(context, "调起播放器失败: ${e.message}", Toast.LENGTH_SHORT).show()
    }
}
