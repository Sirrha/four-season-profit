// management-manualtime-ui.test.mjs
// 3B-UI proofs for the manager "Legg til / korriger arbeidstid" integration surface.
// Named in the UI1 recon before creation, as the release requires. Node built-ins only.
// Run: node management-manualtime-ui.test.mjs   (exit 0 = all pass)
//
// SCOPE: the PURE decision logic the UI layer owns — which accepted foundation operation a given
// employee-day resolves to, and how foundation refusal codes reach the manager in Norwegian. No
// DOM, no rendering, no arithmetic: actual-time truth belongs to daySummaryFor and is proven in
// the attendance/payroll suites, not here.

import assert from 'node:assert/strict';
import { manualTargetFor, manualErrorText, nbDateFromIso, isoFromNbDate } from './management-payroll-view.mjs';
import { managerManualEntry, managerCorrection, daySummaryFor, ETR2A_POLICY, attendanceIdFor, manualAttendanceIdFor, tenantLocalHMToUtcMs } from './employee-shell-core.mjs';
import { seedFourSeasonEmployees, employeeOf, startDateOf } from './management-employees-core.mjs';
import { FOUR_SEASON_PEOPLE, FOUR_SEASON_TENANT } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0;
const lines = [];
function t(id, name, fn) {
  try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); }
  catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); }
}

const T = FOUR_SEASON_TENANT.tenantId;
const POL = ETR2A_POLICY;
const TZ = POL.timezone;
const WD = '2026-08-24';
const ms = (wd, hm) => tenantLocalHMToUtcMs(wd, hm, TZ);
const admin = { uid: 'auth-admin', accessRole: 'admin', ansattId: 'ans-admin', accessEnabled: true, tenantId: T };
const SCOPE = { tenantId: T };

const rec = (o) => Object.assign({
  attendanceId: 'a1', ansattId: 'ans-a1', workDate: WD, shiftId: 'sh-1',
  status: 'clocked_out', breakState: 'working',
  observedClockInAt: ms(WD, '08:00'), observedClockOutAt: ms(WD, '16:00'),
  declaredStartAt: ms(WD, '08:00'), declaredEndAt: ms(WD, '16:00'),
  declaredBreakMinutesTotal: null, observedBreakMinutesTotal: 0, breakCount: 0,
  plannedSnapshot: { startAt: ms(WD, '08:00'), endAt: ms(WD, '16:00') },
  approvedStartAt: null, approvedEndAt: null, approvedByUid: null, approvedAt: null,
  approvedBreakMinutesTotal: null, revision: 1,
}, o || {});
const shift = (id, wd, from, to, o) => ({
  shiftId: id,
  projection: Object.assign({ ansattId: 'ans-a1', workDate: wd, status: 'assigned', plannedStartAt: ms(wd, from), plannedEndAt: ms(wd, to), revision: 1 }, o || {}),
});

// ---- UTP2/UTP3/UTP4/UTP5/UTP6: the resolution never guesses -----------------------------------
t('U1', 'no attendance + exactly one assigned shift -> M1 with THAT real shift', () => {
  const r = manualTargetFor({ records: [], shifts: [shift('sh-1', WD, '08:00', '16:00')], workDate: WD });
  assert.equal(r.mode, 'm1');
  assert.equal(r.shift.shiftId, 'sh-1');
});
t('U2', 'no attendance + no shift -> M2 manual path', () => {
  assert.equal(manualTargetFor({ records: [], shifts: [], workDate: WD }).mode, 'm2');
  // a shift on ANOTHER day never leaks into this day's decision
  assert.equal(manualTargetFor({ records: [], shifts: [shift('sh-1', '2026-08-25', '08:00', '16:00')], workDate: WD }).mode, 'm2');
});
t('U3', 'several assigned shifts -> explicit choice REQUIRED, never a silent pick or M2 fallback', () => {
  const r = manualTargetFor({ records: [], shifts: [shift('sh-1', WD, '08:00', '12:00'), shift('sh-2', WD, '16:00', '20:00')], workDate: WD });
  assert.equal(r.mode, 'choose');
  assert.equal(r.candidates.length, 2);
  assert.equal(r.shift, undefined, 'no shift is pre-selected');
  assert.notEqual(r.mode, 'm2', 'never falls back to the no-shift path');
});
t('U4', 'cancelled/open shifts are not entry targets', () => {
  const cancelled = shift('sh-1', WD, '08:00', '16:00', { status: 'cancelled' });
  const open = shift('sh-2', WD, '08:00', '16:00', { status: 'open', ansattId: null });
  assert.equal(manualTargetFor({ records: [], shifts: [cancelled, open], workDate: WD }).mode, 'm2');
});
t('U5', 'an existing record routes to CORRECT, never to a duplicate add', () => {
  const r = manualTargetFor({ records: [rec()], shifts: [shift('sh-1', WD, '08:00', '16:00')], workDate: WD });
  assert.equal(r.mode, 'correct');
  assert.equal(r.record.attendanceId, 'a1');
});
t('U6', 'a live session resolves to LIVE (new entry refused; correction still legitimate)', () => {
  assert.equal(manualTargetFor({ records: [rec({ status: 'clocked_in', observedClockOutAt: null })], shifts: [], workDate: WD }).mode, 'live');
  assert.equal(manualTargetFor({ records: [rec({ breakState: 'on_break' })], shifts: [], workDate: WD }).mode, 'live');
});
t('U7', 'several records on one day -> explicit choice, never an arbitrary target', () => {
  const r = manualTargetFor({ records: [rec(), rec({ attendanceId: 'a2', shiftId: 'sh-2' })], shifts: [], workDate: WD });
  assert.equal(r.mode, 'choose_record');
  assert.equal(r.records.length, 2);
});

// ---- UTP8: the employment argument comes from the CANONICAL projection -------------------------
t('U8', 'employment injection matches the canonical employees projection exactly', () => {
  const store = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
  const e = employeeOf(store, T, FOUR_SEASON_PEOPLE[0].ansattId);
  assert.ok(e, 'canonical employee record resolves');
  // THE caller rule: startDate is startDateOf(), endDate is the same status/endedAt expression the
  // payroll core itself uses. Not a literal, not a second derivation.
  const employment = { startDate: startDateOf(e), endDate: e.status === 'active' ? null : (e.endedAt || null) };
  assert.equal(employment.startDate, e.terms[0].validFrom);
  assert.equal(employment.endDate, null);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(employment.startDate));
  // and the operation genuinely enforces it
  const before = managerManualEntry({
    actor: admin, existing: null, shift: null, ansattId: e.ansattId, workDate: '1999-01-01',
    declaredStartAt: ms('1999-01-01', '08:00'), declaredEndAt: ms('1999-01-01', '16:00'),
    declaredBreakMinutesTotal: 0, employment, reasonCode: 'RETROACTIVE_ENTRY', scope: SCOPE,
  }, Date.now(), POL);
  assert.equal(before.ok, false);
  assert.equal(before.code, 'BEFORE_EMPLOYMENT_START');
  const missing = managerManualEntry({
    actor: admin, existing: null, shift: null, ansattId: e.ansattId, workDate: WD,
    declaredStartAt: ms(WD, '08:00'), declaredEndAt: ms(WD, '16:00'),
    declaredBreakMinutesTotal: 0, employment: null, reasonCode: 'RETROACTIVE_ENTRY', scope: SCOPE,
  }, Date.now(), POL);
  assert.equal(missing.code, 'EMPLOYMENT_REQUIRED', 'fails closed without canonical employment');
});

// ---- UTP7/UTP14: named refusals reach the manager, nothing is swallowed ------------------------
t('U9', 'every reachable refusal code maps to specific Norwegian text, never a silent success', () => {
  const codes = ['OEKT_PAAGAAR', 'ATTESTERT_AV_LEDELSE', 'ATTENDANCE_EXISTS', 'EMPLOYMENT_REQUIRED',
    'BEFORE_EMPLOYMENT_START', 'AFTER_EMPLOYMENT_END', 'WORKDATE_INVALID', 'DECLARED_NOT_FINITE',
    'END_BEFORE_START', 'DECLARED_OUTSIDE_WORKDATE', 'DECLARED_BREAK_INVALID', 'BREAK_EXCEEDS_SPAN',
    'BREAK_OPEN', 'REASON_REQUIRED', 'NO_CHANGE', 'NO_ATTENDANCE', 'ANSATT_REQUIRED', 'NOT_ADMIN',
    'CROSS_TENANT', 'NO_SHIFT', 'SHIFT_CHOICE_REQUIRED', 'RECORD_CHOICE_REQUIRED'];
  const seen = new Set();
  for (const c of codes) {
    const text = manualErrorText(c);
    assert.ok(text && text.length > 5, c);
    assert.equal(text.includes(c), false, 'a raw code must never be shown as the message: ' + c);
    assert.equal(seen.has(text), false, 'each refusal reads distinctly: ' + c);
    seen.add(text);
  }
  assert.ok(manualErrorText('FIELD_NOT_CORRECTABLE:status').length > 5);
  // an UNKNOWN code still surfaces honestly rather than being swallowed
  assert.ok(manualErrorText('SOMETHING_NEW').includes('SOMETHING_NEW'));
});

// ---- UTP5/UTP6: the correction path the UI drives writes declared only -------------------------
t('U10', 'the correction the UI submits writes declared facts and leaves observed byte-identical', () => {
  const a = rec();
  const res = managerCorrection({
    actor: admin, existing: a, patch: { declaredStartAt: ms(WD, '07:30'), declaredBreakMinutesTotal: 30 },
    reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE,
  }, Date.now(), POL);
  assert.ok(res.ok, res.code);
  assert.equal(res.attendance.observedClockInAt, a.observedClockInAt);
  assert.equal(res.attendance.observedClockOutAt, a.observedClockOutAt);
  assert.equal(res.attendance.declaredStartAt, ms(WD, '07:30'));
  assert.equal(res.attendance.declaredBreakMinutesTotal, 30);
  // correcting a LIVE record stays legitimate (Soren Q1=A) — the UI must not block it
  const live = managerCorrection({
    actor: admin, existing: rec({ status: 'clocked_in', observedClockOutAt: null, declaredEndAt: null }),
    patch: { declaredStartAt: ms(WD, '07:30') }, reasonCode: 'MANAGEMENT_DECISION', scope: SCOPE,
  }, Date.now(), POL);
  assert.ok(live.ok, live.code);
});

// ---- UTP13: the UI adds no arithmetic and no second identity ----------------------------------
t('U11', 'displayed time after a manual write comes from daySummaryFor, and keys stay disjoint', () => {
  const entry = managerManualEntry({
    actor: admin, existing: null, shift: null, ansattId: 'ans-a1', workDate: WD,
    declaredStartAt: ms(WD, '08:00'), declaredEndAt: ms(WD, '16:00'), declaredBreakMinutesTotal: 30,
    employment: { startDate: '2026-01-01', endDate: null }, reasonCode: 'RETROACTIVE_ENTRY', scope: SCOPE,
  }, Date.now(), POL);
  assert.ok(entry.ok, entry.code);
  assert.equal(entry.attendance.attendanceId, manualAttendanceIdFor(WD, 'ans-a1'));
  assert.notEqual(entry.attendance.attendanceId, attendanceIdFor('sh-1', 'ans-a1'));
  // THE derivation, not a UI calculation
  assert.equal(daySummaryFor({ attendance: entry.attendance }).total.minutes, 450);
  // the manual record carries no planned values and no approved break
  assert.equal(entry.attendance.plannedSnapshot, null);
  assert.equal(entry.attendance.approvedBreakMinutesTotal, null);
});

// ---- UTP1: the shared reason contract is policy truth, not UI invention -----------------------
t('U12', 'manager reason codes are read from the live policy, and none is invented', () => {
  const managerCodes = Object.keys(POL.reasonCodes).filter((c) => POL.reasonCodes[c].appliesTo.includes('manager'));
  assert.ok(managerCodes.includes('RETROACTIVE_ENTRY'));
  assert.ok(managerCodes.includes('MANAGEMENT_DECISION'));
  assert.ok(managerCodes.includes('OTHER'));
  assert.equal(POL.reasonCodes.OTHER.requiresNote, true, 'the note contract is policy, not a UI guess');
  // a code outside the manager set is refused by the operation itself
  const r = managerManualEntry({
    actor: admin, existing: null, shift: null, ansattId: 'ans-a1', workDate: WD,
    declaredStartAt: ms(WD, '08:00'), declaredEndAt: ms(WD, '16:00'), declaredBreakMinutesTotal: 0,
    employment: { startDate: '2026-01-01', endDate: null }, reasonCode: 'FORGOT_CLOCK_IN', scope: SCOPE,
  }, Date.now(), POL);
  assert.equal(r.code, 'REASON_REQUIRED');
});

// ---- STAGE R closure (D1-D3): Norwegian dd.mm.yyyy entry over ONE canonical ISO value ----------
t('U13', 'D1 FORMAT: canonical ISO renders as dd.mm.yyyy, independent of any browser locale', () => {
  assert.equal(nbDateFromIso('2026-08-04'), '04.08.2026');
  assert.equal(nbDateFromIso('2026-12-31'), '31.12.2026');
  assert.equal(nbDateFromIso(''), '');
  assert.equal(nbDateFromIso('08/04/2026'), '', 'a locale string is not a canonical value');
});
t('U14', 'D2 PARSE: visible dd.mm.yyyy resolves to canonical ISO; ISO -> visible -> ISO is identity', () => {
  assert.deepEqual(isoFromNbDate('04.08.2026'), { status: 'valid', iso: '2026-08-04' });
  assert.deepEqual(isoFromNbDate('04082026'), { status: 'valid', iso: '2026-08-04' }, 'unambiguous eight digits');
  for (const iso of ['2026-08-04', '2026-01-01', '2026-12-31', '2028-02-29', '2025-12-04']) {
    assert.equal(isoFromNbDate(nbDateFromIso(iso)).iso, iso, 'round-trip ' + iso);
  }
  // the owner's failure value can only be reached by typing it — never by parsing 04.08.2026
  assert.notEqual(isoFromNbDate('04.08.2026').iso, '2025-12-04');
});
t('U15', 'D3 VALIDATION: incomplete never resolves, impossible dates are refused, no autocorrection, leap day deterministic', () => {
  for (const s of ['', '0', '04.', '04.08', '04.08.202', '4.8.2026']) assert.equal(isoFromNbDate(s).status, 'incomplete', JSON.stringify(s));
  for (const s of ['31.02.2026', '29.02.2026', '00.08.2026', '04.13.2026', '08/04/2026', '2026-08-04', '04.08.2026x']) {
    const r = isoFromNbDate(s);
    assert.equal(r.status, 'invalid', JSON.stringify(s));
    assert.equal(r.iso, '', 'nothing is guessed for ' + JSON.stringify(s));
  }
  assert.deepEqual(isoFromNbDate('29.02.2028'), { status: 'valid', iso: '2028-02-29' });
  assert.deepEqual(isoFromNbDate('29.02.2024'), { status: 'valid', iso: '2024-02-29' });
});

console.log(lines.join('\n'));
console.log('\nMANAGEMENT_MANUALTIME_UI_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
