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
import { applyTeamName, localizedStatus } from '../services/gameMessages';
import { tIngame } from '../i18n/ingame';
import type { GameMessageType } from '../services/gameMessages';
import {
  getLaunchedGameState,
  getLaunchedGameMeta,
  updateLaunchedGameMeta,
  recordPunch,
  updateTeam,
  deleteTeam,
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
import { useSimBus } from '../services/simBus';
import { MysteryGameRenderer, type MysteryScreen, type EnigmaStatusKind } from './MysteryGameRenderer';
import { MYSTERY_STATUS_COLORS } from './mysteryIngameLayout';
import { resolveMysteryBonuses } from '../services/mysteryBonuses';
import { wrongAnswerPoints } from '../services/mysteryScoring';
import { gameClock } from '../services/gameClock';
import '../mystery.css';

interface MysteryGamePageProps {
  config: GameConfig;
  gameUniqid: string;
  launchedGameId: number | null;
  onBack: () => void;
  onGameEnd?: () => void;
}

interface GameData {
  game: {
    id: string;
    uniqid: string;
    type: string;
    title: string;
  };
  game_meta: {
    title?: string;
    number_of_enigmas: string;
    font: string;
    font_color?: string;
    custom_fonts?: Array<{
      family?: string;
      faces?: Array<{ filename?: string; weight?: number; style?: string }>;
    }>;
    score_full_game: string;
    points_units?: string;
    // Signed maluses applied once per enigma in the matching outcome state
    // (default 0; negative = penalty, positive = bonus).
    malus_both_answers_biped?: string;
    malus_no_answer?: string;
    // Game-level images for the "both answers" / "no answer" enigma states.
    both_answers_image?: string;
    no_answer_image?: string;
    levels: Record<string, { points: string; name: string; description: string }>;
    // Bonus ("overscore") tiers - rewards unlocked by scoring ABOVE
    // score_full_game. Studio scenarios carry the array; legacy ones carry the
    // flat `overscore_step_N` / `name_overscore_step_N` / `image_overscore_step_N`
    // keys instead. `services/mysteryBonuses` reads both.
    overscores?: Array<{
      overscore_step?: string;
      overscore_score?: string;
      name_overscore_step?: string;
      image_overscore_step?: string;
    }>;
    gauge_filling: string;
    background_image: string;
    game_instructions_image: string;
    game_instructions_button_image: string;
    game_instructions_button_hover_image: string;
    time_background_image: string;
    game_refresh_button_image: string;
    game_refresh_button_hover_image: string;
    levels_gauge_image: string;
    levels_gauge_level_icon_image: string;
    levels_gauge_player_icon_image?: string;
    score_background_image: string;
    enigmas_header_image: string;
    team_name_background_image: string;
    steps_container_image?: string;
    overscore_steps?: string;
    main_enigma_image?: string;
  };
  game_enigmas: Array<{
    id: string;
    game_id: string;
    number: string;
    text: string;
    answer_type: string;
    good_answer?: string;
    good_answer_image: string;
    wrong_answer_image?: string;
    good_answer_points: string;
    wrong_answer_points?: string;
  }>;
  // Two disk shapes coexist:
  //   - legacy: an array of { image_number, sound_id } rows
  //   - current studio: an object keyed by sound role (e.g. `enigma_success`)
  //     whose values are media filenames
  game_sounds?:
    | Array<{
        id?: string;
        game_id?: string;
        image_number: string;
        sound_id: string;
      }>
    | Record<string, string>;
  // Per-language envelope synthesized by playground.php (LocalizedCompat). Lets
  // the per-team reveal render level name/description in the team's language;
  // falls back to the flattened (default-language) game_meta when absent.
  translations?: Record<string, {
    levels?: Record<string, { name?: string; description?: string }>;
    overscores?: Array<{ name_overscore_step?: string }>;
  }>;
}

/** Read a Localized<string> map (or plain string) at the given language. Returns
 *  '' when absent so callers can `.trim()` and fall back. */
function pickLocalized(v: unknown, lang: string): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const map = v as Record<string, string>;
    return map[lang] || Object.values(map)[0] || '';
  }
  return '';
}

export function MysteryGamePage({ config, gameUniqid, launchedGameId, onGameEnd }: MysteryGamePageProps) {
  // Operator-facing banners (test mode, reader unplugged) speak the app's
  // chrome language, not the players' launch language - they are addressed to
  // whoever is running the base station.
  const { t: tr } = useTranslation('rankings');
  const [gameData, setGameData] = useState<GameData | null>(null);
  const gameDataRef = useRef<GameData | null>(null);
  // Legacy single-player "endgame" screen - never entered in the per-team
  // base-station flow, kept wired so the renderer's endgame branch still
  // type-checks. The per-team reveal happens on the 'ingame' screen.
  const [gameEnded] = useState(false);
  const [score, setScore] = useState(0);
  // Mystery is event-driven on a shared base-station screen: a team starts on
  // its first bip and is scored on its second. There's no single "active" team
  // between bips, so we don't run a live clock. `resultDurationSec` holds the
  // finishing team's elapsed time (end − start) and is the ONLY thing that
  // makes the timer text appear - null = hidden (idle screen + during play).
  const [resultDurationSec, setResultDurationSec] = useState<number | null>(null);
  // The finishing team's name, shown in the right-column name card only while
  // its results are on screen (null = hidden). Replaces the old display of
  // `config.name` (the launched-game name), which we never want there.
  const [resultTeamName, setResultTeamName] = useState<string | null>(null);
  // The finishing team's display language, used to render the reveal's level
  // name/description (and any team-facing text) in that team's language. Empty
  // ⇒ fall back to the launch language. Set on the finishing bip, cleared on reset.
  const [resultLanguage, setResultLanguage] = useState('');
  // Holding-vs-reveal gate. The in-game board is hidden until a team's second
  // bip plays the reveal. `revealStarted` true = the board is shown and the
  // tally animation is running/done. Until then the board stays hidden (idle
  // layout / background) and the reveal fires automatically on the finishing bip.
  const [revealStarted, setRevealStarted] = useState(false);
  // End-of-run summary shown in the centre column (in place of the big enigma
  // image) once a reveal has finished - or instantly, with no animation, when a
  // finished team's card is bipped again. Holds the final score / level / team
  // name; cleared on reset or when a newer reveal starts.
  const [summary, setSummary] = useState<{
    teamName: string;
    finalScoreText: string;
    levelName?: string;
    levelDescription?: string;
    note?: string;
  } | null>(null);
  // Per-card snapshot of the punches already on a card at its first bip (keyed
  // by card id; value = `${code}@${time}` for each punch whose time isn't
  // 00:00:00). If the operator forgets to wipe a card, these stale punches must
  // not count toward the run, so we subtract them at scoring time. In-memory
  // only: a base-station display stays open across a team's two bips, so this
  // doesn't need to survive an app reload.
  const preExistingPunchesRef = useRef<Map<number, Set<string>>>(new Map());
  // Punches read by THIS device's USB reader are processed immediately in
  // saveCardData; the 1s state poll then echoes those same raw_data rows back
  // (the server returns every row since the cursor, with no own-device filter).
  // Track the row ids we've already handled locally so the poll skips them -
  // otherwise each own-reader bip runs twice (now + ~1s later), which would
  // start AND finish a mystery team on its very first bip.
  const processedRawIdsRef = useRef<Set<number>>(new Set());
  const [completedEnigmas, setCompletedEnigmas] = useState<Set<number>>(new Set());
  // Reveal-animation overlay colours keyed by `enigma.number`. The end-of-
  // game tally walks each enigma, sets a colour here for instant feedback,
  // then adds the enigma to `completedEnigmas` to unblur the image.
  const [enigmaStatusColors, setEnigmaStatusColors] = useState<Record<string, string>>({});
  // Parallel to `enigmaStatusColors`: the semantic result per enigma. Feeds the
  // renderer's colour-blind status marks (✓ / ✗ / both-biped).
  const [enigmaStatusKinds, setEnigmaStatusKinds] = useState<Record<string, EnigmaStatusKind>>({});
  // Which enigma to feature in the centre column. Defaults to the first
  // uncompleted enigma; the reveal animation overrides it to walk through
  // every enigma as it tallies the score.
  const [revealEnigmaNumber, setRevealEnigmaNumber] = useState<string | null>(null);
  const [lastCardData, setLastCardData] = useState<CardData | null>(null);
  // Stations reported by the reader are logged (see setStationsDetectedCallback)
  // but not otherwise consumed by this page.
  const [showCardAlert, setShowCardAlert] = useState(false);
  const [gameMessage, setGameMessage] = useState('');
  const [gameMessageType, setGameMessageType] = useState<GameMessageType>('info');
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Serialises on-screen presentations. Game messages AND the reveal animation
  // share this one queue, so a new message/animation only starts once the
  // previous one has fully finished - never overlapping. The labels of the
  // not-yet-started items feed the bottom waiting-teams line.
  const queue = usePresentationQueue();
  // Stops the sounds when the page is left mid-reveal (quit / rankings).
  const playAudio = useGameSounds();
  // Monotonic id of the reveal currently playing. A previous run's pending
  // auto-reset timer checks this before resetting, so it no-ops once a newer
  // reveal has started - otherwise that stale timer wipes the new animation's
  // board mid-play (the visuals vanish while the loop keeps firing sounds).
  const revealRunIdRef = useRef(0);
  // Held while a finished team's results board is on screen. Its `resolve` keeps
  // the presentation-queue slot open so the NEXT team/message can't appear over
  // the current player's summary - until the page is reset (auto timer or the
  // operator's reset button). `runId` ties the held slot to the reveal that
  // owns it, so a stale auto-reset timer never releases a newer team's board.
  const pendingResetRef = useRef<{ runId: number; resolve: () => void } | null>(null);
  // Nothing sets this anymore (legacy loading overlay at the bottom of the
  // page keys off it); kept as a constant rather than deleting the overlay.
  const [showLoading] = useState(false);
  // Loaded scenario audio keyed by sound role (e.g. 'enigma_success'). A ref,
  // not state, because `playSound` is reached through the bip handlers'
  // closures (USB callback set at mount, handleNewBip's useCallback) which are
  // created BEFORE the async audio load finishes - a state value would be
  // captured empty there and the reveal would play no sound.
  const audioElementsRef = useRef<Record<string, HTMLAudioElement>>({});
  // Pending starts, one queue per overlay, keyed by team. Self-register prompt
  // first (when enabled): `finalize(name)` persists the name + proceeds to the
  // videos/start; `abort()` cancels the start (and deletes the team if that bip
  // created it). Then the first-bip videos: start_time + the start message
  // fire only after all of that team's videos have played.
  const pendingStarts = usePendingStarts();
  const { selfReg, videoStart } = pendingStarts;
  // Banner shown when the SportIdent reader isn't plugged in - the game
  // page autobinds via 'reader:status' once detection flips.
  const detectedReader = useDetectedReaderPort();

  useEffect(() => {
    const loadGameData = async () => {
      try {
        const scenarioRow = await scenarioStore.get(gameUniqid);
        const raw = (await scenarioStore.getGameData(gameUniqid)) as any;
        if (!raw) {
          console.error('No game-data.json on disk for', gameUniqid);
          return;
        }

        // Three disk shapes coexist; normalise them all into `GameData`:
        //   1. legacy envelope:  { scenario, game_data: { game_meta, game_enigmas, game_sounds[] } }
        //   2. flattened legacy: { game, game_meta, game_enigmas, game_sounds[] }
        //   3. current studio:   { game_meta, game_enigmas, game_sounds{}, translations, ... }
        //                        (no `game` wrapper; game_sounds is role-keyed object)
        // Shape 3 has no `game.title`, so build the header from the SQLite row /
        // game_meta instead of trusting a wrapper that may not exist.
        const inner = raw.game_data ?? raw;
        const gameMeta = inner.game_meta || {};
        const data: GameData = {
          game: {
            id: String(raw.scenario?.id ?? raw.game?.id ?? gameUniqid),
            uniqid: gameUniqid,
            type: raw.scenario?.scenario_type ?? raw.game?.type ?? scenarioRow?.game_type ?? 'mystery',
            title: raw.game?.title ?? raw.scenario?.name ?? gameMeta.title ?? scenarioRow?.title ?? '',
          },
          game_meta: gameMeta,
          game_enigmas: inner.game_enigmas || [],
          game_sounds: inner.game_sounds,
          // Keep the per-language envelope so the per-team reveal can localize
          // level name/description (playground.php ships it; we used to drop it).
          translations: inner.translations,
        };

        setGameData(data);
        gameDataRef.current = data;
        // Register the scenario's uploaded custom fonts so a Typography
        // selection that points at one renders (offline-safe).
        void registerScenarioFonts(gameUniqid, data.game_meta?.custom_fonts);

        // `playSound(role)` looks up by role name (e.g. 'enigma_success'). Build
        // that map from whichever shape is on disk:
        //   - array : key by `image_number`, url from `sound_id`
        //   - object: key by role, url from the filename value
        const sounds = data.game_sounds;
        if (sounds) {
          const loadedAudio: Record<string, HTMLAudioElement> = {};
          if (Array.isArray(sounds)) {
            for (const soundData of sounds) {
              if (!soundData?.sound_id) continue;
              loadedAudio[soundData.image_number] = new Audio(
                scenarioAssetUrl(gameUniqid, soundData.sound_id)
              );
            }
          } else {
            for (const [role, file] of Object.entries(sounds)) {
              if (!file || typeof file !== 'string') continue;
              loadedAudio[role] = new Audio(scenarioAssetUrl(gameUniqid, file));
            }
          }
          audioElementsRef.current = loadedAudio;
        }
      } catch (error) {
        console.error('Error loading game data:', error);
      }
    };

    loadGameData();
  }, [gameUniqid]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const playSound = (soundName: string) => {
    playAudio(audioElementsRef.current[soundName]).catch(err => console.error('Error playing sound:', err));
  };

  // Resolve one of the scenario's authored "UI text strings" (game_meta.text_*)
  // at the given (team) language. Returns '' when the string is empty/absent so
  // callers can decide whether to show a message or keep the built-in default.
  const resolveMetaText = (key: string, lang?: string, teamName?: string | null): string => {
    const meta = gameDataRef.current?.game_meta as Record<string, unknown> | undefined;
    if (!meta) return '';
    const raw = pickLocalized(meta[key], lang || config.language || '').trim();
    // Authored strings may embed `%team%` to position the team name inside the
    // sentence - substitute it (stripped when no team is in context).
    return applyTeamName(raw, teamName);
  };

  // Format a score the same way the endgame line does: a percentage when the
  // scenario uses percentage units, else "score / full".
  const formatScore = (s: number): string => {
    const meta = gameDataRef.current?.game_meta;
    if (!meta) return `${Math.round(s)}`;
    return meta.points_units === 'percentage'
      ? `${Math.round(s)}%`
      : `${Math.round(s)}`;
  };

  // Highest level whose points threshold is ≤ `scoreValue`, localized to `lang`.
  // Mirrors the render-time `reachedLevel` computation but for an arbitrary
  // score/language (used to build the end-of-run summary).
  const reachedLevelFor = (
    scoreValue: number,
    lang: string,
  ): { name: string; description: string } | null => {
    const data = gameDataRef.current;
    if (!data) return null;
    const levels = data.game_meta.levels ?? {};
    const localizedLevels = lang ? data.translations?.[lang]?.levels : undefined;
    let bestKey: string | null = null;
    let bestPts = -Infinity;
    for (const [key, lvl] of Object.entries(levels)) {
      const pts = parseFloat(lvl?.points ?? '0') || 0;
      if (pts <= scoreValue && pts > bestPts) {
        bestKey = key;
        bestPts = pts;
      }
    }
    if (bestKey === null) return null;
    const flat = levels[bestKey];
    const loc = localizedLevels?.[bestKey];
    return {
      name: loc?.name ?? flat?.name ?? '',
      description: loc?.description ?? flat?.description ?? '',
    };
  };

  // Per-enigma reveal outcome (id + semantic result + signed points). Shared by
  // the animated reveal and the no-animation final-state render.
  type EnigmaReveal = { enigma_id: string; result: EnigmaStatusKind; points: number };

  // Score a card against the pattern's enigmas, dropping punches that were on the
  // card at the first bip (baseline). Pure given the baseline ref - used by both
  // the finishing-bip reveal and the finished-card re-bip (which has no baseline,
  // so it scores every punch the same way the original finish did).
  const scoreCardEnigmas = (
    card: CardData,
    data: GameData,
    patternEnigmas: patternStore.PatternEnigma[],
  ): { enigmaResults: EnigmaReveal[]; totalScore: number } => {
    const baseline = preExistingPunchesRef.current.get(card.id) ?? new Set<string>();
    const livePunches = card.punches.filter((p) => !baseline.has(`${p.code}@${p.time}`));
    const cardPunchCodes = livePunches.map((p) => p.code.toString());
    // Game-level signed maluses (default 0; negative = penalty, positive = bonus),
    // applied once per enigma in the matching outcome state.
    const bothMalus = parseInt(data.game_meta.malus_both_answers_biped || '0') || 0;
    const noAnswerMalus = parseInt(data.game_meta.malus_no_answer || '0') || 0;
    let totalScore = 0;
    const enigmaResults = patternEnigmas.map((enigma) => {
      const gameEnigma = data.game_enigmas.find((ge) => ge.number === enigma.enigma_id);
      const goodPoints = parseInt(gameEnigma?.good_answer_points || '0');
      // Signed, like the maluses above (a legacy positive magnitude folds to its
      // negative) - so this is ADDED, never subtracted.
      const wrongPoints = wrongAnswerPoints(gameEnigma?.wrong_answer_points);
      const hasGoodAnswer = enigma.good_answers.some((a) => cardPunchCodes.includes(a));
      const hasWrongAnswer = enigma.wrong_answers.some((a) => cardPunchCodes.includes(a));
      let result: EnigmaStatusKind;
      let points = 0;
      if (hasGoodAnswer && hasWrongAnswer) {
        result = 'both_answers';
        points = bothMalus;
        totalScore += bothMalus;
      } else if (hasGoodAnswer) {
        result = 'correct';
        points = goodPoints;
        totalScore += goodPoints;
      } else if (hasWrongAnswer) {
        result = 'incorrect';
        points = wrongPoints;
        totalScore += wrongPoints;
      } else {
        result = 'no_answer';
        points = noAnswerMalus;
        totalScore += noAnswerMalus;
      }
      return { enigma_id: enigma.enigma_id, result, points };
    });
    return { enigmaResults, totalScore };
  };

  // Map the Team-Details override vocabulary (found / wrong / not_found / both)
  // onto the renderer's status kinds. The Team Details modal persists per-enigma
  // overrides in this vocabulary; the board renders the kinds below.
  const OVERRIDE_TO_KIND: Record<string, EnigmaStatusKind> = {
    found: 'correct',
    wrong: 'incorrect',
    not_found: 'no_answer',
    both: 'both_answers',
  };

  // Per-team enigma status overrides set in the Team Details modal, stored in
  // launched-game meta under `enigma_overrides` = { "<teamId>": { "<enigmaId>": status } }.
  // Returned already mapped to the renderer's status kinds so the finished-card
  // re-bip can show the operator-corrected statuses (not the raw card scoring).
  const readEnigmaOverridesForTeam = async (
    teamId: number,
  ): Promise<Record<string, EnigmaStatusKind>> => {
    if (!launchedGameId) return {};
    try {
      const meta = await getLaunchedGameMeta(launchedGameId);
      const all = JSON.parse(meta.enigma_overrides || '{}');
      const forTeam = all?.[String(teamId)];
      if (!forTeam || typeof forTeam !== 'object') return {};
      const out: Record<string, EnigmaStatusKind> = {};
      for (const [enigmaId, status] of Object.entries(forTeam)) {
        const kind = OVERRIDE_TO_KIND[String(status)];
        if (kind) out[enigmaId] = kind;
      }
      return out;
    } catch {
      return {};
    }
  };

  // Reveal-overlay colour for a semantic enigma result. Shared with the studio
  // preview so an author tuning the result sub-frame sees the board's colours.
  const enigmaResultColor = (result: EnigmaStatusKind): string => MYSTERY_STATUS_COLORS[result];

  // Late-malus points for a run of `durationSec`: `malusPerMinute` × each started
  // minute past the launch time limit (`config.duration`, minutes). 0 when no
  // malus is configured, no limit is set, or the run finished on time.
  const lateMalusForDuration = (durationSec: number): number => {
    const perMin = config.malusPerMinute ?? 0;
    const limitSec = (config.duration ?? 0) * 60;
    if (perMin <= 0 || limitSec <= 0 || durationSec <= limitSec) return 0;
    return Math.ceil((durationSec - limitSec) / 60) * perMin;
  };

  // Persist the auto-computed late malus for a finished team into launched-game
  // meta (read-modify-write the single `late_malus` JSON map) so the Team Details
  // modal can show it and offer a per-team override. Best-effort.
  const persistLateMalus = async (teamId: number, malus: number) => {
    try {
      const meta = await getLaunchedGameMeta(launchedGameId!);
      let map: Record<string, number>;
      try {
        map = JSON.parse(meta.late_malus || '{}');
        if (!map || typeof map !== 'object') map = {};
      } catch {
        map = {};
      }
      map[String(teamId)] = malus;
      await updateLaunchedGameMeta(launchedGameId!, { ...meta, late_malus: JSON.stringify(map) });
    } catch (err) {
      console.error('Error persisting late malus:', err);
    }
  };

  // Team Details' "count the punches already on the card" switch, stored in
  // launched-game meta as `stale_punches_allowed` = { "<teamId>": true }.
  const staleCardPunchesAllowed = async (teamId: number): Promise<boolean> => {
    try {
      const meta = await getLaunchedGameMeta(launchedGameId!);
      const map = JSON.parse(meta.stale_punches_allowed || '{}');
      return map?.[String(teamId)] === true;
    } catch {
      return false;
    }
  };

  // Re-display a finished team's result board in its FINAL state, instantly and
  // without the walk animation (a finished card's 3rd+ bip). The per-enigma cell
  // colours are recomputed from the card for the visuals, but the score shown is
  // the team's PERSISTED score (which already folds in the late malus and any
  // Team-Details overrides) so it matches the original reveal.
  const showFinishedTeamFinalState = async (
    finishedTeam: {
      id: number;
      team_name?: string | null;
      language?: string | null;
      start_time: number | null;
      end_time: number | null;
      score?: number;
    },
    card: CardData,
    note?: string,
    // Optional transient banner flashed over the re-displayed board (e.g. the
    // scenario's "team ended" string), shown inside the held slot so it appears
    // with the final board rather than after the page is reset.
    banner?: { text: string; type?: GameMessageType },
  ) => {
    const data = gameDataRef.current;
    if (!data) return;
    const patternEnigmas = await patternStore.getMysteryEnigmas(config.pattern);
    const { enigmaResults, totalScore } = scoreCardEnigmas(card, data, patternEnigmas);
    // Apply the operator's per-enigma status corrections (Team Details modal) so
    // the recap statuses match the persisted, override-applied score below -
    // otherwise the board would show the raw card scoring and disagree with it.
    const statusOverrides = await readEnigmaOverridesForTeam(finishedTeam.id);
    const duration =
      finishedTeam.end_time != null && finishedTeam.start_time != null
        ? finishedTeam.end_time - finishedTeam.start_time
        : 0;
    // Prefer the persisted score; fall back to a fresh recompute (− late malus)
    // for legacy rows finished before scores were stored.
    const finalScore =
      typeof finishedTeam.score === 'number'
        ? finishedTeam.score
        : totalScore - lateMalusForDuration(duration);
    const lang = finishedTeam.language ?? config.language ?? '';
    const teamName = finishedTeam.team_name ?? '';

    await queue.enqueue(teamName, async () => {
      // Claim this as the current run so any prior auto-reset timer no-ops.
      const myRunId = ++revealRunIdRef.current;
      setSummary(null);
      setRevealStarted(true);
      setResultDurationSec(duration);
      setResultTeamName(teamName);
      setResultLanguage(lang);

      const colors: Record<string, string> = {};
      const kinds: Record<string, EnigmaStatusKind> = {};
      const completed = new Set<number>();
      for (const r of enigmaResults) {
        const effective = statusOverrides[r.enigma_id] ?? r.result;
        colors[r.enigma_id] = enigmaResultColor(effective);
        kinds[r.enigma_id] = effective;
        completed.add(parseInt(r.enigma_id, 10));
      }
      setEnigmaStatusColors(colors);
      setEnigmaStatusKinds(kinds);
      setCompletedEnigmas(completed);
      setRevealEnigmaNumber(null);
      setScore(finalScore);

      const level = reachedLevelFor(finalScore, lang);
      setSummary({
        teamName,
        finalScoreText: formatScore(finalScore),
        levelName: level?.name || undefined,
        levelDescription: level?.description || undefined,
        note: note || undefined,
      });

      // Flash the optional banner (e.g. "team ended") over the board first.
      if (banner?.text) await displayMessage(banner.text, banner.type ?? 'info');

      // Keep this slot (and thus the next team/message) on hold until the
      // operator resets the page (or auto-reset fires) - the re-displayed
      // final board must not be overwritten by the next bip's presentation.
      await waitForReset(myRunId);
    });
  };

  // Low-level message presentation: show the banner (+ optional sound) and
  // resolve once it has been on screen for the full display duration. NOT
  // queued - used directly inside an already-running queue slot (the reveal's
  // result banner) where re-entering the queue would deadlock.
  const displayMessage = (
    message: string,
    type: GameMessageType = 'info',
    sound?: string,
  ): Promise<void> =>
    new Promise<void>((resolve) => {
      setGameMessage(message);
      setGameMessageType(type);
      if (sound) playSound(sound);
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
      msgTimerRef.current = setTimeout(() => {
        setGameMessage('');
        msgTimerRef.current = null;
        resolve();
      }, config.messageDisplayDuration * 1000);
    });

  // Public message API: serialise behind any in-flight message/animation so it
  // only appears once the previous one is over. Fire-and-forget at call sites
  // (the enqueue happens synchronously, preserving order). `label` is the team
  // name shown in the waiting line while this message is deferred (null for
  // team-agnostic messages like "card not registered").
  const showMessage = (
    message: string,
    type: GameMessageType = 'info',
    sound?: string,
    label: string | null = null,
  ): void => {
    queue.enqueue(label, () => displayMessage(message, type, sound));
  };

  const saveCardData = async (card: CardData) => {
    if (!launchedGameId) {
      console.warn('Cannot save card data: launchedGameId not available');
      return;
    }

    if (!gameDataRef.current) {
      console.warn('Game data not loaded yet, waiting...');
      const maxWaitTime = 5000;
      const waitInterval = 100;
      let waitedTime = 0;

      while (!gameDataRef.current && waitedTime < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, waitInterval));
        waitedTime += waitInterval;
      }

      if (!gameDataRef.current) {
        console.error('Game data still not loaded after waiting');
        return;
      }
    }

    try {
      const rawDataJson = JSON.parse(JSON.stringify(card));
      // Server resolves device_id from the JWT. Remember the row id we just
      // created so the state poll's echo of it is ignored (see handleNewBip).
      const { id } = await recordPunch(launchedGameId, rawDataJson);
      if (typeof id === 'number') processedRawIdsRef.current.add(id);
      await handleCardPunchLogic(card);
    } catch (error) {
      console.error('Error saving card data:', error);
    }
  };

  // Always dispatch punches to the LATEST saveCardData without re-binding the
  // reader. The reader effect binds once per launched game (see below); binding
  // the callback to the mount-time `saveCardData` closure captured a stale
  // `launchedGameId` on the JOIN path (device joins a game launched elsewhere),
  // so every punch hit the `!launchedGameId` guard and was silently dropped.
  // Mirror Tracks/Clash: bind once per game, call through a ref.
  const saveCardDataRef = useRef(saveCardData);
  useEffect(() => {
    saveCardDataRef.current = saveCardData;
  });

  // Return the display to the ready 'ingame' screen without a page reload.
  // Triggered by "Auto-reset page" after a run's results have shown.
  const resetToReady = () => {
    setScore(0);
    setResultDurationSec(null);
    setResultTeamName(null);
    setResultLanguage('');
    setRevealStarted(false);
    setSummary(null);
    setCompletedEnigmas(new Set());
    setEnigmaStatusColors({});
    setEnigmaStatusKinds({});
    setRevealEnigmaNumber(null);
    setGameMessage('');
    setShowCardAlert(false);
    // Release the presentation queue: the results board is gone, so the next
    // waiting team/message may now appear. No-op when nothing was holding.
    const pending = pendingResetRef.current;
    if (pending) {
      pendingResetRef.current = null;
      pending.resolve();
    }
  };

  // Hold the current presentation-queue slot open until the results board is
  // reset - manually (the summary's reset button → resetToReady) or, when
  // "Auto-reset page" is on, automatically after `delayBeforeReset`. This is
  // what keeps the next player's "C'est parti" / reveal from appearing over the
  // previous player's summary. `myRunId` guards the auto timer so a stale run's
  // timer never wipes a newer team's board (and never blocks the queue forever).
  const waitForReset = (myRunId: number): Promise<void> =>
    new Promise<void>((resolve) => {
      pendingResetRef.current = { runId: myRunId, resolve };
      if (config.autoResetTeam) {
        setTimeout(() => {
          if (revealRunIdRef.current === myRunId) resetToReady();
        }, (config.delayBeforeReset || 0) * 1000);
      }
    });

  const handleCardPunchLogic = async (card: CardData) => {
    if (!launchedGameId) return;

    const currentGameData = gameDataRef.current;
    if (!currentGameData) {
      console.error('Game data not loaded yet');
      return;
    }

    try {
      // Resolve the team for this card per the auto-register / reuse rule:
      // an active run is the team for this card with no end_time. If none,
      // create one (auto-register for a never-seen card; reuse for a finished
      // card past its cooldown), else ignore the bip.
      const state = await getLaunchedGameState(launchedGameId, 0);
      const teamsForCard = state.teams.filter((t) => t.key_id === card.id);
      let team = teamsForCard.find((t) => t.end_time == null) ?? null;
      // True when *this* bip created the team - drives the self-register abort
      // cleanup (delete a just-created team, never a rostered one).
      let createdNow = false;

      if (!team) {
        const finished = teamsForCard.length > 0;
        if (!finished) {
          if (!config.autoRegisterTeam && !config.selfRegisterTeam) {
            console.warn('No team for card (dynamic team modes off):', card.id);
            // Bipped card belongs to no team and dynamic registration is off:
            // show the scenario's "card not corresponding" UI string if authored.
            const msg = resolveMetaText('text_card_not_corresponding');
            if (msg) showMessage(msg, 'warning');
            return;
          }
          team = await ensureTeamForCard(launchedGameId, card.id, state, !!config.useNamePool);
          if (!team) {
            showMessage(localizedStatus('card_not_registered', config.language || ''), 'warning');
            return;
          }
          createdNow = true;
        } else {
          if (!config.reuseCards) {
            // A finished card bipped again (no reuse): re-display the finished
            // team's final result board WITHOUT replaying the walk animation,
            // and flash the "team ended" UI string if authored.
            const finishedTeam = teamsForCard.reduce((a, b) =>
              (b.end_time ?? 0) > (a.end_time ?? 0) ? b : a,
            );
            const ended = resolveMetaText('text_team_ended', finishedTeam.language ?? '', finishedTeam.team_name ?? null);
            await showFinishedTeamFinalState(
              finishedTeam,
              card,
              undefined,
              ended ? { text: ended, type: 'info' } : undefined,
            );
            return;
          }
          const lastEnd = Math.max(...teamsForCard.map((t) => t.end_time ?? 0));
          const cooldownSec = (config.reuseDelayMinutes ?? 5) * 60;
          if (gameClock.now() / 1000 < lastEnd + cooldownSec) {
            // Reuse is on but this card is still cooling down (3rd+ bip): re-show
            // the finished team's results board WITHOUT replaying the walk, and
            // carry the cooldown notice as a small footnote at the bottom.
            const remainingMin = Math.max(1, Math.ceil((lastEnd + cooldownSec - gameClock.now() / 1000) / 60));
            const cooldownNote = `Ce doigt sera remis en jeu dans ${remainingMin} minute${remainingMin > 1 ? 's' : ''}`;
            const finishedTeam = teamsForCard.reduce((a, b) =>
              (b.end_time ?? 0) > (a.end_time ?? 0) ? b : a,
            );
            await showFinishedTeamFinalState(finishedTeam, card, cooldownNote);
            return;
          }
          team = await ensureTeamForCard(launchedGameId, card.id, state, !!config.useNamePool);
          if (!team) return;
          createdNow = true;
        }
      }
      const teamName = team.team_name ?? '';

      if (!team.start_time) {
        // This team's start is already on its way (name prompt or videos
        // queued/showing): a repeat bip must not open a second one - it only
        // brings the team's own name prompt back on screen.
        if (!pendingStarts.claim(team.id)) {
          if (!pendingStarts.raiseSelfReg(team.id)) console.log('Start already pending for team', team.id, '- bip ignored');
          return;
        }
        const startTeamId = team.id;
        // The start sequence, parameterised by the effective team name: persist
        // a self-registered rename, then gate the clock on any first-bip videos.
        // Runs directly when self-register is off, or from the overlay's submit.
        const proceedAfterName = async (effectiveName: string, teamLanguage?: string) => {
          // The team's effective display language: the player's overlay pick, else
          // the launch language. Drives in-game text + first-bip video track.
          const effLang = teamLanguage || config.language;
          if ((effectiveName && effectiveName !== teamName) || teamLanguage) {
            try {
              await updateTeam(team.id, {
                ...(effectiveName && effectiveName !== teamName ? { team_name: effectiveName } : {}),
                ...(teamLanguage ? { language: teamLanguage } : {}),
              });
            } catch (err) {
              console.error('Error saving self-registered name/language:', err);
            }
          }

          const finalizeStart = async () => {
            const startTime = Math.floor(gameClock.now() / 1000);
            try {
              await updateTeam(team.id, { start_time: startTime });
              console.log('✓ Team started:', effectiveName);

              // A fresh run wants an empty card. Punches with a real time
              // (not the 00:00:00 placeholder) mean the card wasn't wiped.
              // Snapshot them as `${code}@${time}` so scoring can subtract
              // them at the second bip - the operator gets a heads-up but the
              // run still starts (we just won't count the stale punches).
              const stalePunches = (card.punches ?? []).filter(
                (p) => p.time && p.time !== '00:00:00'
              );
              if (stalePunches.length > 0) {
                preExistingPunchesRef.current.set(
                  card.id,
                  new Set(stalePunches.map((p) => `${p.code}@${p.time}`))
                );
                console.warn(
                  `⚠️  Card ${card.id} not empty at start: ${stalePunches.length} pre-existing punch(es) will be ignored`,
                  stalePunches
                );
              } else {
                preExistingPunchesRef.current.delete(card.id);
              }

              // Start message: prefer the scenario's authored UI strings (resolved
              // in the team's language), falling back to the built-in French text.
              // When the card wasn't empty, the "team starts card not empty"
              // string (or the default warning suffix) is shown instead.
              const startLang = teamLanguage || config.language || '';
              const cardNotEmpty = stalePunches.length > 0;
              const playerStartsTxt = resolveMetaText('text_player_starts', startLang, effectiveName);
              const cardNotEmptyTxt = resolveMetaText('text_team_starts_card_not_empty', startLang, effectiveName);
              let startMessage: string;
              if (cardNotEmpty) {
                startMessage = cardNotEmptyTxt
                  ? cardNotEmptyTxt
                  : tIngame('ingame_mystery', 'player_starts_card_not_empty', startLang, { team: effectiveName });
              } else {
                startMessage = playerStartsTxt
                  ? playerStartsTxt
                  : tIngame('ingame_mystery', 'player_starts', startLang, { team: effectiveName });
              }
              showMessage(startMessage, cardNotEmpty ? 'warning' : 'success', 'game_start', effectiveName);
            } catch (err) {
              console.error('Error updating team start time:', err);
            } finally {
              pendingStarts.release(startTeamId);
            }
          };

          // Decide whether to gate the start on the first-bip video overlay.
          // We only resolve videos here (not at mount) so a launch with both
          // toggles off skips the whole code path. A resolve failure starts the
          // team without videos rather than leaving its start stuck.
          const wantsVideos = !!(config.playTutorialOnBip || config.playIntroOnBip);
          if (wantsVideos) {
            try {
              const gameTypeCode = (currentGameData.game?.type || 'mystery').toLowerCase();
              const rawForResolve = await scenarioStore.getGameData(gameUniqid);
              const videos = await resolveFirstBipVideos(
                { ...config, language: effLang },
                gameUniqid,
                gameTypeCode,
                rawForResolve
              );
              if (videos.length > 0) {
                pendingStarts.enqueueVideoStart({ teamId: startTeamId, videos, finalize: finalizeStart });
                return;
              }
            } catch (err) {
              console.error('Error resolving first-bip videos:', err);
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
                  console.error('Error deleting team on self-register abort:', err);
                }
              }
            },
          });
          return;
        }

        await proceedAfterName(teamName);
      } else if (!team.end_time) {
        const endTime = Math.floor(gameClock.now() / 1000);
        const duration = endTime - team.start_time;

        // The operator may have chosen (Team Details) to count the punches that
        // were already on the card at the start bip - e.g. a player who played
        // before bipping in. Drop the baseline so they score like live punches.
        if (await staleCardPunchesAllowed(team.id)) {
          preExistingPunchesRef.current.delete(card.id);
        }

        const patternEnigmas = await patternStore.getMysteryEnigmas(config.pattern);
        const { enigmaResults, totalScore: enigmaTotal } = scoreCardEnigmas(card, currentGameData, patternEnigmas);

        // Late malus: subtract the configured per-minute penalty for every minute
        // past the launch time limit. The persisted score includes it.
        const lateMalus = lateMalusForDuration(duration);
        const totalScore = enigmaTotal - lateMalus;
        const finishLang = team.language ?? config.language ?? '';
        // Did the team bip any answers this run? Drives the "card empty" notice
        // (mirrors the baseline subtraction scoreCardEnigmas applies).
        const baseline = preExistingPunchesRef.current.get(card.id) ?? new Set<string>();
        const livePunchCount = card.punches.filter(p => !baseline.has(`${p.code}@${p.time}`)).length;

        // An empty card never closes a run (retours #84 and sept #60). In "Départ
        // groupé" a card bipped by accident before the group leaves lands straight
        // here; in a normal start a player who rebips right after the first bip
        // does too. Either way scoring it would burn the reveal on 12 grey
        // enigmas. The bip only shows the warning, however many times it's
        // repeated - a team that genuinely came back with nothing is closed by
        // the operator (Team Details / game end), not by a bip.
        if (livePunchCount === 0) {
          const authored = resolveMetaText('text_card_empty', finishLang, teamName);
          showMessage(
            authored || `${teamName} : puce vide, aucune balise n'a été bipée.`,
            'warning',
            undefined,
            teamName,
          );
          return;
        }

        let updateOk = true;
        try {
          await updateTeam(team.id, { end_time: endTime, score: totalScore });
        } catch (err) {
          console.error('Error updating team end time:', err);
          updateOk = false;
        }
        if (updateOk) {
          // The run is scored; drop the card's start-time baseline so a later
          // reuse of the same card starts clean.
          preExistingPunchesRef.current.delete(card.id);
          // Persist the auto late malus so the Team Details modal can show + override it.
          if (lateMalus > 0) void persistLateMalus(team.id, lateMalus);

          // Play the reveal: show the board (the finishing team's name +
          // elapsed time), start from a hidden/zeroed state, then walk each
          // enigma flashing its result colour and tallying the score.
          const runReveal = async () => {
            // Claim this as the current reveal run; the auto-reset timer below
            // captures it so a previous run's reset can't wipe this board.
            const myRunId = ++revealRunIdRef.current;
            setSummary(null);
            setRevealStarted(true);
            setResultDurationSec(duration);
            setResultTeamName(teamName);
            setResultLanguage(finishLang);
            setScore(0);
            setCompletedEnigmas(new Set());
            setEnigmaStatusColors({});
            setEnigmaStatusKinds({});
            setRevealEnigmaNumber(null);

            // "No animation": the final board appears at once - no notices, no
            // tally walk, no end sound. Nothing below awaits on this path, so the
            // whole board + summary lands in a single render.
            const noAnimation = !!config.noRevealAnimation;

            // Card-empty / late-malus notices (authored UI strings, if any) shown
            // before the walk so the operator sees why the run scored as it did.
            if (!noAnimation) {
              const cardEmptyTxt = livePunchCount === 0 ? resolveMetaText('text_card_empty', finishLang, teamName) : '';
              if (cardEmptyTxt) await displayMessage(cardEmptyTxt, 'warning');
              const lateMalusTxt = lateMalus > 0 ? resolveMetaText('text_late_malus', finishLang, teamName) : '';
              if (lateMalusTxt) await displayMessage(lateMalusTxt, 'warning');
            }

            let currentScore = 0;
            if (noAnimation) {
              // Paint every enigma's result and the full tally in one go (same
              // totals as the walk below).
              const colors: Record<string, string> = {};
              const kinds: Record<string, EnigmaStatusKind> = {};
              const completed = new Set<number>();
              for (const enigmaResult of enigmaResults) {
                if (!currentGameData.game_enigmas.some(ge => ge.number === enigmaResult.enigma_id)) continue;
                colors[enigmaResult.enigma_id] = enigmaResultColor(enigmaResult.result);
                kinds[enigmaResult.enigma_id] = enigmaResult.result;
                completed.add(parseInt(enigmaResult.enigma_id, 10));
                currentScore += enigmaResult.points;
              }
              setEnigmaStatusColors(colors);
              setEnigmaStatusKinds(kinds);
              setCompletedEnigmas(completed);
              setScore(currentScore);
            } else {
              // The board elements (team name, timer, blurred enigmas, gauge) are
              // now on screen - hold a 1s beat before the tally walk begins.
              await new Promise(resolve => setTimeout(resolve, 1000));

              for (const enigmaResult of enigmaResults) {
                const gameEnigma = currentGameData.game_enigmas.find(ge => ge.number === enigmaResult.enigma_id);
                if (!gameEnigma) continue;

                const backgroundColor = enigmaResultColor(enigmaResult.result);
                playSound(
                  enigmaResult.result === 'correct'
                    ? 'enigma_success'
                    : enigmaResult.result === 'no_answer'
                      ? 'enigma_no_answer'
                      : 'enigma_error',
                );

                setRevealEnigmaNumber(enigmaResult.enigma_id);
                setEnigmaStatusColors(prev => ({ ...prev, [enigmaResult.enigma_id]: backgroundColor }));
                setEnigmaStatusKinds(prev => ({ ...prev, [enigmaResult.enigma_id]: enigmaResult.result }));
                setCompletedEnigmas(prev => {
                  const next = new Set(prev);
                  next.add(parseInt(enigmaResult.enigma_id, 10));
                  return next;
                });

                currentScore += enigmaResult.points;
                setScore(currentScore);

                // How long each enigma image is held during the reveal walk. The
                // launch "Enigma Image Display Duration" wins when set; otherwise
                // fall back to the scenario's authored animation_enigma_duration,
                // then 1s.
                const scenarioStepSec = parseInt(
                  (currentGameData.game_meta as unknown as { animation_enigma_duration?: string }).animation_enigma_duration || '1',
                  10,
                ) || 1;
                const stepSec = config.enigmaImageDisplayDuration && config.enigmaImageDisplayDuration > 0
                  ? config.enigmaImageDisplayDuration
                  : scenarioStepSec;
                await new Promise(resolve => setTimeout(resolve, stepSec * 1000));
              }
            }

            // Apply the late malus to the running tally so the final figure
            // matches the persisted score, then play the end sound.
            if (lateMalus > 0) {
              currentScore -= lateMalus;
              setScore(currentScore);
            }
            if (!noAnimation) playSound('game_end');

            // Replace the centre enigma image with the end-of-run summary:
            // final score, level reached + description, team name, reset button.
            const level = reachedLevelFor(currentScore, finishLang);
            setSummary({
              teamName,
              finalScoreText: formatScore(currentScore),
              levelName: level?.name || undefined,
              levelDescription: level?.description || undefined,
            });

            // Hold this slot open until the page is reset - automatically after
            // `delayBeforeReset` when "Auto-reset page" is on, or until the
            // operator hits the reset button otherwise. This is what makes the
            // next player's "C'est parti" / reveal wait until THIS team's
            // results have been cleared, instead of appearing over them.
            await waitForReset(myRunId);
          };

          // Queue the reveal→banner as ONE slot: it waits for any in-flight
          // message/animation before starting and holds the queue until done.
          // The reveal fires automatically on the finishing bip (no holding
          // screen). Keeping it inside the slot is what stops a later team's bip
          // from disturbing the team that's currently animating.
          await queue.enqueue(teamName, runReveal);
        }
      } else {
        console.log('Team has already finished the game');
      }
    } catch (error) {
      console.error('Error handling card punch logic:', error);
    }
  };

  // Live handles for the Enter key. Kept in refs so the once-registered listener
  // never closes over stale state: it fires only while a results summary is on
  // screen and "use Enter to refresh the page" is on.
  const summaryShowingRef = useRef(false);
  summaryShowingRef.current = summary != null;
  const enterToResetRef = useRef(false);
  enterToResetRef.current = config.enterToReset === true;
  const resetToReadyRef = useRef(resetToReady);
  resetToReadyRef.current = resetToReady;

  // Enter mirrors the summary's refresh button: once a team's results are on
  // screen, pressing Enter resets the page (gated by `enterToReset`). NOTE:
  // there is intentionally NO window-wide click listener - only the on-screen
  // refresh button resets by click.
  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      if (summaryShowingRef.current && enterToResetRef.current) {
        resetToReadyRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => {
      window.removeEventListener('keydown', handleKeyPress);
    };
  }, []);

  // Game simulator: the operator clicks the summary's reset button (manual reset).
  useSimBus((a) => {
    if (a.kind === 'pressReset' && summaryShowingRef.current) resetToReadyRef.current();
  });

  useEffect(() => {
    let cancelled = false;

    const initializeUSB = async () => {
      if (!siReader.isAvailable()) {
        console.log('ℹ️  USB not available in this runtime - reader disabled');
        return;
      }
      // Don't bind the reader until we know which game we're in - the effect
      // re-runs when launchedGameId lands (join path) and binds then.
      if (!launchedGameId) return;
      // Bound before reader detection so the game simulator's injected reads
      // (no physical reader) reach the page too; harmless without events.
      siReader.setCardDetectedCallback((card: CardData) => {
        console.log('🏷️  CARD DETECTED');
        console.log('  Card ID:', card.id);
        console.log('  Series:', card.series);
        console.log('  Number of punches:', card.nbPunch);
        if (card.start) {
          console.log('  Start:', { code: card.start.code, time: card.start.time });
        }
        if (card.check) {
          console.log('  Check:', { code: card.check.code, time: card.check.time });
        }
        if (card.end) {
          console.log('  End:', { code: card.end.code, time: card.end.time });
        }
        console.log('  Punches:', card.punches);
        console.log('  Full card data:', JSON.stringify(card, null, 2));

        void saveCardDataRef.current(card);

        setLastCardData(card);
        setShowCardAlert(true);

        setTimeout(() => {
          setShowCardAlert(false);
        }, 5000);
      });

      const detected = await detectReaderPort();
      if (cancelled || !detected) {
        if (!detected) console.log('⚠️  No SportIdent reader detected - waiting for hotplug');
        return;
      }
      try {
        console.log('🔌 Initializing USB reader on detected port:', detected.path);
        const initialized = await siReader.initializePort(detected.path);
        if (initialized) {
            console.log('✓ USB reader initialized successfully');
            siReader.setCardRemovedCallback(() => {
              console.log('🏷️  CARD REMOVED');
              setShowCardAlert(false);
            });

            siReader.setStationsDetectedCallback((detectedStations: StationData[]) => {
              console.log('📡 STATIONS DETECTED');
              console.log('  Number of stations:', detectedStations.length);
              detectedStations.forEach((station, index) => {
                console.log(`  Station ${index + 1}:`, {
                  number: station.stationNumber,
                  mode: station.stationMode,
                  extended: station.extended,
                  handShake: station.handShake,
                  autoSend: station.autoSend,
                  radioChannel: station.radioChannel
                });
              });
              console.log('  Full stations data:', JSON.stringify(detectedStations, null, 2));
            });

            console.log('▶️  Starting USB reader...');
            await siReader.start();
            console.log('✓ USB reader started - waiting for card data...');
        } else {
          console.error('✗ Failed to initialize USB reader');
        }
      } catch (error) {
        console.error('✗ Error starting USB reader:', error);
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
      console.log('🚪 Leaving game page - cleaning up USB listener...');
      siReader.setCardDetectedCallback(undefined);
      if (siReader.isAvailable()) {
        siReader.stop().catch(err => {
          console.error('Error stopping USB reader:', err);
        });
      }
    };
    // Re-bind when the joined game's id is established (mirrors Tracks/Clash),
    // so a device that joins a game launched elsewhere records its punches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchedGameId]);

  const handleNewBip = useCallback((row: { id?: number; raw_data: any }) => {
    // Own punches are processed live in the USB-reader callback, which records
    // the row id here; the poll echoes them back ~1s later - skip our own echo.
    if (row.id != null && processedRawIdsRef.current.has(row.id)) return;
    // Anything else is a punch read on ANOTHER device, reaching us through the
    // shared state poll. Each station animates only the cards it physically
    // read, so we must NOT replay a remote bip here - doing so was animating a
    // single bip on every device in the game.
  }, []);

  useGameStatePolling({
    launchedGameId,
    numberOfTeams: config.numberOfTeams,
    onGameEnded: () => onGameEnd?.(),
    onAllTeamsFinished: () => {
      // Show the scenario's "all teams ended" UI string (if authored), then end
      // the game once it has had its display time; otherwise end immediately.
      const msg = resolveMetaText('text_all_team_ended');
      if (msg) {
        showMessage(msg, 'info');
        setTimeout(() => onGameEnd?.(), (config.messageDisplayDuration || 5) * 1000 + 500);
      } else {
        onGameEnd?.();
      }
    },
    onNewBip: handleNewBip,
    disableAllFinishedEnd: !!(config.autoRegisterTeam || config.reuseCards || config.selfRegisterTeam),
  });

  if (!gameData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading game...</div>
      </div>
    );
  }

  const getImageUrl = (filename: string) => {
    if (!filename || filename === 'undefined' || filename === 'null') return '';
    return scenarioAssetUrl(gameUniqid, filename);
  };

  // Scenario-wide font from the Typography section. Applied at the renderer
  // root so all mystery text inherits it.
  const scenarioFontFamily = resolveFontFamily(gameData.game_meta.font);

  // Display model. The in-game board is only shown once a team's reveal is
  // playing (`revealStarted`). Until then the board is blanked (boardHidden) so
  // the idle layout / background shows; everything appears when the reveal fires
  // automatically on the finishing bip.
  const screen: MysteryScreen = gameEnded ? 'endgame' : 'ingame';
  const boardHidden = screen === 'ingame' && !revealStarted;

  // Centre column focuses the next uncompleted enigma; during the end-of-game
  // reveal animation, `revealEnigmaNumber` overrides it so the centre walks
  // through every enigma as the tally runs.
  const selectedEnigmaIndex = (() => {
    if (revealEnigmaNumber) {
      const idx = gameData.game_enigmas.findIndex(e => e.number === revealEnigmaNumber);
      if (idx >= 0) return idx;
    }
    const firstUncompleted = gameData.game_enigmas.findIndex(
      e => !completedEnigmas.has(parseInt(e.number, 10)),
    );
    return firstUncompleted >= 0 ? firstUncompleted : 0;
  })();

  const scoreFullGameNum = parseFloat(gameData.game_meta.score_full_game) || 100;
  const gaugePercent = (score / scoreFullGameNum) * 100;

  const finalScoreText = gameData.game_meta.points_units === 'percentage'
    ? `${Math.round(score)}%`
    : `${Math.round(score)}`;

  // Highest level whose points threshold is ≤ current score - drives the
  // endgame screen's level name + description. Resolved in the finishing team's
  // language when available (translations envelope), else the flattened default.
  const reachedLevel = (() => {
    const levels = gameData.game_meta.levels ?? {};
    // The team's language for this reveal; empty ⇒ use the flat default text.
    const lang = resultLanguage || config.language || '';
    const localizedLevels = lang ? gameData.translations?.[lang]?.levels : undefined;
    let bestKey: string | null = null;
    let bestPts = -Infinity;
    for (const [key, lvl] of Object.entries(levels)) {
      const pts = parseFloat(lvl?.points ?? '0') || 0;
      if (pts <= score && pts > bestPts) {
        bestKey = key;
        bestPts = pts;
      }
    }
    if (bestKey === null) return null;
    const flat = levels[bestKey];
    const loc = localizedLevels?.[bestKey];
    return {
      name: loc?.name ?? flat?.name ?? '',
      description: loc?.description ?? flat?.description ?? '',
    };
  })();

  // Bonus ("overscore") tiers: the rewards a team unlocks by scoring ABOVE
  // score_full_game. Resolved in the finishing team's language when the
  // scenario ships a translations envelope, exactly like the level name above.
  // The renderer decides which ones the current score has reached.
  const bonusTiers = resolveMysteryBonuses(
    gameData.game_meta as unknown as Record<string, unknown>,
    scoreFullGameNum,
    gameData.translations,
    resultLanguage || config.language || '',
  );

  return (
    <div
      className="game_page_wrapper game_page_wrapper_mystery"
      style={{ fontFamily: scenarioFontFamily || undefined, position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}
    >
      {selfReg && (
        <SelfRegisterOverlay
          key={selfReg.teamId}
          cardId={selfReg.cardId}
          language={config.language || 'fr'}
          scenarioLanguages={config.scenarioLanguages ?? []}
          scenarioAudience={config.namePoolAudience ?? 'kids'}
          allowLanguageChoice={!!config.allowPlayerLanguageChoice}
          addRandomName={!!config.addRandomNameOption}
          onSubmit={(name, language) => {
            pendingStarts.dropSelfReg(selfReg.teamId);
            void selfReg.finalize(name, language);
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

      {/* No title/back chrome - the in-game screen is full-bleed. Exit is via
          GamePage's 4-tap top-right corner → operator panel (PIN-gated when
          "use PIN to exit" is on). Only the operational banners below render,
          and only while their condition holds, so there's no permanent top bar. */}
      {(config.testMode || (siReader.isAvailable() && !detectedReader.isPresent)) && (
        <div className="fixed top-0 left-0 right-0 z-50 pointer-events-none flex flex-col">
          {config.testMode && (
            <div className="flex items-center justify-center gap-3 px-4 py-2 bg-amber-400 border-b-2 border-amber-200 shadow-lg">
              <div className="w-2 h-2 rounded-full bg-black/70 animate-pulse" />
              <span className="font-sans tracking-wide uppercase text-black font-bold text-sm">{tr('testMode')}</span>
              <div className="w-2 h-2 rounded-full bg-black/70 animate-pulse" />
            </div>
          )}
          {siReader.isAvailable() && !detectedReader.isPresent && (
            <div className="flex items-center justify-center gap-3 px-4 py-2 bg-orange-600 border-b-2 border-orange-300 shadow-lg">
              <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
              <span className="font-sans normal-case tracking-normal text-white font-semibold text-sm">
                {tr('readerNotConnected')}
              </span>
            </div>
          )}
        </div>
      )}

      <MysteryGameRenderer
        gameMeta={gameData.game_meta}
        enigmas={gameData.game_enigmas}
        resolveMediaUrl={getImageUrl}
        screen={screen}
        boardHidden={boardHidden}
        timerText={resultDurationSec != null ? formatTime(resultDurationSec) : ''}
        score={score}
        teamName={resultTeamName ?? ''}
        completedEnigmas={completedEnigmas}
        enigmaStatusColors={enigmaStatusColors}
        enigmaStatusKinds={enigmaStatusKinds}
        colorblind={config.colorblindMode}
        selectedEnigmaIndex={selectedEnigmaIndex}
        gaugePercent={gaugePercent}
        onRestart={() => window.location.reload()}
        summary={summary}
        onReset={resetToReady}
        finalScoreText={finalScoreText}
        endLevelName={reachedLevel?.name}
        endLevelDescription={reachedLevel?.description}
        fontFamily={scenarioFontFamily || undefined}
        scenarioTitle={gameData.game.title}
        showIdleLayout={config.showIdleLayout}
        idleTextHidden={!!gameMessage}
        idleSubtitle={config.idleSubtitle}
        bonuses={bonusTiers}
        noAnimation={!!config.noRevealAnimation}
      />

      <GameMessageOverlay
        message={gameMessage || null}
        type={gameMessageType}
        fontFamily={scenarioFontFamily || undefined}
      />

      {/* While a full-screen message ("C'est parti …" etc.) is on screen, hide
          the waiting line so it doesn't show through; it reappears once the
          message clears. */}
      <PendingTeamsBar
        labels={queue.pending}
        lang={config.language ?? ''}
        hidden={!!gameMessage}
        fontFamily={scenarioFontFamily || undefined}
      />

      {showLoading && (
        <div id="game_loading_wrapper">
          <div id="game_loading_container">
            {gameData.game_meta.levels_gauge_player_icon_image ? (
              <div id="loading_image">
                <img src={getImageUrl(gameData.game_meta.levels_gauge_player_icon_image)} alt="loading" />
              </div>
            ) : (
              <div className="spinner"></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
