// Ludiom #76: converge a device that is NO LONGER the mother of a game it still
// holds rows for.
//
// `become_mother` is entirely local to the promoted device - it never writes
// back to the mother it replaced. So the old mother kept `ended = 0` and went on
// listing a game that had been finished elsewhere, with the scores frozen at the
// moment of the failover. `yieldToMother` now mirrors the winner's state at the
// moment it stands down, but that only covers the devices that actually yield:
// the yield poll needs this device to be SERVING and to see a higher-epoch
// mother over mDNS. A device that stood down at boot (the fence), or that ended
// up a satellite by any other route, has nothing that ever corrects it.
//
// This is that missing path. It runs on the App tick that the yield poll already
// owns - the two are exclusive, so there is no extra polling cost - and only for
// devices that are NOT currently hosting.

import { invoke } from '@tauri-apps/api/core';
import { applyMotherSnapshot, type ApplyOutcome } from './lanMotherBoot';
import { getAuthUser } from './authStore';
import { getDb } from './db';

interface MotherLink {
  base_url: string;
  token: string;
  mother_uuid: string;
}

interface TakeoverTarget {
  launched_game_id: number;
  game_name: string;
  addr: string;
  port: number;
  mother_uuid: string;
  epoch: number;
}

// A game whose owner moved on isn't a fast-moving thing: once a minute is plenty
// to correct a list, and it keeps the mDNS/HTTP cost negligible on a venue full
// of satellites.
const RECONCILE_MIN_INTERVAL_MS = 60_000;
let lastRun = 0;
let inFlight: Promise<void> | null = null;

// The snapshot identity (epoch:version) we last mirrored per game. Applying is a
// delete-and-reinsert of the whole game, so repeating it for a snapshot we have
// already written is pure churn on the DB the game page may be reading. Kept in
// memory only: after a restart one redundant apply is harmless.
const lastApplied = new Map<number, string>();
const stamp = (epoch: number, version: number) => `${epoch}:${version}`;

/** Split `http://1.2.3.4:47800` into the addr/port the Rust fetch expects. */
function parseBase(baseUrl: string): { addr: string; port: number } | null {
  try {
    const u = new URL(baseUrl);
    const port = Number(u.port);
    if (!u.hostname || !Number.isFinite(port) || port <= 0) return null;
    return { addr: u.hostname, port };
  } catch {
    return null;
  }
}

async function reconcileOne(
  gameId: number,
  localEpoch: number,
  clientId: number | null
): Promise<void> {
  const applyAndRecord = async (source: string): Promise<ApplyOutcome | null> => {
    const cached = await (await getDb())
      .select<Array<{ mother_epoch: number; state_version: number }>>(
        'SELECT mother_epoch, state_version FROM mother_snapshots WHERE launched_game_id = ?',
        [gameId]
      )
      .catch(() => [] as Array<{ mother_epoch: number; state_version: number }>);
    const row = cached[0];
    if (!row) return null;
    if (row.mother_epoch < localEpoch) return null;
    if (lastApplied.get(gameId) === stamp(row.mother_epoch, row.state_version)) return null;
    const outcome = await applyMotherSnapshot(gameId).catch(() => null);
    if (outcome?.applied) {
      lastApplied.set(gameId, stamp(outcome.mother_epoch, outcome.state_version));
      console.log(`[reconcile] game ${gameId}: mirrored from ${source} (ended=${outcome.ended})`);
    }
    return outcome;
  };

  // The cheap path: a snapshot we already cached (the ping piggybacks one on
  // every tick while a game is live) that is at least as new as our own rows.
  if ((await applyAndRecord('cache'))?.applied) return;

  // Otherwise go and ask. The mother we're routed at is the obvious source;
  // failing that, whichever higher-epoch mother mDNS can see.
  let addr: { addr: string; port: number } | null = null;
  const link = await invoke<MotherLink | null>('client_resolve_mother_link').catch(() => null);
  if (link?.base_url) addr = parseBase(link.base_url);
  if (!addr && clientId != null) {
    const target = await invoke<TakeoverTarget | null>('get_takeover_target', {
      clientId,
    }).catch(() => null);
    if (target?.launched_game_id === gameId) addr = { addr: target.addr, port: target.port };
  }
  if (!addr) return;

  const got = await invoke<boolean>('fetch_snapshot_from_mother', {
    launchedGameId: gameId,
    addr: addr.addr,
    port: addr.port,
  }).catch(() => false);
  if (!got) return;
  await applyAndRecord(addr.addr);
}

/**
 * Correct any local game that this device still shows as running while someone
 * else owns it. No-op on a device that is hosting (that case belongs to the
 * yield poll - and "never mirror over state we are serving" is enforced again
 * inside the Rust command). Throttled and coalesced; never throws.
 */
export async function reconcileSupersededGamesTick(): Promise<void> {
  if (inFlight) return inFlight;
  const now = Date.now();
  if (now - lastRun < RECONCILE_MIN_INTERVAL_MS) return;
  lastRun = now;
  inFlight = (async () => {
    try {
      const role = await invoke<{ mother_server_running: boolean }>(
        'client_describe_local_role'
      ).catch(() => null);
      if (!role || role.mother_server_running) return;

      const me = await getAuthUser().catch(() => null);
      const open = await (await getDb()).select<Array<{ id: number; mother_epoch: number }>>(
        'SELECT id, mother_epoch FROM lg_launched_games WHERE ended = 0'
      );
      for (const g of open) {
        await reconcileOne(g.id, g.mother_epoch ?? 1, me?.client_id ?? null).catch(() => {});
      }
    } catch (e) {
      console.warn('[reconcile] tick failed:', e);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
