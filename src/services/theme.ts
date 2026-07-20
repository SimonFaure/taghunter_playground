// App colour theme (tactical red default, blue alternative). This is a pure
// per-device UI preference - it lives in localStorage so it can be applied
// synchronously at boot (no flash) before any async config read. The selector
// lives in Settings → Appearance; `applyTheme` flips the `data-theme` attribute
// on <html>, which the `--pg-*` tokens in index.css key off.

export type ThemeName = 'red' | 'blue' | 'red-light' | 'blue-light';

const STORAGE_KEY = 'pg-theme';

export function isThemeName(v: unknown): v is ThemeName {
  return v === 'red' || v === 'blue' || v === 'red-light' || v === 'blue-light';
}

/** Read the persisted theme, defaulting to the tactical red (the `:root` set). */
export function getStoredTheme(): ThemeName {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isThemeName(v)) return v;
  } catch {
    /* localStorage unavailable - fall through to default */
  }
  return 'red';
}

/** Reflect the theme onto <html> so the `--pg-*` token overrides take effect. */
export function applyTheme(theme: ThemeName): void {
  // Red is the default `:root` set, so no attribute is needed for it; keeping
  // the attribute present-and-explicit makes the current theme observable.
  document.documentElement.setAttribute('data-theme', theme);
}

/** Persist + apply in one call (used by the Settings selector). */
export function setTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* best-effort persistence */
  }
  applyTheme(theme);
}

/** Apply the stored theme. Call once as early as possible at startup. */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}
