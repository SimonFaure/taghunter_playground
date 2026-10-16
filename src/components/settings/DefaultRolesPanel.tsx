import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, Loader2, Satellite } from 'lucide-react';
import { CONFIG_CHANGED_EVENT } from '../../utils/config';
import { isConfiguredMother, setConfiguredMother } from '../../services/deviceRole';
import { demoteFromMother, HostingActiveGameError } from '../../services/lanMotherBoot';
import { relaunchToApply } from '../../services/appRelaunch';
import { ErrorDetails } from '../ErrorDetails';
import { useAuth } from '../auth/AuthProvider';

type Role = 'mother' | 'satellite';

// "Rôle de ce poste" (retours sept. #10): this PC is the mother, or a
// satellite. One choice, confirmed, applied through a relaunch. It is the only
// place (with the install-time question) that changes the role - a takeover
// never does - and the role shown is the configured one, nothing else: it used
// to read "Poste mère" on a PC that had merely taken a game over.
// Setting a PC as the mother moves the role: Studio keeps one mother per
// licensee, and the former mother becomes a satellite when it sees this one.
export function DefaultRolesPanel() {
  const { t } = useTranslation('devicesLan');
  const auth = useAuth();
  const [current, setCurrent] = useState<Role | null>(null);
  const [pending, setPending] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    const refresh = async () => {
      setCurrent((await isConfiguredMother()) ? 'mother' : 'satellite');
    };
    void refresh();
    // Re-read when another flow changes the role (e.g. this PC giving it up to
    // a mother designated after it).
    const onChanged = () => void refresh();
    window.addEventListener(CONFIG_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONFIG_CHANGED_EVENT, onChanged);
  }, []);

  async function apply(next: Role) {
    setBusy(true);
    setErr(null);
    try {
      // Refuses (HostingActiveGameError) while this PC alone hosts a running game.
      if (next === 'satellite') await demoteFromMother(auth.user?.client_id);
      await setConfiguredMother(next === 'mother');
      setCurrent(next);
      await relaunchToApply(1200);
    } catch (e) {
      setErr(
        e instanceof HostingActiveGameError
          ? { message: t('failover:errHostingActiveGame', { name: e.gameName }), detail: null }
          : e,
      );
      setBusy(false);
      setPending(null);
    }
  }

  if (current === null) {
    return (
      <div className="flex items-center gap-2 text-[var(--pg-text-dim)]">
        <Loader2 className="w-4 h-4 animate-spin" /> …
      </div>
    );
  }

  const shown = pending ?? current;
  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold text-[var(--pg-text)]">{t('roleChoiceLabel')}</div>
      <div className="grid sm:grid-cols-2 gap-3">
        {(['mother', 'satellite'] as const).map((r) => {
          const active = shown === r;
          const Icon = r === 'mother' ? Crown : Satellite;
          return (
            <button
              key={r}
              type="button"
              disabled={busy}
              onClick={() => setPending(r === current ? null : r)}
              className={`flex items-start gap-3 p-4 rounded-lg border-2 text-left disabled:opacity-50 ${
                active ? 'border-[var(--pg-accent)]' : 'border-[var(--pg-line)] hover:bg-[var(--pg-surface-3)]'}`}
            >
              <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${active ? 'text-[var(--pg-accent-bright)]' : 'text-[var(--pg-text-dim)]'}`} />
              <span>
                <span className="block font-semibold text-[var(--pg-text)]">
                  {r === 'mother' ? t('roleChoiceMother') : t('roleChoiceSatellite')}
                </span>
                <span className="block text-sm text-[var(--pg-text-dim)]">
                  {r === 'mother' ? t('roleChoiceMotherHint') : t('roleChoiceSatelliteHint')}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {pending && (
        <div className="p-3 rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)] space-y-2">
          <p className="text-sm text-[var(--pg-text)]">
            {pending === 'mother' ? t('roleChoiceToMotherWarn') : t('roleChoiceToSatelliteWarn')}
          </p>
          <p className="text-xs text-[var(--pg-text-dim)]">{t('relaunchNote')}</p>
          <div className="flex gap-2">
            <button className="pg-btn" disabled={busy} onClick={() => setPending(null)}>
              {t('notMotherCancel')}
            </button>
            <button className="pg-btn pg-btn--danger" disabled={busy} onClick={() => void apply(pending)}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {busy ? t('relaunchingToApply') : t('relaunchConfirm')}
            </button>
          </div>
        </div>
      )}
      {err != null && <ErrorDetails error={err} />}
    </div>
  );
}
