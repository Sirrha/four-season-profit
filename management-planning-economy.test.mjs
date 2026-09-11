// management-planning-economy.test.mjs
// P2 proofs for the pure planning-economy projection. Node built-ins only.
// Run: node management-planning-economy.test.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planningEconomyFor, hourlyRateOn, coverageLineOf, FIXED_SALARY_NOTE, MISSING_BASIS_NOTE, ESTIMATE_LABEL } from './management-planning-economy.mjs';
import { seedFourSeasonEmployees, plannedHoursForEmployee } from './management-employees-core.mjs';
import { buildFourSeasonSchedule, FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE } from './employee-schedule-fixture.mjs';
import { tenantLocalHMToUtcMs, ETR2A_POLICY } from './employee-shell-core.mjs';   // test-only: instants + timezone for isolated fixtures
import { buildPayrollPackage, accountantPayloadOf, createPayrollStore, applyPayrollOperation, versionsOf } from './management-payroll-core.mjs';
import { FOUR_SEASON_MANAGER_ACTOR } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0;
const lines = [];
function t(id, name, fn) {
  try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); }
  catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); }
}
const TZ = ETR2A_POLICY.timezone;
const T = 't1';
const ms = (wd, hm) => tenantLocalHMToUtcMs(wd, hm, TZ);
const shift = (id, ansattId, wd, from, to, status) => [id, { ansattId, workDate: wd, status: status || 'assigned', plannedStartAt: ms(wd, from), plannedEndAt: ms(wd, to), roleKey: 'butikkmedarbeider', revision: 1 }];
const emp = (ansattId, name, terms, status) => ({ ansattId, name, status: status || 'active', endedAt: null, terms, documents: [] });
const stores = (emps, shifts) => ({
  employeeStore: { [T]: Object.fromEntries(emps.map((e) => [e.ansattId, e])) },
  scheduleStore: { [T]: Object.fromEntries(shifts) },
});

// ---- P2-PROOF-1: pure & deterministic from schedule + terms only ------------------------------
t('P2-1', 'deterministic: same stores -> identical projection; planned hours = canonical derivation', () => {
  const { employeeStore, scheduleStore } = stores(
    [emp('a', 'A', [{ validFrom: '2026-01-01', compensation: { model: 'timelonn', hourlyRate: 200 } }])],
    [shift('s1', 'a', '2026-08-04', '16:00', '20:00'), shift('s2', 'a', '2026-08-08', '10:00', '18:00')]);
  const p1 = planningEconomyFor({ employeeStore, scheduleStore, tenantId: T, periodId: '2026-08' });
  const p2 = planningEconomyFor({ employeeStore, scheduleStore, tenantId: T, periodId: '2026-08' });
  assert.deepEqual(p1, p2);
  assert.equal(p1.plannedHoursTotal, 12);
  assert.equal(p1.employees[0].plannedHours, plannedHoursForEmployee(scheduleStore, T, 'a', { kind: 'month', year: 2026, month: 8 }));
  assert.equal(p1.estimate.kr, 2400);
  assert.equal(p1.estimate.label, '(estimat)');
  assert.equal(planningEconomyFor({ employeeStore, scheduleStore, tenantId: T, periodId: 'nope' }), null);
});

// ---- P2-PROOF-2: mid-month rate change — per-shift rate by workDate, no current-rate shortcut --
t('P2-2', 'two shifts on opposite sides of a wage change use the rate in effect on each workDate', () => {
  const { employeeStore, scheduleStore } = stores(
    [emp('a', 'A', [
      { validFrom: '2026-01-01', compensation: { model: 'timelonn', hourlyRate: 200 } },
      { validFrom: '2026-08-15', compensation: { model: 'timelonn', hourlyRate: 220 } },
    ])],
    [shift('s1', 'a', '2026-08-10', '08:00', '12:00'), shift('s2', 'a', '2026-08-20', '08:00', '12:00')]);
  const p = planningEconomyFor({ employeeStore, scheduleStore, tenantId: T, periodId: '2026-08' });
  const a = p.employees[0];
  assert.deepEqual(a.shifts.map((s) => [s.workDate, s.rate, s.kr]), [['2026-08-10', 200, 800], ['2026-08-20', 220, 880]]);
  assert.equal(a.estimateKr, 1680, 'NOT 8 h × 220 = 1760 (current-rate shortcut) and NOT 8 × 200');
  assert.equal(hourlyRateOn(employeeStore[T].a, '2026-08-14'), 200);
  assert.equal(hourlyRateOn(employeeStore[T].a, '2026-08-15'), 220, 'validFrom day itself carries the new rate');
  // a shift dated BEFORE the first terms period has no rate -> the employee is excluded, never guessed
  const early = stores([emp('b', 'B', [{ validFrom: '2026-08-15', compensation: { model: 'timelonn', hourlyRate: 300 } }])], [shift('s3', 'b', '2026-08-10', '08:00', '12:00')]);
  const q = planningEconomyFor({ employeeStore: early.employeeStore, scheduleStore: early.scheduleStore, tenantId: T, periodId: '2026-08' });
  assert.equal(q.employees[0].estimateKr, null);
  assert.equal(q.employees[0].note, MISSING_BASIS_NOTE);
});

// ---- P2-PROOF-3 / -4 / -5: fixed salary, missing basis, coverage -------------------------------
t('P2-3', 'fixed salary: planned hours shown as context, excluded from the estimate and named', () => {
  const { employeeStore, scheduleStore } = stores(
    [emp('f', 'F', [{ validFrom: '2026-01-01', compensation: { model: 'fastlonn', monthlySalary: 52000 } }])],
    [shift('s1', 'f', '2026-08-03', '08:00', '16:00')]);
  const p = planningEconomyFor({ employeeStore, scheduleStore, tenantId: T, periodId: '2026-08' });
  assert.equal(p.employees[0].plannedHours, 8);
  assert.equal(p.employees[0].estimateKr, null);
  assert.equal(p.employees[0].note, FIXED_SALARY_NOTE);
  assert.equal(p.estimate.kr, 0);
  assert.deepEqual(p.estimate.exclusions.map((x) => x.reason), ['fastlonn']);
  assert.ok(!JSON.stringify(p).includes('52000'), 'monthly salary is never multiplied or surfaced as a planning cost');
});
t('P2-4', 'missing basis: excluded, never guessed, named', () => {
  const { employeeStore, scheduleStore } = stores(
    [emp('m', 'M', [{ validFrom: '2026-01-01', compensation: null }])],
    [shift('s1', 'm', '2026-08-03', '08:00', '16:00')]);
  const p = planningEconomyFor({ employeeStore, scheduleStore, tenantId: T, periodId: '2026-08' });
  assert.equal(p.employees[0].estimateKr, null);
  assert.equal(p.employees[0].note, MISSING_BASIS_NOTE);
  assert.equal(p.estimate.kr, 0);
  assert.equal(p.estimate.exclusions[0].reason, 'mangler_lonnsbasis');
});
t('P2-5', 'coverage line and counts match the exclusions on the real fixture (2 hourly with rate, 1 missing basis, 2 fixed)', () => {
  const employeeStore = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, FOUR_SEASON_TENANT.tenantId);
  const scheduleStore = buildFourSeasonSchedule('2026-09-10', TZ);
  const p = planningEconomyFor({ employeeStore, scheduleStore, tenantId: FOUR_SEASON_TENANT.tenantId, periodId: '2026-08' });
  assert.equal(p.estimate.totalCount, 5);
  assert.equal(p.estimate.coveredCount, 2, 'Maria + Aboud are hourly with a rate; Yussef has no basis; Athar/Herish are fixed');
  assert.equal(p.estimate.coverageLine, coverageLineOf(2, 5));
  assert.equal(p.estimate.coverageLine, 'estimatet dekker 2 av 5 ansatte (timelønn)');
  assert.deepEqual(p.estimate.exclusions.map((x) => x.name + ':' + x.reason).sort(), ['Athar:fastlonn', 'Herish:fastlonn', 'Yussef:mangler_lonnsbasis']);
  const aboud = p.employees.find((e) => e.ansattId === 'ans-aboud');
  assert.equal(aboud.plannedHours, 36);
  assert.equal(aboud.estimateKr, 36 * 220);
  assert.equal(p.estimate.kr, p.employees.filter((e) => e.included).reduce((s, e) => s + e.estimateKr, 0));
  assert.equal(p.plannedHoursTotal, p.employees.reduce((s, e) => s + e.plannedHours, 0));
});

// ---- P2-PROOF-9: layer firewall (source) -------------------------------------------------------
t('P2-9', 'the planning module imports only the schedule core and the employees core; no attendance/payroll symbols', () => {
  const src = fs.readFileSync(new URL('./management-planning-economy.mjs', import.meta.url), 'utf8');
  const from = (src.match(/from '\.\/[^']+'/g) || []).map((s) => s.slice(6).replace(/'/g, '')).sort();
  assert.deepEqual(from, ['./management-employees-core.mjs', './management-schedule-core.mjs']);
  for (const bad of ['employee-shell-core', 'daySummaryFor', 'payroll-core', 'accountantPayloadOf', 'snapshot', 'approve', 'attendance', 'payload', 'deliver', 'frozen']) {
    assert.ok(!src.replace(/\/\/.*$/gm, '').includes(bad), 'forbidden symbol in planning module: ' + bad);
  }
  // S-P2a: the only money arithmetic is hours × rate
  assert.ok(!/monthlySalary\s*[*/]|\/\s*4\.33|\/\s*4\b|tax|skatt|feriepeng|overtid|bonus|arbeidsgiveravgift/i.test(src.replace(/\/\/.*$/gm, '')));
});

// ---- P2-PROOF-10: payload / snapshot firewall (PT13b class) -------------------------------------
t('P2-10', 'accountant payload and frozen snapshot carry no planned/estimate keys; the projection is never stored', () => {
  const employeeStore = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, FOUR_SEASON_TENANT.tenantId);
  const scheduleStore = buildFourSeasonSchedule('2026-09-10', TZ);
  const tenantId = FOUR_SEASON_TENANT.tenantId;
  const pkg = buildPayrollPackage({ employeeStore, scheduleStore, attendanceStore: new Map(), tenantId, periodId: '2026-08', generatedAt: Date.now(), todayWorkDate: '2026-09-10' });
  const planning = planningEconomyFor({ employeeStore, scheduleStore, tenantId, periodId: '2026-08' });
  assert.ok(planning.estimate.kr > 0);
  const payload = JSON.stringify(accountantPayloadOf(pkg));
  // (compensation basis such as hourlyRate is EXISTING payroll payload truth; planning keys are not)
  assert.ok(!/estimat|estimate|kostnad|plannedHours|plannedHoursTotal|coverage|comparison/i.test(payload), 'payload is free of planning keys');
  const store = createPayrollStore();
  const res = applyPayrollOperation({ store, tenantId, actor: FOUR_SEASON_MANAGER_ACTOR, op: { kind: 'approvePackage', periodId: '2026-08', managerNote: '', supersedes: null }, pkg, now: Date.now(), operatorName: 'x' });
  if (res.ok) {
    const snap = JSON.stringify(versionsOf(store, tenantId, '2026-08')[0].snapshot);
    // (the snapshot legitimately carries compensation basis and the manager-only comparison; it must never carry a planning estimate)
    assert.ok(!/estimat|estimate|kostnad|plannedHoursTotal|coverage/i.test(snap), 'frozen snapshot carries no estimate');
  }
  assert.ok(!JSON.stringify(store).includes('estimat'));
});

console.log(lines.join('\n'));
console.log('\nMANAGEMENT_PLANNING_ECONOMY_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
