import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Trash2, Users, Save, Clock, CheckCircle, Flag, Trophy, Gamepad2, Search, ArrowUpDown, Import as SortAsc, Minimize2, Maximize2, Monitor, MonitorPlay, StopCircle, Settings, FlaskConical, UserPlus, PlusCircle, X, Eye, RefreshCw, Database, Archive, Dices, Printer, Video } from 'lucide-react';
import { GamePage } from './GamePage';
import { GameTypeIcon } from './icons/GameTypeIcons';
import { useAuth } from './auth/AuthProvider';
import * as cardsStore from '../services/cardsStore';
import * as cardsRepo from '../services/cardsRepo';
import * as scenarioStore from '../services/scenarioStore';
import * as namePoolsStore from '../services/namePoolsStore';
import { LANG_NAMES } from '../services/langFlags';
import {
  listLaunchedGames,
  getLaunchedGameMeta,
  updateLaunchedGameMeta,
  mergeLaunchedGameMeta,
  getLaunchedGameState,
  endLaunchedGame,
  deleteLaunchedGame,
  archiveLaunchedGame,
  listArchivedSummaries,
  type GameSummaryRow,
  updateTeam,
  addTeamToLaunchedGame,
  deleteTeam,
  listCompletedQuests,
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
import { TeamTestModal } from './TeamTestModal';
import { TeamDetailsModal } from './TeamDetailsModal';
import { ClashClanDetailsModal } from './ClashClanDetailsModal';
import { AddTimeModal } from './AddTimeModal';
import { PrePrintModal } from './PrePrintModal';
import type { PrintPrefs } from '../services/printPrefsStore';
import { getClashState, getClashMembers, type ClashStandings } from '../services/clash';
import {
  comboBonusPoints,
  effectifWeights,
  formatWeight,
  isWeightingEnabled,
  memberCounts,
  teamHeadcounts,
  weightedScore,
  type RosterTeam,
} from '../services/tagquestScoring';
import { LeaderboardPage } from './LeaderboardPage';
import { RankingsModal } from './RankingsModal';
import { RankingOptionsModal, type RankingAction } from './RankingOptionsModal';
import { RankingDevicePicker } from './RankingDevicePicker';
import { DevicePicker } from './DevicePicker';
import { buildTeamSummarySnapshot, gameTypeHasTeamSummary } from '../services/teamSummary';
import { encodeTeamSummarySnapshot } from '../services/teamSummaryTarget';
import { TimeRangeLeaderboard } from './TimeRangeLeaderboard';
import { MultiGameLeaderboard } from './MultiGameLeaderboard';
import { openProjector } from '../services/projectorWindow';
import type { RankingTarget } from '../services/rankingTarget';
import { HelpDot } from '../help';
import type { ScenarioOption, TimeRange, ActiveGameOption } from './RankingsModal';
import type { GameConfig, Team as ConfigTeam, Teammate } from './LaunchGameModal';
import { gameConfigFromMeta } from '../utils/gameConfigFromMeta';
import type { SiPuce } from '../types/database';

// Tracks route keys → operator-facing labels (Add Team per-team route override).
const TRACKS_ROUTE_LABELS: Record<string, string> = {
  default: 'All checkpoints',
  first_half: 'First half',
  last_half: 'Last half',
  odd: 'Odd checkpoints',
  even: 'Even checkpoints',
};

interface LaunchedGame {
  id: number;
  game_uniqid: string;
  name: string;
  number_of_teams: number;
  game_type: string;
  ended: boolean;
  created_at: string;
  is_test: boolean;
}

interface GameData {
  game: {
    uniqid: string;
    title: string;
    type: string;
  };
}

interface Team {
  id: number;
  team_number: number;
  team_name: string;
  score: number;
  start_time: number | null;
  end_time: number | null;
  key_id: number;
  language?: string | null;
  currentLevel?: { level: number; name: string } | null;
  /** TagQuest effectif weighting (when active): live chip count + applied weight. */
  headcount?: number | null;
  weight?: number | null;
}

// Game-type → display label + pill colors for the launched-game card badge.
// launched_games stores game_type capitalised ('TagQuest'); we key off the
// lowercase slug so either casing (and the scenario gameDataMap fallback) works.
const GAME_TYPE_BADGE: Record<string, { label: string; className: string }> = {
  tagquest: { label: 'TagQuest', className: 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300' },
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

// Fold a scenario's game_public onto the canonical name-pool audience trio
// (mirrors LaunchGameModal's normalizeGamePublic / studio src/types/audience.ts).
function normalizeAudience(raw: unknown): string {
  const v = String(raw ?? '').toLowerCase();
  if (['adults', 'adult', 'adultes', 'teens', 'ado'].includes(v)) return 'ado_adultes';
  if (v === 'mini_kids' || v === 'ado_adultes') return v;
  return 'kids';
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
  const [teams, setTeams] = useState<Team[]>([]);
  const [refreshingTeams, setRefreshingTeams] = useState(false);
  const [loading, setLoading] = useState(true);
  const [renamingTeamId, setRenamingTeamId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
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
  const [teamSearch, setTeamSearch] = useState('');
  const [teamSortBy, setTeamSortBy] = useState<'ranking' | 'name'>('ranking');
  const [minimizedTeams, setMinimizedTeams] = useState<Set<number>>(new Set());
  const [showDevices, setShowDevices] = useState<number | null>(null);
  const [showVideo, setShowVideo] = useState<number | null>(null);
  const [printing, setPrinting] = useState(false);
  // Pre-print modal (paper size + orientation) - printing goes through it.
  const [printTarget, setPrintTarget] = useState<{ game: LaunchedGame; teamId: number | null; subject: string } | null>(null);
  const [showRawData, setShowRawData] = useState<{ id: number; name: string } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant: 'danger' | 'warning' | 'info';
    confirmText?: string;
  }>({
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
  const [testGameName, setTestGameName] = useState<string>('');
  const [testTeam, setTestTeam] = useState<{ gameId: number; gameName: string; team: Team } | null>(null);
  const [selectedGamePlayMode, setSelectedGamePlayMode] = useState<'solo' | 'team' | null>(null);
  const [selectedGameTeamsConfig, setSelectedGameTeamsConfig] = useState<ConfigTeam[]>([]);
  const [allChips, setAllChips] = useState<SiPuce[]>([]);
  const [addTeammateState, setAddTeammateState] = useState<{ teamId: number; chipId: number | null; name: string } | null>(null);
  const [addTeamState, setAddTeamState] = useState<{ name: string; chipId: number | null; route?: string; language?: string } | null>(null);
  // Tracks: enabled route set + launch default route (from launch meta), so the
  // Add Team form can offer a per-team route override (manual assignment only).
  const [tracksRouteOptions, setTracksRouteOptions] = useState<string[]>([]);
  const [tracksDefaultRoute, setTracksDefaultRoute] = useState<string>('default');
  // Mystery/tracks "Départ groupé": the whole roster was stamped started at
  // launch, so a manually added team must start immediately too - otherwise
  // its return bip would START it instead of scoring it.
  const [selectedGameMassStart, setSelectedGameMassStart] = useState(false);
  // Name-pool draw context for the manual "Random name" button: the scenario's
  // audience + language (from launch meta) and the resolved candidate names.
  const [nameDrawAudience, setNameDrawAudience] = useState<string>('kids');
  const [nameDrawLang, setNameDrawLang] = useState<string>('en');
  const [namePoolNames, setNamePoolNames] = useState<string[]>([]);
  // The scenario's available languages (from launch meta) - drives the Add-Team
  // and team-details per-team language selects. Empty ⇒ no language picker shown.
  const [selectedGameLanguages, setSelectedGameLanguages] = useState<string[]>([]);
  const [savingTeammate, setSavingTeammate] = useState(false);
  const [savingTeam, setSavingTeam] = useState(false);
  const [teamDetails, setTeamDetails] = useState<{ team: Team; gameUniqid: string; gameType: string } | null>(null);
  // Clash: the clan-details modal target + per-clan member counts for the
  // currently-selected clash game (team_id → member_count).
  const [clashClan, setClashClan] = useState<{ id: number; team_number: number; team_name: string | null } | null>(null);
  const [clashCounts, setClashCounts] = useState<Map<number, number>>(new Map());
  // Clash: live standings (points + per-territory validation counts) and the
  // chips bound to each clan, polled alongside the counts so the team rows show
  // live scores/status and the clan members inline (team_id → chip_id[]).
  const [clashStandings, setClashStandings] = useState<ClashStandings | null>(null);
  const [clashMembers, setClashMembers] = useState<Map<number, number[]>>(new Map());
  // Operator "add time" modal target.
  const [addTimeGame, setAddTimeGame] = useState<{ id: number; name: string } | null>(null);
  const [showRankingsModal, setShowRankingsModal] = useState(false);
  const [timeRangePage, setTimeRangePage] = useState<{ scenario: ScenarioOption; timeRange: TimeRange } | null>(null);
  const [activeGamesPage, setActiveGamesPage] = useState<ActiveGameOption[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedSummaries, setArchivedSummaries] = useState<GameSummaryRow[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  // When true, the launched-game cards collapse to a compact list. The selected
  // game keeps its full card so the operator never loses sight of it.
  const [gamesMinimized, setGamesMinimized] = useState(true);
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

  useEffect(() => {
    if (selectedGameId !== null) {
      loadTeams(selectedGameId);
      setTeamSearch('');
      setMinimizedTeams(new Set());
      setSelectedGamePlayMode(null);
      setSelectedGameTeamsConfig([]);
      setNameDrawAudience('kids');
      setNameDrawLang('en');
      setTracksRouteOptions([]);
      setTracksDefaultRoute('default');
      setSelectedGameMassStart(false);
      getLaunchedGameMeta(selectedGameId)
        .then(async (map) => {
          if (map.playMode === 'solo' || map.playMode === 'team') {
            setSelectedGamePlayMode(map.playMode);
          }
          setSelectedGameMassStart(map.massStart === 'true');
          // Tracks per-team route options (persisted at launch).
          if (map.tracks_routes) {
            setTracksRouteOptions(map.tracks_routes.split(',').map((s) => s.trim()).filter(Boolean));
          }
          if (map.route) setTracksDefaultRoute(map.route);
          if (map.teamsConfig) {
            try { setSelectedGameTeamsConfig(JSON.parse(map.teamsConfig)); } catch { /* swallow */ }
          }
          // Name-pool draw context. namePoolAudience + language are persisted by
          // the launch modal; for older games predating that, fall back to the
          // scenario's game_meta.game_public (language falls back in the store).
          let audienceRaw: unknown = map.namePoolAudience;
          const lang = map.language;
          if (!audienceRaw) {
            const game = games.find((g) => g.id === selectedGameId);
            if (game) {
              try {
                const gd = (await scenarioStore.getGameData(game.game_uniqid)) as any;
                audienceRaw = (gd?.game_data?.game_meta ?? gd?.game_meta)?.game_public;
              } catch { /* swallow - defaults to 'kids' */ }
            }
          }
          setNameDrawAudience(normalizeAudience(audienceRaw));
          setNameDrawLang((lang || 'en').toLowerCase());
          setSelectedGameLanguages(map.availableLanguages ? map.availableLanguages.split(',') : []);
        })
        .catch((err) => console.error('[LaunchedGamesList] meta load failed:', err));
    }
  }, [selectedGameId]);

  // Clash + TagQuest self-register: poll per-team member counts/chips for the
  // selected game so the team rows show who joined. TagQuest self-register
  // binds chips via the same lg_clash_members rows as Clash (no teamsConfig
  // roster exists for those games); a predetermined TagQuest game simply has
  // no member rows, so the fetch is a harmless empty set.
  useEffect(() => {
    if (selectedGameId === null) {
      setClashCounts(new Map());
      setClashStandings(null);
      setClashMembers(new Map());
      return;
    }
    const game = games.find((g) => g.id === selectedGameId);
    const gameType = (game?.game_type || '').toLowerCase();
    const wantsClashState = gameType === 'clash';
    const wantsMembers = wantsClashState || gameType === 'tagquest';
    if (!game || !wantsMembers) {
      setClashCounts(new Map());
      setClashStandings(null);
      setClashMembers(new Map());
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const [st, members] = await Promise.all([
          // Standings only exist for Clash (territories/points); TagQuest just
          // needs the member bindings.
          wantsClashState ? getClashState(selectedGameId) : Promise.resolve(null),
          getClashMembers(selectedGameId),
        ]);
        if (cancelled) return;
        const byTeam = new Map<number, number[]>();
        for (const mem of members) {
          const arr = byTeam.get(mem.team_id);
          if (arr) arr.push(mem.chip_id);
          else byTeam.set(mem.team_id, [mem.chip_id]);
        }
        setClashMembers(byTeam);
        const m = new Map<number, number>();
        if (st) {
          for (const c of st.clans) m.set(c.team_id, c.member_count);
        } else {
          for (const [teamId, chips] of byTeam) m.set(teamId, chips.length);
        }
        setClashCounts(m);
        setClashStandings(st);
      } catch { /* ignore - next tick retries */ }
    };
    void tick();
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); };
  }, [selectedGameId, games]);

  // Resolve the candidate names for the current audience/language so the
  // "Random name" button can draw instantly (and stay disabled when empty).
  useEffect(() => {
    let cancelled = false;
    namePoolsStore
      .listPoolNames(nameDrawAudience, nameDrawLang)
      .then((names) => { if (!cancelled) setNamePoolNames(names); })
      .catch(() => { if (!cancelled) setNamePoolNames([]); });
    return () => { cancelled = true; };
  }, [nameDrawAudience, nameDrawLang]);

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
      }));
      setGames(normalized);

      // Child view detection: the rows above came from a MOTHER (the override
      // points at a remote server, not our own 127.0.0.1). When so, also load
      // this device's OWN local games for the read-only "This device" section.
      const route = gamesRouteRef.current;
      const childView = !!route && !route.baseUrl.includes('127.0.0.1');
      setIsChildView(childView);
      if (childView) {
        try {
          const localRows = await listLaunchedGames({ forceLocal: true, mine: true });
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
      setLoading(false);
    }
  };

  const loadTeams = async (gameId: number) => {
    let teamsData: Team[] = [];
    let questRows: { team_id: number; quest_number: string; points_awarded: number }[] = [];
    try {
      const state = await getLaunchedGameState(gameId, 0);
      teamsData = state.teams.map((t) => ({
        id: t.id,
        team_number: t.team_number,
        team_name: t.team_name ?? '',
        score: t.score,
        start_time: t.start_time,
        end_time: t.end_time,
        key_id: t.key_id ?? 0,
        language: t.language ?? null,
      }));
    } catch (err) {
      console.error('Error loading teams:', err);
      return;
    }
    try {
      const rows = await listCompletedQuests(gameId);
      questRows = rows.map((r) => ({
        team_id: r.team_id,
        quest_number: r.quest_number,
        points_awarded: r.points_awarded,
      }));
    } catch (err) {
      console.warn('[LaunchedGamesList] completed quests fetch failed:', err);
    }

    const scoreByTeam: Record<number, number> = {};
    const questCountByTeam: Record<number, Record<string, number>> = {};
    for (const row of questRows) {
      scoreByTeam[row.team_id] = (scoreByTeam[row.team_id] ?? 0) + (row.points_awarded ?? 0);
      if (!questCountByTeam[row.team_id]) questCountByTeam[row.team_id] = {};
      questCountByTeam[row.team_id][row.quest_number] = (questCountByTeam[row.team_id][row.quest_number] ?? 0) + 1;
    }

    const game = games.find(g => g.id === gameId);
    let pts6 = 0, pts4 = 0, pts2 = 0;
    let gameLevels: Record<string, { name: string | null; points: string | null }> | null = null;
    if (game?.game_uniqid) {
      try {
        // Slice 2: scenario game-data.json comes from the local SQLite/FS store.
        const gameDataJson = (await scenarioStore.getGameData(game.game_uniqid)) as any;
        const gameMeta = gameDataJson?.game_data?.game_meta ?? gameDataJson?.game_meta;
        const parseVal = (v: any) => (v === undefined || v === null) ? 0 : (typeof v === 'string' ? parseInt(v, 10) || 0 : v);
        pts6 = parseVal(gameMeta?.combo_6_quests);
        pts4 = parseVal(gameMeta?.combo_4_quests);
        pts2 = parseVal(gameMeta?.combo_2_quests);
        gameLevels = gameMeta?.levels ?? null;
      } catch { /* swallow - combos default to 0 */ }
    }

    const computeLevelForScore = (score: number): { level: number; name: string } | null => {
      if (!gameLevels) return null;
      let best: { level: number; name: string } | null = null;
      for (const [key, val] of Object.entries(gameLevels)) {
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

    // Only the quest system (TagQuest) derives its score from completed_quests.
    // Tracks / Mystery / Clash store the authoritative score on the team row
    // (set by the runtime + by TeamDetailsModal overrides) - recomputing from
    // quests would zero it out, so use the row score as-is for those types.
    const isTagQuest = (game?.game_type || '').toLowerCase() === 'tagquest';

    // Effectif weighting (launch option): mirror the punch logic's weighted
    // score so this list matches lg_teams.score. Headcounts come from the
    // self-register bindings (lg_clash_members) or the pre-built roster.
    let headcounts: Map<number, number> | null = null;
    let weights: Map<number, number> | null = null;
    if (isTagQuest) {
      try {
        const meta = await getLaunchedGameMeta(gameId);
        if (isWeightingEnabled(meta)) {
          let roster: RosterTeam[] = [];
          try { roster = JSON.parse(meta.teamsConfig || '[]'); } catch { /* swallow */ }
          const members = await getClashMembers(gameId).catch(() => []);
          headcounts = teamHeadcounts(teamsData, roster, memberCounts(members));
          weights = effectifWeights(headcounts);
        }
      } catch { /* weighting unavailable - fall back to raw scores */ }
    }

    const enriched = teamsData.map(t => {
      if (!isTagQuest) {
        return { ...t, currentLevel: computeLevelForScore(t.score) };
      }
      const questScore = scoreByTeam[t.id] ?? 0;
      const comboBonus = comboBonusPoints(questCountByTeam[t.id] ?? {}, pts6, pts4, pts2);
      const totalScore = weightedScore(questScore + comboBonus, weights?.get(t.id) ?? 1);
      return {
        ...t,
        score: totalScore,
        currentLevel: computeLevelForScore(totalScore),
        headcount: headcounts?.get(t.id) ?? null,
        weight: weights?.get(t.id) ?? null,
      };
    });

    setTeams(enriched);
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
          setTeams([]);
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
          setTeams([]);
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
            setTeams([]);
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

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  // Team start_time / end_time are stored as unix SECONDS (see TagQuestGamePage:
  // start is `Math.floor(startMs / 1000)`, end via endTimeToCommit). The Date
  // ctor expects milliseconds, so scale by 1000 here - otherwise every team's
  // start time renders as a 1970 timestamp.
  const formatTime = (timestamp: number | null) => {
    if (!timestamp) return t('launched:notStarted');
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString();
  };

  const handleRenameTeam = async (teamId: number) => {
    const name = renameValue.trim();
    if (!name) { setRenamingTeamId(null); return; }
    try {
      await updateTeam(teamId, { team_name: name });
      if (selectedGameId !== null) loadTeams(selectedGameId);
    } catch (err) {
      console.error('Error renaming team:', err);
    }
    setRenamingTeamId(null);
    setRenameValue('');
  };

  // All chips on a team (leader + teammates) from the launch config - the
  // Team Details punch tab needs them all, since in team mode members punch
  // with their own chip, not the leader's key_id.
  const chipIdsForTeam = (t: Team): number[] => {
    const cfg = selectedGameTeamsConfig.find(c => c.chipId === t.key_id || c.name === t.team_name);
    const ids = cfg ? [cfg.chipId, ...(cfg.teammates ?? []).map(m => m.chipId)] : [t.key_id];
    return [...new Set(ids.filter((x): x is number => x != null))];
  };

  const getUsedChipIds = (): Set<number> => {
    const used = new Set<number>();
    selectedGameTeamsConfig.forEach(t => {
      used.add(t.chipId);
      t.teammates?.forEach(m => used.add(m.chipId));
    });
    teams.forEach(t => used.add(t.key_id));
    return used;
  };

  // The first card not already assigned to a team/teammate - used to preselect
  // a chip (and seed the name from its key_name) when opening an add form.
  const firstFreeChip = (): SiPuce | undefined => {
    const used = getUsedChipIds();
    return allChips.find(c => !used.has(c.id));
  };

  // Names already in use across teams + teammates, so the random draw can avoid
  // handing out a duplicate.
  const usedNames = (): string[] => {
    const names = teams.map(t => t.team_name);
    selectedGameTeamsConfig.forEach(t => {
      names.push(t.name);
      t.teammates?.forEach(m => names.push(m.name));
    });
    return names.filter(Boolean);
  };

  // Draw a random pooled name, preferring one not already used. Returns null
  // when the pool has no names for the scenario's audience/language.
  const pickRandomName = (): string | null => {
    if (namePoolNames.length === 0) return null;
    const used = new Set(usedNames().map(n => n.trim().toLowerCase()));
    const free = namePoolNames.filter(n => !used.has(n.trim().toLowerCase()));
    const pool = free.length > 0 ? free : namePoolNames;
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  };

  // Open the add-team form with the first free chip preselected and its name
  // seeded from the card (per the launched-game team/player creation UX).
  const openAddTeam = () => {
    const chip = firstFreeChip();
    setAddTeamState({
      chipId: chip?.id ?? null,
      name: chip?.key_name ?? '',
      route: tracksDefaultRoute,
      // Default the per-team language to the launch language.
      language: nameDrawLang,
    });
  };

  const openAddTeammate = (teamId: number) => {
    const chip = firstFreeChip();
    setAddTeammateState({ teamId, chipId: chip?.id ?? null, name: chip?.key_name ?? '' });
  };

  const persistTeamsConfig = async (updated: ConfigTeam[]) => {
    if (!selectedGameId) return;
    setSelectedGameTeamsConfig(updated);
    try {
      // Read-modify-write: update_meta replaces the whole bag, so we need
      // the full current set, not just teamsConfig.
      const current = await getLaunchedGameMeta(selectedGameId);
      const next = { ...current, teamsConfig: JSON.stringify(updated) };
      await updateLaunchedGameMeta(selectedGameId, next);
      // Teammates live only in meta.teamsConfig (no DB row), so peers won't see
      // a roster change unless we push a reload - same broadcast every other
      // config-edit path performs. Covers add-team / add-teammate / remove.
      await broadcastConfigReload(selectedGameId);
    } catch (err) {
      console.error('[LaunchedGamesList] persistTeamsConfig failed:', err);
    }
  };

  const handleAddTeammate = async () => {
    if (!addTeammateState || addTeammateState.chipId === null || !addTeammateState.name.trim() || !selectedGameId) return;
    setSavingTeammate(true);
    const chip = allChips.find(c => c.id === addTeammateState.chipId);
    if (!chip) { setSavingTeammate(false); return; }

    const newMate: Teammate = {
      chipId: chip.id,
      chipNumber: chip.key_number,
      name: addTeammateState.name.trim(),
    };

    const updated = selectedGameTeamsConfig.map(t => {
      if (t.chipId === teams.find(tm => tm.id === addTeammateState.teamId)?.key_id || t.name === teams.find(tm => tm.id === addTeammateState.teamId)?.team_name) {
        return { ...t, teammates: [...(t.teammates ?? []), newMate] };
      }
      return t;
    });

    await persistTeamsConfig(updated);
    setAddTeammateState(null);
    setSavingTeammate(false);
  };

  const handleAddTeam = async () => {
    if (!addTeamState || addTeamState.chipId === null || !addTeamState.name.trim() || !selectedGameId) return;
    if (await blockedByLock(() => void handleAddTeam())) return;
    setSavingTeam(true);
    const chip = allChips.find(c => c.id === addTeamState.chipId);
    if (!chip) { setSavingTeam(false); return; }

    const nextTeamNumber = (teams.length > 0 ? Math.max(...teams.map(t => t.team_number)) : 0) + 1;

    const chosenRoute = addTeamState.route;
    try {
      const { id: newTeamId } = await addTeamToLaunchedGame({
        launched_game_id: selectedGameId,
        team_number: nextTeamNumber,
        team_name: addTeamState.name.trim(),
        pattern: 0,
        key_id: chip.id,
        language: addTeamState.language ?? nameDrawLang ?? null,
      });
      // Mass-start game: the roster started together at launch, so a late-added
      // team starts now - its first (return) bip must score it, not start it.
      if (selectedGameMassStart) {
        await updateTeam(newTeamId, { start_time: Math.floor(Date.now() / 1000) });
      }
      // Persist a per-team route override only when it differs from the launch
      // default (the runtime falls back to the default when no override exists).
      if (chosenRoute && chosenRoute !== tracksDefaultRoute && tracksRouteOptions.length > 1) {
        await mergeLaunchedGameMeta(selectedGameId, { [`route:${newTeamId}`]: chosenRoute });
      }
    } catch (err) {
      console.error('Error adding team:', err);
      setSavingTeam(false);
      return;
    }

    const newConfigTeam: ConfigTeam = {
      chipId: chip.id,
      chipNumber: chip.key_number,
      name: addTeamState.name.trim(),
      teammates: [],
    };

    const updated = [...selectedGameTeamsConfig, newConfigTeam];
    await persistTeamsConfig(updated);
    await loadTeams(selectedGameId);
    setAddTeamState(null);
    setSavingTeam(false);
  };

  // Remove one (non-leader) teammate from a team. Teammates live only in
  // meta.teamsConfig, so this is a config edit - no DB team row involved.
  const handleRemoveTeammate = (teamId: number, teammateChipId: number, teammateName: string) => {
    setConfirmDialog({
      isOpen: true,
      title: t('launched:removeTeammateTitle'),
      message: t('launched:removeTeammateMessage', { name: teammateName }),
      variant: 'warning',
      confirmText: t('launched:removeConfirm'),
      onConfirm: async () => {
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        const t = teams.find(tm => tm.id === teamId);
        const updated = selectedGameTeamsConfig.map(ct => {
          if (ct.chipId === t?.key_id || ct.name === t?.team_name) {
            return { ...ct, teammates: (ct.teammates ?? []).filter(m => m.chipId !== teammateChipId) };
          }
          return ct;
        });
        await persistTeamsConfig(updated);
      },
    });
  };

  // Remove a whole team: deletes the DB team row + its completions, then drops
  // it from the launch roster (meta.teamsConfig).
  const handleRemoveTeam = (team: Team) => {
    setConfirmDialog({
      isOpen: true,
      title: t('launched:removeTeamTitle'),
      message: t('launched:removeTeamMessage', { name: team.team_name }),
      variant: 'danger',
      confirmText: t('launched:removeTeamConfirm'),
      onConfirm: async () => {
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        try {
          await deleteTeam(team.id);
          const updated = selectedGameTeamsConfig.filter(
            ct => !(ct.chipId === team.key_id || ct.name === team.team_name)
          );
          await persistTeamsConfig(updated);
        } catch (err) {
          console.error('[LaunchedGamesList] removeTeam failed:', err);
        }
        if (selectedGameId !== null) loadTeams(selectedGameId);
      },
    });
  };

  // Stamp a team's end_time = now (unix seconds) so their clock stops and they
  // count as finished. If they never started, also backfill start_time = now so
  // the recorded duration is 0 rather than a bogus negative value. Works for
  // every game type. No-op if already ended.
  const handleEndTeam = (team: Team) => {
    if (team.end_time) return;
    setConfirmDialog({
      isOpen: true,
      title: t('launched:endTeamTitle'),
      message: t('launched:endTeamMessage', { name: team.team_name || `#${team.team_number}` }),
      variant: 'warning',
      confirmText: t('launched:endTeamConfirm'),
      onConfirm: async () => {
        setConfirmDialog(d => ({ ...d, isOpen: false }));
        const nowSec = Math.floor(Date.now() / 1000);
        try {
          await updateTeam(team.id, {
            end_time: nowSec,
            ...(team.start_time ? {} : { start_time: nowSec }),
          });
        } catch (err) {
          console.error('[LaunchedGamesList] endTeam failed:', err);
        }
        if (selectedGameId !== null) loadTeams(selectedGameId);
      },
    });
  };

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

  const getFilteredAndSortedTeams = () => {
    let filtered = teams;

    if (teamSearch) {
      const q = teamSearch.toLowerCase();
      filtered = filtered.filter(team => {
        if (
          team.team_name.toLowerCase().includes(q) ||
          team.key_id.toString().includes(q)
        ) return true;
        const configTeam = selectedGameTeamsConfig.find(t => t.chipId === team.key_id || t.name === team.team_name);
        if (configTeam?.teammates?.some(m => m.name.toLowerCase().includes(q))) return true;
        return false;
      });
    }

    // Clash clans never carry a per-team quest score; rank them by live clan points.
    const selectedGame = games.find(g => g.id === selectedGameId);
    const isClashGame = selectedGame?.game_type?.toLowerCase() === 'clash';
    const effectiveScore = (team: Team) =>
      isClashGame ? (clashStandings?.clans.find(c => c.team_id === team.id)?.points ?? 0) : team.score;

    const sorted = [...filtered].sort((a, b) => {
      if (teamSortBy === 'ranking') {
        return effectiveScore(b) - effectiveScore(a);
      } else {
        return a.team_name.localeCompare(b.team_name);
      }
    });

    return sorted;
  };

  const toggleMinimizeTeam = (teamId: number) => {
    setMinimizedTeams(prev => {
      const newSet = new Set(prev);
      if (newSet.has(teamId)) {
        newSet.delete(teamId);
      } else {
        newSet.add(teamId);
      }
      return newSet;
    });
  };

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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-[var(--pg-text)] text-xl">{t('launched:loading')}</div>
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

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-bold text-[var(--pg-text)]">{t('launched:heading')}</h2>
        <div className="flex items-center gap-2">
          {games.length > 0 && (
            <button
              onClick={() => setGamesMinimized((v) => !v)}
              className="pg-btn"
              title={gamesMinimized ? t('launched:expandGames') : t('launched:minimizeGames')}
            >
              {gamesMinimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
              {gamesMinimized ? t('launched:expandGames') : t('launched:minimizeGames')}
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

      {games.length === 0 && localGames.length === 0 ? (
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
              return (
              <div
                key={game.id}
                className={`p-6 rounded-lg border-2 transition cursor-pointer ${
                  selectedGameId === game.id
                    ? 'bg-[var(--pg-accent-tint)] border-[var(--pg-accent)]'
                    : 'bg-[var(--pg-surface)] border-[var(--pg-line)] hover:border-[var(--pg-line-strong)]'
                } ${!game.ended ? 'ring-2 ring-green-500/50' : ''}`}
                onClick={() => setSelectedGameId(game.id)}
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
            {selectedGameId !== null ? (
              <div className="sticky top-24">
                <div className="bg-[var(--pg-surface)] border-2 border-[var(--pg-line)] rounded-lg p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xl font-bold text-[var(--pg-text)] flex items-center gap-2">
                      <Users size={20} />
                      {t('launched:teamsCount', { count: teams.length })}
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          if (selectedGameId === null) return;
                          setRefreshingTeams(true);
                          await loadTeams(selectedGameId);
                          setRefreshingTeams(false);
                        }}
                        className="pg-btn pg-btn--sm"
                        title={t('launched:refreshTeams')}
                        disabled={refreshingTeams}
                      >
                        <RefreshCw size={14} className={refreshingTeams ? 'animate-spin' : ''} />
                        {t('launched:refresh')}
                      </button>
                      {teams.length > 0 && (
                        <button
                          onClick={() => {
                            if (minimizedTeams.size === teams.length) {
                              setMinimizedTeams(new Set());
                            } else {
                              const allTeamIds = new Set(teams.map(t => t.id));
                              setMinimizedTeams(allTeamIds);
                            }
                          }}
                          className="pg-btn pg-btn--sm"
                          title={minimizedTeams.size === teams.length ? t('launched:expandAllTeams') : t('launched:minimizeAllTeams')}
                        >
                          {minimizedTeams.size === teams.length ? (
                            <>
                              <Maximize2 size={14} />
                              {t('launched:expandAll')}
                            </>
                          ) : (
                            <>
                              <Minimize2 size={14} />
                              {t('launched:minimizeAll')}
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {teams.length > 0 && (
                    <div className="space-y-3 mb-4">
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] z-10" />
                          <input
                            type="text"
                            placeholder={t('launched:searchTeamsPlaceholder')}
                            value={teamSearch}
                            onChange={(e) => setTeamSearch(e.target.value)}
                            className="pg-input !pl-9"
                          />
                        </div>
                        <button
                          onClick={() => setTeamSortBy(teamSortBy === 'ranking' ? 'name' : 'ranking')}
                          className="pg-btn"
                          title={teamSortBy === 'ranking' ? t('launched:sortByName') : t('launched:sortByRanking')}
                        >
                          {teamSortBy === 'ranking' ? (
                            <>
                              <ArrowUpDown size={16} />
                              {t('launched:sortRanking')}
                            </>
                          ) : (
                            <>
                              <SortAsc size={16} />
                              {t('launched:sortName')}
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {teams.length === 0 ? (
                    <p className="text-[var(--pg-text-dim)]">{t('launched:noTeamsInGame')}</p>
                  ) : (
                    getFilteredAndSortedTeams().length === 0 ? (
                      <p className="text-[var(--pg-text-dim)] text-sm">{t('launched:noTeamsMatchSearch')}</p>
                    ) : (
                    <div className="space-y-3">
                      {getFilteredAndSortedTeams().map((team, index) => {
                        const isMinimized = minimizedTeams.has(team.id);
                        const ranking = index + 1;
                        const selectedGame = games.find(g => g.id === selectedGameId);
                        // launched_games stores game_type capitalised ('TagQuest');
                        // the scenario gameDataMap uses the lowercase slug. Lowercase
                        // the launched value so the primary check works without
                        // depending on the async gameDataMap fallback.
                        const isTagQuest = selectedGame?.game_type?.toLowerCase() === 'tagquest' ||
                          gameDataMap[selectedGame?.game_uniqid ?? '']?.game?.type?.toLowerCase() === 'tagquest';
                        const isClash = selectedGame?.game_type?.toLowerCase() === 'clash';
                        const isMystery = selectedGame?.game_type?.toLowerCase() === 'mystery' ||
                          gameDataMap[selectedGame?.game_uniqid ?? '']?.game?.type?.toLowerCase() === 'mystery';
                        // Mystery teams: the operator also wants the physical card
                        // number (key_number) alongside the chip id (key_id).
                        const teamCardNumber = isMystery
                          ? (allChips.find(c => c.id === team.key_id)?.key_number ?? null)
                          : null;
                        const clanMemberCount = clashCounts.get(team.id) ?? 0;
                        const showTeammates = isTagQuest && selectedGamePlayMode === 'team';
                        const configTeam = showTeammates
                          ? selectedGameTeamsConfig.find(t => t.chipId === team.key_id || t.name === team.team_name)
                          : undefined;
                        const teammates = configTeam?.teammates ?? [];
                        // Clash: clans share one game timeline and never set per-team
                        // start/end, so derive the live score (clan points), validation
                        // count (activity), member chips, and an activity-based status
                        // from the polled standings instead of the lg_teams row.
                        const clashStanding = isClash
                          ? clashStandings?.clans.find(c => c.team_id === team.id)
                          : undefined;
                        const clashPoints = clashStanding?.points ?? 0;
                        const clashValidations = isClash
                          ? (clashStandings?.territories ?? []).reduce(
                              (n, terr) => n + (terr.counts[String(team.id)] ?? 0), 0)
                          : 0;
                        const clashMemberChips = isClash ? (clashMembers.get(team.id) ?? []) : [];
                        // TagQuest self-register: members bound via lg_clash_members
                        // (no teamsConfig roster). Shown whenever the config roster
                        // has no teammates for this team.
                        const tagquestMemberChips =
                          isTagQuest && teammates.length === 0 ? (clashMembers.get(team.id) ?? []) : [];
                        const displayScore = isClash ? clashPoints : team.score;
                        // Status: ended game ⇒ done; live + scored ⇒ playing; else waiting.
                        const clashStatus: 'ended' | 'playing' | 'waiting' = selectedGame?.ended
                          ? 'ended'
                          : clashValidations > 0 ? 'playing' : 'waiting';
                        const renderStatusIcon = (size: number, extraClass = '') => {
                          if (isClash) {
                            if (clashStatus === 'ended') return <CheckCircle size={size} className={`text-green-500 ${extraClass}`} />;
                            if (clashStatus === 'playing') return <Play size={size} className={`text-[var(--pg-accent-bright)] ${extraClass}`} />;
                            return <Clock size={size} className={`text-[var(--pg-text-dim)] ${extraClass}`} />;
                          }
                          if (team.end_time) return <CheckCircle size={size} className={`text-green-500 ${extraClass}`} />;
                          if (team.start_time) return <Play size={size} className={`text-[var(--pg-accent-bright)] ${extraClass}`} />;
                          return <Clock size={size} className={`text-[var(--pg-text-dim)] ${extraClass}`} />;
                        };
                        const clanChipLabel = (chipId: number) => {
                          const c = allChips.find(x => x.id === chipId);
                          return c ? { number: c.key_number, name: c.key_name } : { number: chipId, name: '' };
                        };

                        return (
                        <div
                          key={team.id}
                          className="bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-lg overflow-hidden"
                        >
                          {isMinimized ? (
                            <div className="p-3 flex items-center justify-between cursor-pointer hover:bg-[var(--pg-surface-3)] transition" onClick={() => toggleMinimizeTeam(team.id)}>
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <span className="text-[var(--pg-text-dim)] text-sm font-medium">#{ranking}</span>
                                <div className="flex items-center gap-2 min-w-0">
                                  {renderStatusIcon(16, 'shrink-0')}
                                  <span className="text-[var(--pg-text)] font-semibold truncate">{team.team_name}</span>
                                </div>
                                {showTeammates && teammates.length > 1 && (
                                  <span className="flex items-center gap-1 text-teal-400 text-xs shrink-0">
                                    <Users size={12} />
                                    {teammates.length}
                                  </span>
                                )}
                                {(isClash || tagquestMemberChips.length > 0) && (
                                  <span className="flex items-center gap-1 text-blue-400 text-xs shrink-0" title="Chips in this team">
                                    <Users size={12} />
                                    {clanMemberCount}
                                  </span>
                                )}
                                <span className="flex items-center gap-2 text-[var(--pg-text-dim)] text-sm ml-auto mr-4 shrink-0">
                                  {t('launched:scoreLabel')} <span className="text-[var(--pg-text)] font-medium">{displayScore}</span>
                                  {team.weight != null && (
                                    <span
                                      title={t('launched:effectifWeightTitle')}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-sky-500/20 border border-sky-500/40 rounded-full text-sky-400 text-xs font-semibold"
                                    >
                                      <Users size={12} />
                                      {t('launched:effectifWeightBadge', { count: team.headcount ?? 1, weight: formatWeight(team.weight) })}
                                    </span>
                                  )}
                                  {team.currentLevel && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                                      {team.currentLevel.name}
                                    </span>
                                  )}
                                </span>
                                {!showTeammates && !isClash && (
                                  <span className="text-[var(--pg-text-dim)] text-sm shrink-0 flex items-center gap-2">
                                    <span>{t('launched:chipLabel', { id: team.key_id })}</span>
                                    {isMystery && teamCardNumber != null && (
                                      <span>{t('launched:cardNumberLabel', { number: teamCardNumber })}</span>
                                    )}
                                  </span>
                                )}
                              </div>
                              <button className="p-1 hover:bg-[var(--pg-surface-3)] rounded transition ml-2 shrink-0" title={t('launched:expandTeamDetails')}>
                                <Maximize2 size={16} className="text-[var(--pg-text-dim)]" />
                              </button>
                            </div>
                          ) : (
                          <div className="p-4">
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-3">
                                <div className="flex items-center gap-2">
                                  {renderStatusIcon(18)}
                                  {renamingTeamId === team.id ? (
                                    <input
                                      autoFocus
                                      value={renameValue}
                                      onChange={e => setRenameValue(e.target.value)}
                                      onBlur={() => handleRenameTeam(team.id)}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter') handleRenameTeam(team.id);
                                        if (e.key === 'Escape') { setRenamingTeamId(null); setRenameValue(''); }
                                      }}
                                      className="bg-[var(--pg-surface-3)] border border-[var(--pg-accent-line)] rounded px-2 py-0.5 text-[var(--pg-text)] font-semibold text-sm focus:outline-none w-36"
                                    />
                                  ) : (
                                    <span
                                      className="text-[var(--pg-text)] font-semibold cursor-pointer hover:text-[var(--pg-accent-bright)] transition-colors"
                                      title={t('launched:doubleClickToRename')}
                                      onDoubleClick={() => { setRenamingTeamId(team.id); setRenameValue(team.team_name); }}
                                    >
                                      {team.team_name}
                                    </span>
                                  )}
                                  <span className="text-[var(--pg-text-dim)] text-xs font-mono">#{team.team_number}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {!showTeammates && !isClash && (
                                  <span className="text-[var(--pg-text-dim)] text-sm flex items-center gap-2">
                                    <span>{t('launched:chipLabel', { id: team.key_id })}</span>
                                    {isMystery && teamCardNumber != null && (
                                      <span>{t('launched:cardNumberLabel', { number: teamCardNumber })}</span>
                                    )}
                                  </span>
                                )}
                                {isClash && (
                                  <span className="flex items-center gap-1 text-blue-400 text-sm" title="Chips in this clan">
                                    <Users size={13} />
                                    {clanMemberCount}
                                  </span>
                                )}
                                <button
                                  onClick={() => toggleMinimizeTeam(team.id)}
                                  className="p-1 hover:bg-[var(--pg-surface-3)] rounded transition"
                                  title={t('launched:minimizeTeamDetails')}
                                >
                                  <Minimize2 size={16} className="text-[var(--pg-text-dim)]" />
                                </button>
                              </div>
                            </div>

                          <>
                              <div className="text-sm text-[var(--pg-text-dim)] space-y-1 mb-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span>{t('launched:scoreLabel')} <span className="text-[var(--pg-text)] font-medium">{displayScore}</span></span>
                                  {team.weight != null && (
                                    <span
                                      title={t('launched:effectifWeightTitle')}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-sky-500/20 border border-sky-500/40 rounded-full text-sky-400 text-xs font-semibold"
                                    >
                                      <Users size={12} />
                                      {t('launched:effectifWeightBadge', { count: team.headcount ?? 1, weight: formatWeight(team.weight) })}
                                    </span>
                                  )}
                                  {team.currentLevel && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-400 text-xs font-semibold">
                                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                                      {team.currentLevel.name}
                                    </span>
                                  )}
                                  {isClash && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/15 border border-blue-500/30 rounded-full text-blue-300 text-xs font-semibold">
                                      <Flag size={11} />
                                      {t('launched:validationsBadge', { count: clashValidations })}
                                    </span>
                                  )}
                                </div>
                                {!isClash && (
                                  <>
                                    <div>{t('launched:startLabel')} <span className="text-[var(--pg-text)]">{formatTime(team.start_time)}</span></div>
                                    <div>{t('launched:endLabel')} <span className="text-[var(--pg-text)]">{team.end_time ? formatTime(team.end_time) : t('launched:notEnded')}</span></div>
                                  </>
                                )}
                              </div>
                              {(isClash || tagquestMemberChips.length > 0) && (
                                <div className="mb-3 pt-2 border-t border-[var(--pg-line)]">
                                  <div className="flex items-center gap-1.5 text-xs text-[var(--pg-text-dim)] mb-2">
                                    <Users size={12} />
                                    <span className="font-medium uppercase tracking-wide">
                                      {t('launched:membersHeading', { count: (isClash ? clashMemberChips : tagquestMemberChips).length })}
                                    </span>
                                  </div>
                                  {(isClash ? clashMemberChips : tagquestMemberChips).length === 0 ? (
                                    <p className="text-xs text-[var(--pg-text-dim)]">{t('launched:noChipsBound')}</p>
                                  ) : (
                                    <div className="flex flex-wrap gap-2">
                                      {(isClash ? clashMemberChips : tagquestMemberChips).map((chipId) => {
                                        const label = clanChipLabel(chipId);
                                        return (
                                          <span key={chipId} className="flex items-center gap-1.5 px-2.5 py-1 bg-[var(--pg-surface-3)] rounded-full text-xs text-[var(--pg-text-muted)]">
                                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                                            {label.name || `Chip ${chipId}`}
                                            <span className="text-[var(--pg-text-dim)] font-mono">#{label.number}</span>
                                          </span>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              )}
                              {showTeammates && (
                                <div className="mb-3 pt-2 border-t border-[var(--pg-line)]">
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-1.5 text-xs text-[var(--pg-text-dim)]">
                                      <Users size={12} />
                                      <span className="font-medium uppercase tracking-wide">{t('launched:teammates')}</span>
                                    </div>
                                    {addTeammateState?.teamId !== team.id && (
                                      <button
                                        onClick={() => openAddTeammate(team.id)}
                                        className="flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300 transition"
                                      >
                                        <UserPlus size={12} />
                                        {t('launched:add')}
                                      </button>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    {teammates.map((mate, mi) => (
                                      <span key={mi} className="flex items-center gap-1.5 px-2.5 py-1 bg-[var(--pg-surface-3)] rounded-full text-xs text-[var(--pg-text-muted)]">
                                        <span className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" />
                                        {mate.name}
                                        <span className="text-[var(--pg-text-dim)] font-mono">#{mate.chipNumber}</span>
                                        <span className="text-[var(--pg-text-dim)] font-mono text-[10px]">{mate.chipId}</span>
                                        {mate.chipId !== team.key_id && (
                                          <button
                                            onClick={() => handleRemoveTeammate(team.id, mate.chipId, mate.name)}
                                            className="ml-0.5 -mr-0.5 text-[var(--pg-text-dim)] hover:text-red-400 transition"
                                            title={t('launched:removeTeammateTitle')}
                                          >
                                            <X size={12} />
                                          </button>
                                        )}
                                      </span>
                                    ))}
                                  </div>
                                  {addTeammateState?.teamId === team.id && (
                                    <div className="mt-2 p-2 bg-[var(--pg-bg)] rounded-lg space-y-2">
                                      <input
                                        type="text"
                                        placeholder={t('launched:teammateNamePlaceholder')}
                                        value={addTeammateState.name}
                                        onChange={e => setAddTeammateState({ ...addTeammateState, name: e.target.value })}
                                        className="pg-input !text-xs !py-1.5"
                                      />
                                      <select
                                        value={addTeammateState.chipId ?? ''}
                                        onChange={e => {
                                          const id = Number(e.target.value) || null;
                                          const chip = allChips.find(c => c.id === id);
                                          setAddTeammateState({ ...addTeammateState, chipId: id, name: chip ? chip.key_name : addTeammateState.name });
                                        }}
                                        className="pg-select !text-xs !py-1.5"
                                      >
                                        <option value="">{t('launched:selectChip')}</option>
                                        {allChips
                                          .filter(c => !getUsedChipIds().has(c.id))
                                          .map(c => (
                                            <option key={c.id} value={c.id}>
                                              {t('launched:chipOption', { number: c.key_number, name: c.key_name, id: c.id })}
                                            </option>
                                          ))}
                                      </select>
                                      <div className="flex gap-1.5">
                                        <button
                                          onClick={handleAddTeammate}
                                          disabled={savingTeammate || !addTeammateState.name.trim() || addTeammateState.chipId === null}
                                          className="flex-1 px-2 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white rounded text-xs font-medium flex items-center justify-center gap-1"
                                        >
                                          <Save size={11} />
                                          {savingTeammate ? t('launched:saving') : t('launched:save')}
                                        </button>
                                        <button
                                          onClick={() => {
                                            const name = pickRandomName();
                                            if (name) setAddTeammateState(s => (s ? { ...s, name } : s));
                                          }}
                                          disabled={namePoolNames.length === 0}
                                          className="px-2 py-1.5 bg-[var(--pg-surface-3)] hover:bg-indigo-600 disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-3)] text-[var(--pg-text)] rounded text-xs flex items-center gap-1"
                                          title={namePoolNames.length === 0 ? t('launched:noPooledNames') : t('launched:randomName')}
                                        >
                                          <Dices size={11} />
                                        </button>
                                        <button
                                          onClick={() => setAddTeammateState(null)}
                                          className="px-2 py-1.5 bg-[var(--pg-surface-3)] hover:bg-[var(--pg-surface-2)] text-[var(--pg-text)] rounded text-xs"
                                        >
                                          <X size={11} />
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                              <div className="flex gap-2">
                                <button
                                  onClick={() => {
                                    const game = games.find(g => g.id === selectedGameId);
                                    if (!game) return;
                                    if ((game.game_type || '').toLowerCase() === 'clash') {
                                      // Clash: clan-management modal (chips + territories) instead
                                      // of the quest/enigma TeamDetailsModal.
                                      setClashClan({ id: team.id, team_number: team.team_number, team_name: team.team_name });
                                    } else {
                                      setTeamDetails({ team, gameUniqid: game.game_uniqid, gameType: game.game_type });
                                    }
                                  }}
                                  className="flex-1 px-3 py-2 bg-[var(--pg-accent)] hover:bg-[var(--pg-accent-hover)] text-white rounded text-sm font-medium flex items-center justify-center gap-1.5"
                                  title={t('launched:viewTeamDetails')}
                                >
                                  <Eye size={15} />
                                  {t('launched:details')}
                                </button>
                                <button
                                  onClick={() => handleEndTeam(team)}
                                  disabled={!!team.end_time}
                                  className="px-3 py-2 bg-[var(--pg-surface-3)] hover:bg-orange-600 text-[var(--pg-text-muted)] hover:text-white rounded text-sm font-medium flex items-center disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-3)] disabled:hover:text-[var(--pg-text-muted)]"
                                  title={team.end_time ? t('launched:teamAlreadyEnded') : t('launched:endTeamTitle')}
                                >
                                  <StopCircle size={14} />
                                </button>
                                {isAdminMode && (
                                  <button
                                    onClick={() => {
                                      const game = games.find(g => g.id === selectedGameId);
                                      if (game) {
                                        setTestTeam({ gameId: game.id, gameName: game.name, team });
                                      }
                                    }}
                                    className="px-3 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded text-sm font-medium flex items-center gap-1.5"
                                    title={t('launched:testThisTeam')}
                                  >
                                    <FlaskConical size={14} />
                                    {t('launched:test')}
                                  </button>
                                )}
                                <button
                                  onClick={() => {
                                    const game = games.find(g => g.id === selectedGameId);
                                    if (game) setPrintTarget({ game, teamId: team.id, subject: `${game.name} - ${team.team_name}` });
                                  }}
                                  disabled={printing}
                                  className="px-3 py-2 bg-[var(--pg-surface-3)] hover:bg-[var(--pg-surface-2)] text-[var(--pg-text-muted)] rounded text-sm font-medium flex items-center disabled:opacity-50"
                                  title={t('launched:printTeam')}
                                >
                                  <Printer size={14} />
                                </button>
                                {(() => {
                                  const game = games.find(g => g.id === selectedGameId);
                                  if (!game || !gameTypeHasTeamSummary(game.game_type) || !team.end_time) return null;
                                  return (
                                    <button
                                      onClick={() => setSummaryDeviceTarget({ game, teamId: team.id })}
                                      className="px-3 py-2 bg-[var(--pg-surface-3)] hover:bg-indigo-600 text-[var(--pg-text-muted)] hover:text-white rounded text-sm font-medium flex items-center"
                                      title={t('launched:showSummaryOnDevice')}
                                    >
                                      <MonitorPlay size={14} />
                                    </button>
                                  );
                                })()}
                                <button
                                  onClick={() => handleRemoveTeam(team)}
                                  className="px-3 py-2 bg-[var(--pg-surface-3)] hover:bg-red-600 text-[var(--pg-text-muted)] hover:text-white rounded text-sm font-medium flex items-center"
                                  title={t('launched:removeTeamTitle')}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </>
                          </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                    )
                  )}
                  {selectedGamePlayMode === 'team' && (
                    <div className="mt-4">
                      {addTeamState === null ? (
                        <button
                          onClick={openAddTeam}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 border border-dashed border-[var(--pg-line-strong)] hover:border-teal-500 text-[var(--pg-text-dim)] hover:text-teal-400 rounded-lg text-sm transition"
                        >
                          <PlusCircle size={15} />
                          {t('launched:addTeam')}
                        </button>
                      ) : (
                        <div className="p-3 bg-[var(--pg-surface-2)] border border-[var(--pg-line-strong)] rounded-lg space-y-2">
                          <div className="text-xs text-[var(--pg-text-dim)] font-medium uppercase tracking-wide mb-1">{t('launched:newTeam')}</div>
                          <input
                            type="text"
                            placeholder={t('launched:teamNamePlaceholder')}
                            value={addTeamState.name}
                            onChange={e => setAddTeamState({ ...addTeamState, name: e.target.value })}
                            className="pg-input !py-1.5"
                          />
                          <select
                            value={addTeamState.chipId ?? ''}
                            onChange={e => {
                              const id = Number(e.target.value) || null;
                              const chip = allChips.find(c => c.id === id);
                              setAddTeamState({ ...addTeamState, chipId: id, name: chip ? chip.key_name : addTeamState.name });
                            }}
                            className="pg-select !py-1.5"
                          >
                            <option value="">{t('launched:selectChip')}</option>
                            {allChips
                              .filter(c => !getUsedChipIds().has(c.id))
                              .map(c => (
                                <option key={c.id} value={c.id}>
                                  {t('launched:chipOption', { number: c.key_number, name: c.key_name, id: c.id })}
                                </option>
                              ))}
                          </select>
                          {tracksRouteOptions.length > 1 && (
                            <select
                              value={addTeamState.route ?? tracksDefaultRoute}
                              onChange={e => setAddTeamState({ ...addTeamState, route: e.target.value })}
                              className="pg-select !py-1.5"
                              title={t('launched:routeSelectTitle')}
                            >
                              {tracksRouteOptions.map(r => (
                                <option key={r} value={r}>
                                  {t(`launched:trackRoute_${r}`, { defaultValue: TRACKS_ROUTE_LABELS[r] ?? r })}
                                </option>
                              ))}
                            </select>
                          )}
                          {selectedGameLanguages.length >= 2 && (
                            <div className="flex items-center gap-2">
                              <select
                                value={addTeamState.language ?? nameDrawLang}
                                onChange={e => setAddTeamState({ ...addTeamState, language: e.target.value })}
                                className="pg-select flex-1 min-w-0 !py-1.5"
                                title={t('launched:languageSelectTitle')}
                              >
                                {selectedGameLanguages.map(l => (
                                  <option key={l} value={l}>
                                    {LANG_NAMES[l] ?? l}
                                  </option>
                                ))}
                              </select>
                              <HelpDot topic="team.language" align="right" />
                            </div>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={handleAddTeam}
                              disabled={savingTeam || !addTeamState.name.trim() || addTeamState.chipId === null}
                              className="flex-1 px-3 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white rounded text-sm font-medium flex items-center justify-center gap-1.5"
                            >
                              <Save size={13} />
                              {savingTeam ? t('launched:saving') : t('launched:saveTeam')}
                            </button>
                            <button
                              onClick={() => {
                                const name = pickRandomName();
                                if (name) setAddTeamState(s => (s ? { ...s, name } : s));
                              }}
                              disabled={namePoolNames.length === 0}
                              className="px-3 py-1.5 bg-[var(--pg-surface-3)] hover:bg-indigo-600 disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-3)] text-[var(--pg-text)] rounded text-sm flex items-center gap-1.5"
                              title={namePoolNames.length === 0 ? t('launched:noPooledNames') : t('launched:randomName')}
                            >
                              <Dices size={13} />
                              {t('launched:randomName')}
                            </button>
                            <button
                              onClick={() => setAddTeamState(null)}
                              className="px-3 py-1.5 bg-[var(--pg-surface-3)] hover:bg-[var(--pg-surface-2)] text-[var(--pg-text)] rounded text-sm"
                            >
                              <X size={13} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
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
            if (selectedGameId !== null) loadTeams(selectedGameId);
          }}
        />
      )}

      {teamDetails && selectedGameId !== null && (
        <TeamDetailsModal
          team={teamDetails.team}
          launchedGameId={selectedGameId}
          gameUniqid={teamDetails.gameUniqid}
          gameType={teamDetails.gameType}
          chipIds={chipIdsForTeam(teamDetails.team)}
          languages={selectedGameLanguages}
          launchLanguage={nameDrawLang}
          onTeamUpdated={() => loadTeams(selectedGameId)}
          onClose={() => setTeamDetails(null)}
        />
      )}

      {clashClan && selectedGameId !== null && (
        <ClashClanDetailsModal
          clanTeam={clashClan}
          launchedGameId={selectedGameId}
          onClose={() => setClashClan(null)}
          onChanged={() => { if (selectedGameId !== null) loadTeams(selectedGameId); }}
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
