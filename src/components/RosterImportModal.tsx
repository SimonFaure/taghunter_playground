// Preview + confirm gate shared by the team import (LaunchGameModal step 2) and
// the Clash clan-assignment import. Shows what matched, what was skipped (with
// reasons), and any clan capacity warnings, behind an explicit Apply/Cancel so
// the destructive roster replace is deliberate.
//
// Design: project_playground_team_import_excel_csv.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { RosterImportResult, SkipReason, ImportedEntry } from '../services/rosterImport';

export interface ClanCapacityWarning {
  clan: string;
  max: number;
  count: number;
}

interface RosterImportModalProps {
  isOpen: boolean;
  result: RosterImportResult | null;
  capacityWarnings?: ClanCapacityWarning[];
  onApply: () => void;
  onCancel: () => void;
  overlayZIndex?: number;
}

const REASON_KEY: Record<SkipReason, string> = {
  'unknown-chip': 'launchModal:importReasonUnknownChip',
  'duplicate-chip': 'launchModal:importReasonDuplicateChip',
  'chip-in-use': 'launchModal:importReasonChipInUse',
  'missing-name': 'launchModal:importReasonMissingName',
  'missing-chip-ref': 'launchModal:importReasonMissingChipRef',
  'id-number-mismatch': 'launchModal:importReasonIdNumberMismatch',
  'unknown-clan': 'launchModal:importReasonUnknownClan',
  'missing-clan': 'launchModal:importReasonMissingClan',
};

/** Group entries by their `group` label (team name / clan), preserving order. */
function groupEntries(entries: ImportedEntry[]): { label: string; members: ImportedEntry[] }[] {
  const order: string[] = [];
  const map = new Map<string, ImportedEntry[]>();
  for (const e of entries) {
    const label = e.group ?? '';
    if (!map.has(label)) {
      map.set(label, []);
      order.push(label);
    }
    map.get(label)!.push(e);
  }
  return order.map((label) => ({ label, members: map.get(label)! }));
}

export function RosterImportModal({
  isOpen,
  result,
  capacityWarnings = [],
  onApply,
  onCancel,
  overlayZIndex = 60,
}: RosterImportModalProps) {
  const { t } = useTranslation();

  const grouped = useMemo(
    () => (result && result.mode !== 'single' ? groupEntries(result.entries) : null),
    [result],
  );

  if (!isOpen || !result) return null;

  const { mode, entries, skipped } = result;
  const matched = entries.length;
  const title = mode === 'clan' ? t('launchModal:importClanPreviewTitle') : t('launchModal:importPreviewTitle');

  const matchedSummary =
    mode === 'clan'
      ? t('launchModal:importMatchedChips', { count: matched })
      : mode === 'team'
        ? t('launchModal:importMatchedTeams', { count: grouped?.length ?? 0 })
        : t('launchModal:importMatchedTeams', { count: matched });

  return (
    <div className="pg-overlay" style={{ zIndex: overlayZIndex }}>
      <div className="pg-modal max-w-2xl w-full animate-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-[var(--pg-line)]">
          <h3 className="text-lg font-semibold text-[var(--pg-text)]">{title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1.5 text-[var(--pg-accent-bright)]">
              <CheckCircle2 size={16} /> {matchedSummary}
            </span>
            {skipped.length > 0 && (
              <span className="inline-flex items-center gap-1.5 text-amber-400">
                <AlertTriangle size={16} /> {t('launchModal:importSkippedRows', { count: skipped.length })}
              </span>
            )}
          </div>
          {mode !== 'clan' && (
            <p className="mt-1 text-xs text-[var(--pg-text-dim)]">{t('launchModal:importReplaceWarning')}</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {matched === 0 && (
            <p className="text-sm text-amber-400">{t('launchModal:importNothingMatched')}</p>
          )}

          {/* Clan capacity warnings (Clash) */}
          {capacityWarnings.length > 0 && (
            <div className="rounded-[var(--pg-radius-md)] border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
              {capacityWarnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-300 flex items-start gap-1.5">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <span>{t('launchModal:importClanOverCapacity', { clan: w.clan, max: w.max, count: w.count })}</span>
                </p>
              ))}
            </div>
          )}

          {/* Matched - grouped for team/clan, flat for single */}
          {grouped ? (
            <div className="space-y-2">
              {grouped.map((g, i) => (
                <div key={i} className="rounded-[var(--pg-radius-md)] bg-[var(--pg-surface-2)] p-3">
                  <div className="text-sm font-semibold text-[var(--pg-text)] mb-1">
                    {mode === 'clan' ? t('launchModal:importColClan') : t('launchModal:importColTeam')}: {g.label}
                    <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">({g.members.length})</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.members.map((m) => (
                      <span key={m.chip.id} className="text-xs px-2 py-0.5 rounded bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)]">
                        #{m.chip.key_number} · {m.name}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            matched > 0 && (
              <div className="rounded-[var(--pg-radius-md)] bg-[var(--pg-surface-2)] divide-y divide-[var(--pg-line)]">
                {entries.map((e) => (
                  <div key={e.chip.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="text-xs text-[var(--pg-text-dim)] w-16 flex-shrink-0">#{e.chip.key_number}</span>
                    <span className="text-[var(--pg-text)]">{e.name}</span>
                  </div>
                ))}
              </div>
            )
          )}

          {/* Skipped rows */}
          {skipped.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--pg-text-dim)] mb-1.5">
                {t('launchModal:importSkippedRows', { count: skipped.length })}
              </div>
              <div className="rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] divide-y divide-[var(--pg-line)]">
                {skipped.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 px-3 py-2 text-xs">
                    <XCircle size={14} className="mt-0.5 flex-shrink-0 text-red-400/80" />
                    <span className="text-[var(--pg-text-dim)] w-16 flex-shrink-0">
                      {t('launchModal:importRowLabel', { row: s.rowIndex })}
                    </span>
                    <span className="text-[var(--pg-text-muted)]">{t(REASON_KEY[s.reason])}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--pg-line)] bg-[var(--pg-surface)]">
          <button type="button" onClick={onCancel} className="pg-btn">
            {t('launchModal:cancel')}
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={matched === 0}
            className="pg-btn pg-btn--primary disabled:opacity-50"
          >
            {t('launchModal:importApply')}
          </button>
        </div>
      </div>
    </div>
  );
}
