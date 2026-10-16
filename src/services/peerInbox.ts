// Mother side of LAN content sync: commit what a satellite pushed to us.
//
// The Rust content server stages a satellite's pushes (content_server.rs): a
// newer cloud snapshot in content_sync_state.inbox_*, media blobs straight
// into the pool (sha256-verified), and scenario metas / catalogs as JSON under
// media/peer_inbox/. This module presents that staging area as one more peer
// ContentSource, so syncOrchestrator.runPeerSync commits it through exactly
// the same path as a pull from a mother: adopt the snapshot if strictly newer,
// then take whatever is staged at the version our manifest wants.

import { getAuthUser } from './authStore';
import { getDb } from './db';
import { PEER_INBOX_REL, listFileNames, readTextRel, removeRecursive } from './contentFs';
import type {
  PatternDownloadResponse,
  PeerContentSource,
  PeerInventory,
  ReportLayoutsResponse,
  ScenarioMetaResponse,
} from './contentSource';
import * as contentSyncState from './contentSyncState';
import * as namePoolsStore from './namePoolsStore';
import * as reportLayoutsStore from './reportLayoutsStore';
import { getState as getOrchestratorState, runPeerSync } from './syncOrchestrator';

const SCENARIOS_REL = `${PEER_INBOX_REL}/scenarios`;
const PATTERNS_REL = `${PEER_INBOX_REL}/patterns`;
const TEAM_NAMES_REL = `${PEER_INBOX_REL}/team_names.json`;
const REPORT_LAYOUTS_REL = `${PEER_INBOX_REL}/report_layouts.json`;

async function readStaged<T>(rel: string): Promise<T | null> {
  const text = await readTextRel(rel);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readInboxManifest(): Promise<{ asOf: number; manifest: unknown } | null> {
  const db = await getDb();
  const rows = await db.select<Array<{ inbox_manifest_json: string | null; inbox_as_of_ms: number | null }>>(
    'SELECT inbox_manifest_json, inbox_as_of_ms FROM content_sync_state WHERE id = 1'
  );
  const r = rows[0];
  if (!r?.inbox_manifest_json || r.inbox_as_of_ms === null) return null;
  try {
    return { asOf: r.inbox_as_of_ms, manifest: JSON.parse(r.inbox_manifest_json) };
  } catch {
    return null;
  }
}

const notStaged = (what: string) => Promise.reject(new Error(`${what} is not staged in the peer inbox`));

function inboxSource(clientId: number): PeerContentSource {
  return {
    kind: 'peer',
    label: 'peer inbox',
    getInventory: async () => {
      const inbox = await readInboxManifest();
      const scenarios: PeerInventory['scenarios'] = [];
      for (const name of await listFileNames(SCENARIOS_REL)) {
        if (!name.endsWith('.json')) continue;
        const meta = await readStaged<ScenarioMetaResponse>(`${SCENARIOS_REL}/${name}`);
        if (meta?.scenario?.uniqid && meta.content_hash) {
          scenarios.push({ uniqid: meta.scenario.uniqid, hash: meta.content_hash, complete: true });
        }
      }
      const patterns: PeerInventory['patterns'] = [];
      for (const name of await listFileNames(PATTERNS_REL)) {
        if (!name.endsWith('.json')) continue;
        const p = await readStaged<PatternDownloadResponse>(`${PATTERNS_REL}/${name}`);
        if (p?.pattern_uniqid && typeof p.version === 'number') patterns.push({ uniqid: p.pattern_uniqid, version: p.version });
      }
      const names = await readStaged<{ version: number }>(TEAM_NAMES_REL);
      const layouts = await readStaged<{ version: number }>(REPORT_LAYOUTS_REL);
      return {
        client_id: clientId,
        cloud_as_of_ms: inbox?.asOf ?? null,
        approx: false,
        content_rev: 0,
        // Staged content is already on this device: nothing to hold back.
        game_active: false,
        scenarios,
        patterns,
        team_names: names?.version ?? null,
        report_layouts: layouts?.version ?? null,
        game_types: [],
        overrides: [],
      };
    },
    getManifest: async () => {
      const inbox = await readInboxManifest();
      if (!inbox) throw new Error('no staged manifest');
      return { client_id: clientId, cloud_as_of_ms: inbox.asOf, approx: false, manifest: inbox.manifest };
    },
    getScenarioMeta: async (uniqid) => {
      const meta = await readStaged<ScenarioMetaResponse>(`${SCENARIOS_REL}/${uniqid}.json`);
      return meta ?? notStaged(`scenario ${uniqid}`);
    },
    // Pushed blobs land in the pool before the meta is staged; a blob still
    // missing here simply wasn't pushed.
    streamScenarioMedia: (a) => notStaged(`blob ${a.hash}`),
    getPattern: async (uniqid) => {
      const p = await readStaged<PatternDownloadResponse>(`${PATTERNS_REL}/${uniqid}.json`);
      return p ?? notStaged(`pattern ${uniqid}`);
    },
    getTeamNames: async () => {
      const t = await readStaged<{ content: string }>(TEAM_NAMES_REL);
      return t?.content ?? notStaged('team names');
    },
    getReportLayouts: async () => {
      const l = await readStaged<ReportLayoutsResponse>(REPORT_LAYOUTS_REL);
      return l ?? notStaged('report layouts');
    },
    streamGameTypeVideo: () => notStaged('game-type video'),
    getGameTypeSubtitle: () => notStaged('game-type subtitles'),
  };
}

// Drop what has been committed or can no longer be: an inbox manifest not
// newer than ours, a staged item we now hold, and - unless a newer staged
// snapshot (still waiting, e.g. for the operator's go) may want it - one our
// manifest doesn't want.
async function pruneInbox(): Promise<void> {
  const db = await getDb();
  const mine = await contentSyncState.get();
  const inbox = await readInboxManifest();
  const mineAsOf = mine?.cloud_as_of_ms ?? null;
  if (inbox && mineAsOf !== null && inbox.asOf <= mineAsOf) {
    await db.execute('UPDATE content_sync_state SET inbox_manifest_json = NULL, inbox_as_of_ms = NULL WHERE id = 1');
  }
  const newerPending = inbox !== null && (mineAsOf === null || inbox.asOf > mineAsOf);
  for (const name of await listFileNames(SCENARIOS_REL)) {
    const rel = `${SCENARIOS_REL}/${name}`;
    const meta = await readStaged<ScenarioMetaResponse>(rel);
    const uniqid = meta?.scenario?.uniqid;
    const rows = uniqid
      ? await db.select<Array<{ local_content_hash: string | null; remote_content_hash: string | null }>>(
          'SELECT local_content_hash, remote_content_hash FROM scenarios WHERE uniqid = $1',
          [uniqid]
        )
      : [];
    const row = rows[0];
    const held = !!meta && row?.local_content_hash === meta.content_hash;
    const unwanted = !meta || !row || row.remote_content_hash !== meta.content_hash;
    if (held || (unwanted && !newerPending)) await removeRecursive(rel).catch(() => {});
  }
  for (const name of await listFileNames(PATTERNS_REL)) {
    const rel = `${PATTERNS_REL}/${name}`;
    const p = await readStaged<PatternDownloadResponse>(rel);
    const rows = p
      ? await db.select<Array<{ local_version: number | null; remote_version: number }>>(
          'SELECT local_version, remote_version FROM patterns WHERE pattern_uniqid = $1',
          [p.pattern_uniqid]
        )
      : [];
    const row = rows[0];
    const held = !!p && row?.local_version === p.version;
    const unwanted = !p || !row || row.remote_version !== p.version;
    if (held || (unwanted && !newerPending)) await removeRecursive(rel).catch(() => {});
  }
  // Single-file catalogs: gone once we hold that version (or newer).
  const user = await getAuthUser();
  const names = await readStaged<{ version: number }>(TEAM_NAMES_REL);
  const namesState = user ? await namePoolsStore.get(user.client_id) : null;
  if (names && namesState?.local_version != null && namesState.local_version >= names.version) {
    await removeRecursive(TEAM_NAMES_REL).catch(() => {});
  }
  const layouts = await readStaged<{ version: number }>(REPORT_LAYOUTS_REL);
  const layoutsState = await reportLayoutsStore.getState();
  if (layouts && layoutsState?.local_version != null && layoutsState.local_version >= layouts.version) {
    await removeRecursive(REPORT_LAYOUTS_REL).catch(() => {});
  }
}

let runInFlight: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Commit what satellites pushed. Coalesced; never throws. */
export function commitPeerInboxNow(): Promise<void> {
  if (runInFlight) return runInFlight;
  runInFlight = (async () => {
    try {
      const user = await getAuthUser();
      if (!user) return;
      // A cloud cycle owns the stores right now: come back once it's done.
      if (getOrchestratorState().cycleInFlight) {
        scheduleInboxCommit(30_000);
        return;
      }
      const did = await runPeerSync(inboxSource(user.client_id));
      if (did) console.log('[peerInbox] committed content pushed by a satellite');
      await pruneInbox();
    } catch (e) {
      console.warn('[peerInbox] commit failed:', e);
    } finally {
      runInFlight = null;
    }
  })();
  return runInFlight;
}

/** Debounced: a satellite pushes several items in a row. */
export function scheduleInboxCommit(delayMs = 3000): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void commitPeerInboxNow();
  }, delayMs);
}
