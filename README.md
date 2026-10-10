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

Pick a length with − / +, press **Start**, and a countdown runs until the session ends
and a voice announces it (`src-tauri/sounds/session-finished.mp3`, played with `paplay`, generated with
[Piper](https://github.com/OHF-Voice/piper1-gpl) using the `en_GB-jenny_dioco-medium` voice,
`--length-scale 1.1`). During a session, distracting sites are blocked at system level:
`/etc/hosts`, a Chrome/Chromium `URLBlocklist` policy and a Firefox `WebsiteFilter` policy
(Firefox reads it at startup), and existing connections to the sites are cut when the session
starts. The list lives in `BLOCKED_SITES` in `src-tauri/src/lib.rs`.

Blocking needs root, so install the helper once (it only adds/removes the app's own hosts
section and browser policy files, and the sudoers rule lets the app run it without a password):

```sh
sudo sh scripts/install-site-blocker.sh
```

Re-run it after changing `scripts/tm-block-sites`.
