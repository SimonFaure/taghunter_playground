import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Trash2, Users, Save, Clock, CheckCircle, Flag, Search, ArrowUpDown, Minimize2, Maximize2, MonitorPlay, StopCircle, FlaskConical, UserPlus, PlusCircle, X, Eye, RefreshCw, Dices, Printer } from 'lucide-react';
import * as scenarioStore from '../services/scenarioStore';
import * as namePoolsStore from '../services/namePoolsStore';
import { LANG_NAMES } from '../services/langFlags';
import {
  getLaunchedGameMeta,
  updateLaunchedGameMeta,
  mergeLaunchedGameMeta,
  getLaunchedGameState,
  updateTeam,
  addTeamToLaunchedGame,
  deleteTeam,
  listCompletedQuests,
  broadcastConfigReload,
} from '../services/launchedGames';
import { getClashState, getClashMembers, type ClashStandings } from '../services/clash';
import {
  MALUS_QUEST_NUMBER,
  comboBonusPoints,
  effectifWeights,
  formatWeight,
  isWeightingEnabled,
  memberCounts,
  teamHeadcounts,
  weightedScore,
  type RosterTeam,
} from '../services/tagquestScoring';
import { gameTypeHasTeamSummary } from '../services/teamSummary';
import { HelpDot } from '../help';
import type { Team as ConfigTeam, Teammate } from './LaunchGameModal';
import type { SiPuce } from '../types/database';
import { gameClock } from '../services/gameClock';

// Tracks route keys → operator-facing labels (Add Team per-team route override).
const TRACKS_ROUTE_LABELS: Record<string, string> = {
  default: 'All checkpoints',
  reverse: 'Reversed course',
  first_half: 'First half',
  last_half: 'Last half',
  odd: 'Odd checkpoints',
  even: 'Even checkpoints',
};

// "Expand current" grid: each panel re-reads its teams this often (the normal
// single-game view only refreshes on demand).
const AUTO_REFRESH_MS = 5000;

type TeamStatus = 'playing' | 'waiting' | 'ended';
// "Sort by status": teams still playing first, then those yet to start, then finished.
const STATUS_SORT_ORDER: Record<TeamStatus, number> = { playing: 0, waiting: 1, ended: 2 };

export interface LaunchedGame {
  id: number;
  game_uniqid: string;
  name: string;
  number_of_teams: number;
  game_type: string;
  ended: boolean;
  created_at: string;
  is_test: boolean;
  /** Game simulator session (tester builds): shows the "Simulate" button. */
  is_simulated: boolean;
  /** Cross-device identity; set on rows served by the games' host only. */
  summary_uuid?: string;
  /** Licensee customer (project_licensee_customers). */
  customer_id?: string | null;
  customer_name?: string | null;
}

export interface LaunchedTeam {
  id: number;
  team_number: number;
  team_name: string;
  score: number;
  start_time: number | null;
  end_time: number | null;
  key_id: number;
  language?: string | null;
  currentLevel?: { level: number; name: string } | null;
  /** TagQuest effectif weighting (when active): live chip count + applied weight. */
  headcount?: number | null;
  weight?: number | null;
}

export interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  variant: 'danger' | 'warning' | 'info';
  confirmText?: string;
}

// The team-level modals stay mounted by the page (they are not portaled, so
// rendering them inside a sticky/scrolling panel would trap their z-index).
// Each request carries its game + a reload for the panel that opened it.
export interface TeamDetailsRequest {
  team: LaunchedTeam;
  launchedGameId: number;
  gameUniqid: string;
  gameType: string;
  chipIds: number[];
  languages: string[];
  launchLanguage: string;
  reload: () => void;
}

export interface ClashClanRequest {
  clan: { id: number; team_number: number; team_name: string | null };
  launchedGameId: number;
  reload: () => void;
}

export interface TeamTestRequest {
  gameId: number;
  gameName: string;
  team: LaunchedTeam;
  reload: () => void;
}

// Fold a scenario's game_public onto the canonical name-pool audience trio
// (mirrors LaunchGameModal's normalizeGamePublic / studio src/types/audience.ts).
function normalizeAudience(raw: unknown): string {
  const v = String(raw ?? '').toLowerCase();
  if (['adults', 'adult', 'adultes', 'teens', 'ado'].includes(v)) return 'ado_adultes';
  if (v === 'mini_kids' || v === 'ado_adultes') return v;
  return 'kids';
}

interface Props {
  game: LaunchedGame;
  /** Scenario game-data type (lowercase slug) - fallback when game_type is empty. */
  scenarioType: string;
  allChips: SiPuce[];
  isAdminMode: boolean;
  printing: boolean;
  /** 'side' = the sticky right-hand panel; 'grid' = one column of "Expand current". */
  variant: 'side' | 'grid';
  /** Re-read the teams every few seconds (paused while a form is open here). */
  autoRefresh?: boolean;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  blockedByLock: (run: () => void) => Promise<boolean>;
  onOpenTeamDetails: (req: TeamDetailsRequest) => void;
  onOpenClashClan: (req: ClashClanRequest) => void;
  onTestTeam: (req: TeamTestRequest) => void;
  onPrintTeam: (teamId: number, teamName: string) => void;
  onShowSummary: (teamId: number) => void;
}

/**
 * The teams panel of one launched game: roster, live scores, per-team actions
 * and the add team / teammate forms. Owns all its per-game state, so several
 * can run side by side ("Expand current"). Mount it keyed by the game id.
 */
export function LaunchedGameTeamsPanel({
  game,
  scenarioType,
  allChips,
  isAdminMode,
  printing,
  variant,
  autoRefresh = false,
  setConfirmDialog,
  blockedByLock,
  onOpenTeamDetails,
  onOpenClashClan,
  onTestTeam,
  onPrintTeam,
  onShowSummary,
}: Props) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<LaunchedTeam[]>([]);
  const [refreshingTeams, setRefreshingTeams] = useState(false);
  const [renamingTeamId, setRenamingTeamId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [teamSearch, setTeamSearch] = useState('');
  const [teamSortBy, setTeamSortBy] = useState<'ranking' | 'status' | 'name'>('ranking');
  const [minimizedTeams, setMinimizedTeams] = useState<Set<number>>(new Set());
  const [playMode, setPlayMode] = useState<'solo' | 'team' | null>(null);
  const [teamsConfig, setTeamsConfig] = useState<ConfigTeam[]>([]);
  const [addTeammateState, setAddTeammateState] = useState<{ teamId: number; chipId: number | null; name: string } | null>(null);
  const [addTeamState, setAddTeamState] = useState<{ name: string; chipId: number | null; route?: string; language?: string } | null>(null);
  // Tracks: enabled route set + launch default route (from launch meta), so the
  // Add Team form can offer a per-team route override (manual assignment only).
  const [tracksRouteOptions, setTracksRouteOptions] = useState<string[]>([]);
  const [tracksDefaultRoute, setTracksDefaultRoute] = useState<string>('default');
  // Mystery/tracks "Départ groupé": the whole roster was stamped started at
  // launch, so a manually added team must start immediately too - otherwise
  // its return bip would START it instead of scoring it.
  const [massStart, setMassStart] = useState(false);
  // Name-pool draw context for the manual "Random name" button: the scenario's
  // audience + language (from launch meta) and the resolved candidate names.
  const [nameDrawAudience, setNameDrawAudience] = useState<string>('kids');
  const [nameDrawLang, setNameDrawLang] = useState<string>('en');
  const [namePoolNames, setNamePoolNames] = useState<string[]>([]);
  // The scenario's available languages (from launch meta) - drives the Add-Team
  // and team-details per-team language selects. Empty ⇒ no language picker shown.
  const [languages, setLanguages] = useState<string[]>([]);
  const [savingTeammate, setSavingTeammate] = useState(false);
  const [savingTeam, setSavingTeam] = useState(false);
  // Clash: per-clan member counts (team_id → member_count), live standings
  // (points + per-territory validation counts) and the chips bound to each clan,
  // polled so the team rows show live scores/status and the members inline.
  const [clashCounts, setClashCounts] = useState<Map<number, number>>(new Map());
  const [clashStandings, setClashStandings] = useState<ClashStandings | null>(null);
  const [clashMembers, setClashMembers] = useState<Map<number, number[]>>(new Map());

  const gameType = (game.game_type || '').toLowerCase();

  // A reload can resolve after the panel unmounted (grid column dropped, other
  // game selected) - never set state then.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const loadTeams = async () => {
    const gameId = game.id;
    let teamsData: LaunchedTeam[] = [];
    let questRows: { team_id: number; quest_number: string; points_awarded: number }[] = [];
    try {
      const state = await getLaunchedGameState(gameId, 0);
      teamsData = state.teams.map((t) => ({
        id: t.id,
        team_number: t.team_number,
        team_name: t.team_name ?? '',
        score: t.score,
        start_time: t.start_time,
        end_time: t.end_time,
        key_id: t.key_id ?? 0,
        language: t.language ?? null,
      }));
    } catch (err) {
      console.error('Error loading teams:', err);
      return;
    }
    try {
      const rows = await listCompletedQuests(gameId);
      questRows = rows.map((r) => ({
        team_id: r.team_id,
        quest_number: r.quest_number,
        points_awarded: r.points_awarded,
      }));
    } catch (err) {
      console.warn('[LaunchedGameTeamsPanel] completed quests fetch failed:', err);
    }

    const scoreByTeam: Record<number, number> = {};
    const questCountByTeam: Record<number, Record<string, number>> = {};
    // Malus-station hits share the completed-quests table (see
    // MALUS_QUEST_NUMBER) but are penalties, not completions: they must not
    // count towards combos, and they are subtracted UNWEIGHTED below.
    const stationMalusByTeam: Record<number, number> = {};
    for (const row of questRows) {
      if (row.quest_number === MALUS_QUEST_NUMBER) {
        stationMalusByTeam[row.team_id] = (stationMalusByTeam[row.team_id] ?? 0) + Math.abs(row.points_awarded ?? 0);
        continue;
      }
      scoreByTeam[row.team_id] = (scoreByTeam[row.team_id] ?? 0) + (row.points_awarded ?? 0);
      if (!questCountByTeam[row.team_id]) questCountByTeam[row.team_id] = {};
      questCountByTeam[row.team_id][row.quest_number] = (questCountByTeam[row.team_id][row.quest_number] ?? 0) + 1;
    }

    let pts6 = 0, pts4 = 0, pts2 = 0;
    let gameLevels: Record<string, { name: string | null; points: string | null }> | null = null;
    if (game.game_uniqid) {
      try {
        // Slice 2: scenario game-data.json comes from the local SQLite/FS store.
        const gameDataJson = (await scenarioStore.getGameData(game.game_uniqid)) as any;
        const gameMeta = gameDataJson?.game_data?.game_meta ?? gameDataJson?.game_meta;
        const parseVal = (v: any) => (v === undefined || v === null) ? 0 : (typeof v === 'string' ? parseInt(v, 10) || 0 : v);
        pts6 = parseVal(gameMeta?.combo_6_quests);
        pts4 = parseVal(gameMeta?.combo_4_quests);
        pts2 = parseVal(gameMeta?.combo_2_quests);
        gameLevels = gameMeta?.levels ?? null;
      } catch { /* swallow - combos default to 0 */ }
    }

    const computeLevelForScore = (score: number): { level: number; name: string } | null => {
      if (!gameLevels) return null;
      let best: { level: number; name: string } | null = null;
      for (const [key, val] of Object.entries(gameLevels)) {
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
    };

    // Only the quest system (TagQuest) derives its score from completed_quests.
    // Tracks / Mystery / Clash store the authoritative score on the team row
    // (set by the runtime + by TeamDetailsModal overrides) - recomputing from
    // quests would zero it out, so use the row score as-is for those types.
    const isTagQuest = gameType === 'tagquest';

    // Effectif weighting (launch option): mirror the punch logic's weighted
    // score so this list matches lg_teams.score. Headcounts come from the
    // self-register bindings (lg_clash_members) or the pre-built roster.
    let headcounts: Map<number, number> | null = null;
    let weights: Map<number, number> | null = null;
    if (isTagQuest) {
      try {
        const meta = await getLaunchedGameMeta(gameId);
        if (isWeightingEnabled(meta)) {
          let roster: RosterTeam[] = [];
          try { roster = JSON.parse(meta.teamsConfig || '[]'); } catch { /* swallow */ }
          const members = await getClashMembers(gameId).catch(() => []);
          headcounts = teamHeadcounts(teamsData, roster, memberCounts(members));
          weights = effectifWeights(headcounts);
        }
      } catch { /* weighting unavailable - fall back to raw scores */ }
    }

    const enriched = teamsData.map(t => {
      if (!isTagQuest) {
        return { ...t, currentLevel: computeLevelForScore(t.score) };
      }
      const questScore = scoreByTeam[t.id] ?? 0;
      const comboBonus = comboBonusPoints(questCountByTeam[t.id] ?? {}, pts6, pts4, pts2);
      const totalScore = weightedScore(
        questScore + comboBonus,
        weights?.get(t.id) ?? 1,
        stationMalusByTeam[t.id] ?? 0,
      );
      return {
        ...t,
        score: totalScore,
        currentLevel: computeLevelForScore(totalScore),
        headcount: headcounts?.get(t.id) ?? null,
        weight: weights?.get(t.id) ?? null,
      };
    });

    if (aliveRef.current) setTeams(enriched);
  };

  // Stable handle for the modals + the auto-refresh timer (loadTeams is
  // re-created every render).
  const loadTeamsRef = useRef(loadTeams);
  loadTeamsRef.current = loadTeams;
  const reload = () => { void loadTeamsRef.current(); };

  useEffect(() => {
    void loadTeams();
    getLaunchedGameMeta(game.id)
      .then(async (map) => {
        if (!aliveRef.current) return;
        if (map.playMode === 'solo' || map.playMode === 'team') {
          setPlayMode(map.playMode);
        }
        setMassStart(map.massStart === 'true');
        // Tracks per-team route options (persisted at launch).
        if (map.tracks_routes) {
          setTracksRouteOptions(map.tracks_routes.split(',').map((s) => s.trim()).filter(Boolean));
        }
        if (map.route) setTracksDefaultRoute(map.route);
        if (map.teamsConfig) {
          try { setTeamsConfig(JSON.parse(map.teamsConfig)); } catch { /* swallow */ }
        }
        // Name-pool draw context. namePoolAudience + language are persisted by
        // the launch modal; for older games predating that, fall back to the
        // scenario's game_meta.game_public (language falls back in the store).
        let audienceRaw: unknown = map.namePoolAudience;
        const lang = map.language;
        if (!audienceRaw) {
          try {
            const gd = (await scenarioStore.getGameData(game.game_uniqid)) as any;
            audienceRaw = (gd?.game_data?.game_meta ?? gd?.game_meta)?.game_public;
          } catch { /* swallow - defaults to 'kids' */ }
        }
        if (!aliveRef.current) return;
        setNameDrawAudience(normalizeAudience(audienceRaw));
        setNameDrawLang((lang || 'en').toLowerCase());
        setLanguages(map.availableLanguages ? map.availableLanguages.split(',') : []);
      })
      .catch((err) => console.error('[LaunchedGameTeamsPanel] meta load failed:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  // "Expand current": keep every column live. Skipped while a rename / add form
  // is open in this panel so a refresh never steals the operator's typing, and
  // while a previous read is still in flight.
  const editingRef = useRef(false);
  editingRef.current = renamingTeamId !== null || addTeamState !== null || addTeammateState !== null;
  useEffect(() => {
    if (!autoRefresh) return;
    let inFlight = false;
    const h = setInterval(() => {
      if (inFlight || editingRef.current) return;
      inFlight = true;
      void loadTeamsRef.current().finally(() => { inFlight = false; });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(h);
  }, [autoRefresh, game.id]);

  // Clash + TagQuest self-register: poll per-team member counts/chips so the
  // team rows show who joined. TagQuest self-register binds chips via the same
  // lg_clash_members rows as Clash (no teamsConfig roster exists for those
  // games); a predetermined TagQuest game simply has no member rows, so the
  // fetch is a harmless empty set.
  useEffect(() => {
    const wantsClashState = gameType === 'clash';
    const wantsMembers = wantsClashState || gameType === 'tagquest';
    if (!wantsMembers) {
      setClashCounts(new Map());
      setClashStandings(null);
      setClashMembers(new Map());
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const [st, members] = await Promise.all([
          // Standings only exist for Clash (territories/points); TagQuest just
          // needs the member bindings.
          wantsClashState ? getClashState(game.id) : Promise.resolve(null),
          getClashMembers(game.id),
        ]);
        if (cancelled) return;
        const byTeam = new Map<number, number[]>();
        for (const mem of members) {
          const arr = byTeam.get(mem.team_id);
          if (arr) arr.push(mem.chip_id);
          else byTeam.set(mem.team_id, [mem.chip_id]);
        }
        setClashMembers(byTeam);
        const m = new Map<number, number>();
        if (st) {
          for (const c of st.clans) m.set(c.team_id, c.member_count);
        } else {
          for (const [teamId, chips] of byTeam) m.set(teamId, chips.length);
        }
        setClashCounts(m);
        setClashStandings(st);
      } catch { /* ignore - next tick retries */ }
    };
    void tick();
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); };
  }, [game.id, gameType]);

  // Resolve the candidate names for the current audience/language so the
  // "Random name" button can draw instantly (and stay disabled when empty).
  useEffect(() => {
    let cancelled = false;
    namePoolsStore
      .listPoolNames(nameDrawAudience, nameDrawLang)
      .then((names) => { if (!cancelled) setNamePoolNames(names); })
      .catch(() => { if (!cancelled) setNamePoolNames([]); });
    return () => { cancelled = true; };
  }, [nameDrawAudience, nameDrawLang]);

  // Team start_time / end_time are stored as unix SECONDS (see TagQuestGamePage:
  // start is `Math.floor(startMs / 1000)`, end via endTimeToCommit). The Date
  // ctor expects milliseconds, so scale by 1000 here - otherwise every team's
  // start time renders as a 1970 timestamp.
  const formatTime = (timestamp: number | null) => {
    if (!timestamp) return t('launched:notStarted');
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString();
  };

  const handleRenameTeam = async (teamId: number) => {
    const name = renameValue.trim();
    if (!name) { setRenamingTeamId(null); return; }
    try {
      await updateTeam(teamId, { team_name: name });
      void loadTeams();
    } catch (err) {
      console.error('Error renaming team:', err);
    }
    setRenamingTeamId(null);
    setRenameValue('');
  };

  // All chips on a team (leader + teammates) from the launch config - the
  // Team Details punch tab needs them all, since in team mode members punch
  // with their own chip, not the leader's key_id.
  const chipIdsForTeam = (t: LaunchedTeam): number[] => {
    const cfg = teamsConfig.find(c => c.chipId === t.key_id || c.name === t.team_name);
    const ids = cfg ? [cfg.chipId, ...(cfg.teammates ?? []).map(m => m.chipId)] : [t.key_id];
    return [...new Set(ids.filter((x): x is number => x != null))];
  };

  const getUsedChipIds = (): Set<number> => {
    const used = new Set<number>();
    teamsConfig.forEach(t => {
      used.add(t.chipId);
      t.teammates?.forEach(m => used.add(m.chipId));
    });
    teams.forEach(t => used.add(t.key_id));
    return used;
  };

  // The first card not already assigned to a team/teammate - used to preselect
  // a chip (and seed the name from its key_name) when opening an add form.
  const firstFreeChip = (): SiPuce | undefined => {
    const used = getUsedChipIds();
    return allChips.find(c => !used.has(c.id));
  };

  // Names already in use across teams + teammates, so the random draw can avoid
  // handing out a duplicate.
  const usedNames = (): string[] => {
    const names = teams.map(t => t.team_name);
    teamsConfig.forEach(t => {
      names.push(t.name);
      t.teammates?.forEach(m => names.push(m.name));
    });
    return names.filter(Boolean);
  };

  // Draw a random pooled name, preferring one not already used. Returns null
  // when the pool has no names for the scenario's audience/language.
  const pickRandomName = (): string | null => {
    if (namePoolNames.length === 0) return null;
    const used = new Set(usedNames().map(n => n.trim().toLowerCase()));
    const free = namePoolNames.filter(n => !used.has(n.trim().toLowerCase()));
    const pool = free.length > 0 ? free : namePoolNames;
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  };

  // Open the add-team form with the first free chip preselected and its name
  // seeded from the card (per the launched-game team/player creation UX).
  const openAddTeam = () => {
    const chip = firstFreeChip();
    setAddTeamState({
      chipId: chip?.id ?? null,
      name: chip?.key_name ?? '',
      route: tracksDefaultRoute,
      // Default the per-team language to the launch language.
      language: nameDrawLang,
    });
  };

  const openAddTeammate = (teamId: number) => {
    const chip = firstFreeChip();
    setAddTeammateState({ teamId, chipId: chip?.id ?? null, name: chip?.key_name ?? '' });
  };

  const persistTeamsConfig = async (updated: ConfigTeam[]) => {
    setTeamsConfig(updated);
    try {
      // Read-modify-write: update_meta replaces the whole bag, so we need
      // the full current set, not just teamsConfig.
      const current = await getLaunchedGameMeta(game.id);
      const next = { ...current, teamsConfig: JSON.stringify(updated) };
      await updateLaunchedGameMeta(game.id, next);
      // Teammates live only in meta.teamsConfig (no DB row), so peers won't see
      // a roster change unless we push a reload - same broadcast every other
      // config-edit path performs. Covers add-team / add-teammate / remove.
      await broadcastConfigReload(game.id);
    } catch (err) {
      console.error('[LaunchedGameTeamsPanel] persistTeamsConfig failed:', err);
    }
  };

  const handleAddTeammate = async () => {
    if (!addTeammateState || addTeammateState.chipId === null || !addTeammateState.name.trim()) return;
    setSavingTeammate(true);
    const chip = allChips.find(c => c.id === addTeammateState.chipId);
    if (!chip) { setSavingTeammate(false); return; }

    const newMate: Teammate = {
      chipId: chip.id,
      chipNumber: chip.key_number,
      name: addTeammateState.name.trim(),
    };

    const updated = teamsConfig.map(t => {
      if (t.chipId === teams.find(tm => tm.id === addTeammateState.teamId)?.key_id || t.name === teams.find(tm => tm.id === addTeammateState.teamId)?.team_name) {
        return { ...t, teammates: [...(t.teammates ?? []), newMate] };
      }
      return t;
    });

    await persistTeamsConfig(updated);
    setAddTeammateState(null);
    setSavingTeammate(false);
  };

  const handleAddTeam = async () => {
    if (!addTeamState || addTeamState.chipId === null || !addTeamState.name.trim()) return;
    if (await blockedByLock(() => void handleAddTeam())) return;
    setSavingTeam(true);
    const chip = allChips.find(c => c.id === addTeamState.chipId);
    if (!chip) { setSavingTeam(false); return; }

    const nextTeamNumber = (teams.length > 0 ? Math.max(...teams.map(t => t.team_number)) : 0) + 1;

    const chosenRoute = addTeamState.route;
    try {
      const { id: newTeamId } = await addTeamToLaunchedGame({
        launched_game_id: game.id,
        team_number: nextTeamNumber,
        team_name: addTeamState.name.trim(),
        pattern: 0,
        key_id: chip.id,
        language: addTeamState.language ?? nameDrawLang ?? null,
      });
      // Mass-start game: the roster started together at launch, so a late-added
      // team starts now - its first (return) bip must score it, not start it.
      if (massStart) {
        await updateTeam(newTeamId, { start_time: Math.floor(gameClock.now() / 1000) });
      }
      // Persist a per-team route override only when it differs from the launch
      // default (the runtime falls back to the default when no override exists).
      if (chosenRoute && chosenRoute !== tracksDefaultRoute && tracksRouteOptions.length > 1) {
        await mergeLaunchedGameMeta(game.id, { [`route:${newTeamId}`]: chosenRoute });
      }
    } catch (err) {
      console.error('Error adding team:', err);
      setSavingTeam(false);
      return;
    }

    const newConfigTeam: ConfigTeam = {
      chipId: chip.id,
      chipNumber: chip.key_number,
      name: addTeamState.name.trim(),
      teammates: [],
    };

    const updated = [...teamsConfig, newConfigTeam];
    await persistTeamsConfig(updated);
    await loadTeams();
    setAddTeamState(null);
    setSavingTeam(false);
  };

  // Remove one (non-leader) teammate from a team. Teammates live only in
  // meta.teamsConfig, so this is a config edit - no DB team row involved.
  const handleRemoveTeammate = (teamId: number, teammateChipId: number, teammateName: string) => {
    setConfirmDialog({
      isOpen: true,
      title: t('launched:removeTeammateTitle'),
      message: t('launched:removeTeammateMessage', { name: teammateName }),
      variant: 'warning',
      confirmText: t('launched:removeConfirm'),
      onConfirm: async () => {
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        const t = teams.find(tm => tm.id === teamId);
        const updated = teamsConfig.map(ct => {
          if (ct.chipId === t?.key_id || ct.name === t?.team_name) {
            return { ...ct, teammates: (ct.teammates ?? []).filter(m => m.chipId !== teammateChipId) };
          }
          return ct;
        });
        await persistTeamsConfig(updated);
      },
    });
  };

  // Remove a whole team: deletes the DB team row + its completions, then drops
  // it from the launch roster (meta.teamsConfig).
  const handleRemoveTeam = (team: LaunchedTeam) => {
    setConfirmDialog({
      isOpen: true,
      title: t('launched:removeTeamTitle'),
      message: t('launched:removeTeamMessage', { name: team.team_name }),
      variant: 'danger',
      confirmText: t('launched:removeTeamConfirm'),
      onConfirm: async () => {
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        try {
          await deleteTeam(team.id);
          const updated = teamsConfig.filter(
            ct => !(ct.chipId === team.key_id || ct.name === team.team_name)
          );
          await persistTeamsConfig(updated);
        } catch (err) {
          console.error('[LaunchedGameTeamsPanel] removeTeam failed:', err);
        }
        void loadTeams();
      },
    });
  };

  // Stamp a team's end_time = now (unix seconds) so their clock stops and they
  // count as finished. If they never started, also backfill start_time = now so
  // the recorded duration is 0 rather than a bogus negative value. Works for
  // every game type. No-op if already ended.
  const handleEndTeam = (team: LaunchedTeam) => {
    if (team.end_time) return;
    setConfirmDialog({
      isOpen: true,
      title: t('launched:endTeamTitle'),
      message: t('launched:endTeamMessage', { name: team.team_name || `#${team.team_number}` }),
      variant: 'warning',
      confirmText: t('launched:endTeamConfirm'),
      onConfirm: async () => {
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        const nowSec = Math.floor(gameClock.now() / 1000);
        try {
          await updateTeam(team.id, {
            end_time: nowSec,
            ...(team.start_time ? {} : { start_time: nowSec }),
          });
        } catch (err) {
          console.error('[LaunchedGameTeamsPanel] endTeam failed:', err);
        }
        void loadTeams();
      },
    });
  };

  const isClashGame = gameType === 'clash';
  // launched_games stores game_type capitalised ('TagQuest'); the scenario
  // game-data uses the lowercase slug. Lowercase the launched value so the
  // primary check works without depending on the async scenario fallback.
  const isTagQuest = gameType === 'tagquest' || scenarioType === 'tagquest';
  const isMystery = gameType === 'mystery' || scenarioType === 'mystery';

  const getFilteredAndSortedTeams = () => {
    let filtered = teams;

    if (teamSearch) {
      const q = teamSearch.toLowerCase();
      filtered = filtered.filter(team => {
        if (
          team.team_name.toLowerCase().includes(q) ||
          team.key_id.toString().includes(q)
        ) return true;
        const configTeam = teamsConfig.find(t => t.chipId === team.key_id || t.name === team.team_name);
        if (configTeam?.teammates?.some(m => m.name.toLowerCase().includes(q))) return true;
        return false;
      });
    }

    const sorted = [...filtered].sort((a, b) => {
      if (teamSortBy === 'name') return a.team_name.localeCompare(b.team_name);
      if (teamSortBy === 'status') {
        const byStatus = STATUS_SORT_ORDER[teamStatus(a)] - STATUS_SORT_ORDER[teamStatus(b)];
        if (byStatus !== 0) return byStatus;
      }
      return (rankById.get(a.id) ?? 0) - (rankById.get(b.id) ?? 0);
    });

    return sorted;
  };

  // Clash clans never carry a per-team quest score; rank them by live clan points.
  const effectiveScore = (team: LaunchedTeam) =>
    isClashGame ? (clashStandings?.clans.find(c => c.team_id === team.id)?.points ?? 0) : team.score;

  // Status: ended ⇒ done; started ⇒ playing; else waiting. Clash clans share one
  // game timeline and never set per-team start/end, so they derive it from the
  // ended game and their territory validations instead.
  const teamStatus = (team: LaunchedTeam): TeamStatus => {
    if (isClashGame) {
      if (game.ended) return 'ended';
      const validations = (clashStandings?.territories ?? []).reduce(
        (n, terr) => n + (terr.counts[String(team.id)] ?? 0), 0);
      return validations > 0 ? 'playing' : 'waiting';
    }
    if (team.end_time) return 'ended';
    if (team.start_time) return 'playing';
    return 'waiting';
  };

  // The "#N" shown on each row is the team's place in the score ranking, over
  // all teams, whatever the list order or search filter.
  const rankById = new Map(
    [...teams]
      .sort((a, b) => effectiveScore(b) - effectiveScore(a))
      .map((team, i) => [team.id, i + 1] as const),
  );

  const toggleMinimizeTeam = (teamId: number) => {
    setMinimizedTeams(prev => {
      const newSet = new Set(prev);
      if (newSet.has(teamId)) {
        newSet.delete(teamId);
      } else {
        newSet.add(teamId);
      }
      return newSet;
    });
  };

  const isGrid = variant === 'grid';
  const visibleTeams = getFilteredAndSortedTeams();

  return (
    <div
      className={
        isGrid
          ? 'bg-[var(--pg-surface)] border-2 border-[var(--pg-line)] rounded-lg p-4 flex flex-col max-h-[calc(100vh-7.5rem)]'
          : 'bg-[var(--pg-surface)] border-2 border-[var(--pg-line)] rounded-lg p-6 lg:flex lg:flex-col lg:max-h-[calc(100vh-7.5rem)]'
      }
    >
      <div className="flex items-center justify-between gap-2 flex-wrap mb-4 shrink-0">
        <h3 className="text-xl font-bold text-[var(--pg-text)] flex items-center gap-2">
          <Users size={20} />
          {t('launched:teamsCount', { count: teams.length })}
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setRefreshingTeams(true);
              await loadTeams();
              if (aliveRef.current) setRefreshingTeams(false);
            }}
            className="pg-btn pg-btn--sm"
            title={t('launched:refreshTeams')}
            disabled={refreshingTeams}
          >
            <RefreshCw size={14} className={refreshingTeams ? 'animate-spin' : ''} />
            {t('launched:refresh')}
          </button>
          {teams.length > 0 && (
            <button
              onClick={() => {
                if (minimizedTeams.size === teams.length) {
                  setMinimizedTeams(new Set());
                } else {
                  const allTeamIds = new Set(teams.map(t => t.id));
                  setMinimizedTeams(allTeamIds);
                }
              }}
              className="pg-btn pg-btn--sm"
              title={minimizedTeams.size === teams.length ? t('launched:expandAllTeams') : t('launched:minimizeAllTeams')}
            >
              {minimizedTeams.size === teams.length ? (
                <>
                  <Maximize2 size={14} />
                  {t('launched:expandAll')}
                </>
              ) : (
                <>
                  <Minimize2 size={14} />
                  {t('launched:minimizeAll')}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {teams.length > 0 && (
        <div className="space-y-3 mb-4 shrink-0">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] z-10" />
              <input
                type="text"
                placeholder={t('launched:searchTeamsPlaceholder')}
                value={teamSearch}
                onChange={(e) => setTeamSearch(e.target.value)}
                className="pg-input !pl-9"
              />
            </div>
            <div className="relative shrink-0">
              <ArrowUpDown size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] pointer-events-none" />
              <select
                value={teamSortBy}
                onChange={(e) => setTeamSortBy(e.target.value as typeof teamSortBy)}
                className="pg-select !pl-8"
                title={t('launched:sortTeamsBy')}
                aria-label={t('launched:sortTeamsBy')}
              >
                <option value="ranking">{t('launched:sortRanking')}</option>
                <option value="status">{t('launched:sortStatus')}</option>
                <option value="name">{t('launched:sortName')}</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* The team list scrolls on its own so an operator can reach the
          bottom teams without scrolling the whole page (and the games
          list on the left) - retours sept. 2026 #32. */}
      <div
        className={
          isGrid
            ? 'flex-1 min-h-0 overflow-y-auto -mr-3 pr-3'
            : 'lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:-mr-3 lg:pr-3'
        }
      >
        {teams.length === 0 ? (
          <p className="text-[var(--pg-text-dim)]">{t('launched:noTeamsInGame')}</p>
        ) : (
          visibleTeams.length === 0 ? (
            <p className="text-[var(--pg-text-dim)] text-sm">{t('launched:noTeamsMatchSearch')}</p>
          ) : (
          <div className="space-y-3">
            {visibleTeams.map((team, index) => {
              const isMinimized = minimizedTeams.has(team.id);
              const ranking = rankById.get(team.id) ?? index + 1;
              const isClash = isClashGame;
              // Mystery teams: the operator also wants the physical card
              // number (key_number) alongside the chip id (key_id).
              const teamCardNumber = isMystery
                ? (allChips.find(c => c.id === team.key_id)?.key_number ?? null)
                : null;
              const clanMemberCount = clashCounts.get(team.id) ?? 0;
              const showTeammates = isTagQuest && playMode === 'team';
              const configTeam = showTeammates
                ? teamsConfig.find(t => t.chipId === team.key_id || t.name === team.team_name)
                : undefined;
              const teammates = configTeam?.teammates ?? [];
              // Clash: clans share one game timeline and never set per-team
              // start/end, so derive the live score (clan points), validation
              // count (activity), member chips, and an activity-based status
              // from the polled standings instead of the lg_teams row.
              const clashStanding = isClash
                ? clashStandings?.clans.find(c => c.team_id === team.id)
                : undefined;
              const clashPoints = clashStanding?.points ?? 0;
              const clashValidations = isClash
                ? (clashStandings?.territories ?? []).reduce(
                    (n, terr) => n + (terr.counts[String(team.id)] ?? 0), 0)
                : 0;
              const clashMemberChips = isClash ? (clashMembers.get(team.id) ?? []) : [];
              // TagQuest self-register: members bound via lg_clash_members
              // (no teamsConfig roster). Shown whenever the config roster
              // has no teammates for this team.
              const tagquestMemberChips =
                isTagQuest && teammates.length === 0 ? (clashMembers.get(team.id) ?? []) : [];
              const displayScore = isClash ? clashPoints : team.score;
              const status = teamStatus(team);
              const renderStatusIcon = (size: number, extraClass = '') => {
                if (status === 'ended') return <CheckCircle size={size} className={`text-green-500 ${extraClass}`} />;
                if (status === 'playing') return <Play size={size} className={`text-[var(--pg-accent-bright)] ${extraClass}`} />;
                return <Clock size={size} className={`text-[var(--pg-text-dim)] ${extraClass}`} />;
              };
              const clanChipLabel = (chipId: number) => {
                const c = allChips.find(x => x.id === chipId);
                return c ? { number: c.key_number, name: c.key_name } : { number: chipId, name: '' };
              };

              return (
              <div
                key={team.id}
                className="bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-lg overflow-hidden"
              >
                {isMinimized ? (
                  <div className="p-3 flex items-center justify-between cursor-pointer hover:bg-[var(--pg-surface-3)] transition" onClick={() => toggleMinimizeTeam(team.id)}>
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <span className="text-[var(--pg-text-dim)] text-sm font-medium">#{ranking}</span>
                      <div className="flex items-center gap-2 min-w-0">
                        {renderStatusIcon(16, 'shrink-0')}
                        <span className="text-[var(--pg-text)] font-semibold truncate">{team.team_name}</span>
                      </div>
                      {showTeammates && teammates.length > 1 && (
                        <span className="flex items-center gap-1 text-teal-400 text-xs shrink-0">
                          <Users size={12} />
                          {teammates.length}
                        </span>
                      )}
                      {(isClash || tagquestMemberChips.length > 0) && (
                        <span className="flex items-center gap-1 text-blue-400 text-xs shrink-0" title={t('launched:chipsInTeam')}>
                          <Users size={12} />
                          {clanMemberCount}
                        </span>
                      )}
                      <span className="flex items-center gap-2 text-[var(--pg-text-dim)] text-sm ml-auto mr-4 shrink-0">
                        {t('launched:scoreLabel')} <span className="text-[var(--pg-text)] font-medium">{displayScore}</span>
                        {team.weight != null && (
                          <span
                            title={t('launched:effectifWeightTitle')}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-sky-500/20 border border-sky-500/40 rounded-full text-sky-400 text-xs font-semibold"
                          >
                            <Users size={12} />
                            {t('launched:effectifWeightBadge', { count: team.headcount ?? 1, weight: formatWeight(team.weight) })}
                          </span>
                        )}
                        {team.currentLevel && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                            {team.currentLevel.name}
                          </span>
                        )}
                      </span>
                      {!showTeammates && !isClash && (
                        <span className="text-[var(--pg-text-dim)] text-sm shrink-0 flex items-center gap-2">
                          <span>{t('launched:chipLabel', { id: team.key_id })}</span>
                          {isMystery && teamCardNumber != null && (
                            <span>{t('launched:cardNumberLabel', { number: teamCardNumber })}</span>
                          )}
                        </span>
                      )}
                    </div>
                    <button className="p-1 hover:bg-[var(--pg-surface-3)] rounded transition ml-2 shrink-0" title={t('launched:expandTeamDetails')}>
                      <Maximize2 size={16} className="text-[var(--pg-text-dim)]" />
                    </button>
                  </div>
                ) : (
                <div className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        {renderStatusIcon(18)}
                        {renamingTeamId === team.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={() => handleRenameTeam(team.id)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleRenameTeam(team.id);
                              if (e.key === 'Escape') { setRenamingTeamId(null); setRenameValue(''); }
                            }}
                            className="bg-[var(--pg-surface-3)] border border-[var(--pg-accent-line)] rounded px-2 py-0.5 text-[var(--pg-text)] font-semibold text-sm focus:outline-none w-36"
                          />
                        ) : (
                          <span
                            className="text-[var(--pg-text)] font-semibold cursor-pointer hover:text-[var(--pg-accent-bright)] transition-colors"
                            title={t('launched:doubleClickToRename')}
                            onDoubleClick={() => { setRenamingTeamId(team.id); setRenameValue(team.team_name); }}
                          >
                            {team.team_name}
                          </span>
                        )}
                        <span className="text-[var(--pg-text-dim)] text-xs font-mono">#{team.team_number}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!showTeammates && !isClash && (
                        <span className="text-[var(--pg-text-dim)] text-sm flex items-center gap-2">
                          <span>{t('launched:chipLabel', { id: team.key_id })}</span>
                          {isMystery && teamCardNumber != null && (
                            <span>{t('launched:cardNumberLabel', { number: teamCardNumber })}</span>
                          )}
                        </span>
                      )}
                      {isClash && (
                        <span className="flex items-center gap-1 text-blue-400 text-sm" title={t('launched:chipsInClan')}>
                          <Users size={13} />
                          {clanMemberCount}
                        </span>
                      )}
                      <button
                        onClick={() => toggleMinimizeTeam(team.id)}
                        className="p-1 hover:bg-[var(--pg-surface-3)] rounded transition"
                        title={t('launched:minimizeTeamDetails')}
                      >
                        <Minimize2 size={16} className="text-[var(--pg-text-dim)]" />
                      </button>
                    </div>
                  </div>

                <>
                    <div className="text-sm text-[var(--pg-text-dim)] space-y-1 mb-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>{t('launched:scoreLabel')} <span className="text-[var(--pg-text)] font-medium">{displayScore}</span></span>
                        {team.weight != null && (
                          <span
                            title={t('launched:effectifWeightTitle')}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-sky-500/20 border border-sky-500/40 rounded-full text-sky-400 text-xs font-semibold"
                          >
                            <Users size={12} />
                            {t('launched:effectifWeightBadge', { count: team.headcount ?? 1, weight: formatWeight(team.weight) })}
                          </span>
                        )}
                        {team.currentLevel && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                            {team.currentLevel.name}
                          </span>
                        )}
                        {isClash && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/15 border border-blue-500/30 rounded-full text-blue-300 text-xs font-semibold">
                            <Flag size={11} />
                            {t('launched:validationsBadge', { count: clashValidations })}
                          </span>
                        )}
                      </div>
                      {!isClash && (
                        <>
                          <div>{t('launched:startLabel')} <span className="text-[var(--pg-text)]">{formatTime(team.start_time)}</span></div>
                          <div>{t('launched:endLabel')} <span className="text-[var(--pg-text)]">{team.end_time ? formatTime(team.end_time) : t('launched:notEnded')}</span></div>
                        </>
                      )}
                    </div>
                    {(isClash || tagquestMemberChips.length > 0) && (
                      <div className="mb-3 pt-2 border-t border-[var(--pg-line)]">
                        <div className="flex items-center gap-1.5 text-xs text-[var(--pg-text-dim)] mb-2">
                          <Users size={12} />
                          <span className="font-medium uppercase tracking-wide">
                            {t('launched:membersHeading', { count: (isClash ? clashMemberChips : tagquestMemberChips).length })}
                          </span>
                        </div>
                        {(isClash ? clashMemberChips : tagquestMemberChips).length === 0 ? (
                          <p className="text-xs text-[var(--pg-text-dim)]">{t('launched:noChipsBound')}</p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {(isClash ? clashMemberChips : tagquestMemberChips).map((chipId) => {
                              const label = clanChipLabel(chipId);
                              return (
                                <span key={chipId} className="flex items-center gap-1.5 px-2.5 py-1 bg-[var(--pg-surface-3)] rounded-full text-xs text-[var(--pg-text-muted)]">
                                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                                  {label.name || `Chip ${chipId}`}
                                  <span className="text-[var(--pg-text-dim)] font-mono">#{label.number}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    {showTeammates && (
                      <div className="mb-3 pt-2 border-t border-[var(--pg-line)]">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-1.5 text-xs text-[var(--pg-text-dim)]">
                            <Users size={12} />
                            <span className="font-medium uppercase tracking-wide">{t('launched:teammates')}</span>
                          </div>
                          {addTeammateState?.teamId !== team.id && (
                            <button
                              onClick={() => openAddTeammate(team.id)}
                              className="flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300 transition"
                            >
                              <UserPlus size={12} />
                              {t('launched:add')}
                            </button>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {teammates.map((mate, mi) => (
                            <span key={mi} className="flex items-center gap-1.5 px-2.5 py-1 bg-[var(--pg-surface-3)] rounded-full text-xs text-[var(--pg-text-muted)]">
                              <span className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" />
                              {mate.name}
                              <span className="text-[var(--pg-text-dim)] font-mono">#{mate.chipNumber}</span>
                              <span className="text-[var(--pg-text-dim)] font-mono text-[10px]">{mate.chipId}</span>
                              {mate.chipId !== team.key_id && (
                                <button
                                  onClick={() => handleRemoveTeammate(team.id, mate.chipId, mate.name)}
                                  className="ml-0.5 -mr-0.5 text-[var(--pg-text-dim)] hover:text-red-400 transition"
                                  title={t('launched:removeTeammateTitle')}
                                >
                                  <X size={12} />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                        {addTeammateState?.teamId === team.id && (
                          <div className="mt-2 p-2 bg-[var(--pg-bg)] rounded-lg space-y-2">
                            <input
                              type="text"
                              placeholder={t('launched:teammateNamePlaceholder')}
                              value={addTeammateState.name}
                              onChange={e => setAddTeammateState({ ...addTeammateState, name: e.target.value })}
                              className="pg-input !text-xs !py-1.5"
                            />
                            <select
                              value={addTeammateState.chipId ?? ''}
                              onChange={e => {
                                const id = Number(e.target.value) || null;
                                const chip = allChips.find(c => c.id === id);
                                setAddTeammateState({ ...addTeammateState, chipId: id, name: chip ? chip.key_name : addTeammateState.name });
                              }}
                              className="pg-select !text-xs !py-1.5"
                            >
                              <option value="">{t('launched:selectChip')}</option>
                              {allChips
                                .filter(c => !getUsedChipIds().has(c.id))
                                .map(c => (
                                  <option key={c.id} value={c.id}>
                                    {t('launched:chipOption', { number: c.key_number, name: c.key_name, id: c.id })}
                                  </option>
                                ))}
                            </select>
                            <div className="flex gap-1.5">
                              <button
                                onClick={handleAddTeammate}
                                disabled={savingTeammate || !addTeammateState.name.trim() || addTeammateState.chipId === null}
                                className="flex-1 px-2 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white rounded text-xs font-medium flex items-center justify-center gap-1"
                              >
                                <Save size={11} />
                                {savingTeammate ? t('launched:saving') : t('launched:save')}
                              </button>
                              <button
                                onClick={() => {
                                  const name = pickRandomName();
                                  if (name) setAddTeammateState(s => (s ? { ...s, name } : s));
                                }}
                                disabled={namePoolNames.length === 0}
                                className="px-2 py-1.5 bg-[var(--pg-surface-3)] hover:bg-indigo-600 disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-3)] text-[var(--pg-text)] rounded text-xs flex items-center gap-1"
                                title={namePoolNames.length === 0 ? t('launched:noPooledNames') : t('launched:randomName')}
                              >
                                <Dices size={11} />
                              </button>
                              <button
                                onClick={() => setAddTeammateState(null)}
                                className="px-2 py-1.5 bg-[var(--pg-surface-3)] hover:bg-[var(--pg-surface-2)] text-[var(--pg-text)] rounded text-xs"
                              >
                                <X size={11} />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          if (isClash) {
                            // Clash: clan-management modal (chips + territories) instead
                            // of the quest/enigma TeamDetailsModal.
                            onOpenClashClan({
                              clan: { id: team.id, team_number: team.team_number, team_name: team.team_name },
                              launchedGameId: game.id,
                              reload,
                            });
                          } else {
                            onOpenTeamDetails({
                              team,
                              launchedGameId: game.id,
                              gameUniqid: game.game_uniqid,
                              gameType: game.game_type,
                              chipIds: chipIdsForTeam(team),
                              languages,
                              launchLanguage: nameDrawLang,
                              reload,
                            });
                          }
                        }}
                        className="flex-1 px-3 py-2 bg-[var(--pg-accent)] hover:bg-[var(--pg-accent-hover)] text-white rounded text-sm font-medium flex items-center justify-center gap-1.5"
                        title={t('launched:viewTeamDetails')}
                      >
                        <Eye size={15} />
                        {t('launched:details')}
                      </button>
                      <button
                        onClick={() => handleEndTeam(team)}
                        disabled={!!team.end_time}
                        className="px-3 py-2 bg-[var(--pg-surface-3)] hover:bg-orange-600 text-[var(--pg-text-muted)] hover:text-white rounded text-sm font-medium flex items-center disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-3)] disabled:hover:text-[var(--pg-text-muted)]"
                        title={team.end_time ? t('launched:teamAlreadyEnded') : t('launched:endTeamTitle')}
                      >
                        <StopCircle size={14} />
                      </button>
                      {isAdminMode && (
                        <button
                          onClick={() => onTestTeam({ gameId: game.id, gameName: game.name, team, reload })}
                          className="px-3 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded text-sm font-medium flex items-center gap-1.5"
                          title={t('launched:testThisTeam')}
                        >
                          <FlaskConical size={14} />
                          {t('launched:test')}
                        </button>
                      )}
                      <button
                        onClick={() => onPrintTeam(team.id, team.team_name)}
                        disabled={printing}
                        className="px-3 py-2 bg-[var(--pg-surface-3)] hover:bg-[var(--pg-surface-2)] text-[var(--pg-text-muted)] rounded text-sm font-medium flex items-center disabled:opacity-50"
                        title={t('launched:printTeam')}
                      >
                        <Printer size={14} />
                      </button>
                      {gameTypeHasTeamSummary(game.game_type) && team.end_time ? (
                        <button
                          onClick={() => onShowSummary(team.id)}
                          className="px-3 py-2 bg-[var(--pg-surface-3)] hover:bg-indigo-600 text-[var(--pg-text-muted)] hover:text-white rounded text-sm font-medium flex items-center"
                          title={t('launched:showSummaryOnDevice')}
                        >
                          <MonitorPlay size={14} />
                        </button>
                      ) : null}
                      <button
                        onClick={() => handleRemoveTeam(team)}
                        className="px-3 py-2 bg-[var(--pg-surface-3)] hover:bg-red-600 text-[var(--pg-text-muted)] hover:text-white rounded text-sm font-medium flex items-center"
                        title={t('launched:removeTeamTitle')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </>
                </div>
                )}
              </div>
              );
            })}
          </div>
          )
        )}
        {playMode === 'team' && (
          <div className="mt-4">
            {addTeamState === null ? (
              <button
                onClick={openAddTeam}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 border border-dashed border-[var(--pg-line-strong)] hover:border-teal-500 text-[var(--pg-text-dim)] hover:text-teal-400 rounded-lg text-sm transition"
              >
                <PlusCircle size={15} />
                {t('launched:addTeam')}
              </button>
            ) : (
              <div className="p-3 bg-[var(--pg-surface-2)] border border-[var(--pg-line-strong)] rounded-lg space-y-2">
                <div className="text-xs text-[var(--pg-text-dim)] font-medium uppercase tracking-wide mb-1">{t('launched:newTeam')}</div>
                <input
                  type="text"
                  placeholder={t('launched:teamNamePlaceholder')}
                  value={addTeamState.name}
                  onChange={e => setAddTeamState({ ...addTeamState, name: e.target.value })}
                  className="pg-input !py-1.5"
                />
                <select
                  value={addTeamState.chipId ?? ''}
                  onChange={e => {
                    const id = Number(e.target.value) || null;
                    const chip = allChips.find(c => c.id === id);
                    setAddTeamState({ ...addTeamState, chipId: id, name: chip ? chip.key_name : addTeamState.name });
                  }}
                  className="pg-select !py-1.5"
                >
                  <option value="">{t('launched:selectChip')}</option>
                  {allChips
                    .filter(c => !getUsedChipIds().has(c.id))
                    .map(c => (
                      <option key={c.id} value={c.id}>
                        {t('launched:chipOption', { number: c.key_number, name: c.key_name, id: c.id })}
                      </option>
                    ))}
                </select>
                {tracksRouteOptions.length > 1 && (
                  <select
                    value={addTeamState.route ?? tracksDefaultRoute}
                    onChange={e => setAddTeamState({ ...addTeamState, route: e.target.value })}
                    className="pg-select !py-1.5"
                    title={t('launched:routeSelectTitle')}
                  >
                    {tracksRouteOptions.map(r => (
                      <option key={r} value={r}>
                        {t(`launched:trackRoute_${r}`, { defaultValue: TRACKS_ROUTE_LABELS[r] ?? r })}
                      </option>
                    ))}
                  </select>
                )}
                {languages.length >= 2 && (
                  <div className="flex items-center gap-2">
                    <select
                      value={addTeamState.language ?? nameDrawLang}
                      onChange={e => setAddTeamState({ ...addTeamState, language: e.target.value })}
                      className="pg-select flex-1 min-w-0 !py-1.5"
                      title={t('launched:languageSelectTitle')}
                    >
                      {languages.map(l => (
                        <option key={l} value={l}>
                          {LANG_NAMES[l] ?? l}
                        </option>
                      ))}
                    </select>
                    <HelpDot topic="team.language" align="right" />
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleAddTeam}
                    disabled={savingTeam || !addTeamState.name.trim() || addTeamState.chipId === null}
                    className="flex-1 px-3 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white rounded text-sm font-medium flex items-center justify-center gap-1.5"
                  >
                    <Save size={13} />
                    {savingTeam ? t('launched:saving') : t('launched:saveTeam')}
                  </button>
                  <button
                    onClick={() => {
                      const name = pickRandomName();
                      if (name) setAddTeamState(s => (s ? { ...s, name } : s));
                    }}
                    disabled={namePoolNames.length === 0}
                    className="px-3 py-1.5 bg-[var(--pg-surface-3)] hover:bg-indigo-600 disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-3)] text-[var(--pg-text)] rounded text-sm flex items-center gap-1.5"
                    title={namePoolNames.length === 0 ? t('launched:noPooledNames') : t('launched:randomName')}
                  >
                    <Dices size={13} />
                    {t('launched:randomName')}
                  </button>
                  <button
                    onClick={() => setAddTeamState(null)}
                    className="px-3 py-1.5 bg-[var(--pg-surface-3)] hover:bg-[var(--pg-surface-2)] text-[var(--pg-text)] rounded text-sm"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
