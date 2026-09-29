// A plain-language error line with the raw technical text tucked behind a
// "Détails techniques" toggle (retours sept. #24). The operator reads what to
// do; support still gets the exact message when asked for it.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { describeFailoverError, type DescribedError } from '../services/failoverErrors';

interface Props {
  /** Either a caught error (decoded here) or an already described one. */
  error: unknown;
  className?: string;
  /** 'error' = red (default), 'warning' = amber. */
  tone?: 'error' | 'warning';
}

function isDescribed(e: unknown): e is DescribedError {
  return !!e && typeof e === 'object' && 'message' in e && 'detail' in e;
}

export function ErrorDetails({ error, className = '', tone = 'error' }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { message, detail } = isDescribed(error) ? error : describeFailoverError(error, t);
  const color = tone === 'warning' ? 'text-yellow-300' : 'text-red-300';
  const icon = tone === 'warning' ? 'text-yellow-400' : 'text-red-400';
  return (
    <div className={`flex items-start gap-2.5 ${className}`}>
      <AlertTriangle size={18} className={`${icon} shrink-0 mt-0.5`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--pg-text)]">{message}</p>
        {detail && (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className={`mt-1.5 inline-flex items-center gap-1 text-xs ${color} opacity-80 hover:opacity-100 underline`}
            >
              {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {t('sync:technicalDetails')}
            </button>
            {open && (
              <pre className="mt-1.5 text-xs bg-[var(--pg-bg)] text-[var(--pg-text-muted)] p-2 rounded overflow-x-auto whitespace-pre-wrap break-words select-text">
                {detail}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
