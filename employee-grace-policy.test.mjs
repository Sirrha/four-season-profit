// employee-grace-policy.test.mjs
// OD-5 (HERISH-SIRRHA-S4-OWNER-RATIFICATIONS-FREEZE-001, 2026-09-25): graceHours = 6 in the single accepted
// policy object. Deterministic proofs G1–G10. Node built-ins only. Run: node employee-grace-policy.test.mjs
//
// Meaning proven here: an overnight shift stays attached to its workDate; declared times and the one-shot
// employee edit are accepted until 06:00 local the next morning; every other accepted safeguard (36 h cap,
// once-only edit, observed immutability, reason model, day shifts) is unchanged.

import assert from 'node:assert/strict';
import { ETR2A_POLICY as P, clockIn, clockOut, startBreak, endBreak, employeeEdit, managerManualEntry, tenantLocalHMToUtcMs, endOfTenantLocalDayUtcMs } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const TZ = P.timezone;
const WD = '2026-09-27', NX = '2026-09-28';            // Sunday night shift (CEST), Monday morning
const at = (d, hm) => tenantLocalHMToUtcMs(d, hm, TZ);
const actor = { uid: 'auth-x', accessRole: 'employee', ansattId: 'ans-x', accessEnabled: true, tenantId: 't' };
const admin = { uid: 'auth-adm', accessRole: 'admin', ansattId: 'ans-adm', accessEnabled: true, tenantId: 't' };
const night = { shiftId: 'night-1', tenantId: 't', ansattId: 'ans-x', status: 'assigned', workDate: WD, plannedStartAt: at(WD, '22:00'), plannedEndAt: at(NX, '02:00'), revision: 1, roleKey: null };
const day = { shiftId: 'day-1', tenantId: 't', ansattId: 'ans-x', status: 'assigned', workDate: WD, plannedStartAt: at(WD, '08:00'), plannedEndAt: at(WD, '16:00'), revision: 1, roleKey: null };
const scope = (s) => ({ tenantId: 't', shiftId: s.shiftId });

t('G1', 'accepted policy carries graceHours 6; the other accepted knobs are unchanged', () => {
  assert.equal(P.graceHours, 6);
  assert.equal(P.maxEditWindowHours, 36); assert.equal(P.employeeEditMode, 'once'); assert.equal(P.editCutoffMode, 'tenantLocalDay');
  assert.equal(P.timezone, 'Europe/Oslo'); assert.equal(P.employeeMayAdjustTime, true); assert.equal(P.expectedBreakMinutes, 30);
});
t('G2', 'overnight 22:00–02:00: clock-in, pause, clock-out at 02:00 next morning all succeed under the accepted policy', () => {
  const ci = clockIn({ actor, shift: night, existing: null, scope: scope(night) }, at(WD, '22:00'), P); assert.ok(ci.ok, ci.code);
  const bs = startBreak({ actor, existing: ci.attendance, scope: scope(night) }, at(NX, '00:30'), P); assert.ok(bs.ok, bs.code);
  const be = endBreak({ actor, existing: bs.attendance, scope: scope(night) }, at(NX, '01:00'), P); assert.ok(be.ok, be.code);
  const co = clockOut({ actor, existing: be.attendance, scope: scope(night) }, at(NX, '02:00'), P); assert.ok(co.ok, co.code);
  assert.equal(co.attendance.workDate, WD, 'stays attached to its workDate');
  assert.equal(co.attendance.status, 'clocked_out'); assert.equal(co.attendance.observedBreakMinutesTotal, 30);
});
t('G3', 'the same overnight clock-out at 02:00 is REJECTED under graceHours 0 (the previous policy) — the change is necessary, not cosmetic', () => {
  const P0 = Object.assign({}, P, { graceHours: 0 });
  const ci = clockIn({ actor, shift: night, existing: null, scope: scope(night) }, at(WD, '22:00'), P0); assert.ok(ci.ok, ci.code);
  const co = clockOut({ actor, existing: ci.attendance, scope: scope(night) }, at(NX, '02:00'), P0);
  assert.equal(co.ok, false); assert.equal(co.code, 'DECLARED_OUTSIDE_WORKDATE');
});
t('G4', 'edit window: the one-shot employee edit is allowed at 05:59 local next morning and closed at exactly 06:00', () => {
  const ci = clockIn({ actor, shift: night, existing: null, scope: scope(night) }, at(WD, '22:00'), P);
  const co = clockOut({ actor, existing: ci.attendance, scope: scope(night) }, at(NX, '02:00'), P);
  assert.equal(co.attendance.employeeEditDeadline, at(NX, '06:00'), 'deadline == 06:00 local next day');
  assert.equal(co.attendance.employeeEditDeadline, endOfTenantLocalDayUtcMs(WD, TZ, 6));
  const ok = employeeEdit({ actor, existing: co.attendance, patch: { note: 'Glemte notat' }, scope: scope(night) }, at(NX, '05:59'), P);
  assert.ok(ok.ok, ok.code);
  const closed = employeeEdit({ actor, existing: co.attendance, patch: { note: 'For sent' }, scope: scope(night) }, at(NX, '06:00'), P);
  assert.equal(closed.ok, false); assert.equal(closed.code, 'EDIT_WINDOW_CLOSED');
});
t('G5', 'declared times beyond 06:00 next morning are outside the workDate (clock-out at 06:01 rejected; 06:00 accepted)', () => {
  const ci = clockIn({ actor, shift: night, existing: null, scope: scope(night) }, at(WD, '22:00'), P);
  const late = clockOut({ actor, existing: ci.attendance, scope: scope(night), reasonCode: 'MANAGEMENT_DECISION' }, at(NX, '06:01'), P);
  assert.equal(late.ok, false); assert.equal(late.code, 'DECLARED_OUTSIDE_WORKDATE');
  const edge = clockOut({ actor, existing: ci.attendance, scope: scope(night), reasonCode: 'MANAGEMENT_DECISION' }, at(NX, '06:00'), P);
  assert.ok(edge.ok, edge.code);
});
t('G6', 'the 36 h cap still bounds the deadline: a clock-in early on the workDate closes at 06:00 next day, never later', () => {
  const early = { ...day, shiftId: 'early-1', plannedStartAt: at(WD, '06:00'), plannedEndAt: at(WD, '14:00') };
  const ci = clockIn({ actor, shift: early, existing: null, scope: scope(early) }, at(WD, '06:00'), P);
  assert.ok(ci.ok, ci.code);
  assert.equal(ci.attendance.employeeEditDeadline, Math.min(at(NX, '06:00'), at(WD, '06:00') + 36 * 3600000));
  assert.equal(ci.attendance.employeeEditDeadline, at(NX, '06:00'));
  assert.ok(ci.attendance.employeeEditDeadline - ci.attendance.createdAt <= 36 * 3600000);
});
t('G7', 'a plain day shift 08:00–16:00 behaves exactly as before (clock-out at 16:00; a declared 09:00 next day is outside)', () => {
  const ci = clockIn({ actor, shift: day, existing: null, scope: scope(day) }, at(WD, '08:00'), P); assert.ok(ci.ok, ci.code);
  const co = clockOut({ actor, existing: ci.attendance, scope: scope(day) }, at(WD, '16:00'), P); assert.ok(co.ok, co.code);
  const bad = clockOut({ actor, existing: ci.attendance, scope: scope(day), reasonCode: 'MANAGEMENT_DECISION' }, at(NX, '09:00'), P);
  assert.equal(bad.ok, false); assert.equal(bad.code, 'DECLARED_OUTSIDE_WORKDATE');
});
t('G8', 'once-only edit and observed immutability are unchanged under grace 6', () => {
  const ci = clockIn({ actor, shift: night, existing: null, scope: scope(night) }, at(WD, '22:00'), P);
  const co = clockOut({ actor, existing: ci.attendance, scope: scope(night) }, at(NX, '02:00'), P);
  const e1 = employeeEdit({ actor, existing: co.attendance, patch: { note: 'a' }, scope: scope(night) }, at(NX, '03:00'), P); assert.ok(e1.ok, e1.code);
  const e2 = employeeEdit({ actor, existing: e1.attendance, patch: { note: 'b' }, scope: scope(night) }, at(NX, '03:10'), P);
  assert.equal(e2.ok, false); assert.equal(e2.code, 'EDIT_LIMIT');
  const tamper = employeeEdit({ actor, existing: co.attendance, patch: { observedClockInAt: 1 }, scope: scope(night) }, at(NX, '03:00'), P);
  assert.equal(tamper.ok, false); assert.ok(tamper.code.startsWith('FIELD_NOT_EDITABLE'));
});
t('G9', 'manager manual entry: an overnight 20:00–01:00 entry belongs whole to its workDate; 06:30 next morning is outside', () => {
  const employment = { startDate: '2026-01-01', endDate: null };
  const ok = managerManualEntry({ actor: admin, existing: null, shift: null, ansattId: 'ans-x', workDate: WD, declaredStartAt: at(WD, '20:00'), declaredEndAt: at(NX, '01:00'), declaredBreakMinutesTotal: 0, employment, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: 't' } }, at(NX, '09:00'), P);
  assert.ok(ok.ok, ok.code); assert.equal(ok.attendance.workDate, WD); assert.equal(ok.attendance.attendanceId, 'manual-' + WD + '-ans-x');
  const bad = managerManualEntry({ actor: admin, existing: null, shift: null, ansattId: 'ans-x', workDate: WD, declaredStartAt: at(WD, '20:00'), declaredEndAt: at(NX, '06:30'), declaredBreakMinutesTotal: 0, employment, reasonCode: 'RETROACTIVE_ENTRY', scope: { tenantId: 't' } }, at(NX, '09:00'), P);
  assert.equal(bad.ok, false); assert.equal(bad.code, 'DECLARED_OUTSIDE_WORKDATE');
});
t('G10', 'measured fact (documented, not a rule): grace is 6 clock-HOURS after local midnight — on the DST-end night 2026-10-24→25 the window ends at 05:00 wall time', () => {
  const dl = endOfTenantLocalDayUtcMs('2026-10-24', TZ, 6);
  assert.equal(dl, at('2026-10-25', '05:00'));           // midnight + 6 h of elapsed time = 05:00 wall clock that night
  assert.equal(endOfTenantLocalDayUtcMs('2026-10-23', TZ, 6), at('2026-10-24', '06:00'));
});

for (const l of lines) console.log(l);
console.log('EMPLOYEE_GRACE_POLICY_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
