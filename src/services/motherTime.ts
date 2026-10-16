// The mother's wall clock, as seen from this device (tester builds: game
// simulator). PC clocks drift apart by seconds or minutes, and a simulated game
// clock runs at up to ×20, so a clock shared between devices is expressed in
// MOTHER time: each device measures its offset to the mother (NTP-style, best
// of a few round trips) and converts. On the mother itself the offset is 0.
// An older mother without `server_time`, or no LAN route: offset 0 (each
// device's own clock, the previous behaviour).

import { apiCall } from './api';

let offsetMs = 0;
let measuredAt = 0;
let inflight: Promise<number> | null = null;

/** Re-measure at most this often unless forced. */
const MAX_AGE_MS = 120_000;
const SAMPLES = 4;

/** mother clock − local clock, in ms (0 until measured). */
export function motherOffsetMs(): number {
  return offsetMs;
}

/** The mother's current time in epoch ms. */
export function motherNow(): number {
  return Date.now() + offsetMs;
}

/** Measure the offset now (or reuse a recent measure). Never throws. */
export function refreshMotherOffset(force = false): Promise<number> {
  if (!force && measuredAt && Date.now() - measuredAt < MAX_AGE_MS) return Promise.resolve(offsetMs);
  if (inflight) return inflight;
  inflight = (async () => {
    let best: { rtt: number; offset: number } | null = null;
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now();
      try {
        const res = await apiCall<{ now_ms?: number }>('launched_games', 'server_time', { method: 'GET', bearer: true });
        const t1 = Date.now();
        if (typeof res.now_ms !== 'number' || res.now_ms <= 0) break;
        const sample = { rtt: t1 - t0, offset: res.now_ms - (t0 + t1) / 2 };
        if (!best || sample.rtt < best.rtt) best = sample;
      } catch {
        break;
      }
    }
    if (best) {
      offsetMs = Math.round(best.offset);
      measuredAt = Date.now();
    }
    inflight = null;
    return offsetMs;
  })();
  return inflight;
}

/** A clock state's real-time fields (epoch ms), as in gameClock's SimClockState. */
interface RealTimed {
  realAnchor: number;
  pausedAt: number | null;
}

/** Local real-time fields → mother time (a clock leaving this device). */
export function toMotherClock<T extends RealTimed>(c: T): T {
  return { ...c, realAnchor: c.realAnchor + offsetMs, pausedAt: c.pausedAt === null ? null : c.pausedAt + offsetMs };
}

/** Mother time → this device's real-time fields (a clock received from elsewhere). */
export function fromMotherClock<T extends RealTimed>(c: T): T {
  return { ...c, realAnchor: c.realAnchor - offsetMs, pausedAt: c.pausedAt === null ? null : c.pausedAt - offsetMs };
}
