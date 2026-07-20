import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, KeyRound } from 'lucide-react';
import { OtpInput } from './auth/OtpInput';
import {
  hasUnusedRecoveryCodes,
  tryConsumeRecoveryCode,
} from '../services/recoveryCodesStore';

// Offline PIN-recovery entry. Shown when an operator forgets the device PIN
// and taps "Forgot PIN?" on a gate. They get an 8-digit recovery code from
// their admin (read aloud); it's validated fully offline against the codes the
// device synced earlier and burned once-per-device on success. The host
// decides what success means (the exit gates clear the PIN; the LockScreen
// routes on to choosing a new PIN).
//
// No lockout: 8 digits × a small pool make guessing impractical, and an
// operator must never be able to brick their own recovery. If the device has
// no unused codes, we say so plainly rather than letting them type in vain.

interface RecoveryCodePromptProps {
  title?: string;
  subtitle?: string;
  onSuccess: () => void;
  onCancel: () => void;
  // Which gate is consuming the code: 'pin' (forgot-PIN) or 'billing'
  // (device-lock reprieve). Reported up so studio can distinguish them.
  // project_client_device_lock.
  context?: 'pin' | 'billing';
}

export function RecoveryCodePrompt({
  title,
  subtitle,
  onSuccess,
  onCancel,
  context = 'pin',
}: RecoveryCodePromptProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = still checking; true/false = whether unused codes exist locally.
  const [hasCodes, setHasCodes] = useState<boolean | null>(null);

  const resolvedTitle = title ?? t('recoveryCode:title');
  const resolvedSubtitle = subtitle ?? t('recoveryCode:subtitle');

  useEffect(() => {
    let cancelled = false;
    void hasUnusedRecoveryCodes()
      .then((v) => {
        if (!cancelled) setHasCodes(v);
      })
      .catch(() => {
        if (!cancelled) setHasCodes(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleComplete(value: string) {
    setBusy(true);
    setError(null);
    try {
      const outcome = await tryConsumeRecoveryCode(value, context);
      if (outcome.ok) {
        onSuccess();
        return;
      }
      if (outcome.reason === 'no_codes') {
        setHasCodes(false);
        return;
      }
      setError(t('recoveryCode:wrongCode'));
      setCode('');
    } catch (err) {
      console.error('[RecoveryCodePrompt] verify failed:', err);
      setError(t('recoveryCode:checkFailed'));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="w-full max-w-lg"
      // Swallow taps so a click inside never reaches a tap-to-dismiss layer
      // underneath (e.g. the logo screen).
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--pg-accent-tint)] border border-[var(--pg-accent-line)] mb-4">
          <KeyRound className="w-7 h-7 text-[var(--pg-accent-bright)]" />
        </div>
        <h1 className="text-2xl font-bold text-[var(--pg-text)] mb-1">{resolvedTitle}</h1>
        <p className="text-[var(--pg-text-dim)] text-sm">{resolvedSubtitle}</p>
      </div>

      <div className="bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-2xl p-6 space-y-4">
        {hasCodes === null ? (
          <div className="flex items-center justify-center gap-2 text-[var(--pg-text-dim)] text-sm py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('recoveryCode:loading')}
          </div>
        ) : hasCodes === false ? (
          <div className="text-center text-sm text-amber-300 py-2">
            {t('recoveryCode:noCodes')}
          </div>
        ) : (
          <>
            <OtpInput
              length={8}
              value={code}
              onChange={setCode}
              onComplete={handleComplete}
              disabled={busy}
            />
            {error && <div className="text-sm text-red-400 text-center">{error}</div>}
            {busy && (
              <div className="flex items-center justify-center gap-2 text-[var(--pg-text-dim)] text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('recoveryCode:checking')}
              </div>
            )}
          </>
        )}

        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] disabled:opacity-50"
          >
            {t('recoveryCode:cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
