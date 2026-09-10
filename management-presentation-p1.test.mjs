// management-presentation-p1.test.mjs
// P1 (Lønnsgrunnlag presentation, Soren Q3-Q6) proofs. Node built-ins only.
// Run: node management-presentation-p1.test.mjs   (exit 0 = all pass)
//
// SCOPE: the pure, view-owned projections P1 renders from — the DAGER I PERIODEN union, the
// Norwegian date/variance formatting — plus source-level guards that the payload firewall and
// the 3A/Stage-R seams stayed intact. Actual-time truth is proven in the attendance/payroll suites.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dagerIPerioden, fmtDagRad, fmtAvvik, nbDateFromIso, isoFromNbDate, calendarMonthGrid, NB_WEEKDAYS_SHORT, manualTargetFor } from './management-payroll-view.mjs';
import { buildPayrollPackage, accountantPayloadOf } from './management-payroll-core.mjs';
import { seedFourSeasonEmployees } from './management-employees-core.mjs';
import { applyScheduleOperation, shiftsForEmployee, durationHoursOf } from './management-schedule-core.mjs';
import { buildFourSeasonSchedule, FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MANAGER_ACTOR } from './employee-schedule-fixture.mjs';
import { ETR2A_POLICY, tenantLocalHMToUtcMs } from './employee-shell-core.mjs';

let passed = 0, failed = 0;
const lines = [];
function t(id, name, fn) {
  try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); }
  catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); }
}

const TZ = ETR2A_POLICY.timezone;
const ms = (wd, hm) => tenantLocalHMToUtcMs(wd, hm, TZ);
const shift = (id, wd, from, to, o) => ({ shiftId: id, hours: 4, projection: Object.assign({ ansattId: 'ans-a1', workDate: wd, status: 'assigned', plannedStartAt: ms(wd, from), plannedEndAt: ms(wd, to) }, o || {}) });
const day = (wd, o) => Object.assign({ workDate: wd, startAt: ms(wd, '16:00'), endAt: ms(wd, '20:00'), minutes: 240, hours: 4, label: 'Oppgitt arbeidstid', breakRow: { kind: 'declared', minutes: 0 }, recordApproved: false, exceptions: [], declarationSource: 'manager', fortAvLedelse: true }, o || {});
const viewSrc = fs.readFileSync(new URL('./management-payroll-view.mjs', import.meta.url), 'utf8');
const shellSrc = fs.readFileSync(new URL('./employee-shell-ui.mjs', import.meta.url), 'utf8');

// ---- P1-3: the four row semantics of DAGER I PERIODEN -----------------------------------------
t('P1-3a', 'planned, no attendance -> one planned_only row with the REAL interval', () => {
  const rows = dagerIPerioden({ plannedShifts: [shift('sh-1', '2026-08-04', '16:00', '20:00')], days: [], periodId: '2026-08' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'planned_only');
  assert.equal(rows[0].planned[0].shiftId, 'sh-1');
  assert.equal(rows[0].actual.length, 0);
});
t('P1-3b', 'planned + attendance -> one "both" row; actual comes ONLY from the day payload', () => {
  const rows = dagerIPerioden({ plannedShifts: [shift('sh-1', '2026-08-04', '16:00', '20:00')], days: [day('2026-08-04')], periodId: '2026-08' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'both');
  assert.equal(rows[0].actual[0].minutes, 240);
  assert.equal(rows[0].planned.length, 1);
});
t('P1-3c', 'attendance, no plan -> actual_only row; no shift is fabricated', () => {
  const rows = dagerIPerioden({ plannedShifts: [], days: [day('2026-08-05')], periodId: '2026-08' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'actual_only');
  assert.equal(rows[0].planned.length, 0);
});
t('P1-3d', 'neither -> no row; other-period, cancelled and open shifts never make a row', () => {
  const rows = dagerIPerioden({
    plannedShifts: [shift('sh-x', '2026-09-01', '08:00', '12:00'), shift('sh-c', '2026-08-10', '08:00', '12:00', { status: 'cancelled' }), shift('sh-o', '2026-08-11', '08:00', '12:00', { status: 'open', ansattId: null })],
    days: [day('2026-07-31')], periodId: '2026-08',
  });
  assert.deepEqual(rows, []);
});
t('P1-3e', 'several shifts / records on one day stay EXPLICIT intervals; rows sorted by date', () => {
  const rows = dagerIPerioden({
    plannedShifts: [shift('sh-2', '2026-08-08', '16:00', '20:00'), shift('sh-1', '2026-08-08', '08:00', '12:00'), shift('sh-3', '2026-08-04', '16:00', '20:00')],
    days: [day('2026-08-08'), day('2026-08-08', { startAt: ms('2026-08-08', '08:00'), endAt: ms('2026-08-08', '12:00') })], periodId: '2026-08',
  });
  assert.deepEqual(rows.map((r) => r.workDate), ['2026-08-04', '2026-08-08']);
  assert.deepEqual(rows[1].planned.map((p) => p.shiftId), ['sh-1', 'sh-2'], 'intervals ordered by start, none merged');
  assert.equal(rows[1].actual.length, 2, 'two records stay two records');
});

// ---- P1-4: empty state only when BOTH sides are empty -----------------------------------------
t('P1-4', 'planned days render with zero attendance; the empty sentence exists only for both-empty', () => {
  const some = dagerIPerioden({ plannedShifts: [shift('sh-1', '2026-08-04', '16:00', '20:00')], days: [], periodId: '2026-08' });
  assert.equal(some.length, 1);
  assert.deepEqual(dagerIPerioden({ plannedShifts: [], days: [], periodId: '2026-08' }), []);
  assert.ok(viewSrc.includes("'Ingen planlagte vakter eller registrert tid i perioden.'"));
  assert.ok(!viewSrc.includes('Ingen registrert tid i perioden.'), 'the attendance-only sentence is retired');
  assert.ok(!viewSrc.includes("'Dag for dag'"), 'renamed to Dager i perioden');
  assert.ok(viewSrc.includes("text: 'Dager i perioden'"));
});

// ---- P1-1: Norwegian dates, never MM/DD ----------------------------------------------------------
t('P1-1', 'day rows and numeric dates are Norwegian; no locale MM/DD; Stage-R control intact', () => {
  const s = fmtDagRad('2026-08-04');
  assert.ok(/4\./.test(s) && /aug/.test(s), s);
  assert.ok(!s.includes('/'), s);
  assert.equal(nbDateFromIso('2026-08-04'), '04.08.2026');
  assert.equal(isoFromNbDate('04.08.2026').iso, '2026-08-04');
  assert.ok(!/input\('date'/.test(viewSrc), 'no native date input may return');
  assert.ok(viewSrc.includes("field('Dato (dd.mm.åååå)', dateRow)") && viewSrc.includes('dateRow.appendChild(dateI);'), 'the Stage-R text control is the date entry, now beside the calendar button');
  assert.ok(viewSrc.includes("btn('Denne måneden'"), 'period stepper carries Denne måneden');
  assert.ok(viewSrc.includes('root.appendChild(head(periodTitle(periodId)'), 'period title stays the first fact');
});
t('P1-2', 'signed variance formatting is presentation only', () => {
  assert.equal(fmtAvvik(-16), '−16 t');
  assert.equal(fmtAvvik(2.5), '+2,5 t');
  assert.equal(fmtAvvik(0), '±0 t');
  assert.equal(fmtAvvik(null), '');
  assert.ok(viewSrc.includes("stat('Planlagt', fmtH(row.comparison.plannedHours))"));
  assert.ok(viewSrc.includes("stat('Godkjent', fmtH(row.payload.approvedHours))"));
  assert.ok(!/kr\s*\d|kostnad|estimat/i.test(viewSrc.replace(/\/\/.*$/gm, '')), 'no planning-economy money in P1 view code');
});

// ---- P1-6: payload firewall (PT13b class) ----------------------------------------------------------
t('P1-6', 'the accountant payload stays byte-free of planned keys with a loaded plan', () => {
  const T = FOUR_SEASON_TENANT.tenantId;
  const employeeStore = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
  const scheduleStore = buildFourSeasonSchedule('2026-09-04', TZ);
  const pkg = buildPayrollPackage({ employeeStore, scheduleStore, attendanceStore: new Map(), tenantId: T, periodId: '2026-08', generatedAt: Date.now(), todayWorkDate: '2026-09-04' });
  assert.ok(pkg.rows.some((r) => r.comparison.plannedHours > 0), 'the plan is loaded');
  const payload = JSON.stringify(accountantPayloadOf(pkg));
  assert.ok(!/plann|planlagt|comparison|variance/i.test(payload), 'no planned key in the payload');
  // the view never writes the union anywhere: no store/payload/snapshot reference near dagerIPerioden
  assert.ok(!/dagerIPerioden\([^)]*\)[\s\S]{0,400}(attendanceStore\.set|payrollStore|snapshot)/.test(viewSrc));
  assert.ok(!viewSrc.includes('attendanceStore.set('), 'the view writes no attendance');
});

// ---- P1-5 / §E: contextual actions reuse the existing seam; shell projection is read-only ---------
t('P1-5', 'planned-only action carries date + shift into the existing panel; shell projection is shiftsForEmployee', () => {
  assert.ok(viewSrc.includes("manual = newManualState('add', row.ansattId);\n            manual.workDate = u.workDate; manual.shiftId = p.shiftId;"));
  assert.ok(viewSrc.includes("newManualState('correct', row.ansattId, day)"));
  assert.ok(viewSrc.includes("'Denne datoen tilhører ' + periodLabel(target) + '. Dagen føres i lønnsgrunnlaget for ' + monthNameOf(target) + '.'"));
  assert.ok(viewSrc.includes("heading.textContent = (c && (c.mode === 'correct' || c.mode === 'live')) ? 'Korriger arbeidstid' : 'Legg til arbeidstid'"));
  assert.ok(shellSrc.includes('function plannedShiftsForPayroll(ansattId)'));
  assert.ok(shellSrc.includes('shiftsForEmployee(scheduleStore(), FOUR_SEASON_TENANT.tenantId, ansattId, FOUR_SEASON_MANAGER_ACTOR)\n      .map((s) => ({ shiftId: s.shiftId, projection: s.projection, hours: durationHoursOf(s.projection) }))'));
  const from = (viewSrc.match(/from '\.\/[^']+'/g) || []).map((s) => s.slice(6).replace(/'/g, '')).sort();
  assert.deepEqual(from, ['./employee-shell-core.mjs', './management-payroll-core.mjs'], 'view import fence unchanged');
});

// ---- P1 CORRECTION (release-002) ---------------------------------------------------------------
// C1: the exact owner failure at the projection level — a shift created through the REAL schedule
// operation on the ONE store is immediately visible to the payroll projection and the day union.
t('C1', 'a shift created via applyScheduleOperation is seen by payroll planned hours and DAGER I PERIODEN without reseed', () => {
  const T = FOUR_SEASON_TENANT.tenantId;
  const employeeStore = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
  const scheduleStore = buildFourSeasonSchedule('2026-09-10', TZ);   // today's anchor: no seeded Aboud 04.08
  const before = buildPayrollPackage({ employeeStore, scheduleStore, attendanceStore: new Map(), tenantId: T, periodId: '2026-08', generatedAt: Date.now(), todayWorkDate: '2026-09-10' });
  const rowBefore = before.rows.find((r) => r.ansattId === 'ans-aboud');
  assert.equal(rowBefore.comparison.plannedHours, 36, 'fixture alone: 36 t (the number the owner saw)');
  const res = applyScheduleOperation({
    store: scheduleStore, tenantId: T, actor: FOUR_SEASON_MANAGER_ACTOR, now: Date.now(), policy: ETR2A_POLICY,
    op: { kind: 'create', workDate: '2026-08-04', ansattId: 'ans-aboud', fromHM: '16:00', toHM: '20:00', roleKey: 'butikkmedarbeider' },
    deps: { resolveAssignee: (id) => ({ status: 'FOUND', tenantId: T, ansattId: id }) },
  });
  assert.ok(res.ok, res.code);
  const after = buildPayrollPackage({ employeeStore, scheduleStore, attendanceStore: new Map(), tenantId: T, periodId: '2026-08', generatedAt: Date.now(), todayWorkDate: '2026-09-10' });
  const rowAfter = after.rows.find((r) => r.ansattId === 'ans-aboud');
  assert.equal(rowAfter.comparison.plannedHours, 40, 'the new shift is counted immediately');
  const planned = shiftsForEmployee(scheduleStore, T, 'ans-aboud', FOUR_SEASON_MANAGER_ACTOR).map((s) => ({ shiftId: s.shiftId, projection: s.projection, hours: durationHoursOf(s.projection) }));
  const union = dagerIPerioden({ plannedShifts: planned, days: rowAfter.payload.days, periodId: '2026-08' });
  const d4 = union.find((u) => u.workDate === '2026-08-04');
  assert.ok(d4 && d4.kind === 'planned_only', '04.08 is a planned-only row');
  assert.equal(d4.planned[0].hours, 4);
  assert.equal(d4.planned[0].shiftId, res.shiftId, 'the SAME canonical shift, no copy');
  // and the resolver sees it as M1 for that exact date
  assert.equal(manualTargetFor({ records: [], shifts: planned, workDate: '2026-08-04' }).mode, 'm1');
});
// C4: the in-app calendar grid is built from explicit civil numbers, Monday-first, Norwegian label.
t('C4', 'calendar grid: august 2026 starts on a Saturday, has 31 days, Norwegian label, exact ISO cells', () => {
  const g = calendarMonthGrid(2026, 8);
  assert.equal(g.label, 'august 2026');
  assert.equal(g.periodId, '2026-08');
  assert.deepEqual(g.weeks[0], [null, null, null, null, null, '2026-08-01', '2026-08-02']);
  assert.equal(g.weeks.flat().filter(Boolean).length, 31);
  assert.equal(g.weeks.flat().filter(Boolean)[3], '2026-08-04');
  assert.equal(g.weeks[g.weeks.length - 1].filter(Boolean).pop(), '2026-08-31');
  assert.deepEqual(NB_WEEKDAYS_SHORT, ['ma', 'ti', 'on', 'to', 'fr', 'lø', 'sø']);
  assert.equal(calendarMonthGrid(2028, 2).weeks.flat().filter(Boolean).length, 29, 'leap day deterministic');
  assert.equal(calendarMonthGrid(2026, 13), null);
  // a calendar pick and a typed entry meet in the SAME parser
  assert.equal(isoFromNbDate(nbDateFromIso('2026-08-04')).iso, '2026-08-04');
  assert.ok(!/input\('date'/.test(viewSrc) && !/type:\s*'date'/.test(viewSrc), 'no native date control anywhere in the view');
  assert.ok(viewSrc.includes("text: 'Kalender'") && viewSrc.includes('const pickIso = (iso) => { dateI.value = nbDateFromIso(iso); resolveInPlace();'), 'calendar writes the field and runs the same resolver path');
});
// C2/C3: the schedule notice is stated for one / many / none, and planned never pre-fills actual.
t('C2', 'schedule notice wording exists for one, several and none; save label follows the shift; no planned->actual prefill', () => {
  assert.ok(viewSrc.includes("'Planlagt vakt funnet: '"));
  assert.ok(viewSrc.includes("'Flere planlagte vakter for '"));
  assert.ok(viewSrc.includes("'Ingen planlagt vakt for '"));
  assert.ok(viewSrc.includes("'Registrer arbeidstid for vakten' : 'Lagre'"));
  // the only pre-fill of Start/Slutt is the CORRECTION path from the record's own effective values
  assert.ok(viewSrc.includes("if (day.startAt != null) st.startHM = fmtHM(day.startAt);"));
  assert.ok(!/plannedStartAt[^\n]*startHM|startHM[^\n]*plannedStartAt/.test(viewSrc), 'planned times never reach the Start field');
});

console.log(lines.join('\n'));
console.log('\nMANAGEMENT_PRESENTATION_P1_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
