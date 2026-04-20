import { useState, useEffect } from 'react';
import { Play, Trash2, Users, Save, Clock, CheckCircle, Flag, Trophy, Gamepad2, Search, ArrowUpDown, Import as SortAsc, Minimize2, Maximize2, Monitor, StopCircle, Settings, FlaskConical, UserPlus, PlusCircle, X, BarChart2, RefreshCw, ExternalLink } from 'lucide-react';
import { supabase } from '../lib/db';
import { GamePage } from './GamePage';
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

interface LaunchedGame {
  id: number;
  game_uniqid: string;
  name: string;
  number_of_teams: number;
  game_type: string;
  ended: boolean;
  created_at: string;
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

interface Device {
  id: number;
  device_id: string;
  connected: boolean;
  last_connexion_attempt: string;
}

export function LaunchedGamesList() {
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
  const [devices, setDevices] = useState<Device[]>([]);
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
  const [addTeamState, setAddTeamState] = useState<{ name: string; chipId: number | null } | null>(null);
  const [savingTeammate, setSavingTeammate] = useState(false);
  const [savingTeam, setSavingTeam] = useState(false);
  const [teamDetails, setTeamDetails] = useState<{ team: Team; gameUniqid: string } | null>(null);
  const [showRankingsModal, setShowRankingsModal] = useState(false);
  const [timeRangePage, setTimeRangePage] = useState<{ scenario: ScenarioOption; timeRange: TimeRange } | null>(null);
  const [activeGamesPage, setActiveGamesPage] = useState<ActiveGameOption[] | null>(null);

  const parseChipsCsv = (text: string): SiPuce[] => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const idIdx = headers.indexOf('id');
    const numIdx = headers.indexOf('key_number');
    const nameIdx = headers.indexOf('key_name');
    const colorIdx = headers.indexOf('color');
    const chips: SiPuce[] = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      const id = parseInt(vals[idIdx]);
      const key_number = parseInt(vals[numIdx]);
      const key_name = vals[nameIdx] || '';
      if (isNaN(id) || isNaN(key_number)) continue;
      chips.push({ id, key_number, key_name, color: colorIdx !== -1 ? vals[colorIdx] || null : null, created_at: '', updated_at: '' });
    }
    return chips.sort((a, b) => a.key_number - b.key_number);
  };

  useEffect(() => {
    loadGames();
    const loadChips = async () => {
      const { data: files, error } = await supabase.storage.from('resources').list('cards', { limit: 100 });
      if (error || !files) return;
      const csvFiles = files.filter(f => f.name && f.name.endsWith('.csv') && f.name !== '.emptyFolderPlaceholder');
      const allParsed: SiPuce[] = [];
      for (const file of csvFiles) {
        const { data: blob } = await supabase.storage.from('resources').download(`cards/${file.name}`);
        if (blob) {
          const parsed = parseChipsCsv(await blob.text());
          allParsed.push(...parsed);
        }
      }
      allParsed.sort((a, b) => a.key_number - b.key_number);
      setAllChips(allParsed);
    };
    loadChips();
  }, []);

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
      supabase
        .from('launched_game_meta')
        .select('meta_name, meta_value')
        .eq('launched_game_id', selectedGameId)
        .in('meta_name', ['playMode', 'teamsConfig'])
        .then(({ data }) => {
          if (data) {
            const map: Record<string, string> = {};
            data.forEach(row => { map[row.meta_name] = row.meta_value || ''; });
            if (map.playMode === 'solo' || map.playMode === 'team') {
              setSelectedGamePlayMode(map.playMode);
            }
            if (map.teamsConfig) {
              try { setSelectedGameTeamsConfig(JSON.parse(map.teamsConfig)); } catch {}
            }
          }
        });
    }
  }, [selectedGameId]);

  const loadGames = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('launched_games')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading launched games:', error);
    } else {
      setGames(data || []);
    }
    setLoading(false);
  };

  const loadTeams = async (gameId: number) => {
    const { data, error } = await supabase
      .from('teams')
      .select('*')
      .eq('launched_game_id', gameId)
      .order('team_number', { ascending: true });

    if (error) {
      console.error('Error loading teams:', error);
      return;
    }

    const teamsData = data || [];

    const { data: questRows } = await supabase
      .from('team_completed_quests')
      .select('team_id, quest_number, points_awarded')
      .eq('launched_game_id', gameId);

    const scoreByTeam: Record<number, number> = {};
    const questCountByTeam: Record<number, Record<string, number>> = {};
    for (const row of questRows || []) {
      scoreByTeam[row.team_id] = (scoreByTeam[row.team_id] ?? 0) + (row.points_awarded ?? 0);
      if (!questCountByTeam[row.team_id]) questCountByTeam[row.team_id] = {};
      questCountByTeam[row.team_id][row.quest_number] = (questCountByTeam[row.team_id][row.quest_number] ?? 0) + 1;
    }

    const game = games.find(g => g.id === gameId);
    let pts6 = 0, pts4 = 0, pts2 = 0;
    let gameLevels: Record<string, { name: string | null; points: string | null }> | null = null;
    if (game?.game_uniqid) {
      try {
        const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;
        let gameDataJson: any = null;
        if (isElectron && (window as any).electron?.games?.readFile) {
          const content = await (window as any).electron.games.readFile(game.game_uniqid, 'game-data.json');
          gameDataJson = JSON.parse(content);
        } else {
          const { data: urlData } = supabase.storage.from('resources').getPublicUrl(`scenarios/${game.game_uniqid}/game-data.json`);
          const resp = await fetch(urlData.publicUrl);
          if (resp.ok) gameDataJson = await resp.json();
        }
        const gameMeta = gameDataJson?.game_data?.game_meta ?? gameDataJson?.game_meta;
        const parseVal = (v: any) => (v === undefined || v === null) ? 0 : (typeof v === 'string' ? parseInt(v, 10) || 0 : v);
        pts6 = parseVal(gameMeta?.combo_6_quests);
        pts4 = parseVal(gameMeta?.combo_4_quests);
        pts2 = parseVal(gameMeta?.combo_2_quests);
        gameLevels = gameMeta?.levels ?? null;
      } catch {}
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
    try {
      const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;
      console.log('🎮 Loading game data...');
      console.log('  - isElectron:', isElectron);
      console.log('  - electron.games.readFile available:', !!(window as any).electron?.games?.readFile);
      console.log('  - Games:', games);

      const uniqueUniqids = [...new Set(games.map(g => g.game_uniqid))];
      console.log('  - Unique uniqids to load:', uniqueUniqids);
      const dataMap: Record<string, GameData> = {};

      for (const uniqid of uniqueUniqids) {
        try {
          console.log(`  - Loading ${uniqid}...`);
          let gameData;

          if (isElectron && (window as any).electron?.games?.readFile) {
            const gameDataContent = await (window as any).electron.games.readFile(uniqid, 'game-data.json');
            gameData = JSON.parse(gameDataContent);
          } else {
            const { data: scenarioData, error: scenarioError } = await supabase
              .from('scenarios')
              .select('*')
              .eq('uniqid', uniqid)
              .maybeSingle();

            if (!scenarioError && scenarioData) {
              gameData = {
                game: {
                  id: scenarioData.id.toString(),
                  uniqid: scenarioData.uniqid,
                  type: scenarioData.game_type,
                  title: scenarioData.title,
                  slug: scenarioData.uniqid
                }
              };
            } else {
              const response = await fetch(`/data/games/${uniqid}/game-data.json`);
              if (response.ok) {
                gameData = await response.json();
              }
            }
          }

          console.log(`  ✓ Loaded ${uniqid}:`, gameData?.game?.title);
          if (gameData) {
            dataMap[uniqid] = gameData;
          }
        } catch (err) {
          console.error(`  ✗ Error loading game data for ${uniqid}:`, err);
        }
      }

      console.log('  - Final gameDataMap:', dataMap);
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
      onConfirm: async () => {
        const { error } = await supabase
          .from('launched_games')
          .update({ ended: true })
          .eq('id', gameId);

        if (error) {
          console.error('Error ending game:', error);
          alert('Failed to end game');
        } else {
          loadGames();
          if (selectedGameId === gameId) {
            loadTeams(gameId);
          }
        }
        setConfirmDialog({ ...confirmDialog, isOpen: false });
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
      onConfirm: async () => {
        const { error: teamsError } = await supabase
          .from('teams')
          .delete()
          .eq('launched_game_id', gameId);

        if (teamsError) {
          console.error('Error deleting teams:', teamsError);
          alert('Failed to delete teams');
          setConfirmDialog({ ...confirmDialog, isOpen: false });
          return;
        }

        const { error: devicesError } = await supabase
          .from('launched_game_devices')
          .delete()
          .eq('launched_game_id', gameId);

        if (devicesError) {
          console.error('Error deleting devices:', devicesError);
          alert('Failed to delete devices');
          setConfirmDialog({ ...confirmDialog, isOpen: false });
          return;
        }

        const { error: metaError } = await supabase
          .from('launched_game_meta')
          .delete()
          .eq('launched_game_id', gameId);

        if (metaError) {
          console.error('Error deleting game meta:', metaError);
          alert('Failed to delete game meta');
          setConfirmDialog({ ...confirmDialog, isOpen: false });
          return;
        }

        const { error: gameError } = await supabase
          .from('launched_games')
          .delete()
          .eq('id', gameId);

        if (gameError) {
          console.error('Error deleting game:', gameError);
          alert('Failed to delete game');
        } else {
          if (selectedGameId === gameId) {
            setSelectedGameId(null);
            setTeams([]);
          }
          loadGames();
        }
        setConfirmDialog({ ...confirmDialog, isOpen: false });
      },
    });
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
    const { error } = await supabase
      .from('teams')
      .update(editedTeam)
      .eq('id', teamId);

    if (error) {
      console.error('Error updating team:', error);
      alert('Failed to update team');
    } else {
      setEditingTeamId(null);
      setEditedTeam({});
      if (selectedGameId !== null) {
        loadTeams(selectedGameId);
      }
    }
  };

  const handleRenameTeam = async (teamId: number) => {
    const name = renameValue.trim();
    if (!name) { setRenamingTeamId(null); return; }
    const { error } = await supabase.from('teams').update({ team_name: name }).eq('id', teamId);
    if (!error && selectedGameId !== null) loadTeams(selectedGameId);
    setRenamingTeamId(null);
    setRenameValue('');
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

  const persistTeamsConfig = async (updated: ConfigTeam[]) => {
    if (!selectedGameId) return;
    setSelectedGameTeamsConfig(updated);
    await supabase
      .from('launched_game_meta')
      .update({ meta_value: JSON.stringify(updated) })
      .eq('launched_game_id', selectedGameId)
      .eq('meta_name', 'teamsConfig');
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

    const { data: newTeam, error } = await supabase
      .from('teams')
      .insert({
        launched_game_id: selectedGameId,
        team_number: nextTeamNumber,
        team_name: addTeamState.name.trim(),
        pattern: 0,
        score: 0,
        key_id: chip.id,
      })
      .select()
      .maybeSingle();

    if (error || !newTeam) {
      console.error('Error adding team:', error);
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

  const handleShowRankings = async (gameId: number, gameName: string) => {
    const [teamsRes, metaRes] = await Promise.all([
      supabase.from('teams').select('*').eq('launched_game_id', gameId).order('score', { ascending: false }),
      supabase.from('launched_game_meta').select('meta_name, meta_value').eq('launched_game_id', gameId),
    ]);

    if (teamsRes.error) {
      console.error('Error loading rankings:', teamsRes.error);
      return;
    }

    const metaMap: Record<string, string> = {};
    metaRes.data?.forEach(row => { metaMap[row.meta_name] = row.meta_value || ''; });

    const config: GameConfig = {
      name: gameName,
      numberOfTeams: parseInt(metaMap.numberOfTeams || '0'),
      firstChipIndex: parseInt(metaMap.firstChipIndex || '1'),
      pattern: metaMap.pattern || '',
      duration: parseInt(metaMap.duration || '0'),
      messageDisplayDuration: parseInt(metaMap.messageDisplayDuration || '5'),
      enigmaImageDisplayDuration: parseInt(metaMap.enigmaImageDisplayDuration || '5'),
      colorblindMode: metaMap.colorblindMode === 'true',
      autoResetTeam: metaMap.autoResetTeam === 'true',
      delayBeforeReset: parseInt(metaMap.delayBeforeReset || '2'),
      testMode: metaMap.testMode === 'true',
      victoryType: (metaMap.victoryType as 'speed' | 'score') || undefined,
      playMode: (metaMap.playMode as 'solo' | 'team') || undefined,
      usbPort: metaMap.usbPort || undefined,
    };

    setRankings(teamsRes.data || []);
    setRankingsGameName(gameName);
    setRankingsConfig(config);
    setShowRankings(gameId);
  };

  const handleShowDevices = async (gameId: number) => {
    const { data, error } = await supabase
      .from('launched_game_devices')
      .select('*')
      .eq('launched_game_id', gameId)
      .order('last_connexion_attempt', { ascending: false });

    if (error) {
      console.error('Error loading devices:', error);
    } else {
      setDevices(data || []);
      setShowDevices(gameId);
    }
  };

  const handlePlayGame = async (game: LaunchedGame) => {
    const { data: metaData, error } = await supabase
      .from('launched_game_meta')
      .select('*')
      .eq('launched_game_id', game.id);

    if (error) {
      console.error('Error loading game meta:', error);
      return;
    }

    const metaMap: Record<string, string> = {};
    metaData?.forEach(meta => {
      metaMap[meta.meta_name] = meta.meta_value || '';
    });

    const config: GameConfig = {
      name: game.name,
      numberOfTeams: game.number_of_teams,
      firstChipIndex: parseInt(metaMap.firstChipIndex || '1'),
      pattern: metaMap.pattern || '',
      duration: parseInt(metaMap.duration || '0'),
      messageDisplayDuration: parseInt(metaMap.messageDisplayDuration || '5'),
      enigmaImageDisplayDuration: parseInt(metaMap.enigmaImageDisplayDuration || '5'),
      colorblindMode: metaMap.colorblindMode === 'true',
      autoResetTeam: metaMap.autoResetTeam === 'true',
      delayBeforeReset: parseInt(metaMap.delayBeforeReset || '2'),
      testMode: metaMap.testMode === 'true',
      victoryType: (metaMap.victoryType as 'speed' | 'score') || undefined,
      playMode: (metaMap.playMode as 'solo' | 'team') || undefined,
      usbPort: metaMap.usbPort || undefined,
    };

    setPlayingGame({ config, uniqid: game.game_uniqid, launchedGameId: game.id });
  };

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
        <button
          onClick={() => setShowRankingsModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-yellow-500/15 hover:bg-yellow-500/25 border border-yellow-500/30 hover:border-yellow-400/50 text-yellow-400 font-semibold text-sm rounded-xl transition-all"
        >
          <Trophy size={16} />
          Rankings
        </button>
      </div>

      {games.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-400 text-lg">No games have been launched yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            {games.map((game) => (
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
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteGame(game.id);
                    }}
                    className="p-2 bg-red-600 hover:bg-red-500 text-white rounded-lg transition"
                    title="Delete"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            ))}
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
                        const isTagQuest = selectedGame?.game_type === 'tagquest' ||
                          gameDataMap[selectedGame?.game_uniqid ?? '']?.game?.type === 'tagquest';
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
                                        onClick={() => setAddTeammateState({ teamId: team.id, chipId: null, name: '' })}
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
                                        onChange={e => setAddTeammateState({ ...addTeammateState, chipId: Number(e.target.value) || null })}
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
                                  onClick={() => handleEditTeam(team)}
                                  className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium"
                                  title="Edit team details"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => {
                                    const game = games.find(g => g.id === selectedGameId);
                                    if (game) {
                                      setTeamDetails({ team, gameUniqid: game.game_uniqid });
                                    }
                                  }}
                                  className="px-3 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded text-sm font-medium flex items-center gap-1.5"
                                  title="View team details"
                                >
                                  <BarChart2 size={14} />
                                  Details
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
                          onClick={() => setAddTeamState({ name: '', chipId: null })}
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
                            onChange={e => setAddTeamState({ ...addTeamState, chipId: Number(e.target.value) || null })}
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
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setShowDevices(null)}>
          <div className="bg-slate-800 border-2 border-slate-700 rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-bold text-white flex items-center gap-2">
                <Monitor size={24} className="text-purple-500" />
                Game Devices
              </h3>
              <button
                onClick={() => setShowDevices(null)}
                className="text-slate-400 hover:text-white transition"
                title="Close"
              >
                ✕
              </button>
            </div>

            {devices.length === 0 ? (
              <p className="text-slate-400 text-center py-8">No devices have connected to this game yet.</p>
            ) : (
              <div className="space-y-3">
                {devices.map((device) => (
                  <div
                    key={device.id}
                    className="p-4 rounded-lg border-2 bg-slate-800 border-slate-700"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Monitor size={20} className={device.connected ? 'text-green-500' : 'text-slate-500'} />
                        <div>
                          <div className="text-white font-semibold text-lg">
                            {device.device_id}
                          </div>
                          <p className="text-sm text-slate-400">
                            Last attempt: {formatDate(device.last_connexion_attempt)}
                          </p>
                        </div>
                      </div>
                      <div>
                        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                          device.connected
                            ? 'bg-green-900/30 text-green-400 border border-green-700'
                            : 'bg-slate-700 text-slate-300 border border-slate-600'
                        }`}>
                          {device.connected ? 'Connected' : 'Disconnected'}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
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
    </div>
  );
}
