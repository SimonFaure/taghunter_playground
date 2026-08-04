// TagQuest quest-image lookups.
//
// `game_media_images` has had two shapes over the app's life:
//   - legacy (pre scenarios-refactor): an array of `{ id, file_name }` rows,
//     straight out of game_media_images.csv;
//   - current: a field→filename map, spliced back in by the studio's
//     playground.php from the structured `scenarios.medias` column (and an
//     empty JS object when the scenario has no media at all).
//
// Scenarios synced before the refactor still carry the array form on disk, so
// both have to keep resolving. Returns id/field → bare filename.
export function buildMediaMap(
  raw: unknown,
  stripMedia: (name: string) => string,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || typeof raw !== 'object') return map;

  if (Array.isArray(raw)) {
    for (const row of raw as Array<{ id?: unknown; file_name?: unknown }>) {
      if (typeof row?.file_name === 'string') {
        map.set(String(row.id), stripMedia(row.file_name));
      }
    }
    return map;
  }

  for (const [field, fileName] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof fileName === 'string') map.set(field, stripMedia(fileName));
  }
  return map;
}
