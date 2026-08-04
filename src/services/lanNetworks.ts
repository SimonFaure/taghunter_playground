// Studio LAN integration for the playground.
//
// Hotspot creds are now AUTHORED IN STUDIO and pushed down on sync (see
// plans/studio-authoritative-hotspot-creds.md). The playground only DOWNLOADS
// them (getLanNetworks → wifi_networks mirror, consumed by lanCredentials /
// the auto-join engine). The old per-device "announce my creds upward" path
// (announce_lan_network / withdraw_lan_network) has been retired.
//
// What remains here:
//   - getLanNetworks + the lan_networks_version cursor (download side).
//   - set_default_mother (inventory bit - which machine is the client's
//     canonical mother, for the studio dashboard; no secret leaves the device).
// Writes are best-effort with a durable retry (the mother bit is enqueued on
// failure and replayed by flushPendingLanOps on the next online tick).

import { apiCall } from './api';
import { getDb } from './db';

/** Record (or clear) this device as the client's canonical mother. Inventory
 *  only - no secret leaves the device. */
export async function setDefaultMother(
  on: boolean,
  motherUuid?: string | null
): Promise<void> {
  await apiCall('playground', 'set_default_mother', {
    method: 'POST',
    bearer: true,
    body: { is_default_mother: on, mother_uuid: motherUuid ?? null },
  });
}

export interface RelayedNetwork {
  ssid: string;
  password: string;
  source: 'hotspot' | 'router' | string;
  version: number;
}

/** Download the client's studio-authored hotspots (orchestrator work-item). */
export async function getLanNetworks(signal?: AbortSignal): Promise<RelayedNetwork[]> {
  const res = await apiCall<{ networks?: RelayedNetwork[] }>('playground', 'get_lan_networks', {
    bearer: true,
    signal,
  });
  return res?.networks ?? [];
}

// Local mirror of the "default mother" designation so the Network settings
// toggle can render its current on/off state instantly + offline. Set alongside
// the set_default_mother call.
const MOTHER_DEFAULT_KEY = 'default_mother_on';

async function readBoolMeta(key: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [key]
  );
  return rows.length > 0 && rows[0].value === '1';
}

async function writeBoolMeta(key: string, on: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, on ? '1' : '0']
  );
}

export const getDefaultMotherLocal = () => readBoolMeta(MOTHER_DEFAULT_KEY);
export const setDefaultMotherLocal = (on: boolean) => writeBoolMeta(MOTHER_DEFAULT_KEY, on);

// ─── durable retry queue ─────────────────────────────────────────────────────
// Only the "default mother" inventory write is queued now (the hotspot upload
// ops are gone). Pending ops live in a single schema_meta JSON blob so they
// survive a restart.

type PendingOp = { kind: 'mother'; on: boolean; motherUuid: string | null };

const PENDING_KEY = 'pending_lan_ops';

async function readPending(): Promise<PendingOp[]> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [PENDING_KEY]
  );
  if (!rows.length) return [];
  try {
    const parsed = JSON.parse(rows[0].value);
    return Array.isArray(parsed) ? (parsed as PendingOp[]).filter((o) => o.kind === 'mother') : [];
  } catch {
    return [];
  }
}

async function writePending(ops: PendingOp[]): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [PENDING_KEY, JSON.stringify(ops)]
  );
}

export async function enqueuePendingOp(op: PendingOp): Promise<void> {
  const ops = await readPending();
  // De-dupe: a later mother op supersedes an earlier one.
  const next = ops.filter((existing) => existing.kind !== op.kind);
  next.push(op);
  await writePending(next);
}

let flushing = false;

/** Replay any queued ops. Called on connectivity:online and after auth at boot.
 *  Best-effort: ops that still fail are kept for the next attempt. */
export async function flushPendingLanOps(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const ops = await readPending();
    if (!ops.length) return;
    const remaining: PendingOp[] = [];
    for (const op of ops) {
      try {
        await setDefaultMother(op.on, op.motherUuid);
      } catch {
        remaining.push(op); // keep for the next flush
      }
    }
    await writePending(remaining);
  } finally {
    flushing = false;
  }
}
