// bid2a-preprod.test.mjs — BID-2A preprod resource binding (unit; no emulator, no cloud). Run: node test/bid2a-preprod.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installNetGuard, blocked } from './net-guard.mjs';
import { BANKID_PREPROD, FORBIDDEN_PROJECTS, LIVE_CLOUD_WRITES_AUTHORIZED, SIGNING_FUNCTION_OPTIONS, assertPreprodTarget, resolveSigningTarget, assertAdapterBinding } from '../src/preprod-config.mjs';
import { createGcsArtifactStore } from '../src/gcs-artifact-store.mjs';
import { createSigningTransactionRepository } from '../src/firestore-stores.mjs';
import { FUNCTION_OPTIONS, makeHttpFunction } from '../index.mjs';
import { generateKeyPair, exportJWK } from 'jose';
import { frozenEmployee1, T, NOW, ADMIN_UID } from './fixtures.mjs';
import { createFakeWysiwys } from '../src/fake-wysiwys.mjs';
import { createSigningService } from '../src/signing-service.mjs';
import { createMemoryTransactionStore, createMemoryArtifactStore } from '../src/stores.mjs';
installNetGuard();

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }
const code = (fn) => { try { fn(); return 'NO_THROW'; } catch (e) { return e.code; } };
const OK_ENV = { SORMENA_SIGNING_PROJECT_ID: 'sormena-bankid-preprod', SORMENA_SIGNING_BUCKET: 'sormena-bankid-preprod-signing-artifacts' };
const EMU = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199' };
const TARGET = { projectId: BANKID_PREPROD.projectId, bucket: BANKID_PREPROD.signingArtifactBucket, region: BANKID_PREPROD.region, databaseId: '(default)' };

await t('C01', 'CANONICAL PREPROD CONFIG: projectId sormena-bankid-preprod, projectNumber 1070284705326, region europe-west1, Firestore (default), bucket sormena-bankid-preprod-signing-artifacts; frozen object; live cloud writes NOT authorized in BID-2A', async () => {
  assert.deepEqual({ ...BANKID_PREPROD }, { environment: 'preprod', projectId: 'sormena-bankid-preprod', projectNumber: '1070284705326', region: 'europe-west1', firestoreDatabase: '(default)', signingArtifactBucket: 'sormena-bankid-preprod-signing-artifacts' });
  assert.ok(Object.isFrozen(BANKID_PREPROD)); assert.deepEqual([...FORBIDDEN_PROJECTS], ['sormena-prod', 'four-season-as']);
  assert.equal(LIVE_CLOUD_WRITES_AUTHORIZED, false);
  const r = resolveSigningTarget(OK_ENV);
  assert.deepEqual({ ...r }, { projectId: 'sormena-bankid-preprod', projectNumber: '1070284705326', region: 'europe-west1', databaseId: '(default)', bucket: 'sormena-bankid-preprod-signing-artifacts' });
  assert.deepEqual({ ...resolveSigningTarget(Object.assign({ GCLOUD_PROJECT: 'sormena-bankid-preprod', FIREBASE_CONFIG: JSON.stringify({ projectId: 'sormena-bankid-preprod' }) }, OK_ENV)) }, { ...r }, 'agreeing platform signals accepted');
});
await t('C02', 'NO DEFAULT / NO FALLBACK: missing explicit project -> PROJECT_ID_MISSING even when the platform says preprod (GCLOUD_PROJECT alone is never trusted); missing bucket -> BUCKET_MISSING; empty env -> PROJECT_ID_MISSING', async () => {
  assert.equal(code(() => resolveSigningTarget({})), 'PROJECT_ID_MISSING');
  assert.equal(code(() => resolveSigningTarget({ GCLOUD_PROJECT: 'sormena-bankid-preprod', SORMENA_SIGNING_BUCKET: OK_ENV.SORMENA_SIGNING_BUCKET })), 'PROJECT_ID_MISSING');
  assert.equal(code(() => resolveSigningTarget({ SORMENA_SIGNING_PROJECT_ID: 'sormena-bankid-preprod' })), 'BUCKET_MISSING');
  assert.equal(code(() => assertPreprodTarget({})), 'PROJECT_ID_MISSING');
});
await t('C03', 'WRONG PROJECT refused: another project -> PROJECT_MISMATCH; a disagreeing platform signal -> PROJECT_CONFLICT (never "resolved"); wrong project number -> PROJECT_NUMBER_MISMATCH; wrong database -> DATABASE_MISMATCH', async () => {
  assert.equal(code(() => resolveSigningTarget(Object.assign({}, OK_ENV, { SORMENA_SIGNING_PROJECT_ID: 'sormena-bankid-test' }))), 'PROJECT_MISMATCH');
  assert.equal(code(() => resolveSigningTarget(Object.assign({ GCLOUD_PROJECT: 'some-other-project' }, OK_ENV))), 'PROJECT_CONFLICT');
  assert.equal(code(() => resolveSigningTarget(Object.assign({ FIREBASE_CONFIG: JSON.stringify({ projectId: 'x-project' }) }, OK_ENV))), 'PROJECT_CONFLICT');
  assert.equal(code(() => assertPreprodTarget(Object.assign({}, TARGET, { projectNumber: '999' }))), 'PROJECT_NUMBER_MISMATCH');
  assert.equal(code(() => assertPreprodTarget(Object.assign({}, TARGET, { databaseId: 'signing' }))), 'DATABASE_MISMATCH');
});
await t('C04', 'PRODUCTION EXPLICITLY REFUSED by name wherever it appears: explicit project, GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT, FIREBASE_CONFIG.projectId, the bucket (sormena-prod.firebasestorage.app / sormena-prod-*), the Admin app project; legacy four-season-as too — always PRODUCTION_PROJECT_REFUSED, even when everything else is preprod', async () => {
  for (const env of [
    Object.assign({}, OK_ENV, { SORMENA_SIGNING_PROJECT_ID: 'sormena-prod' }),
    Object.assign({ GCLOUD_PROJECT: 'sormena-prod' }, OK_ENV),
    Object.assign({ GOOGLE_CLOUD_PROJECT: 'sormena-prod' }, OK_ENV),
    Object.assign({ FIREBASE_CONFIG: JSON.stringify({ projectId: 'sormena-prod' }) }, OK_ENV),
    Object.assign({}, OK_ENV, { SORMENA_SIGNING_BUCKET: 'sormena-prod.firebasestorage.app' }),
    Object.assign({}, OK_ENV, { SORMENA_SIGNING_PROJECT_ID: 'four-season-as' }),
  ]) assert.equal(code(() => resolveSigningTarget(env)), 'PRODUCTION_PROJECT_REFUSED', JSON.stringify(env));
  assert.equal(code(() => assertPreprodTarget(Object.assign({}, TARGET, { bucket: 'sormena-prod-signing-artifacts' }))), 'PRODUCTION_PROJECT_REFUSED');
  assert.equal(code(() => assertAdapterBinding({ target: TARGET, appProjectId: 'sormena-prod', databaseId: '(default)', mode: 'emulator', env: EMU })), 'PRODUCTION_PROJECT_REFUSED');
  assert.equal(code(() => assertAdapterBinding({ target: TARGET, bucketName: 'sormena-prod.firebasestorage.app', mode: 'emulator', env: EMU })), 'PRODUCTION_PROJECT_REFUSED');
});
await t('C05', 'WRONG BUCKET / WRONG REGION refused: another bucket -> BUCKET_MISMATCH (resolver and adapter binding); us-central1 or any non-europe-west1 region -> REGION_MISMATCH', async () => {
  assert.equal(code(() => resolveSigningTarget(Object.assign({}, OK_ENV, { SORMENA_SIGNING_BUCKET: 'sormena-bankid-preprod.firebasestorage.app' }))), 'BUCKET_MISMATCH');
  assert.equal(code(() => assertAdapterBinding({ target: TARGET, bucketName: 'other-bucket', mode: 'emulator', env: EMU })), 'BUCKET_MISMATCH');
  assert.equal(code(() => resolveSigningTarget(Object.assign({}, OK_ENV, { SORMENA_SIGNING_REGION: 'us-central1' }))), 'REGION_MISMATCH');
  assert.equal(code(() => assertPreprodTarget(Object.assign({}, TARGET, { region: 'europe-north1' }))), 'REGION_MISMATCH');
});
await t('C06', 'MODE GATE: live (real cloud) adapters refused in BID-2A (LIVE_CLOUD_WRITES_NOT_AUTHORIZED) even with a perfect target; emulator mode requires loopback emulator hosts (EMULATOR_HOST_REQUIRED otherwise); a missing mode is refused', async () => {
  assert.equal(code(() => assertAdapterBinding({ target: TARGET, appProjectId: TARGET.projectId, databaseId: '(default)', mode: 'live', env: {} })), 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED');
  assert.equal(code(() => assertAdapterBinding({ target: TARGET, appProjectId: TARGET.projectId, databaseId: '(default)', mode: 'emulator', env: {} })), 'EMULATOR_HOST_REQUIRED');
  assert.equal(code(() => assertAdapterBinding({ target: TARGET, appProjectId: TARGET.projectId, databaseId: '(default)', mode: 'emulator', env: { FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' } })), 'EMULATOR_HOST_REQUIRED');
  assert.equal(code(() => assertAdapterBinding({ target: TARGET, bucketName: TARGET.bucket, mode: 'emulator', env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080' } })), 'EMULATOR_HOST_REQUIRED');
  assert.equal(code(() => assertAdapterBinding({ target: TARGET, appProjectId: TARGET.projectId, mode: undefined, env: EMU })), 'ADAPTER_MODE_REQUIRED');
});
await t('C07', 'REFUSED BEFORE ANY WRITE: a wrong/production bucket or app handle makes the adapter factory throw with ZERO calls on the bucket/db handles; the live mode likewise', async () => {
  const calls = [];
  const spyBucket = (name) => ({ name, file: (k) => { calls.push(['file', k]); return { save: async () => calls.push(['save']) }; } });
  const spyDb = { databaseId: '(default)', doc: (p) => { calls.push(['doc', p]); }, collection: (p) => { calls.push(['collection', p]); }, runTransaction: async () => calls.push(['tx']) };
  assert.equal(code(() => createGcsArtifactStore({ bucket: spyBucket('sormena-prod.firebasestorage.app'), target: TARGET, mode: 'emulator', env: EMU })), 'PRODUCTION_PROJECT_REFUSED');
  assert.equal(code(() => createGcsArtifactStore({ bucket: spyBucket('wrong-bucket'), target: TARGET, mode: 'emulator', env: EMU })), 'BUCKET_MISMATCH');
  assert.equal(code(() => createGcsArtifactStore({ bucket: spyBucket(TARGET.bucket), target: TARGET, mode: 'live', env: {} })), 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED');
  assert.equal(code(() => createSigningTransactionRepository({ app: { options: { projectId: 'sormena-prod' } }, db: spyDb, target: TARGET, mode: 'emulator', env: EMU })), 'PRODUCTION_PROJECT_REFUSED');
  assert.equal(code(() => createSigningTransactionRepository({ app: { options: {} }, db: spyDb, target: TARGET, mode: 'emulator', env: EMU })), 'PROJECT_MISMATCH');
  assert.equal(code(() => createSigningTransactionRepository({ app: { options: { projectId: TARGET.projectId } }, db: Object.assign({}, spyDb, { databaseId: 'other' }), target: TARGET, mode: 'emulator', env: EMU })), 'DATABASE_MISMATCH');
  assert.deepEqual(calls, [], 'no handle was touched');
});
await t('C08', 'CLOUD FUNCTIONS 2ND GEN SHAPE: FUNCTION_OPTIONS = { region europe-west1, private invoker, no CORS } from the canonical config; the built HTTPS function carries region europe-west1 (never the us-central1 default); building it without an explicit preprod target, or with production, is refused', async () => {
  assert.deepEqual({ ...FUNCTION_OPTIONS }, { region: 'europe-west1', cors: false, invoker: 'private' });
  assert.equal(FUNCTION_OPTIONS, SIGNING_FUNCTION_OPTIONS);
  const deps = (env) => ({ env: Object.assign({ SORMENA_SIGNING_PROVIDER: 'fake' }, env), auth: {}, memberships: {}, contracts: {}, service: {}, txStore: {}, config: {} });
  assert.equal(code(() => makeHttpFunction(deps({}))), 'PROJECT_ID_MISSING');
  assert.equal(code(() => makeHttpFunction(deps({ SORMENA_SIGNING_PROJECT_ID: 'sormena-prod', SORMENA_SIGNING_BUCKET: 'x' }))), 'PRODUCTION_PROJECT_REFUSED');
  const fn = makeHttpFunction(deps(OK_ENV));
  assert.equal(typeof fn, 'function');
  assert.deepEqual(fn.__endpoint.region, ['europe-west1']);
  assert.equal(fn.__endpoint.platform, 'gcfv2');
});
await t('C09', 'ONE CANONICAL SURFACE: the preprod project id, project number, bucket and region literals appear ONLY in src/preprod-config.mjs; no "us-central1" and no production project literal anywhere else in functions/src or index.mjs', async () => {
  const files = fs.readdirSync(new URL('../src/', import.meta.url)).map((f) => ['src/' + f, fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')]).concat([['index.mjs', fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')]]);
  for (const [name, src] of files) {
    if (name === 'src/preprod-config.mjs') continue;
    for (const lit of ['sormena-bankid-preprod', '1070284705326', "'europe-west1'", 'us-central1', 'sormena-prod', 'four-season-as']) assert.ok(!src.includes(lit), name + ' contains ' + lit);
  }
});
await t('C10', 'BINDING METADATA through the (fake) signing flow: every stored artifact carries stage + tenant + employee + contract version (+ tx + signer role for B/C) + sha256 + application/pdf; the transaction records its validated target project; source A metadata binds snapshot hash + generator version', async () => {
  const keys = await generateKeyPair('ES256'); const jwk = Object.assign(await exportJWK(keys.publicKey), { kid: 'k', alg: 'ES256' });
  let now = NOW; const clock = () => now;
  const fake = createFakeWysiwys({ clock, signingKey: keys.privateKey, kid: 'k', issuer: 'fake.iss', alg: 'ES256' });
  const store = createMemoryArtifactStore(); const txStore = createMemoryTransactionStore();
  const svc = createSigningService({ txStore, artifactStore: store, provider: fake.api, clock, config: { environment: 'fake', targetProjectId: BANKID_PREPROD.projectId, verifier: { jwks: { keys: [jwk] }, issuer: 'fake.iss', algorithms: ['ES256'] } } });
  const fx = frozenEmployee1();
  const i = await svc.initiate({ tenantId: T, ansattId: fx.ansattId, version: fx.version, employerSigner: { uid: ADMIN_UID, name: 'Herish Hashemi', birthdate: '1980-01-01' }, actorUid: ADMIN_UID });
  const txId = i.tx.txId;
  for (const p of [{ sub: 'a', name: 'Herish Hashemi', birthdate: '1980-01-01' }, { sub: 'b', name: 'Test Ansatt 01', birthdate: '1995-04-12' }]) { const s = await svc.startSession({ tenantId: T, txId }); await fake.control.userSigns(s.signId, p); await svc.refresh({ tenantId: T, txId }); }
  const tx = await txStore.get(T, txId);
  assert.equal(tx.status, 'completed'); assert.equal(tx.targetProjectId, 'sormena-bankid-preprod');
  const A = (await store.metadataOf(tx.source.artifactRef)).metadata, B = (await store.metadataOf(tx.signers[0].output.ref)).metadata, C = (await store.metadataOf(tx.finalArtifact.ref)).metadata;
  assert.deepEqual([A.stage, B.stage, C.stage], ['source_unsigned', 'employer_signed', 'final_signed']);
  for (const m of [A, B, C]) { assert.equal(m.tenantId, T); assert.equal(m.ansattId, fx.ansattId); assert.equal(m.contractVersionId, fx.version.contractVersionId); assert.equal(m.contentType, 'application/pdf'); }
  assert.equal(A.sha256, tx.source.sourcePdfSha256); assert.equal(A.sourceSnapshotSha256, tx.source.sourceSnapshotSha256); assert.equal(A.generatorVersion, tx.source.generatorVersion); assert.equal(A.txId, undefined);
  assert.equal(B.sha256, tx.signers[0].output.sha256); assert.equal(B.txId, txId); assert.equal(B.signerRole, 'employer');
  assert.equal(C.sha256, tx.finalArtifact.sha256); assert.equal(C.txId, txId); assert.equal(C.signerRole, 'employee');
});
await t('C11', 'no network attempt (fetch/http/https/net/tls/http2 guarded)', async () => { assert.deepEqual(blocked, []); });

for (const l of lines) console.log(l);
console.log('BID2A_PREPROD_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
