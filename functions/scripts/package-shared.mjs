// package-shared.mjs — BID-2B DETERMINISTIC PACKAGING of the approved shared root modules into the deployable functions/
// package (Firebase deploys ONLY functions/). The repository root stays the single authoritative source: this script
// copies the transitive import closure of the runtime entry module(s) BYTE-FOR-BYTE into functions/shared/ and writes
// functions/shared/MANIFEST.json with each file's source path, sha256 and size. Nothing is rewritten or forked; a copy
// that no longer matches its root source is STALE and is refused by verifySharedPackage() (dev) / integrity-checked
// against the manifest (deployed runtime, where the root is absent).
// Usage: node scripts/package-shared.mjs [--check]   (from functions/)   --check = verify only, exit 1 on drift
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PACKAGER_VERSION = 'sormena-shared-packager/1';
export const RUNTIME_ENTRIES = Object.freeze(['management-contract-core.mjs']);   // everything the signing runtime needs from the root
const FORBIDDEN_NAME = /(\.rules$|^firebase.*\.json$|^\.env|credential|adminsdk|\.pem$|\.key$|\.p12$|^index\.html$|\.firebaserc$|storage\.rules$)/i;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FUNCTIONS_DIR = path.resolve(HERE, '..');
export const ROOT_DIR = path.resolve(FUNCTIONS_DIR, '..');
export const SHARED_DIR = path.join(FUNCTIONS_DIR, 'shared');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const err = (code, detail) => Object.assign(new Error(code + (detail ? ': ' + detail : '')), { code });

// Transitive closure of `from './x.mjs'` imports, root-relative, deterministic order.
export function closureOf(rootDir, entries) {
  const seen = new Set(); const q = [...entries];
  while (q.length) {
    const f = q.shift(); if (seen.has(f)) continue;
    if (!/^[A-Za-z0-9._-]+\.mjs$/.test(f)) throw err('SHARED_MODULE_NAME_INVALID', f);
    if (FORBIDDEN_NAME.test(f)) throw err('SHARED_MODULE_FORBIDDEN', f);
    const p = path.join(rootDir, f);
    if (!fs.existsSync(p)) throw err('SHARED_SOURCE_MISSING', f);
    seen.add(f);
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/from '\.\/([^']+\.mjs)'/g)) q.push(m[1]);
  }
  return [...seen].sort();
}
export function buildManifest(rootDir, entries) {
  const files = closureOf(rootDir, entries).map((name) => { const b = fs.readFileSync(path.join(rootDir, name)); return { name, source: name, sha256: sha(b), bytes: b.length }; });
  return { packagerVersion: PACKAGER_VERSION, entries: [...entries], files };   // no timestamp: the manifest itself is deterministic
}
export function packageShared({ rootDir = ROOT_DIR, sharedDir = SHARED_DIR, entries = RUNTIME_ENTRIES } = {}) {
  const manifest = buildManifest(rootDir, entries);
  fs.rmSync(sharedDir, { recursive: true, force: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  for (const f of manifest.files) fs.copyFileSync(path.join(rootDir, f.source), path.join(sharedDir, f.name));   // byte-exact
  fs.writeFileSync(path.join(sharedDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
// Verifies functions/shared against its manifest (integrity) and, when the root is available, against the root sources
// (staleness). Throws SHARED_PACKAGE_MISSING | SHARED_PACKAGE_CORRUPT | SHARED_PACKAGE_STALE | SHARED_PACKAGE_EXTRA.
export function verifySharedPackage({ rootDir = ROOT_DIR, sharedDir = SHARED_DIR, requireRoot = false } = {}) {
  const mp = path.join(sharedDir, 'MANIFEST.json');
  if (!fs.existsSync(mp)) throw err('SHARED_PACKAGE_MISSING', 'run: node scripts/package-shared.mjs');
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (manifest.packagerVersion !== PACKAGER_VERSION) throw err('SHARED_PACKAGE_CORRUPT', 'packagerVersion ' + manifest.packagerVersion);
  for (const f of manifest.files) {
    const p = path.join(sharedDir, f.name);
    if (!fs.existsSync(p)) throw err('SHARED_PACKAGE_CORRUPT', 'missing ' + f.name);
    if (sha(fs.readFileSync(p)) !== f.sha256) throw err('SHARED_PACKAGE_CORRUPT', 'hash ' + f.name);
  }
  const extra = fs.readdirSync(sharedDir).filter((n) => n !== 'MANIFEST.json' && !manifest.files.some((f) => f.name === n));
  if (extra.length) throw err('SHARED_PACKAGE_EXTRA', extra.join(','));
  const rootAvailable = manifest.files.every((f) => fs.existsSync(path.join(rootDir, f.source)));
  if (!rootAvailable) { if (requireRoot) throw err('SHARED_ROOT_UNAVAILABLE'); return { ok: true, checkedAgainstRoot: false, files: manifest.files.length }; }
  const fresh = buildManifest(rootDir, manifest.entries);
  const stale = fresh.files.filter((f) => { const m = manifest.files.find((x) => x.name === f.name); return !m || m.sha256 !== f.sha256; }).map((f) => f.name);
  const removed = manifest.files.filter((m) => !fresh.files.some((f) => f.name === m.name)).map((m) => m.name);
  if (stale.length || removed.length) throw err('SHARED_PACKAGE_STALE', [...stale, ...removed.map((r) => '-' + r)].join(','));
  return { ok: true, checkedAgainstRoot: true, files: manifest.files.length };
}
// Deployable-package inventory: what would ship from functions/ (node_modules and test excluded), with forbidden names refused.
export function packageInventory({ functionsDir = FUNCTIONS_DIR } = {}) {
  const out = [];
  const walk = (dir, rel) => { for (const n of fs.readdirSync(dir).sort()) { const p = path.join(dir, n), r = rel ? rel + '/' + n : n; if (n === 'node_modules' || n === 'test' || n === '.git') continue; if (fs.statSync(p).isDirectory()) walk(p, r); else out.push(r); } };
  walk(functionsDir, '');
  const forbidden = out.filter((r) => FORBIDDEN_NAME.test(path.basename(r)));
  return { files: out, forbidden };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) { try { console.log(JSON.stringify(verifySharedPackage({ requireRoot: true }))); } catch (e) { console.error(e.code + (e.message ? ' ' + e.message : '')); process.exit(1); } }
  else { const m = packageShared(); console.log(JSON.stringify({ packaged: m.files.map((f) => f.name + '@' + f.sha256.slice(0, 12)), dir: SHARED_DIR })); }
}
