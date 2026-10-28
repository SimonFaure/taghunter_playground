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
// clients can browse for it on the same network without typing IPs. The
// network itself is a router / venue LAN the PCs join through Windows (the
// mother hotspot was retired 2026-09-30).
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
    // Consecutive TRANSPORT failures per mother uuid. A dead mother's address
    // used to stay warm for the whole session (only a uuid mismatch evicted
    // it), so `client_resolve_mother_link` kept handing back the corpse and the
    // 15s route tick kept re-pointing at it - the satellite could never
    // converge on the promoted mother (Ludiom #74). See `note_ping_failure`.
    fails: Mutex<HashMap<String, u32>>,
}

// Evict a mother's cached endpoint after this many consecutive transport
// failures. Two, not one: the in-game ping runs every 4s, so a genuinely dead
// mother is dropped in ~8s while a single blip costs nothing.
const ENDPOINT_EVICT_AFTER_FAILS: u32 = 2;

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

/// Client-side: this device's "Operator only device" setting, pushed by JS
/// (`services/operatorMode.ts` -> `client_set_operator_only`) at boot and on
/// toggle. Sent in every ping so the mother refuses to push a game onto it;
/// read directly for the mother's own row.
#[derive(Default)]
pub struct OperatorPresence {
    inner: Mutex<bool>,
}

/// Client-side: this device's upkeep report (app update + content sync state),
/// an opaque JSON string pushed by JS (`services/upkeepState.ts` ->
/// `client_set_upkeep`) whenever it changes. Sent in every ping so the top-bar
/// Devices modal shows what each device needs; read directly for the mother's
/// own row.
#[derive(Default)]
pub struct UpkeepPresence {
    inner: Mutex<Option<String>>,
}

/// Client-side: the pushed commands this device received, keyed by (mother
/// uuid, command id). The renderer acks a command once its handler ran
/// (`client_ack_command`, with the result); until then the mother redelivers it
/// on a later ping (at most every 30 s), which this ledger absorbs:
/// - in flight and recent: not emitted again;
/// - in flight for over `RENDERER_ACK_TIMEOUT`: acked `renderer_timeout`, so a
///   handler that never answers can't make it come back forever;
/// - handled (our ack POST was lost): acked again, not emitted again.
/// In-process only: a restart forgets it (restart_app has its own guard).
#[derive(Default)]
pub struct CommandLedger {
    inner: Mutex<HashMap<(String, i64), LedgerEntry>>,
}

enum LedgerEntry {
    Inflight(Instant),
    Handled(Instant, Option<Value>),
}

const RENDERER_ACK_TIMEOUT: Duration = Duration::from_secs(45);
const LEDGER_KEEP: Duration = Duration::from_secs(2 * 60 * 60);

struct Running {
    port: u16,
    shutdown: oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
    mdns: Option<MdnsHandle>,
    // Kept so the mDNS announcement can be re-registered (e.g. once the PC gets
    // a LAN address) without restarting the whole server.
    mother_uuid: String,
    mdns_label: Option<String>,
    // Mother-failover slice 3: advertised in the mDNS TXT so a re-pointing
    // satellite can match the mother serving ITS client and pick the highest
    // epoch (slice 5/6). epoch = max(mother_epoch) over this client's games at
    // boot; a promotion re-registers mDNS with a higher value.
    client_id: i64,
    epoch: i64,
    // Why this device hosts: the mother set in "Rôle de ce poste", or a
    // substitute standing in for it. Advertised with `since` (see `HostRole`).
    role: HostRole,
    since: i64,
}

/// Who is serving. `Mother` is the device configured as the mother (the
/// install-time choice, or a later "Rôle de ce poste"). `Substitute` took a
/// game over while the mother was away: it hands everything back and stops
/// serving as soon as a `Mother` is on the network again.
///
/// Advertised in the mDNS TXT (`role` = `m` / `s`) and in the hello reply, with
/// `since` = when the device was designated mother (ms since epoch, 0 unknown).
/// Two configured mothers on one network: the later designation keeps the role.
/// A peer that advertises no role runs an older build.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostRole {
    Mother,
    Substitute,
}

impl HostRole {
    fn from_configured(configured: Option<bool>) -> Self {
        if configured == Some(true) { Self::Mother } else { Self::Substitute }
    }
    fn code(self) -> &'static str {
        match self {
            Self::Mother => "m",
            Self::Substitute => "s",
        }
    }
}

/// Must this device stand down for a mother it discovered?
///
/// - A substitute always does: it never competes with anyone already serving.
/// - The configured mother ignores substitutes (they yield to it).
/// - Two configured mothers: the later designation wins; with no usable date
///   on either side the lower uuid serves, so exactly one of them does.
/// - A peer with no role (older build): the pre-role rule, first one up wins.
pub(crate) fn must_stand_down(
    my_role: HostRole,
    my_since: i64,
    my_uuid: &str,
    their_role: Option<&str>,
    their_since: Option<i64>,
    their_uuid: &str,
) -> bool {
    match (my_role, their_role) {
        (HostRole::Substitute, _) => true,
        (HostRole::Mother, Some("s")) => false,
        (HostRole::Mother, Some("m")) => {
            let theirs = their_since.unwrap_or(0);
            theirs > my_since || (theirs == my_since && their_uuid < my_uuid)
        }
        (HostRole::Mother, _) => true,
    }
}

struct MdnsHandle {
    daemon: ServiceDaemon,
    full_name: String,
    /// The addresses this announcement carries (sorted). Compared against the
    /// host's current ones so a Wi-Fi change re-announces the new IP.
    advertised: Vec<String>,
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
// reach the axum server over the LAN (Windows blocks custom inbound TCP by
// default, always on a "Public" network, and blocks custom inbound TCP by default - mDNS multicast is
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
    let name_ports = "name=TagHunter Playground LAN Ports";
    for n in [name, name_ports] {
        let _ = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "delete", "rule", n])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    // Remove ANY inbound rules bound to our exe - crucially the auto-created BLOCK
    // rules Windows adds when a "Windows Security Alert" prompt is declined. A
    // Block rule overrides every Allow rule, so the adds below do nothing until
    // these are gone (the "port allow rule has no effect, only turning the whole
    // firewall off works" symptom). Best-effort - only bites when already elevated.
    let _ = std::process::Command::new("netsh")
        .args([
            "advfirewall", "firewall", "delete", "rule", "name=all", "dir=in",
            &format!("program={exe}"),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    // TCP for the mother's axum server AND UDP for mDNS discovery (port 5353):
    // a satellite can't even DISCOVER the mother if the Public profile blocks
    // inbound mDNS, so both protocols must be allowed for our exe.
    for proto in ["TCP", "UDP"] {
        let _ = std::process::Command::new("netsh")
            .args([
                "advfirewall", "firewall", "add", "rule", name,
                "dir=in", "action=allow", "enable=yes", "profile=any",
                &format!("protocol={proto}"), &format!("program={exe}"),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    // Also allow the well-known LAN ports by NUMBER, independent of the exe path.
    // A program-scoped rule silently fails to cover inbound TCP when the stored
    // image path diverges from the running one (rebuild / reinstall to a new
    // location / 8.3 short name / junction) - the child then sees the mother over
    // mDNS but its TCP connect is dropped ("deadline has elapsed"). A port rule
    // has no such dependency, so this is the reliable inbound path to the server.
    for (proto, ports) in [("TCP", "47800-47803"), ("UDP", "5353")] {
        let _ = std::process::Command::new("netsh")
            .args([
                "advfirewall", "firewall", "add", "rule", name_ports,
                "dir=in", "action=allow", "enable=yes", "profile=any",
                &format!("protocol={proto}"), &format!("localport={ports}"),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

#[cfg(not(target_os = "windows"))]
fn try_open_firewall() {}

// Add the inbound firewall rules WITH ELEVATION. The plain `try_open_firewall`
// above only works when the app already runs as admin (rare); on a normal install
// the rule is never added, so satellites on a "Public" network profile can't
// open a TCP connection to the mother's server (mDNS multicast still works, which
// is why the mother is *discoverable* but *unreachable*). This escalates via a
// single UAC prompt (an elevated PowerShell script).
//
// CRITICAL: it does not just ADD allow rules - it first DELETES any inbound BLOCK
// rules that cover our exe. Windows auto-creates program-scoped inbound *block*
// rules when the user clicks "Cancel"/"Block" on the "Windows Security Alert"
// firewall prompt, and a Block rule OVERRIDES every Allow rule - so allow rules
// (program- or port-scoped) never take effect until the blocks are removed. That
// is the exact "an explicit port allow rule does nothing, only turning the whole
// firewall off works" symptom. We match block rules by full exe path OR by exe
// leaf name (so blocks left over from a previous install location are cleared too).
#[cfg(target_os = "windows")]
fn add_firewall_rule_elevated() -> bool {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return false,
    };
    let exe_ps = exe.replace('\'', "''");
    let name = "TagHunter Playground LAN";
    // All-cmdlet (NetSecurity) so a path with spaces needs no netsh quoting.
    //  1) remove inbound BLOCK rules covering our exe (the override that made
    //     allow rules useless),
    //  2) clear our own named rules for an idempotent re-add,
    //  3) add program-scoped (TCP+UDP) AND port-scoped (TCP 47800-47803 + UDP
    //     5353) allow rules - the port rule is path-independent, so it survives a
    //     rebuild/reinstall to a new location.
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'\r\n\
         $exe='{exe_ps}'\r\n\
         $leaf=Split-Path $exe -Leaf\r\n\
         Get-NetFirewallRule -Direction Inbound -Action Block | ForEach-Object {{\r\n\
         $f = $_ | Get-NetFirewallApplicationFilter\r\n\
         if ($f -and $f.Program -and ($f.Program -eq $exe -or $f.Program -like ('*\\' + $leaf))) {{ $_ | Remove-NetFirewallRule }}\r\n\
         }}\r\n\
         Remove-NetFirewallRule -DisplayName '{name}'\r\n\
         Remove-NetFirewallRule -DisplayName '{name} Ports'\r\n\
         New-NetFirewallRule -DisplayName '{name}' -Direction Inbound -Action Allow -Profile Any -Protocol TCP -Program $exe -Enabled True | Out-Null\r\n\
         New-NetFirewallRule -DisplayName '{name}' -Direction Inbound -Action Allow -Profile Any -Protocol UDP -Program $exe -Enabled True | Out-Null\r\n\
         New-NetFirewallRule -DisplayName '{name} Ports' -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort 47800-47803 -Enabled True | Out-Null\r\n\
         New-NetFirewallRule -DisplayName '{name} Ports' -Direction Inbound -Action Allow -Profile Any -Protocol UDP -LocalPort 5353 -Enabled True | Out-Null\r\n\
         exit 0\r\n"
    );
    matches!(run_elevated_powershell(&script), Ok(0))
}

#[cfg(not(target_os = "windows"))]
fn add_firewall_rule_elevated() -> bool {
    true
}

/// Ensure the mother's inbound LAN port is allowed through the firewall, with a
/// one-time UAC elevation if needed. Returns true if the elevated rule was added
/// (or we're not on Windows). Callers persist the result so the prompt appears at
/// most once per machine; the Network-tab "repair" button calls it on demand.
#[tauri::command]
pub async fn mother_open_firewall_elevated() -> Result<bool, String> {
    // Cheap best-effort first (works if already elevated), then the UAC path.
    let _ = tokio::task::spawn_blocking(try_open_firewall).await;
    let ok = tokio::task::spawn_blocking(add_firewall_rule_elevated)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ok)
}

// Read-only check that the "TagHunter Playground LAN" rule exists in the live
// firewall AND still points at the CURRENTLY-running exe. The persisted
// 'firewall_rule_added' flag alone was untrustworthy: the NSIS uninstaller
// deletes the rule while app data (+ the flag) survive a reinstall, GPO/AV
// cleanups delete rules, and - crucially - the rule is program-scoped to an
// exact .exe PATH, so a rebuild/reinstall to a NEW location leaves a rule that
// exists by name but no longer covers the running app: mother discoverable over
// mDNS, unreachable over TCP, and Diagnostics falsely reads "OK".
//
// We query the rule's program path via PowerShell Get-NetFirewallApplicationFilter
// (structured, proper Unicode) rather than netsh's LOCALIZED + OEM-codepage
// verbose dump - the codepage is why a plain substring match missed accented
// install paths (common in France). No elevation needed.
//
// Some(true) = rule present and covers this exe (or is program=Any, or we
// couldn't read either path so we don't nag); Some(false) = absent OR stale
// (points at a different exe) → the caller clears the flag and re-adds it for
// the current exe; None = could not run the check (callers keep trusting the flag).
#[cfg(target_os = "windows")]
fn firewall_rule_status_sync() -> Option<bool> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let ps = "$ErrorActionPreference='SilentlyContinue';\
        $r = Get-NetFirewallRule -DisplayName 'TagHunter Playground LAN';\
        if (-not $r) { Write-Output 'ABSENT'; exit 0 };\
        $p = ($r | Get-NetFirewallApplicationFilter | Select-Object -First 1 -ExpandProperty Program);\
        Write-Output ('PROGRAM=' + $p)";
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ps])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    if text.contains("ABSENT") {
        return Some(false); // no rule with that name → re-add
    }
    let rule_prog = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("PROGRAM="))
        .map(|s| s.trim().to_lowercase());
    let cur = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().to_lowercase());
    match (rule_prog, cur) {
        (Some(rp), Some(cur)) if !rp.is_empty() => {
            if rp == cur || rp == "any" {
                Some(true) // covers the running exe (or any program)
            } else {
                eprintln!(
                    "[lan_server] firewall rule points at a different exe (stale): '{rp}' != '{cur}' - flagging for re-add"
                );
                Some(false) // stale rule from a previous build/install location
            }
        }
        // Rule exists but we couldn't read its program path (or ours) - don't
        // nag-loop the UAC prompt; assume it's fine.
        _ => Some(true),
    }
}

#[cfg(not(target_os = "windows"))]
fn firewall_rule_status_sync() -> Option<bool> {
    Some(true)
}

/// `Some(true)` rule present and covers the running exe, `Some(false)` absent OR
/// stale (points at a different exe - the caller should clear its persisted flag
/// and re-run the one-time UAC add), `None` indeterminate (keep trusting the flag).
#[tauri::command]
pub async fn mother_firewall_rule_status() -> Result<Option<bool>, String> {
    tokio::task::spawn_blocking(firewall_rule_status_sync)
        .await
        .map_err(|e| e.to_string())
}

// Slice 6 sentinel: `mother_start_local_server` returns this (recognizable by
// the TS `ensureMotherServer`) when it stands down because another device is
// already the mother at a higher epoch. Not a real error - a deliberate refusal.
pub const MOTHER_SUPERSEDED: &str = "mother_superseded: another device is the current mother (higher epoch)";

/// LAN protocol version. Every device of a fleet must speak the same one: a
/// mother refuses satellites on another version (HTTP 426 `LAN_PROTO_MISMATCH`)
/// and a satellite refuses such a mother. A peer that sends none is a
/// hotspot-era build = 1. Bump ONLY for a breaking LAN change, never per release.
pub const LAN_PROTO: u32 = 2;
const LAN_PROTO_HEADER: &str = "x-lan-proto";

/// A reqwest client builder for satellite -> mother calls: carries the
/// `X-Lan-Proto` header on every request.
pub(crate) fn lan_client_builder() -> reqwest::ClientBuilder {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        LAN_PROTO_HEADER,
        reqwest::header::HeaderValue::from(LAN_PROTO),
    );
    reqwest::Client::builder().default_headers(headers)
}

/// The LAN protocol a mother announced in a JSON reply (1 when absent).
fn announced_proto(body: &Value) -> u32 {
    body.get("lan_proto").and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(1)
}

/// Mother-side gate: refuse any LAN request from a peer on another protocol.
/// Exempt: loopback (this device's own renderer), `pair.php?action=hello`,
/// which old peers may still call to read our version, and `/update.php`
/// (an outdated satellite updates from us). Requests served without
/// ConnectInfo (unit tests) are let through.
async fn lan_proto_gate(request: Request<Body>, next: axum::middleware::Next) -> Response {
    let remote = request
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|c| c.0);
    let is_hello = request.uri().path() == "/pair.php"
        && request.uri().query().map_or(false, |q| q.split('&').any(|kv| kv == "action=hello"));
    // App updates work across protocol versions: an outdated satellite must be
    // able to fetch the installer that brings it back to ours.
    let is_update = request.uri().path() == "/update.php";
    let exempt = match remote {
        None => true,
        Some(a) => a.ip().is_loopback(),
    };
    if exempt || is_hello || is_update {
        return next.run(request).await;
    }
    let peer_proto = request
        .headers()
        .get(LAN_PROTO_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(1);
    if peer_proto == LAN_PROTO {
        return next.run(request).await;
    }
    (
        StatusCode::UPGRADE_REQUIRED,
        Json(json!({
            "error": "LAN_PROTO_MISMATCH",
            "peer_proto": peer_proto,
            "lan_proto": LAN_PROTO,
            "app_version": crate::app_version(),
        })),
    )
        .into_response()
}

// F13: preferred well-known ports for the mother's axum server. Binding a
// predictable port lets a satellite pair by typing only the mother's IP
// (`client_pair_by_address` probes these in order) when mDNS multicast is
// filtered by the router or venue network. The server still advertises its
// ACTUAL bound port over mDNS, so a rare conflict that forces the OS-picked
// fallback below only loses the by-address path, never discovery itself.
pub const PREFERRED_PORTS: [u16; 4] = [47800, 47801, 47802, 47803];

/// Bind the axum listener. `requested == 0` means "OS picks" from the caller,
/// but we first try the PREFERRED_PORTS in order (so pairing by address
/// has a known port to hit) and fall back to an OS-assigned port only if they
/// are all taken. A non-zero `requested` is honored verbatim (tests / explicit).
async fn bind_mother_listener(requested: u16) -> std::io::Result<TcpListener> {
    if requested != 0 {
        return TcpListener::bind(format!("0.0.0.0:{requested}")).await;
    }
    for p in PREFERRED_PORTS {
        if let Ok(l) = TcpListener::bind(format!("0.0.0.0:{p}")).await {
            return Ok(l);
        }
    }
    TcpListener::bind("0.0.0.0:0").await
}

#[tauri::command]
pub async fn mother_start_local_server(
    app: AppHandle,
    state: tauri::State<'_, MotherServerState>,
    client_id: i64,
    port: u16,
    mdns_label: Option<String>,
    // true = this device is set as the mother ("Rôle de ce poste"); anything
    // else starts it as a substitute. `designated_at` is when it was set (ms).
    configured: Option<bool>,
    designated_at: Option<i64>,
) -> Result<MotherServerInfo, String> {
    let role = HostRole::from_configured(configured);
    let since = if role == HostRole::Mother { designated_at.unwrap_or(0) } else { 0 };
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

    // Boot fence: never start a second, competing server. Who stands down is
    // decided by ROLE (`must_stand_down`), not by who booted first: the device
    // set as the mother starts even when a substitute is serving (the
    // substitute then yields to it), while a substitute, or a mother facing a
    // later-designated mother, stands down. Presence used to decide alone, so
    // the mother changed PC with the power-on order.
    //
    // Epoch plays no part here: it only orders two devices claiming the SAME
    // game (the runtime yield poll + re-point use it for that). Comparing ours
    // to a mother hosting a DIFFERENT game is meaningless.
    {
        // Whether this device still holds a live game - used by the error path
        // below: a game-holding device must keep serving even when the browse is
        // broken (never strand a live game); a willing-but-idle one fails closed.
        let has_active_game = conn
            .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
                let n: i64 = c.query_row(
                    "SELECT COUNT(*) FROM lg_launched_games WHERE client_id = ? AND ended = 0",
                    params![client_id],
                    |r| r.get(0),
                )?;
                Ok(n > 0)
            })
            .await
            .unwrap_or(false);
        // A browse ERROR (mdns daemon failure, blocked inbound UDP 5353) used to
        // skip the fence entirely - a silent split-brain enabler. Treat it as
        // indeterminate instead: retry once, then fail closed while idle.
        let browsed = match run_mdns_discovery(Duration::from_millis(2500)).await {
            Ok(m) => Ok(m),
            Err(_) => run_mdns_discovery(Duration::from_millis(2000)).await,
        };
        match browsed {
            Ok(mothers) => {
                let my_uuid = &self_pair.mother_device_uuid;
                // A mother on another LAN protocol (an outdated build) can't
                // serve our satellites anyway - never stand down for it.
                let superseded = mothers.iter().any(|m| {
                    &m.mother_uuid != my_uuid
                        && m.client_id == Some(client_id)
                        && m.lan_proto == LAN_PROTO
                        && must_stand_down(role, since, my_uuid, m.role.as_deref(), m.since, &m.mother_uuid)
                });
                if superseded {
                    return Err(MOTHER_SUPERSEDED.into());
                }
            }
            Err(e) => {
                // The device set as the mother starts regardless: it is the one
                // every other device defers to.
                if !has_active_game && role != HostRole::Mother {
                    // Sentinel prefix kept so the TS caller treats this as a calm
                    // stand-down (and its delayed re-check retries once mDNS works).
                    return Err(format!(
                        "{MOTHER_SUPERSEDED} [fence browse failed twice: {e} - refusing to start a possibly-duplicate mother while idle]"
                    ));
                }
                eprintln!(
                    "[lan_server] fence browse failed twice ({e}) - serving anyway: this device holds a live game."
                );
            }
        }
    }

    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        Ok(note_hosting_role(c, role)?)
    })
    .await
    .map_err(|e| format!("record hosting role: {e}"))?;

    let app_state = AppState {
        db: Arc::new(conn),
        media_root: resolve_media_root(&app)?,
        client_id,
        mother_uuid: self_pair.mother_device_uuid.clone(),
        self_peer_id: self_pair.peer_id,
        last_bump: Arc::new(Mutex::new(HashMap::new())),
        app: app.clone(),
        role,
        since,
        content_slots: crate::content_server::Slots::new(),
    };

    let app_router = build_router(app_state);
    let listener = bind_mother_listener(port)
        .await
        .map_err(|e| format!("bind mother listener (requested {port}): {e}"))?;
    let actual = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;
    let actual_port = actual.port();

    // Open the firewall for our exe so satellites can connect (best-effort).
    let _ = tokio::task::spawn_blocking(try_open_firewall).await;

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app_router.into_make_service_with_connect_info::<SocketAddr>(),
        )
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    // Register mDNS broadcast (best-effort: failure shouldn't kill the server).
    // start_mdns advertises this host's LAN IPv4s (router / venue network).
    let mdns = match start_mdns(&self_pair.mother_device_uuid, mdns_label.as_deref(), actual_port, client_id, epoch, role, since) {
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
        role,
        since,
    });

    Ok(MotherServerInfo {
        port: actual_port,
        bound_addr: actual.to_string(),
        mother_device_uuid: self_pair.mother_device_uuid,
        mother_peer_secret: self_pair.peer_secret,
        mother_peer_id: self_pair.peer_id,
    })
}

/// Record why this device is about to serve. A substitute remembers the mother
/// it stands in for (the one it last followed) so the Network page can say
/// "en remplacement de PC2"; a configured mother forgets any such note. Display
/// only: nothing decides on these keys.
fn note_hosting_role(c: &rusqlite::Connection, role: HostRole) -> rusqlite::Result<()> {
    if role == HostRole::Mother {
        c.execute(
            "DELETE FROM schema_meta WHERE key IN ('substitute_for_uuid', 'substitute_for_label')",
            [],
        )?;
        return Ok(());
    }
    let lost: Option<(String, Option<String>)> = c
        .query_row(
            "SELECT mother_uuid, mother_label FROM paired_mothers
             ORDER BY last_seen_at IS NULL, last_seen_at DESC, paired_at DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    // No paired mother = a substitute starting again after its own takeover
    // (which dropped the rows): keep what it noted then.
    if let Some((uuid, label)) = lost {
        for (key, value) in [("substitute_for_uuid", Some(uuid)), ("substitute_for_label", label)] {
            match value {
                Some(v) => c.execute(
                    "INSERT INTO schema_meta(key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, v],
                )?,
                None => c.execute("DELETE FROM schema_meta WHERE key = ?", params![key])?,
            };
        }
    }
    Ok(())
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
    /// Every game this promotion took over: the requested one first, then the
    /// `also_game_ids` that passed their guards.
    pub adopted_game_ids: Vec<i64>,
    /// The `also_game_ids` left behind, with why.
    pub skipped_games: Vec<SkippedGame>,
}

#[derive(Serialize)]
pub struct SkippedGame {
    pub id: i64,
    /// `no_cached_snapshot`, `corrupt_snapshot`, `other_mother`, `ended`,
    /// `wrong_client`, `no_content` or `stale_snapshot`.
    pub reason: String,
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
    // Optional so a snapshot written by an older build (which didn't carry it)
    // still parses; it simply mirrors as NULL, exactly as before.
    ended_at: Option<i64>,
    // Per-game version (migration 37). A snapshot from a build that doesn't
    // carry it falls back to the snapshot's device-wide counter.
    state_version: i64,
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
// Clash V2 per-game state (empty vecs for non-clash games and for snapshots
// taken before these tables were captured).
struct ClashMemberRow { id: i64, team_id: i64, chip_id: i64, created_at: String }
struct ClashValidationRow {
    id: i64,
    team_id: i64,
    chip_id: i64,
    combo_index: i64,
    territory_index: i64,
    seq: i64,
    created_at: String,
}
struct ClashConsumedRow { id: i64, chip_id: i64, punch_key: String, created_at: String }
struct ClashEffectifRow { team_id: i64, size: i64 }
struct ClashPurgeRow {
    id: i64,
    team_id: i64,
    chip_id: i64,
    territory_index: i64,
    seq: i64,
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

/// Everything a snapshot says about one launched game, parsed and validated
/// BEFORE any DB work so shape problems surface as clear errors instead of
/// half-applied writes.
struct SnapshotRows {
    game: GameRow,
    mother_epoch: i64,
    state_version: i64,
    paired_devices: Vec<PdRow>,
    meta: Vec<MetaRow>,
    devices: Vec<DevRow>,
    raw_data: Vec<RawRow>,
    teams: Vec<TeamRow>,
    cqs: Vec<CqRow>,
    clash_members: Vec<ClashMemberRow>,
    clash_validations: Vec<ClashValidationRow>,
    clash_consumed: Vec<ClashConsumedRow>,
    clash_effectif: Vec<ClashEffectifRow>,
    clash_purges: Vec<ClashPurgeRow>,
}

/// Parse a cached snapshot into typed rows. Shared by `become_mother` (which
/// takes ownership of the game) and `apply_mother_snapshot` (which only mirrors
/// it), so the two can never disagree about the wire shape.
fn parse_snapshot_rows(snap: &Value) -> Result<SnapshotRows, String> {
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
        ended_at: vi64(game_v, "ended_at"),
        state_version: vi64(game_v, "state_version")
            .or_else(|| vi64(snap, "state_version"))
            .unwrap_or(0),
    };

    let arr =|k: &str| snap.get(k).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut paired_devices = Vec::new();
    for v in arr("paired_devices") {
        paired_devices.push(PdRow {
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
    let mut clash_members = Vec::new();
    for v in arr("clash_members") {
        clash_members.push(ClashMemberRow {
            id: req_i64(&v, "id")?,
            team_id: req_i64(&v, "team_id")?,
            chip_id: req_i64(&v, "chip_id")?,
            created_at: vstr(&v, "created_at").unwrap_or_default(),
        });
    }
    let mut clash_validations = Vec::new();
    for v in arr("clash_validations") {
        clash_validations.push(ClashValidationRow {
            id: req_i64(&v, "id")?,
            team_id: req_i64(&v, "team_id")?,
            chip_id: req_i64(&v, "chip_id")?,
            combo_index: req_i64(&v, "combo_index")?,
            territory_index: req_i64(&v, "territory_index")?,
            seq: req_i64(&v, "seq")?,
            created_at: vstr(&v, "created_at").unwrap_or_default(),
        });
    }
    let mut clash_consumed = Vec::new();
    for v in arr("clash_consumed") {
        clash_consumed.push(ClashConsumedRow {
            id: req_i64(&v, "id")?,
            chip_id: req_i64(&v, "chip_id")?,
            punch_key: req_str(&v, "punch_key")?,
            created_at: vstr(&v, "created_at").unwrap_or_default(),
        });
    }
    let mut clash_effectif = Vec::new();
    for v in arr("clash_effectif") {
        clash_effectif.push(ClashEffectifRow {
            team_id: req_i64(&v, "team_id")?,
            size: req_i64(&v, "size")?,
        });
    }
    let mut clash_purges = Vec::new();
    for v in arr("clash_purges") {
        clash_purges.push(ClashPurgeRow {
            id: req_i64(&v, "id")?,
            team_id: req_i64(&v, "team_id")?,
            chip_id: req_i64(&v, "chip_id")?,
            territory_index: req_i64(&v, "territory_index")?,
            seq: req_i64(&v, "seq")?,
            created_at: vstr(&v, "created_at").unwrap_or_default(),
        });
    }

    Ok(SnapshotRows {
        game,
        mother_epoch: vi64(snap, "mother_epoch").unwrap_or(1),
        state_version: vi64(snap, "state_version").unwrap_or(0),
        paired_devices,
        meta,
        devices,
        raw_data,
        teams,
        cqs,
        clash_members,
        clash_validations,
        clash_consumed,
        clash_effectif,
        clash_purges,
    })
}

/// Row ids are allocated per DEVICE (AUTOINCREMENT), but a snapshot carries the
/// mother's ids verbatim. A device that hosted or mirrored OTHER games can
/// therefore already hold a row with one of the snapshot's ids under a different
/// `launched_game_id` - the adopt then died on "UNIQUE constraint failed:
/// lg_launched_game_raw_data.id" and every retry hit the same wall (retours
/// sept. #15). The snapshot's ids must be preserved (satellites address the game
/// by them), so it is the LOCAL, unrelated rows that move to fresh ids.
///
/// Same `lg_launched_games.id` with a different `summary_uuid` is an unrelated
/// game that happens to share the number: it used to be silently deleted by the
/// wholesale replace; it is now moved aside with its children instead.
///
/// FK checks are deferred to commit so a parent id and its children can be
/// renumbered in either order.
fn rekey_conflicting_local_rows(tx: &rusqlite::Transaction, rows: &SnapshotRows) -> rusqlite::Result<()> {
    tx.pragma_update(None, "defer_foreign_keys", "ON")?;
    let game_id = rows.game.id;

    // Tables whose children point at a launched game.
    const GAME_CHILDREN: [&str; 9] = [
        "lg_launched_game_meta",
        "lg_launched_game_devices",
        "lg_launched_game_raw_data",
        "lg_teams",
        "lg_team_completed_quests",
        "lg_clash_members",
        "lg_clash_validations",
        "lg_clash_consumed",
        "lg_clash_effectif",
    ];
    fn next_id(tx: &rusqlite::Transaction, table: &str) -> rusqlite::Result<i64> {
        let max_row: i64 = tx.query_row(&format!("SELECT COALESCE(MAX(id), 0) FROM {table}"), [], |r| r.get(0))?;
        let seq: i64 = tx
            .query_row("SELECT seq FROM sqlite_sequence WHERE name = ?", params![table], |r| r.get(0))
            .optional()?
            .unwrap_or(0);
        Ok(max_row.max(seq) + 1)
    }

    // 1. The game row itself.
    let local_uuid: Option<String> = tx
        .query_row("SELECT summary_uuid FROM lg_launched_games WHERE id = ?", params![game_id], |r| r.get(0))
        .optional()?;
    if let Some(u) = local_uuid {
        if u != rows.game.summary_uuid {
            let new_gid = next_id(tx, "lg_launched_games")?;
            tx.execute("UPDATE lg_launched_games SET id = ?1 WHERE id = ?2", params![new_gid, game_id])?;
            for t in GAME_CHILDREN.iter().chain(["lg_clash_purges"].iter()) {
                tx.execute(
                    &format!("UPDATE {t} SET launched_game_id = ?1 WHERE launched_game_id = ?2"),
                    params![new_gid, game_id],
                )?;
            }
            // Summaries carry no FK; follow the moved game by its uuid only.
            tx.execute(
                "UPDATE lg_game_summaries SET launched_game_id = ?1
                  WHERE launched_game_id = ?2 AND summary_uuid = ?3",
                params![new_gid, game_id, u],
            )?;
        }
    }

    // 2. Teams (parent of completed quests + clash rows) of OTHER games.
    for t in &rows.teams {
        let other: Option<i64> = tx
            .query_row(
                "SELECT launched_game_id FROM lg_teams WHERE id = ?1 AND launched_game_id <> ?2",
                params![t.id, game_id],
                |r| r.get(0),
            )
            .optional()?;
        if other.is_some() {
            let new_id = next_id(tx, "lg_teams")?;
            tx.execute("UPDATE lg_teams SET id = ?1 WHERE id = ?2", params![new_id, t.id])?;
            for child in [
                "lg_team_completed_quests",
                "lg_clash_members",
                "lg_clash_validations",
                "lg_clash_effectif",
                "lg_clash_purges",
            ] {
                tx.execute(
                    &format!("UPDATE {child} SET team_id = ?1 WHERE team_id = ?2 AND launched_game_id <> ?3"),
                    params![new_id, t.id, game_id],
                )?;
            }
        }
    }

    // 3. Leaf rows: nothing references their ids.
    let leaf = |table: &str, ids: Vec<i64>| -> rusqlite::Result<()> {
        for id in ids {
            let clash: bool = tx
                .query_row(
                    &format!("SELECT 1 FROM {table} WHERE id = ?1 AND launched_game_id <> ?2"),
                    params![id, game_id],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if clash {
                let new_id = next_id(tx, table)?;
                tx.execute(&format!("UPDATE {table} SET id = ?1 WHERE id = ?2"), params![new_id, id])?;
            }
        }
        Ok(())
    };
    leaf("lg_launched_game_raw_data", rows.raw_data.iter().map(|r| r.id).collect())?;
    leaf("lg_team_completed_quests", rows.cqs.iter().map(|r| r.id).collect())?;
    leaf("lg_clash_members", rows.clash_members.iter().map(|r| r.id).collect())?;
    leaf("lg_clash_validations", rows.clash_validations.iter().map(|r| r.id).collect())?;
    leaf("lg_clash_consumed", rows.clash_consumed.iter().map(|r| r.id).collect())?;
    leaf("lg_clash_purges", rows.clash_purges.iter().map(|r| r.id).collect())?;
    Ok(())
}

/// Replace one launched game's rows with the snapshot's, inside the caller's
/// transaction. The DELETE cascades the children, so this is a wholesale
/// replacement, not a merge: the mother is the truth.
///
/// LEGALITY: the game's `device_id` references (`lg_launched_game_devices`,
/// `lg_launched_game_raw_data`) point into `paired_devices` by convention -
/// there is no FK - so applying game rows WITHOUT rebuilding the pairing table
/// is only sound because `become_mother` preserves `paired_devices.id` when it
/// adopts. Do not "optimise" that id preservation away; this function depends
/// on it.
///
/// `preserve_launched_by_self` guards a per-DEVICE fact that must never travel
/// with the mother's copy: it drives the `mine=1` filter behind the "This
/// device" list. A mirroring device (Ludiom #76) keeps its own value, or the
/// very act of correcting the game's status would delete it from that list.
/// A promoting device passes false, matching the pre-refactor behaviour: it
/// surfaces the game through its participant row instead.
fn apply_game_rows(
    tx: &rusqlite::Transaction,
    rows: &SnapshotRows,
    mother_epoch: i64,
    preserve_launched_by_self: bool,
) -> rusqlite::Result<()> {
    let game = &rows.game;
    let game_id = game.id;
    let launched_by_self: i64 = if preserve_launched_by_self {
        tx.query_row(
            "SELECT launched_by_self FROM lg_launched_games WHERE id = ? AND summary_uuid = ?",
            params![game_id, game.summary_uuid],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0)
    } else {
        0
    };

    rekey_conflicting_local_rows(tx, rows)?;
    tx.execute("DELETE FROM lg_launched_games WHERE id = ?", params![game_id])?;
    tx.execute(
        "INSERT INTO lg_launched_games
           (id, summary_uuid, client_id, game_uniqid, name, number_of_teams,
            game_type, duration, start_time, started, ended, mother_epoch, created_at,
            ended_at, launched_by_self, state_version)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,
                 COALESCE(NULLIF(?13,''), CURRENT_TIMESTAMP), ?14, ?15, ?16)",
        params![
            game.id, game.summary_uuid, game.client_id, game.game_uniqid, game.name,
            game.number_of_teams, game.game_type, game.duration, game.start_time,
            game.started as i64, game.ended as i64, mother_epoch, game.created_at,
            game.ended_at, launched_by_self, game.state_version
        ],
    )?;
    for m in &rows.meta {
        tx.execute(
            "INSERT INTO lg_launched_game_meta (launched_game_id, meta_name, meta_value)
             VALUES (?1, ?2, ?3)",
            params![game_id, m.meta_name, m.meta_value],
        )?;
    }
    for d in &rows.devices {
        tx.execute(
            "INSERT INTO lg_launched_game_devices
               (launched_game_id, device_id, device_label, os, os_version, connected)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![game_id, d.device_id, d.device_label, d.os, d.os_version, d.connected as i64],
        )?;
    }
    for r in &rows.raw_data {
        tx.execute(
            "INSERT INTO lg_launched_game_raw_data
               (id, launched_game_id, device_id, raw_data, created_at)
             VALUES (?1, ?2, ?3, ?4, COALESCE(NULLIF(?5,''), CURRENT_TIMESTAMP))",
            params![r.id, game_id, r.device_id, r.raw_data, r.created_at],
        )?;
    }
    for t in &rows.teams {
        tx.execute(
            "INSERT INTO lg_teams
               (id, launched_game_id, team_number, team_name, pattern, score,
                key_id, start_time, end_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![t.id, game_id, t.team_number, t.team_name, t.pattern, t.score, t.key_id, t.start_time, t.end_time],
        )?;
    }
    for q in &rows.cqs {
        tx.execute(
            "INSERT INTO lg_team_completed_quests
               (id, launched_game_id, team_id, teammate_chip_id, quest_id,
                quest_number, points_awarded, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(NULLIF(?8,''), CURRENT_TIMESTAMP))",
            params![q.id, game_id, q.team_id, q.teammate_chip_id, q.quest_id, q.quest_number, q.points_awarded, q.created_at],
        )?;
    }
    // Clash V2 state (empty for non-clash games / older snapshots). Ordered
    // after lg_teams - these rows FK onto it.
    for m in &rows.clash_members {
        tx.execute(
            "INSERT INTO lg_clash_members (id, launched_game_id, team_id, chip_id, created_at)
             VALUES (?1, ?2, ?3, ?4, COALESCE(NULLIF(?5,''), CURRENT_TIMESTAMP))",
            params![m.id, game_id, m.team_id, m.chip_id, m.created_at],
        )?;
    }
    for vr in &rows.clash_validations {
        tx.execute(
            "INSERT INTO lg_clash_validations
               (id, launched_game_id, team_id, chip_id, combo_index, territory_index, seq, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(NULLIF(?8,''), CURRENT_TIMESTAMP))",
            params![vr.id, game_id, vr.team_id, vr.chip_id, vr.combo_index, vr.territory_index, vr.seq, vr.created_at],
        )?;
    }
    for cr in &rows.clash_consumed {
        tx.execute(
            "INSERT INTO lg_clash_consumed (id, launched_game_id, chip_id, punch_key, created_at)
             VALUES (?1, ?2, ?3, ?4, COALESCE(NULLIF(?5,''), CURRENT_TIMESTAMP))",
            params![cr.id, game_id, cr.chip_id, cr.punch_key, cr.created_at],
        )?;
    }
    for e in &rows.clash_effectif {
        tx.execute(
            "INSERT INTO lg_clash_effectif (launched_game_id, team_id, size)
             VALUES (?1, ?2, ?3)",
            params![game_id, e.team_id, e.size],
        )?;
    }
    for p in &rows.clash_purges {
        tx.execute(
            "INSERT INTO lg_clash_purges
               (id, launched_game_id, team_id, chip_id, territory_index, seq, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(NULLIF(?7,''), CURRENT_TIMESTAMP))",
            params![p.id, game_id, p.team_id, p.chip_id, p.territory_index, p.seq, p.created_at],
        )?;
    }
    // Keep the language column on teams in sync (separate UPDATE so the INSERT
    // column list stays aligned with the base schema).
    for t in &rows.teams {
        if let Some(lang) = &t.language {
            tx.execute("UPDATE lg_teams SET language = ?1 WHERE id = ?2", params![lang, t.id])?;
        }
    }
    Ok(())
}

/// Promote THIS device (a satellite holding a cached snapshot) into the new
/// mother for `launched_game_id`. Adopts the snapshot's game state + pairing
/// table, bumps the epoch, and starts the local server + mDNS on the LAN.
/// See plans/mother-failover-promote-any-device.md.
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
    cache: tauri::State<'_, MotherEndpointCache>,
    launched_game_id: i64,
    port: u16,
    mdns_label: Option<String>,
    // Same meaning as on `mother_start_local_server`. A takeover from the red
    // banner passes false: the device hosts as a substitute.
    configured: Option<bool>,
    designated_at: Option<i64>,
    // The other games the dead mother was running that this device cached.
    // A substitute takes them all over, not just the one on screen.
    also_game_ids: Option<Vec<i64>>,
) -> Result<BecomeMotherInfo, String> {
    let role = HostRole::from_configured(configured);
    let since = if role == HostRole::Mother { designated_at.unwrap_or(0) } else { 0 };
    // NOTE: a server already running on this device is stopped only once every
    // guard below has passed and the snapshot is adopted (step 5-ter). Stopping
    // it up front meant any refusal - no snapshot, scenario not synced, stale
    // snapshot - left a serving mother with NO server at all, and the venue with
    // no mother to find.

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

    // 2. Parse + validate everything up front. `rows` is moved into the adopt
    // transaction below, so anything needed after it is copied out here.
    let rows = parse_snapshot_rows(&snap)?;
    let game_uniqid = rows.game.game_uniqid.clone();
    let game_client_id = rows.game.client_id;
    let old_epoch = rows.mother_epoch;
    let new_epoch = old_epoch + 1;
    let snap_state_version = rows.state_version;

    // 2-bis. Staleness guard. Our own rows for this game may be NEWER than the
    // cached snapshot - typically on the device that was promoted earlier: its
    // cache still holds the dead mother's copy (epoch N) while it has been
    // serving at N+1 ever since. Adopting would silently roll the game back to
    // the moment of the failover. The `stale_snapshot` marker lets the caller
    // fall back to simply (re)starting its own server.
    //
    // Matched by `summary_uuid`: ids are allocated per device, so another local
    // game can sit at the same id. Matching by id alone refused the takeover
    // with `stale_snapshot`, and the caller then served this device's own rows,
    // which don't hold the game: the substitute showed no game at all.
    // `apply_game_rows` moves such an unrelated game aside.
    let summary_for_guard = rows.game.summary_uuid.clone();
    let local_epoch: Option<i64> = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
            local_newer_epoch(c, &summary_for_guard)
        })
        .await
        .map_err(|e| e.to_string())?;
    if let Some(le) = local_epoch {
        if le > old_epoch {
            return Err(format!(
                "stale_snapshot: this device already holds a newer copy of the game (epoch {le} > cached {old_epoch})"
            ));
        }
    }
    let snap_mother_uuid = vstr(&snap, "mother_uuid");
    let also_game_ids: Vec<i64> = also_game_ids
        .unwrap_or_default()
        .into_iter()
        .filter(|id| *id != launched_game_id)
        .collect();

    // 3. Content guard - refuse if this device hasn't synced the scenario.
    let game_uniqid_for_guard = game_uniqid.clone();
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
            game_uniqid
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
    let adopt_label = mdns_label.clone();
    // None = an older snapshot without the field: keep our own list.
    let snap_revoked: Option<Vec<String>> = snap.get("revoked_devices").and_then(|v| v.as_array()).map(|a| {
        a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()
    });
    let (self_peer_id, self_peer_secret, extras) = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(i64, String, ExtraAdoption)> {
            let tx = c.transaction()?;

            // 5a. Rebuild the pairing table from the snapshot, preserving ids.
            tx.execute("DELETE FROM paired_devices", [])?;
            let mut self_found: Option<(i64, String)> = None;
            for pd in &rows.paired_devices {
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

            // 5a-bis. Inherit the dead mother's sticky removals (retours sept. #8).
            if let Some(list) = snap_revoked.as_ref() {
                if tx.execute("DELETE FROM revoked_devices", []).is_ok() {
                    for u in list {
                        let _ = tx.execute(
                            "INSERT OR IGNORE INTO revoked_devices (peer_uuid) VALUES (?)",
                            params![u],
                        );
                    }
                }
            }

            // 5b. Replace this game's rows at our NEW epoch. `preserve` is false:
            // taking ownership doesn't make us the device that launched the game,
            // and our participant row is what surfaces it in "This device".
            apply_game_rows(&tx, &rows, new_epoch, false)?;

            // 5b-bis. The mother's other running games this device cached.
            let extras = adopt_extra_cached_games(
                &tx,
                &also_game_ids,
                snap_mother_uuid.as_deref(),
                game_client_id,
            )?;

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
            // We ARE the mother now: no outbound link to any other mother may
            // survive. heal_self_identity only drops SELF-links, so the row for
            // the mother we just replaced used to persist - and childControlLink's
            // 15s refreshLaunchedGamesRoute tick would resolve it (its endpoint is
            // still warm in MotherEndpointCache) and drag our OWN launched_games
            // traffic off 127.0.0.1 onto the dead machine, re-raising "lost
            // contact with the mother" on the device that just got promoted.
            // If we later stand down, yieldToMother re-creates the row via
            // client_save_paired_mother, so nothing is lost.
            // (Read the mother we stand in for BEFORE the rows go.)
            note_hosting_role(&tx, role)?;
            tx.execute("DELETE FROM paired_mothers", [])?;
            // Take over the state-version counter too, or every snapshot WE ship
            // as the new mother looks stale to the satellites (see
            // `seed_state_version`).
            seed_state_version(&tx, snap_state_version.max(extras.max_state_version))?;

            tx.commit()?;
            Ok((self_id, self_secret, extras))
        })
        .await
        .map_err(|e| format!("adopt snapshot: {e}"))?;
    // Advertise the highest epoch among the adopted games, so fencing and
    // re-pointing prefer us for each of them.
    let new_epoch = new_epoch.max(extras.max_epoch);
    let mut adopted_game_ids = vec![launched_game_id];
    adopted_game_ids.extend(extras.adopted.iter().copied());

    // 5-bis. The in-memory endpoint cache is process-global and still holds the
    // dead mother's SocketAddr. `client_resolve_mother_link` reads ONLY that
    // cache, so leaving it warm would resurrect the link we just deleted above
    // for the rest of the session.
    cache.inner.lock().await.clear();
    cache.fails.lock().await.clear();

    // 5-ter. Every device may run its OWN local server (ensureMotherServer), so
    // "already running" is the normal case, not an error - stop it now that the
    // adoption is committed, then start the replacement. Take it out under the
    // lock, then shut it down without holding the lock (the join await would
    // otherwise block other server-state callers).
    let existing = { state.inner.lock().await.take() };
    if let Some(running) = existing {
        if let Some(m) = running.mdns {
            let _ = m.daemon.unregister(&m.full_name);
            let _ = m.daemon.shutdown();
        }
        let _ = running.shutdown.send(());
        let _ = running.join.await;
    }

    // 6. Build state + serve + mDNS (epoch bumped so fencing prefers us).
    let app_state = AppState {
        db: Arc::new(conn),
        media_root: resolve_media_root(&app)?,
        client_id: game_client_id,
        mother_uuid: mother_uuid.clone(),
        self_peer_id,
        last_bump: Arc::new(Mutex::new(HashMap::new())),
        app: app.clone(),
        role,
        since,
        content_slots: crate::content_server::Slots::new(),
    };
    let app_router = build_router(app_state);
    let listener = bind_mother_listener(port)
        .await
        .map_err(|e| format!("bind mother listener (requested {port}): {e}"))?;
    let actual = listener.local_addr().map_err(|e| format!("local_addr: {e}"))?;
    let actual_port = actual.port();
    let _ = tokio::task::spawn_blocking(try_open_firewall).await;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app_router.into_make_service_with_connect_info::<SocketAddr>(),
        )
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    let mdns = match start_mdns(&mother_uuid, mdns_label.as_deref(), actual_port, game_client_id, new_epoch, role, since) {
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
            client_id: game_client_id,
            epoch: new_epoch,
            role,
            since,
        });
    }

    Ok(BecomeMotherInfo {
        port: actual_port,
        bound_addr: actual.to_string(),
        mother_device_uuid: mother_uuid,
        mother_peer_secret: self_peer_secret,
        mother_peer_id: self_peer_id,
        epoch: new_epoch,
        adopted_game_ids,
        skipped_games: extras.skipped,
    })
}

/// Epoch of this device's own copy of a game, found by `summary_uuid`.
fn local_newer_epoch(c: &rusqlite::Connection, summary_uuid: &str) -> tokio_rusqlite::Result<Option<i64>> {
    Ok(c
        .query_row(
            "SELECT mother_epoch FROM lg_launched_games WHERE summary_uuid = ?",
            params![summary_uuid],
            |r| r.get(0),
        )
        .optional()?)
}

/// What `adopt_extra_cached_games` did.
struct ExtraAdoption {
    adopted: Vec<i64>,
    skipped: Vec<SkippedGame>,
    max_epoch: i64,
    max_state_version: i64,
}

/// The second half of a substitute's takeover: besides the game it was asked
/// to promote, adopt every OTHER running game of the same mother it holds a
/// cached snapshot of. Before, a mother running two games failed over to a
/// substitute holding one of them; the other was lost.
///
/// Each game is taken as `become_mother` takes the first one (its epoch + 1,
/// `launched_by_self` left at 0) and must pass the same guards: a parseable
/// snapshot from the same mother and client, not ended, scenario downloaded,
/// and no newer copy here. The pairing table was rebuilt from the first
/// snapshot; `map_device_ids` covers a device paired in between.
fn adopt_extra_cached_games(
    tx: &rusqlite::Transaction,
    ids: &[i64],
    mother_uuid: Option<&str>,
    client_id: i64,
) -> rusqlite::Result<ExtraAdoption> {
    let mut out = ExtraAdoption { adopted: Vec::new(), skipped: Vec::new(), max_epoch: 0, max_state_version: 0 };
    for &id in ids {
        let skip = |out: &mut ExtraAdoption, reason: &str| {
            out.skipped.push(SkippedGame { id, reason: reason.to_string() });
        };
        let json: Option<String> = tx
            .query_row(
                "SELECT snapshot_json FROM mother_snapshots WHERE launched_game_id = ?",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(json) = json else {
            skip(&mut out, "no_cached_snapshot");
            continue;
        };
        let Ok(snap) = serde_json::from_str::<Value>(&json) else {
            skip(&mut out, "corrupt_snapshot");
            continue;
        };
        if vstr(&snap, "mother_uuid").as_deref() != mother_uuid {
            skip(&mut out, "other_mother");
            continue;
        }
        let Ok(mut rows) = parse_snapshot_rows(&snap) else {
            skip(&mut out, "corrupt_snapshot");
            continue;
        };
        if rows.game.client_id != client_id {
            skip(&mut out, "wrong_client");
            continue;
        }
        if rows.game.ended {
            skip(&mut out, "ended");
            continue;
        }
        let has_content = tx
            .query_row(
                "SELECT 1 FROM scenarios WHERE uniqid = ? AND local_version IS NOT NULL",
                params![rows.game.game_uniqid],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_content {
            skip(&mut out, "no_content");
            continue;
        }
        let local_epoch: Option<i64> = tx
            .query_row(
                "SELECT mother_epoch FROM lg_launched_games WHERE summary_uuid = ?",
                params![rows.game.summary_uuid],
                |r| r.get(0),
            )
            .optional()?;
        if local_epoch.is_some_and(|le| le > rows.mother_epoch) {
            skip(&mut out, "stale_snapshot");
            continue;
        }
        map_device_ids(tx, &mut rows)?;
        let epoch = rows.mother_epoch + 1;
        apply_game_rows(tx, &rows, epoch, false)?;
        out.adopted.push(id);
        out.max_epoch = out.max_epoch.max(epoch);
        out.max_state_version = out.max_state_version.max(rows.state_version);
    }
    Ok(out)
}

/// Outcome of `apply_mother_snapshot`. Never an error for the ordinary "nothing
/// to do" cases - the caller runs this on a timer and a refusal is information,
/// not a failure.
#[derive(Serialize)]
pub struct ApplyOutcome {
    pub applied: bool,
    /// `applied`, `no_cached_snapshot`, `no_local_row`, `stale_snapshot`,
    /// `serving_locally`, or `corrupt_snapshot`.
    pub reason: String,
    pub ended: bool,
    pub mother_epoch: i64,
    pub state_version: i64,
}

/// Mirror the cached snapshot of ONE game onto this device's local rows, WITHOUT
/// taking ownership of the game (Ludiom #76).
///
/// The case: this device was the mother, another device was promoted, and the
/// operator ended the game there. `become_mother` is entirely local to the
/// promoted device - nothing ever writes back here - so this device kept
/// `ended = 0` and went on showing a game that finished elsewhere, in its games
/// list, its "This device" history and its statistics. Worse, that stale row
/// feeds `deviceHasLocalActiveGame`, the epoch advertised at boot and
/// `get_takeover_target`, so it also distorts the next failover.
///
/// This is `become_mother`'s row application and nothing else. It deliberately
/// does NOT: bump the epoch, rebuild `paired_devices` (we keep our own secrets),
/// touch `paired_mothers`, write identity or wifi keys, heal identities, or
/// start any server/mDNS. It adopts the epoch it mirrors, so a later
/// snapshot from the same owner is not seen as stale.
///
/// Four guards make it safe to run on a timer: a local row must already exist
/// (we never materialise a stranger's game - `mother_snapshots` is never
/// pruned), the snapshot's epoch must be at least the local one, this device
/// must not be serving that game itself at an epoch that would make it the
/// rightful owner, and the caller short-circuits when it is a running mother.
#[tauri::command]
pub async fn apply_mother_snapshot(
    app: AppHandle,
    state: tauri::State<'_, MotherServerState>,
    launched_game_id: i64,
) -> Result<ApplyOutcome, String> {
    let refused = |reason: &str| ApplyOutcome {
        applied: false,
        reason: reason.to_string(),
        ended: false,
        mother_epoch: 0,
        state_version: 0,
    };

    let conn = open_db_for_command(&app).await?;
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
        return Ok(refused("no_cached_snapshot"));
    };
    let Ok(snap) = serde_json::from_str::<Value>(&snap_json) else {
        return Ok(refused("corrupt_snapshot"));
    };
    let Ok(rows) = parse_snapshot_rows(&snap) else {
        return Ok(refused("corrupt_snapshot"));
    };
    let snap_epoch = rows.mother_epoch;
    let snap_version = rows.state_version;
    let ended = rows.game.ended;

    // Are we serving right now, at an epoch that says the game is still ours?
    // Then the snapshot is a peer's opinion, not the truth, and mirroring would
    // destroy live state. (The TS caller already skips running mothers; this is
    // the same rule enforced where it can't be bypassed.)
    if let Some(running) = state.inner.lock().await.as_ref() {
        if running.epoch >= snap_epoch {
            return Ok(refused("serving_locally"));
        }
    }

    let outcome = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<&'static str>> {
            let tx = c.transaction()?;
            // The same game, not just the same number: ids are per device, and
            // an unrelated local game at this id must not be overwritten.
            let local: Option<i64> = tx
                .query_row(
                    "SELECT mother_epoch FROM lg_launched_games WHERE id = ?1 AND summary_uuid = ?2",
                    params![launched_game_id, rows.game.summary_uuid],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(local_epoch) = local else {
                return Ok(Some("no_local_row"));
            };
            if snap_epoch < local_epoch {
                return Ok(Some("stale_snapshot"));
            }
            apply_game_rows(&tx, &rows, snap_epoch, /* preserve_launched_by_self */ true)?;
            // The mirrored state came with the owner's counter; adopting it keeps
            // our own snapshots (should we ever host again) from looking stale.
            seed_state_version(&tx, snap_version)?;
            tx.commit()?;
            Ok(None)
        })
        .await
        .map_err(|e| format!("apply snapshot: {e}"))?;

    if let Some(reason) = outcome {
        return Ok(refused(reason));
    }
    Ok(ApplyOutcome {
        applied: true,
        reason: "applied".into(),
        ended,
        mother_epoch: snap_epoch,
        state_version: snap_version,
    })
}

// ─── game reconciliation: the newer copy wins, whoever holds it ──────────────

/// What orders two copies of the same game (same `summary_uuid`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GameVersion {
    pub epoch: i64,
    pub ended: bool,
    pub state_version: i64,
}

/// Is copy `a` more advanced than copy `b`?
///
/// A higher `mother_epoch` always wins: it is a later lineage (a substitute
/// took the game over). Within one epoch an ended copy beats an unfinished
/// one, then the per-game version decides. Equal copies are not "newer", so
/// two devices holding the same state never trade it back and forth.
pub(crate) fn is_newer(a: GameVersion, b: GameVersion) -> bool {
    (a.epoch, a.ended, a.state_version) > (b.epoch, b.ended, b.state_version)
}

pub(crate) struct AdoptOutcome {
    pub applied: bool,
    /// `applied`, `corrupt_snapshot`, `wrong_client`, `tombstoned`,
    /// `not_newer`, `unknown_game` or `id_collision_active`.
    pub reason: &'static str,
    /// The id the game has HERE after the adoption (0 when refused).
    pub game_id: i64,
    pub mother_epoch: i64,
    pub ended: bool,
}

impl AdoptOutcome {
    fn refused(reason: &'static str) -> Self {
        Self { applied: false, reason, game_id: 0, mother_epoch: 0, ended: false }
    }
}

/// Hands out row ids no local row and no incoming row uses.
struct IdAlloc {
    next: i64,
}

impl IdAlloc {
    fn new(tx: &rusqlite::Transaction, table: &str, incoming_max: i64) -> rusqlite::Result<Self> {
        let max_row: i64 = tx.query_row(&format!("SELECT COALESCE(MAX(id), 0) FROM {table}"), [], |r| r.get(0))?;
        let seq: i64 = tx
            .query_row("SELECT seq FROM sqlite_sequence WHERE name = ?", params![table], |r| r.get(0))
            .optional()?
            .unwrap_or(0);
        Ok(Self { next: max_row.max(seq).max(incoming_max) + 1 })
    }
    fn take(&mut self) -> i64 {
        let v = self.next;
        self.next += 1;
        v
    }
}

/// Does this id of `table` belong to another game than `game_id`?
fn id_taken_elsewhere(tx: &rusqlite::Transaction, table: &str, id: i64, game_id: i64) -> rusqlite::Result<bool> {
    Ok(tx
        .query_row(
            &format!("SELECT 1 FROM {table} WHERE id = ?1 AND launched_game_id <> ?2"),
            params![id, game_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
}

/// Same question, restricted to games still running here.
fn id_taken_by_live_game(tx: &rusqlite::Transaction, table: &str, id: i64, game_id: i64) -> rusqlite::Result<bool> {
    Ok(tx
        .query_row(
            &format!(
                "SELECT 1 FROM {table} x JOIN lg_launched_games g ON g.id = x.launched_game_id
                  WHERE x.id = ?1 AND x.launched_game_id <> ?2 AND g.ended = 0"
            ),
            params![id, game_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
}

/// Tables whose rows carry an id nothing else references.
const LEAF_TABLES: [&str; 5] = [
    "lg_launched_game_raw_data",
    "lg_team_completed_quests",
    "lg_clash_members",
    "lg_clash_validations",
    "lg_clash_consumed",
];

/// Move the INCOMING rows of an ended game onto ids that are free here, and
/// leave every local row where it is.
///
/// `rekey_conflicting_local_rows` does the opposite (it keeps the snapshot's
/// ids and renumbers the local rows), which is right for a game satellites are
/// still playing: they address it by those ids. For a finished game nobody
/// does, while the receiving mother may be running ANOTHER game whose teams
/// satellites address by id right now. Team ids are allocated per device, so
/// a game created on a substitute nearly always collides with the mother's.
fn remap_incoming_ids(tx: &rusqlite::Transaction, rows: &mut SnapshotRows, game_id: i64) -> rusqlite::Result<()> {
    rows.game.id = game_id;

    let incoming_max = rows.teams.iter().map(|t| t.id).max().unwrap_or(0);
    let mut alloc = IdAlloc::new(tx, "lg_teams", incoming_max)?;
    let mut team_map: HashMap<i64, i64> = HashMap::new();
    for t in rows.teams.iter_mut() {
        if id_taken_elsewhere(tx, "lg_teams", t.id, game_id)? {
            let fresh = alloc.take();
            team_map.insert(t.id, fresh);
            t.id = fresh;
        }
    }
    let team = |id: i64| team_map.get(&id).copied().unwrap_or(id);
    for q in rows.cqs.iter_mut() { q.team_id = team(q.team_id); }
    for m in rows.clash_members.iter_mut() { m.team_id = team(m.team_id); }
    for v in rows.clash_validations.iter_mut() { v.team_id = team(v.team_id); }
    for e in rows.clash_effectif.iter_mut() { e.team_id = team(e.team_id); }
    for p in rows.clash_purges.iter_mut() { p.team_id = team(p.team_id); }

    fn leaf(tx: &rusqlite::Transaction, table: &str, game_id: i64, ids: Vec<&mut i64>) -> rusqlite::Result<()> {
        let incoming_max = ids.iter().map(|i| **i).max().unwrap_or(0);
        let mut alloc = IdAlloc::new(tx, table, incoming_max)?;
        for id in ids {
            if id_taken_elsewhere(tx, table, *id, game_id)? {
                *id = alloc.take();
            }
        }
        Ok(())
    }
    leaf(tx, "lg_launched_game_raw_data", game_id, rows.raw_data.iter_mut().map(|r| &mut r.id).collect())?;
    leaf(tx, "lg_team_completed_quests", game_id, rows.cqs.iter_mut().map(|r| &mut r.id).collect())?;
    leaf(tx, "lg_clash_members", game_id, rows.clash_members.iter_mut().map(|r| &mut r.id).collect())?;
    leaf(tx, "lg_clash_validations", game_id, rows.clash_validations.iter_mut().map(|r| &mut r.id).collect())?;
    leaf(tx, "lg_clash_consumed", game_id, rows.clash_consumed.iter_mut().map(|r| &mut r.id).collect())?;
    leaf(tx, "lg_clash_purges", game_id, rows.clash_purges.iter_mut().map(|r| &mut r.id).collect())?;
    Ok(())
}

/// Would keeping the incoming ids renumber rows of a game still running here?
fn collides_with_live_game(tx: &rusqlite::Transaction, rows: &SnapshotRows) -> rusqlite::Result<bool> {
    let game_id = rows.game.id;
    let live_game: bool = tx
        .query_row(
            "SELECT 1 FROM lg_launched_games WHERE id = ?1 AND summary_uuid <> ?2 AND ended = 0",
            params![game_id, rows.game.summary_uuid],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if live_game {
        return Ok(true);
    }
    for t in &rows.teams {
        if id_taken_by_live_game(tx, "lg_teams", t.id, game_id)? {
            return Ok(true);
        }
    }
    let leaves: [(&str, Vec<i64>); 6] = [
        (LEAF_TABLES[0], rows.raw_data.iter().map(|r| r.id).collect()),
        (LEAF_TABLES[1], rows.cqs.iter().map(|r| r.id).collect()),
        (LEAF_TABLES[2], rows.clash_members.iter().map(|r| r.id).collect()),
        (LEAF_TABLES[3], rows.clash_validations.iter().map(|r| r.id).collect()),
        (LEAF_TABLES[4], rows.clash_consumed.iter().map(|r| r.id).collect()),
        ("lg_clash_purges", rows.clash_purges.iter().map(|r| r.id).collect()),
    ];
    for (table, ids) in leaves {
        for id in ids {
            if id_taken_by_live_game(tx, table, id, game_id)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Re-point the game's `device_id` references at THIS device's pairing table.
///
/// They are `paired_devices.id` values of the device that built the bundle.
/// `apply_game_rows` is only sound when those ids mean the same thing here,
/// which holds after `become_mother` (it rebuilds the table from the snapshot)
/// but not for a game pushed by a peer: a device paired on the substitute after
/// the takeover has another id here, or none. Each referenced device is matched
/// by its uuid; one this device has never seen gets a row, so punches stay
/// attributed and the `mine=1` filter keeps working. Existing rows are never
/// modified - in particular their secrets.
fn map_device_ids(tx: &rusqlite::Transaction, rows: &mut SnapshotRows) -> rusqlite::Result<()> {
    let referenced: HashSet<i64> = rows
        .devices
        .iter()
        .map(|d| d.device_id)
        .chain(rows.raw_data.iter().map(|r| r.device_id))
        .collect();
    let self_uuid: Option<String> = tx
        .query_row("SELECT value FROM schema_meta WHERE key = 'client_device_uuid'", [], |r| r.get(0))
        .optional()?;

    let mut map: HashMap<i64, i64> = HashMap::new();
    for pd in rows.paired_devices.iter().filter(|pd| referenced.contains(&pd.id)) {
        let local: Option<i64> = tx
            .query_row("SELECT id FROM paired_devices WHERE peer_uuid = ?", params![pd.peer_uuid], |r| r.get(0))
            .optional()?;
        let id = match local {
            Some(id) => id,
            None => {
                // The bundle's secret lets that device keep its token, unless it
                // was removed here on purpose or the secret is already someone's.
                let unusable: bool = tx
                    .query_row(
                        "SELECT 1 FROM paired_devices WHERE peer_secret = ?1
                         UNION ALL SELECT 1 FROM revoked_devices WHERE peer_uuid = ?2",
                        params![pd.peer_secret, pd.peer_uuid],
                        |_| Ok(true),
                    )
                    .optional()
                    .unwrap_or(Some(true))
                    .unwrap_or(false);
                let secret = if unusable { random_token(32) } else { pd.peer_secret.clone() };
                let is_self = self_uuid.as_deref() == Some(pd.peer_uuid.as_str());
                tx.execute(
                    "INSERT INTO paired_devices
                       (peer_uuid, peer_label, peer_os, peer_app_version, peer_secret, is_self)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![pd.peer_uuid, pd.peer_label, pd.peer_os, pd.peer_app_version, secret, is_self as i64],
                )?;
                tx.last_insert_rowid()
            }
        };
        map.insert(pd.id, id);
    }

    let dev = |id: i64| map.get(&id).copied().unwrap_or(id);
    for r in rows.raw_data.iter_mut() {
        r.device_id = dev(r.device_id);
    }
    // UNIQUE(launched_game_id, device_id): two bundle ids can land on one row.
    let mut seen: HashSet<i64> = HashSet::new();
    let devices = std::mem::take(&mut rows.devices);
    for mut d in devices {
        d.device_id = dev(d.device_id);
        if seen.insert(d.device_id) {
            rows.devices.push(d);
        }
    }
    Ok(())
}

/// Take a peer's copy of ONE game when it is more advanced than ours.
///
/// This is how copies converge. A substitute pushes what it hosted to the
/// mother (`push_snapshot`); a satellite pulls the mother's later state of a
/// game it holds (`client_reconcile_with_mother`). Both end here, so one rule
/// decides everywhere: `is_newer`.
///
/// The game is identified by `summary_uuid`, never by its integer id, which is
/// allocated per device. `hosted` (the pusher was the game's host) is what
/// allows creating a row this device has never had: without it an old mirror
/// would bring back a game that was deleted here before tombstones existed.
///
/// The game keeps the EPOCH of the copy it comes from, even when the mother
/// adopts a game that is still running. Raising it (as a promotion does) would
/// put the adopted copy in a later lineage than the device that really played
/// the game on: a satellite's cached snapshot pushed first would then outrank
/// the substitute's final, ended copy arriving later, and the end of the game
/// would be lost. Satellites still accept what the mother ships afterwards:
/// `seed_state_version` puts its counter past the copy's version, and their
/// cache guard compares versions within one epoch.
///
/// Runs inside the caller's transaction; the caller commits only when
/// `applied`.
pub(crate) fn adopt_peer_snapshot(
    tx: &rusqlite::Transaction,
    snap: &Value,
    client_id: i64,
    hosted: bool,
) -> rusqlite::Result<AdoptOutcome> {
    let Ok(mut rows) = parse_snapshot_rows(snap) else {
        return Ok(AdoptOutcome::refused("corrupt_snapshot"));
    };
    if rows.game.client_id != client_id {
        return Ok(AdoptOutcome::refused("wrong_client"));
    }
    let incoming = GameVersion {
        epoch: rows.mother_epoch,
        ended: rows.game.ended,
        state_version: rows.game.state_version,
    };

    let tombstone: Option<(i64, i64)> = tx
        .query_row(
            "SELECT mother_epoch, state_version FROM lg_game_tombstones WHERE summary_uuid = ?",
            params![rows.game.summary_uuid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((epoch, state_version)) = tombstone {
        if !is_newer(incoming, GameVersion { epoch, ended: true, state_version }) {
            return Ok(AdoptOutcome::refused("tombstoned"));
        }
    }

    let local: Option<(i64, i64, bool, i64)> = tx
        .query_row(
            "SELECT id, mother_epoch, ended, state_version FROM lg_launched_games WHERE summary_uuid = ?",
            params![rows.game.summary_uuid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0, r.get(3)?)),
        )
        .optional()?;
    match local {
        Some((_, epoch, ended, state_version)) => {
            if !is_newer(incoming, GameVersion { epoch, ended, state_version }) {
                return Ok(AdoptOutcome::refused("not_newer"));
            }
        }
        None if !hosted => return Ok(AdoptOutcome::refused("unknown_game")),
        None => {}
    }

    tx.pragma_update(None, "defer_foreign_keys", "ON")?;
    let incoming_game_id = rows.game.id;
    let local_id = local.map(|l| l.0);
    if rows.game.ended {
        // Our id when we already hold the game, the pusher's when it is free
        // here, a new one otherwise.
        let game_id = match local_id {
            Some(id) => id,
            None => {
                let taken: bool = tx
                    .query_row("SELECT 1 FROM lg_launched_games WHERE id = ?", params![incoming_game_id], |_| Ok(true))
                    .optional()?
                    .unwrap_or(false);
                if taken { IdAlloc::new(tx, "lg_launched_games", incoming_game_id)?.take() } else { incoming_game_id }
            }
        };
        remap_incoming_ids(tx, &mut rows, game_id)?;
    } else {
        if let Some(id) = local_id {
            rows.game.id = id;
        }
        if collides_with_live_game(tx, &rows)? {
            return Ok(AdoptOutcome::refused("id_collision_active"));
        }
    }
    map_device_ids(tx, &mut rows)?;

    let epoch = rows.mother_epoch;
    apply_game_rows(tx, &rows, epoch, /* preserve_launched_by_self */ true)?;
    seed_state_version(tx, rows.state_version.max(rows.game.state_version))?;
    tx.execute(
        "DELETE FROM lg_game_tombstones WHERE summary_uuid = ?",
        params![rows.game.summary_uuid],
    )?;

    Ok(AdoptOutcome {
        applied: true,
        reason: "applied",
        game_id: rows.game.id,
        mother_epoch: epoch,
        ended: rows.game.ended,
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
    /// The mother's advertised device name, so the device that yields to it
    /// saves a paired mother with a name instead of "Poste mère".
    pub label: Option<String>,
}

/// Every secret this device could present to the CURRENT mother of its game,
/// best first: all `paired_mothers` secrets (the mother adopted our row, so it
/// honours one of them; most recently seen first, never-seen rows last), then
/// our own `is_self` secret (honoured when WE were the mother the live one was
/// promoted from). Callers that get a 401/403 try the next one.
///
/// Trying only the first used to strand the "take back control" path after a
/// failover: the freshest `paired_mothers` row is not necessarily the one the
/// live mother honours (a satellite that followed several mothers holds a row
/// per mother), and a single refusal ended the takeover with an error.
async fn outbound_secrets(conn: &DbConnection) -> Vec<String> {
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<String>> {
        let mut out: Vec<String> = Vec::new();
        let mut stmt = c.prepare(
            "SELECT peer_secret FROM paired_mothers
             ORDER BY last_seen_at IS NULL, last_seen_at DESC, paired_at DESC",
        )?;
        for s in stmt.query_map([], |r| r.get::<_, String>(0))? {
            let s = s?;
            if !s.is_empty() && !out.contains(&s) {
                out.push(s);
            }
        }
        let own: Option<String> = c
            .query_row(
                "SELECT peer_secret FROM paired_devices WHERE is_self = 1 LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(s) = own.filter(|s| !s.is_empty()) {
            if !out.contains(&s) {
                out.push(s);
            }
        }
        Ok(out)
    })
    .await
    .unwrap_or_default()
}

/// Whether a `pull_snapshot_over_http` error is the mother refusing our token
/// (worth retrying with another secret) rather than a transport failure.
fn is_auth_refusal(err: &str) -> bool {
    err.contains("HTTP 401") || err.contains("HTTP 403")
}

/// Does a discovered mother outrank this device's own claim on the game?
/// A strictly higher epoch always does. An EQUAL epoch means two satellites
/// promoted from the same snapshot in the same few seconds (retours sept. #10,
/// "first click wins" racing itself): the lower uuid wins, so exactly one of
/// the two yields and the venue converges on a single mother.
pub(crate) fn outranks_local_mother(
    their_epoch: Option<i64>,
    their_uuid: &str,
    my_epoch: i64,
    self_uuid: Option<&str>,
) -> bool {
    match their_epoch {
        Some(e) if e > my_epoch => true,
        Some(e) if e == my_epoch && my_epoch > 0 => self_uuid.map_or(false, |me| their_uuid < me),
        _ => false,
    }
}

/// "Regain control" detection. Returns the live mother to take over from, if
/// any. Works whether or not THIS device has a local copy of the game:
///  - browse mDNS for a DIFFERENT mother of this client at a HIGHER epoch than
///    our own (our local active game's epoch, or 0 if we have none), or at the
///    SAME epoch with a lower uuid (`outranks_local_mother`);
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

    let mut mothers: Vec<DiscoveredMother> = run_mdns_discovery(Duration::from_millis(2000))
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.client_id == Some(client_id))
        .filter(|m| m.lan_proto == LAN_PROTO)
        .filter(|m| self_uuid.as_deref() != Some(m.mother_uuid.as_str()))
        .filter(|m| outranks_local_mother(m.epoch, &m.mother_uuid, my_epoch, self_uuid.as_deref()))
        .collect();
    mothers.sort_by_key(|m| std::cmp::Reverse(m.epoch.unwrap_or(0)));

    // Game id+name. Ask the live mother which games it is ACTUALLY serving and
    // prefer one we also hold locally (ids are preserved through adoption).
    // Picking our local row blind - "highest epoch among our unfinished games" -
    // could land on a leftover unfinished game from an earlier session that the
    // live mother knows nothing about; the snapshot fetch then came back empty
    // and "take back control" failed with an error (Ludiom field test).
    let local_ids: Vec<(i64, String)> = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(i64, String)>> {
            let mut stmt = c.prepare(
                "SELECT id, name FROM lg_launched_games WHERE client_id = ? AND ended = 0",
            )?;
            let rows = stmt.query_map(params![client_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
        .map_err(|e| e.to_string())?;
    let client = lan_client_builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let secrets = outbound_secrets(&conn).await;

    // Retours sept. #14: the target used to be "first matching address of the
    // highest-epoch advertisement", unverified - a mother advertising a stale
    // client lease (e.g. an old DHCP address) sent the regain button at an address that
    // no longer existed, while the "someone took over" state never cleared.
    // Now every advertised address of every candidate is tried, best epoch
    // first, and only an address that ANSWERS becomes the target. A candidate
    // nobody can reach is no target at all: this device simply stays mother.
    let mut chosen: Option<(DiscoveredMother, String, Option<Vec<(i64, String)>>)> = None;
    'candidates: for m in mothers {
        let mut addrs = m.addresses.clone();
        if let Some(first) = select_address(&m.addresses) {
            addrs.retain(|a| a != &first);
            addrs.insert(0, first);
        }
        for addr in addrs.into_iter().filter(|a| a.parse::<Ipv4Addr>().is_ok()) {
            // None = could not authenticate; Some(list) = the mother answered.
            let mut reached = false;
            let mut served: Option<Vec<(i64, String)>> = None;
            for secret in &secrets {
                let Ok(resp) = client
                    .get(format!("http://{addr}:{}/launched_games.php?action=list_active", m.port))
                    .header(header::AUTHORIZATION, format!("Bearer {secret}"))
                    .send()
                    .await
                else {
                    break; // transport failure: try the next address
                };
                reached = true;
                if !resp.status().is_success() {
                    continue;
                }
                let Ok(body) = resp.json::<Value>().await else { break };
                let games = body
                    .get("games")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|g| {
                                let id = g.get("id").and_then(|v| v.as_i64())?;
                                let nm = g.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                Some((id, nm))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                served = Some(games);
                break;
            }
            if reached {
                chosen = Some((m, addr, served));
                break 'candidates;
            }
        }
    }
    let Some((m, addr, served)) = chosen else { return Ok(None) };
    let (gid, name) = match served {
        Some(games) => {
            let shared = games.iter().find(|(id, _)| local_ids.iter().any(|(l, _)| l == id));
            match shared.or(games.first()) {
                Some((id, nm)) => (*id, nm.clone()),
                // The live mother serves nothing: there is no game to take over.
                None => return Ok(None),
            }
        }
        // Couldn't ask: fall back to our own best guess, as before.
        None => match local {
            Some((id, nm, _)) => (id, nm),
            None => return Ok(None),
        },
    };
    if gid == 0 {
        return Ok(None);
    }

    Ok(Some(TakeoverTarget {
        launched_game_id: gid,
        game_name: name,
        addr,
        port: m.port,
        epoch: m.epoch.unwrap_or(0),
        label: m.label,
        mother_uuid: m.mother_uuid,
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

/// One authenticated snapshot request against a mother at `addr_port`
/// ("ip:port"), asking for `launched_game_id` with `known_version: -1` so the
/// mother always answers with a full snapshot rather than "you're up to date".
///
/// `Ok(None)` is a MEANINGFUL answer, not a failure: the mother replied and
/// authenticated us, but has no such game (`build_snapshot` returns None → the
/// ping body carries `snapshot: null`). That is precisely what makes this call
/// a candidate test - it proves reachable + honours our token + actually serves
/// THIS game, in one round trip. `Err` is reserved for transport failures and
/// non-2xx replies.
async fn pull_snapshot_over_http(
    addr_port: &str,
    secret: &str,
    launched_game_id: i64,
) -> Result<Option<Value>, String> {
    let client = lan_client_builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("http://{addr_port}/ping.php"))
        .header(header::AUTHORIZATION, format!("Bearer {secret}"))
        .json(&json!({ "launched_game_id": launched_game_id, "known_version": -1 }))
        .send()
        .await
        .map_err(|e| format!("contacting current mother: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("current mother returned HTTP {}", resp.status().as_u16()));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body
        .get("snapshot")
        .filter(|v| v.is_object())
        .cloned())
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
    let secrets = outbound_secrets(&conn).await;
    if secrets.is_empty() {
        return Err("this device has no credentials to authenticate with the current mother".into());
    }

    // Try each secret we hold until the mother accepts one; only a refusal
    // (401/403) moves on - a transport error is final.
    let addr_port = format!("{addr}:{port}");
    let mut pulled: Option<Option<Value>> = None;
    let mut last_err = String::new();
    for secret in &secrets {
        match pull_snapshot_over_http(&addr_port, secret, launched_game_id).await {
            Ok(v) => {
                pulled = Some(v);
                break;
            }
            Err(e) if is_auth_refusal(&e) => last_err = e,
            Err(e) => return Err(e),
        }
    }
    let Some(pulled) = pulled else { return Err(last_err) };
    let Some(snap) = pulled else {
        return Ok(false);
    };
    let gid = snap.get("game").and_then(|g| g.get("id")).and_then(|v| v.as_i64());
    let ver = snap.get("state_version").and_then(|v| v.as_i64());
    let epoch = snap.get("mother_epoch").and_then(|v| v.as_i64()).unwrap_or(1);
    let (Some(gid), Some(ver)) = (gid, ver) else { return Ok(false) };
    upsert_cached_snapshot(&conn, gid, ver, epoch, snap.to_string())
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Cache a received snapshot in `mother_snapshots`, the single writer for that
/// table on a satellite. Both callers (this file's `fetch_snapshot_from_mother`
/// and the `/ping.php` piggyback in `client_ping_mother`) MUST go through here:
/// they used to carry hand-copied SQL, and the strict-advance guard is exactly
/// the kind of thing that drifts when duplicated.
///
/// The guard is EPOCH-DOMINANT. `state_version` is a per-DEVICE counter
/// (`schema_meta.lg_state_version`), so a newly promoted mother's counter is not
/// comparable to the dead mother's - it typically restarts far below it. Keying
/// staleness on the version alone therefore made a satellite reject every
/// snapshot the new mother shipped, for ever: its cached epoch/uuid froze at the
/// dead mother's values and re-point could never see a "genuine promotion"
/// (Ludiom #74). A higher epoch always wins; the version only breaks ties
/// within one epoch, where it IS the same counter.
async fn upsert_cached_snapshot(
    conn: &DbConnection,
    launched_game_id: i64,
    state_version: i64,
    mother_epoch: i64,
    snapshot_json: String,
) -> Result<(), tokio_rusqlite::Error> {
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
             WHERE excluded.mother_epoch > mother_snapshots.mother_epoch
                OR (excluded.mother_epoch = mother_snapshots.mother_epoch
                    AND excluded.state_version > mother_snapshots.state_version)",
            params![launched_game_id, state_version, mother_epoch, snapshot_json],
        )?;
        Ok(())
    })
    .await
}

// ─── background snapshots: every satellite keeps a copy of every running game ─
//
// The ping used to ship a snapshot only for the game the satellite had ON
// SCREEN. A PC sitting on the games list, in settings or on rankings cached
// nothing, so when the mother died and the operator hosted there, the
// substitute took over with no game at all (Coralie, 2026-10-27). Now, at most
// every BACKGROUND_SNAPSHOT_EVERY, a hosting-capable satellite also asks for
// the mother's other games: it lists the copies it holds, and the mother ships
// the ones that changed.

/// How often a satellite asks for the games it is not playing.
const BACKGROUND_SNAPSHOT_EVERY: Duration = Duration::from_secs(30);
/// At most this many background snapshots per ping reply; the rest follow.
const BACKGROUND_SNAPSHOT_CAP: usize = 3;
/// Once the shipped snapshots reach this size, the rest wait for the next round.
const BACKGROUND_SNAPSHOT_BYTES: usize = 512 * 1024;

/// When this device last asked each mother (by uuid) for its other games.
fn background_snapshot_clock() -> &'static std::sync::Mutex<HashMap<String, Instant>> {
    static CLOCK: std::sync::OnceLock<std::sync::Mutex<HashMap<String, Instant>>> = std::sync::OnceLock::new();
    CLOCK.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Is it time to ask `mother_uuid` for its other games? Records the ask.
/// Never on Android: a tablet never hosts, so a copy would serve nothing.
fn background_snapshots_due(mother_uuid: &str) -> bool {
    if cfg!(target_os = "android") {
        return false;
    }
    let Ok(mut clock) = background_snapshot_clock().lock() else {
        return false;
    };
    let now = Instant::now();
    match clock.get(mother_uuid) {
        Some(at) if now.duration_since(*at) < BACKGROUND_SNAPSHOT_EVERY => false,
        _ => {
            clock.insert(mother_uuid.to_string(), now);
            true
        }
    }
}

/// The unfinished games this device holds a copy of from `mother_uuid`, with
/// the per-game version of each copy. Sent so the mother ships only what changed.
fn cached_games_of_mother(c: &rusqlite::Connection, mother_uuid: &str) -> rusqlite::Result<Vec<(i64, i64)>> {
    c.prepare(
        "SELECT launched_game_id,
                COALESCE(json_extract(snapshot_json, '$.game.state_version'), state_version)
           FROM mother_snapshots
          WHERE json_extract(snapshot_json, '$.mother_uuid') = ?1
            AND COALESCE(json_extract(snapshot_json, '$.game.ended'), 0) = 0",
    )?
    .query_map(params![mother_uuid], |r| Ok((r.get(0)?, r.get(1)?)))?
    .collect()
}

/// Mother side: which games to ship to a satellite that listed `known` copies
/// (game id → per-game version), and which games are running here.
///
/// Candidates are this client's unfinished games plus the games the satellite
/// holds a copy of (so an ending reaches it once and its copy reads "ended").
/// A game is shipped when the satellite has no copy or an older one, at most
/// `BACKGROUND_SNAPSHOT_CAP`. `exclude` is the game the satellite is playing:
/// the regular path already handles it.
fn background_snapshot_plan(
    c: &rusqlite::Connection,
    client_id: i64,
    known: &HashMap<i64, i64>,
    exclude: Option<i64>,
) -> rusqlite::Result<(Vec<i64>, Vec<(i64, i64)>)> {
    let active: Vec<(i64, i64)> = c
        .prepare(
            "SELECT id, state_version FROM lg_launched_games
              WHERE client_id = ? AND ended = 0 ORDER BY id",
        )?
        .query_map(params![client_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut candidates = active.clone();
    for &id in known.keys() {
        if candidates.iter().any(|(gid, _)| *gid == id) {
            continue;
        }
        let row: Option<i64> = c
            .query_row(
                "SELECT state_version FROM lg_launched_games WHERE id = ? AND client_id = ?",
                params![id, client_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(v) = row {
            candidates.push((id, v));
        }
    }
    let ship: Vec<i64> = candidates
        .iter()
        .filter(|(id, _)| Some(*id) != exclude)
        .filter(|(id, version)| known.get(id) != Some(version))
        .map(|(id, _)| *id)
        .take(BACKGROUND_SNAPSHOT_CAP)
        .collect();
    Ok((ship, active))
}

/// "Still running at that version": refresh `updated_at` of a cached copy that
/// is current, without touching its content. `updated_at` used to move only
/// when the game changed, so a quiet game looked abandoned after 30 minutes and
/// "Héberger les parties en remplacement" refused to take it over.
fn touch_cached_snapshot(
    c: &rusqlite::Connection,
    launched_game_id: i64,
    mother_uuid: &str,
    game_version: i64,
) -> rusqlite::Result<usize> {
    c.execute(
        "UPDATE mother_snapshots SET updated_at = CURRENT_TIMESTAMP
          WHERE launched_game_id = ?1
            AND json_extract(snapshot_json, '$.mother_uuid') = ?2
            AND COALESCE(json_extract(snapshot_json, '$.game.state_version'), state_version) = ?3",
        params![launched_game_id, mother_uuid, game_version],
    )
}

/// Re-announce the mother over mDNS with this host's CURRENT LAN IPv4s - e.g.
/// after the PC switched Wi-Fi network once the server was already up (the
/// "Actualiser le réseau" button). The TCP server listens on 0.0.0.0 and needs
/// nothing; only the announcement carries addresses. Returns the addresses now
/// advertised (empty = no LAN address yet). No-op if the server isn't running.
#[tauri::command]
pub async fn mother_refresh_mdns(
    state: tauri::State<'_, MotherServerState>,
) -> Result<Vec<String>, String> {
    let mut guard = state.inner.lock().await;
    match guard.as_mut() {
        Some(running) => {
            reregister_mdns(running)?;
            Ok(running.mdns.as_ref().map(|m| m.advertised.clone()).unwrap_or_default())
        }
        None => Ok(Vec::new()),
    }
}

/// Drop the server's mDNS announcement and register it again from its current
/// fields (addresses, epoch).
fn reregister_mdns(running: &mut Running) -> Result<(), String> {
    if let Some(old) = running.mdns.take() {
        let _ = old.daemon.unregister(&old.full_name);
        let _ = old.daemon.shutdown();
    }
    let handle = start_mdns(
        &running.mother_uuid,
        running.mdns_label.as_deref(),
        running.port,
        running.client_id,
        running.epoch,
        running.role,
        running.since,
    )?;
    running.mdns = Some(handle);
    Ok(())
}

/// Self-healing mDNS keepalive for the mother. Re-registers the announcement
/// when the addresses it carries no longer match the host's LAN addresses:
/// - a mother that booted before its PC got a LAN address (Wi-Fi not joined
///   yet, cable unplugged) holds an INERT announcement;
/// - a mother whose PC switched Wi-Fi network still advertises the OLD IP, so
///   satellites resolve an unreachable address (used to need an app restart).
/// A healthy announcement is never churned. Returns true if it (re)registered.
#[tauri::command]
pub async fn mother_ensure_mdns_live(
    state: tauri::State<'_, MotherServerState>,
) -> Result<bool, String> {
    // Not-a-mother check FIRST: this command is polled on EVERY device every
    // 10s. Bail under a short lock before paying for the if_addrs interface
    // scan - a pure satellite (the common case) would do it every 10s for a
    // guaranteed Ok(false).
    {
        let guard = state.inner.lock().await;
        if guard.is_none() {
            return Ok(false); // not a mother
        }
    }
    let current = current_designated_addrs();
    // Re-acquire to mutate; re-check the state we dropped the lock on.
    let mut guard = state.inner.lock().await;
    let running = match guard.as_mut() {
        Some(r) => r,
        None => return Ok(false),
    };
    let advertised: &[String] = running.mdns.as_ref().map(|m| m.advertised.as_slice()).unwrap_or(&[]);
    if advertised == current.as_slice() {
        return Ok(false); // already advertising exactly these - don't churn discovery
    }
    // Includes "address lost": go inert rather than keep advertising a dead IP.
    reregister_mdns(running).map(|_| true)
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

pub(crate) fn resolve_media_root(app: &AppHandle) -> Result<PathBuf, String> {
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
        // A device has ONE identity, whatever its role: the mother uuid IS the
        // `client_device_uuid` it pairs to other mothers with. `become_mother`
        // always advertised that one, while a plain boot used to mint a random
        // `mother_device_uuid` - so the same PC showed up on satellites under a
        // fresh hex id every time it changed role (retours sept. #7).
        let client_uuid: String = match tx
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'client_device_uuid'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            Some(s) => s,
            None => {
                let new = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO schema_meta(key, value) VALUES ('client_device_uuid', ?)",
                    params![new],
                )?;
                new
            }
        };
        let legacy_uuid: Option<String> = tx
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'mother_device_uuid'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        let mother_uuid = client_uuid.clone();

        // Find the self row: under the current identity, else under the legacy
        // random one (one-time migration below).
        let mut existing: Option<(i64, String)> = tx
            .query_row(
                "SELECT id, peer_secret FROM paired_devices
                 WHERE peer_uuid = ? AND is_self = 1",
                params![mother_uuid],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        if existing.is_none() {
            if let Some(old) = legacy_uuid.as_deref().filter(|o| *o != mother_uuid) {
                let legacy_row: Option<(i64, String)> = tx
                    .query_row(
                        "SELECT id, peer_secret FROM paired_devices WHERE peer_uuid = ? AND is_self = 1",
                        params![old],
                        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                    )
                    .optional()?;
                if let Some((id, secret)) = legacy_row {
                    // Free the uuid (a non-self row for our own identity is a
                    // ghost anyway - heal merges it into the self row), then
                    // re-key the self row. Its id and secret are kept, so game
                    // participation and our own client stack stay valid.
                    heal_self_identity(&tx, id)?;
                    tx.execute(
                        "UPDATE paired_devices SET peer_uuid = ?1 WHERE id = ?2",
                        params![mother_uuid, id],
                    )?;
                    existing = Some((id, secret));
                }
            }
        }
        tx.execute(
            "INSERT INTO schema_meta(key, value) VALUES ('mother_device_uuid', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![mother_uuid],
        )?;

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
/// identity - mother role rework, `become_mother` snapshot adoption -
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
pub(crate) struct AppState {
    pub(crate) db: Arc<DbConnection>,
    /// `<app_data_dir>/media` - where synced content lives. Used by add_team to
    /// read the team-name pools JSON (media/name_pools/team_names.json), and by
    /// /content.php to serve scenario blobs to satellites.
    pub(crate) media_root: PathBuf,
    pub(crate) client_id: i64,
    /// Stable identity of this mother device. Returned by /ping.php so the
    /// child can verify it's still talking to the same machine it paired with.
    mother_uuid: String,
    /// `paired_devices.id` of the mother's own self-row. Cached here so the
    /// authorization check on queue_command (only self may push commands) is
    /// a single integer comparison instead of a SQL roundtrip per call.
    self_peer_id: i64,
    /// Handle on the hosting app, so a command a satellite targets at the
    /// MOTHER's own screen can be executed in-process (emitted straight to
    /// this device's renderer) instead of queued - see `queue_command_inner`.
    pub(crate) app: AppHandle,
    /// Debounce map for `bump_presence` - peer_id → last write Instant. The
    /// 5s window keeps the row from churning under the satellite's 1s state
    /// polling, while the 25s online window in `list_paired_with_status`
    /// still reads a fresh enough timestamp.
    last_bump: Arc<Mutex<HashMap<i64, Instant>>>,
    /// Fixed for the server's lifetime; announced in the hello reply.
    role: HostRole,
    since: i64,
    /// Blob-stream slots for /content.php (total + per satellite).
    pub(crate) content_slots: Arc<crate::content_server::Slots>,
}

fn build_router(state: AppState) -> Router {
    let mut router = Router::new()
        .route("/launched_games.php", any(dispatch_launched_games))
        .route("/pair.php", any(dispatch_pair))
        .route("/ping.php", any(dispatch_ping))
        .route("/content.php", any(crate::content_server::dispatch_content));
    // App installers for satellites (update_cache.rs). Best-effort: a mother
    // without an app data dir still serves games.
    match crate::update_cache::router(&state.app) {
        Ok(updates) => router = router.merge(updates),
        Err(e) => eprintln!("[lan_server] /update.php not mounted: {e}"),
    }
    router
        .layer(axum::middleware::from_fn(lan_proto_gate))
        .with_state(state)
}

#[derive(Deserialize)]
struct ActionQuery {
    action: Option<String>,
    #[serde(flatten)]
    rest: HashMap<String, String>,
}

// ─── auth ────────────────────────────────────────────────────────────────────

pub(crate) async fn resolve_peer(state: &AppState, headers: &HeaderMap) -> Result<i64, Response> {
    let id = resolve_peer_for_ping(state, headers).await?;
    bump_presence(state, id, None, None, None, PeerReport::default()).await;
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
/// What a ping reports besides presence: the peer's running app version, its
/// installer platform key (update_cache: "windows-x86_64", "android"), and its
/// upkeep report as a JSON string. All None from an older satellite / non-ping
/// call, which leaves the stored values untouched.
#[derive(Default)]
struct PeerReport {
    app_version: Option<String>,
    platform: Option<String>,
    upkeep_json: Option<String>,
    /// The command kinds the peer's build handles (`command_caps()`), JSON array.
    caps_json: Option<String>,
}

async fn bump_presence(
    state: &AppState,
    peer_id: i64,
    has_reader: Option<bool>,
    screen_state: Option<String>,
    operator_only: Option<bool>,
    report: PeerReport,
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
        if has_reader.is_none()
            && screen_state.is_none()
            && operator_only.is_none()
            && report.upkeep_json.is_none()
            && report.caps_json.is_none()
        {
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
    let operator_only_i64: Option<i64> = operator_only.map(|b| if b { 1 } else { 0 });
    let PeerReport { app_version, platform, upkeep_json, caps_json } = report;
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
                            screen_state_json = COALESCE(?2, screen_state_json),
                            operator_only = COALESCE(?4, operator_only),
                            peer_app_version = COALESCE(?5, peer_app_version),
                            peer_platform = COALESCE(?6, peer_platform),
                            upkeep_json = COALESCE(?7, upkeep_json),
                            command_caps = COALESCE(?8, command_caps)
                      WHERE id = ?3",
                    params![
                        has_reader_i64,
                        screen_state,
                        peer_id,
                        operator_only_i64,
                        app_version,
                        platform,
                        upkeep_json,
                        caps_json
                    ],
                )?;
                Ok(())
            })
            .await;
    });
}

/// Drain (with delivery-stamp side-effect) the open commands queued for this
/// peer, opportunistically pruning long-dead rows on the way in. Returns the
/// payloads ready to be embedded in the /ping.php response; the satellite is
/// expected to POST `ack_command` once it has acted on each. A current build
/// acks only after its handler ran, so an unacked command is redelivered at most
/// every 30 s (`delivered_at` = last delivery): back-to-back pings never get the
/// same command twice, and one whose reply was lost comes back.
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
                    AND (delivered_at IS NULL
                         OR delivered_at < datetime('now','-30 seconds'))
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
                        SET delivered_at = CURRENT_TIMESTAMP
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
async fn bump_state_version(state: &AppState, game_id: Option<i64>) -> i64 {
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            Ok(bump_state_version_sync(c, game_id)?)
        })
        .await
        .unwrap_or(0)
}

/// Advance the device counter and, when the change belongs to one game, stamp
/// that game with the new value. The stamp is the game's own version: it is
/// what `is_newer` compares between two devices' copies.
fn bump_state_version_sync(c: &rusqlite::Connection, game_id: Option<i64>) -> rusqlite::Result<i64> {
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
    let v = v.parse::<i64>().unwrap_or(0);
    if let Some(id) = game_id {
        c.execute(
            "UPDATE lg_launched_games SET state_version = ?1 WHERE id = ?2",
            params![v, id],
        )?;
    }
    Ok(v)
}

/// Mutating POST actions bump `lg_state_version`; the command-channel and
/// cloud-bookkeeping POSTs are excluded so a video/join push or a summary
/// ack doesn't trigger a needless snapshot re-send. `push_snapshot` seeds the
/// counter itself while adopting.
fn action_mutates_game_state(method: &str, action: &str) -> bool {
    method == "POST"
        && !matches!(
            action,
            "queue_command"
                | "queue_command_bulk"
                | "ack_command"
                | "sync_summaries"
                | "mark_summaries_pushed"
                | "push_snapshot"
                | "customers_create"
        )
}

/// Which body field names the game a mutating action touches. `create` is
/// absent (the id is in its reply), as are `delete_game` / `archive_game`
/// (the row is gone afterwards; they leave a tombstone instead).
fn stamp_field(action: &str) -> Option<&'static str> {
    match action {
        "update_meta" | "merge_meta" | "start_game" | "end_game" | "add_time" => Some("id"),
        "update_team" | "end_team" | "delete_team" => Some("team_id"),
        "record_punch"
        | "add_team"
        | "register_device"
        | "record_completed_quest"
        | "delete_completed_quest"
        | "clash_register"
        | "clash_unregister"
        | "clash_validate" => Some("launched_game_id"),
        _ => None,
    }
}

/// The game a mutating action is about to change. Resolved BEFORE the action
/// runs: `delete_team` removes the row the team lookup needs.
async fn stamp_target(state: &AppState, action: &str, body: &Value) -> Option<i64> {
    let field = stamp_field(action)?;
    let n = body.get(field).and_then(|v| v.as_i64())?;
    if field != "team_id" {
        return Some(n);
    }
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<i64>> {
            Ok(c.query_row(
                "SELECT launched_game_id FROM lg_teams WHERE id = ?",
                params![n],
                |r| r.get(0),
            )
            .optional()?)
        })
        .await
        .ok()
        .flatten()
}

/// Adopt a snapshot's `state_version` into THIS device's counter, taking the
/// max of the two and stepping past it.
///
/// `lg_state_version` is per-DEVICE, and every device runs its own idle server
/// from boot, so a promoted mother's counter is unrelated to (and usually far
/// below) the counter of the mother it replaces. Satellites cache snapshots
/// under a staleness guard, so without this the new mother's snapshots looked
/// permanently stale and were dropped for ever - freezing every satellite's
/// cached epoch at the dead mother's value and breaking re-point (Ludiom #74).
/// Runs inside the caller's transaction so adoption stays atomic.
fn seed_state_version(tx: &rusqlite::Transaction, snap_version: i64) -> rusqlite::Result<()> {
    let local: i64 = tx
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'lg_state_version'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let next = local.max(snap_version) + 1;
    tx.execute(
        "INSERT INTO schema_meta(key, value) VALUES('lg_state_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![next.to_string()],
    )?;
    Ok(())
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
/// same-named AP), the clash_* per-game state (members / validations /
/// consumed punches / effectif / purges - a Clash failover used to restore
/// with those silently amputated), plus `state_version` + `mother_epoch` for
/// staleness + fencing. Returns None if the game id is unknown.
async fn build_snapshot(state: &AppState, game_id: i64, state_version: i64) -> Option<Value> {
    let mother_uuid = state.mother_uuid.clone();
    state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<Value>> {
            Ok(build_snapshot_sync(c, &mother_uuid, game_id, state_version)?)
        })
        .await
        .ok()
        .flatten()
}

/// `build_snapshot` on a bare connection: a device with NO running server (a
/// satellite that hosted the game earlier) builds the bundle it pushes to the
/// mother with this. `mother_uuid` is then the device's own uuid.
fn build_snapshot_sync(
    c: &rusqlite::Connection,
    mother_uuid: &str,
    game_id: i64,
    state_version: i64,
) -> rusqlite::Result<Option<Value>> {
    let game: Option<Value> = c
        .query_row(
            // `ended_at` travels with the snapshot: Clash scoring integrates
            // up to min(now, start+duration, ended_at), so a device that
            // adopts or mirrors this game without it computes WRONG final
            // standings for a manually-ended game.
            //
            // `launched_by_self` deliberately does NOT travel: it is a
            // per-device fact ("I launched this"), and it drives the
            // `mine=1` filter behind the "This device" list. Shipping the
            // mother's value would rewrite every other device's history.
            "SELECT id, summary_uuid, client_id, game_uniqid, name, number_of_teams,
                    game_type, duration, start_time, started, ended, mother_epoch, created_at,
                    ended_at, state_version
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
                    "ended_at": r.get::<_, Option<i64>>(13)?,
                    "state_version": r.get::<_, i64>(14)?,
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

    // Clash V2 per-game state. Cheap for non-clash games (indexed
    // lookups over empty tables); required for Clash - a promotion
    // without these rows silently zeroes territory domination,
    // banked punches, effectif weighting and purge history.
    let clash_members: Vec<Value> = c
        .prepare(
            "SELECT id, team_id, chip_id, created_at
             FROM lg_clash_members WHERE launched_game_id = ? ORDER BY id ASC",
        )?
        .query_map(params![game_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "team_id": r.get::<_, i64>(1)?,
                "chip_id": r.get::<_, i64>(2)?,
                "created_at": r.get::<_, String>(3)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let clash_validations: Vec<Value> = c
        .prepare(
            "SELECT id, team_id, chip_id, combo_index, territory_index, seq, created_at
             FROM lg_clash_validations WHERE launched_game_id = ? ORDER BY id ASC",
        )?
        .query_map(params![game_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "team_id": r.get::<_, i64>(1)?,
                "chip_id": r.get::<_, i64>(2)?,
                "combo_index": r.get::<_, i64>(3)?,
                "territory_index": r.get::<_, i64>(4)?,
                "seq": r.get::<_, i64>(5)?,
                "created_at": r.get::<_, String>(6)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let clash_consumed: Vec<Value> = c
        .prepare(
            "SELECT id, chip_id, punch_key, created_at
             FROM lg_clash_consumed WHERE launched_game_id = ? ORDER BY id ASC",
        )?
        .query_map(params![game_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "chip_id": r.get::<_, i64>(1)?,
                "punch_key": r.get::<_, String>(2)?,
                "created_at": r.get::<_, String>(3)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let clash_effectif: Vec<Value> = c
        .prepare(
            "SELECT team_id, size FROM lg_clash_effectif WHERE launched_game_id = ?",
        )?
        .query_map(params![game_id], |r| {
            Ok(json!({
                "team_id": r.get::<_, i64>(0)?,
                "size": r.get::<_, i64>(1)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let clash_purges: Vec<Value> = c
        .prepare(
            "SELECT id, team_id, chip_id, territory_index, seq, created_at
             FROM lg_clash_purges WHERE launched_game_id = ? ORDER BY id ASC",
        )?
        .query_map(params![game_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "team_id": r.get::<_, i64>(1)?,
                "chip_id": r.get::<_, i64>(2)?,
                "territory_index": r.get::<_, i64>(3)?,
                "seq": r.get::<_, i64>(4)?,
                "created_at": r.get::<_, String>(5)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Sticky removals travel too, so a promoted mother keeps refusing
    // the devices the operator removed (retours sept. #8). Empty when
    // the table doesn't exist yet.
    let revoked_devices: Vec<String> = c
        .prepare("SELECT peer_uuid FROM revoked_devices")
        .and_then(|mut st| {
            st.query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default();

    Ok(Some(json!({
        "schema": 1,
        "state_version": state_version,
        "mother_epoch": epoch,
        "mother_uuid": mother_uuid,
        "game": game,
        "meta": meta,
        "devices": devices,
        "raw_data": raw_data,
        "teams": teams,
        "completed_quests": completed_quests,
        "paired_devices": paired_devices,
        "revoked_devices": revoked_devices,
        "clash_members": clash_members,
        "clash_validations": clash_validations,
        "clash_consumed": clash_consumed,
        "clash_effectif": clash_effectif,
        "clash_purges": clash_purges,
    })))
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

    let mutates = action_mutates_game_state(method.as_str(), action);
    let stamp_id = if mutates { stamp_target(&state, action, &body).await } else { None };

    let result: Result<Value, ApiErr> = match (method.as_str(), action) {
        ("POST", "create") => create(&state, peer_id, body).await,
        ("GET", "inventory") => inventory(&state).await,
        ("POST", "push_snapshot") => push_snapshot(&state, body).await,
        ("GET", "list") => list(&state, &q.rest).await,
        ("GET", "list_active") => list_active(&state).await,
        ("GET", "get_meta") => get_meta(&state, &q.rest).await,
        ("POST", "update_meta") => update_meta(&state, body).await,
        ("POST", "merge_meta") => merge_meta(&state, body).await,
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
        ("POST", "delete_game") => delete_game(&state, peer_id, body).await,
        ("POST", "archive_game") => archive_game(&state, peer_id, body).await,
        ("POST", "sync_summaries") => sync_summaries(&state).await,
        ("POST", "mark_summaries_pushed") => mark_summaries_pushed(&state, body).await,
        ("GET", "list_archived_summaries") => list_archived_summaries(&state).await,
        ("GET", "customers_list") => customers_list(&state).await,
        ("POST", "customers_create") => customers_create(&state, body).await,
        ("POST", "assign_customer") => assign_customer(&state, body).await,
        ("POST", "register_device") => register_device(&state, peer_id, body).await,
        ("GET", "get_devices") => get_devices(&state, &q.rest).await,
        ("GET", "list_paired_with_status") => {
            list_paired_with_status(&state, peer_id, &q.rest).await
        }
        ("GET", "list_paired_for_launch") => list_paired_for_launch(&state, peer_id).await,
        ("GET", "list_fleet") => list_fleet(&state, peer_id).await,
        ("POST", "queue_command") => queue_command(&state, peer_id, body).await,
        ("POST", "queue_command_bulk") => queue_command_bulk(&state, peer_id, body).await,
        ("POST", "ack_command") => ack_command(&state, peer_id, body).await,
        ("GET", "command_status") => command_status(&state, peer_id, &q.rest).await,
        ("GET", "list_completed_quests") => list_completed_quests(&state, &q.rest).await,
        ("POST", "record_completed_quest") => record_completed_quest(&state, body).await,
        ("POST", "delete_completed_quest") => delete_completed_quest(&state, body).await,
        ("POST", "clash_register") => clash_register(&state, body).await,
        ("POST", "clash_unregister") => clash_unregister(&state, body).await,
        ("GET", "clash_members") => clash_members(&state, &q.rest).await,
        ("POST", "clash_validate") => clash_validate(&state, body).await,
        ("GET", "clash_state") => clash_state(&state, &q.rest).await,
        // The mother's wall clock (ms): devices measure their offset to it so a
        // simulated game clock shared across PCs means the same instant on each.
        ("GET", "server_time") => Ok(json!({
            "now_ms": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        })),
        ("", _) | (_, "") => Err(ApiErr::bad("action is required")),
        _ => Err(ApiErr::status(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        )),
    };

    // Slice 0: a successful state-changing action advances the per-mother
    // version counter. Read side (snapshot delivery) lands in slice 1.
    if let (true, Ok(v)) = (mutates, &result) {
        let game_id = if action == "create" { v.get("id").and_then(|x| x.as_i64()) } else { stamp_id };
        bump_state_version(&state, game_id).await;
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
        // Unauthenticated identity probe: lets a child that reached this server
        // by a typed address (pairing by IP) confirm a mother is here and learn
        // its uuid/client_id/epoch WITHOUT mDNS - the fallback for networks that
        // filter multicast. Same shape a resolved mDNS record yields.
        ("GET", "hello") => pair_hello_handler(&state).await,
        // ("GET", "status") retired with the manual-approval ceremony: this
        // mother never returns 'pending', so nothing has a request_id to poll.
        ("", _) | (_, "") => Err(ApiErr::bad("action is required")),
        _ => Err(ApiErr::status(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        )),
    };
    match result {
        Ok(mut v) => {
            // Every pair reply announces our protocol, so a satellite can refuse
            // a mother on another one (see client_pair_with_mother).
            if let Some(obj) = v.as_object_mut() {
                obj.insert("lan_proto".into(), json!(LAN_PROTO));
                obj.insert("app_version".into(), json!(crate::app_version()));
                // This mother serves scenario content on /content.php.
                obj.insert("content_caps".into(), json!(crate::content_server::CONTENT_CAPS));
            }
            json_ok(v)
        }
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

    // 16 KB: the upkeep report rides along (the renderer keeps it to ~1 KB).
    let body_bytes = axum::body::to_bytes(request.into_body(), 16 * 1024)
        .await
        .unwrap_or_default();
    let body: Value = if body_bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body_bytes).unwrap_or(Value::Null)
    };
    let has_reader = body.get("has_reader").and_then(|v| v.as_bool());
    let operator_only = body.get("operator_only").and_then(|v| v.as_bool());
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

    // Devices modal upkeep: what the satellite runs and what it still needs.
    let report = PeerReport {
        app_version: vstr(&body, "app_version").filter(|s| s.len() <= 32),
        platform: vstr(&body, "platform").filter(|s| s.len() <= 40),
        upkeep_json: body.get("upkeep").filter(|v| v.is_object()).map(|v| v.to_string()),
        caps_json: body
            .get("caps")
            .filter(|v| v.is_array())
            .map(|v| v.to_string())
            .filter(|s| s.len() <= 1024),
    };

    bump_presence(&state, peer_id, has_reader, screen_state, operator_only, report).await;
    // A satellite on its offline lock screen pings only to exchange the licence:
    // it can't act on commands, so leave them queued for its real pings.
    let licence_only = body.get("licence_only").and_then(|v| v.as_bool()) == Some(true);
    let commands = if licence_only {
        Vec::new()
    } else {
        pickup_pending_commands(&state, peer_id).await
    };

    // Licence sync (licence_sync.rs): keep the satellite's copy when it is a
    // newer studio check, then answer with ours - the newest either way.
    crate::licence_sync::adopt_from_peer(&state.app, &state.db, body.get("licence")).await;
    let licence = crate::licence_sync::local_value(&state.db).await;

    let state_version = read_state_version(&state).await;
    let content_rev = crate::content_server::content_rev(&state).await;
    let snapshot = match launched_game_id {
        Some(gid) if known_version != Some(state_version) => {
            build_snapshot(&state, gid, state_version).await
        }
        _ => None,
    };

    // The satellite's other games (see `background_snapshot_plan`). Only when
    // it asks, which it does at most every 30 s.
    let mut snapshots: Vec<Value> = Vec::new();
    let mut active_games: Vec<Value> = Vec::new();
    if !licence_only && body.get("background_games").and_then(|v| v.as_bool()) == Some(true) {
        let known: HashMap<i64, i64> = body
            .get("known_games")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|g| Some((vi64(g, "id")?, vi64(g, "game_version")?)))
                    .collect()
            })
            .unwrap_or_default();
        let client_id = state.client_id;
        let plan = state
            .db
            .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(Vec<i64>, Vec<(i64, i64)>)> {
                Ok(background_snapshot_plan(c, client_id, &known, launched_game_id)?)
            })
            .await;
        if let Ok((ship, active)) = plan {
            // The satellite reads this reply under a 2 s timeout: past a budget,
            // the remaining games wait for the next round (the first always goes).
            let mut bytes = 0usize;
            for gid in ship {
                if bytes >= BACKGROUND_SNAPSHOT_BYTES {
                    break;
                }
                if let Some(s) = build_snapshot(&state, gid, state_version).await {
                    bytes += s.to_string().len();
                    snapshots.push(s);
                }
            }
            active_games = active
                .into_iter()
                .map(|(id, v)| json!({ "id": id, "game_version": v }))
                .collect();
        }
    }

    json_ok(json!({
        "mother_uuid": state.mother_uuid,
        "snapshots": snapshots,
        "active_games": active_games,
        "commands": commands,
        "lan_proto": LAN_PROTO,
        "app_version": crate::app_version(),
        "content_caps": crate::content_server::CONTENT_CAPS,
        "content_rev": content_rev,
        "state_version": state_version,
        "snapshot": snapshot,
        "licence": licence,
    }))
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

    let mut meta_pairs: Vec<(String, Option<String>)> = body
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
    // A launch-time customer is stamped with the mother's clock: every LAN
    // assignment then compares on one clock (project_licensee_customers).
    if meta_pairs.iter().any(|(k, v)| k == "customerId" && v.is_some()) {
        meta_pairs.retain(|(k, _)| k != "customerAssignedAt");
        meta_pairs.push(("customerAssignedAt".to_string(), Some(now_iso_ms())));
    }

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

/// Every game this device holds for the client, with what orders two copies
/// (`is_newer`), plus the tombstones of the games deleted or archived here.
/// A peer compares it with its own list to decide what to push and what to
/// pull (`client_reconcile_with_mother`).
fn inventory_sync(c: &rusqlite::Connection, client_id: i64) -> rusqlite::Result<(Vec<Value>, Vec<Value>)> {
    let games = c
        .prepare(
            "SELECT id, summary_uuid, name, mother_epoch, state_version, ended, ended_at
             FROM lg_launched_games WHERE client_id = ?",
        )?
        .query_map(params![client_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "summary_uuid": r.get::<_, String>(1)?,
                "name": r.get::<_, String>(2)?,
                "mother_epoch": r.get::<_, i64>(3)?,
                "state_version": r.get::<_, i64>(4)?,
                "ended": r.get::<_, i64>(5)? != 0,
                "ended_at": r.get::<_, Option<i64>>(6)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let tombstones = c
        .prepare("SELECT summary_uuid, kind, mother_epoch, state_version FROM lg_game_tombstones")?
        .query_map([], |r| {
            Ok(json!({
                "summary_uuid": r.get::<_, String>(0)?,
                "kind": r.get::<_, String>(1)?,
                "mother_epoch": r.get::<_, i64>(2)?,
                "state_version": r.get::<_, i64>(3)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((games, tombstones))
}

async fn inventory(state: &AppState) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    let (games, tombstones) = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(Vec<Value>, Vec<Value>)> {
            Ok(inventory_sync(c, client_id)?)
        })
        .await?;
    Ok(json!({
        "mother_uuid": state.mother_uuid,
        "client_id": client_id,
        "games": games,
        "tombstones": tombstones,
    }))
}

/// Renderer event fired when a peer's copy of a game replaced ours, so open
/// game lists reload.
const GAMES_RECONCILED_EVENT: &str = "taghunter://games-reconciled";

/// A peer hands this mother its copy of one game. Body:
/// `{ snapshot: <build_snapshot bundle>, hosted: bool }`. Never an HTTP error
/// for a refusal: `applied: false` with a `reason` is an answer the pusher
/// acts on (see `adopt_peer_snapshot`).
async fn push_snapshot(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let snap = body
        .get("snapshot")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| ApiErr::bad("snapshot is required"))?;
    let hosted = vbool(&body, "hosted");
    let client_id = state.client_id;
    let outcome = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<AdoptOutcome> {
            let tx = c.transaction()?;
            let outcome = adopt_peer_snapshot(&tx, &snap, client_id, hosted)?;
            if outcome.applied {
                // This device HOSTS the game from now on. A snapshot of it cached
                // while following another host (same id, epoch at least ours)
                // would make it read as a mere copy - see the "hosted" rule in
                // `client_reconcile_with_mother`.
                tx.execute(
                    "DELETE FROM mother_snapshots WHERE launched_game_id = ?",
                    params![outcome.game_id],
                )?;
                tx.commit()?;
            }
            Ok(outcome)
        })
        .await?;

    if outcome.applied {
        // A running game can come in at a higher epoch than the one this server
        // advertises (its frozen copy was older): advertise it, or satellites
        // that cached that epoch keep looking for another host.
        if !outcome.ended {
            let server = state.app.state::<MotherServerState>();
            let mut guard = server.inner.lock().await;
            if let Some(running) = guard.as_mut() {
                if outcome.mother_epoch > running.epoch {
                    running.epoch = outcome.mother_epoch;
                    let _ = reregister_mdns(running);
                }
            }
        }
        use tauri::Emitter;
        let _ = state.app.emit(
            GAMES_RECONCILED_EVENT,
            json!({ "launched_game_id": outcome.game_id, "ended": outcome.ended }),
        );
    }
    Ok(json!({
        "applied": outcome.applied,
        "reason": outcome.reason,
        "game_id": outcome.game_id,
        "mother_epoch": outcome.mother_epoch,
    }))
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
            Ok(list_games_sync(c, client_id, ended_filter.as_deref(), mine)?)
        })
        .await?;
    Ok(json!({ "games": games }))
}

/// The `list` query on a bare connection, so a device with no running server
/// can read its own games (`client_list_local_games`).
fn list_games_sync(
    c: &rusqlite::Connection,
    client_id: i64,
    ended_filter: Option<&str>,
    mine: bool,
) -> rusqlite::Result<Vec<Value>> {
    // Composed WHERE clause: client scope + optional ended + optional
    // ownership, so the four param combinations share one query builder.
    let mut where_sql = String::from("WHERE client_id = ?");
    match ended_filter {
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
                         AND m.meta_name IN ('testMode', 'simulated')
                         AND m.meta_value = 'true') AS is_test,
                summary_uuid,
                EXISTS(SELECT 1 FROM lg_launched_game_meta m
                       WHERE m.launched_game_id = lg_launched_games.id
                         AND m.meta_name = 'simulated'
                         AND m.meta_value = 'true') AS is_simulated,
                (SELECT m.meta_value FROM lg_launched_game_meta m
                  WHERE m.launched_game_id = lg_launched_games.id
                    AND m.meta_name = 'customerId' LIMIT 1) AS customer_id,
                (SELECT m.meta_value FROM lg_launched_game_meta m
                  WHERE m.launched_game_id = lg_launched_games.id
                    AND m.meta_name = 'customerName' LIMIT 1) AS customer_name,
                (start_time IS NULL AND ended = 0
                 AND (lower(game_type) = 'clash'
                      OR EXISTS(SELECT 1 FROM lg_launched_game_meta m
                                 WHERE m.launched_game_id = lg_launched_games.id
                                   AND m.meta_name = 'tagquestSelfRegister'
                                   AND m.meta_value = 'true'))) AS awaiting_start
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
            // Cross-device identity: lets a satellite recognise its own
            // local copy of a game the mother also lists.
            "summary_uuid": r.get::<_, String>(12)?,
            // Game simulator session (tester builds). Also counted in is_test
            // above so it is excluded from stats/archive and deletable.
            "is_simulated": r.get::<_, i64>(13)? != 0,
            // Licensee customer (project_licensee_customers), from meta.
            "customer_id": r.get::<_, Option<String>>(14)?,
            "customer_name": r.get::<_, Option<String>>(15)?,
            // Self-registered Quest / Clash still on its registration screen:
            // the card offers a remote Start (`start_game` command).
            "awaiting_start": r.get::<_, i64>(16)? != 0,
        }))
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
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
            // The customer keys are left alone: callers write back a meta map
            // they read earlier, which would revert a reassignment made since.
            // Only create + assign_customer write them.
            tx.execute(
                "DELETE FROM lg_launched_game_meta WHERE launched_game_id = ?
                   AND meta_name NOT IN ('customerId', 'customerName', 'customerAssignedAt')",
                params![id],
            )?;
            for (k, v) in meta_pairs.iter().filter(|(k, _)| !is_customer_meta_key(k)) {
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

/// Upsert ONLY the given meta keys, leaving every other key untouched. Unlike
/// `update_meta` (which replaces the whole map) this is safe to call from
/// several devices at once - the classic case being self-register, where each
/// registration station writes its own per-chip keys concurrently. A read-
/// merge-write on the client cannot do this: two devices that read the same
/// base both write it back and one device's key is silently lost.
///
/// A null value deletes the key.
async fn merge_meta(state: &AppState, body: Value) -> Result<Value, ApiErr> {
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
            // Customer keys: assign_customer only (see update_meta).
            for (k, v) in meta_pairs.iter().filter(|(k, _)| !is_customer_meta_key(k)) {
                // No UNIQUE(launched_game_id, meta_name) on this table, so
                // delete-then-insert rather than ON CONFLICT. Both statements
                // are scoped to the single key, inside one transaction.
                tx.execute(
                    "DELETE FROM lg_launched_game_meta
                     WHERE launched_game_id = ? AND meta_name = ?",
                    params![id, k],
                )?;
                if let Some(val) = v {
                    tx.execute(
                        "INSERT INTO lg_launched_game_meta
                           (launched_game_id, meta_name, meta_value) VALUES (?, ?, ?)",
                        params![id, k, val],
                    )?;
                }
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
        // The column is an INTEGER, but a Tracks percentage is rarely a whole
        // number (4 of 24 checkpoints = 16.66…). `as_i64()` is None for a JSON
        // float, so such a score used to be dropped silently and every Tracks
        // team stayed at 0 (rankings, clues page, team summary). Round instead.
        let n = v
            .as_i64()
            .or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64));
        if let Some(n) = n {
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
    let teams_closed = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<i64> {
            // Stamp the freeze moment (first end wins) so clash's per-minute
            // scoring stops accruing at an early manual-end, not at the scheduled
            // timer expiry. Harmless for other game types.
            let now = game_now_secs(c, id)?;
            c.execute(
                "UPDATE lg_launched_games
                 SET ended = 1,
                     ended_at = COALESCE(ended_at, ?2)
                 WHERE id = ?1",
                params![id, now],
            )?;

            // Clash: lg_teams.score is only persisted on a validation, so it
            // misses the per-minute points earned since the last one. Recompute
            // the standings now that ended_at freezes them, so the saved score
            // is final. Never blocks ending the game. Gated on the game TYPE, not
            // on `clash_config`: a TagQuest self-register team launch carries one
            // too (for its per-team cap only, no territories), and recomputing
            // it as Clash persisted 0 for every team.
            let game_type: Option<String> = c
                .query_row(
                    "SELECT game_type FROM lg_launched_games WHERE id = ?",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?;
            if game_type.as_deref().is_some_and(|g| g.eq_ignore_ascii_case("clash")) {
                if let Ok(Some(cfg)) = load_clash_config(c, id) {
                    if let Err(e) = compute_clash_standings(c, id, &cfg, true) {
                        eprintln!("[lan_server] end_game {id}: final clash standings failed: {e}");
                    }
                }
            }

            // Closing the game closes every run still open, for EVERY game type:
            // a team the operator (or the timer) stopped mid-run is finished, not
            // eternally "in progress". Same semantics as the per-team "end team"
            // button - end_time = the freeze moment, and a team that never
            // started gets start_time backfilled so its recorded duration is 0
            // rather than a bogus negative. Their live score in lg_teams is
            // already final, so nothing else needs recomputing, and summaries
            // (which need start_time + end_time + score <> 0) now count them.
            // Clash clans have no per-team run at all; the boards read their
            // status from the standings, so this is inert for them.
            let ended_at: Option<i64> = c
                .query_row(
                    "SELECT ended_at FROM lg_launched_games WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            let stamp = match ended_at {
                Some(v) => v,
                // No row / never stamped (a legacy game ended before ended_at
                // existed): nothing reliable to stamp the teams with.
                None => return Ok(0),
            };
            let closed = c.execute(
                "UPDATE lg_teams
                    SET end_time = ?2,
                        start_time = COALESCE(start_time, ?2)
                  WHERE launched_game_id = ?1 AND end_time IS NULL",
                params![id, stamp],
            )?;
            Ok(closed as i64)
        })
        .await?;
    Ok(json!({ "success": true, "teams_closed": teams_closed }))
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

/// Remember that a game was deleted or archived HERE, at the version it had.
/// Call just before the row goes. A device that hosted the game earlier would
/// otherwise push it back at every reconciliation; with the tombstone, only a
/// copy that is newer than the one thrown away comes back (see `is_newer`).
fn write_tombstone(c: &rusqlite::Connection, game_id: i64, kind: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO lg_game_tombstones (summary_uuid, kind, mother_epoch, state_version)
         SELECT summary_uuid, ?2, mother_epoch, state_version FROM lg_launched_games WHERE id = ?1
         ON CONFLICT(summary_uuid) DO UPDATE SET
           kind = excluded.kind,
           mother_epoch = excluded.mother_epoch,
           state_version = excluded.state_version,
           created_at = CURRENT_TIMESTAMP",
        params![game_id, kind],
    )?;
    Ok(())
}

async fn delete_game(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    let client_id = state.client_id;
    let self_peer_id = state.self_peer_id;
    require_game_owned(state, id).await?;
    let mother_in = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
            // Every other device showing this game leaves it.
            let mother_in = queue_game_gone(c, id, peer_id, self_peer_id, "game_deleted")?;
            // Hard delete also discards any non-archived local summary for this
            // game (Delete = "throw it away"; Archive is the "keep the summary"
            // path). Archived summaries point at a now-gone game id and are left
            // intact. A summary already pushed to studio stays in studio.
            c.execute(
                "DELETE FROM lg_game_summaries
                 WHERE launched_game_id = ? AND client_id = ? AND archived_at IS NULL",
                params![id, client_id],
            )?;
            write_tombstone(c, id, "deleted")?;
            c.execute(
                "DELETE FROM lg_launched_games WHERE id = ? AND client_id = ?",
                params![id, client_id],
            )?;
            Ok(mother_in)
        })
        .await?;
    if mother_in {
        dispatch_game_gone_local(state, id, "game_deleted");
    }
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
    /// The licensee customer, from the game's meta (project_licensee_customers).
    /// Not part of content_hash: a reassignment sets customer_dirty instead.
    customer_id: Option<String>,
    customer_name: Option<String>,
    customer_assigned_at: Option<String>,
}

/// True when the launch was flagged as a test (meta testMode='true') or is a
/// game-simulator session (meta simulated='true'). Neither is ever summarised.
fn game_is_test(c: &rusqlite::Connection, game_id: i64) -> rusqlite::Result<bool> {
    let n: i64 = c.query_row(
        "SELECT COUNT(*) FROM lg_launched_game_meta
         WHERE launched_game_id = ?1 AND meta_name IN ('testMode', 'simulated')
           AND meta_value = 'true'",
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
    let (customer_id, customer_name, customer_assigned_at) = meta_customer(c, game_id)?;

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
        customer_id,
        customer_name,
        customer_assigned_at,
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
    let existing: Option<(String, Option<String>)> = c
        .query_row(
            "SELECT content_hash, customer_assigned_at FROM lg_game_summaries WHERE summary_uuid = ?1",
            params![s.summary_uuid],
            |r| Ok((r.get::<_, Option<String>>(0)?.unwrap_or_default(), r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    // A customer (re)assignment newer than the stored one is copied over and
    // flagged dirty, independently of the stats hash below.
    if let (Some((_, stored_at)), Some(at)) = (&existing, &s.customer_assigned_at) {
        if stored_at.as_deref().map_or(true, |old| at.as_str() > old) {
            c.execute(
                "UPDATE lg_game_summaries
                   SET customer_id = ?2, customer_name = ?3, customer_assigned_at = ?4,
                       customer_dirty = 1, updated_at = ?5
                 WHERE summary_uuid = ?1",
                params![s.summary_uuid, s.customer_id, s.customer_name, at, now],
            )?;
        }
    }
    match existing.map(|(h, _)| h) {
        None => {
            c.execute(
                "INSERT INTO lg_game_summaries
                   (summary_uuid, launched_game_id, client_id, game_uniqid, name, game_type,
                    played_at, teams_launched, teams_played, players_played, content_hash,
                    pushed_at, archived_at, created_at, updated_at,
                    customer_id, customer_name, customer_assigned_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,NULL,?12,?12,?13,?14,?15)",
                params![
                    s.summary_uuid, game_id, s.client_id, s.game_uniqid, s.name, s.game_type,
                    s.played_at, s.teams_launched, s.teams_played, s.players_played,
                    s.content_hash, now, s.customer_id, s.customer_name, s.customer_assigned_at
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
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(Vec<Value>, Vec<Value>)> {
            let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

            // 1. Auto-end stale games (>24h since start, or since creation when
            //    never started - the latter just clears them from the list).
            //    The freeze moment and a new version are stamped too: this is a
            //    change of the game like any other, and reconciliation compares
            //    copies on (epoch, ended, version).
            let stale: i64 = c.query_row(
                "SELECT COUNT(*) FROM lg_launched_games
                 WHERE client_id = ?1 AND ended = 0
                   AND COALESCE(start_time, created_at) < datetime('now','-24 hours')",
                params![client_id],
                |r| r.get(0),
            )?;
            if stale > 0 {
                let version = bump_state_version_sync(c, None)?;
                c.execute(
                    "UPDATE lg_launched_games
                       SET ended = 1, updated_at = ?2, state_version = ?3,
                           ended_at = COALESCE(ended_at, CAST(strftime('%s','now') AS INTEGER))
                     WHERE client_id = ?1 AND ended = 0
                       AND COALESCE(start_time, created_at) < datetime('now','-24 hours')",
                    params![client_id, now, version],
                )?;
            }

            // 1b. Adopt newer studio-side customer reassignments (studio's
            //     game view, cached by the customers sync). Before the recompute
            //     so the meta it reads is already up to date.
            flow_back_customer_assignments(c, client_id)?;

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

            // 3. Return everything still awaiting a push (new, changed, a
            //    customer reassignment, or a previous push that never got acked).
            //    customer_assigned_at is sent only when set: an older studio
            //    ignores it, a newer one leaves the customer alone without it.
            let merges = customer_redirects(c, client_id)?;
            let mut stmt = c.prepare(
                "SELECT summary_uuid, name, game_type, game_uniqid, played_at,
                        teams_launched, teams_played, players_played,
                        customer_id, customer_name, customer_assigned_at
                 FROM lg_game_summaries
                 WHERE client_id = ?1 AND (pushed_at IS NULL OR customer_dirty = 1)",
            )?;
            let rows = stmt.query_map(params![client_id], |r| {
                let mut v = json!({
                    "summary_uuid": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "game_type": r.get::<_, String>(2)?,
                    "scenario_uniqid": r.get::<_, String>(3)?,
                    "played_at": r.get::<_, Option<String>>(4)?,
                    "teams_launched": r.get::<_, Option<i64>>(5)?,
                    "teams_played": r.get::<_, i64>(6)?,
                    "players_played": r.get::<_, i64>(7)?,
                });
                if let Some(at) = r.get::<_, Option<String>>(10)? {
                    let cid = r.get::<_, Option<String>>(8)?.map(|id| resolve_customer_id(&merges, &id));
                    v["customer_id"] = json!(cid);
                    v["customer_name"] = json!(r.get::<_, Option<String>>(9)?);
                    v["customer_assigned_at"] = json!(at);
                }
                Ok(v)
            })?;
            let summaries = rows.collect::<rusqlite::Result<Vec<_>>>()?;

            // Customers quick-created on this LAN, not yet sent to studio.
            let mut stmt = c.prepare(
                "SELECT id, name, type, created_at FROM customers
                 WHERE client_id = ?1 AND origin = 'local' AND pushed_at IS NULL AND deleted = 0",
            )?;
            let rows = stmt.query_map(params![client_id], |r| {
                Ok(json!({
                    "customer_id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "type": r.get::<_, Option<String>>(2)?,
                    "created_at": r.get::<_, String>(3)?,
                }))
            })?;
            let customers = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((summaries, customers))
        })
        .await?;
    Ok(json!({ "summaries": to_push.0, "customers": to_push.1 }))
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
    // customer_assigned: {summary_uuid: customer_assigned_at|null} as pushed.
    // The dirty flag is cleared only when the assignment did not change since
    // (a reassignment during the push must go out next time). Absent (older
    // caller): cleared unconditionally.
    let assigned: Option<serde_json::Map<String, Value>> =
        body.get("customer_assigned").and_then(|v| v.as_object()).cloned();
    let customer_ids: Vec<String> = body
        .get("customer_ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    if uuids.is_empty() && customer_ids.is_empty() {
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
                match assigned.as_ref().map(|m| m.get(u)) {
                    Some(Some(at)) => {
                        c.execute(
                            "UPDATE lg_game_summaries SET customer_dirty = 0
                             WHERE client_id = ?1 AND summary_uuid = ?2
                               AND customer_assigned_at IS ?3",
                            params![client_id, u, at.as_str()],
                        )?;
                    }
                    Some(None) => {}
                    None => {
                        c.execute(
                            "UPDATE lg_game_summaries SET customer_dirty = 0
                             WHERE client_id = ?1 AND summary_uuid = ?2",
                            params![client_id, u],
                        )?;
                    }
                }
            }
            for id in &customer_ids {
                c.execute(
                    "UPDATE customers SET pushed_at = ?3, updated_at = ?3
                     WHERE client_id = ?1 AND id = ?2 AND pushed_at IS NULL",
                    params![client_id, id, now],
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
async fn archive_game(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
    let id = json_i64(&body, "id")?;
    require_game_owned(state, id).await?;
    let client_id = state.client_id;
    let self_peer_id = state.self_peer_id;
    let (kept, mother_in) = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(bool, bool)> {
            // Every other device showing this game leaves it.
            let mother_in = queue_game_gone(c, id, peer_id, self_peer_id, "game_archived")?;
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
            write_tombstone(c, id, "archived")?;
            // Cascades to lg_teams / lg_team_completed_quests / meta / devices /
            // raw_data. The summary row (no FK to the game) survives.
            c.execute(
                "DELETE FROM lg_launched_games WHERE id = ?1 AND client_id = ?2",
                params![id, client_id],
            )?;
            Ok((kept, mother_in))
        })
        .await?;
    if mother_in {
        dispatch_game_gone_local(state, id, "game_archived");
    }
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
                        teams_launched, teams_played, players_played, archived_at, pushed_at,
                        customer_id, customer_name
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
                    "customer_id": r.get::<_, Option<String>>(10)?,
                    "customer_name": r.get::<_, Option<String>>(11)?,
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "summaries": rows }))
}

// ─── licensee customers (project_licensee_customers) ──────────────────────────
//
// The licensee's OWN customers (companies, schools...), not the licensee
// (`client_id`). The mother owns the LAN's view: the `customers` cache synced
// from studio (TS customersStore), quick-creates made on any device of the LAN
// (origin='local', pushed as `customer_upsert` telemetry), and each game's
// assignment - meta customerId / customerName / customerAssignedAt while the
// game lives, lg_game_summaries.customer_* after. customerAssignedAt (ISO UTC
// ms, mother clock) decides against a studio-side edit: strictly newest wins.

const CUSTOMER_META_KEYS: [&str; 3] = ["customerId", "customerName", "customerAssignedAt"];

fn is_customer_meta_key(k: &str) -> bool {
    CUSTOMER_META_KEYS.contains(&k)
}

fn now_iso_ms() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, ch)| {
            if matches!(i, 8 | 13 | 18 | 23) { ch == '-' } else { ch.is_ascii_hexdigit() }
        })
}

/// (customerId, customerName, customerAssignedAt) from a game's meta.
fn meta_customer(
    c: &rusqlite::Connection,
    game_id: i64,
) -> rusqlite::Result<(Option<String>, Option<String>, Option<String>)> {
    let mut stmt = c.prepare(
        "SELECT meta_name, meta_value FROM lg_launched_game_meta
         WHERE launched_game_id = ?1
           AND meta_name IN ('customerId', 'customerName', 'customerAssignedAt')",
    )?;
    let mut out = (None, None, None);
    let rows = stmt.query_map(params![game_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    for row in rows {
        let (k, v) = row?;
        match k.as_str() {
            "customerId" => out.0 = v.filter(|s| !s.is_empty()),
            "customerName" => out.1 = v,
            _ => out.2 = v.filter(|s| !s.is_empty()),
        }
    }
    Ok(out)
}

/// Write a game's customer meta (None id = no customer, still timestamped so
/// the removal wins over an older assignment elsewhere).
fn write_meta_customer(
    c: &rusqlite::Connection,
    game_id: i64,
    customer_id: Option<&str>,
    customer_name: Option<&str>,
    at: &str,
) -> rusqlite::Result<()> {
    c.execute(
        "DELETE FROM lg_launched_game_meta WHERE launched_game_id = ?1
           AND meta_name IN ('customerId', 'customerName', 'customerAssignedAt')",
        params![game_id],
    )?;
    let put = |k: &str, v: &str| {
        c.execute(
            "INSERT INTO lg_launched_game_meta (launched_game_id, meta_name, meta_value) VALUES (?1, ?2, ?3)",
            params![game_id, k, v],
        )
    };
    if let Some(id) = customer_id {
        put("customerId", id)?;
        if let Some(n) = customer_name {
            put("customerName", n)?;
        }
    }
    put("customerAssignedAt", at)?;
    Ok(())
}

/// Merged id -> the id it was merged into (studio tombstones, cached).
fn customer_redirects(c: &rusqlite::Connection, client_id: i64) -> rusqlite::Result<HashMap<String, String>> {
    let mut stmt = c.prepare(
        "SELECT id, merged_into_id FROM customers WHERE client_id = ?1 AND merged_into_id IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![client_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

fn resolve_customer_id(redirects: &HashMap<String, String>, id: &str) -> String {
    let mut cur = id.to_string();
    for _ in 0..5 {
        match redirects.get(&cur) {
            Some(next) => cur = next.clone(),
            None => break,
        }
    }
    cur
}

/// Adopt studio-side reassignments newer than the local one: the summary takes
/// the studio value without being marked dirty (no echo back), and a game still
/// on the device gets its meta rewritten so its chip and next recompute agree.
fn flow_back_customer_assignments(c: &rusqlite::Connection, client_id: i64) -> rusqlite::Result<usize> {
    let pending: Vec<(String, Option<String>, String)> = {
        let mut stmt = c.prepare(
            "SELECT s.summary_uuid, cg.customer_id, cg.customer_assigned_at
             FROM lg_game_summaries s
             JOIN customer_games cg ON cg.summary_uuid = s.summary_uuid AND cg.client_id = s.client_id
             WHERE s.client_id = ?1 AND cg.customer_assigned_at IS NOT NULL
               AND (s.customer_assigned_at IS NULL OR cg.customer_assigned_at > s.customer_assigned_at)",
        )?;
        let rows = stmt.query_map(params![client_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (uuid, customer_id, at) in &pending {
        let name: Option<String> = match customer_id {
            Some(id) => c
                .query_row("SELECT name FROM customers WHERE id = ?1", params![id], |r| r.get(0))
                .optional()?,
            None => None,
        };
        c.execute(
            "UPDATE lg_game_summaries
               SET customer_id = ?2, customer_name = ?3, customer_assigned_at = ?4, customer_dirty = 0
             WHERE client_id = ?1 AND summary_uuid = ?5",
            params![client_id, customer_id, name, at, uuid],
        )?;
        let game_id: Option<i64> = c
            .query_row(
                "SELECT id FROM lg_launched_games WHERE client_id = ?1 AND summary_uuid = ?2",
                params![client_id, uuid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(gid) = game_id {
            write_meta_customer(c, gid, customer_id.as_deref(), name.as_deref(), at)?;
            bump_state_version_sync(c, Some(gid))?;
        }
    }
    Ok(pending.len())
}

/// The LAN's customer list + per-customer played scenarios (the scenario-list
/// badges). A game counts once, under the newest of: studio's view, the local
/// summary, or a running game's meta. Test / simulated games never count, nor
/// an ended game nobody played (no summary).
fn customers_list_sync(c: &rusqlite::Connection, client_id: i64) -> rusqlite::Result<Value> {
    let redirects = customer_redirects(c, client_id)?;
    let mut customers: Vec<Value> = Vec::new();
    let mut known: HashSet<String> = HashSet::new();
    {
        let mut stmt = c.prepare(
            "SELECT id, name, type, city, archived, deleted, merged_into_id FROM customers
             WHERE client_id = ?1 ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map(params![client_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?;
        for row in rows {
            let (id, name, ty, city, archived, deleted, merged) = row?;
            known.insert(id.clone());
            if merged.is_none() && deleted == 0 {
                customers.push(json!({ "id": id, "name": name, "type": ty, "city": city, "archived": archived != 0 }));
            }
        }
    }

    // summary_uuid -> (customer_id, game_uniqid, played_at, assigned_at, from_studio)
    type Cand = (Option<String>, Option<String>, Option<String>, String, bool);
    let mut best: HashMap<String, Cand> = HashMap::new();
    let mut orphans: HashMap<String, String> = HashMap::new();
    let mut consider = |uuid: String, cand: Cand| {
        let keep_old = best
            .get(&uuid)
            .map_or(false, |old| old.3 > cand.3 || (old.3 == cand.3 && old.4));
        if !keep_old {
            best.insert(uuid, cand);
        }
    };
    {
        let mut stmt = c.prepare(
            "SELECT summary_uuid, customer_id, game_uniqid, played_at, customer_assigned_at
             FROM customer_games WHERE client_id = ?1 AND customer_assigned_at IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![client_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, String>(4)?))
        })?;
        for row in rows {
            let (u, cid, g, p, at) = row?;
            consider(u, (cid, g, p, at, true));
        }
    }
    {
        let mut stmt = c.prepare(
            "SELECT summary_uuid, customer_id, game_uniqid, played_at, customer_assigned_at, customer_name
             FROM lg_game_summaries WHERE client_id = ?1 AND customer_assigned_at IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![client_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get(2)?, r.get(3)?,
                r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?))
        })?;
        for row in rows {
            let (u, cid, g, p, at, name) = row?;
            if let (Some(id), Some(n)) = (&cid, name) {
                orphans.insert(id.clone(), n);
            }
            consider(u, (cid, g, p, at, false));
        }
    }
    {
        let mut stmt = c.prepare(
            "SELECT g.summary_uuid, g.game_uniqid, COALESCE(g.start_time, g.created_at),
                    (SELECT meta_value FROM lg_launched_game_meta m WHERE m.launched_game_id = g.id AND m.meta_name = 'customerId' LIMIT 1),
                    (SELECT meta_value FROM lg_launched_game_meta m WHERE m.launched_game_id = g.id AND m.meta_name = 'customerName' LIMIT 1),
                    (SELECT meta_value FROM lg_launched_game_meta m WHERE m.launched_game_id = g.id AND m.meta_name = 'customerAssignedAt' LIMIT 1)
             FROM lg_launched_games g
             WHERE g.client_id = ?1 AND g.ended = 0
               AND NOT EXISTS (SELECT 1 FROM lg_launched_game_meta m WHERE m.launched_game_id = g.id
                                 AND m.meta_name IN ('testMode', 'simulated') AND m.meta_value = 'true')",
        )?;
        let rows = stmt.query_map(params![client_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<String>>(5)?))
        })?;
        for row in rows {
            let (u, g, p, cid, name, at) = row?;
            let Some(at) = at else { continue };
            if let (Some(id), Some(n)) = (&cid, name) {
                orphans.insert(id.clone(), n);
            }
            consider(u, (cid, g, p, at, false));
        }
    }

    // customer x scenario -> (last played, count)
    let mut played: HashMap<(String, String), (Option<String>, i64)> = HashMap::new();
    for (cid, uniqid, played_at, _, _) in best.into_values() {
        let (Some(cid), Some(uniqid)) = (cid, uniqid) else { continue };
        let e = played.entry((resolve_customer_id(&redirects, &cid), uniqid)).or_insert((None, 0));
        e.1 += 1;
        if played_at > e.0 {
            e.0 = played_at;
        }
    }
    let played: Vec<Value> = played
        .into_iter()
        .map(|((cid, uniqid), (last, count))| {
            json!({ "customer_id": cid, "game_uniqid": uniqid, "last_played_at": last, "count": count })
        })
        .collect();

    // Ids games still carry but this cache lacks (a promoted mother whose
    // cache is older, a quick-create on a device since replaced): keep them
    // nameable from the games' own snapshot.
    for (id, name) in orphans {
        if !known.contains(&id) {
            known.insert(id.clone());
            customers.push(json!({ "id": id, "name": name, "type": null, "city": null, "archived": false }));
        }
    }

    let cloud_supported: bool = c
        .query_row(
            "SELECT remote_version IS NOT NULL FROM customers_state WHERE client_id = ?1",
            params![client_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false);

    Ok(json!({
        "supported": true,
        "cloud_supported": cloud_supported,
        "customers": customers,
        "redirects": redirects,
        "played": played,
    }))
}

async fn customers_list(state: &AppState) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    Ok(state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Value> {
            Ok(customers_list_sync(c, client_id)?)
        })
        .await?)
}

/// Quick-create a customer from any device of the LAN (name only, works
/// offline). Idempotent on the client-generated id, so a retry is harmless.
async fn customers_create(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let name: String = json_str(&body, "name")?.trim().chars().take(190).collect();
    if name.is_empty() {
        return Err(ApiErr::bad("name is required"));
    }
    let id = match body.get("id").and_then(|v| v.as_str()) {
        Some(s) if looks_like_uuid(&s.to_lowercase()) => s.to_lowercase(),
        Some(_) => return Err(ApiErr::bad("id must be a UUID")),
        None => uuid::Uuid::new_v4().to_string(),
    };
    // A code from studio's admin-managed customer types; studio validates it.
    let ty = body
        .get("type")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty() && t.len() <= 40)
        .map(|t| t.to_string());
    let client_id = state.client_id;
    let row = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<Value>> {
            let added = c.execute(
                "INSERT OR IGNORE INTO customers (id, client_id, name, type, origin)
                 VALUES (?1, ?2, ?3, ?4, 'local')",
                params![id, client_id, name, ty],
            )?;
            if added > 0 {
                // Satellites see the revision move on their next ping and take a
                // copy right away (customers_sync.rs), so whoever hosts next
                // still lists this customer.
                c.execute("UPDATE content_sync_state SET content_rev = content_rev + 1 WHERE id = 1", [])?;
            }
            Ok(c
                .query_row(
                    "SELECT id, name, type, city, archived FROM customers WHERE id = ?1 AND client_id = ?2",
                    params![id, client_id],
                    |r| {
                        Ok(json!({
                            "id": r.get::<_, String>(0)?,
                            "name": r.get::<_, String>(1)?,
                            "type": r.get::<_, Option<String>>(2)?,
                            "city": r.get::<_, Option<String>>(3)?,
                            "archived": r.get::<_, i64>(4)? != 0,
                        }))
                    },
                )
                .optional()?)
        })
        .await?;
    row.map(|customer| json!({ "customer": customer }))
        .ok_or_else(|| ApiErr::bad("customer id already used"))
}

/// Set / change / clear a game's customer, by summary_uuid: the live game's
/// meta (running or ended) and/or its summary (survives Archive). Stamped with
/// the mother's clock; the summary is flagged for re-push.
fn assign_customer_sync(
    c: &rusqlite::Connection,
    client_id: i64,
    summary_uuid: &str,
    customer_id: Option<&str>,
    fallback_name: Option<&str>,
    at: &str,
) -> rusqlite::Result<bool> {
    let name: Option<String> = match customer_id {
        Some(id) => c
            .query_row("SELECT name FROM customers WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?
            .or_else(|| fallback_name.map(|s| s.to_string())),
        None => None,
    };
    let game_id: Option<i64> = c
        .query_row(
            "SELECT id FROM lg_launched_games WHERE client_id = ?1 AND summary_uuid = ?2",
            params![client_id, summary_uuid],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(gid) = game_id {
        write_meta_customer(c, gid, customer_id, name.as_deref(), at)?;
        bump_state_version_sync(c, Some(gid))?;
    }
    let n = c.execute(
        "UPDATE lg_game_summaries
           SET customer_id = ?3, customer_name = ?4, customer_assigned_at = ?5, customer_dirty = 1
         WHERE client_id = ?1 AND summary_uuid = ?2",
        params![client_id, summary_uuid, customer_id, name, at],
    )?;
    Ok(game_id.is_some() || n > 0)
}

async fn assign_customer(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    // By summary_uuid (any game, archived included) or by the live game's id.
    let summary_uuid = match body.get("summary_uuid").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            let id = json_i64(&body, "id")?;
            state
                .db
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
                    Ok(c.query_row(
                        "SELECT summary_uuid FROM lg_launched_games WHERE id = ?1 AND client_id = ?2",
                        params![id, client_id],
                        |r| r.get(0),
                    )
                    .optional()?)
                })
                .await?
                .ok_or_else(|| ApiErr::not_found("game not found"))?
        }
    };
    let customer_id = match body.get("customer_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if looks_like_uuid(&s.to_lowercase()) => Some(s.to_lowercase()),
        Some(_) => return Err(ApiErr::bad("customer_id must be a UUID or null")),
    };
    let fallback_name = body.get("customer_name").and_then(|v| v.as_str()).map(|s| s.to_string());
    let at = now_iso_ms();
    let at_reply = at.clone();
    let found = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
            let tx = c.transaction()?;
            let found = assign_customer_sync(
                &tx, client_id, &summary_uuid, customer_id.as_deref(), fallback_name.as_deref(), &at,
            )?;
            tx.commit()?;
            Ok(found)
        })
        .await?;
    if !found {
        return Err(ApiErr::not_found("game not found"));
    }
    Ok(json!({ "success": true, "assigned_at": at_reply }))
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
    caller_device_id: i64,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let launched_game_id = parse_i64(rest, "launched_game_id")?;
    require_game_owned(state, launched_game_id).await?;
    let (self_has_reader, self_screen_state) = self_presence(state).await;
    let (op_ids, self_op) = operator_only_ids(state).await;
    let rows = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(i64, String, Option<String>, i64, Option<String>, i64, Option<String>, Option<i64>, Option<i64>, Option<String>, i64, Option<String>, Option<String>)>> {
            let mut stmt = c.prepare(
                "SELECT pd.id, pd.peer_label, pd.peer_os, pd.is_self,
                        pd.last_seen_at, pd.has_reader, pd.reader_last_seen_at,
                        lgd.id AS lgd_id, lgd.connected, lgd.last_connection_attempt,
                        CASE WHEN pd.last_seen_at IS NOT NULL
                               AND (strftime('%s','now') - strftime('%s', pd.last_seen_at)) < 25
                             THEN 1 ELSE 0 END AS online,
                        pd.screen_state_json, pd.command_caps
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
                    r.get::<_, Option<String>>(12)?,
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
        caps_json,
    ) in rows
    {
        // The mother's own row is never bumped by a ping (it doesn't ping
        // itself), so its DB columns read "offline, no reader, no screen" - which
        // greyed out Reconnect on the mother for anyone viewing from a child. We
        // ARE that device answering: online by definition, live presence.
        let self_row = is_self == 1;
        // Stored as an opaque JSON string; re-parse so the frontend receives a
        // real object (null when never reported / unparseable).
        let screen_state: Value = if self_row {
            self_screen_state.clone()
        } else {
            screen_state_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or(Value::Null)
        };
        let online = if self_row { 1 } else { online };
        let row = json!({
            "id": id,
            "device_label": peer_label,
            "peer_os": peer_os,
            "is_self": self_row,
            "has_reader": if self_row { self_has_reader } else { has_reader == 1 },
            "reader_last_seen_at": reader_last_seen_at,
            "online": online == 1,
            "last_seen_at": last_seen_at,
            "lgd_id": lgd_id,
            "screen_state": screen_state,
            "operator_only": if self_row { self_op } else { op_ids.contains(&id) },
            "caps": if self_row { json!(command_caps()) } else { parse_caps(caps_json.as_deref()) },
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
        // Who is ASKING, resolved from the bearer secret. `is_self` on the rows
        // is this DB owner's own row (the mother), which is meaningless to a
        // satellite reading the mother's list - every satellite would resolve
        // itself to the mother's device_id and pick up the mother's station
        // assignment. Callers that need "my device_id" must use this.
        "caller_device_id": caller_device_id,
        // What the hosting mother's own build handles (its row's `caps` too):
        // the modals gate mother-side actions (disconnect the mother...) on it.
        "mother_caps": command_caps(),
    }))
}

// Same shape as a single `list_paired_with_status` row, but without a launched
// game to anchor against - used by the launch-wizard's step 3 to render the
// device picker BEFORE the game has been created. `lgd_id` is always null.
//
// The mother's own row (is_self) is never bumped by a ping - the mother doesn't
// ping itself - so it would always read "offline" to a child launching from
// here. We ARE the mother answering this request, so it's online by definition,
// and its reader flag comes from the live in-process presence instead.
async fn list_paired_for_launch(state: &AppState, caller_device_id: i64) -> Result<Value, ApiErr> {
    let self_has_reader = match state.app.try_state::<ReaderPresence>() {
        Some(p) => *p.inner.lock().await,
        None => false,
    };
    let (op_ids, self_op) = operator_only_ids(state).await;
    let rows = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let mut stmt = c.prepare(
                "SELECT pd.id, pd.peer_label, pd.peer_os, pd.is_self,
                        pd.last_seen_at, pd.has_reader, pd.reader_last_seen_at,
                        CASE WHEN pd.is_self = 1
                               OR (pd.last_seen_at IS NOT NULL
                                   AND (strftime('%s','now') - strftime('%s', pd.last_seen_at)) < 25)
                             THEN 1 ELSE 0 END AS online
                   FROM paired_devices pd
                 ORDER BY pd.is_self DESC, online DESC, pd.last_seen_at DESC",
            )?;
            let rows = stmt.query_map([], |r| {
                let is_self = r.get::<_, i64>(3)? == 1;
                let id = r.get::<_, i64>(0)?;
                Ok(json!({
                    "id": id,
                    "operator_only": if is_self { self_op } else { op_ids.contains(&id) },
                    "device_label": r.get::<_, String>(1)?,
                    "peer_os": r.get::<_, Option<String>>(2)?,
                    "is_self": is_self,
                    "last_seen_at": r.get::<_, Option<String>>(4)?,
                    "has_reader": if is_self { self_has_reader } else { r.get::<_, i64>(5)? == 1 },
                    "reader_last_seen_at": r.get::<_, Option<String>>(6)?,
                    "online": r.get::<_, i64>(7)? == 1,
                    "lgd_id": Value::Null,
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    // `is_self` marks the MOTHER's row (the DB owner), whoever asks. A child
    // launching from here needs to know which row is ITSELF - see
    // list_paired_with_status for the same field.
    Ok(json!({ "devices": rows, "caller_device_id": caller_device_id }))
}

/// Operator-only peers (as last reported in their pings) + this device's own
/// live setting (the mother never pings itself).
async fn operator_only_ids(state: &AppState) -> (std::collections::HashSet<i64>, bool) {
    let self_op = match state.app.try_state::<OperatorPresence>() {
        Some(p) => *p.inner.lock().await,
        None => false,
    };
    let ids = state
        .db
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<std::collections::HashSet<i64>> {
            let mut stmt = c.prepare("SELECT id FROM paired_devices WHERE operator_only = 1 AND is_self = 0")?;
            let ids = stmt
                .query_map([], |r| r.get::<_, i64>(0))?
                .collect::<rusqlite::Result<std::collections::HashSet<i64>>>()?;
            Ok(ids)
        })
        .await
        .unwrap_or_default();
    (ids, self_op)
}

/// This (hosting) device's upkeep report, for its own `is_self` row.
async fn self_upkeep(state: &AppState) -> Value {
    match state.app.try_state::<UpkeepPresence>() {
        Some(p) => p
            .inner
            .lock()
            .await
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null),
        None => Value::Null,
    }
}

/// This (hosting) device's live reader + screen state, for its own `is_self`
/// row - the mother never pings itself, so the DB columns stay stale.
async fn self_presence(state: &AppState) -> (bool, Value) {
    let has_reader = match state.app.try_state::<ReaderPresence>() {
        Some(p) => *p.inner.lock().await,
        None => false,
    };
    let screen_state = match state.app.try_state::<ScreenPresence>() {
        Some(p) => p
            .inner
            .lock()
            .await
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null),
        None => Value::Null,
    };
    (has_reader, screen_state)
}

// Every paired device with its live status, for the top-bar "Devices" modal
// (not tied to one launched game). Each row also lists the ACTIVE games the
// device is registered in - a device can be registered yet showing something
// else (it left the game page without leaving the game), which the screen
// state alone can't tell.
struct FleetDbRow {
    id: i64,
    label: String,
    os: Option<String>,
    is_self: bool,
    last_seen_at: Option<String>,
    has_reader: bool,
    online: bool,
    screen_json: Option<String>,
    app_version: Option<String>,
    platform: Option<String>,
    upkeep_json: Option<String>,
    caps_json: Option<String>,
}

async fn list_fleet(state: &AppState, caller_device_id: i64) -> Result<Value, ApiErr> {
    let (self_has_reader, self_screen_state) = self_presence(state).await;
    let self_upkeep = self_upkeep(state).await;
    let (op_ids, self_op) = operator_only_ids(state).await;
    let content_rev = crate::content_server::content_rev(state).await;
    let installers = crate::update_cache::cached_installers(&state.app);
    let client_id = state.client_id;
    let (devices, regs) = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(Vec<FleetDbRow>, Vec<(i64, i64, String)>)> {
            let mut stmt = c.prepare(
                "SELECT pd.id, pd.peer_label, pd.peer_os, pd.is_self,
                        pd.last_seen_at, pd.has_reader,
                        CASE WHEN pd.last_seen_at IS NOT NULL
                               AND (strftime('%s','now') - strftime('%s', pd.last_seen_at)) < 25
                             THEN 1 ELSE 0 END AS online,
                        pd.screen_state_json,
                        pd.peer_app_version, pd.peer_platform, pd.upkeep_json,
                        pd.command_caps
                   FROM paired_devices pd
                 ORDER BY pd.is_self DESC, online DESC, pd.peer_label COLLATE NOCASE ASC",
            )?;
            let devices = stmt
                .query_map([], |r| {
                    Ok(FleetDbRow {
                        id: r.get(0)?,
                        label: r.get(1)?,
                        os: r.get(2)?,
                        is_self: r.get::<_, i64>(3)? == 1,
                        last_seen_at: r.get(4)?,
                        has_reader: r.get::<_, i64>(5)? == 1,
                        online: r.get::<_, i64>(6)? == 1,
                        screen_json: r.get(7)?,
                        app_version: r.get(8)?,
                        platform: r.get(9)?,
                        upkeep_json: r.get(10)?,
                        caps_json: r.get(11)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            // Newest game first, so the first entry is the one to rejoin.
            let mut stmt = c.prepare(
                "SELECT lgd.device_id, lg.id, lg.name
                   FROM lg_launched_game_devices lgd
                   JOIN lg_launched_games lg ON lg.id = lgd.launched_game_id
                  WHERE lg.client_id = ? AND lg.ended = 0
                  ORDER BY lg.id DESC",
            )?;
            let regs = stmt
                .query_map(params![client_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((devices, regs))
        })
        .await?;

    let parse = |s: Option<&str>| {
        s.and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null)
    };
    let rows: Vec<Value> = devices
        .into_iter()
        .map(|d| {
            let id = d.id;
            let is_self = d.is_self;
            let games: Vec<Value> = regs
                .iter()
                .filter(|(dev, _, _)| *dev == id)
                .map(|(_, gid, name)| json!({ "launched_game_id": gid, "name": name }))
                .collect();
            json!({
                "id": id,
                "device_label": d.label,
                "peer_os": d.os,
                "is_self": is_self,
                "online": is_self || d.online,
                "last_seen_at": d.last_seen_at,
                "has_reader": if is_self { self_has_reader } else { d.has_reader },
                "screen_state": if is_self { self_screen_state.clone() } else { parse(d.screen_json.as_deref()) },
                "operator_only": if is_self { self_op } else { op_ids.contains(&id) },
                "games": games,
                // Upkeep (Devices modal update / sync): an older satellite never
                // reports them, so its version is the one it paired with.
                "app_version": if is_self { Some(crate::app_version().to_string()) } else { d.app_version },
                "platform": if is_self { Some(crate::update_cache::this_platform()) } else { d.platform },
                "upkeep": if is_self { self_upkeep.clone() } else { parse(d.upkeep_json.as_deref()) },
                "caps": if is_self { json!(command_caps()) } else { parse_caps(d.caps_json.as_deref()) },
            })
        })
        .collect();
    Ok(json!({
        "devices": rows,
        "caller_device_id": caller_device_id,
        // What the hosting mother runs and can hand out: devices behind it are
        // flagged in the modal, and update from its cached installers offline.
        "mother": {
            "app_version": crate::app_version(),
            "platform": crate::update_cache::this_platform(),
            "content_rev": content_rev,
            "installers": installers,
            "caps": command_caps(),
        },
    }))
}

/// The command kinds THIS build's renderer handles, reported on every ping
/// (`caps`) and stored on the mother as `paired_devices.command_caps`. The kinds
/// in `NEW_KINDS` are only queued for a peer whose caps list them (an older
/// build silently drops an unknown kind), so the operator gets
/// `409 target_outdated` instead of a click that does nothing.
/// `ack_v2`: acks once the handler ran, with a result (command_status).
/// `self_reload_config` / `self_disconnect`: as a MOTHER, this build accepts
/// those two kinds aimed at itself.
pub fn command_caps() -> Vec<&'static str> {
    #[allow(unused_mut)]
    let mut caps = vec![
        "ack_v2",
        "go_home",
        "unlock_device",
        "hide_logo",
        "start_game",
        "reset_display",
        "set_mute",
        "self_reload_config",
        "self_disconnect",
    ];
    // Relaunch (process plugin) and the USB reader are desktop-only.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    caps.extend(["restart_app", "reader_refresh", "reader_beep"]);
    caps
}

/// Command kinds an older build doesn't know: queued only for a peer that
/// reports them in its caps.
const NEW_KINDS: [&str; 9] = [
    "go_home",
    "unlock_device",
    "hide_logo",
    "start_game",
    "reset_display",
    "set_mute",
    "reader_refresh",
    "reader_beep",
    "restart_app",
];

fn parse_caps(s: Option<&str>) -> Value {
    s.and_then(|s| serde_json::from_str::<Value>(s).ok())
        .filter(|v| v.is_array())
        .unwrap_or(Value::Null)
}

/// Mother push queue. A command is queued for one paired device and delivered on
/// its next /ping.php; a command aimed at the mother itself runs in-process
/// (`emit_local_command`). Kinds and payloads:
/// - `join_game` `{launched_game_id, rejoin?}` - register + open the game page.
/// - `disconnect_device` `{launched_game_id, reason?}` - drop the target's
///   participation row and make it leave the game page. `reason`
///   (`game_deleted` / `game_archived`) when the game itself went away.
/// - `reload_config` `{launched_game_id}` - re-derive the running page's config.
/// - `play_video` `{launched_game_id, kinds[], language}` / `stop_video` `{}`.
/// - `open_ranking` / `show_team_summary` - push a ranking / a team summary.
/// - `lock_device` / `show_logo` - PIN lock overlay / idle logo screen;
///   `unlock_device` / `hide_logo` take them off again (the Devices modal's
///   toggles; the operator waives the device's PIN, as a remote join does).
/// - `sync_content` / `update_app {force?}` - upkeep.
/// - `go_home` `{}` - close every overlay, leave the game page (stays
///   registered) and show the logo screen.
/// - `start_game` `{launched_game_id}` - press Start on a registration screen
///   (self-registered Quest / Clash).
/// - `reset_display` `{launched_game_id}` - clear a Mystery results screen /
///   resume a Tracks screen waiting for Enter.
/// - `set_mute` `{muted}` - Ctrl+M sound mute.
/// - `reader_refresh` / `reader_beep` `{}` - reconnect / test-beep the SI reader.
/// - `restart_app` `{force?, sent_at}` - relaunch the app.
/// - `sim_control` - game simulator (tester builds).
///
/// Authorization: any authenticated paired device may queue commands (children
/// operate the mother's games without having joined). The bearer token is
/// validated upstream by `resolve_peer`; the per-kind target validation below
/// (plus `require_game_owned`, keyed off the hosting mother's own client_id) is
/// what keeps it safe.
async fn queue_command(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
    let target_device_id = json_i64(&body, "target_device_id")?;
    let kind = json_str(&body, "kind")?.to_string();
    let payload = body.get("payload").cloned().unwrap_or(Value::Null);
    let id = queue_command_inner(state, peer_id, target_device_id, &kind, payload).await?;
    Ok(json!({ "command_id": id }))
}

/// Batch convenience used by the launch wizard (`join_game` for N satellites)
/// and the modals' action bars. Per-target failures are returned alongside
/// successes so the caller can render partial-success UI without aborting the
/// whole batch.
async fn queue_command_bulk(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
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
        match queue_command_inner(state, peer_id, target_device_id, &kind, payload.clone()).await {
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

/// The target must currently be a participant of `gid` (409 otherwise).
async fn require_target_in_game(state: &AppState, gid: i64, target_device_id: i64) -> Result<(), ApiErr> {
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
        return Err(ApiErr::status(StatusCode::CONFLICT, "target_not_in_game"));
    }
    Ok(())
}

/// Run a command on the mother's own screen: emit the very same
/// `taghunter://lan-command` event the satellite path emits on /ping.php pickup,
/// with `local: true` (the game lives in OUR db: enter it through our own server
/// route, never repoint at some paired mother). `id: 0`: nothing to ack.
fn emit_local_command(state: &AppState, kind: &str, payload: Value) -> Result<(), ApiErr> {
    use tauri::Emitter;
    state
        .app
        .emit(
            "taghunter://lan-command",
            json!({ "id": 0, "kind": kind, "payload": payload, "local": true }),
        )
        .map_err(|e| {
            ApiErr::status(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("local dispatch failed: {e}"),
            )
        })
}

/// Validates the command and inserts it. Factored out so both `queue_command`
/// and `queue_command_bulk` enforce identical semantics - including the
/// `play_video` preempt rule that auto-acks a previous in-flight `play_video`
/// for the same (target, game) before inserting the new one.
async fn queue_command_inner(
    state: &AppState,
    caller_id: i64,
    target_device_id: i64,
    kind: &str,
    payload: Value,
) -> Result<i64, ApiErr> {
    // Nothing polls the mother's own `pending_commands` (only satellites drain
    // it via /ping.php), so a command for the mother runs IN-PROCESS further
    // down instead of being enqueued: a child's operator drives the room's main
    // display like any other screen. Only the ranking / team-summary pushes stay
    // satellite-only (the mother shows those from its own UI).
    // Game simulator remote control (tester builds) may also drive the mother.
    let to_self = target_device_id == state.self_peer_id;
    let sim_self = cfg!(feature = "devtools") && kind == "sim_control";
    if to_self && !sim_self && matches!(kind, "open_ranking" | "show_team_summary" | "sim_control") {
        return Err(ApiErr::bad("Cannot queue a command targeting self"));
    }
    let launched_game_id = payload
        .get("launched_game_id")
        .and_then(|v| v.as_i64());
    let kind_owned = kind.to_string();

    // A kind an older build doesn't know is refused up front for it.
    if NEW_KINDS.contains(&kind) {
        let supported = if to_self {
            command_caps().contains(&kind)
        } else {
            let caps: Option<String> = state
                .db
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
                    Ok(c.query_row(
                        "SELECT command_caps FROM paired_devices WHERE id = ?",
                        params![target_device_id],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten())
                })
                .await?;
            caps.as_deref()
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .is_some_and(|v| v.iter().any(|k| k == kind))
        };
        if !supported {
            return Err(ApiErr::status(StatusCode::CONFLICT, "target_outdated"));
        }
    }

    // Per-kind validation.
    match kind {
        "join_game" => {
            let gid = launched_game_id
                .ok_or_else(|| ApiErr::bad("payload.launched_game_id is required"))?;
            require_game_owned(state, gid).await?;
            // An operator-only device (every Android tablet) controls games but
            // never plays one: refuse to push it into a game, whoever asks.
            let (op_ids, self_op) = operator_only_ids(state).await;
            let target_op = if to_self {
                self_op
            } else {
                op_ids.contains(&target_device_id)
            };
            if target_op {
                return Err(ApiErr::status(StatusCode::CONFLICT, "target_operator_only"));
            }
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
        // The target must be in the game. For disconnect_device we drop its
        // participation row below (in the same transaction as the command
        // insert) so it leaves the in-game bucket immediately, then the pushed
        // command makes the device leave the in-game page.
        "play_video" | "stop_video" | "reload_config" | "disconnect_device" | "reset_display" => {
            let gid = launched_game_id
                .ok_or_else(|| ApiErr::bad("payload.launched_game_id is required"))?;
            require_game_owned(state, gid).await?;
            require_target_in_game(state, gid, target_device_id).await?;
        }
        "start_game" => {
            // Press Start on the target's registration screen: only while the
            // game is still waiting for it.
            let gid = launched_game_id
                .ok_or_else(|| ApiErr::bad("payload.launched_game_id is required"))?;
            require_game_owned(state, gid).await?;
            require_target_in_game(state, gid, target_device_id).await?;
            let (started, ended): (bool, bool) = state
                .db
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(bool, bool)> {
                    Ok(c.query_row(
                        "SELECT start_time IS NOT NULL, ended = 1 FROM lg_launched_games WHERE id = ?",
                        params![gid],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )?)
                })
                .await?;
            if ended {
                return Err(ApiErr::status(StatusCode::CONFLICT, "game_ended"));
            }
            if started {
                return Err(ApiErr::status(StatusCode::CONFLICT, "already_started"));
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
        "sim_control" if cfg!(feature = "devtools") => {
            // Game simulator remote control (tester builds only): start /
            // pause / speed / stop the simulator executor on the target. The
            // target's executor re-checks the game; here we only verify that
            // the caller owns it.
            let gid = launched_game_id
                .ok_or_else(|| ApiErr::bad("payload.launched_game_id is required"))?;
            require_game_owned(state, gid).await?;
        }
        "set_mute" => {
            if payload.get("muted").and_then(|v| v.as_bool()).is_none() {
                return Err(ApiErr::bad("payload.muted (bool) is required"));
            }
        }
        // Device-level, any paired device, in a game or not. Display / upkeep
        // only; the target's own PIN still gates unlocking, and the target
        // decides what an update / restart takes (a game running there).
        "lock_device" | "unlock_device" | "show_logo" | "hide_logo" | "go_home"
        | "sync_content" | "update_app" | "reader_refresh" | "reader_beep" | "restart_app" => {}
        _ => return Err(ApiErr::bad(format!("Unknown command kind: {kind}"))),
    }

    // Self-targeted command: run it on the mother's own screen. The video
    // overlay's usual "repoint at the pushing mother, then fetch the game state
    // over HTTP" would be wrong here: WE are that mother, the game lives in our
    // own db, and our `launched_games` route may legitimately be pointed at a
    // different mother right now. So resolve the scenario identity server-side
    // and ship it in the payload; the overlay uses those fields verbatim.
    if to_self {
        let mut enriched = payload.clone();
        if kind == "play_video" {
            let gid = launched_game_id
                .ok_or_else(|| ApiErr::bad("payload.launched_game_id is required"))?;
            let ident: Option<(String, String)> = state
                .db
                .call(
                    move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<(String, String)>> {
                        Ok(c.query_row(
                            "SELECT game_uniqid, game_type FROM lg_launched_games WHERE id = ?",
                            params![gid],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?)
                    },
                )
                .await?;
            let (uniqid, game_type) =
                ident.ok_or_else(|| ApiErr::not_found("Launched game not found"))?;
            if let Some(obj) = enriched.as_object_mut() {
                obj.insert("game_uniqid".into(), Value::String(uniqid));
                obj.insert("game_type".into(), Value::String(game_type));
            }
        }
        if kind == "disconnect_device" {
            // Same participation drop as the queued path below.
            let gid = launched_game_id.unwrap_or_default();
            state
                .db
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    c.execute(
                        "DELETE FROM lg_launched_game_devices
                          WHERE launched_game_id = ? AND device_id = ?",
                        params![gid, target_device_id],
                    )?;
                    Ok(())
                })
                .await?;
        }
        emit_local_command(state, kind, enriched)?;
        // Handled in-process: no queue row exists, so there is nothing to ack.
        return Ok(0);
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
                // All-numbered placeholders: a bare `?` here would also bind
                // index 1, so `?1` would alias it and SQLite would see a
                // 2-parameter statement against 3 bound values (hard error).
                c.execute(
                    "UPDATE pending_commands
                        SET acked_at = CURRENT_TIMESTAMP
                      WHERE target_device_id = ?1
                        AND kind = 'play_video'
                        AND acked_at IS NULL
                        AND (payload_json LIKE '%' || ?2 || '%'
                             OR payload_json LIKE '%' || ?3 || '%')",
                    params![target_device_id, needle, alt_needle],
                )?;
            }
            c.execute(
                "INSERT INTO pending_commands (target_device_id, kind, payload_json, queued_by)
                 VALUES (?, ?, ?, ?)",
                params![target_device_id, kind_for_insert, payload_str, caller_id],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?;
    Ok(new_id)
}

/// The game is being deleted / archived: queue a `disconnect_device` (with the
/// reason) for every device registered in it except the mother and the caller,
/// so their game page leaves instead of polling a game that is gone. Runs in the
/// delete/archive transaction, BEFORE the game row (and its device rows) go.
/// Returns whether the mother itself was in the game (the caller then dispatches
/// it in-process after commit). `disconnect_device` is a kind every build knows.
fn queue_game_gone(
    c: &rusqlite::Connection,
    gid: i64,
    caller_id: i64,
    self_peer_id: i64,
    reason: &str,
) -> rusqlite::Result<bool> {
    let mut stmt = c.prepare(
        "SELECT device_id FROM lg_launched_game_devices WHERE launched_game_id = ?",
    )?;
    let devices: Vec<i64> = stmt
        .query_map(params![gid], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let payload = json!({ "launched_game_id": gid, "reason": reason }).to_string();
    let mut mother_in = false;
    for d in devices {
        if d == caller_id {
            continue;
        }
        if d == self_peer_id {
            mother_in = true;
            continue;
        }
        c.execute(
            "INSERT INTO pending_commands (target_device_id, kind, payload_json, queued_by)
             VALUES (?, 'disconnect_device', ?, ?)",
            params![d, payload, caller_id],
        )?;
    }
    Ok(mother_in)
}

/// After a delete/archive commit: the mother's own screen leaves the game too.
fn dispatch_game_gone_local(state: &AppState, gid: i64, reason: &str) {
    let _ = emit_local_command(
        state,
        "disconnect_device",
        json!({ "launched_game_id": gid, "reason": reason }),
    );
}

/// Satellite-side confirmation that a command was acted upon. Only the target
/// device may ack its own command. Idempotent: re-acking is a no-op. A current
/// build acks once its handler ran and sends what happened (`result`: `{ok,
/// error?, detail?}`, kept for the sender's `command_status`); an older build
/// acks on receipt, without one.
async fn ack_command(state: &AppState, peer_id: i64, body: Value) -> Result<Value, ApiErr> {
    let command_id = json_i64(&body, "command_id")?;
    let result: Option<String> = body
        .get("result")
        .filter(|v| v.is_object())
        .map(|v| v.to_string())
        .filter(|s| s.len() <= 1024);
    let updated = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<usize> {
            Ok(c.execute(
                "UPDATE pending_commands
                    SET acked_at = COALESCE(acked_at, CURRENT_TIMESTAMP),
                        result_json = COALESCE(result_json, ?3)
                  WHERE id = ?1 AND target_device_id = ?2",
                params![command_id, peer_id, result],
            )?)
        })
        .await?;
    if updated == 0 {
        return Err(ApiErr::not_found("Command not found or not owned by caller"));
    }
    Ok(json!({ "ok": true }))
}

/// The sender reads back what became of the commands it queued: delivered, done
/// and the target's result. Only rows this caller queued (`queued_by`). A row
/// pruned (1 h after its ack, 15 min undelivered) is simply absent.
async fn command_status(
    state: &AppState,
    peer_id: i64,
    rest: &HashMap<String, String>,
) -> Result<Value, ApiErr> {
    let ids: Vec<i64> = rest
        .get("ids")
        .map(|s| s.split(',').filter_map(|x| x.trim().parse::<i64>().ok()).collect())
        .unwrap_or_default();
    if ids.is_empty() || ids.len() > 64 {
        return Err(ApiErr::bad("ids is required (1-64 comma-separated ids)"));
    }
    let rows = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
            let placeholders = vec!["?"; ids.len()].join(",");
            let sql = format!(
                "SELECT id, target_device_id, kind, delivered_at, acked_at, result_json
                   FROM pending_commands
                  WHERE queued_by = ? AND id IN ({placeholders})"
            );
            let mut stmt = c.prepare(&sql)?;
            let mut args: Vec<i64> = vec![peer_id];
            args.extend(ids.iter().copied());
            let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
                let result: Option<String> = r.get(5)?;
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "target_device_id": r.get::<_, i64>(1)?,
                    "kind": r.get::<_, String>(2)?,
                    "delivered_at": r.get::<_, Option<String>>(3)?,
                    "acked_at": r.get::<_, Option<String>>(4)?,
                    "result": result
                        .as_deref()
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .unwrap_or(Value::Null),
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(json!({ "commands": rows }))
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

    // Duplicate check + insert in ONE db call (the connection runs calls one at
    // a time): split in two, two teammates' reads arriving together could both
    // pass the check and record the same quest twice.
    let (inserted, id) = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(bool, i64)> {
            if !allow_duplicates {
                let existing: Option<i64> = c
                    .query_row(
                        "SELECT id FROM lg_team_completed_quests
                         WHERE team_id = ? AND quest_number = ?",
                        params![team_id, quest_number],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(eid) = existing {
                    return Ok((false, eid));
                }
            }
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
            Ok((true, c.last_insert_rowid()))
        })
        .await?;
    Ok(json!({ "inserted": inserted, "id": id }))
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
    /// The HUMAN-facing station numbers (`si_balises.station_name`) the author
    /// typed, positionally paired with `balises` (which hold the ids the SI
    /// punches actually carry). Persisted by the launch so a station can name
    /// the balises a player is still missing in the numbers printed on them -
    /// retours #96. Empty on pre-2026-09 launches ⇒ fall back to the ids.
    balise_numbers: Vec<i64>,
}

impl ClashTerr {
    /// Label for the k-th balise of this territory: the authored number when the
    /// launch carried one, else the raw station id.
    fn balise_label(&self, k: usize) -> i64 {
        self.balise_numbers
            .get(k)
            .copied()
            .unwrap_or_else(|| self.balises.get(k).copied().unwrap_or_default())
    }
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
            let balise_numbers: Vec<i64> = t
                .get("balise_numbers")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|s| s.as_i64()).collect())
                .unwrap_or_default();
            territories.push(ClashTerr {
                index,
                points,
                balises,
                balise_numbers,
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
/// "Now" for one game, in epoch seconds: the game simulator's virtual clock when
/// the game carries a `sim_clock` meta (tester builds - written by the
/// simulator director), else the wall clock. Keeps Clash ownership minutes,
/// validation stamps and the end stamp in the same timeline as the pages.
fn game_now_secs(c: &rusqlite::Connection, lgid: i64) -> rusqlite::Result<i64> {
    let real_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let raw: Option<String> = c
        .query_row(
            "SELECT meta_value FROM lg_launched_game_meta
              WHERE launched_game_id = ?1 AND meta_name = 'sim_clock'",
            params![lgid],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(v) = raw.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        if let (Some(ra), Some(va), Some(sp)) = (
            v.get("realAnchor").and_then(|x| x.as_f64()),
            v.get("virtualAnchor").and_then(|x| x.as_f64()),
            v.get("speed").and_then(|x| x.as_f64()),
        ) {
            let eff = v.get("pausedAt").and_then(|x| x.as_f64()).unwrap_or(real_ms as f64);
            return Ok(((va + (eff - ra) * sp) / 1000.0) as i64);
        }
    }
    Ok(real_ms / 1000)
}

/// The territories a Purge may hit, best first: those where the leading clan
/// has validations (`leader_count` > 0), by that count, then pts/min. Within a
/// full tie, a deterministic pick leads (FNV-1a over game id + the tied
/// indexes): stable while the tied set is unchanged, NOT re-rolled per query,
/// so the displayed target is what a purge hits. The rest follow by index.
fn clash_purge_order(territories: &[ClashTerr], lgid: i64, leader_count: impl Fn(i64) -> i64) -> Vec<i64> {
    let key = |t: &ClashTerr| (leader_count(t.index), t.points);
    let mut rest: Vec<&ClashTerr> = territories.iter().filter(|t| leader_count(t.index) > 0).collect();
    let mut order: Vec<i64> = Vec::new();
    while let Some(best) = rest.iter().map(|t| key(t)).max() {
        let mut group: Vec<&ClashTerr> = rest.iter().copied().filter(|t| key(t) == best).collect();
        rest.retain(|t| key(t) != best);
        group.sort_by_key(|t| t.index);
        if group.len() > 1 {
            let mut h: u64 = 0xcbf29ce484222325;
            let mut mix = |x: u64| {
                h = (h ^ x).wrapping_mul(0x100000001b3);
            };
            mix(lgid as u64);
            for t in &group {
                mix(t.index as u64);
            }
            let lead = group.remove((h % group.len() as u64) as usize);
            order.push(lead.index);
        }
        order.extend(group.iter().map(|t| t.index));
    }
    order
}

/// The territory a clan's Purge hits: the first of `order` (clash_purge_order)
/// that the purging clan does not own - never its own territory. Err = the
/// refusal status: "no_target" (nothing to purge) or "own_territory" (every
/// candidate is the purger's own).
fn clash_purge_pick(order: &[i64], owner_of: impl Fn(i64) -> Option<i64>, purger: i64) -> Result<i64, &'static str> {
    if order.is_empty() {
        return Err("no_target");
    }
    order.iter().copied().find(|ti| owner_of(*ti) != Some(purger)).ok_or("own_territory")
}

/// `lg_clash_consumed` marker for a purge punch that was refused but stays
/// pending. Never equal to a real `station@time` key, so it doesn't consume it.
const PURGE_SEEN_PREFIX: &str = "purge_seen:";

/// Whether a purge attempt with this outcome uses up the station punch. Only a
/// fired purge, or a clan whose quota is already spent (can never succeed).
/// "no_target" / "own_territory" keep it pending for a later read.
fn purge_consumes(status: &str) -> bool {
    matches!(status, "ok" | "already_used")
}

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
    let now: i64 = game_now_secs(c, lgid)?;
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

    // ── The Purge: target order + spent quotas ──────────────────────────────
    // The territories a Purge may hit, best first: those where the LEADING
    // clan (unique #1 by exact weighted score) has validations, by its count,
    // then pts/min (see clash_purge_order). The first one is the displayed
    // target. A purging clan never hits a territory it owns: it gets the first
    // one in this order that it does not own (clash_validate). No unique
    // leader, or the leader has zero validations everywhere ⇒ no target.
    // Design: project_clash_purge_feature.
    let purge_order: Vec<i64> = if !cfg.purge_enabled {
        Vec::new()
    } else {
        let best = exact_scores
            .iter()
            .map(|(_, s)| *s)
            .fold(f64::NEG_INFINITY, f64::max);
        let top: Vec<i64> = exact_scores
            .iter()
            .filter(|(_, s)| *s == best)
            .map(|(t, _)| *t)
            .collect();
        if top.len() == 1 {
            let leader = top[0];
            clash_purge_order(&cfg.territories, lgid, |terr| {
                t_counts
                    .get(&terr)
                    .and_then(|m| m.get(&leader))
                    .copied()
                    .unwrap_or(0)
            })
        } else {
            Vec::new()
        }
    };
    let purge_json = json!({
        "enabled": cfg.purge_enabled,
        "station": cfg.purge_station,
        "target_territory_index": purge_order.first(),
        "target_order": purge_order,
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
/// The `punches` array of a Clash request as (station, time) pairs. Accepts
/// `code` (SI read shape) or `station`.
fn parse_clash_punches(body: &Value) -> Vec<(i64, String)> {
    body.get("punches")
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
        .unwrap_or_default()
}

/// Mark every punch already on a card as consumed for this game. Called when a
/// chip self-registers: cards are often not wiped between games, and leftover
/// punches (a station-25 purge punch included) must not count in the new game.
/// Clock-independent - SI station clocks drift by minutes.
fn clash_consume_baseline(
    tx: &rusqlite::Connection,
    launched_game_id: i64,
    chip_id: i64,
    punches: &[(i64, String)],
) -> rusqlite::Result<()> {
    for (station, time) in punches {
        tx.execute(
            "INSERT OR IGNORE INTO lg_clash_consumed
               (launched_game_id, chip_id, punch_key) VALUES (?, ?, ?)",
            params![launched_game_id, chip_id, format!("{station}@{time}")],
        )?;
    }
    Ok(())
}

async fn clash_register(state: &AppState, body: Value) -> Result<Value, ApiErr> {
    let launched_game_id = json_i64(&body, "launched_game_id")?;
    let team_id = json_i64(&body, "team_id")?;
    let chip_id = json_i64(&body, "chip_id")?;
    // Only the Clash station's self-registration bip sends these (the card's
    // current punches); operator/TagQuest/predetermined bindings send none.
    let punches = parse_clash_punches(&body);
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
                    // Same clan re-bipped at the inscription screen: anything on
                    // the card by now is still pre-game.
                    clash_consume_baseline(&tx, launched_game_id, chip_id, &punches)?;
                    tx.commit()?;
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
            clash_consume_baseline(&tx, launched_game_id, chip_id, &punches)?;
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
    let punches = parse_clash_punches(&body);
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
            // complete a territory, and a refused one stays pending (see the
            // Purge block below).
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
            // Quota = one SUCCESS per clan. A punch refused for "no_target" /
            // "own_territory" stays PENDING: it is retried on every later read
            // of this card and fires once a purge is possible (bug report #3:
            // a punch burned on a 0-0 start made the purge unreachable). Only
            // success or "already_used" (can never succeed) consume it. A
            // "purge_seen:" marker row tells the station whether the refusal is
            // new (show it) or a repeat (stay quiet). Multiple purge punches in
            // one read = one attempt. Design: project_clash_purge_feature.
            let mut purge_json: Option<Value> = None;
            if !purge_keys.is_empty() {
                let repeat = purge_keys
                    .iter()
                    .all(|k| consumed.contains(&format!("{PURGE_SEEN_PREFIX}{k}")));
                let already_used: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM lg_clash_purges
                                   WHERE launched_game_id = ? AND team_id = ?)",
                    params![launched_game_id, team_id],
                    |r| r.get(0),
                )?;
                if already_used {
                    // Never "repeat": a pending punch whose clan has since
                    // purged (via a clanmate) gets told why it is now spent.
                    purge_json = Some(json!({ "attempted": true, "status": "already_used" }));
                } else {
                    // Target as of this instant (pre-purge state): the first
                    // territory of the order that this clan does not own. Only
                    // its own territories left ⇒ refused, quota not spent.
                    let pre = compute_clash_standings(&tx, launched_game_id, &cfg, false)?;
                    let order: Vec<i64> = pre
                        .get("purge")
                        .and_then(|p| p.get("target_order"))
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                        .unwrap_or_default();
                    let owner_of = |ti: i64| -> Option<i64> {
                        pre.get("territories")
                            .and_then(|v| v.as_array())
                            .and_then(|arr| arr.iter().find(|t| t.get("index").and_then(|x| x.as_i64()) == Some(ti)))
                            .and_then(|t| t.get("owner_team_id"))
                            .and_then(|v| v.as_i64())
                    };
                    match clash_purge_pick(&order, owner_of, team_id) {
                        Err(status) => {
                            purge_json = Some(json!({
                                "attempted": true,
                                "status": status,
                                "repeat": repeat,
                            }));
                        }
                        Ok(ti) => {
                            seq += 1;
                            tx.execute(
                                "INSERT INTO lg_clash_purges
                                   (launched_game_id, team_id, chip_id, territory_index, seq, created_at)
                                 VALUES (?, ?, ?, ?, ?, datetime(?, 'unixepoch'))",
                                params![
                                    launched_game_id,
                                    team_id,
                                    chip_id,
                                    ti,
                                    seq,
                                    game_now_secs(&tx, launched_game_id)?
                                ],
                            )?;
                            purge_json = Some(json!({
                                "attempted": true,
                                "status": "ok",
                                "territory_index": ti,
                            }));
                        }
                    }
                }
                let status = purge_json
                    .as_ref()
                    .and_then(|p| p.get("status"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                for key in &purge_keys {
                    let row = if purge_consumes(status) {
                        key.clone()
                    } else {
                        format!("{PURGE_SEEN_PREFIX}{key}")
                    };
                    tx.execute(
                        "INSERT OR IGNORE INTO lg_clash_consumed
                           (launched_game_id, chip_id, punch_key) VALUES (?, ?, ?)",
                        params![launched_game_id, chip_id, row],
                    )?;
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
                       (launched_game_id, team_id, chip_id, combo_index, territory_index, seq, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'))",
                    params![
                        launched_game_id,
                        team_id,
                        chip_id,
                        t.index,
                        t.index,
                        seq,
                        game_now_secs(&tx, launched_game_id)?
                    ],
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

            // Nothing credited: name the territory the read got CLOSEST to, so
            // the station can say "<name> incomplet" instead of a generic
            // "keep going". Best partial = most balises present (ties → higher
            // points → lowest index). No territory with a single fresh punch ⇒
            // no partial (every punch on the card was already consumed, or the
            // fresh ones belong to no territory) - the station falls back to
            // the generic line, which is itself the diagnostic.
            let mut partial_json: Option<Value> = None;
            if credited.is_empty() {
                let scored = cfg
                    .territories
                    .iter()
                    .filter(|t| !t.balises.is_empty())
                    .map(|t| {
                        let have = t
                            .balises
                            .iter()
                            .filter(|s| by_station.get(s).is_some_and(|v| !v.is_empty()))
                            .count() as i64;
                        (t, have)
                    })
                    .filter(|(_, have)| *have > 0)
                    .max_by(|(a, ha), (b, hb)| {
                        ha.cmp(hb)
                            .then(a.points.cmp(&b.points))
                            .then(b.index.cmp(&a.index))
                    });
                if let Some((t, have)) = scored {
                    // Name the balises still missing, in the numbers printed on
                    // them: "incomplete" alone told a team nothing about what to
                    // go and punch (retours #96).
                    let missing: Vec<i64> = t
                        .balises
                        .iter()
                        .enumerate()
                        .filter(|(_, s)| by_station.get(s).map_or(true, |v| v.is_empty()))
                        .map(|(k, _)| t.balise_label(k))
                        .collect();
                    partial_json = Some(json!({
                        "territory_index": t.index,
                        "have": have,
                        "need": t.balises.len() as i64,
                        "missing": missing,
                    }));
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
            if let Some(p) = partial_json {
                resp.as_object_mut()
                    .expect("resp is an object")
                    .insert("partial".into(), p);
            }
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

/// Unauthenticated identity probe (pairing by address, reachability test).
/// Returns the same identity fields the mDNS TXT record carries so a child can
/// build a DiscoveredMother without multicast, plus our LAN protocol/app version
/// so an outdated peer can be told which side to update. Epoch is computed live (MAX over this
/// client's active games, mirroring the value advertised at server start).
async fn pair_hello_handler(state: &AppState) -> Result<Value, ApiErr> {
    let client_id = state.client_id;
    let self_peer_id = state.self_peer_id;
    // `running_games`: unfinished games whose clock has not run out - what the
    // returning mother asks before taking the hosting back from a substitute.
    // The mDNS TXT can't say: it is not refreshed when a game ends. A game
    // forgotten since yesterday (still `ended = 0` until the 24 h sweep) is not
    // "running".
    let (epoch, running_games, label): (i64, i64, Option<String>) = state
        .db
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(i64, i64, Option<String>)> {
            let epoch: i64 = c.query_row(
                "SELECT COALESCE(MAX(mother_epoch), 1)
                 FROM lg_launched_games WHERE client_id = ? AND ended = 0",
                params![client_id],
                |r| r.get(0),
            )?;
            let running: i64 = c.query_row(
                "SELECT COUNT(*) FROM lg_launched_games
                  WHERE client_id = ? AND ended = 0
                    AND COALESCE(start_time, created_at) > datetime('now','-24 hours')
                    AND (start_time IS NULL OR duration <= 0
                         OR datetime(start_time, '+' || duration || ' minutes') > datetime('now'))",
                params![client_id],
                |r| r.get(0),
            )?;
            let label: Option<String> = c
                .query_row(
                    "SELECT peer_label FROM paired_devices WHERE id = ?",
                    params![self_peer_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok((epoch, running, label.filter(|l| l != SELF_PLACEHOLDER_LABEL)))
        })
        .await
        .unwrap_or((1, 0, None));
    Ok(json!({
        "status": "ok",
        "mother_uuid": state.mother_uuid,
        "client_id": client_id,
        "epoch": epoch,
        "role": state.role.code(),
        "since": state.since,
        "running_games": running_games,
        "label": label,
        "lan_proto": LAN_PROTO,
        "app_version": crate::app_version(),
    }))
}

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
    // Mother role rework (E1 auto-pair): a joiner proves same-client
    // membership by sending its client_id. The trust boundary is the LAN itself
    // (the venue network), so a device that's reachable AND claims
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

    // Sticky removal (retours sept. #8): a device the operator removed is not
    // auto-approved again. Only a pairing started by hand from that device
    // (`manual: true`) lifts it. Tolerates a DB without migration 34.
    let manual = body.get("manual").and_then(|v| v.as_bool()).unwrap_or(false);
    let revoked: bool = state
        .db
        .call({
            let peer_uuid = peer_uuid.clone();
            move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<bool> {
                if manual {
                    let _ = c.execute("DELETE FROM revoked_devices WHERE peer_uuid = ?", params![peer_uuid]);
                    return Ok(false);
                }
                Ok(c
                    .query_row("SELECT 1 FROM revoked_devices WHERE peer_uuid = ?", params![peer_uuid], |_| Ok(true))
                    .optional()
                    .ok()
                    .flatten()
                    .unwrap_or(false))
            }
        })
        .await?;
    if revoked {
        return Ok(json!({
            "status": "denied",
            "message": "This device was removed from the mother. Join again by hand from this device to re-pair it."
        }));
    }

    // Auto-pair fast path: trusted same-client joiner. Create the paired_devices
    // row now and hand the secret back immediately (no pair_requests row, no
    // polling - the joiner reads "approved" straight from this response).
    if peer_client_id == Some(state.client_id) {
        let proposed_secret = random_token(32);
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
    // Cross-client (or no-client_id) requests used to file a pair_requests row
    // the mother's operator approved from a 4s-polled list while the child
    // polled a 120s status loop. That ceremony is retired: it bought no
    // security (any LAN host claiming the client_id was auto-approved above,
    // bypassing it) and no durable control (a revoked same-client child
    // silently re-pairs via the 401-reauth path). Tablets from another client
    // have no business pairing here - moving a device between clients is a
    // studio operation. Flat deny, with a message the joining UI can show.
    // (The pair_requests table remains in the schema but is no longer written;
    // the child-side 'pending' polling in client_pair_with_mother stays for
    // compatibility with OLD mothers that still issue it.)
    Ok(json!({
        "status": "denied",
        "message": "This device belongs to a different client. Reassign it in the studio, then pair again."
    }))
}

// ─── tauri commands: pair management on mother ───────────────────────────────

pub(crate) async fn open_db_for_command(app: &AppHandle) -> Result<DbConnection, String> {
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

// The mother_list_pending_pair_requests / mother_approve_pair_request /
// mother_deny_pair_request commands were retired with the manual-approval
// ceremony (pair_request_handler now flat-denies cross-client joins; the
// pair_requests table survives in the schema but is never written).

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
        let tx = c.transaction()?;
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT peer_uuid, peer_label FROM paired_devices WHERE id = ? AND is_self = 0",
                params![peer_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((peer_uuid, peer_label)) = row else {
            return Err(tokio_rusqlite::Error::Other(
                format!("no non-self paired_devices row id={peer_id}").into(),
            ));
        };
        tx.execute("DELETE FROM paired_devices WHERE id = ?", params![peer_id])?;
        // Sticky removal (retours sept. #8): remember it, so the same-client
        // auto-approve can't silently re-pair the device at its next ping.
        // Tolerates a DB whose migration 34 hasn't run yet.
        let _ = tx.execute(
            "INSERT INTO revoked_devices (peer_uuid, peer_label) VALUES (?1, ?2)
             ON CONFLICT(peer_uuid) DO UPDATE SET revoked_at = CURRENT_TIMESTAMP, peer_label = excluded.peer_label",
            params![peer_uuid, peer_label],
        );
        // Let satellites' cached snapshots (and a future promoted mother) see
        // the new pairing table without waiting for the next game action.
        tx.execute(
            "INSERT INTO schema_meta(key, value) VALUES('lg_state_version', '1')
             ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
            [],
        )?;
        tx.commit()?;
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
               mother_label = COALESCE(excluded.mother_label, paired_mothers.mother_label),
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

/// After a verified switch to `keep_uuid` (failover re-point, yield), drop the
/// other paired mothers not heard from for `stale_minutes`. A satellite has ONE
/// mother: the leftovers were shown as extra "connected" mothers (retours sept.
/// #7) and, while their endpoint stayed warm, the 15 s route tick could drag the
/// games route back to the old machine (#18). Recently seen rows are kept - a
/// planned handover may still be settling. Returns how many rows were removed.
#[tauri::command]
pub async fn client_prune_paired_mothers(
    app: AppHandle,
    cache: tauri::State<'_, MotherEndpointCache>,
    keep_uuid: String,
    stale_minutes: i64,
) -> Result<Vec<String>, String> {
    let conn = open_db_for_command(&app).await?;
    let window = format!("-{} minutes", stale_minutes.max(0));
    let removed: Vec<String> = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<String>> {
            let tx = c.transaction()?;
            let uuids: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT mother_uuid FROM paired_mothers
                      WHERE mother_uuid <> ?1
                        AND (last_seen_at IS NULL OR last_seen_at < datetime('now', ?2))",
                )?;
                let rows = stmt.query_map(params![keep_uuid, window], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for u in &uuids {
                tx.execute("DELETE FROM paired_mothers WHERE mother_uuid = ?", params![u])?;
            }
            tx.commit()?;
            Ok(uuids)
        })
        .await
        .map_err(|e| e.to_string())?;
    if !removed.is_empty() {
        let mut guard = cache.inner.lock().await;
        for u in &removed {
            guard.remove(u);
        }
    }
    Ok(removed)
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
    /// The mother speaks another LAN protocol: one of the two PCs must be
    /// updated. `theirs` < LAN_PROTO means the MOTHER is outdated.
    ProtoMismatch { theirs: u32, their_app_version: Option<String> },
}

/// Do these two IPv4 addresses sit on the same /24? The one test that decides
/// "can I actually reach this host": a mother straddling the venue AP and an
/// office LAN advertises an address on each, and only the one sharing a subnet
/// with us is routable. Shared by `select_address` (endpoint cache) and
/// `order_pair_candidates` (probe/pair) so the two can never disagree about
/// which address is the good one.
fn shares_24(a: Ipv4Addr, b: Ipv4Addr) -> bool {
    let (ao, bo) = (a.octets(), b.octets());
    ao[0] == bo[0] && ao[1] == bo[1] && ao[2] == bo[2]
}

// Order a mother's advertised addresses best-first for a reachable connection:
// same-/24-as-us first, then other routable private IPv4, link-local (169.254)
// last, IPv6 skipped (fe80:: needs a zone id we don't have). Mirrors the JS
// heuristic but runs in Rust.
fn order_pair_candidates(addresses: &[String]) -> Vec<String> {
    let v4 = |a: &String| a.parse::<Ipv4Addr>().ok();
    let locals = local_ipv4s();
    let near = |a: &String| match v4(a) {
        Some(ip) => locals.iter().any(|l| shares_24(*l, ip)),
        None => false,
    };
    let routable = |a: &String| {
        v4(a).is_some() && !a.starts_with("127.") && !a.starts_with("169.254.")
    };
    // Three passes rather than a sort_by_key: the relative order WITHIN each
    // bucket is the mother's own advertisement order, which we keep.
    let mut out: Vec<String> = addresses.iter().filter(|a| routable(a) && near(a)).cloned().collect();
    out.extend(addresses.iter().filter(|a| routable(a) && !near(a)).cloned());
    out.extend(
        addresses
            .iter()
            .filter(|a| v4(a).is_some() && a.starts_with("169.254."))
            .cloned(),
    );
    out
}

/// Run the full pair handshake against a discovered mother FROM RUST (reqwest),
/// so it is not subject to the webview's `http:` capability scope - a router
/// hands out arbitrary LAN IPs that are painful to allowlist. Tries each candidate address until one connects, POSTs the
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
    // Mother role rework: our own client_id, sent so a same-client mother
    // can auto-approve us on the LAN (E1) without an operator tap. None when the
    // caller doesn't know it (falls back to manual approval).
    client_id: Option<i64>,
    timeout_ms: Option<u64>,
    // True when the operator started this pairing by hand ("Join" button): it
    // lifts a sticky removal on the mother. Automatic re-pairs pass None/false.
    manual: Option<bool>,
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

    let client = lan_client_builder()
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
        "manual": manual.unwrap_or(false),
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
                let refused_proto = resp.status() == reqwest::StatusCode::UPGRADE_REQUIRED;
                let body: serde_json::Value = match resp.json().await {
                    Ok(v) => v,
                    Err(e) => { last_err = e.to_string(); continue; }
                };
                // A newer mother refused us (426), or an older one answered
                // without announcing LAN_PROTO: never pair across protocols.
                let theirs = if refused_proto {
                    body.get("lan_proto").and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(LAN_PROTO + 1)
                } else {
                    announced_proto(&body)
                };
                if theirs != LAN_PROTO {
                    return Ok(JoinOutcome::ProtoMismatch {
                        theirs,
                        their_app_version: vstr(&body, "app_version"),
                    });
                }
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
                                       mother_label = COALESCE(excluded.mother_label, paired_mothers.mother_label),
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
                                       mother_label = COALESCE(excluded.mother_label, paired_mothers.mother_label),
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

/// Unauthenticated `pair.php?action=hello` at one socket address; the parsed
/// reply when a mother answers.
async fn hello_at(sock: SocketAddr) -> Option<Value> {
    let client = lan_client_builder()
        .timeout(Duration::from_millis(1500))
        .connect_timeout(Duration::from_millis(800))
        .build()
        .ok()?;
    let resp = client
        .get(format!("http://{sock}/pair.php?action=hello"))
        .send()
        .await
        .ok()?;
    let body: Value = resp.json().await.ok()?;
    body.get("mother_uuid").and_then(|v| v.as_str()).filter(|u| !u.is_empty())?;
    Some(body)
}

/// Pair with a mother by its typed IP - the fallback when the router or venue
/// network filters mDNS multicast. `address` is "a.b.c.d" (the PREFERRED_PORTS
/// are probed in order) or "a.b.c.d:port". On success the address is stored in
/// `paired_mothers.manual_addr` so later reconnects work without mDNS.
#[tauri::command]
pub async fn client_pair_by_address(
    app: AppHandle,
    cache: tauri::State<'_, MotherEndpointCache>,
    address: String,
    peer_label: String,
    peer_os: Option<String>,
    peer_app_version: Option<String>,
    client_id: Option<i64>,
) -> Result<JoinOutcome, String> {
    let address = address.trim();
    let candidates: Vec<SocketAddr> = if let Ok(sock) = address.parse::<SocketAddr>() {
        vec![sock]
    } else if let Ok(ip) = address.parse::<Ipv4Addr>() {
        PREFERRED_PORTS.iter().map(|p| SocketAddr::new(ip.into(), *p)).collect()
    } else {
        return Ok(JoinOutcome::Unreachable {
            message: format!("invalid IPv4 address: {address}"),
        });
    };
    let mut found: Option<(SocketAddr, Value)> = None;
    for sock in candidates {
        if let Some(hello) = hello_at(sock).await {
            found = Some((sock, hello));
            break;
        }
    }
    let Some((sock, hello)) = found else {
        return Ok(JoinOutcome::Unreachable {
            message: format!("no Tag Hunter mother answered at {address}"),
        });
    };
    let theirs = announced_proto(&hello);
    if theirs != LAN_PROTO {
        return Ok(JoinOutcome::ProtoMismatch {
            theirs,
            their_app_version: vstr(&hello, "app_version"),
        });
    }
    let mother_uuid = vstr(&hello, "mother_uuid").unwrap_or_default();
    let outcome = client_pair_with_mother(
        app.clone(),
        cache,
        mother_uuid.clone(),
        None,
        vec![sock.ip().to_string()],
        sock.port(),
        peer_label,
        peer_os,
        peer_app_version,
        client_id,
        None,
        Some(true),
    )
    .await?;
    if matches!(outcome, JoinOutcome::Approved | JoinOutcome::AlreadyPaired) {
        let conn = open_db_for_command(&app).await?;
        let addr = sock.to_string();
        conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
            c.execute(
                "UPDATE paired_mothers SET manual_addr = ? WHERE mother_uuid = ?",
                params![addr, mother_uuid],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(outcome)
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
    /// `lp` TXT key; 1 for a hotspot-era mother that doesn't advertise it. The
    /// renderer never auto-joins a mother on another protocol and labels it
    /// "to update" in the discovery list.
    pub lan_proto: u32,
    /// `role` TXT key: "m" = the device set as the mother, "s" = a substitute
    /// (see `HostRole`). None for a build that predates roles.
    pub role: Option<String>,
    /// `since` TXT key: when that mother was designated (ms), 0 if unknown.
    pub since: Option<i64>,
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
    role: HostRole,
    since: i64,
) -> Result<MdnsHandle, String> {
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;

    // This host's interface IPv4s, filtered by `designated_lan_addrs`. We
    // deliberately do NOT call `enable_addr_auto()`: it re-adds ALL interfaces
    // (loopback, link-local, virtual adapters) at register time.
    let advertised = current_designated_addrs();
    if advertised.is_empty() {
        // No LAN address yet (Wi-Fi not joined). Inert handle: empty full_name ->
        // unregister/shutdown are safe no-ops; `mother_ensure_mdns_live`
        // re-registers once an address exists.
        return Ok(MdnsHandle {
            daemon,
            full_name: String::new(),
            advertised: Vec::new(),
        });
    }

    let host = format!("{}.local.", mother_uuid);
    let instance = format!("taghunter-{}", &mother_uuid[..8]);
    let mut props: HashMap<String, String> = HashMap::new();
    props.insert("uuid".into(), mother_uuid.to_string());
    props.insert("client_id".into(), client_id.to_string());
    props.insert("epoch".into(), epoch.to_string());
    props.insert("lp".into(), LAN_PROTO.to_string());
    props.insert("role".into(), role.code().to_string());
    props.insert("since".into(), since.to_string());
    // Never advertise without a name: satellites fall back to the uuid prefix
    // ("3ea399e5"), which nobody on the field can map to a PC (retours sept. #7).
    // Promotion paths used to pass no label at all.
    let fallback_label = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty());
    if let Some(l) = label.filter(|l| !l.trim().is_empty()).map(str::to_string).or(fallback_label) {
        props.insert("label".into(), l);
    }
    let ip_arg = advertised.join(",");
    let svc = ServiceInfo::new(
        MDNS_SERVICE_TYPE,
        &instance,
        &host,
        ip_arg.as_str(),
        port,
        props,
    )
    .map_err(|e| e.to_string())?;
    let full_name = svc.get_fullname().to_string();
    daemon.register(svc).map_err(|e| e.to_string())?;
    Ok(MdnsHandle { daemon, full_name, advertised })
}

/// The addresses a mother on this host should advertise right now (sorted,
/// deduped - the same order `start_mdns` stores in `MdnsHandle::advertised`).
fn current_designated_addrs() -> Vec<String> {
    let mut candidates: Vec<String> = local_ipv4s().iter().map(|i| i.to_string()).collect();
    candidates.sort();
    candidates.dedup();
    designated_lan_addrs(&candidates)
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
                let lan_proto = props
                    .get_property_val_str("lp")
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(1);
                let role = props.get_property_val_str("role").map(|s| s.to_string());
                let since = props
                    .get_property_val_str("since")
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
                        lan_proto,
                        role,
                        since,
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

/// Result of a manual reachability probe (Step 3 of the hand-driven connect
/// flow). `ok` distinguishes "discoverable" (mDNS answered in Step 2) from
/// "reachable" (the TCP connect actually completed) - the exact split that tells
/// a MOTHER firewall block apart from a wrong-subnet child.
#[derive(Serialize, Default)]
pub struct MotherProbe {
    /// true = at least one advertised address answered the hello.
    pub ok: bool,
    /// The address (host:port) that answered, when ok.
    pub reached_addr: Option<String>,
    /// The mother's uuid from the hello body, when ok.
    pub mother_uuid: Option<String>,
    /// The mother's client_id from the hello body, when ok.
    pub client_id: Option<i64>,
    /// Round-trip of the successful probe in milliseconds, when ok.
    pub latency_ms: Option<u64>,
    /// Per-address failure detail (technical, "addr:port : real OS error"), for
    /// when nothing answered. The frontend shows this verbatim under the headline.
    pub errors: Vec<String>,
    /// Coarse cause of the failure, chosen from the REAL OS error (not a guess):
    /// "refused" (RST / errno 10061 - port closed / server not listening on that
    /// address), "timeout" (drop / errno 10060 - firewall silently blocking),
    /// "unreachable" (no route / net-unreachable), "http" (answered but not a
    /// mother), or "other". None when ok. Drives which headline the child shows.
    pub category: Option<String>,
    /// From the hello body, when ok: the mother's device name, why it hosts
    /// ("m" / "s", None for an older build), when it was designated, and how
    /// many games are running on it right now (see `pair_hello_handler`).
    pub label: Option<String>,
    pub role: Option<String>,
    pub since: Option<i64>,
    pub running_games: Option<i64>,
}

/// Walk a reqwest error's whole `source()` chain into one string, so the REAL
/// OS error ("Connection refused (os error 10061)", "(os error 10060)", …) is
/// visible instead of reqwest's generic "error sending request" wrapper.
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    use std::error::Error as _; // bring `.source()` into scope for method resolution
    let mut chain: Vec<String> = vec![e.to_string()];
    let mut src: Option<&(dyn std::error::Error + 'static)> = e.source();
    while let Some(s) = src {
        let msg = s.to_string();
        if chain.last().map(|l| l != &msg).unwrap_or(true) {
            chain.push(msg);
        }
        src = s.source();
    }
    chain.join(" → ")
}

/// Classify a connect failure from its real text + reqwest's own flags. RST
/// (refused) and DROP (timeout) look identical in the UI otherwise but need
/// opposite fixes (restart the mother's server vs allow the firewall).
fn classify_probe_error(e: &reqwest::Error, described: &str) -> &'static str {
    let low = described.to_lowercase();
    if low.contains("10061") || low.contains("refused") || low.contains("reset") || low.contains("10054") {
        "refused"
    } else if e.is_timeout()
        || low.contains("10060")
        || low.contains("timed out")
        || low.contains("timeout")
        || low.contains("deadline")
        || low.contains("elapsed")
    {
        "timeout"
    } else if low.contains("10065") || low.contains("10051") || low.contains("no route") || low.contains("unreachable") {
        "unreachable"
    } else {
        "other"
    }
}

/// UNAUTHENTICATED reachability test against a discovered mother's advertised
/// addresses: `GET /pair.php?action=hello` on each candidate until one answers.
/// Confirms the actual TCP path is open (the half mDNS discovery can't prove) so
/// a child can tell a firewall block from a routing problem BEFORE pairing.
/// Never mutates state; safe to run repeatedly.
#[tauri::command]
pub async fn client_probe_mother(
    addresses: Vec<String>,
    port: u16,
) -> Result<MotherProbe, String> {
    let candidates = order_pair_candidates(&addresses);
    if candidates.is_empty() {
        return Ok(MotherProbe {
            ok: false,
            reached_addr: None,
            mother_uuid: None,
            client_id: None,
            latency_ms: None,
            errors: vec!["mother advertised no usable IPv4 address".into()],
            category: Some("other".into()),
            ..Default::default()
        });
    }
    // Generous timeouts: a working-but-slow path (busy ICS host, first connect)
    // must not be cut off and mislabeled as a firewall block.
    let client = lan_client_builder()
        .timeout(Duration::from_millis(4000))
        .connect_timeout(Duration::from_millis(3000))
        .build()
        .map_err(|e| e.to_string())?;

    let mut errors: Vec<String> = Vec::new();
    // Rank the categories seen so the headline reflects the most specific cause
    // ("refused" is more actionable than a bare "timeout").
    let rank = |c: &str| match c { "refused" => 3, "unreachable" => 2, "timeout" => 1, _ => 0 };
    let mut best_cat: &'static str = "other";
    for addr in candidates {
        let target = format!("{addr}:{port}");
        let url = format!("http://{target}/pair.php?action=hello");
        let started = std::time::Instant::now();
        match client.get(&url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    errors.push(format!("{target} : HTTP {}", status.as_u16()));
                    if rank("http") >= rank(best_cat) { best_cat = "http"; }
                    continue;
                }
                match resp.json::<Value>().await {
                    Ok(body) => {
                        let uuid = body.get("mother_uuid").and_then(|v| v.as_str()).unwrap_or("");
                        if uuid.is_empty() {
                            errors.push(format!("{target} : unexpected response (not a mother)"));
                            if rank("http") >= rank(best_cat) { best_cat = "http"; }
                            continue;
                        }
                        return Ok(MotherProbe {
                            ok: true,
                            reached_addr: Some(target),
                            mother_uuid: Some(uuid.to_string()),
                            client_id: body.get("client_id").and_then(|v| v.as_i64()),
                            latency_ms: Some(started.elapsed().as_millis() as u64),
                            errors: Vec::new(),
                            category: None,
                            label: vstr(&body, "label"),
                            role: vstr(&body, "role"),
                            since: vi64(&body, "since"),
                            running_games: vi64(&body, "running_games"),
                        });
                    }
                    Err(e) => {
                        errors.push(format!("{target} : unreadable response ({e})"));
                        if rank("http") >= rank(best_cat) { best_cat = "http"; }
                    }
                }
            }
            Err(e) => {
                let desc = describe_reqwest_error(&e);
                let cat = classify_probe_error(&e, &desc);
                errors.push(format!("{target} : {desc}"));
                if rank(cat) >= rank(best_cat) { best_cat = cat; }
            }
        }
    }
    Ok(MotherProbe {
        ok: false,
        reached_addr: None,
        mother_uuid: None,
        client_id: None,
        latency_ms: None,
        errors,
        category: Some(best_cat.to_string()),
        ..Default::default()
    })
}

/// Verdict on one candidate mother, for the satellite's failover re-point.
#[derive(Serialize)]
pub struct CandidateCheck {
    /// The hello answered on one of the advertised addresses.
    pub ok: bool,
    /// `http://ip:port` built from the address that ANSWERED - install this
    /// verbatim as the LAN override; never rebuild it from the mDNS record.
    pub base_url: Option<String>,
    pub mother_uuid: Option<String>,
    pub client_id: Option<i64>,
    /// The candidate serves the requested game AND honoured our token. False
    /// when the ping was refused, unauthorized, or answered `snapshot: null`.
    pub serves_game: bool,
    /// Epoch/version of the snapshot it answered with, when `serves_game`.
    pub mother_epoch: Option<i64>,
    pub state_version: Option<i64>,
    /// Why the game check failed, for the console trail: "no_game_id",
    /// "no_secret", "not_served", or the transport/HTTP error text.
    pub detail: Option<String>,
}

/// Positive validation of a candidate mother before re-pointing at it
/// (Ludiom #74).
///
/// The old rule was "advertises a strictly higher epoch than the snapshot we
/// cached". That is inference, and it broke in the field: a satellite whose
/// cached snapshot came from an unrelated older game carried an epoch the
/// promoted mother could never beat, so the only correct candidate was rejected
/// for ever, silently. This asks the candidate directly instead - hello probe
/// (which also yields the address that actually answered), then ONE
/// authenticated snapshot request for our game. Reachable, honours our token,
/// and serves this very game: three facts, one round trip, no guessing.
///
/// Also warms `mother_snapshots` on success, so the re-point leaves the device
/// with a current snapshot instead of the dead mother's.
#[tauri::command]
pub async fn client_verify_mother_candidate(
    app: AppHandle,
    addresses: Vec<String>,
    port: u16,
    launched_game_id: Option<i64>,
    token: Option<String>,
) -> Result<CandidateCheck, String> {
    let probe = client_probe_mother(addresses, port).await?;
    let (Some(reached), true) = (probe.reached_addr.clone(), probe.ok) else {
        return Ok(CandidateCheck {
            ok: false,
            base_url: None,
            mother_uuid: probe.mother_uuid,
            client_id: probe.client_id,
            serves_game: false,
            mother_epoch: None,
            state_version: None,
            detail: Some(probe.errors.join(" | ")),
        });
    };
    let mut out = CandidateCheck {
        ok: true,
        base_url: Some(format!("http://{reached}")),
        mother_uuid: probe.mother_uuid,
        client_id: probe.client_id,
        serves_game: false,
        mother_epoch: None,
        state_version: None,
        detail: None,
    };

    let Some(gid) = launched_game_id else {
        out.detail = Some("no_game_id".into());
        return Ok(out);
    };
    let conn = open_db_for_command(&app).await?;
    // The caller's bearer first (the override token a satellite already holds -
    // the promoted mother adopted the row it belongs to), then whatever this
    // device would use outbound. A former mother has only the latter.
    let mut secrets: Vec<String> = Vec::new();
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        secrets.push(t);
    }
    for s in outbound_secrets(&conn).await {
        if !secrets.contains(&s) {
            secrets.push(s);
        }
    }
    if secrets.is_empty() {
        out.detail = Some("no_secret".into());
        return Ok(out);
    }

    for secret in secrets {
        match pull_snapshot_over_http(&reached, &secret, gid).await {
            Ok(Some(snap)) => {
                let ver = snap.get("state_version").and_then(|v| v.as_i64());
                let epoch = snap.get("mother_epoch").and_then(|v| v.as_i64());
                out.serves_game = true;
                out.state_version = ver;
                out.mother_epoch = epoch;
                if let (Some(v), Some(e)) = (ver, epoch) {
                    let _ = upsert_cached_snapshot(&conn, gid, v, e, snap.to_string()).await;
                }
                return Ok(out);
            }
            // Answered and authenticated, but doesn't host this game: a
            // definitive NO, so don't burn the second secret on it.
            Ok(None) => {
                out.detail = Some("not_served".into());
                return Ok(out);
            }
            Err(e) => out.detail = Some(e),
        }
    }
    Ok(out)
}

/// This device's non-loopback IPv4 addresses (no side effects). The mother's
/// Network card shows them so a satellite can pair by typing one.
#[tauri::command]
pub async fn get_local_ipv4s() -> Result<Vec<String>, String> {
    Ok(local_ipv4s().iter().map(|i| i.to_string()).collect())
}

// Run a PowerShell script ELEVATED via a single UAC prompt, returning its exit
// code. Writes the script to a temp .ps1 (no command-line quoting to get wrong)
// and launches it with `Start-Process -Verb RunAs`. Used by the firewall rule
// and the Windows-health fixes, which need admin.
#[cfg(target_os = "windows")]
pub(crate) fn run_elevated_powershell(script: &str) -> Result<i32, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut path = std::env::temp_dir();
    path.push(format!("taghunter_net_{}.ps1", std::process::id()));
    std::fs::write(&path, script).map_err(|e| format!("write script: {e}"))?;
    let ps_path = path.to_string_lossy().replace('\'', "''");
    let outer = format!(
        "try {{ $p = Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{ps_path}'; exit $p.ExitCode }} catch {{ exit 1 }}"
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &outer])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    let _ = std::fs::remove_file(&path);
    match status {
        Ok(s) => Ok(s.code().unwrap_or(-1)),
        Err(e) => Err(format!("spawn powershell: {e}")),
    }
}

#[derive(Serialize)]
pub struct LanDiag {
    /// This device's mother server is running (it IS a mother right now).
    server_running: bool,
    port: u16,
    /// The mDNS announcement's full name. EMPTY = the announcement is INERT
    /// (advertising no reachable address - the #1 reason a child can't discover
    /// this mother). Populated only once the designated-LAN address is up.
    mdns_full_name: String,
    /// Every non-loopback IPv4 on this host right now.
    local_ipv4s: Vec<String>,
    /// The subset of local_ipv4s the mother WOULD advertise
    /// (`designated_lan_addrs`). EMPTY here while server_running is true is the
    /// smoking gun: the PC has no LAN address, so the mother advertises nothing
    /// and is undiscoverable.
    designated_addrs: Vec<String>,
    /// Raw mDNS browse result from THIS device (what a child would see). On a
    /// child this reveals whether the mother is discovered at all + its addresses.
    discovered: Vec<DiscoveredMother>,
    /// Live firewall verification: Some(true) rule present, Some(false)
    /// DEFINITIVELY absent (the "discoverable but unreachable" smoking gun -
    /// use the repair button), None = could not check.
    firewall_rule_ok: Option<bool>,
}

/// One-shot LAN diagnostics for the Network tab - surfaces exactly why discovery
/// might fail (inert mDNS / empty designated addrs / what the browse returns)
/// without needing device logs.
#[tauri::command]
pub async fn lan_diag(
    state: tauri::State<'_, MotherServerState>,
) -> Result<LanDiag, String> {
    let local_ipv4s: Vec<String> = local_ipv4s().iter().map(|i| i.to_string()).collect();
    let designated_addrs = designated_lan_addrs(&local_ipv4s);
    let (server_running, port, mdns_full_name) = {
        let guard = state.inner.lock().await;
        match &*guard {
            Some(r) => (
                true,
                r.port,
                r.mdns.as_ref().map(|m| m.full_name.clone()).unwrap_or_default(),
            ),
            None => (false, 0, String::new()),
        }
    };
    let discovered = run_mdns_discovery(Duration::from_millis(2500))
        .await
        .unwrap_or_default();
    let firewall_rule_ok = tokio::task::spawn_blocking(firewall_rule_status_sync)
        .await
        .unwrap_or(None);
    Ok(LanDiag {
        server_running,
        port,
        mdns_full_name,
        local_ipv4s,
        designated_addrs,
        discovered,
        firewall_rule_ok,
    })
}

// This device's own non-loopback IPv4s (one per connected interface). Used to
// pick a mother address we can actually route to.
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

/// The IPv4s a mother advertises: its routable LAN addresses (router / venue
/// network / Ethernet), minus APIPA/link-local (169.254.*, a sign the interface
/// has no DHCP lease - never reachable across the LAN) and loopback. The old
/// Windows-ICS hotspot subnet (192.168.137.*) is dropped too: a PC still carrying
/// it is on a leftover hotspot from a pre-router build, not on the shared LAN.
fn designated_lan_addrs(candidates: &[String]) -> Vec<String> {
    let is_ics = |a: &str| a.starts_with("192.168.137.");
    let is_link_local = |a: &str| a.starts_with("169.254.");
    let is_loopback = |a: &str| a.starts_with("127.") || a == "::1";
    candidates
        .iter()
        .filter(|a| !is_ics(a) && !is_link_local(a) && !is_loopback(a))
        .cloned()
        .collect()
}

/// Choose which advertised mother address to talk to. A mother with several
/// interfaces (Wi-Fi + Ethernet, a VPN) advertises one IPv4 per interface; a
/// satellite can usually route to only one of them. So prefer a mother IPv4 on
/// the SAME /24 as one of our own IPs - otherwise the child caches an
/// unreachable address and the mother sees it as offline. Fall back to first
/// IPv4, then any.
fn select_address(addresses: &[String]) -> Option<String> {
    let v4: Vec<Ipv4Addr> = addresses
        .iter()
        .filter_map(|a| a.parse::<Ipv4Addr>().ok())
        .collect();
    let locals = local_ipv4s();
    if let Some(same_subnet) = v4.iter().find(|m| locals.iter().any(|l| shares_24(*l, **m))) {
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
    let paired: Vec<(String, Option<String>)> = {
        let conn = open_db_for_command(&app).await?;
        conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(String, Option<String>)>> {
            let mut stmt = c.prepare("SELECT mother_uuid, manual_addr FROM paired_mothers")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let paired_set: std::collections::HashSet<String> = paired.iter().map(|(u, _)| u.clone()).collect();

    // Mothers paired by typed address and NOT seen over mDNS (multicast
    // filtered): confirm the stored address still answers as that mother.
    let mut manual_hits: Vec<(String, SocketAddr)> = Vec::new();
    for (uuid, manual) in &paired {
        let Some(sock) = manual.as_deref().and_then(|a| a.parse::<SocketAddr>().ok()) else { continue };
        if discovered.iter().any(|m| &m.mother_uuid == uuid) {
            continue;
        }
        if let Some(hello) = hello_at(sock).await {
            if vstr(&hello, "mother_uuid").as_deref() == Some(uuid.as_str()) {
                manual_hits.push((uuid.clone(), sock));
            }
        }
    }

    let mut refreshed = Vec::new();
    let mut guard = cache.inner.lock().await;
    for (uuid, sock) in manual_hits {
        guard.insert(uuid.clone(), sock);
        cache.fails.lock().await.remove(&uuid);
        refreshed.push(uuid);
    }
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
        // A freshly resolved address deserves a clean slate, or a mother that
        // just came back would be evicted again on its first failure.
        cache.fails.lock().await.remove(&m.mother_uuid);
        refreshed.push(m.mother_uuid);
    }
    Ok(refreshed)
}

/// Record a transport failure against a mother's cached endpoint, and evict the
/// entry once `ENDPOINT_EVICT_AFTER_FAILS` consecutive ones have piled up.
///
/// Why eviction matters (Ludiom #74): `client_resolve_mother_link` reads ONLY
/// this cache, and the 15s `refreshLaunchedGamesRoute` tick installs whatever it
/// returns. While a dead mother's address stayed cached, that tick kept dragging
/// the satellite's `launched_games` traffic back onto the corpse - overwriting a
/// correct re-point - and the route resolver's "no link" branch, which is what
/// triggers re-discovery of the PROMOTED mother, could never run. Dropping the
/// entry is what lets the device converge; a mother that was only blipping is
/// re-cached by the next `client_refresh_mother_endpoints` browse.
/// Lock order is `inner` then `fails`, matching
/// `client_refresh_mother_endpoints` (which holds `inner` across its loop).
/// Taking them the other way round here would be a deadlock.
async fn note_ping_failure(cache: &MotherEndpointCache, mother_uuid: &str) {
    let mut endpoints = cache.inner.lock().await;
    let mut fails = cache.fails.lock().await;
    let n = fails.entry(mother_uuid.to_string()).or_insert(0);
    *n += 1;
    if *n >= ENDPOINT_EVICT_AFTER_FAILS {
        fails.remove(mother_uuid);
        endpoints.remove(mother_uuid);
    }
}

/// Clear the consecutive-failure count: the address answered.
async fn note_ping_success(cache: &MotherEndpointCache, mother_uuid: &str) {
    cache.fails.lock().await.remove(mother_uuid);
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
    /// The mother speaks another LAN protocol (see LAN_PROTO) - an old mother
    /// (theirs < ours) or one that refused us with 426 (theirs > ours).
    ProtoMismatch { theirs: u32, their_app_version: Option<String> },
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
    // The offline lock screen's ping: exchange the licence only, leave queued
    // commands for later (nothing could act on them there).
    licence_only: Option<bool>,
) -> Result<(), PingErr> {
    let licence_only = licence_only == Some(true);
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

    // Every 30 s, also ask for the mother's other games, so this device can
    // take them all over if the mother dies (see `background_snapshot_plan`).
    let background = !licence_only && background_snapshots_due(&mother_uuid);
    let known_games: Value = if background {
        let uuid_for_q = mother_uuid.clone();
        let rows = match open_db_for_command(&app).await {
            Ok(conn) => conn
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(i64, i64)>> {
                    Ok(cached_games_of_mother(c, &uuid_for_q)?)
                })
                .await
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        Value::Array(
            rows.into_iter()
                .map(|(id, v)| json!({ "id": id, "game_version": v }))
                .collect(),
        )
    } else {
        Value::Null
    };

    let has_reader = *reader_presence.inner.lock().await;
    let operator_only = match app.try_state::<OperatorPresence>() {
        Some(p) => *p.inner.lock().await,
        None => false,
    };
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
    let upkeep: Value = match app.try_state::<UpkeepPresence>() {
        Some(p) => p
            .inner
            .lock()
            .await
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null),
        None => Value::Null,
    };

    // Our licence, so the mother keeps it when it's a newer studio check
    // (licence_sync.rs). The reply carries the mother's, adopted below.
    let db = open_db_for_command(&app)
        .await
        .map_err(|e| PingErr::Network { message: e })?;
    let licence = crate::licence_sync::local_value(&db).await;

    let url = format!("http://{addr}/ping.php");
    let client = lan_client_builder()
        .timeout(Duration::from_secs(2))
        .connect_timeout(Duration::from_millis(700))
        .build()
        .map_err(|e| PingErr::Network { message: e.to_string() })?;

    let resp = match client
        .post(&url)
        .header(header::AUTHORIZATION, format!("Bearer {secret}"))
        .json(&serde_json::json!({
            "has_reader": has_reader,
            "operator_only": operator_only,
            "screen_state": screen_state,
            "known_version": known_version,
            "launched_game_id": launched_game_id,
            "app_version": crate::app_version(),
            "platform": crate::update_cache::this_platform(),
            "upkeep": upkeep,
            "caps": command_caps(),
            "licence": licence,
            "licence_only": licence_only,
            "background_games": background,
            "known_games": known_games,
        }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // Transport failure - nothing answered at that address. Count it,
            // and evict once we're sure (see ENDPOINT_EVICT_AFTER_FAILS).
            note_ping_failure(&cache, &mother_uuid).await;
            return Err(PingErr::Network { message: e.to_string() });
        }
    };

    // Something answered on that address, whatever it thinks of us: the
    // endpoint itself is good, so an auth or HTTP error must NOT evict it.
    note_ping_success(&cache, &mother_uuid).await;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(PingErr::Unauth);
    }
    if status == reqwest::StatusCode::UPGRADE_REQUIRED {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        return Err(PingErr::ProtoMismatch {
            theirs: body.get("lan_proto").and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(LAN_PROTO + 1),
            their_app_version: vstr(&body, "app_version"),
        });
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
        cache.inner.lock().await.remove(&mother_uuid);
        cache.fails.lock().await.remove(&mother_uuid);
        return Err(PingErr::WrongUuid { got });
    }
    // A hotspot-era mother (no lan_proto) must not keep driving this satellite.
    let theirs = announced_proto(&body);
    if theirs != LAN_PROTO {
        return Err(PingErr::ProtoMismatch {
            theirs,
            their_app_version: vstr(&body, "app_version"),
        });
    }

    // The mother's licence, when it's a newer studio check than ours.
    crate::licence_sync::adopt_from_peer(&app, &db, body.get("licence")).await;
    if licence_only {
        return Ok(());
    }

    // LAN content sync: the mother's content revision. The renderer pulls new
    // content from the mother when it changes (services/peerContent.ts).
    if let Some(rev) = body.get("content_rev").and_then(|v| v.as_i64()) {
        use tauri::Emitter;
        let _ = app.emit("taghunter://mother-content-rev", rev);
    }

    // A real, authenticated exchange: this is what "Connecté · vu à HH:MM" on the
    // satellite's Network page reflects. last_seen_at used to be written only at
    // pairing, so a dead mother kept "Connecté" for hours (retours sept. #7).
    if let Ok(conn) = open_db_for_command(&app).await {
        let uuid_for_q = mother_uuid.clone();
        let _ = conn
            .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                c.execute(
                    "UPDATE paired_mothers SET last_seen_at = CURRENT_TIMESTAMP WHERE mother_uuid = ?",
                    params![uuid_for_q],
                )?;
                Ok(())
            })
            .await;
    }

    // Mother-failover slice 2: cache the latest snapshot to our own
    // playground.db (one "latest" row per game) so THIS device can be promoted
    // into the new mother (slice 4) if the current one dies. We store the whole
    // snapshot verbatim and key it by the game id; `upsert_cached_snapshot`
    // holds the staleness guard (epoch-dominant - see its doc comment).
    if let Some(snap) = body.get("snapshot").filter(|v| v.is_object()) {
        let gid = snap
            .get("game")
            .and_then(|g| g.get("id"))
            .and_then(|v| v.as_i64());
        let ver = snap.get("state_version").and_then(|v| v.as_i64());
        let epoch = snap.get("mother_epoch").and_then(|v| v.as_i64()).unwrap_or(1);
        if let (Some(gid), Some(ver)) = (gid, ver) {
            if let Ok(conn) = open_db_for_command(&app).await {
                let _ = upsert_cached_snapshot(&conn, gid, ver, epoch, snap.to_string()).await;
            }
        }
    }
    // Nothing shipped because our copy of the game on screen is current: it is
    // still running, say so (see `touch_cached_snapshot`).
    let mother_version = body.get("state_version").and_then(|v| v.as_i64());
    if let (Some(gid), Some(kv)) = (launched_game_id, known_version) {
        if body.get("snapshot").map_or(true, |v| v.is_null()) && mother_version == Some(kv) {
            if let Ok(conn) = open_db_for_command(&app).await {
                let _ = conn
                    .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<usize> {
                        Ok(c.execute(
                            "UPDATE mother_snapshots SET updated_at = CURRENT_TIMESTAMP
                              WHERE launched_game_id = ?1 AND state_version = ?2",
                            params![gid, kv],
                        )?)
                    })
                    .await;
            }
        }
    }
    // The mother's other games: store the copies it shipped, and mark the
    // current ones as still running.
    let background_snaps: Vec<Value> = body
        .get("snapshots")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let active_games: Vec<(i64, i64)> = body
        .get("active_games")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|g| Some((vi64(g, "id")?, vi64(g, "game_version")?)))
                .collect()
        })
        .unwrap_or_default();
    if !background_snaps.is_empty() || !active_games.is_empty() {
        if let Ok(conn) = open_db_for_command(&app).await {
            for snap in background_snaps.iter().filter(|v| v.is_object()) {
                let gid = snap.get("game").and_then(|g| g.get("id")).and_then(|v| v.as_i64());
                let ver = snap.get("state_version").and_then(|v| v.as_i64());
                let epoch = snap.get("mother_epoch").and_then(|v| v.as_i64()).unwrap_or(1);
                if let (Some(gid), Some(ver)) = (gid, ver) {
                    let _ = upsert_cached_snapshot(&conn, gid, ver, epoch, snap.to_string()).await;
                }
            }
            let uuid_for_q = mother_uuid.clone();
            let _ = conn
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    for (id, v) in active_games {
                        touch_cached_snapshot(c, id, &uuid_for_q, v)?;
                    }
                    Ok(())
                })
                .await;
        }
    }

    // Drain & dispatch pending commands. The renderer acks each one once its
    // handler ran (`client_ack_command`); see `CommandLedger` for redelivery.
    if let Some(commands) = body.get("commands").and_then(|v| v.as_array()) {
        use tauri::Emitter;
        let ledger = app.try_state::<CommandLedger>();
        for cmd in commands {
            let id = cmd.get("id").and_then(|v| v.as_i64());
            // What to do with a redelivered command (first delivery: emit).
            enum Seen {
                New,
                Skip,
                Reack(Option<Value>),
            }
            let seen = match (&ledger, id) {
                (Some(l), Some(id)) => {
                    let mut guard = l.inner.lock().await;
                    let now = Instant::now();
                    guard.retain(|_, e| match e {
                        LedgerEntry::Handled(at, _) => now.duration_since(*at) < LEDGER_KEEP,
                        LedgerEntry::Inflight(at) => now.duration_since(*at) < LEDGER_KEEP,
                    });
                    let key = (mother_uuid.clone(), id);
                    match guard.get(&key) {
                        None => {
                            guard.insert(key, LedgerEntry::Inflight(now));
                            Seen::New
                        }
                        Some(LedgerEntry::Handled(_, result)) => Seen::Reack(result.clone()),
                        Some(LedgerEntry::Inflight(since)) => {
                            if now.duration_since(*since) >= RENDERER_ACK_TIMEOUT {
                                let result = json!({ "ok": false, "error": "renderer_timeout" });
                                guard.insert(key, LedgerEntry::Handled(now, Some(result.clone())));
                                Seen::Reack(Some(result))
                            } else {
                                Seen::Skip
                            }
                        }
                    }
                }
                _ => Seen::New,
            };
            match seen {
                Seen::Skip => continue,
                Seen::Reack(result) => {
                    if let Some(id) = id {
                        tokio::spawn(post_ack(addr, secret.clone(), id, result));
                    }
                    continue;
                }
                Seen::New => {}
            }
            // Enrich each command with the originating mother's uuid + address so
            // the renderer can repoint `launched_games` traffic at the mother
            // (a satellite must read/write the mother's game, not its own server)
            // and ack it there once handled.
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
        }
    }
    Ok(())
}

/// POST `ack_command` (with the handler's result, when known) to the mother.
async fn post_ack(addr: SocketAddr, secret: String, id: i64, result: Option<Value>) -> bool {
    let Ok(client) = lan_client_builder()
        .timeout(Duration::from_secs(2))
        .connect_timeout(Duration::from_millis(700))
        .build()
    else {
        return false;
    };
    let url = format!("http://{addr}/launched_games.php?action=ack_command");
    let body = match result {
        Some(r) => json!({ "command_id": id, "result": r }),
        None => json!({ "command_id": id }),
    };
    client
        .post(&url)
        .header(header::AUTHORIZATION, format!("Bearer {secret}"))
        .json(&body)
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

/// The renderer finished handling a pushed command (`services/lanCommands.ts`):
/// record it in the ledger and ack it on the mother that sent it, with what
/// happened (`{ok, error?, detail?}`). `mother_addr` is the address the command
/// came from (the event carries it); the warm endpoint cache is the fallback.
#[tauri::command]
pub async fn client_ack_command(
    app: AppHandle,
    cache: tauri::State<'_, MotherEndpointCache>,
    ledger: tauri::State<'_, CommandLedger>,
    mother_uuid: String,
    mother_addr: Option<String>,
    command_id: i64,
    result: Option<Value>,
) -> Result<bool, String> {
    let result = result.filter(|v| v.is_object());
    ledger.inner.lock().await.insert(
        (mother_uuid.clone(), command_id),
        LedgerEntry::Handled(Instant::now(), result.clone()),
    );
    let secret: Option<String> = {
        let conn = open_db_for_command(&app).await?;
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
        .map_err(|e| e.to_string())?
    };
    let Some(secret) = secret else {
        return Ok(false);
    };
    let addr = match mother_addr.as_deref().and_then(|a| a.parse::<SocketAddr>().ok()) {
        Some(a) => Some(a),
        None => cache.inner.lock().await.get(&mother_uuid).copied(),
    };
    let Some(addr) = addr else {
        // Not reachable now: the next delivery re-acks it from the ledger.
        return Ok(false);
    };
    Ok(post_ack(addr, secret, command_id, result).await)
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

/// Renderer-driven setter: `services/upkeepState.ts` reports this device's
/// update + content-sync state as a JSON string whenever it changes. Cached
/// in-process, shipped on every ping (`paired_devices.upkeep_json` on the
/// mother), read directly for the mother's own row in `list_fleet`.
#[tauri::command]
pub async fn client_set_upkeep(
    presence: tauri::State<'_, UpkeepPresence>,
    json: Option<String>,
) -> Result<(), String> {
    let mut guard = presence.inner.lock().await;
    *guard = json.filter(|s| !s.is_empty() && s.len() <= 8 * 1024);
    Ok(())
}

#[derive(Serialize)]
pub struct LocalRole {
    /// The local axum server is up (this device is the mother).
    pub mother_server_running: bool,
    /// Count of non-self paired_devices. Drives the "N clients" count in the
    /// mother_hosting tooltip and the mother_idle state.
    pub paired_devices_count: u32,
    /// Count of paired_mothers (any). Drives the child branch entry condition.
    pub paired_mothers_count: u32,
    /// Why the running server hosts: "m" (this device is set as the mother) or
    /// "s" (a substitute). None when no server runs.
    pub hosting_role: Option<String>,
    /// The mother a substitute stands in for (its device name), when known.
    pub substitute_for_label: Option<String>,
}

// Aggregate the local LAN-mode signals into a single struct the footer can
// branch on. Cheap: the two counts are single
// SELECT COUNT(*) reads, and mother_server_running comes from the in-process
// MotherServerState mutex.
#[tauri::command]
pub async fn client_describe_local_role(
    app: AppHandle,
    server_state: tauri::State<'_, MotherServerState>,
) -> Result<LocalRole, String> {
    let hosting_role = {
        let guard = server_state.inner.lock().await;
        guard.as_ref().map(|r| r.role.code().to_string())
    };
    let mother_server_running = hosting_role.is_some();

    let conn = open_db_for_command(&app).await?;
    let (paired_devices_count, paired_mothers_count, substitute_for_label) = conn
        .call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(u32, u32, Option<String>)> {
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
            let sub: Option<String> = c
                .query_row(
                    "SELECT value FROM schema_meta WHERE key = 'substitute_for_label'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            Ok((pd.max(0) as u32, pm.max(0) as u32, sub))
        })
        .await
        .map_err(|e| e.to_string())?;

    Ok(LocalRole {
        mother_server_running,
        paired_devices_count,
        paired_mothers_count,
        hosting_role,
        substitute_for_label,
    })
}

/// Forget which mother this device stood in for: it handed the hosting back.
#[tauri::command]
pub async fn client_clear_substitute_state(app: AppHandle) -> Result<(), String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
        c.execute(
            "DELETE FROM schema_meta WHERE key IN ('substitute_for_uuid', 'substitute_for_label')",
            [],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())
}

/// This device's OWN copy of its games, read straight from its database (no
/// server needed). Same rows as the `list` action. The "Cet appareil" section
/// uses it on a satellite: asking the routed mother for `mine=1` answered with
/// the MOTHER's own games.
#[tauri::command]
pub async fn client_list_local_games(
    app: AppHandle,
    client_id: i64,
    mine: Option<bool>,
) -> Result<Vec<Value>, String> {
    let conn = open_db_for_command(&app).await?;
    conn.call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<Value>> {
        Ok(list_games_sync(c, client_id, None, mine.unwrap_or(false))?)
    })
    .await
    .map_err(|e| e.to_string())
}

/// What `client_reconcile_with_mother` did. A refusal is listed, never an
/// error: this runs on a timer.
#[derive(Serialize, Default)]
pub struct ReconcileReport {
    /// Games this device sent and the mother took.
    pub pushed: u32,
    /// Games whose later state this device took from the mother.
    pub pulled: u32,
    /// Local copies removed because the mother deleted or archived the game.
    pub dropped: u32,
    /// `<summary_uuid>: <reason>` for each push or pull that was refused.
    pub refused: Vec<String>,
    /// The mother accepted none of our secrets: pair first, then retry.
    pub needs_pair: bool,
    /// The mother runs a build without reconciliation.
    pub unsupported: bool,
    /// This device is serving: it reconciles as a mother, not as a client.
    pub serving: bool,
}

struct LocalCopy {
    id: i64,
    summary_uuid: String,
    version: GameVersion,
    hosted: bool,
}

fn inventory_version(v: &Value) -> GameVersion {
    GameVersion {
        epoch: vi64(v, "mother_epoch").unwrap_or(1),
        ended: vbool(v, "ended"),
        state_version: vi64(v, "state_version").unwrap_or(0),
    }
}

/// Bring this device and the mother at `addr:port` to the same state for every
/// game of the client: the newer copy wins, whoever holds it.
///
/// - A local game more advanced than the mother's is PUSHED. This is how a
///   substitute hands back what it hosted, ended games included, and how a
///   mother's frozen copy gets replaced.
/// - A game the mother has never had is pushed only by the device that hosted
///   it (no cached snapshot from another mother, or a local epoch above it).
/// - A cached snapshot with no local row is offered too, as an update only: a
///   plain satellite can hold the latest state of a game whose host is gone.
/// - A game more advanced on the mother is PULLED, when this device holds it.
/// - A local copy the mother deleted or archived at that state is dropped.
///
/// Satellites call it when their route to a mother is (re)established and on
/// the reconcile tick. Satellites run no server, so the transfer always starts
/// from the satellite.
#[tauri::command]
pub async fn client_reconcile_with_mother(
    app: AppHandle,
    server_state: tauri::State<'_, MotherServerState>,
    addr: String,
    port: u16,
) -> Result<ReconcileReport, String> {
    let mut report = ReconcileReport::default();
    if server_state.inner.lock().await.is_some() {
        report.serving = true;
        return Ok(report);
    }

    let conn = open_db_for_command(&app).await?;
    let secrets = outbound_secrets(&conn).await;
    if secrets.is_empty() {
        report.needs_pair = true;
        return Ok(report);
    }
    let addr_port = format!("{addr}:{port}");
    // Longer than the 5 s of a snapshot pull: a push carries a whole game.
    let client = lan_client_builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;

    // 1. The mother's inventory; the secret it accepts is used for the rest.
    let mut inventory: Option<(Value, String)> = None;
    for secret in &secrets {
        let resp = client
            .get(format!("http://{addr_port}/launched_games.php?action=inventory"))
            .header(header::AUTHORIZATION, format!("Bearer {secret}"))
            .send()
            .await
            .map_err(|e| format!("contacting current mother: {e}"))?;
        let status = resp.status().as_u16();
        if status == 401 || status == 403 {
            continue;
        }
        if !resp.status().is_success() {
            report.unsupported = true;
            return Ok(report);
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        inventory = Some((body, secret.clone()));
        break;
    }
    let Some((inventory, secret)) = inventory else {
        report.needs_pair = true;
        return Ok(report);
    };
    let Some(client_id) = vi64(&inventory, "client_id") else {
        report.unsupported = true;
        return Ok(report);
    };
    let by_uuid = |key: &str| -> HashMap<String, Value> {
        inventory
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|g| Some((vstr(g, "summary_uuid")?, g.clone())))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mother_games = by_uuid("games");
    let tombstones = by_uuid("tombstones");

    // 2. What this device holds.
    let (locals, self_uuid, counter) = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<(Vec<LocalCopy>, String, i64)> {
            let locals = c
                .prepare(
                    "SELECT g.id, g.summary_uuid, g.mother_epoch, g.ended, g.state_version,
                            (s.launched_game_id IS NULL OR g.mother_epoch > s.mother_epoch)
                       FROM lg_launched_games g
                       LEFT JOIN mother_snapshots s
                              ON s.launched_game_id = g.id
                             AND json_extract(s.snapshot_json, '$.game.summary_uuid') = g.summary_uuid
                      WHERE g.client_id = ?",
                )?
                .query_map(params![client_id], |r| {
                    Ok(LocalCopy {
                        id: r.get(0)?,
                        summary_uuid: r.get(1)?,
                        version: GameVersion {
                            epoch: r.get(2)?,
                            ended: r.get::<_, i64>(3)? != 0,
                            state_version: r.get(4)?,
                        },
                        hosted: r.get::<_, i64>(5)? != 0,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let self_uuid: String = c
                .query_row("SELECT value FROM schema_meta WHERE key = 'client_device_uuid'", [], |r| r.get(0))
                .optional()?
                .unwrap_or_default();
            let counter: i64 = c
                .query_row("SELECT value FROM schema_meta WHERE key = 'lg_state_version'", [], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            Ok((locals, self_uuid, counter))
        })
        .await
        .map_err(|e| e.to_string())?;

    // One push. Ok(Some(epoch)) = taken, at that epoch on the mother.
    let push = |snapshot: Value, hosted: bool| {
        let client = client.clone();
        let url = format!("http://{addr_port}/launched_games.php?action=push_snapshot");
        let secret = secret.clone();
        async move {
            let resp = client
                .post(url)
                .header(header::AUTHORIZATION, format!("Bearer {secret}"))
                .json(&json!({ "snapshot": snapshot, "hosted": hosted }))
                .send()
                .await
                .map_err(|e| format!("contacting current mother: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("current mother returned HTTP {}", resp.status().as_u16()));
            }
            let body: Value = resp.json().await.map_err(|e| e.to_string())?;
            if vbool(&body, "applied") {
                Ok::<Result<i64, String>, String>(Ok(vi64(&body, "mother_epoch").unwrap_or(1)))
            } else {
                Ok(Err(vstr(&body, "reason").unwrap_or_else(|| "refused".into())))
            }
        }
    };

    let mut local_uuids: HashSet<String> = HashSet::new();
    for g in &locals {
        local_uuids.insert(g.summary_uuid.clone());
        let on_mother = mother_games.get(&g.summary_uuid);
        let tomb = tombstones.get(&g.summary_uuid).map(|t| GameVersion { ended: true, ..inventory_version(t) });

        // What to do with this copy.
        let (send, fetch, discard) = match (on_mother, tomb) {
            (Some(m), _) => {
                let theirs = inventory_version(m);
                (is_newer(g.version, theirs), is_newer(theirs, g.version), false)
            }
            (None, Some(t)) if !is_newer(g.version, t) => (false, false, true),
            (None, _) => (g.hosted, false, false),
        };

        if send {
            let (gid, uuid) = (g.id, self_uuid.clone());
            let bundle = conn
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<Value>> {
                    Ok(build_snapshot_sync(c, &uuid, gid, counter)?)
                })
                .await
                .map_err(|e| e.to_string())?;
            let Some(bundle) = bundle else { continue };
            match push(bundle.clone(), g.hosted).await? {
                Ok(mother_epoch) => {
                    report.pushed += 1;
                    // The mother holds it now: remember that as a snapshot at
                    // its epoch, so this game no longer counts as hosted here.
                    let (gid, epoch) = (g.id, mother_epoch.max(g.version.epoch));
                    let _ = conn
                        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                            c.execute(
                                "INSERT OR REPLACE INTO mother_snapshots
                                   (launched_game_id, state_version, mother_epoch, snapshot_json, updated_at)
                                 VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)",
                                params![gid, counter, epoch, bundle.to_string()],
                            )?;
                            Ok(())
                        })
                        .await;
                }
                Err(reason) => report.refused.push(format!("{}: {reason}", g.summary_uuid)),
            }
        } else if fetch {
            let mother_gid = on_mother.and_then(|m| vi64(m, "id")).unwrap_or(0);
            let Some(snap) = pull_snapshot_over_http(&addr_port, &secret, mother_gid).await? else { continue };
            if let (Some(ver), Some(epoch)) = (vi64(&snap, "state_version"), vi64(&snap, "mother_epoch")) {
                let _ = upsert_cached_snapshot(&conn, mother_gid, ver, epoch, snap.to_string()).await;
            }
            let outcome = conn
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<AdoptOutcome> {
                    let tx = c.transaction()?;
                    let outcome = adopt_peer_snapshot(&tx, &snap, client_id, /* hosted */ false)?;
                    if outcome.applied {
                        tx.commit()?;
                    }
                    Ok(outcome)
                })
                .await
                .map_err(|e| format!("apply snapshot: {e}"))?;
            if outcome.applied {
                report.pulled += 1;
            } else {
                report.refused.push(format!("{}: {}", g.summary_uuid, outcome.reason));
            }
        } else if discard {
            let gid = g.id;
            let _ = conn
                .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    c.execute("DELETE FROM lg_launched_games WHERE id = ?", params![gid])?;
                    Ok(())
                })
                .await;
            report.dropped += 1;
        }
    }

    // 3. Cached snapshots of games this device holds no row for.
    let cached: Vec<(String, GameVersion, String)> = conn
        .call(move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Vec<(String, GameVersion, String)>> {
            let rows = c
                .prepare(
                    "SELECT json_extract(snapshot_json, '$.game.summary_uuid'),
                            mother_epoch,
                            COALESCE(json_extract(snapshot_json, '$.game.ended'), 0),
                            COALESCE(json_extract(snapshot_json, '$.game.state_version'), state_version),
                            snapshot_json
                       FROM mother_snapshots
                      WHERE json_extract(snapshot_json, '$.game.client_id') = ?",
                )?
                .query_map(params![client_id], |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        GameVersion {
                            epoch: r.get(1)?,
                            ended: r.get::<_, i64>(2)? != 0,
                            state_version: r.get(3)?,
                        },
                        r.get::<_, String>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap_or_default();
    for (uuid, version, json_text) in cached {
        if local_uuids.contains(&uuid) {
            continue;
        }
        let Some(m) = mother_games.get(&uuid) else { continue };
        if !is_newer(version, inventory_version(m)) {
            continue;
        }
        let Ok(snapshot) = serde_json::from_str::<Value>(&json_text) else { continue };
        match push(snapshot, /* hosted */ false).await? {
            Ok(_) => report.pushed += 1,
            Err(reason) => report.refused.push(format!("{uuid}: {reason}")),
        }
    }

    if report.pulled > 0 || report.dropped > 0 {
        use tauri::Emitter;
        let _ = app.emit(GAMES_RECONCILED_EVENT, json!({}));
    }
    Ok(report)
}

#[cfg(test)]
mod adopt_tests {
    use super::*;

    #[test]
    fn takeover_tie_break_lower_uuid_wins() {
        // Strictly higher epoch always wins, whatever the uuids.
        assert!(outranks_local_mother(Some(5), "zzz", 4, Some("aaa")));
        // Lower epoch never does.
        assert!(!outranks_local_mother(Some(3), "aaa", 4, Some("zzz")));
        // Equal epoch: the lower uuid wins, so exactly one side yields.
        assert!(outranks_local_mother(Some(4), "aaa", 4, Some("bbb")));
        assert!(!outranks_local_mother(Some(4), "bbb", 4, Some("aaa")));
        // No own uuid, no epoch, or no local game: no tie-break.
        assert!(!outranks_local_mother(Some(4), "aaa", 4, None));
        assert!(!outranks_local_mother(None, "aaa", 0, Some("bbb")));
        assert!(!outranks_local_mother(Some(0), "aaa", 0, Some("bbb")));
    }

    const SCHEMA: &str = r#"
        CREATE TABLE lg_launched_games (
            id INTEGER PRIMARY KEY AUTOINCREMENT, summary_uuid TEXT NOT NULL UNIQUE,
            client_id INTEGER NOT NULL, game_uniqid TEXT NOT NULL, name TEXT NOT NULL,
            number_of_teams INTEGER NOT NULL, game_type TEXT NOT NULL, duration INTEGER NOT NULL,
            start_time TEXT NULL, started INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), mother_epoch INTEGER NOT NULL DEFAULT 1,
            ended_at INTEGER NULL, launched_by_self INTEGER NOT NULL DEFAULT 0,
            state_version INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE paired_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, peer_uuid TEXT NOT NULL UNIQUE,
            peer_label TEXT NOT NULL, peer_os TEXT NULL, peer_app_version TEXT NULL, peer_secret TEXT NOT NULL,
            is_self INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE revoked_devices (peer_uuid TEXT PRIMARY KEY, peer_label TEXT NULL);
        CREATE TABLE lg_game_tombstones (summary_uuid TEXT PRIMARY KEY, kind TEXT NOT NULL,
            mother_epoch INTEGER NOT NULL, state_version INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
        CREATE TABLE lg_launched_game_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            meta_name TEXT NOT NULL, meta_value TEXT NULL,
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE);
        CREATE TABLE lg_launched_game_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            device_id INTEGER NOT NULL, device_label TEXT NULL, os TEXT NULL, os_version TEXT NULL,
            connected INTEGER NOT NULL DEFAULT 1, UNIQUE(launched_game_id, device_id),
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE);
        CREATE TABLE lg_launched_game_raw_data (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            device_id INTEGER NOT NULL, raw_data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE);
        CREATE TABLE lg_teams (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            team_number INTEGER NOT NULL, team_name TEXT NULL, pattern INTEGER NOT NULL, score INTEGER NOT NULL DEFAULT 0,
            key_id INTEGER NULL, start_time INTEGER NULL, end_time INTEGER NULL, language TEXT NULL,
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE);
        CREATE TABLE lg_team_completed_quests (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            team_id INTEGER NOT NULL, teammate_chip_id INTEGER NULL, quest_id INTEGER NULL, quest_number TEXT NOT NULL,
            points_awarded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
            FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE);
        CREATE TABLE lg_clash_members (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            team_id INTEGER NOT NULL, chip_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
            FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE);
        CREATE TABLE lg_clash_validations (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            team_id INTEGER NOT NULL, chip_id INTEGER NOT NULL, combo_index INTEGER NOT NULL,
            territory_index INTEGER NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
            FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE);
        CREATE TABLE lg_clash_consumed (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            chip_id INTEGER NOT NULL, punch_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE);
        CREATE TABLE lg_clash_effectif (launched_game_id INTEGER NOT NULL, team_id INTEGER NOT NULL, size INTEGER NOT NULL,
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
            FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE);
        CREATE TABLE lg_clash_purges (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            team_id INTEGER NOT NULL, chip_id INTEGER NOT NULL, territory_index INTEGER NOT NULL, seq INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
            FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE);
        CREATE TABLE lg_game_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, summary_uuid TEXT NOT NULL UNIQUE,
            launched_game_id INTEGER NULL);
    "#;

    fn db() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }

    /// Local, unrelated game 7 owns raw 5, team 3 (+ quest 9 on it) and a
    /// summary; the snapshot adopts a game also numbered 7, another summary_uuid.
    fn seed_local(c: &rusqlite::Connection) {
        c.execute_batch(
            "INSERT INTO lg_launched_games (id, summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, duration, ended)
               VALUES (7, 'local-uuid', 1, 'g', 'local', 1, 'quest', 0, 1);
             INSERT INTO lg_launched_game_raw_data (id, launched_game_id, device_id, raw_data) VALUES (5, 7, 1, 'local-raw');
             INSERT INTO lg_teams (id, launched_game_id, team_number, pattern) VALUES (3, 7, 1, 0);
             INSERT INTO lg_team_completed_quests (id, launched_game_id, team_id, quest_number) VALUES (9, 7, 3, 'q');
             INSERT INTO lg_game_summaries (summary_uuid, launched_game_id) VALUES ('local-uuid', 7);",
        )
        .unwrap();
    }

    fn snapshot() -> SnapshotRows {
        parse_snapshot_rows(&json!({
            "mother_epoch": 2, "state_version": 4,
            "game": {"id": 7, "summary_uuid": "adopted-uuid", "client_id": 1, "game_uniqid": "g",
                     "name": "adopted", "game_type": "quest"},
            "raw_data": [{"id": 5, "device_id": 2, "raw_data": "adopted-raw"}],
            "teams": [{"id": 3, "team_number": 1}],
            "completed_quests": [{"id": 9, "team_id": 3, "quest_number": "q"}],
        }))
        .unwrap()
    }

    fn adopt(c: &mut rusqlite::Connection) -> rusqlite::Result<()> {
        let rows = snapshot();
        let tx = c.transaction()?;
        apply_game_rows(&tx, &rows, 3, false)?;
        tx.commit()
    }

    fn one<T: rusqlite::types::FromSql>(c: &rusqlite::Connection, sql: &str) -> T {
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn adopt_moves_colliding_local_rows_aside() {
        let mut c = db();
        seed_local(&c);
        adopt(&mut c).expect("adopt must not hit UNIQUE");

        assert_eq!(one::<String>(&c, "SELECT raw_data FROM lg_launched_game_raw_data WHERE id = 5"), "adopted-raw");
        assert_eq!(one::<String>(&c, "SELECT name FROM lg_launched_games WHERE id = 7"), "adopted");

        // The unrelated local game survived under a new id, children intact.
        let local_gid: i64 = one(&c, "SELECT id FROM lg_launched_games WHERE summary_uuid = 'local-uuid'");
        assert_ne!(local_gid, 7);
        let raw: String = c
            .query_row("SELECT raw_data FROM lg_launched_game_raw_data WHERE launched_game_id = ?", [local_gid], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, "local-raw");
        let (team_id, cq_team): (i64, i64) = c
            .query_row(
                "SELECT t.id, q.team_id FROM lg_teams t JOIN lg_team_completed_quests q ON q.team_id = t.id
                  WHERE t.launched_game_id = ?",
                [local_gid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(team_id, cq_team);
        assert_ne!(team_id, 3);
        assert_eq!(one::<i64>(&c, "SELECT launched_game_id FROM lg_game_summaries WHERE summary_uuid = 'local-uuid'"), local_gid);
        assert_eq!(one::<i64>(&c, "SELECT COUNT(*) FROM pragma_foreign_key_check"), 0);
    }

    #[test]
    fn adopt_is_repeatable() {
        let mut c = db();
        seed_local(&c);
        adopt(&mut c).unwrap();
        adopt(&mut c).expect("second adopt of the same snapshot must succeed");
        assert_eq!(one::<i64>(&c, "SELECT COUNT(*) FROM lg_launched_games"), 2);
    }

    #[test]
    fn leaf_collision_only_moves_the_leaf() {
        let mut c = db();
        c.execute_batch(
            "INSERT INTO lg_launched_games (id, summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, duration)
               VALUES (1, 'other', 1, 'g', 'other', 1, 'quest', 0);
             INSERT INTO lg_launched_game_raw_data (id, launched_game_id, device_id, raw_data) VALUES (5, 1, 1, 'other-raw');",
        )
        .unwrap();
        adopt(&mut c).unwrap();
        let moved: i64 = one(&c, "SELECT id FROM lg_launched_game_raw_data WHERE raw_data = 'other-raw'");
        assert_ne!(moved, 5);
        let gid: i64 = c
            .query_row("SELECT launched_game_id FROM lg_launched_game_raw_data WHERE id = ?", [moved], |r| r.get(0))
            .unwrap();
        assert_eq!(gid, 1);
    }

    // ── substitute takeover: match by game, adopt every game, cache them all ──

    const FAILOVER_SCHEMA: &str = r#"
        CREATE TABLE mother_snapshots (launched_game_id INTEGER PRIMARY KEY, state_version INTEGER NOT NULL,
            mother_epoch INTEGER NOT NULL DEFAULT 1, snapshot_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP));
        CREATE TABLE scenarios (uniqid TEXT PRIMARY KEY, local_version INTEGER NULL);
    "#;

    fn failover_db() -> rusqlite::Connection {
        let c = db();
        c.execute_batch(FAILOVER_SCHEMA).unwrap();
        c
    }

    fn cached(id: i64, mother: &str, uniqid: &str, ended: bool, game_version: i64) -> Value {
        json!({
            "mother_epoch": 1, "state_version": 40, "mother_uuid": mother,
            "game": {"id": id, "summary_uuid": format!("uuid-{id}"), "client_id": 1, "game_uniqid": uniqid,
                     "name": format!("game {id}"), "game_type": "quest", "ended": ended,
                     "state_version": game_version},
            "teams": [{"id": id * 100, "team_number": 1}],
        })
    }

    fn cache(c: &rusqlite::Connection, snap: &Value) {
        c.execute(
            "INSERT INTO mother_snapshots (launched_game_id, state_version, mother_epoch, snapshot_json)
             VALUES (?1, 40, 1, ?2)",
            params![snap["game"]["id"].as_i64().unwrap(), snap.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn stale_guard_ignores_another_game_at_the_same_id() {
        let c = db();
        seed_local(&c);
        c.execute("UPDATE lg_launched_games SET mother_epoch = 5 WHERE id = 7", []).unwrap();
        // The snapshot's game is also numbered 7, but it is another game.
        assert_eq!(local_newer_epoch(&c, "adopted-uuid").unwrap(), None);
        assert_eq!(local_newer_epoch(&c, "local-uuid").unwrap(), Some(5));
    }

    #[test]
    fn substitute_adopts_every_running_game_of_the_mother() {
        let mut c = failover_db();
        c.execute_batch(
            "INSERT INTO scenarios (uniqid, local_version) VALUES ('ok', 1), ('missing', NULL);",
        )
        .unwrap();
        cache(&c, &cached(11, "M", "ok", false, 3));
        cache(&c, &cached(12, "M", "ok", true, 3)); // ended
        cache(&c, &cached(13, "X", "ok", false, 3)); // another mother
        cache(&c, &cached(14, "M", "missing", false, 3)); // scenario not downloaded
        // 15: nothing cached.

        let tx = c.transaction().unwrap();
        let out = adopt_extra_cached_games(&tx, &[11, 12, 13, 14, 15], Some("M"), 1).unwrap();
        tx.commit().unwrap();

        assert_eq!(out.adopted, vec![11]);
        assert_eq!(out.max_epoch, 2);
        let reasons: Vec<(i64, &str)> = out.skipped.iter().map(|s| (s.id, s.reason.as_str())).collect();
        assert_eq!(
            reasons,
            vec![(12, "ended"), (13, "other_mother"), (14, "no_content"), (15, "no_cached_snapshot")]
        );
        assert_eq!(one::<i64>(&c, "SELECT mother_epoch FROM lg_launched_games WHERE id = 11"), 2);
        assert_eq!(one::<i64>(&c, "SELECT COUNT(*) FROM lg_teams WHERE launched_game_id = 11"), 1);
        assert_eq!(one::<i64>(&c, "SELECT COUNT(*) FROM lg_launched_games"), 1);
    }

    #[test]
    fn substitute_skips_a_game_it_already_holds_newer() {
        let mut c = failover_db();
        c.execute_batch(
            "INSERT INTO scenarios (uniqid, local_version) VALUES ('ok', 1);
             INSERT INTO lg_launched_games (id, summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, duration, mother_epoch)
               VALUES (11, 'uuid-11', 1, 'ok', 'mine', 1, 'quest', 0, 3);",
        )
        .unwrap();
        cache(&c, &cached(11, "M", "ok", false, 3));
        let tx = c.transaction().unwrap();
        let out = adopt_extra_cached_games(&tx, &[11], Some("M"), 1).unwrap();
        tx.commit().unwrap();
        assert!(out.adopted.is_empty());
        assert_eq!(out.skipped[0].reason, "stale_snapshot");
        assert_eq!(one::<String>(&c, "SELECT name FROM lg_launched_games WHERE id = 11"), "mine");
    }

    #[test]
    fn background_plan_ships_only_changed_games() {
        let c = db();
        c.execute_batch(
            "INSERT INTO lg_launched_games (id, summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, duration, ended, state_version) VALUES
               (1, 'a', 1, 'g', 'a', 1, 'quest', 0, 0, 5),
               (2, 'b', 1, 'g', 'b', 1, 'quest', 0, 0, 7),
               (3, 'c', 1, 'g', 'c', 1, 'quest', 0, 1, 9),
               (4, 'd', 1, 'g', 'd', 1, 'quest', 0, 0, 1),
               (5, 'e', 2, 'g', 'e', 1, 'quest', 0, 0, 1);",
        )
        .unwrap();
        // The satellite holds game 1 current, game 3 from before it ended, and
        // plays game 4 (handled by the regular path).
        let known: HashMap<i64, i64> = [(1, 5), (3, 8)].into_iter().collect();
        let (ship, active) = background_snapshot_plan(&c, 1, &known, Some(4)).unwrap();
        assert_eq!(ship, vec![2, 3]);
        assert_eq!(active, vec![(1, 5), (2, 7), (4, 1)]);

        // Nothing cached yet: at most BACKGROUND_SNAPSHOT_CAP per reply.
        c.execute_batch(
            "INSERT INTO lg_launched_games (id, summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, duration, ended) VALUES
               (6, 'f', 1, 'g', 'f', 1, 'quest', 0, 0), (7, 'h', 1, 'g', 'h', 1, 'quest', 0, 0);",
        )
        .unwrap();
        let (ship, _) = background_snapshot_plan(&c, 1, &HashMap::new(), None).unwrap();
        assert_eq!(ship.len(), BACKGROUND_SNAPSHOT_CAP);
    }

    #[test]
    fn touch_marks_a_current_copy_as_still_running() {
        let c = failover_db();
        cache(&c, &cached(11, "M", "ok", false, 3));
        cache(&c, &cached(12, "M", "ok", true, 3));
        c.execute("UPDATE mother_snapshots SET updated_at = '2000-01-01 00:00:00'", []).unwrap();

        assert_eq!(touch_cached_snapshot(&c, 11, "M", 2).unwrap(), 0, "older copy: not current");
        assert_eq!(touch_cached_snapshot(&c, 11, "X", 3).unwrap(), 0, "another mother's id");
        assert_eq!(touch_cached_snapshot(&c, 11, "M", 3).unwrap(), 1);
        assert_ne!(
            one::<String>(&c, "SELECT updated_at FROM mother_snapshots WHERE launched_game_id = 11"),
            "2000-01-01 00:00:00"
        );
        assert_eq!(one::<i64>(&c, "SELECT state_version FROM mother_snapshots WHERE launched_game_id = 11"), 40);

        // Only unfinished copies of that mother are listed to it.
        assert_eq!(cached_games_of_mother(&c, "M").unwrap(), vec![(11, 3)]);
        assert!(cached_games_of_mother(&c, "X").unwrap().is_empty());
    }

    // ── reconciliation: the newer copy wins ──────────────────────────────────

    fn v(epoch: i64, ended: bool, state_version: i64) -> GameVersion {
        GameVersion { epoch, ended, state_version }
    }

    #[test]
    fn newer_is_epoch_then_ended_then_version() {
        // A later lineage beats everything, even an ended copy at a high version.
        assert!(is_newer(v(2, false, 1), v(1, true, 900)));
        assert!(!is_newer(v(1, true, 900), v(2, false, 1)));
        // Same epoch: ended beats unfinished, whatever the versions.
        assert!(is_newer(v(2, true, 1), v(2, false, 50)));
        // Same epoch, same status: the version decides.
        assert!(is_newer(v(2, false, 51), v(2, false, 50)));
        assert!(!is_newer(v(2, false, 50), v(2, false, 51)));
        // Equal copies never trade places.
        assert!(!is_newer(v(2, true, 7), v(2, true, 7)));
    }

    /// The copy a substitute hosted: game 7 "sub-uuid" at epoch 2, ended, one
    /// team with one quest and one punch recorded by device 4 (uuid "sat").
    fn substitute_bundle(ended: bool) -> Value {
        json!({
            "mother_epoch": 2, "state_version": 40,
            "game": {"id": 7, "summary_uuid": "sub-uuid", "client_id": 1, "game_uniqid": "g",
                     "name": "from substitute", "game_type": "quest",
                     "ended": ended, "ended_at": if ended { json!(1700000000) } else { Value::Null },
                     "state_version": 38},
            "devices": [{"device_id": 4, "connected": true}],
            "raw_data": [{"id": 5, "device_id": 4, "raw_data": "punch"}],
            "teams": [{"id": 3, "team_number": 1, "team_name": "Midnight", "score": 25}],
            "completed_quests": [{"id": 9, "team_id": 3, "quest_number": "q", "points_awarded": 25}],
            "paired_devices": [
                {"id": 1, "peer_uuid": "sub", "peer_label": "ADMIN", "peer_secret": "s-sub", "is_self": true},
                {"id": 4, "peer_uuid": "sat", "peer_label": "PC3", "peer_secret": "s-sat"}
            ],
        })
    }

    fn push(c: &mut rusqlite::Connection, snap: &Value, hosted: bool) -> AdoptOutcome {
        let tx = c.transaction().unwrap();
        let outcome = adopt_peer_snapshot(&tx, snap, 1, hosted).unwrap();
        if outcome.applied {
            tx.commit().unwrap();
        }
        outcome
    }

    /// The mother: self row 1, satellite "sat" known as device 2, and its own
    /// game 7 "live-uuid" RUNNING with team 3, quest 9 and punch 5.
    fn seed_mother(c: &rusqlite::Connection) {
        c.execute_batch(
            "INSERT INTO schema_meta VALUES ('client_device_uuid', 'mother'), ('lg_state_version', '3');
             INSERT INTO paired_devices (id, peer_uuid, peer_label, peer_secret, is_self) VALUES
               (1, 'mother', 'PC2', 's-mother', 1), (2, 'sat', 'PC3', 's-sat-here', 0);
             INSERT INTO lg_launched_games (id, summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, duration)
               VALUES (7, 'live-uuid', 1, 'g', 'live', 1, 'quest', 0);
             INSERT INTO lg_launched_game_raw_data (id, launched_game_id, device_id, raw_data) VALUES (5, 7, 2, 'live-raw');
             INSERT INTO lg_teams (id, launched_game_id, team_number, pattern) VALUES (3, 7, 1, 0);
             INSERT INTO lg_team_completed_quests (id, launched_game_id, team_id, quest_number) VALUES (9, 7, 3, 'q');",
        )
        .unwrap();
    }

    #[test]
    fn ended_game_from_substitute_lands_without_touching_the_live_game() {
        let mut c = db();
        seed_mother(&c);
        let out = push(&mut c, &substitute_bundle(true), true);
        assert!(out.applied, "{}", out.reason);
        assert!(out.ended);
        assert_eq!(out.mother_epoch, 2);
        assert_ne!(out.game_id, 7, "the id is taken by the running game");

        // The running game is exactly where satellites address it.
        assert_eq!(one::<String>(&c, "SELECT summary_uuid FROM lg_launched_games WHERE id = 7"), "live-uuid");
        assert_eq!(one::<i64>(&c, "SELECT launched_game_id FROM lg_teams WHERE id = 3"), 7);
        assert_eq!(one::<String>(&c, "SELECT raw_data FROM lg_launched_game_raw_data WHERE id = 5"), "live-raw");
        assert_eq!(one::<i64>(&c, "SELECT team_id FROM lg_team_completed_quests WHERE id = 9"), 3);

        // The pushed game is complete: status, freeze moment, team, score, quest.
        let (ended, ended_at, version): (i64, i64, i64) = c
            .query_row(
                "SELECT ended, ended_at, state_version FROM lg_launched_games WHERE summary_uuid = 'sub-uuid'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((ended, ended_at, version), (1, 1700000000, 38));
        let (team, score): (i64, i64) = c
            .query_row("SELECT id, score FROM lg_teams WHERE launched_game_id = ?", [out.game_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_ne!(team, 3);
        assert_eq!(score, 25);
        let quest_team: i64 = c
            .query_row("SELECT team_id FROM lg_team_completed_quests WHERE launched_game_id = ?", [out.game_id], |r| r.get(0))
            .unwrap();
        assert_eq!(quest_team, team);

        // The punch is attributed to "sat" under ITS id here (2, not the pusher's 4).
        let device: i64 = c
            .query_row("SELECT device_id FROM lg_launched_game_raw_data WHERE launched_game_id = ?", [out.game_id], |r| r.get(0))
            .unwrap();
        assert_eq!(device, 2);
        assert_eq!(one::<String>(&c, "SELECT peer_secret FROM paired_devices WHERE id = 2"), "s-sat-here");
        // The device counter stepped past the bundle's.
        assert!(one::<String>(&c, "SELECT value FROM schema_meta WHERE key = 'lg_state_version'").parse::<i64>().unwrap() > 40);
        assert_eq!(one::<i64>(&c, "SELECT COUNT(*) FROM pragma_foreign_key_check"), 0);
    }

    #[test]
    fn frozen_copy_is_replaced_under_the_local_id() {
        // The mother's frozen copy of the SAME game: epoch 1, unfinished, id 12.
        let mut c = db();
        c.execute_batch(
            "INSERT INTO schema_meta VALUES ('client_device_uuid', 'mother');
             INSERT INTO lg_launched_games (id, summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, duration, launched_by_self)
               VALUES (12, 'sub-uuid', 1, 'g', 'frozen', 1, 'quest', 0, 1);
             INSERT INTO lg_teams (id, launched_game_id, team_number, pattern) VALUES (3, 12, 1, 0);",
        )
        .unwrap();
        // Not flagged hosted: the row exists, so the version alone decides.
        let out = push(&mut c, &substitute_bundle(true), false);
        assert!(out.applied, "{}", out.reason);
        assert_eq!(out.game_id, 12);
        assert_eq!(one::<i64>(&c, "SELECT COUNT(*) FROM lg_launched_games"), 1);
        let (name, ended, mine): (String, i64, i64) = c
            .query_row("SELECT name, ended, launched_by_self FROM lg_launched_games WHERE id = 12", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!((name.as_str(), ended, mine), ("from substitute", 1, 1));
        assert_eq!(one::<i64>(&c, "SELECT score FROM lg_teams WHERE launched_game_id = 12"), 25);

        // The same copy again is not newer: nothing to do.
        assert_eq!(push(&mut c, &substitute_bundle(true), false).reason, "not_newer");
    }

    #[test]
    fn unknown_game_needs_its_host() {
        let mut c = db();
        seed_mother(&c);
        assert_eq!(push(&mut c, &substitute_bundle(true), false).reason, "unknown_game");
        assert!(push(&mut c, &substitute_bundle(true), true).applied);
    }

    #[test]
    fn wrong_client_is_refused() {
        let mut c = db();
        let tx = c.transaction().unwrap();
        let out = adopt_peer_snapshot(&tx, &substitute_bundle(true), 99, true).unwrap();
        assert_eq!(out.reason, "wrong_client");
    }

    #[test]
    fn running_game_is_refused_when_it_would_renumber_a_live_one() {
        let mut c = db();
        seed_mother(&c);
        // Game 7 / team 3 / punch 5 / quest 9 all belong to the mother's running game.
        assert_eq!(push(&mut c, &substitute_bundle(false), true).reason, "id_collision_active");
        assert_eq!(one::<i64>(&c, "SELECT COUNT(*) FROM lg_launched_games"), 1);

        // Once that game is over, the pushed one comes in under its own ids
        // (satellites still address it by them) and at its own epoch.
        c.execute("UPDATE lg_launched_games SET ended = 1 WHERE id = 7", []).unwrap();
        let out = push(&mut c, &substitute_bundle(false), true);
        assert!(out.applied, "{}", out.reason);
        assert_eq!((out.game_id, out.mother_epoch), (7, 2));
        assert_eq!(one::<String>(&c, "SELECT summary_uuid FROM lg_launched_games WHERE id = 7"), "sub-uuid");
        assert_eq!(one::<i64>(&c, "SELECT mother_epoch FROM lg_launched_games WHERE id = 7"), 2);
        assert_ne!(one::<i64>(&c, "SELECT id FROM lg_launched_games WHERE summary_uuid = 'live-uuid'"), 7);
    }

    #[test]
    fn the_real_end_of_a_game_beats_a_cached_copy_adopted_earlier() {
        // The mother's frozen copy (epoch 1). A plain satellite arrives first
        // and offers the last state IT cached from the substitute: epoch 2,
        // still running. The mother takes it.
        let mut c = db();
        c.execute_batch(
            "INSERT INTO schema_meta VALUES ('client_device_uuid', 'mother');
             INSERT INTO lg_launched_games (id, summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, duration)
               VALUES (7, 'sub-uuid', 1, 'g', 'frozen', 1, 'quest', 0);",
        )
        .unwrap();
        assert!(push(&mut c, &substitute_bundle(false), false).applied);
        assert_eq!(one::<i64>(&c, "SELECT ended FROM lg_launched_games WHERE id = 7"), 0);

        // The mother then changes the game (its counter is past the copy's).
        let stamped = bump_state_version_sync(&c, Some(7)).unwrap();
        assert!(stamped > 38);

        // The substitute comes back later with the game as it really ended.
        // Same epoch, lower version - and it still wins: it is ended.
        let out = push(&mut c, &substitute_bundle(true), true);
        assert!(out.applied, "{}", out.reason);
        assert_eq!(one::<i64>(&c, "SELECT ended FROM lg_launched_games WHERE id = 7"), 1);
        assert_eq!(one::<i64>(&c, "SELECT score FROM lg_teams WHERE launched_game_id = 7"), 25);
    }

    #[test]
    fn tombstone_blocks_an_older_copy_only() {
        let mut c = db();
        seed_mother(&c);
        // The mother deleted this game at epoch 2 / version 38: the same copy
        // must not come back.
        c.execute(
            "INSERT INTO lg_game_tombstones (summary_uuid, kind, mother_epoch, state_version) VALUES ('sub-uuid', 'deleted', 2, 38)",
            [],
        )
        .unwrap();
        assert_eq!(push(&mut c, &substitute_bundle(true), true).reason, "tombstoned");

        // It dropped its FROZEN copy (epoch 1); the substitute's later one returns.
        c.execute("UPDATE lg_game_tombstones SET mother_epoch = 1", []).unwrap();
        assert!(push(&mut c, &substitute_bundle(true), true).applied);
        assert_eq!(one::<i64>(&c, "SELECT COUNT(*) FROM lg_game_tombstones"), 0);
    }

    #[test]
    fn tombstone_records_the_version_thrown_away() {
        let c = db();
        seed_mother(&c);
        c.execute("UPDATE lg_launched_games SET mother_epoch = 4, state_version = 17 WHERE id = 7", []).unwrap();
        write_tombstone(&c, 7, "archived").unwrap();
        let (kind, epoch, version): (String, i64, i64) = c
            .query_row(
                "SELECT kind, mother_epoch, state_version FROM lg_game_tombstones WHERE summary_uuid = 'live-uuid'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((kind.as_str(), epoch, version), ("archived", 4, 17));
    }

    #[test]
    fn a_device_never_seen_gets_a_row_and_self_is_recognised() {
        // The puller is "sat" itself, with an empty pairing table.
        let mut c = db();
        c.execute("INSERT INTO schema_meta VALUES ('client_device_uuid', 'sat')", []).unwrap();
        let out = push(&mut c, &substitute_bundle(true), true);
        assert!(out.applied, "{}", out.reason);
        let (id, is_self): (i64, i64) = c
            .query_row("SELECT id, is_self FROM paired_devices WHERE peer_uuid = 'sat'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(is_self, 1);
        assert_eq!(one::<i64>(&c, "SELECT device_id FROM lg_launched_game_devices"), id);
        // "sub" is referenced by nothing in the game: no row for it.
        assert_eq!(one::<i64>(&c, "SELECT COUNT(*) FROM paired_devices"), 1);
    }

    #[test]
    fn version_stamp_follows_the_game_an_action_touches() {
        let c = db();
        seed_mother(&c);
        assert_eq!(bump_state_version_sync(&c, Some(7)).unwrap(), 4);
        assert_eq!(one::<i64>(&c, "SELECT state_version FROM lg_launched_games WHERE id = 7"), 4);
        // No game (a pairing change): the counter moves, no game is stamped.
        assert_eq!(bump_state_version_sync(&c, None).unwrap(), 5);
        assert_eq!(one::<i64>(&c, "SELECT state_version FROM lg_launched_games WHERE id = 7"), 4);

        assert_eq!(stamp_field("end_game"), Some("id"));
        assert_eq!(stamp_field("delete_team"), Some("team_id"));
        assert_eq!(stamp_field("record_punch"), Some("launched_game_id"));
        // The row is gone after these two; `create` reads the id from its reply.
        assert_eq!(stamp_field("delete_game"), None);
        assert_eq!(stamp_field("archive_game"), None);
        assert_eq!(stamp_field("create"), None);
    }

    #[test]
    fn built_bundle_round_trips() {
        let c = db();
        seed_mother(&c);
        c.execute(
            "UPDATE lg_launched_games SET ended = 1, ended_at = 1700000123, mother_epoch = 2, state_version = 9 WHERE id = 7",
            [],
        )
        .unwrap();
        c.execute("UPDATE lg_teams SET score = 25, team_name = 'Midnight' WHERE id = 3", []).unwrap();
        let bundle = build_snapshot_sync(&c, "mother", 7, 11).unwrap().expect("game exists");
        let rows = parse_snapshot_rows(&bundle).unwrap();
        assert_eq!((rows.mother_epoch, rows.game.ended, rows.game.ended_at), (2, true, Some(1700000123)));
        // The game's own version travels apart from the device counter.
        assert_eq!((rows.game.state_version, rows.state_version), (9, 11));
        assert_eq!(rows.teams[0].score, 25);

        // Into an empty device: it comes out identical.
        let mut other = db();
        assert!(push(&mut other, &bundle, true).applied);
        assert_eq!(one::<i64>(&other, "SELECT score FROM lg_teams"), 25);
        assert_eq!(one::<i64>(&other, "SELECT ended_at FROM lg_launched_games"), 1700000123);
    }

    #[test]
    fn sqlite_reads_json_inside_cached_snapshots() {
        // `client_reconcile_with_mother` identifies a cached snapshot's game with
        // json_extract: it must be compiled into the SQLite this build links.
        let c = db();
        c.execute_batch(
            "CREATE TABLE mother_snapshots (launched_game_id INTEGER PRIMARY KEY, state_version INTEGER NOT NULL,
               mother_epoch INTEGER NOT NULL, snapshot_json TEXT NOT NULL);",
        )
        .unwrap();
        c.execute(
            "INSERT INTO mother_snapshots VALUES (7, 40, 2, ?1)",
            params![substitute_bundle(true).to_string()],
        )
        .unwrap();
        let (uuid, ended, version): (String, i64, i64) = c
            .query_row(
                "SELECT json_extract(snapshot_json, '$.game.summary_uuid'),
                        COALESCE(json_extract(snapshot_json, '$.game.ended'), 0),
                        COALESCE(json_extract(snapshot_json, '$.game.state_version'), state_version)
                   FROM mother_snapshots WHERE json_extract(snapshot_json, '$.game.client_id') = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((uuid.as_str(), ended, version), ("sub-uuid", 1, 38));
    }

    #[test]
    fn role_decides_who_stands_down() {
        use HostRole::{Mother, Substitute};
        // A substitute never competes with a server already up.
        assert!(must_stand_down(Substitute, 0, "a", Some("s"), None, "b"));
        assert!(must_stand_down(Substitute, 0, "a", Some("m"), Some(5), "b"));
        // The mother starts over a substitute, whatever the boot order.
        assert!(!must_stand_down(Mother, 0, "b", Some("s"), None, "a"));
        // Two mothers: the later designation keeps the role.
        assert!(must_stand_down(Mother, 100, "a", Some("m"), Some(200), "b"));
        assert!(!must_stand_down(Mother, 200, "b", Some("m"), Some(100), "a"));
        // No date on either side: exactly one of the two serves.
        assert!(must_stand_down(Mother, 0, "b", Some("m"), Some(0), "a"));
        assert!(!must_stand_down(Mother, 0, "a", Some("m"), Some(0), "b"));
        // A build without roles: first one up wins, as before.
        assert!(must_stand_down(Mother, 100, "a", None, None, "b"));
    }
}

#[cfg(test)]
mod lan_proto_tests {
    use super::*;

    #[test]
    fn designated_addrs_keep_only_routable_lan() {
        let got = designated_lan_addrs(&[
            "192.168.1.20".into(),
            "169.254.3.4".into(),
            "127.0.0.1".into(),
            "192.168.137.1".into(),
            "10.0.0.5".into(),
        ]);
        assert_eq!(got, vec!["192.168.1.20".to_string(), "10.0.0.5".to_string()]);
    }

    #[test]
    fn missing_lan_proto_means_hotspot_era() {
        assert_eq!(announced_proto(&json!({ "mother_uuid": "x" })), 1);
        assert_eq!(announced_proto(&json!({ "lan_proto": LAN_PROTO })), LAN_PROTO);
    }
}

/// Pushes this device's "Operator only device" setting (see OperatorPresence).
#[tauri::command]
pub async fn client_set_operator_only(
    presence: tauri::State<'_, OperatorPresence>,
    operator_only: bool,
) -> Result<(), String> {
    *presence.inner.lock().await = operator_only;
    Ok(())
}

#[cfg(test)]
mod clash_purge_tests {
    use super::*;

    fn terr(index: i64, points: i64) -> ClashTerr {
        ClashTerr { index, points, balises: vec![], balise_numbers: vec![] }
    }

    #[test]
    fn order_is_leader_count_then_points_and_skips_unvalidated() {
        let ts = [terr(0, 2), terr(1, 4), terr(2, 6), terr(3, 8)];
        // Leader counts: t0=3, t1=1, t2=3, t3=0.
        let counts = |i: i64| [3, 1, 3, 0][i as usize];
        // t0 and t2 tie on count; t2 pays more ⇒ first. t3 has no validation ⇒ out.
        assert_eq!(clash_purge_order(&ts, 1, counts), vec![2, 0, 1]);
    }

    #[test]
    fn full_tie_pick_is_stable_and_keeps_every_candidate() {
        let ts = [terr(0, 5), terr(1, 5), terr(2, 5)];
        let a = clash_purge_order(&ts, 42, |_| 2);
        assert_eq!(a, clash_purge_order(&ts, 42, |_| 2));
        let mut sorted = a.clone();
        sorted.sort();
        assert_eq!(sorted, vec![0, 1, 2]);
        // The ones after the deterministic lead stay in index order.
        assert!(a[1] < a[2]);
    }

    #[test]
    fn purge_never_hits_the_purgers_own_territory() {
        let order = [2, 0, 1];
        let owner = |i: i64| match i {
            2 => Some(7),
            0 => Some(9),
            _ => None,
        };
        // Clan 7 owns the displayed target (2): it is retargeted to 0.
        assert_eq!(clash_purge_pick(&order, owner, 7), Ok(0));
        // Clan 9 does not own 2: it hits the displayed target.
        assert_eq!(clash_purge_pick(&order, owner, 9), Ok(2));
        // Only own territories left: refused (quota kept).
        assert_eq!(clash_purge_pick(&[2], owner, 7), Err("own_territory"));
        assert_eq!(clash_purge_pick(&[], owner, 7), Err("no_target"));
    }

    #[test]
    fn refused_purge_punch_stays_pending() {
        // Bug report #3: a punch refused at 0-0 must stay usable later.
        assert!(purge_consumes("ok"));
        assert!(purge_consumes("already_used"));
        assert!(!purge_consumes("no_target"));
        assert!(!purge_consumes("own_territory"));
        // The pending marker can never collide with a real punch key.
        assert_ne!(format!("{PURGE_SEEN_PREFIX}55@15:31:02"), "55@15:31:02");
    }

    #[test]
    fn baseline_consumes_every_punch_already_on_the_card() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE lg_clash_consumed (id INTEGER PRIMARY KEY AUTOINCREMENT,
               launched_game_id INTEGER NOT NULL, chip_id INTEGER NOT NULL,
               punch_key TEXT NOT NULL, UNIQUE(launched_game_id, chip_id, punch_key));",
        )
        .unwrap();
        let body = serde_json::json!({ "punches": [
            { "code": 55, "time": "15:31:02" },
            { "station": 31, "time": "15:32:28" },
            { "code": 31, "time": "15:32:28" }
        ]});
        let punches = parse_clash_punches(&body);
        assert_eq!(punches.len(), 3);
        clash_consume_baseline(&c, 8, 1915788, &punches).unwrap();
        let keys: Vec<String> = c
            .prepare("SELECT punch_key FROM lg_clash_consumed ORDER BY punch_key")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(keys, vec!["31@15:32:28", "55@15:31:02"]);
        // No punches sent (operator / TagQuest / old client) ⇒ nothing recorded.
        assert!(parse_clash_punches(&serde_json::json!({})).is_empty());
    }
}

#[cfg(test)]
mod customer_tests {
    use super::*;

    const SCHEMA: &str = r#"
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE lg_launched_games (
            id INTEGER PRIMARY KEY AUTOINCREMENT, summary_uuid TEXT NOT NULL UNIQUE,
            client_id INTEGER NOT NULL, game_uniqid TEXT NOT NULL, name TEXT NOT NULL,
            number_of_teams INTEGER NOT NULL, game_type TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0,
            start_time TEXT NULL, started INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), state_version INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE lg_launched_game_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            meta_name TEXT NOT NULL, meta_value TEXT NULL);
        CREATE TABLE lg_teams (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            team_number INTEGER NOT NULL, pattern INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0,
            start_time INTEGER NULL, end_time INTEGER NULL);
        CREATE TABLE lg_team_completed_quests (id INTEGER PRIMARY KEY AUTOINCREMENT, launched_game_id INTEGER NOT NULL,
            team_id INTEGER NOT NULL, teammate_chip_id INTEGER NULL, quest_number TEXT NOT NULL DEFAULT 'q');
        CREATE TABLE lg_game_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, summary_uuid TEXT NOT NULL UNIQUE,
            launched_game_id INTEGER NULL, client_id INTEGER NOT NULL, game_uniqid TEXT NOT NULL, name TEXT NOT NULL,
            game_type TEXT NOT NULL, played_at TEXT NULL, teams_launched INTEGER NULL, teams_played INTEGER NOT NULL,
            players_played INTEGER NOT NULL, content_hash TEXT NULL, pushed_at TEXT NULL, archived_at TEXT NULL,
            created_at TEXT NULL, updated_at TEXT NULL, customer_id TEXT NULL, customer_name TEXT NULL,
            customer_assigned_at TEXT NULL, customer_dirty INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE customers (id TEXT PRIMARY KEY, client_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NULL,
            city TEXT NULL, archived INTEGER NOT NULL DEFAULT 0, merged_into_id TEXT NULL,
            deleted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT 'studio', pushed_at TEXT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE customer_games (summary_uuid TEXT PRIMARY KEY, client_id INTEGER NOT NULL, customer_id TEXT NULL,
            game_uniqid TEXT NULL, played_at TEXT NULL, customer_assigned_at TEXT NULL);
        CREATE TABLE customers_state (client_id INTEGER PRIMARY KEY, remote_version REAL, local_version REAL,
            fetched_at TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0);
    "#;

    const ACME: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const BETA: &str = "bbbbbbbb-0000-4000-8000-000000000002";
    const NOW: &str = "2026-10-15 10:00:00";

    fn db() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute(
            "INSERT INTO customers (id, client_id, name) VALUES (?1, 1, 'Acme'), (?2, 1, 'Beta')",
            params![ACME, BETA],
        )
        .unwrap();
        c
    }

    /// An ended, played game (one team with start/end/score) on scenario `uniqid`.
    fn played_game(c: &rusqlite::Connection, uuid: &str, uniqid: &str) -> i64 {
        c.execute(
            "INSERT INTO lg_launched_games (summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, start_time, started, ended)
             VALUES (?1, 1, ?2, 'g', 1, 'quest', '2026-10-01 14:00:00', 1, 1)",
            params![uuid, uniqid],
        )
        .unwrap();
        let id = c.last_insert_rowid();
        c.execute(
            "INSERT INTO lg_teams (launched_game_id, team_number, score, start_time, end_time) VALUES (?1, 1, 10, 1, 2)",
            params![id],
        )
        .unwrap();
        id
    }

    fn summarise(c: &rusqlite::Connection, id: i64) {
        let s = compute_summary(c, id).unwrap().expect("eligible");
        upsert_summary(c, id, &s, NOW).unwrap();
    }

    fn one<T: rusqlite::types::FromSql>(c: &rusqlite::Connection, sql: &str) -> T {
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn meta_customer_reaches_summary_and_reassign_marks_dirty() {
        let c = db();
        let id = played_game(&c, "g1", "scn");
        assign_customer_sync(&c, 1, "g1", Some(ACME), None, "2026-10-15T09:00:00.000Z").unwrap();
        assert_eq!(meta_customer(&c, id).unwrap().1.as_deref(), Some("Acme"));
        summarise(&c, id);
        assert_eq!(one::<String>(&c, "SELECT customer_id FROM lg_game_summaries"), ACME);
        assert_eq!(one::<i64>(&c, "SELECT customer_dirty FROM lg_game_summaries"), 0);
        // Reassign after the summary exists: summary updated + dirty for re-push.
        assign_customer_sync(&c, 1, "g1", Some(BETA), None, "2026-10-15T09:05:00.000Z").unwrap();
        assert_eq!(one::<String>(&c, "SELECT customer_name FROM lg_game_summaries"), "Beta");
        assert_eq!(one::<i64>(&c, "SELECT customer_dirty FROM lg_game_summaries"), 1);
        // A recompute with the same meta changes nothing.
        c.execute("UPDATE lg_game_summaries SET customer_dirty = 0", []).unwrap();
        summarise(&c, id);
        assert_eq!(one::<i64>(&c, "SELECT customer_dirty FROM lg_game_summaries"), 0);
    }

    #[test]
    fn detach_is_timestamped() {
        let c = db();
        let id = played_game(&c, "g1", "scn");
        assign_customer_sync(&c, 1, "g1", Some(ACME), None, "2026-10-15T09:00:00.000Z").unwrap();
        assign_customer_sync(&c, 1, "g1", None, None, "2026-10-15T09:01:00.000Z").unwrap();
        let (cid, _, at) = meta_customer(&c, id).unwrap();
        assert_eq!(cid, None);
        assert_eq!(at.as_deref(), Some("2026-10-15T09:01:00.000Z"));
    }

    #[test]
    fn update_meta_style_rewrite_keeps_customer() {
        let c = db();
        let id = played_game(&c, "g1", "scn");
        assign_customer_sync(&c, 1, "g1", Some(ACME), None, "2026-10-15T09:00:00.000Z").unwrap();
        assert!(is_customer_meta_key("customerId") && !is_customer_meta_key("teamsConfig"));
        // What update_meta does: wipe everything but the customer keys.
        c.execute(
            "DELETE FROM lg_launched_game_meta WHERE launched_game_id = ?1
               AND meta_name NOT IN ('customerId', 'customerName', 'customerAssignedAt')",
            params![id],
        )
        .unwrap();
        assert_eq!(meta_customer(&c, id).unwrap().0.as_deref(), Some(ACME));
    }

    #[test]
    fn flow_back_adopts_newer_studio_value_without_dirty() {
        let c = db();
        let id = played_game(&c, "g1", "scn");
        assign_customer_sync(&c, 1, "g1", Some(ACME), None, "2026-10-15T09:00:00.000Z").unwrap();
        summarise(&c, id);
        c.execute("UPDATE lg_game_summaries SET pushed_at = 'x', customer_dirty = 0", []).unwrap();
        c.execute(
            "INSERT INTO customer_games VALUES ('g1', 1, ?1, 'scn', '2026-10-01 14:00:00', '2026-10-15T09:30:00.000Z')",
            params![BETA],
        )
        .unwrap();
        assert_eq!(flow_back_customer_assignments(&c, 1).unwrap(), 1);
        assert_eq!(one::<String>(&c, "SELECT customer_id FROM lg_game_summaries"), BETA);
        assert_eq!(one::<i64>(&c, "SELECT customer_dirty FROM lg_game_summaries"), 0);
        assert_eq!(one::<String>(&c, "SELECT pushed_at FROM lg_game_summaries"), "x");
        assert_eq!(meta_customer(&c, id).unwrap().0.as_deref(), Some(BETA));
        // Recompute after flow-back: no dirty (no echo to studio).
        summarise(&c, id);
        assert_eq!(one::<i64>(&c, "SELECT customer_dirty FROM lg_game_summaries"), 0);
        // Idempotent.
        assert_eq!(flow_back_customer_assignments(&c, 1).unwrap(), 0);
    }

    #[test]
    fn flow_back_ignores_older_studio_value() {
        let c = db();
        let id = played_game(&c, "g1", "scn");
        assign_customer_sync(&c, 1, "g1", Some(ACME), None, "2026-10-15T09:00:00.000Z").unwrap();
        summarise(&c, id);
        c.execute(
            "INSERT INTO customer_games VALUES ('g1', 1, ?1, 'scn', NULL, '2026-10-15T08:00:00.000Z')",
            params![BETA],
        )
        .unwrap();
        assert_eq!(flow_back_customer_assignments(&c, 1).unwrap(), 0);
        assert_eq!(one::<String>(&c, "SELECT customer_id FROM lg_game_summaries"), ACME);
    }

    #[test]
    fn assign_on_archived_summary_marks_dirty() {
        let c = db();
        let id = played_game(&c, "g1", "scn");
        summarise(&c, id);
        c.execute("UPDATE lg_game_summaries SET pushed_at = 'x', archived_at = 'y'", []).unwrap();
        c.execute("DELETE FROM lg_launched_games", []).unwrap();
        assert!(assign_customer_sync(&c, 1, "g1", Some(ACME), None, "2026-10-15T09:00:00.000Z").unwrap());
        assert_eq!(one::<i64>(&c, "SELECT customer_dirty FROM lg_game_summaries"), 1);
        assert!(!assign_customer_sync(&c, 1, "nope", Some(ACME), None, "2026-10-15T09:00:00.000Z").unwrap());
    }

    #[test]
    fn played_dedupes_by_game_and_follows_merges() {
        let c = db();
        // g1: local summary (Acme) AND studio view (newer, Beta) -> counts once, for Beta.
        let g1 = played_game(&c, "g1", "scn1");
        assign_customer_sync(&c, 1, "g1", Some(ACME), None, "2026-10-15T09:00:00.000Z").unwrap();
        summarise(&c, g1);
        c.execute(
            "INSERT INTO customer_games VALUES ('g1', 1, ?1, 'scn1', '2026-10-01 14:00:00', '2026-10-15T09:30:00.000Z')",
            params![BETA],
        )
        .unwrap();
        // g2: studio-only game on scn1 for Acme, which studio since merged into Beta.
        c.execute(
            "INSERT INTO customer_games VALUES ('g2', 1, ?1, 'scn1', '2026-09-01 10:00:00', '2026-09-01T10:00:00.000Z')",
            params![ACME],
        )
        .unwrap();
        c.execute("UPDATE customers SET merged_into_id = ?1 WHERE id = ?2", params![BETA, ACME]).unwrap();
        // g3: running game for Beta on scn2; g4: running TEST game - ignored.
        c.execute(
            "INSERT INTO lg_launched_games (summary_uuid, client_id, game_uniqid, name, number_of_teams, game_type, start_time, started, ended)
             VALUES ('g3', 1, 'scn2', 'g', 1, 'quest', '2026-10-15 09:00:00', 1, 0),
                    ('g4', 1, 'scn3', 'g', 1, 'quest', '2026-10-15 09:00:00', 1, 0)",
            [],
        )
        .unwrap();
        assign_customer_sync(&c, 1, "g3", Some(BETA), None, "2026-10-15T09:10:00.000Z").unwrap();
        assign_customer_sync(&c, 1, "g4", Some(BETA), None, "2026-10-15T09:10:00.000Z").unwrap();
        let g4: i64 = one(&c, "SELECT id FROM lg_launched_games WHERE summary_uuid = 'g4'");
        c.execute(
            "INSERT INTO lg_launched_game_meta (launched_game_id, meta_name, meta_value) VALUES (?1, 'testMode', 'true')",
            params![g4],
        )
        .unwrap();

        let v = customers_list_sync(&c, 1).unwrap();
        let ids: Vec<&str> = v["customers"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec![BETA], "merged Acme is not listed");
        assert_eq!(v["redirects"][ACME], json!(BETA));
        let mut played: Vec<(String, i64)> = v["played"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                assert_eq!(p["customer_id"], json!(BETA));
                (p["game_uniqid"].as_str().unwrap().to_string(), p["count"].as_i64().unwrap())
            })
            .collect();
        played.sort();
        assert_eq!(played, vec![("scn1".to_string(), 2), ("scn2".to_string(), 1)]);
        assert_eq!(v["cloud_supported"], json!(false));
    }

    #[test]
    fn uuid_check() {
        assert!(looks_like_uuid(ACME));
        assert!(!looks_like_uuid("aaaaaaaa-0000-4000-8000-00000000000"));
        assert!(!looks_like_uuid("zaaaaaaa-0000-4000-8000-000000000001"));
    }
}
