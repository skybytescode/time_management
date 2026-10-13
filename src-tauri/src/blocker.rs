use std::fs;
use std::path::Path;
use std::process::Command;

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

fn run_blocker(args: &[String]) -> Result<(), String> {
    if !Path::new(BLOCKER).exists() {
        return Err(
            "site blocker not installed, run `sudo sh scripts/install-site-blocker.sh` once".into(),
        );
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

pub fn block_sites() -> Result<(), String> {
    let mut args = vec!["block".to_string()];
    for site in BLOCKED_SITES {
        for prefix in ["", "www.", "m."] {
            args.push(format!("{prefix}{site}"));
        }
    }
    run_blocker(&args)
}

/// Removes our section from /etc/hosts, skipping the sudo call when it isn't there.
pub fn unblock_sites() -> Result<(), String> {
    let blocked = fs::read_to_string("/etc/hosts").is_ok_and(|hosts| hosts.contains(HOSTS_MARKER));
    if blocked {
        run_blocker(&["unblock".to_string()])
    } else {
        Ok(())
    }
}
