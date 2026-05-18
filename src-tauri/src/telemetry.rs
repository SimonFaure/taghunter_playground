// Rust-side telemetry: just the panic hook.
//
// Why only the panic hook lives in Rust: JS captures its own uncaught errors
// (window.error / unhandledrejection) directly. The remaining gap is Rust
// panics inside Tauri commands or background tasks — those don't surface to
// JS as throwables. We trap them with std::panic::set_hook and persist the
// captured info to a small file under the OS app-data dir. On the next app
// boot, the JS side calls `take_pending_panic`, drains the file (deleting it),
// and enqueues a normal telemetry error event through the outbox.
//
// Writing the file from inside the panic hook keeps us out of any heavier
// machinery (tokio, sql, http) that might re-enter and double-panic. A
// best-effort sync write to a fixed path is the safe move.

use std::fs;
use std::panic;
use std::path::PathBuf;
use std::sync::Once;

use serde::{Deserialize, Serialize};
use tauri::Manager;

const PANIC_FILE_NAME: &str = "pending_panic.json";
static INSTALL: Once = Once::new();

#[derive(Serialize, Deserialize)]
pub struct PendingPanic {
    pub occurred_at: String,
    pub message: String,
    pub location: Option<String>,
    pub thread: Option<String>,
    pub app_version: String,
}

/// Resolve the panic-file path via AppHandle so it always matches what
/// `take_pending_panic` reads back. Must be called from inside Tauri's setup
/// callback (an AppHandle is required). Idempotent: subsequent calls no-op.
pub fn install_panic_hook(app_handle: tauri::AppHandle) {
    INSTALL.call_once(|| {
        let app_version = env!("CARGO_PKG_VERSION").to_string();
        let panic_path: Option<PathBuf> = app_handle
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join(PANIC_FILE_NAME));

        // Drop the AppHandle once we've extracted the path; the hook itself
        // must not hold Tauri state because it can fire from any thread,
        // including during shutdown.
        let prev = panic::take_hook();

        panic::set_hook(Box::new(move |info| {
            let payload_msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "Box<dyn Any>".to_string()
            };

            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
            let thread = std::thread::current().name().map(|s| s.to_string());

            let record = PendingPanic {
                occurred_at: chrono::Utc::now().to_rfc3339(),
                message: payload_msg,
                location,
                thread,
                app_version: app_version.clone(),
            };

            if let Some(path) = panic_path.as_ref() {
                if let Ok(json) = serde_json::to_string(&record) {
                    if let Some(parent) = path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::write(path, json);
                }
            }

            // Chain to the default handler so panics still print to stderr
            // during dev (cargo tauri dev) and respect RUST_BACKTRACE.
            prev(info);
        }));
    });
}

#[tauri::command]
pub fn take_pending_panic(app: tauri::AppHandle) -> Result<Option<PendingPanic>, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(PANIC_FILE_NAME);

    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let record: PendingPanic = serde_json::from_str(&contents).map_err(|e| e.to_string())?;

    // Delete after read so we don't replay the same panic forever. A failure
    // here means the file stays and the next boot retries — acceptable.
    let _ = fs::remove_file(&path);

    Ok(Some(record))
}
