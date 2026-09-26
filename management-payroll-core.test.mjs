// management-payroll-core.test.mjs
// LØNNSGRUNNLAG INCREMENT 2 — deterministic proofs P1–P16. Node built-ins only; every clock
// value INJECTED. Run: node management-payroll-core.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PACKAGE_STATUS, DELIVERY_CHANNELS, FUTURE_DELIVERY_CHANNELS, UNSUPPORTED_CAPABILITIES,
  VARIANCE_TOLERANCE_HOURS, FOUR_SEASON_PAYROLL_POLICY, HARD_EXCEPTIONS, WARN_EXCEPTIONS,
  periodIdOf, periodLabel, periodTitle, periodBounds, periodOfWorkDate, workDateInPeriod, addMonths,
  isCompletePayrollPolicy, payrollCalendarStateFor,
  buildPayrollPackage, accountantPayloadOf, createPayrollStore, applyPayrollOperation,
  versionsOf, latestVersionOf, activeDraftOf, payrollProjectionForEmployee,
} from './management-payroll-core.mjs';
import { seedFourSeasonEmployees, employeeOf, applyEmployeeOperation } from './management-employees-core.mjs';
import { FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MANAGER_ACTOR } from './employee-schedule-fixture.mjs';
import { tenantLocalHMToUtcMs, ETR2A_POLICY } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const T = FOUR_SEASON_TENANT.tenantId;
const TZ = ETR2A_POLICY.timezone;
const MGR = FOUR_SEASON_MANAGER_ACTOR;
const PERIOD = '2026-08';
const TODAY = '2026-09-03';
const NOW = tenantLocalHMToUtcMs(TODAY, '12:00', TZ);
const seedE = () => seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
const applyE = (store, op) => applyEmployeeOperation({ store, tenantId: T, actor: MGR, op, now: NOW, timezone: TZ });

// ---- synthetic layer-B attendance records (the real shape, built by hand so every proof is
// deterministic; daySummaryFor does the derivation exactly as it does in the product) --------
const ms = (wd, hm) => tenantLocalHMToUtcMs(wd, hm, TZ);
function att(ansattId, workDate, o) {
  const opts = o || {};
  const inAt = opts.inAt === undefined ? ms(workDate, '08:00') : opts.inAt;
  const outAt = opts.outAt === undefined ? ms(workDate, '16:00') : opts.outAt;
  return {
    attendanceId: 'att-' + ansattId + '-' + workDate, shiftId: 'sh-' + ansattId + '-' + workDate,
    ansattId, workDate,
    plannedSnapshot: { startAt: ms(workDate, '08:00'), endAt: ms(workDate, '16:00') },
    observedClockInAt: inAt, observedClockOutAt: outAt,
    declaredStartAt: opts.declaredStartAt === undefined ? inAt : opts.declaredStartAt,
    declaredEndAt: opts.declaredEndAt === undefined ? outAt : opts.declaredEndAt,
    approvedStartAt: null, approvedEndAt: null, approvedByUid: null, approvedAt: null,
    status: opts.status || (outAt == null ? 'clocked_in' : 'clocked_out'),
    breakState: opts.breakState || 'working', openBreakStartedAt: opts.openBreakStartedAt || null,
    observedBreakMinutesTotal: opts.observedBreakMinutesTotal || 0,
    declaredBreakMinutesTotal: opts.declaredBreakMinutesTotal === undefined ? null : opts.declaredBreakMinutesTotal,
    approvedBreakMinutesTotal: null, breakCount: opts.breakCount || 0,
    revision: 1, createdAt: NOW, updatedAt: NOW,
  };
}
const storeOf = (records) => new Map(records.map((r) => [r.attendanceId, r]));
const emptySchedule = { [T]: {} };
// tenantShiftsOf treats each tenant-map VALUE as the projection itself (management-schedule-
// core.mjs:24), so the fixture stores projections directly — no wrapper object.
function shiftFor(ansattId, workDate, fromHM, toHM) {
  return { shiftId: 'p-' + ansattId + '-' + workDate, ansattId, workDate, status: 'assigned', plannedStartAt: ms(workDate, fromHM), plannedEndAt: ms(workDate, toHM) };
}
function scheduleOf(shifts) { const c = { [T]: {} }; for (const s of shifts) c[T][s.shiftId] = s; return c; }
const build = (over) => buildPayrollPackage(Object.assign({
  employeeStore: seedE(), scheduleStore: emptySchedule, attendanceStore: new Map(),
  tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY,
}, over || {}));
const rowOf = (pkg, ansattId) => pkg.rows.find((r) => r.ansattId === ansattId);

t('P1', 'period identity, tenant-local workDate placement and the overnight no-split rule', () => {
  assert.equal(periodIdOf(2026, 8), '2026-08');
  assert.equal(periodLabel('2026-08'), 'august 2026');
  assert.equal(periodTitle('2026-08'), 'Lønnsgrunnlag · august 2026');
  assert.deepEqual(periodBounds('2026-08'), { first: '2026-08-01', last: '2026-08-31' });
  assert.deepEqual(periodBounds('2026-02'), { first: '2026-02-01', last: '2026-02-28' });
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(periodOfWorkDate('2026-08-31'), '2026-08');
  assert.equal(workDateInPeriod('2026-09-01', '2026-08'), false);
  // an overnight day (22:00 -> 02:00 next calendar date) stays WHOLE on its workDate
  const overnight = att('ans-maria', '2026-08-31', { inAt: ms('2026-08-31', '22:00'), outAt: ms('2026-09-01', '02:00') });
  const pkg = build({ attendanceStore: storeOf([overnight]) });
  const r = rowOf(pkg, 'ans-maria');
  assert.equal(r.payload.days.length, 1);
  assert.equal(r.payload.days[0].workDate, '2026-08-31');
  assert.equal(r.payload.actualHours, 4);                       // 4 h counted once, not split
  const sept = build({ periodId: '2026-09', attendanceStore: storeOf([overnight]) });
  assert.equal(rowOf(sept, 'ans-maria').payload.dayCount, 0);    // and never double-counted in M+1
});
t('P2', 'actual-time and break supersession are honored through the reused layer-B derivation', () => {
  // declared start supersedes observed; declared break supersedes observed and is NEVER added
  const a = att('ans-maria', '2026-08-03', {
    inAt: ms('2026-08-03', '07:45'), declaredStartAt: ms('2026-08-03', '08:00'),
    outAt: ms('2026-08-03', '16:10'), declaredEndAt: ms('2026-08-03', '16:00'),
    observedBreakMinutesTotal: 45, declaredBreakMinutesTotal: 30, breakCount: 2,
  });
  const r = rowOf(build({ attendanceStore: storeOf([a]) }), 'ans-maria');
  const d = r.payload.days[0];
  assert.equal(d.startSource, 'declared'); assert.equal(d.endSource, 'declared');
  assert.equal(d.minutes, 8 * 60 - 30);                          // declared span minus DECLARED break only
  assert.equal(d.breakRow.kind, 'declared'); assert.equal(d.breakRow.minutes, 30);
  assert.notEqual(d.minutes, 8 * 60 - 75);                       // the two break totals are never summed
  assert.equal(d.label, 'Oppgitt arbeidstid');
  assert.equal(r.payload.actualHours, 7.5);
  // an internally inconsistent day (break exceeds span) yields NO total and fails closed
  const bad = att('ans-aboud', '2026-08-04', { declaredBreakMinutesTotal: 600 });
  const rb = rowOf(build({ attendanceStore: storeOf([bad]) }), 'ans-aboud');
  assert.equal(rb.payload.days[0].minutes, null);
  assert.ok(rb.exceptions.some((x) => x.code === 'dag_uten_svar' && x.severity === 'hard'));
});
t('P3', 'planned time is comparison-only: changing it cannot move the accountant-facing payload', () => {
  const recs = storeOf([att('ans-maria', '2026-08-03'), att('ans-maria', '2026-08-04')]);
  const withPlan = build({ attendanceStore: recs, scheduleStore: scheduleOf([shiftFor('ans-maria', '2026-08-03', '08:00', '16:00'), shiftFor('ans-maria', '2026-08-04', '08:00', '16:00')]) });
  const noPlan = build({ attendanceStore: recs, scheduleStore: emptySchedule });
  assert.equal(JSON.stringify(accountantPayloadOf(withPlan)), JSON.stringify(accountantPayloadOf(noPlan)));
  assert.notEqual(rowOf(withPlan, 'ans-maria').comparison.plannedHours, rowOf(noPlan, 'ans-maria').comparison.plannedHours);
  // planned/variance are structurally absent from the payload
  const flat = JSON.stringify(accountantPayloadOf(withPlan));
  for (const k of ['planned', 'plannedHours', 'variance', 'varianceHours', 'comparison']) assert.ok(!flat.includes(k), 'payload leaked planned key: ' + k);
});
t('P4', 'no computed pay amount exists anywhere in package output', () => {
  const store = seedE();
  const emp = employeeOf(store, T, 'ans-maria');
  const pkg = buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: storeOf([att('ans-maria', '2026-08-03')]), tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  const flat = JSON.stringify(pkg).toLowerCase();
  for (const bad of ['grossPay', 'estimatedpay', 'employercost', 'holidaypay', 'feriepenger', 'skatt', 'tax', 'bruttolonn', 'sumlonn', 'topay', 'amountdue']) {
    assert.ok(!flat.includes(bad.toLowerCase()), 'computed pay leaked: ' + bad);
  }
  // the compensation BASIS is carried verbatim from terms; it is never multiplied by hours
  const r = rowOf(pkg, 'ans-maria');
  assert.equal(r.payload.compensation.model, 'timelonn');
  assert.equal(r.payload.compensation.hourlyRate, 250);
  assert.equal(r.payload.actualHours, 8);
  assert.ok(!Object.keys(r.payload).some((k) => /pay|belop|beløp|sum|total(kr|Kost)/i.test(k)));
  const src = fs.readFileSync(new URL('./management-payroll-core.mjs', import.meta.url), 'utf8');
  assert.ok(!/hourlyRate\s*\*/.test(src) && !/\*\s*hourlyRate/.test(src), 'source multiplies a rate');
  assert.ok(!/monthlySalary\s*\*/.test(src) && !/\*\s*monthlySalary/.test(src), 'source multiplies a salary');
});
t('P5', 'every employee employed at ANY point in the period appears; nobody is silently omitted', () => {
  const store = seedE();
  const pkg = buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: new Map(), tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  assert.equal(pkg.rows.length, 5);                              // all five seeded people
  // someone who ended mid-period is still present and named
  applyE(store, { kind: 'endEmployee', ansattId: 'ans-aboud', endDate: '2026-08-15' });
  const p2 = buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: new Map(), tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  assert.equal(p2.rows.length, 5);
  const ab = rowOf(p2, 'ans-aboud');
  assert.equal(ab.payload.employmentEndedInPeriod, '2026-08-15');
  assert.ok(ab.exceptions.some((x) => x.code === 'sluttet_i_perioden' && x.severity === 'warn'));
  // but someone who left BEFORE the period is out of scope
  const p3 = buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: new Map(), tenantId: T, periodId: '2026-10', generatedAt: NOW, todayWorkDate: TODAY });
  assert.ok(!p3.rows.some((r) => r.ansattId === 'ans-aboud'));
  const c = applyE(store, { kind: 'createEmployee', name: 'Nyansatt', startDate: '2026-08-20', role: 'butikkmedarbeider' });
  const p4 = buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: new Map(), tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  assert.ok(rowOf(p4, c.ansattId), 'employee starting mid-period must appear');
  assert.equal(rowOf(p4, c.ansattId).payload.employmentStartedInPeriod, '2026-08-20');
});
t('P6', 'fixed salary stays in the package as CONTEXT and never becomes a pay basis', () => {
  const pkg = build({ attendanceStore: storeOf([att('ans-herish', '2026-08-03')]) });
  const r = rowOf(pkg, 'ans-herish');                             // Herish is fastlønn in the fixture
  assert.equal(r.payload.fixedSalary, true);
  assert.equal(r.payload.compensation.model, 'fastlonn');
  assert.equal(r.payload.fixedSalaryNote, 'Fastlønn – timer er ikke lønnsgrunnlag');
  assert.equal(r.payload.actualHours, 8);                         // hours still shown, as context
  assert.equal(r.readiness, 'klar');                              // and never a block
  const noHours = build({});
  assert.ok(rowOf(noHours, 'ans-herish').exceptions.some((x) => x.code === 'fastlonn_uten_timer' && x.severity === 'warn'));
});
t('P7', 'declared hours with NO compensation basis is a HARD block and never becomes 0 kr', () => {
  const store = seedE();
  const c = applyE(store, { kind: 'createEmployee', name: 'Uten Basis', startDate: '2026-08-01', role: 'butikkmedarbeider' });
  const pkg = buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: storeOf([att(c.ansattId, '2026-08-05')]), tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  const r = rowOf(pkg, c.ansattId);
  assert.equal(r.payload.compensation, null);
  assert.equal(r.payload.compensationMissing, true);
  assert.ok(r.exceptions.some((x) => x.code === 'mangler_lonnsbasis' && x.severity === 'hard'));
  assert.equal(r.readiness, 'krever_oppmerksomhet');
  assert.equal(pkg.readiness.ready, false);
  const flat = JSON.stringify(r.payload);
  assert.ok(!flat.includes('"0 kr"') && !flat.includes('"hourlyRate":0'), 'missing basis must never render as zero');
  // and approval is refused while it stands
  const ps = createPayrollStore();
  const res = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg, now: NOW });
  assert.equal(res.ok, false); assert.equal(res.code, 'NOT_READY');
  assert.ok(res.blocking.some((b) => b.ansattId === c.ansattId && b.causes.includes('mangler_lonnsbasis')));
});
t('P8', 'hard vs warn classification is exact, named per employee per cause, never a red wall', () => {
  const open = att('ans-maria', '2026-08-06', { outAt: null, declaredEndAt: null, status: 'clocked_in' });
  const pkg = build({ attendanceStore: storeOf([open]), scheduleStore: scheduleOf([shiftFor('ans-yussef', '2026-08-07', '09:00', '15:00')]) });
  const maria = rowOf(pkg, 'ans-maria');
  assert.ok(maria.exceptions.some((x) => x.code === 'aapen_oekt' && x.severity === 'hard'));
  assert.equal(maria.readiness, 'krever_oppmerksomhet');
  const yussef = rowOf(pkg, 'ans-yussef');
  assert.ok(yussef.exceptions.some((x) => x.code === 'planlagt_uten_faktisk' && x.severity === 'warn'));
  assert.equal(yussef.readiness, 'klar');                         // a warning never blocks
  // blocking is reported per employee with named causes
  assert.deepEqual(pkg.readiness.blockingEmployees.map((b) => b.ansattId), ['ans-maria']);
  assert.deepEqual(pkg.readiness.blockingEmployees[0].causes, ['aapen_oekt']);
  for (const r of pkg.rows) for (const x of r.exceptions) {
    assert.ok(x.code && x.label && (x.severity === 'hard' || x.severity === 'warn'));
    assert.ok(HARD_EXCEPTIONS.includes(x.code) || WARN_EXCEPTIONS.includes(x.code), 'unclassified exception: ' + x.code);
    assert.equal(HARD_EXCEPTIONS.includes(x.code), x.severity === 'hard');
  }
  // large variance warns, small variance does not
  const long = att('ans-athar', '2026-08-10', { outAt: ms('2026-08-10', '20:00') });   // 12 h actual vs 8 h planned
  const varPkg = build({ attendanceStore: storeOf([long]), scheduleStore: scheduleOf([shiftFor('ans-athar', '2026-08-10', '08:00', '16:00')]) });
  assert.ok(rowOf(varPkg, 'ans-athar').exceptions.some((x) => x.code === 'stort_avvik' && x.severity === 'warn'));
  assert.equal(VARIANCE_TOLERANCE_HOURS, 2);
});
t('P9', 'approval freezes a VALUE snapshot; later live source changes do not move vN', () => {
  const store = seedE();
  const recs = storeOf([att('ans-maria', '2026-08-03')]);
  const pkg = buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: recs, tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  const ps = createPayrollStore();
  const res = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg, now: NOW, operatorName: 'Herish' });
  assert.equal(res.ok, true, res.code);
  const v1 = res.version;
  const before = JSON.stringify(v1);
  assert.equal(v1.status, PACKAGE_STATUS.APPROVED);
  assert.equal(v1.snapshot.rows.find((r) => r.ansattId === 'ans-maria').payload.actualHours, 8);
  // change the live source afterwards, in both truth stores
  recs.set('att-ans-maria-2026-08-20', att('ans-maria', '2026-08-20'));
  applyE(store, { kind: 'appendTerms', ansattId: 'ans-maria', terms: { validFrom: '2026-08-20', role: 'butikksjef', compensation: { model: 'fastlonn', monthlySalary: 51000 } } });
  const after = latestVersionOf(ps, T, PERIOD);
  assert.equal(JSON.stringify(after), before);                    // byte-stable
  assert.equal(after.snapshot.rows.find((r) => r.ansattId === 'ans-maria').payload.actualHours, 8);
  assert.equal(after.snapshot.rows.find((r) => r.ansattId === 'ans-maria').payload.compensation.model, 'timelonn');
  assert.ok(Object.isFrozen(after) && Object.isFrozen(after.snapshot));
  // a fresh build DOES see the new truth — the snapshot is what is pinned, not the derivation
  const rebuilt = buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: recs, tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  assert.equal(rowOf(rebuilt, 'ans-maria').payload.actualHours, 16);
});
t('P10', 'corrected vN+1 preserves the prior approved/sent vN and never rewrites its snapshot', () => {
  const store = seedE();
  const recs = storeOf([att('ans-maria', '2026-08-03')]);
  const mk = () => buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: recs, tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  const ps = createPayrollStore();
  const v1 = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg: mk(), now: NOW, operatorName: 'Herish' }).version;
  applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'markSentToAccountant', periodId: PERIOD, packageVersionId: v1.packageVersionId }, now: NOW, operatorName: 'Herish' });
  const v1Sent = versionsOf(ps, T, PERIOD)[0];
  const v1Json = JSON.stringify(v1Sent);
  assert.equal(v1Sent.status, PACKAGE_STATUS.SENT);
  // correction: new draft from current truth
  const d = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'createCorrectedVersion', periodId: PERIOD, packageVersionId: v1.packageVersionId }, now: NOW });
  assert.equal(d.ok, true, d.code);
  assert.equal(d.version.status, PACKAGE_STATUS.DRAFT);
  assert.equal(d.version.supersedes, v1.packageVersionId);
  assert.equal(JSON.stringify(versionsOf(ps, T, PERIOD)[0]), v1Json);   // vN untouched while draft exists
  recs.set('att-ans-maria-2026-08-20', att('ans-maria', '2026-08-20'));
  const v2 = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD, supersedes: v1.packageVersionId }, pkg: mk(), now: NOW, operatorName: 'Herish' }).version;
  const all = versionsOf(ps, T, PERIOD);
  const finalV1 = all.find((x) => x.packageVersionId === v1.packageVersionId);
  assert.equal(finalV1.status, PACKAGE_STATUS.SUPERSEDED);
  assert.equal(finalV1.supersededBy, v2.packageVersionId);
  assert.equal(finalV1.deliveries.length, 1);                     // prior sent history preserved
  assert.equal(JSON.stringify(finalV1.snapshot), JSON.stringify(v1Sent.snapshot));  // snapshot never rewritten
  assert.equal(v2.snapshot.rows.find((r) => r.ansattId === 'ans-maria').payload.actualHours, 16);
});
t('P11', 'manual delivery attaches only to an approved version and records channel=manuell honestly', () => {
  const ps = createPayrollStore();
  const pkg = build({ attendanceStore: storeOf([att('ans-maria', '2026-08-03')]) });
  // cannot deliver what does not exist / is not approved
  assert.equal(applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'markSentToAccountant', periodId: PERIOD, packageVersionId: 'lg-2026-08-v1' }, now: NOW }).code, 'VERSION_UNKNOWN');
  const v1 = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg, now: NOW, operatorName: 'Herish' }).version;
  const bad = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'markSentToAccountant', periodId: PERIOD, packageVersionId: v1.packageVersionId, channel: 'epost' }, now: NOW });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'CHANNEL_NOT_SUPPORTED');   // no external channel is reachable
  const sent = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'markSentToAccountant', periodId: PERIOD, packageVersionId: v1.packageVersionId, recipient: 'regnskapsfører' }, now: NOW, operatorName: 'Herish' });
  assert.equal(sent.ok, true, sent.code);
  assert.equal(sent.delivery.channel, DELIVERY_CHANNELS.MANUAL);
  assert.equal(sent.delivery.at, NOW);
  assert.equal(sent.delivery.by.verified, false);
  assert.equal(sent.version.status, PACKAGE_STATUS.SENT);
  assert.deepEqual(Object.keys(FUTURE_DELIVERY_CHANNELS).sort(), ['EMAIL', 'PORTAL']);   // declared, unreachable
});
t('P12', 'unconfigured payroll policy invents no dates; a supplied policy derives states correctly', () => {
  assert.equal(FOUR_SEASON_PAYROLL_POLICY, null);                 // owner-unconfirmed, never fabricated
  const un = payrollCalendarStateFor(PERIOD, FOUR_SEASON_PAYROLL_POLICY, TODAY);
  assert.equal(un.configured, false);
  assert.equal(un.targetDate, null); assert.equal(un.hardDate, null); assert.equal(un.daysRemaining, null);
  assert.ok(un.label.includes('ikke konfigurert'));
  assert.equal(build({}).calendar.configured, false);              // and the built package says so
  assert.equal(isCompletePayrollPolicy({ salaryDayOfMonth: 15, targetAccountantDay: 5 }), false);
  // synthetic configured policy (test-only) proves the pure date logic
  const P = { salaryDayOfMonth: 15, targetAccountantDay: 5, minimumLeadDays: 5, weekendAdjustment: 'none' };
  const s = payrollCalendarStateFor('2026-08', P, '2026-09-01');
  assert.equal(s.configured, true);
  assert.equal(s.targetDate, '2026-09-05');
  assert.equal(s.salaryDate, '2026-09-15');
  assert.equal(s.hardDate, '2026-09-10');                         // salary date minus lead days
  assert.equal(s.daysRemaining, 9);
  assert.equal(s.state, 'ok');
  assert.equal(payrollCalendarStateFor('2026-08', P, '2026-09-05').state, 'maal_passert');
  assert.equal(payrollCalendarStateFor('2026-08', P, '2026-09-07').state, 'advarsel');
  assert.equal(payrollCalendarStateFor('2026-08', P, '2026-09-11').state, 'forfalt');
  assert.equal(payrollCalendarStateFor('2026-08', P, '2026-09-11').daysRemaining, -1);
  assert.equal(s.weekendAdjustment, 'none');                      // explicit named policy, not silent
});
t('P13', 'Employee 360 projection returns the IDENTICAL approved-hours/version truth, no recompute', () => {
  const store = seedE();
  const recs = storeOf([att('ans-maria', '2026-08-03'), att('ans-maria', '2026-08-04')]);
  const pkg = buildPayrollPackage({ employeeStore: store, scheduleStore: emptySchedule, attendanceStore: recs, tenantId: T, periodId: PERIOD, generatedAt: NOW, todayWorkDate: TODAY });
  const ps = createPayrollStore();
  const v1 = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg, now: NOW, operatorName: 'Herish' }).version;
  const proj = payrollProjectionForEmployee(ps, T, 'ans-maria', PERIOD);
  const snapRow = v1.snapshot.rows.find((r) => r.ansattId === 'ans-maria');
  assert.equal(proj.packageVersionId, v1.packageVersionId);
  assert.equal(proj.version, v1.version);
  assert.equal(proj.periodId, PERIOD);
  assert.equal(proj.status, PACKAGE_STATUS.APPROVED);
  assert.equal(proj.actualHours, snapRow.payload.actualHours);     // same bytes, not a recomputation
  assert.equal(proj.approvedHours, snapRow.payload.approvedHours);
  assert.deepEqual(proj.compensation, snapRow.payload.compensation);
  // it keeps returning the SNAPSHOT truth after the live source moves
  recs.set('att-ans-maria-2026-08-20', att('ans-maria', '2026-08-20'));
  assert.equal(payrollProjectionForEmployee(ps, T, 'ans-maria', PERIOD).actualHours, snapRow.payload.actualHours);
  applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'markSentToAccountant', periodId: PERIOD, packageVersionId: v1.packageVersionId }, now: NOW });
  const after = payrollProjectionForEmployee(ps, T, 'ans-maria', PERIOD);
  assert.equal(after.status, PACKAGE_STATUS.SENT);
  assert.equal(after.sentAt, NOW); assert.equal(after.sentChannel, DELIVERY_CHANNELS.MANUAL);
  assert.equal(payrollProjectionForEmployee(ps, T, 'ans-nobody', PERIOD), null);
});
t('P14', 'claimed operator identity is labelled unverified and introduces no auth claim', () => {
  const ps = createPayrollStore();
  const v1 = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg: build({}), now: NOW, operatorName: 'Herish' }).version;
  assert.equal(v1.approvedBy.name, 'Herish');
  assert.equal(v1.approvedBy.verified, false);
  const flat = JSON.stringify(v1).toLowerCase();
  for (const bad of ['authenticated', 'signedin', 'verifiedidentity', 'token', 'bankid', 'password']) assert.ok(!flat.includes(bad), 'auth claim leaked: ' + bad);
  // package approval consumes existing per-record approval and states the remainder plainly
  const rec = att('ans-maria', '2026-08-03', { status: 'approved' });
  const pkg2 = build({ attendanceStore: storeOf([rec, att('ans-maria', '2026-08-04')]) });
  const ps2 = createPayrollStore();
  const v = applyPayrollOperation({ store: ps2, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg: pkg2, now: NOW, operatorName: 'Herish' }).version;
  assert.equal(v.approvedDayCounts.total, 2);
  assert.equal(v.approvedDayCounts.alreadyApproved, 1);
  assert.equal(v.approvedDayCounts.approvedByPackage, 1);
  assert.equal(rowOf(pkg2, 'ans-maria').payload.approvedDayCount, 1);
  // capability gate holds
  assert.equal(applyPayrollOperation({ store: createPayrollStore(), tenantId: T, actor: { accessEnabled: true }, op: { kind: 'approvePackage', periodId: PERIOD }, pkg: build({}), now: NOW }).code, 'NOT_AUTHORIZED');
});
t('P15', 'the package read path never imports, reads or writes layer-C payable truth', () => {
  const src = fs.readFileSync(new URL('./management-payroll-core.mjs', import.meta.url), 'utf8');
  const fromPaths = (src.match(/from '\.\/[^']+'/g) || []).map((s) => s.slice(6).replace(/'/g, ''));
  assert.deepEqual(fromPaths.sort(), ['./employee-shell-core.mjs', './management-employees-core.mjs']);
  // exactly two dependencies: layer B and the canonical employee/terms core — nothing else
  for (const forbidden of ['index.html', 'firebase', 'firestore', './RouteA', 'vakter', 'dbAll', 'dbFind', 'LOCAL[']) {
    assert.ok(!src.includes(forbidden), 'layer-C/legacy reference: ' + forbidden);
  }
  // layer B itself has no imports at all, so reading it cannot pull in layer C
  const layerB = fs.readFileSync(new URL('./employee-shell-core.mjs', import.meta.url), 'utf8');
  assert.equal(layerB.split('\n').filter((l) => l.startsWith('import ')).length, 0);
  const view = fs.readFileSync(new URL('./management-payroll-view.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['index.html', 'firebase', 'firestore', 'dbAll', 'dbFind', 'LOCAL[']) {
    assert.ok(!view.includes(forbidden), 'view touched layer C: ' + forbidden);
  }
});
t('P16', 'no legacy/payable write and no external-send function exists in this increment', () => {
  const src = fs.readFileSync(new URL('./management-payroll-core.mjs', import.meta.url), 'utf8');
  const view = fs.readFileSync(new URL('./management-payroll-view.mjs', import.meta.url), 'utf8');
  for (const s of [src, view]) {
    for (const bad of ['fetch(', 'XMLHttpRequest', 'sendMail', 'sendEmail', 'mailto:', 'navigator.sendBeacon', 'WebSocket', 'localStorage', 'sessionStorage']) {
      assert.ok(!s.includes(bad), 'external/persistent path found: ' + bad);
    }
  }
  // the only delivery kind reachable is the manual record
  assert.deepEqual(Object.values(DELIVERY_CHANNELS), ['manuell']);
  const ps = createPayrollStore();
  const v1 = applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg: build({}), now: NOW }).version;
  for (const kind of ['sendToAccountant', 'transmit', 'export', 'writePayable', 'postToLedger']) {
    assert.equal(applyPayrollOperation({ store: ps, tenantId: T, actor: MGR, op: { kind, periodId: PERIOD, packageVersionId: v1.packageVersionId }, now: NOW }).code, 'UNKNOWN_OPERATION');
  }
  // named absent capabilities are printed, never silently zero
  assert.equal(UNSUPPORTED_CAPABILITIES.length, 2);
  assert.ok(build({}).unsupported.every((u) => typeof u.note === 'string' && u.note.includes('regnskapsfører')));
});

// ---- 3B-FOUNDATION: readiness distinction + package immutability under attested mutation ----
// A management-attested day: no observed receipts, complete declared pair, manager source.
function attested(ansattId, workDate, o) {
  const opts = o || {};
  return {
    attendanceId: 'manual-' + workDate + '-' + ansattId, shiftId: null, ansattId, workDate,
    plannedSnapshot: null, plannedShiftRevision: null,
    observedClockInAt: null, observedClockOutAt: null,
    declaredStartAt: opts.startAt === undefined ? ms(workDate, '08:00') : opts.startAt,
    declaredEndAt: opts.endAt === undefined ? ms(workDate, '16:00') : opts.endAt,
    approvedStartAt: null, approvedEndAt: null, approvedByUid: null, approvedAt: null,
    status: opts.status || 'attested',
    breakState: 'working', openBreakStartedAt: null,
    observedBreakMinutesTotal: 0,
    declaredBreakMinutesTotal: opts.breakMinutes === undefined ? 30 : opts.breakMinutes,
    approvedBreakMinutesTotal: null, breakCount: 0,
    declarationSource: 'manager',
    revision: 1, createdAt: NOW, updatedAt: NOW,
  };
}
t('PT11', 'readiness tri-distinction: unanswered HARD, attested resolved + INFO, partial HARD', () => {
  // (a) truly unanswered — a closed record that yields no total: unchanged HARD dag_uten_svar
  const unanswered = att('ans-maria', '2026-08-03', { outAt: null, status: 'clocked_out' });
  const ra = rowOf(build({ attendanceStore: storeOf([unanswered]) }), 'ans-maria');
  assert.ok(ra.exceptions.some((x) => x.code === 'dag_uten_svar' && x.severity === 'hard'));
  assert.equal(ra.payload.actualMinutes, 0);
  // (b) management-attested complete day: real minutes, NO dag_uten_svar, INFO mark + count
  const rb = rowOf(build({ attendanceStore: storeOf([attested('ans-maria', '2026-08-03')]) }), 'ans-maria');
  assert.equal(rb.payload.actualMinutes, 450, '8h minus a 30-min declared break');
  assert.equal(rb.exceptions.some((x) => x.code === 'dag_uten_svar'), false, 'management answered it');
  assert.equal(rb.attestedDayCount, 1);
  assert.deepEqual(rb.infoMarks, [{ code: 'fort_av_ledelse', severity: 'info', label: 'Ført av ledelse', detail: '1 dag' }]);
  assert.equal(rb.readiness, 'klar');
  // the INFO mark is NOT a finding: hard/warn doctrine is untouched by construction
  assert.equal(rb.exceptions.some((x) => x.severity === 'info'), false, 'info never enters exceptions');
  assert.equal(rb.payload.days[0].fortAvLedelse, true);
  assert.equal(rb.payload.days[0].declarationSource, 'manager');
  assert.equal(rb.payload.attestedDayCount, 1);
  // (c) partial manager declaration (no end): still unresolved and HARD
  const rc = rowOf(build({ attendanceStore: storeOf([attested('ans-maria', '2026-08-04', { endAt: null })]) }), 'ans-maria');
  assert.ok(rc.exceptions.some((x) => x.code === 'dag_uten_svar' && x.severity === 'hard'));
  assert.equal(rc.payload.actualMinutes, 0);
  // a clock-origin day carries no attested marker
  const rd = rowOf(build({ attendanceStore: storeOf([att('ans-maria', '2026-08-05')]) }), 'ans-maria');
  assert.equal(rd.attestedDayCount, 0); assert.deepEqual(rd.infoMarks, []);
  assert.equal(rd.payload.days[0].fortAvLedelse, false);
});
t('PT12', 'approved package vN stays byte-identical after a later attested mutation; vN+1 sees it', () => {
  const store = createPayrollStore();
  const recs = new Map();
  const pkg1 = build({ attendanceStore: recs });
  const ap = applyPayrollOperation({ store, tenantId: T, actor: MGR, op: { kind: 'approvePackage', periodId: PERIOD }, pkg: pkg1, now: NOW, operatorName: 'Herish' });
  assert.ok(ap.ok, ap.code);
  const vN = versionsOf(store, T, PERIOD)[0];
  const frozenBytes = JSON.stringify(vN.snapshot);
  // now management enters a day that did not exist when vN was approved
  const a = attested('ans-maria', '2026-08-06');
  recs.set(a.attendanceId, a);
  const pkg2 = build({ attendanceStore: recs });
  assert.equal(rowOf(pkg2, 'ans-maria').payload.actualMinutes, 450, 'a fresh build sees the new truth');
  assert.equal(JSON.stringify(versionsOf(store, T, PERIOD)[0].snapshot), frozenBytes, 'vN did not move');
  // only the corrected version carries it forward
  const corr = applyPayrollOperation({ store, tenantId: T, actor: MGR, op: { kind: 'createCorrectedVersion', periodId: PERIOD, packageVersionId: vN.packageVersionId }, pkg: pkg2, now: NOW, operatorName: 'Herish' });
  assert.ok(corr.ok, corr.code);
  assert.equal(JSON.stringify(versionsOf(store, T, PERIOD)[0].snapshot), frozenBytes, 'vN still did not move');
});
t('PT13b', 'attested days add no planned values and never reach the accountant payload as plan', () => {
  const recs = storeOf([attested('ans-maria', '2026-08-03')]);
  const withPlan = build({ attendanceStore: recs, scheduleStore: scheduleOf([shiftFor('ans-maria', '2026-08-03', '08:00', '16:00')]) });
  const noPlan = build({ attendanceStore: recs, scheduleStore: emptySchedule });
  assert.notEqual(rowOf(withPlan, 'ans-maria').comparison.plannedHours, rowOf(noPlan, 'ans-maria').comparison.plannedHours);
  assert.equal(JSON.stringify(accountantPayloadOf(withPlan)), JSON.stringify(accountantPayloadOf(noPlan)), 'payload is plan-free');
  const payloadText = JSON.stringify(accountantPayloadOf(withPlan));
  assert.ok(payloadText.includes('fortAvLedelse'), 'origin provenance IS carried to the accountant');
  assert.equal(payloadText.includes('plannedHours'), false);
});

console.log(lines.join('\n'));
console.log('MANAGEMENT_PAYROLL_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
