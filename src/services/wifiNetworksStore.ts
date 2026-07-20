// Remembered Wi-Fi networks the device may auto-join (see migration v19,
// services/wifiAutoConnect.ts). Rows are written by Feature A (mother creds
// piggybacked on the ping, in Rust, origin='paired') and - once the onboarding
// feature lands - Feature B (studio relay, origin='studio'). This store is the
// JS read/consent surface; it never invents creds.

import { getDb } from './db';

export interface WifiNetworkRow {
  ssid: string;
  password: string;
  source: 'hotspot' | 'router' | string;
  origin: 'paired' | 'studio' | string;
  /** null = never asked, 0 = declined, 1 = consented. */
  auto_connect: number | null;
  updated_at: string | null;
  last_connected_at: string | null;
}

// Ordered for selection: most-recently-connected first (never-connected last),
// then paired-over-studio as the tie-break (Q7/Q8 of the design).
export async function list(): Promise<WifiNetworkRow[]> {
  const db = await getDb();
  return db.select<WifiNetworkRow[]>(
    `SELECT * FROM wifi_networks
     ORDER BY last_connected_at IS NULL,
              last_connected_at DESC,
              CASE origin WHEN 'paired' THEN 0 ELSE 1 END`
  );
}

/** How many studio-authored hotspot rows this device currently mirrors. Used by
 * the sync gate to re-pull when studio advertises networks but we hold none
 * (e.g. a prior empty pull advanced the version + tombstoned before the seed). */
export async function countStudio(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM wifi_networks WHERE origin = 'studio'"
  );
  return rows[0]?.n ?? 0;
}

export async function get(ssid: string): Promise<WifiNetworkRow | null> {
  const db = await getDb();
  const rows = await db.select<WifiNetworkRow[]>(
    'SELECT * FROM wifi_networks WHERE ssid = $1',
    [ssid]
  );
  return rows[0] ?? null;
}

/** Record the operator's one-time choice for a network ("from now on"). */
export async function setConsent(ssid: string, consent: boolean): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE wifi_networks SET auto_connect = $1 WHERE ssid = $2', [
    consent ? 1 : 0,
    ssid,
  ]);
}

/** Stamp a successful join so MRU selection favours this network next time. */
export async function markConnected(ssid: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE wifi_networks SET last_connected_at = datetime('now') WHERE ssid = $1",
    [ssid]
  );
}

/**
 * Upsert creds for a network, preserving the operator's auto_connect consent.
 * Used by the orchestrator's `lan_networks` work-item (Feature B download side):
 * studio-relayed default hotspots are written with origin='studio'. Creds are
 * last-write-wins; `auto_connect` is NEVER touched here, so a refreshed password
 * keeps a prior consent/decline. New rows start auto_connect = NULL (unasked),
 * so the auto-join engine prompts the first time the network is seen in range.
 */
export async function upsert(input: {
  ssid: string;
  password: string;
  source?: string;
  origin?: string;
  // When true, a NEW row is created already-consented (auto_connect = 1) instead
  // of unasked (NULL) - so the silent auto-connect can join it with no prompt.
  // Used for studio-authored creds (the operator's own admin-defined venue
  // network). NEVER overrides an existing row's consent (an explicit decline
  // stays a decline): the ON CONFLICT branch leaves auto_connect untouched.
  autoConnectOnInsert?: boolean;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO wifi_networks (ssid, password, source, origin, auto_connect, updated_at)
     VALUES ($1, $2, $3, $4, $5, datetime('now'))
     ON CONFLICT(ssid) DO UPDATE SET
       password   = excluded.password,
       source     = excluded.source,
       origin     = excluded.origin,
       -- Promote an UNASKED row (NULL) to consented when the caller asks
       -- (studio creds); preserve an explicit decline (0) and a prior consent (1).
       auto_connect = CASE
         WHEN excluded.auto_connect = 1 AND wifi_networks.auto_connect IS NULL THEN 1
         ELSE wifi_networks.auto_connect END,
       updated_at = datetime('now')`,
    [
      input.ssid,
      input.password,
      input.source ?? 'hotspot',
      input.origin ?? 'studio',
      input.autoConnectOnInsert ? 1 : null,
    ]
  );
}

/**
 * Drop studio-origin rows whose SSID is no longer in the freshly-pulled set.
 * Studio is the sole author of these (plans/studio-authoritative-hotspot-creds.md):
 * when an admin renames the client's hotspot, the old SSID stops being relayed
 * and must disappear from this device's mirror so the picker / mother-raise don't
 * keep offering the stale network. Only origin='studio' rows are touched -
 * paired-mother rows (origin='paired') are never pruned here. Passing an empty
 * keep-set removes ALL studio rows (studio defines none for this client).
 */
export async function tombstoneMissingStudio(keepSsids: string[]): Promise<void> {
  const db = await getDb();
  if (keepSsids.length === 0) {
    await db.execute("DELETE FROM wifi_networks WHERE origin = 'studio'");
    return;
  }
  const placeholders = keepSsids.map((_, i) => `$${i + 1}`).join(', ');
  await db.execute(
    `DELETE FROM wifi_networks WHERE origin = 'studio' AND ssid NOT IN (${placeholders})`,
    keepSsids
  );
}
