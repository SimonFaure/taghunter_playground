// Online/offline tracking. Sources:
//   - navigator.onLine (immediate)
//   - 'online' / 'offline' window events (on reconnect)
//   - a 30s background ping that re-evaluates connectivity to studio
//
// Consumers:
//   - syncOrchestrator subscribes to 'online' for the network-up trigger
//   - UI banners can call isOnline() at any time

type ConnectivityListener = (online: boolean) => void;

const listeners = new Set<ConnectivityListener>();
let lastKnown: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;
let started = false;

export function isOnline(): boolean {
  return lastKnown;
}

export function startConnectivityMonitor(): void {
  if (started) return;
  started = true;

  const update = (next: boolean) => {
    if (next === lastKnown) return;
    lastKnown = next;
    for (const cb of listeners) {
      try {
        cb(next);
      } catch (err) {
        console.error('[connectivity] listener threw:', err);
      }
    }
  };

  window.addEventListener('online', () => update(true));
  window.addEventListener('offline', () => update(false));

  // Periodic re-check. navigator.onLine can lie (returns true on captive
  // portals, can stay false after the radio recovers without a window event).
  // A cheap interval re-poll ensures the state self-heals.
  setInterval(() => {
    update(navigator.onLine);
  }, 30_000);
}

export function onConnectivityChange(cb: ConnectivityListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
