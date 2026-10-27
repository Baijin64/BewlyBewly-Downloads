// Proves that a Chromium Local Storage LevelDB written by the Node toolchain can
// be read by the Rust implementation, including the compacted .ldb block path.

use std::path::PathBuf;

use bewly_store::local_storage::{decode_entry, is_whitelisted, LocalStorageEntry};
use rusty_leveldb::LdbIterator;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/localstorage-leveldb")
}

fn read_all(path: &std::path::Path) -> Vec<LocalStorageEntry> {
    let options = rusty_leveldb::Options {
        create_if_missing: false,
        ..Default::default()
    };
    let mut database = rusty_leveldb::DB::open(path, options).expect("open leveldb");
    let mut entries = Vec::new();
    let mut iterator = database.new_iter().expect("iterator");
    iterator.seek_to_first();
    // `seek_to_first` already positions on the first record; calling `next()`
    // here would drop it, which is exactly how a migration loses a setting.
    let mut key = Vec::new();
    let mut value = Vec::new();
    while iterator.valid() {
        if iterator.current(&mut key, &mut value) {
            if let Some(entry) = decode_entry(&key, &value) {
                entries.push(entry);
            }
        }
        iterator.advance();
    }
    entries
}

#[test]
fn reads_browser_local_storage_from_a_real_leveldb() {
    let entries = read_all(&fixture());
    assert_eq!(entries.len(), 5, "unexpected entries: {entries:?}");

    let setting = entries
        .iter()
        .find(|entry| entry.origin == "_app://." && entry.name == "setting")
        .expect("app setting missing");
    assert!(setting.value.contains("\"videoQn\":\"112\""));

    let path = entries
        .iter()
        .find(|entry| entry.name == "defaultDownPath")
        .expect("legacy path missing");
    assert!(path.value.ends_with("视频"));

    // The invalid UTF-16 payload must be dropped instead of decoded.
    assert!(!entries.iter().any(|entry| entry.name == "user"));

    // A _file:// origin is readable but only whitelisted names may be consumed.
    let file_origin = entries
        .iter()
        .find(|entry| entry.origin == "_file://.")
        .expect("file origin missing");
    assert!(!is_whitelisted(&file_origin.name));
}
