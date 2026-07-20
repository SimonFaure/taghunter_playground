// Global "is an in-game presentation currently on screen?" signal.
//
// Team reveal animations and status messages are serialised through
// usePresentationQueue (one instance per in-game page) and rendered at a very
// high z-index - the punch-reveal overlay sits at z-5000 (see GameMessageOverlay
// for the stacking map). App-root overlays such as the operator-driven video
// (<OperatorVideoOverlay>, FirstBipVideoOverlay at z-100) live far below that,
// so a video that mounts mid-animation plays its audio *behind* the reveal and
// looks like nothing happened. This module lets those overlays defer until the
// animation is over.
//
// `active` counts not-yet-finished presentations across every mounted queue.
// The queue increments on enqueue and decrements when each item's slot finishes
// (run completed OR dropped by clear()), so the count is balanced and returns to
// 0 once the screen is quiet.

let active = 0;
let waiters: Array<() => void> = [];

/** Called by usePresentationQueue when an item is queued. */
export function presentationBegin(): void {
  active += 1;
}

/** Called by usePresentationQueue when an item's slot finishes or is dropped. */
export function presentationEnd(): void {
  active = Math.max(0, active - 1);
  if (active === 0 && waiters.length > 0) {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  }
}

export function isPresentationActive(): boolean {
  return active > 0;
}

/**
 * Resolve once no in-game presentation is on screen. Resolves immediately when
 * already idle. `timeoutMs` is a safety cap so an unbalanced gate (future bug)
 * can never permanently wedge a caller - it resolves anyway and logs. A single
 * reveal animation finishes well within the default; a long queue of bipping
 * teams is exactly what we want to wait through.
 */
export function waitForPresentationIdle(timeoutMs = 45000): Promise<void> {
  if (active === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    waiters.push(finish);
    if (timeoutMs > 0) {
      window.setTimeout(() => {
        if (done) return;
        waiters = waiters.filter((w) => w !== finish);
        console.warn('[presentationGate] idle wait timed out - proceeding');
        finish();
      }, timeoutMs);
    }
  });
}
