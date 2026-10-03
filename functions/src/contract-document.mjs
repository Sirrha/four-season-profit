// contract-document.mjs — BID-1 CANONICAL FROZEN-CONTRACT DOCUMENT MODEL (pure; no DOM, no clock, no I/O).
// Governing: SIRRHA-CCODE-SORMENA-BANKID-BID1-SECURE-SIGNING-FOUNDATION-LOCAL-009 (component A).
//
// ONE SEMANTIC SOURCE: the model is built from the SAME pure function the accepted browser preview paints —
// management-contract-core.mjs renderContractBlocks(version.snapshot, { frozen: true }) — so the PDF and the preview
// cannot drift apart. Only the frozen version is accepted, and only its own snapshot is read (never live records).
// The agreement BODY is everything except status chrome: the docHeader badge ("GODKJENT OG FROSSET – IKKE ELEKTRONISK
// SIGNERT") and the signing-status notes are excluded from the signing source, because a document that is about to be
// signed must not print "not signed" — the PAdES signatures carry the signing state. Section 14 Dato stays "—" (-007A).
import { createHash } from 'node:crypto';
import { renderContractBlocks, CONTRACT_STATUS } from '../shared/management-contract-core.mjs';

export const DOCUMENT_MODEL_VERSION = 'sormena-contract-document/1';

// Order-independent, deterministic JSON (sorted keys at every level; JSON semantics for undefined).
export function canonicalJson(v) {
  const norm = (x) => (Array.isArray(x) ? x.map(norm) : x && typeof x === 'object'
    ? Object.keys(x).sort().reduce((o, k) => { if (x[k] !== undefined) o[k] = norm(x[k]); return o; }, {}) : x);
  return JSON.stringify(norm(v === undefined ? null : v));
}
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

// Only an approved/frozen version may become a signing source. Drafts, missing versions and any later lifecycle
// state are refused (conservative: a superseded/erstattet version is never re-sent).
export function signableVersionProblem(version) {
  if (!version || typeof version !== 'object') return 'CONTRACT_VERSION_MISSING';
  if (version.status === CONTRACT_STATUS.DRAFT) return 'CONTRACT_NOT_FROZEN';
  if (version.status !== CONTRACT_STATUS.FROZEN) return 'CONTRACT_NOT_SIGNABLE';
  if (!version.snapshot || typeof version.snapshot !== 'object') return 'CONTRACT_SNAPSHOT_MISSING';
  if (typeof version.contractVersionId !== 'string' || !version.contractVersionId) return 'CONTRACT_VERSION_ID_MISSING';
  if (!Number.isFinite(version.frozenAt)) return 'CONTRACT_FROZEN_AT_MISSING';
  return null;
}

const STATUS_NOTE = (t) => /ikke elektronisk signert|ikke signert|Elektronisk signering med BankID kommer/i.test(t);

export function frozenContractDocument(version) {
  const problem = signableVersionProblem(version);
  if (problem) return { ok: false, code: problem };
  const blocks = renderContractBlocks(version.snapshot, { frozen: true, frozenAt: version.frozenAt });
  const header = blocks.find((b) => b.kind === 'docHeader') || {};
  const footer = blocks.find((b) => b.kind === 'docFooter') || {};
  const notes = blocks.filter((b) => b.kind === 'note').map((b) => b.text);
  const body = blocks.filter((b) => b.kind === 'numbered' || b.kind === 'parties' || b.kind === 'signatures' || b.kind === 'pageBreak');
  return {
    ok: true,
    model: {
      modelVersion: DOCUMENT_MODEL_VERSION,
      identity: {
        contractVersionId: version.contractVersionId, kind: version.kind || null, templateVersion: version.templateVersion || null,
        frozenAt: version.frozenAt, termsPeriodRef: version.termsPeriodRef || null,
      },
      header: { title: header.title, subtitle: header.subtitle, orgLine: header.orgLine, contLine: header.contLine },
      body,
      footer: { line: footer.line, brand: footer.brand },
      provenanceNotes: notes.filter((t) => !STATUS_NOTE(t)),
      excludedStatusChrome: { badge: header.badge || null, notes: notes.filter(STATUS_NOTE) },
    },
  };
}

// Every semantic string of the agreement body (what a reader must find in the PDF). Used by the coverage proof.
export function bodyStringsOf(model) {
  const out = [model.header.title, model.header.subtitle, model.header.orgLine, model.footer.brand];
  for (const b of model.body) {
    if (b.kind === 'numbered') {
      out.push(b.n, b.title);
      for (const r of b.rows || []) out.push(r[0], r[1]);
      if (b.text) out.push(b.text);
      for (const li of b.bullets || []) out.push(li);
    } else if (b.kind === 'parties') {
      for (const r of b.employer.concat(b.employee)) out.push(r[0], r[1]);
    } else if (b.kind === 'signatures') {
      out.push(b.place, b.date, b.left.caption, b.left.name, b.right.caption, b.right.name);
    }
  }
  for (const t of model.provenanceNotes) out.push(t);
  return out.filter((s) => typeof s === 'string' && s !== '');
}

// sourceSnapshotSha256 binds the source artifact to the frozen snapshot + template + generator identity.
export function sourceSnapshotSha256(version, generatorVersion) {
  return sha256Hex(canonicalJson({
    generatorVersion, contractVersionId: version.contractVersionId, templateVersion: version.templateVersion || null,
    frozenAt: version.frozenAt, snapshot: version.snapshot,
  }));
}
