import { useState } from 'react';
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
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 max-w-lg w-full">
      <div className="flex items-start gap-3 mb-4">
        <div className="bg-amber-500/20 border border-amber-500/40 rounded-full p-2">
          <AlertCircle className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Device limit reached</h2>
          <p className="text-sm text-slate-400 mt-1">
            Your account allows {maxDevices} device{maxDevices === 1 ? '' : 's'}. Pick one to log out so this device can be added.
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
              className={`w-full text-left p-3 rounded-lg border transition flex items-center gap-3 ${
                isSelected
                  ? 'bg-red-500/10 border-red-500/60'
                  : 'bg-slate-900/60 border-slate-700 hover:border-slate-500'
              }`}
            >
              <Icon className="w-5 h-5 text-slate-300 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium truncate">
                  {d.device_label || `${d.os ?? 'Unknown'} device`}
                </div>
                <div className="text-xs text-slate-400">
                  {[d.os, d.os_version].filter(Boolean).join(' ')}
                  {d.last_seen_at ? ` · last seen ${formatTimestamp(d.last_seen_at)}` : ''}
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
          className="px-4 py-2 rounded-lg text-slate-300 hover:bg-slate-700/60 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => selected && onSelect(selected)}
          disabled={!selected || busy}
          className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium disabled:opacity-50"
        >
          {busy ? 'Removing…' : 'Remove and continue'}
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
