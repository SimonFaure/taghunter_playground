// Game reconciliation, satellite side: bring this device and the mother it is
// routed at to the same state for every game. The newer copy wins, whoever
// holds it.
//
// Each device used to keep its own copy and the current mother's was shown
// everywhere, even when it was the one frozen at the moment of a failure: a
// game finished on a substitute could vanish once the real mother came back.
// The comparison and the transfer live in Rust (`client_reconcile_with_mother`):
//  - what this device holds that is more advanced is PUSHED to the mother - a
//    substitute hands back what it hosted this way, ended games included;
//  - what the mother holds that is more advanced is pulled onto our copy
//    (the old "superseded game still shown as running" case, Ludiom #76).
// Satellites run no server, so the exchange always starts here, when the route
// to a mother is (re)established and then once a minute.

import { invoke } from '@tauri-apps/api/core';

interface MotherLink {
  base_url: string;
  token: string;
  mother_uuid: string;
}

/** Mirror of the Rust `ReconcileReport`. */
export interface ReconcileReport {
  pushed: number;
  pulled: number;
  dropped: number;
  refused: string[];
  needs_pair: boolean;
  unsupported: boolean;
  serving: boolean;
}

// A game whose owner moved on isn't a fast-moving thing: once a minute is plenty
// and keeps the HTTP cost negligible on a venue full of satellites.
const RECONCILE_MIN_INTERVAL_MS = 60_000;
let lastRun = 0;
let inFlight: Promise<ReconcileReport | null> | null = null;

/** Split `http://1.2.3.4:47800` into the addr/port the Rust command expects. */
function parseBase(baseUrl: string): { addr: string; port: number } | null {
  try {
    const u = new URL(baseUrl);
    const port = Number(u.port);
    if (!u.hostname || !Number.isFinite(port) || port <= 0) return null;
    return { addr: u.hostname, port };
  } catch {
    return null;
  }
}

/**
 * Reconcile with the mother now. Coalesced; never throws. Returns null when
 * there is no mother to reconcile with. A `needs_pair` report is left to the
 * route tick: its 401 handler re-pairs, and the next run goes through.
 */
export function reconcileWithMotherNow(): Promise<ReconcileReport | null> {
  if (inFlight) return inFlight;
  lastRun = Date.now();
  inFlight = (async () => {
    try {
      const link = await invoke<MotherLink | null>('client_resolve_mother_link').catch(() => null);
      const addr = link?.base_url ? parseBase(link.base_url) : null;
      if (!addr) return null;
      const report = await invoke<ReconcileReport>('client_reconcile_with_mother', addr);
      if (report.pushed || report.pulled || report.dropped || report.refused.length) {
        console.log(
          `[reconcile] with ${addr.addr}: pushed ${report.pushed}, pulled ${report.pulled}, dropped ${report.dropped}`,
          report.refused.length ? report.refused : '',
        );
      }
      return report;
    } catch (e) {
      console.warn('[reconcile] failed:', e);
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The periodic call, from the App tick of a device that is not hosting. */
export async function reconcileSupersededGamesTick(): Promise<void> {
  if (Date.now() - lastRun < RECONCILE_MIN_INTERVAL_MS) return;
  await reconcileWithMotherNow();
}
