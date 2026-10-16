// Game simulator bus: lets the simulator answer the on-screen steps a real
// player or operator would (self-register name, picking the registration team,
// the Start button). Components subscribe with the SAME handlers a click would
// call - no DOM robot. Inert outside a simulation: nothing ever emits on it in
// licensee builds (the simulator is tester-only), so subscribers never fire.

import { useEffect, useRef } from 'react';

export type SimBusAction =
  /** The self-register overlay opened by this card's bip should submit this
   *  team name (and language). */
  | { kind: 'selfRegister'; name: string; language?: string; cardId?: number }
  /** The registration screen should select this team/clan before the next bip. */
  | { kind: 'selectTeam'; teamId: number }
  /** The registration screen's Start button. */
  | { kind: 'pressStart' }
  /** An Enter keypress (results "press Enter to reset" holds). */
  | { kind: 'pressEnter' }
  /** The results summary's reset button (manual reset holds). */
  | { kind: 'pressReset' };

type Listener = (a: SimBusAction) => void;
const listeners = new Set<Listener>();
type SelfRegisterAnswer = { name: string; language?: string; cardId?: number };
/** Self-register answers wait here until their card's overlay opens. Keyed by
 *  card so a queued prompt never takes another team's name. */
const pendingNames: SelfRegisterAnswer[] = [];

export function simBusEmit(a: SimBusAction): void {
  if (a.kind === 'selfRegister') pendingNames.push({ name: a.name, language: a.language, cardId: a.cardId });
  if (a.kind === 'pressEnter') {
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    } catch {
      /* non-DOM context */
    }
  }
  listeners.forEach((l) => l(a));
}

const answerIndex = (cardId?: number) =>
  pendingNames.findIndex((a) => a.cardId == null || cardId == null || a.cardId === cardId);

/** The answer waiting for this card's overlay (an answer without a card fits
 *  any), left in place: a prompt pushed under a newer one answers later. */
export function peekSelfRegisterAnswer(cardId?: number): SelfRegisterAnswer | null {
  const i = answerIndex(cardId);
  return i < 0 ? null : pendingNames[i];
}

/** Consume that answer (the overlay submits it). */
export function takeSelfRegisterAnswer(cardId?: number): SelfRegisterAnswer | null {
  const i = answerIndex(cardId);
  return i < 0 ? null : pendingNames.splice(i, 1)[0];
}

export function clearSimBus(): void {
  pendingNames.length = 0;
}

/** Subscribe a component to simulator actions (latest handler, no re-subscribe). */
export function useSimBus(handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const l: Listener = (a) => ref.current(a);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Human-ish pause before an auto-answer, so the screen is visible first. */
export const SIM_ANSWER_DELAY_MS = 1200;
