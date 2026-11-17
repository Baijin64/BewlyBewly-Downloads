package io.bewly.download

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

@RunWith(AndroidJUnit4::class)
class BewlyNativeTest {

    @Test
    fun testNativePing() {
        val pingResult = BewlyNative.ping()
        val json = JSONObject(pingResult)
        assertEquals(true, json.getBoolean("pong"))
        assertEquals("rust", json.getString("engine"))
    }

    @Test
    fun testStartServiceAndHealth() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dataDir = context.filesDir.absolutePath

        val started = BewlyNative.startService(dataDir, "service")
        assertTrue("Service should start successfully", started)

        // 等待服务启动并生成可连通的 connection.json
        val connFile = File(context.filesDir, "connection.json")
        var responseText = ""
        var responseCode = -1
        val deadline = System.currentTimeMillis() + 5000L
        var lastError: Throwable? = null

        while (System.currentTimeMillis() < deadline) {
            if (connFile.exists()) {
                try {
                    val connJson = JSONObject(connFile.readText())
                    val port = connJson.getInt("port")
                    val token = connJson.getString("token")
                    if (port > 0 && token.isNotEmpty()) {
                        val url = URL("http://127.0.0.1:$port/rpc")
                        val conn = (url.openConnection() as HttpURLConnection).apply {
                            requestMethod = "POST"
                            setRequestProperty("Content-Type", "application/json")
                            setRequestProperty("Authorization", "Bearer $token")
                            doOutput = true
                            connectTimeout = 1000
                            readTimeout = 2000
                        }
                        val rpcRequest = JSONObject().apply {
                            put("id", 1)
                            put("method", "health")
                            put("params", JSONObject())
                        }
                        conn.outputStream.use { os ->
                            os.write(rpcRequest.toString().toByteArray(Charsets.UTF_8))
                        }
                        responseCode = conn.responseCode
                        responseText = conn.inputStream.bufferedReader().use { it.readText() }
                        break
                    }
                } catch (e: Throwable) {
                    lastError = e
                }
            }
            Thread.sleep(150)
        }

        assertTrue("connection.json must be created by native service", connFile.exists())
        if (responseCode != 200) {
            throw AssertionError("RPC health check failed (code=$responseCode)", lastError)
        }
        val rpcResponse = JSONObject(responseText)
        assertTrue("RPC response should contain result", rpcResponse.has("result"))
    }
}
