// bid2a-preprod-binding.proof.mjs — BID-2A: the production-shaped Firestore repository + private Cloud Storage adapter,
// bound to the PREPROD identity (Admin app projectId sormena-bankid-preprod, bucket sormena-bankid-preprod-signing-
// artifacts) but talking ONLY to the local emulators. The emulator suite itself runs as the offline demo project
// (demo-sormena), so no tool can reach a real project; the proof refuses to start unless both emulator hosts are loopback.
// Run: firebase emulators:exec --only firestore,storage --project demo-sormena --config <repo>/firebase.signing.local.json "node <this file>"
process.env.METADATA_SERVER_DETECTION = 'none';   // never probe the Cloud metadata server (no credentials exist or are used)
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK } from 'jose';
import { installNetGuard, blocked } from '../net-guard.mjs';
import { frozenEmployee1, T, NOW, ADMIN_UID } from '../fixtures.mjs';
import { BANKID_PREPROD, resolveSigningTarget } from '../../src/preprod-config.mjs';
import { createSigningTransactionRepository } from '../../src/firestore-stores.mjs';
import { createGcsArtifactStore } from '../../src/gcs-artifact-store.mjs';
import { createFakeWysiwys } from '../../src/fake-wysiwys.mjs';
import { createSigningService, isSigned } from '../../src/signing-service.mjs';
installNetGuard();

const results = []; let n = 0;
const J = (v) => JSON.stringify(v);
const rec = (id, desc, pass, detail) => { results.push({ n: ++n, id, desc, pass: !!pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + id + ' | ' + desc + ' | ' + J(detail === undefined ? '' : detail).slice(0, 420)); };
const loop = (h) => typeof h === 'string' && /^(127\.0\.0\.1|localhost):\d+$/.test(h);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const code = async (p) => { try { await p; return 'NO_THROW'; } catch (e) { return e.code || e.message; } };

try {
  if (!loop(process.env.FIRESTORE_EMULATOR_HOST) || !loop(process.env.FIREBASE_STORAGE_EMULATOR_HOST)) throw new Error('REFUSING TO RUN: emulator hosts are not loopback');
  // explicit target resolution exactly as the future function would do it (synthetic env: explicit names, agreeing signal)
  const target = resolveSigningTarget({ SORMENA_SIGNING_PROJECT_ID: BANKID_PREPROD.projectId, SORMENA_SIGNING_BUCKET: BANKID_PREPROD.signingArtifactBucket, GCLOUD_PROJECT: BANKID_PREPROD.projectId });
  const app = initializeApp({ projectId: target.projectId }, 'bid2a-preprod');
  const db = getFirestore(app); db.settings({ ignoreUndefinedProperties: true });
  const bucket = getStorage(app).bucket(target.bucket);
  const env = { FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST: process.env.FIREBASE_STORAGE_EMULATOR_HOST };
  const repo = createSigningTransactionRepository({ app, db, target, mode: 'emulator', env });
  const store = createGcsArtifactStore({ bucket, target, mode: 'emulator', env });
  rec('B01', 'BINDING: target resolved explicitly (no default) to project sormena-bankid-preprod / (default) database / bucket sormena-bankid-preprod-signing-artifacts / europe-west1; repository and artifact adapter accepted only after the Admin app, database and bucket matched it (emulator mode, loopback hosts)', repo.target.projectId === 'sormena-bankid-preprod' && store.target.bucket === 'sormena-bankid-preprod-signing-artifacts' && repo.target.region === 'europe-west1' && repo.target.databaseId === '(default)', { target, fs: env.FIRESTORE_EMULATOR_HOST, st: env.FIREBASE_STORAGE_EMULATOR_HOST });

  // ---- full fake flow over the preprod-shaped Firestore repository + private bucket adapter ----
  let now = NOW; const clock = () => now;
  const keys = await generateKeyPair('ES256'); const jwk = Object.assign(await exportJWK(keys.publicKey), { kid: 'fake-k1', alg: 'ES256' });
  const fake = createFakeWysiwys({ clock, signingKey: keys.privateKey, kid: 'fake-k1', issuer: 'fake.esign-stoetest.local', alg: 'ES256' });
  const svc = createSigningService({ txStore: repo, artifactStore: store, provider: fake.api, clock, config: { environment: 'fake', targetProjectId: target.projectId, verifier: { jwks: { keys: [jwk] }, issuer: 'fake.esign-stoetest.local', algorithms: ['ES256'] } } });
  const fx = frozenEmployee1();
  const versionBefore = J(fx.employee().contractVersions); const passedBefore = J(fx.version);
  const EMR = { uid: ADMIN_UID, name: 'Herish Hashemi', birthdate: '1980-01-01' };
  const init = () => svc.initiate({ tenantId: T, ansattId: fx.ansattId, version: fx.version, employerSigner: EMR, actorUid: ADMIN_UID });
  const signAs = async (txId, person) => { const s = await svc.startSession({ tenantId: T, txId }); await fake.control.userSigns(s.signId, person); await svc.refresh({ tenantId: T, txId }); return s; };

  // attempt 1: employer rejects -> terminal, then a NEW attempt reuses the same frozen source A (object not rewritten)
  const i1 = await init();
  const aMeta1 = await store.metadataOf(i1.tx.source.artifactRef);
  const s1 = await svc.startSession({ tenantId: T, txId: i1.tx.txId }); fake.control.userRejects(s1.signId); await svc.refresh({ tenantId: T, txId: i1.tx.txId });
  const tx1 = await repo.get(T, i1.tx.txId);
  const i2 = await init();
  const aMeta2 = await store.metadataOf(i2.tx.source.artifactRef);
  rec('B02', 'RETRY: attempt 1 rejected by the employer (terminal, lock released); attempt 2 is a NEW transaction (…-sig-2) that reuses the IDENTICAL frozen source A — same sha256, same object generation (never rewritten), same key', tx1.status === 'rejected' && i2.ok && i2.tx.attempt === 2 && i2.tx.txId.endsWith('-sig-2') && i2.tx.source.sourcePdfSha256 === i1.tx.source.sourcePdfSha256 && i2.tx.source.reusedExistingArtifact === true && aMeta2.generation === aMeta1.generation && i2.tx.source.artifactRef === i1.tx.source.artifactRef, { gen: [aMeta1.generation, aMeta2.generation], sha: i2.tx.source.sourcePdfSha256.slice(0, 16) });

  const txId = i2.tx.txId;
  await signAs(txId, { sub: 'UN:NO-FAKE-EMR', name: 'Herish Hashemi', birthdate: '1980-01-01' });
  const mid = await repo.get(T, txId);
  await signAs(txId, { sub: 'UN:NO-FAKE-EMP', name: 'Test Ansatt 01', birthdate: '1995-04-12' });
  const tx = await repo.get(T, txId);
  const C = await store.get(tx.finalArtifact.ref, tx.finalArtifact.sha256);
  rec('B03', 'FULL FAKE FLOW over the preprod-shaped repository + private bucket: A -> employer -> B -> employee -> C; completed only with BOTH verified signers + durable final object whose bytes AND stored sha256 metadata match; chain recorded; derived signed', tx.status === 'completed' && isSigned(tx) && mid.status === 'awaiting_signer' && tx.signers.every((s) => s.status === 'signed' && s.identity.matched && s.evidence) && tx.signers[0].output.inputSha256 === tx.source.sourcePdfSha256 && tx.signers[1].output.inputSha256 === tx.signers[0].output.sha256 && tx.finalArtifact.sha256 === tx.signers[1].output.sha256 && sha(C) === tx.finalArtifact.sha256 && tx.targetProjectId === 'sormena-bankid-preprod', { status: tx.status, rev: tx.rev, chain: [tx.source.sourcePdfSha256.slice(0, 12), tx.signers[0].output.sha256.slice(0, 12), tx.finalArtifact.sha256.slice(0, 12)] });

  // ---- object metadata binding ----
  const [mA, mB, mC] = await Promise.all([store.metadataOf(tx.source.artifactRef), store.metadataOf(tx.signers[0].output.ref), store.metadataOf(tx.finalArtifact.ref)]);
  const ok = (m, stage, h, withTx, role) => m.contentType === 'application/pdf' && m.metadata.stage === stage && m.metadata.sha256 === h && m.metadata.tenantId === T && m.metadata.ansattId === fx.ansattId && m.metadata.contractVersionId === fx.version.contractVersionId && (withTx ? m.metadata.txId === txId && m.metadata.signerRole === role : !m.metadata.txId);
  const [files] = await bucket.getFiles({ prefix: 'tenants/' + T + '/contracts/' });
  rec('B04', 'ARTIFACT METADATA BINDING in the private bucket: A {stage source_unsigned, snapshot hash, generator}, B {employer_signed, txId, employer}, C {final_signed, txId, employee}; every object application/pdf with tenant/employee/contract-version ids and its sha256; exactly the expected objects exist (A once for both attempts, B, C)', ok(mA, 'source_unsigned', tx.source.sourcePdfSha256, false) && mA.metadata.sourceSnapshotSha256 === tx.source.sourceSnapshotSha256 && ok(mB, 'employer_signed', tx.signers[0].output.sha256, true, 'employer') && ok(mC, 'final_signed', tx.finalArtifact.sha256, true, 'employee') && files.length === 3, { A: mA.metadata, objects: files.map((f) => f.name) });

  // ---- create-only / immutability in the bucket ----
  const conflict = await code(store.putOnce(tx.finalArtifact.ref, Buffer.from('%PDF-1.7 tampered'), { stage: 'final_signed', tenantId: T, ansattId: fx.ansattId, contractVersionId: fx.version.contractVersionId, txId }));
  const same = await store.putOnce(tx.finalArtifact.ref, C, { stage: 'final_signed', tenantId: T, ansattId: fx.ansattId, contractVersionId: fx.version.contractVersionId, txId });
  const mC2 = await store.metadataOf(tx.finalArtifact.ref);
  const noBinding = await code(store.putOnce('tenants/' + T + '/contracts/x/y.pdf', Buffer.from('%PDF-1.7'), { stage: 'final_signed', tenantId: T }));
  rec('B05', 'CREATE-ONLY: different bytes on an existing key -> ARTIFACT_IMMUTABLE_CONFLICT (precondition ifGenerationMatch 0); identical bytes -> reused, generation unchanged; an object without full binding metadata is refused before upload', conflict === 'ARTIFACT_IMMUTABLE_CONFLICT' && same.reused === true && mC2.generation === mC.generation && noBinding === 'ARTIFACT_BINDING_REQUIRED', { conflict, reused: same.reused, gen: [mC.generation, mC2.generation], noBinding });

  // ---- tamper detection: bytes changed out-of-band -> read refused; a tampered result can never be marked signed ----
  await bucket.file(tx.signers[0].output.ref).save(Buffer.from('%PDF-1.7 out-of-band change'), { resumable: false });   // raw admin overwrite (simulated attack), not via the adapter
  const tamper = await code(store.get(tx.signers[0].output.ref, tx.signers[0].output.sha256));
  rec('B06', 'HASH-VERIFIED READS: an object altered out-of-band no longer matches its recorded sha256 -> ARTIFACT_HASH_MISMATCH (the next signer/gate could never consume it)', tamper === 'ARTIFACT_HASH_MISMATCH', { tamper });

  // ---- separation: signing truth only in its own collections; frozen contract untouched ----
  const cols = (await db.doc('tenants/' + T).listCollections()).map((c) => c.id).sort();
  rec('B07', 'SEPARATE SIGNING TRUTH: in the preprod-shaped Firestore namespace the tenant has ONLY signingLocks + signingTransactions (no contract/employee collection is written); the frozen contract version objects are deep-equal before/after the whole flow (signingTransaction/signedArtifactMeta still null)', J(cols) === J(['signingLocks', 'signingTransactions']) && J(fx.employee().contractVersions) === versionBefore && J(fx.version) === passedBefore && fx.version.signingTransaction === null && fx.version.signedArtifactMeta === null, { cols });

  // ---- no NIN / PID / raw JWT / secrets in anything persisted ----
  const txDocs = (await db.collection('tenants/' + T + '/signingTransactions').get()).docs.map((d) => J(d.data()));
  const metas = J([mA, mB, mC]);
  const bad = /eyJ[A-Za-z0-9_-]{10,}|2\.16\.578\.1\.61\.2\.[34]|\b\d{11}\b|client_secret|access_token/;
  rec('B08', 'NO NIN / PID / raw JWT / token / secret persisted in any transaction document or object metadata', !txDocs.some((s) => bad.test(s)) && !bad.test(metas), { txDocs: txDocs.length });

  // ---- refusals against the SAME live emulator: wrong/prod bucket or app never gets an adapter, nothing written ----
  const before = (await bucket.getFiles({ prefix: '' }))[0].length;
  const prodApp = initializeApp({ projectId: 'sormena-prod' }, 'bid2a-prod-attempt');
  const r1 = await code((async () => createSigningTransactionRepository({ app: prodApp, db: getFirestore(prodApp), target, mode: 'emulator', env }))());
  const r2 = await code((async () => createGcsArtifactStore({ bucket: getStorage(app).bucket('sormena-prod.firebasestorage.app'), target, mode: 'emulator', env }))());
  const r3 = await code((async () => createGcsArtifactStore({ bucket, target, mode: 'live', env: {} }))());
  const prodCols = await db.doc('tenants/' + T).listCollections();
  const after = (await bucket.getFiles({ prefix: '' }))[0].length;
  const [prodFiles] = await getStorage(app).bucket('sormena-prod.firebasestorage.app').getFiles().catch(() => [[]]);
  rec('B09', 'FAIL CLOSED BEFORE WRITE: an Admin app for sormena-prod -> PRODUCTION_PROJECT_REFUSED; the production bucket -> PRODUCTION_PROJECT_REFUSED; live mode -> LIVE_CLOUD_WRITES_NOT_AUTHORIZED; no object appeared in either bucket, no document in any other project', r1 === 'PRODUCTION_PROJECT_REFUSED' && r2 === 'PRODUCTION_PROJECT_REFUSED' && r3 === 'LIVE_CLOUD_WRITES_NOT_AUTHORIZED' && after === before && prodFiles.length === 0 && prodCols.length === 2, { r1, r2, r3, objects: [before, after], prodFiles: prodFiles.length });
  rec('B10', 'NO EXTERNAL NETWORK: only loopback emulator traffic (fetch/http/https/net/tls/http2 guarded); zero blocked attempts', blocked.length === 0, blocked);
} catch (e) {
  rec('B-ERR', 'unexpected error', false, String(e && e.stack || e).slice(0, 700));
}
const summary = { cases: results.length, pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length };
console.log('BID2A_EMULATOR_PROOF_SUMMARY ' + J(summary));
process.exit(summary.fail ? 1 : 0);
