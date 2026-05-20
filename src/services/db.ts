import Database from '@tauri-apps/plugin-sql';

// Shared SQLite handle for the entire app.
//
// All service modules (authStore, scenarioStore, patternStore, layoutStore,
// cardsStore, contentFs, strongholdStore, telemetry, device, syncOrchestrator)
// import `getDb` from here instead of each holding their own cached
// `Database.load()` promise.
//
// Why one shared promise:
//   - tauri-plugin-sql returns a JS wrapper around a Rust resource. When
//     Vite HMR replaces a module, its captured wrapper can be GC'd and the
//     underlying Rust resource freed, causing "The resource id N is invalid"
//     errors in unrelated callers that still hold the old wrapper.
//   - Centralizing to one cache means HMR can only reset *this* module, and
//     the next getDb() call freshly reloads — all consumers transparently
//     pick up the new instance.
//   - Also tightens future schema/migration coordination to a single place.
//
// Why pinned to `globalThis`:
//   - Vite HMR replaces *module* state, but `globalThis` survives module
//     reloads. Without this pin, hot-reloading db.ts (or any module that
//     imports it) resets the cache and creates a NEW Database wrapper with
//     a NEW resource id, while in-flight code (the sync orchestrator's
//     transaction, the telemetry drainer, etc.) still holds the OLD wrapper.
//     The old resource is GC'd Rust-side → "resource id N is invalid" →
//     transactions stay open → "database is locked" cascades. Pinning the
//     promise to globalThis makes a single wrapper survive the entire
//     browser-page lifetime, immune to dev-time HMR churn.

const GLOBAL_KEY = '__playgroundDbPromise';

interface DbGlobals {
  [GLOBAL_KEY]?: Promise<Database>;
}

const g = globalThis as unknown as DbGlobals;

// The connection URL MUST match exactly what lib.rs's add_migrations()
// registered under — tauri-plugin-sql keys migrations by URL string, and
// a mismatch silently drops them. sqlx's SQLite URL parser only accepts
// a small set of query params (mode, cache, immutable), so the previous
// attempt at `?journal_mode=WAL&busy_timeout=5000` failed at parse time
// and migrations registered under that URL never ran. Keep this plain.
const PLAYGROUND_DB_URL = 'sqlite:playground.db';

export async function getDb(): Promise<Database> {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = (async () => {
      const db = await Database.load(PLAYGROUND_DB_URL);
      // Set pragmas imperatively (replaces the broken URL-param attempt).
      // journal_mode = WAL persists per-DB-FILE so the LAN axum pool sees
      // it too. busy_timeout is per-connection; this connection retries
      // for 5s on SQLITE_BUSY before erroring.
      try {
        await db.execute('PRAGMA journal_mode = WAL');
        await db.execute('PRAGMA busy_timeout = 5000');
      } catch (e) {
        console.warn('[db] failed to set pragmas:', e);
      }
      return db;
    })().catch((err) => {
      // Don't pin a rejected promise — let the next caller try again.
      g[GLOBAL_KEY] = undefined;
      throw err;
    });
  }
  return g[GLOBAL_KEY]!;
}

// Clears the cached handle. The next getDb() call re-loads. Call this if a
// caller detects a stale-resource error and wants the rest of the app to
// recover without an app restart.
export function invalidateDb(): void {
  g[GLOBAL_KEY] = undefined;
}

// Convenience wrapper: runs `fn(db)` and, if it fails with a stale-handle
// error from the sql plugin, invalidates the cache and retries once.
//
// Opt-in — existing call sites that do `const db = await getDb(); await
// db.execute(...)` keep working unchanged. Wrap a call here if you want
// self-healing on dev-mode HMR artifacts that slip past the globalThis pin
// (e.g. the user manually called invalidateDb, or an OS-level handle drop).
export async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  try {
    const db = await getDb();
    return await fn(db);
  } catch (err) {
    if (!isStaleHandle(err)) throw err;
    invalidateDb();
    const db = await getDb();
    return await fn(db);
  }
}

function isStaleHandle(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /resource id .* invalid/i.test(msg);
}
