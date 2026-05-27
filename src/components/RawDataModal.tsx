import { useEffect, useState, useCallback } from 'react';
import { Database, RefreshCw, Loader2, X, Check, Copy, AlertTriangle, ChevronRight } from 'lucide-react';
import { getLaunchedGameState, type RawPunchRow } from '../services/launchedGames';

interface RawDataModalProps {
  launchedGameId: number;
  gameName: string;
  onClose: () => void;
}

// A punch as it arrives from the SportIdent reader (stored verbatim per
// raw_data row). We only read a few fields for the summary line; the full
// object is always shown in the expandable JSON, so unknown shapes degrade
// gracefully rather than throwing.
interface CardLike {
  id?: number;
  cardType?: string;
  nbPunch?: number;
  punches?: Array<{ code?: number; time?: string }>;
  start?: { code?: number; time?: string } | null;
  end?: { code?: number; time?: string } | null;
}

// Raw punch rows are the source of truth for the in-game scorer. This viewer
// shows them per launched game so an operator can verify what the readers
// actually recorded — chip id, station codes, timing — without dropping into
// the admin DB inspector. Data comes from getLaunchedGameState(id, 0), whose
// `new_raw_data` (cursor 0 ⇒ all rows) routes to the mother during a LAN game.
export function RawDataModal({ launchedGameId, gameName, onClose }: RawDataModalProps) {
  const [rows, setRows] = useState<RawPunchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const state = await getLaunchedGameState(launchedGameId, 0);
      // Newest first — operators care most about the latest punches.
      const sorted = [...(state.new_raw_data ?? [])].sort((a, b) => b.id - a.id);
      setRows(sorted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [launchedGameId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
    } catch {
      /* clipboard may be unavailable in some webviews — ignore */
    }
  };

  const formatTs = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };

  const summarize = (raw: unknown): { chipId: string; punchCount: number; codes: string; card: CardLike | null } => {
    if (!raw || typeof raw !== 'object') return { chipId: '—', punchCount: 0, codes: '', card: null };
    const card = raw as CardLike;
    const punches = Array.isArray(card.punches) ? card.punches : [];
    const codes = punches.map((p) => p?.code).filter((c) => c != null).join(', ');
    return {
      chipId: card.id != null ? String(card.id) : '—',
      punchCount: punches.length,
      codes,
      card,
    };
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-slate-800 border-2 border-slate-700 rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <div className="min-w-0">
            <h3 className="text-xl font-bold text-white flex items-center gap-2">
              <Database size={20} className="text-emerald-400" />
              Raw Data
            </h3>
            <p className="text-sm text-slate-400 truncate">{gameName} · Game ID {launchedGameId} · {rows.length} record{rows.length === 1 ? '' : 's'}</p>
          </div>
          <div className="flex items-center gap-2">
            {rows.length > 0 && (
              <button
                onClick={() => copy('all', JSON.stringify(rows, null, 2))}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition"
                title="Copy all raw data as JSON"
              >
                {copiedKey === 'all' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                Copy all
              </button>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition disabled:opacity-50"
              title="Refresh"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white transition p-1" title="Close">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-4 flex-1">
          {error ? (
            <div className="p-3 bg-red-500/15 border border-red-500/40 text-red-300 rounded-lg text-sm flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          ) : loading && rows.length === 0 ? (
            <div className="text-center py-12 text-slate-400 flex items-center justify-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading raw data…
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-12 text-slate-400">No raw data recorded for this game yet.</div>
          ) : (
            <div className="space-y-2">
              {rows.map((row) => {
                const isOpen = expanded.has(row.id);
                const { chipId, punchCount, codes, card } = summarize(row.raw_data);
                const endCode = card?.end?.code;
                const rowKey = `row-${row.id}`;
                return (
                  <div key={row.id} className="bg-slate-900/50 border border-slate-700 rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleExpanded(row.id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800/60 transition"
                    >
                      <ChevronRight
                        size={16}
                        className={`text-slate-500 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      />
                      <span className="font-mono text-xs text-slate-500 shrink-0">#{row.id}</span>
                      <span className="text-white font-medium text-sm shrink-0">Chip {chipId}</span>
                      <span className="text-slate-400 text-xs shrink-0">
                        {punchCount} punch{punchCount === 1 ? '' : 'es'}
                      </span>
                      {codes && (
                        <span className="text-slate-300 text-xs font-mono truncate min-w-0">[{codes}]</span>
                      )}
                      {endCode != null && (
                        <span className="px-1.5 py-0.5 bg-green-600/20 border border-green-600/40 text-green-400 rounded text-[10px] font-semibold shrink-0">
                          END {endCode}
                        </span>
                      )}
                      <span className="text-slate-500 text-xs ml-auto shrink-0 whitespace-nowrap">
                        {formatTs(row.created_at)}
                      </span>
                      <span className="text-slate-600 text-[10px] font-mono shrink-0" title="Recording device">
                        dev {row.device_id}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="border-t border-slate-700 p-3 bg-slate-950/40 relative">
                        <button
                          onClick={() => copy(rowKey, JSON.stringify(row.raw_data, null, 2))}
                          className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-[11px] transition"
                          title="Copy this record"
                        >
                          {copiedKey === rowKey ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                          Copy
                        </button>
                        <pre className="text-xs text-slate-200 font-mono whitespace-pre-wrap break-words overflow-x-auto pr-16">
                          {JSON.stringify(row.raw_data, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
