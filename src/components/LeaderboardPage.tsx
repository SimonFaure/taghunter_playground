import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { Trophy, ArrowLeft, Clock, Zap, Star, Medal, Users, ArrowUp, ArrowDown, ArrowRight, Minus, MonitorUp, MonitorOff } from 'lucide-react';
import { getLaunchedGameState, getLaunchedGameMeta } from '../services/launchedGames';
import { pushOverlay, popOverlay } from '../services/screenState';
import { GameConfig, Team as ConfigTeam } from './LaunchGameModal';
import {
  openProjector,
  closeProjector,
  isProjectorOpenForTarget,
  closeSelfProjectorWindow,
} from '../services/projectorWindow';

interface LeaderboardPageProps {
  launchedGameId: number | null;
  config: GameConfig;
  gameName?: string;
  onBack: () => void;
  /** When true, render as the dedicated projector window - hides back button,
   *  scales typography for big-screen viewing, and wires Esc to close-self. */
  projectorMode?: boolean;
  /** When true (default), the board slowly creep-scrolls itself whenever the
   *  list overflows, and a right-edge badge announces every team that climbs.
   *  Set false for a static classic board. */
  autoScroll?: boolean;
}

/** A team that just moved up, queued for the right-edge climber badge. */
interface Climber {
  id: number;
  teamName: string;
  fromRank: number;
  toRank: number;
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

function RankIcon({ index }: { index: number }) {
  if (index === 0) return <Trophy size={22} className="text-yellow-400" />;
  if (index === 1) return <Medal size={22} className="text-slate-300" />;
  if (index === 2) return <Medal size={22} className="text-amber-500" />;
  return <span className="text-[var(--pg-text-dim)] font-bold text-sm w-5 text-center">#{index + 1}</span>;
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

export function LeaderboardPage({ launchedGameId, config, gameName, onBack, projectorMode = false, autoScroll = true }: LeaderboardPageProps) {
  const [teams, setTeams] = useState<RankedTeam[]>([]);
  const [teamsConfig, setTeamsConfig] = useState<ConfigTeam[]>(config.teams || []);
  const [playMode, setPlayMode] = useState<'solo' | 'team'>(config.playMode || 'solo');
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);
  const [projectorOpen, setProjectorOpen] = useState(false);
  const [projectorBusy, setProjectorBusy] = useState(false);
  // The top bar auto-hides; it slides back in only while the mouse is near the
  // top edge of the page. Hysteresis (reveal ≤80px, hide >140px) avoids flicker.
  const [headerVisible, setHeaderVisible] = useState(false);

  const prevRanksRef = useRef<Map<number, number>>(new Map());
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-scroll ("creep") + climber sidebar state.
  // The scroll container is the outer positioned div; the creep drives its
  // scrollTop directly via rAF. `pausedRef` is flipped by user interaction on
  // the operator device so manual scrolling always wins.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  // Right-edge "moving up" badges: a queue of climbers plus the one on screen.
  const [climberQueue, setClimberQueue] = useState<Climber[]>([]);
  const [currentClimber, setCurrentClimber] = useState<{ c: Climber; phase: 'in' | 'out' } | null>(null);

  // Cap the pending queue so the badge tracks *live* rank instead of falling
  // behind a long backlog - keep only the biggest jumps when a flood arrives.
  const enqueueClimbers = useCallback((incoming: Climber[]) => {
    setClimberQueue((prev) => {
      const combined = [...prev, ...incoming];
      if (combined.length <= 3) return combined;
      return [...combined]
        .sort((a, b) => Math.abs(b.fromRank - b.toRank) - Math.abs(a.fromRank - a.toRank))
        .slice(0, 3);
    });
  }, []);

  // Report "showing a ranking" to paired mothers while this page is mounted, so
  // the Devices modal pill reflects it (overlay wins over any in_game base).
  // Skip in the projector child window - it shares this device's reported state
  // with the main window and must not overwrite what the operator screen shows.
  useEffect(() => {
    if (projectorMode) return;
    pushOverlay('ranking');
    return () => popOverlay('ranking');
  }, [projectorMode]);

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
    let data: Array<{ id: number; team_number: number; team_name: string; score: number; start_time: number | null; end_time: number | null; key_id: number }> = [];
    try {
      const state = await getLaunchedGameState(launchedGameId, 0);
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
      console.error('[LeaderboardPage] fetchTeams failed:', err);
      return;
    }

    const ranked = processTeams(data);

    if (!isInitial) {
      const movers = ranked.filter(t => t.rankDelta !== null && t.rankDelta !== 0);
      if (movers.length > 0) {
        capturePositions();
        setFlipAnimating(new Set(movers.map(t => t.id)));
      }

      // Climbers (rank number decreased) feed the right-edge badge, so a jump
      // is seen even when the creep is parked far from that row. Detected here
      // with the transition captured "as it happened" (prevRank → newRank).
      if (autoScroll) {
        const climbers: Climber[] = ranked
          .filter(t => t.rankDelta !== null && t.rankDelta < 0)
          .map(t => ({
            id: t.id,
            teamName: t.team_name,
            fromRank: t.rank - (t.rankDelta as number),
            toRank: t.rank,
          }));
        if (climbers.length > 0) enqueueClimbers(climbers);
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
  }, [launchedGameId, processTeams, updatePrevRanks, capturePositions, autoScroll, enqueueClimbers]);

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
      try {
        const map = await getLaunchedGameMeta(launchedGameId);
        if (map.playMode === 'solo' || map.playMode === 'team') setPlayMode(map.playMode);
        if (map.teamsConfig) {
          try { setTeamsConfig(JSON.parse(map.teamsConfig)); } catch { /* swallow */ }
        }
      } catch (err) {
        console.error('[LeaderboardPage] meta load failed:', err);
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

  // Reveal the top bar only when the cursor approaches the top edge of the page.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= 80) setHeaderVisible(true);
      else if (e.clientY > 140) setHeaderVisible(false);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // Auto-scroll creep: a slow rAF loop that walks scrollTop down at ~20 px/s
  // while the list overflows, holds at the bottom, eases back to the top, and
  // repeats. Paused (via pausedRef) while the operator is interacting, and inert
  // when the content fits. The loop never interrupts for rank changes - those
  // are surfaced independently by the climber badge.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;

    const SPEED = 20;          // px/s downward creep
    const RETURN_DUR = 1.2;    // s to ease back to top
    const HOLD_BOTTOM = 3;     // s pause at the bottom
    const HOLD_TOP = 2;        // s pause at the top before creeping again

    let raf = 0;
    let last = 0;
    let phase: 'down' | 'holdBottom' | 'return' | 'holdTop' = 'down';
    let holdT = 0;
    let returnFrom = 0;
    let returnT = 0;

    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      if (!last) { last = ts; return; }
      const dt = Math.min((ts - last) / 1000, 0.05); // clamp tab-switch gaps
      last = ts;

      const max = el.scrollHeight - el.clientHeight;
      if (pausedRef.current || max <= 4) return; // paused or no overflow

      switch (phase) {
        case 'down':
          el.scrollTop = Math.min(max, el.scrollTop + SPEED * dt);
          if (el.scrollTop >= max - 0.5) { phase = 'holdBottom'; holdT = 0; }
          break;
        case 'holdBottom':
          holdT += dt;
          if (holdT >= HOLD_BOTTOM) { phase = 'return'; returnFrom = el.scrollTop; returnT = 0; }
          break;
        case 'return': {
          returnT += dt;
          const p = Math.min(1, returnT / RETURN_DUR);
          const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
          el.scrollTop = returnFrom * (1 - eased);
          if (p >= 1) { phase = 'holdTop'; holdT = 0; }
          break;
        }
        case 'holdTop':
          holdT += dt;
          if (holdT >= HOLD_TOP) phase = 'down';
          break;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoScroll]);

  // On the operator device, any manual scroll gesture pauses the creep for 8s
  // of idle, then it resumes from wherever the user left it. The projector
  // window has no user, so this wiring is skipped there.
  useEffect(() => {
    if (!autoScroll || projectorMode) return;
    const el = scrollRef.current;
    if (!el) return;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const grab = () => {
      pausedRef.current = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { pausedRef.current = false; }, 8000);
    };
    el.addEventListener('wheel', grab, { passive: true });
    el.addEventListener('touchstart', grab, { passive: true });
    el.addEventListener('pointerdown', grab);
    return () => {
      el.removeEventListener('wheel', grab);
      el.removeEventListener('touchstart', grab);
      el.removeEventListener('pointerdown', grab);
      if (idleTimer) clearTimeout(idleTimer);
      pausedRef.current = false;
    };
  }, [autoScroll, projectorMode]);

  // Climber badge pump: when the stage is free, pull the next climber from the
  // queue and show it. Each badge slides in, holds ~1.6s, slides out ~0.4s,
  // then clears - which frees the stage for the following climber.
  useEffect(() => {
    if (currentClimber || climberQueue.length === 0) return;
    const [next, ...rest] = climberQueue;
    setClimberQueue(rest);
    setCurrentClimber({ c: next, phase: 'in' });
  }, [climberQueue, currentClimber]);

  useEffect(() => {
    if (!currentClimber) return;
    if (currentClimber.phase === 'in') {
      const t = setTimeout(() => setCurrentClimber(cur => (cur ? { ...cur, phase: 'out' } : null)), 1600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setCurrentClimber(null), 400);
    return () => clearTimeout(t);
  }, [currentClimber]);

  // Esc-to-close inside the projector window. Disabled in the main window
  // because Esc is reserved for back-button-like navigation upstream.
  useEffect(() => {
    if (!projectorMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        void closeSelfProjectorWindow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [projectorMode]);

  // Refresh the toggle button state on mount and after each toggle action.
  // Polling keeps the button honest if the projector window is closed
  // externally (Esc, OS close, app crash) while this modal stays open.
  useEffect(() => {
    if (projectorMode || launchedGameId === null) return;
    let cancelled = false;
    const check = async () => {
      try {
        const open = await isProjectorOpenForTarget({ mode: 'game', launchedGameId, gameName: gameName ?? '', config });
        if (!cancelled) setProjectorOpen(open);
      } catch {
        if (!cancelled) setProjectorOpen(false);
      }
    };
    void check();
    const id = setInterval(() => void check(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectorMode, launchedGameId]);

  const handleToggleProjector = useCallback(async () => {
    if (projectorBusy || launchedGameId === null) return;
    setProjectorBusy(true);
    try {
      if (projectorOpen) {
        await closeProjector();
        setProjectorOpen(false);
      } else {
        await openProjector({ mode: 'game', launchedGameId, gameName: gameName ?? '', config });
        setProjectorOpen(true);
      }
    } catch (err) {
      console.error('[LeaderboardPage] projector toggle failed:', err);
    } finally {
      setProjectorBusy(false);
    }
  }, [projectorBusy, projectorOpen, launchedGameId, gameName, config]);

  return (
    <div
      ref={scrollRef}
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
        <header
          className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-5 border-b border-[var(--pg-line)] bg-[var(--pg-app-bg)]/95 backdrop-blur transition-all duration-300"
          style={{
            transform: headerVisible ? 'translateY(0)' : 'translateY(-100%)',
            opacity: headerVisible ? 1 : 0,
            pointerEvents: headerVisible ? 'auto' : 'none',
          }}
        >
          <div className="flex items-center gap-3">
            {!projectorMode && (
              <button
                onClick={onBack}
                className="flex items-center gap-2 text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] transition-colors text-sm font-medium"
              >
                <ArrowLeft size={18} />
                Back
              </button>
            )}
            {!projectorMode && launchedGameId !== null && (
              <button
                onClick={handleToggleProjector}
                disabled={projectorBusy}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
                  projectorOpen
                    ? 'border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20'
                    : 'border-[var(--pg-line-strong)] bg-[var(--pg-surface-2)] text-[var(--pg-text-muted)] hover:bg-[var(--pg-surface-3)] hover:text-[var(--pg-text)]'
                } ${projectorBusy ? 'opacity-50 cursor-wait' : ''}`}
                title={projectorOpen ? 'Close the projector window' : 'Open this leaderboard on a second screen'}
              >
                {projectorOpen ? <MonitorOff size={14} /> : <MonitorUp size={14} />}
                {projectorOpen ? 'Close projector' : 'Open on second screen'}
              </button>
            )}
          </div>

          <div className="flex items-center gap-3 text-[var(--pg-text-dim)] text-sm">
            {playMode === 'team' && (
              <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-teal-500/15 border border-teal-500/30 text-teal-400 text-xs font-semibold uppercase tracking-wide">
                <Users size={12} />
                Team mode
              </span>
            )}
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--pg-surface-2)] border border-[var(--pg-line)] text-[var(--pg-text-dim)] text-xs font-medium">
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
                <Star size={15} className="text-[var(--pg-accent-bright)]" />
                <span className="text-[var(--pg-accent-bright)] font-semibold uppercase tracking-wide text-xs">Score</span>
              </>
            )}
          </div>
        </header>

        <div className="flex-1 flex flex-col items-center px-4 py-10 max-w-2xl mx-auto w-full">
          <div className="mb-10 text-center">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-yellow-400/10 border-2 border-yellow-400/40 mb-5">
              <Trophy size={36} className="text-yellow-400" />
            </div>
            <h1 className="text-4xl font-bold text-[var(--pg-text)] tracking-tight mb-1">Rankings</h1>
            {gameName && (
              <p className="text-[var(--pg-text-dim)] text-base mt-1">{gameName}</p>
            )}
          </div>

          {loading ? (
            <div className="text-[var(--pg-text-dim)] text-center py-16">Loading rankings...</div>
          ) : teams.length === 0 ? (
            <div className="text-[var(--pg-text-dim)] text-center py-16">No team data found.</div>
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
                          <span className="text-[var(--pg-text-dim)] text-xs">
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
                        <div className="text-[var(--pg-text-dim)] text-xs mt-0.5 flex items-center gap-1">
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
                            className={`font-bold transition-all duration-300 ${movingUp ? 'text-emerald-400' : 'text-[var(--pg-text)]'}`}
                            style={{ fontSize: movingUp ? '1.4rem' : '1.25rem' }}
                          >
                            {team.score}
                            <span className="text-[var(--pg-text-dim)] text-sm font-normal ml-1">pts</span>
                          </div>
                        ) : duration !== null ? (
                          <div
                            className={`font-bold ${movingUp ? 'text-emerald-400' : getRankColor(index)}`}
                            style={{ fontSize: movingUp ? '1.4rem' : '1.25rem', transition: 'font-size 0.3s ease, color 0.3s ease' }}
                          >
                            {formatDuration(duration)}
                          </div>
                        ) : (
                          <div className="text-[var(--pg-text-dim)] text-sm">&mdash;</div>
                        )}

                        {victoryType === 'speed' && team.score > 0 && (
                          <div className="text-[var(--pg-text-dim)] text-xs mt-0.5">
                            {team.score} pts
                          </div>
                        )}
                      </div>
                    </div>

                    {teammates.length > 1 && (
                      <div className="mt-3 pt-3 border-t border-[var(--pg-line)] flex flex-wrap gap-2">
                        {teammates.map((mate, mi) => (
                          <span key={mi} className="flex items-center gap-1.5 px-2.5 py-1 bg-[var(--pg-surface-3)] rounded-full text-xs text-[var(--pg-text-muted)]">
                            <span className="w-1.5 h-1.5 rounded-full bg-teal-400 inline-block" />
                            {mate.name}
                            <span className="text-[var(--pg-text-dim)]">#{mate.chipNumber}</span>
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

      {/* Climber badge - pinned to the right edge, vertically centered, OUTSIDE
          the transformed content wrapper so `position: fixed` resolves to the
          viewport and the badge never scrolls away with the creep. */}
      {autoScroll && currentClimber && (
        <div className="fixed right-0 top-1/2 z-30 pointer-events-none" style={{ transform: 'translateY(-50%)' }}>
          <div
            key={currentClimber.c.id}
            className="mr-4 rounded-2xl border border-emerald-400/50 bg-emerald-500/15 backdrop-blur px-5 py-4"
            style={{
              minWidth: 200,
              boxShadow: '0 0 0 1px rgb(52 211 153 / 0.35), 0 12px 44px rgb(16 185 129 / 0.35)',
              animation: currentClimber.phase === 'in'
                ? 'climberIn 0.4s cubic-bezier(0.22, 1, 0.36, 1) both'
                : 'climberOut 0.4s ease both',
            }}
          >
            <div className="flex items-center gap-1.5 text-emerald-300 text-xs font-bold uppercase tracking-wide mb-1.5">
              <ArrowUp size={14} />
              Moving up
            </div>
            <div className="text-[var(--pg-text)] font-bold text-lg leading-tight truncate max-w-[240px]">
              {currentClimber.c.teamName}
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[var(--pg-text-dim)] font-semibold">#{currentClimber.c.fromRank}</span>
              <ArrowRight size={16} className="text-emerald-400" />
              <span className="text-emerald-400 font-bold text-xl">#{currentClimber.c.toRank}</span>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes bounceUp {
          0%   { transform: translateY(4px); opacity: 0; }
          60%  { transform: translateY(-3px); }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes climberIn {
          from { opacity: 0; transform: translateX(120%); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes climberOut {
          from { opacity: 1; transform: translateX(0); }
          to   { opacity: 0; transform: translateX(120%); }
        }
      `}</style>
    </div>
  );
}
