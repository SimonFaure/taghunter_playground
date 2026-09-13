/**
 * Clash event-feed vocabulary, shared by every surface that narrates the match.
 *
 * Extracted from `ClashGameRenderer` on 2026-09-07 when the ranking page grew
 * its own feed (retours #95): the sentence rules (scenario-authored override,
 * `%CLAN%` / `%TERRITORY%` tokens, clan name in the clan colour) must read the
 * same wherever they appear. The studio LayoutEditor keeps its own `sentence()`
 * mock - that one lives in a `@ts-nocheck` file in the other repo and has to be
 * kept in step by hand.
 *
 * Every string here resolves against the LAUNCH language (bucket 2), not the
 * operator's chrome language: these are the words players read.
 */

import type { ClashEvent } from '../services/clash';

export type ClashT = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Scenario-authored event-banner sentences (retours #56). Empty ⇒ the app's
 * translated default. `%CLAN%` and `%TERRITORY%` are substituted at render.
 */
export interface ClashEventTexts {
  conquest?: string;
  attack?: string;
  neutralized?: string;
  purge?: string;
  rankingTitle?: string;
}

/** Read a Localized<string> map (or plain string) at the given language. */
export function pickLocalized(
  v: Record<string, string> | string | undefined,
  lang: string,
): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v[lang] || Object.values(v)[0] || '';
}

/** "à l'instant" / "il y a 4 min" / "il y a 2 h" for an event timestamp. */
export function relativeAge(atMs: number, nowMs: number, t: ClashT): string {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 60) return t('age_just_now');
  const m = Math.floor(s / 60);
  if (m < 60) return t('age_minutes', { n: m });
  const h = Math.floor(m / 60);
  return t('age_hours', { n: h });
}

/**
 * The built-in sentence minus the clan name - the name is rendered separately
 * in the clan's colour, the rest in the default text colour.
 */
export function eventPredicate(kind: ClashEvent['kind'], terr: string, t: ClashT): string {
  switch (kind) {
    case 'conquest':
      return t('event_conquest', { territory: terr });
    case 'attack':
      return t('event_attack', { territory: terr });
    case 'neutralized':
      return t('event_neutralized', { territory: terr });
    case 'purge':
      return t('purge_announcement', { territory: terr });
    default:
      return t('event_other', { territory: terr });
  }
}

/** Scenario override for one event kind, '' when the author left it blank. */
export function authoredEventText(kind: ClashEvent['kind'], texts?: ClashEventTexts): string {
  switch (kind) {
    case 'conquest':
      return texts?.conquest ?? '';
    case 'attack':
      return texts?.attack ?? '';
    case 'neutralized':
      return texts?.neutralized ?? '';
    case 'purge':
      return texts?.purge ?? '';
    default:
      return '';
  }
}

/** One run of an event sentence; `clan` runs are drawn in the clan's colour. */
export interface EventRun {
  text: string;
  clan: boolean;
}

/**
 * Split an authored sentence (retours #56) into coloured / plain runs.
 *
 * `%CLAN%` marks where the clan name goes (drawn in the clan's colour);
 * `%TERRITORY%` is substituted inline. A sentence with no `%CLAN%` keeps the
 * default wording's shape - clan name first, then the sentence - so a partly
 * filled field never loses the actor. Both tokens are case-insensitive, and
 * `%TEAM%` is accepted as an alias of `%CLAN%` (it is the token used elsewhere
 * in the studio).
 */
export function renderEventSentence(
  authored: string,
  clanName: string,
  territory: string,
): EventRun[] {
  const withTerritory = authored.replace(/%TERRITORY%/gi, territory);
  const parts = withTerritory.split(/%CLAN%|%TEAM%/gi);
  if (parts.length === 1) {
    // No clan token - prepend the name like the built-in sentences do.
    return [
      { text: clanName, clan: true },
      { text: ` ${withTerritory}`, clan: false },
    ];
  }
  const runs: EventRun[] = [];
  parts.forEach((chunk, i) => {
    if (i > 0) runs.push({ text: clanName, clan: true });
    if (chunk) runs.push({ text: chunk, clan: false });
  });
  return runs;
}

/**
 * The full run list for one event: the scenario-authored sentence when the
 * author filled that kind in, else the built-in "<clan> <predicate>" shape.
 */
export function eventRuns(
  ev: ClashEvent,
  clanName: string,
  territory: string,
  texts: ClashEventTexts | undefined,
  t: ClashT,
): EventRun[] {
  const authored = authoredEventText(ev.kind, texts);
  if (authored) return renderEventSentence(authored, clanName, territory);
  return [
    { text: clanName, clan: true },
    { text: ` ${eventPredicate(ev.kind, territory, t)}`, clan: false },
  ];
}

/** Stable per-event React key - lets existing rows keep their DOM. */
export function eventKey(ev: ClashEvent): string {
  return `${ev.kind}-${ev.team_id}-${ev.territory_index}-${ev.at}`;
}
