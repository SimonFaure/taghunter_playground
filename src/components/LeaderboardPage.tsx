import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { Trophy, ArrowLeft, Clock, Zap, Star, Medal, Users, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { supabase } from '../lib/db';
import { GameConfig, Team as ConfigTeam } from './LaunchGameModal';

interface LeaderboardPageProps {
  launchedGameId: number | null;
  config: GameConfig;
  gameName?: string;
  onBack: () => void;
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
  return 'text-slate-400';
}

function getRankBg(index: number, movingUp: boolean, movingDown: boolean): string {
  if (movingUp) return 'bg-emerald-500/15 border-emerald-400/50';
  if (movingDown) return 'bg-red-500/10 border-red-400/35';
  if (index === 0) return 'bg-yellow-400/10 border-yellow-400/30';
  if (index === 1) return 'bg-slate-300/10 border-slate-300/20';
  if (index === 2) return 'bg-amber-500/10 border-amber-500/25';
  return 'bg-slate-700/40 border-slate-600/30';
}

function RankIcon({ index }: { index: number }) {
  if (index === 0) return <Trophy size={22} className="text-yellow-400" />;
  if (index === 1) return <Medal size={22} className="text-slate-300" />;
  if (index === 2) return <Medal size={22} className="text-amber-500" />;
  return <span className="text-slate-400 font-bold text-sm w-5 text-center">#{index + 1}</span>;
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

export function LeaderboardPage({ launchedGameId, config, gameName, onBack }: LeaderboardPageProps) {
  const [teams, setTeams] = useState<RankedTeam[]>([]);
  const [teamsConfig, setTeamsConfig] = useState<ConfigTeam[]>(config.teams || []);
  const [playMode, setPlayMode] = useState<'solo' | 'team'>(config.playMode || 'solo');
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);

  const prevRanksRef = useRef<Map<number, number>>(new Map());
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // FLIP animation refs: map teamId -> DOM element
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Store positions before re-render
  const prevPositionsRef = useRef<Map<number, DOMRect>>(new Map());
  // Track which teams are mid-FLIP animation
  const [flipAnimating, setFlipAnimating] = useState<Set<number>>(new Set());

  const victoryType = config.victoryType || 'speed';

  const processTeams = useCallback((raw: TeamResult[]): RankedTeam[] => {
    const sorted = sortTeams(raw, victoryType);
    return sorted.map((team, index) => {
      const rank = index + 1;
      const prevRank = prevRanksRef.current.get(team.id) ?? null;
      const rankDelta = prevRank !== null ? rank - prevRank : null;
      return { ...team, rank, rankDelta };
    });
  }, [victoryType]);

  const updatePrevRanks = useCallback((ranked: RankedTeam[]) => {
    const map = new Map<number, number>();
    ranked.forEach(t => map.set(t.id, t.rank));
    prevRanksRef.current = map;
  }, []);

  // Capture current positions before state update
  const capturePositions = useCallback(() => {
    const positions = new Map<number, DOMRect>();
    cardRefs.current.forEach((el, id) => {
      positions.set(id, el.getBoundingClientRect());
    });
    prevPositionsRef.current = positions;
  }, []);

  const fetchTeams = useCallback(async (isInitial = false) => {
    if (!launchedGameId) return;

    const { data, error } = await supabase
      .from('teams')
      .select('id, team_number, team_name, score, start_time, end_time, key_id')
      .eq('launched_game_id', launchedGameId);

    if (error || !data) return;

    const ranked = processTeams(data);

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
      setTimeout(() => setVisible(true), 50);
    }
  }, [launchedGameId, processTeams, updatePrevRanks, capturePositions]);

  // FLIP: after DOM updates with new positions, compute delta and play animation
  useLayoutEffect(() => {
    if (flipAnimating.size === 0) return;

    flipAnimating.forEach(id => {
      const el = cardRefs.current.get(id);
      const prevRect = prevPositionsRef.current.get(id);
      if (!el || !prevRect) return;

      const nextRect = el.getBoundingClientRect();
      const dy = prevRect.top - nextRect.top;
      const scale = prevRect.height / nextRect.height;

      if (Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.01) return;

      // Cancel any running animation
      el.getAnimations().forEach(a => a.cancel());

      el.animate(
        [
          { transform: `translateY(${dy}px) scale(${scale})`, zIndex: '10' },
          { transform: 'translateY(0px) scale(1)', zIndex: '10' },
        ],
        {
          duration: 600,
          easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
          fill: 'forwards',
        }
      );
    });
  }, [teams, flipAnimating]);

  useEffect(() => {
    const loadMeta = async () => {
      if (!launchedGameId) return;
      const { data: metaData } = await supabase
        .from('launched_game_meta')
        .select('meta_name, meta_value')
        .eq('launched_game_id', launchedGameId)
        .in('meta_name', ['playMode', 'teamsConfig']);

      if (metaData) {
        const map: Record<string, string> = {};
        metaData.forEach(row => { map[row.meta_name] = row.meta_value || ''; });
        if (map.playMode === 'solo' || map.playMode === 'team') setPlayMode(map.playMode);
        if (map.teamsConfig) {
          try { setTeamsConfig(JSON.parse(map.teamsConfig)); } catch {}
        }
      }
    };

    loadMeta();
    fetchTeams(true);

    intervalRef.current = setInterval(() => fetchTeams(false), 3000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
    };
  }, [launchedGameId, fetchTeams]);

  return (
    <div className="fixed inset-0 z-[200] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 overflow-auto">
      <div
        className="min-h-screen flex flex-col"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(20px)',
          transition: 'opacity 0.5s ease, transform 0.5s ease',
        }}
      >
        <header className="flex items-center justify-between px-6 py-5 border-b border-slate-700/60">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium"
          >
            <ArrowLeft size={18} />
            Back
          </button>

          <div className="flex items-center gap-3 text-slate-400 text-sm">
            {playMode === 'team' && (
              <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-teal-500/15 border border-teal-500/30 text-teal-400 text-xs font-semibold uppercase tracking-wide">
                <Users size={12} />
                Team mode
              </span>
            )}
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
              Live
            </span>
            {victoryType === 'speed' ? (
              <>
                <Zap size={15} className="text-orange-400" />
                <span className="text-orange-400 font-semibold uppercase tracking-wide text-xs">Speed</span>
              </>
            ) : (
              <>
                <Star size={15} className="text-blue-400" />
                <span className="text-blue-400 font-semibold uppercase tracking-wide text-xs">Score</span>
              </>
            )}
          </div>
        </header>

        <div className="flex-1 flex flex-col items-center px-4 py-10 max-w-2xl mx-auto w-full">
          <div className="mb-10 text-center">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-yellow-400/10 border-2 border-yellow-400/40 mb-5">
              <Trophy size={36} className="text-yellow-400" />
            </div>
            <h1 className="text-4xl font-bold text-white tracking-tight mb-1">Rankings</h1>
            {gameName && (
              <p className="text-slate-400 text-base mt-1">{gameName}</p>
            )}
          </div>

          {loading ? (
            <div className="text-slate-400 text-center py-16">Loading rankings...</div>
          ) : teams.length === 0 ? (
            <div className="text-slate-400 text-center py-16">No team data found.</div>
          ) : (
            <div className="w-full space-y-3">
              {teams.map((team) => {
                const index = team.rank - 1;
                const movingUp = flipAnimating.has(team.id) && team.rankDelta !== null && team.rankDelta < 0;
                const movingDown = flipAnimating.has(team.id) && team.rankDelta !== null && team.rankDelta > 0;

                const duration =
                  team.start_time && team.end_time
                    ? team.end_time - team.start_time
                    : null;

                const configTeam = teamsConfig.find(
                  t => t.chipId === team.key_id || t.name === team.team_name
                );
                const teammates = playMode === 'team' ? (configTeam?.teammates ?? []) : [];

                return (
                  <div
                    key={team.id}
                    ref={el => {
                      if (el) cardRefs.current.set(team.id, el);
                      else cardRefs.current.delete(team.id);
                    }}
                    className={`rounded-xl border ${getRankBg(index, movingUp, movingDown)} px-5 pt-4 pb-4 will-change-transform`}
                    style={{
                      opacity: visible ? 1 : 0,
                      transition: !flipAnimating.has(team.id)
                        ? `opacity 0.4s ease ${index * 0.07}s, background-color 0.4s ease, border-color 0.4s ease`
                        : 'background-color 0.3s ease, border-color 0.3s ease',
                      transform: visible ? 'none' : 'translateX(-16px)',
                      boxShadow: movingUp
                        ? '0 0 0 2px rgb(52 211 153 / 0.6), 0 8px 32px rgb(52 211 153 / 0.2)'
                        : movingDown
                        ? '0 0 0 1px rgb(248 113 113 / 0.4)'
                        : 'none',
                    }}
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col items-center justify-center w-10 shrink-0 gap-1.5">
                        <div
                          style={{
                            transition: 'transform 0.3s ease',
                            transform: movingUp ? 'scale(1.25)' : 'scale(1)',
                          }}
                        >
                          <RankIcon index={index} />
                        </div>

                        {team.rankDelta !== null && team.rankDelta !== 0 ? (
                          <span
                            className={`flex items-center gap-0.5 text-xs font-bold ${movingUp ? 'text-emerald-400' : 'text-red-400'}`}
                            style={{
                              animation: movingUp ? 'bounceUp 0.5s ease' : undefined,
                            }}
                          >
                            {movingUp ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                            {Math.abs(team.rankDelta)}
                          </span>
                        ) : (
                          <span className="text-slate-600 text-xs">
                            <Minus size={11} />
                          </span>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div
                          className={`font-bold leading-tight ${movingUp ? 'text-emerald-300' : getRankColor(index)}`}
                          style={{
                            fontSize: movingUp ? '1.2rem' : '1.125rem',
                            transition: 'font-size 0.3s ease, color 0.3s ease',
                          }}
                        >
                          {team.team_name}
                        </div>
                        <div className="text-slate-500 text-xs mt-0.5 flex items-center gap-1">
                          {team.end_time ? (
                            <>
                              <Clock size={11} />
                              Finished
                            </>
                          ) : team.start_time ? (
                            'In progress'
                          ) : (
                            'Did not start'
                          )}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        {victoryType === 'score' ? (
                          <div
                            className={`font-bold transition-all duration-300 ${movingUp ? 'text-emerald-400' : 'text-white'}`}
                            style={{ fontSize: movingUp ? '1.4rem' : '1.25rem' }}
                          >
                            {team.score}
                            <span className="text-slate-400 text-sm font-normal ml-1">pts</span>
                          </div>
                        ) : duration !== null ? (
                          <div
                            className={`font-bold ${movingUp ? 'text-emerald-400' : getRankColor(index)}`}
                            style={{ fontSize: movingUp ? '1.4rem' : '1.25rem', transition: 'font-size 0.3s ease, color 0.3s ease' }}
                          >
                            {formatDuration(duration)}
                          </div>
                        ) : (
                          <div className="text-slate-500 text-sm">&mdash;</div>
                        )}

                        {victoryType === 'speed' && team.score > 0 && (
                          <div className="text-slate-500 text-xs mt-0.5">
                            {team.score} pts
                          </div>
                        )}
                      </div>
                    </div>

                    {teammates.length > 1 && (
                      <div className="mt-3 pt-3 border-t border-white/10 flex flex-wrap gap-2">
                        {teammates.map((mate, mi) => (
                          <span key={mi} className="flex items-center gap-1.5 px-2.5 py-1 bg-white/5 rounded-full text-xs text-slate-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-teal-400 inline-block" />
                            {mate.name}
                            <span className="text-slate-600">#{mate.chipNumber}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
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
