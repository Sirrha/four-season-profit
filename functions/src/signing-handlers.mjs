// signing-handlers.mjs — BID-1 component F: SERVER / CAPABILITY BOUNDARY (transport-agnostic; the Cloud Functions 2nd gen
// entry in ../index.mjs only adapts HTTP to these handlers). Every handler resolves the caller from a verified Firebase ID
// token + the tenant membership document; the browser is never trusted for identity, role or ansattId.
//   initiateSigning      admin (accessEnabled) of the tenant
//   startSignerSession   employer step: ONLY the designated employer signer uid (an admin) — not "any admin"
//                        employee step: ONLY a member whose membership.ansattId === tx.ansattId
//   refreshSigningStatus admin or a participant of the transaction
//   bankidReturn         public (redirectUrl / silent callback): trusts NOTHING in the request; only triggers an
//                        authoritative server-side refresh, then redirects the browser (or 204 for a silent call)
//   getMySigningStatus   the employee's minimal projection (never the admin transaction record)
//   getTransaction       admin only (full record; it contains no secret, token, NIN or PID)
//   getSignedAgreement   admin or the employee of that contract; server-mediated, hash-verified bytes; only when signed
//   cancelSigning        admin only (application-level; BankID has no cancel endpoint)
import { isSigned } from './signing-service.mjs';

const res = (status, body) => ({ status, body });
export function createSigningHandlers({ auth, memberships, contracts, service, txStore, config }) {
  const cfg = config || {};
  async function caller(idToken, tenantId) {
    if (typeof idToken !== 'string' || !idToken) return { error: res(401, { code: 'UNAUTHENTICATED' }) };
    let decoded;
    try { decoded = await auth.verifyIdToken(idToken); } catch (e) { return { error: res(401, { code: 'INVALID_ID_TOKEN' }) }; }
    const m = await memberships.get(decoded.uid, tenantId);
    if (!m || m.uid !== decoded.uid || m.tenantId !== tenantId || m.accessEnabled !== true) return { error: res(403, { code: 'NOT_A_MEMBER' }) };
    return { uid: decoded.uid, m, isAdmin: m.accessRole === 'admin', ansattId: typeof m.ansattId === 'string' && m.ansattId ? m.ansattId : null };
  }
  const projection = (tx, c) => {
    const mine = tx.signers.find((s) => (s.role === 'employer' && s.expectedUid === c.uid) || (s.role === 'employee' && s.expectedAnsattId === c.ansattId));
    return { txId: tx.txId, contractVersionId: tx.contractVersionId, status: tx.status, signed: isSigned(tx),
      mySigner: mine ? { role: mine.role, status: mine.status } : null,
      canStart: !!(mine && mine.index === tx.currentSignerIndex && ['awaiting_signer', 'signing_session'].includes(tx.status)) };
  };
  const participant = (tx, c) => c.uid === tx.employerSignerUid || (c.ansattId && c.ansattId === tx.ansattId && ['employee', 'admin'].includes(c.m.accessRole));

  return {
    async initiateSigning({ idToken, tenantId, ansattId, contractVersionId }) {
      const c = await caller(idToken, tenantId); if (c.error) return c.error;
      if (!c.isAdmin) return res(403, { code: 'ADMIN_REQUIRED' });
      const version = await contracts.getVersion(tenantId, ansattId, contractVersionId);
      if (!version) return res(404, { code: 'CONTRACT_VERSION_MISSING' });
      const r = await service.initiate({ tenantId, ansattId, version, employerSigner: cfg.employerSigner, actorUid: c.uid });
      return r.ok ? res(201, { txId: r.tx.txId, status: r.tx.status, source: r.tx.source }) : res(r.code === 'ACTIVE_TRANSACTION_EXISTS' ? 409 : 422, r);
    },
    async startSignerSession({ idToken, tenantId, txId }) {
      const c = await caller(idToken, tenantId); if (c.error) return c.error;
      const tx = await txStore.get(tenantId, txId); if (!tx) return res(404, { code: 'TX_UNKNOWN' });
      const s = tx.signers[tx.currentSignerIndex];
      if (s.role === 'employer' && !(c.isAdmin && c.uid === tx.employerSignerUid && c.uid === s.expectedUid)) return res(403, { code: 'NOT_DESIGNATED_EMPLOYER_SIGNER' });
      if (s.role === 'employee' && !(c.ansattId && c.ansattId === s.expectedAnsattId && ['employee', 'admin'].includes(c.m.accessRole))) return res(403, { code: 'NOT_THIS_EMPLOYEE' });
      const r = await service.startSession({ tenantId, txId });
      return r.ok ? res(200, { signId: r.signId, url: r.url, reused: !!r.reused, signerIndex: r.signerIndex }) : res(409, r);
    },
    async refreshSigningStatus({ idToken, tenantId, txId }) {
      const c = await caller(idToken, tenantId); if (c.error) return c.error;
      const tx = await txStore.get(tenantId, txId); if (!tx) return res(404, { code: 'TX_UNKNOWN' });
      if (!c.isAdmin && !participant(tx, c)) return res(403, { code: 'NOT_A_PARTICIPANT' });
      await service.refresh({ tenantId, txId });
      const after = await txStore.get(tenantId, txId);
      return res(200, c.isAdmin ? { status: after.status } : projection(after, c));
    },
    async bankidReturn({ query, silent }) {
      const q = query || {};
      if (typeof q.tenant === 'string' && typeof q.tx === 'string' && await txStore.get(q.tenant, q.tx)) await service.onCallback({ tenantId: q.tenant, txId: q.tx });
      return silent ? res(204, null) : res(302, { location: cfg.appUrl || '/' });   // nothing from the request is echoed or trusted
    },
    async getMySigningStatus({ idToken, tenantId, txId }) {
      const c = await caller(idToken, tenantId); if (c.error) return c.error;
      const tx = await txStore.get(tenantId, txId); if (!tx) return res(404, { code: 'TX_UNKNOWN' });
      if (!participant(tx, c)) return res(403, { code: 'NOT_A_PARTICIPANT' });
      return res(200, projection(tx, c));
    },
    async getTransaction({ idToken, tenantId, txId }) {
      const c = await caller(idToken, tenantId); if (c.error) return c.error;
      if (!c.isAdmin) return res(403, { code: 'ADMIN_REQUIRED' });
      const tx = await txStore.get(tenantId, txId); return tx ? res(200, tx) : res(404, { code: 'TX_UNKNOWN' });
    },
    async getSignedAgreement({ idToken, tenantId, txId }) {
      const c = await caller(idToken, tenantId); if (c.error) return c.error;
      const tx = await txStore.get(tenantId, txId); if (!tx) return res(404, { code: 'TX_UNKNOWN' });
      if (!(c.isAdmin || (c.ansattId && c.ansattId === tx.ansattId))) return res(403, { code: 'NOT_ALLOWED' });
      const r = await service.signedAgreement({ tenantId, txId });
      return r.ok ? res(200, { contentType: 'application/pdf', sha256: r.sha256, bytes: r.bytes }) : res(409, r);
    },
    async cancelSigning({ idToken, tenantId, txId, reason }) {
      const c = await caller(idToken, tenantId); if (c.error) return c.error;
      if (!c.isAdmin) return res(403, { code: 'ADMIN_REQUIRED' });
      const r = await service.cancel({ tenantId, txId, actorUid: c.uid, reason });
      return r.ok ? res(200, { status: r.tx.status }) : res(409, r);
    },
  };
}
