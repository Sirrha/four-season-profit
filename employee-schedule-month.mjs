// employee-schedule-month.mjs
// EMPLOYEE MONTH SCHEDULE — PURE month-grid derivation. No DOM, no clock read, no storage.
// Governing: SOREN-SIRRHA-EMPLOYEE-MONTH-VIEW-DESIGN-RECOMMENDATION-001 §5. The grid is built
// from TENANT-LOCAL calendar dates and a shift is placed by its workDate — NEVER by its start
// instant — so an overnight 22:00–02:00 shift stays on the day it starts. "Today" is tenant-local
// (derived from the INJECTED now + timezone) and is flagged only inside the displayed month.
// Always 42 cells (6 rows × 7 columns), Monday-first; the first cell is the Monday on or before
// the 1st of the displayed month. Reads the frozen ETR-2c projection fields only.

import { tenantWorkDate } from './employee-shell-core.mjs';
import { isoWeekMonday, addDays, isOvernight } from './employee-schedule-week.mjs';

function pad2(n) { return String(n).padStart(2, '0'); }

// { year, month } of a 'YYYY-MM-DD' workDate (month 1–12).
export function monthOfWorkDate(workDate) {
  const [y, m] = String(workDate).split('-').map(Number);
  return { year: y, month: m };
}
// Previous / next calendar month, correct across year boundaries (December → January).
export function prevMonth(year, month) { return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }; }
export function nextMonth(year, month) { return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }; }

// Pure 42-cell Monday-first grid for (year, month 1–12).
// Each cell: { workDate, inMonth, isToday, shifts: [{ shiftId, projection, overnight }] }.
// shifts is the employee's own [{ shiftId, projection }] list (any order); placement key is
// projection.workDate; per-day order is plannedStartAt ascending. isToday requires inMonth.
export function monthGridFor({ year, month, shifts, now, timezone }) {
  const key = year + '-' + pad2(month);
  const start = isoWeekMonday(key + '-01');
  const todayWd = now != null && timezone ? tenantWorkDate(now, timezone) : null;
  const byDate = new Map();
  for (const s of (Array.isArray(shifts) ? shifts : [])) {
    if (!s || !s.projection || typeof s.projection.workDate !== 'string') continue;
    const wd = s.projection.workDate;
    if (!byDate.has(wd)) byDate.set(wd, []);
    byDate.get(wd).push(s);
  }
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const workDate = addDays(start, i);
    const inMonth = workDate.slice(0, 7) === key;
    const dayShifts = (byDate.get(workDate) || [])
      .slice()
      .sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt)
      .map((s) => ({ shiftId: s.shiftId, projection: s.projection, overnight: isOvernight(s.projection, timezone) }));
    cells.push({ workDate, inMonth, isToday: inMonth && todayWd != null && workDate === todayWd, shifts: dayShifts });
  }
  return { year, month, firstCell: cells[0].workDate, lastCell: cells[41].workDate, cells };
}
