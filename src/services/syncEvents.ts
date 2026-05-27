// Tiny TS event bus for the content-sync slice.
//
// Subscribers (FirstLaunchProgress, SyncStatusPill, SyncFailureBanner,
// content-backed pages) call `on(event, cb)` to react to orchestrator state.
// The orchestrator and stores call `emit(event, payload)`.

export type ContentKind =
  | 'scenarios'
  | 'patterns'
  | 'layouts'
  | 'cards'
  | 'on_demand_cards'
  | 'team_names'
  | 'recovery_codes'
  | 'game_types'
  | 'game_type_overrides';

export type CyclePhase = 'push_pending' | 'manifest' | 'download';
export type WorkItemKind =
  | 'cards'
  | 'on_demand'
  | 'team_names'
  | 'recovery_codes'
  | 'pattern'
  | 'layout'
  | 'scenario_meta'
  | 'scenario_media'
  | 'game_type_admin_video'
  | 'game_type_override_video';

export interface CycleStartedPayload {
  trigger: 'startup' | 'foreground' | 'network_up' | 'timer' | 'manual';
  startedAt: string;
}

// `cycle:phase` is emitted at each phase boundary so the UI can render a
// 3-step indicator (push local changes → check for updates → download).
// `skipped` is used for push_pending when no pending mutations existed; the
// indicator should render the step as inactive rather than as completed.
export interface CyclePhasePayload {
  phase: CyclePhase;
  status: 'started' | 'finished' | 'skipped';
}

// Per-item streaming-download progress. Emitted while a binary item
// (scenario_media, on_demand) is being read chunk-by-chunk so the UI can
// show "Downloading foo.png — 8.2 / 12.3 KB (67%)" instead of a stalled
// label that just reads "Scenario media: foo.png" for 30s. `key` is the
// caller's choice of stable identifier (typically the WorkItem.label);
// `total` is null when the server didn't send Content-Length.
export interface CycleItemProgressPayload {
  key: string;
  label: string;
  itemKind: WorkItemKind;
  loaded: number;
  total: number | null;
  // True on the final emission for this key (download finished or aborted),
  // so subscribers can clear their in-flight map.
  done: boolean;
}

export interface CycleProgressPayload {
  total: number;
  completed: number;
  failed: number;
  currentLabel?: string;
  // Set on the emission that immediately follows a successful download. The
  // log component uses this to render per-item size and aggregate a cycle
  // total. Omitted for failed items and for the initial total=0 emission.
  byteLength?: number;
  itemKind?: WorkItemKind;
  // Used by the log UI to group entries. Both a scenario_meta item and its
  // child scenario_media items emit the same groupKey (the scenario uniqid),
  // so the renderer can collapse media under their parent without juggling
  // two different keys. Undefined for unrelated kinds (cards / on_demand /
  // pattern / layout) which don't group.
  groupKey?: string;
}

export interface CycleFinishedPayload {
  startedAt: string;
  finishedAt: string;
  total: number;
  completed: number;
  failed: number;
}

// `detail` carries pre-stringified diagnostic context for the failure UI's
// collapsible "Show details" section. We pre-stringify in the orchestrator
// so listeners never have to JSON.stringify an arbitrary thrown value (which
// can be circular, a string, a DOMException, etc).
export interface CycleFailureDetail {
  errorType: string;
  serialized: string;
  stack: string | null;
  trigger: string;
  phase: CyclePhase | null;
  lastLabel: string | null;
  counters: { total: number; completed: number; failed: number };
}

export interface CycleFailedPayload {
  reason: string;
  recoverable: boolean;
  detail?: CycleFailureDetail;
}

export interface ContentUpdatedPayload {
  kind: ContentKind;
  ids: Array<string | number>;
  removed?: Array<string | number>;
}

export type SyncEventMap = {
  'cycle:started': CycleStartedPayload;
  'cycle:phase': CyclePhasePayload;
  'cycle:progress': CycleProgressPayload;
  'cycle:item_progress': CycleItemProgressPayload;
  'cycle:finished': CycleFinishedPayload;
  'cycle:failed': CycleFailedPayload;
  'content:updated': ContentUpdatedPayload;
};

type Listener<E extends keyof SyncEventMap> = (payload: SyncEventMap[E]) => void;

const listeners: { [E in keyof SyncEventMap]?: Set<Listener<E>> } = {};

export function on<E extends keyof SyncEventMap>(event: E, cb: Listener<E>): () => void {
  let set = listeners[event] as Set<Listener<E>> | undefined;
  if (!set) {
    set = new Set();
    listeners[event] = set as never;
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

export function emit<E extends keyof SyncEventMap>(event: E, payload: SyncEventMap[E]): void {
  const set = listeners[event] as Set<Listener<E>> | undefined;
  if (!set) return;
  for (const cb of set) {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[syncEvents] listener for ${event} threw:`, err);
    }
  }
}

export function off<E extends keyof SyncEventMap>(event: E, cb: Listener<E>): void {
  const set = listeners[event] as Set<Listener<E>> | undefined;
  set?.delete(cb);
}
