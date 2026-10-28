// Mother-failover slice 4/5/6 UI surface, mounted at the App root so it shows
// EVERYWHERE - including over the in-game renderer, where the footer is hidden.
//
// When a satellite loses contact with its mother (slice 5 flips the reachability
// flag), a red banner slides across the bottom (the top during a game, where
// there is no top bar to cover) with a "Become mother" button. The game id is
// resolved from the active game (if the game page is mounted) or the latest
// cached snapshot, so promotion works even from the games-list page.
// Clicking opens the confirmation modal (BecomeMotherModal) - a deliberate
// manual action, never an auto-prompt (design Q5/Q10). The device that takes
// the game hosts it as a SUBSTITUTE: its role does not change, and it hands
// back when the mother returns.
//
// Two additions with the role split:
//  - the device SET as the mother never shows any of this. It does not look
//    for a mother: when nobody else hosts, it hosts.
//  - a device that finds no mother at all at start (nothing was "lost", so the
//    red banner never armed) gets a bar with "Héberger les parties en
//    remplacement". Nothing hosts by itself except the mother.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Crown, Link2, Loader2, X } from 'lucide-react';
import {
  onMotherReachState, onMotherTakeover, getPromotableGameId, type ReachState, type TakeoverMother,
} from '../services/motherFailover';
import { rejoinCurrentMother, refreshLaunchedGamesRoute } from '../services/childControlLink';
import { useLocalRole } from '../services/motherConnection';
import { onHostingNotice, canHostAsSubstitute, type HostingNotice } from '../services/hostingRole';
import { forceBecomeMother } from '../services/lanMotherBoot';
import { useInGame } from '../services/screenState';
import { useAuth } from './auth/AuthProvider';
import { BecomeMotherModal } from './BecomeMotherModal';
import { ErrorDetails } from './ErrorDetails';

export function MotherFailoverBanner() {
  const { t } = useTranslation();
  const auth = useAuth();
  const localRole = useLocalRole();
  // Bottom so the bar doesn't cover the top bar; top during a game.
  const edge = useInGame() ? 'top-0' : 'bottom-0';
  const [notice, setNotice] = useState<HostingNotice>({ kind: 'none' });
  const [hosting, setHosting] = useState(false);
  const [hostError, setHostError] = useState<unknown>(null);
  const [noMotherDismissed, setNoMotherDismissed] = useState(false);
  // The substitute came up with no running game (`forceBecomeMother` → 'empty').
  // Shown even on the device that now hosts, until dismissed.
  const [hostedEmpty, setHostedEmpty] = useState(false);
  useEffect(
    () =>
      onHostingNotice((n) => {
        setNotice(n);
        if (n.kind !== 'no_mother') {
          setNoMotherDismissed(false);
          setHostError(null);
        }
      }),
    []
  );
  // 'reconnecting': a calm amber bar, no buttons - the device is re-attaching on
  // its own and the operator must not start promoting things (retours sept.
  // #22). 'lost': ~1 min without real contact - the red banner with actions.
  const [reach, setReach] = useState<ReachState>('ok');
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
  // Another satellite already took over (retours sept. #10, first click wins):
  // no promote button any more - this device is joining it.
  const [taker, setTaker] = useState<TakeoverMother | null>(null);
  useEffect(() => onMotherTakeover(setTaker), []);

  useEffect(
    () =>
      onMotherReachState((st) => {
        setReach(st);
        if (st === 'ok') {
          setDismissed(false); // reachable again → re-arm for next outage
          setRejoinFailed(false);
          setNoGame(false);
        }
      }),
    []
  );

  // The mother never seeks a mother (and so never loses one).
  const isMother = localRole?.role === 'mother';
  const showTakeover = !isMother && taker != null && reach !== 'ok' && promoteGameId == null;
  const showReconnecting = !isMother && reach === 'reconnecting' && promoteGameId == null && !showTakeover;
  const showBanner = !isMother && reach === 'lost' && !dismissed && promoteGameId == null && !showTakeover;
  const showNoMother =
    !isMother && notice.kind === 'no_mother' && reach === 'ok' && !noMotherDismissed && promoteGameId == null;
  if (!showBanner && !showReconnecting && !showTakeover && !showNoMother && !hostedEmpty && promoteGameId == null) {
    return null;
  }

  const hostAsSubstitute = async () => {
    const clientId = auth.user?.client_id;
    if (clientId == null) return;
    setHosting(true);
    setHostError(null);
    try {
      const outcome = await forceBecomeMother(clientId, { allowIdle: true });
      await refreshLaunchedGamesRoute().catch(() => {});
      // This device hosts now, so the bar is about to go: carry the "nothing
      // could be recovered here" warning past it.
      if (outcome === 'empty') setHostedEmpty(true);
    } catch (e) {
      setHostError(e);
    } finally {
      setHosting(false);
    }
  };

  return (
    <>
      {hostedEmpty && (
        <div
          className={`fixed ${edge} left-0 right-0 flex flex-wrap items-center justify-center gap-3 px-4 py-2 bg-amber-500/95 text-black shadow-lg`}
          style={{ zIndex: 6000 }}
          role="status"
        >
          <AlertTriangle size={18} className="shrink-0" />
          <span className="text-sm font-medium">{t('failover:hostedEmpty')}</span>
          <button
            type="button"
            onClick={() => setHostedEmpty(false)}
            className="p-1 rounded hover:bg-black/20 transition-colors"
            title={t('failover:dismiss')}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {showNoMother && (
        <div
          className={`fixed ${edge} left-0 right-0 flex flex-wrap items-center justify-center gap-3 px-4 py-2 bg-amber-500/95 text-black shadow-lg`}
          style={{ zIndex: 6000 }}
          role="status"
        >
          <AlertTriangle size={18} className="shrink-0" />
          <span className="text-sm font-medium">{t('failover:bannerNoMother')}</span>
          {canHostAsSubstitute() && (
            <button
              type="button"
              disabled={hosting}
              onClick={() => void hostAsSubstitute()}
              className="inline-flex items-center gap-1.5 rounded-md bg-black/15 hover:bg-black/25 disabled:opacity-60 px-3 py-1 text-sm font-semibold transition-colors"
            >
              {hosting ? <Loader2 size={15} className="animate-spin" /> : <Crown size={15} />}
              {hosting ? t('failover:hostAsSubstituteWorking') : t('failover:hostAsSubstitute')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setNoMotherDismissed(true)}
            className="p-1 rounded hover:bg-black/20 transition-colors"
            title={t('failover:dismiss')}
          >
            <X size={16} />
          </button>
          {hostError != null && <ErrorDetails error={hostError} className="basis-full max-w-xl mx-auto" />}
        </div>
      )}
      {showTakeover && (
        <div
          className={`fixed ${edge} left-0 right-0 flex items-center justify-center gap-3 px-4 py-2 bg-amber-500/95 text-black shadow-lg`}
          style={{ zIndex: 6000 }}
          role="status"
        >
          <Loader2 size={16} className="shrink-0 animate-spin" />
          <span className="text-sm font-medium">
            {t('failover:takingOverBy', { name: taker?.label || t('failover:anotherDevice') })}
          </span>
        </div>
      )}
      {showReconnecting && (
        <div
          className={`fixed ${edge} left-0 right-0 flex items-center justify-center gap-3 px-4 py-2 bg-amber-500/95 text-black shadow-lg`}
          style={{ zIndex: 6000 }}
          role="status"
        >
          <Loader2 size={16} className="shrink-0 animate-spin" />
          <span className="text-sm font-medium">{t('failover:bannerReconnecting')}</span>
        </div>
      )}
      {showBanner && (
        <div
          className={`fixed ${edge} left-0 right-0 flex items-center justify-center gap-3 px-4 py-2 bg-red-600/95 text-white shadow-lg`}
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
          {/* A tablet never hosts (Android is operator-only). */}
          {!noGame && canHostAsSubstitute() && (
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
