// Render-side decoder for the mother-failover error codes.
//
// The failover services (`lanMotherBoot`) throw i18n KEYS - `failover:errXxx` -
// rather than English prose, so the "Take back control?" prompt that greets an
// operator at startup speaks their language (Retours Ludiom #75). Anything else
// that reaches here is an unexpected/transport failure whose raw text IS the
// diagnostic, so it passes through untouched.
//
// Deliberately narrow: only `failover:` + a bare identifier is treated as a key.
// Passing an arbitrary message to i18next's `t()` would let a colon inside a
// real error ("open sqlite (C:\...): disk full") be parsed as a namespace.

import type { TFunction } from 'i18next';

const CODE_RE = /^failover:[A-Za-z][A-Za-z0-9_]*$/;

/** Message from a caught failover error, in the operator's language. */
export function failoverErrorText(err: unknown, t: TFunction): string {
  const msg = String((err as { message?: string } | undefined)?.message ?? err ?? '');
  return CODE_RE.test(msg) ? t(msg) : msg;
}
