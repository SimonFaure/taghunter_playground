import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Building2, Plus, X } from 'lucide-react';
import { createCustomer, type CustomersSnapshot, type LanCustomer } from '../../services/customersStore';
import { findSimilar, normalizeName } from '../../services/customerNameMatch';

export interface CustomerValue {
  id: string;
  name: string;
}

// Searchable licensee-customer picker with inline quick-create (name only,
// works offline: the mother is on the LAN). Warns before creating a likely
// duplicate. project_licensee_customers.
export function CustomerCombobox({ snapshot, value, onChange, disabled, autoFocus }: {
  snapshot: CustomersSnapshot;
  value: CustomerValue | null;
  onChange: (v: CustomerValue | null) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('customers');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [similar, setSimilar] = useState<LanCustomer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSimilar(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = useMemo(() => snapshot.customers.filter((c) => !c.archived), [snapshot.customers]);
  const q = query.trim();
  const matches = useMemo(() => {
    const nq = normalizeName(q);
    const list = nq ? active.filter((c) => normalizeName(c.name).includes(nq) || (c.city ?? '').toLowerCase().includes(q.toLowerCase())) : active;
    return list.slice(0, 50);
  }, [active, q]);
  const exact = q !== '' && active.some((c) => c.name.trim().toLowerCase() === q.toLowerCase());

  const pick = (c: CustomerValue | null) => {
    onChange(c);
    setQuery('');
    setOpen(false);
    setSimilar(null);
  };

  const create = async (force: boolean) => {
    if (!q) return;
    if (!force) {
      const s = findSimilar(q, active);
      if (s.length > 0) {
        setSimilar(s);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const c = await createCustomer(q);
      pick({ id: c.id, name: c.name });
    } catch (err) {
      console.error('[customers] create failed:', err);
      setError(t('createFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (value && !open) {
    return (
      // inline-flex, like a bare <input>: same spacing under a .pg-label (a
      // block here would collapse the label's margin and sit 6px higher).
      <div className="pg-input inline-flex items-center gap-2 !py-0" style={{ minHeight: 40 }}>
        <Building2 size={16} className="text-[var(--pg-text-dim)] shrink-0" />
        <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="flex-1 text-left truncate">
          {value.name}
        </button>
        {!disabled && (
          <button type="button" onClick={() => pick(null)} title={t('clear')} aria-label={t('clear')}
            className="text-[var(--pg-text-dim)] hover:text-[var(--pg-text)]">
            <X size={16} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative inline-block w-full">
      <input
        type="text"
        className="pg-input"
        value={query}
        disabled={disabled || busy}
        autoFocus={autoFocus || open}
        placeholder={value ? value.name : t('search')}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setSimilar(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); setQuery(''); }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (matches.length > 0 && q) pick({ id: matches[0].id, name: matches[0].name });
            else if (q && !exact) void create(false);
          }
        }}
      />
      {open && (
        <div className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] bg-[var(--pg-surface)] text-[var(--pg-text)] shadow-xl">
          {similar ? (
            <div className="p-3 space-y-2 text-sm">
              <div className="flex items-center gap-2 text-amber-400"><AlertTriangle size={16} />{t('similarTitle')}</div>
              {similar.map((s) => (
                <button key={s.id} type="button" onClick={() => pick({ id: s.id, name: s.name })}
                  className="block w-full text-left px-3 py-2 rounded hover:bg-[var(--pg-surface-2)]">
                  {t('useExisting', { name: s.name })}{s.city ? ` (${s.city})` : ''}
                </button>
              ))}
              <button type="button" onClick={() => void create(true)} disabled={busy}
                className="pg-btn pg-btn--sm pg-btn--ghost">
                {t('createAnyway')}
              </button>
            </div>
          ) : (
            <>
              {!q && (
                <button type="button" onClick={() => pick(null)}
                  className="block w-full text-left px-3 py-2 text-sm text-[var(--pg-text-dim)] hover:bg-[var(--pg-surface-2)]">
                  {t('none')}
                </button>
              )}
              {matches.map((c) => (
                <button key={c.id} type="button" onClick={() => pick({ id: c.id, name: c.name })}
                  className={`block w-full text-left px-3 py-2 text-sm hover:bg-[var(--pg-surface-2)] ${value?.id === c.id ? 'font-semibold' : ''}`}>
                  {c.name}{c.city ? <span className="text-[var(--pg-text-dim)]"> · {c.city}</span> : null}
                </button>
              ))}
              {q && !exact && (
                <button type="button" onClick={() => void create(false)} disabled={busy}
                  className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-[var(--pg-accent)] hover:bg-[var(--pg-surface-2)] border-t border-[var(--pg-line)]">
                  <Plus size={14} />{t('newOption', { name: q })}
                </button>
              )}
            </>
          )}
          {error && <div className="px-3 py-2 text-sm text-red-400">{error}</div>}
        </div>
      )}
    </div>
  );
}
