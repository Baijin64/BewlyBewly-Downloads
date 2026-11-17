package io.bewly.download

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.bewly.download.data.DefaultDataRepository
import io.bewly.download.ui.components.BiliLoginDialog
import io.bewly.download.ui.main.CookieDialog
import io.bewly.download.ui.main.MainScreen
import io.bewly.download.ui.main.MainScreenViewModel
import io.bewly.download.ui.settings.SettingsScreen
import io.bewly.download.ui.tools.ToolsScreen

private enum class AppTab(val label: String, val badge: String) {
    DOWNLOAD("下载", "⬇"),
    TOOLS("工具箱", "🛠"),
    SETTINGS("设置", "⚙")
}

@Composable
fun MainNavigation(
    sharedText: String? = null,
    onSharedTextConsumed: () -> Unit = {},
    viewModel: MainScreenViewModel = viewModel { MainScreenViewModel(DefaultDataRepository()) }
) {
    val context: Context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val benchState by viewModel.benchState.collectAsStateWithLifecycle()
    var currentTab by rememberSaveable { mutableStateOf(AppTab.DOWNLOAD) }

    LaunchedEffect(Unit) {
        viewModel.initAndCheckStatus(context)
    }

    LaunchedEffect(sharedText) {
        if (!sharedText.isNullOrBlank()) {
            currentTab = AppTab.DOWNLOAD
            viewModel.handleIncomingSharedText(context, sharedText)
            onSharedTextConsumed()
        }
    }

    androidx.compose.runtime.DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> viewModel.setForegroundActive(true)
                Lifecycle.Event.ON_PAUSE -> viewModel.setForegroundActive(false)
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    if (benchState.isWebLoginDialogVisible) {
        BiliLoginDialog(
            onLoginSuccess = { cookie ->
                viewModel.saveSessionCookie(cookie)
                Toast.makeText(context, "已自动获取并保存 B 站登录状态", Toast.LENGTH_SHORT).show()
            },
            onSwitchManualCookie = {
                viewModel.setWebLoginDialogVisible(false)
                viewModel.setCookieDialogVisible(true)
            },
            onDismiss = { viewModel.setWebLoginDialogVisible(false) }
        )
    }

    if (benchState.isCookieDialogVisible) {
        CookieDialog(
            currentCookie = benchState.sessionCookie,
            onSave = viewModel::saveSessionCookie,
            onDismiss = { viewModel.setCookieDialogVisible(false) }
        )
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                AppTab.entries.forEach { tab ->
                    NavigationBarItem(
                        selected = currentTab == tab,
                        onClick = { currentTab = tab },
                        icon = { Text(tab.badge, fontSize = 18.sp) },
                        label = {
                            Text(
                                tab.label,
                                fontWeight = if (currentTab == tab) FontWeight.Bold else FontWeight.Normal,
                                fontSize = 12.sp
                            )
                        }
                    )
                }
            }
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(bottom = innerPadding.calculateBottomPadding())
        ) {
            when (currentTab) {
                AppTab.DOWNLOAD -> MainScreen(
                    viewModel = viewModel,
                    onOpenLogin = { viewModel.setWebLoginDialogVisible(true) },
                    onNavigateToSettings = { currentTab = AppTab.SETTINGS }
                )
                AppTab.TOOLS -> ToolsScreen(
                    toolbox = benchState.toolbox,
                    onConvertInputChange = viewModel::updateConvertInput,
                    onRunConvertId = { viewModel.runConvertId(context) },
                    onPickCcFile = { uri -> viewModel.setPickedCcFile(context, uri) },
                    onRunCcToSrt = { viewModel.runCcToSrt(context) },
                    onPickSrtFile = { uri -> viewModel.setPickedSrtFile(context, uri) },
                    onSetSrtLineBreaks = viewModel::setSrtLineBreaks,
                    onRunSrtToText = { viewModel.runSrtToText(context) },
                    onPickAudioFile = { uri -> viewModel.setPickedAudioFile(context, uri) },
                    onRunAudioToMp3 = { viewModel.runAudioToMp3(context) },
                    onPickMuxVideo = { uri -> viewModel.setPickedMuxVideo(context, uri) },
                    onPickMuxAudio = { uri -> viewModel.setPickedMuxAudio(context, uri) },
                    onRunMux = { viewModel.runMux(context) },
                    onSetExportFormat = viewModel::setExportFormat,
                    onRunExportHistory = { viewModel.runExportHistory(context) }
                )
                AppTab.SETTINGS -> SettingsScreen(
                    benchState = benchState,
                    onOpenWebLogin = { viewModel.setWebLoginDialogVisible(true) },
                    onOpenManualCookie = { viewModel.setCookieDialogVisible(true) },
                    onClearCookie = { viewModel.saveSessionCookie("") },
                    onSelectQuality = viewModel::setQuality,
                    onSelectCodec = viewModel::setCodec,
                    onSelectAudioQuality = viewModel::setAudioQuality,
                    onSelectOutputMode = viewModel::setOutputMode,
                    onSaveEngineSettings = { maxC, fnTpl, dirTpl, autoExp ->
                        viewModel.updateSettings(context, maxC, fnTpl, dirTpl, autoExp)
                    },
                    onRefreshStatus = { viewModel.initAndCheckStatus(context) },
                    onRestartService = { viewModel.restartService(context) }
                )
            }
        }
    }
}
