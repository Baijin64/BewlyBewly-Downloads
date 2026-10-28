use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring};
use jni::JNIEnv;
use serde_json::json;

static RUNNING: AtomicBool = AtomicBool::new(false);

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

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to build Tokio runtime for BewlyService");

        rt.block_on(async {
            if let Err(err) = bewly_service::run(path, mode_val).await {
                eprintln!("[BewlyNative] Service error: {}", err);
            }
        });
        RUNNING.store(false, Ordering::SeqCst);
    });

    1
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
