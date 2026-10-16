import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      setError(t('pinSetup:pinsDontMatch'));
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
      setError(err instanceof Error ? err.message : t('pinSetup:saveFailed'));
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
    <div className="min-h-screen flex items-center justify-center p-6 pg-app-bg">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--pg-accent-tint)] border border-[var(--pg-accent-line)] mb-4">
            <Lock className="w-7 h-7 text-[var(--pg-accent-bright)]" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--pg-text)] mb-1">
            {phase === 'choose' ? t('pinSetup:setTitle') : t('pinSetup:confirmTitle')}
          </h1>
          <p className="text-[var(--pg-text-dim)] text-sm">
            {phase === 'choose'
              ? t('pinSetup:setSubtitle')
              : t('pinSetup:typeAgain')}
          </p>
          <p className="text-[var(--pg-text-dim)] text-xs mt-2">
            {t('pinSetup:signedInAs', { email: user.email })}
          </p>
        </div>

        <div className="pg-panel p-6 space-y-4">
          {phase === 'choose' && (
            <OtpInput
              length={4}
              masked
              value={firstEntry}
              onChange={setFirstEntry}
              onComplete={handleFirstComplete}
              disabled={busy}
            />
          )}

          {phase === 'confirm' && (
            <OtpInput
              length={4}
              masked
              value={secondEntry}
              onChange={setSecondEntry}
              onComplete={handleSecondComplete}
              disabled={busy}
            />
          )}

          {error && <div className="text-sm text-red-400 text-center">{error}</div>}

          {busy && (
            <div className="flex items-center justify-center gap-2 text-[var(--pg-text-dim)] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('pinSetup:savingPin')}
            </div>
          )}

          {phase === 'confirm' && !busy && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleBack}
                className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)]"
              >
                {'← '}
                {t('pinSetup:pickDifferent')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
