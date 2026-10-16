// In-memory ring of the last console.warn / console.error lines since the app
// started. Attached to licensee bug reports (services/bugReport.ts): most of
// the app's diagnostics ([sync], [lan], [telemetry]…) are console lines that
// never become telemetry errors, so without this a report carries none of them.
//
// Memory only, per window - it does not survive a restart. Lines are scrubbed
// with the telemetry scrubber (JWTs, bearer tokens, home-dir user names).

import { scrubPii } from './telemetry';

export interface ConsoleLine {
  /** ISO timestamp. */
  t: string;
  level: 'warn' | 'error';
  msg: string;
}

const MAX_LINES = 300;
const MAX_LINE_CHARS = 2000;

const lines: ConsoleLine[] = [];
let installed = false;

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) {
    const firstFrame = a.stack?.split('\n').find((l) => l.trim().startsWith('at '))?.trim();
    return `${a.name}: ${a.message}${firstFrame ? ` (${firstFrame})` : ''}`;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function push(level: ConsoleLine['level'], args: unknown[]): void {
  try {
    let msg = args.map(formatArg).join(' ');
    if (msg.length > MAX_LINE_CHARS) msg = msg.slice(0, MAX_LINE_CHARS) + '…';
    lines.push({ t: new Date().toISOString(), level, msg: scrubPii(msg) });
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  } catch {
    /* the buffer must never break logging */
  }
}

/** Wrap console.warn / console.error. Idempotent. */
export function installConsoleBuffer(): void {
  if (installed) return;
  installed = true;
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    push('warn', args);
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    push('error', args);
    origError(...args);
  };
}

/** Oldest first. */
export function getConsoleLines(): ConsoleLine[] {
  return lines.slice();
}
