/**
 * Tracks scoring + route logic — pure functions, no I/O, easy to reason about.
 *
 * Design plan: C:\Users\faure\.claude\plans\tracks-game-type-design.md (§6)
 */

export type TracksRouteKey = 'default' | 'first_half' | 'last_half' | 'odd' | 'even';
export type TracksScoreType = 'percentage' | 'points';

export interface TracksCheckpoint {
  id: string;
  number?: string | number;
  title?: unknown;
  description?: unknown;
  image?: string;
  position?: { top: number; left: number };
  points?: number;
}

/**
 * The subset of checkpoints that count for a given route. `odd`/`even` are
 * 1-based on the checkpoint's ordinal position (1st, 3rd, ... = odd).
 */
export function checkpointsForRoute(all: TracksCheckpoint[], route: string | undefined): TracksCheckpoint[] {
  const n = all.length;
  switch (route) {
    case 'first_half':
      return all.slice(0, Math.ceil(n / 2));
    case 'last_half':
      return all.slice(Math.ceil(n / 2));
    case 'odd':
      return all.filter((_, i) => i % 2 === 0); // positions 1,3,5,...
    case 'even':
      return all.filter((_, i) => i % 2 === 1); // positions 2,4,6,...
    case 'default':
    default:
      return all;
  }
}

export interface ScoreInput {
  /** Checkpoints that count for the active route. */
  routeCheckpoints: TracksCheckpoint[];
  /** Ids of checkpoints the team actually reached. */
  hitCheckpointIds: Set<string>;
  scoreType: TracksScoreType;
  /** Minutes elapsed for the team (end - start). */
  elapsedMinutes: number;
  /** Configured time limit in minutes. */
  timeLimitMinutes: number;
  /** Malus subtracted per whole minute over the limit. */
  malusPerMinute: number;
}

/**
 * Final team score.
 * - percentage: (hits / route size) × 100, capped at 100
 * - points: Σ points over hit checkpoints
 * Then subtract `malusPerMinute` per whole minute over the limit; floor at 0.
 */
export function computeScore(input: ScoreInput): number {
  const { routeCheckpoints, hitCheckpointIds, scoreType, elapsedMinutes, timeLimitMinutes, malusPerMinute } = input;
  const hits = routeCheckpoints.filter((c) => hitCheckpointIds.has(c.id));

  let raw: number;
  if (scoreType === 'points') {
    raw = hits.reduce((sum, c) => sum + (typeof c.points === 'number' ? c.points : 1), 0);
  } else {
    const denom = routeCheckpoints.length || 1;
    raw = Math.min(100, (hits.length / denom) * 100);
  }

  const overMinutes = Math.max(0, Math.ceil(elapsedMinutes - timeLimitMinutes));
  const malus = overMinutes * (Number.isFinite(malusPerMinute) ? malusPerMinute : 0);
  return Math.max(0, raw - malus);
}

/**
 * Strict-prefix itinerary scoring. Given each route checkpoint's earliest hit
 * time (seconds-of-day, or undefined if never reached), credit the longest
 * *leading* run of checkpoints reached in non-decreasing time order. The first
 * missing or out-of-order checkpoint ends the sequence.
 *
 * `brokeAfterId` is the last credited checkpoint id when the run deviated
 * (credited prefix shorter than the route); null on a perfect run, or when even
 * the first checkpoint failed (then `hitIds` is empty). Free mode does NOT use
 * this — it counts any reached checkpoint regardless of order.
 */
export function orderedHitCheckpointIds(
  routeCheckpoints: TracksCheckpoint[],
  hitTimeByCheckpointId: Map<string, number | undefined>,
): { hitIds: Set<string>; brokeAfterId: string | null; deviated: boolean } {
  const hitIds = new Set<string>();
  let prevTime = Number.NEGATIVE_INFINITY;
  let lastCreditedId: string | null = null;
  for (const cp of routeCheckpoints) {
    const t = hitTimeByCheckpointId.get(cp.id);
    if (t === undefined || t < prevTime) break; // missing or out-of-order
    hitIds.add(cp.id);
    lastCreditedId = cp.id;
    prevTime = t;
  }
  const deviated = hitIds.size < routeCheckpoints.length;
  return { hitIds, brokeAfterId: deviated ? lastCreditedId : null, deviated };
}

export interface RankableTeam {
  score?: number | null;
  start_time?: number | null;
  end_time?: number | null;
}

/** Seconds a team took, or +Infinity if it never finished (ranks last on ties). */
function teamDurationSec(t: RankableTeam): number {
  if (t.start_time && t.end_time) return t.end_time - t.start_time;
  return Number.POSITIVE_INFINITY;
}

/** Rank by score (desc), tie-break by completion time (asc — faster wins). */
export function sortTracksTeams<T extends RankableTeam>(teams: T[]): T[] {
  return [...teams].sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;
    return teamDurationSec(a) - teamDurationSec(b);
  });
}

/** Reward tier for a 1-based rank: top_1 (≤1), top_3 (≤3), top_10 (≤10), else null. */
export function rankTier(rank: number): 'top_1' | 'top_3' | 'top_10' | null {
  if (rank <= 1) return 'top_1';
  if (rank <= 3) return 'top_3';
  if (rank <= 10) return 'top_10';
  return null;
}
