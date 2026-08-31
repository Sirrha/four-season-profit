// employee-schedule-view.mjs
// EMPLOYEE SCHEDULE ("Plan") — read-only rendering inside the employee shell: Uke (default) and
// Måned behind one segmented control. Owns ONLY view-local cursors (week offset, month cursor,
// selected day). Receives the already-resolved membership and the employee's own shifts; never
// resolves identity, never touches attendance state, never reaches any mutation path.
// All text is rendered via textContent (never innerHTML). Product strings live here, not in core.
// Presentation uses the shared Sormena classes defined in employee-shell.html; semantics unchanged.
// Month behavior per SOREN-SIRRHA-EMPLOYEE-MONTH-VIEW-DESIGN-RECOMMENDATION-001: same 7-column
// Monday→Sunday grid at both densities, always 6 rows, chips on desktop, markers on mobile, one
// inline selected-day detail region below the grid; entering Plan resets both cursors to now;
// switching Uke ↔ Måned preserves each view's own cursor within the Plan session.

import { fmtTenantHM, tenantWorkDate } from './employee-shell-core.mjs';
import { weekFor, isoWeekMonday, addDays } from './employee-schedule-week.mjs';
import { monthGridFor, monthOfWorkDate, prevMonth, nextMonth } from './employee-schedule-month.mjs';

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
  // Noon UTC of the calendar day keeps the weekday stable in any tenant zone.
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('nb-NO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}
function shortDate(workDate) { const [, m, d] = workDate.split('-').map(Number); return d + '.' + m + '.'; }
const MONTH_NAMES = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
const WD_SHORT = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];

export function renderScheduleView(root, { membership, tenantLabel, shifts, nowMs, timezone, roleLabels, onBack }) {
  if (!root) return;
  const todayWd = tenantWorkDate(nowMs, timezone);
  const baseMonday = isoWeekMonday(todayWd);
  const todayMonth = monthOfWorkDate(todayWd);
  // Entering Plan (this function runs fresh from I dag) resets BOTH cursors to now.
  let mode = 'week';                                     // 'week' (default) | 'month'
  let offset = 0;                                        // week cursor: -1 previous, 0 current, +1 next
  let mCursor = { year: todayMonth.year, month: todayMonth.month };  // month cursor (view-local)
  let selectedWd = todayWd;                              // month detail selection

  const fmtHM = (t) => fmtTenantHM(t, timezone);
  const chipTime = (p) => (fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt)).replace(/:00/g, '');
  const roleOf = (p) => (roleLabels && p.roleKey && roleLabels[p.roleKey] ? roleLabels[p.roleKey] : null);

  function header() {
    const head = el('div', { cls: 'plan-head' });
    const ht = el('div');
    ht.appendChild(el('h1', { text: 'Min plan' }));
    ht.appendChild(el('div', { cls: 'sub', text: tenantLabel }));
    head.appendChild(ht);
    return head;
  }
  function segControl() {
    const s = el('div', { cls: 'seg', attrs: { role: 'tablist', 'aria-label': 'Visning' } });
    const mkTab = (key, label) => {
      const b = el('button', { text: label, cls: mode === key ? 'on' : '', attrs: { type: 'button', role: 'tab', 'aria-selected': mode === key ? 'true' : 'false' } });
      b.addEventListener('click', () => { if (mode !== key) { mode = key; draw(); } });
      return b;
    };
    s.appendChild(mkTab('week', 'Uke'));
    s.appendChild(mkTab('month', 'Måned'));
    return s;
  }

  // ---- Uke (unchanged behavior; own cursor `offset`) ----------------------------------------
  function drawWeek() {
    const week = weekFor(addDays(baseMonday, offset * 7), timezone, shifts, todayWd);

    const nav = el('div', { cls: 'wknav' });
    const prev = el('button', { text: '‹ Forrige uke', attrs: { type: 'button', 'aria-label': 'Forrige uke' } });
    const next = el('button', { text: 'Neste uke ›', attrs: { type: 'button', 'aria-label': 'Neste uke' } });
    prev.addEventListener('click', () => { offset -= 1; draw(); });
    next.addEventListener('click', () => { offset += 1; draw(); });
    const mid = el('div', { cls: 'mid' });
    mid.appendChild(el('div', { cls: 'wk', text: 'Uke ' + week.weekNumber }));
    mid.appendChild(el('div', { cls: 'rng', text: shortDate(week.monday) + ' – ' + shortDate(week.sunday) }));
    if (offset !== 0) {
      const back = el('span', { cls: 'cur', text: 'Til denne uken', attrs: { role: 'button', tabindex: '0' } });
      back.addEventListener('click', () => { offset = 0; draw(); });
      back.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); offset = 0; draw(); } });
      mid.appendChild(back);
    }
    nav.appendChild(prev); nav.appendChild(mid); nav.appendChild(next);
    root.appendChild(nav);

    // seven days, always
    const grid = el('div', { cls: 'plan-grid' });
    for (const day of week.days) {
      const isToday = day.isToday;
      const card = el('div', { cls: 'pday' + (isToday ? ' today' : '') });
      const ph = el('div', { cls: 'ph' });
      ph.appendChild(el('div', { cls: 'dl', text: dayLabel(day.workDate) }));
      if (isToday) ph.appendChild(el('span', { cls: 'badge', text: 'I dag' }));
      card.appendChild(ph);
      if (day.shifts.length === 0) {
        card.appendChild(el('div', { cls: 'free', text: 'Fri' }));
      }
      for (const s of day.shifts) {
        const p = s.projection;
        const cancelled = p.status === 'cancelled';
        const row = el('div', { cls: 'shift' + (cancelled ? ' cancel' : '') });
        const times = fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (s.overnight ? ' (til neste dag)' : '');
        const t = el('div', { cls: 't', text: times });
        if (cancelled) t.appendChild(el('span', { cls: 'avl', text: 'Avlyst' }));
        row.appendChild(t);
        const role = roleOf(p);
        row.appendChild(el('div', { cls: 'm', text: tenantLabel + (role ? ' · ' + role : '') }));
        card.appendChild(row);
      }
      grid.appendChild(card);
    }
    root.appendChild(grid);
  }

  // ---- Måned (own cursor `mCursor`; inline detail region below the grid) --------------------
  function drawMonth() {
    const grid = monthGridFor({ year: mCursor.year, month: mCursor.month, shifts, now: nowMs, timezone });
    const firstInMonth = grid.cells.find((c) => c.inMonth).workDate;
    // Keep the selection inside the displayed month (today when visible, else the 1st).
    if (selectedWd.slice(0, 7) !== firstInMonth.slice(0, 7)) {
      selectedWd = (todayWd.slice(0, 7) === firstInMonth.slice(0, 7)) ? todayWd : firstInMonth;
    }
    const isCurrentMonth = mCursor.year === todayMonth.year && mCursor.month === todayMonth.month;

    const nav = el('div', { cls: 'wknav' });
    const prev = el('button', { text: '‹ Forrige måned', attrs: { type: 'button', 'aria-label': 'Forrige måned' } });
    const next = el('button', { text: 'Neste måned ›', attrs: { type: 'button', 'aria-label': 'Neste måned' } });
    prev.addEventListener('click', () => { mCursor = prevMonth(mCursor.year, mCursor.month); draw(); });
    next.addEventListener('click', () => { mCursor = nextMonth(mCursor.year, mCursor.month); draw(); });
    const mid = el('div', { cls: 'mid' });
    mid.appendChild(el('div', { cls: 'wk', text: MONTH_NAMES[mCursor.month - 1].replace(/^./, (c) => c.toUpperCase()) + ' ' + mCursor.year }));
    if (!isCurrentMonth) {
      const back = el('span', { cls: 'cur', text: 'Til denne måneden', attrs: { role: 'button', tabindex: '0' } });
      const goNow = () => { mCursor = { year: todayMonth.year, month: todayMonth.month }; selectedWd = todayWd; draw(); };
      back.addEventListener('click', goNow);
      back.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goNow(); } });
      mid.appendChild(back);
    }
    nav.appendChild(prev); nav.appendChild(mid); nav.appendChild(next);
    root.appendChild(nav);

    const card = el('div', { cls: 'card' });
    const wd = el('div', { cls: 'mo-wd', attrs: { 'aria-hidden': 'true' } });
    for (const w of WD_SHORT) wd.appendChild(el('div', { text: w }));
    card.appendChild(wd);

    const g = el('div', { cls: 'mo-grid' });
    for (const cell of grid.cells) {
      const assigned = cell.shifts.filter((s) => s.projection.status === 'assigned');
      const cancelledOnly = cell.shifts.length > 0 && assigned.length === 0;
      let cls = 'mo-cell';
      if (!cell.inMonth) cls += ' out';
      if (cell.isToday) cls += ' today';
      if (cell.inMonth && assigned.length) cls += ' work';
      if (cell.inMonth && cancelledOnly) cls += ' cancel';
      if (cell.inMonth && cell.workDate === selectedWd) cls += ' sel';
      const dayNo = String(parseInt(cell.workDate.slice(8), 10));
      const b = el('button', { cls, attrs: { type: 'button' } });
      if (cell.inMonth) {
        const state = assigned.length ? (assigned.length > 1 ? assigned.length + ' vakter' : 'vakt') : cancelledOnly ? 'avlyst' : 'fri';
        b.setAttribute('aria-label', dayLabel(cell.workDate) + (cell.isToday ? ', i dag' : '') + ': ' + state);
        b.addEventListener('click', () => { selectedWd = cell.workDate; draw(); });
      } else {
        b.disabled = true;                       // outside-month: visible, muted, non-interactive
        b.setAttribute('aria-hidden', 'true');
        b.setAttribute('tabindex', '-1');
      }
      const numWrap = el('div', { cls: 'numw' });
      numWrap.appendChild(el('span', { cls: 'num', text: dayNo }));
      b.appendChild(numWrap);
      if (cell.inMonth && cell.shifts.length) {
        // desktop: up to two compact time chips (+N when more)
        const chips = el('div', { cls: 'chips' });
        const shown = cell.shifts.slice(0, 2);
        for (const s of shown) {
          const cancelled = s.projection.status === 'cancelled';
          chips.appendChild(el('span', { cls: 'mchip' + (cancelled ? ' cancel' : ''), text: chipTime(s.projection) + (s.overnight ? ' +1d' : '') }));
        }
        if (cell.shifts.length > 2) chips.appendChild(el('span', { cls: 'mchip more', text: '+' + (cell.shifts.length - 2) }));
        b.appendChild(chips);
        // mobile: compact state markers only (filled = assigned, hollow = cancelled-only)
        const marks = el('div', { cls: 'marks', attrs: { 'aria-hidden': 'true' } });
        if (assigned.length) { marks.appendChild(el('span', { cls: 'mk' })); if (assigned.length > 1) marks.appendChild(el('span', { cls: 'mk' })); }
        else if (cancelledOnly) marks.appendChild(el('span', { cls: 'mk cancel' }));
        b.appendChild(marks);
      }
      g.appendChild(b);
    }
    card.appendChild(g);

    // ---- inline selected-day detail (always present; no modal, no drawer) ----
    const sel = grid.cells.find((c) => c.inMonth && c.workDate === selectedWd) || grid.cells.find((c) => c.inMonth);
    const detail = el('div', { cls: 'mo-detail' });
    const dh = el('div', { cls: 'dh' });
    dh.appendChild(el('div', { cls: 'dl', text: dayLabel(sel.workDate) }));
    if (sel.isToday) dh.appendChild(el('span', { cls: 'badge', text: 'I dag' }));
    detail.appendChild(dh);
    if (sel.shifts.length === 0) {
      detail.appendChild(el('div', { cls: 'free', text: 'Fri' }));
    }
    for (const s of sel.shifts) {
      const p = s.projection;
      const cancelled = p.status === 'cancelled';
      const row = el('div', { cls: 'shift' + (cancelled ? ' cancel' : '') });
      const t = el('div', { cls: 't', text: fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (s.overnight ? ' (til neste dag)' : '') });
      if (cancelled) t.appendChild(el('span', { cls: 'avl', text: 'Avlyst' }));
      row.appendChild(t);
      const role = roleOf(p);
      const meta = [tenantLabel, role].filter(Boolean).join(' · ')
        + (cancelled ? ' · Avlyst vakt – du skal ikke jobbe denne.' : '')
        + (s.overnight && !cancelled ? ' · Nattvakt: slutter neste dag.' : '');
      row.appendChild(el('div', { cls: 'm', text: meta }));
      detail.appendChild(row);
    }
    card.appendChild(detail);
    root.appendChild(card);
  }

  function draw() {
    clear(root);
    root.appendChild(header());
    root.appendChild(segControl());
    if (mode === 'week') drawWeek(); else drawMonth();
    const backBtn = el('button', { cls: 'btn tertiary', text: '← Tilbake til i dag', attrs: { type: 'button' }, style: 'margin-top:12px' });
    backBtn.addEventListener('click', () => onBack());
    root.appendChild(backBtn);
  }
  draw();
}
