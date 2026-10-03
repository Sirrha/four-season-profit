// management-schedule-core.mjs
// MANAGEMENT VAKTPLAN CORE — PURE. No DOM, no clock read, no storage, no network.
// Governing: SOREN-SIRRHA-MANAGEMENT-SCHEDULING-FIRST-REAL-PRODUCT-MILESTONE-DESIGN-001
// (§6 ONE STORE / TWO PROJECTIONS) on top of the frozen ETR-2c planned-schedule engine
// (schedule-core.mjs). This module is the SINGLE operation boundary for manager
// create/edit/cancel: every mutation of the shared local planned-schedule store flows through
// applyScheduleOperation, which delegates every invariant to the frozen validators (create at
// revision 1; revise/cancel advance revision; cancelled is terminal; attendance existence
// blocks cancel; tenant/actor/scope fail-closed) and only on ok writes the returned projection
// back to the store. PLANNED LAYER ONLY: never reads or writes attendance/vakter — the boolean
// attendance-existence fact the frozen cancel invariant requires is INJECTED via deps.

import { validateCreateShift, validateReviseShift, validateCancelShift, canReadShift } from './schedule-core.mjs';
import { weekFor, isoWeekMonday, isoWeekNumber, addDays, isOvernight } from './employee-schedule-week.mjs';
import { tenantLocalHMToUtcMs } from './employee-shell-core.mjs';

// All [{ shiftId, projection }] of ONE tenant (fail-closed empty on bad container/tenant).
export function tenantShiftsOf(container, tenantId) {
  if (!container || typeof container !== 'object' || typeof tenantId !== 'string' || !tenantId) return [];
  const tenant = Object.prototype.hasOwnProperty.call(container, tenantId) ? container[tenantId] : null;
  if (!tenant || typeof tenant !== 'object') return [];
  const out = [];
  for (const shiftId of Object.keys(tenant)) {
    const projection = tenant[shiftId];
    if (!projection || typeof projection !== 'object') continue;
    out.push({ shiftId, projection });
  }
  return out;
}

// Manager week grid: Monday-first week containing anchorWorkDate, ALL given employees as rows.
// Tenant is fixed FIRST (tenantShiftsOf); each row then projects only that employee's shifts,
// so an open/unassigned shift (ansattId null) can never appear in an employee row. Placement
// reuses the frozen weekFor semantics: workDate is the key, overnight flagged, per-day order by
// plannedStartAt. Returns { monday, sunday, weekNumber, days:[7 workDates], rows:[{ ansattId,
// days: weekFor-days }] } with rows in the given people order.
export function managerWeekFor({ anchorWorkDate, timezone, container, tenantId, people, todayWorkDate }) {
  const monday = isoWeekMonday(anchorWorkDate);
  const all = tenantShiftsOf(container, tenantId);
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(monday, i));
  const rows = (Array.isArray(people) ? people : []).map((person) => {
    const own = all.filter((s) => s.projection.ansattId === person.ansattId);
    return { ansattId: person.ansattId, days: weekFor(monday, timezone, own, todayWorkDate).days };
  });
  return { monday, sunday: addDays(monday, 6), weekNumber: isoWeekNumber(monday), days, rows };
}

// Planned instants for a manager-entered local HH:MM range on workDate. A toHM earlier than
// fromHM means the shift ends on the NEXT local day (overnight) — the same convention as the
// seeded fixture. Equal times yield end === start, which the frozen validator rejects.
export function plannedInstantsFor(workDate, fromHM, toHM, timezone) {
  const plannedStartAt = tenantLocalHMToUtcMs(workDate, fromHM, timezone);
  const endDate = toHM < fromHM ? addDays(workDate, 1) : workDate;
  return { plannedStartAt, plannedEndAt: tenantLocalHMToUtcMs(endDate, toHM, timezone) };
}

// Structural HH:MM guard (24h). The boundary must FAIL CLOSED on malformed manager input —
// the date layer would otherwise throw on garbage instead of returning an error result.
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function hmError(fromHM, toHM) {
  if (!HM_RE.test(fromHM || '') || !HM_RE.test(toHM || '')) return 'TIME_INVALID';
  return null;
}

// Collision-safe deterministic id for a manager-created shift: the first unused of
// mg-<workDate>-<ansattId>, then -2, -3, ... Existing seeded ids are never reused or overwritten.
export function newShiftIdFor(tenantShifts, workDate, ansattId) {
  const base = 'mg-' + workDate + '-' + ansattId;
  let id = base, n = 1;
  while (Object.prototype.hasOwnProperty.call(tenantShifts, id)) { n += 1; id = base + '-' + n; }
  return id;
}

// THE single operation boundary. op is one of:
//   { kind:'create', workDate, ansattId, fromHM, toHM, roleKey }
//   { kind:'revise', shiftId, fromHM, toHM }
//   { kind:'cancel', shiftId }
// deps (injected; keeps this module pure and the attendance layer untouched):
//   resolveAssignee(ansattId) -> { status:'FOUND', tenantId, ansattId } | { status:'NOT_FOUND' }
//   attendanceExistsFor(shiftId, ansattId) -> boolean (existence fact only, never the record)
// Returns { ok:true, shiftId, projection, event } after writing the validated projection to the
// store, or { ok:false, code } with the store untouched.
export function applyScheduleOperation({ store, tenantId, actor, op, now, policy, deps }) {
  if (!store || typeof store !== 'object') return { ok: false, code: 'NO_STORE' };
  if (typeof tenantId !== 'string' || !tenantId || !Object.prototype.hasOwnProperty.call(store, tenantId)) return { ok: false, code: 'TENANT_UNKNOWN' };
  const tenant = store[tenantId];
  if (!tenant || typeof tenant !== 'object') return { ok: false, code: 'TENANT_UNKNOWN' };
  if (!op || typeof op !== 'object') return { ok: false, code: 'NO_OPERATION' };
  const d = deps || {};

  if (op.kind === 'create') {
    const he = hmError(op.fromHM, op.toHM);
    if (he) return { ok: false, code: he };
    const { plannedStartAt, plannedEndAt } = plannedInstantsFor(op.workDate, op.fromHM, op.toHM, policy.timezone);
    // ansattId null/undefined creates an OPEN "Manko" shift (existing open semantics — no new
    // status field); a non-null ansattId creates an assigned shift as before.
    const assigned = op.ansattId != null;
    const shiftId = newShiftIdFor(tenant, op.workDate, assigned ? op.ansattId : 'manko');
    const res = validateCreateShift({
      actor, scope: { tenantId, shiftId },
      proposed: {
        ansattId: assigned ? op.ansattId : null, plannedStartAt, plannedEndAt, workDate: op.workDate,
        roleKey: ('roleKey' in op) ? op.roleKey : null, status: assigned ? 'assigned' : 'open',
      },
      now, policy,
      context: {
        shiftExistsAtScope: Object.prototype.hasOwnProperty.call(tenant, shiftId),
        proposedAssigneeResolution: assigned && typeof d.resolveAssignee === 'function' ? d.resolveAssignee(op.ansattId) : undefined,
      },
    });
    if (!res.ok) return { ok: false, code: res.code };
    tenant[shiftId] = res.projection;
    return { ok: true, shiftId, projection: res.projection, event: res.event };
  }

  if (op.kind === 'claim') {
    // LOCAL claim of an open shift by an eligible employee. PRODUCTION INVARIANT (documented,
    // not implemented here): the production claim MUST be an atomic/conditional write on
    // ansattId still being null so two claimants can never both win; this local single-threaded
    // path has the exact same fail-closed losing semantics. The frozen engine has no
    // employee-claim authorization rule yet, so this boundary carries its own fail-closed
    // checks and advances revision exactly like the frozen assignment transition.
    const shiftId = op.shiftId;
    if (typeof shiftId !== 'string' || !shiftId) return { ok: false, code: 'NO_SHIFT' };
    const existing = Object.prototype.hasOwnProperty.call(tenant, shiftId) ? tenant[shiftId] : null;
    if (!existing || typeof existing !== 'object') return { ok: false, code: 'NO_SHIFT' };
    if (existing.status === 'cancelled') return { ok: false, code: 'SHIFT_CANCELLED' };
    if (existing.status === 'assigned' || existing.ansattId !== null) return { ok: false, code: 'SHIFT_TAKEN' };
    if (existing.status !== 'open') return { ok: false, code: 'SHIFT_NOT_OPEN' };
    const ansattId = op.ansattId;
    const resolution = typeof d.resolveAssignee === 'function' ? d.resolveAssignee(ansattId) : null;
    if (!resolution || resolution.status !== 'FOUND' || resolution.tenantId !== tenantId || resolution.ansattId !== ansattId) {
      return { ok: false, code: 'CLAIMANT_UNKNOWN' };
    }
    const projection = Object.assign({}, existing, { status: 'assigned', ansattId, revision: existing.revision + 1, updatedAt: now });
    tenant[shiftId] = projection;
    return { ok: true, shiftId, projection };
  }

  if (op.kind === 'revise' || op.kind === 'cancel') {
    const shiftId = op.shiftId;
    if (typeof shiftId !== 'string' || !shiftId) return { ok: false, code: 'NO_SHIFT' };
    const existing = Object.prototype.hasOwnProperty.call(tenant, shiftId) ? tenant[shiftId] : null;
    if (!existing || typeof existing !== 'object') return { ok: false, code: 'NO_SHIFT' };
    const context = {};
    if (existing.ansattId !== null) {
      context.attendanceExistsForCurrentAssignee =
        typeof d.attendanceExistsFor === 'function' ? d.attendanceExistsFor(shiftId, existing.ansattId) === true : undefined;
    }
    let res;
    if (op.kind === 'revise') {
      const he = hmError(op.fromHM, op.toHM);
      if (he) return { ok: false, code: he };
      const patch = plannedInstantsFor(existing.workDate, op.fromHM, op.toHM, policy.timezone);
      res = validateReviseShift({ actor, scope: { tenantId, shiftId }, existing, patch, now, policy, context });
    } else {
      res = validateCancelShift({ actor, scope: { tenantId, shiftId }, existing, now, policy, context });
    }
    if (!res.ok) return { ok: false, code: res.code };
    tenant[shiftId] = res.projection;
    return { ok: true, shiftId, projection: res.projection, event: res.event };
  }

  return { ok: false, code: 'UNKNOWN_OPERATION' };
}

// ============================================================================================
// SECOND INCREMENT — pure derivations (month grid, planned hours, planning-cost projection,
// Manko/eligibility, search, capability routing, manager "se som ansatt" projection).
// PLANNED LAYER (A) ONLY. The planning cost is an ESTIMATE from DEMO planning compensation
// input — never payroll/payable truth, never read from vakter or index.html ansatte.
// ============================================================================================

// Capability-shaped routing (local fixture form of a later real auth rule).
export function canOpenVaktplan(actor) {
  return !!(actor && typeof actor === 'object' && actor.accessEnabled === true && actor.canManageSchedule === true);
}

export function durationHoursOf(projection) { return (projection.plannedEndAt - projection.plannedStartAt) / 3600000; }

// Open ("Manko") shifts of one tenant: status open AND ansattId null, never cancelled. No new
// status field exists — this is the existing open semantics read back.
export function openShiftsOf(container, tenantId) {
  return tenantShiftsOf(container, tenantId)
    .filter((s) => s.projection.status === 'open' && s.projection.ansattId === null)
    .sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt);
}

// V1 eligibility is a FUNCTION, not a stored field: any valid same-tenant employee may take any
// open, non-cancelled shift. No roleKey/requiredRole matching is stored or evaluated yet.
export function isEligible(person, projection, tenantId) {
  if (!person || typeof person !== 'object' || typeof person.ansattId !== 'string' || !person.ansattId) return false;
  if (typeof tenantId !== 'string' || !tenantId) return false;
  if (!projection || typeof projection !== 'object') return false;
  if (projection.status !== 'open' || projection.ansattId !== null) return false;
  return true;
}

// ONE compensation derivation, three DERIVED branches. UNKNOWN is derived from a missing or
// invalid planning input — never stored, and never silently substituted with zero.
export function compensationOf(person) {
  const c = person && person.compensation;
  if (c && c.model === 'timelonn' && Number.isFinite(c.plannedHourlyRate) && c.plannedHourlyRate > 0) {
    return { model: 'timelonn', plannedHourlyRate: c.plannedHourlyRate };
  }
  if (c && c.model === 'fastlonn' && Number.isFinite(c.plannedMonthlySalary) && c.plannedMonthlySalary > 0) {
    return { model: 'fastlonn', plannedMonthlySalary: c.plannedMonthlySalary };
  }
  return { model: 'unknown' };
}

// Every calendar day of (year, month 1-12) as 'YYYY-MM-DD'.
export function monthDaysOf(year, month) {
  const key = year + '-' + String(month).padStart(2, '0');
  const days = [];
  let d = key + '-01';
  while (d.slice(0, 7) === key) { days.push(d); d = addDays(d, 1); }
  return days;
}

// Manager MONTH matrix: employee rows x EVERY calendar day of the month. Placement is by
// workDate (overnight stays on its start day, flagged); per-day order by plannedStartAt.
export function managerMonthFor({ year, month, timezone, container, tenantId, people, todayWorkDate }) {
  const days = monthDaysOf(year, month);
  const all = tenantShiftsOf(container, tenantId);
  const rows = (Array.isArray(people) ? people : []).map((person) => {
    const byDate = new Map();
    for (const s of all) {
      if (s.projection.ansattId !== person.ansattId) continue;
      const wd = s.projection.workDate;
      if (!byDate.has(wd)) byDate.set(wd, []);
      byDate.get(wd).push(s);
    }
    const cells = days.map((wd) => ({
      workDate: wd,
      isToday: todayWorkDate != null && wd === todayWorkDate,
      shifts: (byDate.get(wd) || []).slice()
        .sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt)
        .map((s) => ({ shiftId: s.shiftId, projection: s.projection, overnight: isOvernight(s.projection, timezone) })),
    }));
    return { ansattId: person.ansattId, cells };
  });
  return { year, month, days, rows };
}

// Days of a summary scope: { kind:'week', anchorWorkDate } (ISO week) or { kind:'month', year, month }.
export function scopeDaysOf(scope) {
  if (scope && scope.kind === 'week') {
    const mon = isoWeekMonday(scope.anchorWorkDate);
    const out = [];
    for (let i = 0; i < 7; i++) out.push(addDays(mon, i));
    return out;
  }
  return monthDaysOf(scope.year, scope.month);
}

const r2 = (v) => Math.round(v * 100) / 100;

// THE single planning-hours/cost derivation. Simple AND detailed UI must render from this ONE
// result object — there is no second calculation path. Gross hours = assigned, non-cancelled
// planned spans only (breaks are NOT deducted: no per-shift break truth exists). Open Manko
// shifts carry gap hours and an UNKNOWN cost (never zero) until claimed/assigned. Week scope
// NEVER allocates fixed salary numerically (no /4, /4.33, no hours-share); month scope shows
// the full planned monthly salary because the calendar month is fastlønn's natural period.
// Overtime, supplements and employer on-costs are NOT calculated in this version — the result
// says so explicitly so an hourly-only week number is never mistaken for total labour cost.
export function planningSummaryFor({ container, tenantId, people, scope }) {
  const inScope = new Set(scopeDaysOf(scope));
  const all = tenantShiftsOf(container, tenantId).filter((s) => inScope.has(s.projection.workDate));
  const isMonth = scope.kind === 'month';
  const rows = [];
  let variableCostKnown = 0, grossHoursTotal = 0, fixedMonthlySalaryKnown = 0, unknownCount = 0, fastlonnCount = 0;
  for (const person of (Array.isArray(people) ? people : [])) {
    const comp = compensationOf(person);
    const own = all.filter((s) => s.projection.ansattId === person.ansattId && s.projection.status === 'assigned');
    let grossHours = 0;
    for (const s of own) grossHours += durationHoursOf(s.projection);
    grossHours = r2(grossHours);
    grossHoursTotal += grossHours;
    const row = {
      ansattId: person.ansattId, name: person.name, model: comp.model,
      grossHours, shiftCount: own.length,
      plannedHourlyRate: comp.model === 'timelonn' ? comp.plannedHourlyRate : null,
      plannedMonthlySalary: comp.model === 'fastlonn' ? comp.plannedMonthlySalary : null,
      estimatedVariableCost: null, fixedMonthlySalaryForScope: null, notes: [],
    };
    if (comp.model === 'timelonn') {
      row.estimatedVariableCost = r2(grossHours * comp.plannedHourlyRate);
      variableCostKnown += row.estimatedVariableCost;
    } else if (comp.model === 'fastlonn') {
      fastlonnCount += 1;
      if (isMonth) {
        row.fixedMonthlySalaryForScope = comp.plannedMonthlySalary;
        fixedMonthlySalaryKnown += comp.plannedMonthlySalary;
        row.notes.push('Fast månedslønn – grunnbeløpet påvirkes ikke av antall ordinære vakter.');
      } else {
        row.notes.push('Fastlønn – påvirkes ikke av vaktplanen.');
        row.notes.push('Ukesfordeling av fastlønn: ikke beregnet i denne versjonen.');
      }
    } else {
      unknownCount += 1;
      row.notes.push('Lønnsgrunnlag mangler – kostnad ikke beregnet (aldri satt til 0).');
    }
    row.notes.push('Overtid, tillegg og arbeidsgiverkostnader: ikke beregnet i denne versjonen.');
    rows.push(row);
  }
  const open = openShiftsOf(container, tenantId).filter((s) => inScope.has(s.projection.workDate));
  let gapHours = 0;
  for (const s of open) gapHours += durationHoursOf(s.projection);
  const omissions = [];
  if (!isMonth && fastlonnCount > 0) omissions.push(fastlonnCount + ' ansatt(e) med fastlønn – ikke fordelt per uke');
  if (unknownCount > 0) omissions.push(unknownCount + ' ansatt(e) mangler lønnsgrunnlag');
  if (open.length > 0) omissions.push(open.length + ' åpen/åpne vakt(er) – kostnad ukjent til de er tildelt');
  omissions.push('Overtid, tillegg og arbeidsgiverkostnader er ikke beregnet i denne versjonen.');
  return {
    scope, rows,
    totals: {
      grossHours: r2(grossHoursTotal),
      variableCostKnown: r2(variableCostKnown),
      fixedMonthlySalaryKnown: isMonth ? r2(fixedMonthlySalaryKnown) : null,   // week: deliberately never allocated
      combinedKnownCost: isMonth ? r2(variableCostKnown + fixedMonthlySalaryKnown) : null,
      unknownCompensationCount: unknownCount,
      fastlonnCount,
      openShiftCount: open.length,
      openGapHours: r2(gapHours),
    },
    omissions,
  };
}

// Name search (people selection shared by Week and Month). Empty/blank query returns everyone.
export function searchPeople(people, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  const list = Array.isArray(people) ? people : [];
  if (!q) return list.slice();
  return list.filter((p) => p && typeof p.name === 'string' && p.name.toLowerCase().includes(q));
}

// Authorized-manager-shaped read of ONE employee's shifts ("Se som ansatt"): the MANAGER
// remains the actor (capability-gated, admin branch of the frozen read predicate);
// viewingAsAnsattId is only a projection target — never credential/identity switching.
export function shiftsForEmployee(container, tenantId, ansattId, actor) {
  if (!canOpenVaktplan(actor)) return [];
  if (typeof ansattId !== 'string' || !ansattId) return [];
  const out = [];
  for (const s of tenantShiftsOf(container, tenantId)) {
    const r = canReadShift({ actor, scope: { tenantId, shiftId: s.shiftId }, projection: s.projection });
    if (!r.ok) continue;
    if (s.projection.ansattId !== ansattId) continue;
    out.push(s);
  }
  return out.sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt);
}
