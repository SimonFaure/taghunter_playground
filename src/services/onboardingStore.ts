// First-launch onboarding state. Per-device, stored in the SQLite `schema_meta`
// key/value table (the same table device.ts / lanCredentials.ts use), so it is
// a pure machine property - a second operator account on the same PC does NOT
// redo onboarding. Design: plans/playground-first-launch-onboarding.md.
//
// The gate is a hard gate (AuthProvider blocks the app shell until done) and is
// resumable: each post-PIN step carries its own "answered" marker so a crash
// mid-wizard resumes at the first unanswered step. The OTP and PIN steps need
// no marker here - their state is the JWT (strongholdStore) and the device PIN
// (pinStore) respectively, which the auth gate already inspects.

import { getDb } from './db';
import { isAndroid } from '../utils/platform';

// schema_meta keys. `onboarding_completed` is the single commit flag set only
// when the final step (Appearance → Finish) lands.
const COMPLETED_KEY = 'onboarding_completed';
const LANG_KEY = 'onboarding_lang';       // step 0 answered
const LANG_TOUCHED_KEY = 'onboarding_lang_touched'; // operator explicitly picked a language
const NAMED_KEY = 'onboarding_named';      // step 4 answered
const MOTHER_KEY = 'onboarding_mother';    // step 6 answered
const OPERATOR_KEY = 'onboarding_operator_only'; // step 7 answered (before appearance)

export type OnboardingStepKey =
  | typeof LANG_KEY
  | typeof NAMED_KEY
  | typeof MOTHER_KEY
  | typeof OPERATOR_KEY;

async function readMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [key]
  );
  return rows.length > 0 ? rows[0].value : null;
}

async function writeMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

export async function isOnboardingComplete(): Promise<boolean> {
  return (await readMeta(COMPLETED_KEY)) === '1';
}

/** Commit point: the wizard's final step calls this once. */
export async function markOnboardingComplete(): Promise<void> {
  await writeMeta(COMPLETED_KEY, '1');
}

export async function isStepAnswered(key: OnboardingStepKey): Promise<boolean> {
  return (await readMeta(key)) === '1';
}

export async function markStepAnswered(key: OnboardingStepKey): Promise<void> {
  await writeMeta(key, '1');
}

// The operator deliberately picked a language on the first onboarding screen.
// Set once they tap a language option. When set, bootstrap must NOT override
// their choice with the client's account language. Design: project_client_language.
export async function markLangTouched(): Promise<void> {
  await writeMeta(LANG_TOUCHED_KEY, '1');
}

export async function isLangTouched(): Promise<boolean> {
  return (await readMeta(LANG_TOUCHED_KEY)) === '1';
}

export const ONBOARDING_KEYS = {
  lang: LANG_KEY,
  named: NAMED_KEY,
  mother: MOTHER_KEY,
  operatorOnly: OPERATOR_KEY,
} as const;

// The first post-PIN step (4–7) that hasn't been answered yet. Drives where the
// post-PIN wizard resumes. Appearance (step 7) is the trailing step and has no
// marker of its own - reaching it means everything before is done, so 'appearance'
// is returned once name/mother/operator-only are all answered. (The former
// 'hotspot' step was removed with the hotspot, 2026-09-30.)
export type PostPinStep = 'name' | 'mother' | 'operatorOnly' | 'appearance';

export async function firstUnansweredPostPinStep(): Promise<PostPinStep> {
  if (!(await isStepAnswered(NAMED_KEY))) return 'name';
  // Android tablets are locked operator-only and never host: no mother or
  // operator-only question to ask.
  if (isAndroid()) return 'appearance';
  if (!(await isStepAnswered(MOTHER_KEY))) return 'mother';
  if (!(await isStepAnswered(OPERATOR_KEY))) return 'operatorOnly';
  return 'appearance';
}
