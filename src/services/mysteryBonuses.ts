/**
 * Mystery bonus ("overscore" / "surscore") tiers.
 *
 * A scenario can author reward tiers ABOVE `score_full_game`: each tier carries
 * a name + image and unlocks once the team's score passes
 * `score_full_game + <authored extra>`. The authored figure is the OVERSHOOT,
 * not an absolute score - the legacy engine has always compared
 * `current_score >= overscore_step_N + full_score`, and the shipped scenarios
 * line up with that (e.g. full = 30, tiers 10…90, 12 enigmas x 10 pts = 120 max,
 * so the top tier lands exactly on a perfect run).
 *
 * Two on-disk shapes reach the playground and both are handled here:
 *   - legacy / flat: `overscore_steps` (count) plus `overscore_step_N` (the
 *     extra points) / `name_overscore_step_N` / `image_overscore_step_N` keys
 *     sitting directly on `game_meta`.
 *   - studio array: `game_meta.overscores[] = { overscore_step (1-based tier
 *     index), overscore_score (the extra points), name_overscore_step,
 *     image_overscore_step }`. `cleanGameMetaForData` strips the image on save
 *     and parks it in the `medias` column; playground.php splices it back.
 */

export interface MysteryBonusTier {
  /** 1-based tier index (the authored "Étape" / "Step"). */
  index: number;
  /** Absolute score at which this tier unlocks (`score_full_game` + extra). */
  threshold: number;
  /** Authored tier name in the requested language. May be empty. */
  name: string;
  /** Media filename / id for the tier image. May be empty. */
  image: string;
}

/** Per-language translations envelope slice this module cares about. */
export type MysteryBonusTranslations = Record<
  string,
  { overscores?: Array<{ name_overscore_step?: string } | null> } | undefined
>;

type MetaBag = Record<string, unknown>;

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

/** Parse an authored numeric field. NaN on blank/garbage so callers can skip. */
function num(v: unknown): number {
  const s = str(v).trim();
  if (s === '') return NaN;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Build the bonus tier list for a mystery scenario, lowest threshold first.
 *
 * `language` picks the tier names out of the `translations` envelope when the
 * scenario ships one (same path the level name/description take); it falls back
 * to the flattened default-language name otherwise.
 */
export function resolveMysteryBonuses(
  gameMeta: MetaBag | null | undefined,
  scoreFullGame: number,
  translations?: MysteryBonusTranslations | null,
  language?: string,
): MysteryBonusTier[] {
  if (!gameMeta) return [];
  const full = Number.isFinite(scoreFullGame) ? scoreFullGame : 0;
  const localized = language ? translations?.[language]?.overscores : undefined;
  // Both shapes are ordered, so the translations envelope lines up positionally.
  const localizedName = (pos: number) => str(localized?.[pos]?.name_overscore_step).trim();

  const tiers: MysteryBonusTier[] = [];

  const authored = gameMeta.overscores;
  if (Array.isArray(authored) && authored.length > 0) {
    authored.forEach((raw, pos) => {
      const o = (raw ?? {}) as MetaBag;
      // `overscore_step` is the tier INDEX; the points live in `overscore_score`.
      const extra = num(o.overscore_score);
      if (!Number.isFinite(extra)) return;
      const image = str(o.image_overscore_step).trim();
      const name = localizedName(pos) || str(o.name_overscore_step).trim();
      // A tier with neither image nor name has nothing to show.
      if (!image && !name) return;
      tiers.push({
        index: num(o.overscore_step) || pos + 1,
        threshold: full + extra,
        name,
        image,
      });
    });
  } else {
    // Flat shape. `overscore_steps` bounds the scan on purpose: shipped
    // scenarios keep junk rows past the count (one has `overscore_step_7 = '0'`
    // left over from an older edit), and an unbounded scan would turn those
    // into a tier that unlocks the instant a team hits the maximum.
    const count = num(gameMeta.overscore_steps);
    if (!Number.isFinite(count) || count <= 0) return tiers;
    for (let i = 1; i <= count; i++) {
      const extra = num(gameMeta[`overscore_step_${i}`]);
      if (!Number.isFinite(extra)) continue;
      const image = str(gameMeta[`image_overscore_step_${i}`]).trim();
      const name = localizedName(i - 1) || str(gameMeta[`name_overscore_step_${i}`]).trim();
      if (!image && !name) continue;
      tiers.push({ index: i, threshold: full + extra, name, image });
    }
  }

  return tiers.sort((a, b) => a.threshold - b.threshold);
}

/** The tiers a given score has unlocked, lowest first. */
export function reachedMysteryBonuses(
  tiers: readonly MysteryBonusTier[],
  score: number,
): MysteryBonusTier[] {
  return tiers.filter((t) => score >= t.threshold);
}
