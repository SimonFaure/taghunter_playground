import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Building2, ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import { createCustomer, resolveCustomerId } from '../../services/customersStore';
import { findSimilar, normalizeName } from '../../services/customerNameMatch';
import * as scenarioStore from '../../services/scenarioStore';
import { useCustomers } from '../customers/useCustomers';

// Settings > Clients: the licensee's customers as the LAN sees them (the
// mother's list, synced from studio) with what each already played.
// Read-mostly: a quick-create like the launch wizard's; details, merge and
// archive are edited in studio. project_licensee_customers.

function fmtDay(s: string | null, lang: string): string | null {
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(lang);
}

interface Played {
  uniqid: string;
  count: number;
  last: string | null;
}

export function CustomersScreen() {
  const { t, i18n } = useTranslation('customers');
  const { snapshot } = useCustomers();
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [newName, setNewName] = useState('');
  const [similarAck, setSimilarAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void scenarioStore.list().then((rows) => {
      if (alive) setTitles(new Map(rows.map((r) => [r.uniqid, r.title])));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // customer id -> scenarios played (merged ids already resolved by the mother).
  const playedBy = useMemo(() => {
    const m = new Map<string, Played[]>();
    for (const p of snapshot.played) {
      const id = resolveCustomerId(snapshot, p.customer_id);
      const list = m.get(id) ?? [];
      list.push({ uniqid: p.game_uniqid, count: p.count, last: p.last_played_at });
      m.set(id, list);
    }
    for (const list of m.values()) list.sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
    return m;
  }, [snapshot]);

  const visible = useMemo(() => {
    const nq = normalizeName(q);
    return snapshot.customers
      .filter((c) => showArchived || !c.archived)
      .filter((c) => !nq || normalizeName(c.name).includes(nq) || (c.city ?? '').toLowerCase().includes(q.trim().toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, i18n.language, { sensitivity: 'base' }));
  }, [snapshot.customers, q, showArchived, i18n.language]);

  const similar = useMemo(
    () => (newName.trim().length >= 3 ? findSimilar(newName.trim(), snapshot.customers.filter((c) => !c.archived)) : []),
    [newName, snapshot.customers]
  );

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    if (similar.length > 0 && !similarAck) {
      setSimilarAck(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createCustomer(name);
      setNewName('');
      setSimilarAck(false);
    } catch (err) {
      console.error('[CustomersScreen] create failed:', err);
      setError(t('createFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-[var(--pg-text)] flex items-center gap-2">
        <Building2 size={22} /> {t('screen.title')}
      </h1>
      <p className="text-sm text-[var(--pg-text-dim)]">{t('screen.intro')}</p>

      {!snapshot.supported ? (
        <div className="pg-panel p-6 text-sm text-[var(--pg-text-dim)]">{t('screen.unsupported')}</div>
      ) : (
        <>
          {/* Quick-create (works offline: the mother is on the LAN). */}
          <div className="pg-panel p-4 space-y-2">
            <div className="flex gap-2">
              <input
                className="pg-input"
                value={newName}
                placeholder={t('screen.newPlaceholder')}
                disabled={busy}
                onChange={(e) => { setNewName(e.target.value); setSimilarAck(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
              />
              <button type="button" onClick={() => void add()} disabled={busy || !newName.trim()}
                className="pg-btn pg-btn--primary flex items-center gap-2 shrink-0">
                <Plus size={16} />{similarAck ? t('createAnyway') : t('screen.add')}
              </button>
            </div>
            {similarAck && similar.length > 0 && (
              <div className="text-sm text-amber-400 flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{t('similarTitle')} {similar.map((s) => s.name).join(', ')}</span>
              </div>
            )}
            {error && <div className="text-sm text-red-400">{error}</div>}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="pg-search flex-1 min-w-[14rem]">
              <span className="pg-search-icon"><Search size={16} /></span>
              <input type="text" value={q} placeholder={t('screen.search')} onChange={(e) => setQ(e.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--pg-text-muted)] cursor-pointer select-none">
              <input type="checkbox" className="accent-[var(--pg-accent)]" checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)} />
              {t('screen.showArchived')}
            </label>
          </div>

          {visible.length === 0 ? (
            <div className="pg-panel p-6 text-sm text-[var(--pg-text-dim)]">
              {q.trim() ? t('screen.emptySearch') : t('screen.empty')}
            </div>
          ) : (
            <div className="pg-panel divide-y divide-[var(--pg-line)]">
              {visible.map((c) => {
                const played = playedBy.get(c.id) ?? [];
                const games = played.reduce((n, p) => n + p.count, 0);
                const last = played.reduce<string | null>((m, p) => (p.last && (!m || p.last > m) ? p.last : m), null);
                const isOpen = open.has(c.id);
                return (
                  <div key={c.id}>
                    <button type="button" onClick={() => toggle(c.id)} disabled={played.length === 0}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left text-[var(--pg-text)] disabled:cursor-default">
                      <span className="w-4 shrink-0 text-[var(--pg-text-dim)]">
                        {played.length > 0 && (isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="font-medium truncate">{c.name}</span>
                          {c.archived && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)]">
                              {t('screen.archived')}
                            </span>
                          )}
                        </span>
                        {c.city && <span className="block text-xs text-[var(--pg-text-dim)] truncate">{c.city}</span>}
                      </span>
                      <span className="text-right text-sm shrink-0">
                        <span className="block">{t('screen.games', { count: games })}</span>
                        <span className="block text-xs text-[var(--pg-text-dim)]">
                          {last ? t('screen.lastPlayed', { date: fmtDay(last, i18n.language) }) : t('screen.never')}
                        </span>
                      </span>
                    </button>
                    {isOpen && (
                      <ul className="pb-3 pl-11 pr-4 space-y-1">
                        {played.map((p) => (
                          <li key={p.uniqid} className="flex items-center justify-between gap-3 text-sm text-[var(--pg-text-muted)]">
                            <span className="truncate">{titles.get(p.uniqid) ?? p.uniqid}</span>
                            <span className="shrink-0 text-xs text-[var(--pg-text-dim)]">
                              {p.count > 1
                                ? t('playedBadgeCount', { count: p.count, date: fmtDay(p.last, i18n.language) ?? '' })
                                : t('playedBadge', { date: fmtDay(p.last, i18n.language) ?? '' })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-xs text-[var(--pg-text-dim)]">{t('screen.editInStudio')}</p>
        </>
      )}
    </div>
  );
}
