//! Speaks text with Piper (en_GB-jenny_dioco-medium), installed by `scripts/install-voice.sh`.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

const VOICE: &str = "en_GB-jenny_dioco-medium";
/// "Work session finished successfully. Take a rest." Played when Piper isn't available.
pub const FINISHED_VOICE: &[u8] = include_bytes!("../sounds/session-finished.mp3");

/// Held while speaking, so messages queue up instead of talking over each other.
static SPEAKING: Mutex<()> = Mutex::new(());

fn cache_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn play(file: &PathBuf) -> Result<(), String> {
    let status = Command::new("paplay")
        .arg(file)
        .status()
        .map_err(|e| format!("could not run paplay: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("paplay failed: {status}"))
    }
}

/// Speaks `text`, blocking until done.
pub fn speak(app: &AppHandle, text: &str) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let piper = data.join("piper/bin/piper");
    let model = data.join(format!("voices/{VOICE}.onnx"));
    if !piper.exists() || !model.exists() {
        return Err("voice not installed, run `sh scripts/install-voice.sh` once".into());
    }

    let _speaking = SPEAKING.lock().unwrap();
    let wav = cache_file(app, "speech.wav")?;
    let mut child = Command::new(&piper)
        .arg("-m")
        .arg(&model)
        .args(["--length-scale", "1.1", "-f"])
        .arg(&wav)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run piper: {e}"))?;
    // One line, so Piper reads it as a single utterance.
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("piper failed: {status}"));
    }
    play(&wav)
}

pub fn play_finished(app: &AppHandle) -> Result<(), String> {
    let _speaking = SPEAKING.lock().unwrap();
    let file = cache_file(app, "session-finished.mp3")?;
    fs::write(&file, FINISHED_VOICE).map_err(|e| e.to_string())?;
    play(&file)
}
