import { useEffect, useState } from 'react';
import {
  getDeviceMetadata,
  getCachedDeviceDisplayName,
  type DeviceMetadata,
} from '../services/device';
import { refreshDeviceDisplayName } from '../services/auth';

// The device's identity line - friendly name + app version - rendered in
// normal page flow at the bottom of every chrome page (mt-auto pins it to the
// viewport bottom on short pages). Replaces the right side of the retired
// fixed footer.
export function DeviceIdentityLine() {
  const [device, setDevice] = useState<DeviceMetadata | null>(null);
  // Operator-assigned friendly name (Settings → My Devices). Falls back to the
  // OS hostname (device.device_label) when unset.
  const [displayName, setDisplayName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const meta = await getDeviceMetadata().catch(() => null);
      if (cancelled) return;
      if (meta) setDevice(meta);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Friendly device name: show the cached value instantly (offline-safe), then
  // reconcile with the server. Re-fetch whenever the user renames a device in
  // Settings → My Devices (which dispatches `device:renamed`).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const cached = await getCachedDeviceDisplayName().catch(() => null);
      if (!cancelled && cached) setDisplayName(cached);
      const fresh = await refreshDeviceDisplayName().catch(() => null);
      if (!cancelled) setDisplayName(fresh);
    };
    void load();
    const onRenamed = () => void load();
    window.addEventListener('device:renamed', onRenamed);
    return () => {
      cancelled = true;
      window.removeEventListener('device:renamed', onRenamed);
    };
  }, []);

  const name = displayName ?? device?.device_label ?? null;

  return (
    <div className="mt-auto px-6 py-3 text-right text-xs text-[var(--pg-text-dim)]">
      {name ? (device ? `${name} · v${device.app_version}` : name) : '…'}
    </div>
  );
}
