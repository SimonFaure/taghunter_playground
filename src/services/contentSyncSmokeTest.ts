// LAN content sync smoke test: exercises this device's OWN /content.php (the
// local mother server must be running - i.e. this device is hosting) through
// the same peer ContentSource a satellite uses. Read-only: it never deletes or
// re-downloads anything (on one device the source and the target are the same
// database, so a real fetch needs two devices - see the plan's 2-device QA).
//
// Manual run from DevTools:
//   await window.__contentSyncSmokeTest()
//   await window.__contentSyncSmokeTest({ uniqid: '...' })   // a given scenario
//   await window.__lanSyncDiag()   // satellite: why isn't something moving?

import { ApiError, getLocalLaunchedGamesRoute } from './api';
import { getAuthUser } from './authStore';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { fetch } from '@tauri-apps/plugin-http';
import { motherRoute, peerErrorCode, peerSource, peerSupportsContent } from './contentSource';
import * as contentSyncState from './contentSyncState';
import { resolveUpdateChannel, stagedUpdateVersion } from './updateService';
import { getLaunchGate } from './syncOrchestrator';
import { lastLanSyncReport } from './peerContent';
import { PEER_INBOX_REL, listFileNames } from './contentFs';
import * as scenarioStore from './scenarioStore';

interface StepResult {
  step: string;
  ok: boolean;
  detail?: unknown;
}

export async function runContentSyncSmokeTest(opts?: { uniqid?: string }): Promise<{ passed: number; failed: number; steps: StepResult[] }> {
  const steps: StepResult[] = [];
  const check = async (step: string, fn: () => Promise<unknown>) => {
    try {
      steps.push({ step, ok: true, detail: await fn() });
    } catch (err) {
      steps.push({ step, ok: false, detail: err instanceof Error ? err.message : err });
    }
  };
  const signal = new AbortController().signal;

  const route = getLocalLaunchedGamesRoute();
  const user = await getAuthUser();
  if (!route || !user) {
    return { passed: 0, failed: 1, steps: [{ step: 'local mother server running + signed in', ok: false }] };
  }
  const src = peerSource(route, user.client_id);

  await check('status: /content.php answers', async () => {
    if (!(await peerSupportsContent(route, user.client_id, signal))) throw new Error('route missing (404)');
    return 'ok';
  });

  await check('wrong X-Client-Id is refused (403 CLIENT_MISMATCH)', async () => {
    try {
      await peerSource(route, user.client_id + 1_000_000).getScenarioMeta('x', signal);
    } catch (err) {
      if (peerErrorCode(err) === 'CLIENT_MISMATCH') return 'refused';
      throw err;
    }
    throw new Error('accepted a foreign licensee');
  });

  await check('unknown scenario → NOT_ON_MOTHER', async () => {
    try {
      await src.getScenarioMeta('__no_such_scenario__', signal);
    } catch (err) {
      if (peerErrorCode(err) === 'NOT_ON_MOTHER') return 'ok';
      throw err;
    }
    throw new Error('expected 404');
  });

  const uniqid = opts?.uniqid ?? (await scenarioStore.list({ downloaded: true }))[0]?.uniqid;
  if (!uniqid) {
    steps.push({ step: 'a downloaded scenario to test with', ok: false });
  } else {
    let firstMedia: { hash: string; size: number } | null = null;
    await check(`get_scenario_meta ${uniqid}`, async () => {
      const res = await src.getScenarioMeta(uniqid, signal);
      if (!res.data_hash || !res.files?.length || res.game_data == null) throw new Error('incomplete reply');
      const media = res.files.filter((f) => f.rel_path !== 'game-data.json' && f.available !== false && f.size > 0);
      firstMedia = media[0] ?? null;
      return { complete: res.complete, files: res.files.length, available: media.length, version: res.version };
    });
    const m = firstMedia as { hash: string; size: number } | null;
    if (m) {
      await check('get_blob Range tail → 206, exact byte count', async () => {
        const start = Math.max(0, m.size - 1024);
        let got = 0;
        await src.streamScenarioMedia(
          { uniqid, filename: '', hash: m.hash, signal, rangeStart: start, onProgress: () => {} },
          async (c) => {
            got += c.byteLength;
          }
        );
        if (start > 0 && got !== m.size - start) throw new Error(`got ${got}, expected ${m.size - start}`);
        return `${got} bytes`;
      });
      await check('get_blob past the end → 416', async () => {
        try {
          await src.streamScenarioMedia(
            { uniqid, filename: '', hash: m.hash, signal, rangeStart: m.size + 10, onProgress: () => {} },
            async () => {}
          );
        } catch (err) {
          if (err instanceof ApiError && err.status === 416) return 'ok';
          throw err;
        }
        throw new Error('expected 416');
      });
    }
  }

  await check('bad blob hash → 400', async () => {
    try {
      await src.streamScenarioMedia(
        { uniqid: '', filename: '', hash: '../../etc/passwd', signal, rangeStart: 0, onProgress: () => {} },
        async () => {}
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) return 'ok';
      throw err;
    }
    throw new Error('expected 400');
  });

  const passed = steps.filter((s) => s.ok).length;
  return { passed, failed: steps.length - passed, steps };
}

/**
 * Why isn't content / an update moving between this device and its mother?
 * Read-only. Run on the satellite (also works on the mother: no route then).
 *   await window.__lanSyncDiag()
 */
export async function lanSyncDiag(): Promise<Record<string, unknown>> {
  const user = await getAuthUser();
  const mine = await contentSyncState.get();
  const out: Record<string, unknown> = {
    app_version: await getVersion().catch(() => '?'),
    // approx = true: the studio sent no server_time (old PHP) - snapshots
    // can't be ordered, only scenarios a side lacks entirely move.
    snapshot: mine && { as_of: mine.cloud_as_of_ms && new Date(mine.cloud_as_of_ms).toISOString(), approx: !!mine.approx, source: mine.source, rev: mine.content_rev },
    update_cache: await invoke('update_cache_status').catch((e) => String(e)),
    staged_update: await stagedUpdateVersion().catch(() => null),
  };
  out.launch_gate = getLaunchGate();
  out.last_lan_sync = lastLanSyncReport();
  const route = motherRoute();
  if (!route || !user) {
    out.mother = route ? 'not signed in' : 'none (not routed to a mother, or this device is the mother)';
    // On the mother: what satellites pushed and is waiting to be committed.
    out.inbox_scenarios = await listFileNames(`${PEER_INBOX_REL}/scenarios`);
    out.inbox_manifest = await contentSyncState.inboxAsOf().then((t) => (t ? new Date(t).toISOString() : null));
    out.rows_not_downloaded = (await scenarioStore.list()).filter((s) => s.local_version === null).map((s) => s.title);
    return out;
  }
  out.mother = route.baseUrl;
  const signal = new AbortController().signal;
  try {
    if (!(await peerSupportsContent(route, user.client_id, signal))) {
      out.mother_content = 'mother app too old: no /content.php';
      return out;
    }
    const inv = await peerSource(route, user.client_id).getInventory(signal);
    out.mother_snapshot = { as_of: inv.cloud_as_of_ms && new Date(inv.cloud_as_of_ms).toISOString(), approx: inv.approx, game_active: inv.game_active };
    const here = await scenarioStore.list({ downloaded: true });
    const there = new Map(inv.scenarios.map((s) => [s.uniqid, s]));
    out.scenarios_only_here = here.filter((s) => !there.has(s.uniqid)).map((s) => s.title);
    out.scenarios_only_on_mother = inv.scenarios.filter((m) => !here.some((s) => s.uniqid === m.uniqid)).map((m) => m.uniqid);
    out.scenarios_differing = here
      .filter((s) => there.has(s.uniqid) && there.get(s.uniqid)!.hash !== s.local_content_hash)
      .map((s) => s.title);
    out.scenarios_here_without_full_file_list = [];
    for (const s of here) {
      if (s.local_content_hash && !(await scenarioStore.listRemoteFiles(s.uniqid, s.local_content_hash)).length) {
        (out.scenarios_here_without_full_file_list as string[]).push(s.title);
      }
    }
  } catch (e) {
    out.mother_content = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    const res = await fetch(`${route.baseUrl}/update.php?action=check&target=windows&arch=x86_64&current_version=0.0.0&channel=${await resolveUpdateChannel()}`);
    out.mother_update_offer = res.ok ? await res.json() : `HTTP ${res.status} (mother app too old for /update.php?)`;
  } catch (e) {
    out.mother_update_offer = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return out;
}

declare global {
  interface Window {
    __contentSyncSmokeTest?: typeof runContentSyncSmokeTest;
    __lanSyncDiag?: typeof lanSyncDiag;
  }
}

if (typeof window !== 'undefined') {
  window.__contentSyncSmokeTest = runContentSyncSmokeTest;
  window.__lanSyncDiag = lanSyncDiag;
}
