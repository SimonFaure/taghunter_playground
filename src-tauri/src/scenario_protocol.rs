// Custom URI scheme that resolves `scenario://{uniqid}/{relpath}` to a blob in
// the content-addressed pool:
//   <app_data_dir>/media/blobs/{first2}/{content_hash}
//
// The (uniqid, relpath) -> content_hash mapping is the scenario's active
// manifest, looked up per-request from `scenario_files` in the same SQLite the
// sync orchestrator writes to (`playground.db`). Per-request lookup keeps URLs
// stable across content changes: a `<img src="scenario://abc/foo.png">`
// survives a scenario update because the next request resolves the (possibly
// new) hash automatically - and unchanged files keep the same hash, so the
// blob is shared, never re-downloaded. Design: project_scenario_incremental_sync_cas.
//
// On Windows, Tauri rewrites `scenario://abc/foo.png` to
// `http://scenario.localhost/abc/foo.png` for the webview round-trip. The
// parser below handles both shapes.

use std::path::PathBuf;

use rusqlite::OptionalExtension;
use tauri::http::{Request, Response, StatusCode, Uri};
use tauri::{AppHandle, Manager};

pub async fn handle(app: AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match resolve(app, &request).await {
        Ok(resp) => resp,
        Err(_) => not_found(),
    }
}

async fn resolve(app: AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
    let uri = request.uri();
    let (uniqid, relpath) =
        parse_scenario_uri(uri).ok_or_else(|| format!("unparseable URI: {uri}"))?;
    if !is_safe_path(&relpath) {
        return Err(format!("unsafe relpath: {relpath}"));
    }

    let bytes =
        tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<u8>, String), String> {
            let db_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir failed: {e}"))?;
            let db_path = db_dir.join("playground.db");
            let conn = rusqlite::Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|e| format!("open {} failed: {e}", db_path.display()))?;

            // Resolve the active manifest entry: (uniqid, relpath) -> content
            // hash. A missing row means this file isn't part of the committed
            // download (e.g. an operator-only device that only keeps the visual,
            // or a not-yet-synced scenario) - 404 is the correct outcome.
            //
            // Match the full relpath first, falling back to its basename - the
            // SAME fallback scenarioStore.activeHash() uses on the TS side. The
            // manifest stores the studio's (flat) filename, while a game-data
            // field may reference it with a subdir prefix (or vice-versa); both
            // resolution paths MUST agree or in-game media 404s where the test
            // modals would have resolved it.
            let basename = relpath.rsplit('/').next().unwrap_or(&relpath).to_string();
            let content_hash: String = conn
                .query_row(
                    "SELECT content_hash FROM scenario_files \
                     WHERE uniqid = ?1 AND (rel_path = ?2 OR rel_path = ?3) \
                     ORDER BY (rel_path = ?2) DESC LIMIT 1",
                    rusqlite::params![&uniqid, &relpath, &basename],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| format!("query scenario_files for {uniqid}/{relpath} failed: {e}"))?
                .ok_or_else(|| format!("no manifest entry for {uniqid}/{relpath}"))?;

            if content_hash.len() < 2 {
                return Err(format!("malformed content_hash for {uniqid}/{relpath}"));
            }
            let shard = &content_hash[0..2];
            let file_path: PathBuf = db_dir
                .join("media")
                .join("blobs")
                .join(shard)
                .join(&content_hash);

            let bytes = std::fs::read(&file_path)
                .map_err(|e| format!("read {} failed: {e}", file_path.display()))?;
            // MIME comes from the requested relpath's extension, not the blob's
            // hash name (the blob file has no extension).
            let mime = mime_for(std::path::Path::new(&relpath)).to_string();
            Ok((bytes, mime))
        })
        .await
        .map_err(|e| format!("spawn_blocking join error: {e}"))??;

    let (body, mime) = bytes;
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .map_err(|e| format!("response build failed: {e}"))
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain")
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}

/// Returns (uniqid, relpath) for the URI shapes Tauri 2 may deliver.
///
/// The webview mints `http(s)://scenario.localhost/<uniqid>/<relpath>` on
/// Windows/Android and `scenario://…` elsewhere - but Tauri NORMALISES every
/// custom-protocol request to `scenario://localhost/<uniqid>/<relpath>` before
/// it reaches this handler (host becomes the literal `localhost`). So:
///   host == "localhost" / "scenario.localhost"  → uniqid is the 1st path seg
///   any other host                              → legacy `scenario://<uniqid>/…`
///                                                  shape (host IS the uniqid)
fn parse_scenario_uri(uri: &Uri) -> Option<(String, String)> {
    let host = uri.host()?;
    let raw_path = uri.path().trim_start_matches('/');
    let (uniqid_raw, rest_raw) = if host == "localhost" || host == "scenario.localhost" {
        raw_path.split_once('/')?
    } else {
        (host, raw_path)
    };
    let uniqid = percent_decode(uniqid_raw);
    let relpath = percent_decode(rest_raw);
    if uniqid.is_empty() || relpath.is_empty() {
        return None;
    }
    Some((uniqid, relpath))
}

fn is_safe_path(relpath: &str) -> bool {
    for seg in relpath.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return false;
        }
        if seg.contains('\\') || seg.contains('\0') {
            return false;
        }
    }
    true
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = (bytes[i + 1] as char).to_digit(16);
            let l = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (h, l) {
                out.push(((h * 16) + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_for(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("mp3") => "audio/mpeg",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("m4a") => "audio/mp4",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal() {
        assert!(!is_safe_path("../etc/passwd"));
        assert!(!is_safe_path("images/../../etc"));
        assert!(!is_safe_path("a//b"));
        assert!(!is_safe_path("a\\b"));
        assert!(!is_safe_path(""));
        assert!(is_safe_path("images/foo.png"));
        assert!(is_safe_path("foo.png"));
    }

    #[test]
    fn parses_native_shape() {
        let uri: Uri = "scenario://abc/images/foo.png".parse().unwrap();
        let (u, r) = parse_scenario_uri(&uri).unwrap();
        assert_eq!(u, "abc");
        assert_eq!(r, "images/foo.png");
    }

    #[test]
    fn parses_windows_shape() {
        let uri: Uri = "http://scenario.localhost/abc/images/foo.png".parse().unwrap();
        let (u, r) = parse_scenario_uri(&uri).unwrap();
        assert_eq!(u, "abc");
        assert_eq!(r, "images/foo.png");
    }

    #[test]
    fn parses_normalised_localhost_shape() {
        // The shape Tauri actually hands the handler after normalising the
        // `http://scenario.localhost/…` webview URL.
        let uri: Uri = "scenario://localhost/abc/images/foo.png".parse().unwrap();
        let (u, r) = parse_scenario_uri(&uri).unwrap();
        assert_eq!(u, "abc");
        assert_eq!(r, "images/foo.png");
    }

    #[test]
    fn decodes_percent_encoded_filenames() {
        let uri: Uri = "scenario://abc/my%20image.png".parse().unwrap();
        let (u, r) = parse_scenario_uri(&uri).unwrap();
        assert_eq!(u, "abc");
        assert_eq!(r, "my image.png");
    }
}
