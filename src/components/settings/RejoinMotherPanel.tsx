// Network-settings panel: a manual "Reconnect to the mother" button
// (Ludiom #74).
//
// The automatic path (services/motherFailover) covers the normal failover, but
// it depends on mDNS reaching this device. When it can't - two access points,
// a device that never had a successful call, multicast filtered - the operator
// needs something to press that is NOT "become mother": the mother for the game
// usually exists already, and promoting a second one makes things worse. This
// rejoins the mother that is there; ForceMotherPanel below it is the answer for
// when there isn't one.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2 } from 'lucide-react';
import { rejoinCurrentMother } from '../../services/childControlLink';

export function RejoinMotherPanel() {
  const { t } = useTranslation('devicesLan');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const outcome = await rejoinCurrentMother();
      setMsg(
        outcome === 'not_found'
          ? {
              kind: 'err',
              text: t('rejoinNotFound', {
                defaultValue:
                  'No mother found on the network for this device. Check that both devices are on the same Wi-Fi, then try again.',
              }),
            }
          : {
              kind: 'ok',
              text: t('rejoinDone', {
                defaultValue:
                  'Reconnected. The games list and the running game follow the current mother again.',
              }),
            }
      );
    } catch {
      setMsg({
        kind: 'err',
        text: t('rejoinFailed', { defaultValue: 'Could not reconnect - try again.' }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pg-panel">
      <div className="flex items-start gap-3">
        <Link2 className="w-5 h-5 mt-0.5 shrink-0 text-[var(--pg-ok-icon)]" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-[var(--pg-text)] mb-0.5">
            {t('rejoinTitle', { defaultValue: 'Reconnect to the mother' })}
          </div>
          <p className="text-xs text-[var(--pg-text-dim)] leading-relaxed mb-3">
            {t('rejoinDesc', {
              defaultValue:
                'Look for the device currently hosting and point this one back at it. Use this when this device has lost the game after another device took over as mother. It changes nothing on the mother - try this before taking control.',
            })}
          </p>
          <button onClick={run} disabled={busy} className="pg-btn pg-btn--primary">
            <Link2 size={15} />
            {busy
              ? t('rejoinWorking', { defaultValue: 'Reconnecting…' })
              : t('rejoinBtn', { defaultValue: 'Reconnect' })}
          </button>
          {msg && (
            <p
              className={`text-xs mt-3 ${msg.kind === 'ok' ? 'text-[var(--pg-ok-icon)]' : 'text-[var(--pg-danger-icon)]'}`}
            >
              {msg.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
