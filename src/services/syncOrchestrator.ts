// Content sync orchestrator. Single module-level singleton.
//
// Responsibilities (per slice 2 plan):
//   - Trigger cycles: startup, foreground (>=5min), network-up, 30-min timer,
//     manual. All debounced - at most one cycle in flight; subsequent triggers
//     within 60s of the last cycle start are dropped. With start(..., {askFirst})
//     (every launch but the first) the startup trigger only checks and the
//     operator is asked before anything downloads - see LaunchGate.
//   - On each cycle:
//       1. Fetch get_user_data_update manifest.
//       2. Apply manifest in one SQLite transaction: upsert all rows, tombstone
//          missing items (rows + on-disk media for scenarios).
//       3. Build a priority-sorted work list from each store's
//          listPendingDownloads().
//       4. Run a 3-slot download pool with per-asset retries
//          (3 attempts, ~1s/4s/16s with jitter). 401/403 aborts the cycle and
//          emits cycle:failed reason=auth_invalid. 4xx (non-auth) skips the
//          asset permanently for this cycle.
//   - Emit syncEvents at boundaries so the UI (FirstLaunchProgress, pill,
//     failure banner) can react.
//
// Q9 escape hatch: if mobile profiling shows JS-heap pressure on big media
// downloads, lift this whole orchestrator into Rust.

import { ApiError, RangeIgnoredError, apiCall, apiDownloadBytesStream } from './api';
import { withRetry } from './apiRetry';
import { AuthUser } from './authStore';
import {
  ensureDir,
  onDemandCardsFileRel,
  teamNamesFileRel,
  writeJson,
  writeBinary,
  streamBinary,
  streamBinaryAppend,
  fileSize,
  writeText,
  blobExists,
  blobPathRel,
  blobTmpPathRel,
  commitBlobFromTemp,
  removeRecursive,
} from './contentFs';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import * as scenarioStore from './scenarioStore';
import * as patternStore from './patternStore';
import * as cardsStore from './cardsStore';
import * as namePoolsStore from './namePoolsStore';
import * as recoveryCodesStore from './recoveryCodesStore';
import * as customersStore from './customersStore';
import * as reportLayoutsStore from './reportLayoutsStore';
import { setSyncedDefaultPrintPrefs } from './printPrefsStore';
import * as translationsStore from './translationsStore';
import { hydrateIngameFromStore } from '../i18n/ingame';
import * as gameTypesStore from './gameTypesStore';
import * as lanNetworks from './lanNetworks';
import { isGameActive } from './activeSession';
import * as clientPreferencesStore from './clientPreferencesStore';
import {
  gameTypeAdminVersionDirRel,
  gameTypeClientVersionDirRel,
} from './contentFs';
import { startConnectivityMonitor, onConnectivityChange, isOnline, studioReachableFresh } from './connectivity';
import {
  syncItemKey,
  recordFailure,
  recordSuccess,
  reconcileObsolete,
  recordScenarioComplete,
} from './syncFailures';
import { captureError } from './telemetry';
import { loadConfig } from '../utils/config';
import { emit } from './syncEvents';
import type { CyclePhase, CycleFailureDetail, CycleProgressPayload, UpdatesAvailablePayload } from './syncEvents';
import { getDb } from './db';
import * as contentSyncState from './contentSyncState';
import {
  cloudSource,
  type ContentSource,
  type PeerContentSource,
  type PeerInventory,
  type ScenarioMetaResponse,
  type PatternDownloadResponse,
} from './contentSource';

// ---------- tunables ----------

const DEBOUNCE_MS = 60_000;
const TIMER_MS = 30 * 60 * 1000;
// After a cycle that left items behind (failed downloads, idle-cap abort), a
// follow-up cycle is scheduled on this backoff instead of waiting for the next
// 30-min tick or for the operator to press "Tout réessayer". With resumable
// media each follow-up continues where the last one stopped. Reset by a
// complete cycle. Retours sept. 2026 #27.
const RETRY_BACKOFF_MS = [2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const FOREGROUND_THRESHOLD_MS = 5 * 60 * 1000;
// 5 parallel downloads: first sync of a full catalogue (30+ scenarios, heavy
// videos) was taking 5-6 h at 3. Retours sept. 2026 #26.
const POOL_SIZE = 5;
// Defense-in-depth cap on a single cycle. Per-request timeouts in api.ts should
// already bound every call; this is the backstop guaranteeing runCycle() always
// terminates even if a future path forgets a timeout.
//
// It is deliberately an IDLE cap, not a wall-clock one. A flat wall-clock cap
// (it used to be 10 minutes) killed cycles that were downloading perfectly
// well: a scenario carrying a few 100-200 MB videos, split across the worker
// pool, simply needs longer than that. Back then there was no resume, so the
// next cycle restarted those videos from byte 0 and was cut off at the same
// point - a livelock in which heavy videos could never land. Scenario media now
// resume from their `.part` (Range request, see downloadScenarioMedia), but the
// idle cap stays the right shape. Mirrors DOWNLOAD_STALL_TIMEOUT_MS in api.ts:
// what matters is that progress is being made, not how long the job takes.
const CYCLE_IDLE_CAP_MS = 5 * 60 * 1000; // no progress of any kind
const CYCLE_ABSOLUTE_CAP_MS = 4 * 60 * 60 * 1000; // runaway guard only
const CYCLE_CAP_CHECK_MS = 15 * 1000;

// Video extensions get partial-readiness treatment in the post-pool sweep: a
// scenario whose ONLY missing files are videos is still committed as usable.
// NOTE: .ogg is deliberately absent. The studio accepts it as a video container,
// but in practice scenario sounds use it far more often, and treating a missing
// SOUND as "just a video" would commit a scenario that is silently broken. A
// genuine .ogg video simply doesn't get partial treatment - the safe way round.
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogv', '.mov', '.m4v'];

function isVideoFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ---------- types ----------

export type Trigger = 'startup' | 'foreground' | 'network_up' | 'timer' | 'retry' | 'manual';

interface ManifestResponse {
  custom_scenarios: Array<{ uniqid: string; title: string; version: number; game_type: string; content_hash?: string | null }>;
  product_scenarios: Array<{ uniqid: string; title: string; version: number; game_type: string; content_hash?: string | null }>;
  default_patterns: Array<{ pattern_uniqid: string; name: string; version: number; game_type: string }>;
  custom_patterns: Array<{ pattern_uniqid: string; name: string; version: number; game_type: string }>;
  cards_version: number | null;
  has_on_demand_cards: boolean;
  team_names_version?: number;
  recovery_codes_version?: number;
  report_layouts_version?: number;
  /** Licensee customers; absent from a studio that predates them. */
  customers_version?: number;
  translations?: Array<{ key: string; value: unknown; version: number }>;
  game_types?: gameTypesStore.GameTypeManifestRow[];
  client_game_type_overrides?: gameTypesStore.GameTypeOverrideManifestRow[];
  client_preferences?: clientPreferencesStore.ClientPreferences;
  /** Studio snapshot time (ms); orders manifests passed between LAN peers. */
  server_time?: number;
}

export type WorkItem =
  | { kind: 'cards'; priority: 1; clientId: number; remoteVersion: number; label: string }
  | { kind: 'on_demand'; priority: 1; clientId: number; label: string }
  | { kind: 'team_names'; priority: 1; clientId: number; remoteVersion: number; label: string }
  | { kind: 'recovery_codes'; priority: 1; clientId: number; remoteVersion: number; label: string }
  | { kind: 'customers'; priority: 1; clientId: number; remoteVersion: number; label: string }
  | { kind: 'report_layouts'; priority: 1; remoteVersion: number; label: string }
  | { kind: 'pattern'; priority: 2; uniqid: string; remoteVersion: number; label: string }
  | { kind: 'scenario_meta'; priority: 4; uniqid: string; remoteVersion: number; remoteContentHash: string; label: string }
  | { kind: 'scenario_media'; priority: 5; uniqid: string; filename: string; hash: string; label: string }
  | { kind: 'game_type_admin_video'; priority: 6; code: string; remoteVersion: number; filename: string; subtitleFilenames: Record<string, string>; subtitlesVersion: number; label: string }
  | { kind: 'game_type_override_video'; priority: 6; code: string; remoteVersion: number; filename: string; subtitleFilenames: Record<string, string>; subtitlesVersion: number; label: string }
  // Subtitle tracks alone, for a video that is already current on disk:
  // `videoVersion` names the version dir they live in (both here and in studio).
  | { kind: 'game_type_admin_subtitles'; priority: 6; code: string; videoVersion: number; subtitleFilenames: Record<string, string>; subtitlesVersion: number; label: string }
  | { kind: 'game_type_override_subtitles'; priority: 6; code: string; videoVersion: number; subtitleFilenames: Record<string, string>; subtitlesVersion: number; label: string };

// ---------- module state ----------

let started = false;
let currentUser: AuthUser | null = null;
let cycleInFlight = false;
let lastCycleStartedAtMs: number | null = null;
let lastCycleFinishedAtIso: string | null = null;
let lastCycleStats: { total: number; completed: number; failed: number } | null = null;
let cycleAbort: AbortController | null = null;
let disposers: Array<() => void> = [];
let timerHandle: ReturnType<typeof setInterval> | null = null;
let retryHandle: ReturnType<typeof setTimeout> | null = null;
let retryStep = 0;
let lastVisibleAtMs = Date.now();

// Launch gate. With `askFirst`, no download starts on its own at launch: the
// first trigger only CHECKS (manifest fetch, no downloads, no prunes) and, when
// something is pending, asks the operator through 'updates:available'.
//   pending_check   - check not done yet (offline at launch, or it failed); the
//                     next automatic trigger runs the check instead of a cycle.
//   awaiting_answer - the prompt is up; automatic triggers are held.
//   declined        - "Plus tard": automatic cycles stay off for this session.
//   open            - normal behaviour (nothing was pending, or accepted).
// A manual sync (Settings → Synchroniser maintenant) always runs and opens the
// gate.
type LaunchGate = 'pending_check' | 'awaiting_answer' | 'declined' | 'open';
let launchGate: LaunchGate = 'open';
let checkInFlight = false;
let checkAbort: AbortController | null = null;
let pendingUpdates: PendingUpdatesSummary | null = null;

// Wall-clock of the last observable forward step in the running cycle: a phase
// transition, an item starting or finishing, or a single streamed chunk landing.
// The idle cap (CYCLE_IDLE_CAP_MS) is measured from here, so a large file
// downloading slow-but-steady keeps the cycle alive indefinitely while a truly
// wedged one still gets aborted.
let lastCycleProgressAtMs = 0;

function bumpCycleProgress(): void {
  lastCycleProgressAtMs = Date.now();
}

// Per-cycle scratch - used by the catch block to attach diagnostic context to
// cycle:failed events. Reset at the top of every cycle. Mirrors what the UI
// would otherwise have to track itself by listening to events.
let currentTrigger: Trigger | null = null;
let currentPhase: CyclePhase | null = null;
let lastCurrentLabel: string | null = null;

// Operator-only device (AppConfig.operatorOnlyDevice): read once at the top of
// every cycle. When true, the cycle downloads only each scenario's game-data +
// its single visual image and skips all game-type tutorial videos - this device
// manages games but never plays them. See project_operator_only_device.
let operatorOnly = false;

// Per-scenario bookkeeping inside a cycle. `manifest` is the full target file
// set (rel_path -> hash, incl. game-data.json) to commit once `remaining`
// (the media files still being fetched) drains with no failures. Cleared
// between cycles.
interface ScenarioProgress {
  remaining: Set<string>;
  failed: Set<string>;
  manifest: scenarioStore.ManifestFile[];
  remoteContentHash: string;
  remoteVersion: number;
  // false: a LAN peer's copy that is not known to match the cloud manifest.
  // Committed as launchable only (local_content_hash untouched), so the next
  // cloud cycle still reconciles it.
  commitFull: boolean;
}
const scenarioProgress = new Map<string, ScenarioProgress>();

// In-flight scenario-media downloads by blob hash. The temp path is stable per
// hash (`{hash}.part`, so an interrupted download can be RESUMED next time), so
// two workers fetching the same blob (a file shared by two scenarios) must not
// both append to it: the second one joins the first one's promise instead.
const inflightBlobs = new Map<string, Promise<number>>();

// A cycle's completion, so a LAN peer fetch can abort a running cycle and wait
// for it to unwind before reusing the (module-level) scenarioProgress map.
let cycleDone: Promise<void> | null = null;
// A peer fetch (fetchScenarioFromSource) is running: no cycle may start, and
// progress goes to `peerProgress` instead of the cloud sync UI's cycle:* events.
let peerFetchInFlight = false;
// The running cycle was aborted on purpose to let a peer fetch through: it
// ends quietly (no failure banner, no telemetry) and is re-triggered after.
let cycleYieldedToPeer = false;
export interface PeerFetchProgress {
  label: string;
  loaded: number;
  total: number | null;
  done: boolean;
}
let peerProgress: ((p: PeerFetchProgress) => void) | null = null;
// First error a peer fetch's pool swallowed (the pool never throws per item),
// so the caller can tell "the mother doesn't have it" from a network failure.
let peerFirstError: unknown = null;
// Peer fetches run one at a time (they share scenarioProgress): a second one
// waits for the first to finish - e.g. React re-running an effect whose first
// run was just aborted.
let peerFetchTail: Promise<void> = Promise.resolve();
// The LAN mother whose content the pending-updates prompt is about (offline
// launch): accepting syncs from it instead of the unreachable studio.
let pendingPeerSource: PeerContentSource | null = null;
// The running background peer sync, so joining a game (fetchScenarioFromSource)
// can cut it short instead of queueing behind its videos.
let peerSyncAbort: AbortController | null = null;

// ---------- public API ----------

export interface OrchestratorState {
  cycleInFlight: boolean;
  lastCycleStartedAtMs: number | null;
  lastCycleFinishedAtIso: string | null;
  lastCycleStats: { total: number; completed: number; failed: number } | null;
  online: boolean;
}

export function getState(): OrchestratorState {
  return {
    cycleInFlight,
    lastCycleStartedAtMs,
    lastCycleFinishedAtIso,
    lastCycleStats,
    online: isOnline(),
  };
}

// What the launch check found, shown in the "synchronise now?" prompt.
// `on_demand` items are left out: they are re-fetched by every cycle, so they
// would make the prompt appear on every launch.
export type PendingUpdatesSummary = UpdatesAvailablePayload;

export function getPendingUpdates(): PendingUpdatesSummary | null {
  return launchGate === 'awaiting_answer' ? pendingUpdates : null;
}

// The operator's answer to the launch prompt. Accept runs the cycle now (as a
// manual sync: it is user-initiated) and resumes automatic cycles; decline
// keeps them off until the next launch or a manual sync.
export function answerPendingUpdates(accept: boolean): void {
  if (launchGate !== 'awaiting_answer') return;
  pendingUpdates = null;
  emit('updates:resolved', { accepted: accept });
  const peer = pendingPeerSource;
  pendingPeerSource = null;
  if (accept) {
    launchGate = 'open';
    if (peer) {
      // Back online meanwhile (runPeerSync then defers to the studio): sync
      // from there instead.
      void runPeerSync(peer).then((did) => {
        if (!did) void runCycleNow('manual');
      });
    } else {
      void runCycleNow('manual');
    }
  } else {
    launchGate = 'declined';
  }
}

// `askFirst`: check at launch and ask before downloading (see LaunchGate).
// Off on a first launch - with nothing on disk there is nothing to choose.
export async function start(authUser: AuthUser, opts: { askFirst?: boolean } = {}): Promise<void> {
  if (started) {
    currentUser = authUser;
    return;
  }
  started = true;
  currentUser = authUser;
  launchGate = opts.askFirst ? 'pending_check' : 'open';
  startConnectivityMonitor();

  // Visibility: track foregrounded duration; trigger after >= threshold offscreen.
  const onVisChange = () => {
    if (document.visibilityState === 'hidden') {
      lastVisibleAtMs = Date.now();
    } else {
      const offMs = Date.now() - lastVisibleAtMs;
      if (offMs >= FOREGROUND_THRESHOLD_MS) {
        void fireTrigger('foreground');
      }
      lastVisibleAtMs = Date.now();
    }
  };
  document.addEventListener('visibilitychange', onVisChange);
  disposers.push(() => document.removeEventListener('visibilitychange', onVisChange));

  // Network up.
  const offConn = onConnectivityChange((online) => {
    if (online) void fireTrigger('network_up');
  });
  disposers.push(offConn);

  // 30-min foreground timer.
  timerHandle = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void fireTrigger('timer');
    }
  }, TIMER_MS);
  disposers.push(() => {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  });

  // Initial cycle (or, with askFirst, the launch check).
  void fireTrigger('startup');
}

export function stop(): void {
  if (!started) return;
  started = false;
  if (launchGate === 'awaiting_answer') {
    emit('updates:resolved', { accepted: false });
  }
  launchGate = 'open';
  pendingUpdates = null;
  pendingPeerSource = null;
  if (checkAbort) {
    checkAbort.abort();
    checkAbort = null;
  }
  for (const d of disposers) {
    try {
      d();
    } catch { /* swallow */ }
  }
  disposers = [];
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  clearRetry();
  retryStep = 0;
  if (cycleAbort) {
    cycleAbort.abort();
    cycleAbort = null;
  }
  cycleInFlight = false;
  currentUser = null;
}

export async function runCycleNow(trigger: Trigger = 'manual'): Promise<void> {
  if (trigger === 'manual' && launchGate !== 'open') {
    // A manual sync answers the launch question too: close the prompt.
    if (launchGate === 'awaiting_answer') {
      pendingUpdates = null;
      emit('updates:resolved', { accepted: true });
    }
    launchGate = 'open';
  }
  await fireTrigger(trigger, { force: trigger === 'manual' });
}

// After a local card edit: get it to the studio soon. With the launch gate
// open this is a normal manual cycle; while the operator has not agreed to the
// launch sync (or said "Plus tard"), it pushes the card changes and pulls the
// card list only, so a card edit never starts the scenario/video downloads.
export async function syncCardsNow(): Promise<void> {
  if (launchGate === 'open') {
    await runCycleNow('manual');
    return;
  }
  if (!started || !currentUser || cycleInFlight || checkInFlight) return;
  const clientId = currentUser.client_id;
  await cardsStore.pushPendingMutations();
  await withRetry(() => cardsStore.pullCardsFromServer(clientId));
  emit('content:updated', { kind: 'cards', ids: [clientId] });
}

// ---------- LAN peer fetch ----------

export type PeerFetchOutcome =
  // Every file is here.
  | { status: 'full' }
  // Launchable, but some videos are missing (not on the mother, or failed).
  | { status: 'launchable' }
  // Not launchable; `error` is what went wrong (ApiError from the mother...).
  | { status: 'missing'; error: unknown };

/**
 * Fetch one scenario - plus the pattern a Tracks game needs - from a LAN
 * source: the launch path when a satellite joins a game whose scenario it never
 * synced, in a venue with no internet. Runs the same download -> verify ->
 * commit path as a cycle. A running cloud cycle is aborted first (cheap: blob
 * downloads resume from their .part) and re-triggered afterwards.
 */
export async function fetchScenarioFromSource(
  uniqid: string,
  source: ContentSource,
  opts: { patternUniqid?: string | null; signal?: AbortSignal; onProgress?: (p: PeerFetchProgress) => void } = {}
): Promise<PeerFetchOutcome> {
  // Joining a game comes first: cut a background peer sync short (its blob
  // downloads resume from their .part next time).
  peerSyncAbort?.abort();
  const previous = peerFetchTail;
  let release: () => void = () => {};
  peerFetchTail = new Promise<void>((r) => {
    release = r;
  });
  await previous;
  if (opts.signal?.aborted) {
    release();
    return { status: 'missing', error: new DOMException('aborted', 'AbortError') };
  }
  peerFetchInFlight = true;
  let abortedCycle = false;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  try {
    if (cycleInFlight) {
      abortedCycle = true;
      cycleYieldedToPeer = true;
      cycleAbort?.abort();
      await cycleDone;
      cycleYieldedToPeer = false;
    }
    peerProgress = opts.onProgress ?? null;
    peerFirstError = null;
    operatorOnly = await readOperatorOnly();
    scenarioProgress.clear();

    const items: WorkItem[] = [];
    if (opts.patternUniqid) {
      const p = await patternStore.get(opts.patternUniqid);
      if (!p || p.local_version == null) {
        items.push({
          kind: 'pattern',
          priority: 2,
          uniqid: opts.patternUniqid,
          remoteVersion: p?.remote_version ?? 0,
          label: `Pattern: ${opts.patternUniqid}`,
        });
      }
    }
    // remoteVersion/remoteContentHash are placeholders: a peer's reply carries
    // the version and hash its copy is committed at.
    items.push({
      kind: 'scenario_meta',
      priority: 4,
      uniqid,
      remoteVersion: 0,
      remoteContentHash: '',
      label: `Scenario: ${uniqid}`,
    });
    await runDownloadPool(items, ctrl.signal, source, 2);
    if (ctrl.signal.aborted) return { status: 'missing', error: new DOMException('aborted', 'AbortError') };

    const row = await scenarioStore.get(uniqid);
    if (!row || row.local_version == null || !(await scenarioStore.getGameData(uniqid))) {
      return { status: 'missing', error: peerFirstError ?? new Error('scenario not committed') };
    }
    const progress = scenarioProgress.get(uniqid);
    const whole = progress && progress.remaining.size === 0 && progress.failed.size === 0;
    return whole ? { status: 'full' } : { status: 'launchable' };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    scenarioProgress.clear();
    peerProgress = null;
    peerFirstError = null;
    peerFetchInFlight = false;
    release();
    // Give back the cycle we interrupted (fireTrigger still skips it offline).
    if (abortedCycle) void fireTrigger('retry', { force: true });
  }
}

// Can the mother serve this work item? Only what it holds at exactly the
// version our manifest wants (rule: peer.local == our remote): anything else
// waits for the cloud, or for the mother to catch up.
function peerCanServe(item: WorkItem, inv: PeerInventory): boolean {
  switch (item.kind) {
    case 'scenario_meta':
      return inv.scenarios.some((s) => s.uniqid === item.uniqid && s.complete && s.hash === item.remoteContentHash);
    case 'pattern':
      return inv.patterns.some((p) => p.uniqid === item.uniqid && p.version === item.remoteVersion);
    case 'team_names':
      return inv.team_names !== null && inv.team_names === item.remoteVersion;
    case 'report_layouts':
      return inv.report_layouts !== null && inv.report_layouts === item.remoteVersion;
    case 'game_type_admin_video':
      return !inv.game_active && inv.game_types.some((g) => g.code === item.code && g.version === item.remoteVersion);
    case 'game_type_override_video':
      return !inv.game_active && inv.overrides.some((o) => o.code === item.code && o.version === item.remoteVersion);
    case 'game_type_admin_subtitles':
      return inv.game_types.some(
        (g) => g.code === item.code && g.version === item.videoVersion && g.subtitles_version === item.subtitlesVersion
      );
    case 'game_type_override_subtitles':
      return inv.overrides.some(
        (o) => o.code === item.code && o.version === item.videoVersion && o.subtitles_version === item.subtitlesVersion
      );
    default:
      // Cards, on-demand cards, recovery codes: never from a peer.
      return false;
  }
}

/**
 * Background content sync from the LAN mother (offline venue). Adopts the
 * mother's cloud snapshot when it is strictly newer than ours (its deletions
 * included - they are real cloud deletions - unless a game is running), then
 * fetches whatever the mother holds at the exact version our manifest wants.
 * Runs only when the studio is unreachable or the mother's snapshot is newer:
 * online, the cloud stays the source. Returns false when it did nothing.
 */
export async function runPeerSync(source: PeerContentSource, signal?: AbortSignal): Promise<boolean> {
  if (!started || !currentUser) return false;
  if (cycleInFlight || checkInFlight || peerFetchInFlight) return false;
  // Same consent as cloud downloads (LaunchGate): nothing in the background
  // until the operator has agreed to this session's sync. Joining a game still
  // fetches its scenario (fetchScenarioFromSource).
  if (launchGate === 'declined' || launchGate === 'awaiting_answer') return false;
  const clientId = currentUser.client_id;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const previous = peerFetchTail;
  let release: () => void = () => {};
  peerFetchTail = new Promise<void>((r) => {
    release = r;
  });
  await previous;
  // A cycle may have started while we queued: never run two pools at once.
  if (cycleInFlight || checkInFlight || ctrl.signal.aborted) {
    signal?.removeEventListener('abort', onAbort);
    release();
    return false;
  }
  peerFetchInFlight = true;
  peerSyncAbort = ctrl;
  try {
    const inv = await source.getInventory(ctrl.signal);
    if (inv.client_id !== clientId) return false;
    const mine = await contentSyncState.get();
    const mineAsOf = mine && mine.client_id === clientId ? mine.cloud_as_of_ms : null;
    const peerNewer = inv.cloud_as_of_ms !== null && !inv.approx && (mineAsOf === null || inv.cloud_as_of_ms > mineAsOf);
    const cloudUsable = isOnline() && (await studioReachableFresh());
    if (cloudUsable && !peerNewer) return false;

    operatorOnly = await readOperatorOnly();
    if (launchGate === 'pending_check') {
      // Online, the cloud launch check asks the operator; let it.
      if (cloudUsable) return false;
      // Launched offline: ask about what the mother can bring, like the cloud
      // launch check would. Upserts only (no prune, snapshot not recorded) -
      // accepting re-runs this sync, which applies it for real.
      if (peerNewer) {
        const pm = await source.getManifest(ctrl.signal);
        if (pm.client_id !== clientId || pm.approx) return false;
        await applyManifest(clientId, pm.manifest as ManifestResponse, { prune: false, fromPeer: true });
      }
      const pending = (await buildWorkList(clientId, { onDemand: false, fromPeer: true })).filter((w) =>
        peerCanServe(w, inv)
      );
      const summary = await summarizeWork(pending);
      if (summary.total > 0) {
        launchGate = 'awaiting_answer';
        pendingUpdates = summary;
        pendingPeerSource = source;
        emit('updates:available', summary);
      }
      // Nothing the mother can bring: the gate stays closed, so the studio's
      // own launch check still asks once the internet is back.
      return false;
    }
    if (peerNewer) {
      const pm = await source.getManifest(ctrl.signal);
      if (pm.client_id !== clientId || pm.approx || pm.cloud_as_of_ms !== inv.cloud_as_of_ms) return false;
      const manifest = pm.manifest as ManifestResponse;
      await applyManifest(clientId, manifest, { prune: true, fromPeer: true });
      // Keep the snapshot's ORIGIN time, so ordering holds across hops.
      await contentSyncState.recordSnapshot(clientId, manifest, pm.cloud_as_of_ms, 'peer');
      emit('content:updated', { kind: 'scenarios', ids: [] });
    }

    const work = (await buildWorkList(clientId, { onDemand: false, fromPeer: true })).filter((w) =>
      peerCanServe(w, inv)
    );
    if (work.length === 0) return peerNewer;
    scenarioProgress.clear();
    peerFirstError = null;
    const deferring: PeerContentSource = inv.game_active ? { ...source, deferVideos: true } : source;
    await runDownloadPool(work, ctrl.signal, deferring, 2);
    await contentSyncState.bumpRev();
    return true;
  } catch (err) {
    console.warn('[syncOrchestrator] peer sync failed:', err);
    return false;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (peerSyncAbort === ctrl) peerSyncAbort = null;
    scenarioProgress.clear();
    peerFirstError = null;
    peerFetchInFlight = false;
    release();
  }
}

function clearRetry(): void {
  if (retryHandle) {
    clearTimeout(retryHandle);
    retryHandle = null;
  }
}

// Called once per finished cycle. `incomplete` = items were left behind for a
// reason worth retrying (not auth). Past the last backoff step the regular
// 30-min timer takes over.
function scheduleRetry(incomplete: boolean): void {
  clearRetry();
  if (!incomplete) {
    retryStep = 0;
    return;
  }
  if (!started || retryStep >= RETRY_BACKOFF_MS.length) return;
  const delay = RETRY_BACKOFF_MS[retryStep++];
  retryHandle = setTimeout(() => {
    retryHandle = null;
    void fireTrigger('retry');
  }, delay);
}

// ---------- trigger gate (debounce) ----------

async function fireTrigger(trigger: Trigger, opts: { force?: boolean } = {}): Promise<void> {
  if (!started || !currentUser) return;
  if (cycleInFlight || checkInFlight || peerFetchInFlight) return;
  if (trigger !== 'manual' && (launchGate === 'awaiting_answer' || launchGate === 'declined')) return;
  // Offline → don't even attempt a cycle. Every request would just time out
  // and surface as a spurious "Sync failed" banner. The 'network_up' trigger
  // (fired by the connectivity monitor when the radio recovers) is the proper
  // resumption path, so nothing is lost by skipping here. A user-initiated
  // 'manual' sync is still honoured - they may know connectivity is back even
  // when navigator.onLine hasn't caught up (captive-portal lag, etc.).
  //
  // navigator.onLine is only trusted as a fast NEGATIVE: on the normal venue
  // setup (satellites on an internet-less venue router) it reads TRUE, and
  // scheduled cycles used to fire and die at the manifest fetch (up to a 30s
  // timeout each) all event long. The truthful signal is the studio HTTP
  // probe's shared cache - consult it (one live probe at most when stale)
  // before spending a cycle.
  if (trigger !== 'manual') {
    if (!isOnline()) return;
    if (!(await studioReachableFresh())) return;
  }
  if (launchGate === 'pending_check') {
    await runLaunchCheck();
    return;
  }
  if (
    !opts.force &&
    lastCycleStartedAtMs !== null &&
    Date.now() - lastCycleStartedAtMs < DEBOUNCE_MS
  ) {
    return;
  }
  await runCycle(trigger);
}

// ---------- launch check ----------

// The askFirst launch check: phases 1-2 of a cycle (push local card edits,
// fetch + apply the manifest) WITHOUT the download pool and without pruning
// content the studio no longer lists - nothing is downloaded or deleted until
// the operator says yes. Silent: no cycle:* events, so the pill stays hidden.
// A failure leaves the gate at pending_check for the next automatic trigger.
async function runLaunchCheck(): Promise<void> {
  if (!currentUser || checkInFlight || cycleInFlight) return;
  checkInFlight = true;
  checkAbort = new AbortController();
  const signal = checkAbort.signal;
  let summary: PendingUpdatesSummary | null = null;
  try {
    operatorOnly = await readOperatorOnly();
    if (await cardsStore.hasPendingMutations()) {
      try {
        await cardsStore.pushPendingMutations();
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err;
      }
    }
    const work = await fetchManifestAndApply(signal, { prune: false });
    summary = await summarizeWork(work);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      emit('cycle:failed', { reason: 'auth_invalid', recoverable: false });
    } else if (!signal.aborted) {
      console.warn('[syncOrchestrator] launch check failed, will retry on the next trigger', err);
    }
  } finally {
    checkInFlight = false;
    checkAbort = null;
  }
  // stop() ran meanwhile (logout, hard-floor update): drop the result.
  if (signal.aborted || !started) return;
  // A manual sync was asked for while the check ran (fireTrigger dropped it
  // because checkInFlight): run it now.
  if (launchGate === 'open') {
    await runCycle('manual');
    return;
  }
  if (!summary || launchGate !== 'pending_check') return;

  if (summary.total === 0) {
    // Nothing to download: open the gate and run a normal cycle, which applies
    // what the check held back (removed scenarios/patterns) - no downloads.
    launchGate = 'open';
    await runCycle('startup');
    return;
  }
  launchGate = 'awaiting_answer';
  pendingUpdates = summary;
  emit('updates:available', summary);
}

async function summarizeWork(work: WorkItem[]): Promise<PendingUpdatesSummary> {
  const summary: PendingUpdatesSummary = {
    total: 0,
    newScenarios: [],
    updatedScenarios: [],
    patterns: 0,
    videos: 0,
    other: 0,
  };
  const pendingScenarios = new Map(
    (await scenarioStore.listPendingDownloads()).map((s) => [s.uniqid, s])
  );
  for (const w of work) {
    if (w.kind === 'on_demand') continue;
    summary.total += 1;
    switch (w.kind) {
      case 'scenario_meta': {
        const row = pendingScenarios.get(w.uniqid);
        const title = row?.title ?? w.label;
        if (row && row.local_version !== null) summary.updatedScenarios.push(title);
        else summary.newScenarios.push(title);
        break;
      }
      case 'pattern':
        summary.patterns += 1;
        break;
      case 'game_type_admin_video':
      case 'game_type_override_video':
        summary.videos += 1;
        break;
      default:
        summary.other += 1;
    }
  }
  return summary;
}

async function readOperatorOnly(): Promise<boolean> {
  return loadConfig()
    .then((c) => c.operatorOnlyDevice === true)
    .catch(() => false);
}

// ---------- cycle ----------

async function runCycle(trigger: Trigger): Promise<void> {
  if (!currentUser) return;
  // One pool at a time (they share scenarioProgress): a peer fetch/sync that
  // got in first wins; it re-triggers the cycle when it's done.
  if (cycleInFlight || peerFetchInFlight) return;
  cycleInFlight = true;
  let resolveCycleDone: () => void = () => {};
  cycleDone = new Promise<void>((r) => {
    resolveCycleDone = r;
  });
  lastCycleStartedAtMs = Date.now();
  cycleAbort = new AbortController();
  scenarioProgress.clear();

  // Operator-only download policy - read once for the whole cycle (cheap FS
  // read). Drives the slim scenario-media filter + tutorial-video skip below.
  operatorOnly = await readOperatorOnly();

  // Cycle cap (see CYCLE_IDLE_CAP_MS). Firing aborts the cycle: the pool stops
  // dispatch, Promise.all resolves, and the cycle ends as a recoverable
  // failure rather than hanging. Cleared in the finally block below.
  const thisCycleAbort = cycleAbort;
  const cycleStartedAtMs = Date.now();
  bumpCycleProgress();
  const capTimer = setInterval(() => {
    // Workers can take a moment to unwind after the abort; don't re-log each tick.
    if (thisCycleAbort.signal.aborted) return;
    const now = Date.now();
    if (now - lastCycleProgressAtMs > CYCLE_IDLE_CAP_MS) {
      console.warn('[syncOrchestrator] cycle made no progress for the idle cap, aborting');
      thisCycleAbort.abort();
    } else if (now - cycleStartedAtMs > CYCLE_ABSOLUTE_CAP_MS) {
      console.warn('[syncOrchestrator] cycle exceeded absolute cap, aborting');
      thisCycleAbort.abort();
    }
  }, CYCLE_CAP_CHECK_MS);


  const startedAtIso = new Date().toISOString();
  currentTrigger = trigger;
  currentPhase = null;
  lastCurrentLabel = null;
  emit('cycle:started', { trigger, startedAt: startedAtIso });

  let total = 0;
  let completed = 0;
  let failed = 0;

  // The terminal event (cycle:finished / cycle:failed) is captured here and
  // fired from the finally block - AFTER cycleInFlight is cleared - so a
  // listener that calls getState() inside its handler sees the orchestrator
  // already idle. Emitting it inline (while still inside this try) left
  // cycleInFlight=true at notification time, which froze the UI's "Syncing…".
  let emitTerminal: (() => void) | null = null;
  // Whether this cycle left work behind that a quick follow-up should pick up.
  let retryWorthy = false;

  try {
    // Phase 1: push pending local mutations (uploads).
    // Pre-checked so we emit 'skipped' for the common no-op case, instead of
    // a started→finished pair for zero work.
    currentPhase = 'push_pending';
    bumpCycleProgress();
    const hasPending = await cardsStore.hasPendingMutations();
    if (hasPending) {
      emit('cycle:phase', { phase: 'push_pending', status: 'started' });
      try {
        await cardsStore.pushPendingMutations();
      } catch (err) {
        // Auth failures bubble up - same as any other phase.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          throw err;
        }
        // Non-auth (network blip, 409 conflict, ...) are recorded on the
        // pending row and reconciled by the next pull. Don't fail the cycle.
      }
      emit('cycle:phase', { phase: 'push_pending', status: 'finished' });
    } else {
      emit('cycle:phase', { phase: 'push_pending', status: 'skipped' });
    }

    // Phase 2: manifest fetch + DB apply.
    currentPhase = 'manifest';
    bumpCycleProgress();
    emit('cycle:phase', { phase: 'manifest', status: 'started' });
    const work = await fetchManifestAndApply(cycleAbort.signal);
    total = work.length;
    bumpCycleProgress();
    emit('cycle:progress', { total, completed: 0, failed: 0 });
    emit('cycle:phase', { phase: 'manifest', status: 'finished' });

    // Phase 3: download pool.
    currentPhase = 'download';
    bumpCycleProgress();
    emit('cycle:phase', { phase: 'download', status: 'started' });
    const result = await runDownloadPool(work, cycleAbort.signal);
    // Pull counts BEFORE checking for auth error. The pool returns partial
    // progress on auth failure (used to throw, which discarded the counts
    // and skipped the post-pool sweep). This keeps lastCycleStats accurate
    // - "1 of 12 downloaded" rather than the stale "0 of 3" the catch
    // block used to record.
    completed = result.completed;
    failed = result.failed;
    total = result.total;
    emit('cycle:phase', { phase: 'download', status: 'finished' });
    // New content on disk: satellites routed to us see the revision move on
    // their next ping and pull it (LAN content sync).
    if (completed > 0) await contentSyncState.bumpRev().catch(() => {});
    if (result.authError) {
      throw result.authError;
    }

    lastCycleStats = { total, completed, failed };
    // Failed items, or items never reached because the idle cap aborted the pool.
    retryWorthy = failed > 0 || completed < total;
    const finishedAt = new Date().toISOString();
    lastCycleFinishedAtIso = finishedAt;
    emitTerminal = () =>
      emit('cycle:finished', {
        startedAt: startedAtIso,
        finishedAt,
        total,
        completed,
        failed,
      });
  } catch (err) {
    lastCycleStats = { total, completed, failed };
    lastCycleFinishedAtIso = new Date().toISOString();
    if (cycleYieldedToPeer) {
      const finishedAt = lastCycleFinishedAtIso;
      emitTerminal = () => emit('cycle:finished', { startedAt: startedAtIso, finishedAt, total, completed, failed });
    } else if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      emitTerminal = () => emit('cycle:failed', { reason: 'auth_invalid', recoverable: false });
    } else {
      retryWorthy = true;
      const detail = buildFailureDetail(err);
      // Log full raw err to console so a developer with devtools open can
      // inspect even non-serializable values (DOMException, Error subclasses,
      // Tauri invoke rejections that come back as plain strings, etc).
      console.error('[syncOrchestrator] cycle failed', {
        err,
        trigger: currentTrigger,
        phase: currentPhase,
        lastLabel: lastCurrentLabel,
        counters: { total, completed, failed },
      });
      // Whole-cycle failure (manifest fetch died, hard-cap/abort, etc.) has no
      // per-item key - report it via the generic error-telemetry path so the
      // admin sees "device X's sync cycle is failing entirely". Best-effort.
      void captureError(err, {
        source: 'sync_cycle',
        trigger: detail.trigger,
        phase: detail.phase ?? undefined,
        last_label: detail.lastLabel ?? undefined,
      });
      emitTerminal = () =>
        emit('cycle:failed', {
          reason: detail.errorType
            ? `${detail.errorType}: ${detail.serialized}`
            : detail.serialized,
          recoverable: true,
          detail,
        });
    }
  } finally {
    clearInterval(capTimer);
    cycleInFlight = false;
    cycleAbort = null;
    currentPhase = null;
    currentTrigger = null;
    scheduleRetry(retryWorthy);
    // Orchestrator is idle again - now fire the terminal event so any
    // getState() call inside a listener observes the consistent idle state.
    emitTerminal?.();
    resolveCycleDone();
  }
}

// Build a serializable diagnostic snapshot for cycle:failed. The catch block
// receives an arbitrary thrown value (Error subclass, string, plain object,
// undefined - anything). We normalize to strings so the UI can render and
// the user can copy-paste a complete diagnostic without listeners having to
// JSON.stringify a circular value themselves.
function buildFailureDetail(err: unknown): CycleFailureDetail {
  let errorType = 'unknown';
  let serialized = 'cycle failed with unknown error';
  let stack: string | null = null;

  if (err instanceof Error) {
    errorType = err.constructor.name || 'Error';
    serialized = err.message || String(err);
    stack = err.stack ?? null;
  } else if (typeof err === 'string') {
    errorType = 'string';
    serialized = err;
  } else if (err === null) {
    errorType = 'null';
    serialized = 'null';
  } else if (err === undefined) {
    errorType = 'undefined';
    serialized = 'undefined';
  } else if (typeof err === 'object') {
    errorType = (err as object).constructor?.name || 'object';
    try {
      serialized = JSON.stringify(err);
    } catch {
      serialized = String(err);
    }
  } else {
    errorType = typeof err;
    serialized = String(err);
  }

  return {
    errorType,
    serialized,
    stack,
    trigger: currentTrigger ?? 'unknown',
    phase: currentPhase,
    lastLabel: lastCurrentLabel,
    counters: lastCycleStats ?? { total: 0, completed: 0, failed: 0 },
  };
}

// ---------- manifest fetch + apply ----------

// `prune: false` (the launch check) applies upserts only: content the studio
// no longer lists stays on disk until a real cycle runs.
async function fetchManifestAndApply(
  signal: AbortSignal,
  opts: { prune?: boolean } = {}
): Promise<WorkItem[]> {
  if (!currentUser) throw new Error('orchestrator: no current user');
  const clientId = currentUser.client_id;

  // NOTE: push_pending lives in runCycle (its own phase) - by the time we
  // get here, any outgoing card mutations have been pushed and studio's
  // cards_version reflects this device's writes.

  // apiCall applies a default 30s per-request timeout internally (see
  // api.ts DEFAULT_REQUEST_TIMEOUT_MS) - pass only the cycle abort signal.
  const manifest = await withRetry(() =>
    apiCall<ManifestResponse>('playground', 'get_user_data_update', {
      method: 'GET',
      bearer: true,
      signal,
    })
  );

  // Best-effort replay of any deferred onboarding/Network "default mother"
  // writes (grill Q13). We're guaranteed online + authed here,
  // so this is the natural retry tick. Fire-and-forget - it never blocks sync.
  void lanNetworks.flushPendingLanOps();

  await applyManifest(clientId, manifest, { prune: opts.prune !== false, fromPeer: false });

  // Remember this cloud snapshot (and when the cloud produced it) so LAN peers
  // can tell whose content is the most recent when the venue has no internet.
  await contentSyncState.recordSnapshot(clientId, manifest, manifest.server_time, 'cloud');

  const work = await buildWorkList(clientId, { onDemand: manifest.has_on_demand_cards, fromPeer: false });

  // Reconcile the failure tracker against reality: any previously-failing item
  // that's no longer pending (its content was unassigned/removed in studio)
  // left the work list without succeeding - resolve-by-removal so the admin's
  // view doesn't show it stuck forever. Dynamic scenario_media keys aren't in
  // `work` yet; reconcileObsolete keeps them alive via their parent scenario.
  await reconcileObsolete(new Set(work.map((w) => syncItemKey(w))));

  return work;
}

// Apply a manifest's upserts (and, with `prune`, its tombstones) to the local
// stores. `fromPeer`: the manifest came from a LAN peer (a cloud snapshot it
// applied, newer than ours) - the device-only parts (client preferences,
// recovery codes, on-demand cards, cards) are left for our own next cloud
// cycle; see contentSyncState.
async function applyManifest(
  clientId: number,
  manifest: ManifestResponse,
  opts: { prune: boolean; fromPeer: boolean }
): Promise<void> {
  const seenAt = new Date().toISOString();
  // db handle was used here for an explicit BEGIN/COMMIT transaction. That
  // pattern is unsafe with tauri-plugin-sql v2: the plugin's only API is
  // `execute(sql)` running on a sqlx::Pool, which acquires a fresh
  // connection per call. A `BEGIN` executed on connection A is invisible to
  // subsequent statements that get connection B, and the BEGIN'd connection
  // is returned to the pool with an open transaction - surfacing later as
  // "cannot start a transaction within a transaction" on a totally
  // unrelated cycle. The plugin exposes no transaction-binding API.
  //
  // We instead rely on each operation being idempotent: upserts are
  // INSERT OR REPLACE keyed on PK, tombstones DELETE-by-not-in-set. A
  // partial apply (network blip mid-way) leaves the DB in a state that the
  // next cycle's manifest-apply re-converges. The atomicity guarantee
  // was a nice-to-have, not a correctness requirement.
  await getDb(); // ensure pool is initialized before first execute below

  // Scenarios: combine custom + product into a single set, distinguish via flag.
  const allScenarioRows = [
    ...manifest.custom_scenarios.map((s) => ({ ...s, content_hash: s.content_hash ?? null, is_product: false })),
    ...manifest.product_scenarios.map((s) => ({ ...s, content_hash: s.content_hash ?? null, is_product: true })),
  ];
  await scenarioStore.upsertFromManifest(allScenarioRows, seenAt);

  // Never prune local content out from under a running game. Tombstoning hard-deletes
  // rows + on-disk media, which would yank a scenario the live game is rendering (e.g.
  // an admin disables its game type mid-event). Upserts above still apply; the prune is
  // deferred until the next cycle after the game ends. See activeSession.isGameActive.
  const pruneAllowed = opts.prune && !isGameActive();

  if (pruneAllowed) {
    const removedScenarios = await scenarioStore.tombstoneMissing(allScenarioRows.map((s) => s.uniqid));
    if (removedScenarios.length) {
      emit('content:updated', { kind: 'scenarios', ids: [], removed: removedScenarios });
    }
  }

  // Patterns: default + custom.
  const allPatternRows = [
    ...manifest.default_patterns.map((p) => ({ ...p, is_default: true })),
    ...manifest.custom_patterns.map((p) => ({ ...p, is_default: false })),
  ];
  await patternStore.upsertFromManifest(allPatternRows, seenAt);
  if (pruneAllowed) {
    const removedPatterns = await patternStore.tombstoneMissing(allPatternRows.map((p) => p.pattern_uniqid));
    if (removedPatterns.length) {
      emit('content:updated', { kind: 'patterns', ids: [], removed: removedPatterns });
    }
  }

  // The per-game-type `layouts` pipeline was retired (studio dropped it too):
  // tagquest falls back to its bundled default layout, tracks places elements
  // via game_meta.checkpoints[].position (synced with the scenario), clash uses
  // scenario_layout, and mystery has no layout. Nothing to sync here.

  // Global admin translations (inline JSON, no separate download pool).
  await translationsStore.upsertFromManifest(manifest.translations ?? [], seenAt);
  await translationsStore.tombstoneMissing(translationsStore.KNOWN_TRANSLATION_KEYS);
  // Overlay the freshly-synced in-game text (bucket 2) onto the i18next baselines.
  await hydrateIngameFromStore();

  // Game types (admin defaults + per-client overrides). Inline manifest +
  // separate video/subtitle downloads queued via the same pool.
  const gameTypes = manifest.game_types ?? [];
  // (These tombstones delete tutorial videos on disk, so the launch check
  // holds them back too.)
  await gameTypesStore.upsertGameTypesFromManifest(gameTypes);
  if (opts.prune) {
    await gameTypesStore.tombstoneMissingGameTypes(gameTypes.map((g) => g.code));
  }
  const overrides = manifest.client_game_type_overrides ?? [];
  await gameTypesStore.upsertOverridesFromManifest(overrides);
  if (opts.prune) {
    await gameTypesStore.tombstoneMissingOverrides(overrides.map((o) => o.game_type_code));
  }

  if (!opts.fromPeer) {
    // Client preferences (inline JSON only - no version, just last-write-wins).
    await clientPreferencesStore.setFromManifest(clientId, manifest.client_preferences ?? {});

    // Cards (single-row state).
    await cardsStore.upsertFromManifest(clientId, {
      cards_version: manifest.cards_version,
      has_on_demand_cards: manifest.has_on_demand_cards,
    });
  }

  // Team-name pools (single-row state, incremental version compare).
  await namePoolsStore.upsertFromManifest(clientId, {
    team_names_version: manifest.team_names_version ?? null,
  });

  // Offline PIN-recovery codes (single-row state, incremental version compare).
  if (!opts.fromPeer) {
    await recoveryCodesStore.upsertFromManifest(clientId, {
      recovery_codes_version: manifest.recovery_codes_version ?? null,
    });
    // Licensee customers (cloud only: contact-free cache, see customersStore).
    await customersStore.upsertFromManifest(clientId, {
      customers_version: manifest.customers_version ?? null,
    });
  }

  // Mission-report PDF layout defaults (global, single-row state).
  await reportLayoutsStore.upsertFromManifest({
    report_layouts_version: manifest.report_layouts_version ?? null,
  });

}

// Pending downloads across all stores, after a manifest apply. A peer-sourced
// list leaves out what a LAN peer never serves (cards, on-demand cards,
// recovery codes).
async function buildWorkList(clientId: number, opts: { onDemand: boolean; fromPeer: boolean }): Promise<WorkItem[]> {
  const work: WorkItem[] = [];

  if (!opts.fromPeer && (await cardsStore.needsCardsDownload(clientId))) {
    const row = await cardsStore.get(clientId);
    if (row && row.remote_version !== null) {
      work.push({
        kind: 'cards',
        priority: 1,
        clientId,
        remoteVersion: row.remote_version,
        label: `Cards v${row.remote_version}`,
      });
    }
  }
  if (opts.onDemand && !opts.fromPeer) {
    work.push({ kind: 'on_demand', priority: 1, clientId, label: 'On-demand cards' });
  }
  if (await namePoolsStore.needsTeamNamesDownload(clientId)) {
    const row = await namePoolsStore.get(clientId);
    if (row && row.remote_version !== null) {
      work.push({
        kind: 'team_names',
        priority: 1,
        clientId,
        remoteVersion: row.remote_version,
        label: `Team names v${row.remote_version}`,
      });
    }
  }
  if (!opts.fromPeer && (await recoveryCodesStore.needsRecoveryCodesDownload(clientId))) {
    const row = await recoveryCodesStore.getState(clientId);
    if (row && row.remote_version !== null) {
      work.push({
        kind: 'recovery_codes',
        priority: 1,
        clientId,
        remoteVersion: row.remote_version,
        label: `Recovery codes v${row.remote_version}`,
      });
    }
  }
  if (!opts.fromPeer && (await customersStore.needsDownload(clientId))) {
    const row = await customersStore.getState(clientId);
    if (row && row.remote_version !== null) {
      work.push({
        kind: 'customers',
        priority: 1,
        clientId,
        remoteVersion: row.remote_version,
        label: `Customers v${row.remote_version}`,
      });
    }
  }
  if (await reportLayoutsStore.needsDownload()) {
    const row = await reportLayoutsStore.getState();
    if (row && row.remote_version !== null) {
      work.push({
        kind: 'report_layouts',
        priority: 1,
        remoteVersion: row.remote_version,
        label: `Report layouts v${row.remote_version}`,
      });
    }
  }

  for (const p of await patternStore.listPendingDownloads()) {
    work.push({
      kind: 'pattern',
      priority: 2,
      uniqid: p.pattern_uniqid,
      remoteVersion: p.remote_version,
      label: `Pattern: ${p.name}`,
    });
  }
  // Layouts intentionally not enqueued - see the manifest-apply note above.
  for (const s of await scenarioStore.listPendingDownloads()) {
    if (!s.remote_content_hash) continue; // gate guarantees non-null, belt-and-braces
    work.push({
      kind: 'scenario_meta',
      priority: 4,
      uniqid: s.uniqid,
      remoteVersion: s.remote_version,
      remoteContentHash: s.remote_content_hash,
      label: `Scenario: ${s.title}`,
    });
  }

  // Game-type tutorial videos are play-only (shown to players in-game) and the
  // heaviest assets on disk. An operator-only device never plays, so skip them
  // entirely - the game-type rows are still upserted above (for labels/metadata),
  // just not enqueued for the big video download.
  if (!operatorOnly) {
    for (const g of await gameTypesStore.listPendingAdminDownloads()) {
      if (!g.tutorial_video_filename) continue;
      work.push({
        kind: 'game_type_admin_video',
        priority: 6,
        code: g.code,
        remoteVersion: g.remote_version,
        filename: g.tutorial_video_filename,
        subtitleFilenames: g.tutorial_subtitles,
        subtitlesVersion: g.subtitles_remote_version,
        label: `Tutorial video (${g.name})`,
      });
    }
    for (const o of await gameTypesStore.listPendingOverrideDownloads()) {
      if (!o.tutorial_video_filename) continue;
      work.push({
        kind: 'game_type_override_video',
        priority: 6,
        code: o.game_type_code,
        remoteVersion: o.remote_version,
        filename: o.tutorial_video_filename,
        subtitleFilenames: o.tutorial_subtitles,
        subtitlesVersion: o.subtitles_remote_version,
        label: `Tutorial override (${o.game_type_code})`,
      });
    }
    // Subtitle-only changes: the video is already on disk at the right
    // version, so fetch just the .vtt tracks (a few KB) instead of the video.
    for (const g of await gameTypesStore.listPendingAdminSubtitleDownloads()) {
      if (g.local_version === null) continue;
      work.push({
        kind: 'game_type_admin_subtitles',
        priority: 6,
        code: g.code,
        videoVersion: g.local_version,
        subtitleFilenames: g.tutorial_subtitles,
        subtitlesVersion: g.subtitles_remote_version,
        label: `Tutorial subtitles (${g.name})`,
      });
    }
    for (const o of await gameTypesStore.listPendingOverrideSubtitleDownloads()) {
      if (o.local_version === null) continue;
      work.push({
        kind: 'game_type_override_subtitles',
        priority: 6,
        code: o.game_type_code,
        videoVersion: o.local_version,
        subtitleFilenames: o.tutorial_subtitles,
        subtitlesVersion: o.subtitles_remote_version,
        label: `Tutorial override subtitles (${o.game_type_code})`,
      });
    }
  }

  // Stable priority sort.
  work.sort((a, b) => a.priority - b.priority);
  return work;
}

// ---------- download pool ----------

async function runDownloadPool(
  initial: WorkItem[],
  signal: AbortSignal,
  source: ContentSource = cloudSource,
  poolSize: number = POOL_SIZE
): Promise<{ completed: number; failed: number; total: number; authError: ApiError | null }> {
  const cloud = source.kind === 'cloud';
  // Cycle counters go to the sync UI for cloud cycles only; a peer fetch has
  // its own progress sink (peerProgress) and no cycle around it.
  const emitCycleProgress = (p: CycleProgressPayload) => {
    if (cloud) emit('cycle:progress', p);
  };
  // Dynamic queue - scenario_meta tasks enqueue scenario_media items mid-cycle.
  const queue: WorkItem[] = [...initial];
  let completed = 0;
  let failed = 0;
  let total = initial.length;

  // 401/403 inside a worker stops further dispatch but does NOT throw out of
  // the pool: previously we re-threw, which discarded the per-item counts
  // and skipped the post-pool sweep that marks scenarios with all-media-OK
  // as downloaded. Now we capture the error in the return value so the
  // caller can apply partial progress AND surface the auth-interruption.
  let authInvalid = false;
  let authError: ApiError | null = null;

  const workers = Array.from({ length: poolSize }, async () => {
    while (queue.length > 0) {
      if (signal.aborted) return;
      if (authInvalid) return;
      const item = queue.shift();
      if (!item) return;
      lastCurrentLabel = item.label;
      // An item starting is forward progress, so kinds that never stream
      // (patterns, cards, ...) also hold the idle cap open while they run.
      bumpCycleProgress();
      try {
        const { enqueued, bytes } = await downloadOne(item, signal, source);
        if (enqueued && enqueued.length) {
          queue.push(...enqueued);
          total += enqueued.length;
        }
        completed += 1;
        // Item downloaded OK - if it was being tracked as failing, clear the
        // row (and report resolved to studio if it had been promoted).
        if (cloud) await recordSuccess(item).catch(() => {});
        emitCycleProgress({
          total,
          completed,
          failed,
          currentLabel: item.label,
          byteLength: bytes > 0 ? bytes : undefined,
          itemKind: item.kind,
          groupKey: groupKeyOf(item),
        });
      } catch (err) {
        // 401 = unauthenticated (the bearer token itself is bad) → the whole
        // cycle is doomed, so stop dispatch and surface auth_invalid.
        //
        // 403 is NOT auth-invalid: the token is fine, the client just lacks
        // access to THIS one resource (e.g. an un-owned product scenario the
        // manifest still advertised). It must fall through to the per-item
        // failure path below so the rest of the work - scenarios the client
        // *can* access - still downloads, and so it does not trigger a
        // spurious auth refresh.
        if (err instanceof ApiError && err.status === 401) {
          authInvalid = true;
          authError = err;
          return;
        }
        // Cycle teardown (idle/absolute cap, stop(), sign-out) is OUR doing, not
        // the item's. Recording it would mark a perfectly good file failed,
        // churn failed_attempts, and - after two such cycles - promote it to the
        // studio as a real sync failure, filling the admin report with noise we
        // caused. Leave the item in `remaining` so the scenario is not committed
        // as complete, and let the next cycle retry it cleanly.
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          emitItemProgress(item.label, item.kind, 0, null, true);
          return;
        }
        failed += 1;
        emitCycleProgress({
          total,
          completed,
          failed,
          currentLabel: item.label,
          itemKind: item.kind,
          groupKey: groupKeyOf(item),
        });
        // Defensively clear any in-flight item-progress state so the UI
        // doesn't show a half-finished bar forever. Harmless for kinds that
        // never streamed (the listener just removes a key it didn't know).
        emitItemProgress(item.label, item.kind, 0, null, true);
        await markFailed(item, cloud).catch(() => {});
        // Persistent per-item failure tracker: records the file/label + error
        // for the operator panel, and promotes to a studio report after 2
        // consecutive failing cycles. 403 (un-owned resource) lands here too,
        // which is intentional - the admin wants to see those. A LAN peer's
        // failure says nothing about the studio, so it is not recorded.
        if (cloud) {
          await recordFailure(item, err).catch(() => {});
        } else {
          console.warn(`[syncOrchestrator] ${source.label}: ${item.label} failed`, err);
          if (peerFirstError === null) peerFirstError = err;
        }
      }
    }
  });

  await Promise.all(workers);

  // Mark scenarios that have completed all their media items. We run this
  // sweep UNCONDITIONALLY - even when an auth_invalid bubbled up - so any
  // scenario whose media all completed before the auth blip still gets
  // committed. Without this, an auth-interrupted cycle leaves the DB at
  // 0-downloaded even though bytes are already on disk.
  for (const [uniqid, progress] of scenarioProgress) {
    if (progress.remaining.size === 0 && progress.failed.size === 0 && !progress.commitFull) {
      // A LAN peer's whole copy is here, but it isn't known to match our cloud
      // manifest: launchable now, still pending for the next cloud cycle.
      await scenarioStore.commitPartialManifest(uniqid, progress.manifest, progress.manifest, progress.remoteVersion);
      emit('content:updated', { kind: 'scenarios', ids: [uniqid] });
    } else if (progress.remaining.size === 0 && progress.failed.size === 0) {
      // All target blobs are in the pool - atomically swap in the new manifest
      // and mark the scenario reconciled at the remote content hash.
      await scenarioStore.commitManifest(
        uniqid,
        progress.manifest,
        progress.remoteContentHash,
        progress.remoteVersion
      );
      emit('content:updated', { kind: 'scenarios', ids: [uniqid] });
      // Scenario fully downloaded - clear any stale media failure rows for it.
      if (cloud) await recordScenarioComplete(uniqid).catch(() => {});
    } else if (isPartiallyReady(progress)) {
      // Everything except one or more VIDEOS is on disk. Commit a partial
      // manifest so the scenario is launchable now instead of being held back -
      // a 200 MB video that needs several cycles used to block its whole
      // scenario, images included. local_content_hash is left untouched, so the
      // next cycle picks the videos back up and eventually commits in full.
      const present = progress.manifest.filter(
        (f) => !progress.remaining.has(f.rel_path) && !progress.failed.has(f.rel_path)
      );
      await scenarioStore.commitPartialManifest(
        uniqid,
        present,
        progress.manifest,
        progress.remoteVersion
      );
      emit('content:updated', { kind: 'scenarios', ids: [uniqid] });
      if (cloud && progress.failed.size > 0) {
        await scenarioStore.incrementFailedAttempts(uniqid).catch(() => {});
      }
    } else if (cloud && progress.failed.size > 0) {
      await scenarioStore.incrementFailedAttempts(uniqid).catch(() => {});
    }
  }

  return { completed, failed, total, authError: authInvalid ? authError : null };
}

// Emits a streaming-download progress event. Called per-chunk by the
// download helpers so the UI can render an in-flight item caption with a
// real percentage. `done=true` is the final emission (download finished or
// failed), so subscribers can clear the item from their in-flight map.
function emitItemProgress(
  label: string,
  itemKind: WorkItem['kind'],
  loaded: number,
  total: number | null,
  done = false,
): void {
  // Called once per streamed chunk - the finest-grained proof of life we have,
  // and what keeps the cycle's idle cap from firing on a long download.
  bumpCycleProgress();
  if (peerFetchInFlight) {
    peerProgress?.({ label, loaded, total, done });
    return;
  }
  emit('cycle:item_progress', {
    key: label,
    label,
    itemKind,
    loaded,
    total,
    done,
  });
}

// True when a scenario is missing something, but everything it is missing is a
// video. Such a scenario is worth committing as launchable: a missing image
// visibly breaks the HUD, whereas an absent video already degrades gracefully -
// resolveVideosByKind() resolves through getMediaPath(...).catch(() => null) and
// silently drops sources it can't find, so "Play -> Intro" is simply unavailable
// until the file lands.
//
// markFailed() moves an entry out of `remaining` into `failed`, so the missing
// set is the union of the two.
function isPartiallyReady(progress: ScenarioProgress): boolean {
  const missing = [...progress.remaining, ...progress.failed];
  if (missing.length === 0) return false;
  return missing.every(isVideoFile);
}

// Scenario-meta items + their dependent scenario_media items share a group
// key (the scenario uniqid) so the activity-log UI can collapse media files
// under their parent scenario. All other kinds stand alone (no grouping).
function groupKeyOf(item: WorkItem): string | undefined {
  if (item.kind === 'scenario_meta' || item.kind === 'scenario_media') {
    return item.uniqid;
  }
  return undefined;
}

async function markFailed(item: WorkItem, cloud = true): Promise<void> {
  // A LAN peer failing tells us nothing about the studio copy: only the
  // in-cycle media bookkeeping applies, never the persisted failure counters.
  if (!cloud && item.kind !== 'scenario_media') return;
  switch (item.kind) {
    case 'cards':
    case 'on_demand':
      await cardsStore.incrementFailedAttempts(item.clientId);
      break;
    case 'team_names':
      await namePoolsStore.incrementFailedAttempts(item.clientId);
      break;
    case 'recovery_codes':
      await recoveryCodesStore.incrementFailedAttempts(item.clientId);
      break;
    case 'customers':
      await customersStore.incrementFailedAttempts(item.clientId);
      break;
    case 'report_layouts':
      await reportLayoutsStore.incrementFailedAttempts();
      break;
    case 'pattern':
      await patternStore.incrementFailedAttempts(item.uniqid);
      break;
    case 'scenario_meta':
      await scenarioStore.incrementFailedAttempts(item.uniqid);
      break;
    case 'scenario_media': {
      const p = scenarioProgress.get(item.uniqid);
      if (p) {
        p.failed.add(item.filename);
        p.remaining.delete(item.filename);
      }
      break;
    }
    case 'game_type_admin_video':
    case 'game_type_admin_subtitles':
      await gameTypesStore.incrementAdminFailedAttempts(item.code);
      break;
    case 'game_type_override_video':
    case 'game_type_override_subtitles':
      await gameTypesStore.incrementOverrideFailedAttempts(item.code);
      break;
  }
}

// Returns work items to enqueue (only scenario_meta produces non-empty -
// it discovers media files to fetch). `bytes` is a best-effort size of the
// payload that was just downloaded (binary length for media, JSON byte
// length for API responses, 0 when not measurable). The pool aggregates
// it into the cycle-wide total shown in the sync UI.
type DownloadOutcome = { enqueued: WorkItem[] | null; bytes: number };

async function downloadOne(item: WorkItem, signal: AbortSignal, source: ContentSource = cloudSource): Promise<DownloadOutcome> {
  switch (item.kind) {
    case 'cards':
      return downloadCards(item, signal);
    case 'on_demand':
      return downloadOnDemand(item, signal);
    case 'team_names':
      return downloadTeamNames(item, signal, source);
    case 'recovery_codes':
      return downloadRecoveryCodes(item, signal);
    case 'customers':
      return downloadCustomers(item, signal);
    case 'report_layouts':
      return downloadReportLayouts(item, signal, source);
    case 'pattern':
      return downloadPattern(item, signal, source);
    case 'scenario_meta':
      return downloadScenarioMeta(item, signal, source);
    case 'scenario_media':
      return downloadScenarioMedia(item, signal, source);
    case 'game_type_admin_video':
      return downloadGameTypeAdminVideo(item, signal, source);
    case 'game_type_override_video':
      return downloadGameTypeOverrideVideo(item, signal, source);
    case 'game_type_admin_subtitles':
    case 'game_type_override_subtitles':
      return downloadGameTypeSubtitlesOnly(item, signal, source);
  }
}

// Approximate JSON-byte size of an arbitrary value. Used only for the UI's
// running-total display; we already have the parsed object in hand, so
// re-stringifying just to measure is the simplest path.
function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

async function downloadCards(
  item: Extract<WorkItem, { kind: 'cards' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  // Pull the row-based card list from studio (JSON, replaces the legacy
  // download_cards CSV stream). cardsStore.pullCardsFromServer reconciles
  // into the local `cards` table without clobbering pending-write rows,
  // then bumps cards_state.local_version. The store doesn't expose the raw
  // payload, so we can't report bytes here without re-fetching.
  await withRetry(() => cardsStore.pullCardsFromServer(item.clientId, signal));
  emit('content:updated', { kind: 'cards', ids: [item.clientId] });
  return { enqueued: null, bytes: 0 };
}

async function downloadOnDemand(
  item: Extract<WorkItem, { kind: 'on_demand' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  const bytes = await withRetry(() =>
    apiDownloadBytesStream('playground', 'get_on_demand_cards', {
      bearer: true,
      signal,
      onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
    })
  );
  emitItemProgress(item.label, item.kind, bytes.byteLength, bytes.byteLength, true);
  await ensureDir('media/cards');
  await writeText(onDemandCardsFileRel(), new TextDecoder().decode(bytes));
  await cardsStore.markOnDemandFetched(item.clientId);
  emit('content:updated', { kind: 'on_demand_cards', ids: [item.clientId] });
  return { enqueued: null, bytes: bytes.byteLength };
}

// Team-name pools: download the merged (global ∪ client) names JSON and write
// it where the LAN mother (Rust) reads it at team creation. Version-gated like
// cards (only runs when remote_version changed).
async function downloadTeamNames(
  item: Extract<WorkItem, { kind: 'team_names' }>,
  signal: AbortSignal,
  source: ContentSource = cloudSource
): Promise<DownloadOutcome> {
  const text = await withRetry(() =>
    source.getTeamNames(signal, (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total))
  );
  const size = new TextEncoder().encode(text).byteLength;
  emitItemProgress(item.label, item.kind, size, size, true);
  await ensureDir('media/name_pools');
  await writeText(teamNamesFileRel(), text);
  await namePoolsStore.markDownloaded(item.clientId, item.remoteVersion);
  emit('content:updated', { kind: 'team_names', ids: [item.clientId] });
  return { enqueued: null, bytes: size };
}

// Offline PIN-recovery codes: download the client's plaintext pool and hash it
// into the local recovery_codes table (replaceRecoveryPool resets used flags).
// Version-gated like team names - only runs when the admin regenerated. Unlike
// team names, this is NOT written to disk: the codes go straight into SQLite as
// salted hashes (the plaintext exists only in transit).
async function downloadRecoveryCodes(
  item: Extract<WorkItem, { kind: 'recovery_codes' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  const bytes = await withRetry(() =>
    apiDownloadBytesStream('playground', 'get_recovery_codes', {
      bearer: true,
      signal,
      onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
    })
  );
  emitItemProgress(item.label, item.kind, bytes.byteLength, bytes.byteLength, true);

  let codes: string[] = [];
  let version = item.remoteVersion;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      version?: number;
      codes?: unknown;
    };
    if (Array.isArray(parsed.codes)) {
      codes = parsed.codes.filter((c): c is string => typeof c === 'string');
    }
    if (typeof parsed.version === 'number') version = parsed.version;
  } catch (err) {
    console.error('[sync] recovery codes parse failed:', err);
  }

  await recoveryCodesStore.replaceRecoveryPool(codes, version);
  await recoveryCodesStore.markDownloaded(item.clientId, version);
  emit('content:updated', { kind: 'recovery_codes', ids: [item.clientId] });
  return { enqueued: null, bytes: bytes.byteLength };
}

// Licensee customers: the contact-free list + studio's game -> customer view
// (badges, studio-side reassignments). Version-gated like recovery codes.
async function downloadCustomers(
  item: Extract<WorkItem, { kind: 'customers' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  const bytes = await withRetry(() =>
    apiDownloadBytesStream('playground', 'get_customers', {
      bearer: true,
      signal,
      onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
    })
  );
  emitItemProgress(item.label, item.kind, bytes.byteLength, bytes.byteLength, true);
  // A parse failure throws: the item fails and is retried, the cache is untouched.
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as customersStore.CustomersDownload;
  const version = typeof payload.version === 'number' ? payload.version : item.remoteVersion;
  await customersStore.applyDownload(item.clientId, payload);
  await customersStore.markDownloaded(item.clientId, version);
  return { enqueued: null, bytes: bytes.byteLength };
}

// Mission-report PDF layouts: download the per-game-type set (studio merges the
// client's own overrides over the admin defaults server-side) and cache it
// locally (replaceLayouts). The payload also carries the studio-defined default
// print format - recorded as the fallback for devices whose operator never set
// Settings → Printing. Version-gated; the advertised version bumps on both
// admin and client-side saves.
async function downloadReportLayouts(
  item: Extract<WorkItem, { kind: 'report_layouts' }>,
  signal: AbortSignal,
  source: ContentSource = cloudSource
): Promise<DownloadOutcome> {
  // Unparseable payload -> throw to the pool's failure path (markFailed) so
  // the cached layouts survive, instead of replacing them with an empty set.
  const parsed = await withRetry(() =>
    source.getReportLayouts(signal, (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total))
  );
  const bytes = jsonByteLength(parsed);
  emitItemProgress(item.label, item.kind, bytes, bytes, true);
  let layouts: Record<string, unknown> = {};
  let version = item.remoteVersion;
  if (parsed.layouts && typeof parsed.layouts === 'object') {
    layouts = parsed.layouts as Record<string, unknown>;
  }
  if (typeof parsed.version === 'number') version = parsed.version;
  // {version: 0, layouts: {}} is the server's degraded fallback (a DB error
  // on its side). The manifest advertised a real version, so treat it as a
  // failure and keep the cache - marking it downloaded would pin
  // local_version to 0 and re-trigger this download on every sync.
  if (version <= 0 && item.remoteVersion > 0) {
    throw new Error(
      `report layouts: server returned degraded payload (version ${version}) while manifest advertised v${item.remoteVersion}`
    );
  }
  // A LAN peer can't send the print format (the mother keeps it in browser
  // storage): keep ours until the next cloud sync.
  if (source.kind === 'cloud') setSyncedDefaultPrintPrefs(parsed.print_format ?? null);

  await reportLayoutsStore.replaceLayouts(layouts, version);
  await reportLayoutsStore.markDownloaded(version);
  emit('content:updated', { kind: 'report_layouts', ids: [] });
  return { enqueued: null, bytes };
}

async function downloadPattern(
  item: Extract<WorkItem, { kind: 'pattern' }>,
  signal: AbortSignal,
  source: ContentSource = cloudSource
): Promise<DownloadOutcome> {
  const res: PatternDownloadResponse = await withRetry(() => source.getPattern(item.uniqid, signal));
  let version = item.remoteVersion;
  if (source.kind === 'peer') {
    // Our manifest may predate this pattern: create the row from the mother's.
    await patternStore.insertFromPeerIfMissing(res);
    version = res.version;
  }
  await patternStore.markDownloaded(item.uniqid, version, {
    pattern_slug: res.pattern_slug,
    description: res.description,
    pattern_data: res.pattern_data,
    stations: res.stations ?? null,
  });
  emit('content:updated', { kind: 'patterns', ids: [item.uniqid] });
  return { enqueued: null, bytes: jsonByteLength(res) };
}

// Operator-only media filter: from a scenario's full media filename list, return
// just the visual the launch UI uses as a thumbnail. Mirrors GameList's
// resolution: game_media_images.game_visual → background_image. The "other
// languages" cover (`game_visual_intl`, see utils/coverVisual) is kept along
// with the French default, so the thumbnail still resolves if the licensee's
// language changes between two syncs. The reference in game-data may carry a
// leading `media/`, and the medias[] entries may be nested (e.g.
// `images/foo.png`), so we match on exact path OR basename. Returns [] when no
// visual is defined (the scenario then keeps only game-data.json).
function operatorVisualKeepSet(gameData: unknown, medias: string[]): string[] {
  const mediaImages = (gameData as {
    game_media_images?: Record<string, unknown>;
  } | null)?.game_media_images;
  if (!mediaImages || typeof mediaImages !== 'object' || Array.isArray(mediaImages)) return [];
  const isRef = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  let refs = Object.entries(mediaImages)
    .filter(([field, v]) => (field === 'game_visual' || field.startsWith('game_visual_')) && isRef(v))
    .map(([, v]) => v as string);
  if (refs.length === 0 && isRef(mediaImages.background_image)) refs = [mediaImages.background_image];
  const base = (p: string): string => p.split('/').pop() ?? p;
  const targets = refs.map((raw) => (raw.startsWith('media/') ? raw.slice('media/'.length) : raw));
  const targetBases = new Set(targets.map(base));
  return medias.filter((m) => targets.includes(m) || targetBases.has(base(m)));
}

async function downloadScenarioMeta(
  item: Extract<WorkItem, { kind: 'scenario_meta' }>,
  signal: AbortSignal,
  source: ContentSource = cloudSource
): Promise<DownloadOutcome> {
  const res: ScenarioMetaResponse = await withRetry(() => source.getScenarioMeta(item.uniqid, signal));
  const peer = source.kind === 'peer';
  // A LAN peer's copy is committed at ITS content hash, and in full only when
  // the mother says its copy is complete for its cloud manifest.
  const commitHash = peer ? (res.complete && res.content_hash) || '' : item.remoteContentHash;
  const commitVersion = peer ? (res.version ?? item.remoteVersion) : item.remoteVersion;
  if (peer) {
    // Our manifest may predate this scenario: create the row from the mother's.
    await scenarioStore.insertFromPeerIfMissing({
      uniqid: item.uniqid,
      title: res.title ?? res.scenario?.name ?? item.uniqid,
      game_type: res.game_type ?? res.scenario?.scenario_type ?? 'unknown',
      is_product: Boolean(res.is_product),
      version: res.remote_version ?? commitVersion,
      content_hash: res.remote_content_hash ?? null,
    });
  }

  const files = Array.isArray(res.files) ? res.files : [];
  const dataHash = res.data_hash ?? null;
  // CAS requires the per-file hashes + a data_hash. A studio that predates the
  // hash migration won't supply them - treat as a (retryable) failure rather
  // than silently committing an empty manifest.
  if (!dataHash || files.length === 0) {
    throw new Error(`scenario ${item.uniqid} missing CAS manifest (data_hash/files)`);
  }

  const gameDataEntry =
    files.find((f) => f.rel_path === 'game-data.json') ?? { rel_path: 'game-data.json', hash: dataHash, size: 0 };
  const mediaEntries = files.filter((f) => f.rel_path !== 'game-data.json');

  // The FULL list, before any operator-only filtering: a LAN peer serves this
  // scenario from it, whatever subset this device keeps.
  if (commitHash) {
    await scenarioStore.recordRemoteFiles(item.uniqid, commitHash, [gameDataEntry, ...mediaEntries]);
  }

  // Operator-only: keep only the visual the launch list shows as a thumbnail
  // (game_visual and its language versions → background_image). game-data.json
  // is always kept. Everything else is play-only and skipped to save disk.
  let targetMedia = mediaEntries;
  if (operatorOnly) {
    const keep = new Set(operatorVisualKeepSet(res.game_data, mediaEntries.map((f) => f.rel_path)));
    targetMedia = mediaEntries.filter((f) => keep.has(f.rel_path));
  }

  // game-data.json → blob. NOT hash-verified: data_hash is a change token over
  // the studio source columns, not sha256 of these (compat-transformed) bytes.
  // Skip the write if the blob already exists (dedup across revisions).
  if (!(await blobExists(gameDataEntry.hash))) {
    await writeJson(blobPathRel(gameDataEntry.hash), res.game_data);
  }

  // The manifest committed once all target blobs are present (post-pool sweep,
  // or here when nothing needs downloading).
  const manifest: scenarioStore.ManifestFile[] = [
    { rel_path: 'game-data.json', content_hash: gameDataEntry.hash },
    ...targetMedia.map((f) => ({ rel_path: f.rel_path, content_hash: f.hash })),
  ];

  // Enqueue downloads only for media blobs not already in the pool - the dedup
  // that makes a content change carry just the changed bytes over the network.
  //
  // Cheap files first (non-video, then smallest): the scenario reaches
  // partial readiness - everything but its videos - on the first cycle rather
  // than after the heavy files, and a cycle interrupted mid-video still leaves
  // a launchable scenario behind.
  const ordered = [...targetMedia].sort((a, b) => {
    const av = isVideoFile(a.rel_path) ? 1 : 0;
    const bv = isVideoFile(b.rel_path) ? 1 : 0;
    if (av !== bv) return av - bv;
    return (a.size ?? 0) - (b.size ?? 0);
  });

  const remaining = new Set<string>();
  const failed = new Set<string>();
  const enqueued: WorkItem[] = [];
  for (const f of ordered) {
    if (await blobExists(f.hash)) continue;
    // Not on the mother's disk either (or a video while the mother hosts a
    // running game): nothing to fetch now. Counted as failed so the scenario is
    // still committed launchable if only videos are missing.
    if (f.available === false || (source.deferVideos && isVideoFile(f.rel_path))) {
      failed.add(f.rel_path);
      continue;
    }
    remaining.add(f.rel_path);
    enqueued.push({
      kind: 'scenario_media',
      priority: 5,
      uniqid: item.uniqid,
      filename: f.rel_path,
      hash: f.hash,
      label: `Scenario media: ${f.rel_path}`,
    });
  }

  scenarioProgress.set(item.uniqid, {
    remaining,
    failed,
    manifest,
    remoteContentHash: commitHash,
    remoteVersion: commitVersion,
    commitFull: Boolean(commitHash),
  });

  // The post-pool sweep commits every scenario whose remaining+failed are both
  // empty - including this one when no media needed downloading. No separate
  // immediate-commit path needed.
  return { enqueued: enqueued.length ? enqueued : null, bytes: jsonByteLength(res) };
}

async function downloadScenarioMedia(
  item: Extract<WorkItem, { kind: 'scenario_media' }>,
  signal: AbortSignal,
  source: ContentSource = cloudSource
): Promise<DownloadOutcome> {
  // Download to a temp, verify its SHA-256 against the studio hash, then
  // atomically move it into the pool under that hash. Stream straight to disk -
  // a scenario video can be hundreds of MB and buffering it OOMs the Android
  // WebView heap; the native sha256_file command hashes on disk for the same
  // reason.
  //
  // The temp is STABLE per hash (`{hash}.part`) and survives a failed attempt:
  // the next attempt (or the next cycle, or the next app launch - see
  // pruneOrphanBlobs) resumes it with an HTTP Range request instead of
  // restarting a 200 MB video from byte 0 every time the connection drops.
  // Only a hash mismatch discards it.
  let job = inflightBlobs.get(item.hash);
  if (!job) {
    const tmpRel = blobTmpPathRel(`${item.hash}.part`);
    job = (async () => {
      const tmpAbs = await join(await appDataDir(), tmpRel);
      return withRetry(() => runScenarioMediaAttempt(item, tmpRel, tmpAbs, signal, source));
    })().finally(() => inflightBlobs.delete(item.hash));
    inflightBlobs.set(item.hash, job);
  }
  const total = await job;
  emitItemProgress(item.label, item.kind, total, total, true);

  // Bookkeeping: drop from remaining set; the post-pool sweep commits the
  // scenario's manifest once all its target media succeeded.
  const p = scenarioProgress.get(item.uniqid);
  if (p) p.remaining.delete(item.filename);
  return { enqueued: null, bytes: total };
}

// One download+verify+commit attempt, resuming any partial already on disk.
// Returns the full file size.
async function runScenarioMediaAttempt(
  item: Extract<WorkItem, { kind: 'scenario_media' }>,
  tmpRel: string,
  tmpAbs: string,
  signal: AbortSignal,
  source: ContentSource
): Promise<number> {
  const fetchInto = (sink: (chunk: Uint8Array) => Promise<void>, rangeStart: number) =>
    source.streamScenarioMedia(
      {
        uniqid: item.uniqid,
        filename: item.filename,
        hash: item.hash,
        signal,
        rangeStart,
        onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
      },
      sink
    );

  let have = await fileSize(tmpRel);
  let size = 0;
  if (have > 0) {
    try {
      size = have + (await streamBinaryAppend(tmpRel, (write) => fetchInto(write, have)));
    } catch (err) {
      if (err instanceof RangeIgnoredError) {
        // Server without Range support: nothing was appended, start over below.
        have = 0;
      } else if (err instanceof ApiError && err.status === 416) {
        // Nothing left to fetch: the partial is (claims to be) the whole file,
        // e.g. the app closed between the last byte and the commit. Verify it.
        size = have;
      } else {
        throw err;
      }
    }
  }
  if (have === 0) {
    size = await streamBinary(tmpRel, (write) => fetchInto(write, 0));
  }

  const got = await invoke<string>('sha256_file', { path: tmpAbs });
  if (got !== item.hash) {
    // Corrupt or stale partial: drop it so the retry starts from byte 0.
    await removeRecursive(tmpRel).catch(() => {});
    throw new Error(
      `hash mismatch for ${item.uniqid}/${item.filename}: expected ${item.hash}, got ${got}`
    );
  }
  await commitBlobFromTemp(tmpRel, item.hash);
  return size;
}

async function downloadGameTypeAdminVideo(
  item: Extract<WorkItem, { kind: 'game_type_admin_video' }>,
  signal: AbortSignal,
  source: ContentSource = cloudSource
): Promise<DownloadOutcome> {
  const dirRel = gameTypeAdminVersionDirRel(item.code, item.remoteVersion);
  await ensureDir(dirRel);

  // Video file - stream to disk (can be hundreds of MB; buffering OOMs Android).
  const videoBytesLen = await withRetry(() =>
    streamBinary(`${dirRel}/${item.filename}`, (write) =>
      source.streamGameTypeVideo(
        {
          variant: 'admin',
          code: item.code,
          version: item.remoteVersion,
          filename: item.filename,
          signal,
          onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
        },
        write
      )
    )
  );
  emitItemProgress(item.label, item.kind, videoBytesLen, videoBytesLen, true);

  // Subtitle files (one .vtt per language). Failures are non-fatal - a
  // missing subtitle just means playback runs without that language until the
  // subtitles-only pass of a later cycle fetches it (SUBTITLES_RETRY).
  const subs = await downloadGameTypeSubtitleFiles(
    item.code, 'admin', item.remoteVersion, dirRel, item.subtitleFilenames, signal, source
  );

  await gameTypesStore.markAdminDownloaded(
    item.code,
    item.remoteVersion,
    subs.failed.length === 0 ? item.subtitlesVersion : gameTypesStore.SUBTITLES_RETRY
  );
  emit('content:updated', { kind: 'game_types', ids: [item.code] });
  return { enqueued: null, bytes: videoBytesLen + subs.bytes };
}

async function downloadGameTypeOverrideVideo(
  item: Extract<WorkItem, { kind: 'game_type_override_video' }>,
  signal: AbortSignal,
  source: ContentSource = cloudSource
): Promise<DownloadOutcome> {
  const dirRel = gameTypeClientVersionDirRel(item.code, item.remoteVersion);
  await ensureDir(dirRel);

  const videoBytesLen = await withRetry(() =>
    streamBinary(`${dirRel}/${item.filename}`, (write) =>
      source.streamGameTypeVideo(
        {
          variant: 'client',
          code: item.code,
          version: item.remoteVersion,
          filename: item.filename,
          signal,
          onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
        },
        write
      )
    )
  );
  emitItemProgress(item.label, item.kind, videoBytesLen, videoBytesLen, true);

  const subs = await downloadGameTypeSubtitleFiles(
    item.code, 'client', item.remoteVersion, dirRel, item.subtitleFilenames, signal, source
  );

  await gameTypesStore.markOverrideDownloaded(
    item.code,
    item.remoteVersion,
    subs.failed.length === 0 ? item.subtitlesVersion : gameTypesStore.SUBTITLES_RETRY
  );
  emit('content:updated', { kind: 'game_type_overrides', ids: [item.code] });
  return { enqueued: null, bytes: videoBytesLen + subs.bytes };
}

// Fetch every subtitle track of one tutorial video into `<dirRel>/subtitles/`.
// Never throws on a single track: returns the languages that failed so the
// caller decides (the video download tolerates them, the subtitles-only pass
// reports them). `videoVersion` is the version dir the tracks live in on studio.
async function downloadGameTypeSubtitleFiles(
  code: string,
  variant: 'admin' | 'client',
  videoVersion: number,
  dirRel: string,
  subtitleFilenames: Record<string, string>,
  signal: AbortSignal,
  source: ContentSource = cloudSource
): Promise<{ bytes: number; failed: string[] }> {
  let bytes = 0;
  const failed: string[] = [];
  const entries = Object.entries(subtitleFilenames);
  if (entries.length === 0) return { bytes, failed };
  await ensureDir(`${dirRel}/subtitles`);
  for (const [lang, fname] of entries) {
    try {
      const subBytes = await withRetry(() =>
        source.getGameTypeSubtitle({ variant, code, version: videoVersion, lang, filename: fname, signal })
      );
      await writeBinary(`${dirRel}/subtitles/${fname}`, subBytes);
      bytes += subBytes.byteLength;
    } catch (err) {
      console.warn(`[sync] ${variant} subtitle ${code}/${lang} failed:`, err);
      failed.push(lang);
    }
  }
  return { bytes, failed };
}

// Subtitle-only refresh: the video is already on disk at `videoVersion`, studio
// changed just the tracks. A removed track needs no cleanup here - playback
// only offers the languages the manifest still lists.
async function downloadGameTypeSubtitlesOnly(
  item: Extract<WorkItem, { kind: 'game_type_admin_subtitles' | 'game_type_override_subtitles' }>,
  signal: AbortSignal,
  source: ContentSource = cloudSource
): Promise<DownloadOutcome> {
  const isAdmin = item.kind === 'game_type_admin_subtitles';
  const dirRel = isAdmin
    ? gameTypeAdminVersionDirRel(item.code, item.videoVersion)
    : gameTypeClientVersionDirRel(item.code, item.videoVersion);
  const subs = await downloadGameTypeSubtitleFiles(
    item.code, isAdmin ? 'admin' : 'client', item.videoVersion, dirRel, item.subtitleFilenames, signal, source
  );
  if (subs.failed.length > 0) {
    throw new Error(`subtitles ${item.code}: failed for ${subs.failed.join(', ')}`);
  }
  if (isAdmin) {
    await gameTypesStore.markAdminSubtitlesDownloaded(item.code, item.subtitlesVersion);
    emit('content:updated', { kind: 'game_types', ids: [item.code] });
  } else {
    await gameTypesStore.markOverrideSubtitlesDownloaded(item.code, item.subtitlesVersion);
    emit('content:updated', { kind: 'game_type_overrides', ids: [item.code] });
  }
  return { enqueued: null, bytes: subs.bytes };
}

// Retry helper now lives in services/apiRetry.ts and is shared with the
// launched-games service.
