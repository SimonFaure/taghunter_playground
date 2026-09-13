// Mother-failover slice 4/5/6 UI surface, mounted at the App root so it shows
// EVERYWHERE - including over the in-game renderer, where the footer is hidden.
//
// When a satellite loses contact with its mother (slice 5 flips the reachability
// flag), a red banner slides across the top with a "Become mother" button. The
// game id is resolved from the active game (if the game page is mounted) or the
// latest cached snapshot, so promotion works even from the games-list page.
// Clicking opens the confirmation modal (BecomeMotherModal) - a deliberate
// manual action, never an auto-prompt (design Q5/Q10).

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Crown, Link2, X } from 'lucide-react';
import { onMotherReachability, getPromotableGameId } from '../services/motherFailover';
import { rejoinCurrentMother } from '../services/childControlLink';
import { BecomeMotherModal } from './BecomeMotherModal';

export function MotherFailoverBanner() {
  const { t } = useTranslation();
  const [unreachable, setUnreachable] = useState(false);
  const [promoteGameId, setPromoteGameId] = useState<number | null>(null);
  // "Rejoin" is offered BEFORE "become mother": after a failover the mother the
  // device needs usually exists already, and rejoining it keeps one mother for
  // the game. Promotion is the heavier answer, for when there is none.
  const [rejoining, setRejoining] = useState(false);
  const [rejoinFailed, setRejoinFailed] = useState(false);
  // Set when the operator clicks "Become mother" but this device never cached a
  // game (nothing to adopt). Shows a brief inline note instead of silently doing
  // nothing.
  const [noGame, setNoGame] = useState(false);
  // Operator-dismissed: hide the banner until the mother is reachable again (we
  // re-arm on the next false→… transition) so it doesn't nag. The warning does
  // NOT auto-clear on its own - only a successful promotion / re-point or this
  // dismiss hides it.
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      onMotherReachability((u) => {
        setUnreachable(u);
        if (!u) setDismissed(false); // reachable again → re-arm for next outage
      }),
    []
  );

  const showBanner = unreachable && !dismissed && promoteGameId == null;
  if (!showBanner && promoteGameId == null) return null;

  return (
    <>
      {showBanner && (
        <div
          className="fixed top-0 left-0 right-0 flex items-center justify-center gap-3 px-4 py-2 bg-red-600/95 text-white shadow-lg"
          style={{ zIndex: 6000 }}
        >
          <AlertTriangle size={18} className="shrink-0" />
          <span className="text-sm font-medium">
            {noGame
              ? t('failover:bannerNoGame', {
                  defaultValue:
                    'This device has no saved game to take over - promote a device that was in the game.',
                })
              : rejoinFailed
                ? t('failover:rejoinNotFound', {
                    defaultValue: 'No mother found for this game on the network.',
                  })
                : t('failover:bannerText', {
                    defaultValue: 'Lost contact with the mother device.',
                  })}
          </span>
          <button
            type="button"
            disabled={rejoining}
            onClick={async () => {
              setRejoining(true);
              setRejoinFailed(false);
              try {
                const outcome = await rejoinCurrentMother();
                if (outcome === 'not_found') setRejoinFailed(true);
              } finally {
                setRejoining(false);
              }
            }}
            className="ml-2 inline-flex items-center gap-1.5 rounded-md bg-white/15 hover:bg-white/25 disabled:opacity-60 px-3 py-1 text-sm font-semibold transition-colors"
          >
            <Link2 size={15} />
            {rejoining
              ? t('failover:rejoinWorking', { defaultValue: 'Reconnecting…' })
              : t('failover:rejoinBtn', { defaultValue: 'Rejoin the mother' })}
          </button>
          {!noGame && (
            <button
              type="button"
              onClick={async () => {
                const gid = await getPromotableGameId();
                if (gid != null) setPromoteGameId(gid);
                else setNoGame(true);
              }}
              className="ml-2 inline-flex items-center gap-1.5 rounded-md bg-white/15 hover:bg-white/25 px-3 py-1 text-sm font-semibold transition-colors"
            >
              <Crown size={15} />
              {t('failover:becomeMotherConfirm', { defaultValue: 'Become mother' })}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="ml-1 p-1 rounded hover:bg-white/20 transition-colors"
            title={t('failover:dismiss', { defaultValue: 'Dismiss' })}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {promoteGameId != null && (
        <BecomeMotherModal
          launchedGameId={promoteGameId}
          onClose={() => setPromoteGameId(null)}
        />
      )}
    </>
  );
}
