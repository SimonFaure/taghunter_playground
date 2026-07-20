import { LANG_FLAGS, langName } from '../services/langFlags';

interface LanguageFlagRadiosProps {
  /** 2-letter ISO codes to offer (the scenario's available languages). */
  languages: string[];
  /** Currently selected code. */
  value: string;
  onChange: (lang: string) => void;
  /** Optional extra classes on the wrapping row. */
  className?: string;
}

/**
 * Big, kiosk-friendly flag radios for the player self-register overlay. Each
 * option is a bundled SVG flag (never emoji - Windows can't render flag emoji)
 * with the language name underneath. The selected flag gets a highlighted ring.
 */
export function LanguageFlagRadios({ languages, value, onChange, className = '' }: LanguageFlagRadiosProps) {
  return (
    <div className={`flex flex-wrap items-stretch justify-center gap-3 ${className}`} role="radiogroup">
      {languages.map((lang) => {
        const selected = lang === value;
        const flag = LANG_FLAGS[lang];
        return (
          <button
            key={lang}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(lang)}
            className={`flex flex-col items-center gap-1.5 rounded-xl border-2 p-2 transition ${
              selected
                ? 'border-[var(--pg-accent)] bg-[var(--pg-accent-tint)]'
                : 'border-[var(--pg-line-strong)] bg-[var(--pg-surface-2)] hover:border-[var(--pg-text-dim)]'
            }`}
          >
            {flag ? (
              <img
                src={flag}
                alt={langName(lang)}
                draggable={false}
                className="h-10 w-15 rounded border border-black/20 object-cover"
                style={{ width: '3.75rem' }}
              />
            ) : (
              <span className="flex h-10 w-15 items-center justify-center rounded bg-[var(--pg-surface-3)] text-xs uppercase" style={{ width: '3.75rem' }}>
                {lang}
              </span>
            )}
            <span className="text-sm font-medium text-[var(--pg-text)]">{langName(lang)}</span>
          </button>
        );
      })}
    </div>
  );
}
