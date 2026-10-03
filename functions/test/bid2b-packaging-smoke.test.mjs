// bid2b-packaging-smoke.test.mjs — BID-2B: deterministic shared-module packaging + preprod smoke harness gates (unit; no
// emulator, no cloud). The complete synthetic smoke run is proven in test/emulator/bid2b-smoke.proof.mjs.
// Run: node test/bid2b-packaging-smoke.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installNetGuard, blocked } from './net-guard.mjs';
import { packageShared, verifySharedPackage, buildManifest, closureOf, packageInventory, RUNTIME_ENTRIES, PACKAGER_VERSION, ROOT_DIR, SHARED_DIR, FUNCTIONS_DIR } from '../scripts/package-shared.mjs';
import { assertSmokeGates, assertRunId, smokeFixture, runPreprodSmoke, makeSmokeHandler, SMOKE_TENANT, SMOKE_EMPLOYER } from '../src/preprod-smoke.mjs';
import { LIVE_CLOUD_WRITES_AUTHORIZED } from '../src/preprod-config.mjs';
import { LIVE_SMOKE_AUTHORIZATION } from '../src/live-smoke-gate.mjs';
import { generateContractPdf } from '../src/contract-pdf.mjs';
import { assertSharedPackageFresh } from '../index.mjs';
installNetGuard();

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }
const sha = (b) => createHash('sha256').update(b).digest('hex');
const code = (fn) => { try { fn(); return 'NO_THROW'; } catch (e) { return e.code; } };
const OK = { SORMENA_SIGNING_PROJECT_ID: 'sormena-bankid-preprod', SORMENA_SIGNING_BUCKET: 'sormena-bankid-preprod-signing-artifacts', SORMENA_SIGNING_REGION: 'europe-west1', SORMENA_PREPROD_SMOKE_ENABLED: 'true', SORMENA_SIGNING_ADAPTER_MODE: 'emulator', FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199' };
const touched = [];
const spyApp = { options: { projectId: 'sormena-bankid-preprod' } };
const spyDb = { databaseId: '(default)', doc: (p) => { touched.push(['doc', p]); throw new Error('DB_TOUCHED'); }, collection: (p) => { touched.push(['collection', p]); throw new Error('DB_TOUCHED'); }, runTransaction: async () => { touched.push(['tx']); throw new Error('DB_TOUCHED'); } };
const spyBucket = { name: 'sormena-bankid-preprod-signing-artifacts', file: (k) => { touched.push(['file', k]); throw new Error('BUCKET_TOUCHED'); }, getFiles: async () => { touched.push(['getFiles']); return [[]]; } };

// ---------------- packaging ----------------
await t('K01', 'PACKAGING from the current root: closure of management-contract-core.mjs = 6 modules (byte-exact copies), MANIFEST.json with source path + sha256 + bytes per file, packagerVersion; every packaged file byte-identical to its root source; no forbidden names', async () => {
  const m = packageShared();
  assert.deepEqual(m.entries, [...RUNTIME_ENTRIES]); assert.equal(m.packagerVersion, PACKAGER_VERSION);
  assert.deepEqual(m.files.map((f) => f.name), ['employee-schedule-week.mjs', 'employee-shell-core.mjs', 'management-contract-core.mjs', 'management-employees-core.mjs', 'management-schedule-core.mjs', 'schedule-core.mjs']);
  for (const f of m.files) { const root = fs.readFileSync(path.join(ROOT_DIR, f.source)), pk = fs.readFileSync(path.join(SHARED_DIR, f.name)); assert.ok(root.equals(pk), f.name); assert.equal(sha(pk), f.sha256); assert.equal(pk.length, f.bytes); }
  assert.deepEqual(closureOf(ROOT_DIR, RUNTIME_ENTRIES), m.files.map((f) => f.name));
  assert.deepEqual(verifySharedPackage({}), { ok: true, checkedAgainstRoot: true, files: 6 });
  assert.deepEqual(assertSharedPackageFresh(), { ok: true, checkedAgainstRoot: true, files: 6 });
});
await t('K02', 'REPEATABLE: packaging twice from unchanged source yields an identical shared/ tree (every file + MANIFEST.json byte-identical; no timestamp in the manifest)', async () => {
  const snap = () => Object.fromEntries(fs.readdirSync(SHARED_DIR).sort().map((n) => [n, sha(fs.readFileSync(path.join(SHARED_DIR, n)))]));
  const a = snap(); packageShared(); const b = snap();
  assert.deepEqual(b, a); assert.ok(!/generatedAt|timestamp|"date"/i.test(fs.readFileSync(path.join(SHARED_DIR, 'MANIFEST.json'), 'utf8')));
});
await t('K03', 'STALE / CORRUPT / EXTRA detection: a root source that changed after packaging -> SHARED_PACKAGE_STALE; a modified copy -> SHARED_PACKAGE_CORRUPT; an unmanifested file -> SHARED_PACKAGE_EXTRA; missing manifest -> SHARED_PACKAGE_MISSING; no root available -> integrity-only check', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bid2b-root-')), tmpShared = path.join(tmpRoot, 'functions-shared');
  for (const f of closureOf(ROOT_DIR, RUNTIME_ENTRIES)) fs.copyFileSync(path.join(ROOT_DIR, f), path.join(tmpRoot, f));
  packageShared({ rootDir: tmpRoot, sharedDir: tmpShared });
  assert.equal(verifySharedPackage({ rootDir: tmpRoot, sharedDir: tmpShared }).ok, true);
  fs.appendFileSync(path.join(tmpRoot, 'schedule-core.mjs'), '\n// changed after packaging\n');
  assert.equal(code(() => verifySharedPackage({ rootDir: tmpRoot, sharedDir: tmpShared })), 'SHARED_PACKAGE_STALE');
  packageShared({ rootDir: tmpRoot, sharedDir: tmpShared });
  fs.appendFileSync(path.join(tmpShared, 'schedule-core.mjs'), '\n// tampered copy\n');
  assert.equal(code(() => verifySharedPackage({ rootDir: tmpRoot, sharedDir: tmpShared })), 'SHARED_PACKAGE_CORRUPT');
  packageShared({ rootDir: tmpRoot, sharedDir: tmpShared });
  fs.writeFileSync(path.join(tmpShared, 'rogue.mjs'), 'export const x = 1;\n');
  assert.equal(code(() => verifySharedPackage({ rootDir: tmpRoot, sharedDir: tmpShared })), 'SHARED_PACKAGE_EXTRA');
  fs.rmSync(path.join(tmpShared, 'rogue.mjs'));
  const noRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bid2b-noroot-'));
  assert.deepEqual(verifySharedPackage({ rootDir: noRoot, sharedDir: tmpShared }), { ok: true, checkedAgainstRoot: false, files: 6 });
  assert.equal(code(() => verifySharedPackage({ rootDir: noRoot, sharedDir: tmpShared, requireRoot: true })), 'SHARED_ROOT_UNAVAILABLE');
  fs.rmSync(path.join(tmpShared, 'MANIFEST.json'));
  assert.equal(code(() => verifySharedPackage({ rootDir: tmpRoot, sharedDir: tmpShared })), 'SHARED_PACKAGE_MISSING');
  fs.rmSync(tmpRoot, { recursive: true, force: true }); fs.rmSync(noRoot, { recursive: true, force: true });
});
await t('K04', 'PACKAGE CONTENT: the deployable inventory (functions/ minus node_modules/test) contains only index.mjs, package.json, package-lock.json, scripts/, src/, shared/ — no rules, firebase*.json, .env, credentials, index.html or key material; a forbidden module name is refused by the packager; no secret-like literal in any shipped file', async () => {
  const inv = packageInventory();
  assert.deepEqual(inv.forbidden, []);
  for (const f of inv.files) assert.ok(/^(index\.mjs|package\.json|package-lock\.json|scripts\/(package-shared|run-live-smoke|live-net-guard)\.mjs|src\/[a-z-]+\.mjs|shared\/(MANIFEST\.json|[a-z-]+\.mjs))$/.test(f), 'unexpected file in package: ' + f);   // BID-2C: the local live-smoke runner + its allowlist guard (not functions; never exported for deploy)
  assert.equal(code(() => closureOf(ROOT_DIR, ['firestore.rules'])), 'SHARED_MODULE_NAME_INVALID');
  assert.equal(code(() => closureOf(ROOT_DIR, ['../functions/index.mjs'])), 'SHARED_MODULE_NAME_INVALID');
  for (const f of inv.files) { if (f === 'package-lock.json') continue; const s = fs.readFileSync(path.join(FUNCTIONS_DIR, f), 'utf8'); for (const re of [/client_secret\s*[:=]\s*['"][^'"]+/i, /Bearer\s+ey[A-Za-z0-9_-]{10,}/, /BEGIN (RSA|EC|PRIVATE)/, /sormena-prod\.firebasestorage|"sormena-prod"/]) assert.ok(!re.test(s), f + ' ~ ' + re); }
});
await t('K05', 'SEMANTICS PRESERVED: the runtime consumes functions/shared (contract-document imports ../shared/management-contract-core.mjs) and produces the SAME deterministic fixture PDF hash as before packaging (9937d465…)', async () => {
  assert.ok(fs.readFileSync(new URL('../src/contract-document.mjs', import.meta.url), 'utf8').includes("from '../shared/management-contract-core.mjs'"));
  const { frozenEmployee1 } = await import('./fixtures.mjs');
  const r = await generateContractPdf(frozenEmployee1().version);
  assert.equal(r.identity.sourcePdfSha256, '9937d46576552ccc236b879ac72aa4cd49055b96260d94d16fc7dd89124a9b7b');
});

// ---------------- smoke gates ----------------
await t('K06', 'SMOKE DISABLED BY DEFAULT: an environment with only the -010 target still refuses (REGION_MISSING / SMOKE_NOT_ENABLED / ADAPTER_MODE_REQUIRED in order); only the full explicit set passes (emulator mode)', async () => {
  const base = { SORMENA_SIGNING_PROJECT_ID: OK.SORMENA_SIGNING_PROJECT_ID, SORMENA_SIGNING_BUCKET: OK.SORMENA_SIGNING_BUCKET };
  assert.equal(code(() => assertSmokeGates({})), 'PROJECT_ID_MISSING');
  assert.equal(code(() => assertSmokeGates(base)), 'REGION_MISSING');
  assert.equal(code(() => assertSmokeGates(Object.assign({}, base, { SORMENA_SIGNING_REGION: 'europe-west1' }))), 'SMOKE_NOT_ENABLED');
  assert.equal(code(() => assertSmokeGates(Object.assign({}, base, { SORMENA_SIGNING_REGION: 'europe-west1', SORMENA_PREPROD_SMOKE_ENABLED: '1' }))), 'SMOKE_NOT_ENABLED');
  assert.equal(code(() => assertSmokeGates(Object.assign({}, base, { SORMENA_SIGNING_REGION: 'europe-west1', SORMENA_PREPROD_SMOKE_ENABLED: 'true' }))), 'ADAPTER_MODE_REQUIRED');
  const g = assertSmokeGates(OK); assert.equal(g.mode, 'emulator'); assert.equal(g.target.projectId, 'sormena-bankid-preprod');
});
await t('K07', 'LIVE MODE: missing SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED -> LIVE_WRITE_NOT_AUTHORIZED; with the flag, the general code constant (false) still refuses this run id -> LIVE_CLOUD_WRITES_NOT_AUTHORIZED (or LIVE_SMOKE_RUN_ID_NOT_AUTHORIZED while a BID-2C single-run literal authorizes another run)', async () => {
  assert.equal(LIVE_CLOUD_WRITES_AUTHORIZED, false);
  const unauth = LIVE_SMOKE_AUTHORIZATION.authorized === true ? 'LIVE_SMOKE_RUN_ID_NOT_AUTHORIZED' : 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED';
  assert.notEqual(LIVE_SMOKE_AUTHORIZATION.runId, 'smoke-abcd1234');
  assert.equal(code(() => assertSmokeGates(Object.assign({}, OK, { SORMENA_SIGNING_ADAPTER_MODE: 'live' }), { runId: 'smoke-abcd1234' })), 'LIVE_WRITE_NOT_AUTHORIZED');
  assert.equal(code(() => assertSmokeGates(Object.assign({}, OK, { SORMENA_SIGNING_ADAPTER_MODE: 'live', SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED: 'true' }), { runId: 'smoke-abcd1234' })), unauth);
});
await t('K08', 'PRODUCTION / WRONG TARGET refused before any read/write: sormena-prod in the explicit project, in GCLOUD_PROJECT, in the bucket; wrong project/bucket/region; GCLOUD_PROJECT alone never enables anything', async () => {
  for (const [env, c] of [
    [Object.assign({}, OK, { SORMENA_SIGNING_PROJECT_ID: 'sormena-prod' }), 'PRODUCTION_PROJECT_REFUSED'],
    [Object.assign({}, OK, { GCLOUD_PROJECT: 'sormena-prod' }), 'PRODUCTION_PROJECT_REFUSED'],
    [Object.assign({}, OK, { SORMENA_SIGNING_BUCKET: 'sormena-prod.firebasestorage.app' }), 'PRODUCTION_PROJECT_REFUSED'],
    [Object.assign({}, OK, { SORMENA_SIGNING_PROJECT_ID: 'sormena-bankid-test' }), 'PROJECT_MISMATCH'],
    [Object.assign({}, OK, { GCLOUD_PROJECT: 'other' }), 'PROJECT_CONFLICT'],
    [Object.assign({}, OK, { SORMENA_SIGNING_BUCKET: 'other-bucket' }), 'BUCKET_MISMATCH'],
    [Object.assign({}, OK, { SORMENA_SIGNING_REGION: 'us-central1' }), 'REGION_MISMATCH'],
    [{ GCLOUD_PROJECT: 'sormena-bankid-preprod', SORMENA_PREPROD_SMOKE_ENABLED: 'true', SORMENA_SIGNING_ADAPTER_MODE: 'emulator', SORMENA_SIGNING_REGION: 'europe-west1' }, 'PROJECT_ID_MISSING'],
  ]) {
    assert.equal(code(() => assertSmokeGates(env)), c, c);
    const r = await runPreprodSmoke({ app: spyApp, db: spyDb, bucket: spyBucket, env, runId: 'smoke-abcd1234' });
    assert.equal(r.refused, c); assert.deepEqual(r.steps, []);
  }
  assert.deepEqual(touched, [], 'no db/bucket handle touched by a refused run');
});
await t('K09', 'NARROW INPUT SURFACE: run id must match smoke-[a-z0-9]{4,32}; tenant/employee/paths/contract are fixed (tenant bankid-preprod-smoke, employee ansatt-<runId>, version kv-<runId>-1); the handler rejects any field other than runId and any malformed id BEFORE touching anything', async () => {
  for (const bad of ['', 'smoke', 'smoke-ABC', 'smoke-abc', 'smoke-' + 'a'.repeat(33), 'tenants/x/y', '../../etc', 'smoke-abcd1234; drop', 42, null]) assert.equal(code(() => assertRunId(bad)), 'SMOKE_RUN_ID_INVALID', String(bad));
  assert.equal(assertRunId('smoke-abcd1234'), 'smoke-abcd1234');
  const fx = smokeFixture('smoke-abcd1234');
  assert.equal(fx.ansattId, 'ansatt-smoke-abcd1234'); assert.equal(fx.version.contractVersionId, 'kv-smoke-abcd1234-1'); assert.equal(fx.version.status, 'godkjent_frosset');
  assert.equal(SMOKE_TENANT, 'bankid-preprod-smoke');
  const h = makeSmokeHandler({ app: spyApp, db: spyDb, bucket: spyBucket, env: OK });
  assert.equal((await h({ runId: 'bad id' })).body.code, 'SMOKE_RUN_ID_INVALID');
  assert.equal((await h({})).body.code, 'SMOKE_RUN_ID_INVALID');
  for (const extra of [{ tenantId: 'x' }, { ansattId: 'y' }, { bucket: 'z' }, { path: 'a/b' }, { pdf: 'JVBERi0=' }, { contract: {} }, { firestorePath: 'tenants/x' }]) { const r = await h(Object.assign({ runId: 'smoke-abcd1234' }, extra)); assert.equal(r.status, 400); assert.equal(r.body.code, 'UNEXPECTED_INPUT'); }
  assert.deepEqual(touched, []);
});
await t('K10', 'SYNTHETIC ONLY, DETERMINISTIC: the fixture is built from synthetic persons/company (Smoke Ansatt 01 / Smoke Representant / Smoke Arbeidsgiver AS), contains no real name, no NIN, no Test Ansatt 01, no production data; same run id => identical frozen version JSON and identical source PDF hash; different run id => same document content, different identity', async () => {
  const a = smokeFixture('smoke-abcd1234'), b = smokeFixture('smoke-abcd1234'), c = smokeFixture('smoke-zzzz9999');
  assert.equal(a.versionJson, b.versionJson); assert.notEqual(a.versionJson, c.versionJson);
  for (const bad of ['Test Ansatt 01', 'Herish', 'Four Season', 'sormena-prod', /\b\d{11}\b/]) assert.ok(!(bad instanceof RegExp ? bad.test(a.versionJson) : a.versionJson.includes(bad)), String(bad));
  assert.ok(a.versionJson.includes('Smoke Ansatt 01') && a.versionJson.includes('Smoke Representant') && a.versionJson.includes('Smoke Arbeidsgiver AS'));
  assert.equal(SMOKE_EMPLOYER.name, 'Smoke Representant');
  const pa = await generateContractPdf(a.version), pb = await generateContractPdf(b.version);
  assert.equal(pa.identity.sourcePdfSha256, pb.identity.sourcePdfSha256); assert.equal(pa.pageCount, 2);
  lines.push('INFO  K10  smoke source PDF sha256=' + pa.identity.sourcePdfSha256);
});
await t('K11', 'no network attempt in the packaging/smoke-gate path', async () => { assert.deepEqual(blocked, []); });

for (const l of lines) console.log(l);
console.log('BID2B_PACKAGING_SMOKE_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
