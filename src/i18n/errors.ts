/**
 * User-facing error text thrown from the service layer.
 *
 * Services can't use the `useTranslation` hook, but the errors they throw DO
 * reach the screen: nearly every operator surface renders `err.message`
 * verbatim (LockScreen, CardsManager, UpdateProgress, ClientCardsPage, …). So
 * a hardcoded English `throw new Error('…')` shows up untranslated on a French
 * or Spanish device.
 *
 * `tError` resolves those sentences against the chrome language on the shared
 * i18next singleton (namespace `errors`). It is deliberately NOT the in-game
 * `tIngame`: these messages address the operator running the device, not the
 * players, so they follow the app language and not the launch language.
 *
 * Technical detail coming from Rust/Tauri or the network stack is left as-is -
 * it is diagnostic, not copy.
 */

import i18n from 'i18next';

export type ErrorKey =
  | 'authPersistFailed'
  | 'authPersistFailedEviction'
  | 'noCachedAccount'
  | 'deviceCapReached'
  | 'patternNoGameType'
  | 'patternNoRows'
  | 'scenarioNotDownloaded'
  | 'noPatternAvailable'
  | 'noMonitors'
  | 'noUpdateToDownload'
  | 'noUpdateToInstall'
  | 'motherUnreachable'
  | 'pinFourDigits';

/**
 * Localized text for a service-level error. Falls back to the English pivot
 * catalog (and finally to the key) if i18next hasn't booted yet - which only
 * happens if a service throws before `import './i18n'` in main.tsx has run.
 */
export function tError(key: ErrorKey, vars?: Record<string, string | number>): string {
  return i18n.t(`errors:${key}`, { ...vars, defaultValue: key }) as string;
}
