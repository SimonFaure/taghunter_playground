import { apiCall, ApiError } from './api';
import { saveJwt, loadJwt, clearJwt } from './strongholdStore';
import {
  getDeviceMetadata,
  getCachedDeviceDisplayName,
  setCachedDeviceDisplayName,
} from './device';
import {
  persistAuthState,
  clearAuthUser,
  getAuthUser,
  AuthStateBlock,
  AuthUser,
  isWithinOfflineGrace,
  isDifferentOwner,
} from './authStore';
import { wipeAllContent } from './contentFs';
import { clearPin, setPin as savePin } from './pinStore';

export type LoginOutcome =
  | { kind: 'success'; authUser: AuthUser }
  | { kind: 'cap_reached'; approval_token: string; devices: DeviceListItem[]; max_devices: number };

export interface DeviceListItem {
  id: number;
  device_uniq: string;
  device_label: string | null;
  display_name?: string | null;
  os: string | null;
  os_version: string | null;
  app_version?: string | null;
  last_seen_at: string | null;
}

export interface MyDeviceListItem extends DeviceListItem {
  active_sessions: number;
  created_at: string;
  updated_at: string;
}

export type BootstrapOutcome =
  | { kind: 'no_token' }
  | { kind: 'authenticated'; authUser: AuthUser }
  | { kind: 'token_invalid' }
  | { kind: 'offline_in_grace'; authUser: AuthUser }
  | { kind: 'offline_locked'; authUser: AuthUser };

// First-launch flow. Drives splash → login | home | lock decision.
export async function bootstrap(): Promise<BootstrapOutcome> {
  const token = await loadJwt();
  if (!token) return { kind: 'no_token' };

  try {
    const response = await apiCall<{
      success: boolean;
      auth_state: AuthStateBlock;
      device_id: number | null;
    }>('secure_auth', 'playground-bootstrap', { method: 'POST', bearer: true });

    if (response.auth_state) {
      await persistAuthState(response.auth_state, {
        current_device_id: response.device_id ?? null,
      });
    }

    const user = await getAuthUser();
    if (!user) return { kind: 'token_invalid' };
    return { kind: 'authenticated', authUser: user };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      await clearJwt();
      await clearAuthUser();
      return { kind: 'token_invalid' };
    }

    // Network error or 5xx — fall back to local cache and grace period.
    const cached = await getAuthUser();
    if (!cached) return { kind: 'token_invalid' };
    const inGrace = await isWithinOfflineGrace(cached);
    return inGrace
      ? { kind: 'offline_in_grace', authUser: cached }
      : { kind: 'offline_locked', authUser: cached };
  }
}

export async function requestOtp(email: string): Promise<void> {
  await apiCall('secure_auth', 'playground-request-code', {
    method: 'POST',
    bearer: false,
    body: { email },
  });
}

export async function verifyOtp(email: string, code: string): Promise<LoginOutcome> {
  if (await isDifferentOwner(email)) {
    // A different account is logging in on this device. Wipe the prior owner's
    // cached content end-to-end (auth, content rows, media files). The PIN is
    // tied to the prior identity and must go with it.
    await clearAuthUser();
    await clearJwt();
    await clearPin();
    await wipeAllContent();
  }

  const device = await getDeviceMetadata();

  const response = await apiCall<
    | {
        success: true;
        cap_reached: false;
        data: { token: string; expires_at: string; device_id: number };
        auth_state: AuthStateBlock;
      }
    | {
        success: true;
        cap_reached: true;
        max_devices: number;
        approval_token: string;
        devices: DeviceListItem[];
      }
  >('secure_auth', 'playground-verify-code', {
    method: 'POST',
    bearer: false,
    body: {
      email,
      code,
      device_uniq: device.device_uniq,
      device_label: device.device_label,
      os: device.os,
      os_version: device.os_version,
      app_version: device.app_version,
    },
  });

  if (response.cap_reached) {
    return {
      kind: 'cap_reached',
      approval_token: response.approval_token,
      devices: response.devices,
      max_devices: response.max_devices,
    };
  }

  await saveJwt(response.data.token);
  await persistAuthState(response.auth_state, {
    current_device_id: response.data.device_id,
    device_label: device.device_label,
  });

  const user = await getAuthUser();
  if (!user) throw new Error('Failed to persist auth user after login');
  return { kind: 'success', authUser: user };
}

export async function evictAndVerify(
  email: string,
  approvalToken: string,
  revokeDeviceId: number
): Promise<AuthUser> {
  const device = await getDeviceMetadata();

  const response = await apiCall<{
    success: true;
    data: { token: string; expires_at: string; device_id: number };
    auth_state: AuthStateBlock;
  }>('secure_auth', 'playground-evict-and-verify', {
    method: 'POST',
    bearer: false,
    body: {
      email,
      approval_token: approvalToken,
      revoke_device_id: revokeDeviceId,
      device_uniq: device.device_uniq,
      device_label: device.device_label,
      os: device.os,
      os_version: device.os_version,
      app_version: device.app_version,
    },
  });

  await saveJwt(response.data.token);
  await persistAuthState(response.auth_state, {
    current_device_id: response.data.device_id,
    device_label: device.device_label,
  });

  const user = await getAuthUser();
  if (!user) throw new Error('Failed to persist auth user after eviction-login');
  return user;
}

export async function listMyDevices(): Promise<{
  devices: MyDeviceListItem[];
  current_device_id: number | null;
}> {
  return apiCall('secure_auth', 'playground-list-devices', {
    method: 'GET',
    bearer: true,
  });
}

// Resolve THIS device's friendly display name from the server, cache it, and
// return it (or null if none is set). Safe to call offline — falls back to the
// last cached value. The footer uses this to show the operator-assigned name.
export async function refreshDeviceDisplayName(): Promise<string | null> {
  const user = await getAuthUser();
  if (!user?.current_device_id) return getCachedDeviceDisplayName();
  try {
    const { devices, current_device_id } = await listMyDevices();
    const myId = current_device_id ?? user.current_device_id;
    const me = devices.find((d) => d.id === myId);
    const name = me?.display_name?.trim() || null;
    await setCachedDeviceDisplayName(name);
    return name;
  } catch {
    return getCachedDeviceDisplayName();
  }
}

export async function revokeDevice(deviceId: number): Promise<void> {
  await apiCall('secure_auth', 'playground-revoke-device', {
    method: 'POST',
    bearer: true,
    body: { device_id: deviceId },
  });
}

// Sets the user-chosen display name for one of the caller's own devices.
// Pass null (or an empty string) to clear it and fall back to the OS hostname.
export async function renameDevice(
  deviceId: number,
  displayName: string | null
): Promise<void> {
  await apiCall('secure_auth', 'playground-rename-device', {
    method: 'POST',
    bearer: true,
    body: { device_id: deviceId, display_name: displayName },
  });
}

// "Truly sign out" — the destructive path exposed in Settings → Account.
// Replaces the old `logout()` verb: everyday "stepping away" is the nav-bar
// "Lock" button (PIN gate), not a sign-out. Reach this only when the user
// explicitly chooses to release this device.
//
// Online-only at the call site (AccountScreen disables its button when
// connectivity.isOnline() is false). The function itself still tolerates an
// unreachable server — it swallows the revoke error and proceeds with local
// wipe so a half-broken environment can't strand the user mid-action.
export async function signOutOfThisDevice(): Promise<void> {
  const user = await getAuthUser();
  try {
    if (user?.current_device_id) {
      await revokeDevice(user.current_device_id);
    }
  } catch {
    // Swallow — even if the server is unreachable, we still wipe local state.
  }

  await clearJwt();
  await clearAuthUser();
  await clearPin();
}

// Forgot-PIN flow. The user is on the lock screen, has internet, and asks
// to reset their PIN. We reuse the existing OTP request/verify endpoints
// against the email cached in auth_user — the JWT and auth_user row stay
// put; only the PIN is replaced.
//
// `requestPinResetOtp` triggers the email. `verifyPinResetOtpAndSet` swaps
// the local PIN if the OTP is correct.

export async function requestPinResetOtp(): Promise<void> {
  const user = await getAuthUser();
  if (!user?.email) {
    throw new Error('No cached account on this device — cannot reset PIN.');
  }
  await requestOtp(user.email);
}

export async function verifyPinResetOtpAndSet(code: string, newPin: string): Promise<void> {
  const user = await getAuthUser();
  if (!user?.email) {
    throw new Error('No cached account on this device — cannot reset PIN.');
  }

  // Re-run the standard verify-code endpoint. The server treats this as a
  // normal login; on cap_reached we surface a typed error so the lock-screen
  // UI can route the user through the eviction flow if needed.
  const device = await getDeviceMetadata();
  const response = await apiCall<
    | {
        success: true;
        cap_reached: false;
        data: { token: string; expires_at: string; device_id: number };
        auth_state: AuthStateBlock;
      }
    | {
        success: true;
        cap_reached: true;
        max_devices: number;
        approval_token: string;
        devices: DeviceListItem[];
      }
  >('secure_auth', 'playground-verify-code', {
    method: 'POST',
    bearer: false,
    body: {
      email: user.email,
      code,
      device_uniq: device.device_uniq,
      device_label: device.device_label,
      os: device.os,
      os_version: device.os_version,
      app_version: device.app_version,
    },
  });

  if (response.cap_reached) {
    // Extremely unlikely on a device that already has a JWT, but possible if
    // the admin revoked us between cold-start and Forgot-PIN. Surface a
    // distinct error so the caller can decide whether to route to the full
    // CapReachedDialog or just message the user.
    throw new Error('Device cap reached — sign out via Settings and log in again.');
  }

  // Refresh the JWT + auth_user from the server (the new token replaces the
  // old one anyway — the verify endpoint always mints a fresh token).
  await saveJwt(response.data.token);
  await persistAuthState(response.auth_state, {
    current_device_id: response.data.device_id,
    device_label: device.device_label,
  });

  // Replace the PIN. setPin() resets failed_attempts / locked_until_at to 0.
  await savePin(newPin);
}
