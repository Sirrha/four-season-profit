// signing-service.mjs — BID-1 component C: SIGNING TRANSACTION CORE / STATE MACHINE (provider-agnostic, no network).
// Separate truth (D4): all signing process state and evidence live in tenants/{T}/signingTransactions/{txId}. The frozen
// contract version is READ ONLY here — never written (version.signingTransaction / signedArtifactMeta stay null).
// "Signed" is DERIVED: a transaction in status 'completed' whose final artifact is stored and hash-verified.
//
// Transaction.status: preparing_source -> awaiting_signer <-> signing_session -> (next signer ...) -> finalizing -> completed
//                     identity_review (a verified signature whose identity does not match; never auto-completes)
//                     terminal: completed | rejected | cancelled | failed          (terminal releases the one-active lock)
// Signer.status:      pending | in_session | signed | rejected
// Session.outcome:    null (open) | signed | rejected | timed_out | failed | not_found | expired | failed_result_lost |
//                     hash_mismatch | identity_review | cancelled
import { createHash, randomUUID } from 'node:crypto';
import { generateContractPdf, GENERATOR_VERSION } from './contract-pdf.mjs';
import { signableVersionProblem } from './contract-document.mjs';
import { verifySignerInfo, matchSignerIdentity, normalizeName } from './signerinfo-verifier.mjs';
import { TERMINAL_TX } from './stores.mjs';
import { FINAL_ORDER_STATES, TWO_HOURS_MS } from './fake-wysiwys.mjs';

export const PROVIDER_ID = 'bankid_wysiwys_v1';
export const TX_STATUS = Object.freeze({ PREPARING: 'preparing_source', AWAITING: 'awaiting_signer', SESSION: 'signing_session', FINALIZING: 'finalizing', REVIEW: 'identity_review', COMPLETED: 'completed', REJECTED: 'rejected', CANCELLED: 'cancelled', FAILED: 'failed' });
export const SIGNER_STATUS = Object.freeze({ PENDING: 'pending', IN_SESSION: 'in_session', SIGNED: 'signed', REJECTED: 'rejected' });
const RANK = { ORDER_RECEIVED: 0, USER_SIGNING: 1, REJECTED: 2, FAILED: 2, TIMED_OUT: 2, SIGN_COMPLETED: 2 };
const LEASE_MS = 60000, RESERVATION_MS = 30000;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
export const isTerminal = (tx) => TERMINAL_TX.includes(tx.status);
export const isSigned = (tx) => !!(tx && tx.status === TX_STATUS.COMPLETED && tx.finalArtifact && tx.finalArtifact.sha256);   // DERIVED signed condition

export function createSigningService({ txStore, artifactStore, provider, clock, config, hooks }) {
  const cfg = config || {};
  const h = hooks || {};
  const now = () => clock();
  if (cfg.environment !== 'fake') throw Object.assign(new Error('BID1_FAKE_PROVIDER_ONLY'), { code: 'BID1_FAKE_PROVIDER_ONLY' });

  async function mutate(tenantId, txId, fn) {
    for (let i = 0; i < 4; i++) {
      const cur = await txStore.get(tenantId, txId);
      if (!cur) return { ok: false, code: 'TX_UNKNOWN' };
      const draft = clone(cur);
      const r = await fn(draft, cur);
      if (!r || r.abort) return r ? r.abort : { ok: false, code: 'NO_CHANGE' };
      draft.updatedAt = now();
      const u = await txStore.update(tenantId, txId, cur.rev, draft);
      if (u.ok) return Object.assign({ ok: true, tx: u.tx }, r.result || {});
      if (u.code !== 'TX_CONFLICT') return u;
    }
    return { ok: false, code: 'TX_CONFLICT' };
  }
  const openSessionOf = (signer) => { const s = signer.sessions[signer.sessions.length - 1]; return s && s.outcome == null ? s : null; };
  const inputOf = (tx, idx) => (idx === 0 ? { ref: tx.source.artifactRef, sha256: tx.source.sourcePdfSha256 } : { ref: tx.signers[idx - 1].output.ref, sha256: tx.signers[idx - 1].output.sha256 });
  const outputKey = (tx, idx) => 'tenants/' + tx.tenantId + '/contracts/' + tx.ansattId + '/' + tx.contractVersionId + '/' + tx.txId + '/signed-' + (idx + 1) + '.pdf';
  function closeSession(tx, idx, outcome, extra) {
    const s = tx.signers[idx]; const ses = openSessionOf(s);
    if (ses) Object.assign(ses, { outcome, closedAt: now() }, extra || {});
    if (outcome === 'rejected') { s.status = SIGNER_STATUS.REJECTED; tx.status = TX_STATUS.REJECTED; tx.terminalReason = 'SIGNER_REJECTED:' + s.role; tx.completedAt = null; }
    else if (!['signed', 'identity_review'].includes(outcome)) { s.status = SIGNER_STATUS.PENDING; if (!isTerminal(tx)) tx.status = TX_STATUS.AWAITING; }
  }

  // ---- INITIATE: frozen version only; ONE non-terminal transaction per version (lock), same source A for every attempt ----
  async function initiate({ tenantId, ansattId, version, employerSigner, actorUid }) {
    const problem = signableVersionProblem(version);
    if (problem) return { ok: false, code: problem };
    const snap = version.snapshot;
    if (!employerSigner || !employerSigner.uid || !employerSigner.name || !employerSigner.birthdate) return { ok: false, code: 'EMPLOYER_SIGNER_NOT_DESIGNATED' };
    const rep = snap.representative && snap.representative.name;
    if (!rep || normalizeName(rep) !== normalizeName(employerSigner.name)) return { ok: false, code: 'EMPLOYER_SIGNER_NOT_CONTRACT_REPRESENTATIVE' };
    const person = snap.person || {};
    if (!person.name || !person.birthDate) return { ok: false, code: 'EMPLOYEE_IDENTITY_INCOMPLETE' };
    const created = await txStore.createActive(tenantId, version.contractVersionId, (attempt) => ({
      txId: version.contractVersionId + '-sig-' + attempt, provider: PROVIDER_ID, environment: cfg.environment,
      tenantId, ansattId, contractVersionId: version.contractVersionId, attempt,
      source: null, employerSignerUid: employerSigner.uid, employerSignerName: employerSigner.name,
      status: TX_STATUS.PREPARING, currentSignerIndex: 0,
      signers: [
        { index: 0, role: 'employer', expectedUid: employerSigner.uid, expectedName: employerSigner.name, expectedBirthdate: employerSigner.birthdate, status: SIGNER_STATUS.PENDING, sessions: [], output: null, evidence: null, identity: null },
        { index: 1, role: 'employee', expectedAnsattId: ansattId, expectedName: person.name, expectedBirthdate: person.birthDate, status: SIGNER_STATUS.PENDING, sessions: [], output: null, evidence: null, identity: null },
      ],
      targetProjectId: cfg.targetProjectId || null,   // BID-2A: the validated cloud target this transaction is bound to (null = local)
      finalArtifact: null, issues: [], createdAt: now(), createdByUid: actorUid, updatedAt: now(), completedAt: null, terminalReason: null,
    }));
    if (!created.ok) return created;
    const tx = created.tx;
    // source A: deterministic, stored once per (version, generator); every later attempt reuses the identical bytes
    let pdf, stored, ref;
    try {
      pdf = await generateContractPdf(version);
      if (!pdf.ok) throw Object.assign(new Error(pdf.code), { code: pdf.code });
      ref = 'tenants/' + tenantId + '/contracts/' + ansattId + '/' + version.contractVersionId + '/source-' + slug(GENERATOR_VERSION) + '.pdf';
      stored = await artifactStore.putOnce(ref, pdf.bytes, { stage: 'source_unsigned', tenantId, ansattId, contractVersionId: version.contractVersionId, sourceSnapshotSha256: pdf.identity.sourceSnapshotSha256, generatorVersion: pdf.identity.generatorVersion });
      await artifactStore.get(ref, pdf.identity.sourcePdfSha256);
    } catch (e) {
      await mutate(tenantId, tx.txId, (d) => { d.status = TX_STATUS.FAILED; d.terminalReason = 'SOURCE_PREPARATION_FAILED:' + (e.code || e.message); return {}; });
      return { ok: false, code: 'SOURCE_PREPARATION_FAILED', detail: e.code || e.message, txId: tx.txId };
    }
    return mutate(tenantId, tx.txId, (d) => {
      d.source = { generatorVersion: pdf.identity.generatorVersion, templateVersion: pdf.identity.templateVersion, sourceSnapshotSha256: pdf.identity.sourceSnapshotSha256,
        sourcePdfSha256: pdf.identity.sourcePdfSha256, byteLength: pdf.identity.byteLength, artifactRef: ref, reusedExistingArtifact: stored.reused };
      d.status = TX_STATUS.AWAITING;
      return {};
    });
  }

  // ---- START SESSION: one open provider order per current signer; retries return the same session ----
  async function startSession({ tenantId, txId }) {
    const reservationId = randomUUID();
    let reserved = null;
    const r = await mutate(tenantId, txId, (d) => {
      reserved = null;   // a CAS retry re-runs this function on fresh state: never keep a reservation from a lost attempt
      if (![TX_STATUS.AWAITING, TX_STATUS.SESSION].includes(d.status)) return { abort: { ok: false, code: 'TX_NOT_AWAITING_SIGNER', status: d.status } };
      const idx = d.currentSignerIndex; const s = d.signers[idx];
      if (idx === 1 && !(d.signers[0].status === SIGNER_STATUS.SIGNED && d.signers[0].identity && d.signers[0].identity.matched && d.signers[0].output)) return { abort: { ok: false, code: 'PREVIOUS_SIGNER_NOT_VERIFIED' } };
      const open = openSessionOf(s);
      if (open && open.signId && now() - open.orderCreatedAt <= TWO_HOURS_MS) return { abort: { ok: true, reused: true, signId: open.signId, url: open.url, signerIndex: idx } };
      if (open && !open.signId && now() - open.reservedAt < RESERVATION_MS) return { abort: { ok: false, code: 'SESSION_BEING_CREATED' } };
      if (open) Object.assign(open, { outcome: open.signId ? 'expired' : 'failed', closedAt: now(), note: open.signId ? 'TWO_HOUR_CEILING' : 'STALE_RESERVATION' });
      const input = inputOf(d, idx);
      s.sessions.push({ sessionNo: s.sessions.length + 1, reservationId, signId: null, url: null, reservedAt: now(), orderCreatedAt: null, inputRef: input.ref, inputSha256: input.sha256,
        providerState: null, lastCheckedAt: null, callbackReceivedAt: null, retrieval: null, outcome: null });
      s.status = SIGNER_STATUS.IN_SESSION; d.status = TX_STATUS.SESSION;
      reserved = { idx, input };
      return {};
    });
    if (!reserved) return r;
    const tx = r.tx; const idx = reserved.idx;
    let bytes;
    try { bytes = await artifactStore.get(reserved.input.ref, reserved.input.sha256); }                   // exact stored predecessor bytes, hash-verified
    catch (e) {
      await mutate(tenantId, txId, (d) => { closeSession(d, idx, 'failed', { note: 'INPUT_ARTIFACT_' + (e.code || 'ERROR') }); d.issues.push({ at: now(), code: 'INPUT_ARTIFACT_' + (e.code || 'ERROR') }); return {}; });
      return { ok: false, code: 'INPUT_ARTIFACT_' + (e.code || 'ERROR') };
    }
    const order = await provider.createSignOrder({
      orderName: 'Ansettelsesavtale ' + tx.contractVersionId + ' (' + (idx === 0 ? 'arbeidsgiver' : 'arbeidstaker') + ')',
      documents: [{ pdf: bytes.toString('base64'), description: 'Ansettelsesavtale ' + tx.contractVersionId }],
      addVisualSeals: true,
      merchantWorkflowState: idx === 0 ? 'WORKFLOW_ACTIVE' : 'NO_WORKFLOW',   // employer first: more signers follow; employee last
      useConversion: false,                                                    // never convert an already-signed PDF
      resultContent: { requestSignerInfo: true },
      redirectUrl: (cfg.returnUrl || 'http://127.0.0.1/bankid/return') + '?tenant=' + encodeURIComponent(tenantId) + '&tx=' + encodeURIComponent(txId) + '&s=' + idx,
      requestCallback: true,
      timeoutSeconds: cfg.orderTimeoutSeconds || 600,
    });
    return mutate(tenantId, txId, (d) => {
      const ses = d.signers[idx].sessions.find((x) => x.reservationId === reservationId);
      if (!ses || ses.outcome != null) return { abort: { ok: false, code: 'SESSION_SUPERSEDED' } };
      if (!order.ok) { closeSession(d, idx, 'failed', { note: 'PROVIDER_CREATE_' + order.code }); return { result: { ok: false, code: 'PROVIDER_CREATE_FAILED', detail: order.code } }; }
      Object.assign(ses, { signId: order.signId, url: order.url, orderCreatedAt: now(), providerState: 'ORDER_RECEIVED' });
      return { result: { reused: false, signId: order.signId, url: order.url, signerIndex: idx } };
    });
  }

  // ---- REFRESH: authoritative GET drives every transition (callbacks only trigger this) ----
  async function refresh({ tenantId, txId, source }) {
    const tx0 = await txStore.get(tenantId, txId);
    if (!tx0) return { ok: false, code: 'TX_UNKNOWN' };
    if (isTerminal(tx0)) return { ok: true, tx: tx0, noop: 'TERMINAL' };
    if (tx0.status === TX_STATUS.FINALIZING) return finalize(tenantId, txId);
    if (tx0.status !== TX_STATUS.SESSION) return { ok: true, tx: tx0, noop: 'NO_OPEN_SESSION' };
    const idx = tx0.currentSignerIndex;
    const ses0 = openSessionOf(tx0.signers[idx]);
    if (!ses0 || !ses0.signId) return { ok: true, tx: tx0, noop: 'NO_OPEN_SESSION' };
    const signId = ses0.signId;
    if (source === 'callback') await mutate(tenantId, txId, (d) => { const s = openSessionOf(d.signers[idx]); if (!s || s.signId !== signId) return { abort: { ok: true } }; s.callbackReceivedAt = now(); return {}; });
    if (now() - ses0.orderCreatedAt > TWO_HOURS_MS && !ses0.retrieval) {
      return mutate(tenantId, txId, (d) => { const s = openSessionOf(d.signers[idx]); if (!s || s.signId !== signId) return { abort: { ok: true, noop: 'STALE' } }; closeSession(d, idx, 'expired', { note: 'TWO_HOUR_CEILING' }); return {}; });
    }
    const st = await provider.getOrderState(signId);
    if (!st.found) {
      return mutate(tenantId, txId, (d) => {
        const s = openSessionOf(d.signers[idx]); if (!s || s.signId !== signId) return { abort: { ok: true, noop: 'STALE' } };
        // a lease without a stored result means DELETE may already have happened: the signature is lost, never assumed
        closeSession(d, idx, s.retrieval ? 'failed_result_lost' : 'not_found', { note: 'PROVIDER_404' });
        return {};
      });
    }
    if (st.orderState !== 'SIGN_COMPLETED' || !FINAL_ORDER_STATES.includes(st.orderState)) {
      return mutate(tenantId, txId, (d) => {
        const s = openSessionOf(d.signers[idx]); if (!s || s.signId !== signId) return { abort: { ok: true, noop: 'STALE' } };
        if (s.providerState && RANK[st.orderState] < RANK[s.providerState]) return { abort: { ok: true, noop: 'NON_MONOTONIC_IGNORED', tx: d } };
        s.providerState = st.orderState; s.lastCheckedAt = now();
        if (st.orderState === 'REJECTED') closeSession(d, idx, 'rejected');
        else if (st.orderState === 'TIMED_OUT') closeSession(d, idx, 'timed_out');
        else if (st.orderState === 'FAILED') closeSession(d, idx, 'failed', { note: 'PROVIDER_FAILED' });
        return {};
      });
    }
    return retrieve(tenantId, txId, idx, signId);
  }

  // ---- RETRIEVE: exactly one worker holds the lease; DELETE is destructive, so bytes are stored before anything else ----
  async function retrieve(tenantId, txId, idx, signId) {
    const leaseId = randomUUID();
    const got = await mutate(tenantId, txId, (d) => {
      const s = openSessionOf(d.signers[idx]); if (!s || s.signId !== signId) return { abort: { ok: true, noop: 'STALE' } };
      if (s.retrieval && now() - s.retrieval.at < LEASE_MS) return { abort: { ok: true, noop: 'RETRIEVAL_IN_PROGRESS' } };
      s.providerState = 'SIGN_COMPLETED'; s.lastCheckedAt = now(); s.retrieval = { leaseId, at: now() };
      return {};
    });
    if (!got.ok || got.noop) return got;
    const tx = got.tx;
    const ses = openSessionOf(tx.signers[idx]);
    const res = await provider.downloadAndDeleteResult(signId);
    if (h.afterDelete) await h.afterDelete({ txId, idx, signId });                                   // test crash injection point
    const fail = (outcome, code, terminal) => mutate(tenantId, txId, (d) => {
      const s = openSessionOf(d.signers[idx]); if (!s || !s.retrieval || s.retrieval.leaseId !== leaseId) return { abort: { ok: true, noop: 'LEASE_LOST' } };
      closeSession(d, idx, outcome, { note: code }); d.issues.push({ at: now(), code, signerIndex: idx });
      if (terminal) { d.status = TX_STATUS.FAILED; d.terminalReason = code; }
      return { result: { failed: code } };
    });
    if (!res.found || !Array.isArray(res.signingResults) || res.signingResults.length !== 1) return fail('failed_result_lost', res.found ? 'RESULT_EMPTY' : 'RESULT_NOT_FOUND');
    const out = res.signingResults[0];
    if (out.unsignedDocumentSha256 !== ses.inputSha256) return fail('hash_mismatch', 'UNSIGNED_HASH_MISMATCH', true);
    const bytes = Buffer.from(out.padesSignedPdf, 'base64');
    if (sha(bytes) !== out.signedDocumentSha256) return fail('hash_mismatch', 'SIGNED_HASH_MISMATCH', true);
    const key = outputKey(tx, idx);
    try {
      await artifactStore.putOnce(key, bytes, { stage: idx === 0 ? 'employer_signed' : 'final_signed', tenantId, ansattId: tx.ansattId, contractVersionId: tx.contractVersionId, txId, signerRole: tx.signers[idx].role });
      await artifactStore.get(key, out.signedDocumentSha256);
    }
    catch (e) { return fail('failed_result_lost', 'ARTIFACT_STORE_FAILED:' + (e.code || e.message)); }   // bytes die with this invocation
    const v = await verifySignerInfo(res.signerInfo, cfg.verifier, now());
    const signer = tx.signers[idx];
    const match = v.ok ? matchSignerIdentity(v.evidence, { name: signer.expectedName, birthdate: signer.expectedBirthdate }, { allowedQualities: cfg.allowedQualities || ['QES'] }) : { matched: false, reasons: ['JWT:' + v.code] };
    const done = await mutate(tenantId, txId, (d) => {
      const s = openSessionOf(d.signers[idx]); if (!s || !s.retrieval || s.retrieval.leaseId !== leaseId) return { abort: { ok: true, noop: 'LEASE_LOST' } };
      const sg = d.signers[idx];
      sg.output = { ref: key, sha256: out.signedDocumentSha256, byteLength: bytes.length, inputSha256: out.unsignedDocumentSha256, signId };
      sg.evidence = v.ok ? v.evidence : null;           // minimized; raw JWT never stored
      sg.identity = match;
      sg.status = SIGNER_STATUS.SIGNED;
      Object.assign(s, { outcome: match.matched ? 'signed' : 'identity_review', closedAt: now() });
      if (!match.matched) { d.status = TX_STATUS.REVIEW; d.issues.push({ at: now(), code: 'IDENTITY_REVIEW', signerIndex: idx, reasons: match.reasons }); return {}; }
      if (idx === 0) { d.currentSignerIndex = 1; d.status = TX_STATUS.AWAITING; }
      else { d.finalArtifact = { ref: key, sha256: out.signedDocumentSha256, byteLength: bytes.length }; d.status = TX_STATUS.FINALIZING; }
      return {};
    });
    if (done.ok && done.tx.status === TX_STATUS.FINALIZING) return finalize(tenantId, txId);
    return done;
  }

  // ---- FINAL SIGNED GATE: both verified identities + stored, re-verified final artifact + intact A->B->C chain ----
  async function finalize(tenantId, txId) {
    const tx = await txStore.get(tenantId, txId);
    const problems = [];
    const [e, w] = tx.signers;
    for (const s of [e, w]) if (!(s.status === SIGNER_STATUS.SIGNED && s.evidence && s.identity && s.identity.matched && s.output)) problems.push('SIGNER_NOT_VERIFIED:' + s.role);
    if (e.output && e.output.inputSha256 !== tx.source.sourcePdfSha256) problems.push('CHAIN_A_TO_B');
    if (e.output && w.output && w.output.inputSha256 !== e.output.sha256) problems.push('CHAIN_B_TO_C');
    if (!tx.finalArtifact || !w.output || tx.finalArtifact.sha256 !== w.output.sha256) problems.push('FINAL_ARTIFACT_UNRECORDED');
    if (!problems.length) { try { await artifactStore.get(tx.finalArtifact.ref, tx.finalArtifact.sha256); } catch (err) { problems.push('FINAL_ARTIFACT_' + (err.code || 'ERROR')); } }
    return mutate(tenantId, txId, (d) => {
      if (d.status !== TX_STATUS.FINALIZING) return { abort: { ok: true, tx: d, noop: 'NOT_FINALIZING' } };
      if (problems.length) { d.issues.push({ at: now(), code: 'COMPLETION_GATE', problems }); return { result: { gate: problems } }; }   // stays finalizing
      d.status = TX_STATUS.COMPLETED; d.completedAt = now(); d.terminalReason = null;
      return { result: { gate: [] } };
    });
  }

  // ---- application-level cancel (BankID has no cancel endpoint; an open order simply expires and is never collected) ----
  async function cancel({ tenantId, txId, actorUid, reason }) {
    return mutate(tenantId, txId, (d) => {
      if (isTerminal(d)) return { abort: { ok: false, code: 'TX_TERMINAL', status: d.status } };
      const ses = openSessionOf(d.signers[d.currentSignerIndex]);
      if (ses) Object.assign(ses, { outcome: 'cancelled', closedAt: now() });
      d.status = TX_STATUS.CANCELLED; d.terminalReason = 'CANCELLED_BY:' + actorUid + (reason ? ':' + String(reason).slice(0, 120) : '');
      return {};
    });
  }

  async function signedAgreement({ tenantId, txId }) {
    const tx = await txStore.get(tenantId, txId);
    if (!tx) return { ok: false, code: 'TX_UNKNOWN' };
    if (!isSigned(tx)) return { ok: false, code: 'NOT_SIGNED' };
    const bytes = await artifactStore.get(tx.finalArtifact.ref, tx.finalArtifact.sha256);
    return { ok: true, bytes, sha256: tx.finalArtifact.sha256 };
  }

  return { initiate, startSession, refresh, onCallback: (a) => refresh(Object.assign({}, a, { source: 'callback' })), cancel, signedAgreement, finalize };
}
