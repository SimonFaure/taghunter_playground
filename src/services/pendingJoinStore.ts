// Tiny module-level pub/sub used to hand a `taghunter://lan-command join_game`
// from the App-root listener (which doesn't know how to enter GamePage) down
// to LaunchedGamesList (which owns the playGameById helper). Pure event
// fanout - no persistence, no ordering guarantees beyond "subscribers see
// emits in the order they fire."

/**
 * The mother route resolved by the App-root listener from the push itself.
 * Carried alongside the id because LaunchedGamesList's own mount-time
 * `refreshLaunchedGamesRoute()` races this handoff and can restore the LOCAL
 * route in between - the subscriber re-applies this one so the game's meta is
 * always read from the mother that sent the push, never from our own server
 * (whose colliding launched_game id yields a plausible but foreign config).
 */
export interface PendingJoinRoute {
  baseUrl: string;
  token: string;
}

type Listener = (launchedGameId: number, route?: PendingJoinRoute) => void;

const listeners = new Set<Listener>();
// One-slot buffer: a join_game can arrive while the satellite is on a page
// where LaunchedGamesList (the only subscriber) isn't mounted yet. The App
// switches to the 'launched' page in response, but that mount happens a tick
// later - so we hold the last unhandled join and deliver it to the next
// subscriber. This guarantees "enter the in-game page no matter which page we
// were on" (e.g. settings, scenarios, rankings).
let buffered: { id: number; route?: PendingJoinRoute } | null = null;

export function onPendingJoin(l: Listener): () => void {
  listeners.add(l);
  if (buffered !== null) {
    const held = buffered;
    buffered = null;
    try {
      l(held.id, held.route);
    } catch (err) {
      console.error('[pendingJoinStore] listener threw:', err);
    }
  }
  return () => {
    listeners.delete(l);
  };
}

export function emitPendingJoin(launchedGameId: number, route?: PendingJoinRoute): void {
  if (listeners.size === 0) {
    buffered = { id: launchedGameId, route };
    return;
  }
  for (const l of listeners) {
    try {
      l(launchedGameId, route);
    } catch (err) {
      console.error('[pendingJoinStore] listener threw:', err);
    }
  }
}

// Mirror of the join channel for the mother's "Disconnect" push: tell the
// (mounted) LaunchedGamesList to leave the in-game page and return to the
// launched-games list. No buffering - a leave only matters while a game page is
// actually mounted; if it isn't, there is nothing to leave.
type LeaveListener = () => void;
const leaveListeners = new Set<LeaveListener>();

export function onPendingLeave(l: LeaveListener): () => void {
  leaveListeners.add(l);
  return () => {
    leaveListeners.delete(l);
  };
}

export function emitPendingLeave(): void {
  for (const l of leaveListeners) {
    try {
      l();
    } catch (err) {
      console.error('[pendingJoinStore] leave listener threw:', err);
    }
  }
}

// Pull-to-game channel for the "Reconnect" push landing on a device that is
// ALREADY in this game but has drifted onto its own in-game leaderboard /
// rankings overlay. emitPendingJoin re-mounts GamePage when it isn't already
// showing, but when it IS mounted React just re-renders it with the same state,
// leaving an open leaderboard up. This tells a mounted GamePage to drop those
// overlays and show the game itself. No buffering - it only matters while a
// GamePage is mounted; a fresh mount already starts on the game view. Carries
// the launched-game id so a stray push for a different game is ignored.
type RejoinListener = (launchedGameId: number) => void;
const rejoinListeners = new Set<RejoinListener>();

export function onPendingRejoin(l: RejoinListener): () => void {
  rejoinListeners.add(l);
  return () => {
    rejoinListeners.delete(l);
  };
}

export function emitPendingRejoin(launchedGameId: number): void {
  for (const l of rejoinListeners) {
    try {
      l(launchedGameId);
    } catch (err) {
      console.error('[pendingJoinStore] rejoin listener threw:', err);
    }
  }
}

// Config-reload channel for the mother's `reload_config` push: tell the
// (mounted) GamePage to re-derive its config from the freshly-saved meta so an
// edit made on another device applies live. No buffering - it only matters
// while a game page is mounted; if it isn't, the device will read the new
// config on its next join anyway. Carries the launched-game id so a stray push
// for a different game is ignored.
type ConfigReloadListener = (launchedGameId: number) => void;
const configReloadListeners = new Set<ConfigReloadListener>();

export function onPendingConfigReload(l: ConfigReloadListener): () => void {
  configReloadListeners.add(l);
  return () => {
    configReloadListeners.delete(l);
  };
}

export function emitPendingConfigReload(launchedGameId: number): void {
  for (const l of configReloadListeners) {
    try {
      l(launchedGameId);
    } catch (err) {
      console.error('[pendingJoinStore] config-reload listener threw:', err);
    }
  }
}
