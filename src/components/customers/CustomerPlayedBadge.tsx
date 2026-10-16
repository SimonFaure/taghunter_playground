import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';

export interface PlayedInfo {
  last: string | null;
  count: number;
}

/** "Already played · 12/03/2026 (2×)" on a scenario card (project_licensee_customers). */
export function CustomerPlayedBadge({ played }: { played: PlayedInfo }) {
  const { t, i18n } = useTranslation('customers');
  const d = played.last ? new Date(played.last.replace(' ', 'T') + (played.last.endsWith('Z') ? '' : 'Z')) : null;
  const date = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(i18n.language) : '';
  const label = played.count > 1 ? t('playedBadgeCount', { count: played.count, date }) : t('playedBadge', { date });
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30"
      title={label}
    >
      <History size={12} />
      {label}
    </span>
  );
}
