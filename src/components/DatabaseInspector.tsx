import { useEffect, useState } from 'react';
import {
  Database as DbIcon,
  RefreshCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Check,
} from 'lucide-react';
import { getDb } from '../services/db';

interface TableEntry {
  name: string;
}

interface ColumnInfo {
  name: string;
  type: string;
}

const PAGE_SIZE = 50;

// Admin-mode read-only viewer onto the local SQLite (playground.db).
// Reuses the shared getDb() handle. No write paths, no free-form SQL —
// table names are whitelisted against sqlite_master so the interpolated
// identifiers in PRAGMA / COUNT / SELECT cannot be injection vectors.
export function DatabaseInspector() {
  const [tables, setTables] = useState<TableEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadTables = async (keepSelection = true) => {
    setError(null);
    try {
      const db = await getDb();
      const list = await db.select<TableEntry[]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      setTables(list);
      if (!keepSelection || (selected && !list.some((t) => t.name === selected))) {
        setSelected(list[0]?.name ?? null);
        setPage(0);
      } else if (!selected) {
        setSelected(list[0]?.name ?? null);
      }
    } catch (e) {
      setError(toMessage(e));
    }
  };

  useEffect(() => {
    void loadTables(false);
  }, []);

  useEffect(() => {
    if (!selected) return;
    void loadPage(selected, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, page]);

  const loadPage = async (table: string, p: number) => {
    if (!tables.some((t) => t.name === table)) {
      setError(`Unknown table: ${table}`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      const cols = await db.select<{ name: string; type: string }[]>(
        `PRAGMA table_info(${table})`
      );
      setColumns(cols.map((c) => ({ name: c.name, type: c.type })));

      const countRow = await db.select<{ c: number }[]>(
        `SELECT COUNT(*) AS c FROM ${table}`
      );
      setRowCount(Number(countRow[0]?.c ?? 0));

      const data = await db.select<Record<string, unknown>[]>(
        `SELECT * FROM ${table} LIMIT ${PAGE_SIZE} OFFSET ${p * PAGE_SIZE}`
      );
      setRows(data);
    } catch (e) {
      setError(toMessage(e));
      setColumns([]);
      setRows([]);
      setRowCount(0);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    await loadTables(true);
    if (selected) await loadPage(selected, page);
  };

  const handleCopy = async (key: string, value: unknown) => {
    const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
    } catch {
      /* clipboard may be unavailable in some webviews — just ignore */
    }
  };

  const totalPages = Math.max(1, Math.ceil(rowCount / PAGE_SIZE));
  const pageStart = rowCount === 0 ? 0 : page * PAGE_SIZE + 1;
  const pageEnd = Math.min(rowCount, (page + 1) * PAGE_SIZE);

  return (
    <div className="min-h-[calc(100vh-64px)] text-white py-8">
      <div className="container mx-auto px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <DbIcon className="text-red-300" size={28} />
            <h1 className="text-2xl font-bold">Database</h1>
          </div>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm disabled:opacity-50"
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
            <div className="text-xs uppercase tracking-wider text-slate-500 px-3 mb-2">
              Tables ({tables.length})
            </div>
            <div className="space-y-1">
              {tables.map((t) => {
                const active = selected === t.name;
                return (
                  <button
                    key={t.name}
                    onClick={() => {
                      setSelected(t.name);
                      setPage(0);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm font-mono transition ${
                      active ? 'bg-red-600 text-white' : 'text-slate-300 hover:bg-slate-700/60'
                    }`}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="flex-1 min-w-0">
            {!selected ? (
              <div className="text-slate-400">Pick a table on the left.</div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <div className="font-mono text-lg text-white">
                    {selected}
                    <span className="text-slate-400 text-sm ml-2">({rowCount} rows)</span>
                  </div>
                </div>

                <div className="bg-slate-800/60 border border-slate-700 rounded-lg overflow-auto">
                  {columns.length === 0 ? (
                    <div className="p-6 text-slate-400 text-sm">
                      {loading ? 'Loading…' : 'No columns.'}
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-slate-900/60 sticky top-0">
                        <tr>
                          {columns.map((c) => (
                            <th
                              key={c.name}
                              className="text-left px-3 py-2 font-mono text-slate-300 border-b border-slate-700 whitespace-nowrap"
                            >
                              {c.name}
                              <span className="text-slate-500 ml-1 normal-case">
                                {c.type || ''}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr>
                            <td
                              colSpan={Math.max(1, columns.length)}
                              className="px-3 py-6 text-center text-slate-500"
                            >
                              {loading ? 'Loading…' : 'No rows.'}
                            </td>
                          </tr>
                        ) : (
                          rows.map((row, ri) => (
                            <tr
                              key={ri}
                              className={ri % 2 === 0 ? 'bg-slate-800/30' : 'bg-slate-800/10'}
                            >
                              {columns.map((c) => {
                                const key = `${ri}:${c.name}`;
                                const value = row[c.name];
                                return (
                                  <td
                                    key={c.name}
                                    onClick={() => handleCopy(key, value)}
                                    title={fullText(value)}
                                    className="px-3 py-1.5 font-mono text-xs text-slate-200 border-b border-slate-800/60 cursor-pointer hover:bg-red-500/10 max-w-[28ch] truncate align-top"
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
                  <div className="flex items-center justify-between mt-3 text-xs text-slate-400">
                    <span>
                      Rows {pageStart}–{pageEnd} of {rowCount}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        disabled={page === 0 || loading}
                        className="p-1 rounded hover:bg-slate-700/60 disabled:opacity-30"
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span>
                        Page {page + 1} of {totalPages}
                      </span>
                      <button
                        onClick={() =>
                          setPage((p) => Math.min(totalPages - 1, p + 1))
                        }
                        disabled={page >= totalPages - 1 || loading}
                        className="p-1 rounded hover:bg-slate-700/60 disabled:opacity-30"
                      >
                        <ChevronRight size={16} />
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

function renderCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <em className="text-slate-500">NULL</em>;
  }
  if (value instanceof Uint8Array) {
    return <span className="text-slate-400">(blob, {value.length} bytes)</span>;
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
