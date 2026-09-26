// employee-schedule-week.mjs
// EMPLOYEE WEEK SCHEDULE — PURE week derivation. No DOM, no clock read, no storage.
// Governing: SOREN-SIRRHA-EMPLOYEE-SCHEDULE-FIRST-REAL-PRODUCT-REVIEW-SEQUENCING-001 (+ Sirrha
// acceptance + SPF1-SPF7 preflight acceptance). anchor workDate / now / timezone are INJECTED.
// A shift is placed by its workDate (the placement key), never by where its start instant lands
// on the host machine. Reads the frozen ETR-2c projection fields only; calls no validator.

import { tenantWorkDate } from './employee-shell-core.mjs';
import { canReadShift } from './schedule-core.mjs';

function pad2(n) { return String(n).padStart(2, '0'); }
function parts(workDate) { const [y, m, d] = String(workDate).split('-').map(Number); return { y, m, d }; }
function fmtUtcDate(t) { const dt = new Date(t); return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate()); }

// Calendar-day arithmetic on 'YYYY-MM-DD' (pure UTC date math; DST-safe because it never touches instants).
export function addDays(workDate, n) { const { y, m, d } = parts(workDate); return fmtUtcDate(Date.UTC(y, m - 1, d + n)); }
// Monday of the ISO week containing workDate.
export function isoWeekMonday(workDate) {
  const { y, m, d } = parts(workDate);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 = Sunday
  return addDays(workDate, -((dow + 6) % 7));
}
// ISO-8601 week number of workDate (pure).
export function isoWeekNumber(workDate) {
  const { y, m, d } = parts(workDate);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7;                              // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dow);                      // Thursday of this week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
}
// Overnight (D1.4): plannedEndAt falls on a later tenant-local day than the workDate.
export function isOvernight(projection, timezone) {
  return tenantWorkDate(projection.plannedEndAt, timezone) !== projection.workDate;
}

// Flatten a tenant-keyed fixture container to the employee's OWN shifts, tenant FIRST then ansattId.
// container = { [tenantId]: { [shiftId]: projection } }. The tenant is fixed by membership.tenantId
// before any ansattId comparison; ownership goes through the frozen read predicate (canReadShift:
// CROSS_TENANT before NOT_OWN_SHIFT) and is additionally pinned to projection.ansattId === own
// ansattId so an admin membership still only sees its own shifts here (A5/A6). Open shifts
// (ansattId null) can never match. Returns [{ shiftId, projection }] sorted by plannedStartAt.
export function ownShiftsForMembership(container, membership) {
  if (!container || typeof container !== 'object' || !membership || typeof membership !== 'object') return [];
  const tenantId = membership.tenantId;
  if (typeof tenantId !== 'string' || !tenantId) return [];
  const tenant = Object.prototype.hasOwnProperty.call(container, tenantId) ? container[tenantId] : null;
  if (!tenant || typeof tenant !== 'object') return [];
  const actor = { uid: membership.uid, accessRole: membership.accessRole, ansattId: membership.ansattId, accessEnabled: membership.accessEnabled === true, tenantId };
  const out = [];
  for (const shiftId of Object.keys(tenant)) {
    const projection = tenant[shiftId];
    if (!projection || typeof projection !== 'object') continue;
    const r = canReadShift({ actor, scope: { tenantId, shiftId }, projection });
    if (!r.ok) continue;
    if (typeof membership.ansattId !== 'string' || !membership.ansattId || projection.ansattId !== membership.ansattId) continue;
    out.push({ shiftId, projection });
  }
  return out.sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt);
}

// Monday-first seven-day tenant-local week containing anchorWorkDate. Each day carries its shifts
// (placed by projection.workDate, sorted by plannedStartAt) or an empty list; isToday is derived
// from the injected todayWorkDate (may be null when no "today" applies).
export function weekFor(anchorWorkDate, timezone, shifts, todayWorkDate) {
  const monday = isoWeekMonday(anchorWorkDate);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const workDate = addDays(monday, i);
    const dayShifts = (Array.isArray(shifts) ? shifts : [])
      .filter((s) => s && s.projection && s.projection.workDate === workDate)
      .sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt)
      .map((s) => ({ shiftId: s.shiftId, projection: s.projection, overnight: isOvernight(s.projection, timezone) }));
    days.push({ workDate, isToday: todayWorkDate != null && workDate === todayWorkDate, shifts: dayShifts });
  }
  return { monday, sunday: addDays(monday, 6), weekNumber: isoWeekNumber(monday), days };
}

// The employee's assigned shift on a given workDate (first by start), or null.
export function todayShiftOf(shifts, workDate) {
  const list = (Array.isArray(shifts) ? shifts : [])
    .filter((s) => s && s.projection && s.projection.status === 'assigned' && s.projection.workDate === workDate)
    .sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt);
  return list.length ? list[0] : null;
}
// All of the employee's ASSIGNED shifts on a workDate, sorted by start (cancelled/open excluded).
export function todayShiftsOf(shifts, workDate) {
  return (Array.isArray(shifts) ? shifts : [])
    .filter((s) => s && s.projection && s.projection.status === 'assigned' && s.projection.workDate === workDate)
    .sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt);
}
// HERO SELECTION (B1/B2/B3) — pure; attendance is READ through the injected lookup(shiftId) -> attendance|null.
// Order: 1 active attendance (clocked_in; working or on_break) wins, incl. an overnight shift from the prior
// workDate; 2 today's assigned shift whose planned window contains now; 3 earliest today with start > now;
// 4 most recently completed today (planned end passed or attendance clocked_out), shown as completed;
// 5 free day (a cancelled-only day is free). Cancelled/open never become the hero.
// missingRegistration (owner ruling 2026-09-12): TRUE only for step 4 when the ended planned shift has
// NO attendance record at all — the day must render as an attention state ("Vakten er over · Ingen
// arbeidstid er registrert"), never as completed. Additive flag; the selection order is unchanged.
export function heroShiftFor(shifts, { nowMs, todayWorkDate, lookup }) {
  const look = typeof lookup === 'function' ? lookup : () => null;
  const list = (Array.isArray(shifts) ? shifts : []).filter((s) => s && s.projection && s.projection.status === 'assigned');
  const today = todayShiftsOf(list, todayWorkDate);
  const others = (e) => today.filter((t) => t.shiftId !== e.shiftId).length;
  const out = (kind, entry, attendance) => ({ kind, entry, attendance: attendance || null, ongoingFromPriorDay: !!entry && entry.projection.workDate !== todayWorkDate, othersToday: entry ? others(entry) : today.length, missingRegistration: kind === 'completed' && !attendance });
  let active = null;
  for (const s of list) {
    const att = look(s.shiftId);
    if (att && att.status === 'clocked_in' && (!active || s.projection.plannedStartAt > active.entry.projection.plannedStartAt)) active = { entry: s, att };
  }
  if (active) return out('active', active.entry, active.att);
  const cur = today.find((t) => t.projection.plannedStartAt <= nowMs && nowMs < t.projection.plannedEndAt);
  if (cur) return out('current', cur, look(cur.shiftId));
  const up = today.find((t) => t.projection.plannedStartAt > nowMs);
  if (up) return out('upcoming', up, look(up.shiftId));
  const done = today
    .filter((t) => { const a = look(t.shiftId); return t.projection.plannedEndAt <= nowMs || (a && a.status === 'clocked_out'); })
    .sort((a, b) => b.projection.plannedEndAt - a.projection.plannedEndAt)[0];
  if (done) return out('completed', done, look(done.shiftId));
  return out('free', null, null);
}
// Next upcoming ASSIGNED shift strictly after nowMs (by plannedStartAt), or null. Cancelled/open never qualify.
export function nextUpcomingShift(shifts, nowMs) {
  const list = (Array.isArray(shifts) ? shifts : [])
    .filter((s) => s && s.projection && s.projection.status === 'assigned' && s.projection.plannedStartAt > nowMs)
    .sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt);
  return list.length ? list[0] : null;
}
