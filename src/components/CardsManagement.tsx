import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, FileText, Trash2, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/db';
import { FileContentModal } from './FileContentModal';

interface CardFile {
  name: string;
  path: string;
  size?: number;
  updatedAt?: string | null;
}

interface ViewState {
  path: string;
  fileName: string;
  content: string | null;
  loading: boolean;
  error: string | null;
}

export function CardsManagement() {
  const [files, setFiles] = useState<CardFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CardFile | null>(null);

  useEffect(() => {
    loadCards();
  }, []);

  const loadCards = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: listError } = await supabase.storage
        .from('resources')
        .list('cards', { limit: 1000 });

      if (listError) throw listError;

      const cardFiles: CardFile[] = (data || [])
        .filter(f => f.name && f.name !== '.emptyFolderPlaceholder')
        .map(f => ({
          name: f.name,
          path: `cards/${f.name}`,
          size: (f as any).metadata?.size,
          updatedAt: f.updated_at || null,
        }));

      setFiles(cardFiles);
    } catch (err) {
      console.error('Error loading cards:', err);
      setError('Failed to load cards');
    } finally {
      setLoading(false);
    }
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

  const deleteFile = async (file: CardFile) => {
    setDeleting(file.path);
    setConfirmDelete(null);
    try {
      await supabase.storage.from('resources').remove([file.path]);
      setFiles(prev => prev.filter(f => f.path !== file.path));
    } catch (err) {
      console.error('Error deleting card file:', err);
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
            <h3 className="text-lg font-semibold text-slate-100 mb-2">Delete Card File</h3>
            <p className="text-slate-400 text-sm mb-6">
              Delete <span className="text-slate-200 font-medium">{confirmDelete.name}</span>? This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button onClick={() => deleteFile(confirmDelete)} className="px-4 py-2 rounded-lg text-sm bg-red-600 hover:bg-red-500 text-white font-medium transition-colors">
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
        <p className="text-sm text-slate-400">{files.length} card file{files.length !== 1 ? 's' : ''}</p>
        <button onClick={loadCards} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded-lg transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {files.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <p className="text-lg mb-2">No card files found</p>
          <p className="text-sm">Upload a cards CSV file to get started</p>
        </div>
      ) : (
        <div className="bg-slate-700/30 rounded-lg border border-slate-600 divide-y divide-slate-600/50 overflow-hidden">
          {files.map(file => (
            <div key={file.path} className="flex items-center gap-1">
              <button
                onClick={() => openFile(file.path, file.name)}
                className="flex-1 px-5 py-3.5 flex items-center gap-3 hover:bg-slate-700/40 transition-colors text-left"
              >
                <FileText className="w-4 h-4 text-emerald-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-200 truncate">{file.name}</p>
                  {file.size && (
                    <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB</p>
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
    </>
  );
}
