// Settings → Account → Team names. Read-only view of the team-name lists this
// client draws from at team creation (auto-register / reuse-cards): the shared
// DEFAULT catalog plus this client's own custom lists, grouped by audience and
// language. The one writable control is "Use my own lists only" - when on, draws
// use the client's list for an age, falling back to the default catalog only
// where the client has none. Authored in studio; this surface only views + the
// toggle persists through to studio (services/namePoolsStore.setOwnOnly).

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import {
  getTeamNamesView,
  refreshFromServer,
  setOwnOnly,
  type TeamNamesView,
  type PoolsByAudience,
} from '../../services/namePoolsStore';
import { audienceLabelKey, titleCaseSlug } from '../../utils/labels';

// Canonical audience order first, then anything off-list, alphabetically.
const AUDIENCE_ORDER = ['mini_kids', 'kids', 'ado_adultes'];
function sortedAudiences(pools: PoolsByAudience): string[] {
  return Object.keys(pools).sort((a, b) => {
    const ia = AUDIENCE_ORDER.indexOf(a);
    const ib = AUDIENCE_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
}

function countNames(pools: PoolsByAudience): number {
  let n = 0;
  for (const byLang of Object.values(pools)) {
    for (const names of Object.values(byLang)) n += names.length;
  }
  return n;
}

export function TeamNamesScreen() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [view, setView] = useState<TeamNamesView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Prefer a fresh pull (also heals the on-disk shape on older devices);
      // fall back to the local file when offline.
      let v: TeamNamesView;
      try {
        v = user?.client_id
          ? await refreshFromServer(user.client_id)
          : await getTeamNamesView();
      } catch {
        v = await getTeamNamesView();
      }
      if (alive) setView(v);
    })();
    return () => {
      alive = false;
    };
  }, [user?.client_id]);

  const onToggle = async (next: boolean) => {
    if (!user?.client_id || saving) return;
    setSaving(true);
    setError(null);
    const prev = view;
    // Optimistic flip so the checkbox feels instant.
    setView((v) => (v ? { ...v, ownOnly: next } : v));
    try {
      const fresh = await setOwnOnly(user.client_id, next);
      setView(fresh);
    } catch (err) {
      console.error('[TeamNamesScreen] setOwnOnly failed:', err);
      setView(prev); // roll back
      setError(t('teamNames:saveError'));
    } finally {
      setSaving(false);
    }
  };

  const audienceLabel = (audience: string): string => {
    const key = audienceLabelKey(audience);
    return key ? t(`home:${key}`) : titleCaseSlug(audience);
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-[var(--pg-text)] flex items-center gap-2">
        <Users size={22} /> {t('teamNames:title')}
      </h1>
      <p className="text-sm text-[var(--pg-text-dim)]">{t('teamNames:intro')}</p>

      {!view ? (
        <div className="flex items-center gap-2 text-[var(--pg-text-dim)] p-6">
          <Loader2 size={18} className="animate-spin" /> {t('teamNames:loading')}
        </div>
      ) : (
        <>
          {/* Use my own lists only */}
          <div className="pg-panel p-6">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[var(--pg-accent)]"
                checked={view.ownOnly}
                disabled={saving}
                onChange={(e) => void onToggle(e.target.checked)}
              />
              <span>
                <span className="block text-[var(--pg-text)] font-medium">
                  {t('teamNames:ownOnlyLabel')}
                </span>
                <span className="block text-xs text-[var(--pg-text-dim)] mt-0.5">
                  {t('teamNames:ownOnlyDesc')}
                </span>
              </span>
              {saving && <Loader2 size={16} className="animate-spin text-[var(--pg-text-dim)] mt-1" />}
            </label>
            {error && <div className="text-xs text-red-400 mt-3">{error}</div>}
          </div>

          <PoolGroup
            title={t('teamNames:customListsTitle')}
            subtitle={t('teamNames:customListsSubtitle')}
            pools={view.client}
            emptyText={t('teamNames:customListsEmpty')}
            audienceLabel={audienceLabel}
          />

          <PoolGroup
            title={t('teamNames:defaultListsTitle')}
            subtitle={t('teamNames:defaultListsSubtitle')}
            pools={view.global}
            emptyText={t('teamNames:defaultListsEmpty')}
            audienceLabel={audienceLabel}
          />
        </>
      )}
    </div>
  );
}

interface PoolGroupProps {
  title: string;
  subtitle: string;
  pools: PoolsByAudience;
  emptyText: string;
  audienceLabel: (audience: string) => string;
}

function PoolGroup({ title, subtitle, pools, emptyText, audienceLabel }: PoolGroupProps) {
  const audiences = sortedAudiences(pools);
  const total = countNames(pools);

  return (
    <div className="pg-panel p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold text-[var(--pg-text)]">{title}</h2>
        <span className="text-xs text-[var(--pg-text-dim)]">{total}</span>
      </div>
      <p className="text-xs text-[var(--pg-text-dim)] mb-4">{subtitle}</p>

      {total === 0 ? (
        <p className="text-sm text-[var(--pg-text-dim)] italic">{emptyText}</p>
      ) : (
        <div className="space-y-5">
          {audiences.map((audience) => (
            <div key={audience}>
              <div className="text-sm font-medium text-[var(--pg-text)] mb-2">
                {audienceLabel(audience)}
              </div>
              <div className="space-y-2">
                {Object.keys(pools[audience])
                  .sort()
                  .map((lang) => (
                    <div key={lang} className="flex gap-2">
                      <span className="shrink-0 mt-0.5 text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)] h-fit">
                        {lang}
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {pools[audience][lang].map((name, i) => (
                          <span
                            key={`${name}-${i}`}
                            className="text-xs px-2 py-0.5 rounded-full bg-[var(--pg-surface-3)] text-[var(--pg-text)]"
                          >
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
