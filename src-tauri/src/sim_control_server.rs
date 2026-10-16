// Local control API for the game simulator (tester builds only).
//
// Lets a process on THIS PC - the Claude Desktop MCP server in
// tools/playground-mcp - drive simulation campaigns. An HTTP listener on
// 127.0.0.1 only (never the LAN), independent of the mother/satellite role,
// guarded by a random bearer token written next to the port in
// AppData/simulations/control.json. Each request is handed to the main
// window's JS (event `sim://control`), which answers through
// `sim_control_reply`; all the logic lives in src/simulator/controlApi.ts.
//
// Without the `devtools` feature nothing listens and the reply command errors.

use serde_json::Value;

#[cfg(feature = "devtools")]
mod imp {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::{Json, Router};
    use serde_json::{json, Value};
    use tauri::{AppHandle, Emitter, Manager};
    use tokio::sync::oneshot;

    const PORTS: [u16; 4] = [47890, 47891, 47892, 47893];
    pub const EVT_CONTROL: &str = "sim://control";
    /// Long enough for `wait_next_result` (JS caps its own wait at 60 s).
    const REPLY_TIMEOUT: Duration = Duration::from_secs(90);

    type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

    pub fn pending() -> &'static Pending {
        static P: OnceLock<Pending> = OnceLock::new();
        P.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
    }

    #[derive(Clone)]
    struct Ctx {
        app: AppHandle,
        token: String,
        next_id: Arc<AtomicU64>,
    }

    pub fn start(app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            if let Err(e) = serve(app).await {
                eprintln!("[sim_control] not started: {e}");
            }
        });
    }

    async fn serve(app: AppHandle) -> Result<(), String> {
        let mut bound = None;
        for port in PORTS {
            if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                bound = Some((l, port));
                break;
            }
        }
        let (listener, port) = bound.ok_or("ports 47890-47893 are all taken")?;
        let token: String = {
            use rand::Rng;
            let mut rng = rand::thread_rng();
            (0..32).map(|_| format!("{:x}", rng.gen_range(0..16u8))).collect()
        };
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("simulations");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let info = json!({ "port": port, "token": token, "pid": std::process::id() });
        std::fs::write(dir.join("control.json"), info.to_string()).map_err(|e| e.to_string())?;

        let ctx = Ctx { app, token, next_id: Arc::new(AtomicU64::new(1)) };
        let router = Router::new().route("/control", post(control)).with_state(ctx);
        axum::serve(listener, router).await.map_err(|e| e.to_string())
    }

    async fn control(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
        let auth = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if auth != format!("Bearer {}", ctx.token) {
            return (StatusCode::UNAUTHORIZED, Json(json!({ "ok": false, "error": "bad token" })));
        }
        let cmd = body.get("cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if cmd.is_empty() {
            return (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": "missing cmd" })));
        }
        let args = body.get("args").cloned().unwrap_or(json!({}));
        let id = ctx.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        pending().lock().unwrap().insert(id, tx);
        let payload = json!({ "reqId": id, "cmd": cmd, "args": args });
        if let Err(e) = ctx.app.emit_to("main", EVT_CONTROL, payload) {
            pending().lock().unwrap().remove(&id);
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false, "error": e.to_string() })));
        }
        match tokio::time::timeout(REPLY_TIMEOUT, rx).await {
            Ok(Ok(v)) => (StatusCode::OK, Json(v)),
            _ => {
                pending().lock().unwrap().remove(&id);
                (
                    StatusCode::GATEWAY_TIMEOUT,
                    Json(json!({ "ok": false, "error": "the app did not answer (is the main window open and logged in?)" })),
                )
            }
        }
    }
}

/// Start the local control listener (tester builds; no-op otherwise).
pub fn start(app: tauri::AppHandle) {
    #[cfg(feature = "devtools")]
    imp::start(app);
    #[cfg(not(feature = "devtools"))]
    let _ = app;
}

/// The main window's answer to one control request.
#[tauri::command]
pub fn sim_control_reply(req_id: u64, result: Value) -> Result<(), String> {
    #[cfg(feature = "devtools")]
    {
        match imp::pending().lock().unwrap().remove(&req_id) {
            Some(tx) => {
                let _ = tx.send(result);
                Ok(())
            }
            None => Err("unknown or expired request".into()),
        }
    }
    #[cfg(not(feature = "devtools"))]
    {
        let _ = (req_id, result);
        Err("simulator unavailable in this build".into())
    }
}
