// preprod-smoke.mjs — BID-2B PREPROD INFRASTRUCTURE SMOKE HARNESS (DISABLED BY DEFAULT; never a general write API).
// One fixed, fully SYNTHETIC scenario in the isolated namespace tenant "bankid-preprod-smoke" runs the -010
// real-shaped adapters (Firestore repository + private bucket adapter) with the FAKE WYSIWYS provider:
//   A tx creation  B deterministic source PDF  C source artifact persisted  D fake employer-signed artifact
//   E fake employee/final artifact  F sha256 verification  G artifact metadata  H completion gate  I Firestore readback
//   J GCS readback + hash verification  (+ K create-only refusal on the immutable final object; see -010 finding)
// Success needs NO delete: smoke records/objects stay as audit evidence.
// GATES (all explicit, no default-on, the -010 gate stays authoritative): resolveSigningTarget(env) (explicit project +
// bucket, production refused, platform signals must agree), SORMENA_SIGNING_REGION === europe-west1,
// SORMENA_PREPROD_SMOKE_ENABLED === 'true', SORMENA_SIGNING_ADAPTER_MODE ∈ emulator|live; live additionally needs
// SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED === 'true' AND a LIVE-SMOKE GRANT from live-smoke-gate.mjs (BID-2C: code-level
// single-run authorization + release-id echo + no emulator vars + no credential bypass + verified impersonated ADC).
// INPUT SURFACE: only a bounded run id (smoke-[a-z0-9]{4,32}); tenant/employee/paths/bucket/PDF/contract are FIXED.
// STEPS: A tx created  B deterministic source PDF  C A persisted+read back  L one-active lock refuses a 2nd initiate
// M stale-rev CAS update refused  D employer B  E employee/final C  F hash chain  G metadata  H completion gate
// I Firestore readback + lock released  J GCS readback  K duplicate create refused via the adapter (bytes/metadata/
// generation unchanged)  K2 (live only) direct ifGenerationMatch:0 create against the existing final object refused by
// the real backend — 412 OR 403 accepted, success = FAIL (the emulator ignores preconditions, so K2 never runs there).
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK } from 'jose';
import { BANKID_PREPROD, resolveSigningTarget, TargetRefused } from './preprod-config.mjs';
import { issueLiveSmokeGrant } from './live-smoke-gate.mjs';
import { createSigningTransactionRepository } from './firestore-stores.mjs';
import { createGcsArtifactStore, classifyStorageWriteError, DUPLICATE_REFUSAL_CLASSES } from './gcs-artifact-store.mjs';
import { createFakeWysiwys } from './fake-wysiwys.mjs';
import { createSigningService, isSigned } from './signing-service.mjs';
import { generateContractPdf } from './contract-pdf.mjs';
import { applyEmployeeOperation, employeeOf } from '../shared/management-employees-core.mjs';
import { applyContractOperation, contractInputsFor, draftVersionOf } from '../shared/management-contract-core.mjs';

export const SMOKE_TENANT = 'bankid-preprod-smoke';   // Firestore reserves ids matching __.*__, so the ticket's suggested __bankid_preprod_smoke__ is not a legal document id
export const SMOKE_RUN_ID = /^smoke-[a-z0-9]{4,32}$/;
export const SMOKE_CLOCK_MS = Date.UTC(2026, 8, 30, 8, 0, 0);   // fixed: the fixture and PDF are deterministic
const refuse = (code, detail) => { throw new TargetRefused(code, detail); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const J = (v) => JSON.stringify(v);

// opts: { runId, adcIdentity } — needed for live mode only (the grant is bound to ONE run id and a verified ADC record).
export function assertSmokeGates(env, opts) {
  const e = env || {}; const o = opts || {};
  const target = resolveSigningTarget(e);                                                   // -010 gate first (production refused before anything)
  if (e.SORMENA_SIGNING_REGION !== BANKID_PREPROD.region) refuse(e.SORMENA_SIGNING_REGION ? 'REGION_MISMATCH' : 'REGION_MISSING', String(e.SORMENA_SIGNING_REGION));
  if (e.SORMENA_PREPROD_SMOKE_ENABLED !== 'true') refuse('SMOKE_NOT_ENABLED', 'SORMENA_PREPROD_SMOKE_ENABLED must be exactly "true"');
  const mode = e.SORMENA_SIGNING_ADAPTER_MODE;
  if (mode !== 'emulator' && mode !== 'live') refuse('ADAPTER_MODE_REQUIRED', String(mode));
  let grant = null;
  if (mode === 'live') grant = issueLiveSmokeGrant({ env: e, runId: o.runId, adcIdentity: o.adcIdentity });   // always the module constant: no authorization override on the run path
  return { target, mode, grant };
}

// BID-2C §6 acceptance of the duplicate-create proof: the second create must be REFUSED (adapter conflict, 412 or IAM 403
// under the least-privilege identity), and the original object must be untouched (generation, metageneration, size,
// hashes, content type, custom metadata). Any successful replacement is a FAIL.
export function classifyDuplicateRefusal({ outcome, before, after, expectedSha256 }) {
  const refused = DUPLICATE_REFUSAL_CLASSES.includes(outcome);
  const same = (k) => (before && after ? String(before[k]) === String(after[k]) : false);
  const unchanged = { generation: same('generation'), metageneration: same('metageneration'), size: same('size'), md5Hash: same('md5Hash'), crc32c: same('crc32c'), contentType: same('contentType'), metadata: !!(before && after) && J(before.metadata) === J(after.metadata), sha256: !!(after && after.metadata && after.metadata.sha256 === expectedSha256) };
  return { ok: refused && Object.values(unchanged).every(Boolean), refused, outcome, unchanged };
}
export function assertRunId(runId) { if (typeof runId !== 'string' || !SMOKE_RUN_ID.test(runId)) refuse('SMOKE_RUN_ID_INVALID', String(runId).slice(0, 40)); return runId; }

// The ONE synthetic frozen contract (no real person, no real company facts, no NIN). ansattId carries the run id so
// every run leaves its own audit trail without ever touching another run's objects.
const SMOKE_PROFILE = Object.freeze({
  tenantId: SMOKE_TENANT, templateVersion: 'fs-ansettelsesavtale-v2',
  employer: { name: 'Smoke Arbeidsgiver AS', orgnr: '000000000', address: 'Testveien 1, 0001 Testby', nearestSuperior: 'Testleder' },
  representative: { name: 'Smoke Representant', role: 'Daglig leder' }, signingPlace: 'Testby',
  companyFacts: { salaryPaymentArrangement: 'Den 15. hver måned', pension: { applies: false }, occupationalInjuryInsurance: { applies: false }, tariffavtale: { applies: false } },
  clauses: [{ key: 'oppgaver', title: 'Arbeidsoppgaver', text: 'Syntetisk smoke-klausul.', version: 'smoke-1', bullets: ['Smoke-oppgave A', 'Smoke-oppgave B'] }],
});
export const SMOKE_EMPLOYER = Object.freeze({ uid: 'smoke-employer-uid', name: 'Smoke Representant', birthdate: '1970-01-01' });
const SMOKE_EMPLOYEE = Object.freeze({ name: 'Smoke Ansatt 01', birthdate: '1990-01-01' });
const ACTOR = { uid: SMOKE_EMPLOYER.uid, accessRole: 'admin', ansattId: null, accessEnabled: true, tenantId: SMOKE_TENANT, canManageSchedule: true, canViewOwnSchedule: false, canViewEmployeeCore: true, canViewEmployeeCompensation: true, canEditEmployment: true };
export function smokeFixture(runId) {
  assertRunId(runId);
  const store = { [SMOKE_TENANT]: {} };
  const ap = (op) => { const r = applyEmployeeOperation({ store, tenantId: SMOKE_TENANT, actor: ACTOR, op, now: SMOKE_CLOCK_MS }); if (!r.ok) throw new Error('smoke fixture ' + op.kind + ' ' + r.code); return r; };
  const c = ap({ kind: 'createEmployee', name: SMOKE_EMPLOYEE.name, startDate: '2026-08-01', role: 'butikkmedarbeider' });
  ap({ kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentType: 'deltid', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 200 }, expectedWeeklyHours: 18.75, noticePeriod: '1 måned', employmentForm: 'fast', workplace: 'Smoke Butikk', workingTimeArrangement: 'Arbeidstid etter vaktplan', probation: 'ingen', breaksArrangement: '30', scheduleChangeHandling: 'Vaktplan varsles 14 dager før', paymentInterval: 'manedlig' } });
  ap({ kind: 'updateContact', ansattId: c.ansattId, contact: { address: { street: 'Testveien 2', postalCode: '0001', city: 'Testby' }, birthDate: SMOKE_EMPLOYEE.birthdate } });
  const profile = JSON.parse(J(SMOKE_PROFILE));
  const cOp = (op, extra) => { const r = applyContractOperation(Object.assign({ store, tenantId: SMOKE_TENANT, actor: ACTOR, op, profile, now: SMOKE_CLOCK_MS, onDate: '2026-09-30', roleLabels: { butikkmedarbeider: 'Butikkmedarbeider' } }, extra || {})); if (!r.ok) throw new Error('smoke contract ' + op.kind + ' ' + r.code + ' ' + J(r.missing || '')); return r; };
  cOp({ kind: 'startDraft', ansattId: c.ansattId });
  const emp = () => employeeOf(store, SMOKE_TENANT, c.ansattId);
  const draft = draftVersionOf(emp());
  cOp({ kind: 'freezeVersion', ansattId: c.ansattId, contractVersionId: draft.contractVersionId, expectedInputs: JSON.parse(J(contractInputsFor({ employee: emp(), profile, onDate: '2026-09-30', roleLabels: { butikkmedarbeider: 'Butikkmedarbeider' } }))) }, { requireReviewedInputs: true });
  const version = JSON.parse(J(emp().contractVersions[0]));
  // run-scoped identifiers: the version id and employee id embed the run id (fixed shape, never caller-chosen)
  version.contractVersionId = 'kv-' + runId + '-1';
  return { ansattId: 'ansatt-' + runId, version, versionJson: J(version) };
}

// deps: { app, db, bucket, env, runId, adcIdentity? }. Returns { ok, runId, steps[], evidence } — never throws on a step
// failure. adcIdentity (a record from adc-identity.readAdcIdentity) is consulted ONLY in live mode.
export async function runPreprodSmoke({ app, db, bucket, env, runId, adcIdentity }) {
  const steps = []; const evidence = { tenantId: SMOKE_TENANT };
  const step = (id, name, ok, detail) => { steps.push({ id, name, ok: !!ok, detail }); return ok; };
  let gates;
  try { assertRunId(runId); gates = assertSmokeGates(env, { runId, adcIdentity }); } catch (e) { return { ok: false, refused: e.code, detail: e.detail || null, steps: [] }; }
  const { target, mode, grant } = gates;
  try {
    const repo = createSigningTransactionRepository({ app, db, target, mode, env, liveGrant: grant });
    const store = createGcsArtifactStore({ bucket, target, mode, env, liveGrant: grant });
    const fx = smokeFixture(runId);
    evidence.ansattId = fx.ansattId; evidence.contractVersionId = fx.version.contractVersionId;
    const keys = await generateKeyPair('ES256'); const jwk = Object.assign(await exportJWK(keys.publicKey), { kid: 'smoke-k1', alg: 'ES256' });
    let now = SMOKE_CLOCK_MS; const clock = () => now;
    const fake = createFakeWysiwys({ clock, signingKey: keys.privateKey, kid: 'smoke-k1', issuer: 'fake.smoke.local', alg: 'ES256' });
    const svc = createSigningService({ txStore: repo, artifactStore: store, provider: fake.api, clock, config: { environment: 'fake', targetProjectId: target.projectId, verifier: { jwks: { keys: [jwk] }, issuer: 'fake.smoke.local', algorithms: ['ES256'] } } });
    // A + B + C
    const expected = await generateContractPdf(fx.version);
    const init = await svc.initiate({ tenantId: SMOKE_TENANT, ansattId: fx.ansattId, version: fx.version, employerSigner: SMOKE_EMPLOYER, actorUid: SMOKE_EMPLOYER.uid });
    if (!step('A', 'signing transaction created (awaiting_signer)', init.ok && init.tx.status === 'awaiting_signer', init.ok ? { txId: init.tx.txId, attempt: init.tx.attempt } : init)) return { ok: false, runId, steps, evidence };
    const txId = init.tx.txId; evidence.txId = txId;
    step('B', 'deterministic canonical source PDF (hash == generator hash)', init.tx.source.sourcePdfSha256 === expected.identity.sourcePdfSha256 && init.tx.source.sourceSnapshotSha256 === expected.identity.sourceSnapshotSha256, { sourcePdfSha256: init.tx.source.sourcePdfSha256, pages: expected.pageCount });
    const aBytes = await store.get(init.tx.source.artifactRef, init.tx.source.sourcePdfSha256).catch((e) => e);
    step('C', 'source artifact persisted and read back hash-verified', Buffer.isBuffer(aBytes) && sha(aBytes) === init.tx.source.sourcePdfSha256, { ref: init.tx.source.artifactRef, reused: init.tx.source.reusedExistingArtifact });
    // L: one-active-signing lock — a second initiate on the same frozen version while this one is open is refused
    const second = await svc.initiate({ tenantId: SMOKE_TENANT, ansattId: fx.ansattId, version: fx.version, employerSigner: SMOKE_EMPLOYER, actorUid: SMOKE_EMPLOYER.uid });
    step('L', 'one-active lock: second initiate on the same version refused (ACTIVE_TRANSACTION_EXISTS) while the first is open', second.ok === false && second.code === 'ACTIVE_TRANSACTION_EXISTS' && second.txId === txId, { code: second.code, activeTxId: second.txId });
    // M: compare-and-set — an update carrying a stale revision is refused and changes nothing
    const cur0 = await repo.get(SMOKE_TENANT, txId);
    const stale = await repo.update(SMOKE_TENANT, txId, cur0.rev - 1, Object.assign(JSON.parse(J(cur0)), { issues: ['stale-write-attempt'] }));
    const cur1 = await repo.get(SMOKE_TENANT, txId);
    step('M', 'CAS/revision: stale-rev update refused (TX_CONFLICT); document rev and content unchanged', stale.ok === false && stale.code === 'TX_CONFLICT' && cur1.rev === cur0.rev && J(cur1) === J(cur0), { rev: cur0.rev, code: stale.code });
    // D
    const s0 = await svc.startSession({ tenantId: SMOKE_TENANT, txId });
    await fake.control.userSigns(s0.signId, { sub: 'UN:NO-SMOKE-EMR', name: SMOKE_EMPLOYER.name, birthdate: SMOKE_EMPLOYER.birthdate });
    await svc.refresh({ tenantId: SMOKE_TENANT, txId });
    let tx = await repo.get(SMOKE_TENANT, txId);
    step('D', 'fake employer-signed artifact B stored, identity matched, next signer awaiting', tx.signers[0].status === 'signed' && tx.signers[0].identity.matched && tx.status === 'awaiting_signer' && tx.currentSignerIndex === 1, { B: tx.signers[0].output && tx.signers[0].output.sha256 });
    // E
    const s1 = await svc.startSession({ tenantId: SMOKE_TENANT, txId });
    await fake.control.userSigns(s1.signId, { sub: 'UN:NO-SMOKE-EMP', name: SMOKE_EMPLOYEE.name, birthdate: SMOKE_EMPLOYEE.birthdate });
    await svc.refresh({ tenantId: SMOKE_TENANT, txId });
    tx = await repo.get(SMOKE_TENANT, txId);
    step('E', 'fake employee/final artifact C stored', !!(tx.signers[1].output && tx.finalArtifact), { C: tx.finalArtifact && tx.finalArtifact.sha256 });
    // F
    const chain = tx.signers[0].output && tx.signers[1].output && tx.finalArtifact && tx.signers[0].output.inputSha256 === tx.source.sourcePdfSha256 && tx.signers[1].output.inputSha256 === tx.signers[0].output.sha256 && tx.finalArtifact.sha256 === tx.signers[1].output.sha256;
    step('F', 'SHA-256 chain A -> B -> C recorded and consistent', chain, { A: tx.source.sourcePdfSha256, B: tx.signers[0].output && tx.signers[0].output.sha256, C: tx.finalArtifact && tx.finalArtifact.sha256 });
    // G
    const metas = await Promise.all([store.metadataOf(tx.source.artifactRef), store.metadataOf(tx.signers[0].output.ref), store.metadataOf(tx.finalArtifact.ref)]);
    const bound = (m, stage, h, role) => m.contentType === 'application/pdf' && m.metadata.stage === stage && m.metadata.sha256 === h && m.metadata.tenantId === SMOKE_TENANT && m.metadata.ansattId === fx.ansattId && m.metadata.contractVersionId === fx.version.contractVersionId && (role ? m.metadata.txId === txId && m.metadata.signerRole === role : !m.metadata.txId);
    step('G', 'required artifact metadata on A/B/C (stage, tenant, employee, contract version, tx, role, sha256, application/pdf)', bound(metas[0], 'source_unsigned', tx.source.sourcePdfSha256) && bound(metas[1], 'employer_signed', tx.signers[0].output.sha256, 'employer') && bound(metas[2], 'final_signed', tx.finalArtifact.sha256, 'employee'), { stages: metas.map((m) => m.metadata.stage), generations: metas.map((m) => m.generation) });
    // H
    step('H', 'final completion gate: completed + derived signed only with both verified signers and durable final artifact', tx.status === 'completed' && isSigned(tx) && tx.signers.every((s) => s.status === 'signed' && s.identity.matched && s.evidence), { status: tx.status, completedAt: tx.completedAt });
    // I
    const doc = await db.doc('tenants/' + SMOKE_TENANT + '/signingTransactions/' + txId).get();
    const lock = await db.doc('tenants/' + SMOKE_TENANT + '/signingLocks/' + fx.version.contractVersionId).get();
    const txJson = J(doc.exists ? doc.data() : null);
    step('I', 'Firestore readback: transaction document present (rev, status), lock released; no NIN/PID/JWT/token', doc.exists && doc.data().status === 'completed' && doc.data().rev === tx.rev && lock.exists && lock.data().activeTxId === null && !/eyJ[A-Za-z0-9_-]{10,}|2\.16\.578\.1\.61\.2\.[34]|\b\d{11}\b|client_secret|access_token/.test(txJson), { rev: tx.rev, targetProjectId: doc.exists && doc.data().targetProjectId });
    // J
    const cBytes = await store.get(tx.finalArtifact.ref, tx.finalArtifact.sha256).catch((e) => e);
    step('J', 'GCS readback of final artifact C, bytes hash == recorded == object metadata sha256', Buffer.isBuffer(cBytes) && sha(cBytes) === tx.finalArtifact.sha256 && metas[2].metadata.sha256 === tx.finalArtifact.sha256, { bytes: Buffer.isBuffer(cBytes) ? cBytes.length : null });
    // K: duplicate create through the adapter (existence check + ifGenerationMatch 0); §6 acceptance = refused AND untouched
    const overwrite = Buffer.from('%PDF-1.7 smoke-overwrite-attempt');
    const conflict = await store.putOnce(tx.finalArtifact.ref, overwrite, { stage: 'final_signed', tenantId: SMOKE_TENANT, ansattId: fx.ansattId, contractVersionId: fx.version.contractVersionId, txId }).then(() => 'NO_REFUSAL').catch((e) => classifyStorageWriteError(e));
    const metaAfter = await store.metadataOf(tx.finalArtifact.ref);
    const cAfter = await store.get(tx.finalArtifact.ref, tx.finalArtifact.sha256).catch((e) => e);
    const kv = classifyDuplicateRefusal({ outcome: conflict, before: metas[2], after: metaAfter, expectedSha256: tx.finalArtifact.sha256 });
    step('K', 'duplicate create of the immutable final object refused via the adapter; bytes, sha256, metadata and generation unchanged', kv.ok && Buffer.isBuffer(cAfter) && sha(cAfter) === tx.finalArtifact.sha256, { refusal: conflict, unchanged: kv.unchanged, generation: [metas[2].generation, metaAfter.generation], enforcedBy: 'adapter existence check' });
    // K2 (LIVE ONLY): bypass the adapter's existence check and let the REAL backend decide — a direct create-only write
    // (ifGenerationMatch: 0) against the existing final object. Accepted refusals: 412 precondition OR 403 IAM (the
    // runtime identity has no storage.objects.delete). Success = overwrite = FAIL. Not run on the emulator (it ignores
    // preconditions and WOULD overwrite).
    if (mode === 'live') {
      const direct = await bucket.file(tx.finalArtifact.ref).save(overwrite, { resumable: false, contentType: 'application/pdf', metadata: { contentType: 'application/pdf', metadata: { stage: 'final_signed', smokeProbe: 'K2' } }, preconditionOpts: { ifGenerationMatch: 0 } }).then(() => 'NO_REFUSAL').catch((e) => classifyStorageWriteError(e));
      const metaAfter2 = await store.metadataOf(tx.finalArtifact.ref);
      const cAfter2 = await store.get(tx.finalArtifact.ref, tx.finalArtifact.sha256).catch((e) => e);
      const k2 = classifyDuplicateRefusal({ outcome: direct, before: metas[2], after: metaAfter2, expectedSha256: tx.finalArtifact.sha256 });
      step('K2', 'REAL BACKEND: direct ifGenerationMatch:0 create against the existing final object refused (412 or 403 accepted); generation, bytes, sha256, metadata unchanged', k2.ok && direct !== 'ARTIFACT_IMMUTABLE_CONFLICT' && Buffer.isBuffer(cAfter2) && sha(cAfter2) === tx.finalArtifact.sha256, { refusal: direct, unchanged: k2.unchanged, generation: [metas[2].generation, metaAfter2.generation], enforcedBy: 'real Cloud Storage precondition / IAM' });
    }
    evidence.hashes = { A: tx.source.sourcePdfSha256, B: tx.signers[0].output.sha256, C: tx.finalArtifact.sha256 };
    evidence.paths = { tx: 'tenants/' + SMOKE_TENANT + '/signingTransactions/' + txId, lock: 'tenants/' + SMOKE_TENANT + '/signingLocks/' + fx.version.contractVersionId, A: tx.source.artifactRef, B: tx.signers[0].output.ref, C: tx.finalArtifact.ref };
    evidence.generations = { A: metas[0].generation, B: metas[1].generation, C: metas[2].generation };
    return { ok: steps.every((s) => s.ok), runId, mode, target, steps, evidence };
  } catch (e) {
    steps.push({ id: 'ERR', name: 'unexpected error', ok: false, detail: String(e && e.code || e && e.message || e).slice(0, 300) });
    return { ok: false, runId, steps, evidence };
  }
}

// Future private (invoker=private) Cloud Functions 2nd gen entry: POST { runId } only. Not exported for deploy in BID-2B.
export function makeSmokeHandler({ app, db, bucket, env }) {
  return async (body) => {
    const runId = body && body.runId;
    try { assertRunId(runId); } catch (e) { return { status: 400, body: { code: e.code } }; }
    for (const k of Object.keys(body || {})) if (k !== 'runId') return { status: 400, body: { code: 'UNEXPECTED_INPUT', field: k } };   // no other caller input is honoured
    const r = await runPreprodSmoke({ app, db, bucket, env, runId });
    return { status: r.refused ? 403 : r.ok ? 200 : 500, body: r };
  };
}
