import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, FileJson, ChevronDown, ChevronRight, Folder, Trash2, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/db';
import { FileContentModal } from './FileContentModal';

interface ScenarioEntry {
  uniqid: string;
  title: string | null;
  game_type: string | null;
  files: ScenarioFile[];
}

interface ScenarioFile {
  name: string;
  path: string;
  size?: number;
}

interface ViewState {
  path: string;
  fileName: string;
  content: string | null;
  loading: boolean;
  error: string | null;
}

export function ScenariosManagement() {
  const [scenarios, setScenarios] = useState<ScenarioEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    loadScenarios();
  }, []);

  const loadScenarios = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: dbScenarios } = await supabase
        .from('scenarios')
        .select('uniqid, title, game_type')
        .order('created_at', { ascending: false });

      const { data: storageEntries, error: storageError } = await supabase.storage
        .from('resources')
        .list('scenarios', { limit: 1000 });

      if (storageError) throw storageError;

      const dbMap = new Map((dbScenarios || []).map(s => [s.uniqid, s]));

      const entries: ScenarioEntry[] = [];

      for (const entry of storageEntries || []) {
        if (!entry.name || entry.name === '.emptyFolderPlaceholder') continue;

        const { data: files } = await supabase.storage
          .from('resources')
          .list(`scenarios/${entry.name}`, { limit: 1000 });

        const scenarioFiles: ScenarioFile[] = (files || [])
          .filter(f => f.name && f.name !== '.emptyFolderPlaceholder' && f.name.endsWith('.json'))
          .map(f => ({
            name: f.name,
            path: `scenarios/${entry.name}/${f.name}`,
            size: (f as any).metadata?.size,
          }));

        const dbInfo = dbMap.get(entry.name);
        entries.push({
          uniqid: entry.name,
          title: dbInfo?.title || null,
          game_type: dbInfo?.game_type || null,
          files: scenarioFiles,
        });
      }

      setScenarios(entries);
    } catch (err) {
      console.error('Error loading scenarios:', err);
      setError('Failed to load scenarios');
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (uniqid: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(uniqid) ? next.delete(uniqid) : next.add(uniqid);
      return next;
    });
  };

  const openFile = async (path: string, fileName: string) => {
    setViewState({ path, fileName, content: null, loading: true, error: null });
    try {
      const { data, error } = await supabase.storage.from('resources').download(path);
      if (error) throw error;
      const text = await data.text();
      setViewState(prev => prev ? { ...prev, content: text, loading: false } : null);
    } catch (err) {
      setViewState(prev => prev ? { ...prev, loading: false, error: 'Failed to load file content' } : null);
    }
  };

  const deleteScenario = async (uniqid: string) => {
    setDeleting(uniqid);
    setConfirmDelete(null);
    try {
      const { data: files } = await supabase.storage
        .from('resources')
        .list(`scenarios/${uniqid}`, { limit: 1000 });

      const paths = (files || [])
        .filter(f => f.name && f.name !== '.emptyFolderPlaceholder')
        .map(f => `scenarios/${uniqid}/${f.name}`);

      if (paths.length > 0) {
        await supabase.storage.from('resources').remove(paths);
      }

      await supabase.from('scenarios').delete().eq('uniqid', uniqid);

      setScenarios(prev => prev.filter(s => s.uniqid !== uniqid));
    } catch (err) {
      console.error('Error deleting scenario:', err);
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded-lg flex items-center gap-2 bg-red-500/20 text-red-400 border border-red-500/30">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  return (
    <>
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-600 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-100 mb-2">Delete Scenario</h3>
            <p className="text-slate-400 text-sm mb-6">
              Are you sure you want to delete <span className="text-slate-200 font-medium">{confirmDelete}</span>? This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button onClick={() => deleteScenario(confirmDelete)} className="px-4 py-2 rounded-lg text-sm bg-red-600 hover:bg-red-500 text-white font-medium transition-colors">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <FileContentModal
        isOpen={!!viewState}
        onClose={() => setViewState(null)}
        fileName={viewState?.fileName || ''}
        content={viewState?.content || null}
        loading={viewState?.loading || false}
        error={viewState?.error || null}
      />

      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-400">{scenarios.length} scenario{scenarios.length !== 1 ? 's' : ''}</p>
        <button onClick={loadScenarios} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded-lg transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {scenarios.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <p className="text-lg mb-2">No scenarios found</p>
          <p className="text-sm">Upload a scenario ZIP file to get started</p>
        </div>
      ) : (
        <div className="space-y-2">
          {scenarios.map(scenario => {
            const isExpanded = expanded.has(scenario.uniqid);
            return (
              <div key={scenario.uniqid} className="bg-slate-700/30 rounded-lg border border-slate-600 overflow-hidden">
                <div className="px-4 py-3 flex items-center gap-3">
                  <button
                    onClick={() => toggleExpand(scenario.uniqid)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left hover:text-slate-100 transition-colors"
                  >
                    <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                    <span className="font-medium text-slate-200 truncate">
                      {scenario.title || scenario.uniqid}
                    </span>
                    {scenario.game_type && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 shrink-0">
                        {scenario.game_type}
                      </span>
                    )}
                    <span className="text-xs text-slate-500 font-mono shrink-0">{scenario.uniqid}</span>
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 ml-auto" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-400 shrink-0 ml-auto" />
                    )}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(scenario.uniqid)}
                    disabled={deleting === scenario.uniqid}
                    className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50 shrink-0"
                  >
                    {deleting === scenario.uniqid
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <Trash2 className="w-4 h-4" />
                    }
                  </button>
                </div>

                {isExpanded && (
                  <div className="border-t border-slate-600 divide-y divide-slate-700/50">
                    {scenario.files.length === 0 ? (
                      <p className="px-6 py-3 text-sm text-slate-500">No JSON files</p>
                    ) : (
                      scenario.files.map(file => (
                        <button
                          key={file.path}
                          onClick={() => openFile(file.path, file.name)}
                          className="w-full px-6 py-3 flex items-center gap-3 hover:bg-slate-700/40 transition-colors text-left"
                        >
                          <FileJson className="w-4 h-4 text-slate-400 shrink-0" />
                          <span className="text-sm text-slate-300 flex-1 truncate">{file.name}</span>
                          {file.size && (
                            <span className="text-xs text-slate-500 shrink-0">{(file.size / 1024).toFixed(1)} KB</span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
