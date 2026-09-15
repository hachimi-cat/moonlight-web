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
    state: String,
    updated_at: i64,
    pid: Option<u32>,
    message: Option<String>,
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

    let Ok(state) = serde_json::from_slice::<LaunchState>(&contents) else {
        // The launcher writes to a temporary file and renames it, so malformed
        // JSON means corruption rather than a normal partial-write race.
        return HttpResponse::ServiceUnavailable().finish();
    };
    if !valid_state(&state) {
        return HttpResponse::ServiceUnavailable().finish();
    }

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
}
