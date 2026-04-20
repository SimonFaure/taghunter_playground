import { useState, useEffect, useRef, useCallback } from 'react';
import { GameConfig } from './LaunchGameModal';
import { MysteryGamePage } from './MysteryGamePage';
import { TagQuestGamePage } from './TagQuestGamePage';
import { LeaderboardPage } from './LeaderboardPage';
import { LaunchedGameConfigModal } from './LaunchedGameConfigModal';
import { GameTestModal } from './GameTestModal';
import { ConfirmDialog } from './ConfirmDialog';
import { supabase } from '../lib/db';
import { Settings, FlaskConical, Trophy, Monitor, StopCircle, Trash2, X, Gamepad2, Play, Clock, CheckCircle } from 'lucide-react';

interface GamePageProps {
  config: GameConfig;
  gameUniqid: string;
  launchedGameId: number | null;
  onBack: () => void;
}

interface GameMetadata {
  type: string;
  title: string;
}

interface Team {
  id: number;
  team_number: number;
  team_name: string;
  score: number;
  start_time: number | null;
  end_time: number | null;
  key_id: number;
}

interface Device {
  id: number;
  device_id: string;
  connected: boolean;
  last_connexion_attempt: string;
}

export function GamePage({ config, gameUniqid, launchedGameId, onBack }: GamePageProps) {
  const [gameMetadata, setGameMetadata] = useState<GameMetadata | null>(null);
  const [loading, setLoading] = useState(true);

  const [showPanel, setShowPanel] = useState(false);
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showTestModal, setShowTestModal] = useState(false);
  const [postAnimExitDelayMs, setPostAnimExitDelayMs] = useState(0);
  const [showRankings, setShowRankings] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [rankings, setRankings] = useState<Team[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant: 'danger' | 'warning' | 'info';
    confirmText?: string;
  }>({ isOpen: false, title: '', message: '', onConfirm: () => {}, variant: 'warning' });

  useEffect(() => {
    const loadGameMetadata = async () => {
      try {
        const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

        if (isElectron) {
          const gameDataContent = await (window as any).electron.games.readFile(gameUniqid, 'game-data.json');
          const data = JSON.parse(gameDataContent);

          let type, title;
          if (data.game && data.game.type) {
            type = data.game.type;
            title = data.game.title || 'Unknown Game';
          } else if (data.scenario) {
            type = data.scenario.scenario_type;
            title = data.scenario.title || data.scenario.name;
          } else {
            type = 'unknown';
            title = 'Unknown Game';
          }

          setGameMetadata({ type, title });
        } else {
          const { data: scenario, error } = await supabase
            .from('scenarios')
            .select('title, game_type')
            .eq('uniqid', gameUniqid)
            .maybeSingle();

          if (error || !scenario) {
            try {
              const response = await fetch(`/data/games/${gameUniqid}/game-data.json`);
              const data = await response.json();

              let type, title;
              if (data.game && data.game.type) {
                type = data.game.type;
                title = data.game.title || 'Unknown Game';
              } else if (data.scenario) {
                type = data.scenario.scenario_type;
                title = data.scenario.title || data.scenario.name;
              } else {
                type = 'unknown';
                title = 'Unknown Game';
              }

              setGameMetadata({ type, title });
            } catch {
              setGameMetadata({ type: 'unknown', title: 'Unknown Game' });
            }
          } else {
            setGameMetadata({ type: scenario.game_type, title: scenario.title });
          }
        }
      } catch {
        setGameMetadata({ type: 'unknown', title: 'Unknown Game' });
      } finally {
        setLoading(false);
      }
    };

    loadGameMetadata();
  }, [gameUniqid]);

  const handleCornerTap = useCallback(() => {
    tapCountRef.current += 1;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => { tapCountRef.current = 0; }, 800);
    if (tapCountRef.current >= 4) {
      tapCountRef.current = 0;
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      setShowPanel(true);
    }
  }, []);

  const loadRankings = async () => {
    if (!launchedGameId) return;
    const { data } = await supabase
      .from('teams')
      .select('*')
      .eq('launched_game_id', launchedGameId)
      .order('score', { ascending: false });
    setRankings(data || []);
    setShowRankings(true);
  };

  const loadDevices = async () => {
    if (!launchedGameId) return;
    const { data } = await supabase
      .from('launched_game_devices')
      .select('*')
      .eq('launched_game_id', launchedGameId)
      .order('last_connexion_attempt', { ascending: false });
    setDevices(data || []);
    setShowDevices(true);
  };

  const handleEndGame = () => {
    setConfirmDialog({
      isOpen: true,
      title: 'End Game',
      message: 'Are you sure you want to end this game? This will mark it as completed.',
      variant: 'warning',
      confirmText: 'End Game',
      onConfirm: async () => {
        if (!launchedGameId) return;
        await supabase.from('launched_games').update({ ended: true }).eq('id', launchedGameId);
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        setShowPanel(false);
        onBack();
      },
    });
  };

  const handleDeleteGame = () => {
    setConfirmDialog({
      isOpen: true,
      title: 'Delete Game',
      message: 'Are you sure you want to delete this game? This will permanently remove all data. This action cannot be undone.',
      variant: 'danger',
      confirmText: 'Delete Game',
      onConfirm: async () => {
        if (!launchedGameId) return;
        await supabase.from('teams').delete().eq('launched_game_id', launchedGameId);
        await supabase.from('launched_game_devices').delete().eq('launched_game_id', launchedGameId);
        await supabase.from('launched_game_meta').delete().eq('launched_game_id', launchedGameId);
        await supabase.from('launched_games').delete().eq('id', launchedGameId);
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        setShowPanel(false);
        onBack();
      },
    });
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return 'Not started';
    return new Date(ts).toLocaleTimeString();
  };

  const handleGameEnd = useCallback(() => {
    setShowLeaderboard(true);
  }, []);

  if (loading) {
    return (
      <div className="fixed inset-0 z-[100] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  const renderGame = () => {
    if (showLeaderboard) {
      return (
        <LeaderboardPage
          launchedGameId={launchedGameId}
          config={config}
          gameName={gameMetadata?.title}
          onBack={onBack}
        />
      );
    }
    if (gameMetadata?.type === 'mystery') {
      return <MysteryGamePage config={config} gameUniqid={gameUniqid} launchedGameId={launchedGameId} onBack={onBack} onGameEnd={handleGameEnd} />;
    }
    if (gameMetadata?.type === 'tagquest') {
      return <TagQuestGamePage config={config} gameUniqid={gameUniqid} launchedGameId={launchedGameId} onBack={onBack} onGameEnd={handleGameEnd} postAnimExitDelayMs={postAnimExitDelayMs} />;
    }
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-white text-xl">Game type "{gameMetadata?.type}" not yet supported</div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[100] overflow-auto">
      {renderGame()}

      <div
        className="fixed top-0 right-0 w-20 h-20 z-[110] cursor-default select-none"
        onClick={handleCornerTap}
        style={{ WebkitTapHighlightColor: 'transparent' }}
      />

      {showPanel && (
        <div className="fixed inset-0 z-[120] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowPanel(false)}>
          <div
            className="bg-slate-800 border-2 border-slate-700 rounded-xl p-6 w-full max-w-sm shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Gamepad2 size={20} className="text-blue-400" />
                {config.name}
              </h3>
              <button onClick={() => setShowPanel(false)} className="text-slate-400 hover:text-white transition">
                <X size={20} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {launchedGameId && (
                <>
                  <button
                    onClick={() => { setShowPanel(false); setShowConfigModal(true); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <Settings size={16} />
                    Configure
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); setShowTestModal(true); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <FlaskConical size={16} />
                    Test
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); loadRankings(); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <Trophy size={16} />
                    Rankings
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); loadDevices(); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <Monitor size={16} />
                    Devices
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); handleEndGame(); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-orange-600 hover:bg-orange-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <StopCircle size={16} />
                    End Game
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); handleDeleteGame(); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <Trash2 size={16} />
                    Delete
                  </button>
                </>
              )}
            </div>

            <button
              onClick={() => { setShowPanel(false); onBack(); }}
              className="mt-4 w-full px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-medium transition"
            >
              Back to Launched Games
            </button>
          </div>
        </div>
      )}

      {showConfigModal && launchedGameId && (
        <LaunchedGameConfigModal
          gameId={launchedGameId}
          gameName={config.name}
          onClose={() => setShowConfigModal(false)}
          onSave={() => {}}
        />
      )}

      {showTestModal && launchedGameId && (
        <GameTestModal
          gameId={launchedGameId}
          gameName={config.name}
          onClose={() => setShowTestModal(false)}
          postAnimExitDelayMs={postAnimExitDelayMs}
          onPostAnimExitDelayChange={setPostAnimExitDelayMs}
        />
      )}

      {showRankings && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[130] p-4" onClick={() => setShowRankings(false)}>
          <div className="bg-slate-800 border-2 border-slate-700 rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-bold text-white flex items-center gap-2">
                <Trophy size={24} className="text-yellow-500" />
                Rankings
              </h3>
              <button onClick={() => setShowRankings(false)} className="text-slate-400 hover:text-white transition">
                <X size={20} />
              </button>
            </div>
            {rankings.length === 0 ? (
              <p className="text-slate-400 text-center py-8">No teams yet.</p>
            ) : (
              <div className="space-y-3">
                {rankings.map((team, index) => (
                  <div
                    key={team.id}
                    className={`p-4 rounded-lg border-2 ${
                      index === 0 ? 'bg-yellow-900/20 border-yellow-600' :
                      index === 1 ? 'bg-slate-700/50 border-slate-500' :
                      index === 2 ? 'bg-orange-900/20 border-orange-600' :
                      'bg-slate-800 border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className={`text-2xl font-bold ${
                          index === 0 ? 'text-yellow-500' : index === 1 ? 'text-slate-300' : index === 2 ? 'text-orange-500' : 'text-slate-400'
                        }`}>#{index + 1}</div>
                        <div>
                          <div className="flex items-center gap-2">
                            {team.end_time ? <CheckCircle size={16} className="text-green-500" /> :
                             team.start_time ? <Play size={16} className="text-blue-500" /> :
                             <Clock size={16} className="text-slate-500" />}
                            <span className="text-white font-semibold">Team {team.team_number}: {team.team_name}</span>
                          </div>
                          <p className="text-sm text-slate-400">Chip #{team.key_id}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-2xl font-bold text-white">{team.score}</div>
                        <div className="text-xs text-slate-400">points</div>
                      </div>
                    </div>
                    {(team.start_time || team.end_time) && (
                      <div className="mt-3 pt-3 border-t border-slate-700 text-sm text-slate-400 flex gap-4">
                        {team.start_time && <div>Start: <span className="text-white">{formatTime(team.start_time)}</span></div>}
                        {team.end_time && <div>End: <span className="text-white">{formatTime(team.end_time)}</span></div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showDevices && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[130] p-4" onClick={() => setShowDevices(false)}>
          <div className="bg-slate-800 border-2 border-slate-700 rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-bold text-white flex items-center gap-2">
                <Monitor size={24} className="text-blue-400" />
                Devices
              </h3>
              <button onClick={() => setShowDevices(false)} className="text-slate-400 hover:text-white transition">
                <X size={20} />
              </button>
            </div>
            {devices.length === 0 ? (
              <p className="text-slate-400 text-center py-8">No devices connected yet.</p>
            ) : (
              <div className="space-y-3">
                {devices.map(device => (
                  <div key={device.id} className="p-4 rounded-lg border-2 bg-slate-800 border-slate-700">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Monitor size={20} className={device.connected ? 'text-green-500' : 'text-slate-500'} />
                        <div>
                          <div className="text-white font-semibold">{device.device_id}</div>
                          <p className="text-sm text-slate-400">Last attempt: {new Date(device.last_connexion_attempt).toLocaleString()}</p>
                        </div>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                        device.connected ? 'bg-green-900/30 text-green-400 border border-green-700' : 'bg-slate-700 text-slate-300 border border-slate-600'
                      }`}>
                        {device.connected ? 'Connected' : 'Disconnected'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(d => ({ ...d, isOpen: false }))}
        title={confirmDialog.title}
        message={confirmDialog.message}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
      />
    </div>
  );
}
