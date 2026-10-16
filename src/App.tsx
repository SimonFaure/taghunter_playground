import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import {
  Settings,
  ShieldCheck,
  ShieldOff,
  Map,
  Rocket,
  Database as DatabaseIcon,
  Lock,
  Image as ImageIcon,
  HelpCircle,
  FlaskConical,
  MonitorSmartphone,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { HelpProvider, playgroundOpenPdf, helpManifest } from './help';
import { GameList } from './components/GameList';
import { TopbarStatus } from './components/TopbarStatus';
import { DeviceIdentityLine } from './components/DeviceIdentityLine';
import { ConfigurationPage, type SettingsTab } from './components/ConfigurationPage';
import { AdminPasswordModal } from './components/AdminPasswordModal';
import { AdminConfigPage } from './components/AdminConfigPage';
import { LaunchedGamesList } from './components/LaunchedGamesList';
import { OperatorVideoOverlay } from './components/OperatorVideoOverlay';
import { MotherFailoverBanner } from './components/MotherFailoverBanner';
import { HotspotRemovedNotice } from './components/HotspotRemovedNotice';
import { RegainControlPrompt } from './components/RegainControlPrompt';
import { LeaderboardPage } from './components/LeaderboardPage';
import { TimeRangeLeaderboard } from './components/TimeRangeLeaderboard';
import { decodeRankingTarget, type RankingTarget } from './services/rankingTarget';
import { decodeTeamSummarySnapshot, type TeamSummarySnapshot } from './services/teamSummaryTarget';
import { TeamSummaryOverlay } from './components/TeamSummaryOverlay';
import { listen } from '@tauri-apps/api/event';
import { emitPendingJoin, emitPendingLeave, emitPendingConfigReload, emitPendingRejoin, type PendingJoinRoute } from './services/pendingJoinStore';
import { pointLaunchedGamesAtMother, msSincePromotion } from './services/lanMotherBoot';
import { refreshLaunchedGamesRoute, installLanReauth, onLaunchedGamesRouteChange } from './services/childControlLink';
import { ensureFirewallRuleOnce } from './services/firewall';
import { installMotherFailover } from './services/motherFailover';
import { hostingRoleTick } from './services/hostingRole';
import { reconcileRoleFlagOnce } from './services/deviceRole';
import { getPairedMother } from './services/lanPairing';
import { getDeviceMetadata, getCachedDeviceDisplayName } from './services/device';
import { DatabaseInspector } from './components/DatabaseInspector';
import { FirstLaunchProgress } from './components/sync/FirstLaunchProgress';
import { LogoLaunchScreen } from './components/LogoLaunchScreen';
import { DevicesFleetModal } from './components/DevicesFleetModal';
import type { LogoAnimation } from './utils/logoEffect';
import { SyncStatusPill } from './components/sync/SyncStatusPill';
import { SyncFailureBanner } from './components/sync/SyncFailureBanner';
import { PendingUpdatesPrompt } from './components/sync/PendingUpdatesPrompt';
import { UpdateRequiredOverlay } from './components/update/UpdateRequiredOverlay';
import { UpdateAvailableNotice } from './components/update/UpdateAvailableNotice';
import { useAuth } from './components/auth/AuthProvider';
import { start as startSync, stop as stopSync } from './services/syncOrchestrator';
import { installPeerContentSync } from './services/peerContent';
import { checkForUpdate, pruneUpdateCache, type UpdateStatus } from './services/updateService';
// Import for side effects: syncLog wires its event listeners on first
// module load, so it must be referenced before any cycle:* events fire (or
// it'll miss them when the user isn't on the Settings → Sync tab).
import './services/syncLog';
import { pruneOrphanBlobs, pruneStaleCardsCsv } from './services/contentFs';
import { migrateToCasIfNeeded } from './services/casMigration';
import * as scenarioStore from './services/scenarioStore';
import { on as onSyncEvent } from './services/syncEvents';
import {
  recoverPendingPanic,
  sendHeartbeat,
  startDrainer,
  stopDrainer,
} from './services/telemetry';
import { startSummarySync, stopSummarySync, listLaunchedGames } from './services/launchedGames';
import { loadConfig } from './utils/config';
import { onPinReset } from './services/pinResetSignal';
import { getLocalLaunchedGamesRoute } from './services/api';
import { onPresetLaunch } from './services/launchPresetStore';
import { isOperatorOnly, syncOperatorPresence } from './services/operatorMode';

type Page =
  | 'scenarios'
  | 'launched'
  | 'settings'
  | 'admin-config'
  | 'database';

function App() {
  const auth = useAuth();
  const { t, i18n } = useTranslation();
  const [currentPage, setCurrentPage] = useState<Page>('scenarios');
  // "Launch this config" (game simulator Coverage tab): show the scenarios
  // page; GameList consumes the preset and opens the pre-filled wizard.
  useEffect(() => onPresetLaunch(() => setCurrentPage('scenarios')), []);
  // Report the operator-only setting to the LAN layer (pings / mother rows).
  useEffect(() => {
    void syncOperatorPresence();
  }, []);
  const [isAdminMode, setIsAdminMode] = useState(false);
  // Count of currently-active (not-ended) launched games, shown as a badge on
  // the "Launched games" nav button. Polled so it stays fresh as games are
  // launched/ended from anywhere (this device or another LAN device).
  const [activeGameCount, setActiveGameCount] = useState(0);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());
  // Deep-link target for the settings page. Set by the sync pill / failure
  // banner when the user clicks them; consumed by ConfigurationPage which
  // honors it once and is then free to track its own tab state.
  const [pendingSettingsTab, setPendingSettingsTab] = useState<SettingsTab | undefined>(undefined);
  // Raised when an offline recovery code cleared the device PIN - nudges the
  // operator to set a new one (the gates bypass with no PIN). Dismissable.
  const [pinResetNotice, setPinResetNotice] = useState(false);
  const processedRef = useRef<boolean>(false);
  const startedRef = useRef<boolean>(false);

  // App self-update state. `updateGate` is set when the running version is
  // below the server's hard floor - it blocks the whole app. `optionalUpdate`
  // is a dismissable notice for a newer-but-not-mandatory version. The ref
  // mirrors `updateGate` so the orchestrator effect can see it synchronously.
  const [updateGate, setUpdateGate] = useState<UpdateStatus | null>(null);
  const [optionalUpdate, setOptionalUpdate] = useState<UpdateStatus | null>(null);
  const updateGateRef = useRef<boolean>(false);

  // Deep-link into Settings → Updates (from the optional-update notice).
  const navigateToUpdates = () => {
    setCurrentPage('settings');
    setPendingSettingsTab('updates');
  };

  // Surface the "set a new PIN" banner whenever a recovery code clears the PIN.
  useEffect(() => onPinReset(() => setPinResetNotice(true)), []);

  // The Security section (with the Device PIN control) lives in the Preferences
  // tab - deep-link there from the banner.
  const navigateToSecurity = () => {
    setCurrentPage('settings');
    setPendingSettingsTab('general');
    setPinResetNotice(false);
  };

  // A ranking page pushed to this device by the mother (open_ranking command).
  // Rendered as a full-screen overlay; dismissed with the Back button.
  const [pushedRanking, setPushedRanking] = useState<RankingTarget | null>(null);

  // A finished team's final summary pushed to this device by the mother
  // (show_team_summary command). Rendered as a full-screen overlay; dismissed
  // with the Back button / Esc. Self-contained (images resolve locally), so no
  // mother-repoint is needed.
  const [pushedTeamSummary, setPushedTeamSummary] = useState<TeamSummarySnapshot | null>(null);

  // Top-bar "Devices" modal: every paired device's status + remote lock / logo.
  const [showFleet, setShowFleet] = useState(false);
  // The lan-command listener below subscribes once; read auth through a ref.
  const authRef = useRef(auth);
  authRef.current = auth;
  // What this device was showing when a remote join_game pulled it into a game
  // (the idle logo screen and/or the PIN lock), so a later disconnect_device
  // from THAT game puts it back exactly there. null = it was on the normal app.
  const preJoinScreenRef = useRef<{ gameId: number; logo: boolean; locked: boolean } | null>(null);

  // Listen for mother-issued LAN commands relayed by `client_ping_mother`.
  // join_game and open_ranking land here at the App level because they control
  // navigation; play_video / stop_video are handled by <OperatorVideoOverlay>.
  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;
    // The mother hosts launched games in ITS SQLite. Repoint our
    // `launched_games` traffic at the mother before any leaderboard/state
    // query, otherwise we hit our own empty local server.
    // Returns the route it installed so callers can hand it to the subscriber -
    // a concurrent refreshLaunchedGamesRoute() may restore the local route
    // before the subscriber runs, and the pushed route is the authoritative one.
    const repointAtMother = async (
      motherUuid?: string,
      motherAddr?: string,
    ): Promise<PendingJoinRoute | undefined> => {
      if (!motherUuid || !motherAddr) return undefined;
      try {
        const m = await getPairedMother(motherUuid);
        if (m) {
          const route = { baseUrl: `http://${motherAddr}`, token: m.peer_secret };
          pointLaunchedGamesAtMother(route.baseUrl, route.token);
          return route;
        }
      } catch (err) {
        console.error('[App] failed to repoint launched_games at mother:', err);
      }
      return undefined;
    };
    void (async () => {
      const unlisten = await listen<{
        id: number;
        kind:
          | 'join_game'
          | 'play_video'
          | 'stop_video'
          | 'open_ranking'
          | 'show_team_summary'
          | 'disconnect_device'
          | 'become_mother'
          | 'reload_config'
          | 'lock_device'
          | 'show_logo';
        payload: Record<string, unknown> & { launched_game_id?: number };
        mother_uuid?: string;
        mother_addr?: string;
        // Set when OUR OWN server dispatched the command in-process (a child
        // targeted this device while it hosts the game) - there's no remote
        // mother to repoint at.
        local?: boolean;
      }>('taghunter://lan-command', (event) => {
        if (cancelled) return;
        const cmd = event.payload;
        if (cmd.kind === 'join_game') {
          const gid = cmd.payload.launched_game_id;
          if (typeof gid !== 'number') return;
          void (async () => {
            // An operator-only device never plays: ignore a push from an older
            // mother that doesn't know this device is operator-only yet.
            if (await isOperatorOnly()) {
              console.warn('[App] join_game ignored: this device is operator-only');
              return;
            }
            // Self-targeted join (a child launched the game onto this mother):
            // the game lives in our own db, so enter it via our local server.
            let joinRoute: PendingJoinRoute | undefined;
            if (cmd.local) {
              const local = getLocalLaunchedGamesRoute();
              if (local) {
                joinRoute = { baseUrl: local.baseUrl, token: local.token };
                pointLaunchedGamesAtMother(joinRoute.baseUrl, joinRoute.token);
              }
            } else {
              joinRoute = await repointAtMother(cmd.mother_uuid, cmd.mother_addr);
            }
            if (cancelled) return;
            // Remember a logo / lock screen this push pulls the device off, for
            // disconnect_device to restore. A rejoin into the game it's already
            // in keeps the screen recorded by the original join.
            const wasLogo = logoPhaseRef.current === 'show';
            const wasLocked = authRef.current.locked;
            if (wasLogo || wasLocked) {
              preJoinScreenRef.current = { gameId: gid, logo: wasLogo, locked: wasLocked };
            } else if (preJoinScreenRef.current?.gameId !== gid) {
              preJoinScreenRef.current = null;
            }
            // The operator chose to pull this device into a game: lift the PIN
            // lock so the game page is actually visible (it re-locks if the
            // device is removed from the game - see disconnect_device).
            if (wasLocked) authRef.current.unlock();
            // Dismiss any pushed overlay first - they render on top of the page
            // tree, so leaving one up would hide the game page we're about to
            // enter (the device would just sit on the ranking/summary).
            setPushedRanking(null);
            setPushedTeamSummary(null);
            // A device parked on the idle logo screen renders nothing else -
            // the join would stay buffered until someone dismissed the logo by
            // hand. The operator selected this device, so pull it off the logo
            // (disconnect_device sends it back there once the game is over).
            setLogoPhase((p) => (p === 'show' ? 'done' : p));
            setCurrentPage('launched');
            emitPendingJoin(gid, joinRoute);
            // If a GamePage for this game is already mounted but showing its
            // own leaderboard / rankings overlay (a device the operator sent to
            // rankings), emitPendingJoin just re-renders it in place and leaves
            // that overlay up. Tell it to drop back to the game view.
            emitPendingRejoin(gid);
          })();
        } else if (cmd.kind === 'open_ranking') {
          const target = decodeRankingTarget(cmd.payload);
          if (!target) return;
          void (async () => {
            await repointAtMother(cmd.mother_uuid, cmd.mother_addr);
            if (cancelled) return;
            // The pushed overlay renders inside the main tree, which the idle
            // logo screen's early return bypasses entirely - dismiss it.
            setLogoPhase((p) => (p === 'show' ? 'done' : p));
            setPushedRanking(target);
          })();
        } else if (cmd.kind === 'show_team_summary') {
          // Self-contained snapshot (images resolve from this device's own
          // synced scenario) - no mother-repoint needed.
          const snapshot = decodeTeamSummarySnapshot(cmd.payload);
          if (!snapshot) return;
          // Same as open_ranking: the overlay is invisible behind the idle
          // logo screen's early return.
          setLogoPhase((p) => (p === 'show' ? 'done' : p));
          setPushedTeamSummary(snapshot);
        } else if (cmd.kind === 'disconnect_device') {
          // The mother removed this device from the game. Drop any pushed
          // overlay, leave the in-game page (back to the launched-games list),
          // then put it back on the screen the join pulled it off (logo and/or
          // PIN lock); failing that, on the logo screen if this device shows
          // one at app start.
          setPushedRanking(null);
          setPushedTeamSummary(null);
          emitPendingLeave();
          setCurrentPage('launched');
          const recorded = preJoinScreenRef.current;
          const before =
            recorded && recorded.gameId === cmd.payload.launched_game_id ? recorded : null;
          preJoinScreenRef.current = null;
          if (before?.locked) authRef.current.lock();
          void (async () => {
            try {
              const cfg = await loadConfig();
              if (cancelled || !(before?.logo || cfg.logoScreenOnLaunch)) return;
              setLogoCfg({
                bg: cfg.logoScreenBgColor ?? '#000000',
                file: cfg.logoScreenLogoFile ?? null,
                animation: cfg.logoScreenAnimation ?? 'pulse',
                glowColor: cfg.logoScreenGlowColor ?? '#FFFFFF',
                requirePin: Boolean(cfg.requirePinToExitLogo),
              });
              setLogoPhase('show');
            } catch {
              /* leave on the launched-games list if config can't be read */
            }
          })();
        } else if (cmd.kind === 'lock_device') {
          // Another device locked this one from its Devices modal: same PIN
          // overlay as the nav-bar Lock button (the app keeps running beneath).
          authRef.current.lock();
        } else if (cmd.kind === 'show_logo') {
          // Same as the nav-bar Logo button. Drop pushed overlays so they don't
          // resurface once the logo is tapped away.
          setPushedRanking(null);
          setPushedTeamSummary(null);
          void showLogoScreen();
        } else if (cmd.kind === 'reload_config') {
          // The mother (or another device) edited this game's config. Tell a
          // mounted GamePage to re-derive its config from the freshly-saved
          // meta so the edit applies live. Repoint at the mother first so the
          // GamePage's getLaunchedGameMeta reads the mother's DB, not ours.
          const gid = cmd.payload.launched_game_id;
          if (typeof gid !== 'number') return;
          void (async () => {
            await repointAtMother(cmd.mother_uuid, cmd.mother_addr);
            if (cancelled) return;
            emitPendingConfigReload(gid);
          })();
        }
      });
      if (cancelled) unlisten();
      else unlistenFn = unlisten;
    })();
    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // Single entry point for "take me to the sync screen" - invoked by both
  // SyncStatusPill (bottom-right) and SyncFailureBanner (top). Setting the
  // pendingSettingsTab via a new object (or just to 'sync') triggers the
  // ConfigurationPage's deep-link effect even if we're already on settings.
  const navigateToSync = () => {
    setCurrentPage('settings');
    setPendingSettingsTab('sync');
  };

  // First-launch overlay state. Visible while:
  //   - the local DB has zero scenarios with local_version IS NOT NULL, AND
  //   - the orchestrator's startup cycle has queued at least one download.
  // Dismissed when the cycle finishes, when the user clicks "Skip", or when
  // first-launch detection determines we're not first-launching.
  const [firstLaunchVisible, setFirstLaunchVisible] = useState(false);
  // 'pending' = first-launch detected, waiting for the cycle to report work.
  // 'shown' = overlay rendering. 'done' = past first-launch, never show again.
  const firstLaunchPhaseRef = useRef<'pending' | 'shown' | 'done'>('done');

  // Logo launch screen. 'loading' until config.json is read, then 'show'
  // (when logoScreenOnLaunch is set) or 'done'. Shown once per session as
  // the last gate before the home page - after the update and first-launch
  // gates. Dismissed by any click/tap/keypress.
  const [logoPhase, setLogoPhase] = useState<'loading' | 'show' | 'done'>('loading');
  // Read by the subscribe-once lan-command listener.
  const logoPhaseRef = useRef(logoPhase);
  logoPhaseRef.current = logoPhase;

  // Top bar: drop the nav tabs to a second row when brand + nav + icons don't
  // fit on one. Measured from the three blocks' natural widths (all nowrap, so
  // they don't change with the layout) - re-run whenever the bar or any block
  // resizes (window, admin tabs, game-count badge, status icons).
  const topbarRef = useRef<HTMLElement>(null);
  const brandRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const utilsRef = useRef<HTMLDivElement>(null);
  const [topbarStacked, setTopbarStacked] = useState(false);
  // Deps: the header only exists once the logo / first-launch gates are past,
  // so re-attach when those change.
  const headerMounted = !updateGate && !firstLaunchVisible && logoPhase === 'done';
  useLayoutEffect(() => {
    const bar = topbarRef.current;
    const parts = [brandRef.current, navRef.current, utilsRef.current];
    if (!bar || parts.some((p) => !p)) return;
    const measure = () => {
      const cs = getComputedStyle(bar);
      const gap = parseFloat(cs.columnGap) || 0;
      const inner = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      const needed = parts.reduce((sum, p) => sum + p!.offsetWidth, 0) + gap * (parts.length - 1);
      setTopbarStacked(needed > inner);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    for (const p of parts) ro.observe(p!);
    return () => ro.disconnect();
  }, [headerMounted]);
  const [logoCfg, setLogoCfg] = useState<{
    bg: string;
    file: string | null;
    animation: LogoAnimation;
    glowColor: string;
    requirePin: boolean;
  }>({
    bg: '#000000',
    file: null,
    animation: 'pulse',
    glowColor: '#FFFFFF',
    requirePin: false,
  });

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await loadConfig();
        setLogoCfg({
          bg: cfg.logoScreenBgColor ?? '#000000',
          file: cfg.logoScreenLogoFile ?? null,
          animation: cfg.logoScreenAnimation ?? 'pulse',
          glowColor: cfg.logoScreenGlowColor ?? '#FFFFFF',
          requirePin: Boolean(cfg.requirePinToExitLogo),
        });
        setLogoPhase(cfg.logoScreenOnLaunch ? 'show' : 'done');
      } catch {
        setLogoPhase('done');
      }
    })();
  }, []);

  // Manual logo-screen trigger (nav button). Re-reads config so a logo or
  // background colour changed in Settings this session is reflected without
  // a restart. The screen itself dismisses on any tap/click/keypress.
  const showLogoScreen = async () => {
    try {
      const cfg = await loadConfig();
      setLogoCfg({
        bg: cfg.logoScreenBgColor ?? '#000000',
        file: cfg.logoScreenLogoFile ?? null,
        animation: cfg.logoScreenAnimation ?? 'pulse',
        glowColor: cfg.logoScreenGlowColor ?? '#FFFFFF',
        requirePin: Boolean(cfg.requirePinToExitLogo),
      });
    } catch {
      /* keep whatever config was loaded at startup */
    }
    setLogoPhase('show');
  };

  // Launch-time update check. Fires first and runs non-blocking: the app
  // renders and the orchestrator starts as usual while this resolves. A
  // hard-floor violation drops in a full-screen blocking overlay and stops
  // content sync; an optional update shows a dismissable banner. An offline
  // or errored check resolves silently and the app proceeds.
  useEffect(() => {
    let lastState: string | null = null;
    const runCheck = async () => {
      const status = await checkForUpdate();
      lastState = status.state;
      if (status.state === 'required') {
        updateGateRef.current = true;
        setUpdateGate(status);
        stopSync();
      } else if (status.state === 'optional') {
        setOptionalUpdate(status);
      }
    };
    void runCheck();
    // The installer cache: drop what's no newer than this build, and the
    // updater's leftovers in %TEMP%.
    void pruneUpdateCache();
    // Offline, the boot check can't reach the studio and the mother route
    // isn't up yet: check again (against the mother) once it is.
    return onLaunchedGamesRouteChange((route) => {
      if (route === 'mother' && lastState === 'error') void runCheck();
    });
  }, []);

  // Start the orchestrator once we have an authenticated user. Stop on
  // logout / unmount. The CAS migration + orphan-blob sweep run first, before
  // any sync cycle, so no in-flight session can reference a blob we remove and
  // every scenario resolves through the new content-addressed pool.
  useEffect(() => {
    if (!auth.user || startedRef.current || updateGateRef.current) return;
    startedRef.current = true;

    let offProgress: (() => void) | null = null;
    let offFinished: (() => void) | null = null;

    const init = async () => {
      try {
        // One-shot: convert any legacy v{version}/ scenario dirs into the blob
        // pool (local, network-free). No-op once done / on fresh installs.
        await migrateToCasIfNeeded();
      } catch (e) {
        console.error('[App] migrateToCasIfNeeded failed:', e);
      }
      try {
        // Mark-and-sweep the blob pool: delete blobs no active manifest
        // references. Replaces pruneStaleVersions in the CAS model.
        await pruneOrphanBlobs();
      } catch (e) {
        console.error('[App] pruneOrphanBlobs failed:', e);
      }
      try {
        // One-shot post-Unit-4 cleanup: removes any media/cards/v*.csv files
        // left over from the pre-row-based card storage. No-op on fresh
        // installs and idempotent on subsequent boots.
        await pruneStaleCardsCsv();
      } catch (e) {
        console.error('[App] pruneStaleCardsCsv failed:', e);
      }

      const downloaded = await scenarioStore.count({ downloaded: true });
      firstLaunchPhaseRef.current = downloaded === 0 ? 'pending' : 'done';

      // Only flip the overlay on once the cycle reports non-zero work, so an
      // empty manifest on a fresh install doesn't show "0 of 0" briefly.
      offProgress = onSyncEvent('cycle:progress', (p) => {
        if (firstLaunchPhaseRef.current === 'pending' && p.total > 0) {
          firstLaunchPhaseRef.current = 'shown';
          setFirstLaunchVisible(true);
        }
      });
      offFinished = onSyncEvent('cycle:finished', () => {
        firstLaunchPhaseRef.current = 'done';
        offProgress?.();
        offFinished?.();
      });

      // A hard-floor result may have landed while init() was awaiting; skip
      // the cycle so a too-old client never talks to the changed server API.
      if (updateGateRef.current) return;
      // Later launches never download on their own: the orchestrator checks
      // what is pending and PendingUpdatesPrompt asks first. A first launch
      // (nothing on disk) syncs straight away behind FirstLaunchProgress.
      await startSync(auth.user!, { askFirst: downloaded > 0 });
    };

    void init();

    return () => {
      offProgress?.();
      offFinished?.();
      stopSync();
      startedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.user]);

  // Boot the mother's local axum server once auth is resolved, and install a
  // permanent LAN override so all `launched_games` traffic routes locally
  // instead of to studio. This is what makes the new Devices-modal endpoints
  // (`list_paired_with_status`, push commands, etc.) reachable. Idempotent:
  // re-mounts pick up the running server via `mother_get_server_info`.
  // Slice 5: register the launched_games auto-re-point handler once, so a
  // satellite whose mother dies mid-game transparently follows the promoted
  // mother. Idempotent; no auth needed.
  useEffect(() => {
    installMotherFailover();
    installLanReauth();
  }, []);

  // LAN content sync: pull newer scenarios/catalogs from the mother whenever its
  // content revision moves (offline venue). See services/peerContent.
  useEffect(() => installPeerContentSync(), []);

  // Who hosts the games (services/hostingRole.ts). One pass at boot, then a
  // tick: the device set as the mother starts serving by itself; a substitute
  // hands back when the mother returns; a device that is not hosting exchanges
  // game copies with the mother (the newer one wins). Nothing here depends on
  // which PC was switched on first.
  //
  // A pure satellite runs NO server; childControlLink's periodic refresh points
  // its launched_games traffic at the mother once one is reachable.
  useEffect(() => {
    const clientId = auth.user?.client_id;
    if (clientId == null) return;
    let cancelled = false;
    // Prefer the operator's custom device name (Settings → Devices) so other
    // devices see it by name over mDNS instead of a generic "Windows device".
    const label = async () =>
      (await getCachedDeviceDisplayName().catch(() => null)) ||
      (await getDeviceMetadata().catch(() => null))?.device_label ||
      undefined;
    // Every 20 s - but every 5 s during the 2 min after this device promoted
    // itself, so two satellites promoted in the same second (equal epochs, see
    // `outranks_local_mother`) converge on one host fast (retours sept. #10).
    // Only a serving device acts on the fast ticks.
    let lastFull = 0;
    const tick = async () => {
      const full = Date.now() - lastFull >= 20_000;
      if (!full && msSincePromotion() > 120_000) return;
      if (full) lastFull = Date.now();
      if (!cancelled) await hostingRoleTick(clientId, await label(), full);
    };
    void (async () => {
      // Builds before the role split flagged a device "mother" on every
      // takeover: put the flag back to the install-time choice first.
      await reconcileRoleFlagOnce();
      await tick();
    })();
    const id = setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [auth.user?.client_id]);

  // Open the Windows Firewall (TCP for the server + UDP for mDNS discovery) once
  // per machine on EVERY device - not just mothers. A satellite that can't receive
  // inbound mDNS can't DISCOVER the mother at all, so children need the rule too.
  // Self-gates on a persisted flag + Windows platform (one-time UAC), so it's safe
  // to run unconditionally after auth.
  useEffect(() => {
    if (!auth.user?.client_id) return;
    void ensureFirewallRuleOnce();
  }, [auth.user?.client_id]);

  // Keep the mother's mDNS announcement live. A mother that started before its
  // PC got a LAN address (Wi-Fi not joined yet) advertises nothing; this cheap
  // poll re-registers the moment an address exists (the Rust command no-ops when
  // this device isn't a mother, has no address yet, or is already advertising -
  // no churn).
  useEffect(() => {
    if (!auth.user?.client_id) return;
    const tick = () => {
      void invoke('mother_ensure_mdns_live').catch(() => {});
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, [auth.user?.client_id]);

  // Keep the active-launched-games count fresh for the nav badge. Re-runs on
  // navigation (so the badge updates the moment the operator ends a game and
  // leaves the page) and polls every 10s to reflect games launched/ended on
  // other LAN devices. Best-effort: a failed fetch leaves the last count.
  useEffect(() => {
    if (!auth.user) {
      setActiveGameCount(0);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const active = await listLaunchedGames({ ended: false });
        if (!cancelled) setActiveGameCount(active.filter((g) => !g.is_test).length);
      } catch {
        /* keep last known count */
      }
    };
    void refresh();
    const h = setInterval(() => void refresh(), 10000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [auth.user, currentPage]);

  // Keep `launched_games` pointed at the mother for a CHILD device, so the
  // launched-games page and the nav badge list & operate the mother's active
  // games even when this device hasn't joined one. No-op for a mother host /
  // standalone device (routes stay local). Cheap: cache-based resolve, with a
  // one-off mDNS warm only when a mother is paired but not yet discovered.
  // Retries on an interval so a mother that appears after this device booted is
  // picked up, and a transient drop recovers.
  useEffect(() => {
    if (!auth.user) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        await refreshLaunchedGamesRoute();
      } catch {
        /* best-effort; retried on the next tick */
      }
    };
    void tick();
    const h = setInterval(() => void tick(), 15000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [auth.user]);

  // App-level listener for auth_invalid. SyncFailureBanner also handles this
  // (it calls onAuthInvalid → auth.refresh), but the banner isn't mounted
  // while the FirstLaunchProgress overlay is showing - so a first-launch
  // cycle that hits 401/403 has nobody to ask AuthProvider for a refresh.
  // Subscribing here makes auth.refresh fire regardless of which overlay
  // is up. AuthProvider then either re-validates the JWT silently or flips
  // to LoginScreen, which transparently replaces whatever was rendered.
  useEffect(() => {
    const off = onSyncEvent('cycle:failed', (p) => {
      if (p.reason === 'auth_invalid') {
        void auth.refresh();
      }
    });
    return off;
  }, [auth]);

  const dismissFirstLaunch = () => {
    firstLaunchPhaseRef.current = 'done';
    setFirstLaunchVisible(false);
  };

  // Telemetry bootstrap. Runs once per mount:
  //   1. Recover any Rust panic from the previous session (and enqueue it).
  //   2. Enqueue a heartbeat - no-op if app_version hasn't changed since last.
  //   3. Start the periodic drainer (5 min). The drainer politely waits for
  //      a JWT, so starting it before login is fine.
  // None of this gates on auth; events sit in the outbox until reachable.
  useEffect(() => {
    void recoverPendingPanic();
    void sendHeartbeat();
    startDrainer();
    // Game-summary stats: auto-end stale games + push per-game played-stats to
    // studio on boot and every 5 min. Mother-gated and best-effort, so safe to
    // start before the mother is up / before login.
    startSummarySync();
    // Fire-and-forget mDNS browse so the footer's first child-mode ping has a
    // hot endpoint cache. No-op when paired_mothers is empty. Failure is
    // silent: the footer's failure-threshold path will run mDNS again if
    // needed.
    void invoke('client_refresh_mother_endpoints').catch(() => {});
    return () => {
      stopDrainer();
      stopSummarySync();
    };
  }, []);

  const handleAdminSuccess = () => setIsAdminMode(true);

  // Leave admin mode (via the AME keystroke or the topbar button). Bounce off
  // any admin-only page so the user doesn't sit on a now-forbidden screen, and
  // clear the held-keys tracker so a stuck key can't re-trigger anything.
  const exitAdminMode = useCallback(() => {
    setIsAdminMode(false);
    setPressedKeys(new Set());
    processedRef.current = false;
    setCurrentPage((p) => (p === 'admin-config' || p === 'database' ? 'scenarios' : p));
  }, []);

  // AMO/AME admin keystroke handlers. `blur` clears the held-keys set so a
  // missed keyup (combo stolen by the OS/webview) can't leave keys "stuck",
  // which would otherwise wedge `processedRef` and block AME forever.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Autofill/autocomplete selections dispatch synthetic key events with no
      // `key` - guard so they can't crash the handler.
      if (!e.key) return;
      setPressedKeys((prev) => new Set(prev).add(e.key.toLowerCase()));
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (!e.key) return;
      setPressedKeys((prev) => {
        const next = new Set(prev);
        next.delete(e.key.toLowerCase());
        return next;
      });
    };
    const clearKeys = () => setPressedKeys(new Set());
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', clearKeys);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', clearKeys);
    };
  }, []);

  useEffect(() => {
    const hasAMO = pressedKeys.has('a') && pressedKeys.has('m') && pressedKeys.has('o');
    const hasAME = pressedKeys.has('a') && pressedKeys.has('m') && pressedKeys.has('e');

    if (hasAMO && !isAdminMode && !processedRef.current) {
      processedRef.current = true;
      setPressedKeys(new Set());
      setShowPasswordModal(true);
    } else if (hasAME && isAdminMode && !processedRef.current) {
      processedRef.current = true;
      exitAdminMode();
    } else if (!hasAMO && !hasAME) {
      processedRef.current = false;
    }
  }, [pressedKeys, isAdminMode, exitAdminMode]);

  // Hard floor takes precedence over everything, including first-launch sync:
  // a too-old client must update before it does anything else.
  if (updateGate) {
    return <UpdateRequiredOverlay status={updateGate} />;
  }

  if (firstLaunchVisible) {
    return (
      <FirstLaunchProgress
        onSkip={dismissFirstLaunch}
        onDone={dismissFirstLaunch}
      />
    );
  }

  // Last gate before the home page. While config.json is still being read,
  // render a neutral backdrop so the home page never flashes before the
  // logo screen has a chance to appear.
  if (logoPhase === 'loading') {
    return <div className="min-h-screen bg-slate-900" />;
  }
  if (logoPhase === 'show') {
    return (
      <LogoLaunchScreen
        bgColor={logoCfg.bg}
        logoFile={logoCfg.file}
        animation={logoCfg.animation}
        glowColor={logoCfg.glowColor}
        requirePin={logoCfg.requirePin}
        onDismiss={() => setLogoPhase('done')}
      />
    );
  }

  return (
    <HelpProvider
      audience="operator"
      assetBase=""
      lang={i18n.language}
      // Playground has no in-app docs page (unlike studio): both "read more"
      // and the PDF button open the bundled PDF in its webview window.
      navigateToDocs={() => {
        if (helpManifest.pdf) void playgroundOpenPdf(helpManifest.pdf);
      }}
      openPdfFile={(pdf) => void playgroundOpenPdf(pdf)}
    >
    <div
      className={`min-h-screen flex flex-col ${
        isAdminMode
          ? 'bg-gradient-to-br from-red-900 via-red-800 to-slate-900'
          : 'pg-app-bg'
      }`}
    >
      {optionalUpdate && (
        <UpdateAvailableNotice
          status={optionalUpdate}
          onDismiss={() => setOptionalUpdate(null)}
          onOpenUpdates={navigateToUpdates}
        />
      )}

      {pinResetNotice && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-200">
          <div className="container mx-auto px-6 py-2 flex items-center justify-between gap-4 text-sm">
            <span>{t('pinResetBanner')}</span>
            <div className="flex items-center gap-3 shrink-0">
              <button
                onClick={navigateToSecurity}
                className="px-3 py-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 font-medium transition-colors"
              >
                {t('setNewPin')}
              </button>
              <button
                onClick={() => setPinResetNotice(false)}
                className="text-amber-300/80 hover:text-amber-100"
                aria-label={t('dismiss')}
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      <SyncFailureBanner onAuthInvalid={auth.refresh} onViewDetails={navigateToSync} />

      <header
        ref={topbarRef}
        className={`pg-topbar sticky top-0 z-40${topbarStacked ? ' pg-topbar--stacked' : ''}`}
      >
        <div className="pg-brand" ref={brandRef}>
          <span className="pg-brand-mark">
            <img src="/icon.png" alt="" className="pg-brand-logo" />
          </span>
          <span className="pg-brand-name">
            TAG HUNTER <span>Playground</span>
          </span>
          {auth.user?.update_channel === 'test' && (
            <span className="pg-test-badge" title={t('nav:testChannelHint')}>
              <FlaskConical size={12} />
              {t('nav:testChannelBadge')}
            </span>
          )}
        </div>

        <nav className="pg-nav" ref={navRef}>
          <NavButton page="scenarios" current={currentPage} onClick={setCurrentPage}>
            <Map size={14} />
            {t('nav:scenarios')}
          </NavButton>
          <NavButton page="launched" current={currentPage} onClick={setCurrentPage} badge={activeGameCount}>
            <Rocket size={14} />
            {t('nav:launchedGames')}
          </NavButton>
          {isAdminMode && (
            <>
              <NavButton page="database" current={currentPage} onClick={setCurrentPage}>
                <DatabaseIcon size={14} />
                {t('nav:database')}
              </NavButton>
              <NavButton page="admin-config" current={currentPage} onClick={setCurrentPage}>
                <ShieldCheck size={14} />
                {t('nav:adminConfig')}
              </NavButton>
              <button type="button" onClick={exitAdminMode} className="pg-nav-item pg-nav-item--exit-admin">
                <ShieldOff size={14} />
                {t('nav:exitAdmin')}
              </button>
            </>
          )}
        </nav>

        {/* Utilities - icon-only, always one click away during a session.
            Settings highlights when its page is open; "Logo screen" raises the
            branded screen and "Lock" raises the PIN overlay (both keep the app
            running underneath). */}
        <div className="pg-utils" ref={utilsRef}>
          <button
            onClick={() => setCurrentPage('settings')}
            className={`pg-icon-btn${currentPage === 'settings' ? ' is-active pg-icon-btn--lock' : ' pg-icon-btn--muted'}`}
            aria-label={t('nav:settings')}
            title={t('nav:settings')}
          >
            <Settings size={16} />
          </button>
          {helpManifest.pdf && (
            <button
              onClick={() => void playgroundOpenPdf(helpManifest.pdf!)}
              className="pg-icon-btn pg-icon-btn--muted"
              aria-label={t('nav:help')}
              title={t('nav:help')}
            >
              <HelpCircle size={16} />
            </button>
          )}
          <button
            onClick={() => void showLogoScreen()}
            className="pg-icon-btn"
            aria-label={t('nav:logoScreen')}
            title={t('nav:logoScreen')}
          >
            <ImageIcon size={16} />
          </button>
          <button
            onClick={auth.lock}
            className="pg-icon-btn pg-icon-btn--lock"
            aria-label={t('nav:lock')}
            title={t('nav:lock')}
          >
            <Lock size={16} />
          </button>
          <button
            onClick={() => setShowFleet(true)}
            className="pg-icon-btn"
            aria-label={t('nav:devices')}
            title={t('nav:devices')}
          >
            <MonitorSmartphone size={16} />
          </button>
          {/* LAN-role + reader status icons, separated from the action buttons.
              Also hosts the app-wide reader-presence poll - see TopbarStatus. */}
          <TopbarStatus />
        </div>
      </header>

      {currentPage === 'scenarios' && <GameList onShowLaunchedGames={() => setCurrentPage('launched')} />}
      {currentPage === 'launched' && <LaunchedGamesList isAdminMode={isAdminMode} />}
      {currentPage === 'settings' && <ConfigurationPage initialTab={pendingSettingsTab} isAdminMode={isAdminMode} />}
      {currentPage === 'database' && isAdminMode && <DatabaseInspector />}
      {currentPage === 'admin-config' && isAdminMode && <AdminConfigPage />}

      {/* Version + device name at the very bottom of the page flow (the app
          container is a flex column, so mt-auto pins it to the viewport bottom
          on short pages). */}
      <DeviceIdentityLine />

      <AdminPasswordModal
        isOpen={showPasswordModal}
        onClose={() => setShowPasswordModal(false)}
        onSuccess={handleAdminSuccess}
      />

      {showFleet && (
        <DevicesFleetModal
          onClose={() => setShowFleet(false)}
          onLockSelf={() => {
            setShowFleet(false);
            auth.lock();
          }}
          onShowLogoSelf={() => {
            setShowFleet(false);
            void showLogoScreen();
          }}
        />
      )}

      <SyncStatusPill onNavigate={navigateToSync} />
      <PendingUpdatesPrompt />
      <OperatorVideoOverlay />
      <MotherFailoverBanner />
      <HotspotRemovedNotice />
      <RegainControlPrompt clientId={auth.user?.client_id ?? null} />

      {pushedRanking && (
        pushedRanking.mode === 'scenario' ? (
          <TimeRangeLeaderboard
            scenario={{ uniqid: pushedRanking.scenarioUniqid, title: pushedRanking.scenarioTitle }}
            timeRange={pushedRanking.timeRange}
            onBack={() => setPushedRanking(null)}
          />
        ) : (
          <LeaderboardPage
            launchedGameId={pushedRanking.launchedGameId}
            config={pushedRanking.config}
            gameName={pushedRanking.gameName}
            autoScroll={pushedRanking.autoScroll !== false}
            onBack={() => setPushedRanking(null)}
          />
        )
      )}

      {pushedTeamSummary && (
        <TeamSummaryOverlay
          snapshot={pushedTeamSummary}
          onBack={() => setPushedTeamSummary(null)}
        />
      )}
    </div>
    </HelpProvider>
  );
}

interface NavButtonProps {
  page: Page;
  current: Page;
  onClick: (p: Page) => void;
  children: React.ReactNode;
  /** When > 0, renders a count badge (e.g. number of active launched games). */
  badge?: number;
}

function NavButton({ page, current, onClick, children, badge = 0 }: NavButtonProps) {
  const active = current === page;
  return (
    <button
      onClick={() => onClick(page)}
      className={`pg-nav-item${active ? ' is-active' : ''}`}
    >
      {children}
      {badge > 0 && (
        <span className="pg-nav-badge" title={`${badge} active`}>
          {badge}
        </span>
      )}
    </button>
  );
}

export default App;
