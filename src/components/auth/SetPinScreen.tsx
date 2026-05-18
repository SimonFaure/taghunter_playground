import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { OtpInput } from './OtpInput';
import { setPin } from '../../services/pinStore';
import type { AuthUser } from '../../services/authStore';

// Choose-then-confirm flow for the local PIN. Shown:
//   - immediately after a successful OTP login (before the app shell),
//   - after the Forgot-PIN OTP flow (which also resets the PIN), and
//   - on the rare cold-start where a JWT exists but no PIN does
//     (e.g. the OTP completed and the app crashed before the user picked one).
//
// The PIN never reaches the server. We just persist a salted PBKDF2 hash in
// SQLite (`device_pin` table) and let AuthProvider continue to the normal
// server bootstrap.

type Phase = 'choose' | 'confirm';

interface SetPinScreenProps {
  user: AuthUser;
  onPinSet: () => void;
}

export function SetPinScreen({ user, onPinSet }: SetPinScreenProps) {
  const [phase, setPhase] = useState<Phase>('choose');
  const [firstEntry, setFirstEntry] = useState('');
  const [secondEntry, setSecondEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFirstComplete(value: string) {
    setError(null);
    setFirstEntry(value);
    setSecondEntry('');
    setPhase('confirm');
  }

  async function handleSecondComplete(value: string) {
    setError(null);
    if (value !== firstEntry) {
      setError('PINs don’t match. Choose a PIN again.');
      setPhase('choose');
      setFirstEntry('');
      setSecondEntry('');
      return;
    }

    setBusy(true);
    try {
      await setPin(value);
      onPinSet();
    } catch (err) {
      console.error('[SetPinScreen] setPin failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to save PIN. Try again.');
      setPhase('choose');
      setFirstEntry('');
      setSecondEntry('');
    } finally {
      setBusy(false);
    }
  }

  function handleBack() {
    setPhase('choose');
    setFirstEntry('');
    setSecondEntry('');
    setError(null);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/20 border border-blue-500/40 mb-4">
            <Lock className="w-7 h-7 text-blue-300" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">
            {phase === 'choose' ? 'Set a PIN for this device' : 'Confirm your PIN'}
          </h1>
          <p className="text-slate-400 text-sm">
            {phase === 'choose'
              ? 'You’ll use this PIN to unlock the app each time it opens. No internet needed.'
              : 'Type it once more to make sure it matches.'}
          </p>
          <p className="text-slate-500 text-xs mt-2">Signed in as {user.email}</p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4">
          {phase === 'choose' && (
            <OtpInput
              length={4}
              value={firstEntry}
              onChange={setFirstEntry}
              onComplete={handleFirstComplete}
              disabled={busy}
            />
          )}

          {phase === 'confirm' && (
            <OtpInput
              length={4}
              value={secondEntry}
              onChange={setSecondEntry}
              onComplete={handleSecondComplete}
              disabled={busy}
            />
          )}

          {error && <div className="text-sm text-red-400 text-center">{error}</div>}

          {busy && (
            <div className="flex items-center justify-center gap-2 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving PIN…
            </div>
          )}

          {phase === 'confirm' && !busy && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleBack}
                className="text-sm text-slate-400 hover:text-white"
              >
                ← Pick a different PIN
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
