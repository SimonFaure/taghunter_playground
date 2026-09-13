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
  // None of the punched stations is in the scenario's pattern - almost always a
  // wrong/absent pattern binding. Carries a technical detail (the read codes vs
  // the expected ones) that is appended to the localized sentence.
  | 'no_station_match'
  // Replaces the old `no_fresh_punches`, which blamed either an un-wiped card
  // OR a skewed station clock because the code genuinely couldn't tell. The
  // clock test is gone (see tagquestPunchLogic), so each cause now has its own
  // honest message.
  | 'punches_already_counted'
  | 'punches_not_wiped'
  // Advisory, NOT a rejection: a predetermined-roster chip arrived with punches
  // already on it. They are scored - with no pre-play bip there is no way to
  // tell them from the player's first trip - so this only asks the operator to
  // wipe cards before handing them out.
  | 'card_not_wiped'
  | 'card_full';

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
  'no_station_match',
  'punches_already_counted',
  'punches_not_wiped',
  'card_not_wiped',
  'card_full',
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
  no_station_match: 'error',
  team_already_finished: 'info',
  cheat_detected: 'error',
  error: 'error',
  punches_already_counted: 'info',
  punches_not_wiped: 'warning',
  card_not_wiped: 'warning',
  card_full: 'warning',
};

/**
 * Build the user-facing message + type for a non-ok punch result.
 *
 * `overrideText` - a per-scenario UI string (from the editor's "UI text strings"
 * section) that, when non-empty, replaces the default localized status text.
 *
 * `fallbackMsg` is the technical detail the punch logic produced. For an
 * unknown status it IS the message; for the generic `error` status it is
 * appended to the message (retours #6): "une erreur est survenue" told the
 * operator nothing actionable, so the actual cause - unreadable game data,
 * failed write, unreachable mother - is now shown with it. Player-facing
 * statuses (empty card, cheat, already finished) stay clean.
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
  let text = teamName && !authorPlacedName ? `${teamName} - ${base}` : base;
  const detail = fallbackMsg?.trim();
  if ((status === 'error' || status === 'no_station_match') && detail && !text.includes(detail)) {
    text = `${text} — ${detail}`;
  }
  return { text, type };
}
