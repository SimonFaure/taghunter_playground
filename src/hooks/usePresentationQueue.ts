import { useCallback, useEffect, useRef, useState } from 'react';
import { presentationBegin, presentationEnd } from '../services/presentationGate';

// A serial async queue of on-screen "presentations" (team reveal animations AND
// status messages) shared by every in-game page. Each item runs strictly one at
// a time: a new bip / message arriving while one is already on screen waits its
// turn instead of overlapping. The labels of the not-yet-started items are
// exposed as `pending` so the page can render a "waiting teams" line.
//
// Why a chain + refs + mirrored state:
//   - The serial spine is a Promise chain (`chainRef`) - the same mechanism
//     Mystery already used for its presentation chain, generalised here.
//   - `queueRef` is the live source of truth for not-yet-started items, mutated
//     synchronously inside `enqueue` so two bips landing in the same tick keep
//     their arrival order regardless of which render's closure called enqueue
//     (the USB callback is captured at mount, the poll handler later, etc.).
//   - `pending` / `current` are React STATE mirrors because refs don't trigger
//     a re-render - the waiting-teams bar must update the instant a team queues
//     and the instant one starts.

interface Presentation {
  id: number;
  // Team name / combo-clan label shown in the waiting line. `null` = the item
  // still serialises (blocks + defers) but contributes no chip (team-agnostic
  // messages like "card not registered").
  label: string | null;
  // Resolves when the on-screen effect is fully finished (animation torn down /
  // message faded). The queue advances to the next item only then.
  run: () => Promise<void>;
  // Settles the promise returned by enqueue (on run completion OR on clear()).
  settle: () => void;
}

export interface PresentationQueueApi {
  /**
   * Append a presentation. Runs after all earlier ones have finished. Returns a
   * promise that resolves when this item's run completes (or when it is dropped
   * by clear() before starting), so a caller can await its own slot.
   */
  enqueue: (label: string | null, run: () => Promise<void>) => Promise<void>;
  /** Labels of items not yet started, in arrival order. Drives the waiting line. */
  pending: string[];
  /** Label of the item currently on screen, or null. Diagnostic. */
  current: string | null;
  /** Drop every not-yet-started item (game over / leaving). Does not abort the in-flight one. */
  clear: () => void;
}

export function usePresentationQueue(): PresentationQueueApi {
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const queueRef = useRef<Presentation[]>([]);
  const idRef = useRef(0);
  const mountedRef = useRef(true);
  // Number of presentationBegin() calls this instance has made that have not yet
  // been balanced by a presentationEnd(). The presentation gate is a module-level
  // singleton that outlives this component, so if we unmount while a slot's run()
  // is still in flight (e.g. Mystery's reveal slot parks on waitForReset with
  // auto-reset off, or a punch animation's resolver is orphaned), that run() will
  // never resolve and its presentationEnd() would never fire - wedging the gate
  // above 0 forever and making every later operator video wait out the 45s idle
  // timeout. We track our own contribution and flush it on unmount.
  const gateHeldRef = useRef(0);
  const [pending, setPending] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  // Balanced wrappers around the module-level gate. endGate() is guarded so a
  // late chain callback that runs *after* an unmount flush is a harmless no-op
  // (the flush already released this instance's outstanding count).
  const beginGate = useCallback(() => {
    gateHeldRef.current += 1;
    presentationBegin();
  }, []);
  const endGate = useCallback(() => {
    if (gateHeldRef.current === 0) return;
    gateHeldRef.current -= 1;
    presentationEnd();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Release any gate slots still held by orphaned run() promises so the
      // singleton returns to idle when this page goes away.
      while (gateHeldRef.current > 0) endGate();
    };
  }, [endGate]);

  const syncPending = useCallback(() => {
    if (!mountedRef.current) return;
    setPending(
      queueRef.current
        .map((p) => p.label)
        .filter((l): l is string => !!l),
    );
  }, []);

  const enqueue = useCallback(
    (label: string | null, run: () => Promise<void>): Promise<void> => {
      const id = ++idRef.current;
      let settle!: () => void;
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const item: Presentation = { id, label, run, settle };
      queueRef.current.push(item);
      syncPending();
      // Mark the screen "busy" for App-root overlays (operator video) that must
      // defer until the animation is over. Balanced by exactly one
      // endGate() in this item's chain callback below (either branch), or by the
      // unmount flush if this instance goes away while the slot is in flight.
      beginGate();

      // Chain so this item runs only after every earlier one has fully
      // finished. Survives a throwing run() so one failure can't wedge the
      // queue. All setState calls are mount-guarded.
      chainRef.current = chainRef.current.then(async () => {
        // Dropped by clear() before it could start: skip running, already
        // settled there.
        if (!queueRef.current.some((p) => p.id === id)) {
          endGate();
          return;
        }
        // The page was left (quit / rankings) while this team was still
        // waiting: nobody is watching, so its reveal - and its sounds - must
        // not start behind the next screen.
        if (!mountedRef.current) {
          queueRef.current = queueRef.current.filter((p) => p.id !== id);
          settle();
          endGate();
          return;
        }
        // This item is starting: remove from the not-yet-started list and
        // promote it to `current`.
        queueRef.current = queueRef.current.filter((p) => p.id !== id);
        syncPending();
        if (mountedRef.current) setCurrent(label);
        try {
          await run();
        } catch (err) {
          console.error('[presentationQueue] item failed:', err);
        } finally {
          // The next chained item sets `current` again synchronously at its
          // start, so a 1-frame null gap between items is invisible (the bar
          // reads `pending`, not `current`).
          if (mountedRef.current) setCurrent(null);
          settle();
          endGate();
        }
      });

      return done;
    },
    [syncPending, beginGate, endGate],
  );

  const clear = useCallback(() => {
    // Settle the dropped items' promises so any awaiter doesn't hang, then
    // remove them. The in-flight item (already shifted out of queueRef) keeps
    // running and settles itself.
    for (const p of queueRef.current) p.settle();
    queueRef.current = [];
    syncPending();
  }, [syncPending]);

  return { enqueue, pending, current, clear };
}
