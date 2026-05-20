import { useState, useEffect, useRef } from 'react';
import {
  Settings,
  ShieldCheck,
  CreditCard,
  Map,
  Rocket,
  Database as DatabaseIcon,
  Lock,
  Image as ImageIcon,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { GameList } from './components/GameList';
import { Footer } from './components/Footer';
import { ConfigurationPage, type SettingsTab } from './components/ConfigurationPage';
import { AdminPasswordModal } from './components/AdminPasswordModal';
import { AdminConfigPage } from './components/AdminConfigPage';
import { LaunchedGamesList } from './components/LaunchedGamesList';
import ClientCardsPage from './components/ClientCardsPage';
import { DatabaseInspector } from './components/DatabaseInspector';
import { FirstLaunchProgress } from './components/sync/FirstLaunchProgress';
import { LogoLaunchScreen } from './components/LogoLaunchScreen';
import { SyncStatusPill } from './components/sync/SyncStatusPill';
import { SyncFailureBanner } from './components/sync/SyncFailureBanner';
import { UpdateRequiredOverlay } from './components/update/UpdateRequiredOverlay';
import { UpdateAvailableNotice } from './components/update/UpdateAvailableNotice';
import { useAuth } from './components/auth/AuthProvider';
import { start as startSync, stop as stopSync } from './services/syncOrchestrator';
import { checkForUpdate, type UpdateStatus } from './services/updateService';
// Import for side effects: syncLog wires its event listeners on first
// module load, so it must be referenced before any cycle:* events fire (or
// it'll miss them when the user isn't on the Settings → Sync tab).
import './services/syncLog';
import { pruneStaleVersions, pruneStaleCardsCsv } from './services/contentFs';
import * as scenarioStore from './services/scenarioStore';
import { on as onSyncEvent } from './services/syncEvents';
import {
  recoverPendingPanic,
  sendHeartbeat,
  startDrainer,
  stopDrainer,
} from './services/telemetry';
import { loadConfig } from './utils/config';

type Page =
  | 'scenarios'
  | 'launched'
  | 'cards'
  | 'settings'
  | 'admin-config'
  | 'database';

function App() {
  const auth = useAuth();
  const [currentPage, setCurrentPage] = useState<Page>('scenarios');
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());
  // Deep-link target for the settings page. Set by the sync pill / failure
  // banner when the user clicks them; consumed by ConfigurationPage which
  // honors it once and is then free to track its own tab state.
  const [pendingSettingsTab, setPendingSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const processedRef = useRef<boolean>(false);
  const startedRef = useRef<boolean>(false);

  // App self-update state. `updateGate` is set when the running version is
  // below the server's hard floor — it blocks the whole app. `optionalUpdate`
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

  // Single entry point for "take me to the sync screen" — invoked by both
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
  // the last gate before the home page — after the update and first-launch
  // gates. Dismissed by any click/tap/keypress.
  const [logoPhase, setLogoPhase] = useState<'loading' | 'show' | 'done'>('loading');
  const [logoCfg, setLogoCfg] = useState<{ bg: string; file: string | null }>({
    bg: '#000000',
    file: null,
  });

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await loadConfig();
        setLogoCfg({
          bg: cfg.logoScreenBgColor ?? '#000000',
          file: cfg.logoScreenLogoFile ?? null,
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
    void (async () => {
      const status = await checkForUpdate();
      if (status.state === 'required') {
        updateGateRef.current = true;
        setUpdateGate(status);
        stopSync();
      } else if (status.state === 'optional') {
        setOptionalUpdate(status);
      }
    })();
  }, []);

  // Start the orchestrator once we have an authenticated user. Stop on
  // logout / unmount. pruneStaleVersions runs first so no in-flight session
  // can reference a stale dir.
  useEffect(() => {
    if (!auth.user || startedRef.current || updateGateRef.current) return;
    startedRef.current = true;

    let offProgress: (() => void) | null = null;
    let offFinished: (() => void) | null = null;

    const init = async () => {
      try {
        await pruneStaleVersions();
      } catch (e) {
        console.error('[App] pruneStaleVersions failed:', e);
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
      await startSync(auth.user!);
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

  // App-level listener for auth_invalid. SyncFailureBanner also handles this
  // (it calls onAuthInvalid → auth.refresh), but the banner isn't mounted
  // while the FirstLaunchProgress overlay is showing — so a first-launch
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
  //   2. Enqueue a heartbeat — no-op if app_version hasn't changed since last.
  //   3. Start the periodic drainer (5 min). The drainer politely waits for
  //      a JWT, so starting it before login is fine.
  // None of this gates on auth; events sit in the outbox until reachable.
  useEffect(() => {
    void recoverPendingPanic();
    void sendHeartbeat();
    startDrainer();
    // Fire-and-forget mDNS browse so the footer's first child-mode ping has a
    // hot endpoint cache. No-op when paired_mothers is empty. Failure is
    // silent: the footer's failure-threshold path will run mDNS again if
    // needed.
    void invoke('client_refresh_mother_endpoints').catch(() => {});
    return () => {
      stopDrainer();
    };
  }, []);

  // AMO/AME admin keystroke handlers (unchanged from pre-rewrite).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      setPressedKeys((prev) => new Set(prev).add(e.key.toLowerCase()));
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      setPressedKeys((prev) => {
        const next = new Set(prev);
        next.delete(e.key.toLowerCase());
        return next;
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
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
      setPressedKeys(new Set());
      setIsAdminMode(false);
      if (currentPage === 'admin-config' || currentPage === 'database') {
        setCurrentPage('scenarios');
      }
    } else if (!hasAMO && !hasAME) {
      processedRef.current = false;
    }
  }, [pressedKeys, isAdminMode, currentPage]);

  const handleAdminSuccess = () => setIsAdminMode(true);

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
        onDismiss={() => setLogoPhase('done')}
      />
    );
  }

  return (
    <div
      className={`min-h-screen pb-16 ${
        isAdminMode
          ? 'bg-gradient-to-br from-red-900 via-red-800 to-slate-900'
          : 'bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900'
      }`}
    >
      {optionalUpdate && (
        <UpdateAvailableNotice
          status={optionalUpdate}
          onDismiss={() => setOptionalUpdate(null)}
          onOpenUpdates={navigateToUpdates}
        />
      )}

      <SyncFailureBanner onAuthInvalid={auth.refresh} onViewDetails={navigateToSync} />

      <nav
        className={`backdrop-blur-sm border-b sticky top-0 z-40 ${
          isAdminMode ? 'bg-red-800/80 border-red-700' : 'bg-slate-800/80 border-slate-700'
        }`}
      >
        <div className="container mx-auto px-6 py-3">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-white">Taghunter Playground</h1>
            <div className="flex gap-2">
              <NavButton page="scenarios" current={currentPage} onClick={setCurrentPage} admin={isAdminMode}>
                <Map size={16} />
                Scenarios
              </NavButton>
              <NavButton page="launched" current={currentPage} onClick={setCurrentPage} admin={isAdminMode}>
                <Rocket size={16} />
                Launched games
              </NavButton>
              <NavButton page="cards" current={currentPage} onClick={setCurrentPage} admin={isAdminMode}>
                <CreditCard size={16} />
                Cards & Patterns
              </NavButton>
              <NavButton page="settings" current={currentPage} onClick={setCurrentPage} admin={isAdminMode}>
                <Settings size={16} />
                Settings
              </NavButton>
              {isAdminMode && (
                <>
                  <NavButton page="database" current={currentPage} onClick={setCurrentPage} admin={isAdminMode}>
                    <DatabaseIcon size={16} />
                    Database
                  </NavButton>
                  <NavButton page="admin-config" current={currentPage} onClick={setCurrentPage} admin={isAdminMode}>
                    <ShieldCheck size={16} />
                    Admin Config
                  </NavButton>
                </>
              )}
              {/* Actions, not pages — separated from the page tabs by a
                  divider. "Logo screen" raises the branded screen on demand;
                  "Lock" raises the PIN overlay. Both keep the app running
                  underneath. */}
              <div className="w-px self-stretch bg-white/10 mx-1" />
              <button
                onClick={() => void showLogoScreen()}
                title="Show the logo screen"
                className="px-4 py-2 rounded-lg transition flex items-center gap-2 text-slate-300 hover:bg-slate-700"
              >
                <ImageIcon size={16} />
                Logo screen
              </button>
              <button
                onClick={auth.lock}
                title="Lock the app"
                className="px-4 py-2 rounded-lg transition flex items-center gap-2 text-slate-300 hover:bg-slate-700"
              >
                <Lock size={16} />
                Lock
              </button>
            </div>
          </div>
        </div>
      </nav>

      {currentPage === 'scenarios' && <GameList />}
      {currentPage === 'launched' && <LaunchedGamesList />}
      {currentPage === 'cards' && <ClientCardsPage />}
      {currentPage === 'settings' && <ConfigurationPage initialTab={pendingSettingsTab} />}
      {currentPage === 'database' && isAdminMode && <DatabaseInspector />}
      {currentPage === 'admin-config' && isAdminMode && <AdminConfigPage />}

      <AdminPasswordModal
        isOpen={showPasswordModal}
        onClose={() => setShowPasswordModal(false)}
        onSuccess={handleAdminSuccess}
      />

      <SyncStatusPill onNavigate={navigateToSync} />
      <Footer />
    </div>
  );
}

interface NavButtonProps {
  page: Page;
  current: Page;
  onClick: (p: Page) => void;
  admin: boolean;
  children: React.ReactNode;
}

function NavButton({ page, current, onClick, admin, children }: NavButtonProps) {
  const active = current === page;
  return (
    <button
      onClick={() => onClick(page)}
      className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${
        active
          ? admin
            ? 'bg-red-600 text-white'
            : 'bg-blue-600 text-white'
          : 'text-slate-300 hover:bg-slate-700'
      }`}
    >
      {children}
    </button>
  );
}

export default App;
