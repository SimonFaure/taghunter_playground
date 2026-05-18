import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentSsid } from './wifi';

const POLL_MS = 10_000;
// HTTP ping is cheap; mDNS browse is ~2.5s. Wait for two consecutive ping
// failures before falling back to mDNS so we don't spam multicast on every
// poll. The next tick after a refresh resets the counter, so the worst-case
// cadence of mDNS browses while the mother is permanently down is one per
// ~20s — acceptable in exchange for keeping the steady-state path to a
// single TCP round-trip.
const FAILURE_THRESHOLD = 2;

type LocalRole = {
  is_mother_hosting: boolean;
  mother_server_running: boolean;
  paired_devices_count: number;
  paired_mothers_count: number;
};

type PairedMother = {
  mother_uuid: string;
  mother_label: string | null;
  peer_secret: string;
  paired_at: string;
  last_seen_at: string | null;
};

export type MotherConnectionState =
  | { kind: 'hidden' }
  | { kind: 'checking' }
  | { kind: 'mother_hosting'; clientCount: number }
  | { kind: 'mother_partial' }
  | { kind: 'mother_idle' }
  | { kind: 'child_ok'; motherLabel: string | null; ssid: string | null }
  | { kind: 'child_nearby' }
  | { kind: 'child_offline' };

export function useMotherConnection(): MotherConnectionState {
  const [state, setState] = useState<MotherConnectionState>({ kind: 'checking' });
  const failuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const role = await invoke<LocalRole>('client_describe_local_role').catch(
          () => null as LocalRole | null,
        );
        if (cancelled || !role) return;

        if (role.is_mother_hosting) {
          setState(
            role.mother_server_running
              ? { kind: 'mother_hosting', clientCount: role.paired_devices_count }
              : { kind: 'mother_partial' },
          );
          failuresRef.current = 0;
          return;
        }
        if (role.paired_devices_count > 0) {
          setState({ kind: 'mother_idle' });
          failuresRef.current = 0;
          return;
        }
        if (role.paired_mothers_count === 0) {
          setState({ kind: 'hidden' });
          failuresRef.current = 0;
          return;
        }

        const paired = await invoke<PairedMother[]>('client_list_paired_mothers').catch(
          () => [] as PairedMother[],
        );
        if (cancelled) return;

        let success: PairedMother | null = null;
        for (const m of paired) {
          try {
            await invoke('client_ping_mother', { motherUuid: m.mother_uuid });
            success = m;
            break;
          } catch {
            // Try the next paired mother. PingErr variants are intentionally
            // collapsed into "try the next one" — the JS layer doesn't need to
            // distinguish unauth from network from wrong_uuid; an unreachable
            // mother is an unreachable mother. The Rust side has already
            // invalidated the cache entry on WrongUuid so the next refresh
            // can re-resolve it.
          }
        }

        if (success) {
          failuresRef.current = 0;
          const ssid = await getCurrentSsid();
          if (cancelled) return;
          setState({
            kind: 'child_ok',
            motherLabel: success.mother_label,
            ssid,
          });
          return;
        }

        failuresRef.current += 1;
        if (failuresRef.current < FAILURE_THRESHOLD) {
          // One failed tick isn't enough to commit to nearby/offline — wait
          // for a second confirmation. State stays whatever it was (typically
          // the prior child_ok or the initial checking).
          return;
        }

        const refreshed = await invoke<string[]>('client_refresh_mother_endpoints').catch(
          () => [] as string[],
        );
        if (cancelled) return;
        const refreshedSet = new Set(refreshed);
        const anyPairedFound = paired.some((m) => refreshedSet.has(m.mother_uuid));
        setState({ kind: anyPairedFound ? 'child_nearby' : 'child_offline' });
        failuresRef.current = 0;
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const id = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return state;
}
