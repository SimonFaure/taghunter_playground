import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, CheckCircle2 } from 'lucide-react';
import { RecoveryCodePrompt } from './RecoveryCodePrompt';
import { grantReprieve } from '../services/deviceLock';
import { sendHeartbeat } from '../services/telemetry';
import type { LockReason } from '../services/deviceLock';

// Launch/join gate shown when a device is locked (emergency-disabled or past
// billing grace). The app shell stays live underneath - only launching/joining
// games is blocked. A valid recovery code grants a per-device reprieve and then
// re-runs the action the operator was attempting. Design:
// project_client_device_lock.

interface GameLockGateProps {
  reason: Exclude<LockReason, null>;
  // Re-run the launch/join the operator attempted; the caller's own lock guard
  // short-circuits as unlocked now that the reprieve is active.
  onReprieve: () => void;
  onClose: () => void;
}

export function GameLockGate({ reason, onReprieve, onClose }: GameLockGateProps) {
  const { t } = useTranslation();
  const [granted, setGranted] = useState<number | null>(null);

  const title = reason === 'disabled' ? t('deviceLock:disabledTitle') : t('deviceLock:billingTitle');
  const subtitle =
    reason === 'disabled' ? t('deviceLock:disabledSubtitle') : t('deviceLock:billingSubtitle');

  async function handleSuccess() {
    // A valid code proves admin authorization: lift the gate on this device for
    // billing_reprieve_days, then push the new deadline up so studio reflects it.
    const until = await grantReprieve();
    void sendHeartbeat(true);
    const days = until
      ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : 0;
    setGranted(days);
    // Briefly confirm, then continue with the original action.
    setTimeout(onReprieve, 800);
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-6 pg-app-bg"
      onClick={onClose}
    >
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--pg-accent-tint)] border border-[var(--pg-accent-line)] mb-4">
            <ShieldAlert className="w-7 h-7 text-[var(--pg-accent-bright)]" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--pg-text)] mb-1">{title}</h1>
          <p className="text-[var(--pg-text-dim)] text-sm">{subtitle}</p>
        </div>

        {granted !== null ? (
          <div className="pg-panel p-6 flex items-center justify-center gap-2 text-emerald-300 text-sm">
            <CheckCircle2 className="w-5 h-5" />
            {t('deviceLock:reprieveGranted', { days: granted })}
          </div>
        ) : (
          <RecoveryCodePrompt
            context="billing"
            title={t('deviceLock:recoveryTitle')}
            subtitle={t('deviceLock:recoverySubtitle')}
            onSuccess={() => void handleSuccess()}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}
