// Age bands - the fine-grained audience taxonomy authored in studio
// (`game_meta.audience_bands`), mirroring studio's src/types/audience.ts.
//
// The coarse trio (mini_kids / kids / ado_adultes, stored as
// `game_meta.game_public`) stays the keying for the team-name pools; it is NOT
// what the operator filters on any more. The station UI shows the same six
// ranges as the studio catalog so a scenario labelled "8-10" reads the same
// everywhere (project_ludiom_retours_go_spot, retour 22).

export type AudienceBand =
  | 'age_4_5'
  | 'age_6_7'
  | 'age_8_10'
  | 'age_11_12'
  | 'age_13_plus'
  | 'age_adultes';

/** The six bands, youngest → oldest, with their name-pool tier. */
export const AUDIENCE_BANDS: { value: AudienceBand; label: string; tier: string }[] = [
  { value: 'age_4_5', label: '4-5', tier: 'mini_kids' },
  { value: 'age_6_7', label: '6-7', tier: 'mini_kids' },
  { value: 'age_8_10', label: '8-10', tier: 'kids' },
  { value: 'age_11_12', label: '11-12', tier: 'kids' },
  { value: 'age_13_plus', label: '+13', tier: 'ado_adultes' },
  { value: 'age_adultes', label: 'Adultes', tier: 'ado_adultes' },
];

const BAND_ORDER = AUDIENCE_BANDS.map((b) => b.value);
const BAND_SET = new Set<string>(BAND_ORDER);

/** Keep only known bands, de-duplicated, in canonical young→old order. */
export function normalizeBands(raw: unknown): AudienceBand[] {
  if (!Array.isArray(raw)) return [];
  const present = new Set(raw.filter((v): v is string => typeof v === 'string' && BAND_SET.has(v)));
  return BAND_ORDER.filter((b) => present.has(b));
}

/**
 * Read-side fallback for scenarios that only carry the legacy `game_public`
 * tier (un-backfilled rows / legacy ZIP imports) - mirrors studio's
 * deriveBandsFromTier so a pill still matches something.
 */
export function bandsFromTier(tier: string | null | undefined): AudienceBand[] {
  switch ((tier || '').toLowerCase()) {
    case 'mini_kids':
      return ['age_4_5', 'age_6_7'];
    case 'kids':
      return ['age_8_10', 'age_11_12'];
    case 'ado_adultes':
      return ['age_13_plus', 'age_adultes'];
    default:
      return [];
  }
}

/** Stored bands when present, else synthesized from the legacy tier. */
export function resolveBands(bands: unknown, tier: string | null | undefined): AudienceBand[] {
  const stored = normalizeBands(bands);
  return stored.length > 0 ? stored : bandsFromTier(tier);
}

/**
 * Display label for a band. The numeric ranges are language-neutral; only
 * "Adultes" needs translating, via the `home:bandAdults` key.
 */
export function bandLabel(band: AudienceBand, t?: (key: string) => string): string {
  if (band === 'age_adultes') return t ? t('home:bandAdults') : 'Adultes';
  return AUDIENCE_BANDS.find((b) => b.value === band)?.label ?? band;
}
