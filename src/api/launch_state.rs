use actix_web::{HttpResponse, get, http::header};
use serde::{Deserialize, Serialize};
use std::{io::ErrorKind, path::PathBuf};

use crate::app::user::AuthenticatedUser;

/// State written atomically by Pawpado's per-game launcher. This is a fixed
/// local file, not a client-selected path: the browser may observe launch
/// progress but cannot read arbitrary files from the Windows host.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchState {
    slug: String,
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_id: Option<String>,
    state: String,
    updated_at: i64,
    pid: Option<u32>,
    message: Option<String>,
}

#[cfg(windows)]
fn process_is_running(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    if pid == 0 {
        return false;
    }

    // SAFETY: OpenProcess returns an owned kernel handle. We request only
    // query access, pass GetExitCodeProcess a valid out pointer, and close the
    // handle on every successful open.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code = 0_u32;
        let queried = GetExitCodeProcess(handle, &mut exit_code) != 0;
        let _ = CloseHandle(handle);
        queried && exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
fn process_is_running(_pid: u32) -> bool {
    // The endpoint is served from Windows in production. Non-Windows builds
    // retain the state for local development; the normalization itself is
    // covered below with an injected process checker.
    true
}

fn normalize_running_state(state: &mut LaunchState, is_running: impl FnOnce(u32) -> bool) {
    if state.state != "running" {
        return;
    }
    let alive = state.pid.is_some_and(is_running);
    if alive {
        return;
    }
    state.state = "failed".into();
    state.message = Some("The game process closed before its window was ready".into());
}

fn launch_state_path() -> PathBuf {
    if let Some(path) = std::env::var_os("PAWPADO_LAUNCH_STATE_PATH") {
        return PathBuf::from(path);
    }

    #[cfg(windows)]
    return PathBuf::from(r"C:\pawpado\game-launch-state.json");

    #[cfg(not(windows))]
    PathBuf::from("/tmp/pawpado-game-launch-state.json")
}

fn valid_state(state: &LaunchState) -> bool {
    !state.slug.is_empty()
        && state
            .slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && matches!(
            state.state.as_str(),
            "preparing" | "starting" | "running" | "exited" | "failed"
        )
}

#[get("/launch-state")]
pub async fn get_launch_state(_user: AuthenticatedUser) -> HttpResponse {
    let contents = match tokio::fs::read(launch_state_path()).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return HttpResponse::NoContent()
                .insert_header((header::CACHE_CONTROL, "no-store"))
                .finish();
        }
        Err(_) => return HttpResponse::ServiceUnavailable().finish(),
    };

    let Ok(mut state) = serde_json::from_slice::<LaunchState>(&contents) else {
        // The launcher writes to a temporary file and renames it, so malformed
        // JSON means corruption rather than a normal partial-write race.
        return HttpResponse::ServiceUnavailable().finish();
    };
    if !valid_state(&state) {
        return HttpResponse::ServiceUnavailable().finish();
    }
    // The launcher can itself be terminated while waiting on a game, leaving
    // a last-written `running` record behind. Never let that stale file reveal
    // the desktop: on Windows, the PID must still describe a live process.
    normalize_running_state(&mut state, process_is_running);

    HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_launcher_owned_slugs_and_states() {
        let mut state = LaunchState {
            slug: "bioshock-infinite".into(),
            title: "BioShock Infinite".into(),
            launch_id: Some("current-launch".into()),
            state: "running".into(),
            updated_at: 1,
            pid: Some(42),
            message: None,
        };
        assert!(valid_state(&state));

        state.slug = "../../secret".into();
        assert!(!valid_state(&state));
        state.slug = "cuphead".into();
        state.state = "unknown".into();
        assert!(!valid_state(&state));
    }

    #[test]
    fn dead_or_missing_running_pid_becomes_a_visible_failure() {
        let mut state = LaunchState {
            slug: "cuphead".into(),
            title: "Cuphead".into(),
            launch_id: None,
            state: "running".into(),
            updated_at: 1,
            pid: Some(42),
            message: Some("Game is running".into()),
        };

        normalize_running_state(&mut state, |_| false);
        assert_eq!(state.state, "failed");
        assert_eq!(
            state.message.as_deref(),
            Some("The game process closed before its window was ready")
        );

        state.state = "running".into();
        state.pid = None;
        normalize_running_state(&mut state, |_| true);
        assert_eq!(state.state, "failed");
    }

    #[test]
    fn live_running_pid_and_non_running_states_are_preserved() {
        let mut state = LaunchState {
            slug: "cuphead".into(),
            title: "Cuphead".into(),
            launch_id: None,
            state: "running".into(),
            updated_at: 1,
            pid: Some(42),
            message: Some("Game window is ready".into()),
        };

        normalize_running_state(&mut state, |pid| pid == 42);
        assert_eq!(state.state, "running");
        assert_eq!(state.message.as_deref(), Some("Game window is ready"));

        state.state = "starting".into();
        state.pid = None;
        normalize_running_state(&mut state, |_| false);
        assert_eq!(state.state, "starting");
    }

    #[test]
    fn launch_identity_survives_the_status_api_roundtrip() {
        let json = serde_json::json!({
            "slug": "bioshock-infinite", "title": "BioShock Infinite",
            "launchId": "second-launch", "state": "exited", "updatedAt": 42,
            "pid": 8744, "message": "Game closed"
        });
        let state: LaunchState = serde_json::from_value(json.clone()).expect("valid launch record");
        assert_eq!(
            serde_json::to_value(state).expect("serializable launch record"),
            json
        );
    }

    #[test]
    fn legacy_launch_records_without_identity_remain_readable() {
        let json = serde_json::json!({
            "slug": "cuphead", "title": "Cuphead", "state": "running",
            "updatedAt": 42, "pid": 1, "message": null
        });
        let state: LaunchState = serde_json::from_value(json.clone()).expect("valid legacy record");
        assert_eq!(
            serde_json::to_value(state).expect("serializable legacy record"),
            json
        );
    }
}
