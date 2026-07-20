import { useCallback, useEffect, useRef, useState } from 'react';
import { LanguageFlagRadios } from './LanguageFlagRadios';
import { listPoolNames } from '../services/namePoolsStore';

// Fullscreen overlay shown on a team's first bip when "Self-register team names"
// is enabled. The team types its own name; on submit the caller persists it
// (updateTeam) and proceeds to any first-bip videos, then starts the clock.
//
// Shown BEFORE the video overlay. Players cannot dismiss it without entering a
// name - only the operator can, via the same hidden 4-tap top-right gesture as
// FirstBipVideoOverlay, which aborts the start entirely.
//
// Two optional sub-features (launch flags, both children of self-register):
//   • addRandomName - a "Choose my team name for me" button that draws a pooled
//     name (scenario audience + the chosen language) and fills the field; the
//     player can tap again to re-roll. Hidden if no pooled names are available.
//   • allowLanguageChoice - flag radios let the player pick their team's display
//     language. The pick live-retranslates this overlay's chrome and is returned
//     to the caller (persisted on the team, drives in-game text + the name draw).
//
// Keyboard: the field autofocuses on mount; because the overlay is bip-triggered
// (no preceding user gesture) a WebView may decline to raise the soft keyboard,
// so tapping anywhere on the card re-focuses the input - that tap is a user
// gesture and forces the keyboard up on Android tablets.

interface SelfRegisterOverlayProps {
  /** The launch language - pre-selects the flag radios and is the default
   *  returned language when the player doesn't pick one. */
  language: string;
  /** Scenario's available languages (2-letter codes) for the flag radios. */
  scenarioLanguages?: string[];
  /** Scenario's audience (game_public) for the random-name pool draw. */
  scenarioAudience?: string;
  /** Show the flag radios (gated by the launch flag + 2+ languages). */
  allowLanguageChoice?: boolean;
  /** Show the "Choose my team name for me" button. */
  addRandomName?: boolean;
  onSubmit: (name: string, language: string) => void;
  onAbort: () => void;
}

// Window of time inside which the 4 taps in the top-right corner must
// happen for the operator skip gesture to trigger.
const TAP_WINDOW_MS = 3000;
// Side length (px) of the invisible top-right hit zone - comfortable thumb
// target on a tablet, un-discoverable by players.
const TAP_ZONE_PX = 96;
const MAX_NAME_LEN = 40;

interface Strings {
  title: string;
  placeholder: string;
  submit: string;
  randomName: string;
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
    randomName: 'Choose my team name for me',
    skipTitle: 'Cancel registration?',
    skipBody: 'Admin override - confirm to dismiss this prompt without starting the team.',
    cancel: 'Cancel',
    confirm: 'Cancel registration',
  },
  fr: {
    title: "Entrez le nom de votre équipe",
    placeholder: "Nom d'équipe",
    submit: "C'est parti",
    randomName: 'Choisis un nom pour moi',
    skipTitle: "Annuler l'inscription ?",
    skipBody: "Action administrateur - confirmez pour fermer sans démarrer l'équipe.",
    cancel: 'Annuler',
    confirm: "Annuler l'inscription",
  },
  es: {
    title: 'Escribe el nombre de tu equipo',
    placeholder: 'Nombre del equipo',
    submit: 'Empezar',
    randomName: 'Elige un nombre por mí',
    skipTitle: '¿Cancelar el registro?',
    skipBody: 'Acción de administrador: confirma para cerrar sin iniciar el equipo.',
    cancel: 'Cancelar',
    confirm: 'Cancelar registro',
  },
  de: {
    title: 'Gib deinen Teamnamen ein',
    placeholder: 'Teamname',
    submit: 'Start',
    randomName: 'Wähle einen Namen für mich',
    skipTitle: 'Registrierung abbrechen?',
    skipBody: 'Admin-Aktion - bestätigen, um ohne Teamstart zu schließen.',
    cancel: 'Abbrechen',
    confirm: 'Registrierung abbrechen',
  },
  it: {
    title: 'Inserisci il nome della tua squadra',
    placeholder: 'Nome squadra',
    submit: 'Inizia',
    randomName: 'Scegli un nome per me',
    skipTitle: 'Annullare la registrazione?',
    skipBody: "Azione amministratore - conferma per chiudere senza avviare la squadra.",
    cancel: 'Annulla',
    confirm: 'Annulla registrazione',
  },
  pt: {
    title: 'Escreve o nome da tua equipa',
    placeholder: 'Nome da equipa',
    submit: 'Começar',
    randomName: 'Escolhe um nome por mim',
    skipTitle: 'Cancelar o registo?',
    skipBody: 'Ação de administrador - confirma para fechar sem iniciar a equipa.',
    cancel: 'Cancelar',
    confirm: 'Cancelar registo',
  },
  nl: {
    title: 'Voer je teamnaam in',
    placeholder: 'Teamnaam',
    submit: 'Start',
    randomName: 'Kies een naam voor mij',
    skipTitle: 'Registratie annuleren?',
    skipBody: 'Beheerdersactie - bevestig om te sluiten zonder het team te starten.',
    cancel: 'Annuleren',
    confirm: 'Registratie annuleren',
  },
  pl: {
    title: 'Wpisz nazwę swojej drużyny',
    placeholder: 'Nazwa drużyny',
    submit: 'Start',
    randomName: 'Wybierz nazwę za mnie',
    skipTitle: 'Anulować rejestrację?',
    skipBody: 'Działanie administratora - potwierdź, aby zamknąć bez startu drużyny.',
    cancel: 'Anuluj',
    confirm: 'Anuluj rejestrację',
  },
  ru: {
    title: 'Введите название команды',
    placeholder: 'Название команды',
    submit: 'Старт',
    randomName: 'Выбери имя за меня',
    skipTitle: 'Отменить регистрацию?',
    skipBody: 'Действие администратора - подтвердите, чтобы закрыть без старта команды.',
    cancel: 'Отмена',
    confirm: 'Отменить регистрацию',
  },
  ja: {
    title: 'チーム名を入力してください',
    placeholder: 'チーム名',
    submit: 'スタート',
    randomName: 'チーム名をおまかせ',
    skipTitle: '登録をキャンセルしますか？',
    skipBody: '管理者操作 - チームを開始せずに閉じるには確認してください。',
    cancel: 'キャンセル',
    confirm: '登録をキャンセル',
  },
  zh: {
    title: '请输入你的队名',
    placeholder: '队名',
    submit: '开始',
    randomName: '帮我选个队名',
    skipTitle: '取消注册？',
    skipBody: '管理员操作 - 确认以关闭而不启动队伍。',
    cancel: '取消',
    confirm: '取消注册',
  },
  ar: {
    title: 'أدخل اسم فريقك',
    placeholder: 'اسم الفريق',
    submit: 'ابدأ',
    randomName: 'اختر اسمًا لفريقي',
    skipTitle: 'إلغاء التسجيل؟',
    skipBody: 'إجراء المسؤول - أكّد للإغلاق دون بدء الفريق.',
    cancel: 'إلغاء',
    confirm: 'إلغاء التسجيل',
  },
};

export function SelfRegisterOverlay({
  language,
  scenarioLanguages = [],
  scenarioAudience = 'kids',
  allowLanguageChoice = false,
  addRandomName = false,
  onSubmit,
  onAbort,
}: SelfRegisterOverlayProps) {
  const [name, setName] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The player's chosen language - seeded from the launch language, updated when
  // they tap a flag. Drives the live overlay translation + the name-pool draw +
  // what gets persisted on the team.
  const [lang, setLang] = useState(language);
  // Pooled names for the current language (loaded for the random-name button).
  const [poolNames, setPoolNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tapTimestamps = useRef<number[]>([]);

  const showFlags = allowLanguageChoice && scenarioLanguages.length >= 2;
  const t = STRINGS[lang] ?? STRINGS.en;
  const trimmed = name.trim();

  // Load the pool names for the random-name button whenever the language (or the
  // toggle) changes. Empty result ⇒ the button stays hidden (graceful degrade).
  useEffect(() => {
    if (!addRandomName) {
      setPoolNames([]);
      return;
    }
    let cancelled = false;
    listPoolNames(scenarioAudience, lang)
      .then((names) => {
        if (!cancelled) setPoolNames(names);
      })
      .catch(() => {
        if (!cancelled) setPoolNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [addRandomName, scenarioAudience, lang]);

  // Autofocus on mount. The autoFocus attribute covers most cases; this also
  // re-asserts focus after the overlay paints.
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const focusInput = useCallback(() => {
    if (!confirmOpen) inputRef.current?.focus();
  }, [confirmOpen]);

  const pickRandomName = () => {
    if (poolNames.length === 0) return;
    let next = poolNames[Math.floor(Math.random() * poolNames.length)];
    // Re-roll to a different name when the pool allows it.
    if (poolNames.length > 1) {
      let guard = 0;
      while (next === name && guard < 6) {
        next = poolNames[Math.floor(Math.random() * poolNames.length)];
        guard += 1;
      }
    }
    setName(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (trimmed.length === 0) return;
    onSubmit(trimmed, lang);
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

        {showFlags && (
          <div className="mb-6">
            <LanguageFlagRadios languages={scenarioLanguages} value={lang} onChange={setLang} />
          </div>
        )}

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

          {addRandomName && poolNames.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                pickRandomName();
              }}
              className="w-full px-6 py-3 text-base font-medium rounded-xl transition bg-slate-700 text-white hover:bg-slate-600"
            >
              🎲 {t.randomName}
            </button>
          )}

          <button
            type="submit"
            disabled={trimmed.length === 0}
            className="w-full px-6 py-4 text-lg font-semibold rounded-xl transition bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed"
          >
            {t.submit}
          </button>

          {/* Visible cancel control. Opens the same confirm prompt as the hidden
              4-tap gesture so a stray player tap can't abort a registration. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmOpen(true);
            }}
            className="w-full px-6 py-2 text-sm font-medium rounded-xl transition text-slate-400 hover:text-white hover:bg-slate-800"
          >
            {t.cancel}
          </button>
        </form>
      </div>

      {/* Invisible 4-tap admin escape hatch, top-right corner. */}
      <button
        type="button"
        aria-label="Admin escape - tap 4 times to cancel"
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
