// Render-side decoder for the mother-failover error codes.
//
// The failover services (`lanMotherBoot`) throw i18n KEYS - `failover:errXxx` -
// rather than English prose, so the "Take back control?" prompt that greets an
// operator at startup speaks their language (Retours Ludiom #75).
//
// The Rust commands behind them still fail with technical English ("contacting
// current mother: error sending request for url (http://…/ping.php)", "adopt
// snapshot: UNIQUE constraint failed: …"). Those used to reach the operator
// verbatim (retours sept. #24). `describeFailoverError` now maps the known
// shapes to a plain-French sentence that says what to do, and keeps the raw
// text as a separate `detail` for a collapsible "Détails techniques" block.
//
// Deliberately narrow: only `failover:` + a bare identifier is treated as a key.
// Passing an arbitrary message to i18next's `t()` would let a colon inside a
// real error ("open sqlite (C:\...): disk full") be parsed as a namespace.

import type { TFunction } from 'i18next';

const CODE_RE = /^failover:[A-Za-z][A-Za-z0-9_]*$/;

// Raw-message fragments → the key that explains them. First match wins.
const PATTERNS: Array<[RegExp, string]> = [
  [/contacting current mother|error sending request|connection refused|timed out|operation timed out/i, 'failover:errMotherUnreachable'],
  [/stale_snapshot/, 'failover:errStaleSnapshot'],
  [/No cached snapshot/i, 'failover:errNoSnapshot'],
  [/hasn't downloaded the scenario/i, 'failover:errScenarioMissing'],
  [/UNIQUE constraint|adopt snapshot|FOREIGN KEY constraint/i, 'failover:errAdoptFailed'],
  [/bind mother listener|address already in use|only one usage of each socket/i, 'failover:errPortBusy'],
  [/no Wi-Fi credentials/i, 'failover:errNoWifiCreds'],
  [/hotspot|tethering|access point/i, 'failover:errHotspot'],
  [/HTTP 401|HTTP 403|no credentials to authenticate/i, 'failover:errNotAuthorized'],
];

export interface DescribedError {
  /** One sentence in the operator's language, saying what to do. */
  message: string;
  /** The raw technical text, for the collapsible details (null when the
   *  message already IS the whole story, i.e. a thrown i18n key). */
  detail: string | null;
}

function rawMessage(err: unknown): string {
  return String((err as { message?: string } | undefined)?.message ?? err ?? '');
}

/** Human message + raw detail for any error caught on a failover/network path. */
export function describeFailoverError(err: unknown, t: TFunction): DescribedError {
  const raw = rawMessage(err);
  if (CODE_RE.test(raw)) return { message: t(raw), detail: null };
  const hit = PATTERNS.find(([re]) => re.test(raw));
  return { message: t(hit ? hit[1] : 'failover:errGeneric'), detail: raw || null };
}

/** Message only (legacy callers that render a single line). */
export function failoverErrorText(err: unknown, t: TFunction): string {
  return describeFailoverError(err, t).message;
}
