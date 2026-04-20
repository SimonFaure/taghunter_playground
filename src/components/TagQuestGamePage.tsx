import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Play, Users, Trophy } from 'lucide-react';
import { GameConfig } from './LaunchGameModal';
import { usbReaderService, CardData, StationData } from '../services/usbReader';
import { CardDetectionAlert } from './CardDetectionAlert';
import { PunchAnimationOverlay } from './PunchAnimationOverlay';
import { supabase } from '../lib/db';
import { useGameStatePolling } from '../hooks/useGameStatePolling';
import { processTagQuestPunch } from '../services/tagquestPunchLogic';
import type { PunchAnimationData } from '../services/tagquestPunchLogic';
import { logApiCall } from '../services/apiLogger';

type AnimPhase = 'idle' | 'enter' | 'images' | 'main' | 'update' | 'exit';

const SLOT_STAGGER_MS = 400;
const MAIN_IMAGE_HOLD_MS = 2500;
const UPDATE_HOLD_MS = 4000;
const EXIT_MS = 600;

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

interface LayoutElement {
  id: string;
  type: 'image' | 'text' | 'container' | 'quest';
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
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
  const postAnimExitDelayMs = postAnimExitDelayMsProp > 0
    ? postAnimExitDelayMsProp
    : localStorage.getItem('tagquest_keep_anim_visible') === '1' ? 10000 : 0;
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [layout, setLayout] = useState<GameLayout | null>(null);
  const [layoutLoading, setLayoutLoading] = useState(true);
  const [gameStarted, setGameStarted] = useState(true);
  const [lastCardData, setLastCardData] = useState<CardData | null>(null);
  const [showCardAlert, setShowCardAlert] = useState(false);
  const [teams, setTeams] = useState<TeamScore[]>([]);
  const [gameMessage, setGameMessage] = useState('');
  const [levelUpMessage, setLevelUpMessage] = useState('');
  const [mediaFiles, setMediaFiles] = useState<Record<string, string>>({});
  const [bgDimensions, setBgDimensions] = useState<{ width: number; height: number } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
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
  const [animDisplayedMalus, setAnimDisplayedMalus] = useState(0);
  const [animDisplayedLateMalus, setAnimDisplayedLateMalus] = useState(0);
  const [lastKnownScore, setLastKnownScore] = useState(0);
  const [lastKnownQuestDetails, setLastKnownQuestDetails] = useState<PunchAnimationData['newQuestDetails']>([]);
  const [lastKnownCombos, setLastKnownCombos] = useState({ combos6: 0, combos4: 0, combos2: 0 });
  const [lastKnownMalus, setLastKnownMalus] = useState(0);
  const [lastKnownLateMalus, setLastKnownLateMalus] = useState(0);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const bgImageRef = useRef<HTMLImageElement>(null);
  const gameDataRef = useRef<GameData | null>(null);
  const mediaFilesRef = useRef<Record<string, string>>({});

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
    if (animPhase === 'main') {
      animSet(() => setAnimPhase('update'), MAIN_IMAGE_HOLD_MS);
    }
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
            await supabase.from('teams').update({ end_time: punchAnimation.endTimeToCommit, score: punchAnimation.newScore }).eq('id', punchAnimation.teamId);
          }
        }
        setAnimPhase('idle');
        setAnimRevealedSlots(0);
        setAnimShowUpdated(false);
        setPunchAnimation(null);
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
        const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

        if (isElectron) {
          const gameDataContent = await (window as any).electron.games.readFile(gameUniqid, 'game-data.json');
          const data = JSON.parse(gameDataContent);
          const rawGdj = data?.game_data ?? data;
          const gdElectron: GameData = {
            game: {
              id: gameUniqid,
              uniqid: gameUniqid,
              type: 'tagquest',
              title: data.title || data.game?.title || gameUniqid,
            },
            quests: rawGdj.quests || [],
            levels: rawGdj.game_meta?.levels ?? rawGdj.levels ?? undefined,
          };
          gameDataRef.current = gdElectron;
          setGameData(gdElectron);

          const csvContent = await (window as any).electron.games.readFile(gameUniqid, 'csv/game_media_images.csv');
          if (csvContent) {
            const lines = csvContent.split('\n');
            const headers = lines[0].split(',');
            const mediaMap: Record<string, string> = {};

            for (let i = 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;

              const values = line.split(',');
              const id = values[0];
              const uuid = values[3];
              const fileName = values[6];

              if (id && uuid && fileName) {
                const mediaPath = `data/games/${gameUniqid}/media/${uuid}/${fileName}`;
                mediaMap[id] = mediaPath;
                mediaMap[fileName] = mediaPath;
              }
            }

            setMediaFiles(mediaMap);
            mediaFilesRef.current = mediaMap;
            console.log('Loaded media files:', mediaMap);
          }

          const layoutResult = await (window as any).electron.layouts.readFile('tagquest');
          if (layoutResult.success) {
            const layoutData = JSON.parse(layoutResult.content);
            setLayout(layoutData);
            console.log('Layout loaded:', layoutData);
          } else {
            console.warn('No layout found for tagquest:', layoutResult.error);
          }
        } else {
          const { data: scenarioData, error } = await supabase
            .from('scenarios')
            .select('*')
            .eq('uniqid', gameUniqid)
            .maybeSingle();

          if (error) {
            console.error('Error loading scenario:', error);
            return;
          }

          if (scenarioData) {
            let gdj = scenarioData.game_data_json;

            if (!gdj) {
              const { data: gameDataFile } = await supabase.storage
                .from('resources')
                .download(`scenarios/${gameUniqid}/game-data.json`);

              if (gameDataFile) {
                const text = await gameDataFile.text();
                gdj = JSON.parse(text);
              }
            }

            const rawGdjWeb = gdj?.game_data ?? gdj;
            const quests = rawGdjWeb?.quests || [];
            const gdWeb: GameData = {
              game: {
                id: scenarioData.id.toString(),
                uniqid: scenarioData.uniqid,
                type: scenarioData.game_type,
                title: scenarioData.title
              },
              quests,
              levels: rawGdjWeb?.game_meta?.levels ?? rawGdjWeb?.levels ?? undefined,
            };
            gameDataRef.current = gdWeb;
            setGameData(gdWeb);
          }

          const mediaByFilename: Record<string, string> = {};

          const { data: storageMediaFiles } = await supabase.storage
            .from('resources')
            .list(`scenarios/${gameUniqid}/media`, { limit: 1000 });

          if (storageMediaFiles) {
            for (const file of storageMediaFiles) {
              if (file.name) {
                const { data: urlData } = supabase.storage
                  .from('resources')
                  .getPublicUrl(`scenarios/${gameUniqid}/media/${file.name}`);
                const url = urlData.publicUrl;
                const baseName = file.name.startsWith('media/') ? file.name.slice('media/'.length) : file.name;
                mediaByFilename[baseName] = url;
                mediaByFilename[`media/${baseName}`] = url;
              }
            }
          }

          setMediaFiles(prev => ({ ...prev, ...mediaByFilename }));

          mediaFilesRef.current = { ...mediaFilesRef.current, ...mediaByFilename };
          const bgEntry = mediaByFilename['fond-ecran-taille-ok.jpg'] || null;

          let layoutConfig: GameLayout | null = null;

          const { data: storageFiles } = await supabase.storage
            .from('resources')
            .list('layouts/tagquest', { limit: 100 });

          if (storageFiles && storageFiles.length > 0) {
            const jsonFiles = storageFiles
              .filter(f => f.name.endsWith('.json'))
              .sort((a, b) => {
                const vA = parseInt(a.name.match(/(\d+)/)?.[1] ?? '0', 10);
                const vB = parseInt(b.name.match(/(\d+)/)?.[1] ?? '0', 10);
                return vB - vA;
              });

            if (jsonFiles.length > 0) {
              const { data: fileData } = await supabase.storage
                .from('resources')
                .download(`layouts/tagquest/${jsonFiles[0].name}`);

              if (fileData) {
                const text = await fileData.text();
                const parsed = JSON.parse(text);
                layoutConfig = (parsed.config ?? parsed) as GameLayout;
              }
            }
          }

          if (!layoutConfig) {
            const layoutStr = localStorage.getItem('layout_tagquest');
            if (layoutStr) {
              layoutConfig = JSON.parse(layoutStr) as GameLayout;
            }
          }

          if (layoutConfig) {
            const resolvedElements = (layoutConfig.elements || []).map((el: LayoutElement) => {
              if (el.type === 'image' && el.filename) {
                const fname = el.filename.split('/').pop() ?? '';
                const resolved = mediaByFilename[fname];
                if (resolved) return { ...el, src: resolved };
              }
              return el;
            });

            setLayout({
              ...layoutConfig,
              background: bgEntry || layoutConfig.background,
              elements: resolvedElements
            });
          } else {
            console.warn('No layout found for tagquest');
          }
        }
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

    const startAllTeams = async () => {
      const startTime = Math.floor(Date.now() / 1000);
      const { error } = await supabase
        .from('teams')
        .update({ start_time: startTime, end_time: null })
        .eq('launched_game_id', launchedGameId);

      if (error) {
        console.error('[TagQuest] Error starting all teams:', error);
      } else {
        console.log('[TagQuest] All teams started at', startTime);
      }
    };

    startAllTeams();
  }, [launchedGameId]);

  useEffect(() => {
    if (!launchedGameId) return;

    const fetchLaunchedGame = async () => {
      const { data } = await supabase
        .from('launched_games')
        .select('start_time, duration')
        .eq('id', launchedGameId)
        .maybeSingle();

      if (data) {
        setLaunchedGameInfo({ start_time: data.start_time, duration: data.duration });
      }
    };

    const fetchMeta = async () => {
      const { data } = await supabase
        .from('launched_game_meta')
        .select('meta_name, meta_value')
        .eq('launched_game_id', launchedGameId)
        .in('meta_name', ['victoryType', 'playMode', 'teamsConfig']);

      if (data) {
        const map: Record<string, string> = {};
        data.forEach(row => { map[row.meta_name] = row.meta_value || ''; });

        if (map.victoryType === 'score' || map.victoryType === 'speed') {
          setVictoryType(map.victoryType);
        }
        if (map.playMode === 'solo' || map.playMode === 'team') {
          setPlayMode(map.playMode);
        }
        if (map.teamsConfig) {
          try {
            setTeamsConfig(JSON.parse(map.teamsConfig));
          } catch {}
        }
      }
    };

    fetchLaunchedGame();
    fetchMeta();
  }, [launchedGameId]);

  useEffect(() => {
    if (!launchedGameInfo?.start_time || launchedGameInfo.duration == null) return;

    const tick = () => {
      const startMs = new Date(launchedGameInfo.start_time!).getTime();
      const durationMs = (launchedGameInfo.duration ?? 0) * 60 * 1000;
      const endMs = startMs + durationMs;
      const remaining = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
      setCountdown(remaining);
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [launchedGameInfo]);

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

    const { data, error } = await supabase
      .from('teams')
      .select('id, team_name, score, start_time, end_time, key_id')
      .eq('launched_game_id', launchedGameId);

    if (!error && data) {
      const withLevels = data.map(t => ({
        ...t,
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
    }
  };

  const saveCardData = async (card: CardData) => {
    if (!supabase || !launchedGameId) {
      return;
    }

    try {
      let deviceId = 'web_browser';
      const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

      if (isElectron) {
        try {
          deviceId = await (window as any).electron.getComputerName();
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
      }
    } catch (error) {
      console.error('Error saving card data:', error);
    }
  };

  const resolveMedia = useCallback((key: string): string => {
    const m = mediaFilesRef.current;
    return m[key] || m[key.replace(/^media\//, '')] || m[`media/${key}`] || '';
  }, []);

  const handleCardPunchLogic = async (card: CardData) => {
    if (!launchedGameId) return;

    const result = await processTagQuestPunch(
      card,
      launchedGameId,
      gameUniqid,
      playMode,
      teamsConfig,
      resolveMedia
    );

    await logApiCall({
      endpoint: `/tagquest/punch/${launchedGameId}`,
      method: 'PUNCH',
      requestBody: card as unknown as Record<string, unknown>,
      responseData: result,
      statusCode: result.status === 'ok' ? 200 : result.status === 'error' ? 500 : 422,
      errorMessage: result.status !== 'ok' ? result.message : undefined,
    });

    supabase.from('team_punch_responses').insert({
      launched_game_id: launchedGameId,
      team_id: result.team_id ?? null,
      team_name: result.team_name ?? '',
      chip_id: card.id ?? null,
      status: result.status,
      result_json: result as unknown as Record<string, unknown>,
    }).then(({ error }) => {
      if (error) console.error('Error saving punch response:', error);
    });

    if (result.status === 'ok') {
      if (result.animationData) {
        setPunchAnimation(result.animationData);
      } else if (result.game_ended) {
        showMessage(`${result.team_name} — Game finished!`);
      } else if (result.completed_quest) {
        const mainMsg = `${result.team_name} — ${result.completed_quest.name} complete! +${result.completed_quest.points} pts${result.malus_applied > 0 ? ` (−${result.malus_applied} late malus)` : ''}`;
        const levelPart = result.level_up ? `Level up: ${result.level_up.name}!` : undefined;
        showMessage(mainMsg, levelPart);
      } else if (result.level_up) {
        showMessage(`${result.team_name} — Level up: ${result.level_up.name}!`);
      } else if (result.best_partial_quest) {
        showMessage(
          `${result.team_name} — ${result.best_partial_quest.name}: ${result.best_partial_quest.matched} image(s) found`
        );
      }
      loadTeams();
    }
  };

  const showMessage = (message: string, levelUp?: string) => {
    setGameMessage(message);
    setLevelUpMessage(levelUp || '');
    setTimeout(() => { setGameMessage(''); setLevelUpMessage(''); }, 5000);
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
    const initializeUSB = async () => {
      if (usbReaderService.isElectron() && config.usbPort) {
        try {
          console.log('🔌 Initializing USB reader on port:', config.usbPort);
          const initialized = await usbReaderService.initializePort(config.usbPort);
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
          }
        } catch (error) {
          console.error('Error initializing USB reader:', error);
        }
      }
    };

    if (gameStarted) {
      initializeUSB();
    }

    return () => {
      if (usbReaderService.isElectron()) {
        usbReaderService.stopReading();
      }
    };
  }, [gameStarted, config.usbPort]);

  const updateBgDimensions = useCallback(() => {
    if (bgImageRef.current) {
      setBgDimensions({
        width: bgImageRef.current.offsetWidth,
        height: bgImageRef.current.offsetHeight
      });
    }
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(updateBgDimensions);
    if (bgImageRef.current) observer.observe(bgImageRef.current);
    window.addEventListener('resize', updateBgDimensions);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBgDimensions);
    };
  }, [updateBgDimensions, layout]);

  const renderLayoutElement = (element: LayoutElement, index: number): JSX.Element | JSX.Element[] => {
    if (!bgDimensions) {
      return <div key={`${element.id}-${index}`} />;
    }

    const wrapperStyle: React.CSSProperties = {
      position: 'absolute',
      left: element.x !== undefined ? `${(element.x / 100) * bgDimensions.width}px` : undefined,
      top: element.y !== undefined ? `${(element.y / 100) * bgDimensions.height}px` : undefined,
      width: element.width !== undefined ? `${(element.width / 100) * bgDimensions.width}px` : undefined,
      height: element.height !== undefined ? `${(element.height / 100) * bgDimensions.height}px` : undefined,
      ...element.style
    };

    let imageSrc = element.src || element.filename;
    if (element.type === 'image' && !imageSrc && element.id) {
      imageSrc = mediaFiles[element.id] || '';
    }

    const isAnimating = animPhase !== 'idle';
    const activeQuestIndex = punchAnimation?.displayQuest?.index != null ? punchAnimation.displayQuest.index - 1 : -1;

    if (element.id === 'animation_quest_image') {
      const quests = gameData?.quests || [];
      if (!quests.length) return <div key={`${element.id}-${index}`} style={wrapperStyle} />;

      const resolveMedia = (key: string | undefined): string => {
        if (!key) return '';
        return mediaFiles[key] || mediaFiles[key.replace(/^media\//, '')] || mediaFiles[`media/${key}`] || '';
      };

      return quests.map((quest, questIndex) => {
        const questNum = questIndex + 1;
        const mainSrc = resolveMedia(quest.main_image);
        const isActiveQuest = isAnimating && activeQuestIndex === questIndex;
        const slots = punchAnimation?.displayQuest?.slots ?? [];
        const showPreviewImage = isActiveQuest && (animPhase === 'enter' || animPhase === 'images');
        const showMain = isActiveQuest && (animPhase === 'main' || animPhase === 'update' || animPhase === 'exit');
        const showSubImages = isActiveQuest && (animPhase === 'images' || animPhase === 'main' || animPhase === 'update' || animPhase === 'exit');

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
              {showPreviewImage && mainSrc && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: '2px solid rgba(255,255,255,0.15)',
                    opacity: 1,
                    transition: 'opacity 0.4s ease',
                    zIndex: 0,
                  }}
                >
                  <img src={mainSrc} alt={quest.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                </div>
              )}
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
                <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'grid', gridTemplateColumns: slots.length <= 2 ? `repeat(${slots.length}, 1fr)` : 'repeat(2, 1fr)', gap: '4px', zIndex: 1 }}>
                  {slots.map((slot, si) => {
                    const revealed = si < animRevealedSlots;
                    return (
                      <div
                        key={slot.key}
                        style={{
                          position: 'relative',
                          borderRadius: '6px',
                          overflow: 'hidden',
                          border: revealed
                            ? slot.matched ? '2px solid rgba(74,222,128,0.8)' : '2px solid rgba(248,113,113,0.8)'
                            : '2px solid rgba(255,255,255,0.08)',
                          background: '#0f172a',
                          opacity: revealed ? 1 : 0.15,
                          transform: revealed ? 'scale(1)' : 'scale(0.92)',
                          transition: 'opacity 0.35s ease, transform 0.35s ease, border-color 0.3s ease',
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
                fontFamily: element.fontFamily,
                fontSize: element.fontSize !== undefined ? `${(element.fontSize / 100) * (element.height !== undefined ? (element.height / 100) * bgDimensions.height : bgDimensions.height)}px` : '1em',
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
    const isTitle = elementId.includes('_title') || elementId.includes('_label') || elementId.endsWith('title') || elementId.endsWith('label');
    const isQuestPoints = /quest_\d+_points/.test(elementId);
    const isQuestMultiplicator = /quest_\d+_multiplicat/.test(elementId);
    const isQuestName = /quest_\d+_name/.test(elementId);
    const isCombo6 = !isTitle && !isQuestMultiplicator && (elementId.includes('combo_6') || elementId.includes('combo6'));
    const isCombo4 = !isTitle && !isQuestMultiplicator && (elementId.includes('combo_4') || elementId.includes('combo4'));
    const isCombo2 = !isTitle && !isQuestMultiplicator && (elementId.includes('combo_2') || elementId.includes('combo2'));
    const isMultiplicator = !isTitle && !isQuestMultiplicator && !isCombo6 && !isCombo4 && !isCombo2 && elementId.includes('multiplicat');
    const isLateMalus = !isTitle && elementId.includes('late_malus');
    const isMalus = !isTitle && !isLateMalus && elementId.includes('malus');
    const isTotalScore = elementId.includes('total_score') || elementId === 'score';
    const isTeamName = elementId === 'team_name_text';
    const isTimer = elementId.includes('timer') || elementId.includes('countdown');

    const elementHeightPx = element.height !== undefined ? (element.height / 100) * bgDimensions.height : bgDimensions.height;

    const questIndexForElement = (() => {
      const m = elementId.match(/quest_(\d+)_/);
      return m ? parseInt(m[1], 10) - 1 : -1;
    })();

    const getQuestDetail = (details: PunchAnimationData['newQuestDetails'], qi: number) =>
      details.find(d => d.questIndex === qi);

    const isQuestSpecificImage = questIndexForElement >= 0;
    const imageVisible = isTimer || (isAnimating && (
      !isQuestSpecificImage || questIndexForElement === activeQuestIndex
    ));

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
          displayText = countdown !== null ? formatTime(countdown) : formatTime(0);
        } else if (isTeamName) {
          showElement = isAnimating;
          displayText = punchAnimation?.teamName ?? '';
        } else if (isTotalScore) {
          showElement = true;
          displayText = isAnimating ? animDisplayedScore : lastKnownScore;
        } else if (isQuestName && questIndexForElement >= 0) {
          showElement = isAnimating && questIndexForElement === activeQuestIndex;
          const quest = gameData?.quests?.[questIndexForElement];
          displayText = quest?.name ?? '';
        } else if (isQuestPoints && questIndexForElement >= 0) {
          showElement = isAnimating;
          const isActiveQuest = questIndexForElement === activeQuestIndex;
          const details = isAnimating
            ? (animShowUpdated && isActiveQuest ? (punchAnimation?.newQuestDetails ?? []) : (punchAnimation?.prevQuestDetails ?? []))
            : lastKnownQuestDetails;
          const qd = getQuestDetail(details, questIndexForElement);
          displayText = qd ? `${qd.totalPoints} pts` : '0 pts';
        } else if (isQuestMultiplicator && questIndexForElement >= 0) {
          showElement = isAnimating;
          const isActiveQuest = questIndexForElement === activeQuestIndex;
          const details = isAnimating
            ? (animShowUpdated && isActiveQuest ? (punchAnimation?.newQuestDetails ?? []) : (punchAnimation?.prevQuestDetails ?? []))
            : lastKnownQuestDetails;
          const qd = getQuestDetail(details, questIndexForElement);
          displayText = qd ? `x${qd.timesCompleted}` : 'x0';
        } else if (isCombo6) {
          showElement = isAnimating;
          const combos = isAnimating ? animDisplayedCombos : lastKnownCombos;
          const cp = punchAnimation?.comboPoints ?? { pts6: 0, pts4: 0, pts2: 0 };
          displayText = `${combos.combos6 * cp.pts6}`;
        } else if (isCombo4) {
          showElement = isAnimating;
          const combos = isAnimating ? animDisplayedCombos : lastKnownCombos;
          const cp = punchAnimation?.comboPoints ?? { pts6: 0, pts4: 0, pts2: 0 };
          displayText = `${combos.combos4 * cp.pts4}`;
        } else if (isCombo2) {
          showElement = isAnimating;
          const combos = isAnimating ? animDisplayedCombos : lastKnownCombos;
          const cp = punchAnimation?.comboPoints ?? { pts6: 0, pts4: 0, pts2: 0 };
          displayText = `${combos.combos2 * cp.pts2}`;
        } else if (isMultiplicator) {
          showElement = isAnimating;
          const combos = isAnimating ? animDisplayedCombos : lastKnownCombos;
          const totalCombos = combos.combos6 + combos.combos4 + combos.combos2;
          displayText = `x${totalCombos}`;
        } else if (isLateMalus) {
          showElement = isAnimating;
          displayText = isAnimating ? `-${animDisplayedLateMalus}` : `-${lastKnownLateMalus}`;
        } else if (isMalus) {
          showElement = isAnimating;
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
                fontSize: element.fontSize !== undefined ? `${(element.fontSize / 100) * elementHeightPx}px` : undefined,
                color: element.color,
                fontFamily: element.fontFamily,
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
            <p className="text-white/60 mb-2">USB Port: {config.usbPort || 'Not configured'}</p>
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
    return (
      <div style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        backgroundColor: '#000',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        {layout.background && (
          <img
            ref={bgImageRef}
            src={layout.background}
            alt="Background"
            onLoad={updateBgDimensions}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              objectPosition: 'center'
            }}
          />
        )}

        {bgDimensions && layout.elements?.map((element, index) => renderLayoutElement(element, index))}

        {gameMessage && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '20px 40px',
            borderRadius: '10px',
            fontSize: '24px',
            fontWeight: 'bold',
            zIndex: 1000,
            textAlign: 'center',
          }}>
            {gameMessage}
            {levelUpMessage && (
              <div style={{
                marginTop: '10px',
                fontSize: '20px',
                color: '#facc15',
                fontWeight: 'bold',
              }}>
                {levelUpMessage}
              </div>
            )}
          </div>
        )}

        <CardDetectionAlert
            cardData={lastCardData}
            show={showCardAlert}
          />
        {punchAnimation && !layout.elements?.some(el => el.id === 'animation_quest_image') && (
          <PunchAnimationOverlay
            data={punchAnimation}
            onDone={async () => {
              const wasGameOver = punchAnimation.gameOver ?? false;
              const teamName = punchAnimation.teamName ?? '';
              if (punchAnimation.endTimeToCommit != null && punchAnimation.teamId != null) {
                await supabase.from('teams').update({ end_time: punchAnimation.endTimeToCommit, score: punchAnimation.newScore }).eq('id', punchAnimation.teamId);
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
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-8">
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

      <CardDetectionAlert
          cardData={lastCardData}
          show={showCardAlert}
        />
      {punchAnimation && (
        <PunchAnimationOverlay
          data={punchAnimation}
          onDone={async () => {
            const wasGameOver = punchAnimation.gameOver ?? false;
            const teamName = punchAnimation.teamName ?? '';
            if (punchAnimation.endTimeToCommit != null && punchAnimation.teamId != null) {
              await supabase.from('teams').update({ end_time: punchAnimation.endTimeToCommit, score: punchAnimation.newScore }).eq('id', punchAnimation.teamId);
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
