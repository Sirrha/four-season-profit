// management-contract-freeze.test.mjs — GODKJENN OG FRYS VERSJON before BankID (node built-ins only).
// Owner law (SIRRHA-CCODE-SORMENA-CONTRACT-FINALIZE-FREEZE-BEFORE-BANKID-LOCAL-007): management approval turns ONE complete
// editable draft into the SAME contract version, frozen (godkjent_frosset), one-way, snapshot BY VALUE of every rendered
// fact, completeness re-validated at freeze, reviewed content compare-and-set, no duplicate freeze, never signed.
// Run: node management-contract-freeze.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyEmployeeOperation, employeeOf, missingInfoOf, contractStatusOf, hasApprovedContractVersion } from './management-employees-core.mjs';
import {
  applyContractOperation, contractInputsFor, contractReadinessOf, renderContractBlocks, blocksForVersion, draftVersionOf,
  contractStateOf, contractVersionsOf, TEMPLATE_FIELDS, CONTRACT_STATUS, FUTURE_CONTRACT_STATUS, SIGNING_ADAPTER_CONTRACT,
} from './management-contract-core.mjs';
import { createManagementAdapters, contractProfilePath, E360_KEY } from './management-production-adapters.mjs';
import { ETR2A_POLICY as POLICY } from './employee-shell-core.mjs';
import { FOUR_SEASON_CONTRACT_PROFILE, ROLE_LABELS } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }
const T = 'four-season-as';
const ACTOR = { uid: 'u-admin', accessRole: 'admin', ansattId: null, accessEnabled: true, tenantId: T, canManageSchedule: true, canViewOwnSchedule: false, canViewEmployeeCore: true, canViewEmployeeCompensation: true, canEditEmployment: true };
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);   // 2026-09-29 14:00 Oslo
const TODAY = '2026-09-29';
const snap = (v) => JSON.parse(JSON.stringify(v));
const profileOf = (over) => Object.assign(snap(FOUR_SEASON_CONTRACT_PROFILE), { companyFacts: { salaryPaymentArrangement: 'Den 15. hver måned', pension: { applies: true, provider: 'Storebrand' }, occupationalInjuryInsurance: { applies: true, insurer: 'Gjensidige' }, tariffavtale: { applies: false } } }, over || {});
const apply = (store, op) => applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op, now: NOW });
const cOp = (store, op, profile, extra) => applyContractOperation(Object.assign({ store, tenantId: T, actor: ACTOR, op, profile: profile || profileOf(), now: NOW, onDate: TODAY, roleLabels: ROLE_LABELS }, extra || {}));
const inputsOf = (e, profile) => contractInputsFor({ employee: e, profile: profile || profileOf(), onDate: TODAY, roleLabels: ROLE_LABELS });
const rowOf = (blocks, n, k) => ((blocks.find((b) => b.n === n) || { rows: [] }).rows.find((r) => r[0] === k) || [])[1];
// Herish's accepted Employee #1: Butikkmedarbeider, Fast, deltid, 50 %, 18.75 t, Timelønn 210 — every template field filled, draft open
function employee1(opts) {
  const o = opts || {};
  const store = { [T]: {} };
  const c = apply(store, { kind: 'createEmployee', name: 'Test Ansatt 01', startDate: '2026-08-01', role: 'butikkmedarbeider' });
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentType: 'deltid', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 210 }, expectedWeeklyHours: 18.75, noticePeriod: '1 måned' } }).ok, true);
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: Object.assign({ employmentForm: 'fast', workplace: 'Four Season Gjøvik', workingTimeArrangement: 'Arbeidstid etter vaktplan', probation: 'ingen', breaksArrangement: '30', scheduleChangeHandling: 'Vaktplan varsles 14 dager før', paymentInterval: 'manedlig' }, o.terms || {}) }).ok, true);
  if (o.person !== false) assert.equal(apply(store, { kind: 'updateContact', ansattId: c.ansattId, contact: { address: { street: 'Storgata 1', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1995-04-12', phone: '40000000', email: 'test01@example.test' } }).ok, true);
  assert.equal(cOp(store, { kind: 'startDraft', ansattId: c.ansattId }).ok, true);
  const e = () => employeeOf(store, T, c.ansattId);
  return { store, id: c.ansattId, e, vid: () => draftVersionOf(e()) && draftVersionOf(e()).contractVersionId };
}
const reviewedFreeze = (x, profile, extra) => cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, contractVersionId: x.vid(), expectedInputs: snap(inputsOf(x.e(), profile)) }, profile, Object.assign({ requireReviewedInputs: true }, extra || {}));

await t('Z02', 'EXISTING FREEZE CORE TRACE: freezeVersion exists on the single contract boundary; a draft stores identity/provenance/status only (snapshot null, termsPeriodRef null, frozenAt null, signing shapes null) — the draft is a live projection, not a store', () => {
  const x = employee1();
  const d = snap(draftVersionOf(x.e()));
  assert.deepEqual(Object.keys(d).sort(), ['contractVersionId', 'createdAt', 'frozenAt', 'kind', 'signedArtifactMeta', 'signingTransaction', 'snapshot', 'status', 'supersededBy', 'supersedes', 'templateVersion', 'termsPeriodRef']);
  assert.equal(d.status, 'utkast'); assert.equal(d.kind, 'avtale'); assert.equal(d.snapshot, null); assert.equal(d.termsPeriodRef, null); assert.equal(d.frozenAt, null);
  assert.equal(d.signedArtifactMeta, null); assert.equal(d.signingTransaction, null);
  assert.ok(contractReadinessOf(inputsOf(x.e())).ready, JSON.stringify(contractReadinessOf(inputsOf(x.e())).missing));
  assert.ok(fs.readFileSync(new URL('./management-contract-core.mjs', import.meta.url), 'utf8').includes("if (op.kind === 'freezeVersion') {"));
});
await t('Z03', 'HAPPY PATH: one complete draft -> reviewed freeze -> SAME contractVersionId, count 1 -> 1, status godkjent_frosset, frozenAt = now, snapshot populated, termsPeriodRef = the current period (2026-08-01), kind avtale, templateVersion kept, signing shapes still null', () => {
  const x = employee1();
  const id0 = x.vid(); const n0 = contractVersionsOf(x.e()).length;
  const r = reviewedFreeze(x);
  assert.equal(r.ok, true, JSON.stringify(r));
  const v = contractVersionsOf(x.e());
  assert.equal(n0, 1); assert.equal(v.length, 1); assert.equal(v[0].contractVersionId, id0);
  assert.equal(v[0].status, CONTRACT_STATUS.FROZEN); assert.equal(v[0].status, 'godkjent_frosset'); assert.equal(v[0].frozenAt, NOW); assert.equal(v[0].kind, 'avtale');
  assert.equal(v[0].termsPeriodRef, '2026-08-01'); assert.equal(v[0].templateVersion, 'fs-ansettelsesavtale-v2'); assert.ok(v[0].snapshot && v[0].snapshot.terms);
  assert.equal(v[0].signedArtifactMeta, null); assert.equal(v[0].signingTransaction, null); assert.equal(v[0].supersedes, null);
  assert.equal(draftVersionOf(x.e()), null);
  assert.ok(Object.isFrozen(v[0]) && Object.isFrozen(v[0].snapshot));
});
await t('Z04', 'SNAPSHOT COVERAGE: the snapshot equals contractInputsFor(...) at freeze key-for-key (person, termsPeriodRef, startDate, terms incl. roleLabel, employer, representative, companyFacts, signingPlace, clauses with text/title/version/bullets, templateVersion); every TEMPLATE_FIELDS value is present in it; the frozen agreement renders with NO live source at all (employee/profile = null) and equals the approved content', () => {
  const x = employee1();
  const before = snap(inputsOf(x.e()));
  reviewedFreeze(x);
  const v = contractVersionsOf(x.e())[0];
  assert.deepEqual(snap(v.snapshot), before);
  assert.deepEqual(Object.keys(v.snapshot).sort(), ['clauses', 'companyFacts', 'employer', 'person', 'representative', 'signingPlace', 'startDate', 'templateVersion', 'terms', 'termsPeriodRef']);
  assert.ok(v.snapshot.clauses.length > 0 && v.snapshot.clauses.every((c) => typeof c.text === 'string' && c.key && c.version !== undefined));
  assert.equal(contractReadinessOf(v.snapshot).ready, true, 'every template field is answerable from the snapshot alone');
  for (const f of TEMPLATE_FIELDS) assert.ok(!contractReadinessOf(v.snapshot).missing.some((m) => m.key === f.key), f.key);
  const frozenBlocks = blocksForVersion(v, { employee: null, profile: null, onDate: null, roleLabels: null });
  assert.deepEqual(frozenBlocks, renderContractBlocks(before, { frozen: true, frozenAt: NOW }));
});
await t('Z05', 'FROZEN PREVIEW: Avtalt arbeidstid "18.75 timer per uke", Lønnsform Timelønn, "kr 210 per time", Ansettelsesform Fast, Stillingsprosent 50 %, company + person facts as frozen; badge "GODKJENT OG FROSSET – IKKE ELEKTRONISK SIGNERT", no UTKAST label, no signed claim', () => {
  const x = employee1();
  reviewedFreeze(x);
  const b = blocksForVersion(contractVersionsOf(x.e())[0], { employee: null, profile: null });
  assert.equal(rowOf(b, '04', 'Avtalt arbeidstid'), '18.75 timer per uke');
  assert.equal(rowOf(b, '06', 'Lønnsform'), 'Timelønn'); assert.equal(rowOf(b, '06', 'Lønn ved tiltredelse'), 'kr 210 per time');
  assert.equal(rowOf(b, '02', 'Ansettelsesform'), 'Fast'); assert.equal(rowOf(b, '02', 'Stillingsprosent'), '50 %');
  assert.equal(rowOf(b, '10', 'Pensjonsordning'), 'Ja – Storebrand');
  const h = b.find((k) => k.kind === 'docHeader'); assert.equal(h.badge, 'GODKJENT OG FROSSET – IKKE ELEKTRONISK SIGNERT');
  assert.ok(!/UTKAST/.test(JSON.stringify(b)), 'not labelled as an editable draft');
  assert.equal(b.find((k) => k.kind === 'signatures').date, '—', 'unsigned: no signature date (frozenAt is approval metadata, never a signing date)');
  assert.ok(b.some((k) => k.kind === 'note' && k.text === 'Godkjent og frosset lokal versjon. Ikke elektronisk signert.'));
});
await t('Z06', 'EMPLOYEE 360 PROJECTION: before freeze "mangler kontrakt" (+ list chip "arbeidsavtale er utkast"); after freeze missingInfoOf drops it, contractStateOf = frosset "Godkjent og frosset – ikke signert", no draft; the manual document list is untouched (no auto-registered document) and contractStatusOf keeps meaning "manually registered document" (employee self-projection unchanged)', () => {
  const x = employee1();
  assert.ok(missingInfoOf(x.e(), TODAY).includes('mangler kontrakt')); assert.equal(contractStateOf(x.e()).state, 'utkast');
  reviewedFreeze(x);
  assert.ok(!missingInfoOf(x.e(), TODAY).includes('mangler kontrakt')); assert.deepEqual(missingInfoOf(x.e(), TODAY), []);
  const cs = contractStateOf(x.e());
  assert.equal(cs.state, 'frosset'); assert.equal(cs.label, 'Godkjent og frosset – ikke signert'); assert.equal(cs.draft, null); assert.equal(cs.latest.contractVersionId, 'kv-' + x.id + '-1');
  assert.equal(hasApprovedContractVersion(x.e()), true);
  assert.deepEqual(x.e().documents, []); assert.equal(contractStatusOf(x.e()), 'mangler');
});
await t('Z07', 'COMPLETENESS BLOCK — EMPLOYEE/TERMS: missing person facts (no address/birth date) or a missing employment term refuses freeze with NOT_READY (+ named missing labels); draft and record byte-identical', () => {
  const x = employee1({ person: false });
  const before = snap(x.e());
  const r = cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, contractVersionId: x.vid(), expectedInputs: snap(inputsOf(x.e())) }, null, { requireReviewedInputs: true });
  assert.equal(r.code, 'NOT_READY'); assert.deepEqual(r.missing.map((m) => m.key).sort(), ['address', 'birthDate']);
  assert.deepEqual(snap(x.e()), before);
  const s2 = { [T]: {} };
  const c = apply(s2, { kind: 'createEmployee', name: 'Test Ansatt 05', startDate: '2026-08-01', role: 'butikkmedarbeider' });
  apply(s2, { kind: 'updateContact', ansattId: c.ansattId, contact: { address: { street: 'Storgata 1', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1995-04-12' } });
  cOp(s2, { kind: 'startDraft', ansattId: c.ansattId });
  const b2 = snap(employeeOf(s2, T, c.ansattId));
  const r2 = cOp(s2, { kind: 'freezeVersion', ansattId: c.ansattId });
  assert.equal(r2.code, 'NOT_READY'); assert.ok(r2.missing.some((m) => m.key === 'expectedWeeklyHours') && r2.missing.some((m) => m.key === 'compensation'));
  assert.deepEqual(snap(employeeOf(s2, T, c.ansattId)), b2);
});
await t('Z08', 'COMPLETENESS BLOCK — COMPANY PROFILE + TEMPORARY: an unconfirmed pension fact (applies null) refuses freeze NOT_READY naming Pensjonsordning; midlertidig without grunnlag/sluttdato refuses naming both; no mutation', () => {
  const x = employee1();
  const p = profileOf(); p.companyFacts.pension = { applies: null, provider: null };
  const before = snap(x.e());
  const r = reviewedFreeze(x, p);
  assert.equal(r.code, 'NOT_READY'); assert.deepEqual(r.missing.map((m) => m.key), ['pensionArrangement']);
  assert.deepEqual(snap(x.e()), before);
  const m = employee1({ terms: { employmentForm: 'midlertidig' } });
  const bm = snap(m.e());
  const rm = reviewedFreeze(m);
  assert.equal(rm.code, 'NOT_READY'); assert.deepEqual(rm.missing.map((k) => k.key).sort(), ['employmentBasis', 'employmentEndDate']);
  assert.deepEqual(snap(m.e()), bm);
});
await t('Z09', 'STALE REVIEW / CONCURRENT CHANGE: inputs captured at review, then the authoritative record changes (a -006 correction 18.75 -> 20, a phone change, or a company-profile change) -> freeze refuses CONTRACT_INPUTS_CHANGED and writes nothing; a fresh review of the new truth then freezes exactly that truth', () => {
  const x = employee1();
  const reviewed = snap(inputsOf(x.e()));
  assert.equal(apply(x.store, { kind: 'correctCurrentTerms', ansattId: x.id, periodValidFrom: '2026-08-01', reason: 'Feilregistrert arbeidstid', terms: { expectedWeeklyHours: 20 }, expected: { expectedWeeklyHours: 18.75 } }).ok, true);
  const before = snap(x.e());
  assert.equal(cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, contractVersionId: x.vid(), expectedInputs: reviewed }, null, { requireReviewedInputs: true }).code, 'CONTRACT_INPUTS_CHANGED');
  assert.deepEqual(snap(x.e()), before);
  const y = employee1(); const rv = snap(inputsOf(y.e()));
  apply(y.store, { kind: 'updateContact', ansattId: y.id, contact: { phone: '41111111' } });
  assert.equal(cOp(y.store, { kind: 'freezeVersion', ansattId: y.id, contractVersionId: y.vid(), expectedInputs: rv }, null, { requireReviewedInputs: true }).code, 'CONTRACT_INPUTS_CHANGED');
  const z = employee1(); const rz = snap(inputsOf(z.e()));
  const p2 = profileOf({ signingPlace: 'Raufoss' });
  assert.equal(cOp(z.store, { kind: 'freezeVersion', ansattId: z.id, contractVersionId: z.vid(), expectedInputs: rz }, p2, { requireReviewedInputs: true }).code, 'CONTRACT_INPUTS_CHANGED');
  assert.equal(draftVersionOf(z.e()).status, 'utkast');
  const ok = reviewedFreeze(x);
  assert.equal(ok.ok, true); assert.equal(contractVersionsOf(x.e())[0].snapshot.terms.expectedWeeklyHours, 20, 'the freshly reviewed truth is what freezes');
});
await t('Z09b', 'REVIEW REQUIRED at the production boundary: requireReviewedInputs refuses a freeze without contractVersionId or without expectedInputs (FREEZE_REVIEW_REQUIRED) after completeness passes; the legacy core call without the flag keeps its accepted behaviour', () => {
  const x = employee1();
  assert.equal(cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, expectedInputs: snap(inputsOf(x.e())) }, null, { requireReviewedInputs: true }).code, 'FREEZE_REVIEW_REQUIRED');
  assert.equal(cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, contractVersionId: x.vid() }, null, { requireReviewedInputs: true }).code, 'FREEZE_REVIEW_REQUIRED');
  assert.equal(draftVersionOf(x.e()).status, 'utkast');
  assert.equal(cOp(x.store, { kind: 'freezeVersion', ansattId: x.id }).ok, true);
});
await t('Z10', 'DOUBLE FREEZE: a retry naming the same version -> ALREADY_FROZEN; an unnamed retry -> NO_DRAFT; version count stays 1, the frozen version (snapshot, frozenAt) byte-identical, no duplicate snapshot', () => {
  const x = employee1();
  const id = x.vid(); const reviewed = snap(inputsOf(x.e()));
  assert.equal(cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, contractVersionId: id, expectedInputs: reviewed }, null, { requireReviewedInputs: true }).ok, true);
  const v1 = snap(contractVersionsOf(x.e()));
  const again = cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, contractVersionId: id, expectedInputs: reviewed }, null, { requireReviewedInputs: true, now: NOW + 5000 });
  assert.equal(again.code, 'ALREADY_FROZEN');
  assert.equal(cOp(x.store, { kind: 'freezeVersion', ansattId: x.id }).code, 'NO_DRAFT');
  assert.deepEqual(snap(contractVersionsOf(x.e())), v1); assert.equal(contractVersionsOf(x.e()).length, 1);
});
await t('Z11', 'POST-FREEZE EMPLOYMENT: same-period correction of the frozen period -> TERMS_PERIOD_FROZEN_IN_CONTRACT and completion -> TERMS_PERIOD_FROZEN_IN_CONTRACT; a genuine later period (2026-11-01, 60 %, 22.5 t, fastlønn) is allowed; frozen v1 renders byte-identical (Fast, deltid-scope, 50 %, 18.75, Timelønn 210)', () => {
  const x = employee1();
  reviewedFreeze(x);
  const v = contractVersionsOf(x.e())[0]; const blocks0 = snap(blocksForVersion(v, { employee: null, profile: null }));
  assert.equal(apply(x.store, { kind: 'correctCurrentTerms', ansattId: x.id, periodValidFrom: '2026-08-01', reason: 'x', terms: { expectedWeeklyHours: 20 }, expected: { expectedWeeklyHours: 18.75 } }).code, 'TERMS_PERIOD_FROZEN_IN_CONTRACT');
  assert.equal(apply(x.store, { kind: 'completeCurrentTerms', ansattId: x.id, terms: { employmentBasis: 'x' } }).code, 'TERMS_PERIOD_FROZEN_IN_CONTRACT');
  assert.equal(apply(x.store, { kind: 'appendTerms', ansattId: x.id, terms: { validFrom: '2026-11-01', percentage: 60, expectedWeeklyHours: 22.5, compensation: { model: 'fastlonn', monthlySalary: 30000 } } }).ok, true);
  const v1 = contractVersionsOf(x.e())[0];
  assert.deepEqual(snap(blocksForVersion(v1, { employee: x.e(), profile: profileOf(), onDate: '2026-11-15', roleLabels: ROLE_LABELS })), blocks0);
  assert.equal(rowOf(blocks0, '04', 'Avtalt arbeidstid'), '18.75 timer per uke'); assert.equal(rowOf(blocks0, '06', 'Lønn ved tiltredelse'), 'kr 210 per time');
  assert.equal(v1.snapshot.terms.employmentType, 'deltid'); assert.equal(v1.snapshot.terms.employmentForm, 'fast');
  assert.equal(apply(x.store, { kind: 'correctCurrentTerms', ansattId: x.id, periodValidFrom: '2026-08-01', reason: 'x', terms: { expectedWeeklyHours: 20 }, expected: { expectedWeeklyHours: 18.75 } }).code, 'TERMS_CORRECTION_PERIOD_SUPERSEDED');
});
await t('Z12', 'POST-FREEZE COMPANY CHANGE: changing employer name, signing place, pension provider and a clause text after freeze leaves frozen v1 byte-identical; a new (endringsavtale) draft sees the NEW company values live', () => {
  const x = employee1();
  reviewedFreeze(x);
  const v = contractVersionsOf(x.e())[0]; const blocks0 = snap(blocksForVersion(v, { employee: null, profile: null }));
  const p2 = profileOf({ signingPlace: 'Raufoss' }); p2.employer.name = 'Four Season Gjøvik AS'; p2.companyFacts.pension = { applies: true, provider: 'KLP' }; p2.clauses[0].text = 'ENDRET KLAUSULTEKST';
  assert.deepEqual(snap(blocksForVersion(v, { employee: x.e(), profile: p2, onDate: TODAY, roleLabels: ROLE_LABELS })), blocks0);
  assert.equal(rowOf(blocks0, '10', 'Pensjonsordning'), 'Ja – Storebrand');
  assert.equal(cOp(x.store, { kind: 'startDraft', ansattId: x.id }, p2).version.kind, 'endringsavtale');
  const live = blocksForVersion(draftVersionOf(x.e()), { employee: x.e(), profile: p2, onDate: TODAY, roleLabels: ROLE_LABELS });
  assert.equal(rowOf(live, '10', 'Pensjonsordning'), 'Ja – KLP'); assert.ok(JSON.stringify(live).includes('ENDRET KLAUSULTEKST'));
  assert.deepEqual(snap(contractVersionsOf(x.e())[0]), snap(v), 'v1 untouched by the new draft');
});
await t('Z13', 'POST-FREEZE PERSON CHANGE: changing phone, e-mail and address after freeze leaves frozen v1 byte-identical (Telefon/Adresse rows keep the frozen values)', () => {
  const x = employee1();
  reviewedFreeze(x);
  const v = contractVersionsOf(x.e())[0]; const blocks0 = snap(blocksForVersion(v, { employee: null, profile: null }));
  assert.equal(apply(x.store, { kind: 'updateContact', ansattId: x.id, contact: { phone: '49999999', email: 'ny@example.test', address: { street: 'Nygata 9', postalCode: '2821', city: 'Gjøvik' } } }).ok, true);
  assert.deepEqual(snap(blocksForVersion(contractVersionsOf(x.e())[0], { employee: x.e(), profile: profileOf(), onDate: TODAY, roleLabels: ROLE_LABELS })), blocks0);
  const emp = blocks0.find((b) => b.kind === 'parties').employee;
  assert.equal(emp.find((r) => r[0] === 'Telefon')[1], '40000000'); assert.equal(emp.find((r) => r[0] === 'Adresse')[1], 'Storgata 1, 2815 Gjøvik');
});
await t('Z14', 'FROZEN VERSION CANNOT BE EDITED OR DISCARDED: discard naming the frozen version -> VERSION_NOT_DRAFT; unnamed discard -> NO_DRAFT; unfreeze/edit kinds -> UNKNOWN_OPERATION; unknown version -> VERSION_UNKNOWN; employee operations never touch contractVersions', () => {
  const x = employee1();
  reviewedFreeze(x);
  const id = contractVersionsOf(x.e())[0].contractVersionId; const vs = snap(contractVersionsOf(x.e()));
  assert.equal(cOp(x.store, { kind: 'discardDraft', ansattId: x.id, contractVersionId: id }).code, 'VERSION_NOT_DRAFT');
  assert.equal(cOp(x.store, { kind: 'discardDraft', ansattId: x.id }).code, 'NO_DRAFT');
  assert.equal(cOp(x.store, { kind: 'unfreezeVersion', ansattId: x.id, contractVersionId: id }).code, 'UNKNOWN_OPERATION');
  assert.equal(cOp(x.store, { kind: 'editVersion', ansattId: x.id, contractVersionId: id }).code, 'UNKNOWN_OPERATION');
  assert.equal(cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, contractVersionId: 'kv-nope' }).code, 'VERSION_UNKNOWN');
  apply(x.store, { kind: 'updateContact', ansattId: x.id, contact: { phone: '47777777' } });
  apply(x.store, { kind: 'addDocument', ansattId: x.id, doc: { name: 'Politiattest', category: 'attest' } });
  assert.deepEqual(snap(contractVersionsOf(x.e())), vs);
});
await t('Z15', 'NO SIGNING FICTION: no contract operation reaches sendt_til_signering/signert; signing shapes stay null; the provider adapter is declaration-only; the view has no signing control and keeps only the plain BankID-future text', () => {
  const x = employee1();
  reviewedFreeze(x);
  const statuses = contractVersionsOf(x.e()).map((v) => v.status);
  assert.ok(!statuses.includes(FUTURE_CONTRACT_STATUS.SENT) && !statuses.includes(FUTURE_CONTRACT_STATUS.SIGNED));
  for (const k of ['sendToSigning', 'signVersion', 'markSigned']) assert.equal(cOp(x.store, { kind: k, ansattId: x.id }).code, 'UNKNOWN_OPERATION');
  const v = contractVersionsOf(x.e())[0]; assert.equal(v.signedArtifactMeta, null); assert.equal(v.signingTransaction, null);
  assert.ok(Object.values(SIGNING_ADAPTER_CONTRACT).every((s) => s === 'not-implemented-in-v1'));
  const src = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  for (const bad of ["btn('Send til signering'", "btn('Signer'", 'BankID-demo', "'signert'"]) assert.ok(!src.includes(bad), bad);
  assert.ok(src.includes("text: 'Elektronisk signering med BankID kommer.'"));
});
await t('Z16', 'NEXT VERSION BOUNDARY (existing path, regression only): startDraft after a frozen v1 creates kv-…-2 of kind endringsavtale; freezing it sets supersedes = v1 and leaves v1 byte-identical (no automatic draft is ever created by freeze)', () => {
  const x = employee1();
  reviewedFreeze(x);
  assert.equal(contractVersionsOf(x.e()).length, 1, 'freeze creates no new draft');
  const v1 = snap(contractVersionsOf(x.e())[0]);
  apply(x.store, { kind: 'appendTerms', ansattId: x.id, terms: { validFrom: '2026-11-01', percentage: 60, expectedWeeklyHours: 22.5 } });
  assert.equal(cOp(x.store, { kind: 'startDraft', ansattId: x.id }).version.kind, 'endringsavtale');
  const r = cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, contractVersionId: x.vid(), expectedInputs: snap(inputsOf(x.e())) }, null, { requireReviewedInputs: true, onDate: '2026-11-15' });
  assert.equal(r.ok, false); assert.equal(r.code, 'CONTRACT_INPUTS_CHANGED', 'review taken on another date than the freeze date is drift, not truth');
  const r2 = cOp(x.store, { kind: 'freezeVersion', ansattId: x.id, contractVersionId: x.vid(), expectedInputs: snap(contractInputsFor({ employee: x.e(), profile: profileOf(), onDate: '2026-11-15', roleLabels: ROLE_LABELS })) }, null, { requireReviewedInputs: true, onDate: '2026-11-15' });
  assert.equal(r2.ok, true, JSON.stringify(r2)); assert.equal(r2.version.supersedes, v1.contractVersionId); assert.equal(r2.version.snapshot.terms.expectedWeeklyHours, 22.5);
  assert.deepEqual(snap(contractVersionsOf(x.e())[0]), v1);
});

await t('Z17', 'PRE/POST FREEZE AGREEMENT BODY EQUAL (release -007A): the draft agreement rendered immediately before freeze and the frozen agreement after freeze are deep-equal in every block except the status chrome (docHeader.badge and the status note); section 14 Dato is "—" on both sides; frozenAt stays on the version; rendering never mutates the stored version', () => {
  const x = employee1();
  const draftBlocks = snap(blocksForVersion(draftVersionOf(x.e()), { employee: x.e(), profile: profileOf(), onDate: TODAY, roleLabels: ROLE_LABELS }));
  reviewedFreeze(x);
  const v = contractVersionsOf(x.e())[0]; const stored = snap(v);
  const frozenBlocks = snap(blocksForVersion(v, { employee: null, profile: null }));
  const body = (blocks) => blocks.filter((b) => b.kind !== 'note').map((b) => (b.kind === 'docHeader' ? Object.assign({}, b, { badge: null }) : b));
  assert.deepEqual(body(frozenBlocks), body(draftBlocks));
  assert.equal(draftBlocks.find((b) => b.kind === 'signatures').date, '—'); assert.equal(frozenBlocks.find((b) => b.kind === 'signatures').date, '—');
  assert.deepEqual(draftBlocks.filter((b) => b.kind === 'note').map((b) => b.text).slice(1), frozenBlocks.filter((b) => b.kind === 'note').map((b) => b.text).slice(1), 'only the first (status) note differs');
  assert.equal(frozenBlocks.find((b) => b.kind === 'docHeader').badge, 'GODKJENT OG FROSSET – IKKE ELEKTRONISK SIGNERT');
  assert.equal(v.frozenAt, NOW); assert.deepEqual(snap(contractVersionsOf(x.e())[0]), stored, 'render is read-only');
  assert.equal(snap(renderContractBlocks(v.snapshot, { frozen: true, frozenAt: NOW + 86400000 * 400 })).find((b) => b.kind === 'signatures').date, '—', 'no path turns frozenAt into a signature date');
});

// ---- production boundary: ONE transaction, authoritative profile re-read, review required ----
function makeFakeFs() {
  const docs = new Map(); const writes = [];
  const colOf = (p) => p.split('/').slice(0, -1).join('/'); const idOf = (p) => p.split('/').pop();
  const applyW = (w) => { for (const [kind, p, d] of w) { writes.push([kind, p]); if (kind === 'set') docs.set(p, snap(d)); else docs.set(p, Object.assign({}, docs.get(p), snap(d))); } };
  const api = {
    doc: (p) => ({ path: p }), serverTimestamp: () => ({ __st: true }), newId: () => 'AuToId00000000000007', listen: () => () => {},
    runTransaction: async (fn) => { const w = []; const tx = { get: async (ref) => ({ exists: docs.has(ref.path), data: docs.get(ref.path) }), set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]) }; const out = await fn(tx); applyW(w); return out; },
    batch: () => { const w = []; return { set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]), commit: async () => applyW(w) }; },
  };
  const readAnsatte = () => { const out = []; for (const [p, d] of docs) if (colOf(p) === 'tenants/' + T + '/ansatte') out.push(Object.assign({ id: idOf(p) }, d)); return out; };
  return { api, docs, writes, readAnsatte };
}
await t('ADAPTER-TX', 'adapter freeze: ONE transaction update on tenants/T/ansatte/{id} (same version id, godkjent_frosset, snapshot); the snapshot company facts come from the AUTHORITATIVE _meta/contractProfile document, never the caller\'s in-memory profile; a profile document changed after review -> CONTRACT_INPUTS_CHANGED; unreviewed -> FREEZE_REVIEW_REQUIRED; retry -> ALREADY_FROZEN; refusals write nothing', async () => {
  const F = makeFakeFs();
  const ADM = { uid: 'uid-admin-1', tenantId: T, accessRole: 'admin', ansattId: null, accessEnabled: true };
  const PROF = profileOf();
  F.docs.set(contractProfilePath(T), snap(Object.assign({}, PROF, { updatedAt: NOW, updatedByUid: 'uid-admin-1' })));
  const A = createManagementAdapters({ fs: F.api, tenantId: T, membership: ADM, range: { from: '2026-09-01', to: '2026-10-31' }, readAnsatte: F.readAnsatte, defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: POLICY, nowMs: () => NOW });
  const loaded = await A.contractProfile.load();
  const c = await A.employees.apply({ kind: 'createEmployee', name: 'Test Ansatt 01', startDate: '2026-08-01', role: 'butikkmedarbeider' });
  await A.employees.apply({ kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentType: 'deltid', employmentForm: 'fast', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 210 }, expectedWeeklyHours: 18.75, noticePeriod: '1 måned', workplace: 'Four Season Gjøvik', workingTimeArrangement: 'Arbeidstid etter vaktplan', probation: 'ingen', breaksArrangement: '30', scheduleChangeHandling: 'Vaktplan varsles 14 dager før', paymentInterval: 'manedlig' } });
  await A.employees.apply({ kind: 'updateContact', ansattId: c.ansattId, contact: { address: { street: 'Storgata 1', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1995-04-12' } });
  await A.employees.applyContract({ kind: 'startDraft', ansattId: c.ansattId }, loaded, { onDate: TODAY, roleLabels: ROLE_LABELS });
  const path = 'tenants/' + T + '/ansatte/' + c.ansattId;
  const emp = () => A.employees.store()[T][c.ansattId];
  const vid = emp().contractVersions[0].contractVersionId;
  const reviewed = snap(contractInputsFor({ employee: emp(), profile: loaded, onDate: TODAY, roleLabels: ROLE_LABELS }));
  const refused = async (op, prof, code) => { const n = F.writes.length; let e = null; try { await A.employees.applyContract(op, prof, { onDate: TODAY, roleLabels: ROLE_LABELS }); } catch (x) { e = x; } assert.ok(e && e.code === 'CORE_REFUSED' && e.coreResult && e.coreResult.code === code, code + ' got ' + (e && e.coreResult ? e.coreResult.code : e && e.code)); assert.equal(F.writes.length, n, 'no write on ' + code); };
  await refused({ kind: 'freezeVersion', ansattId: c.ansattId }, loaded, 'FREEZE_REVIEW_REQUIRED');
  // the authoritative profile changes after the owner opened the review
  const docBefore = snap(F.docs.get(contractProfilePath(T)));
  F.docs.set(contractProfilePath(T), Object.assign(snap(docBefore), { signingPlace: 'Raufoss' }));
  await refused({ kind: 'freezeVersion', ansattId: c.ansattId, contractVersionId: vid, expectedInputs: reviewed }, loaded, 'CONTRACT_INPUTS_CHANGED');
  F.docs.set(contractProfilePath(T), docBefore);
  // a stale/bogus in-memory profile handed in by the caller is NOT the snapshot source
  const bogus = Object.assign(snap(loaded), { signingPlace: 'BOGUS' });
  const n0 = F.writes.length;
  const r = await A.employees.applyContract({ kind: 'freezeVersion', ansattId: c.ansattId, contractVersionId: vid, expectedInputs: reviewed }, bogus, { onDate: TODAY, roleLabels: ROLE_LABELS });
  assert.equal(r.ok, true);
  assert.deepEqual(F.writes.slice(n0), [['update', path]]);
  const d = F.docs.get(path)[E360_KEY];
  assert.equal(d.contractVersions.length, 1); assert.equal(d.contractVersions[0].contractVersionId, vid); assert.equal(d.contractVersions[0].status, 'godkjent_frosset');
  assert.equal(d.contractVersions[0].snapshot.signingPlace, 'Gjøvik'); assert.equal(d.contractVersions[0].snapshot.terms.expectedWeeklyHours, 18.75); assert.equal(d.contractVersions[0].termsPeriodRef, '2026-08-01');
  assert.equal(d.lastOp, 'contract:freezeVersion');
  await refused({ kind: 'freezeVersion', ansattId: c.ansattId, contractVersionId: vid, expectedInputs: reviewed }, loaded, 'ALREADY_FROZEN');
  assert.ok(F.writes.every(([, p]) => /^tenants\/four-season-as\/ansatte\//.test(p)), 'freeze writes only the canonical employee document (no document registry, no storage)');
  A.dispose();
});
await t('VIEW-LAW', 'management-employees-view.mjs: Step 4 "Godkjenn og frys versjon" opens an in-page confirmation (no native confirm) capturing the reviewed inputs; "Ja, godkjenn og frys" sends freezeVersion with contractVersionId + expectedInputs and is disabled while in flight; the confirmation says locked / new version / NOT signed / BankID later; Overview reads the contract projection; frozen wording says ikke signert', () => {
  const v = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  assert.ok(v.includes("btn('Godkjenn og frys versjon', 'btn primary', () => { freezeConfirm = { contractVersionId: draftV.contractVersionId, inputs: JSON.parse(JSON.stringify(inputsFor(e))) }; errMsg = ''; draw(); })"));
  assert.ok(v.includes("applyC({ kind: 'freezeVersion', ansattId: e.ansattId, contractVersionId: fc.contractVersionId, expectedInputs: fc.inputs }"));
  assert.ok(v.includes("btn('Ja, godkjenn og frys', 'btn primary'") && v.includes("if (freezeBusy || !freezeConfirm) return;"));
  assert.ok(v.includes('Dette signerer IKKE avtalen. Elektronisk signering med BankID kommer senere.') && v.includes('Senere endringer krever en ny avtaleversjon.'));
  assert.ok(!/window\.confirm|[^.]confirm\(/.test(v), 'no native browser confirm');
  assert.ok(!v.includes("applyC({ kind: 'freezeVersion', ansattId: e.ansattId }"), 'no unreviewed one-click freeze left');
  assert.ok(v.includes("csO.state === 'frosset' ? csO.label"));
  assert.ok(v.includes("'Godkjent og frosset – ikke signert · historisk og uforanderlig'"));
});

for (const l of lines) console.log(l);
console.log('MANAGEMENT_CONTRACT_FREEZE_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
