// management-employees-core.test.mjs
// EMPLOYEE 360 CORE — deterministic tests. Node built-ins only; all dates INJECTED.
// Run: node management-employees-core.test.mjs

import assert from 'node:assert/strict';
import {
  seedFourSeasonEmployees, employeesOf, employeeOf, startDateOf, currentTermsOf, termsWithRanges,
  contractStatusOf, missingInfoOf, compensationProjectionOf, vaktplanPeopleFrom,
  plannedHoursForEmployee, upcomingShiftsForEmployee, applyEmployeeOperation,
  canViewEmployees, canViewCompensation, canEditEmployment,
} from './management-employees-core.mjs';
import { buildFourSeasonSchedule, FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MANAGER_ACTOR } from './employee-schedule-fixture.mjs';
import { compensationOf, planningSummaryFor } from './management-schedule-core.mjs';
import { tenantLocalHMToUtcMs, ETR2A_POLICY } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const TZ = ETR2A_POLICY.timezone;
const T = FOUR_SEASON_TENANT.tenantId;
const TODAY = '2026-08-31';
const ANCHOR = '2026-08-26';
const MGR = FOUR_SEASON_MANAGER_ACTOR;
const seedE = () => seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
const applyE = (store, op, over) => applyEmployeeOperation(Object.assign({ store, tenantId: T, actor: MGR, op, now: 0 }, over || {}));

t('E1', 'create requires exactly navn + startdato + rolle; succeeds with only those three', () => {
  const store = seedE();
  assert.equal(applyE(store, { kind: 'createEmployee', name: '', startDate: '2026-09-01', role: 'butikkmedarbeider' }).code, 'NAME_REQUIRED');
  assert.equal(applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: 'x', role: 'butikkmedarbeider' }).code, 'STARTDATE_INVALID');
  assert.equal(applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: '' }).code, 'ROLE_REQUIRED');
  const r = applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  assert.equal(r.ok, true, r.code);
  assert.equal(r.ansattId, 'ans-nora');
  assert.ok(employeesOf(store, T).some((e) => e.ansattId === 'ans-nora'));
  assert.equal(r.employee.terms.length, 1);
});
t('E2', 'created employee is VALID and visibly incomplete (derived markers, no invented values)', () => {
  const store = seedE();
  const r = applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  const miss = missingInfoOf(r.employee, '2026-09-02');
  assert.ok(miss.includes('mangler arbeidsprosent'));
  assert.ok(miss.includes('mangler lønnsgrunnlag'));
  assert.ok(miss.includes('mangler kontrakt'));
  assert.ok(miss.includes('mangler stillingstype'));
  assert.equal(r.employee.terms[0].percentage, null);
  assert.equal(r.employee.terms[0].compensation, null);
});
t('E3', 'first terms validFrom IS the start-date truth (no second start-date field)', () => {
  const store = seedE();
  const r = applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  assert.equal(startDateOf(r.employee), '2026-09-01');
  assert.equal(r.employee.terms[0].role, 'butikkmedarbeider');
  assert.ok(!('startDate' in r.employee) && !('startDato' in r.employee));
});
t('E4', 'current terms selection by date (latest validFrom on/before; null before first period)', () => {
  const store = seedE();
  const emp = employeeOf(store, T, 'ans-maria');                     // validFrom 2023-03-01
  assert.equal(applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', role: 'butikksjef' } }).ok, true);
  assert.equal(currentTermsOf(emp, '2026-08-31').role, 'butikkmedarbeider');
  assert.equal(currentTermsOf(emp, '2026-09-01').role, 'butikksjef');
  assert.equal(currentTermsOf(emp, '2022-01-01'), null);
});
t('E5', 'append preserves earlier terms records unchanged (same frozen object, same content)', () => {
  const store = seedE();
  const emp = employeeOf(store, T, 'ans-maria');
  const first = emp.terms[0];
  const snapshot = JSON.stringify(first);
  assert.equal(applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', role: 'butikksjef' } }).ok, true);
  assert.equal(emp.terms[0], first);                                 // same object reference
  assert.equal(JSON.stringify(emp.terms[0]), snapshot);              // byte-identical content
  assert.ok(Object.isFrozen(first));                                 // actually immutable
});
t('E6', 'validTo is DERIVED from the next validFrom (latest open-ended); newest first', () => {
  const store = seedE();
  applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', role: 'butikksjef' } });
  const ranges = termsWithRanges(employeeOf(store, T, 'ans-maria'));
  assert.equal(ranges[0].validFrom, '2026-09-01'); assert.equal(ranges[0].validTo, null);
  assert.equal(ranges[1].validFrom, '2023-03-01'); assert.equal(ranges[1].validTo, '2026-09-01');
  assert.ok(!('validTo' in ranges[1].terms));                        // never stored on the record
});
t('E7', 'duplicate validFrom fails closed (no overwrite, history unchanged)', () => {
  const store = seedE();
  const emp = employeeOf(store, T, 'ans-maria');
  const r = applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2023-03-01', role: 'butikksjef' } });
  assert.equal(r.ok, false); assert.equal(r.code, 'TERMS_DUPLICATE_VALIDFROM');
  assert.equal(emp.terms.length, 1);
  assert.equal(emp.terms[0].role, 'butikkmedarbeider');
});
t('E8', 'role change history retained with derived ranges (owner acceptance proof shape)', () => {
  const store = seedE();
  applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', role: 'butikksjef' } });
  const ranges = termsWithRanges(employeeOf(store, T, 'ans-maria'));
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].terms.role, 'butikksjef');
  assert.equal(ranges[1].terms.role, 'butikkmedarbeider');           // previous period present and unchanged
});
t('E9', 'terms snapshots carry unspecified facts forward; percentage/compensation changes append, never mutate', () => {
  const store = seedE();
  const emp = employeeOf(store, T, 'ans-maria');
  applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', percentage: 60 } });
  const t2 = currentTermsOf(emp, '2026-09-01');
  assert.equal(t2.percentage, 60);
  assert.equal(t2.role, 'butikkmedarbeider');                        // carried forward
  assert.deepEqual(t2.compensation, { model: 'timelonn', hourlyRate: 250 });   // carried forward
  applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-10-01', compensation: { model: 'fastlonn', monthlySalary: 48000 } } });
  assert.deepEqual(currentTermsOf(emp, '2026-10-02').compensation, { model: 'fastlonn', monthlySalary: 48000 });
  assert.deepEqual(currentTermsOf(emp, '2026-09-15').compensation, { model: 'timelonn', hourlyRate: 250 });   // old period untouched
  assert.equal(emp.terms.length, 3);
});
t('E10', 'unknown compensation stays unknown — never zero (projection null; Vaktplan derives unknown)', () => {
  const store = seedE();
  const r = applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  assert.equal(compensationProjectionOf(r.employee, '2026-09-02'), null);
  const yussef = employeeOf(store, T, 'ans-yussef');
  assert.equal(compensationProjectionOf(yussef, TODAY), null);
  const row = vaktplanPeopleFrom(store, T, TODAY).find((p) => p.ansattId === 'ans-yussef');
  assert.deepEqual(compensationOf(row), { model: 'unknown' });
});
t('E11', 'timelønn/fastlønn projection shapes match Vaktplan expectations exactly', () => {
  const store = seedE();
  const ppl = vaktplanPeopleFrom(store, T, TODAY);
  assert.deepEqual(compensationOf(ppl.find((p) => p.ansattId === 'ans-maria')), { model: 'timelonn', plannedHourlyRate: 250 });
  assert.deepEqual(compensationOf(ppl.find((p) => p.ansattId === 'ans-athar')), { model: 'fastlonn', plannedMonthlySalary: 52000 });
});
t('E12', 'Vaktplan compensation is DERIVED from CURRENT employment terms, not a stored copy', () => {
  const store = seedE();
  applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', compensation: { model: 'fastlonn', monthlySalary: 48000 } } });
  const before = vaktplanPeopleFrom(store, T, '2026-08-31').find((p) => p.ansattId === 'ans-maria');
  const after = vaktplanPeopleFrom(store, T, '2026-09-02').find((p) => p.ansattId === 'ans-maria');
  assert.deepEqual(before.compensation, { model: 'timelonn', plannedHourlyRate: 250 });
  assert.deepEqual(after.compensation, { model: 'fastlonn', plannedMonthlySalary: 48000 });
  assert.ok(!('compensation' in employeeOf(store, T, 'ans-maria')));  // no compensation field outside terms
});
t('E13', 'direct contact edit does not rewrite terms history', () => {
  const store = seedE();
  const emp = employeeOf(store, T, 'ans-maria');
  const termsRef = emp.terms; const snap = JSON.stringify(emp.terms);
  const r = applyE(store, { kind: 'updateContact', ansattId: 'ans-maria', contact: { email: 'demo@example.test' } });
  assert.equal(r.ok, true, r.code);
  assert.equal(emp.contact.email, 'demo@example.test');
  assert.equal(emp.terms, termsRef);
  assert.equal(JSON.stringify(emp.terms), snap);
  assert.equal(applyE(store, { kind: 'updateContact', ansattId: 'ans-maria', contact: { address: 'x' } }).code, 'CONTACT_FIELD_NOT_ALLOWED:address');
});
t('E14', 'ending preserves record/history; no delete path exists; ended excluded from Vaktplan rows', () => {
  const store = seedE();
  const r = applyE(store, { kind: 'endEmployee', ansattId: 'ans-aboud', endDate: '2026-09-30' });
  assert.equal(r.ok, true, r.code);
  const emp = employeeOf(store, T, 'ans-aboud');
  assert.equal(emp.status, 'ended'); assert.equal(emp.endedAt, '2026-09-30');
  assert.equal(emp.terms.length, 1);                                  // history intact
  assert.ok(employeesOf(store, T).some((e) => e.ansattId === 'ans-aboud'));   // never deleted
  assert.equal(applyE(store, { kind: 'endEmployee', ansattId: 'ans-aboud', endDate: '2026-10-01' }).code, 'ALREADY_ENDED');
  assert.equal(applyE(store, { kind: 'deleteEmployee', ansattId: 'ans-aboud' }).code, 'UNKNOWN_OPERATION');
  assert.ok(!vaktplanPeopleFrom(store, T, TODAY).some((p) => p.ansattId === 'ans-aboud'));
});
t('E15', 'tenant/actor/capability invalid input fails closed; store unchanged', () => {
  const store = seedE();
  const snap = JSON.stringify(store);
  assert.equal(applyE(store, { kind: 'createEmployee', name: 'X', startDate: '2026-09-01', role: 'r' }, { tenantId: 'tenant-x' }).code, 'TENANT_UNKNOWN');
  assert.equal(applyE(store, { kind: 'createEmployee', name: 'X', startDate: '2026-09-01', role: 'r' }, { actor: { accessEnabled: true } }).code, 'NOT_AUTHORIZED');
  assert.equal(applyE(store, { kind: 'appendTerms', ansattId: 'ans-nobody', terms: { validFrom: '2026-09-01' } }).code, 'EMPLOYEE_UNKNOWN');
  assert.equal(JSON.stringify(store), snap);
  assert.equal(canViewEmployees(MGR), true);
  assert.equal(canViewCompensation(MGR), true);
  assert.equal(canEditEmployment({ accessEnabled: true, canViewEmployeeCore: true }), false);
});
t('E16', 'document METADATA only: file/blob/url payload keys fail closed; categories validated', () => {
  const store = seedE();
  const ok = applyE(store, { kind: 'addDocument', ansattId: 'ans-yussef', doc: { name: 'Arbeidskontrakt', category: 'kontrakt', date: '2026-08-31', source: 'registrert manuelt' } });
  assert.equal(ok.ok, true, ok.code);
  assert.equal(contractStatusOf(employeeOf(store, T, 'ans-yussef')), 'finnes');
  assert.equal(applyE(store, { kind: 'addDocument', ansattId: 'ans-yussef', doc: { name: 'x', category: 'kontrakt', file: 'blob' } }).code, 'DOC_FIELD_NOT_ALLOWED:file');
  assert.equal(applyE(store, { kind: 'addDocument', ansattId: 'ans-yussef', doc: { name: 'x', category: 'kontrakt', url: 'http://x' } }).code, 'DOC_FIELD_NOT_ALLOWED:url');
  assert.equal(applyE(store, { kind: 'addDocument', ansattId: 'ans-yussef', doc: { name: 'x', category: 'lønnsslipp' } }).code, 'DOC_CATEGORY_INVALID');
});
t('E17', 'no prohibited sensitive identifier fields exist in seeded or created objects', () => {
  const store = seedE();
  applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  const json = JSON.stringify(store).toLowerCase();
  for (const bad of ['fødselsnummer', 'fodselsnummer', 'personnummer', 'bankkonto', 'bank account', 'skattekort', 'pårørende', 'parorende', '"uid"']) {
    assert.ok(!json.includes(bad), 'forbidden: ' + bad);
  }
  // contact stays blank/synthetic in fixture (C2)
  for (const e of employeesOf(store, T)) { assert.equal(e.contact.email, null); assert.equal(e.contact.phone, null); }
});
t('E18', 'schedule projection DELEGATES to the shared truth path (matches planningSummaryFor; upcoming sorted)', () => {
  const sched = buildFourSeasonSchedule(ANCHOR, TZ);
  const hours = plannedHoursForEmployee(sched, T, 'ans-maria', { kind: 'week', anchorWorkDate: ANCHOR });
  const summary = planningSummaryFor({ container: sched, tenantId: T, people: FOUR_SEASON_PEOPLE, scope: { kind: 'week', anchorWorkDate: ANCHOR } });
  assert.equal(hours, summary.rows.find((r) => r.ansattId === 'ans-maria').grossHours);   // same truth
  const now = tenantLocalHMToUtcMs(ANCHOR, '12:00', TZ);
  const up = upcomingShiftsForEmployee(sched, T, 'ans-maria', MGR, now, 3);
  assert.ok(up.length > 0 && up.length <= 3);
  for (const s of up) { assert.equal(s.projection.ansattId, 'ans-maria'); assert.ok(s.projection.plannedStartAt > now); }
  for (let i = 1; i < up.length; i++) assert.ok(up[i - 1].projection.plannedStartAt <= up[i].projection.plannedStartAt);
});
t('E19', 'invalid terms input fails closed (bad compensation shape, extra keys, bad percentage/type)', () => {
  const store = seedE();
  assert.equal(applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', compensation: { model: 'timelonn', hourlyRate: -5 } } }).code, 'COMPENSATION_INVALID');
  assert.equal(applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', compensation: { model: 'timelonn', hourlyRate: 250, bonus: 1 } } }).code, 'COMPENSATION_INVALID');
  assert.equal(applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', percentage: 150 } }).code, 'PERCENTAGE_INVALID');
  assert.equal(applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', employmentType: 'freelancer' } }).code, 'EMPLOYMENTTYPE_INVALID');
  assert.equal(applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-09-01', fodselsnummer: 'x' } }).code, 'TERMS_FIELD_NOT_ALLOWED:fodselsnummer');
  assert.equal(employeeOf(store, T, 'ans-maria').terms.length, 1);
});
t('E20', 'seeded five: statuses, contract facts and honest missing markers', () => {
  const store = seedE();
  assert.equal(employeesOf(store, T).length, 5);
  assert.equal(contractStatusOf(employeeOf(store, T, 'ans-maria')), 'finnes');
  assert.equal(contractStatusOf(employeeOf(store, T, 'ans-aboud')), 'mangler');
  assert.ok(missingInfoOf(employeeOf(store, T, 'ans-yussef'), TODAY).includes('mangler arbeidsprosent'));
  assert.ok(missingInfoOf(employeeOf(store, T, 'ans-yussef'), TODAY).includes('mangler lønnsgrunnlag'));
  assert.equal(startDateOf(employeeOf(store, T, 'ans-herish')), '2021-01-01');
  assert.equal(vaktplanPeopleFrom(store, T, TODAY).length, 5);
});

console.log(lines.join('\n'));
console.log('MANAGEMENT_EMPLOYEES_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
