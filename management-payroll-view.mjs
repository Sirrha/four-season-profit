// management-payroll-view.mjs
// LØNNSGRUNNLAG · <måned år> — the management review surface for the monthly payroll INPUT
// package. Paints the pure derivation from management-payroll-core.mjs; it computes no hours,
// no money and no readiness of its own, and it delivers nothing.
// Governing: SOREN-...-PAYROLL-HANDOFF-DESIGN-001 §5–§10 + the Increment 2 build release.
// All data-derived text via textContent. Norwegian owner-facing labels, existing shell styles.

import {
  PACKAGE_STATUS, buildPayrollPackage, periodTitle, periodLabel, addMonths,
  applyPayrollOperation, versionsOf, latestVersionOf, activeDraftOf,
} from './management-payroll-core.mjs';
import { fmtTenantHM } from './employee-shell-core.mjs';

function el(tag, opts) {
  const node = document.createElement(tag);
  if (opts) {
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.cls) node.className = opts.cls;
    if (opts.attrs) for (const k of Object.keys(opts.attrs)) node.setAttribute(k, String(opts.attrs[k]));
    if (opts.style) node.style.cssText = opts.style;
  }
  return node;
}
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
function fmtDate(wd) {
  if (!wd) return '–';
  const [y, m, d] = wd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('nb-NO', { timeZone: 'UTC', day: 'numeric', month: 'short' });
}
export const fmtH = (h) => (h == null ? '–' : h.toLocaleString('nb-NO', { maximumFractionDigits: 2 }) + ' t');
export const fmtKr = (v) => 'kr ' + Math.round(v).toLocaleString('nb-NO');
const round2 = (v) => Math.round(v * 100) / 100;
// Canonical operation-level workDate shape (YYYY-MM-DD). Anything else is an incomplete/foreign
// value from a native control and is never handed to the resolver.
const ISO_WORKDATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- STAGE R closure: NORWEGIAN DATE ENTRY over ONE canonical ISO value ----------------------
// The manager's manual-entry date is shown and typed as dd.mm.yyyy — never the browser locale's
// MM/DD — while the only stored/submitted value stays canonical YYYY-MM-DD. Pure, deterministic
// and local to this view/input boundary: the visible string is a representation, not a second
// date truth. Exported so the pure battery can prove format, parse, round-trip and refusals.
export function nbDateFromIso(iso) {
  if (!ISO_WORKDATE.test(iso || '')) return '';
  return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
}
// -> { status: 'valid', iso } | { status: 'incomplete', iso: '' } | { status: 'invalid', iso: '' }
// Accepts exactly dd.mm.yyyy, or the unambiguous eight-digit ddmmyyyy. Nothing else is guessed:
// an impossible calendar date (31.02.2026) is 'invalid', never rolled to another date.
export function isoFromNbDate(text) {
  const s = String(text == null ? '' : text).trim();
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s) || /^(\d{2})(\d{2})(\d{4})$/.exec(s);
  if (!m) return { status: (s.length < 10 && /^[\d.]*$/.test(s)) ? 'incomplete' : 'invalid', iso: '' };
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const real = y >= 1900 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  return real ? { status: 'valid', iso: m[3] + '-' + m[2] + '-' + m[1] } : { status: 'invalid', iso: '' };
}
const NB_DATE_ERR = 'Ugyldig dato. Skriv dd.mm.åååå, f.eks. 04.08.2026.';

// ---- P1: DAGER I PERIODEN — presentation-only UNION of planned dates and attendance dates -----
// Planned facts come ONLY from the canonical schedule projection the shell hands in
// (plannedShiftsFor -> shiftsForEmployee, the same read the manual-time resolver uses); actual
// facts come ONLY from the package row's payload.days (daySummaryFor-derived). The union is
// assembled here, read-only, on every render. It is never stored and never enters the package,
// payload or snapshot. Eligibility mirrors the resolver: assigned shifts only (a cancelled shift is
// not a planned day). Pure and exported for the P1 battery.
export function dagerIPerioden({ plannedShifts, days, periodId }) {
  const byDate = new Map();
  const at = (wd) => { if (!byDate.has(wd)) byDate.set(wd, { workDate: wd, planned: [], actual: [] }); return byDate.get(wd); };
  for (const s of (Array.isArray(plannedShifts) ? plannedShifts : [])) {
    const p = s && s.projection;
    if (!p || p.status !== 'assigned' || typeof p.workDate !== 'string' || p.workDate.slice(0, 7) !== periodId) continue;
    at(p.workDate).planned.push({ shiftId: s.shiftId, startAt: p.plannedStartAt, endAt: p.plannedEndAt, hours: s.hours == null ? null : s.hours });
  }
  for (const d of (Array.isArray(days) ? days : [])) {
    if (!d || typeof d.workDate !== 'string' || d.workDate.slice(0, 7) !== periodId) continue;
    at(d.workDate).actual.push(d);
  }
  const rows = Array.from(byDate.values()).sort((a, b) => (a.workDate < b.workDate ? -1 : 1));
  for (const r of rows) {
    r.planned.sort((a, b) => a.startAt - b.startAt);
    r.kind = r.planned.length && r.actual.length ? 'both' : r.planned.length ? 'planned_only' : 'actual_only';
  }
  return rows;
}
// P2 owner correction (Herish ruling): a planned day without registration is ACTIONABLE in the
// month-level KREVER HANDLING count only once its workDate is strictly in the past. Business-local
// today (the same tenantWorkDate convention Vaktplan uses) belongs to the live "I dag" surface, and
// future days have not happened yet. Presentation/actionability only: the union rows themselves are
// untouched and still list today's and future planned days. No today -> nothing counts (never
// inflate). Pure and exported for the battery.
export function tidligerePlanlagteUtenRegistrering(unionRows, todayWorkDate) {
  const today = typeof todayWorkDate === 'string' ? todayWorkDate : '';
  if (!today) return 0;
  return (Array.isArray(unionRows) ? unionRows : []).filter((u) => u && u.kind === 'planned_only' && typeof u.workDate === 'string' && u.workDate < today).length;
}
// OVERSIKT V1 shared seam — THE month-level composition, lifted unchanged from the P2
// drawMonthCards so that Lønn & økonomi's five cards and the Ledelse Oversikt cockpit read ONE
// set of facts. Inputs are exactly what the view already holds: the SHOWN package rows (the live
// draft, or the frozen approved snapshot — the caller chooses precisely as before), the shell's
// read-only planned-shift projection, the period, the live P2 planning projection and
// business-local today. Presentation sums + the owner-corrected past-only rule only; nothing is
// stored and no truth is re-derived. Pure and exported for both renderers and the battery.
export function monthFactsOf({ rows, plannedFor = () => [], periodId, planning, todayWorkDate, frozen = false }) {
  rows = Array.isArray(rows) ? rows : [];
  const p = planning || null;
  // 3–4: the payroll projection's own per-row facts, composed for the month (presentation sum only).
  const actualHours = round2(rows.reduce((s, r) => s + (r.payload.actualHours || 0), 0));
  const approvedHours = round2(rows.reduce((s, r) => s + (r.payload.approvedHours || 0), 0));
  // 5: existing findings + the P1 union fact, narrowed to PAST planned days without registration
  // (owner ruling: today and future never inflate this historical action number).
  const rollup = packageRollupOf(rows);
  let plannedDays = 0;
  const implicated = [];
  for (const r of rows) {
    const past = tidligerePlanlagteUtenRegistrering(dagerIPerioden({ plannedShifts: plannedFor(r.ansattId), days: r.payload.days, periodId }), todayWorkDate);
    plannedDays += past;
    if (past > 0 || statusChipFor(r.exceptions).key !== 'klar') implicated.push(r.ansattId);
  }
  const parts = [];
  if (rollup.hardCount) parts.push(rollup.hardCount + ' må rettes');
  if (rollup.warnCount) parts.push(rollup.warnCount + ' se over');
  if (plannedDays) parts.push(plannedDays + (plannedDays === 1 ? ' tidligere planlagt dag uten registrering' : ' tidligere planlagte dager uten registrering'));
  // 2: the labelled estimate with its named coverage and exclusions (P2 wording, unchanged).
  let estimate = null;
  if (p) {
    const fixed = p.estimate.exclusions.filter((x) => x.reason === 'fastlonn');
    const missing = p.estimate.exclusions.filter((x) => x.reason !== 'fastlonn');
    estimate = {
      kr: p.estimate.kr, label: p.estimate.label, coveredCount: p.estimate.coveredCount, totalCount: p.estimate.totalCount,
      coverageLine: p.estimate.coverageLine,
      subs: [
        p.estimate.coverageLine,
        fixed.length ? fixed.map((x) => x.name).join(', ') + ': ' + fixed[0].label : null,
        missing.length ? missing.map((x) => x.name).join(', ') + ': ' + missing[0].label : null,
      ].filter(Boolean),
    };
  }
  return {
    periodId, frozen: !!frozen,
    plannedHoursTotal: p ? p.plannedHoursTotal : null,
    estimate,
    actualHours, approvedHours,
    chip: rollup.chip, hardCount: rollup.hardCount, warnCount: rollup.warnCount, counts: rollup.counts,
    pastPlannedDaysWithoutRegistration: plannedDays,
    actionCount: rollup.hardCount + rollup.warnCount + plannedDays,
    actionParts: parts,
    employeesNeedingAction: implicated,
  };
}
// Day-row date: "man. 4. aug." — Norwegian, never MM/DD.
export function fmtDagRad(wd) {
  if (!ISO_WORKDATE.test(wd || '')) return '–';
  const [y, m, d] = wd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('nb-NO', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}
// Signed variance beside Faktisk: "−16 t" / "+2 t" / "±0 t" (formatting only; the number is the
// package row's own comparison.varianceHours).
export function fmtAvvik(h) {
  if (h == null || Number.isNaN(h)) return '';
  const sign = h > 0 ? '+' : h < 0 ? '−' : '±';
  return sign + Math.abs(h).toLocaleString('nb-NO', { maximumFractionDigits: 2 }) + ' t';
}
const monthNameOf = (periodId) => periodLabel(periodId).split(' ')[0];

// ---- P1 correction C: Sormena-owned Norwegian month calendar (no native date control) ---------
// Civil dates are built from explicit year/month/day numbers only; Date.UTC is used solely to
// find the weekday, so no browser locale or timezone can shift a chosen day. Monday-first.
export const NB_WEEKDAYS_SHORT = Object.freeze(['ma', 'ti', 'on', 'to', 'fr', 'lø', 'sø']);
const pad2 = (n) => (n < 10 ? '0' : '') + n;
export function calendarMonthGrid(year, month) {
  const y = Number(year), m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;   // 0 = Monday
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(y + '-' + pad2(m) + '-' + pad2(d));
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const periodId = y + '-' + pad2(m);
  return { year: y, month: m, periodId, label: periodLabel(periodId), weeks };
}

// ---- THREE-LEVEL DERIVED STATUS (Increment 3A §4) --------------------------------------------
// PURE PRESENTATION MAPPING over the EXISTING hard/warn findings classification produced by
// management-payroll-core. Nothing is stored, no finding is reclassified, and approval refusal
// stays where the engine already enforces it. A warn finding can therefore never coexist with a
// green Klar chip — the exact disagreement Herish saw is now unrepresentable.
export const STATUS_KLAR = Object.freeze({ key: 'klar', label: 'Klar', tone: 'ok' });
export const STATUS_SE_OVER = Object.freeze({ key: 'se_over', label: 'Se over', tone: 'warn' });
export const STATUS_MA_RETTES = Object.freeze({ key: 'ma_rettes', label: 'Må rettes', tone: 'hard' });
export function statusChipFor(exceptions) {
  const list = Array.isArray(exceptions) ? exceptions : [];
  if (list.some((x) => x && x.severity === 'hard')) return STATUS_MA_RETTES;
  if (list.some((x) => x && x.severity === 'warn')) return STATUS_SE_OVER;
  return STATUS_KLAR;
}
// Package rollup: hard > warn > clean, with counts named from the same findings.
export function packageRollupOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let hard = 0, warn = 0;
  for (const r of list) {
    const chip = statusChipFor(r && r.exceptions);
    if (chip.key === 'ma_rettes') hard += 1;
    else if (chip.key === 'se_over') warn += 1;
  }
  const chip = hard > 0 ? STATUS_MA_RETTES : (warn > 0 ? STATUS_SE_OVER : STATUS_KLAR);
  const parts = [];
  if (hard > 0) parts.push(hard + ' må rettes');
  if (warn > 0) parts.push(warn + ' se over');
  return { chip, hardCount: hard, warnCount: warn, counts: parts.join(' · ') };
}

// ---- 3B-UI: ADD vs CORRECT RESOLUTION (pure) --------------------------------------------------
// The UI never guesses which day it is writing. This decides, from the SAME runtime data the
// payroll projection reads, exactly which accepted foundation operation applies:
//   'correct'  a concrete attendance record already exists for that employee-day -> managerCorrection
//              targeted at THAT record (never a duplicate).
//   'live'     that record has an in-flight clock session -> a NEW entry is refused (ØKT_PÅGÅR);
//              correcting it stays legitimate (Soren Q1=A), so the caller may still correct.
//   'm1'       no attendance, exactly ONE real assigned shift -> managerManualEntry with that shift.
//   'choose'   no attendance, SEVERAL real assigned shifts -> the manager must pick. Never a silent
//              choice and never a fallback to m2 (U-S4).
//   'm2'       no attendance and no assigned shift -> the accepted no-shift manual-key path.
// Cancelled/open shifts are not entry targets: only a shift genuinely assigned to this employee is.
export function manualTargetFor({ records, shifts, workDate }) {
  const recs = (Array.isArray(records) ? records : []).filter((r) => r && r.workDate === workDate);
  if (recs.length > 1) return { mode: 'choose_record', records: recs, candidates: [] };
  if (recs.length === 1) {
    const r = recs[0];
    const live = r.status === 'clocked_in' || r.breakState === 'on_break';
    return { mode: live ? 'live' : 'correct', record: r, candidates: [] };
  }
  const cands = (Array.isArray(shifts) ? shifts : []).filter((s) =>
    s && s.projection && s.projection.workDate === workDate && s.projection.status === 'assigned');
  if (cands.length === 1) return { mode: 'm1', shift: cands[0], candidates: cands };
  if (cands.length > 1) return { mode: 'choose', candidates: cands };
  return { mode: 'm2', candidates: [] };
}

// Foundation refusal codes rendered as manager-facing Norwegian. The CODES are never changed and
// never swallowed as success; this is presentation over the operation's own verdict.
export function manualErrorText(code) {
  const c = String(code || '');
  if (c === 'OEKT_PAAGAAR') return 'Økten pågår fortsatt. Vent til dagen er stemplet ut, eller korriger den registrerte dagen i stedet.';
  if (c === 'ATTESTERT_AV_LEDELSE') return 'Dagen er allerede ført av ledelsen. Bruk Korriger på den dagen.';
  if (c === 'ATTENDANCE_EXISTS') return 'Det finnes allerede en registrering denne dagen. Bruk Korriger i stedet for å legge til på nytt.';
  if (c === 'EMPLOYMENT_REQUIRED') return 'Mangler arbeidsforhold for denne ansatte. Dagen kan ikke føres.';
  if (c === 'BEFORE_EMPLOYMENT_START') return 'Datoen er før ansettelsen startet.';
  if (c === 'AFTER_EMPLOYMENT_END') return 'Datoen er etter at ansettelsen ble avsluttet.';
  if (c === 'WORKDATE_INVALID') return 'Ugyldig dato.';
  if (c === 'DECLARED_NOT_FINITE') return 'Fyll inn både start og slutt.';
  if (c === 'END_BEFORE_START') return 'Slutt må være etter start.';
  if (c === 'DECLARED_OUTSIDE_WORKDATE') return 'Tidspunktet ligger utenfor arbeidsdagen for denne datoen.';
  if (c === 'DECLARED_BREAK_INVALID') return 'Pause må være et helt antall minutter, 0 eller mer.';
  if (c === 'BREAK_EXCEEDS_SPAN') return 'Pausen er like lang som eller lengre enn arbeidstiden.';
  if (c === 'BREAK_OPEN') return 'En pause er åpen. Avslutt pausen før pausetotalen føres.';
  if (c === 'REASON_REQUIRED') return 'Velg en gyldig årsak (og skriv en merknad der årsaken krever det).';
  if (c === 'NO_CHANGE') return 'Ingen endring å lagre.';
  if (c === 'NO_ATTENDANCE') return 'Fant ikke dagen som skulle korrigeres.';
  if (c === 'ANSATT_REQUIRED') return 'Mangler ansatt.';
  if (c === 'NOT_ADMIN' || c === 'ROLE_NOT_ALLOWED' || c === 'ACTOR_NOT_ENABLED') return 'Du har ikke tilgang til å føre arbeidstid.';
  if (c === 'MISSING_SCOPE' || c === 'SCOPE_TENANT_INVALID' || c === 'MISSING_ACTOR_TENANT' || c === 'CROSS_TENANT') return 'Tilgangen gjelder ikke denne virksomheten.';
  if (c === 'NO_SHIFT' || c === 'NOT_OWN_SHIFT' || c === 'SHIFT_WORKDATE_MISMATCH') return 'Vakten passer ikke til denne ansatte eller datoen.';
  if (c === 'SHIFT_CHOICE_REQUIRED') return 'Det finnes flere vakter denne dagen. Velg hvilken vakt dagen gjelder.';
  if (c === 'RECORD_CHOICE_REQUIRED') return 'Det finnes flere registreringer denne dagen. Korriger den aktuelle dagen fra dag-for-dag-listen.';
  if (c.startsWith('FIELD_NOT_CORRECTABLE')) return 'Feltet kan ikke korrigeres.';
  if (c.startsWith('INCOMPLETE_ATTENDANCE')) return 'Dagen mangler opplysninger og kan ikke godkjennes.';
  return 'Kunne ikke lagre (' + c + ').';
}

export function renderPayrollView(root, { employeeStore, scheduleStore, attendanceStore, payrollStore, tenantId, actor, operatorName, nowMs, timezone, todayWorkDate, initialPeriodId, initialOpenEmployee, onStateChange, onBack, onOpenEmployee, manualContext, onManualTime, plannedShiftsFor, planningFor }) {
  if (!root) return;
  let periodId = initialPeriodId;
  let openEmployee = initialOpenEmployee || null;   // shell-owned across tab switches
  let errMsg = '';
  let noteDraft = '';
  let manual = null;      // 3B-UI inline manager time panel state (add | correct), one at a time
  let frozen = false;     // an approved/sent version is on screen -> the live action is absent
  let jumpTo = null;      // P1: after a cross-period save, a one-tap doorway to that month (view state only)
  const reportState = () => { if (typeof onStateChange === 'function') onStateChange({ periodId, openEmployee }); };
  // P1: planned shifts for the day union — the shell's canonical read-only projection, or nothing.
  const plannedFor = (ansattId) => (typeof plannedShiftsFor === 'function' ? (plannedShiftsFor(ansattId) || []) : []);
  // P2: the pure planning-economy projection for the viewed period — recomputed per draw, LIVE even
  // when a frozen payroll version is on screen (estimates are never frozen), never stored here.
  let planningNow = null;
  const isFrozenPeriod = (pid) => versionsOf(payrollStore, tenantId, pid).some((v) => v.status === PACKAGE_STATUS.APPROVED || v.status === PACKAGE_STATUS.SENT);
  const FROZEN_NOTE = 'Perioden er godkjent og frosset. Bruk «Lag korrigert versjon» før ny tid kan tas inn i lønnsgrunnlaget.';

  const fmtHM = (t) => (t == null ? '–' : fmtTenantHM(t, timezone));

  function pkgNow() {
    return buildPayrollPackage({
      employeeStore, scheduleStore, attendanceStore, tenantId, periodId,
      generatedAt: nowMs, todayWorkDate,
    });
  }
  function opError(code) {
    if (code === 'NOT_READY') return 'Kan ikke godkjennes: noe krever oppmerksomhet.';
    if (code === 'ALREADY_APPROVED') return 'Perioden er allerede godkjent.';
    if (code === 'NOT_APPROVED') return 'Bare en godkjent versjon kan markeres som sendt.';
    if (code === 'CHANNEL_NOT_SUPPORTED') return 'Bare manuell overlevering er støttet nå.';
    if (code === 'DRAFT_EXISTS') return 'Det finnes allerede et utkast for perioden.';
    if (code === 'NOT_AUTHORIZED') return 'Du har ikke tilgang til å godkjenne lønnsgrunnlag.';
    return 'Kunne ikke lagre (' + code + ').';
  }
  function apply(op, after) {
    const res = applyPayrollOperation({ store: payrollStore, tenantId, actor, op, pkg: pkgNow(), now: Date.now(), operatorName });
    if (res.ok) { errMsg = ''; if (typeof after === 'function') after(res); } else errMsg = opError(res.code);
    draw();
  }
  function btn(label, cls, onClick) {
    const b = el('button', { cls, text: label, attrs: { type: 'button' } });
    b.addEventListener('click', onClick);
    return b;
  }
  function head(title, sub) {
    const h = el('div', { cls: 'plan-head' });
    const ht = el('div');
    ht.appendChild(el('h1', { text: title }));
    if (sub) ht.appendChild(el('div', { cls: 'sub', text: sub }));
    h.appendChild(ht);
    return h;
  }
  function factRow(label, value) {
    const r = el('div', { cls: 'emp-fact' });
    r.appendChild(el('div', { cls: 'k', text: label }));
    r.appendChild(el('div', { cls: 'v', text: value }));
    return r;
  }
  function badges(list) {
    const wrap = el('div', { cls: 'emp-miss' });
    for (const x of list) {
      const b = el('span', { cls: 'mtag' + (x.severity === 'hard' ? ' hard' : ''), text: x.detail ? x.label + ' · ' + x.detail : x.label });
      b.setAttribute('data-severity', x.severity);
      wrap.appendChild(b);
    }
    return wrap;
  }

  // ---- PERIOD PICKER: simple month stepper, never a hardcoded single period ----
  // P1 §A: the period is the page's first fact — title above, stepper right under it:
  //   ‹ Forrige · Denne måneden · Neste ›
  function goPeriod(pid) { periodId = pid; openEmployee = null; manual = null; errMsg = ''; jumpTo = null; reportState(); draw(); }
  function periodBar() {
    const bar = el('div', { cls: 'lg-period', attrs: { role: 'group', 'aria-label': 'Periode' } });
    bar.appendChild(btn('‹ Forrige', 'btn tertiary lg-step', () => goPeriod(addMonths(periodId, -1))));
    const thisMonth = (todayWorkDate || '').slice(0, 7);
    const now = btn('Denne måneden', 'btn tertiary lg-step' + (thisMonth === periodId ? ' on' : ''), () => { if (thisMonth) goPeriod(thisMonth); });
    bar.appendChild(now);
    bar.appendChild(btn('Neste ›', 'btn tertiary lg-step', () => goPeriod(addMonths(periodId, 1))));
    return bar;
  }

  // ---- P2 §7: the month-level overview — ONE row of derived cards under the period header.
  // Every figure comes from an EXISTING canonical derivation or the P2 planning projection.
  // Cards 1–2 read the planning projection; cards 3–5 compose the payroll projection and the P1
  // union facts. Two projections share the screen; they never share a number or a storage fate.
  function drawMonthCards(shown) {
    const rows = shown.rows || [];
    const wrap = el('div', { cls: 'lg-cards', attrs: { 'aria-label': 'Månedsoversikt' } });
    const card = (title, value, subs) => {
      const c = el('div', { cls: 'lg-card' });
      c.appendChild(el('div', { cls: 'k', text: title }));
      c.appendChild(el('div', { cls: 'v', text: value }));
      for (const s of (subs || [])) if (s) c.appendChild(el('div', { cls: 's', text: s }));
      wrap.appendChild(c);
    };
    const p = planningNow;
    // Oversikt V1 seam: ONE composition — monthFactsOf — feeds these five cards AND the Ledelse
    // Oversikt cockpit. Same shown rows (live or frozen snapshot), same planned-shift projection,
    // same live planning projection, same business-local today; the cards only format.
    const f = monthFactsOf({ rows, plannedFor, periodId, planning: p, todayWorkDate, frozen });
    card('Planlagte timer', p ? fmtH(p.plannedHoursTotal) : '–', ['planlagt bemanning fra Vaktplan']);
    if (p) card('Estimert planlagt kostnad', (p.estimate.coveredCount ? fmtKr(p.estimate.kr) : '–') + ' ' + p.estimate.label, f.estimate.subs);
    else card('Estimert planlagt kostnad', '– (estimat)', ['ingen planprojeksjon tilgjengelig']);
    card('Faktiske timer', fmtH(f.actualHours) + ' registrert', [frozen ? 'fra frosset versjon' : 'fra registrert tid']);
    card('Godkjente timer', fmtH(f.approvedHours) + ' godkjent', null);
    card('Krever handling', String(f.actionCount), f.actionParts.length ? f.actionParts : ['ingenting krever handling']);
    root.appendChild(wrap);
  }

  function drawCalendar(pkg) {
    const c = el('div', { cls: 'card' });
    c.appendChild(el('div', { cls: 'kicker neutral', text: 'Lønnsfrist' }));
    if (!pkg.calendar.configured) {
      c.appendChild(factRow('Status', pkg.calendar.label));
      c.appendChild(el('div', { cls: 'vp-note', text: pkg.calendar.note }));
    } else {
      c.appendChild(factRow('Frist til regnskapsfører', fmtDate(pkg.calendar.targetDate)));
      c.appendChild(factRow('Siste frist', fmtDate(pkg.calendar.hardDate)));
      c.appendChild(factRow('Dager igjen', String(pkg.calendar.daysRemaining)));
    }
    root.appendChild(c);
  }

  function drawVersions(pkg) {
    const versions = versionsOf(payrollStore, tenantId, periodId);
    if (!versions.length) return;
    const c = el('div', { cls: 'card' });
    c.appendChild(el('div', { cls: 'kicker neutral', text: 'Versjoner' }));
    for (const v of versions.slice().reverse()) {
      const row = el('div', { cls: 'emp-period' });
      row.appendChild(el('div', { cls: 'rg', text: 'v' + v.version + ' · ' + v.status + (v.status === PACKAGE_STATUS.APPROVED || v.status === PACKAGE_STATUS.SENT ? ' – frosset verdikopi' : '') }));
      const bits = [];
      if (v.approvedBy) bits.push('godkjent av ' + (v.approvedBy.name || 'ukjent') + ' (uverifisert)');
      if (v.approvedDayCounts) bits.push(v.approvedDayCounts.approvedByPackage + ' dager godkjent av pakken, ' + v.approvedDayCounts.alreadyApproved + ' allerede godkjent per dag');
      for (const d of v.deliveries) bits.push('markert sendt (' + d.channel + ') til ' + d.recipient);
      if (v.supersededBy) bits.push('erstattet av ' + v.supersededBy);
      row.appendChild(el('div', { cls: 'bits', text: bits.join(' · ') }));
      c.appendChild(row);
    }
    root.appendChild(c);
  }

  // THE detail rendering — unchanged content and derivation, re-hosted INLINE beneath its row.
  // There is no second calculation path: every value below comes from the same package row the
  // collapsed line reads.
  // Neutral INFO marks (Ført av ledelse). Rendered from row.infoMarks, which the foundation keeps
  // OUTSIDE row.exceptions on purpose — so this can never reach the findings badges or move the
  // Klar / Se over / Må rettes chip.
  function infoMarks(list) {
    const wrap = el('div', { cls: 'emp-miss mt-info-row' });
    for (const x of list) {
      const b = el('span', { cls: 'mtag mt-info', text: x.detail ? x.label + ' · ' + x.detail : x.label });
      b.setAttribute('data-severity', x.severity);
      wrap.appendChild(b);
    }
    return wrap;
  }
  // Correction PRE-FILL is a convenience over the EFFECTIVE displayed values only; submission still
  // goes through managerCorrection, and observed receipts are never edited.
  function newManualState(mode, ansattId, day) {
    const st = {
      mode, ansattId, err: '', shiftId: '', attendanceId: null,
      workDate: day ? day.workDate : (todayWorkDate || ''),
      startHM: '', endHM: '', breakMin: '0', reasonCode: '', reasonNote: '', targetLabel: null,
    };
    if (day) {
      if (day.startAt != null) st.startHM = fmtHM(day.startAt);
      if (day.endAt != null) st.endHM = fmtHM(day.endAt);
      if (day.breakRow && day.breakRow.kind === 'declared') st.breakMin = String(day.breakRow.minutes);
      st.targetLabel = fmtDate(day.workDate);
    }
    return st;
  }

  // ---- 3B-UI: the manager time panel, INSIDE the already-accepted expanded row ----------------
  // No route, no modal architecture, no second detail path: an inline panel in the same wrapper.
  // It owns NO arithmetic — it collects input, calls the shell's operation seam, and re-renders
  // from the canonical projection.
  function drawManualPanel(row, host) {
    const st = manual;
    const wrap = el('div', { cls: 'lg-detail mt-panel' });
    const isCorrect = st.mode === 'correct';
    // P1 §E panel honesty: the heading follows the resolver target — when an add lands on a day
    // that already has a record, it says Korriger arbeidstid (updated in renderResolution).
    const heading = el('div', { cls: 'kicker neutral', text: isCorrect ? 'Korriger arbeidstid' : 'Legg til arbeidstid' });
    wrap.appendChild(heading);
    if (isCorrect && st.targetLabel) wrap.appendChild(el('div', { cls: 'cue-line', text: 'Gjelder ' + st.targetLabel }));

    // STAGE R (R-A wrong-date wiring): the resolver is consulted ONLY for a COMPLETE canonical
    // workDate. A native date control emits change events with an EMPTY value while a segment is
    // being typed, and a panel torn down inside that event detaches the control mid-entry, drops
    // focus and lets the browser commit a partial segment as a different date. The panel is
    // therefore never redrawn on a date change: only the resolution-dependent parts (Vakt choice
    // and the hint sentence) are re-resolved IN PLACE, against the same canonical schedule truth.
    const resolveFor = (wd) => (typeof manualContext === 'function' && ISO_WORKDATE.test(wd || '')
      ? manualContext({ ansattId: row.ansattId, workDate: wd })
      : null);
    const ctx = resolveFor(st.workDate);

    const field = (label, node) => {
      const f = el('div', { cls: 'mt-field' });
      f.appendChild(el('label', { text: label }));
      f.appendChild(node);
      wrap.appendChild(f);
      return node;
    };
    const input = (type, value, attrs) => {
      const i = el('input', { attrs: Object.assign({ type }, attrs || {}) });
      i.value = value == null ? '' : String(value);
      return i;
    };
    // Date entry: Norwegian dd.mm.yyyy TEXT control over the single canonical ISO st.workDate.
    // No native <input type="date">: its locale-dependent MM/DD rendering and segment/picker
    // gestures were the unresolved variable in the owner's failed run (Stage R closure release).
    // Date is fixed to the targeted record in correction mode — identity is never re-chosen.
    const dateI = input('text', nbDateFromIso(st.workDate), Object.assign(
      { placeholder: 'dd.mm.åååå', inputmode: 'numeric', maxlength: '10', autocomplete: 'off', spellcheck: 'false' },
      isCorrect ? { readonly: 'readonly' } : {}));
    // Correction C: text field + Sormena-owned calendar button; both write the SAME visible
    // dd.mm.yyyy string and go through the SAME parser/resolver (resolveInPlace).
    const dateRow = el('div', { cls: 'mt-daterow' });
    dateRow.appendChild(dateI);
    let calBtn = null, calBox = null, calCursor = null;
    if (!isCorrect) {
      calBtn = el('button', { cls: 'btn tertiary mt-calbtn', text: 'Kalender', attrs: { type: 'button', 'aria-label': 'Åpne kalender', 'aria-expanded': 'false' } });
      dateRow.appendChild(calBtn);
    }
    field('Dato (dd.mm.åååå)', dateRow);
    if (!isCorrect) { calBox = el('div', { cls: 'mt-cal', attrs: { hidden: '' } }); wrap.appendChild(calBox); }
    const startI = field('Start', input('time', st.startHM));
    const endI = field('Slutt', input('time', st.endHM));
    const breakI = field('Pause (minutter)', input('number', st.breakMin, { min: '0', step: '1' }));

    // Vakt selection appears ONLY to resolve several real assigned shifts (never a silent pick).
    // It lives in a box that is re-resolved in place when the date commits (see resolveInPlace).
    const shiftBox = el('div');
    wrap.appendChild(shiftBox);
    let shiftSel = null;
    const hintBox = el('div');
    const errBox = el('div', { cls: 'vp-err', text: st.err || '' });
    let saveBtn = null;
    // Correction B: the schedule context is SHOWN, not implied. One eligible shift -> the planned
    // interval is named and the save action reads "Registrer arbeidstid for vakten"; several ->
    // explicit choice; none -> the no-shift state is stated for this employee/date before the
    // genuine day-without-shift flow may proceed. Planned times are never copied into Start/Slutt.
    function scheduleNotice(c) {
      if (!c) return null;
      const when = nbDateFromIso(st.workDate);
      if (c.mode === 'm1') return { tone: 'ok', text: 'Planlagt vakt funnet: ' + (c.candidates[0] ? c.candidates[0].label : '') + ' · ' + row.name + ' ' + when + '. Arbeidstiden registreres på denne vakten. Oppgi faktisk start og slutt.' };
      if (c.mode === 'choose') return { tone: 'warn', text: 'Flere planlagte vakter for ' + row.name + ' ' + when + ' — velg hvilken vakt arbeidstiden gjelder.' };
      if (c.mode === 'm2') return { tone: 'neutral', text: 'Ingen planlagt vakt for ' + row.name + ' ' + when + '. Dagen registreres som dag uten vakt.' };
      return null;
    }
    function renderResolution(c) {
      clear(shiftBox); shiftSel = null;
      if (saveBtn) saveBtn.textContent = (c && (c.mode === 'm1' || c.mode === 'choose')) ? 'Registrer arbeidstid for vakten' : 'Lagre';
      if (c && c.mode === 'choose') {
        shiftSel = el('select');
        const none = el('option', { text: 'Velg vakt …' }); none.value = '';
        shiftSel.appendChild(none);
        for (const cand of c.candidates) {
          const o = el('option', { text: cand.label }); o.value = cand.shiftId;
          if (cand.shiftId === st.shiftId) o.setAttribute('selected', 'selected');
          shiftSel.appendChild(o);
        }
        const f = el('div', { cls: 'mt-field' });
        f.appendChild(el('label', { text: 'Vakt' }));
        f.appendChild(shiftSel);
        shiftBox.appendChild(f);
        shiftSel.addEventListener('change', () => { st.shiftId = shiftSel.value; });
      }
      clear(hintBox);
      // No resolver sentence is ever uttered for an incomplete date: the UI may not claim
      // "Ingen vakt" (or any other verdict) about a day it has not been given.
      const notice = scheduleNotice(c);
      if (notice) hintBox.appendChild(el('div', { cls: 'mt-notice ' + notice.tone, text: notice.text }));
      const hint = notice ? '' : (c && c.hint ? c.hint : (isCorrect ? '' : 'Skriv eller velg dato (dd.mm.åååå) for å se om dagen har en planlagt vakt.'));
      if (hint) hintBox.appendChild(el('div', { cls: 'vp-note', text: hint }));
      if (!isCorrect) heading.textContent = (c && (c.mode === 'correct' || c.mode === 'live')) ? 'Korriger arbeidstid' : 'Legg til arbeidstid';
      // P1 §F cross-period honesty: a workDate outside the viewed period is legitimate truth, but
      // never silent — the target month is named BEFORE save. A frozen target keeps the existing
      // refusal wording and blocks the save in this view.
      st.crossPeriodFrozen = false;
      if (!isCorrect && st.workDate && st.workDate.slice(0, 7) !== periodId) {
        const target = st.workDate.slice(0, 7);
        st.crossPeriodFrozen = isFrozenPeriod(target);
        hintBox.appendChild(el('div', { cls: 'vp-note lg-cross', text: st.crossPeriodFrozen
          ? 'Denne datoen tilhører ' + periodLabel(target) + '. ' + FROZEN_NOTE
          : 'Denne datoen tilhører ' + periodLabel(target) + '. Dagen føres i lønnsgrunnlaget for ' + monthNameOf(target) + '.' }));
      }
    }
    function resolveInPlace() {
      const parsed = isoFromNbDate(dateI.value);
      st.workDate = parsed.status === 'valid' ? parsed.iso : '';
      st.shiftId = ''; st.err = ''; errBox.textContent = parsed.status === 'invalid' ? NB_DATE_ERR : '';
      renderResolution(resolveFor(st.workDate));
    }
    if (!isCorrect) {
      dateI.addEventListener('input', resolveInPlace);
      // Leaving the field shows a valid eight-digit entry in its dd.mm.yyyy form; the canonical
      // value is untouched. An incomplete or invalid entry is left exactly as typed — never
      // rewritten into another date.
      const normalise = () => { const p = isoFromNbDate(dateI.value); if (p.status === 'valid') dateI.value = nbDateFromIso(p.iso); };
      dateI.addEventListener('blur', normalise);
      dateI.addEventListener('change', normalise);
      // ---- in-app calendar (Correction C) ----
      const closeCal = () => { calBox.setAttribute('hidden', ''); calBtn.setAttribute('aria-expanded', 'false'); };
      const pickIso = (iso) => { dateI.value = nbDateFromIso(iso); resolveInPlace(); closeCal(); dateI.focus(); };
      function drawCal() {
        clear(calBox);
        const g = calendarMonthGrid(calCursor.year, calCursor.month);
        const nav = el('div', { cls: 'mt-calnav' });
        nav.appendChild(btn('‹', 'btn tertiary mt-calstep', () => { const p = addMonths(g.periodId, -1); calCursor = { year: Number(p.slice(0, 4)), month: Number(p.slice(5, 7)) }; drawCal(); }));
        nav.appendChild(el('div', { cls: 'mt-callabel', text: g.label }));
        nav.appendChild(btn('›', 'btn tertiary mt-calstep', () => { const p = addMonths(g.periodId, 1); calCursor = { year: Number(p.slice(0, 4)), month: Number(p.slice(5, 7)) }; drawCal(); }));
        calBox.appendChild(nav);
        const grid = el('div', { cls: 'mt-calgrid', attrs: { role: 'grid', 'aria-label': g.label } });
        for (const w of NB_WEEKDAYS_SHORT) grid.appendChild(el('div', { cls: 'mt-calhd', text: w }));
        const selected = isoFromNbDate(dateI.value).iso;
        for (const week of g.weeks) for (const iso of week) {
          if (!iso) { grid.appendChild(el('div', { cls: 'mt-calcell empty' })); continue; }
          const b = el('button', { cls: 'mt-calcell' + (iso === selected ? ' sel' : '') + (iso === todayWorkDate ? ' today' : ''), text: String(Number(iso.slice(8, 10))), attrs: { type: 'button', 'aria-label': fmtDagRad(iso) + ' ' + iso.slice(0, 4) } });
          b.addEventListener('click', () => pickIso(iso));
          grid.appendChild(b);
        }
        calBox.appendChild(grid);
      }
      calBtn.addEventListener('click', () => {
        if (!calBox.hasAttribute('hidden')) { closeCal(); return; }
        // Open on the VIEWED period (the month the manager is working in); only a valid entry that
        // already lies inside that period keeps its own month — the default "today" date never
        // drags the calendar into another month.
        const entered = isoFromNbDate(dateI.value).iso;
        const cur = (entered && entered.slice(0, 7) === periodId) ? entered : (periodId + '-01');
        calCursor = { year: Number(cur.slice(0, 4)), month: Number(cur.slice(5, 7)) };
        drawCal();
        calBox.removeAttribute('hidden'); calBtn.setAttribute('aria-expanded', 'true');
      });
    }

    const reasonSel = el('select');
    for (const rc of (ctx && ctx.reasonCodes ? ctx.reasonCodes : [])) {
      const o = el('option', { text: rc.label }); o.value = rc.code;
      if (rc.code === st.reasonCode) o.setAttribute('selected', 'selected');
      reasonSel.appendChild(o);
    }
    field('Årsak', reasonSel);
    reasonSel.addEventListener('change', () => { st.reasonCode = reasonSel.value; });
    const noteI = field('Merknad', input('text', st.reasonNote, { placeholder: 'Kreves for enkelte årsaker' }));

    wrap.appendChild(hintBox);
    wrap.appendChild(errBox);

    const acts = el('div', { cls: 'vp-actions' });
    saveBtn = btn('Lagre', 'btn primary', () => {
      // The operation-level date is ALWAYS parsed from the value the control holds at submit —
      // displayed and submitted can never diverge. Anything but a complete valid dd.mm.yyyy is
      // refused here, before any operation is attempted; the form stays open with the entry as typed.
      if (!isCorrect) {
        const parsed = isoFromNbDate(dateI.value);
        if (parsed.status !== 'valid') { st.err = NB_DATE_ERR; errBox.textContent = st.err; return; }
        st.workDate = parsed.iso;
        if (st.crossPeriodFrozen) { st.err = FROZEN_NOTE; errBox.textContent = st.err; return; }
      }
      st.startHM = startI.value; st.endHM = endI.value; st.breakMin = breakI.value;
      st.reasonCode = reasonSel.value; st.reasonNote = noteI.value;
      if (shiftSel) st.shiftId = shiftSel.value;
      const res = typeof onManualTime === 'function' ? onManualTime({
        mode: st.mode, ansattId: row.ansattId, workDate: st.workDate,
        startHM: st.startHM, endHM: st.endHM, breakMin: st.breakMin,
        reasonCode: st.reasonCode, reasonNote: st.reasonNote,
        shiftId: st.shiftId || null, attendanceId: st.attendanceId || null,
      }) : { ok: false, code: 'NOT_WIRED' };
      // A refusal never closes the form and never touches the stores: the manager fixes and retries.
      if (res && res.ok) {
        manual = null; errMsg = '';
        jumpTo = (!isCorrect && st.workDate.slice(0, 7) !== periodId) ? st.workDate.slice(0, 7) : null;   // P1 §F: post-save doorway
      } else { st.err = manualErrorText(res && res.code); }
      draw();
    });
    acts.appendChild(saveBtn);
    acts.appendChild(btn('Avbryt', 'btn tertiary', () => { manual = null; draw(); }));
    wrap.appendChild(acts);
    renderResolution(ctx);
    host.appendChild(wrap);
  }

  // P1 §D helpers — every value below is the package row's own fact or the canonical planned
  // projection; the view computes no hours, no totals, no variance of its own.
  function breakText(day) {
    if (!day.breakRow) return '—';
    if (day.breakRow.kind === 'declared') return day.breakRow.minutes + ' min (oppgitt)';
    if (day.breakRow.kind === 'observed') return day.breakRow.minutes + ' min (registrert)';
    if (day.breakRow.kind === 'open') return 'åpen pause';
    return '—';
  }
  function sourceText(day) {
    if (day.fortAvLedelse) return 'Ført av ledelse';
    if (day.declarationSource === 'manager') return 'Korrigert av ledelse';
    return day.label || 'Ingen tidslinje';
  }
  function chip(tone, text) { return el('span', { cls: 'lg-chip ' + tone, text }); }

  // ONE day row of DAGER I PERIODEN: Dato | Planlagt | Faktisk | Pause | Status | Handling.
  // Four semantics (planned-only, planned+attendance, attendance-no-plan; neither = no row).
  // Every action targets an EXPLICIT interval or record — never a silent pick.
  function dayRow(row, u, plannedLabel) {
    const r = el('div', { cls: 'lg-day ' + u.kind, attrs: { 'data-workdate': u.workDate } });
    const cell = (k, node) => { const c = el('div', { cls: 'c', attrs: { 'data-k': k } }); if (typeof node === 'string') c.textContent = node; else c.appendChild(node); r.appendChild(c); return c; };
    cell('Dato', fmtDagRad(u.workDate));
    const pl = el('div');
    if (!u.planned.length) pl.textContent = '—';
    for (const p of u.planned) pl.appendChild(el('div', { text: fmtHM(p.startAt) + '–' + fmtHM(p.endAt) + (p.hours == null ? '' : ' (' + fmtH(p.hours) + ')') }));
    cell('Planlagt', pl);
    const fa = el('div');
    if (!u.actual.length) fa.appendChild(el('span', { cls: 'lg-nr', text: '— ikke registrert' }));
    for (const day of u.actual) {
      const line = el('div');
      line.appendChild(el('span', { text: fmtHM(day.startAt) + '–' + fmtHM(day.endAt) + (day.minutes == null ? ' · ingen sum' : ' · ' + fmtH(day.hours)) }));
      line.appendChild(el('span', { cls: 'lg-src', text: sourceText(day) }));
      fa.appendChild(line);
    }
    cell('Faktisk', fa);
    const pa = el('div');
    if (!u.actual.length) pa.textContent = '—';
    for (const day of u.actual) pa.appendChild(el('div', { text: breakText(day) }));
    cell('Pause', pa);
    const stt = el('div');
    if (u.kind === 'planned_only') stt.appendChild(chip('warn', plannedLabel));
    for (const day of u.actual) {
      for (const code of day.exceptions) stt.appendChild(chip('hard', code === 'aapen_oekt' ? 'Åpen økt' : 'Dag uten svar'));
      if (!day.exceptions.length) stt.appendChild(chip(day.recordApproved ? 'ok' : 'neutral', day.recordApproved ? 'Godkjent' : 'Registrert'));
    }
    cell('Status', stt);
    const ha = el('div');
    if (!frozen) {
      if (u.kind === 'planned_only') {
        // The M1 path with the choice already made by context: THIS date and THIS shift are carried
        // into the same panel/resolver; times are left for the manager to state (planned never
        // pre-fills actual).
        for (const p of u.planned) {
          ha.appendChild(btn('Legg til arbeidstid' + (u.planned.length > 1 ? ' ' + fmtHM(p.startAt) + '–' + fmtHM(p.endAt) : ''), 'btn tertiary mt-fix', () => {
            manual = newManualState('add', row.ansattId);
            manual.workDate = u.workDate; manual.shiftId = p.shiftId;
            draw();
          }));
        }
      }
      for (const day of u.actual) ha.appendChild(btn('Korriger', 'btn tertiary mt-fix', () => { manual = newManualState('correct', row.ansattId, day); draw(); }));
    }
    cell('Handling', ha);
    return r;
  }

  function drawEmployeeDetail(pkg, row, host) {
    // P1 §B expanded header: person/month facts only — no prose, no planning-cost (that is P2).
    const c = el('div', { cls: 'lg-detail' });
    c.appendChild(factRow('Lønnsgrunnlag (arbeidsforhold)', row.payload.compensation ? row.payload.compensation.label : 'Ukjent – mangler lønnsbasis'));
    if (row.payload.fixedSalaryNote) c.appendChild(el('div', { cls: 'cue-line', text: row.payload.fixedSalaryNote }));
    if (row.payload.employmentStartedInPeriod) c.appendChild(factRow('Ansatt fra', nbDateFromIso(row.payload.employmentStartedInPeriod)));
    if (row.payload.employmentEndedInPeriod) c.appendChild(factRow('Sluttet', nbDateFromIso(row.payload.employmentEndedInPeriod)));
    // P2 §4 money placement: the per-employee planning estimate lives HERE (expanded header),
    // never on collapsed rows. Same pure projection, same per-workDate rate rule as the month card.
    const pe = planningNow ? planningNow.employees.find((x) => x.ansattId === row.ansattId) : null;
    if (pe) c.appendChild(factRow('Estimert planlagt kostnad ' + planningNow.estimate.label, pe.included ? fmtKr(pe.estimateKr) + ' ' + planningNow.estimate.label : pe.note));
    c.appendChild(factRow('Godkjent', fmtH(row.payload.approvedHours) + ' · ' + row.payload.approvedDayCount + ' av ' + row.payload.dayCount + (row.payload.dayCount === 1 ? ' dag' : ' dager')));
    host.appendChild(c);
    if (frozen) host.appendChild(el('div', { cls: 'vp-note', text: FROZEN_NOTE }));

    // P1 §C DAGER I PERIODEN — the presentation-only union, assembled read-only every render.
    const d = el('div', { cls: 'lg-detail' });
    d.appendChild(el('div', { cls: 'kicker neutral', text: 'Dager i perioden' }));
    const union = dagerIPerioden({ plannedShifts: plannedFor(row.ansattId), days: row.payload.days, periodId });
    if (!union.length) {
      d.appendChild(el('div', { style: 'color:var(--faint);font-size:14px', text: 'Ingen planlagte vakter eller registrert tid i perioden.' }));
    } else {
      const found = row.exceptions.find((x) => x.code === 'planlagt_uten_faktisk');
      const plannedLabel = found ? found.label : 'Planlagt uten faktisk';
      const table = el('div', { cls: 'lg-days' });
      const hd = el('div', { cls: 'lg-day head' });
      for (const k of ['Dato', 'Planlagt', 'Faktisk', 'Pause', 'Status', 'Handling']) hd.appendChild(el('div', { cls: 'c', text: k }));
      table.appendChild(hd);
      for (const u of union) table.appendChild(dayRow(row, u, plannedLabel));
      d.appendChild(table);
    }
    d.appendChild(el('div', { cls: 'vp-note', text: 'Planlagt er sammenlikning, aldri arbeidet tid. Pause trekkes med oppgitt total når den finnes, ellers registrert – de legges aldri sammen. Netto tid rundes alltid ned.' }));
    host.appendChild(d);

    // P1 §E: the compact doorway for genuinely unplanned days and cross-period entry — the SAME
    // panel, resolver and operation path. Absent (not disabled) while a frozen version is on screen.
    if (!frozen) {
      const bar = el('div', { cls: 'vp-actions mt-bar' });
      bar.appendChild(btn('+ Legg til dag uten vakt', 'btn tertiary mt-fix', () => {
        manual = manual && manual.mode === 'add' && !manual.shiftId ? null : newManualState('add', row.ansattId);
        draw();
      }));
      host.appendChild(bar);
      if (manual && manual.ansattId === row.ansattId) drawManualPanel(row, host);
      if (jumpTo && jumpTo !== periodId) {
        const j = el('div', { cls: 'vp-actions mt-bar' });
        j.appendChild(el('span', { cls: 'lg-src', text: 'Dagen ble ført i lønnsgrunnlaget for ' + periodLabel(jumpTo) + '.' }));
        j.appendChild(btn('Gå til ' + periodLabel(jumpTo), 'btn tertiary mt-fix', () => goPeriod(jumpTo)));
        host.appendChild(j);
      }
    }
  }

  function drawList(pkg) {
    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker', text: 'Ansatte i perioden' }));
    if (!pkg.rows.length) card.appendChild(el('div', { style: 'color:var(--faint);font-size:14px', text: 'Ingen ansatte i denne perioden.' }));
    for (const row of pkg.rows) {
      const isOpen = openEmployee === row.ansattId;
      const wrap = el('div', { cls: 'lg-row' + (isOpen ? ' open' : '') });
      const chip = statusChipFor(row.exceptions);
      const b = el('button', { cls: 'emp-row', attrs: { type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', 'aria-label': (isOpen ? 'Lukk ' : 'Åpne ') + row.name } });
      const top = el('div', { cls: 'top' });
      top.appendChild(el('div', { cls: 'nm', text: row.name }));
      top.appendChild(el('span', { cls: 'st lg-chip ' + chip.tone, text: chip.label }));
      b.appendChild(top);
      // P1 §B collapsed row — scan, don't parse: quiet basis subline, then a labelled fact strip
      // Planlagt · Faktisk (signed variance) · Godkjent. No sentence. Money is never on a row.
      b.appendChild(el('div', { cls: 'sub lg-basis', text: row.payload.compensation ? row.payload.compensation.label : 'Mangler lønnsbasis' }));
      const strip = el('div', { cls: 'lg-facts' });
      const stat = (k, v, delta) => {
        const s = el('span', { cls: 'lg-stat' });
        s.appendChild(el('span', { cls: 'k', text: k }));
        s.appendChild(el('span', { cls: 'v', text: v }));
        if (delta) s.appendChild(el('span', { cls: 'd', text: delta }));
        strip.appendChild(s);
      };
      stat('Planlagt', fmtH(row.comparison.plannedHours));
      stat('Faktisk', fmtH(row.payload.actualHours), row.comparison.plannedHours > 0 ? fmtAvvik(row.comparison.varianceHours) : null);
      stat('Godkjent', fmtH(row.payload.approvedHours));
      b.appendChild(strip);
      if (row.exceptions.length) b.appendChild(badges(row.exceptions));
      if (row.infoMarks && row.infoMarks.length) b.appendChild(infoMarks(row.infoMarks));
      // EXACTLY ONE open at a time: opening another row closes the previous one.
      b.addEventListener('click', () => { openEmployee = isOpen ? null : row.ansattId; manual = null; errMsg = ''; reportState(); draw(); });
      wrap.appendChild(b);
      if (isOpen) drawEmployeeDetail(pkg, row, wrap);
      card.appendChild(wrap);
    }
    root.appendChild(card);
  }

  function drawActions(pkg) {
    const latest = latestVersionOf(payrollStore, tenantId, periodId);
    const approved = versionsOf(payrollStore, tenantId, periodId).find((v) => v.status === PACKAGE_STATUS.APPROVED || v.status === PACKAGE_STATUS.SENT);
    const c = el('div', { cls: 'card emp-form' });
    // Draft rollup chip (hard > warn > clean). After approval the VERSION state outranks
    // draft readiness, exactly as design 001 §6.1 requires.
    const rollup = packageRollupOf(pkg.rows);
    const headline = el('div', { cls: 'lg-rollup' });
    if (approved) {
      headline.appendChild(el('span', { cls: 'lg-chip ok', text: approved.status === PACKAGE_STATUS.SENT ? 'Sendt' : 'Godkjent v' + approved.version }));
    } else {
      headline.appendChild(el('span', { cls: 'lg-chip ' + rollup.chip.tone, text: rollup.chip.label }));
      if (rollup.counts) headline.appendChild(el('span', { cls: 'lg-rollup-counts', text: rollup.counts }));
    }
    c.appendChild(headline);
    c.appendChild(el('div', { cls: 'vp-note', text: pkg.readiness.note }));
    if (!pkg.readiness.ready) {
      for (const b of pkg.readiness.blockingEmployees) {
        c.appendChild(el('div', { cls: 'cue-line', text: b.name + ': ' + b.causes.join(', ') }));
      }
    }
    c.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
    const acts = el('div', { cls: 'vp-actions' });
    if (!approved) {
      const note = el('input', { attrs: { type: 'text', placeholder: 'Notat til perioden (valgfritt)', value: noteDraft } });
      note.addEventListener('input', () => { noteDraft = note.value; });
      c.appendChild(note);
      const ap = btn('Godkjenn lønnsgrunnlag', 'btn primary', () => apply({ kind: 'approvePackage', periodId, managerNote: noteDraft, supersedes: latest && latest.status === PACKAGE_STATUS.DRAFT && latest.supersedes ? latest.supersedes : null }, () => { noteDraft = ''; }));
      if (!pkg.readiness.ready) ap.setAttribute('disabled', 'disabled');
      acts.appendChild(ap);
    } else {
      if (approved.status === PACKAGE_STATUS.APPROVED) {
        acts.appendChild(btn('Marker som sendt til regnskapsfører', 'btn primary', () => apply({ kind: 'markSentToAccountant', periodId, packageVersionId: approved.packageVersionId, recipient: 'regnskapsfører' })));
      }
      if (!activeDraftOf(payrollStore, tenantId, periodId)) {
        acts.appendChild(btn('Lag korrigert versjon', 'btn secondary', () => apply({ kind: 'createCorrectedVersion', periodId, packageVersionId: approved.packageVersionId })));
      }
    }
    c.appendChild(acts);
    if (approved && approved.status === PACKAGE_STATUS.SENT) {
      c.appendChild(el('div', { cls: 'vp-note', text: 'Markert som manuelt overlevert. Sormena har ikke sendt e-post eller overført en fil – du leverer selv og registrerer at det er gjort.' }));
    }
    root.appendChild(c);
  }

  function drawUnsupported(pkg) {
    const c = el('div', { cls: 'card' });
    c.appendChild(el('div', { cls: 'kicker neutral', text: 'Ikke med i dette grunnlaget' }));
    for (const u of pkg.unsupported) c.appendChild(factRow(u.label, u.note));
    c.appendChild(el('div', { cls: 'vp-note', text: 'Dette er inndata til lønn, ikke en lønnsberegning. Beløp, skatt og feriepenger beregnes av regnskapsfører.' }));
    root.appendChild(c);
  }

  function draw() {
    clear(root);
    const pkg = pkgNow();
    const approved = versionsOf(payrollStore, tenantId, periodId).find((v) => v.status === PACKAGE_STATUS.APPROVED || v.status === PACKAGE_STATUS.SENT);
    // An approved/sent version renders from ITS OWN frozen snapshot, never from live source.
    const shown = approved ? Object.assign({}, approved.snapshot, { periodId, calendar: approved.snapshot.calendar }) : pkg;
    frozen = !!approved;                       // drives the manager action's ABSENCE, not a disabled control
    if (frozen) manual = null;
    root.appendChild(head(periodTitle(periodId), approved ? 'Godkjent versjon v' + approved.version + ' · frosset verdikopi' : 'Utkast · oppdateres fra kilden'));
    root.appendChild(periodBar());
    planningNow = typeof planningFor === 'function' ? planningFor(periodId) : null;   // P2: live projection, never frozen
    drawMonthCards(shown);
    // NOTE: there is no separate employee-detail route any more. The month list is always the
    // page; a selected employee expands INSIDE its row (drawList → drawEmployeeDetail), so the
    // month context never leaves the screen and only one rendering path exists.
    if (openEmployee && !(shown.rows || []).some((r) => r.ansattId === openEmployee)) openEmployee = null;
    drawCalendar(shown);
    drawActions(pkg);
    drawList(shown);
    drawUnsupported(shown);
    drawVersions(pkg);
    if (typeof onBack === 'function') root.appendChild(btn('← Tilbake', 'btn tertiary', onBack));
  }

  draw();
}
