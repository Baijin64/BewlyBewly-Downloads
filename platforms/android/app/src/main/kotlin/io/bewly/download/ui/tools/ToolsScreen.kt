package io.bewly.download.ui.tools

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.bewly.download.ui.main.ToolboxUiState
import io.bewly.download.ui.main.openMediaTarget

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ToolsScreen(
    toolbox: ToolboxUiState,
    onConvertInputChange: (String) -> Unit,
    onRunConvertId: () -> Unit,
    onPickCcFile: (Uri?) -> Unit,
    onRunCcToSrt: () -> Unit,
    onPickSrtFile: (Uri?) -> Unit,
    onSetSrtLineBreaks: (Boolean) -> Unit,
    onRunSrtToText: () -> Unit,
    onPickAudioFile: (Uri?) -> Unit,
    onRunAudioToMp3: () -> Unit,
    onPickMuxVideo: (Uri?) -> Unit,
    onPickMuxAudio: (Uri?) -> Unit,
    onRunMux: () -> Unit,
    onSetExportFormat: (String) -> Unit,
    onRunExportHistory: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current

    val ccPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { onPickCcFile(it) }
    val srtPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { onPickSrtFile(it) }
    val audioPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { onPickAudioFile(it) }
    val muxVideoPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { onPickMuxVideo(it) }
    val muxAudioPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { onPickMuxAudio(it) }

    Scaffold(
        modifier = modifier,
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("实用工具箱", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        Text(
                            "本地 Rust + FFmpeg 处理",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface
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
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            // Feedback banner
            if (toolbox.isBusy || toolbox.resultMessage != null) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (toolbox.isBusy) {
                                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                                Spacer(modifier = Modifier.width(8.dp))
                            }
                            Text(
                                text = toolbox.resultMessage ?: "处理中...",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer
                            )
                        }
                        val outTarget = toolbox.resultFileUri
                        if (!outTarget.isNullOrEmpty() && !toolbox.isBusy) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.End
                            ) {
                                TextButton(onClick = {
                                    openMediaTarget(
                                        context = context,
                                        uriOrPath = outTarget,
                                        mimeHint = toolbox.resultFileMime
                                    )
                                }) {
                                    Text("打开结果文件")
                                }
                            }
                        }
                    }
                }
            }

            // 1. BV / AV Converter
            ToolCard(title = "BV / AV 号互转", subtitle = "离线即时转换 B 站视频编号") {
                OutlinedTextField(
                    value = toolbox.convertInput,
                    onValueChange = onConvertInputChange,
                    placeholder = { Text("输入 BV1... 或 av170001 / 纯数字") },
                    singleLine = true,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (!toolbox.convertResult.isNullOrEmpty()) {
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            modifier = Modifier.weight(1f)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                            ) {
                                Text(
                                    text = toolbox.convertResult,
                                    fontFamily = FontFamily.Monospace,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                                TextButton(onClick = {
                                    clipboard.setText(AnnotatedString(toolbox.convertResult))
                                }) {
                                    Text("复制", fontSize = 12.sp)
                                }
                            }
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                    } else {
                        Spacer(modifier = Modifier.weight(1f))
                    }
                    Button(
                        onClick = onRunConvertId,
                        enabled = !toolbox.isBusy && toolbox.convertInput.isNotBlank()
                    ) {
                        Text("转换")
                    }
                }
            }

            // 2. CC JSON -> SRT
            ToolCard(title = "CC 字幕 JSON 转 SRT", subtitle = "将 B 站 JSON 字幕转为标准 .srt 文件") {
                FilePickRow(
                    label = toolbox.pickedCcFile?.name ?: "未选择 .json 字幕文件",
                    onPick = { ccPicker.launch(arrayOf("application/json", "*/*")) },
                    actionLabel = "转换为 SRT",
                    enabled = !toolbox.isBusy && toolbox.pickedCcFile != null,
                    onRun = onRunCcToSrt
                )
            }

            // 3. SRT -> Text
            ToolCard(title = "SRT 字幕提取纯文本", subtitle = "剥离时间轴导出为 .txt 文本") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text("保留每句换行", style = MaterialTheme.typography.bodySmall)
                    Switch(
                        checked = toolbox.srtLineBreaks,
                        onCheckedChange = onSetSrtLineBreaks
                    )
                }
                FilePickRow(
                    label = toolbox.pickedSrtFile?.name ?: "未选择 .srt 字幕文件",
                    onPick = { srtPicker.launch(arrayOf("*/*")) },
                    actionLabel = "提取文本",
                    enabled = !toolbox.isBusy && toolbox.pickedSrtFile != null,
                    onRun = onRunSrtToText
                )
            }

            // 4. Audio -> MP3
            ToolCard(title = "音频转 MP3", subtitle = "调用内置 FFmpeg + LAME 转码为高质量 MP3") {
                FilePickRow(
                    label = toolbox.pickedAudioFile?.name ?: "支持 m4a / flac / aac / wav / m4s",
                    onPick = { audioPicker.launch(arrayOf("audio/*", "*/*")) },
                    actionLabel = "开始转码",
                    enabled = !toolbox.isBusy && toolbox.pickedAudioFile != null,
                    onRun = onRunAudioToMp3
                )
            }

            // 5. Manual Mux
            ToolCard(title = "手动音视频混流", subtitle = "无损封装视频轨与音频轨为 .merged.mkv") {
                OutlinedButton(
                    onClick = { muxVideoPicker.launch(arrayOf("video/*", "*/*")) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(
                        text = "视频轨: ${toolbox.pickedMuxVideo?.name ?: "点击选择视频 (.mp4/.m4s/.mkv)"}",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontSize = 12.sp
                    )
                }
                OutlinedButton(
                    onClick = { muxAudioPicker.launch(arrayOf("audio/*", "*/*")) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(
                        text = "音频轨: ${toolbox.pickedMuxAudio?.name ?: "点击选择音频 (.m4a/.flac/.mp3)"}",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontSize = 12.sp
                    )
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Button(
                        onClick = onRunMux,
                        enabled = !toolbox.isBusy && toolbox.pickedMuxVideo != null && toolbox.pickedMuxAudio != null
                    ) {
                        Text("执行混流")
                    }
                }
            }

            // 6. Export History
            ToolCard(title = "导出已完成下载历史", subtitle = "导出记录至公共 Download/BewlyBewly 目录") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    listOf("json" to "JSON", "csv" to "CSV", "bilidown" to "Bilidown 导出").forEach { (fmt, label) ->
                        FilterChip(
                            selected = toolbox.exportFormat == fmt,
                            onClick = { onSetExportFormat(fmt) },
                            label = { Text(label, fontSize = 12.sp) }
                        )
                    }
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Button(onClick = onRunExportHistory, enabled = !toolbox.isBusy) {
                        Text("导出历史记录")
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))
        }
    }
}

@Composable
private fun ToolCard(
    title: String,
    subtitle: String,
    content: @Composable () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Column {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            content()
        }
    }
}

@Composable
private fun FilePickRow(
    label: String,
    onPick: () -> Unit,
    actionLabel: String,
    enabled: Boolean,
    onRun: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        OutlinedButton(
            onClick = onPick,
            modifier = Modifier.weight(1f),
            shape = RoundedCornerShape(10.dp)
        ) {
            Text(
                text = label,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontSize = 12.sp
            )
        }
        Button(onClick = onRun, enabled = enabled) {
            Text(actionLabel, fontSize = 12.sp)
        }
    }
}
