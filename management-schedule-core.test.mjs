// management-schedule-core.test.mjs
// MANAGEMENT VAKTPLAN CORE — deterministic tests. Node built-ins only; all now/timezone
// INJECTED. Run: node management-schedule-core.test.mjs
// Covers: manager week grid/projection (G*) and the single operation boundary (O*), including
// the shared-store proof that the EXISTING employee projection reads a manager change from the
// SAME store object (design §6.1).

import assert from 'node:assert/strict';
import {
  tenantShiftsOf, managerWeekFor, plannedInstantsFor, newShiftIdFor, applyScheduleOperation,
  monthDaysOf, managerMonthFor, planningSummaryFor, compensationOf, openShiftsOf, isEligible,
  searchPeople, canOpenVaktplan, shiftsForEmployee, durationHoursOf,
} from './management-schedule-core.mjs';
import { buildFourSeasonSchedule, buildFourSeasonScaleSet, FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MEMBERSHIPS, FOUR_SEASON_MANAGER_ACTOR } from './employee-schedule-fixture.mjs';
import { ownShiftsForMembership, weekFor, isOvernight, addDays } from './employee-schedule-week.mjs';
import { monthGridFor } from './employee-schedule-month.mjs';
import { tenantLocalHMToUtcMs, ETR2A_POLICY } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const POLICY = ETR2A_POLICY;
const TZ = POLICY.timezone;                       // Europe/Oslo
const T = FOUR_SEASON_TENANT.tenantId;
const ANCHOR = '2026-08-26';                      // Wednesday; Maria off on 2026-08-27 and 2026-08-29
const NOW = tenantLocalHMToUtcMs(ANCHOR, '12:00', TZ);
const ADMIN = FOUR_SEASON_MANAGER_ACTOR;
const MARIA = FOUR_SEASON_MEMBERSHIPS.find((m) => m.ansattId === 'ans-maria');
const FROZEN_FIELDS = ['ansattId', 'createdAt', 'createdByUid', 'plannedEndAt', 'plannedStartAt', 'revision', 'roleKey', 'status', 'updatedAt', 'workDate'];

const seed = () => buildFourSeasonSchedule(ANCHOR, TZ);
const DEPS = {
  resolveAssignee: (a) => FOUR_SEASON_PEOPLE.some((p) => p.ansattId === a) ? { status: 'FOUND', tenantId: T, ansattId: a } : { status: 'NOT_FOUND' },
  attendanceExistsFor: () => false,
};
const apply = (store, op, over) => applyScheduleOperation(Object.assign({ store, tenantId: T, actor: ADMIN, op, now: NOW, policy: POLICY, deps: DEPS }, over || {}));
const mw = (container, over) => managerWeekFor(Object.assign({ anchorWorkDate: ANCHOR, timezone: TZ, container, tenantId: T, people: FOUR_SEASON_PEOPLE, todayWorkDate: ANCHOR }, over || {}));
const countOf = (store) => Object.keys(store[T]).length;

// ---- grid / projection ----
t('G1', 'week grid: Monday-Sunday days and one row per employee in people order', () => {
  const w = mw(seed());
  assert.deepEqual(w.days, ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30']);
  assert.equal(w.monday, '2026-08-24'); assert.equal(w.sunday, '2026-08-30');
  assert.deepEqual(w.rows.map((r) => r.ansattId), FOUR_SEASON_PEOPLE.map((p) => p.ansattId));
  for (const r of w.rows) { assert.equal(r.days.length, 7); r.days.forEach((d, i) => assert.equal(d.workDate, w.days[i])); }
});
t('G2', 'tenant isolation: unknown tenant projects to empty rows, tenant-first', () => {
  assert.deepEqual(tenantShiftsOf(seed(), 'tenant-x'), []);
  const w = mw(seed(), { tenantId: 'tenant-x' });
  assert.equal(w.rows.length, 5);
  for (const r of w.rows) for (const d of r.days) assert.equal(d.shifts.length, 0);
});
t('G3', 'grouping: every shift in a row belongs to that row employee', () => {
  const w = mw(seed());
  for (const r of w.rows) for (const d of r.days) for (const s of d.shifts) assert.equal(s.projection.ansattId, r.ansattId);
});
t('G4', 'placement by workDate: Maria overnight Friday shift sits on 2026-08-28', () => {
  const maria = mw(seed()).rows.find((r) => r.ansattId === 'ans-maria');
  const fri = maria.days.find((d) => d.workDate === '2026-08-28');
  assert.equal(fri.shifts.length, 1);
  assert.equal(fri.shifts[0].projection.workDate, '2026-08-28');
});
t('G5', 'multiple shifts same employee/day: split Sunday renders both, sorted by start', () => {
  const maria = mw(seed()).rows.find((r) => r.ansattId === 'ans-maria');
  const sun = maria.days.find((d) => d.workDate === '2026-08-30');
  assert.equal(sun.shifts.length, 2);
  assert.ok(sun.shifts[0].projection.plannedStartAt < sun.shifts[1].projection.plannedStartAt);
});
t('G6', 'cancelled shift retained with status cancelled (Monday 2026-08-24)', () => {
  const maria = mw(seed()).rows.find((r) => r.ansattId === 'ans-maria');
  const mon = maria.days.find((d) => d.workDate === '2026-08-24');
  assert.equal(mon.shifts.length, 1);
  assert.equal(mon.shifts[0].projection.status, 'cancelled');
});
t('G7', 'overnight stays on its workDate, flagged; next day stays free', () => {
  const maria = mw(seed()).rows.find((r) => r.ansattId === 'ans-maria');
  assert.equal(maria.days.find((d) => d.workDate === '2026-08-28').shifts[0].overnight, true);
  assert.equal(maria.days.find((d) => d.workDate === '2026-08-29').shifts.length, 0);
});
t('G8', 'open/unassigned shift is never represented as an employee assignment', () => {
  const store = seed();
  const openIds = tenantShiftsOf(store, T).filter((s) => s.projection.ansattId === null);
  assert.ok(openIds.length >= 1, 'seed has an open shift');
  const w = mw(store);
  let total = 0;
  for (const r of w.rows) for (const d of r.days) for (const s of d.shifts) { total++; assert.notEqual(s.projection.ansattId, null); }
  assert.ok(total > 0);
});
t('G9', 'week derivation across the year boundary (2026-12-31 -> week 53, Mon 2026-12-28..Sun 2027-01-03)', () => {
  const w = mw(seed(), { anchorWorkDate: '2026-12-31' });
  assert.equal(w.monday, '2026-12-28'); assert.equal(w.sunday, '2027-01-03'); assert.equal(w.weekNumber, 53);
});
t('G10', 'plannedInstantsFor: same-day range and overnight (to earlier than from ends next local day)', () => {
  const a = plannedInstantsFor('2026-08-27', '10:00', '16:00', TZ);
  assert.equal(a.plannedStartAt, tenantLocalHMToUtcMs('2026-08-27', '10:00', TZ));
  assert.equal(a.plannedEndAt, tenantLocalHMToUtcMs('2026-08-27', '16:00', TZ));
  const b = plannedInstantsFor('2026-08-27', '22:00', '02:00', TZ);
  assert.equal(b.plannedEndAt, tenantLocalHMToUtcMs('2026-08-28', '02:00', TZ));
  assert.ok(b.plannedEndAt > b.plannedStartAt);
});

// ---- operation boundary ----
t('O1', 'create: assigned shift with EXACTLY the frozen field set, revision 1, in store under mg- id', () => {
  const store = seed();
  const n0 = countOf(store);
  const r = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '10:00', toHM: '16:00', roleKey: 'butikkmedarbeider' });
  assert.equal(r.ok, true, r.code);
  assert.equal(r.shiftId, 'mg-2026-08-27-ans-maria');
  assert.deepEqual(Object.keys(r.projection).sort(), FROZEN_FIELDS);
  assert.equal(r.projection.status, 'assigned');
  assert.equal(r.projection.revision, 1);
  assert.equal(r.projection.workDate, '2026-08-27');
  assert.equal(r.projection.plannedStartAt, tenantLocalHMToUtcMs('2026-08-27', '10:00', TZ));
  assert.equal(r.projection.createdByUid, ADMIN.uid);
  assert.equal(store[T][r.shiftId], r.projection);
  assert.equal(countOf(store), n0 + 1);
});
t('O2', 'create twice on the same employee/date: collision-safe distinct ids, first shift untouched', () => {
  const store = seed();
  const r1 = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '08:00', toHM: '12:00', roleKey: null });
  const p1 = store[T][r1.shiftId];
  const r2 = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '16:00', toHM: '20:00', roleKey: null });
  assert.equal(r1.ok, true); assert.equal(r2.ok, true);
  assert.equal(r1.shiftId, 'mg-2026-08-27-ans-maria');
  assert.equal(r2.shiftId, 'mg-2026-08-27-ans-maria-2');
  assert.equal(store[T][r1.shiftId], p1);
  assert.equal(p1.plannedStartAt, tenantLocalHMToUtcMs('2026-08-27', '08:00', TZ));
});
t('O3', 'create for unknown employee fails closed; store unchanged', () => {
  const store = seed(); const n0 = countOf(store);
  const r = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-nobody', fromHM: '10:00', toHM: '14:00', roleKey: null });
  assert.equal(r.ok, false); assert.equal(r.code, 'ASSIGNEE_NOT_RESOLVED');
  assert.equal(countOf(store), n0);
});
t('O4', 'tenant fail-closed: unknown store tenant and cross-tenant actor both refuse', () => {
  const store = seed(); const n0 = countOf(store);
  const r1 = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '10:00', toHM: '14:00' }, { tenantId: 'tenant-x' });
  assert.equal(r1.ok, false); assert.equal(r1.code, 'TENANT_UNKNOWN');
  const r2 = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '10:00', toHM: '14:00' }, { actor: Object.assign({}, ADMIN, { tenantId: 'tenant-x' }) });
  assert.equal(r2.ok, false); assert.equal(r2.code, 'CROSS_TENANT');
  assert.equal(countOf(store), n0);
});
t('O5', 'non-admin actor cannot operate (NOT_ADMIN, fail-closed)', () => {
  const store = seed(); const n0 = countOf(store);
  const r = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '10:00', toHM: '14:00' }, { actor: Object.assign({}, ADMIN, { accessRole: 'employee' }) });
  assert.equal(r.ok, false); assert.equal(r.code, 'NOT_ADMIN');
  assert.equal(countOf(store), n0);
});
t('O6', 'revise: same identity, times changed, revision advanced, created* preserved, updatedAt = now', () => {
  const store = seed();
  const c = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '10:00', toHM: '16:00', roleKey: 'butikkmedarbeider' });
  const before = store[T][c.shiftId];
  const r = apply(store, { kind: 'revise', shiftId: c.shiftId, fromHM: '12:00', toHM: '18:00' });
  assert.equal(r.ok, true, r.code);
  assert.equal(r.shiftId, c.shiftId);
  const p = store[T][c.shiftId];
  assert.equal(p.revision, 2);
  assert.equal(p.plannedStartAt, tenantLocalHMToUtcMs('2026-08-27', '12:00', TZ));
  assert.equal(p.plannedEndAt, tenantLocalHMToUtcMs('2026-08-27', '18:00', TZ));
  assert.equal(p.workDate, before.workDate);
  assert.equal(p.createdAt, before.createdAt);
  assert.equal(p.createdByUid, before.createdByUid);
  assert.equal(p.status, 'assigned');
  assert.equal(p.updatedAt, NOW);
  assert.deepEqual(Object.keys(p).sort(), FROZEN_FIELDS);
});
t('O7', 'cancel: status cancelled, revision advanced, identity and other fields preserved', () => {
  const store = seed();
  const id = 'fs-2026-08-25-ans-maria';
  const before = Object.assign({}, store[T][id]);
  const r = apply(store, { kind: 'cancel', shiftId: id });
  assert.equal(r.ok, true, r.code);
  const p = store[T][id];
  assert.equal(p.status, 'cancelled');
  assert.equal(p.revision, before.revision + 1);
  assert.equal(p.plannedStartAt, before.plannedStartAt);
  assert.equal(p.ansattId, before.ansattId);
  assert.equal(p.workDate, before.workDate);
  assert.deepEqual(Object.keys(p).sort(), FROZEN_FIELDS);
});
t('O8', 'cancelled is terminal: cancel-again and revise both refuse (SHIFT_CANCELLED), store unchanged', () => {
  const store = seed();
  const id = 'fs-2026-08-25-ans-maria';
  assert.equal(apply(store, { kind: 'cancel', shiftId: id }).ok, true);
  const after = store[T][id];
  const r1 = apply(store, { kind: 'cancel', shiftId: id });
  const r2 = apply(store, { kind: 'revise', shiftId: id, fromHM: '08:00', toHM: '12:00' });
  assert.equal(r1.ok, false); assert.equal(r1.code, 'SHIFT_CANCELLED');
  assert.equal(r2.ok, false); assert.equal(r2.code, 'SHIFT_CANCELLED');
  assert.equal(store[T][id], after);
  assert.equal(store[T][id].revision, after.revision);
});
t('O9', 'attendance existence blocks cancel (ATTENDANCE_BLOCKS_CHANGE), store unchanged', () => {
  const store = seed();
  const id = 'fs-2026-08-26-ans-maria';
  const r = apply(store, { kind: 'cancel', shiftId: id }, { deps: Object.assign({}, DEPS, { attendanceExistsFor: () => true }) });
  assert.equal(r.ok, false); assert.equal(r.code, 'ATTENDANCE_BLOCKS_CHANGE');
  assert.equal(store[T][id].status, 'assigned');
});
t('O10', 'invalid times fail closed: equal start/end and garbage HM never reach the store', () => {
  const store = seed(); const n0 = countOf(store);
  const r1 = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '10:00', toHM: '10:00' });
  assert.equal(r1.ok, false); assert.equal(r1.code, 'END_BEFORE_START');
  const r2 = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: 'zz:zz', toHM: '14:00' });
  assert.equal(r2.ok, false); assert.equal(r2.code, 'TIME_INVALID');
  const r3 = apply(store, { kind: 'revise', shiftId: 'fs-2026-08-26-ans-maria', fromHM: '25:00', toHM: '14:00' });
  assert.equal(r3.ok, false); assert.equal(r3.code, 'TIME_INVALID');
  assert.equal(countOf(store), n0);
});
t('O11', 'unknown operation kind and unknown shift fail closed', () => {
  const store = seed();
  assert.equal(apply(store, { kind: 'reassign', shiftId: 'fs-2026-08-26-ans-maria' }).code, 'UNKNOWN_OPERATION');
  assert.equal(apply(store, { kind: 'revise', shiftId: 'no-such-shift', fromHM: '08:00', toHM: '12:00' }).code, 'NO_SHIFT');
  assert.equal(apply(store, { kind: 'cancel', shiftId: 'no-such-shift' }).code, 'NO_SHIFT');
});
t('O12', 'create overnight: 22:00-02:00 stays on its workDate and is overnight in the projection helpers', () => {
  const store = seed();
  const r = apply(store, { kind: 'create', workDate: '2026-08-29', ansattId: 'ans-maria', fromHM: '22:00', toHM: '02:00', roleKey: null });
  assert.equal(r.ok, true, r.code);
  assert.equal(r.projection.workDate, '2026-08-29');
  assert.equal(isOvernight(r.projection, TZ), true);
  const maria = mw(store).rows.find((x) => x.ansattId === 'ans-maria');
  assert.ok(maria.days.find((d) => d.workDate === '2026-08-29').shifts.some((s) => s.shiftId === r.shiftId && s.overnight));
});
t('O13', 'SHARED STORE PROOF: manager create/edit/cancel are read by the EXISTING employee projection from the SAME store object', () => {
  const store = seed();
  // create for Maria on her free Thursday
  const c = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '10:00', toHM: '16:00', roleKey: 'butikkmedarbeider' });
  assert.equal(c.ok, true, c.code);
  // edit the existing anchor-day shift, cancel the Tuesday shift
  const e = apply(store, { kind: 'revise', shiftId: 'fs-2026-08-26-ans-maria', fromHM: '13:00', toHM: '21:00' });
  assert.equal(e.ok, true, e.code);
  const x = apply(store, { kind: 'cancel', shiftId: 'fs-2026-08-25-ans-maria' });
  assert.equal(x.ok, true, x.code);
  // EMPLOYEE projection (frozen helper, Maria membership) over the SAME container object:
  const own = ownShiftsForMembership(store, MARIA);
  const created = own.find((s) => s.shiftId === c.shiftId);
  assert.ok(created, 'employee view sees the created shift');
  assert.equal(created.projection, store[T][c.shiftId]);          // same object reference — one store, no copy
  const edited = own.find((s) => s.shiftId === 'fs-2026-08-26-ans-maria');
  assert.equal(edited.projection.plannedStartAt, tenantLocalHMToUtcMs('2026-08-26', '13:00', TZ));
  const cancelled = own.find((s) => s.shiftId === 'fs-2026-08-25-ans-maria');
  assert.equal(cancelled.projection.status, 'cancelled');
  // and the employee WEEK view places the created shift on Thursday
  const wk = weekFor(ANCHOR, TZ, own, ANCHOR);
  assert.ok(wk.days.find((d) => d.workDate === '2026-08-27').shifts.some((s) => s.shiftId === c.shiftId));
});
t('O14', 'operation results carry the engine event with matching revision; failed ops never write', () => {
  const store = seed();
  const c = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-maria', fromHM: '10:00', toHM: '16:00' });
  assert.equal(c.event.type, 'shift_created'); assert.equal(c.event.revision, 1);
  const e = apply(store, { kind: 'revise', shiftId: c.shiftId, fromHM: '11:00', toHM: '16:00' });
  assert.equal(e.event.type, 'shift_revised'); assert.equal(e.event.revision, 2);
  const x = apply(store, { kind: 'cancel', shiftId: c.shiftId });
  assert.equal(x.event.type, 'shift_cancelled'); assert.equal(x.event.revision, 3);
  const n0 = countOf(store);
  assert.equal(apply(store, { kind: 'revise', shiftId: c.shiftId, fromHM: '09:00', toHM: '15:00' }).ok, false); // terminal
  assert.equal(countOf(store), n0);
});

// ============================================================================================
// SECOND INCREMENT — month matrix, planned hours, planning-cost derivation, Manko/eligibility,
// claim, search, capability routing, manager projection, 5->40 scale sanity.
// ============================================================================================
const P = (ansattId, workDate, from, to, status) => {
  const endDate = to < from ? addDays(workDate, 1) : workDate;
  return { ansattId, plannedStartAt: tenantLocalHMToUtcMs(workDate, from, TZ), plannedEndAt: tenantLocalHMToUtcMs(endDate, to, TZ), workDate, roleKey: null, status: status || (ansattId ? 'assigned' : 'open'), revision: 1, createdByUid: 'u', createdAt: 0, updatedAt: 0 };
};
// tiny deterministic container: Maria 8h + 4h overnight + one cancelled; one open 6h; Aboud 4h.
const tiny = () => ({ [T]: {
  m1: P('ans-maria', '2026-08-24', '08:00', '16:00'),
  m2: P('ans-maria', '2026-08-25', '22:00', '02:00'),
  mc: P('ans-maria', '2026-08-26', '10:00', '14:00', 'cancelled'),
  op1: P(null, '2026-08-27', '10:00', '16:00'),
  b1: P('ans-aboud', '2026-08-24', '10:00', '14:00'),
} });
const WEEK_SCOPE = { kind: 'week', anchorWorkDate: '2026-08-24' };
const MONTH_SCOPE = { kind: 'month', year: 2026, month: 8 };
const sumFor = (container, scope) => planningSummaryFor({ container, tenantId: T, people: FOUR_SEASON_PEOPLE, scope });
const rowOf = (s, id) => s.rows.find((r) => r.ansattId === id);

t('MM1', 'monthDaysOf: full calendar span incl. leap/non-leap February', () => {
  const aug = monthDaysOf(2026, 8);
  assert.equal(aug.length, 31); assert.equal(aug[0], '2026-08-01'); assert.equal(aug[30], '2026-08-31');
  assert.equal(monthDaysOf(2026, 2).length, 28);
  assert.equal(monthDaysOf(2028, 2).length, 29);
});
t('MM2', 'managerMonthFor: rows x every day; overnight on its workDate with flag; next day untouched', () => {
  const m = managerMonthFor({ year: 2026, month: 8, timezone: TZ, container: seed(), tenantId: T, people: FOUR_SEASON_PEOPLE, todayWorkDate: ANCHOR });
  assert.equal(m.rows.length, 5); assert.equal(m.days.length, 31);
  const maria = m.rows.find((r) => r.ansattId === 'ans-maria');
  maria.cells.forEach((c, i) => assert.equal(c.workDate, m.days[i]));
  const fri = maria.cells.find((c) => c.workDate === '2026-08-28');
  assert.equal(fri.shifts.length, 1); assert.equal(fri.shifts[0].overnight, true);
  assert.equal(maria.cells.find((c) => c.workDate === '2026-08-29').shifts.length, 0);
  assert.equal(m.rows.length && maria.cells.filter((c) => c.isToday).length, 1);
});
t('MM3', 'managerMonthFor: multiple shifts on one date stacked and sorted by start', () => {
  const m = managerMonthFor({ year: 2026, month: 8, timezone: TZ, container: seed(), tenantId: T, people: FOUR_SEASON_PEOPLE, todayWorkDate: null });
  const sun = m.rows.find((r) => r.ansattId === 'ans-maria').cells.find((c) => c.workDate === '2026-08-30');
  assert.equal(sun.shifts.length, 2);
  assert.ok(sun.shifts[0].projection.plannedStartAt < sun.shifts[1].projection.plannedStartAt);
});
t('MM4', 'managerMonthFor: cancelled retained on its day with status cancelled', () => {
  const m = managerMonthFor({ year: 2026, month: 8, timezone: TZ, container: seed(), tenantId: T, people: FOUR_SEASON_PEOPLE, todayWorkDate: null });
  const mon = m.rows.find((r) => r.ansattId === 'ans-maria').cells.find((c) => c.workDate === '2026-08-24');
  assert.equal(mon.shifts[0].projection.status, 'cancelled');
});
t('MH1', 'gross planned hours: assigned non-cancelled only; open excluded from rows, counted as gap', () => {
  const s = sumFor(tiny(), WEEK_SCOPE);
  assert.equal(rowOf(s, 'ans-maria').grossHours, 12);       // 8h + 4h overnight; cancelled 4h excluded
  assert.equal(rowOf(s, 'ans-aboud').grossHours, 4);
  assert.equal(s.totals.grossHours, 16);
  assert.equal(s.totals.openShiftCount, 1);
  assert.equal(s.totals.openGapHours, 6);
});
t('MH2', 'break policy never silently reduces planned gross hours (8h span stays 8h)', () => {
  assert.equal(durationHoursOf(P('ans-maria', '2026-08-24', '08:00', '16:00')), 8);
  const s = sumFor(tiny(), WEEK_SCOPE);
  assert.equal(rowOf(s, 'ans-maria').grossHours, 12);       // no expectedBreakMinutes deduction anywhere
});
t('MC1', 'hourly planning cost = gross hours x demo planning rate', () => {
  const s = sumFor(tiny(), WEEK_SCOPE);
  assert.equal(rowOf(s, 'ans-maria').estimatedVariableCost, 12 * 250);
  assert.equal(rowOf(s, 'ans-aboud').estimatedVariableCost, 4 * 220);
  assert.equal(s.totals.variableCostKnown, 3880);
});
t('MC2', 'missing compensation derives UNKNOWN: no cost, never zero, omission counted', () => {
  assert.deepEqual(compensationOf(FOUR_SEASON_PEOPLE.find((p) => p.ansattId === 'ans-yussef')), { model: 'unknown' });
  assert.deepEqual(compensationOf({ compensation: { model: 'timelonn', plannedHourlyRate: -5 } }), { model: 'unknown' });
  const s = sumFor(tiny(), WEEK_SCOPE);
  const y = rowOf(s, 'ans-yussef');
  assert.equal(y.model, 'unknown'); assert.equal(y.estimatedVariableCost, null);
  assert.equal(s.totals.unknownCompensationCount, 1);
  assert.ok(s.omissions.some((o) => o.includes('mangler lønnsgrunnlag')));
});
t('MC3', 'fixed salary MONTH: full monthly planned salary; adding an ordinary shift moves hours, not base salary', () => {
  const store = seed();
  const before = sumFor(store, MONTH_SCOPE);
  const a0 = rowOf(before, 'ans-athar');
  assert.equal(a0.fixedMonthlySalaryForScope, 52000);
  const r = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: 'ans-athar', fromHM: '09:00', toHM: '13:00', roleKey: 'butikksjef' });
  assert.equal(r.ok, true, r.code);
  const after = sumFor(store, MONTH_SCOPE);
  const a1 = rowOf(after, 'ans-athar');
  assert.equal(a1.fixedMonthlySalaryForScope, 52000);                       // base fixed salary unmoved
  assert.equal(a1.grossHours, a0.grossHours + 4);                           // hours moved honestly
  assert.equal(after.totals.fixedMonthlySalaryKnown, before.totals.fixedMonthlySalaryKnown);
});
t('MC4', 'fixed salary WEEK: no numeric weekly allocation; non-allocation explicit; hours still correct', () => {
  const s = sumFor(seed(), { kind: 'week', anchorWorkDate: ANCHOR });
  const a = rowOf(s, 'ans-athar');
  assert.equal(a.model, 'fastlonn');
  assert.equal(a.estimatedVariableCost, null);
  assert.equal(a.fixedMonthlySalaryForScope, null);                          // never /4 or /4.33
  assert.equal(s.totals.fixedMonthlySalaryKnown, null);
  assert.ok(a.notes.join(' ').includes('ikke beregnet i denne versjonen'));
  assert.ok(a.grossHours > 0);                                               // Athar works Mon/Wed/Fri
  assert.ok(s.omissions.some((o) => o.includes('fastlønn')));
});
t('MC5', 'open Manko cost is unknown until assignment (gap hours shown, no zero-cost anywhere)', () => {
  const s = sumFor(tiny(), WEEK_SCOPE);
  assert.equal(s.totals.openGapHours, 6);
  assert.ok(s.omissions.some((o) => o.includes('ukjent')));
  for (const r of s.rows) if (r.model === 'unknown') assert.notEqual(r.estimatedVariableCost, 0);
});
t('MC6', 'month aggregate combines known hourly variable + known fixed monthly salary and names omissions', () => {
  const s = sumFor(tiny(), MONTH_SCOPE);
  assert.equal(s.totals.fixedMonthlySalaryKnown, 112000);                    // Athar 52000 + Herish 60000
  assert.equal(s.totals.combinedKnownCost, s.totals.variableCostKnown + 112000);
  assert.ok(s.omissions.some((o) => o.includes('mangler lønnsgrunnlag')));
  assert.ok(s.omissions.some((o) => o.includes('ukjent')));
});
t('ME1', 'eligibility: same-tenant open shift eligible; invalid tenant/cancelled/assigned fail closed', () => {
  const maria = FOUR_SEASON_PEOPLE[0];
  assert.equal(isEligible(maria, P(null, '2026-08-27', '10:00', '16:00'), T), true);
  assert.equal(isEligible(maria, P(null, '2026-08-27', '10:00', '16:00'), ''), false);
  assert.equal(isEligible(maria, P(null, '2026-08-27', '10:00', '16:00', 'cancelled'), T), false);
  assert.equal(isEligible(maria, P('ans-aboud', '2026-08-27', '10:00', '16:00'), T), false);
  assert.equal(isEligible({ name: 'x' }, P(null, '2026-08-27', '10:00', '16:00'), T), false);
});
t('MCL1', 'claim open -> assigned succeeds through the single boundary; revision advances', () => {
  const store = seed();
  const open = openShiftsOf(store, T);
  assert.ok(open.length >= 1);
  const id = open[0].shiftId;
  const rev0 = store[T][id].revision;
  const r = apply(store, { kind: 'claim', shiftId: id, ansattId: 'ans-maria' });
  assert.equal(r.ok, true, r.code);
  assert.equal(store[T][id].status, 'assigned');
  assert.equal(store[T][id].ansattId, 'ans-maria');
  assert.equal(store[T][id].revision, rev0 + 1);
  assert.ok(ownShiftsForMembership(store, MARIA).some((s) => s.shiftId === id));
});
t('MCL2', 'claim already-assigned fails closed (SHIFT_TAKEN) and changes nothing', () => {
  const store = seed();
  const id = openShiftsOf(store, T)[0].shiftId;
  assert.equal(apply(store, { kind: 'claim', shiftId: id, ansattId: 'ans-maria' }).ok, true);
  const snap = store[T][id];
  const r = apply(store, { kind: 'claim', shiftId: id, ansattId: 'ans-aboud' });
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_TAKEN');
  assert.equal(store[T][id], snap);
  assert.equal(store[T][id].ansattId, 'ans-maria');
});
t('MCL3', 'claim cancelled fails closed and changes nothing; unknown claimant fails closed', () => {
  const store = seed();
  const c = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: null, fromHM: '10:00', toHM: '14:00' });
  assert.equal(c.ok, true, c.code);
  assert.equal(apply(store, { kind: 'claim', shiftId: c.shiftId, ansattId: 'ans-nobody' }).code, 'CLAIMANT_UNKNOWN');
  assert.equal(apply(store, { kind: 'cancel', shiftId: c.shiftId }).ok, true);
  const snap = store[T][c.shiftId];
  const r = apply(store, { kind: 'claim', shiftId: c.shiftId, ansattId: 'ans-maria' });
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_CANCELLED');
  assert.equal(store[T][c.shiftId], snap);
});
t('MCL4', 'hourly claimant raises the planner-sensitive variable total by hours x rate', () => {
  const store = seed();
  const id = openShiftsOf(store, T)[0].shiftId;                              // 12:00-16:00 = 4h
  const before = sumFor(store, { kind: 'week', anchorWorkDate: ANCHOR }).totals.variableCostKnown;
  assert.equal(apply(store, { kind: 'claim', shiftId: id, ansattId: 'ans-maria' }).ok, true);
  const after = sumFor(store, { kind: 'week', anchorWorkDate: ANCHOR }).totals.variableCostKnown;
  assert.equal(after, before + 4 * 250);
});
t('MCL5', 'fixed-salary claimant: base fixed salary unmoved, variable total unmoved, hours move', () => {
  const store = seed();
  const c = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: null, fromHM: '10:00', toHM: '14:00' });
  const before = sumFor(store, MONTH_SCOPE).totals;
  assert.equal(apply(store, { kind: 'claim', shiftId: c.shiftId, ansattId: 'ans-athar' }).ok, true);
  const after = sumFor(store, MONTH_SCOPE).totals;
  assert.equal(after.fixedMonthlySalaryKnown, before.fixedMonthlySalaryKnown);
  assert.equal(after.variableCostKnown, before.variableCostKnown);
  assert.equal(after.grossHours, before.grossHours + 4);
  assert.equal(after.openShiftCount, before.openShiftCount - 1);
});
t('MS1', 'simple and detailed render from the SAME derivation result (one object, deterministic)', () => {
  const a = sumFor(tiny(), WEEK_SCOPE);
  const b = sumFor(tiny(), WEEK_SCOPE);
  assert.deepEqual(a, b);                                                    // deterministic, single path
  const r = rowOf(a, 'ans-maria');
  // one row object carries BOTH the simple fields and the detailed fields
  assert.ok('grossHours' in r && 'estimatedVariableCost' in r && 'model' in r && 'plannedHourlyRate' in r && Array.isArray(r.notes));
  assert.ok(r.notes.join(' ').includes('ikke beregnet i denne versjonen'));  // overtime/supplements named
});
t('MQ1', 'searchPeople: substring match, case-insensitive; empty query returns everyone; clear path', () => {
  assert.deepEqual(searchPeople(FOUR_SEASON_PEOPLE, 'mar').map((p) => p.name), ['Maria']);
  assert.equal(searchPeople(FOUR_SEASON_PEOPLE, '').length, 5);
  assert.equal(searchPeople(FOUR_SEASON_PEOPLE, '  ').length, 5);
  assert.equal(searchPeople(FOUR_SEASON_PEOPLE, 'zz').length, 0);
});
t('MCA1', 'capability routing: manager actor allowed; employee-shaped or flagless actor refused', () => {
  assert.equal(canOpenVaktplan(FOUR_SEASON_MANAGER_ACTOR), true);
  assert.equal(canOpenVaktplan({ uid: 'x', accessRole: 'employee', accessEnabled: true, canViewOwnSchedule: true }), false);
  assert.equal(canOpenVaktplan(Object.assign({}, FOUR_SEASON_MANAGER_ACTOR, { canManageSchedule: false })), false);
  assert.equal(canOpenVaktplan(null), false);
});
t('MCA2', 'manager projection ("se som ansatt"): manager stays the actor; target shifts only, same references', () => {
  const store = seed();
  const own = shiftsForEmployee(store, T, 'ans-maria', ADMIN);
  assert.ok(own.length > 0);
  for (const s of own) { assert.equal(s.projection.ansattId, 'ans-maria'); assert.equal(s.projection, store[T][s.shiftId]); }
  assert.deepEqual(shiftsForEmployee(store, T, 'ans-maria', Object.assign({}, ADMIN, { canManageSchedule: false })), []);
});
t('MST1', 'SAME-STORE loop: Manko create -> Ledige (eligible) -> claim -> employee Week AND Month see the same shift', () => {
  const store = seed();
  const c = apply(store, { kind: 'create', workDate: '2026-08-27', ansattId: null, fromHM: '10:00', toHM: '14:00' });
  assert.equal(c.ok, true, c.code);
  const ledige = openShiftsOf(store, T).filter((s) => isEligible(FOUR_SEASON_PEOPLE[0], s.projection, T));
  assert.ok(ledige.some((s) => s.shiftId === c.shiftId));
  assert.equal(apply(store, { kind: 'claim', shiftId: c.shiftId, ansattId: 'ans-maria' }).ok, true);
  const own = ownShiftsForMembership(store, MARIA);
  const claimed = own.find((s) => s.shiftId === c.shiftId);
  assert.ok(claimed); assert.equal(claimed.projection, store[T][c.shiftId]); // same object — one store
  const wk = weekFor(ANCHOR, TZ, own, ANCHOR);
  assert.ok(wk.days.find((d) => d.workDate === '2026-08-27').shifts.some((s) => s.shiftId === c.shiftId));
  const mg = monthGridFor({ year: 2026, month: 8, shifts: own, now: NOW, timezone: TZ });
  assert.ok(mg.cells.find((x) => x.workDate === '2026-08-27').shifts.some((s) => s.shiftId === c.shiftId));
});
t('MSC1', 'scale proof: ~40 synthetic rows derive sanely (frozen fields, unique ids, grids and summary work)', () => {
  const scale = buildFourSeasonScaleSet(ANCHOR, TZ);
  assert.equal(scale.people.length, 40);
  assert.deepEqual(scale.people.slice(0, 5).map((p) => p.ansattId), FOUR_SEASON_PEOPLE.map((p) => p.ansattId));
  for (const s of tenantShiftsOf(scale.schedule, T)) assert.deepEqual(Object.keys(s.projection).sort(), FROZEN_FIELDS);
  const w = managerWeekFor({ anchorWorkDate: ANCHOR, timezone: TZ, container: scale.schedule, tenantId: T, people: scale.people, todayWorkDate: ANCHOR });
  assert.equal(w.rows.length, 40);
  const m = managerMonthFor({ year: 2026, month: 8, timezone: TZ, container: scale.schedule, tenantId: T, people: scale.people, todayWorkDate: ANCHOR });
  assert.equal(m.rows.length, 40);
  const s = planningSummaryFor({ container: scale.schedule, tenantId: T, people: scale.people, scope: MONTH_SCOPE });
  assert.equal(s.rows.length, 40);
  assert.ok(Number.isFinite(s.totals.variableCostKnown) && s.totals.variableCostKnown > 0);
  assert.ok(s.totals.unknownCompensationCount > 1);                          // every third demo person is UNKNOWN + Yussef
});
t('MSC2', 'scale proof set is deterministic and does not disturb the base five-person container', () => {
  assert.deepEqual(buildFourSeasonScaleSet(ANCHOR, TZ), buildFourSeasonScaleSet(ANCHOR, TZ));
  const base = seed();
  const scale = buildFourSeasonScaleSet(ANCHOR, TZ).schedule;
  for (const id of Object.keys(base[T])) assert.deepEqual(scale[T][id], base[T][id]);   // base ids byte-identical
});

console.log(lines.join('\n'));
console.log('MANAGEMENT_SCHEDULE_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
