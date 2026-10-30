package io.bewly.download

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

sealed interface RpcResult {
    data class Success(val result: Any?, val runtime: JSONObject?) : RpcResult
    data class Error(val message: String) : RpcResult
}

class BewlyRpcClient(
    val port: Int,
    val token: String
) {
    val baseUrl: String = "http://127.0.0.1:$port/rpc"

    fun call(method: String, params: JSONObject = JSONObject()): RpcResult {
        return try {
            val url = URL(baseUrl)
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 4000
            conn.readTimeout = 20000
            conn.doOutput = true
            conn.doInput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.setRequestProperty("Authorization", "Bearer $token")

            val payload = JSONObject().apply {
                put("method", method)
                put("params", params)
            }.toString()

            conn.outputStream.use { os ->
                OutputStreamWriter(os, "UTF-8").use { writer ->
                    writer.write(payload)
                    writer.flush()
                }
            }

            val statusCode = conn.responseCode
            val stream = if (statusCode in 200..299) conn.inputStream else conn.errorStream
            val responseText = stream?.use { s ->
                BufferedReader(InputStreamReader(s, "UTF-8")).readText()
            } ?: ""

            if (statusCode !in 200..299) {
                return RpcResult.Error("HTTP $statusCode: $responseText")
            }

            val json = JSONObject(responseText)
            if (json.optBoolean("ok", false)) {
                RpcResult.Success(json.opt("result"), json.optJSONObject("runtime"))
            } else {
                RpcResult.Error(json.optString("error", "未知错误"))
            }
        } catch (e: Exception) {
            Log.e("BewlyRpcClient", "RPC call failed: $method", e)
            RpcResult.Error(e.message ?: "网络连接异常")
        }
    }

    fun health(): RpcResult = call("health")

    fun setSession(cookie: String): RpcResult {
        val params = JSONObject().apply {
            put("session", cookie)
        }
        return call("setSession", params)
    }

    fun configure(directory: String): RpcResult {
        val patch = JSONObject().apply {
            put("directory", directory)
        }
        return call("configure", patch)
    }

    fun inspect(video: String): RpcResult {
        val params = JSONObject().apply {
            put("video", video)
        }
        return call("inspect", params)
    }

    fun createTasks(
        info: JSONObject,
        cids: List<Long>,
        options: JSONObject = JSONObject().apply {
            put("quality", 80)
            put("codec", "hev1")
            put("format", "mp4")
            put("outputs", JSONArray().apply { put("video") })
        }
    ): RpcResult {
        val cidsArray = JSONArray().apply {
            cids.forEach { put(it) }
        }
        val params = JSONObject().apply {
            put("info", info)
            put("cids", cidsArray)
            put("options", options)
        }
        return call("createTasks", params)
    }

    fun queryTasks(filter: String = "all"): RpcResult {
        val params = JSONObject().apply {
            put("filter", filter)
        }
        return call("queryTasks", params)
    }

    fun taskAction(id: String, action: String): RpcResult {
        val params = JSONObject().apply {
            put("id", id)
            put("action", action)
        }
        return call("taskAction", params)
    }

    fun clearCompletedTasks(): RpcResult {
        val params = JSONObject().apply {
            put("action", "clearCompleted")
        }
        return call("batchAction", params)
    }
}
