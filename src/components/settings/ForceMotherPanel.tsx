// Network-settings panel: a manual "Take control as mother" button.
//
// Complements the automatic startup prompt (RegainControlPrompt) - the operator
// can force this device to become the mother at any time: if a live mother is
// hosting, it pulls that mother's current state first (no data loss) then
// promotes; otherwise it adopts a cached snapshot, or restarts this device's own
// server. See services/lanMotherBoot.ts::forceBecomeMother.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { forceBecomeMother } from '../../services/lanMotherBoot';

export function ForceMotherPanel() {
  const { t } = useTranslation('devicesLan');
  const auth = useAuth();
  const clientId = auth.user?.client_id ?? null;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const run = async () => {
    if (clientId == null) return;
    setBusy(true);
    setMsg(null);
    try {
      const outcome = await forceBecomeMother(clientId);
      setMsg({
        kind: 'ok',
        text:
          outcome === 'restarted'
            ? t('forceMotherRestarted', {
                defaultValue:
                  'This device restarted as the mother for its own game. Other devices will reconnect.',
              })
            : t('forceMotherDone', {
                defaultValue:
                  'This device is now the mother. Open the game to continue - other devices will reconnect.',
              }),
      });
    } catch (e) {
      setMsg({ kind: 'err', text: String((e as { message?: string })?.message ?? e) });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="pg-panel">
      <div className="flex items-start gap-3">
        <Crown className="w-5 h-5 mt-0.5 shrink-0 text-yellow-400" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-[var(--pg-text)] mb-0.5">
            {t('forceMotherTitle', { defaultValue: 'Take control as mother' })}
          </div>
          <p className="text-xs text-[var(--pg-text-dim)] leading-relaxed mb-3">
            {t('forceMotherDesc', {
              defaultValue:
                'Make THIS device the mother for the active game. If another device is currently hosting, its latest state is pulled in first so nothing is lost. Use this if this device should be hosting but isn’t.',
            })}
          </p>
          {!confirming ? (
            <button
              onClick={() => {
                setMsg(null);
                setConfirming(true);
              }}
              disabled={busy || clientId == null}
              className="pg-btn pg-btn--primary"
            >
              <Crown size={15} />
              {t('forceMotherBtn', { defaultValue: 'Take control' })}
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={() => setConfirming(false)} className="pg-btn" disabled={busy}>
                {t('forceMotherCancel', { defaultValue: 'Cancel' })}
              </button>
              <button onClick={run} className="pg-btn pg-btn--primary" disabled={busy}>
                {busy
                  ? t('forceMotherWorking', { defaultValue: 'Working…' })
                  : t('forceMotherConfirm', { defaultValue: 'Confirm - take control' })}
              </button>
            </div>
          )}
          {msg && (
            <p className={`text-xs mt-3 ${msg.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
              {msg.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
