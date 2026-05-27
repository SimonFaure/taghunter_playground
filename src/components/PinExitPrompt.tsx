import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { OtpInput } from './auth/OtpInput';
import { peekVerifyPin, clearPin } from '../services/pinStore';
import { RecoveryCodePrompt } from './RecoveryCodePrompt';
import { signalPinReset } from '../services/pinResetSignal';

// Full-screen PIN gate for the kiosk "use PIN to exit" preferences. Shown over
// the game page (before leaving a game or opening the operator panel) and the
// logo screen (before dismissing it). Uses the device PIN via the non-mutating
// peekVerifyPin — wrong entries never lock the device out, so there is no
// backoff/countdown.
//
// Recovery: "Forgot PIN?" swaps to an offline RecoveryCodePrompt. A valid
// admin-issued recovery code CLEARS the device PIN (so every exit gate then
// bypasses — see config.ts/FullscreenHint) and lets the operator through. We
// fire signalPinReset() so the app can surface a "set a new PIN" banner.

interface PinExitPromptProps {
  title?: string;
  subtitle?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export function PinExitPrompt({
  title = 'Enter your PIN',
  subtitle = 'Enter the device PIN to continue.',
  onSuccess,
  onCancel,
}: PinExitPromptProps) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'pin' | 'recovery'>('pin');

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
      setError('Wrong PIN. Try again.');
      setPin('');
    } catch (err) {
      console.error('[PinExitPrompt] verify failed:', err);
      setError('Could not check PIN. Try again.');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm select-none">
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
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/20 border border-blue-500/40 mb-4">
              <Lock className="w-7 h-7 text-blue-300" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-1">{title}</h1>
            <p className="text-slate-400 text-sm">{subtitle}</p>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4">
            <OtpInput
              length={4}
              value={pin}
              onChange={setPin}
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

            <div className="flex flex-col items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setMode('recovery');
                  setError(null);
                }}
                disabled={busy}
                className="text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50"
              >
                Forgot PIN?
              </button>
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
      )}
    </div>
  );
}
