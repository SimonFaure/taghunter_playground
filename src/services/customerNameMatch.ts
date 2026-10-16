// "Similar customer name" detection, to warn before creating a duplicate
// ("Acme" vs "ACME SA"). Two byte-identical copies - keep them in step:
// studio-taghunter/src/lib/customerNameMatch.ts and
// taghunter_playground/src/services/customerNameMatch.ts.

const LEGAL_SUFFIXES = new Set([
  'sa', 'sas', 'sasu', 'sarl', 'eurl', 'sci', 'scop', 'inc', 'ltd', 'llc', 'gmbh', 'sl', 'srl', 'bv',
]);

export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_SUFFIXES.has(w))
    .join(' ');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** True when `a` and `b` probably name the same customer. */
export function isSimilarName(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  return Math.min(na.length, nb.length) >= 5 && levenshtein(na, nb) <= 2;
}

/** The entries of `list` whose name looks like `name` (at most `max`). */
export function findSimilar<T extends { name: string }>(name: string, list: T[], max = 3): T[] {
  return list.filter((c) => isSimilarName(name, c.name)).slice(0, max);
}
