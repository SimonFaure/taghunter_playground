import { useEffect, useRef, useState } from 'react';
import {
  Database as DbIcon,
  RefreshCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  AlertTriangle,
  Check,
  Search,
  X,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { getDb } from '../services/db';

interface TableEntry {
  name: string;
}

interface ColumnInfo {
  name: string;
  type: string;
}

interface SortSpec {
  col: string;
  dir: 'asc' | 'desc';
}

const PAGE_SIZE = 50;

// Admin-mode read-only viewer onto the local SQLite (playground.db).
// Reuses the shared getDb() handle. No write paths, no free-form SQL -
// table names are whitelisted against sqlite_master and column names
// against PRAGMA table_info, so the interpolated identifiers in
// PRAGMA / COUNT / SELECT cannot be injection vectors. The search term
// is the only user-typed value that reaches SQL, and it goes through a
// bound $1 parameter.
export function DatabaseInspector() {
  const [tables, setTables] = useState<TableEntry[]>([]);
  const [tableFilter, setTableFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState('1');
  // Guards against out-of-order query responses (fast typing / table hops).
  const requestSeq = useRef(0);

  const loadTables = async (keepSelection = true) => {
    setError(null);
    try {
      const db = await getDb();
      const list = await db.select<TableEntry[]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      setTables(list);
      if (!keepSelection || (selected && !list.some((t) => t.name === selected))) {
        selectTable(list[0]?.name ?? null);
      } else if (!selected) {
        selectTable(list[0]?.name ?? null);
      }
    } catch (e) {
      setError(toMessage(e));
    }
  };

  const selectTable = (name: string | null) => {
    setSelected(name);
    setPage(0);
    setSearch('');
    setDebouncedSearch('');
    setSort(null);
  };

  useEffect(() => {
    void loadTables(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the search box so we don't run a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!selected) return;
    void loadPage(selected, page, debouncedSearch, sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, page, debouncedSearch, sort]);

  const loadPage = async (
    table: string,
    p: number,
    term: string,
    sortSpec: SortSpec | null
  ) => {
    if (!tables.some((t) => t.name === table)) {
      setError(`Unknown table: ${table}`);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      const cols = await db.select<{ name: string; type: string }[]>(
        `PRAGMA table_info(${table})`
      );
      if (seq !== requestSeq.current) return;
      setColumns(cols.map((c) => ({ name: c.name, type: c.type })));

      // Build a WHERE that matches the term against every column, cast to
      // TEXT. Column identifiers come from PRAGMA (trusted); the term is a
      // bound parameter. LIKE wildcards in the term are escaped so a user
      // typing "%" or "_" searches for the literal character.
      let where = '';
      let binds: string[] = [];
      const trimmed = term.trim();
      if (trimmed && cols.length > 0) {
        const clauses = cols
          .map((c) => `CAST(${quoteIdent(c.name)} AS TEXT) LIKE $1 ESCAPE '\\'`)
          .join(' OR ');
        where = ` WHERE (${clauses})`;
        binds = [`%${escapeLike(trimmed)}%`];
      }

      let orderBy = '';
      if (sortSpec && cols.some((c) => c.name === sortSpec.col)) {
        orderBy = ` ORDER BY ${quoteIdent(sortSpec.col)} ${
          sortSpec.dir === 'desc' ? 'DESC' : 'ASC'
        }`;
      }

      const countRow = await db.select<{ c: number }[]>(
        `SELECT COUNT(*) AS c FROM ${table}${where}`,
        binds
      );
      if (seq !== requestSeq.current) return;
      const total = Number(countRow[0]?.c ?? 0);
      setRowCount(total);

      // If the filter shrank the result set below the current page, clamp.
      const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
      const effectivePage = Math.min(p, maxPage);
      if (effectivePage !== p) setPage(effectivePage);

      const data = await db.select<Record<string, unknown>[]>(
        `SELECT * FROM ${table}${where}${orderBy} LIMIT ${PAGE_SIZE} OFFSET ${
          effectivePage * PAGE_SIZE
        }`,
        binds
      );
      if (seq !== requestSeq.current) return;
      setRows(data);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(toMessage(e));
      setColumns([]);
      setRows([]);
      setRowCount(0);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  const handleRefresh = async () => {
    await loadTables(true);
    if (selected) await loadPage(selected, page, debouncedSearch, sort);
  };

  const toggleSort = (col: string) => {
    setPage(0);
    setSort((s) => {
      if (!s || s.col !== col) return { col, dir: 'asc' };
      if (s.dir === 'asc') return { col, dir: 'desc' };
      return null;
    });
  };

  const handleCopy = async (key: string, value: unknown) => {
    const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
    } catch {
      /* clipboard may be unavailable in some webviews - just ignore */
    }
  };

  const totalPages = Math.max(1, Math.ceil(rowCount / PAGE_SIZE));
  const pageStart = rowCount === 0 ? 0 : page * PAGE_SIZE + 1;
  const pageEnd = Math.min(rowCount, (page + 1) * PAGE_SIZE);

  // Keep the editable page field in sync when the page changes by any
  // other means (arrows, filter clamping, table switch).
  useEffect(() => {
    setPageInput(String(page + 1));
  }, [page]);

  const commitPageInput = () => {
    const n = parseInt(pageInput, 10);
    if (Number.isFinite(n)) {
      setPage(Math.min(totalPages - 1, Math.max(0, n - 1)));
    } else {
      setPageInput(String(page + 1));
    }
  };
  const filteredTables = tableFilter.trim()
    ? tables.filter((t) => t.name.toLowerCase().includes(tableFilter.trim().toLowerCase()))
    : tables;

  return (
    <div className="min-h-[calc(100vh-64px)] text-[var(--pg-text)] py-8">
      <div className="container mx-auto px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <DbIcon className="text-[var(--pg-accent-bright)]" size={28} />
            <h1 className="text-2xl font-bold">Database</h1>
          </div>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="pg-btn pg-btn--ghost pg-btn--sm disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/15 border border-red-500/40 text-red-300 rounded-lg text-sm flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        <div className="flex gap-6 min-h-[60vh]">
          <aside className="w-56 shrink-0">
            <div className="text-xs uppercase tracking-wider text-[var(--pg-text-dim)] px-3 mb-2">
              Tables ({filteredTables.length}
              {filteredTables.length !== tables.length ? `/${tables.length}` : ''})
            </div>
            <div className="relative mb-2 px-1">
              <Search
                size={13}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] pointer-events-none"
              />
              <input
                type="text"
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
                placeholder="Filter tables…"
                className="pg-input w-full text-sm pl-8 pr-7 py-1.5"
              />
              {tableFilter && (
                <button
                  onClick={() => setTableFilter('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] hover:text-[var(--pg-text)]"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="space-y-1">
              {filteredTables.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--pg-text-dim)]">No match.</div>
              ) : (
                filteredTables.map((t) => {
                  const active = selected === t.name;
                  return (
                    <button
                      key={t.name}
                      onClick={() => selectTable(t.name)}
                      className={`w-full text-left px-3 py-2 rounded-[var(--pg-radius-md)] text-sm font-mono transition ${
                        active ? 'bg-[var(--pg-accent)] text-[var(--pg-text)]' : 'text-[var(--pg-text-muted)] hover:bg-[var(--pg-surface-3)]'
                      }`}
                    >
                      {t.name}
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <main className="flex-1 min-w-0">
            {!selected ? (
              <div className="text-[var(--pg-text-dim)]">Pick a table on the left.</div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-4 mb-3">
                  <div className="font-mono text-lg text-[var(--pg-text)] truncate">
                    {selected}
                    <span className="text-[var(--pg-text-dim)] text-sm ml-2">
                      ({rowCount} rows{debouncedSearch.trim() ? ', filtered' : ''})
                    </span>
                  </div>
                  <div className="relative w-72 shrink-0">
                    <Search
                      size={14}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] pointer-events-none"
                    />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search all columns…"
                      className="pg-input w-full text-sm pl-8 pr-7 py-1.5"
                    />
                    {search && (
                      <button
                        onClick={() => setSearch('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--pg-text-dim)] hover:text-[var(--pg-text)]"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="bg-[var(--pg-surface)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] overflow-auto">
                  {columns.length === 0 ? (
                    <div className="p-6 text-[var(--pg-text-dim)] text-sm">
                      {loading ? 'Loading…' : 'No columns.'}
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--pg-bg)] sticky top-0">
                        <tr>
                          {columns.map((c) => {
                            const sorted = sort?.col === c.name ? sort.dir : null;
                            return (
                              <th
                                key={c.name}
                                onClick={() => toggleSort(c.name)}
                                title={`Sort by ${c.name}`}
                                className={`text-left px-3 py-2 font-mono border-b border-[var(--pg-line)] whitespace-nowrap cursor-pointer select-none hover:text-[var(--pg-text)] ${
                                  sorted ? 'text-[var(--pg-accent-bright)]' : 'text-[var(--pg-text-muted)]'
                                }`}
                              >
                                <span className="inline-flex items-center gap-1">
                                  {c.name}
                                  {sorted === 'asc' && <ArrowUp size={12} />}
                                  {sorted === 'desc' && <ArrowDown size={12} />}
                                </span>
                                <span className="text-[var(--pg-text-dim)] ml-1 normal-case">
                                  {c.type || ''}
                                </span>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr>
                            <td
                              colSpan={Math.max(1, columns.length)}
                              className="px-3 py-6 text-center text-[var(--pg-text-dim)]"
                            >
                              {loading
                                ? 'Loading…'
                                : debouncedSearch.trim()
                                  ? 'No rows match the search.'
                                  : 'No rows.'}
                            </td>
                          </tr>
                        ) : (
                          rows.map((row, ri) => (
                            <tr
                              key={ri}
                              className={ri % 2 === 0 ? 'bg-[var(--pg-surface-2)]' : ''}
                            >
                              {columns.map((c) => {
                                const key = `${ri}:${c.name}`;
                                const value = row[c.name];
                                return (
                                  <td
                                    key={c.name}
                                    onClick={() => handleCopy(key, value)}
                                    title={fullText(value)}
                                    className="px-3 py-1.5 font-mono text-xs text-[var(--pg-text)] border-b border-[var(--pg-line)] cursor-pointer hover:bg-[var(--pg-accent-tint)] max-w-[28ch] truncate align-top"
                                  >
                                    <span className="inline-flex items-center gap-1">
                                      {renderCell(value)}
                                      {copiedKey === key && (
                                        <Check size={12} className="text-emerald-400" />
                                      )}
                                    </span>
                                  </td>
                                );
                              })}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  )}
                </div>

                {rowCount > 0 && (
                  <div className="flex items-center justify-between mt-3 text-xs text-[var(--pg-text-dim)]">
                    <span>
                      Rows {pageStart}–{pageEnd} of {rowCount}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setPage(0)}
                        disabled={page === 0 || loading}
                        title="First page"
                        className="p-1 rounded hover:bg-[var(--pg-surface-3)] disabled:opacity-30"
                      >
                        <ChevronsLeft size={16} />
                      </button>
                      <button
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        disabled={page === 0 || loading}
                        title="Previous page"
                        className="p-1 rounded hover:bg-[var(--pg-surface-3)] disabled:opacity-30"
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span className="flex items-center gap-1.5 mx-1">
                        Page
                        <input
                          type="text"
                          inputMode="numeric"
                          value={pageInput}
                          onChange={(e) => setPageInput(e.target.value)}
                          onBlur={commitPageInput}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitPageInput();
                          }}
                          className="pg-input w-12 text-center text-xs py-0.5 px-1"
                        />
                        of {totalPages}
                      </span>
                      <button
                        onClick={() =>
                          setPage((p) => Math.min(totalPages - 1, p + 1))
                        }
                        disabled={page >= totalPages - 1 || loading}
                        title="Next page"
                        className="p-1 rounded hover:bg-[var(--pg-surface-3)] disabled:opacity-30"
                      >
                        <ChevronRight size={16} />
                      </button>
                      <button
                        onClick={() => setPage(totalPages - 1)}
                        disabled={page >= totalPages - 1 || loading}
                        title="Last page"
                        className="p-1 rounded hover:bg-[var(--pg-surface-3)] disabled:opacity-30"
                      >
                        <ChevronsRight size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

// Column names come from PRAGMA table_info (trusted), but quote them anyway
// so names with spaces/keywords work.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Escape LIKE wildcards so a typed "%" / "_" matches literally
// (pairs with ESCAPE '\' in the query).
function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function renderCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <em className="text-[var(--pg-text-dim)]">NULL</em>;
  }
  if (value instanceof Uint8Array) {
    return <span className="text-[var(--pg-text-dim)]">(blob, {value.length} bytes)</span>;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function fullText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Uint8Array) return `(blob, ${value.length} bytes)`;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function toMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
