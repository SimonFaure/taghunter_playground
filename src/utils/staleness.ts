import { parseDbTs } from './dbTime';

/** "last seen" wording for a paired device's `last_seen_at` (devicesModal keys). */
export function formatStaleness(
  iso: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!iso) return t('devicesModal:stalenessNever');
  // The server returns 'YYYY-MM-DD HH:MM:SS' in UTC; parse with a trailing 'Z'.
  const parsed = parseDbTs(iso);
  if (Number.isNaN(parsed)) return t('devicesModal:stalenessNever');
  const diff = Date.now() - parsed;
  if (diff < 60_000) return t('devicesModal:stalenessJustNow');
  if (diff < 3_600_000) return t('devicesModal:stalenessMinutes', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('devicesModal:stalenessHours', { n: Math.floor(diff / 3_600_000) });
  return t('devicesModal:stalenessDays', { n: Math.floor(diff / 86_400_000) });
}
