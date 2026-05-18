/**
 * Bundled defaults for the four global tagquest HUD chrome labels.
 *
 * MIRROR of studio-taghunter/src/scenarios/preview/previewLabels.ts
 * `DEFAULT_PREVIEW_LABELS`. Kept in sync by hand — both copies must move
 * together when defaults change. Used when the admin_translations cache is
 * empty (first launch with no sync) or missing the player's language.
 */

export type AdminLabelKey = 'score' | 'malus' | 'late_malus' | 'combo_points';

export type AdminTranslationsValue = Record<AdminLabelKey, Partial<Record<string, string>>>;

const DEFAULTS: Record<string, Record<AdminLabelKey, string>> = {
  fr: {
    score: 'SCORE',
    malus: 'MALUS',
    late_malus: 'MALUS RETARD',
    combo_points: 'POINTS COMBO',
  },
  en: {
    score: 'SCORE',
    malus: 'PENALTY',
    late_malus: 'LATE PENALTY',
    combo_points: 'COMBO POINTS',
  },
  es: {
    score: 'PUNTUACIÓN',
    malus: 'PENALIZACIÓN',
    late_malus: 'PENALIZACIÓN TARDÍA',
    combo_points: 'PUNTOS COMBO',
  },
  de: {
    score: 'PUNKTE',
    malus: 'STRAFE',
    late_malus: 'VERSPÄTUNGSSTRAFE',
    combo_points: 'KOMBO-PUNKTE',
  },
  it: {
    score: 'PUNTEGGIO',
    malus: 'PENALITÀ',
    late_malus: 'PENALITÀ IN RITARDO',
    combo_points: 'PUNTI COMBO',
  },
  pt: {
    score: 'PONTUAÇÃO',
    malus: 'PENALIDADE',
    late_malus: 'PENALIDADE TARDIA',
    combo_points: 'PONTOS COMBO',
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
