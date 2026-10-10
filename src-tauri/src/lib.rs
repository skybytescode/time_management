use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

/// Sites blocked during a work session; `www.` and `m.` variants are added automatically.
const BLOCKED_SITES: &[&str] = &[
    "youtube.com",
    "chess.com",
    "lichess.org",
    "unimedia.md",
    "point.md",
    "digi24.ro",
    "stiripesurse.ro",
    "fanatik.ro",
    "999.md",
    "mobile.de",
];
/// Root helper installed by `scripts/install-site-blocker.sh`.
const BLOCKER: &str = "/usr/local/bin/tm-block-sites";
const HOSTS_MARKER: &str = "# BEGIN time-management";
const MAX_MINUTES: u32 = 240;
/// "Work session finished successfully. Take a rest." (Piper, en_GB-jenny_dioco-medium).
const FINISHED_VOICE: &[u8] = include_bytes!("../sounds/session-finished.mp3");

#[derive(Clone, Serialize)]
struct Session {
    id: u64,
    start_ms: u64,
    end_ms: u64,
    /// Why the sites could not be blocked, if they couldn't.
    block_error: Option<String>,
}

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
    next_id: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before 1970")
        .as_millis() as u64
}

fn run_blocker(args: &[String]) -> Result<(), String> {
    if !Path::new(BLOCKER).exists() {
        return Err("site blocker not installed, run `sudo sh scripts/install-site-blocker.sh` once".into());
    }
    let output = Command::new("sudo")
        .arg("-n")
        .arg(BLOCKER)
        .args(args)
        .output()
        .map_err(|e| format!("could not run sudo: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn block_sites() -> Result<(), String> {
    let mut args = vec!["block".to_string()];
    for site in BLOCKED_SITES {
        for prefix in ["", "www.", "m."] {
            args.push(format!("{prefix}{site}"));
        }
    }
    run_blocker(&args)
}

/// Removes our section from /etc/hosts, skipping the sudo call when it isn't there.
fn unblock_sites() -> Result<(), String> {
    let blocked = fs::read_to_string("/etc/hosts").is_ok_and(|hosts| hosts.contains(HOSTS_MARKER));
    if blocked {
        run_blocker(&["unblock".to_string()])
    } else {
        Ok(())
    }
}

fn current_id(app: &AppHandle) -> Option<u64> {
    app.state::<AppState>().session.lock().unwrap().as_ref().map(|s| s.id)
}

fn watch_session(app: AppHandle, id: u64, end_ms: u64) {
    // Poll the wall clock instead of sleeping the whole duration, so time spent suspended counts.
    while now_ms() < end_ms {
        thread::sleep(Duration::from_millis(500));
        if current_id(&app) != Some(id) {
            return;
        }
    }

    {
        let state = app.state::<AppState>();
        let mut session = state.session.lock().unwrap();
        if session.as_ref().map(|s| s.id) != Some(id) {
            return;
        }
        *session = None;
    }
    let _ = unblock_sites();
    let _ = app.emit("session-finished", ());
    if let Err(e) = play_finished_voice(&app) {
        eprintln!("could not play voice: {e}");
    }
}

fn play_finished_voice(app: &AppHandle) -> Result<(), String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("session-finished.mp3");
    fs::write(&file, FINISHED_VOICE).map_err(|e| e.to_string())?;
    let status = Command::new("paplay")
        .arg(&file)
        .status()
        .map_err(|e| format!("could not run paplay: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("paplay failed: {status}")) }
}

#[tauri::command]
fn get_session(state: State<AppState>) -> Option<Session> {
    state.session.lock().unwrap().clone()
}

#[tauri::command]
fn start_session(minutes: u32, app: AppHandle, state: State<AppState>) -> Result<Session, String> {
    if !(1..=MAX_MINUTES).contains(&minutes) {
        return Err(format!("session length must be 1 to {MAX_MINUTES} minutes"));
    }
    let mut current = state.session.lock().unwrap();
    if current.is_some() {
        return Err("a session is already running".into());
    }

    let start_ms = now_ms();
    let session = Session {
        id: state.next_id.fetch_add(1, Ordering::Relaxed),
        start_ms,
        end_ms: start_ms + u64::from(minutes) * 60_000,
        block_error: block_sites().err(),
    };
    *current = Some(session.clone());

    let (id, end_ms) = (session.id, session.end_ms);
    thread::spawn(move || watch_session(app, id, end_ms));
    Ok(session)
}

#[tauri::command]
fn stop_session(state: State<AppState>) -> Result<(), String> {
    state.session.lock().unwrap().take();
    unblock_sites()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|_| {
            // Leftover block from a session that didn't end cleanly (crash, power loss).
            let _ = unblock_sites();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_session, start_session, stop_session])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if let RunEvent::Exit = event {
                let _ = unblock_sites();
            }
        });
}
