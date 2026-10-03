// management-payroll-zero-state.test.mjs — CANONICAL EMPLOYEE TRUTH for Lønn & økonomi (node built-ins only).
// Law (SIRRHA-CCODE-SORMENA-PAYROLL-ZERO-EMPLOYEE-TRUTH-LOCAL-003): the payroll population, the planning coverage denominator
// and the requires-action count are derived ONLY from the canonical management employee store (tenants/{T}/ansatte via the
// production adapters). No identity, membership, actor, host, tenant profile, fixture or preview source may add a person.
// Z01–Z03 pin the zero state; Z04 pins identity independence at the adapter seam; Z05/Z06 pin that a REAL canonical
// document is still counted exactly as accepted (the owner-observed "0 av 1 · 1 se over" is the TRUE state for a real,
// just-created employee without a wage basis — never a phantom). Run: node management-payroll-zero-state.test.mjs
import assert from 'node:assert/strict';
import { buildPayrollPackage, createPayrollStore, versionsOf } from './management-payroll-core.mjs';
import { planningEconomyFor, coverageLineOf } from './management-planning-economy.mjs';
import { monthFactsOf, packageRollupOf } from './management-payroll-view.mjs';
import { oppmerksomhetFra, ansattFaktaFra } from './management-oversikt.mjs';
import { employeesOf } from './management-employees-core.mjs';
import { createManagementAdapters, normalizeAnsatt } from './management-production-adapters.mjs';
import { ETR2A_POLICY as POLICY, tenantWorkDate } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }
const T = 'four-season-as', TZ = POLICY.timezone;
const today = tenantWorkDate(Date.now(), TZ);
const periodId = today.slice(0, 7);
const facts = (employeeStore, scheduleStore = { [T]: {} }, attendanceStore = new Map()) => {
  const pkg = buildPayrollPackage({ employeeStore, scheduleStore, attendanceStore, tenantId: T, periodId, generatedAt: Date.now(), todayWorkDate: today });
  const planning = planningEconomyFor({ employeeStore, scheduleStore, tenantId: T, periodId });
  const mf = monthFactsOf({ rows: pkg.rows, plannedFor: () => [], periodId, planning, todayWorkDate: today, frozen: false });
  return { pkg, planning, mf, rollup: packageRollupOf(pkg.rows) };
};
// minimal fake fs for the adapter seam (no listeners fire; the store is built from readAnsatte only)
const fakeFs = () => ({ doc: (p) => ({ path: p }), newId: () => 'AuToId00000000000001', serverTimestamp: () => ({ st: true }), listen: () => () => {}, runTransaction: async (fn) => fn({ get: async () => ({ exists: false }), set: () => {}, update: () => {} }), batch: () => ({ set: () => {}, update: () => {}, commit: async () => {} }) });

await t('Z01', 'zero canonical employees -> payroll rows 0, planning population 0, coverage "0 av 0", estimate 0, exclusions 0', () => {
  const f = facts({ [T]: {} });
  assert.equal(f.pkg.rows.length, 0);
  assert.equal(f.planning.employees.length, 0);
  assert.equal(f.planning.estimate.totalCount, 0); assert.equal(f.planning.estimate.coveredCount, 0);
  assert.equal(f.planning.estimate.coverageLine, coverageLineOf(0, 0)); assert.equal(f.planning.estimate.coverageLine, 'estimatet dekker 0 av 0 ansatte (timelønn)');
  assert.equal(f.planning.estimate.exclusions.length, 0); assert.equal(f.planning.plannedHoursTotal, 0);
});
await t('Z02', 'zero canonical employees -> month facts: planned 0, actual 0, approved 0, chip Klar, hard 0, warn 0, actionCount 0, no "se over", no employee needing action; Oversikt attention has no employee item', () => {
  const f = facts({ [T]: {} });
  assert.equal(f.mf.plannedHoursTotal, 0); assert.equal(f.mf.actualHours, 0); assert.equal(f.mf.approvedHours, 0);
  assert.equal(f.mf.chip.key, 'klar'); assert.equal(f.mf.hardCount, 0); assert.equal(f.mf.warnCount, 0); assert.equal(f.mf.actionCount, 0);
  assert.deepEqual(f.mf.actionParts, []); assert.deepEqual(f.mf.employeesNeedingAction, []);
  assert.ok(!/se over/.test(JSON.stringify(f.mf)));
  assert.ok(!/lønnsbasis/i.test(JSON.stringify(f.mf.estimate.subs.filter(Boolean))), 'no wage-basis note without an employee');
  const items = oppmerksomhetFra({ monthFacts: f.mf, periodLabel: 'x', ansatte: ansattFaktaFra([]), openTodayCount: 0 });
  assert.deepEqual(items, []);
  assert.equal(versionsOf(createPayrollStore(), T, periodId).length, 0);
});
await t('Z03', 'the population is enumerated from the store ONLY (employeesOf): an empty tenant map has no hidden/prototype members', () => {
  assert.deepEqual(employeesOf({ [T]: {} }, T), []);
  assert.deepEqual(employeesOf({ [T]: Object.create({ ghost: { name: 'x' } }) }, T), []);
  assert.deepEqual(employeesOf({}, T), []);
});
await t('Z04', 'identity independence at the adapter seam: a bound admin membership (ansattId without a canonical document) and an unbound admin both yield an EMPTY employee store; nothing but readAnsatte() feeds it', () => {
  for (const m of [
    { uid: 'u-bound', tenantId: T, accessRole: 'admin', ansattId: 'ansatt-admin-0001', accessEnabled: true },
    { uid: 'u-noans', tenantId: T, accessRole: 'admin', ansattId: null, accessEnabled: true },
  ]) {
    const M = createManagementAdapters({ fs: fakeFs(), tenantId: T, membership: m, range: { from: '2026-09-01', to: '2026-10-31' }, readAnsatte: () => [], defaultContractProfile: { tenantId: T, companyFacts: {} }, policy: POLICY });
    M.start();
    assert.deepEqual(M.employees.store()[T], {});
    assert.deepEqual(M.employees.people(), []);
    const f = facts(M.employees.store());
    assert.equal(f.planning.estimate.totalCount, 0); assert.equal(f.mf.actionCount, 0); assert.equal(f.pkg.rows.length, 0);
    M.dispose();
  }
});
await t('Z05', 'REAL canonical document regression: a just-created legacy-skeleton employee (opprettet today, timelønn 0, no wage basis) IS counted — 1 row, coverage "0 av 1", missing-basis exclusion, "Startet i perioden" warn -> "1 se over", actionCount 1 (the owner-observed state is the true state for a real record)', () => {
  const doc = { navn: 'text', stilling: 'butikkmedarbeider', timelonn: 0, adresse: '', epost: '', bankkonto: '', personnummer: '', notater: '', aktiv: true, opprettet: new Date().toISOString() };
  const rec = normalizeAnsatt('LSsfVDtxzZEjc7V9f6oz', doc);
  const f = facts({ [T]: { [rec.ansattId]: rec } });
  assert.equal(f.pkg.rows.length, 1);
  assert.equal(f.planning.estimate.totalCount, 1); assert.equal(f.planning.estimate.coveredCount, 0);
  assert.equal(f.planning.estimate.coverageLine, 'estimatet dekker 0 av 1 ansatte (timelønn)');
  assert.equal(f.planning.estimate.exclusions[0].reason, 'mangler_lonnsbasis');
  assert.ok(f.pkg.rows[0].exceptions.some((x) => x.code === 'startet_i_perioden' && x.severity === 'warn'));
  assert.equal(f.mf.warnCount, 1); assert.equal(f.mf.actionCount, 1); assert.deepEqual(f.mf.actionParts, ['1 se over']);
});
await t('Z06', 'REAL canonical document with a wage basis and an earlier start: counted and covered (1 av 1), no warn, actionCount 0 — accepted behaviour unchanged', () => {
  const rec = normalizeAnsatt('Kx9mQ2vT7pLa4RcW1nZb', { navn: 'Mr Testperson', stilling: 'butikkmedarbeider', timelonn: 210, aktiv: true, opprettet: '2026-01-05T08:00:00.000Z' });
  const f = facts({ [T]: { [rec.ansattId]: rec } });
  assert.equal(f.pkg.rows.length, 1); assert.equal(f.planning.estimate.coverageLine, 'estimatet dekker 1 av 1 ansatte (timelønn)');
  assert.equal(f.mf.warnCount, 0); assert.equal(f.mf.actionCount, 0); assert.equal(f.rollup.chip.key, 'klar');
});

for (const l of lines) console.log(l);
console.log('MANAGEMENT_PAYROLL_ZERO_STATE_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
