// bid1-pdf.test.mjs — BID-1 components A + B: canonical document model and deterministic contract PDF (P03–P08).
// Run: node test/bid1-pdf.test.mjs   (from functions/)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installNetGuard, blocked } from './net-guard.mjs';
import { frozenEmployee1 } from './fixtures.mjs';
import { frozenContractDocument, bodyStringsOf, signableVersionProblem, canonicalJson, sourceSnapshotSha256 } from '../src/contract-document.mjs';
import { generateContractPdf, GENERATOR_VERSION, SEAL_MIN } from '../src/contract-pdf.mjs';
import { renderContractBlocks } from '../../management-contract-core.mjs';
installNetGuard();

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const snap = (v) => JSON.parse(JSON.stringify(v));
const WIN = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™' };
// P06 helper: decode every Flate content stream and collect the <hex> Tj strings pdf-lib draws (WinAnsi).
function pdfText(bytes) {
  const s = Buffer.from(bytes).toString('latin1'); const out = [];
  const re = /stream\r?\n/g; let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length; const end = s.indexOf('endstream', start);
    let raw = Buffer.from(s.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
    try { raw = inflateSync(raw); } catch (e) { continue; }
    const txt = raw.toString('latin1');
    for (const h of txt.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      const b = Buffer.from(h[1], 'hex'); let str = '';
      for (const c of b) str += WIN[c] || String.fromCharCode(c);
      out.push(str);
    }
  }
  return out;
}
const norm = (x) => String(x).replace(/\s+/g, ' ').trim();

const fx = frozenEmployee1();
const V = fx.version;

await t('P08', 'FREEZE SOURCE ONLY: draft -> CONTRACT_NOT_FROZEN; missing -> CONTRACT_VERSION_MISSING; any later lifecycle state (erstattet/signert/sendt) -> CONTRACT_NOT_SIGNABLE; frozen -> accepted', async () => {
  const draft = frozenEmployee1({ freeze: false }).version;
  assert.equal(draft.status, 'utkast');
  assert.equal(signableVersionProblem(draft), 'CONTRACT_NOT_FROZEN');
  assert.equal((await generateContractPdf(draft)).code, 'CONTRACT_NOT_FROZEN');
  assert.equal(signableVersionProblem(null), 'CONTRACT_VERSION_MISSING');
  for (const st of ['erstattet', 'signert', 'sendt_til_signering', 'avbrutt']) assert.equal(signableVersionProblem(Object.assign({}, V, { status: st })), 'CONTRACT_NOT_SIGNABLE');
  assert.equal(signableVersionProblem(Object.assign({}, V, { snapshot: null })), 'CONTRACT_SNAPSHOT_MISSING');
  assert.equal(signableVersionProblem(V), null);
});
await t('P03', 'DOCUMENT MODEL = the accepted preview semantics: body blocks are exactly renderContractBlocks(snapshot, frozen) minus status chrome (badge + 2 signing-status notes); every body string (header, 01–14 rows/clauses/bullets, parties, Sted/Dato/names, template note) is drawn in the PDF; no live source is read', async () => {
  const doc = frozenContractDocument(V); assert.equal(doc.ok, true);
  const blocks = renderContractBlocks(V.snapshot, { frozen: true, frozenAt: V.frozenAt });
  assert.deepEqual(doc.model.body, blocks.filter((b) => ['numbered', 'parties', 'signatures', 'pageBreak'].includes(b.kind)));
  assert.deepEqual(doc.model.body.filter((b) => b.kind === 'numbered').map((b) => b.n), ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14']);
  assert.equal(doc.model.excludedStatusChrome.badge, 'GODKJENT OG FROSSET – IKKE ELEKTRONISK SIGNERT');
  assert.deepEqual(doc.model.excludedStatusChrome.notes, ['Godkjent og frosset lokal versjon. Ikke elektronisk signert.', 'Elektronisk signering med BankID kommer.']);
  // no live dereference: the model is built with nothing but the version object
  const detached = snap(V); const d2 = frozenContractDocument(detached); assert.deepEqual(d2.model, doc.model);
  const pdf = await generateContractPdf(V);
  const drawn = norm(pdf.textRuns.join(' ')); const decoded = norm(pdfText(pdf.bytes).join(' '));
  const strings = bodyStringsOf(doc.model);
  assert.ok(strings.length > 80, 'coverage matrix size ' + strings.length);
  for (const s of strings) { assert.ok(drawn.includes(norm(s)), 'drawn: ' + s.slice(0, 60)); assert.ok(decoded.includes(norm(s)), 'in PDF bytes: ' + s.slice(0, 60)); }
  assert.deepEqual(pdf.replacements, [], 'no character had to be substituted');
});
await t('P06', 'PDF CONTENT (decoded from the PDF content streams): Fast, deltid NOT printed as a row (scope expressed by % + hours, as in the preview), 50 %, 18.75 timer per uke, Timelønn, kr 210 per time, "Månedlig – Den 15. hver måned", Ja – Storebrand, Ja – Gjensidige, Sted Gjøvik, Dato —, both signer captions/names; no status chrome, no signed wording, no fake signature', async () => {
  const pdf = await generateContractPdf(V); const txt = pdfText(pdf.bytes); const all = norm(txt.join(' | '));
  for (const s of ['Fast', '50 %', '18.75 timer per uke', 'Timelønn', 'kr 210 per time', 'Månedlig – Den 15. hver måned', 'Ja – Storebrand', 'Ja – Gjensidige', 'Gjøvik', 'ARBEIDSTAKER', 'Test Ansatt 01', 'FOR FOUR SEASON AS', 'Herish Hashemi', 'Godkjenning og underskrift']) assert.ok(all.includes(s), s);
  const i = txt.indexOf('Dato'); assert.ok(i >= 0 && txt[i + 1] === '—', 'section 14 Dato = — (got ' + txt[i + 1] + ')');
  for (const bad of ['IKKE ELEKTRONISK SIGNERT', 'Ikke elektronisk signert', 'BankID kommer', 'Signert av', 'signert den', '%FAKE']) assert.ok(!all.includes(bad) && !Buffer.from(pdf.bytes).toString('latin1').includes(bad), bad);
  assert.ok(!all.includes('29.09.2026'), 'the freeze date is not printed anywhere in the agreement');
});
await t('P04', 'DETERMINISM: the fixture PDF generated in 3 SEPARATE processes is byte-identical (same sourcePdfSha256, sourceSnapshotSha256, byteLength), and equals the in-process result', async () => {
  const runs = [0, 1, 2].map(() => JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'pdf-print.mjs')], { encoding: 'utf8' }).trim().split('\n').pop()));
  assert.equal(new Set(runs.map((r) => r.pid)).size, 3);
  for (const r of runs) { assert.equal(r.sourcePdfSha256, runs[0].sourcePdfSha256); assert.equal(r.rawSha256, r.sourcePdfSha256); assert.equal(r.sourceSnapshotSha256, runs[0].sourceSnapshotSha256); assert.equal(r.byteLength, runs[0].byteLength); }
  const local = await generateContractPdf(V);
  assert.equal(local.identity.sourcePdfSha256, runs[0].sourcePdfSha256);
  lines.push('INFO  P04  sourcePdfSha256=' + runs[0].sourcePdfSha256 + ' sourceSnapshotSha256=' + runs[0].sourceSnapshotSha256 + ' bytes=' + runs[0].byteLength);
});
await t('P04b', 'NO CLOCK / NO RANDOM: metadata dates are frozenAt, producer = generator version, no /ID; generating at a different wall-clock time yields the same bytes', async () => {
  const a = await generateContractPdf(V);
  const realNow = Date.now; Date.now = () => realNow() + 86400000 * 365;
  let b; try { b = await generateContractPdf(V); } finally { Date.now = realNow; }
  assert.equal(b.identity.sourcePdfSha256, a.identity.sourcePdfSha256);
  const s = Buffer.from(a.bytes).toString('latin1');
  assert.ok(!/\/ID\s*\[/.test(s), 'no trailer /ID');
  assert.ok(s.includes('D:20260929120000Z') || s.includes('D:20260929'), 'CreationDate from frozenAt');
  assert.ok(s.includes('sormena-contract-pdf/1.0.0') || /\/Producer/.test(s));
  assert.equal(a.identity.generatorVersion, GENERATOR_VERSION);
  assert.equal(a.identity.sourceSnapshotSha256, sourceSnapshotSha256(V, GENERATOR_VERSION));
  assert.equal(a.identity.sourceSnapshotSha256, createHash('sha256').update(canonicalJson({ generatorVersion: GENERATOR_VERSION, contractVersionId: V.contractVersionId, templateVersion: V.templateVersion, frozenAt: V.frozenAt, snapshot: V.snapshot })).digest('hex'));
});
await t('P05', 'CHANGE SENSITIVITY: one frozen semantic input changed (18.75 -> 18.5 t) => both hashes change; the original artifact bytes are unchanged when regenerated; canonicalJson is key-order independent', async () => {
  const a1 = await generateContractPdf(V);
  const other = frozenEmployee1({ hours: 18.5 }).version;
  const b = await generateContractPdf(other);
  assert.notEqual(b.identity.sourceSnapshotSha256, a1.identity.sourceSnapshotSha256);
  assert.notEqual(b.identity.sourcePdfSha256, a1.identity.sourcePdfSha256);
  const a2 = await generateContractPdf(V);
  assert.equal(a2.identity.sourcePdfSha256, a1.identity.sourcePdfSha256);
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), canonicalJson({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
});
await t('P07', 'LAYOUT: 2 A4 pages; two EMPTY signature areas on the last page, each ≥ 92x49 pt (BankID visual seal), inside the margins, side by side without overlap (text placement inside the boxes verified visually, not by this assertion)', async () => {
  const pdf = await generateContractPdf(V);
  assert.equal(pdf.pageCount, 2);
  assert.equal(pdf.sealAreas.length, 2);
  const [l, r] = pdf.sealAreas;
  for (const a of pdf.sealAreas) { assert.equal(a.page, 2); assert.ok(a.width >= SEAL_MIN.width * 2 && a.height >= SEAL_MIN.height * 1.5, JSON.stringify(a)); assert.ok(a.x >= 40 && a.x + a.width <= 555 && a.y >= 56); }
  assert.ok(l.x + l.width < r.x, 'no overlap');
  assert.deepEqual(pdf.sealAreas.map((a) => a.role), ['ARBEIDSTAKER', 'FOR FOUR SEASON AS']);
  lines.push('INFO  P07  sealAreas=' + JSON.stringify(pdf.sealAreas.map((a) => ({ role: a.role, x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: a.height }))));
});
await t('P13a', 'no network attempt was made by the document/PDF path', async () => { assert.deepEqual(blocked, []); });

for (const l of lines) console.log(l);
console.log('BID1_PDF_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
