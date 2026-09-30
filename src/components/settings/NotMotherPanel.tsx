// Network-settings panel: the "I'm not a mother" button - the inverse of
// ForceMotherPanel. Demotes THIS device to a plain satellite right now (stops
// the local server + hotspot, clears the be-mother preference so it stays down
// across restarts) and then converges on the venue's live mother through the
// normal auto-join path. See services/lanMotherBoot.ts::demoteFromMother.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Satellite } from 'lucide-react';
import { demoteFromMother, HostingActiveGameError } from '../../services/lanMotherBoot';
import { relaunchToApply } from '../../services/appRelaunch';
import { refreshLaunchedGamesRoute } from '../../services/childControlLink';
import { describeLocalRole } from '../../services/lanPairing';
import { CONFIG_CHANGED_EVENT } from '../../utils/config';
import { ErrorDetails } from '../ErrorDetails';
import { useAuth } from '../auth/AuthProvider';

export function NotMotherPanel() {
  const { t } = useTranslation('devicesLan');
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [hostingWarn, setHostingWarn] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok'; text: string } | { kind: 'err'; error: unknown } | null>(null);

  const askConfirm = async () => {
    setMsg(null);
    // Warn harder when this device is actively serving: demoting strands its
    // running games until another device takes control (ForceMotherPanel there).
    const role = await describeLocalRole().catch(() => null);
    setHostingWarn(Boolean(role?.mother_server_running));
    setConfirming(true);
  };

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await demoteFromMother(auth.user?.client_id);
      // Converge on the venue's mother right away (auto-join + route install)
      // instead of waiting for the periodic tick. With no mother nearby the
      // device simply stays a satellite-in-waiting - still a success.
      const route = await refreshLaunchedGamesRoute().catch(() => null);
      // Let DefaultRolesPanel refresh its "Be the mother" toggle.
      window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT));
      setMsg({
        kind: 'ok',
        text:
          (route === 'mother'
            ? t('notMotherDoneJoined', {
                defaultValue:
                  'Done. This device is now a satellite, connected to the mother on this network.',
              })
            : t('notMotherDone', {
                defaultValue:
                  'Done. This device is now a satellite - it will follow a mother as soon as one is available on the network.',
              })) + ' ' + t('relaunchingToApply'),
      });
      // Apply the new role through a clean start (retours sept. #16).
      void relaunchToApply(2500);
    } catch (e) {
      setMsg({
        kind: 'err',
        error:
          e instanceof HostingActiveGameError
            ? { message: t('failover:errHostingActiveGame', { name: e.gameName }), detail: null }
            : e,
      });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="pg-panel">
      <div className="flex items-start gap-3">
        <Satellite className="w-5 h-5 mt-0.5 shrink-0 text-[var(--pg-accent-bright)]" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-[var(--pg-text)] mb-0.5">
            {t('notMotherTitle', { defaultValue: "I'm not a mother" })}
          </div>
          <p className="text-xs text-[var(--pg-text-dim)] leading-relaxed mb-3">
            {t('notMotherDesc', {
              defaultValue:
                'Step this device down: it stops hosting games and broadcasting the hotspot, and no longer volunteers as mother at startup. It becomes a satellite and follows the mother on the network.',
            })}
          </p>
          {!confirming ? (
            <button
              onClick={() => void askConfirm()}
              disabled={busy}
              className="pg-btn pg-btn--danger"
            >
              <Satellite size={15} />
              {t('notMotherBtn', { defaultValue: "I'm not a mother" })}
            </button>
          ) : (
            <div>
              {hostingWarn && (
                <p className="text-xs text-[var(--pg-warn-icon)] leading-relaxed mb-2">
                  {t('notMotherActiveGameWarn', {
                    defaultValue:
                      'This device is currently hosting. Its running games will be unreachable until another device takes control ("Take control as mother" on that device).',
                  })}
                </p>
              )}
              <p className="text-xs text-[var(--pg-text-dim)] leading-relaxed mb-2">{t('relaunchNote')}</p>
              <div className="flex gap-2">
                <button onClick={() => setConfirming(false)} className="pg-btn" disabled={busy}>
                  {t('notMotherCancel', { defaultValue: 'Cancel' })}
                </button>
                <button onClick={run} className="pg-btn pg-btn--danger" disabled={busy}>
                  {busy
                    ? t('notMotherWorking', { defaultValue: 'Working…' })
                    : t('notMotherConfirm', { defaultValue: 'Confirm - step down' })}
                </button>
              </div>
            </div>
          )}
          {msg?.kind === 'ok' && <p className="text-xs mt-3 text-[var(--pg-ok-icon)]">{msg.text}</p>}
          {msg?.kind === 'err' && <ErrorDetails error={msg.error} className="mt-3" />}
        </div>
      </div>
    </div>
  );
}
