/**
 * Mystery enigma scoring helpers.
 *
 * Wrong-answer points are AUTHORED SIGNED in the studio, exactly like the two
 * game-level maluses (`malus_both_answers_biped` / `malus_no_answer`): the
 * author types `-5` and the enigma is worth -5. Scenarios authored before that
 * convention stored the bare magnitude (`"5"` meaning "-5 points"), and both
 * shapes are still in the field (already-synced games keep their game-data.json
 * as it was), so a positive value is read as a penalty of the same size.
 *
 * Every mystery scoring site goes through here, so the two shapes can never
 * drift apart between the runtime board, the Team Details recompute and the
 * test harnesses.
 */

/**
 * Signed points a wrong answer contributes: always <= 0, whichever way the
 * scenario was authored. Add it to the score - never subtract it.
 */
export function wrongAnswerPoints(raw: string | number | null | undefined): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n === 0) return 0;
  return -Math.abs(n);
}
