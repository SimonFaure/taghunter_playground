// "Launch this config" channel: something outside the scenarios page (the
// game simulator's Coverage tab or a campaign) asks to open the Launch wizard
// for a scenario, pre-filled with a set of options. App switches to the
// scenarios page; GameList consumes the preset and opens its pre-filled
// wizard. One slot: a newer request replaces an unconsumed one.
//
// With `autopilot` (simulator campaigns, tester builds) the wizard walks its
// own steps and launches, as an operator pressing Next would.

import type { GameConfig } from '../components/LaunchGameModal';
import type { AutoSetup, WizardWorld } from '../simulator/coverage';

export interface WizardAutopilot {
  /** Resolves the combination once the wizard has loaded the scenario. */
  setup(world: WizardWorld): AutoSetup;
  /** The game was created (the game page opens next). */
  onLaunched(launchedGameId: number): void;
  /** The wizard could not launch; it closes. */
  onFail(reason: string): void;
}

export interface PresetLaunch {
  scenarioUniqid: string;
  scenarioTitle: string;
  gameTypeName: string;
  config: Partial<GameConfig>;
  /** Shown at the top of the wizard (e.g. the steps the preset can't set). */
  notice?: string;
  autopilot?: WizardAutopilot;
}

let pending: PresetLaunch | null = null;
const listeners = new Set<() => void>();

export function requestPresetLaunch(p: PresetLaunch): void {
  pending = p;
  listeners.forEach((l) => l());
}

export function takePresetLaunch(): PresetLaunch | null {
  const p = pending;
  pending = null;
  return p;
}

export function onPresetLaunch(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
