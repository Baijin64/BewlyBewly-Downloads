use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring};
use jni::JNIEnv;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tokio::sync::watch;

static RUNNING: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_TX: Mutex<Option<watch::Sender<bool>>> = Mutex::new(None);

#[no_mangle]
pub extern "system" fn Java_io_bewly_download_BewlyNative_startService(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    mode: JString,
) -> jboolean {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return 1; // Already running
    }

    let Ok(data_dir_str) = env.get_string(&data_dir) else {
        RUNNING.store(false, Ordering::SeqCst);
        return 0;
    };
    let Ok(mode_str) = env.get_string(&mode) else {
        RUNNING.store(false, Ordering::SeqCst);
        return 0;
    };

    let path = PathBuf::from(data_dir_str.to_str().unwrap_or(""));
    let mode_val = mode_str.to_str().unwrap_or("service").to_string();

    // Remove stale connection/lock files from any prior killed process before starting.
    let _ = std::fs::remove_file(path.join("connection.json"));
    let _ = std::fs::remove_file(path.join("service.lock"));

    let (tx, rx) = watch::channel(false);
    if let Ok(mut guard) = SHUTDOWN_TX.lock() {
        *guard = Some(tx);
    }

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("Failed to build Tokio runtime for BewlyService");

        rt.block_on(async {
            if let Err(err) = bewly_service::run_with_shutdown(path, mode_val, rx).await {
                eprintln!("[BewlyNative] Service error: {}", err);
            }
        });
        if let Ok(mut guard) = SHUTDOWN_TX.lock() {
            *guard = None;
        }
        RUNNING.store(false, Ordering::SeqCst);
    });

    1
}

#[no_mangle]
pub extern "system" fn Java_io_bewly_download_BewlyNative_stopService(
    _env: JNIEnv,
    _class: JClass,
) -> jboolean {
    if let Ok(mut guard) = SHUTDOWN_TX.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(true);
            return 1;
        }
    }
    0
}

#[no_mangle]
pub extern "system" fn Java_io_bewly_download_BewlyNative_ping(
    env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = json!({
        "pong": true,
        "engine": "rust",
        "service_running": RUNNING.load(Ordering::Relaxed)
    });
    env.new_string(result.to_string())
        .expect("Failed to create Java string")
        .into_raw()
}
