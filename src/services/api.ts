import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { loadJwt } from './strongholdStore';
import { persistAuthState, AuthStateBlock } from './authStore';

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

export function setLanOverride(o: LanOverride | null): void {
  lanOverride = o;
}

export function getLanOverride(): LanOverride | null {
  return lanOverride;
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
  // number to override, or `null` to disable (rare — e.g. a deliberately
  // long-running upload/long-poll).
  timeoutMs?: number | null;
}

// Single fetch wrapper for studio API calls.
//   - Injects Authorization: Bearer when a JWT is present (and bearer !== false).
//   - Parses optional `auth_state` block from the response and persists it,
//     refreshing the local user record + last_server_check_at.
//   - Throws ApiError on non-2xx with the parsed body.
export async function apiCall<T = unknown>(
  endpoint: string,
  action: string,
  options: ApiCallOptions = {}
): Promise<T> {
  const lanRoute = lanOverride && lanOverride.endpoints.has(endpoint) ? lanOverride : null;
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
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
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
export async function apiDownloadBytesStream(
  endpoint: string,
  action: string,
  options: Omit<ApiCallOptions, 'body' | 'method' | 'timeoutMs'> & {
    signal?: AbortSignal;
    onProgress?: (p: DownloadProgress) => void;
    // Connect → response-headers timeout (a bounded operation).
    // Default DOWNLOAD_TTFB_TIMEOUT_MS. `null` disables.
    ttfbTimeoutMs?: number | null;
    // Per-chunk IDLE timeout: max gap between body chunks. Reset on every
    // chunk, so a large file downloading slow-but-steady is never wrongly
    // aborted — only a genuine mid-stream stall is.
    // Default DOWNLOAD_STALL_TIMEOUT_MS. `null` disables.
    stallTimeoutMs?: number | null;
  } = {}
): Promise<Uint8Array> {
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
    return bytes;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  // Emit an initial progress so the UI shows the item immediately, even
  // before the first chunk arrives (large files can have a long TTFB).
  options.onProgress?.({ loaded: 0, total: totalOrNull });

  try {
    for (;;) {
      // Idle (per-chunk) timeout, not a flat total timeout: a large file
      // downloading slow-but-steady must not be killed, but no chunk at all
      // for stallMs means the stream is dead. withDeadline() is what actually
      // unsticks a parked reader.read() — Tauri's abort propagation into an
      // in-flight bridged stream read is not reliable.
      const { done, value } =
        stallMs != null
          ? await withDeadline(reader.read(), stallMs, `${label} stream stalled`)
          : await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        options.onProgress?.({ loaded, total: totalOrNull });
      }
    }
  } catch (err) {
    // Best-effort cleanup. NOT awaited — cancel() could itself hang on the
    // same dead stream; the throw below is what unblocks the caller.
    // reader.cancel() triggers plugin-http's stream cancel callback which
    // already calls fetch_cancel_body for us. We deliberately do NOT also
    // ctrl.abort() — firing the fused signal here would invoke plugin-http's
    // leaked abort listener for a second dropBody on the now-closed body rid
    // → "The resource id N is invalid" uncaught rejection.
    try { void reader.cancel(); } catch { /* ignore */ }
    throw err;
  }

  // Concatenate. For large files this is the unavoidable JS-heap hit
  // we'd already have taken in the non-streaming path; nothing extra here.
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
