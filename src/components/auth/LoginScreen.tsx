import { useState } from 'react';
import { Mail, Loader2 } from 'lucide-react';
import { OtpInput } from './OtpInput';
import { CapReachedDialog } from './CapReachedDialog';
import { requestOtp, verifyOtp, evictAndVerify, DeviceListItem } from '../../services/auth';
import { ApiError } from '../../services/api';
import type { AuthUser } from '../../services/authStore';

type Phase = 'email' | 'code' | 'cap_reached';

interface LoginScreenProps {
  onAuthenticated: (user: AuthUser) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capState, setCapState] = useState<{
    approval_token: string;
    devices: DeviceListItem[];
    max_devices: number;
  } | null>(null);

  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await requestOtp(email.trim());
      setPhase('code');
      setCode('');
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyOtp(value: string) {
    setError(null);
    setBusy(true);
    try {
      const outcome = await verifyOtp(email.trim(), value);
      if (outcome.kind === 'success') {
        onAuthenticated(outcome.authUser);
      } else {
        setCapState({
          approval_token: outcome.approval_token,
          devices: outcome.devices,
          max_devices: outcome.max_devices,
        });
        setPhase('cap_reached');
      }
    } catch (err) {
      setError(extractErrorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function handleEvict(deviceId: number) {
    if (!capState) return;
    setError(null);
    setBusy(true);
    try {
      const user = await evictAndVerify(email.trim(), capState.approval_token, deviceId);
      onAuthenticated(user);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function handleCancelCap() {
    setCapState(null);
    setPhase('email');
    setCode('');
  }

  function handleResetEmail() {
    setPhase('email');
    setCode('');
    setError(null);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Tag Hunter Playground</h1>
          <p className="text-slate-400">Sign in to continue</p>
        </div>

        {phase === 'email' && (
          <form
            onSubmit={handleRequestOtp}
            className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4"
          >
            <label className="block">
              <span className="text-sm text-slate-300 block mb-2">Email address</span>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoFocus
                  disabled={busy}
                  className="w-full pl-10 pr-3 py-3 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
                />
              </div>
            </label>
            {error && <div className="text-sm text-red-400">{error}</div>}
            <button
              type="submit"
              disabled={busy || !email.includes('@')}
              className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg font-medium flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? 'Sending code…' : 'Send login code'}
            </button>
            <p className="text-xs text-slate-500 text-center">
              Accounts are created by your administrator.
            </p>
          </form>
        )}

        {phase === 'code' && (
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4">
            <div className="text-center">
              <p className="text-slate-300">
                We sent a 6-digit code to
              </p>
              <p className="text-white font-medium">{email}</p>
            </div>

            <OtpInput value={code} onChange={setCode} onComplete={handleVerifyOtp} disabled={busy} />

            {error && <div className="text-sm text-red-400 text-center">{error}</div>}

            {busy && (
              <div className="flex items-center justify-center gap-2 text-slate-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Verifying…
              </div>
            )}

            <div className="flex justify-between items-center text-sm">
              <button
                type="button"
                onClick={handleResetEmail}
                disabled={busy}
                className="text-slate-400 hover:text-white disabled:opacity-50"
              >
                ← Use a different email
              </button>
              <button
                type="button"
                onClick={() => handleRequestOtp({ preventDefault() {} } as React.FormEvent)}
                disabled={busy}
                className="text-blue-400 hover:text-blue-300 disabled:opacity-50"
              >
                Resend code
              </button>
            </div>
          </div>
        )}

        {phase === 'cap_reached' && capState && (
          <CapReachedDialog
            devices={capState.devices}
            maxDevices={capState.max_devices}
            onSelect={handleEvict}
            onCancel={handleCancelCap}
            busy={busy}
          />
        )}
      </div>
    </div>
  );
}

function extractErrorMessage(err: unknown): string {
  console.error('[LoginScreen] auth call failed:', err);
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | null;
    if (body?.error) return body.error;
    return `Request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const anyErr = err as { message?: unknown };
    if (typeof anyErr.message === 'string') return anyErr.message;
    try {
      return JSON.stringify(err);
    } catch {
      // fallthrough
    }
  }
  return 'Something went wrong. Please try again.';
}
