import { getDb } from './db';
import { getAuthUser, type AuthUser } from './authStore';

// Emergency device-disable + billing auto-lock - the device-side gate.
// Design: project_client_device_lock.
//
// Two independent locks flow down in the bootstrap auth_state (cached on
// auth_user so this is computable fully offline):
//   - devices_disabled        : admin emergency hard switch (whole client).
//   - billing_overdue_since +  : billing went overdue; the gate engages once
//     billing_grace_days         now > overdue_since + grace_days.
//
// When locked, the app stays usable but LAUNCHING and JOINING games is blocked
// (running games are never interrupted). A valid recovery code grants a
// per-device reprieve of billing_reprieve_days, stored in billing_reprieve_until
// (device-local; survives bootstraps) - while it is in the future the gate is
// lifted on this device only, then it re-locks and another code is needed.

const DAY_MS = 24 * 60 * 60 * 1000;

export type LockReason = 'disabled' | 'billing_overdue' | null;

export interface DeviceLockState {
  // True when launching/joining games must be blocked right now.
  locked: boolean;
  // Why the device would be locked, ignoring any active reprieve. Null = the
  // account is in good standing.
  reason: LockReason;
  // A recovery-code reprieve is currently active (so `locked` is false even if
  // `reason` is set).
  reprieveActive: boolean;
  reprieveUntil: Date | null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Pure computation so callers can reuse a single AuthUser read.
export function computeDeviceLock(user: AuthUser, now: Date = new Date()): DeviceLockState {
  const reprieveUntil = parseDate(user.billing_reprieve_until);
  const reprieveActive = reprieveUntil !== null && reprieveUntil.getTime() > now.getTime();

  let reason: LockReason = null;
  if (user.devices_disabled) {
    reason = 'disabled';
  } else {
    const overdueSince = parseDate(user.billing_overdue_since);
    if (overdueSince !== null) {
      const lockAt = overdueSince.getTime() + user.billing_grace_days * DAY_MS;
      if (now.getTime() > lockAt) reason = 'billing_overdue';
    }
  }

  return {
    locked: reason !== null && !reprieveActive,
    reason,
    reprieveActive,
    reprieveUntil,
  };
}

// Convenience reads off the cached auth_user. Return a safe "unlocked" default
// when there is no cached user (pre-auth) so a missing row never blocks launch.
export async function getDeviceLockState(now: Date = new Date()): Promise<DeviceLockState> {
  const user = await getAuthUser();
  if (!user) return { locked: false, reason: null, reprieveActive: false, reprieveUntil: null };
  return computeDeviceLock(user, now);
}

export async function isLaunchBlocked(now: Date = new Date()): Promise<boolean> {
  return (await getDeviceLockState(now)).locked;
}

// ── Reprieve ─────────────────────────────────────────────────────────────────

// Called after a recovery code is successfully consumed on the launch/join
// gate. Sets billing_reprieve_until = now + billing_reprieve_days on the cached
// user. The new deadline is reported up on the next heartbeat (see
// services/telemetry.ts captureHeartbeat) so the admin Devices view shows it.
export async function grantReprieve(now: Date = new Date()): Promise<Date | null> {
  const user = await getAuthUser();
  if (!user) return null;
  const until = new Date(now.getTime() + Math.max(0, user.billing_reprieve_days) * DAY_MS);
  const db = await getDb();
  await db.execute('UPDATE auth_user SET billing_reprieve_until = $1 WHERE client_id = $2', [
    until.toISOString(),
    user.client_id,
  ]);
  return until;
}

// The active reprieve deadline (ISO) for heartbeat reporting, or null if none /
// expired. Lets the heartbeat advertise a still-valid reprieve and clear a
// lapsed one.
export async function reprieveUntilForHeartbeat(now: Date = new Date()): Promise<string | null> {
  const user = await getAuthUser();
  const until = parseDate(user?.billing_reprieve_until);
  return until && until.getTime() > now.getTime() ? until.toISOString() : null;
}

// ── Billing-grace warning (pre-lock countdown banner) ─────────────────────────

export interface BillingGraceInfo {
  // The client is currently flagged overdue (a countdown is running or expired).
  overdue: boolean;
  // Whole days until the billing lock engages (0 once reached). Null when not
  // overdue.
  daysUntilLock: number | null;
  lockDate: Date | null;
  // Already past the grace window (the billing lock is in force, reprieve aside).
  locked: boolean;
}

// Only nag once the runway is short, mirroring the offline-grace banner.
export const BILLING_WARNING_THRESHOLD_DAYS = 7;

export function billingGraceInfo(user: AuthUser, now: Date = new Date()): BillingGraceInfo {
  const overdueSince = parseDate(user.billing_overdue_since);
  if (overdueSince === null) {
    return { overdue: false, daysUntilLock: null, lockDate: null, locked: false };
  }
  const lockDate = new Date(overdueSince.getTime() + user.billing_grace_days * DAY_MS);
  const msLeft = lockDate.getTime() - now.getTime();
  return {
    overdue: true,
    daysUntilLock: Math.max(0, Math.ceil(msLeft / DAY_MS)),
    lockDate,
    locked: msLeft <= 0,
  };
}
