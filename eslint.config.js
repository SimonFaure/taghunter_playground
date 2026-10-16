import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import i18next from 'eslint-plugin-i18next';
import tseslint from 'typescript-eslint';

// Files whose user-facing chrome has been migrated to i18next (`t()`). The
// no-literal-string guard is enabled ONLY on these so the migration can't
// regress (a new hardcoded JSX string fails lint). As more files are swept,
// add them here. Un-swept files (in-game game pages/renderers/overlays,
// leaderboards, test harnesses, admin/dev tools) are intentionally absent -
// enabling the rule on them would flood lint with their not-yet-extracted text.
const I18N_GUARDED = [
  'src/App.tsx',
  'src/components/GameList.tsx',
  'src/components/ConfigurationPage.tsx',
  'src/components/LaunchedGamesList.tsx',
  'src/components/ClientCardsPage.tsx',
  'src/components/Footer.tsx',
  'src/components/LaunchGameModal.tsx',
  'src/components/TeamDetailsModal.tsx',
  'src/components/GameDevicesModal.tsx',
  'src/components/DevicesFleetModal.tsx',
  'src/components/LaunchedGameConfigModal.tsx',
  'src/components/ScoreWeightingFormula.tsx',
  'src/components/LaunchConfigModal.tsx',
  'src/components/ScenarioDetailsModal.tsx',
  'src/components/VideoControlModal.tsx',
  'src/components/OperatorVideoOverlay.tsx',
  'src/components/sync/SyncStatusPill.tsx',
  'src/components/sync/SyncFailureBanner.tsx',
  'src/components/sync/FirstLaunchProgress.tsx',
  'src/components/update/UpdateAvailableNotice.tsx',
  'src/components/update/UpdateProgress.tsx',
  'src/components/update/UpdateRequiredOverlay.tsx',
  'src/components/PinExitPrompt.tsx',
  'src/components/RecoveryCodePrompt.tsx',
  'src/components/FullscreenHint.tsx',
  'src/components/LogoLaunchScreen.tsx',
  'src/components/AdminPasswordModal.tsx',
  // Category-A operator-chrome sweep (2026-07-13): settings tabs, cards,
  // auth screens, PIN flow, and operator control modals.
  'src/components/cards/CardsManager.tsx',
  'src/components/settings/UsbDriverScreen.tsx',
  'src/components/settings/SyncStatusScreen.tsx',
  'src/components/settings/MyDevicesScreen.tsx',
  'src/components/settings/AccountScreen.tsx',
  'src/components/settings/DevicePinSettings.tsx',
  'src/components/auth/LoginScreen.tsx',
  'src/components/auth/AuthProvider.tsx',
  'src/components/auth/LockScreen.tsx',
  'src/components/auth/OfflineGraceBanner.tsx',
  'src/components/auth/CapReachedDialog.tsx',
  'src/components/auth/AppDisabledScreen.tsx',
  'src/components/auth/SetPinScreen.tsx',
  'src/components/ClashClanDetailsModal.tsx',
  'src/components/RankingsModal.tsx',
  'src/components/AddTimeModal.tsx',
  'src/components/DevicePicker.tsx',
  'src/components/CardDetectionAlert.tsx',
  'src/components/ConfirmDialog.tsx',
  'src/components/Alert.tsx',
  // Error/alert sweep (2026-09-10): the operator wrapper around every game
  // (controls panel, end/delete confirmations, PIN prompts, fallback rankings)
  // and the LAN diagnostics panel, which was hardcoded French.
  'src/components/GamePage.tsx',
  'src/components/settings/LanDiagnostics.tsx',
  // Clash player-facing surfaces (2026-08-05): registration, live dashboard and
  // results all render in the LAUNCH language via the `ingame_clash` namespace,
  // so hardcoded display text is a regression here too.
  'src/components/ClashGamePage.tsx',
  'src/components/ClashGameRenderer.tsx',
  'src/components/ClashRegistrationScreen.tsx',
  'src/components/ClashResultsScreen.tsx',
  // Licensee "Report a problem" modal (launched-games page).
  'src/components/BugReportModal.tsx',
];

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  // i18n regression guard - only the migrated chrome files. `mode: 'jsx-only'`
  // checks JSX text + JSX attributes (not arbitrary TS strings), so plain logic
  // strings in these files are not flagged. The brand name and a couple of
  // operator labels are allow-listed.
  {
    files: I18N_GUARDED,
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          // Only flag visible JSX text nodes (not attributes / call args),
          // which keeps the guard focused on display copy and avoids the noise
          // of string props like page=/topic=/variant=. Attribute coverage was
          // handled during the sweep; this guard's job is to stop new hardcoded
          // visible text. The brand name is allow-listed.
          mode: 'jsx-text-only',
          framework: 'react',
          words: {
            // Restore the plugin defaults (we'd otherwise replace them), add a
            // catch-all for letter-free symbol/punctuation text nodes (●, ▾, -,
            // #, /, +, parentheses around interpolated values), and allow-list
            // the brand name.
            exclude: [
              '[0-9!-/:-@[-`{-~]+',
              '[A-Z_-]+',
              /^\p{Emoji}+$/u,
              /^[^\p{L}]+$/u,
              'Taghunter Playground',
              // Brand name split across spans in the top-nav (App.tsx).
              'TAG HUNTER',
              'Playground',
            ],
          },
        },
      ],
    },
  },
);
