// live-smoke-evidence.mjs — BID-2C local evidence file for a live smoke run: NON-SECRET facts only (run id, timestamps,
// exact target, impersonated service account, Firestore paths, artifact paths + SHA-256 + generations, duplicate-write
// refusal class, step results, network attempts by host, final PASS/FAIL). A deep redaction pass runs over the whole
// document before it is serialised: secret-named keys and secret-shaped values (OAuth tokens, refresh tokens, client
// secrets/ids, JWTs, private keys, 11-digit NIN-shaped numbers) are replaced by "[REDACTED]" and counted — the evidence
// must still be written (it is the audit record) but can never carry a credential.
import fs from 'node:fs';
import path from 'node:path';
import { ADC_SECRET_FIELDS } from './adc-identity.mjs';

export const EVIDENCE_VERSION = 'sormena-live-smoke-evidence/1';
export const SECRET_KEYS = Object.freeze([...ADC_SECRET_FIELDS, 'authorization', 'source_credentials', 'credentials', 'nin', 'pid', 'personnummer']);
export const SECRET_VALUE_PATTERNS = Object.freeze([
  /ya29\.[A-Za-z0-9._-]{20,}/,                 // Google OAuth access token
  /\b1\/\/[A-Za-z0-9._-]{20,}/,                // Google OAuth refresh token
  /GOCSPX-[A-Za-z0-9_-]{10,}/,                 // OAuth client secret
  /\b\d{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com\b/,   // OAuth client id
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,        // key material
  /2\.16\.578\.1\.61\.2\.[34]/,                // BankID PID/NIN OIDs
  /\b\d{11}\b/,                                // NIN-shaped
]);
const isSecretKey = (k) => SECRET_KEYS.includes(String(k).toLowerCase());
const isSecretValue = (v) => typeof v === 'string' && SECRET_VALUE_PATTERNS.some((re) => re.test(v));

export function redactSecrets(value) {
  let count = 0;
  const walk = (v, key) => {
    if (key != null && isSecretKey(key)) { count += 1; return '[REDACTED]'; }
    if (typeof v === 'string') { if (isSecretValue(v)) { count += 1; return '[REDACTED]'; } return v; }
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x, k); return o; }
    return v;
  };
  const out = walk(value, null);
  return { value: out, redactions: count };
}

// Assembles the evidence document from the runner's facts + the smoke result. Nothing here reads credentials.
export function buildEvidence({ runId, releaseId, startedAt, finishedAt, target, serviceAccount, adc, netGuard, result, runner }) {
  const r = result || {};
  const ev = r.evidence || {};
  const steps = (r.steps || []).map((s) => ({ id: s.id, name: s.name, ok: s.ok, detail: s.detail === undefined ? null : s.detail }));
  const k = steps.find((s) => s.id === 'K'), k2 = steps.find((s) => s.id === 'K2');
  return {
    evidenceVersion: EVIDENCE_VERSION, runId, releaseId: releaseId || null, startedAt, finishedAt,
    runner: runner || null, mode: r.mode || null,
    target: target ? { projectId: target.projectId, projectNumber: target.projectNumber, region: target.region, databaseId: target.databaseId, bucket: target.bucket } : null,
    impersonatedServiceAccount: serviceAccount || null,
    adc: adc ? { present: adc.present === true, type: adc.type || null, serviceAccount: adc.serviceAccount || null, path: adc.path || null, code: adc.code || null } : null,
    network: netGuard ? { allowlist: netGuard.allowlist, port: netGuard.port, attempts: netGuard.attempts, blocked: netGuard.blocked } : null,
    refused: r.refused || null, refusedDetail: r.detail || null,
    tenantId: ev.tenantId || null, ansattId: ev.ansattId || null, contractVersionId: ev.contractVersionId || null, txId: ev.txId || null,
    paths: ev.paths || null, sha256: ev.hashes || null, generations: ev.generations || null,
    duplicateWriteRefusal: { adapter: k ? k.detail : null, directPrecondition: k2 ? k2.detail : null },
    steps, final: r.ok === true ? 'PASS' : 'FAIL',
  };
}

export function evidenceFileName(runId, finishedAt) { return runId + '-' + String(finishedAt).replace(/[:.]/g, '-') + '.evidence.json'; }

// Writes the redacted evidence and returns { path, redactions, final }. Never overwrites an existing file (flag 'wx').
export function writeEvidence(dir, evidence, fsImpl) {
  const f = fsImpl || fs;
  const { value, redactions } = redactSecrets(evidence);
  value.redactions = redactions;
  f.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, evidenceFileName(value.runId, value.finishedAt));
  f.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return { path: p, redactions, final: value.final };
}

// ---- ONE-SHOT CONSUMPTION (release -016A): one authorized run id = ONE attempt, enforced in code. -------------------
// The runner calls consumeLiveRun() after every local gate passed and BEFORE the network path exists. The marker
// <dir>/<runId>.consumed.json is created exclusively (flag 'wx' = CREATE_NEW; two racing processes cannot both win) and
// is NEVER removed or rewritten by any code: PASS, FAIL, exception, Ctrl+C, crash or network failure all leave the run
// id consumed forever. A retry needs a new release id AND a new run id. A run id is ALSO consumed when an earlier
// evidence file for it shows the network path was reached (network != null) — that is how the pre-marker run
// smoke-live0001 stays refused without manufacturing a marker for it; an unreadable evidence file fails closed.
// Evidence of a run refused at a local gate (network == null) does not consume. Marker content: non-secret facts only.
export const CONSUMPTION_MARKER_VERSION = 'sormena-live-smoke-consumed/1';
const CONSUMABLE_RUN_ID = /^smoke-[a-z0-9]{4,32}$/;
const consumptionRefused = (code, detail) => Object.assign(new Error(code + (detail ? ': ' + detail : '')), { code, detail: detail || null });
export function consumptionMarkerName(runId) { return runId + '.consumed.json'; }

// Read-only. null = not consumed; otherwise { by: 'marker' | 'evidence', file }.
export function findRunConsumption(dir, runId, fsImpl) {
  const f = fsImpl || fs;
  if (typeof runId !== 'string' || !CONSUMABLE_RUN_ID.test(runId)) throw consumptionRefused('SMOKE_RUN_ID_INVALID', String(runId).slice(0, 40));
  if (!f.existsSync(dir)) return null;
  if (f.existsSync(path.join(dir, consumptionMarkerName(runId)))) return { by: 'marker', file: consumptionMarkerName(runId) };
  for (const name of f.readdirSync(dir).sort()) {
    if (!name.startsWith(runId + '-') || !name.endsWith('.evidence.json')) continue;
    let doc = null;
    try { doc = JSON.parse(f.readFileSync(path.join(dir, name), 'utf8')); } catch (e) { return { by: 'evidence', file: name }; }   // unreadable = fail closed
    if (!doc || typeof doc !== 'object' || doc.runId !== runId || doc.network != null) return { by: 'evidence', file: name };
  }
  return null;
}

// Creates the marker or throws LIVE_SMOKE_RUN_ALREADY_CONSUMED. Returns { path, marker }. Only the five whitelisted
// facts are written, whatever the caller passes.
export function consumeLiveRun(dir, facts, fsImpl) {
  const f = fsImpl || fs;
  const x = facts || {};
  const prior = findRunConsumption(dir, x.runId, f);
  if (prior) throw consumptionRefused('LIVE_SMOKE_RUN_ALREADY_CONSUMED', x.runId + ' already consumed (' + prior.by + ': ' + prior.file + '); a retry needs a new release id and a new run id');
  const marker = { markerVersion: CONSUMPTION_MARKER_VERSION, runId: x.runId, releaseId: String(x.releaseId || ''), startedAt: String(x.startedAt || ''), projectId: String(x.projectId || ''), serviceAccount: String(x.serviceAccount || '') };
  if (redactSecrets(marker).redactions !== 0) throw consumptionRefused('CONSUMPTION_MARKER_SECRET_REFUSED');
  f.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, consumptionMarkerName(x.runId));
  try { f.writeFileSync(p, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx' }); }
  catch (e) { if (e && e.code === 'EEXIST') throw consumptionRefused('LIVE_SMOKE_RUN_ALREADY_CONSUMED', x.runId + ' already consumed (marker: ' + consumptionMarkerName(x.runId) + '); a retry needs a new release id and a new run id'); throw e; }
  return { path: p, marker };
}
