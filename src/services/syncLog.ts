// Per-cycle live log for the Settings → Sync screen.
//
// Why module-level: the sync screen is mounted only while the user has
// Settings → Sync open. A cycle is independent of mount state; if the cycle
// completes while the user is on another tab, we still want to show the
// final activity when they come back. Keeping the buffer here (with a tiny
// pub/sub) decouples lifecycle.
//
// Per-cycle semantics: the buffer is wiped on cycle:started so the user
// always sees a fresh log for the current cycle. The previous cycle's
// snapshot remains visible until the next cycle starts.

import { on } from './syncEvents';
import type {
  CyclePhase,
  CycleStartedPayload,
  CycleFailureDetail,
  WorkItemKind,
} from './syncEvents';

export type PhaseStatus = 'pending' | 'active' | 'done' | 'skipped';

export interface LogEntry {
  id: string;
  at: number;
  status: 'completed' | 'failed';
  itemKind: WorkItemKind;
  label: string;
  bytes: number;
  groupKey?: string;
}

export interface InFlightItem {
  key: string;
  label: string;
  itemKind: WorkItemKind;
  loaded: number;
  total: number | null;
}

export interface SyncLogSnapshot {
  trigger: CycleStartedPayload['trigger'] | null;
  startedAt: string | null;
  finishedAt: string | null;
  // Final phase state of the cycle (or in-progress for an active cycle).
  // Used by the 3-step phase indicator.
  phase: Record<CyclePhase, PhaseStatus>;
  // Most-recently-processed item label, for the inline progress caption.
  currentLabel: string | null;
  // All work items processed this cycle, in arrival order. Unbounded by
  // design — the buffer naturally resets at the next cycle start.
  entries: LogEntry[];
  totalBytes: number;
  // Counts mirrored from cycle:progress so subscribers don't have to listen
  // to two streams just to render a single header line.
  counters: { total: number; completed: number; failed: number };
  // Populated by the orchestrator's enriched catch block. Cleared on the
  // next cycle:started.
  failure: CycleFailureDetail | null;
  // Set when a cycle ended because the JWT was rejected mid-download.
  // Distinct from `failure` because the user-facing message is "we're
  // refreshing your credentials, no action needed" rather than the red
  // error box. Cleared on the next cycle:started.
  interrupted: { kind: 'auth_refresh'; at: string } | null;
  // Per-binary-item streaming progress. Keyed by the item label so the UI
  // can show "Downloading foo.png — 8.2 / 12.3 KB (67%)" while a download
  // is in flight. Entries are added on the first chunk, updated per chunk,
  // and removed on done. Multiple entries coexist when the worker pool has
  // multiple parallel downloads.
  inFlight: Record<string, InFlightItem>;
}

let snapshot: SyncLogSnapshot = freshSnapshot();
const listeners = new Set<() => void>();

function freshSnapshot(): SyncLogSnapshot {
  return {
    trigger: null,
    startedAt: null,
    finishedAt: null,
    phase: { push_pending: 'pending', manifest: 'pending', download: 'pending' },
    currentLabel: null,
    entries: [],
    totalBytes: 0,
    counters: { total: 0, completed: 0, failed: 0 },
    failure: null,
    interrupted: null,
    inFlight: {},
  };
}

function notify() {
  for (const fn of listeners) fn();
}

export function getSnapshot(): SyncLogSnapshot {
  return snapshot;
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Wire up event listeners once at module load. The orchestrator emits these
// events regardless of whether anyone is subscribed, so this is cheap.

on('cycle:started', (p) => {
  snapshot = {
    ...freshSnapshot(),
    trigger: p.trigger,
    startedAt: p.startedAt,
  };
  notify();
});

on('cycle:phase', (p) => {
  // 'started' marks the phase as currently in-flight; 'finished' freezes it
  // as done; 'skipped' is rendered as a faint inactive segment.
  const status: PhaseStatus =
    p.status === 'started' ? 'active' : p.status === 'finished' ? 'done' : 'skipped';
  snapshot = {
    ...snapshot,
    phase: { ...snapshot.phase, [p.phase]: status },
  };
  notify();
});

on('cycle:progress', (p) => {
  const next: SyncLogSnapshot = {
    ...snapshot,
    counters: { total: p.total, completed: p.completed, failed: p.failed },
  };

  if (p.currentLabel) next.currentLabel = p.currentLabel;

  // We use the (completed + failed) tally vs. the previous tally to decide
  // whether this emission represents a NEW item finishing (vs. a re-emit on
  // the same step). Status is inferred from which counter advanced.
  const prevDone = snapshot.counters.completed + snapshot.counters.failed;
  const nextDone = p.completed + p.failed;
  if (p.currentLabel && p.itemKind && nextDone > prevDone) {
    const status: LogEntry['status'] =
      p.failed > snapshot.counters.failed ? 'failed' : 'completed';
    const bytes = p.byteLength ?? 0;
    next.entries = [
      ...snapshot.entries,
      {
        id: `${snapshot.entries.length}-${p.currentLabel}`,
        at: Date.now(),
        status,
        itemKind: p.itemKind,
        label: p.currentLabel,
        bytes,
        groupKey: p.groupKey,
      },
    ];
    next.totalBytes = snapshot.totalBytes + bytes;
  }

  snapshot = next;
  notify();
});

on('cycle:item_progress', (p) => {
  const nextInFlight = { ...snapshot.inFlight };
  if (p.done) {
    delete nextInFlight[p.key];
  } else {
    nextInFlight[p.key] = {
      key: p.key,
      label: p.label,
      itemKind: p.itemKind,
      loaded: p.loaded,
      total: p.total,
    };
  }
  snapshot = { ...snapshot, inFlight: nextInFlight };
  notify();
});

on('cycle:finished', (p) => {
  snapshot = {
    ...snapshot,
    finishedAt: p.finishedAt,
    currentLabel: null,
    inFlight: {},
  };
  notify();
});

on('cycle:failed', (p) => {
  const now = new Date().toISOString();
  // auth_invalid is special: it isn't really a "failure" the user needs to
  // see a red box for — AuthProvider transparently refreshes the JWT and
  // the next cycle picks up the remaining work. We mark this as
  // `interrupted` so the UI can render a calmer "credentials are
  // refreshing" affordance and still surface the partial counts.
  if (p.reason === 'auth_invalid') {
    snapshot = {
      ...snapshot,
      finishedAt: now,
      currentLabel: null,
      interrupted: { kind: 'auth_refresh', at: now },
      inFlight: {},
    };
  } else {
    snapshot = {
      ...snapshot,
      finishedAt: now,
      currentLabel: null,
      failure: p.detail ?? null,
      inFlight: {},
    };
  }
  notify();
});

// ---------- formatting helpers (used by the UI) ----------

export function formatBytes(n: number): string {
  if (n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function triggerLabel(t: CycleStartedPayload['trigger'] | null): string {
  switch (t) {
    case 'startup':
      return 'app launch';
    case 'foreground':
      return 'app foreground';
    case 'network_up':
      return 'network reconnected';
    case 'timer':
      return 'periodic check';
    case 'manual':
      return 'manual';
    default:
      return 'unknown';
  }
}
