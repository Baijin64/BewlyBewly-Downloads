plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "io.bewly.download"
  compileSdk {
    version = release(37) {
      minorApiLevel = 0
    }
  }
  defaultConfig {
    applicationId = "io.bewly.download"
    minSdk = 26
    targetSdk = 37
    versionCode = 1
    versionName = "0.44.7"

    ndk {
      abiFilters += "arm64-v8a"
    }
  }

  androidResources {
    localeFilters += listOf("zh-rCN", "zh", "en")
  }

  signingConfigs {
    val storePath = System.getenv("BEWLY_ANDROID_KEYSTORE")
    if (!storePath.isNullOrBlank()) {
      create("release") {
        storeFile = file(storePath)
        storePassword = System.getenv("BEWLY_ANDROID_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("BEWLY_ANDROID_KEY_ALIAS")
        keyPassword = System.getenv("BEWLY_ANDROID_KEY_PASSWORD")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  buildFeatures {
    compose = true
    aidl = false
    buildConfig = false
    shaders = false
  }

  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
    // Extract native libraries on install: the bundled FFmpeg executable
    // (jniLibs/<abi>/libffmpeg.so) must exist as a file in nativeLibraryDir to run.
    jniLibs {
      useLegacyPackaging = true
      excludes += "**/librusty_leveldb-*.so"
    }
  }
}

kotlin {
  jvmToolchain(17)
}

dependencies {
  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)
  androidTestImplementation(composeBom)

  // Core Android dependencies
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)

  // Arch Components
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Compose
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  // Tooling
  debugImplementation(libs.androidx.compose.ui.tooling)
  // Instrumented tests
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  debugImplementation(libs.androidx.compose.ui.test.manifest)

  // Local tests: jUnit, coroutines, Android runner
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)

  // Instrumented tests: jUnit rules and runners
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.espresso.core)

  // Navigation
  implementation(libs.androidx.navigation3.ui)
  implementation(libs.androidx.navigation3.runtime)
  implementation(libs.androidx.lifecycle.viewmodel.navigation3)
}
