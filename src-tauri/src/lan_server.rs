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

use std::collections::{HashMap, HashSet};
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
/// in the next ping body. We don't model "which reader" - the modal just
/// needs the boolean for the row badge.
#[derive(Default)]
pub struct ReaderPresence {
    inner: Mutex<bool>,
}

/// Client-side: the satellite's current screen state, as an opaque JSON string
/// (e.g. `{"kind":"in_game","launched_game_id":42,"game_name":"…"}`). Updated by
/// JS (`services/screenState.ts` → `client_set_screen_state`) whenever the
/// top-most visible layer changes, and read by `client_ping_mother` so the
/// mother sees a fresh screen state in the next ping body. None until the
/// renderer reports one; the mother then stores it on
/// `paired_devices.screen_state_json` so the devices modal can render a
/// "what's it showing" pill per peer.
#[derive(Default)]
pub struct ScreenPresence {
    inner: Mutex<Option<String>>,
}

struct Running {
    port: u16,
    shutdown: oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
    mdns: Option<MdnsHandle>,
    // Kept so the mDNS announcement can be re-registered (e.g. once the hotspot
    // interface comes up) without restarting the whole server.
    mother_uuid: String,
    mdns_label: Option<String>,
    // Mother-failover slice 3: advertised in the mDNS TXT so a re-pointing
    // satellite can match the mother serving ITS client and pick the highest
    // epoch (slice 5/6). epoch = max(mother_epoch) over this client's games at
    // boot; a promotion re-registers mDNS with a higher value.
    client_id: i64,
    epoch: i64,
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

// Best-effort: open the Windows Firewall for our executable so satellites can
// reach the axum server over the hotspot/link-local interface (Windows classes
// it "Public" and blocks custom inbound TCP by default - mDNS multicast is
// allowed, which is why discovery works but the pair request can't connect).
// Requires admin; silently no-ops otherwise. Idempotent (delete-then-add by name).
#[cfg(target_os = "windows")]
fn try_open_firewall() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return,
    };
    let name = "name=TagHunter Playground LAN";
    let _ = std::process::Command::new("netsh")
        .args(["advfirewall", "firewall", "delete", "rule", name])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let _ = std::process::Command::new("netsh")
        .args([
            "advfirewall", "firewall", "add", "rule", name,
            "dir=in", "action=allow", "enable=yes", "profile=any",
            "protocol=TCP", &format!("program={exe}"),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(target_os = "windows"))]
fn try_open_firewall() {}

// Slice 6 sentinel: `mother_start_local_server` returns this (recognizable by
// the TS `ensureMotherServer`) when it stands down because another device is
// already the mother at a higher epoch. Not a real error - a deliberate refusal.
pub const MOTHER_SUPERSEDED: &str = "mother_superseded: another device is the current mother (higher epoch)";

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

    // Bootstrap the mother's self-entry in paired_devices on first start. The
    // mDNS label doubles as the self row's display name (it's the operator's
    // device name - see App.tsx's ensureMotherServer call).
    let self_pair = ensure_self_pair(&conn, mdns_label.clone())
        .await
        .map_err(|e| e.to_string())?;

    // Mother-failover slice 3/6: highest epoch among this client's ACTIVE
    // (non-ended) games (1 when none). Advertised over mDNS so a re-pointing
    // satellite prefers the newest mother. (The boot fence below is presence-
    // based and no longer reads the active-game count.)
    let epoch = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            let epoch: i64 = c.query_row(
                "SELECT COALESCE(MAX(mother_epoch), 1)
                 FROM lg_launched_games WHERE client_id = ? AND ended = 0",
                params![client_id],
                |r| r.get(0),
            )?;
            Ok(epoch)
        })
        .await
        .unwrap_or(1);

    // Unified boot fence (mother/hotspot role rework, E1 "preferred mother"):
    // if ANY other mother of this client is already live, it was here first -
    // stand down and join it rather than starting a second, competing server.
    // The TS boot path then auto-pairs with + routes at the winner.
    //
    // This is deliberately PRESENCE-based, not epoch-based: epoch only orders two
    // mothers claiming the SAME game (the runtime failover-yield poll + re-point
    // still use it for that). At boot, comparing OUR epoch to a mother hosting a
    // DIFFERENT game is meaningless - and that mistake is exactly what let a
    // device with stale local games (migrated from the old "every device hosts"
    // model) wrongly keep hosting instead of deferring to the real mother.
    //
    // Known edge: two willing mothers powered on simultaneously can both see each
    // other and both stand down (→ no mother); recover with the Network-tab
    // "Make this device the mother" button. Operators stagger boots in practice.
    {
        if let Ok(mothers) = run_mdns_discovery(Duration::from_millis(2500)).await {
            let my_uuid = &self_pair.mother_device_uuid;
            let superseded = mothers.iter().any(|m| {
                &m.mother_uuid != my_uuid && m.client_id == Some(client_id)
            });
            if superseded {
                return Err(MOTHER_SUPERSEDED.into());
            }
        }
    }

    let app_state = AppState {
        db: Arc::new(conn),
        media_root: resolve_media_root(&app)?,
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

    // Open the firewall for our exe so satellites can connect (best-effort).
    let _ = tokio::task::spawn_blocking(try_open_firewall).await;

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app_router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    // Register mDNS broadcast (best-effort: failure shouldn't kill the server).
    // No explicit addrs at boot - the hotspot interface doesn't exist yet;
    // mother_refresh_mdns re-announces with it once the hotspot starts.
    let mdns = match start_mdns(&self_pair.mother_device_uuid, mdns_label.as_deref(), actual_port, client_id, epoch, &[]) {
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
        mother_uuid: self_pair.mother_device_uuid.clone(),
        mdns_label,
        client_id,
        epoch,
    });

    Ok(MotherServerInfo {
        port: actual_port,
        bound_addr: actual.to_string(),
        mother_device_uuid: self_pair.mother_device_uuid,
        mother_peer_secret: self_pair.peer_secret,
        mother_peer_id: self_pair.peer_id,
    })
}

// ─── slice 4: become mother (promote this satellite into the new mother) ──────

#[derive(Serialize)]
pub struct BecomeMotherInfo {
    pub port: u16,
    pub bound_addr: String,
    pub mother_device_uuid: String,
    pub mother_peer_secret: String,
    pub mother_peer_id: i64,
    pub epoch: i64,
    pub hotspot_started: bool,
    pub hotspot_error: Option<String>,
}

// Typed rows parsed out of the snapshot JSON *before* the DB transaction so
// shape problems surface as clear errors rather than half-applied writes.
struct PdRow {
    id: i64,
    peer_uuid: String,
    peer_label: String,
    peer_os: Option<String>,
    peer_app_version: Option<String>,
    peer_secret: String,
}
struct GameRow {
    id: i64,
    summary_uuid: String,
    client_id: i64,
    game_uniqid: String,
    name: String,
    number_of_teams: i64,
    game_type: String,
    duration: i64,
    start_time: Option<String>,
    started: bool,
    ended: bool,
    created_at: String,
}
struct MetaRow { meta_name: String, meta_value: Option<String> }
struct DevRow {
    device_id: i64,
    device_label: Option<String>,
    os: Option<String>,
    os_version: Option<String>,
    connected: bool,
}
struct RawRow { id: i64, device_id: i64, raw_data: String, created_at: String }
struct TeamRow {
    id: i64,
    team_number: i64,
    team_name: Option<String>,
    pattern: i64,
    score: i64,
    key_id: Option<i64>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    language: Option<String>,
}
struct CqRow {
    id: i64,
    team_id: i64,
    teammate_chip_id: Option<i64>,
    quest_id: Option<i64>,
    quest_number: String,
    points_awarded: i64,
    created_at: String,
}

fn vi64(v: &Value, k: &str) -> Option<i64> { v.get(k).and_then(|x| x.as_i64()) }
fn vstr(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(|s| s.to_string())
}
fn vbool(v: &Value, k: &str) -> bool { v.get(k).and_then(|x| x.as_bool()).unwrap_or(false) }
fn req_i64(v: &Value, k: &str) -> Result<i64, String> {
    vi64(v, k).ok_or_else(|| format!("snapshot row missing integer field '{k}'"))
}
fn req_str(v: &Value, k: &str) -> Result<String, String> {
    vstr(v, k).ok_or_else(|| format!("snapshot row missing string field '{k}'"))
}

/// Promote THIS device (a satellite holding a cached snapshot) into the new
/// mother for `launched_game_id`. Adopts the snapshot's game state + pairing
/// table, bumps the epoch, starts the local server + mDNS, and best-effort
/// raises the same-named hotspot. See plans/mother-failover-promote-any-device.md.
///
/// Identity reconciliation (the careful bit): the snapshot's `paired_devices`
/// has the OLD mother as `is_self=1`. This device is one of the *non-self* rows,
/// keyed by its `client_device_uuid` (the uuid it paired to the old mother
/// with). On adopt we rebuild the pairing table preserving every `id` (so the
/// game's `device_id` references stay valid), then mark OUR row `is_self=1` and
/// everyone else `is_self=0`. The advertised mother uuid becomes our
/// `client_device_uuid`, keeping the "self row peer_uuid == mother uuid"
/// convention `ensure_self_pair` relies on.
#[tauri::command]
pub async fn become_mother(
    app: AppHandle,
    state: tauri::State<'_, MotherServerState>,
    launched_game_id: i64,
    port: u16,
    mdns_label: Option<String>,
) -> Result<BecomeMotherInfo, String> {
    // Every device runs its OWN idle local server from boot (ensureMotherServer),
    // so "already running" is the normal case, not an error - stop it before we
    // adopt the game and start the replacement. Take it out under the lock, then
    // shut it down without holding the lock (the join await would otherwise
    // block other server-state callers).
    let existing = { state.inner.lock().await.take() };
    if let Some(running) = existing {
        if let Some(m) = running.mdns {
            let _ = m.daemon.unregister(&m.full_name);
            let _ = m.daemon.shutdown();
        }
        let _ = running.shutdown.send(());
        let _ = running.join.await;
    }

    let db_path = resolve_db_path(&app)?;
    let conn = DbConnection::open(db_path.clone())
        .await
        .map_err(|e| format!("open sqlite ({}): {e}", db_path.display()))?;
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        c.pragma_update(None, "foreign_keys", "ON")?;
        let _: String = c.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        c.pragma_update(None, "busy_timeout", 5000)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("pragma setup: {e}"))?;

    // 1. Load the cached snapshot for this game.
    let snap_json: Option<String> = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
            Ok(c.query_row(
                "SELECT snapshot_json FROM mother_snapshots WHERE launched_game_id = ?",
                params![launched_game_id],
                |r| r.get(0),
            )
            .optional()?)
        })
        .await
        .map_err(|e| e.to_string())?;
    let Some(snap_json) = snap_json else {
        return Err("No cached snapshot for this game on this device - it can't be promoted. Pick a device that was in the game.".into());
    };
    let snap: Value = serde_json::from_str(&snap_json)
        .map_err(|e| format!("cached snapshot is corrupt: {e}"))?;

    // 2. Parse + validate everything up front.
    let game_v = snap.get("game").ok_or("snapshot missing 'game'")?;
    let game = GameRow {
        id: req_i64(game_v, "id")?,
        summary_uuid: req_str(game_v, "summary_uuid")?,
        client_id: req_i64(game_v, "client_id")?,
        game_uniqid: req_str(game_v, "game_uniqid")?,
        name: req_str(game_v, "name")?,
        number_of_teams: vi64(game_v, "number_of_teams").unwrap_or(0),
        game_type: req_str(game_v, "game_type")?,
        duration: vi64(game_v, "duration").unwrap_or(0),
        start_time: vstr(game_v, "start_time"),
        started: vbool(game_v, "started"),
        ended: vbool(game_v, "ended"),
        created_at: vstr(game_v, "created_at").unwrap_or_default(),
    };
    let old_epoch = vi64(&snap, "mother_epoch").unwrap_or(1);
    let new_epoch = old_epoch + 1;

    let arr = |k: &str| snap.get(k).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut pds = Vec::new();
    for v in arr("paired_devices") {
        pds.push(PdRow {
            id: req_i64(&v, "id")?,
            peer_uuid: req_str(&v, "peer_uuid")?,
            peer_label: vstr(&v, "peer_label").unwrap_or_else(|| "device".into()),
            peer_os: vstr(&v, "peer_os"),
            peer_app_version: vstr(&v, "peer_app_version"),
            peer_secret: req_str(&v, "peer_secret")?,
        });
    }
    let meta: Vec<MetaRow> = arr("meta")
        .iter()
        .map(|v| MetaRow { meta_name: vstr(v, "meta_name").unwrap_or_default(), meta_value: vstr(v, "meta_value") })
        .collect();
    let devices: Vec<DevRow> = arr("devices")
        .iter()
        .filter_map(|v| Some(DevRow {
            device_id: vi64(v, "device_id")?,
            device_label: vstr(v, "device_label"),
            os: vstr(v, "os"),
            os_version: vstr(v, "os_version"),
            connected: vbool(v, "connected"),
        }))
        .collect();
    let mut raw_data = Vec::new();
    for v in arr("raw_data") {
        raw_data.push(RawRow {
            id: req_i64(&v, "id")?,
            device_id: req_i64(&v, "device_id")?,
            raw_data: req_str(&v, "raw_data")?,
            created_at: vstr(&v, "created_at").unwrap_or_default(),
        });
    }
    let mut teams = Vec::new();
    for v in arr("teams") {
        teams.push(TeamRow {
            id: req_i64(&v, "id")?,
            team_number: vi64(&v, "team_number").unwrap_or(0),
            team_name: vstr(&v, "team_name"),
            pattern: vi64(&v, "pattern").unwrap_or(0),
            score: vi64(&v, "score").unwrap_or(0),
            key_id: vi64(&v, "key_id"),
            start_time: vi64(&v, "start_time"),
            end_time: vi64(&v, "end_time"),
            language: vstr(&v, "language"),
        });
    }
    let mut cqs = Vec::new();
    for v in arr("completed_quests") {
        cqs.push(CqRow {
            id: req_i64(&v, "id")?,
            team_id: req_i64(&v, "team_id")?,
            teammate_chip_id: vi64(&v, "teammate_chip_id"),
            quest_id: vi64(&v, "quest_id"),
            quest_number: vstr(&v, "quest_number").unwrap_or_default(),
            points_awarded: vi64(&v, "points_awarded").unwrap_or(0),
            created_at: vstr(&v, "created_at").unwrap_or_default(),
        });
    }

    // 3. Content guard - refuse if this device hasn't synced the scenario.
    let game_uniqid_for_guard = game.game_uniqid.clone();
    let has_content: bool = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
            Ok(c.query_row(
                "SELECT 1 FROM scenarios WHERE uniqid = ? AND local_version IS NOT NULL",
                params![game_uniqid_for_guard],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false))
        })
        .await
        .map_err(|e| e.to_string())?;
    if !has_content {
        return Err(format!(
            "This device hasn't downloaded the scenario \"{}\" - sync it before promoting this device to mother.",
            game.game_uniqid
        ));
    }

    // 4. This device's satellite identity (uuid it paired to the old mother with).
    let client_device_uuid: String = conn
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<String> {
            let existing: Option<String> = c
                .query_row(
                    "SELECT value FROM schema_meta WHERE key = 'client_device_uuid'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(match existing {
                Some(s) => s,
                None => {
                    let new = uuid::Uuid::new_v4().to_string();
                    c.execute(
                        "INSERT INTO schema_meta(key, value) VALUES ('client_device_uuid', ?)",
                        params![new],
                    )?;
                    new
                }
            })
        })
        .await
        .map_err(|e| e.to_string())?;

    // 5. Adopt in one transaction → returns (self_peer_id, self_peer_secret).
    let mother_uuid = client_device_uuid.clone();
    let self_uuid = client_device_uuid.clone();
    let new_self_secret = random_token(32);
    let game_id = game.id;
    let adopt_label = mdns_label.clone();
    let (self_peer_id, self_peer_secret) = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(i64, String)> {
            let tx = c.transaction()?;

            // 5a. Rebuild the pairing table from the snapshot, preserving ids.
            tx.execute("DELETE FROM paired_devices", [])?;
            let mut self_found: Option<(i64, String)> = None;
            for pd in &pds {
                let is_self = if pd.peer_uuid == self_uuid { 1 } else { 0 };
                tx.execute(
                    "INSERT INTO paired_devices
                       (id, peer_uuid, peer_label, peer_os, peer_app_version, peer_secret, is_self)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![pd.id, pd.peer_uuid, pd.peer_label, pd.peer_os, pd.peer_app_version, pd.peer_secret, is_self],
                )?;
                if is_self == 1 {
                    self_found = Some((pd.id, pd.peer_secret.clone()));
                }
            }
            // If this device wasn't a player in the snapshot, add a self row.
            let (self_id, self_secret) = match self_found {
                Some(t) => t,
                None => {
                    tx.execute(
                        "INSERT INTO paired_devices
                           (peer_uuid, peer_label, peer_os, peer_app_version, peer_secret, is_self)
                         VALUES (?1, ?2, NULL, NULL, ?3, 1)",
                        params![
                            self_uuid,
                            adopt_label.as_deref().unwrap_or(SELF_PLACEHOLDER_LABEL),
                            new_self_secret
                        ],
                    )?;
                    (tx.last_insert_rowid(), new_self_secret.clone())
                }
            };

            // 5b. Replace this game's rows (cascade clears any stale children first).
            tx.execute("DELETE FROM lg_launched_games WHERE id = ?", params![game_id])?;
            tx.execute(
                "INSERT INTO lg_launched_games
                   (id, summary_uuid, client_id, game_uniqid, name, number_of_teams,
                    game_type, duration, start_time, started, ended, mother_epoch, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,
                         COALESCE(NULLIF(?13,''), CURRENT_TIMESTAMP))",
                params![
                    game.id, game.summary_uuid, game.client_id, game.game_uniqid, game.name,
                    game.number_of_teams, game.game_type, game.duration, game.start_time,
                    game.started as i64, game.ended as i64, new_epoch, game.created_at
                ],
            )?;
            for m in &meta {
                tx.execute(
                    "INSERT INTO lg_launched_game_meta (launched_game_id, meta_name, meta_value)
                     VALUES (?1, ?2, ?3)",
                    params![game_id, m.meta_name, m.meta_value],
                )?;
            }
            for d in &devices {
                tx.execute(
                    "INSERT INTO lg_launched_game_devices
                       (launched_game_id, device_id, device_label, os, os_version, connected)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![game_id, d.device_id, d.device_label, d.os, d.os_version, d.connected as i64],
                )?;
            }
            for r in &raw_data {
                tx.execute(
                    "INSERT INTO lg_launched_game_raw_data
                       (id, launched_game_id, device_id, raw_data, created_at)
                     VALUES (?1, ?2, ?3, ?4, COALESCE(NULLIF(?5,''), CURRENT_TIMESTAMP))",
                    params![r.id, game_id, r.device_id, r.raw_data, r.created_at],
                )?;
            }
            for t in &teams {
                tx.execute(
                    "INSERT INTO lg_teams
                       (id, launched_game_id, team_number, team_name, pattern, score,
                        key_id, start_time, end_time)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![t.id, game_id, t.team_number, t.team_name, t.pattern, t.score, t.key_id, t.start_time, t.end_time],
                )?;
            }
            for q in &cqs {
                tx.execute(
                    "INSERT INTO lg_team_completed_quests
                       (id, launched_game_id, team_id, teammate_chip_id, quest_id,
                        quest_number, points_awarded, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(NULLIF(?8,''), CURRENT_TIMESTAMP))",
                    params![q.id, game_id, q.team_id, q.teammate_chip_id, q.quest_id, q.quest_number, q.points_awarded, q.created_at],
                )?;
            }

            // 5c. Our mother identity == our client_device_uuid (keeps the
            // self-row peer_uuid == mother_uuid convention).
            tx.execute(
                "INSERT INTO schema_meta(key, value) VALUES ('mother_device_uuid', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![self_uuid],
            )?;
            // With the identity keys settled, collapse any leftover rows for
            // OUR previous identity and drop self-referential mother links
            // (see heal_self_identity).
            heal_self_identity(&tx, self_id)?;
            // Keep the language column on teams in sync (separate UPDATE so the
            // INSERT column list stays aligned with the base schema).
            for t in &teams {
                if let Some(lang) = &t.language {
                    tx.execute("UPDATE lg_teams SET language = ?1 WHERE id = ?2", params![lang, t.id])?;
                }
            }

            tx.commit()?;
            Ok((self_id, self_secret))
        })
        .await
        .map_err(|e| format!("adopt snapshot: {e}"))?;

    // 6. Build state + serve + mDNS (epoch bumped so fencing prefers us).
    let app_state = AppState {
        db: Arc::new(conn),
        media_root: resolve_media_root(&app)?,
        client_id: game.client_id,
        mother_uuid: mother_uuid.clone(),
        self_peer_id,
        last_bump: Arc::new(Mutex::new(HashMap::new())),
    };
    let app_router = build_router(app_state);
    let listener = TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .map_err(|e| format!("bind 0.0.0.0:{port}: {e}"))?;
    let actual = listener.local_addr().map_err(|e| format!("local_addr: {e}"))?;
    let actual_port = actual.port();
    let _ = tokio::task::spawn_blocking(try_open_firewall).await;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app_router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    let mdns = match start_mdns(&mother_uuid, mdns_label.as_deref(), actual_port, game.client_id, new_epoch, &[]) {
        Ok(h) => Some(h),
        Err(e) => {
            eprintln!("[lan_server] become_mother mDNS start failed: {e} (continuing)");
            None
        }
    };
    {
        let mut guard = state.inner.lock().await;
        *guard = Some(Running {
            port: actual_port,
            shutdown: shutdown_tx,
            join,
            mdns,
            mother_uuid: mother_uuid.clone(),
            mdns_label,
            client_id: game.client_id,
            epoch: new_epoch,
        });
    }

    // 7. Best-effort: raise the same-named hotspot the old mother was running,
    // then re-announce mDNS on the AP subnet so satellites can resolve us.
    let mut hotspot_started = false;
    let mut hotspot_error: Option<String> = None;
    let wifi = snap.get("wifi");
    let ssid = wifi.and_then(|w| vstr(w, "ssid"));
    let password = wifi.and_then(|w| vstr(w, "password"));
    let source = wifi.and_then(|w| vstr(w, "source")).unwrap_or_default();
    if source == "hotspot" {
        if let (Some(ssid), Some(password)) = (ssid, password) {
            match crate::hotspot::mother_start_hotspot(ssid, password).await {
                Ok(info) => {
                    hotspot_started = true;
                    // Re-register mDNS with the AP IPv4s so clients resolve us.
                    let mut guard = state.inner.lock().await;
                    if let Some(running) = guard.as_mut() {
                        let addrs: Vec<String> = info
                            .ipv4_addresses
                            .into_iter()
                            .filter(|a| a != "127.0.0.1")
                            .collect();
                        if let Some(old) = running.mdns.take() {
                            let _ = old.daemon.unregister(&old.full_name);
                            let _ = old.daemon.shutdown();
                        }
                        running.mdns = start_mdns(
                            &running.mother_uuid,
                            running.mdns_label.as_deref(),
                            running.port,
                            running.client_id,
                            running.epoch,
                            &addrs,
                        )
                        .ok();
                    }
                }
                Err(e) => {
                    hotspot_error = Some(e);
                }
            }
        }
    }

    Ok(BecomeMotherInfo {
        port: actual_port,
        bound_addr: actual.to_string(),
        mother_device_uuid: mother_uuid,
        mother_peer_secret: self_peer_secret,
        mother_peer_id: self_peer_id,
        epoch: new_epoch,
        hotspot_started,
        hotspot_error,
    })
}

#[derive(Serialize)]
pub struct TakeoverTarget {
    pub launched_game_id: i64,
    pub game_name: String,
    pub addr: String,
    pub port: u16,
    pub mother_uuid: String,
    pub epoch: i64,
}

/// The secret this device should present when talking to the CURRENT mother of
/// its game. Prefers a pairing secret from `paired_mothers` (the mother adopted
/// our row, so it honours this) and falls back to our own `is_self` secret
/// (honoured when WE were the mother the live one was promoted from). None if
/// neither exists.
async fn best_outbound_secret(conn: &DbConnection) -> Option<String> {
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
        let paired: Option<String> = c
            .query_row(
                "SELECT peer_secret FROM paired_mothers ORDER BY last_seen_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if paired.is_some() {
            return Ok(paired);
        }
        Ok(c.query_row(
            "SELECT peer_secret FROM paired_devices WHERE is_self = 1 LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
    })
    .await
    .ok()
    .flatten()
}

/// "Regain control" detection. Returns the live mother to take over from, if
/// any. Works whether or not THIS device has a local copy of the game:
///  - browse mDNS for a DIFFERENT mother of this client at a HIGHER epoch than
///    our own (our local active game's epoch, or 0 if we have none);
///  - resolve the game id+name from our own local row if we have one, otherwise
///    ask that mother (`list_active`) using our best outbound secret.
/// None when there's no higher-epoch mother, or we can't see/authenticate to it.
#[tauri::command]
pub async fn get_takeover_target(
    app: AppHandle,
    client_id: i64,
) -> Result<Option<TakeoverTarget>, String> {
    let conn = open_db_for_command(&app).await?;
    let local: Option<(i64, String, i64)> = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<(i64, String, i64)>> {
            Ok(c.query_row(
                "SELECT id, name, mother_epoch FROM lg_launched_games
                 WHERE client_id = ? AND ended = 0
                 ORDER BY mother_epoch DESC LIMIT 1",
                params![client_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?)
        })
        .await
        .map_err(|e| e.to_string())?;
    let my_epoch = local.as_ref().map(|(_, _, e)| *e).unwrap_or(0);

    let self_uuid: Option<String> = conn
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
            Ok(c.query_row(
                "SELECT value FROM schema_meta WHERE key = 'mother_device_uuid'",
                [],
                |r| r.get(0),
            )
            .optional()?)
        })
        .await
        .ok()
        .flatten();

    let mothers = run_mdns_discovery(Duration::from_millis(2000)).await.unwrap_or_default();
    let best = mothers
        .into_iter()
        .filter(|m| m.client_id == Some(client_id))
        .filter(|m| self_uuid.as_deref() != Some(m.mother_uuid.as_str()))
        .filter(|m| m.epoch.map_or(false, |e| e > my_epoch))
        .max_by_key(|m| m.epoch.unwrap_or(0));
    let Some(m) = best else { return Ok(None) };
    let Some(addr) = select_address(&m.addresses) else { return Ok(None) };

    // Game id+name: our local row (same id, preserved through adoption) if we
    // have one, else ask the live mother.
    let (gid, name) = match local {
        Some((id, nm, _)) => (id, nm),
        None => {
            let Some(secret) = best_outbound_secret(&conn).await else { return Ok(None) };
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .connect_timeout(Duration::from_millis(1500))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client
                .get(format!("http://{addr}:{}/launched_games.php?action=list_active", m.port))
                .header(header::AUTHORIZATION, format!("Bearer {secret}"))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Ok(None);
            }
            let body: Value = resp.json().await.map_err(|e| e.to_string())?;
            let g = body.get("games").and_then(|v| v.as_array()).and_then(|a| a.first());
            match g {
                Some(g) => (
                    g.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                    g.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                ),
                None => return Ok(None),
            }
        }
    };
    if gid == 0 {
        return Ok(None);
    }

    Ok(Some(TakeoverTarget {
        launched_game_id: gid,
        game_name: name,
        addr,
        port: m.port,
        mother_uuid: m.mother_uuid,
        epoch: m.epoch.unwrap_or(0),
    }))
}

/// This device's own peer_secret (the `is_self=1` row). A device that was a
/// mother can use it to authenticate to a NEW mother that adopted its pairing
/// table - e.g. when yielding after being superseded. None if no self row yet.
#[tauri::command]
pub async fn get_self_peer_secret(app: AppHandle) -> Result<Option<String>, String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
        Ok(c.query_row(
            "SELECT peer_secret FROM paired_devices WHERE is_self = 1 LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Pull the CURRENT snapshot of `launched_game_id` from the live mother at
/// `addr:port` and cache it locally (so a subsequent `become_mother` adopts the
/// up-to-date state, not this device's stale copy). Authenticates with THIS
/// device's own self peer_secret, which the live mother honours because it
/// adopted our row into its pairing table. Returns true if a snapshot landed.
#[tauri::command]
pub async fn fetch_snapshot_from_mother(
    app: AppHandle,
    launched_game_id: i64,
    addr: String,
    port: u16,
) -> Result<bool, String> {
    let conn = open_db_for_command(&app).await?;
    let Some(secret) = best_outbound_secret(&conn).await else {
        return Err("this device has no credentials to authenticate with the current mother".into());
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("http://{addr}:{port}/ping.php"))
        .header(header::AUTHORIZATION, format!("Bearer {secret}"))
        .json(&json!({ "launched_game_id": launched_game_id, "known_version": -1 }))
        .send()
        .await
        .map_err(|e| format!("contacting current mother: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("current mother returned HTTP {}", resp.status().as_u16()));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let Some(snap) = body.get("snapshot").filter(|v| v.is_object()) else {
        return Ok(false);
    };
    let gid = snap.get("game").and_then(|g| g.get("id")).and_then(|v| v.as_i64());
    let ver = snap.get("state_version").and_then(|v| v.as_i64());
    let epoch = snap.get("mother_epoch").and_then(|v| v.as_i64()).unwrap_or(1);
    let (Some(gid), Some(ver)) = (gid, ver) else { return Ok(false) };
    let snap_json = snap.to_string();
    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        c.execute(
            "INSERT INTO mother_snapshots
               (launched_game_id, state_version, mother_epoch, snapshot_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
             ON CONFLICT(launched_game_id) DO UPDATE SET
               state_version = excluded.state_version,
               mother_epoch  = excluded.mother_epoch,
               snapshot_json = excluded.snapshot_json,
               updated_at    = excluded.updated_at
             WHERE excluded.state_version > mother_snapshots.state_version",
            params![gid, ver, epoch, snap_json],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Re-announce the mother over mDNS, advertising `addresses` explicitly (plus
/// auto-detected interfaces). Call this after the hotspot starts so clients
/// resolve the hotspot's AP-subnet IPv4 instead of only the stale link-local /
/// APIPA addresses captured when the server first booted. No-op if the server
/// isn't running.
#[tauri::command]
pub async fn mother_refresh_mdns(
    state: tauri::State<'_, MotherServerState>,
    addresses: Vec<String>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    let running = match guard.as_mut() {
        Some(r) => r,
        None => return Ok(()),
    };
    // Drop loopback; keep usable LAN/link-local addrs (the client picks the
    // reachable one). Tear down the old announcement before re-registering.
    let addrs: Vec<String> = addresses
        .into_iter()
        .filter(|a| a != "127.0.0.1" && a != "::1")
        .collect();
    if let Some(old) = running.mdns.take() {
        let _ = old.daemon.unregister(&old.full_name);
        let _ = old.daemon.shutdown();
    }
    match start_mdns(&running.mother_uuid, running.mdns_label.as_deref(), running.port, running.client_id, running.epoch, &addrs) {
        Ok(h) => {
            running.mdns = Some(h);
            Ok(())
        }
        Err(e) => Err(e),
    }
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

/// Returns the running server's full info (port + self peer_secret + mother_uuid),
/// or None when the server isn't running. Lets the renderer pick up an already-
/// running server across React re-mounts without restarting it (and without
/// caching the secret in JS).
#[tauri::command]
pub async fn mother_get_server_info(
    app: AppHandle,
    state: tauri::State<'_, MotherServerState>,
) -> Result<Option<MotherServerInfo>, String> {
    let port = {
        let guard = state.inner.lock().await;
        match &*guard {
            Some(r) => r.port,
            None => return Ok(None),
        }
    };
    // Read self peer fields from the local DB. Cheaper than a heap-cached
    // copy and keeps a single source of truth (the paired_devices row).
    let db_path = resolve_db_path(&app)?;
    let conn = DbConnection::open(db_path.clone())
        .await
        .map_err(|e| format!("open sqlite ({}): {e}", db_path.display()))?;
    let info = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<MotherServerInfo> {
            let mother_uuid: String = c.query_row(
                "SELECT value FROM schema_meta WHERE key = 'mother_device_uuid'",
                [],
                |r| r.get(0),
            )?;
            let (peer_id, peer_secret) = c.query_row(
                "SELECT id, peer_secret FROM paired_devices
                  WHERE peer_uuid = ? AND is_self = 1",
                params![mother_uuid],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )?;
            Ok(MotherServerInfo {
                port,
                bound_addr: format!("127.0.0.1:{port}"),
                mother_device_uuid: mother_uuid,
                mother_peer_secret: peer_secret,
                mother_peer_id: peer_id,
            })
        })
        .await
        .map_err(|e| format!("read self peer: {e}"))?;
    Ok(Some(info))
}

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("playground.db"))
}

fn resolve_media_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("media"))
}

// ─── self-pair bootstrap ─────────────────────────────────────────────────────

struct SelfPair {
    mother_device_uuid: String,
    peer_secret: String,
    peer_id: i64,
}

async fn ensure_self_pair(
    conn: &DbConnection,
    device_label: Option<String>,
) -> tokio_rusqlite::Result<SelfPair> {
    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<SelfPair> {
        let tx = c.transaction()?;
        // Read or initialize mother_device_uuid in schema_meta.
        let mother_uuid: String = match tx
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
                tx.execute(
                    "INSERT INTO schema_meta(key, value) VALUES ('mother_device_uuid', ?)",
                    params![new],
                )?;
                new
            }
        };

        // Find or create the self paired_devices entry.
        let existing: Option<(i64, String)> = tx
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
                tx.execute(
                    "INSERT INTO paired_devices
                       (peer_uuid, peer_label, peer_os, peer_app_version, peer_secret, is_self)
                     VALUES (?, ?, NULL, NULL, ?, 1)",
                    params![
                        mother_uuid,
                        device_label.as_deref().unwrap_or(SELF_PLACEHOLDER_LABEL),
                        secret
                    ],
                )?;
                (tx.last_insert_rowid(), secret)
            }
        };

        // Keep the self row named after the operator's device name so other
        // surfaces (network tab, snapshots shipped to satellites) show a real
        // name instead of the '__mother_self__' placeholder.
        if let Some(label) = device_label.as_deref() {
            if !label.trim().is_empty() {
                tx.execute(
                    "UPDATE paired_devices SET peer_label = ? WHERE id = ?",
                    params![label, peer_id],
                )?;
            }
        }

        heal_self_identity(&tx, peer_id)?;
        tx.commit()?;

        Ok(SelfPair {
            mother_device_uuid: mother_uuid,
            peer_secret,
            peer_id,
        })
    })
    .await
}

/// Placeholder label the self row is created with before the operator's device
/// name is known. Only ever written to `is_self = 1` rows; seeing it on a
/// non-self row means identity drift (see `heal_self_identity`).
const SELF_PLACEHOLDER_LABEL: &str = "__mother_self__";

/// Repair self-identity drift in the pairing tables (idempotent; runs at every
/// server start and after snapshot adoption). A device that re-keyed its
/// identity - mother/hotspot role rework, `become_mother` snapshot adoption -
/// can leave behind:
///
///  1. a stale `paired_devices` row for its OWN previous identity, which then
///     shows up in every device list as a phantom "__mother_self__" peer that
///     is somehow online (the app's own client stack keeps authenticating with
///     the old row's secret), and
///  2. a `paired_mothers` row pointing at ITSELF, which makes childControlLink
///     route this mother's launched_games traffic at itself through the
///     satellite path with that stale secret - so the device even registers
///     its game participation under the phantom row instead of its self row.
///
/// A stale own-identity row is recognized either by carrying one of our own
/// uuids while not being the self row, or by holding the peer_secret of a
/// paired_mothers self-link (we only ever store a secret for a mother we pair
/// WITH, so a secret that lives in a self-link identifies our own row). Rows
/// merely labeled with the placeholder are NOT touched - after a real failover
/// the old mother's row legitimately carries it until that device re-pairs.
fn heal_self_identity(c: &rusqlite::Connection, self_id: i64) -> rusqlite::Result<()> {
    let stale_ids: Vec<i64> = {
        let mut stmt = c.prepare(
            "SELECT pd.id
               FROM paired_devices pd
              WHERE pd.is_self = 0
                AND pd.id <> ?1
                AND (pd.peer_uuid IN (SELECT value FROM schema_meta
                                       WHERE key IN ('mother_device_uuid','client_device_uuid'))
                     OR pd.peer_secret IN (SELECT pm.peer_secret FROM paired_mothers pm
                                            WHERE pm.mother_uuid IN
                                              (SELECT value FROM schema_meta
                                                WHERE key IN ('mother_device_uuid','client_device_uuid'))))",
        )?;
        let rows = stmt.query_map(params![self_id], |r| r.get::<_, i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for ghost in stale_ids {
        // Adopt the ghost's reader fact - it was the row our own pings updated.
        c.execute(
            "UPDATE paired_devices SET
                 has_reader = MAX(has_reader,
                     COALESCE((SELECT has_reader FROM paired_devices WHERE id = ?1), 0))
             WHERE id = ?2",
            params![ghost, self_id],
        )?;
        // Re-key game participation, punch history and queued commands to the
        // canonical self row (UNIQUE(launched_game_id, device_id) duplicates -
        // both identities registered in the same game - keep the self row's).
        c.execute(
            "UPDATE OR IGNORE lg_launched_game_devices SET device_id = ?2 WHERE device_id = ?1",
            params![ghost, self_id],
        )?;
        c.execute(
            "DELETE FROM lg_launched_game_devices WHERE device_id = ?1",
            params![ghost],
        )?;
        c.execute(
            "UPDATE lg_launched_game_raw_data SET device_id = ?2 WHERE device_id = ?1",
            params![ghost, self_id],
        )?;
        c.execute(
            "UPDATE pending_commands SET target_device_id = ?2 WHERE target_device_id = ?1",
            params![ghost, self_id],
        )?;
        c.execute("DELETE FROM paired_devices WHERE id = ?1", params![ghost])?;
    }

    // Drop "I am my own mother" links: the hosting mother routes launched_games
    // at its own server with its self secret, never through the satellite path.
    c.execute(
        "DELETE FROM paired_mothers WHERE mother_uuid IN
            (SELECT value FROM schema_meta WHERE key IN ('mother_device_uuid','client_device_uuid'))",
        [],
    )?;
    Ok(())
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
    /// `<app_data_dir>/media` - where synced content lives. Used by add_team to
    /// read the team-name pools JSON (media/name_pools/team_names.json).
    media_root: PathBuf,
    client_id: i64,
    /// Stable identity of this mother device. Returned by /ping.php so the
    /// child can verify it's still talking to the same machine it paired with.
    mother_uuid: String,
    /// `paired_devices.id` of the mother's own self-row. Cached here so the
    /// authorization check on queue_command (only self may push commands) is
    /// a single integer comparison instead of a SQL roundtrip per call.
    self_peer_id: i64,
    /// Debounce map for `bump_presence` - peer_id → last write Instant. The
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
    bump_presence(state, id, None, None).await;
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
/// cadence). Failures are swallowed - presence is observability, not the
/// critical path.
async fn bump_presence(
    state: &AppState,
    peer_id: i64,
    has_reader: Option<bool>,
    screen_state: Option<String>,
) {
    {
        let mut guard = state.last_bump.lock().await;
        let now = Instant::now();
        // If we have neither reader news NOR a screen-state report AND we bumped
        // recently, skip the write. A reader-status or screen-state report always
        // writes through so a freshly-opened ranking / plugged reader surfaces
        // promptly even if the last bump was <5s ago. (The /ping.php path always
        // carries a screen_state once the satellite has reported one, so the
        // change-triggered out-of-band ping is never debounced away.)
        if has_reader.is_none() && screen_state.is_none() {
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
                            END,
                            screen_state_json = COALESCE(?2, screen_state_json)
                      WHERE id = ?3",
                    params![has_reader_i64, screen_state, peer_id],
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

/// Monotonic per-mother game-state counter (schema_meta `lg_state_version`).
/// Bumped after every successful *mutating* `launched_games` action so the
/// `/ping.php` snapshot delivery (slice 1) can cheaply tell whether a
/// satellite's cached copy is stale without diffing rows. Returns the new
/// value (best-effort; never panics). Behavior-neutral until slice 1 reads it.
async fn bump_state_version(state: &AppState) -> i64 {
    state
        .db
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            c.execute(
                "INSERT INTO schema_meta(key, value) VALUES('lg_state_version', '1')
                 ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
                [],
            )?;
            let v: String = c.query_row(
                "SELECT value FROM schema_meta WHERE key = 'lg_state_version'",
                [],
                |r| r.get(0),
            )?;
            Ok(v.parse::<i64>().unwrap_or(0))
        })
        .await
        .unwrap_or(0)
}

/// Mutating POST actions bump `lg_state_version`; the command-channel and
/// cloud-bookkeeping POSTs are excluded so a video/join push or a summary
/// ack doesn't trigger a needless snapshot re-send.
fn action_mutates_game_state(method: &str, action: &str) -> bool {
    method == "POST"
        && !matches!(
            action,
            "queue_command"
                | "queue_command_bulk"
                | "ack_command"
                | "sync_summaries"
                | "mark_summaries_pushed"
        )
}

/// Current value of the monotonic `lg_state_version` counter (0 if unset).
async fn read_state_version(state: &AppState) -> i64 {
    state
        .db
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            let v: Option<String> = c
                .query_row(
                    "SELECT value FROM schema_meta WHERE key = 'lg_state_version'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(v.and_then(|s| s.parse::<i64>().ok()).unwrap_or(0))
        })
        .await
        .unwrap_or(0)
}

/// Full promotable snapshot of one launched game - everything a fresh device
/// needs to become the new mother for it (slice 4 consumes this): the game
/// header + meta + devices + all raw_data/teams/completed_quests, the
/// `paired_devices` table (peer secrets, so satellites keep authenticating to
/// the new mother), the mother's Wi-Fi creds (so the new mother raises the
/// same-named AP), plus `state_version` + `mother_epoch` for staleness +
/// fencing. Returns None if the game id is unknown.
///
/// NOTE: clash_* tables are not yet captured here - a clash game would restore
/// without its territory/validation rows. Tracked as a slice-1 follow-up.
async fn build_snapshot(state: &AppState, game_id: i64, state_version: i64) -> Option<Value> {
    let wifi = read_mother_wifi(state).await;
    let mother_uuid = state.mother_uuid.clone();
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<Value>> {
            let game: Option<Value> = c
                .query_row(
                    "SELECT id, summary_uuid, client_id, game_uniqid, name, number_of_teams,
                            game_type, duration, start_time, started, ended, mother_epoch, created_at
                     FROM lg_launched_games WHERE id = ?",
                    params![game_id],
                    |r| {
                        Ok(json!({
                            "id": r.get::<_, i64>(0)?,
                            "summary_uuid": r.get::<_, String>(1)?,
                            "client_id": r.get::<_, i64>(2)?,
                            "game_uniqid": r.get::<_, String>(3)?,
                            "name": r.get::<_, String>(4)?,
                            "number_of_teams": r.get::<_, i64>(5)?,
                            "game_type": r.get::<_, String>(6)?,
                            "duration": r.get::<_, i64>(7)?,
                            "start_time": r.get::<_, Option<String>>(8)?,
                            "started": r.get::<_, i64>(9)? != 0,
                            "ended": r.get::<_, i64>(10)? != 0,
                            "mother_epoch": r.get::<_, i64>(11)?,
                            "created_at": r.get::<_, String>(12)?,
                        }))
                    },
                )
                .optional()?;
            let Some(game) = game else { return Ok(None) };
            let epoch = game.get("mother_epoch").and_then(|v| v.as_i64()).unwrap_or(1);

            let meta: Vec<Value> = c
                .prepare(
                    "SELECT meta_name, meta_value FROM lg_launched_game_meta
                     WHERE launched_game_id = ?",
                )?
                .query_map(params![game_id], |r| {
                    Ok(json!({
                        "meta_name": r.get::<_, String>(0)?,
                        "meta_value": r.get::<_, Option<String>>(1)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let devices: Vec<Value> = c
                .prepare(
                    "SELECT device_id, device_label, os, os_version, connected
                     FROM lg_launched_game_devices WHERE launched_game_id = ?",
                )?
                .query_map(params![game_id], |r| {
                    Ok(json!({
                        "device_id": r.get::<_, i64>(0)?,
                        "device_label": r.get::<_, Option<String>>(1)?,
                        "os": r.get::<_, Option<String>>(2)?,
                        "os_version": r.get::<_, Option<String>>(3)?,
                        "connected": r.get::<_, i64>(4)? != 0,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let raw_data: Vec<Value> = c
                .prepare(
                    "SELECT id, device_id, raw_data, created_at
                     FROM lg_launched_game_raw_data
                     WHERE launched_game_id = ? ORDER BY id ASC",
                )?
                .query_map(params![game_id], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "device_id": r.get::<_, i64>(1)?,
                        "raw_data": r.get::<_, String>(2)?,
                        "created_at": r.get::<_, String>(3)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let teams: Vec<Value> = c
                .prepare(
                    "SELECT id, team_number, team_name, pattern, score, key_id,
                            start_time, end_time, language
                     FROM lg_teams WHERE launched_game_id = ? ORDER BY team_number ASC",
                )?
                .query_map(params![game_id], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "team_number": r.get::<_, i64>(1)?,
                        "team_name": r.get::<_, Option<String>>(2)?,
                        "pattern": r.get::<_, i64>(3)?,
                        "score": r.get::<_, i64>(4)?,
                        "key_id": r.get::<_, Option<i64>>(5)?,
                        "start_time": r.get::<_, Option<i64>>(6)?,
                        "end_time": r.get::<_, Option<i64>>(7)?,
                        "language": r.get::<_, Option<String>>(8)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let completed_quests: Vec<Value> = c
                .prepare(
                    "SELECT id, team_id, teammate_chip_id, quest_id, quest_number,
                            points_awarded, created_at
                     FROM lg_team_completed_quests
                     WHERE launched_game_id = ? ORDER BY id ASC",
                )?
                .query_map(params![game_id], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "team_id": r.get::<_, i64>(1)?,
                        "teammate_chip_id": r.get::<_, Option<i64>>(2)?,
                        "quest_id": r.get::<_, Option<i64>>(3)?,
                        "quest_number": r.get::<_, String>(4)?,
                        "points_awarded": r.get::<_, i64>(5)?,
                        "created_at": r.get::<_, String>(6)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            // Whole pairing table - peer secrets included so satellites keep
            // authenticating to the new mother with the bearer they already hold.
            let paired_devices: Vec<Value> = c
                .prepare(
                    "SELECT id, peer_uuid, peer_label, peer_os, peer_app_version,
                            peer_secret, is_self
                     FROM paired_devices",
                )?
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "peer_uuid": r.get::<_, String>(1)?,
                        "peer_label": r.get::<_, String>(2)?,
                        "peer_os": r.get::<_, Option<String>>(3)?,
                        "peer_app_version": r.get::<_, Option<String>>(4)?,
                        "peer_secret": r.get::<_, String>(5)?,
                        "is_self": r.get::<_, i64>(6)? != 0,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            Ok(Some(json!({
                "schema": 1,
                "state_version": state_version,
                "mother_epoch": epoch,
                "mother_uuid": mother_uuid,
                "wifi": wifi,
                "game": game,
                "meta": meta,
                "devices": devices,
                "raw_data": raw_data,
                "teams": teams,
                "completed_quests": completed_quests,
                "paired_devices": paired_devices,
            })))
        })
        .await
        .ok()
        .flatten()
}

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
        ("POST", "delete_team") => delete_team(&state, body).await,
        ("POST", "start_game") => start_game(&state, body).await,
        ("POST", "end_game") => end_game(&state, body).await,
        ("POST", "add_time") => add_time(&state, body).await,
        ("POST", "delete_game") => delete_game(&state, body).await,
        ("POST", "archive_game") => archive_game(&state, body).await,
        ("POST", "sync_summaries") => sync_summaries(&state).await,
        ("POST", "mark_summaries_pushed") => mark_summaries_pushed(&state, body).await,
        ("GET", "list_archived_summaries") => list_archived_summaries(&state).await,
        ("POST", "register_device") => register_device(&state, peer_id, body).await,
        ("GET", "get_devices") => get_devices(&state, &q.rest).await,
        ("GET", "list_paired_with_status") => list_paired_with_status(&state, &q.rest).await,
        ("GET", "list_paired_for_launch") => list_paired_for_launch(&state).await,
        ("POST", "queue_command") => queue_command(&state, peer_id, body).await,
        ("POST", "queue_command_bulk") => queue_command_bulk(&state, peer_id, body).await,
        ("POST", "ack_command") => ack_command(&state, peer_id, body).await,
        ("GET", "list_completed_quests") => list_completed_quests(&state, &q.rest).await,
        ("POST", "record_completed_quest") => record_completed_quest(&state, body).await,
        ("POST", "delete_completed_quest") => delete_completed_quest(&state, body).await,
        ("POST", "clash_register") => clash_register(&state, body).await,
        ("POST", "clash_unregister") => clash_unregister(&state, body).await,
        ("GET", "clash_members") => clash_members(&state, &q.rest).await,
        ("POST", "clash_validate") => clash_validate(&state, body).await,
        ("GET", "clash_state") => clash_state(&state, &q.rest).await,
        ("", _) | (_, "") => Err(ApiErr::bad("action is required")),
        _ => Err(ApiErr::status(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        )),
    };

    // Slice 0: a successful state-changing action advances the per-mother
    // version counter. Read side (snapshot delivery) lands in slice 1.
    if result.is_ok() && action_mutates_game_state(method.as_str(), action) {
        bump_state_version(&state).await;
    }

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
    // The satellite's current screen state travels as a nested object; we store
    // it verbatim as a JSON string. Absent (or explicit null) leaves the stored
    // value untouched via COALESCE in bump_presence.
    let screen_state = body
        .get("screen_state")
        .filter(|v| v.is_object())
        .map(|v| v.to_string());

    // Mother-failover slice 1: the satellite reports the game it's playing and
    // the snapshot version it already has. We return a full snapshot only when
    // its cached version is stale, so a long game's ping stays small once warm.
    let known_version = body.get("known_version").and_then(|v| v.as_i64());
    let launched_game_id = body.get("launched_game_id").and_then(|v| v.as_i64());

    bump_presence(&state, peer_id, has_reader, screen_state).await;
    let commands = pickup_pending_commands(&state, peer_id).await;

    // Feature A: hand the satellite this mother's active Wi-Fi creds so it can
    // auto-rejoin next time. Read straight from schema_meta (the JS side wrote
    // them via lanCredentials.ts into the same SQLite DB). Only included when a
    // password is present (router mode is blank until the operator types one).
    let mother_wifi = read_mother_wifi(&state).await;

    let state_version = read_state_version(&state).await;
    let snapshot = match launched_game_id {
        Some(gid) if known_version != Some(state_version) => {
            build_snapshot(&state, gid, state_version).await
        }
        _ => None,
    };

    json_ok(json!({
        "mother_uuid": state.mother_uuid,
        "commands": commands,
        "mother_wifi": mother_wifi,
        "state_version": state_version,
        "snapshot": snapshot,
    }))
}

/// Active hotspot/router creds from schema_meta as {ssid,password,source}, or
/// null when none usable. Mirrors `services/lanCredentials.ts` key names.
async fn read_mother_wifi(state: &AppState) -> Option<Value> {
    let rows: std::collections::HashMap<String, String> = state
        .db
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<std::collections::HashMap<String, String>> {
            let mut map = std::collections::HashMap::new();
            let mut stmt = c.prepare(
                "SELECT key, value FROM schema_meta WHERE key IN \
                 ('lan_network_source','hotspot_ssid','hotspot_password','lan_router_ssid','lan_router_password')",
            )?;
            let mapped = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in mapped {
                let (k, v) = row?;
                map.insert(k, v);
            }
            Ok(map)
        })
        .await
        .ok()?;

    let source = rows.get("lan_network_source").map(String::as_str).unwrap_or("hotspot");
    let (ssid, password) = if source == "router" {
        (rows.get("lan_router_ssid"), rows.get("lan_router_password"))
    } else {
        (rows.get("hotspot_ssid"), rows.get("hotspot_password"))
    };
    let ssid = ssid.filter(|s| !s.is_empty())?;
    let password = password.filter(|s| !s.is_empty())?;
    Some(json!({ "ssid": ssid, "password": password, "source": source }))
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
    // device - e.g. for a server-only mother that runs the game without
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

            // launched_by_self: 1 when the creating peer IS this device's own
            // is_self row (a local/standalone/mother self-launch). This is what
            // lets the "Cet appareil" section include server-only self-launches
            // (include_self=false ⇒ no lg_launched_game_devices self row) while
            // still dropping games this device merely hosted for other satellites
            // (those create rows carry the satellite's peer_id, is_self=0). When a
            // satellite launches onto a mother, this create runs on the mother, so
            // peer_id is the satellite (is_self=0 there) and the mother's row is
            // correctly 0 - that row never reaches the satellite's local DB anyway.
            let launched_by_self: i64 = c
                .query_row(
                    "SELECT is_self FROM paired_devices WHERE id = ?",
                    params![peer_id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);

            let tx = c.transaction()?;
            let insert_res = tx.execute(
                "INSERT INTO lg_launched_games
                   (summary_uuid, client_id, game_uniqid, name, number_of_teams,
                    game_type, duration, start_time, started, ended, launched_by_self)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
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
                    launched_by_self,
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
                       (launched_game_id, team_number, team_name, pattern, score, key_id, language)
                     VALUES (?, ?, ?, ?, 0, ?, ?)",
                    params![
                        launched_game_id,
                        t.team_number,
                        t.team_name,
                        t.pattern,
                        t.key_id,
                        t.language,
                    ],
                )?;
            }

            // Register the creating peer (the launching mother in slice B's
            // single-device case) into launched_game_devices. Skipped when the
            // operator explicitly unchecked the mother on the launch wizard's
            // device step - in that mode the mother just hosts the server.
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
    language: Option<String>,
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
        let language = v
            .get("language")
            .and_then(|x| if x.is_null() { None } else { x.as_str() })
            .map(|s| s.to_string());
        Some(TeamInput {
            team_number,
            team_name,
            pattern,
            key_id,
            language,
        })
    }
}

async fn list(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    let ended_filter = rest.get("ended").cloned();
    // mine=1: restrict to games that belong to THIS device - either launched by
    // it (launched_by_self=1, covers server-only self-launches) or one it is a
    // registered participant of (self row in lg_launched_game_devices, covers
    // joined + failover-adopted games). Passed by the "Cet appareil" section so
    // it drops games this device merely hosted for other satellites. Absent for
    // the main list, which stays a full management view.
    let mine = rest.get("mine").map(|v| v == "1").unwrap_or(false);
    let games = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            // Composed WHERE clause: client scope + optional ended + optional
            // ownership, so the four param combinations share one query builder.
            let mut where_sql = String::from("WHERE client_id = ?");
            match ended_filter.as_deref() {
                Some("0") => where_sql.push_str(" AND ended = 0"),
                Some("1") => where_sql.push_str(" AND ended = 1"),
                _ => {}
            }
            if mine {
                where_sql.push_str(
                    " AND (launched_by_self = 1
                           OR EXISTS (SELECT 1 FROM lg_launched_game_devices d
                                        JOIN paired_devices pd ON pd.id = d.device_id
                                       WHERE d.launched_game_id = lg_launched_games.id
                                         AND pd.is_self = 1))",
                );
            }
            let sql = format!(
                "SELECT id, game_uniqid, name, number_of_teams, game_type, duration,
                        start_time, started, ended, created_at, updated_at,
                        EXISTS(SELECT 1 FROM lg_launched_game_meta m
                               WHERE m.launched_game_id = lg_launched_games.id
                                 AND m.meta_name = 'testMode'
                                 AND m.meta_value = 'true') AS is_test
                 FROM lg_launched_games
                 {where_sql}
                 ORDER BY created_at DESC"
            );
            let args: Vec<SqlValue> = vec![SqlValue::Integer(client_id)];
            let mut stmt = c.prepare(&sql)?;
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
                    "is_test": r.get::<_, i64>(11)? != 0,
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
                "SELECT id, team_number, team_name, pattern, score, key_id, start_time, end_time, language
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
                        "language": r.get::<_, Option<String>>(8)?,
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
    if let Some(v) = body.get("language") {
        sets.push("language = ?");
        args.push(match v {
            Value::Null => SqlValue::Null,
            Value::String(s) => SqlValue::Text(s.clone()),
            other => SqlValue::Text(other.to_string()),
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

// Draw an unused team name from the synced pools JSON for this game's
// configured audience+language, or None if the pool is disabled / missing /
// exhausted. Called inside the add_team DB closure so the used-names read and
// the eventual INSERT are serialized on one connection (cross-station
// uniqueness). Any failure (no file, parse error, missing keys) collapses to
// None - the caller keeps the key_name fallback.
fn draw_team_name_from_pool(
    c: &rusqlite::Connection,
    media_root: &std::path::Path,
    launched_game_id: i64,
) -> Option<String> {
    // Launch meta: useNamePool / namePoolAudience / language.
    let mut use_pool = false;
    let mut audience = String::new();
    let mut language = String::new();
    {
        let mut stmt = c
            .prepare("SELECT meta_name, meta_value FROM lg_launched_game_meta WHERE launched_game_id = ?1")
            .ok()?;
        let rows = stmt
            .query_map(params![launched_game_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .ok()?;
        for row in rows.flatten() {
            match row.0.as_str() {
                "useNamePool" => use_pool = row.1.as_deref() == Some("true"),
                "namePoolAudience" => audience = row.1.unwrap_or_default(),
                "language" => language = row.1.unwrap_or_default().to_lowercase(),
                _ => {}
            }
        }
    }
    if !use_pool {
        return None;
    }
    // Normalize legacy game_public values onto the canonical trio
    // (mirror of src/types/audience.ts normalizeAudience).
    let audience = match audience.to_lowercase().as_str() {
        "adults" | "adult" | "adultes" | "teens" | "ado" => "ado_adultes".to_string(),
        other => other.to_string(),
    };
    if !matches!(audience.as_str(), "mini_kids" | "kids" | "ado_adultes") || language.is_empty() {
        return None;
    }

    // Candidate names from the synced JSON: pools[audience][language] = [..].
    let path = media_root.join("name_pools").join("team_names.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    let arr = json.get("pools")?.get(&audience)?.get(&language)?.as_array()?;
    let candidates: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    if candidates.is_empty() {
        return None;
    }

    // Exclude names already used by any team in this game (case-insensitive).
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(mut us) = c.prepare(
        "SELECT team_name FROM lg_teams WHERE launched_game_id = ?1 AND team_name IS NOT NULL",
    ) {
        if let Ok(urows) = us.query_map(params![launched_game_id], |r| r.get::<_, String>(0)) {
            for n in urows.flatten() {
                used.insert(n.trim().to_lowercase());
            }
        }
    }
    let free: Vec<&String> = candidates
        .iter()
        .filter(|n| !used.contains(&n.trim().to_lowercase()))
        .collect();
    if free.is_empty() {
        return None;
    }
    let idx = rand::thread_rng().gen_range(0..free.len());
    Some(free[idx].clone())
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
    let language = body
        .get("language")
        .and_then(|v| match v {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            _ => None,
        });
    let draw_from_pool = body
        .get("draw_from_pool")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let media_root = state.media_root.clone();
    require_game_owned(state, launched_game_id).await?;
    let new_id = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            // Multi-station safety: at most one active (end_time NULL) team per
            // (launched_game, key_id). A concurrent add_team for a card that
            // already has an active run returns that team's id instead of
            // inserting a duplicate. (key_id None skips the guard.)
            if let Some(kid) = key_id {
                let existing: Option<i64> = c
                    .query_row(
                        "SELECT id FROM lg_teams
                         WHERE launched_game_id = ?1 AND key_id = ?2 AND end_time IS NULL
                         LIMIT 1",
                        params![launched_game_id, kid],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(id) = existing {
                    return Ok(id);
                }
            }
            // Name pool: replace the key_name fallback with a drawn pooled name
            // (server-side for cross-station uniqueness). Keeps the fallback if
            // the pool is disabled / empty / exhausted.
            let mut team_name = team_name;
            if draw_from_pool {
                if let Some(drawn) = draw_team_name_from_pool(c, &media_root, launched_game_id) {
                    team_name = Some(drawn);
                }
            }
            c.execute(
                "INSERT INTO lg_teams
                   (launched_game_id, team_number, team_name, pattern, score, key_id, language)
                 VALUES (?, ?, ?, ?, 0, ?, ?)",
                params![launched_game_id, team_number, team_name, pattern, key_id, language],
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

// Remove a team from a launched game, along with its completed-quest rows.
// Used by the operator's "Remove team" action in the launched-games list.
async fn delete_team(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let team_id = json_i64(&body, "team_id")?;
    require_team_owned(state, team_id).await?;
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM lg_team_completed_quests WHERE team_id = ?",
                params![team_id],
            )?;
            tx.execute("DELETE FROM lg_teams WHERE id = ?", params![team_id])?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(json!({ "success": true }))
}

// Record the game's start timestamp ONCE. Idempotent: the `start_time IS NULL`
// guard means re-entering the game page never resets the clock. The caller
// supplies the timestamp (an ISO-8601 UTC string) so it isn't tied to the
// server clock and parses unambiguously on the client. Returns the effective
// start_time (the first writer's value wins).
async fn start_game(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    let start_time = json_str(&body, "start_time")?.to_string();
    require_game_owned(state, id).await?;
    let effective = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
            c.execute(
                "UPDATE lg_launched_games SET start_time = ?, started = 1
                 WHERE id = ? AND start_time IS NULL",
                params![start_time, id],
            )?;
            // Clash: lock the effectif (headcount) snapshot at start so score
            // weighting is stable for the whole game. INSERT OR IGNORE keeps the
            // first snapshot even if start_game is re-called or rosters change.
            let game_type: Option<String> = c
                .query_row(
                    "SELECT game_type FROM lg_launched_games WHERE id = ?",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?;
            if game_type.as_deref().is_some_and(|g| g.eq_ignore_ascii_case("clash")) {
                c.execute(
                    "INSERT OR IGNORE INTO lg_clash_effectif (launched_game_id, team_id, size)
                     SELECT ?, t.id,
                            (SELECT COUNT(*) FROM lg_clash_members m
                             WHERE m.launched_game_id = ? AND m.team_id = t.id)
                     FROM lg_teams t WHERE t.launched_game_id = ?",
                    params![id, id, id],
                )?;
            }
            Ok(c
                .query_row(
                    "SELECT start_time FROM lg_launched_games WHERE id = ?",
                    params![id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten())
        })
        .await?;
    Ok(json!({ "start_time": effective }))
}

async fn end_game(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    require_game_owned(state, id).await?;
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            // Stamp the freeze moment (first end wins) so clash's per-minute
            // scoring stops accruing at an early manual-end, not at the scheduled
            // timer expiry. Harmless for other game types.
            c.execute(
                "UPDATE lg_launched_games
                 SET ended = 1,
                     ended_at = COALESCE(ended_at, CAST(strftime('%s','now') AS INTEGER))
                 WHERE id = ?",
                params![id],
            )?;
            Ok(())
        })
        .await?;
    Ok(json!({ "success": true }))
}

// Extend a running game by N minutes (operator "add time"). Single-column bump
// on lg_launched_games.duration - the source of truth every station reads via
// the state poll, so the extra time propagates everywhere. Returns the new
// duration so the caller can confirm.
async fn add_time(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    let minutes = json_i64(&body, "minutes")?;
    require_game_owned(state, id).await?;
    let new_duration = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            c.execute(
                "UPDATE lg_launched_games SET duration = MAX(0, duration + ?) WHERE id = ?",
                params![minutes, id],
            )?;
            Ok(c.query_row(
                "SELECT duration FROM lg_launched_games WHERE id = ?",
                params![id],
                |r| r.get(0),
            )?)
        })
        .await?;
    Ok(json!({ "success": true, "duration": new_duration }))
}

async fn delete_game(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    let client_id = state.client_id;
    require_game_owned(state, id).await?;
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            // Hard delete also discards any non-archived local summary for this
            // game (Delete = "throw it away"; Archive is the "keep the summary"
            // path). Archived summaries point at a now-gone game id and are left
            // intact. A summary already pushed to studio stays in studio.
            c.execute(
                "DELETE FROM lg_game_summaries
                 WHERE launched_game_id = ? AND client_id = ? AND archived_at IS NULL",
                params![id, client_id],
            )?;
            c.execute(
                "DELETE FROM lg_launched_games WHERE id = ? AND client_id = ?",
                params![id, client_id],
            )?;
            Ok(())
        })
        .await?;
    Ok(json!({ "success": true }))
}

// ─── game-summary statistics (pushed to studio as `game_summary` telemetry) ────
//
// A summary is the durable per-game stat record. It is computed from the local
// lg_* tables when a game is ended/eligible, persisted to lg_game_summaries
// (which survives Archive, unlike lg_launched_games), and pushed to the studio
// cloud via the telemetry outbox. See project_playground_statistics_to_studio.

struct ComputedSummary {
    summary_uuid: String,
    client_id: i64,
    game_uniqid: String,
    name: String,
    game_type: String,
    /// played_at = start_time, fallback created_at (both UTC "%Y-%m-%d %H:%M:%S").
    played_at: Option<String>,
    teams_launched: i64,
    teams_played: i64,
    players_played: i64,
    content_hash: String,
}

/// True when the launch was flagged as a test (meta testMode='true'). Tests are
/// never summarised.
fn game_is_test(c: &rusqlite::Connection, game_id: i64) -> rusqlite::Result<bool> {
    let n: i64 = c.query_row(
        "SELECT COUNT(*) FROM lg_launched_game_meta
         WHERE launched_game_id = ?1 AND meta_name = 'testMode' AND meta_value = 'true'",
        params![game_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Returns the computed summary for a game, or None when the game is ineligible
/// (test, missing, or no team "actually played"). A qualifying team has a start
/// time, an end time, and a non-zero score (<>0 covers negative Mystery scores).
/// players_played = (#qualifying teams) + (distinct teammate chips that punched
/// across those teams) - Option 2 from the design.
fn compute_summary(
    c: &rusqlite::Connection,
    game_id: i64,
) -> rusqlite::Result<Option<ComputedSummary>> {
    let row = c
        .query_row(
            "SELECT summary_uuid, client_id, game_uniqid, name, game_type, number_of_teams,
                    COALESCE(start_time, created_at)
             FROM lg_launched_games WHERE id = ?1",
            params![game_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()?;
    let (summary_uuid, client_id, game_uniqid, name, game_type, teams_launched, played_at) =
        match row {
            Some(v) => v,
            None => return Ok(None),
        };

    if game_is_test(c, game_id)? {
        return Ok(None);
    }

    let teams_played: i64 = c.query_row(
        "SELECT COUNT(*) FROM lg_teams
         WHERE launched_game_id = ?1
           AND start_time IS NOT NULL AND end_time IS NOT NULL AND score <> 0",
        params![game_id],
        |r| r.get(0),
    )?;
    if teams_played == 0 {
        return Ok(None);
    }

    let extra_members: i64 = c.query_row(
        "SELECT COUNT(DISTINCT cq.teammate_chip_id)
         FROM lg_team_completed_quests cq
         JOIN lg_teams t ON t.id = cq.team_id
         WHERE t.launched_game_id = ?1
           AND t.start_time IS NOT NULL AND t.end_time IS NOT NULL AND t.score <> 0
           AND cq.teammate_chip_id IS NOT NULL",
        params![game_id],
        |r| r.get(0),
    )?;
    let players_played = teams_played + extra_members;

    let content_hash = format!(
        "{game_type}|{game_uniqid}|{name}|{}|{teams_launched}|{teams_played}|{players_played}",
        played_at.clone().unwrap_or_default()
    );

    Ok(Some(ComputedSummary {
        summary_uuid,
        client_id,
        game_uniqid,
        name,
        game_type,
        played_at,
        teams_launched,
        teams_played,
        players_played,
        content_hash,
    }))
}

/// Inserts a new summary, or updates an existing one only when its content
/// changed (a post-game score edit). A change resets pushed_at = NULL so the
/// next sync re-emits it (studio upserts, last-write-wins). archived_at is
/// never touched here.
fn upsert_summary(
    c: &rusqlite::Connection,
    game_id: i64,
    s: &ComputedSummary,
    now: &str,
) -> rusqlite::Result<()> {
    let existing: Option<String> = c
        .query_row(
            "SELECT content_hash FROM lg_game_summaries WHERE summary_uuid = ?1",
            params![s.summary_uuid],
            |r| Ok(r.get::<_, Option<String>>(0)?.unwrap_or_default()),
        )
        .optional()?;
    match existing {
        None => {
            c.execute(
                "INSERT INTO lg_game_summaries
                   (summary_uuid, launched_game_id, client_id, game_uniqid, name, game_type,
                    played_at, teams_launched, teams_played, players_played, content_hash,
                    pushed_at, archived_at, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,NULL,?12,?12)",
                params![
                    s.summary_uuid, game_id, s.client_id, s.game_uniqid, s.name, s.game_type,
                    s.played_at, s.teams_launched, s.teams_played, s.players_played,
                    s.content_hash, now
                ],
            )?;
        }
        Some(old_hash) if old_hash != s.content_hash => {
            c.execute(
                "UPDATE lg_game_summaries
                   SET launched_game_id=?2, game_uniqid=?3, name=?4, game_type=?5, played_at=?6,
                       teams_launched=?7, teams_played=?8, players_played=?9,
                       content_hash=?10, pushed_at=NULL, updated_at=?11
                 WHERE summary_uuid=?1",
                params![
                    s.summary_uuid, game_id, s.game_uniqid, s.name, s.game_type, s.played_at,
                    s.teams_launched, s.teams_played, s.players_played, s.content_hash, now
                ],
            )?;
        }
        Some(_) => { /* unchanged - leave pushed_at as-is */ }
    }
    Ok(())
}

/// Run on app boot + every telemetry drain. Auto-ends stale games (started or
/// never-started, older than 24h), recomputes summaries for every eligible
/// ended game, and returns the summaries that still need pushing to studio
/// (pushed_at IS NULL). The TS caller enqueues a `game_summary` telemetry event
/// for each, then calls mark_summaries_pushed.
async fn sync_summaries(state: &AppState) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    let to_push = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

            // 1. Auto-end stale games (>24h since start, or since creation when
            //    never started - the latter just clears them from the list).
            c.execute(
                "UPDATE lg_launched_games
                   SET ended = 1, updated_at = ?2
                 WHERE client_id = ?1 AND ended = 0
                   AND COALESCE(start_time, created_at) < datetime('now','-24 hours')",
                params![client_id, now],
            )?;

            // 2. Recompute summaries for all ended games still present locally.
            let ids: Vec<i64> = {
                let mut stmt = c.prepare(
                    "SELECT id FROM lg_launched_games WHERE client_id = ?1 AND ended = 1",
                )?;
                let rows = stmt.query_map(params![client_id], |r| r.get::<_, i64>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for id in ids {
                if let Some(s) = compute_summary(c, id)? {
                    upsert_summary(c, id, &s, &now)?;
                }
            }

            // 3. Return everything still awaiting a push (new, changed, or a
            //    previous push that never got acked).
            let mut stmt = c.prepare(
                "SELECT summary_uuid, name, game_type, game_uniqid, played_at,
                        teams_launched, teams_played, players_played
                 FROM lg_game_summaries
                 WHERE client_id = ?1 AND pushed_at IS NULL",
            )?;
            let rows = stmt.query_map(params![client_id], |r| {
                Ok(json!({
                    "summary_uuid": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "game_type": r.get::<_, String>(2)?,
                    "scenario_uniqid": r.get::<_, String>(3)?,
                    "played_at": r.get::<_, Option<String>>(4)?,
                    "teams_launched": r.get::<_, Option<i64>>(5)?,
                    "teams_played": r.get::<_, i64>(6)?,
                    "players_played": r.get::<_, i64>(7)?,
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "summaries": to_push }))
}

/// Marks the given summary_uuids as pushed (pushed_at = now) so they aren't
/// re-emitted until they change again. Idempotent; ignores already-pushed rows.
async fn mark_summaries_pushed(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    let uuids: Vec<String> = body
        .get("summary_uuids")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if uuids.is_empty() {
        return Ok(json!({ "updated": 0 }));
    }
    let updated = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<usize> {
            let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
            let mut n = 0;
            for u in &uuids {
                n += c.execute(
                    "UPDATE lg_game_summaries SET pushed_at = ?3, updated_at = ?3
                     WHERE client_id = ?1 AND summary_uuid = ?2 AND pushed_at IS NULL",
                    params![client_id, u, now],
                )?;
            }
            Ok(n)
        })
        .await?;
    Ok(json!({ "updated": updated }))
}

/// Archive a launched game: finalise its summary (kept forever) and delete the
/// heavy lg_* rows. Ineligible games (test / nobody played) keep no summary, so
/// archiving them is equivalent to a delete.
async fn archive_game(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    require_game_owned(state, id).await?;
    let client_id = state.client_id;
    let kept = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
            let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
            let kept = if let Some(s) = compute_summary(c, id)? {
                upsert_summary(c, id, &s, &now)?;
                c.execute(
                    "UPDATE lg_game_summaries SET archived_at = ?3, updated_at = ?3
                     WHERE client_id = ?1 AND summary_uuid = ?2",
                    params![client_id, s.summary_uuid, now],
                )?;
                true
            } else {
                false
            };
            // Cascades to lg_teams / lg_team_completed_quests / meta / devices /
            // raw_data. The summary row (no FK to the game) survives.
            c.execute(
                "DELETE FROM lg_launched_games WHERE id = ?1 AND client_id = ?2",
                params![id, client_id],
            )?;
            Ok(kept)
        })
        .await?;
    Ok(json!({ "success": true, "summary_kept": kept }))
}

/// The local Archived-games view: every archived summary, newest first.
async fn list_archived_summaries(state: &AppState) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    let rows = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let mut stmt = c.prepare(
                "SELECT summary_uuid, name, game_type, game_uniqid, played_at,
                        teams_launched, teams_played, players_played, archived_at, pushed_at
                 FROM lg_game_summaries
                 WHERE client_id = ?1 AND archived_at IS NOT NULL
                 ORDER BY (played_at IS NULL), played_at DESC",
            )?;
            let rows = stmt.query_map(params![client_id], |r| {
                Ok(json!({
                    "summary_uuid": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "game_type": r.get::<_, String>(2)?,
                    "scenario_uniqid": r.get::<_, String>(3)?,
                    "played_at": r.get::<_, Option<String>>(4)?,
                    "teams_launched": r.get::<_, Option<i64>>(5)?,
                    "teams_played": r.get::<_, i64>(6)?,
                    "players_played": r.get::<_, i64>(7)?,
                    "archived_at": r.get::<_, Option<String>>(8)?,
                    "pushed": r.get::<_, Option<String>>(9)?.is_some(),
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "summaries": rows }))
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
// staleness - that's a client concern; we just return raw timestamps.
async fn list_paired_with_status(
    state: &AppState,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let launched_game_id = parse_i64(rest, "launched_game_id")?;
    require_game_owned(state, launched_game_id).await?;
    let rows = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(i64, String, Option<String>, i64, Option<String>, i64, Option<String>, Option<i64>, Option<i64>, Option<String>, i64, Option<String>)>> {
            let mut stmt = c.prepare(
                "SELECT pd.id, pd.peer_label, pd.peer_os, pd.is_self,
                        pd.last_seen_at, pd.has_reader, pd.reader_last_seen_at,
                        lgd.id AS lgd_id, lgd.connected, lgd.last_connection_attempt,
                        CASE WHEN pd.last_seen_at IS NOT NULL
                               AND (strftime('%s','now') - strftime('%s', pd.last_seen_at)) < 25
                             THEN 1 ELSE 0 END AS online,
                        pd.screen_state_json
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
                    r.get::<_, Option<String>>(11)?,
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
        screen_state_json,
    ) in rows
    {
        // Stored as an opaque JSON string; re-parse so the frontend receives a
        // real object (null when never reported / unparseable).
        let screen_state: Value = screen_state_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null);
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
            "screen_state": screen_state,
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
// game to anchor against - used by the launch-wizard's step 3 to render the
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
/// - `join_game`     - payload `{launched_game_id}` - target satellite is
///                     expected to register_device + navigate to GamePage.
/// - `play_video`    - payload `{launched_game_id, kinds[], language}` - the
///                     target plays the named videos (intro/tutorial) on top
///                     of whatever it was showing; preempts any in-flight
///                     `play_video` for the same (target, game).
/// - `stop_video`    - payload `{}` - unmount any operator overlay.
/// - `disconnect_device` - payload `{launched_game_id}` - drop the target's
///                     participation row (it must be in the game) and tell the
///                     satellite to leave the in-game page.
/// - `reload_config` - payload `{launched_game_id}` - target (must be in the
///                     game) re-derives its running game page's config from the
///                     freshly-saved meta, so a config edit applies live.
///
/// Authorization: any authenticated paired device may queue commands. Children
/// operate the mother's games (add teams, launch on another device, push videos,
/// etc.) without having joined - so the launch wizard's mother is no longer the
/// only allowed caller. The bearer token is already validated upstream by
/// `resolve_peer`; per-kind target validation below (plus `require_game_owned`,
/// which keys off the hosting mother's own client_id) is what keeps it safe.
/// Targets are validated per-kind: `play_video`/`stop_video` require the target
/// to be currently in `lg_launched_game_devices` for the payload's game;
/// `join_game` requires the target NOT to be in it (409 otherwise).
async fn queue_command(state: &AppState, _peer_id: i64, body: Value) -> Result<Value, ApiErr> {
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
async fn queue_command_bulk(state: &AppState, _peer_id: i64, body: Value) -> Result<Value, ApiErr> {
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
/// and `queue_command_bulk` enforce identical semantics - including the
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
            // `rejoin: true` is the Devices-modal "Reconnect" action: re-push a
            // navigate-to-game command to a device that's ALREADY a participant
            // but has drifted off the game page. It must bypass the
            // already-in-game guard below (a plain join_game - e.g. "Launch
            // here" on an available device - still refuses to double-register).
            let rejoin = payload
                .get("rejoin")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !rejoin {
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
        }
        "play_video" | "stop_video" | "reload_config" => {
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
        "disconnect_device" => {
            // Remove a participating device from the game. The target must
            // currently be in the game; we drop its participation row below (in
            // the same transaction as the command insert) so it leaves bucket A
            // immediately, then the pushed command makes the satellite leave the
            // in-game page.
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
        "open_ranking" => {
            // A ranking page can be pushed to ANY paired device (it only
            // displays a leaderboard), so we don't require the target to be in
            // the game. When the payload scopes to a single launched game we
            // still verify the caller owns it; scenario+time-range targets
            // carry no launched_game_id and need no ownership check.
            if let Some(gid) = launched_game_id {
                require_game_owned(state, gid).await?;
            }
        }
        "show_team_summary" => {
            // A team summary is a self-contained snapshot that can be pushed to
            // ANY paired device (it just renders the team's final page), so the
            // target needn't be in the game. The payload carries the owning
            // launched_game_id - verify the caller owns it.
            if let Some(gid) = launched_game_id {
                require_game_owned(state, gid).await?;
            }
        }
        "become_mother" => {
            // Planned handover: hand hosting to another paired device. It needs
            // the game id so it can adopt; the target need not be a current
            // participant (it caches snapshots regardless). Verify ownership.
            let gid = launched_game_id
                .ok_or_else(|| ApiErr::bad("payload.launched_game_id is required"))?;
            require_game_owned(state, gid).await?;
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
    // For disconnect_device, drop the target's participation row in the same
    // transaction so it leaves the in-game bucket immediately (the pushed
    // command then makes the satellite navigate away).
    let unregister_gid = if kind == "disconnect_device" {
        launched_game_id
    } else {
        None
    };

    let new_id = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            if let Some(gid) = unregister_gid {
                c.execute(
                    "DELETE FROM lg_launched_game_devices
                      WHERE launched_game_id = ? AND device_id = ?",
                    params![gid, target_device_id],
                )?;
            }
            // Preempt: when queuing a play_video, ack any prior unacked
            // play_video for the same (target, game) so only the newest
            // command reaches the satellite. We match on JSON substring of
            // launched_game_id - payloads we emit are normalized.
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

// Delete the most-recent completion row for (team, quest_number). Used by the
// operator's manual quest-count adjustment in the Team Details modal. Returns
// { deleted } so the caller knows whether a row was actually removed.
async fn delete_completed_quest(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let launched_game_id = json_i64(&body, "launched_game_id")?;
    let team_id = json_i64(&body, "team_id")?;
    let quest_number = json_str(&body, "quest_number")?.to_string();

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

    let deleted = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
            let n = c.execute(
                "DELETE FROM lg_team_completed_quests
                 WHERE id = (
                   SELECT id FROM lg_team_completed_quests
                   WHERE launched_game_id = ? AND team_id = ? AND quest_number = ?
                   ORDER BY id DESC LIMIT 1
                 )",
                params![launched_game_id, team_id, quest_number],
            )?;
            Ok(n > 0)
        })
        .await?;
    Ok(json!({ "deleted": deleted }))
}

// ─── action handlers: clash ──────────────────────────────────────────────────
//
// Clash is server-authoritative (LAN-mother-only): multiple reader-equipped
// stations validate into the same shared clan state concurrently, and the
// small territory's "last bipper" needs one total ordering. Client-side
// read-modify-write would lose volume increments under that contention, so the
// crediting, consumed-punch dedup, and ownership math all run here under the
// SQLite write lock. Design: project_clash_game_type_design.

/// A clash territory: a variable-size set of physical balise station codes,
/// worth `points` per-minute to whoever controls it (V2 domination scoring).
struct ClashTerr {
    index: i64,
    points: i64,
    /// Physical balise station codes composing this territory (no shared balises).
    balises: Vec<i64>,
}

struct ClashConfig {
    territories: Vec<ClashTerr>,
    /// 0 ⇒ unlimited.
    max_per_clan: i64,
    /// "The Purge" - launch-time toggle (only offered when the scenario has a
    /// purge image). Absent in pre-purge launches ⇒ false (back-compat).
    purge_enabled: bool,
    /// Physical SI station whose punch attempts a purge (default 25).
    purge_station: i64,
}

/// Load the per-launch clash config persisted by the launch modal in
/// `lg_launched_game_meta` under `clash_config`. V2 shape:
/// `{ territories:[{index,points,balises:[station..]}], max_per_clan,
///    purge_enabled?, purge_station? }`.
fn load_clash_config(c: &rusqlite::Connection, lgid: i64) -> rusqlite::Result<Option<ClashConfig>> {
    let raw: Option<String> = c
        .query_row(
            "SELECT meta_value FROM lg_launched_game_meta
             WHERE launched_game_id = ? AND meta_name = 'clash_config'",
            params![lgid],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(None) };
    let v: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    let mut territories: Vec<ClashTerr> = Vec::new();
    if let Some(arr) = v.get("territories").and_then(|x| x.as_array()) {
        for t in arr {
            let index = t.get("index").and_then(|x| x.as_i64()).unwrap_or(0);
            let points = t.get("points").and_then(|x| x.as_i64()).unwrap_or(0);
            let balises: Vec<i64> = t
                .get("balises")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|s| s.as_i64()).collect())
                .unwrap_or_default();
            territories.push(ClashTerr {
                index,
                points,
                balises,
            });
        }
    }

    let max_per_clan = v.get("max_per_clan").and_then(|x| x.as_i64()).unwrap_or(0);
    let purge_enabled = v.get("purge_enabled").and_then(|x| x.as_bool()).unwrap_or(false);
    let purge_station = v.get("purge_station").and_then(|x| x.as_i64()).unwrap_or(25);
    Ok(Some(ClashConfig {
        territories,
        max_per_clan,
        purge_enabled,
        purge_station,
    }))
}

/// Strict-max ownership (Interpretation B): the unique clan with the highest
/// count controls; any tie at the top (or zero) ⇒ neutral.
fn clash_owner(counts: &HashMap<i64, i64>) -> Option<i64> {
    let max = counts.values().copied().max().unwrap_or(0);
    if max == 0 {
        return None;
    }
    let leaders: Vec<i64> = counts
        .iter()
        .filter(|(_, &v)| v == max)
        .map(|(&k, _)| k)
        .collect();
    if leaders.len() == 1 {
        Some(leaders[0])
    } else {
        None
    }
}

/// Recompute clash standings and return the JSON the dashboard renders.
///
/// V2 domination scoring: each controlled territory pays its `points`/minute to
/// the controlling clan for as long as it holds it. Because ownership only
/// changes at validation events, we replay the timestamped validation log in
/// (time, seq) order, deriving per-territory ownership (strict-max, tie ⇒
/// neutral) after each event and integrating `points × interval` for whoever
/// owned each territory across each interval, from game start up to
/// `min(now, start+duration, ended_at)` (the freeze). Scores are then weighted
/// by the locked effectif multiplier (largest clan ÷ this clan). The same
/// replay derives the event feed (conquest / attack / neutralized). Exact
/// weighted values are returned alongside the rounded display value.
fn compute_clash_standings(
    c: &rusqlite::Connection,
    lgid: i64,
    cfg: &ClashConfig,
    persist: bool,
) -> rusqlite::Result<Value> {
    // Clans = the launched game's teams.
    let mut clans: Vec<(i64, i64, Option<String>)> = Vec::new();
    {
        let mut stmt = c.prepare(
            "SELECT id, team_number, team_name FROM lg_teams
             WHERE launched_game_id = ? ORDER BY team_number ASC",
        )?;
        let rows = stmt.query_map(params![lgid], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            clans.push(row?);
        }
    }

    // Live member counts (display + weighting fallback).
    let mut member_counts: HashMap<i64, i64> = HashMap::new();
    {
        let mut stmt = c.prepare(
            "SELECT team_id, COUNT(*) FROM lg_clash_members
             WHERE launched_game_id = ? GROUP BY team_id",
        )?;
        let rows = stmt.query_map(params![lgid], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (t, n) = row?;
            member_counts.insert(t, n);
        }
    }

    // Locked effectif snapshot → weights. Falls back to live counts if the
    // snapshot is absent (e.g. a game whose start predates the lock).
    let mut sizes: HashMap<i64, i64> = HashMap::new();
    {
        let mut stmt =
            c.prepare("SELECT team_id, size FROM lg_clash_effectif WHERE launched_game_id = ?")?;
        let rows =
            stmt.query_map(params![lgid], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (t, s) = row?;
            sizes.insert(t, s);
        }
    }
    if sizes.is_empty() {
        sizes = member_counts.clone();
    }
    let largest: i64 = sizes.values().copied().filter(|&s| s > 0).max().unwrap_or(0);
    let weight_of = |team: i64| -> f64 {
        let s = sizes.get(&team).copied().unwrap_or(0);
        if largest == 0 {
            1.0
        } else if s > 0 {
            largest as f64 / s as f64
        } else {
            0.0 // an empty clan earns nothing and can't be the divisor
        }
    };

    // Game timing → integration window [start, integration_end]. start_time is a
    // client ISO-8601 string; normalize the 'T'/'Z' so strftime parses on any
    // SQLite build. NULL start ⇒ not started ⇒ empty window (all zero).
    let (start_opt, duration_min, ended, ended_at): (Option<i64>, i64, i64, Option<i64>) = c
        .query_row(
            "SELECT CAST(strftime('%s', replace(replace(start_time,'T',' '),'Z','')) AS INTEGER),
                    duration, ended, ended_at
             FROM lg_launched_games WHERE id = ?",
            params![lgid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    let now: i64 = c.query_row("SELECT CAST(strftime('%s','now') AS INTEGER)", [], |r| r.get(0))?;
    let start = start_opt.unwrap_or(now);
    let integration_end: i64 = match start_opt {
        None => start,
        Some(s) => {
            let cap = s + duration_min * 60;
            let mut e = now.min(cap);
            if ended != 0 {
                if let Some(ea) = ended_at {
                    e = e.min(ea);
                }
            }
            e
        }
    };

    // Ordered replay events: (team, territory, epoch-seconds, seq, is_purge).
    // Validations and purges share one seq high-water (see clash_validate), so
    // sorting the merged stream by (epoch, seq) gives a total order even within
    // the same CURRENT_TIMESTAMP second - a purge always replays before a
    // validation credited later in the same read.
    let events_in: Vec<(i64, i64, i64, i64, bool)> = {
        let mut v: Vec<(i64, i64, i64, i64, bool)> = Vec::new();
        {
            let mut stmt = c.prepare(
                "SELECT team_id, territory_index, CAST(strftime('%s', created_at) AS INTEGER), seq
                 FROM lg_clash_validations WHERE launched_game_id = ?",
            )?;
            let rows = stmt.query_map(params![lgid], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    false,
                ))
            })?;
            for row in rows {
                v.push(row?);
            }
        }
        {
            let mut stmt = c.prepare(
                "SELECT team_id, territory_index, CAST(strftime('%s', created_at) AS INTEGER), seq
                 FROM lg_clash_purges WHERE launched_game_id = ?",
            )?;
            let rows = stmt.query_map(params![lgid], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    true,
                ))
            })?;
            for row in rows {
                v.push(row?);
            }
        }
        v.sort_by_key(|e| (e.2, e.3));
        v
    };

    let points_of: HashMap<i64, i64> = cfg.territories.iter().map(|t| (t.index, t.points)).collect();

    let mut t_counts: HashMap<i64, HashMap<i64, i64>> = HashMap::new();
    let mut t_owner: HashMap<i64, Option<i64>> = HashMap::new();
    let mut t_since: HashMap<i64, i64> = HashMap::new(); // owner_since epoch
    let mut clan_raw: HashMap<i64, f64> = HashMap::new();
    let mut feed: Vec<(String, Option<i64>, i64, i64)> = Vec::new(); // (kind, actor, terr, epoch)
    let mut purge_used_by: Vec<i64> = Vec::new(); // clans whose purge is spent (replay order)

    for (team, terr, epoch, _seq, is_purge) in events_in {
        let prev_owner = t_owner.get(&terr).copied().flatten();
        // Close the previous owner's interval (clamped to the scoring window).
        if let Some(o) = prev_owner {
            let since = t_since.get(&terr).copied().unwrap_or(start);
            let hi = epoch.min(integration_end);
            if hi > since {
                let pts = points_of.get(&terr).copied().unwrap_or(0) as f64;
                *clan_raw.entry(o).or_insert(0.0) += pts * (hi - since) as f64 / 60.0;
            }
        }
        // The Purge: everyone's counts on this territory reset to 0 ⇒ neutral,
        // pays nobody until re-validated from scratch. Points already accrued
        // above stay earned (no clawback).
        if is_purge {
            t_counts.remove(&terr);
            t_owner.insert(terr, None);
            t_since.insert(terr, epoch);
            feed.push(("purge".into(), Some(team), terr, epoch));
            purge_used_by.push(team);
            continue;
        }
        // Apply the +1 and recompute ownership.
        let counts = t_counts.entry(terr).or_default();
        *counts.entry(team).or_insert(0) += 1;
        let new_owner = clash_owner(counts);
        // Feed line (reinforcement of a territory you already own is silent).
        if new_owner == Some(team) && prev_owner != Some(team) {
            feed.push(("conquest".into(), Some(team), terr, epoch));
        } else if new_owner.is_none() && prev_owner.is_some() {
            feed.push(("neutralized".into(), Some(team), terr, epoch));
        } else if new_owner == Some(team) && prev_owner == Some(team) {
            // reinforcement - silent
        } else {
            feed.push(("attack".into(), Some(team), terr, epoch));
        }
        t_owner.insert(terr, new_owner);
        t_since.insert(terr, epoch);
    }

    // Accrue the open (final) interval up to the freeze/now boundary.
    for t in &cfg.territories {
        if let Some(Some(o)) = t_owner.get(&t.index).copied() {
            let since = t_since.get(&t.index).copied().unwrap_or(start);
            if integration_end > since {
                *clan_raw.entry(o).or_insert(0.0) +=
                    t.points as f64 * (integration_end - since) as f64 / 60.0;
            }
        }
    }

    // Current instantaneous raw pts/min per clan from final owners.
    let mut rate_raw: HashMap<i64, i64> = HashMap::new();
    for t in &cfg.territories {
        if let Some(Some(o)) = t_owner.get(&t.index).copied() {
            *rate_raw.entry(o).or_insert(0) += t.points;
        }
    }

    // Territory JSON (final owner + validation counts for the bars).
    let mut territories_json: Vec<Value> = Vec::new();
    for t in &cfg.territories {
        let owner = t_owner.get(&t.index).copied().flatten();
        let counts_json: serde_json::Map<String, Value> = t_counts
            .get(&t.index)
            .map(|m| m.iter().map(|(k, v)| (k.to_string(), Value::from(*v))).collect())
            .unwrap_or_default();
        territories_json.push(json!({
            "index": t.index,
            "points": t.points,
            "owner_team_id": owner,
            "counts": Value::Object(counts_json),
        }));
    }

    // Clan JSON: weighted score + rate; persist the rounded score.
    let mut clans_json: Vec<Value> = Vec::new();
    let mut exact_scores: Vec<(i64, f64)> = Vec::new(); // (team_id, exact weighted)
    let total_points_possible: i64 = cfg.territories.iter().map(|t| t.points).sum();
    for (team_id, team_number, team_name) in &clans {
        let w = weight_of(*team_id);
        let raw = clan_raw.get(team_id).copied().unwrap_or(0.0);
        let weighted = raw * w;
        exact_scores.push((*team_id, weighted));
        let pts = weighted.round() as i64;
        let rate = (rate_raw.get(team_id).copied().unwrap_or(0) as f64 * w).round() as i64;
        if persist {
            c.execute(
                "UPDATE lg_teams SET score = ? WHERE id = ?",
                params![pts, team_id],
            )?;
        }
        clans_json.push(json!({
            "team_id": team_id,
            "team_number": team_number,
            "team_name": team_name,
            "member_count": member_counts.get(team_id).copied().unwrap_or(0),
            "points": pts,
            "points_exact": weighted,
            "rate": rate,
            "weight": w,
        }));
    }

    // ── The Purge: current global target + spent quotas ─────────────────────
    // Target = the territory where the LEADING clan (unique #1 by exact
    // weighted score) has the most validation counts; tie → highest pts/min;
    // still tied → a deterministic pick that is stable while the tied set is
    // unchanged (FNV-1a over game id + sorted candidate indexes - NOT re-rolled
    // per query, so the displayed target always equals what a purge would hit).
    // No unique leader, or the leader has zero validations everywhere ⇒ no
    // target. Design: project_clash_purge_feature.
    let purge_target: Option<i64> = if !cfg.purge_enabled {
        None
    } else {
        let leader: Option<i64> = {
            let best = exact_scores
                .iter()
                .map(|(_, s)| *s)
                .fold(f64::NEG_INFINITY, f64::max);
            let top: Vec<i64> = exact_scores
                .iter()
                .filter(|(_, s)| *s == best)
                .map(|(t, _)| *t)
                .collect();
            if top.len() == 1 { Some(top[0]) } else { None }
        };
        leader.and_then(|leader| {
            let leader_count = |terr: i64| -> i64 {
                t_counts
                    .get(&terr)
                    .and_then(|m| m.get(&leader))
                    .copied()
                    .unwrap_or(0)
            };
            let max_count = cfg
                .territories
                .iter()
                .map(|t| leader_count(t.index))
                .max()
                .unwrap_or(0);
            if max_count == 0 {
                return None;
            }
            let mut candidates: Vec<&ClashTerr> = cfg
                .territories
                .iter()
                .filter(|t| leader_count(t.index) == max_count)
                .collect();
            let max_points = candidates.iter().map(|t| t.points).max().unwrap_or(0);
            candidates.retain(|t| t.points == max_points);
            candidates.sort_by_key(|t| t.index);
            if candidates.len() == 1 {
                return Some(candidates[0].index);
            }
            // Deterministic FNV-1a "random" among the tied candidates.
            let mut h: u64 = 0xcbf29ce484222325;
            let mut mix = |x: u64| {
                let mut hh = h ^ x;
                hh = hh.wrapping_mul(0x100000001b3);
                h = hh;
            };
            mix(lgid as u64);
            for t in &candidates {
                mix(t.index as u64);
            }
            Some(candidates[(h % candidates.len() as u64) as usize].index)
        })
    };
    let purge_json = json!({
        "enabled": cfg.purge_enabled,
        "station": cfg.purge_station,
        "target_territory_index": purge_target,
        "used_by": purge_used_by,
    });

    // Event feed: coalesce consecutive same-actor+territory attacks (refresh the
    // timestamp instead of duplicating), keep the last ~20, most-recent first.
    let mut coalesced: Vec<(String, Option<i64>, i64, i64)> = Vec::new();
    for ev in feed {
        if ev.0 == "attack" {
            if let Some(last) = coalesced.last_mut() {
                if last.0 == "attack" && last.1 == ev.1 && last.2 == ev.2 {
                    last.3 = ev.3;
                    continue;
                }
            }
        }
        coalesced.push(ev);
    }
    let start_idx = coalesced.len().saturating_sub(20);
    let events_json: Vec<Value> = coalesced[start_idx..]
        .iter()
        .rev()
        .map(|(kind, actor, terr, epoch)| {
            json!({
                "kind": kind,
                "team_id": actor,
                "territory_index": terr,
                "at": epoch * 1000,
            })
        })
        .collect();

    Ok(json!({
        "clans": clans_json,
        "territories": territories_json,
        "total_points_possible": total_points_possible,
        "events": events_json,
        "purge": purge_json,
    }))
}

/// Bind a chip to a clan (lg_teams row). Server-authoritative so concurrent
/// stations can't double-bind a chip or overfill a clan past `max_per_clan`.
async fn clash_register(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let launched_game_id = json_i64(&body, "launched_game_id")?;
    let team_id = json_i64(&body, "team_id")?;
    let chip_id = json_i64(&body, "chip_id")?;
    require_game_owned(state, launched_game_id).await?;

    let outcome = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(String, i64)> {
            let tx = c.transaction()?;

            let belongs: Option<i64> = tx
                .query_row(
                    "SELECT id FROM lg_teams WHERE id = ? AND launched_game_id = ?",
                    params![team_id, launched_game_id],
                    |r| r.get(0),
                )
                .optional()?;
            if belongs.is_none() {
                return Ok(("team_not_found".to_string(), 0));
            }

            // Already bound somewhere? A chip joins exactly one clan.
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT team_id FROM lg_clash_members
                     WHERE launched_game_id = ? AND chip_id = ?",
                    params![launched_game_id, chip_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(t) = existing {
                let cnt: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM lg_clash_members WHERE launched_game_id = ? AND team_id = ?",
                    params![launched_game_id, t],
                    |r| r.get(0),
                )?;
                let status = if t == team_id {
                    "already_in_clan"
                } else {
                    "already_in_other_clan"
                };
                return Ok((status.to_string(), cnt));
            }

            // Cap check (max_per_clan from config; 0 ⇒ unlimited).
            let max = load_clash_config(&tx, launched_game_id)?
                .map(|cfg| cfg.max_per_clan)
                .unwrap_or(0);
            let cnt: i64 = tx.query_row(
                "SELECT COUNT(*) FROM lg_clash_members WHERE launched_game_id = ? AND team_id = ?",
                params![launched_game_id, team_id],
                |r| r.get(0),
            )?;
            if max > 0 && cnt >= max {
                return Ok(("clan_full".to_string(), cnt));
            }

            tx.execute(
                "INSERT INTO lg_clash_members (launched_game_id, team_id, chip_id)
                 VALUES (?, ?, ?)",
                params![launched_game_id, team_id, chip_id],
            )?;
            tx.commit()?;
            Ok(("ok".to_string(), cnt + 1))
        })
        .await?;

    Ok(json!({ "status": outcome.0, "team_id": team_id, "member_count": outcome.1 }))
}

/// Operator: list the chips bound to each clan (for the launched-game page +
/// the clan-details modal).
async fn clash_members(state: &AppState, rest: &HashMap<String, String>) -> Result<Value, ApiErr> {
    let id = parse_i64(rest, "id")?;
    require_game_owned(state, id).await?;
    let members = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let mut stmt = c.prepare(
                "SELECT team_id, chip_id, created_at FROM lg_clash_members
                 WHERE launched_game_id = ? ORDER BY team_id ASC, chip_id ASC",
            )?;
            let rows = stmt.query_map(params![id], |r| {
                Ok(json!({
                    "team_id": r.get::<_, i64>(0)?,
                    "chip_id": r.get::<_, i64>(1)?,
                    "created_at": r.get::<_, String>(2)?,
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "members": members }))
}

/// Operator: unbind a chip from its clan (manual correction).
async fn clash_unregister(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let launched_game_id = json_i64(&body, "launched_game_id")?;
    let chip_id = json_i64(&body, "chip_id")?;
    require_game_owned(state, launched_game_id).await?;
    let deleted = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
            let n = c.execute(
                "DELETE FROM lg_clash_members WHERE launched_game_id = ? AND chip_id = ?",
                params![launched_game_id, chip_id],
            )?;
            Ok(n > 0)
        })
        .await?;
    Ok(json!({ "deleted": deleted }))
}

/// Validate a central-reader card-read: credit every fresh combination among
/// the card's unconsumed punches to the player's clan, consume those punches,
/// and return the credited combos (for the local reveal) + fresh standings.
async fn clash_validate(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let launched_game_id = json_i64(&body, "launched_game_id")?;
    let chip_id = json_i64(&body, "chip_id")?;
    let punches: Vec<(i64, String)> = body
        .get("punches")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let station = p
                        .get("code")
                        .and_then(|x| x.as_i64())
                        .or_else(|| p.get("station").and_then(|x| x.as_i64()))?;
                    let time = p
                        .get("time")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    Some((station, time))
                })
                .collect()
        })
        .unwrap_or_default();
    require_game_owned(state, launched_game_id).await?;

    let result = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Value> {
            let tx = c.transaction()?;

            // Resolve clan.
            let team_id: Option<i64> = tx
                .query_row(
                    "SELECT team_id FROM lg_clash_members
                     WHERE launched_game_id = ? AND chip_id = ?",
                    params![launched_game_id, chip_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(team_id) = team_id else {
                return Ok(json!({ "status": "not_registered", "credited": [] }));
            };

            // Game over?
            let ended: i64 = tx.query_row(
                "SELECT ended FROM lg_launched_games WHERE id = ?",
                params![launched_game_id],
                |r| r.get(0),
            )?;
            if ended != 0 {
                return Ok(json!({ "status": "game_over", "team_id": team_id, "credited": [] }));
            }

            let Some(cfg) = load_clash_config(&tx, launched_game_id)? else {
                return Ok(json!({ "status": "no_config", "team_id": team_id, "credited": [] }));
            };

            // Consumed punch keys for this chip.
            let mut consumed: HashSet<String> = HashSet::new();
            {
                let mut stmt = tx.prepare(
                    "SELECT punch_key FROM lg_clash_consumed
                     WHERE launched_game_id = ? AND chip_id = ?",
                )?;
                let rows = stmt.query_map(params![launched_game_id, chip_id], |r| {
                    r.get::<_, String>(0)
                })?;
                for row in rows {
                    consumed.insert(row?);
                }
            }

            // Available (unconsumed, de-duped within this read) punch keys per
            // station. Purge-station punches are split out: they never help
            // complete a territory and are consumed on ANY outcome (a rejected
            // purge attempt costs the player a trip back to the purge station).
            let mut by_station: HashMap<i64, Vec<String>> = HashMap::new();
            let mut seen: HashSet<String> = HashSet::new();
            let mut purge_keys: Vec<String> = Vec::new();
            for (station, time) in &punches {
                let key = format!("{station}@{time}");
                if consumed.contains(&key) || seen.contains(&key) || purge_keys.contains(&key) {
                    continue;
                }
                if cfg.purge_enabled && *station == cfg.purge_station {
                    purge_keys.push(key);
                    continue;
                }
                seen.insert(key.clone());
                by_station.entry(*station).or_default().push(key);
            }

            // Current per-game seq high-water mark - shared across validations
            // AND purges so the standings replay has a total order within the
            // same CURRENT_TIMESTAMP second.
            let mut seq: i64 = tx.query_row(
                "SELECT MAX(COALESCE((SELECT MAX(seq) FROM lg_clash_validations WHERE launched_game_id = ?1), 0),
                            COALESCE((SELECT MAX(seq) FROM lg_clash_purges      WHERE launched_game_id = ?1), 0))",
                params![launched_game_id],
                |r| r.get(0),
            )?;

            // ── The Purge (processed BEFORE crediting, so a read that both
            // purges territory T and completes T starts the recapture at 1).
            // Quota = one SUCCESS per clan; rejections don't spend it but the
            // physical punches are consumed either way. Multiple purge punches
            // in one read = one attempt. Design: project_clash_purge_feature.
            let mut purge_json: Option<Value> = None;
            if !purge_keys.is_empty() {
                for key in &purge_keys {
                    tx.execute(
                        "INSERT OR IGNORE INTO lg_clash_consumed
                           (launched_game_id, chip_id, punch_key) VALUES (?, ?, ?)",
                        params![launched_game_id, chip_id, key],
                    )?;
                }
                let already_used: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM lg_clash_purges
                                   WHERE launched_game_id = ? AND team_id = ?)",
                    params![launched_game_id, team_id],
                    |r| r.get(0),
                )?;
                if already_used {
                    purge_json =
                        Some(json!({ "attempted": true, "status": "already_used" }));
                } else {
                    // Target + current owner as of this instant (pre-purge state).
                    let pre = compute_clash_standings(&tx, launched_game_id, &cfg, false)?;
                    let target = pre
                        .get("purge")
                        .and_then(|p| p.get("target_territory_index"))
                        .and_then(|v| v.as_i64());
                    match target {
                        None => {
                            purge_json =
                                Some(json!({ "attempted": true, "status": "no_target" }));
                        }
                        Some(ti) => {
                            let owner: Option<i64> = pre
                                .get("territories")
                                .and_then(|v| v.as_array())
                                .and_then(|arr| {
                                    arr.iter().find(|t| {
                                        t.get("index").and_then(|x| x.as_i64()) == Some(ti)
                                    })
                                })
                                .and_then(|t| t.get("owner_team_id"))
                                .and_then(|v| v.as_i64());
                            if owner == Some(team_id) {
                                purge_json = Some(
                                    json!({ "attempted": true, "status": "own_territory" }),
                                );
                            } else {
                                seq += 1;
                                tx.execute(
                                    "INSERT INTO lg_clash_purges
                                       (launched_game_id, team_id, chip_id, territory_index, seq)
                                     VALUES (?, ?, ?, ?, ?)",
                                    params![launched_game_id, team_id, chip_id, ti, seq],
                                )?;
                                purge_json = Some(json!({
                                    "attempted": true,
                                    "status": "ok",
                                    "territory_index": ti,
                                }));
                            }
                        }
                    }
                }
            }

            // V2 crediting: at most ONE territory per registration = the
            // highest-value territory whose full balise set is present in the
            // fresh-punch pool (ties → lowest index). If one is credited, the
            // ENTIRE read's fresh punches are consumed (no leftover stockpiling);
            // if none completes, the partials stay pending for a later lap.
            let mut credited: Vec<Value> = Vec::new();
            let best = cfg
                .territories
                .iter()
                .filter(|t| {
                    !t.balises.is_empty()
                        && t.balises
                            .iter()
                            .all(|s| by_station.get(s).map_or(false, |v| !v.is_empty()))
                })
                .max_by(|a, b| a.points.cmp(&b.points).then(b.index.cmp(&a.index)));

            if let Some(t) = best {
                seq += 1;
                tx.execute(
                    "INSERT INTO lg_clash_validations
                       (launched_game_id, team_id, chip_id, combo_index, territory_index, seq)
                     VALUES (?, ?, ?, ?, ?, ?)",
                    params![launched_game_id, team_id, chip_id, t.index, t.index, seq],
                )?;
                credited.push(json!({ "territory_index": t.index }));

                // Consume the whole read's fresh punches (Q2.1b: consume/discard).
                for key in &seen {
                    tx.execute(
                        "INSERT OR IGNORE INTO lg_clash_consumed
                           (launched_game_id, chip_id, punch_key) VALUES (?, ?, ?)",
                        params![launched_game_id, chip_id, key],
                    )?;
                }
            }

            let standings = compute_clash_standings(&tx, launched_game_id, &cfg, true)?;
            tx.commit()?;

            let mut resp = json!({
                "status": "ok",
                "team_id": team_id,
                "credited": credited,
                "standings": standings,
            });
            if let Some(p) = purge_json {
                resp.as_object_mut()
                    .expect("resp is an object")
                    .insert("purge".into(), p);
            }
            Ok(resp)
        })
        .await?;

    Ok(result)
}

/// Read-only standings + clan membership counts for the live dashboard and the
/// registration picker (greys out full clans).
async fn clash_state(state: &AppState, rest: &HashMap<String, String>) -> Result<Value, ApiErr> {
    let id = parse_i64(rest, "id")?;
    require_game_owned(state, id).await?;
    let payload = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Value> {
            let Some(cfg) = load_clash_config(c, id)? else {
                return Ok(json!({ "status": "no_config" }));
            };
            let standings = compute_clash_standings(c, id, &cfg, false)?;
            let mut obj = match standings {
                Value::Object(m) => m,
                _ => serde_json::Map::new(),
            };
            obj.insert("status".into(), Value::from("ok"));
            obj.insert("max_per_clan".into(), Value::from(cfg.max_per_clan));
            Ok(Value::Object(obj))
        })
        .await?;
    Ok(payload)
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
    // Mother/hotspot role rework (E1 auto-pair): a joiner proves same-client
    // membership by sending its client_id. The trust boundary is the LAN itself
    // (venue Wi-Fi / hotspot password), so a device that's reachable AND claims
    // the mother's own client_id is auto-approved - no operator tap. Older
    // clients omit this field and fall through to the manual-approval flow.
    let peer_client_id = body.get("client_id").and_then(|v| v.as_i64());

    // A request claiming OUR own uuid is this device's own client stack (e.g.
    // a stale auto-join tick racing a promotion). Never create an is_self=0
    // twin of the self row - that's exactly the phantom "__mother_self__"
    // device - just hand back the canonical self secret.
    if peer_uuid == state.mother_uuid {
        if peer_client_id == Some(state.client_id) {
            let self_id = state.self_peer_id;
            let secret: String = state
                .db
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<String> {
                    Ok(c.query_row(
                        "SELECT peer_secret FROM paired_devices WHERE id = ?",
                        params![self_id],
                        |r| r.get(0),
                    )?)
                })
                .await?;
            return Ok(json!({ "status": "approved", "peer_secret": secret }));
        }
        return Ok(json!({ "status": "denied" }));
    }

    // If this peer is already paired, hand back the CURRENT secret rather than
    // making the operator revoke-and-re-pair. This is what makes re-pairing
    // idempotent + self-healing: a same-client device whose stored secret drifted
    // (mother DB rebuilt, snapshot promotion, etc.) re-syncs to the mother's live
    // secret just by asking. Cross-client peers still get the old hint (they
    // can't silently adopt a secret without an operator decision).
    let already_paired: Option<String> = state
        .db
        .call({
            let peer_uuid = peer_uuid.clone();
            move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
                Ok(c.query_row(
                    "SELECT peer_secret FROM paired_devices WHERE peer_uuid = ? AND is_self = 0",
                    params![peer_uuid],
                    |r| r.get(0),
                )
                .optional()?)
            }
        })
        .await?;
    if let Some(existing_secret) = already_paired {
        if peer_client_id == Some(state.client_id) {
            // Refresh the display metadata while we're here: a row inherited
            // from a snapshot adoption may still carry the previous mother's
            // '__mother_self__' placeholder - the re-pairing device knows its
            // real name, so adopt it.
            state
                .db
                .call({
                    let peer_uuid = peer_uuid.clone();
                    let peer_label = peer_label.clone();
                    let peer_os = peer_os.clone();
                    let peer_app_version = peer_app_version.clone();
                    move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                        c.execute(
                            "UPDATE paired_devices SET
                                 peer_label = CASE WHEN LENGTH(TRIM(?2)) > 0 THEN ?2 ELSE peer_label END,
                                 peer_os = COALESCE(?3, peer_os),
                                 peer_app_version = COALESCE(?4, peer_app_version)
                             WHERE peer_uuid = ?1 AND is_self = 0",
                            params![peer_uuid, peer_label, peer_os, peer_app_version],
                        )?;
                        Ok(())
                    }
                })
                .await?;
            return Ok(json!({ "status": "approved", "peer_secret": existing_secret }));
        }
        return Ok(json!({
            "status": "already_paired",
            "message": "This peer_uuid already has a paired entry. Re-use the stored secret, or have the mother revoke it to re-pair."
        }));
    }

    let proposed_secret = random_token(32);

    // Auto-pair fast path: trusted same-client joiner. Create the paired_devices
    // row now and hand the secret back immediately (no pair_requests row, no
    // polling - the joiner reads "approved" straight from this response).
    if peer_client_id == Some(state.client_id) {
        let secret = proposed_secret.clone();
        state
            .db
            .call({
                let peer_uuid = peer_uuid.clone();
                let peer_label = peer_label.clone();
                let peer_os = peer_os.clone();
                let peer_app_version = peer_app_version.clone();
                move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    c.execute(
                        "INSERT INTO paired_devices
                           (peer_uuid, peer_label, peer_os, peer_app_version, peer_secret, is_self)
                         VALUES (?, ?, ?, ?, ?, 0)",
                        params![peer_uuid, peer_label, peer_os, peer_app_version, secret],
                    )?;
                    Ok(())
                }
            })
            .await?;
        return Ok(json!({ "status": "approved", "peer_secret": proposed_secret }));
    }
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
        // Refuse a link to OURSELVES (mother_uuid matching one of our own
        // identity keys): a self-link makes childControlLink route this
        // device's launched_games traffic at itself through the satellite
        // path - the source of the phantom "__mother_self__" peer.
        let is_self: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_meta
                            WHERE key IN ('mother_device_uuid','client_device_uuid')
                              AND value = ?)",
            params![mother_uuid],
            |r| r.get(0),
        )?;
        if is_self {
            return Ok(());
        }
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

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JoinOutcome {
    Approved,
    Denied,
    AlreadyPaired,
    Timeout,
    Unreachable { message: String },
}

// Order a mother's advertised addresses best-first for a reachable connection:
// routable private IPv4 first, link-local (169.254) last, IPv6 skipped (fe80::
// needs a zone id we don't have). Mirrors the JS heuristic but runs in Rust.
fn order_pair_candidates(addresses: &[String]) -> Vec<String> {
    let is_ipv4 = |a: &str| {
        let parts: Vec<&str> = a.split('.').collect();
        parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok())
    };
    let mut out: Vec<String> = addresses
        .iter()
        .filter(|a| is_ipv4(a) && !a.starts_with("127.") && !a.starts_with("169.254."))
        .cloned()
        .collect();
    out.extend(
        addresses
            .iter()
            .filter(|a| is_ipv4(a) && a.starts_with("169.254."))
            .cloned(),
    );
    out
}

/// Run the full pair handshake against a discovered mother FROM RUST (reqwest),
/// so it is not subject to the webview's `http:` capability scope - the LAN AP
/// hands out arbitrary IPs (192.168.137.1, 169.254.x APIPA, …) that are painful
/// to allowlist. Tries each candidate address until one connects, POSTs the
/// pair request, polls for approval, and on success persists the secret to
/// `paired_mothers` + warms the endpoint cache so pings work immediately.
#[tauri::command]
pub async fn client_pair_with_mother(
    app: AppHandle,
    cache: tauri::State<'_, MotherEndpointCache>,
    mother_uuid: String,
    mother_label: Option<String>,
    addresses: Vec<String>,
    port: u16,
    peer_label: String,
    peer_os: Option<String>,
    peer_app_version: Option<String>,
    // Mother/hotspot role rework: our own client_id, sent so a same-client mother
    // can auto-approve us on the LAN (E1) without an operator tap. None when the
    // caller doesn't know it (falls back to manual approval).
    client_id: Option<i64>,
    timeout_ms: Option<u64>,
) -> Result<JoinOutcome, String> {
    // Stable per-device peer uuid (same source as client_get_device_identity).
    let conn = open_db_for_command(&app).await?;
    let peer_uuid = conn
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<String> {
            let existing: Option<String> = c
                .query_row(
                    "SELECT value FROM schema_meta WHERE key = 'client_device_uuid'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(match existing {
                Some(s) => s,
                None => {
                    let new = uuid::Uuid::new_v4().to_string();
                    c.execute(
                        "INSERT INTO schema_meta(key, value) VALUES ('client_device_uuid', ?)",
                        params![new],
                    )?;
                    new
                }
            })
        })
        .await
        .map_err(|e| e.to_string())?;

    // Never pair with OURSELVES (an mDNS browse can surface our own advert):
    // a self-link in paired_mothers routes our launched_games traffic at
    // ourselves through the satellite path - the phantom "__mother_self__"
    // peer. We're trivially "paired" with ourselves already.
    let is_self_target = conn
        .call({
            let mother_uuid = mother_uuid.clone();
            move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
                Ok(c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM schema_meta
                                    WHERE key IN ('mother_device_uuid','client_device_uuid')
                                      AND value = ?)",
                    params![mother_uuid],
                    |r| r.get(0),
                )?)
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    if is_self_target {
        return Ok(JoinOutcome::AlreadyPaired);
    }

    let candidates = order_pair_candidates(&addresses);
    if candidates.is_empty() {
        return Ok(JoinOutcome::Unreachable {
            message: "mother advertised no usable IPv4 address".into(),
        });
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;

    // Try each candidate until the pair request goes through.
    let req_body = serde_json::json!({
        "peer_uuid": peer_uuid,
        "peer_label": peer_label,
        "peer_os": peer_os,
        "peer_app_version": peer_app_version,
        "client_id": client_id,
    });
    let mut chosen: Option<String> = None;
    let mut request_id: Option<i64> = None;
    let mut last_err = String::new();
    for cand in &candidates {
        let base = format!("http://{cand}:{port}");
        match client
            .post(format!("{base}/pair.php?action=request"))
            .json(&req_body)
            .send()
            .await
        {
            Ok(resp) => {
                let body: serde_json::Value = match resp.json().await {
                    Ok(v) => v,
                    Err(e) => { last_err = e.to_string(); continue; }
                };
                match body.get("status").and_then(|s| s.as_str()) {
                    Some("already_paired") => return Ok(JoinOutcome::AlreadyPaired),
                    // Auto-pair fast path: the same-client mother approved us
                    // outright (E1). Persist the secret + warm the cache and
                    // we're done - no polling. Mirrors the poll-loop block below.
                    Some("approved") => {
                        if let Some(secret) = body.get("peer_secret").and_then(|v| v.as_str()) {
                            let uuid_db = mother_uuid.clone();
                            let label_db = mother_label.clone();
                            let secret_db = secret.to_string();
                            conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                                c.execute(
                                    "INSERT INTO paired_mothers (mother_uuid, mother_label, peer_secret, last_seen_at)
                                     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                                     ON CONFLICT(mother_uuid) DO UPDATE SET
                                       mother_label = excluded.mother_label,
                                       peer_secret = excluded.peer_secret,
                                       last_seen_at = CURRENT_TIMESTAMP",
                                    params![uuid_db, label_db, secret_db],
                                )?;
                                Ok(())
                            })
                            .await
                            .map_err(|e| e.to_string())?;
                            if let Ok(sa) = base.trim_start_matches("http://").parse::<SocketAddr>() {
                                cache.inner.lock().await.insert(mother_uuid.clone(), sa);
                            }
                            return Ok(JoinOutcome::Approved);
                        }
                        last_err = "approved without a peer_secret".into();
                    }
                    Some("pending") => {
                        request_id = body.get("request_id").and_then(|v| v.as_i64());
                        chosen = Some(base);
                        break;
                    }
                    other => { last_err = format!("unexpected pair status: {other:?}"); }
                }
            }
            Err(e) => { last_err = e.to_string(); }
        }
    }

    let (Some(base), Some(req_id)) = (chosen, request_id) else {
        return Ok(JoinOutcome::Unreachable {
            message: format!("tried {}: {last_err}", candidates.join(", ")),
        });
    };

    // Poll for the operator's decision.
    let deadline = tokio::time::Instant::now()
        + Duration::from_millis(timeout_ms.unwrap_or(120_000));
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Ok(JoinOutcome::Timeout);
        }
        // peer_uuid is a UUID (hex + hyphens) - already URL-safe, no encoding.
        let url = format!("{base}/pair.php?action=status&request_id={req_id}&peer_uuid={peer_uuid}");
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                match body.get("status").and_then(|s| s.as_str()) {
                    Some("approved") => {
                        if let Some(secret) = body.get("peer_secret").and_then(|v| v.as_str()) {
                            let uuid_db = mother_uuid.clone();
                            let label_db = mother_label.clone();
                            let secret_db = secret.to_string();
                            conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                                c.execute(
                                    "INSERT INTO paired_mothers (mother_uuid, mother_label, peer_secret, last_seen_at)
                                     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                                     ON CONFLICT(mother_uuid) DO UPDATE SET
                                       mother_label = excluded.mother_label,
                                       peer_secret = excluded.peer_secret,
                                       last_seen_at = CURRENT_TIMESTAMP",
                                    params![uuid_db, label_db, secret_db],
                                )?;
                                Ok(())
                            })
                            .await
                            .map_err(|e| e.to_string())?;
                            // Warm the endpoint cache with the address that worked.
                            if let Ok(sa) = base
                                .trim_start_matches("http://")
                                .parse::<SocketAddr>()
                            {
                                cache.inner.lock().await.insert(mother_uuid.clone(), sa);
                            }
                            return Ok(JoinOutcome::Approved);
                        }
                    }
                    Some("denied") => return Ok(JoinOutcome::Denied),
                    _ => {}
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(2000)).await;
    }
}

// ─── tauri commands: mDNS ────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DiscoveredMother {
    pub mother_uuid: String,
    pub host: String,
    pub addresses: Vec<String>,
    pub port: u16,
    pub label: Option<String>,
    // Mother-failover slice 3: parsed from the TXT record (None for an older
    // mother that doesn't advertise them yet). Slice 5 uses these to re-point.
    pub client_id: Option<i64>,
    pub epoch: Option<i64>,
}

const MDNS_SERVICE_TYPE: &str = "_taghunter._tcp.local.";

fn start_mdns(
    mother_uuid: &str,
    label: Option<&str>,
    port: u16,
    // Mother-failover slice 3: advertised so satellites can match the mother
    // serving their client and prefer the highest epoch when re-pointing.
    client_id: i64,
    epoch: i64,
    // Addresses to advertise EXPLICITLY in addition to auto-detected ones. The
    // Windows hotspot interface (192.168.x.x) only appears *after* the hotspot
    // is started - well after the server booted and first registered mDNS - so
    // `enable_addr_auto()` alone leaves clients resolving only the stale
    // pre-hotspot addresses (link-local fe80::/APIPA 169.254.x). Passing the
    // hotspot IPv4 here guarantees clients can reach the mother on the AP subnet.
    extra_addrs: &[String],
) -> Result<MdnsHandle, String> {
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let host = format!("{}.local.", mother_uuid);
    let instance = format!("taghunter-{}", &mother_uuid[..8]);
    let mut props: HashMap<String, String> = HashMap::new();
    props.insert("uuid".into(), mother_uuid.to_string());
    props.insert("client_id".into(), client_id.to_string());
    props.insert("epoch".into(), epoch.to_string());
    if let Some(l) = label {
        props.insert("label".into(), l.to_string());
    }
    // Comma-joined explicit IPs ("" when none). enable_addr_auto() additionally
    // fills in the host's other interface addresses at register time.
    let ip_arg = extra_addrs.join(",");
    let svc = ServiceInfo::new(
        MDNS_SERVICE_TYPE,
        &instance,
        &host,
        ip_arg.as_str(),
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
                let client_id = props
                    .get_property_val_str("client_id")
                    .and_then(|s| s.parse::<i64>().ok());
                let epoch = props
                    .get_property_val_str("epoch")
                    .and_then(|s| s.parse::<i64>().ok());
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
                        client_id,
                        epoch,
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
// This device's own non-loopback IPv4s (its office/upstream LAN IP, and its
// hotspot IP 192.168.137.1 when hosting). Used to pick a mother address we can
// actually route to.
fn local_ipv4s() -> Vec<Ipv4Addr> {
    match if_addrs::get_if_addrs() {
        Ok(addrs) => addrs
            .into_iter()
            .filter(|i| !i.is_loopback())
            .filter_map(|i| match i.addr {
                if_addrs::IfAddr::V4(v) => Some(v.ip),
                _ => None,
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Choose which advertised mother address to talk to. A mother that hosts a
/// hotspot advertises BOTH its upstream/office LAN IP and its hotspot IP
/// (192.168.137.1); a satellite on the hotspot subnet can only route to the
/// latter, and one on the office LAN only to the former. So prefer a mother IPv4
/// on the SAME /24 as one of our own IPs - otherwise the child caches an
/// unreachable address and the mother sees it as offline (the exact "connected
/// on internet but not on the hotspot" bug). Fall back to first IPv4, then any.
fn select_address(addresses: &[String]) -> Option<String> {
    let v4: Vec<Ipv4Addr> = addresses
        .iter()
        .filter_map(|a| a.parse::<Ipv4Addr>().ok())
        .collect();
    let locals = local_ipv4s();
    if let Some(same_subnet) = v4.iter().find(|m| {
        let mo = m.octets();
        locals.iter().any(|l| {
            let lo = l.octets();
            lo[0] == mo[0] && lo[1] == mo[1] && lo[2] == mo[2]
        })
    }) {
        return Some(same_subnet.to_string());
    }
    v4.first()
        .map(|ip| ip.to_string())
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

/// A control link to a reachable paired mother: the base URL (the same
/// host:port that serves `/ping.php` also serves `/launched_games.php`) plus the
/// `peer_secret` this device authenticates with.
#[derive(Serialize)]
pub struct MotherLink {
    pub base_url: String,
    pub token: String,
    pub mother_uuid: String,
}

/// Resolve a control link to a reachable paired mother. Reads ONLY the warm
/// `MotherEndpointCache` (kept fresh by the footer's ping loop) + `paired_mothers`
/// - no mDNS browse - so it's cheap to call on a timer. Returns the first paired
/// mother (most-recently-seen) that has a cached endpoint, or None when this
/// device has no such mother (standalone, or none discovered yet).
///
/// The satellite uses this to install an always-on `launched_games` override so
/// children can view and operate the mother's active games without first joining
/// one. The hosting mother itself isn't paired to another mother, so this
/// returns None there and its own local override stays in place.
#[tauri::command]
pub async fn client_resolve_mother_link(
    app: AppHandle,
    cache: tauri::State<'_, MotherEndpointCache>,
) -> Result<Option<MotherLink>, String> {
    let paired: Vec<(String, String)> = {
        let conn = open_db_for_command(&app).await?;
        conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(String, String)>> {
            // Never resolve OURSELVES as the mother to follow: a stale
            // self-link (identity drift, since healed at server start) would
            // otherwise route this mother's launched_games traffic at itself
            // through the satellite path with an old peer secret.
            let mut stmt = c.prepare(
                "SELECT mother_uuid, peer_secret FROM paired_mothers
                 WHERE mother_uuid NOT IN (SELECT value FROM schema_meta
                                            WHERE key IN ('mother_device_uuid','client_device_uuid'))
                 ORDER BY last_seen_at DESC NULLS LAST",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if paired.is_empty() {
        return Ok(None);
    }
    let guard = cache.inner.lock().await;
    for (uuid, secret) in paired {
        if let Some(addr) = guard.get(&uuid).copied() {
            return Ok(Some(MotherLink {
                base_url: format!("http://{addr}"),
                token: secret,
                mother_uuid: uuid,
            }));
        }
    }
    Ok(None)
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
    /// HTTP 401 - the mother no longer recognizes our peer_secret.
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
    screen_presence: tauri::State<'_, ScreenPresence>,
    mother_uuid: String,
    // Mother-failover slice 1: the game this satellite is currently in (None
    // when idle). Drives snapshot delivery - the mother only ships a snapshot
    // for a game the satellite is actually playing. Backward-compatible: TS
    // callers that omit it send null → no snapshot requested.
    launched_game_id: Option<i64>,
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

    // The snapshot version we already cached for this game (slice 2 populates
    // mother_snapshots; until then this is None and the mother always sends a
    // fresh snapshot). Sent so the mother can skip re-shipping unchanged state.
    let known_version: Option<i64> = match launched_game_id {
        Some(gid) => {
            let conn = open_db_for_command(&app)
                .await
                .map_err(|e| PingErr::Network { message: e })?;
            conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
                Ok(c.query_row(
                    "SELECT state_version FROM mother_snapshots WHERE launched_game_id = ?",
                    params![gid],
                    |r| r.get(0),
                )
                .optional()?)
            })
            .await
            .map_err(|e| PingErr::Network { message: e.to_string() })?
        }
        None => None,
    };

    let has_reader = *reader_presence.inner.lock().await;
    // Parse the cached screen-state string into a nested object for the ping
    // body (the mother re-serialises it for storage). None when the renderer
    // hasn't reported a state yet.
    let screen_state: Value = {
        let guard = screen_presence.inner.lock().await;
        guard
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null)
    };

    let url = format!("http://{addr}/ping.php");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .connect_timeout(Duration::from_millis(700))
        .build()
        .map_err(|e| PingErr::Network { message: e.to_string() })?;

    let resp = client
        .post(&url)
        .header(header::AUTHORIZATION, format!("Bearer {secret}"))
        .json(&serde_json::json!({
            "has_reader": has_reader,
            "screen_state": screen_state,
            "known_version": known_version,
            "launched_game_id": launched_game_id,
        }))
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
        // Cached endpoint is pointing at the wrong machine - drop it so the
        // next refresh picks up the correct address (if any).
        let mut guard = cache.inner.lock().await;
        guard.remove(&mother_uuid);
        return Err(PingErr::WrongUuid { got });
    }

    // Feature A: remember the mother's Wi-Fi creds for auto-rejoin. Upsert into
    // wifi_networks (origin='paired'); NEVER touch auto_connect, so the operator's
    // consent choice survives a refreshed password.
    if let Some(w) = body.get("mother_wifi").filter(|v| v.is_object()) {
        let ssid = w.get("ssid").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let password = w.get("password").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let source = w.get("source").and_then(|v| v.as_str()).unwrap_or("hotspot").to_string();
        if !ssid.is_empty() && !password.is_empty() {
            if let Ok(conn) = open_db_for_command(&app).await {
                let _ = conn
                    .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                        c.execute(
                            "INSERT INTO wifi_networks (ssid, password, source, origin, updated_at) \
                             VALUES (?1, ?2, ?3, 'paired', datetime('now')) \
                             ON CONFLICT(ssid) DO UPDATE SET \
                               password = excluded.password, source = excluded.source, \
                               origin = 'paired', updated_at = excluded.updated_at",
                            params![ssid, password, source],
                        )?;
                        Ok(())
                    })
                    .await;
            }
        }
    }

    // Mother-failover slice 2: cache the latest snapshot to our own
    // playground.db (one "latest" row per game) so THIS device can be promoted
    // into the new mother (slice 4) if the current one dies. We store the whole
    // snapshot verbatim and key it by the game id; the strict-advance guard
    // keeps an out-of-order/stale ping from clobbering a newer cached copy.
    if let Some(snap) = body.get("snapshot").filter(|v| v.is_object()) {
        let gid = snap
            .get("game")
            .and_then(|g| g.get("id"))
            .and_then(|v| v.as_i64());
        let ver = snap.get("state_version").and_then(|v| v.as_i64());
        let epoch = snap.get("mother_epoch").and_then(|v| v.as_i64()).unwrap_or(1);
        if let (Some(gid), Some(ver)) = (gid, ver) {
            let snap_json = snap.to_string();
            if let Ok(conn) = open_db_for_command(&app).await {
                let _ = conn
                    .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                        c.execute(
                            "INSERT INTO mother_snapshots
                               (launched_game_id, state_version, mother_epoch, snapshot_json, updated_at)
                             VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
                             ON CONFLICT(launched_game_id) DO UPDATE SET
                               state_version = excluded.state_version,
                               mother_epoch  = excluded.mother_epoch,
                               snapshot_json = excluded.snapshot_json,
                               updated_at    = excluded.updated_at
                             WHERE excluded.state_version > mother_snapshots.state_version",
                            params![gid, ver, epoch, snap_json],
                        )?;
                        Ok(())
                    })
                    .await;
            }
        }
    }

    // Drain & dispatch pending commands. We emit before acking so a crash
    // mid-emit doesn't lose the work (the mother's 15-min TTL will re-issue).
    if let Some(commands) = body.get("commands").and_then(|v| v.as_array()) {
        use tauri::Emitter;
        for cmd in commands {
            // Enrich each command with the originating mother's uuid + address so
            // the renderer can repoint `launched_games` traffic at the mother
            // (a satellite must read/write the mother's game, not its own server).
            let mut enriched = cmd.clone();
            if let Some(obj) = enriched.as_object_mut() {
                obj.insert(
                    "mother_uuid".into(),
                    serde_json::Value::String(mother_uuid.clone()),
                );
                obj.insert(
                    "mother_addr".into(),
                    serde_json::Value::String(addr.to_string()),
                );
            }
            let _ = app.emit("taghunter://lan-command", enriched);
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

/// Renderer-driven setter: `services/screenState.ts` reports the device's
/// current top-most visible layer (game board / ranking / video / home) as a
/// JSON string whenever it changes. We cache it in-process; `client_ping_mother`
/// ships it on the next ping (the JS side also triggers an immediate out-of-band
/// ping so the change reaches the mother within ~1s). `json` is `None`/absent to
/// clear. The mother stores it on `paired_devices.screen_state_json` so its
/// devices modal renders a live "what's it showing" pill per peer.
#[tauri::command]
pub async fn client_set_screen_state(
    presence: tauri::State<'_, ScreenPresence>,
    json: Option<String>,
) -> Result<(), String> {
    let mut guard = presence.inner.lock().await;
    *guard = json.filter(|s| !s.is_empty());
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

    // mother_hotspot_status is best-effort - when Windows can't enumerate
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
