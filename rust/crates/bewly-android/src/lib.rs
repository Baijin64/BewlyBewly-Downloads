use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring};
use jni::JNIEnv;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::watch;

struct ServiceSlot {
    id: u64,
    shutdown_tx: watch::Sender<bool>,
    stopping: bool,
    thread: Option<JoinHandle<()>>,
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static SERVICE: Mutex<Option<ServiceSlot>> = Mutex::new(None);

fn start_service_with<F>(path: PathBuf, mode_val: String, runner: F) -> bool
where
    F: FnOnce(PathBuf, String, watch::Receiver<bool>) + Send + 'static,
{
    loop {
        let pending_join = {
            let mut guard = match SERVICE.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };

            match guard.as_mut() {
                Some(slot) if !slot.stopping => return true, // Already running
                Some(slot) => slot.thread.take(),
                None => {
                    // Remove stale connection/lock files from any prior killed process before starting.
                    let _ = std::fs::remove_file(path.join("connection.json"));
                    let _ = std::fs::remove_file(path.join("service.lock"));

                    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                    let (tx, rx) = watch::channel(false);
                    RUNNING.store(true, Ordering::SeqCst);

                    let handle = std::thread::spawn(move || {
                        runner(path, mode_val, rx);
                        let mut guard = match SERVICE.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        if guard.as_ref().is_some_and(|slot| slot.id == id) {
                            *guard = None;
                            RUNNING.store(false, Ordering::SeqCst);
                        }
                    });

                    *guard = Some(ServiceSlot {
                        id,
                        shutdown_tx: tx,
                        stopping: false,
                        thread: Some(handle),
                    });
                    return true;
                }
            }
        };

        // Wait outside the mutex for the draining run to finish shutting down so
        // an immediate stop -> start sequence never gets dropped or races on service.lock.
        if let Some(handle) = pending_join {
            let _ = handle.join();
        } else {
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}

fn stop_service_impl() -> bool {
    let mut guard = match SERVICE.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(slot) = guard.as_mut() {
        if !slot.stopping {
            slot.stopping = true;
            RUNNING.store(false, Ordering::SeqCst);
            let _ = slot.shutdown_tx.send(true);
            return true;
        }
    }
    false
}

#[no_mangle]
pub extern "system" fn Java_io_bewly_download_BewlyNative_startService(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    mode: JString,
) -> jboolean {
    let Ok(data_dir_str) = env.get_string(&data_dir) else {
        return 0;
    };
    let Ok(mode_str) = env.get_string(&mode) else {
        return 0;
    };

    let path = PathBuf::from(data_dir_str.to_str().unwrap_or(""));
    let mode_val = mode_str.to_str().unwrap_or("service").to_string();

    let started = start_service_with(path, mode_val, |path, mode_val, rx| {
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
    });

    if started {
        1
    } else {
        0
    }
}

#[no_mangle]
pub extern "system" fn Java_io_bewly_download_BewlyNative_stopService(
    _env: JNIEnv,
    _class: JClass,
) -> jboolean {
    if stop_service_impl() {
        1
    } else {
        0
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    #[test]
    fn start_after_stop_waits_for_draining_run_and_restarts() {
        let starts = Arc::new(AtomicUsize::new(0));
        let temp = std::env::temp_dir().join(format!("bewly-android-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp);

        let s1 = Arc::clone(&starts);
        assert!(start_service_with(
            temp.clone(),
            "service".into(),
            move |_path, _mode, mut rx| {
                s1.fetch_add(1, Ordering::SeqCst);
                while !*rx.borrow() {
                    if rx.has_changed().unwrap_or(false) {
                        let _ = rx.borrow_and_update();
                    } else {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
                // Simulate a brief teardown delay after stopService is signaled.
                std::thread::sleep(Duration::from_millis(60));
            }
        ));

        for _ in 0..50 {
            if starts.load(Ordering::SeqCst) == 1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);

        // Immediately stop and restart while the first thread is still tearing down.
        assert!(stop_service_impl());

        let s2 = Arc::clone(&starts);
        assert!(start_service_with(
            temp.clone(),
            "service".into(),
            move |_path, _mode, mut rx| {
                s2.fetch_add(1, Ordering::SeqCst);
                while !*rx.borrow() {
                    if rx.has_changed().unwrap_or(false) {
                        let _ = rx.borrow_and_update();
                    } else {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
        ));

        for _ in 0..50 {
            if starts.load(Ordering::SeqCst) == 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert!(RUNNING.load(Ordering::SeqCst));

        assert!(stop_service_impl());
        let handle = {
            let mut guard = SERVICE.lock().unwrap();
            guard.as_mut().and_then(|slot| slot.thread.take())
        };
        if let Some(h) = handle {
            let _ = h.join();
        }
        assert!(!RUNNING.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&temp);
    }
}
