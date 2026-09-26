// management-planning-economy.mjs
// P2 — PLANNING-ECONOMY PROJECTION (Soren design 001 §6–§7). PURE, view-facing, NEVER frozen,
// NEVER delivered, NEVER approved, NEVER stored in any package artifact.
//
// INPUTS (read-only, canonical):
//   - schedule projections (layer A): tenantShiftsOf / durationHoursOf / scopeDaysOf from the
//     schedule core — the SAME per-shift hours rule plannedHoursForEmployee uses (no second
//     planned-hours arithmetic); the month total IS plannedHoursForEmployee.
//   - employment compensation terms (time-bounded): currentTermsOf(employee, workDate) — the rate
//     IN EFFECT ON EACH SHIFT'S workDate, never "current rate × month total".
// OUTPUTS: planned hours + labelled ESTIMATES with named coverage and named exclusions.
//
// LAYER DISCIPLINE: this module imports NOTHING from employee-shell-core (attendance, layer B)
// and NOTHING from management-payroll-core (package/payload/snapshot/approval). It has no
// business there. There is no "actual cost" anywhere in the product; the only allowed arithmetic
// is planned hours × applicable hourly rate by workDate (S-P2a).

import { tenantShiftsOf, durationHoursOf, scopeDaysOf } from './management-schedule-core.mjs';
import { employeesOf, currentTermsOf, plannedHoursForEmployee } from './management-employees-core.mjs';

export const FIXED_SALARY_NOTE = 'fastlønn — inngår ikke i timebasert estimat';
export const MISSING_BASIS_NOTE = 'kan ikke beregnes — mangler lønnsbasis';
export const ESTIMATE_LABEL = '(estimat)';

const r2 = (v) => Math.round(v * 100) / 100;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function coverageLineOf(covered, total) {
  return 'estimatet dekker ' + covered + ' av ' + total + ' ansatte (timelønn)';
}

// Hourly rate in effect on a workDate for one employee, from the time-bounded terms — or null
// when the employee is not hourly on that date or has no compensation basis there. Never guessed.
export function hourlyRateOn(employee, workDate) {
  const t = currentTermsOf(employee, workDate);
  const c = t && t.compensation;
  if (!c || c.model !== 'timelonn' || !Number.isFinite(c.hourlyRate) || c.hourlyRate <= 0) return null;
  return c.hourlyRate;
}

// Basis of an employee for the period (for naming exclusions): 'timelonn' | 'fastlonn' | 'mangler',
// read from the terms in effect on the period's last day (else first day, else latest).
function basisFor(employee, firstDay, lastDay) {
  const t = currentTermsOf(employee, lastDay) || currentTermsOf(employee, firstDay) || (employee.terms && employee.terms[employee.terms.length - 1]) || null;
  const c = t && t.compensation;
  if (!c) return 'mangler';
  if (c.model === 'timelonn') return 'timelonn';
  if (c.model === 'fastlonn') return 'fastlonn';
  return 'mangler';
}

// THE projection. Deterministic for given stores + periodId.
export function planningEconomyFor({ employeeStore, scheduleStore, tenantId, periodId }) {
  if (!PERIOD_RE.test(periodId || '')) return null;
  const scope = { kind: 'month', year: Number(periodId.slice(0, 4)), month: Number(periodId.slice(5, 7)) };
  const days = scopeDaysOf(scope);
  const firstDay = days[0], lastDay = days[days.length - 1];
  const inScope = new Set(days);
  const allShifts = tenantShiftsOf(scheduleStore, tenantId);
  const employees = [];
  let plannedHoursTotal = 0, estimateKr = 0, covered = 0, hourlyCount = 0;
  const exclusions = [];
  for (const e of employeesOf(employeeStore, tenantId)) {
    // Same inclusion as the payroll package: employed at ANY point in the period.
    const started = e.terms && e.terms[0] ? e.terms[0].validFrom : null;
    const ended = e.status === 'active' ? null : (e.endedAt || null);
    if (started && started > lastDay) continue;
    if (ended && ended < firstDay) continue;
    const plannedHours = plannedHoursForEmployee(scheduleStore, tenantId, e.ansattId, scope);
    plannedHoursTotal = r2(plannedHoursTotal + plannedHours);
    const basis = basisFor(e, firstDay, lastDay);
    const shifts = [];
    let kr = 0, missingRateOnShift = false;
    for (const s of allShifts) {
      const p = s.projection;
      if (p.ansattId !== e.ansattId || p.status !== 'assigned' || !inScope.has(p.workDate)) continue;
      const hours = r2(durationHoursOf(p));
      const rate = basis === 'timelonn' ? hourlyRateOn(e, p.workDate) : null;
      const shiftKr = rate == null ? null : r2(hours * rate);
      if (basis === 'timelonn' && rate == null) missingRateOnShift = true;
      if (shiftKr != null) kr = r2(kr + shiftKr);
      shifts.push({ shiftId: s.shiftId, workDate: p.workDate, hours, rate, kr: shiftKr });
    }
    shifts.sort((a, b) => (a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0));
    let estimate = null, note = null, included = false;
    if (basis === 'timelonn' && !missingRateOnShift) { estimate = kr; included = true; covered += 1; hourlyCount += 1; estimateKr = r2(estimateKr + kr); }
    else if (basis === 'fastlonn') { note = FIXED_SALARY_NOTE; exclusions.push({ ansattId: e.ansattId, name: e.name, reason: 'fastlonn', label: note }); }
    else { note = MISSING_BASIS_NOTE; exclusions.push({ ansattId: e.ansattId, name: e.name, reason: 'mangler_lonnsbasis', label: note }); if (basis === 'timelonn') hourlyCount += 1; }
    employees.push({ ansattId: e.ansattId, name: e.name, basis, plannedHours, estimateKr: estimate, included, note, shifts });
  }
  return {
    periodId,
    plannedHoursTotal,
    estimate: {
      kr: estimateKr,
      label: ESTIMATE_LABEL,
      coveredCount: covered,
      totalCount: employees.length,
      coverageLine: coverageLineOf(covered, employees.length),
      exclusions,
    },
    employees,
  };
}
