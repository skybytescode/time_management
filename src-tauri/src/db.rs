//! Session history in a single SQLite file in the app's data directory.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub type Db = Connection;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    task TEXT NOT NULL,             -- the session's title
    objectives TEXT NOT NULL DEFAULT '',
    planned_minutes INTEGER,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER,                 -- NULL while running
    last_seen_ms INTEGER NOT NULL,  -- heartbeat, closes sessions cut short by a crash
    goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL  -- the goal it contributes to
);
CREATE TABLE IF NOT EXISTS breaks (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER
);
-- Everything the assistant said; greetings have no session.
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    observation TEXT
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    text TEXT NOT NULL
);
-- One row per interval an application was the focused window.
CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY,
    app TEXT NOT NULL,              -- window class, e.g. code or org.kde.konsole
    title TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER                  -- NULL only briefly, for the row being written
);
CREATE TABLE IF NOT EXISTS blocked_sites (
    domain TEXT PRIMARY KEY,
    allowed INTEGER NOT NULL DEFAULT 0   -- 1 = temporarily exempt from blocking
);
-- Why the user reduced blocking: allowing a site, or turning the always-on block off.
CREATE TABLE IF NOT EXISTS block_reasons (
    id INTEGER PRIMARY KEY,
    at_ms INTEGER NOT NULL,
    session_id INTEGER,
    kind TEXT NOT NULL,           -- 'allow-site' or 'disable-block'
    domain TEXT,
    reason TEXT NOT NULL,
    opinion TEXT                  -- Claude's opinion; NULL when not stored
);
-- Long-term goals, independent of any session.
CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    due_ms INTEGER,                      -- optional target date
    done INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    done_ms INTEGER                      -- when it was marked done
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- A session can contribute to several goals, and a goal to several sessions.
CREATE TABLE IF NOT EXISTS session_goals (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, goal_id)
);
CREATE INDEX IF NOT EXISTS session_goals_goal ON session_goals(goal_id);
CREATE INDEX IF NOT EXISTS sessions_start ON sessions(start_ms);
CREATE INDEX IF NOT EXISTS breaks_session ON breaks(session_id);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS notes_session ON notes(session_id);
CREATE INDEX IF NOT EXISTS activities_start ON activities(start_ms);
";

#[derive(Clone, Serialize)]
pub struct Interval {
    pub start_ms: i64,
    pub end_ms: Option<i64>,
}

#[derive(Clone, Serialize)]
pub struct Message {
    pub session_id: Option<i64>,
    pub at_ms: i64,
    pub kind: String,
    pub text: String,
    pub observation: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Note {
    pub id: i64,
    pub session_id: i64,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct Activity {
    pub app: String,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
}

#[derive(Clone, Serialize)]
pub struct BlockedSite {
    pub domain: String,
    pub allowed: bool,
}

#[derive(Clone, Serialize)]
pub struct Goal {
    pub id: i64,
    pub title: String,
    pub details: String,
    pub due_ms: Option<i64>,
    pub done: bool,
    pub created_ms: i64,
    pub done_ms: Option<i64>,
    /// Worked time of finished sessions linked to this goal, and their count.
    pub worked_ms: i64,
    pub sessions: i64,
}

/// A goal a session is linked to: just enough to show and change the link.
#[derive(Clone, Serialize)]
pub struct GoalRef {
    pub id: i64,
    pub title: String,
}

#[derive(Serialize)]
pub struct SessionRecord {
    pub id: i64,
    pub task: String,
    pub objectives: String,
    pub planned_minutes: Option<i64>,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    pub goals: Vec<GoalRef>,
    pub breaks: Vec<Interval>,
    pub messages: Vec<Message>,
    pub notes: Vec<Note>,
}

#[derive(Deserialize)]
pub struct HistoryFilter {
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub query: Option<String>,
}

pub fn open(path: &Path) -> rusqlite::Result<Db> {
    let db = Connection::open(path)?;
    db.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    db.execute_batch(SCHEMA)?;
    // Seed the block list on a fresh database; after that the user owns it, empty included.
    if db.query_row("SELECT COUNT(*) FROM blocked_sites", [], |r| {
        r.get::<_, i64>(0)
    })? == 0
        && get_setting(&db, "block_list_seeded")?.is_none()
    {
        for site in crate::blocker::DEFAULT_SITES {
            db.execute(
                "INSERT OR IGNORE INTO blocked_sites (domain) VALUES (?1)",
                [site],
            )?;
        }
        set_setting(&db, "block_list_seeded", "1")?;
    }
    // Databases from before sessions could be linked to a goal.
    let has_goal = db
        .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'goal_id'")?
        .exists([])?;
    if !has_goal {
        db.execute_batch("ALTER TABLE sessions ADD COLUMN goal_id INTEGER REFERENCES goals(id)")?;
    }
    // Databases from before a session could link to several goals: move the single goal_id into
    // the join table, once. After that session_goals is the source of truth and goal_id is unused.
    if get_setting(&db, "session_goals_migrated")?.is_none() {
        db.execute_batch(
            "INSERT OR IGNORE INTO session_goals (session_id, goal_id)
             SELECT id, goal_id FROM sessions WHERE goal_id IS NOT NULL;",
        )?;
        set_setting(&db, "session_goals_migrated", "1")?;
    }
    // Databases from before per-site allowances existed.
    let has_allowed = db
        .prepare("SELECT 1 FROM pragma_table_info('blocked_sites') WHERE name = 'allowed'")?
        .exists([])?;
    if !has_allowed {
        db.execute_batch("ALTER TABLE blocked_sites ADD COLUMN allowed INTEGER NOT NULL DEFAULT 0")?;
    }
    // Databases from before session objectives existed.
    let has_objectives = db
        .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'objectives'")?
        .exists([])?;
    if !has_objectives {
        db.execute_batch("ALTER TABLE sessions ADD COLUMN objectives TEXT NOT NULL DEFAULT ''")?;
    }
    // Sessions left running by a crash or power loss end where they were last seen.
    db.execute_batch(
        "UPDATE sessions SET end_ms = last_seen_ms WHERE end_ms IS NULL;
         UPDATE breaks SET end_ms = (SELECT end_ms FROM sessions WHERE id = session_id) WHERE end_ms IS NULL;",
    )?;
    Ok(db)
}

pub fn create_session(
    db: &Db,
    task: &str,
    objectives: &str,
    planned_minutes: Option<u32>,
    goal_ids: &[i64],
    start_ms: i64,
) -> rusqlite::Result<i64> {
    db.execute(
        "INSERT INTO sessions (task, objectives, planned_minutes, start_ms, last_seen_ms)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![task, objectives, planned_minutes, start_ms],
    )?;
    let id = db.last_insert_rowid();
    set_session_goals(db, id, goal_ids)?;
    Ok(id)
}

/// Links a session (running or finished) to exactly the given goals, replacing any earlier links.
pub fn set_session_goals(db: &Db, id: i64, goal_ids: &[i64]) -> rusqlite::Result<()> {
    db.execute("DELETE FROM session_goals WHERE session_id = ?1", [id])?;
    let mut stmt =
        db.prepare("INSERT OR IGNORE INTO session_goals (session_id, goal_id) VALUES (?1, ?2)")?;
    for &goal_id in goal_ids {
        stmt.execute(params![id, goal_id])?;
    }
    Ok(())
}

/// The goals a session is linked to, by title.
pub fn session_goal_refs(db: &Db, id: i64) -> rusqlite::Result<Vec<GoalRef>> {
    db.prepare(
        "SELECT g.id, g.title FROM session_goals sg JOIN goals g ON g.id = sg.goal_id
         WHERE sg.session_id = ?1 ORDER BY g.title",
    )?
    .query_map([id], |row| {
        Ok(GoalRef {
            id: row.get(0)?,
            title: row.get(1)?,
        })
    })?
    .collect()
}

/// Changes the title and objectives of a running session; returns false if it has ended.
pub fn update_session_info(
    db: &Db,
    id: i64,
    task: &str,
    objectives: &str,
) -> rusqlite::Result<bool> {
    let changed = db.execute(
        "UPDATE sessions SET task = ?2, objectives = ?3 WHERE id = ?1 AND end_ms IS NULL",
        params![id, task, objectives],
    )?;
    Ok(changed == 1)
}

pub fn touch_session(db: &Db, id: i64, now_ms: i64) -> rusqlite::Result<()> {
    db.execute(
        "UPDATE sessions SET last_seen_ms = ?2 WHERE id = ?1",
        params![id, now_ms],
    )?;
    Ok(())
}

pub fn end_session(db: &Db, id: i64, end_ms: i64) -> rusqlite::Result<()> {
    db.execute(
        "UPDATE sessions SET end_ms = ?2, last_seen_ms = ?2 WHERE id = ?1",
        params![id, end_ms],
    )?;
    end_break(db, id, end_ms)
}

pub fn start_break(db: &Db, session_id: i64, start_ms: i64) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO breaks (session_id, start_ms) VALUES (?1, ?2)",
        params![session_id, start_ms],
    )?;
    Ok(())
}

pub fn end_break(db: &Db, session_id: i64, end_ms: i64) -> rusqlite::Result<()> {
    db.execute(
        "UPDATE breaks SET end_ms = ?2 WHERE session_id = ?1 AND end_ms IS NULL",
        params![session_id, end_ms],
    )?;
    Ok(())
}

pub fn add_message(db: &Db, message: &Message) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO messages (session_id, at_ms, kind, text, observation) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![message.session_id, message.at_ms, message.kind, message.text, message.observation],
    )?;
    Ok(())
}

fn message_row(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    Ok(Message {
        session_id: row.get(0)?,
        at_ms: row.get(1)?,
        kind: row.get(2)?,
        text: row.get(3)?,
        observation: row.get(4)?,
    })
}

pub fn session_messages(db: &Db, session_id: i64) -> rusqlite::Result<Vec<Message>> {
    db.prepare("SELECT session_id, at_ms, kind, text, observation FROM messages WHERE session_id = ?1 ORDER BY at_ms")?
        .query_map([session_id], message_row)?
        .collect()
}

pub fn latest_greeting(db: &Db, since_ms: i64) -> rusqlite::Result<Option<Message>> {
    db.query_row(
        "SELECT session_id, at_ms, kind, text, observation FROM messages
         WHERE kind = 'greeting' AND at_ms >= ?1 ORDER BY at_ms DESC LIMIT 1",
        [since_ms],
        message_row,
    )
    .optional()
}

fn note_row(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        session_id: row.get(1)?,
        created_ms: row.get(2)?,
        updated_ms: row.get(3)?,
        text: row.get(4)?,
    })
}

const NOTE_COLUMNS: &str = "id, session_id, created_ms, updated_ms, text";

pub fn session_notes(db: &Db, session_id: i64) -> rusqlite::Result<Vec<Note>> {
    db.prepare(&format!(
        "SELECT {NOTE_COLUMNS} FROM notes WHERE session_id = ?1 ORDER BY created_ms"
    ))?
    .query_map([session_id], note_row)?
    .collect()
}

pub fn add_note(db: &Db, session_id: i64, text: &str, now_ms: i64) -> rusqlite::Result<Note> {
    db.execute(
        "INSERT INTO notes (session_id, created_ms, updated_ms, text) VALUES (?1, ?2, ?2, ?3)",
        params![session_id, now_ms, text],
    )?;
    db.query_row(
        &format!("SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1"),
        [db.last_insert_rowid()],
        note_row,
    )
}

pub fn update_note(db: &Db, id: i64, text: &str, now_ms: i64) -> rusqlite::Result<Note> {
    db.execute(
        "UPDATE notes SET text = ?2, updated_ms = ?3 WHERE id = ?1",
        params![id, text, now_ms],
    )?;
    db.query_row(
        &format!("SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1"),
        [id],
        note_row,
    )
}

pub fn delete_note(db: &Db, id: i64) -> rusqlite::Result<()> {
    db.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    Ok(())
}

fn session_breaks(db: &Db, session_id: i64) -> rusqlite::Result<Vec<Interval>> {
    db.prepare("SELECT start_ms, end_ms FROM breaks WHERE session_id = ?1 ORDER BY start_ms")?
        .query_map([session_id], |row| {
            Ok(Interval {
                start_ms: row.get(0)?,
                end_ms: row.get(1)?,
            })
        })?
        .collect()
}

/// Sessions started in the filter's range whose title, objectives or notes contain the query,
/// newest first.
pub fn history(db: &Db, filter: &HistoryFilter) -> rusqlite::Result<Vec<SessionRecord>> {
    let pattern = filter.query.as_deref().map(|q| {
        let escaped = q
            .trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        format!("%{escaped}%")
    });
    let mut sessions: Vec<SessionRecord> = db
        .prepare(
            "SELECT s.id, s.task, s.objectives, s.planned_minutes, s.start_ms, s.end_ms
             FROM sessions s
             WHERE (?1 IS NULL OR s.start_ms >= ?1) AND (?2 IS NULL OR s.start_ms < ?2)
               AND (?3 IS NULL OR s.task LIKE ?3 ESCAPE '\\' OR s.objectives LIKE ?3 ESCAPE '\\' OR EXISTS
                    (SELECT 1 FROM notes WHERE session_id = s.id AND text LIKE ?3 ESCAPE '\\'))
             ORDER BY s.start_ms DESC",
        )?
        .query_map(params![filter.from_ms, filter.to_ms, pattern], |row| {
            Ok(SessionRecord {
                id: row.get(0)?,
                task: row.get(1)?,
                objectives: row.get(2)?,
                planned_minutes: row.get(3)?,
                start_ms: row.get(4)?,
                end_ms: row.get(5)?,
                goals: Vec::new(),
                breaks: Vec::new(),
                messages: Vec::new(),
                notes: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    for session in &mut sessions {
        session.goals = session_goal_refs(db, session.id)?;
        session.breaks = session_breaks(db, session.id)?;
        session.messages = session_messages(db, session.id)?;
        session.notes = session_notes(db, session.id)?;
    }
    Ok(sessions)
}

/// One line per finished session since `since_ms`, for the assistant's context.
pub fn recent_summary(db: &Db, since_ms: i64) -> rusqlite::Result<Vec<String>> {
    db.prepare(
        "SELECT task, start_ms, end_ms - start_ms
                - COALESCE((SELECT SUM(end_ms - start_ms) FROM breaks WHERE session_id = sessions.id), 0)
         FROM sessions WHERE start_ms >= ?1 AND end_ms IS NOT NULL ORDER BY start_ms",
    )?
    .query_map([since_ms], |row| {
        let (task, start_ms, worked_ms): (String, i64, i64) = (row.get(0)?, row.get(1)?, row.get(2)?);
        let start = chrono::DateTime::from_timestamp_millis(start_ms)
            .map(|t| t.with_timezone(&chrono::Local).format("%A %H:%M").to_string())
            .unwrap_or_default();
        Ok(format!("{start}: \"{task}\" for {} minutes", worked_ms / 60_000))
    })?
    .collect()
}

pub fn get_setting(db: &Db, key: &str) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
}

pub fn set_setting(db: &Db, key: &str, value: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

pub fn add_activity(
    db: &Db,
    app: &str,
    title: &str,
    start_ms: i64,
    end_ms: i64,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO activities (app, title, start_ms, end_ms) VALUES (?1, ?2, ?3, ?4)",
        params![app, title, start_ms, end_ms],
    )?;
    Ok(())
}

/// Focus intervals that overlap [from_ms, to_ms), clipped to it, newest first.
pub fn activities(db: &Db, from_ms: i64, to_ms: i64) -> rusqlite::Result<Vec<Activity>> {
    db.prepare(
        "SELECT app, title, MAX(start_ms, ?1), MIN(COALESCE(end_ms, ?2), ?2)
         FROM activities
         WHERE start_ms < ?2 AND COALESCE(end_ms, ?2) > ?1
         ORDER BY start_ms DESC",
    )?
    .query_map(params![from_ms, to_ms], |row| {
        Ok(Activity {
            app: row.get(0)?,
            title: row.get(1)?,
            start_ms: row.get(2)?,
            end_ms: Some(row.get(3)?),
        })
    })?
    .collect()
}

/// Every site with its current allowed flag, for the Blocked tab.
pub fn blocked_site_rows(db: &Db) -> rusqlite::Result<Vec<BlockedSite>> {
    db.prepare("SELECT domain, allowed FROM blocked_sites ORDER BY domain")?
        .query_map([], |row| {
            Ok(BlockedSite {
                domain: row.get(0)?,
                allowed: row.get::<_, i64>(1)? != 0,
            })
        })?
        .collect()
}

/// Only the domains that should actually be blocked now (not temporarily allowed).
pub fn active_block_domains(db: &Db) -> rusqlite::Result<Vec<String>> {
    db.prepare("SELECT domain FROM blocked_sites WHERE allowed = 0 ORDER BY domain")?
        .query_map([], |row| row.get(0))?
        .collect()
}

pub fn add_blocked_site(db: &Db, domain: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO blocked_sites (domain) VALUES (?1)",
        [domain],
    )?;
    Ok(())
}

pub fn remove_blocked_site(db: &Db, domain: &str) -> rusqlite::Result<()> {
    db.execute("DELETE FROM blocked_sites WHERE domain = ?1", [domain])?;
    Ok(())
}

pub fn set_site_allowed(db: &Db, domain: &str, allowed: bool) -> rusqlite::Result<()> {
    db.execute(
        "UPDATE blocked_sites SET allowed = ?2 WHERE domain = ?1",
        params![domain, allowed as i64],
    )?;
    Ok(())
}

/// Blocks everything again (clears all temporary allowances); run at startup.
pub fn reset_allowances(db: &Db) -> rusqlite::Result<()> {
    db.execute("UPDATE blocked_sites SET allowed = 0", [])?;
    Ok(())
}

pub fn add_block_reason(
    db: &Db,
    at_ms: i64,
    session_id: Option<i64>,
    kind: &str,
    domain: Option<&str>,
    reason: &str,
    opinion: Option<&str>,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO block_reasons (at_ms, session_id, kind, domain, reason, opinion)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![at_ms, session_id, kind, domain, reason, opinion],
    )?;
    Ok(())
}

const GOAL_COLUMNS: &str = "id, title, details, due_ms, done, created_ms, done_ms";

fn goal_row(row: &rusqlite::Row) -> rusqlite::Result<Goal> {
    Ok(Goal {
        id: row.get(0)?,
        title: row.get(1)?,
        details: row.get(2)?,
        due_ms: row.get(3)?,
        done: row.get::<_, i64>(4)? != 0,
        created_ms: row.get(5)?,
        done_ms: row.get(6)?,
        worked_ms: 0,
        sessions: 0,
    })
}

/// Active goals first (nearest due date, then newest), then the done ones (most recent first),
/// each with the worked time and count of the finished sessions linked to it.
pub fn goals(db: &Db) -> rusqlite::Result<Vec<Goal>> {
    db.prepare(
        "SELECT g.id, g.title, g.details, g.due_ms, g.done, g.created_ms, g.done_ms,
                COALESCE(SUM(p.worked), 0), COUNT(p.id)
         FROM goals g
         LEFT JOIN (
             SELECT sg.goal_id AS goal_id, s.id AS id,
                    s.end_ms - s.start_ms
                    - COALESCE((SELECT SUM(end_ms - start_ms) FROM breaks WHERE session_id = s.id), 0) AS worked
             FROM session_goals sg JOIN sessions s ON s.id = sg.session_id
             WHERE s.end_ms IS NOT NULL
         ) p ON p.goal_id = g.id
         GROUP BY g.id
         ORDER BY g.done, CASE WHEN g.done = 0 THEN COALESCE(g.due_ms, 1 << 62) END,
                  CASE WHEN g.done = 0 THEN -g.created_ms ELSE -g.done_ms END",
    )?
    .query_map([], |row| {
        Ok(Goal {
            id: row.get(0)?,
            title: row.get(1)?,
            details: row.get(2)?,
            due_ms: row.get(3)?,
            done: row.get::<_, i64>(4)? != 0,
            created_ms: row.get(5)?,
            done_ms: row.get(6)?,
            worked_ms: row.get(7)?,
            sessions: row.get(8)?,
        })
    })?
    .collect()
}

pub fn add_goal(
    db: &Db,
    title: &str,
    details: &str,
    due_ms: Option<i64>,
    now_ms: i64,
) -> rusqlite::Result<Goal> {
    db.execute(
        "INSERT INTO goals (title, details, due_ms, created_ms) VALUES (?1, ?2, ?3, ?4)",
        params![title, details, due_ms, now_ms],
    )?;
    db.query_row(
        &format!("SELECT {GOAL_COLUMNS} FROM goals WHERE id = ?1"),
        [db.last_insert_rowid()],
        goal_row,
    )
}

pub fn update_goal(
    db: &Db,
    id: i64,
    title: &str,
    details: &str,
    due_ms: Option<i64>,
) -> rusqlite::Result<Goal> {
    db.execute(
        "UPDATE goals SET title = ?2, details = ?3, due_ms = ?4 WHERE id = ?1",
        params![id, title, details, due_ms],
    )?;
    db.query_row(
        &format!("SELECT {GOAL_COLUMNS} FROM goals WHERE id = ?1"),
        [id],
        goal_row,
    )
}

pub fn set_goal_done(db: &Db, id: i64, done: bool, now_ms: i64) -> rusqlite::Result<Goal> {
    db.execute(
        "UPDATE goals SET done = ?2, done_ms = ?3 WHERE id = ?1",
        params![id, done as i64, if done { Some(now_ms) } else { None }],
    )?;
    db.query_row(
        &format!("SELECT {GOAL_COLUMNS} FROM goals WHERE id = ?1"),
        [id],
        goal_row,
    )
}

pub fn delete_goal(db: &Db, id: i64) -> rusqlite::Result<()> {
    db.execute("DELETE FROM goals WHERE id = ?1", [id])?;
    Ok(())
}

/// Titles of active goals (with due date when set), for the assistant's context.
pub fn active_goal_lines(db: &Db) -> rusqlite::Result<Vec<String>> {
    db.prepare(
        "SELECT title, due_ms FROM goals WHERE done = 0
         ORDER BY COALESCE(due_ms, 1 << 62), -created_ms",
    )?
    .query_map([], |row| {
        let title: String = row.get(0)?;
        let due: Option<i64> = row.get(1)?;
        Ok(match due {
            Some(ms) => {
                let date = chrono::DateTime::from_timestamp_millis(ms)
                    .map(|t| t.with_timezone(&chrono::Local).format("%-d %b %Y").to_string())
                    .unwrap_or_default();
                format!("{title} (by {date})")
            }
            None => title,
        })
    })?
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_list_is_seeded_and_editable() {
        let db = open(Path::new(":memory:")).unwrap();
        assert_eq!(
            active_block_domains(&db).unwrap().len(),
            crate::blocker::DEFAULT_SITES.len()
        );
        add_blocked_site(&db, "reddit.com").unwrap();
        add_blocked_site(&db, "reddit.com").unwrap(); // idempotent
        assert!(
            active_block_domains(&db)
                .unwrap()
                .contains(&"reddit.com".to_string())
        );
        remove_blocked_site(&db, "youtube.com").unwrap();
        assert!(
            !active_block_domains(&db)
                .unwrap()
                .contains(&"youtube.com".to_string())
        );
    }

    #[test]
    fn notes_belong_to_their_session_and_are_searchable() {
        let db = open(Path::new(":memory:")).unwrap();
        let first = create_session(&db, "Write report", "", None, &[], 1_000).unwrap();
        let second = create_session(&db, "Fix login bug", "", Some(25), &[], 2_000).unwrap();

        let note = add_note(&db, first, "ask Ion about the 100% figure", 1_500).unwrap();
        add_note(&db, second, "token expires too early", 2_500).unwrap();
        let edited =
            update_note(&db, note.id, "ask Ion about the 100% figure, again", 1_800).unwrap();
        assert_eq!((edited.created_ms, edited.updated_ms), (1_500, 1_800));

        let search = |query: &str| {
            let filter = HistoryFilter {
                from_ms: None,
                to_ms: None,
                query: Some(query.into()),
            };
            history(&db, &filter)
                .unwrap()
                .into_iter()
                .map(|r| (r.id, r.notes.len()))
                .collect::<Vec<_>>()
        };
        assert_eq!(search("token"), vec![(second, 1)]);
        assert_eq!(search("100%"), vec![(first, 1)]);
        assert_eq!(search("100_"), vec![]);

        delete_note(&db, note.id).unwrap();
        assert!(session_notes(&db, first).unwrap().is_empty());
        assert_eq!(session_notes(&db, second).unwrap().len(), 1);
    }

    #[test]
    fn title_and_objectives_are_editable_only_while_running() {
        let db = open(Path::new(":memory:")).unwrap();
        let id = create_session(&db, "Report", "draft intro", None, &[], 1_000).unwrap();
        assert!(
            update_session_info(&db, id, "Quarterly report", "draft intro and summary").unwrap()
        );

        end_session(&db, id, 2_000).unwrap();
        assert!(!update_session_info(&db, id, "Changed", "").unwrap());

        let filter = HistoryFilter {
            from_ms: None,
            to_ms: None,
            query: Some("summary".into()),
        };
        let record = history(&db, &filter).unwrap().pop().unwrap();
        assert_eq!(
            (record.task.as_str(), record.objectives.as_str()),
            ("Quarterly report", "draft intro and summary")
        );
    }
}
