// employee-schedule-view.mjs
// EMPLOYEE WEEK SCHEDULE ("Plan") — read-only rendering inside the employee shell. Owns ONLY a
// view-local week offset. Receives the already-resolved membership and the employee's own shifts;
// never resolves identity, never touches attendance state, never reaches any mutation path.
// All text is rendered via textContent (never innerHTML). Product strings live here, not in core.
// Presentation uses the shared Sormena classes defined in employee-shell.html; semantics unchanged.

import { fmtTenantHM, tenantWorkDate } from './employee-shell-core.mjs';
import { weekFor, isoWeekMonday, addDays } from './employee-schedule-week.mjs';

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

export function renderScheduleView(root, { membership, tenantLabel, shifts, nowMs, timezone, roleLabels, onBack }) {
  if (!root) return;
  const todayWd = tenantWorkDate(nowMs, timezone);
  const baseMonday = isoWeekMonday(todayWd);
  let offset = 0;                                        // -1 previous, 0 current, +1 next (view-local only)

  function draw() {
    clear(root);
    const week = weekFor(addDays(baseMonday, offset * 7), timezone, shifts, todayWd);

    const head = el('div', { cls: 'plan-head' });
    const ht = el('div');
    ht.appendChild(el('h1', { text: 'Min plan' }));
    ht.appendChild(el('div', { cls: 'sub', text: tenantLabel }));
    head.appendChild(ht);
    root.appendChild(head);

    // week navigation
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
        const times = fmtTenantHM(p.plannedStartAt, timezone) + '–' + fmtTenantHM(p.plannedEndAt, timezone) + (s.overnight ? ' (til neste dag)' : '');
        const t = el('div', { cls: 't', text: times });
        if (cancelled) t.appendChild(el('span', { cls: 'avl', text: 'Avlyst' }));
        row.appendChild(t);
        const role = roleLabels && p.roleKey && roleLabels[p.roleKey] ? roleLabels[p.roleKey] : null;
        row.appendChild(el('div', { cls: 'm', text: tenantLabel + (role ? ' · ' + role : '') }));
        card.appendChild(row);
      }
      grid.appendChild(card);
    }
    root.appendChild(grid);

    const backBtn = el('button', { cls: 'btn tertiary', text: '← Tilbake til i dag', attrs: { type: 'button' }, style: 'margin-top:12px' });
    backBtn.addEventListener('click', () => onBack());
    root.appendChild(backBtn);
  }
  draw();
}
