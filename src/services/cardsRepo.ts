// Local SQLite gateway for the row-based `cards` table.
//
// Replaces the legacy cards-CSV flow: cards used to be downloaded from
// studio as `cards/{clientId}/cards_v{N}.csv` and parsed in memory at
// game-launch time. They now live in `cards` (one row per chip) and sync
// bidirectionally with studio's `client_cards` table.
//
// sync_state semantics:
//   - 'synced' / operation=NULL: matches studio's authoritative state
//   - 'pending' / operation='create': local registration that hasn't been
//     pushed yet
//   - 'pending' / operation='update': local edit not yet pushed
//   - 'pending' / operation='delete': local delete not yet pushed; row is
//     hidden from list() but kept around so the next sync cycle can replay
//     the delete on studio
//
// `applyServerPull` reconciles a server snapshot with the local table.
// It NEVER overwrites a row whose sync_state='pending' - those are local
// mutations awaiting push. Use `acceptServerOverwrite` explicitly when a
// 409 conflict tells the server's data should win.
//
// Every local edit is stamped (edited_at_ms in mother time, edited_by = this
// device, a fresh mutation_id): devices share their unpushed edits over the
// LAN when offline and the later edit of a chip wins (src-tauri cards_sync.rs).

import { invoke } from '@tauri-apps/api/core';
import { getDb } from './db';
import { motherNow } from './motherTime';

let deviceUuid: string | null = null;
async function editStamp(): Promise<[number, string, string]> {
  if (deviceUuid === null) {
    deviceUuid =
      (await invoke<{ device_uuid: string }>('client_get_device_identity').catch(() => null))?.device_uuid ?? '';
  }
  return [Math.round(motherNow()), deviceUuid, crypto.randomUUID()];
}

export interface CardRow {
  id: number;
  key_number: number;
  key_name: string;
  color: string | null;
}

export type CardOperation = 'create' | 'update' | 'delete';

export interface PendingCardRow extends CardRow {
  operation: CardOperation;
  mutation_id: string | null;
}

interface CardDbRow {
  id: number;
  key_number: number;
  key_name: string;
  color: string | null;
  sync_state: 'synced' | 'pending';
  operation: CardOperation | null;
  mutation_id?: string | null;
}

function toCard(row: CardDbRow): CardRow {
  return {
    id: row.id,
    key_number: row.key_number,
    key_name: row.key_name,
    color: row.color,
  };
}

// User-facing list: excludes pending-delete tombstones.
export async function list(): Promise<CardRow[]> {
  const db = await getDb();
  const rows = await db.select<CardDbRow[]>(
    `SELECT id, key_number, key_name, color, sync_state, operation
     FROM cards
     WHERE NOT (sync_state = 'pending' AND operation = 'delete')
     ORDER BY key_number ASC, id ASC`
  );
  return rows.map(toCard);
}

export async function getById(id: number): Promise<CardRow | null> {
  const db = await getDb();
  const rows = await db.select<CardDbRow[]>(
    `SELECT id, key_number, key_name, color, sync_state, operation
     FROM cards
     WHERE id = $1 AND NOT (sync_state = 'pending' AND operation = 'delete')`,
    [id]
  );
  return rows.length ? toCard(rows[0]) : null;
}

// Returns true if `id` is registered (visible in list - not a pending-delete).
export async function isRegistered(id: number): Promise<boolean> {
  return (await getById(id)) !== null;
}

export async function suggestNextKeyNumber(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<Array<{ max: number | null }>>(
    `SELECT MAX(key_number) AS max FROM cards
     WHERE NOT (sync_state = 'pending' AND operation = 'delete')`
  );
  return (rows[0]?.max ?? 0) + 1;
}

// Local insert. Marked pending-create so the next sync cycle pushes it.
// Re-registering a chip whose delete hasn't been pushed yet revives its
// tombstone (pushed as a create; the push falls back to an update if the
// studio still has it). A visible row with that id is still an error.
export async function create(card: CardRow): Promise<void> {
  const db = await getDb();
  const [at, by, mid] = await editStamp();
  const res = await db.execute(
    `INSERT INTO cards (id, key_number, key_name, color, sync_state, operation, updated_at,
                        edited_at_ms, edited_by, mutation_id)
     VALUES ($1, $2, $3, $4, 'pending', 'create', CURRENT_TIMESTAMP, $5, $6, $7)
     ON CONFLICT(id) DO UPDATE SET
       key_number = excluded.key_number, key_name = excluded.key_name, color = excluded.color,
       sync_state = 'pending', operation = 'create', updated_at = CURRENT_TIMESTAMP,
       edited_at_ms = excluded.edited_at_ms, edited_by = excluded.edited_by, mutation_id = excluded.mutation_id
     WHERE cards.sync_state = 'pending' AND cards.operation = 'delete'`,
    [card.id, card.key_number, card.key_name, card.color, at, by, mid]
  );
  if (res.rowsAffected === 0) {
    throw new Error(`cardsRepo.create: card ${card.id} already exists`);
  }
}

// Local edit. If the row is still 'pending'/'create' (never synced), keep
// operation='create' - we're still pushing it as a fresh insert. Otherwise
// flip to 'pending'/'update' so the sync layer issues a PUT.
export async function update(id: number, fields: Partial<Omit<CardRow, 'id'>>): Promise<void> {
  const db = await getDb();
  const existing = await db.select<Pick<CardDbRow, 'sync_state' | 'operation'>[]>(
    'SELECT sync_state, operation FROM cards WHERE id = $1',
    [id]
  );
  if (existing.length === 0) {
    throw new Error(`cardsRepo.update: no card with id=${id}`);
  }

  const keepAsCreate =
    existing[0].sync_state === 'pending' && existing[0].operation === 'create';
  const nextOperation: CardOperation = keepAsCreate ? 'create' : 'update';

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (fields.key_number !== undefined) {
    sets.push(`key_number = $${i++}`);
    params.push(fields.key_number);
  }
  if (fields.key_name !== undefined) {
    sets.push(`key_name = $${i++}`);
    params.push(fields.key_name);
  }
  if (fields.color !== undefined) {
    sets.push(`color = $${i++}`);
    params.push(fields.color);
  }
  sets.push(`sync_state = 'pending'`);
  sets.push(`operation = $${i++}`);
  params.push(nextOperation);
  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  const [at, by, mid] = await editStamp();
  sets.push(`edited_at_ms = $${i++}`, `edited_by = $${i++}`, `mutation_id = $${i++}`);
  params.push(at, by, mid);

  params.push(id);
  await db.execute(
    `UPDATE cards SET ${sets.join(', ')} WHERE id = $${i}`,
    params
  );
}

// Local delete: left in place with operation='delete' so the next push tells
// studio. Even a never-synced pending-create becomes a tombstone (studio
// accepts deleting a card it doesn't have): its create may already have been
// shared with another device over the LAN, which must learn it's gone.
export async function remove(id: number): Promise<void> {
  const db = await getDb();
  const existing = await db.select<Pick<CardDbRow, 'sync_state' | 'operation'>[]>(
    'SELECT sync_state, operation FROM cards WHERE id = $1',
    [id]
  );
  if (existing.length === 0) return;
  const [at, by, mid] = await editStamp();
  await db.execute(
    `UPDATE cards SET sync_state = 'pending', operation = 'delete', updated_at = CURRENT_TIMESTAMP,
       edited_at_ms = $2, edited_by = $3, mutation_id = $4
     WHERE id = $1`,
    [id, at, by, mid]
  );
}

// List of unsynced mutations the sync layer should push. Sort by updated_at
// so creates that referenced an earlier row (rare for cards, but cheap) go
// first.
export async function listPending(): Promise<PendingCardRow[]> {
  const db = await getDb();
  const rows = await db.select<CardDbRow[]>(
    `SELECT id, key_number, key_name, color, sync_state, operation, mutation_id
     FROM cards
     WHERE sync_state = 'pending'
     ORDER BY updated_at ASC, id ASC`
  );
  return rows
    .filter((r): r is CardDbRow & { operation: CardOperation } => r.operation !== null)
    .map((r) => ({ ...toCard(r), operation: r.operation, mutation_id: r.mutation_id ?? null }));
}

// Mark a pending row as synced. For 'delete' operations, the row is removed
// outright (the studio confirmation means the local tombstone has done its
// job).
//
// `mutationId`: the edit that was pushed. A newer edit merged in from a LAN
// peer meanwhile stays pending; the pushed one is recorded as acked so the
// other devices of the fleet mark it synced instead of pushing it again.
export async function markSynced(id: number, operation: CardOperation, mutationId: string | null = null): Promise<void> {
  const db = await getDb();
  if (mutationId) {
    await db.execute('INSERT OR IGNORE INTO card_mutation_acks (mutation_id, acked_at) VALUES ($1, $2)', [
      mutationId,
      Date.now(),
    ]);
  }
  const same = mutationId ? ' AND mutation_id = $2' : '';
  const args = mutationId ? [id, mutationId] : [id];
  if (operation === 'delete') {
    await db.execute(`DELETE FROM cards WHERE id = $1${same}`, args);
    return;
  }
  await db.execute(
    `UPDATE cards SET sync_state = 'synced', operation = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1${same}`,
    args
  );
}

// On 409 conflict, the server's row is authoritative. Replace local fields
// with the server row and flip sync_state back to 'synced'.
export async function acceptServerOverwrite(card: CardRow): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO cards (id, key_number, key_name, color, sync_state, operation, updated_at)
     VALUES ($1, $2, $3, $4, 'synced', NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       key_number = excluded.key_number,
       key_name = excluded.key_name,
       color = excluded.color,
       sync_state = 'synced',
       operation = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [card.id, card.key_number, card.key_name, card.color]
  );
}

// Apply a full server snapshot to the local table. Runs inside a single
// transaction.
//
// Reconciliation rules per id:
//   - Server has it, local doesn't                       → INSERT (synced)
//   - Server has it, local is 'synced'                   → UPDATE if changed
//   - Server has it, local is 'pending'/'create'         → leave alone (local will push)
//   - Server has it, local is 'pending'/'update'         → leave alone (local will push)
//   - Server has it, local is 'pending'/'delete'         → leave alone (local will push delete)
//   - Server doesn't have it, local is 'synced'          → DELETE locally
//   - Server doesn't have it, local is 'pending'/'create' → leave alone (still queued for push)
//   - Server doesn't have it, local is 'pending'/'delete' → DELETE locally (server already
//     dropped it - our pending tombstone is satisfied)
//   - Server doesn't have it, local is 'pending'/'update' → DELETE locally (server doesn't know
//     about it any more; the next push of this update would 404 anyway)
export async function applyServerPull(serverCards: CardRow[]): Promise<void> {
  // No explicit BEGIN/COMMIT: tauri-plugin-sql v2 runs each execute() on a
  // pool connection acquired per-call, so manual transactions across
  // multiple statements leak BEGINs onto pool connections that surface as
  // "cannot start a transaction within a transaction" errors later in
  // unrelated callers. Each statement here is independently safe to apply:
  // INSERT/UPDATE are keyed on PK, DELETE removes rows by id. A partial
  // apply (network blip mid-loop) leaves the cards table in a state that
  // the next sync cycle re-converges on.
  const db = await getDb();
  const existing = await db.select<CardDbRow[]>(
    `SELECT id, key_number, key_name, color, sync_state, operation FROM cards`
  );
  const localById = new Map(existing.map((r) => [r.id, r]));
  const serverById = new Map(serverCards.map((r) => [r.id, r]));

  // Pass 1: insert/update from server.
  for (const card of serverCards) {
    const local = localById.get(card.id);
    if (!local) {
      await db.execute(
        `INSERT INTO cards (id, key_number, key_name, color, sync_state, operation, updated_at)
         VALUES ($1, $2, $3, $4, 'synced', NULL, CURRENT_TIMESTAMP)`,
        [card.id, card.key_number, card.key_name, card.color]
      );
      continue;
    }
    if (local.sync_state === 'pending') continue;
    // synced row - update if any field differs
    if (
      local.key_number !== card.key_number ||
      local.key_name !== card.key_name ||
      local.color !== card.color
    ) {
      await db.execute(
        `UPDATE cards SET key_number = $1, key_name = $2, color = $3,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [card.key_number, card.key_name, card.color, card.id]
      );
    }
  }

  // Pass 2: drop local rows that the server no longer reports, EXCEPT
  // pending-create rows (which the server hasn't heard about yet).
  for (const local of existing) {
    if (serverById.has(local.id)) continue;
    if (local.sync_state === 'pending' && local.operation === 'create') continue;
    await db.execute('DELETE FROM cards WHERE id = $1', [local.id]);
  }
}

// Wipe everything. Called on sign-out or when a different owner signs in.
export async function wipe(): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM cards');
}
