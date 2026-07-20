import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentSsid } from './wifi';
import { discoverOtherMothers } from './lanPairing';
import { getActiveLaunchedGameId } from './activeGameStore';

const POLL_MS = 10_000;
// While a game is live we ping faster so the failover snapshot the mother
// ships (slice 1) is at most this stale on every satellite. Idle reverts to
// POLL_MS to keep multicast/CPU quiet.
const ACTIVE_GAME_POLL_MS = 4_000;
// HTTP ping is cheap; mDNS browse is ~2.5s. Wait for two consecutive ping
// failures before falling back to mDNS so we don't spam multicast on every
// poll. The next tick after a refresh resets the counter, so the worst-case
// cadence of mDNS browses while the mother is permanently down is one per
// ~20s - acceptable in exchange for keeping the steady-state path to a
// single TCP round-trip.
const FAILURE_THRESHOLD = 2;

// When this device is neither a mother nor paired to one, we still want the
// footer to surface that a mother is broadcasting nearby (so the operator knows
// they can go pair). Detecting that needs an mDNS browse (~3s, multicast-heavy),
// which we must NOT run on every 10s ping tick. Throttle it to one browse per
// this interval; between browses the last result is held so the indicator
// doesn't flicker. A mother appearing/disappearing is reflected within ~one
// interval, which is fine for an informational hint.
const DISCOVER_MIN_INTERVAL_MS = 30_000;

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
  | { kind: 'mother_detected'; count: number }
  | { kind: 'child_ok'; motherLabel: string | null; ssid: string | null }
  | { kind: 'child_nearby' }
  | { kind: 'child_offline' };

// The raw "what is this device right now" booleans, straight from
// `client_describe_local_role` with no state-machine collapsing. The footer
// renders these as two plain pills: whether THIS device is the mother (it runs
// the LAN server that hosts launched games) and whether its Wi-Fi hotspot is
// broadcasting. null until the first poll resolves.
export type LocalRoleState = {
  // `mother_server_running`: the axum LAN server is up, so this device is the
  // mother hosting the games (independent of whether a hotspot is on - e.g.
  // router mode hosts without a hotspot).
  isMother: boolean;
  // `is_mother_hosting`: this device's own Wi-Fi hotspot is currently on.
  isHotspot: boolean;
} | null;

export function useLocalRole(): LocalRoleState {
  const [role, setRole] = useState<LocalRoleState>(null);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await invoke<LocalRole>('client_describe_local_role').catch(
          () => null as LocalRole | null,
        );
        if (cancelled || !r) return;
        setRole({ isMother: r.mother_server_running, isHotspot: r.is_mother_hosting });
      } finally {
        inFlight = false;
      }
    };
    // Same adaptive cadence as useMotherConnection: tighten while a game is live.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      await tick();
      if (cancelled) return;
      const interval =
        getActiveLaunchedGameId() !== null ? ACTIVE_GAME_POLL_MS : POLL_MS;
      timer = setTimeout(() => void loop(), interval);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return role;
}

export function useMotherConnection(): MotherConnectionState {
  const [state, setState] = useState<MotherConnectionState>({ kind: 'checking' });
  const failuresRef = useRef(0);
  // Epoch ms of the last mDNS browse for unpaired-mother detection (0 = never).
  const lastDiscoverRef = useRef(0);

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
        // A device paired to a mother is a SATELLITE: fall through to the ping
        // below so the mother sees us (updates last_seen → "connected") AND
        // relays queued commands (join/reconnect), even if we still carry
        // leftover paired_devices rows from a past mother role. Treat
        // paired_devices as "idle mother" ONLY when we are not a satellite -
        // otherwise the ping never runs and the mother thinks we're offline.
        if (role.paired_mothers_count === 0) {
          if (role.paired_devices_count > 0) {
            setState({ kind: 'mother_idle' });
            failuresRef.current = 0;
            return;
          }
          // Not a mother, not paired to one. Throttled mDNS browse: if a mother
          // is broadcasting nearby, surface it so the operator knows they can
          // pair. When throttled, keep the prior state so the hint doesn't
          // flicker between browses.
          failuresRef.current = 0;
          const now = Date.now();
          if (now - lastDiscoverRef.current < DISCOVER_MIN_INTERVAL_MS) return;
          lastDiscoverRef.current = now;
          const others = await discoverOtherMothers().catch(() => []);
          if (cancelled) return;
          setState(
            others.length > 0
              ? { kind: 'mother_detected', count: others.length }
              : { kind: 'hidden' },
          );
          return;
        }

        const paired = await invoke<PairedMother[]>('client_list_paired_mothers').catch(
          () => [] as PairedMother[],
        );
        if (cancelled) return;

        let success: PairedMother | null = null;
        const launchedGameId = getActiveLaunchedGameId();
        for (const m of paired) {
          try {
            await invoke('client_ping_mother', {
              motherUuid: m.mother_uuid,
              launchedGameId,
            });
            success = m;
            break;
          } catch {
            // Try the next paired mother. PingErr variants are intentionally
            // collapsed into "try the next one" - the JS layer doesn't need to
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
          // One failed tick isn't enough to commit to nearby/offline - wait
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

    // Self-scheduling loop (vs a fixed setInterval) so the cadence can tighten
    // to ACTIVE_GAME_POLL_MS while a game is live and relax to POLL_MS when idle.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      await tick();
      if (cancelled) return;
      const interval =
        getActiveLaunchedGameId() !== null ? ACTIVE_GAME_POLL_MS : POLL_MS;
      timer = setTimeout(() => void loop(), interval);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return state;
}
