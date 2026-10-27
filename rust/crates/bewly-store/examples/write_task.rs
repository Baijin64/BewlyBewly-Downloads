// Writes one task through the Rust store so the Node implementation can be asked
// to read it back (see rust/tools/verify-node-reads-rust.mjs).
//
//   cargo run -p bewly-store --example write_task -- <data-directory>

use std::path::Path;

use bewly_store::Store;
use serde_json::json;

fn main() {
    let directory = std::env::args()
        .nth(1)
        .expect("usage: write_task <data-directory>");
    let store = Store::open(Path::new(&directory)).expect("open store");
    let task = json!({
        "id": "rust-written",
        "bvid": "BV1xx411c7mD",
        "cid": 99,
        "title": "Rust 写入的任务",
        "part": "P1",
        "page": 1,
        "pageCount": 1,
        "author": "UP主",
        "uid": 1,
        "pubdate": 1700000000,
        "description": "",
        "cover": "",
        "directory": "C:\\Videos",
        "options": {
            "quality": 80,
            "codec": "auto",
            "audioQuality": "auto",
            "mode": "video",
            "cover": false,
            "subtitles": false,
            "outputs": ["video"],
            "subtitleLanguages": [],
            "filenameTemplate": "%title% [%bv%-%cid%]",
            "folderTemplate": "",
            "createFolder": false,
            "createFolderAddIndex": false
        },
        "status": "pending",
        "stage": "video",
        "progress": 0,
        "speed": 0,
        "error": "",
        "artifacts": {},
        "warnings": [],
        "createdAt": "2026-10-27T00:00:00.000Z",
        "unknownFutureField": { "kept": true }
    });
    store.put_task(&task).expect("write task");
    store
        .put_settings(&json!({ "directory": "C:\\Videos", "maxConcurrent": 3 }))
        .expect("write settings");
    let tasks = store.tasks().expect("list tasks");
    println!("rust store now holds {} tasks", tasks.len());
}
