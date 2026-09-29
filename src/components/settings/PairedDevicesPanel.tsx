import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2, Monitor, Smartphone, Tablet, Crown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listActiveLaunchedGames, queueBecomeMotherCommand } from '../../services/launchedGames';
import {
  listPairedDevices, revokePairedDevice,
  formatLanTime, isRecent, displayDeviceLabel,
  type PairedDeviceRow,
} from '../../services/lanPairing';
import { ErrorDetails } from '../ErrorDetails';

const POLL_MS = 4000;

// The mother-side "Paired devices" list: every device paired to this one, with
// per-device revoke and the planned-handover "Make mother" button. Lives at the
// very top of the Network tab so the operator sees the fleet at a glance.
// On the rebuilt Network page this is the mother's "Mes satellites" card: the
// device itself is not listed (it is the mother), removal is sticky (retours
// sept. #8) and errors render in plain language instead of window.alert.
export function PairedDevicesPanel() {
  const { t } = useTranslation('devicesLan');
  const [makeMotherErr, setMakeMotherErr] = useState<unknown>(null);

  const [paired, setPaired] = useState<PairedDeviceRow[]>([]);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  // Active launched game (for the per-device "Make mother" handover button) and
  // which device a handover is being queued to.
  const [activeGameId, setActiveGameId] = useState<number | null>(null);
  const [makingMotherId, setMakingMotherId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [dev, games] = await Promise.all([
      listPairedDevices().catch(() => [] as PairedDeviceRow[]),
      listActiveLaunchedGames().catch(() => []),
    ]);
    setPaired(dev);
    // Most-recent active game is the handover target's game.
    setActiveGameId(games[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function revoke(d: PairedDeviceRow) {
    if (!window.confirm(t('revokeConfirm'))) return;
    setRevokingId(d.id);
    try { await revokePairedDevice(d.id); await refresh(); }
    finally { setRevokingId(null); }
  }

  // Planned handover: tell a paired device to take over as the mother for the
  // active game. It adopts its cached snapshot and promotes; this device yields.
  async function makeMother(d: PairedDeviceRow) {
    if (activeGameId == null) return;
    if (!window.confirm(t('makeMotherConfirm', {
      defaultValue:
        'Hand the game over to this device? It becomes the mother and the other devices reconnect to it.',
    }))) return;
    setMakingMotherId(d.id);
    setMakeMotherErr(null);
    try {
      await queueBecomeMotherCommand(d.id, activeGameId);
    } catch (e) {
      setMakeMotherErr(e);
    } finally {
      setMakingMotherId(null);
    }
  }

  const satellites = paired.filter((d) => !d.is_self);

  return (
    <div className="pg-panel">
      <h3 className="pg-panel-title">{t('mySatellitesTitle')}</h3>
      <p className="text-sm text-[var(--pg-text-dim)] mt-1 mb-3">{t('mySatellitesHint')}</p>
      {makeMotherErr != null && <ErrorDetails error={makeMotherErr} className="mb-3" />}
      {satellites.length === 0 ? (
        <div className="text-[var(--pg-text-dim)] text-sm py-4">{t('pairedEmpty')}</div>
      ) : (
        <div className="space-y-2">
          {satellites.map((d) => {
            const Icon = osIcon(d.peer_os);
            const online = d.is_self || isRecent(d.last_seen_at);
            return (
              <div key={d.id} className={`p-4 rounded-xl border flex items-center gap-4 ${
                d.is_self ? 'bg-[var(--pg-accent-tint)] border-[var(--pg-accent-line)]' : 'bg-[var(--pg-surface)] border-[var(--pg-line)]'}`}>
                <Icon className="w-6 h-6 text-[var(--pg-text-muted)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--pg-text)] font-medium truncate">
                      {displayDeviceLabel(d.peer_label) || (d.is_self ? t('thisDevice') : t('unknownDevice'))}
                    </span>
                    {d.is_self && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--pg-accent-tint)] text-[var(--pg-accent-bright)] border border-[var(--pg-accent-line)]">
                        {t('thisDevice')}
                      </span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      online ? 'bg-[var(--pg-ok-bg)] text-[var(--pg-ok-text)] border-[var(--pg-ok-line)]'
                             : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)] border-[var(--pg-line-strong)]'}`}>
                      {online ? t('online') : t('offline')}
                    </span>
                  </div>
                  <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                    {d.peer_os}
                    {d.last_seen_at && ` · ${t('lastSeen', { time: formatLanTime(d.last_seen_at) })}`}
                  </div>
                </div>
                {!d.is_self && online && activeGameId != null && (
                  <button onClick={() => makeMother(d)} disabled={makingMotherId === d.id}
                    title={t('makeMother', { defaultValue: 'Make this device the mother' })}
                    className="px-2.5 py-1.5 rounded-lg text-[var(--pg-warn-text)] hover:bg-[var(--pg-warn-bg)] disabled:opacity-50 flex items-center gap-1.5 text-sm">
                    {makingMotherId === d.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crown className="w-4 h-4" />}
                    {t('makeMotherBtn', { defaultValue: 'Make mother' })}
                  </button>
                )}
                {!d.is_self && (
                  <button onClick={() => revoke(d)} disabled={revokingId === d.id}
                    title={t('revoke')}
                    className="p-2 rounded-lg text-[var(--pg-danger-text)] hover:bg-red-500/20 disabled:opacity-50">
                    {revokingId === d.id ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash2 className="w-5 h-5" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
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
