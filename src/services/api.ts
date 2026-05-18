import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { loadJwt } from './strongholdStore';
import { persistAuthState, AuthStateBlock } from './authStore';

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
  'https://studio.taghunter.fr/backend/api';

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

interface ApiCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  bearer?: boolean | 'optional';
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
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

  const init: Parameters<typeof tauriFetch>[1] = {
    method: options.method ?? 'GET',
    headers,
  };
  if (options.signal) init.signal = options.signal;

  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const res = await tauriFetch(url, init);
  const text = await res.text();
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
  options: Omit<ApiCallOptions, 'body' | 'method'> & {
    signal?: AbortSignal;
    onProgress?: (p: DownloadProgress) => void;
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
  const init: Parameters<typeof tauriFetch>[1] = { method: 'GET', headers };
  if (options.signal) init.signal = options.signal;
  const res = await tauriFetch(url, init);
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

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      options.onProgress?.({ loaded, total: totalOrNull });
    }
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
