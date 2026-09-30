import { useEffect, useState } from 'react';
import { Monitor, Tablet, Usb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listLaunchDevices, type PairedDeviceStatusRow } from '../../services/launchedGames';
import { displayDeviceLabel } from '../../services/lanPairing';

const POLL_MS = 5000;

// Satellite side of the Network page: the other devices connected to OUR
// mother. A satellite has no paired list of its own (only the mother does), so
// this reads the mother's list over the launched_games route - the same call as
// the launch wizard. The mother's own row (is_self there) is dropped: it's the
// "Mon poste mère" card above. This device is kept and tagged.
export function MotherSatellitesPanel() {
  const { t } = useTranslation('devicesLan');
  const [rows, setRows] = useState<PairedDeviceStatusRow[] | null>(null);
  const [selfId, setSelfId] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await listLaunchDevices();
        if (cancelled) return;
        setRows(res.devices.filter((d) => !d.is_self));
        setSelfId(res.selfId);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // This device first, then online before offline (server order otherwise).
  const sorted = rows
    ? [...rows].sort(
        (a, b) =>
          Number(b.id === selfId) - Number(a.id === selfId) ||
          Number(b.online) - Number(a.online),
      )
    : [];

  return (
    <div className="pg-panel">
      <h3 className="pg-panel-title">{t('motherSatellitesTitle')}</h3>
      <p className="text-sm text-[var(--pg-text-dim)] mb-2">{t('motherSatellitesHint')}</p>
      {rows === null ? (
        failed && <p className="text-sm text-[var(--pg-text-dim)]">{t('motherSatellitesUnavailable')}</p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-[var(--pg-text-dim)]">{t('motherSatellitesNone')}</p>
      ) : (
        <div className="divide-y divide-[var(--pg-line)]">
          {sorted.map((d) => {
            const Icon = (d.peer_os ?? '').toLowerCase() === 'android' ? Tablet : Monitor;
            return (
              <div key={d.id} className="py-3 flex items-center gap-4">
                <Icon className="w-6 h-6 text-[var(--pg-text-muted)] shrink-0" />
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-[var(--pg-text)] font-semibold truncate">
                    {displayDeviceLabel(d.device_label) || t('unknownDevice')}
                  </span>
                  {d.id === selfId && (
                    <span className="text-xs text-[var(--pg-text-dim)] shrink-0">({t('thisDevice')})</span>
                  )}
                </div>
                {d.online && d.has_reader && (
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-[var(--pg-ok-bg)] text-[var(--pg-ok-text)] border-[var(--pg-ok-line)]">
                    <Usb className="w-3 h-3" />
                    {t('motherSatellitesReader')}
                  </span>
                )}
                <span className={`text-xs px-2 py-0.5 rounded-full border ${
                  d.online ? 'bg-[var(--pg-ok-bg)] text-[var(--pg-ok-text)] border-[var(--pg-ok-line)]'
                           : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)] border-[var(--pg-line-strong)]'}`}>
                  {d.online ? t('online') : t('offline')}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {rows !== null && failed && (
        <p className="text-xs text-[var(--pg-text-dim)] mt-2">{t('motherSatellitesUnavailable')}</p>
      )}
    </div>
  );
}
