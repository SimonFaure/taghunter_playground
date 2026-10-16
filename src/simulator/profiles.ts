// Seeded randomness + behaviour profiles for the game simulator.

import type { ProfileId } from './types';

export type Rng = () => number;

/** mulberry32: small, fast, deterministic per seed. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
export const chance = (rng: Rng, p: number) => rng() < p;

export interface Profile {
  id: ProfileId;
  /** Fraction of the game time limit the team takes (above 1 = late). */
  pace: [number, number];
  /** Probability of punching the GOOD answer of an enigma. */
  accuracy: number;
  /** Probability of skipping an enigma entirely (no punch). */
  skip: number;
  /** Probability of each chaos behaviour (double read, stale card, abandon...). */
  chaos: number;
}

export const PROFILES: Record<ProfileId, Profile> = {
  fast: { id: 'fast', pace: [0.45, 0.7], accuracy: 0.9, skip: 0.02, chaos: 0 },
  average: { id: 'average', pace: [0.7, 0.95], accuracy: 0.7, skip: 0.08, chaos: 0.02 },
  slow: { id: 'slow', pace: [0.9, 1.25], accuracy: 0.5, skip: 0.2, chaos: 0.05 },
  chaotic: { id: 'chaotic', pace: [0.5, 1.4], accuracy: 0.45, skip: 0.15, chaos: 0.6 },
};

export function pickProfile(rng: Rng, mix: Record<ProfileId, number>): Profile {
  const entries = (Object.keys(PROFILES) as ProfileId[]).map((id) => [id, Math.max(0, mix[id] ?? 0)] as const);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return PROFILES.average;
  let r = rng() * total;
  for (const [id, w] of entries) {
    r -= w;
    if (r < 0) return PROFILES[id];
  }
  return PROFILES.average;
}

/** SI time-of-day string for a virtual epoch ms (local time, like a station clock). */
export function hms(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** SI card family for a chip number (the reader reports it; cosmetic here). */
export function cardTypeFor(cardId: number): string {
  if (cardId >= 7_000_001 && cardId <= 7_999_999) return 'SI10';
  if (cardId >= 8_000_001 && cardId <= 9_999_999) return 'SI11';
  if (cardId >= 2_000_001 && cardId <= 2_999_999) return 'SI8';
  if (cardId >= 1_000_001 && cardId <= 1_999_999) return 'SI9';
  return 'SI10';
}

// Fake first names for mock players (mixed FR/EN, short so the field view stays compact).
const FIRST_NAMES = [
  'Léa', 'Tom', 'Emma', 'Hugo', 'Chloé', 'Louis', 'Inès', 'Jules', 'Manon', 'Nathan',
  'Zoé', 'Lucas', 'Jade', 'Gabriel', 'Lina', 'Arthur', 'Sarah', 'Noah', 'Camille', 'Adam',
  'Alice', 'Ethan', 'Rose', 'Paul', 'Anna', 'Max', 'Eva', 'Sam', 'Lou', 'Théo',
  'Mia', 'Leo', 'Nina', 'Oscar', 'Clara', 'Victor', 'Iris', 'Malo', 'Lola', 'Raphaël',
];

/** 2-5 distinct fake first names. */
export function pickPlayers(rng: Rng, min = 2, max = 5): string[] {
  const n = min + Math.floor(rng() * (max - min + 1));
  const pool = [...FIRST_NAMES];
  const out: string[] = [];
  for (let i = 0; i < n && pool.length; i++) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return out;
}
