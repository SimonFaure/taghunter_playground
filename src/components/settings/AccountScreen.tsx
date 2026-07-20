import { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import {
  LogOut,
  Loader2,
  Mail,
  User as UserIcon,
  Award,
  CheckCircle2,
  AlertTriangle,
  WifiOff,
  CloudOff,
} from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { isOnline, onConnectivityChange } from '../../services/connectivity';
import { offlineGraceInfo, OFFLINE_WARNING_THRESHOLD_DAYS } from '../../services/authStore';

// Account tab - read-only summary of the signed-in client + the destructive
// "sign out of this device" action.
//
// The everyday "stepping away from the tablet" verb is the nav-bar Lock
// button (PIN gate, see AuthProvider). "Sign out" actually revokes the
// device server-side, so reaching this button means the user really does
// want to release this device.
//
// Online-only by design: signing out revokes the device server-side, and
// without internet the revoke call would no-op while local state still
// got wiped - that's worth avoiding so the device cap stays consistent.
export function AccountScreen() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [online, setOnline] = useState(isOnline);

  useEffect(() => onConnectivityChange(setOnline), []);

  if (!user) return null;

  const grace = offlineGraceInfo(user);
  const graceLow = grace.remainingDays <= OFFLINE_WARNING_THRESHOLD_DAYS;

  const handleConfirmSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
      setConfirming(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 pb-20 space-y-6">
      <h1 className="text-2xl font-semibold text-[var(--pg-text)]">{t('accountSettings:title')}</h1>

      <div className="pg-panel p-6 space-y-4">
        <Row icon={<UserIcon className="w-4 h-4 text-[var(--pg-text-dim)]" />} label={t('accountSettings:name')}>
          <span className="text-[var(--pg-text)]">{user.name || <em className="text-[var(--pg-text-dim)]">{t('accountSettings:notSet')}</em>}</span>
        </Row>
        <Row icon={<Mail className="w-4 h-4 text-[var(--pg-text-dim)]" />} label={t('accountSettings:email')}>
          <span className="text-[var(--pg-text)]">{user.email}</span>
        </Row>
        <Row icon={<Award className="w-4 h-4 text-[var(--pg-text-dim)]" />} label={t('accountSettings:license')}>
          <span className="pg-badge pg-badge--accent capitalize">
            {user.license_type || t('accountSettings:unknown')}
          </span>
        </Row>
        <Row
          icon={
            user.billing_up_to_date ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-400" />
            )
          }
          label={t('accountSettings:billing')}
        >
          <span className={user.billing_up_to_date ? 'text-emerald-300' : 'text-amber-300'}>
            {user.billing_up_to_date ? t('accountSettings:billingUpToDate') : t('accountSettings:billingPaymentNeeded')}
          </span>
        </Row>
        <Row
          icon={<CloudOff className={`w-4 h-4 ${graceLow ? 'text-amber-400' : 'text-[var(--pg-text-dim)]'}`} />}
          label={t('accountSettings:offlineAccess')}
        >
          <span className={graceLow ? 'text-amber-300' : 'text-[var(--pg-text)]'}>
            {grace.remainingDays > 0 ? (
              <Trans
                i18nKey="accountSettings:daysLeft"
                count={grace.remainingDays}
                values={{ count: grace.remainingDays, total: grace.graceDays }}
                components={{ dim: <span className="text-[var(--pg-text-dim)]" /> }}
              />
            ) : (
              t('accountSettings:offlineExpired')
            )}
          </span>
        </Row>
      </div>

      <div className="flex flex-col items-end gap-2">
        <button
          onClick={() => setConfirming(true)}
          disabled={!online || signingOut}
          className="pg-btn pg-btn--danger"
          title={online ? undefined : t('accountSettings:signOutOfflineTitle')}
        >
          {signingOut ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
          {t('accountSettings:signOutDevice')}
        </button>
        {!online && (
          <p className="text-xs text-[var(--pg-text-dim)] flex items-center gap-1">
            <WifiOff className="w-3 h-3" />
            {t('accountSettings:signOutOfflineHint')}
          </p>
        )}
      </div>

      {confirming && (
        <ConfirmSignOutModal
          email={user.email}
          busy={signingOut}
          onConfirm={handleConfirmSignOut}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

interface ConfirmSignOutModalProps {
  email: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmSignOutModal({ email, busy, onConfirm, onCancel }: ConfirmSignOutModalProps) {
  const { t } = useTranslation();
  return (
    <div className="pg-overlay">
      <div className="pg-modal max-w-md p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-300" />
          </div>
          <h2 className="text-lg font-semibold text-[var(--pg-text)]">{t('accountSettings:confirmTitle')}</h2>
        </div>
        <p className="text-sm text-[var(--pg-text-muted)]">
          <Trans
            i18nKey="accountSettings:confirmBody"
            values={{ email }}
            components={{ strong: <span className="text-[var(--pg-text)] font-medium" /> }}
          />
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="pg-btn pg-btn--ghost"
          >
            {t('accountSettings:cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="pg-btn pg-btn--danger"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('accountSettings:signOut')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 text-sm text-[var(--pg-text-dim)] min-w-0">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-right min-w-0 truncate">{children}</div>
    </div>
  );
}
