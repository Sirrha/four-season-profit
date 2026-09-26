// employee-myjob.test.mjs
// EMPLOYEE PAGE V1 — "Min ansettelse" proofs MJ1–MJ9. Node built-ins only.
// Run: node employee-myjob.test.mjs   (exit 0 = all pass)
//
// SCOPE: the pure presentation helper and the shell's call site. Employee truth itself stays
// proven by management-employees-core.test.mjs; here we prove the page reads that truth through
// the canonical functions, renders missing facts honestly, carries no money, and writes nothing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { minAnsettelseFra, nbDate, fmtHoursPerWeek, EMPLOYMENT_TYPE_LABELS, IKKE_REGISTRERT, SCOPE_LINE } from './employee-myjob.mjs';
import { seedFourSeasonEmployees, employeeOf, currentTermsOf, startDateOf, contractStatusOf, EMPLOYMENT_TYPES } from './management-employees-core.mjs';
import { FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, ROLE_LABELS } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const T = FOUR_SEASON_TENANT.tenantId;
const TODAY = '2026-09-12';
const shellSrc = fs.readFileSync(new URL('./employee-shell-ui.mjs', import.meta.url), 'utf8');
const htmlSrc = fs.readFileSync(new URL('./employee-shell.html', import.meta.url), 'utf8');
const modSrc = fs.readFileSync(new URL('./employee-myjob.mjs', import.meta.url), 'utf8');
const region = shellSrc.slice(shellSrc.indexOf('function goMyWork('), shellSrc.indexOf('function goSchedule('));
const byKey = (f) => Object.fromEntries(f.rows.map((r) => [r.key, r.value]));

t('MJ1', 'complete terms -> every fact rendered, no missing row, no "Forventet" row when that fact is absent', () => {
  const f = minAnsettelseFra({ terms: { role: 'butikkmedarbeider', employmentType: 'fast', percentage: 100, workplace: 'Four Season', expectedWeeklyHours: null }, startDate: '2023-03-01', contractStatus: 'finnes', roleLabels: ROLE_LABELS });
  assert.deepEqual(f.rows.map((r) => r.label), ['Stilling', 'Stillingstype', 'Stillingsprosent', 'Arbeidssted', 'Ansatt fra', 'Arbeidsavtale']);
  assert.deepEqual(byKey(f), { stilling: ROLE_LABELS.butikkmedarbeider, stillingstype: 'Fast', stillingsprosent: '100 %', arbeidssted: 'Four Season', ansatt_fra: '01.03.2023', arbeidsavtale: 'Registrert' });
  assert.equal(f.missingCount, 0); assert.equal(f.complete, true);
});
t('MJ2', 'incomplete terms -> Ikke registrert per missing fact; contract missing -> Mangler', () => {
  const f = minAnsettelseFra({ terms: { role: 'butikkmedarbeider', employmentType: 'deltid', percentage: null, workplace: null }, startDate: '2025-01-10', contractStatus: 'mangler', roleLabels: ROLE_LABELS });
  assert.deepEqual(byKey(f), { stilling: ROLE_LABELS.butikkmedarbeider, stillingstype: 'Deltid', stillingsprosent: IKKE_REGISTRERT, arbeidssted: IKKE_REGISTRERT, ansatt_fra: '10.01.2025', arbeidsavtale: 'Mangler' });
  assert.deepEqual(f.rows.filter((r) => r.missing).map((r) => r.key), ['stillingsprosent', 'arbeidssted', 'arbeidsavtale']);
  assert.equal(f.missingCount, 3); assert.equal(f.complete, false);
});
t('MJ3', 'no terms at all -> everything Ikke registrert, contract Mangler; nothing invented', () => {
  const f = minAnsettelseFra({ terms: null, startDate: null, contractStatus: null, roleLabels: ROLE_LABELS });
  assert.deepEqual(byKey(f), { stilling: IKKE_REGISTRERT, stillingstype: IKKE_REGISTRERT, stillingsprosent: IKKE_REGISTRERT, arbeidssted: IKKE_REGISTRERT, ansatt_fra: IKKE_REGISTRERT, arbeidsavtale: 'Mangler' });
  assert.equal(f.rows.length, 6);
});
t('MJ4', '"Forventet timer per uke" appears only when the fact exists, formatted nb-NO', () => {
  const withHours = minAnsettelseFra({ terms: { role: 'x', employmentType: 'deltid', percentage: 50, workplace: 'Four Season', expectedWeeklyHours: 18.75 }, startDate: '2024-06-15', contractStatus: 'mangler', roleLabels: {} });
  assert.equal(byKey(withHours).forventet_timer, '18,75 t per uke');
  assert.equal(withHours.rows.length, 7);
  assert.equal(fmtHoursPerWeek(37.5), '37,5 t per uke'); assert.equal(fmtHoursPerWeek(null), null); assert.equal(fmtHoursPerWeek(-1), null);
  assert.equal(byKey(minAnsettelseFra({ terms: { role: 'x', expectedWeeklyHours: undefined }, startDate: null, contractStatus: null, roleLabels: {} })).forventet_timer, undefined);
  assert.equal(byKey(withHours).stilling, 'x', 'unknown role key falls back to the key, never to a guess');
});
t('MJ5', 'employment-type labels cover exactly the canonical EMPLOYMENT_TYPES', () => {
  assert.deepEqual(Object.keys(EMPLOYMENT_TYPE_LABELS).sort(), EMPLOYMENT_TYPES.slice().sort());
  for (const k of EMPLOYMENT_TYPES) assert.ok(EMPLOYMENT_TYPE_LABELS[k] && EMPLOYMENT_TYPE_LABELS[k] !== k);
});
t('MJ6', 'no monetary truth anywhere: the helper never surfaces compensation; module and page carry no kroner/rate/payroll labels or keys', () => {
  const f = minAnsettelseFra({ terms: { role: 'x', employmentType: 'fast', percentage: 100, workplace: 'Four Season', compensation: { model: 'timelonn', hourlyRate: 250 } }, startDate: '2021-01-01', contractStatus: 'finnes', roleLabels: {} });
  const blob = JSON.stringify(f);
  assert.ok(!/compensation|hourlyRate|monthlySalary|timelonn|fastlonn|250|kr/i.test(blob), 'rows leak money: ' + blob);
  const code = modSrc.replace(/\/\/.*$/gm, '').replace(SCOPE_LINE, '');
  assert.ok(!/compensation|hourlyRate|monthlySalary|timelonn|fastlonn|estimat|kostnad|\bkr\b|lønn|skatt|feriepeng|payroll|payable/i.test(code), 'module carries monetary vocabulary');
  const page = region.replace(/\/\/.*$/gm, '').replace(/SCOPE_LINE/g, '');
  assert.ok(!/compensation|hourlyRate|monthlySalary|fmtKr|estimat|kostnad|\bkr\b|lønn|payroll|planningEconomy|buildPayrollPackage|monthFactsOf/i.test(page), 'page carries monetary vocabulary');
  assert.equal(SCOPE_LINE, 'Lønn, skatt, feriepenger og dokumenter er ikke tilgjengelig i denne versjonen.');
  assert.ok(!/Kommer senere/.test(region), 'no placeholder wording left on the finished destination');
});
t('MJ7', 'the page reads canonical employee truth at the call site and writes nothing; nav label and back behaviour unchanged; helper is import-free', () => {
  for (const s of ['employeeOf(employeeStore(), membership.tenantId, membership.ansattId)', 'currentTermsOf(e, today)', 'startDateOf(e)', 'contractStatusOf(e)', 'minAnsettelseFra({', 'roleLabels: ROLE_LABELS', "setChrome(membership, 'work')", "backBtn('← Tilbake til i dag', () => goToday(membership))", 'SCOPE_LINE']) assert.ok(region.includes(s), 'missing: ' + s);
  assert.ok(!/applyEmployeeOperation|applyScheduleOperation|applyPayrollOperation|attendanceStore\.(set|delete|clear)|clockIn\(|clockOut\(|managerCorrection|\.terms\s*=|\.documents\s*=|localStorage|sessionStorage|fetch\(/.test(region), 'page must write nothing');
  assert.ok(!/^import /m.test(modSrc), 'helper is import-free');
  assert.ok(htmlSrc.includes('<button type="button" data-nav="work">Jobb &amp; økonomi</button>'), 'nav label kept');
  assert.ok(shellSrc.includes("import { minAnsettelseFra, SCOPE_LINE } from './employee-myjob.mjs';"));
  assert.ok(/import \{[^}]*currentTermsOf[^}]*contractStatusOf[^}]*\} from '\.\/management-employees-core\.mjs';/.test(shellSrc), 'canonical readers imported from the employees core');
});
t('MJ8', 'fixture end-to-end through the same canonical functions: Maria complete, Yussef honest; stores untouched', () => {
  const store = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
  const before = JSON.stringify(store);
  const factsFor = (id) => { const e = employeeOf(store, T, id); return minAnsettelseFra({ terms: currentTermsOf(e, TODAY), startDate: startDateOf(e), contractStatus: contractStatusOf(e), roleLabels: ROLE_LABELS }); };
  const maria = factsFor('ans-maria'), yussef = factsFor('ans-yussef');
  assert.deepEqual(byKey(maria), { stilling: 'Butikkmedarbeider', stillingstype: 'Fast', stillingsprosent: '100 %', arbeidssted: 'Four Season', ansatt_fra: '01.03.2023', arbeidsavtale: 'Registrert' });
  assert.equal(maria.complete, true);
  assert.deepEqual(byKey(yussef), { stilling: 'Butikkmedarbeider', stillingstype: 'Deltid', stillingsprosent: IKKE_REGISTRERT, arbeidssted: 'Four Season', ansatt_fra: '10.01.2025', arbeidsavtale: 'Mangler' });
  assert.deepEqual(yussef.rows.filter((r) => r.missing).map((r) => r.key), ['stillingsprosent', 'arbeidsavtale']);
  assert.equal(JSON.stringify(store), before, 'employee store unchanged by reading');
});
t('MJ9', 'dates are DD.MM.YYYY from ISO only; the helper uses no ambient clock', () => {
  assert.equal(nbDate('2023-03-01'), '01.03.2023'); assert.equal(nbDate('2026-12-31'), '31.12.2026');
  assert.equal(nbDate('01.03.2023'), null); assert.equal(nbDate(null), null); assert.equal(nbDate(''), null);
  assert.ok(!/Date\.now|new Date\(/.test(modSrc), 'no ambient clock in the helper');
});

for (const l of lines) console.log(l);
console.log('EMPLOYEE_MYJOB_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
