// bid1-emulator.proof.mjs — BID-1 emulator integration proof (Auth + Firestore + Storage emulators; project demo-sormena
// = offline demo project; loopback alternate ports from firebase.signing.local.json; never the default session ports).
// Run via:  firebase emulators:exec --only auth,firestore,storage --project demo-sormena --config <repo>/firebase.signing.local.json "node <this file>"
// Proves: real Firebase ID tokens verified by the Admin SDK at the server boundary; memberships from Firestore; the
// Firestore transaction store (runTransaction CAS + one-active lock) under concurrency; the full fake A->B->C flow over
// Firestore; the ansatte document (incl. the frozen version) byte-identical before/after; candidate rules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { generateKeyPair, exportJWK } from 'jose';
import { installNetGuard, blocked } from '../net-guard.mjs';
import { frozenEmployee1, T, NOW } from '../fixtures.mjs';
import { createFakeWysiwys } from '../../src/fake-wysiwys.mjs';
import { createSigningService, isSigned } from '../../src/signing-service.mjs';
import { createFsArtifactStore } from '../../src/stores.mjs';
import { createFirestoreTransactionStore, createFirestoreMemberships, createFirestoreContracts } from '../../src/firestore-stores.mjs';
import { buildHandlers } from '../../index.mjs';
installNetGuard();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const HARNESS = 'C:/Users/gamme/AppData/Local/Sormena/step-c-emulator/';
const results = []; let n = 0;
const rec = (id, desc, pass, detail) => { results.push({ n: ++n, id, desc, pass: !!pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + id + ' | ' + desc + ' | ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)); };
const must = (h) => { if (!h || !/^(127\.0\.0\.1|localhost):\d+$/.test(h)) throw new Error('emulator host missing or not loopback: ' + h); return h; };
const FS = must(process.env.FIRESTORE_EMULATOR_HOST), AU = must(process.env.FIREBASE_AUTH_EMULATOR_HOST), ST = must(process.env.FIREBASE_STORAGE_EMULATOR_HOST);
const PROJECT = 'demo-sormena';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const J = (v) => JSON.stringify(v);

// Offline emulator run: without this, Google's metadata client probes the Cloud metadata server for default credentials
// (first run: 169.254.169.254 / metadata.google.internal — both BLOCKED by the guard, nothing left the machine).
// METADATA_SERVER_DETECTION=none is gcp-metadata's documented "do not probe" switch. No credential is configured.
process.env.METADATA_SERVER_DETECTION = 'none';
initializeApp({ projectId: PROJECT });
const db = getFirestore(); db.settings({ ignoreUndefinedProperties: true });
const auth = getAuth();
async function signUp(email) {
  const r = await fetch('http://' + AU + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ email, password: 'Passw0rd!bid1', returnSecureToken: true }) });
  const j = await r.json(); if (!j.idToken) throw new Error('signUp failed ' + J(j)); return { uid: j.localId, idToken: j.idToken };
}

try {
  // ---- identities (Auth emulator) + memberships + canonical ansatte documents (seeded with the Admin SDK) ----
  const U = { admin: await signUp('bid1-admin@example.test'), admin2: await signUp('bid1-admin2@example.test'), emp: await signUp('bid1-emp@example.test'), emp2: await signUp('bid1-emp2@example.test') };
  const fx = frozenEmployee1(); const fx2 = frozenEmployee1({ name: 'Test Ansatt 02' });
  const docOf = (f) => ({ navn: f.employee().name, stilling: 'butikkmedarbeider', timelonn: 210, aktiv: true, e360: JSON.parse(J({ name: f.employee().name, contact: f.employee().contact, status: 'active', startDate: '2026-08-01', terms: f.employee().terms, documents: [], contractVersions: f.employee().contractVersions, rev: 7, updatedAt: NOW, lastOp: 'contract:freezeVersion' })) });
  const A1 = 'bid1Ansatt0001', A2 = 'bid1Ansatt0002';
  await db.doc('tenants/' + T + '/ansatte/' + A1).set(docOf(fx));
  await db.doc('tenants/' + T + '/ansatte/' + A2).set(docOf(fx2));
  const mem = (u, role, ansattId) => db.doc('memberships/' + u.uid + '_' + T).set({ uid: u.uid, tenantId: T, accessRole: role, accessEnabled: true, ansattId: ansattId || null });
  await mem(U.admin, 'admin'); await mem(U.admin2, 'admin'); await mem(U.emp, 'employee', A1); await mem(U.emp2, 'employee', A2);
  const before = J((await db.doc('tenants/' + T + '/ansatte/' + A1).get()).data());
  const before2 = J((await db.doc('tenants/' + T + '/ansatte/' + A2).get()).data());

  // ---- server wiring: Admin SDK auth + Firestore stores + fake WYSIWYS + temp artifact store ----
  let now = NOW; const clock = () => now;
  const keys = await generateKeyPair('ES256'); const jwk = Object.assign(await exportJWK(keys.publicKey), { kid: 'fake-k1', alg: 'ES256' });
  const fake = createFakeWysiwys({ clock, signingKey: keys.privateKey, kid: 'fake-k1', issuer: 'fake.esign-stoetest.local', alg: 'ES256' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bid1-artifacts-'));
  const txStore = createFirestoreTransactionStore(db);
  const artifactStore = createFsArtifactStore(tmp);
  const service = createSigningService({ txStore, artifactStore, provider: fake.api, clock, config: { environment: 'fake', returnUrl: 'http://127.0.0.1:18790/bankid/return', verifier: { jwks: { keys: [jwk] }, issuer: 'fake.esign-stoetest.local', algorithms: ['ES256'] } } });
  const H = buildHandlers({ env: { SORMENA_SIGNING_PROVIDER: 'fake' }, auth, memberships: createFirestoreMemberships(db), contracts: createFirestoreContracts(db), service, txStore,
    config: { employerSigner: { uid: U.admin.uid, name: 'Herish Hashemi', birthdate: '1980-01-01' }, appUrl: 'https://sormena.local/' } });
  const cv1 = fx.version.contractVersionId, cv2 = fx2.version.contractVersionId;

  // ---- EM01 auth boundary with REAL ID tokens ----
  const base = { tenantId: T, ansattId: A1, contractVersionId: cv1 };
  const unauth = await H.initiateSigning(base);
  const forged = await H.initiateSigning(Object.assign({ idToken: U.admin.idToken.slice(0, -4) + 'AAAA' }, base));
  const empInit = await H.initiateSigning(Object.assign({ idToken: U.emp.idToken }, base));
  rec('EM01', 'server boundary verifies REAL Auth-emulator ID tokens with the Admin SDK: none -> 401, tampered -> 401, employee initiate -> 403 ADMIN_REQUIRED', unauth.status === 401 && forged.status === 401 && empInit.status === 403 && empInit.body.code === 'ADMIN_REQUIRED', { unauth: unauth.status, forged: forged.status, empInit: empInit.body });

  // ---- EM02 concurrent initiate over Firestore transactions ----
  const [c1, c2, c3] = await Promise.all([0, 1, 2].map(() => H.initiateSigning(Object.assign({ idToken: U.admin.idToken }, base))));
  const created = [c1, c2, c3].filter((x) => x.status === 201); const conflicts = [c1, c2, c3].filter((x) => x.status === 409);
  const txs = (await db.collection('tenants/' + T + '/signingTransactions').where('contractVersionId', '==', cv1).get()).docs.map((d) => d.data());
  const lock = (await db.doc('tenants/' + T + '/signingLocks/' + cv1).get()).data();
  rec('EM02', 'ONE ACTIVE TX PER VERSION under 3 concurrent initiate calls (Firestore runTransaction): exactly 1 created, 2 conflict ACTIVE_TRANSACTION_EXISTS; exactly 1 transaction document; lock points at it', created.length === 1 && conflicts.length === 2 && conflicts.every((x) => x.body.code === 'ACTIVE_TRANSACTION_EXISTS') && txs.length === 1 && lock.activeTxId === txs[0].txId, { created: created.length, conflicts: conflicts.length, docs: txs.length, lock });
  const txId = created[0].body.txId;

  // ---- EM03 full A -> employer -> B -> employee -> C over Firestore + capability checks ----
  const deny1 = await H.startSignerSession({ idToken: U.admin2.idToken, tenantId: T, txId });
  const s0 = await H.startSignerSession({ idToken: U.admin.idToken, tenantId: T, txId });
  const s0b = await H.startSignerSession({ idToken: U.admin.idToken, tenantId: T, txId });
  await fake.control.userSigns(s0.body.signId, { sub: 'UN:NO-FAKE-EMR', name: 'Herish Hashemi', birthdate: '1980-01-01' });
  const ret = await H.bankidReturn({ query: { tenant: T, tx: txId, status: 'SIGN_COMPLETED_FORGED' } });
  const deny2 = await H.startSignerSession({ idToken: U.emp2.idToken, tenantId: T, txId });
  const s1 = await H.startSignerSession({ idToken: U.emp.idToken, tenantId: T, txId });
  await fake.control.userSigns(s1.body.signId, { sub: 'UN:NO-FAKE-EMP', name: 'Test Ansatt 01', birthdate: '1995-04-12' });
  const ref = await H.refreshSigningStatus({ idToken: U.emp.idToken, tenantId: T, txId });
  const tx = (await db.doc('tenants/' + T + '/signingTransactions/' + txId).get()).data();
  const dl = await H.getSignedAgreement({ idToken: U.emp.idToken, tenantId: T, txId });
  const dl2 = await H.getSignedAgreement({ idToken: U.emp2.idToken, tenantId: T, txId });
  const empFull = await H.getTransaction({ idToken: U.emp.idToken, tenantId: T, txId });
  rec('EM03', 'FULL FAKE FLOW OVER FIRESTORE with real tokens: non-designated admin denied the employer step; designated employer signs (retry returns the SAME signId); return handler ignores forged query and refreshes authoritatively; unrelated employee denied; expected employee signs; tx completed, chain A->B->C recorded, derived signed; own employee downloads hash-verified C (unrelated employee 403); employee cannot read the full tx; lock released',
    deny1.body.code === 'NOT_DESIGNATED_EMPLOYER_SIGNER' && s0.status === 200 && s0b.body.reused === true && s0b.body.signId === s0.body.signId && ret.status === 302 && deny2.body.code === 'NOT_THIS_EMPLOYEE' && s1.status === 200 && ref.body.status === 'completed' && tx.status === 'completed' && isSigned(tx)
      && tx.signers[0].output.inputSha256 === tx.source.sourcePdfSha256 && tx.signers[1].output.inputSha256 === tx.signers[0].output.sha256 && tx.finalArtifact.sha256 === tx.signers[1].output.sha256
      && dl.status === 200 && sha(dl.body.bytes) === tx.finalArtifact.sha256 && dl2.status === 403 && empFull.status === 403
      && (await db.doc('tenants/' + T + '/signingLocks/' + cv1).get()).data().activeTxId === null,
    { status: tx.status, chain: [tx.source.sourcePdfSha256.slice(0, 12), tx.signers[0].output.sha256.slice(0, 12), tx.finalArtifact.sha256.slice(0, 12)], rev: tx.rev });

  // ---- EM04 frozen version / canonical employee document untouched ----
  const after = J((await db.doc('tenants/' + T + '/ansatte/' + A1).get()).data());
  const v = JSON.parse(after).e360.contractVersions[0];
  rec('EM04', 'FROZEN VERSION IMMUTABLE: the whole canonical ansatte document (incl. e360.contractVersions[0] frozen v1) is byte-identical (JSON) before and after the complete signing flow; version.signingTransaction and signedArtifactMeta still null; status still godkjent_frosset', after === before && v.status === 'godkjent_frosset' && v.signingTransaction === null && v.signedArtifactMeta === null, { equal: after === before, status: v.status });

  // ---- EM05 transaction document hygiene ----
  const tj = J(tx);
  rec('EM05', 'transaction document holds no raw JWT, no NIN, no BankID PID, no token/secret; evidence = minimized fields only', !/eyJ|2\.16\.578\.1\.61\.2\.[34]|client_secret|access_token/.test(tj) && tx.signers.every((s) => J(Object.keys(s.evidence).sort()) === J(['birthdate', 'cert_issuer', 'iss', 'jwtVerifiedAt', 'name', 'signature_quality', 'sub', 'tokenSha256'])), { keys: Object.keys(tx.signers[0].evidence) });

  // ---- EM06 second employee: concurrent start-session over Firestore creates ONE provider order ----
  const init2 = await H.initiateSigning({ idToken: U.admin.idToken, tenantId: T, ansattId: A2, contractVersionId: cv2 });
  const creates0 = fake.control.requests.filter((r) => r.op === 'create').length;
  const pair = await Promise.all([H.startSignerSession({ idToken: U.admin.idToken, tenantId: T, txId: init2.body.txId }), H.startSignerSession({ idToken: U.admin.idToken, tenantId: T, txId: init2.body.txId })]);
  const creates1 = fake.control.requests.filter((r) => r.op === 'create').length;
  rec('EM06', 'DOUBLE ORDER over Firestore CAS: two concurrent employer start-session calls -> exactly ONE provider order', init2.status === 201 && creates1 - creates0 === 1 && pair.some((p) => p.status === 200), { statuses: pair.map((p) => p.status + ':' + (p.body.code || (p.body.reused ? 'reused' : 'new'))) });
  const after2 = J((await db.doc('tenants/' + T + '/ansatte/' + A2).get()).data());
  rec('EM04b', 'second employee document also untouched by initiate/start-session', after2 === before2, { equal: after2 === before2 });

  // ---- EM07 candidate rules (Firestore + Storage) with the client SDK test harness ----
  const req = createRequire(HARNESS);
  const rut = await import(pathToFileURL(req.resolve('@firebase/rules-unit-testing')).href);
  const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection } = await import(pathToFileURL(req.resolve('firebase/firestore')).href);
  const { ref: sref, uploadString, getBytes } = await import(pathToFileURL(req.resolve('firebase/storage')).href);
  const [fh, fp] = FS.split(':'), [sh, sp] = ST.split(':');
  const env = await rut.initializeTestEnvironment({ projectId: PROJECT,
    firestore: { host: fh, port: Number(fp), rules: fs.readFileSync(path.join(REPO, 'firestore.signing.candidate.rules'), 'utf8') },
    storage: { host: sh, port: Number(sp), rules: fs.readFileSync(path.join(REPO, 'storage.signing.candidate.rules'), 'utf8') } });
  await env.withSecurityRulesDisabled(async (c) => { await uploadString(sref(c.storage(), 'tenants/' + T + '/contracts/' + A1 + '/' + cv1 + '/' + txId + '/signed-2.pdf'), '%PDF-fake'); });
  const as = (u) => env.authenticatedContext(u.uid).firestore();
  const ok = async (p) => { try { await p; return true; } catch (e) { return false; } };
  const txPath = 'tenants/' + T + '/signingTransactions/' + txId;
  const checks = {
    adminGet: await ok(getDoc(doc(as(U.admin), txPath))),
    adminList: await ok(getDocs(collection(as(U.admin), 'tenants/' + T + '/signingTransactions'))),
    adminCreate: await ok(setDoc(doc(as(U.admin), 'tenants/' + T + '/signingTransactions/forged'), { status: 'completed' })),
    adminUpdate: await ok(updateDoc(doc(as(U.admin), txPath), { status: 'completed' })),
    adminDelete: await ok(deleteDoc(doc(as(U.admin), txPath))),
    empGet: await ok(getDoc(doc(as(U.emp), txPath))),
    empList: await ok(getDocs(collection(as(U.emp), 'tenants/' + T + '/signingTransactions'))),
    empWrite: await ok(setDoc(doc(as(U.emp), 'tenants/' + T + '/signingTransactions/x'), { status: 'completed' })),
    anonGet: await ok(getDoc(doc(env.unauthenticatedContext().firestore(), txPath))),
    lockAdminGet: await ok(getDoc(doc(as(U.admin), 'tenants/' + T + '/signingLocks/' + cv1))),
    lockAdminWrite: await ok(setDoc(doc(as(U.admin), 'tenants/' + T + '/signingLocks/' + cv1), { activeTxId: null })),
    s4AdminReadsAnsatte: await ok(getDoc(doc(as(U.admin), 'tenants/' + T + '/ansatte/' + A1))),
    s4EmployeeCannotReadAnsatte: !(await ok(getDoc(doc(as(U.emp), 'tenants/' + T + '/ansatte/' + A1)))),
    storageAdminRead: await ok(getBytes(sref(env.authenticatedContext(U.admin.uid).storage(), 'tenants/' + T + '/contracts/' + A1 + '/' + cv1 + '/' + txId + '/signed-2.pdf'))),
    storageEmpRead: await ok(getBytes(sref(env.authenticatedContext(U.emp.uid).storage(), 'tenants/' + T + '/contracts/' + A1 + '/' + cv1 + '/' + txId + '/signed-2.pdf'))),
    storageAnonRead: await ok(getBytes(sref(env.unauthenticatedContext().storage(), 'tenants/' + T + '/contracts/' + A1 + '/' + cv1 + '/' + txId + '/signed-2.pdf'))),
    storageAdminWrite: await ok(uploadString(sref(env.authenticatedContext(U.admin.uid).storage(), 'tenants/' + T + '/contracts/' + A1 + '/x.pdf'), '%PDF-x')),
  };
  await env.cleanup();
  const expect = { adminGet: true, adminList: true, adminCreate: false, adminUpdate: false, adminDelete: false, empGet: false, empList: false, empWrite: false, anonGet: false, lockAdminGet: false, lockAdminWrite: false, s4AdminReadsAnsatte: true, s4EmployeeCannotReadAnsatte: true, storageAdminRead: false, storageEmpRead: false, storageAnonRead: false, storageAdminWrite: false };
  rec('EM07', 'CANDIDATE RULES: signingTransactions readable by tenant admin only; NO client create/update/delete (admin included); employee and anonymous cannot read; signingLocks closed to all clients; contract artifacts in Storage not client-readable/writable by anyone (server-mediated only); S4 behaviour preserved (admin reads ansatte, employee cannot)', J(checks) === J(expect), checks);

  rec('EM08', 'NO EXTERNAL NETWORK: only loopback emulator traffic; zero blocked attempts', blocked.length === 0, blocked);
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  rec('EM-ERR', 'unexpected error', false, String(e && e.stack || e).slice(0, 600));
}
const summary = { cases: results.length, pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length };
console.log('BID1_EMULATOR_PROOF_SUMMARY ' + J(summary));
process.exit(summary.fail ? 1 : 0);
