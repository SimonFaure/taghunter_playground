/**
 * In-game shared text (bucket 2) on the i18next engine.
 *
 * These are the game-type-agnostic + per-type strings shown to players during a
 * game (punch-status messages, tagquest HUD labels, …). Unlike chrome, they
 * resolve against the *team* language, and they are admin-editable + synced from
 * studio so wording can change without a Tauri release.
 *
 * Two layers, both on the same i18next instance as chrome:
 *  1. BASELINES - bundled in the build (lifted from the former `gameMessages.ts`
 *     STATUS_MESSAGES + `defaultPreviewLabels.ts`). Guarantee text offline / on a
 *     fresh device before any sync. Registered with overwrite:false.
 *  2. SYNCED OVERLAY - `hydrateIngameFromStore()` reads the synced
 *     `admin_translations` blobs and overlays them with overwrite:true.
 *
 * Namespaces: `ingame_common`, `ingame_tagquest`, `ingame_mystery`,
 * `ingame_tracks`. Interpolation is i18next-standard `{{var}}`.
 *
 * Design: plan `multilingual-app-translator-workflow.md` (step 2).
 */

import i18n from 'i18next';
import * as translationsStore from '../services/translationsStore';
import { PIVOT_LANG } from './languages';

export const INGAME_NAMESPACES = [
  'ingame_common',
  'ingame_tagquest',
  'ingame_mystery',
  'ingame_tracks',
] as const;
export type IngameNamespace = (typeof INGAME_NAMESPACES)[number];

/** Manifest/store meta keys mirror the namespace names 1:1. */
export const INGAME_STORE_KEYS = INGAME_NAMESPACES;

type Catalog = Record<string, Record<string, string>>; // lang -> key -> value

/**
 * ingame_common - punch/status vocabulary shared by all game types. Lifted from
 * the former gameMessages STATUS_MESSAGES; `{n}` placeholders kept as `{{n}}`.
 */
const COMMON_BASELINE: Catalog = {
  fr: {
    chip_not_recognized: 'Puce non reconnue',
    card_empty: 'Puce vide',
    team_already_finished: 'Équipe déjà terminée',
    cheat_detected: 'Triche détectée',
    error: 'Erreur',
    card_not_registered: 'Puce non enregistrée',
    track_finished: 'Parcours terminé !',
    no_checkpoints: 'Aucun point validé',
    reuse_cooldown: 'Puce rejouable dans {{n}} min',
    no_fresh_punches: 'Aucun poinçon récent - puce non réinitialisée ou horloge de poste décalée ?',
  },
  en: {
    chip_not_recognized: 'Card not recognized',
    card_empty: 'Card empty',
    team_already_finished: 'Team already finished',
    cheat_detected: 'Cheating detected',
    error: 'Error',
    card_not_registered: 'Card not registered',
    track_finished: 'Route complete!',
    no_checkpoints: 'No checkpoints found',
    reuse_cooldown: 'Card playable again in {{n}} min',
    no_fresh_punches: 'No recent punches - card not cleared or station clock off?',
  },
  es: {
    chip_not_recognized: 'Tarjeta no reconocida',
    card_empty: 'Tarjeta vacía',
    team_already_finished: 'Equipo ya terminado',
    cheat_detected: 'Trampa detectada',
    error: 'Error',
    card_not_registered: 'Tarjeta no registrada',
    track_finished: '¡Recorrido completado!',
    no_checkpoints: 'Ningún punto validado',
    reuse_cooldown: 'Tarjeta disponible en {{n}} min',
    no_fresh_punches: 'Sin marcajes recientes - ¿tarjeta sin borrar o reloj de estación desajustado?',
  },
  de: {
    chip_not_recognized: 'Karte nicht erkannt',
    card_empty: 'Karte leer',
    team_already_finished: 'Team bereits fertig',
    cheat_detected: 'Betrug erkannt',
    error: 'Fehler',
    card_not_registered: 'Karte nicht registriert',
    track_finished: 'Strecke abgeschlossen!',
    no_checkpoints: 'Keine Posten gefunden',
    reuse_cooldown: 'Karte in {{n}} Min wieder spielbar',
    no_fresh_punches: 'Keine aktuellen Stempel - Karte nicht gelöscht oder Stationsuhr falsch?',
  },
  it: {
    chip_not_recognized: 'Tessera non riconosciuta',
    card_empty: 'Tessera vuota',
    team_already_finished: 'Squadra già terminata',
    cheat_detected: 'Imbroglio rilevato',
    error: 'Errore',
    card_not_registered: 'Tessera non registrata',
    track_finished: 'Percorso completato!',
    no_checkpoints: 'Nessun punto trovato',
    reuse_cooldown: 'Tessera riutilizzabile tra {{n}} min',
    no_fresh_punches: 'Nessuna punzonatura recente - tessera non azzerata o orologio stazione errato?',
  },
  pt: {
    chip_not_recognized: 'Cartão não reconhecido',
    card_empty: 'Cartão vazio',
    team_already_finished: 'Equipa já terminou',
    cheat_detected: 'Batota detetada',
    error: 'Erro',
    card_not_registered: 'Cartão não registado',
    track_finished: 'Percurso concluído!',
    no_checkpoints: 'Nenhum ponto validado',
    reuse_cooldown: 'Cartão jogável em {{n}} min',
    no_fresh_punches: 'Sem registos recentes - cartão não apagado ou relógio da estação errado?',
  },
};

/**
 * ingame_tagquest - the four global tagquest HUD labels. Lifted from
 * defaultPreviewLabels DEFAULTS; `{s}` placeholder kept as `{{s}}`.
 * MIRROR of studio's previewLabels defaults - keep both in sync.
 */
const TAGQUEST_BASELINE: Catalog = {
  fr: { score: 'SCORE', malus: 'MALUS', late_malus: 'MALUS RETARD', combo_points: 'POINTS COMBO', next_malus: 'Prochain malus dans {{s}} s' },
  en: { score: 'SCORE', malus: 'PENALTY', late_malus: 'LATE PENALTY', combo_points: 'COMBO POINTS', next_malus: 'Next malus in {{s}} s' },
  es: { score: 'PUNTUACIÓN', malus: 'PENALIZACIÓN', late_malus: 'PENALIZACIÓN TARDÍA', combo_points: 'PUNTOS COMBO', next_malus: 'Próxima penalización en {{s}} s' },
  de: { score: 'PUNKTE', malus: 'STRAFE', late_malus: 'VERSPÄTUNGSSTRAFE', combo_points: 'KOMBO-PUNKTE', next_malus: 'Nächste Strafe in {{s}} s' },
  it: { score: 'PUNTEGGIO', malus: 'PENALITÀ', late_malus: 'PENALITÀ IN RITARDO', combo_points: 'PUNTI COMBO', next_malus: 'Prossima penalità tra {{s}} s' },
  pt: { score: 'PONTUAÇÃO', malus: 'PENALIDADE', late_malus: 'PENALIDADE TARDIA', combo_points: 'PONTOS COMBO', next_malus: 'Próxima penalidade em {{s}} s' },
};

const BASELINES: Record<IngameNamespace, Catalog> = {
  ingame_common: COMMON_BASELINE,
  ingame_tagquest: TAGQUEST_BASELINE,
  ingame_mystery: {},
  ingame_tracks: {},
};

/** Register the bundled baselines. Idempotent; never overwrites synced overlays. */
export function registerIngameBaselines(): void {
  for (const ns of INGAME_NAMESPACES) {
    const catalog = BASELINES[ns];
    for (const [lang, entries] of Object.entries(catalog)) {
      i18n.addResourceBundle(lang, ns, entries, /*deep*/ true, /*overwrite*/ false);
    }
  }
}

/**
 * Legacy store key → namespace. The studio backend still publishes the four
 * tagquest HUD labels under `tagquest_translations`; until it is renamed to the
 * per-namespace keys, we read the legacy key and overlay it onto `ingame_tagquest`
 * so the consolidation works against the current backend with no PHP change.
 */
const LEGACY_STORE_KEYS: Partial<Record<IngameNamespace, string>> = {
  ingame_tagquest: 'tagquest_translations',
};

/**
 * Overlay the synced admin translations on top of the baselines. Call after each
 * sync cycle. Synced values win (overwrite:true). Tolerant of missing/malformed
 * blobs - a bad row just leaves the baseline in place. Reads the new namespace
 * key first, then the legacy key as a fallback for the same namespace.
 */
export async function hydrateIngameFromStore(): Promise<void> {
  for (const ns of INGAME_STORE_KEYS) {
    const keys = [ns, LEGACY_STORE_KEYS[ns]].filter(Boolean) as string[];
    for (const storeKey of keys) {
      const catalog = normalizeBlob(await translationsStore.getValue<unknown>(storeKey));
      if (!catalog) continue;
      for (const [lang, entries] of Object.entries(catalog)) {
        i18n.addResourceBundle(lang, ns, entries, /*deep*/ true, /*overwrite*/ true);
      }
    }
  }
}

/**
 * Synced blobs are authored key→lang→value (the studio admin grid shape); the
 * i18next resource is lang→key→value. Accept either and normalize to the latter.
 * Returns null for unusable input.
 */
function normalizeBlob(blob: unknown): Catalog | null {
  if (!blob || typeof blob !== 'object') return null;
  const out: Catalog = {};
  for (const [outer, inner] of Object.entries(blob as Record<string, unknown>)) {
    if (!inner || typeof inner !== 'object') continue;
    for (const [innerKey, val] of Object.entries(inner as Record<string, unknown>)) {
      if (typeof val !== 'string') continue;
      // key→lang→value  (outer=key, innerKey=lang)  OR  lang→key→value.
      // Heuristic: a 2-letter innerKey that is NOT also a top-level key → outer
      // is the key, innerKey is the lang. Otherwise treat outer as the lang.
      const looksLikeKeyFirst = innerKey.length <= 3 && !(innerKey in (blob as object));
      const lang = looksLikeKeyFirst ? innerKey : outer;
      const key = looksLikeKeyFirst ? outer : innerKey;
      (out[lang] ??= {})[key] = normalizePlaceholders(val);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Normalize the `{s}`/`{n}` interpolation tokens to i18next's `{{s}}`/`{{n}}`,
 * tolerating legacy single-brace data saved before the migration. Idempotent:
 * already-doubled tokens are left unchanged.
 */
function normalizePlaceholders(value: string): string {
  return value.replace(/\{\{?([sn])\}?\}/g, '{{$1}}');
}

/**
 * Resolve an in-game string against a specific (team) language, independent of
 * the operator chrome language. Falls back lang → `en` (pivot) → raw key via
 * i18next's own fallback. `vars` feed `{{var}}` interpolation.
 */
export function tIngame(
  ns: IngameNamespace,
  key: string,
  lang: string,
  vars?: Record<string, string | number>,
): string {
  const fixedT = i18n.getFixedT(lang || PIVOT_LANG, ns);
  return fixedT(key, vars ?? {});
}
