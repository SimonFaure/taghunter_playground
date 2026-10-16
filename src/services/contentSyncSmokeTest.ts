// LAN content sync smoke test: exercises this device's OWN /content.php (the
// local mother server must be running - i.e. this device is hosting) through
// the same peer ContentSource a satellite uses. Read-only: it never deletes or
// re-downloads anything (on one device the source and the target are the same
// database, so a real fetch needs two devices - see the plan's 2-device QA).
//
// Manual run from DevTools:
//   await window.__contentSyncSmokeTest()
//   await window.__contentSyncSmokeTest({ uniqid: '...' })   // a given scenario

import { ApiError, getLocalLaunchedGamesRoute } from './api';
import { getAuthUser } from './authStore';
import { peerErrorCode, peerSource, peerSupportsContent } from './contentSource';
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

declare global {
  interface Window {
    __contentSyncSmokeTest?: typeof runContentSyncSmokeTest;
  }
}

if (typeof window !== 'undefined') {
  window.__contentSyncSmokeTest = runContentSyncSmokeTest;
}
