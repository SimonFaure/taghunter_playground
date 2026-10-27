import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GameConfig } from './LaunchGameModal';
import { sportidentService as siReader, CardData, StationData, detectReaderPort } from '../services/sportidentService';
import { useDetectedReaderPort } from '../services/useDetectedReaderPort';
import { CardDetectionAlert } from './CardDetectionAlert';
import { GameMessageOverlay } from './GameMessageOverlay';
import { PendingTeamsBar } from './PendingTeamsBar';
import { usePresentationQueue } from '../hooks/usePresentationQueue';
import { useGameSounds } from '../hooks/useGameSounds';
import { localizedStatus, type GameMessageType } from '../services/gameMessages';
import { tIngame } from '../i18n/ingame';
import {
  getLaunchedGameState,
  recordPunch,
  updateTeam,
  deleteTeam,
  getLaunchedGameMeta,
  mergeLaunchedGameMeta,
  removeLaunchedGameMetaKeys,
} from '../services/launchedGames';
import { ensureTeamForCard } from '../services/teamRegistration';
import * as patternStore from '../services/patternStore';
import * as scenarioStore from '../services/scenarioStore';
import { scenarioAssetUrl } from '../services/contentFs';
import { resolveFontFamily } from '../fonts/resolveFontFamily';
import { registerScenarioFonts } from '../fonts/registerScenarioFonts';
import { useGameStatePolling } from '../hooks/useGameStatePolling';
import { FirstBipVideoOverlay } from './FirstBipVideoOverlay';
import { SelfRegisterOverlay } from './SelfRegisterOverlay';
import { resolveFirstBipVideos } from '../services/firstBipVideos';
import { usePendingStarts } from '../hooks/usePendingStarts';
import {
  TracksGameRenderer,
  readLocalized,
  type TracksScreen,
  type TracksDisplayMode,
  type TracksBigReveal,
  type SceneTextElement,
  type SceneTextCategory,
} from './TracksGameRenderer';
import { TRACKS_LEGEND_ID, TRACKS_LEGEND_DEFAULT_BOX } from './TracksLegend';
import { tracksLegendDefaultOn } from '../services/launchResolve';
import {
  checkpointsForRoute,
  computeScore,
  firstSlotByCheckpoint,
  orderedHitCheckpointIds,
  sortTracksTeams,
  rankTier,
  type TracksCheckpoint,
  type TracksScoreType,
} from '../services/tracksScoring';
import { gameClock } from '../services/gameClock';
import { onPendingResetDisplay } from '../services/pendingJoinStore';
import { refineInGame, clearInGameRefinement } from '../services/screenState';

interface TracksGamePageProps {
  config: GameConfig;
  gameUniqid: string;
  launchedGameId: number | null;
  onBack: () => void;
  onGameEnd?: () => void;
}

/** HUD frame position saved by the studio LayoutEditor; values are % of the
 *  map image (same referential as checkpoint markers + text elements). */
interface HudFrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Author-set value font size, in % of the box height. Undefined = the
   *  renderer's default (45 with a caption, 55 without). Retours point 45. */
  textScale?: number;
  /** Team-name frame only: min font size in px on a 1920×1080 screen; below it
   *  the name wraps to two lines. Undefined = 20 px default; 0 = never wrap. */
  minFontSize?: number;
}

/** HUD frame element ids written to `scenarios.scenario_layout.elements[]` by
 *  the studio LayoutEditor. Mirrors `TRACKS_HUD_ITEMS` in the studio's
 *  `creator-ported/utils/layoutGroups.ts` - three frames; the legacy
 *  `time_background_image` slot was never drawn and is ignored here. */
const HUD_FRAME_IDS = [
  'team_name_background_image',
  'timer_background_image',
  'score_background_image',
] as const;

interface TracksGameData {
  title: string;
  font?: string;
  font_color?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  custom_fonts?: any[];
  checkpoints: TracksCheckpoint[];
  checkpoints_unique_image: boolean;
  // resolved image filenames (bare) keyed by logical slot
  images: Record<string, string>;
  // checkpoint_id → image filename
  checkpointImages: Record<string, string>;
  // logical sound slot → filename
  sounds: Record<string, string>;
  iconSizePercent: number;
  showScore: boolean;
  autoReset: boolean;
  /** Author-defined text overlays on the map; rendered by TracksGameRenderer
   *  when the map is showing. Plan: tracks-text-elements.md. */
  textElements: SceneTextElement[];
  /** Author-defined categories carrying typography defaults; per-element
   *  fields inherit when not set. Plan: tracks-text-elements-categories.md. */
  textCategories: SceneTextCategory[];
  /** Saved positions for the 4 HUD frames (team_name, timer, score, time),
   *  keyed by element id; empty map → renderer uses its default top strip. */
  hudLayout: Partial<Record<(typeof HUD_FRAME_IDS)[number], HudFrameBox>>;
  /** Feedback-image legend box geometry: the box saved in the layout editor,
   *  else the studio default. Whether it is drawn is a per-launch choice
   *  (`config.tracksShowLegend`) defaulting to `legendDefaultOn`. */
  legendBox: HudFrameBox;
  /** The scenario's own choice: `game_meta.show_legend` on and the box not
   *  hidden by the author. */
  legendDefaultOn: boolean;
  /** Author-written legend captions (`text_legend_*`), each a
   *  Localized<string> | string; blank/missing ⇒ the app's own caption. */
  legendTexts: { wrongOrder: unknown; missing: unknown };
  /** Author-editable run messages (text_* UI strings), each a
   *  Localized<string> | string. Surfaced by the runtime only when the author
   *  filled the field in; an empty/missing key keeps the built-in behaviour. */
  texts: Record<string, unknown>;
}

/** The text_* keys the tracks runtime can surface (see TextStringsSection in
 *  studio - tracks omits the ranking/podium/level/late-malus strings). */
const TRACKS_TEXT_KEYS = [
  'text_player_starts',
  'text_team_starts_card_not_empty',
  'text_card_not_corresponding',
  'text_team_ended',
  'text_scenario_ended',
  'text_card_empty',
  'text_if_error',
] as const;

/**
 * Every spelling of the team-name placeholder an author may type. `%team%` is
 * the one the studio editor advertises ("Astuce : écrivez %team% ..."), and it
 * is written `%TEAM%` as often as `%team%` - hence the case-insensitive flag.
 * The `{team}`/`{name}`/`%s` forms are legacy spellings kept working.
 *
 * Matching only the brace forms left a literal `%TEAM%` on the Track start
 * screen (retours #86; the same class of bug as GO/Spot's #62).
 */
const TEAM_TOKEN_RE = /%team%|%name%|\{team\}|\{name\}|%s/gi;
const COUNT_TOKEN_RE = /%count%|\{count\}|%d/gi;

/**
 * Resolve one text_* string for the given language, substituting the team name
 * and an optional count. Returns '' when the author left the field blank -
 * callers then fall back to the built-in message.
 *
 * Team tokens are ALWAYS consumed, even with no team name to put in their
 * place: a stray `%TEAM%` reaching the screen is worse than a missing word.
 */
function resolveTracksText(
  texts: Record<string, unknown> | undefined,
  key: (typeof TRACKS_TEXT_KEYS)[number],
  lang: string,
  vars?: { team?: string | null; count?: number },
): string {
  const raw = readLocalized(
    (texts?.[key] ?? undefined) as Record<string, string> | string | undefined,
    lang,
  ).trim();
  if (!raw) return '';
  let out = raw.replace(TEAM_TOKEN_RE, (vars?.team ?? '').trim());
  if (vars?.count != null) out = out.replace(COUNT_TOKEN_RE, String(vars.count));
  return out.trim();
}

/**
 * A legend caption in `lang`: the author's text for THAT language when they
 * wrote one, else the app's own caption. Deliberately no cross-language
 * fallback (unlike readLocalized): the app caption exists in every language,
 * so it beats showing a French custom caption to an English team.
 */
function resolveLegendLabel(
  authored: unknown,
  appKey: 'legend_wrong_order' | 'legend_missing_checkpoint',
  lang: string,
): string {
  const own =
    typeof authored === 'string'
      ? authored
      : authored && typeof authored === 'object'
        ? (authored as Record<string, unknown>)[lang]
        : '';
  const text = typeof own === 'string' ? own.trim() : '';
  return text || tIngame('ingame_tracks', appKey, lang);
}

const SOUND_SLOTS = [
  'checkpoint_success',
  'checkpoint_error',
  'checkpoint_no_answer',
  'top_1_sound',
  'top_3_sound',
  'top_10_sound',
] as const;

const IMAGE_SLOTS = [
  'background_image',
  'map_image',
  'team_name_background_image',
  'timer_background_image',
  'score_background_image',
  'wrong_order_image',
  'missing_checkpoint_image',
  'checkpoints_unique_image_id',
  'top_1_image',
  'top_3_image',
  'top_10_image',
] as const;

/** Normalize the on-disk game-data.json (envelope or flat) into TracksGameData. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeTracksGameData(raw: any): TracksGameData {
  const gm = raw?.game_data?.game_meta ?? raw?.game_meta ?? {};
  const medias = raw?.game_data?.medias ?? raw?.medias ?? {};

  // Image fields: prefer the value inlined on game_meta (importer merges them),
  // else fall back to medias.images.<slot>.
  const images: Record<string, string> = {};
  for (const slot of IMAGE_SLOTS) {
    const fromMeta = typeof gm[slot] === 'string' ? gm[slot] : '';
    const fromMedias = typeof medias?.images?.[slot] === 'string' ? medias.images[slot] : '';
    const v = fromMeta || fromMedias;
    if (v) images[slot] = v;
  }

  // Sounds: medias.sounds may be an array [{sound_type, sound_file}] or an
  // object {slot: filename}. Also accept inline game_meta.<slot>.
  const sounds: Record<string, string> = {};
  const ms = medias?.sounds;
  if (Array.isArray(ms)) {
    for (const s of ms) {
      if (s?.sound_type && s?.sound_file) sounds[s.sound_type] = s.sound_file;
    }
  } else if (ms && typeof ms === 'object') {
    for (const [k, v] of Object.entries(ms)) {
      if (typeof v === 'string' && v) sounds[k] = v;
    }
  }
  for (const slot of SOUND_SLOTS) {
    if (!sounds[slot] && typeof gm[slot] === 'string' && gm[slot]) sounds[slot] = gm[slot];
  }

  // Per-checkpoint images: medias.checkpoints[] (by checkpoint_id) overlaid on
  // any inline checkpoint.image.
  const checkpoints: TracksCheckpoint[] = Array.isArray(gm.checkpoints) ? gm.checkpoints : [];
  const checkpointImages: Record<string, string> = {};
  for (const cp of checkpoints) {
    if (typeof cp.image === 'string' && cp.image) checkpointImages[cp.id] = cp.image;
  }
  if (Array.isArray(medias?.checkpoints)) {
    for (const mc of medias.checkpoints) {
      if (mc?.checkpoint_id && typeof mc.image === 'string' && mc.image) {
        checkpointImages[mc.checkpoint_id] = mc.image;
      }
    }
  }

  const iconPct = parseFloat(gm.checkpoint_image_width_percentage ?? '3');

  // Authored text overlays. Pass through as-is; the renderer skips entries
  // without `position` (the "unplaced" state from the studio LayoutEditor).
  const textElements: SceneTextElement[] = Array.isArray(gm.text_elements)
    ? (gm.text_elements as SceneTextElement[])
    : [];

  // Author-defined categories carrying typography defaults. Pass through;
  // the renderer indexes them by id and resolves per-element inheritance.
  const textCategories: SceneTextCategory[] = Array.isArray(gm.text_categories)
    ? (gm.text_categories as SceneTextCategory[])
    : [];

  // HUD frame positions from the studio LayoutEditor. Accepts BOTH
  // distribution shapes: cloud (playground.php splices `scenario_layout` into
  // `gameData`) and ZIP (`buildZipPayload` puts `layout` at the top of
  // `game-data.json`). Coords are `% of map image`, identical referential to
  // checkpoint markers + text elements.
  const layoutElements: unknown[] =
    Array.isArray(raw?.scenario_layout?.elements)
      ? raw.scenario_layout.elements
      : Array.isArray(raw?.layout?.elements)
        ? raw.layout.elements
        : Array.isArray(raw?.game_data?.scenario_layout?.elements)
          ? raw.game_data.scenario_layout.elements
          : [];
  const hudLayout: Partial<Record<(typeof HUD_FRAME_IDS)[number], HudFrameBox>> = {};
  let legendBox: HudFrameBox = { ...TRACKS_LEGEND_DEFAULT_BOX };
  for (const el of layoutElements) {
    const le = el as Record<string, unknown> | null;
    if (le && le.id === TRACKS_LEGEND_ID) {
      // A hidden box keeps its geometry: the operator can still ask for the
      // legend at launch, and it then shows where the author last placed it.
      if (
        typeof le.x === 'number' && typeof le.y === 'number' &&
        typeof le.width === 'number' && typeof le.height === 'number'
      ) {
        legendBox = {
          x: le.x, y: le.y, width: le.width, height: le.height,
          ...(typeof le.textScale === 'number' && le.textScale > 0 ? { textScale: le.textScale } : {}),
        };
      }
      continue;
    }
    if (
      el &&
      typeof el === 'object' &&
      typeof (el as Record<string, unknown>).id === 'string' &&
      HUD_FRAME_IDS.includes((el as { id: (typeof HUD_FRAME_IDS)[number] }).id) &&
      typeof (el as Record<string, unknown>).x === 'number' &&
      typeof (el as Record<string, unknown>).y === 'number' &&
      typeof (el as Record<string, unknown>).width === 'number' &&
      typeof (el as Record<string, unknown>).height === 'number'
    ) {
      const e = el as {
        id: (typeof HUD_FRAME_IDS)[number];
        x: number; y: number; width: number; height: number;
        textScale?: unknown;
        minFontSize?: unknown;
      };
      hudLayout[e.id] = {
        x: e.x, y: e.y, width: e.width, height: e.height,
        ...(typeof e.textScale === 'number' && e.textScale > 0 ? { textScale: e.textScale } : {}),
        ...(typeof e.minFontSize === 'number' && e.minFontSize >= 0 ? { minFontSize: e.minFontSize } : {}),
      };
    }
  }

  return {
    title:
      (typeof gm.title === 'string' ? gm.title : gm.title?.fr) ||
      raw?.scenario?.name ||
      'Tracks',
    font: gm.font,
    font_color: gm.font_color,
    custom_fonts: gm.custom_fonts,
    checkpoints,
    checkpoints_unique_image: !!gm.checkpoints_unique_image,
    images,
    checkpointImages,
    sounds,
    iconSizePercent: Number.isFinite(iconPct) ? iconPct : 3,
    showScore: gm.display_score !== false,
    autoReset: gm.auto_reset !== false,
    textElements,
    textCategories,
    hudLayout,
    legendBox,
    legendDefaultOn: tracksLegendDefaultOn(raw),
    legendTexts: {
      wrongOrder: gm.text_legend_wrong_order,
      missing: gm.text_legend_missing_checkpoint,
    },
    texts: (() => {
      const t: Record<string, unknown> = {};
      for (const k of TRACKS_TEXT_KEYS) if (gm[k] != null) t[k] = gm[k];
      return t;
    })(),
  };
}

const AUTO_RESET_SECONDS = 5;
const REVEAL_STEP_MS = 700;

/** Parse an SI clock time "HH:MM:SS" to seconds-of-day. */
function secondsOfDay(t: string): number {
  const [h, m, s] = (t ?? '').split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

/** Punches the SI card actually recorded (a 00:00:00 slot is an empty one). */
function timedPunches(card: CardData): Array<{ code: number; time: string }> {
  return (card.punches ?? []).filter((p) => p.time && p.time !== '00:00:00');
}

/**
 * Unix seconds for a seconds-of-day reading on the LOCAL day, used to rebuild a
 * start/end timestamp for a run recovered from the card itself (the SI clock is
 * all we have - the team never bipped a start). Clamped to "now" so a station
 * clock running fast can never produce a future timestamp (which would make the
 * run duration negative).
 */
function epochForSecondsOfDay(sod: number): number {
  const midnight = gameClock.date();
  midnight.setHours(0, 0, 0, 0);
  const guess = Math.floor(midnight.getTime() / 1000) + sod;
  return Math.min(guess, Math.floor(gameClock.now() / 1000));
}

export function TracksGamePage({ config, gameUniqid, launchedGameId, onBack, onGameEnd }: TracksGamePageProps) {
  // Operator-facing diagnostic strip - chrome language, not the team language.
  const { t: tr } = useTranslation('rankings');
  const [data, setData] = useState<TracksGameData | null>(null);
  const dataRef = useRef<TracksGameData | null>(null);
  // Punches read by THIS device's USB reader are processed immediately in
  // saveCardData; the 1s state poll then echoes those same raw_data rows back.
  // Track the row ids handled locally so the poll skips them - otherwise each
  // own-reader bip runs twice (now + ~1s later), which would start AND reveal a
  // team on its very first bip.
  const processedRawIdsRef = useRef<Set<number>>(new Set());
  // Cards that arrived at the start reader with punches still on them. The run
  // is NOT started on that first bip (retours #90: the "wipe your card" prompt
  // must not be bypassable); the next bip of the same card either starts the
  // run (they wiped it) or RECOVERS the run already recorded on it (retours
  // #91: kids who left without punching their start used to lose everything,
  // because the first bip declared their whole course "pre-existing").
  const dirtyCardHoldRef = useRef<Set<number>>(new Set());
  const [audioElements, setAudioElements] = useState<Record<string, HTMLAudioElement>>({});
  const [lastCardData, setLastCardData] = useState<CardData | null>(null);
  const [showCardAlert, setShowCardAlert] = useState(false);
  const [gameMessage, setGameMessage] = useState('');
  const [gameMessageType, setGameMessageType] = useState<GameMessageType>('info');
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Serial presentation queue: the second-bip reveal / clues-review AND status
  // messages share it, so a team bipping while one is on screen waits its turn
  // (and shows in the bottom line) instead of racing the current reveal.
  const queue = usePresentationQueue();
  // Stops the sounds when the page is left mid-reveal (quit / rankings).
  const playAudio = useGameSounds();

  // Focused-team display state - driven by the most recent bip.
  // Default screen is the resting background image; the map only appears for the
  // second-bip reveal (see tracks-reveal-redesign.md).
  const [screen, setScreen] = useState<TracksScreen>('background');
  // A team's result is on screen until it is reset (Enter, or the auto-reset
  // delay): the operator can reset it remotely (`reset_display`) - this
  // resolves the pending Enter wait so the presentation queue moves on.
  const [awaitingReset, setAwaitingReset] = useState(false);
  const enterResolverRef = useRef<(() => void) | null>(null);
  const [focusTeamName, setFocusTeamName] = useState('');
  // The in-focus team's display language (their reveal/clues render in it). Empty
  // ⇒ idle/shared screen, which falls back to the launch language below.
  const [focusLanguage, setFocusLanguage] = useState('');
  const [focusScoreText, setFocusScoreText] = useState('');
  const [focusHitCount, setFocusHitCount] = useState(0);
  const [topRevealUrl, setTopRevealUrl] = useState('');
  // Reveal state: checkpoints already placed on the map (cpId → per-status image
  // URL, accumulates during the walk) + the full-mode big-center reveal.
  const [placedCheckpoints, setPlacedCheckpoints] = useState<Map<string, string>>(new Map());
  const [bigReveal, setBigReveal] = useState<TracksBigReveal | null>(null);
  // Checkpoints the focused team reached, used by the clues page to show each
  // checkpoint's own image (found) vs the "not found" image (unfound).
  const [cluesFoundIds, setCluesFoundIds] = useState<Set<string>>(new Set());
  // Clues page: checkpoints punched but not credited (itinerary wrong order) -
  // drawn with the wrong-order image, like the reveal, not as "missing".
  const [cluesWrongIds, setCluesWrongIds] = useState<Set<string>>(new Set());
  // Clues page: seconds left before it closes itself (drawn bottom-right).
  const [cluesCountdown, setCluesCountdown] = useState<number | null>(null);
  // The focused team's resolved route (per-team meta override else launch
  // default) - drives which markers render and which checkpoints score.
  const [focusRoute, setFocusRoute] = useState(config.route ?? 'default');
  // HUD timer shows the focused team's frozen final run duration during the
  // reveal; blank otherwise (no HUD over the background during the run).
  const [focusFrozenSec, setFocusFrozenSec] = useState<number | null>(null);

  // Pending starts, one queue per overlay, keyed by team (mirrors
  // MysteryGamePage). Self-register prompt first when enabled: `finalize(name)`
  // persists the name + proceeds; `abort()` cancels the start (and deletes the
  // team if that bip created it). Then the first-bip videos, after which the
  // team's start is finalized.
  const pendingStarts = usePendingStarts();
  const { selfReg, videoStart } = pendingStarts;

  const detectedReader = useDetectedReaderPort();

  // Launch selections (from in-memory config; satellites read launched_games.meta).
  const route = config.route ?? 'default';
  const displayMode = (config.displayMode ?? 'map') as TracksDisplayMode;
  const trackPlayMode = (config.trackPlayMode ?? 'free') as 'itinerary' | 'free';
  const scoreType = (config.scoreType ?? 'percentage') as TracksScoreType;
  const timeLimitMin = config.duration || 60;
  const malusPerMinute = config.malusPerMinute ?? 1;
  const language = config.language ?? 'fr';
  // "Clues page on team return" is a per-launch option (was a studio scenario
  // setting). Off by default; sub-toggles default on when enabled.
  const clues = {
    enabled: !!config.cluesPage?.enabled,
    show_title: config.cluesPage?.show_title !== false,
    show_text: config.cluesPage?.show_text !== false,
    show_image: config.cluesPage?.show_image !== false,
  };
  // How long the clues page stays up. Missing ⇒ 10 s (games launched before
  // the option existed).
  const cluesDurationSec = Math.max(1, Math.round(Number(config.cluesPage?.duration_sec) || 10));

  useEffect(() => {
    const load = async () => {
      try {
        const raw = await scenarioStore.getGameData(gameUniqid);
        if (!raw) {
          console.error('[TracksGamePage] no game-data.json for', gameUniqid);
          return;
        }
        const normalized = normalizeTracksGameData(raw);
        setData(normalized);
        dataRef.current = normalized;
        void registerScenarioFonts(gameUniqid, normalized.custom_fonts);

        const loaded: Record<string, HTMLAudioElement> = {};
        for (const [slot, filename] of Object.entries(normalized.sounds)) {
          if (filename) loaded[slot] = new Audio(scenarioAssetUrl(gameUniqid, filename));
        }
        setAudioElements(loaded);
      } catch (err) {
        console.error('[TracksGamePage] load error:', err);
      }
    };
    void load();
  }, [gameUniqid]);

  // No on-screen back button on the kiosk display - Esc exits (operator keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const playSound = useCallback(
    (slot: string) => {
      playAudio(audioElements[slot]).catch((e) => console.error('[TracksGamePage] sound error:', e));
    },
    [audioElements, playAudio],
  );

  const scoreText = useCallback(
    (value: number) => (scoreType === 'percentage' ? `${Math.round(value)}%` : `${Math.round(value)} pts`),
    [scoreType],
  );

  // Transient full-screen status message (shared <GameMessageOverlay>). Used to
  // surface scored-run outcomes + the otherwise-silent failure paths below.
  const showMessage = useCallback(
    (message: string, type: GameMessageType = 'info', label: string | null = null) => {
      void queue.enqueue(label, () => new Promise<void>((resolve) => {
        setGameMessage(message);
        setGameMessageType(type);
        if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
        msgTimerRef.current = setTimeout(() => {
          setGameMessage('');
          msgTimerRef.current = null;
          resolve();
        }, config.messageDisplayDuration * 1000);
      }));
    },
    [config.messageDisplayDuration, queue.enqueue],
  );

  const getImageUrl = (filename: string | undefined) => {
    if (!filename || filename === 'undefined' || filename === 'null') return '';
    return scenarioAssetUrl(gameUniqid, filename);
  };

  const handleCardPunchLogic = useCallback(
    async (card: CardData) => {
      const gd = dataRef.current;
      if (!launchedGameId || !gd) return;

      try {
        // Resolve the team for this card per the auto-register / reuse rule.
        // Active run = the card's team with no end_time.
        const state = await getLaunchedGameState(launchedGameId, 0);
        const teamsForCard = state.teams.filter((t) => t.key_id === card.id);
        let team = teamsForCard.find((t) => t.end_time == null) ?? null;
        // True when *this* bip created the team - drives the self-register abort
        // cleanup (delete a just-created team, never a rostered one).
        let createdNow = false;
        // True when this bip opened a FRESH run on a card that already finished
        // one in this game (reuse-after-cooldown). Anything still on such a card
        // belongs to that closed run, so the not-empty-card recovery below must
        // not fire for it.
        let reusedAfterFinish = false;

        if (!team) {
          const finished = teamsForCard.length > 0;
          if (!finished) {
            // Card has never had a team in this game.
            if (!config.autoRegisterTeam && !config.selfRegisterTeam) {
              console.warn('[TracksGamePage] no team for card', card.id);
              showMessage(
                resolveTracksText(gd.texts, 'text_card_not_corresponding', language) ||
                  localizedStatus('card_not_registered', language),
                'warning',
              );
              return;
            }
            team = await ensureTeamForCard(launchedGameId, card.id, state, !!config.useNamePool);
            if (!team) {
              showMessage(localizedStatus('chip_not_recognized', language), 'warning'); // unknown chip
              return;
            }
            createdNow = true;
          } else {
            // Card already finished a run.
            const lastEnd = Math.max(...teamsForCard.map((t) => t.end_time ?? 0));
            const cooldownSec = (config.reuseDelayMinutes ?? 5) * 60;
            const cooled = !!config.reuseCards && gameClock.now() / 1000 >= lastEnd + cooldownSec;
            if (cooled) {
              team = await ensureTeamForCard(launchedGameId, card.id, state, !!config.useNamePool);
              if (!team) {
                showMessage(localizedStatus('chip_not_recognized', language), 'warning'); // unknown chip
                return;
              }
              createdNow = true;
              reusedAfterFinish = true;
            } else {
              // reuse off OR within cooldown → existing clues-review behavior:
              // show the map with every checkpoint revealed, then reset.
              if (!clues.enabled) {
                // No clues review to show - surface why the bip did nothing.
                if (config.reuseCards) {
                  const remainingMin = Math.max(
                    1,
                    Math.ceil((lastEnd + cooldownSec - gameClock.now() / 1000) / 60),
                  );
                  showMessage(
                    localizedStatus('reuse_cooldown', language, { n: remainingMin }),
                    'warning',
                  );
                } else {
                  // The scenario's "équipe terminée" text belongs HERE (a finished
                  // team bipping again), not on the run's end. Built-in fallback.
                  const lastTeam = teamsForCard[teamsForCard.length - 1];
                  const ended = dataRef.current
                    ? resolveTracksText(dataRef.current.texts, 'text_team_ended', lastTeam?.language || language, {
                        team: lastTeam?.team_name ?? '',
                      })
                    : '';
                  showMessage(ended || localizedStatus('team_already_finished', language), 'warning');
                }
                return;
              }
              const finishedTeam = teamsForCard[teamsForCard.length - 1];
              // Show the finished team's own route on the clues review.
              let cluesRoute = route;
              try {
                const m = await getLaunchedGameMeta(launchedGameId);
                cluesRoute = m[`route:${finishedTeam.id}`] || route;
              } catch {
                cluesRoute = route;
              }
              // Recompute which checkpoints this team reached (from the punches
              // still on the re-bipped card) so the clues page can show the
              // "not found" image for the ones they missed. Best-effort - on any
              // failure we fall back to an empty found-set (all shown as missing).
              let cluesFound = new Set<string>();
              const cluesWrong = new Set<string>();
              try {
                const allCps = gd.checkpoints;
                const routeCps = checkpointsForRoute(allCps, cluesRoute);
                const stations = await patternStore.getTracksCheckpointStations(config.pattern);
                const numberOf = (cp: TracksCheckpoint) => allCps.findIndex((c) => c.id === cp.id) + 1;
                const hitSlotByCp = firstSlotByCheckpoint(routeCps, numberOf, stations, card.punches ?? []);
                if (trackPlayMode === 'itinerary') {
                  cluesFound = orderedHitCheckpointIds(routeCps, hitSlotByCp).hitIds;
                  for (const cp of routeCps) {
                    if (!cluesFound.has(cp.id) && hitSlotByCp.get(cp.id) !== undefined) cluesWrong.add(cp.id);
                  }
                } else {
                  for (const cp of routeCps) {
                    if (hitSlotByCp.get(cp.id) !== undefined) cluesFound.add(cp.id);
                  }
                }
              } catch (err) {
                console.error('[TracksGamePage] clues found-set compute error:', err);
              }
              const cluesFrozenSec =
                finishedTeam.start_time && finishedTeam.end_time
                  ? finishedTeam.end_time - finishedTeam.start_time
                  : null;
              // One serial slot: a bip during this clues review waits its turn.
              await queue.enqueue(finishedTeam.team_name ?? null, async () => {
                setFocusRoute(cluesRoute);
                setFocusTeamName(finishedTeam.team_name ?? '');
                setFocusLanguage(finishedTeam.language ?? '');
                setCluesFoundIds(cluesFound);
                setCluesWrongIds(cluesWrong);
                setFocusScoreText(scoreText(finishedTeam.score ?? 0));
                setFocusFrozenSec(cluesFrozenSec);
                setScreen('clues');
                // The page closes itself after the launch-configured duration,
                // counting down on screen (no Enter wait, whatever autoReset is).
                for (let left = cluesDurationSec; left > 0; left--) {
                  setCluesCountdown(left);
                  // eslint-disable-next-line no-await-in-loop
                  await new Promise((r) => setTimeout(r, 1000));
                }
                resetDisplay();
              });
              return;
            }
          }
        }
        const teamName = team.team_name ?? '';

        // Resolve this team's route: per-team override (manual Add Team) else the
        // launch default. Drives both the markers shown and the scored subset.
        // The same meta read also carries the second-bip scoring baseline.
        let teamRoute = route;
        let metaForBip: Record<string, string> = {};
        try {
          metaForBip = await getLaunchedGameMeta(launchedGameId);
          teamRoute = metaForBip[`route:${team.id}`] || route;
        } catch (err) {
          console.error('[TracksGamePage] route resolve error:', err);
        }

        // The run start reads the card's own timestamps when it is recovered
        // rather than started (see the dirty-card gate below); `null` until one
        // of the two paths sets it.
        let runStartSec: number | null = team.start_time ?? null;
        // Set only on the recovery path: the run ended at the card's LAST punch,
        // not when it reached the desk (which could be an hour later, and would
        // otherwise be charged as time-limit malus).
        let recoveredEndSec: number | null = null;

        // --- Not-empty card at the start reader ------------------------------
        // The card still carries punches, so we cannot tell a forgotten wipe
        // from a team that ran the whole course without punching their start.
        // Refuse to start on this bip and let the NEXT bip of the same card
        // decide: wiped → normal start; still full → recover the run recorded
        // on it. Retours #90 (the wipe prompt was bypassable by simply bipping
        // twice) + #91 (that second bip used to throw the whole course away).
        // ...EXCEPT on the card-reuse path: there the punches on the card are
        // provably the previous run's (that run was already scored and closed),
        // so they get baselined away at the start as before - re-scoring them
        // would post the same course twice.
        if (!team.start_time && !reusedAfterFinish) {
          const onCard = timedPunches(card);
          if (onCard.length > 0 && !dirtyCardHoldRef.current.has(card.id)) {
            dirtyCardHoldRef.current.add(card.id);
            // Deliberately NOT the authored `text_team_starts_card_not_empty`:
            // that string starts with "C'est parti !" (it is the START message
            // for a dirty card, which is still what it says on the reuse path),
            // and the run has precisely NOT started here. The hold text is a
            // bucket-2 string, editable in the studio Translations admin.
            const holdLang = team.language || language;
            showMessage(
              tIngame('ingame_tracks', 'card_not_empty_hold', holdLang),
              'warning',
              teamName,
            );
            return;
          }
          if (onCard.length > 0) {
            // Second bip, card still not empty → recover. Backdate the run to
            // the card's own first/last punch and fall through to the scoring
            // path below, which reads `runStartSec` / `recoveredEndSec`.
            dirtyCardHoldRef.current.delete(card.id);
            const times = onCard.map((p) => secondsOfDay(p.time));
            runStartSec = epochForSecondsOfDay(Math.min(...times));
            recoveredEndSec = epochForSecondsOfDay(Math.max(...times));
            await updateTeam(team.id, { start_time: runStartSec });
            showMessage(
              tIngame('ingame_tracks', 'card_recovered', team.language || language),
              'info',
              teamName,
            );
          } else {
            // Card is clean - drop any hold from a previous bip and start.
            dirtyCardHoldRef.current.delete(card.id);
          }
        }

        // First bip → (self-register name) → (videos) → start the team's clock.
        if (runStartSec == null) {
          // This team's start is already on its way (name prompt or videos
          // queued/showing): a repeat bip must not open a second one - it only
          // brings the team's own name prompt back on screen.
          if (!pendingStarts.claim(team.id)) {
            if (!pendingStarts.raiseSelfReg(team.id)) {
              console.log('[TracksGamePage] start already pending for team', team.id, '- bip ignored');
            }
            return;
          }
          const startTeamId = team.id;
          // The start sequence, parameterised by the effective team name: persist
          // a self-registered rename, then gate the clock on any first-bip videos.
          const proceedAfterName = async (effectiveName: string, teamLanguage?: string) => {
            // Effective display language: the player's overlay pick, else launch,
            // else 'fr' (the readLocalized fallback convention).
            const effLang = teamLanguage || config.language || 'fr';
            if ((effectiveName && effectiveName !== teamName) || teamLanguage) {
              try {
                await updateTeam(team.id, {
                  ...(effectiveName && effectiveName !== teamName ? { team_name: effectiveName } : {}),
                  ...(teamLanguage ? { language: teamLanguage } : {}),
                });
              } catch (err) {
                console.error('[TracksGamePage] error saving self-registered name/language:', err);
              }
            }

            const finalizeStart = async () => {
              try {
                await finalizeStartInner();
              } finally {
                pendingStarts.release(startTeamId);
              }
            };
            const finalizeStartInner = async () => {
              const startSec = Math.floor(gameClock.now() / 1000);
              await updateTeam(team.id, { start_time: startSec });
              // The dirty-card gate above means the card is empty here on the
              // normal path; the only way to reach this with punches on it is
              // reuse-after-cooldown, where they belong to the run already
              // scored. Baseline them (matched on code+time, so a station
              // legitimately re-punched during the new run still counts) so they
              // are not credited twice. Persisted to meta - tracks runs are long
              // and outlive a reload.
              let staleCount = 0;
              try {
                const stale = timedPunches(card);
                staleCount = stale.length;
                if (stale.length > 0) {
                  await mergeLaunchedGameMeta(launchedGameId, {
                    [`baseline:${team.id}`]: JSON.stringify(stale.map((p) => `${p.code}@${p.time}`)),
                  });
                  console.warn(
                    `[TracksGamePage] card ${card.id} not empty at start: ${stale.length} pre-existing punch(es) will be ignored`,
                  );
                } else {
                  await removeLaunchedGameMetaKeys(launchedGameId, [`baseline:${team.id}`]);
                }
              } catch (err) {
                console.error('[TracksGamePage] baseline snapshot error:', err);
              }
              // First bip → confirm the start (like mystery's "C'est parti !").
              // The resting background stays up; this transient message is the
              // only first-bip feedback the operator/team gets.
              // Authored text_* overrides (blank → built-in message).
              const cardNotEmptyMsg = resolveTracksText(
                gd.texts,
                'text_team_starts_card_not_empty',
                effLang,
                { team: effectiveName, count: staleCount },
              );
              const warn =
                staleCount > 0
                  ? ` - ${cardNotEmptyMsg || tIngame('ingame_tracks', 'card_not_empty_warn', effLang)}`
                  : '';
              const startMsg =
                resolveTracksText(gd.texts, 'text_player_starts', effLang, { team: effectiveName }) ||
                tIngame('ingame_tracks', 'player_starts', effLang, { team: effectiveName });
              showMessage(`${startMsg}${warn}`, staleCount > 0 ? 'warning' : 'success', effectiveName);
              setScreen('background');
              setBigReveal(null);
              setPlacedCheckpoints(new Map());
            };

            // Gate the start on the first-bip video overlay when enabled.
            const wantsVideos = !!(config.playTutorialOnBip || config.playIntroOnBip);
            if (wantsVideos) {
              // A resolve failure starts the team without videos rather than
              // leaving its start stuck.
              try {
                const rawForResolve = await scenarioStore.getGameData(gameUniqid);
                const videos = await resolveFirstBipVideos(
                  { ...config, language: effLang },
                  gameUniqid,
                  'tracks',
                  rawForResolve
                );
                if (videos.length > 0) {
                  pendingStarts.enqueueVideoStart({ teamId: startTeamId, videos, finalize: finalizeStart });
                  return;
                }
              } catch (err) {
                console.error('[TracksGamePage] error resolving first-bip videos:', err);
              }
            }

            await finalizeStart();
          };

          // Self-register: prompt for the name first (before videos). On submit we
          // proceed with the entered name; on abort we cancel the start and delete
          // the team if this bip created it.
          if (config.selfRegisterTeam) {
            pendingStarts.enqueueSelfReg({
              teamId: startTeamId,
              cardId: card.id,
              finalize: (name: string, language: string) => proceedAfterName(name, language),
              abort: async () => {
                pendingStarts.dropSelfReg(startTeamId);
                pendingStarts.release(startTeamId);
                if (createdNow) {
                  try {
                    await deleteTeam(team.id);
                  } catch (err) {
                    console.error('[TracksGamePage] error deleting team on self-register abort:', err);
                  }
                }
              },
            });
            return;
          }

          await proceedAfterName(teamName);
          return;
        }

        // Second bip → score the run from the card's punch codes. On the
        // recovery path the run closed at its last punch, not at this bip.
        const endTime = recoveredEndSec ?? Math.floor(gameClock.now() / 1000);
        const allCps = gd.checkpoints;
        const routeCps = checkpointsForRoute(allCps, teamRoute);
        const stations = await patternStore.getTracksCheckpointStations(config.pattern);

        // Drop punches that were already on the card at the first bip (matched on
        // code+time, so a station legitimately re-punched during the run - new
        // time - still counts). Keeps a forgotten-to-wipe or reused card from
        // re-scoring its leftover punches. Reuses the route-resolution meta read.
        let baseline = new Set<string>();
        try {
          const raw = metaForBip[`baseline:${team.id}`];
          if (raw) baseline = new Set<string>(JSON.parse(raw) as string[]);
        } catch (err) {
          console.error('[TracksGamePage] baseline read error:', err);
        }
        const livePunches = (card.punches ?? []).filter(
          (p) => !baseline.has(`${p.code}@${p.time}`),
        );

        // Empty card on the closing bip (no new punches since start): say so
        // and stop - no scoring, no reveal, the run stays open. With a mass
        // start every team already has a start_time, so an unused card bipped
        // at the desk landed here and played the full score animation
        // (retours sept. #63). Same rule as Mystery #60: an empty card never
        // finishes a run.
        if (livePunches.length === 0) {
          const emptyLang = team.language || language;
          showMessage(
            resolveTracksText(gd.texts, 'text_card_empty', emptyLang, { team: teamName }) ||
              localizedStatus('card_empty', emptyLang),
            'warning',
            teamName,
          );
          return;
        }

        const numberOf = (cp: TracksCheckpoint) => allCps.findIndex((c) => c.id === cp.id) + 1;
        // Card slot of the first live punch at each route checkpoint (undefined =
        // never reached). Slot order, not station time: see firstSlotByCheckpoint.
        let unboundCheckpoints = 0;
        for (const cp of routeCps) {
          if ((stations.get(numberOf(cp)) ?? []).length === 0) {
            unboundCheckpoints++;
            console.warn(
              `[TracksGamePage] checkpoint #${numberOf(cp)} resolves to NO pattern station - it can never be scored as hit. Check that the pattern has one row per checkpoint.`,
            );
          }
        }
        const hitSlotByCp = firstSlotByCheckpoint(routeCps, numberOf, stations, livePunches);

        // Punch-vs-course diagnostic. A run that scores nothing looks exactly
        // like "the software reports punch errors" (retours #87/#89), so make
        // the two causes distinguishable: a wrong/absent pattern binding leaves
        // EVERY checkpoint unreached while the card is full of punches.
        const matchedAnyStation = routeCps.some((cp) => hitSlotByCp.get(cp.id) !== undefined);
        console.info(
          '[TracksGamePage] scoring',
          {
            card: card.id,
            pattern: config.pattern,
            playMode: trackPlayMode,
            route: teamRoute,
            checkpoints: routeCps.length,
            unboundCheckpoints,
            punchCodes: livePunches.map((p) => `${p.code}@${p.time}`),
            expectedStations: routeCps.map((cp) => `#${numberOf(cp)}→${(stations.get(numberOf(cp)) ?? []).join('/') || '—'}`),
            // Card slot each route checkpoint was first reached at (the order
            // itinerary scoring judges); '—' = never reached.
            slotOrder: routeCps.map((cp) => `#${numberOf(cp)}@${hitSlotByCp.get(cp.id) ?? '—'}`),
          },
        );
        if (livePunches.length > 0 && !matchedAnyStation) {
          showMessage(
            tIngame('ingame_tracks', 'no_station_match', team.language || language),
            'error',
            teamName,
          );
        }

        // Itinerary = walk the route in card-slot order (see orderedHitCheckpointIds); free = any reached checkpoint.
        let hitIds: Set<string>;
        if (trackPlayMode === 'itinerary') {
          hitIds = orderedHitCheckpointIds(routeCps, hitSlotByCp).hitIds;
        } else {
          hitIds = new Set<string>();
          for (const cp of routeCps) {
            if (hitSlotByCp.get(cp.id) !== undefined) hitIds.add(cp.id);
          }
        }

        const elapsedMin = Math.max(0, endTime - runStartSec) / 60;
        const finalScore = computeScore({
          routeCheckpoints: routeCps,
          hitCheckpointIds: hitIds,
          scoreType,
          elapsedMinutes: elapsedMin,
          timeLimitMinutes: timeLimitMin,
          malusPerMinute,
        });

        await updateTeam(team.id, { end_time: endTime, score: finalScore });
        // Run scored - drop the start-time baseline so a later reuse starts clean.
        try {
          await removeLaunchedGameMetaKeys(launchedGameId, [`baseline:${team.id}`]);
        } catch (err) {
          console.error('[TracksGamePage] baseline clear error:', err);
        }

        // --- Reveal -----------------------------------------------------------
        // The map is the reveal surface; per-checkpoint status images accumulate
        // on it. Free → correct/missing; itinerary → correct/wrong/missing.
        // Wrapped as ONE serial presentation slot so a second team bipping during
        // this reveal waits its turn (shown in the bottom line) instead of racing
        // this one's setScreen / focus state. Scoring above already committed.
        // Captured before the slot closure - TS loses the `runStartSec`
        // narrowing across the nested async fn.
        const frozenSec = Math.max(0, endTime - runStartSec);
        await queue.enqueue(teamName, async () => {
        setFocusTeamName(teamName);
        setFocusLanguage(team.language ?? '');
        setFocusRoute(teamRoute);
        setFocusFrozenSec(frozenSec); // frozen run duration
        setFocusHitCount(hitIds.size);
        setBigReveal(null);
        setPlacedCheckpoints(new Map());
        setScreen('reveal');

        const statusOf = (cp: TracksCheckpoint): 'correct' | 'wrong' | 'missing' => {
          if (hitIds.has(cp.id)) return 'correct';
          if (hitSlotByCp.get(cp.id) !== undefined) return 'wrong'; // punched, not credited
          return 'missing';
        };
        const correctImage = (cp: TracksCheckpoint) =>
          gd.checkpoints_unique_image
            ? getImageUrl(gd.images.checkpoints_unique_image_id)
            : getImageUrl(gd.checkpointImages[cp.id]);
        const statusImage = (cp: TracksCheckpoint, status: 'correct' | 'wrong' | 'missing') =>
          status === 'correct'
            ? correctImage(cp)
            : status === 'wrong'
              ? getImageUrl(gd.images.wrong_order_image)
              : getImageUrl(gd.images.missing_checkpoint_image);
        const statusSound = (status: 'correct' | 'wrong' | 'missing') =>
          status === 'correct'
            ? 'checkpoint_success'
            : status === 'wrong'
              ? 'checkpoint_error'
              : 'checkpoint_no_answer';

        if (displayMode === 'simple') {
          // No per-checkpoint walk - settle straight onto the summary HUD, then
          // hold it long enough to read before top-X / reset (otherwise it would
          // flash past instantly).
          setFocusScoreText(scoreText(finalScore));
          playSound(hitIds.size > 0 ? 'checkpoint_success' : 'checkpoint_no_answer');
          await new Promise((r) => setTimeout(r, Math.max(1, config.messageDisplayDuration) * 1000));
        } else {
          // full + map: walk every route checkpoint in order, accumulating its
          // status image on the map; correct checkpoints count the score up.
          const denom = routeCps.length || 1;
          const rawIncrement = (cp: TracksCheckpoint) =>
            scoreType === 'percentage' ? 100 / denom : typeof cp.points === 'number' ? cp.points : 1;
          let runningRaw = 0;
          // Currently DISPLAYED integer score, used to animate one unit at a
          // time. Kept separate from `runningRaw` (which can be fractional in
          // percentage mode, e.g. 100/24).
          let displayedScore = 0;
          const SCORE_TICK_MS = 50;
          const animateScoreTo = async (target: number) => {
            const end = Math.max(0, Math.round(target));
            const dir = end >= displayedScore ? 1 : -1;
            while (displayedScore !== end) {
              displayedScore += dir;
              setFocusScoreText(scoreType === 'percentage' ? `${displayedScore}%` : `${displayedScore} pts`);
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, SCORE_TICK_MS));
            }
          };
          const placed = new Map<string, string>();
          setFocusScoreText(scoreType === 'percentage' ? '0%' : '0 pts');
          for (const cp of routeCps) {
            const status = statusOf(cp);
            const url = statusImage(cp, status);
            const bump = async () => {
              if (status !== 'correct') return;
              runningRaw =
                scoreType === 'percentage'
                  ? Math.min(100, runningRaw + rawIncrement(cp))
                  : runningRaw + rawIncrement(cp);
              await animateScoreTo(runningRaw);
            };
            if (displayMode === 'full') {
              // Phase A - big centered status image (name/description only for correct).
              setBigReveal({
                imageUrl: url,
                title: status === 'correct' ? readLocalized(cp.title as Record<string, string> | string | undefined, language) : '',
                description:
                  status === 'correct' ? readLocalized(cp.description as Record<string, string> | string | undefined, language) : '',
              });
              playSound(statusSound(status));
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, Math.max(1, config.messageDisplayDuration) * 1000));
              // Phase B - the image lands on the map; score increments AS the
              // checkpoint is revealed (marker lands), not at Phase-A start.
              setBigReveal(null);
              placed.set(cp.id, url);
              setPlacedCheckpoints(new Map(placed));
              await bump();
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, 500));
            } else {
              // map mode - Phase B only: place each status image sequentially.
              placed.set(cp.id, url);
              setPlacedCheckpoints(new Map(placed));
              playSound(statusSound(status));
              await bump();
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, REVEAL_STEP_MS));
            }
          }
          // Apply the time malus as a visible one-by-one drop to the final score.
          await animateScoreTo(finalScore);
        }

        // --- Top-X reveal: rank the team among all teams ----------------------
        const refreshed = await getLaunchedGameState(launchedGameId, 0);
        const ranked = sortTracksTeams(refreshed.teams.filter((t) => t.end_time));
        const rank = ranked.findIndex((t) => t.id === team.id) + 1;
        const tier = rank > 0 ? rankTier(rank) : null;
        // Only with an uploaded reward image: without one the top-X screen was
        // a bare black page (score text in the scenario colour, often dark).
        const tierUrl = tier ? getImageUrl(gd.images[`${tier}_image`]) : '';
        if (tier && tierUrl) {
          setTopRevealUrl(tierUrl);
          setGameMessage(''); // clear any lingering warning before the celebration
          setScreen('topreveal');
          playSound(`${tier}_sound`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 4000));
          // Back to the revealed map for the closing hold, not the reward page.
          setTopRevealUrl('');
          setScreen('reveal');
        }

        // --- Closing message: scenario ended --------------------------------
        // Already inside the reveal slot, so drive the overlay directly: routing
        // through showMessage would enqueue a nested slot and deadlock the queue.
        // No "équipe terminée" here - that text is for a finished team bipping
        // AGAIN without the clues page (see the finished-card branch above).
        const endLang = team.language || language;
        // "Scenario ended" only when the roster is closed and complete. With
        // auto/self-register or card reuse, teams join and leave one at a time,
        // so "every registered team has finished" is true after nearly every
        // return and the end-of-game message followed each team's results
        // (retours sept. #62). Those sessions only end on the operator's "End
        // game" (retours #88).
        const rosterClosed =
          !config.autoRegisterTeam && !config.selfRegisterTeam && !config.reuseCards;
        const allFinished =
          rosterClosed &&
          refreshed.teams.length >= Math.max(1, config.numberOfTeams || 1) &&
          refreshed.teams.every((t) => t.end_time);
        if (allFinished) {
          const scenarioEndedMsg = resolveTracksText(gd.texts, 'text_scenario_ended', endLang);
          if (scenarioEndedMsg) {
            setGameMessageType('info');
            setGameMessage(scenarioEndedMsg);
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, Math.max(1, config.messageDisplayDuration) * 1000));
            setGameMessage('');
          }
        }

        // --- Reset back to the map -------------------------------------------
        setAwaitingReset(true);
        if (gd.autoReset) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, AUTO_RESET_SECONDS * 1000));
          resetDisplay();
        } else {
          await waitForEnter();
          resetDisplay();
        }
        });
      } catch (err) {
        console.error('[TracksGamePage] punch logic error:', err);
        const errMsg = dataRef.current
          ? resolveTracksText(dataRef.current.texts, 'text_if_error', language)
          : '';
        if (errMsg) showMessage(errMsg, 'error');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [launchedGameId, route, scoreType, trackPlayMode, timeLimitMin, malusPerMinute, displayMode, config.pattern, config.messageDisplayDuration, config.autoRegisterTeam, config.selfRegisterTeam, config.reuseCards, config.reuseDelayMinutes, config.numberOfTeams, config.playTutorialOnBip, config.playIntroOnBip, config.cluesPage, gameUniqid, playSound, scoreText, showMessage, language],
  );

  const resetDisplay = () => {
    // Back to the resting background screen until the next team interacts.
    setAwaitingReset(false);
    setScreen('background');
    setPlacedCheckpoints(new Map());
    setBigReveal(null);
    setCluesFoundIds(new Set());
    setCluesWrongIds(new Set());
    setCluesCountdown(null);
    setTopRevealUrl('');
    setGameMessage('');
    setFocusFrozenSec(null);
    setFocusScoreText('');
    setFocusHitCount(0);
    setFocusRoute(route);
    setFocusLanguage('');
  };

  const waitForEnter = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        window.removeEventListener('keydown', onKey);
        if (enterResolverRef.current === done) enterResolverRef.current = null;
        resolve();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') done();
      };
      enterResolverRef.current = done;
      window.addEventListener('keydown', onKey);
    });

  // The operator's remote "reset display": as Enter on a result waiting for it;
  // with auto-reset on, clear it now rather than after the delay (the delay's
  // own reset then finds the resting screen already up).
  const resetDisplayRef = useRef(resetDisplay);
  resetDisplayRef.current = resetDisplay;
  const awaitingResetRef = useRef(awaitingReset);
  awaitingResetRef.current = awaitingReset;
  useEffect(() => {
    if (!launchedGameId) return;
    return onPendingResetDisplay((gid) => {
      if (gid !== launchedGameId) return false;
      const resolveEnter = enterResolverRef.current;
      if (resolveEnter) {
        resolveEnter();
        return true;
      }
      if (!awaitingResetRef.current) return false;
      resetDisplayRef.current();
      return true;
    });
  }, [launchedGameId]);

  // Tell the Devices modals what this screen shows: the resting background,
  // or a team's result waiting to be reset.
  useEffect(() => {
    if (!launchedGameId) return;
    refineInGame(launchedGameId, {
      boardHidden: screen === 'background',
      sub: awaitingReset ? 'results' : undefined,
    });
  }, [launchedGameId, screen, awaitingReset]);
  useEffect(() => {
    if (!launchedGameId) return;
    return () => clearInGameRefinement(launchedGameId);
  }, [launchedGameId]);

  const saveCardData = useCallback(
    async (card: CardData) => {
      if (!launchedGameId) return;
      try {
        // Remember the row id we just created so the poll's echo of it is
        // skipped in handleNewBip (own-reader de-dupe).
        const { id } = await recordPunch(launchedGameId, JSON.parse(JSON.stringify(card)));
        if (typeof id === 'number') processedRawIdsRef.current.add(id);
        await handleCardPunchLogic(card);
      } catch (err) {
        console.error('[TracksGamePage] saveCardData error:', err);
      }
    },
    [launchedGameId, handleCardPunchLogic],
  );
  // Always dispatch to the LATEST saveCardData without re-binding the reader.
  // Binding the effect to `saveCardData` (which changes whenever the punch logic
  // does) tore the USB reader down + re-initialized it repeatedly, dropping
  // punches. Mirror MysteryGamePage: bind once per game, call through a ref.
  const saveCardDataRef = useRef(saveCardData);
  useEffect(() => {
    saveCardDataRef.current = saveCardData;
  }, [saveCardData]);

  // Reader binding - bind once per launched game (mirrors MysteryGamePage).
  useEffect(() => {
    let cancelled = false;
    const initUSB = async () => {
      if (!siReader.isAvailable()) return;
      // Bound before reader detection so the game simulator's injected reads
      // (no physical reader) reach the page too; harmless without events.
      siReader.setCardDetectedCallback((card: CardData) => {
        void saveCardDataRef.current(card);
        setLastCardData(card);
        setShowCardAlert(true);
        setTimeout(() => setShowCardAlert(false), 5000);
      });
      const detected = await detectReaderPort();
      if (cancelled || !detected) return;
      try {
        const ok = await siReader.initializePort(detected.path);
        if (!ok) return;
        siReader.setCardRemovedCallback(() => setShowCardAlert(false));
        siReader.setStationsDetectedCallback((_s: StationData[]) => {});
        await siReader.start();
      } catch (err) {
        console.error('[TracksGamePage] USB init error:', err);
      }
    };
    const onReaderStatus = () => void initUSB();
    void initUSB();
    window.addEventListener('reader:status', onReaderStatus);
    return () => {
      siReader.setCardDetectedCallback(undefined);
      cancelled = true;
      window.removeEventListener('reader:status', onReaderStatus);
      if (siReader.isAvailable()) siReader.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchedGameId]);

  const handleNewBip = useCallback(
    (row: { id?: number; raw_data: unknown }) => {
      // Own punches are processed live in saveCardData (the USB-reader callback),
      // which records the row id here; the poll echoes them back ~1s later - skip
      // our own echo.
      if (row.id != null && processedRawIdsRef.current.has(row.id)) return;
      // Anything else is a punch read on ANOTHER device, reaching us through the
      // shared state poll. Each station animates only the cards it physically
      // read, so we must NOT replay a remote bip here - doing so was animating a
      // single bip on every device in the game.
    },
    [],
  );

  useGameStatePolling({
    launchedGameId,
    numberOfTeams: config.numberOfTeams,
    onGameEnded: () => onGameEnd?.(),
    onAllTeamsFinished: () => onGameEnd?.(),
    onNewBip: handleNewBip,
    // Tracks NEVER auto-ends on "all teams finished". A track session is a
    // rolling one: teams leave and come back one at a time over hours, cards
    // get reused, and new teams register mid-session. Ending the game the
    // moment the first (or last-so-far) team returned swapped the play screen
    // for the final ranking board while the session was still running -
    // retours #88. The operator's "End game" is the only end.
    disableAllFinishedEnd: true,
  });

  if (!data) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading game...</div>
      </div>
    );
  }

  const fontFamily = resolveFontFamily(data.font) || undefined;
  const routeCheckpoints = checkpointsForRoute(data.checkpoints, focusRoute);

  // HUD chrome in the focused team's language (idle → the launch language).
  // These were hard-coded English ("Time" / "Score" / "N checkpoints") on every
  // Track screen - retours #99.
  const hudLangCode = focusLanguage || language;
  const hudLang = {
    time: tIngame('ingame_tracks', 'hud_time', hudLangCode),
    score: tIngame('ingame_tracks', 'hud_score', hudLangCode),
    summary: tIngame('ingame_tracks', 'summary_checkpoints', hudLangCode, {
      hit: focusHitCount,
      total: routeCheckpoints.length,
    }),
  };

  // Focused team's clock: the frozen final run duration during the reveal,
  // blank otherwise (no HUD over the background during the run).
  const timerDisplay = focusFrozenSec != null ? formatTime(focusFrozenSec) : '';

  const resolveCheckpointImage = (cp: TracksCheckpoint) => {
    if (data.checkpoints_unique_image) return getImageUrl(data.images.checkpoints_unique_image_id);
    return getImageUrl(data.checkpointImages[cp.id]);
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      {selfReg && (
        <SelfRegisterOverlay
          key={selfReg.teamId}
          cardId={selfReg.cardId}
          language={language}
          scenarioLanguages={config.scenarioLanguages ?? []}
          scenarioAudience={config.namePoolAudience ?? 'kids'}
          allowLanguageChoice={!!config.allowPlayerLanguageChoice}
          addRandomName={!!config.addRandomNameOption}
          onSubmit={(name, lang) => {
            pendingStarts.dropSelfReg(selfReg.teamId);
            void selfReg.finalize(name, lang);
          }}
          onAbort={() => {
            void selfReg.abort();
          }}
        />
      )}
      {videoStart && (
        <FirstBipVideoOverlay
          key={videoStart.teamId}
          videos={videoStart.videos}
          onComplete={pendingStarts.completeVideoStart}
        />
      )}
      {/* Dev-only punch/hardware debug indicator - removed from production builds. */}
      {import.meta.env.DEV && (
        <CardDetectionAlert cardData={lastCardData} show={showCardAlert} />
      )}

      <GameMessageOverlay
        message={gameMessage || null}
        type={gameMessageType}
        fontFamily={fontFamily}
      />

      <PendingTeamsBar labels={queue.pending} lang={config.language ?? ''} fontFamily={fontFamily} />

      {/* No top nav on the in-game (kiosk) display. Exit is via Esc (operator
          keyboard) - see the keydown handler. The reader-not-connected banner is
          kept as a thin diagnostic strip since it explains missing punches. */}
      {siReader.isAvailable() && !detectedReader.isPresent && (
        <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-3 px-4 py-2 bg-orange-600 border-b-2 border-orange-300 shadow-lg">
          <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="font-sans normal-case tracking-normal text-white font-semibold text-sm">
            {tr('readerNotConnected')}
          </span>
        </div>
      )}

      <TracksGameRenderer
        screen={screen}
        displayMode={displayMode}
        backgroundUrl={getImageUrl(data.images.background_image)}
        mapUrl={getImageUrl(data.images.map_image)}
        routeCheckpoints={routeCheckpoints}
        placedCheckpoints={placedCheckpoints}
        bigReveal={bigReveal}
        resolveCheckpointImage={resolveCheckpointImage}
        foundCheckpointIds={cluesFoundIds}
        wrongCheckpointIds={cluesWrongIds}
        wrongOrderUrl={getImageUrl(data.images.wrong_order_image)}
        missingCheckpointUrl={getImageUrl(data.images.missing_checkpoint_image)}
        iconSizePercent={data.iconSizePercent}
        hud={{
          teamNameFrame: getImageUrl(data.images.team_name_background_image),
          timerFrame: getImageUrl(data.images.timer_background_image),
          scoreFrame: getImageUrl(data.images.score_background_image),
        }}
        teamName={focusTeamName || config.name}
        timerText={timerDisplay}
        scoreText={focusScoreText || (scoreType === 'percentage' ? '0%' : '0 pts')}
        showScore={data.showScore}
        legend={
          // Per-launch choice (launch modal > Advanced); a game launched before
          // the toggle existed keeps the scenario's own setting.
          (config.tracksShowLegend ?? data.legendDefaultOn)
            ? {
                box: data.legendBox,
                // Wrong order only exists in itinerary mode (free mode credits
                // every punched checkpoint), so free mode drops that row.
                wrongOrder:
                  trackPlayMode === 'itinerary' && data.images.wrong_order_image
                    ? {
                        imageUrl: getImageUrl(data.images.wrong_order_image),
                        label: resolveLegendLabel(data.legendTexts.wrongOrder, 'legend_wrong_order', hudLangCode),
                      }
                    : null,
                missing: data.images.missing_checkpoint_image
                  ? {
                      imageUrl: getImageUrl(data.images.missing_checkpoint_image),
                      label: resolveLegendLabel(data.legendTexts.missing, 'legend_missing_checkpoint', hudLangCode),
                    }
                  : null,
              }
            : null
        }
        timeLabel={hudLang.time}
        scoreLabel={hudLang.score}
        checkpointsSummary={hudLang.summary}
        language={focusLanguage || language}
        clues={clues}
        cluesCountdownSec={cluesCountdown}
        topRevealUrl={topRevealUrl}
        fontFamily={fontFamily}
        fontColor={data.font_color}
        textElements={data.textElements}
        textCategories={data.textCategories}
        scenarioFontName={data.font}
        scenarioFontColor={data.font_color}
        hudLayout={data.hudLayout}
      />
    </div>
  );
}
