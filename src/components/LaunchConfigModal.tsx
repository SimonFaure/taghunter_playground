import { useState } from 'react';
import { X, Play, Pencil, Trash2 } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import type { LaunchConfigRow, SavedLaunchConfig } from '../services/launchConfigsStore';

interface LaunchConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  scenario: { uniqid: string; title: string; gameTypeName: string };
  configs: LaunchConfigRow[];
  /** Headless-launch this config (host validates + falls back to the wizard). */
  onLaunch: (cfg: LaunchConfigRow) => void;
  /** Open the launch wizard pre-filled with this config (no launch). */
  onEdit: (cfg: LaunchConfigRow) => void;
  /** Delete this config (host persists + refetches). */
  onDelete: (cfg: LaunchConfigRow) => void;
}

// One-line, best-effort summary of the saved settings for the row subtitle.
function summarize(c: SavedLaunchConfig): string {
  const parts: string[] = [];
  if (c.autoRegisterTeam) parts.push('auto-register');
  else if (c.selfRegisterTeam) parts.push('self-register');
  else if (typeof c.numberOfTeams === 'number') {
    parts.push(`${c.numberOfTeams} team${c.numberOfTeams === 1 ? '' : 's'}`);
  }
  if (c.duration) parts.push(`${c.duration} min`);
  if (c.victoryType) parts.push(c.victoryType);
  if (c.playMode) parts.push(c.playMode);
  if (c.route) parts.push(c.route);
  if (c.displayMode) parts.push(c.displayMode);
  if (c.reuseCards) parts.push('reuse cards');
  if (c.useNamePool) parts.push('name pool');
  if (c.language) parts.push(c.language);
  return parts.join(' · ');
}

export function LaunchConfigModal({
  isOpen,
  onClose,
  scenario,
  configs,
  onLaunch,
  onEdit,
  onDelete,
}: LaunchConfigModalProps) {
  const [deleteTarget, setDeleteTarget] = useState<LaunchConfigRow | null>(null);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl mx-4 max-h-[85vh] overflow-auto bg-slate-900 shadow-2xl rounded-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between p-6 bg-slate-800 border-b border-slate-700">
          <div>
            <h2 className="text-xl font-bold text-white">Quick Launch</h2>
            <p className="text-sm text-slate-400 mt-0.5">{scenario.title}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition"
          >
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-3">
          {configs.length === 0 ? (
            <p className="text-slate-400 text-sm text-center py-8">
              No saved configurations for this scenario yet. Use “Save configuration”
              on the launch screen to create one.
            </p>
          ) : (
            configs.map((cfg) => (
              <div
                key={cfg.id}
                className="flex items-center gap-3 p-4 bg-slate-800/60 border border-slate-700 rounded-lg hover:border-slate-600 transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-white font-semibold truncate">{cfg.name}</div>
                  <div className="text-xs text-slate-400 truncate">{summarize(cfg.config)}</div>
                </div>
                <button
                  onClick={() => onLaunch(cfg)}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg transition font-medium text-sm flex-shrink-0"
                  title="Launch this configuration"
                >
                  <Play size={16} />
                  Launch
                </button>
                <button
                  onClick={() => onEdit(cfg)}
                  className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition flex-shrink-0"
                  title="Edit configuration"
                >
                  <Pencil size={16} />
                </button>
                <button
                  onClick={() => setDeleteTarget(cfg)}
                  className="p-2 text-red-400 hover:text-white hover:bg-red-600 rounded-lg transition flex-shrink-0"
                  title="Delete configuration"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onConfirm={() => {
          if (deleteTarget) onDelete(deleteTarget);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
        title="Delete configuration"
        message={`Delete the saved configuration “${deleteTarget?.name}”? This can't be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
}
