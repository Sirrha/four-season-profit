// attendance-exceptions.test.mjs — ATTENDANCE EXCEPTION law (owner law 2026-10-06): missing clock-in / clock-out,
// 6 h self-correction window from the PLANNED timestamps, locked shift date, durable shared notification with
// detected ≠ shown ≠ acknowledged ≠ corrected ≠ manager-resolved, manager close of an expired open attendance,
// overnight protection, and the fake-fs adapter flows. Node built-ins only. Run: node attendance-exceptions.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveAttendanceExceptions, exceptionIdFor, newExceptionRecord, applyExceptionTransition, exceptionAuditOf, exceptionStillApplicable,
  missedThresholdMs, selfCorrectionMs, EXCEPTION_STATUS, EXCEPTION_KEYS,
} from './attendance-exceptions-core.mjs';
import {
  ETR2A_POLICY as P, clockIn, clockOut, managerCloseOpenAttendance, managerCorrection, managerManualEntry, approve, daySummaryFor,
  tenantLocalHMToUtcMs, endOfTenantLocalDayUtcMs, selfCorrectionWindowMs, attendanceIdFor,
} from './employee-shell-core.mjs';
import { createProductionAdapters, createManagementScheduleAdapters, makeAttendanceCommitter, s4Path, S4_COLLECTIONS, ADAPTER_ERROR } from './employee-production-adapters.mjs';
import { createManagementAdapters } from './management-production-adapters.mjs';
import { clockInStateFor, ensureExceptionOnce, dayRowFactsFor, declaredByTag } from './employee-shell-ui.mjs';   // PRECLOSURE-POLISH-001 / FIX-003 pure helpers
import { buildPayrollPackage, accountantPayloadOf, sessionIdentitiesFor } from './management-payroll-core.mjs';
import { daysWithIdentity, managerCloseEligible, manualTargetFor } from './management-payroll-view.mjs';
import { FOUR_SEASON_CONTRACT_PROFILE } from './employee-schedule-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; const where = e && e.stack ? (String(e.stack).split('\n').find((l) => l.includes('attendance-exceptions.test')) || '').trim() : ''; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e) + (where ? ' @' + where : '')); } }

const TZ = 'Europe/Oslo', T = 'four-season-as';
const at = (wd, hm) => tenantLocalHMToUtcMs(wd, hm, TZ);
const WD = '2026-10-05', NX = '2026-10-06';
const EMP = 'Emp000000000000000001', ADMIN_ANS = 'Adm000000000000000001';
const emp = { uid: 'uid-emp', accessRole: 'employee', ansattId: EMP, accessEnabled: true, tenantId: T };
const adm = { uid: 'uid-adm', accessRole: 'admin', ansattId: ADMIN_ANS, accessEnabled: true, tenantId: T };
const H = 3600000, M = 60000;
// a day shift 13–17 (Athar's class, synthetic) and an overnight shift 22–03
const dayShift = (id, ansattId) => ({ shiftId: id, projection: { ansattId, workDate: WD, status: 'assigned', plannedStartAt: at(WD, '13:00'), plannedEndAt: at(WD, '17:00'), roleKey: null, revision: 1 } });
const nightShift = (id, ansattId) => ({ shiftId: id, projection: { ansattId, workDate: WD, status: 'assigned', plannedStartAt: at(WD, '22:00'), plannedEndAt: at(NX, '03:00'), roleKey: null, revision: 1 } });
const shiftObj = (s) => Object.assign({ shiftId: s.shiftId, tenantId: T }, s.projection);
const scope = (s) => ({ tenantId: T, shiftId: s.shiftId });
function clockedIn(s, hm, declaredHM) { const r = clockIn({ actor: emp, shift: shiftObj(s), existing: null, declaredStartAt: declaredHM ? at(WD, declaredHM) : undefined, reasonCode: 'LATE_ARRIVAL', reasonNote: null, scope: scope(s) }, at(WD, hm), P); assert.ok(r.ok, 'clockIn fixture: ' + r.code); return r.attendance; }
const lookupOf = (map) => (shiftId, ansattId) => map.get(attendanceIdFor(shiftId, ansattId)) || null;

// ======================= A. derivation =======================
await t('X01', 'policy law: EMPLOYEE_SELF_CORRECTION_HOURS = 6 as its own policy constant (selfCorrectionWindowMs = 6 h), SEPARATE from graceHours (also 6, the technical work-day boundary); the missed/overdue threshold REUSES the existing planned-time tolerance varianceToleranceMinutes = 15 min (no new magic interval)', () => {
  assert.equal(P.employeeSelfCorrectionHours, 6); assert.equal(selfCorrectionWindowMs(P), 6 * H); assert.equal(selfCorrectionMs(P), 6 * H);
  assert.equal(P.graceHours, 6); assert.ok('employeeSelfCorrectionHours' in P && 'graceHours' in P, 'two named laws');
  assert.equal(P.varianceToleranceMinutes, 15); assert.equal(missedThresholdMs(P), 15 * M);
  assert.equal(selfCorrectionWindowMs(Object.assign({}, P, { employeeSelfCorrectionHours: 2 })), 2 * H, 'the window follows its own constant, not graceHours');
});
await t('X02', 'MISSING_CLOCK_OUT derivation (day shift 13–17, clocked in 14:33): not applicable at 17:10 (inside the 15 min tolerance), applicable from 17:15; facts: type, ids, workDate, planned timestamps, effectiveAt = plannedEnd + 15 min, employeeCorrectionDeadlineAt = plannedEnd + 6 h = 23:00, selfCorrectionOpen true at 22:59 and false at 23:00, overnight false, nowValidForClock true until the work-day window end (06:00 next day); deterministic exception id; nothing applicable once the record is clocked out', () => {
  const s = dayShift('s1', EMP); const att = new Map([[attendanceIdFor('s1', EMP), clockedIn(s, '14:33')]]);
  const d = (hm, wd) => deriveAttendanceExceptions({ shifts: [s], lookup: lookupOf(att), nowMs: at(wd || WD, hm), policy: P });
  assert.equal(d('17:10').length, 0); assert.equal(d('17:14').length, 0);
  const [x] = d('17:15'); assert.ok(x);
  assert.equal(x.type, 'MISSING_CLOCK_OUT'); assert.equal(x.exceptionId, 'mco-s1_' + EMP); assert.equal(exceptionIdFor('MISSING_CLOCK_OUT', 's1', EMP), x.exceptionId);
  assert.equal(x.ansattId, EMP); assert.equal(x.shiftId, 's1'); assert.equal(x.workDate, WD); assert.equal(x.plannedStartAt, at(WD, '13:00')); assert.equal(x.plannedEndAt, at(WD, '17:00'));
  assert.equal(x.effectiveAt, at(WD, '17:15')); assert.equal(x.employeeCorrectionDeadlineAt, at(WD, '23:00')); assert.equal(x.overnight, false);
  assert.equal(x.selfCorrectionOpen, true); assert.equal(x.nowValidForClock, true); assert.equal(x.observedClockInAt, at(WD, '14:33'));
  assert.equal(d('22:59')[0].selfCorrectionOpen, true); assert.equal(d('23:00')[0].selfCorrectionOpen, false, 'deadline is exclusive: at 23:00 the window is closed');
  assert.equal(d('12:35', NX)[0].selfCorrectionOpen, false); assert.equal(d('12:35', NX)[0].nowValidForClock, false, 'next day 12:35: past the 06:00 work-day window too');
  assert.equal(d('05:59', NX)[0].nowValidForClock, true);
  const closed = Object.assign({}, att.get(attendanceIdFor('s1', EMP)), { status: 'clocked_out', observedClockOutAt: at(WD, '17:00'), declaredEndAt: at(WD, '17:00') });
  assert.equal(deriveAttendanceExceptions({ shifts: [s], lookup: () => closed, nowMs: at(NX, '12:00'), policy: P }).length, 0);
  assert.equal(exceptionStillApplicable({ type: 'MISSING_CLOCK_OUT' }, closed), false); assert.equal(exceptionStillApplicable({ type: 'MISSING_CLOCK_OUT' }, att.get(attendanceIdFor('s1', EMP))), true);
});
await t('X03', 'MISSING_CLOCK_IN derivation (planned 13:00, no attendance): not applicable before 13:15, applicable from 13:15 with deadline 19:00; selfCorrectionOpen flips at 19:00; a cancelled or open shift never yields an exception; once an attendance exists the missing-clock-in exception is gone', () => {
  const s = dayShift('s2', EMP);
  const d = (hm) => deriveAttendanceExceptions({ shifts: [s], lookup: () => null, nowMs: at(WD, hm), policy: P });
  assert.equal(d('13:14').length, 0); const [x] = d('13:15'); assert.ok(x);
  assert.equal(x.type, 'MISSING_CLOCK_IN'); assert.equal(x.exceptionId, 'mci-s2_' + EMP); assert.equal(x.effectiveAt, at(WD, '13:15')); assert.equal(x.employeeCorrectionDeadlineAt, at(WD, '19:00'));
  assert.equal(d('18:59')[0].selfCorrectionOpen, true); assert.equal(d('19:00')[0].selfCorrectionOpen, false);
  for (const st of ['cancelled', 'open']) assert.equal(deriveAttendanceExceptions({ shifts: [{ shiftId: 'c', projection: Object.assign({}, s.projection, { status: st }) }], lookup: () => null, nowMs: at(WD, '20:00'), policy: P }).length, 0, st);
  assert.equal(deriveAttendanceExceptions({ shifts: [s], lookup: () => clockedIn(s, '13:20'), nowMs: at(WD, '16:00'), policy: P }).length, 0, 'attendance exists -> no missing clock-in');
  assert.equal(exceptionStillApplicable({ type: 'MISSING_CLOCK_IN' }, null), true); assert.equal(exceptionStillApplicable({ type: 'MISSING_CLOCK_IN' }, { status: 'clocked_in' }), false);
});
// ======================= C. overnight =======================
await t('X04', 'OVERNIGHT (22:00–03:00 next day, workDate stays 2026-10-05): clocked in 22:00 — at 00:30 and 02:59 next day NOTHING is applicable (midnight alone is not a missing clock-out); applicable from 03:15; deadline = planned end + 6 h = 09:00 next day (measured from the planned timestamp, not from workDate midnight); overnight flag true; the technical work-day window (06:00 next day) stays a separate fact', () => {
  const s = nightShift('n1', EMP); const att = new Map([[attendanceIdFor('n1', EMP), clockedIn(s, '22:00')]]);
  const d = (wd, hm) => deriveAttendanceExceptions({ shifts: [s], lookup: lookupOf(att), nowMs: at(wd, hm), policy: P });
  assert.equal(d(NX, '00:30').length, 0); assert.equal(d(NX, '02:59').length, 0); assert.equal(d(NX, '03:14').length, 0);
  const [x] = d(NX, '03:15'); assert.ok(x); assert.equal(x.overnight, true); assert.equal(x.employeeCorrectionDeadlineAt, at(NX, '09:00')); assert.equal(x.workDayWindowEndAt, endOfTenantLocalDayUtcMs(WD, TZ, P.graceHours)); assert.equal(x.workDayWindowEndAt, at(NX, '06:00'));
  assert.equal(d(NX, '08:59')[0].selfCorrectionOpen, true); assert.equal(d(NX, '09:00')[0].selfCorrectionOpen, false);
  assert.equal(d(NX, '07:00')[0].nowValidForClock, false, 'between 06:00 and 09:00: "now" is outside the work-day window but the self-correction window is still open');
  // missing clock-in for an overnight shift: threshold 22:15, deadline 04:00 next day
  const [y] = deriveAttendanceExceptions({ shifts: [s], lookup: () => null, nowMs: at(WD, '22:15'), policy: P }); assert.equal(y.type, 'MISSING_CLOCK_IN'); assert.equal(y.employeeCorrectionDeadlineAt, at(NX, '04:00'));
});
// ======================= engine: the two boundaries =======================
await t('X05', 'ENGINE clock-out (day shift, clocked in 14:33): at 17:30 declared 17:00 ok (reason required for the deviation, FORGOT_CLOCK_OUT accepted); at 22:59 declared 17:00 + reason ok (just before the deadline); at 23:00 -> SELF_CORRECTION_EXPIRED (boundary exclusive at the deadline instant); at 12:35 next day -> SELF_CORRECTION_EXPIRED (the owner window refuses BEFORE the work-day check); declared 12:00 (before start) -> END_BEFORE_START; a successful correction keeps observedClockInAt and records the press instant as observedClockOutAt with the declared end apart (provenance preserved), one clock_out event', () => {
  const s = dayShift('s1', EMP); const a = clockedIn(s, '14:33');
  const co = (nowHm, decHm, reason, nowWd) => clockOut({ actor: emp, existing: a, declaredEndAt: decHm ? at(WD, decHm) : undefined, reasonCode: reason || null, reasonNote: null, scope: scope(s) }, at(nowWd || WD, nowHm), P);
  assert.equal(co('17:30', '17:00').code, 'REASON_REQUIRED'); const ok1 = co('17:30', '17:00', 'FORGOT_CLOCK_OUT'); assert.ok(ok1.ok, ok1.code);
  const late = co('22:59', '17:00', 'FORGOT_CLOCK_OUT'); assert.ok(late.ok, late.code);
  assert.equal(co('23:00', '17:00', 'FORGOT_CLOCK_OUT').code, 'SELF_CORRECTION_EXPIRED'); assert.equal(co('12:35', '17:00', 'FORGOT_CLOCK_OUT', NX).code, 'SELF_CORRECTION_EXPIRED');
  assert.equal(co('17:30', '12:00', 'FORGOT_CLOCK_OUT').code, 'END_BEFORE_START');
  assert.equal(ok1.attendance.observedClockInAt, a.observedClockInAt); assert.equal(ok1.attendance.observedClockOutAt, at(WD, '17:30')); assert.equal(ok1.attendance.declaredEndAt, at(WD, '17:00')); assert.equal(ok1.attendance.status, 'clocked_out'); assert.equal(ok1.attendance.revision, 2); assert.equal(ok1.event.type, 'clock_out'); assert.equal(ok1.event.reasonCode, 'FORGOT_CLOCK_OUT');
  assert.equal(ok1.attendance.workDate, WD); assert.equal(ok1.attendance.attendanceId, a.attendanceId); assert.equal(ok1.attendance.shiftId, 's1');
  assert.equal(clockOut({ actor: emp, existing: ok1.attendance, declaredEndAt: at(WD, '18:00'), reasonCode: 'FORGOT_CLOCK_OUT', scope: scope(s) }, at(WD, '18:00'), P).code, 'NOT_CLOCKED_IN', 'a second correction after close is refused');
});
await t('X06', 'ENGINE clock-in (planned 13:00, forgotten): at 15:00 declaring 13:00 + FORGOT_CLOCK_IN ok (observed press 15:00 kept apart from the declared start); at 18:59 ok; at 19:00 -> SELF_CORRECTION_EXPIRED; at 19:00 even an ordinary "now" clock-in is refused (owner law); a second clock-in on the same shift -> DUPLICATE_ATTENDANCE (one attendance per shift; identity fixed)', () => {
  const s = dayShift('s2', EMP);
  const ci = (nowHm, decHm) => clockIn({ actor: emp, shift: shiftObj(s), existing: null, declaredStartAt: decHm ? at(WD, decHm) : undefined, reasonCode: decHm ? 'FORGOT_CLOCK_IN' : null, scope: scope(s) }, at(WD, nowHm), P);
  const ok = ci('15:00', '13:00'); assert.ok(ok.ok, ok.code); assert.equal(ok.attendance.observedClockInAt, at(WD, '15:00')); assert.equal(ok.attendance.declaredStartAt, at(WD, '13:00')); assert.equal(ok.attendance.workDate, WD); assert.equal(ok.attendance.attendanceId, attendanceIdFor('s2', EMP)); assert.equal(ok.event.reasonCode, 'FORGOT_CLOCK_IN');
  assert.ok(ci('18:59', '13:00').ok); assert.equal(ci('19:00', '13:00').code, 'SELF_CORRECTION_EXPIRED'); assert.equal(ci('19:00').code, 'SELF_CORRECTION_EXPIRED');
  assert.equal(clockIn({ actor: emp, shift: shiftObj(s), existing: ok.attendance, declaredStartAt: at(WD, '13:00'), reasonCode: 'FORGOT_CLOCK_IN', scope: scope(s) }, at(WD, '15:30'), P).code, 'DUPLICATE_ATTENDANCE');
});
await t('X07', 'ENGINE overnight (22:00–03:00): ordinary clock-out at 03:00 next day (planned end) ok with no reason; forgotten: at 08:59 next day declared 03:00 + reason ok (window from the planned end 03:00 + 6 h = 09:00); at 09:00 -> SELF_CORRECTION_EXPIRED; at 07:00 declaring 07:00 ("now") -> DECLARED_OUTSIDE_WORKDATE (work-day/grace law 06:00 stays enforced separately, inside the still-open 6 h window)', () => {
  const s = nightShift('n1', EMP); const a = clockedIn(s, '22:00');
  const co = (wd, nowHm, decWd, decHm, reason) => clockOut({ actor: emp, existing: a, declaredEndAt: decHm ? at(decWd, decHm) : undefined, reasonCode: reason || null, reasonNote: null, scope: scope(s) }, at(wd, nowHm), P);
  const o1 = co(NX, '03:00'); assert.ok(o1.ok, o1.code);
  const o2 = co(NX, '08:59', NX, '03:00', 'FORGOT_CLOCK_OUT'); assert.ok(o2.ok, o2.code);
  assert.equal(co(NX, '09:00', NX, '03:00', 'FORGOT_CLOCK_OUT').code, 'SELF_CORRECTION_EXPIRED');
  assert.equal(co(NX, '07:00', NX, '07:00', 'FORGOT_CLOCK_OUT').code, 'DECLARED_OUTSIDE_WORKDATE');
});
// ======================= manager close =======================
await t('X08', 'MANAGER CLOSE of an expired open attendance (day shift, clocked in 14:33, declared 13:00; now 2026-10-06 12:35): employee role refused (ROLE_NOT_ALLOWED-class); admin with declared end 17:00 + break 30 + RETROACTIVE_ENTRY -> status attested, declarationSource manager, observedClockOutAt stays NULL (never fabricated), observedClockInAt and declaredStartAt preserved, identity/ansattId/shiftId/workDate unchanged, breakState working, revision 2, ONE manager_close event with changed {declaredEndAt, declaredBreakMinutesTotal, status}; refusals: end before start, end outside the work-day window (09:00 next day), missing reason, missing break, not clocked_in; an OPEN BREAK is closed by the act (break total declared by the manager); daySummaryFor reads the manager end (4 h declared minus break); approve() admits the result through its attested chain; managerCorrection cannot do this (status not correctable) and managerManualEntry refuses OEKT_PAAGAAR', () => {
  const s = dayShift('s1', EMP); const a = clockedIn(s, '14:33', '13:00'); const now = at(NX, '12:35');
  const close = (over, actor) => managerCloseOpenAttendance(Object.assign({ actor: actor || adm, existing: a, declaredEndAt: at(WD, '17:00'), declaredBreakMinutesTotal: 30, reasonCode: 'RETROACTIVE_ENTRY', reasonNote: null, scope: { tenantId: T } }, over || {}), now, P);
  assert.equal(close({}, emp).ok, false);
  const r = close(); assert.ok(r.ok, r.code);
  const b = r.attendance; assert.equal(b.status, 'attested'); assert.equal(b.declarationSource, 'manager'); assert.equal(b.observedClockOutAt, null); assert.equal(b.observedClockInAt, a.observedClockInAt); assert.equal(b.declaredStartAt, at(WD, '13:00')); assert.equal(b.declaredEndAt, at(WD, '17:00')); assert.equal(b.declaredBreakMinutesTotal, 30);
  assert.equal(b.attendanceId, a.attendanceId); assert.equal(b.ansattId, EMP); assert.equal(b.shiftId, 's1'); assert.equal(b.workDate, WD); assert.equal(b.breakState, 'working'); assert.equal(b.openBreakStartedAt, null); assert.equal(b.revision, 2);
  assert.equal(r.event.type, 'manager_close'); assert.deepEqual(Object.keys(r.event.changed).sort(), ['declaredBreakMinutesTotal', 'declaredEndAt', 'status']); assert.deepEqual(r.event.changed.status, { before: 'clocked_in', after: 'attested' }); assert.equal(r.event.reasonCode, 'RETROACTIVE_ENTRY');
  assert.equal(close({ declaredEndAt: at(WD, '12:00') }).code, 'END_BEFORE_START'); assert.equal(close({ declaredEndAt: at(NX, '09:00') }).code, 'DECLARED_OUTSIDE_WORKDATE'); assert.equal(close({ reasonCode: null }).code, 'REASON_REQUIRED'); assert.equal(close({ declaredBreakMinutesTotal: null }).code, 'DECLARED_BREAK_INVALID'); assert.equal(close({ declaredBreakMinutesTotal: 300 }).code, 'BREAK_EXCEEDS_SPAN');
  assert.equal(close({ existing: b }).code, 'NOT_CLOCKED_IN');
  const onBreak = Object.assign({}, a, { breakState: 'on_break', openBreakStartedAt: at(WD, '16:00') }); const rb = close({ existing: onBreak }); assert.ok(rb.ok, rb.code); assert.equal(rb.attendance.breakState, 'working'); assert.equal(rb.attendance.openBreakStartedAt, null);
  const ds = daySummaryFor({ attendance: b }); assert.equal(ds.end.at, at(WD, '17:00')); assert.equal(ds.end.source, 'declared'); assert.equal(ds.start.at, at(WD, '13:00')); assert.deepEqual([ds.total.hours, ds.total.mins, ds.total.deductionMinutes], [3, 30, 30]);
  const ap = approve({ actor: adm, existing: b, approvedStartAt: at(WD, '13:00'), approvedEndAt: at(WD, '17:00'), scope: { tenantId: T } }, now, P); assert.ok(ap.ok, ap.code); assert.equal(ap.attendance.status, 'approved');
  assert.equal(managerCorrection({ actor: adm, existing: a, patch: { status: 'attested' }, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: T } }, now, P).code, 'FIELD_NOT_CORRECTABLE:status');
  assert.equal(managerManualEntry({ actor: adm, existing: a, shift: null, ansattId: EMP, workDate: WD, declaredStartAt: at(WD, '13:00'), declaredEndAt: at(WD, '17:00'), declaredBreakMinutesTotal: 30, employment: { startDate: '2020-01-01', endDate: null }, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: T } }, now, P).code, 'OEKT_PAAGAAR');
});
await t('X09', 'PAYROLL reads the manager-closed day: no "Åpen økt" any more, the day has a total (3 h 30), the payload marks closedByManager true (and fortAvLedelse false since the employee clock-in is observed), while an ordinary clocked_out day and a manual (attested, no observed) day keep closedByManager false', () => {
  const s = dayShift('s1', EMP); const a = clockedIn(s, '14:33', '13:00');
  const closed = managerCloseOpenAttendance({ actor: adm, existing: a, declaredEndAt: at(WD, '17:00'), declaredBreakMinutesTotal: 30, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: T } }, at(NX, '12:35'), P).attendance;
  const employeeStore = { [T]: { [EMP]: { ansattId: EMP, name: 'Synthetic Employee', status: 'active', endedAt: null, terms: [{ validFrom: '2026-01-01', role: 'butikkmedarbeider', compensation: { model: 'timelonn', hourlyRate: 200 } }], documents: [] } } };
  const pkg = (att) => buildPayrollPackage({ employeeStore, scheduleStore: { [T]: {} }, attendanceStore: new Map([[att.attendanceId, att]]), tenantId: T, periodId: '2026-10', generatedAt: 1, todayWorkDate: NX });
  const open = pkg(a).rows[0]; assert.ok(open.exceptions.some((x) => x.code === 'aapen_oekt')); assert.equal(open.payload.days[0].minutes, null);
  const done = pkg(closed).rows[0]; assert.ok(!done.exceptions.some((x) => x.code === 'aapen_oekt' || x.code === 'dag_uten_svar')); assert.equal(done.payload.days[0].minutes, 210); assert.equal(done.payload.days[0].closedByManager, true); assert.equal(done.payload.days[0].fortAvLedelse, false);
  const ordinary = clockOut({ actor: emp, existing: a, declaredEndAt: at(WD, '17:00'), reasonCode: 'FORGOT_CLOCK_OUT', scope: scope(s) }, at(WD, '17:30'), P).attendance; assert.equal(pkg(ordinary).rows[0].payload.days[0].closedByManager, false);
});
// ======================= D. durable record law =======================
await t('X10', 'RECORD LAW: newExceptionRecord carries exactly the documented keys; detectedByRole names the surface (employee / admin) and says nothing about shown; transitions are write-once and monotonic: shown twice -> ALREADY_SHOWN (first timestamp never moves); acknowledged before shown -> NOT_SHOWN_YET; acknowledged twice -> ALREADY_ACKNOWLEDGED; corrected inside the window ok, at the deadline -> SELF_CORRECTION_EXPIRED, after corrected -> NOT_OPEN; manager_seen write-once; manager_resolved needs admin + resolution and only from open; an employee cannot act on another employee\'s record; audit reading keeps every fact apart', () => {
  const s = dayShift('s1', EMP); const [x] = deriveAttendanceExceptions({ shifts: [s], lookup: lookupOf(new Map([[attendanceIdFor('s1', EMP), clockedIn(s, '14:33')]])), nowMs: at(WD, '17:20'), policy: P });
  const rec = newExceptionRecord(x, { actor: emp, now: at(WD, '17:20') });
  assert.deepEqual(Object.keys(rec).sort(), [...EXCEPTION_KEYS].sort()); assert.equal(rec.status, 'open'); assert.equal(rec.revision, 1); assert.equal(rec.detectedByRole, 'employee'); assert.equal(rec.firstShownToEmployeeAt, null); assert.equal(rec.employeeCorrectionDeadlineAt, at(WD, '23:00'));
  assert.equal(newExceptionRecord(x, { actor: adm, now: 1 }).detectedByRole, 'admin');
  const a0 = exceptionAuditOf(rec); assert.deepEqual(a0, { detected: true, shown: false, acknowledged: false, corrected: false, managerSeen: false, managerResolved: false, active: true });
  assert.equal(applyExceptionTransition({ record: rec, kind: 'acknowledged', actor: emp, now: at(WD, '17:21') }).code, 'NOT_SHOWN_YET');
  const sh = applyExceptionTransition({ record: rec, kind: 'shown', actor: emp, now: at(WD, '17:21') }); assert.ok(sh.ok); assert.equal(sh.record.firstShownToEmployeeAt, at(WD, '17:21')); assert.equal(sh.record.revision, 2); assert.equal(sh.event.type, 'shown'); assert.equal(sh.event.eventId, rec.exceptionId + '-rev-000002');
  assert.equal(applyExceptionTransition({ record: sh.record, kind: 'shown', actor: emp, now: at(WD, '18:00') }).code, 'ALREADY_SHOWN');
  assert.deepEqual(exceptionAuditOf(sh.record).shown, true); assert.equal(exceptionAuditOf(sh.record).acknowledged, false, 'shown is not acknowledged');
  const other = { uid: 'u2', accessRole: 'employee', ansattId: 'Other00000000000000001', accessEnabled: true, tenantId: T };
  assert.equal(applyExceptionTransition({ record: sh.record, kind: 'acknowledged', actor: other, now: at(WD, '18:00') }).code, 'NOT_OWN_EXCEPTION');
  const ak = applyExceptionTransition({ record: sh.record, kind: 'acknowledged', actor: emp, now: at(WD, '18:00') }); assert.ok(ak.ok); assert.equal(ak.record.acknowledgedByEmployeeAt, at(WD, '18:00')); assert.equal(ak.event.type, 'acknowledged');
  assert.equal(applyExceptionTransition({ record: ak.record, kind: 'acknowledged', actor: emp, now: at(WD, '18:01') }).code, 'ALREADY_ACKNOWLEDGED');
  assert.equal(exceptionAuditOf(ak.record).corrected, false, 'acknowledged is not corrected');
  assert.equal(applyExceptionTransition({ record: ak.record, kind: 'corrected', actor: emp, now: at(WD, '23:00') }).code, 'SELF_CORRECTION_EXPIRED');
  const co = applyExceptionTransition({ record: ak.record, kind: 'corrected', actor: emp, now: at(WD, '18:05') }); assert.ok(co.ok); assert.equal(co.record.status, 'corrected'); assert.equal(co.record.correctionSource, 'employee'); assert.equal(exceptionAuditOf(co.record).active, false);
  assert.equal(applyExceptionTransition({ record: co.record, kind: 'corrected', actor: emp, now: at(WD, '18:06') }).code, 'NOT_OPEN'); assert.equal(applyExceptionTransition({ record: co.record, kind: 'manager_resolved', actor: adm, now: 1, resolution: 'x' }).code, 'NOT_OPEN');
  assert.equal(exceptionAuditOf(co.record).managerResolved, false, 'corrected is not manager-approved/resolved');
  assert.equal(applyExceptionTransition({ record: rec, kind: 'manager_seen', actor: emp, now: 1 }).code, 'NOT_ADMIN');
  const seen = applyExceptionTransition({ record: rec, kind: 'manager_seen', actor: adm, now: at(WD, '18:30') }); assert.ok(seen.ok); assert.equal(seen.record.managerSeenByUid, 'uid-adm'); assert.equal(applyExceptionTransition({ record: seen.record, kind: 'manager_seen', actor: adm, now: 2 }).code, 'ALREADY_SEEN');
  assert.equal(applyExceptionTransition({ record: seen.record, kind: 'manager_resolved', actor: adm, now: 3 }).code, 'RESOLUTION_REQUIRED');
  const res = applyExceptionTransition({ record: seen.record, kind: 'manager_resolved', actor: adm, now: at(NX, '12:40'), resolution: 'manager_close' }); assert.ok(res.ok); assert.equal(res.record.status, 'resolved_by_manager'); assert.equal(exceptionAuditOf(res.record).active, false); assert.equal(exceptionAuditOf(res.record).shown, false, 'audit still readable: never shown to the employee');
  assert.equal(applyExceptionTransition({ record: rec, kind: 'nonsense', actor: adm, now: 1 }).code, 'UNKNOWN_TRANSITION');
});

// ======================= adapters (fake fs) =======================
function makeFakeFs() {
  const docs = new Map(); const writes = [];
  const apply = (w) => { for (const [kind, p, d] of w) { writes.push({ kind, path: p, data: JSON.parse(JSON.stringify(d)) }); if (kind === 'set') docs.set(p, JSON.parse(JSON.stringify(d))); else { if (!docs.has(p)) throw Object.assign(new Error('not-found'), { code: 'not-found' }); docs.set(p, Object.assign({}, docs.get(p), JSON.parse(JSON.stringify(d)))); } } };
  const listeners = [];
  const api = {
    doc: (p) => ({ path: p }), serverTimestamp: () => ({ __st: true }), newId: () => 'AuToId00000000000001',
    listen: (spec, onDocs) => { listeners.push({ spec, onDocs }); return () => {}; },
    runTransaction: async (fn) => { const w = []; const tx = { get: async (ref) => ({ exists: docs.has(ref.path), data: docs.get(ref.path) }), set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]) }; const r = await fn(tx); apply(w); return r; },
    batch: () => { const w = []; return { set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]), commit: async () => { apply(w); } }; },
  };
  const emit = () => { for (const l of listeners) { const col = l.spec.col; const out = []; for (const [p, d] of docs) if (col && p.startsWith(col + '/') && p.split('/').length === col.split('/').length + 1) out.push({ id: p.split('/').pop(), exists: true, data: d }); if (col) l.onDocs(out); } };
  return { api, docs, writes, listeners, emit, seed: (p, d) => docs.set(p, JSON.parse(JSON.stringify(d))) };
}
const X = (id) => s4Path(T, 'attendanceExceptions', id);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const membEmp = { uid: 'uid-emp', tenantId: T, accessRole: 'employee', ansattId: EMP, accessEnabled: true };
const membAdm = { uid: 'uid-adm', tenantId: T, accessRole: 'admin', ansattId: ADMIN_ANS, accessEnabled: true };

await t('X11', 'ADAPTER (employee): ensure() creates the durable record ONCE (second call: created false, no write; 1 detected event); markShown is write-once (second -> CORE_REFUSED exception:ALREADY_SHOWN, no write); acknowledge requires shown first and is write-once; every write stays under attendanceExceptions (+events); the record carries the derived planned facts and the deadline; s4Path refuses any other collection', async () => {
  assert.deepEqual([...S4_COLLECTIONS], ['shifts', 'attendance', 'employeeSelf', 'attendanceExceptions']);
  const F = makeFakeFs(); const A = createProductionAdapters({ fs: F.api, tenantId: T, membership: membEmp, policy: P, isCurrent: () => true, nowMs: () => at(WD, '17:20') }); A.start();
  const s = dayShift('s1', EMP); const [x] = deriveAttendanceExceptions({ shifts: [s], lookup: () => clockedIn(s, '14:33'), nowMs: at(WD, '17:20'), policy: P });
  const r1 = await A.exceptions.ensure(x, at(WD, '17:20')); assert.equal(r1.created, true); assert.equal(F.writes.length, 2); assert.equal(F.writes[0].path, X(x.exceptionId)); assert.equal(F.writes[1].path, X(x.exceptionId) + '/events/' + x.exceptionId + '-rev-000001'); assert.equal(F.writes[1].data.type, 'detected');
  const stored = F.docs.get(X(x.exceptionId)); assert.equal(stored.plannedEndAt, at(WD, '17:00')); assert.equal(stored.employeeCorrectionDeadlineAt, at(WD, '23:00')); assert.equal(stored.firstShownToEmployeeAt, null); assert.deepEqual(stored.serverCreatedAt, { __st: true });
  const r2 = await A.exceptions.ensure(x, at(WD, '17:25')); assert.equal(r2.created, false); assert.equal(F.writes.length, 2, 'idempotent: no second write');
  assert.match((await rejects(A.exceptions.acknowledge(x.exceptionId, at(WD, '17:26')))).message, /exception:NOT_SHOWN_YET$/); assert.equal(F.writes.length, 2);
  const sh = await A.exceptions.markShown(x.exceptionId, at(WD, '17:30')); assert.equal(sh.record.firstShownToEmployeeAt, at(WD, '17:30')); assert.equal(F.writes.length, 4); assert.equal(F.writes[3].data.type, 'shown');
  const e2 = await rejects(A.exceptions.markShown(x.exceptionId, at(WD, '18:00'))); assert.equal(e2.code, ADAPTER_ERROR.CORE_REFUSED); assert.match(e2.message, /exception:ALREADY_SHOWN$/); assert.equal(F.writes.length, 4); assert.equal(F.docs.get(X(x.exceptionId)).firstShownToEmployeeAt, at(WD, '17:30'), 'first shown never moved');
  const ak = await A.exceptions.acknowledge(x.exceptionId, at(WD, '18:05')); assert.equal(ak.record.acknowledgedByEmployeeAt, at(WD, '18:05')); assert.match((await rejects(A.exceptions.acknowledge(x.exceptionId, 1))).message, /exception:ALREADY_ACKNOWLEDGED$/);
  assert.ok(F.writes.every((w) => w.path.startsWith(s4Path(T, 'attendanceExceptions') + '/')));
  assert.throws(() => s4Path(T, 'notifications', 'x'), (e) => e.code === ADAPTER_ERROR.PATH_FORBIDDEN);
  F.emit(); assert.ok(A.exceptions.get(x.exceptionId), 'own listener mirrors the record'); A.dispose();
});
await t('X12', 'ADAPTER (employee): the forgotten-clock-out correction and the exception "corrected" transition are ONE transaction — attendance update + clock_out event + exception update + corrected event, all written together; the exception becomes corrected with correctionSource employee; an attempt after the deadline is refused by the engine before anything is written; the forgotten-clock-in backfill (creation) carries the MISSING_CLOCK_IN correction in the same transaction too', async () => {
  const F = makeFakeFs(); const A = createProductionAdapters({ fs: F.api, tenantId: T, membership: membEmp, policy: P, isCurrent: () => true, nowMs: () => at(WD, '17:30') }); A.start();
  const s = dayShift('s1', EMP); const a = clockedIn(s, '14:33'); F.seed(s4Path(T, 'attendance', a.attendanceId), a);
  const [x] = deriveAttendanceExceptions({ shifts: [s], lookup: () => a, nowMs: at(WD, '17:30'), policy: P }); await A.exceptions.ensure(x, at(WD, '17:20'));
  const w0 = F.writes.length;
  const res = clockOut({ actor: emp, existing: a, declaredEndAt: at(WD, '17:00'), reasonCode: 'FORGOT_CLOCK_OUT', scope: scope(s) }, at(WD, '17:30'), P); assert.ok(res.ok);
  const c = await A.attendance.commit(res, { exception: { exceptionId: x.exceptionId, kind: 'corrected', actor: emp } });
  assert.equal(c.ok, true); assert.equal(c.exception.status, 'corrected');
  const paths = F.writes.slice(w0).map((w) => w.path); assert.equal(paths.length, 4);
  assert.ok(paths.includes(s4Path(T, 'attendance', a.attendanceId)) && paths.includes(s4Path(T, 'attendance', a.attendanceId) + '/events/' + res.event.eventId) && paths.includes(X(x.exceptionId)) && paths.some((p) => p.startsWith(X(x.exceptionId) + '/events/')));
  assert.equal(F.docs.get(s4Path(T, 'attendance', a.attendanceId)).status, 'clocked_out'); assert.equal(F.docs.get(X(x.exceptionId)).status, 'corrected'); assert.equal(F.docs.get(X(x.exceptionId)).correctionSource, 'employee');
  // expired: engine refuses, nothing written
  const F2 = makeFakeFs(); const A2 = createProductionAdapters({ fs: F2.api, tenantId: T, membership: membEmp, policy: P, isCurrent: () => true }); A2.start();
  const late = clockOut({ actor: emp, existing: a, declaredEndAt: at(WD, '17:00'), reasonCode: 'FORGOT_CLOCK_OUT', scope: scope(s) }, at(NX, '12:35'), P); assert.equal(late.code, 'SELF_CORRECTION_EXPIRED');
  const e = await rejects(A2.attendance.commit(late, {})); assert.equal(e.code, ADAPTER_ERROR.CORE_REFUSED); assert.equal(F2.writes.length, 0);
  // missing clock-in backfill: creation + exception correction in one transaction
  const s2 = dayShift('s2', EMP); const [mci] = deriveAttendanceExceptions({ shifts: [s2], lookup: () => null, nowMs: at(WD, '15:00'), policy: P }); await A2.exceptions.ensure(mci, at(WD, '14:00'));
  const w1 = F2.writes.length;
  const ci = clockIn({ actor: emp, shift: shiftObj(s2), existing: null, declaredStartAt: at(WD, '13:00'), reasonCode: 'FORGOT_CLOCK_IN', scope: scope(s2) }, at(WD, '15:00'), P); assert.ok(ci.ok, ci.code);
  const c2 = await A2.attendance.commit(ci, { create: true, exception: { exceptionId: mci.exceptionId, kind: 'corrected', actor: emp } });
  assert.equal(c2.ok, true); assert.equal(F2.writes.length - w1, 4); assert.equal(F2.docs.get(X(mci.exceptionId)).status, 'corrected'); assert.equal(F2.docs.get(s4Path(T, 'attendance', ci.attendance.attendanceId)).status, 'clocked_in');
  A.dispose(); A2.dispose();
});
await t('X13', 'ADAPTER (management): the manager reads the SAME exception record (bounded listener); ensure() by the admin marks detectedByRole admin; markSeen is write-once; the manager close commits attendance + manager_close event + exception manager_resolved + its event in ONE transaction (resolution manager_close); afterwards the exception is no longer active but its audit stays readable (never shown / never acknowledged are still true facts)', async () => {
  const F = makeFakeFs(); const s = dayShift('s1', EMP); const a = clockedIn(s, '14:33', '13:00'); F.seed(s4Path(T, 'attendance', a.attendanceId), a);
  const M = createManagementAdapters({ fs: F.api, tenantId: T, membership: membAdm, range: { from: '2026-10-01', to: '2026-10-31' }, readAnsatte: () => [], defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: P, nowMs: () => at(NX, '12:35') }); M.start();
  assert.ok(F.listeners.some((l) => l.spec.col === s4Path(T, 'attendanceExceptions')), 'manager listener on the exceptions collection');
  const [x] = deriveAttendanceExceptions({ shifts: [s], lookup: () => a, nowMs: at(NX, '12:35'), policy: P }); assert.equal(x.selfCorrectionOpen, false);
  const r = await M.exceptions.ensure(x, at(NX, '12:35')); assert.equal(r.created, true); assert.equal(r.record.detectedByRole, 'admin');
  F.emit(); assert.ok(M.exceptions.get(x.exceptionId));
  await M.exceptions.markSeen(x.exceptionId, at(NX, '12:36')); assert.equal(F.docs.get(X(x.exceptionId)).managerSeenByUid, 'uid-adm'); assert.match((await rejects(M.exceptions.markSeen(x.exceptionId, 1))).message, /exception:ALREADY_SEEN$/);
  const w0 = F.writes.length;
  const close = managerCloseOpenAttendance({ actor: adm, existing: a, declaredEndAt: at(WD, '17:00'), declaredBreakMinutesTotal: 30, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: T } }, at(NX, '12:40'), P); assert.ok(close.ok, close.code);
  const c = await M.attendance.commit(close, { exception: { exceptionId: x.exceptionId, kind: 'manager_resolved', actor: adm, resolution: 'manager_close' } });
  assert.equal(c.ok, true); assert.equal(F.writes.length - w0, 4);
  const att = F.docs.get(s4Path(T, 'attendance', a.attendanceId)); assert.equal(att.status, 'attested'); assert.equal(att.observedClockOutAt, null); assert.equal(att.declaredEndAt, at(WD, '17:00'));
  const ex = F.docs.get(X(x.exceptionId)); assert.equal(ex.status, 'resolved_by_manager'); assert.equal(ex.resolution, 'manager_close'); assert.equal(ex.managerResolvedByUid, 'uid-adm');
  const audit = exceptionAuditOf(ex); assert.deepEqual(audit, { detected: true, shown: false, acknowledged: false, corrected: false, managerSeen: true, managerResolved: true, active: false });
  assert.equal(exceptionStillApplicable(ex, att), false);
  M.dispose();
});
await t('X14', '(static) UI + rules wiring: employee page renders the exception cards from the same derivation (never a second truth), suppresses the ordinary STEMPLE UT once overdue, locks the date in the correction dialog, maps the two owner-law codes to plain Norwegian (no raw DECLARED_OUTSIDE_WORKDATE / SELF_CORRECTION_EXPIRED to the employee); "shown" is written once and acknowledgement only by the explicit button; Oversikt names the employee + shift + audit facts; the payroll view offers "Avslutt vakt (ledelse)" only for an open session past the overdue threshold passed in as a prop (import fence intact); rules: 6 h bounds on self clock-in/out, admClose + manager_close event, attendanceExceptions block with employee own-only writes and admin seen/resolve', () => {
  const ui = fs.readFileSync(path.join(HERE, 'employee-shell-ui.mjs'), 'utf8');
  assert.ok(ui.includes("const exceptions = deriveAttendanceExceptions({ shifts, lookup: (shiftId) => lookup(shiftId), nowMs, policy: POLICY });"));
  assert.ok(ui.includes("text: heroException ? 'Vakt ikke avsluttet' : hero.ongoingFromPriorDay ? 'Pågående vakt'"));
  assert.ok(ui.includes("} else if (att && att.status === 'clocked_in' && heroException) {"));
  assert.ok(ui.includes("'Vaktens dato: ' + fmtDayShort(ex.workDate) + ' (kan ikke endres)'") && ui.includes("'Dato: ' + fmtDayShort(shift.workDate) + ' (låst – kun klokkeslettet kan endres).'"));
  assert.ok(ui.includes("btn('Jeg glemte å stemple ut', 'primary'") && ui.includes("presetReason: 'FORGOT_CLOCK_OUT'") && ui.includes("btn('Jeg glemte å stemple inn', 'primary'") && ui.includes("presetReason: 'FORGOT_CLOCK_IN'"));
  assert.ok(ui.includes("if (ex.nowValidForClock) acts.appendChild(btn('Jeg jobber fortsatt – stemple ut nå'"));
  assert.ok(ui.includes("case 'SELF_CORRECTION_EXPIRED': return 'Fristen for å rette dette selv har gått ut (6 timer etter planlagt tid). Ledelsen må registrere dette.';") && ui.includes("case 'DECLARED_OUTSIDE_WORKDATE': return 'Tidspunktet ligger utenfor arbeidsdagen"));
  assert.ok(!ui.includes("errBox.textContent = 'Kunne ikke registrere: ' + res.code;\n      }\n    }, () => goToday(membership));\n  }\n\n  // ETR-2b"), 'the clock dialog no longer prints raw codes');
  assert.ok(ui.includes("btn('Jeg har sett dette', 'secondary ax-ack'") && ui.includes('exceptionSeam.acknowledge(ex.exceptionId)'));
  assert.equal(ui.split('exceptionSeam.markShown(').length - 1, 1, 'shown is written from ONE guarded helper (markShownOnce) in the card renderer'); assert.ok(ui.includes('SHOWN_IN_FLIGHT') && ui.includes('const markShownOnce = () =>'));
  assert.ok(ui.includes("(x.type === 'MISSING_CLOCK_OUT' ? 'ikke stemplet ut etter vakt ' : 'mangler innstempling ')") && ui.includes("'Vist for ansatt' : 'Ikke vist for ansatt ennå'") && ui.includes("'bekreftet av ansatt' : 'ikke bekreftet'"));
  assert.ok(ui.includes("if (form && form.mode === 'close') return submitManagerClose(form);") && ui.includes("kind: 'manager_resolved', actor: MGR.actor, resolution: 'manager_close'") && ui.includes("resolution: 'manager_manual_entry'"));
  const view = fs.readFileSync(path.join(HERE, 'management-payroll-view.mjs'), 'utf8');
  assert.ok(view.includes('if (managerCloseEligible(day, nowMs, overdueAfterMs)) {') && view.includes("btn('Avslutt vakt (ledelse)' + who"), 'close action decided per session by the pure predicate');
  assert.ok(!view.includes('Math.max(...u.planned.map((p) => p.endAt))'), 'MULTISESSION law: the day row maximum planned end is no authority for any session any more');
  assert.ok(!/attendance-exceptions-core|ETR2A_POLICY/.test(view), 'payroll view import fence intact');
  assert.ok(view.includes("'Avsluttet av ledelse'") && view.includes("if (day.closedByManager) return 'Slutt oppgitt av ledelse';"));
  const rules = fs.readFileSync(path.join(HERE, 'firestore.s4.candidate.rules'), 'utf8');
  assert.ok(rules.includes('&& n.updatedAt < o.plannedSnapshot.endAt + 21600000') && rules.includes('&& n.createdAt < shift.plannedStartAt + 21600000'));
  assert.ok(rules.includes('function admClose(n, o) {') && rules.includes("(admCorrection(n, o) || admApprove(n, o) || admClose(n, o))") && rules.includes("(e.type == 'manager_close' && admOk(e, mrole, mans)"));
  assert.ok(rules.includes('match /attendanceExceptions/{exceptionId} {') && rules.includes('d.employeeCorrectionDeadlineAt == planned(d) + 21600000') && rules.includes('d.effectiveAt == planned(d) + 900000') && rules.includes('function xShown(n, o)') && rules.includes('function xAck(n, o)') && rules.includes('function xCorrected(n, o)') && rules.includes('function xSeen(n, o)') && rules.includes('function xResolved(n, o)'));
  assert.ok(rules.includes("allow update: if isSelfActor(tenantId) && resource.data.ansattId == myAnsattId(tenantId) && xShape(request.resource.data)\n          && (xShown(request.resource.data, resource.data) || xAck(request.resource.data, resource.data) || xCorrected(request.resource.data, resource.data));"), 'employee updates: own, and only the three write-once facts (the changed-keys fence keeps identity, planned times, deadline and manager fields immutable)');
});

// ================= MULTISESSION MANAGER-CLOSE TARGETING (owner safety law 2026-10-06) =================
// The REAL defect shape: TWO OPEN attendances on ONE workDate (S5 expired missing clock-out 02:28–06:28, S2 the live shift
// 13:28–19:28), one already clocked-out session, a planned-only shift and a FUTURE OVERNIGHT shift (22:00–03:00) on the same day.
const MS_WD = NX;   // 2026-10-06
const msShift = (id, ansattId, from, to, nextDayEnd) => ({ shiftId: id, projection: { ansattId, workDate: MS_WD, status: 'assigned', plannedStartAt: at(MS_WD, from), plannedEndAt: at(nextDayEnd ? '2026-10-07' : MS_WD, to), roleKey: null, revision: 1 } });
const MS = { s5: msShift('ax-s5', EMP, '02:28', '06:28'), s3: msShift('ax-s3', EMP, '05:28', '07:28'), s4: msShift('ax-s4', EMP, '07:28', '13:28'), s2: msShift('ax-s2', EMP, '13:28', '19:28'), s6: msShift('ax-s6', EMP, '22:00', '03:00', true) };
function msOpen(sh, hm) { const r = clockIn({ actor: emp, shift: shiftObj(sh), existing: null, declaredStartAt: undefined, reasonCode: 'LATE_ARRIVAL', reasonNote: null, scope: scope(sh) }, at(MS_WD, hm), P); assert.ok(r.ok, 'ms clockIn: ' + r.code); return r.attendance; }
function msClosed(sh, inHM, outHM) { const a = msOpen(sh, inHM); const r = clockOut({ actor: emp, existing: a, declaredEndAt: undefined, reasonCode: 'FORGOT_CLOCK_OUT', reasonNote: null, scope: scope(sh) }, at(MS_WD, outHM), P); assert.ok(r.ok, 'ms clockOut: ' + r.code); return r.attendance; }
const MS_NOW = at(MS_WD, '17:50');   // the owner's review instant: S5 overdue by hours, S2 live, S6 not yet started
const msStore = () => { const m = new Map(); for (const a of [msOpen(MS.s2, '15:28'), msClosed(MS.s4, '07:58', '15:28'), msOpen(MS.s5, '03:28')]) m.set(a.attendanceId, a); return m; };
const msEmployeeStore = { [T]: { [EMP]: { ansattId: EMP, name: 'Synthetic Employee', status: 'active', endedAt: null, terms: [{ validFrom: '2026-01-01', role: 'butikkmedarbeider', compensation: { model: 'timelonn', hourlyRate: 200 } }], documents: [] } } };
const msSchedule = () => ({ [T]: Object.fromEntries(Object.values(MS).map((x) => [x.shiftId, x.projection])) });
const PAYLOAD_DAY_KEYS = ['workDate', 'startAt', 'startSource', 'endAt', 'endSource', 'breakRow', 'anyDeclared', 'minutes', 'hours', 'label', 'recordApproved', 'declarationSource', 'fortAvLedelse', 'closedByManager', 'exceptions'];

await t('X15', 'CORE identity: sessionIdentitiesFor yields one exact identity per actual session (attendanceId, shiftId, status, workDate, OWN plannedSnapshot.endAt) in the SAME order as payload.days; payload.days keeps exactly its 15 frozen keys, the accountant payload and the package rows carry no identity field (no contract drift)', () => {
  const store = msStore();
  const pkg = buildPayrollPackage({ employeeStore: msEmployeeStore, scheduleStore: msSchedule(), attendanceStore: store, tenantId: T, periodId: '2026-10', generatedAt: 1, todayWorkDate: MS_WD });
  const row = pkg.rows.find((r) => r.ansattId === EMP); assert.equal(row.payload.days.length, 3);
  const ids = sessionIdentitiesFor(store, EMP, '2026-10'); assert.equal(ids.length, 3);
  ids.forEach((id, i) => { assert.equal(id.workDate, row.payload.days[i].workDate); assert.equal(id.startAt, undefined); assert.deepEqual(Object.keys(id).sort(), ['attendanceId', 'plannedEndAt', 'shiftId', 'status', 'workDate']); });
  const byShift = Object.fromEntries(ids.map((x) => [x.shiftId, x]));
  assert.equal(byShift['ax-s5'].attendanceId, attendanceIdFor('ax-s5', EMP)); assert.equal(byShift['ax-s5'].status, 'clocked_in'); assert.equal(byShift['ax-s5'].plannedEndAt, at(MS_WD, '06:28'));
  assert.equal(byShift['ax-s2'].plannedEndAt, at(MS_WD, '19:28')); assert.equal(byShift['ax-s4'].status, 'clocked_out');
  for (const d of row.payload.days) assert.deepEqual(Object.keys(d).sort(), PAYLOAD_DAY_KEYS.slice().sort(), 'payload.days shape unchanged');
  const json = JSON.stringify(pkg.rows) + JSON.stringify(accountantPayloadOf(pkg));
  for (const k of ['attendanceId', 'plannedEndAt', 'shiftId', 'sessions']) assert.ok(!json.includes('"' + k + '"'), 'no ' + k + ' in rows/payload');
  // identity ordering is stable for any store order (it follows the store, like the builder)
  const rev = new Map(Array.from(store.entries()).reverse());
  const pkg2 = buildPayrollPackage({ employeeStore: msEmployeeStore, scheduleStore: msSchedule(), attendanceStore: rev, tenantId: T, periodId: '2026-10', generatedAt: 1, todayWorkDate: MS_WD });
  const ids2 = sessionIdentitiesFor(rev, EMP, '2026-10');
  pkg2.rows.find((r) => r.ansattId === EMP).payload.days.forEach((d, i) => assert.equal(d.startAt, rev.get(ids2[i].attendanceId).observedClockInAt));
});

await t('X16', 'VIEW law: daysWithIdentity joins index-by-index only when counts and workDates agree (else NO identity); managerCloseEligible is decided per session by its OWN planned end: S5 eligible at 17:50, the live S2 not eligible (19:28 not passed), the clocked-out S4 never, a session without identity or own planned end never; the future overnight S6 on the same day cannot suppress S5 (it is not in the predicate at all)', () => {
  const store = msStore();
  const pkg = buildPayrollPackage({ employeeStore: msEmployeeStore, scheduleStore: msSchedule(), attendanceStore: store, tenantId: T, periodId: '2026-10', generatedAt: 1, todayWorkDate: MS_WD });
  const row = pkg.rows.find((r) => r.ansattId === EMP);
  const days = daysWithIdentity(row.payload.days, sessionIdentitiesFor(store, EMP, '2026-10'));
  const by = Object.fromEntries(days.map((d) => [d.shiftId, d]));
  assert.equal(managerCloseEligible(by['ax-s5'], MS_NOW, 900000), true, 'S5: open, own end 06:28 + 15 min passed');
  assert.equal(managerCloseEligible(by['ax-s2'], MS_NOW, 900000), false, 'S2: open but its own end 19:28 has not passed');
  assert.equal(managerCloseEligible(by['ax-s4'], MS_NOW, 900000), false, 'S4: clocked out, no open session');
  assert.equal(managerCloseEligible(by['ax-s2'], at(MS_WD, '19:44'), 900000), true, 'S2 becomes eligible only by ITS OWN end');
  assert.equal(managerCloseEligible(Object.assign({}, by['ax-s5'], { attendanceId: null }), MS_NOW, 900000), false, 'no identity -> no action');
  assert.equal(managerCloseEligible(Object.assign({}, by['ax-s5'], { plannedEndAt: null }), MS_NOW, 900000), false, 'no own planned end -> no action (never inferred from a sibling shift)');
  assert.equal(managerCloseEligible(by['ax-s5'], MS_NOW, NaN), false);
  // join safety: a count or workDate disagreement yields NO identity on every line
  const broken = daysWithIdentity(row.payload.days, sessionIdentitiesFor(store, EMP, '2026-10').slice(1));
  assert.ok(broken.every((d) => d.attendanceId === null && d.plannedEndAt === null));
  const shifted = daysWithIdentity(row.payload.days, sessionIdentitiesFor(store, EMP, '2026-10').map((x) => Object.assign({}, x, { workDate: '2026-10-07' })));
  assert.ok(shifted.every((d) => d.attendanceId === null));
  // payload.days objects themselves are untouched (copies carry the identity)
  assert.ok(!('attendanceId' in row.payload.days[0]));
  // the OLD resolver still fails closed on this day without an identity (ambiguity law)
  assert.equal(manualTargetFor({ records: Array.from(store.values()), shifts: [], workDate: MS_WD }).mode, 'choose_record');
});

await t('X17', '(static) exact-target wiring: the payroll view carries the clicked line\'s attendanceId into the manual state and the panel (data-attendance), draws one action group per session with the session start in the labels; the shell\'s submitManagerClose and Korriger target by exact attendanceId through exactRecordFor (RECORD_CHOICE_REQUIRED without identity, ATTENDANCE_MISMATCH on a foreign record) and the first-open-record fallback is GONE; the close requires the matching MISSING_CLOCK_OUT exception (required + expect) and ensures it before the mutation', () => {
  const view = fs.readFileSync(path.join(HERE, 'management-payroll-view.mjs'), 'utf8');
  const shell = fs.readFileSync(path.join(HERE, 'employee-shell-ui.mjs'), 'utf8');
  const adapters = fs.readFileSync(path.join(HERE, 'employee-production-adapters.mjs'), 'utf8');
  assert.ok(view.includes("st.attendanceId = typeof day.attendanceId === 'string' && day.attendanceId ? day.attendanceId : null;"));
  assert.ok(view.includes("attrs: { 'data-attendance': st.attendanceId || '' } })"), 'panel names the targeted record');
  assert.ok(view.includes("const grp = el('div', { cls: 'mt-session-actions', attrs: { 'data-attendance': day.attendanceId || '' } });"));
  assert.ok(view.includes("const who = many && day.startAt != null ? ' ' + fmtHM(day.startAt) + '–' : '';") && view.includes("btn('Korriger' + who"));
  assert.ok(view.includes("days: daysWithIdentity(row.payload.days, sessionIdentitiesFor(attendanceStore, row.ansattId, periodId))"));
  assert.ok(view.includes("if (day.attendanceId) grp.appendChild(btn('Korriger' + who") && view.includes("text: 'Ingen handling (uklar registrering)'"), 'a line without identity gets no mutating action');
  assert.ok(!shell.includes("find((r) => r.workDate === wd && r.status === 'clocked_in')"), 'first-open-record fallback removed');
  assert.ok(shell.includes("if (!form || typeof form.attendanceId !== 'string' || !form.attendanceId) return { ok: false, code: 'RECORD_CHOICE_REQUIRED' };"));
  assert.ok(shell.includes("if (rec.ansattId !== form.ansattId || rec.workDate !== form.workDate) return { ok: false, code: 'ATTENDANCE_MISMATCH' };"));
  assert.ok(shell.includes("const picked = exactRecordFor(form);\n    if (!picked.ok) return picked;\n    const existing = picked.record;\n    if (existing.status !== 'clocked_in') return { ok: false, code: 'NOT_CLOCKED_IN' };"));
  assert.ok(shell.includes("kind: 'manager_resolved', actor: MGR.actor, resolution: 'manager_close', required: true, expect: { type: 'MISSING_CLOCK_OUT', shiftId: existing.shiftId, ansattId: existing.ansattId } }"));
  assert.ok(shell.includes("if (!ex) return { ok: false, code: 'NO_EXCEPTION' };") && shell.includes("exceptionSeam.ensure(ex, now)"), 'exception derived from the record\'s own shift and ensured before the mutation');
  assert.ok(shell.includes("if (typeof form.attendanceId === 'string' && form.attendanceId) {\n      const picked = exactRecordFor(form);"), 'Korriger: exact record when the line was clicked');
  assert.ok(shell.includes("target = manualTargetFor({ records: recordsForEmployee(form.ansattId), shifts, workDate: wd });"), 'without identity the resolver still decides (ambiguity fails closed)');
  assert.ok(adapters.includes("if (!xs || !xs.exists) { if (required) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'exception:NO_EXCEPTION'); return null; }"));
  assert.ok(adapters.includes("throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'exception:EXCEPTION_MISMATCH')"));
  assert.ok(adapters.includes("if (r.code === 'NOT_OPEN' && !required) return null;"));
  assert.ok(view.includes("if (c === 'ATTENDANCE_MISMATCH') return") && view.includes("if (c === 'NO_EXCEPTION' || c.startsWith('exception:')) return"), 'owner-facing texts for the new refusals');
});

await t('X18', 'ADAPTER atomic close on a TWO-OPEN-SESSION day: the manager close of S5 (required exception) commits attendance + event + exception + event in ONE transaction (4 writes); S2 (live) is byte-identical before and after and has no exception document; S5\'s exception is resolved_by_manager (manager_close)', async () => {
  const F = makeFakeFs(); const store = msStore(); for (const a of store.values()) F.seed(s4Path(T, 'attendance', a.attendanceId), a);
  const s5 = store.get(attendanceIdFor('ax-s5', EMP)), s2 = store.get(attendanceIdFor('ax-s2', EMP));
  const M = createManagementAdapters({ fs: F.api, tenantId: T, membership: membAdm, range: { from: '2026-10-01', to: '2026-10-31' }, readAnsatte: () => [], defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: P, nowMs: () => MS_NOW }); M.start();
  const derived = deriveAttendanceExceptions({ shifts: Object.values(MS), lookup: lookupOf(store), nowMs: MS_NOW, policy: P });
  const x5 = derived.find((x) => x.shiftId === 'ax-s5'); assert.ok(x5 && x5.type === 'MISSING_CLOCK_OUT' && x5.selfCorrectionOpen === false);
  assert.ok(!derived.some((x) => x.shiftId === 'ax-s2'), 'the live S2 is no exception'); assert.ok(!derived.some((x) => x.shiftId === 'ax-s6'), 'future overnight S6 is no exception');
  await M.exceptions.ensure(x5, MS_NOW);
  const s2Before = JSON.stringify(F.docs.get(s4Path(T, 'attendance', s2.attendanceId)));
  const w0 = F.writes.length;
  const close = managerCloseOpenAttendance({ actor: adm, existing: s5, declaredEndAt: at(MS_WD, '06:30'), declaredBreakMinutesTotal: 0, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: T } }, MS_NOW, P); assert.ok(close.ok, close.code);
  const c = await M.attendance.commit(close, { exception: { exceptionId: x5.exceptionId, kind: 'manager_resolved', actor: adm, resolution: 'manager_close', required: true, expect: { type: 'MISSING_CLOCK_OUT', shiftId: 'ax-s5', ansattId: EMP } } });
  assert.equal(c.ok, true); assert.equal(F.writes.length - w0, 4);
  assert.deepEqual(F.writes.slice(w0).map((w) => w.path.split('/').slice(-2).join('/').replace(/-rev-\d+$/, '')).sort(), ['attendance/' + s5.attendanceId, 'attendanceExceptions/' + x5.exceptionId, 'events/' + s5.attendanceId, 'events/' + x5.exceptionId].sort());
  const a5 = F.docs.get(s4Path(T, 'attendance', s5.attendanceId)); assert.equal(a5.status, 'attested'); assert.equal(a5.declarationSource, 'manager'); assert.equal(a5.observedClockOutAt, null); assert.equal(a5.declaredEndAt, at(MS_WD, '06:30')); assert.equal(a5.shiftId, 'ax-s5'); assert.equal(a5.workDate, MS_WD);
  assert.equal(JSON.stringify(F.docs.get(s4Path(T, 'attendance', s2.attendanceId))), s2Before, 'S2 untouched');
  assert.equal(F.docs.has(X(exceptionIdFor('MISSING_CLOCK_OUT', 'ax-s2', EMP))), false, 'no exception for S2');
  const ex5 = F.docs.get(X(x5.exceptionId)); assert.equal(ex5.status, 'resolved_by_manager'); assert.equal(ex5.resolution, 'manager_close');
  M.dispose();
});

await t('X19', 'ADAPTER fail-closed: a REQUIRED exception that is missing, or exists but names another shift/type, or is not open, aborts the WHOLE close transaction — zero writes, the attendance stays clocked_in; the non-required (employee correction) path keeps its lenient behaviour', async () => {
  const F = makeFakeFs(); const store = msStore(); for (const a of store.values()) F.seed(s4Path(T, 'attendance', a.attendanceId), a);
  const s5 = store.get(attendanceIdFor('ax-s5', EMP));
  const M = createManagementAdapters({ fs: F.api, tenantId: T, membership: membAdm, range: { from: '2026-10-01', to: '2026-10-31' }, readAnsatte: () => [], defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: P, nowMs: () => MS_NOW }); M.start();
  const close = managerCloseOpenAttendance({ actor: adm, existing: s5, declaredEndAt: at(MS_WD, '06:30'), declaredBreakMinutesTotal: 0, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: T } }, MS_NOW, P); assert.ok(close.ok, close.code);
  const x5id = exceptionIdFor('MISSING_CLOCK_OUT', 'ax-s5', EMP);
  const req = (over) => Object.assign({ exceptionId: x5id, kind: 'manager_resolved', actor: adm, resolution: 'manager_close', required: true, expect: { type: 'MISSING_CLOCK_OUT', shiftId: 'ax-s5', ansattId: EMP } }, over || {});
  const before = JSON.stringify(F.docs.get(s4Path(T, 'attendance', s5.attendanceId)));
  let w0 = F.writes.length;
  // (1) missing
  let e = await rejects(M.attendance.commit(close, { exception: req() })); assert.match(e.message, /exception:NO_EXCEPTION$/); assert.equal(F.writes.length, w0);
  // (2) exists but for another shift (S2's id used with S5's expectation) -> mismatch
  const [x2fake] = deriveAttendanceExceptions({ shifts: [MS.s2], lookup: lookupOf(store), nowMs: at(MS_WD, '19:50'), policy: P }); await M.exceptions.ensure(x2fake, at(MS_WD, '19:50')); w0 = F.writes.length;
  e = await rejects(M.attendance.commit(close, { exception: req({ exceptionId: x2fake.exceptionId }) })); assert.match(e.message, /exception:EXCEPTION_MISMATCH$/); assert.equal(F.writes.length, w0);
  // (3) exists and matches but is already resolved -> NOT_OPEN is fatal when required
  const x5 = deriveAttendanceExceptions({ shifts: [MS.s5], lookup: lookupOf(store), nowMs: MS_NOW, policy: P })[0]; await M.exceptions.ensure(x5, MS_NOW); await M.exceptions.resolve(x5.exceptionId, 'manager_manual_entry', MS_NOW); w0 = F.writes.length;
  e = await rejects(M.attendance.commit(close, { exception: req() })); assert.match(e.message, /exception:NOT_OPEN$/); assert.equal(F.writes.length, w0);
  assert.equal(JSON.stringify(F.docs.get(s4Path(T, 'attendance', s5.attendanceId))), before, 'attendance never moved'); assert.equal(F.docs.get(s4Path(T, 'attendance', s5.attendanceId)).status, 'clocked_in');
  // (4) non-required: a missing exception is tolerated (attendance written, exception skipped) — employee-correction law unchanged
  const F2 = makeFakeFs(); const st2 = msStore(); for (const a of st2.values()) F2.seed(s4Path(T, 'attendance', a.attendanceId), a);
  const M2 = createManagementAdapters({ fs: F2.api, tenantId: T, membership: membAdm, range: { from: '2026-10-01', to: '2026-10-31' }, readAnsatte: () => [], defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: P, nowMs: () => MS_NOW }); M2.start();
  const c2 = await M2.attendance.commit(close, { exception: { exceptionId: x5id, kind: 'manager_resolved', actor: adm, resolution: 'manager_close' } }); assert.equal(c2.ok, true); assert.equal(c2.exception, undefined);
  assert.equal(F2.docs.get(s4Path(T, 'attendance', s5.attendanceId)).status, 'attested');
  M.dispose(); M2.dispose();
});

// ======================= P. PRECLOSURE-POLISH-001 (three owner-approved pre-closure fixes) =======================
const uiSrcOf = () => fs.readFileSync(path.join(HERE, 'employee-shell-ui.mjs'), 'utf8').replace(/\r\n/g, '\n');
await t('X21', 'POLISH-001 item 1: the hero START fact never conflates the press instant with the declared start — ordinary clock-in at 13:05 keeps "Stemplet inn kl. 13:05" (no note); forgotten clock-in submitted 15:00 declaring 13:00 shows "Start kl. 13:00 · oppgitt av deg" with the note "Innstemplingen ble registrert kl. 15:00."; both instants stay on the record and the audit event; the three hero sites read the ONE helper and Dagen din keeps its Oppgitt/Registrert rows', () => {
  const s = dayShift('p1', EMP);
  const direct = clockIn({ actor: emp, shift: shiftObj(s), existing: null, reasonCode: null, reasonNote: null, scope: scope(s) }, at(WD, '13:05'), P);
  assert.ok(direct.ok, direct.code); assert.equal(direct.attendance.declaredStartAt, direct.attendance.observedClockInAt);
  assert.deepEqual(clockInStateFor(direct.attendance), { text: 'Stemplet inn kl. 13:05', note: null });
  const back = clockIn({ actor: emp, shift: shiftObj(s), existing: null, declaredStartAt: at(WD, '13:00'), reasonCode: 'FORGOT_CLOCK_IN', scope: scope(s) }, at(WD, '15:00'), P);
  assert.ok(back.ok, back.code); assert.equal(back.attendance.declaredStartAt, at(WD, '13:00')); assert.equal(back.attendance.observedClockInAt, at(WD, '15:00'), 'observed press instant preserved on the record');
  const f = clockInStateFor(back.attendance);
  assert.equal(f.text, 'Start kl. 13:00 \u00b7 oppgitt av deg'); assert.equal(f.note, 'Innstemplingen ble registrert kl. 15:00.');
  assert.ok(!f.text.includes('15:00') && !/^Stemplet inn/.test(f.text), 'the press instant is never presented as the work start');
  assert.equal(back.event.changed.declaredStartAt.after, at(WD, '13:00')); assert.equal(back.event.changed.observedClockInAt.after, at(WD, '15:00'), 'audit keeps both instants apart');
  // adjusted direct clock-in (declared differs by policy-permitted edit) follows the same rule; a record without declaredStartAt falls back to the observed wording
  assert.equal(clockInStateFor({ observedClockInAt: at(WD, '13:05'), declaredStartAt: at(WD, '13:02') }).text, 'Start kl. 13:02 \u00b7 oppgitt av deg');
  assert.deepEqual(clockInStateFor({ observedClockInAt: at(WD, '13:05'), declaredStartAt: null }), { text: 'Stemplet inn kl. 13:05', note: null });
  const ui = uiSrcOf();
  assert.equal(ui.split('const cs = clockInStateFor(att);').length - 1, 3, 'all three hero/status sites read the one helper');
  assert.equal(ui.split("'Stemplet inn kl. ' + fmtHM(att.observedClockInAt)").length - 1, 0, 'no site builds the start text from the observed instant any more');
  assert.ok(ui.includes("if (stateNote) txt.appendChild(el('div', { cls: 'note ax-registered', text: stateNote }));") && ui.includes("if (stateNote) card.appendChild(el('div', { cls: 'note ax-registered', text: stateNote }));"), 'the registration note is a secondary line under the status pill');
  assert.ok(ui.includes("const sr = dayRowFactsFor(att, ds, 'start');") && ui.includes("if (sr) sc.appendChild(rowOf('Start', sr.primary, sr.tag, sr.secondary));"), 'Dagen din start row renders through the source-aware helper (FIX-003)');
});
await t('X22', 'POLISH-001 item 2: the clock dialog mirrors the 6 h law for DISPLAY only — deadline = the same operands the core uses (planned start for in; the record\'s planned-snapshot end for out) + selfCorrectionWindowMs(POLICY); when expired at open or on confirm the confirm button is disabled (aria-disabled, muted style) and the manager-required text is shown; within the window the confirm stays the ordinary active button; the core still refuses a programmatic expired submission; no auto-route into any manager mutation', () => {
  const ui = uiSrcOf();
  const dlg = ui.slice(ui.indexOf('function openClockDialog('), ui.indexOf('function openBreakDialog('));
  assert.ok(dlg.includes("const lawPlannedAt = kind === 'in' ? shift.plannedStartAt : ((existingAtOpen && existingAtOpen.plannedSnapshot && Number.isFinite(existingAtOpen.plannedSnapshot.endAt)) ? existingAtOpen.plannedSnapshot.endAt : shift.plannedEndAt);"), 'same operands as the core');
  assert.ok(dlg.includes('const selfCorrectionExpired = () => Number.isFinite(lawPlannedAt) && Date.now() >= lawPlannedAt + selfCorrectionWindowMs(POLICY);'), 'one law constant, deadline instant closed (>=)');
  assert.ok(dlg.includes("const lockExpired = () => { errBox.textContent = clockErrorText('SELF_CORRECTION_EXPIRED'); if (okBtn) { okBtn.disabled = true; okBtn.setAttribute('aria-disabled', 'true'); okBtn.classList.add('expired'); } };"), 'lock = manager-required text + disabled confirm');
  assert.ok(/^\s+dialogActions\(card, /m.test(dlg) && dlg.includes("okBtn = card.querySelector('.dlg-actions .btn.primary');"), 'the shared action row is kept; its confirm is captured after the call');
  assert.ok(dlg.includes('if (selfCorrectionExpired()) lockExpired();\n  }'), 'open-time pre-check');
  assert.ok(dlg.includes('if (selfCorrectionExpired()) { lockExpired(); return; }'), 'confirm-time pre-check');
  assert.ok(dlg.includes("if (res.code === 'SELF_CORRECTION_EXPIRED') { lockExpired(); return; }"), 'the core refusal also locks the button');
  assert.ok(!/managerCloseOpenAttendance|managerManualEntry|managerCorrection/.test(dlg), 'no manager mutation reachable from the employee dialog');
  const acts = ui.slice(ui.indexOf('function dialogActions('), ui.indexOf('function reasonSelectFor('));
  assert.ok(!acts.includes('disabled'), 'the shared row creates an ACTIVE confirm; only the lock disables it');
  const css = fs.readFileSync(path.join(HERE, 'employee-shell.css'), 'utf8');
  assert.ok(css.includes('.dlg-actions .btn.primary[disabled], .dlg-actions .btn.primary[disabled]:hover { background:#e4e6e1; color:var(--muted); cursor:not-allowed; box-shadow:none; }'), 'disabled confirm is visibly inactive, no green hover');
  assert.equal(clockErrorText_of(ui), 'Fristen for å rette dette selv har gått ut (6 timer etter planlagt tid). Ledelsen må registrere dette.');
  // law (d): the backend path refuses exactly at the deadline, unchanged
  const s = dayShift('p2', EMP);
  const ci = (nowHm, decHm) => clockIn({ actor: emp, shift: shiftObj(s), existing: null, declaredStartAt: decHm ? at(WD, decHm) : undefined, reasonCode: decHm ? 'FORGOT_CLOCK_IN' : null, scope: scope(s) }, at(WD, nowHm), P);
  assert.ok(ci('18:59', '13:00').ok); assert.equal(ci('19:00', '13:00').code, 'SELF_CORRECTION_EXPIRED');
  const a = clockedIn(s, '14:33');
  assert.ok(clockOut({ actor: emp, existing: a, declaredEndAt: at(WD, '17:00'), reasonCode: 'FORGOT_CLOCK_OUT', scope: scope(s) }, at(WD, '22:59'), P).ok);
  assert.equal(clockOut({ actor: emp, existing: a, declaredEndAt: at(WD, '17:00'), reasonCode: 'FORGOT_CLOCK_OUT', scope: scope(s) }, at(WD, '23:00'), P).code, 'SELF_CORRECTION_EXPIRED');
  assert.equal(selfCorrectionMs(P), 6 * H, 'the 6 h law is unchanged');
});
function clockErrorText_of(ui) { const m = ui.match(/case 'SELF_CORRECTION_EXPIRED': return '([^']+)';/); return m ? m[1] : null; }
await t('X23', 'POLISH-001 item 3: ensureExceptionOnce — rapid repeated renders dispatch ONE local ensure() per exception identity while one is pending; a failed ensure clears the flag so a later retry dispatches again; a settled success clears it too; a populated mirror stops further attempts; a synchronously throwing seam also clears; the manager Oversikt loop dispatches only through the guard and no bare ensure remains there', async () => {
  const calls = []; let settle = null; const store = new Map();
  const seam = { get: (id) => store.get(id) || null, ensure: (x) => { calls.push(x.exceptionId); return new Promise((res, rej) => { settle = { res, rej }; }); } };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const x = { exceptionId: exceptionIdFor('MISSING_CLOCK_OUT', 'p3', EMP) };
  assert.equal(ensureExceptionOnce(seam, x, 1), true); assert.equal(ensureExceptionOnce(seam, x, 2), false); assert.equal(ensureExceptionOnce(seam, x, 3), false);
  assert.equal(calls.length, 1, 'one local dispatch while pending');
  settle.rej(new Error('PERMISSION_DENIED')); await tick();
  assert.equal(ensureExceptionOnce(seam, x, 4), true, 'a failed ensure clears the in-flight state: a legitimate retry is possible'); assert.equal(calls.length, 2);
  settle.res({ ok: true, created: true }); await tick();
  store.set(x.exceptionId, { status: 'open' });
  assert.equal(ensureExceptionOnce(seam, x, 5), false, 'mirror population stops further attempts'); assert.equal(calls.length, 2);
  store.delete(x.exceptionId);
  assert.equal(ensureExceptionOnce(seam, x, 6), true, 'a settled success cleared the flag (nothing is permanently suppressed)'); assert.equal(calls.length, 3);
  settle.res({ ok: true, created: false }); await tick();
  const y = { exceptionId: exceptionIdFor('MISSING_CLOCK_IN', 'p3', EMP) };
  const seam2 = { get: () => null, ensure: () => { throw new Error('boom'); } };
  assert.equal(ensureExceptionOnce(seam2, y, 7), true); await tick(); assert.equal(ensureExceptionOnce(seam2, y, 8), true, 'a synchronous throw clears the flag as well');
  assert.equal(ensureExceptionOnce(seam, { exceptionId: null }, 9), false, 'no identity, no dispatch');
  const ui = uiSrcOf();
  const ov = ui.slice(ui.indexOf('function oversiktFacts('), ui.indexOf('function goOversiktTarget('));
  assert.ok(ov.includes('for (const x of derived) ensureExceptionOnce(exceptionSeam, x, Date.now());'), 'Oversikt dispatches through the guard');
  assert.ok(!ov.includes('exceptionSeam.ensure('), 'no bare ensure in the Oversikt facts');
  assert.equal(ui.split('exceptionSeam.ensure(').length - 1, 2, 'bare ensure remains only on the employee card (own record check) and the manager close (one user action)');
  assert.ok(ui.includes("p.then(() => {}, () => {}).then(() => { ENSURE_IN_FLIGHT.delete(id); });"), 'the flag is cleared on settle, success or failure');
});
await t('X24', 'POLISH-001 preservation: exception law and deterministic ids unchanged — newExceptionRecord keys, exceptionIdFor, transitions (shown / acknowledged / corrected / manager_seen / manager_resolved) and the 15 min / 6 h constants are exactly as before', () => {
  assert.equal(missedThresholdMs(P), 15 * 60000); assert.equal(selfCorrectionMs(P), 6 * H); assert.equal(P.varianceToleranceMinutes, 15);
  assert.equal(exceptionIdFor('MISSING_CLOCK_OUT', 's1', EMP), 'mco-s1_' + EMP); assert.equal(exceptionIdFor('MISSING_CLOCK_IN', 's1', EMP), 'mci-s1_' + EMP);
  const s = dayShift('p4', EMP); const [x] = deriveAttendanceExceptions({ shifts: [s], lookup: () => null, nowMs: at(WD, '13:15'), policy: P });
  const rec = newExceptionRecord(x, { actor: emp, now: at(WD, '13:16') });
  assert.deepEqual(Object.keys(rec).sort(), [...EXCEPTION_KEYS].sort());
  const shown = applyExceptionTransition({ record: rec, kind: 'shown', actor: emp, now: at(WD, '13:17') }); assert.ok(shown.ok); assert.equal(shown.event.eventId, rec.exceptionId + '-rev-000002');
  const ack = applyExceptionTransition({ record: shown.record, kind: 'acknowledged', actor: emp, now: at(WD, '13:18') }); assert.ok(ack.ok);
  const seen = applyExceptionTransition({ record: ack.record, kind: 'manager_seen', actor: adm, now: at(WD, '13:19') }); assert.ok(seen.ok);
  const res = applyExceptionTransition({ record: seen.record, kind: 'manager_resolved', actor: adm, resolution: 'manager_manual_entry', now: at(WD, '13:20') }); assert.ok(res.ok); assert.equal(res.record.status, EXCEPTION_STATUS.RESOLVED_BY_MANAGER || 'resolved_by_manager');
});

// ======================= Q. TRUTHFULNESS-FIX-003 (Dagen din after manager-declared attendance) =======================
await t('X25', 'FIX-003 dayRowFactsFor: (a) ordinary clock-in/out -> "Stemplet inn"/"Stemplet ut", no secondary; (b) forgotten clock-in -> declared start primary, "Oppgitt av deg", "Registrert kl. <press>"; (c) forgotten clock-out -> same employee attribution on the end; (d) managerCloseOpenAttendance -> start stays the observed clock-in, end = declared end + "Oppgitt av ledelse", NO fabricated time for the null observed clock-out; (e) managerManualEntry -> both rows "Oppgitt av ledelse" with "Ingen stempling registrert"; (f) the Dagen din path never calls the formatter on a nullable observed instant; open record -> no end row; nothing renders "01:00"', () => {
  const rows = (att) => { const ds = daySummaryFor({ attendance: att }); return { start: dayRowFactsFor(att, ds, 'start'), end: dayRowFactsFor(att, ds, 'end') }; };
  const noEpoch = (r) => assert.ok(!JSON.stringify(r).includes('01:00'), 'no epoch-derived time: ' + JSON.stringify(r));
  // (a) ordinary
  const s = dayShift('q1', EMP);
  const a0 = clockedIn(s, '13:05');
  const a1 = clockOut({ actor: emp, existing: a0, declaredEndAt: at(WD, '17:02'), reasonCode: null, reasonNote: null, scope: scope(s) }, at(WD, '17:02'), P); assert.ok(a1.ok, a1.code);
  assert.deepEqual(rows(a0), { start: { primary: '13:05', tag: 'Stemplet inn', secondary: null }, end: null }, 'open record: no end row');
  assert.deepEqual(rows(a1.attendance), { start: { primary: '13:05', tag: 'Stemplet inn', secondary: null }, end: { primary: '17:02', tag: 'Stemplet ut', secondary: null } });
  // (b) forgotten clock-in
  const b = clockIn({ actor: emp, shift: shiftObj(s), existing: null, declaredStartAt: at(WD, '13:00'), reasonCode: 'FORGOT_CLOCK_IN', scope: scope(s) }, at(WD, '15:00'), P); assert.ok(b.ok, b.code);
  assert.deepEqual(rows(b.attendance).start, { primary: '13:00', tag: 'Oppgitt av deg', secondary: 'Registrert kl. 15:00' });
  // (c) forgotten clock-out
  const c = clockOut({ actor: emp, existing: clockedIn(s, '14:33'), declaredEndAt: at(WD, '17:00'), reasonCode: 'FORGOT_CLOCK_OUT', reasonNote: null, scope: scope(s) }, at(WD, '17:30'), P); assert.ok(c.ok, c.code);
  assert.deepEqual(rows(c.attendance), { start: { primary: '14:33', tag: 'Stemplet inn', secondary: null }, end: { primary: '17:00', tag: 'Oppgitt av deg', secondary: 'Registrert kl. 17:30' } });
  // (d) manager close of an expired open record
  const d = managerCloseOpenAttendance({ actor: adm, existing: clockedIn(s, '14:33'), declaredEndAt: at(WD, '17:00'), declaredBreakMinutesTotal: 30, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: T } }, at(NX, '12:35'), P); assert.ok(d.ok, d.code);
  assert.equal(d.attendance.observedClockOutAt, null); assert.equal(d.attendance.declarationSource, 'manager');
  const dr = rows(d.attendance); noEpoch(dr);
  assert.deepEqual(dr, { start: { primary: '14:33', tag: 'Stemplet inn', secondary: null }, end: { primary: '17:00', tag: 'Oppgitt av ledelse', secondary: 'Ingen stempling registrert' } });
  // (e) manager manual entry (attested, no stamps at all)
  const e = managerManualEntry({ actor: adm, existing: null, shift: null, ansattId: EMP, workDate: WD, declaredStartAt: at(WD, '13:00'), declaredEndAt: at(WD, '17:00'), declaredBreakMinutesTotal: 30, employment: { startDate: '2020-01-01', endDate: null }, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: T } }, at(NX, '12:35'), P); assert.ok(e.ok, e.code);
  assert.equal(e.attendance.observedClockInAt, null); assert.equal(e.attendance.observedClockOutAt, null); assert.equal(e.attendance.status, 'attested');
  const er = rows(e.attendance); noEpoch(er);
  assert.deepEqual(er, { start: { primary: '13:00', tag: 'Oppgitt av ledelse', secondary: 'Ingen stempling registrert' }, end: { primary: '17:00', tag: 'Oppgitt av ledelse', secondary: 'Ingen stempling registrert' } });
  // (f) static: the rendering path has no formatter call on a nullable observed instant; attribution strings live only in the helper
  const ui = fs.readFileSync(path.join(HERE, 'employee-shell-ui.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const dd = ui.slice(ui.indexOf('// ---- DAGEN DIN (Slice003)'), ui.indexOf('// TOTAL (only when the helper exposes a complete total)'));
  assert.ok(dd.length > 200 && !dd.includes('fmtHM(ds.start.') && !dd.includes('fmtHM(ds.end.') && !dd.includes('observedAt'), 'Dagen din start/end rows never format a start/end instant or touch observedAt directly (the break row keeps its own null-guarded sinceAt)');
  assert.ok(dd.includes("const sr = dayRowFactsFor(att, ds, 'start');") && dd.includes("const er = dayRowFactsFor(att, ds, 'end');") && dd.includes("else sc.appendChild(rowOf('Slutt', '\u2013', null, ds.onBreak ? null : 'Ikke stemplet ut ennå'));"), 'both rows go through the helper; the open-end row is unchanged');
  assert.ok(ui.includes("secondary: f.observedAt != null ? 'Registrert kl. ' + fmtHM(f.observedAt) : 'Ingen stempling registrert'"), 'the formatter is guarded by the null check');
  assert.equal(ui.split("'Oppgitt av deg'").length - 1, 1); assert.equal(ui.split("'Oppgitt av ledelse'").length - 1, 1, 'both attribution strings live only in declaredByTag');
  // the declared BREAK row on the same card follows the same attribution rule (a manager close / manual entry declares the break too)
  assert.ok(dd.includes("rowOf('Pause', ds.breakRow.minutes + ' min', declaredByTag(att), (ds.breakRow.observedMinutes"), 'declared break row attributed by the same rule');
  assert.equal(declaredByTag(d.attendance), 'Oppgitt av ledelse'); assert.equal(declaredByTag(e.attendance), 'Oppgitt av ledelse'); assert.equal(declaredByTag(c.attendance), 'Oppgitt av deg'); assert.equal(declaredByTag(null), 'Oppgitt av deg');
  assert.equal(dayRowFactsFor(null, null, 'end'), null);
});

for (const l of lines) console.log(l);
console.log('ATTENDANCE_EXCEPTIONS_TESTS: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
