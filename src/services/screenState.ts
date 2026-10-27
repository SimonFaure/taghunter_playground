// Tracks what THIS device is currently showing - its top-most visible layer -
// and reports it up to every paired mother so the mother's Devices modal can
// render a live "what's it showing" pill per peer.
//
// Two-layer model (overlay wins):
//   base    - 'home' (not in a game) or 'in_game' (a game page is mounted).
//             Set by App / GamePage.
//   overlay - 'ranking' / 'video' / 'logo' / 'locked', a full-screen layer
//             floating over the base. Pushed/popped by the leaderboard pages,
//             the operator video overlay, the idle logo screen and the PIN lock
//             screen. The most-recently-pushed overlay is the effective state -
//             except 'locked', which always wins (the lock screen covers
//             everything); when none are mounted the base shows through.
//
// On every effective-state change we (1) cache the value in-process via the
// `client_set_screen_state` Tauri command so the satellite's regular ~10s ping
// always carries the current state, and (2) fire a debounced out-of-band ping
// to every paired mother so the change is reflected within ~1s rather than
// waiting for the next scheduled heartbeat. The mother reads its OWN row from
// this store directly (it never pings itself) - see GameDevicesModal.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getActiveLaunchedGameId } from './activeGameStore';

/** What the game page is on, within the game: its registration screen
 *  (self-registered Quest / Clash: the operator can Start it remotely), a
 *  results screen waiting for the operator (Mystery summary, Tracks result:
 *  remote "reset display"), or the instructions / reveal animation. */
export type InGameSub = 'instructions' | 'reveal' | 'register' | 'results';

export type ScreenState =
  | { kind: 'home' }
  | {
      kind: 'in_game';
      launchedGameId: number | null;
      gameName: string | null;
      // Within-game refinements, reported by the game-type pages
      // (refineInGame). Absent: the pill renders a plain "In game".
      boardHidden?: boolean;
      sub?: InGameSub;
    }
  | { kind: 'ranking' }
  | { kind: 'video' }
  | { kind: 'logo' }
  | { kind: 'locked' };

type BaseState = Extract<ScreenState, { kind: 'home' | 'in_game' }>;
type OverlayKind = 'ranking' | 'video' | 'logo' | 'locked';

let base: BaseState = { kind: 'home' };
// Within-game detail, kept apart from `base`: the game-type page (a child)
// reports it before GamePage (its parent) sets the in_game base, and GamePage
// re-sets the base without knowing about it. Merged while the base is that
// same game.
let refinement: { launchedGameId: number; boardHidden?: boolean; sub?: InGameSub } | null = null;
// Stack of mounted overlays; the top (last) wins. A stack rather than a single
// flag so an unmounting overlay cleanly reveals whatever is still beneath it.
const overlays: OverlayKind[] = [];
let current: ScreenState = { kind: 'home' };

const listeners = new Set<(s: ScreenState) => void>();

function resolveEffective(): ScreenState {
  if (overlays.includes('locked')) return { kind: 'locked' };
  if (overlays.length > 0) return { kind: overlays[overlays.length - 1] };
  if (base.kind === 'in_game' && refinement && refinement.launchedGameId === base.launchedGameId) {
    const { boardHidden, sub } = refinement;
    return {
      ...base,
      ...(boardHidden ? { boardHidden } : {}),
      ...(sub ? { sub } : {}),
    };
  }
  return base;
}

function sameState(a: ScreenState, b: ScreenState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'in_game' && b.kind === 'in_game') {
    return (
      a.launchedGameId === b.launchedGameId &&
      a.gameName === b.gameName &&
      Boolean(a.boardHidden) === Boolean(b.boardHidden) &&
      a.sub === b.sub
    );
  }
  return true;
}

let pingTimer: ReturnType<typeof setTimeout> | null = null;

/** Ping every paired mother now, so a state change reaches it within ~1s
 *  (also used by services/upkeepState). */
export async function pingMothersNow(): Promise<void> {
  try {
    const mothers = await invoke<Array<{ mother_uuid: string }>>(
      'client_list_paired_mothers'
    );
    const launchedGameId = getActiveLaunchedGameId();
    await Promise.all(
      mothers.map((m) =>
        invoke('client_ping_mother', {
          motherUuid: m.mother_uuid,
          launchedGameId,
        }).catch(() => {})
      )
    );
  } catch {
    // Not paired to any mother (we ARE the mother, or web build) - nothing to
    // push. The mother reads its own state from this store directly.
  }
}

function publish(state: ScreenState): void {
  // Cache in-process immediately so the next scheduled ping carries it even if
  // the debounced out-of-band ping is still pending.
  void invoke('client_set_screen_state', { json: JSON.stringify(state) }).catch(
    () => {}
  );
  // Debounce the network burst: rapid transitions (e.g. ranking opening over a
  // game) collapse into a single ping ~500ms after they settle.
  if (pingTimer) clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    pingTimer = null;
    void pingMothersNow();
  }, 500);
}

function recompute(): void {
  const next = resolveEffective();
  if (sameState(next, current)) return;
  current = next;
  for (const l of listeners) l(current);
  publish(current);
}

// ---------- in-game flag (base only, overlays ignored) ----------
// App-wide banners sit at the bottom so they don't cover the top bar, but go
// back to the top while a game page is mounted (the kiosk screen has no top
// bar). A ranking/video overlay over a running game still counts as in game.

const inGameListeners = new Set<(inGame: boolean) => void>();
let lastInGame = false;

function notifyInGame(): void {
  const inGame = base.kind === 'in_game';
  if (inGame === lastInGame) return;
  lastInGame = inGame;
  for (const l of inGameListeners) l(inGame);
}

export function useInGame(): boolean {
  const [inGame, setInGame] = useState(lastInGame);
  useEffect(() => {
    inGameListeners.add(setInGame);
    setInGame(lastInGame);
    return () => {
      inGameListeners.delete(setInGame);
    };
  }, []);
  return inGame;
}

// ---------- base setters (App / GamePage) ----------

export function setBaseHome(): void {
  base = { kind: 'home' };
  refinement = null;
  recompute();
  notifyInGame();
}

export function setBaseInGame(launchedGameId: number | null, gameName: string | null): void {
  base = { kind: 'in_game', launchedGameId, gameName };
  recompute();
  notifyInGame();
}

/** Report within-game detail for `launchedGameId` (the game-type pages).
 *  Replaces the previous detail; shown only while that game is the base, so a
 *  stray late call can't resurrect a game pill after the page unmounted. */
export function refineInGame(
  launchedGameId: number,
  detail: { boardHidden?: boolean; sub?: InGameSub },
): void {
  refinement = { launchedGameId, ...detail };
  recompute();
}

/** The game-type page unmounted: drop its detail (only if still its own). */
export function clearInGameRefinement(launchedGameId: number): void {
  if (refinement?.launchedGameId !== launchedGameId) return;
  refinement = null;
  recompute();
}

// ---------- overlay push/pop (leaderboard / video / logo / lock) ----------

export function pushOverlay(kind: OverlayKind): void {
  // De-dupe: a re-mount shouldn't stack two copies. Move-to-top so the newest
  // mount wins even if an older same-kind entry lingers.
  const i = overlays.indexOf(kind);
  if (i !== -1) overlays.splice(i, 1);
  overlays.push(kind);
  recompute();
}

export function popOverlay(kind: OverlayKind): void {
  const i = overlays.indexOf(kind);
  if (i === -1) return;
  overlays.splice(i, 1);
  recompute();
}

// ---------- read / subscribe (modal self row) ----------

export function getCurrentScreenState(): ScreenState {
  return current;
}

export function subscribeScreenState(fn: (s: ScreenState) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}
