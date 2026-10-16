import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Trash2, Clock, CheckCircle, Trophy, Gamepad2, Minimize2, Maximize2, Monitor, StopCircle, Settings, FlaskConical, X, Database, Archive, Dices, Printer, Video, Bug, LayoutGrid, List } from 'lucide-react';
import { GamePage } from './GamePage';
import { GameTypeIcon } from './icons/GameTypeIcons';
import { useCustomers } from './customers/useCustomers';
import { AssignCustomerModal } from './customers/AssignCustomerModal';
import { CustomerChip } from './customers/CustomerChip';
import type { CustomerValue } from './customers/CustomerCombobox';
import { useAuth } from './auth/AuthProvider';
import * as cardsStore from '../services/cardsStore';
import * as cardsRepo from '../services/cardsRepo';
import * as scenarioStore from '../services/scenarioStore';
import {
  listLaunchedGames,
  listOwnLocalGames,
  onGamesReconciled,
  getLaunchedGameMeta,
  endLaunchedGame,
  deleteLaunchedGame,
  archiveLaunchedGame,
  listArchivedSummaries,
  type GameSummaryRow,
  registerDeviceForGame,
  queueShowTeamSummaryBulk,
  getLaunchedGameDevices,
  broadcastConfigReload,
} from '../services/launchedGames';
import { loadLaunchedGameReports } from '../services/reportStats';
import { printReports } from '../services/reportPrint';
import { GameDevicesModal } from './GameDevicesModal';
import { GameVideoModal } from './GameVideoModal';
import { RawDataModal } from './RawDataModal';
import { BugReportModal } from './BugReportModal';
import { onPendingJoin, onPendingLeave, type PendingJoinRoute } from '../services/pendingJoinStore';
import { pointLaunchedGamesAtMother } from '../services/lanMotherBoot';
import { isOperatorOnly } from '../services/operatorMode';
import { refreshLaunchedGamesRoute, onLaunchedGamesRouteChange } from '../services/childControlLink';
import { onMotherReachability } from '../services/motherFailover';
import { GameLockGate } from './GameLockGate';
import { getDeviceLockState, type LockReason } from '../services/deviceLock';
import { ApiError, getLanOverride, setLanOverride } from '../services/api';
import { ConfirmDialog } from './ConfirmDialog';
import { LaunchedGameConfigModal } from './LaunchedGameConfigModal';
import { GameTestModal } from './GameTestModal';
import { IS_TESTER_BUILD } from '../services/simChips';
import { isAndroid } from '../utils/platform';

// Tester builds only: the stable build never loads the simulator chunk.
const SimulatorOverlay =
  import.meta.env.DEV || import.meta.env.VITE_QA_HARNESS === '1'
    ? lazy(() => import('../simulator/SimulatorWindow').then((m) => ({ default: m.SimulatorOverlay })))
    : () => null;
import { TeamTestModal } from './TeamTestModal';
import { TeamDetailsModal } from './TeamDetailsModal';
import { ClashClanDetailsModal } from './ClashClanDetailsModal';
import { AddTimeModal } from './AddTimeModal';
import { PrePrintModal } from './PrePrintModal';
import type { PrintPrefs } from '../services/printPrefsStore';
import {
  LaunchedGameTeamsPanel,
  type LaunchedGame,
  type ConfirmDialogState,
  type TeamDetailsRequest,
  type ClashClanRequest,
  type TeamTestRequest,
} from './LaunchedGameTeamsPanel';
import { LeaderboardPage } from './LeaderboardPage';
import { RankingsModal } from './RankingsModal';
import { RankingOptionsModal, type RankingAction } from './RankingOptionsModal';
import { RankingDevicePicker } from './RankingDevicePicker';
import { DevicePicker } from './DevicePicker';
import { buildTeamSummarySnapshot } from '../services/teamSummary';
import { encodeTeamSummarySnapshot } from '../services/teamSummaryTarget';
import { TimeRangeLeaderboard } from './TimeRangeLeaderboard';
import { MultiGameLeaderboard } from './MultiGameLeaderboard';
import { openProjector } from '../services/projectorWindow';
import type { RankingTarget } from '../services/rankingTarget';
import type { ScenarioOption, TimeRange, ActiveGameOption } from './RankingsModal';
import type { GameConfig } from './LaunchGameModal';
import { gameConfigFromMeta } from '../utils/gameConfigFromMeta';
import type { SiPuce } from '../types/database';
import { formatDbDateTime } from '../utils/dbTime';

// "Expand current" grid mode, remembered on this device across page visits.
const EXPAND_CURRENT_KEY = 'pg.launched.expandCurrent';
// Grid open: how often the games list itself is re-read.
const GRID_GAMES_REFRESH_MS = 10_000;

function readExpandCurrentPref(): boolean {
  try { return localStorage.getItem(EXPAND_CURRENT_KEY) === '1'; } catch { return false; }
}

function writeExpandCurrentPref(on: boolean): void {
  try {
    if (on) localStorage.setItem(EXPAND_CURRENT_KEY, '1');
    else localStorage.removeItem(EXPAND_CURRENT_KEY);
  } catch { /* storage unavailable - mode just isn't remembered */ }
}

interface GameData {
  game: {
    uniqid: string;
    title: string;
    type: string;
  };
}

// Game-type → display label + pill colors for the launched-game card badge.
// launched_games stores game_type capitalised ('TagQuest'); we key off the
// lowercase slug so either casing (and the scenario gameDataMap fallback) works.
const GAME_TYPE_BADGE: Record<string, { label: string; className: string }> = {
  tagquest: { label: 'Quest', className: 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300' },
  mystery: { label: 'Mystery', className: 'bg-purple-500/15 border-purple-500/40 text-purple-300' },
  tracks: { label: 'Track', className: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' },
  clash: { label: 'Clash', className: 'bg-rose-500/15 border-rose-500/40 text-rose-300' },
};

function gameTypeBadge(raw: string): { label: string; className: string } {
  const key = (raw || '').toLowerCase();
  return (
    GAME_TYPE_BADGE[key] ?? {
      label: raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Unknown',
      className: 'bg-slate-600/40 border-slate-500/50 text-slate-300',
    }
  );
}

export function LaunchedGamesList({ isAdminMode = false }: { isAdminMode?: boolean }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [games, setGames] = useState<LaunchedGame[]>([]);
  // The launched_games LAN route the current `games` list was loaded from
  // (the mother's server for a satellite that joined a remote game, or this
  // device's own local server). Leaving a game page restores LOCAL routing
  // (so the list shows this device's own games), but the rows already on
  // screen may belong to a mother - so re-apply this captured route before
  // re-entering one, otherwise the meta/state reads hit the wrong server and
  // the play button silently no-ops. See handlePlayGame.
  const gamesRouteRef = useRef<ReturnType<typeof getLanOverride>>(null);
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Retours sept. #22: during a takeover the list could spin for minutes (the
  // launched_games call waits for a mother route that doesn't exist yet). After
  // 10 s the spinner gives way to an explanation and a retry.
  const [slowLoad, setSlowLoad] = useState(false);
  const [gameDataMap, setGameDataMap] = useState<Record<string, GameData>>({});
  // Per-game ranking flow: the Trophy button opens RankingOptionsModal (3
  // actions → only-this-game / time-range step); the chosen action resolves
  // to a RankingTarget that drives the full page, projector, or device push.
  const [rankingOptions, setRankingOptions] = useState<{
    launchedGameId: number;
    gameName: string;
    config: GameConfig;
    scenarioUniqid: string;
    scenarioTitle: string;
  } | null>(null);
  const [rankingDeviceTarget, setRankingDeviceTarget] = useState<RankingTarget | null>(null);
  // Per-team "show final summary on a device" flow (mystery + tracks): the
  // chosen team + its game; the DevicePicker builds the snapshot on send.
  const [summaryDeviceTarget, setSummaryDeviceTarget] = useState<{ game: LaunchedGame; teamId: number } | null>(null);
  const [rankingPageGame, setRankingPageGame] = useState<{ launchedGameId: number; gameName: string; config: GameConfig; autoScroll: boolean } | null>(null);
  const [playingGame, setPlayingGame] = useState<{ config: GameConfig; uniqid: string; launchedGameId: number } | null>(null);
  const [showDevices, setShowDevices] = useState<number | null>(null);
  const [showVideo, setShowVideo] = useState<number | null>(null);
  const [printing, setPrinting] = useState(false);
  // Pre-print modal (paper size + orientation) - printing goes through it.
  const [printTarget, setPrintTarget] = useState<{ game: LaunchedGame; teamId: number | null; subject: string } | null>(null);
  const [showRawData, setShowRawData] = useState<{ id: number; name: string } | null>(null);
  const [bugReportGame, setBugReportGame] = useState<LaunchedGame | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    variant: 'warning',
  });
  const [configGameId, setConfigGameId] = useState<number | null>(null);
  const [configGameName, setConfigGameName] = useState<string>('');
  // Game type + scenario uniqid drive the config modal's per-type field set
  // (and the tracks options section). Captured when the modal is opened.
  const [configGameType, setConfigGameType] = useState<string>('');
  const [configGameUniqid, setConfigGameUniqid] = useState<string>('');
  const [testGameId, setTestGameId] = useState<number | null>(null);
  // Game simulator panel (tester builds): runs here or on any device of the game.
  const [simGameId, setSimGameId] = useState<number | null>(null);
  const [testGameName, setTestGameName] = useState<string>('');
  const [testTeam, setTestTeam] = useState<TeamTestRequest | null>(null);
  const [allChips, setAllChips] = useState<SiPuce[]>([]);
  // Team-level modals, opened from whichever teams panel (side or grid column)
  // asked; each request carries its game + that panel's reload.
  const [teamDetails, setTeamDetails] = useState<TeamDetailsRequest | null>(null);
  const [clashClan, setClashClan] = useState<ClashClanRequest | null>(null);
  // Operator "add time" modal target.
  const [addTimeGame, setAddTimeGame] = useState<{ id: number; name: string } | null>(null);
  const [showRankingsModal, setShowRankingsModal] = useState(false);
  const [timeRangePage, setTimeRangePage] = useState<{ scenario: ScenarioOption; timeRange: TimeRange } | null>(null);
  const [activeGamesPage, setActiveGamesPage] = useState<ActiveGameOption[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedSummaries, setArchivedSummaries] = useState<GameSummaryRow[]>([]);
  // Licensee customer of a game, set after launch (project_licensee_customers).
  const customersSupported = useCustomers().snapshot.supported;
  const [assignTarget, setAssignTarget] = useState<{
    gameId?: number;
    summaryUuid?: string;
    name: string;
    current: CustomerValue | null;
  } | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  // When true, the launched-game cards collapse to a compact list. The selected
  // game keeps its full card so the operator never loses sight of it.
  const [gamesMinimized, setGamesMinimized] = useState(true);
  // "Expand current" grid: ids of the games shown side by side (rendered in
  // list order); null = normal list + side panel. A game that ends while the
  // grid is open stays in it until the operator goes back to the list; newly
  // launched games join it.
  const [expandedIds, setExpandedIds] = useState<number[] | null>(null);
  // A grid remembered from a previous visit is reopened once the first games
  // load lands (see the restore effect).
  const restoreExpandRef = useRef(readExpandCurrentPref());
  // The full-page spinner covers the FIRST load only: later reloads keep the
  // page - and each teams panel's search / open forms - mounted.
  const [loadedOnce, setLoadedOnce] = useState(false);
  // True when this device is a CHILD viewing a mother's games (the launched_games
  // override points at a remote mother, not our own 127.0.0.1 server). Drives the
  // two-section layout: the mother's games (active by default, "Load more" for
  // ended) plus a read-only "This device" section for our own local history.
  const [isChildView, setIsChildView] = useState(false);
  // Child view only: reveal the mother's ENDED games (hidden behind "Load more").
  const [showEndedMother, setShowEndedMother] = useState(false);
  // Child view only: this device's OWN local launched games (read-only history),
  // loaded via the api.ts forceLocal bypass so they survive the override pointing
  // at the mother. Fetched with mine=1 so it lists only games this device launched
  // or participated in - never games it merely hosted for other satellites when it
  // was itself a mother (those local rows carry another device's peer, is_self=0).
  const [localGames, setLocalGames] = useState<LaunchedGame[]>([]);
  // Operator-only devices manage games but never play, so the self-join "Play"
  // button is hidden on them (they keep every other control action).
  const [operatorOnly, setOperatorOnly] = useState(false);
  // Device-lock gate (emergency-disabled / past billing grace). When a privileged
  // game action is attempted on a locked device we stash it and show the
  // recovery-code gate; a reprieve re-runs the action. Same model as GameList.
  const [lockGate, setLockGate] = useState<{ reason: Exclude<LockReason, null>; run: () => void } | null>(null);
  // True when the mother a child is pointed at is currently unreachable (driven
  // by the shared reachability signal). Surfaces a banner; the list auto-recovers
  // when the mother returns and the route resolves again.
  const [motherUnreachable, setMotherUnreachable] = useState(false);

  useEffect(() => {
    void isOperatorOnly().then(setOperatorOnly).catch(() => setOperatorOnly(false));
    const onOpChange = () => void isOperatorOnly().then(setOperatorOnly).catch(() => {});
    window.addEventListener('operator-mode:changed', onOpChange);
    return () => window.removeEventListener('operator-mode:changed', onOpChange);
  }, []);

  // Mother-reachability banner: when a child's mother drops, the shared signal
  // flips; reload the list when it recovers so the games reappear automatically.
  useEffect(() => {
    return onMotherReachability((unreachable) => {
      setMotherUnreachable((was) => {
        if (was && !unreachable) void loadGames();
        return unreachable;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when the launched_games route converges (e.g. a satellite that just
  // auto-paired flips local→mother) so the list populates without a manual
  // refresh. childControlLink emits only on an actual route change.
  useEffect(() => {
    return onLaunchedGamesRouteChange(() => void loadGames());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A copy of a game just changed hands (a substitute handed back what it
  // hosted, or our copy caught up with the mother's): show it.
  useEffect(() => {
    return onGamesReconciled(() => void loadGames());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadGames();
    const loadChips = async () => {
      if (!user) return;
      try {
        const rows = await cardsRepo.list();
        const regularChips: SiPuce[] = rows.map((r) => ({
          id: r.id,
          key_number: r.key_number,
          key_name: r.key_name,
          color: r.color,
          created_at: '',
          updated_at: '',
        }));
        const onDemandJson = await cardsStore.getOnDemandCardsJson();
        const onDemandRecords = (onDemandJson as { cards?: Array<{ id?: number; key_number: number; key_name: string; color?: string | null }> } | null)?.cards ?? [];
        const onDemandMapped: SiPuce[] = onDemandRecords.map((c) => ({
          id: c.id ?? c.key_number,
          key_number: c.key_number,
          key_name: c.key_name,
          color: c.color ?? null,
          created_at: '',
          updated_at: '',
        }));
        const all = [...regularChips, ...onDemandMapped].sort((a, b) => a.key_number - b.key_number);
        setAllChips(all);
      } catch (err) {
        console.error('[LaunchedGamesList] failed to load chips:', err);
      }
    };
    loadChips();
  }, [user]);

  useEffect(() => {
    if (games.length > 0) {
      loadGameData();
    }
  }, [games]);

  // "Expand current" upkeep. After the first load, a remembered grid reopens
  // (or degrades: 1 active game → selected, 0 → plain list). While the grid is
  // open, newly launched games join it and deleted / archived ones leave it;
  // below two games it closes back to the normal view.
  useEffect(() => {
    if (!loadedOnce) return;
    if (restoreExpandRef.current) {
      restoreExpandRef.current = false;
      openExpandCurrent();
      return;
    }
    if (expandedIds === null) return;
    const present = new Set(games.map((g) => g.id));
    const kept = expandedIds.filter((id) => present.has(id));
    const added = games.filter((g) => !g.ended && !kept.includes(g.id)).map((g) => g.id);
    const next = [...kept, ...added];
    if (next.length < 2) {
      if (next.length === 1) setSelectedGameId(next[0]);
      closeExpandCurrent();
    } else if (next.length !== expandedIds.length || added.length > 0) {
      setExpandedIds(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedOnce, games]);

  // While the grid is open, re-read the games list so a game launched from
  // another device joins it and one that ends on its own shows "Ended".
  // Paused while this device plays a game (GamePage replaces the list).
  const gridOpen = expandedIds !== null && playingGame === null;
  useEffect(() => {
    if (!gridOpen) return;
    let busy = false;
    const h = setInterval(() => {
      if (busy) return;
      busy = true;
      void loadGames().finally(() => { busy = false; });
    }, GRID_GAMES_REFRESH_MS);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOpen]);

  // "Expand current" button: 2+ active games open the grid; a single one is
  // just selected (same as clicking it); none - nothing to expand.
  const openExpandCurrent = () => {
    const active = games.filter((g) => !g.ended);
    if (active.length >= 2) {
      setExpandedIds(active.map((g) => g.id));
      writeExpandCurrentPref(true);
      return;
    }
    if (active.length === 1) setSelectedGameId(active[0].id);
    closeExpandCurrent();
  };

  // Back to the list. selectedGameId is never touched by the grid, so the game
  // selected before it opened comes back as is.
  const closeExpandCurrent = () => {
    setExpandedIds(null);
    writeExpandCurrentPref(false);
  };

  // If this device is locked (emergency-disabled / past billing grace), stash the
  // attempted action behind the recovery-code gate and return true. A reprieve
  // re-runs `run`. Used to gate the privileged game-control actions a child can
  // now perform on the mother (self-join, add team, stop/delete/archive, launch
  // on another device). Running games are never interrupted - only new actions.
  const blockedByLock = async (run: () => void): Promise<boolean> => {
    const lock = await getDeviceLockState();
    if (lock.locked && lock.reason) {
      setLockGate({ reason: lock.reason, run });
      return true;
    }
    return false;
  };

  // Count devices currently joined to a game. Used to warn before a destructive
  // action (stop/delete/archive) when other devices are playing - a child
  // operator can't see the other rooms, so the count is cheap insurance.
  const countJoinedDevices = async (gameId: number): Promise<number> => {
    try {
      return (await getLaunchedGameDevices(gameId)).length;
    } catch {
      return 0;
    }
  };

  // Append a "(N devices are in this game)" warning to a destructive-action
  // confirmation message when joined devices > 0.
  const withDeviceWarning = (message: string, joined: number): string =>
    joined > 0
      ? `${message} ${t('launched:devicesInGameWarning', { count: joined })}`
      : message;

  const loadGames = async () => {
    setLoading(true);
    setSlowLoad(false);
    const slowTimer = setTimeout(() => setSlowLoad(true), 10_000);
    try {
      const rows = await listLaunchedGames();
      // Remember which server these rows came from so re-entry routes correctly.
      gamesRouteRef.current = getLanOverride();
      // Server returns ended as 0/1 int; LaunchedGame interface expects boolean.
      const normalized = rows.map((g) => ({
        id: g.id,
        game_uniqid: g.game_uniqid,
        name: g.name,
        number_of_teams: g.number_of_teams ?? 0,
        game_type: g.game_type,
        ended: Boolean(g.ended),
        created_at: g.created_at ?? '',
        is_test: Boolean(g.is_test),
        is_simulated: Boolean(g.is_simulated),
        summary_uuid: g.summary_uuid,
        customer_id: g.customer_id ?? null,
        customer_name: g.customer_name ?? null,
      }));
      // Keep the same array when nothing changed (the grid re-polls this list).
      setGames((prev) => (JSON.stringify(prev) === JSON.stringify(normalized) ? prev : normalized));

      // Child view detection: the rows above came from a MOTHER (the override
      // points at a remote server, not our own 127.0.0.1). When so, also load
      // this device's OWN local games for the read-only "This device" section.
      const route = gamesRouteRef.current;
      const childView = !!route && !route.baseUrl.includes('127.0.0.1');
      setIsChildView(childView);
      if (childView) {
        try {
          // A game the mother lists too is the same game (same summary_uuid):
          // showing our copy next to it produced a second entry, and after a
          // failover the two could even disagree (running here, ended there).
          // Reconciliation brings the copies together; the list shows one.
          const onMother = new Set(rows.map((g) => g.summary_uuid).filter(Boolean));
          const clientId = user?.client_id;
          const localRows = (clientId == null ? [] : await listOwnLocalGames(clientId)).filter(
            (g) => !g.summary_uuid || !onMother.has(g.summary_uuid),
          );
          setLocalGames(
            localRows.map((g) => ({
              id: g.id,
              game_uniqid: g.game_uniqid,
              name: g.name,
              number_of_teams: g.number_of_teams ?? 0,
              game_type: g.game_type,
              ended: Boolean(g.ended),
              created_at: g.created_at ?? '',
              is_test: Boolean(g.is_test),
              is_simulated: Boolean(g.is_simulated),
            })),
          );
        } catch (err) {
          console.error('[LaunchedGamesList] local games load failed:', err);
          setLocalGames([]);
        }
      } else {
        setLocalGames([]);
      }
    } catch (err) {
      console.error('Error loading launched games:', err);
    } finally {
      clearTimeout(slowTimer);
      setSlowLoad(false);
      setLoading(false);
      setLoadedOnce(true);
    }
  };

  const loadGameData = async () => {
    // Slice 3: game-data.json now comes from slice-2's local FS for any
    // scenario the user has downloaded. For game_uniqids we never downloaded
    // (e.g., a scenario referenced by a historical launched_game that was
    // since removed), fall back to the row title from scenarioStore - there's
    // no longer a remote scenarios endpoint to query.
    try {
      const uniqueUniqids = [...new Set(games.map((g) => g.game_uniqid))];
      const dataMap: Record<string, GameData> = {};
      for (const uniqid of uniqueUniqids) {
        try {
          const gd = (await scenarioStore.getGameData(uniqid)) as any;
          const title = gd?.game?.title ?? gd?.scenario?.title ?? gd?.title ?? null;
          const type = gd?.game?.type ?? gd?.scenario?.game_type ?? gd?.game_type ?? '';
          if (title) {
            dataMap[uniqid] = { game: { uniqid, title, type } };
            continue;
          }
          const row = await scenarioStore.get(uniqid);
          if (row) {
            dataMap[uniqid] = { game: { uniqid, title: row.title, type: row.game_type } };
          }
        } catch (err) {
          console.warn(`[LaunchedGamesList] game-data lookup failed for ${uniqid}:`, err);
        }
      }
      setGameDataMap(dataMap);
    } catch (error) {
      console.error('Error loading game data:', error);
    }
  };

  const handleEndGame = async (gameId: number) => {
    if (await blockedByLock(() => void handleEndGame(gameId))) return;
    const joined = await countJoinedDevices(gameId);
    setConfirmDialog({
      isOpen: true,
      title: t('launched:endGameTitle'),
      message: withDeviceWarning(t('launched:endGameMessage'), joined),
      variant: 'warning',
      confirmText: t('launched:endGameConfirm'),
      onConfirm: () => {
        // Close the dialog and flip the optimistic ended flag synchronously
        // so the badge + button set update immediately. end_game on the
        // server only sets ended=1 (teams untouched), so no team refetch.
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        const snapshot = games;
        setGames((prev) => prev.map((g) => (g.id === gameId ? { ...g, ended: true } : g)));

        (async () => {
          try {
            await endLaunchedGame(gameId);
          } catch (err) {
            // 404 → row gone (deleted elsewhere); treat as success since the
            // user's "no longer active" intent still holds.
            if (err instanceof ApiError && err.status === 404) {
              return;
            }
            console.error('Error ending game:', err);
            setGames(snapshot);
            alert(t('launched:endGameFailed'));
          }
        })();
      },
    });
  };

  const handleDeleteGame = async (gameId: number) => {
    if (await blockedByLock(() => void handleDeleteGame(gameId))) return;
    const joined = await countJoinedDevices(gameId);
    setConfirmDialog({
      isOpen: true,
      title: t('launched:deleteGameTitle'),
      message: withDeviceWarning(t('launched:deleteGameMessage'), joined),
      variant: 'danger',
      confirmText: t('launched:deleteGameConfirm'),
      onConfirm: () => {
        // Close the dialog and update local state synchronously so the UI
        // doesn't sit on a spinner during the cascade DELETE + any retries.
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        const snapshot = games;
        setGames((prev) => prev.filter((g) => g.id !== gameId));
        if (selectedGameId === gameId) {
          setSelectedGameId(null);
        }

        // Fire and forget. Server-side FK ON DELETE CASCADE handles meta +
        // devices + teams + raw_data. If withRetry's first attempt succeeded
        // but the response was slow/5xx, the second attempt sees a 404 (row
        // already gone) - that's the desired end state, not an error.
        (async () => {
          try {
            await deleteLaunchedGame(gameId);
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              return;
            }
            console.error('Error deleting game:', err);
            setGames(snapshot);
            alert(t('launched:deleteGameFailed'));
          }
        })();
      },
    });
  };

  const handleArchiveGame = async (gameId: number) => {
    if (await blockedByLock(() => void handleArchiveGame(gameId))) return;
    const joined = await countJoinedDevices(gameId);
    setConfirmDialog({
      isOpen: true,
      title: t('launched:archiveGameTitle'),
      message: withDeviceWarning(t('launched:archiveGameMessage'), joined),
      variant: 'warning',
      confirmText: t('launched:archiveGameConfirm'),
      onConfirm: () => {
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        const snapshot = games;
        setGames((prev) => prev.filter((g) => g.id !== gameId));
        if (selectedGameId === gameId) {
          setSelectedGameId(null);
        }
        (async () => {
          try {
            await archiveLaunchedGame(gameId);
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              return;
            }
            console.error('Error archiving game:', err);
            setGames(snapshot);
            alert(t('launched:archiveGameFailed'));
          }
        })();
      },
    });
  };

  const openArchived = async () => {
    setShowArchived(true);
    setArchivedLoading(true);
    try {
      setArchivedSummaries(await listArchivedSummaries());
    } catch (err) {
      console.error('[LaunchedGamesList] failed to load archived summaries:', err);
      setArchivedSummaries([]);
    } finally {
      setArchivedLoading(false);
    }
  };

  // Archive every ended, non-test game in one pass. Active games (not ended) are
  // intentionally excluded so a running game is never collapsed to a summary.
  const handleArchiveAllEnded = () => {
    const eligible = games.filter((g) => g.ended && !g.is_test);
    if (eligible.length === 0) return;
    setConfirmDialog({
      isOpen: true,
      title: t('launched:archiveAllTitle'),
      message: t('launched:archiveAllMessage', { count: eligible.length }),
      variant: 'warning',
      confirmText: t('launched:archiveAllConfirm'),
      onConfirm: () => {
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        void (async () => {
          setArchivedLoading(true);
          let failed = 0;
          for (const g of eligible) {
            try {
              await archiveLaunchedGame(g.id);
            } catch (err) {
              if (err instanceof ApiError && err.status === 404) continue;
              console.error('Error archiving game:', g.id, err);
              failed += 1;
            }
          }
          if (selectedGameId != null && eligible.some((g) => g.id === selectedGameId)) {
            setSelectedGameId(null);
          }
          await loadGames();
          try {
            setArchivedSummaries(await listArchivedSummaries());
          } catch (err) {
            console.error('[LaunchedGamesList] failed to reload archived summaries:', err);
          } finally {
            setArchivedLoading(false);
          }
          if (failed > 0) alert(t('launched:archiveAllFailed', { count: failed }));
        })();
      },
    });
  };

  const formatDate = (dateString: string) => formatDbDateTime(dateString);

  // Trophy button: open the ranking options modal for a game (3 actions).
  const handleOpenRankingOptions = async (game: LaunchedGame) => {
    // Same routing fix as handlePlayGame: on a satellite the rows on screen
    // belong to the mother, but routing may have drifted back to LOCAL (e.g.
    // after leaving a game). Re-point at the server these rows came from first,
    // or the meta read below 404s and this button silently no-ops.
    if (gamesRouteRef.current) setLanOverride(gamesRouteRef.current);
    let metaMap: Record<string, string> = {};
    try {
      metaMap = await getLaunchedGameMeta(game.id);
    } catch (err) {
      console.error('Error loading rankings config:', err);
      alert(t('launched:actionFailed'));
      return;
    }
    const config = gameConfigFromMeta(metaMap, { name: game.name, numberOfTeams: game.number_of_teams });
    const scenarioTitle = gameDataMap[game.game_uniqid]?.game?.title ?? game.name;
    setRankingOptions({
      launchedGameId: game.id,
      gameName: game.name,
      config,
      scenarioUniqid: game.game_uniqid,
      scenarioTitle,
    });
  };

  // Perform the action chosen in RankingOptionsModal against the resolved target.
  const handleRankingAction = (action: RankingAction, target: RankingTarget) => {
    if (action === 'device') {
      // Hand off to the device picker (keeps the resolved target).
      setRankingOptions(null);
      setRankingDeviceTarget(target);
      return;
    }
    if (action === 'second_screen') {
      void openProjector(target).catch((err) =>
        console.error('[LaunchedGamesList] projector open failed:', err)
      );
      setRankingOptions(null);
      return;
    }
    // 'show' - full page in this window.
    if (target.mode === 'game') {
      setRankingPageGame({ launchedGameId: target.launchedGameId, gameName: target.gameName, config: target.config, autoScroll: target.autoScroll !== false });
    } else {
      setTimeRangePage({ scenario: { uniqid: target.scenarioUniqid, title: target.scenarioTitle }, timeRange: target.timeRange });
    }
    setRankingOptions(null);
  };

  const handleShowDevices = (gameId: number) => {
    // The shared <GameDevicesModal> handles its own fetch + 2s polling. We
    // just open it pointed at the right launched_game.
    setShowDevices(gameId);
  };

  // Print the mission report for one team (single page) or every team in the
  // game (one page each, ranked). Layout + per-team stats come from
  // loadLaunchedGameReports; printReports renders to a hidden iframe → OS dialog.
  const runPrint = async (game: LaunchedGame, teamId: number | null, prefs: PrintPrefs) => {
    if (printing) return;
    setPrinting(true);
    try {
      const { layout, teams } = await loadLaunchedGameReports(game);
      const toPrint = teamId === null ? teams : teams.filter((d) => d.teamId === teamId);
      if (!toPrint.length) {
        alert(t('launched:printNoTeams'));
        return;
      }
      await printReports(layout, toPrint, prefs);
    } catch (err) {
      console.error('[LaunchedGamesList] print failed:', err);
      alert(t('launched:printFailed'));
    } finally {
      setPrinting(false);
    }
  };

  const handlePlayGame = async (game: LaunchedGame) => {
    // Align launched_games routing with the server these rows were loaded from.
    // Leaving a game restores LOCAL routing; a satellite re-entering a mother's
    // game must re-point at the mother first, or every read below 404s and the
    // button appears dead.
    if (gamesRouteRef.current) setLanOverride(gamesRouteRef.current);
    // The whole in-game config is derived from this meta map, so an empty read
    // is NOT "all options off" - getLaunchedGameMeta fails open to `{}` (unknown
    // id / route not yet pointed at the mother). Entering with an empty map made
    // a satellite miss e.g. tagquestSelfRegister and skip the registration
    // screen, so retry briefly before giving up.
    let metaMap: Record<string, string> = {};
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        metaMap = await getLaunchedGameMeta(game.id);
      } catch (err) {
        console.error('Error loading game meta:', err);
        alert(t('launched:actionFailed'));
        return;
      }
      if (Object.keys(metaMap).length > 0) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (Object.keys(metaMap).length === 0) {
      console.warn('[LaunchedGamesList] entering game with empty meta', game.id);
    }
    const config = gameConfigFromMeta(metaMap, { name: game.name, numberOfTeams: game.number_of_teams });

    setPlayingGame({ config, uniqid: game.game_uniqid, launchedGameId: game.id });
  };

  // Drive into a launched game by id alone - used by the mother → satellite
  // join_game push. Looks the game up in the cached list (refetching if not
  // present), registers the satellite with the mother, then mounts GamePage.
  const playGameById = async (launchedGameId: number, route?: PendingJoinRoute) => {
    // Re-apply the route carried by the push BEFORE anything is read. This
    // component's own mount-time refreshLaunchedGamesRoute() races the push and
    // can restore the LOCAL route; reading the game from our own server then
    // yields either nothing or - worse - a colliding local game id's config.
    if (route) pointLaunchedGamesAtMother(route.baseUrl, route.token);
    // The push navigates this device to the game - close any locally-opened
    // full-screen rankings surface or modal. While playingGame is set they
    // wouldn't render anyway, but left set they'd resurface the moment the
    // operator backs out of the game.
    setRankingPageGame(null);
    setTimeRangePage(null);
    setActiveGamesPage(null);
    setShowRankingsModal(false);
    setShowArchived(false);
    let game = games.find(g => g.id === launchedGameId);
    if (!game) {
      // The active list may be stale (e.g. mother created the game seconds ago).
      try {
        const fresh = await listLaunchedGames({ ended: false });
        // Remember the route these rows came from (typically the mother, since
        // this refresh runs right after the join_game push repointed us there).
        gamesRouteRef.current = getLanOverride();
        // Normalize to the local LaunchedGame shape (boolean ended, defaulted
        // number_of_teams) - same as the initial loadGames() path.
        const normalized: LaunchedGame[] = fresh.map((g) => ({
          id: g.id,
          game_uniqid: g.game_uniqid,
          name: g.name,
          number_of_teams: g.number_of_teams ?? 0,
          game_type: g.game_type,
          ended: Boolean(g.ended),
          created_at: g.created_at ?? '',
          is_test: Boolean(g.is_test),
          is_simulated: Boolean(g.is_simulated),
        }));
        setGames(normalized);
        game = normalized.find(g => g.id === launchedGameId);
      } catch (err) {
        console.error('[LaunchedGamesList] playGameById refresh failed:', err);
        return;
      }
    }
    if (!game) {
      console.warn('[LaunchedGamesList] playGameById: launched_game not found', launchedGameId);
      return;
    }
    // The join_game push (App-level) has already repointed launched_games at the
    // mother for this game. That route is authoritative here - capture it so the
    // handlePlayGame re-apply below doesn't clobber it with a stale (e.g. local)
    // value left over from a prior load. Without this, reconnecting a device
    // that's already in the game reads meta from the wrong server and no-ops.
    gamesRouteRef.current = getLanOverride();
    // Register the satellite as a participating device BEFORE entering
    // GamePage, so the mother's modal sees the row migrate B → A on its
    // next 2s poll without waiting for the satellite to take any action.
    try {
      await registerDeviceForGame(launchedGameId);
    } catch (err) {
      console.warn('[LaunchedGamesList] registerDeviceForGame failed:', err);
    }
    await handlePlayGame(game);
  };

  useEffect(() => {
    return onPendingJoin((launchedGameId, route) => {
      void playGameById(launchedGameId, route);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games]);

  // Mother-issued "Disconnect": leave the in-game page (if mounted) and return
  // to the launched-games list. refreshLaunchedGamesRoute mirrors the normal
  // Back path so the list re-reads from the right server after dropping out.
  useEffect(() => {
    return onPendingLeave(() => {
      void refreshLaunchedGamesRoute();
      setPlayingGame(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (playingGame) {
    return (
      <GamePage
        // Key on the game id: a join_game push can land while a GamePage for a
        // PREVIOUS (ended) game is still mounted - e.g. the device was left on
        // that game's leaderboard. Without the key React reuses the mounted
        // instance (mount-time init never reruns, stale overlays stay up); with
        // it the page remounts fresh on the game view. A same-game re-push
        // keeps the key, so the Reconnect/rejoin channel is unaffected.
        key={playingGame.launchedGameId}
        config={playingGame.config}
        gameUniqid={playingGame.uniqid}
        launchedGameId={playingGame.launchedGameId}
        onBack={() => { void refreshLaunchedGamesRoute(); setPlayingGame(null); }}
      />
    );
  }

  if (loading && !loadedOnce) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        {slowLoad ? (
          <div className="max-w-md text-center space-y-3">
            <div className="text-[var(--pg-text)] text-xl font-semibold">{t('launched:slowLoadTitle')}</div>
            <p className="text-sm text-[var(--pg-text-dim)]">{t('launched:slowLoadHint')}</p>
            <button className="pg-btn pg-btn--primary" onClick={() => void loadGames()}>
              {t('launched:slowLoadRetry')}
            </button>
          </div>
        ) : (
          <div className="text-[var(--pg-text)] text-xl">{t('launched:loading')}</div>
        )}
      </div>
    );
  }


  // Child view: default to the mother's ACTIVE games; ended ones hide behind
  // "Load more". Mother/standalone keeps the existing single list (all games).
  const visibleGames = isChildView
    ? showEndedMother
      ? games
      : games.filter((g) => !g.ended)
    : games;
  const motherEndedCount = isChildView ? games.filter((g) => g.ended).length : 0;
  const activeCount = games.filter((g) => !g.ended).length;
  // Grid games in list order (expandedIds only says WHICH games are shown).
  const expandedGames = expandedIds === null ? [] : games.filter((g) => expandedIds.includes(g.id));

  // One launched-game card (header, badges, action buttons). Shared by the
  // normal list and the "Expand current" grid, where a background click is
  // inert (every game is already shown in full).
  const renderGameCard = (game: LaunchedGame, inGrid: boolean) => {
    const typeSlug = game.game_type || gameDataMap[game.game_uniqid]?.game?.type || '';
    const typeBadge = gameTypeBadge(typeSlug);
    return (
      <div
        key={game.id}
        className={`rounded-lg border-2 transition ${
          inGrid
            ? 'p-4 bg-[var(--pg-surface)] border-[var(--pg-line)]'
            : selectedGameId === game.id
              ? 'p-6 cursor-pointer bg-[var(--pg-accent-tint)] border-[var(--pg-accent)]'
              : 'p-6 cursor-pointer bg-[var(--pg-surface)] border-[var(--pg-line)] hover:border-[var(--pg-line-strong)]'
        } ${!game.ended ? 'ring-2 ring-green-500/50' : ''}`}
        onClick={inGrid ? undefined : () => setSelectedGameId(game.id)}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-xl font-bold text-[var(--pg-text)] mb-1">{game.name}</h3>
            {gameDataMap[game.game_uniqid] ? (
              <p className="text-sm text-[var(--pg-accent-bright)] mb-1">{t('launched:scenarioLabel', { scenario: gameDataMap[game.game_uniqid].game.title })}</p>
            ) : (
              <p className="text-sm text-[var(--pg-text-dim)] mb-1">{t('launched:scenarioLabel', { scenario: game.game_uniqid })}</p>
            )}
            <p className="text-sm text-[var(--pg-text-dim)]">{t('launched:gameIdLabel', { id: game.id })}</p>
            {customersSupported && !game.is_simulated && game.summary_uuid && (
              <CustomerChip
                name={game.customer_name ?? null}
                onClick={() => setAssignTarget({
                  gameId: game.id,
                  summaryUuid: game.summary_uuid,
                  name: game.name,
                  current: game.customer_id ? { id: game.customer_id, name: game.customer_name ?? '' } : null,
                })}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-3 py-1 rounded-full text-xs font-semibold border flex items-center gap-1.5 ${typeBadge.className}`}
              title={t('launched:gameTypeTitle')}
            >
              <GameTypeIcon type={typeSlug} size={13} />
              {typeBadge.label}
            </span>
            {game.ended ? (
              <span className="px-3 py-1 bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)] rounded-full text-xs font-semibold flex items-center gap-1">
                <StopCircle size={12} />
                {t('launched:statusEnded')}
              </span>
            ) : (
              <span className="px-3 py-1 bg-green-600 text-white rounded-full text-xs font-semibold flex items-center gap-1">
                <Play size={12} />
                {t('launched:statusActive')}
              </span>
            )}
          </div>
        </div>

        <div className="text-sm text-[var(--pg-text-dim)] mb-4">
          {t('launched:createdLabel', { date: formatDate(game.created_at) })}
        </div>

        {/* Action buttons on a single line, split into two clusters:
            Left: Play (when active), Rankings, Devices, Videos, Print
            Right: Config, Test, Raw data, Stop/Archive (+ clash add-time, delete) */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          {/* Left cluster */}
          <div className="flex items-center gap-2">
            {!game.ended && !operatorOnly && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // playGameById registers this device into the game
                  // (self-join) before mounting GamePage, so a child can
                  // join a mother-hosted game it hasn't joined yet. For
                  // the mother's own game the register is a harmless
                  // upsert.
                  void (async () => {
                    if (await blockedByLock(() => void playGameById(game.id))) return;
                    await playGameById(game.id);
                  })();
                }}
                className="p-2 bg-green-600 hover:bg-green-500 text-white rounded-lg transition"
                title={t('launched:playGame')}
              >
                <Gamepad2 size={18} />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                void handleOpenRankingOptions(game);
              }}
              className="p-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition"
              title={t('launched:rankings')}
            >
              <Trophy size={18} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleShowDevices(game.id);
              }}
              className="p-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition"
              title={t('launched:devices')}
            >
              <Monitor size={18} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowVideo(game.id);
              }}
              className="p-2 bg-pink-600 hover:bg-pink-500 text-white rounded-lg transition"
              title={t('launched:video')}
            >
              <Video size={18} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPrintTarget({ game, teamId: null, subject: game.name });
              }}
              disabled={printing}
              className="p-2 bg-[var(--pg-surface-3)] hover:bg-[var(--pg-surface-2)] text-[var(--pg-text)] rounded-lg transition disabled:opacity-50"
              title={t('launched:printAll')}
            >
              <Printer size={18} />
            </button>
          </div>

          {/* Right cluster */}
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfigGameId(game.id);
                setConfigGameName(game.name);
                setConfigGameType(game.game_type || gameDataMap[game.game_uniqid]?.game?.type || '');
                setConfigGameUniqid(game.game_uniqid);
              }}
              className="p-2 bg-[var(--pg-accent)] hover:bg-[var(--pg-accent-hover)] text-white rounded-lg transition"
              title={t('launched:configure')}
            >
              <Settings size={18} />
            </button>
            {IS_TESTER_BUILD && game.is_simulated && !game.ended && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setSimGameId(game.id);
                }}
                className="p-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-lg transition"
                title="Simulate…"
              >
                <Dices size={18} />
              </button>
            )}
            {isAdminMode && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setTestGameId(game.id);
                  setTestGameName(game.name);
                }}
                className="p-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition"
                title={t('launched:runGameTest')}
              >
                <FlaskConical size={18} />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowRawData({ id: game.id, name: game.name });
              }}
              className="p-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition"
              title={t('launched:rawData')}
            >
              <Database size={18} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                // Snapshot reads must hit the server these rows came
                // from (the mother, on a child) - same re-point as Play.
                if (gamesRouteRef.current) setLanOverride(gamesRouteRef.current);
                setBugReportGame(game);
              }}
              className="p-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg transition"
              title={t('bugReport:buttonTitle')}
            >
              <Bug size={18} />
            </button>
            {!game.ended && (game.game_type || '').toLowerCase() === 'clash' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setAddTimeGame({ id: game.id, name: game.name });
                }}
                className="p-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition"
                title="Add time"
              >
                <Clock size={18} />
              </button>
            )}
            {!game.ended ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleEndGame(game.id);
                }}
                className="p-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg transition"
                title={t('launched:endGameTitle')}
              >
                <StopCircle size={18} />
              </button>
            ) : !game.is_test ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleArchiveGame(game.id);
                }}
                className="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition"
                title={t('launched:archiveTitle')}
              >
                <Archive size={18} />
              </button>
            ) : null}
            {(game.is_test || isAdminMode) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteGame(game.id);
                }}
                className="p-2 bg-red-600 hover:bg-red-500 text-white rounded-lg transition"
                title={game.is_test ? t('launched:deleteTestGame') : t('launched:deleteAdmin')}
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // A game's teams panel, wired to the page-level modals. Keyed by game so
  // another game always gets a fresh panel (no stale roster / open forms).
  const renderTeamsPanel = (game: LaunchedGame, variant: 'side' | 'grid') => (
    <LaunchedGameTeamsPanel
      key={`${game.id}:${game.game_uniqid}`}
      game={game}
      scenarioType={(gameDataMap[game.game_uniqid]?.game?.type || '').toLowerCase()}
      allChips={allChips}
      isAdminMode={isAdminMode}
      printing={printing}
      variant={variant}
      autoRefresh={variant === 'grid'}
      setConfirmDialog={setConfirmDialog}
      blockedByLock={blockedByLock}
      onOpenTeamDetails={setTeamDetails}
      onOpenClashClan={setClashClan}
      onTestTeam={setTestTeam}
      onPrintTeam={(teamId, teamName) => setPrintTarget({ game, teamId, subject: `${game.name} - ${teamName}` })}
      onShowSummary={(teamId) => setSummaryDeviceTarget({ game, teamId })}
    />
  );

  const selectedGame = games.find((g) => g.id === selectedGameId) ?? null;

  return (
    // The grid drops the container cap so three team panels get the full width.
    <div className={expandedIds !== null ? 'px-6 py-8' : 'container mx-auto px-6 py-8'}>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-bold text-[var(--pg-text)]">{t('launched:heading')}</h2>
        <div className="flex items-center gap-2">
          {games.length > 0 && expandedIds === null && (
            <button
              onClick={() => setGamesMinimized((v) => !v)}
              className="pg-btn"
              title={gamesMinimized ? t('launched:expandGames') : t('launched:minimizeGames')}
            >
              {gamesMinimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
              {gamesMinimized ? t('launched:expandGames') : t('launched:minimizeGames')}
            </button>
          )}
          {expandedIds !== null ? (
            <button onClick={closeExpandCurrent} className="pg-btn" title={t('launched:backToList')}>
              <List size={16} />
              {t('launched:backToList')}
            </button>
          ) : activeCount > 0 && (
            <button onClick={openExpandCurrent} className="pg-btn" title={t('launched:expandCurrentTitle')}>
              <LayoutGrid size={16} />
              {t('launched:expandCurrent')}
            </button>
          )}
          <button
            onClick={() => setShowRankingsModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-yellow-500/15 hover:bg-yellow-500/25 border border-yellow-500/30 hover:border-yellow-400/50 text-yellow-400 font-semibold text-sm rounded-xl transition-all"
          >
            <Trophy size={16} />
            {t('launched:rankings')}
          </button>
          <button
            onClick={() => void openArchived()}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 hover:border-indigo-400/50 text-indigo-300 font-semibold text-sm rounded-xl transition-all"
          >
            <Archive size={16} />
            {t('launched:archived')}
          </button>
        </div>
      </div>

      {isChildView && motherUnreachable && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 text-sm font-semibold">
          {t('launched:motherOffline')}
        </div>
      )}

      {expandedIds !== null ? (
        // "Expand current": one column per game (card on top, its teams below):
        // 2 games → 2 columns, 3+ → rows of 3. Capped to 2 columns under 1280px
        // and stacked under 1024px.
        <div
          className={`grid grid-cols-1 gap-6 items-start ${
            expandedGames.length >= 3 ? 'lg:grid-cols-2 xl:grid-cols-3' : 'lg:grid-cols-2'
          }`}
        >
          {expandedGames.map((game) => (
            <div key={game.id} className="flex flex-col gap-4 min-w-0">
              {renderGameCard(game, true)}
              {renderTeamsPanel(game, 'grid')}
            </div>
          ))}
        </div>
      ) : games.length === 0 && localGames.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-[var(--pg-text-dim)] text-lg">{t('launched:noGamesYet')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            {isChildView && (
              <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--pg-text-dim)]">
                {t('launched:gamesOnMother')}
              </h3>
            )}
            {visibleGames.map((game) => {
              const typeSlug = game.game_type || gameDataMap[game.game_uniqid]?.game?.type || '';
              const typeBadge = gameTypeBadge(typeSlug);
              // Compact list row: shown when the list is minimized and this game
              // isn't the selected one (the selected game keeps its full card).
              if (gamesMinimized && selectedGameId !== game.id) {
                return (
                  <div
                    key={game.id}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border transition cursor-pointer ${
                      'bg-[var(--pg-surface)] border-[var(--pg-line)] hover:border-[var(--pg-line-strong)]'
                    } ${!game.ended ? 'ring-1 ring-green-500/40' : ''}`}
                    onClick={() => setSelectedGameId(game.id)}
                  >
                    <span
                      className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold border flex items-center gap-1 ${typeBadge.className}`}
                      title={t('launched:gameTypeTitle')}
                    >
                      <GameTypeIcon type={typeSlug} size={12} />
                      {typeBadge.label}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[var(--pg-text)] font-semibold text-sm">{game.name}</span>
                    {game.ended ? (
                      <StopCircle size={14} className="shrink-0 text-[var(--pg-text-dim)]" />
                    ) : (
                      <Play size={14} className="shrink-0 text-green-400" />
                    )}
                  </div>
                );
              }
              return renderGameCard(game, false);
            })}

            {/* Child view: reveal the mother's ended games on demand. */}
            {isChildView && !showEndedMother && motherEndedCount > 0 && (
              <button
                onClick={() => setShowEndedMother(true)}
                className="pg-btn w-full justify-center"
              >
                {t('launched:loadMoreEnded', { count: motherEndedCount })}
              </button>
            )}

            {/* Child view: this device's OWN local games - read-only history,
                kept separate from the mother's games. */}
            {isChildView && localGames.length > 0 && (
              <div className="pt-4 mt-2 border-t border-[var(--pg-line)]">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--pg-text-dim)] mb-2">
                  {t('launched:thisDeviceSection')}
                </h3>
                <div className="space-y-2">
                  {localGames.map((g) => {
                    const slug = g.game_type || gameDataMap[g.game_uniqid]?.game?.type || '';
                    const badge = gameTypeBadge(slug);
                    return (
                      <div
                        key={g.id}
                        className="flex items-center gap-3 px-4 py-2 rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface)] opacity-80"
                      >
                        <span
                          className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold border flex items-center gap-1 ${badge.className}`}
                        >
                          <GameTypeIcon type={slug} size={12} />
                          {badge.label}
                        </span>
                        <span className="flex-1 min-w-0 truncate text-[var(--pg-text)] text-sm">{g.name}</span>
                        {g.ended ? (
                          <StopCircle size={14} className="shrink-0 text-[var(--pg-text-dim)]" />
                        ) : (
                          <Play size={14} className="shrink-0 text-green-400" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div>
            {selectedGame !== null ? (
              <div className="sticky top-24">
                {renderTeamsPanel(selectedGame, 'side')}
              </div>
            ) : (
              <div className="sticky top-24">
                <div className="bg-[var(--pg-surface)] border-2 border-[var(--pg-line)] rounded-lg p-6 text-center">
                  <p className="text-[var(--pg-text-dim)]">{t('launched:selectGamePrompt')}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showDevices !== null && (
        <GameDevicesModal
          launchedGameId={showDevices}
          gameLanguage="fr"
          isMother={true}
          showVideoControls={false}
          onClose={() => setShowDevices(null)}
        />
      )}

      {showVideo !== null && (
        <GameVideoModal
          launchedGameId={showVideo}
          gameLanguage="fr"
          onClose={() => setShowVideo(null)}
        />
      )}

      {showRawData !== null && (
        <RawDataModal
          launchedGameId={showRawData.id}
          gameName={showRawData.name}
          onClose={() => setShowRawData(null)}
        />
      )}

      {bugReportGame !== null && (
        <BugReportModal
          game={bugReportGame}
          isChildView={isChildView}
          onClose={() => setBugReportGame(null)}
        />
      )}

      {rankingOptions && (
        <RankingOptionsModal
          launchedGameId={rankingOptions.launchedGameId}
          gameName={rankingOptions.gameName}
          config={rankingOptions.config}
          scenarioUniqid={rankingOptions.scenarioUniqid}
          scenarioTitle={rankingOptions.scenarioTitle}
          onClose={() => setRankingOptions(null)}
          onAction={handleRankingAction}
        />
      )}

      {rankingDeviceTarget && (
        <RankingDevicePicker
          target={rankingDeviceTarget}
          onClose={() => setRankingDeviceTarget(null)}
          onSent={() => setRankingDeviceTarget(null)}
        />
      )}

      {printTarget && (
        <PrePrintModal
          subject={printTarget.subject}
          onCancel={() => setPrintTarget(null)}
          onConfirm={(prefs) => {
            const target = printTarget;
            setPrintTarget(null);
            void runPrint(target.game, target.teamId, prefs);
          }}
        />
      )}

      {summaryDeviceTarget && (
        <DevicePicker
          title={t('launched:summaryDevicePickTitle')}
          hint={t('launched:summaryDevicePickHint')}
          sendLabel={t('launched:summaryDeviceSend')}
          emptyLabel={t('launched:rankDeviceNone')}
          onSend={async (ids) => {
            const { game, teamId } = summaryDeviceTarget;
            const snapshot = await buildTeamSummarySnapshot(game, teamId);
            if (!snapshot) return;
            await queueShowTeamSummaryBulk(ids, encodeTeamSummarySnapshot(snapshot));
          }}
          onClose={() => setSummaryDeviceTarget(null)}
          onSent={() => setSummaryDeviceTarget(null)}
        />
      )}

      {assignTarget && (
        <AssignCustomerModal
          gameId={assignTarget.gameId}
          summaryUuid={assignTarget.summaryUuid}
          gameName={assignTarget.name}
          current={assignTarget.current}
          onClose={() => setAssignTarget(null)}
          onSaved={() => {
            void loadGames();
            if (showArchived) void listArchivedSummaries().then(setArchivedSummaries).catch(() => {});
          }}
        />
      )}

      {configGameId !== null && (
        <LaunchedGameConfigModal
          gameId={configGameId}
          gameName={configGameName}
          gameType={configGameType}
          gameUniqid={configGameUniqid}
          onClose={() => {
            setConfigGameId(null);
            setConfigGameName('');
            setConfigGameType('');
            setConfigGameUniqid('');
          }}
          onSave={() => {
            loadGames();
            // Propagate the edit to every device currently in this game so their
            // running game page re-derives config live (this list is on the
            // mother; the players are satellites).
            void broadcastConfigReload(configGameId);
          }}
        />
      )}

      {IS_TESTER_BUILD && simGameId !== null && (
        <Suspense fallback={null}>
          <SimulatorOverlay
            launchedGameId={simGameId}
            allowLocal={!isAndroid()}
            onClose={() => setSimGameId(null)}
            onPopOut={() => {
              const id = simGameId;
              setSimGameId(null);
              void import('../simulator/openSimulatorWindow').then((m) => m.openSimulatorWindow(id));
            }}
          />
        </Suspense>
      )}
      {testGameId !== null && (
        <GameTestModal
          gameId={testGameId}
          gameName={testGameName}
          onClose={() => {
            setTestGameId(null);
            setTestGameName('');
          }}
        />
      )}

      {testTeam !== null && (
        <TeamTestModal
          gameId={testTeam.gameId}
          gameName={testTeam.gameName}
          team={testTeam.team}
          onClose={() => {
            setTestTeam(null);
            testTeam.reload();
          }}
        />
      )}

      {teamDetails && (
        <TeamDetailsModal
          team={teamDetails.team}
          launchedGameId={teamDetails.launchedGameId}
          gameUniqid={teamDetails.gameUniqid}
          gameType={teamDetails.gameType}
          chipIds={teamDetails.chipIds}
          languages={teamDetails.languages}
          launchLanguage={teamDetails.launchLanguage}
          onTeamUpdated={teamDetails.reload}
          onClose={() => setTeamDetails(null)}
        />
      )}

      {clashClan && (
        <ClashClanDetailsModal
          clanTeam={clashClan.clan}
          launchedGameId={clashClan.launchedGameId}
          onClose={() => setClashClan(null)}
          onChanged={clashClan.reload}
        />
      )}

      {addTimeGame && (
        <AddTimeModal
          gameId={addTimeGame.id}
          gameName={addTimeGame.name}
          onClose={() => setAddTimeGame(null)}
          onAdded={() => loadGames()}
        />
      )}

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog({ ...confirmDialog, isOpen: false })}
        title={confirmDialog.title}
        message={confirmDialog.message}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        overlayZIndex={140}
      />

      {rankingPageGame && (
        <LeaderboardPage
          launchedGameId={rankingPageGame.launchedGameId}
          config={rankingPageGame.config}
          gameName={rankingPageGame.gameName}
          autoScroll={rankingPageGame.autoScroll}
          onBack={() => setRankingPageGame(null)}
        />
      )}

      {timeRangePage && (
        <TimeRangeLeaderboard
          scenario={timeRangePage.scenario}
          timeRange={timeRangePage.timeRange}
          onBack={() => setTimeRangePage(null)}
        />
      )}

      {activeGamesPage && activeGamesPage.length > 0 && (
        <MultiGameLeaderboard
          games={activeGamesPage}
          onBack={() => setActiveGamesPage(null)}
        />
      )}

      {showRankingsModal && (
        <RankingsModal
          onClose={() => setShowRankingsModal(false)}
          onOpenTimeRange={(scenario, timeRange) => {
            setShowRankingsModal(false);
            setTimeRangePage({ scenario, timeRange });
          }}
          onOpenActiveGames={(games) => {
            setShowRankingsModal(false);
            setActiveGamesPage(games);
          }}
        />
      )}

      {showArchived && (
        <div
          className="pg-overlay z-[130]"
          onClick={() => setShowArchived(false)}
        >
          <div
            className="pg-modal max-w-4xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pg-modal-head">
              <h3 className="pg-modal-title flex items-center gap-2">
                <Archive size={20} className="text-indigo-300" />
                {t('launched:archivedGames')}
              </h3>
              <div className="flex items-center gap-2">
                {(() => {
                  const eligibleCount = games.filter((g) => g.ended && !g.is_test).length;
                  return (
                    <button
                      onClick={handleArchiveAllEnded}
                      disabled={eligibleCount === 0}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 transition"
                      title={t('launched:archiveAllTitle')}
                    >
                      <Archive size={16} />
                      {t('launched:archiveAll', { count: eligibleCount })}
                    </button>
                  );
                })()}
                <button onClick={() => setShowArchived(false)} className="pg-modal-close">
                  <X size={20} />
                </button>
              </div>
            </div>
            <div className="pg-modal-body">
              {archivedLoading ? (
                <p className="text-[var(--pg-text-dim)] text-center py-8">{t('launched:loadingShort')}</p>
              ) : archivedSummaries.length === 0 ? (
                <p className="text-[var(--pg-text-dim)] text-center py-8">{t('launched:noArchivedGames')}</p>
              ) : (
                <table className="pg-table">
                  <thead>
                    <tr>
                      <th>{t('launched:colDate')}</th>
                      <th>{t('launched:colName')}</th>
                      <th>{t('launched:colType')}</th>
                      <th>{t('launched:colScenario')}</th>
                      <th className="!text-right">{t('launched:colTeams')}</th>
                      <th className="!text-right">{t('launched:colPlayers')}</th>
                      {customersSupported && <th>{t('customers:label')}</th>}
                      <th className="!text-center">{t('launched:colSynced')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {archivedSummaries.map((s) => (
                      <tr key={s.summary_uuid} className="text-[var(--pg-text-muted)]">
                        <td className="whitespace-nowrap">{s.played_at ? formatDate(s.played_at) : '-'}</td>
                        <td>{s.name || '-'}</td>
                        <td className="capitalize">{s.game_type}</td>
                        <td>{gameDataMap[s.scenario_uniqid ?? '']?.game?.title ?? s.scenario_uniqid ?? '-'}</td>
                        <td className="text-right">
                          {s.teams_played}
                          {s.teams_launched != null && s.teams_launched !== s.teams_played && (
                            <span className="text-[var(--pg-text-dim)]"> / {s.teams_launched}</span>
                          )}
                        </td>
                        <td className="text-right">{s.players_played}</td>
                        {customersSupported && (
                          <td>
                            <CustomerChip
                              name={s.customer_name ?? null}
                              onClick={() => setAssignTarget({
                                summaryUuid: s.summary_uuid,
                                name: s.name || s.summary_uuid,
                                current: s.customer_id ? { id: s.customer_id, name: s.customer_name ?? '' } : null,
                              })}
                            />
                          </td>
                        )}
                        <td className="text-center">
                          {s.pushed ? (
                            <CheckCircle size={16} className="inline text-green-400" />
                          ) : (
                            <Clock size={16} className="inline text-amber-400" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {lockGate && (
        <GameLockGate
          reason={lockGate.reason}
          onReprieve={() => {
            const run = lockGate.run;
            setLockGate(null);
            run();
          }}
          onClose={() => setLockGate(null)}
        />
      )}
    </div>
  );
}
