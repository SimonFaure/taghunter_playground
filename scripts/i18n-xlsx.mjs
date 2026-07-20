#!/usr/bin/env node
/**
 * Bucket-1 (chrome) translator round-trip CLI.
 *
 *   node scripts/i18n-xlsx.mjs export [out.xlsx]   # repo JSON  -> XLSX (send to translator)
 *   node scripts/i18n-xlsx.mjs import <in.xlsx>     # XLSX       -> repo JSON (after translation)
 *
 * One sheet per namespace. Columns: key · context · char_limit · en · <targets> · status.
 * English is the pivot/source. Staleness is tracked per (namespace, key, lang) in a sidecar
 * `src/i18n/.translation-hashes.json` by hashing the en source the translation was made against:
 * export flags empty cells NEW and changed-source cells STALE; import restamps from the row's en.
 *
 * `context`/`char_limit` are passthrough columns (chrome keys carry no metadata today) - kept so
 * the schema matches the in-game (bucket-2) workbook. Design: plan multilingual-app-translator-workflow.md.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(ROOT, 'src', 'i18n', 'locales');
const HASH_FILE = join(ROOT, 'src', 'i18n', '.translation-hashes.json');

// Mirror of src/i18n/languages.ts (en = pivot/source). Keep in sync.
const LANGS = ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'zh', 'ar'];
const PIVOT = 'en';
const TARGETS = LANGS.filter((l) => l !== PIVOT);
const HEADER = ['key', 'context', 'char_limit', 'en', ...TARGETS, 'status'];

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v == null ? '' : String(v);
  }
  return out;
};

const unflatten = (flat) => {
  const out = {};
  for (const [dotted, val] of Object.entries(flat)) {
    if (val === '') continue;
    const parts = dotted.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] ??= {};
    node[parts[parts.length - 1]] = val;
  }
  return out;
};

const nsPath = (lang, ns) => join(LOCALES_DIR, lang, `${ns}.json`);
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

/** All namespaces, derived from the en (source) catalog dir. */
function namespaces() {
  const dir = join(LOCALES_DIR, PIVOT);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

function cmdExport(outFile) {
  const hashes = readJson(HASH_FILE, {});
  const wb = XLSX.utils.book_new();
  for (const ns of namespaces()) {
    const byLang = Object.fromEntries(LANGS.map((l) => [l, flatten(readJson(nsPath(l, ns), {}))]));
    const keys = Object.keys(byLang[PIVOT]).sort();
    const rows = [HEADER];
    for (const key of keys) {
      const en = byLang[PIVOT][key] ?? '';
      const curHash = fnv1a(en);
      const statusBits = [];
      const targetCells = TARGETS.map((lang) => {
        const val = byLang[lang][key] ?? '';
        const stored = hashes[ns]?.[key]?.[lang];
        if (!val) statusBits.push(`${lang}:NEW`);
        else if (!stored || stored !== curHash) statusBits.push(`${lang}:STALE`);
        return val;
      });
      rows.push([key, '', '', en, ...targetCells, statusBits.join(' ')]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), ns.slice(0, 31));
  }
  const out = outFile || join(ROOT, 'chrome-translations.xlsx');
  writeFileSync(out, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  console.log(`Exported ${namespaces().length} namespaces → ${out}`);
}

function cmdImport(inFile) {
  if (!inFile || !existsSync(inFile)) {
    console.error('Usage: node scripts/i18n-xlsx.mjs import <in.xlsx>');
    process.exit(1);
  }
  const wb = XLSX.read(readFileSync(inFile), { type: 'buffer' });
  const hashes = readJson(HASH_FILE, {});
  let written = 0;
  for (const sheetName of wb.SheetNames) {
    const ns = sheetName;
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    if (aoa.length < 2) continue;
    const header = aoa[0].map((h) => String(h).trim());
    const col = (n) => header.indexOf(n);
    const keyCol = col('key');
    const enCol = col('en');
    if (keyCol < 0 || enCol < 0) continue;
    const langCols = TARGETS.map((l) => [l, col(l)]).filter(([, c]) => c >= 0);

    // Accumulate per-lang flat maps for this namespace.
    const perLang = Object.fromEntries(LANGS.map((l) => [l, {}]));
    hashes[ns] ??= {};
    for (let r = 1; r < aoa.length; r++) {
      const row = aoa[r];
      const key = String(row[keyCol] ?? '').trim();
      if (!key) continue;
      const en = String(row[enCol] ?? '').trim();
      perLang[PIVOT][key] = en;
      const enHash = fnv1a(en);
      for (const [lang, c] of langCols) {
        const val = String(row[c] ?? '').trim();
        if (!val) continue;
        perLang[lang][key] = val;
        (hashes[ns][key] ??= {})[lang] = enHash;
      }
    }
    // Write back each lang's namespace file (merging onto existing, so langs/keys
    // absent from the sheet are preserved).
    for (const lang of LANGS) {
      const existed = existsSync(nsPath(lang, ns));
      const merged = { ...flatten(readJson(nsPath(lang, ns), {})), ...perLang[lang] };
      // Don't create empty {} files for languages the translator left blank.
      if (!existed && Object.keys(merged).length === 0) continue;
      const dir = join(LOCALES_DIR, lang);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(nsPath(lang, ns), JSON.stringify(unflatten(merged), null, 2) + '\n');
      written++;
    }
  }
  writeFileSync(HASH_FILE, JSON.stringify(hashes, null, 2) + '\n');
  console.log(`Imported ${inFile} → ${written} catalog files updated; hashes restamped.`);
}

/**
 * One-time baseline: record the current en-hash for every already-populated
 * (namespace, key, lang) cell, so the existing hand-authored corpus reads as
 * fresh (OK) instead of STALE. Run once after seeding; thereafter only genuine
 * en-source changes flip a cell to STALE.
 */
function cmdStamp() {
  const hashes = readJson(HASH_FILE, {});
  let stamped = 0;
  for (const ns of namespaces()) {
    const en = flatten(readJson(nsPath(PIVOT, ns), {}));
    hashes[ns] ??= {};
    for (const lang of TARGETS) {
      const flat = flatten(readJson(nsPath(lang, ns), {}));
      for (const [key, val] of Object.entries(flat)) {
        if (!val || en[key] == null) continue;
        (hashes[ns][key] ??= {})[lang] = fnv1a(en[key]);
        stamped++;
      }
    }
  }
  writeFileSync(HASH_FILE, JSON.stringify(hashes, null, 2) + '\n');
  console.log(`Stamped ${stamped} existing translations as fresh → ${HASH_FILE}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'export') cmdExport(arg);
else if (cmd === 'import') cmdImport(arg);
else if (cmd === 'stamp') cmdStamp();
else {
  console.error('Usage: node scripts/i18n-xlsx.mjs <export|import|stamp> [file]');
  process.exit(1);
}
