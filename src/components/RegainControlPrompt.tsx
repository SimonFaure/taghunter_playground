// "Regain control" startup prompt (mother-failover).
//
// Scenario: device M was the mother, it failed, device S was promoted, then
// everything restarts. On boot M's epoch fence (slice 6) makes it stand down
// because S advertises a higher epoch - leaving M idle with the console line
// "standing down - another device is the current mother (higher epoch)".
//
// This prompt detects exactly that situation (`get_takeover_target`: this device
// has an active LOCAL game but a different, higher-epoch mother is live on the
// LAN) and offers the operator a one-tap takeover. Takeover pulls the live
// mother's CURRENT state first, then promotes - so no data is lost. It's a
// deliberate operator choice, never automatic.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Crown, AlertTriangle, Loader2, CheckCircle, X } from 'lucide-react';
import { takeoverMother, type TakeoverTarget } from '../services/lanMotherBoot';

type Phase = 'confirm' | 'taking' | 'success' | 'error';

export function RegainControlPrompt({ clientId }: { clientId: number | null }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<TakeoverTarget | null>(null);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [error, setError] = useState('');

  useEffect(() => {
    if (clientId == null) return;
    let cancelled = false;
    // One-shot check a few seconds after boot, once ensureMotherServer has had a
    // chance to start/stand-down. get_takeover_target only returns a target when
    // this device has an active LOCAL game AND a higher-epoch mother is live.
    const id = setTimeout(async () => {
      try {
        const tgt = await invoke<TakeoverTarget | null>('get_takeover_target', { clientId });
        if (!cancelled && tgt) setTarget(tgt);
      } catch {
        /* no target / browse failed - nothing to prompt */
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [clientId]);

  if (!target) return null;

  const takeover = async () => {
    setPhase('taking');
    setError('');
    try {
      await takeoverMother(target);
      setPhase('success');
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
      setPhase('error');
    }
  };

  const dismissable = phase !== 'taking';
  const close = () => setTarget(null);

  return (
    <div
      className="pg-overlay p-4"
      style={{ zIndex: 6200 }}
      onClick={dismissable ? close : undefined}
    >
      <div className="pg-modal max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="pg-modal-head">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-yellow-400/15 flex items-center justify-center">
              <Crown size={16} className="text-yellow-400" />
            </div>
            <h2 className="pg-modal-title">
              {t('failover:regainTitle', { defaultValue: 'Take back control?' })}
            </h2>
          </div>
          {dismissable && (
            <button onClick={close} className="pg-modal-close">
              <X size={16} />
            </button>
          )}
        </div>

        <div className="p-6">
          {phase === 'confirm' && (
            <div className="space-y-5">
              <p className="text-sm text-[var(--pg-text)]">
                {t('failover:regainBody', {
                  defaultValue:
                    'The game "{{name}}" is currently hosted by another device - it took over while this one was offline. Take back control on this device?',
                  name: target.game_name,
                })}
              </p>
              <div className="flex items-center gap-2 text-xs text-[var(--pg-text-dim)]">
                <AlertTriangle size={14} className="text-yellow-400 shrink-0" />
                <span>
                  {t('failover:regainNote', {
                    defaultValue:
                      'This device pulls the latest game state from the current host before taking over, so nothing is lost.',
                  })}
                </span>
              </div>
              <div className="flex gap-2.5">
                <button onClick={close} className="pg-btn flex-1 justify-center">
                  {t('failover:regainKeep', { defaultValue: 'Keep current host' })}
                </button>
                <button onClick={takeover} className="pg-btn pg-btn--primary flex-1 justify-center">
                  <Crown size={16} />
                  {t('failover:regainConfirm', { defaultValue: 'Take over' })}
                </button>
              </div>
            </div>
          )}

          {phase === 'taking' && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <Loader2 size={28} className="animate-spin text-[var(--pg-accent-bright)]" />
              <p className="text-sm text-[var(--pg-text)]">
                {t('failover:regainTaking', {
                  defaultValue: 'Pulling the latest state and taking over…',
                })}
              </p>
            </div>
          )}

          {phase === 'success' && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <CheckCircle size={28} className="text-green-400" />
                <p className="text-sm text-[var(--pg-text)]">
                  {t('failover:regainDone', {
                    defaultValue:
                      'This device is now the mother. Open the game to continue - other devices will reconnect.',
                  })}
                </p>
              </div>
              <button onClick={close} className="pg-btn pg-btn--primary w-full justify-center">
                {t('failover:done', { defaultValue: 'Done' })}
              </button>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-5">
              <div className="flex items-start gap-2.5">
                <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-[var(--pg-text)]">{error}</p>
              </div>
              <div className="flex gap-2.5">
                <button onClick={close} className="pg-btn flex-1 justify-center">
                  {t('failover:close', { defaultValue: 'Close' })}
                </button>
                <button onClick={takeover} className="pg-btn pg-btn--primary flex-1 justify-center">
                  {t('failover:retry', { defaultValue: 'Retry' })}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
