//! Local tool jobs: currently BV/AV conversion plus job bookkeeping.

use std::collections::BTreeMap;

use bewly_store::Store;
use serde_json::{json, Value};
use uuid::Uuid;

const ALPHABET: &[u8; 58] = b"FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
const XOR: i64 = 23_442_827_791_579;

/// Port of `convertVideoId` from `native/tools.mjs`.
pub fn convert_video_id(input: &str) -> Result<String, String> {
    let text = input.trim();
    let lower = text.to_ascii_lowercase();
    let numeric = if let Some(rest) = lower.strip_prefix("av") {
        Some(rest.to_string())
    } else if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) {
        Some(text.to_string())
    } else {
        None
    };
    if let Some(digits) = numeric {
        if digits.is_empty()
            || digits.starts_with('0')
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("请输入 BV 或 AV 号".into());
        }
        let aid: i64 = digits.parse().map_err(|_| "AV 号超出支持范围")?;
        if aid >= 1i64 << 51 || aid <= 0 {
            return Err("AV 号超出支持范围".into());
        }
        let mut number = ((1i64 << 51) | aid) ^ XOR;
        let mut chars: Vec<u8> = b"BV1000000000".to_vec();
        let mut index = 11usize;
        while number > 0 {
            chars[index] = ALPHABET[(number % 58) as usize];
            number /= 58;
            if index == 0 {
                break;
            }
            index -= 1;
        }
        chars.swap(3, 9);
        chars.swap(4, 7);
        return Ok(String::from_utf8_lossy(&chars).into_owned());
    }

    let bytes = text.as_bytes();
    if bytes.len() != 12 || !text.starts_with("BV1") {
        return Err("请输入 BV 或 AV 号".into());
    }
    let mut chars = bytes.to_vec();
    chars.swap(3, 9);
    chars.swap(4, 7);
    let mut number: i64 = 0;
    for byte in &chars[3..] {
        let Some(position) = ALPHABET.iter().position(|item| item == byte) else {
            return Err("BV 号包含无效字符".into());
        };
        number = number
            .checked_mul(58)
            .and_then(|value| value.checked_add(position as i64))
            .ok_or("AV 号超出支持范围")?;
    }
    let aid = (number & ((1i64 << 51) - 1)) ^ XOR;
    if convert_video_id(&format!("av{aid}"))? != text {
        return Err("BV 号校验失败".into());
    }
    Ok(format!("av{aid}"))
}

pub fn store_job(store: &Store, job: &Value) -> Result<(), String> {
    let id = job
        .get("id")
        .and_then(Value::as_str)
        .ok_or("工具任务缺少 id")?;
    store.put_job(id, job).map_err(|error| error.to_string())
}

pub fn load_job(store: &Store, id: &str) -> Result<Option<Value>, String> {
    store.get_job(id).map_err(|error| error.to_string())
}

pub fn convert_job(store: &Store, input: &str) -> Result<Value, String> {
    let id = Uuid::new_v4().to_string();
    let created_at = crate::tasks::service_now();
    match convert_video_id(input) {
        Ok(text) => {
            let job = json!({
                "id": id,
                "status": "completed",
                "operation": "convertId",
                "createdAt": created_at,
                "result": { "text": text },
            });
            store_job(store, &job)?;
            Ok(job)
        }
        Err(error) => {
            let job = json!({
                "id": id,
                "status": "failed",
                "operation": "convertId",
                "createdAt": created_at,
                "error": error,
            });
            store_job(store, &job)?;
            Ok(job)
        }
    }
}

pub fn job_map(job: &Value) -> BTreeMap<String, Value> {
    job.as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_published_identifiers() {
        assert_eq!(convert_video_id("av170001").unwrap(), "BV17x411w7KC");
        assert_eq!(convert_video_id("BV17x411w7KC").unwrap(), "av170001");
        assert_eq!(convert_video_id("170001").unwrap(), "BV17x411w7KC");
    }

    #[test]
    fn rejects_invalid_input() {
        assert_eq!(convert_video_id("hello").unwrap_err(), "请输入 BV 或 AV 号");
        assert_eq!(
            convert_video_id("BV17x411w7K!").unwrap_err(),
            "BV 号包含无效字符"
        );
        assert_eq!(convert_video_id("av0").unwrap_err(), "请输入 BV 或 AV 号");
    }

    #[test]
    fn round_trips_a_large_range() {
        for aid in [1i64, 2, 17, 999_999, 170_001, 1 << 40] {
            let bvid = convert_video_id(&format!("av{aid}")).unwrap();
            assert_eq!(convert_video_id(&bvid).unwrap(), format!("av{aid}"));
        }
    }
}
