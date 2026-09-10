// management-presentation-3a.test.mjs
// LØNNSGRUNNLAG INCREMENT 3A — PRESENTATION-ONLY proofs PA1–PA5. Node built-ins only.
// This suite asserts PRESENTATION behaviour: the three-level chip mapping, the package rollup,
// the one-page Ledelse frame and the inline employee detail. It changes and tests NO truth:
// every engine invariant stays proven by management-payroll-core.test.mjs (P1–P16), re-run
// unchanged as regression. Run: node management-presentation-3a.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  statusChipFor, packageRollupOf, STATUS_KLAR, STATUS_SE_OVER, STATUS_MA_RETTES,
} from './management-payroll-view.mjs';
import {
  buildPayrollPackage, createPayrollStore, applyPayrollOperation,
} from './management-payroll-core.mjs';
import { seedFourSeasonEmployees, employeeOf, applyEmployeeOperation } from './management-employees-core.mjs';
import { FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MANAGER_ACTOR } from './employee-schedule-fixture.mjs';
import { tenantLocalHMToUtcMs, ETR2A_POLICY } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const T = FOUR_SEASON_TENANT.tenantId;
const TZ = ETR2A_POLICY.timezone;
const MGR = FOUR_SEASON_MANAGER_ACTOR;
const PERIOD = '2026-08';
const TODAY = '2026-09-03';
const NOW = tenantLocalHMToUtcMs(TODAY, '12:00', TZ);
const shellSrc = fs.readFileSync(new URL('./employee-shell-ui.mjs', import.meta.url), 'utf8');
const payrollViewSrc = fs.readFileSync(new URL('./management-payroll-view.mjs', import.meta.url), 'utf8');
const scheduleViewSrc = fs.readFileSync(new URL('./management-schedule-view.mjs', import.meta.url), 'utf8');

const ms = (wd, hm) => tenantLocalHMToUtcMs(wd, hm, TZ);
function att(ansattId, workDate, o) {
  const opts = o || {};
  const inAt = opts.inAt === undefined ? ms(workDate, '08:00') : opts.inAt;
  const outAt = opts.outAt === undefined ? ms(workDate, '16:00') : opts.outAt;
  return {
    attendanceId: 'att-' + ansattId + '-' + workDate, shiftId: 'sh-' + ansattId + '-' + workDate,
    ansattId, workDate, plannedSnapshot: { startAt: ms(workDate, '08:00'), endAt: ms(workDate, '16:00') },
    observedClockInAt: inAt, observedClockOutAt: outAt,
    declaredStartAt: inAt, declaredEndAt: outAt,
    approvedStartAt: null, approvedEndAt: null, approvedByUid: null, approvedAt: null,
    status: opts.status || (outAt == null ? 'clocked_in' : 'clocked_out'),
    breakState: 'working', openBreakStartedAt: null, observedBreakMinutesTotal: 0,
    declaredBreakMinutesTotal: null, approvedBreakMinutesTotal: null, breakCount: 0,
    revision: 1, createdAt: NOW, updatedAt: NOW,
  };
}
const storeOf = (rs) => new Map(rs.map((r) => [r.attendanceId, r]));
function shiftFor(ansattId, workDate, fromHM, toHM) {
  return { shiftId: 'p-' + ansattId + '-' + workDate, ansattId, workDate, status: 'assigned', plannedStartAt: ms(workDate, fromHM), plannedEndAt: ms(workDate, toHM) };
}
const scheduleOf = (ss) => { const c = { [T]: {} }; for (const s of ss) c[T][s.shiftId] = s; return c; };
const build = (over) => buildPayrollPackage(Object.assign({
  employeeStore: seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T), scheduleStore: { [T]: {} },
  attendanceStore: new Map(), tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY,
}, over || {}));
const rowOf = (pkg, id) => pkg.rows.find((r) => r.ansattId === id);

t('PA1', 'Ledelse is ONE persistent frame with four tabs; switching stays in-frame and keeps state', () => {
  // one frame + tab bar, built once in the shell
  assert.ok(shellSrc.includes("function goLedelse(tab)"));
  assert.ok(shellSrc.includes("cls: 'lede-frame'") && shellSrc.includes("cls: 'lede-tabs'") && shellSrc.includes("cls: 'lede-content'"));
  for (const label of ["'Oversikt'", "'Vaktplan'", "'Ansatte'", "'Lønn & økonomi'"]) assert.ok(shellSrc.includes(label), 'missing tab: ' + label);
  // tab clicks re-enter the same frame, never a separate destination
  assert.ok(shellSrc.includes("b.addEventListener('click', () => goLedelse(t.key));"));
  // shell OWNS the state that must survive a tab switch
  assert.ok(shellSrc.includes('const LG_STATE = { periodId: null, openEmployee: null };'));
  assert.ok(shellSrc.includes("const VP_STATE = { offset: 0, query: '' };"));
  assert.ok(shellSrc.includes('initialPeriodId: LG_STATE.periodId, initialOpenEmployee: LG_STATE.openEmployee'));
  assert.ok(shellSrc.includes('onStateChange: (s) => { LG_STATE.periodId = s.periodId; LG_STATE.openEmployee = s.openEmployee; }'));
  assert.ok(shellSrc.includes('initialOffset: VP_STATE.offset'));
  assert.ok(shellSrc.includes('onOffsetChange: (o) => { VP_STATE.offset = o; }'));
  // the views accept and report that state
  assert.ok(payrollViewSrc.includes('initialOpenEmployee, onStateChange'));
  assert.ok(scheduleViewSrc.includes('initialOffset, onOffsetChange'));
  assert.ok(scheduleViewSrc.includes('let offset = Number.isInteger(initialOffset) ? initialOffset : 0;'));
  // an internal Ansatte → Vaktplan jump switches TAB rather than leaving the workspace
  assert.ok(shellSrc.includes("goLedelse('vaktplan'); }"));
  // capability gating still decides which tabs exist (absence, not dead controls)
  assert.ok(shellSrc.includes('function ledelseTabs()') && shellSrc.includes('canOpenVaktplan(FOUR_SEASON_MANAGER_ACTOR)') && shellSrc.includes('canViewEmployees(FOUR_SEASON_MANAGER_ACTOR)'));
});
t('PA2', 'each tab mounts the EXISTING view module — no duplicate truth or parallel calculator', () => {
  // the same renderers the standalone destinations used, mounted into the frame content element
  assert.ok(shellSrc.includes('renderManagementView(host, {'));
  assert.ok(shellSrc.includes('renderEmployeesView(host, {'));
  assert.ok(shellSrc.includes('renderPayrollView(host, {'));
  // no second store or fork was created for the frame
  for (const bad of ['createPayrollStore()', 'seedFourSeasonEmployees(']) {
    const n = shellSrc.split(bad).length - 1;
    assert.ok(n <= 1, 'store constructed more than once in the shell: ' + bad);
  }
  // Oversikt reads existing derivations only; it defines no arithmetic of its own
  assert.ok(shellSrc.includes('managerWeekFor({') && shellSrc.includes('openShiftsOf(') && shellSrc.includes('missingInfoOf(') && shellSrc.includes('buildPayrollPackage({'));
  // and the package/view modules still import exactly what Increment 2 fixed
  const from = (payrollViewSrc.match(/from '\.\/[^']+'/g) || []).map((s) => s.slice(6).replace(/'/g, '')).sort();
  assert.deepEqual(from, ['./employee-shell-core.mjs', './management-payroll-core.mjs']);
});
t('PA3', 'status truth table: clean→Klar, warn-only→Se over (approval allowed), hard→Må rettes (refused)', () => {
  assert.deepEqual(statusChipFor([]), STATUS_KLAR);
  assert.deepEqual(statusChipFor([{ severity: 'warn' }]), STATUS_SE_OVER);
  assert.deepEqual(statusChipFor([{ severity: 'hard' }]), STATUS_MA_RETTES);
  assert.deepEqual(statusChipFor([{ severity: 'warn' }, { severity: 'hard' }]), STATUS_MA_RETTES);  // hard wins
  // A WARNING CAN NEVER COEXIST WITH A GREEN CHIP — the defect Herish saw is unrepresentable.
  for (const set of [[{ severity: 'warn' }], [{ severity: 'warn' }, { severity: 'warn' }]]) {
    assert.notEqual(statusChipFor(set).key, 'klar');
  }
  // warn-only employee: chip amber, approval STILL permitted (engine unchanged, P8 stands)
  const warnPkg = build({ scheduleStore: scheduleOf([shiftFor('ans-maria', '2026-08-10', '08:00', '16:00')]) });
  const maria = rowOf(warnPkg, 'ans-maria');
  assert.ok(maria.exceptions.some((x) => x.severity === 'warn'));
  assert.ok(!maria.exceptions.some((x) => x.severity === 'hard'));
  assert.equal(statusChipFor(maria.exceptions).key, 'se_over');
  assert.equal(warnPkg.readiness.ready, true);
  const ps = createPayrollStore();
  assert.equal(applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg: warnPkg, now: NOW }).ok, true);
  // hard employee: chip red AND the existing approval refusal still blocks
  const store = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
  const c = applyEmployeeOperation({ store, tenantId: T, actor: MGR, op: { kind: 'createEmployee', name: 'Uten Basis', startDate: '2026-08-01', role: 'butikkmedarbeider' }, now: NOW, timezone: TZ });
  const hardPkg = buildPayrollPackage({ employeeStore: store, scheduleStore: { [T]: {} }, attendanceStore: storeOf([att(c.ansattId, '2026-08-05')]), tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  const hardRow = rowOf(hardPkg, c.ansattId);
  assert.equal(statusChipFor(hardRow.exceptions).key, 'ma_rettes');
  const refusal = applyPayrollOperation({ store: createPayrollStore(), tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg: hardPkg, now: NOW });
  assert.equal(refusal.ok, false); assert.equal(refusal.code, 'NOT_READY');
});
t('PA4', 'package rollup follows hard > warn > clean and names the counts', () => {
  assert.equal(packageRollupOf([]).chip.key, 'klar');
  assert.equal(packageRollupOf([{ exceptions: [] }]).chip.key, 'klar');
  const mixed = [{ exceptions: [{ severity: 'hard' }] }, { exceptions: [{ severity: 'hard' }] }, { exceptions: [{ severity: 'warn' }] }, { exceptions: [] }];
  const r = packageRollupOf(mixed);
  assert.equal(r.chip.key, 'ma_rettes');
  assert.equal(r.hardCount, 2); assert.equal(r.warnCount, 1);
  assert.equal(r.counts, '2 må rettes · 1 se over');
  const warnOnly = packageRollupOf([{ exceptions: [{ severity: 'warn' }] }, { exceptions: [] }]);
  assert.equal(warnOnly.chip.key, 'se_over');
  assert.equal(warnOnly.counts, '1 se over');
  // after approval the VERSION state outranks draft readiness in the header
  assert.ok(payrollViewSrc.includes("text: approved.status === PACKAGE_STATUS.SENT ? 'Sendt' : 'Godkjent v' + approved.version"));
});
t('PA5', 'inline detail: one row open at a time, month stays in context, separate route removed', () => {
  // expansion happens inside the list; the detail renderer is handed the row wrapper
  assert.ok(payrollViewSrc.includes('function drawEmployeeDetail(pkg, row, host)'));
  assert.ok(payrollViewSrc.includes('if (isOpen) drawEmployeeDetail(pkg, row, wrap);'));
  // toggling: opening another row replaces the open one (single-open by construction)
  assert.ok(payrollViewSrc.includes('openEmployee = isOpen ? null : row.ansattId;'));
  // the old separate full-page route is GONE — no early return, no second rendering path
  assert.ok(!payrollViewSrc.includes("← Alle ansatte i perioden"));
  assert.ok(!/if \(openEmployee\) \{[\s\S]{0,200}return;/.test(payrollViewSrc), 'separate detail route still present');
  assert.equal(payrollViewSrc.split('function drawEmployeeDetail').length - 1, 1, 'more than one detail renderer');
  // month context is still painted on every draw (title + period bar precede the list)
  assert.ok(payrollViewSrc.includes('root.appendChild(head(periodTitle(periodId)'));
  assert.ok(payrollViewSrc.includes('root.appendChild(periodBar());'));
  // the expanded content is the same package row the collapsed line reads — no new arithmetic
  for (const bad of ['Math.floor(', 'minutes / 60', '/ 60000', '* 60']) {
    assert.ok(!payrollViewSrc.includes(bad), 'view introduced duration arithmetic: ' + bad);
  }
});

console.log(lines.join('\n'));
console.log('MANAGEMENT_PRESENTATION_3A_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
