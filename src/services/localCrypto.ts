// Shared local KDF helpers for the device's "UX gate" secrets — the cold-start
// device PIN (pinStore.ts) and the offline admin recovery codes
// (recoveryCodesStore.ts). Centralised so both hash identically
// (PBKDF2-HMAC-SHA256 → 32 bytes, base64-encoded) and so the crypto lives in
// one reviewable place.
//
// Threat model (verbatim from pinStore): these are UX gates against casual
// misuse of an unattended tablet, not cryptographic boundaries. A short numeric
// secret is brute-forceable offline regardless of KDF cost; PBKDF2 + a
// per-secret salt only slows naïve dumps and keeps the on-disk format
// upgradeable.

const HASH_BYTES = 32;

// PBKDF2-HMAC-SHA256 of `value` under the base64 `saltB64`, returned base64.
export async function pbkdf2(
  value: string,
  saltB64: string,
  iterations: number,
): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(value),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const salt = base64Decode(saltB64);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, hash: 'SHA-256', iterations },
    keyMaterial,
    HASH_BYTES * 8,
  );
  return base64Encode(new Uint8Array(bits));
}

// `byteLength` random bytes, base64-encoded — for a per-secret salt.
export function randomSaltB64(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Encode(bytes);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
