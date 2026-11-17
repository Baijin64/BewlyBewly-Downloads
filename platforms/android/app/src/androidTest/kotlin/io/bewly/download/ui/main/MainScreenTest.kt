package io.bewly.download.ui.main

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import io.bewly.download.ui.theme.BewlyBewlyTheme
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/** UI tests for [io.bewly.download.ui.main.MainScreenContent]. */
class MainScreenTest {

  @get:Rule val composeTestRule = createAndroidComposeRule<ComponentActivity>()

  @Before
  fun setup() {
    composeTestRule.setContent {
      BewlyBewlyTheme {
        MainScreenContent(
          benchState =
            BenchUiState(
              isJniOk = true,
              isServiceRunning = true,
              rpcHealth = "健康在线",
              isSessionConfigured = true,
              tasks =
                listOf(
                  TaskItem(
                    id = "t1",
                    title = "Sample Download Task",
                    bvid = "BV1xx411c7mD",
                    status = "completed",
                    progress = 100.0,
                    speed = 0L,
                    downloaded = 1024L,
                    total = 1024L,
                    error = "",
                    output = "/storage/emulated/0/Download/sample.mp4",
                    exportedDisplay = "Movies/BewlyBewly/sample.mp4",
                  )
                ),
            ),
          onVideoInputChange = {},
          onInspectVideo = {},
          onTestExample = {},
          onPauseTask = {},
          onResumeTask = {},
          onRequestDeleteTask = {},
        )
      }
    }
  }

  @Test
  fun mainScreen_rendersTaskAndHeader() {
    composeTestRule.onNodeWithText("Bewly 下载器").assertExists()
    composeTestRule.onNodeWithText("Sample Download Task").assertExists()
    composeTestRule.onNodeWithText("✓ 已保存: Movies/BewlyBewly/sample.mp4").assertExists()
  }
}
