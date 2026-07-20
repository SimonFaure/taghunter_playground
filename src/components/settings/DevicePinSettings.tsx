import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { OtpInput } from '../auth/OtpInput';
import { hasPin, setPin } from '../../services/pinStore';
import { onPinReset } from '../../services/pinResetSignal';
import { HelpDot } from '../../help';

// Set / change the device PIN from Settings (no relaunch, no email). Needed so
// an operator can re-establish a PIN after an offline recovery code cleared it
// - the recovery banner points here - and to change a remembered PIN at will.
// Reaching Settings already means the operator is past the lock, so this
// doesn't re-ask for the current PIN. Setting a PIN re-arms whichever security
// gates are enabled in this section.

export function DevicePinSettings() {
  const { t } = useTranslation();
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
    <div className="flex items-center justify-between p-4 rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)] mb-3">
      <div>
        <div className="font-semibold text-lg flex items-center gap-1.5 text-[var(--pg-text)]">
          {t('pinSetup:devicePin')}
          <HelpDot topic="security.pin" />
        </div>
        <div className="text-sm text-[var(--pg-text-dim)]">
          {t('pinSetup:gatesHint')}{' '}
          {pinSet === null ? '' : pinSet ? t('pinSetup:pinCurrentlySet') : t('pinSetup:noPinSet')}
        </div>
      </div>
      <button
        onClick={() => setOpen(true)}
        className="pg-btn pg-btn--primary pg-btn--sm whitespace-nowrap"
      >
        {pinSet ? t('pinSetup:changePin') : t('pinSetup:setPin')}
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
  const { t } = useTranslation();
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
      setError(t('pinSetup:pinsDontMatch'));
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
      setError(err instanceof Error ? err.message : t('pinSetup:saveFailed'));
      setFirst('');
      setSecond('');
      setPhase('choose');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pg-overlay z-[200]">
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-[var(--pg-text)] mb-1">
            {phase === 'choose' ? t('pinSetup:chooseTitle') : t('pinSetup:confirmTitle')}
          </h1>
          <p className="text-[var(--pg-text-dim)] text-sm">
            {phase === 'choose'
              ? t('pinSetup:chooseSubtitle')
              : t('pinSetup:typeAgain')}
          </p>
        </div>

        <div className="pg-panel p-6 space-y-4">
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
            <div className="flex items-center justify-center gap-2 text-[var(--pg-text-dim)] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('pinSetup:saving')}
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
                className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)]"
              >
                {'← '}
                {t('pinSetup:pickDifferent')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] disabled:opacity-50"
            >
              {t('pinSetup:cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
