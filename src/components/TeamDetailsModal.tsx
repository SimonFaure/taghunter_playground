import { useState, useEffect } from 'react';
import { X, Award, Zap, Target, Clock, List, ChevronDown, ChevronUp, BarChart2, Plus, Minus, Puzzle, RotateCcw, ImageOff } from 'lucide-react';
import * as scenarioStore from '../services/scenarioStore';
import * as patternStore from '../services/patternStore';
import { scenarioAssetUrl } from '../services/contentFs';
import {
  getLaunchedGameState,
  getLaunchedGameMeta,
  updateLaunchedGameMeta,
  listCompletedQuests,
  recordCompletedQuest,
  deleteCompletedQuest,
  updateTeam,
} from '../services/launchedGames';

interface Team {
  id: number;
  team_number: number;
  team_name: string;
  score: number;
  start_time: number | null;
  end_time: number | null;
  key_id: number;
}

interface CompletedQuest {
  id: number;
  quest_number: string;
  points_awarded: number;
  teammate_chip_id: number | null;
  completed_at: string | null;
}

interface RawDataRecord {
  id: number;
  raw_data: {
    id: number;
    punches: { code: number | string; time: number | string }[];
    end?: number | string | null;
  };
  created_at: string;
}

interface TeamDetailsModalProps {
  team: Team;
  launchedGameId: number;
  gameUniqid: string;
  /** Launched-game type ('mystery', 'tagquest', 'tracks', …). For 'mystery'
   *  the modal swaps the quest tabs for an Enigmas tab. */
  gameType: string;
  /** All chips belonging to this team (leader + teammates). In team mode each
   *  member punches with their own chip, so the punch tab must look at all of
   *  them, not just the leader's key_id. Defaults to [team.key_id]. */
  chipIds?: number[];
  onClose: () => void;
}

// Mystery per-enigma outcome. Mirrors the four results MysteryGamePage computes
// at the finishing bip (correct / incorrect / no_answer / both_answers).
type EnigmaStatus = 'found' | 'wrong' | 'not_found' | 'both';

const ENIGMA_STATUS_META: Record<EnigmaStatus, { label: string; activeClass: string; dot: string }> = {
  found:     { label: 'Found',      activeClass: 'bg-green-600 text-white border-green-500',   dot: 'bg-green-400' },
  wrong:     { label: 'Wrong',      activeClass: 'bg-red-600 text-white border-red-500',       dot: 'bg-red-400' },
  not_found: { label: 'Not found',  activeClass: 'bg-slate-500 text-white border-slate-400',   dot: 'bg-slate-300' },
  both:      { label: 'Both biped', activeClass: 'bg-amber-600 text-white border-amber-500',   dot: 'bg-amber-400' },
};

const ENIGMA_STATUS_ORDER: EnigmaStatus[] = ['found', 'wrong', 'not_found', 'both'];

// Points a single enigma contributes for a given (effective) status — the same
// rule MysteryGamePage applies: good answer adds its points, wrong answer
// subtracts its penalty, no-answer / both = 0.
function enigmaPoints(status: EnigmaStatus, goodPts: number, wrongPts: number): number {
  if (status === 'found') return goodPts;
  if (status === 'wrong') return -wrongPts;
  return 0;
}

// Read the persisted per-team override map from launched-game meta. Stored
// under a single `enigma_overrides` key as JSON: { "<teamId>": { "<enigmaId>": status } }.
function readEnigmaOverrides(meta: Record<string, string>, teamId: number): Record<string, EnigmaStatus> {
  try {
    const all = JSON.parse(meta.enigma_overrides || '{}');
    const forTeam = all?.[String(teamId)];
    return forTeam && typeof forTeam === 'object' ? (forTeam as Record<string, EnigmaStatus>) : {};
  } catch {
    return {};
  }
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function rowEpochSeconds(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 1000 : NaN;
}

// Reconstruct the station codes this team actually scored on, mirroring
// MysteryGamePage exactly. The engine snapshots the card's PRE-EXISTING punches
// at the start bip (those with a real time, not the 00:00:00 placeholder) and,
// at the finish bip, scores `finishPunches − baseline`. That baseline lives only
// in memory at runtime, but both bips persist as raw_data snapshots — so we
// rebuild start/finish per card and subtract here. A naive "count every code"
// would re-introduce the stale punches the engine dropped, drifting the modal's
// status/score away from what was actually scored.
//
// When a card is reused across runs, all its rows are present; we window to this
// team's [start, end] (with a skew margin) so the right start/finish pair is
// used, falling back to every row if windowing leaves nothing.
function liveCodesForTeam(
  records: RawDataRecord[],
  startTime: number | null,
  endTime: number | null,
): Set<string> {
  const byCard = new Map<number, RawDataRecord[]>();
  for (const r of records) {
    const cid = Number((r.raw_data as { id?: number } | null)?.id);
    if (!Number.isFinite(cid)) continue;
    const arr = byCard.get(cid);
    if (arr) arr.push(r);
    else byCard.set(cid, [r]);
  }

  const SKEW_MARGIN_SEC = 60;
  const codes = new Set<string>();
  for (const allRows of byCard.values()) {
    let rows = allRows;
    if (startTime != null) {
      const lo = startTime - SKEW_MARGIN_SEC;
      const hi = (endTime ?? Math.floor(Date.now() / 1000)) + SKEW_MARGIN_SEC;
      const windowed = allRows.filter((r) => {
        const e = rowEpochSeconds(r.created_at);
        return !Number.isFinite(e) || (e >= lo && e <= hi);
      });
      if (windowed.length > 0) rows = windowed;
    }
    const asc = [...rows].sort((a, b) => a.id - b.id);
    const startRow = asc[0];
    const finishRow = asc[asc.length - 1];
    const baseline = new Set(
      (startRow.raw_data?.punches ?? [])
        .filter((p) => p.time != null && String(p.time) !== '00:00:00')
        .map((p) => `${p.code}@${p.time}`),
    );
    for (const p of finishRow.raw_data?.punches ?? []) {
      if (baseline.has(`${p.code}@${p.time}`)) continue;
      codes.add(String(p.code));
    }
  }
  return codes;
}

interface GameQuest {
  name: string;
  points?: string | number;
}

interface GameEnigma {
  number: string;
  text?: string;
  good_answer_image?: string;
  good_answer_points?: string | number;
  wrong_answer_points?: string | number;
}

interface GameDataJson {
  game_meta?: {
    combo_6_quests?: string | number;
    combo_4_quests?: string | number;
    combo_2_quests?: string | number;
    levels?: Record<string, { name: string | null; points: string | null; description?: string | null }>;
    score_full_game?: string | number;
    points_units?: string;
  };
  levels?: Record<string, { name: string | null; points: string | null; description?: string | null }>;
  quests?: GameQuest[];
  game_enigmas?: GameEnigma[];
}

function toCompletedQuest(r: {
  id: number;
  quest_number: string;
  points_awarded: number;
  teammate_chip_id: number | null;
  created_at: string;
}): CompletedQuest {
  return {
    id: r.id,
    quest_number: r.quest_number,
    points_awarded: r.points_awarded,
    teammate_chip_id: r.teammate_chip_id,
    completed_at: r.created_at,
  };
}

function formatTimestamp(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined) return '—';
  const ms = typeof ts === 'string' ? parseFloat(ts) : ts;
  const adjusted = ms > 1e10 ? ms : ms * 1000;
  return new Date(adjusted).toLocaleTimeString();
}

function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function computeCombos(questCompletions: Map<string, number>): { combos6: number; combos4: number; combos2: number } {
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

function parseComboVal(val: string | number | undefined): number {
  if (val === undefined || val === null) return 0;
  return typeof val === 'string' ? parseInt(val, 10) || 0 : val;
}

function computeLevel(
  score: number,
  levels: Record<string, { name: string | null; points: string | null }> | undefined
): { level: number; name: string } | null {
  if (!levels) return null;
  let best: { level: number; name: string } | null = null;
  for (const [key, val] of Object.entries(levels)) {
    const threshold = val.points ? parseFloat(val.points) : null;
    if (threshold === null) continue;
    if (score >= threshold) {
      const lvlNum = parseInt(key, 10);
      if (!best || lvlNum > best.level) {
        best = { level: lvlNum, name: val.name || `Level ${lvlNum}` };
      }
    }
  }
  return best;
}

export function TeamDetailsModal({ team, launchedGameId, gameUniqid, gameType, chipIds, onClose }: TeamDetailsModalProps) {
  // launched_games stores game_type capitalised ('Mystery'), while scenario rows
  // use the lowercase slug — compare case-insensitively so either value matches.
  const isMystery = (gameType ?? '').toLowerCase() === 'mystery';
  const [completedQuests, setCompletedQuests] = useState<CompletedQuest[]>([]);
  const [rawDataRecords, setRawDataRecords] = useState<RawDataRecord[]>([]);
  const [gameData, setGameData] = useState<GameDataJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'quests' | 'quest-count' | 'punches' | 'enigmas'>(
    isMystery ? 'enigmas' : 'quests'
  );
  const [expandedPunch, setExpandedPunch] = useState<number | null>(null);
  const [mutating, setMutating] = useState(false);
  const [currentTeam, setCurrentTeam] = useState(team);
  // Mystery: the pattern's good/wrong answer-station codes per enigma, plus the
  // operator's persisted per-enigma status overrides for THIS team.
  const [patternEnigmas, setPatternEnigmas] = useState<patternStore.PatternEnigma[]>([]);
  const [enigmaOverrides, setEnigmaOverrides] = useState<Record<string, EnigmaStatus>>({});
  const chipKey = (chipIds ?? []).join(',');

  useEffect(() => {
    const loadGameData = async () => {
      try {
        const raw = (await scenarioStore.getGameData(gameUniqid)) as any;
        if (raw) setGameData(raw?.game_data ?? raw);
      } catch {
        // game data not available
      }
    };

    loadGameData();
  }, [gameUniqid]);

  // Mystery only: load the pattern's per-enigma good/wrong answer-station codes
  // (used to recompute each enigma's base status from the team's punches) and
  // this team's persisted status overrides. Both come from launched-game meta.
  useEffect(() => {
    if (!isMystery) return;
    let cancelled = false;
    (async () => {
      try {
        const meta = await getLaunchedGameMeta(launchedGameId);
        if (cancelled) return;
        setEnigmaOverrides(readEnigmaOverrides(meta, team.id));
        const patternUniqid = meta.pattern || '';
        if (patternUniqid) {
          const enigmas = await patternStore.getMysteryEnigmas(patternUniqid);
          if (!cancelled) setPatternEnigmas(enigmas);
        }
      } catch (err) {
        console.error('[TeamDetailsModal] mystery load failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isMystery, launchedGameId, team.id]);

  useEffect(() => {
    const load = async (isInitial = false) => {
      if (isInitial) setLoading(true);

      try {
        const [questsRows, state] = await Promise.all([
          listCompletedQuests(launchedGameId, team.id),
          getLaunchedGameState(launchedGameId, 0),
        ]);
        setCompletedQuests(questsRows.map(toCompletedQuest));
        // Punches: in team mode each member punches with their OWN chip, so
        // filter the game's raw_data to every chip on this team (leader +
        // teammates) — the leader's key_id often never punches. state's
        // new_raw_data (since_raw_id 0) is the full set for the game.
        const chipSet = new Set(
          (chipIds && chipIds.length ? chipIds : [team.key_id]).map(Number)
        );
        const rawForTeam = (state.new_raw_data ?? []).filter((r) => {
          const cid = (r.raw_data as { id?: number } | null)?.id;
          return cid != null && chipSet.has(Number(cid));
        });
        const rawAsc = [...rawForTeam].sort((a, b) => a.id - b.id);
        setRawDataRecords(
          rawAsc.map((r) => ({
            id: r.id,
            raw_data: r.raw_data,
            created_at: r.created_at,
          })) as RawDataRecord[]
        );
        const refreshed = state.teams.find((t) => t.id === team.id);
        if (refreshed) {
          setCurrentTeam({
            ...team,
            team_name: refreshed.team_name ?? team.team_name,
            score: refreshed.score,
            start_time: refreshed.start_time,
            end_time: refreshed.end_time,
            key_id: refreshed.key_id ?? team.key_id,
          } as typeof team);
        }
      } catch (err) {
        console.error('[TeamDetailsModal] load failed:', err);
      } finally {
        if (isInitial) setLoading(false);
      }
    };

    load(true);

    const interval = setInterval(() => load(false), 2000);
    return () => clearInterval(interval);
  }, [team.id, launchedGameId, team.key_id, chipKey]);

  const quests = gameData?.quests ?? [];
  const comboConfig = gameData?.game_meta;
  const pts6 = parseComboVal(comboConfig?.combo_6_quests);
  const pts4 = parseComboVal(comboConfig?.combo_4_quests);
  const pts2 = parseComboVal(comboConfig?.combo_2_quests);
  const hasComboConfig = pts6 > 0 || pts4 > 0 || pts2 > 0;

  const totalQuestPoints = completedQuests.reduce((sum, q) => sum + (q.points_awarded ?? 0), 0);
  const gameLevels = gameData?.levels ?? comboConfig?.levels;

  const getQuestName = (questNumber: string): string => {
    const idx = parseInt(questNumber, 10) - 1;
    return quests[idx]?.name ?? `Quest #${questNumber}`;
  };

  const questCountMap = completedQuests.reduce<Record<string, number>>((acc, q) => {
    acc[q.quest_number] = (acc[q.quest_number] ?? 0) + 1;
    return acc;
  }, {});

  const questCountMapForCombos = new Map<string, number>(Object.entries(questCountMap));
  const combos = computeCombos(questCountMapForCombos);
  const comboTotal = combos.combos6 * pts6 + combos.combos4 * pts4 + combos.combos2 * pts2;
  const totalScore = totalQuestPoints + comboTotal;
  const currentLevel = computeLevel(totalScore, gameLevels);

  const allQuestNumbers = quests.length > 0
    ? quests.map((_, i) => String(i + 1))
    : [...new Set(completedQuests.map(q => q.quest_number))].sort((a, b) => parseInt(a) - parseInt(b));

  const getQuestPoints = (questNumber: string): number => {
    const idx = parseInt(questNumber, 10) - 1;
    const raw = quests[idx]?.points;
    if (raw === undefined || raw === null) return 0;
    return typeof raw === 'string' ? parseInt(raw, 10) || 0 : raw;
  };

  const questCountRows = allQuestNumbers.map(num => ({
    questNumber: num,
    name: getQuestName(num),
    points: getQuestPoints(num),
    count: questCountMap[num] ?? 0,
  }));

  // Quests tab: list individual completions youngest (most recent) first.
  const questsNewestFirst = [...completedQuests].sort((a, b) => {
    const at = a.completed_at ? new Date(a.completed_at).getTime() : 0;
    const bt = b.completed_at ? new Date(b.completed_at).getTime() : 0;
    if (at !== bt) return bt - at;
    return b.id - a.id;
  });

  // Recompute the team's score from a fresh set of completions (quest points +
  // combo bonus, matching how the list/modal display it) and persist it, so the
  // rankings / in-game HUD stay consistent after a manual adjustment.
  const recomputeScore = (rows: CompletedQuest[]): number => {
    const qp = rows.reduce((s, q) => s + (q.points_awarded ?? 0), 0);
    const countMap = new Map<string, number>();
    for (const q of rows) countMap.set(q.quest_number, (countMap.get(q.quest_number) ?? 0) + 1);
    const c = computeCombos(countMap);
    return qp + c.combos6 * pts6 + c.combos4 * pts4 + c.combos2 * pts2;
  };

  const adjustQuest = async (questNumber: string, delta: 1 | -1) => {
    if (mutating) return;
    setMutating(true);
    try {
      if (delta === 1) {
        await recordCompletedQuest({
          launched_game_id: launchedGameId,
          team_id: team.id,
          quest_number: questNumber,
          points_awarded: getQuestPoints(questNumber),
          allow_duplicates: true,
        });
      } else {
        await deleteCompletedQuest({
          launched_game_id: launchedGameId,
          team_id: team.id,
          quest_number: questNumber,
        });
      }
      const fresh = (await listCompletedQuests(launchedGameId, team.id)).map(toCompletedQuest);
      setCompletedQuests(fresh);
      await updateTeam(team.id, { score: recomputeScore(fresh) });
    } catch (err) {
      console.error('[TeamDetailsModal] adjustQuest failed:', err);
    } finally {
      setMutating(false);
    }
  };

  // ───────────────────────── Mystery enigmas ─────────────────────────
  // Station codes this team scored on, with pre-existing (stale) punches removed
  // exactly as the engine does at the finishing bip — see liveCodesForTeam. The
  // base status of each enigma is derived from this set + the pattern's
  // good/wrong station codes, matching MysteryGamePage's scoring.
  const punchedCodes = liveCodesForTeam(rawDataRecords, currentTeam.start_time, currentTeam.end_time);

  const findGameEnigma = (enigmaId: string): GameEnigma | undefined =>
    gameData?.game_enigmas?.find((ge) => ge.number === enigmaId);

  const detectBaseStatus = (pe: patternStore.PatternEnigma): EnigmaStatus => {
    const hasGood = pe.good_answers.some((a) => punchedCodes.has(a));
    const hasWrong = pe.wrong_answers.some((a) => punchedCodes.has(a));
    if (hasGood && hasWrong) return 'both';
    if (hasGood) return 'found';
    if (hasWrong) return 'wrong';
    return 'not_found';
  };

  const toPoints = (n: string | number | undefined): number => {
    if (n === undefined || n === null) return 0;
    const v = typeof n === 'string' ? parseInt(n, 10) : n;
    return Number.isFinite(v) ? v : 0;
  };

  const resolveEnigmaThumb = (filename?: string): string => {
    if (!filename || filename === 'undefined' || filename === 'null') return '';
    return scenarioAssetUrl(gameUniqid, filename);
  };

  const enigmaRows = patternEnigmas.map((pe) => {
    const ge = findGameEnigma(pe.enigma_id);
    const goodPts = toPoints(ge?.good_answer_points);
    const wrongPts = toPoints(ge?.wrong_answer_points);
    const base = detectBaseStatus(pe);
    const override = enigmaOverrides[pe.enigma_id];
    const effective: EnigmaStatus = override ?? base;
    return {
      enigmaId: pe.enigma_id,
      name: ge?.text || `Enigma ${pe.enigma_id}`,
      thumb: resolveEnigmaThumb(ge?.good_answer_image),
      goodPts,
      wrongPts,
      base,
      effective,
      overridden: override !== undefined && override !== base,
      points: enigmaPoints(effective, goodPts, wrongPts),
    };
  });

  // Full recompute of the team's score from the effective (override-applied)
  // status of every enigma, matching MysteryGamePage's scoring rule.
  const recomputeMysteryScore = (overrides: Record<string, EnigmaStatus>): number =>
    patternEnigmas.reduce((sum, pe) => {
      const ge = findGameEnigma(pe.enigma_id);
      const eff = overrides[pe.enigma_id] ?? detectBaseStatus(pe);
      return sum + enigmaPoints(eff, toPoints(ge?.good_answer_points), toPoints(ge?.wrong_answer_points));
    }, 0);

  // Set (or, when the chosen status equals the detected one, clear) an enigma's
  // override: persist the override map to launched-game meta, then recompute and
  // persist the team score. Optimistic; reverts local state on failure.
  const setEnigmaStatus = async (enigmaId: string, status: EnigmaStatus, base: EnigmaStatus) => {
    if (mutating) return;
    const prevOverrides = enigmaOverrides;
    const nextOverrides = { ...enigmaOverrides };
    if (status === base) delete nextOverrides[enigmaId];
    else nextOverrides[enigmaId] = status;

    setMutating(true);
    setEnigmaOverrides(nextOverrides); // optimistic
    try {
      // Read-modify-write the FULL meta blob — update_meta replaces all keys,
      // so we must send everything back, not just enigma_overrides.
      const meta = await getLaunchedGameMeta(launchedGameId);
      let all: Record<string, Record<string, EnigmaStatus>>;
      try {
        all = JSON.parse(meta.enigma_overrides || '{}');
        if (!all || typeof all !== 'object') all = {};
      } catch {
        all = {};
      }
      if (Object.keys(nextOverrides).length === 0) delete all[String(team.id)];
      else all[String(team.id)] = nextOverrides;
      await updateLaunchedGameMeta(launchedGameId, { ...meta, enigma_overrides: JSON.stringify(all) });

      const score = recomputeMysteryScore(nextOverrides);
      await updateTeam(team.id, { score });
      setCurrentTeam((t) => ({ ...t, score }));
    } catch (err) {
      console.error('[TeamDetailsModal] setEnigmaStatus failed:', err);
      setEnigmaOverrides(prevOverrides); // roll back
    } finally {
      setMutating(false);
    }
  };

  // Mystery header summary values.
  const enigmaFoundCount = enigmaRows.filter((r) => r.effective === 'found').length;
  const mysteryScore = enigmaRows.reduce((s, r) => s + r.points, 0);
  const mysteryScoreFull = toPoints(gameData?.game_meta?.score_full_game) || 100;
  const mysteryScoreText =
    gameData?.game_meta?.points_units === 'percentage'
      ? `${Math.round(mysteryScore)}%`
      : `${Math.round(mysteryScore)} / ${mysteryScoreFull}`;
  const mysteryLevel = computeLevel(mysteryScore, gameData?.game_meta?.levels ?? gameData?.levels);
  const mysteryDurationText =
    currentTeam.start_time != null && currentTeam.end_time != null
      ? formatDuration(currentTeam.end_time - currentTeam.start_time)
      : '—';

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
          <div>
            <h2 className="text-white font-semibold text-lg">{team.team_name}</h2>
            <p className="text-slate-400 text-sm">Game details — Chip #{team.key_id}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-700 rounded-lg transition text-slate-400 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        {/* Score summary */}
        <div className="px-6 py-4 border-b border-slate-700 shrink-0">
          {isMystery ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                  <Puzzle size={11} /> Found
                </div>
                <div className="text-green-400 font-bold text-xl">
                  {enigmaFoundCount}
                  <span className="text-slate-500 text-sm font-medium">/{enigmaRows.length}</span>
                </div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                  <Award size={11} /> Score
                </div>
                <div className="text-blue-400 font-bold text-xl">{mysteryScoreText}</div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                  <Award size={11} /> Level
                </div>
                {mysteryLevel ? (
                  <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                    {mysteryLevel.name}
                  </div>
                ) : (
                  <div className="text-slate-600 font-bold text-xl">—</div>
                )}
              </div>
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                  <Clock size={11} /> Time
                </div>
                <div className="text-white font-bold text-xl">{mysteryDurationText}</div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                  <Target size={11} /> Quests
                </div>
                <div className="text-white font-bold text-xl">{completedQuests.length}</div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                  <Award size={11} /> Quest pts
                </div>
                <div className="text-blue-400 font-bold text-xl">{totalQuestPoints}</div>
              </div>
              {hasComboConfig && (
                <div className="bg-slate-800 rounded-lg p-3 text-center">
                  <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                    <Zap size={11} /> Combo bonus
                  </div>
                  <div className="text-amber-400 font-bold text-xl">{comboTotal}</div>
                </div>
              )}
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                  <Clock size={11} /> Total score
                </div>
                <div className="text-green-400 font-bold text-xl">{totalScore}</div>
                {currentLevel && (
                  <div className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                    {currentLevel.name}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Combo breakdown */}
        {!isMystery && hasComboConfig && (combos.combos6 > 0 || combos.combos4 > 0 || combos.combos2 > 0) && (
          <div className="px-6 py-3 border-b border-slate-700 shrink-0 bg-amber-950/20">
            <p className="text-amber-400 text-xs font-medium mb-2 flex items-center gap-1.5">
              <Zap size={12} /> Combo breakdown
            </p>
            <div className="flex flex-wrap gap-2">
              {combos.combos6 > 0 && (
                <span className="px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-amber-300 text-xs">
                  {combos.combos6}× combo-6 = +{combos.combos6 * pts6} pts
                </span>
              )}
              {combos.combos4 > 0 && (
                <span className="px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-amber-300 text-xs">
                  {combos.combos4}× combo-4 = +{combos.combos4 * pts4} pts
                </span>
              )}
              {combos.combos2 > 0 && (
                <span className="px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-amber-300 text-xs">
                  {combos.combos2}× combo-2 = +{combos.combos2 * pts2} pts
                </span>
              )}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-slate-700 shrink-0">
          {isMystery ? (
            <button
              onClick={() => setActiveTab('enigmas')}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition border-b-2 ${
                activeTab === 'enigmas'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-slate-400 hover:text-white'
              }`}
            >
              <Puzzle size={14} />
              Enigmas ({enigmaRows.length})
            </button>
          ) : (
            <>
              <button
                onClick={() => setActiveTab('quests')}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition border-b-2 ${
                  activeTab === 'quests'
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                <Target size={14} />
                Quests ({completedQuests.length})
              </button>
              <button
                onClick={() => setActiveTab('quest-count')}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition border-b-2 ${
                  activeTab === 'quest-count'
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                <BarChart2 size={14} />
                Quest count
              </button>
            </>
          )}
          <button
            onClick={() => setActiveTab('punches')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition border-b-2 ${
              activeTab === 'punches'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <List size={14} />
            Punches ({rawDataRecords.length})
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-500 text-sm">
              Loading...
            </div>
          ) : activeTab === 'enigmas' ? (
            <div className="p-4 space-y-2">
              {enigmaRows.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">
                  No enigmas in this game's pattern.
                </p>
              ) : (
                enigmaRows.map((row) => (
                  <div
                    key={row.enigmaId}
                    className="flex items-center gap-3 bg-slate-800 border border-slate-700 rounded-lg p-2.5"
                  >
                    {/* Thumbnail */}
                    <div className="w-11 h-11 shrink-0 rounded-md bg-slate-900 border border-slate-700 overflow-hidden flex items-center justify-center">
                      {row.thumb ? (
                        <img src={row.thumb} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageOff size={16} className="text-slate-600" />
                      )}
                    </div>

                    {/* Name + points */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-white text-sm font-medium truncate">{row.name}</span>
                        {row.overridden && (
                          <span className="inline-flex items-center gap-1 shrink-0 text-amber-400 text-[10px] font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                            edited
                          </span>
                        )}
                      </div>
                      <div className="text-slate-500 text-xs">
                        +{row.goodPts}
                        {row.wrongPts > 0 && <span className="text-slate-600"> / −{row.wrongPts}</span>}
                        <span className="text-slate-600"> pts</span>
                      </div>
                    </div>

                    {/* Revert to detected */}
                    {row.overridden && (
                      <button
                        onClick={() => setEnigmaStatus(row.enigmaId, row.base, row.base)}
                        disabled={mutating}
                        className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition shrink-0"
                        title={`Revert to detected (${ENIGMA_STATUS_META[row.base].label})`}
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}

                    {/* 4-way status pills */}
                    <div className="flex shrink-0 rounded-md overflow-hidden border border-slate-700">
                      {ENIGMA_STATUS_ORDER.map((status) => {
                        const active = row.effective === status;
                        const meta = ENIGMA_STATUS_META[status];
                        return (
                          <button
                            key={status}
                            onClick={() => setEnigmaStatus(row.enigmaId, status, row.base)}
                            disabled={mutating}
                            className={`px-2 py-1.5 text-[11px] font-medium transition border-l border-slate-700 first:border-l-0 disabled:cursor-not-allowed ${
                              active
                                ? meta.activeClass
                                : 'bg-slate-900 text-slate-400 hover:bg-slate-700 hover:text-white disabled:opacity-50'
                            }`}
                            title={meta.label}
                          >
                            {meta.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : activeTab === 'quests' ? (
            <div className="p-4">
              {completedQuests.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">No quests completed yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-400 text-xs border-b border-slate-700">
                      <th className="text-left py-2 pr-3 font-medium">#</th>
                      <th className="text-left py-2 pr-3 font-medium">Quest</th>
                      <th className="text-right py-2 pr-3 font-medium">Points</th>
                      <th className="text-right py-2 font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {questsNewestFirst.map((cq, i) => (
                      <tr key={cq.id} className="border-b border-slate-800 hover:bg-slate-800/50 transition">
                        <td className="py-2.5 pr-3 text-slate-500">{i + 1}</td>
                        <td className="py-2.5 pr-3 text-white font-medium">
                          {getQuestName(cq.quest_number)}
                          {cq.teammate_chip_id && cq.teammate_chip_id !== team.key_id && (
                            <span className="ml-2 text-xs text-teal-400">chip #{cq.teammate_chip_id}</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-right">
                          <span className="text-blue-400 font-semibold">+{cq.points_awarded}</span>
                        </td>
                        <td className="py-2.5 text-right text-slate-400 text-xs">
                          {cq.completed_at ? formatCreatedAt(cq.completed_at) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : activeTab === 'quest-count' ? (
            <div className="p-4">
              {questCountRows.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">No quest data available.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-400 text-xs border-b border-slate-700">
                      <th className="text-left py-2 pr-3 font-medium">#</th>
                      <th className="text-left py-2 pr-3 font-medium">Quest</th>
                      <th className="text-right py-2 pr-3 font-medium">Pts</th>
                      <th className="text-right py-2 pr-3 font-medium">Completions</th>
                      <th className="text-right py-2 font-medium w-28">Adjust</th>
                    </tr>
                  </thead>
                  <tbody>
                    {questCountRows.map((row) => (
                      <tr key={row.questNumber} className="border-b border-slate-800 hover:bg-slate-800/50 transition">
                        <td className="py-2.5 pr-3 text-slate-500 text-xs">{row.questNumber}</td>
                        <td className="py-2.5 pr-3 text-white">{row.name}</td>
                        <td className="py-2.5 pr-3 text-right">
                          {row.points > 0
                            ? <span className="text-amber-400 text-xs font-medium">{row.points}</span>
                            : <span className="text-slate-600 text-xs">—</span>
                          }
                        </td>
                        <td className="py-2.5 pr-3 text-right">
                          <span className={row.count > 0 ? 'text-blue-400 font-semibold' : 'text-slate-600'}>
                            {row.count}
                          </span>
                        </td>
                        <td className="py-2.5 text-right w-28">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => adjustQuest(row.questNumber, -1)}
                              disabled={mutating || row.count === 0}
                              className="p-1 rounded bg-slate-700 hover:bg-red-600/70 text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                              title="Remove one completion"
                            >
                              <Minus size={14} />
                            </button>
                            <button
                              onClick={() => adjustQuest(row.questNumber, 1)}
                              disabled={mutating}
                              className="p-1 rounded bg-slate-700 hover:bg-green-600/70 text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                              title="Add one completion"
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : activeTab === 'punches' ? (
            <div className="p-4 space-y-2">
              {rawDataRecords.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">No punch records found.</p>
              ) : (
                rawDataRecords.map((rec, i) => {
                  const isExpanded = expandedPunch === rec.id;
                  const punches = rec.raw_data?.punches ?? [];
                  return (
                    <div key={rec.id} className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
                      <button
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-700/50 transition text-left"
                        onClick={() => setExpandedPunch(isExpanded ? null : rec.id)}
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-slate-500 text-xs">#{i + 1}</span>
                          <span className="text-white text-sm font-medium">
                            {punches.length} punch{punches.length !== 1 ? 'es' : ''}
                          </span>
                          {rec.raw_data?.id != null && (
                            <span className="text-slate-400 text-xs">chip #{rec.raw_data.id}</span>
                          )}
                          {rec.raw_data?.end != null && (
                            <span className="px-1.5 py-0.5 bg-green-900/50 border border-green-700/50 rounded text-green-400 text-xs">
                              end station
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-slate-400 text-xs">{formatCreatedAt(rec.created_at)}</span>
                          {isExpanded ? (
                            <ChevronUp size={14} className="text-slate-400" />
                          ) : (
                            <ChevronDown size={14} className="text-slate-400" />
                          )}
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="border-t border-slate-700 px-4 py-3">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-slate-500 border-b border-slate-700">
                                <th className="text-left py-1.5 pr-3 font-medium">Station code</th>
                                <th className="text-right py-1.5 font-medium">Punch time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {punches.map((p, j) => (
                                <tr key={j} className="border-b border-slate-800/60">
                                  <td className="py-1.5 pr-3 text-white font-mono">{p.code}</td>
                                  <td className="py-1.5 text-right text-slate-400">
                                    {formatTimestamp(p.time)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
