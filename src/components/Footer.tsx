import { useEffect, useState } from 'react';
import { Usb, Wifi } from 'lucide-react';
import { platform } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';
import { isReaderConnected } from '../services/sportidentService';
import {
  getDeviceMetadata,
  getCachedDeviceDisplayName,
  type DeviceMetadata,
} from '../services/device';
import { refreshDeviceDisplayName } from '../services/auth';
import {
  useMotherConnection,
  type MotherConnectionState,
} from '../services/motherConnection';

const POLL_MS = 10_000;

type ReaderState = 'unknown' | 'ok' | 'bad';

export function Footer() {
  const [device, setDevice] = useState<DeviceMetadata | null>(null);
  // Operator-assigned friendly name (Settings → My Devices). Falls back to the
  // OS hostname (device.device_label) when unset.
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [readerState, setReaderState] = useState<ReaderState>('unknown');
  // Windows-only for this slice — non-Windows hides the wifi icon entirely.
  // null while the platform() promise hasn't resolved (one render frame).
  const [isWindows, setIsWindows] = useState<boolean | null>(null);

  const mother = useMotherConnection();

  useEffect(() => {
    try {
      setIsWindows(platform() === 'windows');
    } catch {
      setIsWindows(false);
    }
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    let lastState: ReaderState = 'unknown';
    const tick = async () => {
      const ok = await isReaderConnected().catch(() => false);
      if (cancelled) return;
      const next: ReaderState = ok ? 'ok' : 'bad';
      setReaderState(next);
      // Push the same boolean into the Rust-side ReaderPresence so the next
      // /ping.php tick reports it to the mother. The mother surfaces it as a
      // per-row reader badge in the Devices modal so the operator can pick
      // a launch target without physical inspection.
      void invoke('client_set_reader_presence', { hasReader: ok }).catch(() => {});
      // Emit a global event whenever the polled reader status flips. The
      // game pages + ConfigurationPage + LaunchGameModal subscribe via
      // useDetectedReaderPort() and re-run their VID/PID detection so
      // hotplug propagates without each component running its own poll.
      if (next !== lastState) {
        lastState = next;
        window.dispatchEvent(new CustomEvent('reader:status', { detail: { state: next } }));
      }
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const wifiView = isWindows === true ? motherToView(mother) : null;

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 bg-slate-800/90 backdrop-blur-sm border-t border-slate-700 py-3">
      <div className="container mx-auto px-6">
        <div className="flex items-center justify-between gap-6 text-slate-400 text-sm">
          <div className="flex items-center gap-6">
            {wifiView && (
              <Indicator
                icon={<Wifi size={16} />}
                label="WiFi"
                value={wifiView.value}
                color={wifiView.color}
                tooltip={wifiView.tooltip}
              />
            )}
            <Indicator
              icon={<Usb size={16} />}
              label="Reader"
              value={readerState === 'ok' ? 'OK' : readerState === 'bad' ? 'KO' : '…'}
              color={
                readerState === 'ok'
                  ? 'text-green-400'
                  : readerState === 'bad'
                    ? 'text-red-400'
                    : 'text-slate-500'
              }
            />
          </div>
          <div className="text-slate-500">
            {(() => {
              const name = displayName ?? device?.device_label ?? null;
              if (!name) return '…';
              return device ? `${name} · v${device.app_version}` : name;
            })()}
          </div>
        </div>
      </div>
    </footer>
  );
}

interface WifiView {
  value: string;
  color: string;
  tooltip: string;
}

function motherToView(state: MotherConnectionState): WifiView | null {
  switch (state.kind) {
    case 'hidden':
      return null;
    case 'checking':
      return { value: '…', color: 'text-slate-500', tooltip: 'Checking LAN…' };
    case 'mother_hosting':
      return {
        value: 'OK',
        color: 'text-green-400',
        tooltip: `Hotspot active, ${state.clientCount} client${state.clientCount === 1 ? '' : 's'}`,
      };
    case 'mother_partial':
      return {
        value: 'IDLE',
        color: 'text-slate-400',
        tooltip: 'Hotspot up, server not started',
      };
    case 'mother_idle':
      return {
        value: 'IDLE',
        color: 'text-slate-400',
        tooltip: 'Mother (hotspot off)',
      };
    case 'child_ok':
      return {
        value: 'OK',
        color: 'text-green-400',
        tooltip: `Connected to ${state.motherLabel ?? 'mother'} (${state.ssid ?? '—'})`,
      };
    case 'child_nearby':
      return {
        value: 'NEAR',
        color: 'text-orange-400',
        tooltip: 'Mother nearby but not responding',
      };
    case 'child_offline':
      return {
        value: 'KO',
        color: 'text-red-400',
        tooltip: 'No mother reachable',
      };
  }
}

interface IndicatorProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  tooltip?: string;
}

function Indicator({ icon, label, value, color, tooltip }: IndicatorProps) {
  return (
    <div className="flex items-center gap-2" title={tooltip}>
      <span className={color}>{icon}</span>
      <span>
        {label}: <span className={`font-medium ${color}`}>{value}</span>
      </span>
    </div>
  );
}
