// firestore-stores.mjs — BID-1 Admin-SDK implementations of the server seams (used by the emulator proof; the future
// Cloud Functions runtime would use the same code). Server-only: the Admin SDK bypasses security rules, which is exactly
// why clients are denied every write on these paths in the candidate rules.
//   tenants/{T}/signingTransactions/{txId}      separate signing truth (rev = compare-and-set counter)
//   tenants/{T}/signingLocks/{contractVersionId} { activeTxId } — at most ONE non-terminal transaction per frozen version
//   memberships/{uid}_{T}                       read-only here (authority for role / ansattId)
//   tenants/{T}/ansatte/{ansattId}.e360.contractVersions[]   READ-ONLY here (the frozen version is never written)
import { TERMINAL_TX } from './stores.mjs';
import { assertAdapterBinding } from './preprod-config.mjs';

export function createFirestoreTransactionStore(db) {
  const txRef = (T, id) => db.doc('tenants/' + T + '/signingTransactions/' + id);
  const lockRef = (T, cv) => db.doc('tenants/' + T + '/signingLocks/' + cv);
  const col = (T) => db.collection('tenants/' + T + '/signingTransactions');
  return {
    async createActive(T, cv, build) {
      return db.runTransaction(async (tx) => {
        const lock = await tx.get(lockRef(T, cv));
        if (lock.exists && lock.data().activeTxId) return { ok: false, code: 'ACTIVE_TRANSACTION_EXISTS', txId: lock.data().activeTxId };
        const prior = await tx.get(col(T).where('contractVersionId', '==', cv));
        const t = Object.assign(build(prior.size + 1), { rev: 1 });
        const exists = await tx.get(txRef(T, t.txId));
        if (exists.exists) return { ok: false, code: 'TX_ID_EXISTS', txId: t.txId };
        tx.set(txRef(T, t.txId), t);
        tx.set(lockRef(T, cv), { activeTxId: t.txId, contractVersionId: cv });
        return { ok: true, tx: t };
      });
    },
    async get(T, id) { const s = await txRef(T, id).get(); return s.exists ? s.data() : null; },
    async update(T, id, expectedRev, next) {
      return db.runTransaction(async (tx) => {
        const cur = await tx.get(txRef(T, id));
        if (!cur.exists) return { ok: false, code: 'TX_UNKNOWN' };
        if (cur.data().rev !== expectedRev) return { ok: false, code: 'TX_CONFLICT' };
        const saved = Object.assign(JSON.parse(JSON.stringify(next)), { rev: expectedRev + 1 });
        const lk = await tx.get(lockRef(T, saved.contractVersionId));
        tx.set(txRef(T, id), saved);
        if (TERMINAL_TX.includes(saved.status) && lk.exists && lk.data().activeTxId === id) tx.set(lockRef(T, saved.contractVersionId), { activeTxId: null, contractVersionId: saved.contractVersionId });
        return { ok: true, tx: saved };
      });
    },
    async listForVersion(T, cv) { const q = await col(T).where('contractVersionId', '==', cv).get(); return q.docs.map((d) => d.data()); },
  };
}
export function createFirestoreMemberships(db) {
  return { async get(uid, T) { const s = await db.doc('memberships/' + uid + '_' + T).get(); return s.exists ? s.data() : null; } };
}
export function createFirestoreContracts(db) {
  return {
    async getVersion(T, ansattId, cvid) {
      const s = await db.doc('tenants/' + T + '/ansatte/' + ansattId).get();
      const v = s.exists && s.data().e360 && Array.isArray(s.data().e360.contractVersions) ? s.data().e360.contractVersions.find((x) => x.contractVersionId === cvid) : null;
      return v ? JSON.parse(JSON.stringify(v)) : null;   // a detached copy: nothing downstream can write through it
    },
  };
}

// BID-2A: the production-shaped signing-transaction REPOSITORY. Same collection/paths as BID-1, but it only exists once
// the Admin app + Firestore handle are proven to be the validated preprod target (project id, database id) — checked
// BEFORE any read or write. mode 'emulator' requires a loopback FIRESTORE_EMULATOR_HOST; mode 'live' is refused in BID-2A.
export function createSigningTransactionRepository({ app, db, target, mode, env, liveGrant }) {
  if (!app || !app.options || !db) throw Object.assign(new Error('ADMIN_HANDLES_REQUIRED'), { code: 'ADMIN_HANDLES_REQUIRED' });
  const bound = assertAdapterBinding({ target, appProjectId: app.options.projectId, databaseId: db.databaseId || '(default)', mode, env, liveGrant });
  return Object.assign(createFirestoreTransactionStore(db), { target: bound, paths: { transactions: 'tenants/{tenantId}/signingTransactions/{txId}', locks: 'tenants/{tenantId}/signingLocks/{contractVersionId}' } });
}
