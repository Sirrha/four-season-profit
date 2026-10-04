// management-contract-private-fields.test.mjs — release 019B-R2: Fødselsnummer / Kontonummer as OPTIONAL fields of the
// contract draft itself (step 1), prefilled once from the employee's private master data, edited / cleared per agreement,
// frozen only when non-empty. Node built-ins only; a FAKE injected datastore. Every value in this file is obviously
// synthetic (an impossible birth date, an all-pattern account). Browser behaviour (the step-1 inputs, preview, print) is
// proven in the scratch headless harness (pb-proofs.mjs).
// Run: node management-contract-private-fields.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_STATUS, CONTRACT_KINDS, TEMPLATE_FIELDS, FUTURE_SECURE_FIELDS, OPTIONAL_PRIVATE_FIELDS, privateFieldsOf, formatContractPrivateField,
  contractInputsFor, contractReadinessOf, renderContractBlocks, blocksForVersion, applyContractOperation,
} from './management-contract-core.mjs';
import { createManagementAdapters, normalizeAnsatt, E360_KEY } from './management-production-adapters.mjs';
import { ADAPTER_ERROR } from './employee-production-adapters.mjs';
import { ETR2A_POLICY as POLICY } from './employee-shell-core.mjs';
import { vaktplanPeopleFrom, missingInfoOf, employeesOf } from './management-employees-core.mjs';
import { projectEmployeeSelf, validateEmployeeSelfDoc } from './employee-self-projection.mjs';
import { FOUR_SEASON_CONTRACT_PROFILE } from './employee-schedule-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }

// SYNTHETIC values only.
const PNR = '99999912345', PNR2 = '99999954321';
const KTO = '00001122334', KTO2 = '00009988776';
const PNR_DOC = '999999 12345', PNR2_DOC = '999999 54321', KTO_DOC = '0000.11.22334', KTO2_DOC = '0000.99.88776';
const ALL = [PNR, PNR2, KTO, KTO2, PNR_DOC, PNR2_DOC, KTO_DOC, KTO2_DOC, '12345', '54321', '22334', '88776'];
const hasAny = (s, list) => (list || ALL).some((v) => String(s).includes(v));
const sha = (s) => createHash('sha256').update(s).digest('hex');

const T = 'four-season-as';
const ADM = { uid: 'uid-admin-1', tenantId: T, accessRole: 'admin', ansattId: 'Ij7AmknF9ZDAdWgwQGJi', accessEnabled: true };
const A1 = 'Kx9mQ2vT7pLa4RcW1nZb';
const RANGE = { from: '2026-09-01', to: '2026-10-31' };
const DAY = '2026-10-04';
function makeFakeFs() {
  const docs = new Map(); const writes = [];
  const colOf = (p) => p.split('/').slice(0, -1).join('/'); const idOf = (p) => p.split('/').pop();
  const apply = (w) => { for (const [kind, p, d] of w) { writes.push({ kind, path: p, data: JSON.parse(JSON.stringify(d)) }); if (kind === 'set') docs.set(p, JSON.parse(JSON.stringify(d))); else { if (!docs.has(p)) throw Object.assign(new Error('not-found'), { code: 'not-found' }); docs.set(p, Object.assign({}, docs.get(p), JSON.parse(JSON.stringify(d)))); } } };
  const api = {
    doc: (p) => ({ path: p }), serverTimestamp: () => ({ __st: true }), newId: () => 'AuToId00000000000001',
    listen: () => () => {},
    runTransaction: async (fn) => { const w = []; const tx = { get: async (ref) => ({ exists: docs.has(ref.path), data: docs.get(ref.path) }), set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]) }; const r = await fn(tx); apply(w); return r; },
    batch: () => { const w = []; return { set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]), commit: async () => { apply(w); } }; },
  };
  const readAnsatte = () => { const out = []; for (const [p, d] of docs) if (colOf(p) === 'tenants/' + T + '/ansatte') out.push(Object.assign({ id: idOf(p) }, d)); return out; };
  return { api, docs, writes, readAnsatte, seed: (p, d) => docs.set(p, JSON.parse(JSON.stringify(d))) };
}
const E360 = () => ({ name: 'Test Ansatt 01', status: 'active', startDate: '2026-08-01', contact: { email: null, phone: '40000000', address: { street: 'Testveien 1', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1995-04-12' }, terms: [{ validFrom: '2026-08-01', role: 'butikkmedarbeider', employmentType: 'deltid', employmentForm: 'fast', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 210 }, workplace: 'Four Season Gjøvik', expectedWeeklyHours: 18.75, workingTimeArrangement: 'Arbeidstid etter vaktplan', probation: 'ingen', noticePeriod: '1 måned', breaksArrangement: '30', scheduleChangeHandling: 'Varsles 14 dager før', paymentInterval: 'manedlig' }], documents: [], contractVersions: [], rev: 3 });
const PROFILE = () => { const p = JSON.parse(JSON.stringify(FOUR_SEASON_CONTRACT_PROFILE)); p.companyFacts = { salaryPaymentArrangement: 'Den 15. hver måned', pension: { applies: true, provider: 'Testpensjon' }, occupationalInjuryInsurance: { applies: true, insurer: 'Testforsikring' }, tariffavtale: { applies: false, agreementName: null, parties: null } }; return p; };
const legacyDoc = (over) => Object.assign({ navn: 'Test Ansatt 01', stilling: 'butikkmedarbeider', timelonn: 210, adresse: 'Testveien 1, 2815 Gjøvik', epost: 'test01@example.test', bankkonto: '', personnummer: '', notater: 'n', aktiv: true, opprettet: '2026-09-01T08:00:00.000Z', [E360_KEY]: E360() }, over || {});
const P = (id) => 'tenants/' + T + '/ansatte/' + id;
const X = { onDate: DAY, roleLabels: {} };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const ser = (e) => [e && e.message, e && e.code, e && e.detail, e && e.stack, JSON.stringify(e), JSON.stringify(e && e.coreResult), String(e)].join(' | ');
const mount = (F) => createManagementAdapters({ fs: F.api, tenantId: T, membership: ADM, range: RANGE, readAnsatte: F.readAnsatte, defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: POLICY });
async function world(priv, existing) {
  const F = existing || makeFakeFs();
  if (!existing) { F.seed(P(A1), legacyDoc(priv || {})); F.seed('tenants/' + T + '/_meta/contractProfile', PROFILE()); }
  const M = mount(F); M.start(); await M.contractProfile.load();
  const emp = () => M.employees.store()[T][A1];
  const op = (o) => M.employees.applyContract(Object.assign({ ansattId: A1 }, o), M.contractProfile.get(), X);
  const draft = () => emp().contractVersions.find((v) => v.status === CONTRACT_STATUS.DRAFT);
  const setFields = (fields) => op({ kind: 'setPrivateFields', contractVersionId: draft().contractVersionId, fields });
  const reviewed = () => JSON.parse(JSON.stringify(contractInputsFor({ employee: emp(), profile: M.contractProfile.get(), onDate: DAY, roleLabels: {} })));
  const freeze = (expected) => op({ kind: 'freezeVersion', contractVersionId: draft().contractVersionId, expectedInputs: expected || reviewed() });
  const versions = () => F.docs.get(P(A1))[E360_KEY].contractVersions;
  return { F, M, emp, op, draft, setFields, reviewed, freeze, versions, stored: () => F.docs.get(P(A1)) };
}
const rowsOf = (blocks) => ({ party: blocks.find((b) => b.kind === 'parties').employee, pay: blocks.find((b) => b.n === '06').rows });
const partyHas = (blocks) => rowsOf(blocks).party.some((r) => r[0] === 'Fødselsnummer');
const payHas = (blocks) => rowsOf(blocks).pay.some((r) => r[0] === 'Bankkonto for lønnsutbetaling');
// In-memory core world (no adapter) for pure-core cases.
function coreWorld() {
  const emp = normalizeAnsatt(A1, legacyDoc());
  const store = { [T]: { [A1]: emp } };
  const actor = { accessEnabled: true, canEditEmployment: true };
  const run = (op, privateValues, extra) => applyContractOperation(Object.assign({ store, tenantId: T, actor, op: Object.assign({ ansattId: A1 }, op), profile: PROFILE(), now: 1000, onDate: DAY, roleLabels: {}, privateValues }, extra || {}));
  const blocks = () => blocksForVersion(null, { employee: store[T][A1], profile: PROFILE(), onDate: DAY, roleLabels: {} });
  return { store, emp: () => store[T][A1], run, blocks };
}
// sha256 of JSON.stringify({ inputs, blocks }) for THIS fixture, produced by the accepted core BEFORE the private contract
// fields existed (commit 451d253).
const GOLDEN_BLANK = '2a4d7b7eb0d995660096d65069b9c305e907a8a0fdff8766108048a1be74c254';
const goldenOf = (emp) => { const inputs = contractInputsFor({ employee: emp, profile: PROFILE(), onDate: DAY, roleLabels: {} }); return sha(JSON.stringify({ inputs, blocks: renderContractBlocks(inputs, {}) })); };

await t('CP01', 'the formerly inactive mechanism is the one activated: FUTURE_SECURE_FIELDS no longer declares fodselsnummer / bankAccount as collectible:false; OPTIONAL_PRIVATE_FIELDS declares exactly the two as optional contract fields with their prefill source; neither is a TEMPLATE field nor part of readiness (an agreement is complete without them)', () => {
  assert.deepEqual(FUTURE_SECURE_FIELDS.map((f) => f.key), ['taxCard']);
  assert.deepEqual(OPTIONAL_PRIVATE_FIELDS.map((f) => [f.key, f.secure, f.collectible, f.optional, f.prefillFrom]), [['fodselsnummer', true, true, true, 'personnummer'], ['bankkonto', true, true, true, 'bankkonto']]);
  assert.ok(!TEMPLATE_FIELDS.some((f) => /fodselsnummer|bankkonto|personnummer|bankAccount/i.test(f.key)));
  const W = coreWorld(); W.run({ kind: 'startDraft' });
  const a = contractReadinessOf(contractInputsFor({ employee: W.emp(), profile: PROFILE(), onDate: DAY, roleLabels: {} }));
  assert.equal(a.ready, true); assert.equal(a.total, TEMPLATE_FIELDS.filter((f) => !f.requiredWhen).length);
  assert.equal(formatContractPrivateField('fodselsnummer', PNR), PNR_DOC); assert.equal(formatContractPrivateField('bankkonto', KTO), KTO_DOC);
  assert.equal(formatContractPrivateField('fodselsnummer', undefined), ''); assert.equal(formatContractPrivateField('bankkonto', '123'), ''); assert.equal(formatContractPrivateField('navn', PNR), '');
});
await t('CP02', 'B/C. PREFILL at creation only: a new contract version takes each VALID Employee 360 value (personnummer -> Fødselsnummer, bankkonto -> Kontonummer, dotted legacy account normalised) into the draft\'s own privateFields; a missing or irregular master value leaves that field blank; with neither the draft has no privateFields key at all; the master document is not written', async () => {
  const cases = [
    [{ personnummer: PNR, bankkonto: KTO_DOC }, { fodselsnummer: PNR, bankkonto: KTO }],
    [{ personnummer: PNR }, { fodselsnummer: PNR }],
    [{ bankkonto: '0000 11 22334' }, { bankkonto: KTO }],
    [{ personnummer: '9999991234', bankkonto: 'IBAN NO93 8601' }, {}],
    [{}, {}],
  ];
  for (const [priv, want] of cases) {
    const W = await world(priv); const r = await W.op({ kind: 'startDraft' });
    assert.equal(r.ok, true); assert.deepEqual(privateFieldsOf(W.draft()), want);
    const stored = W.versions()[0];
    if (Object.keys(want).length) assert.deepEqual(stored.privateFields, want); else assert.ok(!('privateFields' in stored));
    for (const w of W.F.writes) assert.ok(!('personnummer' in w.data) && !('bankkonto' in w.data));
    assert.equal(W.stored().personnummer, priv.personnummer || ''); assert.equal(W.stored().bankkonto, priv.bankkonto || '');
    W.M.dispose();
  }
  const C = coreWorld(); assert.ok(!('privateFields' in C.run({ kind: 'startDraft' }).version), 'no supplied values -> blank fields');
  const C2 = coreWorld(); assert.deepEqual(C2.run({ kind: 'startDraft' }, { fodselsnummer: '123', bankkonto: KTO, navn: 'x' }).version.privateFields, { bankkonto: KTO });
});
await t('CP03', 'D/E/F/R. the contract fields are editable per draft: typed text is normalised to 11 digits (spaces for both, dots for the account); a blank value CLEARS the field; a non-empty value must be exactly 11 digits (PERSONNUMMER_INVALID / BANKKONTO_INVALID naming the field, never the text); each field is independent; a value can be typed where the employee has none', () => {
  const W = coreWorld(); const d = W.run({ kind: 'startDraft' }).version.contractVersionId;
  const set = (fields) => W.run({ kind: 'setPrivateFields', contractVersionId: d, fields });
  assert.equal(set({ fodselsnummer: ' 999999 12345 ' }).ok, true); assert.deepEqual(privateFieldsOf(W.emp().contractVersions[0]), { fodselsnummer: PNR });
  assert.equal(set({ bankkonto: '0000.11.22334' }).ok, true); assert.deepEqual(W.emp().contractVersions[0].privateFields, { fodselsnummer: PNR, bankkonto: KTO });
  assert.equal(set({ bankkonto: '0000 99 88776' }).ok, true); assert.equal(W.emp().contractVersions[0].privateFields.bankkonto, KTO2);
  for (const bad of ['9999991234', '999999123456', '99999912 34x', '999999.12345', 'abcdefghijk']) { const r = set({ fodselsnummer: bad }); assert.deepEqual(r, { ok: false, code: 'PERSONNUMMER_INVALID', field: 'fodselsnummer' }, bad); assert.ok(!JSON.stringify(r).includes(bad)); }
  for (const bad of ['0000112233', '000011223344', '0000-11-22334', 'NO9386011117947', 1122334, {}, true]) assert.deepEqual(set({ bankkonto: bad }), { ok: false, code: 'BANKKONTO_INVALID', field: 'bankkonto' }, String(bad));
  assert.deepEqual(W.emp().contractVersions[0].privateFields, { fodselsnummer: PNR, bankkonto: KTO2 }, 'refusals change nothing');
  // one invalid field refuses the whole operation (nothing half-saved)
  assert.equal(set({ fodselsnummer: PNR2, bankkonto: '12' }).code, 'BANKKONTO_INVALID'); assert.equal(W.emp().contractVersions[0].privateFields.fodselsnummer, PNR);
  for (const blank of ['', '   ', null, undefined]) { assert.equal(set({ fodselsnummer: PNR }).ok, true); assert.equal(set({ fodselsnummer: blank }).ok, true); assert.deepEqual(W.emp().contractVersions[0].privateFields, { bankkonto: KTO2 }); }
  assert.equal(set({ bankkonto: '' }).ok, true); assert.ok(!('privateFields' in W.emp().contractVersions[0]), 'both blank -> the key is gone');
  assert.equal(set({ fodselsnummer: '', bankkonto: '' }).ok, true, 'clearing an already blank draft is fine');
});
await t('CP04', 'setPrivateFields shape and targeting: only the two known keys, on the named DRAFT version; unknown key / empty / non-object / missing or foreign version id / no draft / unauthorised actor refused; no refusal carries a value', () => {
  const W = coreWorld();
  assert.equal(W.run({ kind: 'setPrivateFields', contractVersionId: 'kv-x-1', fields: { bankkonto: KTO } }).code, 'VERSION_UNKNOWN');
  const d = W.run({ kind: 'startDraft' }).version.contractVersionId;
  const outs = [];
  for (const bad of [null, {}, [], 'x', { taxCard: '1' }, { fodselsnummer: PNR, navn: 'x' }]) { const r = W.run({ kind: 'setPrivateFields', contractVersionId: d, fields: bad }); assert.deepEqual(r, { ok: false, code: 'PRIVATE_FIELDS_INVALID' }); outs.push(JSON.stringify(r)); }
  assert.equal(W.run({ kind: 'setPrivateFields', fields: { bankkonto: KTO } }).code, 'VERSION_UNKNOWN');
  assert.equal(W.run({ kind: 'setPrivateFields', contractVersionId: 'kv-other-9', fields: { bankkonto: KTO } }).code, 'VERSION_UNKNOWN');
  const na = applyContractOperation({ store: W.store, tenantId: T, actor: { accessEnabled: true, canEditEmployment: false }, op: { kind: 'setPrivateFields', ansattId: A1, contractVersionId: d, fields: { bankkonto: KTO } }, profile: PROFILE(), now: 1 });
  assert.equal(na.code, 'NOT_AUTHORIZED'); outs.push(JSON.stringify(na));
  for (const o of outs) assert.ok(!hasAny(o));
  assert.ok(!('privateFields' in W.emp().contractVersions[0]));
});
await t('CP05', 'G/H/I + placement. blank = omitted, non-empty = rendered: Fødselsnummer -> ONE line on the employee side of 01 Partene directly after Fødselsdato ("Fødselsnummer", "999999 12345"); Kontonummer -> ONE row in 06 Lønn og godtgjørelser directly after Utbetaling ("Bankkonto for lønnsutbetaling", "0000.11.22334"); each alone, both, neither; every other block is identical to the blank agreement', () => {
  const W = coreWorld(); const d = W.run({ kind: 'startDraft' }).version.contractVersionId;
  const withFields = (fields) => { W.run({ kind: 'setPrivateFields', contractVersionId: d, fields }); return W.blocks(); };
  const none = withFields({ fodselsnummer: '', bankkonto: '' });
  assert.ok(!partyHas(none) && !payHas(none) && !hasAny(JSON.stringify(none)));
  const f = withFields({ fodselsnummer: PNR, bankkonto: '' });
  assert.deepEqual(rowsOf(f).party.map((r) => r[0]), ['Navn', 'Fødselsdato', 'Fødselsnummer', 'Adresse', 'Telefon', 'E-post']);
  assert.deepEqual(rowsOf(f).party[2], ['Fødselsnummer', PNR_DOC]); assert.ok(!payHas(f)); assert.ok(!hasAny(JSON.stringify(f), [KTO, KTO_DOC, '22334']));
  const b = withFields({ fodselsnummer: '', bankkonto: KTO });
  assert.deepEqual(rowsOf(b).pay.map((r) => r[0]), ['Lønnsform', 'Lønn ved tiltredelse', 'Utbetaling', 'Bankkonto for lønnsutbetaling', 'Faste tillegg']);
  assert.deepEqual(rowsOf(b).pay[3], ['Bankkonto for lønnsutbetaling', KTO_DOC]); assert.ok(!partyHas(b)); assert.ok(!hasAny(JSON.stringify(b), [PNR, PNR_DOC, '12345']));
  const both = withFields({ fodselsnummer: PNR, bankkonto: KTO });
  assert.ok(partyHas(both) && payHas(both));
  const strip = (bl) => JSON.stringify(bl.map((x) => (x.kind === 'parties' ? Object.assign({}, x, { employee: x.employee.filter((r) => r[0] !== 'Fødselsnummer') }) : x.n === '06' ? Object.assign({}, x, { rows: x.rows.filter((r) => r[0] !== 'Bankkonto for lønnsutbetaling') }) : x)));
  for (const v of [f, b, both]) assert.equal(strip(v), JSON.stringify(none));
});
await t('CP06', 'V. blank/blank is BYTE-IDENTICAL to the accepted contract output: for the same employee + profile the inputs and rendered blocks hash to the value produced by the core before these fields existed — with no draft, with a blank draft, with a draft prefilled and then cleared; and a blank draft freezes to a version with exactly the old key set and a snapshot without privateFields', async () => {
  const C = coreWorld();
  assert.equal(goldenOf(C.emp()), GOLDEN_BLANK, 'no draft');
  const d = C.run({ kind: 'startDraft' }).version.contractVersionId;
  assert.equal(goldenOf(C.emp()), GOLDEN_BLANK, 'blank draft');
  C.run({ kind: 'setPrivateFields', contractVersionId: d, fields: { fodselsnummer: PNR, bankkonto: KTO } });
  assert.notEqual(goldenOf(C.emp()), GOLDEN_BLANK);
  C.run({ kind: 'setPrivateFields', contractVersionId: d, fields: { fodselsnummer: '', bankkonto: '' } });
  assert.equal(goldenOf(C.emp()), GOLDEN_BLANK, 'filled then cleared');
  const W = await world({ personnummer: PNR, bankkonto: KTO }); await W.op({ kind: 'startDraft' });
  await W.setFields({ fodselsnummer: '', bankkonto: '' });
  assert.equal((await W.freeze()).ok, true);
  const v = W.versions()[0];
  assert.deepEqual(Object.keys(v).sort(), ['contractVersionId', 'createdAt', 'frozenAt', 'kind', 'signedArtifactMeta', 'signingTransaction', 'snapshot', 'status', 'supersededBy', 'supersedes', 'templateVersion', 'termsPeriodRef']);
  assert.ok(!('privateFields' in v.snapshot)); assert.ok(!hasAny(JSON.stringify(W.stored()[E360_KEY]))); assert.ok(!/privateFields|personnummer|bankkonto|fodselsnummer/.test(JSON.stringify(W.stored()[E360_KEY])));
  W.M.dispose();
});
await t('CP07', 'J. contract-only editing: changing or clearing the draft\'s Fødselsnummer / Kontonummer writes ONLY the e360 block of the employee document — never the master fields personnummer / bankkonto, which keep their values; the Employee 360 private card (masked projection) is unchanged', async () => {
  const W = await world({ personnummer: PNR, bankkonto: KTO }); await W.op({ kind: 'startDraft' });
  const maskBefore = JSON.stringify(W.M.employees.privateFields.masked(A1));
  await W.setFields({ fodselsnummer: PNR2, bankkonto: KTO2_DOC });
  assert.deepEqual(W.versions()[0].privateFields, { fodselsnummer: PNR2, bankkonto: KTO2 });
  await W.setFields({ bankkonto: '' });
  assert.deepEqual(W.versions()[0].privateFields, { fodselsnummer: PNR2 });
  for (const w of W.F.writes) { assert.equal(w.kind, 'update'); assert.deepEqual(Object.keys(w.data), [E360_KEY]); }
  assert.equal(W.stored().personnummer, PNR); assert.equal(W.stored().bankkonto, KTO);
  assert.equal(JSON.stringify(W.M.employees.privateFields.masked(A1)), maskBefore);
  assert.deepEqual(await W.M.employees.privateFields.read(A1), { personnummer: PNR, bankkonto: KTO });
  W.M.dispose();
});
await t('CP08', 'K/L. draft persistence: the entered values are part of the saved draft — a fresh adapter over the same datastore (close + reopen) restores exactly them; a later Employee 360 change does NOT overwrite the existing draft (no re-prefill), neither on reopen nor on any later contract operation; the draft preview keeps showing the draft values', async () => {
  const W = await world({ personnummer: PNR, bankkonto: KTO }); await W.op({ kind: 'startDraft' });
  await W.setFields({ fodselsnummer: PNR2, bankkonto: '' });
  W.M.dispose();
  const W2 = await world(null, W.F);
  assert.deepEqual(privateFieldsOf(W2.draft()), { fodselsnummer: PNR2 });
  await W2.M.employees.privateFields.update(A1, { personnummer: PNR, bankkonto: KTO2 }); W2.M.employees.refresh();
  assert.deepEqual(privateFieldsOf(W2.draft()), { fodselsnummer: PNR2 }, 'master change leaves the draft alone');
  const again = await rejects(W2.op({ kind: 'startDraft' })); assert.equal(again.coreResult.code, 'DRAFT_EXISTS');
  await W2.setFields({ bankkonto: KTO });
  assert.deepEqual(W2.versions()[0].privateFields, { fodselsnummer: PNR2, bankkonto: KTO });
  const blocks = blocksForVersion(null, { employee: W2.emp(), profile: W2.M.contractProfile.get(), onDate: DAY, roleLabels: {} });
  assert.deepEqual(rowsOf(blocks).party[2], ['Fødselsnummer', PNR2_DOC]); assert.deepEqual(rowsOf(blocks).pay[3], ['Bankkonto for lønnsutbetaling', KTO_DOC]);
  assert.equal(W2.stored().bankkonto, KTO2, 'and the master keeps ITS value');
  W2.M.dispose();
});
await t('CP09', 'N/O. review vs freeze: the freeze stores EXACTLY the reviewed draft values; if the draft\'s Fødselsnummer or Kontonummer changes after the review the freeze is refused PRIVATE_FIELDS_CHANGED (draft stays, nothing written, no value in the refusal); a non-private drift keeps CONTRACT_INPUTS_CHANGED; an Employee 360 change after the review does NOT block the freeze and does not enter it', async () => {
  const W = await world({ personnummer: PNR, bankkonto: KTO }); await W.op({ kind: 'startDraft' });
  const reviewed = W.reviewed(); assert.deepEqual(reviewed.privateFields, { fodselsnummer: PNR, bankkonto: KTO });
  await W.setFields({ bankkonto: KTO2 });
  let n0 = W.F.writes.length;
  const e = await rejects(W.freeze(reviewed));
  assert.deepEqual(e.coreResult, { ok: false, code: 'PRIVATE_FIELDS_CHANGED' }); assert.ok(!hasAny(ser(e))); assert.equal(W.F.writes.length, n0); assert.equal(W.versions()[0].status, CONTRACT_STATUS.DRAFT);
  // cleared after review -> also a private change
  const reviewed2 = W.reviewed(); await W.setFields({ fodselsnummer: '' });
  assert.equal((await rejects(W.freeze(reviewed2))).coreResult.code, 'PRIVATE_FIELDS_CHANGED');
  const drift = W.reviewed(); drift.person.name = 'Someone Else';
  assert.equal((await rejects(W.freeze(drift))).coreResult.code, 'CONTRACT_INPUTS_CHANGED');
  // master changes after the (new) review: irrelevant — the draft is the agreement's truth
  await W.setFields({ fodselsnummer: PNR });
  const reviewed3 = W.reviewed();
  await W.M.employees.privateFields.update(A1, { personnummer: PNR2, bankkonto: KTO }); W.M.employees.refresh();
  const ok = await W.freeze(reviewed3); assert.equal(ok.ok, true);
  assert.deepEqual(W.versions()[0].snapshot.privateFields, { fodselsnummer: PNR, bankkonto: KTO2 });
  assert.equal(W.stored().personnummer, PNR2, 'the freeze wrote nothing onto the master');
  // without reviewed inputs the production boundary still refuses
  await W.op({ kind: 'startDraft' });
  assert.equal((await rejects(W.op({ kind: 'freezeVersion', contractVersionId: W.draft().contractVersionId }))).coreResult.code, 'FREEZE_REVIEW_REQUIRED');
  W.M.dispose();
});
await t('CP10', 'P/Q/M. frozen versions are immutable and each new version stands alone: the snapshot holds each private value only when its field was non-empty (the frozen version keeps no second editable copy); setPrivateFields / freeze aimed at a frozen version are refused; after the master changes, v1 still renders its own values and its stored JSON is byte-identical; a NEW change agreement is prefilled with the NEWER master values and may be frozen with a different content; discarding a draft drops its values', async () => {
  const W = await world({ personnummer: PNR, bankkonto: KTO }); await W.op({ kind: 'startDraft' });
  await W.setFields({ bankkonto: '' });
  assert.equal((await W.freeze()).ok, true);
  const v1 = W.versions()[0]; const v1json = JSON.stringify(v1); const v1id = v1.contractVersionId;
  assert.deepEqual(v1.snapshot.privateFields, { fodselsnummer: PNR }); assert.ok(!('privateFields' in v1)); assert.ok(!hasAny(v1json, [KTO, KTO_DOC, '22334']));
  assert.deepEqual(privateFieldsOf(W.emp().contractVersions[0]), { fodselsnummer: PNR });
  assert.equal((await rejects(W.op({ kind: 'setPrivateFields', contractVersionId: v1id, fields: { fodselsnummer: PNR2 } }))).coreResult.code, 'VERSION_NOT_DRAFT');
  await W.M.employees.privateFields.update(A1, { personnummer: PNR2, bankkonto: KTO2 }); W.M.employees.refresh();
  const s = await W.op({ kind: 'startDraft' }); assert.equal(s.version.kind, CONTRACT_KINDS.AMENDMENT);
  assert.deepEqual(privateFieldsOf(W.draft()), { fodselsnummer: PNR2, bankkonto: KTO2 }, 'M: prefilled with the newer master values, not with v1\'s');
  assert.equal((await rejects(W.op({ kind: 'setPrivateFields', contractVersionId: v1id, fields: { fodselsnummer: '' } }))).coreResult.code, 'VERSION_NOT_DRAFT');
  assert.equal((await rejects(W.op({ kind: 'freezeVersion', contractVersionId: v1id, expectedInputs: W.reviewed() }))).coreResult.code, 'ALREADY_FROZEN');
  const b1 = blocksForVersion(W.emp().contractVersions[0], { employee: W.emp(), profile: W.M.contractProfile.get(), onDate: DAY, roleLabels: {} });
  assert.deepEqual(rowsOf(b1).party[2], ['Fødselsnummer', PNR_DOC]); assert.ok(!payHas(b1)); assert.ok(!hasAny(JSON.stringify(b1), [PNR2, PNR2_DOC, KTO2, KTO2_DOC]));
  await W.setFields({ fodselsnummer: '' });
  assert.equal((await W.freeze()).ok, true);
  const vs = W.versions();
  assert.equal(JSON.stringify(vs[0]), v1json); assert.deepEqual(vs[1].snapshot.privateFields, { bankkonto: KTO2 }); assert.ok(!('privateFields' in vs[1])); assert.equal(vs[1].supersedes, v1id);
  W.M.dispose();
  const C = coreWorld(); const pv = { fodselsnummer: PNR, bankkonto: KTO };
  const d = C.run({ kind: 'startDraft' }, pv).version.contractVersionId;
  const fz = C.run({ kind: 'freezeVersion', contractVersionId: d }).version;
  assert.ok(Object.isFrozen(fz) && Object.isFrozen(fz.snapshot)); assert.deepEqual(fz.snapshot.privateFields, pv);
  const d2 = C.run({ kind: 'startDraft' }, pv).version.contractVersionId;
  assert.equal(C.run({ kind: 'discardDraft', contractVersionId: d2 }).ok, true);
  assert.ok(!('privateFields' in C.run({ kind: 'startDraft' }).version));
  assert.equal(JSON.stringify(C.emp().contractVersions[0]), JSON.stringify(fz));
});
await t('CP11', 'T. no propagation beyond the contract version: with a prefilled draft AND a frozen agreement holding both values, the employeeSelf projection (and the validated employeeSelf document written by the adapter), vaktplanPeopleFrom, adapters.employees.people() and missingInfoOf contain neither value; Oversikt / payroll / planning / Vaktplan modules and the employee self-service modules never read a contract version\'s private fields or snapshot', async () => {
  const W = await world({ personnummer: PNR, bankkonto: KTO }); await W.op({ kind: 'startDraft' });
  await W.freeze(); await W.op({ kind: 'startDraft' });
  const store = W.M.employees.store(); const rec = W.emp();
  const self = projectEmployeeSelf(rec, DAY);
  assert.ok(!hasAny(JSON.stringify(self))); assert.ok(!/snapshot|privateField|contractVersions/.test(JSON.stringify(self)));
  assert.equal(validateEmployeeSelfDoc(Object.assign({}, self, { derivedAt: null, sourceRevision: 1 })).ok, true);
  const n0 = W.F.writes.length;
  await W.M.employeeSelf.write(A1, rec, { onDate: DAY, sourceRevision: 1 });
  for (const w of W.F.writes.slice(n0)) { assert.equal(w.path, 'tenants/' + T + '/employeeSelf/' + A1); assert.ok(!hasAny(JSON.stringify(w.data))); }
  for (const b of [JSON.stringify(vaktplanPeopleFrom(store, T)), JSON.stringify(W.M.employees.people()), JSON.stringify(employeesOf(store, T).map((e) => missingInfoOf(e, DAY)))]) assert.ok(!hasAny(b));
  W.M.dispose();
  const code = (f) => fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['management-oversikt.mjs', 'management-payroll-core.mjs', 'management-payroll-view.mjs', 'management-planning-economy.mjs', 'management-schedule-core.mjs', 'management-schedule-view.mjs', 'schedule-core.mjs', 'employee-self-projection.mjs', 'employee-production-adapters.mjs', 'employee-production-bridge.mjs', 'employee-myjob.mjs', 'employee-schedule-view.mjs', 'employee-shell-core.mjs'])
    assert.ok(!(/^management-payroll-(core|view)\.mjs$/.test(f) ? /privateFields|contractVersions/ : /privateFields|\.snapshot\b/).test(code(f)), f);   // payroll has its OWN payroll-version snapshot, never a contract one
});
await t('CP12', 'S. no private value in any refusal / error string of the contract boundary through the adapter (validation, stale review, wrong version), and the view maps the codes to fixed Norwegian sentences without interpolation; the step-1 validation writes its message from the CODE only and keeps the form untouched', async () => {
  const W = await world({ personnummer: PNR, bankkonto: KTO }); await W.op({ kind: 'startDraft' });
  const outs = [];
  outs.push(ser(await rejects(W.setFields({ fodselsnummer: PNR2 + '9' }))));
  outs.push(ser(await rejects(W.setFields({ bankkonto: KTO2 + 'x' }))));
  outs.push(ser(await rejects(W.setFields({ taxCard: KTO2 }))));
  const reviewed = W.reviewed(); await W.setFields({ bankkonto: KTO2 });
  outs.push(ser(await rejects(W.freeze(reviewed))));
  outs.push(ser(await rejects(W.op({ kind: 'setPrivateFields', contractVersionId: 'kv-nope-1', fields: { bankkonto: KTO2 } }))));
  for (const o of outs) assert.ok(!hasAny(o), o.slice(0, 140));
  W.M.dispose();
  const view = fs.readFileSync(path.join(HERE, 'management-employees-view.mjs'), 'utf8');
  for (const c of ['PRIVATE_FIELDS_CHANGED', 'PRIVATE_FIELDS_INVALID', 'PERSONNUMMER_INVALID', 'BANKKONTO_INVALID']) { const m = view.match(new RegExp("if \\(code === '" + c + "'\\) return '([^']*)';")); assert.ok(m && m[1].length > 15 && !/\+/.test(m[0]), c); }
  assert.ok(view.includes('if (!r.ok) { err1.textContent = opError(r.code); return; }'));
  const core = fs.readFileSync(path.join(HERE, 'management-contract-core.mjs'), 'utf8');
  assert.ok(!/console\./.test(core));
  const flow = view.slice(view.indexOf('  function drawContractFlow() {'), view.indexOf('  function drawKontrakt(e) {'));
  assert.ok(!/console\.|showToast|alert\(/.test(flow));
});
await t('CP13', 'A (static). the ORIGINAL step-1 fields are back and ACTIVE, and the checkbox UX is gone: step 1 renders "Fødselsnummer" and "Kontonummer" as enabled text inputs filled from the DRAFT (live value only — no value attribute, dataset, title or hidden input), with the note that changes apply to this agreement only; saving goes through the contract boundary (setPrivateFields), never privateFields.update; no locked placeholder remains; the contract flow contains NO checkbox, no "Ta med …" control and no inclusion flag; step 4 shows only a note and requires the preview of exactly this draft before approval; the view performs exactly ONE private read (the 019 «Vis»)', () => {
  const view = fs.readFileSync(path.join(HERE, 'management-employees-view.mjs'), 'utf8');
  const flow = view.slice(view.indexOf('  function drawContractFlow() {'), view.indexOf('  function drawPreview() {')).replace(/^\s*\/\/.*$/gm, '');
  assert.ok(view.includes("{ key: 'fodselsnummer', label: 'Fødselsnummer', vkey: 'personnummer', short: 'fødselsnummer' }") && view.includes("{ key: 'bankkonto', label: 'Kontonummer', vkey: 'bankkonto', short: 'kontonummer' }"));
  assert.ok(flow.includes("const i = textInput(null, '11 siffer (valgfritt)');") && flow.includes('i.value = formatContractPrivateField(f.key, pf1[f.key]);') && flow.includes('card.appendChild(field(f.label, i));'));
  assert.ok(flow.includes('de hentes fra Person- og lønnsopplysninger når tilgjengelig, og endringer her gjelder bare denne avtalen. Et tomt felt tas ikke med i avtalen.'));
  assert.ok(flow.includes("if (i.value.trim() === '') { if (pf1[f.key]) privPatch[f.key] = ''; continue; }"), 'blank clears');
  assert.ok(flow.includes("applyC({ kind: 'setPrivateFields', ansattId: e.ansattId, contractVersionId: draft1.contractVersionId, fields: privPatch }, next);"));
  assert.ok(!/emp-locked|Aktiveres etter sikkerhetsmodul|checkbox|Ta med |privateFieldInclusion|setPrivateInclusion|emp-incl|privateFields\.(update|read|masked)|dataset|\.title\s*=|type: 'hidden'|innerHTML/.test(flow));
  assert.ok(!/setAttribute\('(title|value|data-value|id|name)'/.test(flow));
  assert.ok(!/privateFieldInclusion|setPrivateInclusion|privateInclusionOf|cPriv|Ta med fullt|Ta med bankkontonummer/.test(view), 'nothing of the rejected checkbox design is left');
  assert.ok(flow.includes("const previewed = !hasPriv || privSeen === privIdOf(e);") && flow.includes('if (draftV && rd.ready && !confirming && previewed) {'));
  assert.ok(flow.includes("'Avtalen inneholder registrerte personopplysninger (' + privNames(pf4) + '). Kontroller forhåndsvisningen før godkjenning"));
  assert.ok(view.includes("const privIdOf = (e) => { const d = draftVersionOf(e); return d ? d.contractVersionId + '|' + JSON.stringify(privateFieldsOf(d)) : ''; };"));
  assert.equal(view.split('privateFields.read(').length - 1, 1);
  const prev = view.slice(view.indexOf('  function drawPreview() {'), view.indexOf('  function drawKontrakt(e) {'));
  assert.ok(prev.includes('privSeen = privIdOf(e);') && prev.includes("cls: 'vp-note emp-priv-note'"), 'the draft preview records what it showed; its notice is screen-only');
  const list = view.slice(view.indexOf('  function drawList() {'), view.indexOf('  function companyFactSummary() {'));
  assert.ok(!/privateFields|privSeen|snapshot/.test(list));
  const adapters = fs.readFileSync(path.join(HERE, 'management-production-adapters.mjs'), 'utf8');
  assert.ok(adapters.includes("const privateValues = op.kind === 'startDraft' ? {"), 'the master values are read for the one-time prefill only');
});
await t('CP14', 'U. BankID / signing boundary unchanged: no file under functions/src, functions/scripts or functions/index.mjs names privateFields / fodselsnummer / bankkonto (the one existing mention is the evidence REDACTION key list); the only functions change is the byte-exact packaged copy of the contract core (document content); live authorizations stay closed', () => {
  const root = path.join(HERE, 'functions');
  const files = [];
  for (const d of ['src', 'scripts']) for (const f of fs.readdirSync(path.join(root, d))) if (/\.mjs$/.test(f)) files.push(path.join(d, f));
  files.push('index.mjs');
  const hits = [];
  for (const f of files) { const src = fs.readFileSync(path.join(root, f), 'utf8'); src.split('\n').forEach((line, i) => { if (/privateFields|fodselsnummer|bankkonto|personnummer|management-private-fields/.test(line)) hits.push(f.replace(/\\/g, '/') + ':' + (i + 1)); }); }
  assert.equal(hits.length, 1, JSON.stringify(hits)); assert.ok(hits[0].startsWith('src/live-smoke-evidence.mjs:'));
  assert.equal(fs.readFileSync(path.join(root, 'shared', 'management-contract-core.mjs'), 'utf8'), fs.readFileSync(path.join(HERE, 'management-contract-core.mjs'), 'utf8'), 'packaged copy is byte-exact');
  assert.ok(!/private-fields/.test(fs.readFileSync(path.join(root, 'shared', 'MANIFEST.json'), 'utf8')));
  assert.ok(fs.readFileSync(path.join(root, 'src', 'live-smoke-gate.mjs'), 'utf8').includes('export const LIVE_SMOKE_AUTHORIZATION = Object.freeze({ authorized: false, releaseId: null, runId: null });'));
  assert.ok(fs.readFileSync(path.join(root, 'src', 'preprod-config.mjs'), 'utf8').includes('export const LIVE_CLOUD_WRITES_AUTHORIZED = false;'));
});

for (const l of lines) console.log(l);
console.log('MANAGEMENT_CONTRACT_PRIVATE_FIELDS_TESTS: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
