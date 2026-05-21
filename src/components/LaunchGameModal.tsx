import { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Usb } from 'lucide-react';
import type { SiPuce } from '../types/database';
import * as cardsStore from '../services/cardsStore';
import * as cardsRepo from '../services/cardsRepo';
import * as patternStore from '../services/patternStore';
import * as scenarioStore from '../services/scenarioStore';
import * as gameTypesStore from '../services/gameTypesStore';
import * as clientPreferencesStore from '../services/clientPreferencesStore';
import {
  listActiveLaunchedGames,
  getLaunchedGameState,
  listPairedDevicesForLaunch,
  type PairedDeviceStatusRow,
} from '../services/launchedGames';
import { useAuth } from './auth/AuthProvider';

export interface LaunchDeviceSelection {
  /** Whether to register the mother itself as a participating device. */
  include_self: boolean;
  /** paired_devices.id of every non-self peer to send a join_game command to. */
  satellite_targets: number[];
}

const LANG_NAMES: Record<string, string> = {
  en: 'English', fr: 'Français', es: 'Español', de: 'Deutsch', it: 'Italiano',
  pt: 'Português', nl: 'Nederlands', pl: 'Polski', ru: 'Русский',
  ja: '日本語', zh: '中文', ar: 'العربية',
};

// Walk a `Localized<>` map shape — `{ en: '...', fr: '...' }` — looking for
// every language key that has at least one non-empty value across the whole
// gameMeta. Used to populate the launch language picker so we only offer
// languages the scenario actually has translations for.
function collectScenarioLanguages(value: unknown, found: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectScenarioLanguages(v, found);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k.length === 2 && typeof v === 'string' && v.trim().length > 0 && /^[a-z]{2}$/.test(k)) {
      found.add(k);
    } else {
      collectScenarioLanguages(v, found);
    }
  }
}

function extractDefaultLanguage(rawGameData: unknown): string | null {
  if (!rawGameData || typeof rawGameData !== 'object') return null;
  const root = rawGameData as Record<string, unknown>;
  const candidates: unknown[] = [
    root.default_language,
    (root.scenario as { default_language?: unknown } | undefined)?.default_language,
    (root.game_data as { default_language?: unknown } | undefined)?.default_language,
    (root.game_meta as { default_language?: unknown } | undefined)?.default_language,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length === 2) return c;
  }
  return null;
}

interface PatternOption {
  slug: string;
  name: string;
  uniqid: string;
}

// The on-disk game-data.json may be the raw `game_data` blob or a legacy
// envelope with `{scenario, game_data}` siblings — depending on which sync
// generation wrote it. Probe known paths for `default_pattern_id`.
function extractDefaultPatternId(rawGameData: unknown): string | null {
  if (!rawGameData || typeof rawGameData !== 'object') return null;
  const root = rawGameData as Record<string, unknown>;
  const candidates: unknown[] = [
    root.default_pattern_id,
    (root.scenario as { default_pattern_id?: unknown } | undefined)?.default_pattern_id,
    (root.game_data as { scenario?: { default_pattern_id?: unknown }; default_pattern_id?: unknown } | undefined)?.scenario?.default_pattern_id,
    (root.game_data as { default_pattern_id?: unknown } | undefined)?.default_pattern_id,
    (root.game_meta as { default_pattern_id?: unknown } | undefined)?.default_pattern_id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
  }
  return null;
}

interface LaunchGameModalProps {
  isOpen: boolean;
  onClose: () => void;
  gameTitle: string;
  gameUniqid: string;
  gameTypeName: string;
  onLaunch: (config: GameConfig, deviceSelection: LaunchDeviceSelection) => void;
}

export type TagquestVisibilityMode = 'persist' | 'hide_after_delay';

export interface GameConfig {
  name: string;
  numberOfTeams: number;
  firstChipIndex: number;
  pattern: string;
  duration: number;
  messageDisplayDuration: number;
  enigmaImageDisplayDuration: number;
  colorblindMode: boolean;
  autoResetTeam: boolean;
  delayBeforeReset: number;
  victoryType?: 'speed' | 'score';
  playMode?: 'solo' | 'team';
  teammatesPerTeam?: number;
  testMode?: boolean;
  teams?: Team[];
  /** Tagquest HUD value visibility — persists by default. */
  visibilityMode?: TagquestVisibilityMode;
  /** Seconds before HUD values fade out after an animation completes (used when visibilityMode === 'hide_after_delay'). */
  visibilityHideDelaySec?: number;
  /** Selected language code from the launch picker (drives translations + video subtitles). */
  language?: string;
  /** Play tutorial video on each team's first bip (mystery/tracks only). Off if no video exists. */
  playTutorialOnBip?: boolean;
  /** Play intro video (per-scenario scenario_video) on each team's first bip. Off if scenario has none. */
  playIntroOnBip?: boolean;
}

export interface Teammate {
  chipId: number;
  chipNumber: number;
  name: string;
}

export interface Team {
  chipId: number;
  chipNumber: number;
  name: string;
  teammates?: Teammate[];
}

export function LaunchGameModal({ isOpen, onClose, gameTitle, gameUniqid, gameTypeName, onLaunch }: LaunchGameModalProps) {
  const { user } = useAuth();

  const getDefaultName = () => {
    const now = new Date();
    const date = now.toLocaleDateString('fr-FR');
    const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${gameTitle} ${date} ${time}`;
  };

  const [config, setConfig] = useState<GameConfig>({
    name: '',
    numberOfTeams: 1,
    firstChipIndex: 1,
    pattern: '',
    duration: 60,
    messageDisplayDuration: 5,
    enigmaImageDisplayDuration: 1,
    colorblindMode: false,
    autoResetTeam: false,
    delayBeforeReset: 10,
    victoryType: 'score',
    playMode: 'team',
    teammatesPerTeam: 2,
    testMode: false,
    visibilityMode: 'persist',
    visibilityHideDelaySec: 5,
  });
  const [patternFolders, setPatternFolders] = useState<PatternOption[]>([]);
  const [defaultPattern, setDefaultPattern] = useState<string>('');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Step-3 state — the paired-device picker. Loaded lazily when the user
  // advances to step 3; reset on modal close so a fresh open doesn't show
  // stale online indicators.
  const [pairedDevices, setPairedDevices] = useState<PairedDeviceStatusRow[]>([]);
  const [pairedLoading, setPairedLoading] = useState(false);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<number>>(new Set());
  const [motherChecked, setMotherChecked] = useState(true);
  const [scenarioLanguages, setScenarioLanguages] = useState<string[]>([]);
  const [scenarioDefaultLang, setScenarioDefaultLang] = useState<string>('en');
  const [gameTypeRow, setGameTypeRow] = useState<gameTypesStore.GameTypeRow | null>(null);
  const [hasTutorialVideo, setHasTutorialVideo] = useState(false);
  const [hasIntroVideo, setHasIntroVideo] = useState(false);
  const [prefTutorialDefault, setPrefTutorialDefault] = useState(false);
  const [prefIntroDefault, setPrefIntroDefault] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [availableChips, setAvailableChips] = useState<SiPuce[]>([]);
  const [onDemandChips, setOnDemandChips] = useState<SiPuce[]>([]);
  const [hasOnDemandCards, setHasOnDemandCards] = useState(false);
  const [useOnDemandCards, setUseOnDemandCards] = useState(false);
  const [usedChipIds, setUsedChipIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    const loadData = async () => {
      if (!gameTypeName || !gameUniqid) return;

      const gameTypeLc = gameTypeName.toLowerCase();
      const [rows, rawGameData] = await Promise.all([
        patternStore.list({ gameType: gameTypeLc }),
        scenarioStore.getGameData(gameUniqid),
      ]);

      const options: PatternOption[] = rows.map(r => ({
        slug: r.pattern_slug ?? r.pattern_uniqid,
        name: r.name || r.pattern_slug || r.pattern_uniqid,
        uniqid: r.pattern_uniqid,
      }));
      setPatternFolders(options);

      const defaultPatternId = extractDefaultPatternId(rawGameData);
      let resolvedPattern = '';
      if (defaultPatternId && options.some(o => o.uniqid === defaultPatternId)) {
        resolvedPattern = defaultPatternId;
      }
      if (!resolvedPattern) {
        resolvedPattern = options[0]?.uniqid || '';
      }
      setDefaultPattern(resolvedPattern);

      // Discover languages the scenario has translations for. Default to the
      // scenario's declared default_language; fall back to 'en' if neither
      // exists. Empty set means no localization — picker stays hidden.
      const langs = new Set<string>();
      collectScenarioLanguages(rawGameData, langs);
      const sortedLangs = Array.from(langs).sort();
      setScenarioLanguages(sortedLangs);
      const defaultLang = extractDefaultLanguage(rawGameData) || sortedLangs[0] || 'en';
      setScenarioDefaultLang(defaultLang);

      // Resolve game-type capabilities + whether tutorial/intro videos are
      // actually available locally so we know whether to render each toggle.
      const gameTypeLcLocal = gameTypeName.toLowerCase();
      const gt = await gameTypesStore.getGameType(gameTypeLcLocal);
      setGameTypeRow(gt);
      const resolvedTutorial = await gameTypesStore.resolveTutorialVideoUrl(gameTypeLcLocal);
      setHasTutorialVideo(!!gt?.supports_tutorial_video && resolvedTutorial !== null);

      // Intro video = per-scenario scenario_video. Probe game-data for either
      // a top-level `scenario_video` (post-Stage-3) or legacy `medias.video`.
      const introCandidate =
        (rawGameData as { scenario_video?: unknown } | null)?.scenario_video
        ?? ((rawGameData as { game_meta?: { scenario_video?: unknown } } | null)?.game_meta?.scenario_video)
        ?? ((rawGameData as { medias?: { video?: unknown } } | null)?.medias?.video);
      const hasIntro = typeof introCandidate === 'string' && introCandidate.trim().length > 0;
      setHasIntroVideo(!!gt?.supports_intro_video && hasIntro);

      // Pre-fill the toggles from the client's saved preferences.
      if (user?.client_id) {
        const pref = await clientPreferencesStore.getGamePref(user.client_id, gameTypeLcLocal);
        setPrefTutorialDefault(!!pref.play_tutorial_default);
        setPrefIntroDefault(!!pref.play_intro_default);
      }
    };
    loadData();
  }, [gameTypeName, gameUniqid, user?.client_id]);

  useEffect(() => {
    if (isOpen) {
      setConfig({
        name: '',
        numberOfTeams: 10,
        firstChipIndex: 1,
        pattern: defaultPattern,
        duration: 60,
        messageDisplayDuration: 5,
        enigmaImageDisplayDuration: 1,
        colorblindMode: false,
        autoResetTeam: false,
        delayBeforeReset: 10,
        victoryType: 'score',
        playMode: 'team',
        teammatesPerTeam: 2,
        testMode: false,
        visibilityMode: 'persist',
        visibilityHideDelaySec: 5,
        language: scenarioDefaultLang,
        playTutorialOnBip: hasTutorialVideo && prefTutorialDefault,
        playIntroOnBip: hasIntroVideo && prefIntroDefault,
      });
      setStep(1);
      setTeams([]);
      setPairedDevices([]);
      setSelectedDeviceIds(new Set());
      setMotherChecked(true);
    }
  }, [isOpen, defaultPattern, scenarioDefaultLang, hasTutorialVideo, hasIntroVideo, prefTutorialDefault, prefIntroDefault]);

  const allChips = useOnDemandCards
    ? [...availableChips, ...onDemandChips]
    : availableChips;

  const isTagQuest = gameTypeName.toLowerCase() === 'tagquest';
  const isTeamMode = isTagQuest && config.playMode === 'team';
  const chipsPerTeam = isTeamMode ? (config.teammatesPerTeam ?? 2) : 1;
  const totalChipsNeeded = config.numberOfTeams * chipsPerTeam;
  const maxTeams = allChips.length > 0 ? Math.floor(allChips.length / chipsPerTeam) : undefined;
  const totalMaxTeams = maxTeams;
  const maxFirstChipIndex = allChips.length > 0
    ? Math.max(0, allChips.length - totalChipsNeeded)
    : undefined;

  useEffect(() => {
    if (!isOpen || !user) return;

    // Chip roster comes from the local `cards` table (synced from studio's
    // client_cards) plus optional on-demand JSON. Pending-write rows show
    // up here too so the operator can assign a freshly-registered card to
    // a team in the same launch session.
    const loadChips = async () => {
      try {
        const rows = await cardsRepo.list();
        setAvailableChips(
          rows.map((r) => ({
            id: r.id,
            key_number: r.key_number,
            key_name: r.key_name,
            color: r.color,
            created_at: '',
            updated_at: '',
          }))
        );
      } catch (err) {
        console.error('[LaunchGameModal] failed to read cards table:', err);
        setAvailableChips([]);
      }

      try {
        const onDemandJson = await cardsStore.getOnDemandCardsJson();
        const cards = (onDemandJson as { cards?: Array<{ id?: number; key_number: number; key_name: string; color?: string | null }> } | null)?.cards;
        if (cards && cards.length > 0) {
          const mapped: SiPuce[] = cards.map((c) => ({
            id: c.id ?? c.key_number,
            key_number: c.key_number,
            key_name: c.key_name,
            color: c.color ?? null,
            created_at: '',
            updated_at: '',
          }));
          setOnDemandChips(mapped.sort((a, b) => a.key_number - b.key_number));
          setHasOnDemandCards(true);
        } else {
          setOnDemandChips([]);
          setHasOnDemandCards(false);
        }
      } catch (err) {
        console.error('[LaunchGameModal] failed to read on-demand cards:', err);
        setOnDemandChips([]);
        setHasOnDemandCards(false);
      }
    };

    // Used chips: enumerate active games' teams.key_id so the user can't
    // re-assign a chip already in play. With per-client scoping this only
    // sees the current client's active games.
    const loadUsedChips = async () => {
      try {
        const active = await listActiveLaunchedGames();
        if (active.length === 0) {
          setUsedChipIds(new Set());
          return;
        }
        const used = new Set<number>();
        for (const game of active) {
          try {
            const state = await getLaunchedGameState(game.id, 0);
            for (const t of state.teams ?? []) {
              if (t.key_id !== null && t.key_id !== undefined) used.add(t.key_id);
            }
          } catch (err) {
            console.warn('[LaunchGameModal] state fetch failed for', game.id, err);
          }
        }
        setUsedChipIds(used);
      } catch (err) {
        console.error('[LaunchGameModal] loadUsedChips failed:', err);
        setUsedChipIds(new Set());
      }
    };

    loadChips();
    loadUsedChips();
  }, [isOpen, user]);

  const handleNextStep = () => {
    const startIndex = config.firstChipIndex;
    const numberOfTeams = config.numberOfTeams;

    const combinedChips = [...availableChips, ...onDemandChips];

    if (isTeamMode) {
      const newTeams: Team[] = [];
      for (let i = 0; i < numberOfTeams; i++) {
        const teamChips = combinedChips.slice(startIndex + i * chipsPerTeam, startIndex + i * chipsPerTeam + chipsPerTeam);
        if (teamChips.length === 0) break;
        const firstChip = teamChips[0];
        const teammates: Teammate[] = teamChips.map(chip => ({
          chipId: chip.id,
          chipNumber: chip.key_number,
          name: chip.key_name,
        }));
        newTeams.push({
          chipId: firstChip.id,
          chipNumber: firstChip.key_number,
          name: firstChip.key_name,
          teammates,
        });
      }
      setTeams(newTeams);
    } else {
      const chipsForTeams = combinedChips.slice(startIndex, startIndex + numberOfTeams);
      const newTeams: Team[] = chipsForTeams.map(chip => ({
        chipId: chip.id,
        chipNumber: chip.key_number,
        name: chip.key_name,
      }));
      setTeams(newTeams);
    }

    setStep(2);
  };

  const updateTeamName = (index: number, newName: string) => {
    setTeams(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], name: newName };
      return updated;
    });
  };

  const updateTeamChip = (index: number, chipId: number) => {
    const chip = allChips.find(c => c.id === chipId);
    if (!chip) return;

    setTeams(prev => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        chipId: chip.id,
        chipNumber: chip.key_number,
        name: chip.key_name
      };
      return updated;
    });
  };

  const updateTeammateName = (teamIndex: number, teammateIndex: number, newName: string) => {
    setTeams(prev => {
      const updated = [...prev];
      const team = { ...updated[teamIndex] };
      const mates = [...(team.teammates ?? [])];
      mates[teammateIndex] = { ...mates[teammateIndex], name: newName };
      team.teammates = mates;
      if (teammateIndex === 0) {
        team.name = newName;
        team.chipId = mates[0].chipId;
        team.chipNumber = mates[0].chipNumber;
      }
      updated[teamIndex] = team;
      return updated;
    });
  };

  const updateTeammateChip = (teamIndex: number, teammateIndex: number, chipId: number) => {
    const chip = allChips.find(c => c.id === chipId);
    if (!chip) return;
    setTeams(prev => {
      const updated = [...prev];
      const team = { ...updated[teamIndex] };
      const mates = [...(team.teammates ?? [])];
      mates[teammateIndex] = { ...mates[teammateIndex], chipId: chip.id, chipNumber: chip.key_number };
      team.teammates = mates;
      if (teammateIndex === 0) {
        team.chipId = chip.id;
        team.chipNumber = chip.key_number;
      }
      updated[teamIndex] = team;
      return updated;
    });
  };

  const allUsedTeammateChipIds = (): Set<number> => {
    const ids = new Set<number>();
    teams.forEach(t => (t.teammates ?? []).forEach(m => ids.add(m.chipId)));
    return ids;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (step === 1) {
      handleNextStep();
      return;
    }

    if (step === 2) {
      // Advance to the device picker. Lazy-fetch the paired list and
      // pre-check the mother + every currently-online satellite. Offline
      // peers are visible but unchecked — the operator can opt to queue a
      // join_game command that will wake them up when they reconnect
      // (15-minute TTL on the pending_commands row).
      setStep(3);
      setPairedLoading(true);
      try {
        const rows = await listPairedDevicesForLaunch();
        setPairedDevices(rows);
        setSelectedDeviceIds(new Set(rows.filter(r => !r.is_self && r.online).map(r => r.id)));
        setMotherChecked(true);
      } catch (err) {
        console.error('[LaunchGameModal] failed to load paired devices:', err);
        setPairedDevices([]);
      } finally {
        setPairedLoading(false);
      }
      return;
    }

    // step === 3: actually launch.
    // Reader-not-detected is no longer a launch gate. The game pages
    // surface a banner if the dongle is missing and auto-bind via the
    // 'reader:status' event once it's plugged in.
    const finalConfig = {
      ...config,
      name: config.name.trim() || getDefaultName(),
      teams,
    };
    const satellite_targets = Array.from(selectedDeviceIds);
    onLaunch(finalConfig, {
      include_self: motherChecked,
      satellite_targets,
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="relative w-full h-full max-w-4xl max-h-screen overflow-auto bg-slate-900 shadow-2xl md:rounded-xl md:m-8 md:h-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between p-6 bg-slate-800 border-b border-slate-700">
          <h2 className="text-2xl font-bold text-white">Launch Game Configuration</h2>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition"
          >
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {step === 1 && (
          <>
          <div className="space-y-2">
            <label htmlFor="name" className="block text-sm font-medium text-slate-300">
              Game Name
            </label>
            <input
              type="text"
              id="name"
              value={config.name}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
              placeholder={getDefaultName()}
              className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-slate-500">Leave empty to use default: {getDefaultName()}</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label htmlFor="numberOfTeams" className="block text-sm font-medium text-slate-300">
                Number of Teams
                {totalMaxTeams !== undefined && (
                  <span className="ml-2 text-xs text-slate-400">
                    (max {totalMaxTeams})
                  </span>
                )}
              </label>
              <input
                type="number"
                id="numberOfTeams"
                min="1"
                max={config.testMode ? Math.min(maxTeams ?? 5, 5) : maxTeams}
                value={config.numberOfTeams}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 1;
                  const effectiveMax = config.testMode
                    ? Math.min(maxTeams ?? 5, 5)
                    : maxTeams;
                  const clampedTeams = effectiveMax !== undefined ? Math.min(val, effectiveMax) : val;
                  const clampedFirst = maxTeams !== undefined
                    ? Math.min(config.firstChipIndex, maxTeams - clampedTeams)
                    : config.firstChipIndex;
                  setConfig({ ...config, numberOfTeams: clampedTeams, firstChipIndex: clampedFirst });
                }}
                className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
              {maxTeams !== undefined && config.numberOfTeams > maxTeams && (
                <p className="text-xs text-red-400">Cannot exceed the number of available cards ({maxTeams})</p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="firstChipIndex" className="block text-sm font-medium text-slate-300">
                Index of First Chip
              </label>
              <input
                type="number"
                id="firstChipIndex"
                min="0"
                {...(maxFirstChipIndex !== undefined ? { max: maxFirstChipIndex } : {})}
                value={config.firstChipIndex}
                onChange={(e) => {
                  let val = parseInt(e.target.value) || 0;
                  if (maxFirstChipIndex !== undefined) val = Math.min(val, maxFirstChipIndex);
                  setConfig({ ...config, firstChipIndex: val });
                }}
                className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="pattern" className="block text-sm font-medium text-slate-300">
                Pattern
              </label>
              <select
                id="pattern"
                value={config.pattern}
                onChange={(e) => setConfig({ ...config, pattern: e.target.value })}
                className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              >

                {patternFolders.length === 0 ? (
                  <option value="">Loading patterns...</option>
                ) : (
                  patternFolders.map((option) => (
                    <option key={option.uniqid || option.slug} value={option.uniqid}>
                      {option.name}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="duration" className="block text-sm font-medium text-slate-300">
                Duration (minutes)
              </label>
              <input
                type="number"
                id="duration"
                min="1"
                value={config.duration}
                onChange={(e) => setConfig({ ...config, duration: parseInt(e.target.value) || 1 })}
                className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="messageDisplayDuration" className="block text-sm font-medium text-slate-300">
                Message Display Duration (seconds)
              </label>
              <input
                type="number"
                id="messageDisplayDuration"
                min="1"
                value={config.messageDisplayDuration}
                onChange={(e) => setConfig({ ...config, messageDisplayDuration: parseInt(e.target.value) || 1 })}
                className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="enigmaImageDisplayDuration" className="block text-sm font-medium text-slate-300">
                Image Display Duration (seconds)
              </label>
              <input
                type="number"
                id="enigmaImageDisplayDuration"
                min="1"
                value={config.enigmaImageDisplayDuration}
                onChange={(e) => setConfig({ ...config, enigmaImageDisplayDuration: parseInt(e.target.value) || 1 })}
                className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>
          </div>

          {scenarioLanguages.length > 0 && (
            <div className="space-y-2">
              <label htmlFor="language" className="block text-sm font-medium text-slate-300">
                Language
              </label>
              <select
                id="language"
                value={config.language || scenarioDefaultLang}
                onChange={(e) => setConfig({ ...config, language: e.target.value })}
                className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {scenarioLanguages.map((lang) => (
                  <option key={lang} value={lang}>
                    {LANG_NAMES[lang] || lang} ({lang})
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500">
                Selects in-game text translations and video subtitle track.
              </p>
            </div>
          )}

          {(hasTutorialVideo || hasIntroVideo) && (
            <div className="space-y-3 p-4 bg-slate-800/50 rounded-lg">
              <div className="text-sm font-medium text-slate-300">First-bip videos</div>
              {hasTutorialVideo && (
                <label className="flex items-center gap-3 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={!!config.playTutorialOnBip}
                    onChange={(e) => setConfig({ ...config, playTutorialOnBip: e.target.checked })}
                  />
                  Play Taghunter tutorial video on each team's first bip
                </label>
              )}
              {hasIntroVideo && (
                <label className="flex items-center gap-3 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={!!config.playIntroOnBip}
                    onChange={(e) => setConfig({ ...config, playIntroOnBip: e.target.checked })}
                  />
                  Play scenario intro video on each team's first bip
                </label>
              )}
              <p className="text-xs text-slate-500">
                Both videos play in order (intro first, then tutorial) before the team's timer starts.
                Returning teams (already started) skip the videos.
              </p>
            </div>
          )}

          {isTagQuest && (
            <>
              <div className="space-y-3 p-4 bg-slate-800/50 rounded-lg">
                <label className="block text-sm font-medium text-slate-300">
                  Victory Type
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, victoryType: 'score' })}
                    className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                      config.victoryType === 'score'
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-slate-600 bg-slate-800 hover:border-slate-500'
                    }`}
                  >
                    <div className={`font-semibold text-sm mb-1 ${config.victoryType === 'score' ? 'text-blue-400' : 'text-slate-300'}`}>
                      Score
                    </div>
                    <div className="text-xs text-slate-400 leading-snug">
                      Chaque image vaut des points (avec combos et malus). Classement au nombre de points recoltes.
                    </div>
                    {config.victoryType === 'score' && (
                      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-blue-500" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, victoryType: 'speed' })}
                    className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                      config.victoryType === 'speed'
                        ? 'border-orange-500 bg-orange-500/10'
                        : 'border-slate-600 bg-slate-800 hover:border-slate-500'
                    }`}
                  >
                    <div className={`font-semibold text-sm mb-1 ${config.victoryType === 'speed' ? 'text-orange-400' : 'text-slate-300'}`}>
                      Rapidite
                    </div>
                    <div className="text-xs text-slate-400 leading-snug">
                      La premiere equipe a avoir recolte toutes les images gagne. Classement par heure de derniere image collectee.
                    </div>
                    {config.victoryType === 'speed' && (
                      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-orange-500" />
                    )}
                  </button>
                </div>
              </div>

              <div className="space-y-3 p-4 bg-slate-800/50 rounded-lg">
                <label className="block text-sm font-medium text-slate-300">
                  Play Mode
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, playMode: 'team' })}
                    className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                      config.playMode === 'team'
                        ? 'border-teal-500 bg-teal-500/10'
                        : 'border-slate-600 bg-slate-800 hover:border-slate-500'
                    }`}
                  >
                    <div className={`font-semibold text-sm mb-1 ${config.playMode === 'team' ? 'text-teal-400' : 'text-slate-300'}`}>
                      Team
                    </div>
                    <div className="text-xs text-slate-400 leading-snug">
                      Several chips correspond to one team. Multiple players share a team.
                    </div>
                    {config.playMode === 'team' && (
                      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-teal-500" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, playMode: 'solo' })}
                    className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                      config.playMode === 'solo'
                        ? 'border-teal-500 bg-teal-500/10'
                        : 'border-slate-600 bg-slate-800 hover:border-slate-500'
                    }`}
                  >
                    <div className={`font-semibold text-sm mb-1 ${config.playMode === 'solo' ? 'text-teal-400' : 'text-slate-300'}`}>
                      Solo
                    </div>
                    <div className="text-xs text-slate-400 leading-snug">
                      Each chip corresponds to one team. One chip per player.
                    </div>
                    {config.playMode === 'solo' && (
                      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-teal-500" />
                    )}
                  </button>
                </div>

                {isTeamMode && (
                  <div className="mt-3 space-y-2">
                    <label htmlFor="teammatesPerTeam" className="block text-sm font-medium text-slate-300">
                      Teammates per Team
                      {allChips.length > 0 && (
                        <span className="ml-2 text-xs text-slate-400">
                          ({totalChipsNeeded} chips needed, {allChips.length} available)
                        </span>
                      )}
                    </label>
                    <input
                      type="number"
                      id="teammatesPerTeam"
                      min="2"
                      value={config.teammatesPerTeam ?? 2}
                      onChange={(e) => {
                        const val = Math.max(2, parseInt(e.target.value) || 2);
                        const newMax = allChips.length > 0 ? Math.floor(allChips.length / val) : undefined;
                        const clampedTeams = newMax !== undefined ? Math.min(config.numberOfTeams, newMax) : config.numberOfTeams;
                        setConfig({ ...config, teammatesPerTeam: val, numberOfTeams: clampedTeams });
                      }}
                      className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                    />
                  </div>
                )}
              </div>
            </>
          )}

          <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg">
            {hasOnDemandCards && (
              <div className="flex items-center gap-3 pb-3 border-b border-slate-700">
                <input
                  type="checkbox"
                  id="useOnDemandCards"
                  checked={useOnDemandCards}
                  onChange={(e) => {
                    setUseOnDemandCards(e.target.checked);
                    if (!e.target.checked) {
                      const newMax = availableChips.length;
                      if (newMax > 0) {
                        setConfig(prev => {
                          const clampedTeams = Math.min(prev.numberOfTeams, newMax);
                          const clampedFirst = Math.min(prev.firstChipIndex, newMax - clampedTeams);
                          return { ...prev, numberOfTeams: clampedTeams, firstChipIndex: clampedFirst };
                        });
                      }
                    }
                  }}
                  className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
                <label htmlFor="useOnDemandCards" className="text-sm font-medium text-slate-300">
                  Use on-demand cards
                  <span className="ml-2 text-xs text-slate-400">({onDemandChips.length} additional cards available)</span>
                </label>
              </div>
            )}

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="colorblindMode"
                checked={config.colorblindMode}
                onChange={(e) => setConfig({ ...config, colorblindMode: e.target.checked })}
                className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
              />
              <label htmlFor="colorblindMode" className="text-sm font-medium text-slate-300">
                Colorblind Mode
              </label>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="autoResetTeam"
                checked={config.autoResetTeam}
                onChange={(e) => setConfig({ ...config, autoResetTeam: e.target.checked })}
                className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
              />
              <label htmlFor="autoResetTeam" className="text-sm font-medium text-slate-300">
                Auto-reset Team
              </label>
            </div>

            {config.autoResetTeam && (
              <div className="ml-8 space-y-2">
                <label htmlFor="delayBeforeReset" className="block text-sm font-medium text-slate-300">
                  Delay Before Reset (seconds)
                </label>
                <input
                  type="number"
                  id="delayBeforeReset"
                  min="0"
                  value={config.delayBeforeReset}
                  onChange={(e) => setConfig({ ...config, delayBeforeReset: parseInt(e.target.value) || 0 })}
                  className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
              </div>
            )}

            <div className="pt-1 border-t border-slate-700/60 space-y-2">
              <label className="block text-sm font-medium text-slate-300">
                HUD values display
              </label>
              <div className="space-y-2">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="visibilityMode"
                    value="persist"
                    checked={(config.visibilityMode ?? 'persist') === 'persist'}
                    onChange={() => setConfig({ ...config, visibilityMode: 'persist' })}
                    className="mt-1 w-4 h-4 bg-slate-700 border-slate-600 text-blue-600 focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-300">
                    Persist until next punch
                    <span className="ml-1 text-xs text-slate-400">— values stay visible after each punch animation</span>
                  </span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="visibilityMode"
                    value="hide_after_delay"
                    checked={config.visibilityMode === 'hide_after_delay'}
                    onChange={() => setConfig({ ...config, visibilityMode: 'hide_after_delay' })}
                    className="mt-1 w-4 h-4 bg-slate-700 border-slate-600 text-blue-600 focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-300">
                    Hide after
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={config.visibilityHideDelaySec ?? 5}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          visibilityHideDelaySec: Math.max(1, parseInt(e.target.value) || 5),
                        })
                      }
                      onClick={(e) => e.stopPropagation()}
                      disabled={config.visibilityMode !== 'hide_after_delay'}
                      className="mx-1 w-14 px-2 py-0.5 text-sm bg-slate-800 border border-slate-700 rounded text-white disabled:opacity-50"
                    />
                    seconds
                    <span className="ml-1 text-xs text-slate-400">— values fade out after the animation completes</span>
                  </span>
                </label>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-1 border-t border-slate-700/60">
              <input
                type="checkbox"
                id="testMode"
                checked={config.testMode ?? false}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setConfig(prev => ({
                    ...prev,
                    testMode: enabled,
                    numberOfTeams: enabled ? Math.min(prev.numberOfTeams, 5) : prev.numberOfTeams,
                  }));
                }}
                className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-amber-600 focus:ring-2 focus:ring-amber-500"
              />
              <label htmlFor="testMode" className="text-sm font-medium text-amber-400">
                Test Mode
                <span className="ml-2 text-xs text-slate-400 font-normal">(limits teams to 5, shows test banner)</span>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-end gap-4 pt-4 border-t border-slate-700">
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-2 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition font-medium flex items-center gap-2"
            >
              Next
              <ChevronRight size={20} />
            </button>
          </div>
          </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-4">
                <h3 className="text-xl font-semibold text-white border-b border-slate-700 pb-2">Configure Teams</h3>
                <div className="space-y-4">
                  {teams.map((team, teamIndex) => {
                    const usedInGame = allUsedTeammateChipIds();

                    if (isTeamMode && team.teammates && team.teammates.length > 0) {
                      return (
                        <div key={teamIndex} className="bg-slate-800/50 rounded-xl border border-slate-700/60 overflow-hidden">
                          <div className="flex items-center gap-3 px-4 py-3 bg-slate-700/40 border-b border-slate-700/60">
                            <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                              {teamIndex + 1}
                            </div>
                            <input
                              type="text"
                              value={team.name}
                              onChange={(e) => updateTeamName(teamIndex, e.target.value)}
                              className="flex-1 px-3 py-1.5 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                              placeholder="Team name"
                              required
                            />
                          </div>
                          <div className="divide-y divide-slate-700/40">
                            {team.teammates.map((mate, mateIndex) => {
                              return (
                                <div key={mateIndex} className="flex items-center gap-3 px-4 py-3">
                                  <div className="w-6 h-6 rounded-full bg-slate-600 flex items-center justify-center text-slate-300 text-xs font-medium flex-shrink-0">
                                    {mateIndex + 1}
                                  </div>
                                  <div className="flex-shrink-0 min-w-[180px]">
                                    <select
                                      value={mate.chipId}
                                      onChange={(e) => updateTeammateChip(teamIndex, mateIndex, parseInt(e.target.value))}
                                      className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                      required
                                    >
                                      {allChips.map(chip => {
                                        const isUsedHere = usedInGame.has(chip.id) && chip.id !== mate.chipId;
                                        const isUsedInOtherGame = usedChipIds.has(chip.id);
                                        const isDisabled = isUsedHere || isUsedInOtherGame;
                                        return (
                                          <option key={chip.id} value={chip.id} disabled={isDisabled}>
                                            Chip #{chip.key_number} - {chip.key_name}{isDisabled ? ' (In use)' : ''}
                                          </option>
                                        );
                                      })}
                                    </select>
                                  </div>
                                  <div className="flex-1">
                                    <input
                                      type="text"
                                      value={mate.name}
                                      onChange={(e) => updateTeammateName(teamIndex, mateIndex, e.target.value)}
                                      className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                      placeholder={`Teammate ${mateIndex + 1} name`}
                                      required
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={teamIndex} className="flex items-center gap-4 p-4 bg-slate-800/50 rounded-lg">
                        <div className="flex-shrink-0">
                          <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold">
                            {teamIndex + 1}
                          </div>
                        </div>
                        <div className="flex-shrink-0 min-w-[200px]">
                          <select
                            value={team.chipId}
                            onChange={(e) => updateTeamChip(teamIndex, parseInt(e.target.value))}
                            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            required
                          >
                            {allChips.map(chip => {
                              const isUsedInCurrentGame = teams.some((t, i) => i !== teamIndex && t.chipId === chip.id);
                              const isUsedInOtherGame = usedChipIds.has(chip.id);
                              const isDisabled = isUsedInCurrentGame || isUsedInOtherGame;
                              return (
                                <option key={chip.id} value={chip.id} disabled={isDisabled}>
                                  Chip #{chip.key_number} - {chip.key_name}{isDisabled ? ' (In use)' : ''}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                        <div className="flex-1">
                          <input
                            type="text"
                            value={team.name}
                            onChange={(e) => updateTeamName(teamIndex, e.target.value)}
                            className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            placeholder="Team name"
                            required
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 pt-4 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-6 py-2 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition font-medium flex items-center gap-2"
                >
                  <ChevronLeft size={20} />
                  Back
                </button>
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-6 py-2 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition font-medium flex items-center gap-2"
                  >
                    Next
                    <ChevronRight size={20} />
                  </button>
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <h3 className="text-lg font-semibold text-white mb-1">
                  Devices to launch on
                </h3>
                <p className="text-sm text-slate-400 mb-4">
                  Pick which paired devices should run this game. Online devices
                  join within ~10s; offline devices receive the launch when they
                  reconnect (within 15 minutes).
                </p>
                {pairedLoading ? (
                  <p className="text-slate-400 text-sm">Loading paired devices…</p>
                ) : (
                  <div className="space-y-2">
                    {/* Mother row — always rendered, defaults checked, but
                        unchecking is allowed so the operator can launch a
                        "server-only" mother that doesn't participate. */}
                    <label className="flex items-center gap-3 p-3 bg-slate-800 border border-slate-700 rounded-lg cursor-pointer hover:bg-slate-700/50">
                      <input
                        type="checkbox"
                        checked={motherChecked}
                        onChange={(e) => setMotherChecked(e.target.checked)}
                        className="w-4 h-4 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                      <span className="flex-1 text-white font-medium">
                        This device <span className="text-xs text-slate-500">(mother)</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-green-500/10 text-green-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                        online
                      </span>
                      {!motherChecked && (
                        <span className="text-xs text-amber-400 italic">
                          will host the game without participating
                        </span>
                      )}
                    </label>

                    {/* Paired (non-self) devices */}
                    {pairedDevices.filter(d => !d.is_self).length === 0 ? (
                      <p className="text-sm text-slate-500 italic px-1 mt-2">
                        No other paired devices.
                      </p>
                    ) : (
                      pairedDevices
                        .filter(d => !d.is_self)
                        .map(device => {
                          const checked = selectedDeviceIds.has(device.id);
                          return (
                            <label
                              key={device.id}
                              className={`flex items-center gap-3 p-3 bg-slate-800 border rounded-lg cursor-pointer hover:bg-slate-700/50 ${
                                device.online ? 'border-slate-700' : 'border-slate-700/50 opacity-70'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  setSelectedDeviceIds(prev => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.add(device.id);
                                    else next.delete(device.id);
                                    return next;
                                  });
                                }}
                                className="w-4 h-4 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-white font-medium truncate">
                                  {device.device_label}
                                </div>
                                {device.peer_os && (
                                  <div className="text-xs text-slate-500 truncate">{device.peer_os}</div>
                                )}
                              </div>
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                                  device.has_reader
                                    ? 'bg-green-500/10 text-green-400'
                                    : 'bg-slate-700/50 text-slate-500'
                                }`}
                              >
                                <Usb size={12} />
                                {device.has_reader ? 'reader' : 'no reader'}
                              </span>
                              <span
                                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs ${
                                  device.online
                                    ? 'bg-green-500/10 text-green-400'
                                    : 'bg-slate-700/50 text-slate-500'
                                }`}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    device.online ? 'bg-green-500' : 'bg-slate-500'
                                  }`}
                                />
                                {device.online ? 'online' : 'offline'}
                              </span>
                            </label>
                          );
                        })
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-4 pt-4 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-6 py-2 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition font-medium flex items-center gap-2"
                >
                  <ChevronLeft size={20} />
                  Back
                </button>
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-6 py-2 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!motherChecked && selectedDeviceIds.size === 0}
                    className="px-6 py-2 bg-green-600 hover:bg-green-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition font-medium"
                  >
                    Launch on {(motherChecked ? 1 : 0) + selectedDeviceIds.size} device{(motherChecked ? 1 : 0) + selectedDeviceIds.size === 1 ? '' : 's'}
                  </button>
                </div>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
