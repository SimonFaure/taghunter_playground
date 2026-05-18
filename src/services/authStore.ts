import { getDb } from './db';

export interface AuthUser {
  client_id: number;
  email: string;
  name: string | null;
  avatar_url: string | null;
  license_type: string;
  billing_up_to_date: boolean;
  max_devices: number;
  offline_grace_days: number;
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
  };
  max_devices: number;
  offline_grace_days: number;
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
  };
}

export async function persistAuthState(
  state: AuthStateBlock,
  options: { current_device_id?: number | null; device_label?: string | null } = {}
): Promise<void> {
  const db = await getDb();
  const existing = await getAuthUser();
  const currentDeviceId =
    options.current_device_id ?? existing?.current_device_id ?? null;
  const deviceLabel =
    options.device_label ?? existing?.device_label ?? null;

  await db.execute(
    `INSERT INTO auth_user (
       client_id, email, name, avatar_url, license_type, billing_up_to_date,
       max_devices, offline_grace_days, current_device_id, device_label,
       last_server_check_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT(client_id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       license_type = excluded.license_type,
       billing_up_to_date = excluded.billing_up_to_date,
       max_devices = excluded.max_devices,
       offline_grace_days = excluded.offline_grace_days,
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
      state.max_devices,
      state.offline_grace_days,
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

export async function isDifferentOwner(email: string): Promise<boolean> {
  const existing = await getAuthUser();
  return Boolean(existing && existing.email.toLowerCase() !== email.toLowerCase());
}
