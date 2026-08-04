// Remembered Wi-Fi networks the device may auto-join (see migration v19,
// services/wifiAutoConnect.ts). Rows are written by the mother-ping creds relay
// (in Rust, origin='paired'), the studio sync mirror (origin='studio', see
// syncOrchestrator's lan_networks work item) and the Join tab's manual add form
// (origin='manual'). This store is the JS read/consent surface; it never
// invents creds.

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

/**
 * The networks a satellite may join to reach a mother: studio-relayed hotspots
 * plus any the operator added by hand (origin='manual'). Excludes origin='paired'
 * rows (learned passively from a mother ping) - those aren't shown as pickable
 * "mother's Wi-Fi". Studio first, then manual, alphabetical within each.
 */
export async function listJoinable(): Promise<WifiNetworkRow[]> {
  const db = await getDb();
  return db.select<WifiNetworkRow[]>(
    `SELECT * FROM wifi_networks
     WHERE origin IN ('studio', 'manual')
     ORDER BY CASE origin WHEN 'studio' THEN 0 ELSE 1 END, ssid`
  );
}

/**
 * Networks a satellite may CONNECT to by hand in the step-by-step flow. Unlike
 * `listJoinable` (studio+manual only, the pickable "mother's Wi-Fi" list), this
 * includes `origin='paired'` rows - the creds a child learned passively from a
 * mother's ping relay (`read_mother_wifi`). Those are precisely the mother's own
 * Wi-Fi, so a child that only ever learned its creds that way must still be able
 * to connect. Ordered studio → manual → paired, then most-recently-connected.
 * (Without this, such a child wrongly shows "no network configured" even though
 * wifi_networks holds the right SSID/password.)
 */
export async function listConnectable(): Promise<WifiNetworkRow[]> {
  const db = await getDb();
  return db.select<WifiNetworkRow[]>(
    `SELECT * FROM wifi_networks
     ORDER BY CASE origin WHEN 'studio' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,
              last_connected_at IS NULL,
              last_connected_at DESC,
              ssid`
  );
}

/**
 * Manually add a network the operator typed in (Settings → Devices → Join, when
 * studio hasn't synced any creds yet). Stored with origin='manual' so the sync
 * tombstone never prunes it, and auto-consented so the auto-connect engine joins
 * it silently. Idempotent upsert (re-adding updates the password).
 */
export async function addManual(ssid: string, password: string): Promise<void> {
  await upsert({ ssid, password, source: 'hotspot', origin: 'manual', autoConnectOnInsert: true });
}

/** Delete a remembered network by SSID (used to remove a manual entry). */
export async function remove(ssid: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM wifi_networks WHERE ssid = $1', [ssid]);
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
 * Reconcile the local mirror to studio's authoritative set (called on every sync,
 * version-independent). `keepSsids` = the SSIDs studio currently relays.
 *
 *  - When studio relays SOMETHING (non-empty keep set): studio is the source of
 *    truth, so keep exactly that set PLUS any `origin='manual'` entries the
 *    operator typed, and DROP stale HOTSPOT rows - stale studio rows (renamed
 *    hotspot) AND stale `origin='paired'` hotspot rows (e.g. an old auto-generated
 *    SSID learned via a past ping that nothing refreshes and that would otherwise
 *    linger in the table and get auto-joined). A paired row whose SSID matches a
 *    relayed one survives (it IS the current network).
 *    `source='router'` rows are EXEMPT: studio never relays router creds (they
 *    are learned on site via the mother ping), so pruning them here would
 *    un-provision a router-mode venue on every office sync.
 *  - When studio relays NOTHING (empty keep set): only drop stale studio rows;
 *    leave paired/manual intact so a device that learned its creds via the mother
 *    ping (studio not migrated / nothing seeded yet) keeps working.
 */
export async function reconcileToStudioSet(keepSsids: string[]): Promise<void> {
  const db = await getDb();
  if (keepSsids.length === 0) {
    await db.execute("DELETE FROM wifi_networks WHERE origin = 'studio'");
    return;
  }
  const placeholders = keepSsids.map((_, i) => `$${i + 1}`).join(', ');
  await db.execute(
    `DELETE FROM wifi_networks
     WHERE origin != 'manual' AND source != 'router' AND ssid NOT IN (${placeholders})`,
    keepSsids
  );
}
