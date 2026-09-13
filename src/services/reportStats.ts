/**
 * Build normalized per-team mission-report data for a launched game.
 *
 * Loads everything once (state, meta, scenario game-data, pattern) and returns
 * one `ReportData` per team, ranked (score desc). The print engine
 * (`reportPrint.ts`) consumes this - it never touches the DB.
 *
 * Per-type stats reuse the SAME derivations the in-app UI uses:
 *  - mystery: per-enigma status from punches vs the pattern's good/wrong station
 *    codes (mirrors TeamDetailsModal / MysteryGamePage), + operator overrides.
 *  - tagquest: quest completions + combo bonus + level (mirrors
 *    LaunchedGamesList.loadTeams).
 *  - tracks: checkpoint hits vs route (best-effort; order-aware "wrong" is a
 *    follow-up - see TODO).
 *  - clash: core fields only for now (territory/combo stats TODO).
 *
 * Plan: `team-mission-report-printing.md`.
 */

import {
  getLaunchedGameState,
  getLaunchedGameMeta,
  listCompletedQuests,
  type RawPunchRow,
} from './launchedGames';
import * as scenarioStore from './scenarioStore';
import * as patternStore from './patternStore';
import { normalizeGameType, resolveReportLayout, defaultReportLayout, isReportLayout, type ReportGameType, type ReportLayout } from './reportLayout';
import { getSyncedLayout } from './reportLayoutsStore';
import { checkpointsForRoute, orderedHitCheckpointIds, type TracksCheckpoint } from './tracksScoring';
import { getClashState, getClashMembers } from './clash';
import {
  MALUS_QUEST_NUMBER,
  comboBonusPoints,
  effectifWeights,
  isWeightingEnabled,
  memberCounts,
  teamHeadcounts,
  weightedScore,
} from './tagquestScoring';

export interface ReportData {
  teamId: number;
  teamNumber: number;
  gameTitle: string;
  pdfTitle: string;
  /** The scenario's team-title label (e.g. "NOM DE CODE"). */
  teamTitleLabel: string;
  teamName: string;
  /** Pre-formatted dd/mm/yyyy. */
  dateText: string;
  durationSeconds: number | null;
  score: number;
  /** 1-based rank within the game (by score desc). */
  rank: number;
  totalTeams: number;
  /** 2-letter team language for label resolution; '' ⇒ caller default. */
  language: string;
  /** Per-type stat values keyed by the stat field id used in layout grids. */
  stats: Record<string, number | string>;
}

interface GameInput {
  id: number;
  game_uniqid: string;
  game_type: string;
}

// ----- gameData shape helpers (getGameData nests under game_data or is flat) -----

interface NormalizedGameData {
  title: string;
  gameMeta: Record<string, unknown>;
  quests: Array<{ name?: string; points?: string | number }>;
  enigmas: Array<{ number: string; good_answer_points?: string | number; wrong_answer_points?: string | number }>;
  levels: Record<string, { name?: string | null; points?: string | null }> | null;
}

function normalizeGameData(gd: unknown): NormalizedGameData {
  const g = (gd ?? {}) as Record<string, any>;
  const gameMeta = (g.game_data?.game_meta ?? g.game_meta ?? {}) as Record<string, unknown>;
  const title = g.game?.title ?? g.scenario?.title ?? g.title ?? '';
  return {
    title: String(title ?? ''),
    gameMeta,
    quests: (g.quests ?? g.game_data?.quests ?? []) as NormalizedGameData['quests'],
    enigmas: (g.game_enigmas ?? g.game_data?.game_enigmas ?? []) as NormalizedGameData['enigmas'],
    levels: (g.levels ?? gameMeta.levels ?? null) as NormalizedGameData['levels'],
  };
}

function toInt(v: unknown): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ----- punch reconstruction (ported from TeamDetailsModal.liveCodesForTeam) -----

export interface RawRecord {
  id: number;
  raw_data: { id?: number; punches?: Array<{ code: string | number; time?: string | null }> } | null;
  created_at: string;
}

/** Map a launched-game state's raw punch rows into the {@link RawRecord} shape
 *  the punch-reconstruction helpers consume. Reused by teamSummary.ts. */
export function rawRecordsFromState(rows: RawPunchRow[]): RawRecord[] {
  return rows.map((r) => ({
    id: r.id,
    raw_data: r.raw_data as RawRecord['raw_data'],
    created_at: r.created_at,
  }));
}

function rowEpochSeconds(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 1000 : NaN;
}

export interface LivePunch { code: string; time: string }

/**
 * The punches a team actually scored on (finish − start baseline, per card,
 * windowed to [start,end]) WITH their SI clock times. Mirrors the runtime
 * baseline-subtraction; keeping times lets tracks do order-aware scoring.
 */
export function livePunchesForTeam(records: RawRecord[], startTime: number | null, endTime: number | null): LivePunch[] {
  const byCard = new Map<number, RawRecord[]>();
  for (const r of records) {
    const cid = Number(r.raw_data?.id);
    if (!Number.isFinite(cid)) continue;
    (byCard.get(cid) ?? byCard.set(cid, []).get(cid)!).push(r);
  }
  const SKEW = 60;
  const out: LivePunch[] = [];
  for (const allRows of byCard.values()) {
    let rows = allRows;
    if (startTime != null) {
      const lo = startTime - SKEW;
      const hi = (endTime ?? Math.floor(Date.now() / 1000)) + SKEW;
      const windowed = allRows.filter((r) => {
        const e = rowEpochSeconds(r.created_at);
        return !Number.isFinite(e) || (e >= lo && e <= hi);
      });
      if (windowed.length) rows = windowed;
    }
    const asc = [...rows].sort((a, b) => a.id - b.id);
    const startRow = asc[0];
    const finishRow = asc[asc.length - 1];
    if (!startRow || !finishRow) continue;
    const baseline = new Set(
      (startRow.raw_data?.punches ?? [])
        .filter((p) => p.time != null && String(p.time) !== '00:00:00')
        .map((p) => `${p.code}@${p.time}`),
    );
    for (const p of finishRow.raw_data?.punches ?? []) {
      if (baseline.has(`${p.code}@${p.time}`)) continue;
      out.push({ code: String(p.code), time: String(p.time ?? '') });
    }
  }
  return out;
}

/** The station codes a team scored on (presence only) - mystery + free tracks. */
function liveCodesForTeam(records: RawRecord[], startTime: number | null, endTime: number | null): Set<string> {
  return new Set(livePunchesForTeam(records, startTime, endTime).map((p) => p.code));
}

/** Parse an SI clock time "HH:MM:SS" to seconds-of-day for ordering. */
export function secondsOfDay(t: string): number {
  const [h, m, s] = (t ?? '').split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

// ----- per-team chip resolution (team mode: members punch with own chips) -----

export interface ConfigTeam { chipId: number; name?: string; teammates?: Array<{ chipId: number }> }

export function parseTeamsConfig(meta: Record<string, string>): ConfigTeam[] {
  try {
    const arr = JSON.parse(meta.teamsConfig || '[]');
    return Array.isArray(arr) ? (arr as ConfigTeam[]) : [];
  } catch {
    return [];
  }
}

export function chipIdsForTeam(team: { key_id: number | null; team_name: string | null }, cfg: ConfigTeam[]): Set<number> {
  const match = cfg.find((c) => c.chipId === team.key_id || c.name === team.team_name);
  const ids = match ? [match.chipId, ...(match.teammates ?? []).map((m) => m.chipId)] : [team.key_id];
  return new Set(ids.filter((x): x is number => x != null).map(Number));
}

// ----- mystery enigma override parsing (mirrors TeamDetailsModal) -----

type EnigmaStatus = 'found' | 'wrong' | 'not_found' | 'both';

function readEnigmaOverrides(meta: Record<string, string>, teamId: number): Record<string, EnigmaStatus> {
  try {
    const all = JSON.parse(meta.enigma_overrides || '{}');
    const forTeam = all?.[String(teamId)];
    return forTeam && typeof forTeam === 'object' ? (forTeam as Record<string, EnigmaStatus>) : {};
  } catch {
    return {};
  }
}

function formatDateDDMMYYYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export interface LaunchedGameReports {
  /** Resolved layout (scenario override → game-type default). */
  layout: ReportLayout;
  /** One entry per team, ranked by score desc. */
  teams: ReportData[];
}

/**
 * Load + rank every team's report data for a launched game, plus the resolved
 * layout to render it with.
 */
export async function loadLaunchedGameReports(game: GameInput): Promise<LaunchedGameReports> {
  const type = normalizeGameType(game.game_type);
  const [state, meta, gdRaw] = await Promise.all([
    getLaunchedGameState(game.id, 0),
    getLaunchedGameMeta(game.id),
    scenarioStore.getGameData(game.game_uniqid).catch(() => null),
  ]);
  const gd = normalizeGameData(gdRaw);
  const cfg = parseTeamsConfig(meta);
  const dateText = formatDateDDMMYYYY(new Date());

  // Report title texts resolve: per-scenario game_meta override → per-game-type
  // default (admin "Report layouts", synced) → built-in code default. (A custom
  // *layout* override changes block styling/order, not these texts.)
  const syncedDefault = await getSyncedLayout(game.game_type).catch(() => null);
  const typeDefaultLayout = isReportLayout(syncedDefault) ? syncedDefault : defaultReportLayout(game.game_type);
  const teamTitleLabel = String(gd.gameMeta.team_title ?? '').trim() || (typeDefaultLayout.teamTitle ?? '');
  const pdfTitle = String(gd.gameMeta.pdf_title ?? '').trim() || (typeDefaultLayout.pdfTitle ?? '');

  const rawRecords: RawRecord[] = (state.new_raw_data ?? []).map((r: RawPunchRow) => ({
    id: r.id,
    raw_data: r.raw_data as RawRecord['raw_data'],
    created_at: r.created_at,
  }));

  const statsByTeam = await computeStatsByTeam(type, game.id, state.teams, meta, gd, cfg, rawRecords);

  const totalTeams = state.teams.length;
  const data: ReportData[] = state.teams.map((t) => {
    const s = statsByTeam.get(t.id) ?? { score: t.score ?? 0, stats: {} };
    const duration = t.start_time && t.end_time ? t.end_time - t.start_time : null;
    return {
      teamId: t.id,
      teamNumber: t.team_number,
      gameTitle: gd.title,
      pdfTitle,
      teamTitleLabel,
      teamName: t.team_name ?? '',
      dateText,
      durationSeconds: duration,
      score: s.score,
      rank: 0,
      totalTeams,
      language: (t.language ?? '').toLowerCase(),
      stats: s.stats,
    };
  });

  data.sort((a, b) => b.score - a.score);
  data.forEach((d, i) => { d.rank = i + 1; });

  const layout = resolveReportLayout(game.game_type, gd.gameMeta, syncedDefault);
  return { layout, teams: data };
}

interface TeamStats { score: number; stats: Record<string, number | string> }

async function computeStatsByTeam(
  type: ReportGameType,
  launchedGameId: number,
  teams: Array<{ id: number; key_id: number | null; team_name: string | null; score: number; start_time: number | null; end_time: number | null }>,
  meta: Record<string, string>,
  gd: NormalizedGameData,
  cfg: ConfigTeam[],
  rawRecords: RawRecord[],
): Promise<Map<number, TeamStats>> {
  const out = new Map<number, TeamStats>();
  const patternUniqid = meta.pattern || '';

  if (type === 'mystery') {
    const enigmas = patternUniqid ? await patternStore.getMysteryEnigmas(patternUniqid).catch(() => []) : [];
    const total = enigmas.length;
    for (const team of teams) {
      const chips = chipIdsForTeam(team, cfg);
      const teamRaw = rawRecords.filter((r) => r.raw_data?.id != null && chips.has(Number(r.raw_data.id)));
      const codes = liveCodesForTeam(teamRaw, team.start_time, team.end_time);
      const overrides = readEnigmaOverrides(meta, team.id);
      let success = 0, fail = 0, absent = 0;
      for (const e of enigmas) {
        const hasGood = e.good_answers.some((a) => codes.has(a));
        const hasWrong = e.wrong_answers.some((a) => codes.has(a));
        let status: EnigmaStatus = hasGood && hasWrong ? 'both' : hasGood ? 'found' : hasWrong ? 'wrong' : 'not_found';
        status = overrides[e.enigma_id] ?? status;
        if (status === 'found' || status === 'both') success++;
        else if (status === 'wrong') fail++;
        else absent++;
      }
      const rate = total ? Math.round((success / total) * 100) : 0;
      out.set(team.id, { score: team.score ?? 0, stats: { success, fail, absent, rate: `${rate}%` } });
    }
    return out;
  }

  if (type === 'tracks') {
    const stationsByCp = patternUniqid ? await patternStore.getTracksCheckpointStations(patternUniqid).catch(() => new Map<number, number[]>()) : new Map<number, number[]>();
    const allCheckpoints: TracksCheckpoint[] = Array.from(stationsByCp.keys()).sort((a, b) => a - b).map((idx) => ({ id: String(idx) }));
    // itinerary = strict in-order prefix (out-of-order punches are "wrong");
    // free = any reached checkpoint counts (no "wrong"). Mirrors TracksGamePage.
    const itinerary = meta.trackPlayMode === 'itinerary';
    for (const team of teams) {
      const chips = chipIdsForTeam(team, cfg);
      const teamRaw = rawRecords.filter((r) => r.raw_data?.id != null && chips.has(Number(r.raw_data.id)));
      const punches = livePunchesForTeam(teamRaw, team.start_time, team.end_time);
      const routeKey = meta[`route:${team.id}`] || meta.route || 'default';
      const route = checkpointsForRoute(allCheckpoints, routeKey);

      // Earliest hit time per route checkpoint (undefined = never reached).
      const hitTimeByCp = new Map<string, number | undefined>();
      for (const cp of route) {
        const stations = stationsByCp.get(Number(cp.id)) ?? [];
        let earliest: number | undefined;
        for (const p of punches) {
          if (stations.includes(Number(p.code))) {
            const ts = secondsOfDay(p.time);
            if (earliest === undefined || ts < earliest) earliest = ts;
          }
        }
        hitTimeByCp.set(cp.id, earliest);
      }

      const hitIds = itinerary
        ? orderedHitCheckpointIds(route, hitTimeByCp).hitIds
        : new Set(route.filter((cp) => hitTimeByCp.get(cp.id) !== undefined).map((cp) => cp.id));

      // statusOf (mirrors TracksGamePage): credited→correct, punched-not-credited
      // →wrong (itinerary only), never punched→missing.
      const correct = hitIds.size;
      const missing = route.filter((cp) => hitTimeByCp.get(cp.id) === undefined).length;
      const wrong = Math.max(0, route.length - correct - missing);
      const rate = route.length ? Math.round((correct / route.length) * 100) : 0;
      out.set(team.id, { score: team.score ?? 0, stats: { correct, wrong, missing, rate: `${rate}%` } });
    }
    return out;
  }

  if (type === 'tagquest') {
    const questRows = await listCompletedQuests(launchedGameId).catch(() => []);
    const pts6 = toInt(gd.gameMeta.combo_6_quests);
    const pts4 = toInt(gd.gameMeta.combo_4_quests);
    const pts2 = toInt(gd.gameMeta.combo_2_quests);
    const byTeam = new Map<number, { score: number; count: number; counts: Record<string, number>; malus: number }>();
    for (const r of questRows) {
      const e = byTeam.get(r.team_id) ?? { score: 0, count: 0, counts: {}, malus: 0 };
      // Malus-station hits ride in the same table (see MALUS_QUEST_NUMBER) but
      // are penalties: they are not quests, never feed combos, and come off the
      // total unweighted.
      if (r.quest_number === MALUS_QUEST_NUMBER) {
        e.malus += Math.abs(r.points_awarded ?? 0);
        byTeam.set(r.team_id, e);
        continue;
      }
      e.score += r.points_awarded ?? 0;
      e.count += 1;
      e.counts[r.quest_number] = (e.counts[r.quest_number] ?? 0) + 1;
      byTeam.set(r.team_id, e);
    }
    // Headcounts (self-register bindings, else roster) always feed the report's
    // "players" stat; the effectif weight applies only when the launch option
    // is on - mirroring the punch logic so the PDF matches lg_teams.score.
    const members = await getClashMembers(launchedGameId).catch(() => []);
    const headcounts = teamHeadcounts(teams, cfg, memberCounts(members));
    const weights = isWeightingEnabled(meta) ? effectifWeights(headcounts) : null;
    for (const team of teams) {
      const e = byTeam.get(team.id) ?? { score: 0, count: 0, counts: {}, malus: 0 };
      const combos = comboBonusPoints(e.counts, pts6, pts4, pts2);
      const total = weightedScore(e.score + combos, weights?.get(team.id) ?? 1, e.malus);
      out.set(team.id, {
        score: total,
        stats: {
          quests: e.count,
          points: total,
          level: levelName(total, gd.levels),
          combos,
          players: headcounts.get(team.id) ?? 1,
        },
      });
    }
    return out;
  }

  if (type === 'clash') {
    // Clash standings are server-authoritative (mother), not lg_teams.score.
    // territories = clans this clan owns; combos = total credited validations
    // across all territories; score = the clan's points.
    const standings = await getClashState(launchedGameId).catch(() => null);
    const pointsByTeam = new Map<number, number>();
    const combosByTeam = new Map<number, number>();
    const territoriesByTeam = new Map<number, number>();
    if (standings) {
      for (const clan of standings.clans) pointsByTeam.set(clan.team_id, clan.points);
      for (const terr of standings.territories) {
        if (terr.owner_team_id != null) {
          territoriesByTeam.set(terr.owner_team_id, (territoriesByTeam.get(terr.owner_team_id) ?? 0) + 1);
        }
        for (const [teamIdKey, count] of Object.entries(terr.counts ?? {})) {
          const tid = Number(teamIdKey);
          combosByTeam.set(tid, (combosByTeam.get(tid) ?? 0) + (count ?? 0));
        }
      }
    }
    for (const team of teams) {
      out.set(team.id, {
        score: pointsByTeam.get(team.id) ?? team.score ?? 0,
        stats: {
          territories: territoriesByTeam.get(team.id) ?? 0,
          combos: combosByTeam.get(team.id) ?? 0,
        },
      });
    }
    return out;
  }

  // Fallback (unknown type): core fields only.
  for (const team of teams) out.set(team.id, { score: team.score ?? 0, stats: {} });
  return out;
}

function levelName(score: number, levels: NormalizedGameData['levels']): string {
  if (!levels) return '';
  let best: { lvl: number; name: string } | null = null;
  for (const [key, val] of Object.entries(levels)) {
    const threshold = val.points ? parseFloat(val.points) : null;
    if (threshold === null || score < threshold) continue;
    const lvl = parseInt(key, 10);
    if (!best || lvl > best.lvl) best = { lvl, name: val.name || `Level ${lvl}` };
  }
  return best?.name ?? '';
}

