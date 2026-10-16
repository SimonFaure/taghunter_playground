import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2, Monitor, Smartphone, Tablet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  listPairedDevices, revokePairedDevice,
  formatLanTime, isRecent, displayDeviceLabel,
  type PairedDeviceRow,
} from '../../services/lanPairing';
import { parseDbTs } from '../../utils/dbTime';

const POLL_MS = 4000;

// The "Mes satellites" card of the Network page (retours sept. #10): name,
// online pill, last exchange, and the (sticky, retours sept. #8) revoke button.
// Nothing else. Handing the mother role to a satellite from here is gone: there
// is one mother, the PC set as such in "Rôle de ce poste".
export function PairedDevicesPanel() {
  const { t } = useTranslation('devicesLan');

  const [paired, setPaired] = useState<PairedDeviceRow[]>([]);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setPaired(await listPairedDevices().catch(() => [] as PairedDeviceRow[]));
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function revoke(d: PairedDeviceRow) {
    setRevokingId(d.id);
    try { await revokePairedDevice(d.id); await refresh(); }
    finally { setRevokingId(null); setConfirmRevokeId(null); }
  }

  const satellites = paired.filter((d) => !d.is_self);

  return (
    <div className="pg-panel">
      <h3 className="pg-panel-title">{t('mySatellitesTitle')}</h3>
      <p className="text-sm text-[var(--pg-text-dim)] mt-1 mb-3">{t('mySatellitesHint')}</p>
      {satellites.length === 0 ? (
        <div className="text-[var(--pg-text-dim)] text-sm py-4">{t('pairedEmpty')}</div>
      ) : (
        <div className="divide-y divide-[var(--pg-line)] border-t border-[var(--pg-line)]">
          {satellites.map((d) => {
            const Icon = osIcon(d.peer_os);
            const online = isRecent(d.last_seen_at);
            const seen = parseDbTs(d.last_seen_at);
            const ago = Number.isNaN(seen) ? null : Math.max(0, Math.round((Date.now() - seen) / 1000));
            return (
              <div key={d.id} className="py-4 flex items-center gap-4">
                <Icon className="w-6 h-6 text-[var(--pg-text-muted)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--pg-text)] font-semibold truncate">
                      {displayDeviceLabel(d.peer_label) || t('unknownDevice')}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      online ? 'bg-[var(--pg-ok-bg)] text-[var(--pg-ok-text)] border-[var(--pg-ok-line)]'
                             : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)] border-[var(--pg-line-strong)]'}`}>
                      {online ? t('online') : t('offline')}
                    </span>
                  </div>
                  {d.last_seen_at && (
                    <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                      {online && ago != null
                        ? t('seenAgo', { seconds: ago })
                        : t('lastSeen', { time: formatLanTime(d.last_seen_at) })}
                    </div>
                  )}
                </div>
                {confirmRevokeId === d.id ? (
                  <div className="flex items-center gap-2">
                    <button className="pg-btn" disabled={revokingId === d.id} onClick={() => setConfirmRevokeId(null)}>
                      {t('notMotherCancel')}
                    </button>
                    <button className="pg-btn pg-btn--danger" disabled={revokingId === d.id} onClick={() => void revoke(d)}>
                      {revokingId === d.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      {t('revoke')}
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmRevokeId(d.id)}
                    title={t('revoke')}
                    className="p-2 rounded-lg border border-[var(--pg-line)] text-[var(--pg-text-muted)] hover:text-[var(--pg-danger-text)] hover:bg-red-500/10">
                    <Trash2 className="w-5 h-5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {confirmRevokeId != null && (
        <p className="text-xs text-[var(--pg-text-dim)] mt-2">{t('revokeConfirm')}</p>
      )}
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
