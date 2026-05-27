import { useState, useEffect, useRef, useCallback } from 'react';
import { GameConfig } from './LaunchGameModal';
import { sportidentService as siReader, CardData, StationData, detectReaderPort } from '../services/sportidentService';
import { useDetectedReaderPort } from '../services/useDetectedReaderPort';
import { CardDetectionAlert } from './CardDetectionAlert';
import { GameMessageOverlay } from './GameMessageOverlay';
import type { GameMessageType } from '../services/gameMessages';
import {
  getLaunchedGameState,
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
import { resolveFirstBipVideos, type VideoSource } from '../services/firstBipVideos';
import { MysteryGameRenderer, type MysteryScreen, type EnigmaStatusKind } from './MysteryGameRenderer';
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
    levels: Record<string, { points: string; name: string; description: string }>;
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
}

export function MysteryGamePage({ config, gameUniqid, launchedGameId, onGameEnd }: MysteryGamePageProps) {
  const [gameData, setGameData] = useState<GameData | null>(null);
  const gameDataRef = useRef<GameData | null>(null);
  // Legacy single-player "endgame" screen — never entered in the per-team
  // base-station flow, kept wired so the renderer's endgame branch still
  // type-checks. The per-team reveal happens on the 'ingame' screen.
  const [gameEnded] = useState(false);
  const [score, setScore] = useState(0);
  // Mystery is event-driven on a shared base-station screen: a team starts on
  // its first bip and is scored on its second. There's no single "active" team
  // between bips, so we don't run a live clock. `resultDurationSec` holds the
  // finishing team's elapsed time (end − start) and is the ONLY thing that
  // makes the timer text appear — null = hidden (idle screen + during play).
  const [resultDurationSec, setResultDurationSec] = useState<number | null>(null);
  // The finishing team's name, shown in the right-column name card only while
  // its results are on screen (null = hidden). Replaces the old display of
  // `config.name` (the launched-game name), which we never want there.
  const [resultTeamName, setResultTeamName] = useState<string | null>(null);
  // Holding-vs-reveal gate. The in-game board is hidden until a team's second
  // bip plays the reveal. `revealStarted` true = the board is shown and the
  // tally animation is running/done. With "use Enter/click to reveal results"
  // ON, the second bip arms `pendingRevealRef` and an instructions screen holds
  // until the operator presses Enter or clicks; OFF, the reveal fires at once.
  const [revealStarted, setRevealStarted] = useState(false);
  const pendingRevealRef = useRef<(() => void) | null>(null);
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
  // Track the row ids we've already handled locally so the poll skips them —
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
  const [stations, setStations] = useState<StationData[]>([]);
  const [showCardAlert, setShowCardAlert] = useState(false);
  const [gameMessage, setGameMessage] = useState('');
  const [gameMessageType, setGameMessageType] = useState<GameMessageType>('info');
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Serialises on-screen presentations. Game messages AND the reveal animation
  // share this one chain, so a new message/animation only starts once the
  // previous one has fully finished — never overlapping. Tasks are appended in
  // call order and run strictly in sequence. It's a ref so every code path
  // (USB callback captured at mount, the state-poll, the reveal) appends to the
  // same live queue regardless of which render's closure they were created in.
  const presentationChainRef = useRef<Promise<void>>(Promise.resolve());
  // Monotonic id of the reveal currently playing. A previous run's pending
  // auto-reset timer checks this before resetting, so it no-ops once a newer
  // reveal has started — otherwise that stale timer wipes the new animation's
  // board mid-play (the visuals vanish while the loop keeps firing sounds).
  const revealRunIdRef = useRef(0);
  const [showLoading, setShowLoading] = useState(false);
  // Loaded scenario audio keyed by sound role (e.g. 'enigma_success'). A ref,
  // not state, because `playSound` is reached through the bip handlers'
  // closures (USB callback set at mount, handleNewBip's useCallback) which are
  // created BEFORE the async audio load finishes — a state value would be
  // captured empty there and the reveal would play no sound.
  const audioElementsRef = useRef<Record<string, HTMLAudioElement>>({});
  // First-bip video overlay state. Captures the team to finalize once the
  // overlay completes so the start_time set + start message fire only after
  // all videos have played.
  const [firstBipVideos, setFirstBipVideos] = useState<VideoSource[] | null>(null);
  const pendingFirstBipFinalizeRef = useRef<(() => Promise<void>) | null>(null);
  // Self-register overlay state. Shown on a team's first bip when enabled, BEFORE
  // any videos. `finalize(name)` persists the name + proceeds to videos/start;
  // `abort()` cancels the start (and deletes the team if this bip created it).
  const [selfReg, setSelfReg] = useState<{
    finalize: (name: string) => Promise<void>;
    abort: () => Promise<void>;
  } | null>(null);
  // Banner shown when the SportIdent reader isn't plugged in — the game
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
    const audio = audioElementsRef.current[soundName];
    if (audio) {
      audio.currentTime = 0;
      audio.play().catch(err => console.error('Error playing sound:', err));
    }
  };

  // Append a presentation task to the serial chain; it runs only after every
  // earlier message/animation has finished. Resolves when the task itself
  // completes (not the whole future chain), so callers that await it (the
  // reveal) advance as soon as their own slot is done. The chain survives a
  // throwing task so one failure can't wedge the queue.
  const enqueuePresentation = (task: () => Promise<void>): Promise<void> => {
    const run = presentationChainRef.current.then(task, task);
    presentationChainRef.current = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  // Low-level message presentation: show the banner (+ optional sound) and
  // resolve once it has been on screen for the full display duration. NOT
  // queued — used directly inside an already-running queue slot (the reveal's
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
  // (the enqueue happens synchronously, preserving order).
  const showMessage = (
    message: string,
    type: GameMessageType = 'info',
    sound?: string,
  ): Promise<void> => enqueuePresentation(() => displayMessage(message, type, sound));

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

  // Return the display to the ready 'ingame' screen without a page reload.
  // Triggered by "Auto-reset page" after a run's results have shown.
  const resetToReady = () => {
    setScore(0);
    setResultDurationSec(null);
    setResultTeamName(null);
    setRevealStarted(false);
    setCompletedEnigmas(new Set());
    setEnigmaStatusColors({});
    setEnigmaStatusKinds({});
    setRevealEnigmaNumber(null);
    setGameMessage('');
    setShowCardAlert(false);
  };

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
      // True when *this* bip created the team — drives the self-register abort
      // cleanup (delete a just-created team, never a rostered one).
      let createdNow = false;

      if (!team) {
        const finished = teamsForCard.length > 0;
        if (!finished) {
          if (!config.autoRegisterTeam && !config.selfRegisterTeam) {
            console.warn('No team for card (dynamic team modes off):', card.id);
            return;
          }
          team = await ensureTeamForCard(launchedGameId, card.id, state, !!config.useNamePool);
          if (!team) {
            showMessage('Carte non enregistrée', 'warning');
            return;
          }
          createdNow = true;
        } else {
          if (!config.reuseCards) {
            console.log('Team has already finished the game');
            return;
          }
          const lastEnd = Math.max(...teamsForCard.map((t) => t.end_time ?? 0));
          const cooldownSec = (config.reuseDelayMinutes ?? 5) * 60;
          if (Date.now() / 1000 < lastEnd + cooldownSec) {
            const remainingMin = Math.max(1, Math.ceil((lastEnd + cooldownSec - Date.now() / 1000) / 60));
            showMessage(`Ce doigt sera remis en jeu dans ${remainingMin} minute${remainingMin > 1 ? 's' : ''}`, 'warning');
            return;
          }
          team = await ensureTeamForCard(launchedGameId, card.id, state, !!config.useNamePool);
          if (!team) return;
          createdNow = true;
        }
      }
      const teamName = team.team_name ?? '';

      if (!team.start_time) {
        // The start sequence, parameterised by the effective team name: persist
        // a self-registered rename, then gate the clock on any first-bip videos.
        // Runs directly when self-register is off, or from the overlay's submit.
        const proceedAfterName = async (effectiveName: string) => {
          if (effectiveName && effectiveName !== teamName) {
            try {
              await updateTeam(team.id, { team_name: effectiveName });
            } catch (err) {
              console.error('Error saving self-registered name:', err);
            }
          }

          const finalizeStart = async () => {
            const startTime = Math.floor(Date.now() / 1000);
            try {
              await updateTeam(team.id, { start_time: startTime });
              console.log('✓ Team started:', effectiveName);

              // A fresh run wants an empty card. Punches with a real time
              // (not the 00:00:00 placeholder) mean the card wasn't wiped.
              // Snapshot them as `${code}@${time}` so scoring can subtract
              // them at the second bip — the operator gets a heads-up but the
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

              const startMsg = `C'est parti ! ${effectiveName}`;
              const warnMsg =
                stalePunches.length > 0
                  ? ` — ⚠️ Carte non vide : ${stalePunches.length} ancien${stalePunches.length > 1 ? 's' : ''} passage${stalePunches.length > 1 ? 's' : ''} ignoré${stalePunches.length > 1 ? 's' : ''}`
                  : '';
              showMessage(startMsg + warnMsg, warnMsg ? 'warning' : 'success', 'game_start');
            } catch (err) {
              console.error('Error updating team start time:', err);
            }
          };

          // Decide whether to gate the start on the first-bip video overlay.
          // We only resolve videos here (not at mount) so a launch with both
          // toggles off skips the whole code path.
          const wantsVideos = !!(config.playTutorialOnBip || config.playIntroOnBip);
          if (wantsVideos) {
            const gameTypeCode = (currentGameData.game?.type || 'mystery').toLowerCase();
            const rawForResolve = await scenarioStore.getGameData(gameUniqid);
            const videos = await resolveFirstBipVideos(config, gameUniqid, gameTypeCode, rawForResolve);
            if (videos.length > 0) {
              pendingFirstBipFinalizeRef.current = finalizeStart;
              setFirstBipVideos(videos);
              return;
            }
          }

          await finalizeStart();
        };

        // Self-register: prompt for the name first (before videos). On submit we
        // proceed with the entered name; on abort we cancel the start and delete
        // the team if this bip created it.
        if (config.selfRegisterTeam) {
          setSelfReg({
            finalize: (name: string) => proceedAfterName(name),
            abort: async () => {
              setSelfReg(null);
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
        const endTime = Math.floor(Date.now() / 1000);

        const patternEnigmas = await patternStore.getMysteryEnigmas(config.pattern);
        console.log('Loaded pattern enigmas:', patternEnigmas);

        // Drop punches that were already on the card at the first bip (matched
        // on code+time, so a station legitimately re-punched during the run —
        // new time — still counts). Keeps a forgotten-to-wipe card from
        // scoring its leftover punches.
        const baseline = preExistingPunchesRef.current.get(card.id) ?? new Set<string>();
        const livePunches = card.punches.filter(p => !baseline.has(`${p.code}@${p.time}`));
        if (baseline.size > 0) {
          console.log(`Ignoring ${card.punches.length - livePunches.length} pre-existing punch(es) for card ${card.id}`);
        }
        const cardPunchCodes = livePunches.map(p => p.code.toString());
        console.log('Card punch codes (after removing pre-existing):', cardPunchCodes);

        let totalScore = 0;

        console.log('=== MATCHING ENIGMAS ===');
        console.log('Game enigmas:', currentGameData.game_enigmas.map(ge => ({ number: ge.number, id: ge.id, good_points: ge.good_answer_points, wrong_points: ge.wrong_answer_points })));

        const enigmaResults = patternEnigmas.map((enigma) => {
          const gameEnigma = currentGameData.game_enigmas.find(ge => ge.number === enigma.enigma_id);
          console.log(`Looking for enigma_id "${enigma.enigma_id}":`, gameEnigma ? `Found (number: ${gameEnigma.number}, good: ${gameEnigma.good_answer_points}, wrong: ${gameEnigma.wrong_answer_points})` : 'NOT FOUND');

          const goodPoints = parseInt(gameEnigma?.good_answer_points || '0');
          const wrongPoints = parseInt(gameEnigma?.wrong_answer_points || '0');

          const hasGoodAnswer = enigma.good_answers.some(answer => cardPunchCodes.includes(answer));
          const hasWrongAnswer = enigma.wrong_answers.some(answer => cardPunchCodes.includes(answer));

          let result: 'correct' | 'incorrect' | 'no_answer' | 'both_answers';
          let points = 0;

          if (hasGoodAnswer && hasWrongAnswer) {
            result = 'both_answers';
            points = 0;
          } else if (hasGoodAnswer && !hasWrongAnswer) {
            result = 'correct';
            points = goodPoints;
            totalScore += goodPoints;
          } else if (hasWrongAnswer && !hasGoodAnswer) {
            result = 'incorrect';
            points = -wrongPoints;
            totalScore -= wrongPoints;
          } else {
            result = 'no_answer';
            points = 0;
          }

          return {
            enigma_id: enigma.enigma_id,
            good_answers: enigma.good_answers,
            wrong_answers: enigma.wrong_answers,
            result,
            points,
            hasGoodAnswer,
            hasWrongAnswer,
          };
        });

        console.log('=== ENIGMA RESULTS ===');
        enigmaResults.forEach((result) => {
          console.log(`Enigma ${result.enigma_id}:`, {
            expected_good: result.good_answers,
            expected_wrong: result.wrong_answers,
            result: result.result,
            points: result.points,
            hasGoodAnswer: result.hasGoodAnswer,
            hasWrongAnswer: result.hasWrongAnswer,
          });
        });

        console.log('=== FINAL SCORE ===');
        console.log('Total Score:', totalScore);

        let updateOk = true;
        try {
          await updateTeam(team.id, { end_time: endTime, score: totalScore });
        } catch (err) {
          console.error('Error updating team end time:', err);
          updateOk = false;
        }
        if (updateOk) {
          console.log('✓ Team finished:', teamName);
          console.log('✓ Score:', totalScore);
          const duration = endTime - team.start_time;
          // The run is scored; drop the card's start-time baseline so a later
          // reuse of the same card starts clean.
          preExistingPunchesRef.current.delete(card.id);

          // Play the reveal: show the board (the finishing team's name +
          // elapsed time), start from a hidden/zeroed state, then walk each
          // enigma flashing its result colour and tallying the score.
          const runReveal = async () => {
            // Claim this as the current reveal run; the auto-reset timer below
            // captures it so a previous run's reset can't wipe this board.
            const myRunId = ++revealRunIdRef.current;
            setRevealStarted(true);
            setResultDurationSec(duration);
            setResultTeamName(teamName);
            setScore(0);
            setCompletedEnigmas(new Set());
            setEnigmaStatusColors({});
            setEnigmaStatusKinds({});
            setRevealEnigmaNumber(null);

            let currentScore = 0;
            for (const enigmaResult of enigmaResults) {
              const gameEnigma = currentGameData.game_enigmas.find(ge => ge.number === enigmaResult.enigma_id);
              if (!gameEnigma) continue;

              let backgroundColor = '';
              switch (enigmaResult.result) {
                case 'correct':
                  backgroundColor = 'rgba(0, 255, 0, 0.3)';
                  playSound('enigma_success');
                  break;
                case 'incorrect':
                  backgroundColor = 'rgba(255, 0, 0, 0.3)';
                  playSound('enigma_error');
                  break;
                case 'no_answer':
                  backgroundColor = 'rgba(128, 128, 128, 0.3)';
                  playSound('enigma_no_answer');
                  break;
                case 'both_answers':
                  backgroundColor = 'rgba(255, 165, 0, 0.3)';
                  playSound('enigma_error');
                  break;
              }

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

            // The result banner belongs to THIS animation slot: await it so the
            // queue only advances to the next team's message/animation once the
            // banner has shown for its full duration (animation + banner are one
            // atomic, non-overlapping unit). displayMessage is used directly
            // here — we're already inside the queue slot, so re-enqueuing would
            // deadlock.
            await displayMessage(`Terminé! ${teamName} - Score: ${totalScore} - Temps: ${formatTime(duration)}`, 'success', 'game_end');

            // Auto-reset page: after results have shown, return the display to
            // the ready/holding screen automatically — but only if no newer
            // reveal has started since (otherwise we'd wipe ITS board mid-play).
            if (config.autoResetTeam) {
              setTimeout(() => {
                if (revealRunIdRef.current === myRunId) resetToReady();
              }, (config.delayBeforeReset || 0) * 1000);
            }
          };

          // Queue the whole hold→reveal→banner as ONE slot: it waits for any
          // in-flight message/animation before starting and holds the queue
          // until done. The Enter/click hold lives INSIDE the slot too —
          // "Use Enter/click to reveal results" (default on) shows the
          // instructions holding screen and arms the reveal (the global
          // Enter/click listener fires it); off reveals immediately. Keeping the
          // hold inside the slot is what stops a later team's bip from flipping
          // the holding screen on (setRevealStarted(false)) in the middle of the
          // team that's currently animating.
          await enqueuePresentation(async () => {
            if (config.revealResultsOnInput !== false) {
              setRevealStarted(false); // instructions holding screen until reveal
              console.log('⌨️  Awaiting Enter/click to reveal results...');
              await new Promise<void>((resolve) => {
                pendingRevealRef.current = () => { pendingRevealRef.current = null; resolve(); };
              });
            }
            await runReveal();
          });
        }
      } else {
        console.log('Team has already finished the game');
      }
    } catch (error) {
      console.error('Error handling card punch logic:', error);
    }
  };

  // Clicking the holding/instructions screen fires the armed reveal (same as
  // pressing Enter / clicking anywhere). No-op if nothing is armed.
  const handleStartGame = () => {
    pendingRevealRef.current?.();
  };

  // Reveal gate (only relevant when "use Enter/click to reveal results" is on):
  // a finishing bip arms `pendingRevealRef`, and pressing Enter or clicking
  // anywhere fires the held reveal. No-op when nothing is armed, so it never
  // interferes with the idle/holding screen.
  useEffect(() => {
    const fireReveal = () => {
      const run = pendingRevealRef.current;
      if (run) run();
    };
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === 'Enter') fireReveal();
    };
    window.addEventListener('keydown', handleKeyPress);
    window.addEventListener('click', fireReveal);
    return () => {
      window.removeEventListener('keydown', handleKeyPress);
      window.removeEventListener('click', fireReveal);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const initializeUSB = async () => {
      if (!siReader.isAvailable()) {
        console.log('ℹ️  USB not available in this runtime - reader disabled');
        return;
      }
      const detected = await detectReaderPort();
      if (cancelled || !detected) {
        if (!detected) console.log('⚠️  No SportIdent reader detected — waiting for hotplug');
        return;
      }
      try {
        console.log('🔌 Initializing USB reader on detected port:', detected.path);
        const initialized = await siReader.initializePort(detected.path);
        if (initialized) {
            console.log('✓ USB reader initialized successfully');
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

              saveCardData(card);

              setLastCardData(card);
              setShowCardAlert(true);

              setTimeout(() => {
                setShowCardAlert(false);
              }, 5000);
            });

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
              setStations(detectedStations);
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
      if (siReader.isAvailable()) {
        siReader.stop().catch(err => {
          console.error('Error stopping USB reader:', err);
        });
      }
    };
  }, []);

  const handleNewBip = useCallback((row: { id?: number; raw_data: any }) => {
    // Skip rows this device already processed locally via the USB reader; the
    // poll echoes our own punches back ~1s later and re-running the logic would
    // start+finish a team on one bip. Remote (satellite) punches aren't in the
    // set, so they still flow through here.
    if (row.id != null && processedRawIdsRef.current.has(row.id)) return;
    const card = row.raw_data;
    if (card && gameDataRef.current) {
      console.log('🏷️  CARD DETECTED (test/simulation)');
      console.log('  Card ID:', card.id);
      console.log('  Series:', card.series);
      console.log('  Number of punches:', card.nbPunch);
      console.log('  Punches:', card.punches);
      console.log('  Full card data:', JSON.stringify(card, null, 2));
      setLastCardData(card);
      setShowCardAlert(true);
      setTimeout(() => setShowCardAlert(false), 5000);
      handleCardPunchLogic(card);
    }
  }, [launchedGameId]);

  useGameStatePolling({
    launchedGameId,
    numberOfTeams: config.numberOfTeams,
    onGameEnded: () => onGameEnd?.(),
    onAllTeamsFinished: () => onGameEnd?.(),
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

  // Holding-vs-reveal display model. The in-game board is only shown once a
  // team's reveal is playing (`revealStarted`). Until then we hold:
  //   • "use Enter/click to reveal results" ON  → show the instructions screen
  //     (operator presses Enter/clicks to play the reveal);
  //   • OFF → stay on 'ingame' but blank the board (boardHidden) so everything
  //     is hidden and only appears when the reveal fires on the finishing bip.
  const holdWithInstructions = !revealStarted && config.revealResultsOnInput !== false;
  const screen: MysteryScreen = gameEnded
    ? 'endgame'
    : holdWithInstructions
      ? 'instructions'
      : 'ingame';
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
    : `${Math.round(score)} / ${gameData.game_meta.score_full_game}`;

  // Highest level whose points threshold is ≤ current score — drives the
  // endgame screen's level name + description.
  const reachedLevel = (() => {
    let best: { name: string; description: string } | null = null;
    let bestPts = -Infinity;
    for (const lvl of Object.values(gameData.game_meta.levels ?? {})) {
      const pts = parseFloat(lvl?.points ?? '0') || 0;
      if (pts <= score && pts > bestPts) {
        best = { name: lvl?.name ?? '', description: lvl?.description ?? '' };
        bestPts = pts;
      }
    }
    return best;
  })();

  return (
    <div
      className="game_page_wrapper game_page_wrapper_mystery"
      style={{ fontFamily: scenarioFontFamily || undefined, position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}
    >
      {selfReg && (
        <SelfRegisterOverlay
          language={config.language || 'fr'}
          onSubmit={(name) => {
            const s = selfReg;
            setSelfReg(null);
            void s.finalize(name);
          }}
          onAbort={() => {
            void selfReg.abort();
          }}
        />
      )}
      {firstBipVideos && (
        <FirstBipVideoOverlay
          videos={firstBipVideos}
          onComplete={async () => {
            const finalize = pendingFirstBipFinalizeRef.current;
            pendingFirstBipFinalizeRef.current = null;
            setFirstBipVideos(null);
            if (finalize) await finalize();
          }}
        />
      )}
      {/* Dev-only punch/hardware debug indicator — removed from production builds. */}
      {import.meta.env.DEV && (
        <CardDetectionAlert cardData={lastCardData} show={showCardAlert} />
      )}

      {/* No title/back chrome — the in-game screen is full-bleed. Exit is via
          GamePage's 4-tap top-right corner → operator panel (PIN-gated when
          "use PIN to exit" is on). Only the operational banners below render,
          and only while their condition holds, so there's no permanent top bar. */}
      {(config.testMode || (siReader.isAvailable() && !detectedReader.isPresent)) && (
        <div className="fixed top-0 left-0 right-0 z-50 pointer-events-none flex flex-col">
          {config.testMode && (
            <div className="flex items-center justify-center gap-3 px-4 py-2 bg-amber-500/20 backdrop-blur-sm border-b border-amber-500/30">
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-amber-400 font-semibold text-sm tracking-wide uppercase">Test Mode — Max 5 Teams</span>
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            </div>
          )}
          {siReader.isAvailable() && !detectedReader.isPresent && (
            <div className="flex items-center justify-center gap-3 px-4 py-2 bg-orange-500/20 backdrop-blur-sm border-b border-orange-500/40">
              <div className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
              <span className="text-orange-300 text-sm">
                Reader not connected — waiting for SportIdent dongle. Punches will start landing as soon as you plug it in.
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
        onStartGame={handleStartGame}
        onRestart={() => window.location.reload()}
        finalScoreText={finalScoreText}
        endLevelName={reachedLevel?.name}
        endLevelDescription={reachedLevel?.description}
        fontFamily={scenarioFontFamily || undefined}
      />

      <GameMessageOverlay
        message={gameMessage || null}
        type={gameMessageType}
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
