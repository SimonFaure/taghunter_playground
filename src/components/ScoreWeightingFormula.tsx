import { useTranslation } from 'react-i18next';

/**
 * TagQuest "weight scores by number of players": the exact formula applied by
 * services/tagquestScoring (effectifWeights + weightedScore), spelled out under
 * the option in the launch modal and the in-game config modal.
 */
export function ScoreWeightingFormula({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      className={`rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] bg-[var(--pg-surface-2)] px-3 py-2 text-xs text-[var(--pg-text-dim)] space-y-1 ${className}`}
    >
      <div className="font-mono text-[var(--pg-text-muted)]">{t('launchModal:scoreWeightingFormulaScore')}</div>
      <div className="font-mono text-[var(--pg-text-muted)]">{t('launchModal:scoreWeightingFormulaWeight')}</div>
      <div>{t('launchModal:scoreWeightingFormulaExample')}</div>
      <div>{t('launchModal:scoreWeightingFormulaNotes')}</div>
    </div>
  );
}
