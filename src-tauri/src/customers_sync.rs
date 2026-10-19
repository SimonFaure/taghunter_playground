//! Licensee customers quick-created on the LAN (origin = 'local'), shared
//! between devices before any of them reaches the studio.
//!
//! The studio list travels as a file (content_server `get_catalog&kind=
//! customers`). A customer quick-created offline lives only in the database of
//! the mother that created it, so a device promoted to mother later (failover,
//! or another PC hosting the next event) would not list it. One exchange, driven
//! by the satellite with the rest of its LAN sync
//! (`/content.php?action=customers_exchange`): each side sends its local
//! customers, the other inserts those it doesn't know. Customers are created
//! only (no edit on the playground) with a UUID, so a plain insert-if-missing
//! is the whole merge. Every holder pushes them to the studio; the studio
//! ignores a UUID it already has.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub(crate) const CUSTOMERS_MERGED_EVENT: &str = "taghunter://customers-merged";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct LocalCustomer {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct CustomersPayload {
    pub client_id: i64,
    #[serde(default)]
    pub customers: Vec<LocalCustomer>,
}

fn valid(c: &LocalCustomer) -> bool {
    let id = c.id.to_lowercase();
    id.len() == 36
        && id.chars().enumerate().all(|(i, ch)| {
            if [8, 13, 18, 23].contains(&i) {
                ch == '-'
            } else {
                ch.is_ascii_hexdigit()
            }
        })
        && !c.name.trim().is_empty()
}

/// Our quick-created customers the studio hasn't confirmed yet.
pub(crate) fn list_local(c: &Connection, client_id: i64) -> rusqlite::Result<Vec<LocalCustomer>> {
    let mut st = c.prepare(
        "SELECT id, name, type, city, created_at FROM customers
          WHERE client_id = ?1 AND origin = 'local' AND deleted = 0 AND merged_into_id IS NULL",
    )?;
    let rows = st
        .query_map(params![client_id], |r| {
            Ok(LocalCustomer {
                id: r.get(0)?,
                name: r.get(1)?,
                r#type: r.get(2)?,
                city: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Insert the peer's customers we don't know. Never touches an existing row
/// (a studio row with that id is the authority). Returns how many were added.
pub(crate) fn merge_local(c: &Connection, client_id: i64, theirs: &[LocalCustomer]) -> rusqlite::Result<usize> {
    let mut added = 0;
    for cu in theirs.iter().filter(|cu| valid(cu)) {
        let name: String = cu.name.trim().chars().take(190).collect();
        added += c.execute(
            "INSERT OR IGNORE INTO customers (id, client_id, name, type, city, origin, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'local', COALESCE(?6, datetime('now')))",
            params![cu.id.to_lowercase(), client_id, name, cu.r#type, cu.city, cu.created_at],
        )?;
    }
    Ok(added)
}

/// Mother side: take the satellite's, reply with ours.
pub(crate) async fn mother_exchange(
    db: &tokio_rusqlite::Connection,
    app: &AppHandle,
    client_id: i64,
    theirs: CustomersPayload,
) -> Result<Value, String> {
    let (mine, added) = db
        .call(move |c: &mut Connection| -> tokio_rusqlite::Result<(Vec<LocalCustomer>, usize)> {
            let tx = c.transaction()?;
            let added = merge_local(&tx, client_id, &theirs.customers)?;
            let mine = list_local(&tx, client_id)?;
            tx.commit()?;
            Ok((mine, added))
        })
        .await
        .map_err(|e| e.to_string())?;
    if added > 0 {
        let _ = app.emit(CUSTOMERS_MERGED_EVENT, ());
    }
    serde_json::to_value(CustomersPayload { client_id, customers: mine }).map_err(|e| e.to_string())
}

/// Satellite: exchange quick-created customers with the mother.
#[tauri::command]
pub async fn client_customers_exchange(
    app: AppHandle,
    base_url: String,
    token: String,
    client_id: i64,
) -> Result<Value, String> {
    let conn = crate::lan_server::open_db_for_command(&app).await?;
    let ours = conn
        .call(move |c: &mut Connection| -> tokio_rusqlite::Result<CustomersPayload> {
            Ok(CustomersPayload { client_id, customers: list_local(c, client_id)? })
        })
        .await
        .map_err(|e| e.to_string())?;
    let client = crate::lan_server::lan_client_builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/content.php?action=customers_exchange", base_url.trim_end_matches('/')))
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
    let theirs: CustomersPayload = resp.json().await.map_err(|e| e.to_string())?;
    if theirs.client_id != client_id {
        return Err("CLIENT_MISMATCH".into());
    }
    let added = conn
        .call(move |c: &mut Connection| -> tokio_rusqlite::Result<usize> {
            Ok(merge_local(c, client_id, &theirs.customers)?)
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "added": added }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE customers (id TEXT PRIMARY KEY, client_id INTEGER NOT NULL, name TEXT NOT NULL,
                type TEXT NULL, city TEXT NULL, archived INTEGER NOT NULL DEFAULT 0, merged_into_id TEXT NULL,
                deleted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT 'studio', pushed_at TEXT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NULL);",
        )
        .unwrap();
        c
    }

    fn cu(id: &str, name: &str) -> LocalCustomer {
        LocalCustomer { id: id.into(), name: name.into(), r#type: None, city: None, created_at: None }
    }

    const A: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const B: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    #[test]
    fn adds_unknown_and_never_overwrites() {
        let c = db();
        c.execute("INSERT INTO customers (id, client_id, name, origin) VALUES (?1, 1, 'Studio name', 'studio')", params![A])
            .unwrap();
        let added = merge_local(&c, 1, &[cu(A, "Peer name"), cu(B, "École Jules Ferry")]).unwrap();
        assert_eq!(added, 1);
        let name: String = c.query_row("SELECT name FROM customers WHERE id = ?1", params![A], |r| r.get(0)).unwrap();
        assert_eq!(name, "Studio name");
        let local = list_local(&c, 1).unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].id, B);
        // replay: nothing more
        assert_eq!(merge_local(&c, 1, &[cu(B, "École Jules Ferry")]).unwrap(), 0);
    }

    #[test]
    fn rejects_bad_ids_and_empty_names() {
        let c = db();
        assert_eq!(merge_local(&c, 1, &[cu("not-a-uuid", "X"), cu(B, "  ")]).unwrap(), 0);
    }
}
