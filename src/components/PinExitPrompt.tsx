import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock } from 'lucide-react';
import { OtpInput } from './auth/OtpInput';
import { peekVerifyPin, clearPin } from '../services/pinStore';
import { RecoveryCodePrompt } from './RecoveryCodePrompt';
import { signalPinReset } from '../services/pinResetSignal';

// Full-screen PIN gate for the kiosk "use PIN to exit" preferences. Shown over
// the game page (before leaving a game or opening the operator panel) and the
// logo screen (before dismissing it). Uses the device PIN via the non-mutating
// peekVerifyPin - wrong entries never lock the device out, so there is no
// backoff/countdown.
//
// Recovery: "Forgot PIN?" swaps to an offline RecoveryCodePrompt. A valid
// admin-issued recovery code CLEARS the device PIN (so every exit gate then
// bypasses - see config.ts/FullscreenHint) and lets the operator through. We
// fire signalPinReset() so the app can surface a "set a new PIN" banner.

interface PinExitPromptProps {
  title?: string;
  subtitle?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export function PinExitPrompt({
  title,
  subtitle,
  onSuccess,
  onCancel,
}: PinExitPromptProps) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'pin' | 'recovery'>('pin');

  const resolvedTitle = title ?? t('pinExit:title');
  const resolvedSubtitle = subtitle ?? t('pinExit:subtitle');

  async function handleRecoverySuccess() {
    // The operator proved admin authorization with a one-time code; drop the
    // forgotten PIN entirely so the device is usable again, then perform the
    // gated action they were trying to do.
    try {
      await clearPin();
    } catch (err) {
      console.error('[PinExitPrompt] clearPin after recovery failed:', err);
    }
    signalPinReset();
    onSuccess();
  }

  async function handleComplete(value: string) {
    setBusy(true);
    setError(null);
    try {
      const ok = await peekVerifyPin(value);
      if (ok) {
        onSuccess();
        return;
      }
      setError(t('pinExit:wrongPin'));
      setPin('');
    } catch (err) {
      console.error('[PinExitPrompt] verify failed:', err);
      setError(t('pinExit:checkFailed'));
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pg-overlay z-[200] p-6 select-none">
      {mode === 'recovery' ? (
        <RecoveryCodePrompt
          onSuccess={handleRecoverySuccess}
          onCancel={() => {
            setMode('pin');
            setPin('');
            setError(null);
          }}
        />
      ) : (
        <div
          className="w-full max-w-md"
          // Swallow taps so a click inside the card never reaches the screen
          // underneath (e.g. the logo screen's tap-to-reveal handler).
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--pg-accent-tint)] border border-[var(--pg-accent-line)] mb-4">
              <Lock className="w-7 h-7 text-[var(--pg-accent-bright)]" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--pg-text)] mb-1">{resolvedTitle}</h1>
            <p className="text-[var(--pg-text-dim)] text-sm">{resolvedSubtitle}</p>
          </div>

          <div className="bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-2xl p-6 space-y-4">
            <OtpInput
              length={4}
              value={pin}
              onChange={setPin}
              onComplete={handleComplete}
              disabled={busy}
            />

            {error && <div className="text-sm text-red-400 text-center">{error}</div>}
            {busy && (
              <div className="flex items-center justify-center gap-2 text-[var(--pg-text-dim)] text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('pinExit:checking')}
              </div>
            )}

            <div className="flex flex-col items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setMode('recovery');
                  setError(null);
                }}
                disabled={busy}
                className="text-sm text-[var(--pg-accent-bright)] hover:text-[var(--pg-accent-hover)] disabled:opacity-50"
              >
                {t('pinExit:forgotPin')}
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] disabled:opacity-50"
              >
                {t('pinExit:cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
