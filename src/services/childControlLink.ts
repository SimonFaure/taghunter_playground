// Child → mother "control link": keeps this device's `launched_games` traffic
// pointed at the mother whenever one is present, so the launched-games page can
// LIST and OPERATE the mother's active games (add teams, change scores, launch
// on another device, stop, etc.) even when this device has NOT joined a game.
//
// This is the reachability half of "children control the mother's games":
//   - A child paired to a reachable mother → override points at the mother.
//   - A mother host / standalone device → keeps its own local server.
//
// Authorization is already handled mother-side: every game on the mother is
// stamped with the mother's own client_id, and mutations/commands authorize on
// the bearer token (any paired device), so once the override points at the
// mother a child can do everything the mother can. The "This device" section of
// the page reads the child's own local history via api.ts `forceLocal`.

import { invoke } from '@tauri-apps/api/core';
import { pointLaunchedGamesAtMother, restoreLocalLaunchedGames, autoJoinSameClientMother } from './lanMotherBoot';
import { setLanReauthHandler, setLanNoRouteHandler } from './api';
import {
  reportMotherRouteState, rejoinMotherNow, onMotherReachState, findTakeoverMother, noteMotherTakeover,
} from './motherFailover';
import { getAuthUser } from './authStore';

interface MotherLink {
  base_url: string;
  token: string;
  mother_uuid: string;
}

interface LocalRole {
  is_mother_hosting: boolean;
  mother_server_running: boolean;
  paired_devices_count: number;
  paired_mothers_count: number;
}

export type LaunchedGamesRoute = 'mother' | 'mother_offline' | 'local';

// Notify listeners when the resolved route CHANGES (e.g. a satellite that just
// auto-paired transitions local→mother). The launched-games list subscribes so
// it reloads the moment routing converges, instead of showing an empty list
// until the operator manually refreshes.
type RouteListener = (route: LaunchedGamesRoute) => void;
const routeListeners = new Set<RouteListener>();
let lastRoute: LaunchedGamesRoute | null = null;
let lastMotherBase: string | null = null;

export function onLaunchedGamesRouteChange(l: RouteListener): () => void {
  routeListeners.add(l);
  return () => {
    routeListeners.delete(l);
  };
}

function emitRoute(route: LaunchedGamesRoute, motherBase: string | null): void {
  // Tell the failover badge what routing thinks, every tick - not only on a
  // change. "We're a child, we have a paired mother, it won't resolve" is a
  // loss signal in its own right, and it needs consecutive ticks to count
  // (see reportMotherRouteState).
  reportMotherRouteState(route);
  if (route === lastRoute && motherBase === lastMotherBase) return;
  lastRoute = route;
  lastMotherBase = motherBase;
  for (const l of routeListeners) {
    try {
      l(route);
    } catch (e) {
      console.error('[childControlLink] route listener threw:', e);
    }
  }
}

// Mother/hotspot role rework: a non-hosting device that isn't paired to a mother
// yet discovers + auto-pairs a same-client mother on the LAN (the mother
// auto-approves by client_id - no operator tap). Throttle the mDNS browse this
// needs so we don't multicast-storm while no mother is up yet.
let lastAutoJoinAttempt = 0;
const AUTO_JOIN_MIN_INTERVAL_MS = 15_000;
function autoJoinThrottleOk(): boolean {
  const now = Date.now();
  if (now - lastAutoJoinAttempt < AUTO_JOIN_MIN_INTERVAL_MS) return false;
  lastAutoJoinAttempt = now;
  return true;
}

/**
 * Resolve and install the `launched_games` route for THIS device. Cheap: the
 * primary lookup reads the warm mother-endpoint cache (no mDNS). Only when the
 * cache is cold AND a mother is paired do we warm it once via an mDNS browse.
 *
 *  - 'mother'         → override now points at a reachable mother.
 *  - 'mother_offline' → we are a child but the mother is unreachable right now;
 *                       the override is left as-is (a prior mother route stays,
 *                       so a transient drop doesn't lose the list) and we retry.
 *  - 'local'          → standalone / mother host; routed at our own server.
 */
export async function refreshLaunchedGamesRoute(): Promise<LaunchedGamesRoute> {
  try {
    let link = await invoke<MotherLink | null>('client_resolve_mother_link');
    let hasPairedMother = false;
    if (!link) {
      const role = await invoke<LocalRole>('client_describe_local_role').catch(
        () => null,
      );
      hasPairedMother =
        !!role && !role.is_mother_hosting && role.paired_mothers_count > 0;
      const hosting = !!role && (role.mother_server_running || role.is_mother_hosting);
      if (hasPairedMother) {
        // Cold cache (e.g. just after boot): warm it once, then retry.
        await invoke('client_refresh_mother_endpoints', { timeoutMs: 2500 }).catch(
          () => {},
        );
        link = await invoke<MotherLink | null>('client_resolve_mother_link');
      }
      // Not hosting and still no link - discover + auto-pair a same-client
      // mother on the LAN (auto-approved by client_id), then resolve its link.
      // This is what makes a willing device that STOOD DOWN at boot, and a
      // plain satellite, converge on the mother without any manual pairing.
      //
      // This deliberately runs even when we ALREADY have a paired mother whose
      // link won't resolve. After a failover the dead mother's paired_mothers
      // row survives, so paired_mothers_count stays > 0 forever; gating auto-join
      // on "not paired yet" meant a satellite could never discover the PROMOTED
      // mother (whose uuid isn't in paired_mothers, so client_refresh_mother_endpoints
      // - which intersects mDNS with that table - can never cache it either).
      // That was a permanent dead end. An unresolvable link is exactly the signal
      // that our paired set is stale, so re-discovery is the right response.
      if (!link && role && !hosting && autoJoinThrottleOk()) {
        const me = await getAuthUser().catch(() => null);
        if (me?.client_id != null) {
          const joined = await autoJoinSameClientMother(me.client_id).catch(() => false);
          if (joined) {
            await invoke('client_refresh_mother_endpoints', { timeoutMs: 2500 }).catch(
              () => {},
            );
            link = await invoke<MotherLink | null>('client_resolve_mother_link');
          }
        }
      }
    }
    if (link?.base_url && link.token) {
      pointLaunchedGamesAtMother(link.base_url, link.token);
      emitRoute('mother', link.base_url);
      return 'mother';
    }
    if (hasPairedMother) {
      // Child with an unreachable mother - keep whatever route is installed
      // (don't clobber a prior mother route) so the page can show an offline
      // state and recover on the next tick.
      emitRoute('mother_offline', null);
      return 'mother_offline';
    }
  } catch (err) {
    console.error('[childControlLink] refresh route failed:', err);
  }
  // Standalone / mother host: our own local server is the source of truth.
  restoreLocalLaunchedGames();
  emitRoute('local', null);
  return 'local';
}

/**
 * api.ts re-auth handler: a launched_games call to our paired mother came back
 * 401/403 - the mother rebuilt its pairing table and no longer honours our
 * stored secret. Re-pair (same-client auto-approve hands back a working secret,
 * whether the mother had us or not), re-resolve, and re-point the override with
 * the fresh secret so the retry authenticates. Self-heals a stale pairing - no
 * manual unpair. Returns true if we re-established a mother route.
 */
async function reauthPairedMother(): Promise<boolean> {
  const me = await getAuthUser().catch(() => null);
  if (me?.client_id == null) return false;
  const joined = await autoJoinSameClientMother(me.client_id).catch(() => false);
  if (!joined) return false;
  await invoke('client_refresh_mother_endpoints', { timeoutMs: 2500 }).catch(() => {});
  return (await refreshLaunchedGamesRoute()) === 'mother';
}

// A routeless launched_games call asks us to resolve a route NOW. Throttled on
// its own clock: a page can fire a burst of these (list + nav badge + poll) and
// they must collapse into one resolution attempt, not a browse each.
let lastNoRouteKick = 0;
const NO_ROUTE_MIN_INTERVAL_MS = 5_000;
function kickRouteResolution(): void {
  const now = Date.now();
  if (now - lastNoRouteKick < NO_ROUTE_MIN_INTERVAL_MS) return;
  lastNoRouteKick = now;
  void refreshLaunchedGamesRoute().catch(() => {});
}

export type RejoinOutcome = 'repointed' | 'repaired' | 'not_found';

/**
 * The operator's "reconnect to the mother" gesture (Ludiom #74), behind the
 * banner button and the Network-tab panel. Two attempts, safest first:
 *
 *  1. Re-point at a mother that already honours a secret we hold - the normal
 *     post-failover case, and the one that keeps us in the running game.
 *  2. Failing that, discover + pair afresh (a same-client mother auto-approves)
 *     and resolve the route. This covers the device that holds no usable
 *     secret at all, e.g. one whose route was cleared.
 *
 * Deliberately NOT a promotion: this rejoins the mother that exists. Promoting
 * this device is the other, heavier button next to it.
 */
export async function rejoinCurrentMother(): Promise<RejoinOutcome> {
  if (await rejoinMotherNow().catch(() => false)) return 'repointed';
  const me = await getAuthUser().catch(() => null);
  if (me?.client_id != null) {
    const joined = await autoJoinSameClientMother(me.client_id).catch(() => false);
    if (joined) {
      await invoke('client_refresh_mother_endpoints', { timeoutMs: 2500 }).catch(() => {});
      if ((await refreshLaunchedGamesRoute()) === 'mother') return 'repaired';
    }
  }
  return 'not_found';
}

let reauthInstalled = false;
/**
 * Register the api.ts hooks this module owns: the 401 re-auth/re-pair handler
 * and the "no route at all" kick. Idempotent; call once at boot.
 */
export function installLanReauth(): void {
  if (reauthInstalled) return;
  reauthInstalled = true;
  setLanReauthHandler(reauthPairedMother);
  setLanNoRouteHandler(kickRouteResolution);
  installTakeoverWatcher();
}

// Retours sept. #10, "first click wins": once the mother is lost, look every
// 5 s for a device that already took over. Found → announce it (the failover
// banner and the Network page drop the promote button and say "PC2 prend le
// relais") and join it, so no second satellite promotes itself. Only runs in
// the 'lost' state: during 'reconnecting' the normal re-point is still at work.
const TAKEOVER_POLL_MS = 5000;
function installTakeoverWatcher(): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const taker = await findTakeoverMother();
      if (!taker) return;
      noteMotherTakeover(taker);
      await rejoinCurrentMother().catch(() => 'not_found' as const);
    } finally {
      busy = false;
    }
  };
  onMotherReachState((st) => {
    if (st === 'lost') {
      if (!timer) {
        void tick();
        timer = setInterval(() => void tick(), TAKEOVER_POLL_MS);
      }
    } else if (st === 'ok' && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
