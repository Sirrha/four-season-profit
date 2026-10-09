// management-initial-registration.test.mjs — FIRST REGISTRATION of an employee that exists only in the old register
// (no stored employment baseline). Node built-ins only; a FAKE injected datastore. All people and values are synthetic.
// The rendered Workforce flow is proven in the scratch headless harness (ir-proofs.mjs).
// Run: node management-initial-registration.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEmployeeOperation, needsInitialRegistration, lacksEmploymentBaseline, registeredStartDateOf, INITIAL_REGISTRATION_REQUIRED, INITIAL_REGISTRATION_REQUIRED_CODE, TERMS_FIELDS,
  currentTermsOf, startDateOf, termsWithRanges, missingInfoOf, compensationProjectionOf, vaktplanPeopleFrom, correctableTermsPeriodOf,
} from './management-employees-core.mjs';
import { createManagementAdapters, normalizeAnsatt, ansattWriteFor, E360_KEY } from './management-production-adapters.mjs';
import { ADAPTER_ERROR } from './employee-production-adapters.mjs';
import { ETR2A_POLICY as POLICY } from './employee-shell-core.mjs';
import { contractInputsFor, contractReadinessOf, renderContractBlocks, applyContractOperation } from './management-contract-core.mjs';
import os from 'node:os';
import { planningEconomyFor, hourlyRateOn, MISSING_BASIS_NOTE } from './management-planning-economy.mjs';
import { planningSummaryFor, compensationOf, applyScheduleOperation, tenantShiftsOf } from './management-schedule-core.mjs';
import { tenantLocalHMToUtcMs, managerManualEntry, managerCorrection } from './employee-shell-core.mjs';
import { manualErrorText } from './management-payroll-view.mjs';
import { createHash } from 'node:crypto';
import { FOUR_SEASON_MANAGER_ACTOR } from './employee-schedule-fixture.mjs';
import { buildPayrollPackage, accountantPayloadOf, createPayrollStore, applyPayrollOperation, payrollProjectionForEmployee } from './management-payroll-core.mjs';
import { pathToFileURL } from 'node:url';
import { projectEmployeeSelf } from './employee-self-projection.mjs';
import { FOUR_SEASON_CONTRACT_PROFILE } from './employee-schedule-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }

const T = 'four-season-as';
const ADM = { uid: 'uid-admin-1', tenantId: T, accessRole: 'admin', ansattId: 'AdminAnsatt000000001', accessEnabled: true };
const A1 = 'LegacyOnly0000000001', A2 = 'LegacyOnly0000000002', A3 = 'HasBaseline000000003', A4 = 'InactiveLeg000000004';
const RANGE = { from: '2026-09-01', to: '2026-10-31' };
const NOW = Date.parse('2026-10-05T12:00:00Z'), TODAY = '2026-10-05';
// the production problem class: created in the old system on a LATER bootstrap date, with a fake title and wage
const LEGACY_CREATED = '2026-06-20T09:15:00.000Z', LEGACY_DATE = '2026-06-20';
const legacyDoc = (over) => Object.assign({ id: 'x', navn: 'Test Ansatt 01', stilling: 'Fake tittel', timelonn: 111, adresse: 'Testveien 1', epost: 't1@example.test', bankkonto: '00001122334', personnummer: '99999912345', notater: '', aktiv: true, opprettet: LEGACY_CREATED }, over || {});
const REAL_START = '2019-03-04';
const REAL = () => ({ role: 'butikksjef', employmentForm: 'fast', employmentType: 'fast', percentage: 100, compensation: { model: 'fastlonn', monthlySalary: 42000 }, expectedWeeklyHours: 37.5, workplace: '4Seasons ferske varer', noticePeriod: '3 måneder' });
function makeFakeFs() {
  const docs = new Map(); const writes = [];
  const colOf = (p) => p.split('/').slice(0, -1).join('/'); const idOf = (p) => p.split('/').pop();
  const apply = (w) => { for (const [kind, p, d] of w) { writes.push({ kind, path: p, data: JSON.parse(JSON.stringify(d)) }); if (kind === 'set') docs.set(p, JSON.parse(JSON.stringify(d))); else { if (!docs.has(p)) throw Object.assign(new Error('not-found'), { code: 'not-found' }); docs.set(p, Object.assign({}, docs.get(p), JSON.parse(JSON.stringify(d)))); } } };
  const api = {
    doc: (p) => ({ path: p }), serverTimestamp: () => ({ __st: true }), newId: () => 'AuToId00000000000001', listen: () => () => {},
    runTransaction: async (fn) => { const w = []; const tx = { get: async (ref) => ({ exists: docs.has(ref.path), data: docs.get(ref.path) }), set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]) }; const r = await fn(tx); apply(w); return r; },
    batch: () => { const w = []; return { set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]), commit: async () => { apply(w); } }; },
  };
  const readAnsatte = () => { const out = []; for (const [p, d] of docs) if (colOf(p) === 'tenants/' + T + '/ansatte') out.push(Object.assign({}, d, { id: idOf(p) })); return out; };
  return { api, docs, writes, readAnsatte, seed: (p, d) => docs.set(p, JSON.parse(JSON.stringify(d))) };
}
const P = (id) => 'tenants/' + T + '/ansatte/' + id;
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
function world() {
  const F = makeFakeFs();
  F.seed(P(A1), legacyDoc());
  F.seed(P(A2), legacyDoc({ navn: 'Test Ansatt 02', stilling: 'Delt tid', timelonn: 99 }));
  F.seed(P(A4), legacyDoc({ navn: 'Tidligere Ansatt', aktiv: false }));
  F.seed(P(A3), legacyDoc({ navn: 'Har Grunnlag', [E360_KEY]: { name: 'Har Grunnlag', status: 'active', startDate: '2024-01-02', contact: { email: null, phone: null, address: null, birthDate: null }, terms: [{ validFrom: '2024-01-02', role: 'butikkmedarbeider' }], documents: [], contractVersions: [], rev: 2 } }));
  const M = createManagementAdapters({ fs: F.api, tenantId: T, membership: ADM, range: RANGE, readAnsatte: F.readAnsatte, defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: POLICY, nowMs: () => NOW });
  M.start();
  const emp = (id) => M.employees.store()[T][id];
  const register = (id, startDate, terms) => M.employees.apply({ kind: 'registerInitialEmployment', ansattId: id, startDate, terms });
  return { F, M, emp, register, stored: (id) => F.docs.get(P(id)) };
}
// pure-core world built from the SAME normalized record shape the product reads
function coreWorld(doc) {
  const store = { [T]: { [A1]: normalizeAnsatt(A1, doc || legacyDoc()) } };
  const actor = { accessEnabled: true, canEditEmployment: true };
  const run = (op, a) => applyEmployeeOperation({ store, tenantId: T, actor: a === undefined ? actor : a, op: Object.assign({ ansattId: A1 }, op), now: NOW, timezone: 'Europe/Oslo' });
  return { store, emp: () => store[T][A1], run };
}

await t('IR01', 'the problem class as the product reads it: an old-register employee has NO stored baseline; the read shape shows ONE period DERIVED from the old fields (validFrom = the old record\'s creation date, role = its title text, compensation = its hourly wage) and is flagged needsInitialRegistration', () => {
  const rec = normalizeAnsatt(A1, legacyDoc());
  assert.equal(rec.legacy.hasE360, false); assert.equal(needsInitialRegistration(rec), true);
  assert.equal(rec.terms.length, 1); assert.equal(rec.terms[0].validFrom, LEGACY_DATE); assert.equal(startDateOf(rec), LEGACY_DATE);
  assert.equal(rec.terms[0].role, 'Fake tittel'); assert.deepEqual(rec.terms[0].compensation, { model: 'timelonn', hourlyRate: 111 });
  assert.equal(needsInitialRegistration(normalizeAnsatt(A4, legacyDoc({ aktiv: false }))), false, 'inactive: not offered');
  assert.equal(needsInitialRegistration(normalizeAnsatt(A3, legacyDoc({ [E360_KEY]: { terms: [{ validFrom: '2024-01-02', role: 'x' }] } }))), false, 'stored baseline: not offered');
  assert.equal(needsInitialRegistration({ status: 'active', terms: [] }), false, 'a record without the old-register marker (preview fixtures) is never offered');
});
// Every operation that is NOT the first registration, with a payload that would otherwise be accepted.
const OTHER_EMPLOYEE_OPS = (id) => [
  { kind: 'updateContact', ansattId: id, contact: { phone: '40000000' } },
  { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'fast', employmentType: 'fast', percentage: 100 } },
  { kind: 'correctCurrentTerms', ansattId: id, terms: { percentage: 50 }, reason: 'feil prosent' },
  { kind: 'appendTerms', ansattId: id, terms: { validFrom: '2026-09-15', role: 'skiftleder', compensation: { model: 'timelonn', hourlyRate: 240 }, employmentType: 'fast', percentage: 100 } },
  { kind: 'endEmployee', ansattId: id, endDate: '2026-10-05' },
  { kind: 'addDocument', ansattId: id, document: { kind: 'annet', title: 'Notat', date: '2026-10-01' } },
  { kind: 'removeDocument', ansattId: id, documentId: 'doc-1' },
  { kind: 'someFutureOperation', ansattId: id },
];
const CONTRACT_OPS = (id) => [
  { kind: 'startDraft', ansattId: id },
  { kind: 'setPrivateFields', ansattId: id, privateFields: { fodselsnummer: null, bankkonto: null } },
  { kind: 'freezeVersion', ansattId: id },
  { kind: 'discardDraft', ansattId: id },
];
const snap = (F) => JSON.stringify(Array.from(F.docs.entries()));

await t('IR02', 'THE TRAP IS CLOSED (deliberately changed: this test used to REPRODUCE the trap by asserting that a contact update stored the derived period). Through the real adapter EVERY operation other than first registration — contact update, completion, correction, new period, end, document add/remove, an unknown future kind — is refused INITIAL_REGISTRATION_REQUIRED on an old-register employee with ZERO writes: no e360 block appears, the document is byte-identical, opprettet / stilling / timelonn are untouched; and first registration with the REAL start date is still available afterwards', async () => {
  const W = world(); const before = snap(W.F); const docBefore = JSON.stringify(W.stored(A2));
  for (const op of OTHER_EMPLOYEE_OPS(A2)) {
    const err = await rejects(W.M.employees.apply(op));
    assert.ok(err, op.kind + ' must be refused'); assert.equal(err.code, ADAPTER_ERROR.CORE_REFUSED, op.kind); assert.equal(err.coreResult.code, 'INITIAL_REGISTRATION_REQUIRED', op.kind);
    assert.equal(W.F.writes.length, 0, op.kind + ': zero writes'); assert.equal(snap(W.F), before, op.kind + ': nothing changed');
  }
  const d = W.stored(A2); assert.ok(!(E360_KEY in d)); assert.equal(JSON.stringify(d), docBefore);
  assert.equal(d.opprettet, LEGACY_CREATED); assert.equal(d.stilling, 'Delt tid'); assert.equal(d.timelonn, 99);
  assert.equal(needsInitialRegistration(W.emp(A2)), true, 'still offered first registration');
  await W.register(A2, REAL_START, REAL());
  const e = W.stored(A2)[E360_KEY]; assert.equal(e.startDate, REAL_START); assert.equal(e.terms.length, 1); assert.equal(e.terms[0].validFrom, REAL_START); assert.equal(e.terms[0].role, 'butikksjef');
  assert.ok(!JSON.stringify(e).includes(LEGACY_DATE), 'the old creation date is nowhere in the stored baseline');
  W.M.dispose();
});
await t('IR03', 'FIRST REGISTRATION through the real adapter: the submitted REAL start date becomes BOTH e360.startDate and terms[0].validFrom; exactly ONE period; no period at the old creation date; the submitted role and compensation win over the old bootstrap values; same document id; `opprettet` byte-identical', async () => {
  const W = world();
  const before = JSON.parse(JSON.stringify(W.stored(A1)));
  const r = await W.register(A1, REAL_START, REAL());
  assert.equal(r.ok, true); assert.equal(r.ansattId, A1);
  const d = W.stored(A1); const e = d[E360_KEY];
  assert.equal(e.startDate, REAL_START); assert.equal(e.terms.length, 1); assert.equal(e.terms[0].validFrom, REAL_START);
  assert.ok(!e.terms.some((x) => x.validFrom === LEGACY_DATE)); assert.ok(!JSON.stringify(e).includes(LEGACY_DATE));
  assert.equal(e.terms[0].role, 'butikksjef'); assert.deepEqual(e.terms[0].compensation, { model: 'fastlonn', monthlySalary: 42000 });
  assert.ok(!JSON.stringify(e).includes('Fake tittel') && !JSON.stringify(e.terms).includes('111'));
  assert.deepEqual([e.terms[0].employmentForm, e.terms[0].employmentType, e.terms[0].percentage, e.terms[0].expectedWeeklyHours, e.terms[0].workplace, e.terms[0].noticePeriod], ['fast', 'fast', 100, 37.5, '4Seasons ferske varer', '3 måneder']);
  assert.deepEqual(Object.keys(e.terms[0]).sort(), TERMS_FIELDS.slice().sort(), 'the accepted terms shape, nothing parallel');
  assert.equal(d.opprettet, before.opprettet); assert.equal(e.lastOp, 'registerInitialEmployment'); assert.equal(e.rev, 1); assert.equal(e.name, 'Test Ansatt 01'); assert.equal(e.status, 'active');
  assert.deepEqual(e.contractVersions, []); assert.deepEqual(e.documents, []);
  W.M.dispose();
});
await t('IR04', 'exactly ONE write on exactly ONE document, and the legacy fields move only by the accepted projection law: the write is an UPDATE of tenants/{T}/ansatte/{same id} carrying e360 + stilling (canonical role key); timelonn is re-projected only for a timelønn model; opprettet / navn / aktiv / adresse / epost / bankkonto / personnummer / notater are not in the write and stay byte-identical; no employeeSelf, no second employee, no other collection', async () => {
  const W = world();
  const before = JSON.parse(JSON.stringify(W.stored(A1))); const n0 = W.F.docs.size;
  await W.register(A1, REAL_START, REAL());
  assert.equal(W.F.writes.length, 1); const w = W.F.writes[0];
  assert.equal(w.kind, 'update'); assert.equal(w.path, P(A1)); assert.deepEqual(Object.keys(w.data).sort(), [E360_KEY, 'stilling'].sort());
  const after = W.stored(A1);
  for (const k of ['opprettet', 'navn', 'aktiv', 'adresse', 'epost', 'bankkonto', 'personnummer', 'notater', 'timelonn', 'id']) assert.deepEqual(after[k], before[k], k);
  assert.equal(after.stilling, 'butikksjef'); assert.equal(after.timelonn, 111, 'fastlønn: the old hourly field is not rewritten (accepted law) — see result notes');
  assert.equal(W.F.docs.size, n0, 'no new document anywhere'); assert.ok(![...W.F.docs.keys()].some((p) => p.includes('/employeeSelf/')));
  // timelønn model: the hourly projection follows the submitted amount
  const terms2 = Object.assign(REAL(), { compensation: { model: 'timelonn', hourlyRate: 235 } });
  await W.register(A2, '2021-08-16', terms2);
  assert.deepEqual(Object.keys(W.F.writes[1].data).sort(), [E360_KEY, 'stilling', 'timelonn'].sort()); assert.equal(W.stored(A2).timelonn, 235);
  assert.equal(ansattWriteFor('registerInitialEmployment', W.emp(A2), W.stored(A2), NOW, TODAY).opprettet, undefined);
  W.M.dispose();
});
await t('IR05', 'the admin\'s explicit facts are required — nothing is inherited from the old register: each of role, employmentForm, employmentType, percentage, compensation, expectedWeeklyHours, workplace, noticePeriod missing or blank -> INITIAL_TERMS_REQUIRED:<field>, nothing changed; optional accepted fields (arbeidstidsordning, prøvetid, utbetalingsintervall) are stored when given and null otherwise', () => {
  assert.deepEqual([...INITIAL_REGISTRATION_REQUIRED], ['role', 'employmentForm', 'employmentType', 'percentage', 'compensation', 'expectedWeeklyHours', 'workplace', 'noticePeriod']);
  for (const f of INITIAL_REGISTRATION_REQUIRED) {
    for (const blank of [undefined, null, '']) {
      const W = coreWorld(); const snap = JSON.stringify(W.emp());
      const terms = REAL(); if (blank === undefined) delete terms[f]; else terms[f] = blank;
      assert.deepEqual(W.run({ kind: 'registerInitialEmployment', startDate: REAL_START, terms }), { ok: false, code: 'INITIAL_TERMS_REQUIRED:' + f }, f);
      assert.equal(JSON.stringify(W.emp()), snap); assert.equal(needsInitialRegistration(W.emp()), true);
    }
  }
  const W = coreWorld();
  const r = W.run({ kind: 'registerInitialEmployment', startDate: REAL_START, terms: Object.assign(REAL(), { workingTimeArrangement: 'Etter vaktplan', probation: '', paymentInterval: 'manedlig' }) });
  assert.equal(r.ok, true); assert.equal(r.terms.workingTimeArrangement, 'Etter vaktplan'); assert.equal(r.terms.probation, null); assert.equal(r.terms.paymentInterval, 'manedlig'); assert.equal(r.terms.breaksArrangement, null);
  assert.ok(Object.isFrozen(r.terms) && Object.isFrozen(r.terms.compensation));
});
await t('IR06', 'fail closed on the start date and on values: blank / malformed / impossible calendar dates / before 1900 -> STARTDATE_INVALID; a future date -> STARTDATE_FUTURE (today itself is accepted); percentage, hours, compensation, enums and unknown fields are refused by the existing value law; a refusal changes nothing', () => {
  for (const bad of [undefined, null, '', '04.03.2019', '2019-3-4', '2019-02-30', '2019-13-01', '1899-12-31', 20190304]) { const W = coreWorld(); assert.equal(W.run({ kind: 'registerInitialEmployment', startDate: bad, terms: REAL() }).code, 'STARTDATE_INVALID', String(bad)); assert.equal(needsInitialRegistration(W.emp()), true); }
  assert.equal(coreWorld().run({ kind: 'registerInitialEmployment', startDate: '2026-10-06', terms: REAL() }).code, 'STARTDATE_FUTURE');
  assert.equal(coreWorld().run({ kind: 'registerInitialEmployment', startDate: TODAY, terms: REAL() }).ok, true);
  const cases = [[{ percentage: 0 }, 'PERCENTAGE_INVALID'], [{ percentage: 101 }, 'PERCENTAGE_INVALID'], [{ percentage: '100' }, 'PERCENTAGE_INVALID'], [{ expectedWeeklyHours: 0 }, 'EXPECTEDWEEKLYHOURS_INVALID'], [{ expectedWeeklyHours: 200 }, 'EXPECTEDWEEKLYHOURS_INVALID'],
    [{ compensation: { model: 'timelonn', hourlyRate: 0 } }, 'COMPENSATION_INVALID'], [{ compensation: { model: 'fastlonn', monthlySalary: -1 } }, 'COMPENSATION_INVALID'], [{ compensation: { model: 'x' } }, 'COMPENSATION_INVALID'], [{ compensation: { model: 'timelonn', hourlyRate: 200, extra: 1 } }, 'COMPENSATION_INVALID'],
    [{ employmentForm: 'deltid' }, 'EMPLOYMENTFORM_INVALID'], [{ employmentType: 'heltid' }, 'EMPLOYMENTTYPE_INVALID'], [{ paymentInterval: 'ukentlig' }, 'PAYMENTINTERVAL_INVALID'], [{ validFrom: '2019-01-01' }, 'TERMS_FIELD_NOT_ALLOWED:validFrom'], [{ timelonn: 5 }, 'TERMS_FIELD_NOT_ALLOWED:timelonn']];
  for (const [over, code] of cases) { const W = coreWorld(); const snap = JSON.stringify(W.emp()); assert.equal(W.run({ kind: 'registerInitialEmployment', startDate: REAL_START, terms: Object.assign(REAL(), over) }).code, code, JSON.stringify(over)); assert.equal(JSON.stringify(W.emp()), snap); }
  for (const bad of [null, undefined, 'x', []]) assert.equal(coreWorld().run({ kind: 'registerInitialEmployment', startDate: REAL_START, terms: bad }).code, 'NO_TERMS');
});
await t('IR07', 'who and when: an inactive old-register employee is refused (INITIAL_REGISTRATION_INACTIVE); an employee that already has a stored baseline is refused (…_NOT_AVAILABLE) — also immediately after a successful first registration (one-time only, no start-date rewrite through this path); an actor without the employment-edit capability is refused; an unknown employee is refused; nothing is written by any refusal', async () => {
  const W = world();
  const e1 = await rejects(W.register(A4, REAL_START, REAL())); assert.equal(e1.code, ADAPTER_ERROR.CORE_REFUSED); assert.deepEqual(e1.coreResult, { ok: false, code: 'INITIAL_REGISTRATION_INACTIVE' });
  const e2 = await rejects(W.register(A3, REAL_START, REAL())); assert.deepEqual(e2.coreResult, { ok: false, code: 'INITIAL_REGISTRATION_NOT_AVAILABLE' });
  const e3 = await rejects(W.register('NoSuchEmployee000000', REAL_START, REAL())); assert.equal(e3.detail, 'EMPLOYEE_UNKNOWN');
  assert.equal(W.F.writes.length, 0);
  await W.register(A1, REAL_START, REAL());
  const e4 = await rejects(W.register(A1, '2018-01-01', REAL())); assert.deepEqual(e4.coreResult, { ok: false, code: 'INITIAL_REGISTRATION_NOT_AVAILABLE' });
  assert.equal(W.F.writes.length, 1); assert.equal(W.stored(A1)[E360_KEY].startDate, REAL_START); assert.equal(W.stored(A1)[E360_KEY].terms.length, 1);
  W.M.dispose();
  const C = coreWorld();
  for (const actor of [null, { accessEnabled: false, canEditEmployment: true }, { accessEnabled: true, canEditEmployment: false }, { accessEnabled: true, canViewEmployeeCore: true }]) assert.equal(C.run({ kind: 'registerInitialEmployment', startDate: REAL_START, terms: REAL() }, actor).code, 'NOT_AUTHORIZED');
  assert.equal(needsInitialRegistration(C.emp()), true);
  assert.equal(C.run({ kind: 'registerInitialEmployment', startDate: REAL_START, terms: REAL() }).ok, true);
  assert.equal(C.run({ kind: 'registerInitialEmployment', startDate: REAL_START, terms: REAL() }).code, 'INITIAL_REGISTRATION_NOT_AVAILABLE', 'second call in the same store');
  assert.equal(needsInitialRegistration(C.emp()), false);
});
await t('IR08', 'stale / concurrent transition: the decision is made on the document read INSIDE the transaction — if another session has stored a baseline in the meantime (this adapter\'s mirror still shows the employee as unregistered) the registration is refused and nothing is overwritten', async () => {
  const W = world();
  assert.equal(needsInitialRegistration(W.emp(A1)), true);
  // another session registers first (written straight to the datastore; this adapter has NOT refreshed its mirror)
  const other = { name: 'Test Ansatt 01', status: 'active', startDate: '2020-02-02', contact: { email: null, phone: null, address: null, birthDate: null }, terms: [{ validFrom: '2020-02-02', role: 'butikkmedarbeider' }], documents: [], contractVersions: [], rev: 1 };
  W.F.seed(P(A1), Object.assign({}, W.stored(A1), { [E360_KEY]: other }));
  assert.equal(needsInitialRegistration(W.emp(A1)), true, 'local mirror is stale on purpose');
  const e = await rejects(W.register(A1, REAL_START, REAL()));
  assert.deepEqual(e.coreResult, { ok: false, code: 'INITIAL_REGISTRATION_NOT_AVAILABLE' }); assert.equal(W.F.writes.length, 0);
  assert.equal(W.stored(A1)[E360_KEY].startDate, '2020-02-02');
  W.M.dispose();
});
await t('IR09', 'afterwards the ORDINARY laws take over on the one real period: derived history = one open-ended period from the real start date; completion fills only remaining blanks without moving the date; a correction keeps the same period; a genuine change appends period #2 and leaves period #1 untouched', async () => {
  const W = world();
  await W.register(A1, REAL_START, REAL());
  const e = W.emp(A1);
  assert.equal(needsInitialRegistration(e), false); assert.equal(startDateOf(e), REAL_START); assert.equal(e.legacy.hasE360, true);
  assert.deepEqual(termsWithRanges(e).map((r) => [r.validFrom, r.validTo]), [[REAL_START, null]]);
  assert.equal(currentTermsOf(e, TODAY).validFrom, REAL_START); assert.ok(!missingInfoOf(e, TODAY).some((m) => /stilling|prosent|lønn/i.test(m)), 'no employment fact is reported missing');
  await W.M.employees.apply({ kind: 'completeCurrentTerms', ansattId: A1, terms: { probation: 'ingen' } });
  assert.equal(W.stored(A1)[E360_KEY].terms.length, 1); assert.equal(W.stored(A1)[E360_KEY].terms[0].validFrom, REAL_START); assert.equal(W.stored(A1)[E360_KEY].terms[0].probation, 'ingen');
  const c = correctableTermsPeriodOf(W.emp(A1)); assert.ok(c && c.validFrom === REAL_START);
  await W.M.employees.apply({ kind: 'correctCurrentTerms', ansattId: A1, periodValidFrom: REAL_START, reason: 'feil prosent', terms: { percentage: 80 }, expected: { percentage: 100 } });
  assert.equal(W.stored(A1)[E360_KEY].terms.length, 1); assert.equal(W.stored(A1)[E360_KEY].terms[0].percentage, 80); assert.equal(W.stored(A1)[E360_KEY].startDate, REAL_START);
  await W.M.employees.apply({ kind: 'appendTerms', ansattId: A1, terms: { validFrom: '2026-09-01', role: 'butikksjef', percentage: 100 } });
  const terms = W.stored(A1)[E360_KEY].terms;
  assert.deepEqual(terms.map((x) => x.validFrom), [REAL_START, '2026-09-01']); assert.equal(terms[0].percentage, 80); assert.equal(W.stored(A1)[E360_KEY].startDate, REAL_START);
  W.M.dispose();
});
await t('IR10', 'contract flow sees the newly established terms: a draft started after first registration reads the real start date, role, percentage, hours, workplace, notice and compensation; the agreement shows the real Tiltredelsesdato; nothing of the old bootstrap values reaches the agreement', async () => {
  const W = world();
  await W.register(A1, REAL_START, REAL());
  const s = await W.M.employees.applyContract({ kind: 'startDraft', ansattId: A1 }, FOUR_SEASON_CONTRACT_PROFILE, { onDate: TODAY, roleLabels: { butikksjef: 'Butikksjef' } });
  assert.equal(s.ok, true);
  const inputs = contractInputsFor({ employee: W.emp(A1), profile: FOUR_SEASON_CONTRACT_PROFILE, onDate: TODAY, roleLabels: { butikksjef: 'Butikksjef' } });
  assert.equal(inputs.startDate, REAL_START); assert.equal(inputs.termsPeriodRef, REAL_START);
  assert.deepEqual([inputs.terms.role, inputs.terms.roleLabel, inputs.terms.percentage, inputs.terms.expectedWeeklyHours, inputs.terms.workplace, inputs.terms.noticePeriod, inputs.terms.employmentForm], ['butikksjef', 'Butikksjef', 100, 37.5, '4Seasons ferske varer', '3 måneder', 'fast']);
  assert.deepEqual(inputs.terms.compensation, { model: 'fastlonn', monthlySalary: 42000 });
  const blocks = JSON.stringify(renderContractBlocks(inputs, {}));
  assert.ok(blocks.includes('04.03.2019') && blocks.includes('kr 42000 per måned')); assert.ok(!blocks.includes('20.06.2026') && !blocks.includes('Fake tittel') && !blocks.includes('111'));
  const miss = contractReadinessOf(inputs).missing.map((m) => m.key);
  for (const k of ['startDate', 'role', 'workplace', 'employmentForm', 'percentage', 'expectedWeeklyHours', 'noticePeriod', 'compensation']) assert.ok(!miss.includes(k), k);
  W.M.dispose();
});
await t('IR11', 'payroll / planning / Vaktplan projections do not regress: before registration the employee is still an active, assignable person; after it the Vaktplan people entry carries the canonical role key, the compensation projection reads the submitted model, and the employeeSelf projection BUILDER (not written here) would show the real start date and facts', async () => {
  const W = world();
  const before = W.M.employees.people().find((p) => p.ansattId === A1); assert.ok(before && before.name === 'Test Ansatt 01');
  await W.register(A1, REAL_START, REAL());
  const after = W.M.employees.people().find((p) => p.ansattId === A1); assert.deepEqual(after, { ansattId: A1, name: 'Test Ansatt 01', roleKey: 'butikksjef' });
  assert.ok(vaktplanPeopleFrom(W.M.employees.store(), T, TODAY).some((p) => p.ansattId === A1));
  assert.equal(W.M.employees.people().length, 3, 'three active people; the inactive one stays out; no duplicate');
  const cp = compensationProjectionOf(W.emp(A1), TODAY); assert.ok(cp && JSON.stringify(cp).includes('fastlonn'));
  const self = projectEmployeeSelf(W.emp(A1), TODAY);
  assert.deepEqual([self.name, self.role, self.employmentType, self.percentage, self.workplace, self.startDate, self.expectedWeeklyHours], ['Test Ansatt 01', 'butikksjef', 'fast', 100, '4Seasons ferske varer', REAL_START, 37.5]);
  assert.ok(!W.F.writes.some((w) => w.path.includes('/employeeSelf/')), 'building the projection writes nothing');
  W.M.dispose();
});
await t('IR12', '(static) Workforce UI: Arbeidsforhold shows the first-registration state INSTEAD of the ordinary editors while it is needed; "Faktisk startdato" starts empty (never the old creation date); every employment field starts from the typed draft only — no value from the old register is prefilled; the old values appear once as labelled orientation; ONE operation on save; contract start and document registration are withheld until the baseline exists; no implementation vocabulary in user-facing text', () => {
  const view = fs.readFileSync(path.join(HERE, 'management-employees-view.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const a = view.indexOf('  function drawFirstRegistration(e) {'), b = view.indexOf('  function drawArbeid(e, cur) {');
  assert.ok(a > 0 && b > a);
  const body = view.slice(a, b).replace(/^\s*\/\/.*$/gm, '');
  assert.ok(view.includes('    if (lacksEmploymentBaseline(e)) return drawFirstRegistration(e);'), 'ordinary editors are not rendered at all (active or not) while no baseline is stored');
  assert.ok(body.includes('    if (!canEditEmployment(actor) || !needsInitialRegistration(e)) return;'), 'the registration form itself is offered only to an editor and only for an active employee');
  assert.ok(body.includes("text: 'Registrer arbeidsforhold'") && body.includes("field('Faktisk startdato', start)") && body.includes("btn('Opprett arbeidsforhold', 'btn primary'"));
  assert.ok(body.includes("const start = textInput(d.start || '', null, 'date');"), 'start date comes from the typed draft or is empty');
  assert.ok(body.includes('Datoen den ansatte ble lagt inn i det gamle systemet brukes ikke som startdato.'));
  assert.ok(body.includes("'Ubekreftede opplysninger fra gammelt register – kun til orientering: '"), 'old values are explicitly marked unconfirmed');
  assert.ok(body.includes("bits.push('lagt inn i gammelt system ' + fmtDate(opp))") && body.includes("bits.push('stilling «' + hint.role + '»')"));
  assert.ok(!view.includes('Fra det gamle registeret (kun til orientering'), 'the earlier softer wording is gone');
  // no input is initialised from the derived period or the old record
  const inputs = body.split('\n').filter((l) => /= (textInput|selectInput)\(/.test(l));
  assert.equal(inputs.length, 13); for (const l of inputs) assert.ok(!/hint\.|e\.terms|e\.legacy|cur\b|opp\b/.test(l), l.trim().slice(0, 80));
  for (const lab of ['Stilling', 'Ansettelsesform', 'Stillingstype', 'Stillingsprosent', 'Lønnsgrunnlag', 'Beløp (kr per time / per måned)', 'Avtalt arbeidstid (timer per uke)', 'Arbeidssted', 'Oppsigelsestid']) assert.ok(body.includes("field('" + lab + "', "), lab);
  assert.equal(body.split('apply({ kind:').length - 1, 1); assert.ok(body.includes("apply({ kind: 'registerInitialEmployment', ansattId: e.ansattId, startDate: start.value, terms }, () => { regDraft = null; });"));
  assert.ok(!/applyC\(|appendTerms|completeCurrentTerms/.test(body), 'no append / completion / contract call in the first-registration path');
  const literals = (body.match(/'[^'\n]*'/g) || []).join(' ');
  assert.ok(!/e360|legacy|adapter|migrer|Firestore|firestore|bootstrap/i.test(literals.replace(/emp-legacy-hint/g, '')), 'no implementation terms in user-facing strings');
  assert.ok(view.includes("if (needsInitialRegistration(e)) cc.appendChild(el('div', { cls: 'cue-line emp-firstreg-gate', text: 'Registrer arbeidsforholdet under «Arbeidsforhold» før arbeidsavtalen opprettes.' }));"));
  assert.ok(view.includes('    if (canEditEmployment(actor) && !lacksEmploymentBaseline(e)) {\n      const form = el(\'div\', { cls: \'card emp-form\' });\n      form.appendChild(el(\'div\', { cls: \'kicker neutral\', text: \'Registrer dokumentopplysning\' }));'));
  assert.ok(view.includes("card.appendChild(factRow('Startdato', unreg ? 'Ikke registrert' : fmtDate(startDateOf(e))));"));
});

await t('IR13', 'CORE LAW: for an employee without a stored baseline applyEmployeeOperation refuses EVERY kind except registerInitialEmployment with INITIAL_REGISTRATION_REQUIRED — contact, completion, correction, new period, end, documents and an unknown future kind — and mutates nothing (record identical); the same holds for an INACTIVE old-register employee; an employee WITH a stored baseline and a record without the old-register marker are not affected', () => {
  assert.equal(INITIAL_REGISTRATION_REQUIRED_CODE, 'INITIAL_REGISTRATION_REQUIRED'); assert.ok(Array.isArray(INITIAL_REGISTRATION_REQUIRED), 'the required-field list keeps its name');
  for (const doc of [legacyDoc(), legacyDoc({ aktiv: false })]) {
    const C = coreWorld(doc); assert.equal(lacksEmploymentBaseline(C.emp()), true);
    const before = JSON.stringify(C.store);
    for (const op of OTHER_EMPLOYEE_OPS(A1)) { const r = C.run(op); assert.equal(r.ok, false, op.kind); assert.equal(r.code, 'INITIAL_REGISTRATION_REQUIRED', op.kind); assert.equal(JSON.stringify(C.store), before, op.kind + ' mutated the record'); }
  }
  const withBase = coreWorld(legacyDoc({ [E360_KEY]: { name: 'x', status: 'active', startDate: '2024-01-02', contact: { email: null, phone: null, address: null, birthDate: null }, terms: [{ validFrom: '2024-01-02', role: 'butikkmedarbeider' }], documents: [], contractVersions: [], rev: 1 } }));
  assert.equal(lacksEmploymentBaseline(withBase.emp()), false); assert.equal(withBase.run({ kind: 'updateContact', contact: { phone: '40000000' } }).ok, true);
  assert.equal(lacksEmploymentBaseline({ status: 'active', terms: [] }), false, 'no old-register marker (preview fixture / new employee)');
});

await t('IR14', 'CONTRACT CORE LAW: applyContractOperation refuses startDraft, setPrivateFields, freezeVersion and discardDraft with INITIAL_REGISTRATION_REQUIRED for an employee without a stored baseline; no contract version is created and the record is identical', () => {
  const store = { [T]: { [A1]: normalizeAnsatt(A1, legacyDoc()) } }; const before = JSON.stringify(store);
  for (const op of CONTRACT_OPS(A1)) {
    const r = applyContractOperation({ store, tenantId: T, actor: { accessEnabled: true, canEditEmployment: true }, op, profile: FOUR_SEASON_CONTRACT_PROFILE, now: NOW, onDate: TODAY });
    assert.equal(r.ok, false, op.kind); assert.equal(r.code, 'INITIAL_REGISTRATION_REQUIRED', op.kind); assert.equal(JSON.stringify(store), before, op.kind);
  }
  assert.equal((store[T][A1].contractVersions || []).length, 0);
});

await t('IR15', 'ADAPTER: contract start / private fields / freeze / discard on an old-register employee reject CORE_REFUSED:INITIAL_REGISTRATION_REQUIRED with zero writes, no profile read side effect, document byte-identical; document registration is refused the same way (covered with the employee operations in IR02); an INACTIVE old-register employee is refused for every employee and contract operation as well', async () => {
  const W = world(); const before = snap(W.F);
  for (const id of [A1, A4]) {
    for (const op of CONTRACT_OPS(id)) { const err = await rejects(W.M.employees.applyContract(op, FOUR_SEASON_CONTRACT_PROFILE, { onDate: TODAY })); assert.ok(err, op.kind); assert.equal(err.code, ADAPTER_ERROR.CORE_REFUSED); assert.equal(err.coreResult.code, 'INITIAL_REGISTRATION_REQUIRED', id + ' ' + op.kind); }
  }
  for (const op of OTHER_EMPLOYEE_OPS(A4)) { const err = await rejects(W.M.employees.apply(op)); assert.ok(err, op.kind); assert.equal(err.coreResult.code, 'INITIAL_REGISTRATION_REQUIRED', 'inactive ' + op.kind); }
  assert.equal(W.F.writes.length, 0); assert.equal(snap(W.F), before);
  for (const id of [A1, A4]) assert.ok(!(E360_KEY in W.stored(id)));
  W.M.dispose();
});

await t('IR16', 'ADAPTER BYPASS BLOCKED — the persistence invariant is independent of the core guards (mutation proof): in a scratch copy of the modules BOTH core guards are removed; the stripped employee core then ACCEPTS a contact update on an old-register record and the stripped contract core accepts a draft (the mutation is live), yet the adapter over those stripped cores still refuses every employee and contract operation with zero writes and an identical document, while registerInitialEmployment still succeeds with the real start date', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-mutation-'));
  try {
    for (const f of fs.readdirSync(HERE)) if (/\.mjs$/.test(f) && !/\.test\.mjs$/.test(f)) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
    const strip = (f, re) => { const p = path.join(dir, f); const s = fs.readFileSync(p, 'utf8'); const n = s.replace(re, ''); assert.notEqual(n, s, 'guard line found in ' + f); fs.writeFileSync(p, n); };
    strip('management-employees-core.mjs', /^  if \(lacksEmploymentBaseline\(emp\) && op\.kind !== 'registerInitialEmployment'\) return [^\n]*\n/m);
    strip('management-contract-core.mjs', /^  if \(emp\.legacy && emp\.legacy\.hasE360 === false\) return [^\n]*\n/m);
    const url = (f) => pathToFileURL(path.join(dir, f)).href;
    const mCore = await import(url('management-employees-core.mjs')); const mContract = await import(url('management-contract-core.mjs')); const mAd = await import(url('management-production-adapters.mjs'));
    // the mutation is live: without their guards the cores accept
    const store = { [T]: { [A1]: mAd.normalizeAnsatt(A1, legacyDoc()) } };
    assert.equal(mCore.applyEmployeeOperation({ store, tenantId: T, actor: { accessEnabled: true, canEditEmployment: true }, op: { kind: 'updateContact', ansattId: A1, contact: { phone: '40000000' } }, now: NOW, timezone: 'Europe/Oslo' }).ok, true, 'stripped employee core accepts');
    const store2 = { [T]: { [A1]: mAd.normalizeAnsatt(A1, legacyDoc()) } };
    assert.equal(mContract.applyContractOperation({ store: store2, tenantId: T, actor: { accessEnabled: true, canEditEmployment: true }, op: { kind: 'startDraft', ansattId: A1 }, profile: FOUR_SEASON_CONTRACT_PROFILE, now: NOW, onDate: TODAY }).ok, true, 'stripped contract core accepts');
    // the adapter over the stripped cores still refuses, and writes nothing
    const F = makeFakeFs(); F.seed(P(A1), legacyDoc()); F.seed(P(A4), legacyDoc({ aktiv: false }));
    const M = mAd.createManagementAdapters({ fs: F.api, tenantId: T, membership: ADM, range: RANGE, readAnsatte: F.readAnsatte, defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: POLICY, nowMs: () => NOW });
    M.start(); const before = snap(F);
    for (const id of [A1, A4]) {
      for (const op of OTHER_EMPLOYEE_OPS(id)) { const err = await rejects(M.employees.apply(op)); assert.ok(err, 'employee ' + op.kind + ' must be refused by the adapter alone'); assert.equal(err.code, ADAPTER_ERROR.CORE_REFUSED, op.kind); assert.equal(err.coreResult.code, 'INITIAL_REGISTRATION_REQUIRED', op.kind); }
      for (const op of CONTRACT_OPS(id)) { const err = await rejects(M.employees.applyContract(op, FOUR_SEASON_CONTRACT_PROFILE, { onDate: TODAY })); assert.ok(err, 'contract ' + op.kind + ' must be refused by the adapter alone'); assert.equal(err.coreResult.code, 'INITIAL_REGISTRATION_REQUIRED', op.kind); }
    }
    assert.equal(F.writes.length, 0); assert.equal(snap(F), before);
    await M.employees.apply({ kind: 'registerInitialEmployment', ansattId: A1, startDate: REAL_START, terms: REAL() });
    assert.equal(F.writes.length, 1); assert.equal(F.docs.get(P(A1))[E360_KEY].terms[0].validFrom, REAL_START);
    M.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await t('IR17', 'NON-EMPLOYMENT EDITS never create a baseline: saving fødselsnummer / kontonummer on an old-register employee writes ONLY those two keys — no e360 block, opprettet / stilling / timelonn / aktiv identical — and the employee is still offered first registration; (deliberately changed in the closeout: this test used to assert that the employee-readable projection could be WRITTEN here) writing the employee-readable projection is now REFUSED with zero writes; first registration afterwards stores the REAL start date and keeps the private values', async () => {
  const W = world(); const keep = (d) => JSON.stringify([d.opprettet, d.stilling, d.timelonn, d.aktiv, d.navn, d.epost, d.adresse, d.notater]); const k0 = keep(W.stored(A1));
  await W.M.employees.privateFields.update(A1, { personnummer: '999999 12345', bankkonto: '0000.11.22334' });
  assert.equal(W.F.writes.length, 1);
  for (const w of W.F.writes) { assert.equal(w.kind, 'update'); assert.equal(w.path, P(A1)); assert.deepEqual(Object.keys(w.data).filter((k) => k !== 'personnummer' && k !== 'bankkonto'), [], 'only private keys'); }
  assert.ok(!(E360_KEY in W.stored(A1))); assert.equal(keep(W.stored(A1)), k0);
  W.M.employees.refresh(); assert.equal(needsInitialRegistration(W.emp(A1)), true);
  const n = W.F.writes.length;
  const se = await rejects(W.M.employeeSelf.write(A1, W.emp(A1), { onDate: TODAY, sourceRevision: 1 }));
  assert.ok(se && se.coreResult && se.coreResult.code === 'INITIAL_REGISTRATION_REQUIRED'); assert.equal(W.F.writes.length, n, 'zero writes');
  assert.ok(!(E360_KEY in W.stored(A1))); assert.equal(keep(W.stored(A1)), k0);
  const bank = W.stored(A1).bankkonto;
  await W.register(A1, REAL_START, REAL());
  const d = W.stored(A1); assert.equal(d[E360_KEY].startDate, REAL_START); assert.equal(d[E360_KEY].terms.length, 1); assert.equal(d.bankkonto, bank); assert.equal(d.opprettet, LEGACY_CREATED);
  W.M.dispose();
});

await t('IR18', '(static) UI WORDING: before registration the list row and the card header use the neutral label "Arbeidsforhold ikke registrert" (header: "… · Aktiv") through ONE helper instead of the old-register title; Oversikt shows Stilling / Startdato "Ikke registrert" and no compensation line; Lønn & økonomi does not present the old wage as lønnsgrunnlag; after registration the same helper returns the canonical role; the refusal has a plain Norwegian message', () => {
  const view = fs.readFileSync(path.join(HERE, 'management-employees-view.mjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(view.includes("  const UNREGISTERED_LABEL = 'Arbeidsforhold ikke registrert';"));
  assert.ok(view.includes('  const roleLineOf = (e, t) => (lacksEmploymentBaseline(e) ? UNREGISTERED_LABEL : roleOf(t ? t.role : null));'));
  assert.ok(view.includes('      const bits = [roleLineOf(e, t)];'), 'list row');
  assert.ok(view.includes("    root.appendChild(head(e.name, roleLineOf(e, cur) + ' · ' + statusLabelOf(e)));"), 'card header (shared by every tab incl. Kontrakt and Dokumenter)');   // ELA-V1a: status text through ONE helper (statusLabelOf), still beside roleLineOf
  assert.ok(!view.includes("head(e.name, roleOf(") && !view.includes('const bits = [roleOf(t ? t.role : null)];'), 'the old-register title is no longer the header/list line');
  assert.ok(view.includes("    card.appendChild(factRow('Stilling', unreg ? 'Ikke registrert' : roleOf(cur ? cur.role : null)));"));
  assert.ok(view.includes('    if (canViewCompensation(actor) && cur && cur.compensation && !unreg) {'));
  assert.ok(view.includes('    const c = lacksEmploymentBaseline(e) ? null : (cur && cur.compensation);'));
  assert.ok(view.includes("if (code === 'INITIAL_REGISTRATION_REQUIRED') return 'Arbeidsforholdet må registreres først. Gå til «Arbeidsforhold» og velg «Registrer arbeidsforhold».';"));
});

// ===================== FINAL LOCAL CLOSEOUT: employeeSelf law, Vaktplan neutrality, Oversikt contact =====================
const SELF = (id) => 'tenants/' + T + '/employeeSelf/' + id;
const SELF_KEYS = ['derivedAt', 'employmentType', 'expectedWeeklyHours', 'hasContract', 'name', 'percentage', 'role', 'sourceRevision', 'startDate', 'workplace'];
const selfWrites = (F) => F.writes.filter((w) => w.path.includes('/employeeSelf/'));
const isRequired = (e) => !!e && e.code === ADAPTER_ERROR.CORE_REFUSED && /INITIAL_REGISTRATION_REQUIRED/.test(e.message) && !!e.coreResult && e.coreResult.code === 'INITIAL_REGISTRATION_REQUIRED';

await t('IR19', 'EMPLOYEESELF BEFORE FIRST REGISTRATION: employeeSelf.write is refused CORE_REFUSED:INITIAL_REGISTRATION_REQUIRED for an ACTIVE and for an INACTIVE old-register employee; ZERO writes of any kind; no employeeSelf document exists; both ansatte documents are byte-identical and still have no employment block', async () => {
  const W = world(); const before = snap(W.F);
  for (const id of [A1, A4]) { const e = await rejects(W.M.employeeSelf.write(id, W.emp(id), { onDate: TODAY, sourceRevision: 1 })); assert.ok(isRequired(e), id + ' must be refused: ' + (e && e.message)); }
  assert.equal(W.F.writes.length, 0); assert.equal(snap(W.F), before);
  for (const id of [A1, A4]) { assert.ok(!W.F.docs.has(SELF(id))); assert.ok(!(E360_KEY in W.stored(id))); }
  W.M.dispose();
});

await t('IR20', 'EMPLOYEESELF BYPASS BLOCKED — the writer decides on the RAW stored document, not on what the caller hands it: for an unregistered employee a record with the old-register marker STRIPPED, with the marker FORGED to "has baseline", a hand-built record without any marker, and a registered colleague\'s record relabelled to this id are all refused (the stored document has no employment block); a colleague\'s record under a different id is refused (ansattId mismatch); and a STALE pre-registration record (marker stripped) used AFTER someone registered the employment is refused because its start date is the old creation date, not the stored one. Zero employeeSelf writes throughout; the old title and creation date never reach employeeSelf', async () => {
  const W = world(); const rec = W.emp(A1); const before = snap(W.F);
  const stripped = Object.assign({}, rec); delete stripped.legacy;
  const forged = Object.assign({}, rec, { legacy: { hasE360: true, aktiv: true, opprettet: LEGACY_CREATED } });
  const handBuilt = { ansattId: A1, name: 'Test Ansatt 01', status: 'active', contact: {}, terms: [{ validFrom: LEGACY_DATE, role: 'Fake tittel', employmentType: 'fast', percentage: 100 }], documents: [], contractVersions: [] };
  const relabelled = Object.assign({}, W.emp(A3), { ansattId: A1 });
  for (const [label, r] of [['stripped', stripped], ['forged', forged], ['handBuilt', handBuilt], ['relabelled', relabelled]]) { const e = await rejects(W.M.employeeSelf.write(A1, r, { onDate: TODAY, sourceRevision: 1 })); assert.ok(isRequired(e), label + ' must be refused by the raw read: ' + (e && e.message)); }
  const mism = await rejects(W.M.employeeSelf.write(A1, W.emp(A3), { onDate: TODAY })); assert.ok(mism && mism.code === ADAPTER_ERROR.PROJECTION_INVALID && /ansattId/.test(mism.message), 'another employee\'s record under this id');
  assert.equal(W.F.writes.length, 0); assert.equal(snap(W.F), before);
  await W.register(A1, REAL_START, REAL());
  const stale = await rejects(W.M.employeeSelf.write(A1, stripped, { onDate: TODAY, sourceRevision: 1 }));
  assert.ok(stale && stale.code === ADAPTER_ERROR.PROJECTION_INVALID && /sourceMismatch/.test(stale.message), 'stale synthetic record after registration: ' + (stale && stale.message));
  assert.equal(selfWrites(W.F).length, 0); assert.ok(!W.F.docs.has(SELF(A1)));
  assert.ok(!Array.from(W.F.docs.entries()).some(([p, d]) => p.includes('/employeeSelf/') && /Fake tittel|2026-06-20/.test(JSON.stringify(d))));
  W.M.dispose();
});

await t('IR21', 'EMPLOYEESELF AFTER FIRST REGISTRATION works normally: exactly ONE write, to tenants/{T}/employeeSelf/{same ansattId}; the document has exactly the accepted ten keys; role, start date, percentage, hours and workplace are the REGISTERED facts; the old title "Fake tittel" and the old creation date are absent; no wage / contact / id fields; the ansatte document is not touched by the projection write; an employee that already had a stored baseline (A3) projects exactly as before', async () => {
  const W = world();
  await W.register(A1, REAL_START, REAL()); const docAfterReg = JSON.stringify(W.stored(A1)); const n = W.F.writes.length;
  const r = await W.M.employeeSelf.write(A1, W.emp(A1), { onDate: TODAY, sourceRevision: 1 });
  assert.equal(r.ok, true); assert.equal(W.F.writes.length, n + 1); const w = W.F.writes[n]; assert.equal(w.kind, 'set'); assert.equal(w.path, SELF(A1));
  const d = W.F.docs.get(SELF(A1)); assert.deepEqual(Object.keys(d).sort(), SELF_KEYS);
  assert.deepEqual([d.name, d.role, d.employmentType, d.percentage, d.workplace, d.startDate, d.expectedWeeklyHours, d.sourceRevision], ['Test Ansatt 01', 'butikksjef', 'fast', 100, '4Seasons ferske varer', REAL_START, 37.5, 1]);
  const s = JSON.stringify(d); assert.ok(!/Fake tittel|2026-06-20|42000|monthlySalary|timelonn|bankkonto|personnummer|Testveien|example\.test/.test(s), s);
  assert.equal(JSON.stringify(W.stored(A1)), docAfterReg, 'the projection write does not touch the ansatte document');
  const r3 = await W.M.employeeSelf.write(A3, W.emp(A3), { onDate: TODAY, sourceRevision: 2 });
  assert.equal(r3.ok, true); const d3 = W.F.docs.get(SELF(A3)); assert.deepEqual(Object.keys(d3).sort(), SELF_KEYS); assert.equal(d3.startDate, '2024-01-02'); assert.equal(d3.role, 'butikkmedarbeider');
  W.M.dispose();
});

await t('IR22', 'VAKTPLAN NEUTRAL ROLE: before registration the people entry (production adapter people() AND the core vaktplanPeopleFrom) has roleKey null + unregistered:true — the old title is not a role and is nowhere in the entry — and the employee is still listed (assignable), same ansattId, nothing stored; a shift created for them would carry roleKey null; after registration the entry is exactly { ansattId, name, roleKey: canonical role } with no flag; (static) the Vaktplan view prints the neutral label "Arbeidsforhold ikke registrert" for a flagged person at both row sites and the standalone mount keeps the flag', async () => {
  const W = world();
  const b1 = W.M.employees.people().find((p) => p.ansattId === A1); assert.deepEqual(b1, { ansattId: A1, name: 'Test Ansatt 01', roleKey: null, unregistered: true });
  const b2 = vaktplanPeopleFrom(W.M.employees.store(), T, TODAY).find((p) => p.ansattId === A1); assert.equal(b2.roleKey, null); assert.equal(b2.unregistered, true); assert.equal(b2.name, 'Test Ansatt 01');
  assert.ok(!/Fake tittel/.test(JSON.stringify([b1, b2])));
  const reg3 = W.M.employees.people().find((p) => p.ansattId === A3); assert.deepEqual(reg3, { ansattId: A3, name: 'Har Grunnlag', roleKey: 'butikkmedarbeider' }, 'a registered employee is unchanged');
  assert.equal(W.M.employees.people().length, 3); assert.equal(W.F.writes.length, 0);
  await W.register(A1, REAL_START, REAL());
  assert.deepEqual(W.M.employees.people().find((p) => p.ansattId === A1), { ansattId: A1, name: 'Test Ansatt 01', roleKey: 'butikksjef' });
  const a2 = vaktplanPeopleFrom(W.M.employees.store(), T, TODAY).find((p) => p.ansattId === A1); assert.equal(a2.roleKey, 'butikksjef'); assert.ok(!('unregistered' in a2));
  const sv = fs.readFileSync(path.join(HERE, 'management-schedule-view.mjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(sv.includes("  const roleLineOf = (person) => (person && person.unregistered === true ? 'Arbeidsforhold ikke registrert' : roleOf(person ? person.roleKey : null));"));
  assert.equal(sv.split('roleLineOf(').length - 1, 2, 'both row sites'); assert.ok(sv.includes('const rl = roleLineOf(person);') && sv.includes('const rl = roleLineOf(r.person);'));
  assert.ok(!/roleOf\((r\.)?person\.roleKey\)/.test(sv), 'no row prints the role key directly');
  assert.ok(sv.includes("roleKey: !asManko && person ? person.roleKey : null"), 'shift creation semantics unchanged: the person entry\'s roleKey (null while unregistered)');
  const ui = fs.readFileSync(path.join(HERE, 'employee-shell-ui.mjs'), 'utf8');
  assert.ok(ui.includes("p.unregistered === true ? { ansattId: p.ansattId, name: p.name, roleKey: null, unregistered: true }"));
  assert.ok(ui.includes("roleKey: t && !(e.legacy && e.legacy.hasE360 === false) ? t.role : null"), 'the employee\'s own surface does not show the old title either');
  W.M.dispose();
});

await t('IR23', '(static) OVERSIKT CONTACT UX: for an unregistered employee Oversikt shows the short neutral line "Registrer arbeidsforholdet først. Kontaktopplysninger kan oppdateres etterpå." and Oversikt itself contains no input and no save action (opening it writes nothing); the ONLY contact editor in the product is step 1 of the contract flow, which is withheld before registration (button gated) and now also refuses to draw; after registration that editor is unchanged', () => {
  const view = fs.readFileSync(path.join(HERE, 'management-employees-view.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const a = view.indexOf('  function drawOversikt(e, cur) {'), b = view.indexOf('  const COMPLETABLE_TERMS');
  assert.ok(a > 0 && b > a); const ov = view.slice(a, b).replace(/^\s*\/\/.*$/gm, '');
  assert.ok(ov.includes("if (unreg && canEditEmployment(actor)) card.appendChild(el('div', { cls: 'cue-line emp-contact-gate', text: 'Registrer arbeidsforholdet først. Kontaktopplysninger kan oppdateres etterpå.' }));"));
  assert.ok(!/textInput\(|selectInput\(|btn\(|apply\(|applyC\(/.test(ov), 'Oversikt has no form control and no operation');
  assert.equal(view.split("kind: 'updateContact'").length - 1, 1, 'exactly one contact editor in the view');
  const c = view.indexOf('  function drawContractFlow() {'), d = view.indexOf('  function drawPreview() {'); const flow = view.slice(c, d);
  assert.ok(flow.includes("kind: 'updateContact'"), 'and it is step 1 of the contract flow');
  assert.ok(flow.includes("    if (lacksEmploymentBaseline(e)) { page = 'card'; section = 'arbeid'; return drawCard(); }"), 'which is never drawn before first registration');
  assert.ok(flow.indexOf('if (lacksEmploymentBaseline(e))') < flow.indexOf("kind: 'updateContact'"));
  assert.ok(!/e360|legacy|adapter|Firestore/i.test('Registrer arbeidsforholdet først. Kontaktopplysninger kan oppdateres etterpå.'));
});

// ===================== PLANNING COST: an unregistered employee never contributes cost from the old hourly wage =====================
const PWD = '2026-10-07';   // a planned day in the current month / week
const pms = (hm) => tenantLocalHMToUtcMs(PWD, hm, 'Europe/Oslo');
const planShift = (ansattId, roleKey) => ({ ansattId, workDate: PWD, status: 'assigned', plannedStartAt: pms('10:00'), plannedEndAt: pms('18:00'), roleKey, revision: 1 });
const WEEK = { kind: 'week', anchorWorkDate: PWD }, MONTH = { kind: 'month', year: 2026, month: 10 };

await t('IR24', 'VAKTPLAN PLANNING COST before / after first registration (old register: aktiv true, no stored baseline, fake timelønn 111): BEFORE — the person is present, role neutral, the compensation projection is null and the people entry carries NO compensation; with an 8-hour planned shift the planning summary row is model "unknown", estimatedVariableCost null (never 8 × 111 = 888, never 0), the total variable cost contains nothing from them and the omission "mangler lønnsgrunnlag" counts them (2 with the other old-register employee); nothing is persisted. AFTER registration with timelønn 250 (same ansattId, one period) — the projection is { timelonn, 250 }, the row costs 8 × 250 = 2000 and they leave the missing-wage count (2 -> 1). A registered colleague is unchanged throughout', async () => {
  const W = world();
  // registered colleague A3 gets an hourly wage so the before/after totals are meaningful
  W.F.seed(P(A3), Object.assign({}, W.stored(A3), { [E360_KEY]: Object.assign({}, W.stored(A3)[E360_KEY], { terms: [{ validFrom: '2024-01-02', role: 'butikkmedarbeider', compensation: { model: 'timelonn', hourlyRate: 200 } }] }) }));
  W.M.employees.refresh();
  const sched = { [T]: { sA1: planShift(A1, null), sA3: planShift(A3, 'butikkmedarbeider') } };
  const rec = W.emp(A1); assert.equal(rec.terms[0].compensation.hourlyRate, 111, 'the derived period still carries the old wage (read shape unchanged)');
  assert.equal(compensationProjectionOf(rec, TODAY), null);
  const people0 = vaktplanPeopleFrom(W.M.employees.store(), T, TODAY); const p0 = people0.find((p) => p.ansattId === A1);
  assert.deepEqual(p0, { ansattId: A1, name: 'Test Ansatt 01', roleKey: null, unregistered: true }, 'present, neutral, no compensation key');
  assert.deepEqual(compensationOf(p0), { model: 'unknown' });
  for (const scope of [WEEK, MONTH]) {
    const s = planningSummaryFor({ container: sched, tenantId: T, people: people0, scope });
    const row = s.rows.find((r) => r.ansattId === A1);
    assert.equal(row.model, 'unknown'); assert.equal(row.grossHours, 8); assert.equal(row.shiftCount, 1); assert.equal(row.plannedHourlyRate, null); assert.equal(row.estimatedVariableCost, null);
    assert.ok(row.notes.includes('Lønnsgrunnlag mangler – kostnad ikke beregnet (aldri satt til 0).'));
    assert.equal(s.rows.find((r) => r.ansattId === A3).estimatedVariableCost, 1600, 'registered colleague: 8 × 200');
    assert.equal(s.totals.variableCostKnown, 1600, 'nothing from the old wage in the total (would have been 1600 + 888)');
    assert.equal(s.totals.unknownCompensationCount, 2, 'both old-register employees (A1 and A2, old wage 99) are unknown'); assert.ok(s.omissions.includes('2 ansatt(e) mangler lønnsgrunnlag'));
    assert.ok(!/888|"plannedHourlyRate":111/.test(JSON.stringify(s)));
  }
  assert.equal(W.F.writes.length, 0, 'no persistence'); assert.ok(!(E360_KEY in W.stored(A1))); assert.equal(W.stored(A1).timelonn, 111, 'the old field itself is untouched');
  await W.register(A1, REAL_START, Object.assign(REAL(), { compensation: { model: 'timelonn', hourlyRate: 250 } }));
  assert.equal(W.F.writes.length, 1); assert.equal(W.stored(A1)[E360_KEY].terms.length, 1);
  assert.deepEqual(compensationProjectionOf(W.emp(A1), TODAY), { model: 'timelonn', plannedHourlyRate: 250 });
  const people1 = vaktplanPeopleFrom(W.M.employees.store(), T, TODAY); const p1 = people1.find((p) => p.ansattId === A1);
  assert.deepEqual(p1, { ansattId: A1, name: 'Test Ansatt 01', roleKey: 'butikksjef', compensation: { model: 'timelonn', plannedHourlyRate: 250 } });
  assert.equal(people1.filter((p) => p.name === 'Test Ansatt 01').length, 1, 'no second employee');
  const s1 = planningSummaryFor({ container: sched, tenantId: T, people: people1, scope: WEEK });
  const row1 = s1.rows.find((r) => r.ansattId === A1); assert.equal(row1.model, 'timelonn'); assert.equal(row1.estimatedVariableCost, 2000); assert.equal(s1.totals.variableCostKnown, 3600);
  assert.equal(s1.totals.unknownCompensationCount, 1, 'only the still-unregistered A2 remains unknown'); assert.ok(s1.omissions.includes('1 ansatt(e) mangler lønnsgrunnlag')); assert.ok(!row1.notes.some((n) => /Lønnsgrunnlag mangler/.test(n)));
  // fixed salary after registration follows the existing accepted law (month scope shows the monthly salary, no hourly cost)
  const W2 = world(); await W2.register(A1, REAL_START, REAL());
  const pf = vaktplanPeopleFrom(W2.M.employees.store(), T, TODAY).filter((p) => p.ansattId === A1);
  const sm = planningSummaryFor({ container: { [T]: { sA1: planShift(A1, 'butikksjef') } }, tenantId: T, people: pf, scope: MONTH });
  assert.equal(sm.rows[0].model, 'fastlonn'); assert.equal(sm.rows[0].fixedMonthlySalaryForScope, 42000); assert.equal(sm.rows[0].estimatedVariableCost, null);
  W.M.dispose(); W2.M.dispose();
});

await t('IR25', 'WORKFORCE PLANNING ECONOMY (month estimate) before / after: BEFORE — hourlyRateOn is null, the employee row has basis "mangler", estimateKr null, included false, note "kan ikke beregnes — mangler lønnsbasis", every shift line has rate null / kr null, the employee is a named exclusion (mangler_lonnsbasis) and the month estimate contains only the registered colleague (1600, not 2488); planned HOURS are still counted (16). AFTER registration with timelønn 250 — rate 250 on the shift, estimate 2000, included, exclusion gone, month estimate 3600', async () => {
  const W = world();
  W.F.seed(P(A3), Object.assign({}, W.stored(A3), { [E360_KEY]: Object.assign({}, W.stored(A3)[E360_KEY], { terms: [{ validFrom: '2024-01-02', role: 'butikkmedarbeider', compensation: { model: 'timelonn', hourlyRate: 200 } }] }) }));
  W.M.employees.refresh();
  const only = (store) => ({ [T]: { [A1]: store[T][A1], [A3]: store[T][A3] } });
  const sched = { [T]: { sA1: planShift(A1, null), sA3: planShift(A3, 'butikkmedarbeider') } };
  assert.equal(hourlyRateOn(W.emp(A1), PWD), null);
  const e0 = planningEconomyFor({ employeeStore: only(W.M.employees.store()), scheduleStore: sched, tenantId: T, periodId: '2026-10' });
  const r0 = e0.employees.find((x) => x.ansattId === A1);
  assert.equal(r0.basis, 'mangler'); assert.equal(r0.estimateKr, null); assert.equal(r0.included, false); assert.equal(r0.note, MISSING_BASIS_NOTE); assert.equal(r0.plannedHours, 8);
  assert.deepEqual(r0.shifts.map((s) => [s.hours, s.rate, s.kr]), [[8, null, null]]);
  assert.ok(e0.estimate.exclusions.some((x) => x.ansattId === A1 && x.reason === 'mangler_lonnsbasis'));
  assert.equal(e0.estimate.kr, 1600); assert.equal(e0.estimate.coveredCount, 1); assert.equal(e0.plannedHoursTotal, 16);
  assert.ok(!/888|2488|"rate":111/.test(JSON.stringify(e0)));
  assert.equal(W.F.writes.length, 0);
  await W.register(A1, REAL_START, Object.assign(REAL(), { compensation: { model: 'timelonn', hourlyRate: 250 } }));
  const e1 = planningEconomyFor({ employeeStore: only(W.M.employees.store()), scheduleStore: sched, tenantId: T, periodId: '2026-10' });
  const r1 = e1.employees.find((x) => x.ansattId === A1);
  assert.equal(r1.basis, 'timelonn'); assert.equal(r1.estimateKr, 2000); assert.equal(r1.included, true); assert.deepEqual(r1.shifts.map((s) => [s.rate, s.kr]), [[250, 2000]]);
  assert.ok(!e1.estimate.exclusions.some((x) => x.ansattId === A1)); assert.equal(e1.estimate.kr, 3600); assert.equal(e1.estimate.coveredCount, 2);
  assert.equal(e1.employees.filter((x) => x.ansattId === A1).length, 1);
  W.M.dispose();
});

await t('IR26', 'SHIFT CREATION SEMANTICS unchanged and no wage/title copied: creating a shift for the unregistered employee through the accepted schedule operation (with the roleKey of their people entry = null) succeeds; the stored shift has the same ansattId, status assigned, roleKey null and carries NO compensation / rate / wage field and no trace of the old title or wage; the employee store and the ansatte document are untouched', async () => {
  const W = world();
  const person = vaktplanPeopleFrom(W.M.employees.store(), T, TODAY).find((p) => p.ansattId === A1);
  const store = { [T]: {} };
  const r = applyScheduleOperation({ store, tenantId: T, actor: Object.assign({}, FOUR_SEASON_MANAGER_ACTOR, { tenantId: T }), op: { kind: 'create', workDate: PWD, ansattId: person.ansattId, fromHM: '10:00', toHM: '18:00', roleKey: person.roleKey }, now: NOW, policy: POLICY, deps: { resolveAssignee: (a) => ({ status: 'FOUND', tenantId: T, ansattId: a }) } });
  assert.equal(r.ok, true, 'create refused: ' + r.code);
  const shifts = tenantShiftsOf(store, T); assert.equal(shifts.length, 1);
  const p = shifts[0].projection; assert.equal(p.ansattId, A1); assert.equal(p.status, 'assigned'); assert.equal(p.roleKey, null); assert.equal(p.workDate, PWD);
  const blob = JSON.stringify(store); assert.ok(!/compensation|hourlyRate|timelonn|Fake tittel|111/.test(blob.replace(/\d{10,}/g, '')), blob);
  assert.equal(W.F.writes.length, 0); assert.ok(!(E360_KEY in W.stored(A1)));
  W.M.dispose();
});

// ===================== PAYROLL BASIS: the old wage is never shown, serialized or frozen as lønnsgrunnlag =====================
const PAY_PERIOD = '2026-10';
const PAY_ACTOR = { accessEnabled: true, canEditEmployment: true };
const payAtt = (ansattId, workDate) => { const inAt = tenantLocalHMToUtcMs(workDate, '08:00', 'Europe/Oslo'), outAt = tenantLocalHMToUtcMs(workDate, '16:00', 'Europe/Oslo'); return { attendanceId: 'att-' + ansattId + '-' + workDate, shiftId: 'sh-' + ansattId + '-' + workDate, ansattId, workDate, plannedSnapshot: { startAt: inAt, endAt: outAt }, observedClockInAt: inAt, observedClockOutAt: outAt, declaredStartAt: inAt, declaredEndAt: outAt, approvedStartAt: null, approvedEndAt: null, approvedByUid: null, approvedAt: null, status: 'clocked_out', breakState: 'working', openBreakStartedAt: null, observedBreakMinutesTotal: 0, declaredBreakMinutesTotal: null, approvedBreakMinutesTotal: null, breakCount: 0, revision: 1, createdAt: NOW, updatedAt: NOW }; };
const payPkg = (W, atts) => buildPayrollPackage({ employeeStore: W.M.employees.store(), scheduleStore: { [T]: {} }, attendanceStore: new Map((atts || []).map((a) => [a.attendanceId, a])), tenantId: T, periodId: PAY_PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
const approve = (store, pkg) => applyPayrollOperation({ store, tenantId: T, actor: PAY_ACTOR, op: { kind: 'approvePackage', periodId: PAY_PERIOD }, pkg, now: NOW, operatorName: 'Test' });
const OLD_WAGE = /111|"hourlyRate":99|kr 99 |Timelønn kr|Fake tittel|Delt tid/;

await t('IR27', 'PAYROLL BASIS before first registration (old register: aktiv, no stored employment, old timelønn 111, old title, creation date 2026-06-20): the employee is still a package row (membership law unchanged, same ansattId) but its wage basis is UNKNOWN — compensation null, compensationMissing true, fixedSalary false; the old wage / "Timelønn kr 111 per time" appears nowhere in the row, in the accountant payload or in the whole package; nothing is written and the employee document is unchanged (no e360). A registered colleague in the same package keeps the real basis', async () => {
  const W = world(); const before = snap(W.F);
  W.F.seed(P(A3), Object.assign({}, W.stored(A3), { [E360_KEY]: Object.assign({}, W.stored(A3)[E360_KEY], { terms: [{ validFrom: '2024-01-02', role: 'butikkmedarbeider', compensation: { model: 'timelonn', hourlyRate: 200 } }] }) }));
  W.M.employees.refresh(); const seeded = snap(W.F);
  assert.equal(W.emp(A1).terms[0].compensation.hourlyRate, 111, 'the read shape still carries the old wage (unchanged)');
  const pkg = payPkg(W);
  const row = pkg.rows.find((r) => r.ansattId === A1); assert.ok(row, 'row present'); assert.equal(pkg.rows.filter((r) => r.ansattId === A1).length, 1);
  assert.equal(row.payload.compensation, null); assert.equal(row.payload.compensationMissing, true); assert.equal(row.payload.fixedSalary, false); assert.equal(row.payload.fixedSalaryNote, null);
  const pay = accountantPayloadOf(pkg); const prow = pay.rows.find((r) => r.ansattId === A1); assert.equal(prow.compensation, null); assert.equal(prow.compensationMissing, true);
  const unregRows = JSON.stringify([row, prow, pkg.rows.find((r) => r.ansattId === A2), pay.rows.find((r) => r.ansattId === A2)]);
  assert.ok(!OLD_WAGE.test(unregRows.replace(/\d{10,}/g, '')), 'old wage / title in an unregistered row');
  const r3 = pkg.rows.find((r) => r.ansattId === A3); assert.deepEqual(r3.payload.compensation, { model: 'timelonn', hourlyRate: 200, label: 'Timelønn kr 200 per time' }); assert.equal(r3.payload.compensationMissing, false);
  assert.equal(W.F.writes.length, 0); assert.equal(snap(W.F), seeded); assert.ok(!(E360_KEY in W.stored(A1))); assert.equal(W.stored(A1).timelonn, 111);
  assert.notEqual(before, null);
  W.M.dispose();
});

await t('IR28', 'FROZEN PACKAGE SAFETY — the EXISTING missing-basis law decides, legacy compensation is never frozen: (A) no declared hours for the unregistered employee: the row is "klar" exactly like any employee without a wage basis, approval is ALLOWED and the frozen snapshot holds the explicit unknown state (compensation null, compensationMissing true) — the snapshot, the Employee-360 payroll projection and the accountant payload contain no 111, no "Timelønn kr 111 per time", no old title; (B) WITH declared hours (8 h): the existing hard finding mangler_lonnsbasis appears, the row is krever_oppmerksomhet, approval is REFUSED (NOT_READY naming the employee) and nothing is frozen — and the hours are not priced with the old wage anywhere', async () => {
  const W = world();
  const onlyA1 = { [T]: { [A1]: W.emp(A1) } };
  const build = (atts) => buildPayrollPackage({ employeeStore: onlyA1, scheduleStore: { [T]: {} }, attendanceStore: new Map((atts || []).map((a) => [a.attendanceId, a])), tenantId: T, periodId: PAY_PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  // (A) unknown state allowed
  const pkgA = build([]); assert.equal(pkgA.rows[0].readiness, 'klar'); assert.equal(pkgA.readiness.ready, true);
  const storeA = createPayrollStore(); const ra = approve(storeA, pkgA); assert.equal(ra.ok, true, 'approve: ' + ra.code);
  const frozen = ra.version.snapshot.rows[0]; assert.equal(frozen.payload.compensation, null); assert.equal(frozen.payload.compensationMissing, true);
  const blobA = JSON.stringify(ra.version).replace(/\d{10,}/g, ''); assert.ok(!OLD_WAGE.test(blobA), 'legacy compensation in the frozen version');
  const proj = payrollProjectionForEmployee(storeA, T, A1, PAY_PERIOD); assert.ok(proj); assert.ok(!OLD_WAGE.test(JSON.stringify(proj).replace(/\d{10,}/g, '')));
  assert.ok(Object.isFrozen(ra.version) && Object.isFrozen(ra.version.snapshot));
  // (B) declared hours without a basis: refused
  const pkgB = build([payAtt(A1, '2026-10-01')]); const rowB = pkgB.rows[0];
  assert.equal(rowB.payload.actualHours, 8); assert.equal(rowB.payload.compensation, null);
  assert.ok(rowB.exceptions.some((x) => x.code === 'mangler_lonnsbasis' && x.severity === 'hard')); assert.equal(rowB.readiness, 'krever_oppmerksomhet');
  assert.ok(rowB.payload.hardFindings.some((x) => x.code === 'mangler_lonnsbasis'));
  const storeB = createPayrollStore(); const rb = approve(storeB, pkgB);
  assert.equal(rb.ok, false); assert.equal(rb.code, 'NOT_READY'); assert.ok(rb.blocking.some((b) => b.ansattId === A1 && b.causes.includes('mangler_lonnsbasis')));
  assert.equal(storeB.versions.length, 0, 'nothing frozen');
  assert.ok(!/888|"hourlyRate":111|kr 111/.test(JSON.stringify(pkgB).replace(/\d{10,}/g, '')), '8 h x 111 is not computed or labelled anywhere');
  assert.equal(W.F.writes.length, 0); assert.ok(!(E360_KEY in W.stored(A1)));
  W.M.dispose();
});

await t('IR29', 'PAYROLL BASIS after first registration: (timelønn 250) the same row — same ansattId, exactly one row, one stored period — carries { timelonn, 250, "Timelønn kr 250 per time" }, compensationMissing false; with 8 declared hours there is no missing-basis finding, approval succeeds and the frozen snapshot + Employee-360 projection RETAIN the registered compensation, also after the live employee is changed later (copy by value); (fastlønn 42 000) the existing fixed-salary law applies: fixedSalary true, note "Fastlønn – timer er ikke lønnsgrunnlag", label "Fastlønn kr 42000 per måned", frozen as such', async () => {
  const W = world();
  await W.register(A1, REAL_START, Object.assign(REAL(), { compensation: { model: 'timelonn', hourlyRate: 250 } }));
  assert.equal(W.stored(A1)[E360_KEY].terms.length, 1);
  const only = () => ({ [T]: { [A1]: W.emp(A1) } });
  const pkg = buildPayrollPackage({ employeeStore: only(), scheduleStore: { [T]: {} }, attendanceStore: new Map([payAtt(A1, '2026-10-01')].map((a) => [a.attendanceId, a])), tenantId: T, periodId: PAY_PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  assert.equal(pkg.rows.length, 1); const row = pkg.rows[0]; assert.equal(row.ansattId, A1);
  assert.deepEqual(row.payload.compensation, { model: 'timelonn', hourlyRate: 250, label: 'Timelønn kr 250 per time' }); assert.equal(row.payload.compensationMissing, false); assert.equal(row.payload.actualHours, 8);
  assert.ok(!row.exceptions.some((x) => x.code === 'mangler_lonnsbasis')); assert.equal(row.readiness, 'klar');
  const store = createPayrollStore(); const r = approve(store, pkg); assert.equal(r.ok, true, 'approve: ' + r.code);
  assert.deepEqual(r.version.snapshot.rows[0].payload.compensation, { model: 'timelonn', hourlyRate: 250, label: 'Timelønn kr 250 per time' });
  await W.M.employees.apply({ kind: 'appendTerms', ansattId: A1, terms: { validFrom: TODAY, role: 'butikksjef', employmentForm: 'fast', employmentType: 'fast', percentage: 100, compensation: { model: 'timelonn', hourlyRate: 300 } } });
  assert.equal(payrollProjectionForEmployee(store, T, A1, PAY_PERIOD).compensation.hourlyRate, 250, 'the frozen version keeps the compensation it was approved with');
  assert.ok(!/"hourlyRate":111|kr 111/.test(JSON.stringify(r.version)));
  const W2 = world(); await W2.register(A1, REAL_START, REAL());
  const pkg2 = buildPayrollPackage({ employeeStore: { [T]: { [A1]: W2.emp(A1) } }, scheduleStore: { [T]: {} }, attendanceStore: new Map(), tenantId: T, periodId: PAY_PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  const f = pkg2.rows[0].payload; assert.deepEqual(f.compensation, { model: 'fastlonn', monthlySalary: 42000, label: 'Fastlønn kr 42000 per måned' }); assert.equal(f.fixedSalary, true); assert.equal(f.fixedSalaryNote, 'Fastlønn – timer er ikke lønnsgrunnlag');
  const r2 = approve(createPayrollStore(), pkg2); assert.equal(r2.ok, true); assert.equal(r2.version.snapshot.rows[0].payload.compensation.monthlySalary, 42000);
  W.M.dispose(); W2.M.dispose();
});

await t('IR30', '(static) one predicate, one seam: the payroll package decides the unknown state with the SAME shared helper as planning and Vaktplan (lacksEmploymentBaseline from the employee core) at the single place the row compensation is derived; the payroll views render compensation only from row.payload.compensation and already print "Ukjent – mangler lønnsbasis" / "Mangler lønnsbasis" when it is null', () => {
  const core = fs.readFileSync(path.join(HERE, 'management-payroll-core.mjs'), 'utf8');
  assert.ok(core.includes('    const compensation = lacksEmploymentBaseline(e) ? null : compensationOfTerms(terms);'));
  assert.equal(core.split('compensationOfTerms(').length - 1, 2, 'definition + exactly one call');
  assert.ok(/import \{[^}]*lacksEmploymentBaseline[^}]*\} from '\.\/management-employees-core\.mjs';/.test(core));
  const view = fs.readFileSync(path.join(HERE, 'management-payroll-view.mjs'), 'utf8');
  assert.ok(view.includes("row.payload.compensation ? row.payload.compensation.label : 'Ukjent – mangler lønnsbasis'"));
  assert.ok(view.includes("row.payload.compensation ? row.payload.compensation.label : 'Mangler lønnsbasis'"));
  assert.ok(!/\.terms\b|hourlyRate|monthlySalary|timelonn\b/.test(view.replace(/^\s*\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''")), 'the payroll view reads no employment terms or wage itself');
});

// ===================== PAYROLL START DATE: the old-register creation date is never an employment start =====================
// Old register: created 2026-06-20 (LEGACY_DATE). Periods: 2026-05 (before it), 2026-06 (contains it), 2026-10 (after it).
const pkgFor = (employeeStore, periodId, atts) => buildPayrollPackage({ employeeStore, scheduleStore: { [T]: {} }, attendanceStore: new Map((atts || []).map((a) => [a.attendanceId, a])), tenantId: T, periodId, generatedAt: NOW, todayWorkDate: TODAY });
const approveP = (store, pkg, periodId) => applyPayrollOperation({ store, tenantId: T, actor: PAY_ACTOR, op: { kind: 'approvePackage', periodId }, pkg, now: NOW, operatorName: 'Test' });
const OLD_START = /2026-06-20/;

await t('IR31', 'PAYROLL START DATE before first registration: registeredStartDateOf is null (startDateOf, the derived read shape, still returns the old creation date — unchanged for other readers); the employee is a package row in EVERY period regardless of the old creation date — also in 2026-05, the month BEFORE it (membership does not depend on it) — exactly one row, same ansattId; no "Startet i perioden" in any period, including 2026-06 which contains the old date; payload.employmentStartedInPeriod is null; the old creation date is nowhere in the row, the accountant payload or the package; the wage basis stays unknown; the planning month estimate uses the same inclusion; nothing is written and the document is unchanged (no e360). A registered colleague keeps the ordinary start law', async () => {
  const W = world(); const seeded = snap(W.F);
  const rec = W.emp(A1); assert.equal(startDateOf(rec), LEGACY_DATE); assert.equal(registeredStartDateOf(rec), null);
  assert.equal(registeredStartDateOf(W.emp(A3)), '2024-01-02', 'registered: the stored start');
  assert.equal(registeredStartDateOf({ status: 'active', terms: [{ validFrom: '2026-01-01' }] }), '2026-01-01', 'no old-register marker (preview fixture / new employee): unchanged');
  for (const periodId of ['2026-05', '2026-06', '2026-10']) {
    const pkg = pkgFor(W.M.employees.store(), periodId);
    const rows = pkg.rows.filter((r) => r.ansattId === A1); assert.equal(rows.length, 1, periodId + ': one row'); const row = rows[0];
    assert.ok(!row.exceptions.some((x) => x.code === 'startet_i_perioden'), periodId + ': no start warning'); assert.equal(row.payload.employmentStartedInPeriod, null, periodId);
    assert.equal(row.payload.compensation, null); assert.equal(row.payload.compensationMissing, true);
    const pay = accountantPayloadOf(pkg);
    for (const id of [A1, A2]) assert.ok(!OLD_START.test(JSON.stringify([pkg.rows.find((r) => r.ansattId === id), pay.rows.find((r) => r.ansattId === id)])), periodId + ' ' + id + ': old creation date serialized');
    assert.ok(!OLD_START.test(JSON.stringify(pkg)), periodId + ': old creation date anywhere in the package');
    const plan = planningEconomyFor({ employeeStore: W.M.employees.store(), scheduleStore: { [T]: {} }, tenantId: T, periodId });
    assert.equal(plan.employees.filter((x) => x.ansattId === A1).length, 1, periodId + ': planning inclusion follows the package');
    assert.equal(pkg.rows.some((r) => r.ansattId === A3), true, 'colleague (started 2024) is a member');
  }
  // the registered colleague's start law is untouched: not a member before the registered start, warned in the start month
  const s3 = { [T]: { [A3]: W.emp(A3) } };
  assert.equal(pkgFor(s3, '2023-12').rows.length, 0); const jan = pkgFor(s3, '2024-01').rows[0];
  assert.ok(jan.exceptions.some((x) => x.code === 'startet_i_perioden' && x.detail === '2024-01-02')); assert.equal(jan.payload.employmentStartedInPeriod, '2024-01-02');
  assert.equal(W.F.writes.length, 0); assert.equal(snap(W.F), seeded); assert.ok(!(E360_KEY in W.stored(A1))); assert.equal(W.stored(A1).opprettet, LEGACY_CREATED);
  W.M.dispose();
});

await t('IR32', 'FROZEN SNAPSHOT / EMPLOYEE-360 PROJECTION before registration carry the unknown start: a package for 2026-06 (the month containing the old creation date) is approved under the existing law (no declared hours) and the frozen version has employmentStartedInPeriod null, no "Startet i perioden", and the old creation date nowhere in the frozen version, the accountant payload or the Employee-360 payroll projection; same for 2026-05 and 2026-10', async () => {
  const W = world(); const only = { [T]: { [A1]: W.emp(A1) } };
  for (const periodId of ['2026-05', '2026-06', '2026-10']) {
    const pkg = pkgFor(only, periodId); assert.equal(pkg.rows.length, 1);
    const store = createPayrollStore(); const r = approveP(store, pkg, periodId); assert.equal(r.ok, true, periodId + ' approve: ' + r.code);
    const fr = r.version.snapshot.rows[0]; assert.equal(fr.payload.employmentStartedInPeriod, null); assert.ok(!fr.exceptions.some((x) => x.code === 'startet_i_perioden'));
    assert.ok(!OLD_START.test(JSON.stringify(r.version)), periodId + ': old creation date frozen');
    assert.ok(!OLD_START.test(JSON.stringify(accountantPayloadOf(pkg))));
    const proj = payrollProjectionForEmployee(store, T, A1, periodId); assert.ok(proj); assert.ok(!OLD_START.test(JSON.stringify(proj)));
    assert.equal(fr.payload.compensation, null);
  }
  assert.equal(W.F.writes.length, 0);
  W.M.dispose();
});

await t('IR33', 'PAYROLL START DATE after first registration (real start 2019-03-04, timelønn 250): registeredStartDateOf = 2019-03-04; membership follows the REAL start — not a member of 2019-02, a member of 2019-03 and of 2026-05/06/10; "Startet i perioden" (detail 2019-03-04) and payload.employmentStartedInPeriod = 2019-03-04 ONLY in 2019-03; no start warning in 2026-06 although the old creation date lies in it; the frozen 2019-03 snapshot retains 2019-03-04 and never 2026-06-20; registered compensation is used; one stored period, one row, same ansattId, no second employee', async () => {
  const W = world();
  await W.register(A1, REAL_START, Object.assign(REAL(), { compensation: { model: 'timelonn', hourlyRate: 250 } }));
  assert.equal(W.stored(A1)[E360_KEY].terms.length, 1); assert.equal(registeredStartDateOf(W.emp(A1)), REAL_START);
  const only = { [T]: { [A1]: W.emp(A1) } };
  assert.equal(pkgFor(only, '2019-02').rows.length, 0, 'not employed before the real start');
  assert.equal(planningEconomyFor({ employeeStore: only, scheduleStore: { [T]: {} }, tenantId: T, periodId: '2019-02' }).employees.length, 0);
  const mar = pkgFor(only, '2019-03'); assert.equal(mar.rows.length, 1);
  assert.ok(mar.rows[0].exceptions.some((x) => x.code === 'startet_i_perioden' && x.severity === 'warn' && x.detail === REAL_START)); assert.equal(mar.rows[0].payload.employmentStartedInPeriod, REAL_START);
  for (const periodId of ['2026-05', '2026-06', '2026-10']) {
    const pkg = pkgFor(only, periodId); assert.equal(pkg.rows.length, 1); const row = pkg.rows[0]; assert.equal(row.ansattId, A1);
    assert.ok(!row.exceptions.some((x) => x.code === 'startet_i_perioden'), periodId); assert.equal(row.payload.employmentStartedInPeriod, null, periodId);
    assert.deepEqual(row.payload.compensation, { model: 'timelonn', hourlyRate: 250, label: 'Timelønn kr 250 per time' });
    assert.ok(!OLD_START.test(JSON.stringify(pkg)));
  }
  const store = createPayrollStore(); const r = approveP(store, mar, '2019-03'); assert.equal(r.ok, true, 'approve: ' + r.code);
  assert.equal(r.version.snapshot.rows[0].payload.employmentStartedInPeriod, REAL_START); assert.ok(!OLD_START.test(JSON.stringify(r.version)));
  assert.equal(W.M.employees.people().filter((p) => p.name === 'Test Ansatt 01').length, 1);
  W.M.dispose();
});

await t('IR34', '(static) one helper, two seams: the payroll package and the planning month estimate both take the employment start from registeredStartDateOf (employee core) — the payroll core no longer reads startDateOf at all; the payroll view prints "Ansatt fra" only from payload.employmentStartedInPeriod', () => {
  const core = fs.readFileSync(path.join(HERE, 'management-employees-core.mjs'), 'utf8');
  assert.ok(core.includes('export function registeredStartDateOf(employee) { return lacksEmploymentBaseline(employee) ? null : startDateOf(employee); }'));
  const pay = fs.readFileSync(path.join(HERE, 'management-payroll-core.mjs'), 'utf8');
  assert.ok(pay.includes('    const started = registeredStartDateOf(e);')); assert.ok(!/\bstartDateOf\b/.test(pay.replace(/registeredStartDateOf/g, '')), 'no direct startDateOf in the payroll core');
  const plan = fs.readFileSync(path.join(HERE, 'management-planning-economy.mjs'), 'utf8');
  assert.ok(plan.includes('const started = e.terms && e.terms[0] ? registeredStartDateOf(e) : null;')); assert.ok(!plan.includes('e.terms[0].validFrom'));
  const view = fs.readFileSync(path.join(HERE, 'management-payroll-view.mjs'), 'utf8');
  assert.ok(view.includes("if (row.payload.employmentStartedInPeriod) c.appendChild(factRow('Ansatt fra', nbDateFromIso(row.payload.employmentStartedInPeriod)));"));
  assert.ok(!/startDateOf|opprettet/.test(view));
});

// ===================== MANAGER MANUAL TIME: fail closed before registration; real employment window after =====================
// Old register created 2026-06-20 (LEGACY_DATE). Days: before it, on it, after it. NOW = 2026-10-05.
const MT_ADMIN = { uid: 'uid-admin-1', accessRole: 'admin', ansattId: 'AdminAnsatt000000001', accessEnabled: true, tenantId: T };
const mtMs = (wd, hm) => tenantLocalHMToUtcMs(wd, hm, 'Europe/Oslo');
// THE caller rule of the manager surface (employee-shell-ui.mjs employmentOf), reproduced exactly as test U8 does
const employmentRule = (e) => ({ startDate: registeredStartDateOf(e), endDate: e.status === 'active' ? null : (e.endedAt || null) });
const manualEntry = (e, workDate, employment) => managerManualEntry({ actor: MT_ADMIN, existing: null, shift: null, ansattId: e.ansattId, workDate, declaredStartAt: mtMs(workDate, '08:00'), declaredEndAt: mtMs(workDate, '16:00'), declaredBreakMinutesTotal: 30, employment, reasonCode: 'RETROACTIVE_ENTRY', reasonNote: 'test', scope: { tenantId: T } }, NOW, POLICY);
const MT_DAYS = { before: '2026-06-10', on: LEGACY_DATE, after: '2026-07-15' };

await t('IR35', 'MANAGER MANUAL TIME before first registration: (the leak, shown with the OLD caller rule startDateOf) a day before the old creation date was refused BEFORE_EMPLOYMENT_START while the day on it and after it were accepted — the old date acted as employment start. With the caller rule now in the product (registeredStartDateOf -> start unknown) the engine refuses ALL THREE days with the SAME code EMPLOYMENT_REQUIRED, never BEFORE_EMPLOYMENT_START, and returns no attendance record and no event; the old creation date is not in the employment window passed to the engine; for active and inactive old-register employees; nothing is written, the document is unchanged, no e360', async () => {
  const W = world(); const before = snap(W.F); const rec = W.emp(A1);
  const oldRule = { startDate: startDateOf(rec), endDate: null }; assert.equal(oldRule.startDate, LEGACY_DATE);
  assert.equal(manualEntry(rec, MT_DAYS.before, oldRule).code, 'BEFORE_EMPLOYMENT_START'); assert.equal(manualEntry(rec, MT_DAYS.on, oldRule).ok, true); assert.equal(manualEntry(rec, MT_DAYS.after, oldRule).ok, true);
  for (const id of [A1, A4]) {
    const e = W.emp(id); const win = employmentRule(e);
    assert.equal(win.startDate, null); assert.ok(!JSON.stringify(win).includes(LEGACY_DATE), 'old creation date passed as an employment bound');
    const results = Object.values(MT_DAYS).map((d) => manualEntry(e, d, win));
    for (const r of results) { assert.equal(r.ok, false); assert.equal(r.code, 'EMPLOYMENT_REQUIRED'); assert.ok(!('attendance' in r) && !('event' in r), 'no record / event produced'); }
    assert.equal(new Set(results.map((r) => JSON.stringify(r))).size, 1, 'identical refusal before / on / after the old date');
  }
  assert.equal(W.F.writes.length, 0); assert.equal(snap(W.F), before); assert.ok(!(E360_KEY in W.stored(A1)));
  W.M.dispose();
});

await t('IR36', 'MANAGER MANUAL TIME after first registration (real start 2026-07-01, different from the old creation date 2026-06-20): the REGISTERED window is used — a day before the real start (2026-06-25, although AFTER the old creation date) is refused by the existing law BEFORE_EMPLOYMENT_START; the real start day and a later day succeed with the existing manual-entry semantics (record born "attested", declarationSource "manager", manual-keyed, ONE manager_manual_entry event, same ansattId); after the employment is ended (existing endEmployee) a day after the real end is refused AFTER_EMPLOYMENT_END and a day inside the window still succeeds; one stored period; an employee that already had a stored baseline behaves as before', async () => {
  const W = world();
  await W.register(A1, '2026-07-01', REAL());
  const e = W.emp(A1); const win = employmentRule(e); assert.deepEqual(win, { startDate: '2026-07-01', endDate: null });
  assert.equal(manualEntry(e, '2026-06-25', win).code, 'BEFORE_EMPLOYMENT_START', 'after the old creation date but before the REAL start');
  assert.equal(manualEntry(e, '2026-06-20', win).code, 'BEFORE_EMPLOYMENT_START', 'the old creation date itself is before the real start');
  for (const d of ['2026-07-01', '2026-07-15']) {
    const r = manualEntry(e, d, win); assert.equal(r.ok, true, d + ': ' + r.code);
    assert.equal(r.attendance.ansattId, A1); assert.equal(r.attendance.workDate, d); assert.equal(r.attendance.status, 'attested'); assert.equal(r.attendance.declarationSource, 'manager'); assert.equal(r.attendance.shiftId, null); assert.equal(r.attendance.revision, 1);
    assert.equal(r.event.type, 'manager_manual_entry');
  }
  await W.M.employees.apply({ kind: 'endEmployee', ansattId: A1, endDate: '2026-09-30' });
  const ended = W.emp(A1); const win2 = employmentRule(ended); assert.deepEqual(win2, { startDate: '2026-07-01', endDate: '2026-09-30' });
  assert.equal(manualEntry(ended, '2026-10-01', win2).code, 'AFTER_EMPLOYMENT_END'); assert.equal(manualEntry(ended, '2026-09-15', win2).ok, true);
  assert.equal(W.stored(A1)[E360_KEY].terms.length, 1);
  const e3 = W.emp(A3); const w3 = employmentRule(e3); assert.equal(w3.startDate, '2024-01-02');
  assert.equal(manualEntry(e3, '2023-12-31', w3).code, 'BEFORE_EMPLOYMENT_START'); assert.equal(manualEntry(e3, '2026-07-15', w3).ok, true);
  W.M.dispose();
});

await t('IR37', '(static) THE MANAGER GATE, AND NOTHING ELSE (Sirrha ruling 2026-10-06: ADD only): in employee-shell-ui.mjs the gate (manualBlockOf: lacksEmploymentBaseline -> INITIAL_REGISTRATION_REQUIRED) guards the ADD-a-new-day branch of submitManualTime — placed AFTER the correction branch has returned and BEFORE any shift resolution / engine call — and manualTimeContext marks a date blocked only when it would be a NEW day (never when it targets an existing record); it is referenced nowhere else (definition + exactly two uses), in particular by no employee clock-in / clock-out / break / persist path; the user-facing text for the code is exactly "Registrer arbeidsforholdet først."; the form shows it at once and disables Save; the frozen attendance engine (employee-shell-core.mjs) is byte-identical to its packaged copy (not edited for this) and keeps EMPLOYMENT_REQUIRED / BEFORE_EMPLOYMENT_START / AFTER_EMPLOYMENT_END unchanged', () => {
  const ui = fs.readFileSync(path.join(HERE, 'employee-shell-ui.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const sub = ui.slice(ui.indexOf('  function submitManualTime(form) {'), ui.indexOf('    const res = managerManualEntry({'));
  const iCorr = sub.indexOf("if (target.mode === 'correct' || target.mode === 'live' || form.mode === 'correct') {"), iRet = sub.indexOf('return persistManualAttendance(res);   // the ONE canonical store'), iGate = sub.indexOf('const block = manualBlockOf(form.ansattId);'), iShift = sub.indexOf('let shift = null;');
  assert.ok(iCorr > 0 && iRet > iCorr && iGate > iRet && iShift > iGate, 'gate sits after the correction branch and before the add path: ' + [iCorr, iRet, iGate, iShift].join(','));
  assert.ok(sub.includes('    const block = manualBlockOf(form.ansattId);\n    if (block) return { ok: false, code: block };'));
  assert.ok(!sub.slice(0, iCorr).includes('manualBlockOf'), 'the correction branch is reached without passing the gate');
  assert.ok(ui.includes("    const toExisting = target.mode === 'correct' || target.mode === 'live' || target.mode === 'choose_record';   // never a new day\n    if (block && !toExisting) return { mode: 'blocked', blocked: true, code: block, reasonCodes: [], hint: manualErrorText(block), candidates: [] };"));
  assert.ok(ui.includes("    return e && lacksEmploymentBaseline(e) ? 'INITIAL_REGISTRATION_REQUIRED' : null;"));
  assert.equal(ui.split('manualBlockOf(').length - 1, 3, 'definition + submit + context, nothing else');
  assert.ok(!/startDate: startDateOf\(e\), endDate/.test(ui), 'the old caller rule is gone');
  assert.equal(manualErrorText('INITIAL_REGISTRATION_REQUIRED'), 'Registrer arbeidsforholdet først.');
  assert.equal(manualErrorText('BEFORE_EMPLOYMENT_START'), 'Datoen er før ansettelsen startet.'); assert.equal(manualErrorText('AFTER_EMPLOYMENT_END'), 'Datoen er etter at ansettelsen ble avsluttet.');
  const view = fs.readFileSync(path.join(HERE, 'management-payroll-view.mjs'), 'utf8');
  assert.ok(view.includes("if (c && c.blocked) { hintBox.appendChild(el('div', { cls: 'mt-notice warn mt-blocked', text: c.hint })); if (saveBtn) saveBtn.disabled = true; return; }"));
  const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  assert.equal(sha(path.join(HERE, 'employee-shell-core.mjs')), sha(path.join(HERE, 'functions', 'shared', 'employee-shell-core.mjs')), 'engine identical to the packaged copy');
  const core = fs.readFileSync(path.join(HERE, 'employee-shell-core.mjs'), 'utf8');
  assert.ok(core.includes("if (workDate < employment.startDate) return err('BEFORE_EMPLOYMENT_START');") && core.includes("return err('AFTER_EMPLOYMENT_END');") && !/INITIAL_REGISTRATION|lacksEmploymentBaseline|hasE360|e360/.test(core), 'the engine knows nothing about registration: live attendance is not gated');
  const adapters = fs.readFileSync(path.join(HERE, 'employee-production-adapters.mjs'), 'utf8');
  const commit = adapters.slice(adapters.indexOf('export function makeAttendanceCommitter'), adapters.indexOf('// ---- shared employeeSelf writer'));
  assert.ok(commit.length > 200 && !/INITIAL_REGISTRATION|e360|hasE360|lacksEmploymentBaseline/.test(commit), 'the attendance commit seam (used by live clock-in/out/breaks too) is not gated');
});

await t('IR38', 'KORRIGER LAW PRESERVED (Sirrha ruling): correcting an EXISTING attendance record of an unregistered employee follows the existing correction law untouched — managerCorrection takes no employment window at all (the old creation date cannot enter), accepts only declared start / end / break / note, refuses any attempt to change attendanceId, workDate, ansattId or status (FIELD_NOT_CORRECTABLE), keeps identity and workDate, bumps the revision by one and yields ONE manager event; it cannot create a day (an engine call without an existing record is refused, and the committer treats revision > 1 as an UPDATE of the existing document only)', () => {
  const W = world(); const e = W.emp(A1); assert.equal(lacksEmploymentBaseline(e), true);
  const wd = '2026-07-15';
  const existing = { attendanceId: 'man-' + wd + '-' + A1, shiftId: null, ansattId: A1, workDate: wd, plannedSnapshot: null, observedClockInAt: mtMs(wd, '08:02'), observedClockOutAt: mtMs(wd, '16:04'), declaredStartAt: mtMs(wd, '08:02'), declaredEndAt: mtMs(wd, '16:04'), approvedStartAt: null, approvedEndAt: null, approvedByUid: null, approvedAt: null, status: 'clocked_out', breakState: 'working', openBreakStartedAt: null, observedBreakMinutesTotal: 0, declaredBreakMinutesTotal: null, approvedBreakMinutesTotal: null, breakCount: 0, revision: 1, createdAt: NOW - 3600000, updatedAt: NOW - 3600000 };
  const corr = (patch) => managerCorrection({ actor: MT_ADMIN, existing, patch, reasonCode: 'RETROACTIVE_ENTRY', reasonNote: 'test', scope: { tenantId: T } }, NOW, POLICY);
  const ok = corr({ declaredEndAt: mtMs(wd, '16:00'), declaredBreakMinutesTotal: 30 });
  assert.equal(ok.ok, true, ok.code); assert.equal(ok.attendance.attendanceId, existing.attendanceId); assert.equal(ok.attendance.workDate, wd); assert.equal(ok.attendance.ansattId, A1); assert.equal(ok.attendance.revision, 2); assert.equal(ok.attendance.declaredEndAt, mtMs(wd, '16:00')); assert.equal(ok.attendance.observedClockOutAt, existing.observedClockOutAt, 'observed untouched');
  assert.ok(ok.event && /manager/.test(ok.event.type)); assert.ok(!JSON.stringify(ok).includes(LEGACY_DATE));
  for (const bad of [{ attendanceId: 'other' }, { workDate: '2026-07-16' }, { ansattId: A2 }, { status: 'approved' }]) { const r = corr(bad); assert.equal(r.ok, false); assert.ok(/^FIELD_NOT_CORRECTABLE:/.test(r.code), JSON.stringify(bad) + ' -> ' + r.code); }
  assert.equal(corr({}).code, 'NO_CHANGE');
  const noRecord = managerCorrection({ actor: MT_ADMIN, existing: null, patch: { declaredEndAt: mtMs(wd, '16:00') }, reasonCode: 'RETROACTIVE_ENTRY', reasonNote: 'test', scope: { tenantId: T } }, NOW, POLICY);
  assert.equal(noRecord.ok, false, 'a correction can never create a day');
  const core = fs.readFileSync(path.join(HERE, 'employee-shell-core.mjs'), 'utf8');
  assert.ok(/export function managerCorrection\(\{ actor, existing, patch, reasonCode, reasonNote, scope \}, now, policy\)/.test(core), 'no employment parameter');
  assert.ok(core.includes("const MANAGER_CORRECTABLE = ['declaredStartAt', 'declaredEndAt', 'note', 'declaredBreakMinutesTotal'];"));
  const adapters = fs.readFileSync(path.join(HERE, 'employee-production-adapters.mjs'), 'utf8');
  assert.ok(adapters.includes("if (op.create === true || rec.revision === 1) {") && adapters.includes('tx.update(ref, Object.assign({}, use.attendance, { serverUpdatedAt: st() }));'), 'revision > 1 is an update of the existing document');
  W.M.dispose();
});

for (const l of lines) console.log(l);
console.log('MANAGEMENT_INITIAL_REGISTRATION_TESTS: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
