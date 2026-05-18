// App self-update service.
//
// Desktop (Windows/macOS/Linux): downloads + installs a new app build via
// tauri-plugin-updater. Mobile (Android/iOS): cannot self-install, so the
// same version check applies but the action deep-links to the app store.
//
// The version check + hard-floor logic runs on ALL platforms -- it is just a
// semver comparison. Only the delivery differs.
//
// This service deliberately does NOT use services/api.ts `apiCall`: the
// update endpoint is unauthenticated and must stay reachable even when the
// client's auth handling is itself out of date (that is the whole point of
// the hard floor). It talks to backend/api/playground_update.php directly.

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getVersion } from '@tauri-apps/api/app';
import { platform, arch } from '@tauri-apps/plugin-os';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { openUrl } from '@tauri-apps/plugin-opener';

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
  'https://studio.taghunter.fr/backend/api';

export type UpdateState = 'up-to-date' | 'optional' | 'required' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion: string | null;
  notes: string;
  /** Hard floor: clients below this version are blocked. */
  minSupportedVersion: string | null;
  /** App-store URL for the current platform (mobile), if published. */
  storeUrl: string | null;
  /** True on desktop, where the in-app updater can download + install. */
  isDesktop: boolean;
}

export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

interface ManifestResponse {
  available: boolean;
  manifest: {
    version: string;
    notes?: string;
    pub_date?: string;
    min_supported_version?: string;
    store_urls?: Record<string, string>;
  } | null;
}

// ── platform helpers ─────────────────────────────────────────────────────────

/** Tauri updater target name for the running OS. */
function currentTarget(): string {
  let p = 'unknown';
  try {
    p = platform();
  } catch {
    /* keep default */
  }
  return p === 'macos' ? 'darwin' : p;
}

function currentArch(): string {
  try {
    return arch();
  } catch {
    return 'x86_64';
  }
}

/** True on Windows/macOS/Linux, where the app can self-update. */
export function isDesktopPlatform(): boolean {
  return ['windows', 'darwin', 'linux'].includes(currentTarget());
}

// Compare two "x.y.z" semver strings. Returns -1 / 0 / 1.
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ── version check ────────────────────────────────────────────────────────────

/**
 * Check the studio for a newer app version and evaluate the hard floor.
 * Network failure resolves to `state: 'error'` (the caller proceeds silently).
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const currentVersion = await getVersion().catch(() => '0.0.0');
  const isDesktop = isDesktopPlatform();
  const target = currentTarget();
  const base: Omit<UpdateStatus, 'state'> = {
    currentVersion,
    latestVersion: null,
    notes: '',
    minSupportedVersion: null,
    storeUrl: null,
    isDesktop,
  };

  try {
    const url =
      `${API_BASE}/playground_update.php?action=check` +
      `&target=${encodeURIComponent(target)}` +
      `&arch=${encodeURIComponent(currentArch())}` +
      `&current_version=${encodeURIComponent(currentVersion)}`;

    const res = await tauriFetch(url, { method: 'GET' });
    if (!res.ok) return { ...base, state: 'error' };

    const json = (await res.json()) as ManifestResponse;
    const m = json.manifest;
    if (!json.available || !m) {
      return { ...base, state: 'up-to-date' };
    }

    const floor = m.min_supported_version ?? '0.0.0';
    const storeUrl = m.store_urls?.[target === 'darwin' ? 'ios' : target] ?? null;
    const result: Omit<UpdateStatus, 'state'> = {
      ...base,
      latestVersion: m.version,
      notes: m.notes ?? '',
      minSupportedVersion: floor,
      storeUrl,
    };

    if (compareSemver(currentVersion, floor) < 0) {
      return { ...result, state: 'required' };
    }
    if (compareSemver(currentVersion, m.version) < 0) {
      return { ...result, state: 'optional' };
    }
    return { ...result, state: 'up-to-date' };
  } catch {
    return { ...base, state: 'error' };
  }
}

// ── desktop: download + install ──────────────────────────────────────────────

// The Update object from the most recent download, kept so install() can run
// after the user clicks "Restart" (download and install are separate steps).
let pendingUpdate: Update | null = null;

/**
 * Desktop only. Download the latest update, reporting byte progress.
 * The plugin verifies the artifact against the updater signing key.
 */
export async function downloadUpdate(
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  const update = await check();
  if (!update) throw new Error('No update available to download');
  pendingUpdate = update;

  let downloaded = 0;
  let total: number | null = null;
  await update.download((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null;
        onProgress({ downloaded: 0, total });
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        onProgress({ downloaded, total });
        break;
      case 'Finished':
        onProgress({ downloaded: total ?? downloaded, total });
        break;
    }
  });
}

/** True once downloadUpdate() has completed and an install is staged. */
export function hasPendingUpdate(): boolean {
  return pendingUpdate !== null;
}

/**
 * Desktop only. Install the downloaded update and relaunch the app.
 * On Windows the installer (passive mode) takes over and the process exits.
 */
export async function installAndRelaunch(): Promise<void> {
  if (!pendingUpdate) throw new Error('No downloaded update to install');
  await pendingUpdate.install();
  await relaunch();
}

// ── mobile: store deep link ──────────────────────────────────────────────────

/** Mobile only. Open the app-store listing so the user can update there. */
export async function openStoreUpdate(storeUrl: string): Promise<void> {
  await openUrl(storeUrl);
}
