// App self-update service.
//
// Desktop (Windows/macOS/Linux): downloads + installs a new app build via
// tauri-plugin-updater. Android (sideloaded, no Play Store): downloads the APK
// Studio publishes, checks its SHA-256 and hands it to the system installer,
// where the operator confirms (design: project_android_operator_tablet).
// iOS: no in-app install, so the action deep-links to the app store.
//
// The version check + hard-floor logic runs on ALL platforms -- it is just a
// semver comparison. Only the delivery differs.
//
// Downloads land in the installer cache (src-tauri update_cache.rs): one
// installer per platform, kept after install, so a staged update survives a
// restart and this device can hand it to others on the LAN. Without internet
// the check falls back to the mother this device is routed to, which serves
// the installer it holds (`/update.php`, signature-checked like the studio's).
//
// This service deliberately does NOT use services/api.ts `apiCall`: the
// update endpoint is unauthenticated and must stay reachable even when the
// client's auth handling is itself out of date (that is the whole point of
// the hard floor). It talks to backend/api/playground_update.php directly.

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getVersion } from '@tauri-apps/api/app';
import { platform, arch } from '@tauri-apps/plugin-os';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appDataDir, join } from '@tauri-apps/api/path';
import { apiDownloadStreamed, runDownloadUrl } from './api';
import { streamBinary, removeRecursive, ensureDir, fileSize } from './contentFs';
import { getAuthUser } from './authStore';
import { motherRoute } from './contentSource';
import { isGameActive } from './activeSession';
import { isOnline, studioReachableFresh } from './connectivity';
import { listLaunchedGames } from './launchedGames';
import { tError } from '../i18n/errors';
import { getUpkeep, patchUpdate } from './upkeepState';

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
  'https://studio.taghunter.fr/backend/api';

export type UpdateState = 'up-to-date' | 'optional' | 'required' | 'error';

/** Where an update comes from: the studio, the LAN mother (offline), or
 *  this device's installer cache (handed over by a satellite, or downloaded
 *  earlier) - the only offline source a MOTHER has. */
export type UpdateSource = 'cloud' | 'mother' | 'cache';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion: string | null;
  notes: string;
  /** Hard floor: clients below this version are blocked. */
  minSupportedVersion: string | null;
  /** App-store URL for the current platform (mobile), if published. */
  storeUrl: string | null;
  /** True where the app can download + install the update itself: desktop,
   *  and Android when Studio has an APK for it. False -> store link. */
  canSelfUpdate: boolean;
  source: UpdateSource;
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
    /** The build's own channel (newer studio; the mother always sends it). */
    channel?: string;
    /** Android only: the sideload APK to download and verify. `url` is set by
     *  the mother (the studio's is reached by id). */
    apk?: { id: number; sha256: string; size: number | null; url?: string };
  } | null;
}

/** A cached installer (src-tauri update_cache.rs ReleaseMeta). */
interface ReleaseMeta {
  version: string;
  channel: string;
  notes: string;
  pub_date?: string | null;
  signature?: string | null;
  sha256?: string | null;
  size: number;
  min_supported_version?: string | null;
  filename: string;
  fetched_from: string;
  fetched_at: number;
}

interface CacheStatus {
  platform: string;
  own: ReleaseMeta | null;
  android: ReleaseMeta | null;
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

// The app-update channel this device resolved (device override -> client ->
// stable), cached in auth_user by the bootstrap/login auth_state. The update
// endpoints are unauthenticated, so we send this resolved value ourselves: the
// custom `check` call appends ?channel=, and the Tauri plugin's own request
// carries it as the X-Update-Channel header (and in the query, which the
// mother's endpoint reads). Defaults to 'stable' before the first bootstrap /
// offline. Design: project_client_tester_update_channel.
export async function resolveUpdateChannel(): Promise<string> {
  try {
    const user = await getAuthUser();
    const ch = user?.update_channel;
    return ch === 'test' ? 'test' : 'stable';
  } catch {
    return 'stable';
  }
}

// Compare two "x.y.z" semver strings. Returns -1 / 0 / 1.
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The studio's or the mother's update endpoint. */
function updateEndpoint(source: UpdateSource, motherBase?: string): string {
  return source === 'mother' && motherBase
    ? `${motherBase.replace(/\/+$/, '')}/update.php`
    : `${API_BASE}/playground_update.php`;
}

// ── version check ────────────────────────────────────────────────────────────

/**
 * Check the studio (or the mother) for a newer app version.
 * `currentVersion` overridable: a mother prefetching its satellites' installer
 * asks with 0.0.0 to always get the latest.
 */
async function fetchManifest(
  currentVersion: string,
  opts: { source?: UpdateSource; motherBase?: string; target?: string; arch?: string } = {}
): Promise<ManifestResponse | null> {
  const channel = await resolveUpdateChannel();
  const url =
    `${updateEndpoint(opts.source ?? 'cloud', opts.motherBase)}?action=check` +
    `&target=${encodeURIComponent(opts.target ?? currentTarget())}` +
    `&arch=${encodeURIComponent(opts.arch ?? currentArch())}` +
    `&current_version=${encodeURIComponent(currentVersion)}` +
    `&channel=${encodeURIComponent(channel)}`;
  // A mother on the LAN answers fast or not at all. A clearable timer, not
  // AbortSignal.timeout(): plugin-http leaks abort listeners (see api.ts).
  const ctrl = new AbortController();
  const timer = opts.source === 'mother' ? setTimeout(() => ctrl.abort(), 8000) : null;
  try {
    const res = await tauriFetch(url, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as ManifestResponse;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Where the last check found its update: downloadUpdate() fetches from there.
let lastSource: { source: UpdateSource; motherBase?: string } = { source: 'cloud' };

function statusFrom(
  json: ManifestResponse,
  base: Omit<UpdateStatus, 'state'>,
  source: UpdateSource
): UpdateStatus {
  const m = json.manifest;
  if (!json.available || !m) return { ...base, source, state: 'up-to-date' };
  const target = currentTarget();
  const floor = m.min_supported_version ?? '0.0.0';
  const storeUrl = m.store_urls?.[target === 'darwin' ? 'ios' : target] ?? null;
  const result: Omit<UpdateStatus, 'state'> = {
    ...base,
    source,
    latestVersion: m.version,
    notes: m.notes ?? '',
    minSupportedVersion: floor,
    storeUrl,
    canSelfUpdate: base.canSelfUpdate || (target === 'android' && !!m.apk),
  };
  // Offline (update from the mother), never block the app on the hard floor:
  // stuck at an event on an older version beats a locked device.
  if (compareSemver(base.currentVersion, floor) < 0 && source === 'cloud') return { ...result, state: 'required' };
  if (compareSemver(base.currentVersion, m.version) < 0) return { ...result, state: 'optional' };
  return { ...result, state: 'up-to-date' };
}

/**
 * Network failure on the studio falls back to the mother; when neither
 * answers this resolves to `state: 'error'` (the caller proceeds silently).
 * The outcome goes into this device's upkeep report (Devices modal).
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const status = await checkForUpdateUnreported();
  const busy = ['downloading', 'installing'].includes(getUpkeep().update.phase);
  const channel = await resolveUpdateChannel();
  if (status.state === 'error') {
    if (!busy && getUpkeep().update.phase === 'checking') patchUpdate({ phase: 'unknown', channel });
    return status;
  }
  if (status.state === 'up-to-date') {
    if (!busy) patchUpdate({ phase: 'up_to_date', latest: null, progress: null, blocked: null, error: null, source: status.source, channel });
    return status;
  }
  const staged = await stagedUpdateVersion().catch(() => null);
  patchUpdate({
    latest: status.latestVersion,
    source: status.source,
    channel,
    ...(busy
      ? {}
      : {
          phase: !status.canSelfUpdate ? 'store_only' : staged && staged === status.latestVersion ? 'ready' : 'available',
          error: null,
        }),
  });
  return status;
}

async function checkForUpdateUnreported(): Promise<UpdateStatus> {
  const currentVersion = await getVersion().catch(() => '0.0.0');
  const base: Omit<UpdateStatus, 'state'> = {
    currentVersion,
    latestVersion: null,
    notes: '',
    minSupportedVersion: null,
    storeUrl: null,
    canSelfUpdate: isDesktopPlatform(),
    source: 'cloud',
  };

  try {
    const json = await fetchManifest(currentVersion);
    if (json) {
      lastSource = { source: 'cloud' };
      return statusFrom(json, base, 'cloud');
    }
  } catch {
    /* unreachable: try the mother */
  }

  let fromMother: UpdateStatus | null = null;
  const mother = motherRoute();
  if (mother) {
    try {
      const json = await fetchManifest(currentVersion, { source: 'mother', motherBase: mother.baseUrl });
      if (json) {
        lastSource = { source: 'mother', motherBase: mother.baseUrl };
        fromMother = statusFrom(json, base, 'mother');
        if (fromMother.state !== 'up-to-date') return fromMother;
      }
    } catch {
      /* fall through */
    }
  }

  // Nothing newer over the network: a newer installer may already be in our
  // own cache - a satellite handed it to us (we are the mother: there is no
  // one else to ask offline), or it was downloaded earlier. It installs as is.
  const cached = await stagedUpdateMeta();
  if (cached) {
    lastSource = { source: 'cache' };
    return statusFrom(
      {
        available: true,
        manifest: {
          version: cached.version,
          notes: cached.notes,
          min_supported_version: cached.min_supported_version ?? undefined,
          channel: cached.channel,
          ...(currentTarget() === 'android' && cached.sha256
            ? { apk: { id: 0, sha256: cached.sha256, size: cached.size } }
            : {}),
        },
      },
      base,
      'cache'
    );
  }
  return fromMother ?? { ...base, state: 'error' };
}

/**
 * Check a given mother (by its LAN address) directly - for a device whose LAN
 * protocol is too old to pair with it: `/update.php` answers across versions.
 */
export async function checkForUpdateFromMother(motherBase: string): Promise<UpdateStatus> {
  const currentVersion = await getVersion().catch(() => '0.0.0');
  const base: Omit<UpdateStatus, 'state'> = {
    currentVersion,
    latestVersion: null,
    notes: '',
    minSupportedVersion: null,
    storeUrl: null,
    canSelfUpdate: isDesktopPlatform(),
    source: 'mother',
  };
  try {
    const json = await fetchManifest(currentVersion, { source: 'mother', motherBase });
    if (!json) return { ...base, state: 'error' };
    lastSource = { source: 'mother', motherBase };
    return statusFrom(json, base, 'mother');
  } catch {
    return { ...base, state: 'error' };
  }
}

// ── the installer cache ──────────────────────────────────────────────────────

async function cacheStatus(): Promise<CacheStatus | null> {
  return invoke<CacheStatus>('update_cache_status').catch(() => null);
}

/** A device on `device`'s channel may install a `build` of that channel; a
 *  tester may also take a stable build (same rule as update_cache.rs). */
export function channelOk(device: string, build: string): boolean {
  return device === build || (device === 'test' && build === 'stable');
}

/** The installer staged in the cache, newer than this app and for our channel, or null. */
async function stagedUpdateMeta(): Promise<ReleaseMeta | null> {
  const [status, current, channel] = await Promise.all([
    cacheStatus(),
    getVersion().catch(() => '0.0.0'),
    resolveUpdateChannel(),
  ]);
  const own = status?.own;
  return own && channelOk(channel, own.channel) && compareSemver(own.version, current) > 0 ? own : null;
}

/** The version staged in the cache, newer than this app and for our channel, or null. */
export async function stagedUpdateVersion(): Promise<string | null> {
  return (await stagedUpdateMeta())?.version ?? null;
}

/** Boot: drop a cached installer no newer than this app + updater leftovers. */
export async function pruneUpdateCache(): Promise<void> {
  await invoke('update_cache_prune').catch(() => {});
}

// ── desktop: download + install ──────────────────────────────────────────────

/**
 * Download the latest update into the installer cache, reporting byte progress,
 * from wherever the last check found it (studio or mother). Desktop: the
 * updater plugin verifies the artifact against the signing key.
 */
export async function downloadUpdate(
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  patchUpdate({ phase: 'downloading', progress: 0, error: null, blocked: null });
  const report = (p: DownloadProgress) => {
    onProgress(p);
    if (p.total) patchUpdate({ progress: Math.min(100, Math.round((p.downloaded / p.total) * 100)) });
  };
  try {
    await downloadUpdateUnreported(report);
    patchUpdate({ phase: 'ready', progress: null });
  } catch (e) {
    patchUpdate({ phase: 'error', progress: null, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function downloadUpdateUnreported(onProgress: (p: DownloadProgress) => void): Promise<void> {
  if (currentTarget() === 'android') {
    await downloadApk(onProgress, lastSource.source, lastSource.motherBase);
    return;
  }
  // The plugin templates {{target}}/{{arch}}/{{current_version}} itself; the
  // channel rides in the query (mother) and in a header (studio).
  const channel = await resolveUpdateChannel();
  const manifestUrl =
    `${updateEndpoint(lastSource.source, lastSource.motherBase)}?action=manifest` +
    `&target={{target}}&arch={{arch}}&current_version={{current_version}}&channel=${encodeURIComponent(channel)}`;
  await fetchDesktopInstaller(manifestUrl, channel, false, lastSource.source, onProgress);
}

async function fetchDesktopInstaller(
  manifestUrl: string,
  channel: string,
  prefetch: boolean,
  source: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<ReleaseMeta> {
  const unlisten = onProgress
    ? await listen<{ downloaded: number; total: number | null }>('taghunter://update-cache-progress', (e) =>
        onProgress({ downloaded: e.payload.downloaded, total: e.payload.total })
      )
    : null;
  try {
    return await invoke<ReleaseMeta>('update_fetch_to_cache', { manifestUrl, channel, prefetch, source });
  } finally {
    unlisten?.();
  }
}

/**
 * Install the staged update and relaunch the app.
 * On Windows the installer (passive mode) takes over and the process exits.
 */
export async function installAndRelaunch(): Promise<void> {
  patchUpdate({ phase: 'installing', blocked: null, error: null });
  try {
    if (currentTarget() === 'android') {
      const path = pendingApkPath ?? (await cachedApkPath());
      if (!path) throw new Error(tError('noUpdateToInstall'));
      // Opens Android's "update this app?" screen. Once the operator confirms,
      // Android replaces the app and it restarts on the new version by itself.
      await invoke('android_install_apk', { path });
      patchUpdate({ phase: 'ready', blocked: 'confirm_on_device' });
      return;
    }
    if (!(await stagedUpdateVersion())) throw new Error(tError('noUpdateToInstall'));
    // Rust re-checks the signature through the plugin, installs and restarts.
    await invoke('update_install_from_cache', { channel: await resolveUpdateChannel() });
  } catch (e) {
    patchUpdate({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * A launched game is open on this device, or this device is a mother hosting
 * at least one un-ended game: restarting now would interrupt it. The mother
 * server alone is NOT a signal - it stays up on any mother with no game.
 */
export async function isGameRunningHere(): Promise<boolean> {
  if (isGameActive()) return true;
  try {
    const role = await invoke<{ mother_server_running?: boolean }>('client_describe_local_role');
    if (!role?.mother_server_running) return false;
    const hosted = await listLaunchedGames({ ended: false, forceLocal: true });
    return hosted.length > 0;
  } catch {
    return false;
  }
}

// ── android: sideload APK ────────────────────────────────────────────────────

const APK_INCOMING_REL = 'updates/incoming/playground-update.apk';
let pendingApkPath: string | null = null;

async function cachedApkPath(): Promise<string | null> {
  const meta = (await cacheStatus())?.android;
  if (!meta) return null;
  return join(await appDataDir(), 'updates', 'cache', 'android', meta.filename);
}

/**
 * Download the latest APK for `channel` (from the studio or a mother) into the
 * installer cache, verified against the SHA-256 Studio recorded at upload. A
 * mismatch (corrupt or tampered download) is deleted and never kept. Used for
 * this tablet's own update, and by a Windows mother keeping the APK for its
 * tablets (`currentVersion` 0.0.0 = latest whatever we run).
 */
async function fetchApkToCache(
  source: UpdateSource,
  motherBase: string | undefined,
  currentVersion: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<ReleaseMeta | null> {
  const json = await fetchManifest(currentVersion, { source, motherBase, target: 'android', arch: 'aarch64' });
  const m = json?.manifest;
  const apk = m?.apk;
  if (!m || !apk) return null;
  const cached = (await cacheStatus())?.android;
  const channel = await resolveUpdateChannel();
  if (cached && channelOk(channel, cached.channel) && compareSemver(cached.version, m.version) >= 0) return cached;

  await ensureDir('updates/incoming');
  const report = (p: { loaded: number; total: number | null }) =>
    onProgress?.({ downloaded: p.loaded, total: p.total ?? apk.size });
  if (source === 'mother' && apk.url) {
    await streamBinary(APK_INCOMING_REL, (write) => runDownloadUrl(apk.url!, 'mother update.php download', {}, { onProgress: report }, write));
  } else {
    await streamBinary(APK_INCOMING_REL, (write) =>
      apiDownloadStreamed('playground_update', 'download', { bearer: false, query: { id: apk.id }, onProgress: report }, write)
    );
  }

  const abs = await join(await appDataDir(), APK_INCOMING_REL);
  const got = await invoke<string>('sha256_file', { path: abs });
  if (got !== apk.sha256) {
    await removeRecursive(APK_INCOMING_REL).catch(() => {});
    throw new Error(`APK hash mismatch: expected ${apk.sha256}, got ${got}`);
  }
  const meta: ReleaseMeta = {
    version: m.version,
    channel: m.channel ?? channel,
    notes: m.notes ?? '',
    pub_date: m.pub_date ?? null,
    signature: null,
    sha256: apk.sha256,
    size: apk.size ?? 0,
    min_supported_version: m.min_supported_version ?? null,
    filename: `playground-${m.version}.apk`,
    fetched_from: source,
    fetched_at: Date.now(),
  };
  if (!meta.size) meta.size = await fileSize(APK_INCOMING_REL);
  await invoke('update_cache_commit_apk', { tempPath: abs, meta });
  return meta;
}

async function downloadApk(
  onProgress: (p: DownloadProgress) => void,
  source: UpdateSource,
  motherBase: string | undefined
): Promise<void> {
  pendingApkPath = null;
  const currentVersion = await getVersion().catch(() => '0.0.0');
  const meta = await fetchApkToCache(source, motherBase, currentVersion, onProgress);
  if (!meta) throw new Error(tError('noUpdateToDownload'));
  pendingApkPath = await cachedApkPath();
}

// ── mother: keep the newest installers for the satellites ───────────────────

/**
 * A mother, online and idle, keeps the newest installer for its channel - its
 * own platform's, and the Android APK for operator tablets - so satellites can
 * update from it with no internet. Never installs anything. Returns what it
 * fetched (empty when everything was already current).
 */
export async function prefetchInstallersForLan(): Promise<string[]> {
  const fetched: string[] = [];
  const channel = await resolveUpdateChannel();
  if (isDesktopPlatform()) {
    const json = await fetchManifest('0.0.0').catch(() => null);
    const latest = json?.manifest?.version;
    const own = (await cacheStatus())?.own;
    if (latest && (!own || compareSemver(own.version, latest) < 0)) {
      const manifestUrl =
        `${updateEndpoint('cloud')}?action=manifest&target={{target}}&arch={{arch}}&current_version=0.0.0` +
        `&channel=${encodeURIComponent(channel)}`;
      const meta = await fetchDesktopInstaller(manifestUrl, channel, true, 'cloud');
      fetched.push(`${meta.filename}`);
    }
  }
  const apk = await fetchApkToCache('cloud', undefined, '0.0.0').catch((e) => {
    console.warn('[updateService] APK prefetch failed:', e);
    return null;
  });
  if (apk && Date.now() - apk.fetched_at < 60_000) fetched.push(apk.filename);
  return fetched;
}

const PREFETCH_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastPrefetchAt = 0;
let prefetching = false;

/**
 * The mother's periodic call (hosting-role tick): keep the newest installers
 * cached for the LAN, at most every 6 h, only online and with no game running
 * here (a download competes with the game's traffic; it resumes next time).
 */
export async function installerPrefetchTick(): Promise<void> {
  if (prefetching || Date.now() - lastPrefetchAt < PREFETCH_INTERVAL_MS) return;
  if (isGameActive()) return;
  if (!isOnline() || !(await studioReachableFresh())) return;
  const hosted = await listLaunchedGames({ ended: false, forceLocal: true }).catch(() => []);
  if (hosted.length > 0) return;
  prefetching = true;
  lastPrefetchAt = Date.now();
  try {
    const fetched = await prefetchInstallersForLan();
    if (fetched.length) console.log('[updateService] cached for the LAN:', fetched.join(', '));
  } catch (e) {
    console.warn('[updateService] installer prefetch failed:', e);
  } finally {
    prefetching = false;
  }
}

// `${mother}|${version}` already handed over this session: an installer is tens
// of MB, never re-sent to a mother that declined or already has it.
const pushedInstallers = new Set<string>();

/**
 * Satellite: if we hold a newer installer than the mother has for our
 * platform, hand it over (the mother verifies it before keeping it).
 */
export async function pushInstallerToMother(
  route: { baseUrl: string; token: string },
  clientId: number
): Promise<boolean> {
  const status = await cacheStatus();
  const own = status?.own;
  if (!own) return false;
  const key = `${route.baseUrl}|${status.platform}|${own.version}`;
  if (pushedInstallers.has(key)) return false;
  // What the mother holds for our platform (asking as 0.0.0 makes it offer
  // whatever it has). No answer = an older mother without /update.php.
  const json = await fetchManifest('0.0.0', {
    source: 'mother',
    motherBase: route.baseUrl,
    target: currentTarget(),
    arch: currentArch(),
  }).catch(() => null);
  if (!json) return false;
  const theirs = json.available ? json.manifest?.version ?? null : null;
  if (theirs && compareSemver(theirs, own.version) >= 0) return false;
  pushedInstallers.add(key);
  const res = await invoke<{ kept?: boolean }>('client_push_installer', {
    baseUrl: route.baseUrl,
    token: route.token,
    clientId,
    platform: status.platform,
  }).catch((e) => {
    console.warn('[updateService] installer push failed:', e);
    return null;
  });
  return Boolean(res?.kept);
}

// ── mobile: store deep link ──────────────────────────────────────────────────

/** Mobile only. Open the app-store listing so the user can update there. */
export async function openStoreUpdate(storeUrl: string): Promise<void> {
  await openUrl(storeUrl);
}
