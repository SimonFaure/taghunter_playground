// Tauri 2 entry. Registers plugins and SQLite migrations for the auth slice.
//
// Token storage: the JWT lives in SQLite `schema_meta(key, value)` (see
// `src/services/strongholdStore.ts`). The Stronghold plugin was tried and
// retired - its encrypted-snapshot serialization made login take minutes on
// Windows and its actual security gain was negligible given the key was
// derived from a hardcoded constant. The Rust dep is gone; for real
// hardening, swap to an OS keyring plugin in a follow-up.

use tauri_plugin_sql::{Migration, MigrationKind};

mod app_uninstall;
mod cp210x_driver;
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
                // as query params - passing them silently de-keys the
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
        .manage(lan_server::ReaderPresence::default())
        .manage(lan_server::ScreenPresence::default())
        .manage(sportident::SportIdentState::default())
        .setup(|app| {
        // Install the Rust panic hook now that an AppHandle exists, so
        // it can resolve app_data_dir for the persisted panic file. Any
        // Rust panic past this point lands as a structured record the
        // JS side reads back on next boot via take_pending_panic().
        telemetry::install_panic_hook(app.handle().clone());

        // Tester builds (`tauri build --features devtools`) compile the WebView2
        // inspector in and pop it open at boot so QA can watch console/network.
        // The stable bundle never enables this feature, so this whole block
        // compiles to nothing - DevTools stays stripped out of production.
        #[cfg(feature = "devtools")]
        {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
        }

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
            sha256_file,
            scan_wifi,
            connect_wifi,
            telemetry::take_pending_panic,
            lan_server::mother_start_local_server,
            lan_server::mother_open_firewall_elevated,
            lan_server::mother_firewall_rule_status,
            lan_server::lan_diag,
            lan_server::wifi_renew_dhcp,
            lan_server::get_local_ipv4s,
            lan_server::wifi_assign_static_ip,
            lan_server::wifi_restore_dhcp,
            lan_server::mother_ensure_mdns_live,
            lan_server::mother_refresh_mdns,
            lan_server::mother_stop_local_server,
            lan_server::mother_server_status,
            lan_server::mother_get_server_info,
            lan_server::become_mother,
            lan_server::get_takeover_target,
            lan_server::fetch_snapshot_from_mother,
            lan_server::get_self_peer_secret,
            lan_server::mother_list_paired_devices,
            lan_server::mother_revoke_paired_device,
            lan_server::client_save_paired_mother,
            lan_server::client_list_paired_mothers,
            lan_server::client_get_paired_mother,
            lan_server::client_forget_paired_mother,
            lan_server::client_get_device_identity,
            lan_server::client_discover_mothers,
            lan_server::client_probe_mother,
            lan_server::client_pair_with_mother,
            lan_server::client_refresh_mother_endpoints,
            lan_server::client_resolve_mother_link,
            lan_server::client_ping_mother,
            lan_server::client_set_reader_presence,
            lan_server::client_set_screen_state,
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
            cp210x_driver::check_cp210x_driver_state,
            cp210x_driver::install_cp210x_driver,
            app_uninstall::uninstall_app,
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
        // resolved migrations" if it is removed - so the block must stay, and
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
        Migration {
            version: 11,
            description: "device push-channel: reader presence + pending_commands queue",
            sql: r#"
                ALTER TABLE paired_devices ADD COLUMN has_reader INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE paired_devices ADD COLUMN reader_last_seen_at TEXT NULL;

                CREATE TABLE IF NOT EXISTS pending_commands (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_device_id INTEGER NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
                    kind             TEXT NOT NULL,
                    payload_json     TEXT NOT NULL,
                    created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    delivered_at     TEXT NULL,
                    acked_at         TEXT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_pending_commands_target_open
                    ON pending_commands(target_device_id, acked_at);

                UPDATE schema_meta SET value = '11' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "team-name pools sync state (incremental version compare, like cards_state)",
            sql: r#"
                CREATE TABLE IF NOT EXISTS name_pools_state (
                    client_id INTEGER PRIMARY KEY,
                    remote_version REAL,
                    local_version REAL,
                    fetched_at TEXT,
                    failed_attempts INTEGER NOT NULL DEFAULT 0
                );

                UPDATE schema_meta SET value = '12' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "launch_configs: named, scenario-assigned saved launch presets (local-only)",
            sql: r#"
                CREATE TABLE IF NOT EXISTS launch_configs (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_id   INTEGER NOT NULL,
                    game_uniqid TEXT    NOT NULL,
                    name        TEXT    NOT NULL,
                    config_json TEXT    NOT NULL,
                    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(client_id, game_uniqid, name)
                );
                CREATE INDEX IF NOT EXISTS idx_launch_configs_scope
                    ON launch_configs(client_id, game_uniqid);

                UPDATE schema_meta SET value = '13' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "lg_game_summaries: durable per-game stats record (survives lg_* deletion on archive; pushed to studio as game_summary telemetry)",
            sql: r#"
                -- One row per summarised launched game, keyed by the same
                -- summary_uuid as lg_launched_games (stable cloud identity).
                -- Deliberately NOT a child of lg_launched_games: the row must
                -- survive Archive (which deletes lg_launched_games + cascades).
                -- pushed_at NULL = needs (re)enqueue to studio; content_hash
                -- detects post-game edits so we only re-emit on real change.
                -- archived_at NULL = still in the active list; NOT NULL = archived.
                CREATE TABLE IF NOT EXISTS lg_game_summaries (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    summary_uuid    TEXT    NOT NULL UNIQUE,
                    launched_game_id INTEGER NULL,
                    client_id       INTEGER NOT NULL,
                    game_uniqid     TEXT    NOT NULL,
                    name            TEXT    NOT NULL,
                    game_type       TEXT    NOT NULL,
                    played_at       TEXT    NULL,
                    teams_launched  INTEGER NULL,
                    teams_played    INTEGER NOT NULL,
                    players_played  INTEGER NOT NULL,
                    content_hash    TEXT    NULL,
                    pushed_at       TEXT    NULL,
                    archived_at     TEXT    NULL,
                    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
                    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_lgsum_client_archived
                    ON lg_game_summaries(client_id, archived_at);
                CREATE INDEX IF NOT EXISTS idx_lgsum_needs_push
                    ON lg_game_summaries(pushed_at);

                UPDATE schema_meta SET value = '14' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "recovery_codes: offline, admin-issued one-time PIN-recovery codes (per-device burn) + sync state",
            sql: r#"
                -- The client's pool of admin-issued recovery codes, synced down
                -- from studio (plaintext over TLS) and stored here as salted
                -- PBKDF2 hashes only — same "UX gate, not crypto" threat model
                -- as device_pin (see services/pinStore.ts). A code is consumed
                -- ONCE PER DEVICE: used_at flips locally on use, so the same
                -- code can still be used once on a different device. Entering a
                -- valid code clears the device PIN (all exit gates then bypass).
                --
                -- code_index is the code's stable 1..N position in the admin's
                -- pool (identity for the best-effort report-up to studio).
                -- pool_version mirrors the synced version; replacing the pool
                -- (admin "Regenerate all") clears this table and re-inserts.
                -- All rows in a pool share one salt (generated on the device
                -- when the pool is stored) so a verify hashes the typed code
                -- once and compares against every unused hash.
                CREATE TABLE IF NOT EXISTS recovery_codes (
                    code_index     INTEGER PRIMARY KEY,
                    code_hash      TEXT    NOT NULL,
                    salt           TEXT    NOT NULL,
                    kdf_iterations INTEGER NOT NULL,
                    pool_version   REAL    NOT NULL,
                    used_at        TEXT    NULL,
                    reported_at    TEXT    NULL
                );

                -- Incremental version compare for the sync orchestrator, like
                -- name_pools_state / cards_state.
                CREATE TABLE IF NOT EXISTS recovery_codes_state (
                    client_id       INTEGER PRIMARY KEY,
                    remote_version  REAL,
                    local_version   REAL,
                    fetched_at      TEXT,
                    failed_attempts INTEGER NOT NULL DEFAULT 0
                );

                UPDATE schema_meta SET value = '15' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "lg_teams.language: per-team display language (self-register flags + operator selects)",
            sql: r#"
                -- Each team's chosen display language (2-letter ISO, e.g. 'fr').
                -- Set from the self-register overlay flag radios (player) or the
                -- operator team-details / add-team selects. NULL ⇒ fall back to
                -- the launched game's launch language everywhere it's read.
                ALTER TABLE lg_teams ADD COLUMN language TEXT NULL;

                UPDATE schema_meta SET value = '16' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "clash game type: clan membership, credited validations, consumed punches",
            sql: r#"
                -- Clan membership: binds a SportIdent chip to a clan (an lg_teams
                -- row). UNIQUE(launched_game_id, chip_id) ⇒ a chip joins exactly
                -- one clan, so max-per-clan + greying are enforced from
                -- per-clan member counts. Server-authoritative so concurrent
                -- multi-station registration can't double-bind or overfill.
                CREATE TABLE IF NOT EXISTS lg_clash_members (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    launched_game_id INTEGER NOT NULL,
                    team_id INTEGER NOT NULL,
                    chip_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    UNIQUE(launched_game_id, chip_id),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
                    FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_lgcm_game_team ON lg_clash_members(launched_game_id, team_id);

                -- Credited combination validations. One row per credited combo ⇒
                -- volume = row count over a territory's combos; last-validator =
                -- the row with the greatest `seq` among them. `seq` is a per-game
                -- monotonic counter assigned under the SQLite write lock, giving a
                -- total order across stations.
                CREATE TABLE IF NOT EXISTS lg_clash_validations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    launched_game_id INTEGER NOT NULL,
                    team_id INTEGER NOT NULL,
                    chip_id INTEGER NOT NULL,
                    combo_index INTEGER NOT NULL,
                    territory_index INTEGER NOT NULL,
                    seq INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
                    FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_lgcv_game ON lg_clash_validations(launched_game_id);
                CREATE INDEX IF NOT EXISTS idx_lgcv_game_terr ON lg_clash_validations(launched_game_id, territory_index);

                -- Consumed punches: a physical punch (chip + station + time) can
                -- only be banked once. Keyed per chip so two players in the same
                -- clan re-bipping the same combo each get credit (their punches
                -- are distinct), while one card's punches never re-score. UNIQUE
                -- makes re-presented / poll-echoed reads idempotent.
                CREATE TABLE IF NOT EXISTS lg_clash_consumed (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    launched_game_id INTEGER NOT NULL,
                    chip_id INTEGER NOT NULL,
                    punch_key TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                    UNIQUE(launched_game_id, chip_id, punch_key),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE
                );

                UPDATE schema_meta SET value = '17' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "report_layouts: synced per-game-type mission-report PDF layout defaults + version state",
            sql: r#"
                -- Global (admin-owned) default mission-report layout per game
                -- type, synced from studio (playground.php get_report_layouts).
                -- One row per game type; layout_json is the block-layout document
                -- the report renderer consumes. Per-scenario overrides do NOT
                -- live here — they ride in the scenario game_data (game_meta).
                -- If absent/unsynced, the renderer falls back to the built-in
                -- code default in services/reportLayout.ts.
                CREATE TABLE IF NOT EXISTS report_layouts (
                    game_type   TEXT PRIMARY KEY,
                    layout_json TEXT NOT NULL
                );

                -- Single-row incremental version compare for the sync
                -- orchestrator (global, so id is pinned to 1), like
                -- recovery_codes_state but not client-scoped.
                CREATE TABLE IF NOT EXISTS report_layouts_state (
                    id              INTEGER PRIMARY KEY CHECK (id = 1),
                    remote_version  INTEGER,
                    local_version   INTEGER,
                    fetched_at      TEXT,
                    failed_attempts INTEGER NOT NULL DEFAULT 0
                );

                UPDATE schema_meta SET value = '18' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "wifi_networks: remembered Wi-Fi creds + per-network auto-connect consent",
            sql: r#"
                -- One row per Wi-Fi network the device may auto-join. Populated
                -- by Feature A (mother creds piggybacked on the ping response,
                -- origin='paired') and later Feature B (studio relay, origin=
                -- 'studio'). The auto-connect engine (services/wifiAutoConnect.ts)
                -- reads this regardless of origin.
                --   auto_connect: NULL = never asked, 0 = declined, 1 = consented.
                -- Creds are last-write-wins; the consent flag is NEVER reset by an
                -- upsert (so a refreshed password keeps the user's choice).
                CREATE TABLE IF NOT EXISTS wifi_networks (
                    ssid             TEXT PRIMARY KEY,
                    password         TEXT NOT NULL,
                    source           TEXT NOT NULL DEFAULT 'hotspot',
                    origin           TEXT NOT NULL DEFAULT 'paired',
                    auto_connect     INTEGER,
                    updated_at       TEXT,
                    last_connected_at TEXT
                );

                UPDATE schema_meta SET value = '19' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "sync_item_failures: per-item content-sync failure tracker (operator detail + studio report lifecycle)",
            sql: r#"
                -- One row per content-sync work item that is CURRENTLY failing to
                -- download. Drives both the operator's "items that failed to sync"
                -- panel (immediate, every failure) and the studio failure report
                -- (only after consecutive_failures >= 2 — see services/syncFailures.ts).
                -- The row is DELETED the moment the item downloads successfully or
                -- becomes obsolete (content unassigned in studio); studio keeps the
                -- durable history, locally we only track what's stuck right now.
                --
                --   item_key:             version-INDEPENDENT stable key (syncItemKey),
                --                         e.g. 'scenario_media:<uniqid>:<filename>'.
                --   consecutive_failures: increments once per attempted-and-failed
                --                         cycle; the N=2 promote gate reads it.
                --   reported_failed:      1 once a sync_item_failed event has been
                --                         enqueued for this item (so resolve is only
                --                         reported for items studio actually saw).
                --   reported_error_sig:   hash of the last reported error signature;
                --                         a change re-enqueues a failed event (cadence c).
                CREATE TABLE IF NOT EXISTS sync_item_failures (
                    item_key             TEXT PRIMARY KEY,
                    kind                 TEXT NOT NULL,
                    label                TEXT NOT NULL,
                    version              INTEGER,
                    error_type           TEXT,
                    error_message        TEXT,
                    http_status          INTEGER,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    first_failed_at      TEXT,
                    last_failed_at       TEXT,
                    reported_failed      INTEGER NOT NULL DEFAULT 0,
                    reported_error_sig   TEXT
                );

                UPDATE schema_meta SET value = '20' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "patterns.is_local: flags manually-imported patterns so the sync tombstone (which deletes anything not in the cloud manifest) never removes an offline file import",
            sql: r#"
                ALTER TABLE patterns ADD COLUMN is_local INTEGER NOT NULL DEFAULT 0;
                UPDATE schema_meta SET value = '21' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "auth_user.language: per-client UI language (fr/en/es), seeds onboarding default",
            sql: r#"
                -- The client's account language, delivered in the bootstrap
                -- auth_state. Used by first-launch onboarding to default the UI
                -- language (unless the operator explicitly picked one). Existing
                -- rows take the 'fr' default; the next bootstrap overwrites it
                -- with the server value. Design: project_client_language.
                ALTER TABLE auth_user ADD COLUMN language TEXT NOT NULL DEFAULT 'fr';

                UPDATE schema_meta SET value = '22' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 23,
            description: "incremental scenario sync (CAS): content-hash gate + per-file active manifest",
            sql: r#"
                -- remote_content_hash: the studio's Tier-1 hash for the scenario
                -- (sha256 over data_hash + sorted media hashes), set from the
                -- manifest. local_content_hash: the remote hash we last fully
                -- reconciled our (possibly operator-only subset) download against.
                -- The download gate is local_content_hash IS NULL OR <> remote.
                -- The legacy remote_version/local_version columns are kept for
                -- display only. Design: project_scenario_incremental_sync_cas.
                ALTER TABLE scenarios ADD COLUMN remote_content_hash TEXT;
                ALTER TABLE scenarios ADD COLUMN local_content_hash TEXT;

                -- The currently-active per-file manifest for each downloaded
                -- scenario: rel_path -> content_hash. The scenario_protocol
                -- handler resolves scenario://{uniqid}/{rel_path} through this
                -- into media/blobs/{first2}/{hash}. Replaced transactionally on
                -- each scenario commit. game-data.json is a row too (its hash is
                -- the scenario's data_hash). Also the reference set for blob GC.
                CREATE TABLE IF NOT EXISTS scenario_files (
                    uniqid       TEXT NOT NULL,
                    rel_path     TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    PRIMARY KEY (uniqid, rel_path)
                );
                CREATE INDEX IF NOT EXISTS idx_scenario_files_hash ON scenario_files(content_hash);

                UPDATE schema_meta SET value = '23' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 24,
            description: "auth_user.update_channel: resolved app-update channel (stable|test)",
            sql: r#"
                -- The resolved app-update channel (device override -> client ->
                -- stable), delivered in the bootstrap auth_state. updateService
                -- reads it to pull builds from the matching release track; the
                -- navbar shows a TEST badge when it's 'test'. Existing rows take
                -- 'stable'; the next bootstrap overwrites with the server value.
                -- Design: project_client_tester_update_channel.
                ALTER TABLE auth_user ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable';

                UPDATE schema_meta SET value = '24' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 25,
            description: "paired_devices.screen_state_json: satellite-reported current screen (in_game/ranking/video/home) for the devices modal",
            sql: r#"
                -- Each satellite self-reports what it is currently showing (its
                -- top-most layer: a ranking/video overlay, the game board, or the
                -- home/idle screen) on every /ping.php heartbeat. The mother stores
                -- the opaque JSON blob here and returns it verbatim from
                -- list_paired_with_status so the Devices modal can render a live
                -- "what's it showing" pill per online peer. Freshness is gated by
                -- last_seen_at (offline rows never show a pill), so no separate
                -- screen_updated_at is needed. NULL = device hasn't reported yet
                -- (e.g. an older app build): the modal renders no pill, never a
                -- guessed state. Design: project_playground_device_screen_state.
                ALTER TABLE paired_devices ADD COLUMN screen_state_json TEXT NULL;

                UPDATE schema_meta SET value = '25' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 26,
            description: "auth_user device-lock fields + per-device reprieve deadline (emergency disable + billing auto-lock)",
            sql: r#"
                -- Emergency device-disable + billing auto-lock, cached from the
                -- bootstrap auth_state so the launch/join gate can be computed
                -- fully offline:
                --   locked = devices_disabled
                --         OR (billing_overdue_since IS NOT NULL
                --             AND now > billing_overdue_since + billing_grace_days)
                -- A valid recovery code sets billing_reprieve_until = now +
                -- billing_reprieve_days; while it is in the future the gate is
                -- lifted on THIS device only. Existing rows take the safe
                -- defaults (not disabled, 30-day grace, 7-day reprieve); the next
                -- bootstrap overwrites with the server values.
                -- Design: project_client_device_lock.
                ALTER TABLE auth_user ADD COLUMN devices_disabled INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE auth_user ADD COLUMN billing_overdue_since TEXT NULL;
                ALTER TABLE auth_user ADD COLUMN billing_grace_days INTEGER NOT NULL DEFAULT 30;
                ALTER TABLE auth_user ADD COLUMN billing_reprieve_days INTEGER NOT NULL DEFAULT 7;
                ALTER TABLE auth_user ADD COLUMN billing_reprieve_until TEXT NULL;

                UPDATE schema_meta SET value = '26' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 27,
            description: "auth_user.playground_enabled: master on/off for the Playground app",
            sql: r#"
                -- Master on/off for the Playground app, cached from the bootstrap
                -- auth_state. When 0 the whole app self-locks (a stronger lock than
                -- devices_disabled, which only blocks launch/join) — the client no
                -- longer owns the Playground product. The server also refuses to
                -- issue/refresh a token on the login endpoints (belt-and-suspenders).
                -- Existing rows default to 1 so a device that predates the column is
                -- never stranded; the next bootstrap overwrites with the server value.
                -- Design: project_client_app_section.
                ALTER TABLE auth_user ADD COLUMN playground_enabled INTEGER NOT NULL DEFAULT 1;

                UPDATE schema_meta SET value = '27' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 28,
            description: "auth_user brand-logo-on-reports: client flag + cached brand image bytes for offline report printing",
            sql: r#"
                -- "Use my logo on printed reports" (clients.report_use_brand_logo),
                -- cached from the bootstrap auth_state. brand_logo_url is the
                -- resolved remote brand image (uploaded company logo, else avatar);
                -- brand_logo_data is its bytes as a base64 data: URL, downloaded
                -- while online so mission reports can print the client's logo fully
                -- OFFLINE. The TS side re-downloads only when brand_logo_url changes
                -- (or no data is cached yet). When the flag is 0 or no brand image
                -- exists, reportPrint falls back to the bundled TagHunter logo.
                -- Design: project_report_layouts_editor_labels.
                ALTER TABLE auth_user ADD COLUMN report_use_brand_logo INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE auth_user ADD COLUMN brand_logo_url TEXT NULL;
                ALTER TABLE auth_user ADD COLUMN brand_logo_data TEXT NULL;

                UPDATE schema_meta SET value = '28' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 29,
            description: "mother-failover slice 0: epoch fencing column + state-version counter + satellite snapshot cache",
            sql: r#"
                -- Mother-failover foundation (behavior-neutral; read sides land
                -- in later slices). Design: plans/mother-failover-promote-any-device.md.
                --
                -- mother_epoch: per-game fencing counter. A promoted mother sets
                -- old+1; satellites and a revived old mother follow the highest
                -- epoch they see (split-brain guard, slice 6).
                ALTER TABLE lg_launched_games ADD COLUMN mother_epoch INTEGER NOT NULL DEFAULT 1;

                -- lg_state_version: monotonic per-mother counter bumped after each
                -- mutating launched_games action, so the /ping.php snapshot delivery
                -- (slice 1) can tell whether a satellite's cached copy is stale
                -- without diffing rows. Seeded at 0; nothing reads it yet.
                INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('lg_state_version', '0');

                -- mother_snapshots: each SATELLITE caches the latest snapshot per
                -- game here (one "latest" row per game) so any survivor can be
                -- promoted into a new mother. Written in slice 2, consumed in slice 4.
                CREATE TABLE IF NOT EXISTS mother_snapshots (
                    launched_game_id INTEGER PRIMARY KEY,
                    state_version    INTEGER NOT NULL,
                    mother_epoch     INTEGER NOT NULL,
                    snapshot_json    TEXT NOT NULL,
                    updated_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
                );

                UPDATE schema_meta SET value = '29' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 30,
            description: "launched_by_self flag so 'Cet appareil' can list only games this device launched or joined",
            sql: r#"
                -- launched_by_self: 1 when THIS device was the creating peer at
                -- launch time (set in create() when peer_id resolves to the local
                -- is_self row), independent of whether it registered as a playing
                -- device. Lets the "Cet appareil" section include server-only
                -- self-launches (no lg_launched_game_devices self row) while still
                -- dropping games this device merely HOSTED for other satellites.
                -- Adopt-snapshot (failover) inserts explicit columns and omits this
                -- one, so an adopted game defaults to 0 and is surfaced instead via
                -- its self participant row. Design: project_playground_cet_appareil_local_only.
                ALTER TABLE lg_launched_games ADD COLUMN launched_by_self INTEGER NOT NULL DEFAULT 0;

                UPDATE schema_meta SET value = '30' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 31,
            description: "clash v2: ended_at freeze timestamp + locked effectif (headcount) snapshot",
            sql: r#"
                -- Epoch-seconds moment the game was ended (timer expiry OR operator
                -- manual-end). Clash's per-minute domination scoring integrates up
                -- to min(now, start+duration, ended_at); without this an early
                -- manual-end would keep accruing points until the scheduled end.
                -- Generic column (harmless for other game types).
                ALTER TABLE lg_launched_games ADD COLUMN ended_at INTEGER NULL;

                -- Effectif (headcount) lock for clash score weighting. Snapshotted
                -- once when the operator starts the match (registration close), so
                -- the displayed weighted score/rate is stable for the whole game and
                -- mid-game roster edits don't retroactively re-scale scores. One row
                -- per clan; size may be 0 (an empty clan earns 0 and can't be the
                -- weighting divisor). Design: project_clash_game_type_design (V2).
                CREATE TABLE IF NOT EXISTS lg_clash_effectif (
                    launched_game_id INTEGER NOT NULL,
                    team_id INTEGER NOT NULL,
                    size INTEGER NOT NULL,
                    UNIQUE(launched_game_id, team_id),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
                    FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE
                );

                UPDATE schema_meta SET value = '31' WHERE key = 'version';
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 32,
            description: "clash: The Purge - one successful territory purge per clan",
            sql: r#"
                -- One row per SUCCESSFUL purge (rejected attempts leave no row).
                -- The purge zeroes the target territory's validation counts for
                -- everyone at its timestamp; compute_clash_standings replays
                -- these rows merged with lg_clash_validations by
                -- (created_at, seq) — seq shares the validations high-water so
                -- ordering within the same second is total. UNIQUE(game, team)
                -- enforces the once-per-clan quota at the DB level.
                -- Design: project_clash_purge_feature.
                CREATE TABLE IF NOT EXISTS lg_clash_purges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    launched_game_id INTEGER NOT NULL,
                    team_id INTEGER NOT NULL,
                    chip_id INTEGER NOT NULL,
                    territory_index INTEGER NOT NULL,
                    seq INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(launched_game_id, team_id),
                    FOREIGN KEY (launched_game_id) REFERENCES lg_launched_games(id) ON DELETE CASCADE,
                    FOREIGN KEY (team_id) REFERENCES lg_teams(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_lgcp_game ON lg_clash_purges(launched_game_id);

                UPDATE schema_meta SET value = '32' WHERE key = 'version';
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

// Streaming SHA-256 of a file, used to verify a downloaded scenario media blob
// against the studio-advertised hash before it's committed to the blob pool.
// Streams in 1 MiB chunks so a multi-hundred-MB video never lands in memory
// (the WebView heap can't take it). Returns the lowercase hex digest.
#[tauri::command]
async fn sha256_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut file = std::fs::File::open(&path).map_err(|e| format!("open {path} failed: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            let n = file.read(&mut buf).map_err(|e| format!("read {path} failed: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

#[cfg(target_os = "windows")]
async fn parse_ssid_from_platform() -> Result<Option<String>, String> {
    // CREATE_NO_WINDOW: this command runs on a 10s footer/LAN poll; without it
    // a console window flashes every tick once the device is Wi-Fi connected.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = tokio::process::Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .creation_flags(CREATE_NO_WINDOW)
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

// ─────────────────────────────────────────────────────────────────────────────
// Wi-Fi auto-join primitives (satellite side).
// `scan_wifi` lists currently-visible SSIDs so the JS engine only attempts a
// join when the target AP is in range (avoids needlessly dropping the current
// connection). `connect_wifi` joins an SSID with a WPA2 passphrase. Windows is
// the flagship (netsh); mac/Linux are best-effort; Android joins natively via a
// WifiNetworkSuggestion (separate slice) so the desktop command errors there.
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn scan_wifi() -> Result<Vec<String>, String> {
    scan_wifi_platform().await
}

#[tauri::command]
async fn connect_wifi(ssid: String, password: String) -> Result<(), String> {
    if ssid.is_empty() {
        return Err("ssid is empty".into());
    }
    connect_wifi_platform(&ssid, &password).await
}

#[cfg(target_os = "windows")]
async fn scan_wifi_platform() -> Result<Vec<String>, String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = tokio::process::Command::new("netsh")
        .args(["wlan", "show", "networks", "mode=ssid"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    // Lines look like: "SSID 1 : TagHunter-3f9a1c2b". Capture the value after
    // the first colon; skip the empty "broadcast hidden" entries.
    let re = regex::Regex::new(r"(?m)^\s*SSID\s+\d+\s*:\s*(.*)$").map_err(|e| e.to_string())?;
    let mut out_ssids = Vec::new();
    for c in re.captures_iter(&text) {
        let s = c[1].trim().to_string();
        if !s.is_empty() && !out_ssids.contains(&s) {
            out_ssids.push(s);
        }
    }
    Ok(out_ssids)
}

#[cfg(target_os = "windows")]
async fn connect_wifi_platform(ssid: &str, password: &str) -> Result<(), String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // netsh can only `connect` to a network it has a profile for, so add (or
    // refresh) a WPA2PSK profile from an XML file first. SSIDs/passwords here
    // are app-generated and XML-escaped; we still escape defensively.
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let profile = format!(
        r#"<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>{ssid}</name>
  <SSIDConfig><SSID><name>{ssid}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>{pw}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>"#,
        ssid = esc(ssid),
        pw = esc(password),
    );
    let mut path = std::env::temp_dir();
    path.push(format!("taghunter-wlan-{}.xml", ssid.replace(|c: char| !c.is_alphanumeric(), "_")));
    std::fs::write(&path, profile.as_bytes()).map_err(|e| e.to_string())?;

    // A WLAN profile for this SSID may already exist - from a previous connect on
    // this device, or pushed via Group Policy. `netsh add profile` REFUSES to
    // overwrite such a profile ("Un profil portant ce nom existe déjà ... et ne
    // peut pas être remplacé"), which used to abort the whole connect. Delete our
    // own copy first so the fresh add (carrying the CURRENT password) takes; a
    // group-policy profile can't be deleted, but then we simply connect using it.
    // Best-effort: a "profile not found" delete is a harmless no-op.
    let _ = tokio::process::Command::new("netsh")
        .args(["wlan", "delete", "profile"])
        .arg(format!("name={ssid}"))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await;

    let add = tokio::process::Command::new("netsh")
        .args(["wlan", "add", "profile"])
        .arg(format!("filename={}", path.display()))
        .arg("user=current")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    // Don't fail on an add error: if the profile already existed (Group Policy),
    // the connect below uses THAT profile. Keep the add error only to enrich a
    // subsequent connect failure.
    let add_err = if add.status.success() {
        None
    } else {
        Some(String::from_utf8_lossy(&add.stdout).trim().to_string())
    };

    let conn = tokio::process::Command::new("netsh")
        .args(["wlan", "connect"])
        .arg(format!("name={ssid}"))
        .arg(format!("ssid={ssid}"))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if conn.status.success() {
        return Ok(());
    }

    // Connect failed. A failed add (no usable profile) is the more actionable root
    // cause than the generic connect error, so surface it when present.
    let conn_err = String::from_utf8_lossy(&conn.stdout).trim().to_string();
    Err(match add_err {
        Some(a) => format!("netsh connect failed: {conn_err} (add profile: {a})"),
        None => format!("netsh connect failed: {conn_err}"),
    })
}

#[cfg(target_os = "macos")]
async fn scan_wifi_platform() -> Result<Vec<String>, String> {
    let out = tokio::process::Command::new(
        "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
    )
    .arg("-s")
    .output()
    .await
    .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    // First column (whitespace-delimited) of each line after the header is the SSID.
    let mut ssids = Vec::new();
    for line in text.lines().skip(1) {
        if let Some(s) = line.trim().split("  ").next() {
            let s = s.trim().to_string();
            if !s.is_empty() && !ssids.contains(&s) {
                ssids.push(s);
            }
        }
    }
    Ok(ssids)
}

#[cfg(target_os = "macos")]
async fn connect_wifi_platform(ssid: &str, password: &str) -> Result<(), String> {
    let out = tokio::process::Command::new("networksetup")
        .args(["-setairportnetwork", "en0", ssid, password])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

#[cfg(target_os = "linux")]
async fn scan_wifi_platform() -> Result<Vec<String>, String> {
    let out = tokio::process::Command::new("nmcli")
        .args(["-t", "-f", "SSID", "dev", "wifi"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut ssids = Vec::new();
    for line in text.lines() {
        let s = line.trim().to_string();
        if !s.is_empty() && !ssids.contains(&s) {
            ssids.push(s);
        }
    }
    Ok(ssids)
}

#[cfg(target_os = "linux")]
async fn connect_wifi_platform(ssid: &str, password: &str) -> Result<(), String> {
    let out = tokio::process::Command::new("nmcli")
        .args(["dev", "wifi", "connect", ssid, "password", password])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn scan_wifi_platform() -> Result<Vec<String>, String> {
    // Android auto-join is system-mediated (WifiNetworkSuggestion); a separate
    // native slice will handle it. Returning empty makes the JS engine skip the
    // "in range?" gate without erroring the whole flow.
    Ok(Vec::new())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn connect_wifi_platform(_ssid: &str, _password: &str) -> Result<(), String> {
    Err("connect_wifi not implemented on mobile (use the native suggestion path)".to_string())
}
