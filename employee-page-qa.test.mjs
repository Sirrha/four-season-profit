// employee-page-qa.test.mjs
// EMPLOYEE PAGE V1 — final owner-QA correction proofs QA-A..QA-E. Node built-ins only.
// Run: node employee-page-qa.test.mjs   (exit 0 = all pass)
//
// SCOPE: the four presentation corrections from the owner walkthrough (time-action dialogs,
// month trailing dead week, Plan back-link position, Min ansettelse hover) plus preservation
// guards. Truth stays proven by the core/schedule suites, re-run unchanged.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { visibleMonthCells } from './employee-schedule-view.mjs';
import { monthGridFor } from './employee-schedule-month.mjs';
import { ETR2A_POLICY, clockIn, clockOut, tenantLocalHMToUtcMs } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const TZ = ETR2A_POLICY.timezone;
const shellSrc = fs.readFileSync(new URL('./employee-shell-ui.mjs', import.meta.url), 'utf8');
const viewSrc = fs.readFileSync(new URL('./employee-schedule-view.mjs', import.meta.url), 'utf8');
const htmlSrc = ['./employee-shell.html', './employee-shell.css'].map((p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n')   /* S4 host: the preview stylesheet was extracted to employee-shell.css; guards read both */;
const mgmtViewSrc = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\/.*$/gm, '');
const dialogs = shellSrc.slice(shellSrc.indexOf('function dialogFrame('), shellSrc.indexOf('function goMyWork('));
const plan = shellSrc.slice(shellSrc.indexOf('function goSchedule('), shellSrc.indexOf('// ---- VAKTPLAN (ledelse)'));
const myjob = shellSrc.slice(shellSrc.indexOf('function goMyWork('), shellSrc.indexOf('function goSchedule('));

// ---- QA-A: time-action dialogs -------------------------------------------------------------------
t('QA-A1', 'no employee-visible preview/build wording in the three time-action dialogs; current time shown plainly as "Nå: HH:MM"', () => {
  const visible = strip(dialogs);
  // employee-visible text = the string literals of the dialog region (code identifiers such as .test() are not text)
  const literals = (visible.match(/'[^'\n]*'/g) || []);
  const bad = literals.filter((x) => /forhåndsvisning|preview|fikstur|fixture|\btest\b|demo/i.test(x));
  assert.deepEqual(bad, [], 'build vocabulary left in dialog text');
  assert.equal((visible.match(/'Nå: ' \+ fmtHM\(nowShown\)/g) || []).length, 2, 'clock + break dialogs show Nå: HH:MM');
  for (const fn of ['function openClockDialog(', 'function openBreakDialog(', 'function openDeclareBreakDialog(']) assert.ok(dialogs.includes(fn), fn);
});
t('QA-A2', 'dialogs use one product frame: card + kicker + h2 + labelled rows + primary confirm / secondary Avbryt with consistent heights; no inline styles', () => {
  assert.equal((dialogs.match(/dialogFrame\('Dagens vakt'/g) || []).length, 3);
  assert.equal((dialogs.match(/^\s+dialogActions\(card, /gm) || []).length, 3, 'three dialogs call the shared action row');
  assert.ok(dialogs.includes("el('button', { cls: 'btn primary', text: confirmLabel") && dialogs.includes("el('button', { cls: 'btn secondary', text: 'Avbryt'"));
  assert.ok(!/style:/.test(strip(dialogs)), 'no inline styles in the dialogs');
  for (const lbl of ["'Faktisk ' + (kind === 'in' ? 'start' : 'slutt')", "'Årsak (kreves ved avvik)'", "'Notat (kreves ved «Annet»)'", "'Din oppgitte totale pausetid (minutter)'"]) assert.ok(dialogs.includes(lbl), lbl);
  for (const css of ['.dlg-actions { display:flex; gap:10px;', '.dlg-actions .btn { flex:1 1 0; margin:0; min-height:48px;', '.form-row { margin-top:14px; }', '.form-err {']) assert.ok(htmlSrc.includes(css), css);
});
t('QA-A3', 'operation semantics unchanged: same core calls with the same arguments; Avbryt is a no-write path', () => {
  for (const s of [
    "computeClockTimes({\n        nowMs: Date.now(),\n        declaredHM: declaredEdited ? timeInput.value : undefined,\n        workDate: shift.workDate, timezone: TZ, mayAdjust: POLICY.employeeMayAdjustTime,\n      });",
    "res = clockIn({ actor, shift, existing: attendanceStore.get(attId), declaredStartAt: declared, reasonCode, reasonNote, scope }, now, POLICY);",
    "res = clockOut({ actor, existing: attendanceStore.get(attId), declaredEndAt: declared, reasonCode, reasonNote, scope }, now, POLICY);",
    "? startBreak({ actor, existing, scope }, now, POLICY)\n        : endBreak({ actor, existing, scope }, now, POLICY);",
    "declareBreak({ actor, existing: attendanceStore.get(attId), declaredBreakMinutesTotal, reasonCode, reasonNote, scope }, now, POLICY)",
    "reasonRequiredForClock(reasonKind, { declaredAt: declared, observedAt: now, plannedAt, policy: POLICY })",
    "reasonRequiredForBreak(declaredBreakMinutesTotal, POLICY)",
    "const scope = { tenantId: membership.tenantId, shiftId: shift.shiftId };",
    "if (POLICY.employeeMayAdjustTime !== true) timeInput.disabled = true;",
  ]) assert.ok(dialogs.includes(s), 'semantics drifted: ' + s.slice(0, 60));
  assert.equal((dialogs.match(/\}, \(\) => goToday\(membership\)\);/g) || []).length, 3, 'every dialog cancels straight back to I dag');
  const cancelFn = dialogs.slice(dialogs.indexOf('function dialogActions('), dialogs.indexOf('function reasonSelectFor('));
  assert.ok(!/attendanceStore|clockIn|clockOut|startBreak|endBreak|declareBreak/.test(cancelFn), 'action-row helper writes nothing');
});
t('QA-A4', 'source-reality ruling: MANAGEMENT_DECISION is canonically valid for employee self-selection, so the dialogs keep the live taxonomy unfiltered', () => {
  const cfg = ETR2A_POLICY.reasonCodes.MANAGEMENT_DECISION;
  for (const k of ['clock_in', 'clock_out', 'break', 'manager']) assert.ok(cfg.appliesTo.includes(k), k);
  // the core accepts an EMPLOYEE clock-out with that reason (same shape the core battery's clockedOut helper uses)
  const wd = '2026-09-12';
  const ms = (hm) => tenantLocalHMToUtcMs(wd, hm, TZ);
  const shift = { shiftId: 'sh-qa', tenantId: 'four-season', ansattId: 'ans-qa', workDate: wd, plannedStartAt: ms('12:00'), plannedEndAt: ms('20:00'), status: 'assigned', roleKey: null, revision: 1, createdByUid: 'u', createdAt: 0, updatedAt: 0 };
  const actor = { uid: 'uid-qa', accessRole: 'employee', ansattId: 'ans-qa', accessEnabled: true, tenantId: 'four-season' };
  const scope = { tenantId: 'four-season', shiftId: 'sh-qa' };
  const cin = clockIn({ actor, shift, existing: undefined, declaredStartAt: ms('12:00'), reasonCode: null, reasonNote: null, scope }, ms('12:00'), ETR2A_POLICY);
  assert.ok(cin.ok, cin.code);
  const cout = clockOut({ actor, existing: cin.attendance, declaredEndAt: ms('18:00'), reasonCode: 'MANAGEMENT_DECISION', reasonNote: null, scope }, ms('18:00'), ETR2A_POLICY);
  assert.ok(cout.ok, 'employee MANAGEMENT_DECISION refused by the core: ' + cout.code);
  // therefore the employee dialogs filter ONLY by the canonical appliesTo and hide nothing
  assert.ok(dialogs.includes('if (cfg.appliesTo.includes(kind)) sel.appendChild('));
  assert.ok(!/MANAGEMENT_DECISION/.test(strip(dialogs)), 'no hand-rolled reason filtering in the dialogs');
  // owner label ruling: employees see "Etter avtale med leder" for the SAME stored code; managers keep "Ledelsens beslutning"
  const empLabels = shellSrc.slice(shellSrc.indexOf('const REASON_LABELS = {'), shellSrc.indexOf('};', shellSrc.indexOf('const REASON_LABELS = {')));
  const mgrLabels = shellSrc.slice(shellSrc.indexOf('const MANAGER_REASON_LABELS = Object.freeze({'), shellSrc.indexOf('});', shellSrc.indexOf('const MANAGER_REASON_LABELS = Object.freeze({')));
  assert.ok(empLabels.includes("MANAGEMENT_DECISION: 'Etter avtale med leder'"), 'employee label');
  assert.ok(mgrLabels.includes("MANAGEMENT_DECISION: 'Ledelsens beslutning'"), 'manager label unchanged');
  assert.ok(!/Ledelsesbeslutning/.test(shellSrc), 'old employee wording gone everywhere in the shell');
  assert.ok(dialogs.includes("text: REASON_LABELS[key] || key, attrs: { value: key }"), 'option value stays the canonical code; only the text is the employee label');
  assert.ok(shellSrc.includes('label: MANAGER_REASON_LABELS[code] || code'), 'manager flow still reads its own label map');
});

// ---- QA-B: month trailing dead week ---------------------------------------------------------------
t('QA-B1', 'September 2026 shows five rows (35 cells); the canonical grid stays 42 cells', () => {
  const g = monthGridFor({ year: 2026, month: 9, shifts: [], now: null, timezone: TZ });
  assert.equal(g.cells.length, 42);
  const v = visibleMonthCells(g.cells);
  assert.equal(v.length, 35);
  assert.equal(v[0].workDate, '2026-08-31'); assert.equal(v[34].workDate, '2026-10-04');
  assert.ok(v.slice(-7).some((c) => c.inMonth), 'last visible row holds a September date');
  assert.ok(g.cells.slice(-7).every((c) => !c.inMonth), 'the dropped row was entirely October');
});
t('QA-B2', 'a genuine six-row month keeps all 42 cells (August 2026 ends on Monday 31st in row 6)', () => {
  const g = monthGridFor({ year: 2026, month: 8, shifts: [], now: null, timezone: TZ });
  const v = visibleMonthCells(g.cells);
  assert.equal(v.length, 42);
  assert.ok(g.cells.slice(-7).some((c) => c.inMonth && c.workDate === '2026-08-31'));
});
t('QA-B3', 'property over 36 months: only whole trailing outside-month weeks are removed, never a row holding a month date', () => {
  for (let i = 0; i < 36; i++) {
    const year = 2025 + Math.floor(i / 12), month = (i % 12) + 1;
    const g = monthGridFor({ year, month, shifts: [], now: null, timezone: TZ });
    const v = visibleMonthCells(g.cells);
    assert.ok(v.length % 7 === 0 && v.length >= 28 && v.length <= 42, year + '-' + month);
    assert.ok(v.slice(-7).some((c) => c.inMonth), 'last visible row must hold a month date ' + year + '-' + month);
    for (const c of g.cells.slice(v.length)) assert.equal(c.inMonth, false, 'removed a month date ' + c.workDate);
    assert.deepEqual(v, g.cells.slice(0, v.length), 'order and content untouched');
  }
  assert.deepEqual(visibleMonthCells([]), []); assert.deepEqual(visibleMonthCells(null), []);
});
t('QA-B4', 'the view draws the visible cells but keeps selection/detail on the canonical grid; the month truth module is untouched', () => {
  assert.ok(viewSrc.includes('for (const cell of visibleMonthCells(grid.cells))'));
  assert.ok(viewSrc.includes("const sel = grid.cells.find((c) => c.inMonth && c.workDate === selectedWd) || grid.cells.find((c) => c.inMonth);"));
  assert.ok(viewSrc.includes("const firstInMonth = grid.cells.find((c) => c.inMonth).workDate;"));
  const monthSrc = fs.readFileSync(new URL('./employee-schedule-month.mjs', import.meta.url), 'utf8');
  assert.ok(monthSrc.includes('for (let i = 0; i < 42; i++)') && !/visibleMonthCells|trailing/.test(monthSrc), 'truth module unchanged');
  // cancelled / overnight / two-shift rendering paths still present
  for (const s of ["' cancel'", "' +1d'", "'+' + (cell.shifts.length - 2)", "cls += ' work'", "cls += ' sel'"]) assert.ok(viewSrc.includes(s), s);
});

// ---- QA-C: Plan back-link position ---------------------------------------------------------------
t('QA-C1', 'exactly one "Tilbake til i dag" control on Plan, placed by the shell AFTER Ledige vakter; the view draws none for the employee', () => {
  assert.equal((plan.match(/Tilbake til i dag/g) || []).length, 1);
  assert.ok(plan.indexOf('ledigeRoot.appendChild(card);') < plan.indexOf("root.appendChild(backBtn('← Tilbake til i dag', () => goToday(membership)));"));
  const call = plan.slice(plan.indexOf('renderScheduleView(planRoot, {'), plan.indexOf('});', plan.indexOf('renderScheduleView(planRoot, {')));
  assert.ok(!/onBack/.test(call), 'employee Plan passes no onBack');
  assert.ok(viewSrc.includes("if (typeof onBack === 'function') {"), 'view draws the back control only on request');
  assert.ok(shellSrc.includes('onBack: () => goVaktplan(),'), 'management Se som ansatt still passes its own back');
});

// ---- QA-D: Min ansettelse hover -------------------------------------------------------------------
t('QA-D1', 'read-only fact rows carry .static (no hover tint, default cursor); interactive employee rows keep their hover', () => {
  assert.ok(myjob.includes("el('div', { cls: 'emp-row static' })"));
  assert.ok(!/cursor:default/.test(myjob), 'no inline cursor style any more');
  assert.ok(htmlSrc.includes('.emp-row.static { cursor:default; }') && htmlSrc.includes('.emp-row.static:hover { border-color:var(--line); background:#fff; }'));
  assert.ok(htmlSrc.includes('.emp-row:hover { border-color:var(--green-line); background:var(--green-tint); }'), 'interactive hover rule untouched');
  assert.ok(!/emp-row static/.test(mgmtViewSrc), 'management rows unchanged');
});

// ---- QA-E: preservation ---------------------------------------------------------------------------
t('QA-E1', 'Oversikt V1 content preserved in shell and html whenever the Oversikt module is present (dirty tree); Min ansettelse facts and scope line intact', () => {
  // The employee checkpoint deliberately excludes Oversikt V1; the preservation guard applies only
  // when the Oversikt composition module exists alongside this test (the uncommitted working tree).
  if (fs.existsSync(new URL('./management-oversikt.mjs', import.meta.url))) {
    for (const s of ['function oversiktFacts()', 'function goOversiktTarget(', "monthFactsOf({ rows, plannedFor: plannedShiftsForPayroll, periodId, planning: planningEconomyForPeriod(periodId), todayWorkDate: today, frozen: !!approved })", "import { dagensBildeFra, ansattFaktaFra, oppmerksomhetFra, EMPTY_ATTENTION } from './management-oversikt.mjs';"]) assert.ok(shellSrc.includes(s), s);
    assert.ok(htmlSrc.includes('/* Oversikt V1 — owner cockpit') && htmlSrc.includes('.ov-row {'));
  }
  for (const s of ['minAnsettelseFra({', 'SCOPE_LINE', "el('h2', { text: 'Min ansettelse' })"]) assert.ok(myjob.includes(s), s);
});

// ---- QA-F: ended shift with no registration ------------------------------------------------------
t('QA-F1', 'Home renders the missing-registration attention state from the pure flag; completed/active/day-off/current states untouched; no backdated clock-in', () => {
  const home = shellSrc.slice(shellSrc.indexOf('  function goToday(membership) {'), shellSrc.indexOf('  function goTodaySlice1('));
  assert.ok(home.includes("else if (hero.kind === 'completed' && hero.missingRegistration) mood = 'missing';"), 'state comes from the pure derivation');
  assert.ok(home.indexOf("hero.missingRegistration) mood = 'missing'") < home.indexOf("else if (hero.kind === 'completed') mood = 'done';"), 'missing is decided before the generic completed state');
  for (const s of ["text: mood === 'missing' ? 'Vakten er over' : timeRange", "'Ingen arbeidstid er registrert for denne vakten.'", "'Ta kontakt med leder for å få registrert eller korrigert arbeidstiden.'", "else if (mood === 'missing') { stateText = 'Ingen arbeidstid registrert'; stateCls = 'status attn'; }", "cls: 'card hero ' + (mood === 'missing' ? 'attn' : mood)"]) assert.ok(home.includes(s), 'missing: ' + s);
  // the completed copy is still exclusively the done state; the missing state can never show it
  assert.ok(home.includes("if (mood === 'done') txt.appendChild(el('div', { cls: 'lead', text: 'Takk for i dag.' }));"));
  assert.ok(home.includes("mood === 'done' ? 'Dagens vakt · fullført' : 'Dagens vakt'"));
  assert.ok(home.includes("else if (att && att.status === 'clocked_out') mood = 'done';"), 'completed attendance state unchanged');
  assert.ok(home.includes("if (mood === 'work' && ended) txt.appendChild(el('div', { cls: 'lead', text: 'Planlagt slutt er passert' }));"), 'active-after-end state unchanged');
  assert.ok(home.includes("if (hero.kind === 'free') mood = 'free';") && home.includes("text: 'Fri i dag'"), 'day off unchanged');
  assert.ok(home.includes("else if (started && !ended) mood = 'attn';"), 'current shift without attendance keeps the amber not-clocked-in state');
  // no employee clock-in exists for an ended shift: availability is still active|current|upcoming only
  assert.ok(home.includes("const actionable = hero.kind === 'active' || hero.kind === 'current' || hero.kind === 'upcoming';"));
  assert.ok(home.includes("clockInPermitted: !att && actionable && POLICY.employeeClockingEnabled === true,"));
  assert.ok(home.includes("if (!att && actionable) {\n        acts.appendChild(emph('stemple_inn'"), 'clock-in button only when actionable');
  // one attendance store, nothing fabricated: the missing state reads the flag only, writes nothing
  const missingBlock = home.slice(home.indexOf("if (mood === 'missing') {"), home.indexOf("// status pill (authoritative text)"));
  assert.ok(!/attendanceStore\.(set|delete)|clockIn\(|managerManualEntry|observedClockInAt/.test(missingBlock), 'missing state reads the flag only, writes nothing');
  // the pure flag lives in the week derivation and is additive
  const weekSrc = fs.readFileSync(new URL('./employee-schedule-week.mjs', import.meta.url), 'utf8');
  assert.ok(weekSrc.includes("missingRegistration: kind === 'completed' && !attendance"));
});

for (const l of lines) console.log(l);
console.log('EMPLOYEE_PAGE_QA_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
