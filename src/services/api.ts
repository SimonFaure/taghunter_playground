import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { loadJwt } from './strongholdStore';
import { persistAuthState, AuthStateBlock } from './authStore';
import { tError } from '../i18n/errors';

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
  'https://studio.taghunter.fr/backend/api';

// Tauri's HTTP fetch has no default timeout. Without these, a stalled server
// (notably local Apache hanging on the .htaccess Authorization rewrite) freezes
// the whole sync cycle: a worker's `await downloadOne()` never settles, so the
// download pool's Promise.all never resolves and the UI stays stuck on
// "Syncing…". All sync requests route through apiCall / apiDownloadBytesStream,
// so centralizing the timeouts here makes the protection structural rather
// than opt-in per call site.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000; // apiCall: whole request
const DOWNLOAD_TTFB_TIMEOUT_MS = 30_000; // stream: connect → response headers
const DOWNLOAD_STALL_TIMEOUT_MS = 60_000; // stream: max gap between chunks

// LAN override (mother device): when set, requests for endpoints in `endpoints`
// route to `baseUrl` with `token` as the bearer instead of the studio JWT.
// This is the bridge that lets services/launchedGames.ts target an in-process
// axum server during a launched game without changing any caller code.
interface LanOverride {
  baseUrl: string;
  token: string;
  endpoints: ReadonlySet<string>;
}
let lanOverride: LanOverride | null = null;

// Endpoints that are ALWAYS served by the in-process mother (never studio).
// A call to one of these before the override is installed must wait for it
// rather than fall through to studio - studio has no mother-local launched
// game, so it answers 404. See waitForLanOverride below.
// Exported as the single source of truth: every override installer
// (lanMotherBoot, smoke tests) must route exactly this set, or a call would
// pass the local-only gate here yet miss the override's endpoint match and
// silently fall through to studio.
export const LOCAL_ONLY_ENDPOINTS: ReadonlySet<string> = new Set(['launched_games']);
const LAN_READY_TIMEOUT_MS = 4000;

// A gate that resolves when the override is installed. The mother boot in
// App.tsx is fire-and-forget after auth, so a launched_games call (e.g. the
// in-game state poll) can fire during the boot/webview-reload window before
// the override exists. Waiters on this promise unblock the moment
// setLanOverride() installs a non-null override.
let lanReadyResolve: (() => void) | null = null;
let lanReadyPromise: Promise<void> = new Promise<void>((res) => {
  lanReadyResolve = res;
});

export function setLanOverride(o: LanOverride | null): void {
  lanOverride = o;
  if (o) {
    lanReadyResolve?.();
  } else {
    // Re-arm the gate so future callers block until it's re-installed.
    lanReadyPromise = new Promise<void>((res) => {
      lanReadyResolve = res;
    });
  }
}

export function getLanOverride(): LanOverride | null {
  return lanOverride;
}

// This device's OWN local launched_games server (127.0.0.1). Recorded by
// lanMotherBoot once the local axum server is up, and kept independent of
// `lanOverride` so it survives the override being re-pointed at a MOTHER.
//
// On a child paired to a mother, `lanOverride` points at the mother (so the
// launched-games page lists and operates the mother's games). The "This device"
// section still needs to read the child's own historical games from its local
// SQLite - callers pass `forceLocal: true` to bypass the override and hit this
// route instead. Read-only in practice (children launch onto the mother now).
let localLaunchedGamesRoute: { baseUrl: string; token: string } | null = null;
export function setLocalLaunchedGamesRoute(
  r: { baseUrl: string; token: string } | null,
): void {
  localLaunchedGamesRoute = r;
}
export function getLocalLaunchedGamesRoute(): { baseUrl: string; token: string } | null {
  return localLaunchedGamesRoute;
}

// Slice 5 (mother failover): when a LOCAL_ONLY (launched_games) call can't REACH
// its LAN override - the mother died mid-game - this handler tries to discover
// the promoted mother over mDNS and re-point the override. Returns true if it
// installed a new override worth retrying. Registered by services/motherFailover.
let lanRepointHandler: (() => Promise<boolean>) | null = null;
export function setLanRepointHandler(fn: (() => Promise<boolean>) | null): void {
  lanRepointHandler = fn;
}

// When a mother-local (launched_games) call is REJECTED with 401/403 - the
// mother rebuilt its paired_devices and no longer honours our stored secret -
// this handler re-pairs (same-client auto-approve) and re-points the override
// with the fresh secret. Returns true if it re-established a working route worth
// retrying. Registered by services/childControlLink. Avoids the old footgun
// where a stale pairing forced the operator to manually unpair to reconnect.
let lanReauthHandler: (() => Promise<boolean>) | null = null;
export function setLanReauthHandler(fn: (() => Promise<boolean>) | null): void {
  lanReauthHandler = fn;
}

// Fired whenever a mother-local call actually REACHES a remote mother (any HTTP
// status - transport succeeded). motherFailover uses it to know we've had live
// contact this session, which is what distinguishes "the mother we were talking
// to just died" from "we booted with a stale override and never reached one".
let lanContactHandler: (() => void) | null = null;
export function setLanContactHandler(fn: (() => void) | null): void {
  lanContactHandler = fn;
}

// Fired when a mother-local call finds NO route at all (the override never got
// installed, so we fail closed with the synthetic 503 below). That 503 is not a
// transport throw, so it never reached the re-point hook: a device whose
// override had been cleared could sit routeless until the next 15s tick
// happened to resolve a link (Ludiom #74). The handler kicks route resolution
// immediately instead. Fire-and-forget - the 503 is still thrown either way,
// and the caller recovers on its next poll.
let lanNoRouteHandler: (() => void) | null = null;
export function setLanNoRouteHandler(fn: (() => void) | null): void {
  lanNoRouteHandler = fn;
}

// Wait up to `timeoutMs` for the LAN override to be installed. Resolves
// immediately if it's already set. On timeout it resolves anyway so a
// genuinely-absent mother never hangs forever - the caller then fails closed
// with a synthetic 503 for LOCAL_ONLY_ENDPOINTS (it deliberately never falls
// through to studio: launched games exist only in a mother's SQLite).
function waitForLanOverride(timeoutMs: number): Promise<void> {
  if (lanOverride) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((res) => {
    timer = setTimeout(res, timeoutMs);
  });
  return Promise.race([lanReadyPromise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message?: string) {
    super(message ?? `API error ${status}`);
  }
}

// Races a promise against a wall-clock deadline. Rejects with a TimeoutError
// DOMException if the deadline wins. This guards `await`s on Tauri plugin-http
// promises: aborting an AbortSignal does NOT reliably reject a promise already
// parked inside an in-flight bridged fetch / stream read, so we cannot depend
// on the signal alone. The race guarantees the JS promise settles in bounded
// time regardless. The TimeoutError name matches what AbortSignal.timeout()
// produces, so it flows through withRetry()/runDownloadPool unchanged.
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DOMException(`${label} timed out after ${ms}ms`, 'TimeoutError')),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

interface ApiCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  bearer?: boolean | 'optional';
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  // Per-request timeout in ms. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. Pass a
  // number to override, or `null` to disable (rare - e.g. a deliberately
  // long-running upload/long-poll).
  timeoutMs?: number | null;
  // Force a launched_games call to this device's OWN local server, bypassing any
  // mother-pointing override. Used by the "This device" section of the launched
  // games page on a child whose override points at the mother. No-op for other
  // endpoints or when no local route is recorded yet.
  forceLocal?: boolean;
}

// Single fetch wrapper for studio API calls.
//   - Injects Authorization: Bearer when a JWT is present (and bearer !== false).
//   - Parses optional `auth_state` block from the response and persists it,
//     refreshing the local user record + last_server_check_at.
//   - Throws ApiError on non-2xx with the parsed body.
export async function apiCall<T = unknown>(
  endpoint: string,
  action: string,
  options: ApiCallOptions = {},
  // Internal: set on the single auto-retry after a mother re-point so we don't
  // loop. Callers never pass this.
  _isRepointRetry = false,
  // Internal: set on the single auto-retry after a re-pair (401 from a mother
  // whose secret we no longer hold). Callers never pass this.
  _isReauthRetry = false
): Promise<T> {
  // forceLocal: route this launched_games call at our OWN local server,
  // ignoring any mother-pointing override (used by the "This device" section).
  const forceLocalRoute =
    options.forceLocal && LOCAL_ONLY_ENDPOINTS.has(endpoint) && localLaunchedGamesRoute
      ? {
          baseUrl: localLaunchedGamesRoute.baseUrl,
          token: localLaunchedGamesRoute.token,
          endpoints: LOCAL_ONLY_ENDPOINTS,
        }
      : null;

  // For mother-local endpoints, give the override a moment to install before
  // routing - otherwise a boot/reload race sends the request to studio, which
  // 404s for a launched game that only exists in the mother's local SQLite.
  // (Skip the wait for forceLocal calls - they use the local route, which is
  // recorded at boot independently of the override.)
  if (lanOverride == null && !forceLocalRoute && LOCAL_ONLY_ENDPOINTS.has(endpoint)) {
    await waitForLanOverride(LAN_READY_TIMEOUT_MS);
    // Still no LAN route after waiting. In the LAN model launched games live
    // ONLY on a mother - never on studio - so do NOT fall through to the studio
    // base (which would 404 or return the wrong data, confusing operators).
    // Fail clearly instead: this device simply has no mother to talk to yet
    // (not hosting, not routed). childControlLink keeps trying to discover +
    // auto-pair one, so callers (list page, nav badge) recover on a later tick.
    if (lanOverride == null) {
      // Ask for route resolution now rather than waiting for the periodic tick.
      lanNoRouteHandler?.();
      throw new ApiError(
        503,
        null,
        tError('motherUnreachable'),
      );
    }
  }
  const lanRoute =
    forceLocalRoute ??
    (lanOverride && lanOverride.endpoints.has(endpoint) ? lanOverride : null);
  const url = lanRoute
    ? buildUrlWithBase(lanRoute.baseUrl, endpoint, action, options.query)
    : buildUrl(endpoint, action, options.query);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (options.bearer !== false) {
    if (lanRoute) {
      headers['Authorization'] = `Bearer ${lanRoute.token}`;
    } else {
      const token = await loadJwt();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      } else if (options.bearer === true) {
        throw new ApiError(401, null, 'Missing JWT');
      }
    }
  }

  const timeoutMs =
    options.timeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : options.timeoutMs;

  // Fuse the caller signal + our own clearable timeout controller so the
  // request is aborted at the Rust layer when either fires. We do NOT use
  // AbortSignal.timeout() here: plugin-http leaks abort listeners on the
  // signal we hand it (they're attached in `start(controller)` and on the
  // outer fetch's `signal.addEventListener('abort', ...)` and never removed).
  // When the timeout fires LATER, after the body was already fully read and
  // its rid closed Rust-side, dropBody() re-invokes `fetch_cancel_body` on
  // the closed rid → "The resource id N is invalid" uncaught rejection.
  // The clearable timeout below is reset in `finally`, so on natural
  // completion the controller never aborts and the leaked listeners are
  // silent. withDeadline() below remains the authoritative timeout.
  const timeoutCtrl = new AbortController();
  const timeoutHandle =
    timeoutMs != null ? setTimeout(() => timeoutCtrl.abort(), timeoutMs) : null;
  const abortSignals: AbortSignal[] = [timeoutCtrl.signal];
  if (options.signal) abortSignals.push(options.signal);
  const fusedSignal = AbortSignal.any(abortSignals);

  const init: Parameters<typeof tauriFetch>[1] = {
    method: options.method ?? 'GET',
    headers,
    signal: fusedSignal,
  };

  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const label = `${endpoint}?action=${action}`;
  let res: Awaited<ReturnType<typeof tauriFetch>>;
  let text: string;
  try {
    res =
      timeoutMs != null
        ? await withDeadline(tauriFetch(url, init), timeoutMs, label)
        : await tauriFetch(url, init);
    text =
      timeoutMs != null
        ? await withDeadline(res.text(), timeoutMs, `${label} body`)
        : await res.text();
  } catch (err) {
    // A throw HERE is a transport failure (connection refused / timeout). An
    // HTTP 404 does NOT land here - it returns a response and is thrown later
    // from `!res.ok`. So if this was a mother-local call whose mother just
    // died, ask the failover handler to re-point to the promoted mother and
    // retry exactly once. (Slice 5.)
    if (
      !_isRepointRetry &&
      lanRoute &&
      !forceLocalRoute &&
      LOCAL_ONLY_ENDPOINTS.has(endpoint) &&
      lanRepointHandler
    ) {
      const repointed = await lanRepointHandler();
      if (repointed) {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        // Recurse so the retry builds a fresh timeout/abort controller and
        // recomputes the route from the newly-installed override.
        return apiCall<T>(endpoint, action, options, true, _isReauthRetry);
      }
    }
    throw err;
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }

  // Transport succeeded against a REMOTE mother: record live contact.
  if (
    lanRoute &&
    !forceLocalRoute &&
    LOCAL_ONLY_ENDPOINTS.has(endpoint) &&
    !lanRoute.baseUrl.includes('127.0.0.1') &&
    lanContactHandler
  ) {
    lanContactHandler();
  }

  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
    parseFailed = true;
  }

  if (!res.ok) {
    // Auth rejected by a REMOTE mother for a launched_games call: our stored
    // peer_secret is stale (the mother rebuilt its pairing table). Re-pair once
    // (same-client auto-approve) + re-point at the fresh secret, then retry -
    // so a stale pairing self-heals instead of needing a manual unpair.
    if (
      (res.status === 401 || res.status === 403) &&
      !_isReauthRetry &&
      lanRoute &&
      !forceLocalRoute &&
      LOCAL_ONLY_ENDPOINTS.has(endpoint) &&
      !lanRoute.baseUrl.includes('127.0.0.1') &&
      lanReauthHandler
    ) {
      const reauthed = await lanReauthHandler();
      if (reauthed) {
        return apiCall<T>(endpoint, action, options, _isRepointRetry, true);
      }
    }
    throw new ApiError(res.status, parsed);
  }

  // 2xx with non-JSON body: typically PHP warnings/notices being echoed
  // before the JSON payload (display_errors=On in dev). Treat as an error
  // so callers don't silently get back a string and corrupt downstream
  // writes (e.g., empty game-data.json from JSON.stringify(undefined)).
  if (parseFailed) {
    throw new ApiError(
      500,
      parsed,
      `Non-JSON response from ${endpoint}?action=${action}: ${typeof parsed === 'string' ? parsed.slice(0, 200) : ''}`
    );
  }

  if (parsed && typeof parsed === 'object' && 'auth_state' in parsed) {
    const block = (parsed as { auth_state: AuthStateBlock | null }).auth_state;
    if (block) {
      await persistAuthState(block);
    }
  }

  return parsed as T;
}

function buildUrl(endpoint: string, action: string, query?: Record<string, string | number | undefined>): string {
  return buildUrlWithBase(API_BASE, endpoint, action, query);
}

function buildUrlWithBase(
  base: string,
  endpoint: string,
  action: string,
  query?: Record<string, string | number | undefined>
): string {
  const params = new URLSearchParams();
  params.set('action', action);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        params.set(k, String(v));
      }
    }
  }
  return `${base.replace(/\/+$/, '')}/${endpoint}.php?${params.toString()}`;
}

// Bytes download for endpoints that stream raw files (get_media, download_cards).
// Bypasses the JSON parse + auth_state extraction in apiCall(). The bearer
// header is still injected. 4xx/5xx throw ApiError just like apiCall.
export async function apiDownloadBytes(
  endpoint: string,
  action: string,
  options: Omit<ApiCallOptions, 'body' | 'method'> & { signal?: AbortSignal } = {}
): Promise<Uint8Array> {
  return apiDownloadBytesStream(endpoint, action, options);
}

export interface DownloadProgress {
  loaded: number;
  // Total byte count from Content-Length, or null if the server didn't send
  // one (chunked transfer, dynamic-size endpoints). Callers should render
  // an indeterminate progress UI when total is null.
  total: number | null;
}

// Streaming variant: same surface as apiDownloadBytes but invokes onProgress
// after each chunk arrives so the caller can render real download progress.
// Falls back to a non-streaming read if the underlying Response has no
// body stream (the standard Web Streams API guarantees `.body` is a
// ReadableStream<Uint8Array> | null; Tauri's plugin-http returns null for
// 101/103/204/205/304, which we never hit for downloads).
export type DownloadStreamOptions = Omit<ApiCallOptions, 'body' | 'method' | 'timeoutMs'> & {
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  // Connect → response-headers timeout (a bounded operation).
  // Default DOWNLOAD_TTFB_TIMEOUT_MS. `null` disables.
  ttfbTimeoutMs?: number | null;
  // Per-chunk IDLE timeout: max gap between body chunks. Reset on every
  // chunk, so a large file downloading slow-but-steady is never wrongly
  // aborted - only a genuine mid-stream stall is.
  // Default DOWNLOAD_STALL_TIMEOUT_MS. `null` disables.
  stallTimeoutMs?: number | null;
};

// Core download driver: streams the response body, invoking `onChunk` for each
// chunk as it arrives. Never buffers the whole body itself - buffering vs.
// streaming-to-disk is the caller's choice. Returns the total bytes streamed.
async function runDownload(
  endpoint: string,
  action: string,
  options: DownloadStreamOptions,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<number> {
  const url = buildUrl(endpoint, action, options.query);
  const headers: Record<string, string> = {};
  if (options.bearer !== false) {
    const token = await loadJwt();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else if (options.bearer === true) {
      throw new ApiError(401, null, 'Missing JWT');
    }
  }

  const ttfbMs =
    options.ttfbTimeoutMs === undefined ? DOWNLOAD_TTFB_TIMEOUT_MS : options.ttfbTimeoutMs;
  const stallMs =
    options.stallTimeoutMs === undefined ? DOWNLOAD_STALL_TIMEOUT_MS : options.stallTimeoutMs;
  const label = `${endpoint}?action=${action}`;

  // Own controller so the stall watchdog can cancel the body stream; fused
  // with the caller signal and a CLEARABLE TTFB timeout for the header phase.
  // We do NOT use AbortSignal.timeout(): plugin-http leaks abort listeners
  // on `init.signal` (one calls fetch_cancel(REQUEST rid), one calls
  // dropBody(BODY rid)). After natural completion the body rid is already
  // closed Rust-side, so a delayed dropBody → "The resource id N is invalid"
  // uncaught rejection. clearTimeout in `finally` prevents the controller
  // from firing on success; withDeadline below remains the real timeout.
  const ctrl = new AbortController();
  const ttfbHandle =
    ttfbMs != null ? setTimeout(() => ctrl.abort(), ttfbMs) : null;
  const ttfbSignals: AbortSignal[] = [ctrl.signal];
  if (options.signal) ttfbSignals.push(options.signal);

  const init: Parameters<typeof tauriFetch>[1] = {
    method: 'GET',
    headers,
    signal: AbortSignal.any(ttfbSignals),
  };
  let res;
  try {
    res =
      ttfbMs != null
        ? await withDeadline(tauriFetch(url, init), ttfbMs, `${label} TTFB`)
        : await tauriFetch(url, init);
  } finally {
    if (ttfbHandle !== null) clearTimeout(ttfbHandle);
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw new ApiError(res.status, body);
  }

  const contentLengthHeader = res.headers.get('content-length');
  const total = contentLengthHeader ? parseInt(contentLengthHeader, 10) : NaN;
  const totalOrNull = Number.isFinite(total) && total > 0 ? total : null;

  // Fall back to arrayBuffer() if no readable stream is exposed. This still
  // fires one progress callback at completion so the UI gets a "100% done"
  // tick rather than going silent.
  if (!res.body) {
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    options.onProgress?.({ loaded: bytes.byteLength, total: totalOrNull });
    await onChunk(bytes);
    return bytes.byteLength;
  }

  const reader = res.body.getReader();
  let loaded = 0;

  // Emit an initial progress so the UI shows the item immediately, even
  // before the first chunk arrives (large files can have a long TTFB).
  options.onProgress?.({ loaded: 0, total: totalOrNull });

  try {
    for (;;) {
      // Idle (per-chunk) timeout, not a flat total timeout: a large file
      // downloading slow-but-steady must not be killed, but no chunk at all
      // for stallMs means the stream is dead. withDeadline() is what actually
      // unsticks a parked reader.read() - Tauri's abort propagation into an
      // in-flight bridged stream read is not reliable.
      const { done, value } =
        stallMs != null
          ? await withDeadline(reader.read(), stallMs, `${label} stream stalled`)
          : await reader.read();
      if (done) break;
      if (value) {
        await onChunk(value);
        loaded += value.byteLength;
        options.onProgress?.({ loaded, total: totalOrNull });
      }
    }
  } catch (err) {
    // Best-effort cleanup. NOT awaited - cancel() could itself hang on the
    // same dead stream; the throw below is what unblocks the caller.
    // reader.cancel() triggers plugin-http's stream cancel callback which
    // already calls fetch_cancel_body for us. We deliberately do NOT also
    // ctrl.abort() - firing the fused signal here would invoke plugin-http's
    // leaked abort listener for a second dropBody on the now-closed body rid
    // → "The resource id N is invalid" uncaught rejection.
    try { void reader.cancel(); } catch { /* ignore */ }
    throw err;
  }

  return loaded;
}

// Buffering variant: accumulates the whole body into one Uint8Array. Use only
// for small payloads (JSON/CSV manifests). For media/video use
// apiDownloadStreamed instead - a multi-hundred-MB single allocation OOMs the
// Android WebView heap (256 MB growth limit).
export async function apiDownloadBytesStream(
  endpoint: string,
  action: string,
  options: DownloadStreamOptions = {},
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const loaded = await runDownload(endpoint, action, options, (chunk) => {
    chunks.push(chunk);
  });
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Streaming variant: invokes `onChunk` for each chunk without ever buffering
// the whole body. The sink (e.g. a file handle) applies backpressure by
// returning a promise. Returns the total bytes streamed.
export async function apiDownloadStreamed(
  endpoint: string,
  action: string,
  options: DownloadStreamOptions,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<number> {
  return runDownload(endpoint, action, options, onChunk);
}
