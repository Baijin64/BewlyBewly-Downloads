package io.bewly.download.ui.main

import io.bewly.download.data.DataRepository
import junit.framework.TestCase.assertEquals
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import org.junit.Test

class MainScreenViewModelTest {
  @Test
  fun uiState_initiallyLoading() = runTest {
    val viewModel = MainScreenViewModel(FakeMyModelRepository())
    assertEquals(viewModel.uiState.first(), MainScreenUiState.Loading)
  }

  @Test
  fun uiState_onItemSaved_isDisplayed() = runTest {
    val viewModel = MainScreenViewModel(FakeMyModelRepository())
    assertEquals(viewModel.uiState.first(), MainScreenUiState.Loading)
  }

  @Test
  fun benchState_videoInputInitiallyEmpty() {
    val viewModel = MainScreenViewModel(FakeMyModelRepository())
    assertEquals("", viewModel.benchState.value.videoInput)
  }

  @Test
  fun extractBiliTarget_variousInputs() {
    // 1. Direct BV ID
    assertEquals("BV1xx411c7mD", MainScreenViewModel.extractBiliTarget("BV1xx411c7mD"))
    assertEquals("BV1xx411c7mD", MainScreenViewModel.extractBiliTarget("   BV1xx411c7mD   "))

    // 2. Share text containing BV
    val shareWithBv = "【猛男版新宝岛】 https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.337"
    assertEquals("BV1xx411c7mD", MainScreenViewModel.extractBiliTarget(shareWithBv))

    // 3. Short URL b23.tv without BV in URL
    val shortLink = "【猛男版】点开查看 https://b23.tv/abcdef"
    assertEquals("https://b23.tv/abcdef", MainScreenViewModel.extractBiliTarget(shortLink))

    // 4. Empty input
    assertEquals("", MainScreenViewModel.extractBiliTarget(""))
    assertEquals("", MainScreenViewModel.extractBiliTarget("    "))
  }

  @Test
  fun setQualityAndOutputMode() {
    val viewModel = MainScreenViewModel(FakeMyModelRepository())
    viewModel.setQuality(120)
    assertEquals(120, viewModel.benchState.value.selectedQuality)

    viewModel.setOutputMode("audio")
    assertEquals("audio", viewModel.benchState.value.selectedOutputMode)
  }

  @Test
  fun setFilter_updatesState() {
    val viewModel = MainScreenViewModel(FakeMyModelRepository())
    viewModel.setFilter(TaskFilter.COMPLETED)
    assertEquals(TaskFilter.COMPLETED, viewModel.benchState.value.selectedFilter)
  }
}

private class FakeMyModelRepository : DataRepository {
  override val data: Flow<List<String>> = flow { emit(listOf("Sample")) }
}
