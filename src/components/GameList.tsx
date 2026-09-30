import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Search, Play, LogIn, Eye, Zap, ChevronDown, LayoutGrid, List } from 'lucide-react';
import { Alert } from './Alert';
import { ConfirmDialog } from './ConfirmDialog';
import { LaunchGameModal, GameConfig, LaunchDeviceSelection } from './LaunchGameModal';
import { LaunchConfigModal } from './LaunchConfigModal';
import { GamePage } from './GamePage';
import { PinExitPrompt } from './PinExitPrompt';
import { hasPin } from '../services/pinStore';
import { ScenarioThumbnail } from './ScenarioThumbnail';
import { ScenarioDetailsModal } from './ScenarioDetailsModal';
import { GameTypeIcon } from './icons/GameTypeIcons';
import { GameLockGate } from './GameLockGate';
import { getDeviceLockState, type LockReason } from '../services/deviceLock';
import { getLocalGameIds } from '../utils/localGames';
import * as scenarioStore from '../services/scenarioStore';
import * as patternStore from '../services/patternStore';
import * as cardsRepo from '../services/cardsRepo';
import * as launchConfigsStore from '../services/launchConfigsStore';
import type { LaunchConfigRow } from '../services/launchConfigsStore';
import {
  validateForHeadless,
  buildRoster,
  buildClashContiguousAssignments,
  resolveDefaultDeviceSelection,
  extractTracksOptions,
  extractDefaultPatternId,
  EMPTY_TRACKS_OPTIONS,
  type PatternOption,
} from '../services/launchResolve';
import { scenarioAssetUrl } from '../services/contentFs';
import { gameTypeLabel, normalizeAudience } from '../utils/labels';
import { AUDIENCE_BANDS, bandLabel, resolveBands, type AudienceBand } from '../utils/audienceBands';
import { on as onSyncEvent } from '../services/syncEvents';
import { setGameActive } from '../services/activeSession';
import {
  createLaunchedGame,
  listActiveLaunchedGames,
  getLaunchedGameMeta,
  getLaunchedGameState,
  listLaunchDevices,
  mergeLaunchedGameMeta,
  queueJoinGameCommandBulk,
  updateTeam,
} from '../services/launchedGames';
import {
  computeAutoRegAssignments,
  serializeRegAssignments,
  REG_ASSIGNMENTS_META_KEY,
} from '../services/regAssignments';
import { getClashState, clashRegister, DEFAULT_CLASH_PURGE_STATION } from '../services/clash';
import { useAuth } from './auth/AuthProvider';
import { isOperatorOnly } from '../services/operatorMode';
import { refreshLaunchedGamesRoute } from '../services/childControlLink';
import { ensureMotherServer, raiseMotherHotspotIfConfigured } from '../services/lanMotherBoot';
import { getLanOverride } from '../services/api';
import { loadConfig, saveConfig } from '../utils/config';
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
  /** Normalized audience (game_meta.game_public): mini_kids | kids | ado_adultes.
   *  Single tier - used for the server-side name-pool draw. */
  audience: string | null;
  /** Authored age bands (game_meta.audience_bands). Drives the audience filter
   *  pills, which use the same six ranges as the studio catalog. */
  audienceBands: AudienceBand[];
  /** Free-text univers/theme tags (game_meta.univers). Display only. */
  univers: string[];
  uniqid?: string;
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

// Parse a Clash pattern's data into an ordered list of combos' station codes -
// Difficulty is an integer 1–5 (stars). Coerce stored values: new int, numeric
// string, or legacy enum slug (easy→1 / medium→3 / hard→5). Unset → 3.
function coerceDifficulty(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return clampDifficulty(Math.round(raw));
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return 3;
  if (/^-?\d+(\.\d+)?$/.test(s)) return clampDifficulty(Math.round(Number(s)));
  if (s === 'easy' || s === 'simple' || s === 'facile') return 1;
  if (s === 'hard' || s === 'difficult' || s === 'expert' || s === 'difficile') return 5;
  return 3; // medium / normal / moyen / unknown
}
function clampDifficulty(n: number): number {
  return n < 1 ? 1 : n > 5 ? 5 : n;
}

function DifficultyMeter({ level }: { level: number }) {
  return (
    <span className="pg-stars" aria-hidden style={{ display: 'inline-flex', gap: 1, lineHeight: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{ color: '#f59e0b', opacity: i <= level ? 1 : 0.25, fontSize: '0.85em' }}>
          ★
        </span>
      ))}
    </span>
  );
}

interface GameListProps {
  /** Navigate to the launched-games list (App-level page switch). Used after a
   *  launch where this device wasn't selected to run the game. */
  onShowLaunchedGames?: () => void;
}

export function GameList({ onShowLaunchedGames }: GameListProps = {}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [scenarios, setScenarios] = useState<ScenarioWithType[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGameType, setSelectedGameType] = useState<string>('all');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('all');
  const [selectedAudience, setSelectedAudience] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [alert, setAlert] = useState<AlertState>({ show: false, type: 'success', message: '' });
  const [localGameIds, setLocalGameIds] = useState<Set<string>>(new Set());
  // Device-lock gate (project_client_device_lock): when launching/joining is
  // blocked, we stash the attempted action and show the recovery-code gate; a
  // successful reprieve re-runs it (the guard then passes through).
  const [lockGate, setLockGate] = useState<{ reason: Exclude<LockReason, null>; run: () => void } | null>(null);
  const [launchModalOpen, setLaunchModalOpen] = useState(false);
  const [selectedGame, setSelectedGame] = useState<LaunchTarget | null>(null);
  const [launchedGame, setLaunchedGame] = useState<{ config: GameConfig; uniqid: string; launchedGameId: number | null } | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [scenarioToDelete, setScenarioToDelete] = useState<{ uniqid: string; title: string } | null>(null);
  // After the operator confirms deletion, if a device PIN is set we hold the
  // target here and require the PIN before the scenario is actually removed.
  const [deletePinGate, setDeletePinGate] = useState<{ uniqid: string; title: string } | null>(null);
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
  // Operator-only devices never play, so the "Join" (enter the running game on
  // this device) action is hidden.
  const [operatorOnly, setOperatorOnly] = useState(false);
  // F1 (mother/hotspot role rework): when "Launch" is tapped and no mother is
  // reachable, this device must host. We surface a heads-up confirm first; the
  // resolver bridges the dialog buttons back to the awaiting launchGame call.
  const [motherPrompt, setMotherPrompt] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const confirmBecomeMother = () =>
    new Promise<boolean>((resolve) => setMotherPrompt({ resolve }));

  useEffect(() => {
    void isOperatorOnly().then(setOperatorOnly).catch(() => setOperatorOnly(false));
    const onChange = () => void isOperatorOnly().then(setOperatorOnly).catch(() => {});
    window.addEventListener('operator-mode:changed', onChange);
    return () => window.removeEventListener('operator-mode:changed', onChange);
  }, []);

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

  // Block launching/joining when the device is locked. Returns true if it
  // opened the gate (caller should bail); false if the action may proceed.
  const blockedByLock = async (run: () => void): Promise<boolean> => {
    const lock = await getDeviceLockState();
    if (lock.locked && lock.reason) {
      setLockGate({ reason: lock.reason, run });
      return true;
    }
    return false;
  };

  const handleJoinGame = async (uniqid: string) => {
    if (await blockedByLock(() => void handleJoinGame(uniqid))) return;

    const active = activeGames.get(uniqid);
    if (!active) return;

    // The entire in-game config below is read off this map, and every lookup
    // treats a missing key as "off" - so an empty map silently produces a
    // confidently-wrong config (a TagQuest self-register game joined this way
    // would skip the registration screen AND auto-start). Retry, and refuse to
    // enter rather than enter with a fabricated config.
    let meta: Record<string, string> = {};
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        meta = await getLaunchedGameMeta(active.id);
      } catch (err) {
        console.error('[GameList] failed to load meta for join:', err);
      }
      if (Object.keys(meta).length > 0) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (Object.keys(meta).length === 0) {
      console.error('[GameList] join aborted - launched-game meta unreadable', active.id);
      showAlert('error', t('home:joinFailed'));
      return;
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
      autoResetTeam: meta.autoResetTeam !== 'false',
      delayBeforeReset: parseInt(meta.delayBeforeReset ?? '3'),
      enterToReset: meta.enterToReset === 'true',
      showIdleLayout: meta.showIdleLayout !== 'false',
      idleSubtitle: meta.idleSubtitle ?? undefined,
      malusPerMinute: meta.malusPerMinute != null ? parseInt(meta.malusPerMinute) : undefined,
      autoRegisterTeam: meta.autoRegisterTeam === 'true',
      reuseCards: meta.reuseCards === 'true',
      selfRegisterTeam: meta.selfRegisterTeam === 'true',
      reuseDelayMinutes: parseInt(meta.reuseDelayMinutes ?? '5'),
      useNamePool: meta.useNamePool === 'true',
      namePoolAudience: (meta.namePoolAudience as GameConfig['namePoolAudience']) ?? undefined,
      addRandomNameOption: meta.addRandomNameOption === 'true',
      allowPlayerLanguageChoice: meta.allowPlayerLanguageChoice === 'true',
      scenarioLanguages: meta.availableLanguages ? meta.availableLanguages.split(',') : undefined,
      language: meta.language ?? undefined,
      visibilityHideDelaySec: parseInt(meta.visibilityHideDelaySec ?? '10'),
      victoryType: (meta.victoryType as GameConfig['victoryType']) ?? undefined,
      playMode: (meta.playMode as GameConfig['playMode']) ?? undefined,
      tagquestSelfRegister: meta.tagquestSelfRegister === 'true',
      tagquestShowQuestPreview: meta.tagquestShowQuestPreview !== 'false',
      tagquestShowMissingStations: meta.tagquestShowMissingStations !== 'false',
      tagquestScoreWeighting: meta.tagquestScoreWeighting === 'true',
      teammatesPerTeam: meta.teammatesPerTeam ? parseInt(meta.teammatesPerTeam) : undefined,
      testMode: meta.testMode === 'true' ? true : undefined,
      teams: meta.teamsConfig ? JSON.parse(meta.teamsConfig) : undefined,
      cluesPage: meta.cluesPage ? JSON.parse(meta.cluesPage) : undefined,
      // First-bip videos (mystery/tracks): a joining device must resolve and
      // play them locally too, not just the launcher.
      playTutorialOnBip: meta.playTutorialOnBip === 'true',
      playIntroOnBip: meta.playIntroOnBip === 'true',
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
        // Resolve to a `scenario://` URL - the custom protocol is the only one
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
          let audience: string | null = null;
          let audienceBands: AudienceBand[] = [];
          let univers: string[] = [];
          if (row.local_version !== null) {
            try {
              const gd = (await scenarioStore.getGameData(row.uniqid)) as
                | {
                    game?: { description?: string; difficulty?: string; duration_minutes?: number };
                    scenario?: { description?: string };
                    game_meta?: {
                      description?: string;
                      story?: string;
                      scenario?: string;
                      difficulty?: string | number;
                      game_public?: string;
                      audience_bands?: unknown;
                      univers?: unknown;
                    };
                    description?: string;
                    difficulty?: string | number;
                    duration_minutes?: number;
                  }
                | null;
              // Studio writes the authored description to game_meta.description
              // (default-lang string after the cloud compat flatten); fall back
              // to the story field, then the legacy `scenario`/top-level paths.
              description =
                gd?.game_meta?.description ??
                gd?.game_meta?.story ??
                gd?.game_meta?.scenario ??
                gd?.scenario?.description ??
                gd?.description ??
                gd?.game?.description ??
                '';
              // Studio writes the authored difficulty (int 1–5) to
              // game_meta.difficulty; fall back to the legacy top-level paths.
              difficulty = String(gd?.game_meta?.difficulty ?? gd?.difficulty ?? gd?.game?.difficulty ?? 'medium');
              durationMinutes = gd?.duration_minutes ?? gd?.game?.duration_minutes ?? 60;
              // Audience: game_public (single tier) feeds the server-side name
              // draw; the age bands feed the filter pills + display. Un-backfilled
              // rows fall back to bands derived from the tier.
              audience = gd?.game_meta?.game_public ? normalizeAudience(gd.game_meta.game_public) : null;
              audienceBands = resolveBands(gd?.game_meta?.audience_bands, audience);
              univers = Array.isArray(gd?.game_meta?.univers)
                ? (gd!.game_meta!.univers as unknown[]).filter((u): u is string => typeof u === 'string' && u.trim() !== '')
                : [];
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
            audience,
            audienceBands,
            univers,
            uniqid: row.uniqid,
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
      const matchesDifficulty =
        selectedDifficulty === 'all' || coerceDifficulty(scenario.difficulty) === Number(selectedDifficulty);
      // A scenario matches an age pill if it targets that band.
      const matchesAudience =
        selectedAudience === 'all' || scenario.audienceBands.includes(selectedAudience as AudienceBand);
      return matchesSearch && matchesType && matchesDifficulty && matchesAudience;
    })
    .sort((a, b) => {
      const aHasLocal = localGameIds.has(a.uniqid || '');
      const bHasLocal = localGameIds.has(b.uniqid || '');
      if (aHasLocal && !bHasLocal) return -1;
      if (!aHasLocal && bHasLocal) return 1;
      return 0;
    });


  const gameTypes = [...new Set(scenarios.map((s) => s.game_type.name))];
  // Age bands actually present among loaded scenarios, in canonical young→old
  // order - the same six ranges the studio catalog uses.
  const presentBands = new Set(scenarios.flatMap((s) => s.audienceBands));
  const audiences = AUDIENCE_BANDS.map((b) => b.value).filter((b) => presentBands.has(b));
  const audienceLabel = (band: AudienceBand): string => bandLabel(band, t);

  const showAlert = (type: 'success' | 'error', message: string) => {
    setAlert({ show: true, type, message });
  };

  const closeAlert = () => {
    setAlert({ ...alert, show: false });
  };

  const handleLaunchGame = (uniqid: string, title: string, gameTypeName: string) => {
    void blockedByLock(() => handleLaunchGame(uniqid, title, gameTypeName)).then((blocked) => {
      if (blocked) return;
      setPrefill(null);
      setSelectedGame({ uniqid, title, gameTypeName });
      setLaunchModalOpen(true);
    });
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
    // F1: a launched game must live on a mother. If none is reachable and we're
    // not already hosting, become the mother on THIS device (after a heads-up
    // confirm) before creating the game - otherwise the create call has nowhere
    // to go. If a mother IS reachable, this is a no-op and we launch remotely.
    {
      const route = await refreshLaunchedGamesRoute().catch(() => 'local' as const);
      const override = getLanOverride();
      const alreadyHosting = !!override && override.baseUrl.includes('127.0.0.1');
      if (route !== 'mother' && !alreadyHosting) {
        const ok = await confirmBecomeMother();
        if (!ok) return;
        const cid = user?.client_id;
        if (cid != null) {
          const info = await ensureMotherServer(cid);
          if (info) {
            await raiseMotherHotspotIfConfigured();
            // Keep the role across restarts now that this device is the mother.
            try {
              const cfg = await loadConfig();
              await saveConfig({ ...cfg, beMotherWhenAvailable: true });
            } catch {
              /* best-effort */
            }
          } else {
            // Stood down - a mother actually exists (fence caught it). Re-point
            // at it and launch there instead.
            await refreshLaunchedGamesRoute().catch(() => {});
          }
        }
      }
    }

    let launchedGameId: number | null = null;

    // Build the meta KV bag. Pattern is stored as a string (the pattern's
    // identifier), but the server's teams.pattern column expects an int -
    // it represents the pattern *index*, set per team below.
    const meta: Record<string, string | number | boolean | null> = {
      firstChipIndex: config.firstChipIndex.toString(),
      pattern: config.pattern,
      // Stored in meta (in addition to the top-level launched_games.duration
      // column) so re-derive paths (LaunchedGamesList) recover the time limit -
      // used by mystery late-malus scoring.
      duration: config.duration.toString(),
      messageDisplayDuration: config.messageDisplayDuration.toString(),
      enigmaImageDisplayDuration: config.enigmaImageDisplayDuration.toString(),
      colorblindMode: config.colorblindMode.toString(),
      autoResetTeam: config.autoResetTeam.toString(),
      delayBeforeReset: config.delayBeforeReset.toString(),
      enterToReset: (config.enterToReset ?? false) ? 'true' : 'false',
      autoRegisterTeam: config.autoRegisterTeam ? 'true' : 'false',
      reuseCards: config.reuseCards ? 'true' : 'false',
      selfRegisterTeam: config.selfRegisterTeam ? 'true' : 'false',
      // Mystery/tracks "Départ groupé": the whole roster is stamped started at
      // launch (below). Persisted so satellites / rejoin / in-game surfaces can
      // tell a mass-start game apart from a staggered one.
      massStart: config.massStart ? 'true' : 'false',
      reuseDelayMinutes: (config.reuseDelayMinutes ?? 5).toString(),
      useNamePool: config.useNamePool ? 'true' : 'false',
      // Self-register sub-options: random-name button + per-team language flags
      // in the registration overlay. Read at runtime by the self-register pages.
      addRandomNameOption: config.addRandomNameOption ? 'true' : 'false',
      allowPlayerLanguageChoice: config.allowPlayerLanguageChoice ? 'true' : 'false',
      visibilityHideDelaySec: (config.visibilityHideDelaySec ?? 10).toString(),
      // TagQuest: players bind their chip to a team at game start (Clash-style)
      // instead of the operator pre-building the roster. Read at runtime by
      // TagQuestGamePage to show the registration screen.
      tagquestSelfRegister: config.tagquestSelfRegister ? 'true' : 'false',
      // TagQuest: low-opacity ghost preview of the quest images on each bip.
      // Audience-defaulted at launch; missing key reads as true downstream.
      tagquestShowQuestPreview: (config.tagquestShowQuestPreview ?? true) ? 'true' : 'false',
      // TagQuest: draw the visual of a station still missing from a partial
      // combination. Missing key reads as true downstream.
      tagquestShowMissingStations: (config.tagquestShowMissingStations ?? true) ? 'true' : 'false',
      // TagQuest: effectif weighting of earned points (score+team mode only).
      // Default on for new launches; a MISSING key reads as off downstream so
      // games launched before the option existed keep their raw scores.
      tagquestScoreWeighting: (config.tagquestScoreWeighting ?? true) ? 'true' : 'false',
      // Mystery/tracks first-bip videos. Persisted so EVERY device that
      // re-derives the config from meta keeps them: satellites joining the
      // mother's game, the mother re-entering via Play, and any device after an
      // in-game config edit (reload_config). Without these keys the overlay only
      // ever fired on the launching device, which still held the in-memory
      // config. Missing key ⇒ false, so pre-existing games are unaffected.
      playTutorialOnBip: config.playTutorialOnBip ? 'true' : 'false',
      playIntroOnBip: config.playIntroOnBip ? 'true' : 'false',
    };
    // Name-pool draw needs audience + language server-side (cloud PHP / LAN
    // Rust read these from meta). language was previously meta-less.
    if (config.namePoolAudience) meta.namePoolAudience = config.namePoolAudience;
    if (config.language) meta.language = config.language;
    // The scenario's available languages - read back at runtime so the
    // self-register overlay can offer the player-language flag radios.
    if (config.scenarioLanguages && config.scenarioLanguages.length > 0) {
      meta.availableLanguages = config.scenarioLanguages.join(',');
    }
    if (config.victoryType) meta.victoryType = config.victoryType;
    if (config.testMode) meta.testMode = 'true';
    if (config.playMode) meta.playMode = config.playMode;
    if (config.teammatesPerTeam !== undefined) meta.teammatesPerTeam = config.teammatesPerTeam.toString();
    if (config.teams && config.teams.length > 0) meta.teamsConfig = JSON.stringify(config.teams);
    // Tracks launch selections - persisted to launched_games.meta so they
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
    // Mystery idle-screen layout: whether to show the author-placed title/subtitle
    // on the between-teams screen, plus the per-launch subtitle text under the title.
    if (config.showIdleLayout === false) meta.showIdleLayout = 'false';
    if (config.idleSubtitle) meta.idleSubtitle = config.idleSubtitle;
    // Clues page on team return - now a per-launch option (was a studio scenario
    // setting). Persisted as JSON so it survives reload and reaches satellites.
    if (config.cluesPage) meta.cluesPage = JSON.stringify(config.cluesPage);

    const teamRows = (config.teams ?? []).map((team, index) => ({
      team_number: index + 1,
      team_name: team.name,
      // Store 0 for now; teams.pattern is the team-specific pattern index,
      // which the gameplay engine assigns at runtime. Most code paths just
      // read the global config.pattern from meta anyway.
      pattern: 0,
      key_id: team.chipId,
      // Per-team display language: the operator's manual-roster pick, else the
      // launch language. null lets the runtime fall back to the launch language.
      language: team.language ?? config.language ?? null,
    }));

    // ── Clash: one clan = one team row; the clash_config meta carries the
    // territory/combination skeleton (from the scenario) + balise→combination
    // station assignments (from the selected pattern) + the per-clan cap. The
    // mother reads clash_config in clash_register / clash_validate.
    let finalTeams: Array<{
      team_number: number;
      team_name?: string | null;
      pattern: number;
      key_id?: number | null;
      language?: string | null;
    }> = teamRows;
    let finalNumberOfTeams =
      config.autoRegisterTeam || config.selfRegisterTeam ? 1 : config.numberOfTeams;
    // Clash "Équipes prédéfinies": contiguous chip→clan blocks dealt here and
    // applied after createLaunchedGame (clans/team_ids only exist post-launch).
    let clashPredeterminedAssignments: Array<{ chipId: number; clanIndex: number }> = [];
    const isClashLaunch = game.gameTypeName?.toLowerCase() === 'clash';
    if (isClashLaunch) {
      try {
        const gd = (await scenarioStore.getGameData(game.uniqid)) as { game_data?: any } | any | null;
        const gdRoot = gd?.game_data ?? gd;
        const gm = gdRoot?.game_meta ?? gdRoot ?? {};
        const territoriesMeta: any[] = Array.isArray(gm.territories) ? gm.territories : [];
        const clansMeta: any[] = Array.isArray(gm.clans) ? gm.clans : [];

        // Balises are authored (studio + launch grid) as station NUMBERS (the
        // si_balises.station_name label, e.g. "1"), but SI punches carry the
        // station id (si_balises.id, e.g. 31) - the same convention as pattern
        // assignments. Resolve numbers → ids here, ONCE, via the inventory map
        // the studio ships inside the scenario game data; clash_config and the
        // mother's punch matching then live entirely in id space. Numbers
        // missing from the map pass through raw (older synced scenarios / ZIP
        // imports without the map, or venues whose stations are programmed
        // with the literal number).
        const stationIdByNumber: Record<string, number> = {};
        const rawStationMap = gdRoot?.station_ids_by_number;
        if (rawStationMap && typeof rawStationMap === 'object') {
          for (const [name, id] of Object.entries(rawStationMap as Record<string, unknown>)) {
            const idNum = Number(id);
            if (!Number.isNaN(idNum)) stationIdByNumber[name] = idNum;
          }
        }
        const resolveStation = (n: number): number => stationIdByNumber[String(n)] ?? n;

        // V2: each territory carries its balise station numbers inline. The
        // launch-time override grid (config.clashBalises) takes precedence per
        // venue; fall back to the scenario's authored balises otherwise.
        const territories = territoriesMeta.map((t, ti) => {
          const override = config.clashBalises?.[ti];
          const scenarioBalises: number[] = Array.isArray(t.balises)
            ? t.balises.map((x: unknown) => Number(x)).filter((n: number) => !Number.isNaN(n))
            : [];
          const authoredNumbers = override && override.length ? override : scenarioBalises;
          return {
            index: ti,
            points: parseInt(String(t.points ?? '0'), 10) || 0,
            balises: authoredNumbers.map(resolveStation),
            // Keep the authored NUMBERS alongside the resolved ids, positionally
            // paired. The mother uses them to tell a team which balises it is
            // still missing in the numbers printed on them (retours #96) -
            // nothing on the wire ever showed the player-facing label before.
            balise_numbers: authoredNumbers,
          };
        });

        // The Purge - enabled only when the launch says so AND the scenario has
        // a purge image (no built-in fallback marker). Defensive re-check of the
        // station collision here too (the modal hard-blocks it, but saved-config
        // paths could carry a stale station): a collision disables the purge
        // rather than corrupting validation.
        // The purge station is authored as a station number too - resolve it
        // through the same map so the collision check below and the mother's
        // punch matching compare like with like (id space).
        // Headless/saved-config launches may carry no station at all - fall back
        // to the scenario's authored one (retours #50), then to the historic 25.
        const authoredPurgeStation = parseInt(String(gm.purge_station ?? ''), 10);
        const purgeStation = resolveStation(
          config.clashPurgeStation ??
            (Number.isFinite(authoredPurgeStation) && authoredPurgeStation > 0
              ? authoredPurgeStation
              : DEFAULT_CLASH_PURGE_STATION),
        );
        const hasPurgeImage = typeof gm.purge_image === 'string' && gm.purge_image.length > 0;
        let purgeEnabled = !!config.clashPurgeEnabled && hasPurgeImage;
        if (purgeEnabled && territories.some((t) => t.balises.includes(purgeStation))) {
          console.warn(`[Clash] purge station ${purgeStation} collides with a territory balise - The Purge is disabled for this launch.`);
          purgeEnabled = false;
        }

        const clashConfig = {
          territories,
          // The cap only governs live self-registration (the launch modal hides
          // it in 'bulk'). Sending a stale value there would make clash_register
          // silently refuse chips past it - including ones the operator dealt or
          // added by hand on step 2.
          max_per_clan:
            (config.clashRegistrationMode ?? 'self') === 'bulk' ? 0 : config.clashMaxPerClan ?? 0,
          purge_enabled: purgeEnabled,
          purge_station: purgeStation,
        };
        meta.clash_config = JSON.stringify(clashConfig);
        if (config.clashRegistrationMode) meta.clashRegistrationMode = config.clashRegistrationMode;

        const numClans = Math.max(2, Math.min(config.clashNumClans ?? clansMeta.length ?? 2, 4));
        finalTeams = Array.from({ length: numClans }, (_, i) => {
          const cn = clansMeta[i]?.name;
          const name =
            typeof cn === 'string'
              ? cn
              : cn && typeof cn === 'object'
                ? (cn[config.language ?? 'fr'] ?? Object.values(cn)[0] ?? `Clan ${i + 1}`)
                : `Clan ${i + 1}`;
          return {
            team_number: i + 1,
            team_name: String(name),
            pattern: 0,
            key_id: null as number | null,
            language: config.language ?? null,
          };
        });
        finalNumberOfTeams = numClans;

        // Équipes prédéfinies (clashRegistrationMode==='bulk'): deal a uniform
        // contiguous block of chips to each clan from the free card list, so the
        // post-create clashRegister loop populates the clans - the same path the
        // Excel chip→clan import uses. A manual import wins if the operator set one.
        if ((config.clashRegistrationMode ?? 'self') === 'bulk' && (config.clashChipAssignments?.length ?? 0) === 0) {
          try {
            const [cards, used] = await Promise.all([cardsRepo.list(), collectUsedChipIds()]);
            const free = cards.filter((c) => !used.has(c.id));
            clashPredeterminedAssignments = buildClashContiguousAssignments(
              free,
              config.firstChipIndex,
              // Same default the launch modal shows (10/clan) - a bulk config
              // that never carried the field would otherwise deal nothing and
              // launch with empty clans.
              config.clashChipsPerClan ?? 10,
              numClans,
            );
          } catch (err) {
            console.error('[Clash] predetermined assignment build failed:', err);
          }
        }

        if (territories.every((t) => t.balises.length === 0)) {
          console.warn('[Clash] no territory balises found - validation will credit nothing until territories have station codes (author them in the scenario or set them in the launch grid).');
        }
      } catch (err) {
        console.error('[Clash] failed to assemble clash_config', err);
      }
    }

    // ── TagQuest self-register: no operator-built roster. Team mode pre-creates
    // one named team row per team (key_id null) and reuses the clash_config
    // per-team cap so the mother enforces it in clash_register - players bind
    // their chip to a team on the registration screen. Solo mode creates no
    // teams up front; each bipped chip enrols itself as its own team at runtime.
    const isTagQuestSelfReg =
      game.gameTypeName?.toLowerCase() === 'tagquest' && !!config.tagquestSelfRegister;
    if (isTagQuestSelfReg) {
      if (config.playMode === 'team') {
        const numTeams = Math.max(1, config.numberOfTeams);
        finalTeams = Array.from({ length: numTeams }, (_, i) => ({
          team_number: i + 1,
          team_name: config.tagquestTeamNames?.[i] || `Équipe ${i + 1}`,
          pattern: 0,
          key_id: null as number | null,
          language: config.language ?? null,
        }));
        finalNumberOfTeams = numTeams;
        meta.clash_config = JSON.stringify({
          territories: [],
          max_per_clan: config.tagquestMaxPerTeam ?? 0,
        });
      } else {
        // Solo: empty roster + placeholder count (the create guard rejects <= 0).
        finalTeams = [];
        finalNumberOfTeams = 1;
      }
    }

    // ── Station-based self-register: persist the device→teams registration
    // assignment (each assigned device becomes a hard-locked kiosk for its
    // teams; unassigned devices keep the pick-any-team grid). The wizard always
    // passes a resolved map - EMPTY when its "Affecter des équipes aux
    // appareils" toggle is off, which must stay empty. Only a MISSING map means
    // nobody decided (the headless Quick Launch path), and only then do we
    // auto-assign over every participating device, mirroring the wizard's
    // default deal. Testing truthiness here instead of `undefined` silently
    // auto-dealt with the toggle off, making it a no-op.
    // Design: project_selfregister_team_device_assignment.
    const regAssignQualifies =
      (isClashLaunch && (config.clashRegistrationMode ?? 'self') === 'self') ||
      (isTagQuestSelfReg && config.playMode === 'team');
    if (regAssignQualifies) {
      let regMap = deviceSelection.reg_assignments;
      if (regMap === undefined) {
        try {
          const { devices: rows, selfId } = await listLaunchDevices();
          const targets = new Set(deviceSelection.satellite_targets);
          // Every participating device is dealt teams - this device first when
          // it takes part, then the selected satellites. Mirrors the wizard's
          // deal (no reader filter: the flag is only meaningful while online).
          const eligibleIds = [
            ...(deviceSelection.include_self && selfId !== null ? [selfId] : []),
            ...rows.filter((r) => r.id !== selfId && targets.has(r.id)).map((r) => r.id),
          ];
          regMap = computeAutoRegAssignments(eligibleIds, finalNumberOfTeams);
        } catch (err) {
          console.error('[GameList] reg-assignment auto-deal failed:', err);
          regMap = {};
        }
      }
      const serialized = serializeRegAssignments(regMap);
      if (serialized !== '{}') meta[REG_ASSIGNMENTS_META_KEY] = serialized;
    }

    try {
      const res = await createLaunchedGame({
        game_uniqid: game.uniqid,
        name: config.name,
        // Auto-register builds no roster; the server's create guard rejects
        // <= 0, so send a placeholder. The all-teams-finished auto-end is
        // disabled at runtime (disableAllFinishedEnd), so this is inert. Clash
        // creates one team per clan (finalTeams / finalNumberOfTeams).
        number_of_teams: finalNumberOfTeams,
        game_type: game.gameTypeName,
        duration: config.duration,
        started: false,
        meta,
        teams: finalTeams,
        include_self: deviceSelection.include_self,
      });
      launchedGameId = res.id;
      // ── Mass start (mystery/tracks "Départ groupé"): every pre-registered
      // team begins together at launch, so stamp each team's start_time NOW -
      // exactly what that team's first bip would have done under staggered
      // starts. The runtime then treats each team's first real bip as its
      // return/scoring bip (start_time already set ⇒ the end branch runs).
      const launchGtLc = game.gameTypeName?.toLowerCase();
      if (
        config.massStart &&
        (launchGtLc === 'mystery' || launchGtLc === 'tracks') &&
        launchedGameId !== null
      ) {
        try {
          const state = await getLaunchedGameState(launchedGameId, 0);
          const startSec = Math.floor(Date.now() / 1000);
          await Promise.all(
            state.teams
              .filter((t) => t.start_time == null)
              .map((t) => updateTeam(t.id, { start_time: startSec }))
          );
        } catch (err) {
          console.error('[GameList] mass-start team start failed:', err);
        }
      }
      // Tracks multi-route launch: persist each team's route as a `route:{teamId}`
      // meta override (read by the tracks runtime + Add Team flow). Team N defaults
      // to routes[(N-1) % count] (cycling) unless the operator overrode it in step 2.
      // The first route equals meta.route, so team_number 1 needs no override.
      const tracksRoutesSel = config.routes ?? (config.route ? [config.route] : []);
      if (
        game.gameTypeName?.toLowerCase() === 'tracks' &&
        tracksRoutesSel.length > 1 &&
        launchedGameId !== null
      ) {
        try {
          const state = await getLaunchedGameState(launchedGameId, 0);
          const patch: Record<string, string> = {};
          for (const tm of state.teams) {
            const cfgTeam = (config.teams ?? [])[tm.team_number - 1];
            const r = cfgTeam?.route ?? tracksRoutesSel[(tm.team_number - 1) % tracksRoutesSel.length];
            if (r && r !== config.route) patch[`route:${tm.id}`] = r;
          }
          if (Object.keys(patch).length > 0) {
            await mergeLaunchedGameMeta(launchedGameId, patch);
          }
        } catch (err) {
          console.error('[GameList] tracks per-team route persist failed:', err);
        }
      }
      // Clash chip→clan deferred apply: clans only exist now that the game is
      // created, so bind each chip to its clan via the server-authoritative
      // clash_register. Sources: an operator Excel import, else the "Équipes
      // prédéfinies" contiguous blocks dealt above. Resolve clanIndex (1..N)
      // against the freshly-created clans' team_number. Residual failures (e.g.
      // a clan hit its cap) are reported, non-fatally, via an alert.
      const clashAssignmentsToApply: Array<{ chipId: number; clanIndex: number }> =
        (config.clashChipAssignments?.length ?? 0) > 0
          ? config.clashChipAssignments!
          : clashPredeterminedAssignments;
      if (
        isClashLaunch &&
        clashAssignmentsToApply.length > 0 &&
        launchedGameId !== null
      ) {
        try {
          const standings = await getClashState(launchedGameId);
          const teamIdByNumber = new Map<number, number>();
          for (const c of standings.clans) teamIdByNumber.set(c.team_number, c.team_id);
          let ok = 0;
          let failed = 0;
          for (const a of clashAssignmentsToApply) {
            const teamId = teamIdByNumber.get(a.clanIndex);
            if (teamId === undefined) { failed++; continue; }
            try {
              const r = await clashRegister(launchedGameId, teamId, a.chipId);
              if (r.status === 'ok' || r.status === 'already_in_clan') ok++;
              else failed++;
            } catch {
              failed++;
            }
          }
          if (failed > 0) {
            showAlert('error', t('home:clashImportApplied', { ok, failed }));
          } else if (ok > 0) {
            showAlert('success', t('home:clashImportAppliedOk', { ok }));
          }
        } catch (err) {
          console.error('[GameList] clash chip→clan import apply failed:', err);
          showAlert('error', t('home:clashImportFailed'));
        }
      }

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

    setLaunchModalOpen(false);
    if (deviceSelection.include_self) {
      // This device participates - enter the in-game page.
      setLaunchedGame({ config, uniqid: game.uniqid, launchedGameId });
    } else {
      // This device only hosts/dispatches the game (not selected to run it) -
      // redirect to the launched-games list instead of entering the game. The
      // selected satellites get into the game via their join_game push.
      onShowLaunchedGames?.();
    }
  };

  // Wizard launch - the modal's onLaunch. Targets the scenario the modal was
  // opened for.
  const handleGameLaunch = async (
    config: GameConfig,
    deviceSelection: LaunchDeviceSelection
  ) => {
    if (!selectedGame) return;
    await launchGame(selectedGame, config, deviceSelection);
  };

  // ---- Quick Launch + saved-config orchestration ----

  // Chips already assigned to a team in any active game - can't be reused.
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
        isDefault: r.is_default,
      }));
      const tracksOptions = gameTypeLc === 'tracks' ? extractTracksOptions(rawGameData) : EMPTY_TRACKS_OPTIONS;
      const freeChips = cardRows.filter((c) => !used.has(c.id));
      const scenarioDownloaded = !!scenarioRow && scenarioRow.local_version !== null;

      const { ok, critical, resolved } = validateForHeadless(cfgRow.config, {
        patterns,
        scenarioDefaultPatternId: extractDefaultPatternId(rawGameData),
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
      await launchGame(scenario, { ...resolved, name: `${cfgRow.name} - ${frenchStamp()}`, teams }, deviceSelection);
    } catch (err) {
      console.error('[GameList] headlessLaunch failed:', err);
      // Last-resort fallback: open the pre-filled wizard so the operator can
      // launch manually rather than silently doing nothing.
      openPrefilledWizard(scenario, cfgRow.config, cfgRow.name, t('home:quickLaunchPrepareFailed'));
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
    if (await blockedByLock(() => void handleQuickLaunch(scenario))) return;
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
    // The in-game operator panel's button is "Back to Launched Games", so route
    // to the launched-games page rather than dropping back on the scenarios list
    // we launched from.
    onShowLaunchedGames?.();
  };

  const handleDeleteClick = (uniqid: string, title: string) => {
    setScenarioToDelete({ uniqid, title });
    setDeleteConfirmOpen(true);
  };

  // The actual local delete: drops the row + downloaded files. Not permanent -
  // the next sync re-adds the scenario from the manifest and re-downloads it.
  // Works for any scenario, including ones that never finished downloading
  // (e.g. a mystery scenario stuck on failed attempts).
  const performDelete = async (target: { uniqid: string; title: string }) => {
    try {
      await scenarioStore.deleteScenario(target.uniqid);
      await loadScenarios();
      await loadLocalGames();
      showAlert('success', t('home:deleteSuccess', { title: target.title }));
    } catch (err) {
      console.error('[GameList] failed to delete scenario:', err);
      showAlert('error', t('home:deleteError', { title: target.title }));
    }
  };

  const handleDeleteConfirm = async () => {
    const target = scenarioToDelete;
    setDeleteConfirmOpen(false);
    setScenarioToDelete(null);
    if (!target) return;
    // Gate the deletion behind the device PIN when one is set. With no PIN
    // configured there is nothing to verify against, so delete straight away
    // (consistent with the other PIN gates, which bypass when no PIN exists).
    try {
      if (await hasPin()) {
        setDeletePinGate(target);
        return;
      }
    } catch (err) {
      console.error('[GameList] hasPin check failed; deleting without gate:', err);
    }
    await performDelete(target);
  };

  const handleDeleteCancel = () => {
    setDeleteConfirmOpen(false);
    setScenarioToDelete(null);
  };

  // Shared action buttons (join / launch / quick launch) used by
  // both the grid card and the list row. `includeDetails` adds the inline
  // "view details" button - cards suppress it (the card has its own top-right
  // details button) while list rows keep it. Deletion now lives in the details
  // modal, so it's no longer offered here.
  const renderScenarioActions = (
    scenario: ScenarioWithType,
    includeDetails = true,
    layout: 'card' | 'row' = 'card'
  ) => {
    const activeGame = scenario.uniqid ? activeGames.get(scenario.uniqid) : undefined;
    const configCount = scenario.uniqid ? (configCounts.get(scenario.uniqid) ?? 0) : 0;
    const launchTarget: LaunchTarget = {
      uniqid: scenario.uniqid || '',
      title: scenario.title,
      gameTypeName: scenario.game_type.name,
    };

    // When a card shows all three primary buttons (Join + Launch new + Quick),
    // the row gets cramped - collapse them to icon-only.
    const canPlay =
      !!scenario.uniqid &&
      (localGameIds.size === 0 || localGameIds.has(scenario.uniqid));
    const hasJoin = canPlay && !!activeGame && !operatorOnly;
    const hasQuick = !!scenario.uniqid && configCount > 0;
    const compact = layout === 'card' && hasJoin && hasQuick;

    return (
      <div className={`pg-card-actions${layout === 'row' ? ' pg-card-actions--row' : ''}`}>
        {/* Primary actions. When a game is already running for this scenario we
            offer BOTH "Join" (the running game) and "Launch new" - a fresh game
            can run alongside it on other (free) devices. */}
        {scenario.uniqid && (localGameIds.size === 0 || localGameIds.has(scenario.uniqid)) ? (
          <>
            {activeGame && !operatorOnly && (
              <button
                onClick={() => handleJoinGame(scenario.uniqid || '')}
                className="pg-btn-play pg-btn-join"
                title={t('home:joinActiveGame', { name: activeGame.name })}
              >
                <LogIn size={15} />
                {!compact && <span>{t('home:join')}</span>}
              </button>
            )}
            <button
              onClick={() => handleLaunchGame(scenario.uniqid || '', scenario.title, scenario.game_type.name)}
              className="pg-btn-play"
              title={t('home:launchFullOptions')}
            >
              <Play size={15} />
              {!compact && <span>{activeGame ? t('home:launchNew') : t('home:launch')}</span>}
            </button>
          </>
        ) : null}

        {/* Quick Launch split button - only when this scenario has saved
            configs. Main: 1 config → headless, >1 → picker. Caret: always
            opens the picker/manage modal. */}
        {scenario.uniqid && configCount > 0 && (
          <div className="pg-split">
            <button
              onClick={() => void handleQuickLaunch(launchTarget)}
              title={t('home:quickLaunchTitle')}
            >
              <Zap size={15} />
              {!compact && t('home:quick')}
            </button>
            <button
              onClick={() => void openConfigModal(launchTarget)}
              title={t('home:manageConfigs')}
            >
              <ChevronDown size={15} />
            </button>
          </div>
        )}

        {includeDetails && (
          <button
            onClick={() => setDetailsScenario(scenario)}
            className="pg-icon-action"
            title={t('home:viewDetails')}
          >
            <Eye size={16} />
          </button>
        )}
      </div>
    );
  };

  const renderScenarioCard = (scenario: ScenarioWithType) => {
    const localImageUrl = (scenario.uniqid && localImages.get(scenario.uniqid)) || null;

    const difficultyLevel = coerceDifficulty(scenario.difficulty);

    return (
      <article key={scenario.id} className="pg-card">
        <div className="pg-card-img">
          <span className="pg-cat-tag">
            <GameTypeIcon type={scenario.game_type.name} size={12} />
            {gameTypeLabel(scenario.game_type.name).toUpperCase()}
          </span>
          <button
            onClick={() => setDetailsScenario(scenario)}
            className="pg-card-detail"
            title={t('home:viewDetails')}
            aria-label={t('home:viewDetails')}
          >
            <Eye size={15} />
          </button>
          <ScenarioThumbnail
            imageUrl={localImageUrl}
            gameTypeName={scenario.game_type.name}
            title={scenario.title}
          />
        </div>
        <div className="pg-card-body">
          <div className="pg-card-meta">
            <Clock size={13} />
            {t('home:durationMinutes', { count: scenario.duration_minutes })} ·
            <DifficultyMeter level={difficultyLevel} />
          </div>
          <div className="pg-card-title">{scenario.title || t('home:untitledScenario')}</div>
          <div className="pg-card-desc">{scenario.description}</div>
          {(scenario.audienceBands.length > 0 || scenario.univers.length > 0) && (
            <div className="flex flex-wrap gap-1 mb-2">
              {/* Age ranges first - same six bands as the studio catalog. */}
              {scenario.audienceBands.length > 0 && (
                <span className="pg-pill" style={{ fontSize: '0.7rem' }}>
                  {scenario.audienceBands.map((b) => audienceLabel(b)).join(' · ')}
                </span>
              )}
              {scenario.univers.map((tag) => (
                <span key={tag} className="pg-pill" style={{ fontSize: '0.7rem' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}
          {renderScenarioActions(scenario, false)}
        </div>
      </article>
    );
  };

  // Compact list row - same metadata + actions as the card, laid out
  // horizontally so more scenarios fit on screen.
  const renderScenarioRow = (scenario: ScenarioWithType) => {
    const localImageUrl = (scenario.uniqid && localImages.get(scenario.uniqid)) || null;

    return (
      <div key={scenario.id} className="pg-row">
        <div className="pg-row-thumb">
          <ScenarioThumbnail
            imageUrl={localImageUrl}
            gameTypeName={scenario.game_type.name}
            title={scenario.title}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="pg-card-title" style={{ marginBottom: 0 }}>
              {scenario.title || t('home:untitledScenario')}
            </h3>
          </div>
          <div className="pg-card-meta" style={{ marginBottom: 0, gap: 12 }}>
            <span className="inline-flex items-center gap-1.5">
              <GameTypeIcon type={scenario.game_type.name} size={14} />
              {gameTypeLabel(scenario.game_type.name)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock size={13} />
              {t('home:durationMinutes', { count: scenario.duration_minutes })}
            </span>
            <DifficultyMeter level={coerceDifficulty(scenario.difficulty)} />
          </div>
        </div>
        <div className="flex-shrink-0">
          {renderScenarioActions(scenario, true, 'row')}
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
      <div className="min-h-screen pg-app-bg flex items-center justify-center">
        <div className="text-[var(--pg-text)] text-xl">{t('home:loading')}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen">
      {alert.show && (
        <Alert type={alert.type} message={alert.message} onClose={closeAlert} />
      )}

      <main className="flex-1 container mx-auto px-6 py-8">
        {/* Filters: search + view toggle */}
        <div className="pg-filters mb-3">
          <label className="pg-search">
            <span className="pg-search-icon">
              <Search size={16} />
            </span>
            <input
              type="text"
              placeholder={t('home:searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </label>
          <div className="pg-view-toggle">
            <button
              onClick={() => setViewMode('grid')}
              className={viewMode === 'grid' ? 'is-active' : ''}
              aria-label={t('home:gridView')}
              title={t('home:gridView')}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={viewMode === 'list' ? 'is-active' : ''}
              aria-label={t('home:listView')}
              title={t('home:listView')}
            >
              <List size={16} />
            </button>
          </div>
        </div>

        {/* Filter pills - game type, audience and difficulty, each a segmented
            control laid out together on one line (wraps on narrow widths). */}
        <div className="pg-filter-bar mb-7">
          <div className="pg-cat-tabs-inner">
            <button
              onClick={() => setSelectedGameType('all')}
              className={`pg-cat-tab${selectedGameType === 'all' ? ' is-active' : ''}`}
            >
              {t('home:all')}
            </button>
            {gameTypes.map((type) => (
              <button
                key={type}
                onClick={() => setSelectedGameType(type)}
                className={`pg-cat-tab${selectedGameType === type ? ' is-active' : ''}`}
              >
                {gameTypeLabel(type)}
              </button>
            ))}
          </div>

          {audiences.length > 0 && (
            <div className="pg-cat-tabs-inner">
              <button
                onClick={() => setSelectedAudience('all')}
                className={`pg-cat-tab${selectedAudience === 'all' ? ' is-active' : ''}`}
              >
                {t('home:allAudiences')}
              </button>
              {audiences.map((a) => (
                <button
                  key={a}
                  onClick={() => setSelectedAudience(a)}
                  className={`pg-cat-tab${selectedAudience === a ? ' is-active' : ''}`}
                >
                  {audienceLabel(a)}
                </button>
              ))}
            </div>
          )}

          <div className="pg-cat-tabs-inner">
            <button
              onClick={() => setSelectedDifficulty('all')}
              className={`pg-cat-tab${selectedDifficulty === 'all' ? ' is-active' : ''}`}
            >
              {t('home:allDifficulties')}
            </button>
            {[1, 2, 3, 4, 5].map((d) => (
              <button
                key={d}
                onClick={() => setSelectedDifficulty(String(d))}
                className={`pg-cat-tab${selectedDifficulty === String(d) ? ' is-active' : ''}`}
                title={`${d} / 5`}
              >
                {'★'.repeat(d)}
              </button>
            ))}
          </div>
        </div>

        {scenarios.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="text-[var(--pg-text-muted)] text-lg mb-2">{t('home:noScenariosFound')}</div>
            <p className="text-[var(--pg-text-dim)] text-sm">
              {t('home:noScenariosHint')}
            </p>
          </div>
        )}

        {scenarios.length > 0 && filteredScenarios.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="text-[var(--pg-text-muted)] text-lg mb-2">{t('home:noScenariosMatchFilters')}</div>
            <p className="text-[var(--pg-text-dim)] text-sm">
              {t('home:adjustFiltersHint')}
            </p>
          </div>
        )}

        {filteredScenarios.length > 0 && (
          viewMode === 'grid' ? (
            <div className="pg-grid mb-12">
              {filteredScenarios.map(renderScenarioCard)}
            </div>
          ) : (
            <div className="flex flex-col gap-3 mb-12">
              {filteredScenarios.map(renderScenarioRow)}
            </div>
          )
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
          showAlert('success', t('home:configSaved', { name }));
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
        title={t('home:deleteDialogTitle')}
        message={t('home:deleteDialogMessage', { title: scenarioToDelete?.title })}
        confirmText={t('home:delete')}
        cancelText={t('home:cancel')}
        variant="danger"
      />

      <ConfirmDialog
        isOpen={motherPrompt !== null}
        onConfirm={() => { motherPrompt?.resolve(true); setMotherPrompt(null); }}
        onCancel={() => { motherPrompt?.resolve(false); setMotherPrompt(null); }}
        title={t('becomeMotherPromptTitle')}
        message={t('becomeMotherPromptBody')}
        confirmText={t('becomeMotherPromptConfirm')}
        cancelText={t('cancel')}
        variant="warning"
      />

      {deletePinGate && (
        <PinExitPrompt
          title={t('home:enterPinTitle')}
          subtitle={t('home:enterPinDeleteSubtitle', { title: deletePinGate.title })}
          onSuccess={() => {
            const target = deletePinGate;
            setDeletePinGate(null);
            void performDelete(target);
          }}
          onCancel={() => setDeletePinGate(null)}
        />
      )}

      {lockGate && (
        <GameLockGate
          reason={lockGate.reason}
          onReprieve={() => {
            const run = lockGate.run;
            setLockGate(null);
            run();
          }}
          onClose={() => setLockGate(null)}
        />
      )}

      {detailsScenario && (
        <ScenarioDetailsModal
          scenario={detailsScenario}
          thumbnailUrl={(detailsScenario.uniqid && localImages.get(detailsScenario.uniqid)) || null}
          onClose={() => setDetailsScenario(null)}
          onDelete={
            detailsScenario.uniqid &&
            !activeGames.has(detailsScenario.uniqid)
              ? () => {
                  const target = {
                    uniqid: detailsScenario.uniqid || '',
                    title: detailsScenario.title || t('home:untitledScenario'),
                  };
                  setDetailsScenario(null);
                  handleDeleteClick(target.uniqid, target.title);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
