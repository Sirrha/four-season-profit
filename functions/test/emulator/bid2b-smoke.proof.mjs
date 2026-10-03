// bid2b-smoke.proof.mjs — BID-2B: the preprod smoke harness executed end-to-end (steps A–K) in EMULATOR mode through the
// real Admin-SDK adapters bound to the preprod identity; emulator suite = offline demo project; no cleanup/delete needed.
// Run: firebase emulators:exec --only firestore,storage --project demo-sormena --config <repo>/firebase.signing.local.json "node <this file>"
process.env.METADATA_SERVER_DETECTION = 'none';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { installNetGuard, blocked } from '../net-guard.mjs';
import { BANKID_PREPROD } from '../../src/preprod-config.mjs';
import { runPreprodSmoke, makeSmokeHandler, SMOKE_TENANT } from '../../src/preprod-smoke.mjs';
import { assertSharedPackageFresh } from '../../index.mjs';
installNetGuard();

const results = []; let n = 0; const J = (v) => JSON.stringify(v);
const rec = (id, desc, pass, detail) => { results.push({ n: ++n, id, desc, pass: !!pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + id + ' | ' + desc + ' | ' + J(detail === undefined ? '' : detail).slice(0, 420)); };
const loop = (h) => typeof h === 'string' && /^(127\.0\.0\.1|localhost):\d+$/.test(h);
try {
  if (!loop(process.env.FIRESTORE_EMULATOR_HOST) || !loop(process.env.FIREBASE_STORAGE_EMULATOR_HOST)) throw new Error('REFUSING TO RUN: emulator hosts are not loopback');
  rec('S00', 'shared package fresh against the repository root (deploy inputs match their sources)', assertSharedPackageFresh().checkedAgainstRoot === true);
  const env = { SORMENA_SIGNING_PROJECT_ID: BANKID_PREPROD.projectId, SORMENA_SIGNING_BUCKET: BANKID_PREPROD.signingArtifactBucket, SORMENA_SIGNING_REGION: BANKID_PREPROD.region, SORMENA_PREPROD_SMOKE_ENABLED: 'true', SORMENA_SIGNING_ADAPTER_MODE: 'emulator',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST: process.env.FIREBASE_STORAGE_EMULATOR_HOST };
  const app = initializeApp({ projectId: BANKID_PREPROD.projectId }, 'bid2b-smoke');
  const db = getFirestore(app); db.settings({ ignoreUndefinedProperties: true });
  const bucket = getStorage(app).bucket(BANKID_PREPROD.signingArtifactBucket);
  // disabled by default: the same handles without the enable flag never run
  const off = await runPreprodSmoke({ app, db, bucket, env: Object.assign({}, env, { SORMENA_PREPROD_SMOKE_ENABLED: undefined }), runId: 'smoke-run0001' });
  const live = await runPreprodSmoke({ app, db, bucket, env: Object.assign({}, env, { SORMENA_SIGNING_ADAPTER_MODE: 'live', SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED: 'true' }), runId: 'smoke-run0001' });
  const cols0 = (await db.listCollections()).map((c) => c.id);
  const { LIVE_SMOKE_AUTHORIZATION } = await import('../../src/live-smoke-gate.mjs');
  const UNAUTH = LIVE_SMOKE_AUTHORIZATION.authorized === true ? 'LIVE_SMOKE_RUN_ID_NOT_AUTHORIZED' : 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED';   // state-aware: a BID-2C single-run literal authorizes exactly one other run id
  rec('S01', 'DISABLED BY DEFAULT / LIVE REFUSED against real handles: no enable flag -> SMOKE_NOT_ENABLED; live mode for this run id -> ' + UNAUTH + '; nothing written', off.refused === 'SMOKE_NOT_ENABLED' && live.refused === UNAUTH && cols0.length === 0 && LIVE_SMOKE_AUTHORIZATION.runId !== 'smoke-run0001', { off: off.refused, live: live.refused, collections: cols0 });
  // run 1
  const r1 = await runPreprodSmoke({ app, db, bucket, env, runId: 'smoke-run0001' });
  rec('S02', 'SMOKE RUN 1 (smoke-run0001): steps A B C L M D E F G H I J K all pass — tx created, deterministic source PDF, A persisted + read back, one-active lock refuses a 2nd initiate, stale-rev CAS refused, fake employer B, fake employee C, chain, metadata, completion gate, Firestore readback + lock released, GCS readback, duplicate-create refused with generation/bytes/metadata unchanged (K2 is live-only)', r1.ok === true && r1.steps.length === 13 && r1.steps.every((s) => s.ok) && !r1.steps.some((s) => s.id === 'K2') && r1.evidence.generations && r1.evidence.paths.lock, { steps: r1.steps.map((s) => s.id + ':' + (s.ok ? 'ok' : 'FAIL')), hashes: r1.evidence.hashes, generations: r1.evidence.generations });
  for (const s of r1.steps) if (!s.ok) console.log('  step detail', s.id, J(s.detail));
  // run 2: a second run id -> its own audit trail; run 1 untouched (no cleanup anywhere)
  const r2 = await runPreprodSmoke({ app, db, bucket, env, runId: 'smoke-run0002' });
  const d1 = await db.doc(r1.evidence.paths.tx).get();
  const [files] = await bucket.getFiles({ prefix: 'tenants/' + SMOKE_TENANT + '/' });
  rec('S03', 'SMOKE RUN 2 (smoke-run0002) passes too; run 1 evidence still present (transaction document completed, 3 objects); runs are separated by run id; 6 objects total; no delete was needed or performed', r2.ok === true && d1.exists && d1.data().status === 'completed' && files.length === 6 && files.every((f) => f.name.includes('/ansatt-smoke-run000')), { objects: files.map((f) => f.name.split('/').slice(-2).join('/')) });
  // run 1 repeated: a new attempt on the same frozen fixture, source A reused (same object), never rewritten
  const r1b = await runPreprodSmoke({ app, db, bucket, env, runId: 'smoke-run0001' });
  const [files2] = await bucket.getFiles({ prefix: 'tenants/' + SMOKE_TENANT + '/' });
  rec('S04', 'REPEATED RUN ID: a new signing attempt (…-sig-2) on the same frozen synthetic version; source A reused (same hash, no new source object), B/C new objects; prior attempt untouched', r1b.ok === true && r1b.evidence.txId.endsWith('-sig-2') && r1b.evidence.hashes.A === r1.evidence.hashes.A && files2.length === 8 && r1b.steps.find((s) => s.id === 'C').detail.reused === true, { tx: r1b.evidence.txId, objects: files2.length });
  // namespace isolation: only the smoke tenant exists; only signing collections under it
  const tenants = (await db.collection('tenants').listDocuments()).map((d) => d.id);
  const under = (await db.doc('tenants/' + SMOKE_TENANT).listCollections()).map((c) => c.id).sort();
  rec('S05', 'NAMESPACE: everything lives under tenant bankid-preprod-smoke (only signingLocks + signingTransactions); no other tenant, no contract/employee collection, no production data required at any point', J(tenants) === J([SMOKE_TENANT]) && J(under) === J(['signingLocks', 'signingTransactions']) && files.every((f) => f.name.startsWith('tenants/' + SMOKE_TENANT + '/contracts/')), { tenants, under });
  // handler surface against the same handles
  const h = makeSmokeHandler({ app, db, bucket, env });
  const hr = await h({ runId: 'smoke-run0003' });
  const hx = await h({ runId: 'smoke-run0003', bucket: 'sormena-prod.firebasestorage.app' });
  rec('S06', 'HANDLER: POST { runId } runs the fixed scenario (200, ok); any extra field (e.g. a bucket) -> 400 UNEXPECTED_INPUT before anything runs', hr.status === 200 && hr.body.ok === true && hx.status === 400 && hx.body.code === 'UNEXPECTED_INPUT', { hr: hr.status, hx: hx.body });
  const txDocs = (await db.collection('tenants/' + SMOKE_TENANT + '/signingTransactions').get()).docs.map((d) => J(d.data()));
  rec('S07', 'NO NIN / PID / raw JWT / token / secret in any smoke transaction document', !txDocs.some((s) => /eyJ[A-Za-z0-9_-]{10,}|2\.16\.578\.1\.61\.2\.[34]|\b\d{11}\b|client_secret|access_token/.test(s)), { docs: txDocs.length });
  // BID-2C: against the same real handles, live mode with BOTH env flags, the release-id echo and a verified impersonated-ADC
  // fixture is still refused by the code-level gate (module constant), and refused again for emulator vars once a fixture
  // authorization is injected at the gate level — nothing new is written either way.
  const { readAdcIdentity } = await import('../../src/adc-identity.mjs');
  const { issueLiveSmokeGrant } = await import('../../src/live-smoke-gate.mjs');
  const { BANKID_PREPROD_RUNTIME } = await import('../../src/preprod-config.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bid2c-emu-adc-')); fs.mkdirSync(path.join(home, 'gcloud'));
  fs.writeFileSync(path.join(home, 'gcloud', 'application_default_credentials.json'), J({ type: 'impersonated_service_account', service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + BANKID_PREPROD_RUNTIME.serviceAccount + ':generateAccessToken', delegates: [], source_credentials: { type: 'authorized_user', client_id: 'fixture', client_secret: 'fixture', refresh_token: 'fixture' } }));
  const adc = readAdcIdentity({ env: { APPDATA: home, HOME: home }, platform: 'win32' });
  const liveEnv = Object.assign({}, env, { SORMENA_SIGNING_ADAPTER_MODE: 'live', SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED: 'true', SORMENA_LIVE_SMOKE_RELEASE_ID: 'SIRRHA-CCODE-TEST-FIXTURE-AUTHORIZATION-000' });
  const txBefore = (await db.collection('tenants/' + SMOKE_TENANT + '/signingTransactions').get()).size;
  const liveConst = await runPreprodSmoke({ app, db, bucket, env: liveEnv, runId: 'smoke-run0009', adcIdentity: adc });
  let emuCode = null; try { issueLiveSmokeGrant({ env: liveEnv, runId: 'smoke-run0009', adcIdentity: adc, authorization: { authorized: true, releaseId: 'SIRRHA-CCODE-TEST-FIXTURE-AUTHORIZATION-000', runId: 'smoke-run0009' } }); emuCode = 'NO_THROW'; } catch (e) { emuCode = e.code; }
  const txAfter = (await db.collection('tenants/' + SMOKE_TENANT + '/signingTransactions').get()).size;
  rec('S09', 'BID-2C LIVE GATE against real handles: verified impersonated-ADC fixture + both flags + release echo -> still ' + UNAUTH + ' for this run id (code constant); with a fixture authorization the emulator variables of this process -> EMULATOR_ENV_IN_LIVE_MODE; no transaction written', adc.ok === true && liveConst.refused === UNAUTH && emuCode === 'EMULATOR_ENV_IN_LIVE_MODE' && txAfter === txBefore && LIVE_SMOKE_AUTHORIZATION.runId !== 'smoke-run0009', { adc: adc.code, constant: liveConst.refused, injected: emuCode, tx: [txBefore, txAfter] });
  rec('S08', 'NO EXTERNAL NETWORK: loopback emulators only; zero blocked attempts', blocked.length === 0, blocked);
} catch (e) { rec('S-ERR', 'unexpected error', false, String(e && e.stack || e).slice(0, 700)); }
const summary = { cases: results.length, pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length };
console.log('BID2B_SMOKE_PROOF_SUMMARY ' + J(summary));
process.exit(summary.fail ? 1 : 0);
