import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trophy, ArrowLeft, Clock, Medal, Calendar, Zap, Star, Users, X } from 'lucide-react';
import {
  listLaunchedGames,
  getLaunchedGameMeta,
  getLaunchedGameState,
} from '../services/launchedGames';
import type { TimeRange, ScenarioOption } from './RankingsModal';
import { closeSelfProjectorWindow } from '../services/projectorWindow';
import { pushOverlay, popOverlay } from '../services/screenState';

interface TimeRangeLeaderboardProps {
  scenario: ScenarioOption;
  timeRange: TimeRange;
  onBack: () => void;
  /** When true, render as the dedicated projector window - hides the back
   *  button, scales typography for big-screen viewing, and wires Esc to
   *  close-self. */
  projectorMode?: boolean;
}

interface TeamEntry {
  key: string;
  team_name: string;
  score: number;
  duration: number | null;
  launched_game_name: string;
  game_date: string;
}

function getTimeRangeStart(range: TimeRange): Date | null {
  const now = new Date();
  switch (range) {
    case 'day':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - d.getDay());
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'trimester': {
      const quarter = Math.floor(now.getMonth() / 3);
      return new Date(now.getFullYear(), quarter * 3, 1);
    }
    case 'year':
      return new Date(now.getFullYear(), 0, 1);
    case 'all':
      return null;
  }
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const TIME_RANGE_KEY: Record<TimeRange, string> = {
  day: 'rangeDay',
  week: 'rangeWeek',
  month: 'rangeMonth',
  trimester: 'rangeTrimester',
  year: 'rangeYear',
  all: 'rangeAll',
};

function getRankBg(index: number): string {
  if (index === 0) return 'bg-yellow-400/10 border-yellow-400/30';
  if (index === 1) return 'bg-slate-300/10 border-slate-300/20';
  if (index === 2) return 'bg-amber-500/10 border-amber-500/25';
  return 'bg-[var(--pg-surface-2)] border-[var(--pg-line)]';
}

function getRankColor(index: number): string {
  if (index === 0) return 'text-yellow-400';
  if (index === 1) return 'text-slate-300';
  if (index === 2) return 'text-amber-500';
  return 'text-[var(--pg-text-muted)]';
}

function RankIcon({ index }: { index: number }) {
  if (index === 0) return <Trophy size={22} className="text-yellow-400" />;
  if (index === 1) return <Medal size={22} className="text-slate-300" />;
  if (index === 2) return <Medal size={22} className="text-amber-500" />;
  return <span className="text-[var(--pg-text-dim)] font-bold text-sm w-5 text-center inline-block">#{index + 1}</span>;
}

export function TimeRangeLeaderboard({ scenario, timeRange, onBack, projectorMode = false }: TimeRangeLeaderboardProps) {
  const { t } = useTranslation('rankings');
  const rangeLabel = t(TIME_RANGE_KEY[timeRange]);
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [victoryType, setVictoryType] = useState<'speed' | 'score'>('score');
  const [playMode, setPlayMode] = useState<'solo' | 'team'>('solo');
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);

  // Report "showing a ranking" to paired mothers while this page is mounted
  // (mirrors LeaderboardPage - same overlay, scenario time-range variant).
  // Skip in the projector child window (shared device state - see LeaderboardPage).
  useEffect(() => {
    if (projectorMode) return;
    pushOverlay('ranking');
    return () => popOverlay('ranking');
  }, [projectorMode]);

  // Esc-to-close inside the projector window (mirrors LeaderboardPage).
  useEffect(() => {
    if (!projectorMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void closeSelfProjectorWindow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [projectorMode]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setVisible(false);

      const rangeStart = getTimeRangeStart(timeRange);

      // Cross-game leaderboard: client-side aggregation. Pull all this client's
      // launched_games, filter to the scenario + time range, then for each
      // matching game fetch teams and meta. With most venues running tens of
      // games, the round-trip cost is acceptable for a manual leaderboard view.
      let allGames;
      try {
        allGames = await listLaunchedGames();
      } catch (err) {
        console.error('[TimeRangeLeaderboard] listLaunchedGames failed:', err);
        setTeams([]);
        setLoading(false);
        setTimeout(() => setVisible(true), 50);
        return;
      }

      const cutoffMs = rangeStart ? rangeStart.getTime() : 0;
      const launchedGames = allGames.filter((g) => {
        if (g.game_uniqid !== scenario.uniqid) return false;
        if (cutoffMs > 0 && g.created_at) {
          if (new Date(g.created_at).getTime() < cutoffMs) return false;
        }
        return true;
      });

      if (launchedGames.length === 0) {
        setTeams([]);
        setLoading(false);
        setTimeout(() => setVisible(true), 50);
        return;
      }

      const entries: TeamEntry[] = [];
      let resolvedVictoryType: 'speed' | 'score' = 'score';
      for (const game of launchedGames) {
        try {
          const [state, meta] = await Promise.all([
            getLaunchedGameState(game.id, 0),
            getLaunchedGameMeta(game.id),
          ]);
          if (meta.victoryType === 'speed' || meta.victoryType === 'score') {
            resolvedVictoryType = meta.victoryType;
            setVictoryType(meta.victoryType);
          }
          if (meta.playMode === 'solo' || meta.playMode === 'team') {
            setPlayMode(meta.playMode);
          }
          for (const t of state.teams) {
            const duration = t.start_time && t.end_time ? t.end_time - t.start_time : null;
            entries.push({
              key: `${game.id}-${t.id}`,
              team_name: t.team_name ?? '',
              score: t.score ?? 0,
              duration,
              launched_game_name: game.name,
              game_date: game.created_at ?? '',
            });
          }
        } catch (err) {
          console.warn('[TimeRangeLeaderboard] game fetch failed:', game.id, err);
        }
      }

      let sorted = entries;
      if (resolvedVictoryType === 'speed') {
        sorted = entries.sort((a, b) => {
          if (a.duration !== null && b.duration !== null) return a.duration - b.duration;
          if (a.duration !== null) return -1;
          if (b.duration !== null) return 1;
          return 0;
        });
      } else {
        sorted = entries.sort((a, b) => b.score - a.score);
      }

      setTeams(sorted);
      setLoading(false);
      setTimeout(() => setVisible(true), 50);
    };

    load();
  }, [scenario.uniqid, timeRange]);

  return (
    <div
      className="fixed inset-0 z-[200] bg-[var(--pg-app-bg)] overflow-auto"
      style={projectorMode ? { zoom: 1.5 } : undefined}
    >
      <div
        className="min-h-screen flex flex-col"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(20px)',
          transition: 'opacity 0.5s ease, transform 0.5s ease',
        }}
      >
        <header className="flex items-center justify-between px-6 py-5 border-b border-[var(--pg-line)]">
          {projectorMode ? (
            /* Retours Ludiom #71: a visible way out of the projector window,
               not just the undiscoverable Esc key. */
            <button
              onClick={() => void closeSelfProjectorWindow()}
              className="flex items-center gap-2 text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] transition-colors text-sm font-medium"
              title={t('closeWindowTitle')}
              aria-label={t('closeWindowTitle')}
            >
              <X size={18} />
              {t('closeWindow')}
            </button>
          ) : (
            <button
              onClick={onBack}
              className="flex items-center gap-2 text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] transition-colors text-sm font-medium"
            >
              <ArrowLeft size={18} />
              {t('back')}
            </button>
          )}

          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--pg-surface-2)] border border-[var(--pg-line)] text-[var(--pg-text-dim)] text-xs font-medium">
              <Calendar size={12} />
              {rangeLabel}
            </span>
            {playMode === 'team' && (
              <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-teal-500/15 border border-teal-500/30 text-teal-400 text-xs font-semibold uppercase tracking-wide">
                <Users size={12} />
                {t('teamMode')}
              </span>
            )}
            {victoryType === 'speed' ? (
              <span className="flex items-center gap-1.5 text-orange-400 text-xs font-semibold uppercase tracking-wide">
                <Zap size={13} />
                {t('speed')}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[var(--pg-accent-bright)] text-xs font-semibold uppercase tracking-wide">
                <Star size={13} />
                {t('score')}
              </span>
            )}
          </div>
        </header>

        <div className="flex-1 flex flex-col items-center px-4 py-10 max-w-2xl mx-auto w-full">
          <div className="mb-10 text-center">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-yellow-400/10 border-2 border-yellow-400/40 mb-5">
              <Trophy size={36} className="text-yellow-400" />
            </div>
            <h1 className="text-4xl font-bold text-[var(--pg-text)] tracking-tight mb-1">{t('title')}</h1>
            <p className="text-[var(--pg-accent-bright)] font-medium text-base mt-1">{scenario.title}</p>
            <p className="text-[var(--pg-text-dim)] text-sm mt-1">{rangeLabel}</p>
          </div>

          {loading ? (
            <div className="w-full space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-20 bg-[var(--pg-surface-2)] rounded-xl animate-pulse" />
              ))}
            </div>
          ) : teams.length === 0 ? (
            <div className="text-center py-16">
              <Trophy size={36} className="text-[var(--pg-text-dim)] mx-auto mb-3" />
              <p className="text-[var(--pg-text-dim)]">{t('noResults')}</p>
            </div>
          ) : (
            <div className="w-full space-y-3">
              {teams.map((team, index) => (
                <div
                  key={team.key}
                  className={`rounded-xl border ${getRankBg(index)} px-5 py-4`}
                  style={{
                    opacity: visible ? 1 : 0,
                    transform: visible ? 'translateX(0)' : 'translateX(-16px)',
                    transition: `opacity 0.4s ease ${index * 0.05}s, transform 0.4s ease ${index * 0.05}s`,
                  }}
                >
                  <div className="flex items-center gap-4">
                    <div className="flex items-center justify-center w-10 shrink-0">
                      <RankIcon index={index} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className={`font-bold text-lg leading-tight truncate ${getRankColor(index)}`}>
                        {team.team_name}
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-[var(--pg-text-dim)] text-xs truncate max-w-[180px]">{team.launched_game_name}</span>
                        {team.game_date && (
                          <>
                            <span className="text-[var(--pg-text-dim)] text-xs">·</span>
                            <span className="flex items-center gap-1 text-[var(--pg-text-dim)] text-xs">
                              <Calendar size={10} />
                              {formatDate(team.game_date)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      {victoryType === 'speed' && team.duration !== null ? (
                        <>
                          <div className={`text-xl font-bold ${getRankColor(index)}`}>
                            {formatDuration(team.duration)}
                          </div>
                          <div className="text-[var(--pg-text-dim)] text-xs mt-0.5 flex items-center justify-end gap-1">
                            <Clock size={10} />
                            {t('timeLabel')}
                          </div>
                        </>
                      ) : victoryType === 'score' ? (
                        <>
                          <div className={`text-xl font-bold ${index === 0 ? 'text-yellow-400' : 'text-[var(--pg-text)]'}`}>
                            {team.score}
                            <span className="text-[var(--pg-text-dim)] text-sm font-normal ml-1">{t('pts')}</span>
                          </div>
                          <div className="text-[var(--pg-text-dim)] text-xs mt-0.5">{t('scoreLabel')}</div>
                        </>
                      ) : (
                        <div className="text-[var(--pg-text-dim)] text-sm">&mdash;</div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
