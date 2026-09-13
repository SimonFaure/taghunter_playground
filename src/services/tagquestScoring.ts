/**
 * TagQuest scoring helpers shared by every place that derives a team's score:
 *  - tagquestPunchLogic.ts   (authoritative - persists lg_teams.score on punch)
 *  - LaunchedGamesList.tsx   (operator team list re-derivation)
 *  - reportStats.ts          (mission-report PDF re-derivation)
 * Keeping the combo math and the effectif weighting here is what guarantees the
 * three sites can never disagree on a team's score.
 *
 * Effectif weighting ("Pondération par effectif"): with uneven team sizes a
 * bigger team punches more and out-scores smaller ones mechanically. When the
 * launch option is on (score victory + team mode only), each team's EARNED
 * points (quest points + combo bonus) are multiplied by
 * `largest team's headcount ÷ own headcount` - the same rule Clash applies in
 * the mother (compute_clash_standings). The largest team keeps its raw score
 * (×1.0); smaller teams are scaled up. The late malus is time-based, not
 * size-based, so it is subtracted AFTER the multiplication, unweighted:
 *
 *   score = max(0, round((questPoints + comboBonus) × weight − malus))
 *
 * `malus` above is the sum of the time-based late malus and the station malus
 * (every punch on the scenario's `malus_station` costs `malus_points`). Both
 * are penalties, not earned points, so neither is weighted.
 *
 * Headcount = the team's live chip count (min 1): the pre-built roster
 * (leader + teammates) for predetermined teams, or the lg_clash_members
 * bindings for self-register teams. Live - a mid-game join/leave re-scales the
 * team's points on the next recompute (deliberate divergence from Clash's
 * frozen start-time snapshot: TagQuest recomputes from scratch anyway and its
 * rosters legitimately change via late arrivals / manual add-player).
 */

/**
 * Sentinel `quest_number` used to persist a malus-station hit as a row in
 * `lg_team_completed_quests` (one row per punch, `points_awarded` = −malus).
 * Real quest numbers are the 1-based quest index ("1".."6"), so this can never
 * collide. Storing it there (rather than in a new table) is what makes the
 * malus survive a kiosk reload and stay visible to every device reading the
 * mother - the punch scorer recomputes the score from scratch on every bip.
 *
 * EVERY consumer of `listCompletedQuests` must split these rows out before
 * counting quests or computing combos - use `partitionMalusRows`.
 */
export const MALUS_QUEST_NUMBER = '__malus__';

/**
 * Splits completion rows into real quest completions and the accumulated
 * station malus (a POSITIVE number of points to subtract).
 */
export function partitionMalusRows<T extends { quest_number: string; points_awarded?: number | null }>(
  rows: readonly T[],
): { questRows: T[]; stationMalus: number } {
  const questRows: T[] = [];
  let stationMalus = 0;
  for (const r of rows) {
    if (r.quest_number === MALUS_QUEST_NUMBER) {
      stationMalus += Math.abs(r.points_awarded ?? 0);
    } else {
      questRows.push(r);
    }
  }
  return { questRows, stationMalus };
}

/** Minimal roster shape (LaunchGameModal.Team / reportStats.ConfigTeam both fit). */
export interface RosterTeam {
  chipId: number;
  name?: string;
  teammates?: Array<{ chipId: number }>;
}

/**
 * Greedy combo grouping over per-quest completion counts: groups of 6 distinct
 * completed quests first, then 4, then 2. (Moved from tagquestPunchLogic.)
 */
export function computeCombos(questCompletions: Map<string, number>): { combos6: number; combos4: number; combos2: number } {
  const counts = new Map(questCompletions);

  let combos6 = 0;
  while ([...counts.values()].every(v => v > 0) && counts.size >= 6) {
    combos6++;
    for (const key of counts.keys()) counts.set(key, counts.get(key)! - 1);
  }

  let combos4 = 0;
  while (true) {
    const nonZero = [...counts.entries()].filter(([, v]) => v > 0);
    if (nonZero.length < 4) break;
    combos4++;
    for (const [key] of nonZero.slice(0, 4)) counts.set(key, counts.get(key)! - 1);
  }

  let combos2 = 0;
  while (true) {
    const nonZero = [...counts.entries()].filter(([, v]) => v > 0);
    if (nonZero.length < 2) break;
    combos2++;
    for (const [key] of nonZero.slice(0, 2)) counts.set(key, counts.get(key)! - 1);
  }

  return { combos6, combos4, combos2 };
}

/** Total combo bonus points for a team's per-quest completion counts. */
export function comboBonusPoints(
  countMap: Record<string, number>,
  pts6: number,
  pts4: number,
  pts2: number,
): number {
  if (pts6 === 0 && pts4 === 0 && pts2 === 0) return 0;
  const { combos6, combos4, combos2 } = computeCombos(new Map(Object.entries(countMap)));
  return combos6 * pts6 + combos4 * pts4 + combos2 * pts2;
}

/**
 * Whether effectif weighting applies to this launched game (from its meta bag).
 * Only meaningful with a score victory in team mode: speed mode ranks by finish
 * time and solo teams all weigh 1.0. Missing key ⇒ OFF, so games launched
 * before the option existed keep their raw scores (new launches always persist
 * an explicit value, default true).
 */
export function isWeightingEnabled(meta: Record<string, string>): boolean {
  return (
    meta.tagquestScoreWeighting === 'true' &&
    (meta.victoryType || 'speed').toLowerCase() === 'score' &&
    meta.playMode === 'team'
  );
}

/** Per-team member counts from lg_clash_members rows (self-register bindings). */
export function memberCounts(members: Array<{ team_id: number }>): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of members) out.set(m.team_id, (out.get(m.team_id) ?? 0) + 1);
  return out;
}

/**
 * Live headcount (chip count, min 1) for every team in the game. Self-register
 * bindings win when present (they ARE the team's chips); otherwise the
 * predetermined roster (leader + teammates); otherwise 1.
 */
export function teamHeadcounts(
  teams: Array<{ id: number; key_id: number | null; team_name: string | null }>,
  roster: RosterTeam[],
  membersByTeam: Map<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of teams) {
    const bound = membersByTeam.get(t.id) ?? 0;
    if (bound > 0) {
      out.set(t.id, bound);
      continue;
    }
    const cfg = roster.find(c => c.chipId === t.key_id || (c.name != null && c.name === t.team_name));
    out.set(t.id, cfg ? 1 + (cfg.teammates?.length ?? 0) : 1);
  }
  return out;
}

/**
 * weight(team) = largest headcount ÷ own headcount. The largest team gets 1.0,
 * smaller teams >1. No cap - same rule as Clash's effectif weighting.
 */
export function effectifWeights(headcounts: Map<number, number>): Map<number, number> {
  const sizes = new Map([...headcounts].map(([id, n]) => [id, Math.max(1, n)]));
  const largest = Math.max(0, ...sizes.values());
  const out = new Map<number, number>();
  for (const [id, n] of sizes) out.set(id, largest > 0 ? largest / n : 1);
  return out;
}

/** Final score: earned points weighted, malus unweighted, floored at 0. */
export function weightedScore(earnedPoints: number, weight: number, malus = 0): number {
  return Math.max(0, Math.round(earnedPoints * weight - malus));
}

/** Compact operator-facing weight text: ×1, ×1.5, ×2.33. */
export function formatWeight(weight: number): string {
  return `×${Number(weight.toFixed(2))}`;
}
