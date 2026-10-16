// Signed Android release build (design: project_android_operator_tablet).
//
//   npm run android:release
//   npm run android:release:test   (Tester build: VITE_QA_HARNESS=1 + the Rust
//                                    `devtools` feature - game simulator, QA
//                                    harnesses; output name gets a -tester suffix)
//
// Builds ONE universal APK carrying arm64-v8a + armeabi-v7a, signed with the
// release key from src-tauri/gen/android/keystore.properties, then copies it to
// release-android/ as TagHunterPlayground_<version>.apk next to a .sha256 file
// (the hash Studio's upload expects). versionCode comes from tauri.conf.json's
// version (Tauri writes tauri.properties: 1.1.104 -> 1001104).

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(root, 'src-tauri', 'gen', 'android');
const keystoreProps = join(androidDir, 'keystore.properties');

if (!existsSync(keystoreProps)) {
  console.error(`Missing ${keystoreProps} - an unsigned APK can't be installed as an update.`);
  process.exit(1);
}
const storeFile = /^storeFile=(.+)$/m.exec(readFileSync(keystoreProps, 'utf8'))?.[1]?.trim();
if (!storeFile || !existsSync(storeFile)) {
  console.error(`keystore.properties storeFile not found: ${storeFile ?? '(unset)'}`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));

const tester = process.argv.includes('--tester');
execSync(`npx tauri android build --apk --target aarch64 armv7${tester ? ' --features devtools' : ''}`, {
  cwd: root,
  stdio: 'inherit',
  env: tester ? { ...process.env, VITE_QA_HARNESS: '1' } : process.env,
});

const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'universal', 'release', 'app-universal-release.apk');
if (!existsSync(apk)) {
  console.error(`Build finished but no APK at ${apk}`);
  process.exit(1);
}

const outDir = join(root, 'release-android');
mkdirSync(outDir, { recursive: true });
const outName = `TagHunterPlayground_${version}${tester ? '-tester' : ''}.apk`;
const outPath = join(outDir, outName);
copyFileSync(apk, outPath);

const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex');
writeFileSync(`${outPath}.sha256`, `${sha256}  ${outName}\n`);

const mb = (readFileSync(outPath).length / 1024 / 1024).toFixed(1);
console.log(`\n${outPath} (${mb} MB)\nsha256 ${sha256}`);
