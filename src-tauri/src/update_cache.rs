//! App installer cache, shared over the LAN so devices can update without
//! internet.
//!
//! `<app_data>/updates/cache/<platform>/` (`windows-x86_64`, `android`, ...)
//! holds exactly ONE installer plus `release.json`: the newest this device got
//! (from the studio, from its mother, or pushed by a satellite). It is also the
//! staging area of an update: "Download" fills it, "Restart" installs from it,
//! so a staged update survives a restart.
//!
//! Safety: desktop installers are minisign-signed; the updater plugin checks
//! the signature against the key in tauri.conf.json before installing, and a
//! mother checks it before accepting a pushed installer. Android refuses an
//! APK signed with another key, and the APK's sha256 travels with it.
//!
//! LAN surface: GET `/update.php` on the mother's server (no bearer, exempt
//! from the LAN protocol gate - an outdated device must be able to update
//! from it), mirroring the studio's `playground_update.php` shapes. A
//! satellite pushes a newer installer it holds through `/content.php?action=
//! put_installer` (authenticated, content_server.rs).

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio_util::io::ReaderStream;

pub(crate) const ANDROID: &str = "android";
pub(crate) const UPDATE_CACHED_EVENT: &str = "taghunter://update-cached";
const META_FILE: &str = "release.json";
const STREAM_CHUNK: usize = 64 * 1024;
/// Installers are tens of MB; an APK pushed by a satellite is buffered for
/// nothing but its hash, a desktop installer for its signature check.
const MAX_INSTALLER_BYTES: u64 = 600 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ReleaseMeta {
    pub version: String,
    /// The build's own channel: `stable` or `test`.
    pub channel: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub pub_date: Option<String>,
    /// Desktop: the minisign signature (base64), as in the studio manifest.
    #[serde(default)]
    pub signature: Option<String>,
    /// Android: the APK's sha256.
    #[serde(default)]
    pub sha256: Option<String>,
    pub size: u64,
    #[serde(default)]
    pub min_supported_version: Option<String>,
    pub filename: String,
    /// `cloud`, `mother` or `peer` - informational.
    #[serde(default)]
    pub fetched_from: String,
    #[serde(default)]
    pub fetched_at: i64,
}

// ─── helpers ────────────────────────────────────────────────────────────────

/// This build's key in the studio manifest's `platforms` map ("windows-x86_64").
pub(crate) fn desktop_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86" => "i686",
        "arm" => "armv7",
        other => other,
    };
    format!("{os}-{arch}")
}

pub(crate) fn this_platform() -> String {
    if cfg!(target_os = "android") {
        ANDROID.to_string()
    } else {
        desktop_platform()
    }
}

/// Every installer the cache holds, `[{platform, version, channel}]`: what this
/// device, as a mother, can hand its satellites (Devices modal upkeep).
pub(crate) fn cached_installers(app: &AppHandle) -> Value {
    let Ok(root) = cache_root(app) else {
        return json!([]);
    };
    let Ok(dirs) = std::fs::read_dir(&root) else {
        return json!([]);
    };
    let out: Vec<Value> = dirs
        .flatten()
        .filter_map(|e| {
            let platform = e.file_name().to_string_lossy().to_string();
            let meta = read_meta(&root, &platform)?;
            Some(json!({ "platform": platform, "version": meta.version, "channel": meta.channel }))
        })
        .collect();
    Value::Array(out)
}

fn is_safe_platform(p: &str) -> bool {
    !p.is_empty() && p.len() <= 40 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':', '\0'])
        && name != META_FILE
}

pub(crate) fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("updates")
        .join("cache"))
}

pub(crate) fn read_meta(root: &Path, platform: &str) -> Option<ReleaseMeta> {
    if !is_safe_platform(platform) {
        return None;
    }
    let text = std::fs::read_to_string(root.join(platform).join(META_FILE)).ok()?;
    let meta: ReleaseMeta = serde_json::from_str(&text).ok()?;
    if !is_safe_filename(&meta.filename) {
        return None;
    }
    // A meta whose installer is gone (or truncated) is not an offer.
    let len = std::fs::metadata(root.join(platform).join(&meta.filename)).ok()?.len();
    (len == meta.size).then_some(meta)
}

fn installer_path(root: &Path, platform: &str, meta: &ReleaseMeta) -> PathBuf {
    root.join(platform).join(&meta.filename)
}

/// Numeric x.y.z comparison (pre-release tags ignored), like the renderer's.
pub(crate) fn semver_cmp(a: &str, b: &str) -> Ordering {
    let parse = |v: &str| -> [u64; 3] {
        let mut out = [0u64; 3];
        for (i, part) in v.trim().split('.').take(3).enumerate() {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            out[i] = digits.parse().unwrap_or(0);
        }
        out
    };
    parse(a).cmp(&parse(b))
}

/// A device on `requester`'s channel may take a `build` from that channel; a
/// tester may also take a stable build (the studio's own fallback).
pub(crate) fn channel_ok(requester: &str, build: &str) -> bool {
    requester == build || (requester == "test" && build == "stable")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Put a verified installer (`src`, anywhere on the same volume) into the cache.
/// Newest wins: an older or equal version than the cached one is dropped.
/// Returns false when it wasn't kept.
pub(crate) fn commit(root: &Path, platform: &str, src: &Path, meta: &ReleaseMeta) -> Result<bool, String> {
    if !is_safe_platform(platform) || !is_safe_filename(&meta.filename) {
        let _ = std::fs::remove_file(src);
        return Err("invalid platform or file name".into());
    }
    if let Some(cur) = read_meta(root, platform) {
        if semver_cmp(&meta.version, &cur.version) != Ordering::Greater {
            let _ = std::fs::remove_file(src);
            return Ok(false);
        }
    }
    let dir = root.join(platform);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cache dir: {e}"))?;
    // Exactly one installer per platform: everything else goes.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.path() != src {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let dest = dir.join(&meta.filename);
    if std::fs::rename(src, &dest).is_err() {
        std::fs::copy(src, &dest).map_err(|e| format!("copy installer: {e}"))?;
        let _ = std::fs::remove_file(src);
    }
    let tmp = dir.join("release.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write meta: {e}"))?;
    std::fs::rename(&tmp, dir.join(META_FILE)).map_err(|e| format!("rename meta: {e}"))?;
    Ok(true)
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

/// The updater public key from tauri.conf.json (base64 of minisign's text form).
fn updater_pubkey(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(str::to_string)
}

/// Same check as tauri-plugin-updater's `verify_signature`. Returns the
/// signature's trusted comment (signed too, so it can be relied on).
fn verify_minisign(data: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<String, String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk_text = String::from_utf8(b64.decode(pubkey_b64).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let sig_text = String::from_utf8(b64.decode(signature_b64).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let pk = minisign_verify::PublicKey::decode(&pk_text).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&sig_text).map_err(|e| e.to_string())?;
    pk.verify(data, &sig, true).map_err(|e| format!("signature: {e}"))?;
    Ok(sig_text
        .lines()
        .find_map(|l| l.strip_prefix("trusted comment:"))
        .unwrap_or("")
        .trim()
        .to_string())
}

/// The signed artifact's file name (Tauri's signer writes `file:<name>` in
/// the trusted comment) must carry the version the pusher claims: otherwise
/// any old signed build could be passed off as a newer one. Fields are
/// tab-separated and the name keeps its spaces ("Tag Hunter Playground_…").
fn signed_name_matches(trusted_comment: &str, version: &str) -> bool {
    let Some(name) = trusted_comment.split('\t').find_map(|w| w.trim().strip_prefix("file:")) else {
        return false;
    };
    name.contains(&format!("_{version}_")) || name.contains(&format!("-{version}-")) || name.contains(&format!("_{version}."))
}

/// Check a received installer file against its meta (signature or sha256).
fn verify_installer(app: &AppHandle, platform: &str, path: &Path, meta: &ReleaseMeta) -> Result<(), String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len != meta.size {
        return Err(format!("size {len} != {}", meta.size));
    }
    if platform == ANDROID {
        let want = meta.sha256.as_deref().ok_or("sha256 missing")?;
        let got = sha256_of(path).map_err(|e| e.to_string())?;
        return if got == want { Ok(()) } else { Err("sha256 mismatch".into()) };
    }
    let sig = meta.signature.as_deref().ok_or("signature missing")?;
    let key = updater_pubkey(app).ok_or("updater key missing")?;
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let comment = verify_minisign(&data, sig, &key)?;
    if !signed_name_matches(&comment, &meta.version) {
        return Err(format!("signed build is not version {}", meta.version));
    }
    Ok(())
}

/// This device's resolved update channel (auth_user.update_channel).
async fn device_channel(app: &AppHandle) -> String {
    let Ok(conn) = crate::lan_server::open_db_for_command(app).await else {
        return "stable".into();
    };
    conn.call(|c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(c.query_row("SELECT update_channel FROM auth_user LIMIT 1", [], |r| r.get(0)).optional()?)
    })
    .await
    .ok()
    .flatten()
    .filter(|c| c == "test")
    .unwrap_or_else(|| "stable".into())
}

/// A per-call temp name: two writers (a prefetch and a push) never share one.
fn incoming_path(root: &Path, platform: &str) -> PathBuf {
    root.join(".incoming").join(format!("{platform}-{}.part", uuid::Uuid::new_v4()))
}

// ─── LAN: GET /update.php ───────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct UpdateState {
    root: PathBuf,
    slots: Arc<Semaphore>,
}

/// The `/update.php` routes, ready to merge into any router (the mother's LAN
/// server, or the one-shot loopback server an install from cache uses).
pub(crate) fn router<S: Clone + Send + Sync + 'static>(app: &AppHandle) -> Result<Router<S>, String> {
    let st = UpdateState { root: cache_root(app)?, slots: Arc::new(Semaphore::new(2)) };
    Ok(Router::new().route("/update.php", get(dispatch_update)).with_state(st))
}

#[derive(Deserialize)]
struct UpdQuery {
    action: Option<String>,
    target: Option<String>,
    arch: Option<String>,
    current_version: Option<String>,
    channel: Option<String>,
    platform: Option<String>,
}

fn platform_of(target: &str, arch: &str) -> String {
    if target == ANDROID {
        ANDROID.to_string()
    } else {
        format!("{target}-{arch}")
    }
}

/// What we can offer a device of `platform` on `channel` running `current`.
fn offer(root: &Path, platform: &str, channel: &str, current: &str) -> Option<ReleaseMeta> {
    let meta = read_meta(root, platform)?;
    (channel_ok(channel, &meta.channel) && semver_cmp(&meta.version, current) == Ordering::Greater).then_some(meta)
}

fn download_url(headers: &HeaderMap, platform: &str) -> String {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1");
    format!("http://{host}/update.php?action=download&platform={platform}")
}

async fn dispatch_update(State(st): State<UpdateState>, Query(q): Query<UpdQuery>, headers: HeaderMap) -> Response {
    let channel = match q.channel.as_deref() {
        Some("test") => "test",
        _ => "stable",
    };
    let current = q.current_version.as_deref().unwrap_or("0.0.0");
    match q.action.as_deref().unwrap_or("") {
        // The updater plugin's format; 204 = nothing newer for you here.
        "manifest" => {
            let (Some(target), Some(arch)) = (q.target.as_deref(), q.arch.as_deref()) else {
                return (StatusCode::BAD_REQUEST, "target and arch are required").into_response();
            };
            let platform = platform_of(target, arch);
            let Some(meta) = offer(&st.root, &platform, channel, current) else {
                return StatusCode::NO_CONTENT.into_response();
            };
            let Some(sig) = meta.signature.clone() else {
                return StatusCode::NO_CONTENT.into_response();
            };
            let mut body = json!({
                "version": meta.version,
                "notes": meta.notes,
                "min_supported_version": meta.min_supported_version,
                "channel": meta.channel,
                "platforms": { platform.clone(): { "signature": sig, "url": download_url(&headers, &platform) } },
            });
            if let Some(d) = meta.pub_date {
                body["pub_date"] = json!(d);
            }
            Json(body).into_response()
        }
        // The studio's `check` shape (the renderer's update service parses it).
        "check" => {
            let (Some(target), Some(arch)) = (q.target.as_deref(), q.arch.as_deref()) else {
                return (StatusCode::BAD_REQUEST, "target and arch are required").into_response();
            };
            let platform = platform_of(target, arch);
            match offer(&st.root, &platform, channel, current) {
                None => Json(json!({ "available": false, "manifest": Value::Null })).into_response(),
                Some(meta) => {
                    let mut m = json!({
                        "version": meta.version,
                        "notes": meta.notes,
                        "pub_date": meta.pub_date,
                        "min_supported_version": meta.min_supported_version,
                        "channel": meta.channel,
                    });
                    if platform == ANDROID {
                        m["apk"] = json!({
                            "id": 0,
                            "url": download_url(&headers, &platform),
                            "sha256": meta.sha256,
                            "size": meta.size,
                        });
                    }
                    Json(json!({ "available": true, "manifest": m })).into_response()
                }
            }
        }
        "download" => {
            let Some(platform) = q.platform.as_deref().filter(|p| is_safe_platform(p)) else {
                return (StatusCode::BAD_REQUEST, "platform is required").into_response();
            };
            let Some(meta) = read_meta(&st.root, platform) else {
                return StatusCode::NOT_FOUND.into_response();
            };
            let Ok(permit) = st.slots.clone().try_acquire_owned() else {
                let mut r = StatusCode::SERVICE_UNAVAILABLE.into_response();
                r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
                return r;
            };
            stream_installer(installer_path(&st.root, platform, &meta), meta.size, &headers, permit).await
        }
        _ => (StatusCode::BAD_REQUEST, "unknown action").into_response(),
    }
}

async fn stream_installer(
    path: PathBuf,
    len: u64,
    headers: &HeaderMap,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let start = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().strip_prefix("bytes="))
        .and_then(|r| r.strip_suffix('-'))
        .and_then(|n| n.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if start > 0 && start >= len {
        return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    }
    let Ok(mut file) = tokio::fs::File::open(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let stream = ReaderStream::with_capacity(file, STREAM_CHUNK).map(move |c| {
        let _held = &permit;
        c
    });
    let mut b = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, len - start)
        .header(header::ACCEPT_RANGES, "bytes");
    b = if start > 0 {
        b.status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{}/{len}", len - 1))
    } else {
        b.status(StatusCode::OK)
    };
    b.body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

// ─── mother: receive an installer a satellite pushes ────────────────────────

/// Body of `/content.php?action=put_installer&platform=..&meta=<json>`: the
/// installer itself. Verified before it may replace our cached one.
pub(crate) async fn receive_installer(app: &AppHandle, platform: &str, meta: ReleaseMeta, body: Body) -> Result<bool, String> {
    if !is_safe_platform(platform) || !is_safe_filename(&meta.filename) || meta.size > MAX_INSTALLER_BYTES {
        return Err("invalid installer".into());
    }
    // We cache installers for OUR channel only: a tester's build must never
    // reach the stable devices this mother serves.
    let ours = device_channel(app).await;
    if !channel_ok(&ours, &meta.channel) {
        return Ok(false);
    }
    let root = cache_root(app)?;
    if let Some(cur) = read_meta(&root, platform) {
        if semver_cmp(&meta.version, &cur.version) != Ordering::Greater {
            return Ok(false);
        }
    }
    let tmp = incoming_path(&root, platform);
    if let Some(dir) = tmp.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    let mut written = 0u64;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        written += chunk.len() as u64;
        if written > meta.size {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err("installer larger than announced".into());
        }
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    let app2 = app.clone();
    let platform2 = platform.to_string();
    let tmp2 = tmp.clone();
    let mut meta2 = meta.clone();
    meta2.fetched_from = "peer".into();
    meta2.fetched_at = now_ms();
    let kept = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        if let Err(e) = verify_installer(&app2, &platform2, &tmp2, &meta2) {
            let _ = std::fs::remove_file(&tmp2);
            return Err(format!("rejected: {e}"));
        }
        commit(&cache_root(&app2)?, &platform2, &tmp2, &meta2)
    })
    .await
    .map_err(|e| e.to_string())??;
    if kept {
        // The renderer re-checks: this mother can now offer the update to
        // itself (offline it has no one else to ask).
        use tauri::Emitter;
        let _ = app.emit(UPDATE_CACHED_EVENT, &meta.version);
    }
    Ok(kept)
}

// ─── renderer commands ──────────────────────────────────────────────────────

/// What the cache holds: this device's own platform, and the Android APK a
/// Windows mother keeps for tablets.
#[tauri::command]
pub async fn update_cache_status(app: AppHandle) -> Result<Value, String> {
    let root = cache_root(&app)?;
    Ok(json!({
        "platform": this_platform(),
        "own": read_meta(&root, &this_platform()),
        "android": read_meta(&root, ANDROID),
    }))
}

/// Keep an APK the renderer downloaded (studio or mother) and verified.
/// `temp_path`: absolute path of the downloaded file (moved into the cache).
#[tauri::command]
pub async fn update_cache_commit_apk(app: AppHandle, temp_path: String, meta: ReleaseMeta) -> Result<bool, String> {
    let src = PathBuf::from(temp_path);
    let mut meta = meta;
    meta.fetched_at = now_ms();
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        if let Err(e) = verify_installer(&app, ANDROID, &src, &meta) {
            let _ = std::fs::remove_file(&src);
            return Err(e);
        }
        commit(&cache_root(&app)?, ANDROID, &src, &meta)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Boot cleanup: a cached installer for our platform no newer than the running
/// app is useless (we'd never install it, and serving it is a downgrade for no
/// one), and the updater plugin leaves every installer it ran in %TEMP%.
#[tauri::command]
pub async fn update_cache_prune(app: AppHandle) -> Result<(), String> {
    let root = cache_root(&app)?;
    let current = app.package_info().version.to_string();
    let name = app.package_info().name.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let platform = this_platform();
        let dir = root.join(&platform);
        match read_meta(&root, &platform) {
            Some(m) if semver_cmp(&m.version, &current) != Ordering::Less => {}
            Some(_) => {
                let _ = std::fs::remove_dir_all(&dir);
            }
            None => {}
        }
        let _ = std::fs::remove_dir_all(root.join(".incoming"));
        // Before the cache: the APK sat at updates/playground-update.apk.
        if let Some(updates) = root.parent() {
            let _ = std::fs::remove_file(updates.join("playground-update.apk"));
            let _ = std::fs::remove_dir_all(updates.join("incoming"));
        }
        // The updater's leftovers: `<app name>-<version>-updater-XXXX` dirs.
        if !cfg!(target_os = "android") {
            if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
                let prefix = format!("{name}-");
                for e in entries.flatten() {
                    let n = e.file_name().to_string_lossy().to_string();
                    if n.starts_with(&prefix) && n.contains("-updater-") && e.path().is_dir() {
                        let _ = std::fs::remove_dir_all(e.path());
                    }
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Download this device's desktop installer into the cache through the updater
/// plugin (signature checked by the plugin). `manifest_url`: the studio's or the
/// mother's manifest endpoint, `{{target}}`/`{{arch}}`/`{{current_version}}`
/// templated by the plugin. `prefetch`: take the latest whatever our version
/// (a mother keeping the newest installer for its satellites).
#[cfg(desktop)]
#[tauri::command]
pub async fn update_fetch_to_cache(
    app: AppHandle,
    manifest_url: String,
    channel: String,
    prefetch: bool,
    source: String,
) -> Result<ReleaseMeta, String> {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;
    let url = tauri::Url::parse(&manifest_url).map_err(|e| e.to_string())?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .header("X-Update-Channel", channel.clone())
        .map_err(|e| e.to_string())?;
    if prefetch {
        builder = builder.version_comparator(|_, _| true);
    }
    let update = builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    let root = cache_root(&app)?;
    let platform = desktop_platform();
    if let Some(cur) = read_meta(&root, &platform) {
        if channel_ok(&channel, &cur.channel) {
            if semver_cmp(&cur.version, &update.version) != Ordering::Less {
                return Ok(cur);
            }
        } else {
            // Cached for another channel (the device's channel changed): it
            // must not shadow the build this channel offers.
            let _ = std::fs::remove_dir_all(root.join(&platform));
        }
    }
    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(
                    "taghunter://update-cache-progress",
                    json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    let build_channel = update
        .raw_json
        .get("channel")
        .and_then(|c| c.as_str())
        .unwrap_or(&channel)
        .to_string();
    let meta = ReleaseMeta {
        version: update.version.clone(),
        channel: build_channel,
        notes: update.body.clone().unwrap_or_default(),
        pub_date: update.raw_json.get("pub_date").and_then(|v| v.as_str()).map(str::to_string),
        signature: Some(update.signature.clone()),
        sha256: None,
        size: bytes.len() as u64,
        min_supported_version: update
            .raw_json
            .get("min_supported_version")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        filename: format!("Tag_Hunter_Playground_{}_{}-setup.exe", update.version, std::env::consts::ARCH),
        fetched_from: source,
        fetched_at: now_ms(),
    };
    let tmp = incoming_path(&root, &platform);
    if let Some(dir) = tmp.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&tmp, &bytes).await.map_err(|e| e.to_string())?;
    let meta2 = meta.clone();
    tauri::async_runtime::spawn_blocking(move || commit(&root, &platform, &tmp, &meta2))
        .await
        .map_err(|e| e.to_string())??;
    Ok(meta)
}

/// Install the cached desktop installer and restart into it. Goes through the
/// updater plugin (signature checked again, the plugin's own NSIS launch) by
/// pointing it at a one-shot loopback server that serves the cache.
#[cfg(desktop)]
#[tauri::command]
pub async fn update_install_from_cache(app: AppHandle, channel: String) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let root = cache_root(&app)?;
    let platform = desktop_platform();
    let meta = read_meta(&root, &platform).ok_or("no update staged")?;
    if !channel_ok(&channel, &meta.channel) {
        return Err(format!("the staged update is a {} build", meta.channel));
    }
    let current = app.package_info().version.to_string();
    if semver_cmp(&meta.version, &current) != Ordering::Greater {
        return Err("the staged update is not newer than this version".into());
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let router: Router = router(&app)?;
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await;
    });

    let result = async {
        let url = tauri::Url::parse(&format!(
            "http://127.0.0.1:{port}/update.php?action=manifest&target={{{{target}}}}&arch={{{{arch}}}}&current_version={{{{current_version}}}}&channel={}",
            channel
        ))
        .map_err(|e| e.to_string())?;
        let update = app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "the staged update was not offered".to_string())?;
        let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        // Windows: the installer takes over and this process exits here.
        update.install(bytes).map_err(|e| e.to_string())
    }
    .await;

    let _ = stop_tx.send(());
    let _ = server.await;
    result?;
    app.restart();
}

/// Satellite: hand the mother a newer installer we hold (cached `platform`).
#[tauri::command]
pub async fn client_push_installer(
    app: AppHandle,
    base_url: String,
    token: String,
    client_id: i64,
    platform: String,
) -> Result<Value, String> {
    let root = cache_root(&app)?;
    let meta = read_meta(&root, &platform).ok_or("nothing cached for that platform")?;
    let file = tokio::fs::File::open(installer_path(&root, &platform, &meta))
        .await
        .map_err(|e| e.to_string())?;
    let body = reqwest::Body::wrap_stream(ReaderStream::with_capacity(file, STREAM_CHUNK));
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let client = crate::lan_server::lan_client_builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(30 * 60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut url = tauri::Url::parse(&format!("{}/content.php", base_url.trim_end_matches('/')))
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("action", "put_installer")
        .append_pair("platform", &platform)
        .append_pair("meta", &meta_json);
    let resp = client
        .post(url)
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

    fn meta(version: &str, channel: &str, file: &str, size: u64) -> ReleaseMeta {
        ReleaseMeta {
            version: version.into(),
            channel: channel.into(),
            notes: String::new(),
            pub_date: None,
            signature: Some("sig".into()),
            sha256: None,
            size,
            min_supported_version: None,
            filename: file.into(),
            fetched_from: "cloud".into(),
            fetched_at: 0,
        }
    }

    #[test]
    fn semver_and_channels() {
        assert_eq!(semver_cmp("1.2.10", "1.2.9"), Ordering::Greater);
        assert_eq!(semver_cmp("1.2.0", "1.2"), Ordering::Equal);
        assert_eq!(semver_cmp("2.0.0-beta", "1.9.9"), Ordering::Greater);
        assert!(channel_ok("stable", "stable"));
        assert!(!channel_ok("stable", "test"));
        assert!(channel_ok("test", "test"));
        assert!(channel_ok("test", "stable"));
    }

    #[test]
    fn commit_keeps_only_the_newest() {
        let root = std::env::temp_dir().join(format!("thp-upd-{}", uuid::Uuid::new_v4()));
        let p = "windows-x86_64";
        let src1 = root.join("a.part");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&src1, b"one").unwrap();
        assert!(commit(&root, p, &src1, &meta("1.1.0", "stable", "v110.exe", 3)).unwrap());
        assert_eq!(read_meta(&root, p).unwrap().version, "1.1.0");
        // older: dropped, cache unchanged
        let src0 = root.join("b.part");
        std::fs::write(&src0, b"zero").unwrap();
        assert!(!commit(&root, p, &src0, &meta("1.0.0", "stable", "v100.exe", 4)).unwrap());
        assert!(!src0.exists());
        assert_eq!(read_meta(&root, p).unwrap().version, "1.1.0");
        // newer: replaces, the old installer is gone
        let src2 = root.join("c.part");
        std::fs::write(&src2, b"two!").unwrap();
        assert!(commit(&root, p, &src2, &meta("1.2.0", "stable", "v120.exe", 4)).unwrap());
        assert_eq!(read_meta(&root, p).unwrap().version, "1.2.0");
        assert!(!root.join(p).join("v110.exe").exists());
        // offers follow channel + version
        assert!(offer(&root, p, "stable", "1.1.9").is_some());
        assert!(offer(&root, p, "stable", "1.2.0").is_none());
        // a truncated installer is not an offer
        std::fs::write(root.join(p).join("v120.exe"), b"tw").unwrap();
        assert!(read_meta(&root, p).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unsafe_names_are_refused() {
        assert!(!is_safe_filename("../x.exe"));
        assert!(!is_safe_filename("release.json"));
        assert!(!is_safe_platform("../windows"));
        assert!(is_safe_platform("windows-x86_64"));
    }

    #[test]
    fn signed_name_must_carry_the_version() {
        let c = "timestamp:1760000000\tfile:Tag_Hunter_Playground_1.1.20_x64-setup.exe";
        assert!(signed_name_matches(c, "1.1.20"));
        assert!(!signed_name_matches(c, "1.1.2"));
        assert!(!signed_name_matches(c, "99.0.0"));
        assert!(!signed_name_matches("timestamp:1", "1.1.20"));
        // The real Tauri name has spaces: the whole name must be read, not "Tag".
        let spaced = "timestamp:1791441777\tfile:Tag Hunter Playground_1.1.129_x64-setup.exe";
        assert!(signed_name_matches(spaced, "1.1.129"));
        assert!(!signed_name_matches(spaced, "1.1.12"));
    }

    #[test]
    fn minisign_rejects_garbage() {
        assert!(verify_minisign(b"data", "bm90IGEgc2ln", "bm90IGEga2V5").is_err());
    }
}
