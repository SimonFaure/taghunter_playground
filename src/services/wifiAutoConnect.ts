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

import { describeLocalRole } from './lanPairing';
import { discoverOtherMothers, refreshMotherEndpoints } from './lanPairing';
import { getCurrentSsid, scanWifi, connectWifi } from './wifi';
import * as wifiNetworksStore from './wifiNetworksStore';

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

// After landing on the AP, re-establish reachability to the mother: the pairing
// secret is already cached, so we just need a fresh mDNS endpoint on the AP
// subnet. Best-effort - failures here don't undo the successful Wi-Fi join.
async function reestablishMother(): Promise<void> {
  try {
    await refreshMotherEndpoints();
    await discoverOtherMothers(3000);
  } catch (err) {
    console.warn('[wifiAutoConnect] mother re-discovery failed (non-fatal):', err);
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

  // Already on a network we know and haven't declined → leave it alone.
  const current = await getCurrentSsid();
  if (current && networks.some((n) => n.ssid === current && n.auto_connect !== 0)) {
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
