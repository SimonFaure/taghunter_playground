// Dev/QA harness for the offline recovery codes, registered on `window` so it
// can be driven from DevTools before the studio + sync slices land. Mirrors the
// lanSmokeTest / wifiIndicatorTest pattern (side-effect import in main.tsx).
//
// Usage in DevTools:
//   await window.__seedRecoveryCodes(['12345678', '87654321'])  // hash + store
//   await window.__seedRecoveryCodes()                          // 3 sample codes
//   await window.__clearRecoveryCodes()                         // wipe the pool
//
// Only registered in dev builds.
import { devSeedRecoveryCodes } from './recoveryCodesStore';
import { getDb } from './db';

declare global {
  interface Window {
    __seedRecoveryCodes?: (codes?: string[]) => Promise<string[]>;
    __clearRecoveryCodes?: () => Promise<void>;
  }
}

if (import.meta.env.DEV) {
  window.__seedRecoveryCodes = async (codes?: string[]) => {
    const list = codes ?? ['12345678', '23456789', '34567890'];
    await devSeedRecoveryCodes(list);
    console.info('[recoveryCodesDevTest] seeded', list.length, 'codes:', list);
    return list;
  };
  window.__clearRecoveryCodes = async () => {
    const db = await getDb();
    await db.execute('DELETE FROM recovery_codes');
    console.info('[recoveryCodesDevTest] cleared recovery codes');
  };
}

export {};
