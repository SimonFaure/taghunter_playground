// Slice C manual hotspot test. Intentionally separate from
// `runLanSmokeTest()` because starting a real AP on Windows briefly drops
// any Wi-Fi clients on the same adapter and may prompt for elevation. The
// user should invoke this only when they're ready.
//
// Manual run from DevTools (default credentials):
//   await window.__lanHotspotTest()
//
// Or with explicit credentials:
//   await window.__lanHotspotTest({ ssid: 'TagHunter-Lab', password: 'pass1234' })
//
// On non-Windows hosts this returns the platform string and a typed
// "not implemented" error so the user knows what to expect.

import { invoke } from '@tauri-apps/api/core';

interface HotspotInfo {
  ssid: string;
  password: string;
  ipv4_addresses: string[];
  platform: string;
}

interface HotspotStatus {
  running: boolean;
  ssid: string | null;
  ipv4_addresses: string[];
  platform: string;
}

interface StepResult {
  step: string;
  ok: boolean;
  detail?: unknown;
}

export interface HotspotTestReport {
  passed: number;
  failed: number;
  steps: StepResult[];
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function defaultSsid(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `TagHunter-${suffix}`;
}

function defaultPassword(): string {
  // Alphanumeric only — avoids escape rules in the WIFI: QR format.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export async function runLanHotspotTest(opts?: {
  ssid?: string;
  password?: string;
  /** Skip the start step; only query status (safe to run any time). */
  statusOnly?: boolean;
}): Promise<HotspotTestReport> {
  const ssid = opts?.ssid ?? defaultSsid();
  const password = opts?.password ?? defaultPassword();
  const steps: StepResult[] = [];
  const record = (step: string, ok: boolean, detail?: unknown) =>
    steps.push({ step, ok, detail });

  // Initial status (always safe).
  const before = (await invoke('mother_hotspot_status')) as HotspotStatus;
  record('mother_hotspot_status(before)', true, before);

  if (opts?.statusOnly) {
    return summarize(steps);
  }

  if (before.platform !== 'windows') {
    record('platform_not_supported', false, {
      platform: before.platform,
      hint: 'slice C is Windows-only; slice D adds Android. Skipping start.',
    });
    return summarize(steps);
  }

  let started = false;
  try {
    const info = (await invoke('mother_start_hotspot', { ssid, password })) as HotspotInfo;
    assert(info.ssid === ssid, 'start returned the requested SSID');
    assert(info.password === password, 'start returned the requested password');
    record('mother_start_hotspot', true, info);
    started = true;

    // Give Windows a moment to settle the AP interface before checking status.
    await new Promise((r) => setTimeout(r, 1500));

    const after = (await invoke('mother_hotspot_status')) as HotspotStatus;
    assert(after.running, 'status reports running after start');
    if (after.ssid) {
      assert(after.ssid === ssid, 'status reports correct SSID');
    }
    record('mother_hotspot_status(running)', true, after);
  } catch (e) {
    record('mother_start_hotspot', false, (e as Error).message);
    throw e;
  } finally {
    if (started) {
      try {
        await invoke('mother_stop_hotspot');
        record('mother_stop_hotspot', true);
      } catch (e) {
        record('mother_stop_hotspot', false, (e as Error).message);
      }
      try {
        const final = (await invoke('mother_hotspot_status')) as HotspotStatus;
        record('mother_hotspot_status(after)', !final.running, final);
      } catch (e) {
        record('mother_hotspot_status(after)', false, (e as Error).message);
      }
    }
  }

  return summarize(steps);
}

function summarize(steps: StepResult[]): HotspotTestReport {
  const failed = steps.filter((s) => !s.ok).length;
  return { passed: steps.length - failed, failed, steps };
}

declare global {
  interface Window {
    __lanHotspotTest?: typeof runLanHotspotTest;
  }
}

if (typeof window !== 'undefined') {
  window.__lanHotspotTest = runLanHotspotTest;
}
