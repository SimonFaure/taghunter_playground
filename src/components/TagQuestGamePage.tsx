import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Play, Users, Trophy } from 'lucide-react';
import { GameConfig } from './LaunchGameModal';
import { sportidentService as usbReaderService, CardData, StationData, detectReaderPort } from '../services/sportidentService';
import { useDetectedReaderPort } from '../services/useDetectedReaderPort';
import { CardDetectionAlert } from './CardDetectionAlert';
import { GameMessageOverlay } from './GameMessageOverlay';
import { describePunchStatus, type GameMessageType } from '../services/gameMessages';
import { PunchAnimationOverlay } from './PunchAnimationOverlay';
import * as scenarioStore from '../services/scenarioStore';
import * as layoutStore from '../services/layoutStore';
import * as translationsStore from '../services/translationsStore';
import {
  resolveAdminLabelRuntime,
  type AdminLabelKey,
  type AdminTranslationsValue,
} from '../scenarios/tagquest/defaultPreviewLabels';
import { scenarioAssetUrl } from '../services/contentFs';
import { resolveFontFamily } from '../fonts/resolveFontFamily';
import { registerScenarioFonts } from '../fonts/registerScenarioFonts';
// Bundled fallback (hand-mirror of studio's defaultTagquestLayout.ts). The
// playground uses this when its SQLite cache is empty, OR when the bundled
// version is newer than what was synced (transition window after a studio
// migration). Keep this file in lockstep with the canonical TS source.
import bundledTagquestLayout from '../scenarios/tagquest/defaultLayout.json';
import {
  getLaunchedGameState,
  getLaunchedGameMeta,
  recordPunch,
  updateTeam,
  startLaunchedGame,
} from '../services/launchedGames';
import { useGameStatePolling } from '../hooks/useGameStatePolling';
import { processTagQuestPunch } from '../services/tagquestPunchLogic';
import type { PunchAnimationData } from '../services/tagquestPunchLogic';
import { logApiCall } from '../services/apiLogger';

type AnimPhase = 'idle' | 'enter' | 'images' | 'main' | 'update' | 'exit';

const SLOT_STAGGER_MS = 400;
const MAIN_IMAGE_HOLD_MS = 2500;
// Just long enough for the score count-up (~900ms) to settle before the hold.
const UPDATE_HOLD_MS = 1500;
const EXIT_MS = 600;
// Once the animation has finished we keep the final frame on screen for this
// long (the 'exit' phase), then reset everything to hidden. ~10s per spec.
const POST_ANIM_HOLD_MS = 10000;

interface TagQuestGamePageProps {
  config: GameConfig;
  gameUniqid: string;
  launchedGameId: number | null;
  onBack: () => void;
  onGameEnd?: () => void;
  postAnimExitDelayMs?: number;
}

interface GameQuest {
  name: string;
  points?: string;
  sound?: string;
  main_image?: string;
  image_1?: string;
  image_2?: string;
  image_3?: string;
  image_4?: string;
  [key: string]: string | undefined;
}

interface GameLevel {
  name: string | null;
  points: string | null;
  description?: string | null;
}

interface GameData {
  game: {
    id: string;
    uniqid: string;
    type: string;
    title: string;
  };
  quests?: GameQuest[];
  levels?: Record<string, GameLevel>;
  game_meta?: TagquestGameMetaRuntime;
  default_language?: string;
}

interface TagquestGameMetaRuntime {
  background_image?: string;
  malus_image?: string;
  late_malus_image?: string;
  custom_template?: string;
  use_default_template?: boolean;
  [k: string]: unknown;
}

const DEFAULT_TAGQUEST_TEMPLATE_URL = '/default_templates/tagquest_template.png';

interface TeamScore {
  id: number;
  team_name: string;
  score: number;
  start_time: number | null;
  end_time: number | null;
  key_id: number;
  currentLevel?: { level: number; name: string } | null;
}

type LayoutDim = number | 'auto' | 'fit-content' | 'min-content' | 'max-content';

interface LayoutElement {
  id: string;
  type: 'image' | 'text' | 'container' | 'quest';
  name?: string;
  x?: number;
  y?: number;
  width?: LayoutDim;
  height?: LayoutDim;
  src?: string;
  filename?: string;
  text?: string;
  previewText?: string;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  style?: Record<string, any>;
  children?: LayoutElement[];
}

interface GameLayout {
  version: string;
  elements: LayoutElement[];
  background?: string;
  width?: number;
  height?: number;
}

export function TagQuestGamePage({ config, gameUniqid, launchedGameId, onBack, onGameEnd, postAnimExitDelayMs: postAnimExitDelayMsProp = 0 }: TagQuestGamePageProps) {
  // The final frame stays on screen this long after the animation ends before
  // the page resets to its all-hidden state. Configurable per launch via
  // visibilityHideDelaySec; the Test modal may override it via the prop.
  const configuredHoldMs = config.visibilityHideDelaySec != null
    ? Math.max(0, config.visibilityHideDelaySec) * 1000
    : POST_ANIM_HOLD_MS;
  const postAnimExitDelayMs = postAnimExitDelayMsProp > 0
    ? postAnimExitDelayMsProp
    : configuredHoldMs;
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [layout, setLayout] = useState<GameLayout | null>(null);
  const [layoutLoading, setLayoutLoading] = useState(true);
  const [adminTranslations, setAdminTranslations] = useState<AdminTranslationsValue | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const v = await translationsStore.getValue<AdminTranslationsValue>('tagquest_translations');
        if (active) setAdminTranslations(v);
      } catch {
        if (active) setAdminTranslations(null);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  const [gameStarted, setGameStarted] = useState(true);
  const [lastCardData, setLastCardData] = useState<CardData | null>(null);
  const [showCardAlert, setShowCardAlert] = useState(false);
  // Banner shown when the SportIdent reader isn't plugged in — the game
  // page autobinds via 'reader:status' once detection flips, so this is
  // purely informational. Hidden in non-Tauri contexts where the reader
  // service is unavailable entirely.
  const detectedReader = useDetectedReaderPort();
  const [teams, setTeams] = useState<TeamScore[]>([]);
  const [gameMessage, setGameMessage] = useState('');
  const [levelUpMessage, setLevelUpMessage] = useState('');
  const [gameMessageSeverity, setGameMessageSeverity] = useState<GameMessageType>('info');
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bgDimensions, setBgDimensions] = useState<{ width: number; height: number } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  // Seconds until the next late-malus tick, once the game clock has expired
  // (null while the game is still running).
  const [nextMalusInSec, setNextMalusInSec] = useState<number | null>(null);
  const [launchedGameInfo, setLaunchedGameInfo] = useState<{ start_time: string | null; duration: number | null } | null>(null);
  const [victoryType, setVictoryType] = useState<'speed' | 'score'>(config.victoryType || 'speed');
  const [playMode, setPlayMode] = useState<'solo' | 'team'>(config.playMode || 'solo');
  const [teamsConfig, setTeamsConfig] = useState<import('./LaunchGameModal').Team[]>(config.teams || []);
  const [punchAnimation, setPunchAnimation] = useState<PunchAnimationData | null>(null);
  const [gameOverTeamName, setGameOverTeamName] = useState<string | null>(null);

  const [animPhase, setAnimPhase] = useState<AnimPhase>('idle');
  const [animRevealedSlots, setAnimRevealedSlots] = useState(0);
  const [animShowUpdated, setAnimShowUpdated] = useState(false);
  const [animDisplayedScore, setAnimDisplayedScore] = useState(0);
  const [animDisplayedCombos, setAnimDisplayedCombos] = useState({ combos6: 0, combos4: 0, combos2: 0 });
  // Static combo points read from gameMeta — used between animations when
  // `punchAnimation?.comboPoints` is null. The same parsing as
  // `getComboPoints` in tagquestPunchLogic.
  const staticComboPoints = (() => {
    const m = gameData?.game_meta as Record<string, unknown> | undefined;
    const parse = (v: unknown): number => {
      if (v == null) return 0;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') return parseInt(v, 10) || 0;
      return 0;
    };
    return {
      pts6: parse(m?.combo_6_quests),
      pts4: parse(m?.combo_4_quests),
      pts2: parse(m?.combo_2_quests),
    };
  })();
  // Late-malus points per minute, from the scenario's game_meta (mirrors
  // getLateMalusPoints in tagquestPunchLogic). When > 0, a late malus accrues
  // each full minute past the game deadline.
  const lateMalusPoints = (() => {
    const m = gameData?.game_meta as Record<string, unknown> | undefined;
    const v = m?.late_malus_points ?? m?.default_time_malus ?? 0;
    return typeof v === 'string' ? parseFloat(v) || 0 : typeof v === 'number' ? v : 0;
  })();
  // Starts false (everything hidden at game start), flips to true while an
  // animation plays + during the post-animation hold, then back to false when
  // the page resets to idle.
  const [hudValuesVisible, setHudValuesVisible] = useState(false);
  const [animDisplayedMalus, setAnimDisplayedMalus] = useState(0);
  const [animDisplayedLateMalus, setAnimDisplayedLateMalus] = useState(0);
  const [lastKnownScore, setLastKnownScore] = useState(0);
  const [lastKnownQuestDetails, setLastKnownQuestDetails] = useState<PunchAnimationData['newQuestDetails']>([]);
  const [lastKnownCombos, setLastKnownCombos] = useState({ combos6: 0, combos4: 0, combos2: 0 });
  const [lastKnownMalus, setLastKnownMalus] = useState(0);
  const [lastKnownLateMalus, setLastKnownLateMalus] = useState(0);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Audio for the active quest's sound, played when its full image appears.
  const questAudioRef = useRef<HTMLAudioElement | null>(null);
  // Punch animations waiting to play. A punch arriving while one is already
  // playing — including during the post-animation hold — queues here and plays
  // when the current one resets to idle, so no punch is dropped.
  const pendingAnimationsRef = useRef<PunchAnimationData[]>([]);
  const animPhaseRef = useRef(animPhase);
  const punchAnimationRef = useRef<PunchAnimationData | null>(punchAnimation);
  useEffect(() => { animPhaseRef.current = animPhase; }, [animPhase]);
  useEffect(() => { punchAnimationRef.current = punchAnimation; }, [punchAnimation]);

  const bgImageRef = useRef<HTMLImageElement>(null);
  const gameDataRef = useRef<GameData | null>(null);

  // Anti-cheat: per-team set of punch identities ("code@time") already consumed
  // by a completed quest. Threaded into processTagQuestPunch so a re-read of the
  // same card (or a poll echo) can't re-score already-used punches, and a
  // score-mode quest only re-completes on genuinely new physical punches.
  // In-memory by design — it resets if the kiosk reloads mid-game (speed mode
  // is still protected by the persisted completed-quests rows; only score-mode
  // re-scoring is briefly re-exposed until the cards advance past stale marks).
  const consumedPunchesRef = useRef<Map<number, Set<string>>>(new Map());

  const animSet = (fn: () => void, ms: number) => {
    if (animTimerRef.current) clearTimeout(animTimerRef.current);
    animTimerRef.current = setTimeout(fn, ms);
  };

  const clearAnimInterval = () => {
    if (animIntervalRef.current) {
      clearInterval(animIntervalRef.current);
      animIntervalRef.current = null;
    }
  };

  useEffect(() => {
    if (animPhase === 'enter') {
      animSet(() => setAnimPhase('images'), 800);
    }
  }, [animPhase]);

  useEffect(() => {
    if (animPhase !== 'images') return;
    const slots = punchAnimation?.displayQuest?.slots ?? [];
    const isComplete = punchAnimation?.displayQuest?.complete ?? false;
    if (slots.length === 0) {
      setAnimPhase(isComplete ? 'main' : 'update');
      return;
    }
    if (animRevealedSlots < slots.length) {
      animSet(() => setAnimRevealedSlots(prev => prev + 1), SLOT_STAGGER_MS);
    } else {
      animSet(() => setAnimPhase(isComplete ? 'main' : 'update'), 600);
    }
  }, [animPhase, animRevealedSlots, punchAnimation]);

  useEffect(() => {
    if (animPhase !== 'main') return;
    // The full (complete) quest image is now appearing. Play that quest's
    // sound to coincide with it. 'main' is only ever reached for a completed
    // quest, so the sound never fires on a partial punch.
    const idx = punchAnimation?.displayQuest?.index != null
      ? punchAnimation.displayQuest.index - 1
      : -1;
    const soundKey = idx >= 0 ? gameData?.quests?.[idx]?.sound : undefined;
    if (soundKey) {
      try {
        questAudioRef.current?.pause();
        const audio = new Audio(scenarioAssetUrl(gameUniqid, soundKey.replace(/^media\//, '')));
        questAudioRef.current = audio;
        void audio.play().catch((e) => console.error('[TagQuest] quest sound play error:', e));
      } catch (e) {
        console.error('[TagQuest] quest sound load error:', e);
      }
    }
    animSet(() => setAnimPhase('update'), MAIN_IMAGE_HOLD_MS);
  }, [animPhase]);

  useEffect(() => {
    if (animPhase === 'update' && punchAnimation) {
      const fromScore = punchAnimation.prevScore;
      const toScore = punchAnimation.newScore;
      const fromCombos = punchAnimation.prevCombos;
      const toCombos = punchAnimation.newCombos;
      const fromMalus = punchAnimation.prevMalus ?? 0;
      const toMalus = punchAnimation.newMalus ?? 0;
      const fromLateMalus = punchAnimation.prevLateMalus ?? 0;
      const toLateMalus = punchAnimation.newLateMalus ?? 0;

      setAnimDisplayedScore(fromScore);
      setAnimDisplayedCombos(fromCombos);
      setAnimDisplayedMalus(fromMalus);
      setAnimDisplayedLateMalus(fromLateMalus);

      if (toScore !== fromScore || toMalus !== fromMalus || toLateMalus !== fromLateMalus) {
        const steps = 20;
        const stepMs = Math.floor(900 / steps);
        let step = 0;
        clearAnimInterval();
        animIntervalRef.current = setInterval(() => {
          step++;
          const progress = step / steps;
          const eased = 1 - Math.pow(1 - progress, 3);
          setAnimDisplayedScore(Math.round(fromScore + (toScore - fromScore) * eased));
          setAnimDisplayedCombos({
            combos6: Math.round(fromCombos.combos6 + (toCombos.combos6 - fromCombos.combos6) * eased),
            combos4: Math.round(fromCombos.combos4 + (toCombos.combos4 - fromCombos.combos4) * eased),
            combos2: Math.round(fromCombos.combos2 + (toCombos.combos2 - fromCombos.combos2) * eased),
          });
          setAnimDisplayedMalus(Math.round(fromMalus + (toMalus - fromMalus) * eased));
          setAnimDisplayedLateMalus(Math.round(fromLateMalus + (toLateMalus - fromLateMalus) * eased));
          if (step >= steps) {
            clearAnimInterval();
            setAnimDisplayedScore(toScore);
            setAnimDisplayedCombos(toCombos);
            setAnimDisplayedMalus(toMalus);
            setAnimDisplayedLateMalus(toLateMalus);
            setAnimShowUpdated(true);
          }
        }, stepMs);
      } else {
        setAnimDisplayedScore(toScore);
        setAnimDisplayedCombos(toCombos);
        setAnimDisplayedMalus(toMalus);
        setAnimDisplayedLateMalus(toLateMalus);
        setAnimShowUpdated(true);
      }

      animSet(() => setAnimPhase('exit'), UPDATE_HOLD_MS);
    }
  }, [animPhase]);

  // Visibility driver. HUD values + images stay visible through the entire
  // animation INCLUDING the post-animation hold (the 'exit' phase keeps
  // animPhase !== 'idle' for the full ~10s). Once we reset to idle everything
  // hides at once — the screen returns to its all-hidden start state until the
  // next punch.
  useEffect(() => {
    setHudValuesVisible(animPhase !== 'idle');
  }, [animPhase]);

  useEffect(() => {
    if (animPhase === 'exit') {
      animSet(async () => {
        if (postAnimExitDelayMs > 0) {
          await new Promise(r => setTimeout(r, postAnimExitDelayMs));
        }
        clearAnimInterval();
        const wasGameOver = punchAnimation?.gameOver ?? false;
        const teamName = punchAnimation?.teamName ?? '';
        if (punchAnimation) {
          setLastKnownScore(punchAnimation.newScore);
          setLastKnownQuestDetails(punchAnimation.newQuestDetails);
          setLastKnownCombos(punchAnimation.newCombos);
          setLastKnownMalus(punchAnimation.newMalus ?? 0);
          setLastKnownLateMalus(punchAnimation.newLateMalus ?? 0);
          if (punchAnimation.endTimeToCommit != null && punchAnimation.teamId != null) {
            await updateTeam(punchAnimation.teamId, { end_time: punchAnimation.endTimeToCommit, score: punchAnimation.newScore });
          }
        }
        setAnimPhase('idle');
        setAnimRevealedSlots(0);
        setAnimShowUpdated(false);
        // Chain straight into the next queued punch animation, if any, so
        // punches that landed during this one (or its hold) still play. On
        // game-over we stop and drop the queue — we're leaving the page.
        const nextQueued = wasGameOver ? null : (pendingAnimationsRef.current.shift() ?? null);
        punchAnimationRef.current = nextQueued;
        setPunchAnimation(nextQueued);
        if (wasGameOver) {
          setGameOverTeamName(teamName);
        }
      }, EXIT_MS);
    }
  }, [animPhase]);

  useEffect(() => {
    return () => {
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      clearAnimInterval();
      questAudioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    if (punchAnimation && animPhase === 'idle') {
      setAnimRevealedSlots(0);
      setAnimShowUpdated(false);
      setAnimDisplayedScore(punchAnimation.prevScore);
      setAnimDisplayedCombos(punchAnimation.prevCombos);
      setAnimDisplayedMalus(punchAnimation.prevMalus ?? 0);
      setAnimDisplayedLateMalus(punchAnimation.prevLateMalus ?? 0);
      setAnimPhase('enter');
    }
  }, [punchAnimation]);

  useEffect(() => {
    const loadGameData = async () => {
      try {
        // game-data.json + media files come from the local SQLite/FS store
        // (download_scenario / download_media); layouts come from layoutStore.
        // Images resolve via the scenario:// protocol — no disk walk needed
        // because the Rust handler joins on the row's current local_version
        // at request time.
        const scenarioRow = await scenarioStore.get(gameUniqid);
        const gdjRaw = (await scenarioStore.getGameData(gameUniqid)) as
          | { game_data?: any }
          | any
          | null;
        if (gdjRaw && scenarioRow) {
          const rawGdjWeb = gdjRaw.game_data ?? gdjRaw;
          const quests = rawGdjWeb?.quests || [];
          const gdWeb: GameData = {
            game: {
              id: gameUniqid,
              uniqid: gameUniqid,
              type: scenarioRow.game_type,
              title: scenarioRow.title,
            },
            quests,
            levels: rawGdjWeb?.game_meta?.levels ?? rawGdjWeb?.levels ?? undefined,
            game_meta: (rawGdjWeb?.game_meta as TagquestGameMetaRuntime | undefined) ?? undefined,
          };
          gameDataRef.current = gdWeb;
          setGameData(gdWeb);
          // Register the scenario's uploaded custom fonts so a Typography
          // selection that points at one renders (offline-safe).
          void registerScenarioFonts(gameUniqid, rawGdjWeb?.game_meta?.custom_fonts);
        }

        // Layout resolution order:
        //   1. SQLite (synced from studio MySQL). Take the highest remote_version
        //      row that has layout_data_json set.
        //   2. Bundled JSON (hand-mirror of studio's defaultLayout.ts).
        //   3. Pick whichever has the higher `version` string. Ties go to SQLite
        //      so a published layout always wins once it's been synced.
        //
        // localStorage 'layout_tagquest' is no longer consulted — the bundled
        // fallback supersedes it.
        let sqliteLayout: GameLayout | null = null;
        try {
          const layouts = await layoutStore.list({ gameType: 'tagquest' });
          const downloaded = layouts.filter((l) => l.layout_data_json != null);
          if (downloaded.length > 0) {
            downloaded.sort((a, b) => b.remote_version - a.remote_version);
            const parsed = JSON.parse(downloaded[0].layout_data_json!);
            sqliteLayout = (parsed.config ?? parsed.layout_data ?? parsed) as GameLayout;
          }
        } catch (err) {
          console.warn('[TagQuest] failed to read layout from local store:', err);
        }

        const bundledLayout = bundledTagquestLayout as unknown as GameLayout;

        // Compare semver-ish version strings. `compareVersions(a, b)` returns
        // > 0 when a > b, < 0 when a < b, 0 when equal. Missing/unparseable
        // versions are treated as 0.0.0 so a layout that omits `version`
        // (legacy) loses to the bundled one.
        const compareVersions = (a: string | undefined, b: string | undefined): number => {
          const parts = (s: string | undefined) =>
            (s ?? '').split('.').map((p) => parseInt(p, 10) || 0);
          const av = parts(a);
          const bv = parts(b);
          const n = Math.max(av.length, bv.length);
          for (let i = 0; i < n; i++) {
            const diff = (av[i] ?? 0) - (bv[i] ?? 0);
            if (diff !== 0) return diff;
          }
          return 0;
        };

        let layoutConfig: GameLayout;
        if (sqliteLayout && compareVersions(sqliteLayout.version, bundledLayout.version) >= 0) {
          layoutConfig = sqliteLayout;
        } else {
          layoutConfig = bundledLayout;
          if (sqliteLayout) {
            console.info('[TagQuest] bundled layout v%s supersedes SQLite v%s', bundledLayout.version, sqliteLayout.version);
          }
        }

        // Leave element.filename as-is — sentinel filenames (`@template`,
        // `@background`, `@malus_image`, `@quest_main_image_N`) are resolved
        // at render time against the per-scenario gameMeta. Non-sentinel
        // filenames resolve via `scenarioAssetUrl` in the same place.
        setLayout({
          ...layoutConfig,
          background: layoutConfig.background || '@background',
          elements: layoutConfig.elements || [],
        });
      } catch (error) {
        console.error('Error loading game data:', error);
      } finally {
        setLayoutLoading(false);
      }
    };

    loadGameData();
  }, [gameUniqid]);

  useEffect(() => {
    if (launchedGameId) {
      loadTeams();
      const interval = setInterval(loadTeams, 2000);
      return () => clearInterval(interval);
    }
  }, [launchedGameId, victoryType]);

  useEffect(() => {
    if (!launchedGameId) return;
    let cancelled = false;

    // Start the game ONCE and record a persistent start timestamp on the game
    // row. Re-entering the page must NOT reset it — previously startAllTeams
    // overwrote every team's start_time with "now" (and cleared end_time) on
    // each mount, which restarted the timer and un-finished teams.
    const init = async () => {
      try {
        let state = await getLaunchedGameState(launchedGameId, 0);
        if (!state.start_time) {
          // Prefer an already-running game's earliest team start (so legacy
          // games keep their real start); otherwise start now.
          const existingStarts = state.teams
            .map((t) => t.start_time)
            .filter((s): s is number => s != null);
          const startMs = existingStarts.length ? Math.min(...existingStarts) * 1000 : Date.now();
          const startIso = new Date(startMs).toISOString();
          try {
            await startLaunchedGame(launchedGameId, startIso);
            // Start teams that haven't started yet; never touch end_time, so a
            // team that already finished stays finished on re-entry.
            await Promise.all(
              state.teams
                .filter((t) => t.start_time == null)
                .map((t) => updateTeam(t.id, { start_time: Math.floor(startMs / 1000) }))
            );
          } catch (err) {
            console.error('[TagQuest] start_game failed:', err);
          }
          state = await getLaunchedGameState(launchedGameId, 0);
        }
        if (!cancelled) setLaunchedGameInfo({ start_time: state.start_time, duration: state.duration });
      } catch (err) {
        console.error('[TagQuest] init failed:', err);
      }
    };

    const fetchMeta = async () => {
      try {
        const map = await getLaunchedGameMeta(launchedGameId);
        if (map.victoryType === 'score' || map.victoryType === 'speed') {
          setVictoryType(map.victoryType);
        }
        if (map.playMode === 'solo' || map.playMode === 'team') {
          setPlayMode(map.playMode);
        }
        if (map.teamsConfig) {
          try { setTeamsConfig(JSON.parse(map.teamsConfig)); } catch { /* swallow */ }
        }
      } catch (err) {
        console.error('[TagQuest] fetchMeta failed:', err);
      }
    };

    init();
    fetchMeta();
    return () => { cancelled = true; };
  }, [launchedGameId]);

  // Countdown basis: the launched-game row's start_time (a persistent ISO-8601
  // UTC string set once by init/start_game). Falls back to the earliest team
  // start_time only transiently — before init has set the row, or for legacy
  // games. Team start_time is unix SECONDS.
  const gameStartSec = teams.reduce<number | null>((min, t) => {
    if (t.start_time == null) return min;
    return min == null ? t.start_time : Math.min(min, t.start_time);
  }, null);
  const timerStartMs = (() => {
    if (launchedGameInfo?.start_time) {
      const ms = new Date(launchedGameInfo.start_time).getTime();
      if (!Number.isNaN(ms)) return ms;
    }
    return gameStartSec != null ? gameStartSec * 1000 : null;
  })();

  useEffect(() => {
    const duration = launchedGameInfo?.duration;
    if (timerStartMs == null || duration == null) return;

    const tick = () => {
      const endMs = timerStartMs + duration * 60 * 1000;
      const remainingSec = Math.floor((endMs - Date.now()) / 1000);
      if (remainingSec > 0) {
        setCountdown(remainingSec);
        setNextMalusInSec(null);
      } else {
        // Clock expired: a late malus accrues each full minute past the
        // deadline. Count down the seconds to the next one (60 → 1, repeating).
        setCountdown(0);
        const overSec = Math.max(0, Math.floor((Date.now() - endMs) / 1000));
        setNextMalusInSec(60 - (overSec % 60));
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [timerStartMs, launchedGameInfo?.duration]);

  const getTeamLevel = (score: number): { level: number; name: string } | null => {
    const levels = gameDataRef.current?.levels;
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
  };

  const loadTeams = async () => {
    if (!launchedGameId) return;
    try {
      const state = await getLaunchedGameState(launchedGameId, 0);
      const withLevels = state.teams.map((t) => ({
        id: t.id,
        team_name: t.team_name ?? '',
        score: t.score,
        start_time: t.start_time,
        end_time: t.end_time,
        key_id: t.key_id ?? 0,
        currentLevel: getTeamLevel(t.score ?? 0),
      }));
      const sorted = [...withLevels].sort((a, b) => {
        if (victoryType === 'speed') {
          if (a.end_time && b.end_time) return a.end_time - b.end_time;
          if (a.end_time) return -1;
          if (b.end_time) return 1;
          if (a.start_time && b.start_time) return a.start_time - b.start_time;
          if (a.start_time) return -1;
          if (b.start_time) return 1;
          return 0;
        }
        return (b.score ?? 0) - (a.score ?? 0);
      });
      setTeams(sorted);
    } catch (err) {
      console.error('[TagQuest] loadTeams failed:', err);
    }
  };

  const saveCardData = async (card: CardData) => {
    if (!launchedGameId) return;
    try {
      const rawDataJson = JSON.parse(JSON.stringify(card));
      // Server resolves device_id from the JWT (slice 1's auth_tokens.device_id);
      // no need to send it from the client.
      await recordPunch(launchedGameId, rawDataJson);
    } catch (error) {
      console.error('Error saving card data:', error);
    }
  };

  const resolveMedia = useCallback((key: string): string => {
    if (!key) return '';
    return scenarioAssetUrl(gameUniqid, key.replace(/^media\//, ''));
  }, [gameUniqid]);

  // Scenario-wide font from the Typography section. Empty when no font is set
  // (falls through to the layout element / page default). When set it
  // overrides every layout element's own fontFamily — see renderLayoutElement.
  const scenarioFontFamily = resolveFontFamily(
    gameData?.game_meta?.font as string | undefined,
  );

  // Start the next queued animation, but only if nothing is currently playing
  // (idle + no active punchAnimation). Otherwise the punch stays queued and the
  // exit-reset chains into it. punchAnimationRef is set synchronously here so
  // two punches in the same tick can't both kick off an animation.
  const tryStartNextAnimation = useCallback(() => {
    if (animPhaseRef.current !== 'idle' || punchAnimationRef.current != null) return;
    const next = pendingAnimationsRef.current.shift();
    if (next) {
      punchAnimationRef.current = next;
      setPunchAnimation(next);
    }
  }, []);

  const handleCardPunchLogic = async (card: CardData) => {
    if (!launchedGameId) return;

    const result = await processTagQuestPunch(
      card,
      launchedGameId,
      gameUniqid,
      playMode,
      teamsConfig,
      resolveMedia,
      consumedPunchesRef.current
    );

    await logApiCall({
      endpoint: `/tagquest/punch/${launchedGameId}`,
      method: 'PUNCH',
      requestBody: card as unknown as Record<string, unknown>,
      responseData: result,
      statusCode: result.status === 'ok' ? 200 : result.status === 'error' ? 500 : 422,
      errorMessage: result.status !== 'ok' ? result.message : undefined,
    });

    // team_punch_responses (analytics ride-along) is not migrated to studio
    // MySQL in slice 3 — punch logging already happens via recordPunch +
    // logApiCall above. If we want a dedicated response audit log later, add
    // an endpoint then re-enable a write here.

    if (result.status === 'ok') {
      if (result.animationData) {
        // Queue + play. If an animation is already running (or holding), this
        // punch waits its turn instead of clobbering the current one.
        pendingAnimationsRef.current.push(result.animationData);
        tryStartNextAnimation();
      } else if (result.game_ended) {
        showMessage(`${result.team_name} — Game finished!`, undefined, 'success');
      } else if (result.completed_quest) {
        const mainMsg = `${result.team_name} — ${result.completed_quest.name} complete! +${result.completed_quest.points} pts${result.malus_applied > 0 ? ` (−${result.malus_applied} late malus)` : ''}`;
        const levelPart = result.level_up ? `Level up: ${result.level_up.name}!` : undefined;
        showMessage(mainMsg, levelPart, 'success');
      } else if (result.level_up) {
        showMessage(`${result.team_name} — Level up: ${result.level_up.name}!`, undefined, 'success');
      } else if (result.best_partial_quest) {
        // Partial progress — neutral info (not a completion).
        showMessage(
          `${result.team_name} — ${result.best_partial_quest.name}: ${result.best_partial_quest.matched} image(s) found`,
          undefined,
          'info',
        );
      }
      loadTeams();
    } else {
      // Surface every non-ok outcome (unknown card, cheat, team already
      // finished, error) on screen so a detected bip is never silently dropped.
      const lang = config.language || gameData?.default_language || 'fr';
      const { text, type } = describePunchStatus(result.status, result.team_name, result.message, lang);
      showMessage(text, undefined, type);
    }
  };

  const showMessage = (message: string, levelUp?: string, type: GameMessageType = 'info') => {
    setGameMessage(message);
    setLevelUpMessage(levelUp || '');
    setGameMessageSeverity(type);
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    msgTimerRef.current = setTimeout(
      () => { setGameMessage(''); setLevelUpMessage(''); },
      config.messageDisplayDuration * 1000,
    );
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleCardPunchLogicRef = useRef(handleCardPunchLogic);
  useEffect(() => { handleCardPunchLogicRef.current = handleCardPunchLogic; });

  const handleNewBip = useCallback((row: { raw_data: any }) => {
    const card = row.raw_data;
    if (card) {
      console.log('🏷️  CARD DETECTED (test/simulation):', card);
      setLastCardData(card);
      setShowCardAlert(true);
      setTimeout(() => setShowCardAlert(false), 5000);
      handleCardPunchLogicRef.current(card);
    }
  }, []);

  useGameStatePolling({
    launchedGameId,
    numberOfTeams: config.numberOfTeams,
    onGameEnded: () => onGameEnd?.(),
    onAllTeamsFinished: () => onGameEnd?.(),
    onNewBip: handleNewBip,
  });

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;
    if (isElectron) {
      (window as any).electron.db.connect().catch(() => {});
    }
  }, []);

  useEffect(() => {
    // Auto-detect the SportIdent reader on start. If the dongle isn't
    // plugged in yet, the global 'reader:status' event (emitted by
    // Footer's 10s poll) re-fires this effect and tries again — that's
    // the hotplug path.
    let cancelled = false;

    const initializeUSB = async () => {
      if (!usbReaderService.isAvailable()) return;
      const detected = await detectReaderPort();
      if (cancelled || !detected) return;

      try {
        console.log('🔌 Initializing USB reader on detected port:', detected.path);
        const initialized = await usbReaderService.initializePort(detected.path);
        if (initialized) {
          console.log('✓ USB reader initialized successfully');
          usbReaderService.setCardDetectedCallback((card: CardData) => {
            console.log('🏷️  CARD DETECTED:', card);
            saveCardData(card);
            setLastCardData(card);
            setShowCardAlert(true);
            setTimeout(() => setShowCardAlert(false), 5000);
          });

          usbReaderService.setCardRemovedCallback(() => {
            console.log('🏷️  CARD REMOVED');
            setShowCardAlert(false);
          });

          // Phase 1 diagnostic: start the read loop so the SportIdent dongle
          // on the mother actually surfaces punches. Mirrors MysteryGamePage.
          // If this causes double-counting with the LAN backend's raw_data
          // polling in production, revisit the TagQuest USB architecture.
          console.log('▶️  Starting USB reader...');
          await usbReaderService.start();
          console.log('✓ USB reader started - waiting for card data...');
        }
      } catch (error) {
        console.error('Error initializing USB reader:', error);
      }
    };

    const onReaderStatus = () => {
      void initializeUSB();
    };

    if (gameStarted) {
      void initializeUSB();
      window.addEventListener('reader:status', onReaderStatus);
    }

    return () => {
      cancelled = true;
      window.removeEventListener('reader:status', onReaderStatus);
      if (usbReaderService.isAvailable()) {
        usbReaderService.stop().catch(err => {
          console.error('Error stopping USB reader:', err);
        });
      }
    };
  }, [gameStarted]);

  // The HUD lives in a fixed 16:9 "stage" centered in the viewport.
  // Background image is a separate full-bleed layer underneath that fills
  // the viewport via objectFit:'cover'. Text/template positions are
  // percentages of the stage box, never the viewport — so they don't drift
  // when the viewport aspect ratio is not 16:9 (letterbox/pillarbox).
  const TEMPLATE_ASPECT = 16 / 9;
  const updateBgDimensions = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let width: number;
    let height: number;
    if (vw / vh > TEMPLATE_ASPECT) {
      // Viewport wider than 16:9 — height-limited, pillarbox left/right.
      height = vh;
      width = vh * TEMPLATE_ASPECT;
    } else {
      // Viewport narrower than 16:9 — width-limited, letterbox top/bottom.
      width = vw;
      height = vw / TEMPLATE_ASPECT;
    }
    setBgDimensions({ width, height });
  }, [TEMPLATE_ASPECT]);

  useEffect(() => {
    updateBgDimensions();
    window.addEventListener('resize', updateBgDimensions);
    return () => {
      window.removeEventListener('resize', updateBgDimensions);
    };
  }, [updateBgDimensions]);

  // Resolve sentinel filenames (`@…`) against per-scenario gameMeta.
  // Non-sentinel filenames pass through `scenarioAssetUrl` which targets
  // the scenario:// protocol for the current local_version.
  const resolveImageFilename = useCallback((filename: string | undefined): string => {
    if (!filename) return '';
    if (!filename.startsWith('@')) {
      return scenarioAssetUrl(gameUniqid, filename);
    }
    const meta = gameDataRef.current?.game_meta;
    if (filename === '@background') {
      return meta?.background_image ? scenarioAssetUrl(gameUniqid, meta.background_image) : '';
    }
    if (filename === '@template' || filename === '@default') {
      const useDefault = meta?.use_default_template !== false; // default true when missing
      if (!useDefault && meta?.custom_template) {
        return scenarioAssetUrl(gameUniqid, meta.custom_template);
      }
      return DEFAULT_TAGQUEST_TEMPLATE_URL;
    }
    if (filename === '@malus_image') {
      return meta?.malus_image ? scenarioAssetUrl(gameUniqid, meta.malus_image) : '';
    }
    if (filename === '@late_malus_image') {
      return meta?.late_malus_image ? scenarioAssetUrl(gameUniqid, meta.late_malus_image) : '';
    }
    const questMatch = filename.match(/^@quest_main_image_(\d+)$/);
    if (questMatch) {
      const idx = parseInt(questMatch[1], 10) - 1;
      const main = gameDataRef.current?.quests?.[idx]?.main_image;
      return main ? scenarioAssetUrl(gameUniqid, main) : '';
    }
    return '';
  }, [gameUniqid]);

  const renderLayoutElement = (element: LayoutElement, index: number): JSX.Element | JSX.Element[] => {
    if (!bgDimensions) {
      return <div key={`${element.id}-${index}`} />;
    }

    const dimToCss = (
      v: LayoutDim | undefined,
      base: number,
    ): string | undefined => {
      if (v === undefined) return undefined;
      if (typeof v === 'string') return v;        // 'auto' | 'fit-content' | 'min-content' | 'max-content'
      return `${(v / 100) * base}px`;
    };
    const wrapperStyle: React.CSSProperties = {
      position: 'absolute',
      left: element.x !== undefined ? `${(element.x / 100) * bgDimensions.width}px` : undefined,
      top: element.y !== undefined ? `${(element.y / 100) * bgDimensions.height}px` : undefined,
      width: dimToCss(element.width, bgDimensions.width),
      height: dimToCss(element.height, bgDimensions.height),
      ...element.style
    };

    let imageSrc = element.src || resolveImageFilename(element.filename);

    const isAnimating = animPhase !== 'idle';
    const activeQuestIndex = punchAnimation?.displayQuest?.index != null ? punchAnimation.displayQuest.index - 1 : -1;

    if (element.id === 'animation_quest_image') {
      const quests = gameData?.quests || [];
      if (!quests.length) return <div key={`${element.id}-${index}`} style={wrapperStyle} />;

      const resolveMedia = (key: string | undefined): string => {
        if (!key) return '';
        return scenarioAssetUrl(gameUniqid, key.replace(/^media\//, ''));
      };

      return quests.map((quest, questIndex) => {
        const questNum = questIndex + 1;
        const mainSrc = resolveMedia(quest.main_image);
        const isActiveQuest = isAnimating && activeQuestIndex === questIndex;
        const isComplete = punchAnimation?.displayQuest?.complete ?? false;
        const slots = punchAnimation?.displayQuest?.slots ?? [];
        // The full main image is the completion reward: it appears ONLY once
        // every image of the quest has been punched (isComplete). Until then we
        // show just the slot grid with matched/unmatched marks. On a partial
        // punch (never complete) the full image never appears.
        const showMain = isActiveQuest && isComplete && (animPhase === 'main' || animPhase === 'update' || animPhase === 'exit');
        const showSubImages = isActiveQuest && (animPhase === 'enter' || animPhase === 'images' || animPhase === 'main' || animPhase === 'update' || animPhase === 'exit');

        return (
          <div
            key={`quest-${questNum}-outer`}
            id={`quest-${questNum}-outer`}
            style={{ ...wrapperStyle, display: isActiveQuest ? (wrapperStyle.display ?? 'flex') : 'none', flexDirection: 'column' }}
          >
            <div
              id={`quest-${questNum}-wrapper`}
              style={{ position: 'relative', flex: 1, minHeight: 0 }}
            >
              {showMain && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: '2px solid rgba(74,222,128,0.6)',
                    boxShadow: '0 0 32px rgba(74,222,128,0.3)',
                    opacity: showMain ? 1 : 0,
                    transition: 'opacity 0.5s ease',
                    zIndex: 2,
                  }}
                >
                  <img src={mainSrc} alt={quest.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.15)' }}>
                    <div style={{ background: 'rgba(74,222,128,0.9)', borderRadius: '50%', width: '20%', height: 'auto', aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg viewBox="0 0 24 24" style={{ width: '60%', stroke: '#fff', fill: 'none', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }}><polyline points="20 6 9 17 4 12" /></svg>
                    </div>
                  </div>
                </div>
              )}
              {showSubImages && !showMain && slots.length > 0 && (
                <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'grid', gridTemplateColumns: slots.length <= 2 ? `repeat(${slots.length}, 1fr)` : 'repeat(2, 1fr)', gap: 0, zIndex: 1 }}>
                  {slots.map((slot, si) => {
                    const revealed = si < animRevealedSlots;
                    return (
                      <div
                        key={slot.key}
                        style={{
                          position: 'relative',
                          overflow: 'hidden',
                          background: '#0f172a',
                          opacity: revealed ? 1 : 0.15,
                          transform: revealed ? 'scale(1)' : 'scale(0.92)',
                          transition: 'opacity 0.35s ease, transform 0.35s ease',
                        }}
                      >
                        {slot.src ? (
                          <img src={slot.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', filter: revealed && !slot.matched ? 'grayscale(60%) brightness(0.5)' : 'none', transition: 'filter 0.3s ease' }} />
                        ) : (
                          <div style={{ width: '100%', paddingBottom: '100%', background: 'rgba(255,255,255,0.05)' }} />
                        )}
                        {revealed && (
                          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: slot.matched ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.18)' }}>
                            <div style={{ background: slot.matched ? 'rgba(74,222,128,0.85)' : 'rgba(248,113,113,0.85)', borderRadius: '50%', width: '30%', aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
                              {slot.matched
                                ? <svg viewBox="0 0 24 24" style={{ width: '60%', stroke: '#fff', fill: 'none', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }}><polyline points="20 6 9 17 4 12" /></svg>
                                : <svg viewBox="0 0 24 24" style={{ width: '60%', stroke: '#fff', fill: 'none', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                              }
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div
              key={`quest-${questNum}-title`}
              className="quest_title"
              style={{
                width: '100%',
                display: 'flex',
                color: element.color || '#fff',
                fontFamily: scenarioFontFamily || element.fontFamily,
                fontSize: element.fontSize !== undefined
                  ? `${element.fontSize * (bgDimensions.width / 1920)}px`
                  : '1em',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                lineHeight: 1.2,
                textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                flexShrink: 0,
              }}
            >
              {quest.name}
            </div>
          </div>
        );
      });
    }

    const elementId = element.id?.toLowerCase() ?? '';
    // Admin-managed HUD label IDs (resolved against the tagquest_translations row).
    const ADMIN_LABEL_KEYS: Record<string, AdminLabelKey> = {
      score_label: 'score',
      malus_label: 'malus',
      late_malus_label: 'late_malus',
      combo_points_label: 'combo_points',
    };
    const adminLabelKey: AdminLabelKey | undefined = ADMIN_LABEL_KEYS[elementId];
    // Note: `isTitle` historically swept up anything ending in `_title`/`_label`.
    // Exclude the admin-managed labels here so they fall through to their
    // dedicated text branch below (otherwise they'd render their previewText).
    const isTitle = !adminLabelKey && (
      elementId.includes('_title') ||
      elementId.includes('_label') ||
      elementId.endsWith('title') ||
      elementId.endsWith('label')
    );
    const isQuestPoints = /quest_\d+_points/.test(elementId);
    const isQuestMultiplicator = /quest_\d+_multiplicat/.test(elementId);
    // Anchored — must NOT match `animation_quest_name`. Per-slot quest names
    // in the right strip only.
    const isQuestName = /^quest_\d+_name$/.test(elementId);
    const isActiveQuestName = elementId === 'animation_quest_name';
    // Combo tier (6/4/2) elements come in two flavours per tier:
    //   combo_<tier>_multiplicator → HOW MANY of that combo were obtained (x{n})
    //   combo_<tier>_points        → points earned from that tier ({n} * tierPts)
    const comboTier = !isTitle && !isQuestMultiplicator
      ? (() => { const m = elementId.match(/combo_?([642])/); return m ? parseInt(m[1], 10) : 0; })()
      : 0;
    const isComboMultiplicator = comboTier > 0 && elementId.includes('multiplicat');
    const isComboPoints = comboTier > 0 && !isComboMultiplicator;
    // Generic multiplicator (e.g. malus_multiplicator) — NOT a combo tier.
    const isMultiplicator = !isTitle && !isQuestMultiplicator && comboTier === 0 && elementId.includes('multiplicat');
    const isLateMalus = !isTitle && elementId.includes('late_malus');
    const isMalus = !isTitle && !isLateMalus && elementId.includes('malus');
    const isTotalScore = elementId.includes('total_score') || elementId === 'score';
    const isTeamName = elementId === 'team_name_text';
    const isTimer = elementId.includes('timer') || elementId.includes('countdown');

    // fontSize is a fixed pixel value defined in defaultLayout.ts — no
    // adaptive scaling. The author tunes it directly against the artwork.

    const questIndexForElement = (() => {
      const m = elementId.match(/quest_(\d+)_/);
      return m ? parseInt(m[1], 10) - 1 : -1;
    })();

    const getQuestDetail = (details: PunchAnimationData['newQuestDetails'], qi: number) =>
      details.find(d => d.questIndex === qi);

    const isQuestSpecificImage = questIndexForElement >= 0;
    const isQuestIcon = /^quest_\d+_icon$/.test(elementId);

    const valuesShow = isAnimating || hudValuesVisible;
    let imageVisible: boolean;
    if (elementId === 'tagquest_template' || elementId === 'background_image') {
      // Template overlay + background-image elements are always visible.
      imageVisible = true;
    } else if (elementId === 'malus_icon' || elementId === 'late_malus_icon') {
      // Malus / late-malus images stay on as static HUD chrome — visible even
      // when no malus is currently applied and outside the animation/hold.
      // Guarded on a resolved src so a scenario without the image shows nothing
      // rather than a broken-image glyph.
      imageVisible = !!imageSrc;
    } else if (isQuestIcon && questIndexForElement >= 0) {
      const qd = getQuestDetail(lastKnownQuestDetails, questIndexForElement);
      imageVisible = valuesShow && !!qd && qd.timesCompleted > 0;
    } else {
      imageVisible = isTimer || (isAnimating && (
        !isQuestSpecificImage || questIndexForElement === activeQuestIndex
      ));
    }

    switch (element.type) {
      case 'image':
        return (
          <div key={`${element.id}-${index}`} style={{ ...wrapperStyle, display: imageVisible ? 'block' : 'none' }}>
            <img
              src={imageSrc || ''}
              alt={element.id}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </div>
        );
      case 'text': {
        let displayText: string | number | undefined;
        let showElement = false;

        if (isTimer) {
          showElement = true;
          if (countdown !== null && countdown <= 0 && lateMalusPoints > 0 && nextMalusInSec != null) {
            // Game clock expired and the scenario has a late malus: show the
            // translatable "Next malus in {s} s" countdown instead of 0:00.
            const dl = gameData?.default_language || 'fr';
            const lang = config.language || dl;
            const tmpl = resolveAdminLabelRuntime(adminTranslations, 'next_malus', lang, dl);
            displayText = tmpl.replace('{s}', String(nextMalusInSec));
          } else {
            displayText = countdown !== null ? formatTime(countdown) : formatTime(0);
          }
        } else if (isTeamName) {
          showElement = valuesShow;
          displayText = punchAnimation?.teamName ?? '';
        } else if (isTotalScore) {
          // Hidden at start / after reset; shown during the animation + hold.
          showElement = valuesShow;
          displayText = isAnimating ? animDisplayedScore : lastKnownScore;
        } else if (adminLabelKey) {
          // Admin-managed HUD label (score/malus/late_malus/combo_points).
          // Tracks the values' visibility so labels hide together with their
          // numbers. Language defaults to fr unless the scenario carries one.
          showElement = valuesShow;
          const lang = gameData?.default_language || 'fr';
          displayText = resolveAdminLabelRuntime(adminTranslations, adminLabelKey, lang, lang);
        } else if (isActiveQuestName) {
          // Beneath the central grid. Visible only while a punch animation
          // is playing — matches the grid's own visibility.
          showElement = isAnimating && activeQuestIndex >= 0;
          displayText = activeQuestIndex >= 0
            ? (gameData?.quests?.[activeQuestIndex]?.name ?? '')
            : '';
        } else if (isQuestName && questIndexForElement >= 0) {
          // Per-slot quest name in the right strip. Tracks the values'
          // visibility so the right-strip scoreboard hides at start/after reset
          // along with its icons/points (mirrors the icon/mult/points logic).
          const quest = gameData?.quests?.[questIndexForElement];
          showElement = valuesShow && !!quest;
          displayText = quest?.name ?? '';
        } else if (isQuestPoints && questIndexForElement >= 0) {
          showElement = valuesShow;
          const isActiveQuest = questIndexForElement === activeQuestIndex;
          const details = isAnimating
            ? (animShowUpdated && isActiveQuest ? (punchAnimation?.newQuestDetails ?? []) : (punchAnimation?.prevQuestDetails ?? []))
            : lastKnownQuestDetails;
          const qd = getQuestDetail(details, questIndexForElement);
          displayText = qd ? `${qd.totalPoints}` : '0';
        } else if (isQuestMultiplicator && questIndexForElement >= 0) {
          showElement = valuesShow;
          const isActiveQuest = questIndexForElement === activeQuestIndex;
          const details = isAnimating
            ? (animShowUpdated && isActiveQuest ? (punchAnimation?.newQuestDetails ?? []) : (punchAnimation?.prevQuestDetails ?? []))
            : lastKnownQuestDetails;
          const qd = getQuestDetail(details, questIndexForElement);
          displayText = qd ? `x${qd.timesCompleted}` : 'x0';
        } else if (isComboMultiplicator) {
          // How many times this combo tier was obtained.
          showElement = valuesShow;
          const combos = isAnimating ? animDisplayedCombos : lastKnownCombos;
          const count = comboTier === 6 ? combos.combos6 : comboTier === 4 ? combos.combos4 : combos.combos2;
          displayText = `x${count}`;
        } else if (isComboPoints) {
          // Points earned from this combo tier (count × tier value).
          showElement = valuesShow;
          const combos = isAnimating ? animDisplayedCombos : lastKnownCombos;
          const cp = punchAnimation?.comboPoints ?? staticComboPoints;
          const count = comboTier === 6 ? combos.combos6 : comboTier === 4 ? combos.combos4 : combos.combos2;
          const pts = comboTier === 6 ? cp.pts6 : comboTier === 4 ? cp.pts4 : cp.pts2;
          displayText = `${count * pts}`;
        } else if (isMultiplicator) {
          showElement = valuesShow;
          const combos = isAnimating ? animDisplayedCombos : lastKnownCombos;
          const totalCombos = combos.combos6 + combos.combos4 + combos.combos2;
          displayText = `x${totalCombos}`;
        } else if (isLateMalus) {
          showElement = valuesShow;
          displayText = isAnimating ? `-${animDisplayedLateMalus}` : `-${lastKnownLateMalus}`;
        } else if (isMalus) {
          showElement = valuesShow;
          displayText = isAnimating ? `-${animDisplayedMalus}` : `-${lastKnownMalus}`;
        } else {
          showElement = true;
          displayText = element.text ?? element.previewText;
        }

        return (
          <div key={`${element.id}-${index}`} style={{ ...wrapperStyle, display: showElement ? (wrapperStyle.display ?? 'block') : 'none' }}>
            <div
              style={{
                width: '100%',
                height: '100%',
                // fontSize in defaultLayout.json is authored against a 1920-wide
                // canonical stage. Scale to the actual stage so the text keeps
                // its proportion against the template artwork at any size.
                fontSize: element.fontSize !== undefined
                  ? `${element.fontSize * (bgDimensions.width / 1920)}px`
                  : undefined,
                color: element.color,
                fontFamily: scenarioFontFamily || element.fontFamily,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {displayText}
            </div>
          </div>
        );
      }
      case 'container': {
        const containerQuestIndex = (() => {
          const cId = element.id?.toLowerCase() ?? '';
          const m = cId.match(/quest_(\d+)/);
          return m ? parseInt(m[1], 10) - 1 : -1;
        })();
        const containerIsQuestSpecific = containerQuestIndex >= 0;
        const containerVisible = isAnimating && (
          !containerIsQuestSpecific || containerQuestIndex === activeQuestIndex
        );
        return (
          <div key={`${element.id}-${index}`} style={{ ...wrapperStyle, display: containerVisible ? (wrapperStyle.display ?? 'block') : 'none' }}>
            {element.children?.map((child, childIndex) => renderLayoutElement(child, childIndex))}
          </div>
        );
      }
      default:
        return <div key={`${element.id}-${index}`}>Unknown element type</div>;
    }
  };



  if (!gameData || layoutLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading game data...</div>
      </div>
    );
  }

  if (!gameStarted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col items-center justify-center p-8">
        <button
          onClick={onBack}
          className="absolute top-6 left-6 text-white/70 hover:text-white transition-colors flex items-center gap-2"
        >
          <ArrowLeft className="w-5 h-5" />
          Back
        </button>

        <div className="text-center max-w-2xl">
          <h1 className="text-5xl font-bold text-white mb-6">{gameData.game.title}</h1>
          <div className="bg-white/10 backdrop-blur-sm rounded-lg p-8 mb-8">
            <div className="flex items-center justify-center gap-3 text-white/80 mb-6">
              <Users className="w-6 h-6" />
              <span className="text-lg">{config.teams?.length || config.numberOfTeams || 0} Teams</span>
            </div>
            <p className="text-white/60">Message Duration: {config.messageDisplayDuration}s</p>
          </div>

          <button
            onClick={handleStartGame}
            className="bg-blue-600 hover:bg-blue-700 text-white px-12 py-4 rounded-lg text-xl font-semibold transition-colors flex items-center gap-3 mx-auto"
          >
            <Play className="w-6 h-6" />
            Start Game
          </button>
          <p className="text-white/40 mt-4">Press Enter to start</p>
        </div>
      </div>
    );
  }

  if (layout) {
    const backgroundUrl = resolveImageFilename(layout.background);
    return (
      <div style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        backgroundColor: '#000',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: scenarioFontFamily || undefined,
      }}>
        {/* Background: full viewport, cover (may crop edges on non-16:9). */}
        {backgroundUrl && (
          <img
            ref={bgImageRef}
            src={backgroundUrl}
            alt="Background"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center',
            }}
          />
        )}

        {/* Stage: the 16:9 template box. All HUD elements position inside this. */}
        {bgDimensions && (
          <div
            style={{
              position: 'relative',
              width: `${bgDimensions.width}px`,
              height: `${bgDimensions.height}px`,
            }}
          >
            {layout.elements?.map((element, index) => renderLayoutElement(element, index))}
          </div>
        )}

        <GameMessageOverlay
          message={gameMessage || null}
          type={gameMessageSeverity}
          subMessage={levelUpMessage || null}
          fontFamily={scenarioFontFamily || undefined}
        />

        {/* Dev-only punch/hardware debug indicator — removed from production builds. */}
        {import.meta.env.DEV && (
          <CardDetectionAlert
            cardData={lastCardData}
            show={showCardAlert}
          />
        )}
        {punchAnimation && !layout.elements?.some(el => el.id === 'animation_quest_image') && (
          <PunchAnimationOverlay
            data={punchAnimation}
            onDone={async () => {
              const wasGameOver = punchAnimation.gameOver ?? false;
              const teamName = punchAnimation.teamName ?? '';
              if (punchAnimation.endTimeToCommit != null && punchAnimation.teamId != null) {
                await updateTeam(punchAnimation.teamId, { end_time: punchAnimation.endTimeToCommit, score: punchAnimation.newScore });
              }
              setPunchAnimation(null);
              if (wasGameOver) setGameOverTeamName(teamName);
            }}
          />
        )}

        {gameOverTeamName && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.82)',
              zIndex: 2000,
              backdropFilter: 'blur(6px)',
            }}
            onClick={() => setGameOverTeamName(null)}
          >
            <div style={{
              textAlign: 'center',
              padding: '48px 64px',
              borderRadius: '20px',
              background: 'rgba(15,23,42,0.9)',
              border: '1px solid rgba(74,222,128,0.3)',
              boxShadow: '0 0 60px rgba(74,222,128,0.15), 0 24px 48px rgba(0,0,0,0.6)',
            }}>
              <div style={{ fontSize: '4rem', marginBottom: '12px' }}>🏁</div>
              <div style={{
                fontSize: 'clamp(2rem, 5vw, 3.5rem)',
                fontWeight: 800,
                color: '#4ade80',
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
                marginBottom: '16px',
              }}>
                Game Over
              </div>
              <div style={{
                fontSize: 'clamp(1.2rem, 3vw, 2rem)',
                color: '#fff',
                fontWeight: 600,
                marginBottom: '8px',
              }}>
                Good game, {gameOverTeamName}!
              </div>
              <div style={{ marginTop: '32px', fontSize: '0.85rem', color: 'rgba(255,255,255,0.3)' }}>
                Tap to dismiss
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-8"
      style={{ fontFamily: scenarioFontFamily || undefined }}
    >
      <GameMessageOverlay
        message={gameMessage || null}
        type={gameMessageSeverity}
        subMessage={levelUpMessage || null}
        fontFamily={scenarioFontFamily || undefined}
      />

      <button
        onClick={onBack}
        className="text-white/70 hover:text-white transition-colors flex items-center gap-2 mb-6"
      >
        <ArrowLeft className="w-5 h-5" />
        Back
      </button>

      <div className="max-w-6xl mx-auto">
        {config.testMode && (
          <div className="flex items-center justify-center gap-3 mb-6 px-4 py-3 bg-amber-500/20 border border-amber-500/50 rounded-lg">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-amber-400 font-semibold text-sm tracking-wide uppercase">Test Mode — Max 5 Teams</span>
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          </div>
        )}

        {usbReaderService.isAvailable() && !detectedReader.isPresent && (
          <div className="flex items-center justify-center gap-3 mb-6 px-4 py-3 bg-orange-500/20 border border-orange-500/50 rounded-lg">
            <div className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
            <span className="text-orange-300 text-sm">
              Reader not connected — waiting for SportIdent dongle. The game will autobind when you plug it in.
            </span>
          </div>
        )}

        <h1 className="text-4xl font-bold text-white mb-8 text-center">{gameData.game.title}</h1>

        {gameMessage && (
          <div className="bg-blue-600 text-white p-4 rounded-lg mb-6 text-center text-xl font-semibold">
            {gameMessage}
            {levelUpMessage && (
              <div className="mt-2 text-yellow-300 text-lg font-bold">
                {levelUpMessage}
              </div>
            )}
          </div>
        )}

        <div className="bg-white/10 backdrop-blur-sm rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between text-white mb-4">
            <div className="flex items-center gap-3">
              <Trophy className="w-6 h-6" />
              <h2 className="text-2xl font-bold">Leaderboard</h2>
            </div>
            <span className={`text-xs font-semibold px-3 py-1 rounded-full ${
              victoryType === 'speed'
                ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40'
                : 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
            }`}>
              {victoryType === 'speed' ? 'Rapidite' : 'Score'}
            </span>
          </div>

          <div className="space-y-3">
            {teams.length === 0 ? (
              <p className="text-white/60 text-center py-8">No teams have started yet</p>
            ) : (
              teams.map((team, index) => {
                const configTeam = teamsConfig.find(
                  t => t.chipId === team.key_id || t.name === team.team_name
                );
                const teammates = playMode === 'team' ? (configTeam?.teammates ?? []) : [];
                return (
                  <div
                    key={team.id}
                    className="bg-white/5 rounded-lg p-4"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className={`text-2xl font-bold ${
                          index === 0 ? 'text-yellow-400' :
                          index === 1 ? 'text-gray-300' :
                          index === 2 ? 'text-amber-600' :
                          'text-white/60'
                        }`}>
                          #{index + 1}
                        </div>
                        <div>
                          <div className="text-white font-semibold text-lg">{team.team_name}</div>
                          <div className="text-white/60 text-sm">
                            {team.start_time && team.end_time ? (
                              <>Finished &mdash; {formatTime(team.end_time - team.start_time)}</>
                            ) : team.start_time ? (
                              <>In progress...</>
                            ) : (
                              <>Not started</>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        {victoryType === 'score' ? (
                          <>
                            <div className="text-2xl font-bold text-white">{team.score} pts</div>
                            {team.currentLevel && (
                              <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                                {team.currentLevel.name}
                              </div>
                            )}
                          </>
                        ) : (
                          team.end_time ? (
                            <div className="text-lg font-bold text-orange-400">{formatTime(team.end_time - (team.start_time ?? team.end_time))}</div>
                          ) : (
                            <div className="text-sm text-white/40">&mdash;</div>
                          )
                        )}
                      </div>
                    </div>
                    {teammates.length > 1 && (
                      <div className="mt-3 pt-3 border-t border-white/10 flex flex-wrap gap-2">
                        {teammates.map((mate, mi) => (
                          <span key={mi} className="flex items-center gap-1.5 px-2.5 py-1 bg-white/5 rounded-full text-xs text-white/70">
                            <span className="w-1.5 h-1.5 rounded-full bg-teal-400 inline-block" />
                            {mate.name}
                            <span className="text-white/30">#{mate.chipNumber}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="bg-yellow-600/20 border border-yellow-600 text-yellow-100 p-4 rounded-lg">
          <p className="font-semibold mb-2">No Layout Found</p>
          <p className="text-sm">
            To display the custom game layout, please upload a TagQuest layout file or sync with the server.
            Currently showing the default leaderboard view.
          </p>
        </div>
      </div>

      {/* Dev-only punch/hardware debug indicator — removed from production builds. */}
      {import.meta.env.DEV && (
        <CardDetectionAlert
          cardData={lastCardData}
          show={showCardAlert}
        />
      )}
      {punchAnimation && (
        <PunchAnimationOverlay
          data={punchAnimation}
          onDone={async () => {
            const wasGameOver = punchAnimation.gameOver ?? false;
            const teamName = punchAnimation.teamName ?? '';
            if (punchAnimation.endTimeToCommit != null && punchAnimation.teamId != null) {
              await updateTeam(punchAnimation.teamId, { end_time: punchAnimation.endTimeToCommit, score: punchAnimation.newScore });
            }
            setPunchAnimation(null);
            if (wasGameOver) setGameOverTeamName(teamName);
          }}
        />
      )}

      {gameOverTeamName && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(6px)' }}
          onClick={() => setGameOverTeamName(null)}
        >
          <div className="text-center px-16 py-12 rounded-2xl bg-slate-900/90 border border-green-500/30 shadow-2xl">
            <div className="text-6xl mb-3">🏁</div>
            <div className="text-5xl font-extrabold text-green-400 mb-4 tracking-tight">Game Over</div>
            <div className="text-2xl font-semibold text-white">Good game, {gameOverTeamName}!</div>
            <div className="mt-8 text-sm text-white/30">Tap to dismiss</div>
          </div>
        </div>
      )}
    </div>
  );
}
