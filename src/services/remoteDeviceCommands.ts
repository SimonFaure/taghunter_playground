// Device-level commands the operator sends from the Devices modals, run on this
// device: sound mute (`set_mute`), SI reader refresh / test beep
// (`reader_refresh` / `reader_beep`) and app restart (`restart_app`). The mute
// state rides in the upkeep report so the modal shows it.

import { registerLanCommandHandler, type CommandResult } from './lanCommands';
import { isSoundMuted, setSoundMuted, SOUND_MUTE_EVENT } from '../utils/soundMute';
import { setMutedReport } from './upkeepState';
import { sportidentService } from './sportidentService';
import { isGameRunningHere } from './updateService';
import { relaunchToApply } from './appRelaunch';
import { motherNow } from './motherTime';

/** A restart command older than this sat in the queue too long: dropped. */
const RESTART_MAX_AGE_MS = 120_000;
/** Refuse a restart this soon after start: a redelivered one (ack lost before
 *  the relaunch) must not restart the device in a loop. */
const RESTART_MIN_UPTIME_MS = 60_000;

async function restartApp(payload: { force?: boolean; sent_at?: number }): Promise<CommandResult> {
  if (performance.now() < RESTART_MIN_UPTIME_MS) return { ok: false, error: 'just_started' };
  if (typeof payload.sent_at === 'number' && motherNow() - payload.sent_at > RESTART_MAX_AGE_MS) {
    return { ok: false, error: 'stale' };
  }
  if (payload.force !== true && (await isGameRunningHere())) return { ok: false, error: 'game_running' };
  return { ok: true, afterAck: () => void relaunchToApply(300) };
}

/** Install once from the App. Returns the uninstall. */
export function installRemoteDeviceCommands(): () => void {
  const onMute = () => setMutedReport(isSoundMuted());
  onMute();
  window.addEventListener(SOUND_MUTE_EVENT, onMute);
  const offs = [
    registerLanCommandHandler('set_mute', (cmd) => {
      setSoundMuted(cmd.payload?.muted === true);
      return { ok: true };
    }),
    registerLanCommandHandler('reader_refresh', async () => {
      const ok = await sportidentService.refresh();
      return ok ? { ok: true, detail: 'reader_ok' } : { ok: false, error: 'no_reader' };
    }),
    registerLanCommandHandler('reader_beep', async () => {
      const r = await sportidentService.testBeep();
      if (r.result === 'ok') return { ok: true };
      // "code: detail" - the modal shows the reader's own error after the text.
      return { ok: false, error: r.detail ? `${r.result}: ${r.detail}`.slice(0, 300) : r.result };
    }),
    registerLanCommandHandler('restart_app', (cmd) => restartApp(cmd.payload ?? {})),
  ];
  return () => {
    window.removeEventListener(SOUND_MUTE_EVENT, onMute);
    for (const off of offs) off();
  };
}
