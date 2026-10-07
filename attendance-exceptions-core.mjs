// attendance-exceptions-core.mjs
// ATTENDANCE EXCEPTIONS — pure derivation + durable-record law (owner law 2026-10-06, Sirrha release
// ATTENDANCE-EXCEPTION-NOTIFICATION-AND-REPAIR-LOCAL-BUILD-001).
//
// Two exception types, derived ONLY from the canonical shift + attendance records (never a second
// attendance truth):
//   MISSING_CLOCK_IN   an ASSIGNED shift whose planned start + the existing planned-time tolerance
//                      (policy.varianceToleranceMinutes) has passed and that has NO attendance.
//   MISSING_CLOCK_OUT  an attendance still clocked_in whose planned end + the same tolerance has passed.
// The trigger is the planned TIMESTAMP, never the calendar day: an overnight shift is ordinary until
// its planned end has passed. Business law (separate from the technical work-day/grace boundary):
//   employee self-correction window = planned start/end + policy.employeeSelfCorrectionHours (6 h).
// The durable record (tenants/{T}/attendanceExceptions/{exceptionId}) carries the audit facts the owner
// asked to keep apart: detected ≠ shown ≠ acknowledged ≠ corrected ≠ manager reviewed/resolved. Every
// transition here is pure, monotonic and write-once per fact; the adapter persists it and appends the event.
import { endOfTenantLocalDayUtcMs, tenantWorkDate, isFiniteInstant } from './employee-shell-core.mjs';

const MINUTE_MS = 60000, HOUR_MS = 3600000;
export const EXCEPTION_TYPES = Object.freeze(['MISSING_CLOCK_IN', 'MISSING_CLOCK_OUT']);
export const EXCEPTION_STATUS = Object.freeze({ OPEN: 'open', CORRECTED: 'corrected', RESOLVED_BY_MANAGER: 'resolved_by_manager' });
export const EXCEPTION_EVENT_TYPES = Object.freeze(['detected', 'shown', 'acknowledged', 'corrected', 'manager_seen', 'manager_resolved']);
const ID_RE = /^[A-Za-z0-9_-]+$/;
const err = (code) => ({ ok: false, code });

export function exceptionIdFor(type, shiftId, ansattId) {
  if (!EXCEPTION_TYPES.includes(type) || typeof shiftId !== 'string' || !ID_RE.test(shiftId) || typeof ansattId !== 'string' || !ID_RE.test(ansattId)) return null;
  return (type === 'MISSING_CLOCK_IN' ? 'mci-' : 'mco-') + shiftId + '_' + ansattId;
}
export function missedThresholdMs(policy) { return (policy && Number.isFinite(policy.varianceToleranceMinutes) ? policy.varianceToleranceMinutes : 15) * MINUTE_MS; }
export function selfCorrectionMs(policy) { return (policy && Number.isFinite(policy.employeeSelfCorrectionHours) ? policy.employeeSelfCorrectionHours : 6) * HOUR_MS; }

// THE derivation. shifts = [{ shiftId, projection }] (the employee/manager schedule container entries),
// lookup(shiftId, ansattId) -> attendance record | null. Returns the applicable exceptions, newest planned first.
export function deriveAttendanceExceptions({ shifts, lookup, nowMs, policy }) {
  if (!isFiniteInstant(nowMs) || !policy) return [];
  const look = typeof lookup === 'function' ? lookup : () => null;
  const tol = missedThresholdMs(policy), win = selfCorrectionMs(policy);
  const out = [];
  for (const s of (Array.isArray(shifts) ? shifts : [])) {
    const p = s && s.projection;
    if (!p || p.status !== 'assigned' || typeof p.ansattId !== 'string' || !p.ansattId) continue;
    if (!isFiniteInstant(p.plannedStartAt) || !isFiniteInstant(p.plannedEndAt) || typeof p.workDate !== 'string') continue;
    const att = look(s.shiftId, p.ansattId);
    const overnight = tenantWorkDate(p.plannedEndAt, policy.timezone) !== p.workDate;
    const workDayWindowEndAt = endOfTenantLocalDayUtcMs(p.workDate, policy.timezone, policy.graceHours || 0);
    const base = { ansattId: p.ansattId, shiftId: s.shiftId, workDate: p.workDate, plannedStartAt: p.plannedStartAt, plannedEndAt: p.plannedEndAt, overnight, workDayWindowEndAt };
    if (!att) {
      const effectiveAt = p.plannedStartAt + tol;
      if (nowMs >= effectiveAt) out.push(Object.assign({ exceptionId: exceptionIdFor('MISSING_CLOCK_IN', s.shiftId, p.ansattId), type: 'MISSING_CLOCK_IN', effectiveAt, employeeCorrectionDeadlineAt: p.plannedStartAt + win }, base, { selfCorrectionOpen: nowMs < p.plannedStartAt + win, nowValidForClock: nowMs <= workDayWindowEndAt, attendanceStatus: null }));
    } else if (att.status === 'clocked_in') {
      const effectiveAt = p.plannedEndAt + tol;
      if (nowMs >= effectiveAt) out.push(Object.assign({ exceptionId: exceptionIdFor('MISSING_CLOCK_OUT', s.shiftId, p.ansattId), type: 'MISSING_CLOCK_OUT', effectiveAt, employeeCorrectionDeadlineAt: p.plannedEndAt + win }, base, { selfCorrectionOpen: nowMs < p.plannedEndAt + win, nowValidForClock: nowMs <= workDayWindowEndAt, attendanceStatus: att.status, onBreak: att.breakState === 'on_break', observedClockInAt: att.observedClockInAt, declaredStartAt: att.declaredStartAt }));
    }
  }
  return out.sort((a, b) => b.plannedStartAt - a.plannedStartAt);
}
// Resolution as the canonical records tell it, for a stored exception: still applicable, or made moot by the attendance.
export function exceptionStillApplicable(record, attendance) {
  if (!record) return false;
  if (record.type === 'MISSING_CLOCK_IN') return !attendance;
  if (record.type === 'MISSING_CLOCK_OUT') return !!attendance && attendance.status === 'clocked_in';
  return false;
}

// ---- durable record law --------------------------------------------------------------------------
export const EXCEPTION_KEYS = Object.freeze(['exceptionId', 'type', 'ansattId', 'shiftId', 'workDate', 'plannedStartAt', 'plannedEndAt', 'effectiveAt', 'employeeCorrectionDeadlineAt', 'overnight',
  'status', 'detectedAt', 'detectedByRole', 'detectedByUid', 'firstShownToEmployeeAt', 'acknowledgedByEmployeeAt', 'correctionSubmittedAt', 'correctionSource',
  'managerSeenAt', 'managerSeenByUid', 'managerResolvedAt', 'managerResolvedByUid', 'resolution', 'revision', 'createdAt', 'updatedAt']);
// A fresh record for a derived exception. detectedByRole names WHICH surface first detected it (employee/admin);
// detection is a system fact and says nothing about the employee having seen anything.
export function newExceptionRecord(ex, { actor, now }) {
  if (!ex || !ex.exceptionId || !isFiniteInstant(now) || !actor || typeof actor.uid !== 'string') return null;
  return {
    exceptionId: ex.exceptionId, type: ex.type, ansattId: ex.ansattId, shiftId: ex.shiftId, workDate: ex.workDate,
    plannedStartAt: ex.plannedStartAt, plannedEndAt: ex.plannedEndAt, effectiveAt: ex.effectiveAt, employeeCorrectionDeadlineAt: ex.employeeCorrectionDeadlineAt, overnight: !!ex.overnight,
    status: EXCEPTION_STATUS.OPEN, detectedAt: now, detectedByRole: actor.accessRole === 'admin' ? 'admin' : 'employee', detectedByUid: actor.uid,
    firstShownToEmployeeAt: null, acknowledgedByEmployeeAt: null, correctionSubmittedAt: null, correctionSource: null,
    managerSeenAt: null, managerSeenByUid: null, managerResolvedAt: null, managerResolvedByUid: null, resolution: null,
    revision: 1, createdAt: now, updatedAt: now,
  };
}
export function exceptionEventFor(record, type, actor, now, extra) {
  return Object.assign({ eventId: record.exceptionId + '-rev-' + String(record.revision).padStart(6, '0'), exceptionId: record.exceptionId, type, revision: record.revision, actorUid: actor.uid, actorRole: actor.accessRole, actorAnsattId: actor.ansattId || null, at: now }, extra || {});
}
const own = (record, actor) => actor && (actor.accessRole === 'employee' || actor.accessRole === 'admin') && actor.ansattId === record.ansattId;
const admin = (actor) => actor && actor.accessRole === 'admin';
const bump = (record, patch, now) => Object.assign({}, record, patch, { revision: record.revision + 1, updatedAt: now });
// Monotonic, write-once transitions. Each returns { ok, record, event } or { ok:false, code }.
export function applyExceptionTransition({ record, kind, actor, now, resolution }) {
  if (!record || typeof record !== 'object') return err('NO_EXCEPTION');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');
  if (!actor || actor.accessEnabled !== true) return err('ACTOR_NOT_ENABLED');
  if (kind === 'shown') {
    if (!own(record, actor)) return err('NOT_OWN_EXCEPTION');
    if (record.firstShownToEmployeeAt != null) return err('ALREADY_SHOWN');          // write-once: a refresh never moves it
    const next = bump(record, { firstShownToEmployeeAt: now }, now);
    return { ok: true, record: next, event: exceptionEventFor(next, 'shown', actor, now) };
  }
  if (kind === 'acknowledged') {
    if (!own(record, actor)) return err('NOT_OWN_EXCEPTION');
    if (record.firstShownToEmployeeAt == null) return err('NOT_SHOWN_YET');            // cannot acknowledge what was never shown
    if (record.acknowledgedByEmployeeAt != null) return err('ALREADY_ACKNOWLEDGED');
    const next = bump(record, { acknowledgedByEmployeeAt: now }, now);
    return { ok: true, record: next, event: exceptionEventFor(next, 'acknowledged', actor, now) };
  }
  if (kind === 'corrected') {
    if (!own(record, actor)) return err('NOT_OWN_EXCEPTION');
    if (record.status !== EXCEPTION_STATUS.OPEN) return err('NOT_OPEN');
    if (now >= record.employeeCorrectionDeadlineAt) return err('SELF_CORRECTION_EXPIRED');
    const next = bump(record, { status: EXCEPTION_STATUS.CORRECTED, correctionSubmittedAt: now, correctionSource: 'employee' }, now);
    return { ok: true, record: next, event: exceptionEventFor(next, 'corrected', actor, now) };
  }
  if (kind === 'manager_seen') {
    if (!admin(actor)) return err('NOT_ADMIN');
    if (record.managerSeenAt != null) return err('ALREADY_SEEN');
    const next = bump(record, { managerSeenAt: now, managerSeenByUid: actor.uid }, now);
    return { ok: true, record: next, event: exceptionEventFor(next, 'manager_seen', actor, now) };
  }
  if (kind === 'manager_resolved') {
    if (!admin(actor)) return err('NOT_ADMIN');
    if (record.status !== EXCEPTION_STATUS.OPEN) return err('NOT_OPEN');
    if (typeof resolution !== 'string' || !resolution) return err('RESOLUTION_REQUIRED');
    const next = bump(record, { status: EXCEPTION_STATUS.RESOLVED_BY_MANAGER, managerResolvedAt: now, managerResolvedByUid: actor.uid, resolution }, now);
    return { ok: true, record: next, event: exceptionEventFor(next, 'manager_resolved', actor, now) };
  }
  return err('UNKNOWN_TRANSITION');
}
// Audit reading, for both surfaces: which facts are established. Never equates one with the next.
export function exceptionAuditOf(record) {
  if (!record) return null;
  return {
    detected: record.detectedAt != null,
    shown: record.firstShownToEmployeeAt != null,
    acknowledged: record.acknowledgedByEmployeeAt != null,
    corrected: record.status === EXCEPTION_STATUS.CORRECTED,
    managerSeen: record.managerSeenAt != null,
    managerResolved: record.status === EXCEPTION_STATUS.RESOLVED_BY_MANAGER,
    active: record.status === EXCEPTION_STATUS.OPEN,
  };
}
