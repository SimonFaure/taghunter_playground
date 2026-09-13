import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trophy, Clock, Zap, Star, Medal, Users, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { getLaunchedGameState, getLaunchedGameMeta } from '../services/launchedGames';
import type { GameConfig, Team as ConfigTeam } from './LaunchGameModal';

interface LeaderboardPanelProps {
  launchedGameId: number;
  gameName: string;
  config?: Partial<GameConfig>;
  compact?: boolean;
}

interface TeamResult {
  id: number;
  team_number: number;
  team_name: string;
  score: number;
  start_time: number | null;
  end_time: number | null;
  key_id: number;
}

interface RankedTeam extends TeamResult {
  rank: number;
  rankDelta: number | null;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getRankColor(index: number): string {
  if (index === 0) return 'text-yellow-400';
  if (index === 1) return 'text-slate-300';
  if (index === 2) return 'text-amber-500';
  return 'text-[var(--pg-text-muted)]';
}

function getRankBg(index: number, movingUp: boolean, movingDown: boolean): string {
  if (movingUp) return 'bg-emerald-500/15 border-emerald-400/50';
  if (movingDown) return 'bg-red-500/10 border-red-400/35';
  if (index === 0) return 'bg-yellow-400/10 border-yellow-400/30';
  if (index === 1) return 'bg-slate-300/10 border-slate-300/20';
  if (index === 2) return 'bg-amber-500/10 border-amber-500/25';
  return 'bg-[var(--pg-surface-2)] border-[var(--pg-line)]';
}

function RankIcon({ index, size = 18 }: { index: number; size?: number }) {
  if (index === 0) return <Trophy size={size} className="text-yellow-400" />;
  if (index === 1) return <Medal size={size} className="text-slate-300" />;
  if (index === 2) return <Medal size={size} className="text-amber-500" />;
  return <span className="text-[var(--pg-text-dim)] font-bold text-xs w-4 text-center inline-block">#{index + 1}</span>;
}

function sortTeams(teams: TeamResult[], victoryType: string): TeamResult[] {
  return [...teams].sort((a, b) => {
    if (victoryType === 'speed') {
      if (a.end_time && b.end_time) return a.end_time - b.end_time;
      if (a.end_time) return -1;
      if (b.end_time) return 1;
      if (a.start_time && b.start_time) return a.start_time - b.start_time;
      if (a.start_time) return -1;
      if (b.start_time) return 1;
      return 0;
    }
    return (b.score ?? 0) - (a.score ?? 0);
  });
}

export function LeaderboardPanel({ launchedGameId, gameName, config = {}, compact = false }: LeaderboardPanelProps) {
  // `tr`, not `t`: this file already uses `t` as the loop variable for a team.
  const { t: tr } = useTranslation('rankings');
  const [teams, setTeams] = useState<RankedTeam[]>([]);
  // Retours Ludiom #70 - see LeaderboardPage: after the operator closes the
  // game, an unfinished team is "did not finish", not "in progress".
  const [gameEnded, setGameEnded] = useState(false);
  const [isClash, setIsClash] = useState(false);
  const [teamsConfig, setTeamsConfig] = useState<ConfigTeam[]>(config.teams || []);
  const [playMode, setPlayMode] = useState<'solo' | 'team'>(config.playMode || 'solo');
  const [victoryType, setVictoryType] = useState<'speed' | 'score'>(config.victoryType || 'score');
  const [loading, setLoading] = useState(true);

  const prevRanksRef = useRef<Map<number, number>>(new Map());
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const prevPositionsRef = useRef<Map<number, DOMRect>>(new Map());
  const [flipAnimating, setFlipAnimating] = useState<Set<number>>(new Set());

  const processTeams = useCallback((raw: TeamResult[], vt: string): RankedTeam[] => {
    const sorted = sortTeams(raw, vt);
    return sorted.map((team, index) => {
      const rank = index + 1;
      const prevRank = prevRanksRef.current.get(team.id) ?? null;
      const rankDelta = prevRank !== null ? rank - prevRank : null;
      return { ...team, rank, rankDelta };
    });
  }, []);

  const updatePrevRanks = useCallback((ranked: RankedTeam[]) => {
    const map = new Map<number, number>();
    ranked.forEach(t => map.set(t.id, t.rank));
    prevRanksRef.current = map;
  }, []);

  const capturePositions = useCallback(() => {
    const positions = new Map<number, DOMRect>();
    cardRefs.current.forEach((el, id) => {
      positions.set(id, el.getBoundingClientRect());
    });
    prevPositionsRef.current = positions;
  }, []);

  const fetchTeams = useCallback(async (isInitial: boolean, vt: string) => {
    let data: Array<{ id: number; team_number: number; team_name: string; score: number; start_time: number | null; end_time: number | null; key_id: number }> = [];
    try {
      const state = await getLaunchedGameState(launchedGameId, 0);
      setGameEnded(!!state.ended);
      data = state.teams.map((t) => ({
        id: t.id,
        team_number: t.team_number,
        team_name: t.team_name ?? '',
        score: t.score,
        start_time: t.start_time,
        end_time: t.end_time,
        key_id: t.key_id ?? 0,
      }));
    } catch (err) {
      console.error('[LeaderboardPanel] fetchTeams failed:', err);
      return;
    }

    const ranked = processTeams(data, vt);

    if (!isInitial) {
      const movers = ranked.filter(t => t.rankDelta !== null && t.rankDelta !== 0);
      if (movers.length > 0) {
        capturePositions();
        setFlipAnimating(new Set(movers.map(t => t.id)));
      }
      setTeams(ranked);
      updatePrevRanks(ranked);
      if (movers.length > 0) {
        if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
        animationTimerRef.current = setTimeout(() => {
          setTeams(prev => prev.map(t => ({ ...t, rankDelta: null })));
          setFlipAnimating(new Set());
        }, 2000);
      }
    } else {
      updatePrevRanks(ranked);
      setTeams(ranked.map(t => ({ ...t, rankDelta: null })));
      setLoading(false);
    }
  }, [launchedGameId, processTeams, updatePrevRanks, capturePositions]);

  useLayoutEffect(() => {
    if (flipAnimating.size === 0) return;
    flipAnimating.forEach(id => {
      const el = cardRefs.current.get(id);
      const prevRect = prevPositionsRef.current.get(id);
      if (!el || !prevRect) return;
      const nextRect = el.getBoundingClientRect();
      const dy = prevRect.top - nextRect.top;
      if (Math.abs(dy) < 1) return;
      el.getAnimations().forEach(a => a.cancel());
      el.animate(
        [
          { transform: `translateY(${dy}px)`, zIndex: '10' },
          { transform: 'translateY(0px)', zIndex: '10' },
        ],
        { duration: 600, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)', fill: 'forwards' }
      );
    });
  }, [teams, flipAnimating]);

  useEffect(() => {
    let currentVt = config.victoryType || 'score';

    const init = async () => {
      try {
        const map = await getLaunchedGameMeta(launchedGameId);
        if (map.playMode === 'solo' || map.playMode === 'team') setPlayMode(map.playMode);
        if (map.victoryType === 'speed' || map.victoryType === 'score') {
          currentVt = map.victoryType;
          setVictoryType(map.victoryType);
        }
        if (map.teamsConfig) {
          try { setTeamsConfig(JSON.parse(map.teamsConfig)); } catch { /* swallow */ }
        }
        // Clash clans never get a start_time or an end_time, so the generic
        // status line read "Did not start" under every clan for the whole match
        // (retours #97). A registered clan IS in the match - the only states it
        // has are "playing" and "over".
        if (map.clash_config) setIsClash(true);
      } catch (err) {
        console.error('[LeaderboardPanel] meta load failed:', err);
      }

      await fetchTeams(true, currentVt);
      intervalRef.current = setInterval(() => fetchTeams(false, currentVt), 3000);
    };

    init();

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
    };
  }, [launchedGameId]);

  const iconSize = compact ? 14 : 18;
  const nameSize = compact ? 'text-sm' : 'text-base';
  const scoreSize = compact ? 'text-base' : 'text-xl';
  const rowPadding = compact ? 'px-3 py-2.5' : 'px-4 py-3';

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={`shrink-0 ${compact ? 'px-3 pt-3 pb-2' : 'px-4 pt-4 pb-3'} border-b border-[var(--pg-line)]`}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className={`font-bold text-[var(--pg-text)] truncate ${compact ? 'text-xs' : 'text-sm'}`}>{gameName}</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {playMode === 'team' && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-teal-500/15 border border-teal-500/25 text-teal-400 text-xs font-semibold">
                <Users size={10} />
                {tr('teamMode')}
              </span>
            )}
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--pg-surface-2)] border border-[var(--pg-line)] text-[var(--pg-text-dim)] text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
              {tr('live')}
            </span>
            {victoryType === 'speed' ? (
              <span className="flex items-center gap-1 text-orange-400 text-xs font-semibold">
                <Zap size={11} />
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[var(--pg-accent-bright)] text-xs font-semibold">
                <Star size={11} />
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-1.5">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-[var(--pg-text-dim)] text-xs">{tr('loadingShort')}</div>
          </div>
        ) : teams.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-[var(--pg-text-dim)] text-xs text-center">{tr('noTeamsYet')}</div>
          </div>
        ) : (
          teams.map(team => {
            const index = team.rank - 1;
            const movingUp = flipAnimating.has(team.id) && team.rankDelta !== null && team.rankDelta < 0;
            const movingDown = flipAnimating.has(team.id) && team.rankDelta !== null && team.rankDelta > 0;
            const duration = team.start_time && team.end_time ? team.end_time - team.start_time : null;
            const configTeam = teamsConfig.find(t => t.chipId === team.key_id || t.name === team.team_name);
            const teammates = playMode === 'team' ? (configTeam?.teammates ?? []) : [];

            return (
              <div
                key={team.id}
                ref={el => {
                  if (el) cardRefs.current.set(team.id, el);
                  else cardRefs.current.delete(team.id);
                }}
                className={`rounded-lg border ${getRankBg(index, movingUp, movingDown)} ${rowPadding} will-change-transform`}
                style={{
                  transition: !flipAnimating.has(team.id)
                    ? 'background-color 0.4s ease, border-color 0.4s ease'
                    : 'background-color 0.3s ease, border-color 0.3s ease',
                  boxShadow: movingUp
                    ? '0 0 0 1.5px rgb(52 211 153 / 0.5), 0 4px 16px rgb(52 211 153 / 0.15)'
                    : 'none',
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex flex-col items-center justify-center w-7 shrink-0 gap-0.5">
                    <RankIcon index={index} size={iconSize} />
                    {team.rankDelta !== null && team.rankDelta !== 0 ? (
                      <span className={`flex items-center gap-0.5 text-xs font-bold ${movingUp ? 'text-emerald-400' : 'text-red-400'}`}>
                        {movingUp ? <ArrowUp size={9} /> : <ArrowDown size={9} />}
                        {Math.abs(team.rankDelta)}
                      </span>
                    ) : (
                      <span className="text-[var(--pg-text-dim)] text-xs"><Minus size={9} /></span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className={`font-bold leading-tight truncate ${nameSize} ${movingUp ? 'text-emerald-300' : getRankColor(index)}`}>
                      {team.team_name}
                    </div>
                    <div className="text-[var(--pg-text-dim)] text-xs mt-0.5">
                      {isClash ? (
                        gameEnded ? tr('statusFinished') : tr('statusInProgress')
                      ) : team.end_time ? (
                        <span className="flex items-center gap-0.5"><Clock size={9} /> {tr('statusFinished')}</span>
                      ) : team.start_time
                        ? (gameEnded ? tr('statusNotFinished') : tr('statusInProgress'))
                        : tr('statusNotStarted')}
                    </div>
                    {!compact && teammates.length > 1 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {teammates.map((mate, mi) => (
                          <span key={mi} className="px-1.5 py-0.5 bg-[var(--pg-surface-3)] rounded-full text-xs text-[var(--pg-text-dim)]">
                            {mate.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="text-right shrink-0">
                    {victoryType === 'score' ? (
                      <div className={`font-bold ${scoreSize} ${movingUp ? 'text-emerald-400' : 'text-[var(--pg-text)]'}`}>
                        {team.score}
                        <span className="text-[var(--pg-text-dim)] text-xs font-normal ml-0.5">{tr('pts')}</span>
                      </div>
                    ) : duration !== null ? (
                      <div className={`font-bold ${scoreSize} ${movingUp ? 'text-emerald-400' : getRankColor(index)}`}>
                        {formatDuration(duration)}
                      </div>
                    ) : (
                      <div className="text-[var(--pg-text-dim)] text-sm">&mdash;</div>
                    )}
                    {victoryType === 'speed' && team.score > 0 && (
                      <div className="text-[var(--pg-text-dim)] text-xs">{team.score} {tr('pts')}</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <style>{`
        @keyframes bounceUp {
          0%   { transform: translateY(4px); opacity: 0; }
          60%  { transform: translateY(-3px); }
          100% { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
