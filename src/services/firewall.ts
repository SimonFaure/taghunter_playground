// Windows Firewall opening for the mother's inbound LAN port.
//
// On a normal (unelevated) install, the app can't add the firewall rule the
// mother's axum server needs, so satellites on the hotspot's "Public" network
// profile can't open a TCP connection to it - the mother is *discoverable* over
// mDNS (multicast is allowed) but *unreachable* over HTTP (custom inbound TCP is
// blocked). This module escalates via a single one-time UAC prompt.
//
// The rule is also added by the NSIS installer hook when the installer runs
// elevated; this runtime path is the fallback for per-user installs / updates
// that don't elevate. Both are idempotent.

import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { getDb } from './db';

// Versioned: bumping this key forces every existing install to re-run the
// one-time elevated add on next launch (one UAC). Bumped to _v2 when the
// PORT-scoped inbound rule (TCP 47800-47803) was added alongside the historical
// program-scoped rule - a device that already had the _v1 flag set would
// otherwise return early (its program rule "looks present") and never pick up the
// port rule, which is the one that actually makes the mother reachable when the
// program rule's stored exe path has gone stale after a rebuild/reinstall.
const FLAG_KEY = 'firewall_rule_added_v2';

async function readFlag(): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [FLAG_KEY]
  );
  return rows[0]?.value ?? null;
}

async function writeFlag(value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [FLAG_KEY, value]
  );
}

/**
 * Open the firewall for the mother's LAN port ONCE per machine. Shows a single
 * UAC prompt the first time this device hosts a mother server; on success
 * persists a flag so it never prompts again (a declined prompt leaves the flag
 * unset, so the operator can retry via the Network-tab repair button). Windows-
 * only, best-effort, never throws - safe to fire-and-forget from a boot path.
 *
 * The flag is a belief, not proof: the uninstaller deletes the rule while app
 * data (and the flag) survive a reinstall, and GPO/AV cleanups delete rules
 * too - the device then looks fine but is unreachable over TCP. So a set flag
 * is re-verified against the LIVE firewall (read-only netsh, no UAC); only a
 * DEFINITIVE "rule absent" clears it and re-runs the one-time elevated add.
 */
export async function ensureFirewallRuleOnce(): Promise<void> {
  try {
    if (platform() !== 'windows') return;
    if ((await readFlag()) === '1') {
      const present = await invoke<boolean | null>('mother_firewall_rule_status').catch(
        () => null
      );
      if (present !== false) return; // verified or indeterminate → trust the flag
      console.warn('[firewall] persisted flag is stale - rule is gone from the live firewall; re-adding.');
      await writeFlag('');
    }
    const ok = await invoke<boolean>('mother_open_firewall_elevated').catch(() => false);
    if (ok) await writeFlag('1');
  } catch {
    /* best-effort */
  }
}

/**
 * Force the firewall repair on demand (Network-tab button), ignoring the
 * one-time flag. Returns whether the elevated rule was added (false if the user
 * declined the UAC prompt). Non-Windows returns true (nothing to do).
 */
export async function repairFirewallRule(): Promise<boolean> {
  try {
    if (platform() !== 'windows') return true;
    const ok = await invoke<boolean>('mother_open_firewall_elevated').catch(() => false);
    if (ok) await writeFlag('1').catch(() => {});
    return ok;
  } catch {
    return false;
  }
}
