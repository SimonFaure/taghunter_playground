import { useState, useEffect } from 'react';
import { X, FlaskConical, Play, CheckCircle, AlertCircle, Loader, Monitor, Image as ImageIcon, CheckSquare, Square } from 'lucide-react';
import * as scenarioStore from '../services/scenarioStore';
import * as patternStore from '../services/patternStore';
import {
  getLaunchedGameState,
  getLaunchedGameMeta,
  getLaunchedGameDevices,
  recordPunch,
  updateTeam,
} from '../services/launchedGames';
import { checkpointsForRoute, computeScore, type TracksScoreType } from '../services/tracksScoring';
import { processTagQuestPunch } from '../services/tagquestPunchLogic';
import { buildMediaMap } from '../utils/questMedia';
import { wrongAnswerPoints } from '../services/mysteryScoring';

interface GameTestModalProps {
  gameId: number;
  gameName: string;
  onClose: () => void;
  postAnimExitDelayMs?: number;
  onPostAnimExitDelayChange?: (ms: number) => void;
}

interface TestConfig {
  numberOfTeams: number;
  goodAnswerPercent: number;
  badAnswerPercent: number;
  noAnswerPercent: number;
  selectedDeviceId: string;
  /**
   * TagQuest: how many stale punches to put on the card BEFORE the ones being
   * simulated, as if the player never wiped it. Exercises the `tqbase:`
   * baseline - they must be ignored while the fresh punches still score.
   */
  tqStalePunches: number;
}

interface TestResult {
  teamName: string;
  score: number;
  status: 'success' | 'error';
  message: string;
}

interface TestTeam {
  id: number;
  team_name: string;
  key_id: string;
  start_time: number | null;
  end_time: number | null;
  score: number;
}

interface Device {
  id: number;
  device_id: string;
  connected: boolean;
  last_connexion_attempt: string;
}

interface QuestImage {
  key: string;
  label: string;
}

interface Quest {
  index: number;
  number: string;
  text: string;
  images: QuestImage[];
}

export function GameTestModal({ gameId, gameName, onClose, postAnimExitDelayMs = 0, onPostAnimExitDelayChange }: GameTestModalProps) {
  const [gameType, setGameType] = useState<string | null>(null);
  const [loadingType, setLoadingType] = useState(true);

  const [testConfig, setTestConfig] = useState<TestConfig>({
    numberOfTeams: 3,
    goodAnswerPercent: 60,
    badAnswerPercent: 20,
    noAnswerPercent: 20,
    selectedDeviceId: '',
    tqStalePunches: 0,
  });
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [testRunning, setTestRunning] = useState(false);
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [testLog, setTestLog] = useState<string[]>([]);
  const [percentError, setPercentError] = useState('');

  const [quests, setQuests] = useState<Quest[]>([]);
  const [loadingQuests, setLoadingQuests] = useState(false);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [gameUniqid, setGameUniqid] = useState<string | null>(null);
  const [endChip, setEndChip] = useState(false);
  // Map of media filename → webview-loadable URL, populated when gameUniqid is set.
  const [scenarioMediaUrls, setScenarioMediaUrls] = useState<Record<string, string>>({});


  const totalPercent = testConfig.goodAnswerPercent + testConfig.badAnswerPercent + testConfig.noAnswerPercent;

  useEffect(() => {
    loadDevices();
    detectGameType();
  }, [gameId]);

  // When gameUniqid resolves, walk the scenario's local media dir to build
  // filename → URL lookups for the quest-image picker thumbnails.
  useEffect(() => {
    if (!gameUniqid) return;
    let cancelled = false;
    (async () => {
      try {
        // Media now lives in the content-addressed blob pool; resolve the
        // scenario's active manifest into a filename -> blob URL map.
        const map = await scenarioStore.listMediaUrlMap(gameUniqid);
        if (!cancelled) setScenarioMediaUrls(map);
      } catch (err) {
        console.warn('[GameTestModal] media URL build failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [gameUniqid]);

  const detectGameType = async () => {
    setLoadingType(true);
    try {
      const state = await getLaunchedGameState(gameId, 0);
      setGameType(state.game_type);

      if (state.game_type?.toLowerCase() === 'tagquest' && state.game_uniqid) {
        setGameUniqid(state.game_uniqid);
        setLoadingQuests(true);
        const gdjRaw = (await scenarioStore.getGameData(state.game_uniqid)) as any;
        const gdj = gdjRaw?.game_data ?? gdjRaw;
        if (gdj) {
          const rawQuestsSrc = gdj?.quests || gdj?.game_quests || [];
          const rawQuests: any[] = Array.isArray(rawQuestsSrc) ? rawQuestsSrc : Object.values(rawQuestsSrc);
          const stripMedia = (name: string) => name.replace(/^media[/\\]/i, '').replace(/^media[/\\]/i, '');
          const mediaMap = buildMediaMap(gdj?.game_media_images, stripMedia);

          const parsedQuests: Quest[] = rawQuests.map((q: any, idx: number) => {
            const images: QuestImage[] = [];
            const resolve = (id: string) => mediaMap.get(String(id)) ?? id;
            if (q.main_image) images.push({ key: resolve(q.main_image), label: 'Main' });
            for (let i = 1; i <= 4; i++) {
              if (q[`image_${i}`]) images.push({ key: resolve(q[`image_${i}`]), label: `Image ${i}` });
            }
            return { index: idx + 1, number: q.number ?? '', text: q.text ?? '', images };
          });
          setQuests(parsedQuests);
        }
        setLoadingQuests(false);
      }
    } catch (err) {
      console.error('[GameTestModal] detectGameType failed:', err);
    } finally {
      setLoadingType(false);
    }
  };

  const loadDevices = async () => {
    setLoadingDevices(true);
    try {
      const rows = await getLaunchedGameDevices(gameId);
      const mapped = rows.map((r) => ({
        id: r.id,
        device_id: r.device_label ?? `device-${r.device_id}`,
        connected: Boolean(r.connected),
        last_connexion_attempt: r.last_connection_attempt,
      }));
      setDevices(mapped as any);
      if (mapped.length > 0) {
        setTestConfig((prev) => ({ ...prev, selectedDeviceId: mapped[0].device_id }));
      }
    } catch (err) {
      console.error('[GameTestModal] loadDevices failed:', err);
    } finally {
      setLoadingDevices(false);
    }
  };

  const handleChange = (field: keyof TestConfig, value: number | string) => {
    setTestConfig(prev => ({ ...prev, [field]: value }));
    setPercentError('');
  };

  const appendLog = (msg: string) => {
    setTestLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const toggleImage = (key: string, quest: Quest) => {
    setSelectedImages(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      const mainImg = quest.images.find(i => i.label === 'Main');
      const otherKeys = quest.images.filter(i => i.label !== 'Main').map(i => i.key);
      const allOthersSelected = otherKeys.length > 0 && otherKeys.every(k => next.has(k));
      if (mainImg) {
        if (allOthersSelected) next.add(mainImg.key);
        else next.delete(mainImg.key);
      }
      return next;
    });
  };

  const selectQuestAll = (quest: Quest) => {
    const allKeys = quest.images.map(i => i.key);
    setSelectedImages(prev => {
      const allSelected = allKeys.every(k => prev.has(k));
      const next = new Set(prev);
      if (allSelected) {
        allKeys.forEach(k => next.delete(k));
      } else {
        allKeys.forEach(k => next.add(k));
      }
      return next;
    });
  };

  const buildMockCard = (teamKeyId: string, patternEnigmas: any[], goodPct: number, badPct: number): any => {
    const punches: Array<{ code: string; time: number }> = [];
    const now = Math.floor(Date.now() / 1000);

    for (const enigma of patternEnigmas) {
      const roll = Math.random() * 100;
      if (roll < goodPct && enigma.good_answers.length > 0) {
        const answer = enigma.good_answers[Math.floor(Math.random() * enigma.good_answers.length)];
        punches.push({ code: answer, time: now });
      } else if (roll < goodPct + badPct && enigma.wrong_answers.length > 0) {
        const answer = enigma.wrong_answers[Math.floor(Math.random() * enigma.wrong_answers.length)];
        punches.push({ code: answer, time: now });
      }
    }

    return {
      id: teamKeyId,
      series: 0,
      nbPunch: punches.length,
      start: { code: '255', time: now - 600 },
      check: null,
      end: null,
      punches,
    };
  };

  type PatternItem = patternStore.PatternRoutingItem;

  const loadPatternItems = async (patternUniqid: string): Promise<PatternItem[]> => {
    try {
      const routing = await patternStore.getRouting(patternUniqid);
      if (routing.length > 0) {
        appendLog(`Pattern loaded from local store: ${patternUniqid}`);
      } else {
        appendLog(`Pattern uniqid not found in local store: ${patternUniqid}`);
      }
      return routing;
    } catch (e) {
      appendLog(`Local pattern store error: ${e}`);
      return [];
    }
  };

  // Real SI punch times are local "HH:MM:SS" time-of-day strings (see the Rust
  // `Punch::time_hms`), NOT epoch seconds. The mock used to emit epochs, which
  // made the simulated card structurally unlike a real one: `punchSecondsOfDay`
  // rejected every time, so the scorer's ordering and its double-bip collapse
  // both silently degraded and the whole class of bugs behind client report
  // #101 was unreproducible without hardware. Keep this in the real shape.
  const hms = (epochSec: number): string => {
    const d = new Date(epochSec * 1000);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
  };

  const buildTagQuestMockCard = (
    teamKeyId: string,
    selectedImageKeys: Set<string>,
    patternItems: PatternItem[],
    withEnd: boolean,
    stalePunches = 0,
  ): any => {
    const now = Math.floor(Date.now() / 1000);

    const itemMap: Record<string, number> = {};
    patternItems.forEach(p => {
      itemMap[`${p.item_index}:${p.assignment_type}`] = p.station_key_number;
    });

    const punches: Array<{ code: number; time: string }> = [];
    for (const quest of quests) {
      for (const img of quest.images) {
        if (!selectedImageKeys.has(img.key)) continue;
        if (img.label === 'Main') continue;
        const imgIndexMatch = img.label.match(/^Image\s+(\d+)$/i);
        if (!imgIndexMatch) continue;
        const imgIndex = parseInt(imgIndexMatch[1], 10);
        const assignmentType = `image_${imgIndex}`;
        const stationKey = itemMap[`${quest.index}:${assignmentType}`];
        if (stationKey !== undefined) {
          punches.push({ code: stationKey, time: hms(now) });
        }
      }
    }

    // "Player forgot to wipe": stale marks on the SAME stations, an hour back,
    // prepended in card order (SI cards are append-only, oldest first). They
    // must be caught by the baseline snapshot, not by any clock comparison.
    const stale: Array<{ code: number; time: string }> = [];
    const stationPool = [...new Set(patternItems.map((p) => p.station_key_number))];
    for (let i = 0; i < stalePunches && stationPool.length > 0; i++) {
      stale.push({
        code: stationPool[i % stationPool.length],
        time: hms(now - 3600 - i * 60),
      });
    }
    const allPunches = [...stale, ...punches];

    return {
      id: teamKeyId,
      series: 4,
      cardType: 'SI11',
      nbPunch: allPunches.length,
      start: { code: 255, time: hms(now - 600) },
      check: null,
      end: withEnd ? { code: 254, time: hms(now) } : null,
      punches: allPunches,
    };
  };

  const runTest = async () => {
    if (gameType !== 'tagquest' && totalPercent !== 100) {
      setPercentError('Percentages must add up to exactly 100%');
      return;
    }

    setTestRunning(true);
    setTestResults([]);
    setTestLog([]);

    const deviceLabel = testConfig.selectedDeviceId || 'game_test_simulator';
    appendLog(`Starting test simulation on device: ${deviceLabel}`);

    try {
      const state = await getLaunchedGameState(gameId, 0);
      const teams: TestTeam[] = state.teams.map((t) => ({
        id: t.id,
        team_name: t.team_name ?? '',
        key_id: t.key_id ?? 0,
        start_time: t.start_time,
        end_time: t.end_time,
        score: t.score,
      })) as any;
      if (teams.length === 0) {
        appendLog('No teams found. Please create teams before running a test.');
        setTestRunning(false);
        return;
      }

      const teamsToTest = teams.slice(0, testConfig.numberOfTeams);
      appendLog(`Simulating ${teamsToTest.length} team(s)`);

      const meta = await getLaunchedGameMeta(gameId);

      if (gameType?.toLowerCase() === 'tagquest') {
        appendLog(`Selected ${selectedImages.size} image(s) across ${quests.length} quest(s)`);
        const tqPatternUniqid = meta.pattern || '';
        appendLog(`Loading pattern items: ${tqPatternUniqid}`);
        const tqPatternItems = await loadPatternItems(tqPatternUniqid);
        appendLog(`Loaded ${tqPatternItems.length} pattern item(s)`);

        // Each simulated team gets a fresh consumed-punch pool, mirroring how the
        // live TagQuestGamePage owns one set per game instance.
        const tqConsumed = new Map<number, Set<string>>();
        // ...and a baseline map, mirroring the `tqbase:` meta the live page
        // snapshots when a chip is first seen. Without this the simulator can't
        // exercise the only remaining stale-card defence.
        const tqBaselines = new Map<number, Set<string>>();
        const tqPlayMode = (meta.playMode === 'team' ? 'team' : 'solo') as 'solo' | 'team';
        const results: TestResult[] = [];
        for (const team of teamsToTest) {
          appendLog(`Processing: ${team.team_name}`);

          if (team.start_time || team.end_time) {
            await updateTeam(team.id, { start_time: null, end_time: null, score: 0 });
            appendLog('  Reset previous run');
          }

          const startTime = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 1200 + 300);
          await updateTeam(team.id, { start_time: startTime });

          const mockCard = buildTagQuestMockCard(
            team.key_id,
            selectedImages,
            tqPatternItems,
            endChip,
            testConfig.tqStalePunches,
          );
          appendLog(`Punch: ${JSON.stringify(mockCard)}`);
          await recordPunch(gameId, mockCard);

          // The stale punches are prepended, so they are exactly the first N -
          // i.e. what would have been on the card at its baseline moment. The
          // fresh ones came after and must still score.
          const staleIds: string[] = mockCard.punches
            .slice(0, testConfig.tqStalePunches)
            .map((p: { code: number; time: string }) => `${p.code}@${p.time}`);
          if (staleIds.length > 0) {
            tqBaselines.set(mockCard.id, new Set(staleIds));
            appendLog(`  card not wiped: ${staleIds.length} pre-existing punch(es) baselined`);
          }

          // Score the punch here. The live game page now only processes punches
          // its own reader read (so a bip animates on just that device), and no
          // longer scores the punches this simulator injects - so we run the same
          // scoring logic directly to produce the team's result.
          const punchResult = await processTagQuestPunch(
            mockCard,
            gameId,
            state.game_uniqid || '',
            tqPlayMode,
            [],
            () => '',
            tqConsumed,
            new Map(),
            tqBaselines,
          );
          appendLog(`  ${punchResult.status} - score ${punchResult.new_total_score}`);
          for (const d of punchResult.dropped_punches ?? []) {
            appendLog(`  ignored station ${d.code} @ ${d.time} (${d.reason})`);
          }
          if (punchResult.card_full) appendLog('  CARD FULL - stations can write no more to it');
          results.push({
            teamName: team.team_name,
            score: punchResult.new_total_score,
            status: punchResult.status === 'ok' ? 'success' : 'error',
            message:
              punchResult.status === 'ok'
                ? `Score ${punchResult.new_total_score}`
                : punchResult.message || punchResult.status,
          });
          await new Promise((r) => setTimeout(r, 150));
        }
        setTestResults(results);
        appendLog('Simulation complete.');
        return;
      }

      if (gameType?.toLowerCase() === 'tracks') {
        const trPattern = meta.pattern || '';
        appendLog(`Loading tracks pattern: ${trPattern}`);
        const trStations = await patternStore.getTracksCheckpointStations(trPattern);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let checkpoints: any[] = [];
        if (state.game_uniqid) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const gdj = (await scenarioStore.getGameData(state.game_uniqid)) as any;
          checkpoints = gdj?.game_meta?.checkpoints ?? gdj?.game_data?.game_meta?.checkpoints ?? [];
        }
        const launchRoute = meta.route || 'default';
        const scoreType = (meta.scoreType as TracksScoreType) || 'percentage';
        appendLog(`${checkpoints.length} checkpoint(s); ${trStations.size} mapped in pattern; route ${launchRoute}`);
        if (trStations.size === 0) {
          appendLog('Warning: pattern has no checkpoint→station rows - scoring will be 0.');
        }
        // SI clock string "HH:MM:SS" from unix seconds (for itinerary ordering).
        const toClock = (sec: number) =>
          [new Date(sec * 1000).getHours(), new Date(sec * 1000).getMinutes(), new Date(sec * 1000).getSeconds()]
            .map((n) => String(n).padStart(2, '0'))
            .join(':');

        const results: TestResult[] = [];
        for (const team of teamsToTest) {
          appendLog(`Processing: ${team.team_name}`);
          if (team.start_time || team.end_time) {
            await updateTeam(team.id, { start_time: null, end_time: null, score: 0 });
            appendLog('  Reset previous run');
          }
          const startTime = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 1200 + 300);
          await updateTeam(team.id, { start_time: startTime });

          // Per-team route override (manual Add Team) else the launch default.
          const teamRoute = meta[`route:${team.id}`] || launchRoute;
          const routeCps = checkpointsForRoute(checkpoints, teamRoute);

          // Randomly "hit" route checkpoints per the Good% slider, punching the
          // checkpoint's first pattern station (code matched the way the runtime
          // matches it).
          const punches: Array<{ code: number; time: string }> = [];
          const hitIds = new Set<string>();
          let t = startTime + 60;
          for (let i = 0; i < checkpoints.length; i++) {
            const cp = checkpoints[i];
            if (!routeCps.some((c) => c.id === cp.id)) continue;
            const cpStations = trStations.get(i + 1) ?? [];
            if (cpStations.length === 0) continue;
            if (Math.random() * 100 < testConfig.goodAnswerPercent) {
              punches.push({ code: cpStations[0], time: toClock(t) });
              hitIds.add(cp.id);
              t += 90;
            }
          }

          const mockCard = {
            id: team.key_id,
            series: 0,
            cardType: 'SI11',
            nbPunch: punches.length,
            start: null,
            check: null,
            end: null,
            punches,
          };
          await recordPunch(gameId, mockCard);

          const endTime = Math.floor(Date.now() / 1000);
          const score = computeScore({
            routeCheckpoints: routeCps,
            hitCheckpointIds: hitIds,
            scoreType,
            elapsedMinutes: (endTime - startTime) / 60,
            timeLimitMinutes: 60, // under the limit for a quick sim → no malus
            malusPerMinute: 0,
          });
          await updateTeam(team.id, { end_time: endTime, score });
          appendLog(`  Done - ${hitIds.size}/${routeCps.length} checkpoint(s), score ${score}`);
          results.push({
            teamName: team.team_name,
            score,
            status: 'success',
            message: `${hitIds.size}/${routeCps.length} checkpoints - score ${score}`,
          });
          await new Promise((r) => setTimeout(r, 150));
        }
        setTestResults(results);
        appendLog('Simulation complete. (To see the on-screen reveal, bip a card on the live game display.)');
        return;
      }

      // Mystery mode below.
      const patternUniqid = meta.pattern || '';
      appendLog(`Loading pattern: ${patternUniqid}`);
      const patternEnigmas = await patternStore.getMysteryEnigmas(patternUniqid);

      if (patternEnigmas.length === 0) {
        appendLog('Warning: No pattern enigmas loaded (pattern file may not be available here)');
      } else {
        appendLog(`Loaded ${patternEnigmas.length} enigmas`);
      }

      let enigmasForScoring: any[] = [];
      if (state.game_uniqid) {
        const gdj = (await scenarioStore.getGameData(state.game_uniqid)) as any;
        enigmasForScoring = gdj?.game_enigmas ?? gdj?.game_data?.game_enigmas ?? [];
      }

      const results: TestResult[] = [];
      for (const team of teamsToTest) {
        appendLog(`Processing: ${team.team_name}`);

        if (team.start_time || team.end_time) {
          await updateTeam(team.id, { start_time: null, end_time: null, score: 0 });
          appendLog('  Reset previous run');
        }

        const startTime = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 1200 + 300);
        await updateTeam(team.id, { start_time: startTime });

        const mockCard = buildMockCard(
          team.key_id,
          patternEnigmas,
          testConfig.goodAnswerPercent,
          testConfig.badAnswerPercent
        );
        await recordPunch(gameId, mockCard);

        let totalScore = 0;
        if (enigmasForScoring.length > 0 && patternEnigmas.length > 0) {
          const cardCodes = mockCard.punches.map((p: any) => p.code.toString());
          for (const enigma of patternEnigmas) {
            const ge = enigmasForScoring.find((e: any) => e.number === enigma.enigma_id);
            const goodPts = parseInt(ge?.good_answer_points || '0');
            // Signed (a legacy positive magnitude folds to its negative).
            const wrongPts = wrongAnswerPoints(ge?.wrong_answer_points);
            const hasGood = enigma.good_answers.some((a: string) => cardCodes.includes(a));
            const hasBad = enigma.wrong_answers.some((a: string) => cardCodes.includes(a));
            if (hasGood && !hasBad) totalScore += goodPts;
            else if (hasBad && !hasGood) totalScore += wrongPts;
          }
        } else if (patternEnigmas.length === 0) {
          totalScore = mockCard.punches.length * 10;
        }

        const endTime = Math.floor(Date.now() / 1000);
        try {
          await updateTeam(team.id, { end_time: endTime, score: totalScore });
          const duration = endTime - startTime;
          const mins = Math.floor(duration / 60);
          const secs = duration % 60;
          const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
          appendLog(`  Done - Score: ${totalScore}, Time: ${timeStr}`);
          results.push({
            teamName: team.team_name,
            score: totalScore,
            status: 'success',
            message: `Score: ${totalScore} - Time: ${timeStr}`,
          });
        } catch (endErr: any) {
          appendLog(`  Error: ${endErr?.message || endErr}`);
          results.push({ teamName: team.team_name, score: 0, status: 'error', message: endErr?.message || String(endErr) });
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      setTestResults(results);
      appendLog('Simulation complete.');
    } catch (err: any) {
      appendLog(`Unexpected error: ${err?.message || String(err)}`);
    } finally {
      setTestRunning(false);
    }
  };

  return (
    <div className="pg-overlay" onClick={onClose}>
      <div
        className="pg-modal max-w-lg max-h-[85vh] overflow-y-auto p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xl font-bold text-[var(--pg-text)] flex items-center gap-2">
            <FlaskConical size={22} className="text-amber-400" />
            Run Game Test
          </h3>
          <button onClick={onClose} className="pg-modal-close">
            <X size={22} />
          </button>
        </div>

        <p className="text-[var(--pg-text-dim)] text-xs mb-5">
          Game: <span className="text-[var(--pg-text)] font-medium">{gameName}</span>
        </p>

        {loadingType ? (
          <div className="flex items-center justify-center py-8 gap-2 text-[var(--pg-text-dim)]">
            <Loader size={18} className="animate-spin" />
            <span className="text-sm">Loading game configuration...</span>
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <label className="pg-label block mb-2">
                Connected Device
              </label>
              {loadingDevices ? (
                <div className="flex items-center gap-2 text-[var(--pg-text-dim)] text-sm py-2">
                  <Loader size={14} className="animate-spin" />
                  Loading devices...
                </div>
              ) : devices.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)] border border-[var(--pg-line)]">
                  <Monitor size={16} className="text-[var(--pg-text-dim)]" />
                  <span className="text-[var(--pg-text-dim)] text-sm">No connected devices - will use simulator</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {devices.map(device => (
                    <label
                      key={device.id}
                      className={`flex items-center gap-3 px-4 py-3 rounded-[var(--pg-radius-md)] border cursor-pointer transition ${
                        testConfig.selectedDeviceId === device.device_id
                          ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)]'
                          : 'border-[var(--pg-line)] bg-[var(--pg-surface-2)] hover:border-[var(--pg-line-strong)]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="device"
                        value={device.device_id}
                        checked={testConfig.selectedDeviceId === device.device_id}
                        onChange={() => handleChange('selectedDeviceId', device.device_id)}
                        className="sr-only"
                      />
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${device.connected ? 'bg-green-400' : 'bg-[var(--pg-text-dim)]'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[var(--pg-text)] text-sm font-medium truncate">{device.device_id}</p>
                        <p className="text-[var(--pg-text-dim)] text-xs">
                          {device.connected ? 'Connected' : 'Disconnected'} · last seen {new Date(device.last_connexion_attempt).toLocaleTimeString()}
                        </p>
                      </div>
                      {testConfig.selectedDeviceId === device.device_id && (
                        <CheckCircle size={16} className="text-[var(--pg-accent-bright)] shrink-0" />
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="pg-label block mb-2">
                Number of Teams to Test
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={testConfig.numberOfTeams}
                onChange={e => handleChange('numberOfTeams', Math.max(1, parseInt(e.target.value) || 1))}
                className="pg-input"
              />
            </div>

            {gameType?.toLowerCase() === 'tagquest' ? (
              <div>
                <div className="mb-3">
                  <label className="pg-label" htmlFor="tqStalePunches">
                    Stale punches on the card (not wiped)
                  </label>
                  <input
                    id="tqStalePunches"
                    type="number"
                    min={0}
                    max={20}
                    value={testConfig.tqStalePunches}
                    onChange={(e) => handleChange('tqStalePunches', parseInt(e.target.value, 10) || 0)}
                    className="pg-input"
                  />
                  <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                    Prepends this many hour-old punches from a &ldquo;previous game&rdquo;. They must be
                    ignored by the baseline while the fresh ones below still score.
                  </div>
                </div>

                <div className="flex items-center mb-3">
                  <label className="pg-label flex items-center gap-2">
                    <ImageIcon size={15} className="text-[var(--pg-accent-bright)]" />
                    Quest Images Found
                  </label>
                </div>

                {loadingQuests ? (
                  <div className="flex items-center gap-2 text-[var(--pg-text-dim)] text-sm py-3">
                    <Loader size={14} className="animate-spin" />
                    Loading quests...
                  </div>
                ) : quests.length === 0 ? (
                  <div className="px-4 py-3 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] text-[var(--pg-text-dim)] text-sm">
                    No quests found for this game.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {quests.map(quest => {
                      const questKeys = quest.images.map(i => i.key);
                      const questAllSelected = questKeys.length > 0 && questKeys.every(k => selectedImages.has(k));
                      const questSomeSelected = questKeys.some(k => selectedImages.has(k));
                      return (
                        <div key={quest.index} className="bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] overflow-hidden">
                          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--pg-line)]">
                            <span className="text-sm font-medium text-[var(--pg-text)]">
                              Quest {quest.index}
                            </span>
                            <button
                              onClick={() => selectQuestAll(quest)}
                              className={`flex items-center gap-1 text-xs transition ${
                                questAllSelected ? 'text-[var(--pg-accent-bright)]' : questSomeSelected ? 'text-[var(--pg-accent)]' : 'text-[var(--pg-text-dim)] hover:text-[var(--pg-text)]'
                              }`}
                            >
                              {questAllSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                              All
                            </button>
                          </div>
                          <div className="p-2 flex gap-2">
                            {(() => {
                              const mainImg = quest.images.find(i => i.label === 'Main');
                              const otherImgs = quest.images.filter(i => i.label !== 'Main');
                              const renderImg = (img: typeof quest.images[0], large = false) => {
                                const checked = selectedImages.has(img.key);
                                const isMain = img.label === 'Main';
                                const safeKey = img.key.replace(/^media[/\\]/i, '').replace(/^media[/\\]/i, '');
                                // Slice 2: media files come from the local
                                // SQLite/FS store; resolve to a webview URL.
                                const imgSrc = scenarioMediaUrls[safeKey] ?? '';
                                return (
                                  <button
                                    key={img.key}
                                    onClick={() => isMain ? selectQuestAll(quest) : toggleImage(img.key, quest)}
                                    className={`relative flex flex-col items-center gap-1 rounded-[var(--pg-radius-md)] border-2 overflow-hidden transition ${
                                      checked
                                        ? 'border-[var(--pg-accent)] ring-1 ring-[var(--pg-accent-line)]'
                                        : 'border-[var(--pg-line)] hover:border-[var(--pg-line-strong)]'
                                    } ${large ? 'w-full h-full' : ''}`}
                                  >
                                    <div className={`w-full bg-[var(--pg-bg)] ${large ? 'flex-1' : ''}`} style={large ? { height: 148 } : { height: 60 }}>
                                      <img
                                        src={imgSrc}
                                        alt={img.label}
                                        className="w-full h-full object-cover"
                                        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                                      />
                                    </div>
                                    <span className={`text-[10px] font-medium pb-1 px-1 truncate w-full text-center ${checked ? 'text-[var(--pg-accent-bright)]' : 'text-[var(--pg-text-dim)]'}`}>
                                      {img.label}
                                    </span>
                                    {checked && (
                                      <div className="absolute top-1 right-1 bg-[var(--pg-accent)] rounded-full p-0.5">
                                        <CheckCircle size={9} className="text-[var(--pg-text)]" />
                                      </div>
                                    )}
                                  </button>
                                );
                              };
                              return (
                                <>
                                  {otherImgs.length > 0 && (
                                    <div className="grid grid-cols-2 gap-1.5" style={{ width: 168 }}>
                                      {otherImgs.map(img => (
                                        <div key={img.key}>
                                          {renderImg(img, false)}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {mainImg && (
                                    <div className="shrink-0" style={{ width: 140 }}>
                                      {renderImg(mainImg, true)}
                                    </div>
                                  )}
                                  {!mainImg && quest.images.filter(i => i.label === 'Main').length === 0 && quest.images.map(img => (
                                    <div key={img.key} style={{ width: 80 }}>
                                      {renderImg(img, false)}
                                    </div>
                                  ))}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {(() => {
                  const answerCount = quests.flatMap(q => q.images.filter(i => i.label !== 'Main')).filter(i => selectedImages.has(i.key)).length;
                  const completeCount = quests.filter(q => {
                    const answers = q.images.filter(i => i.label !== 'Main');
                    return answers.length > 0 && answers.every(i => selectedImages.has(i.key));
                  }).length;
                  const hasAny = answerCount > 0 || completeCount > 0;
                  return (
                    <div className={`mt-3 flex items-center justify-between text-sm px-3 py-2 rounded-[var(--pg-radius-md)] ${
                      hasAny ? 'bg-[var(--pg-accent-tint)] text-[var(--pg-accent-bright)]' : 'bg-[var(--pg-surface-2)] text-[var(--pg-text-dim)]'
                    }`}>
                      <span>
                        {answerCount} image{answerCount !== 1 ? 's' : ''} selected
                        {completeCount > 0 && <span className="ml-2 opacity-75">· {completeCount} complete</span>}
                      </span>
                      <span className="text-xs font-medium">Score: {answerCount * 10} pts</span>
                    </div>
                  );
                })()}

                <label className="mt-3 flex items-center gap-2.5 cursor-pointer select-none">
                  <button
                    type="button"
                    onClick={() => setEndChip(v => !v)}
                    className={`flex items-center justify-center w-4 h-4 rounded border transition ${endChip ? 'bg-[var(--pg-accent)] border-[var(--pg-accent)]' : 'bg-transparent border-[var(--pg-line-strong)]'}`}
                  >
                    {endChip && <CheckCircle size={10} className="text-[var(--pg-text)]" />}
                  </button>
                  <span className="text-sm text-[var(--pg-text-muted)]">End chip</span>
                </label>

                <label className="mt-2 flex items-center gap-2.5 cursor-pointer select-none">
                  <button
                    type="button"
                    onClick={() => onPostAnimExitDelayChange?.(postAnimExitDelayMs > 0 ? 0 : 10000)}
                    className={`flex items-center justify-center w-4 h-4 rounded border transition ${postAnimExitDelayMs > 0 ? 'bg-[var(--pg-accent)] border-[var(--pg-accent)]' : 'bg-transparent border-[var(--pg-line-strong)]'}`}
                  >
                    {postAnimExitDelayMs > 0 && <CheckCircle size={10} className="text-[var(--pg-text)]" />}
                  </button>
                  <span className="text-sm text-[var(--pg-text-muted)]">Keep animation visible for 10s after completion</span>
                </label>
              </div>
            ) : (
              <div>
                <label className="pg-label block mb-3">Answer Distribution</label>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-2 h-2 rounded-full bg-green-400" />
                      <span className="text-xs text-[var(--pg-text-muted)] font-medium">Good</span>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={testConfig.goodAnswerPercent}
                        onChange={e => handleChange('goodAnswerPercent', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                        className="pg-input !pr-7 !py-2 text-sm"
                      />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] text-xs pointer-events-none">%</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-2 h-2 rounded-full bg-red-400" />
                      <span className="text-xs text-[var(--pg-text-muted)] font-medium">Bad</span>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={testConfig.badAnswerPercent}
                        onChange={e => handleChange('badAnswerPercent', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                        className="pg-input !pr-7 !py-2 text-sm"
                      />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] text-xs pointer-events-none">%</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-2 h-2 rounded-full bg-[var(--pg-text-dim)]" />
                      <span className="text-xs text-[var(--pg-text-muted)] font-medium">None</span>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={testConfig.noAnswerPercent}
                        onChange={e => handleChange('noAnswerPercent', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                        className="pg-input !pr-7 !py-2 text-sm"
                      />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] text-xs pointer-events-none">%</span>
                    </div>
                  </div>
                </div>

                <div className={`mt-3 flex items-center justify-between text-sm px-3 py-2 rounded-[var(--pg-radius-md)] ${totalPercent === 100 ? 'bg-green-900/25 text-green-400' : 'bg-red-900/25 text-red-400'}`}>
                  <span>Total: <span className="font-semibold">{totalPercent}%</span></span>
                  <span className="font-medium text-xs">{totalPercent === 100 ? 'Ready' : 'Must equal 100%'}</span>
                </div>

                {percentError && <p className="text-red-400 text-xs mt-1">{percentError}</p>}
              </div>
            )}

            <button
              onClick={runTest}
              disabled={testRunning || (gameType !== 'tagquest' && totalPercent !== 100)}
              className="pg-btn pg-btn--primary w-full !py-3 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {testRunning ? (
                <>
                  <Loader size={18} className="animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Play size={18} />
                  Run Test
                </>
              )}
            </button>
          </div>
        )}

        {testLog.length > 0 && (
          <div className="mt-5">
            <h5 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-2">Log</h5>
            <div className="bg-[var(--pg-bg)] rounded-[var(--pg-radius-md)] p-3 max-h-36 overflow-y-auto font-mono text-xs text-[var(--pg-text-dim)] space-y-0.5">
              {testLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </div>
        )}

        {testResults.length > 0 && (
          <div className="mt-4">
            <h5 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-2">Results</h5>
            <div className="space-y-2">
              {testResults.map((result, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg ${
                    result.status === 'success'
                      ? 'bg-green-900/20 border border-green-800/40'
                      : 'bg-red-900/20 border border-red-800/40'
                  }`}
                >
                  {result.status === 'success' ? (
                    <CheckCircle size={16} className="text-green-400 shrink-0" />
                  ) : (
                    <AlertCircle size={16} className="text-red-400 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-[var(--pg-text)] text-sm font-medium">{result.teamName}</p>
                    <p className="text-[var(--pg-text-dim)] text-xs">{result.message}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
