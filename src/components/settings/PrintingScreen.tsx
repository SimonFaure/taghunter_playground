// Settings → App → Printing. Informational since the pre-print modal took over
// the paper/orientation choice: shows the default print format in effect (and
// where it comes from: operator choice / studio-synced / built-in), the synced
// report-layouts version, and a scaled preview of each game type's report PDF.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';
import {
  getPrintPrefsInfo,
  cssPageSize,
  type PrintPrefsSource,
} from '../../services/printPrefsStore';
import {
  defaultReportLayout,
  STAT_FIELDS_BY_TYPE,
  type ReportGameType,
  type ReportLayout,
} from '../../services/reportLayout';
import { getSyncedLayout, getState as getReportLayoutsState } from '../../services/reportLayoutsStore';
import { buildReportDocument, resolveReportLogoUrl } from '../../services/reportPrint';
import type { ReportData } from '../../services/reportStats';

const GAME_TYPES = Object.keys(STAT_FIELDS_BY_TYPE) as ReportGameType[];

// Brand names, not translated (mirrors the studio editor tabs).
const GAME_TYPE_LABELS: Record<ReportGameType, string> = {
  mystery: 'Mystery',
  tracks: 'Track',
  tagquest: 'Tagquest',
  clash: 'Clash',
};

// Plausible demo values per stat field id, shared across game types.
const SAMPLE_STATS: Record<string, string | number> = {
  rate: '75 %', success: 6, fail: 2, absent: 0,
  correct: 6, wrong: 1, missing: 1,
  quests: 12, points: 1250, level: 3, combos: 4,
  territories: 5,
};

function sampleData(type: ReportGameType, layout: ReportLayout, teamName: string, reportTitle: string): ReportData {
  const stats: Record<string, number | string> = {};
  for (const f of STAT_FIELDS_BY_TYPE[type]) stats[f] = SAMPLE_STATS[f] ?? 0;
  const d = new Date();
  return {
    teamId: 0,
    teamNumber: 1,
    gameTitle: GAME_TYPE_LABELS[type],
    pdfTitle: layout.pdfTitle || reportTitle,
    teamTitleLabel: layout.teamTitle || '',
    teamName,
    dateText: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`,
    durationSeconds: 3155,
    score: 1250,
    rank: 1,
    totalTeams: 8,
    language: '',
    stats,
  };
}

export function PrintingScreen() {
  const { t } = useTranslation();
  const [info] = useState(() => getPrintPrefsInfo());
  const [layoutsVersion, setLayoutsVersion] = useState<number | null>(null);
  const [previews, setPreviews] = useState<Array<{ type: ReportGameType; html: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await getReportLayoutsState();
        if (!cancelled) setLayoutsVersion(state?.local_version ?? null);
      } catch {
        /* store unavailable → built-in defaults note */
      }
      try {
        const logoUrl = await resolveReportLogoUrl();
        const docs: Array<{ type: ReportGameType; html: string }> = [];
        for (const type of GAME_TYPES) {
          const layout = (await getSyncedLayout(type).catch(() => null)) ?? defaultReportLayout(type);
          const data = sampleData(type, layout, t('printing:sampleTeamName'), t('printing:sampleReportTitle'));
          docs.push({ type, html: buildReportDocument(layout, [data], logoUrl) });
        }
        if (!cancelled) setPreviews(docs);
      } catch (err) {
        console.error('[PrintingScreen] preview build failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  const { prefs, source } = info;
  const sourceLabel: Record<PrintPrefsSource, string> = {
    synced: t('printing:source_synced'),
    builtin: t('printing:source_builtin'),
  };

  // Scaled page preview dimensions: page size in CSS px (96dpi), shrunk to a card.
  const [wMm, hMm] = cssPageSize(prefs).split(' ').map((s) => parseFloat(s));
  const pxPerMm = 96 / 25.4;
  const pageW = wMm * pxPerMm;
  const pageH = hMm * pxPerMm;
  const targetW = 230;
  const scale = targetW / pageW;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-[var(--pg-text)] flex items-center gap-2">
        <Printer size={22} /> {t('settings:navPrinting')}
      </h1>
      <p className="text-sm text-[var(--pg-text-dim)]">{t('printing:intro')}</p>

      {/* Default format in effect + where it comes from */}
      <div className="pg-panel p-6 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="pg-label">{t('printing:defaultFormatTitle')}</span>
          <span className="text-xs px-2 py-1 rounded-full bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)]">
            {sourceLabel[source]}
          </span>
        </div>
        <p className="text-lg text-[var(--pg-text)]">
          {t(`printing:paper_${prefs.paper}`)}
          {prefs.paper === 'custom' && ` (${prefs.customMm.width} × ${prefs.customMm.height} mm)`}
          {' · '}
          {t(`printing:orientation_${prefs.orientation}`)}
        </p>
        <p className="text-xs text-[var(--pg-text-dim)]">{t('printing:pageSizePreview', { size: cssPageSize(prefs) })}</p>
        <p className="text-xs text-[var(--pg-text-dim)]">{t('printing:formatInModalNote')}</p>
      </div>

      {/* Synced report-layouts version */}
      <div className="pg-panel p-6 space-y-1">
        <span className="pg-label">{t('printing:layoutsVersionTitle')}</span>
        <p className="text-sm text-[var(--pg-text)]">
          {layoutsVersion !== null
            ? t('printing:layoutsVersionValue', { version: layoutsVersion })
            : t('printing:layoutsVersionBuiltin')}
        </p>
      </div>

      {/* One scaled PDF preview per game type */}
      <div className="space-y-3">
        <span className="pg-label">{t('printing:previewsTitle')}</span>
        <div className="flex flex-wrap gap-4">
          {previews.map(({ type, html }) => (
            <div key={type} className="space-y-1.5">
              <p className="text-sm font-medium text-[var(--pg-text)]">{GAME_TYPE_LABELS[type]}</p>
              <div
                className="overflow-hidden rounded-lg border border-[var(--pg-line)] bg-white"
                style={{ width: targetW, height: Math.round(pageH * scale) }}
              >
                <iframe
                  title={`report-preview-${type}`}
                  srcDoc={html}
                  style={{
                    width: pageW,
                    height: pageH,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    border: 0,
                    pointerEvents: 'none',
                  }}
                />
              </div>
            </div>
          ))}
          {!previews.length && (
            <p className="text-sm text-[var(--pg-text-dim)]">{t('printing:previewsLoading')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
