// Satellite side of LAN content sync, for a venue with no internet:
//  - at join: fetch a scenario this device never synced from the mother it is
//    routed to (fetchScenarioFromMother);
//  - in the background: pull the mother's newer cloud snapshot and the content
//    it holds (syncFromMotherNow), when the mother's content revision moves on
//    its ping, and every few minutes.
// The heavy lifting (download, sha256 verify, commit) is syncOrchestrator's,
// with a peer ContentSource.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ApiError } from './api';
import { getAuthUser } from './authStore';
import { blobExists, readTextRel, teamNamesFileRel } from './contentFs';
import * as contentSyncState from './contentSyncState';
import {
  motherRoute,
  peerErrorCode,
  peerPostJson,
  peerSource,
  peerSupportsContent,
  type PeerInventory,
  type PeerRoute,
} from './contentSource';
import * as namePoolsStore from './namePoolsStore';
import * as patternStore from './patternStore';
import * as reportLayoutsStore from './reportLayoutsStore';
import * as scenarioStore from './scenarioStore';
import { fetchScenarioFromSource, runPeerSync, type PeerFetchProgress } from './syncOrchestrator';
import { pushInstallerToMother } from './updateService';

export { motherRoute };
import { emit } from './syncEvents';
import { scheduleInboxCommit } from './peerInbox';
import { loadConfig } from '../utils/config';

export type MotherFetchFailure =
  | 'no_mother' // not routed to a mother (or this device IS the mother)
  | 'mother_outdated' // the mother's app predates /content.php
  | 'not_on_mother' // the mother doesn't have the scenario either
  | 'client_mismatch' // the mother belongs to another licensee
  | 'network' // unreachable / timed out / anything else
  | 'cancelled';

export type MotherFetchResult = { ok: true; complete: boolean } | { ok: false; reason: MotherFetchFailure };

function classify(err: unknown): MotherFetchFailure {
  if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
  const code = peerErrorCode(err);
  if (code === 'NOT_ON_MOTHER' || code === 'NOT_DOWNLOADED') return 'not_on_mother';
  if (code === 'CLIENT_MISMATCH') return 'client_mismatch';
  if (err instanceof ApiError && err.status === 426) return 'mother_outdated';
  return 'network';
}

/**
 * Download `uniqid` (and the game's pattern when given) from the mother.
 * `complete: false` = launchable, but some videos are still missing.
 */
export async function fetchScenarioFromMother(
  uniqid: string,
  opts: { patternUniqid?: string | null; signal?: AbortSignal; onProgress?: (p: PeerFetchProgress) => void } = {}
): Promise<MotherFetchResult> {
  const route = motherRoute();
  if (!route) return { ok: false, reason: 'no_mother' };
  const user = await getAuthUser();
  if (!user) return { ok: false, reason: 'client_mismatch' };
  const signal = opts.signal ?? new AbortController().signal;
  try {
    if (!(await peerSupportsContent(route, user.client_id, signal))) {
      return { ok: false, reason: 'mother_outdated' };
    }
  } catch (err) {
    return { ok: false, reason: classify(err) };
  }
  const out = await fetchScenarioFromSource(uniqid, peerSource(route, user.client_id, { priority: 'launch' }), {
    patternUniqid: opts.patternUniqid,
    signal,
    onProgress: opts.onProgress,
  });
  if (out.status === 'missing') return { ok: false, reason: classify(out.error) };
  return { ok: true, complete: out.status === 'full' };
}

// ---------- background sync ----------

const PEER_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
let syncInFlight: Promise<void> | null = null;
let lastSyncAt = 0;
let lastSeenRev: number | null = null;
// Whether a mother (by base URL) serves /content.php: an old one won't start
// to mid-session, so ask once.
const contentCaps = new Map<string, boolean>();

/** Pull newer content from the mother now. Coalesced; never throws. */
export function syncFromMotherNow(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      const route = motherRoute();
      const user = await getAuthUser();
      if (!route || !user) return;
      lastSyncAt = Date.now();
      let caps = contentCaps.get(route.baseUrl);
      if (caps === undefined) {
        caps = await peerSupportsContent(route, user.client_id, new AbortController().signal);
        contentCaps.set(route.baseUrl, caps);
      }
      if (!caps) return;
      const source = peerSource(route, user.client_id, { priority: 'background' });
      // Each step on its own: one failing (a busy mother, a dropped request)
      // must not cost the others their turn.
      const step = async (name: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (e) {
          console.warn(`[peerContent] ${name} with ${route.baseUrl} failed:`, e);
        }
      };
      await step('content pull', async () => {
        if (await runPeerSync(source)) console.log(`[peerContent] synced content from ${route.baseUrl}`);
      });
      // The other direction: what WE hold that the mother lacks (we synced
      // with the studio more recently than it did).
      await step('content push', async () => {
        const inv = await source.getInventory(new AbortController().signal);
        const pushed = await pushToMother(route, user.client_id, inv);
        if (pushed) console.log(`[peerContent] pushed ${pushed} item(s) to ${route.baseUrl}`);
      });
      // Chips: both lists and unpushed edits, merged per chip (cards_sync.rs).
      await step('chip exchange', async () => {
        const cards = await invoke<{ changed: number }>('client_cards_exchange', {
          baseUrl: route.baseUrl,
          token: route.token,
          clientId: user.client_id,
        });
        if (cards.changed > 0) emit('content:updated', { kind: 'cards', ids: [user.client_id] });
      });
      // A newer app installer we hold, for the mother to offer the others.
      await step('installer push', async () => {
        if (await pushInstallerToMother(route, user.client_id)) {
          console.log(`[peerContent] handed our app installer to ${route.baseUrl}`);
        }
      });
    } catch (e) {
      console.warn('[peerContent] sync from mother failed:', e);
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

/** The periodic call, from the App tick of a device that is not hosting. */
export async function peerContentTick(): Promise<void> {
  if (Date.now() - lastSyncAt < PEER_SYNC_MIN_INTERVAL_MS) return;
  await syncFromMotherNow();
}

/**
 * Pull as soon as the mother's content revision moves (it rides on every
 * /ping.php reply; the first one seen also triggers, i.e. on joining a mother),
 * and, as a mother, commit what satellites push. Returns the unlisten function.
 */
export function installPeerContentSync(): () => void {
  const unlisteners: Array<() => void> = [];
  let cancelled = false;
  const keep = (fn: () => void) => {
    if (cancelled) fn();
    else unlisteners.push(fn);
  };
  void listen<number>('taghunter://mother-content-rev', (event) => {
    const rev = event.payload;
    if (rev === lastSeenRev) return;
    lastSeenRev = rev;
    void syncFromMotherNow();
  }).then(keep);
  // Mother side: a satellite pushed content to us (services/peerInbox), or
  // merged its chip list/edits into ours.
  void listen('taghunter://content-inbox', () => scheduleInboxCommit()).then(keep);
  void listen('taghunter://cards-merged', () => {
    void getAuthUser().then((u) => {
      if (u) emit('content:updated', { kind: 'cards', ids: [u.client_id] });
    });
  }).then(keep);
  // Something staged before a restart, or that waited for the operator's go.
  const boot = setTimeout(() => scheduleInboxCommit(0), 20_000);
  return () => {
    cancelled = true;
    clearTimeout(boot);
    for (const fn of unlisteners) fn();
  };
}

// ---------- push to the mother ----------

/**
 * Hand the mother what this device holds and it lacks, when our cloud
 * snapshot is at least as recent as the mother's: the snapshot itself (the
 * mother adopts it if newer), then each scenario (blobs first, uploaded by
 * Rust from disk; its meta last) and catalog it doesn't hold at our version.
 * The mother commits through its own sync path (services/peerInbox). Big
 * uploads wait while the mother hosts a running game. Returns items pushed.
 */
async function pushToMother(route: PeerRoute, clientId: number, inv: PeerInventory): Promise<number> {
  if (inv.client_id !== clientId) return 0;
  const mine = await contentSyncState.get();
  if (!mine || mine.client_id !== clientId || mine.cloud_as_of_ms === null || mine.approx || !mine.manifest_json) return 0;
  // The mother saw the cloud after us: our copies may be stale for it.
  if (inv.cloud_as_of_ms !== null && inv.cloud_as_of_ms > mine.cloud_as_of_ms) return 0;

  let pushed = 0;
  if (inv.cloud_as_of_ms === null || mine.cloud_as_of_ms > inv.cloud_as_of_ms) {
    const res = await peerPostJson<{ accepted: boolean }>(route, clientId, 'offer_manifest', {}, {
      client_id: clientId,
      cloud_as_of_ms: mine.cloud_as_of_ms,
      approx: false,
      manifest: JSON.parse(mine.manifest_json),
    });
    if (res.accepted) pushed += 1;
  }

  // Catalogs, held here at the version our manifest wants.
  const names = await namePoolsStore.get(clientId);
  if (names?.local_version != null && names.local_version === names.remote_version && inv.team_names !== names.local_version) {
    const content = await readTextRel(teamNamesFileRel());
    if (content !== null) {
      await peerPostJson(route, clientId, 'put_catalog', { kind: 'team_names' }, { version: names.local_version, content });
      pushed += 1;
    }
  }
  const layouts = await reportLayoutsStore.getState();
  if (layouts?.local_version != null && layouts.local_version === layouts.remote_version && inv.report_layouts !== layouts.local_version) {
    await peerPostJson(route, clientId, 'put_catalog', { kind: 'report_layouts' }, {
      version: layouts.local_version,
      layouts: await reportLayoutsStore.listAll(),
    });
    pushed += 1;
  }
  for (const p of await patternStore.list()) {
    if (p.is_local || p.local_version == null || p.local_version !== p.remote_version) continue;
    if (inv.patterns.some((ip) => ip.uniqid === p.pattern_uniqid && ip.version === p.local_version)) continue;
    const payload = await patternStore.exportForPeer(p.pattern_uniqid);
    if (!payload) continue;
    await peerPostJson(route, clientId, 'put_catalog', { kind: 'pattern' }, payload);
    pushed += 1;
  }

  // Scenarios: an operator-only device holds only a subset of each one's
  // media, and big uploads would compete with a running game's traffic.
  const config = await loadConfig().catch(() => null);
  if (config?.operatorOnlyDevice || inv.game_active) return pushed;
  for (const s of await scenarioStore.list({ downloaded: true })) {
    const hash = s.local_content_hash;
    if (!hash || hash !== s.remote_content_hash) continue;
    if (inv.scenarios.some((m) => m.uniqid === s.uniqid && m.complete && m.hash === hash)) continue;
    if (await pushScenario(route, clientId, s.uniqid, hash, s)) pushed += 1;
  }
  return pushed;
}

async function pushScenario(
  route: PeerRoute,
  clientId: number,
  uniqid: string,
  hash: string,
  row: scenarioStore.ScenarioRow
): Promise<boolean> {
  // The full list the studio sent for this hash (a scenario synced before the
  // LAN feature has none until its next studio sync).
  const files = await scenarioStore.listRemoteFiles(uniqid, hash);
  const gameDataEntry = files.find((f) => f.rel_path === 'game-data.json');
  if (!gameDataEntry) return false;
  const media = files.filter((f) => f.rel_path !== 'game-data.json');
  for (const f of media) {
    if (!(await blobExists(f.hash))) return false;
  }
  const gameData = await scenarioStore.getGameData(uniqid);
  if (gameData == null) return false;

  const { missing } = await peerPostJson<{ missing: Array<{ hash: string; have: number }> }>(
    route, clientId, 'missing_blobs', {}, { hashes: media.map((f) => f.hash) }
  );
  for (const m of missing) {
    const res = await invoke<{ done?: boolean }>('client_push_blob', {
      baseUrl: route.baseUrl,
      token: route.token,
      clientId,
      hash: m.hash,
      offset: m.have,
    });
    if (!res?.done) return false;
  }
  await peerPostJson(route, clientId, 'put_scenario_meta', {}, {
    scenario: { uniqid, name: row.title, scenario_type: row.game_type },
    title: row.title,
    game_type: row.game_type,
    is_product: row.is_product,
    version: row.local_version,
    remote_version: row.remote_version,
    remote_content_hash: row.remote_content_hash,
    complete: true,
    content_hash: hash,
    game_data: gameData,
    data_hash: gameDataEntry.hash,
    files: files.map((f) => ({ rel_path: f.rel_path, hash: f.hash, size: f.size ?? 0, available: true })),
    medias: null,
  });
  return true;
}
