// management-ansettelsesform.test.mjs — ANSETTELSESFORM (fast/midlertidig) vs ARBEIDSOMFANG / stillingstype (deltid …) are
// TWO distinct canonical employment facts on the SAME terms period (node built-ins only).
// Owner law (SIRRHA-CCODE-SORMENA-CONTRACT-ANSETTELSESFORM-SEPARATION-LOCAL-005): the contract wizard never derives
// Ansettelsesform from the scope value and never overwrites the scope; fast + deltid + 50 % + 18.75 t coexist.
// Run: node management-ansettelsesform.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyEmployeeOperation, employeeOf, currentTermsOf, startDateOf, TERMS_FIELDS, EMPLOYMENT_TYPES, EMPLOYMENT_FORMS, missingInfoOf } from './management-employees-core.mjs';
import { TEMPLATE_FIELDS, contractInputsFor, contractReadinessOf, renderContractBlocks, applyContractOperation } from './management-contract-core.mjs';
import { normalizeAnsatt, ansattWriteFor, E360_KEY } from './management-production-adapters.mjs';
import { FOUR_SEASON_CONTRACT_PROFILE, ROLE_LABELS } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, desc, fn) { try { fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }
const T = 'four-season-as';
const ACTOR = { uid: 'u-admin', accessRole: 'admin', ansattId: null, accessEnabled: true, tenantId: T, canManageSchedule: true, canViewOwnSchedule: false, canViewEmployeeCore: true, canViewEmployeeCompensation: true, canEditEmployment: true };
const NOW = Date.UTC(2026, 8, 27, 10, 0, 0);   // 2026-09-27 12:00 Oslo
const TODAY = '2026-09-27';
const apply = (store, op) => applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op, now: NOW });
const PROFILE = Object.assign({}, FOUR_SEASON_CONTRACT_PROFILE, { companyFacts: { salaryPaymentArrangement: 'x', pension: { applies: false }, occupationalInjuryInsurance: { applies: false }, tariffavtale: { applies: false } } });
const inputsOf = (e) => contractInputsFor({ employee: e, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS });
// Herish's live employee, as completed under result -004 (scope deltid / 50 % / 18.75 t / timelønn 210 / 1 måned)
function testAnsatt01() {
  const store = { [T]: {} };
  const c = apply(store, { kind: 'createEmployee', name: 'Test Ansatt 01', startDate: '2026-08-01', role: 'butikkmedarbeider' });
  const r = apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentType: 'deltid', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 210 }, expectedWeeklyHours: 18.75, noticePeriod: '1 måned' } });
  assert.equal(r.ok, true);
  return { store, id: c.ansattId, e: () => employeeOf(store, T, c.ansattId) };
}
const snap = (v) => JSON.parse(JSON.stringify(v));

t('A02', 'root cause pinned in source law: Ansettelsesform is its OWN terms field (employmentForm, fast|midlertidig) — the template field no longer keys on the scope field employmentType; both fields exist on every period', () => {
  const f = TEMPLATE_FIELDS.find((x) => x.label === 'Ansettelsesform');
  assert.equal(f.key, 'employmentForm'); assert.equal(f.source, 'terms');
  assert.ok(TERMS_FIELDS.includes('employmentForm') && TERMS_FIELDS.includes('employmentType'));
  assert.deepEqual(EMPLOYMENT_FORMS, ['fast', 'midlertidig']);
  assert.deepEqual(EMPLOYMENT_TYPES, ['fast', 'deltid', 'tilkalling', 'midlertidig']);      // legacy scope list untouched (no destructive rewrite of stored deltid/heltid data)
  const { e } = testAnsatt01();
  assert.equal(e().terms[0].employmentType, 'deltid'); assert.equal(e().terms[0].employmentForm, null);
});
t('A01/A03', 'the live combination: scope deltid already set -> completing Ansettelsesform = fast on the SAME period is ACCEPTED (before: TERMS_VALUE_ALREADY_SET:employmentType -> CORE_REFUSED); fast + deltid + 50 + 18.75 coexist', () => {
  const { store, id, e } = testAnsatt01();
  const before = snap(e().terms[0]);
  const r = apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'fast' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = e().terms[0];
  assert.equal(p.employmentForm, 'fast'); assert.equal(p.employmentType, 'deltid'); assert.equal(p.percentage, 50); assert.equal(p.expectedWeeklyHours, 18.75);
  assert.deepEqual(p.compensation, { model: 'timelonn', hourlyRate: 210 }); assert.equal(p.noticePeriod, '1 måned');
  assert.deepEqual(snap(Object.assign({}, p, { employmentForm: null })), before, 'nothing but employmentForm changed');
  const again = apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'fast' } });
  assert.equal(again.ok, true, 'same value again is not an overwrite');
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'vikar' } }).code, 'EMPLOYMENTFORM_INVALID');
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'deltid' } }).code, 'EMPLOYMENTFORM_INVALID', 'a scope value is not a form value');
});
t('A09', 'history: period count 1 before and after, start 2026-08-01 before and after, no period dated today; completeness law unchanged (no new missing chip invented)', () => {
  const { store, id, e } = testAnsatt01();
  assert.equal(e().terms.length, 1); assert.equal(startDateOf(e()), '2026-08-01');
  apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'fast' } });
  assert.equal(e().terms.length, 1); assert.equal(startDateOf(e()), '2026-08-01'); assert.equal(e().terms[0].validFrom, '2026-08-01');
  assert.ok(!e().terms.some((x) => x.validFrom === TODAY));
  assert.deepEqual(missingInfoOf(e(), TODAY), ['mangler adresse', 'mangler kontrakt']);
});
t('A06/A08', 'contract readiness + agreement render distinguish the facts: fast -> no temporary facts required, Ansettelsesform row "Fast", Stillingsprosent "50 %", Avtalt arbeidstid "18.75 timer per uke", sluttdato "Ikke aktuell", no Grunnlag row', () => {
  const { store, id, e } = testAnsatt01();
  apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'fast', workplace: 'Four Season Gjøvik', workingTimeArrangement: 'dagtid', breaksArrangement: '30', scheduleChangeHandling: '14 dager', probation: '6', paymentInterval: 'manedlig' } });
  const inputs = inputsOf(e());
  assert.equal(inputs.terms.employmentForm, 'fast'); assert.equal(inputs.terms.employmentType, 'deltid');
  const rd = contractReadinessOf(inputs);
  assert.ok(!rd.missing.some((m) => m.key === 'employmentForm' || m.key === 'employmentBasis' || m.key === 'employmentEndDate'), JSON.stringify(rd.missing));
  const rows = renderContractBlocks(inputs, {}).find((b) => b.n === '02').rows;
  const row = (k) => (rows.find((r) => r[0] === k) || [])[1];
  assert.equal(row('Ansettelsesform'), 'Fast'); assert.equal(row('Stillingsprosent'), '50 %'); assert.equal(row('Evt. sluttdato'), 'Ikke aktuell');
  assert.ok(!rows.some((r) => r[0] === 'Grunnlag for midlertidighet'));
  assert.equal((renderContractBlocks(inputs, {}).find((b) => b.n === '04').rows.find((r) => r[0] === 'Avtalt arbeidstid') || [])[1], '18.75 timer per uke');
  // an unset form is reported missing by name — never filled in from the scope
  const { e: e2 } = testAnsatt01();
  const rd2 = contractReadinessOf(inputsOf(e2()));
  assert.ok(rd2.missing.some((m) => m.key === 'employmentForm' && m.label === 'Ansettelsesform'));
  assert.equal((renderContractBlocks(inputsOf(e2()), {}).find((b) => b.n === '02').rows.find((r) => r[0] === 'Ansettelsesform') || [])[1], 'Ikke registrert');
});
t('A07', 'midlertidig vector: form midlertidig on a deltid/40 % period -> basis + end date become required (existing validation), scope stays independent; once supplied the agreement renders Grunnlag + sluttdato', () => {
  const store = { [T]: {} };
  const c = apply(store, { kind: 'createEmployee', name: 'Test Ansatt 02', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentType: 'deltid', percentage: 40, compensation: { model: 'timelonn', hourlyRate: 200 }, expectedWeeklyHours: 15, noticePeriod: '14 dager' } });
  const r = apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentForm: 'midlertidig' } });
  assert.equal(r.ok, true);
  const e = employeeOf(store, T, c.ansattId);
  assert.equal(e.terms[0].employmentForm, 'midlertidig'); assert.equal(e.terms[0].employmentType, 'deltid'); assert.equal(e.terms[0].percentage, 40);
  const rd = contractReadinessOf(inputsOf(e));
  assert.deepEqual(rd.missing.filter((m) => /employment/.test(m.key)).map((m) => m.key).sort(), ['employmentBasis', 'employmentEndDate']);
  apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentBasis: 'Sesongarbeid', employmentEndDate: '2026-12-31' } });
  const rows = renderContractBlocks(inputsOf(employeeOf(store, T, c.ansattId)), {}).find((b) => b.n === '02').rows;
  const row = (k) => (rows.find((r) => r[0] === k) || [])[1];
  assert.equal(row('Ansettelsesform'), 'Midlertidig'); assert.equal(row('Grunnlag for midlertidighet'), 'Sesongarbeid'); assert.equal(row('Evt. sluttdato'), '31.12.2026'); assert.equal(row('Stillingsprosent'), '40 %');
});
t('A10', 'true later change fast -> midlertidig is a NEW period (appendTerms), never a rewrite: completeCurrentTerms refuses (TERMS_VALUE_ALREADY_SET:employmentForm), period #1 stays byte-identical, the scope carries forward untouched, period #2 is current from its date', () => {
  const { store, id, e } = testAnsatt01();
  apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'fast' } });
  const p1 = snap(e().terms[0]);
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'midlertidig' } }).code, 'TERMS_VALUE_ALREADY_SET:employmentForm');
  assert.deepEqual(snap(e().terms[0]), p1);
  const r = apply(store, { kind: 'appendTerms', ansattId: id, terms: { validFrom: '2026-11-01', employmentForm: 'midlertidig', employmentBasis: 'Vikariat', employmentEndDate: '2027-03-31' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(e().terms.length, 2); assert.deepEqual(snap(e().terms[0]), p1);
  const p2 = e().terms[1];
  assert.equal(p2.validFrom, '2026-11-01'); assert.equal(p2.employmentForm, 'midlertidig'); assert.equal(p2.employmentType, 'deltid'); assert.equal(p2.percentage, 50); assert.equal(p2.expectedWeeklyHours, 18.75);
  assert.equal(currentTermsOf(e(), '2026-10-15').employmentForm, 'fast'); assert.equal(currentTermsOf(e(), '2026-11-15').employmentForm, 'midlertidig');
  assert.equal(apply(store, { kind: 'appendTerms', ansattId: id, terms: { validFrom: '2027-01-01', employmentForm: 'x' } }).code, 'EMPLOYMENTFORM_INVALID');
});
t('A11', 'frozen / superseded safety: a period referenced by a frozen contract version refuses completion (TERMS_PERIOD_FROZEN_IN_CONTRACT); a superseded first period is never touched by later completion; a frozen snapshot keeps its own values', () => {
  const { store, id, e } = testAnsatt01();
  apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'fast', workplace: 'Four Season Gjøvik', workingTimeArrangement: 'dagtid', breaksArrangement: '30', scheduleChangeHandling: '14 dager', probation: '6', paymentInterval: 'manedlig' } });
  apply(store, { kind: 'updateContact', ansattId: id, contact: { address: { street: 'Storgata 1', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1990-01-01' } });
  const cOps = (op) => applyContractOperation({ store, tenantId: T, actor: ACTOR, op, profile: PROFILE, now: NOW, onDate: TODAY, roleLabels: ROLE_LABELS });
  assert.equal(cOps({ kind: 'startDraft', ansattId: id }).ok, true);
  const fz = cOps({ kind: 'freezeVersion', ansattId: id });
  assert.equal(fz.ok, true, JSON.stringify(fz));
  assert.equal(fz.version.snapshot.terms.employmentForm, 'fast'); assert.equal(fz.version.snapshot.terms.employmentType, 'deltid');
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentBasis: 'x' } }).code, 'TERMS_PERIOD_FROZEN_IN_CONTRACT');
  const p1 = snap(e().terms[0]);
  assert.equal(apply(store, { kind: 'appendTerms', ansattId: id, terms: { validFrom: '2026-11-01', employmentForm: 'midlertidig', employmentBasis: 'Vikariat', employmentEndDate: '2027-03-31' } }).ok, true);
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { probation: 'Ingen' } }).code, 'TERMS_VALUE_ALREADY_SET:probation');   // latest period only; #1 untouched
  assert.deepEqual(snap(e().terms[0]), p1);
  assert.equal(renderContractBlocks(fz.version.snapshot, { frozen: true, frozenAt: NOW }).find((b) => b.n === '02').rows.find((r) => r[0] === 'Ansettelsesform')[1], 'Fast');
});
t('ADAPTER', 'persistence: employmentForm is read back from e360.terms (missing key -> null, never derived from employmentType) and written with the period; a legacy-only document stays null; the adapter forwards the core refusal code with the CORE_REFUSED rejection', () => {
  const withForm = normalizeAnsatt('a1', { navn: 'X', [E360_KEY]: { status: 'active', startDate: '2026-08-01', terms: [{ validFrom: '2026-08-01', role: 'r', employmentType: 'deltid', employmentForm: 'fast', percentage: 50 }], documents: [], contractVersions: [], rev: 2 } });
  assert.equal(withForm.terms[0].employmentForm, 'fast'); assert.equal(withForm.terms[0].employmentType, 'deltid');
  const preSeparation = normalizeAnsatt('a2', { navn: 'Y', [E360_KEY]: { status: 'active', startDate: '2026-08-01', terms: [{ validFrom: '2026-08-01', role: 'r', employmentType: 'fast', percentage: 100 }], documents: [], contractVersions: [], rev: 2 } });
  assert.equal(preSeparation.terms[0].employmentForm, null, 'a legacy scope value "fast" is NOT copied into the form field'); assert.equal(preSeparation.terms[0].employmentType, 'fast');
  const legacy = normalizeAnsatt('a3', { navn: 'Z', stilling: 'kasse', timelonn: 200, opprettet: '2026-01-05T08:00:00.000Z' });
  assert.equal(legacy.terms[0].employmentForm, null); assert.ok('employmentForm' in legacy.terms[0]);
  const { store, id, e } = testAnsatt01();
  apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { employmentForm: 'fast' } });
  const w = ansattWriteFor('completeCurrentTerms', e(), { [E360_KEY]: { rev: 4 } }, NOW, TODAY);
  assert.equal(w[E360_KEY].terms[0].employmentForm, 'fast'); assert.equal(w[E360_KEY].terms[0].employmentType, 'deltid'); assert.equal(w[E360_KEY].rev, 5); assert.equal(w.timelonn, 210); assert.equal(w[E360_KEY].startDate, '2026-08-01');
  const src = fs.readFileSync(new URL('./management-production-adapters.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("if (!res.ok) { const err = adapterError(ADAPTER_ERROR.CORE_REFUSED, res.code); err.coreResult = res; throw err; }"), 'applyEmployee attaches coreResult');
  assert.ok(src.includes("'paymentInterval', 'employmentForm']"), 'TERMS_KEYS persists employmentForm');
});
t('VIEW-LAW', 'management-employees-view.mjs: Step 2 binds Ansettelsesform to employmentForm (never employmentType), temporary-only fields toggle on midlertidig and are not sent for fast; Arbeidsforhold shows both facts; Ny periode carries an Ansettelsesform select; index.html untouched by this law', () => {
  const v = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  assert.ok(v.includes("const type = selectInput(formOptions('Velg …'), cur && cur.employmentForm ? cur.employmentForm : '');"));
  assert.ok(!v.includes("EMPLOYMENT_TYPES.map((x) => ({ value: x, label: x }))), cur && cur.employmentType ? cur.employmentType : '');\n      const basis"), 'Step 2 no longer initialises Ansettelsesform from the scope');
  assert.ok(v.includes("employmentForm: () => type.value, employmentBasis: () => (type.value === 'midlertidig' ? basis.value.trim() : ''), employmentEndDate: () => (type.value === 'midlertidig' ? endD.value : ''),"));
  assert.ok(v.includes("const syncTemp = () => { const on = type.value === 'midlertidig';"));
  assert.ok(v.includes("card.appendChild(factRow('Ansettelsesform', formLabel(cur.employmentForm)));") && v.includes("card.appendChild(factRow('Stillingstype', cur.employmentType || 'Ikke registrert'));"));
  assert.ok(v.includes("form.appendChild(field('Ansettelsesform', formSel));") && v.includes("terms.employmentForm = formSel.value || null;"));
  assert.ok(v.includes("if (code === 'EMPLOYMENTFORM_INVALID') return 'Ugyldig ansettelsesform.';"));
  assert.ok(!v.includes('employmentType: () => type.value'), 'Step 2 never writes the scope field');
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('employmentForm'), 'host page untouched');
});

console.log(lines.join('\n'));
console.log('MANAGEMENT_ANSETTELSESFORM_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
