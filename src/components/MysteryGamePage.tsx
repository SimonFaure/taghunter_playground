import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { GameConfig } from './LaunchGameModal';
import { usbReaderService, CardData, StationData } from '../services/usbReader';
import { CardDetectionAlert } from './CardDetectionAlert';
import { supabase } from '../lib/db';
import { loadPatternEnigmasByUniqid, PatternEnigma } from '../utils/patterns';
import { useGameStatePolling } from '../hooks/useGameStatePolling';
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
    number_of_enigmas: string;
    font: string;
    font_color?: string;
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
  const [lastCardData, setLastCardData] = useState<CardData | null>(null);
  const [stations, setStations] = useState<StationData[]>([]);
  const [showCardAlert, setShowCardAlert] = useState(false);
  const [gameMessage, setGameMessage] = useState('');
  const [showLoading, setShowLoading] = useState(false);
  const [audioElements, setAudioElements] = useState<Record<string, HTMLAudioElement>>({});
  const [mediaFiles, setMediaFiles] = useState<Record<string, string>>({});

  useEffect(() => {
    const loadGameData = async () => {
      try {
        const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

        if (isElectron) {
          const gameDataContent = await (window as any).electron.games.readFile(gameUniqid, 'game-data.json');
          let data = JSON.parse(gameDataContent);

          if (data.scenario) {
            data = {
              game: {
                id: data.scenario.id,
                uniqid: data.scenario.uniqid,
                type: data.scenario.scenario_type,
                title: data.game_data?.game_meta?.title || data.scenario.name
              },
              game_meta: data.game_data?.game_meta || {},
              game_enigmas: data.game_data?.game_enigmas || [],
              game_sounds: data.game_data?.game_sounds || []
            };
          }

          setGameData(data);
          gameDataRef.current = data;

          const mediaFilesMap: Record<string, string> = {};
          const collectImageIds = (obj: any, ids: Set<string>) => {
            if (typeof obj === 'string' && /^\d+$/.test(obj)) {
              ids.add(obj);
            } else if (typeof obj === 'object' && obj !== null) {
              Object.values(obj).forEach(val => collectImageIds(val, ids));
            }
          };

          const imageIds = new Set<string>();
          collectImageIds(data.game_meta, imageIds);
          if (data.game_enigmas) {
            data.game_enigmas.forEach((enigma: any) => collectImageIds(enigma, imageIds));
          }
          if (data.game_sounds) {
            data.game_sounds.forEach((sound: any) => collectImageIds(sound, imageIds));
          }

          for (const imageId of imageIds) {
            try {
              const files = await (window as any).electron.games.listMediaFolder(gameUniqid, imageId);
              if (files && files.length > 0) {
                mediaFilesMap[imageId] = files[0];
              }
            } catch (err) {
              console.warn(`Could not load media for ${imageId}:`, err);
            }
          }
          setMediaFiles(mediaFilesMap);

          if (data.game_sounds) {
            const loadedAudio: Record<string, HTMLAudioElement> = {};
            for (const soundData of data.game_sounds) {
              const fileName = mediaFilesMap[soundData.sound_id];
              if (fileName) {
                const audio = new Audio(`app-file://${gameUniqid}/media/${soundData.sound_id}/${fileName}`);
                loadedAudio[soundData.image_number] = audio;
              }
            }
            setAudioElements(loadedAudio);
          }
        } else {
          const response = await fetch(`/data/games/${gameUniqid}/game-data.json`);
          let data = await response.json();

          if (data.scenario) {
            data = {
              game: {
                id: data.scenario.id,
                uniqid: data.scenario.uniqid,
                type: data.scenario.scenario_type,
                title: data.game_data?.game_meta?.title || data.scenario.name
              },
              game_meta: data.game_data?.game_meta || {},
              game_enigmas: data.game_data?.game_enigmas || [],
              game_sounds: data.game_data?.game_sounds || []
            };
          }

          setGameData(data);
          gameDataRef.current = data;

          if (data.game_sounds) {
            const loadedAudio: Record<string, HTMLAudioElement> = {};
            for (const soundData of data.game_sounds) {
              const audio = new Audio(`/data/games/${gameUniqid}/media/${soundData.sound_id}`);
              loadedAudio[soundData.image_number] = audio;
            }
            setAudioElements(loadedAudio);
          }
        }
      } catch (error) {
        console.error('Error loading game data:', error);
      }
    };

    loadGameData();
  }, [gameUniqid]);

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;
    if (isElectron) {
      (window as any).electron.db.connect().catch(() => {});
    }
  }, []);

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
    if (!supabase || !launchedGameId) {
      console.warn('Cannot save card data: supabase or launchedGameId not available', { supabase: !!supabase, launchedGameId });
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
      console.log('✓ Game data loaded, proceeding...');
    }

    console.log('Saving card data for launched game:', launchedGameId);

    try {
      let deviceId = 'unknown';
      if (usbReaderService.isElectron()) {
        try {
          const computerName = await (window as any).electron.getComputerName();
          deviceId = computerName || 'unknown';
        } catch (error) {
          console.error('Error getting computer name:', error);
        }
      }

      const rawDataJson = JSON.parse(JSON.stringify(card));

      const { error } = await supabase.from('launched_game_raw_data').insert({
        launched_game_id: launchedGameId,
        device_id: deviceId,
        raw_data: rawDataJson,
      });

      if (error) {
        console.error('Error saving card data:', error);
      } else {
        console.log('✓ Card data saved successfully');
        await handleCardPunchLogic(card);
      }
    } catch (error) {
      console.error('Error saving card data:', error);
    }
  };

  const handleCardPunchLogic = async (card: CardData) => {
    if (!supabase || !launchedGameId) {
      return;
    }

    const currentGameData = gameDataRef.current;
    if (!currentGameData) {
      console.error('Game data not loaded yet');
      return;
    }

    try {
      const { data: team, error: teamError } = await supabase
        .from('teams')
        .select('*')
        .eq('launched_game_id', launchedGameId)
        .eq('key_id', card.id)
        .maybeSingle();

      if (teamError) {
        console.error('Error finding team:', teamError);
        return;
      }

      if (!team) {
        console.warn('No team found with card ID:', card.id);
        return;
      }

      if (!team.start_time) {
        const startTime = Math.floor(Date.now() / 1000);
        const { error: updateError } = await supabase
          .from('teams')
          .update({ start_time: startTime })
          .eq('id', team.id);

        if (updateError) {
          console.error('Error updating team start time:', updateError);
        } else {
          console.log('✓ Team started:', team.team_name);
          showMessage(`C'est parti! ${team.team_name}`, config.messageDisplayDuration * 1000);
          playSound('game_start');
        }
      } else if (!team.end_time) {
        const endTime = Math.floor(Date.now() / 1000);

        const patternEnigmas = await loadPatternEnigmasByUniqid('mystery', config.pattern);
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

        const { error: updateError } = await supabase
          .from('teams')
          .update({
            end_time: endTime,
            score: totalScore,
          })
          .eq('id', team.id);

        if (updateError) {
          console.error('Error updating team end time:', updateError);
        } else {
          console.log('✓ Team finished:', team.team_name);
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

            const enigmaContainer = document.querySelector(`#enigma_container_${enigmaResult.enigma_id}`);
            const recapContainer = document.querySelector(`#enigmas_recap_enigma_container_${enigmaResult.enigma_id} .enigma_answer_image`);

            if (enigmaContainer) {
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

              (enigmaContainer as HTMLElement).style.backgroundColor = backgroundColor;
            }

            if (recapContainer) {
              recapContainer.classList.remove('blur');
            }

            currentScore += enigmaResult.points;
            setScore(currentScore);

            const scoreElement = document.querySelector('#game_score_container_score');
            if (scoreElement) {
              scoreElement.textContent = currentScore.toString();
            }

            await new Promise(resolve => setTimeout(resolve, parseInt(currentGameData.game_meta.animation_enigma_duration || '1') * 1000));
          }

          showMessage(`Terminé! ${team.team_name} - Score: ${totalScore} - Temps: ${formatTime(duration)}`, config.messageDisplayDuration * 1000);
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
    const initializeUSB = async () => {
      if (usbReaderService.isElectron() && config.usbPort) {
        try {
          console.log('🔌 Initializing USB reader on port:', config.usbPort);
          const initialized = await usbReaderService.initializePort(config.usbPort);
          if (initialized) {
            console.log('✓ USB reader initialized successfully');
            usbReaderService.setCardDetectedCallback((card: CardData) => {
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

            usbReaderService.setCardRemovedCallback(() => {
              console.log('🏷️  CARD REMOVED');
              setShowCardAlert(false);
            });

            usbReaderService.setStationsDetectedCallback((detectedStations: StationData[]) => {
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
            await usbReaderService.start();
            console.log('✓ USB reader started - waiting for card data...');
          } else {
            console.error('✗ Failed to initialize USB reader');
          }
        } catch (error) {
          console.error('✗ Error starting USB reader:', error);
        }
      } else {
        if (!usbReaderService.isElectron()) {
          console.log('ℹ️  Not in Electron mode - USB reader disabled');
        } else if (!config.usbPort) {
          console.log('⚠️  No USB port configured - USB reader disabled');
        }
      }
    };

    initializeUSB();

    return () => {
      console.log('🚪 Leaving game page - cleaning up USB listener...');
      if (usbReaderService.isElectron()) {
        usbReaderService.stop().catch(err => {
          console.error('Error stopping USB reader:', err);
        });
      }
    };
  }, [config.usbPort]);

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

  const getImageUrl = (imageId: string) => {
    if (!imageId || imageId === 'undefined' || imageId === 'null') return '';
    const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

    if (isElectron) {
      const fileName = mediaFiles[imageId];
      if (fileName) {
        return `app-file://${gameUniqid}/media/${imageId}/${fileName}`;
      }
      return `app-file://${gameUniqid}/media/${imageId}`;
    }

    return '';
  };

  const backgroundImageUrl = getImageUrl(gameData.game_meta.background_image);

  return (
    <div className="game_page_wrapper game_page_wrapper_mystery" style={{ backgroundImage: `url(${backgroundImageUrl})` }}>
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
      </header>

      {!gameStarted && (
        <div className="game_instructions_wrapper">
          <div
            className="mystery_game_instructions_container"
            style={{ backgroundImage: `url(${getImageUrl(gameData.game_meta.game_instructions_image)})` }}
          >
            <div id="game_instructions_button_image_container" onClick={handleStartGame}>
              <div className="game_instructions_button" id="game_instructions_button_image">
                <img src={getImageUrl(gameData.game_meta.game_instructions_button_image)} alt="start" />
              </div>
              <div className="game_instructions_button" id="game_instructions_button_hover_image">
                <img src={getImageUrl(gameData.game_meta.game_instructions_button_hover_image)} alt="start-hover" />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="enigmas_wrapper" style={{ opacity: gameStarted ? 1 : 0 }}>
        <div className="left_column_mystery">
          <div className="time_background_image">
            <img src={getImageUrl(gameData.game_meta.time_background_image)} alt="timer" />
            <div id="time_background_image_text">{formatTime(time)}</div>
          </div>

          <div className="team_score_container">
            <img src={getImageUrl(gameData.game_meta.score_background_image)} alt="score" />
            <div className="team_score_container_text">
              <span id="game_score_container_score">{score}</span>
              {gameData.game_meta.points_units === 'percentage' ? (
                <span id="game_score_container_percentage">%</span>
              ) : (
                <>/<span id="game_score_container_game_complete_score">{gameData.game_meta.score_full_game}</span></>
              )}
            </div>
            <div id="floating_enigma_score"></div>
          </div>

          <div id="game_overscore" className="team_bonus_wrapper">
            <div className="team_bonus_container team_bonus_container_empty">
              <img src={getImageUrl(gameData.game_meta.enigmas_header_image)} alt="bonus-empty" />
            </div>
          </div>
        </div>

        <div id="enigmas_grid_wrapper">
          <div className="enigmas_subwrapper">
            <div className="enigma_container" id="time_full_container">
              <div>Your time </div>
              <div id="time_full_container_detail">{formatTime(time)}</div>
            </div>

            {gameData.game_enigmas.map((enigma) => (
              <div key={enigma.id} className="enigma_wrapper">
                <div className="enigma_container" id={`enigma_container_${enigma.number}`}>
                  <div className="enigma_subcontainer enigma_texts_container">
                    <div className="enigma_text">{enigma.text}</div>
                    <div className="enigma_answer">
                      <div className="enigma_answer_image">
                        <div className="enigma_answer_image_background"></div>
                        <img
                          src={getImageUrl(enigma.good_answer_image)}
                          alt={enigma.text}
                          className={completedEnigmas.has(parseInt(enigma.number)) ? '' : 'blur'}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div id="right_column_mystery" className="right_column_mystery">
          <div id="mystery_team_name_container" className="mystery_team_name_container">
            <img src={getImageUrl(gameData.game_meta.team_name_background_image)} alt="team" />
            <div className="mystery_team_name_container_text">{config.name}</div>
          </div>

          <div id="artefacts_container" className="artefacts_container">
            <img src={getImageUrl(gameData.game_meta.enigmas_header_image)} alt="ingredients" />
          </div>

          <div className="team_enigmas_recap_container">
            {gameData.game_enigmas.map((enigma) => (
              <div
                key={enigma.id}
                className="enigmas_recap_enigma_container"
                id={`enigmas_recap_enigma_container_${enigma.number}`}
              >
                <div className="enigmas_recap_enigma_subcontainer">
                  <div className="enigma_answer">
                    <div className="enigma_answer_image_background">
                      <div className={`enigma_answer_image ${completedEnigmas.has(parseInt(enigma.number)) ? 'no_blur' : 'blur'}`}>
                        <img src={getImageUrl(enigma.good_answer_image)} alt={enigma.text} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="progress_bar_container">
        <div id="progression_wrapper">
          <div className="progress_bar">
            <div id="progress_bar_gauge_with_back">
              <img src={getImageUrl(gameData.game_meta.levels_gauge_image)} alt="gauge" />
            </div>
            <div id="progress_bar_content">
              <div
                id="progress_bar_content_inside"
                style={{
                  background: gameData.game_meta.gauge_filling,
                  width: `${score}%`
                }}
              ></div>
            </div>

            {Object.entries(gameData.game_meta.levels).map(([key, level]) => {
              const stepNumber = parseInt(key);
              const isEven = stepNumber % 2 === 0;
              const isFirst = stepNumber === 1;
              const isLast = stepNumber === Object.keys(gameData.game_meta.levels).length;
              const shouldShowIcon = stepNumber === 1 || stepNumber === 10 || stepNumber === 20 || stepNumber === 30 || stepNumber === 40 || stepNumber === 50;

              if (!shouldShowIcon) return null;

              return (
                <div
                  key={key}
                  className={`step ${isFirst ? 'first_step' : ''} ${isLast ? 'last_step' : ''}`}
                  id={`step_container_${stepNumber}`}
                >
                  <div className="step-progress"></div>
                  <div className={`icon-wrapper ${!isFirst && !isLast ? 'icon-wrapper-end' : ''} ${isLast ? 'icon-wrapper-last' : ''}`}>
                    <div id={`step_${stepNumber}`} className={`${isEven ? 'even_image' : ''} step_checkmark`}>
                      <img src={getImageUrl(gameData.game_meta.levels_gauge_level_icon_image)} alt="level-icon" />
                    </div>
                    <div className={`${isEven ? 'level_line_even' : ''} level_line`}></div>
                  </div>
                  <div className={`${isEven ? 'step_even' : 'step_odd'} step-text step-text-end step_level_hidden`}>
                    {level.name}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

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

      {gameEnded && (
        <div id="final_score_container" className="active">
          <div id="final_score_container_data">
            <div>
              Your final score: <br />
              <span id="final_score_score">{score}</span>
              {gameData.game_meta.points_units === 'percentage' ? (
                <span>%</span>
              ) : (
                <>/<span id="final_score_complete_score">{gameData.game_meta.score_full_game}</span></>
              )}
            </div>
            <div id="final_score_level_container"></div>
            <div className="get_bip_survival">
              <div id="reload_page" className="game_instructions_summary" onClick={() => window.location.reload()}>
                {gameData.game_meta.game_refresh_button_image && gameData.game_meta.game_refresh_button_hover_image ? (
                  <div id="refresh_button_container">
                    <div className="refresh_button" id="game_instructions_button_image">
                      <img src={getImageUrl(gameData.game_meta.game_refresh_button_image)} alt="refresh" />
                    </div>
                    <div className="refresh_button hide" id="game_refresh_button_hover_image">
                      <img src={getImageUrl(gameData.game_meta.game_refresh_button_hover_image)} alt="refresh-hover" />
                    </div>
                  </div>
                ) : (
                  <span>Restart Game</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
