import { getDb } from './db';
import { pbkdf2, randomSaltB64, constantTimeEqual } from './localCrypto';
import { captureRecoveryCodeUsed } from './telemetry';

// Offline PIN-recovery codes. The client's admin issues a pool of one-time
// codes in studio; they sync down to every device and are validated here
// fully offline. A code is consumed ONCE PER DEVICE (used_at flips locally),
// so the same code can still be used once on a different device. Entering a
// valid code is the caller's signal to clear the device PIN and let the
// operator back in — see PinExitPrompt / LockScreen.
//
// Storage: studio is the plaintext source of truth (so the admin can read a
// code aloud); the device keeps only salted PBKDF2 hashes. All codes in a pool
// share one device-generated salt, so a verify hashes the typed code once and
// compares against every unused hash. Same "UX gate, not crypto" threat model
// as the PIN (see pinStore.ts / localCrypto.ts).

const KDF_ITERATIONS = 200_000;
const SALT_BYTES = 16;

// 8-digit numeric, matching the studio generator and the RecoveryCodePrompt
// input. Grouping/spaces are stripped before validation.
const CODE_SHAPE = /^\d{8}$/;

interface CodeRow {
  code_index: number;
  code_hash: string;
  salt: string;
  kdf_iterations: number;
  pool_version: number;
}

export function normalizeRecoveryCode(raw: string): string {
  return raw.replace(/\D/g, '');
}

// True if the device has any recovery code at all (used or not). Drives
// whether the "Forgot PIN?" affordance offers the offline code path.
export async function hasRecoveryCodes(): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    'SELECT COUNT(*) AS n FROM recovery_codes',
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function hasUnusedRecoveryCodes(): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    'SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL',
  );
  return (rows[0]?.n ?? 0) > 0;
}

export type ConsumeOutcome =
  | { ok: true; codeIndex: number }
  | { ok: false; reason: 'bad_shape' | 'no_codes' | 'wrong' };

// Verify a typed code against the unused pool; on a match, burn it locally
// (used_at) and return its index so the caller can report the consumption up
// to studio later (best-effort, slice 4). Never mutates on a miss, and never
// locks out — guessing is impractical against 8 digits × a small pool, and an
// operator mustn't be able to brick their own recovery.
export async function tryConsumeRecoveryCode(raw: string): Promise<ConsumeOutcome> {
  const code = normalizeRecoveryCode(raw);
  if (!CODE_SHAPE.test(code)) return { ok: false, reason: 'bad_shape' };

  const db = await getDb();
  const rows = await db.select<CodeRow[]>(
    'SELECT code_index, code_hash, salt, kdf_iterations, pool_version FROM recovery_codes WHERE used_at IS NULL',
  );
  if (rows.length === 0) return { ok: false, reason: 'no_codes' };

  // All rows in a pool share one salt, but cache by salt defensively so a
  // mixed pool still verifies correctly with at most one hash per salt.
  const hashBySalt = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.salt}:${row.kdf_iterations}`;
    let candidate = hashBySalt.get(key);
    if (candidate === undefined) {
      candidate = await pbkdf2(code, row.salt, row.kdf_iterations);
      hashBySalt.set(key, candidate);
    }
    if (constantTimeEqual(candidate, row.code_hash)) {
      await db.execute(
        "UPDATE recovery_codes SET used_at = datetime('now') WHERE code_index = $1",
        [row.code_index],
      );
      // Best-effort report so studio shows this code as used. The outbox is
      // durable + retried, so this survives an offline event and an app
      // restart; we don't await it (the exit must not wait on telemetry).
      void captureRecoveryCodeUsed({
        code_index: row.code_index,
        pool_version: row.pool_version,
      });
      return { ok: true, codeIndex: row.code_index };
    }
  }
  return { ok: false, reason: 'wrong' };
}

// Replace the device's whole pool with a freshly synced set (admin
// "Regenerate all" or first sync). Hashes each plaintext code under one new
// device salt and resets all used flags — the slice-2 sync orchestrator will
// call this when remote_version advances. Codes arrive plaintext over TLS and
// are never persisted in the clear.
export async function replaceRecoveryPool(
  plaintextCodes: string[],
  poolVersion: number,
): Promise<void> {
  const salt = randomSaltB64(SALT_BYTES);
  const hashes = await Promise.all(
    plaintextCodes.map((c) => pbkdf2(normalizeRecoveryCode(c), salt, KDF_ITERATIONS)),
  );
  const db = await getDb();
  await db.execute('DELETE FROM recovery_codes');
  for (let i = 0; i < hashes.length; i++) {
    await db.execute(
      `INSERT INTO recovery_codes
         (code_index, code_hash, salt, kdf_iterations, pool_version, used_at, reported_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL)`,
      [i + 1, hashes[i], salt, KDF_ITERATIONS, poolVersion],
    );
  }
}

// Dev/QA helper: seed plaintext codes (pool_version 0) so the prompts can be
// exercised before the studio + sync slices land. Registered on window in
// main.tsx (dev builds only).
export async function devSeedRecoveryCodes(codes: string[]): Promise<void> {
  await replaceRecoveryPool(codes, 0);
}

// ───────────────────────────────────────────────────────────────────────────
// Sync state (recovery_codes_state) — incremental version compare, mirrors
// namePoolsStore. The codes table above is the validated pool; this tracks
// what studio advertised (remote_version) vs what we last pulled
// (local_version) so the orchestrator only re-downloads on a Regenerate.
// ───────────────────────────────────────────────────────────────────────────

export interface RecoveryCodesStateRow {
  client_id: number;
  remote_version: number | null;
  local_version: number | null;
  fetched_at: string | null;
  failed_attempts: number;
}

export async function getState(clientId: number): Promise<RecoveryCodesStateRow | null> {
  const db = await getDb();
  const rows = await db.select<RecoveryCodesStateRow[]>(
    'SELECT * FROM recovery_codes_state WHERE client_id = $1',
    [clientId],
  );
  return rows.length ? rows[0] : null;
}

// Record studio's reported version. Preserves local_version; creates on first sight.
export async function upsertFromManifest(
  clientId: number,
  payload: { recovery_codes_version: number | null },
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO recovery_codes_state (client_id, remote_version, local_version, fetched_at, failed_attempts)
     VALUES ($1, $2, NULL, NULL, 0)
     ON CONFLICT(client_id) DO UPDATE SET remote_version = excluded.remote_version`,
    [clientId, payload.recovery_codes_version],
  );
}

export async function markDownloaded(clientId: number, version: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE recovery_codes_state SET local_version = $1, fetched_at = $2, failed_attempts = 0 WHERE client_id = $3',
    [version, new Date().toISOString(), clientId],
  );
}

export async function incrementFailedAttempts(clientId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE recovery_codes_state SET failed_attempts = failed_attempts + 1 WHERE client_id = $1',
    [clientId],
  );
}

// Pull needed when studio's remote_version differs from what we last persisted.
// remote_version 0 means "no pool exists" — still worth one download to clear a
// stale pool, but only if we've never downloaded (local null) or it changed.
export async function needsRecoveryCodesDownload(clientId: number): Promise<boolean> {
  const row = await getState(clientId);
  if (!row || row.remote_version === null) return false;
  return row.local_version === null || row.local_version !== row.remote_version;
}
