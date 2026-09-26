// management-payroll-core.mjs
// MONTHLY LØNNSGRUNNLAG — INCREMENT 2 FOUNDATION. PURE. No DOM, no clock read, no storage,
// no network. Governing: SOREN-SIRRHA-EMPLOYEE-360-CONTRACT-AND-PAYROLL-HANDOFF-DESIGN-001
// §5–§10 + SIRRHA-CCODE-LONNSGRUNNLAG-INCREMENT-2-BUILD-RELEASE-001.
//
// THIS IS AN INPUT TO PAYROLL, NEVER PAYABLE TRUTH.
//  - PAYROLL-GRADE TIME = ACTUAL attendance truth (layer B) at its highest supersession, read
//    ONLY through the existing pure derivation daySummaryFor() — declared supersedes observed,
//    declaredBreakMinutesTotal supersedes observed break and is NEVER additive, net minutes are
//    floored. This module re-derives none of that arithmetic.
//  - PLANNED (Vaktplan, layer A) is COMPARISON ONLY. It lives in `comparison`, never in
//    `payload`. Removing or changing every planned input cannot change one byte the accountant
//    receives (proven, P3).
//  - COMPENSATION BASIS comes from the employment-terms projection for the period.
//  - LEGACY PAYABLE TRUTH (the old economy app's employee/shift collections, truth layer C) is
//    NOT READ and NOT WRITTEN. This module imports exactly two paths: layer B and the canonical
//    employee/terms core. It has no access route to layer C at all.
//  - NO COMPUTED PAY: no hours × rate, no gross, no estimate, no employer cost, no tax, no
//    holiday pay, no overtime or supplement amount. The accountant computes pay.
//  - Capabilities the product does not carry (overtime/supplements, absence/leave) are NAMED,
//    never silently zero (UNSUPPORTED_CAPABILITIES).

import { daySummaryFor } from './employee-shell-core.mjs';
import {
  employeesOf, employeeOf, startDateOf, currentTermsOf, plannedHoursForEmployee,
} from './management-employees-core.mjs';

export const PACKAGE_STATUS = Object.freeze({ DRAFT: 'utkast', APPROVED: 'godkjent', SENT: 'sendt', SUPERSEDED: 'erstattet' });
// v1 delivers NOTHING. 'manuell' records that the owner handed the package over himself.
// The other channels are declared shapes only — no local operation can reach them.
export const DELIVERY_CHANNELS = Object.freeze({ MANUAL: 'manuell' });
export const FUTURE_DELIVERY_CHANNELS = Object.freeze({ EMAIL: 'epost', PORTAL: 'portal' });

// Comparison tolerance for the planned-vs-actual WARNING. Owned by this module as a review
// aid — it is not a payroll fact and never touches the accountant payload.
export const VARIANCE_TOLERANCE_HOURS = 2;

// Named absent capabilities (design §5.5): printed, never silently zero.
export const UNSUPPORTED_CAPABILITIES = Object.freeze([
  { key: 'overtid', label: 'Overtid og tillegg', note: 'ikke støttet ennå – føres av regnskapsfører' },
  { key: 'fravaer', label: 'Fravær og permisjon', note: 'ikke støttet ennå – føres av regnskapsfører' },
]);

export const HARD_EXCEPTIONS = Object.freeze(['aapen_oekt', 'dag_uten_svar', 'mangler_lonnsbasis']);
export const WARN_EXCEPTIONS = Object.freeze(['stort_avvik', 'planlagt_uten_faktisk', 'startet_i_perioden', 'sluttet_i_perioden', 'fastlonn_uten_timer']);
const EXCEPTION_LABELS = {
  aapen_oekt: 'Åpen økt', dag_uten_svar: 'Dag uten svar', mangler_lonnsbasis: 'Mangler lønnsbasis',
  stort_avvik: 'Stort avvik plan/faktisk', planlagt_uten_faktisk: 'Planlagt uten faktisk',
  startet_i_perioden: 'Startet i perioden', sluttet_i_perioden: 'Sluttet i perioden',
  fastlonn_uten_timer: 'Fastlønn uten timer',
};
// NOTE: an "unresolved correction" hard block is deliberately ABSENT. Recon R2.3 established
// that the built attendance model concludes every edit/correction immediately (statuses are
// assigned | clocked_in | clocked_out | approved only); inventing a pending-correction state
// would fabricate a condition the product cannot be in.

const WD_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-\d{2}$/;
const MONTHS_NB = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

// ---- PERIOD IDENTITY / PLACEMENT -------------------------------------------------------------
// Period identity is YYYY-MM. A day belongs to the period of its tenant-local workDate — the
// frozen placement rule. An overnight shift therefore lands WHOLE on its workDate; v1 never
// splits a day across calendar dates.
export function periodIdOf(year, month) {
  const m = String(month).padStart(2, '0');
  return String(year) + '-' + m;
}
export function isValidPeriodId(periodId) { return typeof periodId === 'string' && PERIOD_RE.test(periodId); }
export function periodOfWorkDate(workDate) { return (typeof workDate === 'string' && WD_RE.test(workDate)) ? workDate.slice(0, 7) : null; }
export function workDateInPeriod(workDate, periodId) { return isValidPeriodId(periodId) && periodOfWorkDate(workDate) === periodId; }
export function periodLabel(periodId) {
  if (!isValidPeriodId(periodId)) return '—';
  const y = periodId.slice(0, 4), m = Number(periodId.slice(5, 7));
  return (MONTHS_NB[m - 1] || periodId) + ' ' + y;
}
export function periodTitle(periodId) { return 'Lønnsgrunnlag · ' + periodLabel(periodId); }
export function periodScope(periodId) {
  return { kind: 'month', year: Number(periodId.slice(0, 4)), month: Number(periodId.slice(5, 7)) };
}
function daysInPeriod(periodId) {
  const y = Number(periodId.slice(0, 4)), m = Number(periodId.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function periodBounds(periodId) {
  if (!isValidPeriodId(periodId)) return null;
  return { first: periodId + '-01', last: periodId + '-' + String(daysInPeriod(periodId)).padStart(2, '0') };
}
export function addMonths(periodId, delta) {
  const y = Number(periodId.slice(0, 4)), m = Number(periodId.slice(5, 7));
  const t = (y * 12 + (m - 1)) + delta;
  return periodIdOf(Math.floor(t / 12), (t % 12) + 1);
}

// ---- PAYROLL CALENDAR (design §8) ------------------------------------------------------------
// POLICY SHAPE + pure derived state only. The live Four Season values are NOT configured here:
// the real salary payment date/arrangement is still owner-unconfirmed, so nothing is invented.
// An unconfigured policy yields an honest "not configured" state and NO countdown/deadline.
// A fully supplied policy (tests, or a later owner-confirmed config) derives the real states.
export const FOUR_SEASON_PAYROLL_POLICY = null;   // owner-unconfirmed — never fabricate dates
export function isCompletePayrollPolicy(p) {
  return !!(p && typeof p === 'object'
    && Number.isInteger(p.salaryDayOfMonth) && p.salaryDayOfMonth >= 1 && p.salaryDayOfMonth <= 31
    && Number.isInteger(p.targetAccountantDay) && p.targetAccountantDay >= 1 && p.targetAccountantDay <= 31
    && Number.isInteger(p.minimumLeadDays) && p.minimumLeadDays >= 0
    && typeof p.weekendAdjustment === 'string');
}
function clampDay(periodId, day) { return periodId + '-' + String(Math.min(day, daysInPeriod(periodId))).padStart(2, '0'); }
function shiftWorkDate(wd, deltaDays) {
  const [y, m, d] = wd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + deltaDays);
  return t.toISOString().slice(0, 10);
}
function daysBetween(fromWd, toWd) {
  const a = Date.UTC(Number(fromWd.slice(0, 4)), Number(fromWd.slice(5, 7)) - 1, Number(fromWd.slice(8, 10)));
  const b = Date.UTC(Number(toWd.slice(0, 4)), Number(toWd.slice(5, 7)) - 1, Number(toWd.slice(8, 10)));
  return Math.round((b - a) / 86400000);
}
export function payrollCalendarStateFor(periodId, policy, todayWorkDate) {
  if (!isValidPeriodId(periodId) || !isCompletePayrollPolicy(policy)) {
    return { configured: false, state: 'ikke_konfigurert', label: 'Lønnsfrist ikke konfigurert', note: 'Lønnsdato og frist for regnskapsfører er ikke bekreftet av eier ennå.', targetDate: null, hardDate: null, daysRemaining: null };
  }
  const next = addMonths(periodId, 1);
  const targetDate = clampDay(next, policy.targetAccountantDay);
  const salaryDate = clampDay(next, policy.salaryDayOfMonth);
  const hardDate = shiftWorkDate(salaryDate, -policy.minimumLeadDays);
  // weekendAdjustment is an explicit named policy value; v1 applies no silent business-day rule.
  const daysRemaining = (typeof todayWorkDate === 'string' && WD_RE.test(todayWorkDate)) ? daysBetween(todayWorkDate, hardDate) : null;
  let state = 'ok';
  if (daysRemaining != null) {
    if (todayWorkDate > hardDate) state = 'forfalt';
    else if (todayWorkDate > targetDate) state = 'advarsel';
    else if (todayWorkDate === targetDate) state = 'maal_passert';
  }
  return { configured: true, state, label: null, targetDate, hardDate, salaryDate, daysRemaining, weekendAdjustment: policy.weekendAdjustment };
}

// ---- CANONICAL READS -------------------------------------------------------------------------
function attendanceRecordsFor(attendanceStore, ansattId, periodId) {
  const out = [];
  if (!attendanceStore) return out;
  const values = typeof attendanceStore.values === 'function' ? Array.from(attendanceStore.values())
    : (Array.isArray(attendanceStore) ? attendanceStore : Object.keys(attendanceStore).map((k) => attendanceStore[k]));
  for (const a of values) {
    if (!a || a.ansattId !== ansattId) continue;
    if (!workDateInPeriod(a.workDate, periodId)) continue;
    out.push(a);
  }
  return out.sort((x, y) => (x.workDate < y.workDate ? -1 : x.workDate > y.workDate ? 1 : 0));
}
function compensationOfTerms(terms) {
  const c = terms && terms.compensation;
  if (!c) return null;
  if (c.model === 'timelonn') return { model: 'timelonn', hourlyRate: c.hourlyRate, label: 'Timelønn kr ' + c.hourlyRate + ' per time' };
  return { model: 'fastlonn', monthlySalary: c.monthlySalary, label: 'Fastlønn kr ' + c.monthlySalary + ' per måned' };
}
const hoursOf = (min) => Math.round((min / 60) * 100) / 100;

// ---- PACKAGE BUILD ---------------------------------------------------------------------------
// Pure over the canonical stores. `payload` is the ACCOUNTANT-FACING truth and contains only
// actual/approved time, compensation basis and hard findings. `comparison` holds planned time
// and variance and is MANAGER-ONLY — no payload field derives from it (P3).
export function buildPayrollPackage({ employeeStore, scheduleStore, attendanceStore, tenantId, periodId, generatedAt, todayWorkDate, payrollPolicy }) {
  if (!isValidPeriodId(periodId)) return null;
  const bounds = periodBounds(periodId);
  const scope = periodScope(periodId);
  const rows = [];
  for (const e of employeesOf(employeeStore, tenantId)) {
    const started = startDateOf(e);
    const ended = e.status === 'active' ? null : (e.endedAt || null);
    // Every employee employed at ANY point in the period appears — nobody is silently omitted.
    if (started && started > bounds.last) continue;
    if (ended && ended < bounds.first) continue;
    const terms = currentTermsOf(e, bounds.last) || currentTermsOf(e, bounds.first) || (e.terms && e.terms[e.terms.length - 1]) || null;
    const compensation = compensationOfTerms(terms);
    const fixedSalary = !!(compensation && compensation.model === 'fastlonn');

    const records = attendanceRecordsFor(attendanceStore, e.ansattId, periodId);
    const days = [];
    let actualMinutes = 0, approvedMinutes = 0, approvedDayCount = 0, openSessions = 0, unresolvedDays = 0, attestedDays = 0;
    for (const a of records) {
      const sum = daySummaryFor({ attendance: a });        // THE reused layer-B derivation
      const dayExceptions = [];
      const open = a.status === 'clocked_in' || (sum && sum.onBreak);
      if (open) { openSessions += 1; dayExceptions.push('aapen_oekt'); }
      // observed activity with no resolvable answer: a closed record that still yields no total
      else if (!sum || sum.total == null) { unresolvedDays += 1; dayExceptions.push('dag_uten_svar'); }
      const minutes = sum && sum.total ? sum.total.minutes : null;
      if (minutes != null) actualMinutes += minutes;
      // 3B-FOUNDATION §K: a day management ANSWERED is resolved truth, not an unanswered hole —
      // it resolves above (sum.total is non-null) and so never reaches dag_uten_svar. It is
      // still LABELLED, never silent: the marker rides on the day line and is counted per row.
      // Deliberately NOT pushed into `exceptions` — that array is the hard/warn doctrine and is
      // rendered as findings badges; an INFO fact must not masquerade as a finding.
      if (a.declarationSource === 'manager' && a.observedClockInAt == null && a.observedClockOutAt == null) attestedDays += 1;
      const recordApproved = a.status === 'approved';
      if (recordApproved && minutes != null) { approvedMinutes += minutes; approvedDayCount += 1; }
      days.push({
        workDate: a.workDate,
        startAt: sum ? sum.start.at : null, startSource: sum ? sum.start.source : null,
        endAt: sum ? sum.end.at : null, endSource: sum ? sum.end.source : null,
        breakRow: sum ? sum.breakRow : null, anyDeclared: sum ? sum.anyDeclared : false,
        minutes, hours: minutes == null ? null : hoursOf(minutes),
        label: sum && sum.total ? sum.total.label : null,
        // provenance the accountant legitimately cares about: which days were management-entered.
        declarationSource: a.declarationSource || null,
        fortAvLedelse: a.declarationSource === 'manager' && a.observedClockInAt == null && a.observedClockOutAt == null,
        recordApproved, exceptions: dayExceptions,
      });
    }

    const exceptions = [];
    const addEx = (code, severity, detail) => exceptions.push({ code, severity, label: EXCEPTION_LABELS[code] || code, detail: detail || null });
    if (openSessions > 0) addEx('aapen_oekt', 'hard', openSessions + (openSessions === 1 ? ' dag' : ' dager'));
    if (unresolvedDays > 0) addEx('dag_uten_svar', 'hard', unresolvedDays + (unresolvedDays === 1 ? ' dag' : ' dager'));
    // declared hours with no compensation basis is a HARD block — never rendered as 0 kr.
    if (!compensation && actualMinutes > 0) addEx('mangler_lonnsbasis', 'hard', null);
    if (started && workDateInPeriod(started, periodId)) addEx('startet_i_perioden', 'warn', started);
    if (ended && workDateInPeriod(ended, periodId)) addEx('sluttet_i_perioden', 'warn', ended);

    // ---- comparison only (planned) — never part of payload ----
    const plannedHours = plannedHoursForEmployee(scheduleStore, tenantId, e.ansattId, scope);
    const actualHours = hoursOf(actualMinutes);
    const varianceHours = Math.round((actualHours - plannedHours) * 100) / 100;
    if (plannedHours > 0 && records.length === 0) addEx('planlagt_uten_faktisk', 'warn', plannedHours + ' t planlagt');
    if (plannedHours > 0 && records.length > 0 && Math.abs(varianceHours) > VARIANCE_TOLERANCE_HOURS) addEx('stort_avvik', 'warn', varianceHours + ' t');
    if (fixedSalary && actualMinutes === 0) addEx('fastlonn_uten_timer', 'warn', null);

    const hardCount = exceptions.filter((x) => x.severity === 'hard').length;
    rows.push({
      ansattId: e.ansattId, name: e.name,
      payload: {
        ansattId: e.ansattId, name: e.name,
        compensation, compensationMissing: !compensation, fixedSalary,
        fixedSalaryNote: fixedSalary ? 'Fastlønn – timer er ikke lønnsgrunnlag' : null,
        actualMinutes, actualHours,
        approvedMinutes, approvedHours: hoursOf(approvedMinutes), approvedDayCount,
        dayCount: days.length,
        employmentStartedInPeriod: started && workDateInPeriod(started, periodId) ? started : null,
        employmentEndedInPeriod: ended && workDateInPeriod(ended, periodId) ? ended : null,
        attestedDayCount: attestedDays,
        days: days.map((d) => ({
          workDate: d.workDate, startAt: d.startAt, startSource: d.startSource, endAt: d.endAt,
          endSource: d.endSource, breakRow: d.breakRow, anyDeclared: d.anyDeclared,
          minutes: d.minutes, hours: d.hours, label: d.label, recordApproved: d.recordApproved,
          declarationSource: d.declarationSource, fortAvLedelse: d.fortAvLedelse,
          exceptions: d.exceptions.slice(),
        })),
        hardFindings: exceptions.filter((x) => x.severity === 'hard').map((x) => ({ code: x.code, label: x.label, detail: x.detail })),
      },
      comparison: { plannedHours, varianceHours },
      // 3B-FOUNDATION §K: named INFO-level marker, carried BESIDE the findings rather than inside
      // them, so the Klar / Se over / Må rettes hard-warn doctrine is untouched by construction.
      infoMarks: attestedDays > 0
        ? [{ code: 'fort_av_ledelse', severity: 'info', label: 'Ført av ledelse', detail: attestedDays + (attestedDays === 1 ? ' dag' : ' dager') }]
        : [],
      attestedDayCount: attestedDays,
      exceptions,
      readiness: hardCount === 0 ? 'klar' : 'krever_oppmerksomhet',
    });
  }
  const blocking = rows.filter((r) => r.readiness !== 'klar');
  return {
    tenantId, periodId, periodLabel: periodLabel(periodId), title: periodTitle(periodId),
    generatedAt: generatedAt == null ? null : generatedAt,
    rows,
    readiness: {
      ready: blocking.length === 0,
      blockingEmployees: blocking.map((r) => ({ ansattId: r.ansattId, name: r.name, causes: r.exceptions.filter((x) => x.severity === 'hard').map((x) => x.code) })),
      label: blocking.length === 0 ? 'Klar' : blocking.length + (blocking.length === 1 ? ' ting krever oppmerksomhet' : ' ting krever oppmerksomhet'),
      note: 'Godkjenning fryser en verdikopi av grunnlaget. Dette er inndata til lønn, ikke en lønnsberegning.',
    },
    unsupported: UNSUPPORTED_CAPABILITIES.map((u) => Object.assign({}, u)),
    calendar: payrollCalendarStateFor(periodId, payrollPolicy === undefined ? FOUR_SEASON_PAYROLL_POLICY : payrollPolicy, todayWorkDate),
  };
}

// The accountant-facing payload — the ONLY thing a delivery would carry. Planned time and
// variance are structurally absent here (P3).
export function accountantPayloadOf(pkg) {
  if (!pkg) return null;
  return {
    tenantId: pkg.tenantId, periodId: pkg.periodId, periodLabel: pkg.periodLabel,
    rows: (pkg.rows || []).map((r) => JSON.parse(JSON.stringify(r.payload))),
    unsupported: (pkg.unsupported || []).map((u) => Object.assign({}, u)),
  };
}

// ---- PACKAGE STORE / VERSIONS ----------------------------------------------------------------
// One shared in-memory store for BOTH doorways (Lønnsgrunnlag surface and Employee 360).
// Local/demo runtime only — no production persistence, no network, no Firestore.
export function createPayrollStore() { return { versions: [] }; }
export function versionsOf(store, tenantId, periodId) {
  if (!store || !Array.isArray(store.versions)) return [];
  return store.versions.filter((v) => v.tenantId === tenantId && (!periodId || v.periodId === periodId));
}
export function latestVersionOf(store, tenantId, periodId) {
  const v = versionsOf(store, tenantId, periodId);
  return v.length ? v[v.length - 1] : null;
}
export function activeDraftOf(store, tenantId, periodId) {
  return versionsOf(store, tenantId, periodId).find((v) => v.status === PACKAGE_STATUS.DRAFT) || null;
}

// THE single payroll operation boundary. Kinds: approvePackage | markSentToAccountant |
// createCorrectedVersion. No kind computes pay and no kind performs an external send.
export function applyPayrollOperation({ store, tenantId, actor, op, pkg, now, operatorName }) {
  if (!store || !Array.isArray(store.versions)) return { ok: false, code: 'NO_STORE' };
  if (!actor || actor.accessEnabled !== true || actor.canEditEmployment !== true) return { ok: false, code: 'NOT_AUTHORIZED' };
  if (!op || typeof op !== 'object') return { ok: false, code: 'NO_OPERATION' };
  if (!isValidPeriodId(op.periodId)) return { ok: false, code: 'PERIOD_INVALID' };

  if (op.kind === 'approvePackage') {
    if (!pkg || pkg.periodId !== op.periodId) return { ok: false, code: 'PACKAGE_REQUIRED' };
    if (!pkg.readiness.ready) return { ok: false, code: 'NOT_READY', blocking: pkg.readiness.blockingEmployees };
    const prior = versionsOf(store, tenantId, op.periodId);
    // A period may hold only ONE live approved/sent version at a time. A correction is allowed
    // precisely because it names the version it replaces (op.supersedes).
    const live = prior.filter((v) => v.status === PACKAGE_STATUS.APPROVED || v.status === PACKAGE_STATUS.SENT);
    if (live.length && !live.some((v) => v.packageVersionId === op.supersedes)) return { ok: false, code: 'ALREADY_APPROVED' };
    // Per-record approval EXISTS in the attendance product (recon R2.3), so the package
    // CONSUMES it and states plainly how many further days this act approves (§9.2).
    let alreadyApprovedDays = 0, totalDays = 0;
    for (const r of pkg.rows) for (const d of r.payload.days) { totalDays += 1; if (d.recordApproved) alreadyApprovedDays += 1; }
    const packageApprovedDays = totalDays - alreadyApprovedDays;
    // FREEZE = copy by value. A JSON round-trip guarantees no live reference survives, so
    // later source edits cannot move this version.
    const snapshot = JSON.parse(JSON.stringify({ rows: pkg.rows, readiness: pkg.readiness, unsupported: pkg.unsupported, calendar: pkg.calendar, periodLabel: pkg.periodLabel, title: pkg.title }));
    const version = Object.freeze({
      packageVersionId: 'lg-' + op.periodId + '-v' + (prior.length + 1),
      tenantId, periodId: op.periodId, version: prior.length + 1,
      status: PACKAGE_STATUS.APPROVED,
      generatedAt: pkg.generatedAt, approvedAt: now,
      approvedBy: Object.freeze({ name: operatorName || null, verified: false }),   // v1: never an auth claim
      approvedDayCounts: Object.freeze({ total: totalDays, alreadyApproved: alreadyApprovedDays, approvedByPackage: packageApprovedDays }),
      managerNote: typeof op.managerNote === 'string' && op.managerNote.trim() !== '' ? op.managerNote.trim() : null,
      snapshot: Object.freeze(snapshot),
      deliveries: Object.freeze([]),
      supersedes: op.supersedes || null, supersededBy: null,
    });
    store.versions = store.versions.concat([version]);
    if (version.supersedes) {
      store.versions = store.versions.map((v) => (v.packageVersionId === version.supersedes
        ? Object.freeze(Object.assign({}, v, { status: PACKAGE_STATUS.SUPERSEDED, supersededBy: version.packageVersionId }))
        : v));
    }
    return { ok: true, version };
  }

  if (op.kind === 'markSentToAccountant') {
    const v = versionsOf(store, tenantId, op.periodId).find((x) => x.packageVersionId === op.packageVersionId);
    if (!v) return { ok: false, code: 'VERSION_UNKNOWN' };
    if (v.status !== PACKAGE_STATUS.APPROVED && v.status !== PACKAGE_STATUS.SENT) return { ok: false, code: 'NOT_APPROVED' };
    if (op.channel && op.channel !== DELIVERY_CHANNELS.MANUAL) return { ok: false, code: 'CHANNEL_NOT_SUPPORTED' };
    // Records that the OWNER handed the package over. Sormena sends nothing.
    const delivery = Object.freeze({
      packageVersionId: v.packageVersionId, channel: DELIVERY_CHANNELS.MANUAL,
      recipient: typeof op.recipient === 'string' && op.recipient.trim() !== '' ? op.recipient.trim() : 'regnskapsfører',
      at: now, by: Object.freeze({ name: operatorName || null, verified: false }),
    });
    const updated = Object.freeze(Object.assign({}, v, { status: PACKAGE_STATUS.SENT, deliveries: Object.freeze(v.deliveries.concat([delivery])) }));
    store.versions = store.versions.map((x) => (x.packageVersionId === v.packageVersionId ? updated : x));
    return { ok: true, version: updated, delivery };
  }

  if (op.kind === 'createCorrectedVersion') {
    const v = versionsOf(store, tenantId, op.periodId).find((x) => x.packageVersionId === op.packageVersionId);
    if (!v) return { ok: false, code: 'VERSION_UNKNOWN' };
    if (v.status !== PACKAGE_STATUS.APPROVED && v.status !== PACKAGE_STATUS.SENT) return { ok: false, code: 'NOT_CORRECTABLE' };
    if (activeDraftOf(store, tenantId, op.periodId)) return { ok: false, code: 'DRAFT_EXISTS' };
    // A correction is a NEW draft built from current truth. vN keeps its snapshot and its
    // delivery history and gains supersededBy only when the replacement is itself approved.
    const draft = Object.freeze({
      packageVersionId: 'lg-' + op.periodId + '-v' + (versionsOf(store, tenantId, op.periodId).length + 1),
      tenantId, periodId: op.periodId, version: versionsOf(store, tenantId, op.periodId).length + 1,
      status: PACKAGE_STATUS.DRAFT, generatedAt: null, approvedAt: null, approvedBy: null,
      approvedDayCounts: null, managerNote: null, snapshot: null, deliveries: Object.freeze([]),
      supersedes: v.packageVersionId, supersededBy: null,
    });
    store.versions = store.versions.concat([draft]);
    return { ok: true, version: draft };
  }

  return { ok: false, code: 'UNKNOWN_OPERATION' };
}

// ---- EMPLOYEE 360 PROJECTION -----------------------------------------------------------------
// SAME package truth, filtered to one employee. Employee 360 computes NOTHING of its own: the
// numbers below are read out of the frozen snapshot the Lønnsgrunnlag surface produced.
export function payrollProjectionForEmployee(store, tenantId, ansattId, periodId) {
  const candidates = versionsOf(store, tenantId, periodId).filter((v) => v.snapshot);
  if (!candidates.length) return null;
  const v = candidates[candidates.length - 1];
  const row = (v.snapshot.rows || []).find((r) => r.ansattId === ansattId);
  if (!row) return null;
  const lastDelivery = v.deliveries.length ? v.deliveries[v.deliveries.length - 1] : null;
  return {
    packageVersionId: v.packageVersionId, version: v.version, periodId: v.periodId,
    periodLabel: v.snapshot.periodLabel, status: v.status,
    approvedHours: row.payload.approvedHours, approvedMinutes: row.payload.approvedMinutes,
    actualHours: row.payload.actualHours, approvedDayCount: row.payload.approvedDayCount,
    compensation: row.payload.compensation, fixedSalary: row.payload.fixedSalary,
    sentAt: lastDelivery ? lastDelivery.at : null, sentChannel: lastDelivery ? lastDelivery.channel : null,
  };
}
