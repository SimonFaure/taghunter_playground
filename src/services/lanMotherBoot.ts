// Production boot path for the mother's local axum server.
//
// Until this module was added, the in-process LAN server only ever ran inside
// `lanSmokeTest.ts` - every production `launched_games` request went straight
// to studio.taghunter.fr. That made the new Devices-modal endpoints
// (`list_paired_with_status`, push commands, etc.) unreachable, since they
// only exist in the local axum.
//
// `ensureMotherServer` is idempotent: at first call after app boot it starts
// the server and installs a permanent LAN override for the `launched_games`
// endpoint so all launched-game traffic goes local. On subsequent calls (e.g.
// a React re-mount), it picks the running server up via `mother_get_server_info`
// without restarting it.
//
// Tradeoff to be explicit about: once the LAN override is installed, launched
// games created via the new flow live in the mother's SQLite, NOT in studio's
// MySQL. Cross-device persistence + studio dashboard visibility is a follow-up
// (cloud-sync, slice E of the LAN-mode roadmap).

import { invoke } from '@tauri-apps/api/core';
import { setLanOverride, getLanOverride, setLocalLaunchedGamesRoute, LOCAL_ONLY_ENDPOINTS } from './api';
import {
  notifyPromotedToMother, getPromotableGameId, getCompanionGameIds, findTakeoverMother, noteMotherTakeover,
  rejoinMotherNow, type TakeoverMother,
} from './motherFailover';
import { getActiveLaunchedGameId } from './activeGameStore';
import { discoverOtherMothers, joinMother, speaksOurLanProto } from './lanPairing';
import { ensureFirewallRuleOnce } from './firewall';
import { getAuthUser } from './authStore';
import { getDeviceMetadata, getCachedDeviceDisplayName } from './device';
import { getHostingClaim } from './deviceRole';
import { reconcileWithMotherNow } from './motherStateReconcile';

export interface MotherServerInfo {
  port: number;
  bound_addr: string;
  mother_device_uuid: string;
  mother_peer_secret: string;
  mother_peer_id: number;
}

let bootPromise: Promise<MotherServerInfo | null> | null = null;
// Remembered so a satellite can restore its own local `launched_games` routing
// after leaving a mother's game (see point/restore helpers below).
let localInfo: MotherServerInfo | null = null;

// The LAN-routed endpoint family. Single source of truth lives in api.ts
// (LOCAL_ONLY_ENDPOINTS) so the override installers and the fail-closed gate
// can never drift apart.
const LAUNCHED_GAMES_ENDPOINTS = LOCAL_ONLY_ENDPOINTS;

// Record this device's OWN local server as the force-local route in api.ts, so
// the "This device" section can read local history even while the main override
// is pointed at a mother. Called whenever `localInfo` is (re)established.
function publishLocalRoute(info: MotherServerInfo): void {
  setLocalLaunchedGamesRoute({
    baseUrl: `http://127.0.0.1:${info.port}`,
    token: info.mother_peer_secret,
  });
}

/**
 * Repoint `launched_games` traffic at a MOTHER device (used when this device is
 * a satellite joining the mother's launched game). Reads/writes - game state,
 * register_device, punches - then hit the mother's SQLite instead of our own
 * empty local server. `baseUrl` like `http://192.168.1.20:47800`.
 */
export function pointLaunchedGamesAtMother(baseUrl: string, token: string): void {
  setLanOverride({ baseUrl, token, endpoints: LAUNCHED_GAMES_ENDPOINTS });
}

/** Restore `launched_games` routing to this device's own local server. */
export function restoreLocalLaunchedGames(): void {
  if (!localInfo) return;
  setLanOverride({
    baseUrl: `http://127.0.0.1:${localInfo.port}`,
    token: localInfo.mother_peer_secret,
    endpoints: LAUNCHED_GAMES_ENDPOINTS,
  });
}

/**
 * The name this device advertises as a mother: the operator's custom device
 * name, else the OS device label. Every hosting path resolves it here when its
 * caller passed none - promotion paths used to advertise NO label, so
 * satellites listed the new mother as a bare uuid prefix ("3ea399e5",
 * retours sept. #7). Rust still falls back to the PC name if this is empty.
 */
export async function defaultMotherLabel(): Promise<string | undefined> {
  const [displayName, meta] = await Promise.all([
    getCachedDeviceDisplayName().catch(() => null),
    getDeviceMetadata().catch(() => null),
  ]);
  return displayName || meta?.device_label || undefined;
}

export interface BecomeMotherInfo extends MotherServerInfo {
  epoch: number;
  /** Every game taken over: the requested one first, then the companions. */
  adopted_game_ids: number[];
  /** Companion games left behind, with the Rust reason (`ended`, `no_content`...). */
  skipped_games: Array<{ id: number; reason: string }>;
}

/**
 * Mother-failover slice 4: promote THIS device into the new mother for
 * `launchedGameId`, adopting its cached snapshot (game state + pairing table),
 * bumping the epoch and announcing itself over mDNS on the LAN. On success
 * this device's `launched_games` traffic is routed at its own freshly-started
 * server. Throws with a human-readable message on the guards (no cached
 * snapshot on this device / scenario content not synced).
 *
 * The device hosts in the role it is SET to: the mother when "Rôle de ce
 * poste" says so (it takes a running game back from a substitute), a
 * substitute otherwise. Taking a game over never changes that setting.
 *
 * `alsoGameIds`: the dead mother's other running games this device cached
 * (`getCompanionGameIds`), taken over in the same step. Left empty when taking
 * a game from a LIVE mother: its other games come back fresher through
 * reconciliation than from our cache.
 */
export async function becomeMother(
  launchedGameId: number,
  mdnsLabel?: string,
  alsoGameIds: number[] = []
): Promise<BecomeMotherInfo> {
  const claim = await getHostingClaim();
  const info = await invoke<BecomeMotherInfo>('become_mother', {
    launchedGameId,
    port: 0, // 0 = OS picks; the command returns the actual port
    mdnsLabel: mdnsLabel ?? (await defaultMotherLabel()) ?? null,
    configured: claim.configured,
    designatedAt: claim.designatedAt,
    alsoGameIds,
  });
  if (info.skipped_games?.length) {
    console.warn('[becomeMother] companion games not taken over:', info.skipped_games);
  }
  // We are the mother now - route launched_games at our own server and let
  // ensureMotherServer pick this up on subsequent calls without restarting.
  localInfo = info;
  publishLocalRoute(info);
  bootPromise = Promise.resolve(info);
  setLanOverride({
    baseUrl: `http://127.0.0.1:${info.port}`,
    token: info.mother_peer_secret,
    endpoints: LAUNCHED_GAMES_ENDPOINTS,
  });
  // First time this device hosts, make sure satellites can actually reach it
  // (one-time UAC for the firewall rule). Fire-and-forget so the promotion isn't
  // blocked on the prompt.
  void ensureFirewallRuleOnce();
  // We're the mother now - clear the "unreachable" banner.
  lastPromotedAt = Date.now();
  notifyPromotedToMother();
  return info;
}

// When this device last promoted itself. For two minutes after, the App's
// superseded-mother check runs every 5 s instead of 20 s, so two satellites
// promoted in the same second converge fast (retours sept. #10).
let lastPromotedAt = 0;
export function msSincePromotion(): number {
  return lastPromotedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastPromotedAt;
}

export type PromoteOutcome =
  | { kind: 'promoted'; info: MotherServerInfo }
  | { kind: 'joined'; taker: TakeoverMother };

/**
 * "Reprendre la partie" with first-click-wins (retours sept. #10): if another
 * satellite already took over (a same-client mother above our cached epoch),
 * join it instead of promoting a second mother. Only otherwise becomeMother.
 * Two clicks in the very same second both promote; the equal-epoch tie-break
 * in `get_takeover_target` then makes the higher uuid yield.
 */
export async function promoteUnlessTakenOver(launchedGameId: number, clientId?: number): Promise<PromoteOutcome> {
  const taker = await findTakeoverMother();
  if (taker) {
    noteMotherTakeover(taker);
    if (!(await rejoinMotherNow().catch(() => false)) && clientId != null) {
      await autoJoinSameClientMother(clientId).catch(() => false);
    }
    return { kind: 'joined', taker };
  }
  return { kind: 'promoted', info: await becomeMotherOrServeOwn(launchedGameId, clientId) };
}

/**
 * `becomeMother`, for the case where this device's OWN rows are newer than the
 * snapshot it cached (it hosted the game after that snapshot was taken, e.g. a
 * substitute restarted mid-game). Adopting the cache would roll the game back,
 * so Rust refuses with `stale_snapshot`; the right move is then simply to serve
 * the rows this device already holds. That refusal used to reach the operator
 * as an error with nothing to do about it.
 */
async function becomeMotherOrServeOwn(launchedGameId: number, clientId?: number): Promise<MotherServerInfo> {
  try {
    return await becomeMother(launchedGameId, undefined, await getCompanionGameIds(launchedGameId));
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (!msg.includes('stale_snapshot') || clientId == null) throw e;
    const info = await ensureMotherServer(clientId);
    if (!info) throw e;
    lastPromotedAt = Date.now();
    return info;
  }
}

export interface TakeoverTarget {
  launched_game_id: number;
  game_name: string;
  addr: string;
  port: number;
  mother_uuid: string;
  epoch: number;
  label: string | null;
}

/** Where a serving mother answers, and who it is. */
export interface MotherEndpoint {
  addr: string;
  port: number;
  mother_uuid: string;
  label: string | null;
}

/**
 * "Regain control": this device stood down (a different device is the live
 * mother at a higher epoch), and the operator wants to host on THIS device
 * instead. We first pull the live mother's CURRENT snapshot - so we adopt the
 * up-to-date state, not this device's stale copy - then promote (epoch bumps
 * again, so satellites and the now-orphaned mother converge on us). Throws with
 * a readable message if the live mother can't be reached or has no state.
 */
export async function takeoverMother(target: TakeoverTarget): Promise<BecomeMotherInfo> {
  const ok = await invoke<boolean>('fetch_snapshot_from_mother', {
    launchedGameId: target.launched_game_id,
    addr: target.addr,
    port: target.port,
  });
  if (!ok) {
    // Thrown as an i18n KEY, not prose: this surfaces in the startup "Take back
    // control?" prompt, which the operator reads in their own language.
    // Retours Ludiom #75. See `failoverErrorText` for the render side.
    throw new Error('failover:errSnapshotFetch');
  }
  return becomeMother(target.launched_game_id);
}

/**
 * Stop hosting and follow `target` instead. Two cases end here:
 *  - a substitute sees the device set as the mother back on the network: it
 *    hands the hosting back, silently;
 *  - a serving device is superseded on the game it hosts (another device took
 *    it over at a higher epoch).
 * It stops its own server and becomes a satellite of `target` - pointing
 * launched_games at it (our self secret authenticates when it adopted our row;
 * otherwise the route tick re-pairs) and tracking it as a paired mother so the
 * top bar reflects it. Then it reconciles: everything this device hosted that
 * the mother lacks or holds in an older state is pushed to it, ended games
 * included, and the mother's later states come back.
 */
export async function yieldToMother(target: MotherEndpoint): Promise<void> {
  await invoke('mother_stop_local_server').catch(() => {});

  // Forget that we were hosting, the way demoteFromMother does. Our server is
  // stopped, so a remembered local route is a route to a dead port - and
  // childControlLink's `restoreLocalLaunchedGames()` would happily reinstall it
  // every 15s, dragging the games list back onto our own stale rows. That was
  // half of "the game still showed as running on the old mother" (Ludiom #76).
  // NOT touched: "Rôle de ce poste". Standing down for a game is not the
  // operator changing this device's role.
  bootPromise = null;
  localInfo = null;
  setLocalLaunchedGamesRoute(null);
  // We no longer stand in for anyone.
  await invoke('client_clear_substitute_state').catch(() => {});

  const secret = await invoke<string | null>('get_self_peer_secret').catch(() => null);
  if (secret) {
    pointLaunchedGamesAtMother(`http://${target.addr}:${target.port}`, secret);
    await invoke('client_save_paired_mother', {
      motherUuid: target.mother_uuid,
      motherLabel: target.label,
      peerSecret: secret,
    }).catch(() => {});
    await invoke('client_refresh_mother_endpoints', { timeoutMs: 2500 }).catch(() => {});
    await invoke('client_prune_paired_mothers', { keepUuid: target.mother_uuid, staleMinutes: 10 }).catch(() => {});
  }

  // Best-effort: the reconcile tick retries, and re-pairs first if the mother
  // did not honour our secret.
  const report = await reconcileWithMotherNow();
  console.log('[yieldToMother] reconciled with the mother →', report);
}

/** Outcome of the Rust `apply_mother_snapshot` mirror - see its doc comment. */
export interface ApplyOutcome {
  applied: boolean;
  reason:
    | 'applied'
    | 'no_cached_snapshot'
    | 'no_local_row'
    | 'stale_snapshot'
    | 'serving_locally'
    | 'corrupt_snapshot';
  ended: boolean;
  mother_epoch: number;
  state_version: number;
}

/**
 * Mirror this device's cached snapshot of `launchedGameId` onto its own local
 * rows without taking ownership: the fix for a superseded mother that keeps
 * showing a game someone else already finished (Ludiom #76). Refusals come back
 * as an outcome, not a throw - the callers run on timers.
 */
export async function applyMotherSnapshot(launchedGameId: number): Promise<ApplyOutcome> {
  return invoke<ApplyOutcome>('apply_mother_snapshot', { launchedGameId });
}

/**
 * 'empty': this device now hosts, but holds no unfinished game - nothing of the
 * old mother's could be recovered here. Reported so the operator is not told
 * "done" in front of an empty games list (Coralie, 2026-10-27).
 */
export type ForceMotherOutcome = 'takeover' | 'adopted' | 'restarted' | 'empty';

/**
 * Operator-forced "host the games on THIS device", from the Network page. On a
 * device that is not set as the mother this is how it becomes a substitute.
 * Handles every situation, in order of preference:
 *  1. A live, higher-epoch mother is on the LAN → pull its CURRENT state and
 *     promote (no data loss) - same as the startup prompt.
 *  2. No live competitor, but this device cached a snapshot → adopt that.
 *  3. Neither → (re)start this device's own local server, serving its own rows.
 *     Refused when the device holds no running game - unless `allowIdle`: the
 *     "Héberger les parties en remplacement" button, pressed when no mother is
 *     on the network, must work on a PC with nothing in progress too (it is
 *     how the venue gets a host to launch from).
 * Throws with a readable message if none apply.
 */
export async function forceBecomeMother(
  clientId: number,
  opts?: { allowIdle?: boolean }
): Promise<ForceMotherOutcome> {
  console.log('[forceBecomeMother] start clientId=', clientId);
  // 1. Live higher-epoch mother present.
  const target = await invoke<TakeoverTarget | null>('get_takeover_target', { clientId }).catch(
    (e) => {
      console.warn('[forceBecomeMother] get_takeover_target failed:', e);
      return null;
    }
  );
  console.log('[forceBecomeMother] takeover target=', target);
  if (target) {
    await takeoverMother(target);
    return 'takeover';
  }
  // 2. Competitor gone, but we hold a cached snapshot.
  // `mother_snapshots` is never pruned: without a game on screen, only adopt a
  // cached one that is plausibly the game of the day.
  const candidate = await getPromotableGameId();
  const gid = candidate != null && (!opts?.allowIdle || (await isReclaimableGame(candidate))) ? candidate : null;
  console.log('[forceBecomeMother] promotable game id=', gid);
  if (gid != null) {
    try {
      await becomeMother(gid, undefined, await getCompanionGameIds(gid));
      return 'adopted';
    } catch (e) {
      // Only fall through when there's simply nothing cached for it; a content
      // guard / real failure should surface to the operator.
      const msg = String((e as { message?: string })?.message ?? e);
      console.warn('[forceBecomeMother] becomeMother(', gid, ') failed:', msg);
      // A genuine failure keeps its raw message - it is the diagnostic. Only
      // "nothing cached here" and "our own rows are newer than the cache" (the
      // device that is ALREADY the promoted mother) fall through to step 3.
      if (!msg.includes('No cached snapshot') && !msg.includes('stale_snapshot')) throw e;
    }
  }
  // 3. Restart our own local server - ONLY if our game actually lives here
  //    (the original mother). Otherwise there's nothing to take control of:
  //    don't start an empty server and falsely report success.
  const hasLocalGame = opts?.allowIdle || (await deviceHasLocalActiveGame());
  console.log('[forceBecomeMother] hasLocalActiveGame=', hasLocalGame);
  if (!hasLocalGame) {
    throw new Error('failover:errNotInGame');
  }
  console.log('[forceBecomeMother] falling back to ensureMotherServer');
  const info = await ensureMotherServer(clientId);
  console.log('[forceBecomeMother] ensureMotherServer →', info ? `port ${info.port}` : 'null');
  if (!info) {
    throw new Error('failover:errTakeControl');
  }
  return (await countUnfinishedLocalGames()) > 0 ? 'restarted' : 'empty';
}

/** Unfinished games in this device's own DB - what its games list shows as running. */
async function countUnfinishedLocalGames(): Promise<number> {
  try {
    const { getDb } = await import('./db');
    const rows = await (await getDb()).select<Array<{ n: number }>>(
      'SELECT COUNT(*) AS n FROM lg_launched_games WHERE ended = 0'
    );
    return rows[0]?.n ?? 0;
  } catch {
    // Unknown: don't claim the takeover came back empty.
    return 1;
  }
}

/**
 * Stop hosting on THIS device right now, for "Rôle de ce poste → Satellite"
 * and for a mother superseded by a later-designated one. The caller changes
 * the configured role (`setConfiguredMother(false)`); this only takes the
 * server down safely.
 *  - Stop the local axum server: unregisters mDNS, so satellites stop
 *    resolving this device as a mother.
 *  - Reset the module boot state and routing to a pure satellite's boot shape:
 *    no LAN override (the fail-closed gate re-arms) and no local route, so
 *    nothing keeps pointing at the now-dead 127.0.0.1 server.
 * Existing paired_devices rows are kept - if this device ever hosts again its
 * former children re-pair silently via the same-client auto-approve.
 * Best-effort by design; the caller should kick `refreshLaunchedGamesRoute()`
 * afterwards so the device converges on the venue's live mother (auto-join)
 * without waiting for the periodic tick.
 */
/** Refusal of demoteFromMother: this device hosts `gameName` and nobody else serves it. */
export class HostingActiveGameError extends Error {
  constructor(public gameName: string) {
    super('failover:errHostingActiveGame');
  }
}

export async function demoteFromMother(clientId?: number): Promise<void> {
  // Retours sept. #17: stepping down while hosting a running game used to be
  // accepted silently - and undone at the next boot, since the device still held
  // the game. Refuse with the reason instead, unless another mother already
  // serves that game (then hand over to it, like a superseded mother does).
  const hosted = await getLocallyHostedActiveGame();
  let handover: TakeoverTarget | null = null;
  if (hosted) {
    const cid = clientId ?? (await getAuthUser().catch(() => null))?.client_id ?? null;
    handover = cid == null
      ? null
      : await invoke<TakeoverTarget | null>('get_takeover_target', { clientId: cid }).catch(() => null);
    if (!handover || handover.launched_game_id !== hosted.id) {
      throw new HostingActiveGameError(hosted.name);
    }
  }
  await invoke('mother_stop_local_server').catch(() => {});
  bootPromise = null;
  localInfo = null;
  setLocalLaunchedGamesRoute(null);
  setLanOverride(null);
  if (handover) await yieldToMother(handover).catch(() => {});
}

/** Order discovered mothers: the device set as the mother first, then by epoch. */
export function byRoleThenEpoch(
  a: { role: string | null; epoch: number | null },
  b: { role: string | null; epoch: number | null }
): number {
  const rank = (m: { role: string | null }) => (m.role === 'm' ? 1 : 0);
  return rank(b) - rank(a) || (b.epoch ?? 0) - (a.epoch ?? 0);
}

/**
 * A device that is not hosting joins the mother that is. Browses mDNS for a
 * same-client mother - the device set as the mother when there is one, else
 * the highest epoch - and pairs with it. The mother auto-approves us on the LAN
 * (same client_id), so this is silent. Once paired, the periodic
 * `refreshLaunchedGamesRoute` tick points our launched_games traffic at it.
 * Returns true if we joined (or were already paired). Best-effort: a venue with
 * no mother yet returns false and we stay idle.
 */
let autoJoinInFlight: Promise<boolean> | null = null;

export async function autoJoinSameClientMother(clientId: number): Promise<boolean> {
  // Coalesce: the boot one-shot and the childControlLink tick can both call this
  // within the same window - run a single browse + pair at a time.
  if (autoJoinInFlight) return autoJoinInFlight;
  autoJoinInFlight = (async () => {
    const mothers = await discoverOtherMothers().catch(() => []);
    const candidate = mothers
      .filter((m) => m.addresses.length > 0 && m.port > 0)
      // Never a mother on another LAN protocol (an outdated build): pairing
      // would be refused anyway.
      .filter(speaksOurLanProto)
      // Same client when advertised; tolerate older mothers that don't advertise it.
      .filter((m) => m.client_id == null || m.client_id === clientId)
      .sort(byRoleThenEpoch)[0];
    if (!candidate) return false;
    try {
      const outcome = await joinMother(candidate, { timeoutMs: 8000 }).result;
      return outcome.kind === 'approved' || outcome.kind === 'already_paired';
    } catch {
      return false;
    }
  })();
  try {
    return await autoJoinInFlight;
  } finally {
    autoJoinInFlight = null;
  }
}

// Only adopt a cached game if it is plausibly THE game of the day: the one on
// screen, still unfinished in our own rows, or seen running within the last
// half hour. `mother_snapshots` is never pruned, and hosting from an idle
// screen must not resurrect last week's unfinished session.
// `updated_at` is refreshed by every ping that finds the copy current (Rust
// `touch_cached_snapshot`); it used to move only when the game changed, so a
// quiet game was refused here and the substitute came up empty.
// The local row is matched by game (`summary_uuid`): ids are per device.
async function isReclaimableGame(gameId: number): Promise<boolean> {
  if (getActiveLaunchedGameId() === gameId) return true;
  try {
    const { getDb } = await import('./db');
    const rows = await (await getDb()).select<Array<{ n: number }>>(
      `SELECT
         (SELECT COUNT(*) FROM mother_snapshots s
            JOIN lg_launched_games g
              ON g.summary_uuid = json_extract(s.snapshot_json, '$.game.summary_uuid')
           WHERE s.launched_game_id = $1 AND g.ended = 0)
       + (SELECT COUNT(*) FROM mother_snapshots
            WHERE launched_game_id = $1 AND updated_at >= datetime('now', '-30 minutes')) AS n`,
      [gameId]
    );
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

// A game is HOSTED here when this device is its mother, not merely holding a
// copy: either no other mother's snapshot of it was ever cached (we launched
// it), or our rows are at a higher epoch than the cached snapshot (we were
// promoted). A copy mirrored from another mother (apply_mother_snapshot) sits
// at the snapshot's epoch and does NOT count. Counting every `ended = 0` row
// made a device that said "I'm not a mother" start hosting again at the next
// boot because of a mirrored copy (retours sept. #17).
// The snapshot must be of the same game, not just the same id (ids are per
// device): a cached copy of another game at that id hid ours.
const HOSTED_ACTIVE_GAMES_SQL = `
  SELECT g.id AS id, g.name AS name
    FROM lg_launched_games g
    LEFT JOIN mother_snapshots s
      ON s.launched_game_id = g.id
     AND json_extract(s.snapshot_json, '$.game.summary_uuid') = g.summary_uuid
   WHERE g.ended = 0
     AND (s.launched_game_id IS NULL OR g.mother_epoch > s.mother_epoch)
   ORDER BY g.mother_epoch DESC, g.id DESC`;

export async function getLocallyHostedActiveGame(): Promise<{ id: number; name: string } | null> {
  try {
    const { getDb } = await import('./db');
    const rows = await (await getDb()).select<Array<{ id: number; name: string }>>(HOSTED_ACTIVE_GAMES_SQL);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function deviceHasLocalActiveGame(): Promise<boolean> {
  return (await getLocallyHostedActiveGame()) != null;
}

/**
 * Pickup-only companion to ensureMotherServer for contexts that must NEVER
 * start a server - the audience projector window. It installs the local
 * override for a mother server that is ALREADY running in this process
 * (mother_get_server_info is process-global Tauri state, shared across
 * windows) and returns null otherwise, without touching the boot promise.
 * The projector previously called ensureMotherServer unconditionally, which
 * could turn a pure satellite into a competing epoch-1 mother whenever the
 * boot fence's mDNS browse errored (fence is skipped on browse error).
 */
export async function attachToRunningMotherServer(): Promise<MotherServerInfo | null> {
  try {
    const existing = await invoke<MotherServerInfo | null>('mother_get_server_info');
    if (!existing) return null;
    localInfo = existing;
    publishLocalRoute(existing);
    const current = getLanOverride();
    if (!current || current.baseUrl.includes(`:${existing.port}`) === false) {
      setLanOverride({
        baseUrl: `http://127.0.0.1:${existing.port}`,
        token: existing.mother_peer_secret,
        endpoints: LAUNCHED_GAMES_ENDPOINTS,
      });
    }
    return existing;
  } catch {
    return null;
  }
}

export async function ensureMotherServer(
  clientId: number,
  mdnsLabel?: string
): Promise<MotherServerInfo | null> {
  // Coalesce concurrent callers onto one in-flight boot - React Strict-Mode
  // double-mounts and the AuthProvider's auth-resolution effect can both
  // hit this within a few ms of each other.
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      // Server may already be running (e.g. smoke test left it up, or this
      // is a React re-mount). Pick it up rather than restarting.
      const existing = await invoke<MotherServerInfo | null>('mother_get_server_info');
      // The role the server starts in decides the boot fence: the device set
      // as the mother starts even while a substitute serves; a substitute
      // stands down for anyone already serving.
      const claim = await getHostingClaim();
      const info = existing
        ?? (await invoke<MotherServerInfo>('mother_start_local_server', {
          clientId,
          port: 0, // 0 = OS picks; the command returns the actual port
          mdnsLabel: mdnsLabel ?? (await defaultMotherLabel()) ?? null,
          configured: claim.configured,
          designatedAt: claim.designatedAt,
        }));

      // Install the LAN override unless someone else (the smoke test) set one
      // we shouldn't stomp. The smoke test always restores `null` in its
      // finally block, so a non-null override here is almost certainly ours.
      localInfo = info;
      publishLocalRoute(info);
      const current = getLanOverride();
      if (!current || current.baseUrl.includes(`:${info.port}`) === false) {
        setLanOverride({
          baseUrl: `http://127.0.0.1:${info.port}`,
          token: info.mother_peer_secret,
          // Only launched_games is routed locally. Scenarios, patterns,
          // auth, etc. still go to studio.
          endpoints: LAUNCHED_GAMES_ENDPOINTS,
        });
      }
      // First time this device runs the mother server, open the firewall so
      // satellites can reach it (one-time UAC). Fire-and-forget; only escalates
      // if `existing` was null (we actually started a server) is not required -
      // the helper self-gates on a persisted flag, so a re-mount pickup no-ops.
      void ensureFirewallRuleOnce();
      // Serving: a "lost the mother" banner raised while this device was still
      // a satellite has nothing left to say.
      notifyPromotedToMother();
      return info;
    } catch (err) {
      // Slice 6: a deliberate stand-down (another device is the current mother
      // at a higher epoch) comes back as the `mother_superseded` sentinel - log
      // it calmly, not as a failure. Returning null makes App.tsx join the live
      // mother instead, so we don't recreate the split-brain the fence prevented.
      const msg = String((err as { message?: string })?.message ?? err);
      if (msg.includes('mother_superseded')) {
        console.warn('[lanMotherBoot] standing down - another device is the current mother (higher epoch).');
      } else {
        console.error('[lanMotherBoot] failed to start/locate mother server:', err);
      }
      bootPromise = null; // allow retry on next caller
      return null;
    }
  })();

  return bootPromise;
}
