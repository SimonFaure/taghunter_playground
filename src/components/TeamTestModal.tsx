import { useState, useEffect } from 'react';
import { X, FlaskConical, Play, CheckCircle, AlertCircle, Loader, Monitor, Users, Image as ImageIcon, CheckSquare, Square, ChevronDown, Search } from 'lucide-react';
import * as scenarioStore from '../services/scenarioStore';
import * as patternStore from '../services/patternStore';
import {
  getLaunchedGameState,
  getLaunchedGameMeta,
  getLaunchedGameDevices,
  recordPunch,
  updateTeam,
} from '../services/launchedGames';

interface TeamTestModalProps {
  gameId: number;
  gameName: string;
  team: {
    id: number;
    team_name: string;
    team_number: number;
    key_id: number;
  };
  onClose: () => void;
}

interface TestConfig {
  goodAnswerPercent: number;
  badAnswerPercent: number;
  noAnswerPercent: number;
  selectedDeviceId: string;
}

interface TestResult {
  teamName: string;
  score: number;
  status: 'success' | 'error';
  message: string;
}

interface Device {
  id: number;
  device_id: string;
  connected: boolean;
  last_connexion_attempt: string;
}

interface TeamMember {
  id: number;
  team_name: string;
  team_number: number;
  key_id: number;
}

interface QuestImage {
  key: string;
  label: string;
}

interface Quest {
  index: number;
  number: string;
  text: string;
  name: string;
  points: number;
  images: QuestImage[];
}

export function TeamTestModal({ gameId, gameName, team, onClose }: TeamTestModalProps) {
  const [gameType, setGameType] = useState<string | null>(null);
  const [loadingType, setLoadingType] = useState(true);

  const [testConfig, setTestConfig] = useState<TestConfig>({
    goodAnswerPercent: 60,
    badAnswerPercent: 20,
    noAnswerPercent: 20,
    selectedDeviceId: '',
  });
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testLog, setTestLog] = useState<string[]>([]);
  const [percentError, setPercentError] = useState('');

  const [quests, setQuests] = useState<Quest[]>([]);
  const [loadingQuests, setLoadingQuests] = useState(false);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [gameUniqid, setGameUniqid] = useState<string | null>(null);
  const [endChip, setEndChip] = useState(false);
  const [keepAnimVisible, setKeepAnimVisible] = useState(() => localStorage.getItem('tagquest_keep_anim_visible') === '1');
  // Map of media filename → webview-loadable URL, populated when gameUniqid resolves.
  const [scenarioMediaUrls, setScenarioMediaUrls] = useState<Record<string, string>>({});

  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<TeamMember>(team);
  const [teamDropdownOpen, setTeamDropdownOpen] = useState(false);
  const [teamSearch, setTeamSearch] = useState('');


  const totalPercent = testConfig.goodAnswerPercent + testConfig.badAnswerPercent + testConfig.noAnswerPercent;

  useEffect(() => {
    loadDevices();
    detectGameType();
    loadTeamMembers();
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
        console.warn('[TeamTestModal] media URL build failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [gameUniqid]);

  const loadTeamMembers = async () => {
    try {
      const state = await getLaunchedGameState(gameId, 0);
      const members: TeamMember[] = state.teams
        .map((t) => ({
          id: t.id,
          team_name: t.team_name ?? '',
          team_number: t.team_number,
          key_id: t.key_id ?? 0,
        }))
        .sort((a, b) => a.team_number - b.team_number);
      setTeamMembers(members);
    } catch (err) {
      console.error('[TeamTestModal] loadTeamMembers failed:', err);
    }
  };

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
          const rawQuests: any[] = gdj?.quests || gdj?.game_quests || [];
          const stripMedia = (name: string) => name.replace(/^media[/\\]/i, '').replace(/^media[/\\]/i, '');
          const mediaImages: Array<{ id: string; file_name: string }> = gdj?.game_media_images || [];
          const mediaMap = new Map(mediaImages.map((m) => [String(m.id), stripMedia(m.file_name)]));

          const parsedQuests: Quest[] = rawQuests.map((q: any, idx: number) => {
            const images: QuestImage[] = [];
            const resolve = (id: string) => mediaMap.get(String(id)) ?? id;
            if (q.main_image) images.push({ key: resolve(q.main_image), label: 'Main' });
            for (let i = 1; i <= 4; i++) {
              if (q[`image_${i}`]) images.push({ key: resolve(q[`image_${i}`]), label: `Image ${i}` });
            }
            const rawPts = q.points ?? q.point ?? 0;
            const points = typeof rawPts === 'string' ? parseInt(rawPts, 10) || 0 : rawPts;
            return { index: idx + 1, number: q.number ?? '', text: q.text ?? '', name: q.name ?? q.title ?? '', points, images };
          });
          setQuests(parsedQuests);
        }
        setLoadingQuests(false);
      }
    } catch (err) {
      console.error('[TeamTestModal] detectGameType failed:', err);
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
      console.error('[TeamTestModal] loadDevices failed:', err);
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
      end: { code: '254', time: now },
      punches,
    };
  };

  type PatternItem = patternStore.PatternRoutingItem;

  const loadPatternItems = async (patternUniqid: string): Promise<PatternItem[]> => {
    try {
      const routing = await patternStore.getRouting(patternUniqid);
      if (routing.length === 0) {
        appendLog(`No pattern items found for uniqid: ${patternUniqid}`);
      }
      return routing;
    } catch (err) {
      console.warn('[TeamTestModal] pattern load failed:', err);
      appendLog(`No pattern items found for uniqid: ${patternUniqid}`);
      return [];
    }
  };

  const buildTagQuestMockCard = (
    teamKeyId: string,
    selectedImageKeys: Set<string>,
    patternItems: PatternItem[],
    withEnd: boolean
  ): any => {
    const now = Math.floor(Date.now() / 1000);

    const itemMap: Record<string, number> = {};
    patternItems.forEach(p => {
      itemMap[`${p.item_index}:${p.assignment_type}`] = p.station_key_number;
    });

    const punches: Array<{ code: string; time: number }> = [];
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
          punches.push({ code: String(stationKey), time: now });
        }
      }
    }

    return {
      id: teamKeyId,
      series: 0,
      nbPunch: punches.length,
      start: { code: '255', time: now - 600 },
      check: null,
      end: withEnd ? { code: '254', time: now } : null,
      punches,
    };
  };

  const runTest = async () => {
    if (gameType?.toLowerCase() !== 'tagquest' && totalPercent !== 100) {
      setPercentError('Percentages must add up to exactly 100%');
      return;
    }

    setTestRunning(true);
    setTestResult(null);
    setTestLog([]);

    const deviceLabel = testConfig.selectedDeviceId || 'game_test_simulator';
    appendLog(`Starting test simulation on device: ${deviceLabel}`);

    try {
      const state = await getLaunchedGameState(gameId, 0);
      const currentTeam = state.teams.find((t) => t.id === selectedTeam.id) ?? null;
      if (currentTeam?.start_time || currentTeam?.end_time) {
        await updateTeam(selectedTeam.id, { start_time: null, end_time: null, score: 0 });
        appendLog('  Reset previous run');
      }

      appendLog(`Processing: ${selectedTeam.team_name}`);

      const meta = await getLaunchedGameMeta(gameId);

      if (gameType?.toLowerCase() === 'tagquest') {
        appendLog(`Selected ${selectedImages.size} image(s) across ${quests.length} quest(s)`);
        const tqPatternUniqid = meta.pattern || '';
        appendLog(`Loading pattern items: ${tqPatternUniqid}`);
        const tqPatternItems = await loadPatternItems(tqPatternUniqid);
        appendLog(`Loaded ${tqPatternItems.length} pattern item(s)`);

        const startTime = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 1200 + 300);
        await updateTeam(selectedTeam.id, { start_time: startTime });

        const mockCard = buildTagQuestMockCard(selectedTeam.key_id.toString(), selectedImages, tqPatternItems, endChip);
        appendLog(`Punch: ${JSON.stringify(mockCard)}`);
        await recordPunch(gameId, mockCard);

        if (endChip) {
          const totalScore = mockCard.nbPunch * 10;
          const endTime = Math.floor(Date.now() / 1000);
          try {
            await updateTeam(selectedTeam.id, { end_time: endTime, score: totalScore });
            const duration = endTime - startTime;
            const mins = Math.floor(duration / 60);
            const secs = duration % 60;
            const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
            appendLog(`  Done - Score: ${totalScore}, Time: ${timeStr}`);
            setTestResult({ teamName: selectedTeam.team_name, score: totalScore, status: 'success', message: `Score: ${totalScore} - Time: ${timeStr}` });
          } catch (endErr: any) {
            appendLog(`  Error: ${endErr?.message || endErr}`);
            setTestResult({ teamName: selectedTeam.team_name, score: 0, status: 'error', message: endErr?.message || String(endErr) });
          }
        } else {
          appendLog(`  Card sent (no end punch) - punch logic will process this card`);
          setTestResult({ teamName: selectedTeam.team_name, score: 0, status: 'success', message: `Card sent - no end punch` });
        }

        appendLog('Simulation complete.');
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

      const startTime = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 1200 + 300);
      await updateTeam(selectedTeam.id, { start_time: startTime });

      const mockCard = buildMockCard(
        selectedTeam.key_id.toString(),
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
          const wrongPts = parseInt(ge?.wrong_answer_points || '0');
          const hasGood = enigma.good_answers.some((a: string) => cardCodes.includes(a));
          const hasBad = enigma.wrong_answers.some((a: string) => cardCodes.includes(a));
          if (hasGood && !hasBad) totalScore += goodPts;
          else if (hasBad && !hasGood) totalScore -= wrongPts;
        }
      } else if (patternEnigmas.length === 0) {
        totalScore = mockCard.punches.length * 10;
      }

      const endTime = Math.floor(Date.now() / 1000);
      try {
        await updateTeam(selectedTeam.id, { end_time: endTime, score: totalScore });
        const duration = endTime - startTime;
        const mins = Math.floor(duration / 60);
        const secs = duration % 60;
        const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
        appendLog(`  Done - Score: ${totalScore}, Time: ${timeStr}`);
        setTestResult({ teamName: selectedTeam.team_name, score: totalScore, status: 'success', message: `Score: ${totalScore} - Time: ${timeStr}` });
      } catch (endErr: any) {
        appendLog(`  Error: ${endErr?.message || endErr}`);
        setTestResult({ teamName: selectedTeam.team_name, score: 0, status: 'error', message: endErr?.message || String(endErr) });
      }

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
            Run Team Test
          </h3>
          <button onClick={onClose} className="pg-modal-close">
            <X size={22} />
          </button>
        </div>

        <p className="text-[var(--pg-text-dim)] text-xs mb-5">
          Game: <span className="text-[var(--pg-text)] font-medium">{gameName}</span>
        </p>

        <div className="mb-5 relative">
          <button
            type="button"
            onClick={() => setTeamDropdownOpen(v => !v)}
            className="w-full px-4 py-3 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] hover:border-[var(--pg-line-strong)] flex items-center gap-3 transition text-left"
          >
            <Users size={18} className="text-[var(--pg-accent-bright)] shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[var(--pg-text)] text-sm font-semibold">{selectedTeam.team_name}</p>
              <p className="text-[var(--pg-text-dim)] text-xs">Team {selectedTeam.team_number} · Chip #{selectedTeam.key_id}</p>
            </div>
            <ChevronDown size={16} className={`text-[var(--pg-text-dim)] shrink-0 transition-transform ${teamDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {teamDropdownOpen && teamMembers.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--pg-surface)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] shadow-xl z-10">
              <div className="p-2 border-b border-[var(--pg-line)]">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] pointer-events-none z-10" />
                  <input
                    type="text"
                    value={teamSearch}
                    onChange={e => setTeamSearch(e.target.value)}
                    placeholder="Search by name or chip #..."
                    autoFocus
                    className="pg-input !pl-8 !py-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="max-h-44 overflow-y-auto">
                {teamMembers
                  .filter(m =>
                    m.team_name.toLowerCase().includes(teamSearch.toLowerCase()) ||
                    m.team_number.toString().includes(teamSearch) ||
                    m.key_id.toString().includes(teamSearch)
                  )
                  .map(member => (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => {
                        setSelectedTeam(member);
                        setTeamDropdownOpen(false);
                        setTeamSearch('');
                        setTestResult(null);
                        setTestLog([]);
                      }}
                      className={`w-full px-4 py-2.5 flex items-center gap-3 hover:bg-[var(--pg-surface-3)] transition text-left ${
                        member.id === selectedTeam.id ? 'bg-[var(--pg-accent-tint)]' : ''
                      }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${member.id === selectedTeam.id ? 'bg-[var(--pg-accent-bright)]' : 'bg-[var(--pg-line-strong)]'}`} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${member.id === selectedTeam.id ? 'text-[var(--pg-accent-bright)]' : 'text-[var(--pg-text)]'}`}>
                          {member.team_name}
                        </p>
                        <p className="text-[var(--pg-text-dim)] text-xs">Team {member.team_number} · Chip #{member.key_id}</p>
                      </div>
                      {member.id === selectedTeam.id && <CheckCircle size={14} className="text-[var(--pg-accent-bright)] shrink-0" />}
                    </button>
                  ))}
                {teamMembers.filter(m =>
                  m.team_name.toLowerCase().includes(teamSearch.toLowerCase()) ||
                  m.team_number.toString().includes(teamSearch) ||
                  m.key_id.toString().includes(teamSearch)
                ).length === 0 && (
                  <p className="px-4 py-3 text-[var(--pg-text-dim)] text-sm">No teams found.</p>
                )}
              </div>
            </div>
          )}
        </div>

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

            {gameType?.toLowerCase() === 'tagquest' ? (
              <div>
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
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-xs text-[var(--pg-text-dim)] shrink-0">#{quest.index}</span>
                              {quest.name ? (
                                <span className="text-sm font-medium text-[var(--pg-text)] truncate">{quest.name}</span>
                              ) : (
                                <span className="text-sm font-medium text-[var(--pg-text)]">Quest {quest.index}</span>
                              )}
                              {quest.points > 0 && (
                                <span className="shrink-0 text-xs font-medium text-[var(--pg-accent-bright)] bg-[var(--pg-accent-tint)] border border-[var(--pg-accent-line)] px-1.5 py-0.5 rounded">
                                  {quest.points} pts
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => selectQuestAll(quest)}
                              className={`flex items-center gap-1 text-xs transition shrink-0 ml-2 ${
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
                    onClick={() => {
                      const next = !keepAnimVisible;
                      setKeepAnimVisible(next);
                      localStorage.setItem('tagquest_keep_anim_visible', next ? '1' : '0');
                    }}
                    className={`flex items-center justify-center w-4 h-4 rounded border transition ${keepAnimVisible ? 'bg-[var(--pg-accent)] border-[var(--pg-accent)]' : 'bg-transparent border-[var(--pg-line-strong)]'}`}
                  >
                    {keepAnimVisible && <CheckCircle size={10} className="text-[var(--pg-text)]" />}
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
              disabled={testRunning || (gameType?.toLowerCase() !== 'tagquest' && totalPercent !== 100)}
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

        {testResult && (
          <div className="mt-4">
            <h5 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-2">Result</h5>
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-[var(--pg-radius-md)] ${
                testResult.status === 'success'
                  ? 'bg-green-900/20 border border-green-800/40'
                  : 'bg-red-900/20 border border-red-800/40'
              }`}
            >
              {testResult.status === 'success' ? (
                <CheckCircle size={16} className="text-green-400 shrink-0" />
              ) : (
                <AlertCircle size={16} className="text-red-400 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-[var(--pg-text)] text-sm font-medium">{testResult.teamName}</p>
                <p className="text-[var(--pg-text-dim)] text-xs">{testResult.message}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
