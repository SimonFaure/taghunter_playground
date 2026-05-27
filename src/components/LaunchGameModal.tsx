import { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Usb, Save } from 'lucide-react';
import type { SiPuce } from '../types/database';
import * as cardsStore from '../services/cardsStore';
import * as cardsRepo from '../services/cardsRepo';
import * as patternStore from '../services/patternStore';
import * as scenarioStore from '../services/scenarioStore';
import * as gameTypesStore from '../services/gameTypesStore';
import * as clientPreferencesStore from '../services/clientPreferencesStore';
import * as launchConfigsStore from '../services/launchConfigsStore';
import {
  buildRoster,
  extractTracksOptions,
  EMPTY_TRACKS_OPTIONS,
  type TracksLaunchOptions,
  type PatternOption,
} from '../services/launchResolve';
import { ConfirmDialog } from './ConfirmDialog';
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

// ---------------------------------------------------------------- Tracks
// Tracks launch options are parsed from the scenario's game_meta. The editor
// enables a subset of each group; the operator picks one at launch. Labels
// mirror the studio's RoutesSection / DisplaysSection / etc. copy.
const TRACKS_ROUTE_LABELS: Record<string, string> = {
  default: 'Default (all checkpoints)',
  first_half: 'First half',
  last_half: 'Last half',
  odd: 'Odd checkpoints',
  even: 'Even checkpoints',
};
const TRACKS_DISPLAY_LABELS: Record<string, string> = {
  full: 'Full',
  map: 'Map',
  simple: 'Simple',
};
const TRACKS_PLAY_MODE_LABELS: Record<string, string> = {
  itinerary: 'Itinerary (ordered)',
  free: 'Free (any order)',
};
const TRACKS_SCORE_TYPE_LABELS: Record<string, string> = {
  percentage: 'Percentage',
  points: 'Points',
};

/** Compact radio group for a tracks launch option. Hidden when ≤1 option (auto-selected). */
function TracksRadioGroup({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: Array<{ key: string; label: string }>;
  value: string;
  onChange: (key: string) => void;
}) {
  if (options.length <= 1) return null;
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-300">{label}</label>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.key}
            className={`px-3 py-2 rounded-lg border-2 cursor-pointer text-sm transition-all ${
              value === o.key
                ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                : 'border-slate-600 bg-slate-800 text-slate-300 hover:border-slate-500'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={o.key}
              checked={value === o.key}
              onChange={() => onChange(o.key)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}

interface LaunchGameModalProps {
  isOpen: boolean;
  onClose: () => void;
  gameTitle: string;
  gameUniqid: string;
  gameTypeName: string;
  onLaunch: (config: GameConfig, deviceSelection: LaunchDeviceSelection) => void;
  /** Seed step-1 from a saved config (Edit a config, or headless critical-fallback). */
  prefillConfig?: Partial<GameConfig>;
  /** When editing an existing config, its current name (seeds the Save field). */
  prefillConfigName?: string;
  /** Amber banner shown atop step 1 — e.g. the reason a headless launch fell back here. */
  noticeText?: string;
  /** Fired after a config is saved so the host can refresh counts / toast. */
  onConfigSaved?: (name: string) => void;
}

export interface GameConfig {
  name: string;
  numberOfTeams: number;
  firstChipIndex: number;
  pattern: string;
  duration: number;
  messageDisplayDuration: number;
  enigmaImageDisplayDuration: number;
  colorblindMode: boolean;
  /** Mystery: relabeled "Auto-reset page" — auto-return the display to ready after results. */
  autoResetTeam: boolean;
  /** Mystery: when true, an instructions screen holds until Enter/click before
   *  the reveal animation; when false the board stays hidden and the reveal
   *  plays automatically on the finishing (second) bip. Defaults to true. */
  revealResultsOnInput?: boolean;
  /** Seconds the results stay on screen before the auto page-reset (when autoResetTeam). */
  delayBeforeReset: number;
  /** Mystery+tracks: no roster pre-built; each registered card's first bip creates+starts a team. */
  autoRegisterTeam?: boolean;
  /** Mystery+tracks: a finished card can start a fresh run after the cooldown. */
  reuseCards?: boolean;
  /** Mystery+tracks: each team types its own name on its first bip. Implies dynamic
   *  team mode (no roster) — the bip creates the team, then prompts for the name. */
  selfRegisterTeam?: boolean;
  /** Minutes after a card finishes before it can be reused (when reuseCards). */
  reuseDelayMinutes?: number;
  /** Mystery+tracks: draw a fun pooled team name (by audience+language) instead of the card's key_name. */
  useNamePool?: boolean;
  /** Audience for the name pool draw — defaults to the scenario's game_public, overridable here.
   *  Canonical trio mirrors studio's src/types/audience.ts. */
  namePoolAudience?: 'mini_kids' | 'kids' | 'ado_adultes';
  victoryType?: 'speed' | 'score';
  playMode?: 'solo' | 'team';
  teammatesPerTeam?: number;
  testMode?: boolean;
  teams?: Team[];
  /** Tagquest: seconds to keep the result (full image + score) on screen after
   *  each punch animation completes, before the page resets to its hidden state. */
  visibilityHideDelaySec?: number;
  /** Selected language code from the launch picker (drives translations + video subtitles). */
  language?: string;
  /** Play tutorial video on each team's first bip (mystery/tracks only). Off if no video exists. */
  playTutorialOnBip?: boolean;
  /** Play intro video (per-scenario scenario_video) on each team's first bip. Off if scenario has none. */
  playIntroOnBip?: boolean;
  /** Tracks: selected route key (default | first_half | last_half | odd | even). */
  route?: string;
  /** Tracks: the studio-enabled route set, persisted so the Add Team form can
   *  offer a per-team route override. */
  tracksRoutes?: string[];
  /** Tracks: selected display mode (full | map | simple). */
  displayMode?: string;
  /** Tracks: selected play mode (itinerary | free). Named distinctly from tagquest's `playMode`. */
  trackPlayMode?: 'itinerary' | 'free';
  /** Tracks: selected score type (percentage | points). */
  scoreType?: 'percentage' | 'points';
  /** Tracks: malus subtracted per minute over the time limit (points or %). */
  malusPerMinute?: number;
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

// Canonical audience trio for the name-pool draw — mirrors studio's
// src/types/audience.ts (game_meta.game_public). Legacy values fold onto it.
type NamePoolAudience = 'mini_kids' | 'kids' | 'ado_adultes';
const NAME_POOL_AUDIENCES: { value: NamePoolAudience; label: string }[] = [
  { value: 'mini_kids', label: 'Mini Kids' },
  { value: 'kids', label: 'Kids' },
  { value: 'ado_adultes', label: 'Teens/Adults' },
];
function normalizeGamePublic(raw: unknown): NamePoolAudience {
  const v = String(raw ?? '').toLowerCase();
  if (['adults', 'adult', 'adultes', 'teens', 'ado'].includes(v)) return 'ado_adultes';
  if (v === 'mini_kids' || v === 'ado_adultes') return v;
  return 'kids';
}

export function LaunchGameModal({
  isOpen,
  onClose,
  gameTitle,
  gameUniqid,
  gameTypeName,
  onLaunch,
  prefillConfig,
  prefillConfigName,
  noticeText,
  onConfigSaved,
}: LaunchGameModalProps) {
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
    revealResultsOnInput: true,
    autoRegisterTeam: false,
    reuseCards: false,
    selfRegisterTeam: false,
    reuseDelayMinutes: 5,
    victoryType: 'score',
    playMode: 'team',
    teammatesPerTeam: 2,
    testMode: false,
    visibilityHideDelaySec: 10,
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
  // Scenario's audience (game_meta.game_public) — default for the name-pool draw.
  const [scenarioPublic, setScenarioPublic] = useState<NamePoolAudience>('kids');
  const [gameTypeRow, setGameTypeRow] = useState<gameTypesStore.GameTypeRow | null>(null);
  const [hasTutorialVideo, setHasTutorialVideo] = useState(false);
  const [hasIntroVideo, setHasIntroVideo] = useState(false);
  const [prefTutorialDefault, setPrefTutorialDefault] = useState(false);
  const [prefIntroDefault, setPrefIntroDefault] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [tracksOptions, setTracksOptions] = useState<TracksLaunchOptions>(EMPTY_TRACKS_OPTIONS);
  const [showTracksAdvanced, setShowTracksAdvanced] = useState(false);
  // Tracks: checkpoint count from game_meta + a warning when the selected
  // pattern's row count doesn't match it (the checkpoint↔station binding is
  // positional, so a mismatch silently misaligns scoring).
  const [tracksCheckpointCount, setTracksCheckpointCount] = useState(0);
  const [tracksPatternWarning, setTracksPatternWarning] = useState('');
  const [availableChips, setAvailableChips] = useState<SiPuce[]>([]);
  const [onDemandChips, setOnDemandChips] = useState<SiPuce[]>([]);
  const [hasOnDemandCards, setHasOnDemandCards] = useState(false);
  const [useOnDemandCards, setUseOnDemandCards] = useState(false);
  const [usedChipIds, setUsedChipIds] = useState<Set<number>>(new Set());
  // Save-configuration UI (step 1). The inline name field appears when the
  // operator clicks "Save configuration"; saving does NOT launch.
  const [showSaveField, setShowSaveField] = useState(false);
  const [configName, setConfigName] = useState('');
  const [savePending, setSavePending] = useState(false);
  const [overwriteConfirm, setOverwriteConfirm] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

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

      // Audience for name-pool draws: scenario's game_meta.game_public, folded
      // onto the canonical trio (legacy 'adults'/'teens' -> 'ado_adultes').
      const gp = (rawGameData as { game_meta?: { game_public?: unknown } } | null)?.game_meta?.game_public;
      setScenarioPublic(normalizeGamePublic(gp));

      // Tracks: parse the enabled route/display/play_mode/score_type sets +
      // default time/malus from game_meta. No-op (empty) for other types.
      if (gameTypeLc === 'tracks') {
        setTracksOptions(extractTracksOptions(rawGameData));
        const gm = (rawGameData as { game_meta?: { checkpoints?: unknown } } | null)?.game_meta
          ?? (rawGameData as { game_data?: { game_meta?: { checkpoints?: unknown } } } | null)?.game_data?.game_meta;
        const cps = gm?.checkpoints;
        setTracksCheckpointCount(Array.isArray(cps) ? cps.length : 0);
      } else {
        setTracksOptions(EMPTY_TRACKS_OPTIONS);
        setTracksCheckpointCount(0);
      }

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
      const isTracksType = gameTypeName.toLowerCase() === 'tracks';
      const isMysteryType = gameTypeName.toLowerCase() === 'mystery';
      // Tracks default selections: first enabled key in declaration order;
      // score type uses the `default`-flagged one, falling back to first enabled.
      const defaultScoreType =
        tracksOptions.scoreTypes.find((s) => s.isDefault)?.key ??
        tracksOptions.scoreTypes[0]?.key;
      setConfig({
        numberOfTeams: 10,
        firstChipIndex: 1,
        pattern: defaultPattern,
        duration: isTracksType ? tracksOptions.defaultTime : (isMysteryType ? 90 : 60),
        messageDisplayDuration: 5,
        enigmaImageDisplayDuration: 1,
        colorblindMode: false,
        autoResetTeam: false,
        delayBeforeReset: 10,
        revealResultsOnInput: true,
        autoRegisterTeam: false,
        reuseCards: false,
        selfRegisterTeam: false,
        reuseDelayMinutes: 5,
        useNamePool: false,
        namePoolAudience: scenarioPublic,
        victoryType: 'score',
        playMode: 'team',
        teammatesPerTeam: 2,
        testMode: false,
        visibilityHideDelaySec: 10,
        language: scenarioDefaultLang,
        playTutorialOnBip: hasTutorialVideo && prefTutorialDefault,
        playIntroOnBip: hasIntroVideo && prefIntroDefault,
        route: tracksOptions.routes[0],
        tracksRoutes: tracksOptions.routes,
        displayMode: tracksOptions.displays[0],
        trackPlayMode: tracksOptions.playModes[0] as 'itinerary' | 'free' | undefined,
        scoreType: defaultScoreType as 'percentage' | 'points' | undefined,
        malusPerMinute: tracksOptions.defaultMalus,
        // A saved config (Edit / headless fallback) overrides the computed
        // defaults. `name` stays blank — it's per-instance, never restored.
        ...(prefillConfig ?? {}),
        name: '',
      });
      setStep(1);
      setTeams([]);
      setPairedDevices([]);
      setSelectedDeviceIds(new Set());
      setMotherChecked(true);
      setShowTracksAdvanced(false);
      // Seed the save field when editing an existing config; otherwise reset.
      setConfigName(prefillConfigName ?? '');
      setShowSaveField(!!prefillConfigName);
      setSavePending(false);
      setOverwriteConfirm(null);
      setSavedFlash(null);
    }
  }, [isOpen, defaultPattern, scenarioDefaultLang, scenarioPublic, hasTutorialVideo, hasIntroVideo, prefTutorialDefault, prefIntroDefault, gameTypeName, tracksOptions, prefillConfig, prefillConfigName]);

  // Tracks: warn when the selected pattern's row count doesn't match the
  // course's checkpoint count. The checkpoint↔station binding is positional
  // (pattern row N ↔ Nth checkpoint), so a mismatch silently misaligns scoring.
  useEffect(() => {
    if (gameTypeName.toLowerCase() !== 'tracks' || !config.pattern || tracksCheckpointCount === 0) {
      setTracksPatternWarning('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stations = await patternStore.getTracksCheckpointStations(config.pattern);
        if (cancelled) return;
        if (stations.size !== tracksCheckpointCount) {
          setTracksPatternWarning(
            `This pattern defines ${stations.size} checkpoint row(s) but the course has ${tracksCheckpointCount} checkpoint(s). Scoring may misalign — make sure the pattern matches this scenario.`,
          );
        } else {
          setTracksPatternWarning('');
        }
      } catch {
        if (!cancelled) setTracksPatternWarning('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameTypeName, config.pattern, tracksCheckpointCount]);

  const allChips = useOnDemandCards
    ? [...availableChips, ...onDemandChips]
    : availableChips;

  const isTagQuest = gameTypeName.toLowerCase() === 'tagquest';
  const isTracks = gameTypeName.toLowerCase() === 'tracks';
  const isMystery = gameTypeName.toLowerCase() === 'mystery';
  // Auto-register + reuse-cards are offered for the card-collection runtimes
  // that create teams on bip (mystery, tracks) — not tagquest.
  const supportsDynamicTeams = isMystery || isTracks;
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
    // Roster build lives in launchResolve so the headless Quick Launch path
    // produces an identical roster from the same inputs.
    const combinedChips = [...availableChips, ...onDemandChips];
    setTeams(buildRoster(config, combinedChips, gameTypeName));
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

  // Advance to the device picker (step 3). Lazy-fetch the paired list and
  // pre-check the mother + every currently-online satellite. Offline peers
  // are visible but unchecked — the operator can opt to queue a join_game
  // command that wakes them up when they reconnect (15-minute TTL on the
  // pending_commands row).
  const advanceToDevices = async () => {
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
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (step === 1) {
      // Dynamic-team modes (auto-register / self-register) build no roster, so
      // skip the team-config step.
      if (config.autoRegisterTeam || config.selfRegisterTeam) {
        setTeams([]);
        await advanceToDevices();
      } else {
        handleNextStep();
      }
      return;
    }

    if (step === 2) {
      await advanceToDevices();
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

  // Persist the current step-1 settings as a named, scenario-assigned config.
  // Does NOT launch and does NOT advance the wizard. Strips the per-instance
  // name/teams (handled in launchConfigsStore).
  const performSaveConfig = async (name: string) => {
    if (!user?.client_id) return;
    setSavePending(true);
    try {
      await launchConfigsStore.upsertByName(user.client_id, gameUniqid, name, config);
      setOverwriteConfirm(null);
      setSavedFlash(name);
      onConfigSaved?.(name);
      window.setTimeout(() => setSavedFlash(null), 2500);
    } catch (err) {
      console.error('[LaunchGameModal] failed to save launch config:', err);
    } finally {
      setSavePending(false);
    }
  };

  const handleSaveConfigClick = async () => {
    const name = configName.trim();
    if (!name || !user?.client_id) return;
    // Overwrite-on-name-match: confirm before replacing an existing config.
    const exists = await launchConfigsStore.existsByName(user.client_id, gameUniqid, name);
    if (exists) {
      setOverwriteConfirm(name);
    } else {
      await performSaveConfig(name);
    }
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
          {noticeText && (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
              <span>{noticeText}</span>
            </div>
          )}
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
            {!(config.autoRegisterTeam || config.selfRegisterTeam) && (
            <>
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
            </>
            )}

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
              {tracksPatternWarning && (
                <p className="text-xs text-amber-300/90 flex items-start gap-1.5">
                  <span aria-hidden>⚠️</span>
                  <span>{tracksPatternWarning}</span>
                </p>
              )}
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

          {isTracks && (
            <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg">
              <TracksRadioGroup
                label="Route"
                name="tracksRoute"
                options={tracksOptions.routes.map((k) => ({ key: k, label: TRACKS_ROUTE_LABELS[k] ?? k }))}
                value={config.route ?? ''}
                onChange={(k) => setConfig({ ...config, route: k })}
              />
              <TracksRadioGroup
                label="Display mode"
                name="tracksDisplay"
                options={tracksOptions.displays.map((k) => ({ key: k, label: TRACKS_DISPLAY_LABELS[k] ?? k }))}
                value={config.displayMode ?? ''}
                onChange={(k) => setConfig({ ...config, displayMode: k })}
              />
              <TracksRadioGroup
                label="Play mode"
                name="tracksPlayMode"
                options={tracksOptions.playModes.map((k) => ({ key: k, label: TRACKS_PLAY_MODE_LABELS[k] ?? k }))}
                value={config.trackPlayMode ?? ''}
                onChange={(k) => setConfig({ ...config, trackPlayMode: k as 'itinerary' | 'free' })}
              />
              <TracksRadioGroup
                label="Score type"
                name="tracksScoreType"
                options={tracksOptions.scoreTypes.map((s) => ({ key: s.key, label: TRACKS_SCORE_TYPE_LABELS[s.key] ?? s.key }))}
                value={config.scoreType ?? ''}
                onChange={(k) => setConfig({ ...config, scoreType: k as 'percentage' | 'points' })}
              />

              <div className="pt-1 border-t border-slate-700/60">
                <button
                  type="button"
                  onClick={() => setShowTracksAdvanced((v) => !v)}
                  className="text-sm text-slate-400 hover:text-slate-200 transition"
                >
                  {showTracksAdvanced ? '▾' : '▸'} Advanced
                </button>
                {showTracksAdvanced && (
                  <div className="mt-3 space-y-2">
                    <label htmlFor="malusPerMinute" className="block text-sm font-medium text-slate-300">
                      Malus per minute over (points or %)
                    </label>
                    <input
                      type="number"
                      id="malusPerMinute"
                      min={0}
                      value={config.malusPerMinute ?? tracksOptions.defaultMalus}
                      onChange={(e) =>
                        setConfig({ ...config, malusPerMinute: Math.max(0, parseInt(e.target.value) || 0) })
                      }
                      className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <p className="text-xs text-slate-500">
                      Game time is set by the Duration field above. The malus is
                      subtracted from the final score for each minute over.
                    </p>
                  </div>
                )}
              </div>
            </div>
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

            {supportsDynamicTeams && (
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="autoRegisterTeam"
                  checked={!!config.autoRegisterTeam}
                  onChange={(e) => setConfig({ ...config, autoRegisterTeam: e.target.checked })}
                  className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
                <label htmlFor="autoRegisterTeam" className="text-sm font-medium text-slate-300">
                  Auto register team
                  <span className="ml-2 text-xs text-slate-400 font-normal">(first bip of each registered card creates and starts a team)</span>
                </label>
              </div>
            )}

            {supportsDynamicTeams && (
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="selfRegisterTeam"
                  checked={!!config.selfRegisterTeam}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      selfRegisterTeam: e.target.checked,
                      // The name pool is meaningless when players type their own
                      // name (self-register overwrites it), so clear it.
                      useNamePool: e.target.checked ? false : config.useNamePool,
                    })
                  }
                  className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
                <label htmlFor="selfRegisterTeam" className="text-sm font-medium text-slate-300">
                  Self-register team names
                  <span className="ml-2 text-xs text-slate-400 font-normal">(each team types its own name on first bip — teams are created on bip)</span>
                </label>
              </div>
            )}

            {supportsDynamicTeams && (
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="reuseCards"
                  checked={!!config.reuseCards}
                  onChange={(e) => setConfig({ ...config, reuseCards: e.target.checked })}
                  className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
                <label htmlFor="reuseCards" className="text-sm font-medium text-slate-300">
                  Reuse cards
                  <span className="ml-2 text-xs text-slate-400 font-normal">(a finished card can start a fresh run after a delay)</span>
                </label>
              </div>
            )}

            {supportsDynamicTeams && config.reuseCards && (
              <div className="ml-8 space-y-2">
                <label htmlFor="reuseDelayMinutes" className="block text-sm font-medium text-slate-300">
                  Delay before a finished card can be reused (minutes)
                </label>
                <input
                  type="number"
                  id="reuseDelayMinutes"
                  min="0"
                  value={config.reuseDelayMinutes ?? 5}
                  onChange={(e) => setConfig({ ...config, reuseDelayMinutes: Math.max(0, parseInt(e.target.value) || 0) })}
                  className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
              </div>
            )}

            {/* Name pool — only meaningful when teams are created dynamically and
                the players aren't naming themselves (self-register overwrites it). */}
            {supportsDynamicTeams && (config.autoRegisterTeam || config.reuseCards) && !config.selfRegisterTeam && (
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="useNamePool"
                  checked={!!config.useNamePool}
                  onChange={(e) => setConfig({ ...config, useNamePool: e.target.checked })}
                  className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
                <label htmlFor="useNamePool" className="text-sm font-medium text-slate-300">
                  Use team-name pool
                  <span className="ml-2 text-xs text-slate-400 font-normal">(draw a fun name instead of the card name)</span>
                </label>
              </div>
            )}

            {supportsDynamicTeams && (config.autoRegisterTeam || config.reuseCards) && !config.selfRegisterTeam && config.useNamePool && (
              <div className="ml-8 space-y-2">
                <label htmlFor="namePoolAudience" className="block text-sm font-medium text-slate-300">
                  Audience
                  <span className="ml-2 text-xs text-slate-400 font-normal">(defaults to the scenario's public)</span>
                </label>
                <select
                  id="namePoolAudience"
                  value={config.namePoolAudience ?? scenarioPublic}
                  onChange={(e) => setConfig({ ...config, namePoolAudience: e.target.value as NamePoolAudience })}
                  className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {NAME_POOL_AUDIENCES.map((a) => (
                    <option key={a.value} value={a.value}>{a.label}</option>
                  ))}
                </select>
              </div>
            )}

            {isMystery && (
            <>
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="autoResetTeam"
                checked={config.autoResetTeam}
                onChange={(e) => setConfig({ ...config, autoResetTeam: e.target.checked })}
                className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
              />
              <label htmlFor="autoResetTeam" className="text-sm font-medium text-slate-300">
                Auto-reset page
                <span className="ml-2 text-xs text-slate-400 font-normal">(returns the display to the ready screen after results — no Enter/reset needed)</span>
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

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="revealResultsOnInput"
                checked={config.revealResultsOnInput ?? true}
                onChange={(e) => setConfig({ ...config, revealResultsOnInput: e.target.checked })}
                className="w-5 h-5 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
              />
              <label htmlFor="revealResultsOnInput" className="text-sm font-medium text-slate-300">
                Use Enter or click to reveal results
                <span className="ml-2 text-xs text-slate-400 font-normal">(checked: an instructions screen holds until Enter/click, then plays the reveal. Unchecked: the board stays hidden and reveals automatically on the finishing bip.)</span>
              </label>
            </div>
            </>
            )}

            <div className="pt-1 border-t border-slate-700/60 space-y-2">
              <label className="block text-sm font-medium text-slate-300">
                Keep result on screen
              </label>
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={config.visibilityHideDelaySec ?? 10}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      visibilityHideDelaySec: Math.max(0, parseInt(e.target.value) || 0),
                    })
                  }
                  className="w-16 px-2 py-0.5 text-sm bg-slate-800 border border-slate-700 rounded text-white"
                />
                seconds
              </div>
              <p className="text-xs text-slate-400">
                After each punch animation, the full image + score stay on screen for this long, then everything hides until the next punch.
              </p>
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

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pt-4 border-t border-slate-700">
            {/* Save-configuration control — persists step-1 settings as a named,
                scenario-assigned preset. Does NOT launch or advance. */}
            <div className="flex items-center gap-2 flex-wrap">
              {!showSaveField ? (
                <button
                  type="button"
                  onClick={() => setShowSaveField(true)}
                  className="px-4 py-2 text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition font-medium flex items-center gap-2 text-sm"
                >
                  <Save size={16} />
                  Save configuration
                </button>
              ) : (
                <>
                  <input
                    type="text"
                    value={configName}
                    onChange={(e) => setConfigName(e.target.value)}
                    placeholder="Configuration name"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleSaveConfigClick();
                      }
                    }}
                    className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSaveConfigClick()}
                    disabled={!configName.trim() || savePending}
                    className="px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-lg transition font-medium flex items-center gap-2 text-sm"
                  >
                    <Save size={16} />
                    {savePending ? 'Saving…' : 'Save'}
                  </button>
                  {savedFlash && (
                    <span className="text-sm text-green-400">Saved “{savedFlash}”</span>
                  )}
                </>
              )}
            </div>
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
                  onClick={() => setStep(config.autoRegisterTeam || config.selfRegisterTeam ? 1 : 2)}
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

      <ConfirmDialog
        isOpen={overwriteConfirm !== null}
        onConfirm={() => overwriteConfirm && void performSaveConfig(overwriteConfirm)}
        onCancel={() => setOverwriteConfirm(null)}
        title="Replace configuration"
        message={`A configuration named “${overwriteConfirm}” already exists for this scenario. Replace it?`}
        confirmText="Replace"
        cancelText="Cancel"
        variant="warning"
      />
    </div>
  );
}
