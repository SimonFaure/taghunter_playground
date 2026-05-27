import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

// Stable import point for the help system. The kit + content under _generated/ are
// produced by `node scripts/help.mjs --app playground` (runs at predev/prebuild).
//   import { HelpProvider, DocsShell, HelpDot, HelpButton } from '../help';
export * from './_generated/kit';

// Playground shows the bundled PDF in a dedicated webview window (WebView2's built-in
// PDF viewer) — fully offline, no Tauri resource bundling required. Single-instance.
// (Follow-up: bundle the PDF as a Tauri resource and open the OS default viewer via the
// opener plugin if a true external viewer is preferred.)
export async function playgroundOpenPdf(pdf: string): Promise<void> {
  const label = 'help-pdf';
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  // eslint-disable-next-line no-new
  new WebviewWindow(label, {
    url: `/${pdf}`,
    title: 'Taghunter — Help (PDF)',
    width: 900,
    height: 1000,
    focus: true,
  });
}
