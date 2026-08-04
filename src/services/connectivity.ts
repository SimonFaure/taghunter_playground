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
// Every call stamps the shared cache below, so consumers (the sync gate,
// studioReachableFresh) can reuse a recent answer without probing again.
let lastProbe: { ok: boolean; at: number } | null = null;
const PROBE_FRESH_MS = 90_000;

export async function probeStudioReachable(timeoutMs = 8000): Promise<boolean> {
  try {
    // Lazy import keeps connectivity.ts free of a static dependency on the API
    // layer (which several low-level modules import in turn).
    const { apiCall } = await import('./api');
    const res = await apiCall<{ status?: string }>('playground', 'test', {
      bearer: false,
      timeoutMs,
    });
    const ok = res?.status === 'ok';
    lastProbe = { ok, at: Date.now() };
    return ok;
  } catch {
    lastProbe = { ok: false, at: Date.now() };
    return false;
  }
}

/**
 * The truthful "is studio reachable" signal: the cached probe result when
 * fresh, else one live probe. On the normal venue setup - hotspot with no
 * upstream internet - navigator.onLine reads true while this correctly
 * reads false.
 */
export async function studioReachableFresh(maxAgeMs = PROBE_FRESH_MS): Promise<boolean> {
  if (lastProbe && Date.now() - lastProbe.at <= maxAgeMs) return lastProbe.ok;
  return probeStudioReachable();
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
