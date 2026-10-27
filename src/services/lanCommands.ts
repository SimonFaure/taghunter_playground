// One listener for the mother's pushed commands (`taghunter://lan-command`,
// relayed by `client_ping_mother`, or emitted in-process when a command targets
// the mother itself). Each kind has one handler, registered by whoever owns the
// behaviour (App for navigation, OperatorVideoOverlay for videos, deviceUpkeep
// for sync/update, the simulator executor...). Once the handler has run, the
// command is acked on the mother that sent it WITH its result
// (`client_ack_command`), so the operator who queued it can read back what
// happened (`launched_games.php?action=command_status`). Until then the mother
// redelivers it; the Rust-side CommandLedger keeps it from running twice.
//
// Main window only (main.tsx): every webview receives the event, and a second
// bus would ack `no_handler` on the projector's behalf.

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

export interface LanCommand<P = Record<string, unknown>> {
  /** Queue row id on the mother; 0 = dispatched in-process (nothing to ack). */
  id: number;
  kind: string;
  payload: P;
  mother_uuid?: string;
  mother_addr?: string;
  /** Our OWN server dispatched it (this device hosts the game) - there is no
   *  remote mother to repoint at. Also set by `runLocalCommand`. */
  local?: boolean;
}

/** What a handler reports. `afterAck` runs once the ack went out (restart). */
export type CommandResult =
  | { ok: true; detail?: string; afterAck?: () => void }
  | { ok: false; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LanCommandHandler = (cmd: LanCommand<any>) => Promise<CommandResult | void> | CommandResult | void;

const handlers = new Map<string, LanCommandHandler>();

/** A kind arriving before its handler registered (boot) waits this long. */
const HANDLER_WAIT_MS = 5_000;
/** A handler still running after this is acked `timeout` (it keeps running). */
const HANDLER_TIMEOUT_MS = 20_000;

/** Own a command kind. Returns the unregister (a no-op once replaced). */
export function registerLanCommandHandler(kind: string, handler: LanCommandHandler): () => void {
  handlers.set(kind, handler);
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

async function waitForHandler(kind: string): Promise<LanCommandHandler | undefined> {
  const deadline = Date.now() + HANDLER_WAIT_MS;
  while (!handlers.has(kind) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return handlers.get(kind);
}

async function run(cmd: LanCommand): Promise<CommandResult> {
  const handler = handlers.get(cmd.kind) ?? (await waitForHandler(cmd.kind));
  if (!handler) return { ok: false, error: 'no_handler' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CommandResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), HANDLER_TIMEOUT_MS);
  });
  try {
    const work = Promise.resolve(handler(cmd)).then((r): CommandResult => r ?? { ok: true });
    return await Promise.race([work, timeout]);
  } catch (err) {
    console.error(`[lanCommands] ${cmd.kind} handler threw:`, err);
    return { ok: false, error: 'failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ack(cmd: LanCommand, result: CommandResult): Promise<void> {
  if (!cmd.id || cmd.local || !cmd.mother_uuid) return;
  const wire = result.ok
    ? { ok: true, ...(result.detail ? { detail: result.detail } : {}) }
    : { ok: false, error: result.error };
  try {
    await invoke('client_ack_command', {
      motherUuid: cmd.mother_uuid,
      motherAddr: cmd.mother_addr ?? null,
      commandId: cmd.id,
      result: wire,
    });
  } catch (err) {
    // The ledger re-acks it on the next delivery.
    console.warn('[lanCommands] ack failed:', err);
  }
}

async function dispatch(cmd: LanCommand): Promise<CommandResult> {
  const result = await run(cmd);
  if (!result.ok && result.error !== 'no_handler') {
    console.warn(`[lanCommands] ${cmd.kind} #${cmd.id}: ${result.error}`);
  }
  await ack(cmd, result);
  if (result.ok && result.afterAck) {
    try {
      result.afterAck();
    } catch (err) {
      console.error('[lanCommands] afterAck threw:', err);
    }
  }
  return result;
}

/**
 * Run a command on THIS device the way a pushed one would run (the Devices
 * modals' own row). Resolves with the handler's result.
 */
export function runLocalCommand(kind: string, payload: Record<string, unknown> = {}): Promise<CommandResult> {
  return dispatch({ id: 0, kind, payload, local: true });
}

let installed = false;

/** Main window, once, before the first ping. */
export function installLanCommandBus(): void {
  if (installed) return;
  installed = true;
  void listen<LanCommand>('taghunter://lan-command', (event) => {
    const cmd = event.payload;
    if (!cmd || typeof cmd.kind !== 'string') return;
    cmd.payload = cmd.payload ?? {};
    void dispatch(cmd);
  });
}
