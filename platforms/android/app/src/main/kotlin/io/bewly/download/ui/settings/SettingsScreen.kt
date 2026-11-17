package io.bewly.download.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.bewly.download.ui.main.AVAILABLE_AUDIO_QUALITIES
import io.bewly.download.ui.main.AVAILABLE_CODECS
import io.bewly.download.ui.main.AVAILABLE_OUTPUTS
import io.bewly.download.ui.main.AVAILABLE_QUALITIES
import io.bewly.download.ui.main.BenchUiState
import io.bewly.download.ui.main.FILENAME_PRESETS
import io.bewly.download.ui.theme.BiliPink

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    benchState: BenchUiState,
    onOpenWebLogin: () -> Unit,
    onOpenManualCookie: () -> Unit,
    onClearCookie: () -> Unit,
    onSelectQuality: (Int) -> Unit,
    onSelectCodec: (String) -> Unit,
    onSelectAudioQuality: (String) -> Unit,
    onSelectOutputMode: (String) -> Unit,
    onSaveEngineSettings: (maxConcurrent: Int, filenameTemplate: String, folderTemplate: String, autoExport: Boolean) -> Unit,
    onRefreshStatus: () -> Unit,
    onRestartService: () -> Unit,
    modifier: Modifier = Modifier
) {
    var maxConcurrent by remember(benchState.settings.maxConcurrent) {
        mutableIntStateOf(benchState.settings.maxConcurrent)
    }
    var filenameTemplate by remember(benchState.settings.filenameTemplate) {
        mutableStateOf(benchState.settings.filenameTemplate)
    }
    var folderTemplate by remember(benchState.settings.folderTemplate) {
        mutableStateOf(benchState.settings.folderTemplate)
    }
    var autoExportPublic by remember(benchState.settings.autoExportPublic) {
        mutableStateOf(benchState.settings.autoExportPublic)
    }

    Scaffold(
        modifier = modifier,
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("应用设置", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        Text(
                            "账号 · 默认偏好 · 引擎诊断",
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
            benchState.statusMessage?.let { msg ->
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = msg,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.padding(12.dp)
                    )
                }
            }

            // Card 1: Bilibili Account
            SectionCard(title = "B 站账号登录") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = if (benchState.isSessionConfigured) "状态：已配置登录凭证" else "状态：未登录（无法解析高画质流）",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = if (benchState.isSessionConfigured) BiliPink else MaterialTheme.colorScheme.error
                        )
                        Text(
                            text = "推荐使用官方网页登录（支持手机号 + 验证码）自动获取 Cookie",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Button(
                        onClick = onOpenWebLogin,
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("手机号 / 网页登录", fontSize = 13.sp)
                    }
                    OutlinedButton(
                        onClick = onOpenManualCookie
                    ) {
                        Text("粘贴 Cookie", fontSize = 13.sp)
                    }
                }
                if (benchState.isSessionConfigured) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = onClearCookie) {
                            Text("退出登录 / 清除 Cookie", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                        }
                    }
                }
            }

            // Card 2: Download Defaults & Storage
            SectionCard(title = "下载与存储设置") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f).padding(end = 12.dp)) {
                        Text("完成后自动导出到系统公共目录", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                        Text(
                            "导出到 Movies/BewlyBewly、Music/BewlyBewly 与 Download/BewlyBewly 并清理私有暂存文件，卸载不丢失",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Switch(
                        checked = autoExportPublic,
                        onCheckedChange = { autoExportPublic = it }
                    )
                }

                Text("同时下载任务数: $maxConcurrent", style = MaterialTheme.typography.labelLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    (1..4).forEach { count ->
                        FilterChip(
                            selected = maxConcurrent == count,
                            onClick = { maxConcurrent = count },
                            label = { Text("$count 路") }
                        )
                    }
                }

                Text("默认画质", style = MaterialTheme.typography.labelLarge)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    AVAILABLE_QUALITIES.forEach { item ->
                        FilterChip(
                            selected = benchState.selectedQuality == item.quality,
                            onClick = { onSelectQuality(item.quality) },
                            label = { Text(item.label, fontSize = 12.sp) }
                        )
                    }
                }

                Text("默认视频编码", style = MaterialTheme.typography.labelLarge)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    AVAILABLE_CODECS.forEach { item ->
                        FilterChip(
                            selected = benchState.selectedCodec == item.codec,
                            onClick = { onSelectCodec(item.codec) },
                            label = { Text(item.label, fontSize = 12.sp) }
                        )
                    }
                }

                Text("默认音质", style = MaterialTheme.typography.labelLarge)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    AVAILABLE_AUDIO_QUALITIES.forEach { item ->
                        FilterChip(
                            selected = benchState.selectedAudioQuality == item.audioQuality,
                            onClick = { onSelectAudioQuality(item.audioQuality) },
                            label = { Text(item.label, fontSize = 12.sp) }
                        )
                    }
                }

                Text("默认输出模式", style = MaterialTheme.typography.labelLarge)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    AVAILABLE_OUTPUTS.forEach { item ->
                        FilterChip(
                            selected = benchState.selectedOutputMode == item.mode,
                            onClick = { onSelectOutputMode(item.mode) },
                            label = { Text(item.label, fontSize = 12.sp) }
                        )
                    }
                }

                OutlinedTextField(
                    value = filenameTemplate,
                    onValueChange = { filenameTemplate = it },
                    label = { Text("文件名模板") },
                    supportingText = {
                        Text("可用变量: %title% %part% %upnn% %bv% %cid% %index% %vqn% %aqn%")
                    },
                    singleLine = true,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                )

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    FILENAME_PRESETS.forEach { (preset, label) ->
                        FilterChip(
                            selected = filenameTemplate == preset,
                            onClick = { filenameTemplate = preset },
                            label = { Text(label, fontSize = 11.sp) }
                        )
                    }
                }

                OutlinedTextField(
                    value = folderTemplate,
                    onValueChange = { folderTemplate = it },
                    label = { Text("子目录模板（可选，如 %upnn% 或 %collection%）") },
                    singleLine = true,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                )

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Button(
                        onClick = {
                            onSaveEngineSettings(
                                maxConcurrent,
                                filenameTemplate.ifBlank { "%title% [%bv%-%cid%]" },
                                folderTemplate,
                                autoExportPublic
                            )
                        }
                    ) {
                        Text("保存设置")
                    }
                }
            }

            // Card 3: Engine Diagnostics
            SectionCard(title = "Rust 引擎运行诊断") {
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
                                "工作暂存路径: ${benchState.downloadDirectory}",
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace
                            )
                        }
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
                        onClick = onRestartService,
                        colors = ButtonDefaults.filledTonalButtonColors()
                    ) {
                        Text("重启引擎服务")
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))
        }
    }
}

@Composable
private fun SectionCard(
    title: String,
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
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            content()
        }
    }
}
