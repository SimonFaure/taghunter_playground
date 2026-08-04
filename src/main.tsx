import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App.tsx';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { FullscreenHint } from './components/FullscreenHint';
import { captureError } from './services/telemetry';
import { loadConfig } from './utils/config';
import { LeaderboardPage } from './components/LeaderboardPage';
import { TimeRangeLeaderboard } from './components/TimeRangeLeaderboard';
import { readProjectorTargetFromUrl } from './services/projectorWindow';
import type { RankingTarget } from './services/rankingTarget';
import { attachToRunningMotherServer } from './services/lanMotherBoot';
import { refreshLaunchedGamesRoute } from './services/childControlLink';
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
// __lanHotspotTest, __wifiIndicatorTest, __seedRecoveryCodes). Loaded in dev
// AND in Tester-channel builds (which run the production Vite build with the
// Rust `devtools` feature - the build script sets VITE_QA_HARNESS=1), but
// tree-shaken out of stable bundles: __lanHotspotTest can bounce a live AP,
// and the smoke tests mutate the production LAN override.
if (import.meta.env.DEV || import.meta.env.VITE_QA_HARNESS === '1') {
  void import('./services/lanSmokeTest');
  void import('./services/failoverSmokeTest');
  void import('./services/lanHotspotTest');
  void import('./services/wifiIndicatorTest');
  void import('./services/recoveryCodesDevTest');
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
  useEffect(() => {
    if (!clientId) return;
    void (async () => {
      const attached = await attachToRunningMotherServer();
      if (!attached) await refreshLaunchedGamesRoute().catch(() => {});
    })();
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

// Apply the `fullscreenOnLaunch` preference before the app renders so the
// LoginScreen comes up fullscreen too. Fire-and-forget: the config read is
// a fast local file, and a sub-100ms windowed flash is acceptable for a
// once-per-session kiosk launch. Skipped for the audience-facing projector
// window, which manages its own sizing.
if (!projectorTarget) {
  void (async () => {
    try {
      const cfg = await loadConfig();
      if (cfg.fullscreenOnLaunch) {
        await getCurrentWindow().setFullscreen(true);
      }
    } catch (err) {
      console.error('[main] fullscreen-on-launch failed:', err);
    }
  })();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      {projectorTarget ? <ProjectorRoot target={projectorTarget} /> : <App />}
    </AuthProvider>
    {!projectorTarget && <FullscreenHint />}
  </StrictMode>
);
