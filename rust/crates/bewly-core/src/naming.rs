//! File naming and folder planning.
//!
//! Faithful port of `native/naming.mjs`. The rules look cosmetic but they decide
//! the on-disk layout, so every subtle detail (UTF-16 truncation, reserved device
//! names, the literal after `%index%` when a video is not a collection) is kept.

use std::borrow::Cow;

use unicode_normalization::UnicodeNormalization;

/// `%v%` is frozen at the value the Node implementation wrote into file names.
/// It must NOT follow the product version, otherwise upgrading renames files.
pub const NAMING_VERSION: &str = "0.2.8";

const TOKENS: [&str; 15] = [
    "title",
    "upnn",
    "uid",
    "aqn",
    "vqn",
    "bv",
    "cid",
    "index",
    "part",
    "collection",
    "vtype",
    "upnn-uid",
    "uid-upnn",
    "v",
    "dd",
];

#[derive(Debug, Clone, Default)]
pub struct Group {
    pub index: u32,
    pub title: String,
    pub id: String,
}

#[derive(Debug, Clone)]
pub struct NamingOptions {
    pub quality: u32,
    pub audio_quality: String,
    pub codec: String,
    pub filename_template: String,
    pub folder_template: String,
    pub create_folder: bool,
    pub create_folder_add_index: bool,
    pub outputs: Vec<String>,
}

impl Default for NamingOptions {
    fn default() -> Self {
        Self {
            quality: 0,
            audio_quality: "auto".into(),
            codec: "auto".into(),
            filename_template: "%title% [%bv%-%cid%]".into(),
            folder_template: String::new(),
            create_folder: false,
            create_folder_add_index: false,
            outputs: vec!["video".into()],
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TaskView {
    pub title: String,
    pub part: String,
    pub author: String,
    pub bvid: String,
    pub cid: u64,
    pub page: u32,
    pub page_count: u32,
    pub uid: f64,
    pub pubdate: f64,
    pub created_at: String,
    pub group: Option<Group>,
    pub options: NamingOptions,
}

#[derive(Debug, Clone)]
pub struct VideoStream {
    pub quality: u32,
    pub codec: u32,
    pub codecs: String,
    pub bandwidth: f64,
    pub urls: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AudioStream {
    pub id: u32,
    pub bandwidth: f64,
    pub codecs: String,
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Streams {
    pub video: Option<VideoStream>,
    pub audio: Option<AudioStream>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanLocation {
    pub parts: Vec<String>,
    pub basename: String,
    pub index: u32,
}

/// JavaScript `String.prototype.slice(0, limit)` counts UTF-16 code units, so a
/// truncation can split a surrogate pair. Rust strings cannot hold a lone
/// surrogate; the orphan half becomes U+FFFD (only reachable for >150-unit titles).
fn truncate_utf16(value: &str, limit: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().take(limit).collect();
    String::from_utf16_lossy(&units)
}

pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn is_reserved(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let head = match lower.find('.') {
        Some(index) => &lower[..index],
        None => lower.as_str(),
    };
    matches!(head, "con" | "prn" | "aux" | "nul")
        || (head.len() == 4
            && (head.starts_with("com") || head.starts_with("lpt"))
            && head.as_bytes()[3].is_ascii_digit()
            && head.as_bytes()[3] != b'0')
}

pub fn safe_name(value: &str) -> String {
    let normalized: Cow<'_, str> = value.nfc().collect::<String>().into();
    let mut replaced = String::with_capacity(normalized.len());
    for ch in normalized.chars() {
        let illegal = matches!(ch, '<' | '>' | '"' | ':' | '/' | '\\' | '|' | '?' | '*')
            || (ch as u32) < 0x20;
        replaced.push(if illegal { '_' } else { ch });
    }
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    let sliced = truncate_utf16(trimmed, 150);
    if sliced.is_empty() {
        return "_video".to_string();
    }
    if is_reserved(&sliced) {
        format!("_{sliced}")
    } else {
        sliced
    }
}

fn valid_token(token: &str) -> bool {
    if TOKENS.contains(&token) {
        return true;
    }
    if let Some(rest) = token
        .strip_prefix("dd")
        .or_else(|| token.strip_prefix("pd"))
    {
        if rest.is_empty() {
            return true;
        }
        if let Some(spec) = rest.strip_prefix(':') {
            return matches!(spec, "YYYY" | "MM" | "DD" | "YYYYMMDD");
        }
        return false;
    }
    matches!(token, "index:0" | "index:00" | "index:01")
}

pub fn validate_template(template: &str) -> Result<(), String> {
    let bytes: Vec<char> = template.chars().collect();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != '%' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end] != '%' {
            end += 1;
        }
        if end >= bytes.len() {
            break;
        }
        let token: String = bytes[start..end].iter().collect();
        if !valid_token(&token) {
            return Err(format!("不支持的命名变量：%{token}%"));
        }
        index = end + 1;
    }
    Ok(())
}

fn date_parts(millis: f64) -> Option<(i32, u32, u32)> {
    if !millis.is_finite() {
        return None;
    }
    let nanos = (millis * 1_000_000.0).trunc() as i128;
    let utc = time::OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    let offset = time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC);
    let local = utc.to_offset(offset);
    Some((local.year(), local.month() as u32, local.day() as u32))
}

pub fn date_value(millis: f64, format: Option<&str>) -> String {
    let Some((year, month, day)) = date_parts(millis) else {
        return String::new();
    };
    match format {
        Some("YYYY") => format!("{year}"),
        Some("MM") => format!("{month:02}"),
        Some("DD") => format!("{day:02}"),
        Some("YYYYMMDD") => format!("{year}{month:02}{day:02}"),
        _ => format!("{year}-{month:02}-{day:02}"),
    }
}

/// Mirrors `template.replace(/%index(?::0|:00|:01)?%[^%]*/g, '')`: when the video
/// is neither a collection nor multi-part, the index token and the literal that
/// follows it (up to the next `%`) are dropped so names do not keep a stray dash.
fn strip_index_literal(template: &str) -> String {
    let chars: Vec<char> = template.chars().collect();
    let mut output = String::with_capacity(template.len());
    let mut index = 0usize;
    while index < chars.len() {
        if chars[index] != '%' {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        let rest: String = chars[index..].iter().collect();
        if let Some(consumed) = match_index_literal(&rest) {
            index += consumed;
            continue;
        }
        output.push('%');
        index += 1;
    }
    output
}

fn match_index_literal(rest: &str) -> Option<usize> {
    let after_marker = rest.strip_prefix("%index")?;
    let mut consumed = "%index".chars().count();
    for suffix in [":00", ":01", ":0"] {
        if let Some(tail) = after_marker.strip_prefix(suffix) {
            if let Some(after) = tail.strip_prefix('%') {
                let literal: usize = after.chars().take_while(|c| *c != '%').count();
                consumed += suffix.chars().count() + 1 + literal;
                return Some(consumed);
            }
        }
    }
    let after = after_marker.strip_prefix('%')?;
    let literal: usize = after.chars().take_while(|c| *c != '%').count();
    Some(consumed + 1 + literal)
}

fn task_index(task: &TaskView) -> u32 {
    let group = task.group.as_ref().map(|g| g.index).unwrap_or(0);
    if group != 0 {
        group
    } else if task.page != 0 {
        task.page
    } else {
        1
    }
}

fn video_label(quality: u32) -> Option<&'static str> {
    Some(match quality {
        16 => "360P",
        32 => "480P",
        64 => "720P",
        74 => "720P 高帧",
        80 => "1080P",
        112 => "1080P 高码",
        116 => "1080P 高帧",
        120 => "4K",
        125 => "HDR",
        126 => "杜比",
        127 => "8K",
        _ => return None,
    })
}

fn audio_label(id: u32) -> Option<&'static str> {
    Some(match id {
        30216 => "64K",
        30232 => "132K",
        30280 => "192K",
        30250 => "杜比全景声",
        30251 => "Hi-Res无损",
        _ => return None,
    })
}

fn audio_id_for(quality: &str) -> u32 {
    match quality {
        "64" => 30216,
        "132" => 30232,
        "192" => 30280,
        "dolby" => 30250,
        "hires" => 30251,
        _ => 0,
    }
}

fn audio_quality_label(task: &TaskView, streams: &Streams) -> String {
    let id = streams
        .audio
        .as_ref()
        .map(|a| a.id)
        .filter(|id| *id != 0)
        .unwrap_or_else(|| audio_id_for(&task.options.audio_quality));
    let label = audio_label(id).unwrap_or("auto");
    let codecs = streams
        .audio
        .as_ref()
        .map(|a| a.codecs.split('.').next().unwrap_or(""))
        .unwrap_or("");
    [label, codecs]
        .iter()
        .filter(|part| !part.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
}

fn video_quality_label(task: &TaskView, streams: &Streams) -> String {
    let quality = streams
        .video
        .as_ref()
        .map(|v| v.quality)
        .filter(|q| *q != 0)
        .unwrap_or(task.options.quality);
    let label = video_label(quality).unwrap_or("auto");
    let codec = streams
        .video
        .as_ref()
        .and_then(|v| match v.codec {
            7 => Some("avc1"),
            12 => Some("hev1"),
            13 => Some("av01"),
            _ => None,
        })
        .unwrap_or(task.options.codec.as_str());
    [label, codec]
        .iter()
        .filter(|part| !part.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn render_template(template: &str, task: &TaskView, streams: &Streams) -> String {
    let index = task_index(task);
    let is_multi_part = task.page_count > 1;
    let title = if !task.part.is_empty() && is_multi_part {
        task.part.clone()
    } else {
        task.title.clone()
    };
    let part = if task.part.is_empty() {
        task.title.clone()
    } else {
        task.part.clone()
    };
    let collection = task
        .group
        .as_ref()
        .map(|g| g.title.clone())
        .unwrap_or_default();
    let vtype = if task.group.is_some() {
        "合集视频"
    } else if is_multi_part {
        "分集视频"
    } else {
        "单视频"
    };
    let uid = if task.uid == 0.0 {
        String::new()
    } else {
        format!("{}", task.uid as i64)
    };

    let mut source = template.to_string();
    if task.group.is_none() && !is_multi_part {
        source = strip_index_literal(&source);
    }

    let chars: Vec<char> = source.chars().collect();
    let mut output = String::with_capacity(source.len());
    let mut position = 0usize;
    while position < chars.len() {
        if chars[position] != '%' {
            output.push(chars[position]);
            position += 1;
            continue;
        }
        let start = position + 1;
        let mut end = start;
        while end < chars.len() && chars[end] != '%' {
            end += 1;
        }
        if end >= chars.len() {
            output.push('%');
            position += 1;
            continue;
        }
        let token: String = chars[start..end].iter().collect();
        let replacement = match token.as_str() {
            "index:0" => (index.saturating_sub(1)).to_string(),
            "index:00" => format!("{:02}", index.saturating_sub(1)),
            "index:01" => format!("{index:02}"),
            _ if token.starts_with("dd") || token.starts_with("pd") => {
                let is_created = token.starts_with("dd");
                let format = token.split(':').nth(1);
                let millis = if is_created {
                    parse_iso_millis(&task.created_at)
                } else {
                    task.pubdate * 1000.0
                };
                date_value(millis, format)
            }
            "title" => title.clone(),
            "part" => part.clone(),
            "upnn" => task.author.clone(),
            "uid" => uid.clone(),
            "bv" => task.bvid.clone(),
            "cid" => task.cid.to_string(),
            "index" => index.to_string(),
            "v" => NAMING_VERSION.to_string(),
            "aqn" => audio_quality_label(task, streams),
            "vqn" => video_quality_label(task, streams),
            "collection" => collection.clone(),
            "vtype" => vtype.to_string(),
            "upnn-uid" => format!("{}-{}", task.author, uid),
            "uid-upnn" => format!("{}-{}", uid, task.author),
            _ => String::new(),
        };
        output.push_str(&replacement);
        position = end + 1;
    }
    output
}

fn parse_iso_millis(value: &str) -> f64 {
    if value.is_empty() {
        return 0.0;
    }
    match time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339) {
        Ok(parsed) => parsed.unix_timestamp_nanos() as f64 / 1_000_000.0,
        Err(_) => 0.0,
    }
}

pub fn plan_location(task: &TaskView, streams: &Streams) -> PlanLocation {
    let index = task_index(task);
    let mut parts: Vec<String> = task
        .options
        .folder_template
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .map(|part| safe_name(&render_template(part, task, streams)))
        .collect();
    if let Some(group) = &task.group {
        if !group.title.is_empty() {
            parts.push(safe_name(&group.title));
        }
    } else if task.page_count > 1 {
        parts.push(safe_name(&task.title));
    }
    if task.options.create_folder && task.options.outputs.len() > 1 {
        let base = if task.part.is_empty() {
            task.title.clone()
        } else {
            task.part.clone()
        };
        let name = if task.options.create_folder_add_index {
            format!("{index:02} {base}")
        } else {
            base
        };
        parts.push(safe_name(&name));
    }
    PlanLocation {
        parts,
        basename: safe_name(&render_template(
            &task.options.filename_template,
            task,
            streams,
        )),
        index,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(title: &str) -> TaskView {
        TaskView {
            title: title.into(),
            bvid: "BV17x411w7KC".into(),
            cid: 42,
            ..Default::default()
        }
    }

    #[test]
    fn safe_name_matches_the_node_rules() {
        assert_eq!(safe_name("正常标题"), "正常标题");
        assert_eq!(safe_name("a/b:c*?. "), "a_b_c__");
        assert_eq!(safe_name("CON"), "_CON");
        assert_eq!(safe_name("con.txt"), "_con.txt");
        assert_eq!(safe_name("com1"), "_com1");
        assert_eq!(safe_name("com0"), "com0");
        assert_eq!(safe_name(""), "_video");
        assert_eq!(safe_name("..."), "_video");
        assert_eq!(safe_name("trailing. . "), "trailing");
    }

    #[test]
    fn safe_name_truncates_at_150_utf16_units() {
        let long = "字".repeat(200);
        assert_eq!(utf16_len(&safe_name(&long)), 150);
        let emoji = "😀".repeat(80); // 160 UTF-16 units
        assert_eq!(utf16_len(&safe_name(&emoji)), 150);
    }

    #[test]
    fn template_validation_lists_the_allowed_tokens() {
        assert!(validate_template("%title% [%bv%-%cid%]").is_ok());
        assert!(validate_template("%index:00%-%part%").is_ok());
        assert!(validate_template("%dd:YYYYMMDD%").is_ok());
        assert_eq!(
            validate_template("%unknown%").unwrap_err(),
            "不支持的命名变量：%unknown%"
        );
        assert!(validate_template("%index:11%").is_err());
    }

    #[test]
    fn single_video_drops_index_and_following_literal() {
        let task = TaskView {
            options: NamingOptions {
                filename_template: "%index:00%-%title%-%bv%".into(),
                ..Default::default()
            },
            ..task("标题")
        };
        let rendered = render_template(&task.options.filename_template, &task, &Streams::default());
        assert_eq!(rendered, "标题-BV17x411w7KC");
    }

    #[test]
    fn multi_part_keeps_index_with_zero_padding() {
        let task = TaskView {
            title: "系列".into(),
            part: "第一集".into(),
            page: 1,
            page_count: 3,
            bvid: "BV1xx411c7mD".into(),
            options: NamingOptions {
                filename_template: "%index:00%-%part%-%bv%".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        let rendered = render_template(&task.options.filename_template, &task, &Streams::default());
        assert_eq!(rendered, "00-第一集-BV1xx411c7mD");
    }

    #[test]
    fn collection_index_takes_precedence_over_page() {
        let task = TaskView {
            title: "合集里的第二集".into(),
            page: 7,
            group: Some(Group {
                index: 2,
                title: "合集".into(),
                id: "g".into(),
            }),
            options: NamingOptions {
                filename_template: "%index:00%-%title%".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            render_template(&task.options.filename_template, &task, &Streams::default()),
            "01-合集里的第二集"
        );
    }

    #[test]
    fn plan_location_builds_folders_then_task_folder() {
        let task = TaskView {
            title: "系列".into(),
            part: "第二集".into(),
            author: "UP主".into(),
            page: 2,
            page_count: 3,
            group: Some(Group {
                index: 2,
                title: "系列视频".into(),
                id: "g".into(),
            }),
            options: NamingOptions {
                folder_template: "%upnn%/%dd:YYYY%/".into(),
                create_folder: true,
                create_folder_add_index: true,
                outputs: vec!["video".into(), "cover".into()],
                ..Default::default()
            },
            created_at: "2023-05-06T00:00:00Z".into(),
            ..Default::default()
        };
        let plan = plan_location(&task, &Streams::default());
        assert_eq!(plan.parts[0], "UP主");
        assert_eq!(plan.parts[1], "2023");
        assert_eq!(plan.parts[2], "系列视频");
        assert_eq!(plan.parts[3], "02 第二集");
    }

    #[test]
    fn version_token_stays_frozen_at_0_2_8() {
        let task = task("标题");
        assert_eq!(render_template("%v%", &task, &Streams::default()), "0.2.8");
    }
}
