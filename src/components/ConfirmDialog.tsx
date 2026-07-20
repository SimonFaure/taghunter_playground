import { AlertTriangle, Trash2, CheckCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ConfirmDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  /**
   * Stacking order for the overlay. Applied inline because `.pg-overlay`
   * (z-index: 50) is declared after `@tailwind utilities`, so a `z-[…]`
   * class would be out-weighed; an inline style beats the stylesheet rule.
   * Use a value above the modal this confirm is shown over.
   */
  overlayZIndex?: number;
}

export const ConfirmDialog = ({
  isOpen,
  onConfirm,
  onCancel,
  title,
  message,
  confirmText,
  cancelText,
  variant = 'warning',
  overlayZIndex,
}: ConfirmDialogProps) => {
  const { t } = useTranslation();
  if (!isOpen) return null;

  const variantStyles = {
    danger: {
      icon: Trash2,
      iconBg: 'bg-red-500/10',
      iconColor: 'text-red-500',
      button: 'pg-btn pg-btn--danger',
    },
    warning: {
      icon: AlertTriangle,
      iconBg: 'bg-amber-500/10',
      iconColor: 'text-amber-500',
      button: 'pg-btn pg-btn--primary',
    },
    info: {
      icon: CheckCircle,
      iconBg: 'bg-[var(--pg-accent-tint)]',
      iconColor: 'text-[var(--pg-accent-bright)]',
      button: 'pg-btn pg-btn--primary',
    },
  };

  const style = variantStyles[variant];
  const Icon = style.icon;

  return (
    <div className="pg-overlay" style={overlayZIndex != null ? { zIndex: overlayZIndex } : undefined}>
      <div className="pg-modal max-w-md animate-in zoom-in-95 duration-200">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className={`flex-shrink-0 w-12 h-12 rounded-full ${style.iconBg} flex items-center justify-center`}>
              <Icon className={`${style.iconColor}`} size={24} />
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-[var(--pg-text)] mb-2">
                {title}
              </h3>
              <p className="text-sm text-[var(--pg-text-muted)] leading-relaxed">
                {message}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--pg-line)] bg-[var(--pg-surface)]">
          <button
            onClick={onCancel}
            className="pg-btn"
          >
            {cancelText ?? t('dialogs:cancel')}
          </button>
          <button
            onClick={onConfirm}
            className={style.button}
          >
            {confirmText ?? t('dialogs:confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
