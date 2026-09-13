// Shared display-label helpers. These transform the *display* string only -
// the underlying game-type slug / `game_meta.game_public` value is left intact
// so matching logic (launch resolve, icon lookup, filters) keeps working.

/**
 * Display label for a game type. The canonical slugs stay as they are; only the
 * user-facing names are normalised - `tracks` reads "Track" (singular), and
 * `tagquest` reads "Quest" (the mode's actual name - there is no "Tag" in front
 * of it). Everything else passes through unchanged. Accepts a slug or a
 * display name.
 */
export function gameTypeLabel(name: string | null | undefined): string {
  const v = (name || '').trim();
  const k = v.toLowerCase();
  if (k === 'tracks' || k === 'track') return 'Track';
  if (k === 'tagquest' || k === 'tag quest' || k === 'quest') return 'Quest';
  return v;
}

/**
 * Collapse legacy / mislabelled audience values onto the canonical trio
 * (mirrors studio's src/types/audience.ts, stored as `game_meta.game_public`).
 */
export function normalizeAudience(raw: string | null | undefined): string {
  const v = (raw || '').toLowerCase();
  if (['adults', 'adult', 'adultes', 'teens', 'ado'].includes(v)) return 'ado_adultes';
  return v;
}

/**
 * i18n key (under the `home` namespace) for a normalized audience value, or
 * null for an off-list value - callers fall back to a title-cased raw string.
 */
export function audienceLabelKey(raw: string | null | undefined): string | null {
  switch (normalizeAudience(raw)) {
    case 'mini_kids':
      return 'audienceMiniKids';
    case 'kids':
      return 'audienceKids';
    case 'ado_adultes':
      return 'audienceAdoAdultes';
    default:
      return null;
  }
}

/** Title-case fallback for an off-list audience slug ("foo_bar" → "Foo Bar"). */
export function titleCaseSlug(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
