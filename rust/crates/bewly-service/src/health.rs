//! Health payload and the read-only UI snapshot.

use std::io::Write;
use std::path::Path;

use serde_json::{json, Value};

use crate::settings::{Settings, VERSION};
use crate::tasks::{ui_task, Counts};

#[derive(Debug, Clone, Copy)]
pub struct PlatformCaps {
    pub tray: bool,
    pub picker: bool,
    pub shutdown: bool,
}

impl PlatformCaps {
    pub fn current() -> Self {
        Self {
            tray: cfg!(target_os = "windows") || cfg!(target_os = "macos"),
            picker: true,
            shutdown: cfg!(target_os = "windows")
                || cfg!(target_os = "macos")
                || cfg!(target_os = "linux"),
        }
    }
}

pub fn capabilities(caps: PlatformCaps) -> Vec<&'static str> {
    let mut list = vec![
        "on-demand",
        "pending",
        "batch",
        "audio-highest",
        "formats",
        "naming",
        "collections",
        "tools",
        "migration",
    ];
    if caps.tray {
        list.push("tray");
    }
    if caps.picker {
        list.push("picker");
    }
    if caps.shutdown {
        list.push("shutdown");
    }
    list
}

pub fn health(
    settings: &Settings,
    storage_error: &str,
    last_tray: i64,
    caps: PlatformCaps,
) -> Value {
    json!({
        "version": VERSION,
        "protocol": crate::settings::PROTOCOL,
        "storageError": storage_error,
        "lastTrayContact": last_tray,
        "capabilities": capabilities(caps),
        "settings": settings,
        "engineInstalled": true,
    })
}

/// Writes `ui-snapshot.json` atomically, capped at 200 tasks and ~650 KB just
/// like `native/snapshot.mjs`, so the extension can render while offline.
pub fn write(
    data_directory: &Path,
    health: &Value,
    tasks: &[Value],
    counts: &Counts,
) -> std::io::Result<()> {
    const BUDGET: usize = 650_000;
    let mut items = Vec::new();
    let mut used = 0usize;
    for task in tasks.iter().take(200) {
        let projected = ui_task(task);
        let size = serde_json::to_vec(&projected)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        if used + size > BUDGET && !items.is_empty() {
            break;
        }
        used += size;
        items.push(projected);
    }
    let snapshot = json!({
        "health": health,
        "items": items,
        "counts": counts,
        "syncedAt": crate::tasks::service_now(),
    });
    let payload = serde_json::to_vec(&snapshot)?;
    let temporary = data_directory.join("ui-snapshot.json.tmp");
    let target = data_directory.join("ui-snapshot.json");
    std::fs::create_dir_all(data_directory)?;
    {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(&payload)?;
        file.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temporary, &target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_exposes_the_required_capabilities() {
        let value = health(&Settings::default(), "", 0, PlatformCaps::current());
        let capabilities = value["capabilities"].as_array().unwrap();
        assert!(capabilities.iter().any(|item| item == "audio-highest"));
        assert_eq!(value["protocol"], 2);
        assert_eq!(value["version"], VERSION);
    }
}
