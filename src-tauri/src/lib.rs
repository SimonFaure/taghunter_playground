// Tauri 2 entry. Registers plugins and SQLite migrations for the auth slice.
//
// Token storage: the JWT lives in SQLite `schema_meta(key, value)` (see
// `src/services/strongholdStore.ts`). The Stronghold plugin was tried and
// retired — its encrypted-snapshot serialization made login take minutes on
// Windows and its actual security gain was negligible given the key was
// derived from a hardcoded constant. The Rust dep is gone; for real
// hardening, swap to an OS keyring plugin in a follow-up.

use tauri_plugin_sql::{Migration, MigrationKind};

mod hotspot;
mod lan_server;
mod scenario_protocol;
mod sportident;
mod telemetry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                // Migrations are looked up by exact match against the URL
                // that Database.load() opens (see services/db.ts). sqlx's
                // SQLite URL parser does NOT accept journal_mode / busy_timeout
                // as query params — passing them silently de-keys the
                // migration list and migrations stop applying. The WAL and
                // busy-timeout pragmas are set imperatively in db.ts right
                // after Database.load() returns.
                .add_migrations("sqlite:playground.db", playground_migrations())
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("scenario", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let response = scenario_protocol::handle(app, request).await;
                responder.respond(response);
            });
        })
        .manage(lan_server::MotherServerState::default())
        .manage(lan_server::MotherEndpointCache::default())
        .manage(sportident::SportIdentState::default())
        .setup(|app| {
        // Install the Rust panic hook now that an AppHandle exists, so
        // it can resolve app_data_dir for the persisted panic file. Any
        // Rust panic past this point lands as a structured record the
        // JS side reads back on next boot via take_pending_panic().
        telemetry::install_panic_hook(app.handle().clone());
        Ok(())
    });

    // Desktop-only: the app self-update stack. tauri-plugin-process supplies
    // the explicit relaunch the user-driven "Restart now" button calls.
    // Mobile updates go through the app stores, so these are not registered.
    // tauri-plugin-autostart backs the "Launch on startup" preference; it is
    // desktop-only and the renderer calls enable()/disable() on Save.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    builder
        .invoke_handler(tauri::generate_handler![
            get_wifi_ssid,
            telemetry::take_pending_panic,
            lan_server::mother_start_local_server,
            lan_server::mother_stop_local_server,
            lan_server::mother_server_status,
            lan_server::mother_list_pending_pair_requests,
            lan_server::mother_approve_pair_request,
            lan_server::mother_deny_pair_request,
            lan_server::mother_list_paired_devices,
            lan_server::mother_revoke_paired_device,
            lan_server::client_save_paired_mother,
            lan_server::client_list_paired_mothers,
            lan_server::client_get_paired_mother,
            lan_server::client_forget_paired_mother,
            lan_server::client_get_device_identity,
            lan_server::client_discover_mothers,
            lan_server::client_refresh_mother_endpoints,
            lan_server::client_ping_mother,
            lan_server::client_describe_local_role,
            hotspot::mother_start_hotspot,
            hotspot::mother_stop_hotspot,
            hotspot::mother_hotspot_status,
            sportident::si_list_ports,
            sportident::si_start,
            sportident::si_stop,
            sportident::si_send_beep,
            sportident::si_set_station_time,
            sportident::si_read_station_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn playground_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "auth_slice initial schema",
            sql: r#"
                CREATE TABLE IF NOT EXISTS auth_user (
                    client_id INTEGER PRIMARY KEY,
                    email TEXT NOT NULL,
                    name TEXT,
                    avatar_url TEXT,
                    license_type TEXT NOT NULL,
                    billing_up_to_date INTEGER NOT NULL,
                    max_devices INTEGER NOT NULL,
                    offline_grace_days INTEGER NOT NULL,
                    current_device_id INTEGER,
                    device_label TEXT,
                    last_server_check_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS pending_writes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    endpoint TEXT NOT NULL,
                    method TEXT NOT NULL,
                    body_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT
                );

                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '1');
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "content_sync schema: scenarios, patterns, layouts, cards_state",
            sql: r#"
                CREATE TABLE IF NOT EXISTS scenarios (
                    uniqid TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    game_type TEXT NOT NULL,
                    is_product INTEGER NOT NULL,
                    remote_version INTEGER NOT NULL,
                    local_version INTEGER,
                    last_manifest_seen_at TEXT NOT NULL,
                    failed_attempts INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS patterns (
                    pattern_uniqid TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    game_type TEXT NOT NULL,
                    pattern_slug TEXT,
                    description TEXT,
                    is_default INTEGER NOT NULL,
                    remote_version INTEGER NOT NULL,
                    local_version INTEGER,
                    pattern_data_json TEXT,
                    last_manifest_seen_at TEXT NOT NULL,
                    failed_attempts INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS layouts (
                    id INTEGER PRIMARY KEY,
                    game_type TEXT NOT NULL,
                    remote_version INTEGER NOT NULL,
                    local_version INTEGER,
                    layout_data_json TEXT,
                    last_manifest_seen_at TEXT NOT NULL,
                    failed_attempts INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS cards_state (
                    client_id INTEGER PRIMARY KEY,
                    remote_version INTEGER,
                    local_version INTEGER,
                    has_on_demand_cards INTEGER NOT NULL DEFAULT 0,
                    on_demand_fetched_at TEXT,
                    failed_attempts INTEGER NOT NULL DEFAULT 0
                );

                UPDATE schema_meta SET value = '2' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "lan_mode schema: launched-games tables hosted on the mother device",
            sql: r#"
                -- Game header. INT AUTO_INCREMENT id (so the TS surface, which
                -- expects `id: number`, is unchanged). summary_uuid is a stable
                -- offline-generated identifier that future cloud-sync (slice E)
                -- uses as the cloud PK to dedupe re-syncs across devices.
                CREATE TABLE IF NOT EXISTS lg_launched_games (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    summary_uuid TEXT NOT NULL UNIQUE,
                    client_id INTEGER NOT NULL,
                    game_uniqid TEXT NOT NULL,
                    name TEXT NOT NULL,
                    number_of_teams INTEGER NOT NULL,
                    game_type TEXT NOT NULL,
                    duration INTEGER NOT NULL,
                    start_time TEXT NULL,
                    started INTEGER NOT NULL DEFAULT 0,
                    ended INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
                );
                CREATE INDEX IF NOT EXISTS idx_lg_client_ended
                    ON lg_launched_games(client_id, ended);
                CREATE INDEX IF NOT EXISTS idx_lg_client_created
                    ON lg_launched_games(client_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS lg_launched_game_meta (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    launched_game_id INTEGER NOT NULL,
                    meta_name TEXT NOT NULL,
                    meta_value TEXT NULL,
                    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_lgm_game_name
                    ON lg_launched_game_meta(launched_game_id, meta_name);

                CREATE TABLE IF NOT EXISTS lg_launched_game_devices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    launched_game_id INTEGER NOT NULL,
                    device_id INTEGER NOT NULL,
                    device_label TEXT NULL,
                    os TEXT NULL,
                    os_version TEXT NULL,
                    connected INTEGER NOT NULL DEFAULT 1,
                    last_connection_attempt TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    UNIQUE(launched_game_id, device_id),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS lg_launched_game_raw_data (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    launched_game_id INTEGER NOT NULL,
                    device_id INTEGER NOT NULL,
                    raw_data TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_lgrd_game_id
                    ON lg_launched_game_raw_data(launched_game_id, id);

                CREATE TABLE IF NOT EXISTS lg_teams (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    launched_game_id INTEGER NOT NULL,
                    team_number INTEGER NOT NULL,
                    team_name TEXT NULL,
                    pattern INTEGER NOT NULL,
                    score INTEGER NOT NULL DEFAULT 0,
                    key_id INTEGER NULL,
                    start_time INTEGER NULL,
                    end_time INTEGER NULL,
                    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_lgteams_game
                    ON lg_teams(launched_game_id);
                CREATE INDEX IF NOT EXISTS idx_lgteams_game_team
                    ON lg_teams(launched_game_id, team_number);

                CREATE TABLE IF NOT EXISTS lg_team_completed_quests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    launched_game_id INTEGER NOT NULL,
                    team_id INTEGER NOT NULL,
                    teammate_chip_id INTEGER NULL,
                    quest_id INTEGER NULL,
                    quest_number TEXT NOT NULL,
                    points_awarded INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
                    FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_lgtcq_game
                    ON lg_team_completed_quests(launched_game_id);
                CREATE INDEX IF NOT EXISTS idx_lgtcq_team
                    ON lg_team_completed_quests(team_id);
                CREATE INDEX IF NOT EXISTS idx_lgtcq_team_quest
                    ON lg_team_completed_quests(team_id, quest_number);

                UPDATE schema_meta SET value = '3' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "lan_mode pairing: paired_devices (mother) + paired_mothers (client) + pair_requests",
            sql: r#"
                -- Mother-side: every peer (including the mother itself) that
                -- can talk to the LAN server. The row id doubles as the
                -- device_id in lg_launched_game_devices and lg_launched_game_raw_data.
                CREATE TABLE IF NOT EXISTS paired_devices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    peer_uuid TEXT NOT NULL UNIQUE,
                    peer_label TEXT NOT NULL,
                    peer_os TEXT NULL,
                    peer_app_version TEXT NULL,
                    peer_secret TEXT NOT NULL,
                    is_self INTEGER NOT NULL DEFAULT 0,
                    paired_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    last_seen_at TEXT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_paired_devices_secret
                    ON paired_devices(peer_secret);

                -- Mother-side: pending or recently-decided pair handshakes.
                -- proposed_secret is generated on receipt; revealed to the peer
                -- only after status flips to 'approved'.
                CREATE TABLE IF NOT EXISTS pair_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    peer_uuid TEXT NOT NULL,
                    peer_label TEXT NOT NULL,
                    peer_os TEXT NULL,
                    peer_app_version TEXT NULL,
                    proposed_secret TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    decided_at TEXT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_pair_requests_status
                    ON pair_requests(status, created_at);

                -- Client-side: list of mothers this device is paired with, plus
                -- the bearer it uses for each. Same DB file as paired_devices
                -- (this app is both mother and client depending on slot).
                CREATE TABLE IF NOT EXISTS paired_mothers (
                    mother_uuid TEXT PRIMARY KEY,
                    mother_label TEXT NULL,
                    peer_secret TEXT NOT NULL,
                    paired_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    last_seen_at TEXT NULL
                );

                UPDATE schema_meta SET value = '4' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "telemetry: extend pending_writes for outbox-style event delivery",
            sql: r#"
                -- pending_writes was declared in migration 1 as a generic
                -- offline-write queue (endpoint/method/body_json/attempts).
                -- It was never wired up. We're co-opting it as the telemetry
                -- outbox: one row per queued event (heartbeat, error, future
                -- launch stat), each carrying a client-generated event_uuid
                -- so the studio server can idempotently upsert.
                --
                -- payload_hash is the fingerprint used for client-side
                -- dedup of error events (sha256(message + first 5 stack
                -- frames)). Same hash within a small window collapses onto
                -- an existing pending row by incrementing occurrence_count.
                ALTER TABLE pending_writes ADD COLUMN event_uuid TEXT NOT NULL DEFAULT '';
                ALTER TABLE pending_writes ADD COLUMN event_type TEXT NOT NULL DEFAULT '';
                ALTER TABLE pending_writes ADD COLUMN payload_hash TEXT;
                ALTER TABLE pending_writes ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
                ALTER TABLE pending_writes ADD COLUMN first_seen_at TEXT;
                ALTER TABLE pending_writes ADD COLUMN last_seen_at TEXT;
                ALTER TABLE pending_writes ADD COLUMN occurred_at TEXT;

                CREATE INDEX IF NOT EXISTS idx_pw_event_type ON pending_writes(event_type);
                CREATE INDEX IF NOT EXISTS idx_pw_dedup ON pending_writes(event_type, payload_hash);
                CREATE INDEX IF NOT EXISTS idx_pw_created ON pending_writes(created_at);

                UPDATE schema_meta SET value = '5' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "admin_translations: cache global tagquest HUD labels",
            sql: r#"
                -- One row per global translation key (currently only
                -- 'tagquest_translations'). `value_json` is the opaque JSON
                -- value as shipped by the manifest. `remote_version` matches
                -- the studio's default_config.version for idempotent upsert.
                -- Read at render time; rendered text follows the fallback
                -- chain in defaultPreviewLabels.ts.
                CREATE TABLE IF NOT EXISTS admin_translations (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    remote_version INTEGER NOT NULL,
                    last_manifest_seen_at TEXT NOT NULL
                );

                UPDATE schema_meta SET value = '6' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "cards table (row-based, replaces cards_v*.csv) + usbPort sweep",
            sql: r#"
                -- Row-based cards table. Cards used to be a per-client
                -- versioned CSV file downloaded from the studio and parsed
                -- in memory at game-launch time. They're now sync'd as DB
                -- rows from studio's client_cards table.
                --
                -- sync_state tracks rows that haven't been pushed to studio
                -- yet (created/edited/deleted offline). When 'pending',
                -- operation says which verb to replay on next sync cycle.
                -- When 'synced', operation is NULL.
                --
                -- cards_state.{remote,local}_version are integers in the
                -- column declaration but SQLite's dynamic typing stores
                -- REAL values transparently — studio's version is now
                -- DECIMAL(10,2), so values like 4.01 land here unchanged.
                CREATE TABLE IF NOT EXISTS cards (
                    id INTEGER NOT NULL PRIMARY KEY,
                    key_number INTEGER NOT NULL,
                    key_name TEXT NOT NULL,
                    color TEXT,
                    sync_state TEXT NOT NULL DEFAULT 'synced',
                    operation TEXT,
                    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
                );
                CREATE INDEX IF NOT EXISTS idx_cards_sync_state
                    ON cards(sync_state)
                    WHERE sync_state = 'pending';
                CREATE INDEX IF NOT EXISTS idx_cards_key_number
                    ON cards(key_number);

                -- Part 1 sweep: the playground used to save the chosen USB
                -- port to launched_game_meta on every game launch. We now
                -- auto-detect by VID/PID at run time, so any saved meta
                -- rows are dead bytes. Delete them once on this migration.
                DELETE FROM lg_launched_game_meta WHERE meta_name = 'usbPort';

                UPDATE schema_meta SET value = '7' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "game_types + client overrides + client preferences for launch videos",
            sql: r#"
                CREATE TABLE IF NOT EXISTS game_types (
                    code TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    supports_tutorial_video INTEGER NOT NULL DEFAULT 0,
                    supports_intro_video INTEGER NOT NULL DEFAULT 0,
                    tutorial_video_filename TEXT,
                    remote_version INTEGER NOT NULL DEFAULT 0,
                    local_version INTEGER,
                    tutorial_subtitles_json TEXT,
                    failed_attempts INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS game_type_overrides (
                    game_type_code TEXT PRIMARY KEY,
                    tutorial_video_filename TEXT,
                    remote_version INTEGER NOT NULL DEFAULT 0,
                    local_version INTEGER,
                    tutorial_subtitles_json TEXT,
                    failed_attempts INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (game_type_code) REFERENCES game_types(code) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS client_preferences (
                    client_id INTEGER PRIMARY KEY,
                    preferences_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
                );

                UPDATE schema_meta SET value = '8' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "device_pin: local 4-digit PIN guarding cold-start unlock",
            sql: r#"
                -- Single-row table holding the device's PIN hash + backoff state.
                -- The CHECK(id=1) clause enforces "at most one row" so the
                -- INSERT-or-UPDATE pattern in services/pinStore.ts can target
                -- a known PK without juggling existence checks.
                --
                -- Hash format: PBKDF2-HMAC-SHA256 via Web Crypto, encoded as
                -- base64. Salt is 16 random bytes; iterations is stored to
                -- allow future cost tuning without breaking existing PINs.
                --
                -- Backoff: failed_attempts is the running streak of wrong
                -- entries since the last success. locked_until_at is a unix
                -- epoch (seconds) past which the next attempt is allowed.
                -- Both reset to 0 on a successful unlock.
                CREATE TABLE IF NOT EXISTS device_pin (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    pin_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    kdf_iterations INTEGER NOT NULL,
                    failed_attempts INTEGER NOT NULL DEFAULT 0,
                    locked_until_at INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
                );

                UPDATE schema_meta SET value = '9' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        // Migration 10 is retained for migration-history integrity ONLY.
        // It shipped in a dev build and was applied to existing databases,
        // then the feature it backed (a `hidden` soft-delete flag) was
        // dropped. sqlx records every applied migration and aborts startup
        // with "migration 10 was previously applied but is missing in the
        // resolved migrations" if it is removed — so the block must stay, and
        // its `sql` must stay byte-identical so the sqlx checksum still
        // matches the recorded one. The `hidden` column is now inert dead
        // schema that no code reads. Do not delete or edit this block.
        Migration {
            version: 10,
            description: "scenarios.hidden: local soft-delete flag for the playground delete button",
            sql: r#"
                -- Local-only soft delete. The playground's "Delete scenario"
                -- button sets this to 1, which drops the scenario from the
                -- card list AND from the sync orchestrator's pending-download
                -- view, so the manifest does not re-download it. The flag is
                -- never written by upsertFromManifest's ON CONFLICT clause, so
                -- it survives every subsequent sync cycle.
                ALTER TABLE scenarios ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

                UPDATE schema_meta SET value = '10' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
    ]
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer health-check command.
// Invoked from the renderer on a 10s polling tick (Footer.tsx). Never panics;
// failures collapse to Err(String) which the TS side interprets as "red dot".
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_wifi_ssid() -> Result<Option<String>, String> {
    // \bSSID\b avoids matching BSSID lines that appear later in netsh/airport
    // output (B-S has no word boundary, so \b prevents the false match).
    parse_ssid_from_platform().await
}

#[cfg(target_os = "windows")]
async fn parse_ssid_from_platform() -> Result<Option<String>, String> {
    let out = tokio::process::Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let re = regex::Regex::new(r"(?m)^\s*\bSSID\b\s*:\s*(.+)$").map_err(|e| e.to_string())?;
    Ok(re.captures(&text).map(|c| c[1].trim().to_string()))
}

#[cfg(target_os = "macos")]
async fn parse_ssid_from_platform() -> Result<Option<String>, String> {
    let out = tokio::process::Command::new(
        "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
    )
    .arg("-I")
    .output()
    .await
    .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let re = regex::Regex::new(r"(?m)^\s*\bSSID\b\s*:\s*(.+)$").map_err(|e| e.to_string())?;
    Ok(re.captures(&text).map(|c| c[1].trim().to_string()))
}

#[cfg(target_os = "linux")]
async fn parse_ssid_from_platform() -> Result<Option<String>, String> {
    let out = tokio::process::Command::new("iwgetid")
        .arg("-r")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let ssid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if ssid.is_empty() { None } else { Some(ssid) })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn parse_ssid_from_platform() -> Result<Option<String>, String> {
    Err("SSID detection not implemented on mobile".to_string())
}
