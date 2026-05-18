import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Info,
  Loader2,
  Check,
  X,
  ChevronRight,
  ChevronDown,
  CircleDot,
  Circle,
} from 'lucide-react';
import { getState, runCycleNow } from '../../services/syncOrchestrator';
import { on } from '../../services/syncEvents';
import { subscribe, getSnapshot, formatBytes, triggerLabel } from '../../services/syncLog';
import type { LogEntry, PhaseStatus, SyncLogSnapshot, InFlightItem } from '../../services/syncLog';
import type { CyclePhase } from '../../services/syncEvents';
import * as scenarioStore from '../../services/scenarioStore';
import * as patternStore from '../../services/patternStore';
import * as layoutStore from '../../services/layoutStore';

interface ContentCounts {
  scenarios: { total: number; downloaded: number };
  patterns: { total: number; downloaded: number };
  layouts: { total: number; downloaded: number };
}

// Settings-tab detail view for the content sync subsystem. Exposes:
//   - 3-phase indicator (push local changes → check for updates → download)
//   - trigger reason ("Started by: app launch / manual / ...")
//   - live progress bar with current item label
//   - per-cycle activity log, grouped (scenario media collapsed under parent)
//   - per-item bytes and cycle total
//   - collapsible diagnostic <details> when a cycle fails
//   - per-kind library counts (downloaded vs known)
//   - manual "Sync now" button
export function SyncStatusScreen() {
  const log = useSyncExternalStore(subscribe, getSnapshot);
  const [state, setState] = useState(getState());
  const [counts, setCounts] = useState<ContentCounts | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshCounts = async () => {
    const [scenarios, downloadedScenarios, patterns, downloadedPatterns, layouts, downloadedLayouts] =
      await Promise.all([
        scenarioStore.count(),
        scenarioStore.count({ downloaded: true }),
        patternStore.count(),
        patternStore.count({ downloaded: true }),
        layoutStore.count(),
        layoutStore.count({ downloaded: true }),
      ]);
    setCounts({
      scenarios: { total: scenarios, downloaded: downloadedScenarios },
      patterns: { total: patterns, downloaded: downloadedPatterns },
      layouts: { total: layouts, downloaded: downloadedLayouts },
    });
  };

  useEffect(() => {
    void refreshCounts();
    setState(getState());

    const offStarted = on('cycle:started', () => setState(getState()));
    const offFinished = on('cycle:finished', () => {
      setState(getState());
      void refreshCounts();
    });
    const offFailed = on('cycle:failed', () => {
      setState(getState());
      void refreshCounts();
    });
    const offContent = on('content:updated', () => {
      void refreshCounts();
    });
    return () => {
      offStarted();
      offFinished();
      offFailed();
      offContent();
    };
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await runCycleNow('manual');
    } finally {
      setSyncing(false);
    }
  };

  const inFlight = state.cycleInFlight || syncing;
  const pct = log.counters.total > 0
    ? Math.round((log.counters.completed / log.counters.total) * 100)
    : 0;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Sync</h1>
        <button
          onClick={handleSync}
          disabled={inFlight}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium flex items-center gap-2 disabled:opacity-50"
        >
          {inFlight ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {inFlight ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-3">
        <div className="text-sm text-slate-400">Status</div>
        <div className="flex items-center gap-2 text-white">
          {inFlight ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
              <span>
                {log.counters.total === 0
                  ? 'Checking for updates…'
                  : `Downloading ${log.counters.completed} of ${log.counters.total}`}
              </span>
            </>
          ) : state.lastCycleFinishedAtIso ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>
                Last sync at{' '}
                {new Date(state.lastCycleFinishedAtIso).toLocaleString()}
                {state.lastCycleStats
                  ? state.lastCycleStats.total === 0
                    ? ' — already up to date'
                    : ` — ${state.lastCycleStats.completed} of ${state.lastCycleStats.total} downloaded${
                        state.lastCycleStats.failed > 0 ? `, ${state.lastCycleStats.failed} failed` : ''
                      }`
                  : ''}
              </span>
            </>
          ) : (
            <span className="text-slate-400">Not yet synced</span>
          )}
        </div>

        {log.trigger && (
          <div className="text-xs text-slate-500">
            Started by: <span className="text-slate-300">{triggerLabel(log.trigger)}</span>
          </div>
        )}

        <PhaseIndicator phases={log.phase} />

        {inFlight && (
          <div>
            <div className="h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-700">
              <div
                className={`h-full bg-blue-500 transition-all duration-300 ${
                  log.counters.total === 0 ? 'animate-pulse w-full' : ''
                }`}
                style={log.counters.total > 0 ? { width: `${pct}%` } : undefined}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-slate-500 mt-2">
              <span className="truncate">{log.currentLabel ?? 'Fetching manifest…'}</span>
              {log.counters.total > 0 && (
                <span className="shrink-0 ml-3">
                  {log.counters.completed} of {log.counters.total}
                  {log.counters.failed > 0 && (
                    <span className="text-amber-400"> · {log.counters.failed} failed</span>
                  )}
                </span>
              )}
            </div>
            <InFlightList items={Object.values(log.inFlight)} />
          </div>
        )}

        {!inFlight && log.failure && (
          <FailureBox failure={log.failure} />
        )}

        {!inFlight && !log.failure && log.interrupted && (
          <InterruptedBox
            kind={log.interrupted.kind}
            counters={log.counters}
          />
        )}

        {!inFlight && !log.failure && state.lastCycleStats && state.lastCycleStats.failed > 0 && (
          <div className="flex items-center gap-2 text-sm text-amber-400">
            <AlertTriangle className="w-4 h-4" />
            <span>{state.lastCycleStats.failed} item(s) failed last cycle. Tap Sync now to retry.</span>
          </div>
        )}

        {log.totalBytes > 0 && (
          <div className="text-xs text-slate-500">
            Downloaded {formatBytes(log.totalBytes)} this cycle
          </div>
        )}

        <div className="text-xs text-slate-500">
          Network: {state.online ? 'online' : 'offline'}
        </div>
      </div>

      {log.entries.length > 0 && (
        <ActivityLog log={log} inFlight={inFlight} />
      )}

      {counts && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-3">
          <div className="text-sm text-slate-400">Library</div>
          <CountRow label="Scenarios" total={counts.scenarios.total} downloaded={counts.scenarios.downloaded} />
          <CountRow label="Patterns" total={counts.patterns.total} downloaded={counts.patterns.downloaded} />
          <CountRow label="Layouts" total={counts.layouts.total} downloaded={counts.layouts.downloaded} />
        </div>
      )}
    </div>
  );
}

// ---------- in-flight item list ----------
//
// Live per-item download progress. Up to POOL_SIZE entries simultaneously
// (orchestrator runs 3 parallel workers). Each row shows the file label,
// loaded/total bytes (or "Downloading…" if Content-Length wasn't sent),
// and an indeterminate pulse vs determinate fill based on whether we have
// a total.

function InFlightList({ items }: { items: InFlightItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-3 space-y-2">
      {items.map((it) => (
        <li key={it.key}>
          <InFlightRow item={it} />
        </li>
      ))}
    </ul>
  );
}

function InFlightRow({ item }: { item: InFlightItem }) {
  const hasTotal = item.total !== null && item.total > 0;
  const pct = hasTotal ? Math.min(100, Math.round((item.loaded / item.total!) * 100)) : 0;
  return (
    <div className="text-xs">
      <div className="flex items-center justify-between gap-2 text-slate-300">
        <span className="truncate">{item.label}</span>
        <span className="shrink-0 text-slate-500 tabular-nums">
          {hasTotal
            ? `${formatBytes(item.loaded)} / ${formatBytes(item.total!)} · ${pct}%`
            : formatBytes(item.loaded)}
        </span>
      </div>
      <div className="mt-1 h-1 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
        <div
          className={`h-full bg-blue-400 transition-all duration-100 ${
            !hasTotal ? 'animate-pulse w-1/3' : ''
          }`}
          style={hasTotal ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}

// ---------- phase indicator ----------

const PHASE_LABELS: Record<CyclePhase, string> = {
  push_pending: 'Pushing local changes',
  manifest: 'Checking for updates',
  download: 'Downloading content',
};

function PhaseIndicator({ phases }: { phases: Record<CyclePhase, PhaseStatus> }) {
  const order: CyclePhase[] = ['push_pending', 'manifest', 'download'];
  return (
    <div className="flex items-center gap-2">
      {order.map((phase, idx) => (
        <div key={phase} className="flex items-center gap-2 flex-1 min-w-0">
          <PhaseStep status={phases[phase]} label={PHASE_LABELS[phase]} />
          {idx < order.length - 1 && (
            <div className="h-px bg-slate-700 flex-1 shrink-0" />
          )}
        </div>
      ))}
    </div>
  );
}

function PhaseStep({ status, label }: { status: PhaseStatus; label: string }) {
  const iconClass = 'w-3.5 h-3.5 shrink-0';
  let icon;
  let textClass = '';
  switch (status) {
    case 'active':
      icon = <Loader2 className={`${iconClass} text-blue-400 animate-spin`} />;
      textClass = 'text-slate-100';
      break;
    case 'done':
      icon = <Check className={`${iconClass} text-emerald-400`} />;
      textClass = 'text-slate-300';
      break;
    case 'skipped':
      icon = <CircleDot className={`${iconClass} text-slate-600`} />;
      textClass = 'text-slate-500 italic';
      break;
    case 'pending':
    default:
      icon = <Circle className={`${iconClass} text-slate-600`} />;
      textClass = 'text-slate-500';
  }
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {icon}
      <span className={`text-xs truncate ${textClass}`}>{label}</span>
    </div>
  );
}

// ---------- interrupted box (auth refresh, etc.) ----------
//
// Calmer affordance than FailureBox. The cycle stopped not because of a
// real error but because something transient kicked in (auth refresh
// today; could grow to cover other "we'll retry shortly" interruptions).
// Shows partial counts so the user knows we made progress before stopping.

function InterruptedBox({
  kind,
  counters,
}: {
  kind: 'auth_refresh';
  counters: SyncLogSnapshot['counters'];
}) {
  const message =
    kind === 'auth_refresh'
      ? "Sync paused while your credentials are refreshed. We'll pick up where we left off automatically."
      : 'Sync was interrupted.';
  return (
    <div className="flex items-start gap-2 text-sm text-blue-200 bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
      <Info className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Sync interrupted</div>
        <div className="text-blue-300/80">
          {message}
          {counters.total > 0 && (
            <span>
              {' '}
              {counters.completed} of {counters.total} items completed before stopping
              {counters.failed > 0 && `, ${counters.failed} failed`}.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- failure box with collapsible details ----------

function FailureBox({ failure }: { failure: NonNullable<SyncLogSnapshot['failure']> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Sync failed</div>
        <div className="text-red-400/80 break-words">
          {failure.errorType}: {failure.serialized}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-2 inline-flex items-center gap-1 text-xs text-red-300/80 hover:text-red-200 underline"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {open ? 'Hide details' : 'Show details'}
        </button>
        {open && (
          <pre className="mt-2 text-xs bg-slate-900/60 text-slate-300 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
{`trigger:   ${failure.trigger}
phase:     ${failure.phase ?? '(none)'}
lastItem:  ${failure.lastLabel ?? '(none)'}
counters:  ${failure.counters.completed} of ${failure.counters.total}, ${failure.counters.failed} failed
${failure.stack ? `\nstack:\n${failure.stack}` : ''}`}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------- activity log ----------

interface ActivityLogProps {
  log: SyncLogSnapshot;
  inFlight: boolean;
}

function ActivityLog({ log, inFlight }: ActivityLogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll-to-bottom unless the user has scrolled up. When the user
  // scrolls up they presumably want to read history; we get out of the way
  // until they scroll back down.
  const stuckToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuckToBottomRef.current = distanceFromBottom < 20;
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stuckToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [log.entries.length]);

  const groups = buildGroups(log.entries);

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-400">Activity</div>
        <div className="text-xs text-slate-500">
          {log.entries.length} item{log.entries.length === 1 ? '' : 's'}
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="max-h-80 overflow-y-auto pr-1 space-y-1 text-sm"
      >
        {groups.map((group) => (
          <ActivityGroup key={group.key} group={group} inFlight={inFlight} />
        ))}
      </div>
    </div>
  );
}

interface ActivityGroup {
  key: string;
  parent: LogEntry | null;
  children: LogEntry[];
}

function buildGroups(entries: LogEntry[]): ActivityGroup[] {
  // Walks the flat entry list in arrival order. scenario_meta entries seed a
  // group; subsequent scenario_media entries with the matching groupKey are
  // attached as children. Non-grouping entries are their own single-entry
  // groups so the renderer can treat everything uniformly.
  const groups: ActivityGroup[] = [];
  const byGroupKey = new Map<string, ActivityGroup>();

  for (const entry of entries) {
    if (entry.itemKind === 'scenario_meta' && entry.groupKey) {
      const group: ActivityGroup = { key: entry.groupKey, parent: entry, children: [] };
      groups.push(group);
      byGroupKey.set(entry.groupKey, group);
    } else if (entry.itemKind === 'scenario_media' && entry.groupKey) {
      const existing = byGroupKey.get(entry.groupKey);
      if (existing) {
        existing.children.push(entry);
      } else {
        // Media arrived before its scenario_meta (shouldn't happen but be
        // defensive — render the media as its own group).
        groups.push({ key: `orphan-${entry.id}`, parent: null, children: [entry] });
      }
    } else {
      groups.push({ key: `solo-${entry.id}`, parent: entry, children: [] });
    }
  }

  return groups;
}

function ActivityGroup({ group, inFlight }: { group: ActivityGroup; inFlight: boolean }) {
  // Default-expanded while the parent's children are still arriving. Once
  // the cycle is no longer in flight we collapse so the log stays scannable.
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!inFlight && group.children.length > 0) {
      setOpen(false);
    }
  }, [inFlight, group.children.length]);

  // Solo entry (non-grouping kind, or a scenario with zero children).
  if (!group.parent || group.children.length === 0) {
    const entry = group.parent ?? group.children[0];
    if (!entry) return null;
    return <ActivityRow entry={entry} />;
  }

  const totalBytes =
    group.parent.bytes + group.children.reduce((acc, c) => acc + c.bytes, 0);
  const failedCount = group.children.filter((c) => c.status === 'failed').length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left text-slate-300 hover:text-white"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 shrink-0 text-slate-500" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0 text-slate-500" />
        )}
        <StatusIcon status={group.parent.status} />
        <span className="truncate flex-1">{group.parent.label}</span>
        <span className="shrink-0 text-xs text-slate-500">
          {group.children.length} file{group.children.length === 1 ? '' : 's'}
          {totalBytes > 0 && ` · ${formatBytes(totalBytes)}`}
          {failedCount > 0 && (
            <span className="text-amber-400"> · {failedCount} failed</span>
          )}
        </span>
      </button>
      {open && (
        <ul className="ml-6 mt-1 space-y-1">
          {group.children.map((child) => (
            <li key={child.id}>
              <ActivityRow entry={child} muted />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityRow({ entry, muted = false }: { entry: LogEntry; muted?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${muted ? 'text-slate-400' : 'text-slate-300'}`}>
      <StatusIcon status={entry.status} />
      <span className="truncate flex-1">{entry.label}</span>
      {entry.bytes > 0 && (
        <span className="shrink-0 text-xs text-slate-500">{formatBytes(entry.bytes)}</span>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: LogEntry['status'] }) {
  return status === 'completed' ? (
    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
  ) : (
    <X className="w-4 h-4 text-red-400 shrink-0" />
  );
}

// ---------- library counts ----------

function CountRow({ label, total, downloaded }: { label: string; total: number; downloaded: number }) {
  return (
    <div className="flex items-center justify-between text-white">
      <span>{label}</span>
      <span className={`text-sm ${downloaded === total ? 'text-emerald-400' : 'text-slate-300'}`}>
        {downloaded} / {total}
      </span>
    </div>
  );
}
