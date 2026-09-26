// employee-self-projection.test.mjs
// OD-4 least-privilege projection proofs S1–S8. Node built-ins only. Run: node employee-self-projection.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectEmployeeSelf, employeeSelfToShellEmployee, validateEmployeeSelfDoc, EMPLOYEE_SELF_FIELDS, EMPLOYEE_SELF_DOC_FIELDS, EMPLOYEE_SELF_FORBIDDEN } from './employee-self-projection.mjs';
import { seedFourSeasonEmployees, employeeOf, currentTermsOf, startDateOf, contractStatusOf, applyEmployeeOperation } from './management-employees-core.mjs';
import { FOUR_SEASON_PEOPLE, FOUR_SEASON_TENANT, ROLE_LABELS } from './employee-schedule-fixture.mjs';
import { minAnsettelseFra } from './employee-myjob.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }
const T = FOUR_SEASON_TENANT.tenantId, TODAY = '2026-09-25';
const store = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
const rowsOf = (e) => minAnsettelseFra({ terms: e ? currentTermsOf(e, TODAY) : null, startDate: e ? startDateOf(e) : null, contractStatus: e ? contractStatusOf(e) : null, roleLabels: ROLE_LABELS }).rows;

t('S1', 'projection carries exactly the eight ratified business fields, nothing else', () => {
  for (const p of FOUR_SEASON_PEOPLE) {
    const proj = projectEmployeeSelf(employeeOf(store, T, p.ansattId), TODAY);
    assert.deepEqual(Object.keys(proj).sort(), [...EMPLOYEE_SELF_FIELDS].sort());
    for (const k of EMPLOYEE_SELF_FORBIDDEN) assert.ok(!(k in proj), k);
  }
  assert.deepEqual([...EMPLOYEE_SELF_FIELDS], ['name', 'role', 'employmentType', 'percentage', 'workplace', 'startDate', 'expectedWeeklyHours', 'hasContract']);
  assert.deepEqual([...EMPLOYEE_SELF_DOC_FIELDS].slice(8), ['derivedAt', 'sourceRevision']);
});
t('S2', 'derivation equals the canonical helpers (one truth): role/type/percentage/workplace/startDate/contract for all five', () => {
  for (const p of FOUR_SEASON_PEOPLE) {
    const e = employeeOf(store, T, p.ansattId); const cur = currentTermsOf(e, TODAY); const proj = projectEmployeeSelf(e, TODAY);
    assert.equal(proj.name, e.name); assert.equal(proj.role, cur.role); assert.equal(proj.employmentType, cur.employmentType);
    assert.equal(proj.percentage, cur.percentage); assert.equal(proj.workplace, cur.workplace); assert.equal(proj.startDate, startDateOf(e));
    assert.equal(proj.expectedWeeklyHours, cur.expectedWeeklyHours); assert.equal(proj.hasContract, contractStatusOf(e) === 'finnes');
  }
});
t('S3', 'wage/compensation never leaks: employees WITH compensation and contact data project without them', () => {
  const e = employeeOf(store, T, 'ans-maria');
  assert.ok(currentTermsOf(e, TODAY).compensation, 'fixture has compensation');
  const proj = projectEmployeeSelf(e, TODAY);
  const s = JSON.stringify(proj);
  for (const bad of ['compensation', 'hourlyRate', 'monthlySalary', '250', 'timelonn', 'bank', 'personnummer', 'notater', 'contact', 'birthDate']) assert.ok(!s.includes(bad), 'leak: ' + bad);
});
t('S4', 'round trip: projection → shell employee shape → Min ansettelse rows are IDENTICAL to the canonical rows (no UI change)', () => {
  for (const p of FOUR_SEASON_PEOPLE) {
    const e = employeeOf(store, T, p.ansattId);
    const doc = Object.assign({}, projectEmployeeSelf(e, TODAY), { derivedAt: null, sourceRevision: 1 });
    const back = employeeSelfToShellEmployee(p.ansattId, doc);
    assert.deepEqual(rowsOf(back), rowsOf(e), p.ansattId);
    assert.equal(back.ansattId, p.ansattId); assert.equal(back.terms[0].compensation, null); assert.deepEqual(back.contact, { email: null, phone: null, address: null, birthDate: null });
  }
});
t('S5', 'missing facts stay honest: a fresh employee (createEmployee) projects nulls and renders "Ikke registrert" rows, never invented values', () => {
  const st2 = seedFourSeasonEmployees([], T);
  const adm = { uid: 'u', accessRole: 'admin', ansattId: 'a', accessEnabled: true, tenantId: T, canEditEmployment: true, canViewEmployeeCore: true };
  const r = applyEmployeeOperation({ store: st2, tenantId: T, actor: adm, op: { kind: 'createEmployee', name: 'Ny Ansatt', startDate: '2026-09-01', role: 'butikkmedarbeider' }, now: Date.now(), timezone: 'Europe/Oslo' });
  assert.ok(r.ok, r.code);
  const e = employeeOf(st2, T, r.ansattId || Object.keys(st2[T])[0]);
  const proj = projectEmployeeSelf(e, TODAY);
  assert.equal(proj.employmentType, null); assert.equal(proj.percentage, null); assert.equal(proj.workplace, null); assert.equal(proj.hasContract, false); assert.equal(proj.startDate, '2026-09-01');
  const rows = rowsOf(employeeSelfToShellEmployee(e.ansattId, Object.assign({}, proj, { derivedAt: null, sourceRevision: null })));
  assert.ok(rows.filter((x) => x.missing).length >= 3);
  assert.deepEqual(rows, rowsOf(e));
});
t('S6', 'validateEmployeeSelfDoc: exact key set enforced; forbidden or missing keys and bad types fail closed', () => {
  const good = Object.assign({}, projectEmployeeSelf(employeeOf(store, T, 'ans-aboud'), TODAY), { derivedAt: null, sourceRevision: 3 });
  assert.equal(validateEmployeeSelfDoc(good).ok, true);
  assert.equal(validateEmployeeSelfDoc(Object.assign({}, good, { timelonn: 250 })).code, 'FIELD_FORBIDDEN:timelonn');
  assert.equal(validateEmployeeSelfDoc(Object.assign({}, good, { personnummer: 'x' })).code, 'FIELD_FORBIDDEN:personnummer');
  assert.equal(validateEmployeeSelfDoc(Object.assign({}, good, { ansattId: 'x' })).code, 'FIELD_FORBIDDEN:ansattId');
  const miss = Object.assign({}, good); delete miss.hasContract; assert.equal(validateEmployeeSelfDoc(miss).code, 'FIELD_MISSING:hasContract');
  assert.equal(validateEmployeeSelfDoc(Object.assign({}, good, { percentage: 140 })).code, 'PERCENTAGE_INVALID');
  assert.equal(validateEmployeeSelfDoc(Object.assign({}, good, { employmentType: 'vikar' })).code, 'EMPLOYMENT_TYPE_INVALID');
  assert.equal(validateEmployeeSelfDoc(Object.assign({}, good, { startDate: '25.09.2026' })).code, 'STARTDATE_INVALID');
  assert.equal(validateEmployeeSelfDoc(null).code, 'DOC_MALFORMED');
});
t('S7', 'the projector is pure: no DOM/network/Firebase/storage, imports only the canonical employee helpers', () => {
  const src = fs.readFileSync(new URL('./employee-self-projection.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // strip block + line comments (prose may say "document.")
  assert.ok(!/firebase|initializeApp|fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.|window\./.test(code));
  const imports = src.match(/^import .*$/gm) || [];
  assert.equal(imports.length, 1); assert.ok(imports[0].includes("./management-employees-core.mjs"));
});
t('S8', 'employeeSelfToShellEmployee refuses bad input and takes ansattId from the PATH argument only', () => {
  assert.equal(employeeSelfToShellEmployee('', {}), null); assert.equal(employeeSelfToShellEmployee('a', null), null);
  const back = employeeSelfToShellEmployee('ans-path', { name: 'X', role: null, employmentType: null, percentage: null, workplace: null, startDate: null, expectedWeeklyHours: null, hasContract: false, derivedAt: null, sourceRevision: null, ansattId: 'ans-injected' });
  assert.equal(back.ansattId, 'ans-path');
});

for (const l of lines) console.log(l);
console.log('EMPLOYEE_SELF_PROJECTION_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
