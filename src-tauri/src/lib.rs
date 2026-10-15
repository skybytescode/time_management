mod activity;
mod assistant;
mod blocker;
mod db;
mod voice;

use std::fs;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const MAX_MINUTES: u32 = 240;
const MINUTE_MS: i64 = 60_000;
/// The assistant checks in once per hour of session (`TM_CHECK_IN_MINUTES` overrides it, for testing)...
const CHECK_IN_EVERY_MS: i64 = 60 * MINUTE_MS;
/// ...after taking screenshots spread over the last five minutes before it.
const CAPTURE_WINDOW_MS: i64 = 5 * MINUTE_MS;
const SHOTS_PER_CHECK_IN: i64 = 3;
/// Length of the recommended break, after which the assistant calls you back.
const BREAK_MS: i64 = 5 * MINUTE_MS;

#[derive(Clone, Serialize)]
pub struct Session {
    id: i64,
    /// The session's title.
    task: String,
    objectives: String,
    start_ms: i64,
    /// Set for timed sessions.
    end_ms: Option<i64>,
    /// Why the sites could not be blocked, if they couldn't.
    block_error: Option<String>,
    /// Start of the current break, if on one.
    break_start_ms: Option<i64>,
    last_break_end_ms: Option<i64>,
    breaks: u32,
    /// Total length of the finished breaks.
    break_ms: i64,
}

impl Session {
    /// Break time up to `now_ms`, including a break in progress.
    fn break_ms_until(&self, now_ms: i64) -> i64 {
        self.break_ms + self.break_start_ms.map_or(0, |start| now_ms - start)
    }
}

pub struct AppState {
    session: Mutex<Option<Session>>,
    db: Mutex<db::Db>,
    /// The application currently in the foreground, as seen by the activity tracker.
    activity: Mutex<Option<activity::CurrentActivity>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before 1970")
        .as_millis() as i64
}

fn current_session(app: &AppHandle) -> Option<Session> {
    app.state::<AppState>().session.lock().unwrap().clone()
}

/// Clears the session if it is still `id`, returning it.
fn take_session(app: &AppHandle, id: i64) -> Option<Session> {
    let state = app.state::<AppState>();
    let mut session = state.session.lock().unwrap();
    if session.as_ref().map(|s| s.id) == Some(id) {
        session.take()
    } else {
        None
    }
}

fn end_session(app: &AppHandle, session: &Session, end_ms: i64) {
    let state = app.state::<AppState>();
    if let Err(e) = db::end_session(&state.db.lock().unwrap(), session.id, end_ms) {
        eprintln!("could not save session end: {e}");
    }
    if let Err(e) = blocker::unblock_sites() {
        eprintln!("could not unblock sites: {e}");
    }
}

fn watch_session(app: AppHandle, id: i64) {
    let every = std::env::var("TM_CHECK_IN_MINUTES")
        .ok()
        .and_then(|m| m.parse::<i64>().ok())
        .filter(|&m| m > 0)
        .map_or(CHECK_IN_EVERY_MS, |m| m * MINUTE_MS);
    let window = CAPTURE_WINDOW_MS.min(every / 2);
    let mut next_check_in = None;
    let mut shots = Vec::new();
    let mut shots_due = 0;
    let mut last_heartbeat = 0;
    let mut reminded_break = None;

    // Poll the wall clock instead of sleeping long, so time spent suspended counts.
    loop {
        thread::sleep(Duration::from_millis(500));
        let Some(session) = current_session(&app).filter(|s| s.id == id) else {
            return;
        };
        let now = now_ms();

        if now - last_heartbeat >= MINUTE_MS {
            last_heartbeat = now;
            let _ = db::touch_session(&app.state::<AppState>().db.lock().unwrap(), id, now);
        }

        if session.end_ms.is_some_and(|end_ms| now >= end_ms) {
            let Some(session) = take_session(&app, id) else {
                return;
            };
            let end_ms = session.end_ms.unwrap();
            end_session(&app, &session, end_ms);
            let _ = app.emit("session-finished", ());
            assistant::session_ended(&app, &session, end_ms, true);
            return;
        }

        if let Some(start) = session.break_start_ms
            && now - start >= BREAK_MS
            && reminded_break != Some(start)
        {
            reminded_break = Some(start);
            let (app, session) = (app.clone(), session.clone());
            thread::spawn(move || assistant::break_over(&app, &session));
        }

        // Screenshots at 55, 57:30 and 60 minutes into each hour, then the check-in.
        let check_in_at = *next_check_in.get_or_insert(session.start_ms + every);
        let shot_at = check_in_at - window + shots_due * window / (SHOTS_PER_CHECK_IN - 1);
        if now >= shot_at {
            if session.break_start_ms.is_none() {
                match assistant::capture_screen(&app) {
                    Ok(shot) => shots.push(shot),
                    Err(e) => eprintln!("screenshot: {e}"),
                }
            }
            shots_due += 1;
            if shots_due == SHOTS_PER_CHECK_IN {
                if !shots.is_empty() {
                    let (app, shots) = (app.clone(), std::mem::take(&mut shots));
                    thread::spawn(move || assistant::check_in(&app, &session, shots));
                }
                shots_due = 0;
                // Skip check-ins missed while the computer was suspended.
                let mut next = check_in_at + every;
                while next < now {
                    next += every;
                }
                next_check_in = Some(next);
            }
        }
    }
}

fn err(e: rusqlite::Error) -> String {
    format!("database error: {e}")
}

#[tauri::command]
fn get_session(state: State<AppState>) -> Option<Session> {
    state.session.lock().unwrap().clone()
}

/// Messages of the current session, or the latest greeting when none is running.
#[tauri::command]
fn get_messages(state: State<AppState>) -> Result<Vec<db::Message>, String> {
    let session_id = state.session.lock().unwrap().as_ref().map(|s| s.id);
    let db = state.db.lock().unwrap();
    match session_id {
        Some(id) => db::session_messages(&db, id).map_err(err),
        None => db::latest_greeting(&db, now_ms() - 4 * 3_600_000)
            .map(|greeting| greeting.into_iter().collect())
            .map_err(err),
    }
}

#[tauri::command]
fn start_session(
    task: String,
    objectives: String,
    minutes: Option<u32>,
    app: AppHandle,
    state: State<AppState>,
) -> Result<Session, String> {
    let task = session_title(&task)?;
    let objectives = objectives.trim().to_string();
    if minutes.is_some_and(|m| !(1..=MAX_MINUTES).contains(&m)) {
        return Err(format!("session length must be 1 to {MAX_MINUTES} minutes"));
    }
    let mut current = state.session.lock().unwrap();
    if current.is_some() {
        return Err("a session is already running".into());
    }

    let start_ms = now_ms();
    let id = db::create_session(
        &state.db.lock().unwrap(),
        &task,
        &objectives,
        minutes,
        start_ms,
    )
    .map_err(err)?;
    let session = Session {
        id,
        task,
        objectives,
        start_ms,
        end_ms: minutes.map(|m| start_ms + i64::from(m) * MINUTE_MS),
        block_error: blocker::block_sites().err(),
        break_start_ms: None,
        last_break_end_ms: None,
        breaks: 0,
        break_ms: 0,
    };
    *current = Some(session.clone());

    let watcher_app = app.clone();
    thread::spawn(move || watch_session(watcher_app, id));
    let announced = session.clone();
    thread::spawn(move || assistant::session_started(&app, &announced));
    Ok(session)
}

fn session_title(task: &str) -> Result<String, String> {
    let task = task.trim();
    if task.is_empty() {
        Err("write what you're working on first".into())
    } else {
        Ok(task.to_string())
    }
}

/// Edits the title and objectives of the running session; ended sessions can't be changed.
#[tauri::command]
fn update_session_info(
    task: String,
    objectives: String,
    state: State<AppState>,
) -> Result<Session, String> {
    let task = session_title(&task)?;
    let objectives = objectives.trim().to_string();
    let mut current = state.session.lock().unwrap();
    let session = current
        .as_mut()
        .ok_or("the session has ended and can't be edited")?;
    if !db::update_session_info(&state.db.lock().unwrap(), session.id, &task, &objectives)
        .map_err(err)?
    {
        return Err("the session has ended and can't be edited".into());
    }
    session.task = task;
    session.objectives = objectives;
    Ok(session.clone())
}

#[tauri::command]
fn stop_session(app: AppHandle, state: State<AppState>) {
    let Some(session) = state.session.lock().unwrap().take() else {
        return;
    };
    let end_ms = now_ms();
    end_session(&app, &session, end_ms);
    thread::spawn(move || assistant::session_ended(&app, &session, end_ms, false));
}

/// Starts a break (`on == true`) or ends it. Sites stay blocked during breaks.
#[tauri::command]
fn set_break(on: bool, state: State<AppState>) -> Result<Session, String> {
    let mut current = state.session.lock().unwrap();
    let session = current.as_mut().ok_or("no session is running")?;
    let now = now_ms();
    let db = state.db.lock().unwrap();
    match (on, session.break_start_ms) {
        (true, None) => {
            db::start_break(&db, session.id, now).map_err(err)?;
            session.break_start_ms = Some(now);
        }
        (false, Some(start)) => {
            db::end_break(&db, session.id, now).map_err(err)?;
            session.break_start_ms = None;
            session.last_break_end_ms = Some(now);
            session.breaks += 1;
            session.break_ms += now - start;
        }
        _ => {}
    }
    Ok(session.clone())
}

#[tauri::command]
fn history(
    filter: db::HistoryFilter,
    state: State<AppState>,
) -> Result<Vec<db::SessionRecord>, String> {
    db::history(&state.db.lock().unwrap(), &filter).map_err(err)
}

#[tauri::command]
fn get_notes(session_id: i64, state: State<AppState>) -> Result<Vec<db::Note>, String> {
    db::session_notes(&state.db.lock().unwrap(), session_id).map_err(err)
}

fn note_text(text: &str) -> Result<&str, String> {
    let text = text.trim();
    if text.is_empty() {
        Err("the note is empty".into())
    } else {
        Ok(text)
    }
}

#[tauri::command]
fn add_note(session_id: i64, text: String, state: State<AppState>) -> Result<db::Note, String> {
    db::add_note(
        &state.db.lock().unwrap(),
        session_id,
        note_text(&text)?,
        now_ms(),
    )
    .map_err(err)
}

#[tauri::command]
fn update_note(id: i64, text: String, state: State<AppState>) -> Result<db::Note, String> {
    db::update_note(&state.db.lock().unwrap(), id, note_text(&text)?, now_ms()).map_err(err)
}

#[tauri::command]
fn delete_note(id: i64, state: State<AppState>) -> Result<(), String> {
    db::delete_note(&state.db.lock().unwrap(), id).map_err(err)
}

/// Focus intervals that overlap [from_ms, to_ms), plus the live current activity clipped to it.
#[tauri::command]
fn activities(
    from_ms: i64,
    to_ms: i64,
    state: State<AppState>,
) -> Result<Vec<db::Activity>, String> {
    let mut rows = db::activities(&state.db.lock().unwrap(), from_ms, to_ms).map_err(err)?;
    if let Some(current) = state.activity.lock().unwrap().clone() {
        let now = now_ms();
        if current.start_ms < to_ms && now > from_ms {
            rows.insert(
                0,
                db::Activity {
                    app: current.app,
                    title: current.title,
                    start_ms: current.start_ms.max(from_ms),
                    end_ms: Some(now.min(to_ms)),
                },
            );
        }
    }
    Ok(rows)
}

/// Async so the window stays responsive while Claude thinks.
#[tauri::command]
async fn ask_notes(
    session_id: Option<i64>,
    conversation: Vec<assistant::ChatTurn>,
    app: AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        assistant::ask_about_notes(&app, session_id, conversation)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let db = db::open(&dir.join("history.db"))?;
            app.manage(AppState {
                session: Mutex::new(None),
                db: Mutex::new(db),
                activity: Mutex::new(None),
            });

            // Leftover block from a session that didn't end cleanly (crash, power loss).
            let _ = blocker::unblock_sites();

            activity::start(app.handle().clone());
            let handle = app.handle().clone();
            thread::spawn(move || assistant::greet(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_session,
            get_messages,
            start_session,
            update_session_info,
            stop_session,
            set_break,
            history,
            get_notes,
            add_note,
            update_note,
            delete_note,
            activities,
            ask_notes
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                activity::stop();
                let session = app.state::<AppState>().session.lock().unwrap().take();
                match session {
                    Some(session) => end_session(app, &session, now_ms()),
                    None => {
                        let _ = blocker::unblock_sites();
                    }
                }
            }
        });
}
