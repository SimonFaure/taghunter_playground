import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Smartphone, Tablet, AlertCircle } from 'lucide-react';
import type { DeviceListItem } from '../../services/auth';

interface CapReachedDialogProps {
  devices: DeviceListItem[];
  maxDevices: number;
  onSelect: (deviceId: number) => void;
  onCancel: () => void;
  busy?: boolean;
}

export function CapReachedDialog({ devices, maxDevices, onSelect, onCancel, busy }: CapReachedDialogProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <div className="pg-panel p-6 max-w-lg w-full">
      <div className="flex items-start gap-3 mb-4">
        <div className="bg-amber-500/20 border border-amber-500/40 rounded-full p-2">
          <AlertCircle className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--pg-text)]">{t('authChrome:capReached.title')}</h2>
          <p className="text-sm text-[var(--pg-text-dim)] mt-1">
            {t('authChrome:capReached.message', { count: maxDevices })}
          </p>
        </div>
      </div>

      <div className="space-y-2 mb-6 max-h-72 overflow-y-auto">
        {devices.map((d) => {
          const Icon = osIcon(d.os);
          const isSelected = selected === d.id;
          return (
            <button
              key={d.id}
              type="button"
              disabled={busy}
              onClick={() => setSelected(d.id)}
              className={`w-full text-left p-3 rounded-[var(--pg-radius-md)] border transition flex items-center gap-3 ${
                isSelected
                  ? 'bg-red-500/10 border-red-500/60'
                  : 'bg-[var(--pg-surface)] border-[var(--pg-line)] hover:border-[var(--pg-line-strong)]'
              }`}
            >
              <Icon className="w-5 h-5 text-[var(--pg-text-muted)] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[var(--pg-text)] font-medium truncate">
                  {d.device_label || t('authChrome:capReached.deviceLabel', { os: d.os ?? t('authChrome:capReached.unknownOs') })}
                </div>
                <div className="text-xs text-[var(--pg-text-dim)]">
                  {[d.os, d.os_version].filter(Boolean).join(' ')}
                  {d.last_seen_at ? ` · ${t('authChrome:capReached.lastSeen', { time: formatTimestamp(d.last_seen_at) })}` : ''}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="pg-btn pg-btn--ghost disabled:opacity-50"
        >
          {t('authChrome:capReached.cancel')}
        </button>
        <button
          type="button"
          onClick={() => selected && onSelect(selected)}
          disabled={!selected || busy}
          className="pg-btn pg-btn--danger disabled:opacity-50"
        >
          {busy ? t('authChrome:capReached.removing') : t('authChrome:capReached.removeAndContinue')}
        </button>
      </div>
    </div>
  );
}

function osIcon(os: string | null) {
  switch ((os ?? '').toLowerCase()) {
    case 'ios':
    case 'android':
      return Smartphone;
    case 'ipados':
      return Tablet;
    default:
      return Monitor;
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
