import { StrictMode, Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App.tsx';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { FullscreenHint } from './components/FullscreenHint';
import { SoundMuteNotice } from './components/SoundMuteNotice';
import { installSoundMute } from './utils/soundMute';
import { installLanCommandBus } from './services/lanCommands';
import { captureError } from './services/telemetry';
import { installConsoleBuffer } from './services/consoleBuffer';
import { loadConfig } from './utils/config';
import { syncAutostart } from './utils/autostart';
import { LeaderboardPage } from './components/LeaderboardPage';
import { TimeRangeLeaderboard } from './components/TimeRangeLeaderboard';
import { readProjectorTargetFromUrl } from './services/projectorWindow';
import type { RankingTarget } from './services/rankingTarget';
import { attachToRunningMotherServer } from './services/lanMotherBoot';
import { refreshLaunchedGamesRoute, installLanReauth } from './services/childControlLink';
import { installMotherFailover } from './services/motherFailover';
import './index.css';
// Apply the saved colour theme (tactical red default / blue) synchronously,
// before the app renders, so a blue-theme device doesn't flash red on boot.
import { initTheme } from './services/theme';
initTheme();
// Initialize i18next (chrome translations) before the app renders.
import './i18n';
// Strip the stale leading zero from every <input type="number"> as the user
// types (e.g. "05" → "5") - one capture-phase listener covers all fields.
import { installNumberInputLeadingZeroFix } from './utils/numberInputLeadingZeros';
installNumberInputLeadingZeroFix();
import { registerCatalogFonts } from './fonts/registerCatalogFonts';
// DevTools QA harnesses (window.__lanSmokeTest, __failoverSmokeTest,
// __wifiIndicatorTest, __seedRecoveryCodes, __contentSyncSmokeTest). Loaded in dev
// AND in Tester-channel builds (which run the production Vite build with the
// Rust `devtools` feature - the build script sets VITE_QA_HARNESS=1), but
// tree-shaken out of stable bundles: the smoke tests mutate the production
// LAN override.
if (import.meta.env.DEV || import.meta.env.VITE_QA_HARNESS === '1') {
  void import('./services/lanSmokeTest');
  void import('./services/failoverSmokeTest');
  void import('./services/wifiIndicatorTest');
  void import('./services/recoveryCodesDevTest');
  void import('./services/contentSyncSmokeTest');
}

// Game simulator (tester builds only - same inline guard as above so the
// stable build drops these chunks). `?simulator=<launchedGameId>` is the
// control window; every other window follows the simulated game clock, and
// the main window hosts the executor that injects the card reads.
const simulatorGameId =
  import.meta.env.DEV || import.meta.env.VITE_QA_HARNESS === '1'
    ? Number(new URLSearchParams(window.location.search).get('simulator')) || null
    : null;
const SimulatorWindow =
  import.meta.env.DEV || import.meta.env.VITE_QA_HARNESS === '1'
    ? lazy(() => import('./simulator/SimulatorWindow').then((m) => ({ default: m.SimulatorWindow })))
    : null;
if ((import.meta.env.DEV || import.meta.env.VITE_QA_HARNESS === '1') && !simulatorGameId) {
  void import('./simulator/executor').then((m) => {
    m.installSimClockFollower();
    if (!new URLSearchParams(window.location.search).get('projector')) {
      m.installSimulatorHost();
      // Campaigns + the local control API (Claude Desktop) live next to the executor.
      void import('./simulator/controlApi').then((c) => c.installControlApi());
    }
  });
}

// Projector-window wrapper: this is what the secondary Tauri WebviewWindow
// mounts when launched with `?projector=1`. AuthProvider still wraps so the
// projector inherits the operator's SQLite-backed session - but we don't
// want to render the LoginScreen here (the projector is audience-facing).
// While auth is loading or absent, render a neutral placeholder.
function ProjectorRoot({ target }: { target: RankingTarget }) {
  const auth = useAuth();
  const clientId = auth.user?.client_id;

  // The projector is a separate WebviewWindow with its own JS context, so the
  // LAN override installed by <App> in the main window does NOT carry over here.
  // Without it, every launched_games request (the leaderboard's state + meta
  // poll) fails closed. Pickup-only on purpose: on the mother we attach to the
  // already-running server (process-global Tauri state, shared across windows);
  // on a satellite we resolve the paired mother's route instead. The projector
  // must never START a server - the old unconditional ensureMotherServer could
  // mint a competing mother on a satellite when the boot fence's browse errored.
  //
  // Retours sept. #18: on a satellite, the projector must also FOLLOW the mother
  // through a failover, like the main window does - it used to resolve its route
  // once and keep showing the old mother's game. Same failover handlers, same
  // 15 s route refresh (both idempotent, per window).
  useEffect(() => {
    if (!clientId) return;
    let id: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    void (async () => {
      const attached = await attachToRunningMotherServer();
      if (attached || cancelled) return;
      installMotherFailover();
      installLanReauth();
      await refreshLaunchedGamesRoute().catch(() => {});
      if (cancelled) return;
      id = setInterval(() => void refreshLaunchedGamesRoute().catch(() => {}), 15_000);
    })();
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [clientId]);

  if (!auth.user) {
    return (
      <div className="fixed inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900" />
    );
  }
  if (target.mode === 'scenario') {
    return (
      <TimeRangeLeaderboard
        projectorMode
        scenario={{ uniqid: target.scenarioUniqid, title: target.scenarioTitle }}
        timeRange={target.timeRange}
        onBack={() => { /* no-op in projector mode */ }}
      />
    );
  }
  return (
    <LeaderboardPage
      projectorMode
      launchedGameId={target.launchedGameId}
      config={target.config}
      gameName={target.gameName}
      autoScroll={target.autoScroll !== false}
      onBack={() => { /* no-op in projector mode */ }}
    />
  );
}

// Keep the last console warnings/errors in memory for bug reports.
installConsoleBuffer();

// Global error capture for the telemetry outbox. Registered as early as
// possible so we catch failures inside the React mount itself. Both handlers
// are fire-and-forget; captureError swallows its own failures.
window.addEventListener('error', (e) => {
  void captureError(e.error ?? e.message ?? 'window.error', { source: 'window.error' });
});
window.addEventListener('unhandledrejection', (e) => {
  void captureError(e.reason ?? 'unhandledrejection', { source: 'unhandledrejection' });
});

// Make the bundled curated fonts available so scenarios that select one
// render it even fully offline.
registerCatalogFonts();

const projectorTarget = readProjectorTargetFromUrl();

// Ctrl+M mutes every sound in the app. Only the main window resets the mute at
// boot; the projector/simulator windows pick up the current state.
installSoundMute({ resetOnBoot: !projectorTarget && !simulatorGameId });

// The mother's pushed commands: one dispatcher, main window only (every webview
// receives the event; a second one would answer for the projector).
if (!projectorTarget && !simulatorGameId) installLanCommandBus();

// Apply the `fullscreenOnLaunch` preference before the app renders so the
// LoginScreen comes up fullscreen too. Fire-and-forget: the config read is
// a fast local file, and a sub-100ms windowed flash is acceptable for a
// once-per-session kiosk launch. Skipped for the audience-facing projector
// window, which manages its own sizing.
if (!projectorTarget && !simulatorGameId) {
  void (async () => {
    try {
      const cfg = await loadConfig();
      if (cfg.fullscreenOnLaunch) {
        await getCurrentWindow().setFullscreen(true);
      }
      // Re-assert the launch-on-boot registration against the saved
      // preference (a reinstall wipes the Run value; see utils/autostart.ts).
      // This also re-points it at the current exe path.
      await syncAutostart(Boolean(cfg.autoLaunch));
    } catch (err) {
      console.error('[main] fullscreen-on-launch failed:', err);
    }
  })();
}

createRoot(document.getElementById('root')!).render(
  simulatorGameId && SimulatorWindow ? (
    <StrictMode>
      <Suspense fallback={null}>
        <SimulatorWindow launchedGameId={simulatorGameId} />
      </Suspense>
    </StrictMode>
  ) : (
    <StrictMode>
      <AuthProvider>
        {projectorTarget ? <ProjectorRoot target={projectorTarget} /> : <App />}
      </AuthProvider>
      {!projectorTarget && <FullscreenHint />}
      <SoundMuteNotice />
    </StrictMode>
  )
);
