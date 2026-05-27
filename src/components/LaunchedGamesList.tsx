import { useState, useEffect } from 'react';
import { Play, Trash2, Users, Save, Clock, CheckCircle, Flag, Trophy, Gamepad2, Search, ArrowUpDown, Import as SortAsc, Minimize2, Maximize2, Monitor, StopCircle, Settings, FlaskConical, UserPlus, PlusCircle, X, BarChart2, RefreshCw, ExternalLink, Database, Archive, Dices } from 'lucide-react';
import { GamePage } from './GamePage';
import { useAuth } from './auth/AuthProvider';
import * as cardsStore from '../services/cardsStore';
import * as cardsRepo from '../services/cardsRepo';
import * as scenarioStore from '../services/scenarioStore';
import * as namePoolsStore from '../services/namePoolsStore';
import {
  listLaunchedGames,
  getLaunchedGameMeta,
  updateLaunchedGameMeta,
  mergeLaunchedGameMeta,
  getLaunchedGameState,
  endLaunchedGame,
  deleteLaunchedGame,
  archiveLaunchedGame,
  listArchivedSummaries,
  type GameSummaryRow,
  updateTeam,
  addTeamToLaunchedGame,
  deleteTeam,
  listCompletedQuests,
  registerDeviceForGame,
} from '../services/launchedGames';
import { GameDevicesModal } from './GameDevicesModal';
import { RawDataModal } from './RawDataModal';
import { onPendingJoin } from '../services/pendingJoinStore';
import { ApiError } from '../services/api';
import { ConfirmDialog } from './ConfirmDialog';
import { LaunchedGameConfigModal } from './LaunchedGameConfigModal';
import { GameTestModal } from './GameTestModal';
import { TeamTestModal } from './TeamTestModal';
import { TeamDetailsModal } from './TeamDetailsModal';
import { LeaderboardPage } from './LeaderboardPage';
import { RankingsModal } from './RankingsModal';
import { TimeRangeLeaderboard } from './TimeRangeLeaderboard';
import { MultiGameLeaderboard } from './MultiGameLeaderboard';
import type { ScenarioOption, TimeRange, ActiveGameOption } from './RankingsModal';
import type { GameConfig, Team as ConfigTeam, Teammate } from './LaunchGameModal';
import type { SiPuce } from '../types/database';

// Tracks route keys → operator-facing labels (Add Team per-team route override).
const TRACKS_ROUTE_LABELS: Record<string, string> = {
  default: 'Default (all checkpoints)',
  first_half: 'First half',
  last_half: 'Last half',
  odd: 'Odd checkpoints',
  even: 'Even checkpoints',
};

interface LaunchedGame {
  id: number;
  game_uniqid: string;
  name: string;
  number_of_teams: number;
  game_type: string;
  ended: boolean;
  created_at: string;
  is_test: boolean;
}

interface GameData {
  game: {
    uniqid: string;
    title: string;
    type: string;
  };
}

interface Team {
  id: number;
  team_number: number;
  team_name: string;
  score: number;
  start_time: number | null;
  end_time: number | null;
  key_id: number;
  currentLevel?: { level: number; name: string } | null;
}

// Game-type → display label + pill colors for the launched-game card badge.
// launched_games stores game_type capitalised ('TagQuest'); we key off the
// lowercase slug so either casing (and the scenario gameDataMap fallback) works.
const GAME_TYPE_BADGE: Record<string, { label: string; className: string }> = {
  tagquest: { label: 'TagQuest', className: 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300' },
  mystery: { label: 'Mystery', className: 'bg-purple-500/15 border-purple-500/40 text-purple-300' },
  tracks: { label: 'Tracks', className: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' },
};

function gameTypeBadge(raw: string): { label: string; className: string } {
  const key = (raw || '').toLowerCase();
  return (
    GAME_TYPE_BADGE[key] ?? {
      label: raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Unknown',
      className: 'bg-slate-600/40 border-slate-500/50 text-slate-300',
    }
  );
}

// Fold a scenario's game_public onto the canonical name-pool audience trio
// (mirrors LaunchGameModal's normalizeGamePublic / studio src/types/audience.ts).
function normalizeAudience(raw: unknown): string {
  const v = String(raw ?? '').toLowerCase();
  if (['adults', 'adult', 'adultes', 'teens', 'ado'].includes(v)) return 'ado_adultes';
  if (v === 'mini_kids' || v === 'ado_adultes') return v;
  return 'kids';
}

export function LaunchedGamesList({ isAdminMode = false }: { isAdminMode?: boolean }) {
  const { user } = useAuth();
  const [games, setGames] = useState<LaunchedGame[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [refreshingTeams, setRefreshingTeams] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingTeamId, setEditingTeamId] = useState<number | null>(null);
  const [editedTeam, setEditedTeam] = useState<Partial<Team>>({});
  const [renamingTeamId, setRenamingTeamId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [gameDataMap, setGameDataMap] = useState<Record<string, GameData>>({});
  const [showRankings, setShowRankings] = useState<number | null>(null);
  const [rankingsGameName, setRankingsGameName] = useState<string>('');
  const [rankingsConfig, setRankingsConfig] = useState<GameConfig | null>(null);
  const [rankings, setRankings] = useState<Team[]>([]);
  const [rankingPageGame, setRankingPageGame] = useState<{ launchedGameId: number; gameName: string; config: GameConfig } | null>(null);
  const [playingGame, setPlayingGame] = useState<{ config: GameConfig; uniqid: string; launchedGameId: number } | null>(null);
  const [teamSearch, setTeamSearch] = useState('');
  const [teamSortBy, setTeamSortBy] = useState<'ranking' | 'name'>('ranking');
  const [minimizedTeams, setMinimizedTeams] = useState<Set<number>>(new Set());
  const [showDevices, setShowDevices] = useState<number | null>(null);
  const [showRawData, setShowRawData] = useState<{ id: number; name: string } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant: 'danger' | 'warning' | 'info';
    confirmText?: string;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    variant: 'warning',
  });
  const [configGameId, setConfigGameId] = useState<number | null>(null);
  const [configGameName, setConfigGameName] = useState<string>('');
  const [testGameId, setTestGameId] = useState<number | null>(null);
  const [testGameName, setTestGameName] = useState<string>('');
  const [testTeam, setTestTeam] = useState<{ gameId: number; gameName: string; team: Team } | null>(null);
  const [selectedGamePlayMode, setSelectedGamePlayMode] = useState<'solo' | 'team' | null>(null);
  const [selectedGameTeamsConfig, setSelectedGameTeamsConfig] = useState<ConfigTeam[]>([]);
  const [allChips, setAllChips] = useState<SiPuce[]>([]);
  const [addTeammateState, setAddTeammateState] = useState<{ teamId: number; chipId: number | null; name: string } | null>(null);
  const [addTeamState, setAddTeamState] = useState<{ name: string; chipId: number | null; route?: string } | null>(null);
  // Tracks: enabled route set + launch default route (from launch meta), so the
  // Add Team form can offer a per-team route override (manual assignment only).
  const [tracksRouteOptions, setTracksRouteOptions] = useState<string[]>([]);
  const [tracksDefaultRoute, setTracksDefaultRoute] = useState<string>('default');
  // Name-pool draw context for the manual "Random name" button: the scenario's
  // audience + language (from launch meta) and the resolved candidate names.
  const [nameDrawAudience, setNameDrawAudience] = useState<string>('kids');
  const [nameDrawLang, setNameDrawLang] = useState<string>('en');
  const [namePoolNames, setNamePoolNames] = useState<string[]>([]);
  const [savingTeammate, setSavingTeammate] = useState(false);
  const [savingTeam, setSavingTeam] = useState(false);
  const [teamDetails, setTeamDetails] = useState<{ team: Team; gameUniqid: string; gameType: string } | null>(null);
  const [showRankingsModal, setShowRankingsModal] = useState(false);
  const [timeRangePage, setTimeRangePage] = useState<{ scenario: ScenarioOption; timeRange: TimeRange } | null>(null);
  const [activeGamesPage, setActiveGamesPage] = useState<ActiveGameOption[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedSummaries, setArchivedSummaries] = useState<GameSummaryRow[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);

  useEffect(() => {
    loadGames();
    const loadChips = async () => {
      if (!user) return;
      try {
        const rows = await cardsRepo.list();
        const regularChips: SiPuce[] = rows.map((r) => ({
          id: r.id,
          key_number: r.key_number,
          key_name: r.key_name,
          color: r.color,
          created_at: '',
          updated_at: '',
        }));
        const onDemandJson = await cardsStore.getOnDemandCardsJson();
        const onDemandRecords = (onDemandJson as { cards?: Array<{ id?: number; key_number: number; key_name: string; color?: string | null }> } | null)?.cards ?? [];
        const onDemandMapped: SiPuce[] = onDemandRecords.map((c) => ({
          id: c.id ?? c.key_number,
          key_number: c.key_number,
          key_name: c.key_name,
          color: c.color ?? null,
          created_at: '',
          updated_at: '',
        }));
        const all = [...regularChips, ...onDemandMapped].sort((a, b) => a.key_number - b.key_number);
        setAllChips(all);
      } catch (err) {
        console.error('[LaunchedGamesList] failed to load chips:', err);
      }
    };
    loadChips();
  }, [user]);

  useEffect(() => {
    if (games.length > 0) {
      loadGameData();
    }
  }, [games]);

  useEffect(() => {
    if (selectedGameId !== null) {
      loadTeams(selectedGameId);
      setTeamSearch('');
      setMinimizedTeams(new Set());
      setSelectedGamePlayMode(null);
      setSelectedGameTeamsConfig([]);
      setNameDrawAudience('kids');
      setNameDrawLang('en');
      setTracksRouteOptions([]);
      setTracksDefaultRoute('default');
      getLaunchedGameMeta(selectedGameId)
        .then(async (map) => {
          if (map.playMode === 'solo' || map.playMode === 'team') {
            setSelectedGamePlayMode(map.playMode);
          }
          // Tracks per-team route options (persisted at launch).
          if (map.tracks_routes) {
            setTracksRouteOptions(map.tracks_routes.split(',').map((s) => s.trim()).filter(Boolean));
          }
          if (map.route) setTracksDefaultRoute(map.route);
          if (map.teamsConfig) {
            try { setSelectedGameTeamsConfig(JSON.parse(map.teamsConfig)); } catch { /* swallow */ }
          }
          // Name-pool draw context. namePoolAudience + language are persisted by
          // the launch modal; for older games predating that, fall back to the
          // scenario's game_meta.game_public (language falls back in the store).
          let audienceRaw: unknown = map.namePoolAudience;
          const lang = map.language;
          if (!audienceRaw) {
            const game = games.find((g) => g.id === selectedGameId);
            if (game) {
              try {
                const gd = (await scenarioStore.getGameData(game.game_uniqid)) as any;
                audienceRaw = (gd?.game_data?.game_meta ?? gd?.game_meta)?.game_public;
              } catch { /* swallow — defaults to 'kids' */ }
            }
          }
          setNameDrawAudience(normalizeAudience(audienceRaw));
          setNameDrawLang((lang || 'en').toLowerCase());
        })
        .catch((err) => console.error('[LaunchedGamesList] meta load failed:', err));
    }
  }, [selectedGameId]);

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

  const loadGames = async () => {
    setLoading(true);
    try {
      const rows = await listLaunchedGames();
      // Server returns ended as 0/1 int; LaunchedGame interface expects boolean.
      const normalized = rows.map((g) => ({
        id: g.id,
        game_uniqid: g.game_uniqid,
        name: g.name,
        number_of_teams: g.number_of_teams ?? 0,
        game_type: g.game_type,
        ended: Boolean(g.ended),
        created_at: g.created_at ?? '',
        is_test: Boolean(g.is_test),
      }));
      setGames(normalized);
    } catch (err) {
      console.error('Error loading launched games:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadTeams = async (gameId: number) => {
    let teamsData: Team[] = [];
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
      console.warn('[LaunchedGamesList] completed quests fetch failed:', err);
    }

    const scoreByTeam: Record<number, number> = {};
    const questCountByTeam: Record<number, Record<string, number>> = {};
    for (const row of questRows) {
      scoreByTeam[row.team_id] = (scoreByTeam[row.team_id] ?? 0) + (row.points_awarded ?? 0);
      if (!questCountByTeam[row.team_id]) questCountByTeam[row.team_id] = {};
      questCountByTeam[row.team_id][row.quest_number] = (questCountByTeam[row.team_id][row.quest_number] ?? 0) + 1;
    }

    const game = games.find(g => g.id === gameId);
    let pts6 = 0, pts4 = 0, pts2 = 0;
    let gameLevels: Record<string, { name: string | null; points: string | null }> | null = null;
    if (game?.game_uniqid) {
      try {
        // Slice 2: scenario game-data.json comes from the local SQLite/FS store.
        const gameDataJson = (await scenarioStore.getGameData(game.game_uniqid)) as any;
        const gameMeta = gameDataJson?.game_data?.game_meta ?? gameDataJson?.game_meta;
        const parseVal = (v: any) => (v === undefined || v === null) ? 0 : (typeof v === 'string' ? parseInt(v, 10) || 0 : v);
        pts6 = parseVal(gameMeta?.combo_6_quests);
        pts4 = parseVal(gameMeta?.combo_4_quests);
        pts2 = parseVal(gameMeta?.combo_2_quests);
        gameLevels = gameMeta?.levels ?? null;
      } catch { /* swallow — combos default to 0 */ }
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

    const computeCombosForTeam = (countMap: Record<string, number>): number => {
      if (pts6 === 0 && pts4 === 0 && pts2 === 0) return 0;
      const counts = new Map(Object.entries(countMap));
      let bonus = 0;

      while ([...counts.values()].every(v => v > 0) && counts.size >= 6) {
        bonus += pts6;
        for (const key of counts.keys()) counts.set(key, counts.get(key)! - 1);
      }

      while (true) {
        const nonZero = [...counts.entries()].filter(([, v]) => v > 0);
        if (nonZero.length < 4) break;
        bonus += pts4;
        for (const [key] of nonZero.slice(0, 4)) counts.set(key, counts.get(key)! - 1);
      }

      while (true) {
        const nonZero = [...counts.entries()].filter(([, v]) => v > 0);
        if (nonZero.length < 2) break;
        bonus += pts2;
        for (const [key] of nonZero.slice(0, 2)) counts.set(key, counts.get(key)! - 1);
      }

      return bonus;
    };

    const enriched = teamsData.map(t => {
      const questScore = scoreByTeam[t.id] ?? 0;
      const comboBonus = computeCombosForTeam(questCountByTeam[t.id] ?? {});
      const totalScore = questScore + comboBonus;
      return { ...t, score: totalScore, currentLevel: computeLevelForScore(totalScore) };
    });

    setTeams(enriched);
  };

  const loadGameData = async () => {
    // Slice 3: game-data.json now comes from slice-2's local FS for any
    // scenario the user has downloaded. For game_uniqids we never downloaded
    // (e.g., a scenario referenced by a historical launched_game that was
    // since removed), fall back to the row title from scenarioStore — there's
    // no longer a remote scenarios endpoint to query.
    try {
      const uniqueUniqids = [...new Set(games.map((g) => g.game_uniqid))];
      const dataMap: Record<string, GameData> = {};
      for (const uniqid of uniqueUniqids) {
        try {
          const gd = (await scenarioStore.getGameData(uniqid)) as any;
          const title = gd?.game?.title ?? gd?.scenario?.title ?? gd?.title ?? null;
          const type = gd?.game?.type ?? gd?.scenario?.game_type ?? gd?.game_type ?? '';
          if (title) {
            dataMap[uniqid] = { game: { uniqid, title, type } };
            continue;
          }
          const row = await scenarioStore.get(uniqid);
          if (row) {
            dataMap[uniqid] = { game: { uniqid, title: row.title, type: row.game_type } };
          }
        } catch (err) {
          console.warn(`[LaunchedGamesList] game-data lookup failed for ${uniqid}:`, err);
        }
      }
      setGameDataMap(dataMap);
    } catch (error) {
      console.error('Error loading game data:', error);
    }
  };

  const handleEndGame = async (gameId: number) => {
    setConfirmDialog({
      isOpen: true,
      title: 'End Game',
      message: 'Are you sure you want to end this game? This action will mark the game as completed.',
      variant: 'warning',
      confirmText: 'End Game',
      onConfirm: () => {
        // Close the dialog and flip the optimistic ended flag synchronously
        // so the badge + button set update immediately. end_game on the
        // server only sets ended=1 (teams untouched), so no team refetch.
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        const snapshot = games;
        setGames((prev) => prev.map((g) => (g.id === gameId ? { ...g, ended: true } : g)));

        (async () => {
          try {
            await endLaunchedGame(gameId);
          } catch (err) {
            // 404 → row gone (deleted elsewhere); treat as success since the
            // user's "no longer active" intent still holds.
            if (err instanceof ApiError && err.status === 404) {
              return;
            }
            console.error('Error ending game:', err);
            setGames(snapshot);
            alert('Failed to end game');
          }
        })();
      },
    });
  };

  const handleDeleteGame = async (gameId: number) => {
    setConfirmDialog({
      isOpen: true,
      title: 'Delete Game',
      message: 'Are you sure you want to delete this game? This will permanently remove the game and all associated data (teams, devices, configuration). This action cannot be undone.',
      variant: 'danger',
      confirmText: 'Delete Game',
      onConfirm: () => {
        // Close the dialog and update local state synchronously so the UI
        // doesn't sit on a spinner during the cascade DELETE + any retries.
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        const snapshot = games;
        setGames((prev) => prev.filter((g) => g.id !== gameId));
        if (selectedGameId === gameId) {
          setSelectedGameId(null);
          setTeams([]);
        }

        // Fire and forget. Server-side FK ON DELETE CASCADE handles meta +
        // devices + teams + raw_data. If withRetry's first attempt succeeded
        // but the response was slow/5xx, the second attempt sees a 404 (row
        // already gone) — that's the desired end state, not an error.
        (async () => {
          try {
            await deleteLaunchedGame(gameId);
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              return;
            }
            console.error('Error deleting game:', err);
            setGames(snapshot);
            alert('Failed to delete game');
          }
        })();
      },
    });
  };

  const handleArchiveGame = async (gameId: number) => {
    setConfirmDialog({
      isOpen: true,
      title: 'Archive Game',
      message: 'Archiving keeps only this game’s statistics summary and permanently deletes its detailed data (teams, punches, devices, configuration). The summary stays available in the Archived view and in Studio. Continue?',
      variant: 'warning',
      confirmText: 'Archive Game',
      onConfirm: () => {
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        const snapshot = games;
        setGames((prev) => prev.filter((g) => g.id !== gameId));
        if (selectedGameId === gameId) {
          setSelectedGameId(null);
          setTeams([]);
        }
        (async () => {
          try {
            await archiveLaunchedGame(gameId);
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              return;
            }
            console.error('Error archiving game:', err);
            setGames(snapshot);
            alert('Failed to archive game');
          }
        })();
      },
    });
  };

  const openArchived = async () => {
    setShowArchived(true);
    setArchivedLoading(true);
    try {
      setArchivedSummaries(await listArchivedSummaries());
    } catch (err) {
      console.error('[LaunchedGamesList] failed to load archived summaries:', err);
      setArchivedSummaries([]);
    } finally {
      setArchivedLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const formatTime = (timestamp: number | null) => {
    if (!timestamp) return 'Not started';
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  };

  const formatTimeForInput = (timestamp: number | null) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
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
    return now.getTime();
  };

  const handleEditTeam = (team: Team) => {
    setEditingTeamId(team.id);
    setEditedTeam({
      team_name: team.team_name,
      score: team.score,
      start_time: team.start_time,
      end_time: team.end_time,
    });
  };

  const handleCancelEdit = () => {
    setEditingTeamId(null);
    setEditedTeam({});
  };

  const handleSaveTeam = async (teamId: number) => {
    try {
      const fields: Parameters<typeof updateTeam>[1] = {};
      if (editedTeam.team_name !== undefined) fields.team_name = editedTeam.team_name ?? null;
      if (editedTeam.score !== undefined) fields.score = editedTeam.score;
      if (editedTeam.start_time !== undefined) fields.start_time = editedTeam.start_time ?? null;
      if (editedTeam.end_time !== undefined) fields.end_time = editedTeam.end_time ?? null;
      await updateTeam(teamId, fields);
      setEditingTeamId(null);
      setEditedTeam({});
      if (selectedGameId !== null) loadTeams(selectedGameId);
    } catch (err) {
      console.error('Error updating team:', err);
      alert('Failed to update team');
    }
  };

  const handleRenameTeam = async (teamId: number) => {
    const name = renameValue.trim();
    if (!name) { setRenamingTeamId(null); return; }
    try {
      await updateTeam(teamId, { team_name: name });
      if (selectedGameId !== null) loadTeams(selectedGameId);
    } catch (err) {
      console.error('Error renaming team:', err);
    }
    setRenamingTeamId(null);
    setRenameValue('');
  };

  // All chips on a team (leader + teammates) from the launch config — the
  // Team Details punch tab needs them all, since in team mode members punch
  // with their own chip, not the leader's key_id.
  const chipIdsForTeam = (t: Team): number[] => {
    const cfg = selectedGameTeamsConfig.find(c => c.chipId === t.key_id || c.name === t.team_name);
    const ids = cfg ? [cfg.chipId, ...(cfg.teammates ?? []).map(m => m.chipId)] : [t.key_id];
    return [...new Set(ids.filter((x): x is number => x != null))];
  };

  const getUsedChipIds = (): Set<number> => {
    const used = new Set<number>();
    selectedGameTeamsConfig.forEach(t => {
      used.add(t.chipId);
      t.teammates?.forEach(m => used.add(m.chipId));
    });
    teams.forEach(t => used.add(t.key_id));
    return used;
  };

  // The first card not already assigned to a team/teammate — used to preselect
  // a chip (and seed the name from its key_name) when opening an add form.
  const firstFreeChip = (): SiPuce | undefined => {
    const used = getUsedChipIds();
    return allChips.find(c => !used.has(c.id));
  };

  // Names already in use across teams + teammates, so the random draw can avoid
  // handing out a duplicate.
  const usedNames = (): string[] => {
    const names = teams.map(t => t.team_name);
    selectedGameTeamsConfig.forEach(t => {
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
    setAddTeamState({ chipId: chip?.id ?? null, name: chip?.key_name ?? '', route: tracksDefaultRoute });
  };

  const openAddTeammate = (teamId: number) => {
    const chip = firstFreeChip();
    setAddTeammateState({ teamId, chipId: chip?.id ?? null, name: chip?.key_name ?? '' });
  };

  const persistTeamsConfig = async (updated: ConfigTeam[]) => {
    if (!selectedGameId) return;
    setSelectedGameTeamsConfig(updated);
    try {
      // Read-modify-write: update_meta replaces the whole bag, so we need
      // the full current set, not just teamsConfig.
      const current = await getLaunchedGameMeta(selectedGameId);
      const next = { ...current, teamsConfig: JSON.stringify(updated) };
      await updateLaunchedGameMeta(selectedGameId, next);
    } catch (err) {
      console.error('[LaunchedGamesList] persistTeamsConfig failed:', err);
    }
  };

  const handleAddTeammate = async () => {
    if (!addTeammateState || addTeammateState.chipId === null || !addTeammateState.name.trim() || !selectedGameId) return;
    setSavingTeammate(true);
    const chip = allChips.find(c => c.id === addTeammateState.chipId);
    if (!chip) { setSavingTeammate(false); return; }

    const newMate: Teammate = {
      chipId: chip.id,
      chipNumber: chip.key_number,
      name: addTeammateState.name.trim(),
    };

    const updated = selectedGameTeamsConfig.map(t => {
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
    if (!addTeamState || addTeamState.chipId === null || !addTeamState.name.trim() || !selectedGameId) return;
    setSavingTeam(true);
    const chip = allChips.find(c => c.id === addTeamState.chipId);
    if (!chip) { setSavingTeam(false); return; }

    const nextTeamNumber = (teams.length > 0 ? Math.max(...teams.map(t => t.team_number)) : 0) + 1;

    const chosenRoute = addTeamState.route;
    try {
      const { id: newTeamId } = await addTeamToLaunchedGame({
        launched_game_id: selectedGameId,
        team_number: nextTeamNumber,
        team_name: addTeamState.name.trim(),
        pattern: 0,
        key_id: chip.id,
      });
      // Persist a per-team route override only when it differs from the launch
      // default (the runtime falls back to the default when no override exists).
      if (chosenRoute && chosenRoute !== tracksDefaultRoute && tracksRouteOptions.length > 1) {
        await mergeLaunchedGameMeta(selectedGameId, { [`route:${newTeamId}`]: chosenRoute });
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

    const updated = [...selectedGameTeamsConfig, newConfigTeam];
    await persistTeamsConfig(updated);
    await loadTeams(selectedGameId);
    setAddTeamState(null);
    setSavingTeam(false);
  };

  // Remove one (non-leader) teammate from a team. Teammates live only in
  // meta.teamsConfig, so this is a config edit — no DB team row involved.
  const handleRemoveTeammate = (teamId: number, teammateChipId: number, teammateName: string) => {
    setConfirmDialog({
      isOpen: true,
      title: 'Remove Teammate',
      message: `Remove "${teammateName}" from this team?`,
      variant: 'warning',
      confirmText: 'Remove',
      onConfirm: async () => {
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        const t = teams.find(tm => tm.id === teamId);
        const updated = selectedGameTeamsConfig.map(ct => {
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
  const handleRemoveTeam = (team: Team) => {
    setConfirmDialog({
      isOpen: true,
      title: 'Remove Team',
      message: `Remove "${team.team_name}" from this game? Its completions will be permanently deleted. This cannot be undone.`,
      variant: 'danger',
      confirmText: 'Remove Team',
      onConfirm: async () => {
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        try {
          await deleteTeam(team.id);
          const updated = selectedGameTeamsConfig.filter(
            ct => !(ct.chipId === team.key_id || ct.name === team.team_name)
          );
          await persistTeamsConfig(updated);
        } catch (err) {
          console.error('[LaunchedGamesList] removeTeam failed:', err);
        }
        if (selectedGameId !== null) loadTeams(selectedGameId);
      },
    });
  };

  const handleShowRankings = async (gameId: number, gameName: string) => {
    let teamsForRankings: Team[] = [];
    let metaMap: Record<string, string> = {};
    try {
      const [state, meta] = await Promise.all([
        getLaunchedGameState(gameId, 0),
        getLaunchedGameMeta(gameId),
      ]);
      teamsForRankings = state.teams.map((t) => ({
        id: t.id,
        team_number: t.team_number,
        team_name: t.team_name ?? '',
        score: t.score,
        start_time: t.start_time,
        end_time: t.end_time,
        key_id: t.key_id ?? 0,
      })).sort((a, b) => b.score - a.score);
      metaMap = meta;
    } catch (err) {
      console.error('Error loading rankings:', err);
      return;
    }

    const config: GameConfig = {
      name: gameName,
      numberOfTeams: parseInt(metaMap.numberOfTeams || '0'),
      firstChipIndex: parseInt(metaMap.firstChipIndex || '1'),
      pattern: metaMap.pattern || '',
      duration: parseInt(metaMap.duration || '0'),
      messageDisplayDuration: parseInt(metaMap.messageDisplayDuration || '5'),
      enigmaImageDisplayDuration: parseInt(metaMap.enigmaImageDisplayDuration || '1'),
      colorblindMode: metaMap.colorblindMode === 'true',
      autoResetTeam: metaMap.autoResetTeam === 'true',
      delayBeforeReset: parseInt(metaMap.delayBeforeReset || '2'),
      autoRegisterTeam: metaMap.autoRegisterTeam === 'true',
      reuseCards: metaMap.reuseCards === 'true',
      selfRegisterTeam: metaMap.selfRegisterTeam === 'true',
      reuseDelayMinutes: parseInt(metaMap.reuseDelayMinutes || '5'),
      testMode: metaMap.testMode === 'true',
      victoryType: (metaMap.victoryType as 'speed' | 'score') || undefined,
      playMode: (metaMap.playMode as 'solo' | 'team') || undefined,
    };

    setRankings(teamsForRankings);
    setRankingsGameName(gameName);
    setRankingsConfig(config);
    setShowRankings(gameId);
  };

  const handleShowDevices = (gameId: number) => {
    // The shared <GameDevicesModal> handles its own fetch + 2s polling. We
    // just open it pointed at the right launched_game.
    setShowDevices(gameId);
  };

  const handlePlayGame = async (game: LaunchedGame) => {
    let metaMap: Record<string, string> = {};
    try {
      metaMap = await getLaunchedGameMeta(game.id);
    } catch (err) {
      console.error('Error loading game meta:', err);
      return;
    }
    const config: GameConfig = {
      name: game.name,
      numberOfTeams: game.number_of_teams,
      firstChipIndex: parseInt(metaMap.firstChipIndex || '1'),
      pattern: metaMap.pattern || '',
      duration: parseInt(metaMap.duration || '0'),
      messageDisplayDuration: parseInt(metaMap.messageDisplayDuration || '5'),
      enigmaImageDisplayDuration: parseInt(metaMap.enigmaImageDisplayDuration || '1'),
      colorblindMode: metaMap.colorblindMode === 'true',
      autoResetTeam: metaMap.autoResetTeam === 'true',
      delayBeforeReset: parseInt(metaMap.delayBeforeReset || '2'),
      revealResultsOnInput: metaMap.revealResultsOnInput !== 'false',
      autoRegisterTeam: metaMap.autoRegisterTeam === 'true',
      reuseCards: metaMap.reuseCards === 'true',
      selfRegisterTeam: metaMap.selfRegisterTeam === 'true',
      reuseDelayMinutes: parseInt(metaMap.reuseDelayMinutes || '5'),
      visibilityHideDelaySec: parseInt(metaMap.visibilityHideDelaySec || '10'),
      testMode: metaMap.testMode === 'true',
      victoryType: (metaMap.victoryType as 'speed' | 'score') || undefined,
      playMode: (metaMap.playMode as 'solo' | 'team') || undefined,
    };

    setPlayingGame({ config, uniqid: game.game_uniqid, launchedGameId: game.id });
  };

  // Drive into a launched game by id alone — used by the mother → satellite
  // join_game push. Looks the game up in the cached list (refetching if not
  // present), registers the satellite with the mother, then mounts GamePage.
  const playGameById = async (launchedGameId: number) => {
    let game = games.find(g => g.id === launchedGameId);
    if (!game) {
      // The active list may be stale (e.g. mother created the game seconds ago).
      try {
        const fresh = await listLaunchedGames({ ended: false });
        // Normalize to the local LaunchedGame shape (boolean ended, defaulted
        // number_of_teams) — same as the initial loadGames() path.
        const normalized: LaunchedGame[] = fresh.map((g) => ({
          id: g.id,
          game_uniqid: g.game_uniqid,
          name: g.name,
          number_of_teams: g.number_of_teams ?? 0,
          game_type: g.game_type,
          ended: Boolean(g.ended),
          created_at: g.created_at ?? '',
        }));
        setGames(normalized);
        game = normalized.find(g => g.id === launchedGameId);
      } catch (err) {
        console.error('[LaunchedGamesList] playGameById refresh failed:', err);
        return;
      }
    }
    if (!game) {
      console.warn('[LaunchedGamesList] playGameById: launched_game not found', launchedGameId);
      return;
    }
    // Register the satellite as a participating device BEFORE entering
    // GamePage, so the mother's modal sees the row migrate B → A on its
    // next 2s poll without waiting for the satellite to take any action.
    try {
      await registerDeviceForGame(launchedGameId);
    } catch (err) {
      console.warn('[LaunchedGamesList] registerDeviceForGame failed:', err);
    }
    await handlePlayGame(game);
  };

  useEffect(() => {
    return onPendingJoin((launchedGameId) => {
      void playGameById(launchedGameId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games]);

  const getFilteredAndSortedTeams = () => {
    let filtered = teams;

    if (teamSearch) {
      const q = teamSearch.toLowerCase();
      filtered = filtered.filter(team => {
        if (
          team.team_name.toLowerCase().includes(q) ||
          team.key_id.toString().includes(q)
        ) return true;
        const configTeam = selectedGameTeamsConfig.find(t => t.chipId === team.key_id || t.name === team.team_name);
        if (configTeam?.teammates?.some(m => m.name.toLowerCase().includes(q))) return true;
        return false;
      });
    }

    const sorted = [...filtered].sort((a, b) => {
      if (teamSortBy === 'ranking') {
        return b.score - a.score;
      } else {
        return a.team_name.localeCompare(b.team_name);
      }
    });

    return sorted;
  };

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

  if (playingGame) {
    return (
      <GamePage
        config={playingGame.config}
        gameUniqid={playingGame.uniqid}
        launchedGameId={playingGame.launchedGameId}
        onBack={() => setPlayingGame(null)}
      />
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-white text-xl">Loading launched games...</div>
      </div>
    );
  }


  return (
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-bold text-white">Launched Games</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowRankingsModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-yellow-500/15 hover:bg-yellow-500/25 border border-yellow-500/30 hover:border-yellow-400/50 text-yellow-400 font-semibold text-sm rounded-xl transition-all"
          >
            <Trophy size={16} />
            Rankings
          </button>
          <button
            onClick={() => void openArchived()}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 hover:border-indigo-400/50 text-indigo-300 font-semibold text-sm rounded-xl transition-all"
          >
            <Archive size={16} />
            Archived
          </button>
        </div>
      </div>

      {games.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-400 text-lg">No games have been launched yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            {games.map((game) => {
              const typeBadge = gameTypeBadge(game.game_type || gameDataMap[game.game_uniqid]?.game?.type || '');
              return (
              <div
                key={game.id}
                className={`p-6 rounded-lg border-2 transition cursor-pointer ${
                  selectedGameId === game.id
                    ? 'bg-blue-900/30 border-blue-500'
                    : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
                } ${!game.ended ? 'ring-2 ring-green-500/50' : ''}`}
                onClick={() => setSelectedGameId(game.id)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-xl font-bold text-white mb-1">{game.name}</h3>
                    {gameDataMap[game.game_uniqid] ? (
                      <p className="text-sm text-blue-400 mb-1">Scenario: {gameDataMap[game.game_uniqid].game.title}</p>
                    ) : (
                      <p className="text-sm text-slate-400 mb-1">Scenario: {game.game_uniqid}</p>
                    )}
                    <p className="text-sm text-slate-400">Game ID: {game.id}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-semibold border ${typeBadge.className}`}
                      title="Game type"
                    >
                      {typeBadge.label}
                    </span>
                    {game.ended ? (
                      <span className="px-3 py-1 bg-slate-700 text-slate-300 rounded-full text-xs font-semibold flex items-center gap-1">
                        <StopCircle size={12} />
                        Ended
                      </span>
                    ) : (
                      <span className="px-3 py-1 bg-green-600 text-white rounded-full text-xs font-semibold flex items-center gap-1">
                        <Play size={12} />
                        Active
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-sm text-slate-400 mb-4">
                  Created: {formatDate(game.created_at)}
                </div>

                <div className="flex gap-2 flex-wrap">
                  {!game.ended && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePlayGame(game);
                      }}
                      className="p-2 bg-green-600 hover:bg-green-500 text-white rounded-lg transition"
                      title="Play Game"
                    >
                      <Gamepad2 size={18} />
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfigGameId(game.id);
                      setConfigGameName(game.name);
                    }}
                    className="p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition"
                    title="Configure"
                  >
                    <Settings size={18} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setTestGameId(game.id);
                      setTestGameName(game.name);
                    }}
                    className="p-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition"
                    title="Run Game Test"
                  >
                    <FlaskConical size={18} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleShowRankings(game.id, game.name);
                    }}
                    className="p-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition"
                    title="Rankings"
                  >
                    <Trophy size={18} />
                  </button>
                  {game.ended && !game.is_test && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleArchiveGame(game.id);
                      }}
                      className="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition"
                      title="Archive (keep summary, delete game data)"
                    >
                      <Archive size={18} />
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleShowDevices(game.id);
                    }}
                    className="p-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition"
                    title="Devices"
                  >
                    <Monitor size={18} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowRawData({ id: game.id, name: game.name });
                    }}
                    className="p-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition"
                    title="Raw Data"
                  >
                    <Database size={18} />
                  </button>
                  {!game.ended && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEndGame(game.id);
                      }}
                      className="p-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg transition"
                      title="End Game"
                    >
                      <StopCircle size={18} />
                    </button>
                  )}
                  {(game.is_test || isAdminMode) && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteGame(game.id);
                      }}
                      className="p-2 bg-red-600 hover:bg-red-500 text-white rounded-lg transition"
                      title={game.is_test ? 'Delete test game' : 'Delete (admin)'}
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                </div>
              </div>
              );
            })}
          </div>

          <div>
            {selectedGameId !== null ? (
              <div className="sticky top-24">
                <div className="bg-slate-800/50 border-2 border-slate-700 rounded-lg p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xl font-bold text-white flex items-center gap-2">
                      <Users size={20} />
                      Teams ({teams.length})
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          if (selectedGameId === null) return;
                          setRefreshingTeams(true);
                          await loadTeams(selectedGameId);
                          setRefreshingTeams(false);
                        }}
                        className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm transition flex items-center gap-1"
                        title="Refresh teams"
                        disabled={refreshingTeams}
                      >
                        <RefreshCw size={14} className={refreshingTeams ? 'animate-spin' : ''} />
                        Refresh
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
                          className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm transition flex items-center gap-1"
                          title={minimizedTeams.size === teams.length ? "Expand all teams" : "Minimize all teams"}
                        >
                          {minimizedTeams.size === teams.length ? (
                            <>
                              <Maximize2 size={14} />
                              Expand All
                            </>
                          ) : (
                            <>
                              <Minimize2 size={14} />
                              Minimize All
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {teams.length > 0 && (
                    <div className="space-y-3 mb-4">
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                          <input
                            type="text"
                            placeholder="Search by name or chip #..."
                            value={teamSearch}
                            onChange={(e) => setTeamSearch(e.target.value)}
                            className="w-full pl-9 pr-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-400 text-sm focus:outline-none focus:border-blue-500"
                          />
                        </div>
                        <button
                          onClick={() => setTeamSortBy(teamSortBy === 'ranking' ? 'name' : 'ranking')}
                          className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm transition flex items-center gap-2"
                          title={teamSortBy === 'ranking' ? 'Sort by name' : 'Sort by ranking'}
                        >
                          {teamSortBy === 'ranking' ? (
                            <>
                              <ArrowUpDown size={16} />
                              Ranking
                            </>
                          ) : (
                            <>
                              <SortAsc size={16} />
                              Name
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {teams.length === 0 ? (
                    <p className="text-slate-400">No teams in this game.</p>
                  ) : (
                    getFilteredAndSortedTeams().length === 0 ? (
                      <p className="text-slate-400 text-sm">No teams match your search.</p>
                    ) : (
                    <div className="space-y-3">
                      {getFilteredAndSortedTeams().map((team, index) => {
                        const isMinimized = minimizedTeams.has(team.id);
                        const ranking = index + 1;
                        const selectedGame = games.find(g => g.id === selectedGameId);
                        // launched_games stores game_type capitalised ('TagQuest');
                        // the scenario gameDataMap uses the lowercase slug. Lowercase
                        // the launched value so the primary check works without
                        // depending on the async gameDataMap fallback.
                        const isTagQuest = selectedGame?.game_type?.toLowerCase() === 'tagquest' ||
                          gameDataMap[selectedGame?.game_uniqid ?? '']?.game?.type?.toLowerCase() === 'tagquest';
                        const showTeammates = isTagQuest && selectedGamePlayMode === 'team';
                        const configTeam = showTeammates
                          ? selectedGameTeamsConfig.find(t => t.chipId === team.key_id || t.name === team.team_name)
                          : undefined;
                        const teammates = configTeam?.teammates ?? [];

                        return (
                        <div
                          key={team.id}
                          className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden"
                        >
                          {isMinimized ? (
                            <div className="p-3 flex items-center justify-between cursor-pointer hover:bg-slate-700/50 transition" onClick={() => toggleMinimizeTeam(team.id)}>
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <span className="text-slate-400 text-sm font-medium">#{ranking}</span>
                                <div className="flex items-center gap-2 min-w-0">
                                  {team.end_time ? (
                                    <CheckCircle size={16} className="text-green-500 shrink-0" />
                                  ) : team.start_time ? (
                                    <Play size={16} className="text-blue-500 shrink-0" />
                                  ) : (
                                    <Clock size={16} className="text-slate-500 shrink-0" />
                                  )}
                                  <span className="text-white font-semibold truncate">{team.team_name}</span>
                                </div>
                                {showTeammates && teammates.length > 1 && (
                                  <span className="flex items-center gap-1 text-teal-400 text-xs shrink-0">
                                    <Users size={12} />
                                    {teammates.length}
                                  </span>
                                )}
                                <span className="flex items-center gap-2 text-slate-400 text-sm ml-auto mr-4 shrink-0">
                                  Score: <span className="text-white font-medium">{team.score}</span>
                                  {team.currentLevel && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                                      {team.currentLevel.name}
                                    </span>
                                  )}
                                </span>
                                {!showTeammates && (
                                  <span className="text-slate-400 text-sm shrink-0">
                                    Chip #{team.key_id}
                                  </span>
                                )}
                              </div>
                              <button className="p-1 hover:bg-slate-600 rounded transition ml-2 shrink-0" title="Expand team details">
                                <Maximize2 size={16} className="text-slate-400" />
                              </button>
                            </div>
                          ) : (
                          <div className="p-4">
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-3">
                                <div className="flex items-center gap-2">
                                  {team.end_time ? (
                                    <CheckCircle size={18} className="text-green-500" />
                                  ) : team.start_time ? (
                                    <Play size={18} className="text-blue-500" />
                                  ) : (
                                    <Clock size={18} className="text-slate-500" />
                                  )}
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
                                      className="bg-slate-700 border border-blue-500 rounded px-2 py-0.5 text-white font-semibold text-sm focus:outline-none w-36"
                                    />
                                  ) : (
                                    <span
                                      className="text-white font-semibold cursor-pointer hover:text-blue-300 transition-colors"
                                      title="Double-click to rename"
                                      onDoubleClick={() => { setRenamingTeamId(team.id); setRenameValue(team.team_name); }}
                                    >
                                      {team.team_name}
                                    </span>
                                  )}
                                  <span className="text-slate-500 text-xs font-mono">#{team.team_number}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {!showTeammates && (
                                  <span className="text-slate-400 text-sm">
                                    Chip #{team.key_id}
                                  </span>
                                )}
                                <button
                                  onClick={() => toggleMinimizeTeam(team.id)}
                                  className="p-1 hover:bg-slate-700 rounded transition"
                                  title="Minimize team details"
                                >
                                  <Minimize2 size={16} className="text-slate-400" />
                                </button>
                              </div>
                            </div>

                          {editingTeamId === team.id ? (
                            <div className="space-y-3">
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">Team Name</label>
                                <input
                                  type="text"
                                  value={editedTeam.team_name || ''}
                                  onChange={(e) => setEditedTeam({ ...editedTeam, team_name: e.target.value })}
                                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">Score</label>
                                <input
                                  type="number"
                                  value={editedTeam.score ?? 0}
                                  onChange={(e) => setEditedTeam({ ...editedTeam, score: parseInt(e.target.value) || 0 })}
                                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">Start Time (HH:MM:SS)</label>
                                <input
                                  type="time"
                                  step="1"
                                  value={formatTimeForInput(editedTeam.start_time ?? team.start_time)}
                                  onChange={(e) => setEditedTeam({ ...editedTeam, start_time: parseTimeInput(e.target.value) })}
                                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-slate-400 mb-1 block">End Time (HH:MM:SS)</label>
                                <input
                                  type="time"
                                  step="1"
                                  value={formatTimeForInput(editedTeam.end_time ?? team.end_time)}
                                  onChange={(e) => setEditedTeam({ ...editedTeam, end_time: parseTimeInput(e.target.value) })}
                                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </div>
                              <div className="flex gap-2 pt-2">
                                <button
                                  onClick={() => handleSaveTeam(team.id)}
                                  className="flex-1 px-3 py-2 bg-green-600 hover:bg-green-500 text-white rounded text-sm font-medium flex items-center justify-center gap-2"
                                  title="Save changes"
                                >
                                  <Save size={14} />
                                  Save
                                </button>
                                <button
                                  onClick={handleCancelEdit}
                                  className="flex-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm font-medium"
                                  title="Cancel editing"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="text-sm text-slate-400 space-y-1 mb-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span>Score: <span className="text-white font-medium">{team.score}</span></span>
                                  {team.currentLevel && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                                      {team.currentLevel.name}
                                    </span>
                                  )}
                                </div>
                                <div>Start: <span className="text-white">{formatTime(team.start_time)}</span></div>
                                <div>End: <span className="text-white">{team.end_time ? formatTime(team.end_time) : 'Not ended'}</span></div>
                              </div>
                              {showTeammates && (
                                <div className="mb-3 pt-2 border-t border-slate-700">
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-1.5 text-xs text-slate-400">
                                      <Users size={12} />
                                      <span className="font-medium uppercase tracking-wide">Teammates</span>
                                    </div>
                                    {addTeammateState?.teamId !== team.id && (
                                      <button
                                        onClick={() => openAddTeammate(team.id)}
                                        className="flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300 transition"
                                      >
                                        <UserPlus size={12} />
                                        Add
                                      </button>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    {teammates.map((mate, mi) => (
                                      <span key={mi} className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-700 rounded-full text-xs text-slate-300">
                                        <span className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" />
                                        {mate.name}
                                        <span className="text-slate-500 font-mono">#{mate.chipNumber}</span>
                                        <span className="text-slate-600 font-mono text-[10px]">{mate.chipId}</span>
                                        {mate.chipId !== team.key_id && (
                                          <button
                                            onClick={() => handleRemoveTeammate(team.id, mate.chipId, mate.name)}
                                            className="ml-0.5 -mr-0.5 text-slate-500 hover:text-red-400 transition"
                                            title="Remove teammate"
                                          >
                                            <X size={12} />
                                          </button>
                                        )}
                                      </span>
                                    ))}
                                  </div>
                                  {addTeammateState?.teamId === team.id && (
                                    <div className="mt-2 p-2 bg-slate-900/60 rounded-lg space-y-2">
                                      <input
                                        type="text"
                                        placeholder="Teammate name"
                                        value={addTeammateState.name}
                                        onChange={e => setAddTeammateState({ ...addTeammateState, name: e.target.value })}
                                        className="w-full px-2.5 py-1.5 bg-slate-700 border border-slate-600 rounded text-white text-xs focus:outline-none focus:ring-1 focus:ring-teal-500"
                                      />
                                      <select
                                        value={addTeammateState.chipId ?? ''}
                                        onChange={e => {
                                          const id = Number(e.target.value) || null;
                                          const chip = allChips.find(c => c.id === id);
                                          setAddTeammateState({ ...addTeammateState, chipId: id, name: chip ? chip.key_name : addTeammateState.name });
                                        }}
                                        className="w-full px-2.5 py-1.5 bg-slate-700 border border-slate-600 rounded text-white text-xs focus:outline-none focus:ring-1 focus:ring-teal-500"
                                      >
                                        <option value="">Select chip...</option>
                                        {allChips
                                          .filter(c => !getUsedChipIds().has(c.id))
                                          .map(c => (
                                            <option key={c.id} value={c.id}>
                                              #{c.key_number} — {c.key_name} (ID: {c.id})
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
                                          {savingTeammate ? 'Saving...' : 'Save'}
                                        </button>
                                        <button
                                          onClick={() => {
                                            const name = pickRandomName();
                                            if (name) setAddTeammateState(s => (s ? { ...s, name } : s));
                                          }}
                                          disabled={namePoolNames.length === 0}
                                          className="px-2 py-1.5 bg-slate-700 hover:bg-indigo-600 disabled:opacity-40 disabled:hover:bg-slate-700 text-white rounded text-xs flex items-center gap-1"
                                          title={namePoolNames.length === 0 ? 'No pooled names for this scenario' : 'Random name'}
                                        >
                                          <Dices size={11} />
                                        </button>
                                        <button
                                          onClick={() => setAddTeammateState(null)}
                                          className="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs"
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
                                    const game = games.find(g => g.id === selectedGameId);
                                    if (game) {
                                      setTeamDetails({ team, gameUniqid: game.game_uniqid, gameType: game.game_type });
                                    }
                                  }}
                                  className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium flex items-center justify-center gap-1.5"
                                  title="View team details"
                                >
                                  <BarChart2 size={15} />
                                  Details
                                </button>
                                <button
                                  onClick={() => handleEditTeam(team)}
                                  className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm font-medium"
                                  title="Edit team details"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => {
                                    const game = games.find(g => g.id === selectedGameId);
                                    if (game) {
                                      setTestTeam({ gameId: game.id, gameName: game.name, team });
                                    }
                                  }}
                                  className="px-3 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded text-sm font-medium flex items-center gap-1.5"
                                  title="Test this team"
                                >
                                  <FlaskConical size={14} />
                                  Test
                                </button>
                                <button
                                  onClick={() => handleRemoveTeam(team)}
                                  className="px-3 py-2 bg-slate-700 hover:bg-red-600 text-slate-300 hover:text-white rounded text-sm font-medium flex items-center"
                                  title="Remove team"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </>
                          )}
                          </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                    )
                  )}
                  {selectedGamePlayMode === 'team' && (
                    <div className="mt-4">
                      {addTeamState === null ? (
                        <button
                          onClick={openAddTeam}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 border border-dashed border-slate-600 hover:border-teal-500 text-slate-400 hover:text-teal-400 rounded-lg text-sm transition"
                        >
                          <PlusCircle size={15} />
                          Add Team
                        </button>
                      ) : (
                        <div className="p-3 bg-slate-800 border border-slate-600 rounded-lg space-y-2">
                          <div className="text-xs text-slate-400 font-medium uppercase tracking-wide mb-1">New Team</div>
                          <input
                            type="text"
                            placeholder="Team name"
                            value={addTeamState.name}
                            onChange={e => setAddTeamState({ ...addTeamState, name: e.target.value })}
                            className="w-full px-2.5 py-1.5 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                          />
                          <select
                            value={addTeamState.chipId ?? ''}
                            onChange={e => {
                              const id = Number(e.target.value) || null;
                              const chip = allChips.find(c => c.id === id);
                              setAddTeamState({ ...addTeamState, chipId: id, name: chip ? chip.key_name : addTeamState.name });
                            }}
                            className="w-full px-2.5 py-1.5 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                          >
                            <option value="">Select chip...</option>
                            {allChips
                              .filter(c => !getUsedChipIds().has(c.id))
                              .map(c => (
                                <option key={c.id} value={c.id}>
                                  #{c.key_number} — {c.key_name} (ID: {c.id})
                                </option>
                              ))}
                          </select>
                          {tracksRouteOptions.length > 1 && (
                            <select
                              value={addTeamState.route ?? tracksDefaultRoute}
                              onChange={e => setAddTeamState({ ...addTeamState, route: e.target.value })}
                              className="w-full px-2.5 py-1.5 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                              title="Route for this team (hand them the matching map)"
                            >
                              {tracksRouteOptions.map(r => (
                                <option key={r} value={r}>
                                  {TRACKS_ROUTE_LABELS[r] ?? r}
                                </option>
                              ))}
                            </select>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={handleAddTeam}
                              disabled={savingTeam || !addTeamState.name.trim() || addTeamState.chipId === null}
                              className="flex-1 px-3 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white rounded text-sm font-medium flex items-center justify-center gap-1.5"
                            >
                              <Save size={13} />
                              {savingTeam ? 'Saving...' : 'Save Team'}
                            </button>
                            <button
                              onClick={() => {
                                const name = pickRandomName();
                                if (name) setAddTeamState(s => (s ? { ...s, name } : s));
                              }}
                              disabled={namePoolNames.length === 0}
                              className="px-3 py-1.5 bg-slate-700 hover:bg-indigo-600 disabled:opacity-40 disabled:hover:bg-slate-700 text-white rounded text-sm flex items-center gap-1.5"
                              title={namePoolNames.length === 0 ? 'No pooled names for this scenario' : 'Random name'}
                            >
                              <Dices size={13} />
                              Random name
                            </button>
                            <button
                              onClick={() => setAddTeamState(null)}
                              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm"
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
            ) : (
              <div className="sticky top-24">
                <div className="bg-slate-800/50 border-2 border-slate-700 rounded-lg p-6 text-center">
                  <p className="text-slate-400">Select a game to view its teams</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showDevices !== null && (
        <GameDevicesModal
          launchedGameId={showDevices}
          gameLanguage="fr"
          isMother={true}
          onClose={() => setShowDevices(null)}
        />
      )}

      {showRawData !== null && (
        <RawDataModal
          launchedGameId={showRawData.id}
          gameName={showRawData.name}
          onClose={() => setShowRawData(null)}
        />
      )}

      {showRankings !== null && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setShowRankings(null)}>
          <div className="bg-slate-800 border-2 border-slate-700 rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-bold text-white flex items-center gap-2">
                <Trophy size={24} className="text-yellow-500" />
                Game Rankings
              </h3>
              <div className="flex items-center gap-2">
                {rankingsConfig && (
                  <button
                    onClick={() => {
                      setRankingPageGame({ launchedGameId: showRankings!, gameName: rankingsGameName, config: rankingsConfig });
                      setShowRankings(null);
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded-lg transition"
                    title="Open full ranking page"
                  >
                    <ExternalLink size={14} />
                    Full Page
                  </button>
                )}
                <button
                  onClick={() => setShowRankings(null)}
                  className="text-slate-400 hover:text-white transition"
                  title="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            {rankings.length === 0 ? (
              <p className="text-slate-400 text-center py-8">No teams in this game yet.</p>
            ) : (
              <div className="space-y-3">
                {rankings.map((team, index) => (
                  <div
                    key={team.id}
                    className={`p-4 rounded-lg border-2 ${
                      index === 0
                        ? 'bg-yellow-900/20 border-yellow-600'
                        : index === 1
                        ? 'bg-slate-700/50 border-slate-500'
                        : index === 2
                        ? 'bg-orange-900/20 border-orange-600'
                        : 'bg-slate-800 border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className={`text-2xl font-bold ${
                          index === 0
                            ? 'text-yellow-500'
                            : index === 1
                            ? 'text-slate-300'
                            : index === 2
                            ? 'text-orange-500'
                            : 'text-slate-400'
                        }`}>
                          #{index + 1}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            {team.end_time ? (
                              <CheckCircle size={16} className="text-green-500" />
                            ) : team.start_time ? (
                              <Play size={16} className="text-blue-500" />
                            ) : (
                              <Clock size={16} className="text-slate-500" />
                            )}
                            <span className="text-white font-semibold text-lg">
                              Team {team.team_number}: {team.team_name}
                            </span>
                          </div>
                          {selectedGamePlayMode !== 'team' && (
                            <p className="text-sm text-slate-400">Chip #{team.key_id}</p>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-2xl font-bold text-white">{team.score}</div>
                        <div className="text-xs text-slate-400">points</div>
                        {team.currentLevel && (
                          <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                            {team.currentLevel.name}
                          </div>
                        )}
                      </div>
                    </div>
                    {(team.start_time || team.end_time) && (
                      <div className="mt-3 pt-3 border-t border-slate-700 text-sm text-slate-400 flex gap-4">
                        {team.start_time && (
                          <div>Start: <span className="text-white">{formatTime(team.start_time)}</span></div>
                        )}
                        {team.end_time && (
                          <div>End: <span className="text-white">{formatTime(team.end_time)}</span></div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {configGameId !== null && (
        <LaunchedGameConfigModal
          gameId={configGameId}
          gameName={configGameName}
          onClose={() => {
            setConfigGameId(null);
            setConfigGameName('');
          }}
          onSave={() => {
            loadGames();
          }}
        />
      )}

      {testGameId !== null && (
        <GameTestModal
          gameId={testGameId}
          gameName={testGameName}
          onClose={() => {
            setTestGameId(null);
            setTestGameName('');
          }}
        />
      )}

      {testTeam !== null && (
        <TeamTestModal
          gameId={testTeam.gameId}
          gameName={testTeam.gameName}
          team={testTeam.team}
          onClose={() => {
            setTestTeam(null);
            if (selectedGameId !== null) loadTeams(selectedGameId);
          }}
        />
      )}

      {teamDetails && selectedGameId !== null && (
        <TeamDetailsModal
          team={teamDetails.team}
          launchedGameId={selectedGameId}
          gameUniqid={teamDetails.gameUniqid}
          gameType={teamDetails.gameType}
          chipIds={chipIdsForTeam(teamDetails.team)}
          onClose={() => setTeamDetails(null)}
        />
      )}

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog({ ...confirmDialog, isOpen: false })}
        title={confirmDialog.title}
        message={confirmDialog.message}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
      />

      {rankingPageGame && (
        <LeaderboardPage
          launchedGameId={rankingPageGame.launchedGameId}
          config={rankingPageGame.config}
          gameName={rankingPageGame.gameName}
          onBack={() => setRankingPageGame(null)}
        />
      )}

      {timeRangePage && (
        <TimeRangeLeaderboard
          scenario={timeRangePage.scenario}
          timeRange={timeRangePage.timeRange}
          onBack={() => setTimeRangePage(null)}
        />
      )}

      {activeGamesPage && activeGamesPage.length > 0 && (
        <MultiGameLeaderboard
          games={activeGamesPage}
          onBack={() => setActiveGamesPage(null)}
        />
      )}

      {showRankingsModal && (
        <RankingsModal
          onClose={() => setShowRankingsModal(false)}
          onOpenTimeRange={(scenario, timeRange) => {
            setShowRankingsModal(false);
            setTimeRangePage({ scenario, timeRange });
          }}
          onOpenActiveGames={(games) => {
            setShowRankingsModal(false);
            setActiveGamesPage(games);
          }}
        />
      )}

      {showArchived && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-[130] p-4"
          onClick={() => setShowArchived(false)}
        >
          <div
            className="bg-slate-800 border-2 border-slate-700 rounded-lg w-full max-w-4xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-6 border-b border-slate-700">
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                <Archive size={20} className="text-indigo-300" />
                Archived Games
              </h3>
              <button onClick={() => setShowArchived(false)} className="text-slate-400 hover:text-white transition">
                <X size={20} />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              {archivedLoading ? (
                <p className="text-slate-400 text-center py-8">Loading…</p>
              ) : archivedSummaries.length === 0 ? (
                <p className="text-slate-400 text-center py-8">No archived games yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-400 border-b border-slate-700">
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Name</th>
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2 pr-3">Scenario</th>
                      <th className="py-2 pr-3 text-right">Teams</th>
                      <th className="py-2 pr-3 text-right">Players</th>
                      <th className="py-2 text-center">Synced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {archivedSummaries.map((s) => (
                      <tr key={s.summary_uuid} className="border-b border-slate-700/50 text-slate-200">
                        <td className="py-2 pr-3 whitespace-nowrap">{s.played_at ? formatDate(s.played_at) : '—'}</td>
                        <td className="py-2 pr-3">{s.name || '—'}</td>
                        <td className="py-2 pr-3 capitalize">{s.game_type}</td>
                        <td className="py-2 pr-3">{gameDataMap[s.scenario_uniqid ?? '']?.game?.title ?? s.scenario_uniqid ?? '—'}</td>
                        <td className="py-2 pr-3 text-right">
                          {s.teams_played}
                          {s.teams_launched != null && s.teams_launched !== s.teams_played && (
                            <span className="text-slate-500"> / {s.teams_launched}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right">{s.players_played}</td>
                        <td className="py-2 text-center">
                          {s.pushed ? (
                            <CheckCircle size={16} className="inline text-green-400" />
                          ) : (
                            <Clock size={16} className="inline text-amber-400" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
