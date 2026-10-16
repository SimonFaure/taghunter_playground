// Virtual chips for the game simulator (tester builds only).
//
// They are a deterministic ID range, NOT rows in the `cards` table: the cards
// sync would otherwise push them to studio (pending rows) or reconcile them
// away (synced rows). Every device recognises them from the ID alone, so no
// sync is needed in multi-device simulations.
//
// 900 000 000+ sits above the SI 24-bit card-number space (max 16 777 215),
// so it can never collide with a real chip (SI10 cards use 7 000 001+).

import type { CardRow } from './cardsRepo';

export const SIM_CHIP_BASE = 900_000_000;
export const SIM_CHIP_MAX_COUNT = 1_000_000;

/** True in dev and Tester-channel builds (the build sets VITE_QA_HARNESS=1). */
export const IS_TESTER_BUILD =
  import.meta.env.DEV || import.meta.env.VITE_QA_HARNESS === '1';

export function isSimChipId(id: number): boolean {
  return IS_TESTER_BUILD && id > SIM_CHIP_BASE && id <= SIM_CHIP_BASE + SIM_CHIP_MAX_COUNT;
}

/** Virtual chip N (1-based) -> card row, shaped like a `cards` row. */
export function simChip(n: number): CardRow {
  return {
    id: SIM_CHIP_BASE + n,
    key_number: n,
    key_name: `SIM ${n}`,
    color: null,
  };
}

export function simChipRow(id: number): CardRow | null {
  return isSimChipId(id) ? simChip(id - SIM_CHIP_BASE) : null;
}

/** The first `count` virtual chips. */
export function simChipPool(count: number): CardRow[] {
  return Array.from({ length: count }, (_, i) => simChip(i + 1));
}
