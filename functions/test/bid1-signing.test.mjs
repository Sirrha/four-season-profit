// bid1-signing.test.mjs — BID-1 components C/D/E/F: signing transaction core, fake WYSIWYS V1, signerInfo verifier,
// capability boundary. FAKE provider only, in-memory stores, network guard on. Run: node test/bid1-signing.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { installNetGuard, blocked } from './net-guard.mjs';
import { frozenEmployee1, T, NOW, ADMIN_UID, OTHER_ADMIN_UID, EMPLOYEE_UID, OTHER_EMPLOYEE_UID } from './fixtures.mjs';
import { createFakeWysiwys, TWO_HOURS_MS } from '../src/fake-wysiwys.mjs';
import { createSigningService, isSigned, TX_STATUS } from '../src/signing-service.mjs';
import { createMemoryTransactionStore, createMemoryArtifactStore, createDisabledSecretProvider } from '../src/stores.mjs';
import { verifySignerInfo, matchSignerIdentity, EVIDENCE_FIELDS } from '../src/signerinfo-verifier.mjs';
import { createSigningHandlers } from '../src/signing-handlers.mjs';
import { generateContractPdf } from '../src/contract-pdf.mjs';
import { assertBid1Environment } from '../index.mjs';
installNetGuard();

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e)); } }
const sha = (b) => createHash('sha256').update(b).digest('hex');
const snap = (v) => JSON.parse(JSON.stringify(v));
const ISS = 'fake.esign-stoetest.local';
const KEYS = await generateKeyPair('ES256');
const JWK = Object.assign(await exportJWK(KEYS.publicKey), { kid: 'fake-k1', alg: 'ES256', use: 'sig' });
const JWKS = { keys: [JWK] };
// SYNTHETIC persons (no NIN anywhere). The employer representative name comes from the tenant profile fixture.
const EMPLOYER = { uid: ADMIN_UID, name: 'Herish Hashemi', birthdate: '1980-01-01' };
const EMPLOYER_PERSON = { sub: 'UN:NO-FAKE-CERT-EMR-0001', name: 'Herish Hashemi', given_name: 'Herish', family_name: 'Hashemi', birthdate: '1980-01-01' };
const EMPLOYEE_PERSON = { sub: 'UN:NO-FAKE-CERT-EMP-0001', name: 'Test Ansatt 01', given_name: 'Test Ansatt', family_name: '01', birthdate: '1995-04-12' };

function world(opts) {
  const o = opts || {};
  let now = NOW; const clock = () => now;
  const callbacks = [];
  const fake = createFakeWysiwys({ clock, signingKey: KEYS.privateKey, kid: 'fake-k1', issuer: ISS, alg: 'ES256', onCallback: (c) => callbacks.push(c) });
  const txStore = createMemoryTransactionStore();
  const artifactStore = o.artifactStore || createMemoryArtifactStore();
  const hooks = o.hooks || {};
  const service = createSigningService({ txStore, artifactStore, provider: o.provider || fake.api, clock, hooks,
    config: { environment: 'fake', returnUrl: 'http://127.0.0.1:18790/bankid/return', orderTimeoutSeconds: 600, allowedQualities: ['QES'], verifier: { jwks: JWKS, issuer: ISS, algorithms: ['ES256'] } } });
  const fx = o.fx || frozenEmployee1();
  return { fake, txStore, artifactStore, service, fx, callbacks, clock, advance: (ms) => { now += ms; }, setNow: (v) => { now = v; } };
}
const init = (w, extra) => w.service.initiate(Object.assign({ tenantId: T, ansattId: w.fx.ansattId, version: w.fx.version, employerSigner: EMPLOYER, actorUid: ADMIN_UID }, extra || {}));
async function signStep(w, txId, person) {
  const s = await w.service.startSession({ tenantId: T, txId });
  assert.equal(s.ok, true, JSON.stringify(s));
  await w.fake.control.userSigns(s.signId, person);
  const r = await w.service.onCallback({ tenantId: T, txId });
  return { s, r, tx: await w.txStore.get(T, txId) };
}

// ======================= HAPPY PATH (P09, P12, I07, I09) =======================
await t('P09/P12/I07/I09', 'FULL FAKE TWO-SIGNER FLOW A -> employer -> B -> employee -> C -> completed; source A == deterministic generator bytes; order 1 input sha == sha(A), order 2 input == stored B bytes; C verified on read; derived signed = true; the frozen contract version object (in the employee store AND the object handed to the service) is DEEP-EQUAL before and after', async () => {
  const w = world();
  const storeVersionBefore = snap(w.fx.employee().contractVersions);
  const passedVersionBefore = snap(w.fx.version);
  const expectedA = await generateContractPdf(w.fx.version);
  const i = await init(w);
  assert.equal(i.ok, true, JSON.stringify(i));
  const txId = i.tx.txId;
  assert.equal(i.tx.status, TX_STATUS.AWAITING); assert.equal(i.tx.source.sourcePdfSha256, expectedA.identity.sourcePdfSha256); assert.equal(i.tx.source.sourceSnapshotSha256, expectedA.identity.sourceSnapshotSha256);
  assert.equal(i.tx.attempt, 1); assert.equal(i.tx.txId, w.fx.version.contractVersionId + '-sig-1'); assert.equal(i.tx.environment, 'fake'); assert.equal(i.tx.provider, 'bankid_wysiwys_v1');
  assert.equal(i.tx.currentSignerIndex, 0); assert.equal(i.tx.signers[0].role, 'employer'); assert.equal(i.tx.signers[1].role, 'employee');
  const e = await signStep(w, txId, EMPLOYER_PERSON);
  assert.equal(e.tx.status, TX_STATUS.AWAITING); assert.equal(e.tx.currentSignerIndex, 1);
  assert.equal(e.tx.signers[0].status, 'signed'); assert.equal(e.tx.signers[0].identity.matched, true);
  const B = e.tx.signers[0].output;
  assert.equal(B.inputSha256, expectedA.identity.sourcePdfSha256, 'order 1: unsignedDocumentSha256 == sha(A)');
  const reqs = w.fake.control.requests.filter((r) => r.op === 'create');
  assert.equal(reqs[0].inputSha256, expectedA.identity.sourcePdfSha256); assert.equal(reqs[0].req.merchantWorkflowState, 'WORKFLOW_ACTIVE');
  const m = await signStep(w, txId, EMPLOYEE_PERSON);
  const reqs2 = w.fake.control.requests.filter((r) => r.op === 'create');
  assert.equal(reqs2[1].inputSha256, B.sha256, 'order 2 input = exact stored B'); assert.equal(reqs2[1].req.merchantWorkflowState, 'NO_WORKFLOW');
  const tx = m.tx;
  assert.equal(tx.status, TX_STATUS.COMPLETED, JSON.stringify(tx.issues));
  assert.equal(tx.signers[1].output.inputSha256, B.sha256);
  assert.equal(tx.finalArtifact.sha256, tx.signers[1].output.sha256);
  const C = await w.artifactStore.get(tx.finalArtifact.ref, tx.finalArtifact.sha256);
  assert.equal(sha(C), tx.finalArtifact.sha256);
  assert.ok(C.subarray(0, expectedA.bytes.length).equals(Buffer.from(expectedA.bytes)), 'C extends A');
  assert.equal((C.toString('latin1').match(/%FAKE-PADES-SIGNATURE/g) || []).length, 2);
  assert.equal(isSigned(tx), true); assert.equal(Number.isFinite(tx.completedAt), true);
  assert.deepEqual(snap(w.fx.employee().contractVersions), storeVersionBefore, 'frozen version in the employee store unchanged');
  assert.deepEqual(snap(w.fx.version), passedVersionBefore, 'frozen version object passed to the service unchanged');
  assert.equal(w.fx.version.signingTransaction, null); assert.equal(w.fx.version.signedArtifactMeta, null);
  for (const s of tx.signers) assert.deepEqual(Object.keys(s.evidence).sort(), [...EVIDENCE_FIELDS].sort());
  const txJson = JSON.stringify(tx);
  for (const bad of ['eyJ', '2.16.578.1.61.2.3', '2.16.578.1.61.2.4', 'client_secret', 'access_token']) assert.ok(!txJson.includes(bad), 'transaction must not contain ' + bad);
  lines.push('INFO  CHAIN  A=' + tx.source.sourcePdfSha256.slice(0, 16) + '… -> B=' + B.sha256.slice(0, 16) + '… -> C=' + tx.finalArtifact.sha256.slice(0, 16) + '…');
});

// ======================= FAILURE MATRIX (P10) + IDEMPOTENCY (I01–I10) =======================
await t('I01', 'DOUBLE INITIATE (concurrent): exactly one transaction; the other gets ACTIVE_TRANSACTION_EXISTS with the same txId; a third later call also conflicts', async () => {
  const w = world();
  const [a, b] = await Promise.all([init(w), init(w)]);
  const oks = [a, b].filter((x) => x.ok); const conf = [a, b].filter((x) => !x.ok);
  assert.equal(oks.length, 1); assert.equal(conf[0].code, 'ACTIVE_TRANSACTION_EXISTS'); assert.equal(conf[0].txId, oks[0].tx.txId);
  assert.equal((await init(w)).code, 'ACTIVE_TRANSACTION_EXISTS');
  assert.equal((await w.txStore.listForVersion(T, w.fx.version.contractVersionId)).length, 1);
});
await t('I02', 'DOUBLE CREATE ORDER: two concurrent startSession calls create ONE provider order; the loser gets SESSION_BEING_CREATED (or the same session); a later retry returns the SAME signId (reused)', async () => {
  const w = world(); const i = await init(w);
  const [a, b] = await Promise.all([w.service.startSession({ tenantId: T, txId: i.tx.txId }), w.service.startSession({ tenantId: T, txId: i.tx.txId })]);
  assert.equal(w.fake.control.requests.filter((r) => r.op === 'create').length, 1);
  const winner = [a, b].find((x) => x.ok && !x.reused);
  assert.ok(winner, JSON.stringify([a, b]));
  const loser = [a, b].find((x) => x !== winner);
  assert.ok(loser.code === 'SESSION_BEING_CREATED' || (loser.ok && loser.signId === winner.signId), JSON.stringify(loser));
  const again = await w.service.startSession({ tenantId: T, txId: i.tx.txId });
  assert.equal(again.reused, true); assert.equal(again.signId, winner.signId);
  assert.equal(w.fake.control.requests.filter((r) => r.op === 'create').length, 1);
});
await t('I03', 'REPEATED GET: state only moves forward — a provider answer ORDER_RECEIVED after USER_SIGNING is ignored (NON_MONOTONIC_IGNORED)', async () => {
  const w0 = world();
  let override = null;
  const provider = Object.assign({}, w0.fake.api, { getOrderState: async (id) => override || w0.fake.api.getOrderState(id) });
  const w = world({ provider, fx: w0.fx }); w.fake = w0.fake;
  const i = await init(w); const s = await w.service.startSession({ tenantId: T, txId: i.tx.txId });
  w0.fake.control.userOpens(s.signId);
  await w.service.refresh({ tenantId: T, txId: i.tx.txId });
  assert.equal((await w.txStore.get(T, i.tx.txId)).signers[0].sessions[0].providerState, 'USER_SIGNING');
  override = { found: true, orderState: 'ORDER_RECEIVED' };
  const r = await w.service.refresh({ tenantId: T, txId: i.tx.txId });
  assert.equal(r.noop, 'NON_MONOTONIC_IGNORED');
  assert.equal((await w.txStore.get(T, i.tx.txId)).signers[0].sessions[0].providerState, 'USER_SIGNING');
});
await t('I04', 'CALLBACK IS ONLY A SIGNAL: a callback while the user is still signing changes nothing; the silent callback after completion triggers exactly ONE authoritative GET+DELETE; 3 duplicate callbacks => still one DELETE; callback query content is never trusted (handler)', async () => {
  const w = world(); const i = await init(w); const txId = i.tx.txId;
  const s = await w.service.startSession({ tenantId: T, txId });
  w.fake.control.userOpens(s.signId);
  await w.service.onCallback({ tenantId: T, txId });
  let tx = await w.txStore.get(T, txId);
  assert.equal(tx.signers[0].status, 'in_session'); assert.equal(tx.status, TX_STATUS.SESSION);
  await w.fake.control.userSigns(s.signId, EMPLOYER_PERSON);
  assert.equal(w.callbacks.length, 1); assert.ok(w.callbacks[0].url.includes('sign_id=' + s.signId));
  await Promise.all([w.service.onCallback({ tenantId: T, txId }), w.service.onCallback({ tenantId: T, txId }), w.service.onCallback({ tenantId: T, txId })]);
  assert.equal(w.fake.control.requests.filter((r) => r.op === 'delete').length, 1);
  tx = await w.txStore.get(T, txId);
  assert.equal(tx.signers[0].status, 'signed'); assert.equal(tx.currentSignerIndex, 1);
});
await t('I05', 'DESTRUCTIVE DELETE: the provider DELETE is one-shot (second = 404); a crash AFTER DELETE and BEFORE storage => next refresh sees 404 + held lease => failed_result_lost, signer NOT signed, back to awaiting; a NEW order on the same input A is then required and completes', async () => {
  let crash = true;
  const w = world({ hooks: { afterDelete: async () => { if (crash) { crash = false; throw new Error('SIMULATED_PROCESS_DEATH'); } } } });
  const i = await init(w); const txId = i.tx.txId;
  const s = await w.service.startSession({ tenantId: T, txId });
  await w.fake.control.userSigns(s.signId, EMPLOYER_PERSON);
  await assert.rejects(w.service.refresh({ tenantId: T, txId }), /SIMULATED_PROCESS_DEATH/);
  assert.equal((await w.fake.api.downloadAndDeleteResult(s.signId)).found, false, 'second DELETE is not found');
  w.advance(61000);
  await w.service.refresh({ tenantId: T, txId });
  let tx = await w.txStore.get(T, txId);
  assert.equal(tx.signers[0].sessions[0].outcome, 'failed_result_lost'); assert.equal(tx.signers[0].status, 'pending'); assert.equal(tx.status, TX_STATUS.AWAITING); assert.equal(tx.signers[0].output, null);
  const s2 = await w.service.startSession({ tenantId: T, txId });
  assert.notEqual(s2.signId, s.signId);
  assert.equal(w.fake.control.requests.filter((r) => r.op === 'create')[1].inputSha256, i.tx.source.sourcePdfSha256);
  await w.fake.control.userSigns(s2.signId, EMPLOYER_PERSON); await w.service.refresh({ tenantId: T, txId });
  tx = await w.txStore.get(T, txId);
  assert.equal(tx.signers[0].status, 'signed');
});
await t('I06', '2-HOUR CEILING: an order older than 2 h cannot be continued (session expired, provider order gone); a new order is created against the SAME verified input; timeoutSeconds before start => TIMED_OUT', async () => {
  const w = world(); const i = await init(w); const txId = i.tx.txId;
  const s = await w.service.startSession({ tenantId: T, txId });
  w.advance(TWO_HOURS_MS + 1000);
  assert.equal((await w.fake.api.getOrderState(s.signId)).found, false);
  const again = await w.service.startSession({ tenantId: T, txId });
  let tx = await w.txStore.get(T, txId);
  assert.equal(tx.signers[0].sessions[0].outcome, 'expired'); assert.notEqual(again.signId, s.signId);
  assert.equal(w.fake.control.requests.filter((r) => r.op === 'create')[1].inputSha256, i.tx.source.sourcePdfSha256);
  // timeout before the user starts
  w.advance(601000);
  await w.service.refresh({ tenantId: T, txId });
  tx = await w.txStore.get(T, txId);
  assert.equal(tx.signers[0].sessions[1].outcome, 'timed_out'); assert.equal(tx.status, TX_STATUS.AWAITING);
});
await t('P10a', 'REJECTION BY SIGNER 1 (employer): tx rejected (terminal), lock released, frozen v1 untouched; a NEW attempt on the SAME frozen version reuses the IDENTICAL source A (same hash, artifact reused)', async () => {
  const w = world(); const i = await init(w); const txId = i.tx.txId;
  const s = await w.service.startSession({ tenantId: T, txId });
  w.fake.control.userRejects(s.signId); await w.service.refresh({ tenantId: T, txId });
  const tx = await w.txStore.get(T, txId);
  assert.equal(tx.status, TX_STATUS.REJECTED); assert.equal(tx.terminalReason, 'SIGNER_REJECTED:employer'); assert.equal(tx.signers[0].status, 'rejected');
  const i2 = await init(w);
  assert.equal(i2.ok, true); assert.equal(i2.tx.attempt, 2); assert.equal(i2.tx.txId, w.fx.version.contractVersionId + '-sig-2');
  assert.equal(i2.tx.source.sourcePdfSha256, i.tx.source.sourcePdfSha256); assert.equal(i2.tx.source.reusedExistingArtifact, true); assert.equal(i2.tx.source.artifactRef, i.tx.source.artifactRef);
});
await t('P10b', 'REJECTION BY SIGNER 2 (employee) after the employer signed: tx rejected; B stays stored as evidence but the contract is NOT signed (derived signed = false, no finalArtifact); signing never reopens v1', async () => {
  const w = world(); const i = await init(w); const txId = i.tx.txId;
  await signStep(w, txId, EMPLOYER_PERSON);
  const s = await w.service.startSession({ tenantId: T, txId });
  w.fake.control.userRejects(s.signId); await w.service.refresh({ tenantId: T, txId });
  const tx = await w.txStore.get(T, txId);
  assert.equal(tx.status, TX_STATUS.REJECTED); assert.equal(tx.terminalReason, 'SIGNER_REJECTED:employee'); assert.equal(tx.finalArtifact, null); assert.equal(isSigned(tx), false);
  assert.ok(await w.artifactStore.get(tx.signers[0].output.ref, tx.signers[0].output.sha256));
  assert.equal((await w.service.signedAgreement({ tenantId: T, txId })).code, 'NOT_SIGNED');
});
await t('P10c', '404 and PROVIDER FAILURE: an order the provider no longer knows -> not_found; FAILED -> failed; both return the signer to pending (awaiting_signer), never signed', async () => {
  const w = world(); const i = await init(w); const txId = i.tx.txId;
  const s = await w.service.startSession({ tenantId: T, txId });
  w.fake.control.forget(s.signId); await w.service.refresh({ tenantId: T, txId });
  let tx = await w.txStore.get(T, txId);
  assert.equal(tx.signers[0].sessions[0].outcome, 'not_found'); assert.equal(tx.status, TX_STATUS.AWAITING);
  const s2 = await w.service.startSession({ tenantId: T, txId });
  w.fake.control.providerFails(s2.signId); await w.service.refresh({ tenantId: T, txId });
  tx = await w.txStore.get(T, txId);
  assert.equal(tx.signers[0].sessions[1].outcome, 'failed'); assert.equal(tx.signers[0].status, 'pending'); assert.equal(tx.status, TX_STATUS.AWAITING);
});
await t('I10', 'STORAGE FAILURE: (a) storing B/C throws after the destructive DELETE -> failed_result_lost, signer pending, never signed; (b) C stored but unreadable at the completion gate -> tx stays FINALIZING with COMPLETION_GATE issue, never completed/signed', async () => {
  const mem = createMemoryArtifactStore();
  let failPut = false, failFinalGet = false;
  const store = { putOnce: async (k, b) => { if (failPut && /signed-2\.pdf$/.test(k)) throw Object.assign(new Error('DISK'), { code: 'STORAGE_DOWN' }); return mem.putOnce(k, b); },
    get: async (k, h) => { if (failFinalGet && /signed-2\.pdf$/.test(k)) throw Object.assign(new Error('gone'), { code: 'ARTIFACT_MISSING' }); return mem.get(k, h); } };
  const w = world({ artifactStore: store }); const i = await init(w); const txId = i.tx.txId;
  await signStep(w, txId, EMPLOYER_PERSON);
  failPut = true;
  await signStep(w, txId, EMPLOYEE_PERSON);
  let tx = await w.txStore.get(T, txId);
  assert.equal(tx.signers[1].sessions[0].outcome, 'failed_result_lost'); assert.ok(tx.issues.some((x) => /ARTIFACT_STORE_FAILED/.test(x.code)));
  assert.equal(tx.status, TX_STATUS.AWAITING); assert.equal(isSigned(tx), false);
  failPut = false;
  // (b): the put succeeds, but the gate cannot read C back
  const s = await w.service.startSession({ tenantId: T, txId });
  await w.fake.control.userSigns(s.signId, EMPLOYEE_PERSON);
  const origGet = store.get; let calls = 0;
  store.get = async (k, h) => { if (/signed-2\.pdf$/.test(k) && ++calls > 1) throw Object.assign(new Error('gone'), { code: 'ARTIFACT_MISSING' }); return origGet(k, h); };
  await w.service.refresh({ tenantId: T, txId });
  tx = await w.txStore.get(T, txId);
  assert.equal(tx.status, TX_STATUS.FINALIZING); assert.ok(tx.issues.some((x) => x.code === 'COMPLETION_GATE' && x.problems.includes('FINAL_ARTIFACT_ARTIFACT_MISSING')), JSON.stringify(tx.issues));
  assert.equal(isSigned(tx), false);
  store.get = origGet;
  await w.service.refresh({ tenantId: T, txId });
  assert.equal((await w.txStore.get(T, txId)).status, TX_STATUS.COMPLETED, 'the gate completes once C is readable and verified');
});
await t('I07b', 'HASH CHAIN BREAK: a provider result whose unsignedDocumentSha256 is not sha(input), or whose bytes do not match signedDocumentSha256, fails the transaction (terminal) and never marks the signer signed', async () => {
  for (const mode of ['unsigned', 'signed']) {
    const w0 = world();
    const provider = Object.assign({}, w0.fake.api, { downloadAndDeleteResult: async (id) => { const r = await w0.fake.api.downloadAndDeleteResult(id); if (r.signingResults && r.signingResults[0]) { if (mode === 'unsigned') r.signingResults[0].unsignedDocumentSha256 = 'f'.repeat(64); else r.signingResults[0].signedDocumentSha256 = 'e'.repeat(64); } return r; } });
    const w = world({ provider, fx: w0.fx }); w.fake = w0.fake;
    const i = await init(w); const s = await w.service.startSession({ tenantId: T, txId: i.tx.txId });
    await w0.fake.control.userSigns(s.signId, EMPLOYER_PERSON); await w.service.refresh({ tenantId: T, txId: i.tx.txId });
    const tx = await w.txStore.get(T, i.tx.txId);
    assert.equal(tx.status, TX_STATUS.FAILED); assert.equal(tx.signers[0].status, 'pending'); assert.equal(tx.signers[0].output, null);
    assert.equal(tx.terminalReason, mode === 'unsigned' ? 'UNSIGNED_HASH_MISMATCH' : 'SIGNED_HASH_MISMATCH');
  }
});
await t('I08', 'IDENTITY MISMATCH -> identity_review, never completed: (a) a valid JWT for a different person at the employer step; (b) wrong birth date at the employee step; (c) AES instead of QES; (d) a JWT signed with an unknown key. Employee step cannot start while the employer step is in review', async () => {
  const cases = [
    { at: 0, person: Object.assign({}, EMPLOYER_PERSON, { name: 'Ola Nordmann' }), reason: 'NAME_MISMATCH' },
    { at: 1, person: Object.assign({}, EMPLOYEE_PERSON, { birthdate: '1995-04-13' }), reason: 'BIRTHDATE_MISMATCH' },
    { at: 0, person: Object.assign({}, EMPLOYER_PERSON, { signature_quality: 'AES' }), reason: 'SIGNATURE_QUALITY_NOT_ACCEPTED' },
  ];
  for (const c of cases) {
    const w = world(); const i = await init(w); const txId = i.tx.txId;
    if (c.at === 1) await signStep(w, txId, EMPLOYER_PERSON);
    await signStep(w, txId, c.person);
    const tx = await w.txStore.get(T, txId);
    assert.equal(tx.status, TX_STATUS.REVIEW, c.reason); assert.ok(tx.signers[c.at].identity.reasons.includes(c.reason), JSON.stringify(tx.signers[c.at].identity));
    assert.equal(isSigned(tx), false); assert.equal(tx.finalArtifact, null);
    if (c.at === 0) assert.equal((await w.service.startSession({ tenantId: T, txId })).code, 'TX_NOT_AWAITING_SIGNER');
  }
  // (d) unknown signing key
  const other = await generateKeyPair('ES256');
  const w = world(); const i = await init(w); const txId = i.tx.txId;
  const rogue = createFakeWysiwys({ clock: w.clock, signingKey: other.privateKey, kid: 'fake-k1', issuer: ISS, alg: 'ES256' });
  const s = await w.service.startSession({ tenantId: T, txId });
  await w.fake.control.userSigns(s.signId, EMPLOYER_PERSON);
  const bogus = await (async () => { const o = await rogue.api.createSignOrder({ orderName: 'x', addVisualSeals: true, documents: [{ pdf: Buffer.from('%PDF-1.7 x').toString('base64') }], resultContent: { requestSignerInfo: true } }); await rogue.control.userSigns(o.signId, EMPLOYER_PERSON); return (await rogue.api.downloadAndDeleteResult(o.signId)).signerInfo; })();
  const orig = w.fake.api.downloadAndDeleteResult;
  w.service = createSigningService({ txStore: w.txStore, artifactStore: w.artifactStore, clock: w.clock, provider: Object.assign({}, w.fake.api, { downloadAndDeleteResult: async (id) => Object.assign(await orig(id), { signerInfo: bogus }) }),
    config: { environment: 'fake', verifier: { jwks: JWKS, issuer: ISS, algorithms: ['ES256'] } } });
  await w.service.refresh({ tenantId: T, txId });
  const tx = await w.txStore.get(T, txId);
  assert.equal(tx.status, TX_STATUS.REVIEW); assert.equal(tx.signers[0].evidence, null); assert.ok(tx.signers[0].identity.reasons[0].startsWith('JWT:JWT_SIGNATURE_INVALID'), JSON.stringify(tx.signers[0].identity));
});
await t('P10d', 'CANCEL (application-level, BankID has no cancel endpoint): admin cancel -> terminal cancelled, open session closed; a later provider completion is never collected (refresh = TERMINAL noop, zero DELETE); a new attempt is allowed', async () => {
  const w = world(); const i = await init(w); const txId = i.tx.txId;
  const s = await w.service.startSession({ tenantId: T, txId });
  assert.equal((await w.service.cancel({ tenantId: T, txId, actorUid: ADMIN_UID, reason: 'feil mottaker' })).ok, true);
  await w.fake.control.userSigns(s.signId, EMPLOYER_PERSON);
  const r = await w.service.onCallback({ tenantId: T, txId });
  assert.equal(r.noop, 'TERMINAL'); assert.equal(w.fake.control.requests.filter((x) => x.op === 'delete').length, 0);
  assert.equal((await w.txStore.get(T, txId)).status, TX_STATUS.CANCELLED);
  assert.equal((await init(w)).ok, true);
});
await t('P08b', 'INITIATE GUARDS: draft/missing/erstattet refused; employer signer must be designated (uid+name+birthdate) AND be the contract\'s named representative; employee identity must exist in the frozen snapshot', async () => {
  const w = world();
  const draft = frozenEmployee1({ freeze: false });
  assert.equal((await w.service.initiate({ tenantId: T, ansattId: draft.ansattId, version: draft.version, employerSigner: EMPLOYER, actorUid: ADMIN_UID })).code, 'CONTRACT_NOT_FROZEN');
  assert.equal((await init(w, { version: null })).code, 'CONTRACT_VERSION_MISSING');
  assert.equal((await init(w, { version: Object.assign({}, w.fx.version, { status: 'erstattet' }) })).code, 'CONTRACT_NOT_SIGNABLE');
  assert.equal((await init(w, { employerSigner: null })).code, 'EMPLOYER_SIGNER_NOT_DESIGNATED');
  assert.equal((await init(w, { employerSigner: { uid: OTHER_ADMIN_UID, name: 'Annen Admin', birthdate: '1970-01-01' } })).code, 'EMPLOYER_SIGNER_NOT_CONTRACT_REPRESENTATIVE');
  const noBirth = snap(w.fx.version); noBirth.snapshot.person.birthDate = null;
  assert.equal((await init(w, { version: noBirth })).code, 'EMPLOYEE_IDENTITY_INCOMPLETE');
  assert.equal((await w.txStore.listForVersion(T, w.fx.version.contractVersionId)).length, 0, 'no transaction created by a refused initiate');
});

// ======================= FAKE PROVIDER CONTRACT (D) =======================
await t('D-FAKE', 'FAKE WYSIWYS V1 contract: required orderName/addVisualSeals/documents; base64 PDF only (%PDF-); >40 MB base64 -> 413; useConversion on an already-signed PDF refused; GET unknown -> 404; DELETE on a non-completed order deletes it and returns empty results; DELETE twice -> 404; no signer restriction (anyone completing the session signs); no network', async () => {
  let now = NOW; const f = createFakeWysiwys({ clock: () => now, signingKey: KEYS.privateKey, kid: 'fake-k1', issuer: ISS, alg: 'ES256' });
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n').toString('base64');
  assert.equal((await f.api.createSignOrder({ addVisualSeals: true, documents: [{ pdf }] })).code, 'orderName');
  assert.equal((await f.api.createSignOrder({ orderName: 'x', documents: [{ pdf }] })).code, 'addVisualSeals');
  assert.equal((await f.api.createSignOrder({ orderName: 'x', addVisualSeals: true, documents: [] })).code, 'documents');
  assert.equal((await f.api.createSignOrder({ orderName: 'x', addVisualSeals: true, documents: [{ pdf: Buffer.from('hello').toString('base64') }] })).code, 'NOT_A_PDF');
  assert.equal((await f.api.createSignOrder({ orderName: 'x', addVisualSeals: true, documents: [{ pdf: 'A'.repeat(41943041) }] })).httpStatus, 413);
  assert.equal((await f.api.createSignOrder({ orderName: 'x', addVisualSeals: true, useConversion: true, documents: [{ pdf: Buffer.from('%PDF-1.7\n%FAKE-PADES-SIGNATURE').toString('base64') }] })).code, 'CONVERSION_OF_SIGNED_PDF');
  assert.equal((await f.api.getOrderState('nope')).httpStatus, 404);
  const o = await f.api.createSignOrder({ orderName: 'x', addVisualSeals: true, documents: [{ pdf }] });
  const d1 = await f.api.downloadAndDeleteResult(o.signId);
  assert.equal(d1.found, true); assert.deepEqual(d1.signingResults, []); assert.equal((await f.api.getOrderState(o.signId)).httpStatus, 404);
  const o2 = await f.api.createSignOrder({ orderName: 'x', addVisualSeals: true, documents: [{ pdf }], resultContent: { requestSignerInfo: true } });
  await f.control.userSigns(o2.signId, { sub: 'UN:NO-FAKE-ANYONE', name: 'Hvem Som Helst', birthdate: '2000-01-01' });
  const r = await f.api.downloadAndDeleteResult(o2.signId);
  assert.equal(r.orderState, 'SIGN_COMPLETED'); assert.equal(r.signingResults[0].unsignedDocumentSha256, sha(Buffer.from(pdf, 'base64'))); assert.equal(typeof r.signerInfo, 'string');
  assert.equal((await f.api.downloadAndDeleteResult(o2.signId)).httpStatus, 404);
});

// ======================= SIGNERINFO VERIFIER (E) =======================
await t('E-JWT', 'VERIFIER: valid ES256 JWT -> minimized evidence (exactly sub,name,birthdate,signature_quality,cert_issuer,iss,jwtVerifiedAt,tokenSha256; PID/NIN OIDs dropped); wrong key -> JWT_SIGNATURE_INVALID; unknown kid -> JWT_KEY_UNKNOWN; expired -> JWT_EXPIRED; nbf in future -> JWT_NOT_YET_VALID; wrong iss -> JWT_ISSUER_INVALID; HS256 -> not allowed; missing claims -> CLAIM_MISSING; missing config -> *_NOT_CONFIGURED', async () => {
  const cfg = { jwks: JWKS, issuer: ISS, algorithms: ['ES256'] };
  const iat = Math.floor(NOW / 1000);
  const mk = (claims, o) => new SignJWT(Object.assign({ name: 'Test Ansatt 01', birthdate: '1995-04-12', signature_quality: 'QES', cert_issuer: 'FAKE CA', '2.16.578.1.61.2.3': 'FAKE-PID-0001' }, claims || {}))
    .setProtectedHeader({ alg: 'ES256', kid: (o && o.kid) || 'fake-k1' }).setSubject('UN:NO-FAKE').setIssuer((o && o.iss) || ISS).setIssuedAt(iat).setNotBefore((o && o.nbf) || iat).setExpirationTime((o && o.exp) || iat + 600).sign((o && o.key) || KEYS.privateKey);
  const ok = await verifySignerInfo(await mk(), cfg, NOW);
  assert.equal(ok.ok, true); assert.deepEqual(Object.keys(ok.evidence).sort(), [...EVIDENCE_FIELDS].sort());
  assert.ok(!JSON.stringify(ok.evidence).includes('FAKE-PID'), 'PID dropped');
  const other = await generateKeyPair('ES256');
  assert.equal((await verifySignerInfo(await mk({}, { key: other.privateKey }), cfg, NOW)).code, 'JWT_SIGNATURE_INVALID');
  assert.equal((await verifySignerInfo(await mk({}, { key: other.privateKey, kid: 'k-unknown' }), cfg, NOW)).code, 'JWT_KEY_UNKNOWN');
  assert.equal((await verifySignerInfo(await mk(), cfg, NOW + 601000)).code, 'JWT_EXPIRED');
  assert.equal((await verifySignerInfo(await mk({}, { nbf: iat + 300, exp: iat + 900 }), cfg, NOW)).code, 'JWT_NOT_YET_VALID');
  assert.equal((await verifySignerInfo(await mk({}, { iss: 'evil.example' }), cfg, NOW)).code, 'JWT_ISSUER_INVALID');
  const hs = await new SignJWT({ name: 'x' }).setProtectedHeader({ alg: 'HS256' }).setIssuer(ISS).setExpirationTime(iat + 60).sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
  assert.ok(['JWT_ALG_NOT_ALLOWED', 'JWT_KEY_UNKNOWN'].includes((await verifySignerInfo(hs, cfg, NOW)).code));
  assert.equal((await verifySignerInfo(await mk({ birthdate: undefined }), cfg, NOW)).code, 'CLAIM_MISSING:birthdate');
  assert.equal((await verifySignerInfo(await mk({ signature_quality: 'NONE' }), cfg, NOW)).code, 'CLAIM_INVALID:signature_quality');
  assert.equal((await verifySignerInfo(await mk(), { issuer: ISS, algorithms: ['ES256'] }, NOW)).code, 'JWKS_NOT_CONFIGURED');
  assert.equal((await verifySignerInfo(await mk(), { jwks: JWKS, algorithms: ['ES256'] }, NOW)).code, 'ISSUER_NOT_CONFIGURED');
  assert.equal(matchSignerIdentity(ok.evidence, { name: '  test   ansatt 01 ', birthdate: '1995-04-12' }).matched, true, 'whitespace/case normalization only');
  assert.equal(matchSignerIdentity(ok.evidence, { name: 'Test Ansatt', birthdate: '1995-04-12' }).matched, false, 'no partial/fuzzy match');
});

// ======================= CAPABILITY BOUNDARY (F / P11) =======================
await t('P11', 'AUTH/CAPABILITY: unauthenticated/invalid token -> 401; non-member -> 403; employee cannot initiate; a NON-designated admin cannot run the employer step; the designated employer can; an unrelated employee cannot run the employee step; the expected employee can; employee cannot read the full transaction (admin only) and gets a minimal projection; signed-agreement download: before completion 409, unrelated employee 403, own employee 200 hash-verified, admin 200', async () => {
  const w = world();
  const tokens = { 'tok-admin': ADMIN_UID, 'tok-admin2': OTHER_ADMIN_UID, 'tok-emp': EMPLOYEE_UID, 'tok-emp2': OTHER_EMPLOYEE_UID, 'tok-outsider': 'uid-outsider' };
  const mem = {
    [ADMIN_UID]: { uid: ADMIN_UID, tenantId: T, accessRole: 'admin', accessEnabled: true, ansattId: null },
    [OTHER_ADMIN_UID]: { uid: OTHER_ADMIN_UID, tenantId: T, accessRole: 'admin', accessEnabled: true, ansattId: null },
    [EMPLOYEE_UID]: { uid: EMPLOYEE_UID, tenantId: T, accessRole: 'employee', accessEnabled: true, ansattId: w.fx.ansattId },
    [OTHER_EMPLOYEE_UID]: { uid: OTHER_EMPLOYEE_UID, tenantId: T, accessRole: 'employee', accessEnabled: true, ansattId: 'ans-someone-else' },
  };
  const H = createSigningHandlers({
    auth: { verifyIdToken: async (tok) => { if (!tokens[tok]) throw new Error('bad token'); return { uid: tokens[tok] }; } },
    memberships: { get: async (uid, tenantId) => (mem[uid] && mem[uid].tenantId === tenantId ? mem[uid] : null) },
    contracts: { getVersion: async (tenantId, ansattId, cvid) => (ansattId === w.fx.ansattId && cvid === w.fx.version.contractVersionId ? w.fx.version : null) },
    service: w.service, txStore: w.txStore, config: { employerSigner: EMPLOYER, appUrl: 'https://sormena.local/' },
  });
  const base = { tenantId: T, ansattId: w.fx.ansattId, contractVersionId: w.fx.version.contractVersionId };
  assert.equal((await H.initiateSigning(Object.assign({}, base))).status, 401);
  assert.equal((await H.initiateSigning(Object.assign({ idToken: 'forged' }, base))).status, 401);
  assert.equal((await H.initiateSigning(Object.assign({ idToken: 'tok-outsider' }, base))).status, 403);
  assert.equal((await H.initiateSigning(Object.assign({ idToken: 'tok-emp' }, base))).body.code, 'ADMIN_REQUIRED');
  const ini = await H.initiateSigning(Object.assign({ idToken: 'tok-admin' }, base));
  assert.equal(ini.status, 201, JSON.stringify(ini)); const txId = ini.body.txId;
  assert.equal((await H.initiateSigning(Object.assign({ idToken: 'tok-admin2' }, base))).status, 409, 'second initiate conflicts');
  assert.equal((await H.startSignerSession({ idToken: 'tok-admin2', tenantId: T, txId })).body.code, 'NOT_DESIGNATED_EMPLOYER_SIGNER');
  assert.equal((await H.startSignerSession({ idToken: 'tok-emp', tenantId: T, txId })).body.code, 'NOT_DESIGNATED_EMPLOYER_SIGNER');
  const s0 = await H.startSignerSession({ idToken: 'tok-admin', tenantId: T, txId });
  assert.equal(s0.status, 200); assert.ok(s0.body.url.includes(s0.body.signId));
  await w.fake.control.userSigns(s0.body.signId, EMPLOYER_PERSON);
  const ret = await H.bankidReturn({ query: { tenant: T, tx: txId, sign_id: 'anything', status: 'SIGN_COMPLETED' } });
  assert.equal(ret.status, 302); assert.equal(ret.body.location, 'https://sormena.local/');
  assert.equal((await w.txStore.get(T, txId)).currentSignerIndex, 1, 'return handler triggered an authoritative refresh');
  assert.equal((await H.bankidReturn({ query: { tenant: T, tx: 'unknown-tx' }, silent: true })).status, 204);
  assert.equal((await H.getSignedAgreement({ idToken: 'tok-admin', tenantId: T, txId })).status, 409, 'not signed yet');
  assert.equal((await H.startSignerSession({ idToken: 'tok-emp2', tenantId: T, txId })).body.code, 'NOT_THIS_EMPLOYEE');
  assert.equal((await H.startSignerSession({ idToken: 'tok-admin2', tenantId: T, txId })).body.code, 'NOT_THIS_EMPLOYEE');
  const s1 = await H.startSignerSession({ idToken: 'tok-emp', tenantId: T, txId });
  assert.equal(s1.status, 200);
  await w.fake.control.userSigns(s1.body.signId, EMPLOYEE_PERSON);
  const rf = await H.refreshSigningStatus({ idToken: 'tok-emp', tenantId: T, txId });
  assert.equal(rf.status, 200); assert.equal(rf.body.status, 'completed'); assert.equal(rf.body.signed, true);
  assert.deepEqual(Object.keys(rf.body).sort(), ['canStart', 'contractVersionId', 'mySigner', 'signed', 'status', 'txId']);
  assert.equal((await H.refreshSigningStatus({ idToken: 'tok-emp2', tenantId: T, txId })).status, 403);
  assert.equal((await H.getTransaction({ idToken: 'tok-emp', tenantId: T, txId })).status, 403);
  const full = await H.getTransaction({ idToken: 'tok-admin', tenantId: T, txId });
  assert.equal(full.status, 200); assert.ok(full.body.signers[1].evidence);
  const my = await H.getMySigningStatus({ idToken: 'tok-emp', tenantId: T, txId });
  assert.ok(!JSON.stringify(my.body).includes('evidence') && !JSON.stringify(my.body).includes('fake-sign-'), 'projection carries no evidence or provider ids');
  assert.equal((await H.getSignedAgreement({ idToken: 'tok-emp2', tenantId: T, txId })).status, 403);
  const dl = await H.getSignedAgreement({ idToken: 'tok-emp', tenantId: T, txId });
  assert.equal(dl.status, 200); assert.equal(sha(dl.body.bytes), dl.body.sha256);
  assert.equal((await H.getSignedAgreement({ idToken: 'tok-admin', tenantId: T, txId })).status, 200);
  assert.equal((await H.cancelSigning({ idToken: 'tok-emp', tenantId: T, txId })).status, 403);
});

// ======================= BOUNDARIES (P13 / P14 / secrets / runtime) =======================
await t('P13', 'NO NETWORK: zero non-loopback attempts during every scenario above; package source has no fetch/http client, no BankID/Signicat host', async () => {
  assert.deepEqual(blocked, []);
  const dir = new URL('../src/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    // code only: documentation comments may cite the official docs (developer.bankid.no) without being a call
    const src = fs.readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    for (const bad of ['fetch(', "from 'node:http'", "from 'node:https'", 'esign-stoe', 'bankid.no', 'signicat', 'auth.current.bankid', 'axios']) assert.ok(!src.toLowerCase().includes(bad.toLowerCase()), f + ' contains ' + bad);
  }
});
await t('P14', 'NO SECRET: disabled secret provider throws REAL_SECRETS_DISABLED_IN_BID1; the entry refuses any provider but "fake"; no credential-like literal in functions/ source or tests', async () => {
  await assert.rejects(createDisabledSecretProvider().getBankIdClientCredentials(), /REAL_SECRETS_DISABLED_IN_BID1/);
  assert.throws(() => assertBid1Environment({ SORMENA_SIGNING_PROVIDER: 'bankid' }), /BID1_FAKE_PROVIDER_ONLY/);
  assert.throws(() => assertBid1Environment({}), /BID1_FAKE_PROVIDER_ONLY/);
  assert.doesNotThrow(() => assertBid1Environment({ SORMENA_SIGNING_PROVIDER: 'fake' }));
  assert.throws(() => createSigningService({ config: { environment: 'preprod' } }), /BID1_FAKE_PROVIDER_ONLY/);
  const files = [...fs.readdirSync(new URL('../src/', import.meta.url)).map((f) => new URL('../src/' + f, import.meta.url)), new URL('../index.mjs', import.meta.url), new URL('../package.json', import.meta.url)];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const re of [/client_secret\s*[:=]\s*['"][^'"]+['"]/i, /clientSecret\s*[:=]\s*['"][^'"]+['"]/, /Bearer\s+ey[A-Za-z0-9_-]{10,}/, /access_token\s*[:=]\s*['"][^'"]+['"]/, /\b\d{11}\b/]) assert.ok(!re.test(s), f.pathname.split('/').pop() + ' ~ ' + re);
  }
});

for (const l of lines) console.log(l);
console.log('BID1_SIGNING_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
