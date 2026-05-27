/**
 * Bundled defaults for the four global tagquest HUD chrome labels.
 *
 * MIRROR of studio-taghunter/src/scenarios/preview/previewLabels.ts
 * `DEFAULT_PREVIEW_LABELS`. Kept in sync by hand — both copies must move
 * together when defaults change. Used when the admin_translations cache is
 * empty (first launch with no sync) or missing the player's language.
 */

export type AdminLabelKey = 'score' | 'malus' | 'late_malus' | 'combo_points' | 'next_malus';

export type AdminTranslationsValue = Record<AdminLabelKey, Partial<Record<string, string>>>;

// `next_malus` uses a `{s}` placeholder, replaced at render with the seconds
// until the next late-malus tick. Mirror of studio's DEFAULT_PREVIEW_LABELS.
const DEFAULTS: Record<string, Record<AdminLabelKey, string>> = {
  fr: {
    score: 'SCORE',
    malus: 'MALUS',
    late_malus: 'MALUS RETARD',
    combo_points: 'POINTS COMBO',
    next_malus: 'Prochain malus dans {s} s',
  },
  en: {
    score: 'SCORE',
    malus: 'PENALTY',
    late_malus: 'LATE PENALTY',
    combo_points: 'COMBO POINTS',
    next_malus: 'Next malus in {s} s',
  },
  es: {
    score: 'PUNTUACIÓN',
    malus: 'PENALIZACIÓN',
    late_malus: 'PENALIZACIÓN TARDÍA',
    combo_points: 'PUNTOS COMBO',
    next_malus: 'Próxima penalización en {s} s',
  },
  de: {
    score: 'PUNKTE',
    malus: 'STRAFE',
    late_malus: 'VERSPÄTUNGSSTRAFE',
    combo_points: 'KOMBO-PUNKTE',
    next_malus: 'Nächste Strafe in {s} s',
  },
  it: {
    score: 'PUNTEGGIO',
    malus: 'PENALITÀ',
    late_malus: 'PENALITÀ IN RITARDO',
    combo_points: 'PUNTI COMBO',
    next_malus: 'Prossima penalità tra {s} s',
  },
  pt: {
    score: 'PONTUAÇÃO',
    malus: 'PENALIDADE',
    late_malus: 'PENALIDADE TARDIA',
    combo_points: 'PONTOS COMBO',
    next_malus: 'Próxima penalidade em {s} s',
  },
};

/**
 * Resolve a single admin label at runtime. Render order:
 *   adminValue[key][lang] →
 *   adminValue[key][defaultLang] →
 *   first available admin lang →
 *   bundled defaults[lang] →
 *   bundled defaults[defaultLang] →
 *   bundled defaults.fr →
 *   ''.
 */
export function resolveAdminLabelRuntime(
  adminValue: AdminTranslationsValue | null | undefined,
  key: AdminLabelKey,
  lang: string,
  defaultLang: string,
): string {
  const adminEntry = adminValue?.[key];
  if (adminEntry) {
    const override =
      adminEntry[lang] ??
      adminEntry[defaultLang] ??
      Object.values(adminEntry).find((v) => typeof v === 'string' && v.length > 0);
    if (override) return override;
  }
  return (
    DEFAULTS[lang]?.[key] ??
    DEFAULTS[defaultLang]?.[key] ??
    DEFAULTS.fr[key]
  );
}
