import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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
function summarize(c: SavedLaunchConfig, t: TFunction): string {
  const parts: string[] = [];
  if (c.autoRegisterTeam) parts.push(t('launchConfig:summaryAutoRegister'));
  else if (c.selfRegisterTeam) parts.push(t('launchConfig:summarySelfRegister'));
  else if (typeof c.numberOfTeams === 'number') {
    parts.push(t('launchConfig:summaryTeamCount', { count: c.numberOfTeams }));
  }
  if (c.duration) parts.push(t('launchConfig:summaryDuration', { duration: c.duration }));
  if (c.victoryType) parts.push(c.victoryType);
  if (c.playMode) parts.push(c.playMode);
  if (c.route) parts.push(c.route);
  if (c.displayMode) parts.push(c.displayMode);
  if (c.reuseCards) parts.push(t('launchConfig:summaryReuseCards'));
  if (c.useNamePool) parts.push(t('launchConfig:summaryNamePool'));
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
  const { t } = useTranslation();
  const [deleteTarget, setDeleteTarget] = useState<LaunchConfigRow | null>(null);

  if (!isOpen) return null;

  return (
    <div className="pg-overlay">
      <div className="pg-modal max-w-2xl">
        <div className="pg-modal-head">
          <div>
            <h2 className="pg-modal-title">{t('launchConfig:title')}</h2>
            <p className="pg-modal-sub mt-0.5">{scenario.title}</p>
          </div>
          <button
            onClick={onClose}
            className="pg-modal-close"
          >
            <X size={24} />
          </button>
        </div>

        <div className="pg-modal-body space-y-3">
          {configs.length === 0 ? (
            <p className="text-[var(--pg-text-dim)] text-sm text-center py-8">
              {t('launchConfig:emptyState')}
            </p>
          ) : (
            configs.map((cfg) => (
              <div
                key={cfg.id}
                className="flex items-center gap-3 p-4 bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] hover:border-[var(--pg-line-strong)] transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--pg-text)] font-semibold truncate">{cfg.name}</div>
                  <div className="text-xs text-[var(--pg-text-dim)] truncate">{summarize(cfg.config, t)}</div>
                </div>
                <button
                  onClick={() => onLaunch(cfg)}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-[var(--pg-radius-md)] transition font-medium text-sm flex-shrink-0"
                  title={t('launchConfig:launchTitle')}
                >
                  <Play size={16} />
                  {t('launchConfig:launch')}
                </button>
                <button
                  onClick={() => onEdit(cfg)}
                  className="pg-icon-action flex-shrink-0"
                  title={t('launchConfig:editTitle')}
                >
                  <Pencil size={16} />
                </button>
                <button
                  onClick={() => setDeleteTarget(cfg)}
                  className="p-2 text-red-400 hover:text-white hover:bg-red-600 rounded-[var(--pg-radius-md)] transition flex-shrink-0"
                  title={t('launchConfig:deleteTitle')}
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
        title={t('launchConfig:deleteDialogTitle')}
        message={t('launchConfig:deleteDialogMessage', { name: deleteTarget?.name })}
        confirmText={t('launchConfig:delete')}
        cancelText={t('launchConfig:cancel')}
        variant="danger"
      />
    </div>
  );
}
