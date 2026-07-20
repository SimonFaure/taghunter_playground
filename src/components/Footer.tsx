import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Globe, Usb, Wifi, Crown, RadioTower } from 'lucide-react';
import { platform } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';
import { isReaderConnected } from '../services/sportidentService';
import { loadConfig } from '../utils/config';
import {
  getDeviceMetadata,
  getCachedDeviceDisplayName,
  type DeviceMetadata,
} from '../services/device';
import { refreshDeviceDisplayName } from '../services/auth';
import {
  useMotherConnection,
  useLocalRole,
  type MotherConnectionState,
} from '../services/motherConnection';
import { probeStudioReachable } from '../services/connectivity';

const POLL_MS = 10_000;
// Internet reachability is probed less often than the reader poll - a real
// HTTP round-trip to studio, so 30s keeps it cheap. Reconnects surface faster
// via the window online/offline listeners below.
const ONLINE_POLL_MS = 30_000;

type ReaderState = 'unknown' | 'ok' | 'bad';
type OnlineState = 'unknown' | 'online' | 'offline';

// Whether this device can actually reach the internet (studio). We deliberately
// do NOT trust navigator.onLine here: a satellite joined to the mother's hotspot
// has LAN connectivity but no internet, yet navigator.onLine reports `true`.
// probeStudioReachable() makes a real request to studio's health check, so the
// footer reflects true internet access rather than mere link state.
function useInternetReachable(): OnlineState {
  const [state, setState] = useState<OnlineState>('unknown');
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const ok = await probeStudioReachable();
        if (!cancelled) setState(ok ? 'online' : 'offline');
      } finally {
        inFlight = false;
      }
    };
    void check();
    const id = setInterval(() => void check(), ONLINE_POLL_MS);
    // navigator.onLine can lie, but its transitions are still a useful trigger
    // to re-probe immediately so reconnects don't wait for the next 30s tick.
    const onChange = () => void check();
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('online', onChange);
      window.removeEventListener('offline', onChange);
    };
  }, []);
  return state;
}

export function Footer() {
  const { t } = useTranslation();
  const [device, setDevice] = useState<DeviceMetadata | null>(null);
  // Operator-assigned friendly name (Settings → My Devices). Falls back to the
  // OS hostname (device.device_label) when unset.
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [readerState, setReaderState] = useState<ReaderState>('unknown');
  // Operator-only devices have no reader role - the reader indicator (and its
  // 10s poll) are hidden entirely. Re-read on the 'operator-mode:changed' event
  // the Settings toggle dispatches so it reacts without a reload.
  const [operatorOnly, setOperatorOnly] = useState(false);
  // Windows-only for this slice - non-Windows hides the wifi icon entirely.
  // null while the platform() promise hasn't resolved (one render frame).
  const [isWindows, setIsWindows] = useState<boolean | null>(null);

  const mother = useMotherConnection();
  const localRole = useLocalRole();
  const online = useInternetReachable();

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
    const load = async () => {
      const cfg = await loadConfig().catch(() => null);
      if (!cancelled) setOperatorOnly(cfg?.operatorOnlyDevice === true);
    };
    void load();
    const onChange = () => void load();
    window.addEventListener('operator-mode:changed', onChange);
    return () => {
      cancelled = true;
      window.removeEventListener('operator-mode:changed', onChange);
    };
  }, []);

  useEffect(() => {
    // No reader role on operator-only devices - skip the poll + presence report.
    if (operatorOnly) return;
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
  }, [operatorOnly]);

  const wifiView = isWindows === true ? motherToView(mother, t) : null;

  return (
    <footer className="pg-statusbar fixed bottom-0 left-0 right-0 z-40">
      <div className="flex items-center gap-6">
        <Indicator
          icon={<Globe size={16} />}
          label={t('footer:internet')}
          value={online === 'online' ? t('footer:on') : online === 'offline' ? t('footer:off') : '…'}
          color={
            online === 'online'
              ? 'text-green-400'
              : online === 'offline'
                ? 'text-red-400'
                : 'text-[var(--pg-text-dim)]'
          }
          tooltip={
            online === 'online'
              ? t('footer:internetOk')
              : online === 'offline'
                ? t('footer:internetNone')
                : t('footer:internetChecking')
          }
        />
        {wifiView && (
          <Indicator
            icon={<Wifi size={16} />}
            label={t('footer:wifi')}
            value={wifiView.value}
            color={wifiView.color}
            tooltip={wifiView.tooltip}
          />
        )}
        {isWindows === true && (
          <Indicator
            icon={<Crown size={16} />}
            label={t('footer:motherRole')}
            value={
              localRole === null
                ? '…'
                : localRole.isMother
                  ? t('footer:yes')
                  : t('footer:no')
            }
            color={localRole?.isMother ? 'text-green-400' : 'text-[var(--pg-text-dim)]'}
            tooltip={
              localRole === null
                ? t('footer:checkingLan')
                : localRole.isMother
                  ? t('footer:motherRoleYes')
                  : t('footer:motherRoleNo')
            }
          />
        )}
        {isWindows === true && (
          <Indicator
            icon={<RadioTower size={16} />}
            label={t('footer:hotspot')}
            value={
              localRole === null
                ? '…'
                : localRole.isHotspot
                  ? t('footer:hotspotStateOn')
                  : t('footer:hotspotStateOff')
            }
            color={localRole?.isHotspot ? 'text-green-400' : 'text-[var(--pg-text-dim)]'}
            tooltip={
              localRole === null
                ? t('footer:checkingLan')
                : localRole.isHotspot
                  ? t('footer:hotspotOn')
                  : t('footer:hotspotOff')
            }
          />
        )}
        {!operatorOnly && (
          <Indicator
            icon={<Usb size={16} />}
            label={t('footer:reader')}
            value={readerState === 'ok' ? t('footer:ok') : readerState === 'bad' ? t('footer:ko') : '…'}
            color={
              readerState === 'ok'
                ? 'text-green-400'
                : readerState === 'bad'
                  ? 'text-[var(--pg-accent-bright)]'
                  : 'text-[var(--pg-text-dim)]'
            }
          />
        )}
      </div>
      <div className="pg-status-right">
        {(() => {
          const name = displayName ?? device?.device_label ?? null;
          if (!name) return '…';
          return device ? `${name} · v${device.app_version}` : name;
        })()}
      </div>
    </footer>
  );
}

interface WifiView {
  value: string;
  color: string;
  tooltip: string;
}

function motherToView(state: MotherConnectionState, t: TFunction): WifiView | null {
  switch (state.kind) {
    case 'hidden':
      return null;
    case 'checking':
      return { value: '…', color: 'text-[var(--pg-text-dim)]', tooltip: t('footer:checkingLan') };
    case 'mother_hosting':
      return {
        value: t('footer:ok'),
        color: 'text-green-400',
        tooltip: t('footer:hotspotActive', { count: state.clientCount }),
      };
    case 'mother_partial':
      return {
        value: t('footer:idle'),
        color: 'text-[var(--pg-text-dim)]',
        tooltip: t('footer:hotspotUpServerNotStarted'),
      };
    case 'mother_idle':
      return {
        value: t('footer:idle'),
        color: 'text-[var(--pg-text-dim)]',
        tooltip: t('footer:motherHotspotOff'),
      };
    case 'mother_detected':
      return {
        value: t('footer:detected'),
        color: 'text-blue-300',
        tooltip: t('footer:motherDetected', { count: state.count }),
      };
    case 'child_ok':
      return {
        value: t('footer:ok'),
        color: 'text-green-400',
        tooltip: t('footer:connectedTo', {
          mother: state.motherLabel ?? t('footer:mother'),
          ssid: state.ssid ?? '-',
        }),
      };
    case 'child_nearby':
      return {
        value: t('footer:near'),
        color: 'text-orange-400',
        tooltip: t('footer:motherNearbyNotResponding'),
      };
    case 'child_offline':
      return {
        value: t('footer:ko'),
        color: 'text-red-400',
        tooltip: t('footer:noMotherReachable'),
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
    <div className="pg-status-item" title={tooltip}>
      <span className={color}>{icon}</span>
      <span>
        {label}: <span className={`font-medium ${color}`}>{value}</span>
      </span>
    </div>
  );
}
