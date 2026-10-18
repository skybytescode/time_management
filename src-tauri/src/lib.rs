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
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const MAX_MINUTES: u32 = 240;
const MINUTE_MS: i64 = 60_000;
/// The assistant checks in every 20 minutes of session (`TM_CHECK_IN_MINUTES` overrides it)...
const CHECK_IN_EVERY_MS: i64 = 20 * MINUTE_MS;
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
    /// The goal this session contributes to, if any.
    goal_id: Option<i64>,
    goal_title: Option<String>,
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

fn block_list(state: &AppState) -> Vec<String> {
    db::active_block_domains(&state.db.lock().unwrap()).unwrap_or_default()
}

/// Whether the block list should stay enforced while the app runs, outside sessions.
fn always_block(state: &AppState) -> bool {
    db::get_setting(&state.db.lock().unwrap(), "always_block")
        .ok()
        .flatten()
        .as_deref()
        == Some("1")
}

/// Applies the current block list, or lifts it when the list is empty.
fn apply_block(state: &AppState) -> Result<(), String> {
    blocker::block_sites(&block_list(state))
}

fn end_session(app: &AppHandle, session: &Session, end_ms: i64) {
    let state = app.state::<AppState>();
    if let Err(e) = db::end_session(&state.db.lock().unwrap(), session.id, end_ms) {
        eprintln!("could not save session end: {e}");
    }
    // Keep sites blocked after the session if the user asked for an always-on block.
    let result = if always_block(&state) {
        apply_block(&state)
    } else {
        blocker::unblock_sites()
    };
    if let Err(e) = result {
        eprintln!("could not update site block: {e}");
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
    // (break start, number of 5-minute reminders already spoken for it).
    let mut break_reminders: Option<(i64, i64)> = None;

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

        // Nudge back to work at every 5-minute mark of a break (5, 10, 15, ...).
        if let Some(start) = session.break_start_ms {
            let due = (now - start) / BREAK_MS;
            let spoken = match break_reminders {
                Some((s, count)) if s == start => count,
                _ => 0,
            };
            if due > spoken {
                break_reminders = Some((start, due));
                let minutes = (due * BREAK_MS / MINUTE_MS) as u32;
                let (app, session) = (app.clone(), session.clone());
                thread::spawn(move || assistant::break_reminder(&app, &session, minutes, due == 1));
            }
        } else {
            break_reminders = None;
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
    goal_id: Option<i64>,
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
    let (id, goal_title) = {
        let db = state.db.lock().unwrap();
        let id = db::create_session(&db, &task, &objectives, minutes, goal_id, start_ms).map_err(err)?;
        let title = goal_id.and_then(|g| db::goal_title(&db, g).ok().flatten());
        (id, title)
    };
    let session = Session {
        id,
        task,
        objectives,
        goal_id,
        goal_title,
        start_ms,
        end_ms: minutes.map(|m| start_ms + i64::from(m) * MINUTE_MS),
        block_error: apply_block(&state).err(),
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

/// Links the running session to a goal, or clears the link with `None`.
#[tauri::command]
fn set_session_goal(goal_id: Option<i64>, state: State<AppState>) -> Result<Session, String> {
    let mut current = state.session.lock().unwrap();
    let session = current.as_mut().ok_or("no session is running")?;
    let db = state.db.lock().unwrap();
    db::set_session_goal(&db, session.id, goal_id).map_err(err)?;
    session.goal_id = goal_id;
    session.goal_title = goal_id.and_then(|g| db::goal_title(&db, g).ok().flatten());
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

#[tauri::command]
fn get_goals(state: State<AppState>) -> Result<Vec<db::Goal>, String> {
    db::goals(&state.db.lock().unwrap()).map_err(err)
}

fn goal_title(title: &str) -> Result<&str, String> {
    let title = title.trim();
    if title.is_empty() {
        Err("write a goal title first".into())
    } else {
        Ok(title)
    }
}

#[tauri::command]
fn add_goal(
    title: String,
    details: String,
    due_ms: Option<i64>,
    state: State<AppState>,
) -> Result<db::Goal, String> {
    db::add_goal(
        &state.db.lock().unwrap(),
        goal_title(&title)?,
        details.trim(),
        due_ms,
        now_ms(),
    )
    .map_err(err)
}

#[tauri::command]
fn update_goal(
    id: i64,
    title: String,
    details: String,
    due_ms: Option<i64>,
    state: State<AppState>,
) -> Result<db::Goal, String> {
    db::update_goal(
        &state.db.lock().unwrap(),
        id,
        goal_title(&title)?,
        details.trim(),
        due_ms,
    )
    .map_err(err)
}

#[tauri::command]
fn set_goal_done(id: i64, done: bool, state: State<AppState>) -> Result<db::Goal, String> {
    db::set_goal_done(&state.db.lock().unwrap(), id, done, now_ms()).map_err(err)
}

#[tauri::command]
fn delete_goal(id: i64, state: State<AppState>) -> Result<(), String> {
    db::delete_goal(&state.db.lock().unwrap(), id).map_err(err)
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

#[derive(Serialize)]
struct Blocking {
    sites: Vec<db::BlockedSite>,
    always_block: bool,
    /// Whether the sites are blocked right now (a session is running, or always-block is on).
    active: bool,
    /// Claude's opinion on the reason, for actions that lift a block; not persisted here.
    opinion: Option<String>,
}

fn blocking_state(state: &AppState) -> Result<Blocking, String> {
    let running = state.session.lock().unwrap().is_some();
    let always = always_block(state);
    Ok(Blocking {
        sites: db::blocked_site_rows(&state.db.lock().unwrap()).map_err(err)?,
        always_block: always,
        active: running || always,
        opinion: None,
    })
}

/// Cleans up a domain typed or pasted by the user, or explains why it's not valid.
fn normalize_domain(input: &str) -> Result<String, String> {
    let mut domain = input.trim().to_lowercase();
    if let Some((_, rest)) = domain.split_once("://") {
        domain = rest.to_string();
    }
    domain = domain
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_string();
    domain = domain.strip_prefix("www.").unwrap_or(&domain).to_string();
    let valid = domain.contains('.')
        && !domain.starts_with(['.', '-'])
        && !domain.ends_with(['.', '-'])
        && !domain.contains("..")
        && domain
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
    if valid {
        Ok(domain)
    } else {
        Err(format!("not a valid site: {input}"))
    }
}

/// Re-applies the block after an edit, so changes take effect at once while blocking is on.
fn reapply_if_active(state: &AppState) {
    let running = state.session.lock().unwrap().is_some();
    if (running || always_block(state))
        && let Err(e) = apply_block(state)
    {
        eprintln!("could not update site block: {e}");
    }
}

#[tauri::command]
fn get_blocking(state: State<AppState>) -> Result<Blocking, String> {
    blocking_state(&state)
}

#[tauri::command]
fn add_blocked_site(domain: String, state: State<AppState>) -> Result<Blocking, String> {
    let domain = normalize_domain(&domain)?;
    db::add_blocked_site(&state.db.lock().unwrap(), &domain).map_err(err)?;
    reapply_if_active(&state);
    blocking_state(&state)
}

#[tauri::command]
fn remove_blocked_site(domain: String, state: State<AppState>) -> Result<Blocking, String> {
    db::remove_blocked_site(&state.db.lock().unwrap(), &domain).map_err(err)?;
    reapply_if_active(&state);
    blocking_state(&state)
}

fn current_session_id(state: &AppState) -> Option<i64> {
    state.session.lock().unwrap().as_ref().map(|s| s.id)
}

/// Temporarily allows one blocked site (e.g. YouTube for a tutorial). The reason and Claude's
/// opinion are stored; the site is exempt from blocking until re-blocked or the app restarts.
#[tauri::command]
async fn allow_site(domain: String, reason: String, app: AppHandle) -> Result<Blocking, String> {
    let reason = reason.trim().to_string();
    if reason.is_empty() {
        return Err("write a reason first".into());
    }
    let domain = normalize_domain(&domain)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let opinion =
            assistant::opinion_on_reason(&app, &format!("allow {domain} during work"), &reason).ok();
        let session_id = current_session_id(&state);
        {
            let db = state.db.lock().unwrap();
            db::add_block_reason(
                &db,
                now_ms(),
                session_id,
                "allow-site",
                Some(&domain),
                &reason,
                opinion.as_deref(),
            )
            .map_err(err)?;
            db::set_site_allowed(&db, &domain, true).map_err(err)?;
        }
        reapply_if_active(&state);
        let mut blocking = blocking_state(&state)?;
        blocking.opinion = opinion;
        Ok(blocking)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Blocks an allowed site again.
#[tauri::command]
fn reblock_site(domain: String, state: State<AppState>) -> Result<Blocking, String> {
    db::set_site_allowed(&state.db.lock().unwrap(), &domain, false).map_err(err)?;
    reapply_if_active(&state);
    blocking_state(&state)
}

/// Turns the always-on block on or off. Turning it off needs a reason (stored); Claude's opinion is
/// returned for display but not stored.
#[tauri::command]
async fn set_always_block(
    on: bool,
    reason: Option<String>,
    app: AppHandle,
) -> Result<Blocking, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut opinion = None;
        if !on {
            let reason = reason.unwrap_or_default().trim().to_string();
            if reason.is_empty() {
                return Err("write a reason first".into());
            }
            opinion =
                assistant::opinion_on_reason(&app, "turn off the site block entirely", &reason).ok();
            let session_id = current_session_id(&state);
            db::add_block_reason(
                &state.db.lock().unwrap(),
                now_ms(),
                session_id,
                "disable-block",
                None,
                &reason,
                None, // opinion not stored for disabling the block
            )
            .map_err(err)?;
        }
        db::set_setting(
            &state.db.lock().unwrap(),
            "always_block",
            if on { "1" } else { "0" },
        )
        .map_err(err)?;
        let result = if on {
            apply_block(&state)
        } else if current_session_id(&state).is_none() {
            blocker::unblock_sites()
        } else {
            Ok(()) // a session is still running, keep blocking
        };
        result?;
        let mut blocking = blocking_state(&state)?;
        blocking.opinion = opinion;
        Ok(blocking)
    })
    .await
    .map_err(|e| e.to_string())?
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

/// Brings the main window back from the tray.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// A tray icon so the app keeps running after the window is closed.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::new()
        .tooltip("Time Management")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
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

            // Start every launch fully blocked: clear temporary allowances, turn the always-on
            // block on, and apply it so sites are blocked even before a session.
            let state = app.state::<AppState>();
            {
                let db = state.db.lock().unwrap();
                let _ = db::reset_allowances(&db);
                let _ = db::set_setting(&db, "always_block", "1");
            }
            let _ = apply_block(&state);

            activity::start(app.handle().clone());
            let handle = app.handle().clone();
            thread::spawn(move || assistant::greet(&handle));

            setup_tray(app.handle())?;
            // Closing the window hides it to the tray instead of quitting; use the tray to quit.
            if let Some(window) = app.get_webview_window("main") {
                let hidden = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hidden.hide();
                    }
                });
            }
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
            get_goals,
            add_goal,
            update_goal,
            set_goal_done,
            delete_goal,
            set_session_goal,
            get_blocking,
            add_blocked_site,
            remove_blocked_site,
            allow_site,
            reblock_site,
            set_always_block,
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
