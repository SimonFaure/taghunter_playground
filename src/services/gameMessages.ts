// Shared in-game message vocabulary for the playground.
//
// All game types (Mystery, TagQuest, Tracks) render transient status messages
// through <GameMessageOverlay>, which is typed by GameMessageType. The actual
// localized strings now live in the i18next `ingame_common` namespace (bundled
// baselines in src/i18n/ingame.ts, overridable by the synced admin store) and
// resolve against the *team* language. This module keeps the status vocabulary,
// its severities, and the team-name formatting; lookups delegate to `tIngame`.

import { tIngame } from '../i18n/ingame';

export type GameMessageType = 'success' | 'error' | 'warning' | 'info';

export type StatusKey =
  | 'chip_not_recognized'
  | 'card_empty'
  | 'team_already_finished'
  | 'cheat_detected'
  | 'error'
  | 'card_not_registered'
  | 'track_finished'
  | 'no_checkpoints'
  | 'reuse_cooldown'
  | 'no_fresh_punches';

const KNOWN_STATUS_KEYS: ReadonlySet<string> = new Set<StatusKey>([
  'chip_not_recognized',
  'card_empty',
  'team_already_finished',
  'cheat_detected',
  'error',
  'card_not_registered',
  'track_finished',
  'no_checkpoints',
  'reuse_cooldown',
  'no_fresh_punches',
]);

/**
 * Replace the `%team%` placeholder (case-insensitive) in an authored UI string
 * with the team's display name. Authors type `%team%` in the editor's "UI text
 * strings" section to position the team name inside their own sentence. With no
 * team name the placeholder is stripped so a literal `%team%` never reaches the
 * screen.
 */
export const TEAM_PLACEHOLDER = '%team%';

export function applyTeamName(text: string, teamName?: string | null): string {
  return text.replace(/%team%/gi, (teamName ?? '').trim());
}

/** True when an authored string positions the team name itself via `%team%`. */
export function hasTeamPlaceholder(text: string | undefined | null): boolean {
  return !!text && /%team%/i.test(text);
}

/**
 * Localized text for a known status key in the given (team) language. `vars`
 * feed `{{var}}` interpolation - e.g. `localizedStatus('reuse_cooldown', lang,
 * { n: 5 })`.
 */
export function localizedStatus(
  key: StatusKey,
  lang: string,
  vars?: Record<string, string | number>,
): string {
  return tIngame('ingame_common', key, lang, vars);
}

// Punch-status → message-type severity. Kept here so the vocabulary and its
// severities live in one place.
const STATUS_TYPE: Partial<Record<StatusKey, GameMessageType>> = {
  chip_not_recognized: 'warning',
  card_empty: 'warning',
  team_already_finished: 'info',
  cheat_detected: 'error',
  error: 'error',
  no_fresh_punches: 'warning',
};

/**
 * Build the user-facing message + type for a non-ok punch result.
 *
 * `overrideText` - a per-scenario UI string (from the editor's "UI text strings"
 * section) that, when non-empty, replaces the default localized status text.
 */
export function describePunchStatus(
  status: string,
  teamName: string,
  fallbackMsg: string | undefined,
  lang: string,
  overrideText?: string,
): { text: string; type: GameMessageType } {
  const override = overrideText && overrideText.trim() ? overrideText.trim() : '';
  // When the author placed %team% themselves, they control where the name goes,
  // so we substitute it and skip the automatic "TeamName - " prefix below.
  const authorPlacedName = hasTeamPlaceholder(override);
  const base = override
    ? applyTeamName(override, teamName)
    : KNOWN_STATUS_KEYS.has(status)
      ? tIngame('ingame_common', status, lang)
      : fallbackMsg ?? tIngame('ingame_common', 'error', lang);
  const type = STATUS_TYPE[status as StatusKey] ?? 'warning';
  const text = teamName && !authorPlacedName ? `${teamName} - ${base}` : base;
  return { text, type };
}
