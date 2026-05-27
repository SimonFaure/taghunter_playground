// Resolver wrapper: locate the taghunter-help-content repo and run its generator,
// emitting into this app. Resolution order: $HELP_CONTENT_DIR → ./taghunter-help-content
// (future git submodule) → ../taghunter-help-content (sibling, current). Fails loudly if
// absent so a build never silently ships empty docs.
//
//   node scripts/help.mjs --app playground [--pdf]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const candidates = [
  process.env.HELP_CONTENT_DIR,
  path.join(appRoot, 'taghunter-help-content'),
  path.join(appRoot, '..', 'taghunter-help-content'),
].filter(Boolean);

const contentDir = candidates.find((d) => fs.existsSync(path.join(d, 'scripts', 'generate.mjs')));
if (!contentDir) {
  console.error(`[help] taghunter-help-content not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
    `Clone it next to this app (or set HELP_CONTENT_DIR) and run \`npm install\` there.`);
  process.exit(1);
}

const gen = path.join(contentDir, 'scripts', 'generate.mjs');
const r = spawnSync(process.execPath, [gen, ...process.argv.slice(2), '--out', appRoot], { stdio: 'inherit' });
process.exit(r.status ?? 1);
