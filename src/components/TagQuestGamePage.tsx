import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Users, Trophy } from 'lucide-react';
import { GameConfig } from './LaunchGameModal';
import { sportidentService as usbReaderService, CardData, detectReaderPort, isReaderConnected } from '../services/sportidentService';
import { useDetectedReaderPort } from '../services/useDetectedReaderPort';
import { CardDetectionAlert } from './CardDetectionAlert';
import { GameMessageOverlay } from './GameMessageOverlay';
import { PendingTeamsBar } from './PendingTeamsBar';
import { usePresentationQueue } from '../hooks/usePresentationQueue';
import { describePunchStatus, type GameMessageType } from '../services/gameMessages';
import { PunchAnimationOverlay } from './PunchAnimationOverlay';
import * as scenarioStore from '../services/scenarioStore';
import { tIngame } from '../i18n/ingame';
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
import { onPendingConfigReload } from '../services/pendingJoinStore';
// TagQuest self-register (mirrors Clash): team-mode chip→team binding reuses the
// server-authoritative clash_register / lg_clash_members endpoints; solo-mode
// enrols each chip as its own team via the shared dynamic-team helper.
import { clashRegister, getClashMembers } from '../services/clash';
import { ensureTeamForCard } from '../services/teamRegistration';
import { TagQuestRegistrationScreen, type TagQuestRegTeam } from './TagQuestRegistrationScreen';
// Station-based registration assignment: this device may be hard-locked to
// specific team(s) during registration (meta.regAssignments, keyed by
// device_id). Design: project_selfregister_team_device_assignment.
import {
  parseRegAssignments,
  assignedTeamNumbersFor,
  getSelfDeviceId,
  REG_ASSIGNMENTS_META_KEY,
  type RegAssignmentMap,
} from '../services/regAssignments';

type AnimPhase = 'idle' | 'enter' | 'images' | 'main' | 'update' | 'exit';

// The four admin-managed HUD label keys (resolved via the `ingame_tagquest`
// i18next namespace - bundled baselines, synced overrides applied at sync time).
type AdminLabelKey = 'score' | 'malus' | 'late_malus' | 'combo_points';

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

// Per-scenario UI-string overrides. When the editor's "UI text strings" section
// has a value for one of these punch statuses, it replaces the default in-game
// message.
const STATUS_TEXT_META_KEY: Record<string, string> = {
  card_empty: 'text_card_empty',
  cheat_detected: 'text_team_cheating',
  team_already_finished: 'text_team_ended',
  error: 'text_if_error',
};

/** Read a Localized<string> map (or plain string) at the active language. */
function pickLocalized(v: unknown, lang: string): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const map = v as Record<string, string>;
    return map[lang] || Object.values(map)[0] || '';
  }
  return '';
}

/** Resolve the scenario's configured override text for a punch status, if any. */
function resolveStatusTextOverride(
  status: string,
  meta: TagquestGameMetaRuntime | undefined,
  lang: string,
): string | undefined {
  const key = STATUS_TEXT_META_KEY[status];
  if (!key || !meta) return undefined;
  const txt = pickLocalized(meta[key], lang).trim();
  return txt || undefined;
}

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

// Team self-register: pick the station's selected team. Keeps the current
// selection while it has room; when it's full (or nothing is selected yet)
// advance to the next team with room, scanning forward from the current
// position and wrapping. All-full keeps the current selection (server rejects
// further joins with clan_full anyway).
// Station assignment: restrict the pickable teams to this device's assigned
// team_numbers (null ⇒ unrestricted - the legacy full grid).
function filterAssignedRegTeams(
  rows: TagQuestRegTeam[],
  assigned: number[] | null,
): TagQuestRegTeam[] {
  return assigned ? rows.filter((t) => assigned.includes(t.team_number)) : rows;
}

function nextRegSelection(
  rows: TagQuestRegTeam[],
  currentId: number | null,
  maxPerTeam: number,
): number | null {
  if (rows.length === 0) return null;
  const isFull = (t: TagQuestRegTeam) => maxPerTeam > 0 && t.member_count >= maxPerTeam;
  const curIdx = currentId != null ? rows.findIndex((t) => t.team_id === currentId) : -1;
  if (curIdx >= 0 && !isFull(rows[curIdx])) return currentId;
  // No/invalid selection scans from the first team; a full selection scans
  // from the team after it.
  const start = curIdx >= 0 ? curIdx : rows.length - 1;
  for (let k = 1; k <= rows.length; k++) {
    const cand = rows[(start + k) % rows.length];
    if (!isFull(cand)) return cand.team_id;
  }
  return currentId ?? rows[0].team_id;
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
  const [lastCardData, setLastCardData] = useState<CardData | null>(null);
  const [showCardAlert, setShowCardAlert] = useState(false);
  // Banner shown when the SportIdent reader isn't plugged in - the game
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
  // Seconds elapsed past the game deadline (0 while the clock is still running).
  // Drives the red negative overtime timer on the HUD.
  const [overtimeSec, setOvertimeSec] = useState(0);
  const [launchedGameInfo, setLaunchedGameInfo] = useState<{ start_time: string | null; duration: number | null } | null>(null);
  const [victoryType, setVictoryType] = useState<'speed' | 'score'>(config.victoryType || 'speed');
  const [playMode, setPlayMode] = useState<'solo' | 'team'>(config.playMode || 'solo');
  const [teamsConfig, setTeamsConfig] = useState<import('./LaunchGameModal').Team[]>(config.teams || []);
  // ── Self-register (Clash-style) ────────────────────────────────────────────
  // When on, the roster isn't pre-built: players bind their chip to a team at
  // game start on the registration screen. `phase` gates register→playing; a
  // game that's already started (resume/join) skips straight to playing.
  const [selfRegister, setSelfRegister] = useState<boolean>(!!config.tagquestSelfRegister);
  const [maxPerTeam, setMaxPerTeam] = useState<number>(config.tagquestMaxPerTeam ?? 0);
  const [phase, setPhase] = useState<'register' | 'playing'>(
    config.tagquestSelfRegister ? 'register' : 'playing',
  );
  const [selectedRegTeamId, setSelectedRegTeamId] = useState<number | null>(null);
  // `nonce` re-triggers the registration screen's join flash even when the same
  // outcome repeats (two players joining the same team back to back).
  const [lastJoin, setLastJoin] = useState<{ teamId: number; status: string; nonce: number } | null>(null);
  // Registration-screen tiles (predefined teams + live counts in team mode; the
  // enrolled per-chip teams in solo mode). Polled while phase === 'register'.
  const [regTeams, setRegTeams] = useState<TagQuestRegTeam[]>([]);
  // chip_id → team_id bindings from lg_clash_members (team self-register). Used
  // at play time to resolve a bipped chip to the team it joined at registration.
  const [memberTeamByChip, setMemberTeamByChip] = useState<Map<number, number>>(new Map());
  // Station assignment: the meta.regAssignments map + this device's paired id.
  // When this device has an entry, the registration screen hard-locks to those
  // team_numbers (no entry ⇒ the legacy pick-any-team grid).
  const [regAssignMap, setRegAssignMap] = useState<RegAssignmentMap>({});
  const [selfDeviceId, setSelfDeviceId] = useState<number | null>(null);
  const assignedTeamNumbers = assignedTeamNumbersFor(regAssignMap, selfDeviceId);
  const phaseRef = useRef(phase);
  const selectedRegTeamIdRef = useRef(selectedRegTeamId);
  const playModeRef = useRef(playMode);
  const regTeamsRef = useRef(regTeams);
  const assignedTeamNumbersRef = useRef(assignedTeamNumbers);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { selectedRegTeamIdRef.current = selectedRegTeamId; }, [selectedRegTeamId]);
  useEffect(() => { playModeRef.current = playMode; }, [playMode]);
  useEffect(() => { regTeamsRef.current = regTeams; }, [regTeams]);
  useEffect(() => { assignedTeamNumbersRef.current = assignedTeamNumbers; });
  const [punchAnimation, setPunchAnimation] = useState<PunchAnimationData | null>(null);
  const [gameOverTeamName, setGameOverTeamName] = useState<string | null>(null);

  const [animPhase, setAnimPhase] = useState<AnimPhase>('idle');
  const [animRevealedSlots, setAnimRevealedSlots] = useState(0);
  const [animShowUpdated, setAnimShowUpdated] = useState(false);
  const [animDisplayedScore, setAnimDisplayedScore] = useState(0);
  const [animDisplayedCombos, setAnimDisplayedCombos] = useState({ combos6: 0, combos4: 0, combos2: 0 });
  // Static combo points read from gameMeta - used between animations when
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
  // Serial presentation queue. Punch animations AND status messages share it,
  // so a punch (or message) arriving while one is on screen - including during
  // the post-animation hold - waits its turn instead of overlapping, and the
  // waiting teams show in the bottom line. No punch is dropped.
  const queue = usePresentationQueue();
  // Resolver for the slot wrapping the in-flight animation state-machine; called
  // when the exit phase finishes so the queue advances to the next item.
  const animResolveRef = useRef<(() => void) | null>(null);
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
  // In-memory by design - it resets if the kiosk reloads mid-game (speed mode
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
  // hides at once - the screen returns to its all-hidden start state until the
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
        // Tear down this animation and resolve its queue slot so the queue
        // advances to the next item (another animation or a message). On
        // game-over we drop the rest of the queue - we're leaving the page.
        punchAnimationRef.current = null;
        setPunchAnimation(null);
        if (wasGameOver) {
          queue.clear();
          setGameOverTeamName(teamName);
        }
        const resolveSlot = animResolveRef.current;
        animResolveRef.current = null;
        resolveSlot?.();
      }, EXIT_MS);
    }
  }, [animPhase]);

  useEffect(() => {
    return () => {
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      clearAnimInterval();
      questAudioRef.current?.pause();
      // Settle a mid-animation slot so the queue chain doesn't wedge on unmount.
      animResolveRef.current?.();
      animResolveRef.current = null;
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
        // Images resolve via the scenario:// protocol - no disk walk needed
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

        // Layout source: the bundled JSON (a hand-mirror of studio's
        // defaultLayout.ts). Studio retired the per-game-type `layouts` table
        // publish pipeline, so the bundled layout is the offline default here.
        const layoutConfig = bundledTagquestLayout as unknown as GameLayout;

        // Leave element.filename as-is - sentinel filenames (`@template`,
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
    let retryTimer: number | undefined;

    // Start the game ONCE and record a persistent start timestamp on the game
    // row. Re-entering the page must NOT reset it - previously startAllTeams
    // overwrote every team's start_time with "now" (and cleared end_time) on
    // each mount, which restarted the timer and un-finished teams.
    const init = async () => {
      try {
        let state = await getLaunchedGameState(launchedGameId, 0);
        const alreadyStarted = !!state.start_time;
        // Self-register is decided by the launched game's META, not by the
        // config prop. A satellite driven here by a join_game push builds its
        // config from a meta read that can come back EMPTY (getLaunchedGameMeta
        // fails open to `{}` when the LAN route isn't pointed at the mother
        // yet) - the prop then says "not self-register" and this device both
        // skipped registration AND auto-started the mother's game underneath
        // the operator. Read meta here and OR the two sources.
        let metaSelfRegister: boolean | null = null;
        try {
          const m = await getLaunchedGameMeta(launchedGameId);
          if (Object.keys(m).length > 0) metaSelfRegister = m.tagquestSelfRegister === 'true';
        } catch {
          /* leave null - unknown, handled below */
        }
        // Unknown meta ⇒ never auto-start. Falling through would stamp
        // start_time on a game that may well be mid-registration elsewhere.
        if (metaSelfRegister === null && !alreadyStarted && !config.tagquestSelfRegister) {
          console.warn('[TagQuest] launched-game meta unreadable - holding, will retry');
          if (!cancelled) retryTimer = window.setTimeout(() => { if (!cancelled) void init(); }, 1500);
          return;
        }
        const isSelfRegister = metaSelfRegister ?? !!config.tagquestSelfRegister;
        // Self-register (Clash-style): hold on the registration screen until the
        // operator hits Start (handleRegistrationStart). Do NOT auto-start the
        // game or its teams here. A game that's already started (resume/join)
        // falls through to 'playing' and skips registration.
        if (isSelfRegister && !alreadyStarted) {
          if (!cancelled) {
            setSelfRegister(true);
            setPhase('register');
          }
          return;
        }
        if (!alreadyStarted) {
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
        if (!cancelled) {
          setPhase('playing');
          setLaunchedGameInfo({ start_time: state.start_time, duration: state.duration });
        }
      } catch (err) {
        console.error('[TagQuest] init failed:', err);
      }
    };

    const fetchMeta = async () => {
      try {
        const map = await getLaunchedGameMeta(launchedGameId);
        // An empty map means the read fell open (wrong LAN route / unknown id),
        // not "every option is off" - don't let it clear self-register.
        if (Object.keys(map).length === 0) return;
        if (map.victoryType === 'score' || map.victoryType === 'speed') {
          setVictoryType(map.victoryType);
        }
        if (map.playMode === 'solo' || map.playMode === 'team') {
          setPlayMode(map.playMode);
        }
        setSelfRegister(map.tagquestSelfRegister === 'true');
        // The per-team cap rides in clash_config.max_per_clan (reused verbatim).
        if (map.clash_config) {
          try {
            const cc = JSON.parse(map.clash_config);
            if (typeof cc?.max_per_clan === 'number') setMaxPerTeam(cc.max_per_clan);
          } catch { /* swallow */ }
        }
        if (map.teamsConfig) {
          try { setTeamsConfig(JSON.parse(map.teamsConfig)); } catch { /* swallow */ }
        }
        setRegAssignMap(parseRegAssignments(map[REG_ASSIGNMENTS_META_KEY]));
      } catch (err) {
        console.error('[TagQuest] fetchMeta failed:', err);
      }
    };

    init();
    fetchMeta();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [launchedGameId]);

  // A roster/config edit made on another device (e.g. the mother adding a
  // player to a team) lands as a `reload_config` push. GamePage re-derives the
  // generic config from meta, but the teammate roster lives only in
  // meta.teamsConfig (not carried by gameConfigFromMeta), so re-read it here so
  // added players appear live on this device without a remount.
  useEffect(() => {
    if (!launchedGameId) return;
    return onPendingConfigReload((gid) => {
      if (gid !== launchedGameId) return;
      (async () => {
        try {
          const map = await getLaunchedGameMeta(launchedGameId);
          if (map.teamsConfig) {
            try { setTeamsConfig(JSON.parse(map.teamsConfig)); } catch { /* swallow */ }
          }
          if (map.victoryType === 'score' || map.victoryType === 'speed') setVictoryType(map.victoryType);
          if (map.playMode === 'solo' || map.playMode === 'team') setPlayMode(map.playMode);
          // A registration-station reassignment (Devices modal) lands here too,
          // so a kiosk re-locks to its new team(s) live.
          setRegAssignMap(parseRegAssignments(map[REG_ASSIGNMENTS_META_KEY]));
        } catch (err) {
          console.error('[TagQuest] reload teamsConfig failed:', err);
        }
      })();
    });
  }, [launchedGameId]);

  // Countdown basis: the launched-game row's start_time (a persistent ISO-8601
  // UTC string set once by init/start_game). Falls back to the earliest team
  // start_time only transiently - before init has set the row, or for legacy
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
        setOvertimeSec(0);
      } else {
        // Clock expired: keep counting the time past the deadline so the HUD
        // shows a red negative overtime timer.
        setCountdown(0);
        const overSec = Math.max(0, Math.floor((Date.now() - endMs) / 1000));
        setOvertimeSec(overSec);
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

  // ── Station assignment: resolve this device's paired id while registering,
  // so meta.regAssignments can be keyed against it, and (re-)read the map on
  // entering the register phase. The mount-time fetchMeta can land before a
  // satellite's LAN route is pointed at the mother, which would leave this
  // station unrestricted; re-reading here (as ClashGamePage does) fixes that.
  useEffect(() => {
    if (!launchedGameId || phase !== 'register') return;
    let cancelled = false;
    void getSelfDeviceId(launchedGameId).then((id) => {
      if (!cancelled) setSelfDeviceId(id);
    });
    void (async () => {
      try {
        const map = await getLaunchedGameMeta(launchedGameId);
        if (!cancelled && Object.keys(map).length > 0) {
          setRegAssignMap(parseRegAssignments(map[REG_ASSIGNMENTS_META_KEY]));
        }
      } catch (err) {
        console.error('[TagQuest] regAssignments read failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [launchedGameId, phase]);

  // ── Self-register registration screen: poll the team tiles + live counts ────
  useEffect(() => {
    if (!launchedGameId || phase !== 'register') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const state = await getLaunchedGameState(launchedGameId, 0);
        const counts = new Map<number, number>();
        if (playMode === 'team') {
          const members = await getClashMembers(launchedGameId);
          for (const mem of members) counts.set(mem.team_id, (counts.get(mem.team_id) ?? 0) + 1);
        }
        if (cancelled) return;
        const rows: TagQuestRegTeam[] = state.teams
          .slice()
          .sort((a, b) => a.team_number - b.team_number)
          .map((t) => ({
            team_id: t.id,
            team_number: t.team_number,
            team_name: t.team_name ?? '',
            member_count: counts.get(t.id) ?? 0,
          }));
        setRegTeams(rows);
        if (playMode === 'team') {
          // Default this station's selection to the first non-full team, and
          // hop off a team that filled up (possibly from another station) so
          // the next bip lands on a team with room. An assigned station only
          // ever scans within its own team(s) - a hard lock, not a preference.
          setSelectedRegTeamId((cur) =>
            nextRegSelection(
              filterAssignedRegTeams(rows, assignedTeamNumbersRef.current),
              cur,
              maxPerTeam,
            ),
          );
        }
      } catch (err) {
        console.error('[TagQuest] registration poll failed:', err);
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [launchedGameId, phase, playMode, maxPerTeam]);

  // ── Play time: load chip→team bindings for team self-register so a bipped
  // chip resolves to the team it joined (registration is frozen once started). ─
  useEffect(() => {
    if (!launchedGameId || phase !== 'playing') return;
    if (!selfRegister || playMode !== 'team') return;
    let cancelled = false;
    (async () => {
      try {
        const members = await getClashMembers(launchedGameId);
        if (cancelled) return;
        const m = new Map<number, number>();
        for (const mem of members) m.set(mem.chip_id, mem.team_id);
        setMemberTeamByChip(m);
      } catch (err) {
        console.error('[TagQuest] load member bindings failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [launchedGameId, phase, selfRegister, playMode]);

  // Reader bip during registration: bind the chip to the station's selected
  // team (team mode, reuses clash_register) or enrol the chip as its own team
  // (solo mode). Play-time bips go through saveCardData instead - the reader
  // callback routes by phase.
  const handleRegisterCard = useCallback(async (card: CardData) => {
    if (!launchedGameId) return;
    if (playModeRef.current === 'team') {
      const teamId = selectedRegTeamIdRef.current;
      if (teamId == null) return;
      try {
        const res = await clashRegister(launchedGameId, teamId, card.id);
        setLastJoin({ teamId, status: res.status, nonce: Date.now() });
        // Reflect the server's authoritative count immediately (the 1.5s poll
        // would lag one bip behind), then hop the station's selection to the
        // next team with room when this bip filled the team - or when the
        // team had already filled from another station (clan_full race).
        if (res.status === 'ok' || res.status === 'clan_full') {
          const rows = regTeamsRef.current.map((t) =>
            t.team_id === teamId ? { ...t, member_count: res.member_count } : t,
          );
          setRegTeams(rows);
          setSelectedRegTeamId((cur) =>
            nextRegSelection(
              filterAssignedRegTeams(rows, assignedTeamNumbersRef.current),
              cur,
              maxPerTeam,
            ),
          );
        }
      } catch (err) {
        console.error('[TagQuest] register failed:', err);
      }
    } else {
      // Solo: one team per chip. Skip if this chip already enrolled.
      try {
        const state = await getLaunchedGameState(launchedGameId, 0);
        const existing = state.teams.find((t) => t.key_id === card.id);
        if (existing) {
          setLastJoin({ teamId: existing.id, status: 'already_in_clan', nonce: Date.now() });
          return;
        }
        const created = await ensureTeamForCard(launchedGameId, card.id, state);
        if (created) setLastJoin({ teamId: created.id, status: 'ok', nonce: Date.now() });
      } catch (err) {
        console.error('[TagQuest] solo enrol failed:', err);
      }
    }
  }, [launchedGameId, maxPerTeam]);
  const handleRegisterCardRef = useRef(handleRegisterCard);
  useEffect(() => { handleRegisterCardRef.current = handleRegisterCard; });

  // Operator starts the game from the registration screen: stamp the game +
  // every enrolled team's start_time (mass start), then switch to playing.
  const handleRegistrationStart = useCallback(async () => {
    if (!launchedGameId) return;
    try {
      const state = await getLaunchedGameState(launchedGameId, 0);
      const startMs = Date.now();
      const startIso = new Date(startMs).toISOString();
      await startLaunchedGame(launchedGameId, startIso);
      await Promise.all(
        state.teams
          .filter((t) => t.start_time == null)
          .map((t) => updateTeam(t.id, { start_time: Math.floor(startMs / 1000) })),
      );
      const fresh = await getLaunchedGameState(launchedGameId, 0);
      if (fresh) setLaunchedGameInfo({ start_time: fresh.start_time, duration: fresh.duration });
    } catch (err) {
      console.error('[TagQuest] registration start failed:', err);
    } finally {
      setPhase('playing');
    }
  }, [launchedGameId]);

  // Raw-data row ids for punches THIS device physically read. The 1s state poll
  // echoes every device's punches back to every device; this set lets
  // handleNewBip recognise our own echo (already processed below) and tell it
  // apart from a punch read on another station (which must NOT animate here).
  const processedRawIdsRef = useRef<Set<number>>(new Set());

  const saveCardData = async (card: CardData) => {
    if (!launchedGameId) return;
    try {
      const rawDataJson = JSON.parse(JSON.stringify(card));
      // Server resolves device_id from the JWT (slice 1's auth_tokens.device_id);
      // no need to send it from the client.
      const { id } = await recordPunch(launchedGameId, rawDataJson);
      // Process the punch locally so the animation plays on THIS device - the
      // station whose reader physically read the card. We mark the row id first
      // so the poll echo is recognised as ours and not replayed. Previously
      // TagQuest did no local processing and let the echo drive scoring, so the
      // punch animated (and re-scored) on every device in the game.
      if (typeof id === 'number') processedRawIdsRef.current.add(id);
      await handleCardPunchLogicRef.current(card);
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
  // overrides every layout element's own fontFamily - see renderLayoutElement.
  const scenarioFontFamily = resolveFontFamily(
    gameData?.game_meta?.font as string | undefined,
  );

  // Enqueue a punch animation onto the shared serial queue. The slot's run wraps
  // the existing state-machine: it stores a resolver, then sets punchAnimation
  // (kicking the idle→enter effect). The queue runs one slot at a time, so the
  // machine is only ever (re-)entered once the previous animation has fully
  // finished - the exit-phase effect calls the stored resolver to advance.
  const enqueueAnimation = useCallback((data: PunchAnimationData) => {
    void queue.enqueue(data.teamName ?? null, () => new Promise<void>((resolve) => {
      animResolveRef.current = resolve;
      punchAnimationRef.current = data;
      setPunchAnimation(data);
    }));
  }, [queue.enqueue]);

  const handleCardPunchLogic = async (card: CardData) => {
    if (!launchedGameId) return;

    const result = await processTagQuestPunch(
      card,
      launchedGameId,
      gameUniqid,
      playMode,
      teamsConfig,
      resolveMedia,
      consumedPunchesRef.current,
      // Team self-register: resolve a bipped chip to the team it joined at
      // registration (empty for predetermined rosters / solo).
      memberTeamByChip,
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
    // MySQL in slice 3 - punch logging already happens via recordPunch +
    // logApiCall above. If we want a dedicated response audit log later, add
    // an endpoint then re-enable a write here.

    if (result.status === 'ok') {
      if (result.animationData) {
        // Queue + play through the shared serial queue. If an animation/message
        // is already on screen (or holding), this punch waits its turn - and
        // shows in the bottom line - instead of clobbering the current one.
        enqueueAnimation(result.animationData);
      } else if (result.game_ended) {
        showMessage(`${result.team_name} - Game finished!`, undefined, 'success', result.team_name);
      } else if (result.completed_quest) {
        const mainMsg = `${result.team_name} - ${result.completed_quest.name} complete! +${result.completed_quest.points} pts${result.malus_applied > 0 ? ` (−${result.malus_applied} late malus)` : ''}`;
        const levelPart = result.level_up ? `Level up: ${result.level_up.name}!` : undefined;
        showMessage(mainMsg, levelPart, 'success', result.team_name);
      } else if (result.level_up) {
        showMessage(`${result.team_name} - Level up: ${result.level_up.name}!`, undefined, 'success', result.team_name);
      } else if (result.best_partial_quest) {
        // Partial progress - neutral info (not a completion).
        showMessage(
          `${result.team_name} - ${result.best_partial_quest.name}: ${result.best_partial_quest.matched} image(s) found`,
          undefined,
          'info',
          result.team_name,
        );
      }
      loadTeams();
    } else {
      // Surface every non-ok outcome (unknown card, cheat, team already
      // finished, error) on screen so a detected bip is never silently dropped.
      const lang = config.language || gameData?.default_language || 'fr';
      const overrideText = resolveStatusTextOverride(result.status, gameDataRef.current?.game_meta, lang);
      const { text, type } = describePunchStatus(result.status, result.team_name, result.message, lang, overrideText);
      showMessage(text, undefined, type, result.team_name ?? null);
    }
  };

  // Serialise messages through the shared queue so a message blocks (and is
  // blocked by) punch animations - they no longer overlap. `label` is the team
  // shown in the waiting line while this message is deferred.
  const showMessage = (message: string, levelUp?: string, type: GameMessageType = 'info', label: string | null = null) => {
    void queue.enqueue(label, () => new Promise<void>((resolve) => {
      setGameMessage(message);
      setLevelUpMessage(levelUp || '');
      setGameMessageSeverity(type);
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
      msgTimerRef.current = setTimeout(() => {
        setGameMessage('');
        setLevelUpMessage('');
        msgTimerRef.current = null;
        resolve();
      }, config.messageDisplayDuration * 1000);
    }));
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleCardPunchLogicRef = useRef(handleCardPunchLogic);
  useEffect(() => { handleCardPunchLogicRef.current = handleCardPunchLogic; });

  const handleNewBip = useCallback((row: { id?: number; raw_data: any }) => {
    // Punches read on THIS device are already processed in saveCardData (the USB
    // reader callback) and their row id is recorded in processedRawIdsRef - the
    // poll echoes them back ~1s later, so skip our own echo here.
    if (row.id != null && processedRawIdsRef.current.has(row.id)) {
      processedRawIdsRef.current.delete(row.id);
      return;
    }
    // Otherwise this is a punch read on another station. Each device animates
    // only the cards it physically read, so we do NOT replay a remote bip here -
    // doing so was animating (and re-scoring) a single bip on every device.
  }, []);

  useGameStatePolling({
    launchedGameId,
    numberOfTeams: config.numberOfTeams,
    onGameEnded: () => onGameEnd?.(),
    onAllTeamsFinished: () => onGameEnd?.(),
    onNewBip: handleNewBip,
    // A device sitting on the self-register inscription screen follows the one
    // that pressed "Start game": the mother's start flag flips, the poll sees
    // it, and we leave the register phase for play. Idempotent for the device
    // that started the game itself (its handleStart already set phase).
    onGameStarted: () => setPhase('playing'),
    // Self-register builds its roster dynamically (solo) or leaves empty teams
    // (team mode), so a momentary "all current teams finished" - including the
    // 0-teams state during registration - must not end the game. It ends via
    // the server `ended` flag (manual End) or the duration timeout instead.
    disableAllFinishedEnd: selfRegister,
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
    // Footer's 10s poll) re-fires this effect and tries again - that's
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
            // During self-register the bip enrols/binds the chip; during play it
            // scores. Route by the live phase (ref, so this once-set callback
            // always sees the current phase).
            if (phaseRef.current === 'register') {
              handleRegisterCardRef.current(card);
            } else {
              saveCardData(card);
            }
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

    void initializeUSB();
    window.addEventListener('reader:status', onReaderStatus);

    return () => {
      cancelled = true;
      window.removeEventListener('reader:status', onReaderStatus);
      if (usbReaderService.isAvailable()) {
        usbReaderService.stop().catch(err => {
          console.error('Error stopping USB reader:', err);
        });
      }
    };
  }, []);

  // ── Fast reader hotplug on the inscription screen ──────────────────────────
  // The reader effect above (re)binds on the global 'reader:status' event, but
  // that only fires off the footer's 10s poll - a dongle plugged in mid-
  // registration then takes up to 10s to come alive, which reads as broken.
  // While registering, actively probe every 2s and re-emit 'reader:status' as
  // soon as a reader appears so the bind path fires within ~2s. Once bound,
  // initializePort no-ops, so re-emitting is cheap. Scoped to the register
  // phase so reader-less devices don't probe serial forever during play.
  useEffect(() => {
    if (!launchedGameId || phase !== 'register') return;
    if (!usbReaderService.isAvailable()) return;
    let cancelled = false;
    const id = setInterval(() => {
      void isReaderConnected().then((ok) => {
        if (ok && !cancelled) {
          window.dispatchEvent(new CustomEvent('reader:status', { detail: { state: 'ok' } }));
        }
      });
    }, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [launchedGameId, phase]);

  // The HUD lives in a fixed 16:9 "stage" centered in the viewport.
  // Background image is a separate full-bleed layer underneath that fills
  // the viewport via objectFit:'cover'. Text/template positions are
  // percentages of the stage box, never the viewport - so they don't drift
  // when the viewport aspect ratio is not 16:9 (letterbox/pillarbox).
  const TEMPLATE_ASPECT = 16 / 9;
  const updateBgDimensions = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let width: number;
    let height: number;
    if (vw / vh > TEMPLATE_ASPECT) {
      // Viewport wider than 16:9 - height-limited, pillarbox left/right.
      height = vh;
      width = vh * TEMPLATE_ASPECT;
    } else {
      // Viewport narrower than 16:9 - width-limited, letterbox top/bottom.
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

        // Quest artwork is authored square, but the layout box (e.g. 40%×60% of
        // the stage) isn't. Force square geometry: the main image is the largest
        // centered square that fits the box, and each slot cell is the largest
        // square such that the cols×rows grid fits - centered, surrounded by
        // empty (transparent) space rather than background slabs.
        const boxW = typeof element.width === 'number' ? (element.width / 100) * bgDimensions.width : null;
        const boxH = typeof element.height === 'number' ? (element.height / 100) * bgDimensions.height : null;
        const gridCols = slots.length > 0 && slots.length <= 2 ? slots.length : 2;
        const gridRows = Math.max(1, Math.ceil(Math.max(slots.length, 1) / gridCols));
        const cellPx = boxW != null && boxH != null ? Math.min(boxW / gridCols, boxH / gridRows) : null;
        const mainPx = boxW != null && boxH != null ? Math.min(boxW, boxH) : null;

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
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: mainPx != null ? `${mainPx}px` : '100%',
                    height: mainPx != null ? `${mainPx}px` : '100%',
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
                  {config.colorblindMode && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.15)' }}>
                      <div style={{ background: 'rgba(74,222,128,0.9)', borderRadius: '50%', width: '20%', height: 'auto', aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg viewBox="0 0 24 24" style={{ width: '60%', stroke: '#fff', fill: 'none', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }}><polyline points="20 6 9 17 4 12" /></svg>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {showSubImages && !showMain && slots.length > 0 && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
                  <div
                    style={
                      cellPx != null
                        ? { display: 'grid', gridTemplateColumns: `repeat(${gridCols}, ${cellPx}px)`, gridAutoRows: `${cellPx}px`, gap: 0 }
                        : { display: 'grid', gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gap: 0, width: '100%', height: '100%' }
                    }
                  >
                  {slots.map((slot, si) => {
                    const revealed = si < animRevealedSlots;
                    return (
                      <div
                        key={slot.key}
                        style={{
                          position: 'relative',
                          overflow: 'hidden',
                          // Square cell (the fixed cellPx grid already is; the
                          // fluid fallback enforces it per cell). No background -
                          // the artwork sits directly on the scenario backdrop.
                          ...(cellPx == null ? { aspectRatio: '1 / 1' } : {}),
                          // Ghost preview: unrevealed slots show dimmed unless the
                          // launch disabled it (adult audiences) - then they stay
                          // invisible and simply pop in on their staggered reveal.
                          opacity: revealed ? 1 : ((config.tagquestShowQuestPreview ?? true) ? 0.15 : 0),
                          transform: revealed ? 'scale(1)' : 'scale(0.92)',
                          transition: 'opacity 0.35s ease, transform 0.35s ease',
                        }}
                      >
                        {slot.src ? (
                          <img src={slot.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', filter: revealed && !slot.matched ? 'grayscale(60%) brightness(0.5)' : 'none', transition: 'filter 0.3s ease' }} />
                        ) : (
                          <div style={{ width: '100%', height: '100%' }} />
                        )}
                        {revealed && (
                          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: slot.matched ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.18)' }}>
                            {config.colorblindMode && (
                              <div style={{ background: slot.matched ? 'rgba(74,222,128,0.85)' : 'rgba(248,113,113,0.85)', borderRadius: '50%', width: '30%', aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
                                {slot.matched
                                  ? <svg viewBox="0 0 24 24" style={{ width: '60%', stroke: '#fff', fill: 'none', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }}><polyline points="20 6 9 17 4 12" /></svg>
                                  : <svg viewBox="0 0 24 24" style={{ width: '60%', stroke: '#fff', fill: 'none', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                                }
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  </div>
                </div>
              )}
            </div>
            {/* The per-quest name was previously rendered here too; the larger
                `animation_quest_name` layout element already shows the active
                quest's name beneath the grid, so this smaller duplicate was
                removed to avoid showing the name twice. */}
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
    // Anchored - must NOT match `animation_quest_name`. Per-slot quest names
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
    // Generic multiplicator (e.g. malus_multiplicator) - NOT a combo tier.
    const isMultiplicator = !isTitle && !isQuestMultiplicator && comboTier === 0 && elementId.includes('multiplicat');
    const isLateMalus = !isTitle && elementId.includes('late_malus');
    const isMalus = !isTitle && !isLateMalus && elementId.includes('malus');
    const isTotalScore = elementId.includes('total_score') || elementId === 'score';
    const isTeamName = elementId === 'team_name_text';
    const isTimer = elementId.includes('timer') || elementId.includes('countdown');

    // fontSize is a fixed pixel value defined in defaultLayout.ts - no
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
      // Malus / late-malus images stay on as static HUD chrome - visible even
      // when no malus is currently applied and outside the animation/hold.
      // Guarded on a resolved src so a scenario without the image shows nothing
      // rather than a broken-image glyph.
      imageVisible = !!imageSrc;
    } else if (isQuestIcon && questIndexForElement >= 0) {
      // Same live-during-animation source as quest points/multiplicator below:
      // lastKnownQuestDetails alone is only committed at exit (when the HUD is
      // already hidden), so the icon of a quest completed during THIS animation
      // would never show. The icon "earns" at the update phase, together with
      // the multiplier flipping to x1.
      const isActiveQuest = questIndexForElement === activeQuestIndex;
      const details = isAnimating
        ? (animShowUpdated && isActiveQuest ? (punchAnimation?.newQuestDetails ?? []) : (punchAnimation?.prevQuestDetails ?? []))
        : lastKnownQuestDetails;
      const qd = getQuestDetail(details, questIndexForElement);
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
        // When the game clock has run out, the timer keeps counting as a red
        // negative overtime clock (e.g. "-1:23") instead of freezing at 0:00.
        let isOvertimeTimer = false;

        if (isTimer) {
          showElement = true;
          if (countdown !== null && countdown <= 0) {
            // Game clock expired: show the overtime as a negative timer in red.
            isOvertimeTimer = true;
            displayText = `-${formatTime(overtimeSec)}`;
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
          displayText = tIngame('ingame_tagquest', adminLabelKey, lang);
        } else if (isActiveQuestName) {
          // Beneath the central grid. Visible only while a punch animation
          // is playing - matches the grid's own visibility.
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
                color: isOvertimeTimer ? '#ef4444' : element.color,
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



  // Self-register: players bind their chip to a team before the match. Shown
  // ahead of the game-data guard so registration is available immediately.
  if (phase === 'register' && launchedGameId) {
    // Scenario background behind the registration UI (same asset the in-game
    // layout's `@background` resolves to). Empty until game-data loads - the
    // screen falls back to its slate gradient.
    const regBackgroundUrl = gameData?.game_meta?.background_image
      ? scenarioAssetUrl(gameUniqid, gameData.game_meta.background_image)
      : '';
    return (
      <TagQuestRegistrationScreen
        playMode={playMode}
        teams={
          playMode === 'team'
            ? filterAssignedRegTeams(regTeams, assignedTeamNumbers)
            : regTeams
        }
        maxPerTeam={maxPerTeam}
        selectedTeamId={selectedRegTeamId}
        onSelectTeam={setSelectedRegTeamId}
        onStart={handleRegistrationStart}
        onBack={onBack}
        lastJoin={lastJoin}
        backgroundUrl={regBackgroundUrl}
        restricted={playMode === 'team' && assignedTeamNumbers != null}
      />
    );
  }

  if (!gameData || layoutLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading game data...</div>
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

        <PendingTeamsBar labels={queue.pending} fontFamily={scenarioFontFamily || undefined} />

        {/* Dev-only punch/hardware debug indicator - removed from production builds. */}
        {import.meta.env.DEV && (
          <CardDetectionAlert
            cardData={lastCardData}
            show={showCardAlert}
          />
        )}
        {punchAnimation && !layout.elements?.some(el => el.id === 'animation_quest_image') && (
          <PunchAnimationOverlay
            data={punchAnimation}
            colorblind={config.colorblindMode}
            onDone={async () => {
              const wasGameOver = punchAnimation.gameOver ?? false;
              const teamName = punchAnimation.teamName ?? '';
              if (punchAnimation.endTimeToCommit != null && punchAnimation.teamId != null) {
                await updateTeam(punchAnimation.teamId, { end_time: punchAnimation.endTimeToCommit, score: punchAnimation.newScore });
              }
              // Full teardown (this overlay path drives its own timeline, so the
              // phase-machine exit effect may not run): reset to idle so the next
              // queued slot can start, then resolve this slot to advance the queue.
              punchAnimationRef.current = null;
              setPunchAnimation(null);
              setAnimPhase('idle');
              if (wasGameOver) { queue.clear(); setGameOverTeamName(teamName); }
              const resolveSlot = animResolveRef.current;
              animResolveRef.current = null;
              resolveSlot?.();
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

      <PendingTeamsBar labels={queue.pending} fontFamily={scenarioFontFamily || undefined} />

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
            <span className="text-amber-400 font-semibold text-sm tracking-wide uppercase">Test Mode - Max 5 Teams</span>
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          </div>
        )}

        {usbReaderService.isAvailable() && !detectedReader.isPresent && (
          <div className="flex items-center justify-center gap-3 mb-6 px-4 py-3 bg-orange-500/20 border border-orange-500/50 rounded-lg">
            <div className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
            <span className="text-orange-300 text-sm">
              Reader not connected - waiting for SportIdent dongle. The game will autobind when you plug it in.
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
                // Self-register teams have no teamsConfig roster - their members
                // are the lg_clash_members bindings loaded for punch resolution.
                const regMemberCount =
                  playMode === 'team' && teammates.length === 0
                    ? [...memberTeamByChip.values()].filter((tid) => tid === team.id).length
                    : 0;
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
                    {teammates.length === 0 && regMemberCount > 0 && (
                      <div className="mt-3 pt-3 border-t border-white/10 flex items-center gap-1.5 text-xs text-white/70">
                        <Users size={12} />
                        {regMemberCount} {regMemberCount === 1 ? 'player' : 'players'}
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

      {/* Dev-only punch/hardware debug indicator - removed from production builds. */}
      {import.meta.env.DEV && (
        <CardDetectionAlert
          cardData={lastCardData}
          show={showCardAlert}
        />
      )}
      {punchAnimation && (
        <PunchAnimationOverlay
          data={punchAnimation}
          colorblind={config.colorblindMode}
          onDone={async () => {
            const wasGameOver = punchAnimation.gameOver ?? false;
            const teamName = punchAnimation.teamName ?? '';
            if (punchAnimation.endTimeToCommit != null && punchAnimation.teamId != null) {
              await updateTeam(punchAnimation.teamId, { end_time: punchAnimation.endTimeToCommit, score: punchAnimation.newScore });
            }
            // Full teardown (this overlay path drives its own timeline, so the
            // phase-machine exit effect may not run): reset to idle so the next
            // queued slot can start, then resolve this slot to advance the queue.
            punchAnimationRef.current = null;
            setPunchAnimation(null);
            setAnimPhase('idle');
            if (wasGameOver) { queue.clear(); setGameOverTeamName(teamName); }
            const resolveSlot = animResolveRef.current;
            animResolveRef.current = null;
            resolveSlot?.();
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
