import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface AdminPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function AdminPasswordModal({ isOpen, onClose, onSuccess }: AdminPasswordModalProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setError('');
    }
  }, [isOpen]);

  useEffect(() => {
    // Only react while the modal is actually open. The component stays mounted
    // when closed (it just returns null), so without this guard the retained
    // `password` ('1912') would re-fire onSuccess on every parent re-render -
    // because onSuccess/onClose get new identities each render - silently
    // re-entering admin mode and making "exit admin" impossible.
    if (!isOpen) return;
    if (password.length === 4) {
      if (password === '1912') {
        setPassword('');
        onSuccess();
        onClose();
      } else {
        setError(t('adminPassword:incorrect'));
        setPassword('');
      }
    }
  }, [isOpen, password, onSuccess, onClose, t]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
  };

  if (!isOpen) return null;

  return (
    <div className="pg-overlay">
      <div className="pg-modal max-w-md">
        <div className="pg-modal-head">
          <h2 className="pg-modal-title">{t('adminPassword:heading')}</h2>
          <button
            onClick={onClose}
            aria-label={t('adminPassword:close')}
            className="pg-modal-close"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="pg-modal-body">
          <div className="mb-4">
            <label htmlFor="password" className="pg-label">
              {t('adminPassword:label')}
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={4}
              className="pg-input w-full"
              autoFocus
              placeholder={t('adminPassword:placeholder')}
            />
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="pg-btn flex-1"
            >
              {t('adminPassword:cancel')}
            </button>
            <button
              type="submit"
              className="pg-btn pg-btn--primary flex-1"
            >
              {t('adminPassword:submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
