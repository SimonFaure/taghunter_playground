import { getDb } from './db';
import { pbkdf2, randomSaltB64, constantTimeEqual } from './localCrypto';

// Local PIN store. Backs the cold-start lock screen.
//
// Threat model: a 4-digit PIN is a UX gate against casual misuse of an
// unattended tablet, not a cryptographic boundary. With only 10k possible
// inputs, an offline attacker with SQLite access can brute-force the hash
// regardless of KDF cost. PBKDF2 + a per-device salt is here to slow naïve
// dumps and to keep the on-disk format upgradeable; if real hardening is
// needed later, derive a key from the PIN and encrypt the JWT under it
// (which still doesn't defeat a determined attacker but at least raises
// the bar). For now the JWT stays plaintext per the slice-1 trade-off
// captured in services/strongholdStore.ts.
//
// The PBKDF2/salt/compare primitives live in localCrypto.ts, shared with the
// offline recovery-code store (recoveryCodesStore.ts) so both hash identically.

const KDF_ITERATIONS = 200_000;
const SALT_BYTES = 16;

// Progressive backoff. After a run of wrong attempts hits one of these
// thresholds, the next attempt is gated until `locked_until_at` (unix
// seconds). The counter never resets on its own — only a correct PIN
// (or an OTP-driven reset) clears it. We never wipe state.
const BACKOFF_STEPS: ReadonlyArray<{ threshold: number; delaySeconds: number }> = [
  { threshold: 5, delaySeconds: 30 },
  { threshold: 10, delaySeconds: 5 * 60 },
  { threshold: 20, delaySeconds: 60 * 60 },
];

interface PinRow {
  pin_hash: string;
  salt: string;
  kdf_iterations: number;
  failed_attempts: number;
  locked_until_at: number;
}

async function readRow(): Promise<PinRow | null> {
  const db = await getDb();
  const rows = await db.select<PinRow[]>(
    'SELECT pin_hash, salt, kdf_iterations, failed_attempts, locked_until_at FROM device_pin WHERE id = 1'
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function hasPin(): Promise<boolean> {
  return (await readRow()) !== null;
}

export async function setPin(pin: string): Promise<void> {
  assertPinShape(pin);
  const salt = randomSaltB64(SALT_BYTES);
  const hash = await pbkdf2(pin, salt, KDF_ITERATIONS);
  const db = await getDb();
  await db.execute(
    `INSERT INTO device_pin (id, pin_hash, salt, kdf_iterations, failed_attempts, locked_until_at, updated_at)
     VALUES (1, $1, $2, $3, 0, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       pin_hash = excluded.pin_hash,
       salt = excluded.salt,
       kdf_iterations = excluded.kdf_iterations,
       failed_attempts = 0,
       locked_until_at = 0,
       updated_at = CURRENT_TIMESTAMP`,
    [hash, salt, KDF_ITERATIONS]
  );
}

export async function clearPin(): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM device_pin WHERE id = 1');
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'no_pin' }
  | { ok: false; reason: 'wrong'; failedAttempts: number; lockedUntilAt: number }
  | { ok: false; reason: 'locked_out'; lockedUntilAt: number };

export async function verifyPin(pin: string): Promise<VerifyOutcome> {
  const row = await readRow();
  if (!row) return { ok: false, reason: 'no_pin' };

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (row.locked_until_at > nowSeconds) {
    return { ok: false, reason: 'locked_out', lockedUntilAt: row.locked_until_at };
  }

  const candidate = await pbkdf2(pin, row.salt, row.kdf_iterations);
  if (constantTimeEqual(candidate, row.pin_hash)) {
    const db = await getDb();
    await db.execute(
      'UPDATE device_pin SET failed_attempts = 0, locked_until_at = 0 WHERE id = 1'
    );
    return { ok: true };
  }

  const failed = row.failed_attempts + 1;
  const lockedUntilAt = computeLockoutEnd(failed, nowSeconds);
  const db = await getDb();
  await db.execute(
    'UPDATE device_pin SET failed_attempts = $1, locked_until_at = $2 WHERE id = 1',
    [failed, lockedUntilAt]
  );
  return { ok: false, reason: 'wrong', failedAttempts: failed, lockedUntilAt };
}

// Lightweight, non-mutating PIN check for the kiosk "use PIN to exit" gates
// (game page / logo screen). Unlike verifyPin, this NEVER touches
// failed_attempts / locked_until_at and ignores any active lockout window:
// an operator repeatedly entering the exit PIN during an event must not be
// able to lock themselves out of the cold-start device lock, and a bystander
// mashing digits at the game panel mustn't escalate the shared backoff. The
// gesture obscurity plus the documented "UX gate, not a cryptographic
// boundary" threat model above carry the security weight here.
export async function peekVerifyPin(pin: string): Promise<boolean> {
  const row = await readRow();
  if (!row) return false;
  const candidate = await pbkdf2(pin, row.salt, row.kdf_iterations);
  return constantTimeEqual(candidate, row.pin_hash);
}

// Exposed so the lock screen can render a live countdown without forcing
// a verify round-trip. Returns 0 when the device is free to try again.
export async function getLockoutEnd(): Promise<number> {
  const row = await readRow();
  if (!row) return 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return row.locked_until_at > nowSeconds ? row.locked_until_at : 0;
}

function computeLockoutEnd(failedAttempts: number, nowSeconds: number): number {
  // Pick the longest backoff window whose threshold is <= failedAttempts.
  // failed_attempts of 4 stays free; 5 hits the first step; 10 hits the
  // second; 20+ all the way to the third (and continue applying the third
  // indefinitely so the user gets backoff, not a brick).
  let best = 0;
  for (const step of BACKOFF_STEPS) {
    if (failedAttempts >= step.threshold) {
      best = step.delaySeconds;
    }
  }
  if (best === 0) return 0;
  return nowSeconds + best;
}

function assertPinShape(pin: string): void {
  if (!/^\d{4}$/.test(pin)) {
    throw new Error('PIN must be exactly 4 digits');
  }
}
