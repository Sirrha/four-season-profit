// management-schedule-view.mjs
// MANAGEMENT VAKTPLAN — Uke (default) + full Måned over the ONE shared local planned-schedule
// store (§6 ONE STORE / TWO PROJECTIONS + second-increment design 2A-2G). Desktop Week: five+
// employees as rows x Mon-Sun; desktop Month: employee rows x EVERY calendar day with sticky
// name column and sticky date header. Narrow screens: one day at a time, all employees.
// ONE editor serves Week and Month cells (create assigned OR open "Manko", edit times, cancel).
// Every mutation flows through the SINGLE operation boundary in management-schedule-core.mjs.
// Hours/cost render from ONE planningSummaryFor result object (simple AND detailed views —
// no second calculation path); the compensation basis is DEMO planning input, labelled as such.
// PLANNED LAYER ONLY: no attendance/payable data, no publication wording or affordance.
// All data-derived text via textContent.

import { fmtTenantHM, tenantWorkDate } from './employee-shell-core.mjs';
import { isoWeekMonday, addDays, isOvernight } from './employee-schedule-week.mjs';
import {
  managerWeekFor, managerMonthFor, applyScheduleOperation, planningSummaryFor,
  scopeDaysOf, openShiftsOf, searchPeople, tenantShiftsOf,
} from './management-schedule-core.mjs';

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
function dayLabel(workDate) {
  const [y, m, d] = workDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('nb-NO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}
function capFirst(s) { return s.replace(/^./, (c) => c.toUpperCase()); }
function shortDate(workDate) { const [, m, d] = workDate.split('-').map(Number); return d + '.' + m + '.'; }
function weekdayIdx(workDate) { const [y, m, d] = workDate.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; }
const WD_SHORT = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
const WD_MIN = ['M', 'T', 'O', 'T', 'F', 'L', 'S'];
const MONTH_NAMES = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

export function renderManagementView(root, { store, tenantId, tenantLabel, people, roleLabels, actor, policy, deps, nowMs, timezone, onViewAs, initialQuery, initialOffset, onOffsetChange }) {
  if (!root) return;
  const todayWd = tenantWorkDate(nowMs, timezone);
  const baseMonday = isoWeekMonday(todayWd);
  const todayY = Number(todayWd.slice(0, 4)), todayM = Number(todayWd.slice(5, 7));
  // Separate cursors per view (2A): Week remembers its week, Month remembers its month; a fresh
  // entry into Vaktplan starts at now. The search query is a people selection shared by both.
  let mode = 'week';
  // Week offset is presentation state. It may be seeded by the Ledelse workspace frame and
  // reported back so switching tabs does not lose the week the manager was looking at.
  let offset = Number.isInteger(initialOffset) ? initialOffset : 0;
  const reportOffset = () => { if (typeof onOffsetChange === 'function') onOffsetChange(offset); };
  let mCursor = { year: todayY, month: todayM };
  let dayWd = todayWd;                 // narrow one-day cursor (navigates freely by date)
  let query = typeof initialQuery === 'string' ? initialQuery : '';   // e.g. opened from an Ansattkort

  let sel = null;                      // {mode:'create', ansattId|null, workDate, dateEditable?} | {mode:'edit', shiftId}
  let errMsg = '';
  let showDetails = false;

  const fmtHM = (t) => fmtTenantHM(t, timezone);
  const roleOf = (k) => (roleLabels && k && roleLabels[k] ? roleLabels[k] : null);
  const personOf = (id) => (people || []).find((p) => p.ansattId === id) || null;
  const chipText = (s) => fmtHM(s.projection.plannedStartAt) + '–' + fmtHM(s.projection.plannedEndAt) + (s.overnight ? ' +1d' : '');
  const validHM = (v) => /^\d{2}:\d{2}$/.test(v || '');
  const validWd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const fmtKr = (v) => 'kr ' + Math.round(v).toLocaleString('nb-NO');
  const fmtH = (h) => h.toLocaleString('nb-NO', { maximumFractionDigits: 2 }) + ' t';

  function currentScope() {
    return mode === 'week'
      ? { kind: 'week', anchorWorkDate: addDays(baseMonday, offset * 7) }
      : { kind: 'month', year: mCursor.year, month: mCursor.month };
  }
  function opError(code) {
    if (code === 'END_BEFORE_START') return 'Sluttid må være etter starttid.';
    if (code === 'PLANNED_START_NOT_ON_WORKDATE') return 'Starttiden må ligge på vaktens dato.';
    if (code === 'NO_CHANGE') return 'Ingen endring å lagre.';
    if (code === 'SHIFT_CANCELLED') return 'Vakten er avlyst og kan ikke endres.';
    if (code === 'SHIFT_TAKEN') return 'Vakten er allerede tatt.';
    if (code === 'ATTENDANCE_BLOCKS_CHANGE') return 'Vakten har registrert stempling og kan ikke endres her.';
    if (code === 'TIME_INVALID') return 'Oppgi gyldige klokkeslett (TT:MM).';
    return 'Kunne ikke lagre (' + code + ').';
  }
  function apply(op) {
    const res = applyScheduleOperation({ store, tenantId, actor, op, now: Date.now(), policy, deps });
    if (res.ok) { sel = null; errMsg = ''; } else { errMsg = opError(res.code); }
    draw();
  }

  function shiftChip(s, cls) {
    const cancelled = s.projection.status === 'cancelled';
    const openShift = s.projection.status === 'open';
    const b = el('button', {
      cls: cls + (cancelled ? ' cancel' : ''),
      text: chipText(s) + (openShift ? ' · Manko' : ''),
      attrs: { type: 'button', 'aria-label': (cancelled ? 'Avlyst vakt ' : openShift ? 'Manko-vakt ' : 'Vakt ') + chipText(s) },
    });
    b.addEventListener('click', () => { sel = { mode: 'edit', shiftId: s.shiftId }; errMsg = ''; draw(); });
    return b;
  }
  function markChip(s) {
    const cancelled = s.projection.status === 'cancelled';
    const hh = fmtHM(s.projection.plannedStartAt).slice(0, 2);
    const b = el('button', {
      cls: 'vpm-mk' + (cancelled ? ' cancel' : ''),
      text: hh + (s.overnight ? '+1' : ''),
      attrs: { type: 'button', 'aria-label': (cancelled ? 'Avlyst vakt ' : 'Vakt ') + chipText(s) + ' ' + dayLabel(s.projection.workDate) },
    });
    b.addEventListener('click', () => { sel = { mode: 'edit', shiftId: s.shiftId }; errMsg = ''; draw(); });
    return b;
  }
  function addBtn(person, workDate, cls, quietText) {
    const b = el('button', { cls, text: quietText != null ? quietText : '+', attrs: { type: 'button', 'aria-label': 'Legg til vakt for ' + person.name + ' ' + dayLabel(workDate) } });
    b.addEventListener('click', () => { sel = { mode: 'create', ansattId: person.ansattId, workDate }; errMsg = ''; draw(); });
    return b;
  }
  function actionBtn(label, cls, onClick) {
    const b = el('button', { cls, text: label, attrs: { type: 'button' } });
    b.addEventListener('click', onClick);
    return b;
  }
  function timeField(label, value) {
    const wrap = el('div');
    wrap.appendChild(el('label', { text: label }));
    const input = el('input', { attrs: { type: 'time', value } });
    wrap.appendChild(input);
    return { wrap, input };
  }
  function chipNav(label, go) {
    const back = el('span', { cls: 'cur', text: label, attrs: { role: 'button', tabindex: '0' } });
    back.addEventListener('click', go);
    back.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    return back;
  }

  // ---- segmented Uke | Måned (Week default) ----
  function segControl() {
    const s = el('div', { cls: 'seg', attrs: { role: 'tablist', 'aria-label': 'Visning' } });
    const mkTab = (key, label) => {
      const b = el('button', { text: label, cls: mode === key ? 'on' : '', attrs: { type: 'button', role: 'tab', 'aria-selected': mode === key ? 'true' : 'false' } });
      b.addEventListener('click', () => { if (mode !== key) { mode = key; sel = null; errMsg = ''; draw(); } });
      return b;
    };
    s.appendChild(mkTab('week', 'Uke'));
    s.appendChild(mkTab('month', 'Måned'));
    return s;
  }

  // ---- shared people search (clear/reset path included) ----
  function searchRow() {
    const row = el('div', { cls: 'vp-search' });
    const input = el('input', { attrs: { type: 'text', placeholder: 'Søk ansatt …', value: query, 'aria-label': 'Søk ansatt' } });
    input.addEventListener('input', () => { query = input.value; redrawKeepFocus(input); });
    row.appendChild(input);
    if (query.trim() !== '') {
      const clr = el('button', { cls: 'clr', text: 'Nullstill', attrs: { type: 'button' } });
      clr.addEventListener('click', () => { query = ''; draw(); });
      row.appendChild(clr);
    }
    return row;
  }
  function redrawKeepFocus() {
    draw();
    const fresh = root.querySelector('.vp-search input');
    if (fresh) { fresh.focus(); const v = fresh.value; fresh.setSelectionRange(v.length, v.length); }
  }

  function weekNav(week) {
    const nav = el('div', { cls: 'wknav' });
    const prev = el('button', { text: '‹ Forrige uke', attrs: { type: 'button', 'aria-label': 'Forrige uke' } });
    const next = el('button', { text: 'Neste uke ›', attrs: { type: 'button', 'aria-label': 'Neste uke' } });
    prev.addEventListener('click', () => { offset -= 1; sel = null; errMsg = ''; reportOffset(); draw(); });
    next.addEventListener('click', () => { offset += 1; sel = null; errMsg = ''; reportOffset(); draw(); });
    const mid = el('div', { cls: 'mid' });
    mid.appendChild(el('div', { cls: 'wk', text: 'Uke ' + week.weekNumber }));
    mid.appendChild(el('div', { cls: 'rng', text: shortDate(week.monday) + ' – ' + shortDate(week.sunday) }));
    if (offset !== 0) mid.appendChild(chipNav('Til denne uken', () => { offset = 0; sel = null; errMsg = ''; reportOffset(); draw(); }));
    nav.appendChild(prev); nav.appendChild(mid); nav.appendChild(next);
    return nav;
  }
  function monthNav() {
    const nav = el('div', { cls: 'wknav' });
    const prev = el('button', { text: '‹ Forrige måned', attrs: { type: 'button', 'aria-label': 'Forrige måned' } });
    const next = el('button', { text: 'Neste måned ›', attrs: { type: 'button', 'aria-label': 'Neste måned' } });
    prev.addEventListener('click', () => { mCursor = mCursor.month === 1 ? { year: mCursor.year - 1, month: 12 } : { year: mCursor.year, month: mCursor.month - 1 }; sel = null; errMsg = ''; draw(); });
    next.addEventListener('click', () => { mCursor = mCursor.month === 12 ? { year: mCursor.year + 1, month: 1 } : { year: mCursor.year, month: mCursor.month + 1 }; sel = null; errMsg = ''; draw(); });
    const mid = el('div', { cls: 'mid' });
    mid.appendChild(el('div', { cls: 'wk', text: capFirst(MONTH_NAMES[mCursor.month - 1]) + ' ' + mCursor.year }));
    if (!(mCursor.year === todayY && mCursor.month === todayM)) {
      mid.appendChild(chipNav('Til denne måneden', () => { mCursor = { year: todayY, month: todayM }; sel = null; errMsg = ''; draw(); }));
    }
    nav.appendChild(prev); nav.appendChild(mid); nav.appendChild(next);
    return nav;
  }

  function empCell(person) {
    const emp = el('div', { cls: 'vp-emp' });
    emp.appendChild(el('div', { cls: 'nm', text: person.name }));
    const rl = roleOf(person.roleKey);
    if (rl) emp.appendChild(el('div', { cls: 'rl', text: rl }));
    if (typeof onViewAs === 'function') {
      const as = el('button', { cls: 'as', text: 'Se som ansatt', attrs: { type: 'button', 'aria-label': 'Se som ' + person.name } });
      as.addEventListener('click', () => onViewAs(person.ansattId));
      emp.appendChild(as);
    }
    return emp;
  }

  // ---- desktop WEEK grid ----
  function weekBody(filtered) {
    const week = managerWeekFor({ anchorWorkDate: addDays(baseMonday, offset * 7), timezone, container: store, tenantId, people: filtered, todayWorkDate: todayWd });
    root.appendChild(weekNav(week));
    const desk = el('div', { cls: 'card vp-desk' });
    const grid = el('div', { cls: 'vp-grid' });
    grid.appendChild(el('div', { cls: 'vp-hd', text: '' }));
    week.days.forEach((wd, i) => {
      const h = el('div', { cls: 'vp-hd' + (wd === todayWd ? ' today' : ''), text: WD_SHORT[i] });
      h.appendChild(el('span', { cls: 'd', text: shortDate(wd) + (wd === todayWd ? ' · i dag' : '') }));
      grid.appendChild(h);
    });
    for (const row of week.rows) {
      const person = personOf(row.ansattId);
      if (!person) continue;
      grid.appendChild(empCell(person));
      for (const d of row.days) {
        const cell = el('div', { cls: 'vp-cell' + (d.workDate === todayWd ? ' today' : '') + (d.shifts.length ? ' has' : '') });
        for (const s of d.shifts) cell.appendChild(shiftChip(s, 'vp-chip'));
        if (d.shifts.length === 0) cell.appendChild(addBtn(person, d.workDate, 'vp-add'));
        grid.appendChild(cell);
      }
    }
    desk.appendChild(grid);
    root.appendChild(desk);
  }

  // ---- desktop full MONTH matrix (sticky name column + sticky date header) ----
  function monthBody(filtered) {
    root.appendChild(monthNav());
    const month = managerMonthFor({ year: mCursor.year, month: mCursor.month, timezone, container: store, tenantId, people: filtered, todayWorkDate: todayWd });
    const desk = el('div', { cls: 'vp-desk' });
    const wrap = el('div', { cls: 'vpm-wrap' });
    const grid = el('div', { cls: 'vpm-grid', style: 'grid-template-columns:130px repeat(' + month.days.length + ',minmax(27px,1fr));' });
    grid.appendChild(el('div', { cls: 'vpm-corner', text: 'Ansatt' }));
    for (const wd of month.days) {
      const h = el('div', { cls: 'vpm-hd' + (wd === todayWd ? ' today' : ''), text: WD_MIN[weekdayIdx(wd)] });
      h.appendChild(el('span', { cls: 'dn', text: String(Number(wd.slice(8))) }));
      grid.appendChild(h);
    }
    for (const row of month.rows) {
      const person = personOf(row.ansattId);
      if (!person) continue;
      const name = el('div', { cls: 'vpm-name' });
      name.appendChild(el('div', { cls: 'nm', text: person.name }));
      grid.appendChild(name);
      for (const c of row.cells) {
        const cell = el('div', { cls: 'vpm-cell' + (c.isToday ? ' today' : '') });
        for (const s of c.shifts) cell.appendChild(markChip(s));
        if (c.shifts.length === 0) cell.appendChild(addBtn(person, c.workDate, 'vpm-add', '+'));
        grid.appendChild(cell);
      }
    }
    wrap.appendChild(grid);
    desk.appendChild(wrap);
    root.appendChild(desk);
  }

  // ---- narrow: one day at a time, all (filtered) employees — Week AND Month coverage ----
  function rowsForDay(filtered, wd) {
    const all = tenantShiftsOf(store, tenantId);
    return filtered.map((person) => ({
      person,
      shifts: all.filter((s) => s.projection.ansattId === person.ansattId && s.projection.workDate === wd)
        .sort((a, b) => a.projection.plannedStartAt - b.projection.plannedStartAt)
        .map((s) => ({ shiftId: s.shiftId, projection: s.projection, overnight: isOvernight(s.projection, timezone) })),
    }));
  }
  function dayBody(filtered) {
    const dayCard = el('div', { cls: 'card vp-day' });
    const dn = el('div', { cls: 'wknav', style: 'box-shadow:none;margin-bottom:10px' });
    const dp = el('button', { text: '‹', attrs: { type: 'button', 'aria-label': 'Forrige dag' } });
    const dx = el('button', { text: '›', attrs: { type: 'button', 'aria-label': 'Neste dag' } });
    dp.addEventListener('click', () => { dayWd = addDays(dayWd, -1); sel = null; errMsg = ''; draw(); });
    dx.addEventListener('click', () => { dayWd = addDays(dayWd, 1); sel = null; errMsg = ''; draw(); });
    const dmid = el('div', { cls: 'mid' });
    dmid.appendChild(el('div', { cls: 'wk', text: capFirst(dayLabel(dayWd)) }));
    if (dayWd === todayWd) dmid.appendChild(el('div', { cls: 'rng', text: 'I dag' }));
    else dmid.appendChild(chipNav('Til i dag', () => { dayWd = todayWd; sel = null; errMsg = ''; draw(); }));
    dn.appendChild(dp); dn.appendChild(dmid); dn.appendChild(dx);
    dayCard.appendChild(dn);
    for (const r of rowsForDay(filtered, dayWd)) {
      const row = el('div', { cls: 'vp-drow' });
      const nm = el('div');
      nm.appendChild(el('div', { cls: 'nm', text: r.person.name }));
      const rl = roleOf(r.person.roleKey);
      if (rl) nm.appendChild(el('div', { cls: 'rl', text: rl }));
      row.appendChild(nm);
      const sh = el('div', { cls: 'shifts' });
      if (r.shifts.length === 0) {
        sh.appendChild(el('span', { cls: 'free', text: 'Fri' }));
        sh.appendChild(addBtn(r.person, dayWd, 'vp-add'));
      } else {
        for (const s of r.shifts) sh.appendChild(shiftChip(s, 'vp-chip'));
      }
      row.appendChild(sh);
      dayCard.appendChild(row);
    }
    root.appendChild(dayCard);
  }

  // ---- Manko-vakter (open shifts in the current scope) ----
  function mankoCard(scope) {
    const inScope = new Set(scopeDaysOf(scope));
    const open = openShiftsOf(store, tenantId).filter((s) => inScope.has(s.projection.workDate));
    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker' + (open.length ? ' amber' : ' neutral'), text: 'Manko-vakter (' + open.length + ')' }));
    if (!open.length) card.appendChild(el('div', { style: 'color:var(--faint);font-size:13px', text: 'Ingen ubemannede vakter i denne perioden.' }));
    for (const s of open) {
      const p = s.projection;
      const hours = (p.plannedEndAt - p.plannedStartAt) / 3600000;
      const row = el('div', { cls: 'shift', style: 'background:#fffaf0;border-color:var(--amber-line)' });
      const t = el('div', { cls: 't', text: capFirst(dayLabel(p.workDate)) + ' · ' + fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, timezone) ? ' (til neste dag)' : '') });
      row.appendChild(t);
      row.appendChild(el('div', { cls: 'm', text: fmtH(hours) + ' udekket · Kostnad: ukjent til vakten er tildelt' }));
      const edit = actionBtn('Åpne', 'btn tertiary', () => { sel = { mode: 'edit', shiftId: s.shiftId }; errMsg = ''; draw(); });
      edit.style.cssText = 'width:auto;padding:4px 0;min-height:0';
      row.appendChild(edit);
      card.appendChild(row);
    }
    const scopeDays = scopeDaysOf(scope);
    const defaultWd = inScope.has(todayWd) ? todayWd : scopeDays[0];
    const nyBtn = actionBtn('Ny Manko-vakt', 'btn secondary', () => { sel = { mode: 'create', ansattId: null, workDate: defaultWd, dateEditable: true }; errMsg = ''; draw(); });
    nyBtn.style.marginTop = '10px';
    card.appendChild(nyBtn);
    root.appendChild(card);
  }

  // ---- hours + planning-cost summary (simple AND detailed from the SAME derivation) ----
  function summaryCard(scope, filtered, week) {
    const summary = planningSummaryFor({ container: store, tenantId, people: filtered, scope });
    const card = el('div', { cls: 'card vp-sum' });
    const scopeLabel = scope.kind === 'week' ? 'uke ' + week.weekNumber : MONTH_NAMES[scope.month - 1] + ' ' + scope.year;
    card.appendChild(el('div', { cls: 'kicker', text: 'Timer og estimert kostnad · ' + scopeLabel }));
    card.appendChild(el('div', { cls: 'vp-note', text: 'Lønnsgrunnlaget er demo-/eksempeltall for planlegging – ikke lønnskjøring eller reelle lønnsdata.' }));
    for (const r of summary.rows) {
      const row = el('div', { cls: 'srow' });
      row.appendChild(el('div', { cls: 'nm', text: r.name }));
      row.appendChild(el('div', { cls: 'hrs', text: fmtH(r.grossHours) }));
      let costText;
      if (r.model === 'timelonn') costText = fmtKr(r.estimatedVariableCost);
      else if (r.model === 'fastlonn') costText = scope.kind === 'month' ? fmtKr(r.fixedMonthlySalaryForScope) + ' (fast månedslønn)' : 'Fastlønn – påvirkes ikke av vaktplanen';
      else costText = 'Lønnsgrunnlag mangler';
      row.appendChild(el('div', { text: costText, style: r.model === 'unknown' ? 'color:var(--amber);font-weight:600' : '' }));
      card.appendChild(row);
    }
    const t = summary.totals;
    const agg = el('div', { cls: 'agg' });
    if (scope.kind === 'week') {
      agg.textContent = 'Est. planpåvirket (variabel) kostnad denne uken: ' + fmtKr(t.variableCostKnown);
    } else {
      agg.textContent = 'Kjent planlagt kostnad denne måneden: ' + fmtKr(t.combinedKnownCost)
        + ' (variabel ' + fmtKr(t.variableCostKnown) + ' + fastlønn ' + fmtKr(t.fixedMonthlySalaryKnown) + ')';
    }
    card.appendChild(agg);
    card.appendChild(el('div', { cls: 'vp-oms', text: 'Ikke inkludert: ' + summary.omissions.join(' · ') }));
    const tog = actionBtn(showDetails ? 'Skjul detaljer' : 'Vis detaljer', 'btn tertiary', () => { showDetails = !showDetails; draw(); });
    tog.style.cssText = 'width:auto;padding:6px 0;min-height:0';
    card.appendChild(tog);
    if (showDetails) {
      // DETAILED view renders from the SAME summary object rows — component for component.
      const det = el('div', { cls: 'vp-det' });
      det.appendChild(el('div', { cls: 'vp-note', text: 'Samme beregningsgrunnlag som oversikten over – ingen egen beregning.' }));
      for (const r of summary.rows) {
        const b = el('div', { cls: 'db' });
        b.appendChild(el('div', { cls: 'nm', text: r.name + ' · ' + (r.model === 'timelonn' ? 'Timelønn' : r.model === 'fastlonn' ? 'Fastlønn' : 'Lønnsgrunnlag mangler') }));
        b.appendChild(el('div', { text: 'Planlagte timer (brutto): ' + fmtH(r.grossHours) + ' (' + r.shiftCount + ' vakter, pauser ikke trukket fra)' }));
        if (r.plannedHourlyRate != null) b.appendChild(el('div', { text: 'Planlagt timesats (demo): ' + fmtKr(r.plannedHourlyRate) + ' per time' }));
        if (r.plannedMonthlySalary != null) b.appendChild(el('div', { text: 'Planlagt månedslønn (demo): ' + fmtKr(r.plannedMonthlySalary) }));
        if (r.estimatedVariableCost != null) b.appendChild(el('div', { text: 'Estimert planpåvirket kostnad: ' + fmtKr(r.estimatedVariableCost) }));
        for (const n of r.notes) b.appendChild(el('div', { text: '– ' + n, style: 'color:var(--muted)' }));
        det.appendChild(b);
      }
      det.appendChild(el('div', { text: 'Åpne vakter i perioden: ' + t.openShiftCount + ' (' + fmtH(t.openGapHours) + ' udekket) – kostnad ukjent til de er tildelt.', style: 'font-weight:600' }));
      card.appendChild(det);
    }
    root.appendChild(card);
  }

  // ---- ONE editor for Week and Month (create assigned / create Manko / edit / cancel) ----
  function editor() {
    const card = el('div', { cls: 'card vp-edit' });
    if (sel.mode === 'create') {
      const person = sel.ansattId ? personOf(sel.ansattId) : null;
      card.appendChild(el('div', { cls: 'kicker', text: person ? 'Ny vakt' : 'Ny Manko-vakt' }));
      card.appendChild(el('div', { style: 'font-weight:800;font-size:16px', text: person ? person.name : 'Ubemannet (Manko)' }));
      let dateInput = null;
      if (sel.dateEditable) {
        card.appendChild(el('label', { text: 'Dato' }));
        dateInput = el('input', { attrs: { type: 'date', value: sel.workDate } });
        card.appendChild(dateInput);
      } else {
        card.appendChild(el('div', { style: 'color:var(--muted);font-size:13px;margin:2px 0 10px', text: capFirst(dayLabel(sel.workDate)) }));
      }
      let mankoChk = null;
      if (person) {
        const lab = el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px;margin:2px 0 8px' });
        mankoChk = el('input', { attrs: { type: 'checkbox' }, style: 'width:auto;margin:0' });
        lab.appendChild(mankoChk);
        lab.appendChild(document.createTextNode('Opprett som Manko-vakt (ubemannet)'));
        card.appendChild(lab);
      } else {
        card.appendChild(el('div', { cls: 'cue-line', text: 'Vises i Manko-vakter og i Ledige vakter hos de ansatte til den er tatt.' }));
      }
      const row = el('div', { cls: 'row2' });
      const from = timeField('Start', '09:00'); const to = timeField('Slutt', '17:00');
      row.appendChild(from.wrap); row.appendChild(to.wrap); card.appendChild(row);
      card.appendChild(el('div', { cls: 'cue-line', text: 'Sluttid før starttid betyr at vakten slutter neste dag.' }));
      card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      const acts = el('div', { cls: 'vp-actions' });
      acts.appendChild(actionBtn('Legg til vakt', 'btn primary', () => {
        const wd = dateInput ? dateInput.value : sel.workDate;
        if (!validWd(wd)) { errMsg = 'Oppgi en gyldig dato.'; draw(); return; }
        if (!validHM(from.input.value) || !validHM(to.input.value)) { errMsg = 'Oppgi både start og slutt (TT:MM).'; draw(); return; }
        const asManko = !person || (mankoChk && mankoChk.checked);
        apply({ kind: 'create', workDate: wd, ansattId: asManko ? null : sel.ansattId, fromHM: from.input.value, toHM: to.input.value, roleKey: !asManko && person ? person.roleKey : null });
      }));
      acts.appendChild(actionBtn('Avbryt', 'btn tertiary', () => { sel = null; errMsg = ''; draw(); }));
      card.appendChild(acts);
      return card;
    }
    const tenant = store[tenantId] || {};
    const p = Object.prototype.hasOwnProperty.call(tenant, sel.shiftId) ? tenant[sel.shiftId] : null;
    if (!p) { sel = null; return el('div'); }
    const person = p.ansattId ? personOf(p.ansattId) : null;
    const cancelled = p.status === 'cancelled';
    const openShift = p.status === 'open';
    card.appendChild(el('div', { cls: 'kicker' + (cancelled ? ' neutral' : openShift ? ' amber' : ''), text: cancelled ? 'Avlyst vakt' : openShift ? 'Manko-vakt' : 'Endre vakt' }));
    const tt = el('div', { style: 'font-weight:800;font-size:16px', text: fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, timezone) ? ' (til neste dag)' : '') });
    if (cancelled) tt.appendChild(el('span', { cls: 'avl', text: 'Avlyst' }));
    card.appendChild(tt);
    card.appendChild(el('div', { style: 'color:var(--muted);font-size:13px;margin:2px 0 10px', text: (person ? person.name : openShift ? 'Ubemannet' : p.ansattId || '') + ' · ' + capFirst(dayLabel(p.workDate)) }));
    if (openShift) card.appendChild(el('div', { cls: 'cue-line', text: 'Kostnad: ukjent til vakten er tildelt.' }));
    if (cancelled) {
      card.appendChild(el('div', { cls: 'cue-line', text: 'Avlyst vakt – kan ikke endres.' }));
      const acts = el('div', { cls: 'vp-actions' });
      acts.appendChild(actionBtn('Lukk', 'btn tertiary', () => { sel = null; errMsg = ''; draw(); }));
      card.appendChild(acts);
      return card;
    }
    const row = el('div', { cls: 'row2' });
    const from = timeField('Start', fmtHM(p.plannedStartAt)); const to = timeField('Slutt', fmtHM(p.plannedEndAt));
    row.appendChild(from.wrap); row.appendChild(to.wrap); card.appendChild(row);
    card.appendChild(el('div', { cls: 'cue-line', text: 'Sluttid før starttid betyr at vakten slutter neste dag.' }));
    card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
    const acts = el('div', { cls: 'vp-actions' });
    acts.appendChild(actionBtn('Lagre endring', 'btn primary', () => {
      if (!validHM(from.input.value) || !validHM(to.input.value)) { errMsg = 'Oppgi både start og slutt (TT:MM).'; draw(); return; }
      apply({ kind: 'revise', shiftId: sel.shiftId, fromHM: from.input.value, toHM: to.input.value });
    }));
    acts.appendChild(actionBtn('Avlys vakt', 'btn secondary danger', () => apply({ kind: 'cancel', shiftId: sel.shiftId })));
    acts.appendChild(actionBtn('Lukk', 'btn tertiary', () => { sel = null; errMsg = ''; draw(); }));
    card.appendChild(acts);
    return card;
  }

  function draw() {
    clear(root);
    const filtered = searchPeople(people, query);
    const scope = currentScope();

    const head = el('div', { cls: 'plan-head' });
    const ht = el('div');
    ht.appendChild(el('h1', { text: 'Vaktplan' }));
    ht.appendChild(el('div', { cls: 'sub', text: tenantLabel + ' · planlagt bemanning' }));
    head.appendChild(ht);
    root.appendChild(head);
    root.appendChild(segControl());
    root.appendChild(searchRow());

    let week = null;
    if (mode === 'week') { week = managerWeekFor({ anchorWorkDate: scope.anchorWorkDate, timezone, container: store, tenantId, people: filtered, todayWorkDate: todayWd }); }
    if (mode === 'week') weekBody(filtered); else monthBody(filtered);
    dayBody(filtered);
    if (sel) root.appendChild(editor());
    mankoCard(scope);
    summaryCard(scope, filtered, week || { weekNumber: '' });
  }

  draw();
}
