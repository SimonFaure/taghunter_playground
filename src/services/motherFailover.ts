// Mother-failover slice 5: satellite-side auto-re-point + "Mother unreachable"
// signal.
//
// When the mother a satellite is talking to dies mid-game, its `launched_games`
// calls fail with a transport error (not a 404). api.ts catches that and calls
// the handler registered here, which browses mDNS for the promoted mother
// (matching this device's client_id, highest epoch) and re-points the LAN
// override at it - reusing the SAME peer_secret, which the new mother honours
// because it adopted the old mother's paired_devices table (slice 4).
//
// It also drives a passive "⚠ Mother unreachable" badge: unreachable flips true
// the moment a re-point is attempted and back to false the moment one succeeds,
// so the footer can tell the operator a promotion is needed.

import { invoke } from '@tauri-apps/api/core';
import {
  getLanOverride,
  setLanOverride,
  setLanRepointHandler,
  setLanContactHandler,
} from './api';
import { getAuthUser } from './authStore';
import { getActiveLaunchedGameId } from './activeGameStore';
import { getDb } from './db';

interface DiscoveredMother {
  mother_uuid: string;
  host: string;
  addresses: string[];
  port: number;
  label: string | null;
  client_id: number | null;
  epoch: number | null;
}

// ─── "Mother unreachable" badge pub/sub ──────────────────────────────────────
type ReachListener = (unreachable: boolean) => void;
const reachListeners = new Set<ReachListener>();
let motherUnreachable = false;

// Has this device actually REACHED a remote mother at least once this session?
// The LAN override is persisted, so on a cold boot the very first launched_games
// call can fail simply because we haven't (re)connected yet - which is NOT a
// failover situation. The "become mother" banner is a *loss of contact* signal,
// so we only raise it once contact was genuinely established. Set by api.ts via
// the contact handler below; never cleared (the session-long fact is "we were
// connected at some point", which is exactly what makes a later failure a loss).
let hadMotherContact = false;

/** Subscribe to the "mother unreachable" flag. Fires immediately with current. */
export function onMotherReachability(l: ReachListener): () => void {
  reachListeners.add(l);
  l(motherUnreachable);
  return () => {
    reachListeners.delete(l);
  };
}

function setMotherUnreachable(v: boolean): void {
  if (motherUnreachable === v) return;
  motherUnreachable = v;
  for (const l of reachListeners) {
    try {
      l(v);
    } catch (e) {
      console.error('[motherFailover] reachability listener threw:', e);
    }
  }
}

// ─── re-point ────────────────────────────────────────────────────────────────
function pickAddress(addresses: string[]): string | null {
  const ipv4 = addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  return ipv4 ?? addresses[0] ?? null;
}

// Epoch of the game this device currently has cached (active game, else the
// most recent snapshot). 0 if none. Used to require a strictly-higher epoch
// before following a discovered mother.
async function getCachedGameEpoch(): Promise<number> {
  try {
    const db = await getDb();
    const active = getActiveLaunchedGameId();
    if (active != null) {
      const rows = await db.select<Array<{ mother_epoch: number }>>(
        'SELECT mother_epoch FROM mother_snapshots WHERE launched_game_id = ?',
        [active]
      );
      if (rows[0]) return rows[0].mother_epoch;
    }
    const latest = await db.select<Array<{ mother_epoch: number }>>(
      'SELECT mother_epoch FROM mother_snapshots ORDER BY updated_at DESC LIMIT 1'
    );
    return latest[0]?.mother_epoch ?? 0;
  } catch {
    return 0;
  }
}

let repointInFlight: Promise<boolean> | null = null;

async function repointToNewMother(): Promise<boolean> {
  // Coalesce concurrent failures (state poll + loadTeams can fail together).
  if (repointInFlight) return repointInFlight;
  repointInFlight = (async () => {
    const override = getLanOverride();
    // Only meaningful when we're a SATELLITE pointed at a remote mother. The
    // mother's own server is 127.0.0.1; if that's unreachable, re-pointing
    // can't help (it's our own process), and we'd risk hijacking our own route.
    if (!override || override.baseUrl.includes('127.0.0.1')) return false;

    // Only surface the banner if we LOST a mother we were actually talking to.
    // A boot-time failure against a stale persisted override means "not yet
    // connected", not "mother died" - re-point silently in that case.
    if (hadMotherContact) setMotherUnreachable(true);
    try {
      const mothers = await invoke<DiscoveredMother[]>('client_discover_mothers', {
        timeoutMs: 4000,
      });
      const me = await getAuthUser().catch(() => null);
      const myClientId = me?.client_id ?? null;
      const deadBase = override.baseUrl;

      // The epoch of the game we cached. A VALID new mother must advertise a
      // strictly higher epoch - i.e. an actual promotion. This is what stops us
      // re-pointing at an idle server (every device runs one at epoch 1, incl.
      // our own) and mistaking it for the new mother.
      const cachedEpoch = await getCachedGameEpoch();

      const best = mothers
        .filter((m) => m.addresses.length > 0 && m.port > 0)
        // Match our client when both sides advertise it; tolerate older mothers
        // that don't (client_id === null) rather than excluding them.
        .filter((m) => myClientId == null || m.client_id == null || m.client_id === myClientId)
        // Only a genuine promotion - strictly higher epoch than what we have.
        .filter((m) => (m.epoch ?? 0) > cachedEpoch)
        .map((m) => ({ m, base: `http://${pickAddress(m.addresses)}:${m.port}` }))
        .filter((c) => !c.base.includes('null') && c.base !== deadBase)
        // Highest epoch wins - that's the most recently promoted mother.
        .sort((a, b) => (b.m.epoch ?? 0) - (a.m.epoch ?? 0))[0];

      if (!best) return false;

      // Reuse the existing bearer: the promoted mother adopted the old mother's
      // paired_devices, so our peer_secret still authenticates.
      setLanOverride({
        baseUrl: best.base,
        token: override.token,
        endpoints: override.endpoints,
      });

      // Adopt the new mother as a paired mother so the FOOTER connection
      // indicator (which pings paired_mothers by uuid, independent of the
      // launched_games override) tracks it instead of the dead old one. Reuse
      // our existing secret; cache its endpoint so the footer reconnects fast.
      try {
        await invoke('client_save_paired_mother', {
          motherUuid: best.m.mother_uuid,
          motherLabel: best.m.label,
          peerSecret: override.token,
        });
        await invoke('client_refresh_mother_endpoints', { timeoutMs: 2500 }).catch(() => {});
      } catch (e) {
        console.warn('[motherFailover] could not register new mother as paired:', e);
      }

      setMotherUnreachable(false);
      return true;
    } catch (e) {
      console.error('[motherFailover] re-point failed:', e);
      return false;
    } finally {
      repointInFlight = null;
    }
  })();
  return repointInFlight;
}

/**
 * Called once this device has become the mother (slice 4). Clears the
 * unreachable flag - we ARE the mother now, so there's nothing to reconnect to
 * and the warning banner must go away.
 */
export function notifyPromotedToMother(): void {
  setMotherUnreachable(false);
}

/**
 * Which launched game to promote this device into. Prefers the game currently
 * mounted on screen; falls back to the most-recently-cached snapshot so the
 * promote action works even when the game page isn't mounted (e.g. the operator
 * is on the games list when the mother dies). Returns null if this device has
 * never cached a game - nothing to promote.
 */
export async function getPromotableGameId(): Promise<number | null> {
  const active = getActiveLaunchedGameId();
  if (active != null) return active;
  try {
    const rows = await (await getDb()).select<Array<{ launched_game_id: number }>>(
      'SELECT launched_game_id FROM mother_snapshots ORDER BY updated_at DESC LIMIT 1'
    );
    return rows[0]?.launched_game_id ?? null;
  } catch {
    return null;
  }
}

let installed = false;

/** Register the re-point handler with api.ts. Idempotent; call once at boot. */
export function installMotherFailover(): void {
  if (installed) return;
  installed = true;
  setLanRepointHandler(repointToNewMother);
  setLanContactHandler(() => {
    hadMotherContact = true;
  });
}
