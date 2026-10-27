//! The licence snapshot ("Accès hors ligne N jours restants") shared between
//! devices on the LAN, so ONE device reaching the studio renews the offline
//! allowance of all of them.
//!
//! Each device keeps the licence it last got in `auth_user`, stamped with the
//! studio's own clock (`licence_as_of_ms`, from auth_state.server_time). The
//! snapshot rides on /ping.php both ways: the satellite sends its copy in the
//! body, the mother adopts it when newer and replies with its (now newest)
//! copy, which the satellite adopts in turn. Every satellite pings the mother,
//! so the newest snapshot reaches all of them within two pings. The studio
//! clock is the only order: a device's own clock never decides.
//!
//! The whole licence travels, not only the date: a device kept alive by a peer
//! also gets the account's current locks (app disabled, devices disabled,
//! billing overdue). Device-local fields (update channel, recovery-code
//! reprieve, brand logo) stay put. Trust is the pairing's: same licensee only.

use chrono::{SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio_rusqlite::Connection as DbConnection;

/// Emitted when a peer's snapshot replaced ours. The renderer re-reads
/// auth_user (AuthProvider) and a device on the offline lock screen unlocks.
pub(crate) const LICENCE_ADOPTED_EVENT: &str = "taghunter://licence-adopted";

/// A stamp this far past our clock is refused: one bogus far-future stamp would
/// otherwise outrank every real studio check for ever.
const FUTURE_TOLERANCE_MS: i64 = 24 * 60 * 60 * 1000;

/// An online device refreshes its stamp on every studio reply. Below this
/// advance, an unchanged licence is not rewritten (and the renderer not woken)
/// on every 10 s ping.
const MIN_ADVANCE_MS: i64 = 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Licence {
    pub client_id: i64,
    pub as_of_ms: i64,
    pub license_type: String,
    pub billing_up_to_date: bool,
    pub max_devices: i64,
    pub offline_grace_days: i64,
    pub devices_disabled: bool,
    #[serde(default)]
    pub billing_overdue_since: Option<String>,
    pub billing_grace_days: i64,
    pub billing_reprieve_days: i64,
    pub playground_enabled: bool,
}

impl Licence {
    fn same_terms(&self, other: &Licence) -> bool {
        Licence { as_of_ms: 0, ..self.clone() } == Licence { as_of_ms: 0, ..other.clone() }
    }

    fn plausible(&self, now_ms: i64) -> bool {
        self.as_of_ms > 0
            && self.as_of_ms <= now_ms + FUTURE_TOLERANCE_MS
            && (0..=3650).contains(&self.offline_grace_days)
            && !self.license_type.is_empty()
            && self.license_type.len() <= 64
            && self.billing_overdue_since.as_deref().map_or(true, |s| s.len() <= 40)
    }
}

/// This device's licence, None when signed out or never stamped.
pub(crate) fn read_local(c: &Connection) -> rusqlite::Result<Option<Licence>> {
    c.query_row(
        "SELECT client_id, licence_as_of_ms, license_type, billing_up_to_date, max_devices,
                offline_grace_days, devices_disabled, billing_overdue_since,
                billing_grace_days, billing_reprieve_days, playground_enabled
           FROM auth_user WHERE licence_as_of_ms IS NOT NULL LIMIT 1",
        [],
        |r| {
            Ok(Licence {
                client_id: r.get(0)?,
                as_of_ms: r.get(1)?,
                license_type: r.get(2)?,
                billing_up_to_date: r.get::<_, i64>(3)? != 0,
                max_devices: r.get(4)?,
                offline_grace_days: r.get(5)?,
                devices_disabled: r.get::<_, i64>(6)? != 0,
                billing_overdue_since: r.get(7)?,
                billing_grace_days: r.get(8)?,
                billing_reprieve_days: r.get(9)?,
                playground_enabled: r.get::<_, i64>(10)? != 0,
            })
        },
    )
    .optional()
}

/// Replace our licence with `theirs` when it is the same licensee's and a
/// newer studio check. Also moves `last_server_check_at` (what the offline
/// countdown reads) to that check, never backwards. Returns true if adopted.
pub(crate) fn adopt(c: &Connection, theirs: &Licence, now_ms: i64) -> rusqlite::Result<bool> {
    if !theirs.plausible(now_ms) {
        return Ok(false);
    }
    let ours: Option<(i64, i64)> = c
        .query_row(
            "SELECT client_id, COALESCE(licence_as_of_ms, 0) FROM auth_user LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((client_id, our_as_of)) = ours else { return Ok(false) };
    if client_id != theirs.client_id || theirs.as_of_ms <= our_as_of {
        return Ok(false);
    }
    if theirs.as_of_ms - our_as_of < MIN_ADVANCE_MS {
        if let Some(local) = read_local(c)? {
            if local.same_terms(theirs) {
                return Ok(false);
            }
        }
    }
    let checked_at = Utc
        .timestamp_millis_opt(theirs.as_of_ms.min(now_ms))
        .single()
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default();
    let n = c.execute(
        "UPDATE auth_user SET
           license_type = ?1, billing_up_to_date = ?2, max_devices = ?3,
           offline_grace_days = ?4, devices_disabled = ?5, billing_overdue_since = ?6,
           billing_grace_days = ?7, billing_reprieve_days = ?8, playground_enabled = ?9,
           licence_as_of_ms = ?10,
           last_server_check_at = CASE WHEN last_server_check_at < ?11 THEN ?11
                                       ELSE last_server_check_at END
         WHERE client_id = ?12 AND COALESCE(licence_as_of_ms, 0) < ?10",
        params![
            theirs.license_type,
            theirs.billing_up_to_date as i64,
            theirs.max_devices,
            theirs.offline_grace_days,
            theirs.devices_disabled as i64,
            theirs.billing_overdue_since,
            theirs.billing_grace_days,
            theirs.billing_reprieve_days,
            theirs.playground_enabled as i64,
            theirs.as_of_ms,
            checked_at,
            theirs.client_id,
        ],
    )?;
    Ok(n > 0)
}

/// Our licence as the JSON a ping carries (Null when we have none).
pub(crate) async fn local_value(conn: &DbConnection) -> Value {
    conn.call(|c: &mut Connection| -> tokio_rusqlite::Result<Option<Licence>> { Ok(read_local(c)?) })
        .await
        .ok()
        .flatten()
        .and_then(|l| serde_json::to_value(l).ok())
        .unwrap_or(Value::Null)
}

/// Adopt the licence a peer sent (None/Null/malformed = nothing) and tell the
/// renderer when it replaced ours. Best-effort: a failure leaves ours intact.
pub(crate) async fn adopt_from_peer(app: &AppHandle, conn: &DbConnection, v: Option<&Value>) {
    let Some(theirs) = v
        .filter(|v| v.is_object())
        .and_then(|v| serde_json::from_value::<Licence>(v.clone()).ok())
    else {
        return;
    };
    let now_ms = Utc::now().timestamp_millis();
    let adopted = conn
        .call(move |c: &mut Connection| -> tokio_rusqlite::Result<bool> { Ok(adopt(c, &theirs, now_ms)?) })
        .await
        .unwrap_or(false);
    if adopted {
        let _ = app.emit(LICENCE_ADOPTED_EVENT, ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;
    const DAY: i64 = 24 * 60 * 60 * 1000;

    fn db(as_of: Option<i64>, checked_at: &str) -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE auth_user (client_id INTEGER PRIMARY KEY, license_type TEXT NOT NULL,
               billing_up_to_date INTEGER NOT NULL, max_devices INTEGER NOT NULL,
               offline_grace_days INTEGER NOT NULL, devices_disabled INTEGER NOT NULL DEFAULT 0,
               billing_overdue_since TEXT NULL, billing_grace_days INTEGER NOT NULL DEFAULT 30,
               billing_reprieve_days INTEGER NOT NULL DEFAULT 7,
               playground_enabled INTEGER NOT NULL DEFAULT 1,
               update_channel TEXT NOT NULL DEFAULT 'stable',
               last_server_check_at TEXT NOT NULL, licence_as_of_ms INTEGER NULL);",
        )
        .unwrap();
        c.execute(
            "INSERT INTO auth_user (client_id, license_type, billing_up_to_date, max_devices,
               offline_grace_days, update_channel, last_server_check_at, licence_as_of_ms)
             VALUES (7, 'standard', 1, 6, 90, 'test', ?1, ?2)",
            params![checked_at, as_of],
        )
        .unwrap();
        c
    }

    fn lic(as_of_ms: i64) -> Licence {
        Licence {
            client_id: 7,
            as_of_ms,
            license_type: "standard".into(),
            billing_up_to_date: true,
            max_devices: 6,
            offline_grace_days: 90,
            devices_disabled: false,
            billing_overdue_since: None,
            billing_grace_days: 30,
            billing_reprieve_days: 7,
            playground_enabled: true,
        }
    }

    fn checked_at(c: &Connection) -> String {
        c.query_row("SELECT last_server_check_at FROM auth_user", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn newer_check_renews_the_countdown_and_the_terms() {
        let c = db(Some(NOW - 80 * DAY), "2026-08-01T00:00:00.000Z");
        let theirs = Licence { devices_disabled: true, ..lic(NOW - DAY) };
        assert!(adopt(&c, &theirs, NOW).unwrap());
        let local = read_local(&c).unwrap().unwrap();
        assert_eq!(local, theirs);
        assert!(checked_at(&c) > "2026-08-01T00:00:00.000Z".to_string());
        // Device-local fields are not part of the snapshot.
        let ch: String = c.query_row("SELECT update_channel FROM auth_user", [], |r| r.get(0)).unwrap();
        assert_eq!(ch, "test");
    }

    #[test]
    fn older_or_equal_check_is_ignored() {
        let c = db(Some(NOW - DAY), "2026-10-01T00:00:00.000Z");
        assert!(!adopt(&c, &lic(NOW - 2 * DAY), NOW).unwrap());
        assert!(!adopt(&c, &lic(NOW - DAY), NOW).unwrap());
    }

    #[test]
    fn other_licensee_is_ignored() {
        let c = db(Some(NOW - 80 * DAY), "2026-08-01T00:00:00.000Z");
        assert!(!adopt(&c, &Licence { client_id: 8, ..lic(NOW) }, NOW).unwrap());
    }

    #[test]
    fn far_future_stamp_is_refused() {
        let c = db(Some(NOW - DAY), "2026-10-01T00:00:00.000Z");
        assert!(!adopt(&c, &lic(NOW + 2 * DAY), NOW).unwrap());
    }

    #[test]
    fn small_advance_only_counts_when_terms_changed() {
        let c = db(Some(NOW - 10_000), "2026-10-01T00:00:00.000Z");
        assert!(!adopt(&c, &lic(NOW), NOW).unwrap());
        assert!(adopt(&c, &Licence { playground_enabled: false, ..lic(NOW) }, NOW).unwrap());
    }

    #[test]
    fn unstamped_device_adopts_and_countdown_never_moves_back() {
        let c = db(None, "2099-01-01T00:00:00.000Z");
        assert!(read_local(&c).unwrap().is_none());
        assert!(adopt(&c, &lic(NOW), NOW).unwrap());
        assert_eq!(checked_at(&c), "2099-01-01T00:00:00.000Z");
    }

    #[test]
    fn signed_out_device_adopts_nothing() {
        let c = db(None, "x");
        c.execute("DELETE FROM auth_user", []).unwrap();
        assert!(!adopt(&c, &lic(NOW), NOW).unwrap());
    }
}
