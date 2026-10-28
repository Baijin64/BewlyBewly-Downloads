//! Idle-exit lease, ported from `native/lifetime.mjs`.
//!
//! On-demand services leave after a fixed 5 s grace period; manually started ones
//! follow `idleExitMinutes`, where 0 means "never". Optional extensions such as
//! `health` and `queryTasks` deliberately do not touch the lease, otherwise a
//! polling UI would keep the process alive forever.

use std::collections::HashSet;
use std::sync::Mutex;
use serde_json::Value;

pub const ON_DEMAND_GRACE_MS: i64 = 5000;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Runtime {
    pub mode: String,
    pub state: &'static str,
    pub exit_at: Option<i64>,
}

pub struct Lifetime {
    mode: String,
    idle_since: Option<i64>,
    grace_ms: i64,
}

impl Lifetime {
    pub fn new(mode: &str) -> Self {
        let grace_ms = std::env::var("BEWLY_IDLE_GRACE_MS")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(ON_DEMAND_GRACE_MS);
        Self {
            mode: if mode == "on-demand" {
                "on-demand".into()
            } else {
                "manual".into()
            },
            idle_since: Some(now_ms()),
            grace_ms,
        }
    }

    pub fn manual(&mut self) {
        self.mode = "manual".into();
        self.idle_since = Some(now_ms());
    }

    pub fn touch(&mut self) {
        self.idle_since = Some(now_ms());
    }

    pub fn mode(&self) -> &str {
        &self.mode
    }

    pub fn snapshot(&mut self, busy: bool, manual_idle_minutes: u32) -> Runtime {
        let now = now_ms();
        if busy {
            self.idle_since = None;
        } else if self.idle_since.is_none() {
            self.idle_since = Some(now);
        }
        let delay = if self.mode == "on-demand" {
            self.grace_ms
        } else {
            i64::from(manual_idle_minutes) * 60_000
        };
        let exit_at = if !busy && delay > 0 {
            self.idle_since.map(|since| since + delay)
        } else {
            None
        };
        Runtime {
            mode: self.mode.clone(),
            state: if busy { "busy" } else { "idle" },
            exit_at,
        }
    }
}

pub struct SharedLifetime(pub Mutex<Lifetime>);

impl SharedLifetime {
    pub fn new(mode: &str) -> Self {
        Self(Mutex::new(Lifetime::new(mode)))
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Lifetime> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Completion policy ported from `native/completion.mjs`.
/// Coordinates scheduled shutdown after queued/started tasks succeed.
#[derive(Debug, Default, Clone)]
pub struct CompletionPolicy {
    pub ids: HashSet<String>,
    pub due: i64,
    pub cancelled: bool,
    pub completed: u64,
}

impl CompletionPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(&mut self, tasks: &[Value]) {
        let has_active = tasks.iter().any(|task| {
            let status = task.get("status").and_then(Value::as_str).unwrap_or("");
            matches!(
                status,
                "queued" | "resolving" | "downloading" | "paused" | "muxing" | "postprocessing"
            )
        });
        if !has_active {
            self.ids.clear();
            self.cancelled = false;
        }
        self.due = 0;
    }

    pub fn started(&mut self, id: &str) {
        self.ids.insert(id.to_string());
        self.due = 0;
    }

    pub fn finished(&mut self) {
        self.completed += 1;
    }

    pub fn cancel(&mut self) {
        self.cancelled = true;
        self.due = 0;
    }

    pub fn evaluate(&mut self, tasks: &[Value], enabled: bool, now: i64) -> i64 {
        let waiting = tasks.iter().any(|task| {
            let status = task.get("status").and_then(Value::as_str).unwrap_or("");
            matches!(
                status,
                "pending"
                    | "queued"
                    | "resolving"
                    | "downloading"
                    | "paused"
                    | "muxing"
                    | "postprocessing"
            )
        });
        let all_succeeded = !self.ids.is_empty()
            && self.ids.iter().all(|id| {
                if let Some(task) = tasks
                    .iter()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str()))
                {
                    let is_completed =
                        task.get("status").and_then(Value::as_str) == Some("completed");
                    let no_warnings = match task.get("warnings") {
                        None => true,
                        Some(Value::Null) => true,
                        Some(Value::Array(arr)) => arr.is_empty(),
                        _ => false,
                    };
                    is_completed && no_warnings
                } else {
                    false
                }
            });

        if !enabled || waiting || !all_succeeded || self.cancelled {
            self.due = 0;
            return 0;
        }
        if self.due == 0 {
            self.due = now + 30_000;
        }
        self.due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_demand_exits_after_the_five_second_grace() {
        let mut lifetime = Lifetime::new("on-demand");
        let runtime = lifetime.snapshot(false, 0);
        assert_eq!(runtime.state, "idle");
        assert!(runtime.exit_at.is_some());
        let exit_at = runtime.exit_at.unwrap();
        assert!((exit_at - now_ms() - 5000).abs() < 200);
    }

    #[test]
    fn busy_resets_the_lease_and_suppresses_the_exit() {
        let mut lifetime = Lifetime::new("on-demand");
        let busy = lifetime.snapshot(true, 0);
        assert_eq!(busy.state, "busy");
        assert!(busy.exit_at.is_none());
        let idle = lifetime.snapshot(false, 0);
        assert!(idle.exit_at.is_some());
    }

    #[test]
    fn manual_zero_never_exits_and_minutes_do() {
        let mut lifetime = Lifetime::new("manual");
        assert!(lifetime.snapshot(false, 0).exit_at.is_none());
        let runtime = lifetime.snapshot(false, 30);
        assert!(runtime.exit_at.is_some());
        assert!((runtime.exit_at.unwrap() - now_ms() - 1_800_000).abs() < 500);
    }

    #[test]
    fn touching_extends_the_lease() {
        let mut lifetime = Lifetime::new("on-demand");
        let first = lifetime.snapshot(false, 0).exit_at.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        lifetime.touch();
        let second = lifetime.snapshot(false, 0).exit_at.unwrap();
        assert!(second > first);
    }

    #[test]
    fn completion_policy_shutdown_lifecycle() {
        let mut policy = CompletionPolicy::new();
        let old = serde_json::json!([{ "id": "old", "status": "completed" }]);
        assert_eq!(policy.evaluate(old.as_array().unwrap(), true, 100), 0);

        policy.begin(&[]);
        policy.started("one");
        policy.finished();
        assert_eq!(policy.completed, 1);

        let completed = serde_json::json!([{ "id": "one", "status": "completed" }]);
        assert_eq!(policy.evaluate(completed.as_array().unwrap(), false, 100), 0);
        assert_eq!(
            policy.evaluate(completed.as_array().unwrap(), true, 100),
            30100
        );
        assert_eq!(
            policy.evaluate(completed.as_array().unwrap(), true, 1100),
            30100
        );

        let with_pending = serde_json::json!([
            { "id": "one", "status": "completed" },
            { "id": "later", "status": "pending" }
        ]);
        assert_eq!(
            policy.evaluate(with_pending.as_array().unwrap(), true, 2100),
            0
        );
    }

    #[test]
    fn completion_policy_suppressed_by_active_or_warnings() {
        for status in [
            "pending",
            "paused",
            "failed",
            "cancelled",
            "queued",
            "muxing",
            "postprocessing",
        ] {
            let mut policy = CompletionPolicy::new();
            policy.started("one");
            let tasks = serde_json::json!([{ "id": "one", "status": status }]);
            assert_eq!(policy.evaluate(tasks.as_array().unwrap(), true, 100), 0);
        }

        let mut removed_policy = CompletionPolicy::new();
        removed_policy.started("removed");
        assert_eq!(removed_policy.evaluate(&[], true, 100), 0);

        let mut warning_policy = CompletionPolicy::new();
        warning_policy.started("one");
        let warning_tasks = serde_json::json!([
            { "id": "one", "status": "completed", "warnings": ["字幕下载失败"] }
        ]);
        assert_eq!(
            warning_policy.evaluate(warning_tasks.as_array().unwrap(), true, 100),
            0
        );
    }

    #[test]
    fn completion_policy_cancellation() {
        let mut policy = CompletionPolicy::new();
        policy.started("one");
        let tasks = serde_json::json!([{ "id": "one", "status": "completed" }]);
        assert_eq!(policy.evaluate(tasks.as_array().unwrap(), true, 100), 30100);

        policy.cancel();
        assert_eq!(policy.evaluate(tasks.as_array().unwrap(), true, 100000), 0);

        policy.begin(tasks.as_array().unwrap());
        policy.started("two");
        let tasks2 = serde_json::json!([
            { "id": "one", "status": "completed" },
            { "id": "two", "status": "completed" }
        ]);
        assert_eq!(
            policy.evaluate(tasks2.as_array().unwrap(), true, 100000),
            130000
        );
    }
}
