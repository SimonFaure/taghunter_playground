import * as patternStore from './patternStore';
import * as scenarioStore from './scenarioStore';
import {
  getLaunchedGameState,
  getLaunchedGameMeta,
  getRawDataForChip,
  listCompletedQuests,
  recordCompletedQuest,
  updateTeam,
} from './launchedGames';
import { CardData, SI_CARD_CAPACITY } from './sportidentService';
import {
  MALUS_QUEST_NUMBER,
  computeCombos,
  effectifWeights,
  isWeightingEnabled,
  partitionMalusRows,
  teamHeadcounts,
  weightedScore,
} from './tagquestScoring';
import type { Team } from '../components/LaunchGameModal';

interface GameQuest {
  name: string;
  points?: string | number;
  main_image?: string;
  image_1?: string;
  image_2?: string;
  image_3?: string;
  image_4?: string;
  sound?: string;
  [key: string]: string | number | undefined;
}

interface GameMeta {
  late_malus_points?: string | number;
  // Legacy scenario key for the same value (see launchResolve.ts).
  default_time_malus?: string | number;
  default_time?: string | number;
  levels?: Record<string, { points: string | null; name: string | null; description: string }>;
  combo_6_quests?: string | number;
  combo_4_quests?: string | number;
  combo_2_quests?: string | number;
  // Trap station: every punch on it costs `malus_points`. Authored in the
  // studio tagquest editor (Malus & combo section) as an `si_balises.id`, the
  // same space as pattern `station_key_number` and the SI punch `code`, so no
  // resolution step is needed here. The editor guarantees it is never one of
  // the pattern's quest stations.
  malus_points?: string | number;
  malus_station?: string | number | null;
}

interface GameDataJson {
  game_meta?: GameMeta;
  quests?: GameQuest[];
}

interface PatternItem {
  item_index: number;
  assignment_type: string;
  station_key_number: number;
}

export interface QuestImageSlot {
  key: string;
  src: string;
  matched: boolean;
}

export interface DisplayQuest {
  index: number;
  name: string;
  points: number;
  main_image: string;
  slots: QuestImageSlot[];
  complete: boolean;
  timesCompleted: number;
  totalPointsForQuest: number;
}

export interface PunchAnimationData {
  teamName: string;
  prevScore: number;
  prevCombos: { combos6: number; combos4: number; combos2: number };
  prevQuestDetails: Array<{ questIndex: number; name: string; timesCompleted: number; totalPoints: number }>;
  prevMalus: number;
  prevLateMalus: number;
  comboPoints: { pts6: number; pts4: number; pts2: number };
  displayQuest: DisplayQuest | null;
  newScore: number;
  newCombos: { combos6: number; combos4: number; combos2: number };
  newQuestDetails: Array<{ questIndex: number; name: string; timesCompleted: number; totalPoints: number }>;
  newMalus: number;
  newLateMalus: number;
  gameOver?: boolean;
  endTimeToCommit?: number;
  teamId?: number;
}

/** A punch present on the card that this read deliberately did not count. */
export interface DroppedPunch {
  code: number;
  time: string;
  /**
   * `baseline` - it was already on the card when the chip was first seen this
   * game (the player didn't wipe it). `consumed` - it already paid for a quest
   * or a malus hit. Both are clock-free verdicts: nothing here compares the
   * kiosk's clock to a station's.
   */
  reason: 'baseline' | 'consumed';
}

interface PunchResult {
  team_name: string;
  team_id: number;
  teammate_chip_id: number | null;
  completed_quest: { index: number; name: string; points: number } | null;
  points_earned: number;
  combo_bonus: number;
  /** Late (time-based) malus newly charged by this read. */
  malus_applied: number;
  /** Points charged by this read for punches on the scenario's malus station. */
  station_malus_applied: number;
  /** How many punches on the malus station this read consumed. */
  malus_station_hits: number;
  new_total_score: number;
  level_up: { new_level: number; name: string } | null;
  best_partial_quest: { index: number; name: string; matched: number } | null;
  end_station_reached: boolean;
  game_ended: boolean;
  status:
    | 'ok'
    | 'chip_not_recognized'
    | 'card_empty'
    | 'team_already_finished'
    | 'cheat_detected'
    | 'no_station_match'
    | 'punches_already_counted'
    | 'punches_not_wiped'
    | 'error';
  message?: string;
  animationData?: PunchAnimationData;
  /**
   * Punches on the card this read ignored, and why. Populated on every read
   * that drops something - not only when the drops empty the card - so the
   * operator can tell "already counted" apart from "never punched" instead of
   * staring at a slot that just says false. See `DroppedPunch`.
   */
  dropped_punches?: DroppedPunch[];
  /**
   * The card is at its hardware punch capacity, so stations can write no more
   * to it. Advisory only: the read still scores. Chaining several scenarios on
   * one chip without wiping is what fills a card (client report #101).
   */
  card_full?: boolean;
}

// ── Registration baseline ──────────────────────────────────────────────────
// A player who forgot to wipe their card arrives carrying a previous game's
// punches. Tracks and Mystery solve this by snapshotting what is already on the
// card at the team's start bip and subtracting it later (see TracksGamePage's
// `baseline:{teamId}`); TagQuest's self-register registration bip is the same
// opportunity, and unlike the time-of-day test it needs no clock agreement at
// all. Keyed per CHIP because a TagQuest team can hold several chips.
//
// Stored one meta key per chip so registration stations can write theirs
// concurrently (patchLaunchedGameMeta - a whole-map write would drop keys).
export const TQ_BASELINE_META_PREFIX = 'tqbase:';

export function baselineMetaKey(chipId: number): string {
  return `${TQ_BASELINE_META_PREFIX}${chipId}`;
}

/**
 * The punches worth remembering from a card presented at registration, as
 * `code@time` ids. `00:00:00` is the empty-slot placeholder, not a real punch.
 * Returns [] for a properly wiped card - the caller then writes nothing.
 */
export function baselineIdsFromCard(card: CardData): string[] {
  return (card.punches ?? [])
    .filter((p) => p.time && p.time !== '00:00:00')
    .map((p) => `${p.code}@${p.time}`);
}

/** Rebuild the chip → baseline map from a launched game's meta KV map. */
export function parseBaselineMeta(meta: Record<string, string>): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const [key, raw] of Object.entries(meta)) {
    if (!key.startsWith(TQ_BASELINE_META_PREFIX)) continue;
    const chipId = parseInt(key.slice(TQ_BASELINE_META_PREFIX.length), 10);
    if (!Number.isFinite(chipId)) continue;
    try {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) out.set(chipId, new Set(ids.map(String)));
    } catch {
      console.warn('[TagQuest] unreadable baseline meta for key', key);
    }
  }
  return out;
}

/**
 * The card holds as many punches as its family allows, so stations can write no
 * more to it. `cardType` is absent on synthetic cards (the test simulator), in
 * which case we can't tell and say no.
 */
export function isCardFull(card: CardData): boolean {
  const capacity = SI_CARD_CAPACITY[card.cardType];
  return capacity != null && card.punches.length >= capacity;
}

function getQuests(gdj: GameDataJson): GameQuest[] {
  return gdj?.quests || [];
}

function getLateMalusPoints(gdj: GameDataJson): number {
  const val = gdj?.game_meta?.late_malus_points ?? gdj?.game_meta?.default_time_malus ?? 0;
  return typeof val === 'string' ? parseFloat(val) || 0 : val;
}

function getMalusPoints(gdj: GameDataJson): number {
  const val = gdj?.game_meta?.malus_points ?? 0;
  const n = typeof val === 'string' ? parseFloat(val) || 0 : val;
  // Authors type a positive penalty; be tolerant of a signed value.
  return Math.abs(n);
}

/** The malus station's code (as a string, to compare with punch codes), or null. */
function getMalusStationCode(gdj: GameDataJson): string | null {
  const raw = gdj?.game_meta?.malus_station;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}

function getComboPoints(gdj: GameDataJson): { pts6: number; pts4: number; pts2: number } {
  const parse = (val: string | number | undefined): number => {
    if (val === undefined || val === null) return 0;
    return typeof val === 'string' ? parseInt(val, 10) || 0 : val;
  };
  return {
    pts6: parse(gdj?.game_meta?.combo_6_quests),
    pts4: parse(gdj?.game_meta?.combo_4_quests),
    pts2: parse(gdj?.game_meta?.combo_2_quests),
  };
}

// SI punch times arrive as local "HH:MM:SS" time-of-day strings (see the Rust
// `Punch::time_hms`). Convert one to seconds-since-local-midnight, or null when
// it isn't a parseable HH:MM:SS (e.g. a numeric legacy value).
function punchSecondsOfDay(time: string | number): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(time).trim());
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

// ── Why there is no time-of-day staleness test here ───────────────────────
// There used to be one: `isPreStartPunch` dropped any punch whose time-of-day
// sat more than a grace window before the team's start. It compared the KIOSK
// PC's clock against the SI STATION's RTC - two clocks the app can neither read
// nor set (`si_set_station_time` is still a stub) - so any station whose clock
// had drifted had its punches silently deleted. That is client report 2.2/78
// (every station off => the whole card refused) and 2.2/101 (one station off =>
// that station "ressortait systématiquement en faux", invisibly, for a whole
// morning of testing).
//
// The job it was doing - don't score a card the player forgot to wipe - is done
// properly by the registration baseline below, which compares punch identities
// against a snapshot taken from the same card and never looks at a clock. So
// the test is gone rather than tuned. Punch times are still read, but only as
// *labels* (the "code@time" identity) and for ordering within one card; no
// station clock is ever compared to another clock again.

// Collapse double-bips: drop a punch at the same station within `windowMs` of a
// kept one. Ordered and compared on real time-of-day seconds - a previous
// version parsed "HH:MM:SS" with parseFloat (reading only the hour), which
// silently merged every same-station punch within the same hour and so blocked
// legitimate score-mode re-punches.
function deduplicatePunches(
  punches: CardData['punches'],
  windowMs = 20000
): CardData['punches'] {
  const ms = (t: string | number): number => (punchSecondsOfDay(t) ?? 0) * 1000;
  const sorted = [...punches].sort((a, b) => ms(a.time) - ms(b.time));

  const result: CardData['punches'] = [];
  for (const punch of sorted) {
    const last = result.findLast(p => p.code === punch.code);
    if (!last) {
      result.push(punch);
      continue;
    }
    const diff = Math.abs(ms(punch.time) - ms(last.time));
    if (diff >= windowMs) {
      result.push(punch);
    }
  }
  return result;
}

function isCheatDetected(
  currentPunches: CardData['punches'],
  previousPunches: CardData['punches']
): boolean {
  if (previousPunches.length === 0 || currentPunches.length === 0) return false;

  const previousPunchKeys = new Set(previousPunches.map(p => `${p.code}:${p.time}`));
  const newPunches = currentPunches.filter(p => !previousPunchKeys.has(`${p.code}:${p.time}`));

  return newPunches.length === 0;
}

async function loadPatternItemsFromFile(
  _gameType: string,
  patternUniqid: string
): Promise<PatternItem[]> {
  if (!patternUniqid) return [];
  try {
    // Route through patternStore.getRouting so the studio's nested
    // `[{index, assignments:{image_1:station,...}}]` pattern shape is flattened
    // into the `{item_index, assignment_type, station_key_number}` rows this
    // scorer filters on - the same adapter Mystery (getMysteryEnigmas) and
    // Tracks (getTracksCheckpointStations) use. Reading getData() raw here cast
    // the nested objects straight to PatternItem[], leaving every item_index /
    // station_key_number undefined, so no quest ever matched a punch and the
    // score never moved.
    return await patternStore.getRouting(patternUniqid);
  } catch (err) {
    console.error('[TagQuest] Error loading pattern items from local store:', err);
    return [];
  }
}

function computeLevel(
  score: number,
  levels: GameMeta['levels']
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

export async function processTagQuestPunch(
  card: CardData,
  launchedGameId: number,
  gameUniqid: string,
  playMode: 'solo' | 'team',
  teamsConfig: Team[],
  resolveMedia: (key: string) => string = () => '',
  // In-memory, per-team set of punch identities ("code@time") already consumed
  // by a completed quest. Anti-cheat: a physical punch may only ever be counted
  // once, so re-presenting a card (or a state-poll echo) can't re-score it, and
  // in score mode a quest only re-completes when its stations are genuinely
  // re-punched (new times). Owned by the game page (see TagQuestGamePage) so it
  // persists across reads of the same game; it resets if the kiosk reloads.
  consumedByTeam: Map<number, Set<string>> = new Map(),
  // Self-register (team mode): chip_id → team_id bindings from lg_clash_members
  // (Clash-style). Resolves a bipped chip to the team it joined at registration,
  // since self-register teams have no leader key_id and no teamsConfig roster.
  // Empty for predetermined rosters and solo self-register.
  memberTeamByChip: Map<number, number> = new Map(),
  // chip_id → the "code@time" punches already on that card when it registered
  // (meta `tqbase:{chipId}`, written at the registration bip). A card the player
  // forgot to wipe is caught here without comparing clocks at all - the same
  // trick Tracks and Mystery use. Only self-register games have a registration
  // bip to snapshot at; empty for predetermined rosters.
  baselineByChip: Map<number, Set<string>> = new Map(),
): Promise<PunchResult> {
  const errorResult = (message: string): PunchResult => ({
    team_name: '',
    team_id: 0,
    teammate_chip_id: null,
    completed_quest: null,
    points_earned: 0,
    combo_bonus: 0,
    malus_applied: 0,
    station_malus_applied: 0,
    malus_station_hits: 0,
    new_total_score: 0,
    level_up: null,
    best_partial_quest: null,
    end_station_reached: false,
    game_ended: false,
    status: 'error',
    message,
  });

  try {
    // Step 1: Resolve team from chip ID via the single combined `state` call.
    // We snapshot once here and reuse for everything below; this also lets us
    // pull game_type / start_time / duration without extra round-trips.
    const state = await getLaunchedGameState(launchedGameId, 0);
    const teamsInGame = state.teams;
    const directTeam = teamsInGame.find((t) => t.key_id === card.id) ?? null;

    let resolvedTeamId: number | null = null;
    let teammateChipId: number | null = null;

    if (directTeam) {
      resolvedTeamId = directTeam.id;
    } else if (memberTeamByChip.has(card.id)) {
      // Self-register (team mode): the chip was bound to a team at registration.
      const boundTeamId = memberTeamByChip.get(card.id)!;
      const boundTeam = teamsInGame.find((tm) => tm.id === boundTeamId) ?? null;
      if (boundTeam) {
        resolvedTeamId = boundTeam.id;
        teammateChipId = card.id;
      }
    } else if (playMode === 'team') {
      for (const t of teamsConfig) {
        const match = t.teammates?.find((mate) => mate.chipId === card.id);
        if (match) {
          const parentTeam = teamsInGame.find((tm) => tm.key_id === t.chipId) ?? null;
          if (parentTeam) {
            resolvedTeamId = parentTeam.id;
            teammateChipId = card.id;
          }
          break;
        }
      }
    }

    // Resolve the team record up-front (may be null for an unknown chip) so the
    // checks below can attribute messages to a team when one is known.
    const team = resolvedTeamId !== null
      ? teamsInGame.find((t) => t.id === resolvedTeamId) ?? null
      : null;
    const teamName = team?.team_name ?? '';

    // Card empty takes priority: an empty card (erased/blank, no punches) on bip
    // must always surface the "card empty" message - even when the chip isn't
    // tied to a team - so the player is told to go punch some stations.
    if (card.punches.length === 0) {
      console.log('[TagQuest] Card empty for chip:', card.id, 'team:', teamName || '(none)');
      return {
        team_name: teamName,
        team_id: team?.id ?? 0,
        teammate_chip_id: teammateChipId,
        completed_quest: null,
        points_earned: 0,
        combo_bonus: 0,
        malus_applied: 0,
        station_malus_applied: 0,
        malus_station_hits: 0,
        new_total_score: team?.score ?? 0,
        level_up: null,
        best_partial_quest: null,
        end_station_reached: false,
        game_ended: false,
        status: 'card_empty',
        message: `Card ${card.id} is empty (no punches)`,
      };
    }

    if (resolvedTeamId === null || !team) {
      console.log('[TagQuest] Chip not recognized:', card.id);
      return {
        team_name: '',
        team_id: 0,
        teammate_chip_id: null,
        completed_quest: null,
        points_earned: 0,
        combo_bonus: 0,
        malus_applied: 0,
        station_malus_applied: 0,
        malus_station_hits: 0,
        new_total_score: 0,
        level_up: null,
        best_partial_quest: null,
        end_station_reached: false,
        game_ended: false,
        status: 'chip_not_recognized',
        message: `Chip ${card.id} not recognized in game ${launchedGameId}`,
      };
    }

    // Step 2: Check if team already finished
    if (team.end_time) {
      console.log('[TagQuest] Team already finished:', teamName);
      return {
        team_name: teamName,
        team_id: team.id,
        teammate_chip_id: teammateChipId,
        completed_quest: null,
        points_earned: 0,
        combo_bonus: 0,
        malus_applied: 0,
        station_malus_applied: 0,
        malus_station_hits: 0,
        new_total_score: team.score,
        level_up: null,
        best_partial_quest: null,
        end_station_reached: false,
        game_ended: true,
        status: 'team_already_finished',
        message: `${teamName} has already completed the game`,
      };
    }

    // Step 3: Cheat detection using previous raw data for the same chip
    const previousRecords = await getRawDataForChip(launchedGameId, card.id, 2);
    if (previousRecords.length >= 2) {
      const previousCard = previousRecords[1].raw_data as CardData;
      if (isCheatDetected(card.punches, previousCard.punches)) {
        console.log('[TagQuest] Cheat detected for chip:', card.id, 'team:', teamName);
        return {
          team_name: teamName,
          team_id: team.id,
          teammate_chip_id: teammateChipId,
          completed_quest: null,
          points_earned: 0,
          combo_bonus: 0,
          malus_applied: 0,
        station_malus_applied: 0,
        malus_station_hits: 0,
          new_total_score: team.score,
          level_up: null,
          best_partial_quest: null,
          end_station_reached: false,
          game_ended: false,
          status: 'cheat_detected',
          message: `Cheat detected for ${teamName} (chip ${card.id})`,
        };
      }
    }

    // Step 4: Load pattern items from the local pattern store
    const metaMap = await getLaunchedGameMeta(launchedGameId);
    const patternUniqid = metaMap.pattern || '';
    const gameType = (state.game_type || 'mystery').toLowerCase();
    const patternItems: PatternItem[] = await loadPatternItemsFromFile(gameType, patternUniqid);

    // Step 5: Load game data for quest definitions from the local scenario store.
    let gameDataJson: GameDataJson | null = null;
    try {
      const raw = (await scenarioStore.getGameData(gameUniqid)) as { game_data?: GameDataJson } | GameDataJson | null;
      if (raw) {
        gameDataJson = (raw as { game_data?: GameDataJson }).game_data ?? (raw as GameDataJson);
      }
    } catch (err) {
      console.warn('[TagQuest] Error fetching game-data.json from local store:', err);
    }

    const quests = gameDataJson ? getQuests(gameDataJson) : [];
    const lateMalusPoints = gameDataJson ? getLateMalusPoints(gameDataJson) : 0;
    const malusPoints = gameDataJson ? getMalusPoints(gameDataJson) : 0;
    const malusStationCode = gameDataJson ? getMalusStationCode(gameDataJson) : null;
    const { pts6, pts4, pts2 } = gameDataJson ? getComboPoints(gameDataJson) : { pts6: 0, pts4: 0, pts2: 0 };
    const levels = gameDataJson?.game_meta?.levels;

    const victoryType = (metaMap.victoryType || 'speed').toLowerCase();
    const isScoreMode = victoryType === 'score';

    // Effectif weighting (launch option, score+team mode only): this team's
    // earned points get multiplied by largest-headcount ÷ own-headcount so
    // uneven team sizes compete fairly. Headcount is the LIVE chip count -
    // self-register bindings when present, else the pre-built roster - so a
    // mid-game join re-scales the team's points on its next punch. The late
    // malus stays unweighted. See tagquestScoring.ts for the full contract.
    let weight = 1;
    if (isWeightingEnabled(metaMap)) {
      const membersByTeam = new Map<number, number>();
      for (const tid of memberTeamByChip.values()) {
        membersByTeam.set(tid, (membersByTeam.get(tid) ?? 0) + 1);
      }
      const headcounts = teamHeadcounts(teamsInGame, teamsConfig, membersByTeam);
      weight = effectifWeights(headcounts).get(team.id) ?? 1;
    }

    // Step 6: Load already-scored quests for this team
    // quest_number stores the 1-based item_index (= array index + 1); rows
    // carrying MALUS_QUEST_NUMBER are malus-station hits, not quests, and are
    // split out here so they never count towards completions or combos.
    const completedRowsBefore = await listCompletedQuests(launchedGameId, team.id);
    const { questRows: completedQuests, stationMalus: prevStationMalus } =
      partitionMalusRows(completedRowsBefore);
    const completedQuestNumbers = new Set(completedQuests.map((r) => Number(r.quest_number)));

    // Step 7: Build the working set - every card punch MINUS the ones we must
    // not count. Two filters, both keyed on a punch's stable "code@time"
    // identity (a re-read returns the same time; a fresh physical punch gets a
    // new one), and both clock-free - see the note above `deduplicatePunches`
    // for why the old time-of-day filter is gone:
    //   (a) baseline - punches already on the card the first time this chip was
    //       seen in this game. Catches a card the player forgot to wipe by
    //       comparing the card against a snapshot of itself.
    //   (b) consumed - punches already used to complete a quest (or pay a malus)
    //       this game. Replaces the old speed-only "strip completed quests by
    //       station" pass and works in score mode too, so re-presenting a card
    //       never re-scores and a quest only re-completes on genuinely new
    //       punches.
    const teamConsumed = consumedByTeam.get(team.id) ?? new Set<string>();
    consumedByTeam.set(team.id, teamConsumed);
    const punchId = (p: { code: number; time: string }) => `${p.code}@${p.time}`;

    const chipBaseline = baselineByChip.get(card.id);

    const droppedPunches: DroppedPunch[] = [];
    let workingPunches = card.punches.filter((p) => {
      const id = punchId(p);
      if (chipBaseline?.has(id)) {
        droppedPunches.push({ code: p.code, time: p.time, reason: 'baseline' });
        return false;
      }
      if (teamConsumed.has(id)) {
        droppedPunches.push({ code: p.code, time: p.time, reason: 'consumed' });
        return false;
      }
      return true;
    });
    const baselineCount = droppedPunches.filter((d) => d.reason === 'baseline').length;
    const consumedCount = droppedPunches.length - baselineCount;

    // Warn on ANY drop, not just a total wipe. A partial drop used to be
    // completely silent, which is what let report 2.2/101 run for a morning: the
    // slot for the dropped station simply rendered false and nobody could see
    // why. The station codes here are `si_balises.id` values, the same space the
    // pattern uses - not the "balise 23" label an operator reads off the box.
    if (droppedPunches.length > 0) {
      console.warn('[TagQuest] Punches ignored on this read:', JSON.stringify({
        chip: card.id,
        team: teamName,
        kept: workingPunches.length,
        dropped: droppedPunches,
      }));
    }

    // The card is physically full, so stations can no longer write to it and
    // the player's next punches will vanish with only a station beep to show
    // for it. Advisory - we still score what IS on the card.
    const cardFull = isCardFull(card);
    if (cardFull) {
      console.warn(
        `[TagQuest] Chip ${card.id} (${card.cardType}) is FULL at ${card.punches.length} punch(es) - ` +
          'stations cannot record any more on it. It must be wiped.',
      );
    }

    // Every punch on the card was filtered out - nothing left to score. Without
    // this guard the read fell through to a silent no-op "ok" (no quest, no
    // partial, unchanged score), which the operator sees as "the bip did
    // nothing". Reaching here now means exactly one of two things, and the
    // status says which: the punches were already counted this game, or they
    // were already on the card when the chip was first seen. Skipped on a finish
    // bip (card.end) so the end-station flow below still runs.
    if (workingPunches.length === 0 && card.end == null) {
      return {
        team_name: teamName,
        team_id: team.id,
        teammate_chip_id: teammateChipId,
        completed_quest: null,
        points_earned: 0,
        combo_bonus: 0,
        malus_applied: 0,
        station_malus_applied: 0,
        malus_station_hits: 0,
        new_total_score: team.score,
        level_up: null,
        best_partial_quest: null,
        end_station_reached: false,
        game_ended: false,
        // "Already counted" wins the tie: it is the common case (the player
        // bipped twice) and the more actionable thing to tell them.
        status: consumedCount > 0 ? 'punches_already_counted' : 'punches_not_wiped',
        message: `All ${card.punches.length} punch(es) on chip ${card.id} were ignored (${baselineCount} already on the card when it was first seen, ${consumedCount} already counted)`,
        dropped_punches: droppedPunches,
        card_full: cardFull,
      };
    }

    // Step 8: Deduplicate punches (collapse same-station double-bips)
    workingPunches = deduplicatePunches(workingPunches);

    // Step 8b: Malus-station hits. Every fresh punch on the scenario's
    // `malus_station` costs `malus_points`, once per physical punch - the
    // punches are consumed below exactly like quest punches, so a re-read (or
    // a state-poll echo) can never re-charge, and a second visit to the trap
    // costs again. The studio editor forbids the malus station from also being
    // a pattern station, so these punches never compete with a quest slot.
    const malusHitPunches =
      malusStationCode !== null && malusPoints > 0
        ? workingPunches.filter((p) => String(p.code) === malusStationCode)
        : [];

    // Step 9: Quest completion analysis
    // item_index is 1-based; quest array index is 0-based (item_index - 1)
    const workingCodes = new Set(workingPunches.map(p => String(p.code)));

    interface QuestProgress {
      questIndex: number;
      quest: GameQuest;
      totalSlots: number;
      matchedSlots: number;
    }
    const questProgress = new Map<number, QuestProgress>();

    quests.forEach((quest, arrayIndex) => {
      const itemIndex = arrayIndex + 1;
      // In speed mode, skip quests already completed. In score mode, allow re-completion.
      if (!isScoreMode && completedQuestNumbers.has(itemIndex)) return;

      const questSlots = patternItems.filter(pi => pi.item_index === itemIndex);
      if (questSlots.length === 0) return;

      const matched = questSlots.filter(pi => workingCodes.has(String(pi.station_key_number))).length;
      questProgress.set(itemIndex, {
        questIndex: arrayIndex,
        quest,
        totalSlots: questSlots.length,
        matchedSlots: matched,
      });
    });

    const completedNow = [...questProgress.values()].filter(
      qp => qp.matchedSlots === qp.totalSlots && qp.totalSlots > 0
    );

    // Diagnostic guard: fresh punches exist but NOT ONE matches any quest's
    // stations - the pattern routing is missing/empty, the game data has no
    // quests, or the pattern's station codes don't line up with the physical
    // stations. Without this the read "succeeds" invisibly (no quest, no
    // partial, a no-op animation), which the operator reads as "nothing
    // happened". Surface it as a visible warning + a console dump of the two
    // code sets so the mismatch is obvious. Skipped on a finish bip (card.end)
    // so the end-station flow below still runs.
    // A malus-station hit IS a recognised station, so it must not trip this
    // guard: punching only the trap is a legitimate (costly) read.
    if (workingPunches.length > 0 && card.end == null && malusHitPunches.length === 0) {
      const totalMatchedSlots = [...questProgress.values()].reduce((s, qp) => s + qp.matchedSlots, 0);
      const nothingMatches =
        patternItems.length === 0 ||
        quests.length === 0 ||
        (questProgress.size > 0 && totalMatchedSlots === 0);
      if (nothingMatches) {
        const expectedStations = [...new Set(patternItems.map((pi) => pi.station_key_number))].sort((a, b) => a - b);
        const punchedCodes = [...workingCodes];
        console.warn('[TagQuest] No punched station matches the pattern:', JSON.stringify({
          pattern: patternUniqid || '(none)',
          patternItemCount: patternItems.length,
          questCount: quests.length,
          expectedStations,
          punchedCodes,
        }));
        // Language-neutral diagnostic only. The readable sentence comes from
        // `ingame_common:no_station_match` in the team's language (this module
        // has no language to resolve against); describePunchStatus appends this
        // detail after it so the operator still sees which codes were read.
        const message =
          patternItems.length === 0
            ? `pattern=${patternUniqid || '-'} (0 stations)`
            : quests.length === 0
              ? 'quests=0'
              : `punched=[${punchedCodes.join(', ')}] expected=[${expectedStations.join(', ')}]`;
        return {
          team_name: teamName,
          team_id: team.id,
          teammate_chip_id: teammateChipId,
          completed_quest: null,
          points_earned: 0,
          combo_bonus: 0,
          malus_applied: 0,
        station_malus_applied: 0,
        malus_station_hits: 0,
          new_total_score: team.score,
          level_up: null,
          best_partial_quest: null,
          end_station_reached: false,
          game_ended: false,
          status: 'no_station_match',
          message,
          dropped_punches: droppedPunches,
          card_full: cardFull,
        };
      }
    }

    // Step 10: Late malus calculation (using game metadata from `state` above).
    let malusApplied = 0;
    if (state.start_time && lateMalusPoints > 0) {
      const startMs = new Date(state.start_time).getTime();
      const durationMs = (state.duration ?? 0) * 60 * 1000;
      const deadline = startMs + durationMs;
      const now = Date.now();
      if (now > deadline) {
        const minutesOver = Math.ceil((now - deadline) / 60000);
        malusApplied = minutesOver * lateMalusPoints;
      }
    }

    // Step 11: Apply scoring
    let newCompletedQuest: PunchResult['completed_quest'] = null;

    const buildCompletionMap = (rows: { quest_number: string }[]): Map<string, number> => {
      const map = new Map<string, number>();
      for (const r of rows) {
        map.set(r.quest_number, (map.get(r.quest_number) ?? 0) + 1);
      }
      return map;
    };

    const beforeCompletionMap = buildCompletionMap(
      completedQuests.map((r) => ({ quest_number: String(r.quest_number) }))
    );
    const beforeCombos = computeCombos(beforeCompletionMap);

    // Punch-consumption pool for THIS read: one physical punch can satisfy at
    // most one quest completion. As each quest is recorded we mark the earliest
    // unused punch at each required station as used (so two quests sharing a
    // station in the same read can't both claim the same punch) and add it to
    // the team's consumed set so it can never score again - here or later.
    const consumablePool = workingPunches.map((p) => ({
      code: String(p.code),
      time: p.time,
      used: false,
    }));
    const consumeQuestPunches = (itemIndex: number) => {
      const stations = patternItems
        .filter((pi) => pi.item_index === itemIndex)
        .map((pi) => String(pi.station_key_number));
      for (const st of stations) {
        const candidate = consumablePool
          .filter((c) => !c.used && c.code === st)
          .sort((a, b) => (punchSecondsOfDay(a.time) ?? 0) - (punchSecondsOfDay(b.time) ?? 0))[0];
        if (candidate) {
          candidate.used = true;
          teamConsumed.add(`${candidate.code}@${candidate.time}`);
        }
      }
    };

    for (const qp of completedNow) {
      const itemIndex = qp.questIndex + 1;
      const rawPts = qp.quest.points ?? 0;
      const pts = typeof rawPts === 'string' ? parseInt(rawPts, 10) || 0 : rawPts;

      // In speed mode, skip if already completed (guards against rare race conditions)
      if (!isScoreMode && completedQuestNumbers.has(itemIndex)) continue;

      const res = await recordCompletedQuest({
        launched_game_id: launchedGameId,
        team_id: team.id,
        teammate_chip_id: teammateChipId ?? card.id,
        quest_number: String(itemIndex),
        points_awarded: pts,
        // Score mode allows duplicates (re-completing a quest scores again).
        // Speed mode is unique-per-quest; the server enforces idempotency.
        allow_duplicates: isScoreMode,
      });

      if (res.inserted) {
        // Burn the punches that completed this quest so they can never score
        // again (this read or any later one).
        consumeQuestPunches(itemIndex);
        if (!newCompletedQuest) {
          newCompletedQuest = {
            index: itemIndex,
            name: qp.quest.name,
            points: pts,
          };
        }
      }
    }

    // Malus-station hits: one persisted row per punch, so the penalty survives
    // the from-scratch recompute below (and a kiosk reload / another device
    // reading the same mother). Stored negative so any consumer that naively
    // sums `points_awarded` still lands on the right total.
    let stationMalusApplied = 0;
    let malusHitsCharged = 0;
    for (const p of malusHitPunches) {
      const id = punchId(p);
      // Defensive: the studio editor forbids the malus station from being a
      // pattern station, but a launch-time pattern override can still break
      // that. A punch the quest loop just consumed has already been paid for -
      // charging it too would count one bip twice. The quest wins.
      if (teamConsumed.has(id)) {
        console.warn(
          `[TagQuest] Punch ${id} completed a quest AND sits on the malus station - malus skipped. The launched pattern uses the scenario's malus station.`,
        );
        continue;
      }
      // Burn it first: even if the write fails we must not charge it twice on
      // the next read of the same card.
      teamConsumed.add(id);
      const poolEntry = consumablePool.find((c) => !c.used && c.code === String(p.code) && c.time === p.time);
      if (poolEntry) poolEntry.used = true;
      const res = await recordCompletedQuest({
        launched_game_id: launchedGameId,
        team_id: team.id,
        teammate_chip_id: teammateChipId ?? card.id,
        quest_number: MALUS_QUEST_NUMBER,
        points_awarded: -malusPoints,
        allow_duplicates: true,
      });
      if (res.inserted) {
        stationMalusApplied += malusPoints;
        malusHitsCharged++;
      }
    }

    // Recompute score from scratch based on all completed quests (existing + new)
    // This guarantees the score is always consistent with team_completed_quests
    const allRows = await listCompletedQuests(launchedGameId, team.id);
    const { questRows: allCompletedRows, stationMalus } = partitionMalusRows(allRows);
    const allCompleted = allCompletedRows;
    const totalQuestPoints = allCompleted.reduce((sum, r) => sum + (r.points_awarded ?? 0), 0);

    const afterCompletionMap = buildCompletionMap(
      allCompleted.map(r => ({ quest_number: String(r.quest_number) }))
    );
    const afterCombos = computeCombos(afterCompletionMap);
    const totalComboBonus =
      afterCombos.combos6 * pts6 +
      afterCombos.combos4 * pts4 +
      afterCombos.combos2 * pts2;

    const prevTotalQuestPoints = completedQuests.reduce((sum, r) => sum + (r.points_awarded ?? 0), 0);
    const prevTotalComboBonus =
      beforeCombos.combos6 * pts6 +
      beforeCombos.combos4 * pts4 +
      beforeCombos.combos2 * pts2;
    const prevScore = team.score ?? 0;
    // Invert the score formula to recover the TOTAL malus already baked into
    // the stored score (earned × weight − malus = score), then take out the
    // station malus - which we know exactly from the persisted rows - to leave
    // the late malus. Approximate when the weight changed since the last punch
    // (live headcount); display-only.
    const prevTotalMalus = Math.max(0, Math.round((prevTotalQuestPoints + prevTotalComboBonus) * weight) - prevScore);
    const prevMalus = Math.max(0, prevTotalMalus - prevStationMalus);

    const comboBonus =
      (afterCombos.combos6 - beforeCombos.combos6) * pts6 +
      (afterCombos.combos4 - beforeCombos.combos4) * pts4 +
      (afterCombos.combos2 - beforeCombos.combos2) * pts2;

    const pointsEarned = completedNow.reduce((sum, qp) => {
      const rawPts = qp.quest.points ?? 0;
      return sum + (typeof rawPts === 'string' ? parseInt(rawPts, 10) || 0 : rawPts);
    }, 0) + comboBonus;

    // Both penalties are unweighted (see tagquestScoring's contract).
    const newScore = weightedScore(totalQuestPoints + totalComboBonus, weight, malusApplied + stationMalus);
    const scoreDelta = newScore - prevScore;

    // Step 12: Level up check
    let levelUpResult: PunchResult['level_up'] = null;
    if (levels) {
      const prevLevel = computeLevel(prevScore, levels);
      const newLevel = computeLevel(newScore, levels);
      if (newLevel && (!prevLevel || newLevel.level > prevLevel.level)) {
        levelUpResult = { new_level: newLevel.level, name: newLevel.name };
      }
    }

    // Step 13: End station detection - only end_time if card.end is present
    const endStationReached = card.end != null;

    let gameEnded = false;
    let endTimeToCommit: number | undefined;
    const scoreNeedsWrite = scoreDelta !== 0 || completedNow.length > 0 || stationMalusApplied > 0;
    if (endStationReached && !team.end_time) {
      // Stamp the KIOSK's clock, not the finish station's. `start_time` is
      // already kiosk-clock (TagQuestGamePage's mass start writes
      // `Math.floor(Date.now()/1000)`), so this is the only way the pair can be
      // subtracted into a duration - the leaderboards rank on `end_time` and
      // show `end_time - start_time`.
      //
      // This also fixes a real bug: the old `toMs(card.end.time)` ran parseFloat
      // over "HH:MM:SS", which stops at the first colon, so every finisher was
      // stamped with the HOUR as a unix timestamp (14:30:00 -> end_time 14, i.e.
      // 1970). Ranking was by hour-of-day with mass ties, and durations came out
      // hugely negative.
      //
      // Trade-off: a team punching FINISH out in the field is timed to when they
      // reach the reader, not to the punch. That offset is roughly equal for
      // everyone, so the ranking order holds.
      endTimeToCommit = Math.floor(Date.now() / 1000);
      gameEnded = true;
      if (scoreNeedsWrite) {
        await updateTeam(team.id, { score: newScore });
      }
    } else if (scoreNeedsWrite) {
      await updateTeam(team.id, { score: newScore });
    }

    // Step 14: Best partial quest (if no complete quest this round)
    let bestPartial: PunchResult['best_partial_quest'] = null;
    if (completedNow.length === 0) {
      const inProgress = [...questProgress.values()].filter(qp => qp.matchedSlots > 0);
      if (inProgress.length > 0) {
        const best = inProgress.reduce((a, b) => a.matchedSlots >= b.matchedSlots ? a : b);
        bestPartial = {
          index: best.questIndex + 1,
          name: best.quest.name,
          matched: best.matchedSlots,
        };
      }
    }

    // Build animation data
    const buildQuestDetails = (
      rows: { quest_number: string; points_awarded: number }[]
    ) => {
      const map = new Map<string, { count: number; pts: number }>();
      for (const r of rows) {
        const existing = map.get(r.quest_number) ?? { count: 0, pts: 0 };
        map.set(r.quest_number, { count: existing.count + 1, pts: existing.pts + (r.points_awarded ?? 0) });
      }
      return [...map.entries()].map(([qn, v]) => {
        const idx = parseInt(qn, 10) - 1;
        const q = quests[idx];
        return { questIndex: idx, name: q?.name ?? qn, timesCompleted: v.count, totalPoints: v.pts };
      });
    };

    const prevQuestDetails = buildQuestDetails(
      completedQuests.map((r) => ({ quest_number: String(r.quest_number), points_awarded: r.points_awarded ?? 0 }))
    );

    const newQuestDetails = buildQuestDetails(
      allCompletedRows.map((r) => ({ quest_number: String(r.quest_number), points_awarded: r.points_awarded ?? 0 }))
    );

    // Determine which quest to display (completed or best partial)
    let displayQuest: PunchAnimationData['displayQuest'] = null;

    const bestProgress = newCompletedQuest
      ? questProgress.get(newCompletedQuest.index) ?? null
      : bestPartial
      ? questProgress.get(bestPartial.index) ?? null
      : null;

    const targetItemIndex = newCompletedQuest?.index ?? bestPartial?.index ?? null;

    if (targetItemIndex !== null && bestProgress) {
      const quest = bestProgress.quest;
      const questSlots = patternItems.filter(pi => pi.item_index === targetItemIndex);
      const imageKeys = ['image_1', 'image_2', 'image_3', 'image_4'] as const;
      const slots: QuestImageSlot[] = questSlots.map((pi, slotIdx) => {
        const imageKey = imageKeys[slotIdx] as string | undefined;
        const rawKey = imageKey ? (quest[imageKey] as string | undefined) : undefined;
        const src = rawKey ? resolveMedia(rawKey) : '';
        return {
          key: String(pi.station_key_number),
          src,
          matched: workingCodes.has(String(pi.station_key_number)),
        };
      });

      const rawMainKey = quest.main_image;
      const mainSrc = rawMainKey ? resolveMedia(rawMainKey) : '';

      const rawPts = quest.points ?? 0;
      const pts = typeof rawPts === 'string' ? parseInt(rawPts, 10) || 0 : rawPts;

      const timesCompleted = allCompletedRows.filter((r) => r.quest_number === String(targetItemIndex)).length;

      displayQuest = {
        index: targetItemIndex,
        name: quest.name,
        points: pts,
        main_image: mainSrc,
        slots,
        complete: newCompletedQuest?.index === targetItemIndex,
        timesCompleted,
        totalPointsForQuest: allCompletedRows
          .filter((r) => r.quest_number === String(targetItemIndex))
          .reduce((s, r) => s + (r.points_awarded ?? 0), 0),
      };
    }

    const animationData: PunchAnimationData = {
      teamName: teamName,
      prevScore: prevScore,
      prevCombos: beforeCombos,
      prevQuestDetails,
      // `malus` is the station malus, `lateMalus` the time-based one - the HUD
      // has a slot (and an author-supplied icon) for each.
      prevMalus: prevStationMalus,
      prevLateMalus: prevMalus,
      comboPoints: { pts6, pts4, pts2 },
      displayQuest,
      newScore,
      newCombos: afterCombos,
      newQuestDetails,
      newMalus: stationMalus,
      newLateMalus: malusApplied,
      gameOver: gameEnded,
      endTimeToCommit,
      teamId: team.id,
    };

    const result: PunchResult = {
      team_name: teamName,
      team_id: team.id,
      teammate_chip_id: teammateChipId,
      completed_quest: newCompletedQuest,
      points_earned: pointsEarned,
      combo_bonus: comboBonus,
      malus_applied: Math.max(0, malusApplied - prevMalus),
      station_malus_applied: stationMalusApplied,
      malus_station_hits: malusHitsCharged,
      new_total_score: newScore,
      level_up: levelUpResult,
      best_partial_quest: bestPartial,
      end_station_reached: endStationReached,
      game_ended: gameEnded,
      status: 'ok',
      animationData,
      dropped_punches: droppedPunches,
      card_full: cardFull,
    };

    console.log('[TagQuest] Punch processed:', JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    console.error('[TagQuest] Error processing punch:', err);
    return errorResult(String(err));
  }
}
