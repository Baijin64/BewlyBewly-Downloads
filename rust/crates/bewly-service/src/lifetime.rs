//! Idle-exit lease, ported from `native/lifetime.mjs`.
//!
//! On-demand services leave after a fixed 5 s grace period; manually started ones
//! follow `idleExitMinutes`, where 0 means "never". Optional extensions such as
//! `health` and `queryTasks` deliberately do not touch the lease, otherwise a
//! polling UI would keep the process alive forever.

use std::sync::Mutex;

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
}
