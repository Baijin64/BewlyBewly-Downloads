//! Option validation, DASH stream selection and subtitle side-car generation.
//!
//! Ported from `native/formats.mjs`. The validation messages and the exact byte
//! layout of SRT/ASS/NFO are part of the user-visible contract, so they are kept
//! verbatim; any behavioural difference is a regression, not a cleanup.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::naming::{date_value, plan_location, utf16_len, validate_template, Streams, TaskView};

pub const OUTPUT_KINDS: [&str; 9] = [
    "video", "silent", "audio", "mp3", "cover", "xml", "ass", "srt", "nfo",
];

const QUALITIES: [u32; 12] = [0, 16, 32, 64, 74, 80, 112, 116, 120, 125, 126, 127];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOptions {
    pub quality: u32,
    pub codec: String,
    pub audio_quality: String,
    pub mode: String,
    pub outputs: Vec<String>,
    pub subtitle_languages: Vec<String>,
    pub cover: bool,
    pub subtitles: bool,
    pub filename_template: String,
    pub folder_template: String,
    pub create_folder: bool,
    pub create_folder_add_index: bool,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            quality: 0,
            codec: "auto".into(),
            audio_quality: "auto".into(),
            mode: "video".into(),
            outputs: vec!["video".into()],
            subtitle_languages: Vec::new(),
            cover: false,
            subtitles: false,
            filename_template: "%title% [%bv%-%cid%]".into(),
            folder_template: String::new(),
            create_folder: false,
            create_folder_add_index: false,
        }
    }
}

fn audio_quality_values() -> [&'static str; 6] {
    ["auto", "64", "132", "192", "dolby", "hires"]
}

/// `Number(value)` for the subset the options accept: numbers, numeric strings
/// and booleans; everything else is not finite and therefore invalid.
fn loose_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(true) => Some(1.0),
        Value::Bool(false) => Some(0.0),
        _ => None,
    }
}

fn string_of(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => fallback.to_string(),
    }
}

pub fn validate_options(value: &Value) -> Result<DownloadOptions, String> {
    // `Number(x)` semantics: a missing value defaults to 0, but a present value
    // that cannot be parsed becomes NaN and must be rejected, not coerced to 0.
    let quality = match value.get("quality") {
        None | Some(Value::Null) => 0.0,
        Some(raw) => loose_number(Some(raw)).unwrap_or(f64::NAN),
    };
    if !quality.is_finite() || quality.fract() != 0.0 || !QUALITIES.contains(&(quality as u32)) {
        return Err("无效画质".into());
    }
    let quality = quality as u32;
    let codec = string_of(value.get("codec"), "auto");
    if !matches!(codec.as_str(), "auto" | "avc" | "hevc" | "av1") {
        return Err("无效下载格式".into());
    }
    let mode = string_of(value.get("mode"), "video");
    if !matches!(mode.as_str(), "video" | "audio") {
        return Err("无效下载格式".into());
    }
    let audio_quality = string_of(value.get("audioQuality"), "auto");
    if !audio_quality_values().contains(&audio_quality.as_str()) {
        return Err("无效下载格式".into());
    }

    let requested: Vec<String> = match value.get("outputs") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Some(_) => return Err("请至少选择一种下载内容".into()),
        None => {
            let mut defaults = vec![if mode == "audio" { "audio" } else { "video" }];
            if value.get("cover").and_then(Value::as_bool) == Some(true) {
                defaults.push("cover");
            }
            if value.get("subtitles").and_then(Value::as_bool) == Some(true) {
                defaults.push("srt");
            }
            defaults.into_iter().map(str::to_string).collect()
        }
    };
    if requested.is_empty()
        || requested
            .iter()
            .any(|kind| !OUTPUT_KINDS.contains(&kind.as_str()))
    {
        return Err("请至少选择一种下载内容".into());
    }
    let outputs: Vec<String> = OUTPUT_KINDS
        .iter()
        .filter(|kind| requested.iter().any(|item| item == *kind))
        .map(|kind| (*kind).to_string())
        .collect();

    let subtitle_languages = match value.get("subtitleLanguages") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > 50 {
                return Err("无效字幕语言".into());
            }
            let mut seen = BTreeSet::new();
            let mut result = Vec::new();
            for item in items {
                let Some(text) = item.as_str() else {
                    return Err("无效字幕语言".into());
                };
                if !valid_language(text) {
                    return Err("无效字幕语言".into());
                }
                if seen.insert(text.to_string()) {
                    result.push(text.to_string());
                }
            }
            result
        }
        Some(_) => return Err("无效字幕语言".into()),
    };

    let filename_template = string_of(
        value.get("filenameTemplate"),
        &DownloadOptions::default().filename_template,
    );
    let folder_template = string_of(value.get("folderTemplate"), "");
    for template in [&filename_template, &folder_template] {
        if utf16_len(template) > 300 || template.chars().any(|character| (character as u32) < 0x20)
        {
            return Err("命名规则过长或包含控制字符".into());
        }
        validate_template(template)?;
    }
    if filename_template.trim().is_empty() {
        return Err("文件名规则不能为空".into());
    }

    Ok(DownloadOptions {
        quality,
        codec,
        audio_quality,
        mode,
        cover: outputs.iter().any(|kind| kind == "cover"),
        subtitles: outputs.iter().any(|kind| kind == "srt"),
        outputs,
        subtitle_languages,
        filename_template,
        folder_template,
        create_folder: value.get("createFolder").and_then(Value::as_bool) == Some(true),
        create_folder_add_index: value.get("createFolderAddIndex").and_then(Value::as_bool)
            == Some(true),
    })
}

fn valid_language(text: &str) -> bool {
    if text.is_empty() || utf16_len(text) > 40 {
        return false;
    }
    text.chars()
        .all(|character| character.is_alphanumeric() || character == '_' || character == '-')
}

pub fn output_location(task: &TaskView, streams: &Streams) -> Result<(PathBuf, String), String> {
    let root = std::path::absolute(Path::new(&task.directory))
        .map_err(|_| "输出目录超出保存位置".to_string())?;
    let plan = plan_location(task, streams);
    let mut directory = root.clone();
    for part in &plan.parts {
        directory.push(part);
    }
    if directory.strip_prefix(&root).is_err() {
        return Err("输出目录超出保存位置".into());
    }
    let target = directory.join(&plan.basename);
    if utf16_len(&target.to_string_lossy()) > 235 {
        return Err("输出路径过长，请缩短命名规则或保存目录".into());
    }
    Ok((directory, plan.basename))
}

fn stream_of(input: Option<&Value>) -> Option<Value> {
    let input = input?;
    let base = input
        .get("baseUrl")
        .or_else(|| input.get("base_url"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())?;
    let mut urls = vec![base.to_string()];
    let backup = input
        .get("backupUrl")
        .or_else(|| input.get("backup_url"))
        .and_then(Value::as_array);
    if let Some(items) = backup {
        for item in items {
            if let Some(text) = item.as_str().filter(|text| !text.is_empty()) {
                urls.push(text.to_string());
            }
        }
    }
    Some(serde_json::json!({
        "urls": urls,
        "quality": input.get("id").cloned().unwrap_or(Value::from(0)),
        "id": input.get("id").cloned().unwrap_or(Value::from(0)),
        "codec": input.get("codecid").cloned().unwrap_or(Value::from(0)),
        "codecs": input.get("codecs").cloned().unwrap_or(Value::from("")),
        "bandwidth": input.get("bandwidth").cloned().unwrap_or(Value::from(0)),
    }))
}

fn audio_rank(id: u32) -> u32 {
    match id {
        30251 => 5,
        30250 => 4,
        30280 => 3,
        30232 => 2,
        30216 => 1,
        _ => 0,
    }
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

fn select_audio<'a>(tracks: &'a [Value], quality: &str) -> Option<&'a Value> {
    let mut matching: Vec<&Value> = tracks
        .iter()
        .filter(|track| {
            let id = track.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            if quality == "auto" {
                audio_rank(id) > 0
            } else {
                id == audio_id_for(quality)
            }
        })
        .collect();
    matching.sort_by(|left, right| {
        let left_id = left.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
        let right_id = right.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
        audio_rank(right_id)
            .cmp(&audio_rank(left_id))
            .then_with(|| {
                let left_band = left.get("bandwidth").and_then(Value::as_f64).unwrap_or(0.0);
                let right_band = right
                    .get("bandwidth")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                right_band.total_cmp(&left_band)
            })
    });
    matching.first().copied()
}

pub fn select_streams(data: &Value, options: &DownloadOptions) -> Result<Streams, String> {
    let preview = data.get("is_preview");
    let preview = preview.and_then(Value::as_bool) == Some(true)
        || preview.and_then(Value::as_u64) == Some(1)
        || data
            .get("accept_description")
            .and_then(Value::as_array)
            .map(|labels| {
                labels
                    .iter()
                    .any(|label| label.as_str().map(|text| text.contains("试看")) == Some(true))
            })
            .unwrap_or(false);
    if preview {
        return Err("接口仅提供试看内容，未下载不完整的视频".into());
    }

    let need_video = options
        .outputs
        .iter()
        .any(|kind| kind == "video" || kind == "silent");
    let need_audio = options
        .outputs
        .iter()
        .any(|kind| kind == "video" || kind == "audio" || kind == "mp3");

    let videos = data
        .pointer("/dash/video")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let codec_code = match options.codec.as_str() {
        "avc" => Some(7),
        "hevc" => Some(12),
        "av1" => Some(13),
        _ => None,
    };
    let candidates: Vec<&Value> = videos
        .iter()
        .filter(|video| match codec_code {
            None => true,
            Some(code) => video.get("codecid").and_then(Value::as_u64) == Some(code),
        })
        .collect();

    let quality = if options.quality != 0 {
        options.quality
    } else {
        candidates
            .iter()
            .filter_map(|video| video.get("id").and_then(Value::as_u64))
            .max()
            .unwrap_or(0) as u32
    };
    let mut same_quality: Vec<&Value> = candidates
        .iter()
        .copied()
        .filter(|video| video.get("id").and_then(Value::as_u64) == Some(quality as u64))
        .collect();
    same_quality.sort_by(|left, right| {
        let left_band = left.get("bandwidth").and_then(Value::as_f64).unwrap_or(0.0);
        let right_band = right
            .get("bandwidth")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        right_band.total_cmp(&left_band)
    });
    let video = same_quality.first().copied();

    let mut audios: Vec<Value> = data
        .pointer("/dash/audio")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(dolby) = data.pointer("/dash/dolby/audio").and_then(Value::as_array) {
        audios.extend(dolby.iter().cloned());
    }
    if let Some(flac) = data
        .pointer("/dash/flac/audio")
        .filter(|value| value.is_object())
    {
        audios.push(flac.clone());
    }
    let audible: Vec<Value> = audios
        .into_iter()
        .filter(|audio| {
            audio
                .get("baseUrl")
                .or_else(|| audio.get("base_url"))
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
        })
        .collect();
    let audio = select_audio(&audible, &options.audio_quality);

    if need_video && video.is_none() {
        return Err("当前账号或视频没有所选画质和编码，没有自动降级".into());
    }
    if need_audio && audio.is_none() {
        return Err("当前账号或视频没有所选音质，没有自动替换音轨".into());
    }

    Ok(Streams {
        video: if need_video {
            stream_of(video).and_then(|value| serde_json::from_value(value).ok())
        } else {
            None
        },
        audio: if need_audio {
            stream_of(audio).and_then(|value| serde_json::from_value(value).ok())
        } else {
            None
        },
    })
}

fn cue_number(cue: &Value, key: &str) -> Option<f64> {
    loose_number(cue.get(key))
}

pub fn to_srt(cues: &Value) -> Result<String, String> {
    let items = match cues {
        Value::Array(items) => items,
        _ => return Err("CC 文件没有有效字幕".into()),
    };
    if items.is_empty() {
        return Err("CC 文件没有有效字幕".into());
    }
    let mut blocks = Vec::with_capacity(items.len());
    for (index, cue) in items.iter().enumerate() {
        let from = cue_number(cue, "from");
        let to = cue_number(cue, "to");
        let content = cue.get("content").and_then(Value::as_str);
        let (Some(from), Some(to), Some(content)) = (from, to, content) else {
            return Err("CC 文件没有有效字幕".into());
        };
        if to < from {
            return Err("CC 文件没有有效字幕".into());
        }
        blocks.push(format!(
            "{}\n{} --> {}\n{}\n",
            index + 1,
            srt_stamp(from),
            srt_stamp(to),
            content
        ));
    }
    Ok(blocks.join("\n"))
}

fn srt_stamp(seconds: f64) -> String {
    let ms = (seconds * 1000.0).round().max(0.0) as i64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        ms % 1000
    )
}

pub fn srt_text(value: &str, line_breaks: bool) -> Result<String, String> {
    let text = value.strip_prefix('\u{feff}').unwrap_or(value);
    let mut lines: Vec<String> = Vec::new();
    for block in split_blocks(text) {
        let block_lines: Vec<&str> = block
            .split('\n')
            .map(|line| line.trim_end_matches('\r'))
            .collect();
        let time = block_lines
            .iter()
            .position(|line| is_time_line(line.trim()));
        if let Some(index) = time {
            for line in &block_lines[index + 1..] {
                if line.trim().is_empty() {
                    continue;
                }
                lines.push(strip_tags(line));
            }
        }
    }
    if lines.is_empty() {
        return Err("SRT 文件没有有效字幕".into());
    }
    Ok(lines.join(if line_breaks { "\n" } else { "" }))
}

fn split_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = String::new();
    let mut blank_run = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.trim().is_empty() {
            blank_run += 1;
            if blank_run == 1 && !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
            continue;
        }
        blank_run = 0;
        current.push_str(trimmed);
        current.push('\n');
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
}

fn is_time_line(line: &str) -> bool {
    let Some((left, right)) = line.split_once("-->") else {
        return false;
    };
    let right = right.split_whitespace().next().unwrap_or("");
    valid_stamp(left.trim()) && valid_stamp(right)
}

/// `HH(2+):MM:SS[,.]mmm`, matching the SRT dialect the Node parser accepts.
fn valid_stamp(value: &str) -> bool {
    let mut parts = value.split(':');
    let (Some(hours), Some(minutes), Some(rest)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    if hours.len() < 2 || !digits(hours) || minutes.len() != 2 || !digits(minutes) {
        return false;
    }
    let bytes = rest.as_bytes();
    bytes.len() == 6
        && bytes[..2].iter().all(u8::is_ascii_digit)
        && matches!(bytes[2], b',' | b'.')
        && bytes[3..].iter().all(u8::is_ascii_digit)
}

fn strip_tags(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut inside = false;
    for character in line.chars() {
        match character {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => output.push(character),
            _ => {}
        }
    }
    output
}

pub fn xml_escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&apos;"),
            _ => output.push(character),
        }
    }
    output
}

fn xml_decode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find('&') {
        output.push_str(&rest[..index]);
        let tail = &rest[index..];
        let Some(end) = tail.find(';') else {
            output.push_str(tail);
            return output;
        };
        let entity = &tail[1..end];
        let decoded = if let Some(number) = entity
            .strip_prefix("#x")
            .or_else(|| entity.strip_prefix("#X"))
        {
            u32::from_str_radix(number, 16)
                .ok()
                .and_then(char::from_u32)
        } else if let Some(number) = entity.strip_prefix('#') {
            number.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ => None,
            }
        };
        match decoded {
            Some(character) => output.push(character),
            None => output.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    output.push_str(rest);
    output
}

const ASS_HEADER: &str = "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,48,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

fn ass_stamp(seconds: f64) -> String {
    let cs = (seconds * 100.0).round().max(0.0) as i64;
    format!(
        "{}:{:02}:{:02}.{:02}",
        cs / 360_000,
        (cs / 6000) % 60,
        (cs / 100) % 60,
        cs % 100
    )
}

pub fn to_ass(xml: &str) -> String {
    let mut comments: Vec<(Vec<String>, String)> = parse_danmaku(xml)
        .into_iter()
        .map(|(parameter, text)| {
            (
                parameter.split(',').map(str::to_string).collect::<Vec<_>>(),
                xml_decode(&text),
            )
        })
        .collect();
    comments.sort_by(|left, right| {
        let left_time = left
            .0
            .first()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let right_time = right
            .0
            .first()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        left_time.total_cmp(&right_time)
    });

    let mut lanes: [Vec<f64>; 3] = [vec![0.0; 14], vec![0.0; 4], vec![0.0; 4]];
    let mut events: Vec<String> = Vec::new();
    for (parameters, text) in comments {
        let time = parameters
            .first()
            .and_then(|value| value.parse::<f64>().ok());
        let mode = parameters
            .get(1)
            .and_then(|value| value.parse::<f64>().ok());
        let size = parameters
            .get(2)
            .and_then(|value| value.parse::<f64>().ok());
        let color = parameters
            .get(3)
            .and_then(|value| value.parse::<f64>().ok());
        let (Some(time), Some(mode), Some(size), Some(color)) = (time, mode, size, color) else {
            continue;
        };
        if !(1.0..=6.0).contains(&mode) || mode.fract() != 0.0 {
            continue;
        }
        let size = (size * 2.0).clamp(24.0, 96.0);
        let group = if mode == 4.0 {
            2
        } else if mode == 5.0 {
            1
        } else {
            0
        };
        let pool = &mut lanes[group];
        let lane = pool
            .iter()
            .position(|until| *until <= time)
            .unwrap_or_else(|| {
                pool.iter()
                    .enumerate()
                    .min_by(|left, right| left.1.total_cmp(right.1))
                    .map(|(index, _)| index)
                    .unwrap_or(0)
            });
        pool[lane] = time + if group == 0 { 2.0 } else { 4.0 };
        let y = if group == 2 {
            1000.0 - lane as f64 * 60.0
        } else {
            30.0 + lane as f64 * 64.0
        };
        let width = (crate::naming::utf16_len(&text) as f64 * size).max(500.0);
        let motion = if group == 0 {
            if mode == 6.0 {
                format!("\\move(-500,{y},1920,{y})")
            } else {
                format!("\\move(1920,{y},-{width},{y})")
            }
        } else {
            format!("\\an8\\pos(960,{y})")
        };
        let color = color.max(0.0) as u64;
        let rgb = format!("{color:06x}");
        let rgb = &rgb[rgb.len().saturating_sub(6)..];
        let bgr = format!("{}{}{}", &rgb[4..6], &rgb[2..4], &rgb[0..2]);
        let body = text
            .replace(['{', '}', '\\'], " ")
            .replace("\r\n", "\\N")
            .replace('\n', "\\N");
        events.push(format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{{{motion}\\fs{size}\\c&H{bgr}&}}{body}",
            ass_stamp(time),
            ass_stamp(time + if group == 0 { 8.0 } else { 4.0 })
        ));
    }
    let mut output = String::from(ASS_HEADER);
    output.push_str(&events.join("\n"));
    output.push('\n');
    output
}

fn parse_danmaku(xml: &str) -> Vec<(String, String)> {
    let mut comments = Vec::new();
    let bytes = xml.as_bytes();
    let mut cursor = 0usize;
    while let Some(offset) = xml[cursor..].find("<d ") {
        let start = cursor + offset;
        let Some(marker) = xml[start..].find("p=\"") else {
            break;
        };
        let value_start = start + marker + 3;
        let Some(value_end_offset) = xml[value_start..].find('"') else {
            break;
        };
        let value_end = value_start + value_end_offset;
        let Some(tag_end_offset) = xml[value_end..].find('>') else {
            break;
        };
        let tag_end = value_end + tag_end_offset;
        let Some(close_offset) = xml[tag_end..].find("</d>") else {
            break;
        };
        let close_start = tag_end + close_offset;
        comments.push((
            xml[value_start..value_end].to_string(),
            xml[tag_end + 1..close_start].to_string(),
        ));
        cursor = close_start + 4;
        let _ = bytes;
    }
    comments
}

pub fn to_nfo(task: &TaskView) -> String {
    let title = if task.part.is_empty() {
        task.title.clone()
    } else {
        task.part.clone()
    };
    let mut output = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<movie>\n");
    let mut tag = |name: &str, value: &str| {
        output.push_str(&format!("  <{name}>{}</{name}>\n", xml_escape(value)));
    };
    tag("title", &title);
    tag("originaltitle", &task.title);
    tag("plot", &task.description);
    tag("studio", &task.author);
    tag("premiered", &date_value(task.pubdate * 1000.0, None));
    tag("thumb", &task.cover);
    tag(
        "website",
        &format!(
            "https://www.bilibili.com/video/{}/?p={}",
            task.bvid, task.page
        ),
    );
    output.push_str(&format!(
        "  <uniqueid type=\"bilibili\" default=\"true\">{}</uniqueid>\n</movie>\n",
        xml_escape(&format!("{}-{}", task.bvid, task.cid))
    ));
    output
}

/// Convenience wrapper used by `previewPath`.
pub fn preview_path(task: &TaskView) -> Result<(String, String), String> {
    let (directory, basename) = output_location(task, &Streams::default())?;
    Ok((directory.to_string_lossy().into_owned(), basename))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::naming::TaskView;
    use serde_json::json;

    #[test]
    fn options_reject_out_of_range_values() {
        assert_eq!(
            validate_options(&json!({"quality": 99})).unwrap_err(),
            "无效画质"
        );
        assert_eq!(
            validate_options(&json!({"codec": "vp9"})).unwrap_err(),
            "无效下载格式"
        );
        assert_eq!(
            validate_options(&json!({"outputs": []})).unwrap_err(),
            "请至少选择一种下载内容"
        );
        assert_eq!(
            validate_options(&json!({"filenameTemplate": "%nope%"})).unwrap_err(),
            "不支持的命名变量：%nope%"
        );
    }

    #[test]
    fn options_follow_the_fixed_output_order_and_dedupe_languages() {
        let options = validate_options(&json!({
            "quality": 80,
            "outputs": ["nfo", "video", "cover", "video"],
            "subtitleLanguages": ["zh-CN", "zh-CN", "ai-zh"],
            "createFolder": true
        }))
        .unwrap();
        assert_eq!(options.outputs, vec!["video", "cover", "nfo"]);
        assert!(options.cover);
        assert_eq!(options.subtitle_languages, vec!["zh-CN", "ai-zh"]);
        assert!(options.create_folder);
    }

    #[test]
    fn srt_conversion_matches_the_reference_bytes() {
        let cues = json!([{ "from": 1.234, "to": 62.5, "content": "第一行" }]);
        let srt = to_srt(&cues).unwrap();
        assert_eq!(srt, "1\n00:00:01,234 --> 00:01:02,500\n第一行\n");
    }

    #[test]
    fn srt_text_strips_tags_and_joins_lines() {
        let source = "\u{feff}1\n00:00:01,000 --> 00:00:02,000\n<i>标题</i>\n第二行\n\n2\n00:00:03,000 --> 00:00:04,000\n下一段\n";
        assert_eq!(srt_text(source, true).unwrap(), "标题\n第二行\n下一段");
        assert_eq!(srt_text(source, false).unwrap(), "标题第二行下一段");
    }

    #[test]
    fn ass_places_lanes_and_escapes_text() {
        let xml = r#"<i><d p="1.5,1,25,16777215">滚动{弹幕}</d><d p="2,4,25,255">底部</d><d p="3,9,25,255">跳过</d></i>"#;
        let ass = to_ass(xml);
        assert!(ass.contains("Dialogue: 0,0:00:01.50,0:00:09.50"));
        assert!(ass.contains("\\move(1920,30,"));
        assert!(ass.contains("滚动 弹幕 "));
        assert!(ass.contains("\\an8\\pos(960,1000)"));
        assert!(!ass.contains("跳过"));
    }

    #[test]
    fn nfo_escapes_the_metadata() {
        let task = TaskView {
            title: "A & B".into(),
            bvid: "BV1xx411c7mD".into(),
            cid: 9,
            page: 1,
            author: "UP".into(),
            pubdate: 0.0,
            ..Default::default()
        };
        let nfo = to_nfo(&task);
        assert!(nfo.contains("<title>A &amp; B</title>"));
        assert!(
            nfo.contains("<uniqueid type=\"bilibili\" default=\"true\">BV1xx411c7mD-9</uniqueid>")
        );
        assert!(nfo.contains("https://www.bilibili.com/video/BV1xx411c7mD/?p=1"));
    }

    #[test]
    fn preview_path_rejects_escaping_folders() {
        let task = TaskView {
            title: "标题".into(),
            bvid: "BV1".into(),
            cid: 1,
            directory: std::env::temp_dir().to_string_lossy().into_owned(),
            options: DownloadOptions {
                folder_template: "../外面".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        let (directory, _) = preview_path(&task).unwrap();
        assert!(!directory.contains(".."));
    }
}
