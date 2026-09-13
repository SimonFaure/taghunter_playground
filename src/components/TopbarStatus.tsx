import { useCallback, useEffect, useRef, useState } from 'react';
import { Crown, Radio, Wifi, Usb, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { platform } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';
import { useLocalRole, useMotherConnection } from '../services/motherConnection';
import { connectConfiguredNetwork } from '../services/wifiAutoConnect';
import { isReaderConnected } from '../services/sportidentService';
import { loadConfig } from '../utils/config';

const READER_POLL_MS = 10_000;

type ReaderState = 'unknown' | 'ok' | 'bad';
type Toast = { kind: 'ok' | 'err'; text: string };

// Top-bar status cluster (replaces the retired footer): a separator after the
// utility buttons, then
//  - the LAN role at a glance: crown = this device IS the mother; radio =
//    child connected to a mother; amber Wi-Fi button = child NOT connected,
//    one tap joins the mother's Wi-Fi (same auto-connect engine as the Join
//    tab, Windows-only since the Wi-Fi primitives only exist there);
//  - the SI reader indicator. Its 10s poll is ALSO the app-wide reader
//    heartbeat: it pushes ReaderPresence to the Rust side (reported to the
//    mother via ping) and emits the 'reader:status' event game pages and the
//    launch modal re-detect from - keep it here, always mounted, or hotplug
//    stops propagating.
export function TopbarStatus() {
  const { t } = useTranslation('devicesLan');
  const localRole = useLocalRole();
  const conn = useMotherConnection();

  const [isWindows, setIsWindows] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [readerState, setReaderState] = useState<ReaderState>('unknown');
  // Operator-only devices have no reader role - the reader indicator (and its
  // poll) are hidden entirely. Re-read on the 'operator-mode:changed' event
  // the Settings toggle dispatches so it reacts without a reload.
  const [operatorOnly, setOperatorOnly] = useState(false);

  useEffect(() => {
    try {
      setIsWindows(platform() === 'windows');
    } catch {
      setIsWindows(false);
    }
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
    }, READER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [operatorOnly]);

  const flash = useCallback((next: Toast) => {
    setToast(next);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const connect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setToast(null);
    try {
      // Directly attempt the networks saved in wifi_networks (no scan gate) so an
      // explicit press connects even if the SSID missed the last Wi-Fi scan.
      const r = await connectConfiguredNetwork();
      switch (r.kind) {
        case 'connected':
          flash({ kind: 'ok', text: t('autoConnected', { ssid: r.ssid }) });
          break;
        case 'failed':
          flash({ kind: 'err', text: t('autoConnectFailed', { ssid: r.ssid }) });
          break;
        case 'noop':
          flash({
            kind: 'err',
            text:
              r.reason === 'no-networks'
                ? t('noStudioHotspot')
                : r.reason === 'already-on-known'
                  ? t('connectAlready')
                  : t('connectNotFound'),
          });
          break;
      }
    } catch (e) {
      flash({ kind: 'err', text: (e as Error)?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }, [busy, flash, t]);

  const connected = conn.kind === 'child_ok';
  const motherLabel = conn.kind === 'child_ok' ? conn.motherLabel : null;
  // "Acts as the mother" comes from the connection state machine, NOT the raw
  // mother_server_running flag: a satellite whose local server happens to be up
  // (be-mother preference left on, pre-demote leftovers) but which is paired to
  // a real mother must NOT wear the crown. The state machine collapses that
  // correctly - mother_* kinds mean this device genuinely hosts/provides the
  // LAN; child_* kinds mean it follows a mother. The raw flag is only the
  // fallback for a mother with nothing paired yet (kind 'hidden'/'mother_detected').
  const actsAsMother =
    conn.kind === 'mother_hosting' ||
    conn.kind === 'mother_partial' ||
    conn.kind === 'mother_idle' ||
    (localRole?.isMother === true && (localRole?.pairedMotherCount ?? 0) === 0);

  // Role slots, empty during the first poll ('checking') so a connected
  // satellite doesn't flash the amber icons on load. A child shows its
  // connection status icon PLUS, when not connected, the one-tap "join the
  // mother's Wi-Fi" action button right next to it (Windows-only - the Wi-Fi
  // join primitives only exist there).
  let roleSlot: React.ReactNode = null;
  if (localRole !== null && conn.kind !== 'checking') {
    if (actsAsMother) {
      roleSlot = (
        <span className="pg-status-icon text-green-400" title={t('nav:motherThisDevice')}>
          <Crown size={16} />
        </span>
      );
    } else {
      roleSlot = (
        <>
          <span
            className={`pg-status-icon ${connected ? 'text-green-400' : 'text-amber-400'}`}
            title={
              connected
                ? motherLabel
                  ? t('nav:motherConnectedTo', { label: motherLabel })
                  : t('nav:motherConnected')
                : t('nav:motherNotConnected')
            }
          >
            <Radio size={16} />
          </span>
          {!connected && isWindows === true && (
            <button
              onClick={() => void connect()}
              disabled={busy}
              className="pg-icon-btn text-amber-400"
              aria-label={t('connectTooltip')}
              title={busy ? t('connectSearching') : t('connectTooltip')}
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />}
            </button>
          )}
        </>
      );
    }
  }

  return (
    <>
      <span className="pg-utils-sep" aria-hidden="true" />
      {roleSlot}
      {!operatorOnly && (
        <span
          className={`pg-status-icon ${
            readerState === 'ok'
              ? 'text-green-400'
              : readerState === 'bad'
                ? 'text-[var(--pg-accent-bright)]'
                : 'text-[var(--pg-text-dim)]'
          }`}
          title={
            readerState === 'ok'
              ? t('nav:readerOk')
              : readerState === 'bad'
                ? t('nav:readerKo')
                : t('nav:readerChecking')
          }
        >
          <Usb size={16} />
        </span>
      )}

      {toast && (
        <div
          className={`fixed top-16 right-4 z-50 max-w-xs text-sm rounded-lg px-3 py-2 border shadow-lg ${
            toast.kind === 'ok'
              ? 'bg-[var(--pg-ok-bg)] border-[var(--pg-ok-line)] text-[var(--pg-ok-text)]'
              : 'bg-[var(--pg-danger-bg)] border-[var(--pg-danger-line)] text-[var(--pg-danger-text)]'
          }`}
          role="status"
        >
          {toast.text}
        </div>
      )}
    </>
  );
}
