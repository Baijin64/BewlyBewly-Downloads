//! Media remuxing.
//!
//! The public surface is backend-neutral on purpose: the current backend shells
//! out to FFmpeg when one is available, and the libav rewrite swaps the internals
//! without touching the queue worker.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("媒体合并需要 FFmpeg，当前安装未包含该组件")]
    MissingTool,
    #[error("同名文件已存在，保留了原文件")]
    Exists,
    #[error("音视频处理失败：{0}")]
    Failed(String),
    #[error("写入文件失败：{0}")]
    Io(String),
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(explicit) = std::env::var("BEWLY_FFMPEG") {
        paths.push(PathBuf::from(explicit));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            paths.push(directory.join("bin").join("ffmpeg.exe"));
            paths.push(directory.join("bin").join("ffmpeg"));
            paths.push(directory.join("ffmpeg.exe"));
        }
    }
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            paths.push(directory.join(name));
        }
    }
    paths
}

pub fn ffmpeg() -> Option<PathBuf> {
    candidate_paths().into_iter().find(|path| path.is_file())
}

/// The service has no console of its own, so on Windows a console child would
/// open a window of its own for every mux; CREATE_NO_WINDOW keeps it hidden.
fn tool_command(tool: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(tool);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Whether the file is ISO base media (MP4 / fragmented MP4), judged by its
/// first box. FLV and other containers must not be renamed to `.mp4`.
fn is_mp4_family(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 8];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut head))
        .map(|_| matches!(&head[4..8], b"ftyp" | b"styp" | b"moov" | b"moof" | b"sidx"))
        .unwrap_or(false)
}

/// Remuxes the given inputs with `-c copy`, matching the Node implementation.
pub fn remux(
    video: Option<&Path>,
    audio: Option<&Path>,
    output: &Path,
    container: &str,
    faststart: bool,
) -> Result<(), MediaError> {
    if output.exists() {
        return Err(MediaError::Exists);
    }
    let tool = match ffmpeg() {
        Some(t) => t,
        None => {
            // Without FFmpeg a single input can still be kept as is, but only
            // when it already is the container the output name promises.
            let single = match (video, audio) {
                (Some(v), None) | (None, Some(v)) => Some(v),
                (Some(v), Some(a)) if v == a => Some(v),
                _ => None,
            };
            match single {
                Some(source) if matches!(container, "mp4" | "m4a") && is_mp4_family(source) => {
                    std::fs::copy(source, output).map_err(|e| MediaError::Io(e.to_string()))?;
                    return Ok(());
                }
                _ => return Err(MediaError::MissingTool),
            }
        }
    };
    let temporary = output.with_file_name(format!(
        ".bewly-mux-{}.part.{}",
        std::process::id(),
        output
            .extension()
            .map(|extension| extension.to_string_lossy().into_owned())
            .unwrap_or_else(|| container.to_string())
    ));
    let _ = std::fs::remove_file(&temporary);

    let mut command = tool_command(&tool);
    command.args(["-hide_banner", "-nostdin", "-y"]);
    if let Some(video) = video {
        command.arg("-i").arg(video);
    }
    if let Some(audio) = audio {
        command.arg("-i").arg(audio);
    }
    if video.is_some() {
        command.args(["-map", "0:v:0"]);
    }
    if audio.is_some() {
        command.args(["-map", if video.is_some() { "1:a:0" } else { "0:a:0" }]);
    }
    command.args(["-c", "copy"]);
    if faststart {
        command.args(["-movflags", "+faststart"]);
    }
    command.arg(&temporary);
    let result = command
        .output()
        .map_err(|error| MediaError::Failed(error.to_string()))?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&temporary);
        let detail = String::from_utf8_lossy(&result.stderr);
        let tail: String = detail
            .chars()
            .rev()
            .take(500)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(MediaError::Failed(tail.trim().to_string()));
    }
    if output.exists() {
        let _ = std::fs::remove_file(&temporary);
        return Err(MediaError::Exists);
    }
    std::fs::rename(&temporary, output).map_err(|error| MediaError::Io(error.to_string()))?;
    Ok(())
}

/// Encodes the audio stream to MP3 at the same VBR quality the Node build used.
pub fn transcode_mp3(audio: &Path, output: &Path) -> Result<(), MediaError> {
    let tool = ffmpeg().ok_or(MediaError::MissingTool)?;
    if output.exists() {
        return Err(MediaError::Exists);
    }
    let temporary = output.with_file_name(format!(".bewly-mp3-{}.part.mp3", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let result = tool_command(&tool)
        .args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(audio)
        .args([
            "-map",
            "0:a:0",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "2",
            "-f",
            "mp3",
        ])
        .arg(&temporary)
        .output()
        .map_err(|error| MediaError::Failed(error.to_string()))?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&temporary);
        let detail = String::from_utf8_lossy(&result.stderr);
        let tail: String = detail
            .chars()
            .rev()
            .take(500)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(MediaError::Failed(tail.trim().to_string()));
    }
    std::fs::rename(&temporary, output).map_err(|error| MediaError::Io(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_a_missing_tool_instead_of_panicking() {
        std::env::set_var("BEWLY_FFMPEG", "/definitely/not/here");
        let result = remux(None, None, Path::new("out.mp4"), "mp4", true);
        assert!(matches!(result, Err(MediaError::MissingTool)));
        let mp3_result = transcode_mp3(Path::new("in.m4a"), Path::new("out.mp3"));
        assert!(matches!(mp3_result, Err(MediaError::MissingTool)));
        std::env::remove_var("BEWLY_FFMPEG");
    }

    #[test]
    fn recognises_mp4_but_not_flv_by_the_first_box() {
        let directory = std::env::temp_dir().join(format!("bewly-media-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let mp4 = directory.join("a.m4s");
        let flv = directory.join("b.flv");
        std::fs::write(&mp4, b"\0\0\0\x18ftypiso5\0\0\0\0").unwrap();
        std::fs::write(&flv, b"FLV\x01\x05\0\0\0\x09").unwrap();
        assert!(is_mp4_family(&mp4));
        assert!(!is_mp4_family(&flv));
        assert!(!is_mp4_family(&directory.join("missing")));
        let _ = std::fs::remove_dir_all(&directory);
    }
}
