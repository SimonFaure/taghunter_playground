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

// Active reachability probe against studio's unauthenticated health check
// (`playground.php?action=test`). Unlike isOnline()/navigator.onLine - which
// lie on captive portals - this confirms the studio API actually answers, so
// the first-launch onboarding gate can guarantee the OTP step will work before
// showing the login screen. Short timeout; any failure resolves false.
export async function probeStudioReachable(timeoutMs = 8000): Promise<boolean> {
  try {
    // Lazy import keeps connectivity.ts free of a static dependency on the API
    // layer (which several low-level modules import in turn).
    const { apiCall } = await import('./api');
    const res = await apiCall<{ status?: string }>('playground', 'test', {
      bearer: false,
      timeoutMs,
    });
    return res?.status === 'ok';
  } catch {
    return false;
  }
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
