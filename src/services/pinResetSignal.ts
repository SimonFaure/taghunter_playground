// One-liner cross-tree signal for "the device PIN was just cleared via an
// offline recovery code". Used so the app can raise a non-blocking banner
// prompting the operator to set a new PIN in Settings.
//
// A plain window CustomEvent (rather than syncEvents) because the firing
// component can live OUTSIDE the React tree that renders the banner — e.g.
// FullscreenHint mounts at the app root, beside <App>, not inside it.

const EVENT = 'taghunter:pin-reset';

export function signalPinReset(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* non-DOM env — no-op */
  }
}

export function onPinReset(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
