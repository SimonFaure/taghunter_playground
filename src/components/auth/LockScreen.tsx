import { useEffect, useState } from 'react';
import { Loader2, Lock, Mail } from 'lucide-react';
import { OtpInput } from './OtpInput';
import { verifyPin, getLockoutEnd, type VerifyOutcome } from '../../services/pinStore';
import { requestPinResetOtp, verifyPinResetOtpAndSet } from '../../services/auth';
import { isOnline } from '../../services/connectivity';
import { ApiError } from '../../services/api';
import type { AuthUser } from '../../services/authStore';

// Cold-start PIN gate. JWT + auth_user are already on disk; this screen
// never touches the server unless the user explicitly taps "Forgot PIN".
//
// Recovery flow is the existing OTP infra:
//   1. tap "Forgot PIN" (online only — button disabled when offline),
//   2. server emails a code to user.email (read from cached auth_user row),
//   3. user types the OTP, then a new PIN, both inline on this screen.

type Phase =
  | 'enter_pin'
  | 'forgot_request'
  | 'forgot_verify'
  | 'forgot_set_pin'
  | 'forgot_done';

interface LockScreenProps {
  user: AuthUser;
  onUnlocked: () => void;
}

export function LockScreen({ user, onUnlocked }: LockScreenProps) {
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
        // Shouldn't happen — AuthProvider routes to SetPinScreen in that case.
        // Surface clearly so the user can recover.
        setError('No PIN set on this device. Restart the app to continue.');
        return;
      }
      if (outcome.reason === 'locked_out') {
        setLockoutEnd(outcome.lockedUntilAt);
        setError('Too many wrong attempts. Try again shortly.');
        setPin('');
        return;
      }
      // reason === 'wrong'
      setLockoutEnd(outcome.lockedUntilAt);
      setPin('');
      setError(
        outcome.lockedUntilAt > Math.floor(Date.now() / 1000)
          ? 'Too many wrong attempts. Try again shortly.'
          : 'Wrong PIN. Try again.'
      );
    } catch (err) {
      console.error('[LockScreen] verify failed:', err);
      setError('Could not check PIN. Try again.');
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
      setError(extractErrorMessage(err));
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
      setError('PINs don’t match. Choose a PIN again.');
      setNewPin('');
      setConfirmNewPin('');
      return;
    }
    setBusy(true);
    try {
      await verifyPinResetOtpAndSet(otp, value);
      // PIN persisted server-side bootstrap will be re-run by AuthProvider
      // after onUnlocked() — same gate as a successful PIN entry.
      setPhase('forgot_done');
      setPin('');
      setError(null);
      // Briefly show success, then route to the app.
      setTimeout(onUnlocked, 600);
    } catch (err) {
      setError(extractErrorMessage(err));
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

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/20 border border-blue-500/40 mb-4">
            <Lock className="w-7 h-7 text-blue-300" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">
            {phase === 'enter_pin' && 'Enter your PIN'}
            {phase === 'forgot_verify' && 'Check your email'}
            {phase === 'forgot_set_pin' &&
              (newPin === '' ? 'Choose a new PIN' : 'Confirm your new PIN')}
            {phase === 'forgot_done' && 'PIN updated'}
          </h1>
          <p className="text-slate-400 text-sm">
            {phase === 'enter_pin' && `Signed in as ${user.email}`}
            {phase === 'forgot_verify' && `We sent a 6-digit code to ${user.email}`}
            {phase === 'forgot_set_pin' &&
              (newPin === ''
                ? 'Pick a new 4-digit PIN for this device.'
                : 'Type it once more to make sure it matches.')}
            {phase === 'forgot_done' && 'Unlocking…'}
          </p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4">
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
                  Too many wrong attempts. Try again in {formatRemaining(remainingSeconds)}.
                </div>
              )}
              {!lockedOut && error && (
                <div className="text-sm text-red-400 text-center">{error}</div>
              )}
              {busy && (
                <div className="flex items-center justify-center gap-2 text-slate-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Checking…
                </div>
              )}

              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={handleForgotPin}
                  disabled={busy || !online}
                  className="text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:hover:text-blue-400"
                  title={online ? undefined : 'Connect to the internet to reset your PIN'}
                >
                  <Mail className="w-4 h-4 inline mr-1.5 align-text-bottom" />
                  Forgot PIN?
                </button>
              </div>
              {!online && (
                <p className="text-xs text-slate-500 text-center">
                  Connect to the internet to reset your PIN.
                </p>
              )}
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
                <div className="flex items-center justify-center gap-2 text-slate-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Sending code…
                </div>
              )}
              <div className="flex justify-between items-center text-sm">
                <button
                  type="button"
                  onClick={handleCancelForgot}
                  disabled={busy}
                  className="text-slate-400 hover:text-white disabled:opacity-50"
                >
                  ← Back to PIN
                </button>
                <button
                  type="button"
                  onClick={handleForgotPin}
                  disabled={busy || !online}
                  className="text-blue-400 hover:text-blue-300 disabled:opacity-50"
                >
                  Resend code
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
                <div className="flex items-center justify-center gap-2 text-slate-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving…
                </div>
              )}
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleCancelForgot}
                  disabled={busy}
                  className="text-sm text-slate-400 hover:text-white disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          {phase === 'forgot_done' && (
            <div className="flex items-center justify-center gap-2 text-emerald-300 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Unlocking…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatRemaining(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}

function extractErrorMessage(err: unknown): string {
  console.error('[LockScreen] error:', err);
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | null;
    if (body?.error) return body.error;
    return `Request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}
