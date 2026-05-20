import { getDb } from './db';

// JWT storage for the playground client.
//
// Originally backed by tauri-plugin-stronghold, but its save() pipeline takes
// minutes on some Windows setups (Stronghold's encrypted-snapshot serialization
// + I/O is unusably slow during login). Pre-launch we route the JWT through
// the existing SQLite schema_meta(key, value) table.
//
// Threat model trade-off: token is now plaintext in playground.db (readable by
// the user's profile only). Stronghold's "encryption" was barely better given
// the key was derived from a hardcoded constant + a salt sitting next to the
// vault. For real hardening, swap to OS Credential Manager / Keychain via a
// keyring plugin in a follow-up.

const KEY_JWT = 'device_jwt';

export async function saveJwt(jwt: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT INTO schema_meta(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [KEY_JWT, jwt]
  );
}

export async function loadJwt(): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<Array<{ value: string }>>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [KEY_JWT]
  );
  if (rows.length === 0) return null;
  const v = rows[0].value;
  return v ? v : null;
}

export async function clearJwt(): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM schema_meta WHERE key = $1', [KEY_JWT]);
}
