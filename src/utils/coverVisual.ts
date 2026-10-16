// Scenario cover visual, per licensee language.
//
// The cover comes in two versions: `game_visual` is the French one, and the
// studio author can add `game_visual_intl`, shown for every other language.
// Both are in `game_media_images` (and `game_meta`, where the studio splices
// the same image fields). The one to show follows the LICENSEE's account
// language (`auth_user.language`), not the device's UI language; with no
// "other languages" version everyone gets `game_visual`.
export function pickGameVisual(images: unknown, lang: string | null | undefined): string | null {
  if (!images || typeof images !== 'object' || Array.isArray(images)) return null;
  const map = images as Record<string, unknown>;
  const localized = lang && lang !== 'fr' ? map.game_visual_intl : null;
  if (typeof localized === 'string' && localized.trim()) return localized;
  const fallback = map.game_visual;
  return typeof fallback === 'string' && fallback.trim() ? fallback : null;
}
