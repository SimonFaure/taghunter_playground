import { useState, useEffect } from 'react';
import { X, Award, Zap, Target, Clock, List, ChevronDown, ChevronUp, BarChart2, Radio } from 'lucide-react';
import { supabase } from '../lib/db';

interface Team {
  id: number;
  team_number: number;
  team_name: string;
  score: number;
  start_time: number | null;
  end_time: number | null;
  key_id: number;
}

interface CompletedQuest {
  id: number;
  quest_number: string;
  points_awarded: number;
  teammate_chip_id: number | null;
  completed_at: string | null;
}

interface PunchResponse {
  id: number;
  chip_id: number | null;
  status: string;
  result_json: {
    team_name?: string;
    completed_quest?: { index: number; name: string; points: number } | null;
    points_earned?: number;
    combo_bonus?: number;
    malus_applied?: number;
    level_up?: { new_level: number; name: string } | null;
    best_partial_quest?: { index: number; name: string; matched: number } | null;
    end_station_reached?: boolean;
    game_ended?: boolean;
    message?: string;
  };
  punched_at: string;
}

interface RawDataRecord {
  id: number;
  raw_data: {
    id: number;
    punches: { code: number | string; time: number | string }[];
    end?: number | string | null;
  };
  created_at: string;
}

interface TeamDetailsModalProps {
  team: Team;
  launchedGameId: number;
  gameUniqid: string;
  onClose: () => void;
}

interface GameQuest {
  name: string;
  points?: string | number;
}

interface GameDataJson {
  game_meta?: {
    combo_6_quests?: string | number;
    combo_4_quests?: string | number;
    combo_2_quests?: string | number;
    levels?: Record<string, { name: string | null; points: string | null; description?: string | null }>;
  };
  levels?: Record<string, { name: string | null; points: string | null; description?: string | null }>;
  quests?: GameQuest[];
}

function formatTimestamp(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined) return '—';
  const ms = typeof ts === 'string' ? parseFloat(ts) : ts;
  const adjusted = ms > 1e10 ? ms : ms * 1000;
  return new Date(adjusted).toLocaleTimeString();
}

function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function computeCombos(questCompletions: Map<string, number>): { combos6: number; combos4: number; combos2: number } {
  const counts = new Map(questCompletions);

  let combos6 = 0;
  while ([...counts.values()].every(v => v > 0) && counts.size >= 6) {
    combos6++;
    for (const key of counts.keys()) counts.set(key, counts.get(key)! - 1);
  }

  let combos4 = 0;
  while (true) {
    const nonZero = [...counts.entries()].filter(([, v]) => v > 0);
    if (nonZero.length < 4) break;
    combos4++;
    for (const [key] of nonZero.slice(0, 4)) counts.set(key, counts.get(key)! - 1);
  }

  let combos2 = 0;
  while (true) {
    const nonZero = [...counts.entries()].filter(([, v]) => v > 0);
    if (nonZero.length < 2) break;
    combos2++;
    for (const [key] of nonZero.slice(0, 2)) counts.set(key, counts.get(key)! - 1);
  }

  return { combos6, combos4, combos2 };
}

function parseComboVal(val: string | number | undefined): number {
  if (val === undefined || val === null) return 0;
  return typeof val === 'string' ? parseInt(val, 10) || 0 : val;
}

function computeLevel(
  score: number,
  levels: Record<string, { name: string | null; points: string | null }> | undefined
): { level: number; name: string } | null {
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
}

export function TeamDetailsModal({ team, launchedGameId, gameUniqid, onClose }: TeamDetailsModalProps) {
  const [completedQuests, setCompletedQuests] = useState<CompletedQuest[]>([]);
  const [rawDataRecords, setRawDataRecords] = useState<RawDataRecord[]>([]);
  const [gameData, setGameData] = useState<GameDataJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'quests' | 'quest-count' | 'punches' | 'responses'>('quests');
  const [punchResponses, setPunchResponses] = useState<PunchResponse[]>([]);
  const [expandedPunch, setExpandedPunch] = useState<number | null>(null);
  const [currentTeam, setCurrentTeam] = useState(team);

  useEffect(() => {
    const loadGameData = async () => {
      try {
        const { data: urlData } = supabase.storage
          .from('resources')
          .getPublicUrl(`scenarios/${gameUniqid}/game-data.json`);
        const resp = await fetch(urlData.publicUrl);
        if (resp.ok) {
          const raw = await resp.json();
          setGameData(raw?.game_data ?? raw);
        }
      } catch {
        // game data not available
      }
    };

    loadGameData();
  }, [gameUniqid]);

  useEffect(() => {
    const load = async (isInitial = false) => {
      if (isInitial) setLoading(true);

      const [questsRes, rawRes, teamRes, responsesRes] = await Promise.all([
        supabase
          .from('team_completed_quests')
          .select('id, quest_number, points_awarded, teammate_chip_id, completed_at')
          .eq('team_id', team.id)
          .order('completed_at', { ascending: true }),
        supabase
          .from('launched_game_raw_data')
          .select('id, raw_data, created_at')
          .eq('launched_game_id', launchedGameId)
          .eq('raw_data->>id', team.key_id.toString())
          .order('created_at', { ascending: true }),
        supabase
          .from('teams')
          .select('id, team_name, score, start_time, end_time, key_id')
          .eq('id', team.id)
          .maybeSingle(),
        supabase
          .from('team_punch_responses')
          .select('id, chip_id, status, result_json, punched_at')
          .eq('team_id', team.id)
          .order('punched_at', { ascending: false }),
      ]);

      if (questsRes.data) setCompletedQuests(questsRes.data as CompletedQuest[]);
      if (rawRes.data) setRawDataRecords(rawRes.data as RawDataRecord[]);
      if (teamRes.data) setCurrentTeam(teamRes.data as typeof team);
      if (responsesRes.data) setPunchResponses(responsesRes.data as PunchResponse[]);

      if (isInitial) setLoading(false);
    };

    load(true);

    const interval = setInterval(() => load(false), 2000);
    return () => clearInterval(interval);
  }, [team.id, launchedGameId, team.key_id]);

  const quests = gameData?.quests ?? [];
  const comboConfig = gameData?.game_meta;
  const pts6 = parseComboVal(comboConfig?.combo_6_quests);
  const pts4 = parseComboVal(comboConfig?.combo_4_quests);
  const pts2 = parseComboVal(comboConfig?.combo_2_quests);
  const hasComboConfig = pts6 > 0 || pts4 > 0 || pts2 > 0;

  const totalQuestPoints = completedQuests.reduce((sum, q) => sum + (q.points_awarded ?? 0), 0);
  const gameLevels = gameData?.levels ?? comboConfig?.levels;

  const getQuestName = (questNumber: string): string => {
    const idx = parseInt(questNumber, 10) - 1;
    return quests[idx]?.name ?? `Quest #${questNumber}`;
  };

  const questCountMap = completedQuests.reduce<Record<string, number>>((acc, q) => {
    acc[q.quest_number] = (acc[q.quest_number] ?? 0) + 1;
    return acc;
  }, {});

  const questCountMapForCombos = new Map<string, number>(Object.entries(questCountMap));
  const combos = computeCombos(questCountMapForCombos);
  const comboTotal = combos.combos6 * pts6 + combos.combos4 * pts4 + combos.combos2 * pts2;
  const totalScore = totalQuestPoints + comboTotal;
  const currentLevel = computeLevel(totalScore, gameLevels);

  const allQuestNumbers = quests.length > 0
    ? quests.map((_, i) => String(i + 1))
    : [...new Set(completedQuests.map(q => q.quest_number))].sort((a, b) => parseInt(a) - parseInt(b));

  const getQuestPoints = (questNumber: string): number => {
    const idx = parseInt(questNumber, 10) - 1;
    const raw = quests[idx]?.points;
    if (raw === undefined || raw === null) return 0;
    return typeof raw === 'string' ? parseInt(raw, 10) || 0 : raw;
  };

  const questCountRows = allQuestNumbers.map(num => ({
    questNumber: num,
    name: getQuestName(num),
    points: getQuestPoints(num),
    count: questCountMap[num] ?? 0,
  }));

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
          <div>
            <h2 className="text-white font-semibold text-lg">{team.team_name}</h2>
            <p className="text-slate-400 text-sm">Game details — Chip #{team.key_id}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-700 rounded-lg transition text-slate-400 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        {/* Score summary */}
        <div className="px-6 py-4 border-b border-slate-700 shrink-0">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="bg-slate-800 rounded-lg p-3 text-center">
              <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                <Target size={11} /> Quests
              </div>
              <div className="text-white font-bold text-xl">{completedQuests.length}</div>
            </div>
            <div className="bg-slate-800 rounded-lg p-3 text-center">
              <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                <Award size={11} /> Quest pts
              </div>
              <div className="text-blue-400 font-bold text-xl">{totalQuestPoints}</div>
            </div>
            {hasComboConfig && (
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                  <Zap size={11} /> Combo bonus
                </div>
                <div className="text-amber-400 font-bold text-xl">{comboTotal}</div>
              </div>
            )}
            <div className="bg-slate-800 rounded-lg p-3 text-center">
              <div className="text-slate-400 text-xs mb-1 flex items-center justify-center gap-1">
                <Clock size={11} /> Total score
              </div>
              <div className="text-green-400 font-bold text-xl">{totalScore}</div>
              {currentLevel && (
                <div className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                  {currentLevel.name}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Combo breakdown */}
        {hasComboConfig && (combos.combos6 > 0 || combos.combos4 > 0 || combos.combos2 > 0) && (
          <div className="px-6 py-3 border-b border-slate-700 shrink-0 bg-amber-950/20">
            <p className="text-amber-400 text-xs font-medium mb-2 flex items-center gap-1.5">
              <Zap size={12} /> Combo breakdown
            </p>
            <div className="flex flex-wrap gap-2">
              {combos.combos6 > 0 && (
                <span className="px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-amber-300 text-xs">
                  {combos.combos6}× combo-6 = +{combos.combos6 * pts6} pts
                </span>
              )}
              {combos.combos4 > 0 && (
                <span className="px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-amber-300 text-xs">
                  {combos.combos4}× combo-4 = +{combos.combos4 * pts4} pts
                </span>
              )}
              {combos.combos2 > 0 && (
                <span className="px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-amber-300 text-xs">
                  {combos.combos2}× combo-2 = +{combos.combos2 * pts2} pts
                </span>
              )}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-slate-700 shrink-0">
          <button
            onClick={() => setActiveTab('quests')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition border-b-2 ${
              activeTab === 'quests'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <Target size={14} />
            Quests ({completedQuests.length})
          </button>
          <button
            onClick={() => setActiveTab('quest-count')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition border-b-2 ${
              activeTab === 'quest-count'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <BarChart2 size={14} />
            Quest count
          </button>
          <button
            onClick={() => setActiveTab('punches')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition border-b-2 ${
              activeTab === 'punches'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <List size={14} />
            Punches ({rawDataRecords.length})
          </button>
          <button
            onClick={() => setActiveTab('responses')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition border-b-2 ${
              activeTab === 'responses'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <Radio size={14} />
            Responses ({punchResponses.length})
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-500 text-sm">
              Loading...
            </div>
          ) : activeTab === 'quests' ? (
            <div className="p-4">
              {completedQuests.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">No quests completed yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-400 text-xs border-b border-slate-700">
                      <th className="text-left py-2 pr-3 font-medium">#</th>
                      <th className="text-left py-2 pr-3 font-medium">Quest</th>
                      <th className="text-right py-2 pr-3 font-medium">Points</th>
                      <th className="text-right py-2 font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {completedQuests.map((cq, i) => (
                      <tr key={cq.id} className="border-b border-slate-800 hover:bg-slate-800/50 transition">
                        <td className="py-2.5 pr-3 text-slate-500">{i + 1}</td>
                        <td className="py-2.5 pr-3 text-white font-medium">
                          {getQuestName(cq.quest_number)}
                          {cq.teammate_chip_id && cq.teammate_chip_id !== team.key_id && (
                            <span className="ml-2 text-xs text-teal-400">chip #{cq.teammate_chip_id}</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-right">
                          <span className="text-blue-400 font-semibold">+{cq.points_awarded}</span>
                        </td>
                        <td className="py-2.5 text-right text-slate-400 text-xs">
                          {cq.completed_at ? formatCreatedAt(cq.completed_at) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : activeTab === 'quest-count' ? (
            <div className="p-4">
              {questCountRows.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">No quest data available.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-400 text-xs border-b border-slate-700">
                      <th className="text-left py-2 pr-3 font-medium">#</th>
                      <th className="text-left py-2 pr-3 font-medium">Quest</th>
                      <th className="text-right py-2 pr-3 font-medium">Pts</th>
                      <th className="text-right py-2 pr-3 font-medium">Completions</th>
                      <th className="text-right py-2 font-medium w-32">Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const maxCount = Math.max(1, ...questCountRows.map(r => r.count));
                      return questCountRows.map((row) => {
                        const pct = Math.round((row.count / maxCount) * 100);
                        return (
                          <tr key={row.questNumber} className="border-b border-slate-800 hover:bg-slate-800/50 transition">
                            <td className="py-2.5 pr-3 text-slate-500 text-xs">{row.questNumber}</td>
                            <td className="py-2.5 pr-3 text-white">{row.name}</td>
                            <td className="py-2.5 pr-3 text-right">
                              {row.points > 0
                                ? <span className="text-amber-400 text-xs font-medium">{row.points}</span>
                                : <span className="text-slate-600 text-xs">—</span>
                              }
                            </td>
                            <td className="py-2.5 pr-3 text-right">
                              <span className={row.count > 0 ? 'text-blue-400 font-semibold' : 'text-slate-600'}>
                                {row.count}
                              </span>
                            </td>
                            <td className="py-2.5 text-right w-32">
                              <div className="flex items-center justify-end gap-2">
                                <div className="w-20 bg-slate-700 rounded-full h-1.5 overflow-hidden">
                                  <div
                                    className="h-1.5 rounded-full bg-blue-500 transition-all duration-300"
                                    style={{ width: `${row.count > 0 ? pct : 0}%` }}
                                  />
                                </div>
                              </div>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              )}
            </div>
          ) : activeTab === 'punches' ? (
            <div className="p-4 space-y-2">
              {rawDataRecords.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">No punch records found.</p>
              ) : (
                rawDataRecords.map((rec, i) => {
                  const isExpanded = expandedPunch === rec.id;
                  const punches = rec.raw_data?.punches ?? [];
                  return (
                    <div key={rec.id} className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
                      <button
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-700/50 transition text-left"
                        onClick={() => setExpandedPunch(isExpanded ? null : rec.id)}
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-slate-500 text-xs">#{i + 1}</span>
                          <span className="text-white text-sm font-medium">
                            {punches.length} punch{punches.length !== 1 ? 'es' : ''}
                          </span>
                          {rec.raw_data?.end != null && (
                            <span className="px-1.5 py-0.5 bg-green-900/50 border border-green-700/50 rounded text-green-400 text-xs">
                              end station
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-slate-400 text-xs">{formatCreatedAt(rec.created_at)}</span>
                          {isExpanded ? (
                            <ChevronUp size={14} className="text-slate-400" />
                          ) : (
                            <ChevronDown size={14} className="text-slate-400" />
                          )}
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="border-t border-slate-700 px-4 py-3">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-slate-500 border-b border-slate-700">
                                <th className="text-left py-1.5 pr-3 font-medium">Station code</th>
                                <th className="text-right py-1.5 font-medium">Punch time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {punches.map((p, j) => (
                                <tr key={j} className="border-b border-slate-800/60">
                                  <td className="py-1.5 pr-3 text-white font-mono">{p.code}</td>
                                  <td className="py-1.5 text-right text-slate-400">
                                    {formatTimestamp(p.time)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className="p-4 space-y-2">
              {punchResponses.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">No responses recorded yet.</p>
              ) : (
                punchResponses.map((resp, i) => {
                  const r = resp.result_json;
                  const isOk = resp.status === 'ok';
                  const isError = resp.status === 'error';
                  const statusColor = isOk ? 'text-green-400 bg-green-900/40 border-green-700/50' : isError ? 'text-red-400 bg-red-900/40 border-red-700/50' : 'text-amber-400 bg-amber-900/40 border-amber-700/50';
                  const isExpanded = expandedPunch === resp.id;
                  return (
                    <div key={resp.id} className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
                      <button
                        className="w-full text-left px-4 py-3 space-y-2 hover:bg-slate-700/40 transition"
                        onClick={() => setExpandedPunch(isExpanded ? null : resp.id)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className="text-slate-500 text-xs">#{punchResponses.length - i}</span>
                            <span className={`px-2 py-0.5 rounded text-xs font-semibold border ${statusColor}`}>
                              {resp.status.replace(/_/g, ' ').toUpperCase()}
                            </span>
                            {resp.chip_id != null && (
                              <span className="text-slate-400 text-xs">chip #{resp.chip_id}</span>
                            )}
                            {r.completed_quest && (
                              <span className="text-white text-xs font-medium">{r.completed_quest.name}</span>
                            )}
                            {r.end_station_reached && (
                              <span className="px-1.5 py-0.5 bg-teal-900/50 border border-teal-700/50 rounded text-teal-400 text-xs">end station</span>
                            )}
                            {r.game_ended && (
                              <span className="px-1.5 py-0.5 bg-slate-700 border border-slate-600 rounded text-slate-300 text-xs">game ended</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            <span className="text-slate-500 text-xs">{formatCreatedAt(resp.punched_at)}</span>
                            {isExpanded ? (
                              <ChevronUp size={14} className="text-slate-400" />
                            ) : (
                              <ChevronDown size={14} className="text-slate-400" />
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs">
                          {r.completed_quest && (
                            <span className="text-blue-400">+{r.points_earned ?? r.completed_quest.points} pts</span>
                          )}
                          {(r.combo_bonus ?? 0) > 0 && (
                            <span className="text-amber-400">+{r.combo_bonus} combo</span>
                          )}
                          {(r.malus_applied ?? 0) > 0 && (
                            <span className="text-red-400">−{r.malus_applied} malus</span>
                          )}
                          {r.level_up && (
                            <span className="text-yellow-400 font-semibold">Level up: {r.level_up.name}</span>
                          )}
                          {r.best_partial_quest && !r.completed_quest && (
                            <span className="text-slate-400">{r.best_partial_quest.name}: {r.best_partial_quest.matched} match{r.best_partial_quest.matched !== 1 ? 'es' : ''}</span>
                          )}
                          {r.message && (
                            <span className="text-slate-500 italic">{r.message}</span>
                          )}
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="border-t border-slate-700 px-4 py-3 bg-slate-900/60">
                          <p className="text-slate-500 text-xs font-medium mb-2 uppercase tracking-wide">result_json</p>
                          <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
                            {JSON.stringify(resp.result_json, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
