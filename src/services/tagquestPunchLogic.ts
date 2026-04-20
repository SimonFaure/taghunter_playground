import { supabase } from '../lib/db';
import { getPatternFilesFromStorage } from '../utils/patterns';
import { CardData } from './usbReader';
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
  default_time?: string | number;
  levels?: Record<string, { points: string | null; name: string | null; description: string }>;
  combo_6_quests?: string | number;
  combo_4_quests?: string | number;
  combo_2_quests?: string | number;
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

interface PunchResult {
  team_name: string;
  team_id: number;
  teammate_chip_id: number | null;
  completed_quest: { index: number; name: string; points: number } | null;
  points_earned: number;
  combo_bonus: number;
  malus_applied: number;
  new_total_score: number;
  level_up: { new_level: number; name: string } | null;
  best_partial_quest: { index: number; name: string; matched: number } | null;
  end_station_reached: boolean;
  game_ended: boolean;
  status: 'ok' | 'chip_not_recognized' | 'team_already_finished' | 'cheat_detected' | 'error';
  message?: string;
  animationData?: PunchAnimationData;
}

function getQuests(gdj: GameDataJson): GameQuest[] {
  return gdj?.quests || [];
}

function getLateMalusPoints(gdj: GameDataJson): number {
  const val = gdj?.game_meta?.late_malus_points ?? gdj?.game_meta?.default_time_malus ?? 0;
  return typeof val === 'string' ? parseFloat(val) || 0 : val;
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

function toMs(time: number | string): number {
  const n = typeof time === 'string' ? parseFloat(time) : time;
  if (n > 1e10) return n;
  return n * 1000;
}

function deduplicatePunches(
  punches: CardData['punches'],
  windowMs = 20000
): CardData['punches'] {
  const sorted = [...punches].sort((a, b) => toMs(a.time) - toMs(b.time));

  const result: CardData['punches'] = [];
  for (const punch of sorted) {
    const last = result.findLast(p => p.code === punch.code);
    if (!last) {
      result.push(punch);
      continue;
    }
    const diff = Math.abs(toMs(punch.time) - toMs(last.time));
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
  gameType: string,
  patternUniqid: string
): Promise<PatternItem[]> {
  if (!patternUniqid) return [];

  try {
    const storageFiles = await getPatternFilesFromStorage(gameType);
    const match = storageFiles.find(f => f.uniqid === patternUniqid);
    if (!match) {
      console.warn('[TagQuest] No pattern file found for uniqid:', patternUniqid);
      return [];
    }

    const { data: urlData } = supabase.storage
      .from('resources')
      .getPublicUrl(match.storagePath);

    const resp = await fetch(urlData.publicUrl);
    if (!resp.ok) {
      console.warn('[TagQuest] Failed to fetch pattern file:', match.storagePath);
      return [];
    }

    const json = await resp.json();
    if (Array.isArray(json?.pattern_data)) {
      return json.pattern_data as PatternItem[];
    }

    console.warn('[TagQuest] Pattern file missing pattern_data array:', match.storagePath);
    return [];
  } catch (err) {
    console.error('[TagQuest] Error loading pattern items from file:', err);
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
  resolveMedia: (key: string) => string = () => ''
): Promise<PunchResult> {
  const errorResult = (message: string): PunchResult => ({
    team_name: '',
    team_id: 0,
    teammate_chip_id: null,
    completed_quest: null,
    points_earned: 0,
    combo_bonus: 0,
    malus_applied: 0,
    new_total_score: 0,
    level_up: null,
    best_partial_quest: null,
    end_station_reached: false,
    game_ended: false,
    status: 'error',
    message,
  });

  try {
    // Step 1: Resolve team from chip ID
    let resolvedTeamId: number | null = null;
    let teammateChipId: number | null = null;

    const { data: directTeam } = await supabase
      .from('teams')
      .select('*')
      .eq('launched_game_id', launchedGameId)
      .eq('key_id', card.id)
      .maybeSingle();

    if (directTeam) {
      resolvedTeamId = directTeam.id;
    } else if (playMode === 'team') {
      for (const t of teamsConfig) {
        const match = t.teammates?.find(mate => mate.chipId === card.id);
        if (match) {
          const { data: parentTeam } = await supabase
            .from('teams')
            .select('*')
            .eq('launched_game_id', launchedGameId)
            .eq('key_id', t.chipId)
            .maybeSingle();

          if (parentTeam) {
            resolvedTeamId = parentTeam.id;
            teammateChipId = card.id;
          }
          break;
        }
      }
    }

    if (resolvedTeamId === null) {
      console.log('[TagQuest] Chip not recognized:', card.id);
      return {
        team_name: '',
        team_id: 0,
        teammate_chip_id: null,
        completed_quest: null,
        points_earned: 0,
        combo_bonus: 0,
        malus_applied: 0,
        new_total_score: 0,
        level_up: null,
        best_partial_quest: null,
        end_station_reached: false,
        game_ended: false,
        status: 'chip_not_recognized',
        message: `Chip ${card.id} not recognized in game ${launchedGameId}`,
      };
    }

    const { data: team } = await supabase
      .from('teams')
      .select('*')
      .eq('id', resolvedTeamId)
      .maybeSingle();

    if (!team) return errorResult('Team record not found');

    // Step 2: Check if team already finished
    if (team.end_time) {
      console.log('[TagQuest] Team already finished:', team.team_name);
      return {
        team_name: team.team_name,
        team_id: team.id,
        teammate_chip_id: teammateChipId,
        completed_quest: null,
        points_earned: 0,
        combo_bonus: 0,
        malus_applied: 0,
        new_total_score: team.score,
        level_up: null,
        best_partial_quest: null,
        end_station_reached: false,
        game_ended: true,
        status: 'team_already_finished',
        message: `${team.team_name} has already completed the game`,
      };
    }

    // Step 3: Cheat detection using previous raw data for the same chip
    const { data: previousRecords } = await supabase
      .from('launched_game_raw_data')
      .select('raw_data, created_at')
      .eq('launched_game_id', launchedGameId)
      .eq('raw_data->>id', card.id.toString())
      .order('created_at', { ascending: false })
      .limit(2);

    if (previousRecords && previousRecords.length >= 2) {
      const previousCard = previousRecords[1].raw_data as CardData;
      if (isCheatDetected(card.punches, previousCard.punches)) {
        console.log('[TagQuest] Cheat detected for chip:', card.id, 'team:', team.team_name);
        return {
          team_name: team.team_name,
          team_id: team.id,
          teammate_chip_id: teammateChipId,
          completed_quest: null,
          points_earned: 0,
          combo_bonus: 0,
          malus_applied: 0,
          new_total_score: team.score,
          level_up: null,
          best_partial_quest: null,
          end_station_reached: false,
          game_ended: false,
          status: 'cheat_detected',
          message: `Cheat detected for ${team.team_name} (chip ${card.id})`,
        };
      }
    }

    // Step 4: Load pattern items from the pattern file in storage
    const { data: metaRows } = await supabase
      .from('launched_game_meta')
      .select('meta_name, meta_value')
      .eq('launched_game_id', launchedGameId);

    const metaMap: Record<string, string> = {};
    metaRows?.forEach(m => { metaMap[m.meta_name] = m.meta_value || ''; });

    const patternUniqid = metaMap.pattern || '';

    const { data: launchedGameRow } = await supabase
      .from('launched_games')
      .select('game_type')
      .eq('id', launchedGameId)
      .maybeSingle();

    const gameType = (launchedGameRow?.game_type || 'mystery').toLowerCase();

    const patternItems: PatternItem[] = await loadPatternItemsFromFile(gameType, patternUniqid);

    // Step 5: Load game data for quest definitions
    let gameDataJson: GameDataJson | null = null;

    try {
      const { data: urlData } = supabase.storage
        .from('resources')
        .getPublicUrl(`scenarios/${gameUniqid}/game-data.json`);
      const resp = await fetch(urlData.publicUrl);
      if (resp.ok) {
        const raw = await resp.json();
        gameDataJson = raw?.game_data ?? raw;
      } else {
        console.warn('[TagQuest] Could not fetch game-data.json from storage, status:', resp.status);
      }
    } catch (err) {
      console.warn('[TagQuest] Error fetching game-data.json from storage:', err);
    }

    const quests = gameDataJson ? getQuests(gameDataJson) : [];
    const lateMalusPoints = gameDataJson ? getLateMalusPoints(gameDataJson) : 0;
    const { pts6, pts4, pts2 } = gameDataJson ? getComboPoints(gameDataJson) : { pts6: 0, pts4: 0, pts2: 0 };
    const levels = gameDataJson?.game_meta?.levels;

    const victoryType = (metaMap.victoryType || 'speed').toLowerCase();
    const isScoreMode = victoryType === 'score';

    // Step 6: Load already-scored quests for this team
    // quest_number stores the 1-based item_index (= array index + 1)
    const { data: completedQuests } = await supabase
      .from('team_completed_quests')
      .select('quest_number, points_awarded')
      .eq('team_id', team.id);

    const completedQuestNumbers = new Set((completedQuests || []).map(r => Number(r.quest_number)));

    // Step 7: Sanitize - remove already-scored quest punches from working set
    // In score mode, quests can be completed multiple times so we never strip them out.
    let workingPunches = [...card.punches];

    if (!isScoreMode) {
      for (const questNumber of completedQuestNumbers) {
        const requiredStations = new Set(
          patternItems
            .filter(pi => pi.item_index === questNumber)
            .map(pi => String(pi.station_key_number))
        );

        const presentStations = new Set(workingPunches.map(p => String(p.code)));
        const allPresent = [...requiredStations].every(s => presentStations.has(s));

        if (allPresent) {
          workingPunches = workingPunches.filter(p => !requiredStations.has(String(p.code)));
        }
      }
    }

    // Step 8: Deduplicate punches
    workingPunches = deduplicatePunches(workingPunches);

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

    // Step 10: Late malus calculation
    let malusApplied = 0;
    const { data: launchedGame } = await supabase
      .from('launched_games')
      .select('start_time, duration')
      .eq('id', launchedGameId)
      .maybeSingle();

    if (launchedGame && lateMalusPoints > 0) {
      const startMs = new Date(launchedGame.start_time).getTime();
      const durationMs = (launchedGame.duration ?? 0) * 60 * 1000;
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
      (completedQuests || []).map(r => ({ quest_number: String(r.quest_number) }))
    );
    const beforeCombos = computeCombos(beforeCompletionMap);

    for (const qp of completedNow) {
      const itemIndex = qp.questIndex + 1;
      const rawPts = qp.quest.points ?? 0;
      const pts = typeof rawPts === 'string' ? parseInt(rawPts, 10) || 0 : rawPts;

      const row = {
        launched_game_id: launchedGameId,
        team_id: team.id,
        teammate_chip_id: teammateChipId ?? card.id,
        quest_id: null,
        quest_number: String(itemIndex),
        points_awarded: pts,
      };

      // In speed mode, skip if already completed (guards against rare race conditions)
      if (!isScoreMode && completedQuestNumbers.has(itemIndex)) continue;

      let insertedRows: { id: number }[] | null = null;
      if (isScoreMode) {
        const { data } = await supabase
          .from('team_completed_quests')
          .insert(row)
          .select('id');
        insertedRows = data;
      } else {
        const { data } = await supabase
          .from('team_completed_quests')
          .upsert(row, { onConflict: 'team_id,quest_number', ignoreDuplicates: true })
          .select('id');
        insertedRows = data;
      }
      const actuallyInserted = insertedRows !== null && insertedRows.length > 0;

      if (actuallyInserted && !newCompletedQuest) {
        newCompletedQuest = {
          index: itemIndex,
          name: qp.quest.name,
          points: pts,
        };
      }
    }

    // Recompute score from scratch based on all completed quests (existing + new)
    // This guarantees the score is always consistent with team_completed_quests
    const { data: allCompletedRows } = await supabase
      .from('team_completed_quests')
      .select('quest_number, points_awarded')
      .eq('team_id', team.id);

    const allCompleted = allCompletedRows ?? [];
    const totalQuestPoints = allCompleted.reduce((sum, r) => sum + (r.points_awarded ?? 0), 0);

    const afterCompletionMap = buildCompletionMap(
      allCompleted.map(r => ({ quest_number: String(r.quest_number) }))
    );
    const afterCombos = computeCombos(afterCompletionMap);
    const totalComboBonus =
      afterCombos.combos6 * pts6 +
      afterCombos.combos4 * pts4 +
      afterCombos.combos2 * pts2;

    const prevTotalQuestPoints = (completedQuests || []).reduce((sum, r) => sum + (r.points_awarded ?? 0), 0);
    const prevTotalComboBonus =
      beforeCombos.combos6 * pts6 +
      beforeCombos.combos4 * pts4 +
      beforeCombos.combos2 * pts2;
    const prevScore = team.score ?? 0;
    const prevMalus = Math.max(0, prevTotalQuestPoints + prevTotalComboBonus - prevScore);

    const comboBonus =
      (afterCombos.combos6 - beforeCombos.combos6) * pts6 +
      (afterCombos.combos4 - beforeCombos.combos4) * pts4 +
      (afterCombos.combos2 - beforeCombos.combos2) * pts2;

    const pointsEarned = completedNow.reduce((sum, qp) => {
      const rawPts = qp.quest.points ?? 0;
      return sum + (typeof rawPts === 'string' ? parseInt(rawPts, 10) || 0 : rawPts);
    }, 0) + comboBonus;

    const newScore = Math.max(0, totalQuestPoints + totalComboBonus - malusApplied);
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

    // Step 13: End station detection — only end_time if card.end is present
    const endStationReached = card.end != null;

    let gameEnded = false;
    let endTimeToCommit: number | undefined;
    if (endStationReached && !team.end_time) {
      endTimeToCommit = Math.floor(toMs(card.end!.time) / 1000);
      gameEnded = true;
      if (scoreDelta !== 0 || completedNow.length > 0) {
        await supabase.from('teams').update({ score: newScore }).eq('id', team.id);
      }
    } else if (scoreDelta !== 0 || completedNow.length > 0) {
      await supabase.from('teams').update({ score: newScore }).eq('id', team.id);
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
      (completedQuests || []).map(r => ({ quest_number: String(r.quest_number), points_awarded: r.points_awarded ?? 0 }))
    );

    const newQuestDetails = buildQuestDetails(
      (allCompletedRows ?? []).map(r => ({ quest_number: String(r.quest_number), points_awarded: r.points_awarded ?? 0 }))
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

      const timesCompleted = (allCompletedRows ?? []).filter(r => r.quest_number === String(targetItemIndex)).length;

      displayQuest = {
        index: targetItemIndex,
        name: quest.name,
        points: pts,
        main_image: mainSrc,
        slots,
        complete: newCompletedQuest?.index === targetItemIndex,
        timesCompleted,
        totalPointsForQuest: (allCompletedRows ?? [])
          .filter(r => r.quest_number === String(targetItemIndex))
          .reduce((s, r) => s + (r.points_awarded ?? 0), 0),
      };
    }

    const animationData: PunchAnimationData = {
      teamName: team.team_name,
      prevScore: prevScore,
      prevCombos: beforeCombos,
      prevQuestDetails,
      prevMalus: 0,
      prevLateMalus: prevMalus,
      comboPoints: { pts6, pts4, pts2 },
      displayQuest,
      newScore,
      newCombos: afterCombos,
      newQuestDetails,
      newMalus: 0,
      newLateMalus: malusApplied,
      gameOver: gameEnded,
      endTimeToCommit,
      teamId: team.id,
    };

    const result: PunchResult = {
      team_name: team.team_name,
      team_id: team.id,
      teammate_chip_id: teammateChipId,
      completed_quest: newCompletedQuest,
      points_earned: pointsEarned,
      combo_bonus: comboBonus,
      malus_applied: Math.max(0, malusApplied - prevMalus),
      new_total_score: newScore,
      level_up: levelUpResult,
      best_partial_quest: bestPartial,
      end_station_reached: endStationReached,
      game_ended: gameEnded,
      status: 'ok',
      animationData,
    };

    console.log('[TagQuest] Punch processed:', JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    console.error('[TagQuest] Error processing punch:', err);
    return errorResult(String(err));
  }
}
