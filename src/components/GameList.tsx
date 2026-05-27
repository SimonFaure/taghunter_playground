import { useEffect, useState } from 'react';
import { Clock, Search, Play, Trash2, LogIn, Eye, Zap, ChevronDown } from 'lucide-react';
import { Alert } from './Alert';
import { ConfirmDialog } from './ConfirmDialog';
import { LaunchGameModal, GameConfig, LaunchDeviceSelection } from './LaunchGameModal';
import { LaunchConfigModal } from './LaunchConfigModal';
import { GamePage } from './GamePage';
import { ScenarioThumbnail } from './ScenarioThumbnail';
import { ScenarioDetailsModal } from './ScenarioDetailsModal';
import { getLocalGameIds } from '../utils/localGames';
import * as scenarioStore from '../services/scenarioStore';
import * as patternStore from '../services/patternStore';
import * as cardsRepo from '../services/cardsRepo';
import * as launchConfigsStore from '../services/launchConfigsStore';
import type { LaunchConfigRow } from '../services/launchConfigsStore';
import {
  validateForHeadless,
  buildRoster,
  resolveDefaultDeviceSelection,
  extractTracksOptions,
  EMPTY_TRACKS_OPTIONS,
  type PatternOption,
} from '../services/launchResolve';
import { scenarioAssetUrl } from '../services/contentFs';
import { on as onSyncEvent } from '../services/syncEvents';
import { setGameActive } from '../services/activeSession';
import {
  createLaunchedGame,
  listActiveLaunchedGames,
  getLaunchedGameMeta,
  getLaunchedGameState,
  queueJoinGameCommandBulk,
} from '../services/launchedGames';
import { useAuth } from './auth/AuthProvider';
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

interface LaunchTarget {
  uniqid: string;
  title: string;
  gameTypeName: string;
}

export function GameList() {
  const { user } = useAuth();
  const [scenarios, setScenarios] = useState<ScenarioWithType[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGameType, setSelectedGameType] = useState<string>('all');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('all');
  const [showOnlyLaunchable, setShowOnlyLaunchable] = useState(false);
  const [alert, setAlert] = useState<AlertState>({ show: false, type: 'success', message: '' });
  const [localGameIds, setLocalGameIds] = useState<Set<string>>(new Set());
  const [launchModalOpen, setLaunchModalOpen] = useState(false);
  const [selectedGame, setSelectedGame] = useState<LaunchTarget | null>(null);
  const [launchedGame, setLaunchedGame] = useState<{ config: GameConfig; uniqid: string; launchedGameId: number | null } | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [scenarioToDelete, setScenarioToDelete] = useState<{ uniqid: string; title: string } | null>(null);
  const [localImages, setLocalImages] = useState<Map<string, string>>(new Map());
  const [activeGames, setActiveGames] = useState<Map<string, { id: number; name: string; game_type: string; duration: number }>>(new Map());
  const [detailsScenario, setDetailsScenario] = useState<ScenarioWithType | null>(null);
  // Saved launch configs (local-only). Counts drive the Quick Launch button;
  // the modal is the unified picker + manager.
  const [configCounts, setConfigCounts] = useState<Map<string, number>>(new Map());
  const [configModal, setConfigModal] = useState<{ scenario: LaunchTarget; configs: LaunchConfigRow[] } | null>(null);
  // Pre-fill payload for the launch wizard: set when Editing a config or when a
  // headless launch hit critical drift and falls back to the full screen.
  const [prefill, setPrefill] = useState<{ config: Partial<GameConfig>; name?: string; notice?: string } | null>(null);

  useEffect(() => {
    loadScenarios();
    loadLocalGames();
    loadActiveGames();
    loadConfigCounts();

    // Refresh when the orchestrator downloads or removes content.
    const offContent = onSyncEvent('content:updated', (p) => {
      if (p.kind === 'scenarios') {
        loadScenarios();
        loadLocalGames();
      }
    });
    return () => {
      offContent();
    };
  }, [user?.client_id]);

  const loadConfigCounts = async () => {
    if (!user?.client_id) {
      setConfigCounts(new Map());
      return;
    }
    try {
      setConfigCounts(await launchConfigsStore.countsByScenario(user.client_id));
    } catch (err) {
      console.error('[GameList] loadConfigCounts failed:', err);
    }
  };

  // Mirror "a game is running" into the module-level signal the update flow
  // reads before relaunching to apply an update (services/activeSession.ts).
  useEffect(() => {
    setGameActive(launchedGame !== null);
    return () => setGameActive(false);
  }, [launchedGame]);

  const loadLocalGames = async () => {
    const ids = await getLocalGameIds();
    setLocalGameIds(new Set(ids));
    await loadLocalImages(ids);
  };

  const loadActiveGames = async () => {
    try {
      const games = await listActiveLaunchedGames();
      const map = new Map<string, { id: number; name: string; game_type: string; duration: number }>();
      for (const g of games) {
        if (g.game_uniqid) {
          map.set(g.game_uniqid, { id: g.id, name: g.name, game_type: g.game_type, duration: g.duration });
        }
      }
      setActiveGames(map);
    } catch (err) {
      console.error('[GameList] loadActiveGames failed:', err);
    }
  };

  const handleJoinGame = async (uniqid: string) => {
    const active = activeGames.get(uniqid);
    if (!active) return;

    let meta: Record<string, string> = {};
    try {
      meta = await getLaunchedGameMeta(active.id);
    } catch (err) {
      console.error('[GameList] failed to load meta for join:', err);
    }

    const config: GameConfig = {
      name: active.name,
      numberOfTeams: 0,
      firstChipIndex: parseInt(meta.firstChipIndex ?? '1'),
      pattern: meta.pattern ?? '',
      duration: active.duration,
      messageDisplayDuration: parseInt(meta.messageDisplayDuration ?? '5'),
      enigmaImageDisplayDuration: parseInt(meta.enigmaImageDisplayDuration ?? '1'),
      colorblindMode: meta.colorblindMode === 'true',
      autoResetTeam: meta.autoResetTeam === 'true',
      delayBeforeReset: parseInt(meta.delayBeforeReset ?? '3'),
      revealResultsOnInput: meta.revealResultsOnInput !== 'false',
      autoRegisterTeam: meta.autoRegisterTeam === 'true',
      reuseCards: meta.reuseCards === 'true',
      selfRegisterTeam: meta.selfRegisterTeam === 'true',
      reuseDelayMinutes: parseInt(meta.reuseDelayMinutes ?? '5'),
      useNamePool: meta.useNamePool === 'true',
      namePoolAudience: (meta.namePoolAudience as GameConfig['namePoolAudience']) ?? undefined,
      language: meta.language ?? undefined,
      visibilityHideDelaySec: parseInt(meta.visibilityHideDelaySec ?? '10'),
      victoryType: (meta.victoryType as GameConfig['victoryType']) ?? undefined,
      playMode: (meta.playMode as GameConfig['playMode']) ?? undefined,
      teammatesPerTeam: meta.teammatesPerTeam ? parseInt(meta.teammatesPerTeam) : undefined,
      testMode: meta.testMode === 'true' ? true : undefined,
      teams: meta.teamsConfig ? JSON.parse(meta.teamsConfig) : undefined,
    };

    setLaunchedGame({ config, uniqid, launchedGameId: active.id });
  };

  // Load thumbnail URLs from the local SQLite/FS store. Resolves
  // game-data.json's `game_media_images.game_visual` (or background_image) for
  // each downloaded scenario and turns it into a webview-loadable URL.
  // The orchestrator writes the API's `game_data` payload to disk unwrapped,
  // so the map sits at the root (not under a `.game_data` key).
  const loadLocalImages = async (gameIds: string[]) => {
    const imageMap = new Map<string, string>();
    for (const uniqid of gameIds) {
      try {
        const gameData = await scenarioStore.getGameData(uniqid);
        const mediaImages =
          (gameData as { game_media_images?: { game_visual?: string; background_image?: string } } | null)
            ?.game_media_images;
        const raw = mediaImages?.game_visual ?? mediaImages?.background_image;
        if (!raw) continue;
        const fileName = raw.startsWith('media/') ? raw.slice('media/'.length) : raw;
        // Resolve to a `scenario://` URL — the custom protocol is the only one
        // the webview can actually load (the asset protocol / convertFileSrc
        // is not enabled in tauri.conf.json). The Rust handler resolves the
        // file against the scenario's current local_version per request.
        const url = scenarioAssetUrl(uniqid, fileName);
        if (url) imageMap.set(uniqid, url);
      } catch (err) {
        console.warn(`[GameList] image lookup failed for ${uniqid}:`, err);
      }
    }
    setLocalImages(imageMap);
  };

  const loadScenarios = async () => {
    try {
      const rows = await scenarioStore.list();
      const gameTypeByName = new Map(gamesData.game_types.map((gt) => [gt.name.toLowerCase(), gt]));

      const scenariosWithTypes: ScenarioWithType[] = await Promise.all(
        rows.map(async (row) => {
          // Pull richer metadata from game-data.json if the scenario is downloaded.
          let description = '';
          let difficulty: string | null = 'medium';
          let durationMinutes = 60;
          if (row.local_version !== null) {
            try {
              const gd = (await scenarioStore.getGameData(row.uniqid)) as
                | {
                    game?: { description?: string; difficulty?: string; duration_minutes?: number };
                    scenario?: { description?: string };
                    game_meta?: { scenario?: string };
                    description?: string;
                    difficulty?: string;
                    duration_minutes?: number;
                  }
                | null;
              description =
                gd?.game_meta?.scenario ?? gd?.scenario?.description ?? gd?.description ?? gd?.game?.description ?? '';
              difficulty = gd?.difficulty ?? gd?.game?.difficulty ?? 'medium';
              durationMinutes = gd?.duration_minutes ?? gd?.game?.duration_minutes ?? 60;
            } catch (err) {
              console.warn(`[GameList] game-data.json read failed for ${row.uniqid}:`, err);
            }
          }

          const matchedType =
            gameTypeByName.get(row.game_type.toLowerCase()) ?? {
              id: row.game_type,
              name: row.game_type.charAt(0).toUpperCase() + row.game_type.slice(1),
              description: '',
            };

          return {
            id: row.uniqid,
            game_type_id: matchedType.id,
            title: row.title,
            description,
            difficulty,
            duration_minutes: durationMinutes,
            uniqid: row.uniqid,
            available_for_purchase: false,
            game_type: matchedType,
          };
        })
      );

      setScenarios(scenariosWithTypes);
    } catch (error) {
      console.error('Error loading scenarios:', error);
    } finally {
      setLoading(false);
    }
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

  const showAlert = (type: 'success' | 'error', message: string) => {
    setAlert({ show: true, type, message });
  };

  const closeAlert = () => {
    setAlert({ ...alert, show: false });
  };

  const handleLaunchGame = (uniqid: string, title: string, gameTypeName: string) => {
    setPrefill(null);
    setSelectedGame({ uniqid, title, gameTypeName });
    setLaunchModalOpen(true);
  };

  // Core launch: create the launched_game, fan out join_game, navigate to the
  // GamePage. Used by both the wizard (via handleGameLaunch) and the headless
  // Quick Launch path (via headlessLaunch), so the game target is explicit
  // rather than read from `selectedGame`.
  const launchGame = async (
    game: LaunchTarget,
    config: GameConfig,
    deviceSelection: LaunchDeviceSelection
  ) => {
    let launchedGameId: number | null = null;

    // Build the meta KV bag. Pattern is stored as a string (the pattern's
    // identifier), but the server's teams.pattern column expects an int —
    // it represents the pattern *index*, set per team below.
    const meta: Record<string, string | number | boolean | null> = {
      firstChipIndex: config.firstChipIndex.toString(),
      pattern: config.pattern,
      messageDisplayDuration: config.messageDisplayDuration.toString(),
      enigmaImageDisplayDuration: config.enigmaImageDisplayDuration.toString(),
      colorblindMode: config.colorblindMode.toString(),
      autoResetTeam: config.autoResetTeam.toString(),
      delayBeforeReset: config.delayBeforeReset.toString(),
      revealResultsOnInput: (config.revealResultsOnInput ?? true) ? 'true' : 'false',
      autoRegisterTeam: config.autoRegisterTeam ? 'true' : 'false',
      reuseCards: config.reuseCards ? 'true' : 'false',
      selfRegisterTeam: config.selfRegisterTeam ? 'true' : 'false',
      reuseDelayMinutes: (config.reuseDelayMinutes ?? 5).toString(),
      useNamePool: config.useNamePool ? 'true' : 'false',
      visibilityHideDelaySec: (config.visibilityHideDelaySec ?? 10).toString(),
    };
    // Name-pool draw needs audience + language server-side (cloud PHP / LAN
    // Rust read these from meta). language was previously meta-less.
    if (config.namePoolAudience) meta.namePoolAudience = config.namePoolAudience;
    if (config.language) meta.language = config.language;
    if (config.victoryType) meta.victoryType = config.victoryType;
    if (config.testMode) meta.testMode = 'true';
    if (config.playMode) meta.playMode = config.playMode;
    if (config.teammatesPerTeam !== undefined) meta.teammatesPerTeam = config.teammatesPerTeam.toString();
    if (config.teams && config.teams.length > 0) meta.teamsConfig = JSON.stringify(config.teams);
    // Tracks launch selections — persisted to launched_games.meta so they
    // survive reload and reach satellites. Consumed by the tracks runtime
    // (Slice C). Time is carried by the top-level `duration` field below;
    // language flows via the in-memory config like mystery/tagquest.
    if (config.route) meta.route = config.route;
    // Enabled route set → lets the Add Team form offer a per-team route override.
    if (config.tracksRoutes && config.tracksRoutes.length > 0) {
      meta.tracks_routes = config.tracksRoutes.join(',');
    }
    if (config.displayMode) meta.displayMode = config.displayMode;
    if (config.trackPlayMode) meta.trackPlayMode = config.trackPlayMode;
    if (config.scoreType) meta.scoreType = config.scoreType;
    if (config.malusPerMinute !== undefined) meta.malusPerMinute = config.malusPerMinute.toString();

    const teamRows = (config.teams ?? []).map((team, index) => ({
      team_number: index + 1,
      team_name: team.name,
      // Store 0 for now; teams.pattern is the team-specific pattern index,
      // which the gameplay engine assigns at runtime. Most code paths just
      // read the global config.pattern from meta anyway.
      pattern: 0,
      key_id: team.chipId,
    }));

    try {
      const res = await createLaunchedGame({
        game_uniqid: game.uniqid,
        name: config.name,
        // Auto-register builds no roster; the server's create guard rejects
        // <= 0, so send a placeholder. The all-teams-finished auto-end is
        // disabled at runtime (disableAllFinishedEnd), so this is inert.
        number_of_teams: config.autoRegisterTeam || config.selfRegisterTeam ? 1 : config.numberOfTeams,
        game_type: game.gameTypeName,
        duration: config.duration,
        started: false,
        meta,
        teams: teamRows,
        include_self: deviceSelection.include_self,
      });
      launchedGameId = res.id;
      // Fan out join_game to every pre-selected satellite. Server validates
      // each target individually; we don't await/inspect per-target results
      // here because the in-game Devices modal surfaces them anyway as the
      // rows migrate from bucket B → bucket A on the next 2s poll.
      if (deviceSelection.satellite_targets.length > 0 && launchedGameId !== null) {
        try {
          await queueJoinGameCommandBulk(deviceSelection.satellite_targets, launchedGameId);
        } catch (err) {
          console.error('[GameList] queueJoinGameCommandBulk failed:', err);
        }
      }
    } catch (error) {
      console.error('Error creating launched game:', error);
    }

    setLaunchedGame({ config, uniqid: game.uniqid, launchedGameId });
    setLaunchModalOpen(false);
  };

  // Wizard launch — the modal's onLaunch. Targets the scenario the modal was
  // opened for.
  const handleGameLaunch = async (
    config: GameConfig,
    deviceSelection: LaunchDeviceSelection
  ) => {
    if (!selectedGame) return;
    await launchGame(selectedGame, config, deviceSelection);
  };

  // ---- Quick Launch + saved-config orchestration ----

  // Chips already assigned to a team in any active game — can't be reused.
  const collectUsedChipIds = async (): Promise<Set<number>> => {
    const used = new Set<number>();
    try {
      const active = await listActiveLaunchedGames();
      for (const g of active) {
        try {
          const state = await getLaunchedGameState(g.id, 0);
          for (const t of state.teams ?? []) {
            if (t.key_id !== null && t.key_id !== undefined) used.add(t.key_id);
          }
        } catch (err) {
          console.warn('[GameList] state fetch failed for', g.id, err);
        }
      }
    } catch (err) {
      console.error('[GameList] collectUsedChipIds failed:', err);
    }
    return used;
  };

  const frenchStamp = (): string => {
    const now = new Date();
    const date = now.toLocaleDateString('fr-FR');
    const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
  };

  // Open the launch wizard pre-filled with a saved config (Edit, or a headless
  // launch that hit critical drift). Does not launch.
  const openPrefilledWizard = (
    scenario: LaunchTarget,
    config: Partial<GameConfig>,
    name?: string,
    notice?: string
  ) => {
    setConfigModal(null);
    setSelectedGame(scenario);
    setPrefill({ config, name, notice });
    setLaunchModalOpen(true);
  };

  // Headless launch: validate the saved config against the current world; on
  // critical drift fall back to the pre-filled wizard, otherwise build the
  // roster + default device selection and launch straight into the GamePage.
  const headlessLaunch = async (scenario: LaunchTarget, cfgRow: LaunchConfigRow) => {
    const gameTypeLc = scenario.gameTypeName.toLowerCase();
    try {
      const [patternRows, rawGameData, cardRows, scenarioRow, used] = await Promise.all([
        patternStore.list({ gameType: gameTypeLc }),
        scenarioStore.getGameData(scenario.uniqid),
        cardsRepo.list(),
        scenarioStore.get(scenario.uniqid),
        collectUsedChipIds(),
      ]);

      const patterns: PatternOption[] = patternRows.map((r) => ({
        slug: r.pattern_slug ?? r.pattern_uniqid,
        name: r.name || r.pattern_slug || r.pattern_uniqid,
        uniqid: r.pattern_uniqid,
      }));
      const tracksOptions = gameTypeLc === 'tracks' ? extractTracksOptions(rawGameData) : EMPTY_TRACKS_OPTIONS;
      const freeChips = cardRows.filter((c) => !used.has(c.id));
      const scenarioDownloaded = !!scenarioRow && scenarioRow.local_version !== null;

      const { ok, critical, resolved } = validateForHeadless(cfgRow.config, {
        patterns,
        freeChips,
        tracksOptions,
        scenarioDownloaded,
        gameTypeName: scenario.gameTypeName,
      });

      if (!ok) {
        openPrefilledWizard(scenario, cfgRow.config, cfgRow.name, critical.join(' '));
        return;
      }

      const teams = resolved.autoRegisterTeam || resolved.selfRegisterTeam ? [] : buildRoster(resolved, freeChips, scenario.gameTypeName);
      const deviceSelection = await resolveDefaultDeviceSelection();
      setConfigModal(null);
      await launchGame(scenario, { ...resolved, name: `${cfgRow.name} — ${frenchStamp()}`, teams }, deviceSelection);
    } catch (err) {
      console.error('[GameList] headlessLaunch failed:', err);
      // Last-resort fallback: open the pre-filled wizard so the operator can
      // launch manually rather than silently doing nothing.
      openPrefilledWizard(scenario, cfgRow.config, cfgRow.name, 'Could not prepare a quick launch — please review and launch.');
    }
  };

  const openConfigModal = async (scenario: LaunchTarget) => {
    if (!user?.client_id) return;
    try {
      const configs = await launchConfigsStore.listForScenario(user.client_id, scenario.uniqid);
      setConfigModal({ scenario, configs });
    } catch (err) {
      console.error('[GameList] openConfigModal failed:', err);
    }
  };

  // Main split-button action: 1 config → headless; >1 → open the picker.
  const handleQuickLaunch = async (scenario: LaunchTarget) => {
    if (!user?.client_id) return;
    try {
      const configs = await launchConfigsStore.listForScenario(user.client_id, scenario.uniqid);
      if (configs.length === 1) {
        await headlessLaunch(scenario, configs[0]);
      } else if (configs.length > 1) {
        setConfigModal({ scenario, configs });
      }
    } catch (err) {
      console.error('[GameList] handleQuickLaunch failed:', err);
    }
  };

  const handleDeleteConfig = async (cfg: LaunchConfigRow) => {
    if (!user?.client_id) return;
    try {
      await launchConfigsStore.deleteConfig(user.client_id, cfg.id);
      await loadConfigCounts();
      // Refresh the open modal's list (and close it if it emptied).
      if (configModal) {
        const configs = await launchConfigsStore.listForScenario(user.client_id, configModal.scenario.uniqid);
        if (configs.length === 0) setConfigModal(null);
        else setConfigModal({ scenario: configModal.scenario, configs });
      }
    } catch (err) {
      console.error('[GameList] handleDeleteConfig failed:', err);
    }
  };

  const handleBackToList = () => {
    setLaunchedGame(null);
  };

  const handleDeleteClick = (uniqid: string, title: string) => {
    setScenarioToDelete({ uniqid, title });
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = async () => {
    const target = scenarioToDelete;
    setDeleteConfirmOpen(false);
    setScenarioToDelete(null);
    if (!target) return;
    try {
      // Local delete: drops the row + downloaded files. Not permanent — the
      // next sync re-adds the scenario from the manifest and re-downloads it.
      // Works for any scenario, including ones that never finished
      // downloading (e.g. a mystery scenario stuck on failed attempts).
      await scenarioStore.deleteScenario(target.uniqid);
      await loadScenarios();
      await loadLocalGames();
      showAlert('success', `"${target.title}" was deleted. It will be downloaded again on the next sync.`);
    } catch (err) {
      console.error('[GameList] failed to delete scenario:', err);
      showAlert('error', `Could not delete "${target.title}". Please try again.`);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirmOpen(false);
    setScenarioToDelete(null);
  };

  const renderScenarioCard = (scenario: ScenarioWithType) => {
    const localImageUrl = (scenario.uniqid && localImages.get(scenario.uniqid)) || null;
    const isAvailableForPurchase = scenario.available_for_purchase;
    const activeGame = scenario.uniqid ? activeGames.get(scenario.uniqid) : undefined;
    const configCount = scenario.uniqid ? (configCounts.get(scenario.uniqid) ?? 0) : 0;
    const launchTarget: LaunchTarget = {
      uniqid: scenario.uniqid || '',
      title: scenario.title,
      gameTypeName: scenario.game_type.name,
    };

    return (
      <div
        key={scenario.id}
        className="bg-slate-800 rounded-xl shadow-xl overflow-hidden border border-slate-700 hover:border-slate-600 transition group"
      >
        <div className="w-full h-48 overflow-hidden bg-slate-700 relative">
          <ScenarioThumbnail
            imageUrl={localImageUrl}
            gameTypeName={scenario.game_type.name}
            title={scenario.title}
          />
          {isAvailableForPurchase && (
            <div className="absolute top-3 right-3 bg-amber-500/90 backdrop-blur-sm px-3 py-1 rounded-full text-xs font-bold text-white shadow-lg">
              Available for Purchase
            </div>
          )}
        </div>
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
            {scenario.title || 'Untitled scenario'}
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
              <button
                onClick={() => setDetailsScenario(scenario)}
                className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg transition font-medium text-sm border border-slate-600"
                title="View scenario details"
              >
                <Eye size={16} />
              </button>
              {!isAvailableForPurchase && scenario.uniqid && !activeGame && (
                <button
                  onClick={() => handleDeleteClick(scenario.uniqid || '', scenario.title || 'Untitled scenario')}
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
                <>
                  <button
                    onClick={() => handleLaunchGame(scenario.uniqid || '', scenario.title, scenario.game_type.name)}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg transition font-medium text-sm"
                    title="Launch (full options)"
                  >
                    <Play size={16} />
                  </button>
                  {/* Quick Launch split button — only when this scenario has
                      saved configs. Main: 1 config → headless, >1 → picker.
                      Caret: always opens the picker/manage modal. */}
                  {configCount > 0 && (
                    <div className="flex items-stretch rounded-lg overflow-hidden">
                      <button
                        onClick={() => void handleQuickLaunch(launchTarget)}
                        className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white transition font-medium text-sm"
                        title="Quick launch from a saved configuration"
                      >
                        <Zap size={16} />
                        Quick
                      </button>
                      <button
                        onClick={() => void openConfigModal(launchTarget)}
                        className="px-2 py-2 bg-blue-700 hover:bg-blue-600 text-white transition border-l border-blue-500/40"
                        title="Manage saved configurations"
                      >
                        <ChevronDown size={16} />
                      </button>
                    </div>
                  )}
                </>
              ) : null}
              {isAvailableForPurchase && (
                <a
                  href="https://studio.taghunter.fr"
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

      <LaunchGameModal
        isOpen={launchModalOpen}
        onClose={() => {
          setLaunchModalOpen(false);
          setPrefill(null);
        }}
        gameTitle={selectedGame?.title || ''}
        gameUniqid={selectedGame?.uniqid || ''}
        gameTypeName={selectedGame?.gameTypeName || ''}
        onLaunch={handleGameLaunch}
        prefillConfig={prefill?.config}
        prefillConfigName={prefill?.name}
        noticeText={prefill?.notice}
        onConfigSaved={(name) => {
          void loadConfigCounts();
          showAlert('success', `Configuration “${name}” saved.`);
        }}
      />

      {configModal && (
        <LaunchConfigModal
          isOpen={true}
          onClose={() => setConfigModal(null)}
          scenario={configModal.scenario}
          configs={configModal.configs}
          onLaunch={(cfg) => void headlessLaunch(configModal.scenario, cfg)}
          onEdit={(cfg) => openPrefilledWizard(configModal.scenario, cfg.config, cfg.name)}
          onDelete={(cfg) => void handleDeleteConfig(cfg)}
        />
      )}

      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        title="Delete Scenario"
        message={`Delete "${scenarioToDelete?.title}" from this playground? Its downloaded files are removed now. It will be downloaded again on the next sync.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
      />

      {detailsScenario && (
        <ScenarioDetailsModal
          scenario={detailsScenario}
          thumbnailUrl={(detailsScenario.uniqid && localImages.get(detailsScenario.uniqid)) || null}
          onClose={() => setDetailsScenario(null)}
        />
      )}
    </div>
  );
}
