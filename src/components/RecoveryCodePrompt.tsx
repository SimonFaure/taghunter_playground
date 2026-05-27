import { useEffect, useState } from 'react';
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
}

export function RecoveryCodePrompt({
  title = 'Enter a recovery code',
  subtitle = 'Ask your administrator for a recovery code, then type it here.',
  onSuccess,
  onCancel,
}: RecoveryCodePromptProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = still checking; true/false = whether unused codes exist locally.
  const [hasCodes, setHasCodes] = useState<boolean | null>(null);

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
      const outcome = await tryConsumeRecoveryCode(value);
      if (outcome.ok) {
        onSuccess();
        return;
      }
      if (outcome.reason === 'no_codes') {
        setHasCodes(false);
        return;
      }
      setError('That code didn’t work. Check it and try again.');
      setCode('');
    } catch (err) {
      console.error('[RecoveryCodePrompt] verify failed:', err);
      setError('Could not check the code. Try again.');
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
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/20 border border-blue-500/40 mb-4">
          <KeyRound className="w-7 h-7 text-blue-300" />
        </div>
        <h1 className="text-2xl font-bold text-white mb-1">{title}</h1>
        <p className="text-slate-400 text-sm">{subtitle}</p>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4">
        {hasCodes === null ? (
          <div className="flex items-center justify-center gap-2 text-slate-400 text-sm py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        ) : hasCodes === false ? (
          <div className="text-center text-sm text-amber-300 py-2">
            No recovery codes are available on this device. Connect to the
            internet and reset your PIN by email, or contact your administrator.
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
              <div className="flex items-center justify-center gap-2 text-slate-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Checking…
              </div>
            )}
          </>
        )}

        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-sm text-slate-400 hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
