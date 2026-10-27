import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { GameConfig } from './LaunchGameModal';
import { MysteryGamePage } from './MysteryGamePage';
import { TagQuestGamePage } from './TagQuestGamePage';
import { TracksGamePage } from './TracksGamePage';
import { ClashGamePage } from './ClashGamePage';
import { LeaderboardPage } from './LeaderboardPage';
import { LaunchedGameConfigModal } from './LaunchedGameConfigModal';
import { GameTestModal } from './GameTestModal';
import { ConfirmDialog } from './ConfirmDialog';
import { GameDevicesModal } from './GameDevicesModal';
import { VideoControlModal } from './VideoControlModal';
import { PinExitPrompt } from './PinExitPrompt';
import { loadConfig } from '../utils/config';
import * as scenarioStore from '../services/scenarioStore';
import { fetchScenarioFromMother, motherRoute, type MotherFetchFailure } from '../services/peerContent';
import {
  endLaunchedGame,
  deleteLaunchedGame,
  getLaunchedGameState,
  getLaunchedGameMeta,
  addLaunchedGameTime,
  broadcastConfigReload,
} from '../services/launchedGames';
import { gameConfigFromMeta } from '../utils/gameConfigFromMeta';
import { onPendingConfigReload, onPendingRejoin, onGameGone } from '../services/pendingJoinStore';
import { setBaseInGame, setBaseHome } from '../services/screenState';
import { setActiveLaunchedGameId } from '../services/activeGameStore';

// Game simulator floating window (tester builds only - inline guard so the
// stable build drops the chunk).
const SimFloatingWindow =
  import.meta.env.DEV || import.meta.env.VITE_QA_HARNESS === '1'
    ? lazy(() => import('../simulator/SimFloatingWindow').then((m) => ({ default: m.SimFloatingWindow })))
    : null;
import { Settings, FlaskConical, Trophy, Monitor, StopCircle, Trash2, X, Gamepad2, Play, Clock, CheckCircle, Film } from 'lucide-react';

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

export function GamePage({ config: initialConfig, gameUniqid, launchedGameId, onBack }: GamePageProps) {
  // Operator chrome (controls panel, confirmations, PIN prompts) speaks the
  // app language of whoever runs the device - not the players' launch language.
  const { t } = useTranslation('operatorControls');
  // Live config: starts from the launch snapshot but is re-derived from the DB
  // meta whenever the in-game config modal saves, so edits apply to the running
  // page (the renderers read these fields on every render).
  const [config, setConfig] = useState<GameConfig>(initialConfig);

  const reloadConfig = useCallback(async () => {
    if (!launchedGameId) return;
    try {
      const meta = await getLaunchedGameMeta(launchedGameId);
      setConfig((prev) => gameConfigFromMeta(meta, { name: prev.name, numberOfTeams: prev.numberOfTeams }));
    } catch (err) {
      console.error('[GamePage] reload config after save failed:', err);
    }
  }, [launchedGameId]);

  // A config edit made on ANOTHER device (the mother's launched-games list or a
  // peer's operator panel) lands here as a `reload_config` push → re-derive our
  // running config from the freshly-saved meta so the edit applies live.
  useEffect(() => {
    if (!launchedGameId) return;
    return onPendingConfigReload((gid) => {
      if (gid === launchedGameId) void reloadConfig();
    });
  }, [launchedGameId, reloadConfig]);

  // The game is gone from the mother (deleted / archived, the push that says
  // so missed): leave it rather than poll a game that no longer exists.
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!launchedGameId) return;
    return onGameGone((gid) => {
      if (gid !== launchedGameId) return false;
      onBackRef.current();
      return true;
    });
  }, [launchedGameId]);

  const [gameMetadata, setGameMetadata] = useState<GameMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  // game-data.json absent locally (scenario never synced to this device).
  // Holds the best title we know; bumping `loadAttempt` re-runs the loader.
  const [missingScenario, setMissingScenario] = useState<{ title: string } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Fetching that scenario from the mother (offline venue). Each bump of
  // `motherFetchRun` starts one fetch; the first one starts by itself when the
  // scenario turns out missing, later ones from the panel's button.
  const [motherFetch, setMotherFetch] = useState<
    | { kind: 'idle' }
    | { kind: 'fetching'; file: string | null; pct: number | null; filesDone: number }
    | { kind: 'failed'; reason: MotherFetchFailure }
  >({ kind: 'idle' });
  const [motherFetchRun, setMotherFetchRun] = useState(0);
  const autoFetchArmedRef = useRef(true);
  const motherFetchAbortRef = useRef<AbortController | null>(null);

  const [showPanel, setShowPanel] = useState(false);
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "Use PIN to exit" gate. When the pref is on, every way out of a running
  // game (the visible Back buttons in each renderer, the leaderboard Back, and
  // opening the 4-tap operator panel) is funneled through a PIN prompt. Once
  // the panel is open the PIN has already been entered, so its internal
  // actions (Back to Launched Games / End / Delete) use the raw onBack and
  // don't re-prompt.
  const [requirePinExit, setRequirePinExit] = useState(false);
  const [pinGate, setPinGate] = useState<{ run: () => void; subtitle?: string } | null>(null);

  // Operator-only devices are the only ones that may open the 4-tap operator
  // panel. On every other (player-facing) device the 4-tap gesture is an
  // "I'm stuck, get me out" escape hatch instead: it leaves the game and
  // returns to the launched-games list (still behind the exit PIN when set).
  const [operatorOnly, setOperatorOnly] = useState(false);

  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showTestModal, setShowTestModal] = useState(false);
  const [postAnimExitDelayMs, setPostAnimExitDelayMs] = useState(0);
  const [showRankings, setShowRankings] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [showVideoControl, setShowVideoControl] = useState(false);
  const [rankings, setRankings] = useState<Team[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant: 'danger' | 'warning' | 'info';
    confirmText?: string;
  }>({ isOpen: false, title: '', message: '', onConfirm: () => {}, variant: 'warning' });

  // A "Reconnect" push from the mother's Devices modal lands here when this
  // device is already in the game but drifted onto the in-game leaderboard /
  // rankings overlay. Drop those overlays so we snap back to the game view.
  useEffect(() => {
    if (!launchedGameId) return;
    return onPendingRejoin((gid) => {
      if (gid !== launchedGameId) return;
      setShowLeaderboard(false);
      setShowRankings(false);
    });
  }, [launchedGameId]);

  useEffect(() => {
    const loadGameMetadata = async () => {
      try {
        // Slice 2: scenario metadata + game-data.json come from the local
        // SQLite/FS store. No remote scenarios endpoint anymore.
        const gd = (await scenarioStore.getGameData(gameUniqid)) as any;
        if (!gd) {
          // No game data on this device: every renderer would sit on its own
          // "Loading game data…" forever (or "unsupported type" with no row).
          // Say so instead, with a retry once the scenario has been synced.
          const row = await scenarioStore.get(gameUniqid).catch(() => null);
          setMissingScenario({ title: row?.title || initialConfig.name || gameUniqid });
          // Routed to a mother: ask it for the scenario, once on our own.
          if (autoFetchArmedRef.current && motherRoute()) {
            autoFetchArmedRef.current = false;
            setMotherFetchRun((n) => n + 1);
          }
          return;
        }
        setMissingScenario(null);
        let type: string | undefined;
        let title: string | undefined;
        if (gd.game && gd.game.type) {
          type = gd.game.type;
          title = gd.game.title || t('gamePanel.unknownGame');
        } else if (gd.scenario) {
          type = gd.scenario.scenario_type;
          title = gd.scenario.title || gd.scenario.name;
        }
        if (type && title) {
          setGameMetadata({ type, title });
          return;
        }
        const row = await scenarioStore.get(gameUniqid);
        if (row) {
          setGameMetadata({ type: row.game_type, title: row.title });
        } else {
          setGameMetadata({ type: 'unknown', title: t('gamePanel.unknownGame') });
        }
      } catch {
        setGameMetadata({ type: 'unknown', title: t('gamePanel.unknownGame') });
      } finally {
        setLoading(false);
      }
    };

    loadGameMetadata();
  }, [gameUniqid, t, initialConfig.name, loadAttempt]);

  // Scenario missing and we're routed to a mother: fetch it from there, then
  // reload. Videos may still be missing afterwards - the renderers already play
  // on without them.
  useEffect(() => {
    if (motherFetchRun === 0) return;
    const ctrl = new AbortController();
    motherFetchAbortRef.current = ctrl;
    let filesDone = 0;
    setMotherFetch({ kind: 'fetching', file: null, pct: null, filesDone: 0 });
    void fetchScenarioFromMother(gameUniqid, {
      patternUniqid: initialConfig.pattern || null,
      signal: ctrl.signal,
      onProgress: (p) => {
        if (ctrl.signal.aborted) return;
        if (p.done) filesDone += 1;
        const file = p.label.replace(/^Scenario media: /, '');
        const pct = p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : null;
        setMotherFetch({ kind: 'fetching', file: p.done ? null : file, pct: p.done ? null : pct, filesDone });
      },
    }).then((res) => {
      if (ctrl.signal.aborted) return;
      if (res.ok) {
        setMotherFetch({ kind: 'idle' });
        setLoading(true);
        setLoadAttempt((n) => n + 1);
      } else {
        setMotherFetch({ kind: 'failed', reason: res.reason });
      }
    });
    return () => ctrl.abort();
  }, [motherFetchRun, gameUniqid, initialConfig.pattern]);

  // Publish this device's screen state as "in this game" while a game page is
  // mounted, so the mother's Devices modal can show what each peer is showing.
  // Reverts to the idle/home state on unmount (back to launched-games list).
  // Wrapper-only (v1): board-hidden / instructions / reveal refinements layer
  // in later - see services/screenState.ts. The pushed leaderboard / operator
  // video overlays publish their own 'ranking' / 'video' states on top.
  useEffect(() => {
    setBaseInGame(launchedGameId, gameMetadata?.title ?? config.name ?? null);
    return () => setBaseHome();
  }, [launchedGameId, gameMetadata?.title, config.name]);

  // Mother-failover slice 1: tell the mother-ping path which game this device
  // is in, so the mother ships this game's failover snapshot and the ping
  // cadence tightens while we're playing. Cleared on unmount (back to idle).
  useEffect(() => {
    setActiveLaunchedGameId(launchedGameId);
    return () => setActiveLaunchedGameId(null);
  }, [launchedGameId]);

  // Read the kiosk exit-PIN pref once. Until it resolves we leave gating off;
  // config.json loads in a few ms and a player won't be hitting Back that fast.
  useEffect(() => {
    let cancelled = false;
    void loadConfig()
      .then((c) => {
        if (cancelled) return;
        setRequirePinExit(Boolean(c.requirePinToExitGame));
        setOperatorOnly(Boolean(c.operatorOnlyDevice));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Run `action` immediately, or behind a PIN prompt when the pref is on.
  const runGuarded = useCallback(
    (run: () => void, subtitle?: string) => {
      if (requirePinExit) setPinGate({ run, subtitle });
      else run();
    },
    [requirePinExit]
  );

  // Passed to every game renderer + the leaderboard in place of the raw
  // onBack, so their visible Back buttons prompt for the PIN first.
  const guardedBack = useCallback(
    () => runGuarded(onBack, t('gamePanel.pinToLeave')),
    [runGuarded, onBack, t]
  );

  const handleCornerTap = useCallback(() => {
    tapCountRef.current += 1;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => { tapCountRef.current = 0; }, 800);
    if (tapCountRef.current >= 4) {
      tapCountRef.current = 0;
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      // Operator devices get the controls panel; player devices get an exit
      // back to the launched-games list. Both stay behind the PIN when set.
      if (operatorOnly) {
        runGuarded(() => setShowPanel(true), t('gamePanel.pinToOpenControls'));
      } else {
        runGuarded(onBack, t('gamePanel.pinToLeave'));
      }
    }
  }, [runGuarded, operatorOnly, onBack, t]);

  const loadRankings = async () => {
    if (!launchedGameId) return;
    try {
      const state = await getLaunchedGameState(launchedGameId, 0);
      const sorted = [...state.teams]
        .map((t) => ({ ...t, team_name: t.team_name ?? '' }))
        .sort((a, b) => b.score - a.score);
      setRankings(sorted as any);
      setShowRankings(true);
    } catch (err) {
      console.error('[GamePage] loadRankings failed:', err);
    }
  };

  const loadDevices = () => {
    // The shared <GameDevicesModal> fetches its own data and polls every 2s
    // while open. We just toggle the visibility flag here.
    if (!launchedGameId) return;
    setShowDevices(true);
  };

  const handleEndGame = () => {
    setConfirmDialog({
      isOpen: true,
      title: t('gamePanel.endGameTitle'),
      message: t('gamePanel.endGameMessage'),
      variant: 'warning',
      confirmText: t('gamePanel.endGame'),
      onConfirm: async () => {
        if (!launchedGameId) return;
        try {
          await endLaunchedGame(launchedGameId);
        } catch (err) {
          console.error('[GamePage] endLaunchedGame failed:', err);
        }
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        setShowPanel(false);
        onBack();
      },
    });
  };

  const handleDeleteGame = () => {
    setConfirmDialog({
      isOpen: true,
      title: t('gamePanel.deleteTitle'),
      message: t('gamePanel.deleteMessage'),
      variant: 'danger',
      confirmText: t('gamePanel.deleteTitle'),
      onConfirm: async () => {
        if (!launchedGameId) return;
        try {
          // FK ON DELETE CASCADE removes teams + meta + devices + raw_data.
          await deleteLaunchedGame(launchedGameId);
        } catch (err) {
          console.error('[GamePage] deleteLaunchedGame failed:', err);
        }
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        setShowPanel(false);
        onBack();
      },
    });
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return t('gamePanel.notStarted');
    // Team start_time / end_time are stored in unix SECONDS; the Date ctor wants
    // milliseconds, so scale by 1000 to avoid a 1970 timestamp.
    return new Date(ts * 1000).toLocaleTimeString();
  };

  const handleGameEnd = useCallback(() => {
    setShowLeaderboard(true);
  }, []);

  if (loading) {
    return (
      <div className="fixed inset-0 z-[100] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl">{t('gamePanel.loading')}</div>
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
          onBack={guardedBack}
        />
      );
    }
    if (missingScenario) {
      const fetching = motherFetch.kind === 'fetching' ? motherFetch : null;
      const failedReason =
        motherFetch.kind === 'failed' && motherFetch.reason !== 'cancelled' && motherFetch.reason !== 'no_mother'
          ? motherFetch.reason
          : null;
      const canAskMother = !fetching && motherRoute() !== null;
      return (
        <div className="min-h-full bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-slate-800/80 border border-slate-700 rounded-xl p-6 text-center">
            <h2 className="text-white text-xl font-semibold mb-3">{t('gamePanel.missingTitle')}</h2>
            {fetching ? (
              <div className="mb-6">
                <p className="text-slate-300 text-sm mb-3">{t('gamePanel.missingFetching')}</p>
                <div className="h-2 w-full bg-slate-700 rounded overflow-hidden mb-2">
                  <div
                    className={`h-full bg-blue-500 transition-all ${fetching.pct === null ? 'animate-pulse w-full opacity-40' : ''}`}
                    style={fetching.pct !== null ? { width: `${fetching.pct}%` } : undefined}
                  />
                </div>
                {fetching.file && fetching.pct !== null && (
                  <p className="text-slate-400 text-xs truncate">
                    {t('gamePanel.missingFetchingFile', { file: fetching.file, pct: fetching.pct })}
                  </p>
                )}
                {fetching.filesDone > 0 && (
                  <p className="text-slate-400 text-xs">{t('gamePanel.missingFilesDone', { count: fetching.filesDone })}</p>
                )}
              </div>
            ) : (
              <p className="text-slate-300 text-sm mb-6">
                {failedReason
                  ? t(`gamePanel.missingReason_${failedReason}`)
                  : t('gamePanel.missingBody', { title: missingScenario.title })}
              </p>
            )}
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => {
                  motherFetchAbortRef.current?.abort();
                  guardedBack();
                }}
                className="px-4 py-3 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm font-medium transition"
              >
                {fetching ? t('gamePanel.missingCancel') : t('gamePanel.missingBack')}
              </button>
              {!fetching && (
                <button
                  onClick={() => {
                    setMotherFetch({ kind: 'idle' });
                    if (canAskMother) {
                      setMotherFetchRun((n) => n + 1);
                    } else {
                      setLoading(true);
                      setLoadAttempt((n) => n + 1);
                    }
                  }}
                  className="px-4 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition"
                >
                  {canAskMother ? t('gamePanel.missingFromMother') : t('gamePanel.missingRetry')}
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    if (gameMetadata?.type === 'mystery') {
      return <MysteryGamePage config={config} gameUniqid={gameUniqid} launchedGameId={launchedGameId} onBack={guardedBack} onGameEnd={handleGameEnd} />;
    }
    if (gameMetadata?.type === 'tagquest') {
      return <TagQuestGamePage config={config} gameUniqid={gameUniqid} launchedGameId={launchedGameId} onBack={guardedBack} onGameEnd={handleGameEnd} postAnimExitDelayMs={postAnimExitDelayMs} />;
    }
    if (gameMetadata?.type === 'tracks') {
      return <TracksGamePage config={config} gameUniqid={gameUniqid} launchedGameId={launchedGameId} onBack={guardedBack} onGameEnd={handleGameEnd} />;
    }
    if (gameMetadata?.type === 'clash') {
      return <ClashGamePage config={config} gameUniqid={gameUniqid} launchedGameId={launchedGameId} onBack={guardedBack} onGameEnd={handleGameEnd} />;
    }
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-white text-xl">{t('gamePanel.unsupportedType', { type: gameMetadata?.type ?? '' })}</div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[100] overflow-auto">
      {renderGame()}

      {SimFloatingWindow && launchedGameId !== null && (
        <Suspense fallback={null}>
          <SimFloatingWindow launchedGameId={launchedGameId} />
        </Suspense>
      )}

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
                    {t('gamePanel.configure')}
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); setShowTestModal(true); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <FlaskConical size={16} />
                    {t('gamePanel.test')}
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); loadRankings(); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <Trophy size={16} />
                    {t('gamePanel.rankings')}
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); loadDevices(); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <Monitor size={16} />
                    {t('gamePanel.devices')}
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); setShowVideoControl(true); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <Film size={16} />
                    {t('gamePanel.playVideo')}
                  </button>
                  {gameMetadata?.type === 'clash' && (
                    <button
                      onClick={() => {
                        void addLaunchedGameTime(launchedGameId, 5).catch(() => {});
                        setShowPanel(false);
                      }}
                      className="flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition"
                    >
                      <Clock size={16} />
                      {t('gamePanel.addFiveMin')}
                    </button>
                  )}
                  <button
                    onClick={() => { setShowPanel(false); handleEndGame(); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-orange-600 hover:bg-orange-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <StopCircle size={16} />
                    {t('gamePanel.endGame')}
                  </button>
                  <button
                    onClick={() => { setShowPanel(false); handleDeleteGame(); }}
                    className="flex items-center justify-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    <Trash2 size={16} />
                    {t('gamePanel.delete')}
                  </button>
                </>
              )}
            </div>

            <button
              onClick={() => { setShowPanel(false); onBack(); }}
              className="mt-4 w-full px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-medium transition"
            >
              {t('gamePanel.backToLaunched')}
            </button>
          </div>
        </div>
      )}

      {showConfigModal && launchedGameId && (
        <LaunchedGameConfigModal
          gameId={launchedGameId}
          gameName={config.name}
          gameUniqid={gameUniqid}
          gameType={gameMetadata?.type}
          onClose={() => setShowConfigModal(false)}
          onSave={() => {
            void reloadConfig();
            void broadcastConfigReload(launchedGameId);
          }}
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
                {t('gamePanel.rankings')}
              </h3>
              <button onClick={() => setShowRankings(false)} className="text-slate-400 hover:text-white transition">
                <X size={20} />
              </button>
            </div>
            {rankings.length === 0 ? (
              <p className="text-slate-400 text-center py-8">{t('gamePanel.noTeams')}</p>
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
                            <span className="text-white font-semibold">{t('gamePanel.teamLabel', { number: team.team_number, name: team.team_name })}</span>
                          </div>
                          <p className="text-sm text-slate-400">{t('gamePanel.chipLabel', { id: team.key_id })}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-2xl font-bold text-white">{team.score}</div>
                        <div className="text-xs text-slate-400">{t('gamePanel.points')}</div>
                      </div>
                    </div>
                    {(team.start_time || team.end_time) && (
                      <div className="mt-3 pt-3 border-t border-slate-700 text-sm text-slate-400 flex gap-4">
                        {team.start_time && <div>{t('gamePanel.startLabel')} <span className="text-white">{formatTime(team.start_time)}</span></div>}
                        {team.end_time && <div>{t('gamePanel.endLabel')} <span className="text-white">{formatTime(team.end_time)}</span></div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showDevices && launchedGameId && (
        <GameDevicesModal
          launchedGameId={launchedGameId}
          gameLanguage={config.language ?? 'fr'}
          isMother={true}
          onClose={() => setShowDevices(false)}
        />
      )}

      {showVideoControl && gameMetadata && (
        <VideoControlModal
          gameUniqid={gameUniqid}
          gameType={gameMetadata.type}
          gameLanguage={config.language ?? 'fr'}
          onClose={() => setShowVideoControl(false)}
        />
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

      {pinGate && (
        <PinExitPrompt
          subtitle={pinGate.subtitle}
          onSuccess={() => {
            const run = pinGate.run;
            setPinGate(null);
            run();
          }}
          onCancel={() => setPinGate(null)}
        />
      )}
    </div>
  );
}
