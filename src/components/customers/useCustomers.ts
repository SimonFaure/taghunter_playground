import { useCallback, useSyncExternalStore } from 'react';
import { listCustomers, onCustomersChanged, resolveCustomerId, type CustomersSnapshot } from '../../services/customersStore';
import { getSelectedCustomer, setSelectedCustomer } from '../../services/selectedCustomerStore';
import { onLanOverrideChange } from '../../services/api';
import { on } from '../../services/syncEvents';

// One shared view of the LAN's licensee customers (from the mother) for every
// screen (project_licensee_customers). Refreshed on: a customer change (sync
// download, quick-create, assignment), the end of a sync cycle (first manifest
// = studio support known), and a re-route to another mother. While the feature
// still reads "unsupported" - mother route not up yet, first sync not done -
// it retries every few seconds, so it shows up without leaving the page.

const EMPTY: CustomersSnapshot = { supported: false, customers: [], redirects: {}, played: [] };
const RETRY_UNSUPPORTED_MS = 15_000;

let snapshot: CustomersSnapshot = EMPTY;
let started = false;
let inFlight: Promise<void> | null = null;
let again = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function refresh(): void {
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = listCustomers()
    .then((s) => {
      snapshot = s;
      for (const l of listeners) l();
      // Keep the scenario-list selection valid: a merged customer follows its
      // target, an archived / deleted one is dropped.
      const sel = getSelectedCustomer();
      if (sel && s.supported) {
        const target = s.customers.find((c) => c.id === resolveCustomerId(s, sel.id));
        if (!target || target.archived) setSelectedCustomer(null);
        else if (target.id !== sel.id || target.name !== sel.name) setSelectedCustomer({ id: target.id, name: target.name });
      }
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = s.supported ? null : setTimeout(refresh, RETRY_UNSUPPORTED_MS);
    })
    .finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        refresh();
      }
    });
}

function start(): void {
  if (started) return;
  started = true;
  onCustomersChanged(refresh);
  on('cycle:finished', () => refresh());
  onLanOverrideChange(() => refresh());
  refresh();
}

function subscribe(cb: () => void): () => void {
  start();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = () => snapshot;

/** The LAN's licensee customers + played scenarios, shared and kept fresh. */
export function useCustomers(): { snapshot: CustomersSnapshot; reload: () => void } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const reload = useCallback(() => refresh(), []);
  return { snapshot: snap, reload };
}
