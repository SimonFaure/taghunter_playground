import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App.tsx';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { FullscreenHint } from './components/FullscreenHint';
import { captureError } from './services/telemetry';
import { loadConfig } from './utils/config';
import { LeaderboardPage } from './components/LeaderboardPage';
import { readProjectorParamsFromUrl, type ProjectorPayload } from './services/projectorWindow';
import './index.css';
import { registerCatalogFonts } from './fonts/registerCatalogFonts';
// Slice A/B LAN-mode smoke test: side-effect import registers
// `window.__lanSmokeTest` for DevTools-based verification.
import './services/lanSmokeTest';
// Slice C hotspot manual test: registers `window.__lanHotspotTest`. Kept
// separate from the auto smoke test because it briefly drops Wi-Fi clients.
import './services/lanHotspotTest';
// Footer wifi indicator manual test: registers `window.__wifiIndicatorTest`.
import './services/wifiIndicatorTest';

// Projector-window wrapper: this is what the secondary Tauri WebviewWindow
// mounts when launched with `?projector=1`. AuthProvider still wraps so the
// projector inherits the operator's SQLite-backed session — but we don't
// want to render the LoginScreen here (the projector is audience-facing).
// While auth is loading or absent, render a neutral placeholder.
function ProjectorRoot({ params }: { params: ProjectorPayload }) {
  const auth = useAuth();
  if (!auth.user) {
    return (
      <div className="fixed inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900" />
    );
  }
  return (
    <LeaderboardPage
      projectorMode
      launchedGameId={params.launchedGameId}
      config={params.config}
      gameName={params.gameName}
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

const projectorParams = readProjectorParamsFromUrl();

// Apply the `fullscreenOnLaunch` preference before the app renders so the
// LoginScreen comes up fullscreen too. Fire-and-forget: the config read is
// a fast local file, and a sub-100ms windowed flash is acceptable for a
// once-per-session kiosk launch. Skipped for the audience-facing projector
// window, which manages its own sizing.
if (!projectorParams) {
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
      {projectorParams ? <ProjectorRoot params={projectorParams} /> : <App />}
    </AuthProvider>
    {!projectorParams && <FullscreenHint />}
  </StrictMode>
);
