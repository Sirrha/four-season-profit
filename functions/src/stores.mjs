// stores.mjs — BID-1 storage/secret SEAMS (interfaces + local implementations). No live Firebase Storage, no secrets.
//
// TransactionStore (conceptual path tenants/{T}/signingTransactions/{txId}; lock tenants/{T}/signingLocks/{contractVersionId}):
//   createActive(tenantId, contractVersionId, build(attempt) -> tx) -> { ok:true, tx } | { ok:false, code:'ACTIVE_TRANSACTION_EXISTS', txId }
//   get(tenantId, txId) -> tx | null
//   update(tenantId, txId, expectedRev, next) -> { ok:true, tx } | { ok:false, code:'TX_CONFLICT' | 'TX_UNKNOWN' }  (compare-and-set on tx.rev;
//        a terminal next state releases the version lock atomically)
//   listForVersion(tenantId, contractVersionId) -> tx[]
// ArtifactStore (conceptual bucket path tenants/{T}/contracts/{ansattId}/{contractVersionId}/...):
//   putOnce(key, bytes, meta?) -> { ok:true, sha256, byteLength, reused } | throws ARTIFACT_IMMUTABLE_CONFLICT   (create-only;
//        meta = server-controlled binding { stage, tenantId, ansattId, contractVersionId, txId?, signerRole?, ... } — BID-2A)
//   get(key, expectedSha256) -> bytes | throws ARTIFACT_MISSING / ARTIFACT_HASH_MISMATCH                   (verify on read)
// SecretProvider: getBankIdClientCredentials() -> throws in BID-1 (no real secret exists or is read).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const TERMINAL_TX = Object.freeze(['completed', 'rejected', 'cancelled', 'failed']);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));
const err = (code) => Object.assign(new Error(code), { code });

export function createMemoryTransactionStore() {
  const txs = new Map();     // tenantId/txId -> tx
  const locks = new Map();   // tenantId/cvid -> txId
  const k = (a, b) => a + '/' + b;
  return {
    async createActive(tenantId, cvid, build) {
      const held = locks.get(k(tenantId, cvid));
      if (held) return { ok: false, code: 'ACTIVE_TRANSACTION_EXISTS', txId: held };
      const attempt = [...txs.values()].filter((t) => t.tenantId === tenantId && t.contractVersionId === cvid).length + 1;
      const tx = Object.assign(build(attempt), { rev: 1 });
      if (txs.has(k(tenantId, tx.txId))) return { ok: false, code: 'TX_ID_EXISTS', txId: tx.txId };
      txs.set(k(tenantId, tx.txId), clone(tx)); locks.set(k(tenantId, cvid), tx.txId);
      return { ok: true, tx: clone(tx) };
    },
    async get(tenantId, txId) { const t = txs.get(k(tenantId, txId)); return t ? clone(t) : null; },
    async update(tenantId, txId, expectedRev, next) {
      const cur = txs.get(k(tenantId, txId));
      if (!cur) return { ok: false, code: 'TX_UNKNOWN' };
      if (cur.rev !== expectedRev) return { ok: false, code: 'TX_CONFLICT' };
      const saved = Object.assign(clone(next), { rev: expectedRev + 1 });
      txs.set(k(tenantId, txId), saved);
      if (TERMINAL_TX.includes(saved.status) && locks.get(k(tenantId, saved.contractVersionId)) === txId) locks.delete(k(tenantId, saved.contractVersionId));
      return { ok: true, tx: clone(saved) };
    },
    async listForVersion(tenantId, cvid) { return [...txs.values()].filter((t) => t.tenantId === tenantId && t.contractVersionId === cvid).map(clone); },
    _locks: locks,
  };
}

function artifactApi(read, write, exists) {
  const metas = new Map();
  return {
    async putOnce(key, bytes, meta) {
      const buf = Buffer.from(bytes);
      const h = sha(buf);
      if (await exists(key)) {
        const cur = await read(key);
        if (sha(cur) === h) return { ok: true, sha256: h, byteLength: buf.length, reused: true };
        throw err('ARTIFACT_IMMUTABLE_CONFLICT');
      }
      await write(key, buf);
      metas.set(key, Object.assign({ sha256: h, byteLength: String(buf.length), contentType: 'application/pdf' }, meta || {}));
      return { ok: true, sha256: h, byteLength: buf.length, reused: false };
    },
    async metadataOf(key) { const m = metas.get(key); return m ? { contentType: m.contentType, metadata: Object.assign({}, m) } : null; },
    async get(key, expectedSha256) {
      if (!(await exists(key))) throw err('ARTIFACT_MISSING');
      const buf = await read(key);
      if (expectedSha256 && sha(buf) !== expectedSha256) throw err('ARTIFACT_HASH_MISMATCH');
      return buf;
    },
  };
}
export function createMemoryArtifactStore() {
  const m = new Map();
  const api = artifactApi(async (k) => Buffer.from(m.get(k)), async (k, b) => { m.set(k, Buffer.from(b)); }, async (k) => m.has(k));
  api._raw = m;
  return api;
}
// Local filesystem store for proofs (temp directory only; never the app's data).
export function createFsArtifactStore(rootDir) {
  const p = (key) => { const f = path.join(rootDir, ...key.split('/')); if (!f.startsWith(path.resolve(rootDir))) throw err('ARTIFACT_KEY_INVALID'); return f; };
  return artifactApi(async (k) => fs.readFileSync(p(k)), async (k, b) => { fs.mkdirSync(path.dirname(p(k)), { recursive: true }); fs.writeFileSync(p(k), b, { flag: 'wx' }); }, async (k) => fs.existsSync(p(k)));
}

export function createDisabledSecretProvider() {
  return { async getBankIdClientCredentials() { throw err('REAL_SECRETS_DISABLED_IN_BID1'); } };
}
