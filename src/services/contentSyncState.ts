// content_sync_state row: the last cloud manifest this device applied, and
// WHEN the cloud produced it (studio `server_time`, ms).
//
// Devices of the same licensee pass manifests to each other over the LAN when
// the venue has no internet. `cloud_as_of_ms` orders those snapshots: only a
// strictly newer one may delete content on a peer, and a snapshot adopted from
// a peer keeps its ORIGIN time (never the local "now"), so the ordering stays
// consistent however many hops it travels. `content_rev` is bumped after every
// apply; children watch it on the mother's ping reply to know when to pull.

import { getDb } from './db';

export interface ContentSyncState {
  client_id: number | null;
  cloud_as_of_ms: number | null;
  manifest_json: string | null;
  source: string | null;
  approx: number;
  applied_at: string | null;
  content_rev: number;
}

// Manifest fields that never travel between devices: recovery codes are salted
// per device, on-demand cards depend on the date, client preferences carry no
// version, LAN networks are retired. A peer-sourced apply leaves those to the
// next cloud cycle.
const DEVICE_ONLY_FIELDS = [
  'client_preferences',
  'recovery_codes_version',
  'has_on_demand_cards',
  'lan_networks_version',
] as const;

export async function get(): Promise<ContentSyncState | null> {
  const db = await getDb();
  const rows = await db.select<ContentSyncState[]>(
    'SELECT client_id, cloud_as_of_ms, manifest_json, source, approx, applied_at, content_rev FROM content_sync_state WHERE id = 1'
  );
  return rows[0] ?? null;
}

/**
 * Remember the manifest just applied. `serverTime` is the studio's snapshot
 * time; an old studio without it falls back to the device clock and is flagged
 * `approx` (peers then copy bytes from it but never adopt its deletions).
 */
export async function recordSnapshot(
  clientId: number,
  manifest: object,
  serverTime: number | null | undefined,
  source: string
): Promise<void> {
  const shared: Record<string, unknown> = { ...(manifest as Record<string, unknown>) };
  for (const k of DEVICE_ONLY_FIELDS) delete shared[k];
  delete shared.server_time;
  const approx = typeof serverTime === 'number' && serverTime > 0 ? 0 : 1;
  const asOf = approx ? Date.now() : (serverTime as number);
  const db = await getDb();
  await db.execute(
    `UPDATE content_sync_state
        SET client_id = $1, cloud_as_of_ms = $2, manifest_json = $3, source = $4,
            approx = $5, applied_at = $6, content_rev = content_rev + 1
      WHERE id = 1`,
    [clientId, asOf, JSON.stringify(shared), source, approx, new Date().toISOString()]
  );
}

/** Bump content_rev after content changed without a new manifest (a blob/catalog committed). */
export async function bumpRev(): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE content_sync_state SET content_rev = content_rev + 1 WHERE id = 1');
}

/** Sign-out / owner switch: forget the snapshot so it can't be offered to another licensee's devices. */
export async function clear(): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE content_sync_state
        SET client_id = NULL, cloud_as_of_ms = NULL, manifest_json = NULL, source = NULL,
            approx = 0, applied_at = NULL, inbox_manifest_json = NULL, inbox_as_of_ms = NULL
      WHERE id = 1`
  );
}
