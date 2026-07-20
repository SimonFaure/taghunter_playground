import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Trophy, X, Calendar, Gamepad2, ChevronRight, ChevronDown } from 'lucide-react';
import * as scenarioStore from '../services/scenarioStore';
import { listActiveLaunchedGames } from '../services/launchedGames';

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

const timeRanges = (t: TFunction): { value: TimeRange; label: string }[] => [
  { value: 'day', label: t('operatorControls:rankings.rangeToday') },
  { value: 'week', label: t('operatorControls:rankings.rangeWeek') },
  { value: 'month', label: t('operatorControls:rankings.rangeMonth') },
  { value: 'trimester', label: t('operatorControls:rankings.rangeQuarter') },
  { value: 'year', label: t('operatorControls:rankings.rangeYear') },
  { value: 'all', label: t('operatorControls:rankings.rangeAll') },
];

export function RankingsModal({ onClose, onOpenTimeRange, onOpenActiveGames }: RankingsModalProps) {
  const { t } = useTranslation();
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
      try {
        const rows = await scenarioStore.list();
        const opts = rows
          .map((r) => ({ uniqid: r.uniqid, title: r.title }))
          .sort((a, b) => a.title.localeCompare(b.title));
        setScenarios(opts);
        if (opts.length > 0) setSelectedScenario(opts[0]);
      } catch (err) {
        console.error('[RankingsModal] loadScenarios failed:', err);
      } finally {
        setLoadingScenarios(false);
      }
    };

    const loadActiveGames = async () => {
      try {
        const games = await listActiveLaunchedGames();
        if (games.length > 0) {
          const titleByUniqid = new Map<string, string>();
          for (const uniq of new Set(games.map((g) => g.game_uniqid))) {
            const row = await scenarioStore.get(uniq);
            if (row) titleByUniqid.set(uniq, row.title);
          }
          setActiveGames(games.map((g) => ({
            id: g.id,
            name: g.name,
            game_uniqid: g.game_uniqid,
            scenarioTitle: titleByUniqid.get(g.game_uniqid) ?? g.game_uniqid,
          })));
        }
      } catch (err) {
        console.error('[RankingsModal] loadActiveGames failed:', err);
      } finally {
        setLoadingActive(false);
      }
    };

    loadScenarios();
    loadActiveGames();
  }, []);

  return (
    <div
      className="pg-overlay p-4"
      onClick={onClose}
    >
      <div
        className="pg-modal max-w-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="pg-modal-head">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-yellow-400/15 flex items-center justify-center">
              <Trophy size={16} className="text-yellow-400" />
            </div>
            <h2 className="pg-modal-title">{t('operatorControls:rankings.title')}</h2>
          </div>
          <button
            onClick={onClose}
            className="pg-modal-close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex border-b border-[var(--pg-line)]">
          <button
            onClick={() => setTab('timerange')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
              tab === 'timerange'
                ? 'text-[var(--pg-text)] border-b-2 border-[var(--pg-accent)] bg-[var(--pg-accent-tint)]'
                : 'text-[var(--pg-text-dim)] hover:text-[var(--pg-text-muted)]'
            }`}
          >
            <Calendar size={15} />
            {t('operatorControls:rankings.tabTimeRange')}
          </button>
          <button
            onClick={() => setTab('active')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
              tab === 'active'
                ? 'text-[var(--pg-text)] border-b-2 border-emerald-500 bg-emerald-500/5'
                : 'text-[var(--pg-text-dim)] hover:text-[var(--pg-text-muted)]'
            }`}
          >
            <Gamepad2 size={15} />
            {t('operatorControls:rankings.tabActiveGames')}
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
                <label className="block text-xs font-semibold text-[var(--pg-text-dim)] uppercase tracking-wider mb-2">
                  {t('operatorControls:rankings.scenario')}
                </label>
                {loadingScenarios ? (
                  <div className="h-10 bg-[var(--pg-surface-2)] rounded-lg animate-pulse" />
                ) : scenarios.length === 0 ? (
                  <p className="text-[var(--pg-text-dim)] text-sm">{t('operatorControls:rankings.noScenarios')}</p>
                ) : (
                  <div className="relative">
                    <button
                      onClick={() => setScenarioOpen(v => !v)}
                      className="w-full flex items-center justify-between px-4 py-2.5 bg-[var(--pg-surface-2)] border border-[var(--pg-line)] hover:border-[var(--pg-line-strong)] rounded-lg text-sm text-[var(--pg-text)] transition-colors"
                    >
                      <span className="truncate">{selectedScenario?.title ?? t('operatorControls:rankings.selectScenario')}</span>
                      <ChevronDown size={15} className={`text-[var(--pg-text-dim)] shrink-0 ml-2 transition-transform ${scenarioOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {scenarioOpen && (
                      <div className="absolute z-10 mt-1 w-full bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-lg shadow-xl max-h-52 overflow-y-auto">
                        {scenarios.map(s => (
                          <button
                            key={s.uniqid}
                            onClick={() => { setSelectedScenario(s); setScenarioOpen(false); }}
                            className={`w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-[var(--pg-surface-3)] ${
                              selectedScenario?.uniqid === s.uniqid ? 'text-[var(--pg-accent-bright)] bg-[var(--pg-accent-tint)]' : 'text-[var(--pg-text)]'
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
                <label className="block text-xs font-semibold text-[var(--pg-text-dim)] uppercase tracking-wider mb-2">
                  {t('operatorControls:rankings.timeRange')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {timeRanges(t).map(range => (
                    <button
                      key={range.value}
                      onClick={() => setSelectedTimeRange(range.value)}
                      className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                        selectedTimeRange === range.value
                          ? 'bg-[var(--pg-accent)] text-[var(--pg-text)]'
                          : 'bg-[var(--pg-surface-2)] text-[var(--pg-text-dim)] hover:bg-[var(--pg-surface-3)] hover:text-[var(--pg-text)] border border-[var(--pg-line)]'
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
                className="pg-btn pg-btn--primary w-full justify-center"
              >
                {t('operatorControls:rankings.viewRankings')}
                <ChevronRight size={16} />
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {loadingActive ? (
                <div className="space-y-2">
                  {[1, 2].map(i => (
                    <div key={i} className="h-16 bg-[var(--pg-surface-2)] rounded-xl animate-pulse" />
                  ))}
                </div>
              ) : activeGames.length === 0 ? (
                <div className="text-center py-8">
                  <Gamepad2 size={32} className="text-[var(--pg-text-dim)] mx-auto mb-3" />
                  <p className="text-[var(--pg-text-dim)] text-sm">{t('operatorControls:rankings.noActiveGames')}</p>
                </div>
              ) : (
                <>
                  <p className="text-xs text-[var(--pg-text-dim)]">
                    {t('operatorControls:rankings.selectUpTo', { count: MAX_SELECTION })}
                    {selectedGameIds.size === MAX_SELECTION && (
                      <span className="text-amber-400 ml-1">{t('operatorControls:rankings.maximumReached')}</span>
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
                              ? 'bg-[var(--pg-surface)] border-[var(--pg-line)] opacity-40 cursor-not-allowed'
                              : 'bg-[var(--pg-surface-2)] border-[var(--pg-line)] hover:border-[var(--pg-line-strong)]'
                          }`}
                        >
                          <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                            selected ? 'bg-emerald-500 border-emerald-500' : 'border-[var(--pg-line-strong)]'
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
                            <div className="text-[var(--pg-text)] font-semibold text-sm leading-tight truncate">{game.name}</div>
                            <div className="text-[var(--pg-text-dim)] text-xs mt-0.5">{game.scenarioTitle}</div>
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
                    {t('operatorControls:rankings.viewRankings')}
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
