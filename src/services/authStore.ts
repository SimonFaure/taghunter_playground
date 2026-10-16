import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getDb } from './db';

// Studio origin (the brand image lives under /media there). Derived from the
// API base by stripping the /backend/api suffix, so a relative brand_logo_url
// like "/media/avatars/x.png" resolves to an absolute, fetchable URL.
const STUDIO_ORIGIN = (
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
  'https://studio.taghunter.fr/backend/api'
).replace(/\/backend\/api$/, '');

function resolveBrandUrl(raw: string): string {
  if (/^(https?:|data:|blob:)/.test(raw)) return raw;
  return `${STUDIO_ORIGIN}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

// Download an image into a base64 `data:` URL so it can be embedded directly in
// the offline print iframe. Returns null on any failure (offline, 404, …) - the
// caller then keeps whatever it had cached before.
async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await tauriFetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get('content-type') || 'image/png';
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:${mime};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

export interface AuthUser {
  client_id: number;
  email: string;
  name: string | null;
  avatar_url: string | null;
  license_type: string;
  billing_up_to_date: boolean;
  language: string;
  update_channel: string;
  max_devices: number;
  offline_grace_days: number;
  // Emergency device-disable + billing auto-lock (project_client_device_lock).
  // Cached from auth_state so the launch/join gate is computable offline.
  devices_disabled: boolean;
  billing_overdue_since: string | null;
  billing_grace_days: number;
  billing_reprieve_days: number;
  // Master on/off for the Playground app (project_client_app_section). When false
  // the whole app self-locks - a stronger lock than devices_disabled (which only
  // blocks launch/join). Cached from auth_state so it holds offline.
  playground_enabled: boolean;
  // Device-local: a recovery code grants a reprieve until this instant. NOT in
  // auth_state - set by grantReprieve() (services/deviceLock.ts) and preserved
  // across bootstraps.
  billing_reprieve_until: string | null;
  // "Use my logo on printed reports" (project_report_layouts_editor_labels).
  // brand_logo_url is the resolved (absolute) remote brand image; brand_logo_data
  // is its bytes as a base64 data: URL, cached for OFFLINE report printing.
  report_use_brand_logo: boolean;
  brand_logo_url: string | null;
  brand_logo_data: string | null;
  current_device_id: number | null;
  device_label: string | null;
  last_server_check_at: string;
}

export interface AuthStateBlock {
  user: {
    client_id: number;
    email: string;
    name: string | null;
    avatar_url: string | null;
    license_type: string;
    billing_up_to_date: boolean;
    language?: string;
  };
  // Resolved app-update channel (device override -> client -> stable).
  update_channel?: string;
  max_devices: number;
  offline_grace_days: number;
  // Device-lock fields (project_client_device_lock). Optional so an older
  // server payload still persists cleanly (defaults applied below).
  devices_disabled?: boolean;
  billing_overdue_since?: string | null;
  billing_grace_days?: number;
  billing_reprieve_days?: number;
  // Playground master on/off (project_client_app_section). Optional so an older
  // server payload (pre-Client-App) defaults to enabled rather than locking out.
  playground_enabled?: boolean;
  // Brand-logo-on-reports (project_report_layouts_editor_labels). brand_logo_url
  // is the server-resolved brand image (uploaded company logo, else avatar).
  // Optional so older payloads persist cleanly.
  brand_logo_url?: string | null;
  report_use_brand_logo?: boolean;
  // The calling device, when the token is bound to one. `is_default_mother` /
  // `mother_since` say which device Studio holds as the licensee's mother
  // (see deviceRole.alignRoleWithStudio). Absent on an older server.
  device?: {
    id: number;
    is_default_mother?: boolean;
    mother_since?: string | null;
  };
  server_time: string;
}

export async function getAuthUser(): Promise<AuthUser | null> {
  const db = await getDb();
  const rows = await db.select<AuthUser[]>('SELECT * FROM auth_user LIMIT 1');
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    billing_up_to_date: Boolean(row.billing_up_to_date),
    devices_disabled: Boolean(row.devices_disabled),
    playground_enabled: Boolean(row.playground_enabled),
    report_use_brand_logo: Boolean(row.report_use_brand_logo),
  };
}

export async function persistAuthState(
  state: AuthStateBlock,
  options: { current_device_id?: number | null; device_label?: string | null } = {}
): Promise<void> {
  const db = await getDb();
  const existing = await getAuthUser();
  // Studio holds one mother per licensee: a device that lost the role there
  // gives it up here. Imported lazily (deviceRole reaches back into api.ts).
  if (state.device) {
    void import('./deviceRole')
      .then((m) => m.alignRoleWithStudio(state.device))
      .catch(() => {});
  }
  const currentDeviceId =
    options.current_device_id ?? existing?.current_device_id ?? null;
  const deviceLabel =
    options.device_label ?? existing?.device_label ?? null;

  // Brand-logo-on-reports cache. Resolve the remote brand image to an absolute
  // URL and, while online, download its bytes into a base64 data: URL so reports
  // can print the client's logo fully offline. We only re-download when the URL
  // changed (or nothing is cached yet) and the client has the feature on, so the
  // common per-response persist stays a pure DB write. A failed/offline fetch
  // keeps the previous cache (and the previous URL, so it retries next time).
  const useBrand = !!state.report_use_brand_logo;
  const resolvedUrl = state.brand_logo_url ? resolveBrandUrl(state.brand_logo_url) : null;
  let brandUrl = existing?.brand_logo_url ?? null;
  let brandData = existing?.brand_logo_data ?? null;
  if (!resolvedUrl) {
    brandUrl = null;
    brandData = null;
  } else if (resolvedUrl === existing?.brand_logo_url && existing?.brand_logo_data) {
    brandUrl = resolvedUrl; // already cached for this URL
  } else if (useBrand) {
    const fetched = await fetchImageAsDataUrl(resolvedUrl);
    if (fetched) {
      brandUrl = resolvedUrl;
      brandData = fetched;
    }
    // else: keep prior brandUrl/brandData so the next online persist retries.
  }

  // billing_reprieve_until is deliberately NOT written here: it is device-local
  // (set by grantReprieve) and must survive a bootstrap. It isn't in the column
  // list, so ON CONFLICT UPDATE leaves it untouched; a fresh INSERT takes its
  // NULL default. Design: project_client_device_lock.
  await db.execute(
    `INSERT INTO auth_user (
       client_id, email, name, avatar_url, license_type, billing_up_to_date,
       language, update_channel, max_devices, offline_grace_days,
       devices_disabled, billing_overdue_since, billing_grace_days, billing_reprieve_days,
       playground_enabled,
       report_use_brand_logo, brand_logo_url, brand_logo_data,
       current_device_id, device_label,
       last_server_check_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT(client_id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       license_type = excluded.license_type,
       billing_up_to_date = excluded.billing_up_to_date,
       language = excluded.language,
       update_channel = excluded.update_channel,
       max_devices = excluded.max_devices,
       offline_grace_days = excluded.offline_grace_days,
       devices_disabled = excluded.devices_disabled,
       billing_overdue_since = excluded.billing_overdue_since,
       billing_grace_days = excluded.billing_grace_days,
       billing_reprieve_days = excluded.billing_reprieve_days,
       playground_enabled = excluded.playground_enabled,
       report_use_brand_logo = excluded.report_use_brand_logo,
       brand_logo_url = excluded.brand_logo_url,
       brand_logo_data = excluded.brand_logo_data,
       current_device_id = excluded.current_device_id,
       device_label = excluded.device_label,
       last_server_check_at = excluded.last_server_check_at`,
    [
      state.user.client_id,
      state.user.email,
      state.user.name,
      state.user.avatar_url,
      state.user.license_type,
      state.user.billing_up_to_date ? 1 : 0,
      state.user.language ?? 'fr',
      state.update_channel ?? 'stable',
      state.max_devices,
      state.offline_grace_days,
      state.devices_disabled ? 1 : 0,
      state.billing_overdue_since ?? null,
      state.billing_grace_days ?? 30,
      state.billing_reprieve_days ?? 7,
      // Absent (older payload) => enabled, so a stale server never locks the app.
      (state.playground_enabled ?? true) ? 1 : 0,
      useBrand ? 1 : 0,
      brandUrl,
      brandData,
      currentDeviceId,
      deviceLabel,
      new Date().toISOString(),
    ]
  );
}

export async function clearAuthUser(): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM auth_user');
}

export async function isWithinOfflineGrace(user: AuthUser, now: Date = new Date()): Promise<boolean> {
  const last = new Date(user.last_server_check_at);
  const ageMs = now.getTime() - last.getTime();
  const graceMs = user.offline_grace_days * 24 * 60 * 60 * 1000;
  return ageMs <= graceMs;
}

// Only surface the offline-grace warning banner once the runway is short.
// Below this many days remaining we nag; above it the device has plenty of
// offline headroom and the banner would just be noise.
export const OFFLINE_WARNING_THRESHOLD_DAYS = 7;

export interface OfflineGraceInfo {
  // Whole days since the last successful server check.
  ageDays: number;
  // Whole days of offline access still left (clamped at 0).
  remainingDays: number;
  // The client's configured total offline allowance.
  graceDays: number;
}

// Shared computation behind the offline banner, the offline-locked screen, and
// the Account-tab "offline access left" row. Keeping it in one place means all
// three surfaces agree on the same day arithmetic.
export function offlineGraceInfo(user: AuthUser, now: Date = new Date()): OfflineGraceInfo {
  const lastSeen = new Date(user.last_server_check_at);
  const ageDays = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24));
  const remainingDays = Math.max(0, user.offline_grace_days - ageDays);
  return { ageDays, remainingDays, graceDays: user.offline_grace_days };
}

export async function isDifferentOwner(email: string): Promise<boolean> {
  const existing = await getAuthUser();
  return Boolean(existing && existing.email.toLowerCase() !== email.toLowerCase());
}
