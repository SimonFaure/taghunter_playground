// SQLite `CURRENT_TIMESTAMP` / Rust `Utc::now().format("%Y-%m-%d %H:%M:%S")`
// produce UTC strings WITHOUT a timezone marker. `new Date("2026-09-25 07:49:53")`
// reads such a string as LOCAL time, so every screen that fed one straight to
// Date showed UTC ("Créée : 07:49" for a game launched at 09:49, retours sept.
// #23). Everything that displays or compares a DB timestamp goes through here.

/** Epoch ms for a DB timestamp (UTC without marker, or any ISO string), or NaN. */
export function parseDbTs(ts: string | null | undefined): number {
  if (ts == null || ts === '') return NaN;
  const s = String(ts).trim();
  // Already carries a timezone (cloud ISO, JS toISOString) - parse as-is.
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  // Bare "YYYY-MM-DD HH:MM:SS[.fff]" or "YYYY-MM-DDTHH:MM:SS" → UTC.
  if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s)) return Date.parse(s.replace(' ', 'T') + 'Z');
  return Date.parse(s);
}

/** `Date` for a DB timestamp, or null when unparseable. */
export function dbDate(ts: string | null | undefined): Date | null {
  const t = parseDbTs(ts);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Epoch SECONDS for a DB timestamp, or NaN. */
export function dbEpochSeconds(ts: string | null | undefined): number {
  const t = parseDbTs(ts);
  return Number.isNaN(t) ? NaN : Math.floor(t / 1000);
}

/** Local date + time ("25/09/2026 09:49:53" in fr). Falls back to the raw string. */
export function formatDbDateTime(ts: string | null | undefined, locale?: string): string {
  if (!ts) return '';
  const d = dbDate(ts);
  return d ? d.toLocaleString(locale) : String(ts);
}

/** Local time only ("09:49:53"). Falls back to the raw string. */
export function formatDbTime(ts: string | null | undefined, locale?: string): string {
  if (!ts) return '';
  const d = dbDate(ts);
  return d ? d.toLocaleTimeString(locale) : String(ts);
}

/** Local date only. Falls back to the raw string. */
export function formatDbDate(ts: string | null | undefined, locale?: string): string {
  if (!ts) return '';
  const d = dbDate(ts);
  return d ? d.toLocaleDateString(locale) : String(ts);
}
