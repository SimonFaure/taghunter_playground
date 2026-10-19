// Where the sync pipeline fetches scenario content from.
//
// `cloudSource` is the studio (what every sync cycle uses). `peerSource` is the
// mother's /content.php on the LAN, for a venue with no internet: same response
// shapes, so syncOrchestrator's download → sha256-verify → commit path runs
// unchanged whichever side the bytes come from. Media blobs are verified
// against their content hash either way; game-data.json can't be (its key is a
// studio change token) and is trusted because the mother is paired to the same
// licensee.

import {
  ApiError,
  apiCall,
  apiDownloadBytesStream,
  apiDownloadStreamed,
  buildUrlWithBase,
  getLanOverride,
  getLocalLaunchedGamesRoute,
  runDownloadUrl,
  type DownloadProgress,
} from './api';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { LAN_PROTO, LAN_PROTO_HEADER } from './lanProto';

export interface ScenarioMetaFile {
  rel_path: string;
  hash: string;
  size: number;
  /** Peer only: the blob is on the mother's disk (an operator-only or still-
   *  syncing mother may lack some). Absent = available. */
  available?: boolean;
}

export interface ScenarioMetaResponse {
  scenario: { uniqid: string; name: string; scenario_type: string };
  game_data: unknown;
  medias: string[] | null;
  // CAS manifest. `files` is authoritative: per-file content hashes incl. the
  // game-data.json entry (keyed by data_hash). `data_hash` is also surfaced
  // top-level. Both present once the studio hash migration has run.
  data_hash?: string | null;
  files?: ScenarioMetaFile[] | null;
  // Peer only: the mother's scenario row, so a satellite whose own manifest
  // predates the scenario can create it, and whether the mother's copy is the
  // full one for its cloud manifest (`content_hash` set only then).
  title?: string;
  game_type?: string;
  is_product?: boolean;
  version?: number;
  remote_version?: number;
  remote_content_hash?: string | null;
  complete?: boolean;
  content_hash?: string | null;
}

export interface PatternDownloadResponse {
  pattern_uniqid: string;
  pattern_slug: string | null;
  description: string | null;
  pattern_data: unknown;
  stations?: Record<string, string> | null;
  version: number;
  // Peer only: manifest fields to create the row when missing locally.
  name?: string;
  game_type?: string;
  is_default?: boolean;
  is_local?: boolean;
}

export interface MediaStreamArgs {
  uniqid: string;
  filename: string;
  hash: string;
  signal: AbortSignal;
  rangeStart: number;
  onProgress: (p: DownloadProgress) => void;
}

export interface ReportLayoutsResponse {
  version?: number;
  layouts?: unknown;
  /** Cloud only: a peer can't read it (it lives in the renderer's storage). */
  print_format?: unknown;
}

export interface GameTypeFileArgs {
  variant: 'admin' | 'client';
  code: string;
  version: number;
  signal: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
}

export interface ContentSource {
  kind: 'cloud' | 'peer';
  /** For logs / error messages. */
  label: string;
  /** Peer, background sync while the mother hosts a running game: leave the
   *  videos for later (the mother refuses big transfers then anyway). */
  deferVideos?: boolean;
  getScenarioMeta(uniqid: string, signal: AbortSignal): Promise<ScenarioMetaResponse>;
  streamScenarioMedia(args: MediaStreamArgs, sink: (chunk: Uint8Array) => Promise<void>): Promise<number>;
  getPattern(uniqid: string, signal: AbortSignal): Promise<PatternDownloadResponse>;
  /** The team-name pools file, as text. */
  getTeamNames(signal: AbortSignal, onProgress?: (p: DownloadProgress) => void): Promise<string>;
  getReportLayouts(signal: AbortSignal, onProgress?: (p: DownloadProgress) => void): Promise<ReportLayoutsResponse>;
  /** The licensee-customers file (studio get_customers, contact-free), as text. */
  getCustomers(signal: AbortSignal, onProgress?: (p: DownloadProgress) => void): Promise<string>;
  /** A game-type tutorial video. */
  streamGameTypeVideo(
    args: GameTypeFileArgs & { filename: string },
    sink: (chunk: Uint8Array) => Promise<void>
  ): Promise<number>;
  /** One subtitle track of a game-type tutorial video. */
  getGameTypeSubtitle(args: GameTypeFileArgs & { lang: string; filename: string }): Promise<Uint8Array>;
}

export const cloudSource: ContentSource = {
  kind: 'cloud',
  label: 'studio',
  getScenarioMeta: (uniqid, signal) =>
    apiCall<ScenarioMetaResponse>('playground', 'get_scenario_game_data', {
      method: 'GET',
      bearer: true,
      query: { uniqid },
      signal,
    }),
  streamScenarioMedia: (a, sink) =>
    apiDownloadStreamed(
      'playground',
      'get_media',
      {
        bearer: true,
        query: { uniqid: a.uniqid, filename: a.filename },
        signal: a.signal,
        rangeStart: a.rangeStart,
        onProgress: a.onProgress,
      },
      sink
    ),
  getPattern: (uniqid, signal) =>
    apiCall<PatternDownloadResponse>('playground', 'download_pattern', {
      method: 'GET',
      bearer: true,
      query: { pattern_uniqid: uniqid },
      signal,
    }),
  getTeamNames: async (signal, onProgress) =>
    new TextDecoder().decode(
      await apiDownloadBytesStream('playground', 'get_team_names', { bearer: true, signal, onProgress })
    ),
  getReportLayouts: async (signal, onProgress) =>
    JSON.parse(
      new TextDecoder().decode(
        await apiDownloadBytesStream('playground', 'get_report_layouts', { bearer: true, signal, onProgress })
      )
    ) as ReportLayoutsResponse,
  getCustomers: async (signal, onProgress) =>
    new TextDecoder().decode(
      await apiDownloadBytesStream('playground', 'get_customers', { bearer: true, signal, onProgress })
    ),
  streamGameTypeVideo: (a, sink) =>
    apiDownloadStreamed(
      'playground',
      'get_game_type_media',
      {
        bearer: true,
        query: { code: a.code, variant: a.variant, version: String(a.version), filename: a.filename },
        signal: a.signal,
        onProgress: a.onProgress,
      },
      sink
    ),
  getGameTypeSubtitle: (a) =>
    apiDownloadBytesStream('playground', 'get_game_type_media', {
      bearer: true,
      query: { code: a.code, variant: a.variant, version: String(a.version), subtitle_lang: a.lang },
      signal: a.signal,
    }),
};

export interface PeerRoute {
  baseUrl: string;
  token: string;
}

/** The mother this device's launched games are routed to; null when none, or when it is us. */
export function motherRoute(): PeerRoute | null {
  const o = getLanOverride();
  if (!o) return null;
  const local = getLocalLaunchedGamesRoute();
  if (local && local.baseUrl === o.baseUrl) return null;
  return { baseUrl: o.baseUrl, token: o.token };
}

// The mother's error code from a /content.php failure (NOT_ON_MOTHER,
// NOT_DOWNLOADED, BLOB_NOT_ON_MOTHER, CLIENT_MISMATCH, BUSY...), else null.
export function peerErrorCode(err: unknown): string | null {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const code = (err.body as { error?: unknown }).error;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** What the mother holds (/content.php?action=inventory). */
export interface PeerInventory {
  client_id: number;
  cloud_as_of_ms: number | null;
  approx: boolean;
  content_rev: number;
  game_active: boolean;
  /** `title`: absent from a mother that predates it. */
  scenarios: Array<{ uniqid: string; hash: string | null; complete: boolean; title?: string }>;
  patterns: Array<{ uniqid: string; version: number }>;
  team_names: number | null;
  report_layouts: number | null;
  /** Licensee customers file version; absent from a mother that predates it. */
  customers?: number | null;
  game_types: Array<{ code: string; version: number; subtitles_version: number }>;
  overrides: Array<{ code: string; version: number; subtitles_version: number }>;
}

/** The last cloud manifest the mother applied (/content.php?action=get_manifest). */
export interface PeerManifest {
  client_id: number;
  cloud_as_of_ms: number;
  approx: boolean;
  manifest: unknown;
}

export interface PeerContentSource extends ContentSource {
  kind: 'peer';
  /** The content is already on this device's disk (a satellite pushed it:
   *  services/peerInbox). Committing it downloads nothing, so it isn't held
   *  back for the studio or the operator's go-ahead. */
  local?: boolean;
  getInventory(signal: AbortSignal): Promise<PeerInventory>;
  getManifest(signal: AbortSignal): Promise<PeerManifest>;
}

/**
 * `priority: 'launch'` - fetching what a game about to be played needs: the
 * mother serves it even while a game runs (it otherwise refuses big files then).
 */
export function peerSource(
  route: PeerRoute,
  clientId: number,
  opts: { priority?: 'launch' | 'background'; deferVideos?: boolean } = {}
): PeerContentSource {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${route.token}`,
    [LAN_PROTO_HEADER]: String(LAN_PROTO),
    'X-Client-Id': String(clientId),
  };
  if (opts.priority === 'launch') headers['X-Content-Priority'] = 'launch';
  const url = (action: string, query: Record<string, string>) =>
    buildUrlWithBase(route.baseUrl, 'content', action, query);

  // Small JSON replies go through the same streaming driver as blobs, so they
  // get its TTFB/stall watchdogs and ApiError mapping for free.
  const getJson = async <T>(action: string, query: Record<string, string>, signal: AbortSignal): Promise<T> => {
    const chunks: Uint8Array[] = [];
    const total = await runDownloadUrl(url(action, query), `mother content?action=${action}`, headers, { signal }, (c) => {
      chunks.push(c);
    });
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  };

  const gameTypeQuery = (a: GameTypeFileArgs, file: string, sub: boolean): Record<string, string> => ({
    variant: a.variant,
    code: a.code,
    version: String(a.version),
    file,
    ...(sub ? { sub: '1' } : {}),
  });

  return {
    kind: 'peer',
    label: `mother ${route.baseUrl}`,
    deferVideos: opts.deferVideos,
    getInventory: (signal) => getJson<PeerInventory>('inventory', {}, signal),
    getManifest: (signal) => getJson<PeerManifest>('get_manifest', {}, signal),
    getScenarioMeta: (uniqid, signal) => getJson<ScenarioMetaResponse>('get_scenario_meta', { uniqid }, signal),
    streamScenarioMedia: (a, sink) =>
      runDownloadUrl(
        url('get_blob', { hash: a.hash }),
        `mother content?action=get_blob`,
        headers,
        { signal: a.signal, rangeStart: a.rangeStart, onProgress: a.onProgress },
        sink
      ),
    getPattern: (uniqid, signal) =>
      getJson<PatternDownloadResponse>('get_catalog', { kind: 'pattern', uniqid }, signal),
    getTeamNames: async (signal) =>
      (await getJson<{ version: number; content: string }>('get_catalog', { kind: 'team_names' }, signal)).content,
    getReportLayouts: (signal) => getJson<ReportLayoutsResponse>('get_catalog', { kind: 'report_layouts' }, signal),
    getCustomers: async (signal) =>
      (await getJson<{ version: number; content: string }>('get_catalog', { kind: 'customers' }, signal)).content,
    streamGameTypeVideo: (a, sink) =>
      runDownloadUrl(
        url('get_file', gameTypeQuery(a, a.filename, false)),
        'mother content?action=get_file',
        headers,
        { signal: a.signal, onProgress: a.onProgress },
        sink
      ),
    getGameTypeSubtitle: async (a) => {
      const chunks: Uint8Array[] = [];
      const total = await runDownloadUrl(
        url('get_file', gameTypeQuery(a, a.filename, true)),
        'mother content?action=get_file',
        headers,
        { signal: a.signal },
        (c) => {
          chunks.push(c);
        }
      );
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    },
  };
}

/** True when the mother serves /content.php (older mothers answer 404). */
export async function peerSupportsContent(route: PeerRoute, clientId: number, signal: AbortSignal): Promise<boolean> {
  try {
    const chunks: Uint8Array[] = [];
    await runDownloadUrl(
      buildUrlWithBase(route.baseUrl, 'content', 'status', {}),
      'mother content?action=status',
      { Authorization: `Bearer ${route.token}`, [LAN_PROTO_HEADER]: String(LAN_PROTO), 'X-Client-Id': String(clientId) },
      { signal, ttfbTimeoutMs: 5000, stallTimeoutMs: 5000 },
      (c) => {
        chunks.push(c);
      }
    );
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && peerErrorCode(err) === null) return false;
    throw err;
  }
}

/**
 * POST a JSON body to the mother's /content.php (satellite -> mother push).
 * Throws ApiError on a non-2xx reply.
 */
export async function peerPostJson<T>(
  route: PeerRoute,
  clientId: number,
  action: string,
  query: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  timeoutMs = 60_000
): Promise<T> {
  // A mother that drops off the Wi-Fi mid-request must not hang the caller.
  // Clearable timer, not AbortSignal.timeout(): plugin-http leaks abort
  // listeners (see api.ts).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  let res: Awaited<ReturnType<typeof tauriFetch>>;
  let text: string;
  try {
    res = await tauriFetch(buildUrlWithBase(route.baseUrl, 'content', action, query), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.token}`,
        [LAN_PROTO_HEADER]: String(LAN_PROTO),
        'X-Client-Id': String(clientId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    text = await res.text();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}
