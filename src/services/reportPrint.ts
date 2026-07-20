/**
 * Mission-report print engine: layout + ReportData → print HTML → OS dialog.
 *
 * Renders the report into a hidden <iframe> in the main window and calls
 * `iframe.contentWindow.print()`. Fully offline, no PDF dependency - the
 * operator picks a printer or "Save as PDF" in the native dialog. The `@page`
 * size comes from Settings → Printing (printPrefsStore).
 *
 * Batch print = one document, one team per page (`page-break-after`).
 *
 * Plan: `team-mission-report-printing.md`.
 */

import i18n from '../i18n';
import type { ReportLayout, ReportBlock } from './reportLayout';
import type { ReportData } from './reportStats';
import { cssPageSize, getPrintPrefs, type PrintPrefs } from './printPrefsStore';
import { catalogFontFaceCss } from '../fonts/registerCatalogFonts';
import { getAuthUser } from './authStore';

// Reports print on white paper: use the black-wordmark logo variant (the app
// chrome's /taghunter-logo.png is white-on-dark and vanishes on paper).
const LOGO_URL = `${window.location.origin}/taghunter-logo-black.png`;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** Inline style for a block from its style props. */
function blockStyle(block: ReportBlock, layout: ReportLayout): string {
  const parts = [
    `font-family:'${(block.font || layout.font).replace(/'/g, '')}',serif`,
    `text-align:${block.align ?? 'center'}`,
  ];
  if (block.size) parts.push(`font-size:${block.size}px`);
  if (block.color) parts.push(`color:${block.color}`);
  if (block.bold) parts.push('font-weight:bold');
  return parts.join(';');
}

/** CSS `justify-content` value for a row block's distribution. */
function justifyCss(j: ReportBlock['justify']): string {
  return j === 'start' ? 'flex-start' : j === 'end' ? 'flex-end' : j === 'between' ? 'space-between' : 'center';
}

/** Inline style for a `frame` container box. Shrink-wraps its content
 *  (inline-block) so the wrapper's text-align can center/position it. */
function frameStyle(block: ReportBlock): string {
  const parts = ['box-sizing:border-box', 'display:inline-block', `padding:${block.padding ?? 12}px`];
  if (block.bordered !== false) parts.push(`border:1px solid ${block.borderColor ?? '#333333'}`);
  if (block.bgColor) parts.push(`background:${block.bgColor}`);
  if (block.radius) parts.push(`border-radius:${block.radius}px`);
  return parts.join(';');
}

/** Format a team's duration via the report `durationFormat` key. */
function formatDuration(seconds: number | null, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '-';
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return t('durationFormat', { m, s });
}

/**
 * Resolve a standard label: an admin-typed override on the layout (printed
 * verbatim in every language) wins; otherwise the built-in `report` i18n label
 * in the team's language.
 */
function pickLabel(layout: ReportLayout, key: string, t: (k: string) => string): string {
  const override = layout.labels?.[key];
  return override && override.trim() ? override : t(key);
}

function statCell(id: string, data: ReportData, layout: ReportLayout, t: (k: string) => string): string {
  const raw = data.stats[id];
  const value = raw === undefined || raw === null || raw === '' ? '-' : raw;
  return `<td style="padding:0 10px;text-align:center;vertical-align:top">
    <div style="font-weight:bold">${esc(pickLabel(layout, `stat_${id}`, t))}</div>
    <div>${esc(value)}</div>
  </td>`;
}

function renderBlock(block: ReportBlock, data: ReportData, layout: ReportLayout, t: (k: string, o?: Record<string, unknown>) => string, logoUrl: string): string {
  if (!block.show) return '';
  const style = blockStyle(block, layout);
  switch (block.type) {
    case 'logo':
      return `<div style="text-align:${block.align ?? 'center'};margin:6px 0"><img src="${logoUrl}" style="width:${block.logoSize ?? 110}px;max-width:80%" alt=""/></div>`;
    case 'game_title':
      return `<div style="${style};margin:4px 0">${esc(data.gameTitle)}</div>`;
    case 'pdf_title':
      return `<div style="${style};margin:2px 0">${esc(data.pdfTitle)}</div>`;
    case 'team_name':
      return `<div style="${style};margin:8px 0">
        ${data.teamTitleLabel ? `<div style="font-weight:bold;font-size:0.7em">${esc(data.teamTitleLabel)}</div>` : ''}
        <div>${esc(data.teamName)}</div>
      </div>`;
    case 'date':
      return `<div style="${style};margin:6px 0">
        <div style="font-weight:bold;font-size:0.75em">${esc(pickLabel(layout, 'date', t))}</div>
        <div>${esc(data.dateText)}</div>
      </div>`;
    case 'duration':
      return `<div style="${style};margin:6px 0">
        <div style="font-weight:bold;font-size:0.8em">${esc(pickLabel(layout, 'duration', t))}</div>
        <div>${esc(formatDuration(data.durationSeconds, t))}</div>
      </div>`;
    case 'score':
      return `<div style="${style};margin:6px 0">
        <div style="font-weight:bold;font-size:0.8em">${esc(pickLabel(layout, 'score', t))}</div>
        <div>${esc(data.score)}</div>
      </div>`;
    case 'rank':
      return `<div style="${style};margin:6px 0">
        <div style="font-weight:bold;font-size:0.8em">${esc(pickLabel(layout, 'rank', t))}</div>
        <div>${esc(t('rankValue', { rank: data.rank, total: data.totalTeams }))}</div>
      </div>`;
    case 'stat_grid': {
      const fields = block.fields ?? [];
      if (!fields.length) return '';
      const cells = fields.map((f) => statCell(f, data, layout, t)).join('');
      return `<div style="text-align:${block.align ?? 'center'};margin:8px 0"><table style="${style};display:inline-table;border-collapse:collapse"><tr>${cells}</tr></table></div>`;
    }
    case 'text':
      return block.text ? `<div style="${style};margin:6px 0">${esc(block.text)}</div>` : '';
    case 'divider':
      return `<hr style="border:none;border-top:${block.thickness ?? 1}px solid ${block.color ?? '#cccccc'};width:${block.width ?? 70}%;margin:10px auto"/>`;
    case 'spacer':
      return `<div style="height:${block.height ?? 16}px"></div>`;
    case 'row': {
      const kids = (block.children ?? []).map((c) => renderBlock(c, data, layout, t, logoUrl)).filter(Boolean);
      if (!kids.length) return '';
      return `<div style="display:flex;flex-wrap:wrap;align-items:flex-start;width:100%;margin:6px 0;justify-content:${justifyCss(block.justify)};gap:${block.gap ?? 16}px">${kids.map((k) => `<div>${k}</div>`).join('')}</div>`;
    }
    case 'frame': {
      const kids = (block.children ?? []).map((c) => renderBlock(c, data, layout, t, logoUrl)).join('');
      return kids ? `<div style="text-align:center;margin:10px 0"><div style="${frameStyle(block)}">${kids}</div></div>` : '';
    }
    default:
      return '';
  }
}

/** One team's page (without the page-break wrapper). */
function renderTeamPage(layout: ReportLayout, data: ReportData, logoUrl: string): string {
  // Resolve labels in the TEAM's language (fallback to the chrome language).
  const lang = data.language || i18n.language;
  const t = i18n.getFixedT(lang, 'report') as (k: string, o?: Record<string, unknown>) => string;
  const inner = layout.blocks.map((b) => renderBlock(b, data, layout, t, logoUrl)).join('\n');
  return `<section class="report-page">${inner}</section>`;
}

/**
 * Build a complete, self-contained print document for the given teams.
 * `logoUrl` overrides the bundled TagHunter logo - the client's cached brand
 * image (a data: URL) when "use my logo on reports" is on. `prefs` is the
 * operator's PrePrintModal choice; omitted ⇒ the synced/built-in default.
 *
 * Only Chromium's "Save as PDF" destination honours the `@page` size; every
 * real/virtual printer driver (Microsoft Print to PDF, OneNote, …) imposes its
 * own paper. So the report content is laid out at its FIXED physical size in mm
 * - on matching paper it fills the page, on larger paper it prints at correct
 * scale in the top-left corner instead of stretching to fill.
 */
export function buildReportDocument(layout: ReportLayout, teams: ReportData[], logoUrl: string = LOGO_URL, prefs?: PrintPrefs): string {
  const pageSize = cssPageSize(prefs ?? getPrintPrefs());
  // "100mm 150mm" → oriented page dimensions; content = page minus @page margins.
  const [pageWmm, pageHmm] = pageSize.split(' ').map((s) => parseFloat(s));
  const marginMm = 5;
  const contentWmm = pageWmm - 2 * marginMm;
  const contentHmm = pageHmm - 2 * marginMm;
  const bg = layout.background.mode === 'color' && layout.background.color ? layout.background.color : '#ffffff';
  const pages = teams.map((d) => renderTeamPage(layout, d, logoUrl)).join('\n');
  const fontFaces = catalogFontFaceCss(window.location.origin);
  // The background paints on .report-page (not body) so it covers exactly the
  // report's area on oversized paper; print-color-adjust keeps it in the output.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
  ${fontFaces}
  @page { size: ${pageSize}; margin: ${marginMm}mm; }
  html,body { margin:0; padding:0; }
  body { font-family:'${layout.font.replace(/'/g, '')}',serif; background:#ffffff; }
  .report-page {
    box-sizing:border-box; width:${contentWmm}mm; min-height:${contentHmm}mm; padding:6mm 4mm;
    background:${bg};
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
    text-transform:uppercase; page-break-after:always;
  }
  .report-page:last-child { page-break-after:auto; }
  table { width:auto; }
</style></head><body>${pages}</body></html>`;
}

/**
 * Render HTML into a hidden iframe and invoke the OS print dialog. Resolves
 * after the dialog is dismissed (best-effort) and the iframe is cleaned up.
 */
export function printHtmlDocument(html: string): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    // Off-screen but with REAL, non-zero dimensions. A `0×0` / `visibility:hidden`
    // iframe fails to lay out in WebView2/Chromium, so its content and `@page`
    // size are not honoured - the dialog opens on an empty / wrong-sized page.
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0';
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      // Delay removal so the print job can read the document on some platforms.
      setTimeout(() => { iframe.parentNode?.removeChild(iframe); resolve(); }, 1000);
    };
    iframe.onload = () => {
      const win = iframe.contentWindow;
      // Appending the iframe fires a `load` for its initial `about:blank`
      // document BEFORE the `srcdoc` report arrives. Ignore that load - printing
      // it opens an empty dialog (with the main window's title/URL in the print
      // header). Only print once the real report is actually in the iframe DOM.
      if (!win || !win.document.querySelector('.report-page')) return;
      try {
        win.addEventListener('afterprint', cleanup, { once: true });
        win.focus();
        win.print();
      } catch (err) {
        console.error('[reportPrint] print failed:', err);
        cleanup();
      }
      // Fallback in case afterprint never fires (some WebView2 builds).
      setTimeout(cleanup, 60000);
    };
    document.body.appendChild(iframe);
    iframe.srcdoc = html;
  });
}

/**
 * The logo reports should carry: the client's cached brand image (a data: URL)
 * when "use my logo on reports" is on, else the bundled TagHunter logo. Shared
 * by printing and the Settings → Printing previews so both match.
 */
export async function resolveReportLogoUrl(): Promise<string> {
  try {
    const user = await getAuthUser();
    if (user?.report_use_brand_logo && user.brand_logo_data) {
      return user.brand_logo_data;
    }
  } catch {
    // Non-fatal: fall back to the bundled logo.
  }
  return LOGO_URL;
}

/** Convenience: build + print in one call. */
export async function printReports(layout: ReportLayout, teams: ReportData[], prefs?: PrintPrefs): Promise<void> {
  if (!teams.length) return;
  const logoUrl = await resolveReportLogoUrl();
  await printHtmlDocument(buildReportDocument(layout, teams, logoUrl, prefs));
}
