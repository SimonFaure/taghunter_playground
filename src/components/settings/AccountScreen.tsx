import { useEffect, useState } from 'react';
import {
  LogOut,
  Loader2,
  Mail,
  User as UserIcon,
  Award,
  CheckCircle2,
  AlertTriangle,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { isOnline, onConnectivityChange } from '../../services/connectivity';

// Account tab — read-only summary of the signed-in client + the destructive
// "sign out of this device" action. The everyday logout verb has been
// reframed as the cold-start PIN lock (see AuthProvider), so reaching this
// button means the user really does want to release this device.
//
// Online-only by design: signing out revokes the device server-side, and
// without internet the revoke call would no-op while local state still
// got wiped — that's worth avoiding so the device cap stays consistent.
export function AccountScreen() {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [online, setOnline] = useState(isOnline);

  useEffect(() => onConnectivityChange(setOnline), []);

  if (!user) return null;

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
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-white">Account</h1>

      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 space-y-4">
        <Row icon={<UserIcon className="w-4 h-4 text-slate-400" />} label="Name">
          <span className="text-white">{user.name || <em className="text-slate-500">Not set</em>}</span>
        </Row>
        <Row icon={<Mail className="w-4 h-4 text-slate-400" />} label="Email">
          <span className="text-white">{user.email}</span>
        </Row>
        <Row icon={<Award className="w-4 h-4 text-slate-400" />} label="License">
          <span className="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/40 text-sm capitalize">
            {user.license_type || 'unknown'}
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
          label="Billing"
        >
          <span className={user.billing_up_to_date ? 'text-emerald-300' : 'text-amber-300'}>
            {user.billing_up_to_date ? 'Up to date' : 'Payment needed'}
          </span>
        </Row>
      </div>

      <div className="flex flex-col items-end gap-2">
        <button
          onClick={() => setConfirming(true)}
          disabled={!online || signingOut}
          className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-medium disabled:opacity-50 disabled:hover:bg-red-600"
          title={online ? undefined : 'Connect to the internet to sign out'}
        >
          {signingOut ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
          Sign out of this device
        </button>
        {!online && (
          <p className="text-xs text-slate-500 flex items-center gap-1">
            <WifiOff className="w-3 h-3" />
            Connect to the internet to sign out.
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-300" />
          </div>
          <h2 className="text-lg font-semibold text-white">Sign out of this device?</h2>
        </div>
        <p className="text-sm text-slate-300">
          You’re signed in as <span className="text-white font-medium">{email}</span>. Signing out
          revokes this device, clears the PIN, and removes the local account data. You’ll need
          internet to sign back in.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-slate-300 hover:bg-slate-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-medium disabled:opacity-50"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Sign out
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
      <div className="flex items-center gap-2 text-sm text-slate-400 min-w-0">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-right min-w-0 truncate">{children}</div>
    </div>
  );
}
