import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Award, Zap, Target, Clock, List, ChevronDown, ChevronUp, BarChart2, Plus, Minus, Puzzle, RotateCcw, ImageOff, Pencil, Save, MapPin, AlertTriangle } from 'lucide-react';
import * as scenarioStore from '../services/scenarioStore';
import * as patternStore from '../services/patternStore';
import * as cardsRepo from '../services/cardsRepo';
import {
  checkpointsForRoute,
  orderedHitCheckpointIds,
  computeScore,
  type TracksCheckpoint,
  type TracksScoreType,
} from '../services/tracksScoring';
import { scenarioAssetUrl } from '../services/contentFs';
import { LANG_NAMES } from '../services/langFlags';
import { HelpDot } from '../help';
import {
  getLaunchedGameState,
  getLaunchedGameMeta,
  updateLaunchedGameMeta,
  listCompletedQuests,
  recordCompletedQuest,
  deleteCompletedQuest,
  updateTeam,
} from '../services/launchedGames';
import { getClashMembers } from '../services/clash';
import { wrongAnswerPoints } from '../services/mysteryScoring';
import {
  computeCombos,
  effectifWeights,
  formatWeight,
  isWeightingEnabled,
  memberCounts,
  partitionMalusRows,
  teamHeadcounts,
  weightedScore,
  type RosterTeam,
} from '../services/tagquestScoring';
import { parseDbTs, formatDbTime } from '../utils/dbTime';
import { gameClock } from '../services/gameClock';

interface Team {
  id: number;
  team_number: number;
  team_name: string;
  score: number;
  start_time: number | null;
  end_time: number | null;
  key_id: number;
  language?: string | null;
}

interface CompletedQuest {
  id: number;
  quest_number: string;
  points_awarded: number;
  teammate_chip_id: number | null;
  completed_at: string | null;
}

/** Chip number + carrier name for a chip id (see `chipInfo`). */
interface ChipInfo {
  number: number | null;
  name: string | null;
}

/** The slice of meta.teamsConfig this modal needs to name a chip's carrier. */
interface RosterEntry {
  chipId?: number;
  chipNumber?: number;
  name?: string;
  teammates?: Array<{ chipId?: number; chipNumber?: number; name?: string }>;
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
  /** Scenario's available languages - when 2+, a per-team language select shows. */
  languages?: string[];
  /** Launch language, used as the select's default when the team has none. */
  launchLanguage?: string;
  /** Called after the team's language is changed so the list can refresh. */
  onTeamUpdated?: () => void;
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

// Points a single enigma contributes for a given (effective) status - the same
// rule MysteryGamePage applies: good answer adds its points, wrong answer adds
// its (negative) points, both = the both-answers malus, no-answer = the
// no-answer malus. Every one of them is signed; default 0.
//
// `wrongPts` must already be signed - pass it through wrongAnswerPoints().
function enigmaPoints(
  status: EnigmaStatus,
  goodPts: number,
  wrongPts: number,
  bothMalus: number,
  noAnswerMalus: number,
): number {
  if (status === 'found') return goodPts;
  if (status === 'wrong') return wrongPts;
  if (status === 'both') return bothMalus;
  return noAnswerMalus; // 'not_found'
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

// Tracks per-checkpoint outcome, mirroring TracksGamePage's reveal walk:
// correct (credited hit) / wrong (punched but not credited - itinerary
// out-of-order) / missing (never reached).
type CpStatus = 'correct' | 'wrong' | 'missing';

const CP_STATUS_META: Record<CpStatus, { label: string; activeClass: string }> = {
  correct: { label: 'Found',     activeClass: 'bg-green-600 text-white border-green-500' },
  wrong:   { label: 'Wrong',     activeClass: 'bg-red-600 text-white border-red-500' },
  missing: { label: 'Not found', activeClass: 'bg-slate-500 text-white border-slate-400' },
};

const CP_STATUS_ORDER: CpStatus[] = ['correct', 'wrong', 'missing'];

// Per-team checkpoint overrides, stored under `checkpoint_overrides` in meta as
// JSON: { "<teamId>": { "<checkpointId>": status } }.
function readCheckpointOverrides(meta: Record<string, string>, teamId: number): Record<string, CpStatus> {
  try {
    const all = JSON.parse(meta.checkpoint_overrides || '{}');
    const forTeam = all?.[String(teamId)];
    return forTeam && typeof forTeam === 'object' ? (forTeam as Record<string, CpStatus>) : {};
  } catch {
    return {};
  }
}

// Mystery "count the punches already on the card" flag, stored under
// `stale_punches_allowed` in meta as JSON: { "<teamId>": true }.
function readStaleAllowed(meta: Record<string, string>, teamId: number): boolean {
  try {
    return JSON.parse(meta.stale_punches_allowed || '{}')?.[String(teamId)] === true;
  } catch {
    return false;
  }
}

// Read a per-team numeric value from a JSON map stored in launched-game meta
// (e.g. `late_malus` / `late_malus_overrides` = { "<teamId>": number }).
// Returns null when absent/unparseable.
function readNumForTeam(json: string | undefined, teamId: number): number | null {
  try {
    const all = JSON.parse(json || '{}');
    const v = all?.[String(teamId)];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/** Read a Localized<string> map (or plain string) at the given language. */
function readLocalizedish(value: unknown, lang: string): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const o = value as Record<string, string>;
    return o[lang] ?? o.fr ?? o.en ?? Object.values(o)[0] ?? '';
  }
  return '';
}

function rowEpochSeconds(iso: string): number {
  const t = parseDbTs(iso);
  return Number.isFinite(t) ? t / 1000 : NaN;
}

// Reconstruct the station codes this team actually scored on, mirroring
// MysteryGamePage exactly. The engine snapshots the card's PRE-EXISTING punches
// at the start bip (those with a real time, not the 00:00:00 placeholder) and,
// at the finish bip, scores `finishPunches − baseline`. That baseline lives only
// in memory at runtime, but both bips persist as raw_data snapshots - so we
// rebuild start/finish per card and subtract here. A naive "count every code"
// would re-introduce the stale punches the engine dropped, drifting the modal's
// status/score away from what was actually scored.
//
// When a card is reused across runs, all its rows are present; we window to this
// team's [start, end] (with a skew margin) so the right start/finish pair is
// used, falling back to every row if windowing leaves nothing.
//
// `countStale` mirrors the operator's "count the punches already on the card"
// switch: the baseline is still measured (`staleCount`) but not subtracted.
function liveCodesForTeam(
  records: RawDataRecord[],
  startTime: number | null,
  endTime: number | null,
  countStale = false,
): { codes: Set<string>; staleCount: number } {
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
  let staleCount = 0;
  for (const allRows of byCard.values()) {
    let rows = allRows;
    if (startTime != null) {
      const lo = startTime - SKEW_MARGIN_SEC;
      const hi = (endTime ?? Math.floor(gameClock.now() / 1000)) + SKEW_MARGIN_SEC;
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
    staleCount += baseline.size;
    for (const p of finishRow.raw_data?.punches ?? []) {
      if (!countStale && baseline.has(`${p.code}@${p.time}`)) continue;
      codes.add(String(p.code));
    }
  }
  return { codes, staleCount };
}

// Tracks variant of liveCodesForTeam: returns the slot position on the card of
// the first live punch per station code, so itinerary ordering can be
// recomputed. Card order, not station clocks: those drift (retours sept. #2).
// Same baseline-subtraction + per-card windowing as liveCodesForTeam.
function liveHitSlotsForTeam(
  records: RawDataRecord[],
  startTime: number | null,
  endTime: number | null,
): Map<string, number> {
  const byCard = new Map<number, RawDataRecord[]>();
  for (const r of records) {
    const cid = Number((r.raw_data as { id?: number } | null)?.id);
    if (!Number.isFinite(cid)) continue;
    const arr = byCard.get(cid);
    if (arr) arr.push(r);
    else byCard.set(cid, [r]);
  }

  const SKEW_MARGIN_SEC = 60;
  const out = new Map<string, number>();
  let slot = 0;
  for (const allRows of byCard.values()) {
    let rows = allRows;
    if (startTime != null) {
      const lo = startTime - SKEW_MARGIN_SEC;
      const hi = (endTime ?? Math.floor(gameClock.now() / 1000)) + SKEW_MARGIN_SEC;
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
      if (p.time == null || String(p.time) === '00:00:00') continue;
      const k = String(p.code);
      if (!out.has(k)) out.set(k, slot);
      slot++;
    }
  }
  return out;
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
    // Signed maluses applied once per enigma in the matching outcome state
    // (default 0; negative = penalty, positive = bonus). Mirror MysteryGamePage.
    malus_both_answers_biped?: string | number;
    malus_no_answer?: string | number;
    // Tracks: the checkpoint list + unique-image config (used by the Checkpoints tab).
    checkpoints?: TracksCheckpoint[];
    checkpoints_unique_image?: boolean;
    checkpoints_unique_image_id?: string;
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
  if (ts === null || ts === undefined) return '-';
  // A punch time is the station's own clock as "HH:MM:SS" - already the local
  // wall time; parseFloat("09:49:12") used to render it as 1970 + 9 s.
  if (typeof ts === 'string' && ts.includes(':')) return ts;
  const ms = typeof ts === 'string' ? parseFloat(ts) : ts;
  const adjusted = ms > 1e10 ? ms : ms * 1000;
  return new Date(adjusted).toLocaleTimeString();
}

function formatCreatedAt(iso: string): string {
  return formatDbTime(iso);
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

export function TeamDetailsModal({ team, launchedGameId, gameUniqid, gameType, chipIds, languages, launchLanguage, onTeamUpdated, onClose }: TeamDetailsModalProps) {
  const { t } = useTranslation();
  // Translated label for an enigma status (the ENIGMA_STATUS_META labels are
  // English fallbacks; the displayed text comes from the i18n catalogue).
  const enigmaStatusLabel = (status: EnigmaStatus): string => t(`teamDetails:enigmaStatus_${status}`);
  // launched_games stores game_type capitalised ('Mystery'), while scenario rows
  // use the lowercase slug - compare case-insensitively so either value matches.
  const isMystery = (gameType ?? '').toLowerCase() === 'mystery';
  const isTracks = (gameType ?? '').toLowerCase() === 'tracks';
  const isTagQuest = (gameType ?? '').toLowerCase() === 'tagquest';
  // Real quest completions only - malus-station hits share the same table (see
  // MALUS_QUEST_NUMBER) and are split into `stationMalus` below so they never
  // show up as quests or feed the combo math.
  const [completedQuests, setCompletedQuests] = useState<CompletedQuest[]>([]);
  /** TagQuest: points this team lost to punches on the scenario's malus station. */
  const [stationMalus, setStationMalus] = useState(0);
  // TagQuest effectif weighting (when the launch option is on): this team's live
  // headcount + weight, refreshed on the same poll as the quest rows so the
  // modal's totals match lg_teams.score. null ⇒ weighting off / not tagquest.
  const [effectifWeight, setEffectifWeight] = useState<number | null>(null);
  const [effectifHeadcount, setEffectifHeadcount] = useState<number | null>(null);
  const [rawDataRecords, setRawDataRecords] = useState<RawDataRecord[]>([]);
  const [gameData, setGameData] = useState<GameDataJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'quests' | 'quest-count' | 'punches' | 'enigmas' | 'checkpoints' | 'edit'>(
    isMystery ? 'enigmas' : isTracks ? 'checkpoints' : 'quests'
  );
  const [expandedPunch, setExpandedPunch] = useState<number | null>(null);
  const [mutating, setMutating] = useState(false);
  const [currentTeam, setCurrentTeam] = useState(team);
  // Mystery: the pattern's good/wrong answer-station codes per enigma, plus the
  // operator's persisted per-enigma status overrides for THIS team.
  const [patternEnigmas, setPatternEnigmas] = useState<patternStore.PatternEnigma[]>([]);
  const [enigmaOverrides, setEnigmaOverrides] = useState<Record<string, EnigmaStatus>>({});
  // Mystery late malus: the value auto-applied at the finishing bip, plus an
  // optional operator override (null = use the auto value). The effective malus
  // is subtracted from the enigma points to form the team's score.
  const [lateMalusAuto, setLateMalusAuto] = useState(0);
  const [lateMalusOverride, setLateMalusOverride] = useState<number | null>(null);
  // Mystery: operator chose to count the punches already on the card at the
  // start bip (a player who played before bipping in). Persisted in meta as
  // `stale_punches_allowed` = { "<teamId>": true }; the engine honours it at the
  // finishing bip.
  const [staleAllowed, setStaleAllowedState] = useState(false);
  // Mystery late-malus inputs (from launched-game meta): penalty per started
  // minute over the limit, and the game's time limit in minutes. Used to
  // re-derive the auto malus when the operator edits the start/end times.
  const [malusPerMinute, setMalusPerMinute] = useState(0);
  const [timeLimitMin, setTimeLimitMin] = useState(0);
  // Tracks: the pattern's per-checkpoint station codes (keyed by 1-based
  // checkpoint ordinal), this team's route + score config, and the operator's
  // persisted per-checkpoint status overrides.
  const [cpStations, setCpStations] = useState<Map<number, number[]>>(new Map());
  const [cpOverrides, setCpOverrides] = useState<Record<string, CpStatus>>({});
  const [tracksRoute, setTracksRoute] = useState('default');
  const [tracksScoreType, setTracksScoreType] = useState<TracksScoreType>('percentage');
  const [tracksPlayMode, setTracksPlayMode] = useState<'itinerary' | 'free'>('free');
  // chip id → its number + the name of whoever carries it, so quest rows and
  // punch records can be attributed to a person rather than a bare chip id.
  // Filled from the card registry and (overriding it) the launch roster.
  const [chipInfo, setChipInfo] = useState<Map<number, ChipInfo>>(new Map());
  const chipKey = (chipIds ?? []).join(',');

  // Auto late-malus for a run of `durationSec` - mirrors MysteryGamePage's rule.
  const computeAutoLateMalus = (durationSec: number): number => {
    const limitSec = timeLimitMin * 60;
    if (malusPerMinute <= 0 || limitSec <= 0 || durationSec <= limitSec) return 0;
    return Math.ceil((durationSec - limitSec) / 60) * malusPerMinute;
  };

  // Inline edit form (the "modify" panel folded in from the launched-games list).
  // Seeded once from the team prop so the 2s polling refresh of currentTeam never
  // clobbers what the operator is typing.
  const [editForm, setEditForm] = useState({
    team_name: team.team_name,
    start_time: team.start_time,
    end_time: team.end_time,
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const formatTimeForInput = (timestamp: number | null) => {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  };

  const parseTimeInput = (timeString: string): number | null => {
    if (!timeString) return null;
    const [hours, minutes, seconds] = timeString.split(':').map(Number);
    const now = new Date();
    now.setHours(hours, minutes, seconds || 0, 0);
    // Persist in unix SECONDS to match how gameplay records team times.
    return Math.floor(now.getTime() / 1000);
  };

  const handleSaveEdit = async () => {
    setSavingEdit(true);
    try {
      const start = editForm.start_time ?? null;
      const end = editForm.end_time ?? null;
      const patch: {
        team_name: string | null;
        start_time: number | null;
        end_time: number | null;
        score?: number;
      } = {
        team_name: editForm.team_name ?? null,
        start_time: start,
        end_time: end,
      };

      // Mystery: the late malus is derived from the run duration, so editing the
      // start/end times must re-derive it (and the score). We recompute the AUTO
      // malus from the new duration, drop any manual late-malus override (the
      // edited time is now the source of truth), and persist
      // score = enigma points − new auto malus.
      let nextAutoMalus = lateMalusAuto;
      let overrideCleared = false;
      if (isMystery && start != null && end != null) {
        nextAutoMalus = computeAutoLateMalus(end - start);
        patch.score = enigmaPointsTotal(enigmaOverrides) - nextAutoMalus;
        const meta = await getLaunchedGameMeta(launchedGameId);
        let lm: Record<string, number>;
        try {
          lm = JSON.parse(meta.late_malus || '{}');
          if (!lm || typeof lm !== 'object') lm = {};
        } catch {
          lm = {};
        }
        lm[String(team.id)] = nextAutoMalus;
        let ov: Record<string, number>;
        try {
          ov = JSON.parse(meta.late_malus_overrides || '{}');
          if (!ov || typeof ov !== 'object') ov = {};
        } catch {
          ov = {};
        }
        if (ov[String(team.id)] != null) {
          delete ov[String(team.id)];
          overrideCleared = true;
        }
        await updateLaunchedGameMeta(launchedGameId, {
          ...meta,
          late_malus: JSON.stringify(lm),
          late_malus_overrides: JSON.stringify(ov),
        });
      }

      // Tracks: the score's time malus depends on the run duration, so editing
      // the start/end times must re-derive it from the (override-applied) hits.
      if (isTracks && start != null && end != null) {
        patch.score = recomputeTracksScore(cpOverrides, start, end);
      }

      await updateTeam(team.id, patch);
      setCurrentTeam((prev) => ({
        ...prev,
        ...editForm,
        ...(patch.score != null ? { score: patch.score } : {}),
      }));
      if (isMystery && start != null && end != null) {
        setLateMalusAuto(nextAutoMalus);
        if (overrideCleared) setLateMalusOverride(null);
      }
      onTeamUpdated?.();
    } catch (err) {
      console.error('[TeamDetailsModal] save edit failed:', err);
      alert(t('teamDetails:editSaveFailed'));
    } finally {
      setSavingEdit(false);
    }
  };

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

  // Chip registry for this game: every card's number/name, then the launch
  // roster on top. The roster wins because its names are what the operator
  // typed for THIS game (team name for a leader chip, player name for a
  // teammate); the card's key_name is the fallback and covers self-register
  // games, whose members are bound at play time and never reach teamsConfig.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = new Map<number, ChipInfo>();
      try {
        for (const c of await cardsRepo.list()) {
          map.set(c.id, { number: c.key_number, name: c.key_name || null });
        }
      } catch (err) {
        console.error('[TeamDetailsModal] card registry load failed:', err);
      }
      try {
        const meta = await getLaunchedGameMeta(launchedGameId);
        const parsed: unknown = JSON.parse(meta.teamsConfig || '[]');
        const roster: RosterEntry[] = Array.isArray(parsed) ? parsed : [];
        for (const cfg of roster) {
          for (const entry of [cfg, ...(cfg?.teammates ?? [])]) {
            if (entry?.chipId == null) continue;
            const id = Number(entry.chipId);
            const prev = map.get(id);
            map.set(id, {
              number: entry.chipNumber ?? prev?.number ?? null,
              name: entry.name || prev?.name || null,
            });
          }
        }
      } catch (err) {
        console.error('[TeamDetailsModal] roster load failed:', err);
      }
      if (!cancelled) setChipInfo(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [launchedGameId]);

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
        setLateMalusAuto(readNumForTeam(meta.late_malus, team.id) ?? 0);
        setLateMalusOverride(readNumForTeam(meta.late_malus_overrides, team.id));
        setStaleAllowedState(readStaleAllowed(meta, team.id));
        setMalusPerMinute(meta.malusPerMinute != null ? parseInt(meta.malusPerMinute) || 0 : 0);
        setTimeLimitMin(meta.duration != null ? parseInt(meta.duration) || 0 : 0);
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

  // Tracks only: load this team's route + score config + per-checkpoint
  // overrides, plus the pattern's checkpoint→station map (so each checkpoint's
  // base status can be recomputed from the team's punches).
  useEffect(() => {
    if (!isTracks) return;
    let cancelled = false;
    (async () => {
      try {
        const meta = await getLaunchedGameMeta(launchedGameId);
        if (cancelled) return;
        setCpOverrides(readCheckpointOverrides(meta, team.id));
        setTracksRoute(meta[`route:${team.id}`] || meta.route || 'default');
        setTracksScoreType(meta.scoreType === 'points' ? 'points' : 'percentage');
        setTracksPlayMode(meta.trackPlayMode === 'itinerary' ? 'itinerary' : 'free');
        setMalusPerMinute(meta.malusPerMinute != null ? parseInt(meta.malusPerMinute) || 0 : 0);
        const patternUniqid = meta.pattern || '';
        if (patternUniqid) {
          const stations = await patternStore.getTracksCheckpointStations(patternUniqid);
          if (!cancelled) setCpStations(stations);
        }
      } catch (err) {
        console.error('[TeamDetailsModal] tracks load failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isTracks, launchedGameId, team.id]);

  useEffect(() => {
    const load = async (isInitial = false) => {
      if (isInitial) setLoading(true);

      try {
        const [questsRows, state, members] = await Promise.all([
          listCompletedQuests(launchedGameId, team.id),
          getLaunchedGameState(launchedGameId, 0),
          getClashMembers(launchedGameId).catch(() => []),
        ]);
        const split = partitionMalusRows(questsRows);
        setCompletedQuests(split.questRows.map(toCompletedQuest));
        setStationMalus(split.stationMalus);
        // Punches: in team mode each member punches with their OWN chip, so
        // filter the game's raw_data to every chip on this team (leader +
        // teammates) - the leader's key_id often never punches. state's
        // new_raw_data (since_raw_id 0) is the full set for the game.
        // chipIds only covers the launch-meta teamsConfig roster; self-register
        // games bind chips at play time via lg_clash_members instead, so union
        // in those bindings or their punches would be filtered out entirely.
        const chipSet = new Set(
          (chipIds && chipIds.length ? chipIds : [team.key_id]).map(Number)
        );
        members
          .filter((m) => m.team_id === team.id)
          .forEach((m) => chipSet.add(Number(m.chip_id)));
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
        // Authoritative game time limit (minutes) - used to re-derive the late
        // malus when start/end times are edited. Read from the launched-game row
        // (always present) rather than meta (absent on older games).
        if (typeof state.duration === 'number' && state.duration > 0) {
          setTimeLimitMin(state.duration);
        }
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
        // Effectif weighting: derive this team's live headcount + weight from
        // the same snapshot (all teams + roster/member bindings), so the tiles
        // and the ± quest adjusters below stay consistent with lg_teams.score.
        if (isTagQuest) {
          const meta = await getLaunchedGameMeta(launchedGameId);
          if (isWeightingEnabled(meta)) {
            let roster: RosterTeam[] = [];
            try { roster = JSON.parse(meta.teamsConfig || '[]'); } catch { /* swallow */ }
            const headcounts = teamHeadcounts(state.teams, roster, memberCounts(members));
            setEffectifHeadcount(headcounts.get(team.id) ?? 1);
            setEffectifWeight(effectifWeights(headcounts).get(team.id) ?? 1);
          } else {
            setEffectifWeight(null);
            setEffectifHeadcount(null);
          }
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

  // "Alice - (n°12 - id 8012345)": who punched, plus the chip's number and id.
  // A null chip id means the team's own (leader) chip. The leader is always
  // labelled with the team name - in solo mode that IS the player's name.
  const chipHolderLabel = (chipId: number | null | undefined): string => {
    const id = Number(chipId ?? currentTeam.key_id);
    if (!Number.isFinite(id) || id <= 0) return currentTeam.team_name;
    const info = chipInfo.get(id);
    const name = (id === currentTeam.key_id ? currentTeam.team_name : info?.name) || currentTeam.team_name;
    return info?.number != null
      ? t('teamDetails:chipHolder', { name, number: info.number, id })
      : t('teamDetails:chipHolderNoNumber', { name, id });
  };

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
    return quests[idx]?.name ?? t('teamDetails:questFallback', { number: questNumber });
  };

  const questCountMap = completedQuests.reduce<Record<string, number>>((acc, q) => {
    acc[q.quest_number] = (acc[q.quest_number] ?? 0) + 1;
    return acc;
  }, {});

  const questCountMapForCombos = new Map<string, number>(Object.entries(questCountMap));
  const combos = computeCombos(questCountMapForCombos);
  const comboTotal = combos.combos6 * pts6 + combos.combos4 * pts4 + combos.combos2 * pts2;
  // Effectif weighting (when active) scales the earned points - the tile then
  // matches the persisted score. Quest-pts / combo tiles stay raw on purpose.
  // The station malus is a penalty, so it comes off unweighted.
  const totalScore = weightedScore(totalQuestPoints + comboTotal, effectifWeight ?? 1, stationMalus);
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
    const at = a.completed_at ? parseDbTs(a.completed_at) || 0 : 0;
    const bt = b.completed_at ? parseDbTs(b.completed_at) || 0 : 0;
    if (at !== bt) return bt - at;
    return b.id - a.id;
  });

  // Recompute the team's score from a fresh set of completions (quest points +
  // combo bonus, matching how the list/modal display it) and persist it, so the
  // rankings / in-game HUD stay consistent after a manual adjustment. Applies
  // the effectif weight when active - otherwise a ± adjustment would overwrite
  // the punch logic's weighted score with a raw one - and re-subtracts the
  // station malus, which would otherwise be wiped by the same overwrite.
  // `rows` must be quest rows only (malus already split out).
  const recomputeScore = (rows: CompletedQuest[], malus: number): number => {
    const qp = rows.reduce((s, q) => s + (q.points_awarded ?? 0), 0);
    const countMap = new Map<string, number>();
    for (const q of rows) countMap.set(q.quest_number, (countMap.get(q.quest_number) ?? 0) + 1);
    const c = computeCombos(countMap);
    return weightedScore(qp + c.combos6 * pts6 + c.combos4 * pts4 + c.combos2 * pts2, effectifWeight ?? 1, malus);
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
      const split = partitionMalusRows(await listCompletedQuests(launchedGameId, team.id));
      const fresh = split.questRows.map(toCompletedQuest);
      setCompletedQuests(fresh);
      setStationMalus(split.stationMalus);
      await updateTeam(team.id, { score: recomputeScore(fresh, split.stationMalus) });
    } catch (err) {
      console.error('[TeamDetailsModal] adjustQuest failed:', err);
    } finally {
      setMutating(false);
    }
  };

  // ───────────────────────── Mystery enigmas ─────────────────────────
  // Station codes this team scored on, with pre-existing (stale) punches removed
  // exactly as the engine does at the finishing bip - see liveCodesForTeam. The
  // base status of each enigma is derived from this set + the pattern's
  // good/wrong station codes, matching MysteryGamePage's scoring.
  const live = liveCodesForTeam(rawDataRecords, currentTeam.start_time, currentTeam.end_time, staleAllowed);
  const punchedCodes = live.codes;
  const staleCount = live.staleCount;

  const findGameEnigma = (enigmaId: string): GameEnigma | undefined =>
    gameData?.game_enigmas?.find((ge) => ge.number === enigmaId);

  const detectBaseStatus = (pe: patternStore.PatternEnigma, codes: Set<string> = punchedCodes): EnigmaStatus => {
    const hasGood = pe.good_answers.some((a) => codes.has(a));
    const hasWrong = pe.wrong_answers.some((a) => codes.has(a));
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

  // Game-level signed maluses for the both-answers / no-answer states (default 0).
  const bothMalus = toPoints(gameData?.game_meta?.malus_both_answers_biped);
  const noAnswerMalus = toPoints(gameData?.game_meta?.malus_no_answer);

  const enigmaRows = patternEnigmas.map((pe) => {
    const ge = findGameEnigma(pe.enigma_id);
    const goodPts = toPoints(ge?.good_answer_points);
    const wrongPts = wrongAnswerPoints(ge?.wrong_answer_points);
    const base = detectBaseStatus(pe);
    const override = enigmaOverrides[pe.enigma_id];
    const effective: EnigmaStatus = override ?? base;
    return {
      enigmaId: pe.enigma_id,
      name: ge?.text || t('teamDetails:enigmaFallback', { id: pe.enigma_id }),
      thumb: resolveEnigmaThumb(ge?.good_answer_image),
      goodPts,
      wrongPts,
      base,
      effective,
      overridden: override !== undefined && override !== base,
      points: enigmaPoints(effective, goodPts, wrongPts, bothMalus, noAnswerMalus),
    };
  });

  // Effective late malus = operator override when set, else the auto value.
  const effectiveLateMalus = lateMalusOverride != null ? lateMalusOverride : lateMalusAuto;

  // Enigma points (override-applied) only - before the late malus.
  const enigmaPointsTotal = (overrides: Record<string, EnigmaStatus>, codes: Set<string> = punchedCodes): number =>
    patternEnigmas.reduce((sum, pe) => {
      const ge = findGameEnigma(pe.enigma_id);
      const eff = overrides[pe.enigma_id] ?? detectBaseStatus(pe, codes);
      return sum + enigmaPoints(eff, toPoints(ge?.good_answer_points), wrongAnswerPoints(ge?.wrong_answer_points), bothMalus, noAnswerMalus);
    }, 0);

  // Full recompute of the team's score: enigma points − effective late malus,
  // matching MysteryGamePage's scoring rule.
  const recomputeMysteryScore = (
    overrides: Record<string, EnigmaStatus>,
    lateMalusVal: number = effectiveLateMalus,
    codes: Set<string> = punchedCodes,
  ): number => enigmaPointsTotal(overrides, codes) - lateMalusVal;

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
      // Read-modify-write the FULL meta blob - update_meta replaces all keys,
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

  // Set (or clear, when `value` is null) this team's late-malus override:
  // persist the override map to launched-game meta, then recompute + persist the
  // team score. Optimistic; reverts local state on failure.
  const setLateMalus = async (value: number | null) => {
    if (mutating) return;
    const prev = lateMalusOverride;
    setMutating(true);
    setLateMalusOverride(value); // optimistic
    try {
      const meta = await getLaunchedGameMeta(launchedGameId);
      let all: Record<string, number>;
      try {
        all = JSON.parse(meta.late_malus_overrides || '{}');
        if (!all || typeof all !== 'object') all = {};
      } catch {
        all = {};
      }
      if (value == null) delete all[String(team.id)];
      else all[String(team.id)] = value;
      await updateLaunchedGameMeta(launchedGameId, { ...meta, late_malus_overrides: JSON.stringify(all) });

      const effective = value != null ? value : lateMalusAuto;
      const score = recomputeMysteryScore(enigmaOverrides, effective);
      await updateTeam(team.id, { score });
      setCurrentTeam((t) => ({ ...t, score }));
    } catch (err) {
      console.error('[TeamDetailsModal] setLateMalus failed:', err);
      setLateMalusOverride(prev); // roll back
    } finally {
      setMutating(false);
    }
  };

  // Count (or stop counting) the punches that were already on the card at the
  // start bip. Persists the flag to launched-game meta (read by the engine at the
  // finishing bip); if the run is already scored, recompute + persist the score
  // here. Optimistic; reverts local state on failure.
  const setStaleAllowed = async (value: boolean) => {
    if (mutating) return;
    const prev = staleAllowed;
    setMutating(true);
    setStaleAllowedState(value); // optimistic
    try {
      const meta = await getLaunchedGameMeta(launchedGameId);
      let all: Record<string, boolean>;
      try {
        all = JSON.parse(meta.stale_punches_allowed || '{}');
        if (!all || typeof all !== 'object') all = {};
      } catch {
        all = {};
      }
      if (value) all[String(team.id)] = true;
      else delete all[String(team.id)];
      await updateLaunchedGameMeta(launchedGameId, { ...meta, stale_punches_allowed: JSON.stringify(all) });

      if (currentTeam.end_time != null) {
        const codes = liveCodesForTeam(rawDataRecords, currentTeam.start_time, currentTeam.end_time, value).codes;
        const score = recomputeMysteryScore(enigmaOverrides, effectiveLateMalus, codes);
        await updateTeam(team.id, { score });
        setCurrentTeam((t) => ({ ...t, score }));
      }
      onTeamUpdated?.();
    } catch (err) {
      console.error('[TeamDetailsModal] setStaleAllowed failed:', err);
      setStaleAllowedState(prev); // roll back
    } finally {
      setMutating(false);
    }
  };

  // ───────────────────────── Tracks checkpoints ─────────────────────────
  const tracksLang = currentTeam.language || launchLanguage || 'fr';
  const cpStatusLabel = (status: CpStatus): string =>
    t(`teamDetails:cpStatus_${status}`, { defaultValue: CP_STATUS_META[status].label });
  const tracksAllCheckpoints: TracksCheckpoint[] = gameData?.game_meta?.checkpoints ?? [];
  const tracksRouteCps = checkpointsForRoute(tracksAllCheckpoints, tracksRoute);
  // First card slot per station code, then per route checkpoint.
  const cpHitSlots = liveHitSlotsForTeam(rawDataRecords, currentTeam.start_time, currentTeam.end_time);
  const cpNumberOf = (cp: TracksCheckpoint) => tracksAllCheckpoints.findIndex((c) => c.id === cp.id) + 1;
  const cpHitSlotById = new Map<string, number | undefined>();
  for (const cp of tracksRouteCps) {
    const codes = cpStations.get(cpNumberOf(cp)) ?? [];
    let first: number | undefined;
    for (const code of codes) {
      const s = cpHitSlots.get(String(code));
      if (s !== undefined && (first === undefined || s < first)) first = s;
    }
    cpHitSlotById.set(cp.id, first);
  }
  // Itinerary = walk the route in card-slot order (see orderedHitCheckpointIds); free = any reached checkpoint.
  const tracksBaseHitIds: Set<string> =
    tracksPlayMode === 'itinerary'
      ? orderedHitCheckpointIds(tracksRouteCps, cpHitSlotById).hitIds
      : (() => {
          const s = new Set<string>();
          for (const cp of tracksRouteCps) if (cpHitSlotById.get(cp.id) !== undefined) s.add(cp.id);
          return s;
        })();
  const detectCpStatus = (cp: TracksCheckpoint): CpStatus => {
    if (tracksBaseHitIds.has(cp.id)) return 'correct';
    if (cpHitSlotById.get(cp.id) !== undefined) return 'wrong'; // punched, not credited
    return 'missing';
  };
  const resolveCheckpointThumb = (cp: TracksCheckpoint): string => {
    const fn = gameData?.game_meta?.checkpoints_unique_image
      ? gameData?.game_meta?.checkpoints_unique_image_id
      : cp.image;
    if (!fn || fn === 'undefined' || fn === 'null') return '';
    return scenarioAssetUrl(gameUniqid, fn);
  };
  const checkpointRows = tracksRouteCps.map((cp, i) => {
    const base = detectCpStatus(cp);
    const override = cpOverrides[cp.id];
    const effective: CpStatus = override ?? base;
    return {
      id: cp.id,
      name: readLocalizedish(cp.title, tracksLang) || `#${i + 1}`,
      thumb: resolveCheckpointThumb(cp),
      points: typeof cp.points === 'number' ? cp.points : 1,
      base,
      effective,
      overridden: override !== undefined && override !== base,
    };
  });

  // Set of checkpoints credited under a given override map (effective 'correct').
  const tracksEffectiveHitIds = (overrides: Record<string, CpStatus>): Set<string> => {
    const s = new Set<string>();
    for (const cp of tracksRouteCps) {
      const eff = overrides[cp.id] ?? detectCpStatus(cp);
      if (eff === 'correct') s.add(cp.id);
    }
    return s;
  };
  // Full tracks score recompute: computeScore over the credited checkpoints with
  // the team's elapsed time + malus - the exact rule TracksGamePage applies.
  const recomputeTracksScore = (
    overrides: Record<string, CpStatus>,
    startT: number | null = currentTeam.start_time,
    endT: number | null = currentTeam.end_time,
  ): number => {
    const elapsedMinutes = startT != null && endT != null ? (endT - startT) / 60 : 0;
    return computeScore({
      routeCheckpoints: tracksRouteCps,
      hitCheckpointIds: tracksEffectiveHitIds(overrides),
      scoreType: tracksScoreType,
      elapsedMinutes,
      timeLimitMinutes: timeLimitMin,
      malusPerMinute,
    });
  };

  // Set (or clear, when status === detected) a checkpoint's override: persist the
  // map to launched-game meta, recompute + persist the team score, refresh the list.
  const setCheckpointStatus = async (cpId: string, status: CpStatus, base: CpStatus) => {
    if (mutating) return;
    const prev = cpOverrides;
    const next = { ...cpOverrides };
    if (status === base) delete next[cpId];
    else next[cpId] = status;
    setMutating(true);
    setCpOverrides(next); // optimistic
    try {
      const meta = await getLaunchedGameMeta(launchedGameId);
      let all: Record<string, Record<string, CpStatus>>;
      try {
        all = JSON.parse(meta.checkpoint_overrides || '{}');
        if (!all || typeof all !== 'object') all = {};
      } catch {
        all = {};
      }
      if (Object.keys(next).length === 0) delete all[String(team.id)];
      else all[String(team.id)] = next;
      await updateLaunchedGameMeta(launchedGameId, { ...meta, checkpoint_overrides: JSON.stringify(all) });
      const score = recomputeTracksScore(next);
      await updateTeam(team.id, { score });
      setCurrentTeam((tm) => ({ ...tm, score }));
      onTeamUpdated?.();
    } catch (err) {
      console.error('[TeamDetailsModal] setCheckpointStatus failed:', err);
      setCpOverrides(prev); // roll back
    } finally {
      setMutating(false);
    }
  };

  // Tracks header summary values.
  const tracksFoundCount = checkpointRows.filter((r) => r.effective === 'correct').length;
  const tracksScoreVal = recomputeTracksScore(cpOverrides);
  const tracksScoreText =
    tracksScoreType === 'percentage' ? `${Math.round(tracksScoreVal)}%` : `${Math.round(tracksScoreVal)} pts`;
  const tracksDurationText =
    currentTeam.start_time != null && currentTeam.end_time != null
      ? formatDuration(currentTeam.end_time - currentTeam.start_time)
      : '-';

  // Change this team's display language (operator override). Drives in-game text
  // for this team and the team's name-pool draw language.
  const handleLanguageChange = async (lang: string) => {
    setMutating(true);
    setCurrentTeam((t) => ({ ...t, language: lang })); // optimistic
    try {
      await updateTeam(team.id, { language: lang });
      onTeamUpdated?.();
    } catch (err) {
      console.error('[TeamDetailsModal] handleLanguageChange failed:', err);
      setCurrentTeam((t) => ({ ...t, language: currentTeam.language })); // roll back
    } finally {
      setMutating(false);
    }
  };

  // Mystery header summary values.
  const enigmaFoundCount = enigmaRows.filter((r) => r.effective === 'found').length;
  const mysteryEnigmaPoints = enigmaRows.reduce((s, r) => s + r.points, 0);
  const mysteryScore = mysteryEnigmaPoints - effectiveLateMalus;
  const mysteryScoreFull = toPoints(gameData?.game_meta?.score_full_game) || 100;
  const mysteryScoreText =
    gameData?.game_meta?.points_units === 'percentage'
      ? `${Math.round(mysteryScore)}%`
      : `${Math.round(mysteryScore)} / ${mysteryScoreFull}`;
  const mysteryLevel = computeLevel(mysteryScore, gameData?.game_meta?.levels ?? gameData?.levels);
  const mysteryDurationText =
    currentTeam.start_time != null && currentTeam.end_time != null
      ? formatDuration(currentTeam.end_time - currentTeam.start_time)
      : '-';

  return (
    <div className="pg-overlay">
      <div className="pg-modal max-w-2xl">
        {/* Header */}
        <div className="pg-modal-head">
          <div>
            <h2 className="pg-modal-title">{team.team_name}</h2>
            <p className="pg-modal-sub">{t('teamDetails:gameDetailsChip', { keyId: team.key_id })}</p>
          </div>
          <div className="flex items-center gap-3">
            {(languages?.length ?? 0) >= 2 && (
              <>
                <select
                  value={currentTeam.language ?? launchLanguage ?? 'en'}
                  disabled={mutating}
                  onChange={(e) => void handleLanguageChange(e.target.value)}
                  className="pg-select disabled:opacity-50"
                  style={{ height: 34 }}
                  title={t('teamDetails:teamDisplayLanguage')}
                >
                  {languages!.map((l) => (
                    <option key={l} value={l}>{LANG_NAMES[l] ?? l}</option>
                  ))}
                </select>
                <HelpDot topic="team.language" align="right" className="text-[var(--pg-text-dim)] hover:text-[var(--pg-text)]" />
              </>
            )}
            <button onClick={onClose} className="pg-modal-close">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Score summary */}
        <div className="px-6 py-4 border-b border-[var(--pg-line)] shrink-0">
          {isMystery ? (
            <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <Puzzle size={11} /> {t('teamDetails:summaryFound')}
                </div>
                <div className="pg-stat-value pg-stat-value--ok">
                  {enigmaFoundCount}
                  <span className="text-[var(--pg-text-dim)] text-sm font-medium">/{enigmaRows.length}</span>
                </div>
              </div>
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <Award size={11} /> {t('teamDetails:summaryScore')}
                </div>
                <div className="pg-stat-value pg-stat-value--accent">{mysteryScoreText}</div>
              </div>
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <Award size={11} /> {t('teamDetails:summaryLevel')}
                </div>
                {mysteryLevel ? (
                  <div className="mt-1 pg-badge pg-badge--warn">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                    {mysteryLevel.name}
                  </div>
                ) : (
                  <div className="pg-stat-value pg-stat-value--muted">-</div>
                )}
              </div>
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <Clock size={11} /> {t('teamDetails:summaryTime')}
                </div>
                <div className="pg-stat-value">{mysteryDurationText}</div>
              </div>
            </div>
            {/* Late malus - editable per-team override. Subtracted from the
                enigma points to form the score. */}
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <span className="pg-stat-label">
                <Clock size={11} /> {t('teamDetails:summaryLateMalus', { defaultValue: 'Late malus' })}
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-[var(--pg-text-dim)] text-sm">−</span>
                <input
                  type="number"
                  min={0}
                  disabled={mutating}
                  value={effectiveLateMalus}
                  onChange={(e) => setLateMalus(Math.max(0, parseInt(e.target.value) || 0))}
                  className="pg-input !w-24 !px-2 !py-1 text-sm disabled:opacity-50"
                />
                {lateMalusOverride != null && (
                  <button
                    onClick={() => setLateMalus(null)}
                    disabled={mutating}
                    className="p-1.5 rounded text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] hover:bg-[var(--pg-surface-3)] disabled:opacity-30 disabled:cursor-not-allowed transition"
                    title={t('teamDetails:lateMalusRevert', { defaultValue: 'Revert to auto-computed late malus', value: lateMalusAuto })}
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
                {lateMalusOverride != null && (
                  <span className="text-amber-400 text-[10px] font-medium inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                    {t('teamDetails:edited')}
                  </span>
                )}
              </div>
            </div>
            {/* Card not empty at the start bip: its punches are ignored unless
                the operator chooses to count them (player played before bipping in). */}
            {(staleCount > 0 || staleAllowed) && (
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                <span className="pg-stat-label">
                  <AlertTriangle size={11} /> {t('teamDetails:stalePunchesLabel', { count: staleCount })}
                </span>
                <button
                  onClick={() => setStaleAllowed(!staleAllowed)}
                  disabled={mutating}
                  className={`pg-btn pg-btn--sm ${staleAllowed ? 'pg-btn--ghost' : 'pg-btn--primary'} disabled:opacity-50`}
                  title={t('teamDetails:stalePunchesHint')}
                >
                  {staleAllowed ? t('teamDetails:stalePunchesIgnore') : t('teamDetails:stalePunchesCount')}
                </button>
                {staleAllowed && (
                  <span className="text-amber-400 text-[10px] font-medium inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                    {t('teamDetails:stalePunchesCounted')}
                  </span>
                )}
              </div>
            )}
            </>
          ) : isTracks ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <MapPin size={11} /> {t('teamDetails:summaryFound')}
                </div>
                <div className="pg-stat-value pg-stat-value--ok">
                  {tracksFoundCount}
                  <span className="text-[var(--pg-text-dim)] text-sm font-medium">/{checkpointRows.length}</span>
                </div>
              </div>
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <Award size={11} /> {t('teamDetails:summaryScore')}
                </div>
                <div className="pg-stat-value pg-stat-value--accent">{tracksScoreText}</div>
              </div>
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <Clock size={11} /> {t('teamDetails:summaryTime')}
                </div>
                <div className="pg-stat-value">{tracksDurationText}</div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <Target size={11} /> {t('teamDetails:summaryQuests')}
                </div>
                <div className="pg-stat-value">{completedQuests.length}</div>
              </div>
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <Award size={11} /> {t('teamDetails:summaryQuestPts')}
                </div>
                <div className="pg-stat-value pg-stat-value--accent">{totalQuestPoints}</div>
              </div>
              {hasComboConfig && (
                <div className="pg-stat">
                  <div className="pg-stat-label">
                    <Zap size={11} /> {t('teamDetails:summaryComboBonus')}
                  </div>
                  <div className="pg-stat-value pg-stat-value--warn">{comboTotal}</div>
                </div>
              )}
              {stationMalus > 0 && (
                <div className="pg-stat">
                  <div className="pg-stat-label">
                    <AlertTriangle size={11} /> {t('teamDetails:summaryStationMalus')}
                  </div>
                  <div className="pg-stat-value pg-stat-value--danger">-{stationMalus}</div>
                </div>
              )}
              <div className="pg-stat">
                <div className="pg-stat-label">
                  <Clock size={11} /> {t('teamDetails:summaryTotalScore')}
                </div>
                <div className="pg-stat-value pg-stat-value--ok">
                  {totalScore}
                  {effectifWeight != null && (
                    <span
                      title={t('launched:effectifWeightTitle')}
                      className="ml-1.5 align-middle text-xs font-semibold text-sky-400"
                    >
                      {t('launched:effectifWeightBadge', { count: effectifHeadcount ?? 1, weight: formatWeight(effectifWeight) })}
                    </span>
                  )}
                </div>
                {currentLevel && (
                  <div className="mt-1.5 pg-badge pg-badge--warn">
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
          <div className="px-6 py-3 border-b border-[var(--pg-line)] shrink-0 bg-amber-950/20">
            <p className="text-amber-400 text-xs font-medium mb-2 flex items-center gap-1.5">
              <Zap size={12} /> {t('teamDetails:comboBreakdown')}
            </p>
            <div className="flex flex-wrap gap-2">
              {combos.combos6 > 0 && (
                <span className="px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-amber-300 text-xs">
                  {t('teamDetails:comboPill6', { count: combos.combos6, points: combos.combos6 * pts6 })}
                </span>
              )}
              {combos.combos4 > 0 && (
                <span className="px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-amber-300 text-xs">
                  {t('teamDetails:comboPill4', { count: combos.combos4, points: combos.combos4 * pts4 })}
                </span>
              )}
              {combos.combos2 > 0 && (
                <span className="px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-amber-300 text-xs">
                  {t('teamDetails:comboPill2', { count: combos.combos2, points: combos.combos2 * pts2 })}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="pg-tabs">
          {isMystery ? (
            <button
              onClick={() => setActiveTab('enigmas')}
              className={`pg-tab${activeTab === 'enigmas' ? ' is-active' : ''}`}
            >
              <Puzzle size={14} />
              {t('teamDetails:tabEnigmas', { count: enigmaRows.length })}
            </button>
          ) : isTracks ? (
            <button
              onClick={() => setActiveTab('checkpoints')}
              className={`pg-tab${activeTab === 'checkpoints' ? ' is-active' : ''}`}
            >
              <MapPin size={14} />
              {t('teamDetails:tabCheckpoints', { count: checkpointRows.length, defaultValue: `Checkpoints (${checkpointRows.length})` })}
            </button>
          ) : (
            <>
              <button
                onClick={() => setActiveTab('quests')}
                className={`pg-tab${activeTab === 'quests' ? ' is-active' : ''}`}
              >
                <Target size={14} />
                {t('teamDetails:tabQuests', { count: completedQuests.length })}
              </button>
              <button
                onClick={() => setActiveTab('quest-count')}
                className={`pg-tab${activeTab === 'quest-count' ? ' is-active' : ''}`}
              >
                <BarChart2 size={14} />
                {t('teamDetails:tabQuestCount')}
              </button>
            </>
          )}
          <button
            onClick={() => setActiveTab('punches')}
            className={`pg-tab${activeTab === 'punches' ? ' is-active' : ''}`}
          >
            <List size={14} />
            {t('teamDetails:tabPunches', { count: rawDataRecords.length })}
          </button>
          <button
            onClick={() => setActiveTab('edit')}
            className={`pg-tab${activeTab === 'edit' ? ' is-active' : ''}`}
          >
            <Pencil size={14} />
            {t('teamDetails:tabEdit')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-[var(--pg-text-dim)] text-sm">
              {t('teamDetails:loading')}
            </div>
          ) : activeTab === 'enigmas' ? (
            <div className="p-4 space-y-2">
              {enigmaRows.length === 0 ? (
                <p className="text-[var(--pg-text-dim)] text-sm text-center py-8">
                  {t('teamDetails:noEnigmas')}
                </p>
              ) : (
                enigmaRows.map((row) => (
                  <div
                    key={row.enigmaId}
                    className="flex items-center gap-3 bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-lg p-2.5"
                  >
                    {/* Thumbnail */}
                    <div className="w-11 h-11 shrink-0 rounded-md bg-[var(--pg-bg)] border border-[var(--pg-line)] overflow-hidden flex items-center justify-center">
                      {row.thumb ? (
                        <img src={row.thumb} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageOff size={16} className="text-[var(--pg-text-dim)]" />
                      )}
                    </div>

                    {/* Name + points */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[var(--pg-text)] text-sm font-medium truncate">{row.name}</span>
                        {row.overridden && (
                          <span className="inline-flex items-center gap-1 shrink-0 text-amber-400 text-[10px] font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                            {t('teamDetails:edited')}
                          </span>
                        )}
                      </div>
                      <div className="text-[var(--pg-text-dim)] text-xs">
                        +{row.goodPts}
                        {row.wrongPts !== 0 && (
                          <span className="opacity-70"> / {row.wrongPts}</span>
                        )}
                        <span className="opacity-70"> {t('teamDetails:pts')}</span>
                      </div>
                    </div>

                    {/* Revert to detected */}
                    {row.overridden && (
                      <button
                        onClick={() => setEnigmaStatus(row.enigmaId, row.base, row.base)}
                        disabled={mutating}
                        className="p-1.5 rounded text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] hover:bg-[var(--pg-surface-3)] disabled:opacity-30 disabled:cursor-not-allowed transition shrink-0"
                        title={t('teamDetails:revertToDetected', { status: enigmaStatusLabel(row.base) })}
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}

                    {/* 4-way status pills */}
                    <div className="flex shrink-0 rounded-md overflow-hidden border border-[var(--pg-line-strong)]">
                      {ENIGMA_STATUS_ORDER.map((status) => {
                        const active = row.effective === status;
                        const meta = ENIGMA_STATUS_META[status];
                        return (
                          <button
                            key={status}
                            onClick={() => setEnigmaStatus(row.enigmaId, status, row.base)}
                            disabled={mutating}
                            className={`px-2 py-1.5 text-[11px] font-medium transition border-l border-[var(--pg-line-strong)] first:border-l-0 disabled:cursor-not-allowed ${
                              active
                                ? meta.activeClass
                                : 'bg-[var(--pg-surface)] text-[var(--pg-text-dim)] hover:bg-[var(--pg-surface-3)] hover:text-[var(--pg-text)] disabled:opacity-50'
                            }`}
                            title={enigmaStatusLabel(status)}
                          >
                            {enigmaStatusLabel(status)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : activeTab === 'checkpoints' ? (
            <div className="p-4 space-y-2">
              {checkpointRows.length === 0 ? (
                <p className="text-[var(--pg-text-dim)] text-sm text-center py-8">
                  {t('teamDetails:noCheckpoints', { defaultValue: 'No checkpoints' })}
                </p>
              ) : (
                checkpointRows.map((row, idx) => (
                  <div
                    key={row.id}
                    className="flex items-center gap-3 bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-lg p-2.5"
                  >
                    {/* Ordinal */}
                    <div className="w-6 text-center text-[var(--pg-text-dim)] text-xs font-mono shrink-0">
                      {idx + 1}
                    </div>

                    {/* Thumbnail */}
                    <div className="w-11 h-11 shrink-0 rounded-md bg-[var(--pg-bg)] border border-[var(--pg-line)] overflow-hidden flex items-center justify-center">
                      {row.thumb ? (
                        <img src={row.thumb} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageOff size={16} className="text-[var(--pg-text-dim)]" />
                      )}
                    </div>

                    {/* Name + points */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[var(--pg-text)] text-sm font-medium truncate">{row.name}</span>
                        {row.overridden && (
                          <span className="inline-flex items-center gap-1 shrink-0 text-amber-400 text-[10px] font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                            {t('teamDetails:edited')}
                          </span>
                        )}
                      </div>
                      {tracksScoreType === 'points' && (
                        <div className="text-[var(--pg-text-dim)] text-xs">
                          +{row.points}
                          <span className="opacity-70"> {t('teamDetails:pts')}</span>
                        </div>
                      )}
                    </div>

                    {/* Revert to detected */}
                    {row.overridden && (
                      <button
                        onClick={() => setCheckpointStatus(row.id, row.base, row.base)}
                        disabled={mutating}
                        className="p-1.5 rounded text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] hover:bg-[var(--pg-surface-3)] disabled:opacity-30 disabled:cursor-not-allowed transition shrink-0"
                        title={t('teamDetails:revertToDetected', { status: cpStatusLabel(row.base) })}
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}

                    {/* 3-way status pills */}
                    <div className="flex shrink-0 rounded-md overflow-hidden border border-[var(--pg-line-strong)]">
                      {CP_STATUS_ORDER.map((status) => {
                        const active = row.effective === status;
                        const meta = CP_STATUS_META[status];
                        return (
                          <button
                            key={status}
                            onClick={() => setCheckpointStatus(row.id, status, row.base)}
                            disabled={mutating}
                            className={`px-2 py-1.5 text-[11px] font-medium transition border-l border-[var(--pg-line-strong)] first:border-l-0 disabled:cursor-not-allowed ${
                              active
                                ? meta.activeClass
                                : 'bg-[var(--pg-surface)] text-[var(--pg-text-dim)] hover:bg-[var(--pg-surface-3)] hover:text-[var(--pg-text)] disabled:opacity-50'
                            }`}
                            title={cpStatusLabel(status)}
                          >
                            {cpStatusLabel(status)}
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
                <p className="text-[var(--pg-text-dim)] text-sm text-center py-8">{t('teamDetails:noQuestsCompleted')}</p>
              ) : (
                <table className="pg-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('teamDetails:colQuest')}</th>
                      <th className="!text-right">{t('teamDetails:colPoints')}</th>
                      <th className="!text-right">{t('teamDetails:colTime')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {questsNewestFirst.map((cq, i) => (
                      <tr key={cq.id}>
                        <td className="text-[var(--pg-text-dim)]">{i + 1}</td>
                        <td className="text-[var(--pg-text)] font-medium">
                          <div>{getQuestName(cq.quest_number)}</div>
                          <div className="text-[var(--pg-text-dim)] text-xs font-normal">
                            {chipHolderLabel(cq.teammate_chip_id)}
                          </div>
                        </td>
                        <td className="text-right">
                          <span className="text-[var(--pg-accent-bright)] font-semibold">+{cq.points_awarded}</span>
                        </td>
                        <td className="text-right text-[var(--pg-text-dim)] text-xs">
                          {cq.completed_at ? formatCreatedAt(cq.completed_at) : '-'}
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
                <p className="text-[var(--pg-text-dim)] text-sm text-center py-8">{t('teamDetails:noQuestData')}</p>
              ) : (
                <table className="pg-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('teamDetails:colQuest')}</th>
                      <th className="!text-right">{t('teamDetails:colPts')}</th>
                      <th className="!text-right">{t('teamDetails:colCompletions')}</th>
                      <th className="!text-right w-28">{t('teamDetails:colAdjust')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {questCountRows.map((row) => (
                      <tr key={row.questNumber}>
                        <td className="text-[var(--pg-text-dim)] text-xs">{row.questNumber}</td>
                        <td className="text-[var(--pg-text)]">{row.name}</td>
                        <td className="text-right">
                          {row.points > 0
                            ? <span className="text-amber-400 text-xs font-medium">{row.points}</span>
                            : <span className="text-[var(--pg-text-dim)] text-xs">-</span>
                          }
                        </td>
                        <td className="text-right">
                          <span className={row.count > 0 ? 'text-[var(--pg-accent-bright)] font-semibold' : 'text-[var(--pg-text-dim)]'}>
                            {row.count}
                          </span>
                        </td>
                        <td className="text-right w-28">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => adjustQuest(row.questNumber, -1)}
                              disabled={mutating || row.count === 0}
                              className="p-1 rounded bg-[var(--pg-surface-3)] hover:bg-red-600/70 text-[var(--pg-text)] disabled:opacity-30 disabled:cursor-not-allowed transition"
                              title={t('teamDetails:removeOneCompletion')}
                            >
                              <Minus size={14} />
                            </button>
                            <button
                              onClick={() => adjustQuest(row.questNumber, 1)}
                              disabled={mutating}
                              className="p-1 rounded bg-[var(--pg-surface-3)] hover:bg-green-600/70 text-[var(--pg-text)] disabled:opacity-30 disabled:cursor-not-allowed transition"
                              title={t('teamDetails:addOneCompletion')}
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
                <p className="text-[var(--pg-text-dim)] text-sm text-center py-8">{t('teamDetails:noPunchRecords')}</p>
              ) : (
                rawDataRecords.map((rec, i) => {
                  const isExpanded = expandedPunch === rec.id;
                  const punches = rec.raw_data?.punches ?? [];
                  return (
                    <div key={rec.id} className="bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-lg overflow-hidden">
                      <button
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--pg-surface-3)] transition text-left"
                        onClick={() => setExpandedPunch(isExpanded ? null : rec.id)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[var(--pg-text-dim)] text-xs shrink-0">#{i + 1}</span>
                          <span className="text-[var(--pg-text)] text-sm font-medium truncate">
                            {chipHolderLabel(rec.raw_data?.id)}
                          </span>
                          <span className="text-[var(--pg-text-dim)] text-sm shrink-0">
                            - {t('teamDetails:stationCount', { count: punches.length })}
                          </span>
                          {rec.raw_data?.end != null && (
                            <span className="px-1.5 py-0.5 bg-green-900/50 border border-green-700/50 rounded text-green-400 text-xs shrink-0">
                              {t('teamDetails:endStation')}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-[var(--pg-text-dim)] text-xs">{formatCreatedAt(rec.created_at)}</span>
                          {isExpanded ? (
                            <ChevronUp size={14} className="text-[var(--pg-text-dim)]" />
                          ) : (
                            <ChevronDown size={14} className="text-[var(--pg-text-dim)]" />
                          )}
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="border-t border-[var(--pg-line)] px-4 py-3">
                          <table className="pg-table !text-xs">
                            <thead>
                              <tr>
                                <th>{t('teamDetails:colStationCode')}</th>
                                <th className="!text-right">{t('teamDetails:colPunchTime')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {punches.map((p, j) => (
                                <tr key={j}>
                                  <td className="text-[var(--pg-text)] font-mono">{p.code}</td>
                                  <td className="text-right text-[var(--pg-text-dim)]">
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
          ) : activeTab === 'edit' ? (
            <div className="p-4 space-y-3">
              <div>
                <label className="pg-label">{t('teamDetails:editTeamName')}</label>
                <input
                  type="text"
                  value={editForm.team_name || ''}
                  onChange={(e) => setEditForm({ ...editForm, team_name: e.target.value })}
                  className="pg-input"
                />
              </div>
              <div>
                <label className="pg-label">{t('teamDetails:editStartTime')}</label>
                <input
                  type="time"
                  step="1"
                  value={formatTimeForInput(editForm.start_time)}
                  onChange={(e) => setEditForm({ ...editForm, start_time: parseTimeInput(e.target.value) })}
                  className="pg-input"
                />
              </div>
              <div>
                <label className="pg-label">{t('teamDetails:editEndTime')}</label>
                <input
                  type="time"
                  step="1"
                  value={formatTimeForInput(editForm.end_time)}
                  onChange={(e) => setEditForm({ ...editForm, end_time: parseTimeInput(e.target.value) })}
                  className="pg-input"
                />
              </div>
              <div className="pt-1">
                <button
                  onClick={() => void handleSaveEdit()}
                  disabled={savingEdit}
                  className="w-full px-3 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded text-sm font-medium flex items-center justify-center gap-2"
                  title={t('teamDetails:editSaveChanges')}
                >
                  <Save size={14} />
                  {savingEdit ? t('teamDetails:editSaving') : t('teamDetails:editSave')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
