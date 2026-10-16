//! LAN content server: lets a satellite fetch scenario content (game data,
//! media blobs, patterns) from the mother when the venue has no internet.
//! Mounted at `/content.php` on the mother's axum server (lan_server.rs).
//!
//! Auth: the peer bearer (paired_devices) AND an `X-Client-Id` header that must
//! match the mother's licensee, so content never crosses licensees even if a
//! device changed owner. Media blobs are content-addressed (sha256): the
//! satellite verifies every file it receives. game-data.json can't be verified
//! (its key is a studio change token, not a hash of the bytes) and is trusted
//! because the peer is paired to the same licensee.
//!
//! Old mothers answer 404 on this route; satellites only call it when the
//! hello/ping reply announces `content_caps`.
//!
//! The other direction (a satellite holding NEWER content than the mother):
//! satellites run no server, so they push. `offer_manifest` stages a newer
//! cloud snapshot, `put_blob` uploads media blobs straight into the pool
//! (sha256-verified), `put_scenario_meta` / `put_catalog` stage the rest under
//! `media/peer_inbox/`. Rust only stages: the renderer commits through its
//! normal sync path when it receives `taghunter://content-inbox`.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use tauri::{AppHandle, Emitter};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::io::ReaderStream;

use crate::lan_server::{resolve_peer, AppState};

/// Announced in hello/ping replies. Bump when a satellite must know the mother
/// serves something new on `/content.php`.
pub(crate) const CONTENT_CAPS: u32 = 1;

/// Concurrent blob streams the mother serves, in total and per satellite. A
/// mother is also a player: a few streams keep its disk and Wi-Fi free for the
/// live game. Beyond that a satellite gets 503 + Retry-After and retries.
const MAX_STREAMS: usize = 4;
const MAX_STREAMS_PER_PEER: usize = 2;
const RETRY_AFTER_SECS: &str = "3";
const STREAM_CHUNK: usize = 64 * 1024;
/// While a game runs on this mother, background transfers of files above this
/// size (videos) are refused with 503 GAME_ACTIVE: the live game's punches and
/// polls come first. A satellite joining that game (`X-Content-Priority:
/// launch`) is still served.
const GAME_ACTIVE_MAX_BYTES: u64 = 20 * 1024 * 1024;
const GAME_ACTIVE_RETRY_AFTER_SECS: &str = "60";
/// JSON bodies pushed by a satellite (a manifest, a scenario's game data).
const MAX_JSON_BODY: usize = 64 * 1024 * 1024;
const INBOX_EVENT: &str = "taghunter://content-inbox";

pub(crate) struct Slots {
    global: Arc<Semaphore>,
    per_peer: std::sync::Mutex<HashMap<i64, usize>>,
    /// Blobs being uploaded right now: one writer per `{hash}.up`.
    uploading: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl Slots {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            global: Arc::new(Semaphore::new(MAX_STREAMS)),
            per_peer: std::sync::Mutex::new(HashMap::new()),
            uploading: std::sync::Mutex::new(std::collections::HashSet::new()),
        })
    }
}

/// Exclusive right to append to one blob's upload temp; released on drop.
struct UploadLock {
    slots: Arc<Slots>,
    hash: String,
}

impl Drop for UploadLock {
    fn drop(&mut self) {
        if let Ok(mut set) = self.slots.uploading.lock() {
            set.remove(&self.hash);
        }
    }
}

fn try_lock_upload(slots: &Arc<Slots>, hash: &str) -> Option<UploadLock> {
    let mut set = slots.uploading.lock().ok()?;
    set.insert(hash.to_string())
        .then(|| UploadLock { slots: slots.clone(), hash: hash.to_string() })
}

/// Held for the whole life of a streamed body; frees both slots on drop.
struct SlotGuard {
    _permit: OwnedSemaphorePermit,
    slots: Arc<Slots>,
    peer: i64,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = self.slots.per_peer.lock() {
            if let Some(n) = m.get_mut(&self.peer) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    m.remove(&self.peer);
                }
            }
        }
    }
}

fn try_acquire(slots: &Arc<Slots>, peer: i64) -> Option<SlotGuard> {
    let mut m = slots.per_peer.lock().ok()?;
    let n = m.entry(peer).or_insert(0);
    if *n >= MAX_STREAMS_PER_PEER {
        return None;
    }
    let permit = slots.global.clone().try_acquire_owned().ok()?;
    *n += 1;
    Some(SlotGuard { _permit: permit, slots: slots.clone(), peer })
}

#[derive(Deserialize)]
pub(crate) struct ContentQuery {
    action: Option<String>,
    uniqid: Option<String>,
    hash: Option<String>,
    kind: Option<String>,
    /// get_file: `admin` (game_types) or `client` (game_type_overrides).
    variant: Option<String>,
    code: Option<String>,
    version: Option<i64>,
    file: Option<String>,
    /// get_file: `1` = a subtitle track (in the version dir's `subtitles/`).
    sub: Option<String>,
    /// put_blob: where this chunk starts, and the blob's full size.
    offset: Option<u64>,
    size: Option<u64>,
    /// put_installer: `windows-x86_64`, `android`...; and its release.json.
    platform: Option<String>,
    meta: Option<String>,
}

fn err(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn busy() -> Response {
    let mut r = err(StatusCode::SERVICE_UNAVAILABLE, "BUSY");
    r.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static(RETRY_AFTER_SECS));
    r
}

pub(crate) async fn dispatch_content(
    State(state): State<AppState>,
    Query(q): Query<ContentQuery>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let peer_id = match resolve_peer(&state, &headers).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let caller_client = headers
        .get("x-client-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok());
    if caller_client != Some(state.client_id) {
        return err(StatusCode::FORBIDDEN, "CLIENT_MISMATCH");
    }

    match q.action.as_deref().unwrap_or("") {
        "status" => Json(json!({ "content_caps": CONTENT_CAPS })).into_response(),
        "get_scenario_meta" => match q.uniqid.as_deref() {
            Some(u) if !u.is_empty() => scenario_meta(&state, u.to_string()).await,
            _ => err(StatusCode::BAD_REQUEST, "uniqid is required"),
        },
        "inventory" => inventory(&state).await,
        "get_manifest" => manifest(&state).await,
        "get_blob" => match q.hash.as_deref() {
            Some(h) if is_hash(h) => {
                let path = blob_path(&state.media_root, h);
                stream_file(&state, peer_id, path, &headers, "BLOB_NOT_ON_MOTHER").await
            }
            _ => err(StatusCode::BAD_REQUEST, "invalid hash"),
        },
        "get_file" => game_type_file(&state, peer_id, &q, &headers).await,
        "get_catalog" => match (q.kind.as_deref(), q.uniqid.as_deref()) {
            (Some("pattern"), Some(u)) if !u.is_empty() => pattern(&state, u.to_string()).await,
            (Some("team_names"), _) => team_names(&state).await,
            (Some("report_layouts"), _) => report_layouts(&state).await,
            _ => err(StatusCode::BAD_REQUEST, "unsupported catalog"),
        },
        // ── satellite → mother (push) ──
        "offer_manifest" => offer_manifest(&state, body).await,
        "missing_blobs" => missing_blobs(&state, body).await,
        "put_blob" => put_blob(&state, peer_id, &q, body).await,
        "put_scenario_meta" => put_staged(&state, body, "scenario").await,
        // A newer app installer a satellite holds (update_cache.rs verifies it).
        "put_installer" => {
            let (Some(platform), Some(meta)) = (q.platform.as_deref(), q.meta.as_deref()) else {
                return err(StatusCode::BAD_REQUEST, "platform and meta are required");
            };
            let Ok(meta) = serde_json::from_str::<crate::update_cache::ReleaseMeta>(meta) else {
                return err(StatusCode::BAD_REQUEST, "invalid meta");
            };
            match crate::update_cache::receive_installer(&state.app, platform, meta, body).await {
                Ok(kept) => Json(json!({ "kept": kept })).into_response(),
                Err(e) => err(StatusCode::UNPROCESSABLE_ENTITY, &e),
            }
        }
        // Chip lists + unpushed chip edits, both ways (cards_sync.rs).
        "cards_exchange" => {
            let v = match read_json(body).await {
                Ok(v) => v,
                Err(r) => return r,
            };
            let Ok(theirs) = serde_json::from_value::<crate::cards_sync::CardsPayload>(v) else {
                return err(StatusCode::BAD_REQUEST, "invalid cards payload");
            };
            if theirs.client_id != state.client_id {
                return err(StatusCode::FORBIDDEN, "CLIENT_MISMATCH");
            }
            match crate::cards_sync::mother_exchange(&state.db, &state.app, state.client_id, theirs).await {
                Ok(v) => Json(v).into_response(),
                Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
            }
        }
        "put_catalog" => match q.kind.as_deref() {
            Some(k @ ("pattern" | "team_names" | "report_layouts")) => put_staged(&state, body, k).await,
            _ => err(StatusCode::BAD_REQUEST, "unsupported catalog"),
        },
        "" => err(StatusCode::BAD_REQUEST, "action is required"),
        _ => err(StatusCode::NOT_FOUND, "unknown action"),
    }
}

/// sha256 hex, lowercase - the only thing ever joined into a blob path.
fn is_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn blob_path(media_root: &Path, hash: &str) -> PathBuf {
    media_root.join("blobs").join(&hash[..2]).join(hash)
}

// ─── scenario meta ──────────────────────────────────────────────────────────

struct ScenarioRow {
    title: String,
    game_type: String,
    is_product: bool,
    remote_version: f64,
    local_version: Option<f64>,
    local_hash: Option<String>,
    remote_hash: Option<String>,
}

/// Same shape as the studio's `get_scenario_game_data`, so the satellite's
/// sync pipeline consumes it unchanged, plus what a peer copy needs:
/// `complete` (our copy matches our cloud manifest), `content_hash` (set only
/// when complete) and a per-file `available` (blob on disk here).
///
/// The file list is the full one for our committed hash when we know it
/// (scenario_remote_files - an operator-only mother keeps just a subset of the
/// media), else what we committed.
async fn scenario_meta(state: &AppState, uniqid: String) -> Response {
    let media_root = state.media_root.clone();
    let uniqid_out = uniqid.clone();
    let res = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<(ScenarioRow, Vec<(String, String, Option<i64>)>)>> {
            let row = c
                .query_row(
                    "SELECT title, game_type, is_product, remote_version, local_version,
                            local_content_hash, remote_content_hash
                       FROM scenarios WHERE uniqid = ?",
                    params![uniqid],
                    |r| {
                        Ok(ScenarioRow {
                            title: r.get(0)?,
                            game_type: r.get(1)?,
                            is_product: r.get::<_, i64>(2)? != 0,
                            remote_version: r.get(3)?,
                            local_version: r.get(4)?,
                            local_hash: r.get(5)?,
                            remote_hash: r.get(6)?,
                        })
                    },
                )
                .optional()?;
            let Some(row) = row else { return Ok(None) };
            if row.local_version.is_none() {
                return Ok(Some((row, Vec::new())));
            }
            let complete = row.local_hash.is_some() && row.local_hash == row.remote_hash;
            let mut remote: Vec<(String, String, Option<i64>)> = Vec::new();
            if let (true, Some(h)) = (complete, row.local_hash.as_ref()) {
                let mut st = c.prepare(
                    "SELECT rel_path, hash, size FROM scenario_remote_files
                      WHERE uniqid = ? AND content_hash = ? ORDER BY rel_path",
                )?;
                remote = st
                    .query_map(params![uniqid, h], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<Result<_, _>>()?;
            }
            if remote.is_empty() {
                let mut st = c.prepare(
                    "SELECT f.rel_path, f.content_hash, rf.size
                       FROM scenario_files f
                       LEFT JOIN scenario_remote_files rf
                         ON rf.uniqid = f.uniqid AND rf.rel_path = f.rel_path AND rf.hash = f.content_hash
                      WHERE f.uniqid = ? ORDER BY f.rel_path",
                )?;
                remote = st
                    .query_map(params![uniqid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<Result<_, _>>()?;
            }
            Ok(Some((row, remote)))
        })
        .await;

    let (row, files) = match res {
        Ok(Some(v)) => v,
        Ok(None) => return err(StatusCode::NOT_FOUND, "NOT_ON_MOTHER"),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let Some(version) = row.local_version else {
        return err(StatusCode::NOT_FOUND, "NOT_DOWNLOADED");
    };
    let Some(data_hash) = files
        .iter()
        .find(|(p, _, _)| p == "game-data.json")
        .map(|(_, h, _)| h.clone())
    else {
        return err(StatusCode::NOT_FOUND, "NOT_DOWNLOADED");
    };
    // The game-data blob is keyed by the studio's data_hash (any string the
    // studio chose); never join an unvalidated key into a path.
    if data_hash.contains(['/', '\\', '.']) || data_hash.len() < 2 {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "bad data hash");
    }
    let game_data: Value = match tokio::fs::read(blob_path(&media_root, &data_hash)).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return err(StatusCode::NOT_FOUND, "NOT_DOWNLOADED"),
        },
        Err(_) => return err(StatusCode::NOT_FOUND, "NOT_DOWNLOADED"),
    };

    let mut out_files = Vec::with_capacity(files.len());
    for (rel_path, hash, size) in &files {
        let available = rel_path == "game-data.json"
            || (is_hash(hash) && tokio::fs::metadata(blob_path(&media_root, hash)).await.is_ok());
        out_files.push(json!({
            "rel_path": rel_path,
            "hash": hash,
            "size": size,
            "available": available,
        }));
    }

    let complete = row.local_hash.is_some() && row.local_hash == row.remote_hash;
    Json(json!({
        "scenario": { "uniqid": uniqid_out, "name": row.title, "scenario_type": row.game_type },
        "title": row.title,
        "game_type": row.game_type,
        "is_product": row.is_product,
        "version": version,
        "remote_version": row.remote_version,
        "remote_content_hash": row.remote_hash,
        "complete": complete,
        "content_hash": if complete { row.local_hash.clone() } else { None },
        "game_data": game_data,
        "data_hash": data_hash,
        "files": out_files,
        "medias": Value::Null,
    }))
    .into_response()
}

// ─── blobs ──────────────────────────────────────────────────────────────────

/// `bytes=N-` (what the satellite's resume sends). Anything else = whole file.
fn parse_range_start(headers: &HeaderMap) -> Option<u64> {
    let v = headers.get(header::RANGE)?.to_str().ok()?;
    let rest = v.trim().strip_prefix("bytes=")?;
    let (start, end) = rest.split_once('-')?;
    if !end.trim().is_empty() {
        return None;
    }
    start.trim().parse::<u64>().ok()
}

async fn game_active(state: &AppState) -> bool {
    state
        .db
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
            Ok(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM lg_launched_games WHERE ended = 0)",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap_or(false)
}

fn is_launch_priority(headers: &HeaderMap) -> bool {
    headers
        .get("x-content-priority")
        .and_then(|v| v.to_str().ok())
        .map_or(false, |v| v.eq_ignore_ascii_case("launch"))
}

/// Stream a file (whole, or from `Range: bytes=N-`) under the slot limits.
async fn stream_file(
    state: &AppState,
    peer_id: i64,
    path: PathBuf,
    headers: &HeaderMap,
    missing_code: &str,
) -> Response {
    let len = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m.len(),
        _ => return err(StatusCode::NOT_FOUND, missing_code),
    };
    if len > GAME_ACTIVE_MAX_BYTES && !is_launch_priority(headers) && game_active(state).await {
        let mut r = err(StatusCode::SERVICE_UNAVAILABLE, "GAME_ACTIVE");
        r.headers_mut().insert(
            header::RETRY_AFTER,
            HeaderValue::from_static(GAME_ACTIVE_RETRY_AFTER_SECS),
        );
        return r;
    }
    let start = parse_range_start(headers).unwrap_or(0);
    if start > 0 && start >= len {
        let mut r = err(StatusCode::RANGE_NOT_SATISFIABLE, "range");
        if let Ok(v) = HeaderValue::from_str(&format!("bytes */{len}")) {
            r.headers_mut().insert(header::CONTENT_RANGE, v);
        }
        return r;
    }
    let Some(guard) = try_acquire(&state.content_slots, peer_id) else {
        return busy();
    };
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return err(StatusCode::NOT_FOUND, missing_code),
    };
    if start > 0 && file.seek(SeekFrom::Start(start)).await.is_err() {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "seek");
    }
    // The guard rides along with the stream: the slot stays taken until the
    // body is fully sent or the satellite hangs up.
    let stream = ReaderStream::with_capacity(file, STREAM_CHUNK).map(move |chunk| {
        let _held = &guard;
        chunk
    });

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, len - start)
        .header(header::ACCEPT_RANGES, "bytes");
    builder = if start > 0 {
        builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{}/{len}", len - 1))
    } else {
        builder.status(StatusCode::OK)
    };
    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "response"))
}

// ─── catalogs ───────────────────────────────────────────────────────────────

/// Same shape as the studio's `download_pattern`, plus the manifest fields a
/// satellite needs to create the row when its own manifest predates the
/// pattern. `is_local` patterns (imported on this device) are served too: a
/// Tracks game launched on one can't be played without it.
async fn pattern(state: &AppState, uniqid: String) -> Response {
    let res = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<Value>> {
            Ok(c.query_row(
                "SELECT pattern_uniqid, name, game_type, pattern_slug, description, is_default,
                        COALESCE(is_local, 0), local_version, pattern_data_json
                   FROM patterns WHERE pattern_uniqid = ? AND local_version IS NOT NULL",
                params![uniqid],
                |r| {
                    let data_json: Option<String> = r.get(8)?;
                    // Stored as a `{ pattern_data, stations }` envelope; older
                    // rows hold the bare pattern_data.
                    let parsed: Value = data_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(Value::Null);
                    let (pattern_data, stations) = match parsed {
                        Value::Object(ref o) if o.contains_key("pattern_data") => (
                            o.get("pattern_data").cloned().unwrap_or(Value::Null),
                            o.get("stations").cloned().unwrap_or(Value::Null),
                        ),
                        other => (other, Value::Null),
                    };
                    Ok(json!({
                        "pattern_uniqid": r.get::<_, String>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "game_type": r.get::<_, String>(2)?,
                        "pattern_slug": r.get::<_, Option<String>>(3)?,
                        "description": r.get::<_, Option<String>>(4)?,
                        "is_default": r.get::<_, i64>(5)? != 0,
                        "is_local": r.get::<_, i64>(6)? != 0,
                        "version": r.get::<_, f64>(7)?,
                        "pattern_data": pattern_data,
                        "stations": stations,
                    }))
                },
            )
            .optional()?)
        })
        .await;
    match res {
        Ok(Some(v)) => Json(v).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "NOT_ON_MOTHER"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ─── inventory + manifest ───────────────────────────────────────────────────

/// Bumped by the renderer after every content apply; announced on /ping.php so
/// satellites know when to pull.
pub(crate) async fn content_rev(state: &AppState) -> i64 {
    state
        .db
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            Ok(c
                .query_row("SELECT content_rev FROM content_sync_state WHERE id = 1", [], |r| r.get(0))
                .optional()?
                .unwrap_or(0))
        })
        .await
        .unwrap_or(0)
}

/// What this mother holds, so a satellite can tell what it may fetch from here
/// (rule: we serve X when our local copy == the satellite's remote X) and
/// whether our cloud snapshot is newer than its own.
async fn inventory(state: &AppState) -> Response {
    let client_id = state.client_id;
    let res = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Value> {
            let snap: Option<(Option<i64>, Option<i64>, i64, i64)> = c
                .query_row(
                    "SELECT client_id, cloud_as_of_ms, approx, content_rev FROM content_sync_state WHERE id = 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            let (snap_client, as_of, approx, rev) = snap.unwrap_or((None, None, 0, 0));
            // A snapshot recorded under another licensee is not ours to offer.
            let as_of = if snap_client == Some(client_id) { as_of } else { None };

            let mut st = c.prepare(
                "SELECT uniqid, local_content_hash, remote_content_hash FROM scenarios
                  WHERE local_version IS NOT NULL",
            )?;
            let scenarios: Vec<Value> = st
                .query_map([], |r| {
                    let uniqid: String = r.get(0)?;
                    let local: Option<String> = r.get(1)?;
                    let remote: Option<String> = r.get(2)?;
                    let complete = local.is_some() && local == remote;
                    Ok(json!({
                        "uniqid": uniqid,
                        "hash": if complete { local } else { None },
                        "complete": complete,
                    }))
                })?
                .collect::<Result<_, _>>()?;

            let mut st = c.prepare(
                "SELECT pattern_uniqid, local_version FROM patterns WHERE local_version IS NOT NULL",
            )?;
            let patterns: Vec<Value> = st
                .query_map([], |r| {
                    Ok(json!({ "uniqid": r.get::<_, String>(0)?, "version": r.get::<_, f64>(1)? }))
                })?
                .collect::<Result<_, _>>()?;

            let team_names: Option<f64> = c
                .query_row(
                    "SELECT local_version FROM name_pools_state WHERE client_id = ?",
                    params![client_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            let report_layouts: Option<f64> = c
                .query_row("SELECT local_version FROM report_layouts_state WHERE id = 1", [], |r| r.get(0))
                .optional()?
                .flatten();

            let mut st = c.prepare(
                "SELECT code, local_version, subtitles_local_version FROM game_types
                  WHERE local_version IS NOT NULL",
            )?;
            let game_types: Vec<Value> = st
                .query_map([], |r| {
                    Ok(json!({
                        "code": r.get::<_, String>(0)?,
                        "version": r.get::<_, f64>(1)?,
                        "subtitles_version": r.get::<_, f64>(2)?,
                    }))
                })?
                .collect::<Result<_, _>>()?;
            let mut st = c.prepare(
                "SELECT game_type_code, local_version, subtitles_local_version FROM game_type_overrides
                  WHERE local_version IS NOT NULL",
            )?;
            let overrides: Vec<Value> = st
                .query_map([], |r| {
                    Ok(json!({
                        "code": r.get::<_, String>(0)?,
                        "version": r.get::<_, f64>(1)?,
                        "subtitles_version": r.get::<_, f64>(2)?,
                    }))
                })?
                .collect::<Result<_, _>>()?;

            let game_active: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM lg_launched_games WHERE ended = 0)",
                [],
                |r| r.get(0),
            )?;

            Ok(json!({
                "v": 1,
                "client_id": client_id,
                "cloud_as_of_ms": as_of,
                "approx": approx != 0,
                "content_rev": rev,
                "game_active": game_active,
                "scenarios": scenarios,
                "patterns": patterns,
                "team_names": team_names,
                "report_layouts": report_layouts,
                "game_types": game_types,
                "overrides": overrides,
            }))
        })
        .await;
    match res {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// The last cloud manifest this mother applied (device-only fields already
/// stripped by the renderer), with the time the cloud produced it.
async fn manifest(state: &AppState) -> Response {
    let client_id = state.client_id;
    let res = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<(Option<i64>, Option<i64>, i64, Option<String>)>> {
            Ok(c.query_row(
                "SELECT client_id, cloud_as_of_ms, approx, manifest_json FROM content_sync_state WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?)
        })
        .await;
    match res {
        Ok(Some((Some(cid), Some(as_of), approx, Some(json_text)))) if cid == client_id => {
            match serde_json::from_str::<Value>(&json_text) {
                Ok(m) => Json(json!({
                    "client_id": cid,
                    "cloud_as_of_ms": as_of,
                    "approx": approx != 0,
                    "manifest": m,
                }))
                .into_response(),
                Err(_) => err(StatusCode::NOT_FOUND, "NO_SNAPSHOT"),
            }
        }
        Ok(_) => err(StatusCode::NOT_FOUND, "NO_SNAPSHOT"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ─── more catalogs ──────────────────────────────────────────────────────────

/// The team-name pools file, verbatim, with the version it was downloaded at.
async fn team_names(state: &AppState) -> Response {
    let client_id = state.client_id;
    let version = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<f64>> {
            Ok(c.query_row(
                "SELECT local_version FROM name_pools_state WHERE client_id = ?",
                params![client_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten())
        })
        .await;
    let Ok(Some(version)) = version else {
        return err(StatusCode::NOT_FOUND, "NOT_ON_MOTHER");
    };
    match tokio::fs::read_to_string(state.media_root.join("name_pools").join("team_names.json")).await {
        Ok(content) => Json(json!({ "version": version, "content": content })).into_response(),
        Err(_) => err(StatusCode::NOT_FOUND, "NOT_ON_MOTHER"),
    }
}

/// Mission-report PDF layouts, in the studio's `get_report_layouts` shape minus
/// `print_format` (kept by the renderer in browser storage, which we can't
/// read; a satellite keeps its own until its next cloud sync).
async fn report_layouts(state: &AppState) -> Response {
    let res = state
        .db
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<Value>> {
            let version: Option<f64> = c
                .query_row("SELECT local_version FROM report_layouts_state WHERE id = 1", [], |r| r.get(0))
                .optional()?
                .flatten();
            let Some(version) = version else { return Ok(None) };
            let mut st = c.prepare("SELECT game_type, layout_json FROM report_layouts")?;
            let mut layouts = serde_json::Map::new();
            for row in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                let (game_type, text) = row?;
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    layouts.insert(game_type, v);
                }
            }
            Ok(Some(json!({ "version": version, "layouts": layouts })))
        })
        .await;
    match res {
        Ok(Some(v)) => Json(v).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "NOT_ON_MOTHER"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// A file name we may join into a path: no separators, no dot-leading names.
fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':', '\0'])
}

fn is_safe_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 64
        && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A game-type tutorial video or one of its subtitle tracks. Videos are
/// written straight to their final path while downloading, so a file is served
/// only once its table row says that version is complete here.
async fn game_type_file(state: &AppState, peer_id: i64, q: &ContentQuery, headers: &HeaderMap) -> Response {
    let (Some(variant), Some(code), Some(version), Some(file)) =
        (q.variant.as_deref(), q.code.as_deref(), q.version, q.file.as_deref())
    else {
        return err(StatusCode::BAD_REQUEST, "variant, code, version and file are required");
    };
    if !is_safe_code(code) || !is_safe_name(file) || version < 0 {
        return err(StatusCode::BAD_REQUEST, "invalid file");
    }
    let table_sql = match variant {
        "admin" => "SELECT local_version FROM game_types WHERE code = ?",
        "client" => "SELECT local_version FROM game_type_overrides WHERE game_type_code = ?",
        _ => return err(StatusCode::BAD_REQUEST, "invalid variant"),
    };
    let code_owned = code.to_string();
    let local: Option<f64> = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<f64>> {
            Ok(c.query_row(table_sql, params![code_owned], |r| r.get(0))
                .optional()?
                .flatten())
        })
        .await
        .unwrap_or(None);
    if local != Some(version as f64) {
        return err(StatusCode::NOT_FOUND, "NOT_ON_MOTHER");
    }
    let mut dir = state.media_root.join("game_types").join(code);
    if variant == "client" {
        dir = dir.join("client");
    }
    dir = dir.join(format!("v{version}"));
    if q.sub.as_deref() == Some("1") {
        dir = dir.join("subtitles");
    }
    stream_file(state, peer_id, dir.join(file), headers, "NOT_ON_MOTHER").await
}

// ─── satellite → mother: push ───────────────────────────────────────────────

async fn read_json(body: Body) -> Result<Value, Response> {
    let bytes = axum::body::to_bytes(body, MAX_JSON_BODY)
        .await
        .map_err(|_| err(StatusCode::PAYLOAD_TOO_LARGE, "body too large"))?;
    serde_json::from_slice(&bytes).map_err(|_| err(StatusCode::BAD_REQUEST, "invalid JSON"))
}

fn tmp_upload_path(media_root: &Path, hash: &str) -> PathBuf {
    // `.up`, not `.part`: the renderer's own studio download of the same blob
    // resumes from `{hash}.part`; two writers must never share a file.
    media_root.join("blobs").join(".tmp").join(format!("{hash}.up"))
}

fn inbox_dir(media_root: &Path) -> PathBuf {
    media_root.join("peer_inbox")
}

/// A satellite's cloud snapshot, newer than ours: staged for the renderer,
/// which adopts it through its normal (peer) sync path.
async fn offer_manifest(state: &AppState, body: Body) -> Response {
    let v = match read_json(body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if v.get("client_id").and_then(|x| x.as_i64()) != Some(state.client_id) {
        return err(StatusCode::FORBIDDEN, "CLIENT_MISMATCH");
    }
    if v.get("approx").and_then(|x| x.as_bool()).unwrap_or(true) {
        return Json(json!({ "accepted": false })).into_response();
    }
    let (Some(as_of), Some(manifest)) = (
        v.get("cloud_as_of_ms").and_then(|x| x.as_i64()),
        v.get("manifest").filter(|m| m.is_object()),
    ) else {
        return err(StatusCode::BAD_REQUEST, "cloud_as_of_ms and manifest are required");
    };
    let manifest_text = manifest.to_string();
    let client_id = state.client_id;
    let res = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
            let cur: Option<(Option<i64>, Option<i64>, Option<i64>)> = c
                .query_row(
                    "SELECT client_id, cloud_as_of_ms, inbox_as_of_ms FROM content_sync_state WHERE id = 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let (cid, own, inbox) = cur.unwrap_or((None, None, None));
            let own = if cid == Some(client_id) { own } else { None };
            if own.map_or(false, |o| o >= as_of) || inbox.map_or(false, |i| i >= as_of) {
                return Ok(false);
            }
            c.execute(
                "UPDATE content_sync_state SET inbox_manifest_json = ?, inbox_as_of_ms = ? WHERE id = 1",
                params![manifest_text, as_of],
            )?;
            Ok(true)
        })
        .await;
    match res {
        Ok(accepted) => {
            if accepted {
                let _ = state.app.emit(INBOX_EVENT, ());
            }
            Json(json!({ "accepted": accepted })).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// Which of these blobs the pool lacks, with how much of each an interrupted
/// upload already left here (resume offset).
async fn missing_blobs(state: &AppState, body: Body) -> Response {
    let v = match read_json(body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(hashes) = v.get("hashes").and_then(|h| h.as_array()) else {
        return err(StatusCode::BAD_REQUEST, "hashes is required");
    };
    if hashes.len() > 10_000 {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "too many hashes");
    }
    let mut missing = Vec::new();
    for h in hashes.iter().filter_map(|h| h.as_str()).filter(|h| is_hash(h)) {
        if tokio::fs::metadata(blob_path(&state.media_root, h)).await.is_ok() {
            continue;
        }
        let have = tokio::fs::metadata(tmp_upload_path(&state.media_root, h))
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        missing.push(json!({ "hash": h, "have": have }));
    }
    Json(json!({ "missing": missing })).into_response()
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Append a chunk of a blob (from `offset`) to its upload temp; once `size`
/// bytes are there, verify the sha256 and move it into the pool.
async fn put_blob(state: &AppState, peer_id: i64, q: &ContentQuery, body: Body) -> Response {
    let (Some(hash), Some(offset), Some(size)) = (q.hash.as_deref(), q.offset, q.size) else {
        return err(StatusCode::BAD_REQUEST, "hash, offset and size are required");
    };
    if !is_hash(hash) {
        return err(StatusCode::BAD_REQUEST, "invalid hash");
    }
    let final_path = blob_path(&state.media_root, hash);
    if tokio::fs::metadata(&final_path).await.is_ok() {
        return Json(json!({ "done": true })).into_response();
    }
    let Some(_guard) = try_acquire(&state.content_slots, peer_id) else {
        return busy();
    };
    // Another satellite is uploading this very blob: come back later (it may
    // well be in the pool by then).
    let Some(_upload) = try_lock_upload(&state.content_slots, hash) else {
        return busy();
    };
    let tmp = tmp_upload_path(&state.media_root, hash);
    if let Some(dir) = tmp.parent() {
        if tokio::fs::create_dir_all(dir).await.is_err() {
            return err(StatusCode::INTERNAL_SERVER_ERROR, "tmp dir");
        }
    }
    let have = tokio::fs::metadata(&tmp).await.map(|m| m.len()).unwrap_or(0);
    if offset != have {
        return (StatusCode::CONFLICT, Json(json!({ "error": "OFFSET", "have": have }))).into_response();
    }
    let mut file = match tokio::fs::OpenOptions::new().create(true).append(true).open(&tmp).await {
        Ok(f) => f,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "open tmp"),
    };
    let mut written = have;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            // Satellite hung up: keep what arrived, it resumes from `have`.
            let _ = file.flush().await;
            return err(StatusCode::BAD_REQUEST, "upload interrupted");
        };
        written += chunk.len() as u64;
        if written > size || file.write_all(&chunk).await.is_err() {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp).await;
            return err(StatusCode::BAD_REQUEST, "upload overflow");
        }
    }
    if file.flush().await.is_err() {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "flush");
    }
    drop(file);
    if written < size {
        return Json(json!({ "done": false, "have": written })).into_response();
    }
    let tmp_for_hash = tmp.clone();
    let got = tokio::task::spawn_blocking(move || sha256_of(&tmp_for_hash))
        .await
        .ok()
        .and_then(|r| r.ok());
    if got.as_deref() != Some(hash) {
        let _ = tokio::fs::remove_file(&tmp).await;
        return err(StatusCode::UNPROCESSABLE_ENTITY, "HASH_MISMATCH");
    }
    if let Some(dir) = final_path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    if tokio::fs::rename(&tmp, &final_path).await.is_err() {
        // Lost a race with our own studio download of the same blob: fine.
        if tokio::fs::metadata(&final_path).await.is_err() {
            return err(StatusCode::INTERNAL_SERVER_ERROR, "rename");
        }
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    Json(json!({ "done": true })).into_response()
}

/// Stage a scenario's meta or a catalog pushed by a satellite, as the same
/// JSON a peer `get_*` reply carries, under media/peer_inbox/. Written to a
/// temp then renamed, so the renderer never reads half a file.
async fn put_staged(state: &AppState, body: Body, kind: &str) -> Response {
    let v = match read_json(body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let rel = match kind {
        "scenario" => match v.get("scenario").and_then(|s| s.get("uniqid")).and_then(|u| u.as_str()) {
            Some(u) if is_safe_name(u)
                && v.get("content_hash").and_then(|h| h.as_str()).is_some()
                && v.get("files").map_or(false, |f| f.is_array())
                && v.get("game_data").map_or(false, |g| !g.is_null()) =>
            {
                format!("scenarios/{u}.json")
            }
            _ => return err(StatusCode::BAD_REQUEST, "invalid scenario"),
        },
        "pattern" => match v.get("pattern_uniqid").and_then(|u| u.as_str()) {
            Some(u) if is_safe_name(u) && v.get("version").map_or(false, |x| x.is_number()) => {
                format!("patterns/{u}.json")
            }
            _ => return err(StatusCode::BAD_REQUEST, "invalid pattern"),
        },
        "team_names" if v.get("version").map_or(false, |x| x.is_number())
            && v.get("content").map_or(false, |x| x.is_string()) =>
        {
            "team_names.json".to_string()
        }
        "report_layouts" if v.get("version").map_or(false, |x| x.is_number())
            && v.get("layouts").map_or(false, |x| x.is_object()) =>
        {
            "report_layouts.json".to_string()
        }
        _ => return err(StatusCode::BAD_REQUEST, "invalid catalog"),
    };
    let path = inbox_dir(&state.media_root).join(&rel);
    if let Some(dir) = path.parent() {
        if tokio::fs::create_dir_all(dir).await.is_err() {
            return err(StatusCode::INTERNAL_SERVER_ERROR, "inbox dir");
        }
    }
    let tmp = path.with_extension("json.tmp");
    if tokio::fs::write(&tmp, v.to_string()).await.is_err() || tokio::fs::rename(&tmp, &path).await.is_err() {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "write inbox");
    }
    let _ = state.app.emit(INBOX_EVENT, ());
    Json(json!({ "staged": true })).into_response()
}

// ─── satellite side: blob upload ────────────────────────────────────────────

/// Upload one media blob of this device's pool to the mother's `put_blob`,
/// resuming at `offset` (what the mother already has, from `missing_blobs`).
/// Rust-side so a multi-hundred-MB video streams from disk without passing
/// through the webview. Returns the mother's reply.
#[tauri::command]
pub async fn client_push_blob(
    app: AppHandle,
    base_url: String,
    token: String,
    client_id: i64,
    hash: String,
    offset: u64,
) -> Result<Value, String> {
    if !is_hash(&hash) {
        return Err("invalid hash".into());
    }
    let media_root = crate::lan_server::resolve_media_root(&app)?;
    let path = blob_path(&media_root, &hash);
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("blob not on this device: {e}"))?
        .len();
    if offset > size {
        return Err(format!("offset {offset} past the blob size {size}"));
    }
    let mut file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
    let body = reqwest::Body::wrap_stream(ReaderStream::with_capacity(file, STREAM_CHUNK));

    let client = crate::lan_server::lan_client_builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(60 * 60))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!(
        "{}/content.php?action=put_blob&hash={hash}&offset={offset}&size={size}",
        base_url.trim_end_matches('/')
    );
    let resp = client
        .put(url)
        .bearer_auth(token)
        .header("X-Client-Id", client_id.to_string())
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(v)
    } else {
        Err(format!("HTTP {}: {}", status.as_u16(), v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_validation() {
        assert!(is_hash(&"a".repeat(64)));
        assert!(is_hash("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
        assert!(!is_hash(&"A".repeat(64)));
        assert!(!is_hash(&"a".repeat(63)));
        assert!(!is_hash("../../../../etc/passwd/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    }

    #[test]
    fn range_parsing() {
        let mut h = HeaderMap::new();
        assert_eq!(parse_range_start(&h), None);
        h.insert(header::RANGE, HeaderValue::from_static("bytes=1024-"));
        assert_eq!(parse_range_start(&h), Some(1024));
        h.insert(header::RANGE, HeaderValue::from_static("bytes=0-99"));
        assert_eq!(parse_range_start(&h), None);
        h.insert(header::RANGE, HeaderValue::from_static("items=5-"));
        assert_eq!(parse_range_start(&h), None);
    }

    #[test]
    fn file_name_and_code_validation() {
        assert!(is_safe_name("tutorial.mp4"));
        assert!(is_safe_name("fr.vtt"));
        assert!(!is_safe_name("../secret"));
        assert!(!is_safe_name("a/b.mp4"));
        assert!(!is_safe_name("a\\b.mp4"));
        assert!(!is_safe_name(".hidden"));
        assert!(!is_safe_name("C:evil"));
        assert!(is_safe_code("tagquest"));
        assert!(is_safe_code("go_spot-2"));
        assert!(!is_safe_code("../x"));
        assert!(!is_safe_code(""));
    }

    #[test]
    fn slots_cap_per_peer_and_total() {
        let slots = Slots::new();
        let a1 = try_acquire(&slots, 1).expect("a1");
        let _a2 = try_acquire(&slots, 1).expect("a2");
        assert!(try_acquire(&slots, 1).is_none(), "per-peer cap");
        let _b1 = try_acquire(&slots, 2).expect("b1");
        let _b2 = try_acquire(&slots, 2).expect("b2");
        assert!(try_acquire(&slots, 3).is_none(), "global cap");
        drop(a1);
        assert!(try_acquire(&slots, 3).is_some(), "freed on drop");
    }

    #[test]
    fn one_uploader_per_blob() {
        let slots = Slots::new();
        let l = try_lock_upload(&slots, "abc").expect("first");
        assert!(try_lock_upload(&slots, "abc").is_none());
        assert!(try_lock_upload(&slots, "def").is_some());
        drop(l);
        assert!(try_lock_upload(&slots, "abc").is_some());
    }
}
