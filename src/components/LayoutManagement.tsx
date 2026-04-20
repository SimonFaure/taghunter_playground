import { useState, useEffect } from 'react';
import { AlertCircle, Loader2, FileJson, Trash2, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/db';
import { FileContentModal } from './FileContentModal';

interface LayoutFile {
  name: string;
  gameType: string;
  path: string;
  updatedAt: string | null;
  size?: number;
}

interface ViewState {
  path: string;
  fileName: string;
  content: string | null;
  loading: boolean;
  error: string | null;
}

export function LayoutManagement() {
  const [layouts, setLayouts] = useState<LayoutFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingGameType, setDeletingGameType] = useState<string | null>(null);
  const [confirmDeleteGameType, setConfirmDeleteGameType] = useState<string | null>(null);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<LayoutFile | null>(null);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState | null>(null);

  useEffect(() => {
    loadLayouts();
  }, []);

  const deleteGameTypeFolder = async (gameType: string) => {
    setDeletingGameType(gameType);
    setConfirmDeleteGameType(null);
    try {
      const { data: files, error: listError } = await supabase.storage
        .from('resources')
        .list(`layouts/${gameType}`, { limit: 1000 });
      if (listError) throw listError;

      const paths = (files || []).map(f => `layouts/${gameType}/${f.name}`);
      if (paths.length > 0) {
        const { error: deleteError } = await supabase.storage
          .from('resources')
          .remove(paths);
        if (deleteError) throw deleteError;
      }

      setLayouts(prev => prev.filter(l => l.gameType !== gameType));
    } catch (err) {
      console.error('Error deleting folder:', err);
      setError('Failed to delete folder');
    } finally {
      setDeletingGameType(null);
    }
  };

  const deleteFile = async (file: LayoutFile) => {
    setDeletingFilePath(file.path);
    setConfirmDeleteFile(null);
    try {
      const { error: deleteError } = await supabase.storage
        .from('resources')
        .remove([file.path]);
      if (deleteError) throw deleteError;
      setLayouts(prev => prev.filter(l => l.path !== file.path));
    } catch (err) {
      console.error('Error deleting file:', err);
      setError('Failed to delete file');
    } finally {
      setDeletingFilePath(null);
    }
  };

  const loadLayouts = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: folders, error: foldersError } = await supabase.storage
        .from('resources')
        .list('layouts', { limit: 100 });

      if (foldersError) throw foldersError;

      const allLayouts: LayoutFile[] = [];

      for (const folder of folders || []) {
        if (folder.id === null) {
          const { data: files, error: filesError } = await supabase.storage
            .from('resources')
            .list(`layouts/${folder.name}`, { limit: 100 });

          if (filesError) continue;

          for (const file of files || []) {
            if (file.name.endsWith('.json')) {
              allLayouts.push({
                name: file.name,
                gameType: folder.name,
                path: `layouts/${folder.name}/${file.name}`,
                updatedAt: file.updated_at || null,
                size: (file as any).metadata?.size,
              });
            }
          }
        }
      }

      setLayouts(allLayouts);
    } catch (err) {
      console.error('Error loading layouts:', err);
      setError('Failed to load layouts');
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
        <AlertCircle className="w-5 h-5" />
        <span>{error}</span>
      </div>
    );
  }

  const grouped = layouts.reduce((acc, layout) => {
    if (!acc[layout.gameType]) acc[layout.gameType] = [];
    acc[layout.gameType].push(layout);
    return acc;
  }, {} as Record<string, LayoutFile[]>);

  return (
    <>
      {confirmDeleteGameType && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-600 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-100 mb-2">Delete Folder</h3>
            <p className="text-slate-400 text-sm mb-6">
              Are you sure you want to delete all layouts in <span className="text-slate-200 font-medium capitalize">{confirmDeleteGameType}</span>? This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDeleteGameType(null)}
                className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteGameTypeFolder(confirmDeleteGameType)}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 hover:bg-red-500 text-white font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteFile && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-600 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-100 mb-2">Delete Layout File</h3>
            <p className="text-slate-400 text-sm mb-6">
              Are you sure you want to delete <span className="text-slate-200 font-medium">{confirmDeleteFile.name}</span>? This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDeleteFile(null)}
                className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteFile(confirmDeleteFile)}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 hover:bg-red-500 text-white font-medium transition-colors"
              >
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
        <p className="text-sm text-slate-400">{layouts.length} layout file{layouts.length !== 1 ? 's' : ''}</p>
        <button onClick={loadLayouts} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded-lg transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      <div className="space-y-3">
        {Object.keys(grouped).length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <p className="text-lg mb-2">No layouts found</p>
            <p className="text-sm">Upload a layout file using the upload field above</p>
          </div>
        ) : (
          Object.entries(grouped).map(([gameType, files]) => (
            <div key={gameType} className="bg-slate-700/30 rounded-lg border border-slate-600">
              <div className="px-5 py-3.5 border-b border-slate-600 flex items-center justify-between">
                <h3 className="font-semibold text-slate-200 capitalize">{gameType} Layouts</h3>
                <button
                  onClick={() => setConfirmDeleteGameType(gameType)}
                  disabled={deletingGameType === gameType}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  title="Delete folder"
                >
                  {deletingGameType === gameType
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Trash2 className="w-4 h-4" />
                  }
                </button>
              </div>
              <div className="divide-y divide-slate-600/50">
                {files.map((file) => (
                  <div
                    key={file.path}
                    className="px-5 py-3.5 flex items-center gap-3 hover:bg-slate-700/40 transition-colors group"
                  >
                    <button
                      onClick={() => openFile(file.path, file.name)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      <FileJson className="w-4 h-4 text-blue-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-200 truncate text-sm">{file.name}</p>
                        {file.updatedAt && (
                          <p className="text-xs text-slate-500">
                            Updated {new Date(file.updatedAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </button>
                    {file.size && (
                      <span className="text-xs text-slate-500 shrink-0">{(file.size / 1024).toFixed(1)} KB</span>
                    )}
                    <button
                      onClick={() => setConfirmDeleteFile(file)}
                      disabled={deletingFilePath === file.path}
                      className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 opacity-0 group-hover:opacity-100"
                      title="Delete file"
                    >
                      {deletingFilePath === file.path
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Trash2 className="w-3.5 h-3.5" />
                      }
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
