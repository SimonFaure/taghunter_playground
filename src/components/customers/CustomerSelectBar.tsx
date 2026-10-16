import { useTranslation } from 'react-i18next';
import { Building2 } from 'lucide-react';
import type { CustomersSnapshot } from '../../services/customersStore';
import { setSelectedCustomer, useSelectedCustomer } from '../../services/selectedCustomerStore';
import { CustomerCombobox } from './CustomerCombobox';

// Above the scenario list: "Game for <customer>". Picking one marks the
// scenarios that customer already played and pre-fills the launch wizard.
// Hidden when the LAN / studio does not support customers yet.
export function CustomerSelectBar({ snapshot }: { snapshot: CustomersSnapshot }) {
  const { t } = useTranslation('customers');
  const selected = useSelectedCustomer();
  if (!snapshot.supported) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 mb-3">
      <span className="inline-flex items-center gap-2 text-sm font-medium text-[var(--pg-text-muted)]">
        <Building2 size={16} />
        {t('selectBarLabel')}
      </span>
      <div className="w-full sm:w-80">
        <CustomerCombobox snapshot={snapshot} value={selected} onChange={setSelectedCustomer} />
      </div>
      {!selected && <span className="text-xs text-[var(--pg-text-dim)]">{t('selectBarHint')}</span>}
    </div>
  );
}
