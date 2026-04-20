import { useEffect, useState } from 'react';
import { Clock, Search, Upload, Play, Trash2, LogIn } from 'lucide-react';
import { Footer } from './Footer';
import { Alert } from './Alert';
import { ConfirmDialog } from './ConfirmDialog';
import { LaunchGameModal, GameConfig } from './LaunchGameModal';
import { GamePage } from './GamePage';
import { validateAndExtractZip } from '../utils/zipHandler';
import { getLocalGameIds } from '../utils/localGames';
import { supabase } from '../lib/db';
import { usbReaderService } from '../services/usbReader';
import gamesData from '../../data/games.json';

interface GameType {
  id: string;
  name: string;
  description: string;
}

interface Scenario {
  id: string;
  game_type_id: string;
  title: string;
  description: string;
  difficulty: string | null;
  duration_minutes: number;
  image_url: string;
  uniqid?: string;
  available_for_purchase?: boolean;
}

interface ScenarioWithType extends Scenario {
  game_type: GameType;
}

interface AlertState {
  show: boolean;
  type: 'success' | 'error';
  message: string;
}

export function GameList() {
  const [scenarios, setScenarios] = useState<ScenarioWithType[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGameType, setSelectedGameType] = useState<string>('all');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('all');
  const [showOnlyLaunchable, setShowOnlyLaunchable] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [alert, setAlert] = useState<AlertState>({ show: false, type: 'success', message: '' });
  const [localGameIds, setLocalGameIds] = useState<Set<string>>(new Set());
  const [launchModalOpen, setLaunchModalOpen] = useState(false);
  const [selectedGame, setSelectedGame] = useState<{ uniqid: string; title: string; gameTypeName: string } | null>(null);
  const [launchedGame, setLaunchedGame] = useState<{ config: GameConfig; uniqid: string } | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [scenarioToDelete, setScenarioToDelete] = useState<{ uniqid: string; title: string } | null>(null);
  const [localImages, setLocalImages] = useState<Map<string, string>>(new Map());
  const [activeGames, setActiveGames] = useState<Map<string, { id: number; name: string; game_type: string; duration: number }>>(new Map());

  useEffect(() => {
    loadScenarios();
    loadLocalGames();
    loadActiveGames();
  }, []);

  const loadLocalGames = async () => {
    const ids = await getLocalGameIds();
    setLocalGameIds(new Set(ids));
    await loadLocalImages(ids);
  };

  const loadActiveGames = async () => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from('launched_games')
      .select('id, game_uniqid, name, game_type, duration')
      .eq('ended', false);
    if (error || !data) return;
    const map = new Map<string, { id: number; name: string; game_type: string; duration: number }>();
    data.forEach(g => { if (g.game_uniqid) map.set(g.game_uniqid, { id: g.id, name: g.name, game_type: g.game_type, duration: g.duration }); });
    setActiveGames(map);
  };

  const handleJoinGame = async (uniqid: string) => {
    const active = activeGames.get(uniqid);
    if (!active || !supabase) return;

    const { data: metaRows } = await supabase
      .from('launched_game_meta')
      .select('meta_name, meta_value')
      .eq('launched_game_id', active.id);

    const meta: Record<string, string> = {};
    (metaRows || []).forEach(r => { meta[r.meta_name] = r.meta_value; });

    const config: GameConfig = {
      name: active.name,
      numberOfTeams: 0,
      firstChipIndex: parseInt(meta.firstChipIndex ?? '1'),
      pattern: meta.pattern ?? '',
      duration: active.duration,
      messageDisplayDuration: parseInt(meta.messageDisplayDuration ?? '5'),
      enigmaImageDisplayDuration: parseInt(meta.enigmaImageDisplayDuration ?? '5'),
      colorblindMode: meta.colorblindMode === 'true',
      autoResetTeam: meta.autoResetTeam === 'true',
      delayBeforeReset: parseInt(meta.delayBeforeReset ?? '3'),
      victoryType: (meta.victoryType as GameConfig['victoryType']) ?? undefined,
      playMode: (meta.playMode as GameConfig['playMode']) ?? undefined,
      teammatesPerTeam: meta.teammatesPerTeam ? parseInt(meta.teammatesPerTeam) : undefined,
      testMode: meta.testMode === 'true' ? true : undefined,
      usbPort: meta.usbPort ?? undefined,
      teams: meta.teamsConfig ? JSON.parse(meta.teamsConfig) : undefined,
    };

    setLaunchedGame({ config, uniqid, launchedGameId: active.id });
  };

  const loadLocalImages = async (gameIds: string[]) => {
    const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;
    if (!isElectron) return;

    const imageMap = new Map<string, string>();

    for (const uniqid of gameIds) {
      try {
        const result = await (window as any).electron.scenarios.getImage(uniqid);
        if (result.success && result.data) {
          imageMap.set(uniqid, result.data);
        }
      } catch (error) {
        console.error(`Error loading image for ${uniqid}:`, error);
      }
    }

    setLocalImages(imageMap);
  };

  const loadScenarios = async () => {
    try {
      let scenariosData;

      const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

      if (isElectron && (window as any).electron?.scenarios?.load) {
        await (window as any).electron.scenarios.refresh();
        scenariosData = await (window as any).electron.scenarios.load();
        console.log('Loaded scenarios from local folder:', scenariosData);
      } else {
        scenariosData = await loadScenariosFromSupabase();
        console.log('Loaded scenarios from Supabase:', scenariosData);
      }

      const gameTypesMap = new Map(scenariosData.game_types.map(gt => [gt.id, gt]));

      const scenariosWithTypes = scenariosData.scenarios.map(scenario => ({
        ...scenario,
        game_type: gameTypesMap.get(scenario.game_type_id)!
      }));

      setScenarios(scenariosWithTypes);
    } catch (error) {
      console.error('Error loading scenarios:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadScenariosFromSupabase = async () => {
    const { data: storageFolders, error: storageError } = await supabase.storage
      .from('resources')
      .list('scenarios', { limit: 1000 });

    if (storageError || !storageFolders || storageFolders.length === 0) {
      return gamesData;
    }

    const gameTypeMap = new Map();
    const scenariosList = [];

    for (const folder of storageFolders) {
      if (!folder.name) continue;
      const uniqid = folder.name;

      const { data: fileData, error: fileError } = await supabase.storage
        .from('resources')
        .download(`scenarios/${uniqid}/game-data.json`);

      if (fileError || !fileData) continue;

      let gameData: any;
      try {
        const text = await fileData.text();
        gameData = JSON.parse(text);
      } catch {
        continue;
      }

      const title = gameData?.game?.title || gameData?.scenario?.title || gameData?.title || 'Unknown';
      const description = gameData?.game_meta?.scenario || gameData?.scenario?.description || gameData?.description || '';
      const game_type = gameData?.game?.type || gameData?.scenario?.game_type || gameData?.game_type || 'mystery';
      const difficulty = gameData?.difficulty || gameData?.game?.difficulty || 'medium';
      const duration_minutes = gameData?.duration_minutes || gameData?.game?.duration_minutes || 60;

      if (!gameTypeMap.has(game_type)) {
        gameTypeMap.set(game_type, {
          id: game_type,
          name: game_type.charAt(0).toUpperCase() + game_type.slice(1),
          description: `${game_type} game type`
        });
      }

      const imageUrl = await getScenarioImageFromStorage(uniqid, gameData);

      scenariosList.push({
        id: uniqid,
        game_type_id: game_type,
        title,
        description,
        difficulty,
        duration_minutes,
        image_url: imageUrl || '/placeholder-image.jpg',
        uniqid,
        available_for_purchase: false
      });
    }

    const combinedScenarios = [...scenariosList, ...gamesData.scenarios];
    const gameTypes = Array.from(gameTypeMap.values());
    const combinedGameTypes = [...gameTypes, ...gamesData.game_types];
    const uniqueGameTypes = Array.from(
      new Map(combinedGameTypes.map(gt => [gt.id, gt])).values()
    );

    return {
      game_types: uniqueGameTypes,
      scenarios: combinedScenarios
    };
  };

  const getScenarioImageUrl = async (uniqid: string): Promise<string | null> => {
    const { data: scenarioMedia, error: mediaError } = await supabase
      .from('scenario_media')
      .select('filename, data')
      .eq('scenario_uniqid', uniqid)
      .eq('media_type', 'image')
      .like('filename', '%game_instructions_image%')
      .maybeSingle();

    if (scenarioMedia && scenarioMedia.data) {
      return `data:image/png;base64,${scenarioMedia.data}`;
    }

    const { data: anyImage } = await supabase
      .from('scenario_media')
      .select('filename, data')
      .eq('scenario_uniqid', uniqid)
      .eq('media_type', 'image')
      .limit(1)
      .maybeSingle();

    if (anyImage && anyImage.data) {
      return `data:image/png;base64,${anyImage.data}`;
    }

    return null;
  };

  const getScenarioImageFromStorage = async (uniqid: string, gameData: any): Promise<string | null> => {
    const mediaImages = gameData?.game_data?.game_media_images;
    const rawFileName: string | undefined = mediaImages?.game_visual || mediaImages?.background_image;

    console.log(`[GameList][${uniqid}] game_media_images:`, mediaImages);
    console.log(`[GameList][${uniqid}] game_visual file:`, rawFileName);

    if (rawFileName) {
      const fileName = rawFileName.startsWith('media/') ? rawFileName.slice('media/'.length) : rawFileName;
      console.log(`[GameList][${uniqid}] resolved storage path: scenarios/${uniqid}/media/${fileName}`);
      const { data } = supabase.storage
        .from('resources')
        .getPublicUrl(`scenarios/${uniqid}/media/${fileName}`);
      console.log(`[GameList][${uniqid}] public URL:`, data.publicUrl);
      return data.publicUrl;
    }

    console.warn(`[GameList][${uniqid}] No game_visual or background_image found`);
    return null;
  };

  const filteredScenarios = scenarios
    .filter((scenario) => {
      const matchesSearch = scenario.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           scenario.description.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesType = selectedGameType === 'all' || scenario.game_type.name === selectedGameType;
      const matchesDifficulty = selectedDifficulty === 'all' || (scenario.difficulty?.toLowerCase() || 'medium') === selectedDifficulty.toLowerCase();
      const matchesLaunchable = !showOnlyLaunchable || (scenario.uniqid && localGameIds.has(scenario.uniqid));
      return matchesSearch && matchesType && matchesDifficulty && matchesLaunchable;
    })
    .sort((a, b) => {
      const aHasLocal = localGameIds.has(a.uniqid || '');
      const bHasLocal = localGameIds.has(b.uniqid || '');
      if (aHasLocal && !bHasLocal) return -1;
      if (!aHasLocal && bHasLocal) return 1;
      return 0;
    });

  const purchasedScenarios = filteredScenarios.filter(s => !s.available_for_purchase);
  const availableForPurchaseScenarios = filteredScenarios.filter(s => s.available_for_purchase);

  const gameTypes = [...new Set(scenarios.map((s) => s.game_type.name))];

  const getDifficultyColor = (difficulty: string | null) => {
    switch (difficulty?.toLowerCase()) {
      case 'easy':
        return 'bg-green-900/30 text-green-400 border-green-700';
      case 'medium':
        return 'bg-yellow-900/30 text-yellow-400 border-yellow-700';
      case 'hard':
        return 'bg-red-900/30 text-red-400 border-red-700';
      default:
        return 'bg-slate-700 text-slate-300 border-slate-600';
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const showAlert = (type: 'success' | 'error', message: string) => {
    setAlert({ show: true, type, message });
  };

  const closeAlert = () => {
    setAlert({ ...alert, show: false });
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const zipFile = files.find(f => f.name.endsWith('.zip'));

    if (!zipFile) {
      showAlert('error', 'Please drop a ZIP file.');
      return;
    }

    const result = await validateAndExtractZip(zipFile);

    if (!result.success) {
      showAlert('error', result.message || 'Failed to import scenario.');
      return;
    }

    showAlert('success', `Successfully imported game scenario: ${result.uniqid}`);
    await loadScenarios();
    await loadLocalGames();
  };

  const handleClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.onchange = async (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;

      const result = await validateAndExtractZip(file);

      if (!result.success) {
        showAlert('error', result.message || 'Failed to import scenario.');
        return;
      }

      showAlert('success', `Successfully imported game scenario: ${result.uniqid}`);
      await loadScenarios();
      await loadLocalGames();
    };
    input.click();
  };

  const handleLaunchGame = (uniqid: string, title: string, gameTypeName: string) => {
    setSelectedGame({ uniqid, title, gameTypeName });
    setLaunchModalOpen(true);
  };

  const handleGameLaunch = async (config: GameConfig) => {
    console.log('Launching game with config:', selectedGame, config);

    let launchedGameId: number | null = null;

    if (supabase && selectedGame) {
      try {
        const { data: launchedGame, error } = await supabase.from('launched_games').insert({
          game_uniqid: selectedGame.uniqid,
          name: config.name,
          number_of_teams: config.numberOfTeams,
          game_type: selectedGame.gameTypeName,
          start_time: new Date().toISOString(),
          duration: config.duration,
          started: false,
          ended: false,
        }).select().single();

        if (error) {
          console.error('Error inserting launched game:', error);
        } else if (launchedGame) {
          console.log('Successfully saved launched game to database');
          launchedGameId = launchedGame.id;

          const metaEntries = [
            { meta_name: 'firstChipIndex', meta_value: config.firstChipIndex.toString() },
            { meta_name: 'pattern', meta_value: config.pattern },
            { meta_name: 'messageDisplayDuration', meta_value: config.messageDisplayDuration.toString() },
            { meta_name: 'enigmaImageDisplayDuration', meta_value: config.enigmaImageDisplayDuration.toString() },
            { meta_name: 'colorblindMode', meta_value: config.colorblindMode.toString() },
            { meta_name: 'autoResetTeam', meta_value: config.autoResetTeam.toString() },
            { meta_name: 'delayBeforeReset', meta_value: config.delayBeforeReset.toString() },
          ];

          if (config.victoryType) {
            metaEntries.push({ meta_name: 'victoryType', meta_value: config.victoryType });
          }

          if (config.usbPort) {
            metaEntries.push({ meta_name: 'usbPort', meta_value: config.usbPort });
          }

          if (config.testMode) {
            metaEntries.push({ meta_name: 'testMode', meta_value: 'true' });
          }

          if (config.playMode) {
            metaEntries.push({ meta_name: 'playMode', meta_value: config.playMode });
          }

          if (config.teammatesPerTeam !== undefined) {
            metaEntries.push({ meta_name: 'teammatesPerTeam', meta_value: config.teammatesPerTeam.toString() });
          }

          if (config.teams && config.teams.length > 0) {
            metaEntries.push({ meta_name: 'teamsConfig', meta_value: JSON.stringify(config.teams) });
          }

          const metaData = metaEntries.map(entry => ({
            ...entry,
            launched_game_id: launchedGame.id,
          }));

          const { error: metaError } = await supabase.from('launched_game_meta').insert(metaData);

          if (metaError) {
            console.error('Error inserting launched game meta:', metaError);
          } else {
            console.log('Successfully saved launched game meta to database');
          }

          let deviceId = 'bolt';

          if (usbReaderService.isElectron()) {
            try {
              const computerName = await (window as any).electron.getComputerName();
              deviceId = computerName || 'unknown';
            } catch (error) {
              console.error('Error getting computer name:', error);
              deviceId = 'electron-unknown';
            }
          }

          const { error: deviceError } = await supabase.from('launched_game_devices').insert({
            launched_game_id: launchedGame.id,
            device_id: deviceId,
            connected: true,
            last_connexion_attempt: new Date().toISOString(),
          });

          if (deviceError) {
            console.error('Error inserting device:', deviceError);
          } else {
            console.log('Successfully saved device to database');
          }

          console.log('Config teams:', config.teams);
          if (config.teams && config.teams.length > 0) {
            const teamsData = config.teams.map((team, index) => ({
              launched_game_id: launchedGame.id,
              team_number: index + 1,
              team_name: team.name,
              pattern: config.pattern || '',
              score: 0,
              key_id: team.chipId,
            }));

            console.log('Teams data to insert:', teamsData);
            const { data: insertedTeams, error: teamsError } = await supabase.from('teams').insert(teamsData);

            if (teamsError) {
              console.error('Error inserting teams:', teamsError);
              console.error('Full error details:', JSON.stringify(teamsError, null, 2));
            } else {
              console.log('Successfully saved teams to database');
              console.log('Inserted teams response:', insertedTeams);
            }
          } else {
            console.log('No teams to insert or teams array is empty');
          }
        }
      } catch (error) {
        console.error('Error saving launched game:', error);
      }
    }

    setLaunchedGame({ config, uniqid: selectedGame?.uniqid || '', launchedGameId });
    setLaunchModalOpen(false);
  };

  const handleBackToList = () => {
    setLaunchedGame(null);
  };

  const handleDeleteClick = (uniqid: string, title: string) => {
    setScenarioToDelete({ uniqid, title });
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!scenarioToDelete) return;

    const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

    if (isElectron && (window as any).electron?.scenarios?.delete) {
      try {
        const result = await (window as any).electron.scenarios.delete(scenarioToDelete.uniqid);
        if (result.success) {
          showAlert('success', `Successfully deleted scenario: ${scenarioToDelete.title}`);
          await loadScenarios();
          await loadLocalGames();
        } else {
          showAlert('error', `Failed to delete scenario: ${result.error}`);
        }
      } catch (error) {
        console.error('Error deleting scenario:', error);
        showAlert('error', 'Failed to delete scenario');
      }
    } else if (!isElectron) {
      try {
        const { data: storageFiles } = await supabase.storage
          .from('game-media')
          .list(scenarioToDelete.uniqid, { limit: 1000 });

        if (storageFiles && storageFiles.length > 0) {
          const filePaths = storageFiles.map(f => `${scenarioToDelete.uniqid}/${f.name}`);
          await supabase.storage.from('game-media').remove(filePaths);
        }

        const { error } = await supabase
          .from('scenarios')
          .delete()
          .eq('uniqid', scenarioToDelete.uniqid);

        if (error) {
          console.error('Error deleting scenario:', error);
          showAlert('error', `Failed to delete scenario: ${error.message}`);
        } else {
          showAlert('success', `Successfully deleted scenario: ${scenarioToDelete.title}`);
          await loadScenarios();
          await loadLocalGames();
        }
      } catch (error) {
        console.error('Error deleting scenario:', error);
        showAlert('error', 'Failed to delete scenario');
      }
    }

    setDeleteConfirmOpen(false);
    setScenarioToDelete(null);
  };

  const handleDeleteCancel = () => {
    setDeleteConfirmOpen(false);
    setScenarioToDelete(null);
  };

  const renderScenarioCard = (scenario: ScenarioWithType) => {
    const hasLocal = scenario.uniqid && localGameIds.has(scenario.uniqid);
    const localImageUrl = scenario.uniqid ? localImages.get(scenario.uniqid) : null;
    const displayImageUrl = localImageUrl || scenario.image_url;
    const isAvailableForPurchase = scenario.available_for_purchase;
    const activeGame = scenario.uniqid ? activeGames.get(scenario.uniqid) : undefined;

    return (
      <div
        key={scenario.id}
        className="bg-slate-800 rounded-xl shadow-xl overflow-hidden border border-slate-700 hover:border-slate-600 transition group"
      >
        {displayImageUrl && (
          <div className="w-full h-48 overflow-hidden bg-slate-700 relative">
            <img
              src={displayImageUrl}
              alt={scenario.title}
              className="w-full h-full object-cover group-hover:scale-110 transition duration-300"
            />
            {isAvailableForPurchase && (
              <div className="absolute top-3 right-3 bg-amber-500/90 backdrop-blur-sm px-3 py-1 rounded-full text-xs font-bold text-white shadow-lg">
                Available for Purchase
              </div>
            )}
          </div>
        )}
        <div className="p-6">
          <div className="flex items-start justify-between mb-3">
            <span className="text-blue-400 text-sm font-semibold">
              {scenario.game_type.name}
            </span>
            <span className={`px-3 py-1 rounded-full text-xs font-medium border ${getDifficultyColor(scenario.difficulty)}`}>
              {scenario.difficulty || 'Medium'}
            </span>
          </div>
          <h3 className="text-xl font-bold text-white mb-2 group-hover:text-blue-400 transition">
            {scenario.title}
          </h3>
          <p className="text-slate-400 text-sm mb-4 line-clamp-2">
            {scenario.description}
          </p>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Clock size={16} />
              <span>{scenario.duration_minutes} minutes</span>
            </div>
            <div className="flex items-center gap-2">
              {!isAvailableForPurchase && scenario.uniqid && hasLocal && (
                <button
                  onClick={() => handleDeleteClick(scenario.uniqid || '', scenario.title)}
                  className="flex items-center gap-2 px-3 py-2 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white rounded-lg transition font-medium text-sm border border-red-600/30 hover:border-red-600"
                  title="Delete scenario"
                >
                  <Trash2 size={16} />
                </button>
              )}
              {!isAvailableForPurchase && scenario.uniqid && activeGame ? (
                <button
                  onClick={() => handleJoinGame(scenario.uniqid || '')}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition font-medium text-sm"
                  title={`Join active game: ${activeGame.name}`}
                >
                  <LogIn size={16} />
                  <span>Join</span>
                </button>
              ) : !isAvailableForPurchase && scenario.uniqid && (localGameIds.size === 0 || localGameIds.has(scenario.uniqid)) ? (
                <button
                  onClick={() => handleLaunchGame(scenario.uniqid || '', scenario.title, scenario.game_type.name)}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg transition font-medium text-sm"
                >
                  <Play size={16} />
                </button>
              ) : null}
              {isAvailableForPurchase && (
                <a
                  href="https://admin.taghunter.fr"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition font-medium text-sm"
                >
                  Purchase
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (launchedGame) {
    return (
      <GamePage
        config={launchedGame.config}
        gameUniqid={launchedGame.uniqid}
        launchedGameId={launchedGame.launchedGameId}
        onBack={handleBackToList}
      />
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen">
      {alert.show && (
        <Alert type={alert.type} message={alert.message} onClose={closeAlert} />
      )}

      <main className="flex-1 container mx-auto px-6 py-8">
        <div className="mb-8">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" size={20} />
              <input
                type="text"
                placeholder="Search scenarios..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              />
            </div>
            <button
              onClick={() => setShowOnlyLaunchable(!showOnlyLaunchable)}
              className={`px-6 py-3 rounded-lg font-medium transition flex items-center gap-2 ${
                showOnlyLaunchable
                  ? 'bg-green-600 text-white hover:bg-green-500'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <Play size={16} />
              Launchable Only
            </button>
            <select
              value={selectedDifficulty}
              onChange={(e) => setSelectedDifficulty(e.target.value)}
              className="px-4 py-3 bg-slate-800 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            >
              <option value="all">All Difficulties</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
            <div className="flex gap-2">
              <button
                onClick={() => setSelectedGameType('all')}
                className={`px-6 py-3 rounded-lg font-medium transition ${
                  selectedGameType === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                All
              </button>
              {gameTypes.map((type) => (
                <button
                  key={type}
                  onClick={() => setSelectedGameType(type)}
                  className={`px-6 py-3 rounded-lg font-medium transition ${
                    selectedGameType === type
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>
        </div>

        {scenarios.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="text-slate-400 text-lg mb-2">No scenarios found</div>
            <p className="text-slate-500 text-sm">
              Please configure your email in settings to sync scenarios from the server
            </p>
          </div>
        )}

        {scenarios.length > 0 && filteredScenarios.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="text-slate-400 text-lg mb-2">No scenarios match your filters</div>
            <p className="text-slate-500 text-sm">
              Try adjusting your search or filter criteria
            </p>
          </div>
        )}

        {purchasedScenarios.length > 0 && (
          <>
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Your Scenarios</h2>
              <p className="text-slate-400 text-sm mt-1">Scenarios you own and can launch</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
              {purchasedScenarios.map(renderScenarioCard)}
              <button
                onClick={handleClick}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`bg-slate-800 rounded-xl shadow-xl overflow-hidden border transition group cursor-pointer flex flex-col items-center justify-center min-h-[300px] p-6 ${
                  isDragging ? 'border-blue-400 bg-blue-900/20' : 'border-slate-700 hover:border-blue-500'
                }`}
              >
                <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 transition ${
                  isDragging ? 'bg-blue-600/40' : 'bg-blue-600/20 group-hover:bg-blue-600/30'
                }`}>
                  <Upload className={`transition ${
                    isDragging ? 'text-blue-300' : 'text-blue-400 group-hover:text-blue-300'
                  }`} size={32} />
                </div>
                <h3 className="text-xl font-bold text-white mb-2 group-hover:text-blue-400 transition">
                  Import Scenario
                </h3>
                <p className="text-slate-400 text-sm text-center">
                  {isDragging ? 'Drop ZIP file here' : 'Drag and drop a ZIP file or click to browse'}
                </p>
              </button>
            </div>
          </>
        )}

        {availableForPurchaseScenarios.length > 0 && (
          <>
            <div className="mb-6 border-t border-slate-700 pt-12">
              <h2 className="text-2xl font-bold text-white flex items-center gap-3">
                Available for Purchase
                <span className="px-3 py-1 bg-amber-500/20 text-amber-400 text-sm font-semibold rounded-full border border-amber-500/30">
                  New
                </span>
              </h2>
              <p className="text-slate-400 text-sm mt-1">Discover more scenarios and expand your collection</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {availableForPurchaseScenarios.map(renderScenarioCard)}
            </div>
          </>
        )}

        {purchasedScenarios.length === 0 && availableForPurchaseScenarios.length === 0 && scenarios.length > 0 && (
          <div className="text-center py-12">
            <p className="text-slate-400 text-lg">No scenarios found matching your criteria</p>
          </div>
        )}
      </main>

      <Footer />

      <LaunchGameModal
        isOpen={launchModalOpen}
        onClose={() => setLaunchModalOpen(false)}
        gameTitle={selectedGame?.title || ''}
        gameUniqid={selectedGame?.uniqid || ''}
        gameTypeName={selectedGame?.gameTypeName || ''}
        onLaunch={handleGameLaunch}
      />

      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        title="Delete Scenario"
        message={`Are you sure you want to delete "${scenarioToDelete?.title}"? This action cannot be undone and will permanently remove all scenario files.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
}
