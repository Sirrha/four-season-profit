// management-contract-core.test.mjs
// CONTRACT FOUNDATION INCREMENT 1 — deterministic tests. Node built-ins only; dates INJECTED.
// Run: node management-contract-core.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTRACT_STATUS, FUTURE_CONTRACT_STATUS, CONTRACT_KINDS, TEMPLATE_FIELDS, FUTURE_SECURE_FIELDS,
  SIGNING_ADAPTER_CONTRACT, contractInputsFor, contractReadinessOf, renderContractBlocks,
  contractVersionsOf, latestContractVersion, draftVersionOf, contractStateOf,
  applyContractOperation, blocksForVersion, applyCompanyContractOperation,
} from './management-contract-core.mjs';
import {
  seedFourSeasonEmployees, employeeOf, applyEmployeeOperation, currentTermsOf, startDateOf,
  TERMS_FIELDS, normalizeAddress, addressIsComplete, formatAddress, missingInfoOf,
} from './management-employees-core.mjs';
import { FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MANAGER_ACTOR, FOUR_SEASON_CONTRACT_PROFILE, ROLE_LABELS } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const T = FOUR_SEASON_TENANT.tenantId;
const MGR = FOUR_SEASON_MANAGER_ACTOR;
// REAL profile ships with UNCONFIRMED (null) company facts — the reachable app cannot freeze
// until Herish confirms them (V7 proves that). Freeze-machinery tests use a TEST-CONFIRMED
// overlay so the proven freeze/versioning semantics stay exercised end to end.
const REAL_PROFILE = FOUR_SEASON_CONTRACT_PROFILE;
const PROFILE = Object.freeze(Object.assign({}, FOUR_SEASON_CONTRACT_PROFILE, {
  companyFacts: Object.freeze({
    salaryPaymentArrangement: 'TEST-BEKREFTET utbetalingsordning',
    pension: Object.freeze({ applies: true, provider: 'TEST-BEKREFTET pensjonsleverandør' }),
    occupationalInjuryInsurance: Object.freeze({ applies: true, insurer: 'TEST-BEKREFTET forsikringsselskap' }),
    tariffavtale: Object.freeze({ applies: false, agreementName: null, parties: null }),
  }),
}));
const TODAY = '2026-08-31';
const AFTER_START = '2026-09-02';   // new fixture employees start 2026-09-01; query on/after that
const NOW = 1756600000000;
const seedE = () => seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
const applyE = (store, op, over) => applyEmployeeOperation(Object.assign({ store, tenantId: T, actor: MGR, op, now: NOW }, over || {}));
const applyC = (store, op, over) => applyContractOperation(Object.assign({ store, tenantId: T, actor: MGR, op, profile: PROFILE, now: NOW, onDate: TODAY, roleLabels: ROLE_LABELS }, over || {}));
const inputsOf = (emp) => contractInputsFor({ employee: emp, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS });

// A fully specified employee: quick-create, then complete the blanks of the initial period.
function readyEmployee(store, name) {
  const c = applyE(store, { kind: 'createEmployee', name: name || 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  applyE(store, { kind: 'updateContact', ansattId: c.ansattId, contact: { address: { street: 'Storgata 99', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1995-03-15' } });
  applyE(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: {
    workplace: 'Four Season Gjøvik', employmentType: 'fast', percentage: 60,
    workingTimeArrangement: 'Dagtid og kveld etter vaktplan', expectedWeeklyHours: 22.5,
    breaksArrangement: '30 minutter ubetalt pause per vakt over 5,5 timer',
    scheduleChangeHandling: 'Vaktplan varsles minst 14 dager før perioden starter',
    probation: '6 måneder', noticePeriod: '1 måned', paymentInterval: 'manedlig',
    compensation: { model: 'timelonn', hourlyRate: 230 },
  } });
  return employeeOf(store, T, c.ansattId);
}

t('K1', 'three-field creation is unchanged and contract continuation is optional (no contract version)', () => {
  const store = seedE();
  const r = applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  assert.equal(r.ok, true, r.code);
  const emp = employeeOf(store, T, r.ansattId);
  assert.deepEqual(contractVersionsOf(emp), []);                       // creation never starts a contract
  assert.equal(contractStateOf(emp).state, 'mangler');
  assert.equal(contractStateOf(emp).label, 'Mangler arbeidsavtale');
});
t('K2', 'employee exists BEFORE the contract flow; abandoning the draft never undoes creation', () => {
  const store = seedE();
  const r = applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  const emp = employeeOf(store, T, r.ansattId);
  assert.equal(applyC(store, { kind: 'startDraft', ansattId: emp.ansattId }).ok, true);
  assert.equal(contractStateOf(emp).state, 'utkast');
  assert.equal(applyC(store, { kind: 'discardDraft', ansattId: emp.ansattId }).ok, true);
  assert.ok(employeeOf(store, T, emp.ansattId));                        // employee survives
  assert.equal(contractStateOf(emp).state, 'mangler');
  assert.equal(emp.terms.length, 1);
});
t('K3', 'draft is resumable: it persists in the employee store between sittings', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  assert.equal(applyC(store, { kind: 'startDraft', ansattId: emp.ansattId }).ok, true);
  const again = employeeOf(store, T, emp.ansattId);                     // simulate reopening
  const draft = draftVersionOf(again);
  assert.ok(draft); assert.equal(draft.status, CONTRACT_STATUS.DRAFT);
  assert.equal(latestContractVersion(again).contractVersionId, draft.contractVersionId);
  assert.equal(applyC(store, { kind: 'startDraft', ansattId: emp.ansattId }).code, 'DRAFT_EXISTS');
});
t('K4', 'readiness is DERIVED (never stored) and counts down as canonical facts are filled', () => {
  const store = seedE();
  const c = applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  const emp = employeeOf(store, T, c.ansattId);
  const before = contractReadinessOf(inputsOf(emp));
  assert.equal(before.ready, false);
  assert.ok(before.missing.length > 5);
  assert.ok(before.missing.some((m) => m.key === 'compensation'));
  applyE(store, { kind: 'completeCurrentTerms', ansattId: emp.ansattId, terms: { compensation: { model: 'timelonn', hourlyRate: 230 }, percentage: 60 } });
  const mid = contractReadinessOf(inputsOf(emp));
  assert.equal(mid.missing.length, before.missing.length - 2);          // counted down, nothing stored
  assert.ok(!mid.missing.some((m) => m.key === 'compensation'));
  for (const v of contractVersionsOf(emp)) assert.ok(!('ready' in v) && !('complete' in v) && !('missing' in v));
});
t('K5', 'canonical facts are NOT duplicated into contract draft storage', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const draft = draftVersionOf(emp);
  const json = JSON.stringify(draft);
  for (const k of ['role', 'percentage', 'compensation', 'workplace', 'hourlyRate', 'noticePeriod', 'probation']) {
    assert.ok(!json.includes('"' + k + '"'), 'draft must not store ' + k);
  }
  assert.equal(draft.snapshot, null);                                   // snapshot only exists at freeze
});
t('K6', 'existing equivalent terms fields stay the one truth (no parallel contract fields added)', () => {
  for (const f of ['workingTimeArrangement', 'probation', 'noticePeriod', 'workplace']) assert.ok(TERMS_FIELDS.includes(f));
  for (const f of ['noticeTermsRef', 'probationObject', 'contractWorkplace']) assert.ok(!TERMS_FIELDS.includes(f));
  // genuinely missing contract facts were added to TERMS (their canonical home), not to a contract object
  for (const f of ['breaksArrangement', 'scheduleChangeHandling', 'employmentBasis', 'employmentEndDate', 'paymentInterval']) assert.ok(TERMS_FIELDS.includes(f));
  // workplace lives in terms, never on the employee record (Sirrha C2)
  const store = seedE();
  const emp = employeeOf(store, T, 'ans-maria');
  assert.ok(!('workplace' in emp));
  assert.equal(currentTermsOf(emp, TODAY).workplace, 'Four Season');
});
t('K7', 'freeze requires template readiness; an incomplete draft fails closed and stays a draft', () => {
  const store = seedE();
  const c = applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  const emp = employeeOf(store, T, c.ansattId);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const r = applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  assert.equal(r.ok, false); assert.equal(r.code, 'NOT_READY');
  assert.ok(r.missing.length > 0);
  assert.equal(draftVersionOf(emp).status, CONTRACT_STATUS.DRAFT);
});
t('K8', 'ACCEPTANCE INVARIANT: freeze v1, then change employment terms/role — frozen v1 does not move', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const f = applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  assert.equal(f.ok, true, f.code);
  const frozen = latestContractVersion(emp);
  const beforeJson = JSON.stringify(frozen);
  const beforeBlocks = JSON.stringify(blocksForVersion(frozen, { employee: emp, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS }));
  // later employment change: new role, new percentage, new compensation, later period
  const a = applyE(store, { kind: 'appendTerms', ansattId: emp.ansattId, terms: { validFrom: '2026-12-01', role: 'butikksjef', percentage: 100, compensation: { model: 'fastlonn', monthlySalary: 51000 } } });
  assert.equal(a.ok, true, a.code);
  assert.equal(currentTermsOf(emp, '2026-12-02').role, 'butikksjef');   // live truth moved
  const after = latestContractVersion(emp);
  assert.equal(JSON.stringify(after), beforeJson);                       // frozen version byte-stable
  assert.equal(after.snapshot.terms.role, 'butikkmedarbeider');
  assert.equal(after.snapshot.terms.percentage, 60);
  assert.deepEqual(after.snapshot.terms.compensation, { model: 'timelonn', hourlyRate: 230 });
  const afterBlocks = JSON.stringify(blocksForVersion(after, { employee: emp, profile: PROFILE, onDate: '2026-12-02', roleLabels: ROLE_LABELS }));
  assert.equal(afterBlocks, beforeBlocks);                               // rendering unchanged too
});
t('K9', 'frozen rendering uses the SNAPSHOT, not live references (snapshot is deep-copied and frozen)', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  const v = latestContractVersion(emp);
  assert.ok(Object.isFrozen(v)); assert.ok(Object.isFrozen(v.snapshot));
  const live = currentTermsOf(emp, AFTER_START);
  assert.notEqual(v.snapshot.terms.compensation, live.compensation);     // copied by value, not shared
  assert.equal(v.termsPeriodRef, startDateOf(emp));                      // provenance recorded
  const blocks = blocksForVersion(v, { employee: emp, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS });
  assert.ok(blocks.some((b) => b.kind === 'note' && b.text.includes('Ikke elektronisk signert')));
  assert.ok(!blocks.some((b) => b.kind === 'note' && b.text.includes('UTKAST')));
});
t('K10', 'terms periods referenced by a frozen contract can no longer be completed (fail closed)', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  const r = applyE(store, { kind: 'completeCurrentTerms', ansattId: emp.ansattId, terms: { noticePeriod: '3 måneder' } });
  assert.equal(r.ok, false); assert.equal(r.code, 'TERMS_PERIOD_FROZEN_IN_CONTRACT');
  assert.equal(currentTermsOf(emp, AFTER_START).noticePeriod, '1 måned');
});
t('K11', 'completeCurrentTerms fills BLANKS only; overwriting an existing value requires a new period', () => {
  const store = seedE();
  const c = applyE(store, { kind: 'createEmployee', name: 'Nora', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  const emp = employeeOf(store, T, c.ansattId);
  assert.equal(applyE(store, { kind: 'completeCurrentTerms', ansattId: emp.ansattId, terms: { percentage: 60 } }).ok, true);
  assert.equal(emp.terms.length, 1);                                     // same period, not a second one
  const r = applyE(store, { kind: 'completeCurrentTerms', ansattId: emp.ansattId, terms: { percentage: 80 } });
  assert.equal(r.ok, false); assert.equal(r.code, 'TERMS_VALUE_ALREADY_SET:percentage');
  assert.equal(currentTermsOf(emp, AFTER_START).percentage, 60);
  assert.equal(applyE(store, { kind: 'completeCurrentTerms', ansattId: emp.ansattId, terms: { fodselsnummer: 'x' } }).code, 'TERMS_FIELD_NOT_ALLOWED:fodselsnummer');
});
t('K12', 'midlertidig employment requires basis + end date; fast does not', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  const readyFast = contractReadinessOf(inputsOf(emp));
  assert.equal(readyFast.ready, true);
  const store2 = seedE();
  const c = applyE(store2, { kind: 'createEmployee', name: 'Tim', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  applyE(store2, { kind: 'updateContact', ansattId: c.ansattId, contact: { address: { street: 'Storgata 99', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1998-07-01' } });
  applyE(store2, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: {
    workplace: 'Four Season Gjøvik', employmentType: 'midlertidig', percentage: 40,
    workingTimeArrangement: 'Kveld', expectedWeeklyHours: 15, breaksArrangement: '30 min',
    scheduleChangeHandling: '14 dager', probation: 'Ingen', noticePeriod: '14 dager',
    paymentInterval: 'manedlig', compensation: { model: 'timelonn', hourlyRate: 210 },
  } });
  const emp2 = employeeOf(store2, T, c.ansattId);
  const r = contractReadinessOf(inputsOf(emp2));
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing.map((m) => m.key).sort(), ['employmentBasis', 'employmentEndDate']);
});
t('K13', 'readiness wording is a TEMPLATE fact, never a legal-completeness or signature claim', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  const r = contractReadinessOf(inputsOf(emp));
  assert.ok(r.label.includes('Alle malfelter utfylt'));
  assert.ok(r.label.includes('klar for gjennomgang'));
  const label = r.label.toLowerCase();
  for (const bad of ['juridisk fullstendig', 'lovlig', 'compliant', 'signert', 'ansettelse klar']) assert.ok(!label.includes(bad), 'overclaim in label: ' + bad);
  assert.ok(r.note.includes('ikke en juridisk fullstendighetsvurdering'));   // explicit disclaimer, not a claim
});
t('K14', 'NO local operation can claim sent/signed/cancelled; signing metadata stays empty', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  for (const kind of ['sendForSigning', 'markSigned', 'cancelSigning', 'sign']) {
    assert.equal(applyC(store, { kind, ansattId: emp.ansattId }).code, 'UNKNOWN_OPERATION');
  }
  for (const v of contractVersionsOf(emp)) {
    assert.ok(v.status === CONTRACT_STATUS.DRAFT || v.status === CONTRACT_STATUS.FROZEN);
    assert.equal(v.signedArtifactMeta, null);
    assert.equal(v.signingTransaction, null);
  }
  const states = Object.values(FUTURE_CONTRACT_STATUS);
  const json = JSON.stringify(contractVersionsOf(emp));
  for (const s of states) assert.ok(!json.includes(s), 'unreachable state leaked: ' + s);
  for (const k of Object.keys(SIGNING_ADAPTER_CONTRACT)) assert.equal(SIGNING_ADAPTER_CONTRACT[k], 'not-implemented-in-v1');
});
t('K15', 'preview: draft is watermarked UTKAST, both note BankID is coming, neither claims signature', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  const draftBlocks = renderContractBlocks(inputsOf(emp), { frozen: false });
  assert.ok(draftBlocks.some((b) => b.kind === 'note' && b.text === 'UTKAST — ikke signert'));
  assert.ok(draftBlocks.some((b) => b.text && b.text.includes('Elektronisk signering med BankID kommer.')));
  assert.ok(draftBlocks.some((b) => b.text && b.text.includes('Ikke juridisk kvalitetssikret')));
  const flat = JSON.stringify(draftBlocks).toLowerCase();
  for (const bad of ['send til signering', 'signer nå', 'signert av']) assert.ok(!flat.includes(bad));
});
t('K16', 'no sensitive identifier is collected, rendered or placeheld anywhere (C1)', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  const blob = (JSON.stringify(store) + JSON.stringify(renderContractBlocks(inputsOf(emp), {})) + JSON.stringify(PROFILE)).toLowerCase();
  for (const bad of ['fødselsnummer', 'fodselsnummer', 'personnummer', 'bankkonto', 'kontonummer', 'skattekort', 'pårørende', 'fylles ut ved signering']) {
    assert.ok(!blob.includes(bad), 'forbidden content: ' + bad);
  }
  for (const f of FUTURE_SECURE_FIELDS) { assert.equal(f.secure, true); assert.equal(f.collectible, false); }
  assert.ok(!TEMPLATE_FIELDS.some((f) => FUTURE_SECURE_FIELDS.some((s) => s.key === f.key)));
});
t('K17', 'tenant contract profile is tenant config carrying the REAL Four Season identity', () => {
  assert.equal(REAL_PROFILE.tenantId, T);
  assert.equal(REAL_PROFILE.templateVersion, 'fs-ansettelsesavtale-v2');
  assert.equal(REAL_PROFILE.employer.name, 'Four Season AS');
  assert.equal(REAL_PROFILE.employer.orgnr, '919430036');               // digit-normalized storage
  assert.equal(REAL_PROFILE.employer.address, 'Storgata 20, 2815 Gjøvik');
  assert.equal(REAL_PROFILE.employer.nearestSuperior, 'Butikksjef');
  assert.equal(REAL_PROFILE.companyFacts.tariffavtale.applies, false);   // established Four Season fact: Nei
  assert.equal(REAL_PROFILE.representative.name, 'Herish Hashemi');     // preserved, not reinvented
  assert.ok(REAL_PROFILE.clauses.length >= 10);
  for (const c of REAL_PROFILE.clauses) { assert.ok(c.key && c.title && c.text && Number.isFinite(c.version)); }
  const inputs = inputsOf(seedE()[T]['ans-maria']);
  assert.equal(inputs.templateVersion, PROFILE.templateVersion);
  assert.equal(inputs.clauses.length, PROFILE.clauses.length);          // renderer consumes profile, not literals
});
t('K18', 'contract versions are append-only; a second version supersedes and is an endringsavtale', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const v1 = applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId }).version;
  applyE(store, { kind: 'appendTerms', ansattId: emp.ansattId, terms: { validFrom: '2026-12-01', role: 'butikksjef' } });
  const d2 = applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  assert.equal(d2.ok, true, d2.code);
  assert.equal(d2.version.kind, CONTRACT_KINDS.AMENDMENT);
  assert.equal(applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId, }, { onDate: '2026-12-02' }).ok, true);
  const all = contractVersionsOf(emp);
  assert.equal(all.length, 2);
  assert.equal(all[0].contractVersionId, v1.contractVersionId);
  assert.equal(all[0].snapshot.terms.role, 'butikkmedarbeider');        // v1 still untouched
  assert.equal(all[1].supersedes, v1.contractVersionId);
  assert.equal(all[1].snapshot.terms.role, 'butikksjef');
  assert.equal(all[1].kind, CONTRACT_KINDS.AMENDMENT);
});
t('K19', 'capability-shaped and tenant-scoped: unauthorized actor / unknown tenant fail closed', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  assert.equal(applyC(store, { kind: 'startDraft', ansattId: emp.ansattId }, { actor: { accessEnabled: true } }).code, 'NOT_AUTHORIZED');
  assert.equal(applyC(store, { kind: 'startDraft', ansattId: emp.ansattId }, { tenantId: 'tenant-x' }).code, 'TENANT_UNKNOWN');
  assert.equal(applyC(store, { kind: 'startDraft', ansattId: 'ans-nobody' }).code, 'EMPLOYEE_UNKNOWN');
  assert.deepEqual(contractVersionsOf(emp), []);
});
t('K20', 'generic document metadata stays metadata-only and separate from contract versions', () => {
  const store = seedE();
  const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  assert.equal(applyE(store, { kind: 'addDocument', ansattId: emp.ansattId, doc: { name: 'x', category: 'kontrakt', url: 'http://x' } }).code, 'DOC_FIELD_NOT_ALLOWED:url');
  assert.equal(applyE(store, { kind: 'addDocument', ansattId: emp.ansattId, doc: { name: 'x', category: 'kontrakt', file: 'blob' } }).code, 'DOC_FIELD_NOT_ALLOWED:file');
  const json = JSON.stringify(contractVersionsOf(emp));
  for (const bad of ['"file"', '"url"', '"blob"', 'storageRef', 'base64']) assert.ok(!json.includes(bad));
  assert.ok(Array.isArray(emp.documents) && Array.isArray(emp.contractVersions));   // coherent, separate
});

// ---- FOUR SEASON TEMPLATE REFINEMENT (Ansettelsesavtale v2) — release proofs V1–V10 --------
const realInputsOf = (emp) => contractInputsFor({ employee: emp, profile: REAL_PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS });
const flatOf = (blocks) => JSON.stringify(blocks);

t('V1', 'reachable preview carries the real Four Season identity', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const flat = flatOf(renderContractBlocks(realInputsOf(emp), {}));
  assert.ok(flat.includes('Four Season AS'));
  assert.ok(flat.includes('919 430 036'));                               // displayed with readable spacing
  assert.ok(flat.includes('Storgata 20, 2815 Gjøvik'));
  assert.ok(flat.includes('Butikksjef'));
});
t('V2', 'no reachable preview, profile or field manifest carries the old synthetic placeholders', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const blob = flatOf(renderContractBlocks(realInputsOf(emp), {})) + JSON.stringify(REAL_PROFILE) + JSON.stringify(TEMPLATE_FIELDS);
  assert.ok(!blob.includes('LOKAL-TEST'));
  assert.ok(!blob.includes('lokal testadresse'));
});
t('V3', 'rejected literal "Forventede timer per uke" is gone; Avtalt arbeidstid reuses the canonical fact', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const flat = flatOf(renderContractBlocks(realInputsOf(emp), {}));
  assert.ok(!flat.includes('Forventede timer per uke'));
  assert.ok(flat.includes('Avtalt arbeidstid'));
  assert.ok(flat.includes('22.5 timer per uke'));                        // same expectedWeeklyHours truth, explicit unit
  assert.ok(!JSON.stringify(TEMPLATE_FIELDS).includes('Forventede timer per uke'));
  const viewSrc = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  assert.ok(!viewSrc.includes('Forventede timer per uke'));
  assert.ok(viewSrc.includes('Avtalt arbeidstid'));
});
t('V4', 'generated agreement follows the sealed v2 Four Season structure with human units', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const blocks = renderContractBlocks(realInputsOf(emp), {});
  assert.equal(blocks.find((b) => b.kind === 'docHeader').title, 'ANSETTELSESAVTALE');
  const secs = blocks.filter((b) => b.kind === 'numbered').map((b) => b.n + ' ' + b.title);
  assert.deepEqual(secs, [
    '01 Partene', '02 Ansettelsesforholdet', '03 Arbeidsoppgaver', '04 Arbeidstid og arbeidsplan',
    '05 Prøvetid', '06 Lønn og godtgjørelser', '07 Ferie og feriepenger', '08 Oppsigelse',
    '09 Opplæring og kompetanseutvikling', '10 Pensjon, forsikringer og andre sosiale ytelser',
    '11 Tariffavtale', '12 Taushetsplikt', '13 Avtalens dokumenter og endringer', '14 Godkjenning og underskrift',
  ]);
  assert.ok(blocks.some((b) => b.kind === 'parties'));
  assert.ok(blocks.some((b) => b.kind === 'pageBreak'));                  // two-page composition
  assert.ok(blocks.some((b) => b.kind === 'signatures'));
  assert.ok(blocks.some((b) => b.kind === 'docFooter'));
  assert.equal(blocks.find((b) => b.kind === 'numbered' && b.n === '11').rows[0][1], 'Nei');
  assert.equal(blocks.find((b) => b.kind === 'numbered' && b.n === '05').rows[0][1], '6 måneder');
  assert.equal(blocks.find((b) => b.kind === 'numbered' && b.n === '08').rows[0][1], '1 måned');
});
t('V5', 'no sensitive identifier or emergency-contact content in generated contract or draft storage', () => {
  const store = seedE(); const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  const blob = (JSON.stringify(store) + flatOf(renderContractBlocks(realInputsOf(emp), {})) + JSON.stringify(REAL_PROFILE)).toLowerCase();
  for (const bad of ['fødselsnummer', 'fodselsnummer', 'personnummer', 'bankkonto', 'kontonummer', 'skattekort', 'emergencycontact', 'pårørende']) {
    assert.ok(!blob.includes(bad), 'forbidden content: ' + bad);
  }
});
t('V6', 'signature areas are visual data only — no signing action/control, no reachable sent/signed state', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const blocks = renderContractBlocks(realInputsOf(emp), {});
  const sig = blocks.find((b) => b.kind === 'signatures');
  assert.deepEqual(Object.keys(sig).sort(), ['date', 'kind', 'left', 'place', 'right']);
  const flat = flatOf(blocks).toLowerCase();
  for (const bad of ['send til signering', 'signer nå', 'signert av', 'bankid-knapp']) assert.ok(!flat.includes(bad));
  assert.ok(flat.includes('elektronisk signering med bankid kommer'));
  for (const kind of ['sendForSigning', 'markSigned', 'cancelSigning']) {
    assert.equal(applyC(store, { kind, ansattId: emp.ansattId }).code, 'UNKNOWN_OPERATION');
  }
});
t('V7', 'unconfirmed company facts are never invented: they block readiness/freeze and render honestly', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const r = contractReadinessOf(realInputsOf(emp));
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing.map((m) => m.key).sort(), ['occupationalInjuryInsurance', 'pensionArrangement', 'salaryPaymentArrangement']);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const f = applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId }, { profile: REAL_PROFILE });
  assert.equal(f.ok, false); assert.equal(f.code, 'NOT_READY');           // fail closed
  const flat = flatOf(renderContractBlocks(realInputsOf(emp), {}));       // draft still previews, with honest markers
  assert.ok(flat.toLowerCase().includes('ikke bekreftet'));               // 'Ja – leverandør ikke bekreftet' etc.
  assert.ok(!flat.includes('null'));                                      // never a raw invented/empty value
});
t('V8', 'frozen version renders byte-stable from its own snapshot even after profile/template changes', () => {
  const store = seedE(); const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  const v = latestContractVersion(emp);
  const before = JSON.stringify(blocksForVersion(v, { employee: emp, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS }));
  const mutated = Object.assign({}, PROFILE, { templateVersion: 'x-later', employer: { name: 'Annet Selskap AS', orgnr: '000000000', address: 'Annen gate 1' }, clauses: [] });
  const after = JSON.stringify(blocksForVersion(v, { employee: emp, profile: mutated, onDate: '2027-01-01', roleLabels: ROLE_LABELS }));
  assert.equal(after, before);                                            // profile never re-dereferenced after freeze
  assert.ok(before.includes('Four Season AS'));
  assert.ok(!before.includes('Annet Selskap'));
});
t('V9', 'logo asset is the exact sealed Four Season file and the preview references it', () => {
  const buf = fs.readFileSync(new URL('./four-season-logo.gif', import.meta.url));
  assert.equal(buf.length, 32071);                                        // exact sealed byte size
  assert.equal(buf.slice(0, 6).toString('latin1'), 'GIF89a');
  assert.equal(buf[buf.length - 1], 0x3B);                                // intact trailer — not a recreation
  const viewSrc = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  assert.ok(viewSrc.includes('four-season-logo.gif'));
});
t('V10', 'draft keeps UTKAST watermark, badge and the template-readiness disclaimer', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const blocks = renderContractBlocks(realInputsOf(emp), { frozen: false });
  assert.ok(blocks.some((b) => b.kind === 'note' && b.text === 'UTKAST — ikke signert'));
  assert.equal(blocks.find((b) => b.kind === 'docHeader').badge, 'UTKAST – IKKE SIGNERT');
  assert.ok(blocks.some((b) => b.kind === 'note' && b.text.includes('Ikke juridisk kvalitetssikret')));
  assert.ok(contractReadinessOf(realInputsOf(emp)).note.includes('ikke en juridisk fullstendighetsvurdering'));
});

// ---- EMPLOYEE IDENTITY + COMPANY FACTS REFINEMENT — release proofs W1–W9 -------------------
// Runtime-editable company profile = ONE truth: a mutable deep copy of the seed (the frozen
// fixture seed itself refuses edits, proven in W5).
const mutableProfile = (base) => JSON.parse(JSON.stringify(base || REAL_PROFILE));

t('W1', 'address is canonical employee truth; renderer reuses it; no contract-side duplicate', () => {
  const store = seedE(); const emp = readyEmployee(store);
  assert.deepEqual(emp.contact.address, { street: 'Storgata 99', postalCode: '2815', city: 'Gjøvik' });  // ONE structured canonical truth
  assert.ok(flatOf(renderContractBlocks(realInputsOf(emp), {})).includes('Storgata 99, 2815 Gjøvik'));
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  assert.ok(!JSON.stringify(draftVersionOf(emp)).includes('"address"')); // draft stores no second address truth
  applyE(store, { kind: 'updateContact', ansattId: emp.ansattId, contact: { address: { street: 'Nyveien 2', postalCode: '2815', city: 'Gjøvik' } } });
  assert.ok(flatOf(renderContractBlocks(realInputsOf(emp), {})).includes('Nyveien 2, 2815 Gjøvik'));  // live canonical read
});
t('W2', 'birth date is canonical and renders DD.MM.YYYY; invalid dates fail closed', () => {
  const store = seedE(); const emp = readyEmployee(store);
  assert.equal(emp.contact.birthDate, '1995-03-15');
  assert.ok(flatOf(renderContractBlocks(realInputsOf(emp), {})).includes('15.03.1995'));
  assert.equal(applyE(store, { kind: 'updateContact', ansattId: emp.ansattId, contact: { birthDate: '15.03.1995' } }).code, 'BIRTHDATE_INVALID');
});
t('W3', 'sensitive fields stay design-only: no acceptance, no persistence, no render, no readiness', () => {
  const store = seedE(); const emp = readyEmployee(store);
  for (const bad of ['nationalIdentityNumber', 'bankAccountNumber', 'fodselsnummer', 'kontonummer']) {
    assert.equal(applyE(store, { kind: 'updateContact', ansattId: emp.ansattId, contact: { [bad]: 'x' } }).code, 'CONTACT_FIELD_NOT_ALLOWED:' + bad);
  }
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  const blob = JSON.stringify(store) + flatOf(blocksForVersion(latestContractVersion(emp), { employee: emp, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS }));
  for (const bad of ['nationalIdentityNumber', 'bankAccountNumber', 'fødselsnummer', 'kontonummer', 'personnummer']) {
    assert.ok(!blob.toLowerCase().includes(bad.toLowerCase()), 'sensitive leak: ' + bad);
  }
  assert.ok(!TEMPLATE_FIELDS.some((f) => f.key === 'nationalIdentityNumber' || f.key === 'bankAccountNumber'));  // never a readiness requirement
});
t('W4', 'numeric break renders as human minutes; meaningful free text stays untouched', () => {
  const store = seedE();
  const c = applyE(store, { kind: 'createEmployee', name: 'Pia', startDate: '2026-09-01', role: 'butikkmedarbeider' });
  applyE(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { breaksArrangement: '30' } });
  const rows = renderContractBlocks(realInputsOf(employeeOf(store, T, c.ansattId)), {}).find((b) => b.kind === 'numbered' && b.n === '04').rows;
  assert.equal(rows.find((r) => r[0] === 'Pause')[1], '30 minutter');
  const emp2 = readyEmployee(seedE());                                    // stored meaningful free text
  const rows2 = renderContractBlocks(realInputsOf(emp2), {}).find((b) => b.kind === 'numbered' && b.n === '04').rows;
  assert.equal(rows2.find((r) => r[0] === 'Pause')[1], '30 minutter ubetalt pause per vakt over 5,5 timer');
});
t('W5', 'pension is structured company truth: Ja requires provider; renders professionally; seed refuses edits', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const p = mutableProfile();                                             // pension: Ja, provider unconfirmed
  const inputs = () => contractInputsFor({ employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS });
  assert.ok(contractReadinessOf(inputs()).missing.some((m) => m.key === 'pensionArrangement'));
  assert.ok(flatOf(renderContractBlocks(inputs(), {})).includes('Ja – leverandør ikke bekreftet'));
  assert.equal(applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setPension', applies: true, provider: 'Testleverandør Pensjon' } }).ok, true);
  assert.ok(!contractReadinessOf(inputs()).missing.some((m) => m.key === 'pensionArrangement'));
  assert.ok(flatOf(renderContractBlocks(inputs(), {})).includes('Pensjonsordning'));
  assert.ok(flatOf(renderContractBlocks(inputs(), {})).includes('Ja – Testleverandør Pensjon'));
  assert.equal(applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setPension', applies: 'ja' } }).code, 'APPLIES_INVALID');
  assert.equal(applyCompanyContractOperation({ profile: p, actor: { accessEnabled: true }, op: { kind: 'setPension', applies: true } }).code, 'NOT_AUTHORIZED');
  assert.equal(applyCompanyContractOperation({ profile: REAL_PROFILE, actor: MGR, op: { kind: 'setPension', applies: true } }).code, 'PROFILE_FROZEN');
});
t('W6', 'occupational-injury insurance uses the explicit label Yrkesskadeforsikring with Ja+insurer semantics', () => {
  assert.equal(TEMPLATE_FIELDS.find((f) => f.key === 'occupationalInjuryInsurance').label, 'Yrkesskadeforsikring');
  assert.ok(!TEMPLATE_FIELDS.some((f) => f.key === 'insuranceArrangement'));
  const store = seedE(); const emp = readyEmployee(store);
  const p = mutableProfile();
  const inputs = () => contractInputsFor({ employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS });
  assert.ok(contractReadinessOf(inputs()).missing.some((m) => m.key === 'occupationalInjuryInsurance'));
  const row = () => renderContractBlocks(inputs(), {}).find((b) => b.kind === 'numbered' && b.n === '10').rows.find((r) => r[0] === 'Yrkesskadeforsikring');
  assert.equal(row()[1], 'Ja – forsikringsselskap ikke bekreftet');
  assert.equal(applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setOccupationalInjuryInsurance', applies: true, insurer: 'Testselskap Forsikring' } }).ok, true);
  assert.equal(row()[1], 'Ja – Testselskap Forsikring');
  assert.ok(!contractReadinessOf(inputs()).missing.some((m) => m.key === 'occupationalInjuryInsurance'));
});
t('W7', 'tariffavtale: Nei is the established complete answer; Ja conditionally requires and renders details', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const p = mutableProfile();                                             // seeded Nei
  const inputs = () => contractInputsFor({ employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS });
  const row = () => renderContractBlocks(inputs(), {}).find((b) => b.kind === 'numbered' && b.n === '11').rows[0];
  assert.equal(row()[1], 'Nei');
  assert.ok(!contractReadinessOf(inputs()).missing.some((m) => m.key === 'tariffavtale'));
  applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setTariffavtale', applies: true, agreementName: '', parties: '' } });
  assert.ok(contractReadinessOf(inputs()).missing.some((m) => m.key === 'tariffavtale'));   // Ja without details blocks
  assert.equal(row()[1], 'Ja – avtaledetaljer ikke bekreftet');
  applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setTariffavtale', applies: true, agreementName: 'Testavtale', parties: 'Part A / Part B' } });
  assert.equal(row()[1], 'Ja – Testavtale (Part A / Part B)');
  assert.ok(!contractReadinessOf(inputs()).missing.some((m) => m.key === 'tariffavtale'));
});
t('W8', 'company facts are ONE shared truth across employees, never duplicated per contract draft', () => {
  const store = seedE();
  const a = readyEmployee(store, 'Nora'); const b = readyEmployee(store, 'Tim');
  const p = mutableProfile();
  applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setPension', applies: true, provider: 'Felles Leverandør' } });
  for (const emp of [a, b]) {
    assert.ok(flatOf(renderContractBlocks(contractInputsFor({ employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS }), {})).includes('Ja – Felles Leverandør'));
    applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
    const dj = JSON.stringify(draftVersionOf(emp));
    for (const k of ['pension', 'tariffavtale', 'occupationalInjuryInsurance', 'provider', 'insurer']) assert.ok(!dj.includes(k), 'duplicated company fact in draft: ' + k);
  }
});
t('W9', 'frozen version stays byte-stable when employee and company facts change afterwards', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const p = mutableProfile(PROFILE);                                      // fully confirmed, runtime-editable
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  assert.equal(applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId }, { profile: p }).ok, true);
  const v = latestContractVersion(emp);
  const before = JSON.stringify(blocksForVersion(v, { employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS }));
  applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setPension', applies: true, provider: 'Endret Leverandør' } });
  applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setTariffavtale', applies: true, agreementName: 'Ny Avtale', parties: null } });
  applyE(store, { kind: 'updateContact', ansattId: emp.ansattId, contact: { address: { street: 'Flyttet 1', postalCode: '0001', city: 'Oslo' } } });
  const after = JSON.stringify(blocksForVersion(v, { employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS }));
  assert.equal(after, before);
  assert.ok(before.includes('TEST-BEKREFTET pensjonsleverandør'));
  assert.ok(before.includes('Storgata 99, 2815 Gjøvik'));
  assert.ok(!after.includes('Endret Leverandør'));
  assert.ok(!after.includes('Flyttet 1, 0001 Oslo'));
});

// ---- COMPANY-FACTS UX + SALARY-PAYMENT REFINEMENT — release proofs X1–X4 -------------------
t('X1', 'salary payment arrangement updates through the shared boundary and renders combined with paymentInterval', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const p = mutableProfile();                                             // salaryPaymentArrangement: null
  const inputs = () => contractInputsFor({ employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS });
  assert.ok(contractReadinessOf(inputs()).missing.some((m) => m.key === 'salaryPaymentArrangement'));
  const row = () => renderContractBlocks(inputs(), {}).find((b) => b.kind === 'numbered' && b.n === '06').rows.find((r) => r[0] === 'Utbetaling');
  assert.equal(row()[1], 'Månedlig – dato/ordning ikke bekreftet');       // interval truth + honest unconfirmed
  assert.equal(applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setSalaryPaymentArrangement', arrangement: 'den 25. i hver måned' } }).ok, true);
  assert.equal(row()[1], 'Månedlig – den 25. i hver måned');              // combined, no duplicate storage
  assert.ok(!contractReadinessOf(inputs()).missing.some((m) => m.key === 'salaryPaymentArrangement'));
  assert.equal(p.companyFacts.salaryPaymentArrangement, 'den 25. i hver måned');   // same single truth
  assert.equal(applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setSalaryPaymentArrangement', arrangement: 42 } }).code, 'ARRANGEMENT_INVALID');
  assert.equal(applyCompanyContractOperation({ profile: REAL_PROFILE, actor: MGR, op: { kind: 'setSalaryPaymentArrangement', arrangement: 'x' } }).code, 'PROFILE_FROZEN');
});
t('X2', 'missing salary payment arrangement alone still blocks freeze (fail closed)', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const p = mutableProfile();
  applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setPension', applies: true, provider: 'Testleverandør Pensjon' } });
  applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setOccupationalInjuryInsurance', applies: true, insurer: 'Testselskap Forsikring' } });
  const r = contractReadinessOf(contractInputsFor({ employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS }));
  assert.deepEqual(r.missing.map((m) => m.key), ['salaryPaymentArrangement']);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const f = applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId }, { profile: p });
  assert.equal(f.ok, false); assert.equal(f.code, 'NOT_READY');
  applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setSalaryPaymentArrangement', arrangement: 'den 25. i hver måned' } });
  assert.equal(applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId }, { profile: p }).ok, true);
});
t('X3', 'frozen version stays byte-stable after a later salary-arrangement change', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const p = mutableProfile(PROFILE);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId }, { profile: p });
  const v = latestContractVersion(emp);
  const before = JSON.stringify(blocksForVersion(v, { employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS }));
  applyCompanyContractOperation({ profile: p, actor: MGR, op: { kind: 'setSalaryPaymentArrangement', arrangement: 'HELT NY ORDNING' } });
  const after = JSON.stringify(blocksForVersion(v, { employee: emp, profile: p, onDate: TODAY, roleLabels: ROLE_LABELS }));
  assert.equal(after, before);
  assert.ok(!after.includes('HELT NY ORDNING'));
  assert.ok(before.includes('TEST-BEKREFTET utbetalingsordning'));
});
t('X4', 'management surface: collapsed default, gated editor, conditional Ja-only fields, one shared editor from the flow', () => {
  const src = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('companySetupOpen = false'));                    // collapsed summary is the default state
  assert.ok(src.includes("btn('Rediger avtaleoppsett'"));                 // editor opens only via owner action
  assert.ok(src.includes('if (!companySetupOpen)'));                      // editor branch gated behind the flag
  for (const cond of ["if (d.pen === 'ja')", "if (d.yrk === 'ja')", "if (d.ta === 'ja')"]) {
    assert.ok(src.includes(cond), 'missing conditional dependent field gate: ' + cond);   // Nei/unset hides details
  }
  assert.ok(src.includes('Felles opplysninger fra Four Season'));         // read-only inherited block in the flow
  assert.ok(src.includes("btn('Fullfør selskapsopplysninger'"));          // opens the SAME shared editor
  assert.ok(src.includes('companySetupOpen = true; companyDraft = null')); // reveal action reuses the one editor/state
  assert.ok(src.includes('Lønnsutbetaling – dato/ordning'));              // owner-facing shared salary field
  assert.ok(!src.includes('Pensjonsleverandør (ved Ja)'));                // old always-visible pattern removed
  const occurrences = src.split('applyCompanyContractOperation({ profile: contractProfile').length - 1;
  assert.ok(occurrences >= 1);                                            // all writes go through the ONE boundary
  assert.ok(!src.includes('companyFactsCopy') && !src.includes('localStorage'));   // no second store
});

// ---- DRAFT/VERSION LIFECYCLE + PRINT/PDF REFINEMENT — release proofs Y1–Y4 -----------------
t('Y1', 'prior frozen version stays byte/value-stable after starting AND editing a new draft', () => {
  const store = seedE(); const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  const v1 = latestContractVersion(emp);
  const v1Json = JSON.stringify(v1);
  const v1Blocks = JSON.stringify(blocksForVersion(v1, { employee: emp, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS }));
  assert.equal(applyC(store, { kind: 'startDraft', ansattId: emp.ansattId }).ok, true);   // new agreement via the SAME boundary
  applyE(store, { kind: 'appendTerms', ansattId: emp.ansattId, terms: { validFrom: '2026-12-01', role: 'butikksjef', percentage: 100 } });
  applyE(store, { kind: 'updateContact', ansattId: emp.ansattId, contact: { address: { street: 'Nyveien 7', postalCode: '2815', city: 'Gjøvik' } } });
  const v1After = contractVersionsOf(emp).find((v) => v.contractVersionId === v1.contractVersionId);
  assert.equal(JSON.stringify(v1After), v1Json);                                          // history immutable by value
  assert.equal(JSON.stringify(blocksForVersion(v1After, { employee: emp, profile: PROFILE, onDate: '2026-12-02', roleLabels: ROLE_LABELS })), v1Blocks);
});
t('Y2', 'starting new agreements never deletes or replaces prior frozen history', () => {
  const store = seedE(); const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const v1 = applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId }).version;
  applyE(store, { kind: 'appendTerms', ansattId: emp.ansattId, terms: { validFrom: '2026-12-01', role: 'butikksjef' } });
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const v2 = applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId }, { onDate: '2026-12-02' }).version;
  applyE(store, { kind: 'appendTerms', ansattId: emp.ansattId, terms: { validFrom: '2027-02-01', role: 'butikkmedarbeider' } });
  assert.equal(applyC(store, { kind: 'startDraft', ansattId: emp.ansattId }).ok, true);   // third agreement, draft
  const all = contractVersionsOf(emp);
  assert.equal(all.length, 3);                                                            // append-only history
  assert.equal(all[0].contractVersionId, v1.contractVersionId);
  assert.equal(all[1].contractVersionId, v2.contractVersionId);
  assert.equal(all[0].status, CONTRACT_STATUS.FROZEN);
  assert.equal(all[1].status, CONTRACT_STATUS.FROZEN);
  assert.equal(all[2].status, CONTRACT_STATUS.DRAFT);
  assert.equal(all[1].supersedes, v1.contractVersionId);                                  // lineage, not replacement
  assert.equal(all[0].snapshot.terms.role, 'butikkmedarbeider');                          // v1 content untouched
});
t('Y3', 'a new draft renders from CURRENT canonical facts with no duplicate storage and no shared references', () => {
  const store = seedE(); const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  applyE(store, { kind: 'appendTerms', ansattId: emp.ansattId, terms: { validFrom: '2026-12-01', role: 'butikksjef', percentage: 100 } });
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const draft = draftVersionOf(emp);
  const flat = flatOf(blocksForVersion(draft, { employee: emp, profile: PROFILE, onDate: '2026-12-02', roleLabels: ROLE_LABELS }));
  assert.ok(flat.includes('Butikksjef'));                                                 // current canonical role
  assert.ok(flat.includes('TEST-BEKREFTET pensjonsleverandør'));                          // ONE shared company truth
  const dj = JSON.stringify(draft);
  for (const k of ['"role"', '"address"', 'pension', 'tariffavtale', 'salaryPaymentArrangement']) assert.ok(!dj.includes(k), 'duplicate truth in draft: ' + k);
  assert.equal(draft.snapshot, null);                                                     // no silent frozen copy
  const v1 = contractVersionsOf(emp)[0];
  assert.notEqual(draft, v1); assert.ok(Object.isFrozen(v1) && !Object.isFrozen(draft));  // no by-reference history leak
});
t('Y4', 'Print/PDF consume the one renderer, mutate nothing; lifecycle status is owner-readable', () => {
  const src = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("btn('Skriv ut'"));
  assert.ok(src.includes("btn('Lagre som PDF'"));
  assert.equal(src.split('window.print()').length - 1, 2);                                // both actions ONLY print
  assert.ok(src.includes('historisk og uforanderlig'));                                   // frozen-status wording
  assert.ok(src.includes("btn('Lagre utkast og lukk'"));                                  // explicit draft-save exposure
  assert.ok(src.includes("btn('Vis'"));                                                   // per-version history view
  assert.ok(src.includes("btn('Ny endringsavtale'"));                                     // new-agreement action (reused boundary)
  assert.ok(!src.includes('jsPDF') && !src.includes('html2canvas') && !src.includes('html2pdf'));  // no second document pipeline
  const html = ['./employee-shell.html', './employee-shell.css'].map((p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n')   /* S4 host: the preview stylesheet was extracted to employee-shell.css; guards read both */;
  assert.ok(html.includes('@media print'));
  assert.ok(html.includes('.fs-a4, .fs-a4 * { visibility:visible; }'));                   // only the agreement prints
  // printing has no operation-boundary reach: the print actions appear before any apply* call
  const printIdx = src.indexOf("btn('Skriv ut'");
  const segment = src.slice(printIdx, src.indexOf("btn('Lagre som PDF'") + 60);
  assert.ok(!segment.includes('applyC') && !segment.includes('applyEmployeeOperation') && !segment.includes('applyCompanyContractOperation'));
});

// ---- PRE-CHECKPOINT CORRECTION — address/birthDate proofs P1, P2, P3, P8, P9 ----------------
t('P1', 'structured address entry renders exactly "Storgata 20, 2815 Gjøvik" in the contract preview', () => {
  const store = seedE(); const emp = readyEmployee(store);
  applyE(store, { kind: 'updateContact', ansattId: emp.ansattId, contact: { address: { street: 'Storgata 20', postalCode: '2815', city: 'Gjøvik' } } });
  const panel = renderContractBlocks(realInputsOf(emp), {}).find((b) => b.kind === 'parties');
  assert.equal(panel.employee.find((r) => r[0] === 'Adresse')[1], 'Storgata 20, 2815 Gjøvik');
  assert.equal(panel.employee.find((r) => r[0] === 'Fødselsdato')[1], '15.03.1995');   // DD.MM.YYYY presentation
  assert.equal(formatAddress({ street: 'Storgata 20', postalCode: '2815', city: 'Gjøvik' }), 'Storgata 20, 2815 Gjøvik');
  assert.equal(formatAddress({ street: 'Kirkegata 1', postalCode: '0150', city: 'Oslo' }), 'Kirkegata 1, 0150 Oslo');   // leading zero preserved
});
t('P2', 'legacy free-text record: structured fields empty, legacyText verbatim, readiness fails closed on Adresse', () => {
  const store = seedE(); const emp = readyEmployee(store);
  emp.contact.address = 'storgata 20.2815 gjovik';                       // a pre-shape local record
  const norm = normalizeAddress(emp.contact.address);
  assert.deepEqual(norm, { street: '', postalCode: '', city: '', legacyText: 'storgata 20.2815 gjovik' });
  assert.equal(addressIsComplete(emp.contact.address), false);
  const r = contractReadinessOf(realInputsOf(emp));
  assert.equal(r.ready, false);
  assert.ok(r.missing.some((m) => m.key === 'address' && m.label === 'Adresse'), 'named address cause required');
  assert.ok(missingInfoOf(emp, TODAY).includes('mangler adresse'));
  const flat = flatOf(renderContractBlocks(realInputsOf(emp), {}));
  assert.ok(!flat.includes('storgata 20.2815 gjovik'), 'legacyText must never reach the agreement');
  assert.ok(flat.includes('Ikke registrert'));                            // honest missing marker, never a partial line
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  const f = applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId });
  assert.equal(f.ok, false); assert.equal(f.code, 'NOT_READY');           // freeze blocked
  // first successful structured save CLEARS legacyText
  assert.equal(applyE(store, { kind: 'updateContact', ansattId: emp.ansattId, contact: { address: { street: 'Storgata 20', postalCode: '2815', city: 'Gjøvik' } } }).ok, true);
  assert.deepEqual(emp.contact.address, { street: 'Storgata 20', postalCode: '2815', city: 'Gjøvik' });
  assert.ok(!('legacyText' in emp.contact.address));
});
t('P3', 'NO auto-parse path exists from legacyText into the structured fields', () => {
  // behavioural: a legacy string never populates street/postalCode/city, and legacyText is not owner-writable
  const store = seedE(); const emp = readyEmployee(store);
  emp.contact.address = 'Storgata 20, 2815 Gjøvik';                       // even a perfectly shaped string
  const n = normalizeAddress(emp.contact.address);
  assert.equal(n.street, ''); assert.equal(n.postalCode, ''); assert.equal(n.city, '');   // nothing guessed
  assert.equal(formatAddress(emp.contact.address), 'Ikke registrert');    // formatter never reads legacyText
  assert.equal(applyE(store, { kind: 'updateContact', ansattId: emp.ansattId, contact: { address: { street: 'A 1', postalCode: '2815', city: 'B', legacyText: 'x' } } }).code, 'ADDRESS_FIELD_NOT_ALLOWED:legacyText');
  // source-level: legacyText is read ONLY by the read-only editor display; core limits it to
  // normalization; no renderer/formatter/contract path mentions it.
  const coreSrc = fs.readFileSync(new URL('./management-employees-core.mjs', import.meta.url), 'utf8');
  const viewSrc = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  const contractSrc = fs.readFileSync(new URL('./management-contract-core.mjs', import.meta.url), 'utf8');
  assert.ok(!contractSrc.includes('legacyText'), 'contract renderer must never mention legacyText');
  const viewHits = viewSrc.split('legacyText').length - 1;
  assert.equal(viewHits, 2);                                              // exactly: the read-only guard + its display
  assert.ok(viewSrc.includes('Tidligere adresse (uformatert)'));
  for (const bad of ['parseAddress', 'splitAddress', 'guessAddress', 'postalLookup']) assert.ok(!coreSrc.includes(bad));
  // the formatter body reads street/postalCode/city only
  const fBody = coreSrc.slice(coreSrc.indexOf('export function formatAddress'), coreSrc.indexOf('function validateAddressPatch'));
  assert.ok(!fBody.includes('legacyText'));
});
t('P8', 'frozen version is untouched by later address/birthDate corrections; a new draft shows them', () => {
  const store = seedE(); const emp = readyEmployee(store);
  applyC(store, { kind: 'startDraft', ansattId: emp.ansattId });
  assert.equal(applyC(store, { kind: 'freezeVersion', ansattId: emp.ansattId }).ok, true);
  const v1 = latestContractVersion(emp);
  const v1Json = JSON.stringify(v1);
  const v1Blocks = JSON.stringify(blocksForVersion(v1, { employee: emp, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS }));
  assert.ok(v1Blocks.includes('Storgata 99, 2815 Gjøvik'));
  // correct the live employee truth
  assert.equal(applyE(store, { kind: 'updateContact', ansattId: emp.ansattId, contact: { address: { street: 'Nygata 5', postalCode: '0150', city: 'Oslo' }, birthDate: '1990-01-02' } }).ok, true);
  const v1After = contractVersionsOf(emp).find((v) => v.contractVersionId === v1.contractVersionId);
  assert.equal(JSON.stringify(v1After), v1Json);                          // snapshot byte-stable
  const v1BlocksAfter = JSON.stringify(blocksForVersion(v1After, { employee: emp, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS }));
  assert.equal(v1BlocksAfter, v1Blocks);                                  // rendered bytes UNCHANGED
  assert.ok(!v1BlocksAfter.includes('Nygata 5'));
  assert.ok(!v1BlocksAfter.includes('02.01.1990'));
  // corrected values reach paper ONLY through a new draft
  assert.equal(applyC(store, { kind: 'startDraft', ansattId: emp.ansattId }).ok, true);
  const d2 = JSON.stringify(blocksForVersion(draftVersionOf(emp), { employee: emp, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS }));
  assert.ok(d2.includes('Nygata 5, 0150 Oslo'));
  assert.ok(d2.includes('02.01.1990'));
});
t('P9', 'draft print path still carries the UTKAST watermark and two-page print isolation', () => {
  const store = seedE(); const emp = readyEmployee(store);
  const draftBlocks = renderContractBlocks(realInputsOf(emp), { frozen: false });
  assert.equal(draftBlocks.find((b) => b.kind === 'docHeader').badge, 'UTKAST – IKKE SIGNERT');
  assert.ok(draftBlocks.some((b) => b.kind === 'note' && b.text === 'UTKAST — ikke signert'));
  assert.ok(draftBlocks.some((b) => b.kind === 'pageBreak'));
  const html = ['./employee-shell.html', './employee-shell.css'].map((p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n')   /* S4 host: the preview stylesheet was extracted to employee-shell.css; guards read both */;
  assert.ok(html.includes('@media print'));
  assert.ok(html.includes('.fs-a4, .fs-a4 * { visibility:visible; }'));   // only the agreement prints
  const viewSrc = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  assert.ok(viewSrc.includes("btn('Skriv ut'") && viewSrc.includes("btn('Lagre som PDF'"));
  assert.ok(viewSrc.includes('fs-badge'));                                // badge painted onto the printed page
});

console.log(lines.join('\n'));
console.log('MANAGEMENT_CONTRACT_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
