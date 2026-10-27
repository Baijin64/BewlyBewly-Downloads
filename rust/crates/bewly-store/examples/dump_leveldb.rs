// Dumps every raw key/value pair of a LevelDB directory for debugging.
//
//   cargo run -p bewly-store --example dump_leveldb -- <directory>

use std::path::Path;

use rusty_leveldb::LdbIterator;

fn main() {
    let directory = std::env::args().nth(1).expect("usage: dump_leveldb <dir>");
    let options = rusty_leveldb::Options {
        create_if_missing: false,
        ..Default::default()
    };
    let mut database = rusty_leveldb::DB::open(Path::new(&directory), options).expect("open");
    let mut iterator = database.new_iter().expect("iterator");
    iterator.seek_to_first();
    let mut key = Vec::new();
    let mut value = Vec::new();
    while iterator.valid() {
        if iterator.current(&mut key, &mut value) {
            let name: String = key
                .iter()
                .skip_while(|byte| **byte != 0)
                .skip(2)
                .map(|byte| char::from(*byte))
                .collect();
            println!(
                "name={name:<20} key={} value={}",
                key.len(),
                value
                    .iter()
                    .take(6)
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<Vec<_>>()
                    .join("")
            );
        }
        iterator.advance();
    }
}
