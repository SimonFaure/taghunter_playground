import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tablet, X, ChevronRight, Loader2 } from 'lucide-react';
import { listPairedDevicesForLaunch, type PairedDeviceStatusRow } from '../services/launchedGames';

interface DevicePickerProps {
  title: string;
  /** Hint shown above the device list (when devices exist). */
  hint: string;
  /** Label on the confirm button. */
  sendLabel: string;
  /** Message shown when no online paired device is available. */
  emptyLabel: string;
  /** Push to the selected device ids. Resolves → modal closes via onSent. */
  onSend: (deviceIds: number[]) => Promise<void>;
  onClose: () => void;
  /** Called with the number of targeted devices once the send resolves. */
  onSent: (count: number) => void;
}

/**
 * Pick one or more online paired devices and push something to them. Generic
 * over the action - used by the ranking push (RankingDevicePicker) and the
 * per-team summary push (LaunchedGamesList) via the `onSend` callback.
 */
export function DevicePicker({ title, hint, sendLabel, emptyLabel, onSend, onClose, onSent }: DevicePickerProps) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<PairedDeviceStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listPairedDevicesForLaunch();
        // Any online paired device except this one (you can't push to self).
        if (!cancelled) setDevices(rows.filter((d) => d.online && !d.is_self));
      } catch (err) {
        console.error('[DevicePicker] list failed:', err);
        if (!cancelled) setDevices([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const send = async () => {
    if (selected.size === 0 || sending) return;
    setSending(true);
    try {
      await onSend([...selected]);
      onSent(selected.size);
    } catch (err) {
      console.error('[DevicePicker] send failed:', err);
      setSending(false);
    }
  };

  return (
    <div className="pg-overlay p-4" onClick={onClose}>
      <div className="pg-modal max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="pg-modal-head">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--pg-accent-tint)] flex items-center justify-center">
              <Tablet size={16} className="text-[var(--pg-accent-bright)]" />
            </div>
            <h2 className="pg-modal-title">{title}</h2>
          </div>
          <button onClick={onClose} className="pg-modal-close" title={t('operatorControls:devicePicker.close')}>
            <X size={16} />
          </button>
        </div>

        <div className="p-6 space-y-3">
          {loading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-14 bg-[var(--pg-surface-2)] rounded-xl animate-pulse" />
              ))}
            </div>
          ) : devices.length === 0 ? (
            <div className="text-center py-8">
              <Tablet size={32} className="text-[var(--pg-text-dim)] mx-auto mb-3" />
              <p className="text-[var(--pg-text-dim)] text-sm">{emptyLabel}</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-[var(--pg-text-dim)]">{hint}</p>
              <div className="space-y-2">
                {devices.map((d) => {
                  const sel = selected.has(d.id);
                  return (
                    <button
                      key={d.id}
                      onClick={() => toggle(d.id)}
                      className={`w-full flex items-center gap-3 p-4 rounded-xl border text-left transition-all ${
                        sel
                          ? 'bg-[var(--pg-accent-tint)] border-[var(--pg-accent-line)]'
                          : 'bg-[var(--pg-surface-2)] border-[var(--pg-line)] hover:border-[var(--pg-line-strong)]'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                        sel ? 'bg-[var(--pg-accent)] border-[var(--pg-accent)]' : 'border-[var(--pg-line-strong)]'
                      }`}>
                        {sel && (
                          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                            <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                      <div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[var(--pg-text)] font-semibold text-sm leading-tight truncate">{d.device_label}</div>
                        {d.peer_os && <div className="text-[var(--pg-text-dim)] text-xs mt-0.5">{d.peer_os}</div>}
                      </div>
                    </button>
                  );
                })}
              </div>

              <button
                disabled={selected.size === 0 || sending}
                onClick={() => void send()}
                className="pg-btn pg-btn--primary w-full justify-center mt-1"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : null}
                {sendLabel}
                {selected.size > 0 && (
                  <span className="px-1.5 py-0.5 bg-white/20 rounded-md text-xs font-bold">{selected.size}</span>
                )}
                <ChevronRight size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
