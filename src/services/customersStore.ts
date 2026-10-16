// Licensee customers (project_licensee_customers): the licensee's OWN customers
// (companies, schools...), NOT the licensee itself (which the code calls
// "client"). Two halves:
//   - the studio cache: `customers` + `customer_games` + `customers_state` in
//     the local SQLite, refreshed by the sync orchestrator (get_customers) when
//     studio's `customers_version` moves. The mother's copy feeds the LAN.
//   - LAN calls to the mother (launched_games endpoint): the customer list with
//     per-customer played scenarios, quick-create, and a game's (re)assignment.
// Studio support is detected by the manifest key: an older studio leaves
// remote_version NULL and the whole feature stays hidden.

import { getDb } from './db';
import { apiCall } from './api';
import { emit, on } from './syncEvents';

export interface LanCustomer {
  id: string;
  name: string;
  type: string | null;
  city: string | null;
  archived: boolean;
}

export interface CustomerPlayed {
  customer_id: string;
  game_uniqid: string;
  last_played_at: string | null;
  count: number;
}

export interface CustomersSnapshot {
  supported: boolean;
  customers: LanCustomer[];
  redirects: Record<string, string>;
  played: CustomerPlayed[];
}

const UNSUPPORTED: CustomersSnapshot = { supported: false, customers: [], redirects: {}, played: [] };

// ─── sync state (customers_state) - mirrors recoveryCodesStore ───────────────

export interface CustomersStateRow {
  client_id: number;
  remote_version: number | null;
  local_version: number | null;
  fetched_at: string | null;
  failed_attempts: number;
}

export async function getState(clientId: number): Promise<CustomersStateRow | null> {
  const db = await getDb();
  const rows = await db.select<CustomersStateRow[]>('SELECT * FROM customers_state WHERE client_id = $1', [clientId]);
  return rows.length ? rows[0] : null;
}

/** Record studio's advertised version (null = studio without customers). */
export async function upsertFromManifest(clientId: number, payload: { customers_version: number | null }): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO customers_state (client_id, remote_version, local_version, fetched_at, failed_attempts)
     VALUES ($1, $2, NULL, NULL, 0)
     ON CONFLICT(client_id) DO UPDATE SET remote_version = excluded.remote_version`,
    [clientId, payload.customers_version],
  );
}

export async function needsDownload(clientId: number): Promise<boolean> {
  const row = await getState(clientId);
  if (!row || row.remote_version === null) return false;
  return row.local_version === null || row.local_version !== row.remote_version;
}

export async function markDownloaded(clientId: number, version: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE customers_state SET local_version = $1, fetched_at = $2, failed_attempts = 0 WHERE client_id = $3',
    [version, new Date().toISOString(), clientId],
  );
}

export async function incrementFailedAttempts(clientId: number): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE customers_state SET failed_attempts = failed_attempts + 1 WHERE client_id = $1', [clientId]);
}

/** True once this device has seen a studio that knows customers. */
export async function studioSupportsCustomers(): Promise<boolean> {
  try {
    const db = await getDb();
    const rows = await db.select<{ n: number }[]>(
      'SELECT COUNT(*) AS n FROM customers_state WHERE remote_version IS NOT NULL',
    );
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

// ─── studio download (playground.php get_customers) ─────────────────────────

export interface CustomersDownload {
  version: number;
  customers: Array<{ id: string; name: string; type: string | null; city: string | null; archived: number }>;
  redirects: Record<string, string>;
  deleted: string[];
  /** [summary_uuid, customer_id|null, scenario_uniqid, played_at, assigned_at ISO] */
  games: Array<[string, string | null, string | null, string | null, string | null]>;
}

const GAME_BATCH = 100;

/**
 * Replace the studio half of the cache. Every statement is idempotent: the SQL
 * plugin cannot bind a transaction (see applyManifest), so a crash midway is
 * repaired by the next download. Local quick-creates (origin='local') are kept
 * until studio echoes them back.
 */
export async function applyDownload(clientId: number, p: CustomersDownload): Promise<void> {
  const db = await getDb();
  const keep = new Set<string>();
  for (const c of p.customers ?? []) {
    keep.add(c.id);
    await db.execute(
      `INSERT INTO customers (id, client_id, name, type, city, archived, merged_into_id, deleted, origin, pushed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, 0, 'studio', datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         client_id = excluded.client_id, name = excluded.name, type = excluded.type, city = excluded.city,
         archived = excluded.archived, merged_into_id = NULL, deleted = 0, origin = 'studio',
         pushed_at = COALESCE(customers.pushed_at, excluded.pushed_at), updated_at = excluded.updated_at`,
      [c.id, clientId, c.name, c.type, c.city, c.archived ? 1 : 0],
    );
  }
  for (const [id, target] of Object.entries(p.redirects ?? {})) {
    keep.add(id);
    await db.execute(
      `INSERT INTO customers (id, client_id, name, archived, merged_into_id, origin, pushed_at)
       VALUES ($1, $2, '', 1, $3, 'studio', datetime('now'))
       ON CONFLICT(id) DO UPDATE SET merged_into_id = excluded.merged_into_id, archived = 1, origin = 'studio'`,
      [id, clientId, target],
    );
  }
  for (const id of p.deleted ?? []) {
    keep.add(id);
    await db.execute(
      `UPDATE customers SET deleted = 1, origin = 'studio', pushed_at = COALESCE(pushed_at, datetime('now'))
       WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
  }
  // Studio rows studio no longer lists (hard-deleted there).
  const studioRows = await db.select<{ id: string }[]>(
    "SELECT id FROM customers WHERE client_id = $1 AND origin = 'studio'",
    [clientId],
  );
  for (const r of studioRows) {
    if (!keep.has(r.id)) await db.execute('DELETE FROM customers WHERE id = $1', [r.id]);
  }

  await db.execute('DELETE FROM customer_games WHERE client_id = $1', [clientId]);
  const games = p.games ?? [];
  for (let i = 0; i < games.length; i += GAME_BATCH) {
    const chunk = games.slice(i, i + GAME_BATCH);
    const values: unknown[] = [];
    const rows = chunk.map((g, j) => {
      values.push(g[0], clientId, g[1], g[2], g[3], g[4]);
      const b = j * 6;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    await db.execute(
      `INSERT OR REPLACE INTO customer_games (summary_uuid, client_id, customer_id, game_uniqid, played_at, customer_assigned_at)
       VALUES ${rows.join(', ')}`,
      values,
    );
  }
  emit('content:updated', { kind: 'customers', ids: [clientId] });
}

// ─── LAN calls (routed to the mother) ───────────────────────────────────────

/**
 * The LAN's customers + played scenarios, from the mother. `supported` is false
 * when the mother predates customers (405) or this device / the mother never
 * saw a studio that supports them - the UI hides the feature then.
 */
export async function listCustomers(): Promise<CustomersSnapshot> {
  try {
    const res = await apiCall<CustomersSnapshot & { cloud_supported?: boolean }>(
      'launched_games',
      'customers_list',
      { method: 'GET', bearer: true },
    );
    if (!res?.supported) return UNSUPPORTED;
    const cloud = res.cloud_supported === true || (await studioSupportsCustomers());
    if (!cloud) return UNSUPPORTED;
    return {
      supported: true,
      customers: res.customers ?? [],
      redirects: res.redirects ?? {},
      played: res.played ?? [],
    };
  } catch {
    return UNSUPPORTED;
  }
}

/** Quick-create (name only). Works offline: the mother is on the LAN. */
export async function createCustomer(name: string): Promise<LanCustomer> {
  const res = await apiCall<{ customer: LanCustomer }>('launched_games', 'customers_create', {
    method: 'POST',
    bearer: true,
    body: { id: crypto.randomUUID(), name: name.trim() },
  });
  notifyChanged();
  return res.customer;
}

/**
 * Set / change / clear (customerId null) a game's customer, by summary_uuid
 * (works for archived games too) or by the live game's id.
 */
export async function assignCustomer(args: {
  summaryUuid?: string;
  gameId?: number;
  customerId: string | null;
  customerName?: string | null;
}): Promise<void> {
  await apiCall('launched_games', 'assign_customer', {
    method: 'POST',
    bearer: true,
    body: {
      ...(args.summaryUuid ? { summary_uuid: args.summaryUuid } : {}),
      ...(args.gameId !== undefined ? { id: args.gameId } : {}),
      customer_id: args.customerId,
      customer_name: args.customerName ?? null,
    },
  });
  notifyChanged();
}

/** Follow merge tombstones to the customer that holds the history now. */
export function resolveCustomerId(snapshot: CustomersSnapshot, id: string): string {
  let cur = id;
  for (let i = 0; i < 5 && snapshot.redirects[cur]; i++) cur = snapshot.redirects[cur];
  return cur;
}

function notifyChanged(): void {
  emit('content:updated', { kind: 'customers', ids: [] });
}

/** Called when the customer list or an assignment may have changed. */
export function onCustomersChanged(cb: () => void): () => void {
  return on('content:updated', (p) => {
    if (p.kind === 'customers') cb();
  });
}
