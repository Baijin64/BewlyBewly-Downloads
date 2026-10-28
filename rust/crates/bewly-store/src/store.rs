//! SQLite access.
//!
//! Schema, `user_version`, the pre-v2 backup and the interrupted-task reset are
//! copied verbatim from `native/core.mjs`. Rows stay JSON-in-TEXT so unknown
//! fields written by a newer build survive a round trip through this crate.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use thiserror::Error;

const ACTIVE_STATES: [&str; 4] = ["resolving", "downloading", "muxing", "postprocessing"];

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("数据库操作失败：{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("数据库记录缺少 id")]
    MissingId,
    #[error("任务数据不是合法的 JSON：{0}")]
    Json(#[from] serde_json::Error),
    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),
}

pub struct Store {
    connection: Connection,
    directory: PathBuf,
}

impl Store {
    /// Opens (and if needed creates) the database, then applies the same
    /// migration the Node build applies on startup.
    pub fn open(directory: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(directory)?;
        let connection = Connection::open(directory.join("downloads.sqlite"))?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;

        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let has_tasks: bool = connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some();

        if has_tasks && version < 2 {
            let stamp = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
            let backup = directory.join(format!("downloads.pre-v2-{stamp}.sqlite"));
            let escaped = backup.to_string_lossy().replace('\'', "''");
            connection.execute_batch(&format!("VACUUM INTO '{escaped}'"))?;
        }

        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS tool_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS migration_previews (id TEXT PRIMARY KEY, data TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS task_status ON tasks(json_extract(data,'$.status'));
             PRAGMA user_version=2;",
        )?;

        let store = Self {
            connection,
            directory: directory.to_path_buf(),
        };
        store.reset_interrupted()?;
        store.reset_interrupted_jobs()?;
        Ok(store)
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        Ok(self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    /// Interrupted tasks return to the queue with their progress reset, exactly
    /// like the Node constructor does before the scheduler starts.
    pub fn reset_interrupted(&self) -> Result<usize, StoreError> {
        let updated_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        // The state list is a compile-time constant, so it is inlined instead of
        // going through a dynamically built parameter vector.
        let sql = format!(
            "UPDATE tasks
                SET data = json_set(json_remove(data,'$.prepared'),'$.status','queued','$.speed',0,'$.error','','$.updatedAt',?)
              WHERE json_extract(data,'$.status') IN ('{}')",
            ACTIVE_STATES.join("','")
        );
        Ok(self.connection.execute(&sql, params![updated_at])?)
    }

    /// Interrupted tool jobs are marked failed on startup so the user can retry.
    pub fn reset_interrupted_jobs(&self) -> Result<usize, StoreError> {
        let sql = "UPDATE tool_jobs
            SET data = json_set(data, '$.status', 'failed', '$.error', '助手重启中断了工具操作，请重试')
          WHERE json_extract(data, '$.status') = 'running'";
        Ok(self.connection.execute(sql, [])?)
    }

    pub fn tasks(&self) -> Result<Vec<Value>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT data FROM tasks ORDER BY rowid DESC")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(serde_json::from_str(&row?)?);
        }
        Ok(tasks)
    }

    pub fn task(&self, id: &str) -> Result<Option<Value>, StoreError> {
        let data: Option<String> = self
            .connection
            .query_row("SELECT data FROM tasks WHERE id = ?", params![id], |row| {
                row.get(0)
            })
            .optional()?;
        match data {
            Some(text) => Ok(Some(serde_json::from_str(&text)?)),
            None => Ok(None),
        }
    }

    pub fn put_task(&self, task: &Value) -> Result<(), StoreError> {
        let id = task
            .get("id")
            .and_then(Value::as_str)
            .ok_or(StoreError::MissingId)?;
        self.connection.execute(
            "INSERT INTO tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![id, serde_json::to_string(task)?],
        )?;
        Ok(())
    }

    pub fn remove_task(&self, id: &str) -> Result<usize, StoreError> {
        Ok(self
            .connection
            .execute("DELETE FROM tasks WHERE id=?", params![id])?)
    }

    pub fn put_preview(&self, id: &str, preview: &Value) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO migration_previews(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![id, serde_json::to_string(preview)?],
        )?;
        self.connection.execute(
            "DELETE FROM migration_previews WHERE rowid NOT IN (SELECT rowid FROM migration_previews ORDER BY rowid DESC LIMIT 3)",
            [],
        )?;
        Ok(())
    }

    pub fn get_preview(&self, id: &str) -> Result<Option<Value>, StoreError> {
        let data: Option<String> = self
            .connection
            .query_row(
                "SELECT data FROM migration_previews WHERE id = ?",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        match data {
            Some(text) => Ok(Some(serde_json::from_str(&text)?)),
            None => Ok(None),
        }
    }

    pub fn remove_preview(&self, id: &str) -> Result<(), StoreError> {
        self.connection
            .execute("DELETE FROM migration_previews WHERE id=?", params![id])?;
        Ok(())
    }

    pub fn put_job(&self, id: &str, job: &Value) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO tool_jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![id, serde_json::to_string(job)?],
        )?;
        Ok(())
    }

    pub fn get_job(&self, id: &str) -> Result<Option<Value>, StoreError> {
        let data: Option<String> = self
            .connection
            .query_row(
                "SELECT data FROM tool_jobs WHERE id = ?",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        match data {
            Some(text) => Ok(Some(serde_json::from_str(&text)?)),
            None => Ok(None),
        }
    }

    pub fn settings(&self) -> Result<Option<Value>, StoreError> {
        let data: Option<String> = self
            .connection
            .query_row("SELECT data FROM settings WHERE id=1", [], |row| row.get(0))
            .optional()?;
        match data {
            Some(text) => Ok(Some(serde_json::from_str(&text)?)),
            None => Ok(None),
        }
    }

    pub fn put_settings(&self, settings: &Value) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![serde_json::to_string(settings)?],
        )?;
        Ok(())
    }

    /// Textual query plan, used by the compatibility tests to prove that the
    /// expression index is still selected.
    pub fn query_plan(&self, sql: &str) -> Result<Vec<String>, StoreError> {
        let mut statement = self
            .connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let rows = statement.query_map([], |row| row.get::<_, String>(3))?;
        let mut plan = Vec::new();
        for row in rows {
            plan.push(row?);
        }
        Ok(plan)
    }

    pub fn close(self) -> Result<(), StoreError> {
        self.connection.close().map_err(|(_, error)| error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/downloads.sqlite");

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "bewly-store-{}-{}",
                std::process::id(),
                time::OffsetDateTime::now_utc().unix_timestamp_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn with_fixture() -> Self {
            let temp = Self::new();
            std::fs::write(temp.0.join("downloads.sqlite"), FIXTURE).unwrap();
            temp
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_the_node_fixture_and_resets_interrupted_tasks() {
        let temp = TempDir::with_fixture();
        let store = Store::open(&temp.0).unwrap();
        assert_eq!(store.schema_version().unwrap(), 2);

        let tasks = store.tasks().unwrap();
        assert_eq!(tasks.len(), 3);

        let active = store.task("task-active").unwrap().unwrap();
        assert_eq!(active["status"], "queued");
        assert_eq!(active["speed"], 0.0);
        assert_eq!(active["error"], "");
        assert!(active.get("prepared").is_none());

        let completed = store.task("task-done").unwrap().unwrap();
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["progress"], 100);

        let settings = store.settings().unwrap().unwrap();
        assert_eq!(settings["maxConcurrent"], 2);
        assert_eq!(settings["directory"], "C:\\Videos");
    }

    #[test]
    fn keeps_the_expression_index_for_status_queries() {
        let temp = TempDir::with_fixture();
        let store = Store::open(&temp.0).unwrap();
        let plan = store
            .query_plan("SELECT data FROM tasks WHERE json_extract(data,'$.status') IN ('pending')")
            .unwrap()
            .join(" | ");
        assert!(
            plan.contains("task_status"),
            "expression index not used: {plan}"
        );
    }

    #[test]
    fn backs_up_a_pre_v2_database_before_migrating() {
        let temp = TempDir::new();
        {
            let connection = Connection::open(temp.0.join("downloads.sqlite")).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                     INSERT INTO tasks(id,data) VALUES('legacy','{\"id\":\"legacy\",\"status\":\"completed\"}');",
                )
                .unwrap();
        }
        let store = Store::open(&temp.0).unwrap();
        assert_eq!(store.schema_version().unwrap(), 2);
        assert!(store.task("legacy").unwrap().is_some());
        let backups: Vec<_> = std::fs::read_dir(&temp.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("downloads.pre-v2-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "expected exactly one pre-v2 backup");
    }

    #[test]
    fn round_trips_unknown_fields_without_dropping_them() {
        let temp = TempDir::new();
        let store = Store::open(&temp.0).unwrap();
        let task = serde_json::json!({
            "id": "round-trip",
            "status": "pending",
            "title": "测试",
            "futureField": { "nested": [1, 2, 3] }
        });
        store.put_task(&task).unwrap();
        let read = store.task("round-trip").unwrap().unwrap();
        assert_eq!(read, task);
    }

    #[test]
    fn persists_settings_for_the_next_process() {
        let temp = TempDir::new();
        {
            let store = Store::open(&temp.0).unwrap();
            store
                .put_settings(
                    &serde_json::json!({ "directory": "D:\\\\Media", "maxConcurrent": 4 }),
                )
                .unwrap();
            store.close().unwrap();
        }
        let store = Store::open(&temp.0).unwrap();
        let settings = store.settings().unwrap().unwrap();
        assert_eq!(settings["maxConcurrent"], 4);
    }

    #[test]
    fn resets_interrupted_tool_jobs_on_open() {
        let temp = TempDir::new();
        {
            let store = Store::open(&temp.0).unwrap();
            store
                .put_job(
                    "job-running",
                    &serde_json::json!({ "id": "job-running", "status": "running" }),
                )
                .unwrap();
            store
                .put_job(
                    "job-completed",
                    &serde_json::json!({ "id": "job-completed", "status": "completed" }),
                )
                .unwrap();
            store.close().unwrap();
        }

        let reopened = Store::open(&temp.0).unwrap();
        let running = reopened.get_job("job-running").unwrap().unwrap();
        assert_eq!(running["status"], "failed");
        assert_eq!(running["error"], "助手重启中断了工具操作，请重试");

        let completed = reopened.get_job("job-completed").unwrap().unwrap();
        assert_eq!(completed["status"], "completed");
    }
}
