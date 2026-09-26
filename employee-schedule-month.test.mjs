// employee-schedule-month.test.mjs
// EMPLOYEE MONTH SCHEDULE — pure month-grid tests. Node built-ins only. All dates/timezones
// INJECTED (now/timezone never read from the host). Run: node employee-schedule-month.test.mjs
// Governing: SOREN-SIRRHA-EMPLOYEE-MONTH-VIEW-DESIGN-RECOMMENDATION-001 §§5, 6, 8.

import assert from 'node:assert/strict';
import { monthGridFor, monthOfWorkDate, prevMonth, nextMonth } from './employee-schedule-month.mjs';
import { addDays, ownShiftsForMembership } from './employee-schedule-week.mjs';
import { buildFourSeasonSchedule, FOUR_SEASON_MEMBERSHIPS } from './employee-schedule-fixture.mjs';
import { tenantLocalHMToUtcMs } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }
const TZ = 'Europe/Oslo';
const sh = (id, workDate, from, to, status) => {
  const endDate = to < from ? addDays(workDate, 1) : workDate;
  return { shiftId: id, projection: { ansattId: 'x', plannedStartAt: tenantLocalHMToUtcMs(workDate, from, TZ), plannedEndAt: tenantLocalHMToUtcMs(endDate, to, TZ), workDate, roleKey: null, status: status || 'assigned', revision: 1, createdByUid: 'u', createdAt: 0, updatedAt: 0 } };
};
const grid = (y, m, shifts, now) => monthGridFor({ year: y, month: m, shifts: shifts || [], now: now != null ? now : null, timezone: TZ });
const cellOf = (g, wd) => g.cells.find((c) => c.workDate === wd);

// ---- shape: always 42 consecutive Monday-first cells ----
t('MT1', 'always exactly 42 consecutive cells for any month', () => {
  for (const [y, m] of [[2026, 8], [2025, 9], [2026, 2], [2028, 2], [2027, 1], [2026, 12]]) {
    const g = grid(y, m);
    assert.equal(g.cells.length, 42, y + '-' + m);
    for (let i = 0; i < 42; i++) assert.equal(g.cells[i].workDate, addDays(g.firstCell, i));
    assert.equal(g.lastCell, addDays(g.firstCell, 41));
  }
});
t('MT2', 'month beginning on a Monday: first cell IS the 1st (September 2025)', () => {
  const g = grid(2025, 9);
  assert.equal(g.firstCell, '2025-09-01'); assert.equal(g.cells[0].inMonth, true); assert.equal(g.lastCell, '2025-10-12');
});
t('MT3', 'month beginning on a Sunday: six leading outside-month cells (February 2026)', () => {
  const g = grid(2026, 2);
  assert.equal(g.firstCell, '2026-01-26');
  for (let i = 0; i < 6; i++) assert.equal(g.cells[i].inMonth, false, String(i));
  assert.equal(g.cells[6].workDate, '2026-02-01'); assert.equal(g.cells[6].inMonth, true);
});
t('MT4', 'February leap vs non-leap: 29 in-month days in 2028, 28 in 2026', () => {
  const leap = grid(2028, 2), non = grid(2026, 2);
  assert.equal(leap.cells.filter((c) => c.inMonth).length, 29); assert.ok(cellOf(leap, '2028-02-29').inMonth);
  assert.equal(non.cells.filter((c) => c.inMonth).length, 28); assert.equal(cellOf(non, '2026-03-01').inMonth, false);
});
t('MT5', 'first cell is the Monday on/before the 1st; in-month count equals month length (August 2026)', () => {
  const g = grid(2026, 8);
  assert.equal(g.firstCell, '2026-07-27'); assert.equal(g.lastCell, '2026-09-06');
  assert.equal(g.cells.filter((c) => c.inMonth).length, 31);
});

// ---- placement / statuses ----
t('MT6', 'shift placed by workDate, never by start instant; overnight stays on its start day, flagged', () => {
  const s = sh('n', '2026-08-28', '22:00', '02:00');
  const g = grid(2026, 8, [s]);
  assert.equal(cellOf(g, '2026-08-28').shifts.length, 1);
  assert.equal(cellOf(g, '2026-08-29').shifts.length, 0);
  assert.equal(cellOf(g, '2026-08-28').shifts[0].overnight, true);
});
t('MT7', 'cancelled shift is present on its day and keeps status cancelled', () => {
  const g = grid(2026, 8, [sh('c', '2026-08-14', '09:00', '13:00', 'cancelled')]);
  assert.equal(cellOf(g, '2026-08-14').shifts[0].projection.status, 'cancelled');
});
t('MT8', 'two shifts on one date: both present, sorted by plannedStartAt regardless of input order', () => {
  const g = grid(2026, 8, [sh('late', '2026-08-12', '16:00', '20:00'), sh('early', '2026-08-12', '08:00', '12:00')]);
  assert.deepEqual(cellOf(g, '2026-08-12').shifts.map((s) => s.shiftId), ['early', 'late']);
});

// ---- today / outside-month ----
t('MT9', 'today flagged exactly once and ONLY inside the displayed month (tenant-local)', () => {
  const now = tenantLocalHMToUtcMs('2026-08-26', '12:00', TZ);
  const aug = grid(2026, 8, [], now);
  assert.deepEqual(aug.cells.filter((c) => c.isToday).map((c) => c.workDate), ['2026-08-26']);
  const jul = grid(2026, 7, [], now);
  assert.equal(jul.cells.filter((c) => c.isToday).length, 0);
  // today lands in the grid as an OUTSIDE-month cell -> still not flagged
  const nowAug31 = tenantLocalHMToUtcMs('2026-08-31', '12:00', TZ);
  const sep = grid(2026, 9, [], nowAug31);
  assert.equal(sep.firstCell, '2026-08-31');
  assert.equal(sep.cells[0].inMonth, false); assert.equal(sep.cells[0].isToday, false);
  assert.equal(sep.cells.filter((c) => c.isToday).length, 0);
});
t('MT10', 'outside-month cells are flagged inMonth=false at both edges (August 2026)', () => {
  const g = grid(2026, 8);
  for (const wd of ['2026-07-27', '2026-07-31', '2026-09-01', '2026-09-06']) assert.equal(cellOf(g, wd).inMonth, false, wd);
  for (const wd of ['2026-08-01', '2026-08-31']) assert.equal(cellOf(g, wd).inMonth, true, wd);
});

// ---- navigation across the year boundary ----
t('MT11', 'prev/next month navigation crosses December -> January correctly both ways', () => {
  assert.deepEqual(nextMonth(2026, 12), { year: 2027, month: 1 });
  assert.deepEqual(prevMonth(2027, 1), { year: 2026, month: 12 });
  assert.deepEqual(nextMonth(2026, 8), { year: 2026, month: 9 });
  assert.deepEqual(prevMonth(2026, 1), { year: 2025, month: 12 });
  const jan = grid(2027, 1);
  assert.equal(jan.firstCell, '2026-12-28'); assert.ok(cellOf(jan, '2027-01-01').inMonth);
  const dec = grid(2026, 12);
  assert.ok(cellOf(dec, '2026-12-31').inMonth);
});
t('MT12', 'monthOfWorkDate parses year/month from a workDate', () => {
  assert.deepEqual(monthOfWorkDate('2026-08-30'), { year: 2026, month: 8 });
  assert.deepEqual(monthOfWorkDate('2027-01-02'), { year: 2027, month: 1 });
});

// ---- fixture coverage for the review month (design §6; Maria, anchor-relative) ----
t('MT13', 'fixture: review month has cancelled, overnight, a two-shift date and days off; prev/next months are not empty', () => {
  const ANCHOR = '2026-08-26';
  const maria = ownShiftsForMembership(buildFourSeasonSchedule(ANCHOR, TZ), FOUR_SEASON_MEMBERSHIPS.find((m) => m.ansattId === 'ans-maria'));
  const now = tenantLocalHMToUtcMs(ANCHOR, '12:00', TZ);
  const cur = monthGridFor({ year: 2026, month: 8, shifts: maria, now, timezone: TZ });
  const inMonth = cur.cells.filter((c) => c.inMonth);
  assert.ok(inMonth.some((c) => c.shifts.some((s) => s.projection.status === 'cancelled')), 'cancelled in month');
  assert.ok(inMonth.some((c) => c.shifts.some((s) => s.overnight)), 'overnight in month');
  assert.ok(inMonth.some((c) => c.shifts.filter((s) => s.projection.status === 'assigned').length >= 2), 'two-shift date in month');
  assert.ok(inMonth.some((c) => c.shifts.length === 0), 'days off in month');
  assert.equal(cur.cells.filter((c) => c.isToday).length, 1);
  const prev = monthGridFor({ year: 2026, month: 7, shifts: maria, now, timezone: TZ });
  const next = monthGridFor({ year: 2026, month: 9, shifts: maria, now, timezone: TZ });
  assert.ok(prev.cells.filter((c) => c.inMonth).some((c) => c.shifts.length > 0), 'previous month not empty');
  assert.ok(next.cells.filter((c) => c.inMonth).some((c) => c.shifts.length > 0), 'next month not empty');
});

console.log(lines.join('\n'));
console.log('SCHEDULE_MONTH_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
