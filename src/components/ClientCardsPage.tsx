import { useCallback, useEffect, useState } from 'react';
import { CreditCard, RefreshCw, Package, Layers } from 'lucide-react';
import * as patternStore from '../services/patternStore';
import { runCycleNow, getState } from '../services/syncOrchestrator';
import { on } from '../services/syncEvents';
import { useAuth } from './auth/AuthProvider';
import { CardsManager } from './cards/CardsManager';

// Cards & patterns overview for the currently-authenticated client. Layout
// mirrors ConfigurationPage: a left sidebar with tab buttons + a main panel
// that renders the active section. Cards CRUD is handled by CardsManager;
// patterns are display-only (synced from studio).

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
                    />
                    <PatternSection
                      title="Custom Patterns"
                      rows={customPatterns}
                      icon={<Layers className="text-blue-400" size={24} />}
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
}: {
  title: string;
  rows: patternStore.PatternRow[];
  icon: React.ReactNode;
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
            <div
              key={p.pattern_uniqid}
              className="flex items-center justify-between p-4 rounded-lg border border-slate-700 bg-slate-900/40"
            >
              <div className="flex-1">
                <h3 className="font-semibold text-white">{p.name}</h3>
                <div className="flex items-center gap-4 mt-1 text-sm text-slate-400 flex-wrap">
                  <span>Game type: {p.game_type}</span>
                  <span>
                    Version: {p.local_version ?? '—'}
                    {p.local_version !== p.remote_version && (
                      <span className="text-amber-400 ml-1">(server v{p.remote_version})</span>
                    )}
                  </span>
                  <span className="font-mono text-xs px-2 py-1 rounded bg-slate-800 text-slate-300">
                    {p.pattern_uniqid}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
