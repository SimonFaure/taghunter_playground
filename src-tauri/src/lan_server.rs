// Mother-side LAN HTTP server.
//
// Slices A + B: same wire shape as `studio-taghunter/backend/api/
// launched_games.php` (17 actions) plus a `/pair.php` surface for first-meet
// device pairing. Backed by the local SQLite at `<app_data_dir>/playground.db`.
//
// Auth model (slice B): the bearer token is a per-peer secret stored in the
// `paired_devices` table. The mother itself has a self-entry with `is_self=1`
// auto-created on `mother_start_local_server`. The row id of `paired_devices`
// doubles as the device_id used in `lg_launched_game_devices` and
// `lg_launched_game_raw_data`.
//
// mDNS: the mother registers a `_taghunter._tcp.local.` instance on start so
// clients can browse for it on the same Wi-Fi without typing IPs. Hotspot
// creation is slices C + D.
//
// The server runs in the existing tokio runtime spawned by Tauri. State is
// held in a `MotherServerState` resource managed at app build time.
//
// Endpoints expose `/launched_games.php?action=…` and `/pair.php?action=…` so
// the renderer's `services/launchedGames.ts` only needs a base-URL swap; the
// pair surface gets its own thin client (`services/pairing.ts` on the JS
// side).

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use rand::Rng;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tokio_rusqlite::Connection as DbConnection;

// ─── public state ────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct MotherServerState {
    inner: Mutex<Option<Running>>,
}

// Client-side: mother_uuid → SocketAddr resolved via mDNS. Populated at app
// launch by client_refresh_mother_endpoints() and refreshed on ping failure.
// Lookups are O(1) and held briefly so a synchronous std mutex would be fine,
// but we reuse tokio::sync::Mutex to stay consistent with the rest of this
// module and avoid blocking-in-async lint surprises.
#[derive(Default)]
pub struct MotherEndpointCache {
    inner: Mutex<HashMap<String, SocketAddr>>,
}

/// Client-side: the satellite's current SportIdent reader-attached state.
/// Updated by JS (`Footer.tsx`'s 10s polling tick → `client_set_reader_presence`)
/// and read by `client_ping_mother` so the mother sees a fresh `has_reader`
/// in the next ping body. We don't model "which reader" — the modal just
/// needs the boolean for the row badge.
#[derive(Default)]
pub struct ReaderPresence {
    inner: Mutex<bool>,
}

struct Running {
    port: u16,
    shutdown: oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
    mdns: Option<MdnsHandle>,
}

struct MdnsHandle {
    daemon: ServiceDaemon,
    full_name: String,
}

#[derive(Serialize)]
pub struct MotherServerInfo {
    pub port: u16,
    pub bound_addr: String,
    /// Stable UUID for this mother device, persisted in `schema_meta`. Survives
    /// app restarts and is the identity exposed via mDNS TXT records.
    pub mother_device_uuid: String,
    /// Bearer token the mother's *own* renderer uses against its loopback
    /// server. Per-peer secrets for other devices are issued via pairing.
    pub mother_peer_secret: String,
    /// `paired_devices.id` for the mother's self-entry. Used as device_id when
    /// the mother records its own punches.
    pub mother_peer_id: i64,
}

#[derive(Serialize)]
pub struct MotherServerStatus {
    pub running: bool,
    pub port: Option<u16>,
}

// ─── tauri commands: mother lifecycle ────────────────────────────────────────

#[tauri::command]
pub async fn mother_start_local_server(
    app: AppHandle,
    state: tauri::State<'_, MotherServerState>,
    client_id: i64,
    port: u16,
    mdns_label: Option<String>,
) -> Result<MotherServerInfo, String> {
    let mut guard = state.inner.lock().await;
    if guard.is_some() {
        return Err("Mother server is already running".into());
    }

    let db_path = resolve_db_path(&app)?;
    let conn = DbConnection::open(db_path.clone())
        .await
        .map_err(|e| format!("open sqlite ({}): {e}", db_path.display()))?;
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        c.pragma_update(None, "foreign_keys", "ON")?;
        let _: String = c.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        // Two SQLite pools share this file: this tokio_rusqlite handle and the
        // tauri-plugin-sql pool used from JS (telemetry, useGameStatePolling,
        // loadTeams, etc.). Without a busy_timeout, any concurrent writer
        // races immediately into SQLITE_BUSY. 5s of patient retry is enough
        // to ride out the typical contention spikes during game start.
        c.pragma_update(None, "busy_timeout", 5000)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("pragma setup: {e}"))?;

    // Bootstrap the mother's self-entry in paired_devices on first start.
    let self_pair = ensure_self_pair(&conn).await.map_err(|e| e.to_string())?;

    let app_state = AppState {
        db: Arc::new(conn),
        client_id,
        mother_uuid: self_pair.mother_device_uuid.clone(),
        self_peer_id: self_pair.peer_id,
        last_bump: Arc::new(Mutex::new(HashMap::new())),
    };

    let app_router = build_router(app_state);
    let bind_addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| format!("bind {bind_addr}: {e}"))?;
    let actual = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;
    let actual_port = actual.port();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app_router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    // Register mDNS broadcast (best-effort: failure shouldn't kill the server).
    let mdns = match start_mdns(&self_pair.mother_device_uuid, mdns_label.as_deref(), actual_port) {
        Ok(h) => Some(h),
        Err(e) => {
            eprintln!("[lan_server] mDNS start failed: {e} (continuing without)");
            None
        }
    };

    *guard = Some(Running {
        port: actual_port,
        shutdown: shutdown_tx,
        join,
        mdns,
    });

    Ok(MotherServerInfo {
        port: actual_port,
        bound_addr: actual.to_string(),
        mother_device_uuid: self_pair.mother_device_uuid,
        mother_peer_secret: self_pair.peer_secret,
        mother_peer_id: self_pair.peer_id,
    })
}

#[tauri::command]
pub async fn mother_stop_local_server(
    state: tauri::State<'_, MotherServerState>,
) -> Result<(), String> {
    let running = {
        let mut guard = state.inner.lock().await;
        guard.take()
    };
    let Some(running) = running else { return Ok(()) };
    if let Some(m) = running.mdns {
        let _ = m.daemon.unregister(&m.full_name);
        let _ = m.daemon.shutdown();
    }
    let _ = running.shutdown.send(());
    let _ = running.join.await;
    Ok(())
}

#[tauri::command]
pub async fn mother_server_status(
    state: tauri::State<'_, MotherServerState>,
) -> Result<MotherServerStatus, String> {
    let guard = state.inner.lock().await;
    Ok(match &*guard {
        Some(r) => MotherServerStatus {
            running: true,
            port: Some(r.port),
        },
        None => MotherServerStatus {
            running: false,
            port: None,
        },
    })
}

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("playground.db"))
}

// ─── self-pair bootstrap ─────────────────────────────────────────────────────

struct SelfPair {
    mother_device_uuid: String,
    peer_secret: String,
    peer_id: i64,
}

async fn ensure_self_pair(conn: &DbConnection) -> tokio_rusqlite::Result<SelfPair> {
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<SelfPair> {
        // Read or initialize mother_device_uuid in schema_meta.
        let mother_uuid: String = match c
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'mother_device_uuid'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            Some(s) => s,
            None => {
                let new = uuid::Uuid::new_v4().to_string();
                c.execute(
                    "INSERT INTO schema_meta(key, value) VALUES ('mother_device_uuid', ?)",
                    params![new],
                )?;
                new
            }
        };

        // Find or create the self paired_devices entry.
        let existing: Option<(i64, String)> = c
            .query_row(
                "SELECT id, peer_secret FROM paired_devices
                 WHERE peer_uuid = ? AND is_self = 1",
                params![mother_uuid],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;

        let (peer_id, peer_secret) = match existing {
            Some(t) => t,
            None => {
                let secret = random_token(32);
                c.execute(
                    "INSERT INTO paired_devices
                       (peer_uuid, peer_label, peer_os, peer_app_version, peer_secret, is_self)
                     VALUES (?, '__mother_self__', NULL, NULL, ?, 1)",
                    params![mother_uuid, secret],
                )?;
                (c.last_insert_rowid(), secret)
            }
        };

        Ok(SelfPair {
            mother_device_uuid: mother_uuid,
            peer_secret,
            peer_id,
        })
    })
    .await
}

fn random_token(bytes: usize) -> String {
    let mut rng = rand::thread_rng();
    let buf: Vec<u8> = (0..bytes).map(|_| rng.gen::<u8>()).collect();
    // Use simple hex; URL-safe and fixed-length, no extra crate.
    let mut out = String::with_capacity(bytes * 2);
    for b in buf {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

// ─── axum wiring ─────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    db: Arc<DbConnection>,
    client_id: i64,
    /// Stable identity of this mother device. Returned by /ping.php so the
    /// child can verify it's still talking to the same machine it paired with.
    mother_uuid: String,
    /// `paired_devices.id` of the mother's own self-row. Cached here so the
    /// authorization check on queue_command (only self may push commands) is
    /// a single integer comparison instead of a SQL roundtrip per call.
    self_peer_id: i64,
    /// Debounce map for `bump_presence` — peer_id → last write Instant. The
    /// 5s window keeps the row from churning under the satellite's 1s state
    /// polling, while the 25s online window in `list_paired_with_status`
    /// still reads a fresh enough timestamp.
    last_bump: Arc<Mutex<HashMap<i64, Instant>>>,
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/launched_games.php", any(dispatch_launched_games))
        .route("/pair.php", any(dispatch_pair))
        .route("/ping.php", any(dispatch_ping))
        .with_state(state)
}

#[derive(Deserialize)]
struct ActionQuery {
    action: Option<String>,
    #[serde(flatten)]
    rest: HashMap<String, String>,
}

// ─── auth ────────────────────────────────────────────────────────────────────

async fn resolve_peer(state: &AppState, headers: &HeaderMap) -> Result<i64, Response> {
    let id = resolve_peer_for_ping(state, headers).await?;
    bump_presence(state, id, None).await;
    Ok(id)
}

/// Same lookup as `resolve_peer` but does NOT touch last_seen_at. Used by the
/// /ping.php handler so we can wrap the bump in `bump_presence` once we've
/// also parsed the body (and folded `has_reader` into the same UPDATE).
async fn resolve_peer_for_ping(state: &AppState, headers: &HeaderMap) -> Result<i64, Response> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string());
    let Some(token) = token else {
        return Err(error(StatusCode::UNAUTHORIZED, "Missing bearer"));
    };
    let peer_id: Option<i64> = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
            Ok(c.query_row(
                "SELECT id FROM paired_devices WHERE peer_secret = ?",
                params![token],
                |r| r.get(0),
            )
            .optional()?)
        })
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    peer_id.ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Unauthorized"))
}

/// Best-effort presence bump, debounced to once per 5s per peer. Folds in
/// `has_reader` when the satellite reports it, so the reader badge in the
/// devices modal stays within ~10s of the truth (the satellite pings at 10s
/// cadence). Failures are swallowed — presence is observability, not the
/// critical path.
async fn bump_presence(state: &AppState, peer_id: i64, has_reader: Option<bool>) {
    {
        let mut guard = state.last_bump.lock().await;
        let now = Instant::now();
        // If we don't have reader news AND we bumped recently, skip the write.
        // A reader-status report always writes through so plug/unplug surfaces
        // promptly even if the last bump was <5s ago.
        if has_reader.is_none() {
            if let Some(prev) = guard.get(&peer_id) {
                if now.duration_since(*prev) < Duration::from_secs(5) {
                    return;
                }
            }
        }
        guard.insert(peer_id, now);
    }

    let db = state.db.clone();
    let has_reader_i64: Option<i64> = has_reader.map(|b| if b { 1 } else { 0 });
    tokio::spawn(async move {
        let _ = db
            .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                c.execute(
                    "UPDATE paired_devices
                        SET last_seen_at = CURRENT_TIMESTAMP,
                            has_reader = COALESCE(?1, has_reader),
                            reader_last_seen_at = CASE
                                WHEN ?1 = 1 THEN CURRENT_TIMESTAMP
                                ELSE reader_last_seen_at
                            END
                      WHERE id = ?2",
                    params![has_reader_i64, peer_id],
                )?;
                Ok(())
            })
            .await;
    });
}

/// Drain (with delivery-stamp side-effect) the open commands queued for this
/// peer, opportunistically pruning long-dead rows on the way in. Returns the
/// payloads ready to be embedded in the /ping.php response; the satellite is
/// expected to POST `ack_command` once it has acted on each.
///
/// TTLs: undelivered rows > 15min are dropped (the operator can re-issue);
/// acked rows > 1h are dropped (kept briefly for at-least-once audit).
async fn pickup_pending_commands(state: &AppState, peer_id: i64) -> Vec<Value> {
    let result = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(i64, String, String)>> {
            // Prune first so the SELECT doesn't surface stale work.
            c.execute(
                "DELETE FROM pending_commands
                  WHERE (acked_at IS NOT NULL AND acked_at < datetime('now','-1 hour'))
                     OR (acked_at IS NULL    AND created_at < datetime('now','-15 minutes'))",
                [],
            )?;

            let mut stmt = c.prepare(
                "SELECT id, kind, payload_json
                   FROM pending_commands
                  WHERE target_device_id = ?
                    AND acked_at IS NULL
                  ORDER BY id ASC
                  LIMIT 32",
            )?;
            let rows: Vec<(i64, String, String)> = stmt
                .query_map(params![peer_id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            if !rows.is_empty() {
                let placeholders = vec!["?"; rows.len()].join(",");
                let sql = format!(
                    "UPDATE pending_commands
                        SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP)
                      WHERE id IN ({placeholders})"
                );
                let ids: Vec<i64> = rows.iter().map(|(id, _, _)| *id).collect();
                c.execute(&sql, params_from_iter(ids.iter()))?;
            }

            Ok(rows)
        })
        .await;

    match result {
        Ok(rows) => rows
            .into_iter()
            .map(|(id, kind, payload_json)| {
                let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
                json!({ "id": id, "kind": kind, "payload": payload })
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

// ─── dispatchers ─────────────────────────────────────────────────────────────

async fn dispatch_launched_games(
    State(state): State<AppState>,
    Query(q): Query<ActionQuery>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    let peer_id = match resolve_peer(&state, &headers).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };

    let action = q.action.as_deref().unwrap_or("");
    let method = request.method().clone();
    let body_bytes = match axum::body::to_bytes(request.into_body(), 8 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => return error(StatusCode::BAD_REQUEST, format!("read body: {e}")),
    };
    let body: Value = if body_bytes.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&body_bytes) {
            Ok(v) => v,
            Err(e) => return error(StatusCode::BAD_REQUEST, format!("invalid JSON: {e}")),
        }
    };

    let result: Result<Value, ApiErr> = match (method.as_str(), action) {
        ("POST", "create") => create(&state, peer_id, body).await,
        ("GET", "list") => list(&state, &q.rest).await,
        ("GET", "list_active") => list_active(&state).await,
        ("GET", "get_meta") => get_meta(&state, &q.rest).await,
        ("POST", "update_meta") => update_meta(&state, body).await,
        ("GET", "state") => state_action(&state, &q.rest).await,
        ("GET", "raw_data_for_chip") => raw_data_for_chip(&state, &q.rest).await,
        ("POST", "record_punch") => record_punch(&state, peer_id, body).await,
        ("POST", "update_team") => update_team(&state, body).await,
        ("POST", "add_team") => add_team(&state, body).await,
        ("POST", "end_team") => end_team(&state, body).await,
        ("POST", "end_game") => end_game(&state, body).await,
        ("POST", "delete_game") => delete_game(&state, body).await,
        ("POST", "register_device") => register_device(&state, peer_id, body).await,
        ("GET", "get_devices") => get_devices(&state, &q.rest).await,
        ("GET", "list_paired_with_status") => list_paired_with_status(&state, &q.rest).await,
        ("GET", "list_paired_for_launch") => list_paired_for_launch(&state).await,
        ("POST", "queue_command") => queue_command(&state, peer_id, body).await,
        ("POST", "queue_command_bulk") => queue_command_bulk(&state, peer_id, body).await,
        ("POST", "ack_command") => ack_command(&state, peer_id, body).await,
        ("GET", "list_completed_quests") => list_completed_quests(&state, &q.rest).await,
        ("POST", "record_completed_quest") => record_completed_quest(&state, body).await,
        ("", _) | (_, "") => Err(ApiErr::bad("action is required")),
        _ => Err(ApiErr::status(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        )),
    };

    match result {
        Ok(v) => json_ok(v),
        Err(e) => e.into_response(),
    }
}

async fn dispatch_pair(
    State(state): State<AppState>,
    Query(q): Query<ActionQuery>,
    request: Request<Body>,
) -> Response {
    // Pair endpoints are intentionally unauthenticated: they're how a fresh
    // peer establishes itself. Approval on the mother's UI is the trust gate.
    let action = q.action.as_deref().unwrap_or("");
    let method = request.method().clone();
    let body_bytes = match axum::body::to_bytes(request.into_body(), 64 * 1024).await {
        Ok(b) => b,
        Err(e) => return error(StatusCode::BAD_REQUEST, format!("read body: {e}")),
    };
    let body: Value = if body_bytes.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&body_bytes) {
            Ok(v) => v,
            Err(e) => return error(StatusCode::BAD_REQUEST, format!("invalid JSON: {e}")),
        }
    };

    let result: Result<Value, ApiErr> = match (method.as_str(), action) {
        ("POST", "request") => pair_request_handler(&state, body).await,
        ("GET", "status") => pair_status_handler(&state, &q.rest).await,
        ("", _) | (_, "") => Err(ApiErr::bad("action is required")),
        _ => Err(ApiErr::status(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        )),
    };
    match result {
        Ok(v) => json_ok(v),
        Err(e) => e.into_response(),
    }
}

// Lightweight health/identity + push channel polled by the child's footer
// every 10s. Authenticated with the peer's bearer secret so an unrecognized
// device gets 401 (drives the child's RED state) instead of a misleading OK.
//
// Accepts both GET (legacy clients) and POST. POST body is optional and may
// carry `{ has_reader: bool }` so the satellite reports whether a SportIdent
// dongle is currently attached. The response always includes `mother_uuid`;
// any pending join_game/play_video/stop_video commands queued for this peer
// are returned in `commands: [...]` and the satellite is expected to POST
// `ack_command` per id once it has acted.
async fn dispatch_ping(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    let peer_id = match resolve_peer_for_ping(&state, &headers).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };

    let body_bytes = axum::body::to_bytes(request.into_body(), 8 * 1024)
        .await
        .unwrap_or_default();
    let body: Value = if body_bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body_bytes).unwrap_or(Value::Null)
    };
    let has_reader = body.get("has_reader").and_then(|v| v.as_bool());

    bump_presence(&state, peer_id, has_reader).await;
    let commands = pickup_pending_commands(&state, peer_id).await;

    json_ok(json!({
        "mother_uuid": state.mother_uuid,
        "commands": commands,
    }))
}

#[allow(dead_code)]
async fn verify_peer_secret(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string());
    let Some(token) = token else {
        return Err(error(StatusCode::UNAUTHORIZED, "Missing bearer"));
    };
    let exists: bool = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
            Ok(c.query_row(
                "SELECT 1 FROM paired_devices WHERE peer_secret = ?",
                params![token],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false))
        })
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if exists {
        Ok(())
    } else {
        Err(error(StatusCode::UNAUTHORIZED, "Unauthorized"))
    }
}

// ─── error type ──────────────────────────────────────────────────────────────

struct ApiErr {
    status: StatusCode,
    message: String,
}

impl ApiErr {
    fn status(s: StatusCode, m: impl Into<String>) -> Self {
        Self {
            status: s,
            message: m.into(),
        }
    }
    fn bad(m: impl Into<String>) -> Self {
        Self::status(StatusCode::BAD_REQUEST, m)
    }
    fn not_found(m: impl Into<String>) -> Self {
        Self::status(StatusCode::NOT_FOUND, m)
    }
    fn into_response(self) -> Response {
        error(self.status, self.message)
    }
}

impl From<tokio_rusqlite::Error> for ApiErr {
    fn from(e: tokio_rusqlite::Error) -> Self {
        Self::status(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

impl From<rusqlite::Error> for ApiErr {
    fn from(e: rusqlite::Error) -> Self {
        Self::status(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn json_ok(v: Value) -> Response {
    (StatusCode::OK, Json(v)).into_response()
}

// ─── helpers ─────────────────────────────────────────────────────────────────

fn parse_i64(rest: &HashMap<String, String>, key: &str) -> Result<i64, ApiErr> {
    rest.get(key)
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| ApiErr::bad(format!("{key} is required")))
}

fn parse_i64_opt(rest: &HashMap<String, String>, key: &str) -> Option<i64> {
    rest.get(key).and_then(|v| v.parse::<i64>().ok())
}

fn json_i64(v: &Value, key: &str) -> Result<i64, ApiErr> {
    v.get(key)
        .and_then(|x| x.as_i64())
        .ok_or_else(|| ApiErr::bad(format!("{key} is required")))
}

fn json_str<'a>(v: &'a Value, key: &str) -> Result<&'a str, ApiErr> {
    v.get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| ApiErr::bad(format!("{key} is required")))
}

async fn require_game_owned(
    state: &AppState,
    launched_game_id: i64,
) -> Result<i64, ApiErr> {
    let client_id = state.client_id;
    let exists: Option<i64> = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
            Ok(c.query_row(
                "SELECT id FROM lg_launched_games WHERE id = ? AND client_id = ?",
                params![launched_game_id, client_id],
                |r| r.get(0),
            )
            .optional()?)
        })
        .await?;
    exists.ok_or_else(|| ApiErr::not_found("Launched game not found"))
}

async fn require_team_owned(state: &AppState, team_id: i64) -> Result<(), ApiErr> {
    let client_id = state.client_id;
    let row: Option<i64> = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
            Ok(c.query_row(
                "SELECT t.id FROM lg_teams t
                 INNER JOIN lg_launched_games lg ON lg.id = t.launched_game_id
                 WHERE t.id = ? AND lg.client_id = ?",
                params![team_id, client_id],
                |r| r.get(0),
            )
            .optional()?)
        })
        .await?;
    row.map(|_| ()).ok_or_else(|| ApiErr::not_found("Team not found"))
}

// ─── action handlers: launched_games ─────────────────────────────────────────

async fn create(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
    let game_uniqid = json_str(&body, "game_uniqid")?.to_string();
    let name = json_str(&body, "name")?.to_string();
    let game_type = json_str(&body, "game_type")?.to_string();
    let number_of_teams = json_i64(&body, "number_of_teams")?;
    let duration = body.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
    let started = body
        .get("started")
        .map(|v| v.as_bool().unwrap_or(false) || v.as_i64() == Some(1))
        .unwrap_or(false);

    if number_of_teams <= 0 {
        return Err(ApiErr::bad(
            "game_uniqid, name, game_type, number_of_teams are required",
        ));
    }

    let meta_pairs: Vec<(String, Option<String>)> = body
        .get("meta")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    let s = match v {
                        Value::Null => None,
                        Value::String(s) => Some(s.clone()),
                        other => Some(other.to_string()),
                    };
                    (k.clone(), s)
                })
                .collect()
        })
        .unwrap_or_default();

    let teams: Vec<TeamInput> = body
        .get("teams")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(TeamInput::from_value).collect())
        .unwrap_or_default();

    // Idempotency: if the client supplied an idempotency_key, reuse it as the
    // summary_uuid (which already has a UNIQUE constraint). A retried request
    // with the same key returns the row from the first successful attempt
    // instead of inserting again. Legacy callers without a key fall back to a
    // server-generated UUID.
    let client_key = body
        .get("idempotency_key")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let summary_uuid = client_key
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let client_id = state.client_id;
    // `include_self` lets the launch-wizard skip the mother as a participating
    // device — e.g. for a server-only mother that runs the game without
    // having a screen scanning cards. Default true keeps legacy behaviour.
    let include_self = body
        .get("include_self")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let start_time = if started {
        Some(chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string())
    } else {
        None
    };

    let result = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(i64, Option<i64>, bool)> {
            // Pre-check: idempotent replay short-circuit.
            if client_key.is_some() {
                let existing: Option<i64> = c
                    .query_row(
                        "SELECT id FROM lg_launched_games
                         WHERE client_id = ? AND summary_uuid = ?",
                        params![client_id, summary_uuid],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?;
                if let Some(existing_id) = existing {
                    let device_row_id = upsert_device_registration(c, existing_id, peer_id)?;
                    return Ok((existing_id, device_row_id, true));
                }
            }

            let tx = c.transaction()?;
            let insert_res = tx.execute(
                "INSERT INTO lg_launched_games
                   (summary_uuid, client_id, game_uniqid, name, number_of_teams,
                    game_type, duration, start_time, started, ended)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
                params![
                    summary_uuid,
                    client_id,
                    game_uniqid,
                    name,
                    number_of_teams,
                    game_type,
                    duration,
                    start_time,
                    if started { 1 } else { 0 },
                ],
            );

            // Race fallback: a concurrent retry won the unique(summary_uuid)
            // insert between our pre-check and this INSERT. Roll back this
            // attempt and look up the winning row.
            if let Err(ref e) = insert_res {
                if is_unique_violation(e) && client_key.is_some() {
                    drop(tx);
                    let existing_id: i64 = c.query_row(
                        "SELECT id FROM lg_launched_games
                         WHERE client_id = ? AND summary_uuid = ?",
                        params![client_id, summary_uuid],
                        |r| r.get::<_, i64>(0),
                    )?;
                    let device_row_id = upsert_device_registration(c, existing_id, peer_id)?;
                    return Ok((existing_id, device_row_id, true));
                }
            }
            insert_res?;
            let launched_game_id = tx.last_insert_rowid();

            for (k, v) in &meta_pairs {
                tx.execute(
                    "INSERT INTO lg_launched_game_meta
                       (launched_game_id, meta_name, meta_value) VALUES (?, ?, ?)",
                    params![launched_game_id, k, v],
                )?;
            }

            for t in &teams {
                tx.execute(
                    "INSERT INTO lg_teams
                       (launched_game_id, team_number, team_name, pattern, score, key_id)
                     VALUES (?, ?, ?, ?, 0, ?)",
                    params![
                        launched_game_id,
                        t.team_number,
                        t.team_name,
                        t.pattern,
                        t.key_id,
                    ],
                )?;
            }

            // Register the creating peer (the launching mother in slice B's
            // single-device case) into launched_game_devices. Skipped when the
            // operator explicitly unchecked the mother on the launch wizard's
            // device step — in that mode the mother just hosts the server.
            let device_row_id = if include_self {
                tx.execute(
                    "INSERT INTO lg_launched_game_devices
                       (launched_game_id, device_id, connected) VALUES (?, ?, 1)",
                    params![launched_game_id, peer_id],
                )?;
                Some(tx.last_insert_rowid())
            } else {
                None
            };

            tx.commit()?;
            Ok((launched_game_id, device_row_id, false))
        })
        .await?;

    let mut out = json!({
        "id": result.0,
        "device_row_id": result.1,
    });
    if result.2 {
        out["idempotent_replay"] = Value::Bool(true);
    }
    Ok(out)
}

// Upsert the calling peer's row in lg_launched_game_devices and return its id.
// Used by the idempotent-replay branch of `create` so the response shape stays
// the same (caller expects a `device_row_id`).
fn upsert_device_registration(
    c: &mut rusqlite::Connection,
    launched_game_id: i64,
    peer_id: i64,
) -> rusqlite::Result<Option<i64>> {
    c.execute(
        "INSERT INTO lg_launched_game_devices (launched_game_id, device_id, connected)
         VALUES (?, ?, 1)
         ON CONFLICT(launched_game_id, device_id) DO UPDATE SET
             connected = 1,
             last_connection_attempt = CURRENT_TIMESTAMP",
        params![launched_game_id, peer_id],
    )?;
    c.query_row(
        "SELECT id FROM lg_launched_game_devices
         WHERE launched_game_id = ? AND device_id = ?",
        params![launched_game_id, peer_id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
}

fn is_unique_violation(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(e, _)
            if e.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

struct TeamInput {
    team_number: i64,
    team_name: Option<String>,
    pattern: i64,
    key_id: Option<i64>,
}

impl TeamInput {
    fn from_value(v: &Value) -> Option<Self> {
        let team_number = v.get("team_number").and_then(|x| x.as_i64()).unwrap_or(0);
        if team_number <= 0 {
            return None;
        }
        let team_name = v
            .get("team_name")
            .and_then(|x| if x.is_null() { None } else { x.as_str() })
            .map(|s| s.to_string());
        let pattern = v.get("pattern").and_then(|x| x.as_i64()).unwrap_or(0);
        let key_id = v
            .get("key_id")
            .and_then(|x| if x.is_null() { None } else { x.as_i64() });
        Some(TeamInput {
            team_number,
            team_name,
            pattern,
            key_id,
        })
    }
}

async fn list(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    let ended_filter = rest.get("ended").cloned();
    let games = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let (sql, args): (&str, Vec<SqlValue>) = match ended_filter.as_deref() {
                Some("0") => (
                    "SELECT id, game_uniqid, name, number_of_teams, game_type, duration,
                            start_time, started, ended, created_at, updated_at
                     FROM lg_launched_games
                     WHERE client_id = ? AND ended = 0
                     ORDER BY created_at DESC",
                    vec![SqlValue::Integer(client_id)],
                ),
                Some("1") => (
                    "SELECT id, game_uniqid, name, number_of_teams, game_type, duration,
                            start_time, started, ended, created_at, updated_at
                     FROM lg_launched_games
                     WHERE client_id = ? AND ended = 1
                     ORDER BY created_at DESC",
                    vec![SqlValue::Integer(client_id)],
                ),
                _ => (
                    "SELECT id, game_uniqid, name, number_of_teams, game_type, duration,
                            start_time, started, ended, created_at, updated_at
                     FROM lg_launched_games
                     WHERE client_id = ?
                     ORDER BY created_at DESC",
                    vec![SqlValue::Integer(client_id)],
                ),
            };
            let mut stmt = c.prepare(sql)?;
            let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "game_uniqid": r.get::<_, String>(1)?,
                    "name": r.get::<_, String>(2)?,
                    "number_of_teams": r.get::<_, i64>(3)?,
                    "game_type": r.get::<_, String>(4)?,
                    "duration": r.get::<_, i64>(5)?,
                    "start_time": r.get::<_, Option<String>>(6)?,
                    "started": r.get::<_, i64>(7)?,
                    "ended": r.get::<_, i64>(8)?,
                    "created_at": r.get::<_, String>(9)?,
                    "updated_at": r.get::<_, String>(10)?,
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "games": games }))
}

async fn list_active(state: &AppState) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    let games = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let mut stmt = c.prepare(
                "SELECT id, game_uniqid, name, game_type, duration
                 FROM lg_launched_games
                 WHERE client_id = ? AND ended = 0
                 ORDER BY created_at DESC",
            )?;
            let rows = stmt.query_map(params![client_id], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "game_uniqid": r.get::<_, String>(1)?,
                    "name": r.get::<_, String>(2)?,
                    "game_type": r.get::<_, String>(3)?,
                    "duration": r.get::<_, i64>(4)?,
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "games": games }))
}

async fn get_meta(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let id = parse_i64(rest, "id")?;
    require_game_owned(state, id).await?;
    let pairs = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(String, Option<String>)>> {
            let mut stmt = c.prepare(
                "SELECT meta_name, meta_value FROM lg_launched_game_meta
                 WHERE launched_game_id = ?",
            )?;
            let rows = stmt.query_map(params![id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    let mut meta = serde_json::Map::new();
    for (k, v) in pairs {
        meta.insert(k, v.map(Value::String).unwrap_or(Value::Null));
    }
    Ok(json!({ "meta": Value::Object(meta) }))
}

async fn update_meta(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    require_game_owned(state, id).await?;
    let meta_pairs: Vec<(String, Option<String>)> = body
        .get("meta")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    let s = match v {
                        Value::Null => None,
                        Value::String(s) => Some(s.clone()),
                        other => Some(other.to_string()),
                    };
                    (k.clone(), s)
                })
                .collect()
        })
        .unwrap_or_default();
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM lg_launched_game_meta WHERE launched_game_id = ?",
                params![id],
            )?;
            for (k, v) in &meta_pairs {
                tx.execute(
                    "INSERT INTO lg_launched_game_meta
                       (launched_game_id, meta_name, meta_value) VALUES (?, ?, ?)",
                    params![id, k, v],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(json!({ "success": true }))
}

async fn state_action(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let id = parse_i64(rest, "id")?;
    let since_raw_id = parse_i64_opt(rest, "since_raw_id").unwrap_or(0);
    require_game_owned(state, id).await?;

    let payload = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Value> {
            let game: Value = c.query_row(
                "SELECT id, name, game_uniqid, game_type, duration, start_time, ended, started
                 FROM lg_launched_games WHERE id = ?",
                params![id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "game_uniqid": r.get::<_, String>(2)?,
                        "game_type": r.get::<_, String>(3)?,
                        "duration": r.get::<_, i64>(4)?,
                        "start_time": r.get::<_, Option<String>>(5)?,
                        "ended": r.get::<_, i64>(6)? != 0,
                        "started": r.get::<_, i64>(7)? != 0,
                    }))
                },
            )?;

            let mut teams_stmt = c.prepare(
                "SELECT id, team_number, team_name, pattern, score, key_id, start_time, end_time
                 FROM lg_teams WHERE launched_game_id = ? ORDER BY team_number ASC",
            )?;
            let teams: Vec<Value> = teams_stmt
                .query_map(params![id], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "team_number": r.get::<_, i64>(1)?,
                        "team_name": r.get::<_, Option<String>>(2)?,
                        "pattern": r.get::<_, i64>(3)?,
                        "score": r.get::<_, i64>(4)?,
                        "key_id": r.get::<_, Option<i64>>(5)?,
                        "start_time": r.get::<_, Option<i64>>(6)?,
                        "end_time": r.get::<_, Option<i64>>(7)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let mut raw_stmt = c.prepare(
                "SELECT id, device_id, raw_data, created_at
                 FROM lg_launched_game_raw_data
                 WHERE launched_game_id = ? AND id > ?
                 ORDER BY id ASC",
            )?;
            let mut last_raw_id = since_raw_id;
            let new_raw: Vec<Value> = raw_stmt
                .query_map(params![id, since_raw_id], |r| {
                    let row_id = r.get::<_, i64>(0)?;
                    let device_id = r.get::<_, i64>(1)?;
                    let raw_text: Option<String> = r.get(2)?;
                    let created_at: String = r.get(3)?;
                    let raw_value = match raw_text {
                        Some(s) => serde_json::from_str::<Value>(&s).unwrap_or(Value::Null),
                        None => Value::Null,
                    };
                    Ok((row_id, device_id, raw_value, created_at))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(|(row_id, device_id, raw_value, created_at)| {
                    if row_id > last_raw_id {
                        last_raw_id = row_id;
                    }
                    json!({
                        "id": row_id,
                        "device_id": device_id,
                        "raw_data": raw_value,
                        "created_at": created_at,
                    })
                })
                .collect();

            let mut combined = match game {
                Value::Object(m) => m,
                _ => unreachable!(),
            };
            combined.insert("teams".into(), Value::Array(teams));
            combined.insert("new_raw_data".into(), Value::Array(new_raw));
            combined.insert("last_raw_id".into(), Value::from(last_raw_id));
            Ok(Value::Object(combined))
        })
        .await?;

    Ok(payload)
}

async fn raw_data_for_chip(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let launched_game_id = parse_i64(rest, "launched_game_id")?;
    let chip_id = parse_i64(rest, "chip_id")?;
    let limit = parse_i64_opt(rest, "limit")
        .map(|n| n.clamp(1, 50))
        .unwrap_or(2);
    require_game_owned(state, launched_game_id).await?;

    let rows = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let mut stmt = c.prepare(
                "SELECT id, device_id, raw_data, created_at
                 FROM lg_launched_game_raw_data
                 WHERE launched_game_id = ?
                   AND CAST(json_extract(raw_data, '$.id') AS INTEGER) = ?
                 ORDER BY id DESC
                 LIMIT ?",
            )?;
            let mapped = stmt
                .query_map(params![launched_game_id, chip_id, limit], |r| {
                    let raw_text: Option<String> = r.get(2)?;
                    let parsed = match raw_text {
                        Some(s) => serde_json::from_str::<Value>(&s).unwrap_or(Value::Null),
                        None => Value::Null,
                    };
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "device_id": r.get::<_, i64>(1)?,
                        "raw_data": parsed,
                        "created_at": r.get::<_, String>(3)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(mapped)
        })
        .await?;
    Ok(json!({ "rows": rows }))
}

async fn record_punch(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
    let launched_game_id = json_i64(&body, "launched_game_id")?;
    let raw_data = body
        .get("raw_data")
        .ok_or_else(|| ApiErr::bad("raw_data is required"))?
        .clone();
    require_game_owned(state, launched_game_id).await?;

    let raw_str = serde_json::to_string(&raw_data).unwrap_or_else(|_| "null".into());
    let id = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            c.execute(
                "INSERT INTO lg_launched_game_raw_data
                   (launched_game_id, device_id, raw_data) VALUES (?, ?, ?)",
                params![launched_game_id, peer_id, raw_str],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?;
    Ok(json!({ "id": id }))
}

async fn update_team(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let team_id = json_i64(&body, "team_id")?;
    require_team_owned(state, team_id).await?;

    let mut sets: Vec<&'static str> = Vec::new();
    let mut args: Vec<SqlValue> = Vec::new();
    if let Some(v) = body.get("score") {
        if let Some(n) = v.as_i64() {
            sets.push("score = ?");
            args.push(SqlValue::Integer(n));
        }
    }
    if let Some(v) = body.get("team_name") {
        sets.push("team_name = ?");
        args.push(match v {
            Value::Null => SqlValue::Null,
            Value::String(s) => SqlValue::Text(s.clone()),
            other => SqlValue::Text(other.to_string()),
        });
    }
    if let Some(v) = body.get("start_time") {
        sets.push("start_time = ?");
        args.push(match v.as_i64() {
            Some(n) => SqlValue::Integer(n),
            None => SqlValue::Null,
        });
    }
    if let Some(v) = body.get("end_time") {
        sets.push("end_time = ?");
        args.push(match v.as_i64() {
            Some(n) => SqlValue::Integer(n),
            None => SqlValue::Null,
        });
    }
    if sets.is_empty() {
        return Ok(json!({ "success": true, "noop": true }));
    }
    args.push(SqlValue::Integer(team_id));
    let sql = format!("UPDATE lg_teams SET {} WHERE id = ?", sets.join(", "));
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            c.execute(&sql, params_from_iter(args.iter()))?;
            Ok(())
        })
        .await?;
    Ok(json!({ "success": true }))
}

async fn add_team(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let launched_game_id = json_i64(&body, "launched_game_id")?;
    let team_number = json_i64(&body, "team_number")?;
    if team_number <= 0 {
        return Err(ApiErr::bad("team_number is required"));
    }
    let team_name = body
        .get("team_name")
        .and_then(|v| match v {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            _ => None,
        });
    let pattern = body.get("pattern").and_then(|v| v.as_i64()).unwrap_or(0);
    let key_id = body
        .get("key_id")
        .and_then(|v| if v.is_null() { None } else { v.as_i64() });
    require_game_owned(state, launched_game_id).await?;
    let new_id = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            c.execute(
                "INSERT INTO lg_teams
                   (launched_game_id, team_number, team_name, pattern, score, key_id)
                 VALUES (?, ?, ?, ?, 0, ?)",
                params![launched_game_id, team_number, team_name, pattern, key_id],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?;
    Ok(json!({ "id": new_id }))
}

async fn end_team(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let team_id = json_i64(&body, "team_id")?;
    let end_time = body.get("end_time").and_then(|v| v.as_i64());
    require_team_owned(state, team_id).await?;
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            c.execute(
                "UPDATE lg_teams SET end_time = ? WHERE id = ?",
                params![end_time, team_id],
            )?;
            Ok(())
        })
        .await?;
    Ok(json!({ "success": true }))
}

async fn end_game(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    require_game_owned(state, id).await?;
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            c.execute(
                "UPDATE lg_launched_games SET ended = 1 WHERE id = ?",
                params![id],
            )?;
            Ok(())
        })
        .await?;
    Ok(json!({ "success": true }))
}

async fn delete_game(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    let client_id = state.client_id;
    require_game_owned(state, id).await?;
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            c.execute(
                "DELETE FROM lg_launched_games WHERE id = ? AND client_id = ?",
                params![id, client_id],
            )?;
            Ok(())
        })
        .await?;
    Ok(json!({ "success": true }))
}

async fn register_device(
    state: &AppState,
    peer_id: i64,
    body: Value,
) -> Result<Value, ApiErr> {
    let launched_game_id = json_i64(&body, "launched_game_id")?;
    require_game_owned(state, launched_game_id).await?;
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            c.execute(
                "INSERT INTO lg_launched_game_devices
                   (launched_game_id, device_id, connected) VALUES (?, ?, 1)
                 ON CONFLICT(launched_game_id, device_id) DO UPDATE SET
                   connected = 1,
                   last_connection_attempt = CURRENT_TIMESTAMP",
                params![launched_game_id, peer_id],
            )?;
            Ok(())
        })
        .await?;
    Ok(json!({ "success": true }))
}

async fn get_devices(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let id = parse_i64(rest, "id")?;
    require_game_owned(state, id).await?;
    let devices = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            // Join with paired_devices so labels/os surface alongside the
            // launched_game_devices row, without duplicating those fields.
            let mut stmt = c.prepare(
                "SELECT lgd.id, lgd.device_id, lgd.connected, lgd.last_connection_attempt,
                        pd.peer_label, pd.peer_os, pd.peer_app_version
                 FROM lg_launched_game_devices lgd
                 LEFT JOIN paired_devices pd ON pd.id = lgd.device_id
                 WHERE lgd.launched_game_id = ?",
            )?;
            let rows = stmt.query_map(params![id], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "device_id": r.get::<_, i64>(1)?,
                    "connected": r.get::<_, i64>(2)?,
                    "last_connection_attempt": r.get::<_, String>(3)?,
                    "device_label": r.get::<_, Option<String>>(4)?,
                    "os": r.get::<_, Option<String>>(5)?,
                    "os_version": r.get::<_, Option<String>>(6)?,
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "devices": devices }))
}

// Three-bucket view of paired devices for the in-game Devices modal:
// (A) currently in this launched_game, (B) paired & online & not in game,
// (C) paired & offline & not in game. "Online" is `last_seen_at` within 25s.
// Self is included in (A) when it's a participating device; otherwise the
// caller can hide it. The modal sorts (C) by `last_seen_at` desc and labels
// staleness — that's a client concern; we just return raw timestamps.
async fn list_paired_with_status(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let launched_game_id = parse_i64(rest, "launched_game_id")?;
    require_game_owned(state, launched_game_id).await?;
    let rows = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(i64, String, Option<String>, i64, Option<String>, i64, Option<String>, Option<i64>, Option<i64>, Option<String>, i64)>> {
            let mut stmt = c.prepare(
                "SELECT pd.id, pd.peer_label, pd.peer_os, pd.is_self,
                        pd.last_seen_at, pd.has_reader, pd.reader_last_seen_at,
                        lgd.id AS lgd_id, lgd.connected, lgd.last_connection_attempt,
                        CASE WHEN pd.last_seen_at IS NOT NULL
                               AND (strftime('%s','now') - strftime('%s', pd.last_seen_at)) < 25
                             THEN 1 ELSE 0 END AS online
                   FROM paired_devices pd
                   LEFT JOIN lg_launched_game_devices lgd
                     ON lgd.device_id = pd.id AND lgd.launched_game_id = ?
                 ORDER BY pd.is_self DESC, online DESC, pd.last_seen_at DESC",
            )?;
            let rows = stmt.query_map(params![launched_game_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, i64>(10)?,
                ))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;

    let mut in_game = Vec::new();
    let mut available_online = Vec::new();
    let mut offline = Vec::new();
    for (
        id,
        peer_label,
        peer_os,
        is_self,
        last_seen_at,
        has_reader,
        reader_last_seen_at,
        lgd_id,
        _connected,
        _last_conn_attempt,
        online,
    ) in rows
    {
        let row = json!({
            "id": id,
            "device_label": peer_label,
            "peer_os": peer_os,
            "is_self": is_self == 1,
            "has_reader": has_reader == 1,
            "reader_last_seen_at": reader_last_seen_at,
            "online": online == 1,
            "last_seen_at": last_seen_at,
            "lgd_id": lgd_id,
        });
        if lgd_id.is_some() {
            in_game.push(row);
        } else if online == 1 {
            available_online.push(row);
        } else {
            offline.push(row);
        }
    }
    Ok(json!({
        "in_game": in_game,
        "available_online": available_online,
        "offline": offline,
    }))
}

// Same shape as a single `list_paired_with_status` row, but without a launched
// game to anchor against — used by the launch-wizard's step 3 to render the
// device picker BEFORE the game has been created. `lgd_id` is always null.
async fn list_paired_for_launch(state: &AppState) -> Result<Value, ApiErr> {
    let rows = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let mut stmt = c.prepare(
                "SELECT pd.id, pd.peer_label, pd.peer_os, pd.is_self,
                        pd.last_seen_at, pd.has_reader, pd.reader_last_seen_at,
                        CASE WHEN pd.last_seen_at IS NOT NULL
                               AND (strftime('%s','now') - strftime('%s', pd.last_seen_at)) < 25
                             THEN 1 ELSE 0 END AS online
                   FROM paired_devices pd
                 ORDER BY pd.is_self DESC, online DESC, pd.last_seen_at DESC",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "device_label": r.get::<_, String>(1)?,
                    "peer_os": r.get::<_, Option<String>>(2)?,
                    "is_self": r.get::<_, i64>(3)? == 1,
                    "last_seen_at": r.get::<_, Option<String>>(4)?,
                    "has_reader": r.get::<_, i64>(5)? == 1,
                    "reader_last_seen_at": r.get::<_, Option<String>>(6)?,
                    "online": r.get::<_, i64>(7)? == 1,
                    "lgd_id": Value::Null,
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "devices": rows }))
}

/// Mother-only push queue. Three command kinds today:
/// - `join_game`     — payload `{launched_game_id}` — target satellite is
///                     expected to register_device + navigate to GamePage.
/// - `play_video`    — payload `{launched_game_id, kinds[], language}` — the
///                     target plays the named videos (intro/tutorial) on top
///                     of whatever it was showing; preempts any in-flight
///                     `play_video` for the same (target, game).
/// - `stop_video`    — payload `{}` — unmount any operator overlay.
///
/// Authorization: only the mother's self-peer may queue (`peer_id == self_peer_id`).
/// Targets are validated per-kind: `play_video`/`stop_video` require the target
/// to be currently in `lg_launched_game_devices` for the payload's game;
/// `join_game` requires the target NOT to be in it (409 otherwise).
async fn queue_command(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
    if peer_id != state.self_peer_id {
        return Err(ApiErr::status(
            StatusCode::FORBIDDEN,
            "Only the mother may queue commands",
        ));
    }
    let target_device_id = json_i64(&body, "target_device_id")?;
    let kind = json_str(&body, "kind")?.to_string();
    let payload = body.get("payload").cloned().unwrap_or(Value::Null);
    let id = queue_command_inner(state, target_device_id, &kind, payload).await?;
    Ok(json!({ "command_id": id }))
}

/// Batch convenience used by the launch wizard (`join_game` for N satellites)
/// and the in-game modal's video action bar (`play_video`/`stop_video` for N
/// targets). Per-target failures are returned alongside successes so the
/// caller can render partial-success UI without aborting the whole batch.
async fn queue_command_bulk(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
    if peer_id != state.self_peer_id {
        return Err(ApiErr::status(
            StatusCode::FORBIDDEN,
            "Only the mother may queue commands",
        ));
    }
    let kind = json_str(&body, "kind")?.to_string();
    let payload = body.get("payload").cloned().unwrap_or(Value::Null);
    let targets: Vec<i64> = body
        .get("targets")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_i64()).collect())
        .unwrap_or_default();
    if targets.is_empty() {
        return Err(ApiErr::bad("targets is required (non-empty array)"));
    }

    let mut results = Vec::with_capacity(targets.len());
    for target_device_id in targets {
        match queue_command_inner(state, target_device_id, &kind, payload.clone()).await {
            Ok(id) => results.push(json!({
                "target_device_id": target_device_id,
                "command_id": id,
            })),
            Err(e) => results.push(json!({
                "target_device_id": target_device_id,
                "error": e.message,
                "status": e.status.as_u16(),
            })),
        }
    }
    Ok(json!({ "results": results }))
}

/// Validates the command and inserts it. Factored out so both `queue_command`
/// and `queue_command_bulk` enforce identical semantics — including the
/// `play_video` preempt rule that auto-acks a previous in-flight `play_video`
/// for the same (target, game) before inserting the new one.
async fn queue_command_inner(
    state: &AppState,
    target_device_id: i64,
    kind: &str,
    payload: Value,
) -> Result<i64, ApiErr> {
    if target_device_id == state.self_peer_id {
        return Err(ApiErr::bad("Cannot queue a command targeting self"));
    }
    let launched_game_id = payload
        .get("launched_game_id")
        .and_then(|v| v.as_i64());
    let kind_owned = kind.to_string();

    // Per-kind validation.
    match kind {
        "join_game" => {
            let gid = launched_game_id
                .ok_or_else(|| ApiErr::bad("payload.launched_game_id is required"))?;
            require_game_owned(state, gid).await?;
            let already: Option<i64> = state
                .db
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
                    Ok(c.query_row(
                        "SELECT id FROM lg_launched_game_devices
                          WHERE launched_game_id = ? AND device_id = ?",
                        params![gid, target_device_id],
                        |r| r.get(0),
                    )
                    .optional()?)
                })
                .await?;
            if already.is_some() {
                return Err(ApiErr::status(
                    StatusCode::CONFLICT,
                    "already_in_game",
                ));
            }
        }
        "play_video" | "stop_video" => {
            let gid = launched_game_id
                .ok_or_else(|| ApiErr::bad("payload.launched_game_id is required"))?;
            require_game_owned(state, gid).await?;
            let registered: Option<i64> = state
                .db
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
                    Ok(c.query_row(
                        "SELECT id FROM lg_launched_game_devices
                          WHERE launched_game_id = ? AND device_id = ?",
                        params![gid, target_device_id],
                        |r| r.get(0),
                    )
                    .optional()?)
                })
                .await?;
            if registered.is_none() {
                return Err(ApiErr::status(
                    StatusCode::CONFLICT,
                    "target_not_in_game",
                ));
            }
        }
        _ => return Err(ApiErr::bad(format!("Unknown command kind: {kind}"))),
    }

    let payload_str = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    let kind_for_insert = kind_owned.clone();
    let preempt_gid = if kind == "play_video" {
        launched_game_id
    } else {
        None
    };

    let new_id = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            // Preempt: when queuing a play_video, ack any prior unacked
            // play_video for the same (target, game) so only the newest
            // command reaches the satellite. We match on JSON substring of
            // launched_game_id — payloads we emit are normalized.
            if let Some(gid) = preempt_gid {
                let needle = format!("\"launched_game_id\":{gid}");
                let alt_needle = format!("\"launched_game_id\": {gid}");
                c.execute(
                    "UPDATE pending_commands
                        SET acked_at = CURRENT_TIMESTAMP
                      WHERE target_device_id = ?
                        AND kind = 'play_video'
                        AND acked_at IS NULL
                        AND (payload_json LIKE '%' || ?1 || '%'
                             OR payload_json LIKE '%' || ?2 || '%')",
                    params![target_device_id, needle, alt_needle],
                )?;
            }
            c.execute(
                "INSERT INTO pending_commands (target_device_id, kind, payload_json)
                 VALUES (?, ?, ?)",
                params![target_device_id, kind_for_insert, payload_str],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?;
    Ok(new_id)
}

/// Satellite-side confirmation that a command was acted upon. Only the target
/// device may ack its own command. Idempotent: re-acking is a no-op.
async fn ack_command(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
    let command_id = json_i64(&body, "command_id")?;
    let updated = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<usize> {
            Ok(c.execute(
                "UPDATE pending_commands
                    SET acked_at = CURRENT_TIMESTAMP
                  WHERE id = ? AND target_device_id = ?",
                params![command_id, peer_id],
            )?)
        })
        .await?;
    if updated == 0 {
        return Err(ApiErr::not_found("Command not found or not owned by caller"));
    }
    Ok(json!({ "ok": true }))
}

async fn list_completed_quests(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let launched_game_id = parse_i64(rest, "launched_game_id")?;
    let team_id = parse_i64_opt(rest, "team_id");
    require_game_owned(state, launched_game_id).await?;

    if let Some(tid) = team_id {
        let belongs: Option<i64> = state
            .db
            .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
                Ok(c.query_row(
                    "SELECT id FROM lg_teams WHERE id = ? AND launched_game_id = ?",
                    params![tid, launched_game_id],
                    |r| r.get(0),
                )
                .optional()?)
            })
            .await?;
        if belongs.is_none() {
            return Err(ApiErr::not_found("Team not found"));
        }
        let rows = state
            .db
            .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
                let mut stmt = c.prepare(
                    "SELECT id, team_id, quest_number, points_awarded, teammate_chip_id, created_at
                     FROM lg_team_completed_quests WHERE team_id = ? ORDER BY id ASC",
                )?;
                let rows = stmt.query_map(params![tid], map_completed_quest)?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await?;
        return Ok(json!({ "rows": rows }));
    }

    let rows = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let mut stmt = c.prepare(
                "SELECT id, team_id, quest_number, points_awarded, teammate_chip_id, created_at
                 FROM lg_team_completed_quests WHERE launched_game_id = ? ORDER BY id ASC",
            )?;
            let rows = stmt.query_map(params![launched_game_id], map_completed_quest)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "rows": rows }))
}

fn map_completed_quest(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "team_id": r.get::<_, i64>(1)?,
        "quest_number": r.get::<_, String>(2)?,
        "points_awarded": r.get::<_, i64>(3)?,
        "teammate_chip_id": r.get::<_, Option<i64>>(4)?,
        "created_at": r.get::<_, String>(5)?,
    }))
}

async fn record_completed_quest(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let launched_game_id = json_i64(&body, "launched_game_id")?;
    let team_id = json_i64(&body, "team_id")?;
    let quest_number = json_str(&body, "quest_number")?.to_string();
    let points_awarded = body
        .get("points_awarded")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let teammate_chip_id = body
        .get("teammate_chip_id")
        .and_then(|v| if v.is_null() { None } else { v.as_i64() });
    let allow_duplicates = body
        .get("allow_duplicates")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    require_game_owned(state, launched_game_id).await?;

    let team_belongs: Option<i64> = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
            Ok(c.query_row(
                "SELECT id FROM lg_teams WHERE id = ? AND launched_game_id = ?",
                params![team_id, launched_game_id],
                |r| r.get(0),
            )
            .optional()?)
        })
        .await?;
    if team_belongs.is_none() {
        return Err(ApiErr::not_found("Team not found"));
    }

    let qn_for_dup = quest_number.clone();
    if !allow_duplicates {
        let existing: Option<i64> = state
            .db
            .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
                Ok(c.query_row(
                    "SELECT id FROM lg_team_completed_quests
                     WHERE team_id = ? AND quest_number = ?",
                    params![team_id, qn_for_dup],
                    |r| r.get(0),
                )
                .optional()?)
            })
            .await?;
        if let Some(eid) = existing {
            return Ok(json!({ "inserted": false, "id": eid }));
        }
    }

    let new_id = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            c.execute(
                "INSERT INTO lg_team_completed_quests
                   (launched_game_id, team_id, teammate_chip_id, quest_number, points_awarded)
                 VALUES (?, ?, ?, ?, ?)",
                params![
                    launched_game_id,
                    team_id,
                    teammate_chip_id,
                    quest_number,
                    points_awarded,
                ],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?;
    Ok(json!({ "inserted": true, "id": new_id }))
}

// ─── action handlers: pair ───────────────────────────────────────────────────

async fn pair_request_handler(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let peer_uuid = json_str(&body, "peer_uuid")?.to_string();
    let peer_label = json_str(&body, "peer_label")?.to_string();
    let peer_os = body
        .get("peer_os")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let peer_app_version = body
        .get("peer_app_version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // If this peer is already paired, surface a hint so the client can re-use
    // its stored secret instead of pestering staff with a fresh approval.
    let already_paired: Option<i64> = state
        .db
        .call({
            let peer_uuid = peer_uuid.clone();
            move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
                Ok(c.query_row(
                    "SELECT id FROM paired_devices WHERE peer_uuid = ? AND is_self = 0",
                    params![peer_uuid],
                    |r| r.get(0),
                )
                .optional()?)
            }
        })
        .await?;
    if already_paired.is_some() {
        return Ok(json!({
            "status": "already_paired",
            "message": "This peer_uuid already has a paired entry. Re-use the stored secret, or have the mother revoke it to re-pair."
        }));
    }

    let proposed_secret = random_token(32);
    let request_id = state
        .db
        .call({
            let peer_uuid = peer_uuid.clone();
            let peer_label = peer_label.clone();
            let proposed_secret = proposed_secret.clone();
            move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
                c.execute(
                    "INSERT INTO pair_requests
                       (peer_uuid, peer_label, peer_os, peer_app_version, proposed_secret)
                     VALUES (?, ?, ?, ?, ?)",
                    params![peer_uuid, peer_label, peer_os, peer_app_version, proposed_secret],
                )?;
                Ok(c.last_insert_rowid())
            }
        })
        .await?;

    Ok(json!({
        "status": "pending",
        "request_id": request_id,
    }))
}

async fn pair_status_handler(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let request_id = parse_i64(rest, "request_id")?;
    let peer_uuid = rest
        .get("peer_uuid")
        .cloned()
        .ok_or_else(|| ApiErr::bad("peer_uuid is required"))?;
    let row: Option<(String, String, String)> = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<(String, String, String)>> {
            Ok(c.query_row(
                "SELECT status, peer_uuid, proposed_secret FROM pair_requests WHERE id = ?",
                params![request_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
            )
            .optional()?)
        })
        .await?;
    let Some((status, row_peer_uuid, secret)) = row else {
        return Err(ApiErr::not_found("Pair request not found"));
    };
    // Defensive: only the peer that made the request gets to read the secret.
    if row_peer_uuid != peer_uuid {
        return Err(ApiErr::status(StatusCode::FORBIDDEN, "peer_uuid mismatch"));
    }
    let payload = match status.as_str() {
        "approved" => json!({ "status": "approved", "peer_secret": secret }),
        "denied" => json!({ "status": "denied" }),
        _ => json!({ "status": "pending" }),
    };
    Ok(payload)
}

// ─── tauri commands: pair management on mother ───────────────────────────────

#[derive(Serialize)]
pub struct PendingPairRequest {
    pub id: i64,
    pub peer_uuid: String,
    pub peer_label: String,
    pub peer_os: Option<String>,
    pub peer_app_version: Option<String>,
    pub created_at: String,
}

async fn open_db_for_command(app: &AppHandle) -> Result<DbConnection, String> {
    let path = resolve_db_path(app)?;
    let conn = DbConnection::open(path)
        .await
        .map_err(|e| e.to_string())?;
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        c.pragma_update(None, "foreign_keys", "ON")?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub async fn mother_list_pending_pair_requests(
    app: AppHandle,
) -> Result<Vec<PendingPairRequest>, String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<PendingPairRequest>> {
        let mut stmt = c.prepare(
            "SELECT id, peer_uuid, peer_label, peer_os, peer_app_version, created_at
             FROM pair_requests
             WHERE status = 'pending'
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PendingPairRequest {
                id: r.get(0)?,
                peer_uuid: r.get(1)?,
                peer_label: r.get(2)?,
                peer_os: r.get(3)?,
                peer_app_version: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mother_approve_pair_request(
    app: AppHandle,
    request_id: i64,
) -> Result<i64, String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
        let tx = c.transaction()?;
        let row: Option<(String, String, Option<String>, Option<String>, String, String)> = tx
            .query_row(
                "SELECT peer_uuid, peer_label, peer_os, peer_app_version, proposed_secret, status
                 FROM pair_requests WHERE id = ?",
                params![request_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((peer_uuid, peer_label, peer_os, peer_app_version, proposed_secret, status)) = row
        else {
            return Err(tokio_rusqlite::Error::Other(
                format!("pair request {request_id} not found").into(),
            ));
        };
        if status != "pending" {
            return Err(tokio_rusqlite::Error::Other(
                format!("pair request {request_id} already {status}").into(),
            ));
        }

        tx.execute(
            "INSERT INTO paired_devices
               (peer_uuid, peer_label, peer_os, peer_app_version, peer_secret, is_self)
             VALUES (?, ?, ?, ?, ?, 0)
             ON CONFLICT(peer_uuid) DO UPDATE SET
               peer_label = excluded.peer_label,
               peer_os = excluded.peer_os,
               peer_app_version = excluded.peer_app_version,
               peer_secret = excluded.peer_secret",
            params![peer_uuid, peer_label, peer_os, peer_app_version, proposed_secret],
        )?;
        let peer_id: i64 = tx.query_row(
            "SELECT id FROM paired_devices WHERE peer_uuid = ?",
            params![peer_uuid],
            |r| r.get(0),
        )?;

        tx.execute(
            "UPDATE pair_requests SET status = 'approved', decided_at = CURRENT_TIMESTAMP
             WHERE id = ?",
            params![request_id],
        )?;
        tx.commit()?;
        Ok(peer_id)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mother_deny_pair_request(
    app: AppHandle,
    request_id: i64,
) -> Result<(), String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        let n = c.execute(
            "UPDATE pair_requests
             SET status = 'denied', decided_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pending'",
            params![request_id],
        )?;
        if n == 0 {
            return Err(tokio_rusqlite::Error::Other(
                format!("pair request {request_id} not pending").into(),
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct PairedDeviceRow {
    pub id: i64,
    pub peer_uuid: String,
    pub peer_label: String,
    pub peer_os: Option<String>,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
    pub is_self: bool,
}

#[tauri::command]
pub async fn mother_list_paired_devices(
    app: AppHandle,
) -> Result<Vec<PairedDeviceRow>, String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<PairedDeviceRow>> {
        let mut stmt = c.prepare(
            "SELECT id, peer_uuid, peer_label, peer_os, paired_at, last_seen_at, is_self
             FROM paired_devices
             ORDER BY is_self DESC, paired_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PairedDeviceRow {
                id: r.get(0)?,
                peer_uuid: r.get(1)?,
                peer_label: r.get(2)?,
                peer_os: r.get(3)?,
                paired_at: r.get(4)?,
                last_seen_at: r.get(5)?,
                is_self: r.get::<_, i64>(6)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mother_revoke_paired_device(
    app: AppHandle,
    peer_id: i64,
) -> Result<(), String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        let n = c.execute(
            "DELETE FROM paired_devices WHERE id = ? AND is_self = 0",
            params![peer_id],
        )?;
        if n == 0 {
            return Err(tokio_rusqlite::Error::Other(
                format!("no non-self paired_devices row id={peer_id}").into(),
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())
}

// ─── tauri commands: client-side (paired_mothers) ────────────────────────────

#[derive(Serialize)]
pub struct PairedMotherRow {
    pub mother_uuid: String,
    pub mother_label: Option<String>,
    pub peer_secret: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
}

#[tauri::command]
pub async fn client_save_paired_mother(
    app: AppHandle,
    mother_uuid: String,
    mother_label: Option<String>,
    peer_secret: String,
) -> Result<(), String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        c.execute(
            "INSERT INTO paired_mothers (mother_uuid, mother_label, peer_secret, last_seen_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(mother_uuid) DO UPDATE SET
               mother_label = excluded.mother_label,
               peer_secret = excluded.peer_secret,
               last_seen_at = CURRENT_TIMESTAMP",
            params![mother_uuid, mother_label, peer_secret],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn client_list_paired_mothers(
    app: AppHandle,
) -> Result<Vec<PairedMotherRow>, String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<PairedMotherRow>> {
        let mut stmt = c.prepare(
            "SELECT mother_uuid, mother_label, peer_secret, paired_at, last_seen_at
             FROM paired_mothers ORDER BY last_seen_at DESC NULLS LAST",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PairedMotherRow {
                mother_uuid: r.get(0)?,
                mother_label: r.get(1)?,
                peer_secret: r.get(2)?,
                paired_at: r.get(3)?,
                last_seen_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn client_get_paired_mother(
    app: AppHandle,
    mother_uuid: String,
) -> Result<Option<PairedMotherRow>, String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<PairedMotherRow>> {
        Ok(c.query_row(
            "SELECT mother_uuid, mother_label, peer_secret, paired_at, last_seen_at
             FROM paired_mothers WHERE mother_uuid = ?",
            params![mother_uuid],
            |r| {
                Ok(PairedMotherRow {
                    mother_uuid: r.get(0)?,
                    mother_label: r.get(1)?,
                    peer_secret: r.get(2)?,
                    paired_at: r.get(3)?,
                    last_seen_at: r.get(4)?,
                })
            },
        )
        .optional()?)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn client_forget_paired_mother(
    app: AppHandle,
    cache: tauri::State<'_, MotherEndpointCache>,
    mother_uuid: String,
) -> Result<(), String> {
    let conn = open_db_for_command(&app).await?;
    let uuid_for_db = mother_uuid.clone();
    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        c.execute(
            "DELETE FROM paired_mothers WHERE mother_uuid = ?",
            params![uuid_for_db],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut guard = cache.inner.lock().await;
    guard.remove(&mother_uuid);
    Ok(())
}

// Also expose a "get-or-create" for the client's own device identity, so the
// pairing handshake has a stable peer_uuid to send. Stored as a singleton row
// in `schema_meta`.
#[tauri::command]
pub async fn client_get_device_identity(
    app: AppHandle,
) -> Result<DeviceIdentity, String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<DeviceIdentity> {
        let existing: Option<String> = c
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'client_device_uuid'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let uuid = match existing {
            Some(s) => s,
            None => {
                let new = uuid::Uuid::new_v4().to_string();
                c.execute(
                    "INSERT INTO schema_meta(key, value) VALUES ('client_device_uuid', ?)",
                    params![new],
                )?;
                new
            }
        };
        Ok(DeviceIdentity { device_uuid: uuid })
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct DeviceIdentity {
    pub device_uuid: String,
}

// ─── tauri commands: mDNS ────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DiscoveredMother {
    pub mother_uuid: String,
    pub host: String,
    pub addresses: Vec<String>,
    pub port: u16,
    pub label: Option<String>,
}

const MDNS_SERVICE_TYPE: &str = "_taghunter._tcp.local.";

fn start_mdns(
    mother_uuid: &str,
    label: Option<&str>,
    port: u16,
) -> Result<MdnsHandle, String> {
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let host = format!("{}.local.", mother_uuid);
    let instance = format!("taghunter-{}", &mother_uuid[..8]);
    let mut props: HashMap<String, String> = HashMap::new();
    props.insert("uuid".into(), mother_uuid.to_string());
    if let Some(l) = label {
        props.insert("label".into(), l.to_string());
    }
    // Empty IP list lets mdns-sd auto-detect interface addresses on register.
    let svc = ServiceInfo::new(
        MDNS_SERVICE_TYPE,
        &instance,
        &host,
        "",
        port,
        props,
    )
    .map_err(|e| e.to_string())?
    .enable_addr_auto();
    let full_name = svc.get_fullname().to_string();
    daemon.register(svc).map_err(|e| e.to_string())?;
    Ok(MdnsHandle { daemon, full_name })
}

async fn run_mdns_discovery(timeout: Duration) -> Result<Vec<DiscoveredMother>, String> {
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let receiver = daemon
        .browse(MDNS_SERVICE_TYPE)
        .map_err(|e| e.to_string())?;

    // Collect ServiceResolved events for `timeout`. mdns-sd emits one per
    // resolved instance; deduplicate by mother_uuid (TXT key).
    let mut found: HashMap<String, DiscoveredMother> = HashMap::new();
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = match deadline.checked_duration_since(tokio::time::Instant::now()) {
            Some(d) => d,
            None => break,
        };
        let event = tokio::task::spawn_blocking({
            let receiver = receiver.clone();
            move || receiver.recv_timeout(remaining)
        })
        .await
        .map_err(|e| e.to_string())?;
        match event {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                let props = info.get_properties();
                let mother_uuid = props
                    .get_property_val_str("uuid")
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                if mother_uuid.is_empty() {
                    continue;
                }
                let label = props.get_property_val_str("label").map(|s| s.to_string());
                let addrs: Vec<String> = info
                    .get_addresses()
                    .iter()
                    .map(|a| a.to_string())
                    .collect();
                found.insert(
                    mother_uuid.clone(),
                    DiscoveredMother {
                        mother_uuid,
                        host: info.get_hostname().to_string(),
                        addresses: addrs,
                        port: info.get_port(),
                        label,
                    },
                );
            }
            Ok(_) => continue,
            Err(_) => break, // timeout
        }
    }
    let _ = daemon.shutdown();
    Ok(found.into_values().collect())
}

#[tauri::command]
pub async fn client_discover_mothers(
    timeout_ms: Option<u64>,
) -> Result<Vec<DiscoveredMother>, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2500));
    run_mdns_discovery(timeout).await
}

// Pick the best address out of a DiscoveredMother record. Prefer IPv4 (the
// soft-AP scenario on Windows hands out IPv4 leases reliably); fall back to
// IPv6 only if there are no IPv4 entries (rare, e.g. some virtual adapters).
fn select_address(addresses: &[String]) -> Option<String> {
    addresses
        .iter()
        .find(|a| a.parse::<Ipv4Addr>().is_ok())
        .cloned()
        .or_else(|| addresses.first().cloned())
}

// Refresh the in-memory mother endpoint cache by running an mDNS browse and
// intersecting the discovered set with the local `paired_mothers` rows.
// Returns the list of uuids whose endpoint was (re)cached this call. The
// footer's state machine uses this set to distinguish ORANGE (uuid present
// in the refresh result but ping still failing) from RED (uuid absent).
#[tauri::command]
pub async fn client_refresh_mother_endpoints(
    app: AppHandle,
    cache: tauri::State<'_, MotherEndpointCache>,
    timeout_ms: Option<u64>,
) -> Result<Vec<String>, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2500));
    let discovered = run_mdns_discovery(timeout).await?;

    // Intersect with the locally-paired set so we don't waste cache slots on
    // strangers' mothers that happen to be broadcasting on the same LAN.
    let paired: Vec<String> = {
        let conn = open_db_for_command(&app).await?;
        conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<String>> {
            let mut stmt = c.prepare("SELECT mother_uuid FROM paired_mothers")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let paired_set: std::collections::HashSet<String> = paired.into_iter().collect();

    let mut refreshed = Vec::new();
    let mut guard = cache.inner.lock().await;
    for m in discovered {
        if !paired_set.contains(&m.mother_uuid) {
            continue;
        }
        let Some(addr_str) = select_address(&m.addresses) else {
            continue;
        };
        // Parse as IpAddr (handles both v4 and v6) and combine with the port.
        let socket = match addr_str.parse::<std::net::IpAddr>() {
            Ok(ip) => SocketAddr::new(ip, m.port),
            Err(_) => continue,
        };
        guard.insert(m.mother_uuid.clone(), socket);
        refreshed.push(m.mother_uuid);
    }
    Ok(refreshed)
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PingErr {
    /// No row in `paired_mothers` for the requested uuid.
    Unpaired,
    /// No cached endpoint yet. Caller should run client_refresh_mother_endpoints.
    NotCached,
    /// TCP refused / timeout / DNS / connect error.
    Network { message: String },
    /// HTTP 401 — the mother no longer recognizes our peer_secret.
    Unauth,
    /// HTTP 200 but the mother_uuid in the response didn't match. Cached
    /// endpoint has been invalidated; caller should refresh on next tick.
    WrongUuid { got: String },
    /// Any other HTTP status or malformed JSON.
    BadResponse { message: String },
}

// Ping a single paired mother by uuid. The renderer's footer hook iterates
// paired_mothers (last_seen_at DESC) and stops on the first Ok(()).
//
// Now also: (1) reports the satellite's reader-attached state to the mother,
// piggybacked in the POST body, so the mother's devices modal shows a fresh
// reader badge per peer; (2) drains any pending commands the mother has
// queued for this peer (join_game, play_video, stop_video), emits each as a
// Tauri event `taghunter://lan-command`, and best-effort acks them so the
// mother's modal stops spinning the corresponding row.
#[tauri::command]
pub async fn client_ping_mother(
    app: AppHandle,
    cache: tauri::State<'_, MotherEndpointCache>,
    reader_presence: tauri::State<'_, ReaderPresence>,
    mother_uuid: String,
) -> Result<(), PingErr> {
    let secret: Option<String> = {
        let conn = open_db_for_command(&app)
            .await
            .map_err(|e| PingErr::Network { message: e })?;
        let uuid_for_q = mother_uuid.clone();
        conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
            Ok(c.query_row(
                "SELECT peer_secret FROM paired_mothers WHERE mother_uuid = ?",
                params![uuid_for_q],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
        })
        .await
        .map_err(|e| PingErr::Network { message: e.to_string() })?
    };
    let Some(secret) = secret else {
        return Err(PingErr::Unpaired);
    };

    let addr = {
        let guard = cache.inner.lock().await;
        guard.get(&mother_uuid).copied()
    };
    let Some(addr) = addr else {
        return Err(PingErr::NotCached);
    };

    let has_reader = *reader_presence.inner.lock().await;

    let url = format!("http://{addr}/ping.php");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .connect_timeout(Duration::from_millis(700))
        .build()
        .map_err(|e| PingErr::Network { message: e.to_string() })?;

    let resp = client
        .post(&url)
        .header(header::AUTHORIZATION, format!("Bearer {secret}"))
        .json(&serde_json::json!({ "has_reader": has_reader }))
        .send()
        .await
        .map_err(|e| PingErr::Network { message: e.to_string() })?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(PingErr::Unauth);
    }
    if !status.is_success() {
        return Err(PingErr::BadResponse {
            message: format!("HTTP {}", status.as_u16()),
        });
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| PingErr::BadResponse { message: e.to_string() })?;
    let got = body
        .get("mother_uuid")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if got != mother_uuid {
        // Cached endpoint is pointing at the wrong machine — drop it so the
        // next refresh picks up the correct address (if any).
        let mut guard = cache.inner.lock().await;
        guard.remove(&mother_uuid);
        return Err(PingErr::WrongUuid { got });
    }

    // Drain & dispatch pending commands. We emit before acking so a crash
    // mid-emit doesn't lose the work (the mother's 15-min TTL will re-issue).
    if let Some(commands) = body.get("commands").and_then(|v| v.as_array()) {
        use tauri::Emitter;
        for cmd in commands {
            let _ = app.emit("taghunter://lan-command", cmd.clone());
            if let Some(id) = cmd.get("id").and_then(|v| v.as_i64()) {
                let ack_addr = addr;
                let ack_secret = secret.clone();
                tokio::spawn(async move {
                    let ack_client = reqwest::Client::builder()
                        .timeout(Duration::from_secs(2))
                        .connect_timeout(Duration::from_millis(700))
                        .build();
                    if let Ok(ack_client) = ack_client {
                        let ack_url = format!(
                            "http://{ack_addr}/launched_games.php?action=ack_command"
                        );
                        let _ = ack_client
                            .post(&ack_url)
                            .header(header::AUTHORIZATION, format!("Bearer {ack_secret}"))
                            .json(&serde_json::json!({ "command_id": id }))
                            .send()
                            .await;
                    }
                });
            }
        }
    }
    Ok(())
}

/// Renderer-driven setter: the JS-side `sportidentService` poll in the Footer
/// reports whether a SI dongle is currently attached. We cache the boolean
/// in-process and let `client_ping_mother` ship it on the next ping. The
/// mother stores it on `paired_devices.has_reader` so its devices modal can
/// render a reader badge per peer without per-poll DB writes.
#[tauri::command]
pub async fn client_set_reader_presence(
    presence: tauri::State<'_, ReaderPresence>,
    has_reader: bool,
) -> Result<(), String> {
    let mut guard = presence.inner.lock().await;
    *guard = has_reader;
    Ok(())
}

#[derive(Serialize)]
pub struct LocalRole {
    /// Hotspot is currently broadcasting (drives mother_hosting / mother_partial).
    pub is_mother_hosting: bool,
    /// The local axum server is up. Together with `is_mother_hosting` this
    /// distinguishes mother_hosting (both true) from mother_partial (hotspot
    /// up but server not started).
    pub mother_server_running: bool,
    /// Count of non-self paired_devices. Drives the "N clients" count in the
    /// mother_hosting tooltip and the mother_idle state.
    pub paired_devices_count: u32,
    /// Count of paired_mothers (any). Drives the child branch entry condition.
    pub paired_mothers_count: u32,
}

// Aggregate the local LAN-mode signals into a single struct the footer can
// branch on. Cheap: hotspot status is in-memory, the two counts are single
// SELECT COUNT(*) reads, and mother_server_running comes from the in-process
// MotherServerState mutex.
#[tauri::command]
pub async fn client_describe_local_role(
    app: AppHandle,
    server_state: tauri::State<'_, MotherServerState>,
) -> Result<LocalRole, String> {
    let mother_server_running = {
        let guard = server_state.inner.lock().await;
        guard.is_some()
    };

    // mother_hotspot_status is best-effort — when Windows can't enumerate
    // tethering, we treat it as "not hosting" so the footer falls back to the
    // child / hidden branch instead of erroring.
    let is_mother_hosting = crate::hotspot::mother_hotspot_status()
        .await
        .map(|s| s.running)
        .unwrap_or(false);

    let conn = open_db_for_command(&app).await?;
    let (paired_devices_count, paired_mothers_count) = conn
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(u32, u32)> {
            let pd: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM paired_devices WHERE is_self = 0",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let pm: i64 = c
                .query_row("SELECT COUNT(*) FROM paired_mothers", [], |r| r.get(0))
                .unwrap_or(0);
            Ok((pd.max(0) as u32, pm.max(0) as u32))
        })
        .await
        .map_err(|e| e.to_string())?;

    Ok(LocalRole {
        is_mother_hosting,
        mother_server_running,
        paired_devices_count,
        paired_mothers_count,
    })
}
