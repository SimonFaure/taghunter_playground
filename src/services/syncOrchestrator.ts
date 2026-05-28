// Content sync orchestrator. Single module-level singleton.
//
// Responsibilities (per slice 2 plan):
//   - Trigger cycles: startup, foreground (>=5min), network-up, 30-min timer,
//     manual. All debounced — at most one cycle in flight; subsequent triggers
//     within 60s of the last cycle start are dropped.
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

import { ApiError, apiCall, apiDownloadBytesStream } from './api';
import { withRetry } from './apiRetry';
import { AuthUser } from './authStore';
import {
  ensureDir,
  scenarioVersionDirRel,
  onDemandCardsFileRel,
  teamNamesFileRel,
  writeJson,
  writeBinary,
  writeText,
} from './contentFs';
import * as scenarioStore from './scenarioStore';
import * as patternStore from './patternStore';
import * as layoutStore from './layoutStore';
import * as cardsStore from './cardsStore';
import * as namePoolsStore from './namePoolsStore';
import * as recoveryCodesStore from './recoveryCodesStore';
import * as translationsStore from './translationsStore';
import * as gameTypesStore from './gameTypesStore';
import * as clientPreferencesStore from './clientPreferencesStore';
import {
  gameTypeAdminVersionDirRel,
  gameTypeClientVersionDirRel,
} from './contentFs';
import { startConnectivityMonitor, onConnectivityChange, isOnline } from './connectivity';
import { emit } from './syncEvents';
import type { CyclePhase, CycleFailureDetail } from './syncEvents';
import { getDb } from './db';

// ---------- tunables ----------

const DEBOUNCE_MS = 60_000;
const TIMER_MS = 30 * 60 * 1000;
const FOREGROUND_THRESHOLD_MS = 5 * 60 * 1000;
const POOL_SIZE = 3;
// Defense-in-depth wall-clock cap on a single cycle. Per-request timeouts in
// api.ts should already bound every call; this is the backstop guaranteeing
// runCycle() always terminates even if a future path forgets a timeout.
const CYCLE_HARD_CAP_MS = 10 * 60 * 1000;

// ---------- types ----------

export type Trigger = 'startup' | 'foreground' | 'network_up' | 'timer' | 'manual';

interface ManifestResponse {
  custom_scenarios: Array<{ uniqid: string; title: string; version: number; game_type: string }>;
  product_scenarios: Array<{ uniqid: string; title: string; version: number; game_type: string }>;
  default_patterns: Array<{ pattern_uniqid: string; name: string; version: number; game_type: string }>;
  custom_patterns: Array<{ pattern_uniqid: string; name: string; version: number; game_type: string }>;
  cards_version: number | null;
  has_on_demand_cards: boolean;
  team_names_version?: number;
  recovery_codes_version?: number;
  layouts: Array<{ id: number; version: number; game_type: string }>;
  translations?: Array<{ key: string; value: unknown; version: number }>;
  game_types?: gameTypesStore.GameTypeManifestRow[];
  client_game_type_overrides?: gameTypesStore.GameTypeOverrideManifestRow[];
  client_preferences?: clientPreferencesStore.ClientPreferences;
}

interface ScenarioMetaResponse {
  scenario: { uniqid: string; name: string; scenario_type: string };
  game_data: unknown;
  medias: string[] | null;
}

interface PatternDownloadResponse {
  pattern_uniqid: string;
  pattern_slug: string | null;
  description: string | null;
  pattern_data: unknown;
  version: number;
}

type WorkItem =
  | { kind: 'cards'; priority: 1; clientId: number; remoteVersion: number; label: string }
  | { kind: 'on_demand'; priority: 1; clientId: number; label: string }
  | { kind: 'team_names'; priority: 1; clientId: number; remoteVersion: number; label: string }
  | { kind: 'recovery_codes'; priority: 1; clientId: number; remoteVersion: number; label: string }
  | { kind: 'pattern'; priority: 2; uniqid: string; remoteVersion: number; label: string }
  | { kind: 'layout'; priority: 3; id: number; remoteVersion: number; label: string }
  | { kind: 'scenario_meta'; priority: 4; uniqid: string; remoteVersion: number; label: string }
  | { kind: 'scenario_media'; priority: 5; uniqid: string; remoteVersion: number; filename: string; label: string }
  | { kind: 'game_type_admin_video'; priority: 6; code: string; remoteVersion: number; filename: string; subtitleFilenames: Record<string, string>; label: string }
  | { kind: 'game_type_override_video'; priority: 6; code: string; remoteVersion: number; filename: string; subtitleFilenames: Record<string, string>; label: string };

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
let lastVisibleAtMs = Date.now();

// Per-cycle scratch — used by the catch block to attach diagnostic context to
// cycle:failed events. Reset at the top of every cycle. Mirrors what the UI
// would otherwise have to track itself by listening to events.
let currentTrigger: Trigger | null = null;
let currentPhase: CyclePhase | null = null;
let lastCurrentLabel: string | null = null;

// Per-scenario bookkeeping inside a cycle. Cleared between cycles.
const scenarioProgress = new Map<string, { remaining: Set<string>; failed: Set<string> }>();

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

export async function start(authUser: AuthUser): Promise<void> {
  if (started) {
    currentUser = authUser;
    return;
  }
  started = true;
  currentUser = authUser;
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

  // Initial cycle.
  void fireTrigger('startup');
}

export function stop(): void {
  if (!started) return;
  started = false;
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
  if (cycleAbort) {
    cycleAbort.abort();
    cycleAbort = null;
  }
  cycleInFlight = false;
  currentUser = null;
}

export async function runCycleNow(trigger: Trigger = 'manual'): Promise<void> {
  await fireTrigger(trigger, { force: trigger === 'manual' });
}

// ---------- trigger gate (debounce) ----------

async function fireTrigger(trigger: Trigger, opts: { force?: boolean } = {}): Promise<void> {
  if (!started || !currentUser) return;
  if (cycleInFlight) return;
  if (
    !opts.force &&
    lastCycleStartedAtMs !== null &&
    Date.now() - lastCycleStartedAtMs < DEBOUNCE_MS
  ) {
    return;
  }
  await runCycle(trigger);
}

// ---------- cycle ----------

async function runCycle(trigger: Trigger): Promise<void> {
  if (!currentUser) return;
  cycleInFlight = true;
  lastCycleStartedAtMs = Date.now();
  cycleAbort = new AbortController();
  scenarioProgress.clear();

  // Hard cap (see CYCLE_HARD_CAP_MS). Firing aborts the cycle: the pool stops
  // dispatch, Promise.all resolves, and the cycle ends as a recoverable
  // failure rather than hanging. Cleared in the finally block below.
  const thisCycleAbort = cycleAbort;
  const hardCap = setTimeout(() => {
    console.warn('[syncOrchestrator] cycle exceeded hard cap, aborting');
    thisCycleAbort.abort();
  }, CYCLE_HARD_CAP_MS);

  const startedAtIso = new Date().toISOString();
  currentTrigger = trigger;
  currentPhase = null;
  lastCurrentLabel = null;
  emit('cycle:started', { trigger, startedAt: startedAtIso });

  let total = 0;
  let completed = 0;
  let failed = 0;

  // The terminal event (cycle:finished / cycle:failed) is captured here and
  // fired from the finally block — AFTER cycleInFlight is cleared — so a
  // listener that calls getState() inside its handler sees the orchestrator
  // already idle. Emitting it inline (while still inside this try) left
  // cycleInFlight=true at notification time, which froze the UI's "Syncing…".
  let emitTerminal: (() => void) | null = null;

  try {
    // Phase 1: push pending local mutations (uploads).
    // Pre-checked so we emit 'skipped' for the common no-op case, instead of
    // a started→finished pair for zero work.
    currentPhase = 'push_pending';
    const hasPending = await cardsStore.hasPendingMutations();
    if (hasPending) {
      emit('cycle:phase', { phase: 'push_pending', status: 'started' });
      try {
        await cardsStore.pushPendingMutations();
      } catch (err) {
        // Auth failures bubble up — same as any other phase.
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
    emit('cycle:phase', { phase: 'manifest', status: 'started' });
    const work = await fetchManifestAndApply(cycleAbort.signal);
    total = work.length;
    emit('cycle:progress', { total, completed: 0, failed: 0 });
    emit('cycle:phase', { phase: 'manifest', status: 'finished' });

    // Phase 3: download pool.
    currentPhase = 'download';
    emit('cycle:phase', { phase: 'download', status: 'started' });
    const result = await runDownloadPool(work, cycleAbort.signal);
    // Pull counts BEFORE checking for auth error. The pool returns partial
    // progress on auth failure (used to throw, which discarded the counts
    // and skipped the post-pool sweep). This keeps lastCycleStats accurate
    // — "1 of 12 downloaded" rather than the stale "0 of 3" the catch
    // block used to record.
    completed = result.completed;
    failed = result.failed;
    total = result.total;
    emit('cycle:phase', { phase: 'download', status: 'finished' });
    if (result.authError) {
      throw result.authError;
    }

    lastCycleStats = { total, completed, failed };
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
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      emitTerminal = () => emit('cycle:failed', { reason: 'auth_invalid', recoverable: false });
    } else {
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
    clearTimeout(hardCap);
    cycleInFlight = false;
    cycleAbort = null;
    currentPhase = null;
    currentTrigger = null;
    // Orchestrator is idle again — now fire the terminal event so any
    // getState() call inside a listener observes the consistent idle state.
    emitTerminal?.();
  }
}

// Build a serializable diagnostic snapshot for cycle:failed. The catch block
// receives an arbitrary thrown value (Error subclass, string, plain object,
// undefined — anything). We normalize to strings so the UI can render and
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

async function fetchManifestAndApply(signal: AbortSignal): Promise<WorkItem[]> {
  if (!currentUser) throw new Error('orchestrator: no current user');
  const clientId = currentUser.client_id;

  // NOTE: push_pending lives in runCycle (its own phase) — by the time we
  // get here, any outgoing card mutations have been pushed and studio's
  // cards_version reflects this device's writes.

  // apiCall applies a default 30s per-request timeout internally (see
  // api.ts DEFAULT_REQUEST_TIMEOUT_MS) — pass only the cycle abort signal.
  const manifest = await withRetry(() =>
    apiCall<ManifestResponse>('playground', 'get_user_data_update', {
      method: 'GET',
      bearer: true,
      signal,
    })
  );

  const seenAt = new Date().toISOString();
  // db handle was used here for an explicit BEGIN/COMMIT transaction. That
  // pattern is unsafe with tauri-plugin-sql v2: the plugin's only API is
  // `execute(sql)` running on a sqlx::Pool, which acquires a fresh
  // connection per call. A `BEGIN` executed on connection A is invisible to
  // subsequent statements that get connection B, and the BEGIN'd connection
  // is returned to the pool with an open transaction — surfacing later as
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
    ...manifest.custom_scenarios.map((s) => ({ ...s, is_product: false })),
    ...manifest.product_scenarios.map((s) => ({ ...s, is_product: true })),
  ];
  await scenarioStore.upsertFromManifest(allScenarioRows, seenAt);
  const removedScenarios = await scenarioStore.tombstoneMissing(allScenarioRows.map((s) => s.uniqid));
  if (removedScenarios.length) {
    emit('content:updated', { kind: 'scenarios', ids: [], removed: removedScenarios });
  }

  // Patterns: default + custom.
  const allPatternRows = [
    ...manifest.default_patterns.map((p) => ({ ...p, is_default: true })),
    ...manifest.custom_patterns.map((p) => ({ ...p, is_default: false })),
  ];
  await patternStore.upsertFromManifest(allPatternRows, seenAt);
  const removedPatterns = await patternStore.tombstoneMissing(allPatternRows.map((p) => p.pattern_uniqid));
  if (removedPatterns.length) {
    emit('content:updated', { kind: 'patterns', ids: [], removed: removedPatterns });
  }

  // Layouts are NO LONGER synced. They were only ever consumed by tagquest's
  // HUD positioning, which now falls back to its bundled default layout; tracks
  // places its elements via game_meta.checkpoints[].position (synced with the
  // scenario), and mystery doesn't use layouts. Skipping the manifest apply +
  // download keeps the cycle lean. (manifest.layouts is intentionally ignored.)

  // Global admin translations (inline JSON, no separate download pool).
  await translationsStore.upsertFromManifest(manifest.translations ?? [], seenAt);
  await translationsStore.tombstoneMissing(translationsStore.KNOWN_TRANSLATION_KEYS);

  // Game types (admin defaults + per-client overrides). Inline manifest +
  // separate video/subtitle downloads queued via the same pool.
  const gameTypes = manifest.game_types ?? [];
  await gameTypesStore.upsertGameTypesFromManifest(gameTypes);
  await gameTypesStore.tombstoneMissingGameTypes(gameTypes.map((g) => g.code));
  const overrides = manifest.client_game_type_overrides ?? [];
  await gameTypesStore.upsertOverridesFromManifest(overrides);
  await gameTypesStore.tombstoneMissingOverrides(overrides.map((o) => o.game_type_code));

  // Client preferences (inline JSON only — no version, just last-write-wins).
  await clientPreferencesStore.setFromManifest(clientId, manifest.client_preferences ?? {});

  // Cards (single-row state).
  await cardsStore.upsertFromManifest(clientId, {
    cards_version: manifest.cards_version,
    has_on_demand_cards: manifest.has_on_demand_cards,
  });

  // Team-name pools (single-row state, incremental version compare).
  await namePoolsStore.upsertFromManifest(clientId, {
    team_names_version: manifest.team_names_version ?? null,
  });

  // Offline PIN-recovery codes (single-row state, incremental version compare).
  await recoveryCodesStore.upsertFromManifest(clientId, {
    recovery_codes_version: manifest.recovery_codes_version ?? null,
  });

  // Build the work list from each store's pending-downloads view.
  const work: WorkItem[] = [];

  if (await cardsStore.needsCardsDownload(clientId)) {
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
  if (manifest.has_on_demand_cards) {
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
  if (await recoveryCodesStore.needsRecoveryCodesDownload(clientId)) {
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

  for (const p of await patternStore.listPendingDownloads()) {
    work.push({
      kind: 'pattern',
      priority: 2,
      uniqid: p.pattern_uniqid,
      remoteVersion: p.remote_version,
      label: `Pattern: ${p.name}`,
    });
  }
  // Layouts intentionally not enqueued — see the manifest-apply note above.
  for (const s of await scenarioStore.listPendingDownloads()) {
    work.push({
      kind: 'scenario_meta',
      priority: 4,
      uniqid: s.uniqid,
      remoteVersion: s.remote_version,
      label: `Scenario: ${s.title}`,
    });
  }

  for (const g of await gameTypesStore.listPendingAdminDownloads()) {
    if (!g.tutorial_video_filename) continue;
    work.push({
      kind: 'game_type_admin_video',
      priority: 6,
      code: g.code,
      remoteVersion: g.remote_version,
      filename: g.tutorial_video_filename,
      subtitleFilenames: g.tutorial_subtitles,
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
      label: `Tutorial override (${o.game_type_code})`,
    });
  }

  // Stable priority sort.
  work.sort((a, b) => a.priority - b.priority);
  return work;
}

// ---------- download pool ----------

async function runDownloadPool(
  initial: WorkItem[],
  signal: AbortSignal
): Promise<{ completed: number; failed: number; total: number; authError: ApiError | null }> {
  // Dynamic queue — scenario_meta tasks enqueue scenario_media items mid-cycle.
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

  const workers = Array.from({ length: POOL_SIZE }, async () => {
    while (queue.length > 0) {
      if (signal.aborted) return;
      if (authInvalid) return;
      const item = queue.shift();
      if (!item) return;
      lastCurrentLabel = item.label;
      try {
        const { enqueued, bytes } = await downloadOne(item, signal);
        if (enqueued && enqueued.length) {
          queue.push(...enqueued);
          total += enqueued.length;
        }
        completed += 1;
        emit('cycle:progress', {
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
        // failure path below so the rest of the work — scenarios the client
        // *can* access — still downloads, and so it does not trigger a
        // spurious auth refresh.
        if (err instanceof ApiError && err.status === 401) {
          authInvalid = true;
          authError = err;
          return;
        }
        failed += 1;
        emit('cycle:progress', {
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
        await markFailed(item).catch(() => {});
      }
    }
  });

  await Promise.all(workers);

  // Mark scenarios that have completed all their media items. We run this
  // sweep UNCONDITIONALLY — even when an auth_invalid bubbled up — so any
  // scenario whose media all completed before the auth blip still gets
  // committed. Without this, an auth-interrupted cycle leaves the DB at
  // 0-downloaded even though bytes are already on disk.
  for (const [uniqid, progress] of scenarioProgress) {
    if (progress.remaining.size === 0 && progress.failed.size === 0) {
      const row = await scenarioStore.get(uniqid);
      if (row) {
        await scenarioStore.markDownloaded(uniqid, row.remote_version);
        emit('content:updated', { kind: 'scenarios', ids: [uniqid] });
      }
    } else if (progress.failed.size > 0) {
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
  emit('cycle:item_progress', {
    key: label,
    label,
    itemKind,
    loaded,
    total,
    done,
  });
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

async function markFailed(item: WorkItem): Promise<void> {
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
    case 'pattern':
      await patternStore.incrementFailedAttempts(item.uniqid);
      break;
    case 'layout':
      await layoutStore.incrementFailedAttempts(item.id);
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
      await gameTypesStore.incrementAdminFailedAttempts(item.code);
      break;
    case 'game_type_override_video':
      await gameTypesStore.incrementOverrideFailedAttempts(item.code);
      break;
  }
}

// Returns work items to enqueue (only scenario_meta produces non-empty —
// it discovers media files to fetch). `bytes` is a best-effort size of the
// payload that was just downloaded (binary length for media, JSON byte
// length for API responses, 0 when not measurable). The pool aggregates
// it into the cycle-wide total shown in the sync UI.
type DownloadOutcome = { enqueued: WorkItem[] | null; bytes: number };

async function downloadOne(item: WorkItem, signal: AbortSignal): Promise<DownloadOutcome> {
  switch (item.kind) {
    case 'cards':
      return downloadCards(item, signal);
    case 'on_demand':
      return downloadOnDemand(item, signal);
    case 'team_names':
      return downloadTeamNames(item, signal);
    case 'recovery_codes':
      return downloadRecoveryCodes(item, signal);
    case 'pattern':
      return downloadPattern(item, signal);
    case 'layout':
      return downloadLayout(item, signal);
    case 'scenario_meta':
      return downloadScenarioMeta(item, signal);
    case 'scenario_media':
      return downloadScenarioMedia(item, signal);
    case 'game_type_admin_video':
      return downloadGameTypeAdminVideo(item, signal);
    case 'game_type_override_video':
      return downloadGameTypeOverrideVideo(item, signal);
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
  signal: AbortSignal
): Promise<DownloadOutcome> {
  const bytes = await withRetry(() =>
    apiDownloadBytesStream('playground', 'get_team_names', {
      bearer: true,
      signal,
      onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
    })
  );
  emitItemProgress(item.label, item.kind, bytes.byteLength, bytes.byteLength, true);
  await ensureDir('media/name_pools');
  await writeText(teamNamesFileRel(), new TextDecoder().decode(bytes));
  await namePoolsStore.markDownloaded(item.clientId, item.remoteVersion);
  emit('content:updated', { kind: 'team_names', ids: [item.clientId] });
  return { enqueued: null, bytes: bytes.byteLength };
}

// Offline PIN-recovery codes: download the client's plaintext pool and hash it
// into the local recovery_codes table (replaceRecoveryPool resets used flags).
// Version-gated like team names — only runs when the admin regenerated. Unlike
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

async function downloadPattern(
  item: Extract<WorkItem, { kind: 'pattern' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  const res = await withRetry(() =>
    apiCall<PatternDownloadResponse>('playground', 'download_pattern', {
      method: 'GET',
      bearer: true,
      query: { pattern_uniqid: item.uniqid },
      signal,
    })
  );
  await patternStore.markDownloaded(item.uniqid, item.remoteVersion, {
    pattern_slug: res.pattern_slug,
    description: res.description,
    pattern_data: res.pattern_data,
  });
  emit('content:updated', { kind: 'patterns', ids: [item.uniqid] });
  return { enqueued: null, bytes: jsonByteLength(res) };
}

async function downloadLayout(
  item: Extract<WorkItem, { kind: 'layout' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  // download_layout returns JSON via header()+echo, no auth_state wrap.
  // apiCall handles JSON parsing fine; the lack of an auth_state field just
  // means no implicit auth_user refresh happens for this response.
  const res = await withRetry(() =>
    apiCall<{ id: number; layout_data: unknown; game_type: string; version: number }>(
      'playground',
      'download_layout',
      {
        method: 'GET',
        bearer: true,
        query: { layout_id: item.id },
        signal,
      }
    )
  );
  await layoutStore.markDownloaded(item.id, item.remoteVersion, res.layout_data);
  emit('content:updated', { kind: 'layouts', ids: [item.id] });
  return { enqueued: null, bytes: jsonByteLength(res) };
}

async function downloadScenarioMeta(
  item: Extract<WorkItem, { kind: 'scenario_meta' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  const res = await withRetry(() =>
    apiCall<ScenarioMetaResponse>('playground', 'get_scenario_game_data', {
      method: 'GET',
      bearer: true,
      query: { uniqid: item.uniqid },
      signal,
    })
  );
  // Write game-data.json to the new version dir.
  const dirRel = scenarioVersionDirRel(item.uniqid, item.remoteVersion);
  await ensureDir(dirRel);
  await writeJson(`${dirRel}/game-data.json`, res.game_data);

  const medias = Array.isArray(res.medias) ? res.medias : [];
  const remaining = new Set(medias);
  scenarioProgress.set(item.uniqid, { remaining, failed: new Set() });

  const bytes = jsonByteLength(res);

  // No media → mark immediately.
  if (medias.length === 0) {
    await scenarioStore.markDownloaded(item.uniqid, item.remoteVersion);
    emit('content:updated', { kind: 'scenarios', ids: [item.uniqid] });
    return { enqueued: null, bytes };
  }

  // Enqueue one work item per media file.
  const enqueued: WorkItem[] = medias.map((filename) => ({
    kind: 'scenario_media',
    priority: 5,
    uniqid: item.uniqid,
    remoteVersion: item.remoteVersion,
    filename,
    label: `Scenario media: ${filename}`,
  }));
  return { enqueued, bytes };
}

async function downloadScenarioMedia(
  item: Extract<WorkItem, { kind: 'scenario_media' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  const bytes = await withRetry(() =>
    apiDownloadBytesStream('playground', 'get_media', {
      bearer: true,
      query: { uniqid: item.uniqid, filename: item.filename },
      signal,
      onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
    })
  );
  emitItemProgress(item.label, item.kind, bytes.byteLength, bytes.byteLength, true);
  const dirRel = scenarioVersionDirRel(item.uniqid, item.remoteVersion);
  // The media filename can be a nested path like 'images/foo.png'; ensureDir
  // is called on the immediate parent only.
  const slash = item.filename.lastIndexOf('/');
  if (slash > 0) {
    await ensureDir(`${dirRel}/${item.filename.slice(0, slash)}`);
  } else {
    await ensureDir(dirRel);
  }
  await writeBinary(`${dirRel}/${item.filename}`, bytes);

  // Bookkeeping: drop from remaining set; the post-pool sweep marks the
  // scenario downloaded once all media for it succeeded.
  const p = scenarioProgress.get(item.uniqid);
  if (p) p.remaining.delete(item.filename);
  return { enqueued: null, bytes: bytes.byteLength };
}

async function downloadGameTypeAdminVideo(
  item: Extract<WorkItem, { kind: 'game_type_admin_video' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  const dirRel = gameTypeAdminVersionDirRel(item.code, item.remoteVersion);
  await ensureDir(dirRel);

  // Video file.
  const videoBytes = await withRetry(() =>
    apiDownloadBytesStream('playground', 'get_game_type_media', {
      bearer: true,
      query: {
        code: item.code,
        variant: 'admin',
        version: String(item.remoteVersion),
        filename: item.filename,
      },
      signal,
      onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
    })
  );
  emitItemProgress(item.label, item.kind, videoBytes.byteLength, videoBytes.byteLength, true);
  await writeBinary(`${dirRel}/${item.filename}`, videoBytes);

  let totalBytes = videoBytes.byteLength;

  // Subtitle files (one .vtt per language). Failures are non-fatal — a
  // missing subtitle just means playback runs without that language.
  if (Object.keys(item.subtitleFilenames).length > 0) {
    await ensureDir(`${dirRel}/subtitles`);
    for (const [lang, fname] of Object.entries(item.subtitleFilenames)) {
      try {
        const subBytes = await withRetry(() =>
          apiDownloadBytesStream('playground', 'get_game_type_media', {
            bearer: true,
            query: {
              code: item.code,
              variant: 'admin',
              version: String(item.remoteVersion),
              subtitle_lang: lang,
            },
            signal,
          })
        );
        await writeBinary(`${dirRel}/subtitles/${fname}`, subBytes);
        totalBytes += subBytes.byteLength;
      } catch (err) {
        console.warn(`[sync] subtitle ${item.code}/${lang} failed:`, err);
      }
    }
  }

  await gameTypesStore.markAdminDownloaded(item.code, item.remoteVersion);
  emit('content:updated', { kind: 'game_types', ids: [item.code] });
  return { enqueued: null, bytes: totalBytes };
}

async function downloadGameTypeOverrideVideo(
  item: Extract<WorkItem, { kind: 'game_type_override_video' }>,
  signal: AbortSignal
): Promise<DownloadOutcome> {
  const dirRel = gameTypeClientVersionDirRel(item.code, item.remoteVersion);
  await ensureDir(dirRel);

  const videoBytes = await withRetry(() =>
    apiDownloadBytesStream('playground', 'get_game_type_media', {
      bearer: true,
      query: {
        code: item.code,
        variant: 'client',
        version: String(item.remoteVersion),
        filename: item.filename,
      },
      signal,
      onProgress: (p) => emitItemProgress(item.label, item.kind, p.loaded, p.total),
    })
  );
  emitItemProgress(item.label, item.kind, videoBytes.byteLength, videoBytes.byteLength, true);
  await writeBinary(`${dirRel}/${item.filename}`, videoBytes);

  let totalBytes = videoBytes.byteLength;

  if (Object.keys(item.subtitleFilenames).length > 0) {
    await ensureDir(`${dirRel}/subtitles`);
    for (const [lang, fname] of Object.entries(item.subtitleFilenames)) {
      try {
        const subBytes = await withRetry(() =>
          apiDownloadBytesStream('playground', 'get_game_type_media', {
            bearer: true,
            query: {
              code: item.code,
              variant: 'client',
              version: String(item.remoteVersion),
              subtitle_lang: lang,
            },
            signal,
          })
        );
        await writeBinary(`${dirRel}/subtitles/${fname}`, subBytes);
        totalBytes += subBytes.byteLength;
      } catch (err) {
        console.warn(`[sync] override subtitle ${item.code}/${lang} failed:`, err);
      }
    }
  }

  await gameTypesStore.markOverrideDownloaded(item.code, item.remoteVersion);
  emit('content:updated', { kind: 'game_type_overrides', ids: [item.code] });
  return { enqueued: null, bytes: totalBytes };
}

// Retry helper now lives in services/apiRetry.ts and is shared with the
// launched-games service.
