import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
  Clock,
  ShieldCheck,
  Film,
} from 'lucide-react';
import { getState, runCycleNow } from '../../services/syncOrchestrator';
import { on } from '../../services/syncEvents';
import { subscribe, getSnapshot, formatBytes, triggerLabel } from '../../services/syncLog';
import type { LogEntry, PhaseStatus, SyncLogSnapshot, InFlightItem } from '../../services/syncLog';
import type { CyclePhase } from '../../services/syncEvents';
import * as scenarioStore from '../../services/scenarioStore';
import * as patternStore from '../../services/patternStore';
import { listCurrentFailures, describeSyncFailure } from '../../services/syncFailures';
import type { SyncFailureRow } from '../../services/syncFailures';

interface ContentCounts {
  scenarios: { total: number; downloaded: number };
  patterns: { total: number; downloaded: number };
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
  const { t } = useTranslation();
  const log = useSyncExternalStore(subscribe, getSnapshot);
  const [state, setState] = useState(getState());
  const [counts, setCounts] = useState<ContentCounts | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [failures, setFailures] = useState<SyncFailureRow[]>([]);
  const [partial, setPartial] = useState<scenarioStore.ScenarioRow[]>([]);

  const refreshFailures = async () => {
    setFailures(await listCurrentFailures());
    setPartial(await scenarioStore.listPartiallyReady().catch(() => []));
  };

  const refreshCounts = async () => {
    const [scenarios, downloadedScenarios, patterns, downloadedPatterns] =
      await Promise.all([
        scenarioStore.count(),
        scenarioStore.count({ downloaded: true }),
        patternStore.count(),
        patternStore.count({ downloaded: true }),
      ]);
    setCounts({
      scenarios: { total: scenarios, downloaded: downloadedScenarios },
      patterns: { total: patterns, downloaded: downloadedPatterns },
    });
  };

  useEffect(() => {
    void refreshCounts();
    void refreshFailures();
    setState(getState());

    const offStarted = on('cycle:started', () => setState(getState()));
    const offFinished = on('cycle:finished', () => {
      setState(getState());
      void refreshCounts();
      void refreshFailures();
    });
    const offFailed = on('cycle:failed', () => {
      setState(getState());
      void refreshCounts();
      void refreshFailures();
    });
    const offContent = on('content:updated', () => {
      void refreshCounts();
      void refreshFailures();
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
        <h1 className="text-2xl font-semibold text-[var(--pg-text)]">{t('sync:title')}</h1>
        <button
          onClick={handleSync}
          disabled={inFlight}
          className="pg-btn pg-btn--primary"
        >
          {inFlight ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {inFlight ? t('sync:syncing') : t('sync:syncNow')}
        </button>
      </div>

      <SyncExplainer />

      <div className="pg-panel space-y-3">
        <div className="text-sm text-[var(--pg-text-dim)]">{t('sync:statusLabel')}</div>
        <div className="flex items-center gap-2 text-[var(--pg-text)]">
          {inFlight ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-[var(--pg-accent-bright)]" />
              <span>
                {log.counters.total === 0
                  ? t('sync:checkingForUpdates')
                  : t('sync:downloadingProgress', {
                      completed: log.counters.completed,
                      total: log.counters.total,
                    })}
              </span>
            </>
          ) : state.lastCycleFinishedAtIso ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>
                {t('sync:lastSyncAt', {
                  time: new Date(state.lastCycleFinishedAtIso).toLocaleString(),
                })}
                {state.lastCycleStats
                  ? state.lastCycleStats.total === 0
                    ? t('sync:lastSyncUpToDate')
                    : t('sync:lastSyncDownloaded', {
                        completed: state.lastCycleStats.completed,
                        total: state.lastCycleStats.total,
                      }) +
                      (state.lastCycleStats.failed > 0
                        ? t('sync:lastSyncFailedSuffix', { count: state.lastCycleStats.failed })
                        : '')
                  : ''}
              </span>
            </>
          ) : (
            <span className="text-[var(--pg-text-dim)]">{t('sync:notYetSynced')}</span>
          )}
        </div>

        {log.trigger && (
          <div className="text-xs text-[var(--pg-text-dim)]">
            {t('sync:startedBy')}{' '}
            <span className="text-[var(--pg-text-muted)]">{t(triggerLabel(log.trigger))}</span>
          </div>
        )}

        <PhaseIndicator phases={log.phase} />

        {inFlight && (
          <div>
            <div className="h-2 bg-[var(--pg-surface-3)] rounded-full overflow-hidden border border-[var(--pg-line)]">
              <div
                className={`h-full bg-[var(--pg-accent)] transition-all duration-300 ${
                  log.counters.total === 0 ? 'animate-pulse w-full' : ''
                }`}
                style={log.counters.total > 0 ? { width: `${pct}%` } : undefined}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-[var(--pg-text-dim)] mt-2">
              <span className="truncate">{log.currentLabel ?? t('sync:fetchingManifest')}</span>
              {log.counters.total > 0 && (
                <span className="shrink-0 ml-3">
                  {t('sync:countOfTotal', {
                    completed: log.counters.completed,
                    total: log.counters.total,
                  })}
                  {log.counters.failed > 0 && (
                    <span className="text-amber-400"> · {t('sync:countFailed', { count: log.counters.failed })}</span>
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
            <span>{t('sync:itemsFailedLastCycle', { count: state.lastCycleStats.failed })}</span>
          </div>
        )}

        {log.totalBytes > 0 && (
          <div className="text-xs text-[var(--pg-text-dim)]">
            {t('sync:downloadedThisCycle', { bytes: formatBytes(log.totalBytes) })}
          </div>
        )}

        <div className="text-xs text-[var(--pg-text-dim)]">
          {t('sync:networkStatus', {
            status: state.online ? t('sync:online') : t('sync:offline'),
          })}
        </div>
      </div>

      {failures.length > 0 && (
        <FailedItemsPanel failures={failures} onRetry={handleSync} retrying={inFlight} />
      )}

      {partial.length > 0 && <PartiallyReadyPanel scenarios={partial} />}

      {log.entries.length > 0 && (
        <ActivityLog log={log} inFlight={inFlight} />
      )}

      {counts && (
        <div className="pg-panel space-y-3">
          <div className="text-sm text-[var(--pg-text-dim)]">{t('sync:libraryLabel')}</div>
          <CountRow label={t('sync:scenariosLabel')} total={counts.scenarios.total} downloaded={counts.scenarios.downloaded} />
          <CountRow label={t('sync:patternsLabel')} total={counts.patterns.total} downloaded={counts.patterns.downloaded} />
        </div>
      )}
    </div>
  );
}

// ---------- what-is-sync explainer ----------
//
// Operators routinely confuse Sync with Updates. Sync pulls game *content*
// (scenarios, patterns, images, videos) down from the studio; Updates installs
// a new version of the *app*. Spell out both here so the distinction is
// unmissable from the tab itself.

function SyncExplainer() {
  const { t } = useTranslation('sync');
  return (
    <div className="flex items-start gap-2 text-sm text-[var(--pg-text-muted)] bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-lg p-3">
      <Info className="w-4 h-4 mt-0.5 shrink-0 text-[var(--pg-text-dim)]" />
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <div className="font-medium text-[var(--pg-text)]">{t('sync:explainerWhatTitle')}</div>
          <p>
            <Trans t={t} i18nKey="explainerWhatBody">
              Sync downloads your game content - scenarios, patterns, images and
              videos - from Tag Hunter Studio onto this device, so everything is
              ready to play, even without internet. It runs automatically, and{' '}
              <span className="font-medium">Sync now</span> forces an immediate
              check for the latest content.
            </Trans>
          </p>
        </div>
        <div>
          <div className="font-medium text-[var(--pg-text)]">{t('sync:explainerNotSameTitle')}</div>
          <p>
            <Trans t={t} i18nKey="explainerNotSameBody">
              Sync keeps the <span className="font-medium">content you play with</span>{' '}
              up to date. The <span className="font-medium">Updates</span> tab is
              separate - it installs a new version of the{' '}
              <span className="font-medium">app itself</span>. Changing your
              scenarios never needs an app update, and updating the app doesn't
              re-download your content.
            </Trans>
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------- persistent failed-items panel ----------
//
// Sourced from the sync_item_failures table (services/syncFailures.ts), so -
// unlike the per-cycle activity log - it survives the cycle:started wipe and
// shows the operator exactly which files are stuck, with a friendly reason and
// the raw error on expand. Shows ALL currently-failing items; the small
// "reported to support" tag marks the ones promoted to a studio report.

function relativeTime(
  iso: string | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!iso) return t('sync:dash');
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 60_000) return t('sync:justNow');
  if (diff < 3_600_000) return t('sync:minutesAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('sync:hoursAgo', { count: Math.floor(diff / 3_600_000) });
  return t('sync:daysAgo', { count: Math.floor(diff / 86_400_000) });
}

function FailedItemsPanel({
  failures,
  onRetry,
  retrying,
}: {
  failures: SyncFailureRow[];
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="pg-panel space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-amber-400">
          <AlertTriangle className="w-4 h-4" />
          <span className="font-medium">{t('sync:failedItemsTitle')}</span>
          <span className="text-[var(--pg-text-dim)]">({failures.length})</span>
        </div>
        <button onClick={onRetry} disabled={retrying} className="pg-btn pg-btn--ghost text-xs disabled:opacity-50">
          {retrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t('sync:retryAll')}
        </button>
      </div>
      <ul className="space-y-2">
        {failures.map((f) => (
          <li key={f.item_key}>
            <FailedItemRow row={f} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// Scenarios that were committed with a video still missing (commitPartialManifest).
// They ARE launchable - everything but the video is on disk - so this is an
// informational note, not a failure: without it an operator would just find the
// intro greyed out with no explanation.
function PartiallyReadyPanel({ scenarios }: { scenarios: scenarioStore.ScenarioRow[] }) {
  const { t } = useTranslation();
  return (
    <div className="pg-panel space-y-3">
      <div className="flex items-center gap-2 text-sm text-[var(--pg-text)]">
        <Film className="w-4 h-4 text-[var(--pg-text-dim)]" />
        <span className="font-medium">{t('sync:partiallyReadyTitle')}</span>
        <span className="text-[var(--pg-text-dim)]">({scenarios.length})</span>
      </div>
      <div className="text-xs text-[var(--pg-text-dim)]">{t('sync:partiallyReadyHint')}</div>
      <ul className="space-y-2">
        {scenarios.map((s) => (
          <li
            key={s.uniqid}
            className="rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)] p-3"
          >
            <div className="truncate text-sm text-[var(--pg-text)]">{s.title}</div>
            <div className="mt-0.5 text-xs text-[var(--pg-text-dim)]">
              {t('sync:partiallyReadyRow')}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FailedItemRow({ row }: { row: SyncFailureRow }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const reason = describeSyncFailure(row);
  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm text-[var(--pg-text)]">{row.label}</span>
            {row.reported_failed === 1 && (
              <span
                title={t('sync:reportedToSupportHint')}
                className="shrink-0 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--pg-text-dim)] border border-[var(--pg-line)] rounded px-1.5 py-0.5"
              >
                <ShieldCheck className="w-3 h-3" />
                {t('sync:reportedToSupport')}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-amber-300/90">{t(reason.key, reason.params)}</div>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-[var(--pg-text-dim)]">
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {relativeTime(row.last_failed_at, t)}
            </span>
            <span>{t('sync:failedAttempts', { count: row.consecutive_failures })}</span>
          </div>
        </div>
      </div>
      {row.error_message && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--pg-text-dim)] hover:text-[var(--pg-text-muted)] underline"
          >
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {t('sync:technicalDetails')}
          </button>
          {open && (
            <pre className="mt-2 text-[11px] bg-[var(--pg-bg)] text-[var(--pg-text-muted)] p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
{`key:     ${row.item_key}
type:    ${row.error_type ?? '(none)'}${row.http_status !== null ? ` (HTTP ${row.http_status})` : ''}
message: ${row.error_message}`}
            </pre>
          )}
        </>
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
      <div className="flex items-center justify-between gap-2 text-[var(--pg-text-muted)]">
        <span className="truncate">{item.label}</span>
        <span className="shrink-0 text-[var(--pg-text-dim)] tabular-nums">
          {hasTotal
            ? `${formatBytes(item.loaded)} / ${formatBytes(item.total!)} · ${pct}%`
            : formatBytes(item.loaded)}
        </span>
      </div>
      <div className="mt-1 h-1 bg-[var(--pg-surface-3)] rounded-full overflow-hidden border border-[var(--pg-line)]">
        <div
          className={`h-full bg-[var(--pg-accent)] transition-all duration-100 ${
            !hasTotal ? 'animate-pulse w-1/3' : ''
          }`}
          style={hasTotal ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}

// ---------- phase indicator ----------

function getPhaseLabels(
  t: (key: string) => string,
): Record<CyclePhase, string> {
  return {
    push_pending: t('sync:phasePushPending'),
    manifest: t('sync:phaseManifest'),
    download: t('sync:phaseDownload'),
  };
}

function PhaseIndicator({ phases }: { phases: Record<CyclePhase, PhaseStatus> }) {
  const { t } = useTranslation();
  const PHASE_LABELS = getPhaseLabels(t);
  const order: CyclePhase[] = ['push_pending', 'manifest', 'download'];
  return (
    <div className="flex items-center gap-2">
      {order.map((phase, idx) => (
        <div key={phase} className="flex items-center gap-2 flex-1 min-w-0">
          <PhaseStep status={phases[phase]} label={PHASE_LABELS[phase]} />
          {idx < order.length - 1 && (
            <div className="h-px bg-[var(--pg-line-strong)] flex-1 shrink-0" />
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
      icon = <Loader2 className={`${iconClass} text-[var(--pg-accent-bright)] animate-spin`} />;
      textClass = 'text-[var(--pg-text)]';
      break;
    case 'done':
      icon = <Check className={`${iconClass} text-emerald-400`} />;
      textClass = 'text-[var(--pg-text-muted)]';
      break;
    case 'skipped':
      icon = <CircleDot className={`${iconClass} text-[var(--pg-text-dim)]`} />;
      textClass = 'text-[var(--pg-text-dim)] italic';
      break;
    case 'pending':
    default:
      icon = <Circle className={`${iconClass} text-[var(--pg-text-dim)]`} />;
      textClass = 'text-[var(--pg-text-dim)]';
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
  const { t } = useTranslation();
  const message =
    kind === 'auth_refresh'
      ? t('sync:interruptedAuthRefresh')
      : t('sync:interruptedGeneric');
  return (
    <div className="flex items-start gap-2 text-sm text-[var(--pg-accent-bright)] bg-[var(--pg-accent-tint)] border border-[var(--pg-accent-line)] rounded-lg p-3">
      <Info className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t('sync:interruptedTitle')}</div>
        <div className="opacity-80">
          {message}
          {counters.total > 0 && (
            <span>
              {' '}
              {t('sync:interruptedProgress', {
                completed: counters.completed,
                total: counters.total,
              })}
              {counters.failed > 0 && t('sync:lastSyncFailedSuffix', { count: counters.failed })}
              {'.'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- failure box with collapsible details ----------

function FailureBox({ failure }: { failure: NonNullable<SyncLogSnapshot['failure']> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t('sync:syncFailedTitle')}</div>
        <div className="text-red-400/80 break-words">
          {failure.errorType}: {failure.serialized}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-2 inline-flex items-center gap-1 text-xs text-red-300/80 hover:text-red-200 underline"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {open ? t('sync:hideDetails') : t('sync:showDetails')}
        </button>
        {open && (
          <pre className="mt-2 text-xs bg-[var(--pg-bg)] text-[var(--pg-text-muted)] p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
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
  const { t } = useTranslation();
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
    <div className="pg-panel space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-[var(--pg-text-dim)]">{t('sync:activityLabel')}</div>
        <div className="text-xs text-[var(--pg-text-dim)]">
          {t('sync:activityItems', { count: log.entries.length })}
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
        // defensive - render the media as its own group).
        groups.push({ key: `orphan-${entry.id}`, parent: null, children: [entry] });
      }
    } else {
      groups.push({ key: `solo-${entry.id}`, parent: entry, children: [] });
    }
  }

  return groups;
}

function ActivityGroup({ group, inFlight }: { group: ActivityGroup; inFlight: boolean }) {
  const { t } = useTranslation();
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
        className="w-full flex items-center gap-2 text-left text-[var(--pg-text-muted)] hover:text-[var(--pg-text)]"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 shrink-0 text-[var(--pg-text-dim)]" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0 text-[var(--pg-text-dim)]" />
        )}
        <StatusIcon status={group.parent.status} />
        <span className="truncate flex-1">{group.parent.label}</span>
        <span className="shrink-0 text-xs text-[var(--pg-text-dim)]">
          {t('sync:fileCount', { count: group.children.length })}
          {totalBytes > 0 && ` · ${formatBytes(totalBytes)}`}
          {failedCount > 0 && (
            <span className="text-amber-400"> · {t('sync:countFailed', { count: failedCount })}</span>
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
    <div className={`flex items-center gap-2 ${muted ? 'text-[var(--pg-text-dim)]' : 'text-[var(--pg-text-muted)]'}`}>
      <StatusIcon status={entry.status} />
      <span className="truncate flex-1">{entry.label}</span>
      {entry.bytes > 0 && (
        <span className="shrink-0 text-xs text-[var(--pg-text-dim)]">{formatBytes(entry.bytes)}</span>
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
    <div className="flex items-center justify-between text-[var(--pg-text)]">
      <span>{label}</span>
      <span className={`text-sm ${downloaded === total ? 'text-emerald-400' : 'text-[var(--pg-text-muted)]'}`}>
        {downloaded} / {total}
      </span>
    </div>
  );
}
