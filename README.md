# Time Management

A desktop app for time management: to-do lists, work sessions and more.

Built with [Tauri 2](https://tauri.app) (Rust backend) and a vanilla HTML/CSS/JS frontend.

## Development

Prerequisites: Rust, Node.js and the [Tauri system dependencies](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev     # run with hot reload
npm run tauri build   # build a release bundle
```

## Work sessions

The **Session** tab has three columns: today's sessions with total work and break time on the
left, the timer with the current session's work and break time in the middle, and the session's
objectives and notes on the right.

Write the session's title (what you're working on) and, optionally, its objectives, then press
**Start**. While the session runs, the title and objectives can be edited or the objectives
deleted; once it ends they are read-only. A session is either **Open** (it runs until
you press Stop) or a **Timer** (pick a length with − / +). **Break** pauses the work clock; the
assistant calls you back after five minutes, and sites stay blocked during breaks.

During a session, distracting sites are blocked at system level:
`/etc/hosts`, a Chrome/Chromium `URLBlocklist` policy and a Firefox `WebsiteFilter` policy
(Firefox reads it at startup), and existing connections to the sites are cut when the session
starts. The list lives in `BLOCKED_SITES` in `src-tauri/src/blocker.rs`.

Blocking needs root, so install the helper once (it only adds/removes the app's own hosts
section and browser policy files, and the sudoers rule lets the app run it without a password):

```sh
sudo sh scripts/install-site-blocker.sh
```

Re-run it after changing `scripts/tm-block-sites`.

## Assistant

A voice assistant talks to you through the session:

- a greeting when the app opens (at most once every four hours), fitted to the time of day and
  your recent work,
- a good-luck message about the task when a session starts, and a closing remark when it ends,
- every hour of a session, three screenshots of the active window over the last five minutes
  (`spectacle`, scaled down, never written to the history) and a spoken tip, motivation or break
  reminder based on them: a 5 minute break after an hour without one, firmly after two.

The messages are written by Claude through the `claude` CLI (so it uses your Claude
subscription; log in once with `claude`) and spoken by [Piper](https://github.com/OHF-Voice/piper1-gpl)
with the `en_GB-jenny_dioco-medium` voice. Install Piper and the voice once:

```sh
sh scripts/install-voice.sh
```

Set `TM_CHECK_IN_MINUTES=2` to try the check-ins without waiting an hour.

## History

Sessions, breaks and everything the assistant said are stored in SQLite at
`~/.local/share/com.skybytescode.timemanagement/history.db`. The **History** tab lists them with
date and text filters (the search also covers objectives and notes), a timeline of work, breaks
and assistant messages per session, and totals. Its **Calendar** view shows a month: each day's
sessions (hover one for its title), work time and break time.

## Notes and Ask

Every note belongs to one session: write them in the **Session** tab while it runs, and add, edit
or delete them on any session in **History**. The hourly check-ins read the current session's notes.

The **Ask** tab is a chat with Claude about your history: by default it gets all sessions (newest
first, with their notes and what the assistant said), and **Ask Claude** on a session in History
narrows it to that one.

## Start at login

Build and install the app with an app-menu entry and a login autostart entry:

```sh
npx tauri build --no-bundle
sh scripts/install-desktop-entry.sh
```
