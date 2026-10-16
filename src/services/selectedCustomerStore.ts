// The customer chosen above the scenario list (project_licensee_customers):
// "today I'm running games for X". Drives the "already played" badges and
// pre-fills the launch wizard. Lives across navigation and launches, never
// persisted - an app restart clears it.
import { useSyncExternalStore } from 'react';

export interface SelectedCustomer {
  id: string;
  name: string;
}

let selected: SelectedCustomer | null = null;
const listeners = new Set<() => void>();

export function getSelectedCustomer(): SelectedCustomer | null {
  return selected;
}

export function setSelectedCustomer(c: SelectedCustomer | null): void {
  if (selected?.id === c?.id && selected?.name === c?.name) return;
  selected = c;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSelectedCustomer(): SelectedCustomer | null {
  return useSyncExternalStore(subscribe, getSelectedCustomer, getSelectedCustomer);
}
