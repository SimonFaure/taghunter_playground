import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, primaryMonitor, type Monitor } from '@tauri-apps/api/window';
import type { RankingTarget } from './rankingTarget';
import { rankingTargetKey, encodeRankingTarget, decodeRankingTarget } from './rankingTarget';

const PROJECTOR_LABEL = 'projector';
const PROJECTED_KEY = 'projector.targetKey';

// localStorage is shared between Tauri WebviewWindows on Windows (same WebView2
// user data folder), so the main window can read what the projector window is
// currently showing. Cleared on close (including projector-self-close on Esc).
function setProjectedKey(key: string | null): void {
  if (key === null) localStorage.removeItem(PROJECTED_KEY);
  else localStorage.setItem(PROJECTED_KEY, key);
}

function getStoredProjectedKey(): string | null {
  return localStorage.getItem(PROJECTED_KEY);
}

// Read projector params from the current window's URL. Returns null when the
// `projector` flag is absent, malformed, or missing required fields - caller
// should fall back to the normal app render in that case.
export function readProjectorTargetFromUrl(): RankingTarget | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('projector') !== '1') return null;
  const targetStr = params.get('target');
  if (!targetStr) return null;
  try {
    return decodeRankingTarget(JSON.parse(atob(targetStr)));
  } catch {
    return null;
  }
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

function buildProjectorUrl(target: RankingTarget): string {
  const params = new URLSearchParams();
  params.set('projector', '1');
  params.set('target', btoa(JSON.stringify(encodeRankingTarget(target))));
  return `/index.html?${params.toString()}`;
}

export async function isProjectorOpen(): Promise<boolean> {
  const existing = await WebviewWindow.getByLabel(PROJECTOR_LABEL);
  return existing !== null;
}

// Returns true iff the projector window is alive AND currently showing the
// given target. Used by `LeaderboardPage` to flip its toggle button between
// "Open on second screen" and "Close projector".
export async function isProjectorOpenForTarget(target: RankingTarget): Promise<boolean> {
  const open = await isProjectorOpen();
  if (!open) {
    // Stale localStorage cleanup if the window died without our knowledge.
    setProjectedKey(null);
    return false;
  }
  return getStoredProjectedKey() === rankingTargetKey(target);
}

// Open (or switch the content of) the projector window. Single-instance:
// if a projector window already exists, navigate it to the new URL instead
// of spawning a second one.
export async function openProjector(target: RankingTarget): Promise<void> {
  const url = buildProjectorUrl(target);

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

  setProjectedKey(rankingTargetKey(target));
}

export async function closeProjector(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(PROJECTOR_LABEL);
  if (existing) {
    await existing.close();
  }
  setProjectedKey(null);
}

// Inside the projector window itself: close self. Used by the Esc key
// handler when projectorMode is on. Also clears the shared localStorage
// marker so the main window's toggle button flips back.
export async function closeSelfProjectorWindow(): Promise<void> {
  setProjectedKey(null);
  await getCurrentWebviewWindow().close();
}
