// employee-shell-core.test.mjs
// ETR-1 + ETR-2a core model tests. Node built-ins only (node:assert/strict). No packages.
// Run: node employee-shell-core.test.mjs   (exit 0 = all pass, 1 = any fail)
// All ETR-2a tests INJECT now / timezone (via policy) / policy. No ambient clock.

import assert from 'node:assert/strict';
import {
  resolveRouting,
  eligibleMemberships,
  selectMembership,
  ownShifts,
  isUsableMembership,
  // ETR-2a:
  ETR2A_POLICY,
  attendanceIdFor,
  eventIdFor,
  reasonRequiredForClock,
  isReasonValid,
  createShift,
  reviseShift,
  shiftRevisionState,
  rejectEventMutation,
  clockIn,
  clockOut,
  employeeEdit,
  managerCorrection,
  approve,
  assertObservedImmutable,
  assertApprovalFieldsAdminOnly,
  assertOwnershipImmutable,
  assertRevisionMonotonic,
  eventIdMatchesRevision,
  detectRevisionGaps,
  landingReads,
  endOfTenantLocalDayUtcMs,
  EMPLOYEE_MAY_DELETE,
  // ETR-2a corrective (B1-B9):
  tenantWorkDate,
  fmtTenantHM,
  tenantLocalHMToUtcMs,
  computeClockTimes,
  // ETR-2b break path:
  startBreak,
  endBreak,
  declareBreak,
} from './employee-shell-core.mjs';

let passed = 0;
let failed = 0;
const lines = [];
function t(name, fn) {
  try {
    fn();
    passed++;
    lines.push('PASS  ' + name);
  } catch (e) {
    failed++;
    lines.push('FAIL  ' + name + '  ::  ' + (e && e.message ? e.message : e));
  }
}

// =====================================================================
// ETR-1 (preserved unchanged) — membership routing
// =====================================================================
const mOneA = { uid: 'U_ONE', tenantId: 't-alpha', accessRole: 'employee', ansattId: 'ans-a1', accessEnabled: true };
const mManyA = { uid: 'U_MANY', tenantId: 't-alpha', accessRole: 'employee', ansattId: 'ans-a2', accessEnabled: true };
const mManyB = { uid: 'U_MANY', tenantId: 't-beta', accessRole: 'employee', ansattId: 'ans-b7', accessEnabled: true };
const mDisabled = { uid: 'U_ZERO', tenantId: 't-alpha', accessRole: 'employee', ansattId: 'ans-z9', accessEnabled: false };
const mOther = { uid: 'U_OTHER', tenantId: 't-alpha', accessRole: 'employee', ansattId: 'ans-o3', accessEnabled: true };
const mNoAnsatt = { uid: 'U_ADMIN', tenantId: 't-alpha', accessRole: 'admin', ansattId: null, accessEnabled: true };
const ALL = [mOneA, mManyA, mManyB, mDisabled, mOther, mNoAnsatt];
const shifts1 = [
  { id: 's1', ansattId: 'ans-a1', dato: '2026-08-20', fra: '08:00', til: '12:00' },
  { id: 's2', ansattId: 'ans-a2', dato: '2026-08-20', fra: '09:00', til: '15:00' },
  { id: 's3', ansattId: 'ans-b7', dato: '2026-08-21', fra: '10:00', til: '18:00' },
  { id: 's4', ansattId: 'ans-o3', dato: '2026-08-21', fra: '07:00', til: '11:00' },
  { id: 's5', ansattId: 'ans-a1', dato: '2026-08-22', timer: 5 },
];
t('ETR1-1 zero memberships -> no-access', () => {
  assert.equal(resolveRouting([], 'U_ONE').kind, 'no-access');
  assert.equal(resolveRouting(ALL, 'U_NOBODY').kind, 'no-access');
});
t('ETR1-2 one enabled exact-UID -> direct', () => {
  const r = resolveRouting(ALL, 'U_ONE');
  assert.equal(r.kind, 'direct');
  assert.equal(r.membership.tenantId, 't-alpha');
  assert.equal(r.membership.ansattId, 'ans-a1');
});
t('ETR1-3 multiple enabled exact-UID -> picker', () => {
  const r = resolveRouting(ALL, 'U_MANY');
  assert.equal(r.kind, 'picker');
  assert.equal(r.memberships.length, 2);
});
t('ETR1-4 disabled membership ignored', () => {
  assert.equal(eligibleMemberships(ALL, 'U_ZERO').length, 0);
  assert.equal(resolveRouting(ALL, 'U_ZERO').kind, 'no-access');
});
t('ETR1-5 different-UID never leaks', () => {
  const elig = eligibleMemberships(ALL, 'U_ONE');
  assert.equal(elig.length, 1);
  assert.ok(elig.every((m) => m.uid === 'U_ONE'));
});
t('ETR1-6 door selection constrained to eligible tenants', () => {
  const r = resolveRouting(ALL, 'U_MANY');
  assert.equal(selectMembership(r.eligible, 't-gamma'), null);
  const sel = selectMembership(r.eligible, 't-beta');
  assert.ok(sel && sel.tenantId === 't-beta' && sel.ansattId === 'ans-b7');
});
t('ETR1-7 own shifts scoped to selected ansattId', () => {
  const r = resolveRouting(ALL, 'U_MANY');
  const selA = selectMembership(r.eligible, 't-alpha');
  const own = ownShifts(shifts1, selA);
  assert.equal(own.length, 1);
  assert.ok(own.every((s) => s.ansattId === 'ans-a2'));
});
t('ETR1-8 null ansattId -> zero own shifts', () => {
  assert.equal(ownShifts(shifts1, mNoAnsatt).length, 0);
  assert.equal(ownShifts(shifts1, { ansattId: '' }).length, 0);
  assert.equal(ownShifts(shifts1, {}).length, 0);
});
t('ETR1-9 per-membership ansattId yields different own-shift sets', () => {
  const r = resolveRouting(ALL, 'U_MANY');
  const selA = selectMembership(r.eligible, 't-alpha');
  const selB = selectMembership(r.eligible, 't-beta');
  const ownA = ownShifts(shifts1, selA).map((s) => s.id).sort();
  const ownB = ownShifts(shifts1, selB).map((s) => s.id).sort();
  assert.deepEqual(ownA, ['s2']);
  assert.deepEqual(ownB, ['s3']);
  assert.notDeepEqual(ownA, ownB);
});

// =====================================================================
// ETR-2a — CLOCK PATH
// =====================================================================
const POL = ETR2A_POLICY;
const WD = '2026-08-24';
const D = (h, m = 0) => Date.UTC(2026, 7, 24, h, m, 0); // 2026-08-24 hh:mm UTC
const NEXT = (h, m = 0) => Date.UTC(2026, 7, 25, h, m, 0);
const DEADLINE = endOfTenantLocalDayUtcMs(WD, POL.timezone, 0); // 2026-08-25 00:00 CEST = 2026-08-24 22:00 UTC
const SCOPE = { tenantId: 'tenant-alpha' }; // P2-2/P2-3: structural request-path tenant scope for fixtures

function emp(ansattId, over) { return Object.assign({ uid: 'auth-' + ansattId, accessRole: 'employee', ansattId, accessEnabled: true, tenantId: 'tenant-alpha' }, over || {}); }
function admin(over) { return Object.assign({ uid: 'auth-admin', accessRole: 'admin', ansattId: 'ans-admin', accessEnabled: true, tenantId: 'tenant-alpha' }, over || {}); }
function mkShift(ansattId, over) {
  over = over || {};
  const { shift } = createShift({ shiftId: over.shiftId || 'shift-1', ansattId, plannedStartAt: over.start != null ? over.start : D(12), plannedEndAt: over.end != null ? over.end : D(20), workDate: WD, actorUid: 'auth-admin' }, D(8));
  shift.tenantId = over.tenantId || 'tenant-alpha';
  if (over.status) shift.status = over.status;
  return shift;
}
function clockedIn(over) {
  over = over || {};
  const res = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: over.declared != null ? over.declared : D(12), reasonCode: over.reasonCode || null, reasonNote: over.reasonNote || null, scope: SCOPE }, over.now != null ? over.now : D(12), POL);
  assert.ok(res.ok, 'clockedIn helper expected ok, got ' + res.code);
  return res.attendance;
}
function clockedOut(over) {
  over = over || {};
  const a = clockedIn(over);
  const res = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: over.declaredEnd != null ? over.declaredEnd : D(20), reasonCode: over.outReason || 'MANAGEMENT_DECISION', reasonNote: null, scope: SCOPE }, over.outNow != null ? over.outNow : D(20), POL);
  assert.ok(res.ok, 'clockedOut helper expected ok, got ' + res.code);
  return res.attendance;
}
function onBreak(over) {
  over = over || {};
  const a = clockedIn(over);
  const res = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, over.breakNow != null ? over.breakNow : D(13), POL);
  assert.ok(res.ok, 'onBreak helper expected ok, got ' + res.code);
  return res.attendance;
}

// ---- Identity ----
t('ID-1 attendanceId deterministic', () => {
  assert.equal(attendanceIdFor('shift-1', 'ans-a1'), 'shift-1_ans-a1');
});
t('ID-2 shiftId required (null -> null id)', () => {
  assert.equal(attendanceIdFor(null, 'ans-a1'), null);
  assert.equal(attendanceIdFor('', 'ans-a1'), null);
});
t('ID-3 eventId derived from attendanceId+revision', () => {
  assert.equal(eventIdFor('shift-1_ans-a1', 7), 'shift-1_ans-a1-rev-000007');
});

// ---- Clock mechanics C1-C9 ----
t('C1 clock-in assigned shift today ALLOW', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.status, 'clocked_in');
  assert.equal(r.attendance.revision, 1);
  assert.equal(r.attendance.attendanceId, 'shift-1_ans-a1');
});
t('C2 clock-in another employees shift REJECT', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-OTHER'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'NOT_OWN_SHIFT');
});
t('C3 clock-in cross-tenant REJECT (actor tenant != scope tenant; shift tenant is not the mechanism)', () => {
  const r = clockIn({ actor: emp('ans-a1', { tenantId: 'tenant-beta' }), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: { tenantId: 'tenant-alpha' } }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'CROSS_TENANT');
});
t('C4 duplicate attendance REJECT', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), existing: clockedIn(), scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'DUPLICATE_ATTENDANCE');
});
t('C5 clock-out before clock-in REJECT', () => {
  const r = clockOut({ actor: emp('ans-a1'), existing: null, scope: SCOPE }, D(20), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'NO_ATTENDANCE');
});
t('C6 second clock-out REJECT', () => {
  const a = clockedIn();
  const out1 = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), scope: SCOPE }, D(20), POL);
  assert.ok(out1.ok, out1.code);
  const out2 = clockOut({ actor: emp('ans-a1'), existing: out1.attendance, declaredEndAt: D(20), scope: SCOPE }, D(20), POL);
  assert.equal(out2.ok, false); assert.equal(out2.code, 'NOT_CLOCKED_IN');
});
t('C7 clock-in with no shift REJECT', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: null, declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'NO_SHIFT');
});
t('C8 clock-in on cancelled shift REJECT', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1', { status: 'cancelled' }), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_NOT_ASSIGNED');
});
t('C9 clocking disabled REJECT', () => {
  const pol = Object.assign({}, POL, { employeeClockingEnabled: false });
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), pol);
  assert.equal(r.ok, false); assert.equal(r.code, 'CLOCKING_DISABLED');
});

// ---- Observed integrity C10-C13 + tamper ----
t('C10/C13 observed clock-in == injected now (client cannot supply)', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), observedClockInAt: D(9), scope: SCOPE }, D(12), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.observedClockInAt, D(12)); // forced to now, ignores any supplied value
});
t('C11 employee edits observedClockInAt REJECT', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { observedClockInAt: D(9) }, scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.ok(r.code.startsWith('FIELD_NOT_EDITABLE'));
});
t('C12 MANAGER edits observedClockInAt REJECT', () => {
  const a = clockedIn();
  const r = managerCorrection({ actor: admin(), existing: a, patch: { observedClockInAt: D(9) }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.ok(r.code.startsWith('FIELD_NOT_CORRECTABLE'));
});
t('TAMPER observed immutable predicate (employee + manager)', () => {
  const a = clockedIn();
  const bad = Object.assign({}, a, { observedClockInAt: D(9) });
  assert.equal(assertObservedImmutable(a, bad).ok, false);
  assert.equal(assertObservedImmutable(a, Object.assign({}, a)).ok, true);
});

// ---- Declarations & reasons C14-C22 + 3 business examples ----
t('C14/EX1 within both tolerances no reason ALLOW (12:00 obs 12:04 decl 12:00)', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1', { start: D(12) }), declaredStartAt: D(12), scope: SCOPE }, D(12, 4), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.reason.required, false);
});
t('C15/EX2 declaration deviation over tol no reason REJECT (12:00 obs 13:00 decl 12:00)', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1', { start: D(12) }), declaredStartAt: D(12), scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'REASON_REQUIRED');
});
t('C16 declaration deviation over tol WITH reason ALLOW', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1', { start: D(12) }), declaredStartAt: D(12), reasonCode: 'FORGOT_CLOCK_IN', scope: SCOPE }, D(13), POL);
  assert.ok(r.ok, r.code);
});
t('C17/EX3 variance over tol no reason REJECT (clock-out planned 20:00 obs 21:00 decl 21:00)', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(21), scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'REASON_REQUIRED');
});
t('C18 variance over tol WITH reason ALLOW (clock-out)', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(21), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(21), POL);
  assert.ok(r.ok, r.code);
});
t('C19 reasonCode not in policy set REJECT', () => {
  assert.equal(isReasonValid('clock_in', 'NOT_A_CODE', null, POL), false);
});
t('C20 OTHER without note REJECT', () => {
  assert.equal(isReasonValid('clock_in', 'OTHER', '', POL), false);
  assert.equal(isReasonValid('clock_in', 'OTHER', 'because', POL), true);
});
t('C21 reason as display label (not key) REJECT', () => {
  assert.equal(isReasonValid('clock_in', 'Forgot to clock in', null, POL), false);
});
t('REASON appliesTo mismatch REJECT (LATE_ARRIVAL not valid for clock_out)', () => {
  assert.equal(isReasonValid('clock_out', 'LATE_ARRIVAL', null, POL), false);
  assert.equal(isReasonValid('clock_in', 'LATE_ARRIVAL', null, POL), true);
});
t('C22 declared adjusted when employeeMayAdjustTime false REJECT', () => {
  const pol = Object.assign({}, POL, { employeeMayAdjustTime: false });
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(11), scope: SCOPE }, D(12), pol);
  assert.equal(r.ok, false); assert.equal(r.code, 'TIME_ADJUST_NOT_ALLOWED');
});

// ---- Planned snapshot & schedule truth C23-C25 + S1-S5 ----
t('S1 shift revised BEFORE attendance -> shift_revision event on the shift', () => {
  const built = createShift({ shiftId: 'sh', ansattId: 'ans-a1', plannedStartAt: D(12), plannedEndAt: D(20), workDate: WD, actorUid: 'auth-admin' }, D(8));
  const rev = reviseShift(built.shift, built.events, { plannedStartAt: D(13), plannedEndAt: D(21) }, D(9), 'auth-admin');
  assert.ok(rev.ok, rev.code);
  assert.equal(rev.event.type, 'shift_revision');
  assert.equal(rev.shift.revision, 2);
  assert.equal(rev.events.length, 2);
});
t('C25 shift edit emits a shift_revision event', () => {
  const b = createShift({ shiftId: 'sh', ansattId: 'ans-a1', plannedStartAt: D(12), plannedEndAt: D(20), workDate: WD, actorUid: 'auth-admin' }, D(8));
  const rev = reviseShift(b.shift, b.events, { plannedEndAt: D(21) }, D(9), 'auth-admin');
  assert.equal(rev.event.type, 'shift_revision');
  assert.deepEqual(rev.event.changed.plannedEndAt, { before: D(20), after: D(21) });
});
t('S2/C23 shift revised AFTER attendance -> plannedSnapshot + plannedShiftRevision UNCHANGED', () => {
  const b = createShift({ shiftId: 'sh', ansattId: 'ans-a1', plannedStartAt: D(12), plannedEndAt: D(20), workDate: WD, actorUid: 'auth-admin' }, D(8));
  b.shift.tenantId = 'tenant-alpha';
  const att = clockIn({ actor: emp('ans-a1'), shift: b.shift, declaredStartAt: D(12), scope: SCOPE }, D(12), POL).attendance;
  reviseShift(b.shift, b.events, { plannedStartAt: D(13), plannedEndAt: D(21) }, D(13), 'auth-admin'); // revise later
  assert.deepEqual(att.plannedSnapshot, { startAt: D(12), endAt: D(20) }); // snapshot immutable
  assert.equal(att.plannedShiftRevision, 1);
});
t('S3 counterexample: 12:00-20:00 -> revised 13:00-21:00 -> clock 13:00', () => {
  const b = createShift({ shiftId: 'sh', ansattId: 'ans-a1', plannedStartAt: D(12), plannedEndAt: D(20), workDate: WD, actorUid: 'auth-admin' }, D(8));
  const rev = reviseShift(b.shift, b.events, { plannedStartAt: D(13), plannedEndAt: D(21) }, D(12, 40), 'auth-admin');
  rev.shift.tenantId = 'tenant-alpha';
  const att = clockIn({ actor: emp('ans-a1'), shift: rev.shift, declaredStartAt: D(13), scope: SCOPE }, D(13), POL).attendance;
  assert.deepEqual(att.plannedSnapshot, { startAt: D(13), endAt: D(21) });
  assert.equal(att.plannedShiftRevision, 2);
  const r1 = shiftRevisionState(rev.events, 1); // original still retrievable
  assert.equal(r1.plannedStartAt, D(12));
  assert.equal(r1.plannedEndAt, D(20));
});
t('S4 update/delete a shift_revision event REJECT', () => {
  assert.equal(rejectEventMutation('update').ok, false);
  assert.equal(rejectEventMutation('delete').ok, false);
});
t('S5 attendance with mismatched plannedShiftRevision REJECT', () => {
  const s = mkShift('ans-a1'); // revision 1
  const r = clockIn({ actor: emp('ans-a1'), shift: s, declaredStartAt: D(12), plannedShiftRevision: 2, scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_REVISION_MISMATCH');
});
t('C24 employee/manager edit plannedSnapshot REJECT', () => {
  const a = clockedIn();
  const e = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { plannedSnapshot: { startAt: 0, endAt: 0 } }, scope: SCOPE }, D(13), POL);
  assert.equal(e.ok, false); assert.ok(e.code.startsWith('FIELD_NOT_EDITABLE'));
  const m = managerCorrection({ actor: admin(), existing: a, patch: { plannedSnapshot: { startAt: 0, endAt: 0 } }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(13), POL);
  assert.equal(m.ok, false); assert.ok(m.code.startsWith('FIELD_NOT_CORRECTABLE'));
  assert.equal(assertOwnershipImmutable(a, Object.assign({}, a, { ansattId: 'x' })).ok, false);
});

// ---- Events & history C26-C33 ----
t('C26/C27 event update/delete REJECT', () => {
  assert.equal(rejectEventMutation('update').ok, false);
  assert.equal(rejectEventMutation('delete').ok, false);
});
t('C30 revision increments on value-bearing change', () => {
  const a = clockedIn(); // rev 1
  const out = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(20), POL);
  assert.equal(out.attendance.revision, 2);
  assert.equal(assertRevisionMonotonic(a, out.attendance).ok, true);
});
t('C31 revision decrement/repeat REJECT', () => {
  const a = clockedIn();
  assert.equal(assertRevisionMonotonic(a, Object.assign({}, a, { revision: 1 })).ok, false);
  assert.equal(assertRevisionMonotonic(a, Object.assign({}, a, { revision: 0 })).ok, false);
});
t('C32 event id must match new revision', () => {
  const a = clockedIn();
  const out = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(20), POL);
  assert.equal(eventIdMatchesRevision(out.event), true);
  assert.equal(eventIdMatchesRevision(Object.assign({}, out.event, { eventId: 'wrong' })), false);
});
t('C33 revision gap DETECTED', () => {
  assert.equal(detectRevisionGaps([{ revision: 1 }, { revision: 2 }]).hasGap, false);
  assert.equal(detectRevisionGaps([{ revision: 1 }, { revision: 3 }]).hasGap, true);
});

// ---- Approval C34-C37 + manager correction C28/C29 ----
t('C34/T6 employee edit after approval REJECT', () => {
  let a = clockedIn();
  a = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(20), POL).attendance;
  a = approve({ actor: admin(), existing: a, approvedStartAt: D(12), approvedEndAt: D(20), scope: SCOPE }, D(21), POL).attendance;
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { declaredStartAt: D(11) }, scope: SCOPE }, D(21, 30), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'ALREADY_APPROVED');
});
t('C35 employee writes approved* field REJECT', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { approvedStartAt: D(12) }, scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.ok(r.code.startsWith('FIELD_NOT_EDITABLE'));
  assert.equal(assertApprovalFieldsAdminOnly('employee', a, Object.assign({}, a, { approvedStartAt: D(12) })).ok, false);
  assert.equal(assertApprovalFieldsAdminOnly('admin', a, Object.assign({}, a, { approvedStartAt: D(12) })).ok, true);
});
t('C36 manager approves completed record, approvedByUid == actor', () => {
  const a = clockedOut(); // B6/P2-1: approval requires a completed (clocked_out) attendance
  const r = approve({ actor: admin(), existing: a, approvedStartAt: D(12), approvedEndAt: D(20), scope: SCOPE }, D(21), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.approvedByUid, 'auth-admin');
  assert.equal(r.attendance.status, 'approved');
});
t('C37 approval outside sane bound REJECT', () => {
  const a = clockedIn();
  const r = approve({ actor: admin(), existing: a, approvedStartAt: D(12) - 48 * 3600000, approvedEndAt: D(20), scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'APPROVED_OUT_OF_BOUND');
});
t('C28 manager correction without reason REJECT (policy requires)', () => {
  const a = clockedIn();
  const r = managerCorrection({ actor: admin(), existing: a, patch: { declaredStartAt: D(11) }, scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'REASON_REQUIRED');
});
t('C29 manager correction WITH reason preserves prior value in event', () => {
  const a = clockedIn();
  const r = managerCorrection({ actor: admin(), existing: a, patch: { declaredStartAt: D(11) }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(13), POL);
  assert.ok(r.ok, r.code);
  assert.deepEqual(r.event.changed.declaredStartAt, { before: D(12), after: D(11) });
  assert.equal(r.attendance.declaredStartAt, D(11));
});

// ---- Ruling-001 carried edit/ownership/window vectors ----
t('T4 first employee edit within window ALLOW', () => {
  let a = clockedIn();
  a = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(20), POL).attendance;
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'fix' }, scope: SCOPE }, D(21), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.employeeEditCount, 1);
});
t('T5 second employee edit REJECT (once)', () => {
  let a = clockedIn();
  const r1 = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'a' }, scope: SCOPE }, D(13), POL);
  const r2 = employeeEdit({ actor: emp('ans-a1'), existing: r1.attendance, patch: { note: 'b' }, scope: SCOPE }, D(13, 30), POL);
  assert.equal(r2.ok, false); assert.equal(r2.code, 'EDIT_LIMIT');
});
t('T7 employee edit after deadline REJECT', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, NEXT(1), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'EDIT_WINDOW_CLOSED');
});
t('T24 edit at EXACTLY the deadline instant REJECT (strictly-before)', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, DEADLINE, POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'EDIT_WINDOW_CLOSED');
});
t('T25 overnight/graceHours=0 edit next day REJECT', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, NEXT(6), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'EDIT_WINDOW_CLOSED');
});
t('T26 graceHours>0 makes a later edit ALLOWED', () => {
  const pol = Object.assign({}, POL, { graceHours: 12 });
  // recompute an attendance whose deadline uses the grace policy
  const res = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), pol);
  const a = res.attendance;
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, NEXT(6), pol); // 06:00 next day < grace deadline (10:00 UTC)
  assert.ok(r.ok, r.code);
});
t('T8 accessEnabled false REJECT', () => {
  const r = clockIn({ actor: emp('ans-a1', { accessEnabled: false }), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'ACTOR_NOT_ENABLED');
});
t('T9 employee delete is never allowed', () => {
  assert.equal(EMPLOYEE_MAY_DELETE, false);
});
t('T10 malformed ownership fail-closed', () => {
  const r = clockIn({ actor: emp('ans-a1', { ansattId: '' }), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'ACTOR_NO_ANSATTID');
  assert.equal(isUsableMembership({ uid: 'u' }), false);
});
t('T11-T15 employee edit of forbidden fields REJECT', () => {
  const a = clockedIn();
  for (const f of ['ansattId', 'shiftId', 'workDate', 'createdAt', 'createdByUid', 'status', 'employeeEditDeadline', 'observedClockOutAt']) {
    const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { [f]: 1 }, scope: SCOPE }, D(13), POL);
    assert.equal(r.ok, false, 'expected reject editing ' + f);
    assert.ok(r.code.startsWith('FIELD_NOT_EDITABLE'), f);
  }
});
t('T16 declared time outside workDate REJECT', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { declaredStartAt: Date.UTC(2026, 6, 1, 12, 0) }, scope: SCOPE }, D(13), POL); // July -> outside Aug 24
  assert.equal(r.ok, false); assert.equal(r.code, 'DECLARED_OUTSIDE_WORKDATE');
});
t('T17 create cannot set status approved (forced clocked_in)', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), status: 'approved', scope: SCOPE }, D(12), POL);
  assert.equal(r.attendance.status, 'clocked_in');
});
t('T18 create employeeEditCount == 0', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.equal(r.attendance.employeeEditCount, 0);
});
t('T19 employeeEditDeadline within MAX_WINDOW of createdAt', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  const a = r.attendance;
  assert.ok(a.employeeEditDeadline > a.createdAt);
  assert.ok((a.employeeEditDeadline - a.createdAt) <= POL.maxEditWindowHours * 3600000);
});
t('T20 endAt before startAt REJECT (approve + employee edit)', () => {
  const a = clockedIn();
  assert.equal(approve({ actor: admin(), existing: a, approvedStartAt: D(20), approvedEndAt: D(12), scope: SCOPE }, D(21), POL).code, 'END_BEFORE_START');
  const e = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { declaredStartAt: D(19), declaredEndAt: D(13) }, scope: SCOPE }, D(13), POL);
  assert.equal(e.ok, false); assert.equal(e.code, 'END_BEFORE_START');
});
t('T21 unrecognised status -> not editable (fail closed)', () => {
  const a = Object.assign({}, clockedIn(), { status: 'weird_state' });
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'STATUS_NOT_EDITABLE');
});
t('T22 admin WITH ansattId creates own record ALLOW', () => {
  const r = clockIn({ actor: admin({ ansattId: 'ans-admin' }), shift: mkShift('ans-admin'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.ok(r.ok, r.code);
});
t('T23 admin WITHOUT ansattId creates REJECT', () => {
  const r = clockIn({ actor: admin({ ansattId: null }), shift: mkShift('ans-admin'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'ACTOR_NO_ANSATTID');
});
t('T27 routing zero/many behaves as ETR-1', () => {
  assert.equal(resolveRouting(ALL, 'U_NOBODY').kind, 'no-access');
  assert.equal(resolveRouting(ALL, 'U_MANY').kind, 'picker');
});

// ---- Landing shape L1 ----
t('L1 Today/Clocking renders from exactly TWO reads, no query', () => {
  const l = landingReads('shift-1', 'ans-a1');
  assert.equal(l.query, false);
  assert.equal(l.reads.length, 2);
  assert.deepEqual(l.reads.map((r) => r.kind).sort(), ['attendance', 'shift']);
  const att = l.reads.find((r) => r.kind === 'attendance');
  assert.equal(att.id, 'shift-1_ans-a1');
});

// =====================================================================
// ETR-2a CORRECTIVE (Pass 1) — adversarial coverage for B1-B9 (Ruling 001)
// =====================================================================
function mkShiftEvents() {
  return createShift({ shiftId: 'sh', ansattId: 'ans-a1', plannedStartAt: D(12), plannedEndAt: D(20), workDate: WD, actorUid: 'auth-admin' }, D(8));
}

// ---- B1: shift revision history fails closed ----
t('B1a reviseShift rejects an arbitrary patch key', () => {
  const b = mkShiftEvents();
  const r = reviseShift(b.shift, b.events, { plannedStartAt: D(13), foo: 'bar' }, D(9), 'auth-admin');
  assert.equal(r.ok, false); assert.ok(r.code.startsWith('SHIFT_FIELD_NOT_MUTABLE'));
});
t('B1b reviseShift rejects immutable identity/workDate/provenance/revision keys', () => {
  const b = mkShiftEvents();
  for (const k of ['shiftId', 'workDate', 'createdByUid', 'createdAt', 'revision', 'attendanceId']) {
    const r = reviseShift(b.shift, b.events, { [k]: 1 }, D(9), 'auth-admin');
    assert.equal(r.ok, false, 'expected reject ' + k);
    assert.ok(r.code.startsWith('SHIFT_FIELD_NOT_MUTABLE'), k);
  }
});
t('B1c reviseShift never silently mutates identity; logs only the accepted change', () => {
  const b = mkShiftEvents();
  const r = reviseShift(b.shift, b.events, { plannedStartAt: D(13) }, D(9), 'auth-admin');
  assert.ok(r.ok, r.code);
  assert.equal(r.shift.shiftId, 'sh');
  assert.equal(r.shift.workDate, WD);
  assert.equal(r.shift.createdByUid, 'auth-admin');
  assert.deepEqual(Object.keys(r.event.changed), ['plannedStartAt']);
  assert.deepEqual(r.event.changed.plannedStartAt, { before: D(12), after: D(13) });
});
t('B1d reviseShift no-op fabricates no revision/event', () => {
  const b = mkShiftEvents();
  const r = reviseShift(b.shift, b.events, { plannedStartAt: D(12) }, D(9), 'auth-admin');
  assert.equal(r.ok, false); assert.equal(r.code, 'NO_CHANGE');
});
t('B1e reviseShift rejects an end-before-start planned interval', () => {
  const b = mkShiftEvents();
  const r = reviseShift(b.shift, b.events, { plannedEndAt: D(11) }, D(9), 'auth-admin');
  assert.equal(r.ok, false); assert.equal(r.code, 'END_BEFORE_START');
});

// ---- B2: central declared-time sanity ----
t('B2a clockOut rejects declaredEnd < declaredStart', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(11), scope: SCOPE }, D(20), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'END_BEFORE_START');
});
t('B2b clockIn rejects a declared start outside workDate even WITH a reason', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: Date.UTC(2026, 6, 1, 12, 0), reasonCode: 'FORGOT_CLOCK_IN', scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'DECLARED_OUTSIDE_WORKDATE');
});
t('B2c clockIn/clockOut reject non-finite declared instants', () => {
  const r1 = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: NaN, scope: SCOPE }, D(12), POL);
  assert.equal(r1.ok, false); assert.equal(r1.code, 'DECLARED_NOT_FINITE');
  const a = clockedIn();
  const r2 = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: Infinity, scope: SCOPE }, D(20), POL);
  assert.equal(r2.ok, false); assert.equal(r2.code, 'DECLARED_NOT_FINITE');
});

// ---- B3: employee edit cannot bypass two-threshold reason model ----
t('B3a employeeEdit large declaredStart change with NO reason REJECT', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { declaredStartAt: D(5) }, scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'REASON_REQUIRED');
});
t('B3b employeeEdit large declaredStart change WITH valid reason ALLOW', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { declaredStartAt: D(5) }, reasonCode: 'FORGOT_CLOCK_IN', scope: SCOPE }, D(13), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.declaredStartAt, D(5));
});
t('B3c employeeEdit large declaredEnd change with NO reason REJECT', () => {
  const a = clockedOut();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { declaredEndAt: D(17) }, scope: SCOPE }, D(20, 30), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'REASON_REQUIRED');
});
t('B3d employeeEdit no-op consumes no allowance (NO_CHANGE)', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { declaredStartAt: a.declaredStartAt }, scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'NO_CHANGE');
});

// ---- B4: policy modes / cutoff / max window actually enforced ----
t('B4a employeeEditMode untilApproved allows repeated valid edits', () => {
  const pol = Object.assign({}, POL, { employeeEditMode: 'untilApproved' });
  const a = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), pol).attendance;
  const r1 = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'a' }, scope: SCOPE }, D(13), pol);
  assert.ok(r1.ok, r1.code);
  const r2 = employeeEdit({ actor: emp('ans-a1'), existing: r1.attendance, patch: { note: 'b' }, scope: SCOPE }, D(13, 30), pol);
  assert.ok(r2.ok, r2.code);
  assert.equal(r2.attendance.employeeEditCount, 2);
});
t('B4b employeeEditMode never rejects any edit', () => {
  const pol = Object.assign({}, POL, { employeeEditMode: 'never' });
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, D(13), pol);
  assert.equal(r.ok, false); assert.equal(r.code, 'EDIT_DISABLED');
});
t('B4c unsupported employeeEditMode fails closed', () => {
  const pol = Object.assign({}, POL, { employeeEditMode: 'weird' });
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, D(13), pol);
  assert.equal(r.ok, false); assert.equal(r.code, 'EDIT_MODE_INVALID');
});
t('B4d maxEditWindowHours caps the deadline even with a large graceHours', () => {
  const pol = Object.assign({}, POL, { graceHours: 110 });
  const a = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), pol).attendance;
  assert.ok((a.employeeEditDeadline - a.createdAt) <= POL.maxEditWindowHours * 3600000);
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, D(12) + 40 * 3600000, pol);
  assert.equal(r.ok, false); assert.equal(r.code, 'EDIT_WINDOW_CLOSED');
});
t('B4e unsupported editCutoffMode fails closed (deadline == createdAt)', () => {
  const pol = Object.assign({}, POL, { editCutoffMode: 'weird' });
  const a = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), pol).attendance;
  assert.equal(a.employeeEditDeadline, a.createdAt);
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, D(12) + 1, pol);
  assert.equal(r.ok, false); assert.equal(r.code, 'EDIT_WINDOW_CLOSED');
});

// ---- B5: typed manager correction ----
t('B5a managerCorrection rejects status/counter/approval/arbitrary/observed via whitelist', () => {
  const a = clockedIn();
  for (const patch of [{ status: 'approved' }, { employeeEditCount: -9 }, { approvedStartAt: D(12) }, { evil: 'x' }, { revision: 99 }, { observedClockInAt: D(9) }]) {
    const r = managerCorrection({ actor: admin(), existing: a, patch, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(13), POL);
    assert.equal(r.ok, false, 'expected reject ' + Object.keys(patch)[0]);
    assert.ok(r.code.startsWith('FIELD_NOT_CORRECTABLE'), Object.keys(patch)[0]);
  }
});
t('B5b managerCorrection rejects an invalid corrected interval', () => {
  const a = clockedOut();
  const r = managerCorrection({ actor: admin(), existing: a, patch: { declaredEndAt: D(11) }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'END_BEFORE_START');
});
t('B5c managerCorrection accepts a typed declared correction; observed untouched', () => {
  const a = clockedOut();
  const r = managerCorrection({ actor: admin(), existing: a, patch: { declaredEndAt: D(19) }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(21), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.declaredEndAt, D(19));
  assert.equal(r.attendance.revision, a.revision + 1);
  assert.equal(r.attendance.observedClockOutAt, a.observedClockOutAt);
});

// ---- B6: approval requires a completed attendance ----
t('B6 approve rejects a still-clocked-in record', () => {
  const a = clockedIn();
  const r = approve({ actor: admin(), existing: a, approvedStartAt: D(12), approvedEndAt: D(20), scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'NOT_CLOCKED_OUT');
});

// ---- B7: role/tenant continuity on every later transition ----
t('B7a clockOut by unsupported role REJECT', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1', { accessRole: 'viewer' }), existing: a, declaredEndAt: D(20), scope: SCOPE }, D(20), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'ROLE_NOT_ALLOWED');
});
t('B7b employeeEdit by unsupported role REJECT', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1', { accessRole: 'viewer' }), existing: a, patch: { note: 'x' }, scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'ROLE_NOT_ALLOWED');
});
t('B7c cross-tenant later transition REJECT via injected scope', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1', { tenantId: 'tenant-beta' }), existing: a, declaredEndAt: D(20), scope: { tenantId: 'tenant-alpha' } }, D(20), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'CROSS_TENANT');
});
t('B7d managerCorrection + approve cross-tenant REJECT', () => {
  const a = clockedOut();
  const mc = managerCorrection({ actor: admin({ tenantId: 'tenant-beta' }), existing: a, patch: { declaredEndAt: D(19) }, reasonCode: 'MANAGEMENT_DECISION', scope: { tenantId: 'tenant-alpha' } }, D(21), POL);
  assert.equal(mc.ok, false); assert.equal(mc.code, 'CROSS_TENANT');
  const ap = approve({ actor: admin({ tenantId: 'tenant-beta' }), existing: a, approvedStartAt: D(12), approvedEndAt: D(20), scope: { tenantId: 'tenant-alpha' } }, D(21), POL);
  assert.equal(ap.ok, false); assert.equal(ap.code, 'CROSS_TENANT');
});
t('B7e same-tenant scope still allows the transition', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: { tenantId: 'tenant-alpha' } }, D(20), POL);
  assert.ok(r.ok, r.code);
});

// ---- B8: tenant-timezone helpers are host-independent + deterministic ----
t('B8a tenantWorkDate uses tenant tz, not host', () => {
  assert.equal(tenantWorkDate(Date.UTC(2026, 7, 24, 22, 30), 'Europe/Oslo'), '2026-08-25'); // 00:30 CEST next day
  assert.equal(tenantWorkDate(Date.UTC(2026, 7, 24, 22, 30), 'UTC'), '2026-08-24');
});
t('B8b fmtTenantHM formats in the tenant tz', () => {
  assert.equal(fmtTenantHM(Date.UTC(2026, 7, 24, 10, 5), 'Europe/Oslo'), '12:05');
  assert.equal(fmtTenantHM(Date.UTC(2026, 7, 24, 10, 5), 'UTC'), '10:05');
});
t('B8c tenantLocalHMToUtcMs round-trips with fmtTenantHM', () => {
  const utc = tenantLocalHMToUtcMs('2026-08-24', '12:00', 'Europe/Oslo');
  assert.equal(fmtTenantHM(utc, 'Europe/Oslo'), '12:00');
  assert.equal(utc, Date.UTC(2026, 7, 24, 10, 0)); // 12:00 CEST == 10:00 UTC
});

// ---- B9: displayed observed value cannot diverge from the recorded one ----
t('B9a computeClockTimes: observed is the injected instant, declared defaults to it', () => {
  const now = Date.UTC(2026, 7, 24, 10, 0);
  const r = computeClockTimes({ nowMs: now, declaredHM: undefined, workDate: '2026-08-24', timezone: 'Europe/Oslo', mayAdjust: true });
  assert.equal(r.observedAt, now);
  assert.equal(r.declaredAt, now);
});
t('B9b computeClockTimes: observed stays the injected instant even when declared is adjusted', () => {
  const now = Date.UTC(2026, 7, 24, 10, 0);
  const r = computeClockTimes({ nowMs: now, declaredHM: '11:30', workDate: '2026-08-24', timezone: 'Europe/Oslo', mayAdjust: true });
  assert.equal(r.observedAt, now);
  assert.equal(r.declaredAt, Date.UTC(2026, 7, 24, 9, 30)); // 11:30 CEST == 09:30 UTC
  assert.notEqual(r.declaredAt, r.observedAt);
});
t('B9c computeClockTimes ignores adjusted time when mayAdjust is false', () => {
  const now = Date.UTC(2026, 7, 24, 10, 0);
  const r = computeClockTimes({ nowMs: now, declaredHM: '08:00', workDate: '2026-08-24', timezone: 'Europe/Oslo', mayAdjust: false });
  assert.equal(r.declaredAt, now);
  assert.equal(r.observedAt, now);
});

// =====================================================================
// ETR-2a CORRECTIVE PASS 2 — adversarial coverage for P2-1..P2-5 (Ruling 002)
// =====================================================================

// ---- P2-1: approval requires a structurally complete attendance ----
t('P2-1a approve rejects missing observedClockOutAt', () => {
  const a = Object.assign({}, clockedOut(), { observedClockOutAt: null });
  const r = approve({ actor: admin(), existing: a, approvedStartAt: D(12), approvedEndAt: D(20), scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'INCOMPLETE_ATTENDANCE:observedClockOutAt');
});
t('P2-1b approve rejects missing declaredEndAt', () => {
  const a = Object.assign({}, clockedOut(), { declaredEndAt: null });
  const r = approve({ actor: admin(), existing: a, approvedStartAt: D(12), approvedEndAt: D(20), scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'INCOMPLETE_ATTENDANCE:declaredEndAt');
});
t('P2-1c approve rejects a non-finite completion fact', () => {
  const a = Object.assign({}, clockedOut(), { observedClockInAt: NaN });
  const r = approve({ actor: admin(), existing: a, approvedStartAt: D(12), approvedEndAt: D(20), scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'INCOMPLETE_ATTENDANCE:observedClockInAt');
});
t('P2-1d approve rejects a malformed declared interval on a clocked_out record', () => {
  const a = Object.assign({}, clockedOut(), { declaredStartAt: D(19), declaredEndAt: D(13) });
  const r = approve({ actor: admin(), existing: a, approvedStartAt: D(12), approvedEndAt: D(20), scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'MALFORMED_DECLARED_INTERVAL');
});
t('P2-1e approve rejects a malformed observed interval on a clocked_out record', () => {
  const a = Object.assign({}, clockedOut(), { observedClockOutAt: D(9) }); // out < in (D12)
  const r = approve({ actor: admin(), existing: a, approvedStartAt: D(12), approvedEndAt: D(20), scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'MALFORMED_OBSERVED_INTERVAL');
});

// ---- P2-2: structural tenant/path scope mandatory on later transitions ----
t('P2-2a clockOut without scope REJECT (MISSING_SCOPE)', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION' }, D(20), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'MISSING_SCOPE');
});
t('P2-2b clockOut with empty scope.tenantId REJECT (SCOPE_TENANT_INVALID)', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: { tenantId: '' } }, D(20), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'SCOPE_TENANT_INVALID');
});
t('P2-2c clockOut with missing actor tenant REJECT (MISSING_ACTOR_TENANT)', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1', { tenantId: undefined }), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(20), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'MISSING_ACTOR_TENANT');
});
t('P2-2d employeeEdit without scope REJECT (MISSING_SCOPE)', () => {
  const a = clockedIn();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' } }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'MISSING_SCOPE');
});
t('P2-2e managerCorrection without scope REJECT (MISSING_SCOPE)', () => {
  const a = clockedIn();
  const r = managerCorrection({ actor: admin(), existing: a, patch: { declaredStartAt: D(11) }, reasonCode: 'MANAGEMENT_DECISION' }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'MISSING_SCOPE');
});
t('P2-2f approve without scope REJECT (MISSING_SCOPE)', () => {
  const a = clockedOut();
  const r = approve({ actor: admin(), existing: a, approvedStartAt: D(12), approvedEndAt: D(20) }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'MISSING_SCOPE');
});

// ---- P2-3: clock-in requires the same structural tenant scope ----
t('P2-3a clockIn without scope REJECT (MISSING_SCOPE)', () => {
  const r = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12) }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'MISSING_SCOPE');
});
t('P2-3b clockIn with missing actor tenant REJECT (MISSING_ACTOR_TENANT)', () => {
  const r = clockIn({ actor: emp('ans-a1', { tenantId: undefined }), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'MISSING_ACTOR_TENANT');
});
t('P2-3c clockIn cross-tenant same-ansattId REJECT (CROSS_TENANT)', () => {
  const r = clockIn({ actor: emp('ans-a1', { tenantId: 'tenant-beta' }), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: { tenantId: 'tenant-alpha' } }, D(12), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'CROSS_TENANT');
});

// ---- P2-4: injected action time must be finite on every timestamped path ----
t('P2-4 non-finite now fails closed on every timestamp-producing validator', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const cs = createShift({ shiftId: 'sh', ansattId: 'ans-a1', plannedStartAt: D(12), plannedEndAt: D(20), workDate: WD, actorUid: 'auth-admin' }, bad);
    assert.equal(cs.ok, false, 'createShift ' + bad); assert.equal(cs.code, 'NOW_NOT_FINITE');
    const base = mkShiftEvents();
    const rv = reviseShift(base.shift, base.events, { plannedEndAt: D(21) }, bad, 'auth-admin');
    assert.equal(rv.ok, false, 'reviseShift ' + bad); assert.equal(rv.code, 'NOW_NOT_FINITE');
    const ci = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, bad, POL);
    assert.equal(ci.ok, false, 'clockIn ' + bad); assert.equal(ci.code, 'NOW_NOT_FINITE');
    const a = clockedIn();
    const co = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, bad, POL);
    assert.equal(co.ok, false, 'clockOut ' + bad); assert.equal(co.code, 'NOW_NOT_FINITE');
    const ee = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { note: 'x' }, scope: SCOPE }, bad, POL);
    assert.equal(ee.ok, false, 'employeeEdit ' + bad); assert.equal(ee.code, 'NOW_NOT_FINITE');
    const mc = managerCorrection({ actor: admin(), existing: a, patch: { declaredStartAt: D(11) }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, bad, POL);
    assert.equal(mc.ok, false, 'managerCorrection ' + bad); assert.equal(mc.code, 'NOW_NOT_FINITE');
    const ao = clockedOut();
    const ap = approve({ actor: admin(), existing: ao, approvedStartAt: D(12), approvedEndAt: D(20), scope: SCOPE }, bad, POL);
    assert.equal(ap.ok, false, 'approve ' + bad); assert.equal(ap.code, 'NOW_NOT_FINITE');
  }
});

// ---- P2-5: planned instants finite and ordered at create and revise ----
t('P2-5a createShift rejects a non-finite planned start (PLANNED_NOT_FINITE)', () => {
  const r = createShift({ shiftId: 'sh', ansattId: 'ans-a1', plannedStartAt: NaN, plannedEndAt: D(20), workDate: WD, actorUid: 'auth-admin' }, D(8));
  assert.equal(r.ok, false); assert.equal(r.code, 'PLANNED_NOT_FINITE');
});
t('P2-5b createShift rejects an Infinity planned end (PLANNED_NOT_FINITE)', () => {
  const r = createShift({ shiftId: 'sh', ansattId: 'ans-a1', plannedStartAt: D(12), plannedEndAt: Infinity, workDate: WD, actorUid: 'auth-admin' }, D(8));
  assert.equal(r.ok, false); assert.equal(r.code, 'PLANNED_NOT_FINITE');
});
t('P2-5c createShift rejects an end-before-start planned interval (END_BEFORE_START)', () => {
  const r = createShift({ shiftId: 'sh', ansattId: 'ans-a1', plannedStartAt: D(20), plannedEndAt: D(12), workDate: WD, actorUid: 'auth-admin' }, D(8));
  assert.equal(r.ok, false); assert.equal(r.code, 'END_BEFORE_START');
});
t('P2-5d reviseShift rejects a non-finite planned patch (PLANNED_NOT_FINITE)', () => {
  const b = mkShiftEvents();
  const r = reviseShift(b.shift, b.events, { plannedEndAt: NaN }, D(9), 'auth-admin');
  assert.equal(r.ok, false); assert.equal(r.code, 'PLANNED_NOT_FINITE');
});
t('P2-5e reviseShift rejects an Infinity planned patch (PLANNED_NOT_FINITE)', () => {
  const b = mkShiftEvents();
  const r = reviseShift(b.shift, b.events, { plannedStartAt: Infinity }, D(9), 'auth-admin');
  assert.equal(r.ok, false); assert.equal(r.code, 'PLANNED_NOT_FINITE');
});

// =====================================================================
// ETR-2a CORRECTIVE PASS 3 — clock-out chronology guard (Ruling 003)
// =====================================================================
t('P3a clock-out with observed now < observedClockInAt REJECT', () => {
  const a = clockedIn(); // observedClockInAt = D(12)
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(11), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'CLOCK_OUT_BEFORE_CLOCK_IN');
});
t('P3b clock-out with missing/non-finite existing.observedClockInAt REJECT', () => {
  for (const bad of [null, undefined, NaN, Infinity]) {
    const a = Object.assign({}, clockedIn(), { observedClockInAt: bad });
    const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(20), POL);
    assert.equal(r.ok, false, 'expected reject for ' + String(bad));
    assert.equal(r.code, 'OBSERVED_IN_NOT_FINITE', String(bad));
  }
});
t('P3c chronology rejection produces no event/revision/attendance', () => {
  const a = clockedIn();
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(11), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'CLOCK_OUT_BEFORE_CLOCK_IN');
  assert.equal(r.attendance, undefined);
  assert.equal(r.event, undefined);
  assert.equal(a.revision, 1); // existing projection untouched
});
t('P3d normal clock-out after observed clock-in still ALLOW', () => {
  const a = clockedIn(); // observedClockInAt = D(12)
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(20), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.status, 'clocked_out');
  assert.equal(r.attendance.observedClockOutAt, D(20));
});
t('P3e observed clock-out EQUAL to clock-in is not rejected by the chronology guard', () => {
  const a = clockedIn(); // observedClockInAt = D(12)
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(12), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(12), POL);
  assert.ok(r.ok, r.code); // equality allowed; no minimum-duration policy invented here
  assert.equal(r.attendance.observedClockOutAt, D(12));
});

// =====================================================================
// ETR-2b — BREAK PATH (Freeze 003 §3 + prebuild design ruling). B1-B18 map to
// BRK-B* here to avoid name collision with the ETR-2a corrective B1-B9 family.
// =====================================================================
t('BRK-B1 break_start while working ALLOW', () => {
  const a = clockedIn(); // observedClockInAt = D(12)
  const r = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(13), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.breakState, 'on_break');
  assert.equal(r.attendance.openBreakStartedAt, D(13));
  assert.equal(r.attendance.breakCount, 0);       // no increment on start
  assert.equal(r.attendance.revision, 2);
  assert.equal(r.event.type, 'break_start');
});
t('BRK-B2 break_start before clock_in REJECT', () => {
  const r = startBreak({ actor: emp('ans-a1'), existing: null, scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'NO_ATTENDANCE');
});
t('BRK-B3 break_start after clock_out REJECT', () => {
  const a = clockedOut(); // status clocked_out
  const r = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'NOT_CLOCKED_IN');
});
t('BRK-B4 break_start while already on_break REJECT', () => {
  const a = onBreak();
  const r = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(14), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'BREAK_ALREADY_OPEN');
});
t('BRK-B5 break_end while working REJECT', () => {
  const a = clockedIn();
  const r = endBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(13), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'BREAK_NOT_OPEN');
});
t('BRK-B6 two sequential breaks ALLOW', () => {
  let a = onBreak();
  a = endBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(13, 10), POL).attendance;
  const s2 = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(15), POL);
  assert.ok(s2.ok, s2.code);
  const e2 = endBreak({ actor: emp('ans-a1'), existing: s2.attendance, scope: SCOPE }, D(15, 20), POL);
  assert.ok(e2.ok, e2.code);
  assert.equal(e2.attendance.breakCount, 2);
  assert.equal(e2.attendance.observedBreakMinutesTotal, 30);
});
t('BRK-B7 clock_out while break open REJECT', () => {
  const a = onBreak();
  const r = clockOut({ actor: emp('ans-a1'), existing: a, declaredEndAt: D(20), reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(20), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'BREAK_OPEN');
});
t('BRK-B8 break events preserve contiguous ordering in the attendance stream', () => {
  const ci = clockIn({ actor: emp('ans-a1'), shift: mkShift('ans-a1'), declaredStartAt: D(12), scope: SCOPE }, D(12), POL);
  const bs = startBreak({ actor: emp('ans-a1'), existing: ci.attendance, scope: SCOPE }, D(13), POL);
  const be = endBreak({ actor: emp('ans-a1'), existing: bs.attendance, scope: SCOPE }, D(13, 15), POL);
  const events = [ci.event, bs.event, be.event];
  assert.deepEqual(events.map((e) => e.revision), [1, 2, 3]);
  assert.equal(detectRevisionGaps(events).hasGap, false);
  for (const e of events) assert.equal(eventIdMatchesRevision(e), true);
  assert.deepEqual(events.map((e) => e.type), ['clock_in', 'break_start', 'break_end']);
});
t('BRK-B9 observedBreakMinutesTotal accumulates on each completed break_end', () => {
  let a = onBreak();
  a = endBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(13, 12), POL).attendance;
  assert.equal(a.observedBreakMinutesTotal, 12);
  assert.equal(a.breakCount, 1);
  a = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(15), POL).attendance;
  a = endBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(15, 8), POL).attendance;
  assert.equal(a.observedBreakMinutesTotal, 20);
  assert.equal(a.breakCount, 2);
});
t('BRK-B10 employee edit of an observed break projection fact REJECT', () => {
  const a = onBreak();
  for (const f of ['openBreakStartedAt', 'observedBreakMinutesTotal', 'breakState', 'breakCount']) {
    const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { [f]: 1 }, scope: SCOPE }, D(14), POL);
    assert.equal(r.ok, false, f); assert.ok(r.code.startsWith('FIELD_NOT_EDITABLE'), f);
  }
});
t('BRK-B11 manager edit of an observed break projection fact REJECT', () => {
  const a = onBreak();
  for (const f of ['openBreakStartedAt', 'observedBreakMinutesTotal', 'breakState', 'breakCount']) {
    const r = managerCorrection({ actor: admin(), existing: a, patch: { [f]: 1 }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(14), POL);
    assert.equal(r.ok, false, f); assert.ok(r.code.startsWith('FIELD_NOT_CORRECTABLE'), f);
  }
});
t('BRK-B12 client-supplied observed break start cannot replace injected now', () => {
  const a = clockedIn();
  const r = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE, observedBreakStartAt: D(9), openBreakStartedAt: D(9) }, D(13), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.openBreakStartedAt, D(13)); // forced to injected now
});
t('BRK-B13 declared break total within tolerance, no reason ALLOW', () => {
  const a = clockedOut();
  const r = declareBreak({ actor: emp('ans-a1'), existing: a, declaredBreakMinutesTotal: 33, scope: SCOPE }, D(21), POL); // |33-30|=3 <= 5
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.declaredBreakMinutesTotal, 33);
  assert.equal(r.event.type, 'employee_declaration');
});
t('BRK-B14 declared break total beyond tolerance, no reason REJECT', () => {
  const a = clockedOut();
  const r = declareBreak({ actor: emp('ans-a1'), existing: a, declaredBreakMinutesTotal: 45, scope: SCOPE }, D(21), POL); // |45-30|=15 > 5
  assert.equal(r.ok, false); assert.equal(r.code, 'REASON_REQUIRED');
});
t('BRK-B15 declared break total beyond tolerance with applicable break reason ALLOW', () => {
  const a = clockedOut();
  const r = declareBreak({ actor: emp('ans-a1'), existing: a, declaredBreakMinutesTotal: 45, reasonCode: 'EXTENDED_BREAK', scope: SCOPE }, D(21), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.declaredBreakMinutesTotal, 45);
});
t('BRK-B16 reason code not applicable to break REJECT', () => {
  const a = clockedOut();
  const r = declareBreak({ actor: emp('ans-a1'), existing: a, declaredBreakMinutesTotal: 45, reasonCode: 'FORGOT_CLOCK_IN', scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'REASON_REQUIRED');
});
t('BRK-B17 employee write to approvedBreakMinutesTotal REJECT', () => {
  const a = clockedOut();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { approvedBreakMinutesTotal: 30 }, scope: SCOPE }, D(21), POL);
  assert.equal(r.ok, false); assert.ok(r.code.startsWith('FIELD_NOT_EDITABLE'));
});
t('BRK-B18 breakMode none -> ALL break transitions unavailable at core level', () => {
  const pol = Object.assign({}, POL, { breakMode: 'none' });
  // startBreak disabled on a working attendance
  const a = clockedIn();
  const s = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(13), pol);
  assert.equal(s.ok, false); assert.equal(s.code, 'BREAK_DISABLED');
  // endBreak disabled even on an otherwise on-break attendance (set up under normal policy)
  const open = onBreak();
  const e = endBreak({ actor: emp('ans-a1'), existing: open, scope: SCOPE }, D(14), pol);
  assert.equal(e.ok, false); assert.equal(e.code, 'BREAK_DISABLED');
  // declareBreak disabled even on an otherwise declarable (clocked_out) attendance
  const done = clockedOut();
  const d = declareBreak({ actor: emp('ans-a1'), existing: done, declaredBreakMinutesTotal: 30, scope: SCOPE }, D(21), pol);
  assert.equal(d.ok, false); assert.equal(d.code, 'BREAK_DISABLED');
});

// ---- Break chronology / integrity (not new business policy) ----
t('BRK-chron non-finite openBreakStartedAt REJECT', () => {
  const a = Object.assign({}, onBreak(), { openBreakStartedAt: NaN });
  const r = endBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(14), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'OPEN_BREAK_NOT_FINITE');
});
t('BRK-chron endBreak now < openBreakStartedAt REJECT', () => {
  const a = onBreak(); // open at D(13)
  const r = endBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(12, 30), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'BREAK_END_BEFORE_START');
});
t('BRK-chron endBreak now === openBreakStartedAt ALLOW (zero-minute segment)', () => {
  const a = onBreak(); // open at D(13)
  const r = endBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(13), POL);
  assert.ok(r.ok, r.code);
  assert.equal(r.attendance.observedBreakMinutesTotal, 0);
  assert.equal(r.attendance.breakCount, 1);
});

// ---- Admin-only approved break total (counterpart of BRK-B17) ----
t('BRK-approved admin may set approvedBreakMinutesTotal; employee cannot', () => {
  const a = clockedOut();
  const ok1 = managerCorrection({ actor: admin(), existing: a, patch: { approvedBreakMinutesTotal: 30 }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(21), POL);
  assert.ok(ok1.ok, ok1.code);
  assert.equal(ok1.attendance.approvedBreakMinutesTotal, 30);
  const badVal = managerCorrection({ actor: admin(), existing: a, patch: { approvedBreakMinutesTotal: -5 }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE }, D(21), POL);
  assert.equal(badVal.ok, false); assert.equal(badVal.code, 'APPROVED_BREAK_INVALID');
  const empTry = employeeEdit({ actor: emp('ans-a1'), existing: a, patch: { approvedBreakMinutesTotal: 30 }, scope: SCOPE }, D(21), POL);
  assert.equal(empTry.ok, false); assert.ok(empTry.code.startsWith('FIELD_NOT_EDITABLE'));
});

// ---- Load-bearing multiple-break scenario (design-correction proof) ----
t('BRK-load 10+20 sequential breaks: no intermediate reason demand; totals + revisions correct', () => {
  let a = clockedIn(); // in D(12), revision 1
  a = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(13), POL).attendance;      // rev 2
  const e1 = endBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(13, 10), POL);        // rev 3, +10, NO reason demanded
  assert.ok(e1.ok, e1.code);
  a = e1.attendance;
  assert.equal(a.observedBreakMinutesTotal, 10);
  assert.equal(a.breakCount, 1);
  a = startBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(15), POL).attendance;      // rev 4
  const e2 = endBreak({ actor: emp('ans-a1'), existing: a, scope: SCOPE }, D(15, 20), POL);        // rev 5, +20
  assert.ok(e2.ok, e2.code);
  a = e2.attendance;
  assert.equal(a.observedBreakMinutesTotal, 30);
  assert.equal(a.breakCount, 2);
  const d = declareBreak({ actor: emp('ans-a1'), existing: a, declaredBreakMinutesTotal: 30, scope: SCOPE }, D(16), POL); // |30-30|=0, no reason
  assert.ok(d.ok, d.code);                     // rev 6
  assert.equal(d.attendance.declaredBreakMinutesTotal, 30);
  assert.equal(d.attendance.revision, 6);      // contiguous 1..6
});

// ---- Concurrency (DEFERRED to emulator; cannot be proven in fixtures) ----
t('CONC C38/C39/T28 deferred to emulator (documented, not asserted here)', () => {
  // Single-document write serialisation is a platform-behaviour claim that
  // fixtures cannot prove. Ruling 001 §5.2 / Ruling 002 C38-C39. Deferred.
  assert.ok(true);
});

console.log(lines.join('\n'));
console.log('\nEMPLOYEE_SHELL_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
