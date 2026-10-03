// gcs-artifact-store.mjs — BID-2A PRIVATE SIGNING-ARTIFACT STORAGE ADAPTER (Admin SDK / Cloud Storage bucket).
// Same interface as the BID-1 local stores: putOnce(key, bytes, meta) / get(key, expectedSha256).
//   - target-bound: the bucket must be the validated preprod artifact bucket (assertAdapterBinding) BEFORE any write,
//     and every call re-checks the bucket name;
//   - create-only: write precondition ifGenerationMatch = 0 (the object must not exist) — an existing object with the
//     same bytes is "reused", different bytes are ARTIFACT_IMMUTABLE_CONFLICT; nothing is ever overwritten;
//   - server-controlled binding metadata on every object (tenant, employee, contract version, tx, stage, sha256,
//     content type application/pdf); no public URL, no ACL, no signed URL — downloads stay server-mediated (BID-1);
//   - hash-verified reads: object bytes AND the stored sha256 metadata must match the expected hash.
import { createHash } from 'node:crypto';
import { assertAdapterBinding } from './preprod-config.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const err = (code, detail) => Object.assign(new Error(code + (detail ? ': ' + detail : '')), { code });
export const ARTIFACT_STAGES = Object.freeze(['source_unsigned', 'employer_signed', 'final_signed']);
const META_KEYS = ['tenantId', 'ansattId', 'contractVersionId', 'txId', 'stage', 'signerRole', 'sourceSnapshotSha256', 'generatorVersion'];

// Classifies a Cloud Storage write error for the duplicate-create proof (BID-2C §6): the deployed runtime identity has
// NO storage.objects.delete, so a second create of an existing object may surface as 412 (precondition) OR 403 (IAM);
// both are a REFUSAL. Anything else is reported as-is; a success is never a refusal.
const is412 = (e) => e && (e.code === 412 || e.code === '412' || /conditionNotMet|Precondition/i.test(String(e.message)));
const is403 = (e) => e && (e.code === 403 || e.code === '403' || /PERMISSION_DENIED|does not have storage\.objects\.(delete|create)|Forbidden/i.test(String(e.message)));
export function classifyStorageWriteError(e) {
  if (!e) return 'NO_REFUSAL';
  if (e.code === 'ARTIFACT_IMMUTABLE_CONFLICT') return 'ARTIFACT_IMMUTABLE_CONFLICT';
  if (is412(e)) return 'PRECONDITION_FAILED';
  if (is403(e)) return 'PERMISSION_DENIED';
  return 'OTHER:' + String(e.code || e.message || e).slice(0, 60);
}
export const DUPLICATE_REFUSAL_CLASSES = Object.freeze(['ARTIFACT_IMMUTABLE_CONFLICT', 'PRECONDITION_FAILED', 'PERMISSION_DENIED']);

export function createGcsArtifactStore({ bucket, target, mode, env, liveGrant }) {
  if (!bucket || typeof bucket.file !== 'function') throw err('BUCKET_HANDLE_REQUIRED');
  const bound = assertAdapterBinding({ target, bucketName: bucket.name, mode, env, liveGrant });   // fails closed before any write
  const check = () => { if (bucket.name !== bound.bucket) throw err('BUCKET_MISMATCH', bucket.name); };
  return {
    target: bound,
    async putOnce(key, bytes, meta) {
      check();
      const m = meta || {};
      if (!ARTIFACT_STAGES.includes(m.stage)) throw err('ARTIFACT_STAGE_REQUIRED', String(m.stage));
      for (const k of ['tenantId', 'ansattId', 'contractVersionId']) if (typeof m[k] !== 'string' || !m[k]) throw err('ARTIFACT_BINDING_REQUIRED', k);
      if (m.stage !== 'source_unsigned' && (typeof m.txId !== 'string' || !m.txId)) throw err('ARTIFACT_BINDING_REQUIRED', 'txId');
      const buf = Buffer.from(bytes);
      const h = sha(buf);
      const custom = { sha256: h, byteLength: String(buf.length) };
      for (const k of META_KEYS) if (typeof m[k] === 'string' && m[k]) custom[k] = m[k];
      const file = bucket.file(key);
      // Defense in depth: (1) explicit existence check — never overwrite, even where a backend ignores preconditions
      // (the Firebase Storage emulator does NOT enforce ifGenerationMatch, proven in BID-2A); (2) ifGenerationMatch 0 on
      // the write — the atomic guard against a concurrent creator on real Cloud Storage (to be verified in the first
      // real-cloud smoke test).
      const [already] = await file.exists();
      if (already) {
        const [cur] = await file.download();
        if (sha(cur) === h) return { ok: true, sha256: h, byteLength: buf.length, reused: true };
        throw err('ARTIFACT_IMMUTABLE_CONFLICT', key);
      }
      try {
        await file.save(buf, { resumable: false, contentType: 'application/pdf', metadata: { contentType: 'application/pdf', cacheControl: 'private, no-store', metadata: custom }, preconditionOpts: { ifGenerationMatch: 0 } });
        return { ok: true, sha256: h, byteLength: buf.length, reused: false };
      } catch (e) {
        if (!is412(e)) throw e;
        const [cur] = await file.download();
        if (sha(cur) === h) return { ok: true, sha256: h, byteLength: buf.length, reused: true };
        throw err('ARTIFACT_IMMUTABLE_CONFLICT', key);
      }
    },
    async get(key, expectedSha256) {
      check();
      const file = bucket.file(key);
      const [exists] = await file.exists();
      if (!exists) throw err('ARTIFACT_MISSING', key);
      const [md] = await file.getMetadata();
      const [buf] = await file.download();
      const h = sha(buf);
      if (expectedSha256 && (h !== expectedSha256 || (md.metadata && md.metadata.sha256 !== expectedSha256))) throw err('ARTIFACT_HASH_MISMATCH', key);
      return buf;
    },
    async metadataOf(key) { check(); const [md] = await bucket.file(key).getMetadata(); return { contentType: md.contentType, generation: String(md.generation), metageneration: md.metageneration == null ? null : String(md.metageneration), size: md.size == null ? null : String(md.size), md5Hash: md.md5Hash || null, crc32c: md.crc32c || null, metadata: md.metadata || {} }; },
  };
}
