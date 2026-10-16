// Mother-failover slice 5: satellite-side auto-re-point + "Mother unreachable"
// signal.
//
// When the mother a satellite is talking to dies mid-game, its `launched_games`
// calls fail with a transport error (not a 404). api.ts catches that and calls
// the handler registered here, which browses mDNS for the promoted mother
// (matching this device's client_id) and re-points the LAN override at it -
// reusing the SAME peer_secret, which the new mother honours because it adopted
// the old mother's paired_devices table (slice 4).
//
// Selecting the replacement is VERIFIED, not inferred (Ludiom #74): each
// candidate is asked, over the address that actually answers, whether it serves
// our game with our token. The old rule - "advertises a higher epoch than the
// snapshot we cached" - was a guess that could be permanently wrong, and the
// address was picked blind from the mDNS record, which on a multi-address
// mother meant installing an APIPA address the probe had never validated.
//
// It also drives a passive "⚠ Mother unreachable" badge, from two independent
// signals: a re-point attempt after live contact was lost, and childControlLink
// reporting that we are a child whose paired mother will not resolve.

import { invoke } from '@tauri-apps/api/core';
import {
  getLanOverride,
  setLanOverride,
  setLanRepointHandler,
  setLanContactHandler,
  LOCAL_ONLY_ENDPOINTS,
} from './api';
import { getAuthUser } from './authStore';
import { getActiveLaunchedGameId } from './activeGameStore';
import { getDb } from './db';

/** Verdict on one candidate mother - see Rust `client_verify_mother_candidate`. */
interface CandidateCheck {
  ok: boolean;
  base_url: string | null;
  mother_uuid: string | null;
  client_id: number | null;
  serves_game: boolean;
  mother_epoch: number | null;
  state_version: number | null;
  detail: string | null;
}

interface DiscoveredMother {
  mother_uuid: string;
  host: string;
  addresses: string[];
  port: number;
  label: string | null;
  client_id: number | null;
  epoch: number | null;
  /** 'm' = the device set as the mother, 's' = a substitute, null = older build. */
  role: string | null;
}

/** The device set as the mother first, then the highest epoch. */
function byRoleThenEpoch(a: DiscoveredMother, b: DiscoveredMother): number {
  const rank = (m: DiscoveredMother) => (m.role === 'm' ? 1 : 0);
  return rank(b) - rank(a) || (b.epoch ?? 0) - (a.epoch ?? 0);
}

// ─── "Mother unreachable" badge pub/sub ──────────────────────────────────────
//
// Retours sept. #22: the banner used to be a single boolean that every transport
// error set and every cache-resolved route tick cleared, so during a takeover it
// blinked red/normal for minutes on devices that were in fact recovering on
// their own. It is now a small state machine with hysteresis:
//
//   ok ──loss──▶ reconnecting ──60 s without real contact──▶ lost
//    ▲                │                                        │
//    └── 2 consecutive real successes (or a verified re-point) ┘
//
// "reconnecting" is a calm "don't touch anything" bar; only "lost" shows the red
// banner with its Rejoin / Become-mother actions. Any failure resets the success
// streak, so alternating fail/succeed can no longer flap the display.
export type ReachState = 'ok' | 'reconnecting' | 'lost';
type ReachListener = (unreachable: boolean) => void;
type StateListener = (state: ReachState) => void;
const reachListeners = new Set<ReachListener>();
const stateListeners = new Set<StateListener>();
let reachState: ReachState = 'ok';
let lostTimer: ReturnType<typeof setTimeout> | null = null;
let successStreak = 0;
const LOST_AFTER_MS = 60_000;
const SUCCESSES_TO_RECOVER = 2;

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
  l(reachState !== 'ok');
  return () => {
    reachListeners.delete(l);
  };
}

/** Subscribe to the three-state reachability. Fires immediately with current. */
export function onMotherReachState(l: StateListener): () => void {
  stateListeners.add(l);
  l(reachState);
  return () => {
    stateListeners.delete(l);
  };
}

export function getMotherReachState(): ReachState {
  return reachState;
}

function emitState(next: ReachState): void {
  if (reachState === next) return;
  const wasUnreachable = reachState !== 'ok';
  reachState = next;
  // Back in contact: whoever took over is now simply "our mother".
  if (next === 'ok') noteMotherTakeover(null);
  for (const l of stateListeners) {
    try {
      l(next);
    } catch (e) {
      console.error('[motherFailover] reach-state listener threw:', e);
    }
  }
  const unreachable = next !== 'ok';
  if (unreachable !== wasUnreachable) {
    for (const l of reachListeners) {
      try {
        l(unreachable);
      } catch (e) {
        console.error('[motherFailover] reachability listener threw:', e);
      }
    }
  }
}

/** A failure signal. Starts (or keeps) the reconnecting phase. */
function noteMotherLoss(): void {
  successStreak = 0;
  if (reachState !== 'ok') return;
  emitState('reconnecting');
  if (lostTimer) clearTimeout(lostTimer);
  lostTimer = setTimeout(() => {
    lostTimer = null;
    if (reachState === 'reconnecting') emitState('lost');
  }, LOST_AFTER_MS);
}

/** A success signal. `verified` (a proven re-point / promotion) recovers at once. */
function noteMotherContact(verified: boolean): void {
  if (reachState === 'ok') {
    successStreak = 0;
    return;
  }
  successStreak += 1;
  if (!verified && successStreak < SUCCESSES_TO_RECOVER) return;
  successStreak = 0;
  if (lostTimer) {
    clearTimeout(lostTimer);
    lostTimer = null;
  }
  emitState('ok');
}

function setMotherUnreachable(v: boolean): void {
  if (v) noteMotherLoss();
  else noteMotherContact(true);
}

// ─── re-point ────────────────────────────────────────────────────────────────
// NOTE (Ludiom #74): there is deliberately no address picker here any more. We
// used to take the first IPv4 out of the mDNS record and build the base URL from
// it, while the liveness probe below went through Rust's `order_pair_candidates`
// - which sorts same-subnet first and APIPA last. On a mother advertising
// several addresses (e.g. `169.254.x` next to a LAN IP), the two disagreed:
// the probe succeeded on the routable address, we installed the link-local one,
// cleared the "unreachable" badge on that false success, and every later call
// failed. The address we install is now, always, the one the probe reached.

// Identity of the mother whose game this device currently has cached (active
// game, else the most recent unfinished snapshot): its epoch and its uuid.
//
//  - `epoch` (0 if none) is the floor for the degraded path that still selects
//    on epoch alone - see the candidate loop.
//  - `motherUuid` (null if none/unparseable) identifies the mother that WROTE
//    that snapshot - i.e. the one that just died. It's the reliable way to tell
//    "this is the dead mother" apart from "this is its replacement": the
//    address proves nothing (a router's DHCP can hand the replacement the dead
//    mother's IP, and bind_mother_listener prefers 47800, so the promoted mother
//    may advertise a byte-identical base URL).
async function getCachedMotherIdentity(): Promise<{ epoch: number; motherUuid: string | null }> {
  const parse = (row?: { mother_epoch: number; snapshot_json: string }) => {
    if (!row) return null;
    let motherUuid: string | null = null;
    try {
      const uuid = (JSON.parse(row.snapshot_json) as { mother_uuid?: unknown }).mother_uuid;
      if (typeof uuid === 'string' && uuid) motherUuid = uuid;
    } catch {
      /* a corrupt snapshot still yields a usable epoch */
    }
    return { epoch: row.mother_epoch, motherUuid };
  };
  try {
    const db = await getDb();
    type Row = { mother_epoch: number; snapshot_json: string };
    const active = getActiveLaunchedGameId();
    if (active != null) {
      const rows = await db.select<Row[]>(
        'SELECT mother_epoch, snapshot_json FROM mother_snapshots WHERE launched_game_id = ?',
        [active]
      );
      // Deliberately NO fallback to another game when we're in one: an epoch
      // borrowed from last week's session is not this game's epoch, and using
      // it as a floor made the promotion filter permanently unsatisfiable
      // (Ludiom #74). No row for the game we're playing means "we know
      // nothing", which is epoch 0 - not "some other number".
      return parse(rows[0]) ?? { epoch: 0, motherUuid: null };
    }
    // Idle: the most recent snapshot is the best guess at who we were talking
    // to - but only among games that are still running. A finished game's
    // mother is not a corpse worth avoiding, and its epoch is not a floor.
    const latest = await db.select<Row[]>(
      'SELECT mother_epoch, snapshot_json FROM mother_snapshots ORDER BY updated_at DESC LIMIT 10'
    );
    for (const row of latest) {
      try {
        if ((JSON.parse(row.snapshot_json) as { game?: { ended?: unknown } }).game?.ended === true) {
          continue;
        }
      } catch {
        /* unparseable: parse() below still yields a usable epoch */
      }
      const hit = parse(row);
      if (hit) return hit;
    }
    return { epoch: 0, motherUuid: null };
  } catch {
    return { epoch: 0, motherUuid: null };
  }
}

/** Our own advertised mother uuid, so we never re-point at our own idle server. */
async function getSelfUuid(): Promise<string | null> {
  try {
    const id = await invoke<{ device_uuid: string }>('client_get_device_identity');
    return id?.device_uuid ?? null;
  } catch {
    return null;
  }
}

let repointInFlight: Promise<boolean> | null = null;

async function repointToNewMother(opts?: { force?: boolean }): Promise<boolean> {
  // Coalesce concurrent failures (state poll + loadTeams can fail together).
  if (repointInFlight) return repointInFlight;
  const force = opts?.force === true;
  repointInFlight = (async () => {
    const override = getLanOverride();
    // Automatically, this is only meaningful when we're a SATELLITE pointed at
    // a remote mother: the mother's own server is 127.0.0.1, and re-pointing
    // away from our own process would hijack our own route. An operator asking
    // for it explicitly (`force`) overrides that - they can see the device is
    // stranded, whatever the override says.
    if (!force && (!override || override.baseUrl.includes('127.0.0.1'))) return false;

    // Only surface the banner if we LOST a mother we were actually talking to.
    // A boot-time failure against a stale persisted override means "not yet
    // connected", not "mother died" - re-point silently in that case.
    if (hadMotherContact && !force) setMotherUnreachable(true);
    // The bearer to present. Normally the override's (the promoted mother
    // adopted the pairing row it belongs to). With no override - a forced
    // rejoin on a device whose route was cleared - fall back to our own self
    // secret, which a mother promoted from THIS device honours. No secret at
    // all means pairing is the only way in; the caller falls back to that.
    const token =
      override?.token ??
      (force ? await invoke<string | null>('get_self_peer_secret').catch(() => null) : null);
    if (!token) return false;
    try {
      const mothers = await invoke<DiscoveredMother[]>('client_discover_mothers', {
        timeoutMs: 4000,
      });
      const me = await getAuthUser().catch(() => null);
      const myClientId = me?.client_id ?? null;

      // Identity of the mother whose snapshot we hold - i.e. the one that just
      // died. A valid replacement is a DIFFERENT device that passes the
      // verification below; the epoch only orders the candidates.
      //
      // We deliberately do NOT reject a candidate for reusing the dead mother's
      // base URL: the promoted device can get the very same IP (DHCP reuse)
      // and binds the same preferred port 47800. Comparing base URLs there
      // discarded the ONLY correct candidate and made failover structurally
      // impossible - uuid + epoch are the identity, the address is not.
      const { epoch: cachedEpoch, motherUuid: deadUuid } = await getCachedMotherIdentity();
      const selfUuid = await getSelfUuid();
      // Which game we're trying to get back into. The active one if a game page
      // is mounted, else the most recent unfinished cached game - the same
      // resolution the "Become mother" button uses.
      const gameId = getActiveLaunchedGameId() ?? (await getPromotableGameId());

      const candidates = mothers
        .filter((m) => m.addresses.length > 0 && m.port > 0)
        // Match our client when both sides advertise it; tolerate older mothers
        // that don't (client_id === null) rather than excluding them.
        .filter((m) => myClientId == null || m.client_id == null || m.client_id === myClientId)
        // Never follow the corpse back to the same machine - but only on the
        // degraded, unverified path. With a game to verify against, the check
        // below proves the candidate is alive and serves us, which beats any
        // guess about who died. The guess was wrong in the field: once this
        // satellite cached a snapshot FROM the promoted mother, `deadUuid` named
        // the LIVE mother, so a single slow call made us refuse it and the
        // "lost the mother" banner kept popping up on a working connection.
        //
        // The device SET as the mother passes every guess below: it is the one
        // everybody follows once it is back. It returns idle, at a low epoch and
        // without the game a satellite still has on screen (the substitute
        // pushes it a moment later), so the epoch floor and the "serves our
        // game" check would both reject the only right answer - and leave the
        // red banner inviting a second substitute.
        .filter((m) => m.role === 'm' || gameId != null || deadUuid == null || m.mother_uuid !== deadUuid)
        // Never our own idle server (discovery includes self).
        .filter((m) => selfUuid == null || m.mother_uuid !== selfUuid)
        // Epoch is a PREFERENCE, not a gate, whenever we can verify a candidate
        // for real (below). It used to be a hard `> cachedEpoch` filter, which
        // is inference about who was promoted - and it locked satellites out
        // permanently whenever the cached epoch was wrong (Ludiom #74). We
        // still fall back to it when there's no game to verify against.
        .filter((m) => m.role === 'm' || gameId != null || (m.epoch ?? 0) > cachedEpoch)
        // The mother first, then the highest epoch - most likely the most
        // recently promoted substitute.
        .sort(byRoleThenEpoch);

      // Ask each candidate directly: are you reachable, do you honour our
      // token, and do you serve OUR game? `client_verify_mother_candidate`
      // answers all three in one round trip and hands back the address that
      // actually answered - which is the address we install, never one picked
      // blind from the mDNS record. This also settles the stale-record case: a
      // promoted mother can legitimately inherit the dead one's address, so
      // only the live uuid can tell them apart.
      let best: { base: string; uuid: string; label: string | null } | null = null;
      for (const c of candidates.slice(0, 3)) {
        const check = await invoke<CandidateCheck>('client_verify_mother_candidate', {
          addresses: c.addresses,
          port: c.port,
          launchedGameId: gameId,
          token,
        }).catch(() => null);
        if (!check?.ok || !check.base_url) continue;
        // The machine that answered must be the one mDNS advertised, and must
        // not be the corpse or ourselves.
        if (check.mother_uuid !== c.mother_uuid) continue;
        if (check.mother_uuid === selfUuid) continue;
        if (c.role !== 'm') {
          if (gameId == null && check.mother_uuid === deadUuid) continue;
          // With a game to check against, serving it is the whole point. Without
          // one, the epoch filter above already did the (weaker) selection.
          if (gameId != null && !check.serves_game) continue;
        }
        best = {
          base: check.base_url,
          uuid: check.mother_uuid ?? c.mother_uuid,
          label: c.label,
        };
        break;
      }

      if (!best) return false;

      // Reuse the existing bearer: the promoted mother adopted the old mother's
      // paired_devices, so our peer_secret still authenticates.
      setLanOverride({
        baseUrl: best.base,
        token,
        endpoints: override?.endpoints ?? LOCAL_ONLY_ENDPOINTS,
      });

      // Adopt the new mother as a paired mother so the FOOTER connection
      // indicator (which pings paired_mothers by uuid, independent of the
      // launched_games override) tracks it instead of the dead old one. Reuse
      // our existing secret; cache its endpoint so the footer reconnects fast.
      try {
        await invoke('client_save_paired_mother', {
          motherUuid: best.uuid,
          motherLabel: best.label,
          peerSecret: token,
        });
        await invoke('client_refresh_mother_endpoints', { timeoutMs: 2500 }).catch(() => {});
        // One mother per satellite: forget the ones we have not heard from in
        // 10 min (retours sept. #7/#18).
        await invoke('client_prune_paired_mothers', { keepUuid: best.uuid, staleMinutes: 10 }).catch(() => {});
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
 * Route-derived reachability, reported by childControlLink (Ludiom #74).
 *
 * The transport-error path can't be the only thing that raises the warning: it
 * requires an in-flight `launched_games` call AND prior live contact this
 * session, so a device that was pushed into a game and never had a successful
 * call - exactly the stranded second satellite - showed no banner at all, and
 * the operator had nothing to act on. "We are a child, we have a paired mother,
 * and it will not resolve" is an independent, honest loss signal. Two
 * consecutive offline ticks (~30s) to keep a single blip quiet.
 */
let offlineTicks = 0;
export function reportMotherRouteState(state: 'mother' | 'mother_offline' | 'local'): void {
  if (state === 'mother_offline') {
    offlineTicks += 1;
    if (offlineTicks >= 2) setMotherUnreachable(true);
    else successStreak = 0;
    return;
  }
  offlineTicks = 0;
  // A resolved route comes from the endpoint CACHE, not a live exchange: it
  // counts toward the success streak but can't clear the state on its own
  // (that was the flapping). 'local' means hosting/standalone - neither.
  if (state === 'mother') noteMotherContact(false);
}

/**
 * Operator-triggered "reconnect to the current mother", from the banner and the
 * Network tab. Same discovery + verification as the automatic path, minus the
 * throttling and minus the "we must already hold a remote override" guard - the
 * whole point is to run when the automatic path has given up or never fired.
 * Returns true if a mother route is now installed.
 */
export async function rejoinMotherNow(): Promise<boolean> {
  offlineTicks = 0;
  return repointToNewMother({ force: true });
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
    // `mother_snapshots` is never pruned, so the most recent row can belong to a
    // game that already ended (last week's session). Promoting into that would
    // silently resurrect the wrong game, so skip finished ones - the snapshot
    // carries the game's `ended` flag.
    const rows = await (await getDb()).select<Array<{ launched_game_id: number; snapshot_json: string }>>(
      'SELECT launched_game_id, snapshot_json FROM mother_snapshots ORDER BY updated_at DESC LIMIT 10'
    );
    for (const row of rows) {
      try {
        const ended = (JSON.parse(row.snapshot_json) as { game?: { ended?: unknown } }).game?.ended;
        if (ended === true) continue;
      } catch {
        /* unparseable snapshot: become_mother will reject it with a clear error */
      }
      return row.launched_game_id;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── "someone already took over" (retours sept. #10: first click wins) ───────
//
// Every satellite gets "Reprendre la partie" once the mother is lost, so two
// operators can race. Two guards make the FIRST click win:
//  - a promotion first looks for a mother that already took over (below) and
//    joins it instead (lanMotherBoot.promoteUnlessTakenOver);
//  - while 'lost', the satellites keep looking for that mother, announce it
//    ("PC2 prend le relais") and join it - the promote button disappears.
// A newly promoted mother is recognisable by its epoch: becomeMother bumps it
// above the one in the snapshot every satellite cached from the dead mother.

export interface TakeoverMother {
  mother_uuid: string;
  label: string | null;
  epoch: number;
}

/**
 * A same-client mother whose epoch beats our cached snapshot - i.e. one that
 * took over - or the device set as the mother, back on the network.
 */
export async function findTakeoverMother(timeoutMs = 2000): Promise<TakeoverMother | null> {
  try {
    const [mothers, me, cached, selfUuid] = await Promise.all([
      invoke<DiscoveredMother[]>('client_discover_mothers', { timeoutMs }),
      getAuthUser().catch(() => null),
      getCachedMotherIdentity(),
      getSelfUuid(),
    ]);
    const myClientId = me?.client_id ?? null;
    const hit = mothers
      .filter((m) => m.addresses.length > 0 && m.port > 0)
      .filter((m) => myClientId == null || m.client_id == null || m.client_id === myClientId)
      .filter((m) => selfUuid == null || m.mother_uuid !== selfUuid)
      .filter((m) => m.role === 'm' || (m.epoch ?? 0) > cached.epoch)
      .sort(byRoleThenEpoch)[0];
    return hit ? { mother_uuid: hit.mother_uuid, label: hit.label, epoch: hit.epoch ?? 0 } : null;
  } catch {
    return null;
  }
}

type TakeoverListener = (taker: TakeoverMother | null) => void;
const takeoverListeners = new Set<TakeoverListener>();
let currentTaker: TakeoverMother | null = null;

/** Subscribe to "another device took over the game". Fires immediately with current. */
export function onMotherTakeover(l: TakeoverListener): () => void {
  takeoverListeners.add(l);
  l(currentTaker);
  return () => {
    takeoverListeners.delete(l);
  };
}

export function noteMotherTakeover(taker: TakeoverMother | null): void {
  if (currentTaker?.mother_uuid === taker?.mother_uuid) return;
  currentTaker = taker;
  for (const l of takeoverListeners) {
    try {
      l(taker);
    } catch (e) {
      console.error('[motherFailover] takeover listener threw:', e);
    }
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
    // A real answer from the mother over the LAN route.
    noteMotherContact(false);
  });
}
