// Opens (or focuses) the game simulator control window for a launched game.
// Tester builds only - callers gate on IS_TESTER_BUILD.

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const LABEL = 'simulator';

export async function openSimulatorWindow(launchedGameId: number): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    // One control window per device: switch it to this game.
    await existing.close();
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  new WebviewWindow(LABEL, {
    url: `/index.html?simulator=${launchedGameId}`,
    title: `Game simulator - #${launchedGameId}`,
    width: 900,
    height: 760,
    focus: true,
  });
}
