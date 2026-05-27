import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { OtpInput } from '../auth/OtpInput';
import { hasPin, setPin } from '../../services/pinStore';
import { onPinReset } from '../../services/pinResetSignal';

// Set / change the device PIN from Settings (no relaunch, no email). Needed so
// an operator can re-establish a PIN after an offline recovery code cleared it
// — the recovery banner points here — and to change a remembered PIN at will.
// Reaching Settings already means the operator is past the lock, so this
// doesn't re-ask for the current PIN. Setting a PIN re-arms whichever security
// gates are enabled in this section.

export function DevicePinSettings() {
  const [pinSet, setPinSet] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = () =>
    void hasPin()
      .then(setPinSet)
      .catch(() => setPinSet(null));

  useEffect(() => {
    refresh();
    // If a recovery code clears the PIN while this page is open, reflect it.
    return onPinReset(refresh);
  }, []);

  return (
    <div className="flex items-center justify-between p-4 rounded-lg border-2 border-slate-700 bg-slate-700/30 mb-3">
      <div>
        <div className="font-semibold text-lg">Device PIN</div>
        <div className="text-sm text-slate-400">
          Used by the security gates above and the nav-bar Lock button.{' '}
          {pinSet === null ? '' : pinSet ? 'A PIN is currently set.' : 'No PIN is set.'}
        </div>
      </div>
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors text-sm font-medium whitespace-nowrap"
      >
        {pinSet ? 'Change PIN' : 'Set PIN'}
      </button>

      {open && (
        <SetPinModal
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function SetPinModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [phase, setPhase] = useState<'choose' | 'confirm'>('choose');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFirstComplete(value: string) {
    setError(null);
    setFirst(value);
    setSecond('');
    setPhase('confirm');
  }

  async function handleSecondComplete(value: string) {
    if (value !== first) {
      setError('PINs don’t match. Choose a PIN again.');
      setFirst('');
      setSecond('');
      setPhase('choose');
      return;
    }
    setBusy(true);
    try {
      await setPin(value);
      onSaved();
    } catch (err) {
      console.error('[DevicePinSettings] setPin failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to save PIN. Try again.');
      setFirst('');
      setSecond('');
      setPhase('choose');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-white mb-1">
            {phase === 'choose' ? 'Choose a PIN' : 'Confirm your PIN'}
          </h1>
          <p className="text-slate-400 text-sm">
            {phase === 'choose'
              ? 'Pick a 4-digit PIN for this device.'
              : 'Type it once more to make sure it matches.'}
          </p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4">
          {phase === 'choose' ? (
            <OtpInput
              length={4}
              value={first}
              onChange={setFirst}
              onComplete={handleFirstComplete}
              disabled={busy}
            />
          ) : (
            <OtpInput
              length={4}
              value={second}
              onChange={setSecond}
              onComplete={handleSecondComplete}
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

          <div className="flex justify-center gap-4 pt-1">
            {phase === 'confirm' && !busy && (
              <button
                type="button"
                onClick={() => {
                  setPhase('choose');
                  setFirst('');
                  setSecond('');
                  setError(null);
                }}
                className="text-sm text-slate-400 hover:text-white"
              >
                ← Pick a different PIN
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-sm text-slate-400 hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
