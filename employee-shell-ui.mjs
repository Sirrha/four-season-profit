// employee-shell-ui.mjs
// ETR-1 membership routing + ETR-2a Today/Clocking + ETR-2b breaks + employee week schedule
// (local demo, mobile-first). Demo identities are the Four Season first names with SYNTHETIC
// technical ids only: no emails, real auth UIDs, passwords/PINs, personnummer, bank or contact
// details. No network, no Firebase, no Firestore. Authority + clock transitions come ONLY from
// the pure core model. All data-derived text is rendered via textContent / created elements —
// never via innerHTML — so data values can never become markup. The UI reads the clock
// (Date.now()) and INJECTS it into the pure model; validators never read a clock (G3).

import {
  resolveRouting, selectMembership,
  ETR2A_POLICY, attendanceIdFor,
  clockIn, clockOut, reasonRequiredForClock,
  tenantWorkDate, fmtTenantHM, tenantLocalHMToUtcMs, computeClockTimes,
  startBreak, endBreak, declareBreak, reasonRequiredForBreak,
  daySummaryFor, primaryActionFor,
  managerManualEntry, managerCorrection,
} from './employee-shell-core.mjs';
import { buildFourSeasonSchedule, buildFourSeasonScaleSet, FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MEMBERSHIPS, FOUR_SEASON_MANAGER_ACTOR, FOUR_SEASON_CONTRACT_PROFILE, ROLE_LABELS } from './employee-schedule-fixture.mjs';
import { ownShiftsForMembership, todayShiftOf, nextUpcomingShift, isOvernight, heroShiftFor, weekFor } from './employee-schedule-week.mjs';
import { renderScheduleView } from './employee-schedule-view.mjs';
import { renderManagementView } from './management-schedule-view.mjs';
import { canOpenVaktplan, openShiftsOf, isEligible, applyScheduleOperation, shiftsForEmployee, managerWeekFor, durationHoursOf } from './management-schedule-core.mjs';
import { seedFourSeasonEmployees, vaktplanPeopleFrom, canViewEmployees, employeesOf, employeeOf, startDateOf, missingInfoOf, currentTermsOf, contractStatusOf } from './management-employees-core.mjs';
import { minAnsettelseFra, SCOPE_LINE } from './employee-myjob.mjs';   // Employee Page V1: pure, import-free presentation of the employee's own employment facts
import { renderEmployeesView } from './management-employees-view.mjs';
import { renderPayrollView, packageRollupOf, manualTargetFor, monthFactsOf, fmtH, fmtKr } from './management-payroll-view.mjs';
import { planningEconomyFor } from './management-planning-economy.mjs';   // P2: pure planning projection (never stored)
import { dagensBildeFra, ansattFaktaFra, oppmerksomhetFra, EMPTY_ATTENTION } from './management-oversikt.mjs';   // Oversikt V1: pure, import-free composition
import { createPayrollStore, buildPayrollPackage, versionsOf, periodLabel } from './management-payroll-core.mjs';

const POLICY = ETR2A_POLICY;
// Owner-facing wording for the EXISTING manager reason codes. The code set itself is policy truth
// and is read live from POLICY.reasonCodes — nothing here invents or widens a reason.
const MANAGER_REASON_LABELS = Object.freeze({
  RETROACTIVE_ENTRY: 'Etterregistrering',
  MANAGEMENT_DECISION: 'Ledelsens beslutning',
  OTHER: 'Annet (krever merknad)',
});

// ---- Demo identities / memberships (Four Season; Maria is the default review identity) ----
export const FIXTURE_USERS = FOUR_SEASON_PEOPLE.map((p) => ({ uid: p.uid, label: p.name }));
export const FIXTURE_MEMBERSHIPS = FOUR_SEASON_MEMBERSHIPS;
export const TENANT_LABELS = { [FOUR_SEASON_TENANT.tenantId]: FOUR_SEASON_TENANT.label };
const DEFAULT_UID = 'uid-maria';
function tenantLabel(t) { return Object.prototype.hasOwnProperty.call(TENANT_LABELS, t) ? TENANT_LABELS[t] : t; }

// ETR-1 read-only "Mine vakter" fixtures retained (historical shifts, display only).
export const FIXTURE_SHIFTS = [
  { id: 'v-01', ansattId: 'ansatt-102', dato: '2026-08-18', fra: '08:00', til: '14:00', notat: 'Morgenvakt' },
  { id: 'v-03', ansattId: 'ansatt-103', dato: '2026-08-18', fra: '10:00', til: '18:00', notat: '' },
  { id: 'v-04', ansattId: 'ansatt-204', dato: '2026-08-19', fra: '16:00', til: '22:00', notat: 'Kveld' },
];

// Reason labels (fixture only; the KEY is the stored identity, per Freeze 003 §6.2).
const REASON_LABELS = {
  FORGOT_CLOCK_IN: 'Glemte å stemple inn', LATE_ARRIVAL: 'Kom for sent',
  MANAGEMENT_DECISION: 'Etter avtale med leder', OTHER: 'Annet (krever notat)',   // employee wording only; the stored code stays MANAGEMENT_DECISION
  FORGOT_CLOCK_OUT: 'Glemte å stemple ut', LEFT_EARLY: 'Gikk tidlig',
  SICK_DEPARTURE: 'Syk – dro hjem', COVERED_FOR_COLLEAGUE: 'Dekket for kollega',
  APP_UNAVAILABLE: 'Appen var utilgjengelig',
  // ETR-2b break reason labels
  FORGOT_BREAK_START: 'Glemte å starte pause', FORGOT_BREAK_END: 'Glemte å avslutte pause',
  EXTENDED_BREAK: 'Forlenget pause', WORK_RELATED_INTERRUPTION: 'Arbeidsrelatert avbrudd',
  PERSONAL_REASON: 'Personlig årsak',
};

// ---- ONE shared schedule store (management Vaktplan AND employee views project the SAME object) ----
// B8: workDate and planned instants derive from the tenant policy timezone via the pure core
// helpers, NOT from host Date getters. The store is seeded ONCE per page/mount lifecycle from the
// pure deterministic builder with the same tenant-local anchor conventions, so the seeded
// shiftIds are byte-identical to the previous per-read rebuild and attendance keys never drift.
// Manager create/edit/cancel mutate THIS object through the single operation boundary
// (management-schedule-core.mjs); employee Today/Uke/Måned project it via ownShiftsForMembership
// (tenant fixed by the membership BEFORE any ansattId filtering). No persistence claim: a page
// refresh re-seeds the local fixture store.
const TZ = POLICY.timezone;
// ?scale=40 is a LOCAL, non-production fixture toggle (design 2H): it swaps in the synthetic
// ~40-person scale-proof set for the Vaktplan grids. OFF by default; the normal five-person
// review is untouched without the parameter.
const SCALE40 = typeof location !== 'undefined' && new URLSearchParams(location.search).get('scale') === '40';
let SCHEDULE_STORE = null;
let VAKTPLAN_PEOPLE = FOUR_SEASON_PEOPLE;
function scheduleStore() {
  if (!SCHEDULE_STORE) {
    const wd = tenantWorkDate(Date.now(), TZ);
    if (SCALE40) { const s = buildFourSeasonScaleSet(wd, TZ); SCHEDULE_STORE = s.schedule; VAKTPLAN_PEOPLE = s.people; }
    else SCHEDULE_STORE = buildFourSeasonSchedule(wd, TZ);
  }
  return SCHEDULE_STORE;
}
// ---- ONE employee (Employee 360) store, seeded once per mount from the same fixture people.
// Compensation lives ONLY in employment terms here; the Vaktplan surface receives a DERIVED
// projection of the CURRENT terms (vaktplanPeopleFrom) — there is no second stored copy.
// Under ?scale=40 the synthetic people are used directly for the grid scale proof (they are not
// employment records); the normal five-person product always projects from employment terms.
let EMPLOYEE_STORE = null;
function employeeStore() {
  if (!EMPLOYEE_STORE) EMPLOYEE_STORE = seedFourSeasonEmployees(VAKTPLAN_PEOPLE === FOUR_SEASON_PEOPLE ? FOUR_SEASON_PEOPLE : VAKTPLAN_PEOPLE, FOUR_SEASON_TENANT.tenantId);
  return EMPLOYEE_STORE;
}
function vaktplanPeople() {
  scheduleStore();                       // ensure the scale toggle has resolved first
  return vaktplanPeopleFrom(employeeStore(), FOUR_SEASON_TENANT.tenantId, tenantWorkDate(Date.now(), TZ));
}
// ---- ONE shared payroll-package store for BOTH doorways (Lønnsgrunnlag surface and the
// Employee 360 Lønn & økonomi projection). Local/demo in-memory only: a hard browser reload
// resets package state. No production persistence, no network, no Firestore.
let PAYROLL_STORE = null;
function payrollStore() {
  if (!PAYROLL_STORE) PAYROLL_STORE = createPayrollStore();
  return PAYROLL_STORE;
}
// Claimed operator display identity from the existing manager actor — never an auth claim; the
// package labels it "(uverifisert)" everywhere it is shown.
function operatorDisplayName() {
  const emp = employeeStore()[FOUR_SEASON_TENANT.tenantId];
  const rec = emp && FOUR_SEASON_MANAGER_ACTOR.ansattId ? emp[FOUR_SEASON_MANAGER_ACTOR.ansattId] : null;
  return rec ? rec.name : null;
}
function ownScheduleFor(membership) {
  const wd = tenantWorkDate(Date.now(), TZ);
  return { workDate: wd, shifts: ownShiftsForMembership(scheduleStore(), membership) };
}
// Clock-path packaging (unchanged contract): clockIn inspects shift.shiftId for equality with
// scope.shiftId only; the projection itself stays the frozen ten fields.
function clockShiftFrom(entry, membership) {
  return Object.assign({ shiftId: entry.shiftId, tenantId: membership.tenantId }, entry.projection);
}
function fmtDayShort(workDate) {
  const [y, m, d] = workDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('nb-NO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}

// In-memory attendance store (fixture only; keyed by deterministic attendanceId).
const attendanceStore = new Map();

// ---- Safe DOM helpers -------------------------------------------------------
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
function fmtHM(instant) { return fmtTenantHM(instant, TZ); } // B8: tenant-timezone, not host
function actorFromMembership(m) {
  return { uid: m.uid, accessRole: m.accessRole, ansattId: m.ansattId, accessEnabled: true, tenantId: m.tenantId };
}

// ---- Shell ------------------------------------------------------------------
export function mountEmployeeShell(root) {
  if (!root) return;

  function goChooser() {
    clear(root);
    const wrap = el('div', { cls: 'card', style: 'max-width:520px' });
    wrap.appendChild(el('h2', { text: 'Hvem er du?' }));
    wrap.appendChild(el('div', { text: 'Velg navnet ditt for å se din dag og din plan.', style: 'color:#5f6b62;font-size:14px;margin-bottom:14px' }));
    for (const u of FIXTURE_USERS) {
      const b = el('button', { cls: 'btn secondary', text: u.label, attrs: { type: 'button' }, style: 'text-align:left;padding:14px 16px' });
      b.addEventListener('click', () => route(u.uid));
      wrap.appendChild(b);
    }
    // ONE Ledelse doorway: the destination list became a persistent tabbed workspace (3A §1).
    if (ledelseTabs().length) {
      wrap.appendChild(el('div', { text: 'Ledelse', style: 'color:#5f6b62;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px' }));
      const lb = el('button', { cls: 'btn secondary', text: 'Ledelse', attrs: { type: 'button' }, style: 'text-align:left;padding:14px 16px' });
      lb.addEventListener('click', () => goLedelse());
      wrap.appendChild(lb);
    }
    root.appendChild(wrap);
  }

  function route(uid) {
    const r = resolveRouting(FIXTURE_MEMBERSHIPS, uid);
    if (r.kind === 'no-access') return goNoAccess();
    if (r.kind === 'direct') return goToday(r.membership);
    return goPicker(r.eligible);
  }

  function goNoAccess() {
    clear(root);
    root.appendChild(el('div', {
      text: 'Ingen tilgang. Denne kontoen har ingen aktive medlemskap. Kontakt administrator.',
      style: 'padding:14px;border:1px solid #ddd;border-radius:8px;background:#fafafa',
    }));
    root.appendChild(backBtn('Bytt ansatt', goChooser));
  }

  function goPicker(eligible) {
    clear(root);
    root.appendChild(el('h2', { text: 'Velg arbeidsplass', style: 'font-size:18px;margin:0 0 10px' }));
    for (const m of eligible) {
      const b = el('button', {
        text: tenantLabel(m.tenantId) + ' — ' + m.accessRole,
        style: 'display:block;width:100%;max-width:360px;text-align:left;padding:12px;margin-bottom:8px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;font-size:15px',
      });
      b.addEventListener('click', () => { const sel = selectMembership(eligible, m.tenantId); if (sel) goToday(sel); else goNoAccess(); });
      root.appendChild(b);
    }
    root.appendChild(backBtn('Bytt ansatt', goChooser));
  }

  // ---- SORMENA EMPLOYEE HOME (Visual Slice 001) ---------------------------------------------
  // Hero / next shift / week strip all derive from ownScheduleFor(membership) (one shared truth).
  // Attendance is READ through a lookup into the existing attendanceStore; writers stay in the dialogs.
  let current = null;
  function setChrome(membership, view) {
    const person = FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId);
    const idb = document.getElementById('emp-identity');
    if (idb) {
      idb.hidden = false; idb.onclick = goChooser;
      const av = idb.querySelector('.av'), nm = idb.querySelector('.nm');
      if (av) av.textContent = person ? person.name.charAt(0) : '?';
      if (nm) nm.textContent = person ? person.name : '';
      idb.setAttribute('aria-label', 'Bytt ansatt');
    }
    const nav = document.getElementById('emp-nav');
    if (nav) {
      nav.hidden = false;
      for (const b of nav.querySelectorAll('button[data-nav]')) {
        const k = b.getAttribute('data-nav');
        if (k === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        b.onclick = () => { if (k === 'today') goToday(current); else if (k === 'plan') goSchedule(current); else goMyWork(current); };
      }
    }
  }
  function greetingFor(nowMs) {
    const h = parseInt(fmtHM(nowMs).slice(0, 2), 10);          // tenant-local hour
    return h < 10 ? 'God morgen' : h < 17 ? 'God dag' : 'God kveld';
  }
  function goToday(membership) {
    current = membership; clear(root); setChrome(membership, 'today');
    const { workDate, shifts } = ownScheduleFor(membership);
    const nowMs = Date.now();
    const lookup = (shiftId) => attendanceStore.get(attendanceIdFor(shiftId, membership.ansattId)) || null;
    const hero = heroShiftFor(shifts, { nowMs, todayWorkDate: workDate, lookup });
    const person = FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId);
    const fmtDur = (m) => (m >= 60 ? Math.floor(m / 60) + ' t ' + (m % 60 ? (m % 60) + ' min' : '') : m + ' min').trim();

    // two deliberate compositions from one DOM: single column on phone, main/side columns on desktop (CSS grid)
    const home = el('div', { cls: 'home' }); const main = el('div', { cls: 'col-main' }); const side = el('div', { cls: 'col-side' });
    home.appendChild(main); home.appendChild(side); root.appendChild(home);

    const g = el('div', { cls: 'greet' });
    g.appendChild(el('h1', { text: greetingFor(nowMs) + (person ? ', ' + person.name : '') }));
    g.appendChild(el('div', { cls: 'date', text: new Date(nowMs).toLocaleDateString('nb-NO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }) }));
    main.appendChild(g);

    // ---- hero (selection unchanged; presentation is state-driven) ----
    const entry = hero.entry; const p = entry ? entry.projection : null; const att = hero.attendance;
    const started = !!p && nowMs >= p.plannedStartAt;
    const ended = !!p && nowMs >= p.plannedEndAt;
    let mood = 'calm';                                   // calm | attn | work | pause | done | missing | free
    if (hero.kind === 'free') mood = 'free';
    else if (att && att.status === 'clocked_in') mood = att.breakState === 'on_break' ? 'pause' : 'work';
    else if (att && att.status === 'clocked_out') mood = 'done';
    else if (hero.kind === 'completed' && hero.missingRegistration) mood = 'missing';   // ended, nothing registered -> attention, never "fullført"
    else if (hero.kind === 'completed') mood = 'done';
    else if (started && !ended) mood = 'attn';           // window running, not clocked in => attention, not calm green
    const card = el('div', { cls: 'card hero ' + (mood === 'missing' ? 'attn' : mood) });   // missing registration uses the amber attention treatment
    if (mood === 'free') {
      card.appendChild(el('div', { cls: 'kicker neutral', text: 'I dag' }));
      card.appendChild(el('div', { cls: 'title', text: 'Fri i dag' }));
      card.appendChild(el('div', { cls: 'sub', text: 'Ingen planlagt vakt hos ' + tenantLabel(membership.tenantId) + '. Nyt dagen.' }));
      main.appendChild(card);
    } else {
      card.appendChild(el('div', { cls: 'kicker' + (mood === 'attn' || mood === 'pause' || mood === 'missing' ? ' amber' : mood === 'done' ? ' neutral' : ''), text: hero.ongoingFromPriorDay ? 'Pågående vakt' : mood === 'done' ? 'Dagens vakt · fullført' : 'Dagens vakt' }));
      const hg = el('div', { cls: 'hero-grid' }); const txt = el('div', { cls: 'txt' }); hg.appendChild(txt);
      const timeRange = fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, TZ) ? ' (til neste dag)' : '');
      txt.appendChild(el('div', { cls: 'title', text: mood === 'missing' ? 'Vakten er over' : timeRange }));
      txt.appendChild(el('div', { cls: 'sub', text: (mood === 'missing' ? timeRange + ' · ' : '') + tenantLabel(membership.tenantId) + (ROLE_LABELS[p.roleKey] ? ' · ' + ROLE_LABELS[p.roleKey] : '') + (hero.ongoingFromPriorDay ? ' · startet ' + fmtDayShort(p.workDate) : '') }));
      // human lead line per state
      if (mood === 'calm' && !started) txt.appendChild(el('div', { cls: 'lead', text: 'Vakten starter kl. ' + fmtHM(p.plannedStartAt) + (p.plannedStartAt - nowMs < 12 * 3600000 ? ' · om ' + fmtDur(Math.round((p.plannedStartAt - nowMs) / 60000)) : '') }));
      if (mood === 'attn') { txt.appendChild(el('div', { cls: 'lead', text: 'Vakten startet kl. ' + fmtHM(p.plannedStartAt) })); txt.appendChild(el('div', { cls: 'note', text: 'Ikke stemplet inn ennå.' })); }
      if (mood === 'work' && !ended) txt.appendChild(el('div', { cls: 'lead', text: 'Ca. ' + fmtDur(Math.max(1, Math.round((p.plannedEndAt - nowMs) / 60000))) + ' til planlagt slutt' }));
      if (mood === 'work' && ended) txt.appendChild(el('div', { cls: 'lead', text: 'Planlagt slutt er passert' }));
      if (mood === 'done') txt.appendChild(el('div', { cls: 'lead', text: 'Takk for i dag.' }));
      // ended planned shift with NO registration (pure flag from heroShiftFor): honest guidance, no action — the
      // manager registers/corrects the day; an employee clock-in after the shift ended is never offered here.
      if (mood === 'missing') { txt.appendChild(el('div', { cls: 'lead', text: 'Ingen arbeidstid er registrert for denne vakten.' })); txt.appendChild(el('div', { cls: 'note', text: 'Ta kontakt med leder for å få registrert eller korrigert arbeidstiden.' })); }
      // status pill (authoritative text)
      let stateText = 'Ikke stemplet inn', stateCls = 'status' + (mood === 'attn' ? ' attn' : '');
      if (att && att.status === 'clocked_in') { stateText = 'Stemplet inn kl. ' + fmtHM(att.observedClockInAt); stateCls = 'status on'; }
      else if (att && att.status === 'clocked_out') { stateText = 'Stemplet ut'; }   // Slice003: all start/end meaning lives in Dagen din
      else if (mood === 'missing') { stateText = 'Ingen arbeidstid registrert'; stateCls = 'status attn'; }
      else if (hero.kind === 'completed') { stateText = 'Planlagt vakt er over'; }
      if (att && att.breakState === 'on_break') { stateText = 'På pause siden kl. ' + fmtHM(att.openBreakStartedAt); stateCls = 'status pause'; }
      const st = el('div', { cls: stateCls }); st.appendChild(el('span', { cls: 'dot' })); st.appendChild(el('span', { text: stateText })); txt.appendChild(st);
      // (the former observed-break cue-line is replaced by the source-aware Dagen din block below)
      // planned-window progress: ring on desktop (CSS shows it), bar on mobile; only while the window runs
      const span = p.plannedEndAt - p.plannedStartAt;
      if (started && !ended && span > 0 && mood !== 'done') {
        const pct = Math.max(0, Math.min(100, Math.round(((nowMs - p.plannedStartAt) / span) * 100)));
        const ring = el('div', { cls: 'ring', attrs: { 'aria-hidden': 'true' } }); const rw = el('div', { cls: 'ring-wrap' });
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 88 88');
        const mk = (c) => { const o = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); o.setAttribute('cx', '44'); o.setAttribute('cy', '44'); o.setAttribute('r', '38'); o.setAttribute('class', c); return o; };
        const track = mk('track'); const val = mk('val'); const C = 2 * Math.PI * 38; val.setAttribute('stroke-dasharray', C.toFixed(1)); val.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(1));
        svg.appendChild(track); svg.appendChild(val); rw.appendChild(svg); rw.appendChild(el('div', { cls: 'pct', text: pct + ' %' })); ring.appendChild(rw); hg.appendChild(ring);
        const pr = el('div', { cls: 'prog bar-only' }); const bar = el('div', { cls: 'bar' }); bar.appendChild(el('div', { cls: 'fill', style: 'width:' + pct + '%' })); pr.appendChild(bar);
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-label', 'Planlagt tid');
        txt.appendChild(pr);
        txt.appendChild(el('div', { cls: 'cue-line', text: pct + ' % av planlagt vakt er gått' }));
      }
      card.appendChild(hg);
      if (hero.othersToday > 0) card.appendChild(el('div', { cls: 'cue-line', text: 'Du har også en vakt til i dag – se Plan.' }));
      main.appendChild(card);

      // ---- state-driven primary action: GREEN = emphasis only, NEVER availability ----
      // Which buttons exist is unchanged (existing availability rules below); the pure
      // selector only decides which ONE (if any) gets the existing green-primary styling.
      const acts = el('div', { cls: 'actions' });
      const shift = clockShiftFrom(entry, membership);
      const attId = attendanceIdFor(shift.shiftId, membership.ansattId);
      const breaksOn = POLICY.breakMode !== 'none';
      const actionable = hero.kind === 'active' || hero.kind === 'current' || hero.kind === 'upcoming';
      const primary = primaryActionFor({
        attendance: att, shift, now: nowMs, policy: POLICY,
        clockInPermitted: !att && actionable && POLICY.employeeClockingEnabled === true,
      });
      const emph = (key, capsLabel, label, onClick) =>
        btn(primary === key ? capsLabel : label, primary === key ? 'primary' : 'secondary', onClick);
      if (!att && actionable) {
        acts.appendChild(emph('stemple_inn', 'STEMPLE INN', 'Stemple inn', () => openClockDialog(membership, shift, attId, 'in')));
      } else if (att && att.status === 'clocked_in') {
        if (att.breakState === 'on_break') {
          acts.appendChild(emph('avslutt_pause', 'AVSLUTT PAUSE', 'Avslutt pause', () => openBreakDialog(membership, shift, attId, 'break_end')));
        } else {
          if (breaksOn) acts.appendChild(emph('start_pause', 'START PAUSE', 'Start pause', () => openBreakDialog(membership, shift, attId, 'break_start')));
          acts.appendChild(emph('stemple_ut', 'STEMPLE UT', 'Stemple ut', () => openClockDialog(membership, shift, attId, 'out')));
        }
      } else if (att && att.status === 'clocked_out') {
        acts.appendChild(el('div', { cls: 'done-line', text: 'Vakten er fullført for i dag.' }));
      }
      main.appendChild(acts);

      // ---- DAGEN DIN (Slice003): source-aware day summary from the existing projection, rendered only with attendance ----
      const ds = att ? daySummaryFor({ attendance: att }) : null;
      if (ds) {
        const sc = el('div', { cls: 'card' });
        sc.appendChild(el('div', { cls: 'kicker', text: 'Dagen din' }));
        const rowOf = (label, primary, tag, secondary) => {
          const r = el('div', { cls: 'row', style: 'padding:8px 0;border-top:1px solid #eef0ec' });
          r.appendChild(el('div', { text: label, style: 'color:#5f6b62;font-size:13px;font-weight:600;min-width:52px' }));
          const right = el('div', { style: 'text-align:right' });
          const line = el('div', { style: 'display:flex;gap:8px;align-items:baseline;justify-content:flex-end' });
          line.appendChild(el('span', { text: primary, style: 'font-weight:800;font-size:16px' }));
          if (tag) line.appendChild(el('span', { cls: 'tag', text: tag }));
          right.appendChild(line);
          if (secondary) right.appendChild(el('div', { cls: 'cue-line', text: secondary, style: 'margin-top:2px' }));
          r.appendChild(right);
          return r;
        };
        // START
        if (ds.start.at != null) {
          if (ds.start.source === 'declared') sc.appendChild(rowOf('Start', fmtHM(ds.start.at), 'Oppgitt av deg', 'Registrert kl. ' + fmtHM(ds.start.observedAt)));
          else sc.appendChild(rowOf('Start', fmtHM(ds.start.at), 'Stemplet inn', null));
        }
        // BREAK
        if (ds.breakRow.kind === 'open') sc.appendChild(rowOf('Pause', 'Pågår siden ' + (ds.breakRow.sinceAt != null ? fmtHM(ds.breakRow.sinceAt) : '–'), null, null));
        else if (ds.breakRow.kind === 'declared') sc.appendChild(rowOf('Pause', ds.breakRow.minutes + ' min', 'Oppgitt av deg', (ds.breakRow.observedMinutes > 0 || ds.breakRow.count > 0) ? 'Registrert ' + ds.breakRow.observedMinutes + ' min' + (ds.breakRow.count > 0 ? ' (' + ds.breakRow.count + (ds.breakRow.count === 1 ? ' pause)' : ' pauser)') : '') : null));
        else if (ds.breakRow.kind === 'observed') sc.appendChild(rowOf('Pause', ds.breakRow.minutes + ' min', 'Registrert', ds.breakRow.count > 0 ? ds.breakRow.count + (ds.breakRow.count === 1 ? ' pause' : ' pauser') : null));
        // END
        if (ds.end.at != null) {
          if (ds.end.source === 'declared') sc.appendChild(rowOf('Slutt', fmtHM(ds.end.at), 'Oppgitt av deg', 'Registrert kl. ' + fmtHM(ds.end.observedAt)));
          else sc.appendChild(rowOf('Slutt', fmtHM(ds.end.at), 'Stemplet ut', null));
        } else {
          sc.appendChild(rowOf('Slutt', '–', null, ds.onBreak ? null : 'Ikke stemplet ut ennå'));
        }
        // TOTAL (only when the helper exposes a complete total)
        if (ds.total) {
          const tr = el('div', { cls: 'row', style: 'padding:12px 0 2px;border-top:1px solid #eef0ec;margin-top:2px' });
          tr.appendChild(el('div', { text: ds.total.label, style: 'font-weight:700;font-size:14px' }));
          tr.appendChild(el('div', { text: (ds.total.hours > 0 ? ds.total.hours + ' t ' : '') + ds.total.mins + ' min', style: 'font-weight:800;font-size:20px;color:#175330' }));
          sc.appendChild(tr);
        }
        // existing forgotten-break affordance, relocated beside the break truth (identical handler/condition)
        if (breaksOn && att && (att.status === 'clocked_in' || att.status === 'clocked_out') && att.breakState !== 'on_break') {
          sc.appendChild(btn('Glemt en pause? Registrer pausetid', 'tertiary', () => openDeclareBreakDialog(membership, shift, attId)));
        }
        main.appendChild(sc);
      }
    }

    // ---- next shift (same own-schedule array) ----
    const after = entry && hero.kind !== 'completed' ? Math.max(nowMs, p.plannedStartAt) : nowMs;
    const nx = nextUpcomingShift(shifts, after);
    const nc = el('div', { cls: 'card next' });
    if (nx) {
      const q = nx.projection; const [, qm, qd] = q.workDate.split('-').map(Number);
      const cal = el('div', { cls: 'cal', attrs: { 'aria-hidden': 'true' } });
      cal.appendChild(el('div', { cls: 'm', text: ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'][qm - 1] }));
      cal.appendChild(el('div', { cls: 'd', text: String(qd) }));
      cal.appendChild(el('div', { cls: 'w', text: fmtDayShort(q.workDate).split(' ')[0].slice(0, 3) }));
      nc.appendChild(cal);
      const body = el('div', { cls: 'body' });
      body.appendChild(el('div', { cls: 'kicker', text: 'Neste vakt' }));
      body.appendChild(el('div', { cls: 'when', text: fmtDayShort(q.workDate).replace(/^./, (c) => c.toUpperCase()) }));
      body.appendChild(el('div', { cls: 'meta', text: fmtHM(q.plannedStartAt) + '–' + fmtHM(q.plannedEndAt) + ' · ' + tenantLabel(membership.tenantId) + (ROLE_LABELS[q.roleKey] ? ' · ' + ROLE_LABELS[q.roleKey] : '') }));
      if (isOvernight(q, TZ)) {
        const nt = el('span', { cls: 'night' });
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'); path.setAttribute('fill', 'currentColor'); svg.appendChild(path);
        nt.appendChild(svg); nt.appendChild(el('span', { text: 'Nattvakt · slutter neste dag' })); body.appendChild(nt);
      }
      nc.appendChild(body);
    } else {
      const body = el('div', { cls: 'body' });
      body.appendChild(el('div', { cls: 'kicker neutral', text: 'Neste vakt' }));
      body.appendChild(el('div', { cls: 'meta', text: 'Ingen flere planlagte vakter i denne perioden.' }));
      nc.appendChild(body);
    }
    side.appendChild(nc);

    // ---- this week: mini calendar strip (phone) + vertical summary (desktop), same array ----
    const week = weekFor(workDate, TZ, shifts, workDate);
    const wc = el('div', { cls: 'card' });
    const wr = el('div', { cls: 'row' });
    wr.appendChild(el('div', { cls: 'kicker neutral', text: 'Denne uken · uke ' + week.weekNumber }));
    const seeAll = el('button', { cls: 'btn tertiary', text: 'Se hele planen →', style: 'width:auto;padding:4px 0;min-height:0', attrs: { type: 'button' } }); seeAll.addEventListener('click', () => goSchedule(membership)); wr.appendChild(seeAll);
    wc.appendChild(wr);
    const WD = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
    const strip = el('div', { cls: 'strip' }); const list = el('div', { cls: 'wlist' });
    week.days.forEach((d, i) => {
      const assigned = d.shifts.filter((s) => s.projection.status === 'assigned');
      const cancelledOnly = d.shifts.length > 0 && assigned.length === 0;
      const stateCls = assigned.length ? ' work' : cancelledOnly ? ' cancel' : '';
      const num = String(parseInt(d.workDate.slice(8), 10));
      const aria = WD[i] + ' ' + d.workDate + (d.isToday ? ', i dag' : '') + ': ' + (assigned.length ? 'vakt' : cancelledOnly ? 'avlyst' : 'fri');
      const cell = el('div', { cls: 'day' + stateCls + (d.isToday ? ' today' : ''), attrs: { 'aria-label': aria } });
      cell.appendChild(el('div', { cls: 'wd', text: WD[i] })); cell.appendChild(el('div', { cls: 'num', text: num }));
      cell.appendChild(el('div', { cls: 'st', text: assigned.length ? fmtHM(assigned[0].projection.plannedStartAt) : cancelledOnly ? 'Avlyst' : 'Fri' }));
      strip.appendChild(cell);
      const row = el('div', { cls: 'wrow' + stateCls + (d.isToday ? ' today' : ''), attrs: { 'aria-label': aria } });
      const dn = el('div', { cls: 'dn' }); dn.appendChild(el('div', { cls: 'wd', text: WD[i] })); dn.appendChild(el('div', { cls: 'num', text: num })); row.appendChild(dn);
      const lab = el('div', { cls: 'lab' });
      if (assigned.length) { const a = assigned[0].projection; lab.appendChild(document.createTextNode(fmtHM(a.plannedStartAt) + '–' + fmtHM(a.plannedEndAt) + (isOvernight(a, TZ) ? ' (til neste dag)' : ''))); lab.appendChild(el('small', { text: tenantLabel(membership.tenantId) + (ROLE_LABELS[a.roleKey] ? ' · ' + ROLE_LABELS[a.roleKey] : '') + (assigned.length > 1 ? ' · +' + (assigned.length - 1) + ' vakt' : '') })); }
      else lab.appendChild(document.createTextNode(cancelledOnly ? fmtHM(d.shifts[0].projection.plannedStartAt) + '–' + fmtHM(d.shifts[0].projection.plannedEndAt) : 'Fri'));
      row.appendChild(lab);
      row.appendChild(el('span', { cls: 'tag', text: d.isToday ? 'I dag' : assigned.length ? 'Vakt' : cancelledOnly ? 'Avlyst' : 'Fri' }));
      list.appendChild(row);
    });
    wc.appendChild(strip); wc.appendChild(list);
    side.appendChild(wc);
  }
  function goTodaySlice1(membership) {
    current = membership; clear(root); setChrome(membership, 'today');
    const { workDate, shifts } = ownScheduleFor(membership);
    const nowMs = Date.now();
    const lookup = (shiftId) => attendanceStore.get(attendanceIdFor(shiftId, membership.ansattId)) || null;
    const hero = heroShiftFor(shifts, { nowMs, todayWorkDate: workDate, lookup });
    const person = FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId);

    const g = el('div', { cls: 'greet' });
    g.appendChild(el('h1', { text: greetingFor(nowMs) + (person ? ', ' + person.name : '') }));
    g.appendChild(el('div', { cls: 'date', text: new Date(nowMs).toLocaleDateString('nb-NO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }) }));
    root.appendChild(g);

    // ---- hero ----
    const entry = hero.entry; const p = entry ? entry.projection : null; const att = hero.attendance;
    const card = el('div', { cls: 'card hero' + (hero.kind === 'free' ? ' free' : '') });
    if (hero.kind === 'free') {
      card.appendChild(el('div', { cls: 'kicker neutral', text: 'Dagens vakt' }));
      card.appendChild(el('div', { cls: 'title', text: 'Fri i dag' }));
      card.appendChild(el('div', { cls: 'sub', text: 'Ingen planlagt vakt hos ' + tenantLabel(membership.tenantId) + '.' }));
      root.appendChild(card);
    } else {
      card.appendChild(el('div', { cls: 'kicker', text: hero.ongoingFromPriorDay ? 'Pågående vakt' : hero.kind === 'completed' ? 'Dagens vakt · fullført' : 'Dagens vakt' }));
      card.appendChild(el('div', { cls: 'title', text: fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, TZ) ? ' (til neste dag)' : '') }));
      card.appendChild(el('div', { cls: 'sub', text: tenantLabel(membership.tenantId) + (ROLE_LABELS[p.roleKey] ? ' · ' + ROLE_LABELS[p.roleKey] : '') + (hero.ongoingFromPriorDay ? ' · startet ' + fmtDayShort(p.workDate) : '') }));
      let stateText = 'Ikke stemplet inn', stateCls = 'status';
      if (att && att.status === 'clocked_in') { stateText = 'Stemplet inn kl. ' + fmtHM(att.observedClockInAt); stateCls = 'status on'; }
      else if (att && att.status === 'clocked_out') { stateText = 'Stemplet ut kl. ' + fmtHM(att.observedClockOutAt) + ' (inn ' + fmtHM(att.observedClockInAt) + ')'; }
      else if (hero.kind === 'completed') { stateText = 'Planlagt vakt er over'; }
      if (att && att.breakState === 'on_break') { stateText = 'På pause siden kl. ' + fmtHM(att.openBreakStartedAt); stateCls = 'status pause'; }
      const st = el('div', { cls: stateCls }); st.appendChild(el('span', { cls: 'dot' })); st.appendChild(el('span', { text: stateText })); card.appendChild(st);
      if (att && att.breakState !== 'on_break' && att.observedBreakMinutesTotal > 0) card.appendChild(el('div', { cls: 'cue-line', text: 'Observert pausetid: ' + att.observedBreakMinutesTotal + ' min (' + att.breakCount + ' pauser)' }));
      // schedule-window progress (planned window only; never worked/payable time)
      const span = p.plannedEndAt - p.plannedStartAt;
      if (nowMs < p.plannedStartAt) {
        const m = Math.round((p.plannedStartAt - nowMs) / 60000);
        card.appendChild(el('div', { cls: 'cue-line', text: 'Planlagt start om ' + (m >= 60 ? Math.floor(m / 60) + ' t ' + (m % 60) + ' min' : m + ' min') + '.' }));
      } else if (nowMs < p.plannedEndAt && span > 0) {
        const pct = Math.max(0, Math.min(100, Math.round(((nowMs - p.plannedStartAt) / span) * 100)));
        const m = Math.round((p.plannedEndAt - nowMs) / 60000);
        const pr = el('div', { cls: 'prog' }); const bar = el('div', { cls: 'bar' }); const fill = el('div', { cls: 'fill', style: 'width:' + pct + '%' }); bar.appendChild(fill); pr.appendChild(bar);
        pr.appendChild(el('div', { cls: 'lbl', text: 'Planlagt vakt: ' + pct + ' % av tiden er gått · ' + (m >= 60 ? Math.floor(m / 60) + ' t ' + (m % 60) + ' min' : m + ' min') + ' igjen til planlagt slutt' }));
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-label', 'Planlagt vakt');
        card.appendChild(pr);
      } else if (hero.kind !== 'completed') {
        card.appendChild(el('div', { cls: 'cue-line', text: 'Planlagt slutt er passert.' }));
      }
      if (hero.othersToday > 0) card.appendChild(el('div', { cls: 'cue-line', text: 'Du har også en vakt til i dag – se Plan.' }));
      root.appendChild(card);

      // ---- exactly ONE primary action ----
      const shift = clockShiftFrom(entry, membership);
      const attId = attendanceIdFor(shift.shiftId, membership.ansattId);
      const breaksOn = POLICY.breakMode !== 'none';
      const actionable = hero.kind === 'active' || hero.kind === 'current' || hero.kind === 'upcoming';
      if (!att && actionable) {
        root.appendChild(btn('STEMPLE INN', 'primary', () => openClockDialog(membership, shift, attId, 'in')));
      } else if (att && att.status === 'clocked_in') {
        if (att.breakState === 'on_break') {
          root.appendChild(btn('AVSLUTT PAUSE', 'primary', () => openBreakDialog(membership, shift, attId, 'break_end')));
        } else if (breaksOn) {
          root.appendChild(btn('START PAUSE', 'primary', () => openBreakDialog(membership, shift, attId, 'break_start')));
          root.appendChild(btn('Stemple ut', 'secondary', () => openClockDialog(membership, shift, attId, 'out')));
        } else {
          root.appendChild(btn('STEMPLE UT', 'primary', () => openClockDialog(membership, shift, attId, 'out')));
        }
      } else if (att && att.status === 'clocked_out') {
        root.appendChild(el('div', { cls: 'cue-line', text: 'Vakten er fullført for i dag.', style: 'text-align:center;color:#175330;font-weight:700;padding:10px 0' }));
      }
      if (breaksOn && att && (att.status === 'clocked_in' || att.status === 'clocked_out') && att.breakState !== 'on_break') {
        root.appendChild(btn('Glemt en pause? Registrer pausetid', 'tertiary', () => openDeclareBreakDialog(membership, shift, attId)));
      }
    }

    // ---- next shift (same own-schedule array) ----
    const after = entry && hero.kind !== 'completed' ? Math.max(nowMs, p.plannedStartAt) : nowMs;
    const nx = nextUpcomingShift(shifts, after);
    const nc = el('div', { cls: 'card next' });
    nc.appendChild(el('div', { cls: 'kicker neutral', text: 'Neste vakt' }));
    if (nx) {
      const q = nx.projection;
      nc.appendChild(el('div', { cls: 'when', text: fmtDayShort(q.workDate).replace(/^./, (c) => c.toUpperCase()) + ' · ' + fmtHM(q.plannedStartAt) + '–' + fmtHM(q.plannedEndAt) + (isOvernight(q, TZ) ? ' (til neste dag)' : '') }));
      nc.appendChild(el('div', { cls: 'meta', text: tenantLabel(membership.tenantId) + (ROLE_LABELS[q.roleKey] ? ' · ' + ROLE_LABELS[q.roleKey] : '') }));
    } else {
      nc.appendChild(el('div', { cls: 'meta', text: 'Ingen flere planlagte vakter i denne perioden.' }));
    }
    root.appendChild(nc);

    // ---- current week strip (Mon–Sun, same array) ----
    const week = weekFor(workDate, TZ, shifts, workDate);
    const wc = el('div', { cls: 'card' });
    const wr = el('div', { cls: 'row' });
    wr.appendChild(el('div', { cls: 'kicker neutral', text: 'Denne uken · uke ' + week.weekNumber }));
    const seeAll = el('button', { cls: 'btn tertiary', text: 'Se hele planen →', style: 'width:auto;padding:4px 0;min-height:0' }); seeAll.addEventListener('click', () => goSchedule(membership)); wr.appendChild(seeAll);
    wc.appendChild(wr);
    const strip = el('div', { cls: 'strip' });
    const WD = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
    week.days.forEach((d, i) => {
      const assigned = d.shifts.filter((s) => s.projection.status === 'assigned');
      const cancelledOnly = d.shifts.length > 0 && assigned.length === 0;
      const cell = el('div', { cls: 'day' + (assigned.length ? ' work' : cancelledOnly ? ' cancel' : '') + (d.isToday ? ' today' : '') });
      cell.appendChild(el('div', { cls: 'wd', text: WD[i] }));
      cell.appendChild(el('div', { cls: 'num', text: String(parseInt(d.workDate.slice(8), 10)) }));
      cell.appendChild(el('div', { cls: 'st', text: assigned.length ? fmtHM(assigned[0].projection.plannedStartAt) : cancelledOnly ? 'Avlyst' : 'Fri' }));
      cell.setAttribute('aria-label', WD[i] + ' ' + d.workDate + (d.isToday ? ', i dag' : '') + ': ' + (assigned.length ? 'vakt' : cancelledOnly ? 'avlyst' : 'fri'));
      strip.appendChild(cell);
    });
    wc.appendChild(strip);
    root.appendChild(wc);
  }
  function btn(label, kind, onClick) {
    const b = el('button', { cls: 'btn ' + kind, text: label, attrs: { type: 'button' } });
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- previous scaffold Today (kept intact for the clock/break dialog return path contract; not routed) ----
  function goTodayLegacy(membership) {
    clear(root);
    const { workDate, shifts } = ownScheduleFor(membership);       // same truth as Min plan
    const todayEntry = todayShiftOf(shifts, workDate);
    const nowMs = Date.now();
    const upcoming = nextUpcomingShift(shifts, nowMs);

    // header + greeting
    const now = new Date(nowMs);
    const person = FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId);
    root.appendChild(el('div', { text: 'SORMENA', style: 'font-weight:800;letter-spacing:1px;color:#2e7d46;font-size:16px' }));
    root.appendChild(el('div', { text: (person ? 'Hei, ' + person.name + ' · ' : '') + 'I dag · ' + now.toLocaleDateString('nb-NO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }), style: 'color:#666;font-size:13px;margin-bottom:14px' }));

    // no shift today: coherent day-off card, no clock actions
    if (!todayEntry) {
      const off = el('div', { style: 'border:1px solid #dfe6df;border-radius:12px;padding:16px;background:#fff;margin-bottom:16px' });
      off.appendChild(el('div', { text: 'Dagens vakt', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#2e7d46;font-weight:700;margin-bottom:6px' }));
      off.appendChild(el('div', { text: 'Fri i dag', style: 'font-weight:700;font-size:15px' }));
      off.appendChild(el('div', { text: upcomingText(upcoming), style: 'font-size:13px;color:#555;margin-top:8px' }));
      root.appendChild(off);
      root.appendChild(linkBtn('Se hele planen →', () => goSchedule(membership)));
      root.appendChild(linkBtn('Min jobb & økonomi →', () => goMyWork(membership)));
      root.appendChild(backBtn('Bytt ansatt', goChooser));
      return;
    }

    const shift = clockShiftFrom(todayEntry, membership);
    // ETR-2c: attendance id derives from the authoritative scope.shiftId; the deterministic fixture
    // shiftId IS the scope.shiftId seed, so this equals the id clockIn produces — on every visit.
    const attId = attendanceIdFor(shift.shiftId, membership.ansattId);
    const att = attendanceStore.get(attId) || null;   // L1: two reads (shift + attendance), no query

    // Today's shift card
    const card = el('div', { style: 'border:1px solid #dfe6df;border-radius:12px;padding:16px;background:#f6fff6;margin-bottom:16px' });
    card.appendChild(el('div', { text: 'Dagens vakt', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#2e7d46;font-weight:700;margin-bottom:6px' }));
    card.appendChild(el('div', { text: tenantLabel(shift.tenantId) + (ROLE_LABELS[shift.roleKey] ? ' · ' + ROLE_LABELS[shift.roleKey] : ''), style: 'font-weight:700;font-size:15px' }));
    card.appendChild(el('div', { text: 'Planlagt: ' + fmtHM(shift.plannedStartAt) + '–' + fmtHM(shift.plannedEndAt) + (isOvernight(todayEntry.projection, TZ) ? ' (til neste dag)' : ''), style: 'font-size:14px;color:#333;margin-top:2px' }));
    let stateText = 'Ikke stemplet inn';
    if (att && att.status === 'clocked_in') stateText = 'Stemplet inn kl. ' + fmtHM(att.observedClockInAt);
    else if (att && att.status === 'clocked_out') stateText = 'Stemplet ut kl. ' + fmtHM(att.observedClockOutAt) + ' (inn ' + fmtHM(att.observedClockInAt) + ')';
    card.appendChild(el('div', { text: 'Status: ' + stateText, style: 'font-size:13px;color:#555;margin-top:8px' }));
    if (att && att.breakState === 'on_break') {
      card.appendChild(el('div', { text: 'På pause siden kl. ' + fmtHM(att.openBreakStartedAt), style: 'font-size:13px;color:#6a5acd;font-weight:600;margin-top:4px' }));
    } else if (att && att.observedBreakMinutesTotal > 0) {
      // OBSERVED total shown as reference only (never auto-substituted for a declaration)
      card.appendChild(el('div', { text: 'Observert pausetid: ' + att.observedBreakMinutesTotal + ' min (' + att.breakCount + ' pauser)', style: 'font-size:12px;color:#888;margin-top:4px' }));
    }
    card.appendChild(el('div', { text: upcomingText(upcoming), style: 'font-size:12px;color:#777;margin-top:8px' }));
    root.appendChild(card);

    // dominant action(s) — break state machine (Freeze 003 §3.4)
    const breaksOn = POLICY.breakMode !== 'none';
    if (!att) {
      root.appendChild(bigBtn('STEMPLE INN', '#2e7d46', () => openClockDialog(membership, shift, attId, 'in')));
    } else if (att.status === 'clocked_in') {
      if (att.breakState === 'on_break') {
        // clock-out hidden/blocked while on_break, consistent with core BREAK_OPEN
        root.appendChild(bigBtn('AVSLUTT PAUSE', '#b8860b', () => openBreakDialog(membership, shift, attId, 'break_end')));
      } else {
        if (breaksOn) root.appendChild(bigBtn('START PAUSE', '#6a5acd', () => openBreakDialog(membership, shift, attId, 'break_start')));
        root.appendChild(bigBtn('STEMPLE UT', '#b8860b', () => openClockDialog(membership, shift, attId, 'out')));
      }
    } else {
      root.appendChild(el('div', { text: 'Vakten er fullført for i dag.', style: 'text-align:center;color:#2e7d46;font-weight:600;padding:12px' }));
    }

    // break declaration entry (only when there is an attendance and no break is open)
    if (breaksOn && att && (att.status === 'clocked_in' || att.status === 'clocked_out') && att.breakState !== 'on_break') {
      root.appendChild(linkBtn('Registrer pausetid →', () => openDeclareBreakDialog(membership, shift, attId)));
    }

    // secondary entry points
    root.appendChild(linkBtn('Se hele planen →', () => goSchedule(membership)));
    root.appendChild(linkBtn('Min jobb & økonomi →', () => goMyWork(membership)));
    root.appendChild(backBtn('Bytt ansatt', goChooser));
  }

  // "Neste vakt" text shared by the Today card and the day-off card (same source as Min plan).
  function upcomingText(entry) {
    if (!entry) return 'Ingen flere planlagte vakter i denne perioden.';
    const p = entry.projection;
    return 'Neste vakt: ' + fmtDayShort(p.workDate) + ' ' + fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, TZ) ? ' (til neste dag)' : '');
  }

  // ---- Employee time-action dialogs (owner QA-A): ONE product frame — a Sormena card with
  // kicker / title / context lines, labelled form rows through the shared #emp-root field styles,
  // and a two-button action row (confirm = primary, Avbryt = secondary and a NO-WRITE path back
  // to I dag). Only presentation lives here; every operation call below is unchanged.
  function dialogFrame(kicker, title, subs) {
    clear(root);
    const card = el('div', { cls: 'card dlg' });
    card.appendChild(el('div', { cls: 'kicker neutral', text: kicker }));
    card.appendChild(el('h2', { text: title }));
    for (const line of (subs || [])) if (line) card.appendChild(el('div', { cls: 'sub', text: line }));
    root.appendChild(card);
    return card;
  }
  function fieldRow(card, labelText, control) {
    const row = el('div', { cls: 'form-row' });
    row.appendChild(el('label', { text: labelText }));
    row.appendChild(control);
    card.appendChild(row);
    return control;
  }
  function dialogActions(card, confirmLabel, onConfirm, onCancel) {
    const acts = el('div', { cls: 'dlg-actions' });
    const ok = el('button', { cls: 'btn primary', text: confirmLabel, attrs: { type: 'button' } });
    ok.addEventListener('click', onConfirm);
    const cancel = el('button', { cls: 'btn secondary', text: 'Avbryt', attrs: { type: 'button' } });
    cancel.addEventListener('click', onCancel);
    acts.appendChild(ok); acts.appendChild(cancel);
    card.appendChild(acts);
    return ok;
  }
  // Reason options for an employee dialog kind — read live from the canonical policy taxonomy
  // (POLICY.reasonCodes[key].appliesTo); nothing is invented or hidden here.
  function reasonSelectFor(kind) {
    const sel = el('select');
    sel.appendChild(el('option', { text: '— Ingen —', attrs: { value: '' } }));
    for (const key of Object.keys(POLICY.reasonCodes)) {
      const cfg = POLICY.reasonCodes[key];
      if (cfg.appliesTo.includes(kind)) sel.appendChild(el('option', { text: REASON_LABELS[key] || key, attrs: { value: key } }));
    }
    return sel;
  }

  function openClockDialog(membership, shift, attId, kind) {
    const nowShown = Date.now();   // display only (B9): the observed instant is captured on confirm
    const plannedAt = kind === 'in' ? shift.plannedStartAt : shift.plannedEndAt;
    const card = dialogFrame('Dagens vakt', kind === 'in' ? 'Stemple inn' : 'Stemple ut', [
      tenantLabel(shift.tenantId) + ' · planlagt ' + fmtHM(plannedAt),
      'Nå: ' + fmtHM(nowShown) + ' · tidspunktet registreres når du bekrefter.',
    ]);
    // declared time (defaults to the action time; editable only if policy permits)
    const timeInput = fieldRow(card, 'Faktisk ' + (kind === 'in' ? 'start' : 'slutt'), el('input', { attrs: { type: 'time', value: fmtHM(nowShown) } }));
    if (POLICY.employeeMayAdjustTime !== true) timeInput.disabled = true;
    let declaredEdited = false;
    timeInput.addEventListener('input', () => { declaredEdited = true; });
    const reasonKind = kind === 'in' ? 'clock_in' : 'clock_out';
    const reasonSel = fieldRow(card, 'Årsak (kreves ved avvik)', reasonSelectFor(reasonKind));
    const noteInput = fieldRow(card, 'Notat (kreves ved «Annet»)', el('input', { attrs: { type: 'text', placeholder: 'Skriv kort hva som skjedde' } }));
    const errBox = el('div', { cls: 'form-err' });
    card.appendChild(errBox);
    dialogActions(card, kind === 'in' ? 'Bekreft innstempling' : 'Bekreft utstempling', () => {
      // B9: ONE injected action instant is both the observed fact and (by default) the
      // declared time. computeClockTimes never treats an earlier display value as observed.
      const { observedAt, declaredAt } = computeClockTimes({
        nowMs: Date.now(),
        declaredHM: declaredEdited ? timeInput.value : undefined,
        workDate: shift.workDate, timezone: TZ, mayAdjust: POLICY.employeeMayAdjustTime,
      });
      const now = observedAt;
      const declared = declaredAt;
      const reasonCode = reasonSel.value || null;
      const reasonNote = (noteInput.value || '').trim() || null;
      const actor = actorFromMembership(membership);
      const scope = { tenantId: membership.tenantId, shiftId: shift.shiftId };   // ETR-2c: full ScheduleScope — scope.shiftId is authority; the fixture shift.shiftId seeds it (equal packaging)
      let res;
      if (kind === 'in') {
        res = clockIn({ actor, shift, existing: attendanceStore.get(attId), declaredStartAt: declared, reasonCode, reasonNote, scope }, now, POLICY);
      } else {
        res = clockOut({ actor, existing: attendanceStore.get(attId), declaredEndAt: declared, reasonCode, reasonNote, scope }, now, POLICY);
      }
      if (res.ok) { attendanceStore.set(attId, res.attendance); goToday(membership); return; }
      if (res.code === 'REASON_REQUIRED') {
        const rr = reasonRequiredForClock(reasonKind, { declaredAt: declared, observedAt: now, plannedAt, policy: POLICY });
        errBox.textContent = 'Årsak kreves (avvik ' + Math.round(rr.declarationDeviationMin) + ' min fra registrert / ' + Math.round(rr.varianceMin) + ' min fra planlagt). Velg en gyldig årsak' + (reasonCode === 'OTHER' ? ' og skriv et notat.' : '.');
      } else {
        errBox.textContent = 'Kunne ikke registrere: ' + res.code;
      }
    }, () => goToday(membership));
  }

  // ETR-2b: START/END BREAK confirm dialog. Observed break time = the single injected instant
  // on confirm; no reason prompt here (variance lives on declaration).
  function openBreakDialog(membership, shift, attId, kind) {
    const nowShown = Date.now();
    const isStart = kind === 'break_start';
    const card = dialogFrame('Dagens vakt', isStart ? 'Start pause' : 'Avslutt pause', [
      tenantLabel(shift.tenantId),
      'Nå: ' + fmtHM(nowShown) + ' · tidspunktet registreres når du bekrefter.',
    ]);
    const errBox = el('div', { cls: 'form-err' });
    card.appendChild(errBox);
    dialogActions(card, isStart ? 'Bekreft pausestart' : 'Bekreft pauseslutt', () => {
      const now = Date.now();   // single injected action instant = observed break time
      const actor = actorFromMembership(membership);
      const scope = { tenantId: membership.tenantId };
      const existing = attendanceStore.get(attId);
      const res = isStart
        ? startBreak({ actor, existing, scope }, now, POLICY)
        : endBreak({ actor, existing, scope }, now, POLICY);
      if (res.ok) { attendanceStore.set(attId, res.attendance); goToday(membership); return; }
      errBox.textContent = 'Kunne ikke registrere: ' + res.code;
    }, () => goToday(membership));
  }

  // ETR-2b: dedicated employee break DECLARATION. Observed total is shown as reference
  // only; the declared minutes are an explicit employee entry (never auto-filled from
  // observed). Reason prompt follows B13-B16 via the core variance gate.
  function openDeclareBreakDialog(membership, shift, attId) {
    const att = attendanceStore.get(attId);
    const card = dialogFrame('Dagens vakt', 'Registrer pausetid', [
      tenantLabel(shift.tenantId) + ' · forventet ' + POLICY.expectedBreakMinutes + ' min',
      'Registrert pause så langt: ' + (att ? att.observedBreakMinutesTotal : 0) + ' min (kun til orientering)',
    ]);
    const minInput = fieldRow(card, 'Din oppgitte totale pausetid (minutter)', el('input', { attrs: { type: 'number', min: '0', step: '1', placeholder: 'minutter' } }));
    const reasonSel = fieldRow(card, 'Årsak (kreves ved avvik)', reasonSelectFor('break'));
    const noteInput = fieldRow(card, 'Notat (kreves ved «Annet»)', el('input', { attrs: { type: 'text', placeholder: 'Skriv kort hva som skjedde' } }));
    const errBox = el('div', { cls: 'form-err' });
    card.appendChild(errBox);
    dialogActions(card, 'Bekreft pausetid', () => {
      const now = Date.now();
      const raw = (minInput.value || '').trim();
      if (raw === '' || !/^\d+$/.test(raw)) { errBox.textContent = 'Oppgi et helt antall minutter (0 eller mer).'; return; }
      const declaredBreakMinutesTotal = parseInt(raw, 10);
      const reasonCode = reasonSel.value || null;
      const reasonNote = (noteInput.value || '').trim() || null;
      const actor = actorFromMembership(membership);
      const scope = { tenantId: membership.tenantId };
      const res = declareBreak({ actor, existing: attendanceStore.get(attId), declaredBreakMinutesTotal, reasonCode, reasonNote, scope }, now, POLICY);
      if (res.ok) { attendanceStore.set(attId, res.attendance); goToday(membership); return; }
      if (res.code === 'REASON_REQUIRED') {
        const rr = reasonRequiredForBreak(declaredBreakMinutesTotal, POLICY);
        errBox.textContent = 'Årsak kreves (avvik ' + Math.round(rr.varianceMin) + ' min fra forventet ' + POLICY.expectedBreakMinutes + ' min). Velg en gyldig årsak' + (reasonCode === 'OTHER' ? ' og skriv et notat.' : '.');
      } else {
        errBox.textContent = 'Kunne ikke registrere: ' + res.code;
      }
    }, () => goToday(membership));
  }

  function goMyWork(membership) {
    current = membership; setChrome(membership, 'work');
    clear(root);
    const today = tenantWorkDate(Date.now(), TZ);
    const e = employeeOf(employeeStore(), membership.tenantId, membership.ansattId);
    const facts = minAnsettelseFra({
      terms: e ? currentTermsOf(e, today) : null,
      startDate: e ? startDateOf(e) : null,
      contractStatus: e ? contractStatusOf(e) : null,
      roleLabels: ROLE_LABELS,
    });
    const wrap = el('div', { cls: 'card', style: 'max-width:640px' });
    wrap.appendChild(el('div', { cls: 'kicker neutral', text: 'Jobb & økonomi' }));
    wrap.appendChild(el('h2', { text: 'Min ansettelse' }));
    wrap.appendChild(el('div', { text: (e ? e.name + ' · ' : '') + tenantLabel(membership.tenantId), style: 'color:#5f6b62;font-size:14px;margin-bottom:10px' }));
    for (const r of facts.rows) {
      // existing employee-row surface (shared styles): label muted, value bold, missing as a neutral pill
      const row = el('div', { cls: 'emp-row static' });   // read-only: no hover affordance (owner QA-D)
      const top = el('div', { cls: 'top' });
      top.appendChild(el('span', { cls: 'sub', text: r.label }));
      top.appendChild(r.missing ? el('span', { cls: 'st', text: r.value }) : el('span', { cls: 'nm', text: r.value }));
      row.appendChild(top);
      wrap.appendChild(row);
    }
    wrap.appendChild(el('div', { text: SCOPE_LINE, style: 'color:#5f6b62;font-size:14px;margin-top:10px' }));
    root.appendChild(wrap);
    root.appendChild(backBtn('← Tilbake til i dag', () => goToday(membership)));
  }

  // ---- MIN PLAN (read-only week view; same membership, same schedule truth, clock state untouched) ----
  function goSchedule(membership) {
    current = membership; setChrome(membership, 'plan');
    clear(root);
    // Two sibling roots: the protected schedule view owns (and clears) only planRoot, so the
    // Ledige vakter surface below survives the view's internal Uke/Måned redraws.
    const planRoot = el('div'); const ledigeRoot = el('div');
    root.appendChild(planRoot); root.appendChild(ledigeRoot);
    const { shifts } = ownScheduleFor(membership);
    renderScheduleView(planRoot, {
      membership, tenantLabel: tenantLabel(membership.tenantId), shifts,
      nowMs: Date.now(), timezone: TZ, roleLabels: ROLE_LABELS,
    });   // no onBack: the single back control is placed by the shell AFTER Ledige vakter (owner QA-C)
    // ---- LEDIGE VAKTER: eligible open shifts from the SAME shared store; "Ta vakten" goes
    // through the single claim operation boundary and fails closed if the shift is taken. ----
    const store = scheduleStore();
    const person = FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId) || { ansattId: membership.ansattId, name: '' };
    const open = openShiftsOf(store, membership.tenantId).filter((s) => isEligible(person, s.projection, membership.tenantId));
    const card = el('div', { cls: 'card', style: 'margin-top:14px' });
    card.appendChild(el('div', { cls: 'kicker' + (open.length ? '' : ' neutral'), text: 'Ledige vakter (' + open.length + ')' }));
    const errBox = el('div', { style: 'color:#a33;font-size:13px;min-height:0' });
    if (!open.length) card.appendChild(el('div', { style: 'color:#8a948c;font-size:14px', text: 'Ingen ledige vakter akkurat nå.' }));
    for (const s of open) {
      const p = s.projection;
      const row = el('div', { cls: 'shift' });
      row.appendChild(el('div', { cls: 't', text: fmtDayShort(p.workDate).replace(/^./, (c) => c.toUpperCase()) + ' · ' + fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, TZ) ? ' (til neste dag)' : '') }));
      row.appendChild(el('div', { cls: 'm', text: tenantLabel(membership.tenantId) }));
      const take = btn('Ta vakten', 'secondary', () => {
        const res = applyScheduleOperation({
          store, tenantId: membership.tenantId, actor: null,
          op: { kind: 'claim', shiftId: s.shiftId, ansattId: membership.ansattId },
          now: Date.now(), policy: POLICY,
          deps: {
            resolveAssignee: (a) => (FOUR_SEASON_PEOPLE.some((x) => x.ansattId === a) || VAKTPLAN_PEOPLE.some((x) => x.ansattId === a))
              ? { status: 'FOUND', tenantId: membership.tenantId, ansattId: a } : { status: 'NOT_FOUND' },
          },
        });
        if (res.ok) { goSchedule(membership); }   // claimed shift now renders in normal Uke/Måned from the same store
        else {
          errBox.textContent = res.code === 'SHIFT_TAKEN' ? 'Vakten er allerede tatt.'
            : res.code === 'SHIFT_CANCELLED' ? 'Vakten er avlyst og ikke lenger tilgjengelig.'
            : 'Vakten er ikke tilgjengelig (' + res.code + ').';
        }
      });
      take.style.marginTop = '8px';
      row.appendChild(take);
      card.appendChild(row);
    }
    card.appendChild(errBox);
    ledigeRoot.appendChild(card);
    // ONE terminal back control after all Plan content; clock state is untouched on return.
    root.appendChild(backBtn('← Tilbake til i dag', () => goToday(membership)));
  }

  // ---- VAKTPLAN (ledelse): manager Uke/Måned planner over the SAME schedule store ------------
  // Capability-gated (canOpenVaktplan on the fixture manager actor — not "clicked Ledelse"
  // shaped). "Se som ansatt" is a MANAGER PROJECTION: the manager remains the actor and
  // viewingAsAnsattId is only a projection target (admin-shaped read) — never an identity
  // switch. The attendance dep exposes an EXISTENCE boolean only (frozen cancel invariant).
  function managerChrome(nmText) {
    const idb = document.getElementById('emp-identity');
    if (idb) {
      idb.hidden = false; idb.onclick = goChooser;
      const av = idb.querySelector('.av'), nm = idb.querySelector('.nm');
      if (av) av.textContent = 'L';
      if (nm) nm.textContent = nmText;
      idb.setAttribute('aria-label', 'Bytt visning');
    }
    const nav = document.getElementById('emp-nav');
    if (nav) nav.hidden = true;                      // the manager surface has no employee tab bar
  }
  function goVaktplan(prefillName) {
    if (!canOpenVaktplan(FOUR_SEASON_MANAGER_ACTOR)) return goChooser();   // capability routing, fail closed
    clear(root);
    managerChrome('Ledelse');
    // People (incl. planning compensation) are DERIVED from current employment terms — the
    // Vaktplan no longer carries its own stored compensation truth. Under ?scale=40 the
    // synthetic grid set is used instead, unchanged, purely for the render scale proof.
    const people = SCALE40 ? VAKTPLAN_PEOPLE : vaktplanPeople();
    renderManagementView(root, {
      store: scheduleStore(), tenantId: FOUR_SEASON_TENANT.tenantId,
      tenantLabel: tenantLabel(FOUR_SEASON_TENANT.tenantId),
      people, roleLabels: ROLE_LABELS,
      actor: FOUR_SEASON_MANAGER_ACTOR, policy: POLICY,
      deps: {
        resolveAssignee: (ansattId) => people.some((p) => p.ansattId === ansattId)
          ? { status: 'FOUND', tenantId: FOUR_SEASON_TENANT.tenantId, ansattId }
          : { status: 'NOT_FOUND' },
        attendanceExistsFor: (shiftId, ansattId) => attendanceStore.has(attendanceIdFor(shiftId, ansattId)),
      },
      nowMs: Date.now(), timezone: TZ,
      initialQuery: typeof prefillName === 'string' ? prefillName : '',
      onViewAs: (ansattId) => goVaktplanViewAs(ansattId),
    });
  }
  // ---- ANSATTE (Employee 360): same schedule truth, employment terms as the single basis ----
  // The company-contract profile is the ONE runtime truth for shared Four Season agreement
  // facts (pension / yrkesskadeforsikring / tariffavtale): seeded once from the frozen fixture
  // config, editable via the management Avtaleoppsett card, reused by every employee's
  // agreement. Local/demo state only — no production persistence in this release.
  let companyContractProfile = null;
  function contractProfile() {
    if (!companyContractProfile) companyContractProfile = JSON.parse(JSON.stringify(FOUR_SEASON_CONTRACT_PROFILE));
    return companyContractProfile;
  }
  function goAnsatte() {
    if (!canViewEmployees(FOUR_SEASON_MANAGER_ACTOR)) return goChooser();
    clear(root);
    managerChrome('Ledelse');
    renderEmployeesView(root, {
      employeeStore: employeeStore(), scheduleStore: scheduleStore(),
      tenantId: FOUR_SEASON_TENANT.tenantId, tenantLabel: tenantLabel(FOUR_SEASON_TENANT.tenantId),
      roleLabels: ROLE_LABELS, actor: FOUR_SEASON_MANAGER_ACTOR,
      contractProfile: contractProfile(),   // tenant config, not rendering literals
      payrollStore: payrollStore(),         // SAME package truth as the Lønnsgrunnlag surface
      nowMs: Date.now(), timezone: TZ,
      onOpenVaktplanFor: (name) => goVaktplan(name),
      onBack: goChooser,
    });
  }
  // ---- LEDELSE WORKSPACE (Increment 3A §1): ONE persistent frame, four section tabs ----------
  // The tabs are PRESENTATION DOORWAYS into the existing capability views — each view module is
  // mounted unchanged into the frame's content element. No truth merges, no logic moves. Tab
  // availability follows the SAME capability gates as before; an unavailable tab is absent, not
  // a dead control. In-session view state the owner cares about (Lønnsgrunnlag month + open row,
  // Vaktplan week) is held HERE, in the shell, so switching tabs does not lose it.
  let LEDELSE_TAB = 'oversikt';
  const LG_STATE = { periodId: null, openEmployee: null };
  const VP_STATE = { offset: 0, query: '' };
  function ledelseTabs() {
    const tabs = [];
    if (canOpenVaktplan(FOUR_SEASON_MANAGER_ACTOR) || canViewEmployees(FOUR_SEASON_MANAGER_ACTOR)) tabs.push({ key: 'oversikt', label: 'Oversikt' });
    if (canOpenVaktplan(FOUR_SEASON_MANAGER_ACTOR)) tabs.push({ key: 'vaktplan', label: 'Vaktplan' });
    if (canViewEmployees(FOUR_SEASON_MANAGER_ACTOR)) {
      tabs.push({ key: 'ansatte', label: 'Ansatte' });
      tabs.push({ key: 'lonn', label: 'Lønn & økonomi' });
    }
    return tabs;
  }
  function goLedelse(tab) {
    const tabs = ledelseTabs();
    if (!tabs.length) return goChooser();
    if (tab) LEDELSE_TAB = tab;
    if (!tabs.some((t) => t.key === LEDELSE_TAB)) LEDELSE_TAB = tabs[0].key;
    clear(root);
    managerChrome('Ledelse');
    const frame = el('div', { cls: 'lede-frame' });
    const bar = el('div', { cls: 'lede-tabs', attrs: { role: 'tablist', 'aria-label': 'Ledelse' } });
    for (const t of tabs) {
      const b = el('button', { cls: 'lede-tab' + (t.key === LEDELSE_TAB ? ' on' : ''), text: t.label, attrs: { type: 'button', role: 'tab', 'aria-selected': t.key === LEDELSE_TAB ? 'true' : 'false' } });
      b.addEventListener('click', () => goLedelse(t.key));      // stays inside the frame
      bar.appendChild(b);
    }
    frame.appendChild(bar);
    const content = el('div', { cls: 'lede-content' });
    frame.appendChild(content);
    root.appendChild(frame);
    if (LEDELSE_TAB === 'oversikt') drawOversikt(content);
    else if (LEDELSE_TAB === 'vaktplan') mountVaktplan(content);
    else if (LEDELSE_TAB === 'ansatte') mountAnsatte(content);
    else mountLonnsgrunnlag(content);
    const exit = el('button', { cls: 'btn tertiary', text: '← Bytt visning', attrs: { type: 'button' } });
    exit.addEventListener('click', goChooser);
    root.appendChild(exit);
  }
  // ---- OVERSIKT V1 — owner cockpit (Sirrha OVERSIKT-V1-OWNER-COCKPIT-BUILD-RELEASE-001) ------
  // "Hva skjer i virksomheten min, og hva trenger meg?" — attention first, then today, then the
  // month's payroll facts, then people. READ-ONLY composition over the SAME projections the tabs
  // draw: the shell fetches them here exactly as the tabs do, management-oversikt.mjs turns them
  // into rows, and the payroll facts come from the ONE shared composition (monthFactsOf) that
  // Lønn & økonomi's cards use. Nothing on this page sums, stores or infers anything of its own.
  function oversiktFacts() {
    const today = tenantWorkDate(Date.now(), TZ);
    const T = FOUR_SEASON_TENANT.tenantId;
    const tabs = ledelseTabs().map((t) => t.key);
    const out = { today, tabs, dag: null, lonn: null, ansatte: null };
    if (tabs.includes('vaktplan')) {
      // managerWeekFor / openShiftsOf are the EXISTING Vaktplan projections; the attendance read is
      // the same attendanceStore.get(attendanceIdFor(...)) the employee home and Vaktplan deps use.
      const people = vaktplanPeople();
      const week = managerWeekFor({ anchorWorkDate: today, timezone: TZ, container: scheduleStore(), tenantId: T, people, todayWorkDate: today });
      out.dag = dagensBildeFra({ week, openShifts: openShiftsOf(scheduleStore(), T), today, people, lookup: (shiftId, ansattId) => attendanceStore.get(attendanceIdFor(shiftId, ansattId)) || null, fmtHM, roleLabels: ROLE_LABELS });
    }
    if (tabs.includes('ansatte')) {
      out.ansatte = ansattFaktaFra(employeesOf(employeeStore(), T).map((e) => ({ ansattId: e.ansattId, name: e.name, status: e.status, missing: missingInfoOf(e, today) })));
    }
    if (tabs.includes('lonn')) {
      const periodId = today.slice(0, 7);   // the CURRENT period
      const pkg = buildPayrollPackage({ employeeStore: employeeStore(), scheduleStore: scheduleStore(), attendanceStore, tenantId: T, periodId, generatedAt: Date.now(), todayWorkDate: today });
      // Frozen behaviour mirrors Lønn & økonomi's draw(): an approved/sent version shows ITS OWN
      // snapshot rows; the planning projection stays live (estimates are never frozen).
      const approved = versionsOf(payrollStore(), T, periodId).find((v) => v.status === 'godkjent' || v.status === 'sendt') || null;
      const rows = approved ? approved.snapshot.rows : pkg.rows;
      out.lonn = {
        periodId, label: periodLabel(periodId), approved, calendar: pkg.calendar,
        facts: monthFactsOf({ rows, plannedFor: plannedShiftsForPayroll, periodId, planning: planningEconomyForPeriod(periodId), todayWorkDate: today, frozen: !!approved }),
      };
    }
    return out;
  }
  // Navigation = the existing Ledelse tab seam plus the shell-held tab state; no router, no URL.
  function goOversiktTarget(target, f, openEmployee) {
    if (target === 'lonn' && f.lonn) { LG_STATE.periodId = f.lonn.periodId; LG_STATE.openEmployee = openEmployee || null; goLedelse('lonn'); }
    else if (target === 'vaktplan') { VP_STATE.offset = 0; goLedelse('vaktplan'); }   // offset 0 = the week holding today
    else goLedelse('ansatte');
  }
  function drawOversikt(host) {
    const f = oversiktFacts();
    // 1. KREVER DIN OPPMERKSOMHET — compact action rows, or the honest empty state.
    const items = oppmerksomhetFra({ monthFacts: f.lonn ? f.lonn.facts : null, periodLabel: f.lonn ? f.lonn.label : '', ansatte: f.ansatte, openTodayCount: f.dag ? f.dag.openCount : 0 });
    const s1 = ovSection('Krever din oppmerksomhet');
    if (!items.length) s1.appendChild(el('div', { cls: 'ov-empty', text: EMPTY_ATTENTION }));
    for (const it of items) s1.appendChild(ovRow(it.text, it.tone, () => goOversiktTarget(it.target, f, it.openEmployee)));
    host.appendChild(s1);
    // 2. I DAG — one line per assigned shift with the attendance state the record carries.
    if (f.dag) {
      const s2 = ovSection('I dag · ' + fmtDayShort(f.today));
      if (!f.dag.assigned.length && !f.dag.open.length) s2.appendChild(el('div', { cls: 'ov-empty', text: 'Ingen planlagte vakter i dag.' }));
      for (const l of f.dag.assigned) {   // one scan line: name | planned time | attendance state (owner visual B)
        const row = el('div', { cls: 'ov-dag' });
        row.appendChild(el('div', { cls: 'who', text: l.name }));
        row.appendChild(el('div', { cls: 'when', text: l.time }));
        row.appendChild(el('div', { cls: 'ov-state ' + l.state.key, text: l.state.text }));
        s2.appendChild(row);
      }
      for (const o of f.dag.open) {
        const row = el('div', { cls: 'ov-dag' });
        row.appendChild(el('div', { cls: 'who', text: 'Åpen vakt' + (o.role ? ' · ' + o.role : '') }));
        row.appendChild(el('div', { cls: 'when', text: o.time }));
        row.appendChild(el('div', { cls: 'ov-state open', text: 'Ikke tildelt' }));
        s2.appendChild(row);
      }
      s2.appendChild(ovRow('Åpne Vaktplan for i dag', 'go', () => goOversiktTarget('vaktplan', f)));
      host.appendChild(s2);
    }
    // 3. LØNNSGRUNNLAG · <current month> — the same facts as the Lønn & økonomi cards.
    if (f.lonn) {
      const L = f.lonn, m = L.facts, a = L.approved;
      const s3 = ovSection('Lønnsgrunnlag · ' + L.label);
      s3.appendChild(ovFact('Status', a ? (a.status === 'sendt' ? 'Sendt' : 'Godkjent v' + a.version) : 'Utkast · ' + m.chip.label, L.calendar.configured ? 'Frist ' + L.calendar.targetDate : L.calendar.label));
      s3.appendChild(ovFact('Planlagte timer', m.plannedHoursTotal == null ? '–' : fmtH(m.plannedHoursTotal), 'planlagt bemanning fra Vaktplan'));
      // Oversikt summarises (owner visual C): headline + the existing coverage line from the same seam; the named
      // exclusions stay where the detail lives, in Lønn & økonomi (monthFactsOf.estimate.subs, unchanged there).
      s3.appendChild(ovFact('Estimert planlagt kostnad', m.estimate ? ((m.estimate.coveredCount ? fmtKr(m.estimate.kr) : '–') + ' ' + m.estimate.label) : '– (estimat)', m.estimate ? m.estimate.coverageLine : 'ingen planprojeksjon tilgjengelig'));
      s3.appendChild(ovFact('Faktiske timer', fmtH(m.actualHours), m.frozen ? 'fra frosset versjon' : 'fra registrert tid'));
      s3.appendChild(ovFact('Godkjente timer', fmtH(m.approvedHours), null));
      s3.appendChild(ovFact('Krever handling', String(m.actionCount), m.actionParts.length ? m.actionParts.join(' · ') : 'ingenting krever handling'));
      s3.appendChild(ovRow('Åpne Lønn & økonomi', 'go', () => goOversiktTarget('lonn', f)));
      host.appendChild(s3);
    }
    // 4. ANSATTE — counts from the existing missing-info classification only.
    if (f.ansatte) {
      const A = f.ansatte;
      const s4 = ovSection('Ansatte');
      s4.appendChild(ovFact('Aktive ansatte', String(A.active), null));
      s4.appendChild(ovFact('Alt utfylt', A.complete + ' av ' + A.total, null));
      s4.appendChild(ovFact('Mangler opplysninger', String(A.incomplete), A.categories.length ? A.categories.map((c) => c.count + ' ' + c.label).join(' · ') : null));
      s4.appendChild(ovRow('Åpne Ansatte', 'go', () => goOversiktTarget('ansatte', f)));
      host.appendChild(s4);
    }
    host.appendChild(el('div', { cls: 'vp-note', text: 'Oversikten viser eksisterende status fra de samme kildene som fanene – ingen egne beregninger.' }));
  }
  function ovSection(title) {
    const c = el('div', { cls: 'card ov-sec' });
    c.appendChild(el('div', { cls: 'kicker neutral', text: title }));
    return c;
  }
  function ovRow(text, tone, onOpen) {
    const b = el('button', { cls: 'ov-row' + (tone ? ' ' + tone : ''), attrs: { type: 'button' } });
    b.appendChild(el('span', { text }));
    b.appendChild(el('span', { cls: 'chev', text: '›' }));
    b.addEventListener('click', onOpen);
    return b;
  }
  function ovFact(label, value, sub) {
    const r = el('div', { cls: 'ov-fact' });
    r.appendChild(el('div', { cls: 'k', text: label }));
    r.appendChild(el('div', { cls: 'v', text: value }));
    if (sub) r.appendChild(el('div', { cls: 's', text: sub }));
    return r;
  }
  function mountVaktplan(host) {
    // Same module, same people/deps derivation as the standalone destination used — only the
    // mount target and the shell-held week/query state differ.
    const people = SCALE40 ? VAKTPLAN_PEOPLE : vaktplanPeople();
    const q = VP_STATE.query || '';
    VP_STATE.query = '';
    renderManagementView(host, {
      store: scheduleStore(), tenantId: FOUR_SEASON_TENANT.tenantId,
      tenantLabel: tenantLabel(FOUR_SEASON_TENANT.tenantId), people, roleLabels: ROLE_LABELS,
      actor: FOUR_SEASON_MANAGER_ACTOR, policy: POLICY,
      deps: {
        resolveAssignee: (ansattId) => people.some((p) => p.ansattId === ansattId)
          ? { status: 'FOUND', tenantId: FOUR_SEASON_TENANT.tenantId, ansattId }
          : { status: 'NOT_FOUND' },
        attendanceExistsFor: (shiftId, ansattId) => attendanceStore.has(attendanceIdFor(shiftId, ansattId)),
      },
      nowMs: Date.now(), timezone: TZ,
      onViewAs: (ansattId) => goVaktplanViewAs(ansattId),
      initialQuery: q,
      initialOffset: VP_STATE.offset,
      onOffsetChange: (o) => { VP_STATE.offset = o; },
    });
  }
  function mountAnsatte(host) {
    renderEmployeesView(host, {
      employeeStore: employeeStore(), scheduleStore: scheduleStore(),
      tenantId: FOUR_SEASON_TENANT.tenantId, tenantLabel: tenantLabel(FOUR_SEASON_TENANT.tenantId),
      roleLabels: ROLE_LABELS, actor: FOUR_SEASON_MANAGER_ACTOR,
      contractProfile: contractProfile(), payrollStore: payrollStore(),
      nowMs: Date.now(), timezone: TZ,
      // Ledelse-internal jump: stay inside the workspace, switch tab with the name carried over.
      onOpenVaktplanFor: (name) => { VP_STATE.query = typeof name === 'string' ? name : ''; goLedelse('vaktplan'); },
    });
  }
  function mountLonnsgrunnlag(host) {
    const today = tenantWorkDate(Date.now(), TZ);
    if (!LG_STATE.periodId) LG_STATE.periodId = today.slice(0, 7);
    renderPayrollView(host, {
      employeeStore: employeeStore(), scheduleStore: scheduleStore(), attendanceStore,
      payrollStore: payrollStore(),
      tenantId: FOUR_SEASON_TENANT.tenantId, actor: FOUR_SEASON_MANAGER_ACTOR,
      operatorName: operatorDisplayName(),
      nowMs: Date.now(), timezone: TZ, todayWorkDate: today,
      initialPeriodId: LG_STATE.periodId, initialOpenEmployee: LG_STATE.openEmployee,
      onStateChange: (s) => { LG_STATE.periodId = s.periodId; LG_STATE.openEmployee = s.openEmployee; },
      manualContext: manualTimeContext,
      onManualTime: submitManualTime,
      plannedShiftsFor: plannedShiftsForPayroll,   // P1: read-only planned projection for DAGER I PERIODEN
      planningFor: planningEconomyForPeriod,       // P2: labelled planning estimates, view-only
    });
  }
  // P2: the pure planning-economy projection over the SAME canonical stores (schedule + employment
  // terms). Recomputed on every render, never stored, never part of the payroll package.
  function planningEconomyForPeriod(periodId) {
    return planningEconomyFor({ employeeStore: employeeStore(), scheduleStore: scheduleStore(), tenantId: FOUR_SEASON_TENANT.tenantId, periodId });
  }
  // P1: the SAME canonical schedule read the manual-time resolver uses (shiftsForEmployee over
  // the one store), plus the core's own planned-hours arithmetic per shift. Read-only; nothing is
  // copied anywhere and the view stores nothing.
  function plannedShiftsForPayroll(ansattId) {
    return shiftsForEmployee(scheduleStore(), FOUR_SEASON_TENANT.tenantId, ansattId, FOUR_SEASON_MANAGER_ACTOR)
      .map((s) => ({ shiftId: s.shiftId, projection: s.projection, hours: durationHoursOf(s.projection) }));
  }

  // ---- 3B-UI: manager manual time — the INTEGRATION seam ---------------------------------------
  // Everything here is transport: the view collects input, this resolves the target from the SAME
  // runtime data the payroll projection reads, calls the ACCEPTED foundation operation, and writes
  // the returned canonical record into the SAME attendanceStore the employee surfaces write.
  // No arithmetic, no second store, no second derivation.
  function manualScope() { return { tenantId: FOUR_SEASON_TENANT.tenantId }; }
  // The reason contract is READ from the live policy — the UI invents no reason truth.
  function managerReasonCodes() {
    const out = [];
    const codes = POLICY.reasonCodes || {};
    for (const code of Object.keys(codes)) {
      const cfg = codes[code];
      if (!cfg || !cfg.appliesTo.includes('manager')) continue;
      out.push({ code, label: MANAGER_REASON_LABELS[code] || code, requiresNote: !!cfg.requiresNote });
    }
    return out;
  }
  // CANONICAL EMPLOYMENT (binding caller rule): sourced from the management-employees-core
  // projection at the call site — startDateOf() and the same status/endedAt expression the payroll
  // core itself uses (management-payroll-core.mjs:170-171). Never a literal, never a re-derivation,
  // never read back from rendered text.
  function employmentOf(ansattId) {
    const e = employeeOf(employeeStore(), FOUR_SEASON_TENANT.tenantId, ansattId);
    if (!e) return null;
    return { startDate: startDateOf(e), endDate: e.status === 'active' ? null : (e.endedAt || null) };
  }
  function recordsForEmployee(ansattId) {
    const out = [];
    for (const rec of attendanceStore.values()) if (rec && rec.ansattId === ansattId) out.push(rec);
    return out;
  }
  function manualTimeContext({ ansattId, workDate }) {
    const shifts = shiftsForEmployee(scheduleStore(), FOUR_SEASON_TENANT.tenantId, ansattId, FOUR_SEASON_MANAGER_ACTOR);
    const target = manualTargetFor({ records: recordsForEmployee(ansattId), shifts, workDate });
    const hint =
      target.mode === 'correct' ? 'Dagen finnes allerede. Lagring korrigerer den registreringen.'
      : target.mode === 'live' ? 'Økten pågår. Du kan ikke legge til en ny dag mens den løper.'
      : target.mode === 'm1' ? 'Føres på den planlagte vakten denne dagen.'
      : target.mode === 'choose' ? 'Flere vakter denne dagen — velg hvilken.'
      : target.mode === 'choose_record' ? 'Flere registreringer denne dagen — korriger fra dag-for-dag-listen.'
      : 'Ingen vakt denne dagen. Dagen føres som en manuell dag.';
    return {
      mode: target.mode,
      reasonCodes: managerReasonCodes(),
      hint,
      candidates: (target.candidates || []).map((s) => ({
        shiftId: s.shiftId,
        label: fmtTenantHM(s.projection.plannedStartAt, TZ) + '–' + fmtTenantHM(s.projection.plannedEndAt, TZ),
      })),
    };
  }
  function submitManualTime(form) {
    const now = Date.now();
    const wd = form.workDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wd || '')) return { ok: false, code: 'WORKDATE_INVALID' };
    // No coercion: an empty or malformed time is passed on as a non-instant and refused by name.
    const toMs = (hm) => (/^\d{2}:\d{2}$/.test(hm || '') ? tenantLocalHMToUtcMs(wd, hm, TZ) : null);
    const declaredStartAt = toMs(form.startHM);
    const declaredEndAt = toMs(form.endHM);
    const breakRaw = String(form.breakMin == null ? '' : form.breakMin).trim();
    const declaredBreakMinutesTotal = /^\d+$/.test(breakRaw) ? Number(breakRaw) : null;
    if (declaredBreakMinutesTotal === null) return { ok: false, code: 'DECLARED_BREAK_INVALID' };
    const employment = employmentOf(form.ansattId);
    if (!employment) return { ok: false, code: 'EMPLOYMENT_REQUIRED' };
    const shifts = shiftsForEmployee(scheduleStore(), FOUR_SEASON_TENANT.tenantId, form.ansattId, FOUR_SEASON_MANAGER_ACTOR);
    const target = manualTargetFor({ records: recordsForEmployee(form.ansattId), shifts, workDate: wd });

    if (target.mode === 'choose_record') return { ok: false, code: 'RECORD_CHOICE_REQUIRED' };
    // CORRECTION: targets the exact existing record; identity is never re-chosen, observed never touched.
    if (target.mode === 'correct' || target.mode === 'live' || form.mode === 'correct') {
      if (!target.record) return { ok: false, code: 'NO_ATTENDANCE' };
      const patch = {};
      if (declaredStartAt !== target.record.declaredStartAt) patch.declaredStartAt = declaredStartAt;
      if (declaredEndAt !== target.record.declaredEndAt) patch.declaredEndAt = declaredEndAt;
      if (declaredBreakMinutesTotal !== target.record.declaredBreakMinutesTotal) patch.declaredBreakMinutesTotal = declaredBreakMinutesTotal;
      const res = managerCorrection({
        actor: FOUR_SEASON_MANAGER_ACTOR, existing: target.record, patch,
        reasonCode: form.reasonCode, reasonNote: form.reasonNote, scope: manualScope(),
      }, now, POLICY);
      if (!res.ok) return { ok: false, code: res.code };
      attendanceStore.set(res.attendance.attendanceId, res.attendance);   // the ONE canonical store
      return { ok: true };
    }
    // ADD: M1 needs an unambiguous real shift; several candidates require an explicit choice.
    let shift = null;
    if (target.mode === 'choose') {
      if (!form.shiftId) return { ok: false, code: 'SHIFT_CHOICE_REQUIRED' };
      const pick = target.candidates.find((s) => s.shiftId === form.shiftId);
      if (!pick) return { ok: false, code: 'SHIFT_CHOICE_REQUIRED' };
      shift = Object.assign({ shiftId: pick.shiftId }, pick.projection);
    } else if (target.mode === 'm1') {
      shift = Object.assign({ shiftId: target.shift.shiftId }, target.shift.projection);
    }
    const res = managerManualEntry({
      actor: FOUR_SEASON_MANAGER_ACTOR, existing: null, shift,
      ansattId: form.ansattId, workDate: wd,
      declaredStartAt, declaredEndAt, declaredBreakMinutesTotal,
      employment, reasonCode: form.reasonCode, reasonNote: form.reasonNote, scope: manualScope(),
    }, now, POLICY);
    if (!res.ok) return { ok: false, code: res.code };
    attendanceStore.set(res.attendance.attendanceId, res.attendance);
    return { ok: true };
  }

  // ---- LØNNSGRUNNLAG (Increment 2): monthly payroll INPUT package ----------------------------
  // Reads ACTUAL attendance truth (layer B) out of the same in-memory attendanceStore the
  // employee surfaces write, plus canonical employee/terms and the planned schedule for the
  // comparison column only. Local/demo runtime: a hard reload resets package state.
  function goLonnsgrunnlag() {
    if (!canViewEmployees(FOUR_SEASON_MANAGER_ACTOR)) return goChooser();
    clear(root);
    managerChrome('Ledelse');
    const today = tenantWorkDate(Date.now(), TZ);
    renderPayrollView(root, {
      employeeStore: employeeStore(), scheduleStore: scheduleStore(), attendanceStore,
      payrollStore: payrollStore(),
      tenantId: FOUR_SEASON_TENANT.tenantId, actor: FOUR_SEASON_MANAGER_ACTOR,
      operatorName: operatorDisplayName(),          // claimed identity only — labelled unverified
      nowMs: Date.now(), timezone: TZ, todayWorkDate: today,
      initialPeriodId: today.slice(0, 7),
      onBack: goChooser,
      plannedShiftsFor: plannedShiftsForPayroll,
      planningFor: planningEconomyForPeriod,
    });
  }
  function goVaktplanViewAs(ansattId) {
    if (!canOpenVaktplan(FOUR_SEASON_MANAGER_ACTOR)) return goChooser();
    clear(root);
    const person = VAKTPLAN_PEOPLE.find((p) => p.ansattId === ansattId);
    managerChrome('Ledelse · ser som ' + (person ? person.name : ansattId));
    // Manager-shaped read of the target employee's shifts from the SAME store; the membership
    // object handed to the read-only schedule view is only the projection target descriptor.
    const shifts = shiftsForEmployee(scheduleStore(), FOUR_SEASON_TENANT.tenantId, ansattId, FOUR_SEASON_MANAGER_ACTOR);
    renderScheduleView(root, {
      membership: { tenantId: FOUR_SEASON_TENANT.tenantId, ansattId },
      tenantLabel: tenantLabel(FOUR_SEASON_TENANT.tenantId), shifts,
      nowMs: Date.now(), timezone: TZ, roleLabels: ROLE_LABELS,
      onBack: () => goVaktplan(),
    });
  }

  // ---- shared button builders ----
  function bigBtn(label, color, onClick) {
    const b = el('button', { text: label, style: 'display:block;width:100%;max-width:360px;padding:18px;margin:6px 0 14px;border:0;border-radius:14px;background:' + color + ';color:#fff;font-size:18px;font-weight:800;cursor:pointer' });
    b.addEventListener('click', onClick);
    return b;
  }
  function linkBtn(label, onClick) {
    const b = el('button', { text: label, style: 'display:block;width:100%;max-width:360px;text-align:left;padding:12px;margin-bottom:8px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;font-size:14px' });
    b.addEventListener('click', onClick);
    return b;
  }
  function backBtn(label, onClick) {
    const b = el('button', { text: label, style: 'margin-top:10px;padding:10px 14px;border:1px solid #999;border-radius:8px;background:#fff;cursor:pointer;font-size:13px' });
    b.addEventListener('click', onClick);
    return b;
  }

  route(DEFAULT_UID);   // land on the default review identity (Maria); "Bytt ansatt" opens the chooser
}
