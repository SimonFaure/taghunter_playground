import { useEffect, useRef } from 'react';

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  length?: number;
}

export function OtpInput({ value, onChange, onComplete, disabled, length = 6 }: OtpInputProps) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

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
    <div className="flex gap-2 justify-center">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { inputs.current[i] = el; }}
          type="text"
          inputMode="numeric"
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
          className="w-12 h-14 text-center text-2xl font-mono bg-slate-800 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:opacity-50"
        />
      ))}
    </div>
  );
}
