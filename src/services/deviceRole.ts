// The role of this device on the LAN, and the only code that changes it.
//
// Two facts used to share one flag. "This PC is set as the mother" (the
// install-time choice, "Rôle de ce poste") and "this PC took a game over while
// the mother was away" both ended up as `beMotherWhenAvailable = true`, so after
// one failover nothing could tell the real mother from its replacement, and the
// mother changed PC with the power-on order. They are now separate:
//
//   mother      the device SET as the mother. It alone starts hosting by itself.
//   substitute  a device that is hosting without being set as the mother. It
//               hands everything back and stops as soon as the mother returns.
//   satellite   everything else.
//
// `beMotherWhenAvailable` is the configured role and nothing else; "substitute"
// is derived (server running + not configured). A takeover never writes the flag.

import { invoke } from '@tauri-apps/api/core';
import { loadConfig, saveConfig, CONFIG_CHANGED_EVENT } from '../utils/config';
import { getDb } from './db';
import {
  setDefaultMother,
  enqueuePendingOp,
  hasPendingMotherOp,
  getDefaultMotherLocal,
  setDefaultMotherLocal,
} from './lanNetworks';

export type DeviceRole = 'mother' | 'substitute' | 'satellite';

export function deviceRoleOf(configuredMother: boolean, serving: boolean): DeviceRole {
  if (configuredMother) return 'mother';
  return serving ? 'substitute' : 'satellite';
}

/** What this device claims when it starts hosting (passed to the Rust server). */
export interface HostingClaim {
  configured: boolean;
  designatedAt: number | null;
}

// The flag is read on every role poll (10 s, 4 s in a game): keep it in memory
// and drop the copy whenever something changes the config.
let cachedClaim: HostingClaim | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener(CONFIG_CHANGED_EVENT, () => {
    cachedClaim = null;
  });
}

export async function getHostingClaim(): Promise<HostingClaim> {
  if (cachedClaim) return cachedClaim;
  const cfg = await loadConfig();
  const claim = {
    configured: !!cfg.beMotherWhenAvailable,
    designatedAt: cfg.beMotherWhenAvailable ? cfg.motherDesignatedAt ?? null : null,
  };
  cachedClaim = claim;
  return claim;
}

export async function isConfiguredMother(): Promise<boolean> {
  return (await getHostingClaim().catch(() => null))?.configured ?? false;
}

async function metaGet(key: string): Promise<string | null> {
  const rows = await (await getDb()).select<{ value: string }[]>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [key],
  );
  return rows[0]?.value ?? null;
}

async function metaSet(key: string, value: string): Promise<void> {
  await (await getDb()).execute(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

/**
 * Set or clear "this device is the mother", everywhere it is recorded: the
 * config flag (what the boot reads), the Studio inventory (one mother per
 * licensee - Studio clears the bit on the others) and its local mirror. The
 * Studio write is queued when offline. Called by the onboarding question, by
 * Rôle de ce poste, and when this device gives the role up to a mother
 * designated after it.
 */
export async function setConfiguredMother(on: boolean): Promise<void> {
  const cfg = await loadConfig();
  await saveConfig({
    ...cfg,
    beMotherWhenAvailable: on,
    motherDesignatedAt: on ? Date.now() : undefined,
  });
  const motherUuid = on
    ? (await invoke<{ device_uuid: string }>('client_get_device_identity').catch(() => null))?.device_uuid ?? null
    : null;
  try {
    await setDefaultMother(on, motherUuid);
  } catch (e) {
    console.error('[deviceRole] set_default_mother failed, queued:', e);
    await enqueuePendingOp({ kind: 'mother', on, motherUuid });
  }
  await setDefaultMotherLocal(on);
  if (on) await invoke('client_clear_substitute_state').catch(() => {});
  await metaSet(RESET_NOTICE_KEY, '0').catch(() => {});
  window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT));
}

// ─── Studio is the reference for "one mother per licensee" ───────────────────

/** The `device` block of the auth_state, as far as the role goes. */
export interface StudioDeviceRole {
  /** Studio flags THIS device as the licensee's mother. */
  is_default_mother?: boolean;
  /** When the licensee's CURRENT mother was designated (ISO, Studio time). */
  mother_since?: string | null;
}

/**
 * The role was given to another PC ("Rôle de ce poste → Poste mère" over
 * there): Studio flags that one, and this device - still set as the mother
 * locally - learns it here, at its next exchange with Studio. It gives the
 * role up. On the LAN the same thing happens without Internet, from the two
 * designation dates (services/hostingRole.ts).
 *
 * Deliberately one-way and conservative: Studio never MAKES a device the
 * mother, and nothing happens when Studio has no dated mother (flags set
 * before dates existed), when this device was designated after Studio's
 * mother, or while this device's own choice is still queued for Studio.
 * Called on every auth_state, so it must stay cheap when there is nothing to do.
 */
export async function alignRoleWithStudio(device: StudioDeviceRole | undefined): Promise<void> {
  if (!device || device.is_default_mother !== false || !device.mother_since) return;
  const claim = await getHostingClaim().catch(() => null);
  if (!claim?.configured) return;
  const theirs = Date.parse(device.mother_since);
  if (!Number.isFinite(theirs) || theirs <= (claim.designatedAt ?? 0)) return;
  if (await hasPendingMotherOp().catch(() => true)) return;
  console.warn('[deviceRole] Studio: another device was set as the mother after this one - becoming a satellite.');
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, beMotherWhenAvailable: false, motherDesignatedAt: undefined });
  await setDefaultMotherLocal(false);
  window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT));
}

// ─── one-shot fleet migration ────────────────────────────────────────────────
//
// Builds before the role split wrote `beMotherWhenAvailable = true` on every
// takeover (and on "host and launch"), so a fleet in the field has several PCs
// flagged mother. The install-time choice survived apart, in `default_mother_on`
// (written only by the onboarding question and by Rôle de ce poste). On the
// first start of this build the flag goes back to that choice.
//
// One-way on purpose: a PC that was demoted by hand ("Je ne suis pas un poste
// mère" cleared the flag but not the mirror) stays a satellite.

const MIGRATED_KEY = 'role_flag_reconciled';
const RESET_NOTICE_KEY = 'role_reset_by_update';

export async function reconcileRoleFlagOnce(): Promise<void> {
  try {
    if ((await metaGet(MIGRATED_KEY)) === '1') return;
    const [cfg, installChoice] = await Promise.all([loadConfig(), getDefaultMotherLocal()]);
    if (cfg.beMotherWhenAvailable && !installChoice) {
      await saveConfig({ ...cfg, beMotherWhenAvailable: false, motherDesignatedAt: undefined });
      // Tell the operator once: a real mother set through an older screen that
      // wrote only the flag is reset too, and must be chosen again.
      await metaSet(RESET_NOTICE_KEY, '1');
      console.warn('[deviceRole] this device was flagged mother by a takeover - back to satellite.');
    } else if (!cfg.beMotherWhenAvailable && installChoice) {
      await setDefaultMotherLocal(false);
      await setDefaultMother(false).catch(() =>
        enqueuePendingOp({ kind: 'mother', on: false, motherUuid: null }),
      );
    }
    await metaSet(MIGRATED_KEY, '1');
    window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT));
  } catch (e) {
    // Not marked done: retried at the next start.
    console.error('[deviceRole] role flag migration failed:', e);
  }
}

/** The update turned this device back into a satellite and nobody has chosen its role since. */
export async function wasRoleResetByUpdate(): Promise<boolean> {
  return (await metaGet(RESET_NOTICE_KEY).catch(() => null)) === '1';
}

export async function dismissRoleResetNotice(): Promise<void> {
  await metaSet(RESET_NOTICE_KEY, '0').catch(() => {});
}
