import { useCallback, useEffect, useRef, useState } from 'react';

// Fullscreen overlay shown on a team's first bip when "Self-register team names"
// is enabled. The team types its own name; on submit the caller persists it
// (updateTeam) and proceeds to any first-bip videos, then starts the clock.
//
// Shown BEFORE the video overlay. Players cannot dismiss it without entering a
// name — only the operator can, via the same hidden 4-tap top-right gesture as
// FirstBipVideoOverlay, which aborts the start entirely.
//
// Keyboard: the field autofocuses on mount; because the overlay is bip-triggered
// (no preceding user gesture) a WebView may decline to raise the soft keyboard,
// so tapping anywhere on the card re-focuses the input — that tap is a user
// gesture and forces the keyboard up on Android tablets.

interface SelfRegisterOverlayProps {
  language: string;
  onSubmit: (name: string) => void;
  onAbort: () => void;
}

// Window of time inside which the 4 taps in the top-right corner must
// happen for the operator skip gesture to trigger.
const TAP_WINDOW_MS = 3000;
// Side length (px) of the invisible top-right hit zone — comfortable thumb
// target on a tablet, un-discoverable by players.
const TAP_ZONE_PX = 96;
const MAX_NAME_LEN = 40;

interface Strings {
  title: string;
  placeholder: string;
  submit: string;
  skipTitle: string;
  skipBody: string;
  cancel: string;
  confirm: string;
}

const STRINGS: Record<string, Strings> = {
  en: {
    title: 'Enter your team name',
    placeholder: 'Team name',
    submit: 'Start',
    skipTitle: 'Cancel registration?',
    skipBody: 'Admin override — confirm to dismiss this prompt without starting the team.',
    cancel: 'Cancel',
    confirm: 'Cancel registration',
  },
  fr: {
    title: "Entrez le nom de votre équipe",
    placeholder: "Nom d'équipe",
    submit: "C'est parti",
    skipTitle: "Annuler l'inscription ?",
    skipBody: "Action administrateur — confirmez pour fermer sans démarrer l'équipe.",
    cancel: 'Annuler',
    confirm: "Annuler l'inscription",
  },
  es: {
    title: 'Escribe el nombre de tu equipo',
    placeholder: 'Nombre del equipo',
    submit: 'Empezar',
    skipTitle: '¿Cancelar el registro?',
    skipBody: 'Acción de administrador: confirma para cerrar sin iniciar el equipo.',
    cancel: 'Cancelar',
    confirm: 'Cancelar registro',
  },
  de: {
    title: 'Gib deinen Teamnamen ein',
    placeholder: 'Teamname',
    submit: 'Start',
    skipTitle: 'Registrierung abbrechen?',
    skipBody: 'Admin-Aktion — bestätigen, um ohne Teamstart zu schließen.',
    cancel: 'Abbrechen',
    confirm: 'Registrierung abbrechen',
  },
  it: {
    title: 'Inserisci il nome della tua squadra',
    placeholder: 'Nome squadra',
    submit: 'Inizia',
    skipTitle: 'Annullare la registrazione?',
    skipBody: "Azione amministratore — conferma per chiudere senza avviare la squadra.",
    cancel: 'Annulla',
    confirm: 'Annulla registrazione',
  },
};

export function SelfRegisterOverlay({ language, onSubmit, onAbort }: SelfRegisterOverlayProps) {
  const [name, setName] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tapTimestamps = useRef<number[]>([]);

  const t = STRINGS[language] ?? STRINGS.en;
  const trimmed = name.trim();

  // Autofocus on mount. The autoFocus attribute covers most cases; this also
  // re-asserts focus after the overlay paints.
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const focusInput = useCallback(() => {
    if (!confirmOpen) inputRef.current?.focus();
  }, [confirmOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  };

  const handleTapZoneClick = (e: React.MouseEvent) => {
    // Don't let the tap fall through to the card's focus handler.
    e.stopPropagation();
    const now = Date.now();
    tapTimestamps.current = [...tapTimestamps.current, now].filter((ts) => now - ts <= TAP_WINDOW_MS);
    if (tapTimestamps.current.length >= 4) {
      tapTimestamps.current = [];
      setConfirmOpen(true);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] bg-black/90 flex items-center justify-center p-6">
      {/* Tapping the card re-focuses the input → forces the soft keyboard up. */}
      <div
        onClick={focusInput}
        className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl p-8 shadow-2xl"
      >
        <h2 className="text-2xl font-bold text-white text-center mb-6">{t.title}</h2>
        <form onSubmit={handleSubmit} className="space-y-5">
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.placeholder}
            maxLength={MAX_NAME_LEN}
            autoFocus
            inputMode="text"
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full px-5 py-4 text-xl text-center bg-slate-800 border-2 border-slate-600 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            type="submit"
            disabled={trimmed.length === 0}
            className="w-full px-6 py-4 text-lg font-semibold rounded-xl transition bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed"
          >
            {t.submit}
          </button>
        </form>
      </div>

      {/* Invisible 4-tap admin escape hatch, top-right corner. */}
      <button
        type="button"
        aria-label="Admin escape — tap 4 times to cancel"
        onClick={handleTapZoneClick}
        className="absolute top-0 right-0 bg-transparent border-0 cursor-default"
        style={{ width: TAP_ZONE_PX, height: TAP_ZONE_PX }}
      />

      {confirmOpen && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center p-6">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">{t.skipTitle}</h3>
            <p className="text-sm text-slate-300">{t.skipBody}</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setConfirmOpen(false);
                  focusInput();
                }}
                className="px-4 py-2 text-sm bg-slate-700 text-white rounded-lg hover:bg-slate-600"
              >
                {t.cancel}
              </button>
              <button
                onClick={() => {
                  setConfirmOpen(false);
                  onAbort();
                }}
                className="px-4 py-2 text-sm bg-rose-600 text-white rounded-lg hover:bg-rose-700"
              >
                {t.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
