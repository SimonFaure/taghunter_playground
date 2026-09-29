/**
 * Tracks scoring + route logic - pure functions, no I/O, easy to reason about.
 *
 * Design plan: C:\Users\faure\.claude\plans\tracks-game-type-design.md (§6)
 */

export type TracksRouteKey = 'default' | 'reverse' | 'first_half' | 'last_half' | 'odd' | 'even';
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
 * The subset of checkpoints that count for a given route, IN THE ORDER they
 * must be reached (itinerary mode walks this array). `odd`/`even` are 1-based
 * on the checkpoint's ordinal position (1st, 3rd, ... = odd); `reverse` is the
 * full course walked backwards, so one scenario covers both directions.
 */
export function checkpointsForRoute(all: TracksCheckpoint[], route: string | undefined): TracksCheckpoint[] {
  const n = all.length;
  switch (route) {
    case 'reverse':
      return [...all].reverse();
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
 * For each route checkpoint, the slot index on the card of the FIRST punch at
 * one of its stations (undefined = never reached). The card stores punches in
 * the order they happened; the per-punch times come from each station's own
 * clock, which drift apart by tens of seconds, so ordering by time judged
 * correctly-punched courses as out of order (retours sept. #2). Times are only
 * for durations. `numberOf` is the checkpoint's 1-based position in the full
 * checkpoint list, the key of `stations` (patternStore.getTracksCheckpointStations).
 */
export function firstSlotByCheckpoint(
  routeCheckpoints: TracksCheckpoint[],
  numberOf: (cp: TracksCheckpoint) => number,
  stations: Map<number, number[]>,
  punches: ReadonlyArray<{ code: number | string; time?: string | null }>,
): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  for (const cp of routeCheckpoints) {
    const cpStations = stations.get(numberOf(cp)) ?? [];
    const slot = punches.findIndex(
      (p) => !!p.time && p.time !== '00:00:00' && cpStations.includes(Number(p.code)),
    );
    out.set(cp.id, slot >= 0 ? slot : undefined);
  }
  return out;
}

/**
 * Strict-prefix itinerary scoring. Given each route checkpoint's first hit
 * position on the card (slot index from firstSlotByCheckpoint, NOT a station
 * time; undefined if never reached), credit the longest *leading* run of
 * checkpoints reached in order. The first missing or out-of-order checkpoint
 * ends the sequence.
 *
 * `brokeAfterId` is the last credited checkpoint id when the run deviated
 * (credited prefix shorter than the route); null on a perfect run, or when even
 * the first checkpoint failed (then `hitIds` is empty). Free mode does NOT use
 * this - it counts any reached checkpoint regardless of order.
 */
export function orderedHitCheckpointIds(
  routeCheckpoints: TracksCheckpoint[],
  hitOrderByCheckpointId: Map<string, number | undefined>,
): { hitIds: Set<string>; brokeAfterId: string | null; deviated: boolean } {
  const hitIds = new Set<string>();
  let prevOrder = Number.NEGATIVE_INFINITY;
  let lastCreditedId: string | null = null;
  for (const cp of routeCheckpoints) {
    // Equal orders only when two checkpoints share a station: legitimate.
    const o = hitOrderByCheckpointId.get(cp.id);
    if (o === undefined || o < prevOrder) break; // missing or out-of-order
    hitIds.add(cp.id);
    lastCreditedId = cp.id;
    prevOrder = o;
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

/** Rank by score (desc), tie-break by completion time (asc - faster wins). */
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
