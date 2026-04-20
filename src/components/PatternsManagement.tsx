import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, FileJson, FileText, Trash2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { supabase } from '../lib/db';
import { FileContentModal } from './FileContentModal';

interface PatternFile {
  name: string;
  path: string;
  uniqid: string;
  slug: string;
  ext: string;
  size?: number;
  updatedAt?: string | null;
}

interface PatternGroup {
  gameType: string;
  files: PatternFile[];
}

interface ViewState {
  path: string;
  fileName: string;
  content: string | null;
  loading: boolean;
  error: string | null;
}

export function PatternsManagement() {
  const [groups, setGroups] = useState<PatternGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PatternFile | null>(null);

  useEffect(() => {
    loadPatterns();
  }, []);

  const loadPatterns = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: gameTypeFolders, error: foldersError } = await supabase.storage
        .from('resources')
        .list('patterns', { limit: 100 });

      if (foldersError) throw foldersError;

      const result: PatternGroup[] = [];

      for (const folder of gameTypeFolders || []) {
        if (!folder.name || folder.name === '.emptyFolderPlaceholder' || folder.id !== null) continue;

        const { data: files } = await supabase.storage
          .from('resources')
          .list(`patterns/${folder.name}`, { limit: 1000 });

        const patternFiles: PatternFile[] = [];

        for (const file of files || []) {
          if (!file.name || file.name === '.emptyFolderPlaceholder') continue;

          const baseName = file.name.replace(/\.(json|csv)$/, '');
          const ext = file.name.endsWith('.json') ? 'json' : 'csv';
          const parts = baseName.split('_');

          let uniqid = '';
          let slug = baseName;

          if (parts.length >= 3 && parts[0] === 'pattern') {
            uniqid = parts[1];
            slug = parts.slice(2).join('_');
          }

          patternFiles.push({
            name: file.name,
            path: `patterns/${folder.name}/${file.name}`,
            uniqid,
            slug,
            ext,
            size: (file as any).metadata?.size,
            updatedAt: file.updated_at || null,
          });
        }

        if (patternFiles.length > 0) {
          result.push({ gameType: folder.name, files: patternFiles });
        }
      }

      setGroups(result);
      setExpanded(new Set(result.map(g => g.gameType)));
    } catch (err) {
      console.error('Error loading patterns:', err);
      setError('Failed to load patterns');
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (gameType: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(gameType) ? next.delete(gameType) : next.add(gameType);
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
    } catch {
      setViewState(prev => prev ? { ...prev, loading: false, error: 'Failed to load file content' } : null);
    }
  };

  const deletePattern = async (file: PatternFile) => {
    setDeleting(file.path);
    setConfirmDelete(null);
    try {
      await supabase.storage.from('resources').remove([file.path]);

      const baseName = file.name.replace(/\.(json|csv)$/, '');
      await supabase.from('patterns').delete().eq('slug', baseName);

      setGroups(prev =>
        prev
          .map(g => ({
            ...g,
            files: g.files.filter(f => f.path !== file.path),
          }))
          .filter(g => g.files.length > 0)
      );
    } catch (err) {
      console.error('Error deleting pattern:', err);
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

  const totalFiles = groups.reduce((sum, g) => sum + g.files.length, 0);

  return (
    <>
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-600 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-100 mb-2">Delete Pattern File</h3>
            <p className="text-slate-400 text-sm mb-6">
              Delete <span className="text-slate-200 font-medium">{confirmDelete.name}</span>? This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button onClick={() => deletePattern(confirmDelete)} className="px-4 py-2 rounded-lg text-sm bg-red-600 hover:bg-red-500 text-white font-medium transition-colors">
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
        <p className="text-sm text-slate-400">{totalFiles} pattern file{totalFiles !== 1 ? 's' : ''} across {groups.length} game type{groups.length !== 1 ? 's' : ''}</p>
        <button onClick={loadPatterns} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded-lg transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <p className="text-lg mb-2">No pattern files found</p>
          <p className="text-sm">Upload a pattern JSON or CSV file to get started</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(group => {
            const isExpanded = expanded.has(group.gameType);
            return (
              <div key={group.gameType} className="bg-slate-700/30 rounded-lg border border-slate-600 overflow-hidden">
                <button
                  onClick={() => toggleExpand(group.gameType)}
                  className="w-full px-5 py-3.5 flex items-center gap-3 hover:bg-slate-700/40 transition-colors"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                  <span className="font-semibold text-slate-200 capitalize flex-1 text-left">{group.gameType}</span>
                  <span className="text-xs text-slate-500">{group.files.length} file{group.files.length !== 1 ? 's' : ''}</span>
                </button>

                {isExpanded && (
                  <div className="border-t border-slate-600 divide-y divide-slate-700/50">
                    {group.files.map(file => (
                      <div key={file.path} className="flex items-center gap-1">
                        <button
                          onClick={() => openFile(file.path, file.name)}
                          className="flex-1 px-5 py-3 flex items-center gap-3 hover:bg-slate-700/40 transition-colors text-left"
                        >
                          {file.ext === 'json' ? (
                            <FileJson className="w-4 h-4 text-blue-400 shrink-0" />
                          ) : (
                            <FileText className="w-4 h-4 text-emerald-400 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-200 truncate">{file.name}</p>
                            {file.slug && file.uniqid && (
                              <p className="text-xs text-slate-500 truncate">
                                {file.slug} <span className="font-mono text-slate-600">· {file.uniqid}</span>
                              </p>
                            )}
                          </div>
                          {file.updatedAt && (
                            <span className="text-xs text-slate-500 shrink-0 hidden sm:block">
                              {new Date(file.updatedAt).toLocaleDateString()}
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(file)}
                          disabled={deleting === file.path}
                          className="p-2 mr-2 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                        >
                          {deleting === file.path
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Trash2 className="w-4 h-4" />
                          }
                        </button>
                      </div>
                    ))}
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
