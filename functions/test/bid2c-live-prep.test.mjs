// bid2c-live-prep.test.mjs — BID-2C: live-smoke authorization gate, ADC structural identity, network allowlist, local
// runner surface, corrected duplicate-write acceptance and evidence redaction (unit; no emulator, no cloud, no network).
// Run: node test/bid2c-live-prep.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installNetGuard, blocked } from './net-guard.mjs';
import { BANKID_PREPROD, BANKID_PREPROD_RUNTIME, LIVE_CLOUD_WRITES_AUTHORIZED, CREDENTIAL_BYPASS_KEYS, assertAdapterBinding, isLiveSmokeGrant, emulatorEnvKeys } from '../src/preprod-config.mjs';
import { LIVE_SMOKE_AUTHORIZATION, RELEASE_ID_PATTERN, issueLiveSmokeGrant, assertAuthorizationShape } from '../src/live-smoke-gate.mjs';
import { adcWellKnownPath, inspectAdcJson, readAdcIdentity, isVerifiedAdcIdentity, ADC_SECRET_FIELDS } from '../src/adc-identity.mjs';
import { assertSmokeGates, runPreprodSmoke, makeSmokeHandler, classifyDuplicateRefusal } from '../src/preprod-smoke.mjs';
import { createGcsArtifactStore, classifyStorageWriteError, DUPLICATE_REFUSAL_CLASSES } from '../src/gcs-artifact-store.mjs';
import { createSigningTransactionRepository } from '../src/firestore-stores.mjs';
import { buildEvidence, redactSecrets, writeEvidence, SECRET_VALUE_PATTERNS, consumeLiveRun, findRunConsumption, consumptionMarkerName, CONSUMPTION_MARKER_VERSION } from '../src/live-smoke-evidence.mjs';
import { LIVE_ALLOWED_HOSTS, LIVE_ALLOWED_PORT, isAllowedLiveHost, isNeverAllowedIp } from '../scripts/live-net-guard.mjs';
import { parseRunnerArgs, assertLivePreflight, main as runnerMain, EVIDENCE_DIR } from '../scripts/run-live-smoke.mjs';
installNetGuard();

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }
const code = (fn) => { try { fn(); return 'NO_THROW'; } catch (e) { return e.code; } };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SA = BANKID_PREPROD_RUNTIME.serviceAccount;
const RUN = 'smoke-bid2c001';
const AUTH = Object.freeze({ authorized: true, releaseId: 'SIRRHA-CCODE-TEST-FIXTURE-AUTHORIZATION-000', runId: RUN });
const LIVE = Object.freeze({ SORMENA_SIGNING_PROJECT_ID: BANKID_PREPROD.projectId, SORMENA_SIGNING_BUCKET: BANKID_PREPROD.signingArtifactBucket, SORMENA_SIGNING_REGION: BANKID_PREPROD.region, SORMENA_PREPROD_SMOKE_ENABLED: 'true', SORMENA_SIGNING_ADAPTER_MODE: 'live', SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED: 'true', SORMENA_LIVE_SMOKE_RELEASE_ID: AUTH.releaseId });
const touched = [];
const spyApp = { options: { projectId: BANKID_PREPROD.projectId } };
const spyDb = { databaseId: '(default)', doc: (p) => { touched.push(['doc', p]); throw new Error('DB_TOUCHED'); }, collection: (p) => { touched.push(['collection', p]); throw new Error('DB_TOUCHED'); }, runTransaction: async () => { touched.push(['tx']); throw new Error('DB_TOUCHED'); } };
const spyBucket = { name: BANKID_PREPROD.signingArtifactBucket, file: (k) => { touched.push(['file', k]); throw new Error('BUCKET_TOUCHED'); } };
// ADC fixtures (values are obviously synthetic; the structural check never reads them beyond presence)
const impersonated = (sa, extra) => Object.assign({ type: 'impersonated_service_account', service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + sa + ':generateAccessToken', delegates: [], source_credentials: { type: 'authorized_user', client_id: 'fixture-client-id', client_secret: 'fixture-client-secret', refresh_token: 'fixture-refresh-token' } }, extra || {});
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bid2c-adc-'));
const withAdc = (json) => { const home = tmpHome(); const dir = path.join(home, 'gcloud'); fs.mkdirSync(dir, { recursive: true }); if (json !== null) fs.writeFileSync(path.join(dir, 'application_default_credentials.json'), typeof json === 'string' ? json : JSON.stringify(json)); return { APPDATA: home, HOME: home }; };
const goodAdc = () => readAdcIdentity({ env: withAdc(impersonated(SA)), platform: 'win32' });
// The module constant is either the unauthorized default or a well-formed ONE-run authorization (an execution release).
// In both states every run id other than the authorized one must be refused; the code differs by state.
const EXEC = LIVE_SMOKE_AUTHORIZATION.authorized === true;
const UNAUTH = EXEC ? 'LIVE_SMOKE_RUN_ID_NOT_AUTHORIZED' : 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED';

await t('V01', 'DISABLED BY DEFAULT / BOUNDED WHEN AUTHORIZED: LIVE_CLOUD_WRITES_AUTHORIZED = false in source; LIVE_SMOKE_AUTHORIZATION is the unauthorized default OR a well-formed single-run literal whose run id is not this suite\'s; a fully flagged live environment (both env flags, no emulator vars, verified ADC) is refused for this run id by the gate, by runPreprodSmoke (zero handle calls) and by the adapters', async () => {
  if (EXEC) { assert.equal(code(() => assertAuthorizationShape(LIVE_SMOKE_AUTHORIZATION)), 'NO_THROW'); assert.notEqual(LIVE_SMOKE_AUTHORIZATION.runId, RUN); lines.push('INFO  V01  EXEC STATE: authorized run ' + LIVE_SMOKE_AUTHORIZATION.runId + ' by ' + LIVE_SMOKE_AUTHORIZATION.releaseId); }
  else assert.deepEqual({ ...LIVE_SMOKE_AUTHORIZATION }, { authorized: false, releaseId: null, runId: null });
  assert.ok(Object.isFrozen(LIVE_SMOKE_AUTHORIZATION));
  assert.equal(LIVE_CLOUD_WRITES_AUTHORIZED, false);
  const adc = goodAdc(); assert.equal(adc.ok, true);
  assert.equal(code(() => issueLiveSmokeGrant({ env: LIVE, runId: RUN, adcIdentity: adc })), UNAUTH);
  assert.equal(code(() => assertSmokeGates(LIVE, { runId: RUN, adcIdentity: adc })), UNAUTH);
  const r = await runPreprodSmoke({ app: spyApp, db: spyDb, bucket: spyBucket, env: LIVE, runId: RUN, adcIdentity: adc });
  assert.equal(r.refused, UNAUTH); assert.deepEqual(r.steps, []); assert.deepEqual(touched, []);
  const target = { projectId: BANKID_PREPROD.projectId, bucket: BANKID_PREPROD.signingArtifactBucket, region: BANKID_PREPROD.region, databaseId: '(default)' };
  assert.equal(code(() => assertAdapterBinding({ target, bucketName: target.bucket, mode: 'live', env: {} })), 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED');
  assert.equal(code(() => createGcsArtifactStore({ bucket: spyBucket, target, mode: 'live', env: {} })), 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED');
  assert.equal(code(() => createSigningTransactionRepository({ app: spyApp, db: spyDb, target, mode: 'live', env: {} })), 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED');
  assert.deepEqual(touched, []);
});
await t('V02', 'ALL EXPLICIT GATES REQUIRED, IN ORDER (authorized fixture injected): mode must be live; SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED must be exactly "true"; the code literal must be well-formed (authorized:true alone is MALFORMED); the run id must equal the ONE authorized run id; SORMENA_LIVE_SMOKE_RELEASE_ID must echo the release id; GCLOUD_PROJECT alone authorizes nothing', async () => {
  const adc = goodAdc();
  const g = (env, auth) => code(() => issueLiveSmokeGrant({ env, runId: RUN, adcIdentity: adc, authorization: auth === undefined ? AUTH : auth }));
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_SIGNING_ADAPTER_MODE: 'emulator' })), 'LIVE_MODE_REQUIRED');
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED: undefined })), 'LIVE_WRITE_NOT_AUTHORIZED');
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED: 'TRUE' })), 'LIVE_WRITE_NOT_AUTHORIZED');
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_PREPROD_SMOKE_ENABLED: '1' })), 'SMOKE_NOT_ENABLED');
  assert.equal(g(LIVE, { authorized: true }), 'LIVE_SMOKE_AUTHORIZATION_MALFORMED');
  assert.equal(g(LIVE, { authorized: true, releaseId: 'x', runId: RUN }), 'LIVE_SMOKE_AUTHORIZATION_MALFORMED');
  assert.equal(g(LIVE, { authorized: true, releaseId: AUTH.releaseId, runId: 'smoke-*' }), 'LIVE_SMOKE_AUTHORIZATION_MALFORMED');
  assert.equal(g(LIVE, { authorized: 'true', releaseId: AUTH.releaseId, runId: RUN }), 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED');
  assert.equal(g(LIVE, { authorized: true, releaseId: AUTH.releaseId, runId: 'smoke-other001' }), 'LIVE_SMOKE_RUN_ID_NOT_AUTHORIZED');
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_LIVE_SMOKE_RELEASE_ID: undefined })), 'LIVE_SMOKE_RELEASE_ID_MISMATCH');
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_LIVE_SMOKE_RELEASE_ID: 'SIRRHA-CCODE-SOME-OTHER-RELEASE-001' })), 'LIVE_SMOKE_RELEASE_ID_MISMATCH');
  assert.equal(g({ GCLOUD_PROJECT: BANKID_PREPROD.projectId, GOOGLE_CLOUD_PROJECT: BANKID_PREPROD.projectId, SORMENA_PREPROD_SMOKE_ENABLED: 'true', SORMENA_SIGNING_ADAPTER_MODE: 'live', SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED: 'true' }), 'PROJECT_ID_MISSING');
  assert.ok(RELEASE_ID_PATTERN.test('SIRRHA-CCODE-SORMENA-BANKID-BID2C-LIVE-SMOKE-EXEC-015')); assert.equal(code(() => assertAuthorizationShape(AUTH)), 'NO_THROW');
  assert.equal(g(LIVE), 'NO_THROW');
});
await t('V03', 'EMULATOR VARIABLES CAUSE LIVE REFUSAL: any *EMULATOR* variable (FIRESTORE_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST, STORAGE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_EMULATOR_HUB) -> EMULATOR_ENV_IN_LIVE_MODE at the gate AND at the adapter binding even with a grant; empty values are ignored', async () => {
  const adc = goodAdc();
  for (const k of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'CLOUD_STORAGE_EMULATOR_HOST']) assert.equal(code(() => issueLiveSmokeGrant({ env: Object.assign({}, LIVE, { [k]: '127.0.0.1:18080' }), runId: RUN, adcIdentity: adc, authorization: AUTH })), 'EMULATOR_ENV_IN_LIVE_MODE', k);
  assert.deepEqual(emulatorEnvKeys({ FIRESTORE_EMULATOR_HOST: '', X: '1' }), []);
  const grant = issueLiveSmokeGrant({ env: LIVE, runId: RUN, adcIdentity: adc, authorization: AUTH });
  const target = { projectId: BANKID_PREPROD.projectId, bucket: BANKID_PREPROD.signingArtifactBucket, region: BANKID_PREPROD.region, databaseId: '(default)' };
  assert.equal(code(() => assertAdapterBinding({ target, bucketName: target.bucket, mode: 'live', env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080' }, liveGrant: grant })), 'EMULATOR_ENV_IN_LIVE_MODE');
  assert.equal(code(() => assertAdapterBinding({ target, bucketName: target.bucket, mode: 'live', env: LIVE, liveGrant: grant })), 'NO_THROW');
});
await t('V04', 'PRODUCTION / WRONG TARGET refused in live mode before anything else: sormena-prod as explicit project, as GCLOUD_PROJECT, in the bucket -> PRODUCTION_PROJECT_REFUSED; wrong project / bucket / region / project number -> mismatch codes', async () => {
  const adc = goodAdc();
  const g = (env) => code(() => issueLiveSmokeGrant({ env, runId: RUN, adcIdentity: adc, authorization: AUTH }));
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_SIGNING_PROJECT_ID: 'sormena-prod' })), 'PRODUCTION_PROJECT_REFUSED');
  assert.equal(g(Object.assign({}, LIVE, { GCLOUD_PROJECT: 'sormena-prod' })), 'PRODUCTION_PROJECT_REFUSED');
  assert.equal(g(Object.assign({}, LIVE, { GOOGLE_CLOUD_PROJECT: 'sormena-prod' })), 'PRODUCTION_PROJECT_REFUSED');
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_SIGNING_BUCKET: 'sormena-prod.firebasestorage.app' })), 'PRODUCTION_PROJECT_REFUSED');
  assert.equal(g(Object.assign({}, LIVE, { FIREBASE_CONFIG: JSON.stringify({ projectId: 'sormena-prod' }) })), 'PRODUCTION_PROJECT_REFUSED');
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_SIGNING_PROJECT_ID: 'sormena-bankid-test' })), 'PROJECT_MISMATCH');
  assert.equal(g(Object.assign({}, LIVE, { GCLOUD_PROJECT: 'other' })), 'PROJECT_CONFLICT');
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_SIGNING_BUCKET: 'other-bucket' })), 'BUCKET_MISMATCH');
  assert.equal(g(Object.assign({}, LIVE, { SORMENA_SIGNING_REGION: 'us-central1' })), 'REGION_MISMATCH');
  const target = { projectId: BANKID_PREPROD.projectId, projectNumber: '999', bucket: BANKID_PREPROD.signingArtifactBucket, region: BANKID_PREPROD.region, databaseId: '(default)' };
  assert.equal(code(() => assertAdapterBinding({ target, mode: 'live', env: LIVE })), 'PROJECT_NUMBER_MISMATCH');
});
await t('V05', 'NO SERVICE-ACCOUNT KEY PATH / NO CREDENTIAL BYPASS: GOOGLE_APPLICATION_CREDENTIALS set -> SA_KEY_PATH_REFUSED; CLOUDSDK_CONFIG, GCE_METADATA_HOST, GCE_METADATA_IP, CLOUDSDK_AUTH_ACCESS_TOKEN, GOOGLE_OAUTH_ACCESS_TOKEN -> CREDENTIAL_BYPASS_REFUSED', async () => {
  const adc = goodAdc();
  const g = (env) => code(() => issueLiveSmokeGrant({ env, runId: RUN, adcIdentity: adc, authorization: AUTH }));
  assert.equal(g(Object.assign({}, LIVE, { GOOGLE_APPLICATION_CREDENTIALS: 'C:\\keys\\sa.json' })), 'SA_KEY_PATH_REFUSED');
  for (const k of CREDENTIAL_BYPASS_KEYS.filter((x) => x !== 'GOOGLE_APPLICATION_CREDENTIALS')) assert.equal(g(Object.assign({}, LIVE, { [k]: 'x' })), 'CREDENTIAL_BYPASS_REFUSED', k);
  assert.deepEqual([...CREDENTIAL_BYPASS_KEYS], ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG', 'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']);
});
await t('V06', 'ADC STRUCTURAL IDENTITY (local file only, no network): absent -> ADC_ABSENT; direct user ADC -> ADC_DIRECT_USER_REFUSED; service-account key -> ADC_SERVICE_ACCOUNT_KEY_REFUSED; external_account -> ADC_TYPE_REFUSED; wrong impersonation target -> ADC_IMPERSONATION_TARGET_MISMATCH; delegation chain refused; non-user source refused; unparseable refused; each maps to a gate refusal; the safe record carries no secret field', async () => {
  const cases = [
    [null, 'ADC_ABSENT'],
    ['{not json', 'ADC_UNPARSEABLE'],
    [{ type: 'authorized_user', client_id: 'a', client_secret: 'b', refresh_token: 'c' }, 'ADC_DIRECT_USER_REFUSED'],
    [{ type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com', private_key: 'fixture' }, 'ADC_SERVICE_ACCOUNT_KEY_REFUSED'],
    [{ type: 'external_account', audience: 'x' }, 'ADC_TYPE_REFUSED'],
    [{ type: 'unknown_thing' }, 'ADC_TYPE_REFUSED'],
    [impersonated('other-sa@sormena-bankid-preprod.iam.gserviceaccount.com'), 'ADC_IMPERSONATION_TARGET_MISMATCH'],
    [impersonated('sormena-signing-runtime@sormena-prod.iam.gserviceaccount.com'), 'ADC_IMPERSONATION_TARGET_MISMATCH'],
    [impersonated(SA, { delegates: ['d@x.iam.gserviceaccount.com'] }), 'ADC_DELEGATION_CHAIN_REFUSED'],
    [impersonated(SA, { source_credentials: { type: 'service_account', private_key: 'fixture' } }), 'ADC_SOURCE_TYPE_REFUSED'],
    [impersonated(SA, { source_credentials: { type: 'authorized_user', client_id: 'a', client_secret: 'b' } }), 'ADC_SOURCE_INCOMPLETE'],
    [impersonated(SA, { service_account_impersonation_url: 'https://evil.example/v1/projects/-/serviceAccounts/' + SA + ':generateAccessToken' }), 'ADC_IMPERSONATION_URL_INVALID'],
    [impersonated(SA, { private_key: 'fixture' }), 'ADC_SERVICE_ACCOUNT_KEY_REFUSED'],
  ];
  for (const [json, expect] of cases) {
    const r = readAdcIdentity({ env: withAdc(json), platform: 'win32' });
    assert.equal(r.ok, false, expect); assert.equal(r.code, expect); assert.equal(isVerifiedAdcIdentity(r), false);
    for (const k of ADC_SECRET_FIELDS) assert.ok(!(k in r), expect + ' leaks ' + k);
    assert.equal(code(() => issueLiveSmokeGrant({ env: LIVE, runId: RUN, adcIdentity: r, authorization: AUTH })), expect, 'gate ' + expect);
  }
  assert.equal(code(() => issueLiveSmokeGrant({ env: LIVE, runId: RUN, adcIdentity: { ok: true, type: 'impersonated_service_account', serviceAccount: SA }, authorization: AUTH })), 'ADC_IDENTITY_NOT_VERIFIED', 'a shape-alike record is not a verified identity');
  assert.equal(code(() => issueLiveSmokeGrant({ env: LIVE, runId: RUN, adcIdentity: undefined, authorization: AUTH })), 'ADC_IDENTITY_NOT_VERIFIED');
  assert.equal(inspectAdcJson(null).code, 'ADC_UNPARSEABLE'); assert.equal(inspectAdcJson([]).code, 'ADC_UNPARSEABLE');
  assert.equal(adcWellKnownPath({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32'), path.join('C:\\Users\\x\\AppData\\Roaming', 'gcloud', 'application_default_credentials.json'));
  assert.equal(adcWellKnownPath({ HOME: '/home/x' }, 'linux'), path.join('/home/x', '.config', 'gcloud', 'application_default_credentials.json'));
  assert.equal(readAdcIdentity({ env: {}, platform: 'win32' }).code, 'ADC_LOCATION_UNRESOLVABLE');
});
await t('V07', 'CORRECT IMPERSONATED ADC FIXTURE PASSES THE LOCAL CHECK WITHOUT A NETWORK CALL: type impersonated_service_account, target = runtime SA, source authorized_user, no delegates -> ok + registered; with the authorized fixture the full preflight issues a grant bound to the run id / release / target / SA; a forged object of identical shape is NOT a grant; adapters constructed in live mode with the grant touch no handle', async () => {
  const adc = goodAdc();
  assert.deepEqual({ ...adc }, { ok: true, code: 'ADC_IMPERSONATED_OK', present: true, path: adc.path, type: 'impersonated_service_account', serviceAccount: SA, sourceType: 'authorized_user' });
  assert.ok(isVerifiedAdcIdentity(adc)); assert.ok(Object.isFrozen(adc)); assert.ok(adc.path.endsWith(path.join('gcloud', 'application_default_credentials.json')));
  const env = Object.assign({}, LIVE, withAdc(impersonated(SA)));
  const pf = assertLivePreflight({ env, runId: RUN, platform: 'win32', authorization: AUTH });
  assert.equal(pf.adc.ok, true); assert.ok(isLiveSmokeGrant(pf.grant)); assert.ok(Object.isFrozen(pf.grant));
  assert.deepEqual({ ...pf.grant, issuedAt: null }, { scope: 'preprod-smoke', releaseId: AUTH.releaseId, runId: RUN, projectId: BANKID_PREPROD.projectId, projectNumber: BANKID_PREPROD.projectNumber, region: BANKID_PREPROD.region, databaseId: '(default)', bucket: BANKID_PREPROD.signingArtifactBucket, serviceAccount: SA, issuedAt: null });
  assert.equal(isLiveSmokeGrant({ ...pf.grant }), false, 'copy of a grant is not a grant');
  assert.equal(isLiveSmokeGrant(Object.freeze({ scope: 'preprod-smoke', runId: RUN })), false);
  assert.equal(code(() => assertLivePreflight({ env, runId: RUN, platform: 'win32' })), UNAUTH, 'without injection the module constant rules');
  const target = { projectId: BANKID_PREPROD.projectId, bucket: BANKID_PREPROD.signingArtifactBucket, region: BANKID_PREPROD.region, databaseId: '(default)' };
  const store = createGcsArtifactStore({ bucket: spyBucket, target, mode: 'live', env: LIVE, liveGrant: pf.grant });
  const repo = createSigningTransactionRepository({ app: spyApp, db: spyDb, target, mode: 'live', env: LIVE, liveGrant: pf.grant });
  assert.equal(store.target.bucket, target.bucket); assert.equal(repo.target.projectId, target.projectId); assert.deepEqual(touched, []);
  assert.equal(code(() => createGcsArtifactStore({ bucket: { name: 'other-bucket', file() {} }, target, mode: 'live', env: LIVE, liveGrant: pf.grant })), 'BUCKET_MISMATCH');
  assert.deepEqual(blocked, []);
});
await t('V08', 'ARBITRARY CALLER DATA CANNOT REDIRECT WRITES: the runner accepts only --run-id (smoke-[a-z0-9]{4,32}); --adc/--credentials/--key/--project/--bucket/--tenant/--employee/--contract/--path/--pdf/--region/positional -> UNEXPECTED_ARGUMENT; the handler still rejects any extra field; the runner source never loads a key (no cert(), no GOOGLE_APPLICATION_CREDENTIALS assignment) and initialises the Admin SDK with applicationDefault() only', async () => {
  assert.equal(parseRunnerArgs(['--run-id', RUN]), RUN); assert.equal(parseRunnerArgs(['--run-id=' + RUN]), RUN);
  assert.equal(code(() => parseRunnerArgs([])), 'RUN_ID_ARGUMENT_REQUIRED');
  assert.equal(code(() => parseRunnerArgs(['--run-id'])), 'RUN_ID_ARGUMENT_INVALID');
  assert.equal(code(() => parseRunnerArgs(['--run-id', 'smoke-ABC'])), 'SMOKE_RUN_ID_INVALID');
  assert.equal(code(() => parseRunnerArgs(['--run-id', RUN, '--run-id', RUN])), 'RUN_ID_ARGUMENT_INVALID');
  for (const extra of [['--adc', 'x.json'], ['--credentials=x.json'], ['--key', 'x'], ['--project', 'p'], ['--bucket', 'b'], ['--tenant', 't'], ['--employee', 'e'], ['--contract', '{}'], ['--path', 'tenants/x'], ['--pdf', 'JVBERi0='], ['--region', 'us-central1'], ['tenants/x/y'], ['--live']]) assert.equal(code(() => parseRunnerArgs(['--run-id', RUN, ...extra])), 'UNEXPECTED_ARGUMENT', extra.join(' '));
  const h = makeSmokeHandler({ app: spyApp, db: spyDb, bucket: spyBucket, env: LIVE });
  for (const extra of [{ tenantId: 'x' }, { bucket: 'z' }, { adc: 'p' }, { credentials: 'p' }]) { const r = await h(Object.assign({ runId: RUN }, extra)); assert.equal(r.status, 400); assert.equal(r.body.code, 'UNEXPECTED_INPUT'); }
  const src = fs.readFileSync(path.join(HERE, '..', 'scripts', 'run-live-smoke.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bcert\(/.test(src) && !/refreshToken\(/.test(src) && !/GOOGLE_APPLICATION_CREDENTIALS\s*=/.test(src) && !/readFileSync/.test(src), 'runner loads no key material');
  assert.ok(/credential:\s*applicationDefault\(\)/.test(src));
  assert.ok(/process\.env\.METADATA_SERVER_DETECTION = 'none'/.test(src));
  assert.deepEqual(touched, []);
});
await t('V09', 'EVIDENCE FILE CONTAINS NO SECRETS: a poisoned result (access token, refresh token, client secret/id, JWT, NIN-shaped number, secret-named keys) is redacted before writing, redactions counted; required non-secret facts present (run id, timestamps, project, region, bucket, SA, tx path, artifact paths, sha256, generations, refusal class, steps, final); the file is create-only (wx)', async () => {
  const poisoned = { ok: true, mode: 'live', steps: [{ id: 'A', name: 'x', ok: true, detail: { token: 'ya29.' + 'a'.repeat(40) } }, { id: 'K', name: 'dup', ok: true, detail: { refusal: 'PERMISSION_DENIED', note: 'refresh 1//' + 'b'.repeat(40) } }, { id: 'K2', name: 'direct', ok: true, detail: { refusal: 'PRECONDITION_FAILED' } }],
    evidence: { tenantId: 'bankid-preprod-smoke', ansattId: 'ansatt-' + RUN, contractVersionId: 'kv-' + RUN + '-1', txId: 'kv-' + RUN + '-1-sig-1', paths: { tx: 'tenants/bankid-preprod-smoke/signingTransactions/x', A: 'a.pdf', B: 'b.pdf', C: 'c.pdf' }, hashes: { A: 'a'.repeat(64), B: 'b'.repeat(64), C: 'c'.repeat(64), refresh_token: 'fixture', client_secret: 'GOCSPX-' + 'c'.repeat(20), oauthClient: '123456789012-abcdefghijklmnop.apps.googleusercontent.com', jwt: 'eyJ' + 'd'.repeat(20) + '.' + 'e'.repeat(20) + '.sig', nin: '12345678901' }, generations: { A: '1', B: '2', C: '3' } } };
  const adc = Object.assign({}, goodAdc());
  const ev = buildEvidence({ runId: RUN, releaseId: AUTH.releaseId, startedAt: '2026-09-30T10:00:00.000Z', finishedAt: '2026-09-30T10:00:05.000Z', target: { projectId: BANKID_PREPROD.projectId, projectNumber: BANKID_PREPROD.projectNumber, region: BANKID_PREPROD.region, databaseId: '(default)', bucket: BANKID_PREPROD.signingArtifactBucket }, serviceAccount: SA, adc, netGuard: { allowlist: [...LIVE_ALLOWED_HOSTS], port: 443, attempts: { 'firestore.googleapis.com': { allowed: 3, blocked: 0 } }, blocked: [] }, result: poisoned, runner: { version: 'test' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bid2c-ev-'));
  const w = writeEvidence(dir, ev);
  const text = fs.readFileSync(w.path, 'utf8'); const doc = JSON.parse(text);
  assert.ok(w.redactions >= 6, 'redactions=' + w.redactions); assert.equal(doc.redactions, w.redactions);
  for (const re of SECRET_VALUE_PATTERNS) assert.ok(!re.test(text), 'evidence matches ' + re);
  for (const bad of ['ya29.', 'GOCSPX', 'apps.googleusercontent.com', '12345678901', '"fixture"']) assert.ok(!text.includes(bad), 'evidence contains ' + bad);
  for (const k of ['refresh_token', 'client_secret', 'oauthClient', 'jwt', 'nin']) assert.equal(doc.sha256[k], '[REDACTED]', k);
  assert.equal(doc.steps[0].detail.token, '[REDACTED]'); assert.equal(doc.steps[1].detail.note, '[REDACTED]');
  assert.equal(doc.runId, RUN); assert.equal(doc.final, 'PASS'); assert.equal(doc.releaseId, AUTH.releaseId); assert.equal(doc.target.projectId, BANKID_PREPROD.projectId); assert.equal(doc.target.region, BANKID_PREPROD.region); assert.equal(doc.target.bucket, BANKID_PREPROD.signingArtifactBucket);
  assert.equal(doc.impersonatedServiceAccount, SA); assert.deepEqual(doc.adc, { present: true, type: 'impersonated_service_account', serviceAccount: SA, path: adc.path, code: 'ADC_IMPERSONATED_OK' });
  assert.equal(doc.txId, 'kv-' + RUN + '-1-sig-1'); assert.equal(doc.paths.tx, 'tenants/bankid-preprod-smoke/signingTransactions/x'); assert.equal(doc.sha256.C, 'c'.repeat(64)); assert.deepEqual(doc.generations, { A: '1', B: '2', C: '3' });
  assert.equal(doc.duplicateWriteRefusal.adapter.refusal, 'PERMISSION_DENIED'); assert.equal(doc.duplicateWriteRefusal.directPrecondition.refusal, 'PRECONDITION_FAILED');
  assert.equal(doc.steps.length, 3); assert.equal(doc.network.allowlist.length, 4);
  assert.throws(() => writeEvidence(dir, ev), /EEXIST/);
  assert.equal(redactSecrets({ a: 'plain', b: 42, c: ['x', { d: 'y' }] }).redactions, 0);
});
await t('V10', 'CORRECTED DUPLICATE-WRITE ACCEPTANCE: refusal classes ARTIFACT_IMMUTABLE_CONFLICT / PRECONDITION_FAILED (412) / PERMISSION_DENIED (403, least-privilege identity without objects.delete) all PASS when generation, metageneration, size, md5/crc32c, content type, custom metadata and sha256 are unchanged; a successful replacement FAILS even if metadata looks unchanged; a refusal with a changed generation FAILS; classifyStorageWriteError maps 412/403/message forms', async () => {
  const before = { contentType: 'application/pdf', generation: '17', metageneration: '1', size: '4321', md5Hash: 'm', crc32c: 'c', metadata: { sha256: 'h'.repeat(64), stage: 'final_signed' } };
  const same = JSON.parse(JSON.stringify(before));
  for (const outcome of DUPLICATE_REFUSAL_CLASSES) assert.equal(classifyDuplicateRefusal({ outcome, before, after: same, expectedSha256: 'h'.repeat(64) }).ok, true, outcome);
  assert.deepEqual([...DUPLICATE_REFUSAL_CLASSES], ['ARTIFACT_IMMUTABLE_CONFLICT', 'PRECONDITION_FAILED', 'PERMISSION_DENIED']);
  assert.equal(classifyDuplicateRefusal({ outcome: 'NO_REFUSAL', before, after: same, expectedSha256: 'h'.repeat(64) }).ok, false, 'a successful overwrite is a FAIL');
  assert.equal(classifyDuplicateRefusal({ outcome: 'PRECONDITION_FAILED', before, after: Object.assign({}, same, { generation: '18' }), expectedSha256: 'h'.repeat(64) }).ok, false, 'generation moved');
  assert.equal(classifyDuplicateRefusal({ outcome: 'PERMISSION_DENIED', before, after: Object.assign({}, same, { metadata: { sha256: 'h'.repeat(64), stage: 'final_signed', smokeProbe: 'K2' } }), expectedSha256: 'h'.repeat(64) }).ok, false, 'metadata changed');
  assert.equal(classifyDuplicateRefusal({ outcome: 'PERMISSION_DENIED', before, after: same, expectedSha256: 'x'.repeat(64) }).ok, false, 'sha mismatch');
  assert.equal(classifyDuplicateRefusal({ outcome: 'OTHER:ECONNRESET', before, after: same, expectedSha256: 'h'.repeat(64) }).ok, false);
  assert.equal(classifyStorageWriteError(Object.assign(new Error('x'), { code: 412 })), 'PRECONDITION_FAILED');
  assert.equal(classifyStorageWriteError(new Error('At least one of the pre-conditions you specified did not hold. conditionNotMet')), 'PRECONDITION_FAILED');
  assert.equal(classifyStorageWriteError(Object.assign(new Error('x'), { code: 403 })), 'PERMISSION_DENIED');
  assert.equal(classifyStorageWriteError(new Error('sormena-signing-runtime@x does not have storage.objects.delete access')), 'PERMISSION_DENIED');
  assert.equal(classifyStorageWriteError(Object.assign(new Error('x'), { code: 'ARTIFACT_IMMUTABLE_CONFLICT' })), 'ARTIFACT_IMMUTABLE_CONFLICT');
  assert.equal(classifyStorageWriteError(Object.assign(new Error('boom'), { code: 500 })), 'OTHER:500');
  assert.equal(classifyStorageWriteError(null), 'NO_REFUSAL');
});
await t('V11', 'NETWORK ALLOWLIST: exactly oauth2/iamcredentials/firestore/storage .googleapis.com on TLS 443; in a fresh process with the live guard installed, BankID hosts, a production-looking host, the metadata server (IP + name), loopback, plain http to an allowed host, a non-443 port, an IP literal and dns.lookup of any other host are all refused BEFORE a socket opens (fetch/https/net/tls/http2/dns layers) and recorded by host; LEARNED-IP EXCEPTION (EXEC-015 correction, stubbed DNS + sockets): a guarded lookup of an allowlisted host records its public IPs, net/tls connect to a learned IP on 443 is allowed, the same IP on another port / without a port / through fetch-https-http2 is refused, an unknown IP on 443 is refused, the metadata IP and loopback are refused even when DNS answers them for an allowlisted host, an unrelated host and its IP stay refused', async () => {
  assert.deepEqual([...LIVE_ALLOWED_HOSTS], ['oauth2.googleapis.com', 'iamcredentials.googleapis.com', 'firestore.googleapis.com', 'storage.googleapis.com']); assert.equal(LIVE_ALLOWED_PORT, 443);
  for (const h of LIVE_ALLOWED_HOSTS) { assert.ok(isAllowedLiveHost(h, 443, 'https:')); assert.ok(isAllowedLiveHost(h, undefined, undefined)); assert.ok(!isAllowedLiveHost(h, 80, 'http:')); assert.ok(!isAllowedLiveHost(h, 8443)); }
  for (const h of ['www.googleapis.com', 'cloudresourcemanager.googleapis.com', 'metadata.google.internal', '169.254.169.254', '127.0.0.1', 'localhost', '::1', 'oidc.bankid.no', 'preprod.bankid.no', 'developer.bankid.no', 'sormena.no', 'example.com', 'firestore.googleapis.com.evil.example', '', null]) assert.ok(!isAllowedLiveHost(h, 443, 'https:'), String(h));
  const script = `
    import { installLiveNetGuard } from ${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'scripts', 'live-net-guard.mjs')).href)};
    import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import http2 from 'node:http2'; import dns from 'node:dns';
    const g = installLiveNetGuard(); const out = [];
    const tryIt = async (label, fn) => { try { await fn(); out.push(label + ':OPENED'); } catch (e) { out.push(label + ':' + (e.code || e.message)); } };
    await tryIt('fetch-bankid', () => fetch('https://oidc.bankid.no/'));
    await tryIt('https-prod', () => new Promise((res, rej) => { const r = https.request('https://sormena-prod.firebaseio.com/', res); r.on('error', rej); r.end(); }));
    await tryIt('https-www', () => new Promise((res, rej) => { const r = https.get({ hostname: 'www.googleapis.com', path: '/' }, res); r.on('error', rej); }));
    await tryIt('http-plain-allowed', () => new Promise((res, rej) => { const r = http.request('http://storage.googleapis.com/', res); r.on('error', rej); r.end(); }));
    await tryIt('net-metadata-ip', () => new Promise((res, rej) => { const s = net.connect(80, '169.254.169.254'); s.on('connect', res); s.on('error', rej); }));
    await tryIt('net-metadata-name', () => new Promise((res, rej) => { const s = net.connect({ host: 'metadata.google.internal', port: 80 }); s.on('connect', res); s.on('error', rej); }));
    await tryIt('tls-loopback', () => new Promise((res, rej) => { const s = tls.connect({ host: '127.0.0.1', port: 18080 }); s.on('secureConnect', res); s.on('error', rej); }));
    await tryIt('tls-port', () => new Promise((res, rej) => { const s = tls.connect({ host: 'firestore.googleapis.com', port: 8443 }); s.on('secureConnect', res); s.on('error', rej); }));
    await tryIt('http2-bankid', () => new Promise((res, rej) => { const s = http2.connect('https://preprod.bankid.no'); s.on('connect', res); s.on('error', rej); }));
    await tryIt('dns-example', () => new Promise((res, rej) => dns.lookup('example.com', (e, a) => (e ? rej(e) : res(a)))));
    await tryIt('dns-promises-bankid', () => dns.promises.lookup('oidc.bankid.no'));
    console.log(JSON.stringify({ out, attempts: g.attempts, blockedCount: g.blocked.length }));
  `;
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  const r = JSON.parse(raw.trim().split('\n').pop());
  assert.equal(r.out.length, 11);
  for (const o of r.out) assert.ok(o.endsWith(':NETWORK_REFUSED_BY_LIVE_ALLOWLIST'), o);
  assert.equal(r.blockedCount, 11);
  for (const h of ['oidc.bankid.no', 'sormena-prod.firebaseio.com', '169.254.169.254', 'metadata.google.internal', '127.0.0.1', 'example.com', 'preprod.bankid.no']) assert.ok(r.attempts[h] && r.attempts[h].blocked >= 1, h);
  assert.ok(!Object.values(r.attempts).some((a) => a.allowed > 0), 'no host was allowed in this process');
  // EXEC-015 correction: an IP is connectable ONLY if this process learned it from a guarded lookup of an allowlisted host, on 443, at the socket layers.
  // DNS and the socket constructors are stubbed BEFORE the guard is installed, so this proof resolves nothing and opens nothing.
  for (const ip of ['169.254.169.254', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '0.0.0.0', '::1', '[::1]', 'fe80::1', 'fd00::1', '::ffff:169.254.169.254', '::ffff:127.0.0.1']) assert.ok(isNeverAllowedIp(ip), ip);
  for (const ip of ['172.217.20.170', '172.217.19.234', '203.0.113.10', '2a00:1450:400f:80d::200a']) assert.ok(!isNeverAllowedIp(ip), ip);
  const script2 = `
    import http2 from 'node:http2'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns';
    const FAKE = { 'firestore.googleapis.com': ['203.0.113.10', '203.0.113.11'], 'oauth2.googleapis.com': ['198.51.100.7'], 'storage.googleapis.com': ['169.254.169.254'], 'iamcredentials.googleapis.com': ['127.0.0.1'], 'example.com': ['198.51.100.99'] };
    const ans = (h, o) => (o && o.all ? FAKE[h].map((a) => ({ address: a, family: 4 })) : null);
    dns.lookup = (h, ...r) => { const cb = r[r.length - 1]; const o = typeof r[0] === 'object' ? r[0] : null; process.nextTick(() => (ans(h, o) ? cb(null, ans(h, o)) : cb(null, FAKE[h][0], 4))); };
    dns.promises.lookup = async (h, o) => ans(h, o) || { address: FAKE[h][0], family: 4 };
    net.connect = () => 'FAKE'; tls.connect = () => 'FAKE';
    const { installLiveNetGuard } = await import(${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'scripts', 'live-net-guard.mjs')).href)});
    const g = installLiveNetGuard(); const out = {};
    const tryIt = async (label, fn) => { try { await fn(); out[label] = 'OPENED'; } catch (e) { out[label] = e.code || e.message; } };
    const cbLookup = (h) => new Promise((res, rej) => dns.lookup(h, (e, a) => (e ? rej(e) : res(a))));
    await tryIt('before-lookup', () => net.connect({ host: '203.0.113.10', port: 443 }));
    await tryIt('lookup-firestore', () => dns.promises.lookup('firestore.googleapis.com', { all: true }));
    await tryIt('net-learned-443', () => net.connect({ host: '203.0.113.10', port: 443 }));
    await tryIt('net-learned-443-args', () => net.connect(443, '203.0.113.11'));
    await tryIt('tls-learned-443', () => tls.connect({ host: '203.0.113.10', port: 443, servername: 'firestore.googleapis.com' }));
    await tryIt('learned-8443', () => net.connect({ host: '203.0.113.10', port: 8443 }));
    await tryIt('learned-80', () => net.connect(80, '203.0.113.10'));
    await tryIt('learned-noport', () => net.connect({ host: '203.0.113.10' }));
    await tryIt('unknown-ip-443', () => net.connect({ host: '203.0.113.99', port: 443 }));
    await tryIt('metadata-ip-443', () => net.connect({ host: '169.254.169.254', port: 443 }));
    await tryIt('metadata-ip-80', () => net.connect(80, '169.254.169.254'));
    await tryIt('metadata-name-443', () => net.connect({ host: 'metadata.google.internal', port: 443 }));
    await tryIt('lookup-storage-poisoned', () => cbLookup('storage.googleapis.com'));
    await tryIt('poisoned-metadata-443', () => net.connect({ host: '169.254.169.254', port: 443 }));
    await tryIt('lookup-iam-poisoned', () => dns.promises.lookup('iamcredentials.googleapis.com'));
    await tryIt('poisoned-loopback-443', () => tls.connect({ host: '127.0.0.1', port: 443 }));
    await tryIt('lookup-oauth2-callback', () => cbLookup('oauth2.googleapis.com'));
    await tryIt('net-learned-callback-443', () => net.connect({ host: '198.51.100.7', port: 443 }));
    await tryIt('lookup-example', () => cbLookup('example.com'));
    await tryIt('unrelated-ip-443', () => net.connect({ host: '198.51.100.99', port: 443 }));
    await tryIt('bankid-name-443', () => net.connect({ host: 'oidc.bankid.no', port: 443 }));
    await tryIt('fetch-learned-ip', () => fetch('https://203.0.113.10/'));
    await tryIt('https-learned-ip', () => new Promise((res, rej) => { const q = https.request('https://203.0.113.10:443/', res); q.on('error', rej); q.end(); }));
    await tryIt('http2-learned-ip', () => new Promise((res, rej) => { const s = http2.connect('https://203.0.113.10'); s.on('connect', res); s.on('error', rej); }));
    console.log(JSON.stringify({ out, resolved: g.resolved, attempts: g.attempts }));
  `;
  const r2 = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script2], { encoding: 'utf8', timeout: 30000 }).trim().split('\n').pop());
  const OPENED = ['lookup-firestore', 'net-learned-443', 'net-learned-443-args', 'tls-learned-443', 'lookup-storage-poisoned', 'lookup-iam-poisoned', 'lookup-oauth2-callback', 'net-learned-callback-443'];
  assert.equal(Object.keys(r2.out).length, 24);
  for (const [k, v] of Object.entries(r2.out)) assert.equal(v, OPENED.includes(k) ? 'OPENED' : 'NETWORK_REFUSED_BY_LIVE_ALLOWLIST', k);
  assert.deepEqual(r2.resolved, { '203.0.113.10': 'firestore.googleapis.com', '203.0.113.11': 'firestore.googleapis.com', '198.51.100.7': 'oauth2.googleapis.com' });   // poisoned (metadata / loopback) answers and non-allowlisted hosts are never learned
  assert.equal(r2.attempts['203.0.113.10'].allowed, 2); assert.equal(r2.attempts['203.0.113.10'].blocked, 7);
  assert.ok(r2.attempts['169.254.169.254'].allowed === 0 && r2.attempts['127.0.0.1'].allowed === 0 && r2.attempts['203.0.113.99'].allowed === 0 && r2.attempts['198.51.100.99'].allowed === 0 && r2.attempts['oidc.bankid.no'].allowed === 0 && r2.attempts['example.com'].allowed === 0 && r2.attempts['metadata.google.internal'].allowed === 0);
});
await t('V12', 'RUNNER END-TO-END LOCALLY (module constant = not authorized): main() with a complete live environment and a correct ADC fixture stops at the code-level gate BEFORE any Google library is imported or any socket opens, still writes a redacted evidence file (final FAIL, refused LIVE_CLOUD_WRITES_NOT_AUTHORIZED), exit status false; the grant registry is minted only by live-smoke-gate.mjs; the evidence directory lives outside functions/ (never packaged)', async () => {
  const env = Object.assign({}, LIVE, withAdc(impersonated(SA)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bid2c-run-'));
  const logs = [];
  const r = await runnerMain({ argv: ['--run-id', RUN], env, platform: 'win32', evidenceDir: dir, log: (s) => logs.push(s) });
  assert.equal(r.ok, false); assert.equal(r.final, 'FAIL'); assert.equal(r.runId, RUN);
  const doc = JSON.parse(fs.readFileSync(r.evidencePath, 'utf8'));
  assert.equal(doc.refused, UNAUTH); assert.equal(doc.final, 'FAIL'); assert.equal(doc.network, null, 'guard never installed = no library loaded'); assert.equal(doc.adc.serviceAccount, SA);
  assert.ok(logs.some((l) => l.startsWith('REFUSED ' + UNAUTH)) && logs.some((l) => l === 'LIVE_SMOKE_RESULT FAIL'));
  for (const re of SECRET_VALUE_PATTERNS) assert.ok(!re.test(fs.readFileSync(r.evidencePath, 'utf8')));
  const r2 = await runnerMain({ argv: ['--run-id', RUN, '--bucket', 'x'], env, platform: 'win32', evidenceDir: dir, log: () => {} });
  assert.equal(r2.ok, false); assert.equal(JSON.parse(fs.readFileSync(r2.evidencePath, 'utf8')).refused, 'UNEXPECTED_ARGUMENT');
  const srcDir = path.join(HERE, '..', 'src'); const callers = [];
  for (const f of fs.readdirSync(srcDir).concat(['../scripts/run-live-smoke.mjs', '../scripts/live-net-guard.mjs', '../index.mjs'])) { const s = fs.readFileSync(path.join(srcDir, f), 'utf8').replace(/^\s*\/\/.*$/gm, ''); if (/registerLiveSmokeGrant\(/.test(s)) callers.push(path.basename(f)); }
  assert.deepEqual(callers.sort(), ['live-smoke-gate.mjs', 'preprod-config.mjs']);
  assert.equal(path.basename(path.dirname(EVIDENCE_DIR)), path.basename(path.resolve(HERE, '..', '..'))); assert.ok(!EVIDENCE_DIR.startsWith(path.resolve(HERE, '..') + path.sep));
  assert.deepEqual(touched, []);
});
await t('V14', 'EXEC STATE (only when the module literal authorizes a run): with the real literal, a verified ADC fixture and the correct release-id echo, the gate issues a grant for EXACTLY the authorized run id; any other run id, a wrong echo, an emulator variable, a key path, a missing ADC and the wrong impersonation target are still refused; no handle touched', async () => {
  if (!EXEC) { lines.push('INFO  V14  skipped: module literal is the unauthorized default'); return; }
  const adc = goodAdc();
  const envExec = Object.assign({}, LIVE, { SORMENA_LIVE_SMOKE_RELEASE_ID: LIVE_SMOKE_AUTHORIZATION.releaseId });
  const g = issueLiveSmokeGrant({ env: envExec, runId: LIVE_SMOKE_AUTHORIZATION.runId, adcIdentity: adc });
  assert.ok(isLiveSmokeGrant(g)); assert.equal(g.runId, LIVE_SMOKE_AUTHORIZATION.runId); assert.equal(g.releaseId, LIVE_SMOKE_AUTHORIZATION.releaseId); assert.equal(g.serviceAccount, SA); assert.equal(g.bucket, BANKID_PREPROD.signingArtifactBucket);
  assert.equal(code(() => issueLiveSmokeGrant({ env: envExec, runId: 'smoke-live0003', adcIdentity: adc })), 'LIVE_SMOKE_RUN_ID_NOT_AUTHORIZED');
  assert.equal(code(() => issueLiveSmokeGrant({ env: LIVE, runId: LIVE_SMOKE_AUTHORIZATION.runId, adcIdentity: adc })), 'LIVE_SMOKE_RELEASE_ID_MISMATCH');
  assert.equal(code(() => issueLiveSmokeGrant({ env: Object.assign({}, envExec, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080' }), runId: LIVE_SMOKE_AUTHORIZATION.runId, adcIdentity: adc })), 'EMULATOR_ENV_IN_LIVE_MODE');
  assert.equal(code(() => issueLiveSmokeGrant({ env: Object.assign({}, envExec, { GOOGLE_APPLICATION_CREDENTIALS: 'x.json' }), runId: LIVE_SMOKE_AUTHORIZATION.runId, adcIdentity: adc })), 'SA_KEY_PATH_REFUSED');
  assert.equal(code(() => issueLiveSmokeGrant({ env: envExec, runId: LIVE_SMOKE_AUTHORIZATION.runId, adcIdentity: readAdcIdentity({ env: withAdc(null), platform: 'win32' }) })), 'ADC_ABSENT');
  assert.equal(code(() => issueLiveSmokeGrant({ env: envExec, runId: LIVE_SMOKE_AUTHORIZATION.runId, adcIdentity: readAdcIdentity({ env: withAdc(impersonated('other@sormena-bankid-preprod.iam.gserviceaccount.com')), platform: 'win32' }) })), 'ADC_IMPERSONATION_TARGET_MISMATCH');
  assert.equal(code(() => issueLiveSmokeGrant({ env: Object.assign({}, envExec, { SORMENA_SIGNING_PROJECT_ID: 'sormena-prod' }), runId: LIVE_SMOKE_AUTHORIZATION.runId, adcIdentity: adc })), 'PRODUCTION_PROJECT_REFUSED');
  assert.deepEqual(touched, []);
});
await t('V15', 'ONE-SHOT CONSUMPTION MARKER (-016A): the first consume creates <runId>.consumed.json exclusively (flag wx) with ONLY the five non-secret facts; a second consume of the same run id is refused LIVE_SMOKE_RUN_ALREADY_CONSUMED and the marker bytes are unchanged; a prior FAILED attempt (evidence with network != null) consumes the run id without a marker being manufactured; unreadable evidence fails closed; evidence of a locally refused run (network == null) does not consume; an invalid run id writes nothing; other run ids are unaffected; nothing in the runner or the evidence module deletes or rewrites a marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bid2c-consume-'));
  const facts = { runId: 'smoke-oneshot01', releaseId: 'SIRRHA-CCODE-TEST-FIXTURE-AUTHORIZATION-000', startedAt: '2026-10-03T10:00:00.000Z', projectId: BANKID_PREPROD.projectId, serviceAccount: SA, access_token: 'ya29.' + 'a'.repeat(40), refresh_token: '1//' + 'b'.repeat(40), adc: impersonated(SA) };
  assert.equal(findRunConsumption(dir, facts.runId), null);
  const flags = []; const spyFs = Object.assign({}, fs, { writeFileSync: (pp, d, o) => { flags.push(o && o.flag); return fs.writeFileSync(pp, d, o); } });
  const c = consumeLiveRun(dir, facts, spyFs);
  assert.deepEqual(flags, ['wx']); assert.equal(path.basename(c.path), 'smoke-oneshot01.consumed.json'); assert.equal(consumptionMarkerName(facts.runId), 'smoke-oneshot01.consumed.json');
  const raw = fs.readFileSync(c.path, 'utf8'); const doc = JSON.parse(raw);
  assert.deepEqual(Object.keys(doc).sort(), ['markerVersion', 'projectId', 'releaseId', 'runId', 'serviceAccount', 'startedAt']);
  assert.deepEqual(doc, { markerVersion: CONSUMPTION_MARKER_VERSION, runId: facts.runId, releaseId: facts.releaseId, startedAt: facts.startedAt, projectId: BANKID_PREPROD.projectId, serviceAccount: SA });
  for (const re of SECRET_VALUE_PATTERNS) assert.ok(!re.test(raw)); assert.ok(!/token|secret|source_credentials|private_key/i.test(raw));
  assert.deepEqual(findRunConsumption(dir, facts.runId), { by: 'marker', file: 'smoke-oneshot01.consumed.json' });
  assert.equal(code(() => consumeLiveRun(dir, facts)), 'LIVE_SMOKE_RUN_ALREADY_CONSUMED');
  assert.equal(code(() => consumeLiveRun(dir, Object.assign({}, facts, { releaseId: 'SIRRHA-CCODE-ANOTHER-RELEASE-001' }))), 'LIVE_SMOKE_RUN_ALREADY_CONSUMED', 'a new release id does not revive a consumed run id');
  assert.equal(fs.readFileSync(c.path, 'utf8'), raw, 'marker never rewritten');
  // atomic create-only at the file layer itself: even if the pre-check saw nothing, an existing marker makes wx fail
  const blindFs = Object.assign({}, fs, { existsSync: (pp) => (String(pp).endsWith('.consumed.json') ? false : fs.existsSync(pp)) });
  assert.equal(code(() => consumeLiveRun(dir, facts, blindFs)), 'LIVE_SMOKE_RUN_ALREADY_CONSUMED'); assert.equal(fs.readFileSync(c.path, 'utf8'), raw);
  // a prior FAILED attempt that reached the network path (the smoke-live0001 shape) consumes without any marker
  const ev = (run, network) => fs.writeFileSync(path.join(dir, run + '-2026-10-03T07-57-20-888Z.evidence.json'), JSON.stringify({ runId: run, network, final: 'FAIL' }));
  ev('smoke-failed001', { allowlist: [], port: 443, attempts: {}, blocked: [] });
  assert.deepEqual(findRunConsumption(dir, 'smoke-failed001'), { by: 'evidence', file: 'smoke-failed001-2026-10-03T07-57-20-888Z.evidence.json' });
  assert.equal(code(() => consumeLiveRun(dir, Object.assign({}, facts, { runId: 'smoke-failed001' }))), 'LIVE_SMOKE_RUN_ALREADY_CONSUMED'); assert.ok(!fs.existsSync(path.join(dir, 'smoke-failed001.consumed.json')), 'no retroactive marker');
  fs.writeFileSync(path.join(dir, 'smoke-broken001-2026-10-03T08-00-00-000Z.evidence.json'), '{not json');
  assert.equal(code(() => consumeLiveRun(dir, Object.assign({}, facts, { runId: 'smoke-broken001' }))), 'LIVE_SMOKE_RUN_ALREADY_CONSUMED');
  // evidence of a run refused at a local gate (guard never installed) does NOT consume
  ev('smoke-refused01', null);
  assert.equal(findRunConsumption(dir, 'smoke-refused01'), null);
  assert.ok(fs.existsSync(consumeLiveRun(dir, Object.assign({}, facts, { runId: 'smoke-refused01' })).path));
  // prefix safety + invalid ids
  assert.equal(findRunConsumption(dir, 'smoke-failed0019'), null); assert.equal(findRunConsumption(dir, 'smoke-failed00'), null);
  const before = fs.readdirSync(dir).sort();
  for (const bad of ['../smoke-x0001', 'smoke-UPPER001', 'smoke-a/../../b', '', null, undefined, 'smoke-abc']) assert.equal(code(() => consumeLiveRun(dir, Object.assign({}, facts, { runId: bad }))), 'SMOKE_RUN_ID_INVALID', String(bad));
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  const src = ['../scripts/run-live-smoke.mjs', '../src/live-smoke-evidence.mjs'].map((f) => fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')).join('\n');
  assert.ok(!/unlink|rmSync|rmdir|renameSync|truncate|\.rm\(/.test(src), 'no code path removes or rewrites a marker');
  // the real historical evidence (if present on this machine) is read-only proof of consumption for smoke-live0001; never touched
  const hist = fs.existsSync(EVIDENCE_DIR) ? fs.readdirSync(EVIDENCE_DIR).filter((n) => n.startsWith('smoke-live0001-')) : [];
  if (hist.length) { const h0 = fs.readFileSync(path.join(EVIDENCE_DIR, hist[0])); const c0 = findRunConsumption(EVIDENCE_DIR, 'smoke-live0001'); assert.equal(c0 && c0.by, 'evidence'); assert.ok(fs.readFileSync(path.join(EVIDENCE_DIR, hist[0])).equals(h0)); assert.ok(!fs.existsSync(path.join(EVIDENCE_DIR, 'smoke-live0001.consumed.json'))); lines.push('INFO  V15  historical smoke-live0001 evidence present: run id is consumed by evidence, no marker manufactured'); }
});
await t('V16', 'RUNNER CONSUMPTION ORDER (-016A): in main() the marker is created AFTER argument, authorization, environment and ADC gates and the package check, and BEFORE the live network guard, any Google library import and any handle; an unauthorized run id, a rejected argument, an absent ADC and a wrong impersonation target create NO marker; with an authorized literal, a second invocation of the authorized run id (existing marker, or a prior failed network attempt) is refused LIVE_SMOKE_RUN_ALREADY_CONSUMED with network == null (guard never installed)', async () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'scripts', 'run-live-smoke.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const body = src.slice(src.indexOf('export async function main'));
  const at = (x) => { const i = body.indexOf(x); assert.ok(i >= 0, x); return i; };
  const order = ['parseRunnerArgs(', 'assertLivePreflight(', 'verifySharedPackage(', 'consumeLiveRun(', 'METADATA_SERVER_DETECTION', 'installLiveNetGuard(', "import('firebase-admin/app')", 'initializeApp(', 'runPreprodSmoke('].map(at);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], 'order ' + i);
  assert.equal(body.split('consumeLiveRun(').length, 2, 'exactly one consumption point');
  const markers = (d) => fs.readdirSync(d).filter((n) => n.endsWith('.consumed.json'));
  const run = async (argv, env) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bid2c-run16-')); const r = await runnerMain({ argv, env, platform: 'win32', evidenceDir: d, log: () => {} }); return { d, r, doc: JSON.parse(fs.readFileSync(r.evidencePath, 'utf8')) }; };
  const good = () => Object.assign({}, LIVE, withAdc(impersonated(SA)));
  let x = await run(['--run-id', RUN], good());                       // not the authorized run id (or nothing authorized)
  assert.equal(x.doc.refused, UNAUTH); assert.deepEqual(markers(x.d), []); assert.equal(x.doc.network, null);
  x = await run(['--run-id', RUN, '--project', 'sormena-prod'], good());
  assert.equal(x.doc.refused, 'UNEXPECTED_ARGUMENT'); assert.deepEqual(markers(x.d), []);
  if (!EXEC) { lines.push('INFO  V16  authorized-run cases skipped: module literal is the unauthorized default'); assert.deepEqual(touched, []); return; }
  const AR = LIVE_SMOKE_AUTHORIZATION.runId; const echo = { SORMENA_LIVE_SMOKE_RELEASE_ID: LIVE_SMOKE_AUTHORIZATION.releaseId };
  x = await run(['--run-id', AR], Object.assign({}, LIVE, echo, withAdc(null)));                         // failed ADC: absent
  assert.equal(x.doc.refused, 'ADC_ABSENT'); assert.deepEqual(markers(x.d), []); assert.equal(x.doc.network, null);
  x = await run(['--run-id', AR], Object.assign({}, LIVE, echo, withAdc(impersonated('other@sormena-bankid-preprod.iam.gserviceaccount.com'))));
  assert.equal(x.doc.refused, 'ADC_IMPERSONATION_TARGET_MISMATCH'); assert.deepEqual(markers(x.d), []);
  x = await run(['--run-id', AR], Object.assign({}, good(), { SORMENA_LIVE_SMOKE_RELEASE_ID: 'SIRRHA-CCODE-WRONG-RELEASE-ECHO-000' }));   // failed preflight
  assert.equal(x.doc.refused, 'LIVE_SMOKE_RELEASE_ID_MISMATCH'); assert.deepEqual(markers(x.d), []);
  // second invocation, marker present (whatever the first attempt's outcome was): refused before the network path
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'bid2c-run16-'));
  const first = consumeLiveRun(d1, { runId: AR, releaseId: LIVE_SMOKE_AUTHORIZATION.releaseId, startedAt: '2026-10-03T10:00:00.000Z', projectId: BANKID_PREPROD.projectId, serviceAccount: SA });
  const raw = fs.readFileSync(first.path, 'utf8'); const logs = [];
  const r1 = await runnerMain({ argv: ['--run-id', AR], env: Object.assign({}, good(), echo), platform: 'win32', evidenceDir: d1, log: (l) => logs.push(l) });
  const doc1 = JSON.parse(fs.readFileSync(r1.evidencePath, 'utf8'));
  assert.equal(r1.ok, false); assert.equal(doc1.refused, 'LIVE_SMOKE_RUN_ALREADY_CONSUMED'); assert.equal(doc1.network, null, 'guard never installed'); assert.deepEqual(doc1.steps, []);
  assert.equal(fs.readFileSync(first.path, 'utf8'), raw); assert.ok(!logs.some((l) => l.startsWith('CONSUMED ')));
  // second invocation after a FAILED first attempt recorded only as evidence (no marker): still refused, no marker manufactured
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bid2c-run16-'));
  fs.writeFileSync(path.join(d2, AR + '-2026-10-03T07-57-20-888Z.evidence.json'), JSON.stringify({ runId: AR, network: { attempts: {} }, final: 'FAIL' }));
  const r2 = await runnerMain({ argv: ['--run-id', AR], env: Object.assign({}, good(), echo), platform: 'win32', evidenceDir: d2, log: () => {} });
  const doc2 = JSON.parse(fs.readFileSync(r2.evidencePath, 'utf8'));
  assert.equal(doc2.refused, 'LIVE_SMOKE_RUN_ALREADY_CONSUMED'); assert.equal(doc2.network, null); assert.deepEqual(markers(d2), []);
  assert.deepEqual(touched, []);
});
await t('V13', 'no network attempt anywhere in this suite (fetch/http/https/net/tls/http2 guarded); no BankID traffic possible', async () => { assert.deepEqual(blocked, []); });

for (const l of lines) console.log(l);
console.log('BID2C_LIVE_PREP_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
