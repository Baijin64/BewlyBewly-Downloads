package io.bewly.download.ui.components

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun BiliLoginDialog(
    onLoginSuccess: (String) -> Unit,
    onSwitchManualCookie: () -> Unit,
    onDismiss: () -> Unit
) {
    var pageProgress by remember { mutableIntStateOf(0) }
    var currentUrl by remember { mutableStateOf("https://passport.bilibili.com/login") }
    var statusTip by remember { mutableStateOf("请使用手机号 + 验证码登录 B 站") }
    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    var captured by remember { mutableStateOf(false) }

    fun tryExtractCookie(): Boolean {
        if (captured) return true
        val cm = CookieManager.getInstance()
        val mainCookie = cm.getCookie("https://www.bilibili.com").orEmpty()
        val passportCookie = cm.getCookie("https://passport.bilibili.com").orEmpty()
        val merged = mergeCookies(mainCookie, passportCookie)
        if (merged.contains("SESSDATA=")) {
            captured = true
            onLoginSuccess(merged)
            return true
        }
        return false
    }

    LaunchedEffect(Unit) {
        // Clear stale login cookies only if user explicitly starts a fresh web login when unauthenticated
        while (!captured) {
            delay(1000)
            if (tryExtractCookie()) break
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            webViewRef?.stopLoading()
            webViewRef?.destroy()
            webViewRef = null
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            topBar = {
                TopAppBar(
                    title = {
                        Column {
                            Text("B 站账号登录", fontWeight = FontWeight.Bold, fontSize = 17.sp)
                            Text(
                                text = statusTip,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    },
                    navigationIcon = {
                        TextButton(onClick = onDismiss) {
                            Text("关闭")
                        }
                    },
                    actions = {
                        TextButton(onClick = { webViewRef?.reload() }) {
                            Text("刷新")
                        }
                        TextButton(onClick = {
                            if (!tryExtractCookie()) {
                                statusTip = "暂未检测到 SESSDATA，请先完成登录"
                            }
                        }) {
                            Text("读取登录")
                        }
                    }
                )
            },
            bottomBar = {
                Surface(tonalElevation = 3.dp) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        OutlinedButton(onClick = onSwitchManualCookie) {
                            Text("手动粘贴 Cookie", fontSize = 12.sp)
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(onClick = {
                            if (!tryExtractCookie()) {
                                statusTip = "尚未检测到有效登录凭证，请先在上方页面完成验证码登录"
                            }
                        }) {
                            Text("我已完成登录", fontSize = 12.sp)
                        }
                    }
                }
            }
        ) { innerPadding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
            ) {
                if (pageProgress in 1..99) {
                    LinearProgressIndicator(
                        progress = { pageProgress / 100f },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(2.dp)
                    )
                }
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            CookieManager.getInstance().setAcceptCookie(true)
                            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.useWideViewPort = true
                            settings.loadWithOverviewMode = true
                            webChromeClient = object : WebChromeClient() {
                                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                                    pageProgress = newProgress
                                }
                            }
                            webViewClient = object : WebViewClient() {
                                override fun shouldOverrideUrlLoading(
                                    view: WebView?,
                                    request: WebResourceRequest?
                                ): Boolean {
                                    val url = request?.url?.toString().orEmpty()
                                    if (url.startsWith("http://") || url.startsWith("https://")) {
                                        currentUrl = url
                                        return false
                                    }
                                    return true
                                }

                                override fun onPageFinished(view: WebView?, url: String?) {
                                    super.onPageFinished(view, url)
                                    if (!url.isNullOrEmpty()) {
                                        currentUrl = url
                                    }
                                    CookieManager.getInstance().flush()
                                    tryExtractCookie()
                                }
                            }
                            loadUrl(currentUrl)
                            webViewRef = this
                        }
                    }
                )
            }
        }
    }
}

private fun mergeCookies(primary: String, secondary: String): String {
    val map = linkedMapOf<String, String>()
    for (source in listOf(secondary, primary)) {
        source.split(";").forEach { part ->
            val trimmed = part.trim()
            val eq = trimmed.indexOf('=')
            if (eq > 0) {
                val k = trimmed.substring(0, eq).trim()
                val v = trimmed.substring(eq + 1).trim()
                if (k.isNotEmpty() && v.isNotEmpty()) {
                    map[k] = v
                }
            }
        }
    }
    return map.entries.joinToString("; ") { "${it.key}=${it.value}" }
}
