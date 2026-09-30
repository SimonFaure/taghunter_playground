import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, Loader2, Satellite } from 'lucide-react';
import { loadConfig, saveConfig, CONFIG_CHANGED_EVENT } from '../../utils/config';
import {
  setDefaultMother,
  enqueuePendingOp,
  getDefaultMotherLocal,
  setDefaultMotherLocal,
} from '../../services/lanNetworks';
import { demoteFromMother, HostingActiveGameError } from '../../services/lanMotherBoot';
import { relaunchToApply } from '../../services/appRelaunch';
import { ErrorDetails } from '../ErrorDetails';
import { useAuth } from '../auth/AuthProvider';

type Role = 'mother' | 'satellite';

// "Rôle de ce poste" (retours sept. #10). The two underlying flags - the
// studio-side "default mother" inventory bit and the local
// `beMotherWhenAvailable` boot flag - used to be two raw switches applied on
// click. The operator only ever means ONE thing: this PC is the mother, or a
// satellite. So: one choice, written to both flags, confirmed, and applied
// through a relaunch (same path as the mode switch and "I'm not a mother").
export function DefaultRolesPanel() {
  const { t } = useTranslation('devicesLan');
  const auth = useAuth();
  const [current, setCurrent] = useState<Role | null>(null);
  const [pending, setPending] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    const refresh = async () => {
      const [motherOn, cfg] = await Promise.all([getDefaultMotherLocal(), loadConfig()]);
      setCurrent(cfg.beMotherWhenAvailable || motherOn ? 'mother' : 'satellite');
    };
    void refresh();
    // Re-read when another flow changes the config (e.g. NotMotherPanel).
    const onChanged = () => void refresh();
    window.addEventListener(CONFIG_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONFIG_CHANGED_EVENT, onChanged);
  }, []);

  async function writeDefaultMother(on: boolean) {
    try {
      await setDefaultMother(on);
    } catch (e) {
      console.error('[network] set_default_mother failed, queued:', e);
      await enqueuePendingOp({ kind: 'mother', on, motherUuid: null });
    }
    await setDefaultMotherLocal(on);
  }

  async function apply(next: Role) {
    setBusy(true);
    setErr(null);
    try {
      if (next === 'satellite') {
        // Refuses (HostingActiveGameError) while this PC alone hosts a running game.
        await demoteFromMother(auth.user?.client_id);
        await writeDefaultMother(false);
      } else {
        const cfg = await loadConfig();
        await saveConfig({ ...cfg, beMotherWhenAvailable: true });
        await writeDefaultMother(true);
      }
      window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT));
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
