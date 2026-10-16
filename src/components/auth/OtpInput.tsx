import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  length?: number;
  /** Secret entry (PIN): digits render as dots, with an eye button to reveal them. */
  masked?: boolean;
}

export function OtpInput({ value, onChange, onComplete, disabled, length = 6, masked = false }: OtpInputProps) {
  const { t } = useTranslation();
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const [revealed, setRevealed] = useState(false);
  const hidden = masked && !revealed;

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  const firedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (value.length === length && onComplete && firedForRef.current !== value) {
      firedForRef.current = value;
      onComplete(value);
    }
    if (value.length < length) {
      firedForRef.current = null;
    }
  }, [value, length, onComplete]);

  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  return (
    <div className="flex gap-2 justify-center items-center">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { inputs.current[i] = el; }}
          type={hidden ? 'password' : 'text'}
          inputMode="numeric"
          autoComplete="off"
          maxLength={1}
          value={d}
          disabled={disabled}
          onChange={(e) => {
            const ch = e.target.value.replace(/\D/g, '').slice(-1);
            const next = (value.slice(0, i) + ch + value.slice(i + 1)).slice(0, length);
            onChange(next);
            if (ch && i < length - 1) inputs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i] && i > 0) {
              inputs.current[i - 1]?.focus();
            }
            if (e.key === 'ArrowLeft' && i > 0) inputs.current[i - 1]?.focus();
            if (e.key === 'ArrowRight' && i < length - 1) inputs.current[i + 1]?.focus();
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
            if (pasted) {
              e.preventDefault();
              onChange(pasted);
              const focusAt = Math.min(pasted.length, length - 1);
              inputs.current[focusAt]?.focus();
            }
          }}
          className="w-12 h-14 text-center text-2xl font-mono bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] text-[var(--pg-text)] focus:outline-none focus:border-[var(--pg-accent-line)] disabled:opacity-50"
        />
      ))}
      {masked && (
        <button
          type="button"
          // Keep focus on the digit being typed; the click only flips visibility.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setRevealed((r) => !r)}
          title={revealed ? t('common:hidePin') : t('common:showPin')}
          aria-label={revealed ? t('common:hidePin') : t('common:showPin')}
          aria-pressed={revealed}
          className="ml-1 p-2 rounded-[var(--pg-radius-md)] text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] hover:bg-[var(--pg-surface-2)]"
        >
          {revealed ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
        </button>
      )}
    </div>
  );
}
