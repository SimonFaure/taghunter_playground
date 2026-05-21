// Tiny module-level pub/sub used to hand a `taghunter://lan-command join_game`
// from the App-root listener (which doesn't know how to enter GamePage) down
// to LaunchedGamesList (which owns the playGameById helper). Pure event
// fanout — no persistence, no ordering guarantees beyond "subscribers see
// emits in the order they fire."

type Listener = (launchedGameId: number) => void;

const listeners = new Set<Listener>();

export function onPendingJoin(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function emitPendingJoin(launchedGameId: number): void {
  for (const l of listeners) {
    try {
      l(launchedGameId);
    } catch (err) {
      console.error('[pendingJoinStore] listener threw:', err);
    }
  }
}
