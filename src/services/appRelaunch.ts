// Role changes are applied by relaunching Playground (retours sept. #5/#16):
// the boot path is the one place that consistently derives the server, mDNS
// announcement and routing from the saved settings. Hot
// re-application left a demoted device still hosting its copy of the game
// ("the game shows twice everywhere until Playground is restarted").

import { relaunch } from '@tauri-apps/plugin-process';

/** Relaunch after a short pause so the operator can read the outcome line. */
export async function relaunchToApply(delayMs = 1500): Promise<void> {
  await new Promise((r) => setTimeout(r, delayMs));
  try {
    await relaunch();
  } catch (e) {
    console.error('[appRelaunch] relaunch failed - the change applies at next start:', e);
  }
}
