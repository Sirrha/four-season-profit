// management-initial-period-completion.test.mjs — INITIAL PERIOD COMPLETION vs GENUINE CHANGE (node built-ins only).
// Owner law (SIRRHA-CCODE-SORMENA-EMPLOYEE-INITIAL-PERIOD-COMPLETION-LOCAL-004): filling the blanks of a newly created
// employee's ONE starting period completes THAT period (completeCurrentTerms: start date preserved, period count stays 1);
// only a genuine later change creates period #2 (appendTerms). I-cases mirror the release's proof list at core / adapter /
// downstream / view-law level. Run: node management-initial-period-completion.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyEmployeeOperation, employeeOf, missingInfoOf, currentTermsOf, vaktplanPeopleFrom, startDateOf } from './management-employees-core.mjs';
import { createManagementAdapters, normalizeAnsatt, E360_KEY, ansattePath } from './management-production-adapters.mjs';
import { planningEconomyFor } from './management-planning-economy.mjs';
import { buildPayrollPackage } from './management-payroll-core.mjs';
import { ETR2A_POLICY as POLICY } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }
const T = 'four-season-as';
const ACTOR = { uid: 'u-admin', accessRole: 'admin', ansattId: null, accessEnabled: true, tenantId: T, canManageSchedule: true, canViewOwnSchedule: false, canViewEmployeeCore: true, canViewEmployeeCompensation: true, canEditEmployment: true };
const NOW = Date.UTC(2026, 8, 27, 10, 0, 0);   // 2026-09-27 12:00 Oslo
const TODAY = '2026-09-27';
const CREATE = { kind: 'createEmployee', name: 'Test Ansatt 01', startDate: '2026-08-01', role: 'butikkmedarbeider' };
const COMPLETION = { employmentType: 'deltid', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 210 }, expectedWeeklyHours: 18.75, noticePeriod: '1 måned' };
const fresh = () => { const store = { [T]: {} }; const r = applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op: CREATE, now: NOW }); assert.equal(r.ok, true); return { store, id: r.ansattId }; };
const snapshotTerms = (e) => JSON.parse(JSON.stringify(e.terms));

await t('I01', 'initial state after quick-create: exactly ONE period, validFrom 2026-08-01, role set, completable terms blank, accepted completeness law reports the blanks, no later period', () => {
  const { store, id } = fresh(); const e = employeeOf(store, T, id);
  assert.equal(e.terms.length, 1); assert.equal(e.terms[0].validFrom, '2026-08-01'); assert.equal(startDateOf(e), '2026-08-01'); assert.equal(e.terms[0].role, 'butikkmedarbeider');
  for (const f of ['employmentType', 'percentage', 'compensation', 'expectedWeeklyHours', 'noticePeriod']) assert.equal(e.terms[0][f], null, f);
  const m = missingInfoOf(e, TODAY); for (const x of ['mangler stillingstype', 'mangler arbeidsprosent', 'mangler lønnsgrunnlag']) assert.ok(m.includes(x), x);
});
await t('I03', 'completeCurrentTerms fills the blanks ON THE SAME PERIOD: count stays 1, validFrom stays 2026-08-01, role preserved, supplied values present; no period dated today exists', () => {
  const { store, id } = fresh();
  const r = applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op: { kind: 'completeCurrentTerms', ansattId: id, terms: COMPLETION }, now: NOW });
  assert.equal(r.ok, true);
  const e = employeeOf(store, T, id);
  assert.equal(e.terms.length, 1); assert.equal(e.terms[0].validFrom, '2026-08-01'); assert.equal(e.terms[0].role, 'butikkmedarbeider');
  assert.equal(e.terms[0].employmentType, 'deltid'); assert.equal(e.terms[0].percentage, 50); assert.deepEqual(e.terms[0].compensation, { model: 'timelonn', hourlyRate: 210 }); assert.equal(e.terms[0].expectedWeeklyHours, 18.75); assert.equal(e.terms[0].noticePeriod, '1 måned');
  assert.ok(!e.terms.some((x) => x.validFrom === TODAY), 'no fake change period dated today');
  const m = missingInfoOf(e, TODAY); for (const x of ['mangler stillingstype', 'mangler arbeidsprosent', 'mangler lønnsgrunnlag']) assert.ok(!m.includes(x), 'stale: ' + x);
});
await t('I04', 'history truth: completion never rewrites a set value (TERMS_VALUE_ALREADY_SET, record untouched) and never touches validFrom (validFrom is not an accepted completion field)', () => {
  const { store, id } = fresh();
  assert.equal(applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op: { kind: 'completeCurrentTerms', ansattId: id, terms: COMPLETION }, now: NOW }).ok, true);
  const before = snapshotTerms(employeeOf(store, T, id));
  const r = applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op: { kind: 'completeCurrentTerms', ansattId: id, terms: { percentage: 60 } }, now: NOW });
  assert.equal(r.ok, false); assert.equal(r.code, 'TERMS_VALUE_ALREADY_SET:percentage');
  const r2 = applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op: { kind: 'completeCurrentTerms', ansattId: id, terms: { validFrom: '2026-09-01' } }, now: NOW });
  assert.equal(r2.ok, false); assert.match(r2.code, /TERMS_FIELD_NOT_ALLOWED:validFrom/);
  assert.deepEqual(snapshotTerms(employeeOf(store, T, id)), before);
});
await t('I05', 'genuine later change still creates period #2 via appendTerms (effective 2026-10-01): period #1 byte-identical, #2 carries forward and becomes current from its date', () => {
  const { store, id } = fresh();
  assert.equal(applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op: { kind: 'completeCurrentTerms', ansattId: id, terms: COMPLETION }, now: NOW }).ok, true);
  const p1 = snapshotTerms(employeeOf(store, T, id))[0];
  const r = applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op: { kind: 'appendTerms', ansattId: id, terms: { validFrom: '2026-10-01', role: 'butikksjef' } }, now: NOW });
  assert.equal(r.ok, true);
  const e = employeeOf(store, T, id);
  assert.equal(e.terms.length, 2); assert.deepEqual(JSON.parse(JSON.stringify(e.terms[0])), p1);
  assert.equal(e.terms[1].validFrom, '2026-10-01'); assert.equal(e.terms[1].role, 'butikksjef'); assert.equal(e.terms[1].percentage, 50);
  assert.equal(currentTermsOf(e, '2026-09-27').validFrom, '2026-08-01'); assert.equal(currentTermsOf(e, '2026-10-15').validFrom, '2026-10-01');
});
await t('I06', 'non-eligible cases: a period referenced by a frozen contract is refused (TERMS_PERIOD_FROZEN_IN_CONTRACT); with 2+ periods completion targets only the latest and the view offers no completion mode (static law below); a genuine change request is never routed through completion', () => {
  const { store, id } = fresh(); const e = employeeOf(store, T, id);
  e.contractVersions = [{ contractVersionId: 'kv-x-1', status: 'godkjent_frosset', termsPeriodRef: '2026-08-01' }];
  const r = applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op: { kind: 'completeCurrentTerms', ansattId: id, terms: { percentage: 50 } }, now: NOW });
  assert.equal(r.ok, false); assert.equal(r.code, 'TERMS_PERIOD_FROZEN_IN_CONTRACT'); assert.equal(e.terms[0].percentage, null);
  const two = fresh(); assert.equal(applyEmployeeOperation({ store: two.store, tenantId: T, actor: ACTOR, op: { kind: 'appendTerms', ansattId: two.id, terms: { validFrom: '2026-10-01', role: 'butikksjef' } }, now: NOW }).ok, true);
  const first = snapshotTerms(employeeOf(two.store, T, two.id))[0];
  assert.equal(applyEmployeeOperation({ store: two.store, tenantId: T, actor: ACTOR, op: { kind: 'completeCurrentTerms', ansattId: two.id, terms: { percentage: 80 } }, now: NOW }).ok, true);
  const e2 = employeeOf(two.store, T, two.id);
  assert.deepEqual(JSON.parse(JSON.stringify(e2.terms[0])), first, 'superseded first period never mutated'); assert.equal(e2.terms[1].percentage, 80);
});
await t('I03-adapter', 'production persistence: completion is ONE update on the canonical ansatte document — e360.terms stays length 1 with validFrom 2026-08-01 and the completed values, e360.rev advances 1 -> 2 (lastOp completeCurrentTerms), legacy timelonn projection 210, stilling unchanged; no other path written (no employeeSelf/vakter side effect)', async () => {
  const docs = new Map(); const writes = []; const ST = { st: true };
  const apply = (w) => { for (const [k, p, d] of w) { writes.push(p); if (k === 'set') docs.set(p, JSON.parse(JSON.stringify(d))); else docs.set(p, Object.assign({}, docs.get(p), JSON.parse(JSON.stringify(d)))); } };
  const fsx = { doc: (p) => ({ path: p }), newId: () => 'TestAnsatt0100000001', serverTimestamp: () => ST, listen: () => () => {}, runTransaction: async (fn) => { const w = []; const out = await fn({ get: async (r) => ({ exists: docs.has(r.path), data: docs.get(r.path) }), set: (r, d) => w.push(['set', r.path, d]), update: (r, d) => w.push(['update', r.path, d]) }); apply(w); return out; }, batch: () => { const w = []; return { set: (r, d) => w.push(['set', r.path, d]), update: (r, d) => w.push(['update', r.path, d]), commit: async () => apply(w) }; } };
  const readAnsatte = () => Array.from(docs.entries()).filter(([p]) => p.startsWith(ansattePath(T) + '/')).map(([p, d]) => Object.assign({ id: p.split('/').pop() }, d));
  const M = createManagementAdapters({ fs: fsx, tenantId: T, membership: { uid: 'u', tenantId: T, accessRole: 'admin', ansattId: null, accessEnabled: true }, range: { from: '2026-08-01', to: '2026-12-31' }, readAnsatte, defaultContractProfile: { tenantId: T, companyFacts: {} }, policy: POLICY, nowMs: () => NOW });
  M.start();
  const c = await M.employees.apply(CREATE); const id = c.ansattId;
  const d1 = docs.get(ansattePath(T, id)); assert.equal(d1[E360_KEY].rev, 1); assert.equal(d1[E360_KEY].terms.length, 1);
  const r = await M.employees.apply({ kind: 'completeCurrentTerms', ansattId: id, terms: COMPLETION });
  assert.equal(r.ok, true);
  const d2 = docs.get(ansattePath(T, id));
  assert.equal(d2[E360_KEY].terms.length, 1); assert.equal(d2[E360_KEY].terms[0].validFrom, '2026-08-01'); assert.equal(d2[E360_KEY].terms[0].percentage, 50); assert.deepEqual(d2[E360_KEY].terms[0].compensation, { model: 'timelonn', hourlyRate: 210 });
  assert.equal(d2[E360_KEY].rev, 2); assert.equal(d2[E360_KEY].lastOp, 'completeCurrentTerms'); assert.equal(d2[E360_KEY].startDate, '2026-08-01');
  assert.equal(d2.timelonn, 210); assert.equal(d2.stilling, 'butikkmedarbeider'); assert.equal(d2.navn, 'Test Ansatt 01');
  assert.ok(writes.every((p) => p === ansattePath(T, id)), 'only the canonical document written: ' + writes.join(','));
  const rec = M.employees.store()[T][id]; assert.equal(rec.terms.length, 1); assert.equal(rec.terms[0].percentage, 50);
  M.dispose();
});
await t('I07', 'downstream after completion (one period): Vaktplan people = 1 with derived compensation; planning coverage "1 av 1"; payroll row uses timelønn 210; no stale missing chips for the completed fields', () => {
  const { store, id } = fresh();
  assert.equal(applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op: { kind: 'completeCurrentTerms', ansattId: id, terms: COMPLETION }, now: NOW }).ok, true);
  const people = vaktplanPeopleFrom(store, T, TODAY); assert.equal(people.length, 1); assert.equal(people[0].ansattId, id); assert.ok(people[0].compensation && people[0].compensation.model === 'timelonn' && people[0].compensation.plannedHourlyRate === 210);
  const plan = planningEconomyFor({ employeeStore: store, scheduleStore: { [T]: {} }, tenantId: T, periodId: '2026-09' });
  assert.equal(plan.estimate.coverageLine, 'estimatet dekker 1 av 1 ansatte (timelønn)'); assert.equal(plan.employees[0].basis, 'timelonn');
  const pkg = buildPayrollPackage({ employeeStore: store, scheduleStore: { [T]: {} }, attendanceStore: new Map(), tenantId: T, periodId: '2026-09', generatedAt: NOW, todayWorkDate: TODAY });
  assert.equal(pkg.rows.length, 1); assert.equal(pkg.rows[0].payload.compensation.model, 'timelonn'); assert.equal(pkg.rows[0].payload.compensation.hourlyRate, 210); assert.equal(pkg.rows[0].payload.compensationMissing, false);
  const m = missingInfoOf(employeeOf(store, T, id), TODAY); assert.deepEqual(m.filter((x) => /stillingstype|arbeidsprosent|lønnsgrunnlag/.test(x)), []);
});
await t('I02-law', 'view law (static): Arbeidsforhold offers the completion mode ("Fullfør eksisterende arbeidsforhold" -> completeCurrentTerms, start date locked) ONLY when exactly one period exists, it is not frozen in a contract and a completable term is blank; the genuine "Ny periode (endring)" (appendTerms, validFrom input) remains the path for a later change', () => {
  const v = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  assert.ok(v.includes("text: 'Fullfør eksisterende arbeidsforhold'"));
  assert.ok(v.includes("apply({ kind: 'completeCurrentTerms', ansattId: e.ansattId, terms: patch });"));
  assert.ok(v.includes("if (!e || !Array.isArray(e.terms) || e.terms.length !== 1) return null;"), 'exactly one period');
  assert.ok(v.includes("if ((e.contractVersions || []).some((v) => v.status === 'godkjent_frosset' && v.termsPeriodRef === t.validFrom)) return null;"), 'frozen lock');
  assert.ok(v.includes("const COMPLETABLE_TERMS = ['employmentType', 'percentage', 'compensation', 'expectedWeeklyHours', 'noticePeriod'];"));
  assert.ok(v.includes("const vf = lock(textInput(fmtDate(t.validFrom), null, 'text'));"), 'start date shown and locked');
  assert.ok(v.includes("text: 'Ny periode (endring)'") && v.includes("apply({ kind: 'appendTerms', ansattId: e.ansattId, terms });") && v.includes("const vf = textInput(todayWd, null, 'date');"), 'genuine change path intact');
  assert.ok(v.includes("(!completion || arbeidChangeOpen)"), 'change form secondary while completion is offered');
  const arbeid = v.slice(v.indexOf('  function drawArbeid(e, cur) {'), v.indexOf('    const hist = el(', v.indexOf('  function drawArbeid(e, cur) {')));
  assert.equal((arbeid.match(/textInput\(todayWd, null, 'date'\)/g) || []).length, 1, 'within Arbeidsforhold, today is the default ONLY for a genuine new period');
  assert.ok(arbeid.indexOf("text: 'Fullfør eksisterende arbeidsforhold'") < arbeid.indexOf("text: 'Ny periode (endring)'"), 'completion mode is rendered first');
});

for (const l of lines) console.log(l);
console.log('MANAGEMENT_INITIAL_PERIOD_COMPLETION_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
