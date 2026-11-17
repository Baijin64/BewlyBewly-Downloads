package io.bewly.download.ui.main

import android.content.Context
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.bewly.download.MediaStoreExporter
import io.bewly.download.R
import io.bewly.download.ui.theme.BewlyBewlyTheme
import io.bewly.download.ui.theme.BiliBlue
import io.bewly.download.ui.theme.BiliPink
import java.io.File
import java.util.Locale

@Composable
fun MainScreen(
    modifier: Modifier = Modifier,
    viewModel: MainScreenViewModel = viewModel(),
    onOpenLogin: () -> Unit = {},
    onNavigateToSettings: () -> Unit = {}
) {
    val context = LocalContext.current
    val clipboardManager = LocalClipboardManager.current
    val benchState by viewModel.benchState.collectAsStateWithLifecycle()

    var pendingDeleteTask by remember { mutableStateOf<TaskItem?>(null) }

    MainScreenContent(
        modifier = modifier,
        benchState = benchState,
        onOpenLogin = onOpenLogin,
        onNavigateToSettings = onNavigateToSettings,
        onVideoInputChange = viewModel::onVideoInputChange,
        onClearInput = viewModel::onClearVideoInput,
        onPasteClipboard = {
            val clipText = clipboardManager.getText()?.text.orEmpty()
            viewModel.onPasteClipboard(clipText)
        },
        onInspectVideo = { viewModel.inspectVideo(context) },
        onTestExample = { viewModel.inspectVideo(context, "BV1xx411c7mD") },
        onQualityChange = viewModel::setQuality,
        onCodecChange = viewModel::setCodec,
        onAudioQualityChange = viewModel::setAudioQuality,
        onOutputModeChange = viewModel::setOutputMode,
        onToggleAttachment = viewModel::toggleAttachment,
        onFilterChange = viewModel::setFilter,
        onStartPendingTask = viewModel::startPendingTask,
        onStartAllPending = viewModel::startAllPending,
        onPauseTask = viewModel::pauseTask,
        onPauseAllActive = viewModel::pauseAllActive,
        onResumeTask = viewModel::resumeTask,
        onRetryTask = viewModel::retryTask,
        onRequestDeleteTask = { task -> pendingDeleteTask = task },
        onClearCompleted = viewModel::clearCompletedTasks,
        onDismissMessage = viewModel::clearStatusMessage,
        onCopyPath = { path ->
            clipboardManager.setText(AnnotatedString(path))
            Toast.makeText(context, "已复制: $path", Toast.LENGTH_SHORT).show()
        },
        onOpenTarget = { uriOrPath, nameHint ->
            val mime = nameHint?.let { MediaStoreExporter.mimeTypeFor(it) }
            openMediaTarget(context, uriOrPath, mime)
        }
    )

    val inspected = benchState.inspectedVideo
    if (inspected != null) {
        VideoInspectBottomSheet(
            inspected = inspected,
            benchState = benchState,
            onToggleCid = viewModel::toggleCidSelection,
            onSelectAllCids = viewModel::selectAllCids,
            onSwitchEpisode = { bvid -> viewModel.switchToCollectionEpisode(context, bvid) },
            onQualityChange = viewModel::setQuality,
            onCodecChange = viewModel::setCodec,
            onAudioQualityChange = viewModel::setAudioQuality,
            onOutputModeChange = viewModel::setOutputMode,
            onToggleAttachment = viewModel::toggleAttachment,
            onSubmit = { startNow -> viewModel.submitInspectedDownload(context, startNow) },
            onDismiss = viewModel::dismissInspectedVideo
        )
    }

    val deleteTarget = pendingDeleteTask
    if (deleteTarget != null) {
        DeleteTaskDialog(
            task = deleteTarget,
            onConfirm = { deleteFiles ->
                viewModel.deleteTask(context, deleteTarget.id, deleteTarget.status, deleteFiles)
                pendingDeleteTask = null
            },
            onDismiss = { pendingDeleteTask = null }
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MainScreenContent(
    modifier: Modifier = Modifier,
    benchState: BenchUiState,
    onOpenLogin: () -> Unit = {},
    onNavigateToSettings: () -> Unit = {},
    onVideoInputChange: (String) -> Unit,
    onClearInput: () -> Unit = {},
    onPasteClipboard: () -> Unit = {},
    onInspectVideo: () -> Unit,
    onTestExample: () -> Unit,
    onQualityChange: (Int) -> Unit = {},
    onCodecChange: (String) -> Unit = {},
    onAudioQualityChange: (String) -> Unit = {},
    onOutputModeChange: (String) -> Unit = {},
    onToggleAttachment: (String) -> Unit = {},
    onFilterChange: (TaskFilter) -> Unit = {},
    onStartPendingTask: (String) -> Unit = {},
    onStartAllPending: () -> Unit = {},
    onPauseTask: (String) -> Unit,
    onPauseAllActive: () -> Unit = {},
    onResumeTask: (String) -> Unit,
    onRetryTask: (String) -> Unit = {},
    onRequestDeleteTask: (TaskItem) -> Unit,
    onClearCompleted: () -> Unit = {},
    onDismissMessage: () -> Unit = {},
    onCopyPath: (String) -> Unit = {},
    onOpenTarget: (String, String?) -> Unit = { _, _ -> }
) {
    val scrollState = rememberScrollState()
    val filteredTasks = remember(benchState.tasks, benchState.selectedFilter) {
        when (benchState.selectedFilter) {
            TaskFilter.ALL -> benchState.tasks
            TaskFilter.ACTIVE -> benchState.tasks.filter {
                it.status in setOf("downloading", "queued", "resolving", "muxing", "postprocessing", "paused")
            }
            TaskFilter.PENDING -> benchState.tasks.filter { it.status == "pending" }
            TaskFilter.COMPLETED -> benchState.tasks.filter { it.status == "completed" }
            TaskFilter.FAILED -> benchState.tasks.filter { it.status == "failed" || it.status == "cancelled" }
        }
    }

    val isOnline = benchState.isJniOk && benchState.isServiceRunning && benchState.rpcHealth.startsWith("健康")
    val hasPending = benchState.tasks.any { it.status == "pending" }
    val hasActive = benchState.tasks.any {
        it.status in setOf("downloading", "queued", "resolving", "muxing", "postprocessing")
    }
    val hasCompleted = benchState.tasks.any { it.status == "completed" }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Image(
                            painter = painterResource(id = R.drawable.ic_bewly_brand),
                            contentDescription = "BewlyBewly Logo",
                            modifier = Modifier.size(28.dp)
                        )
                        Text(
                            text = "Bewly 下载器",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                    }
                },
                actions = {
                    Surface(
                        onClick = onOpenLogin,
                        shape = RoundedCornerShape(16.dp),
                        color = if (benchState.isSessionConfigured) Color(0xFFE8F5E9) else BiliPink.copy(alpha = 0.14f),
                        modifier = Modifier.padding(end = 6.dp)
                    ) {
                        Text(
                            text = if (benchState.isSessionConfigured) "✓ 已登录" else "登录账号",
                            color = if (benchState.isSessionConfigured) Color(0xFF1B5E20) else BiliPink,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp)
                        )
                    }
                    Surface(
                        onClick = onNavigateToSettings,
                        shape = RoundedCornerShape(16.dp),
                        color = if (isOnline) Color(0xFFE1F5FE) else Color(0xFFFFECEB),
                        modifier = Modifier.padding(end = 10.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(7.dp)
                                    .background(if (isOnline) BiliBlue else Color(0xFFC62828), CircleShape)
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(
                                text = if (isOnline) "引擎就绪" else "引擎未就绪",
                                color = if (isOnline) Color(0xFF0277BD) else Color(0xFFC62828),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold
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
                .verticalScroll(scrollState)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            // Login reminder banner when no cookie is present
            if (!benchState.isSessionConfigured) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.6f),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "未登录将以游客清晰度（最高 480P / 原生音频）下载；登录可解锁 1080P / 4K",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.weight(1f)
                        )
                        TextButton(onClick = onOpenLogin) {
                            Text("立即登录", fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }

            // Input & Parse Card
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "新建下载任务",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        FilledTonalButton(
                            onClick = onPasteClipboard,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.height(34.dp)
                        ) {
                            Text("粘贴并识别", fontSize = 12.sp)
                        }
                    }

                    OutlinedTextField(
                        value = benchState.videoInput,
                        onValueChange = onVideoInputChange,
                        placeholder = {
                            Text("粘贴 B 站视频链接、b23.tv 短链或 BV/AV 号（也支持从 B 站 App 分享到本应用）", fontSize = 12.sp)
                        },
                        singleLine = true,
                        trailingIcon = {
                            if (benchState.videoInput.isNotEmpty()) {
                                IconButton(onClick = onClearInput) {
                                    Text("✕", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        },
                        shape = RoundedCornerShape(12.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = MaterialTheme.colorScheme.primary,
                            unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    // Quick Quality & Mode Presets
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("预设:", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        listOf(0, 120, 116, 80, 64).forEach { q ->
                            val label = AVAILABLE_QUALITIES.firstOrNull { it.quality == q }?.label ?: "${q}P"
                            FilterChip(
                                selected = benchState.selectedQuality == q && benchState.selectedOutputMode in listOf("video", "silent"),
                                onClick = {
                                    if (benchState.selectedOutputMode !in listOf("video", "silent")) {
                                        onOutputModeChange("video")
                                    }
                                    onQualityChange(q)
                                },
                                label = { Text(label, fontSize = 11.sp) }
                            )
                        }
                        listOf("audio", "mp3").forEach { mode ->
                            val label = AVAILABLE_OUTPUTS.firstOrNull { it.mode == mode }?.label ?: mode
                            FilterChip(
                                selected = benchState.selectedOutputMode == mode,
                                onClick = { onOutputModeChange(mode) },
                                label = { Text(label, fontSize = 11.sp) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = BiliBlue.copy(alpha = 0.16f),
                                    selectedLabelColor = BiliBlue
                                )
                            )
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Button(
                            onClick = onInspectVideo,
                            enabled = !benchState.isProcessing && benchState.videoInput.isNotBlank(),
                            shape = RoundedCornerShape(12.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
                            modifier = Modifier
                                .weight(1f)
                                .height(46.dp)
                        ) {
                            if (benchState.isProcessing) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(18.dp),
                                    color = Color.White,
                                    strokeWidth = 2.dp
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text("解析中...", fontWeight = FontWeight.Bold)
                            } else {
                                Text("解析并配置下载", fontWeight = FontWeight.Bold)
                            }
                        }

                        OutlinedButton(
                            onClick = onTestExample,
                            enabled = !benchState.isProcessing,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.height(46.dp)
                        ) {
                            Text("⚡ 示例", fontSize = 12.sp)
                        }
                    }
                }
            }

            // Status toast banner
            AnimatedVisibility(
                visible = !benchState.statusMessage.isNullOrEmpty(),
                enter = fadeIn(),
                exit = fadeOut()
            ) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.7f),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.25f)),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = benchState.statusMessage.orEmpty(),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            modifier = Modifier.weight(1f)
                        )
                        TextButton(onClick = onDismissMessage) {
                            Text("关闭", fontSize = 11.sp)
                        }
                    }
                }
            }

            // Task Queue Header & Batch Actions
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "任务队列 (${benchState.tasks.size})",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (hasPending) {
                        TextButton(onClick = onStartAllPending) {
                            Text("全部开始", fontSize = 12.sp, color = BiliBlue)
                        }
                    }
                    if (hasActive) {
                        TextButton(onClick = onPauseAllActive) {
                            Text("全部暂停", fontSize = 12.sp)
                        }
                    }
                    if (hasCompleted) {
                        TextButton(onClick = onClearCompleted) {
                            Text("清理已完成", fontSize = 12.sp)
                        }
                    }
                }
            }

            // Filter Tabs
            PrimaryScrollableTabRow(
                selectedTabIndex = TaskFilter.entries.indexOf(benchState.selectedFilter),
                containerColor = Color.Transparent,
                edgePadding = 0.dp
            ) {
                TaskFilter.entries.forEach { filter ->
                    val count = when (filter) {
                        TaskFilter.ALL -> benchState.tasks.size
                        TaskFilter.ACTIVE -> benchState.tasks.count {
                            it.status in setOf("downloading", "queued", "resolving", "muxing", "postprocessing", "paused")
                        }
                        TaskFilter.PENDING -> benchState.tasks.count { it.status == "pending" }
                        TaskFilter.COMPLETED -> benchState.tasks.count { it.status == "completed" }
                        TaskFilter.FAILED -> benchState.tasks.count { it.status == "failed" || it.status == "cancelled" }
                    }
                    Tab(
                        selected = benchState.selectedFilter == filter,
                        onClick = { onFilterChange(filter) },
                        text = {
                            Text(
                                text = "${filter.label} ($count)",
                                fontSize = 12.sp,
                                fontWeight = if (benchState.selectedFilter == filter) FontWeight.Bold else FontWeight.Normal
                            )
                        }
                    )
                }
            }

            // Task Cards
            if (filteredTasks.isEmpty()) {
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.surface,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(
                            text = if (benchState.tasks.isEmpty()) "暂无下载任务" else "当前分组下没有任务",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Medium
                        )
                        Text(
                            text = "输入 BV 号、链接或从 B 站分享即可开始",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    filteredTasks.forEach { task ->
                        TaskCard(
                            task = task,
                            onStartPending = { onStartPendingTask(task.id) },
                            onPause = { onPauseTask(task.id) },
                            onResume = { onResumeTask(task.id) },
                            onRetry = { onRetryTask(task.id) },
                            onDelete = { onRequestDeleteTask(task) },
                            onCopyPath = onCopyPath,
                            onOpenTarget = onOpenTarget
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun VideoInspectBottomSheet(
    inspected: InspectedVideo,
    benchState: BenchUiState,
    onToggleCid: (Long) -> Unit,
    onSelectAllCids: (Boolean) -> Unit,
    onSwitchEpisode: (String) -> Unit,
    onQualityChange: (Int) -> Unit,
    onCodecChange: (String) -> Unit,
    onAudioQualityChange: (String) -> Unit,
    onOutputModeChange: (String) -> Unit,
    onToggleAttachment: (String) -> Unit,
    onSubmit: (Boolean) -> Unit,
    onDismiss: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 660.dp)
                .padding(horizontal = 16.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = false)
                    .verticalScroll(rememberScrollState())
                    .padding(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
            Text(
                text = inspected.title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = listOfNotNull(
                    inspected.author.takeIf { it.isNotEmpty() }?.let { "UP主: $it" },
                    inspected.bvid.takeIf { it.isNotEmpty() }
                ).joinToString("  •  "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            // Pages selection (for multi-P videos or single-P confirmation)
            if (inspected.pages.isNotEmpty()) {
                HorizontalDivider()
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "选择分 P（已选 ${benchState.selectedCids.size}/${inspected.pages.size}）",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold
                    )
                    Row {
                        TextButton(onClick = { onSelectAllCids(true) }) {
                            Text("全选", fontSize = 12.sp)
                        }
                        TextButton(onClick = { onSelectAllCids(false) }) {
                            Text("清空", fontSize = 12.sp)
                        }
                    }
                }

                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 180.dp)
                ) {
                    LazyColumn(modifier = Modifier.padding(4.dp)) {
                        items(inspected.pages, key = { it.cid }) { page ->
                            val checked = page.cid in benchState.selectedCids
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onToggleCid(page.cid) }
                                    .padding(horizontal = 6.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Checkbox(
                                    checked = checked,
                                    onCheckedChange = { onToggleCid(page.cid) }
                                )
                                Text(
                                    text = "P${page.page}  ${page.title}",
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f)
                                )
                                if (page.duration > 0L) {
                                    Text(
                                        text = formatDuration(page.duration),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Collection episodes switcher if available
            if (inspected.collectionSections.isNotEmpty()) {
                HorizontalDivider()
                Text(
                    text = "所属合集：${inspected.collectionTitle ?: "视频合集"}（点击切换其它集数）",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold
                )
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    inspected.collectionSections.forEach { section ->
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            section.videos.take(12).forEach { ep ->
                                FilterChip(
                                    selected = ep.bvid.equals(inspected.bvid, ignoreCase = true),
                                    onClick = {
                                        if (ep.available && !ep.bvid.equals(inspected.bvid, ignoreCase = true)) {
                                            onSwitchEpisode(ep.bvid)
                                        }
                                    },
                                    enabled = ep.available,
                                    label = {
                                        Text(
                                            text = ep.title.ifEmpty { ep.bvid },
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                            fontSize = 11.sp
                                        )
                                    }
                                )
                            }
                        }
                    }
                }
            }

            HorizontalDivider()

            // Output mode
            Text("输出类型", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                AVAILABLE_OUTPUTS.forEach { opt ->
                    FilterChip(
                        selected = benchState.selectedOutputMode == opt.mode,
                        onClick = { onOutputModeChange(opt.mode) },
                        label = { Text(opt.label, fontSize = 12.sp) }
                    )
                }
            }

            // Video quality & codec (when downloading video/silent)
            if (benchState.selectedOutputMode in listOf("video", "silent")) {
                Text("画质选择", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                if (!benchState.isSessionConfigured && benchState.selectedQuality >= 64) {
                    Text(
                        text = "提示：未登录 B 站账号时固定选择 720P 以上画质可能会被接口拒绝，推荐选「最高可用」或先登录账号。",
                        style = MaterialTheme.typography.labelSmall,
                        color = Color(0xFFE65100)
                    )
                }
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    AVAILABLE_QUALITIES.forEach { q ->
                        FilterChip(
                            selected = benchState.selectedQuality == q.quality,
                            onClick = { onQualityChange(q.quality) },
                            label = { Text(q.label, fontSize = 12.sp) }
                        )
                    }
                }

                Text("视频编码", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    AVAILABLE_CODECS.forEach { c ->
                        FilterChip(
                            selected = benchState.selectedCodec == c.codec,
                            onClick = { onCodecChange(c.codec) },
                            label = { Text(c.label, fontSize = 12.sp) }
                        )
                    }
                }
            }

            // Audio quality
            if (benchState.selectedOutputMode != "silent") {
                Text("音质偏好", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    AVAILABLE_AUDIO_QUALITIES.forEach { aq ->
                        FilterChip(
                            selected = benchState.selectedAudioQuality == aq.audioQuality,
                            onClick = { onAudioQualityChange(aq.audioQuality) },
                            label = { Text(aq.label, fontSize = 12.sp) }
                        )
                    }
                }
            }

            // Attachments
            Text("附属文件（可多选，完成后同步导出）", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                AVAILABLE_ATTACHMENTS.forEach { att ->
                    FilterChip(
                        selected = att.key in benchState.selectedAttachments,
                        onClick = { onToggleAttachment(att.key) },
                        label = { Text(att.label, fontSize = 12.sp) }
                    )
                }
            }

            Spacer(modifier = Modifier.height(4.dp))
            }

            HorizontalDivider()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp, bottom = 18.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                OutlinedButton(
                    onClick = { onSubmit(false) },
                    enabled = !benchState.isProcessing && benchState.selectedCids.isNotEmpty(),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp)
                ) {
                    Text("加入待下载")
                }
                Button(
                    onClick = { onSubmit(true) },
                    enabled = !benchState.isProcessing && benchState.selectedCids.isNotEmpty(),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier
                        .weight(1.3f)
                        .height(48.dp)
                ) {
                    Text("立即开始下载 (${benchState.selectedCids.size})", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
fun TaskCard(
    task: TaskItem,
    onStartPending: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onRetry: () -> Unit,
    onDelete: () -> Unit,
    onCopyPath: (String) -> Unit,
    onOpenTarget: (String, String?) -> Unit
) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = task.title,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    if (task.bvid.isNotEmpty()) {
                        Text(
                            text = task.bvid,
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                Spacer(modifier = Modifier.width(8.dp))
                StatusChip(status = task.status)
            }

            val progressFraction = (task.progress / 100.0).toFloat().coerceIn(0f, 1f)
            LinearProgressIndicator(
                progress = { progressFraction },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(7.dp),
                color = when (task.status) {
                    "completed" -> Color(0xFF4CAF50)
                    "failed", "cancelled" -> MaterialTheme.colorScheme.error
                    "paused", "pending" -> Color(0xFF90A4AE)
                    else -> MaterialTheme.colorScheme.primary
                },
                trackColor = MaterialTheme.colorScheme.surfaceVariant
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                val downloadedStr = formatBytes(task.downloaded)
                val totalStr = if (task.total > 0) formatBytes(task.total) else "未知大小"
                Text(
                    text = String.format(Locale.US, "%.1f%% · %s / %s", task.progress, downloadedStr, totalStr),
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary
                )
                if (task.status == "downloading") {
                    Text(
                        text = "⚡ ${formatSpeed(task.speed)}",
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                        color = BiliBlue
                    )
                }
            }

            // Completed banner preferring public MediaStore export location
            if (task.status == "completed" && (!task.exportedUri.isNullOrEmpty() || !task.output.isNullOrEmpty())) {
                val openTarget = task.exportedUri ?: task.output.orEmpty()
                val rawName = task.output?.substringAfterLast('/') ?: "${task.title}.mp4"
                val displayText = task.exportedDisplay ?: rawName

                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = Color(0xFFE8F5E9),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Text(
                            text = "✓ 已保存: $displayText",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.SemiBold,
                            color = Color(0xFF1B5E20),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.End,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            TextButton(
                                onClick = { onCopyPath(displayText) },
                                modifier = Modifier.padding(end = 6.dp)
                            ) {
                                Text("复制路径", fontSize = 11.sp, color = Color(0xFF1B5E20))
                            }
                            Button(
                                onClick = { onOpenTarget(openTarget, rawName) },
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D32)),
                                shape = RoundedCornerShape(8.dp)
                            ) {
                                Text("▶ 播放 / 打开", fontSize = 11.sp, color = Color.White)
                            }
                        }
                    }
                }
            }

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

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                when (task.status) {
                    "pending" -> {
                        FilledTonalButton(
                            onClick = onStartPending,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.padding(end = 8.dp)
                        ) {
                            Text("开始下载", fontSize = 12.sp)
                        }
                    }
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
                        containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.85f),
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
fun DeleteTaskDialog(
    task: TaskItem,
    onConfirm: (deleteFiles: Boolean) -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("删除下载任务", fontWeight = FontWeight.Bold) },
        text = {
            Text("确认删除「${task.title}」？您可以选择仅移除任务记录，或连同本地与媒体库导出的文件一并删除。")
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(true) },
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
            ) {
                Text("删除记录与文件")
            }
        },
        dismissButton = {
            Row {
                TextButton(onClick = { onConfirm(false) }) {
                    Text("仅移除记录")
                }
                TextButton(onClick = onDismiss) {
                    Text("取消")
                }
            }
        }
    )
}

@Composable
fun StatusChip(status: String) {
    val (label, bg, fg) = when (status) {
        "pending" -> Triple("待下载", Color(0xFFF3E5F5), Color(0xFF6A1B9A))
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
            Text("手动导入 B 站 Cookie", fontWeight = FontWeight.Bold)
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

fun formatDuration(seconds: Long): String {
    val s = seconds.coerceAtLeast(0L)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) {
        String.format(Locale.US, "%d:%02d:%02d", h, m, sec)
    } else {
        String.format(Locale.US, "%02d:%02d", m, sec)
    }
}

fun openMediaTarget(context: Context, uriOrPath: String, mimeHint: String? = null) {
    try {
        if (uriOrPath.startsWith("content://")) {
            val uri = Uri.parse(uriOrPath)
            val mime = mimeHint
                ?: context.contentResolver.getType(uri)
                ?: "*/*"
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(Intent.createChooser(intent, "打开文件"))
            return
        }

        val file = File(uriOrPath)
        if (!file.exists()) {
            Toast.makeText(context, "文件不存在: $uriOrPath", Toast.LENGTH_SHORT).show()
            return
        }
        MediaScannerConnection.scanFile(context, arrayOf(uriOrPath), null, null)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val mime = mimeHint ?: MediaStoreExporter.mimeTypeFor(file.name)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(intent, "打开文件"))
    } catch (e: Exception) {
        Toast.makeText(context, "调起打开失败: ${e.message}", Toast.LENGTH_SHORT).show()
    }
}

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
                        output = "/storage/emulated/0/Download/爱能做到的还有什么.m4a",
                        exportedDisplay = "Music/BewlyBewly/爱能做到的还有什么.m4a"
                    )
                )
            ),
            onVideoInputChange = {},
            onInspectVideo = {},
            onTestExample = {},
            onPauseTask = {},
            onResumeTask = {},
            onRequestDeleteTask = {}
        )
    }
}
