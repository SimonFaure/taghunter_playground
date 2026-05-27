import { useCallback, useEffect, useState } from 'react';
import { CreditCard, RefreshCw, Package, Layers, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import * as patternStore from '../services/patternStore';
import { runCycleNow, getState } from '../services/syncOrchestrator';
import { on } from '../services/syncEvents';
import { useAuth } from './auth/AuthProvider';
import { CardsManager } from './cards/CardsManager';

// Cards & patterns overview for the currently-authenticated client. Layout
// mirrors ConfigurationPage: a left sidebar with tab buttons + a main panel
// that renders the active section. Cards CRUD is handled by CardsManager.
// Patterns are synced from studio; each one can be expanded to inspect its
// station→item routing and removed from this device (re-syncs from cloud).

type CardsTab = 'cards' | 'patterns';

export default function ClientCardsPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<CardsTab>('cards');
  const [defaultPatterns, setDefaultPatterns] = useState<patternStore.PatternRow[]>([]);
  const [customPatterns, setCustomPatterns] = useState<patternStore.PatternRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white py-8">
      <div className="container mx-auto px-6">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <CreditCard className="text-blue-400" size={32} />
            <h1 className="text-3xl font-bold">Cards &amp; Patterns</h1>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing || getState().cycleInFlight}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            <span>Sync now</span>
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
                {loading ? (
                  <Section icon={<Package className="text-blue-400" size={24} />} title="Patterns">
                    <div className="flex items-center justify-center py-10">
                      <RefreshCw className="w-8 h-8 text-slate-400 animate-spin" />
                    </div>
                  </Section>
                ) : (
                  <>
                    <PatternSection
                      title="Default Patterns"
                      rows={defaultPatterns}
                      icon={<Package className="text-blue-400" size={24} />}
                      onDelete={handleDeletePattern}
                    />
                    <PatternSection
                      title="Custom Patterns"
                      rows={customPatterns}
                      icon={<Layers className="text-blue-400" size={24} />}
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
  const items: { tab: CardsTab; label: string; icon: React.ReactNode }[] = [
    { tab: 'cards', label: 'Cards', icon: <CreditCard size={16} /> },
    { tab: 'patterns', label: 'Patterns', icon: <Layers size={16} /> },
  ];
  return (
    <nav className="space-y-6 sticky top-24">
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 px-3 mb-2">Content</div>
        <div className="space-y-1">
          {items.map((item) => {
            const isActive = active === item.tab;
            return (
              <button
                key={item.tab}
                onClick={() => onChange(item.tab)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition text-left text-sm ${
                  isActive ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700/60'
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
    <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
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
  return (
    <Section
      icon={icon}
      title={`${title} (${rows.length})`}
    >
      {rows.length === 0 ? (
        <p className="text-slate-400 italic text-sm">None.</p>
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
  const [expanded, setExpanded] = useState(false);
  const [routing, setRouting] = useState<patternStore.PatternRoutingItem[] | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const toggleDetails = async () => {
    if (!expanded && routing === null) {
      setLoadingDetails(true);
      try {
        setRouting(await patternStore.getRouting(pattern.pattern_uniqid));
      } finally {
        setLoadingDetails(false);
      }
    }
    setExpanded((v) => !v);
  };

  const handleDelete = async () => {
    const ok = window.confirm(
      `Remove "${pattern.name}" from this device?\n\n` +
        'It will reappear on the next sync if it still exists in your account.'
    );
    if (!ok) return;
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
    <div className="rounded-lg border border-slate-700 bg-slate-900/40">
      <div className="flex items-center justify-between gap-3 p-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white truncate">{pattern.name}</h3>
          <div className="flex items-center gap-4 mt-1 text-sm text-slate-400 flex-wrap">
            <span>Game type: {pattern.game_type}</span>
            <span>
              Version: {pattern.local_version ?? '—'}
              {pattern.local_version !== pattern.remote_version && (
                <span className="text-amber-400 ml-1">(server v{pattern.remote_version})</span>
              )}
            </span>
            <span className="font-mono text-xs px-2 py-1 rounded bg-slate-800 text-slate-300">
              {pattern.pattern_uniqid}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={toggleDetails}
            className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Details</span>
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            title="Remove from this device"
            className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm bg-red-500/10 hover:bg-red-500/20 text-red-400 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-700 px-4 py-4">
          {loadingDetails ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Loading routing…
            </div>
          ) : !downloaded ? (
            <p className="text-slate-400 italic text-sm">
              Routing not downloaded yet — run a sync to fetch this pattern's data.
            </p>
          ) : groups.length === 0 ? (
            <p className="text-slate-400 italic text-sm">This pattern has no station assignments.</p>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g.itemIndex} className="rounded-md bg-slate-800/60 p-3">
                  <div className="font-medium text-slate-200 mb-2">{g.itemLabel}</div>
                  <div className="space-y-1.5">
                    {g.assignments.map((a, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm flex-wrap">
                        <span className="text-slate-400 min-w-[7rem]">{a.label}:</span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {a.stations.map((s, j) => (
                            <span
                              key={j}
                              className="font-mono text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-300"
                            >
                              station {s}
                            </span>
                          ))}
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
  );
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
