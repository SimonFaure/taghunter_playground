import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Loader2, Lock, Mail, KeyRound } from 'lucide-react';
import { OtpInput } from './OtpInput';
import { verifyPin, getLockoutEnd, clearPin, type VerifyOutcome } from '../../services/pinStore';
import { requestPinResetOtp, verifyPinResetOtpAndSet } from '../../services/auth';
import { isOnline } from '../../services/connectivity';
import { ApiError } from '../../services/api';
import { signalPinReset } from '../../services/pinResetSignal';
import { RecoveryCodePrompt } from '../RecoveryCodePrompt';
import type { AuthUser } from '../../services/authStore';

// Manual-lock PIN gate. Rendered as a full-screen overlay when the user
// taps "Lock" in the nav bar - the app shell stays mounted and live
// underneath. It is not a cold-start gate. JWT + auth_user are already on
// disk; this screen never touches the server unless the user explicitly
// taps "Forgot PIN".
//
// Two recovery paths:
//   - "Forgot PIN" (online only): server emails an OTP to user.email, then the
//     user types the OTP + a new PIN inline (existing infra).
//   - "Use a recovery code" (works offline): an admin-issued one-time code,
//     validated locally. On success the device PIN is cleared and the app
//     unlocks; the operator sets a new PIN via the banner / Settings. This is
//     the only path that works at an offline event when the email is out of
//     reach - see RecoveryCodePrompt / recoveryCodesStore.

type Phase =
  | 'enter_pin'
  | 'forgot_request'
  | 'forgot_verify'
  | 'forgot_set_pin'
  | 'forgot_done'
  | 'recovery_code';

interface LockScreenProps {
  user: AuthUser;
  onUnlocked: () => void;
}

export function LockScreen({ user, onUnlocked }: LockScreenProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('enter_pin');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockoutEnd, setLockoutEnd] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Forgot-PIN state.
  const [otp, setOtp] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmNewPin, setConfirmNewPin] = useState('');

  // Initial lockout-end read so a relaunch during a backoff window still
  // shows the countdown without forcing a wrong attempt first.
  useEffect(() => {
    void getLockoutEnd().then(setLockoutEnd);
  }, []);

  // Per-second tick while the device is locked out. No-op when free.
  useEffect(() => {
    if (lockoutEnd <= now) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    return () => clearInterval(t);
  }, [lockoutEnd, now]);

  const lockedOut = lockoutEnd > now;
  const remainingSeconds = lockedOut ? lockoutEnd - now : 0;
  const online = isOnline();

  async function handlePinComplete(value: string) {
    if (lockedOut) return;
    setBusy(true);
    setError(null);
    try {
      const outcome: VerifyOutcome = await verifyPin(value);
      if (outcome.ok) {
        onUnlocked();
        return;
      }
      if (outcome.reason === 'no_pin') {
        // Shouldn't happen - AuthProvider routes to SetPinScreen in that case.
        // Surface clearly so the user can recover.
        setError(t('authChrome:lock.noPin'));
        return;
      }
      if (outcome.reason === 'locked_out') {
        setLockoutEnd(outcome.lockedUntilAt);
        setError(t('authChrome:lock.tooManyAttempts'));
        setPin('');
        return;
      }
      // reason === 'wrong'
      setLockoutEnd(outcome.lockedUntilAt);
      setPin('');
      setError(
        outcome.lockedUntilAt > Math.floor(Date.now() / 1000)
          ? t('authChrome:lock.tooManyAttempts')
          : t('authChrome:lock.wrongPin')
      );
    } catch (err) {
      console.error('[LockScreen] verify failed:', err);
      setError(t('authChrome:lock.couldNotCheck'));
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  async function handleForgotPin() {
    if (!online) return;
    setBusy(true);
    setError(null);
    try {
      await requestPinResetOtp();
      setPhase('forgot_verify');
      setOtp('');
    } catch (err) {
      setError(extractErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  function handleOtpComplete(value: string) {
    setError(null);
    setOtp(value);
    setPhase('forgot_set_pin');
    setNewPin('');
    setConfirmNewPin('');
  }

  function handleNewPinComplete(value: string) {
    setError(null);
    setNewPin(value);
    setConfirmNewPin('');
  }

  async function handleConfirmNewPinComplete(value: string) {
    setError(null);
    if (value !== newPin) {
      setError(t('authChrome:lock.pinsDontMatch'));
      setNewPin('');
      setConfirmNewPin('');
      return;
    }
    setBusy(true);
    try {
      await verifyPinResetOtpAndSet(otp, value);
      // PIN persisted server-side bootstrap will be re-run by AuthProvider
      // after onUnlocked() - same gate as a successful PIN entry.
      setPhase('forgot_done');
      setPin('');
      setError(null);
      // Briefly show success, then route to the app.
      setTimeout(onUnlocked, 600);
    } catch (err) {
      setError(extractErrorMessage(err, t));
      // Stay on this phase but reset the entry boxes so the user retries.
      setNewPin('');
      setConfirmNewPin('');
      setPhase('forgot_set_pin');
    } finally {
      setBusy(false);
    }
  }

  function handleCancelForgot() {
    setPhase('enter_pin');
    setOtp('');
    setNewPin('');
    setConfirmNewPin('');
    setError(null);
    setPin('');
  }

  // A valid offline recovery code proves admin authorization. Drop the
  // forgotten PIN and unlock; the operator re-establishes a PIN via the
  // "set a new PIN" banner or Settings (and a relaunch forces SetPinScreen).
  async function handleRecoveryUnlock() {
    try {
      await clearPin();
    } catch (err) {
      console.error('[LockScreen] clearPin after recovery failed:', err);
    }
    signalPinReset();
    onUnlocked();
  }

  if (phase === 'recovery_code') {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pg-app-bg">
        <RecoveryCodePrompt
          onSuccess={handleRecoveryUnlock}
          onCancel={() => {
            setPhase('enter_pin');
            setError(null);
            setPin('');
          }}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pg-app-bg">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--pg-accent-tint)] border border-[var(--pg-accent-line)] mb-4">
            <Lock className="w-7 h-7 text-[var(--pg-accent-bright)]" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--pg-text)] mb-1">
            {phase === 'enter_pin' && t('authChrome:lock.enterPinTitle')}
            {phase === 'forgot_verify' && t('authChrome:lock.checkEmailTitle')}
            {phase === 'forgot_set_pin' &&
              (newPin === ''
                ? t('authChrome:lock.chooseNewPinTitle')
                : t('authChrome:lock.confirmNewPinTitle'))}
            {phase === 'forgot_done' && t('authChrome:lock.pinUpdatedTitle')}
          </h1>
          <p className="text-[var(--pg-text-dim)] text-sm">
            {phase === 'enter_pin' && t('authChrome:lock.signedInAs', { email: user.email })}
            {phase === 'forgot_verify' && t('authChrome:lock.codeSentTo', { email: user.email })}
            {phase === 'forgot_set_pin' &&
              (newPin === ''
                ? t('authChrome:lock.pickNewPin')
                : t('authChrome:lock.typeOnceMore'))}
            {phase === 'forgot_done' && t('authChrome:lock.unlocking')}
          </p>
        </div>

        <div className="pg-panel p-6 space-y-4">
          {phase === 'enter_pin' && (
            <>
              <OtpInput
                length={4}
                value={pin}
                onChange={setPin}
                onComplete={handlePinComplete}
                disabled={busy || lockedOut}
              />

              {lockedOut && (
                <div className="text-amber-300 text-sm text-center">
                  {t('authChrome:lock.lockedOut', { time: formatRemaining(remainingSeconds, t) })}
                </div>
              )}
              {!lockedOut && error && (
                <div className="text-sm text-red-400 text-center">{error}</div>
              )}
              {busy && (
                <div className="flex items-center justify-center gap-2 text-[var(--pg-text-dim)] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('authChrome:lock.checking')}
                </div>
              )}

              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={handleForgotPin}
                  disabled={busy || !online}
                  className="text-sm text-[var(--pg-accent-bright)] hover:text-[var(--pg-accent-hover)] disabled:opacity-50 disabled:hover:text-[var(--pg-accent-bright)]"
                  title={online ? undefined : t('authChrome:lock.connectToResetTitle')}
                >
                  <Mail className="w-4 h-4 inline mr-1.5 align-text-bottom" />
                  {t('authChrome:lock.forgotPin')}
                </button>
              </div>
              {!online && (
                <p className="text-xs text-[var(--pg-text-dim)] text-center">
                  {t('authChrome:lock.connectToReset')}
                </p>
              )}

              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    setPhase('recovery_code');
                    setError(null);
                    setPin('');
                  }}
                  disabled={busy}
                  className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] disabled:opacity-50"
                  title={t('authChrome:lock.recoveryHint')}
                >
                  <KeyRound className="w-4 h-4 inline mr-1.5 align-text-bottom" />
                  {t('authChrome:lock.useRecoveryCode')}
                </button>
              </div>
            </>
          )}

          {phase === 'forgot_verify' && (
            <>
              <OtpInput
                length={6}
                value={otp}
                onChange={setOtp}
                onComplete={handleOtpComplete}
                disabled={busy}
              />
              {error && <div className="text-sm text-red-400 text-center">{error}</div>}
              {busy && (
                <div className="flex items-center justify-center gap-2 text-[var(--pg-text-dim)] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('authChrome:lock.sendingCode')}
                </div>
              )}
              <div className="flex justify-between items-center text-sm">
                <button
                  type="button"
                  onClick={handleCancelForgot}
                  disabled={busy}
                  className="text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] disabled:opacity-50"
                >
                  {t('authChrome:lock.backToPin')}
                </button>
                <button
                  type="button"
                  onClick={handleForgotPin}
                  disabled={busy || !online}
                  className="text-[var(--pg-accent-bright)] hover:text-[var(--pg-accent-hover)] disabled:opacity-50"
                >
                  {t('authChrome:lock.resendCode')}
                </button>
              </div>
            </>
          )}

          {phase === 'forgot_set_pin' && (
            <>
              {newPin === '' ? (
                <OtpInput
                  length={4}
                  value={newPin}
                  onChange={setNewPin}
                  onComplete={handleNewPinComplete}
                  disabled={busy}
                />
              ) : (
                <OtpInput
                  length={4}
                  value={confirmNewPin}
                  onChange={setConfirmNewPin}
                  onComplete={handleConfirmNewPinComplete}
                  disabled={busy}
                />
              )}
              {error && <div className="text-sm text-red-400 text-center">{error}</div>}
              {busy && (
                <div className="flex items-center justify-center gap-2 text-[var(--pg-text-dim)] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('authChrome:lock.saving')}
                </div>
              )}
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleCancelForgot}
                  disabled={busy}
                  className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] disabled:opacity-50"
                >
                  {t('authChrome:lock.cancel')}
                </button>
              </div>
            </>
          )}

          {phase === 'forgot_done' && (
            <div className="flex items-center justify-center gap-2 text-emerald-300 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('authChrome:lock.unlocking')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatRemaining(seconds: number, t: TFunction): string {
  if (seconds < 60) return t('authChrome:lock.remainingSeconds', { count: seconds });
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t('authChrome:lock.remainingMinutes', { count: minutes });
  const hours = Math.ceil(minutes / 60);
  return t('authChrome:lock.remainingHours', { count: hours });
}

function extractErrorMessage(err: unknown, t: TFunction): string {
  console.error('[LockScreen] error:', err);
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | null;
    if (body?.error) return body.error;
    return t('authChrome:errors.requestFailed', { status: err.status });
  }
  if (err instanceof Error) return err.message;
  return t('authChrome:errors.generic');
}
