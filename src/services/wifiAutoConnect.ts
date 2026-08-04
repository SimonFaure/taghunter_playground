// Auto-connect engine - joins the mother's Wi-Fi from remembered creds so the
// operator doesn't hand-connect every satellite. Design: plans/playground-hotspot-autojoin.md.
//
// Reads `wifi_networks` (populated by Feature A's ping piggyback, later Feature
// B's studio relay) regardless of origin. Triggered on app launch (silent, only
// already-consented networks) and in the join/LAN context (may surface the
// one-time consent prompt for a never-seen network).
//
// Guards (Q2): never while THIS device is hosting a hotspot; never when there
// are no remembered networks (a non-satellite device). One attempt per call -
// no retry loop; a failed join returns `failed` so the UI can fall back to the
// manual SSID/QR.

import { platform } from '@tauri-apps/plugin-os';
import { describeLocalRole, discoverOtherMothers, type DiscoveredMother } from './lanPairing';
import { refreshMotherEndpoints } from './lanPairing';
import {
  getCurrentSsid, scanWifi, connectWifi, maybeRenewDhcpIfStuck,
  isStuckOnApipa, assignStaticIp,
} from './wifi';
import * as wifiNetworksStore from './wifiNetworksStore';
import { autoJoinSameClientMother } from './lanMotherBoot';
import { getAuthUser } from './authStore';

export type AutoConnectResult =
  | { kind: 'noop'; reason: string }
  | { kind: 'connected'; ssid: string }
  | { kind: 'needs_consent'; ssid: string }
  | { kind: 'failed'; ssid: string; message: string };

export interface AutoConnectOpts {
  /** join-context passes true (may return `needs_consent`); launch passes false
   *  (silently joins only already-consented networks, never prompts). */
  allowPrompt: boolean;
}

// After landing on the AP, re-establish reachability to the mother: warm a fresh
// mDNS endpoint on the AP subnet, then AUTO-PAIR with the same-client mother if we
// aren't already (the mother auto-approves us by client_id, so no operator tap and
// no manual "Join" click). Once paired, the periodic route tick points our
// launched-games traffic at it. Best-effort - failures here don't undo the
// successful Wi-Fi join.
async function reestablishMother(): Promise<void> {
  try {
    // If we joined the AP but Windows never handed us a DHCP lease (stuck on an
    // APIPA 169.254.* address), we can't reach the mother's 192.168.137.1 gateway.
    // Renew DHCP first to pull a real lease, then discover/pair.
    await maybeRenewDhcpIfStuck();
    await refreshMotherEndpoints();
    const me = await getAuthUser().catch(() => null);
    if (me?.client_id != null) {
      await autoJoinSameClientMother(me.client_id).catch(() => false);
    }
  } catch (err) {
    console.warn('[wifiAutoConnect] mother re-discovery failed (non-fatal):', err);
  }
}

// Auto-recover an APIPA-stuck child. Windows Mobile-Hotspot ICS sometimes never
// leases a 192.168.137.x address (observed on-site when the mother is ALSO
// sharing an upstream Wi-Fi - the least reliable ICS config) and `ipconfig
// /renew` can't force it. When that happens AND a mother is actually reachable
// on the hotspot subnet, add a STATIC IP on the mother's /24 so the child can
// reach it anyway - the same recovery the LanDiagnostics button does, but
// automatic. The static is ADDITIVE (DHCP stays enabled), so internet on other
// networks keeps working with no revert prompt. One UAC per SSID (we don't
// re-prompt on the same network); once assigned, the child holds a 192.168.137.x
// so isStuckOnApipa() is false and we won't re-escalate. mDNS discovery works
// even from an APIPA address (link-local multicast), so we can still find the
// mother to derive the /24.
let staticIpAttemptedFor: string | null = null;
async function maybeEscalateToStaticIp(): Promise<boolean> {
  try {
    if (platform() !== 'windows') return false;
    if (!(await isStuckOnApipa())) return false; // got a real lease / already static → nothing to do
    const ssid = await getCurrentSsid();
    // Moved to a different network (or dropped) → allow a fresh attempt there.
    if (staticIpAttemptedFor && staticIpAttemptedFor !== ssid) staticIpAttemptedFor = null;
    if (!ssid) return false;
    if (staticIpAttemptedFor === ssid) return false; // already tried on this SSID
    // Only escalate if a mother is genuinely on the hotspot subnet - otherwise a
    // static IP reaches nothing. mDNS multicast resolves even at 169.254.x.
    const mothers = await discoverOtherMothers(3000).catch(() => [] as DiscoveredMother[]);
    const gw = mothers.flatMap((m) => m.addresses).find((a) => a.startsWith('192.168.137.'));
    if (!gw) return false;
    staticIpAttemptedFor = ssid; // mark BEFORE the prompt so a decline doesn't re-loop
    console.warn('[wifiAutoConnect] DHCP never leased on', ssid, '- escalating to a static IP on', gw);
    await assignStaticIp(gw);
    return true;
  } catch (err) {
    console.warn('[wifiAutoConnect] static-IP escalation failed (non-fatal):', err);
    return false;
  }
}

export async function runAutoConnect(opts: AutoConnectOpts): Promise<AutoConnectResult> {
  // ── Guards ──────────────────────────────────────────────────────────────
  try {
    const role = await describeLocalRole();
    if (role.is_mother_hosting) return { kind: 'noop', reason: 'hosting' };
  } catch {
    // If we can't tell our role, err on the side of not yanking the connection.
    return { kind: 'noop', reason: 'role-unknown' };
  }

  const networks = await wifiNetworksStore.list();
  if (networks.length === 0) return { kind: 'noop', reason: 'no-networks' };

  // Already on a network we know and haven't declined → leave the Wi-Fi alone, but
  // self-heal a failed DHCP: a child already sitting on the mother's AP but stuck
  // on an APIPA address (no 192.168.137.x lease) can't reach the mother, and this
  // periodic path is the only thing that revisits it. Renew (throttled) + re-pair.
  const current = await getCurrentSsid();
  if (current && networks.some((n) => n.ssid === current && n.auto_connect !== 0)) {
    // Try a DHCP renew first (cheap, no prompt). If a renew fired we re-pair;
    // otherwise it was throttled or already tried and we're STILL on APIPA -
    // that's the "ICS just won't lease" case, so escalate to a static IP (one
    // UAC) and re-pair once it lands. maybeEscalateToStaticIp self-skips unless
    // genuinely stuck with a mother reachable on the subnet.
    if (await maybeRenewDhcpIfStuck()) {
      await reestablishMother();
    } else if (await maybeEscalateToStaticIp()) {
      await reestablishMother();
    }
    return { kind: 'noop', reason: 'already-on-known' };
  }

  const visible = new Set(await scanWifi());

  // Consented + in range + not the current network, in MRU/paired-first order.
  const consentedTarget = networks.find(
    (n) => n.auto_connect === 1 && n.ssid !== current && visible.has(n.ssid)
  );
  if (consentedTarget) {
    try {
      await connectWifi(consentedTarget.ssid, consentedTarget.password);
      await wifiNetworksStore.markConnected(consentedTarget.ssid);
      await reestablishMother();
      return { kind: 'connected', ssid: consentedTarget.ssid };
    } catch (err) {
      // No retry loop - surface manual fallback.
      return { kind: 'failed', ssid: consentedTarget.ssid, message: String((err as Error)?.message ?? err) };
    }
  }

  // No consented target. In a join context, offer the first-time consent prompt
  // for a never-asked network that's in range.
  if (opts.allowPrompt) {
    const unasked = networks.find(
      (n) => n.auto_connect == null && n.ssid !== current && visible.has(n.ssid)
    );
    if (unasked) return { kind: 'needs_consent', ssid: unasked.ssid };
  }

  return { kind: 'noop', reason: 'nothing-in-range' };
}

// Studio/manual creds are the authoritative "mother's network"; paired creds are
// learned from a past ping. When directly attempting a join we try authoritative
// first, then paired - MRU order within each group is preserved by list()'s sort.
function originRank(origin: string): number {
  return origin === 'studio' || origin === 'manual' ? 0 : 1;
}

/**
 * Explicit "connect me to the mother's Wi-Fi" (the top-bar Wi-Fi button). Unlike
 * `runAutoConnect`, this does NOT gate on a Wi-Fi scan: a deliberate button press
 * should ATTEMPT the join to every network configured in `wifi_networks` even if
 * the SSID didn't appear in the last scan (scans are flaky / can miss a just-
 * raised AP). Tries them in turn (studio/manual first, then paired) and stops at
 * the first that connects. Still guards against yanking the link while THIS device
 * hosts its own hotspot. No consent prompt - the click is the consent.
 */
export async function connectConfiguredNetwork(): Promise<AutoConnectResult> {
  try {
    const role = await describeLocalRole();
    if (role.is_mother_hosting) return { kind: 'noop', reason: 'hosting' };
  } catch {
    return { kind: 'noop', reason: 'role-unknown' };
  }

  const networks = await wifiNetworksStore.list();
  if (networks.length === 0) return { kind: 'noop', reason: 'no-networks' };

  const current = await getCurrentSsid();
  if (current && networks.some((n) => n.ssid === current)) {
    return { kind: 'noop', reason: 'already-on-known' };
  }

  // Authoritative (studio/manual) networks first, then paired. Sort is stable, so
  // list()'s MRU ordering is kept within each group.
  const ordered = [...networks].sort((a, b) => originRank(a.origin) - originRank(b.origin));
  let lastErr = '';
  for (const n of ordered) {
    if (n.ssid === current) continue;
    try {
      await connectWifi(n.ssid, n.password);
      await wifiNetworksStore.markConnected(n.ssid);
      await reestablishMother();
      return { kind: 'connected', ssid: n.ssid };
    } catch (err) {
      lastErr = String((err as Error)?.message ?? err);
    }
  }
  return { kind: 'failed', ssid: ordered[0]?.ssid ?? '-', message: lastErr };
}

// Called after the operator answers the consent prompt. On "yes" we persist the
// choice and immediately attempt the join; on "no" we persist the decline.
export async function resolveConsent(
  ssid: string,
  consent: boolean
): Promise<AutoConnectResult> {
  await wifiNetworksStore.setConsent(ssid, consent);
  if (!consent) return { kind: 'noop', reason: 'declined' };
  const net = await wifiNetworksStore.get(ssid);
  if (!net) return { kind: 'noop', reason: 'gone' };
  try {
    await connectWifi(net.ssid, net.password);
    await wifiNetworksStore.markConnected(net.ssid);
    await reestablishMother();
    return { kind: 'connected', ssid: net.ssid };
  } catch (err) {
    return { kind: 'failed', ssid: net.ssid, message: String((err as Error)?.message ?? err) };
  }
}
