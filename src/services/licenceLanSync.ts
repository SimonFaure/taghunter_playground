// The licence ("Accès hors ligne N jours restants") shared between the
// licensee's devices on the LAN: one device reaching the studio renews the
// offline allowance of all of them. The exchange itself is Rust-side, on every
// /ping.php (src-tauri/src/licence_sync.rs); this module is the renderer's end:
//  - onLicenceAdopted: a peer's newer licence replaced ours (AuthProvider
//    re-reads it, the offline lock screen unlocks);
//  - startLicenceLanWatch: the offline lock screen's own search for a peer,
//    since the app shell - and with it the regular ping loop - isn't mounted
//    there.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const LICENCE_ADOPTED_EVENT = 'taghunter://licence-adopted';

const WATCH_TICK_MS = 10_000;
// Pairing needs an mDNS browse (~3 s, multicast); not on every tick.
const DISCOVER_MIN_INTERVAL_MS = 30_000;

export function onLicenceAdopted(cb: () => void): () => void {
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen(LICENCE_ADOPTED_EVENT, () => cb()).then((fn) => {
    if (cancelled) fn();
    else off = fn;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

type PairedMother = { mother_uuid: string };

async function pingForLicence(motherUuid: string): Promise<boolean> {
  try {
    await invoke('client_ping_mother', { motherUuid, launchedGameId: null, licenceOnly: true });
    return true;
  } catch (e) {
    if ((e as { kind?: string })?.kind !== 'not_cached') return false;
  }
  // Endpoint not resolved yet: browse once, then retry.
  await invoke('client_refresh_mother_endpoints', { timeoutMs: 2500 }).catch(() => {});
  try {
    await invoke('client_ping_mother', { motherUuid, launchedGameId: null, licenceOnly: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * While the device is locked for having been offline too long, look for a
 * device of the same licensee whose licence is fresher. A reply carrying one
 * makes Rust emit the adopted event, which AuthProvider turns into a re-check.
 *  - A device hosting the games is pinged like any satellite would.
 *  - Nobody hosting and this device is the mother: start its server, so the
 *    satellites' own pings bring their licence to it.
 * Returns the stop function.
 */
export function startLicenceLanWatch(clientId: number): () => void {
  let cancelled = false;
  let inFlight = false;
  let lastDiscoverAt = 0;

  const tick = async () => {
    if (cancelled || inFlight) return;
    inFlight = true;
    try {
      // Already serving (started on an earlier tick): satellites come to us.
      const serving = await invoke<unknown | null>('mother_get_server_info').catch(() => null);
      if (serving) return;

      let paired = await invoke<PairedMother[]>('client_list_paired_mothers').catch(
        () => [] as PairedMother[]
      );
      for (const m of paired) {
        if (cancelled) return;
        if (await pingForLicence(m.mother_uuid)) return;
      }

      if (Date.now() - lastDiscoverAt < DISCOVER_MIN_INTERVAL_MS) return;
      lastDiscoverAt = Date.now();
      const { autoJoinSameClientMother, ensureMotherServer } = await import('./lanMotherBoot');
      if (await autoJoinSameClientMother(clientId).catch(() => false)) {
        paired = await invoke<PairedMother[]>('client_list_paired_mothers').catch(
          () => [] as PairedMother[]
        );
        for (const m of paired) {
          if (cancelled) return;
          if (await pingForLicence(m.mother_uuid)) return;
        }
        return;
      }
      const { isConfiguredMother } = await import('./deviceRole');
      if (!cancelled && (await isConfiguredMother())) {
        await ensureMotherServer(clientId);
      }
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const id = setInterval(() => void tick(), WATCH_TICK_MS);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}
