import React, { useState, useEffect } from 'react';
import { Folder, FolderOpen, File, ChevronRight, ChevronDown, HardDrive, Database, RefreshCw, ExternalLink, Trash2 } from 'lucide-react';
import { getWebStorageStructure, getWebStorageInfo, deleteWebStorageItem } from '../utils/webStorage';
import { ConfirmDialog } from './ConfirmDialog';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  children?: FileNode[];
  expanded?: boolean;
}

interface FolderBrowserProps {
  isElectron: boolean;
}

export function FolderBrowser({ isElectron }: FolderBrowserProps) {
  const [fileTree, setFileTree] = useState<FileNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [storageInfo, setStorageInfo] = useState<{ used: number; total: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; path: string; name: string; isFolder: boolean }>({
    show: false,
    path: '',
    name: '',
    isFolder: false
  });
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadFileStructure();
  }, [isElectron]);

  const loadFileStructure = async () => {
    setLoading(true);
    try {
      if (isElectron) {
        await loadElectronFileStructure();
      } else {
        await loadWebStorageStructure();
      }
    } catch (error) {
      console.error('Error loading file structure:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadElectronFileStructure = async () => {
    try {
      const structure = await (window as any).electron.scenarios.getFolderStructure();
      setFileTree(structure);

      const info = await (window as any).electron.scenarios.getStorageInfo();
      setStorageInfo(info);
    } catch (error) {
      console.error('Error loading electron file structure:', error);
    }
  };

  const loadWebStorageStructure = async () => {
    const structure = await getWebStorageStructure();
    setFileTree(structure);

    const info = getWebStorageInfo();
    setStorageInfo(info);
  };

  const toggleFolder = (path: string) => {
    if (!fileTree) return;

    const toggleNode = (node: FileNode): FileNode => {
      if (node.path === path) {
        return { ...node, expanded: !node.expanded };
      }
      if (node.children) {
        return {
          ...node,
          children: node.children.map(child => toggleNode(child))
        };
      }
      return node;
    };

    setFileTree(toggleNode(fileTree));
  };

  const handleOpenInExplorer = async () => {
    if (isElectron) {
      try {
        await (window as any).electron.system.openDataFolder();
      } catch (error) {
        console.error('Error opening folder:', error);
      }
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const handleDeleteClick = (e: React.MouseEvent, node: FileNode) => {
    e.stopPropagation();
    setDeleteConfirm({
      show: true,
      path: node.path,
      name: node.name,
      isFolder: node.type === 'folder'
    });
  };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      if (isElectron) {
        const result = await (window as any).electron.scenarios.deletePath(deleteConfirm.path);
        if (!result.success) {
          alert(`Failed to delete: ${result.error}`);
        }
      } else {
        const success = await deleteWebStorageItem(deleteConfirm.path);
        if (!success) {
          alert('Failed to delete item');
        }
      }

      await loadFileStructure();
    } catch (error) {
      console.error('Error deleting item:', error);
      alert('An error occurred while deleting');
    } finally {
      setDeleting(false);
      setDeleteConfirm({ show: false, path: '', name: '', isFolder: false });
    }
  };

  const renderNode = (node: FileNode, depth: number = 0): React.ReactNode => {
    const isFolder = node.type === 'folder';
    const hasChildren = node.children && node.children.length > 0;
    const isRootFolder = depth === 0;

    return (
      <div key={node.path}>
        <div
          className={`flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-slate-700/30 cursor-pointer transition-colors group`}
          style={{ paddingLeft: `${depth * 20 + 12}px` }}
          onClick={() => isFolder && toggleFolder(node.path)}
        >
          {isFolder && hasChildren && (
            node.expanded ? (
              <ChevronDown size={16} className="text-slate-400 flex-shrink-0" />
            ) : (
              <ChevronRight size={16} className="text-slate-400 flex-shrink-0" />
            )
          )}
          {!isFolder && <div className="w-4" />}

          {isFolder ? (
            node.expanded ? (
              <FolderOpen size={18} className="text-blue-400 flex-shrink-0" />
            ) : (
              <Folder size={18} className="text-blue-400 flex-shrink-0" />
            )
          ) : (
            <File size={18} className="text-slate-400 flex-shrink-0" />
          )}

          <span className="text-sm font-medium text-slate-200 flex-1">{node.name}</span>

          {node.size !== undefined && (
            <span className="text-xs text-slate-500">{formatBytes(node.size)}</span>
          )}

          {!isRootFolder && (
            <button
              onClick={(e) => handleDeleteClick(e, node)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-600/20 rounded"
              title={`Delete ${isFolder ? 'folder' : 'file'}`}
            >
              <Trash2 size={16} className="text-red-400" />
            </button>
          )}
        </div>

        {isFolder && node.expanded && node.children && (
          <div>
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-slate-800/50 rounded-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          {isElectron ? (
            <HardDrive className="text-blue-400" size={24} />
          ) : (
            <Database className="text-blue-400" size={24} />
          )}
          <h2 className="text-xl font-semibold">
            {isElectron ? 'File System Browser' : 'Storage Browser'}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {isElectron && (
            <button
              onClick={handleOpenInExplorer}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
              title="Open in File Explorer"
            >
              <ExternalLink size={16} />
              Open Folder
            </button>
          )}
          <button
            onClick={loadFileStructure}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {storageInfo && (
        <div className="mb-4 p-4 bg-slate-700/30 rounded-lg border border-slate-600">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-400">Storage Used</span>
            <span className="text-sm font-semibold text-white">
              {formatBytes(storageInfo.used)} / {formatBytes(storageInfo.total)}
            </span>
          </div>
          <div className="w-full bg-slate-600 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all"
              style={{ width: `${Math.min((storageInfo.used / storageInfo.total) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-slate-400">Loading file structure...</div>
      ) : fileTree ? (
        <div className="border border-slate-700 rounded-lg bg-slate-900/30 max-h-96 overflow-y-auto">
          {renderNode(fileTree)}
        </div>
      ) : (
        <div className="text-center py-8 text-slate-400">No files found</div>
      )}

      <ConfirmDialog
        isOpen={deleteConfirm.show}
        title={`Delete ${deleteConfirm.isFolder ? 'Folder' : 'File'}`}
        message={`Are you sure you want to delete "${deleteConfirm.name}"?${deleteConfirm.isFolder ? ' This will delete all files inside this folder.' : ''}`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteConfirm({ show: false, path: '', name: '', isFolder: false })}
        isLoading={deleting}
      />
    </div>
  );
}
