//! The voice assistant: messages written by Claude (through the `claude` CLI, so it runs on the
//! user's Claude subscription), spoken with Piper and saved in the history.

use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use chrono::{Local, Timelike};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::{AppState, Session, db, now_ms, voice};

/// Fast model for greetings and short remarks, a stronger one for reading screenshots.
const QUICK_MODEL: &str = "haiku";
const VISION_MODEL: &str = "sonnet";
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(120);
/// Don't greet again if the app is reopened within this time.
const GREETING_GAP_MS: i64 = 4 * 3_600_000;
/// Screenshots are scaled down to this longest side before sending.
const SHOT_MAX_SIDE: u32 = 1568;

const PERSONA: &str = "You are the personal work assistant built into Sergiu's time management \
desktop app. Everything you write is spoken aloud by a text-to-speech voice, so write natural spoken \
English: no markdown, lists, emoji, URLs, code or long identifiers. Sound like a real, warm colleague \
who knows Sergiu's work, not a template: vary your wording every time, be specific, keep it short.";

fn message_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "message": { "type": "string" } },
        "required": ["message"]
    })
}

fn claude_bin() -> PathBuf {
    // Autostarted apps may not have ~/.local/bin in PATH.
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".local/bin/claude"))
        .filter(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from("claude"))
}

/// Sends one user message (text and image blocks) and returns the reply: structured if a
/// `schema` is given, a string otherwise.
fn ask(
    app: &AppHandle,
    model: &str,
    system: &str,
    content: Vec<Value>,
    schema: Option<&Value>,
) -> Result<Value, String> {
    // An empty working directory, so no project CLAUDE.md is picked up.
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("claude");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut command = Command::new(claude_bin());
    command
        .current_dir(&dir)
        .args([
            "-p",
            "--model",
            model,
            "--tools",
            "",
            "--no-session-persistence",
            "--setting-sources",
            "",
        ])
        .args([
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
        ])
        .arg("--system-prompt")
        .arg(system);
    if let Some(schema) = schema {
        command.arg("--json-schema").arg(schema.to_string());
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run claude: {e}"))?;

    let input = json!({ "type": "user", "message": { "role": "user", "content": content } });
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(format!("{input}\n").as_bytes())
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = thread::spawn(move || {
        let mut output = String::new();
        stdout.read_to_string(&mut output).map(|_| output)
    });

    let started = Instant::now();
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if started.elapsed() > CLAUDE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("claude timed out".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let output = reader
        .join()
        .expect("reader thread")
        .map_err(|e| e.to_string())?;

    let result = output
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|event| event["type"] == "result")
        .ok_or("claude gave no result")?;
    if result["is_error"] == true {
        return Err(format!("claude failed: {}", result["result"]));
    }
    let reply = if schema.is_some() {
        &result["structured_output"]
    } else {
        &result["result"]
    };
    match reply {
        Value::Null => Err("claude gave no reply".into()),
        reply => Ok(reply.clone()),
    }
}

fn ask_message(app: &AppHandle, prompt: String) -> Result<String, String> {
    let reply = ask(
        app,
        QUICK_MODEL,
        PERSONA,
        vec![json!({ "type": "text", "text": prompt })],
        Some(&message_schema()),
    )?;
    reply["message"]
        .as_str()
        .map(str::to_string)
        .ok_or("reply without message".into())
}

fn period(hour: u32) -> &'static str {
    match hour {
        5..=11 => "morning",
        12..=16 => "afternoon",
        17..=21 => "evening",
        _ => "night",
    }
}

fn time_context() -> String {
    let now = Local::now();
    format!(
        "{} ({})",
        now.format("%A %-d %B %Y, %H:%M"),
        period(now.hour())
    )
}

/// Picks one of `options`, different from run to run.
fn pick<'a>(options: &[&'a str]) -> &'a str {
    options[(now_ms() as usize / 1000) % options.len()]
}

fn recent_sessions(app: &AppHandle, since_ms: i64) -> String {
    let state = app.state::<AppState>();
    let lines = db::recent_summary(&state.db.lock().unwrap(), since_ms).unwrap_or_default();
    if lines.is_empty() {
        "none recorded".into()
    } else {
        lines.join("\n")
    }
}

/// Sergiu's active long-term goals, shared with every assistant message so it keeps the big picture.
fn global_goals(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let lines = db::active_goal_lines(&state.db.lock().unwrap()).unwrap_or_default();
    if lines.is_empty() {
        "none set".into()
    } else {
        lines.join("\n")
    }
}

/// Saves the message, shows it in the window and says it.
fn deliver(
    app: &AppHandle,
    session_id: Option<i64>,
    kind: &str,
    text: String,
    observation: Option<String>,
) {
    let message = db::Message {
        session_id,
        at_ms: now_ms(),
        kind: kind.into(),
        text,
        observation,
    };
    {
        let state = app.state::<AppState>();
        if let Err(e) = db::add_message(&state.db.lock().unwrap(), &message) {
            eprintln!("could not save message: {e}");
        }
    }
    let _ = app.emit("assistant-message", &message);
    if let Err(e) = voice::speak(app, &message.text) {
        eprintln!("could not speak: {e}");
        if kind == "finished" {
            let _ = voice::play_finished(app);
        }
    }
}

/// Greets Sergiu when the app starts, unless it already did recently.
pub fn greet(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let last = db::get_setting(&db, "last_greeting_ms")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok());
        if last.is_some_and(|last| now_ms() - last < GREETING_GAP_MS) {
            return;
        }
        let _ = db::set_setting(&db, "last_greeting_ms", &now_ms().to_string());
    }

    let prompt = format!(
        "Sergiu just turned on the computer and the app opened. It is {}.\n\
         His long-term goals:\n{}\n\
         Work sessions in the last three days:\n{}\n\n\
         Greet Sergiu by name with a greeting that fits the time of day, then add something \
         motivating for what's ahead. You may refer to recent work or a goal. Two or three sentences.",
        time_context(),
        global_goals(app),
        recent_sessions(app, now_ms() - 3 * 24 * 3_600_000),
    );
    let text = ask_message(app, prompt).unwrap_or_else(|e| {
        eprintln!("greeting: {e}");
        let greeting = match period(Local::now().hour()) {
            "morning" => pick(&[
                "Good morning, Sergiu!",
                "Morning, Sergiu!",
                "Hello Sergiu, good morning!",
            ]),
            "afternoon" => pick(&[
                "Good afternoon, Sergiu!",
                "Hello Sergiu!",
                "Good day, Sergiu!",
            ]),
            "evening" => pick(&["Good evening, Sergiu!", "Hello Sergiu, good evening!"]),
            _ => pick(&[
                "Hello Sergiu, working late tonight?",
                "Hi Sergiu, it's a late one.",
            ]),
        };
        let push = pick(&[
            "Let's make today count.",
            "One focused session at a time.",
            "Pick the most important thing and start there.",
            "Small steps, done well, add up.",
        ]);
        format!("{greeting} {push}")
    });
    deliver(app, None, "greeting", text, None);
}

fn session_kind(session: &Session) -> String {
    match session.end_ms {
        Some(end_ms) => format!(
            "a timed session of {} minutes",
            (end_ms - session.start_ms) / 60_000
        ),
        None => "an open-ended session that ends when Sergiu decides".into(),
    }
}

/// "Objectives: …" plus a newline, or nothing when none were written.
fn objectives_line(objectives: &str) -> String {
    if objectives.is_empty() {
        String::new()
    } else {
        format!("Objectives: {objectives}\n")
    }
}

/// Announces a new session with a good-luck message about its task.
pub fn session_started(app: &AppHandle, session: &Session) {
    let prompt = format!(
        "Sergiu just started a work session. It is {}. It's {}.\nTask: \"{}\"\n{}\
         His long-term goals:\n{}\n\
         Sessions earlier today:\n{}\n\n\
         Say the session has started and wish good luck in a way that fits this specific task \
         and its objectives; you may tie it to a goal if it fits. One or two short sentences.",
        time_context(),
        session_kind(session),
        session.task,
        objectives_line(&session.objectives),
        global_goals(app),
        recent_sessions(
            app,
            Local::now()
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .and_then(|t| t.and_local_timezone(Local).single())
                .map_or(now_ms() - 12 * 3_600_000, |t| t.timestamp_millis())
        ),
    );
    let text = ask_message(app, prompt).unwrap_or_else(|e| {
        eprintln!("session start: {e}");
        format!(
            "{} Good luck!",
            pick(&[
                "Session started.",
                "Here we go.",
                "Your session is running."
            ])
        )
    });
    deliver(app, Some(session.id), "start", text, None);
}

/// Says something when the session ends, by the user (`finished == false`) or the timer.
pub fn session_ended(app: &AppHandle, session: &Session, end_ms: i64, finished: bool) {
    let worked = (end_ms - session.start_ms - session.break_ms_until(end_ms)) / 60_000;
    let notes = {
        let state = app.state::<AppState>();
        let messages =
            db::session_messages(&state.db.lock().unwrap(), session.id).unwrap_or_default();
        messages
            .into_iter()
            .filter_map(|m| m.observation)
            .collect::<Vec<_>>()
            .join("\n")
    };
    let prompt = format!(
        "Sergiu just {} a work session on \"{}\": {worked} minutes of work and {} breaks. It is {}.\n\
         {}What you saw on screen during the session:\n{}\n\n\
         Give a short closing remark: acknowledge the work specifically and suggest some rest. \
         One or two sentences.",
        if finished {
            "finished (the timer ran out)"
        } else {
            "ended"
        },
        session.task,
        session.breaks,
        time_context(),
        objectives_line(&session.objectives),
        if notes.is_empty() {
            "nothing recorded"
        } else {
            &notes
        },
    );
    let text = ask_message(app, prompt).unwrap_or_else(|e| {
        eprintln!("session end: {e}");
        format!(
            "Session finished, {worked} minutes of work. {}",
            pick(&["Take a rest.", "Well done, have a break."])
        )
    });
    deliver(app, Some(session.id), "finished", text, None);
}

/// Spoken at each 5-minute mark of a break (`first` is the 5-minute one), to nudge back to work.
/// No Claude needed, so it's instant and free.
pub fn break_reminder(app: &AppHandle, session: &Session, minutes: u32, first: bool) {
    let text = if first {
        pick(&[
            "Five minutes are up. Ready to get back to it?",
            "That's your five minute break. Back to work when you're ready.",
            "Break time's over, Sergiu. Let's pick it up again.",
            "Hope that was refreshing. Shall we continue?",
        ])
        .to_string()
    } else {
        // Pick an opener and an encouragement, varied from one reminder to the next.
        let openers = [
            format!("That's {minutes} minutes on your break now, Sergiu."),
            format!("You've been away for {minutes} minutes."),
            format!("Your break is at {minutes} minutes."),
            format!("{minutes} minutes of break so far."),
        ];
        let pushes = [
            "Let's head back and pick up where you left off.",
            "Time to get back to it while you're still fresh.",
            "Your task is waiting — shall we keep the momentum going?",
            "A good moment to return and make some progress.",
            "Come on, one more focused stretch and you'll feel great.",
        ];
        let seed = (now_ms() / 1000) as usize;
        format!(
            "{} {}",
            openers[seed % openers.len()],
            pushes[seed % pushes.len()]
        )
    };
    deliver(app, Some(session.id), "break-over", text, None);
}

/// Screenshot of the active window, scaled down and JPEG-encoded in base64. Nothing stays on disk.
pub fn capture_screen(app: &AppHandle) -> Result<String, String> {
    let file = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("checkin.png");
    let status = Command::new("spectacle")
        .args(["-b", "-n", "-a", "-o"])
        .arg(&file)
        .env("LC_ALL", "C.UTF-8")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("could not run spectacle: {e}"))?;
    let image = if status.success() {
        image::open(&file).map_err(|e| e.to_string())
    } else {
        Err(format!("spectacle failed: {status}"))
    };
    let _ = std::fs::remove_file(&file);
    let image = image?;
    let image = if image.width().max(image.height()) > SHOT_MAX_SIDE {
        image.resize(
            SHOT_MAX_SIDE,
            SHOT_MAX_SIDE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let mut jpeg = Vec::new();
    image
        .to_rgb8()
        .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(jpeg))
}

/// The check-in: Claude looks at the screenshots and gives advice, motivation or a break.
pub fn check_in(app: &AppHandle, session: &Session, shots: Vec<String>) {
    let now = now_ms();
    let elapsed = (now - session.start_ms) / 60_000;
    let since_break = (now - session.last_break_end_ms.unwrap_or(session.start_ms)) / 60_000;
    let (earlier, notes) = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let messages = db::session_messages(&db, session.id).unwrap_or_default();
        let notes = db::session_notes(&db, session.id).unwrap_or_default();
        (
            messages
                .iter()
                .map(|m| format!("[{}] {}", m.kind, m.text))
                .collect::<Vec<_>>()
                .join("\n"),
            notes
                .iter()
                .map(|n| format!("- {}", n.text))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    };
    let prompt = format!(
        "Check-in. It is {}. Sergiu's task: \"{}\".\n\
         {}His long-term goals:\n{}\n\
         The session has run {elapsed} minutes, {since_break} minutes since the last break \
         ({} breaks so far). The images are the active window over the last few minutes.\n\
         What you said earlier this session:\n{}\n\
         Sergiu's notes in this session:\n{}\n\n\
         First work out what Sergiu is actually doing. Then say one genuinely useful thing: a \
         concrete technical tip about what's on screen, something that might be overlooked (a bug, \
         a risky step, a better approach), or real motivation if it's going well. If the work has \
         drifted from the task, its objectives or his goals, point that out kindly. Don't repeat \
         earlier advice.\n\
         Breaks: if it's been 60 or more minutes since the last break, also recommend a 5 minute \
         break. At 120 or more, make the break the main message and be firm about it.\n\
         Two to four spoken sentences.",
        time_context(),
        session.task,
        objectives_line(&session.objectives),
        global_goals(app),
        session.breaks,
        if earlier.is_empty() {
            "nothing yet"
        } else {
            &earlier
        },
        if notes.is_empty() { "none" } else { &notes },
    );
    let mut content: Vec<Value> = shots
        .into_iter()
        .map(|data| json!({ "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": data } }))
        .collect();
    content.push(json!({ "type": "text", "text": prompt }));
    let schema = json!({
        "type": "object",
        "properties": {
            "observation": { "type": "string", "description": "One sentence on what is on screen; not spoken." },
            "kind": { "type": "string", "enum": ["technical", "motivational", "break"] },
            "message": { "type": "string" }
        },
        "required": ["observation", "kind", "message"]
    });

    match ask(app, VISION_MODEL, PERSONA, content, Some(&schema)) {
        Ok(reply) => {
            let text = reply["message"].as_str().unwrap_or_default().to_string();
            let kind = reply["kind"].as_str().unwrap_or("motivational").to_string();
            let observation = reply["observation"].as_str().map(str::to_string);
            if !text.is_empty() {
                deliver(app, Some(session.id), &kind, text, observation);
            }
        }
        Err(e) => {
            eprintln!("check-in: {e}");
            if since_break >= 60 {
                let text = format!(
                    "You've been working {since_break} minutes without a break. Time for five minutes away from the screen."
                );
                deliver(app, Some(session.id), "break", text, None);
            }
        }
    }
}

const NOTES_PERSONA: &str = "You are the assistant inside Sergiu's time management app, answering \
questions in its chat about Sergiu's work sessions and the notes written in them. Answer from the \
session history you are given, say which session (date and task) something comes from, and say so \
plainly when the history doesn't contain the answer. Plain text only, no markdown; short paragraphs.";
/// Upper bound on the session history sent with a question.
const NOTES_CONTEXT_CHARS: usize = 150_000;

#[derive(serde::Deserialize)]
pub struct ChatTurn {
    /// "user" or "assistant".
    role: String,
    text: String,
}

fn local(ms: i64, format: &str) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&Local).format(format).to_string())
        .unwrap_or_default()
}

fn describe_session(record: &db::SessionRecord) -> String {
    let end = record
        .end_ms
        .map_or("still running".into(), |ms| local(ms, "%H:%M"));
    let mut text = format!(
        "## Session {}: \"{}\"\n{} to {end}, {} breaks\n{}",
        record.id,
        record.task,
        local(record.start_ms, "%A %-d %B %Y, %H:%M"),
        record.breaks.len(),
        objectives_line(&record.objectives),
    );
    if !record.notes.is_empty() {
        text.push_str("Notes:\n");
        for note in &record.notes {
            text.push_str(&format!(
                "- [{}] {}\n",
                local(note.created_ms, "%H:%M"),
                note.text
            ));
        }
    }
    let said: Vec<_> = record
        .messages
        .iter()
        .filter(|m| m.kind != "greeting")
        .collect();
    if !said.is_empty() {
        text.push_str("Assistant during the session:\n");
        for m in said {
            text.push_str(&format!(
                "- [{} {}] {}",
                local(m.at_ms, "%H:%M"),
                m.kind,
                m.text
            ));
            if let Some(observation) = &m.observation {
                text.push_str(&format!(" (saw: {observation})"));
            }
            text.push('\n');
        }
    }
    text
}

/// Answers the last question of `conversation` about one session, or all of them.
pub fn ask_about_notes(
    app: &AppHandle,
    session_id: Option<i64>,
    conversation: Vec<ChatTurn>,
) -> Result<String, String> {
    let records = {
        let state = app.state::<AppState>();
        let filter = db::HistoryFilter {
            from_ms: None,
            to_ms: None,
            query: None,
        };
        db::history(&state.db.lock().unwrap(), &filter).map_err(|e| e.to_string())?
    };
    // Newest sessions first, until the context is full.
    let mut history = String::new();
    for record in records
        .iter()
        .filter(|r| session_id.is_none_or(|id| r.id == id))
    {
        let text = describe_session(record);
        if history.len() + text.len() > NOTES_CONTEXT_CHARS {
            break;
        }
        history.push_str(&text);
        history.push('\n');
    }
    let scope = if session_id.is_some() {
        "the session the question is about"
    } else {
        "Sergiu's sessions, newest first"
    };
    let mut transcript = String::new();
    for turn in &conversation {
        let who = if turn.role == "user" { "Sergiu" } else { "You" };
        transcript.push_str(&format!("{who}: {}\n\n", turn.text));
    }
    let prompt = format!(
        "It is {}. Sergiu's long-term goals:\n{}\n\nHere is {scope}:\n\n{}\n---\nConversation so far (answer Sergiu's last message):\n\n{transcript}",
        time_context(),
        global_goals(app),
        if history.is_empty() {
            "No sessions recorded yet.\n".into()
        } else {
            history
        },
    );
    let reply = ask(
        app,
        VISION_MODEL,
        NOTES_PERSONA,
        vec![json!({ "type": "text", "text": prompt })],
        None,
    )?;
    reply
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or("reply without text".into())
}

const COACH_PERSONA: &str = "You are Sergiu's focus coach inside his time management app. He keeps \
distracting sites blocked during work. When he wants to lift a block he gives a reason. Reply with \
a brief, honest opinion (one or two sentences): is the reason a genuine work need or a slippery \
slope back to distraction, and a short nudge to stay on task. Plain text, no markdown.";

/// Claude's brief opinion on a reason for reducing the site block. Used both when it is stored and
/// when it is only shown.
pub fn opinion_on_reason(app: &AppHandle, action: &str, reason: &str) -> Result<String, String> {
    let prompt = format!(
        "It is {}. Sergiu wants to {action}. His reason: \"{reason}\".\nGive your brief opinion.",
        time_context()
    );
    let reply = ask(
        app,
        QUICK_MODEL,
        COACH_PERSONA,
        vec![json!({ "type": "text", "text": prompt })],
        None,
    )?;
    reply
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or("reply without text".into())
}
