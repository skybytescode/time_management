//! Tracks which application is in use, through a KWin script that reports the active window over
//! D-Bus (see `kwin/activity.js`). Only focus intervals are stored; window titles stay in our
//! database and never reach the system journal.

use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{AppState, db, now_ms};

const SERVICE: &str = "com.skybytescode.timemanagement";
const OBJECT_PATH: &str = "/activity";
const PLUGIN: &str = "timemanagement-activity";
const SCRIPT: &str = include_str!("../kwin/activity.js");
/// Focus intervals shorter than this (quick alt-tabbing) aren't worth storing.
const MIN_INTERVAL_MS: i64 = 1_500;

/// The application currently in the foreground, shown live in the UI.
#[derive(Clone, Serialize)]
pub struct CurrentActivity {
    pub app: String,
    pub title: String,
    pub start_ms: i64,
}

enum Event {
    Focus { app: String, title: String },
    Blur,
    Lock(bool),
}

/// Receives the KWin script's calls and forwards them to the worker.
struct Reporter {
    tx: Sender<Event>,
}

#[zbus::interface(name = "com.skybytescode.timemanagement.Activity")]
impl Reporter {
    #[zbus(name = "Focus")]
    fn focus(&self, app: String, title: String) {
        let _ = self.tx.send(Event::Focus { app, title });
    }

    #[zbus(name = "Blur")]
    fn blur(&self) {
        let _ = self.tx.send(Event::Blur);
    }
}

/// Persists finished focus intervals and keeps the live current activity in `AppState`.
fn worker(app: AppHandle, rx: mpsc::Receiver<Event>) {
    let mut current: Option<CurrentActivity> = None;
    let mut before_lock: Option<(String, String)> = None;

    let close = |current: &mut Option<CurrentActivity>| {
        if let Some(act) = current.take() {
            let end_ms = now_ms();
            if !act.app.is_empty() && end_ms - act.start_ms >= MIN_INTERVAL_MS {
                let state = app.state::<AppState>();
                if let Err(e) = db::add_activity(
                    &state.db.lock().unwrap(),
                    &act.app,
                    &act.title,
                    act.start_ms,
                    end_ms,
                ) {
                    eprintln!("could not save activity: {e}");
                }
            }
        }
    };
    let publish = |current: &Option<CurrentActivity>| {
        *app.state::<AppState>().activity.lock().unwrap() = current.clone();
        let _ = app.emit("activity-changed", current.clone());
    };
    let open = |current: &mut Option<CurrentActivity>, app_name: String, title: String| {
        if current
            .as_ref()
            .is_some_and(|c| c.app == app_name && c.title == title)
        {
            return;
        }
        close(current);
        *current = Some(CurrentActivity {
            app: app_name,
            title,
            start_ms: now_ms(),
        });
        publish(current);
    };

    for event in rx {
        match event {
            Event::Focus {
                app: app_name,
                title,
            } if !app_name.is_empty() => {
                before_lock = None;
                open(&mut current, app_name, title);
            }
            Event::Focus { .. } => {}
            Event::Blur => {
                close(&mut current);
                publish(&current);
            }
            Event::Lock(true) => {
                before_lock = current.as_ref().map(|c| (c.app.clone(), c.title.clone()));
                close(&mut current);
                publish(&current);
            }
            Event::Lock(false) => {
                if let Some((app_name, title)) = before_lock.take() {
                    open(&mut current, app_name, title);
                }
            }
        }
    }
}

/// Writes the KWin script to disk and returns its path.
fn install_script(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("kwin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("activity.js");
    std::fs::write(&path, SCRIPT).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Loads (reloads) the reporting script into KWin.
fn load_script(conn: &zbus::blocking::Connection, path: &std::path::Path) -> Result<(), String> {
    // Drop a stale copy from a previous run before loading, so reloads don't stack up.
    let _ = conn.call_method(
        Some("org.kde.KWin"),
        "/Scripting",
        Some("org.kde.kwin.Scripting"),
        "unloadScript",
        &PLUGIN,
    );
    conn.call_method(
        Some("org.kde.KWin"),
        "/Scripting",
        Some("org.kde.kwin.Scripting"),
        "loadScript",
        &(path.to_string_lossy().as_ref(), PLUGIN),
    )
    .map_err(|e| format!("loadScript: {e}"))?;
    conn.call_method(
        Some("org.kde.KWin"),
        "/Scripting",
        Some("org.kde.kwin.Scripting"),
        "start",
        &(),
    )
    .map_err(|e| format!("start: {e}"))?;
    Ok(())
}

/// Forwards screen lock and unlock to the worker, so locked time isn't counted.
fn watch_lock(conn: &zbus::blocking::Connection, tx: Sender<Event>) {
    let proxy = zbus::blocking::Proxy::new(
        conn,
        "org.freedesktop.ScreenSaver",
        "/org/freedesktop/ScreenSaver",
        "org.freedesktop.ScreenSaver",
    );
    let Ok(proxy) = proxy else { return };
    let Ok(signal) = proxy.receive_signal("ActiveChanged") else {
        return;
    };
    for message in signal {
        if let Ok(active) = message.body().deserialize::<bool>() {
            let _ = tx.send(Event::Lock(active));
        }
    }
}

/// Starts activity tracking. Best-effort: on a non-KDE or non-Wayland desktop it simply does
/// nothing, leaving the rest of the app unaffected.
pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel();
    let worker_app = app.clone();
    thread::spawn(move || worker(worker_app, rx));

    thread::spawn(move || {
        let path = match install_script(&app) {
            Ok(path) => path,
            Err(e) => return eprintln!("activity: {e}"),
        };
        let conn = match zbus::blocking::connection::Builder::session()
            .and_then(|b| b.name(SERVICE))
            .and_then(|b| b.serve_at(OBJECT_PATH, Reporter { tx: tx.clone() }))
            .and_then(|b| b.build())
        {
            Ok(conn) => conn,
            Err(e) => return eprintln!("activity: D-Bus unavailable: {e}"),
        };
        if let Err(e) = load_script(&conn, &path) {
            return eprintln!("activity: {e}");
        }
        // Blocks here, handling lock events and keeping the connection (and service) alive.
        watch_lock(&conn, tx);
        // If the signal stream ever ends, keep the connection alive anyway.
        loop {
            thread::sleep(Duration::from_secs(3600));
        }
    });
}

/// Removes the KWin script; called on exit so it doesn't linger in KWin.
pub fn stop() {
    if let Ok(conn) = zbus::blocking::Connection::session() {
        let _ = conn.call_method(
            Some("org.kde.KWin"),
            "/Scripting",
            Some("org.kde.kwin.Scripting"),
            "unloadScript",
            &PLUGIN,
        );
    }
}
