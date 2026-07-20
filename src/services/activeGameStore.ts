// Tiny module-level singleton tracking which launched game THIS device is
// currently playing. Read by the mother-ping path (motherConnection /
// screenState) so the ping can tell the mother which game's snapshot to ship
// for failover (mother-failover slice 1), and so the ping cadence can tighten
// while a game is live. Set/cleared by GamePage on mount/unmount.
//
// Pure in-process state - no persistence, no subscribers. The ping pollers
// read it lazily on each tick, so there's nothing to unsubscribe.

let activeLaunchedGameId: number | null = null;

export function setActiveLaunchedGameId(id: number | null): void {
  activeLaunchedGameId = id;
}

export function getActiveLaunchedGameId(): number | null {
  return activeLaunchedGameId;
}
