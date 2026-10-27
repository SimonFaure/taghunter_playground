// Shared bits of the operator's remote device actions (top-bar Devices modal,
// per-game Devices modal): send a queued command and read back what the target
// answered once its handler ran, and the operator-facing text of those answers.

import type { TFunction } from 'i18next';
import {
  waitForCommandResults,
  type QueueCommandBulkResp,
} from '../services/launchedGames';

/**
 * Queue a command for one or more devices and wait (up to ~20 s) for each
 * target's answer. Resolves target id -> error code, or null when it ran (or
 * hasn't answered yet: an offline device runs it on its next ping). A refusal
 * at queue time (target_outdated, target_not_in_game...) comes back the same
 * way. Throws only when the mother itself can't be reached.
 */
export async function sendRemote(
  call: () => Promise<QueueCommandBulkResp>,
): Promise<Map<number, string | null>> {
  const res = await call();
  const out = new Map<number, string | null>();
  const pending: Array<{ target: number; id: number }> = [];
  for (const r of res.results) {
    if (r.error) out.set(r.target_device_id, r.error);
    else if (r.command_id && r.command_id > 0) pending.push({ target: r.target_device_id, id: r.command_id });
    else out.set(r.target_device_id, null);
  }
  if (pending.length > 0) {
    const outcomes = await waitForCommandResults(
      pending.map((p) => p.id),
      { timeoutMs: 20_000 },
    );
    for (const p of pending) {
      const o = outcomes.get(p.id);
      out.set(p.target, o?.state === 'failed' ? o.error : null);
    }
  }
  return out;
}

// Error codes from the mother (queue time) and from the targets (their
// handler's answer) that have their own wording; anything else shows as is.
const KNOWN_ERRORS = new Set([
  'target_outdated',
  'target_not_in_game',
  'target_operator_only',
  'already_in_game',
  'already_started',
  'game_ended',
  'game_running',
  'no_reader',
  'not_listening',
  'not_registering',
  'nothing_to_reset',
  'operator_only',
  'just_started',
  'stale',
  'timeout',
  'renderer_timeout',
  'no_handler',
  'no_videos',
  'game_unreachable',
]);

/** `code` may carry a detail after ": " (the reader's own error). */
export function commandErrorText(t: TFunction, code: string): string {
  const sep = code.indexOf(': ');
  const head = sep > 0 ? code.slice(0, sep) : code;
  const detail = sep > 0 ? code.slice(sep + 2) : '';
  if (!KNOWN_ERRORS.has(head)) return code || t('fleet:errorFailed');
  const text = t(`fleet:cmdError.${head}`);
  return detail ? `${text} (${detail})` : text;
}
