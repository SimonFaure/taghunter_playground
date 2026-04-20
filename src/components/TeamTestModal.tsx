import { useState, useEffect } from 'react';
import { X, FlaskConical, Play, CheckCircle, AlertCircle, Loader, Monitor, Users, Image as ImageIcon, CheckSquare, Square, ChevronDown, Search } from 'lucide-react';
import { supabase } from '../lib/db';
import { loadPatternEnigmas } from '../utils/patterns';

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

  const loadTeamMembers = async () => {
    const { data, error } = await supabase
      .from('teams')
      .select('id, team_name, team_number, key_id')
      .eq('launched_game_id', gameId)
      .order('team_number', { ascending: true });
    if (!error && data) {
      setTeamMembers(data as TeamMember[]);
    }
  };

  const detectGameType = async () => {
    setLoadingType(true);
    const { data: launchedGame } = await supabase
      .from('launched_games')
      .select('game_type, game_uniqid')
      .eq('id', gameId)
      .maybeSingle();

    if (launchedGame) {
      setGameType(launchedGame.game_type);

      if (launchedGame.game_type?.toLowerCase() === 'tagquest' && launchedGame.game_uniqid) {
        setGameUniqid(launchedGame.game_uniqid);
        setLoadingQuests(true);
        const { data: scenario } = await supabase
          .from('scenarios')
          .select('game_data_json')
          .eq('uniqid', launchedGame.game_uniqid)
          .maybeSingle();

        if (scenario) {
          let gdj = scenario.game_data_json;

          if (!gdj) {
            const { data: gameDataFile } = await supabase.storage
              .from('resources')
              .download(`scenarios/${launchedGame.game_uniqid}/game-data.json`);

            if (gameDataFile) {
              const text = await gameDataFile.text();
              gdj = JSON.parse(text);
            }
          }

          const rawQuests: any[] = gdj?.game_data?.quests || gdj?.quests || gdj?.game_quests || [];

          const stripMedia = (name: string) => name.replace(/^media[/\\]/i, '').replace(/^media[/\\]/i, '');
          const mediaImages: Array<{ id: string; file_name: string }> = gdj?.game_media_images || [];
          const mediaMap = new Map(mediaImages.map(m => [String(m.id), stripMedia(m.file_name)]));

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
    }

    setLoadingType(false);
  };

  const loadDevices = async () => {
    setLoadingDevices(true);
    const { data, error } = await supabase
      .from('launched_game_devices')
      .select('*')
      .eq('launched_game_id', gameId)
      .order('last_connexion_attempt', { ascending: false });

    if (!error && data) {
      setDevices(data);
      if (data.length > 0) {
        setTestConfig(prev => ({ ...prev, selectedDeviceId: data[0].device_id }));
      }
    }
    setLoadingDevices(false);
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

  const toggleSelectAll = () => {
    const allKeys = quests.flatMap(q => q.images.map(i => i.key));
    const allSelected = allKeys.every(k => selectedImages.has(k));
    if (allSelected) {
      setSelectedImages(new Set());
    } else {
      setSelectedImages(new Set(allKeys));
    }
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

  interface PatternItem {
    item_index: number;
    assignment_type: string;
    station_key_number: number;
  }

  const loadPatternItems = async (patternUniqid: string): Promise<PatternItem[]> => {
    const fetchPatternJson = async (storagePath: string): Promise<PatternItem[] | null> => {
      try {
        const { data: urlData } = supabase.storage.from('resources').getPublicUrl(storagePath);
        const resp = await fetch(urlData.publicUrl);
        if (resp.ok) {
          const json = await resp.json();
          if (Array.isArray(json?.pattern_data)) return json.pattern_data;
        }
      } catch {}
      return null;
    };

    try {
      const { getPatternFilesFromStorage } = await import('../utils/patterns');
      const gameTypeLower = gameType?.toLowerCase() || 'mystery';
      const storageFiles = await getPatternFilesFromStorage(gameTypeLower);
      const match = storageFiles.find(f => f.uniqid === patternUniqid);
      if (match) {
        const items = await fetchPatternJson(match.storagePath);
        if (items) {
          appendLog(`Pattern file: ${match.storagePath}`);
          return items;
        }
      }
    } catch {}

    appendLog(`No pattern items found for uniqid: ${patternUniqid}`);
    return [];
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
      const { data: currentTeam } = await supabase
        .from('teams')
        .select('start_time, end_time')
        .eq('id', selectedTeam.id)
        .maybeSingle();

      if (currentTeam?.start_time || currentTeam?.end_time) {
        await supabase.from('teams').update({ start_time: null, end_time: null, score: 0 }).eq('id', selectedTeam.id);
        appendLog('  Reset previous run');
      }

      appendLog(`Processing: ${selectedTeam.team_name}`);

      if (gameType?.toLowerCase() === 'tagquest') {
        appendLog(`Selected ${selectedImages.size} image(s) across ${quests.length} quest(s)`);

        const { data: metaDataTQ } = await supabase
          .from('launched_game_meta')
          .select('meta_name, meta_value')
          .eq('launched_game_id', gameId);

        const metaMapTQ: Record<string, string> = {};
        metaDataTQ?.forEach(m => { metaMapTQ[m.meta_name] = m.meta_value || ''; });
        const tqPatternUniqid = metaMapTQ.pattern || '';

        appendLog(`Loading pattern items: ${tqPatternUniqid}`);
        const tqPatternItems = await loadPatternItems(tqPatternUniqid);
        appendLog(`Loaded ${tqPatternItems.length} pattern item(s)`);

        const startTime = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 1200 + 300);
        await supabase.from('teams').update({ start_time: startTime }).eq('id', selectedTeam.id);

        const mockCard = buildTagQuestMockCard(selectedTeam.key_id.toString(), selectedImages, tqPatternItems, endChip);

        appendLog(`Punch: ${JSON.stringify(mockCard)}`);

        await supabase.from('launched_game_raw_data').insert({
          launched_game_id: gameId,
          device_id: deviceLabel,
          raw_data: mockCard,
        });

        if (endChip) {
          const totalScore = mockCard.nbPunch * 10;
          const endTime = Math.floor(Date.now() / 1000);

          const { error: endErr } = await supabase
            .from('teams')
            .update({ end_time: endTime, score: totalScore })
            .eq('id', selectedTeam.id);

          if (endErr) {
            appendLog(`  Error: ${endErr.message}`);
            setTestResult({ teamName: selectedTeam.team_name, score: 0, status: 'error', message: endErr.message });
          } else {
            const duration = endTime - startTime;
            const mins = Math.floor(duration / 60);
            const secs = duration % 60;
            const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
            appendLog(`  Done — Score: ${totalScore}, Time: ${timeStr}`);
            setTestResult({ teamName: selectedTeam.team_name, score: totalScore, status: 'success', message: `Score: ${totalScore} — Time: ${timeStr}` });
          }
        } else {
          appendLog(`  Card sent (no end punch) — punch logic will process this card`);
          setTestResult({ teamName: selectedTeam.team_name, score: 0, status: 'success', message: `Card sent — no end punch` });
        }

        appendLog('Simulation complete.');
        return;
      }

      const { data: metaData } = await supabase
        .from('launched_game_meta')
        .select('meta_name, meta_value')
        .eq('launched_game_id', gameId);

      const metaMap: Record<string, string> = {};
      metaData?.forEach(m => { metaMap[m.meta_name] = m.meta_value || ''; });
      const patternUniqid = metaMap.pattern || '';

      appendLog(`Loading pattern: ${patternUniqid}`);
      const { loadPatternEnigmasByUniqid } = await import('../utils/patterns');
      const patternEnigmas = await loadPatternEnigmasByUniqid('mystery', patternUniqid);

      if (patternEnigmas.length === 0) {
        appendLog('Warning: No pattern enigmas loaded (pattern file may not be available here)');
      } else {
        appendLog(`Loaded ${patternEnigmas.length} enigmas`);
      }

      const { data: launchedGame } = await supabase
        .from('launched_games')
        .select('game_uniqid')
        .eq('id', gameId)
        .maybeSingle();

      let enigmasForScoring: any[] = [];
      if (launchedGame?.game_uniqid) {
        const { data: scenarioData } = await supabase
          .from('scenarios')
          .select('game_data_json')
          .eq('uniqid', launchedGame.game_uniqid)
          .maybeSingle();

        enigmasForScoring =
          scenarioData?.game_data_json?.game_enigmas ||
          scenarioData?.game_data_json?.game_data?.game_enigmas || [];
      }

      const startTime = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 1200 + 300);
      await supabase.from('teams').update({ start_time: startTime }).eq('id', selectedTeam.id);

      const mockCard = buildMockCard(
        selectedTeam.key_id.toString(),
        patternEnigmas,
        testConfig.goodAnswerPercent,
        testConfig.badAnswerPercent
      );

      await supabase.from('launched_game_raw_data').insert({
        launched_game_id: gameId,
        device_id: deviceLabel,
        raw_data: mockCard,
      });

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
      const { error: endErr } = await supabase
        .from('teams')
        .update({ end_time: endTime, score: totalScore })
        .eq('id', selectedTeam.id);

      if (endErr) {
        appendLog(`  Error: ${endErr.message}`);
        setTestResult({ teamName: selectedTeam.team_name, score: 0, status: 'error', message: endErr.message });
      } else {
        const duration = endTime - startTime;
        const mins = Math.floor(duration / 60);
        const secs = duration % 60;
        const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
        appendLog(`  Done — Score: ${totalScore}, Time: ${timeStr}`);
        setTestResult({ teamName: selectedTeam.team_name, score: totalScore, status: 'success', message: `Score: ${totalScore} — Time: ${timeStr}` });
      }

      appendLog('Simulation complete.');
    } catch (err: any) {
      appendLog(`Unexpected error: ${err?.message || String(err)}`);
    } finally {
      setTestRunning(false);
    }
  };

  const allImageKeys = quests.flatMap(q => q.images.map(i => i.key));
  const allSelected = allImageKeys.length > 0 && allImageKeys.every(k => selectedImages.has(k));

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-slate-800 border-2 border-slate-700 rounded-xl p-6 max-w-lg w-full max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <FlaskConical size={22} className="text-amber-400" />
            Run Team Test
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition">
            <X size={22} />
          </button>
        </div>

        <p className="text-slate-400 text-xs mb-5">
          Game: <span className="text-white font-medium">{gameName}</span>
        </p>

        <div className="mb-5 relative">
          <button
            type="button"
            onClick={() => setTeamDropdownOpen(v => !v)}
            className="w-full px-4 py-3 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-slate-500 flex items-center gap-3 transition text-left"
          >
            <Users size={18} className="text-blue-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-semibold">{selectedTeam.team_name}</p>
              <p className="text-slate-400 text-xs">Team {selectedTeam.team_number} · Chip #{selectedTeam.key_id}</p>
            </div>
            <ChevronDown size={16} className={`text-slate-400 shrink-0 transition-transform ${teamDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {teamDropdownOpen && teamMembers.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-10">
              <div className="p-2 border-b border-slate-700">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input
                    type="text"
                    value={teamSearch}
                    onChange={e => setTeamSearch(e.target.value)}
                    placeholder="Search by name or chip #..."
                    autoFocus
                    className="w-full pl-8 pr-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-400 text-sm focus:outline-none focus:border-blue-500"
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
                      className={`w-full px-4 py-2.5 flex items-center gap-3 hover:bg-slate-700/60 transition text-left ${
                        member.id === selectedTeam.id ? 'bg-blue-900/20' : ''
                      }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${member.id === selectedTeam.id ? 'bg-blue-400' : 'bg-slate-600'}`} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${member.id === selectedTeam.id ? 'text-blue-300' : 'text-white'}`}>
                          {member.team_name}
                        </p>
                        <p className="text-slate-400 text-xs">Team {member.team_number} · Chip #{member.key_id}</p>
                      </div>
                      {member.id === selectedTeam.id && <CheckCircle size={14} className="text-blue-400 shrink-0" />}
                    </button>
                  ))}
                {teamMembers.filter(m =>
                  m.team_name.toLowerCase().includes(teamSearch.toLowerCase()) ||
                  m.team_number.toString().includes(teamSearch) ||
                  m.key_id.toString().includes(teamSearch)
                ).length === 0 && (
                  <p className="px-4 py-3 text-slate-400 text-sm">No teams found.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {loadingType ? (
          <div className="flex items-center justify-center py-8 gap-2 text-slate-400">
            <Loader size={18} className="animate-spin" />
            <span className="text-sm">Loading game configuration...</span>
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Connected Device
              </label>
              {loadingDevices ? (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-2">
                  <Loader size={14} className="animate-spin" />
                  Loading devices...
                </div>
              ) : devices.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 bg-slate-700/50 rounded-lg border border-slate-600">
                  <Monitor size={16} className="text-slate-400" />
                  <span className="text-slate-400 text-sm">No connected devices — will use simulator</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {devices.map(device => (
                    <label
                      key={device.id}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition ${
                        testConfig.selectedDeviceId === device.device_id
                          ? 'border-amber-500 bg-amber-900/20'
                          : 'border-slate-600 bg-slate-700/40 hover:border-slate-500'
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
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${device.connected ? 'bg-green-400' : 'bg-slate-500'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium truncate">{device.device_id}</p>
                        <p className="text-slate-400 text-xs">
                          {device.connected ? 'Connected' : 'Disconnected'} · last seen {new Date(device.last_connexion_attempt).toLocaleTimeString()}
                        </p>
                      </div>
                      {testConfig.selectedDeviceId === device.device_id && (
                        <CheckCircle size={16} className="text-amber-400 shrink-0" />
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {gameType?.toLowerCase() === 'tagquest' ? (
              <div>
                <div className="flex items-center mb-3">
                  <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                    <ImageIcon size={15} className="text-amber-400" />
                    Quest Images Found
                  </label>
                </div>

                {loadingQuests ? (
                  <div className="flex items-center gap-2 text-slate-400 text-sm py-3">
                    <Loader size={14} className="animate-spin" />
                    Loading quests...
                  </div>
                ) : quests.length === 0 ? (
                  <div className="px-4 py-3 bg-slate-700/50 rounded-lg border border-slate-600 text-slate-400 text-sm">
                    No quests found for this game.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {quests.map(quest => {
                      const questKeys = quest.images.map(i => i.key);
                      const questAllSelected = questKeys.length > 0 && questKeys.every(k => selectedImages.has(k));
                      const questSomeSelected = questKeys.some(k => selectedImages.has(k));
                      return (
                        <div key={quest.index} className="bg-slate-700/40 rounded-lg border border-slate-600 overflow-hidden">
                          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-600/60">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-xs text-slate-500 shrink-0">#{quest.index}</span>
                              {quest.name ? (
                                <span className="text-sm font-medium text-white truncate">{quest.name}</span>
                              ) : (
                                <span className="text-sm font-medium text-white">Quest {quest.index}</span>
                              )}
                              {quest.points > 0 && (
                                <span className="shrink-0 text-xs font-medium text-amber-400 bg-amber-900/30 border border-amber-700/40 px-1.5 py-0.5 rounded">
                                  {quest.points} pts
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => selectQuestAll(quest)}
                              className={`flex items-center gap-1 text-xs transition shrink-0 ml-2 ${
                                questAllSelected ? 'text-amber-400' : questSomeSelected ? 'text-amber-400/60' : 'text-slate-400 hover:text-white'
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
                                const { data: urlData } = supabase.storage
                                  .from('resources')
                                  .getPublicUrl(`scenarios/${gameUniqid}/media/${safeKey}`);
                                return (
                                  <button
                                    key={img.key}
                                    onClick={() => isMain ? selectQuestAll(quest) : toggleImage(img.key, quest)}
                                    className={`relative flex flex-col items-center gap-1 rounded-lg border-2 overflow-hidden transition ${
                                      checked
                                        ? 'border-amber-500 ring-1 ring-amber-500/50'
                                        : 'border-slate-600 hover:border-slate-400'
                                    } ${large ? 'w-full h-full' : ''}`}
                                  >
                                    <div className={`w-full bg-slate-800 ${large ? 'flex-1' : ''}`} style={large ? { height: 148 } : { height: 60 }}>
                                      <img
                                        src={urlData.publicUrl}
                                        alt={img.label}
                                        className="w-full h-full object-cover"
                                        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                                      />
                                    </div>
                                    <span className={`text-[10px] font-medium pb-1 px-1 truncate w-full text-center ${checked ? 'text-amber-300' : 'text-slate-400'}`}>
                                      {img.label}
                                    </span>
                                    {checked && (
                                      <div className="absolute top-1 right-1 bg-amber-500 rounded-full p-0.5">
                                        <CheckCircle size={9} className="text-slate-900" />
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
                    <div className={`mt-3 flex items-center justify-between text-sm px-3 py-2 rounded-lg ${
                      hasAny ? 'bg-amber-900/25 text-amber-400' : 'bg-slate-700/50 text-slate-400'
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
                    className={`flex items-center justify-center w-4 h-4 rounded border transition ${endChip ? 'bg-amber-500 border-amber-500' : 'bg-transparent border-slate-500'}`}
                  >
                    {endChip && <CheckCircle size={10} className="text-slate-900" />}
                  </button>
                  <span className="text-sm text-slate-300">End chip</span>
                </label>

                <label className="mt-2 flex items-center gap-2.5 cursor-pointer select-none">
                  <button
                    type="button"
                    onClick={() => {
                      const next = !keepAnimVisible;
                      setKeepAnimVisible(next);
                      localStorage.setItem('tagquest_keep_anim_visible', next ? '1' : '0');
                    }}
                    className={`flex items-center justify-center w-4 h-4 rounded border transition ${keepAnimVisible ? 'bg-amber-500 border-amber-500' : 'bg-transparent border-slate-500'}`}
                  >
                    {keepAnimVisible && <CheckCircle size={10} className="text-slate-900" />}
                  </button>
                  <span className="text-sm text-slate-300">Keep animation visible for 10s after completion</span>
                </label>
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-3">Answer Distribution</label>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-2 h-2 rounded-full bg-green-400" />
                      <span className="text-xs text-slate-300 font-medium">Good</span>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={testConfig.goodAnswerPercent}
                        onChange={e => handleChange('goodAnswerPercent', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                        className="w-full px-3 py-2 pr-7 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">%</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-2 h-2 rounded-full bg-red-400" />
                      <span className="text-xs text-slate-300 font-medium">Bad</span>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={testConfig.badAnswerPercent}
                        onChange={e => handleChange('badAnswerPercent', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                        className="w-full px-3 py-2 pr-7 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                      />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">%</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-2 h-2 rounded-full bg-slate-400" />
                      <span className="text-xs text-slate-300 font-medium">None</span>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={testConfig.noAnswerPercent}
                        onChange={e => handleChange('noAnswerPercent', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                        className="w-full px-3 py-2 pr-7 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">%</span>
                    </div>
                  </div>
                </div>

                <div className={`mt-3 flex items-center justify-between text-sm px-3 py-2 rounded-lg ${totalPercent === 100 ? 'bg-green-900/25 text-green-400' : 'bg-red-900/25 text-red-400'}`}>
                  <span>Total: <span className="font-semibold">{totalPercent}%</span></span>
                  <span className="font-medium text-xs">{totalPercent === 100 ? 'Ready' : 'Must equal 100%'}</span>
                </div>

                {percentError && <p className="text-red-400 text-xs mt-1">{percentError}</p>}
              </div>
            )}

            <button
              onClick={runTest}
              disabled={testRunning || (gameType?.toLowerCase() !== 'tagquest' && totalPercent !== 100)}
              className="w-full px-4 py-3 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg font-semibold flex items-center justify-center gap-2 transition"
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
            <h5 className="text-sm font-semibold text-slate-300 mb-2">Log</h5>
            <div className="bg-slate-900 rounded-lg p-3 max-h-36 overflow-y-auto font-mono text-xs text-slate-400 space-y-0.5">
              {testLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </div>
        )}

        {testResult && (
          <div className="mt-4">
            <h5 className="text-sm font-semibold text-slate-300 mb-2">Result</h5>
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-lg ${
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
                <p className="text-white text-sm font-medium">{testResult.teamName}</p>
                <p className="text-slate-400 text-xs">{testResult.message}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
