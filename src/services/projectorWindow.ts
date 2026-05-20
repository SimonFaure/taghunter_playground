import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, primaryMonitor, type Monitor } from '@tauri-apps/api/window';
import type { GameConfig } from '../components/LaunchGameModal';

const PROJECTOR_LABEL = 'projector';
const PROJECTED_GAME_KEY = 'projector.launchedGameId';

export interface ProjectorPayload {
  launchedGameId: number;
  gameName?: string;
  config: GameConfig;
}

// localStorage is shared between Tauri WebviewWindows on Windows (same WebView2
// user data folder), so the main window can read what the projector window is
// currently showing. Cleared on close (including projector-self-close on Esc).
function setProjectedGameId(id: number | null): void {
  if (id === null) localStorage.removeItem(PROJECTED_GAME_KEY);
  else localStorage.setItem(PROJECTED_GAME_KEY, String(id));
}

function getStoredProjectedGameId(): number | null {
  const raw = localStorage.getItem(PROJECTED_GAME_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Read projector params from the current window's URL. Returns null when the
// `projector` flag is absent, malformed, or missing required fields — caller
// should fall back to the normal app render in that case.
export function readProjectorParamsFromUrl(): ProjectorPayload | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('projector') !== '1') return null;

  const idStr = params.get('launchedGameId');
  const configStr = params.get('config');
  if (!idStr || !configStr) return null;

  const launchedGameId = Number(idStr);
  if (!Number.isFinite(launchedGameId) || launchedGameId <= 0) return null;

  let config: GameConfig;
  try {
    const decoded = atob(configStr);
    config = JSON.parse(decoded);
  } catch {
    return null;
  }

  const gameName = params.get('gameName') ?? undefined;
  return { launchedGameId, gameName, config };
}

async function pickProjectorMonitor(): Promise<{ monitor: Monitor; fullscreen: boolean }> {
  const [monitors, primary] = await Promise.all([
    availableMonitors().catch(() => [] as Monitor[]),
    primaryMonitor().catch(() => null),
  ]);

  if (monitors.length <= 1 || !primary) {
    const fallback = monitors[0] ?? primary;
    if (!fallback) {
      throw new Error('No monitors detected');
    }
    return { monitor: fallback, fullscreen: false };
  }

  const nonPrimary = monitors.find(
    (m) => m.position.x !== primary.position.x || m.position.y !== primary.position.y
  );
  return { monitor: nonPrimary ?? primary, fullscreen: !!nonPrimary };
}

function buildProjectorUrl(payload: ProjectorPayload): string {
  const params = new URLSearchParams();
  params.set('projector', '1');
  params.set('launchedGameId', String(payload.launchedGameId));
  if (payload.gameName) params.set('gameName', payload.gameName);
  params.set('config', btoa(JSON.stringify(payload.config)));
  return `/index.html?${params.toString()}`;
}

export async function isProjectorOpen(): Promise<boolean> {
  const existing = await WebviewWindow.getByLabel(PROJECTOR_LABEL);
  return existing !== null;
}

// Returns true iff the projector window is alive AND currently showing the
// given launched game. Used by `LeaderboardPage` to flip its toggle button
// between "Open on second screen" and "Close projector".
export async function isProjectorOpenFor(launchedGameId: number): Promise<boolean> {
  const open = await isProjectorOpen();
  if (!open) {
    // Stale localStorage cleanup if the window died without our knowledge.
    setProjectedGameId(null);
    return false;
  }
  return getStoredProjectedGameId() === launchedGameId;
}

// Open (or switch the content of) the projector window. Single-instance:
// if a projector window already exists, navigate it to the new URL instead
// of spawning a second one.
export async function openProjector(payload: ProjectorPayload): Promise<void> {
  const url = buildProjectorUrl(payload);

  const existing = await WebviewWindow.getByLabel(PROJECTOR_LABEL);
  if (existing) {
    // Tauri 2 doesn't expose set_url on WebviewWindow yet; the reliable
    // way to switch a labelled window's content is to close + recreate.
    await existing.close();
    // Closing is async on the OS side; await a short tick before recreate
    // to avoid "label already in use" races.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  const { monitor, fullscreen } = await pickProjectorMonitor();

  const win = new WebviewWindow(PROJECTOR_LABEL, {
    url,
    title: 'Rankings',
    decorations: false,
    fullscreen,
    x: monitor.position.x,
    y: monitor.position.y,
    width: fullscreen ? monitor.size.width : 1280,
    height: fullscreen ? monitor.size.height : 800,
    focus: true,
    skipTaskbar: false,
  });

  await new Promise<void>((resolve, reject) => {
    const unlistenCreated = win.once('tauri://created', () => {
      void unlistenCreated.then((fn) => fn());
      resolve();
    });
    const unlistenError = win.once('tauri://error', (event) => {
      void unlistenError.then((fn) => fn());
      reject(new Error(`projector window failed to open: ${JSON.stringify(event.payload)}`));
    });
  });

  setProjectedGameId(payload.launchedGameId);
}

export async function closeProjector(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(PROJECTOR_LABEL);
  if (existing) {
    await existing.close();
  }
  setProjectedGameId(null);
}

// Inside the projector window itself: close self. Used by the Esc key
// handler in LeaderboardPage when projectorMode is on. Also clears the
// shared localStorage marker so the main window's toggle button flips back.
export async function closeSelfProjectorWindow(): Promise<void> {
  setProjectedGameId(null);
  await getCurrentWebviewWindow().close();
}
