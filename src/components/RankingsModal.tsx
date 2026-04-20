import { useState, useEffect } from 'react';
import { Trophy, X, Calendar, Gamepad2, ChevronRight, ChevronDown } from 'lucide-react';
import { supabase } from '../lib/db';

export type TimeRange = 'day' | 'week' | 'month' | 'trimester' | 'year' | 'all';

export interface ScenarioOption {
  uniqid: string;
  title: string;
}

export interface ActiveGameOption {
  id: number;
  name: string;
  game_uniqid: string;
  scenarioTitle: string;
}

interface RankingsModalProps {
  onClose: () => void;
  onOpenTimeRange: (scenario: ScenarioOption, timeRange: TimeRange) => void;
  onOpenActiveGames: (games: ActiveGameOption[]) => void;
}

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
  { value: 'trimester', label: 'This Quarter' },
  { value: 'year', label: 'This Year' },
  { value: 'all', label: 'All Time' },
];

export function RankingsModal({ onClose, onOpenTimeRange, onOpenActiveGames }: RankingsModalProps) {
  const [scenarios, setScenarios] = useState<ScenarioOption[]>([]);
  const [activeGames, setActiveGames] = useState<ActiveGameOption[]>([]);
  const [loadingScenarios, setLoadingScenarios] = useState(true);
  const [loadingActive, setLoadingActive] = useState(true);
  const [selectedScenario, setSelectedScenario] = useState<ScenarioOption | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>('all');
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [tab, setTab] = useState<'timerange' | 'active'>('timerange');
  const [selectedGameIds, setSelectedGameIds] = useState<Set<number>>(new Set());

  const MAX_SELECTION = 4;

  const toggleGame = (id: number) => {
    setSelectedGameIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_SELECTION) {
        next.add(id);
      }
      return next;
    });
  };

  useEffect(() => {
    const loadScenarios = async () => {
      const { data } = await supabase
        .from('scenarios')
        .select('uniqid, title')
        .order('title');
      if (data) {
        const opts = data.map(s => ({ uniqid: s.uniqid, title: s.title }));
        setScenarios(opts);
        if (opts.length > 0) setSelectedScenario(opts[0]);
      }
      setLoadingScenarios(false);
    };

    const loadActiveGames = async () => {
      const { data } = await supabase
        .from('launched_games')
        .select('id, name, game_uniqid')
        .eq('ended', false)
        .order('created_at', { ascending: false });

      if (data && data.length > 0) {
        const uniqids = [...new Set(data.map(g => g.game_uniqid))];
        const { data: scenData } = await supabase
          .from('scenarios')
          .select('uniqid, title')
          .in('uniqid', uniqids);

        const scenMap: Record<string, string> = {};
        scenData?.forEach(s => { scenMap[s.uniqid] = s.title; });

        setActiveGames(data.map(g => ({
          id: g.id,
          name: g.name,
          game_uniqid: g.game_uniqid,
          scenarioTitle: scenMap[g.game_uniqid] || g.game_uniqid,
        })));
      }
      setLoadingActive(false);
    };

    loadScenarios();
    loadActiveGames();
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-700/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-yellow-400/15 flex items-center justify-center">
              <Trophy size={16} className="text-yellow-400" />
            </div>
            <h2 className="text-lg font-bold text-white">Rankings</h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-white transition-colors w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex border-b border-slate-700/60">
          <button
            onClick={() => setTab('timerange')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
              tab === 'timerange'
                ? 'text-white border-b-2 border-blue-500 bg-blue-500/5'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            <Calendar size={15} />
            Time Range
          </button>
          <button
            onClick={() => setTab('active')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
              tab === 'active'
                ? 'text-white border-b-2 border-emerald-500 bg-emerald-500/5'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            <Gamepad2 size={15} />
            Active Games
            {!loadingActive && activeGames.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold">
                {activeGames.length}
              </span>
            )}
          </button>
        </div>

        <div className="p-6">
          {tab === 'timerange' ? (
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Scenario
                </label>
                {loadingScenarios ? (
                  <div className="h-10 bg-slate-800 rounded-lg animate-pulse" />
                ) : scenarios.length === 0 ? (
                  <p className="text-slate-500 text-sm">No scenarios found.</p>
                ) : (
                  <div className="relative">
                    <button
                      onClick={() => setScenarioOpen(v => !v)}
                      className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-800 border border-slate-600 hover:border-slate-500 rounded-lg text-sm text-white transition-colors"
                    >
                      <span className="truncate">{selectedScenario?.title ?? 'Select a scenario'}</span>
                      <ChevronDown size={15} className={`text-slate-400 shrink-0 ml-2 transition-transform ${scenarioOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {scenarioOpen && (
                      <div className="absolute z-10 mt-1 w-full bg-slate-800 border border-slate-600 rounded-lg shadow-xl max-h-52 overflow-y-auto">
                        {scenarios.map(s => (
                          <button
                            key={s.uniqid}
                            onClick={() => { setSelectedScenario(s); setScenarioOpen(false); }}
                            className={`w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-slate-700 ${
                              selectedScenario?.uniqid === s.uniqid ? 'text-blue-400 bg-blue-500/10' : 'text-white'
                            }`}
                          >
                            {s.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Time Range
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {TIME_RANGES.map(range => (
                    <button
                      key={range.value}
                      onClick={() => setSelectedTimeRange(range.value)}
                      className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                        selectedTimeRange === range.value
                          ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                          : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white border border-slate-700'
                      }`}
                    >
                      {range.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                disabled={!selectedScenario}
                onClick={() => selectedScenario && onOpenTimeRange(selectedScenario, selectedTimeRange)}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold transition-colors"
              >
                View Rankings
                <ChevronRight size={16} />
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {loadingActive ? (
                <div className="space-y-2">
                  {[1, 2].map(i => (
                    <div key={i} className="h-16 bg-slate-800 rounded-xl animate-pulse" />
                  ))}
                </div>
              ) : activeGames.length === 0 ? (
                <div className="text-center py-8">
                  <Gamepad2 size={32} className="text-slate-600 mx-auto mb-3" />
                  <p className="text-slate-400 text-sm">No active games running right now.</p>
                </div>
              ) : (
                <>
                  <p className="text-xs text-slate-500">
                    Select up to {MAX_SELECTION} games to compare side by side.
                    {selectedGameIds.size === MAX_SELECTION && (
                      <span className="text-amber-400 ml-1">Maximum reached.</span>
                    )}
                  </p>
                  <div className="space-y-2">
                    {activeGames.map(game => {
                      const selected = selectedGameIds.has(game.id);
                      const disabled = !selected && selectedGameIds.size >= MAX_SELECTION;
                      return (
                        <button
                          key={game.id}
                          onClick={() => !disabled && toggleGame(game.id)}
                          disabled={disabled}
                          className={`w-full flex items-center gap-3 p-4 rounded-xl border text-left transition-all ${
                            selected
                              ? 'bg-emerald-500/10 border-emerald-500/50'
                              : disabled
                              ? 'bg-slate-800/40 border-slate-700/40 opacity-40 cursor-not-allowed'
                              : 'bg-slate-800 border-slate-700 hover:border-slate-500'
                          }`}
                        >
                          <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                            selected ? 'bg-emerald-500 border-emerald-500' : 'border-slate-600'
                          }`}>
                            {selected && (
                              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                                <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </div>

                          <div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="text-white font-semibold text-sm leading-tight truncate">{game.name}</div>
                            <div className="text-slate-500 text-xs mt-0.5">{game.scenarioTitle}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <button
                    disabled={selectedGameIds.size === 0}
                    onClick={() => {
                      const selected = activeGames.filter(g => selectedGameIds.has(g.id));
                      if (selected.length > 0) onOpenActiveGames(selected);
                    }}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold transition-colors mt-1"
                  >
                    View Rankings
                    {selectedGameIds.size > 0 && (
                      <span className="px-1.5 py-0.5 bg-white/20 rounded-md text-xs font-bold">
                        {selectedGameIds.size}
                      </span>
                    )}
                    <ChevronRight size={16} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
