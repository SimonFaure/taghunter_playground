# Tag Hunter Playground

Tauri 2 desktop/mobile app for browsing and running Tag Hunter game scenarios.

## Development

```sh
npm install
npm run tauri:dev
```

## App self-update

Desktop builds (Windows/macOS/Linux) update themselves via `tauri-plugin-updater`.
Mobile builds (Android/iOS) cannot self-install — they show the same update
screens but deep-link to the app stores.

### Building a release

The bundle config has `createUpdaterArtifacts: true`, so `tauri build` emits an
updater artifact **and** a `.sig` signature next to it. Signing needs the
updater private key in the environment:

```sh
# PowerShell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME\.tauri\playground_updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""   # key was generated without a password
npm run tauri:build
```

The matching public key is committed in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`). The keypair was generated with
`tauri signer generate -w ~/.tauri/playground_updater.key`.

> **Pre-launch note:** the updater key currently has no password. Before real
> distribution, regenerate it *with* a password (`tauri signer generate` then
> `-p <password>`), update the `pubkey` in `tauri.conf.json`, and ship that
> build manually — auto-update only works forward from a build that already
> carries the new public key.

### Publishing

1. `tauri build` (with the signing env vars above).
2. In the **studio admin → Releases** tab, upload the updater artifact and its
   `.sig` file, set the version, the `min_supported_version` floor, and notes,
   then mark it latest.
3. Clients pick it up on next launch (or via Settings → Updates).

The manifest endpoint is `backend/api/playground_update.php` in the studio
backend; artifacts are stored under `backend/releases/`.

### Known gap: OS code signing

The app binary is **not** OS-code-signed yet. Windows SmartScreen and macOS
Gatekeeper will warn on first install and on each update install. The Tauri
updater signature still guarantees the artifact's authenticity — the OS just
doesn't recognise the publisher. Acquiring OS code-signing certificates is a
deferred follow-up.

### First updater-capable build

The pre-updater `1.0.0` build has no updater plugin and cannot auto-update.
`1.1.0` is the first updater-capable build and must be installed manually by
existing users; every build from `1.1.0` onward updates itself.
