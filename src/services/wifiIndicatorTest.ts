// DevTools-runnable manual test for the footer's LAN-mode wifi indicator.
//
// Manual run from DevTools:
//   await window.__wifiIndicatorTest()
//
// Reports: the LocalRole the footer is branching on, the cached endpoints,
// each paired mother's ping result, and a mDNS refresh round-trip. Use this
// to inspect why the footer is showing the state it is — every input the
// state machine sees is reproduced here.

import { invoke } from '@tauri-apps/api/core';

interface LocalRole {
  is_mother_hosting: boolean;
  mother_server_running: boolean;
  paired_devices_count: number;
  paired_mothers_count: number;
}

interface PairedMother {
  mother_uuid: string;
  mother_label: string | null;
  peer_secret: string;
  paired_at: string;
  last_seen_at: string | null;
}

interface PingOutcome {
  mother_uuid: string;
  mother_label: string | null;
  ok: boolean;
  error?: unknown;
}

export interface WifiIndicatorReport {
  role: LocalRole | null;
  paired: PairedMother[];
  pings: PingOutcome[];
  refreshed: string[];
}

export async function runWifiIndicatorTest(): Promise<WifiIndicatorReport> {
  const role = await invoke<LocalRole>('client_describe_local_role').catch(() => null);
  const paired = await invoke<PairedMother[]>('client_list_paired_mothers').catch(
    () => [] as PairedMother[],
  );

  const pings: PingOutcome[] = [];
  for (const m of paired) {
    try {
      await invoke('client_ping_mother', { motherUuid: m.mother_uuid });
      pings.push({ mother_uuid: m.mother_uuid, mother_label: m.mother_label, ok: true });
    } catch (e) {
      pings.push({
        mother_uuid: m.mother_uuid,
        mother_label: m.mother_label,
        ok: false,
        error: e,
      });
    }
  }

  const refreshed = await invoke<string[]>('client_refresh_mother_endpoints').catch(
    () => [] as string[],
  );

  return { role, paired, pings, refreshed };
}

declare global {
  interface Window {
    __wifiIndicatorTest?: typeof runWifiIndicatorTest;
  }
}

if (typeof window !== 'undefined') {
  window.__wifiIndicatorTest = runWifiIndicatorTest;
}
