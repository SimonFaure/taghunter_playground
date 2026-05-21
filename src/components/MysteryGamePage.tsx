import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { GameConfig } from './LaunchGameModal';
import { sportidentService as siReader, CardData, StationData, detectReaderPort } from '../services/sportidentService';
import { useDetectedReaderPort } from '../services/useDetectedReaderPort';
import { CardDetectionAlert } from './CardDetectionAlert';
import {
  getLaunchedGameState,
  recordPunch,
  updateTeam,
} from '../services/launchedGames';
import * as patternStore from '../services/patternStore';
import * as scenarioStore from '../services/scenarioStore';
import * as gameTypesStore from '../services/gameTypesStore';
import { scenarioAssetUrl } from '../services/contentFs';
import { resolveFontFamily } from '../fonts/resolveFontFamily';
import { registerScenarioFonts } from '../fonts/registerScenarioFonts';
import { useGameStatePolling } from '../hooks/useGameStatePolling';
import { FirstBipVideoOverlay } from './FirstBipVideoOverlay';
import { MysteryGameRenderer, type MysteryScreen } from './MysteryGameRenderer';
import '../mystery.css';

interface VideoSource {
  kind: 'intro' | 'tutorial';
  videoUrl: string;
  subtitleLang: string | null;
  subtitleUrl: string | null;
}

// Resolve which videos should play on a team's first bip and produce a
// list of <video> sources for the overlay. Empty list → caller skips the
// overlay entirely.
async function resolveFirstBipVideos(
  config: GameConfig,
  gameUniqid: string,
  gameTypeCode: string,
  rawGameData: unknown,
): Promise<VideoSource[]> {
  const lang = config.language || 'en';
  const sources: VideoSource[] = [];

  // Intro = per-scenario scenario_video. Subtitle file lives in
  // scenarios/<uniqid>/v<N>/<scenario_video_subtitle_<lang>>.
  if (config.playIntroOnBip) {
    const introFilename =
      (rawGameData as { scenario_video?: unknown } | null)?.scenario_video
      ?? (rawGameData as { game_meta?: { scenario_video?: unknown } } | null)?.game_meta?.scenario_video
      ?? (rawGameData as { medias?: { video?: unknown } } | null)?.medias?.video;
    if (typeof introFilename === 'string' && introFilename.trim().length > 0) {
      // `medias.video` historically carries a `/media/<uniqid>/...` path; strip
      // to bare filename for local resolution.
      const bare = introFilename.split('/').filter(Boolean).pop() ?? introFilename;
      const url = await scenarioStore.getMediaPath(gameUniqid, bare);
      if (url) {
        const subtitleField = `scenario_video_subtitle_${lang}`;
        const subFilename =
          (rawGameData as { medias?: { sounds?: Record<string, string> } } | null)?.medias?.sounds?.[subtitleField];
        let subUrl: string | null = null;
        if (typeof subFilename === 'string' && subFilename) {
          subUrl = await scenarioStore.getMediaPath(gameUniqid, subFilename);
        }
        sources.push({ kind: 'intro', videoUrl: url, subtitleLang: lang, subtitleUrl: subUrl });
      }
    }
  }

  // Tutorial = game-type-level video, with override-wins resolution.
  if (config.playTutorialOnBip) {
    const resolved = await gameTypesStore.resolveTutorialVideoUrl(gameTypeCode);
    if (resolved) {
      const subUrl = resolved.subtitleUrls[lang] ?? null;
      sources.push({ kind: 'tutorial', videoUrl: resolved.videoUrl, subtitleLang: lang, subtitleUrl: subUrl });
    }
  }

  return sources;
}

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
  game_sounds?: Array<{
    id: string;
    game_id: string;
    image_number: string;
    sound_id: string;
  }>;
}

export function MysteryGamePage({ config, gameUniqid, launchedGameId, onBack, onGameEnd }: MysteryGamePageProps) {
  const [gameData, setGameData] = useState<GameData | null>(null);
  const gameDataRef = useRef<GameData | null>(null);
  const [gameStarted, setGameStarted] = useState(true);
  const [gameEnded, setGameEnded] = useState(false);
  const [score, setScore] = useState(0);
  const [time, setTime] = useState(0);
  const [completedEnigmas, setCompletedEnigmas] = useState<Set<number>>(new Set());
  // Reveal-animation overlay colours keyed by `enigma.number`. The end-of-
  // game tally walks each enigma, sets a colour here for instant feedback,
  // then adds the enigma to `completedEnigmas` to unblur the image.
  const [enigmaStatusColors, setEnigmaStatusColors] = useState<Record<string, string>>({});
  // Which enigma to feature in the centre column. Defaults to the first
  // uncompleted enigma; the reveal animation overrides it to walk through
  // every enigma as it tallies the score.
  const [revealEnigmaNumber, setRevealEnigmaNumber] = useState<string | null>(null);
  const [lastCardData, setLastCardData] = useState<CardData | null>(null);
  const [stations, setStations] = useState<StationData[]>([]);
  const [showCardAlert, setShowCardAlert] = useState(false);
  const [gameMessage, setGameMessage] = useState('');
  const [showLoading, setShowLoading] = useState(false);
  const [audioElements, setAudioElements] = useState<Record<string, HTMLAudioElement>>({});
  // First-bip video overlay state. Captures the team to finalize once the
  // overlay completes so the start_time set + start message fire only after
  // all videos have played.
  const [firstBipVideos, setFirstBipVideos] = useState<VideoSource[] | null>(null);
  const pendingFirstBipFinalizeRef = useRef<(() => Promise<void>) | null>(null);
  // Banner shown when the SportIdent reader isn't plugged in — the game
  // page autobinds via 'reader:status' once detection flips.
  const detectedReader = useDetectedReaderPort();

  useEffect(() => {
    const loadGameData = async () => {
      try {
        const raw = (await scenarioStore.getGameData(gameUniqid)) as any;
        if (!raw) {
          console.error('No game-data.json on disk for', gameUniqid);
          return;
        }

        // Disk shape may still ship the legacy {scenario, game_data, ...}
        // envelope or the flattened {game, game_meta, ...} shape. Normalise.
        const data: GameData = raw.scenario
          ? {
              game: {
                id: raw.scenario.id,
                uniqid: raw.scenario.uniqid,
                type: raw.scenario.scenario_type,
                title: raw.game_data?.game_meta?.title || raw.scenario.name,
              },
              game_meta: raw.game_data?.game_meta || {},
              game_enigmas: raw.game_data?.game_enigmas || [],
              game_sounds: raw.game_data?.game_sounds || [],
            }
          : raw;

        setGameData(data);
        gameDataRef.current = data;
        // Register the scenario's uploaded custom fonts so a Typography
        // selection that points at one renders (offline-safe).
        void registerScenarioFonts(gameUniqid, data.game_meta?.custom_fonts);

        if (data.game_sounds) {
          const loadedAudio: Record<string, HTMLAudioElement> = {};
          for (const soundData of data.game_sounds) {
            if (!soundData.sound_id) continue;
            const audio = new Audio(scenarioAssetUrl(gameUniqid, soundData.sound_id));
            loadedAudio[soundData.image_number] = audio;
          }
          setAudioElements(loadedAudio);
        }
      } catch (error) {
        console.error('Error loading game data:', error);
      }
    };

    loadGameData();
  }, [gameUniqid]);

  useEffect(() => {
    if (!gameStarted) return;

    const timer = setInterval(() => {
      setTime(prev => prev + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [gameStarted]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const playSound = (soundName: string) => {
    if (audioElements[soundName]) {
      audioElements[soundName].currentTime = 0;
      audioElements[soundName].play().catch(err => console.error('Error playing sound:', err));
    }
  };

  const showMessage = (message: string, duration: number = 3000) => {
    setGameMessage(message);
    setTimeout(() => setGameMessage(''), duration);
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
      // Server resolves device_id from the JWT.
      await recordPunch(launchedGameId, rawDataJson);
      await handleCardPunchLogic(card);
    } catch (error) {
      console.error('Error saving card data:', error);
    }
  };

  const handleCardPunchLogic = async (card: CardData) => {
    if (!launchedGameId) return;

    const currentGameData = gameDataRef.current;
    if (!currentGameData) {
      console.error('Game data not loaded yet');
      return;
    }

    try {
      // Resolve team via single combined state call.
      const state = await getLaunchedGameState(launchedGameId, 0);
      const team = state.teams.find((t) => t.key_id === card.id) ?? null;
      if (!team) {
        console.warn('No team found with card ID:', card.id);
        return;
      }
      const teamName = team.team_name ?? '';

      if (!team.start_time) {
        const finalizeStart = async () => {
          const startTime = Math.floor(Date.now() / 1000);
          try {
            await updateTeam(team.id, { start_time: startTime });
            console.log('✓ Team started:', teamName);
            showMessage(`C'est parti! ${teamName}`, config.messageDisplayDuration * 1000);
            playSound('game_start');
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
      } else if (!team.end_time) {
        const endTime = Math.floor(Date.now() / 1000);

        const patternEnigmas = await patternStore.getMysteryEnigmas(config.pattern);
        console.log('Loaded pattern enigmas:', patternEnigmas);

        const cardPunchCodes = card.punches.map(p => p.code.toString());
        console.log('Card punch codes:', cardPunchCodes);

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

          const waitForEnter = () => {
            return new Promise<void>((resolve) => {
              console.log('⌨️  Waiting for Enter key to show results...');
              const handleKeyPress = (event: KeyboardEvent) => {
                if (event.key === 'Enter') {
                  window.removeEventListener('keydown', handleKeyPress);
                  resolve();
                }
              };
              window.addEventListener('keydown', handleKeyPress);
            });
          };

          await waitForEnter();
          console.log('✓ Enter key pressed, showing results');

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
            setCompletedEnigmas(prev => {
              const next = new Set(prev);
              next.add(parseInt(enigmaResult.enigma_id, 10));
              return next;
            });

            currentScore += enigmaResult.points;
            setScore(currentScore);

            const animationDuration = (currentGameData.game_meta as unknown as { animation_enigma_duration?: string }).animation_enigma_duration;
            await new Promise(resolve => setTimeout(resolve, parseInt(animationDuration || '1') * 1000));
          }

          showMessage(`Terminé! ${teamName} - Score: ${totalScore} - Temps: ${formatTime(duration)}`, config.messageDisplayDuration * 1000);
          playSound('game_end');
        }
      } else {
        console.log('Team has already finished the game');
      }
    } catch (error) {
      console.error('Error handling card punch logic:', error);
    }
  };

  const handleStartGame = async () => {
    setGameStarted(true);
    playSound('game_start');

    const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;
    if (isElectron) {
      try {
        const dbResult = await (window as any).electron.db.connect();
        if (dbResult.success) {
          console.log('✓ Database connection successful:', dbResult.message);
        } else {
          console.error('✗ Database connection failed:', dbResult.message);
        }
      } catch (error) {
        console.error('✗ Database connection error:', error);
      }
    }
  };

  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !gameStarted) {
        handleStartGame();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [gameStarted]);

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

  const handleNewBip = useCallback((row: { raw_data: any }) => {
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

  // Which screen the renderer shows. `gameStarted` defaults to true so the
  // instructions branch is currently dead-code; kept wired so the start
  // button can be re-enabled later by flipping the initial state.
  const screen: MysteryScreen = !gameStarted
    ? 'instructions'
    : gameEnded
      ? 'endgame'
      : 'ingame';

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
      <CardDetectionAlert cardData={lastCardData} show={showCardAlert} />

      <header className="fixed top-0 left-0 right-0 bg-slate-800/80 backdrop-blur-sm border-b border-slate-700 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center gap-4">
          <button
            onClick={onBack}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition"
          >
            <ArrowLeft size={24} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">{gameData.game.title}</h1>
            <p className="text-slate-400 text-sm">{config.name}</p>
          </div>
        </div>
        {config.testMode && (
          <div className="flex items-center justify-center gap-3 px-4 py-2 bg-amber-500/20 border-t border-amber-500/30">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-amber-400 font-semibold text-sm tracking-wide uppercase">Test Mode — Max 5 Teams</span>
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          </div>
        )}
        {siReader.isAvailable() && !detectedReader.isPresent && (
          <div className="flex items-center justify-center gap-3 px-4 py-2 bg-orange-500/20 border-t border-orange-500/40">
            <div className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
            <span className="text-orange-300 text-sm">
              Reader not connected — waiting for SportIdent dongle. Punches will start landing as soon as you plug it in.
            </span>
          </div>
        )}
      </header>

      <MysteryGameRenderer
        gameMeta={gameData.game_meta}
        enigmas={gameData.game_enigmas}
        resolveMediaUrl={getImageUrl}
        screen={screen}
        timerText={formatTime(time)}
        score={score}
        teamName={config.name}
        completedEnigmas={completedEnigmas}
        enigmaStatusColors={enigmaStatusColors}
        selectedEnigmaIndex={selectedEnigmaIndex}
        gaugePercent={gaugePercent}
        onStartGame={handleStartGame}
        onRestart={() => window.location.reload()}
        finalScoreText={finalScoreText}
        endLevelName={reachedLevel?.name}
        endLevelDescription={reachedLevel?.description}
        fontFamily={scenarioFontFamily || undefined}
      />

      {gameMessage && (
        <div id="game_message_container" className="active">
          <div className="game_message_text">{gameMessage}</div>
        </div>
      )}

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
