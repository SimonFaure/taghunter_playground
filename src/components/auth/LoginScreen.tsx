import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Mail, Loader2 } from 'lucide-react';
import { OtpInput } from './OtpInput';
import { CapReachedDialog } from './CapReachedDialog';
import { requestOtp, verifyOtp, evictAndVerify, DeviceListItem } from '../../services/auth';
import { ApiError } from '../../services/api';
import { probeStudioReachable } from '../../services/connectivity';
import type { AuthUser } from '../../services/authStore';

type Phase = 'email' | 'code' | 'cap_reached';

interface LoginScreenProps {
  onAuthenticated: (user: AuthUser) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const { t } = useTranslation();
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
      setError(await resolveLoginError(err, t));
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
      setError(await resolveLoginError(err, t));
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
      setError(extractErrorMessage(err, t));
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
    <div className="min-h-screen flex items-center justify-center p-6 pg-app-bg">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[var(--pg-text)] mb-2">{t('authChrome:login.title')}</h1>
          <p className="text-[var(--pg-text-dim)]">{t('authChrome:login.subtitle')}</p>
        </div>

        {phase === 'email' && (
          <form
            onSubmit={handleRequestOtp}
            className="pg-panel p-6 space-y-4"
          >
            <label className="block">
              <span className="pg-label block mb-2">{t('authChrome:login.emailLabel')}</span>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--pg-text-dim)] z-10" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('authChrome:login.emailPlaceholder')}
                  required
                  autoFocus
                  disabled={busy}
                  className="pg-input !pl-10 disabled:opacity-50"
                />
              </div>
            </label>
            {error && <div className="text-sm text-red-400">{error}</div>}
            <button
              type="submit"
              disabled={busy || !email.includes('@')}
              className="pg-btn pg-btn--primary w-full !py-3 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? t('authChrome:login.sendingCode') : t('authChrome:login.sendCode')}
            </button>
            <p className="text-xs text-[var(--pg-text-dim)] text-center">
              {t('authChrome:login.adminNote')}
            </p>
          </form>
        )}

        {phase === 'code' && (
          <div className="pg-panel p-6 space-y-4">
            <div className="text-center">
              <p className="text-[var(--pg-text-muted)]">
                {t('authChrome:login.codeSentTo')}
              </p>
              <p className="text-[var(--pg-text)] font-medium">{email}</p>
            </div>

            <OtpInput value={code} onChange={setCode} onComplete={handleVerifyOtp} disabled={busy} />

            {error && <div className="text-sm text-red-400 text-center">{error}</div>}

            {busy && (
              <div className="flex items-center justify-center gap-2 text-[var(--pg-text-dim)] text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('authChrome:login.verifying')}
              </div>
            )}

            <div className="flex justify-between items-center text-sm">
              <button
                type="button"
                onClick={handleResetEmail}
                disabled={busy}
                className="text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] disabled:opacity-50"
              >
                {t('authChrome:login.useDifferentEmail')}
              </button>
              <button
                type="button"
                onClick={() => handleRequestOtp({ preventDefault() {} } as React.FormEvent)}
                disabled={busy}
                className="text-[var(--pg-accent-bright)] hover:text-[var(--pg-accent-hover)] disabled:opacity-50"
              >
                {t('authChrome:login.resendCode')}
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

// Login needs studio (the OTP is issued server-side), so a fresh device taken
// straight to a no-internet venue CANNOT be provisioned on site - and the raw
// transport error ("request timed out") doesn't say why. When the call fails,
// confirm whether studio is actually reachable; if not, say plainly that this
// device must be set up online once before the venue. (F2: the actionable half
// of "fresh offline install has no auth path".)
async function resolveLoginError(err: unknown, t: TFunction): Promise<string> {
  const reachable = await probeStudioReachable(4000).catch(() => false);
  if (!reachable) {
    return t('authChrome:errors.offlineFirstLogin', {
      defaultValue:
        'No internet connection to the TagHunter server. This device must be set up online at least once before you take it to a venue - connect to the internet and sign in, then it works offline on site.',
    });
  }
  return extractErrorMessage(err, t);
}

function extractErrorMessage(err: unknown, t: TFunction): string {
  console.error('[LoginScreen] auth call failed:', err);
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | null;
    if (body?.error) return body.error;
    return t('authChrome:errors.requestFailed', { status: err.status });
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
  return t('authChrome:errors.generic');
}
