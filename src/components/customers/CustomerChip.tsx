import { useTranslation } from 'react-i18next';
import { Building2 } from 'lucide-react';

/** A game's customer (or "Customer…" when none) - click to set / change it. */
export function CustomerChip({ name, onClick }: { name: string | null; onClick: () => void }) {
  const { t } = useTranslation('customers');
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`mt-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs border transition ${
        name
          ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)] text-[var(--pg-text)]'
          : 'border-dashed border-[var(--pg-line-strong)] text-[var(--pg-text-dim)] hover:text-[var(--pg-text)]'
      }`}
      title={t('assignTitle')}
    >
      <Building2 size={12} />
      {name || t('setClient')}
    </button>
  );
}
