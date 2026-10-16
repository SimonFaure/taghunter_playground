import { useEffect, useState } from 'react';
import { Crown, Radio, Usb, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { useLocalRole, useMotherConnection } from '../services/motherConnection';
import { isReaderConnected } from '../services/sportidentService';
import { loadConfig } from '../utils/config';
import { setSoundMuted, useSoundMuted } from '../utils/soundMute';

const READER_POLL_MS = 10_000;

type ReaderState = 'unknown' | 'ok' | 'bad';

// Top-bar status cluster (replaces the retired footer): a separator after the
// utility buttons, then
//  - the LAN role at a glance: crown = this device IS the mother; radio =
//    child connected to a mother (amber when not connected);
//  - the SI reader indicator. Its 10s poll is ALSO the app-wide reader
//    heartbeat: it pushes ReaderPresence to the Rust side (reported to the
//    mother via ping) and emits the 'reader:status' event game pages and the
//    launch modal re-detect from - keep it here, always mounted, or hotplug
//    stops propagating.
export function TopbarStatus() {
  const { t } = useTranslation('devicesLan');
  const localRole = useLocalRole();
  const conn = useMotherConnection();
  const soundMuted = useSoundMuted();

  const [readerState, setReaderState] = useState<ReaderState>('unknown');
  // Operator-only devices have no reader role - the reader indicator (and its
  // poll) are hidden entirely. Re-read on the 'operator-mode:changed' event
  // the Settings toggle dispatches so it reacts without a reload.
  const [operatorOnly, setOperatorOnly] = useState(false);

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

  const connected = conn.kind === 'child_ok';
  const motherLabel = conn.kind === 'child_ok' ? conn.motherLabel : null;
  // "Acts as the mother" is the running LAN server, nothing else: only the
  // mother runs it (a satellite, a stood-down or a demoted device has none), so
  // it wears the crown even when it still carries paired_mothers rows from a
  // time it followed another device. The mother_* kinds say the same thing.
  const actsAsMother =
    localRole?.isMother === true ||
    conn.kind === 'mother_hosting' ||
    conn.kind === 'mother_idle';

  // Role slots, empty during the first poll ('checking') so a connected
  // satellite doesn't flash the amber icons on load.
  let roleSlot: React.ReactNode = null;
  if (localRole !== null && conn.kind !== 'checking') {
    if (actsAsMother) {
      roleSlot = (
        <span
          className={`pg-status-icon ${localRole?.role === 'substitute' ? 'text-amber-400' : 'text-green-400'}`}
          title={localRole?.role === 'substitute' ? t('nav:motherSubstituteThisDevice') : t('nav:motherThisDevice')}
        >
          <Crown size={16} />
        </span>
      );
    } else {
      roleSlot = (
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
      {/* Ctrl+M mute: shown only while muted, click to restore the sound. */}
      {soundMuted && (
        <button
          type="button"
          className="pg-status-icon text-[var(--pg-accent-bright)]"
          title={t('soundMute:mutedIndicator')}
          onClick={() => setSoundMuted(false)}
        >
          <VolumeX size={16} />
        </button>
      )}

    </>
  );
}
