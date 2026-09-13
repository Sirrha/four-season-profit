// management-oversikt.mjs
// OVERSIKT V1 — owner-cockpit COMPOSITION (Sirrha OVERSIKT-V1-OWNER-COCKPIT-BUILD-RELEASE-001).
// PURE and import-free. Every function takes projections the Ledelse shell ALREADY reads for its
// tabs (the Vaktplan week, open shifts, the attendance lookup, employees with their existing
// missing-info lists, the shared month facts) and turns them into display rows. Nothing here
// derives truth, sums hours or kroner, stores anything, or infers lateness / absence / payable
// time: an attendance state is only ever the state the record itself carries.

export const EMPTY_ATTENTION = 'Ingenting krever oppmerksomhet akkurat nå.';

// Attendance wording — only states the existing attendance record carries (employee-shell-core
// statuses clocked_in / clocked_out / attested / approved, plus the record's own breakState).
export function vaktStatusOf(att, fmtHM) {
  const hm = (t) => (typeof fmtHM === 'function' && t != null ? fmtHM(t) : null);
  if (!att) return { key: 'none', text: 'Ikke stemplet inn' };
  if (att.status === 'clocked_in' && att.breakState === 'on_break') { const t = hm(att.openBreakStartedAt); return { key: 'pause', text: 'På pause' + (t ? ' siden kl. ' + t : '') }; }
  if (att.status === 'clocked_in') { const t = hm(att.observedClockInAt); return { key: 'on', text: 'Stemplet inn' + (t ? ' kl. ' + t : '') }; }
  if (att.status === 'clocked_out') return { key: 'done', text: 'Stemplet ut' };
  if (att.status === 'attested') return { key: 'done', text: 'Arbeidstid ført' };
  if (att.status === 'approved') return { key: 'done', text: 'Arbeidstid godkjent' };
  return { key: 'none', text: 'Ikke stemplet inn' };
}

// I DAG: one line per ASSIGNED shift in today's cell of the SAME managerWeekFor rows the Vaktplan
// tab draws, plus today's open shifts from the SAME openShiftsOf projection. `lookup(shiftId,
// ansattId)` is the existing attendance read (attendanceStore.get(attendanceIdFor(...))); nothing
// is written to either store.
export function dagensBildeFra({ week, openShifts, today, people, lookup, fmtHM, roleLabels }) {
  const names = new Map((Array.isArray(people) ? people : []).map((p) => [p.ansattId, p.name]));
  const read = typeof lookup === 'function' ? lookup : () => null;
  const hm = (t) => (typeof fmtHM === 'function' ? fmtHM(t) : String(t));
  const assigned = [];
  for (const r of (week && Array.isArray(week.rows) ? week.rows : [])) {
    const cell = (r.days || []).find((d) => d.workDate === today);
    for (const s of (cell && Array.isArray(cell.shifts) ? cell.shifts : [])) {
      const p = s.projection;
      if (!p || p.status !== 'assigned') continue;
      assigned.push({
        kind: 'assigned', shiftId: s.shiftId, ansattId: r.ansattId, name: names.get(r.ansattId) || r.ansattId,
        startAt: p.plannedStartAt, endAt: p.plannedEndAt, time: hm(p.plannedStartAt) + '–' + hm(p.plannedEndAt),
        state: vaktStatusOf(read(s.shiftId, r.ansattId), fmtHM),
      });
    }
  }
  assigned.sort((a, b) => (a.startAt - b.startAt) || a.name.localeCompare(b.name, 'nb'));
  const open = [];
  for (const s of (Array.isArray(openShifts) ? openShifts : [])) {
    const p = s && s.projection;
    if (!p || p.workDate !== today) continue;
    const role = roleLabels && p.roleKey && roleLabels[p.roleKey] ? roleLabels[p.roleKey] : null;
    open.push({ kind: 'open', shiftId: s.shiftId, startAt: p.plannedStartAt, endAt: p.plannedEndAt, time: hm(p.plannedStartAt) + '–' + hm(p.plannedEndAt), role });
  }
  open.sort((a, b) => a.startAt - b.startAt);
  return { today, assigned, open, assignedCount: assigned.length, openCount: open.length };
}

// ANSATTE: counts over the EXISTING missing-info classification. `employees` are the shell's
// employeesOf rows reduced to { ansattId, name, status, missing: missingInfoOf(e, today) }.
// "Complete" is simply "missing is empty" — no second completeness model.
export function ansattFaktaFra(employees) {
  const list = Array.isArray(employees) ? employees : [];
  const active = list.filter((e) => e && e.status === 'active').length;
  const incomplete = list.filter((e) => e && Array.isArray(e.missing) && e.missing.length > 0);
  const tally = new Map();
  for (const e of incomplete) for (const m of e.missing) tally.set(m, (tally.get(m) || 0) + 1);
  const categories = Array.from(tally, ([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label, 'nb'));
  return { total: list.length, active, complete: list.length - incomplete.length, incomplete: incomplete.length, categories };
}

// KREVER DIN OPPMERKSOMHET: compact action rows. Each row names a category the owner can act on,
// its count and the Ledelse tab it opens. Payroll rows come from the shared month facts (the P2
// rollup + the owner-corrected past-only rule); employee rows from the missing-info categories;
// the Vaktplan row from today's open shifts only (future shifts are never attention here).
// `openEmployee` is set only when exactly one employee is implicated in the payroll facts, so the
// existing one-row open seam of Lønn & økonomi can be used; otherwise the period opens as a whole.
export function oppmerksomhetFra({ monthFacts, periodLabel, ansatte, openTodayCount }) {
  const items = [];
  const f = monthFacts || null;
  if (f) {
    const one = Array.isArray(f.employeesNeedingAction) && f.employeesNeedingAction.length === 1 ? f.employeesNeedingAction[0] : null;
    const where = periodLabel ? ' i lønnsgrunnlaget for ' + periodLabel : ' i lønnsgrunnlaget';
    if (f.hardCount) items.push({ key: 'lonn_hard', target: 'lonn', tone: 'hard', count: f.hardCount, openEmployee: one, text: f.hardCount + (f.hardCount === 1 ? ' ansatt må rettes' : ' ansatte må rettes') + where });
    if (f.warnCount) items.push({ key: 'lonn_warn', target: 'lonn', tone: 'warn', count: f.warnCount, openEmployee: one, text: f.warnCount + (f.warnCount === 1 ? ' ansatt å se over' : ' ansatte å se over') + where });
    const d = f.pastPlannedDaysWithoutRegistration || 0;
    if (d) items.push({ key: 'lonn_planned', target: 'lonn', tone: 'warn', count: d, openEmployee: one, text: d + (d === 1 ? ' tidligere planlagt dag uten registrering' : ' tidligere planlagte dager uten registrering') + where });
  }
  for (const c of (ansatte && Array.isArray(ansatte.categories) ? ansatte.categories : [])) {
    items.push({ key: 'ansatte:' + c.label, target: 'ansatte', tone: 'warn', count: c.count, text: c.count + (c.count === 1 ? ' ansatt ' : ' ansatte ') + c.label });
  }
  const o = Number(openTodayCount) || 0;
  if (o) items.push({ key: 'vaktplan_open', target: 'vaktplan', tone: 'warn', count: o, text: o + (o === 1 ? ' åpen vakt i dag' : ' åpne vakter i dag') });
  return items;
}
