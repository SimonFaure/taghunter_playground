import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2, Monitor, Smartphone, Tablet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listActiveLaunchedGames, queueBecomeMotherCommand } from '../../services/launchedGames';
import {
  listPairedDevices, revokePairedDevice,
  formatLanTime, isRecent, displayDeviceLabel,
  type PairedDeviceRow,
} from '../../services/lanPairing';
import { parseDbTs } from '../../utils/dbTime';
import { ErrorDetails } from '../ErrorDetails';

const POLL_MS = 4000;

// The mother's satellites, in two modes (retours sept. #10):
//  - `list`: the "Mes satellites" card of the Network page - name, online pill,
//    last exchange, and the (sticky, retours sept. #8) revoke button. Nothing else.
//  - `handover`: Avancé → Changer de rôle - pick an online satellite and hand it
//    the mother role for the active game. Red, two-step confirmation.
export function PairedDevicesPanel({ mode = 'list' }: { mode?: 'list' | 'handover' }) {
  const { t } = useTranslation('devicesLan');

  const [paired, setPaired] = useState<PairedDeviceRow[]>([]);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);
  // Active launched game: the handover target's game.
  const [activeGameId, setActiveGameId] = useState<number | null>(null);
  const [handoverTo, setHandoverTo] = useState<number | null>(null);
  const [confirmHandover, setConfirmHandover] = useState(false);
  const [handoverBusy, setHandoverBusy] = useState(false);
  const [handoverDone, setHandoverDone] = useState(false);
  const [handoverErr, setHandoverErr] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    const [dev, games] = await Promise.all([
      listPairedDevices().catch(() => [] as PairedDeviceRow[]),
      listActiveLaunchedGames().catch(() => []),
    ]);
    setPaired(dev);
    setActiveGameId(games[0]?.id ?? null);
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

  // Planned handover: tell a paired device to take over as the mother for the
  // active game. It adopts its cached snapshot and promotes; this device yields.
  async function handover() {
    if (activeGameId == null || handoverTo == null) return;
    setHandoverBusy(true);
    setHandoverErr(null);
    try {
      await queueBecomeMotherCommand(handoverTo, activeGameId);
      setHandoverDone(true);
      setConfirmHandover(false);
    } catch (e) {
      setHandoverErr(e);
    } finally {
      setHandoverBusy(false);
    }
  }

  const satellites = paired.filter((d) => !d.is_self);

  if (mode === 'handover') {
    const online = satellites.filter((d) => isRecent(d.last_seen_at));
    if (activeGameId == null) {
      return <p className="text-sm text-[var(--pg-text-dim)]">{t('handoverNoGame')}</p>;
    }
    if (online.length === 0) {
      return <p className="text-sm text-[var(--pg-text-dim)]">{t('handoverNoSatellite')}</p>;
    }
    if (handoverDone) {
      return <p className="text-sm text-[var(--pg-text)]">{t('handoverQueued')}</p>;
    }
    const picked = handoverTo != null && online.some((d) => d.id === handoverTo) ? handoverTo : null;
    return (
      <div className="space-y-3">
        <p className="text-sm text-[var(--pg-text-muted)]">{t('handoverIntro')}</p>
        <select
          className="pg-input w-full"
          value={picked ?? ''}
          disabled={handoverBusy}
          onChange={(e) => {
            setHandoverTo(e.target.value ? Number(e.target.value) : null);
            setConfirmHandover(false);
          }}
        >
          <option value="">{t('handoverPick')}</option>
          {online.map((d) => (
            <option key={d.id} value={d.id}>
              {displayDeviceLabel(d.peer_label) || t('unknownDevice')}
            </option>
          ))}
        </select>
        {handoverErr != null && <ErrorDetails error={handoverErr} />}
        {confirmHandover ? (
          <div className="p-3 rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)] space-y-2">
            <p className="text-sm text-[var(--pg-text)]">{t('makeMotherConfirm')}</p>
            <div className="flex gap-2">
              <button className="pg-btn" disabled={handoverBusy} onClick={() => setConfirmHandover(false)}>
                {t('notMotherCancel')}
              </button>
              <button className="pg-btn pg-btn--danger" disabled={handoverBusy} onClick={() => void handover()}>
                {handoverBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {t('handoverConfirmBtn')}
              </button>
            </div>
          </div>
        ) : (
          <button className="pg-btn pg-btn--danger" disabled={picked == null} onClick={() => setConfirmHandover(true)}>
            {t('handoverBtn')}
          </button>
        )}
      </div>
    );
  }

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
