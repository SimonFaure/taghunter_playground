import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CreditCard, RefreshCw, Package, Layers, Trash2, ChevronDown, ChevronRight, Upload } from 'lucide-react';
import * as patternStore from '../services/patternStore';
import { runCycleNow, getState } from '../services/syncOrchestrator';
import { on } from '../services/syncEvents';
import { useAuth } from './auth/AuthProvider';
import { CardsManager } from './cards/CardsManager';
import { ConfirmDialog } from './ConfirmDialog';

// Cards & patterns overview for the currently-authenticated client. Layout
// mirrors ConfigurationPage: a left sidebar with tab buttons + a main panel
// that renders the active section. Cards CRUD is handled by CardsManager.
// Patterns are synced from studio; each one can be expanded to inspect its
// station→item routing and removed from this device (re-syncs from cloud).

type CardsTab = 'cards' | 'patterns';

export default function ClientCardsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<CardsTab>('cards');
  const [defaultPatterns, setDefaultPatterns] = useState<patternStore.PatternRow[]>([]);
  const [customPatterns, setCustomPatterns] = useState<patternStore.PatternRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [defaults, customs] = await Promise.all([
        patternStore.list({ isDefault: true }),
        patternStore.list({ isDefault: false }),
      ]);
      setDefaultPatterns(defaults);
      setCustomPatterns(customs);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
    const offContent = on('content:updated', () => {
      void refresh();
    });
    return () => {
      offContent();
    };
  }, [refresh]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await runCycleNow('manual');
    } finally {
      setSyncing(false);
    }
  };

  const handleDeletePattern = useCallback(
    async (uniqid: string) => {
      await patternStore.remove(uniqid);
      await refresh();
    },
    [refresh]
  );

  const handlePatternFile = useCallback(
    async (file: File) => {
      setImporting(true);
      setImportMsg(null);
      try {
        const { parsePatternFile } = await import('../services/patternImport');
        const parsed = await parsePatternFile(file);
        await patternStore.importLocal(parsed, new Date().toISOString());
        setImportMsg({ type: 'success', text: t('cards:importPatternOk', { name: parsed.name }) });
        await refresh();
      } catch (err) {
        setImportMsg({
          type: 'error',
          text: err instanceof Error ? err.message : t('cards:importPatternFailed'),
        });
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [refresh, t]
  );

  const onPatternFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handlePatternFile(file);
  };

  return (
    <div
      className={
        embedded
          ? 'text-[var(--pg-text)]'
          : 'min-h-screen pg-app-bg text-[var(--pg-text)] py-8'
      }
    >
      <div className={embedded ? '' : 'container mx-auto px-6'}>
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <CreditCard className="text-[var(--pg-accent-bright)]" size={32} />
            <h1 className="text-3xl font-bold">{t('cards:title')}</h1>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing || getState().cycleInFlight}
            className="pg-btn pg-btn--primary disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            <span>{t('cards:syncNow')}</span>
          </button>
        </div>

        <div className="flex gap-6">
          <aside className="w-56 shrink-0">
            <CardsNav active={activeTab} onChange={setActiveTab} />
          </aside>

          <main className="flex-1 min-w-0 max-w-4xl">
            {activeTab === 'cards' && <CardsManager />}

            {activeTab === 'patterns' && (
              <>
                <div className="flex items-center justify-end mb-4">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.xls,.xlsx"
                    onChange={onPatternFileChange}
                    className="hidden"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importing}
                    className="pg-btn pg-btn--primary disabled:opacity-50"
                  >
                    <Upload className={`w-4 h-4 ${importing ? 'animate-pulse' : ''}`} />
                    <span>{importing ? t('cards:importPatternBusy') : t('cards:importPattern')}</span>
                  </button>
                </div>
                {importMsg && (
                  <div
                    className={`mb-4 px-4 py-3 rounded-[var(--pg-radius-md)] text-sm ${
                      importMsg.type === 'success'
                        ? 'bg-[var(--pg-success-soft,#0f3d2e)] text-[var(--pg-success,#34d399)]'
                        : 'bg-[var(--pg-danger-soft,#3d1620)] text-[var(--pg-danger,#f87171)]'
                    }`}
                  >
                    {importMsg.text}
                  </div>
                )}
                {loading ? (
                  <Section icon={<Package className="text-[var(--pg-accent-bright)]" size={24} />} title={t('cards:patterns')}>
                    <div className="flex items-center justify-center py-10">
                      <RefreshCw className="w-8 h-8 text-[var(--pg-text-dim)] animate-spin" />
                    </div>
                  </Section>
                ) : (
                  <>
                    <PatternSection
                      title={t('cards:defaultPatterns')}
                      rows={defaultPatterns}
                      icon={<Package className="text-[var(--pg-accent-bright)]" size={24} />}
                      onDelete={handleDeletePattern}
                    />
                    <PatternSection
                      title={t('cards:customPatterns')}
                      rows={customPatterns}
                      icon={<Layers className="text-[var(--pg-accent-bright)]" size={24} />}
                      onDelete={handleDeletePattern}
                    />
                  </>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function CardsNav({ active, onChange }: { active: CardsTab; onChange: (tab: CardsTab) => void }) {
  const { t } = useTranslation();
  const items: { tab: CardsTab; label: string; icon: React.ReactNode }[] = [
    { tab: 'cards', label: t('cards:navCards'), icon: <CreditCard size={16} /> },
    { tab: 'patterns', label: t('cards:navPatterns'), icon: <Layers size={16} /> },
  ];
  return (
    <nav className="space-y-6 sticky top-24">
      <div>
        <div className="text-xs uppercase tracking-wider text-[var(--pg-text-dim)] px-3 mb-2">{t('cards:content')}</div>
        <div className="space-y-1">
          {items.map((item) => {
            const isActive = active === item.tab;
            return (
              <button
                key={item.tab}
                onClick={() => onChange(item.tab)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-[var(--pg-radius-md)] transition text-left text-sm ${
                  isActive ? 'bg-[var(--pg-accent)] text-[var(--pg-text)]' : 'text-[var(--pg-text-muted)] hover:bg-[var(--pg-surface-3)]'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

function Section({
  icon,
  title,
  headerExtra,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="pg-panel p-6 mb-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-xl font-semibold">{title}</h2>
        </div>
        {headerExtra}
      </div>
      {children}
    </div>
  );
}

function PatternSection({
  title,
  rows,
  icon,
  onDelete,
}: {
  title: string;
  rows: patternStore.PatternRow[];
  icon: React.ReactNode;
  onDelete: (uniqid: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <Section
      icon={icon}
      title={t('cards:sectionTitleWithCount', { title, count: rows.length })}
    >
      {rows.length === 0 ? (
        <p className="text-[var(--pg-text-dim)] italic text-sm">{t('cards:none')}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((p) => (
            <PatternCard key={p.pattern_uniqid} pattern={p} onDelete={onDelete} />
          ))}
        </div>
      )}
    </Section>
  );
}

// One pattern row: header (name + metadata + actions) over an optional,
// lazily-loaded routing detail panel that shows which station maps to which
// enigma / checkpoint / quest.
function PatternCard({
  pattern,
  onDelete,
}: {
  pattern: patternStore.PatternRow;
  onDelete: (uniqid: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [routing, setRouting] = useState<patternStore.PatternRoutingItem[] | null>(null);
  const [stations, setStations] = useState<Record<string, string>>({});
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const toggleDetails = async () => {
    if (!expanded && routing === null) {
      setLoadingDetails(true);
      try {
        const [r, s] = await Promise.all([
          patternStore.getRouting(pattern.pattern_uniqid),
          patternStore.getStations(pattern.pattern_uniqid),
        ]);
        setRouting(r);
        setStations(s);
      } finally {
        setLoadingDetails(false);
      }
    }
    setExpanded((v) => !v);
  };

  const confirmDelete = async () => {
    setConfirmOpen(false);
    setDeleting(true);
    try {
      await onDelete(pattern.pattern_uniqid);
    } catch {
      setDeleting(false);
    }
  };

  const downloaded = pattern.local_version !== null;
  const groups = routing ? groupRouting(routing, pattern.game_type) : [];

  return (
    <>
    <div className="rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] bg-[var(--pg-surface)]">
      <div className="flex items-center justify-between gap-3 p-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-[var(--pg-text)] truncate">{pattern.name}</h3>
          <div className="flex items-center gap-4 mt-1 text-sm text-[var(--pg-text-dim)] flex-wrap">
            <span>{t('cards:gameType', { type: pattern.game_type })}</span>
            <span>
              {t('cards:version', { version: formatVersion(pattern.local_version) })}
              {pattern.local_version !== pattern.remote_version && (
                <span className="text-amber-400 ml-1">{t('cards:serverVersion', { version: formatVersion(pattern.remote_version) })}</span>
              )}
            </span>
            <span className="font-mono text-xs px-2 py-1 rounded bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)]">
              {pattern.pattern_uniqid}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={toggleDetails}
            className="pg-btn pg-btn--ghost pg-btn--sm"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>{t('cards:details')}</span>
          </button>
          <button
            onClick={() => setConfirmOpen(true)}
            disabled={deleting}
            title={t('cards:removeFromDevice')}
            className="flex items-center gap-1 px-3 py-2 rounded-[var(--pg-radius-md)] text-sm bg-red-500/10 hover:bg-red-500/20 text-red-400 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-[var(--pg-line)] px-4 py-4">
          {loadingDetails ? (
            <div className="flex items-center gap-2 text-[var(--pg-text-dim)] text-sm">
              <RefreshCw className="w-4 h-4 animate-spin" />
              {t('cards:loadingRouting')}
            </div>
          ) : !downloaded ? (
            <p className="text-[var(--pg-text-dim)] italic text-sm">
              {t('cards:routingNotDownloaded')}
            </p>
          ) : groups.length === 0 ? (
            <p className="text-[var(--pg-text-dim)] italic text-sm">{t('cards:noStationAssignments')}</p>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g.itemIndex} className="rounded-md bg-[var(--pg-surface-2)] p-3">
                  <div className="font-medium text-[var(--pg-text)] mb-2">{g.itemLabel}</div>
                  <div className="space-y-1.5">
                    {g.assignments.map((a, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm flex-wrap">
                        <span className="text-[var(--pg-text-dim)] min-w-[7rem]">{t('cards:assignmentLabel', { label: a.label })}</span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {a.stations.map((s, j) => {
                            const number = stations[String(s)];
                            return (
                              <span
                                key={j}
                                className="inline-flex items-center gap-1.5 font-mono text-xs px-2 py-0.5 rounded bg-[var(--pg-accent-tint)] text-[var(--pg-accent-bright)]"
                              >
                                {number != null ? (
                                  <>
                                    <span>{t('cards:stationNumber', { number })}</span>
                                    <span className="opacity-60">{t('cards:stationId', { id: s })}</span>
                                  </>
                                ) : (
                                  <span>{t('cards:station', { number: s })}</span>
                                )}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>

      <ConfirmDialog
        isOpen={confirmOpen}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
        title={t('cards:removeTitle')}
        message={t('cards:confirmRemove', { name: pattern.name })}
        confirmText={t('cards:removeConfirm')}
        cancelText={t('cards:cancel')}
        variant="danger"
      />
    </>
  );
}

// Show the full pattern version including its minor part: studio bumps versions
// by 0.1 on each publish, but a whole value (1.0) arrives as the integer `1`.
// Force at least one decimal so the UI reads "1.0" / "1.1" rather than "1".
function formatVersion(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

// --- Routing detail helpers -------------------------------------------------

interface RoutingGroup {
  itemIndex: number;
  itemLabel: string;
  assignments: { label: string; stations: number[] }[];
}

// The noun a pattern's items map to, per game type. Patterns are
// scenario-agnostic (they only carry indices + station codes), so labels are
// generic positional names rather than the specific enigma/checkpoint titles.
function itemNoun(gameType: string): string {
  switch (gameType.toLowerCase()) {
    case 'tracks':
      return 'Checkpoint';
    case 'mystery':
      return 'Enigma';
    case 'tagquest':
      return 'Quest';
    default:
      return 'Item';
  }
}

function assignmentLabel(type: string): string {
  switch (type) {
    case 'good_answer_station':
      return 'Good answer';
    case 'wrong_answer_station':
      return 'Wrong answer';
    case 'checkpoint_station':
      return 'Checkpoint';
    default:
      return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

function groupRouting(items: patternStore.PatternRoutingItem[], gameType: string): RoutingGroup[] {
  const noun = itemNoun(gameType);
  const byItem = new Map<number, Map<string, number[]>>();
  for (const it of items) {
    let assignments = byItem.get(it.item_index);
    if (!assignments) {
      assignments = new Map();
      byItem.set(it.item_index, assignments);
    }
    const stations = assignments.get(it.assignment_type) ?? [];
    stations.push(it.station_key_number);
    assignments.set(it.assignment_type, stations);
  }
  return Array.from(byItem.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([idx, assignments]) => ({
      itemIndex: idx,
      itemLabel: `${noun} ${idx}`,
      assignments: Array.from(assignments.entries()).map(([type, stations]) => ({
        label: assignmentLabel(type),
        stations,
      })),
    }));
}
