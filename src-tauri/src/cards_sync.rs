//! Chip (card) list sharing between devices on the LAN, for venues with no
//! internet. Two things travel between a satellite and its mother in one
//! exchange (`/content.php?action=cards_exchange`, driven by the satellite):
//!
//! - the SYNCED list: whoever holds the newer studio version (cards_state
//!   .local_version - the studio bumps it on every change) hands its list to
//!   the other, applied like a studio pull (pending rows are never touched);
//! - the PENDING edits (made offline, not yet pushed to the studio): each is
//!   stamped (edited_at_ms in mother time, edited_by = device uuid, a fresh
//!   mutation_id per edit) and merged per chip - the later edit wins. Whichever
//!   device reaches the studio first pushes it; the studio accepts a replay of
//!   an identical edit, and `acks` (mutation ids some device already pushed)
//!   travel too so the others mark theirs synced instead of pushing it again.
//!
//! The merge lives here only (mother handler + satellite command share it) so
//! the two sides can never disagree on who wins.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// Acks older than this are dropped: by then every device has synced.
const ACK_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;
pub(crate) const CARDS_MERGED_EVENT: &str = "taghunter://cards-merged";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CardMutation {
    pub id: i64,
    /// create | update | delete
    pub op: String,
    pub key_number: i64,
    pub key_name: String,
    pub color: Option<String>,
    pub edited_at_ms: i64,
    pub edited_by: String,
    pub mutation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CardRow {
    pub id: i64,
    pub key_number: i64,
    pub key_name: String,
    pub color: Option<String>,
}

/// One side of an exchange (request or reply).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct CardsPayload {
    pub client_id: i64,
    /// cards_state.local_version: the studio version our synced list is at.
    pub version: Option<f64>,
    /// Our synced list - only sent when it may be the newer one.
    #[serde(default)]
    pub snapshot: Option<Vec<CardRow>>,
    #[serde(default)]
    pub pending: Vec<CardMutation>,
    #[serde(default)]
    pub acks: Vec<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn local_version(c: &Connection, client_id: i64) -> rusqlite::Result<Option<f64>> {
    Ok(c.query_row(
        "SELECT local_version FROM cards_state WHERE client_id = ?",
        params![client_id],
        |r| r.get::<_, Option<f64>>(0),
    )
    .optional()?
    .flatten())
}

/// Our unpushed edits. A pending row from before edit stamping gets a
/// mutation id now (edited_at_ms 0: any stamped edit beats it).
pub(crate) fn list_pending(c: &Connection) -> rusqlite::Result<Vec<CardMutation>> {
    let unstamped: Vec<i64> = c
        .prepare("SELECT id FROM cards WHERE sync_state = 'pending' AND mutation_id IS NULL")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for id in unstamped {
        c.execute(
            "UPDATE cards SET mutation_id = ?, edited_at_ms = COALESCE(edited_at_ms, 0), edited_by = COALESCE(edited_by, '')
              WHERE id = ? AND mutation_id IS NULL",
            params![uuid::Uuid::new_v4().to_string(), id],
        )?;
    }
    let mut st = c.prepare(
        "SELECT id, operation, key_number, key_name, color, COALESCE(edited_at_ms, 0), COALESCE(edited_by, ''), mutation_id
           FROM cards WHERE sync_state = 'pending' AND operation IS NOT NULL ORDER BY id",
    )?;
    let rows = st
        .query_map([], |r| {
            Ok(CardMutation {
                id: r.get(0)?,
                op: r.get(1)?,
                key_number: r.get(2)?,
                key_name: r.get(3)?,
                color: r.get(4)?,
                edited_at_ms: r.get(5)?,
                edited_by: r.get(6)?,
                mutation_id: r.get(7)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub(crate) fn list_acks(c: &Connection) -> rusqlite::Result<Vec<String>> {
    c.execute(
        "DELETE FROM card_mutation_acks WHERE acked_at < ?",
        params![now_ms() - ACK_TTL_MS],
    )?;
    let mut st = c.prepare("SELECT mutation_id FROM card_mutation_acks")?;
    let rows = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Our studio-synced rows. A row with a pending edit holds OUR values, not
/// the studio's, so it is left out (sending it as "synced" would make the
/// receiver drop the edit and keep values the studio may refuse). The edit
/// travels in `pending` instead: the receiver's merge, which runs right after
/// the snapshot, re-creates it there as a pending edit.
pub(crate) fn snapshot(c: &Connection) -> rusqlite::Result<Vec<CardRow>> {
    let mut st = c.prepare(
        "SELECT id, key_number, key_name, color FROM cards WHERE sync_state = 'synced' ORDER BY id",
    )?;
    let rows = st
        .query_map([], |r| {
            Ok(CardRow { id: r.get(0)?, key_number: r.get(1)?, key_name: r.get(2)?, color: r.get(3)? })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// A newer synced list from a peer, applied like a studio pull
/// (cardsRepo.applyServerPull): pending rows are left alone, synced rows
/// follow the list, a synced row missing from it goes.
pub(crate) fn apply_snapshot(c: &Connection, client_id: i64, version: f64, rows: &[CardRow]) -> rusqlite::Result<()> {
    for card in rows {
        let local: Option<String> = c
            .query_row("SELECT sync_state FROM cards WHERE id = ?", params![card.id], |r| r.get(0))
            .optional()?;
        match local.as_deref() {
            None => {
                c.execute(
                    "INSERT INTO cards (id, key_number, key_name, color, sync_state, operation, updated_at)
                     VALUES (?, ?, ?, ?, 'synced', NULL, CURRENT_TIMESTAMP)",
                    params![card.id, card.key_number, card.key_name, card.color],
                )?;
            }
            Some("synced") => {
                c.execute(
                    "UPDATE cards SET key_number = ?, key_name = ?, color = ?, updated_at = CURRENT_TIMESTAMP
                      WHERE id = ? AND (key_number <> ? OR key_name <> ? OR color IS NOT ?)",
                    params![card.key_number, card.key_name, card.color, card.id, card.key_number, card.key_name, card.color],
                )?;
            }
            _ => {}
        }
    }
    let keep: std::collections::HashSet<i64> = rows.iter().map(|r| r.id).collect();
    let synced: Vec<i64> = c
        .prepare("SELECT id FROM cards WHERE sync_state = 'synced'")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for id in synced.into_iter().filter(|id| !keep.contains(id)) {
        c.execute("DELETE FROM cards WHERE id = ?", params![id])?;
    }
    c.execute(
        "INSERT INTO cards_state (client_id, remote_version, local_version, has_on_demand_cards, failed_attempts)
         VALUES (?, NULL, ?, 0, 0)
         ON CONFLICT(client_id) DO UPDATE SET local_version = excluded.local_version",
        params![client_id, version],
    )?;
    Ok(())
}

/// Edits some device already pushed to the studio: ours with that id are done.
pub(crate) fn apply_acks(c: &Connection, acks: &[String]) -> rusqlite::Result<()> {
    let now = now_ms();
    for m in acks {
        c.execute(
            "INSERT OR IGNORE INTO card_mutation_acks (mutation_id, acked_at) VALUES (?, ?)",
            params![m, now],
        )?;
        c.execute(
            "DELETE FROM cards WHERE mutation_id = ? AND sync_state = 'pending' AND operation = 'delete'",
            params![m],
        )?;
        c.execute(
            "UPDATE cards SET sync_state = 'synced', operation = NULL
              WHERE mutation_id = ? AND sync_state = 'pending'",
            params![m],
        )?;
    }
    Ok(())
}

fn is_acked(c: &Connection, mutation_id: &str) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM card_mutation_acks WHERE mutation_id = ?)",
        params![mutation_id],
        |r| r.get(0),
    )
}

/// Merge one peer edit into our table. Returns true when it changed a row.
pub(crate) fn merge_mutation(c: &Connection, m: &CardMutation) -> rusqlite::Result<bool> {
    if !matches!(m.op.as_str(), "create" | "update" | "delete") || is_acked(c, &m.mutation_id)? {
        return Ok(false);
    }
    struct Local {
        sync_state: String,
        op: Option<String>,
        key_number: i64,
        key_name: String,
        color: Option<String>,
        edited_at_ms: i64,
        edited_by: String,
        mutation_id: Option<String>,
    }
    let local = c
        .query_row(
            "SELECT sync_state, operation, key_number, key_name, color, COALESCE(edited_at_ms, 0),
                    COALESCE(edited_by, ''), mutation_id
               FROM cards WHERE id = ?",
            params![m.id],
            |r| {
                Ok(Local {
                    sync_state: r.get(0)?,
                    op: r.get(1)?,
                    key_number: r.get(2)?,
                    key_name: r.get(3)?,
                    color: r.get(4)?,
                    edited_at_ms: r.get(5)?,
                    edited_by: r.get(6)?,
                    mutation_id: r.get(7)?,
                })
            },
        )
        .optional()?;

    let write = |op: &str| -> rusqlite::Result<bool> {
        c.execute(
            "INSERT INTO cards (id, key_number, key_name, color, sync_state, operation, updated_at,
                                edited_at_ms, edited_by, mutation_id)
             VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               key_number = excluded.key_number, key_name = excluded.key_name, color = excluded.color,
               sync_state = 'pending', operation = excluded.operation, updated_at = CURRENT_TIMESTAMP,
               edited_at_ms = excluded.edited_at_ms, edited_by = excluded.edited_by,
               mutation_id = excluded.mutation_id",
            params![m.id, m.key_number, m.key_name, m.color, op, m.edited_at_ms, m.edited_by, m.mutation_id],
        )?;
        Ok(true)
    };

    let Some(l) = local else {
        // Unknown chip here: take the edit as ours to push (a delete too - we
        // may be the first device back online).
        return write(&m.op);
    };
    if l.mutation_id.as_deref() == Some(m.mutation_id.as_str()) {
        return Ok(false);
    }
    if l.sync_state != "pending" {
        // Our copy is the studio's: the edit applies on top of it.
        let same = l.key_number == m.key_number && l.key_name == m.key_name && l.color == m.color;
        return match m.op.as_str() {
            // Already what the studio holds: nothing to push.
            "create" | "update" if same => Ok(false),
            // The studio has the row: a peer's "create" is an update for us.
            "create" | "update" => write("update"),
            _ => write("delete"),
        };
    }
    // Both sides edited offline: the later edit wins (device uuid breaks a tie).
    let theirs_newer = (m.edited_at_ms, m.edited_by.as_str()) > (l.edited_at_ms, l.edited_by.as_str());
    if !theirs_newer {
        return Ok(false);
    }
    let op = match (l.op.as_deref(), m.op.as_str()) {
        (_, "delete") => "delete",
        // Not known to be in the studio yet: keep pushing it as a create (the
        // push falls back to an update if another device created it first).
        (Some("create"), _) | (_, "create") => "create",
        _ => "update",
    };
    write(op)
}

/// Apply a peer's side of an exchange. Returns how many rows changed.
pub(crate) fn apply_payload(c: &Connection, ours_client: i64, theirs: &CardsPayload) -> rusqlite::Result<usize> {
    let mut changed = 0;
    apply_acks(c, &theirs.acks)?;
    if let (Some(rows), Some(v)) = (&theirs.snapshot, theirs.version) {
        let mine = local_version(c, ours_client)?;
        if mine.map_or(true, |m| v > m) {
            apply_snapshot(c, ours_client, v, rows)?;
            changed += 1;
        }
    }
    for m in &theirs.pending {
        if merge_mutation(c, m)? {
            changed += 1;
        }
    }
    Ok(changed)
}

/// Our side of an exchange (the synced list only when asked to include it).
pub(crate) fn build_payload(c: &Connection, client_id: i64, with_snapshot: bool) -> rusqlite::Result<CardsPayload> {
    Ok(CardsPayload {
        client_id,
        version: local_version(c, client_id)?,
        snapshot: if with_snapshot { Some(snapshot(c)?) } else { None },
        pending: list_pending(c)?,
        acks: list_acks(c)?,
    })
}

// ─── mother: /content.php?action=cards_exchange ─────────────────────────────

/// Merge the satellite's side, reply with ours (our synced list only when it
/// is newer than the satellite's).
pub(crate) async fn mother_exchange(
    db: &tokio_rusqlite::Connection,
    app: &AppHandle,
    client_id: i64,
    theirs: CardsPayload,
) -> Result<Value, String> {
    let (reply, changed) = db
        .call(move |c: &mut Connection| -> tokio_rusqlite::Result<(CardsPayload, usize)> {
            let tx = c.transaction()?;
            let changed = apply_payload(&tx, client_id, &theirs)?;
            let mine = local_version(&tx, client_id)?;
            let send_snapshot = match (mine, theirs.version) {
                (Some(m), Some(t)) => m > t,
                (Some(_), None) => true,
                _ => false,
            };
            let reply = build_payload(&tx, client_id, send_snapshot)?;
            tx.commit()?;
            Ok((reply, changed))
        })
        .await
        .map_err(|e| e.to_string())?;
    if changed > 0 {
        let _ = app.emit(CARDS_MERGED_EVENT, ());
    }
    serde_json::to_value(reply).map_err(|e| e.to_string())
}

// ─── satellite: the exchange command ────────────────────────────────────────

/// Exchange chip lists and unpushed edits with the mother. Driven by the
/// satellite's renderer (services/peerContent). Returns the rows changed here.
#[tauri::command]
pub async fn client_cards_exchange(
    app: AppHandle,
    base_url: String,
    token: String,
    client_id: i64,
) -> Result<Value, String> {
    let conn = crate::lan_server::open_db_for_command(&app).await?;
    let ours = conn
        .call(move |c: &mut Connection| -> tokio_rusqlite::Result<CardsPayload> {
            // Always send our list: the mother takes it if it's newer.
            Ok(build_payload(c, client_id, true)?)
        })
        .await
        .map_err(|e| e.to_string())?;

    let client = crate::lan_server::lan_client_builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/content.php?action=cards_exchange", base_url.trim_end_matches('/')))
        .bearer_auth(token)
        .header("X-Client-Id", client_id.to_string())
        .json(&ours)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        return Err(format!("HTTP {}: {}", status.as_u16(), body));
    }
    let theirs: CardsPayload = resp.json().await.map_err(|e| e.to_string())?;
    if theirs.client_id != client_id {
        return Err("CLIENT_MISMATCH".into());
    }
    let changed = conn
        .call(move |c: &mut Connection| -> tokio_rusqlite::Result<usize> {
            let tx = c.transaction()?;
            let n = apply_payload(&tx, client_id, &theirs)?;
            tx.commit()?;
            Ok(n)
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "changed": changed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE cards (
                id INTEGER NOT NULL PRIMARY KEY, key_number INTEGER NOT NULL, key_name TEXT NOT NULL,
                color TEXT, sync_state TEXT NOT NULL DEFAULT 'synced', operation TEXT,
                updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                edited_at_ms INTEGER, edited_by TEXT, mutation_id TEXT);
             CREATE TABLE card_mutation_acks (mutation_id TEXT PRIMARY KEY, acked_at INTEGER NOT NULL);
             CREATE TABLE cards_state (client_id INTEGER PRIMARY KEY, remote_version INTEGER,
                local_version INTEGER, has_on_demand_cards INTEGER NOT NULL DEFAULT 0,
                on_demand_fetched_at TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        c
    }

    fn m(id: i64, op: &str, name: &str, at: i64, by: &str, mid: &str) -> CardMutation {
        CardMutation {
            id,
            op: op.into(),
            key_number: id,
            key_name: name.into(),
            color: None,
            edited_at_ms: at,
            edited_by: by.into(),
            mutation_id: mid.into(),
        }
    }

    fn row(c: &Connection, id: i64) -> Option<(String, Option<String>, String, Option<String>)> {
        c.query_row(
            "SELECT sync_state, operation, key_name, mutation_id FROM cards WHERE id = ?",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .unwrap()
    }

    fn synced(c: &Connection, id: i64, name: &str) {
        c.execute(
            "INSERT INTO cards (id, key_number, key_name, sync_state) VALUES (?, ?, ?, 'synced')",
            params![id, id, name],
        )
        .unwrap();
    }

    #[test]
    fn unknown_chip_is_adopted_as_pending() {
        let c = db();
        assert!(merge_mutation(&c, &m(7, "create", "Red", 10, "a", "m1")).unwrap());
        assert_eq!(row(&c, 7), Some(("pending".into(), Some("create".into()), "Red".into(), Some("m1".into()))));
    }

    #[test]
    fn same_mutation_is_a_noop() {
        let c = db();
        merge_mutation(&c, &m(7, "create", "Red", 10, "a", "m1")).unwrap();
        assert!(!merge_mutation(&c, &m(7, "create", "Red", 10, "a", "m1")).unwrap());
    }

    #[test]
    fn edit_on_synced_row_becomes_update() {
        let c = db();
        synced(&c, 3, "Old");
        assert!(merge_mutation(&c, &m(3, "create", "New", 10, "a", "m1")).unwrap());
        assert_eq!(row(&c, 3).unwrap().1.as_deref(), Some("update"));
        // identical to the studio copy: nothing to push
        let c2 = db();
        synced(&c2, 3, "Same");
        assert!(!merge_mutation(&c2, &m(3, "update", "Same", 10, "a", "m1")).unwrap());
        assert_eq!(row(&c2, 3).unwrap().0, "synced");
    }

    #[test]
    fn later_edit_wins_between_pending_rows() {
        let c = db();
        merge_mutation(&c, &m(5, "update", "Mine", 100, "a", "m1")).unwrap();
        // older peer edit loses
        assert!(!merge_mutation(&c, &m(5, "update", "Older", 50, "b", "m2")).unwrap());
        assert_eq!(row(&c, 5).unwrap().2, "Mine");
        // newer peer edit wins
        assert!(merge_mutation(&c, &m(5, "update", "Newer", 200, "b", "m3")).unwrap());
        assert_eq!(row(&c, 5).unwrap().2, "Newer");
        // tie on time: device uuid decides
        assert!(merge_mutation(&c, &m(5, "update", "Tie", 200, "c", "m4")).unwrap());
        assert_eq!(row(&c, 5).unwrap().2, "Tie");
    }

    #[test]
    fn op_combination() {
        let c = db();
        merge_mutation(&c, &m(1, "create", "A", 10, "a", "m1")).unwrap();
        merge_mutation(&c, &m(1, "update", "B", 20, "b", "m2")).unwrap();
        assert_eq!(row(&c, 1).unwrap().1.as_deref(), Some("create"));
        merge_mutation(&c, &m(1, "delete", "B", 30, "b", "m3")).unwrap();
        assert_eq!(row(&c, 1).unwrap().1.as_deref(), Some("delete"));
    }

    #[test]
    fn acks_settle_pending_rows_and_block_replays() {
        let c = db();
        merge_mutation(&c, &m(2, "update", "X", 10, "a", "m1")).unwrap();
        merge_mutation(&c, &m(4, "delete", "Y", 10, "a", "m2")).unwrap();
        apply_acks(&c, &["m1".into(), "m2".into()]).unwrap();
        assert_eq!(row(&c, 2).unwrap().0, "synced");
        assert_eq!(row(&c, 4), None);
        // an acked edit arriving later is ignored
        assert!(!merge_mutation(&c, &m(9, "create", "Z", 10, "a", "m1")).unwrap());
        // a NEWER local edit on the same chip is not settled by an older ack
        merge_mutation(&c, &m(2, "update", "X2", 20, "a", "m5")).unwrap();
        apply_acks(&c, &["m1".into()]).unwrap();
        assert_eq!(row(&c, 2).unwrap().0, "pending");
    }

    #[test]
    fn snapshot_applies_only_when_newer_and_spares_pending() {
        let c = db();
        synced(&c, 1, "Keep?");
        synced(&c, 2, "Gone");
        merge_mutation(&c, &m(3, "update", "Mine", 10, "a", "m1")).unwrap();
        c.execute("INSERT INTO cards_state (client_id, local_version) VALUES (1, 1.05)", []).unwrap();
        let theirs = CardsPayload {
            client_id: 1,
            version: Some(1.07),
            snapshot: Some(vec![
                CardRow { id: 1, key_number: 1, key_name: "Renamed".into(), color: None },
                CardRow { id: 3, key_number: 3, key_name: "Studio".into(), color: None },
            ]),
            pending: vec![],
            acks: vec![],
        };
        apply_payload(&c, 1, &theirs).unwrap();
        assert_eq!(row(&c, 1).unwrap().2, "Renamed");
        assert_eq!(row(&c, 2), None);
        assert_eq!(row(&c, 3).unwrap().2, "Mine");
        assert_eq!(local_version(&c, 1).unwrap(), Some(1.07));
        // an older list is ignored
        let older = CardsPayload { version: Some(1.01), ..theirs };
        apply_payload(&c, 1, &older).unwrap();
        assert_eq!(local_version(&c, 1).unwrap(), Some(1.07));
    }

    #[test]
    fn legacy_pending_rows_get_a_mutation_id() {
        let c = db();
        c.execute(
            "INSERT INTO cards (id, key_number, key_name, sync_state, operation) VALUES (8, 8, 'L', 'pending', 'update')",
            [],
        )
        .unwrap();
        let p = list_pending(&c).unwrap();
        assert_eq!(p.len(), 1);
        assert!(!p[0].mutation_id.is_empty());
        assert_eq!(p[0].edited_at_ms, 0);
    }
}
