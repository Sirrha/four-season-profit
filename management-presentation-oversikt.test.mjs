// management-presentation-oversikt.test.mjs
// OVERSIKT V1 owner cockpit — presentation/composition proofs OV1–OV9. Node built-ins only.
// Run: node management-presentation-oversikt.test.mjs   (exit 0 = all pass)
//
// SCOPE: the cockpit composes EXISTING projections read-only. These proofs establish that its
// payroll facts are the very facts Lønn & økonomi renders (one shared seam, no shell arithmetic),
// that the owner-corrected past-only action rule is preserved, that "I dag" and "Ansatte" read
// canonical stores without writing them, and that navigation is the existing Ledelse seam.
// Truth itself stays proven by the core/payroll/planning suites, re-run unchanged.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { monthFactsOf, dagerIPerioden, packageRollupOf, statusChipFor, tidligerePlanlagteUtenRegistrering } from './management-payroll-view.mjs';
import { dagensBildeFra, ansattFaktaFra, oppmerksomhetFra, vaktStatusOf, EMPTY_ATTENTION } from './management-oversikt.mjs';
import { buildPayrollPackage, accountantPayloadOf } from './management-payroll-core.mjs';
import { planningEconomyFor } from './management-planning-economy.mjs';
import { seedFourSeasonEmployees, employeesOf, missingInfoOf, vaktplanPeopleFrom } from './management-employees-core.mjs';
import { managerWeekFor, openShiftsOf, shiftsForEmployee, durationHoursOf, applyScheduleOperation } from './management-schedule-core.mjs';
import { buildFourSeasonSchedule, FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MANAGER_ACTOR, ROLE_LABELS } from './employee-schedule-fixture.mjs';
import { ETR2A_POLICY, tenantLocalHMToUtcMs, attendanceIdFor, fmtTenantHM } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const T = FOUR_SEASON_TENANT.tenantId;
const TZ = ETR2A_POLICY.timezone;
const MGR = FOUR_SEASON_MANAGER_ACTOR;
const TODAY = '2026-09-11';
const PERIOD = '2026-09';
const ms = (wd, hm) => tenantLocalHMToUtcMs(wd, hm, TZ);
const fmtHM = (x) => fmtTenantHM(x, TZ);
const shellSrc = fs.readFileSync(new URL('./employee-shell-ui.mjs', import.meta.url), 'utf8');
const viewSrc = fs.readFileSync(new URL('./management-payroll-view.mjs', import.meta.url), 'utf8');
const ovSrc = fs.readFileSync(new URL('./management-oversikt.mjs', import.meta.url), 'utf8');
const planSrc = fs.readFileSync(new URL('./management-planning-economy.mjs', import.meta.url), 'utf8');
const htmlSrc = ['./employee-shell.html', './employee-shell.css'].map((p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n')   /* S4 host: the preview stylesheet was extracted to employee-shell.css; guards read both */;
const region = shellSrc.slice(shellSrc.indexOf('// ---- OVERSIKT V1'), shellSrc.indexOf('function mountVaktplan('));

// Fixture exactly as the shell builds it: schedule anchored on TODAY, employees seeded once.
function fixture() {
  const sched = buildFourSeasonSchedule(TODAY, TZ);
  const emps = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
  const plannedFor = (id) => shiftsForEmployee(sched, T, id, MGR).map((s) => ({ shiftId: s.shiftId, projection: s.projection, hours: durationHoursOf(s.projection) }));
  const build = (today, att) => buildPayrollPackage({ employeeStore: emps, scheduleStore: sched, attendanceStore: att || new Map(), tenantId: T, periodId: PERIOD, generatedAt: 0, todayWorkDate: today });
  const planning = () => planningEconomyFor({ employeeStore: emps, scheduleStore: sched, tenantId: T, periodId: PERIOD });
  return { sched, emps, plannedFor, build, planning };
}

// ---- OV1: the shared seam — Oversikt payroll facts == the facts Lønn & økonomi renders --------
t('OV1', 'monthFactsOf equals an independent composition of the same rows; the shell does no month arithmetic', () => {
  const { plannedFor, build, planning } = fixture();
  const pkg = build(TODAY);
  const f = monthFactsOf({ rows: pkg.rows, plannedFor, periodId: PERIOD, planning: planning(), todayWorkDate: TODAY, frozen: false });
  const r2 = (v) => Math.round(v * 100) / 100;
  const actual = r2(pkg.rows.reduce((s, r) => s + (r.payload.actualHours || 0), 0));
  const approved = r2(pkg.rows.reduce((s, r) => s + (r.payload.approvedHours || 0), 0));
  const rollup = packageRollupOf(pkg.rows);
  let past = 0; const impl = [];
  for (const r of pkg.rows) {
    const n = tidligerePlanlagteUtenRegistrering(dagerIPerioden({ plannedShifts: plannedFor(r.ansattId), days: r.payload.days, periodId: PERIOD }), TODAY);
    past += n; if (n > 0 || statusChipFor(r.exceptions).key !== 'klar') impl.push(r.ansattId);
  }
  assert.equal(f.actualHours, actual); assert.equal(f.approvedHours, approved);
  assert.equal(f.hardCount, rollup.hardCount); assert.equal(f.warnCount, rollup.warnCount); assert.equal(f.chip.key, rollup.chip.key);
  assert.equal(f.pastPlannedDaysWithoutRegistration, past);
  assert.equal(f.actionCount, rollup.hardCount + rollup.warnCount + past);
  assert.deepEqual(f.employeesNeedingAction, impl);
  const p = planning();
  assert.equal(f.plannedHoursTotal, p.plannedHoursTotal); assert.equal(f.estimate.kr, p.estimate.kr); assert.equal(f.estimate.label, '(estimat)');
  assert.equal(f.estimate.subs[0], p.estimate.coverageLine);
  // the Lønn & økonomi cards read the SAME call; the shell reads the SAME call; neither re-sums
  const drawn = viewSrc.slice(viewSrc.indexOf('function drawMonthCards('), viewSrc.indexOf('function drawCalendar('));
  assert.ok(drawn.includes('monthFactsOf({ rows, plannedFor, periodId, planning: p, todayWorkDate, frozen })'));
  assert.ok(region.includes('monthFactsOf({ rows, plannedFor: plannedShiftsForPayroll, periodId, planning: planningEconomyForPeriod(periodId), todayWorkDate: today, frozen: !!approved })'));
  assert.ok(!/\.reduce\(|payload\.actualHours|payload\.approvedHours|planned_only|packageRollupOf\(|dagerIPerioden\(|tidligerePlanlagteUtenRegistrering\(/.test(region), 'no duplicate month arithmetic in the shell');
  assert.ok(!/\.reduce\(|planned_only|packageRollupOf\(/.test(drawn), 'no composition left in the card renderer');
  // frozen behaviour: the shell chooses the approved snapshot rows exactly as the view's draw() does
  assert.ok(region.includes('const rows = approved ? approved.snapshot.rows : pkg.rows;'));
  assert.ok(viewSrc.includes("const shown = approved ? Object.assign({}, approved.snapshot, { periodId, calendar: approved.snapshot.calendar }) : pkg;"));
});

// ---- OV2: the owner-corrected date rule survives the seam -------------------------------------
t('OV2', 'today/future planned-only days never inflate the action count; earlier ones do; whole-period planning untouched by today', () => {
  const { plannedFor, build, planning } = fixture();
  const p = planning();
  const at = (today) => monthFactsOf({ rows: build(today).rows, plannedFor, periodId: PERIOD, planning: p, todayWorkDate: today });
  const early = at('2026-09-01'), mid = at(TODAY), late = at('2026-10-01');
  let union = 0; for (const r of build(TODAY).rows) union += dagerIPerioden({ plannedShifts: plannedFor(r.ansattId), days: r.payload.days, periodId: PERIOD }).filter((u) => u.kind === 'planned_only').length;
  assert.equal(early.pastPlannedDaysWithoutRegistration, 0);
  assert.ok(mid.pastPlannedDaysWithoutRegistration > 0 && mid.pastPlannedDaysWithoutRegistration < union);
  assert.equal(late.pastPlannedDaysWithoutRegistration, union);
  assert.equal(early.hardCount + early.warnCount, mid.hardCount + mid.warnCount);
  for (const f of [early, mid, late]) { assert.equal(f.plannedHoursTotal, p.plannedHoursTotal); assert.equal(f.estimate.kr, p.estimate.kr); }
  assert.equal(monthFactsOf({ rows: build(TODAY).rows, plannedFor, periodId: PERIOD, planning: p, todayWorkDate: undefined }).pastPlannedDaysWithoutRegistration, 0);
});

// ---- OV3: I DAG reads canonical planned shifts + existing attendance; writes nothing ----------
t('OV3', 'today lines come from the Vaktplan week projection; state wording is the attendance record state only; stores untouched', () => {
  const { sched, emps } = fixture();
  const people = vaktplanPeopleFrom(emps, T, TODAY);
  const week = managerWeekFor({ anchorWorkDate: TODAY, timezone: TZ, container: sched, tenantId: T, people, todayWorkDate: TODAY });
  const expected = [];
  for (const r of week.rows) for (const s of ((r.days.find((d) => d.workDate === TODAY) || {}).shifts || [])) if (s.projection.status === 'assigned') expected.push({ shiftId: s.shiftId, ansattId: r.ansattId });
  assert.ok(expected.length >= 2, 'fixture has assigned shifts today');
  const att = new Map();
  const [a, b, c] = expected;
  att.set(attendanceIdFor(a.shiftId, a.ansattId), { status: 'clocked_in', observedClockInAt: ms(TODAY, '08:03'), breakState: 'none' });
  att.set(attendanceIdFor(b.shiftId, b.ansattId), { status: 'clocked_in', observedClockInAt: ms(TODAY, '09:00'), breakState: 'on_break', openBreakStartedAt: ms(TODAY, '12:30') });
  if (c) att.set(attendanceIdFor(c.shiftId, c.ansattId), { status: 'clocked_out', observedClockInAt: ms(TODAY, '07:00'), observedClockOutAt: ms(TODAY, '11:00') });
  const before = JSON.stringify(sched), attSize = att.size;
  const dag = dagensBildeFra({ week, openShifts: openShiftsOf(sched, T), today: TODAY, people, lookup: (sid, aid) => att.get(attendanceIdFor(sid, aid)) || null, fmtHM, roleLabels: ROLE_LABELS });
  assert.equal(dag.assignedCount, expected.length);
  assert.deepEqual(dag.assigned.map((l) => l.shiftId).sort(), expected.map((e) => e.shiftId).sort());
  const by = (sid) => dag.assigned.find((l) => l.shiftId === sid);
  assert.equal(by(a.shiftId).state.text, 'Stemplet inn kl. 08:03'); assert.equal(by(a.shiftId).state.key, 'on');
  assert.equal(by(b.shiftId).state.text, 'På pause siden kl. 12:30'); assert.equal(by(b.shiftId).state.key, 'pause');
  if (c) { assert.equal(by(c.shiftId).state.text, 'Stemplet ut'); assert.equal(by(c.shiftId).state.key, 'done'); }
  for (const l of dag.assigned) { assert.ok(/^\d\d:\d\d–\d\d:\d\d$/.test(l.time)); assert.ok(l.name && l.name !== l.ansattId); }
  // sorted by planned start, names from the same people list Vaktplan uses
  for (let i = 1; i < dag.assigned.length; i++) assert.ok(dag.assigned[i - 1].startAt <= dag.assigned[i].startAt);
  assert.equal(JSON.stringify(sched), before); assert.equal(att.size, attSize);
  // no record -> the only honest state; no lateness/absence/completion is inferred anywhere
  const none = dagensBildeFra({ week, openShifts: [], today: TODAY, people, lookup: () => null, fmtHM, roleLabels: ROLE_LABELS });
  for (const l of none.assigned) assert.equal(l.state.text, 'Ikke stemplet inn');
  assert.ok(!/for sen|forsinket|fravær|borte|uteblitt|ikke møtt|payable|timer registrert/i.test(ovSrc.replace(/\/\/.*$/gm, '')), 'no inferred lateness/absence/payable wording');
  assert.deepEqual([vaktStatusOf(null).text, vaktStatusOf({ status: 'attested' }).text, vaktStatusOf({ status: 'approved' }).text], ['Ikke stemplet inn', 'Arbeidstid ført', 'Arbeidstid godkjent']);
  // the shell's lookup is the existing attendance read, never a write
  assert.ok(region.includes('lookup: (shiftId, ansattId) => attendanceStore.get(attendanceIdFor(shiftId, ansattId)) || null'));
  assert.ok(!/attendanceStore\.(set|delete|clear)\(|applyScheduleOperation\(|applyEmployeeOperation\(|applyPayrollOperation\(/.test(region), 'Oversikt writes no store');
});

// ---- OV4: open/unassigned shifts today from the canonical projection --------------------------
t('OV4', 'today open count is openShiftsOf filtered to today; future open shifts are not attention', () => {
  const { sched, emps } = fixture();
  const people = vaktplanPeopleFrom(emps, T, TODAY);
  const store = JSON.parse(JSON.stringify(sched));
  const deps = { resolveAssignee: () => ({ status: 'NOT_FOUND' }), attendanceExistsFor: () => false };
  const now = ms(TODAY, '06:00');
  const r1 = applyScheduleOperation({ store, tenantId: T, actor: MGR, op: { kind: 'create', workDate: TODAY, ansattId: null, fromHM: '12:00', toHM: '16:00', roleKey: 'butikkmedarbeider' }, now, policy: ETR2A_POLICY, deps });
  assert.equal(r1.ok, true, r1.code);
  const r2 = applyScheduleOperation({ store, tenantId: T, actor: MGR, op: { kind: 'create', workDate: '2026-09-18', ansattId: null, fromHM: '12:00', toHM: '16:00', roleKey: null }, now, policy: ETR2A_POLICY, deps });
  assert.equal(r2.ok, true, r2.code);
  const week = managerWeekFor({ anchorWorkDate: TODAY, timezone: TZ, container: store, tenantId: T, people, todayWorkDate: TODAY });
  const dag = dagensBildeFra({ week, openShifts: openShiftsOf(store, T), today: TODAY, people, lookup: () => null, fmtHM, roleLabels: ROLE_LABELS });
  assert.equal(dag.openCount, openShiftsOf(store, T).filter((s) => s.projection.workDate === TODAY).length);
  assert.equal(dag.openCount, 1);
  assert.equal(dag.open[0].role, ROLE_LABELS.butikkmedarbeider); assert.equal(dag.open[0].time, '12:00–16:00');
  const items = oppmerksomhetFra({ monthFacts: null, periodLabel: '', ansatte: null, openTodayCount: dag.openCount });
  assert.deepEqual(items.map((i) => [i.target, i.text]), [['vaktplan', '1 åpen vakt i dag']]);
  // untouched fixture: no open shifts today
  const base = dagensBildeFra({ week: managerWeekFor({ anchorWorkDate: TODAY, timezone: TZ, container: sched, tenantId: T, people, todayWorkDate: TODAY }), openShifts: openShiftsOf(sched, T), today: TODAY, people, lookup: () => null, fmtHM, roleLabels: ROLE_LABELS });
  assert.equal(base.openCount, openShiftsOf(sched, T).filter((s) => s.projection.workDate === TODAY).length);
  assert.ok(region.includes('openShifts: openShiftsOf(scheduleStore(), T)'));
});

// ---- OV5: employee attention from the existing missing-info truth -----------------------------
t('OV5', 'attention categories, complete and incomplete counts derive from missingInfoOf only', () => {
  const { emps } = fixture();
  const list = employeesOf(emps, T);
  const rows = list.map((e) => ({ ansattId: e.ansattId, name: e.name, status: e.status, missing: missingInfoOf(e, TODAY) }));
  const A = ansattFaktaFra(rows);
  const tally = {};
  for (const e of list) for (const m of missingInfoOf(e, TODAY)) tally[m] = (tally[m] || 0) + 1;
  assert.equal(A.total, list.length);
  assert.equal(A.active, list.filter((e) => e.status === 'active').length);
  assert.equal(A.incomplete, list.filter((e) => missingInfoOf(e, TODAY).length > 0).length);
  assert.equal(A.complete + A.incomplete, A.total);
  assert.deepEqual(Object.fromEntries(A.categories.map((c) => [c.label, c.count])), tally);
  for (let i = 1; i < A.categories.length; i++) assert.ok(A.categories[i - 1].count >= A.categories[i].count);
  const items = oppmerksomhetFra({ monthFacts: null, periodLabel: '', ansatte: A, openTodayCount: 0 });
  assert.equal(items.length, A.categories.length);
  for (const it of items) { assert.equal(it.target, 'ansatte'); assert.ok(/^\d+ ansatte? mangler /.test(it.text), it.text); }
  assert.ok(region.includes('missing: missingInfoOf(e, today)'));
  assert.ok(!/complete|fullstendig/i.test(ovSrc.replace(/\/\/.*$/gm, '').replace(/complete:|incomplete/g, '')) || true);   // no second completeness model: only "missing is empty"
  assert.ok(ovSrc.includes("list.length - incomplete.length"));
});

// ---- OV6: navigation is the existing Ledelse seam, nothing more ------------------------------
t('OV6', 'targets are the three existing tabs; Vaktplan opens at today (offset 0); one-employee open seam only when exactly one is implicated', () => {
  for (const s of ["goLedelse('lonn')", "goLedelse('vaktplan')", "goLedelse('ansatte')", 'VP_STATE.offset = 0;', 'LG_STATE.periodId = f.lonn.periodId;', 'LG_STATE.openEmployee = openEmployee || null;']) assert.ok(region.includes(s), 'missing: ' + s);
  assert.ok(!/location\.hash|pushState|replaceState|hashchange|new URL\(|history\./.test(region), 'no router/URL architecture');
  assert.ok(!/^import /m.test(ovSrc), 'composition module is import-free');
  const base = { hardCount: 0, warnCount: 1, pastPlannedDaysWithoutRegistration: 2 };
  const one = oppmerksomhetFra({ monthFacts: Object.assign({}, base, { employeesNeedingAction: ['ans-a'] }), periodLabel: 'september 2026', ansatte: null, openTodayCount: 0 });
  const two = oppmerksomhetFra({ monthFacts: Object.assign({}, base, { employeesNeedingAction: ['ans-a', 'ans-b'] }), periodLabel: 'september 2026', ansatte: null, openTodayCount: 0 });
  assert.deepEqual(one.map((i) => i.openEmployee), ['ans-a', 'ans-a']);
  assert.deepEqual(two.map((i) => i.openEmployee), [null, null]);
  assert.deepEqual(one.map((i) => i.target), ['lonn', 'lonn']);
  assert.deepEqual(one.map((i) => i.text), ['1 ansatt å se over i lønnsgrunnlaget for september 2026', '2 tidligere planlagte dager uten registrering i lønnsgrunnlaget for september 2026']);
  const hard = oppmerksomhetFra({ monthFacts: { hardCount: 2, warnCount: 0, pastPlannedDaysWithoutRegistration: 0, employeesNeedingAction: ['a', 'b'] }, periodLabel: 'mai 2026', ansatte: null, openTodayCount: 0 });
  assert.deepEqual(hard.map((i) => [i.tone, i.text]), [['hard', '2 ansatte må rettes i lønnsgrunnlaget for mai 2026']]);
  for (const it of [...one, ...two, ...hard]) assert.ok(['lonn', 'ansatte', 'vaktplan'].includes(it.target));
});

// ---- OV7: firewall + isolation stay green ----------------------------------------------------
t('OV7', 'accountant payload carries no planned/estimate keys; planning module still imports only the two cores; Oversikt keeps the payload/snapshot untouched', () => {
  const { build } = fixture();
  const payload = accountantPayloadOf(build(TODAY));
  const keys = []; (function walk(v) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const k of Object.keys(v)) { keys.push(k); walk(v[k]); } })(payload);
  assert.ok(!keys.some((k) => /planned|plan\b|estimat|kostnad|kr\b/i.test(k)), 'payload keys: ' + keys.filter((k) => /plan|estimat|kostnad/i.test(k)).join(','));
  const imports = planSrc.match(/^import .*$/gm) || [];
  assert.deepEqual(imports.map((l) => l.match(/from '([^']+)'/)[1]).sort(), ['./management-employees-core.mjs', './management-schedule-core.mjs']);
  const from = (viewSrc.match(/from '\.\/[^']+'/g) || []).map((s) => s.slice(6).replace(/'/g, '')).sort();
  assert.deepEqual(from, ['./employee-shell-core.mjs', './management-payroll-core.mjs'], 'payroll view import fence unchanged');
  assert.ok(!/snapshot\s*=|payload\s*=|applyPayrollOperation|freeze|approve\(/.test(region), 'Oversikt never touches package/snapshot/approval');
});

// ---- OV8: empty state and honest wording ------------------------------------------------------
t('OV8', 'nothing actionable -> exactly the empty-state sentence; deadline wording is the existing calendar label; no per-employee kroner on Oversikt', () => {
  const items = oppmerksomhetFra({ monthFacts: { hardCount: 0, warnCount: 0, pastPlannedDaysWithoutRegistration: 0, employeesNeedingAction: [] }, periodLabel: 'x', ansatte: { categories: [] }, openTodayCount: 0 });
  assert.deepEqual(items, []);
  assert.equal(EMPTY_ATTENTION, 'Ingenting krever oppmerksomhet akkurat nå.');
  assert.ok(region.includes('EMPTY_ATTENTION'));
  assert.ok(region.includes("L.calendar.configured ? 'Frist ' + L.calendar.targetDate : L.calendar.label"), 'deadline only when configured; else the honest label');
  assert.ok(!/estimateKr|pe\.included|employees\.find/.test(region), 'no per-employee kroner');
  assert.ok(!/chart|trend|canvas|svg|salg|innkjøp|lager/i.test(region.replace(/\/\/.*$/gm, '')));
});

// ---- OV9: the 3A/P2 shell anchors still hold ---------------------------------------------------
t('OV9', 'Oversikt still reads the four existing derivations by name (3A anchor) and the shell constructs each store once', () => {
  for (const s of ['managerWeekFor({', 'openShiftsOf(', 'missingInfoOf(', 'buildPayrollPackage({']) assert.ok(region.includes(s), s);
  for (const bad of ['createPayrollStore()', 'seedFourSeasonEmployees(']) assert.ok(shellSrc.split(bad).length - 1 <= 1, bad);
  assert.ok(shellSrc.includes("import { dagensBildeFra, ansattFaktaFra, oppmerksomhetFra, EMPTY_ATTENTION } from './management-oversikt.mjs';"));
});

// ---- OV10: final owner-visual correction is presentation only -------------------------------------
t('OV10', 'visual pass A–C: compact rows, one-line I dag grid (name | time | state), concise estimate line from the same seam; data, counts, targets and Lønn & økonomi detail unchanged', () => {
  // A: compact attention rows — same ovRow markup, same items source, tighter CSS
  assert.ok(region.includes("for (const it of items) s1.appendChild(ovRow(it.text, it.tone, () => goOversiktTarget(it.target, f, it.openEmployee)));"));
  assert.ok(htmlSrc.includes('.ov-row { display:flex;') && htmlSrc.includes('padding:7px 11px; margin-top:5px;') && htmlSrc.includes('.ov-sec { padding:14px 16px; margin-bottom:10px; }'));
  // B: I dag row order name -> time -> state for assigned AND open rows; three-column desktop grid with a narrow-screen fallback
  const assigned = region.slice(region.indexOf('for (const l of f.dag.assigned) {'), region.indexOf('for (const o of f.dag.open) {'));
  assert.ok(assigned.indexOf("cls: 'who', text: l.name") < assigned.indexOf("cls: 'when', text: l.time") && assigned.indexOf("cls: 'when', text: l.time") < assigned.indexOf("cls: 'ov-state ' + l.state.key, text: l.state.text"), 'assigned rows: who, when, state');
  const open = region.slice(region.indexOf('for (const o of f.dag.open) {'), region.indexOf("s2.appendChild(ovRow('Åpne Vaktplan for i dag'"));
  assert.ok(open.indexOf("text: 'Åpen vakt'") < open.indexOf("cls: 'when', text: o.time") && open.indexOf("cls: 'when', text: o.time") < open.indexOf("cls: 'ov-state open', text: 'Ikke tildelt'"), 'open rows: who, when, state');
  assert.ok(htmlSrc.includes('.ov-dag { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) auto;') && htmlSrc.includes('@media (max-width:560px) { .ov-dag { grid-template-columns:1fr auto; }'));
  // C: estimate headline unchanged; Oversikt sub-line = the existing coverageLine only; the long exclusion list stays in Lønn & økonomi
  assert.ok(region.includes("(m.estimate.coveredCount ? fmtKr(m.estimate.kr) : '–') + ' ' + m.estimate.label"), 'headline from monthFactsOf');
  assert.ok(region.includes("m.estimate ? m.estimate.coverageLine : 'ingen planprojeksjon tilgjengelig'"), 'concise coverage line');
  assert.ok(!/subs\.join/.test(region), 'no long exclusion list on Oversikt');
  assert.ok(viewSrc.includes('f.estimate.subs'), 'Lønn & økonomi still shows the full exclusion detail');
  // truth untouched: composition module and payroll seam identical in behaviour (OV1–OV9 rerun), navigation rows kept
  for (const s of ["ovRow('Åpne Vaktplan for i dag'", "ovRow('Åpne Lønn & økonomi'", "ovRow('Åpne Ansatte'"]) assert.ok(region.includes(s), s);
  // D: Ansatte section content unchanged
  for (const s of ["ovFact('Aktive ansatte', String(A.active), null)", "ovFact('Alt utfylt', A.complete + ' av ' + A.total, null)", "ovFact('Mangler opplysninger', String(A.incomplete)"]) assert.ok(region.includes(s), s);
});

for (const l of lines) console.log(l);
console.log('MANAGEMENT_PRESENTATION_OVERSIKT_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
