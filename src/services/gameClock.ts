// Game clock: the single time source for game LOGIC (start/end times, late
// malus, reuse cooldowns, countdowns, card debounce).
//
// Normally it is just Date.now(). While the game simulator runs on this
// device it returns the simulated ("virtual") time instead, so a 60-min game
// played at 10x really ends after 6 real minutes, with consistent timestamps.
// Licensee builds never set a sim clock, so this stays a plain Date.now().
//
// UI-only timestamps (nonces, animation keys, log lines) keep Date.now().

export interface SimClockState {
  /** Real epoch ms at which the virtual timeline was (re)anchored. */
  realAnchor: number;
  /** Virtual epoch ms at realAnchor. */
  virtualAnchor: number;
  /** Speed multiplier (1 = real time). */
  speed: number;
  /** Real epoch ms when paused, null when running. */
  pausedAt: number | null;
}

let sim: SimClockState | null = null;
const listeners = new Set<(s: SimClockState | null) => void>();

function virtualAt(realMs: number, s: SimClockState): number {
  const effectiveReal = s.pausedAt ?? realMs;
  return s.virtualAnchor + (effectiveReal - s.realAnchor) * s.speed;
}

export const gameClock = {
  /** Epoch milliseconds. */
  now(): number {
    const real = Date.now();
    return sim ? virtualAt(real, sim) : real;
  },
  /** Epoch seconds (floored), the unit stored in teams.start_time/end_time. */
  nowSec(): number {
    return Math.floor(gameClock.now() / 1000);
  },
  date(): Date {
    return new Date(gameClock.now());
  },
  isSimulated(): boolean {
    return sim !== null;
  },
  getSim(): SimClockState | null {
    return sim;
  },
  setSim(next: SimClockState | null): void {
    sim = next;
    listeners.forEach((l) => l(sim));
  },
  /** Re-anchor at "now" with a new speed / pause state, keeping time continuous. */
  adjust(patch: { speed?: number; paused?: boolean }): void {
    if (!sim) return;
    const real = Date.now();
    const v = virtualAt(real, sim);
    const paused = patch.paused ?? sim.pausedAt !== null;
    gameClock.setSim({
      realAnchor: real,
      virtualAnchor: v,
      speed: patch.speed ?? sim.speed,
      pausedAt: paused ? real : null,
    });
  },
  /** Real milliseconds to wait until the given virtual epoch ms (Infinity while paused). */
  realDelayUntil(virtualMs: number): number {
    if (!sim) return Math.max(0, virtualMs - Date.now());
    if (sim.pausedAt !== null) return Infinity;
    return Math.max(0, (virtualMs - gameClock.now()) / sim.speed);
  },
  subscribe(fn: (s: SimClockState | null) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
