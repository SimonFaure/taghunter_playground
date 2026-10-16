import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { assignCustomer } from '../../services/customersStore';
import { CustomerCombobox, type CustomerValue } from './CustomerCombobox';
import { useCustomers } from './useCustomers';

// Set / change the customer of a game after launch - running, ended or
// archived (by summary_uuid, so it works once the game rows are gone).
export function AssignCustomerModal({ summaryUuid, gameId, gameName, current, onClose, onSaved }: {
  summaryUuid?: string;
  gameId?: number;
  gameName: string;
  current: CustomerValue | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation('customers');
  const { snapshot } = useCustomers();
  const [value, setValue] = useState<CustomerValue | null>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await assignCustomer({ summaryUuid, gameId, customerId: value?.id ?? null, customerName: value?.name ?? null });
      onSaved?.();
      onClose();
    } catch (err) {
      console.error('[customers] assign failed:', err);
      setError(t('assignFailed'));
      setBusy(false);
    }
  };

  return (
    <div className="pg-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md bg-[var(--pg-bg)] rounded-[var(--pg-radius-lg)] shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-[var(--pg-line)]">
          <div className="min-w-0">
            <h2 className="pg-modal-title text-xl">{t('assignTitle')}</h2>
            <p className="text-sm text-[var(--pg-text-dim)] truncate">{gameName}</p>
          </div>
          <button type="button" onClick={onClose} className="pg-modal-close"><X size={22} /></button>
        </div>
        <div className="p-5 space-y-3">
          {snapshot.supported ? (
            <CustomerCombobox snapshot={snapshot} value={value} onChange={setValue} />
          ) : (
            <p className="text-sm text-[var(--pg-text-dim)]">{t('unsupportedMother')}</p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-3 p-5 border-t border-[var(--pg-line)]">
          <button type="button" onClick={onClose} className="pg-btn pg-btn--ghost">{t('cancel')}</button>
          <button type="button" onClick={() => void save()} disabled={busy || !snapshot.supported || value?.id === current?.id}
            className="pg-btn pg-btn--primary">
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  );
}
