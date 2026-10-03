// management-current-period-correction.test.mjs — CORRECTION OF A FEILREGISTRERING != REAL LATER EMPLOYMENT CHANGE (node built-ins only).
// Owner law (SIRRHA-CCODE-SORMENA-CURRENT-PERIOD-CORRECTION-BEFORE-CONTRACT-FREEZE-LOCAL-006): an erroneously registered value on
// the CURRENT eligible period is corrected IN PLACE (same period, same validFrom, no new period, reason required, audited); a
// genuine later change stays appendTerms ("Ny periode (endring)"); historical / frozen / signed truth is never rewritten.
// Run: node management-current-period-correction.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyEmployeeOperation, employeeOf, currentTermsOf, startDateOf, correctableTermsPeriodOf, missingInfoOf, compensationProjectionOf, vaktplanPeopleFrom, TERMS_FIELDS } from './management-employees-core.mjs';
import { contractInputsFor, contractReadinessOf, renderContractBlocks, blocksForVersion, applyContractOperation, draftVersionOf } from './management-contract-core.mjs';
import { createManagementAdapters, normalizeAnsatt, ansattWriteFor, E360_KEY } from './management-production-adapters.mjs';
import { ETR2A_POLICY as POLICY } from './employee-shell-core.mjs';
import { FOUR_SEASON_CONTRACT_PROFILE, ROLE_LABELS } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }
const T = 'four-season-as';
const ACTOR = { uid: 'u-admin', accessRole: 'admin', ansattId: null, accessEnabled: true, tenantId: T, canManageSchedule: true, canViewOwnSchedule: false, canViewEmployeeCore: true, canViewEmployeeCompensation: true, canEditEmployment: true };
const NOW = Date.UTC(2026, 8, 29, 10, 0, 0);   // 2026-09-29 12:00 Oslo
const TODAY = '2026-09-29';
const REASON = 'Feilregistrert arbeidstid';
const apply = (store, op, actor, now) => applyEmployeeOperation({ store, tenantId: T, actor: actor || ACTOR, op, now: now === undefined ? NOW : now });
const PROFILE = Object.assign({}, FOUR_SEASON_CONTRACT_PROFILE, { companyFacts: { salaryPaymentArrangement: 'x', pension: { applies: false }, occupationalInjuryInsurance: { applies: false }, tariffavtale: { applies: false } } });
const cOp = (store, op) => applyContractOperation({ store, tenantId: T, actor: ACTOR, op, profile: PROFILE, now: NOW, onDate: TODAY, roleLabels: ROLE_LABELS });
const inputsOf = (e) => contractInputsFor({ employee: e, profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS });
const snap = (v) => JSON.parse(JSON.stringify(v));
const hoursRow = (blocks) => (blocks.find((b) => b.n === '04').rows.find((r) => r[0] === 'Avtalt arbeidstid') || [])[1];
// Herish's live case: ONE current period — Butikkmedarbeider, Fast, deltid, 50 %, Timelønn 210, Arbeidstid etter vaktplan,
// Prøvetid ingen, Oppsigelsestid 1 måned, Avtalt arbeidstid 37.5 (the feilregistrering) — plus an editable contract draft.
function liveCase(opts) {
  const store = { [T]: {} };
  const c = apply(store, { kind: 'createEmployee', name: 'Test Ansatt 01', startDate: '2026-08-01', role: 'butikkmedarbeider' });
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentType: 'deltid', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 210 }, expectedWeeklyHours: 37.5, noticePeriod: '1 måned' } }).ok, true);
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentForm: 'fast', workingTimeArrangement: 'Arbeidstid etter vaktplan', probation: 'ingen', breaksArrangement: '30 minutter ubetalt' } }).ok, true);
  if (!opts || opts.draft !== false) assert.equal(cOp(store, { kind: 'startDraft', ansattId: c.ansattId }).ok, true);
  return { store, id: c.ansattId, e: () => employeeOf(store, T, c.ansattId) };
}
const fix = (id, extra) => Object.assign({ kind: 'correctCurrentTerms', ansattId: id, periodValidFrom: '2026-08-01', reason: REASON, terms: { expectedWeeklyHours: 18.75 }, expected: { expectedWeeklyHours: 37.5 } }, extra || {});

await t('K01', 'PRE-FIX GAP pinned: on the completed current period the accepted fill-only op refuses 37.5 -> 18.75 (TERMS_VALUE_ALREADY_SET:expectedWeeklyHours) and the only other term op, appendTerms, necessarily creates a NEW period — i.e. before -006 no same-period correction existed', () => {
  const { store, id, e } = liveCase();
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { expectedWeeklyHours: 18.75 } }).code, 'TERMS_VALUE_ALREADY_SET:expectedWeeklyHours');
  assert.equal(e().terms[0].expectedWeeklyHours, 37.5);
  const probe = snap(store);
  assert.equal(apply(probe, { kind: 'appendTerms', ansattId: id, terms: { validFrom: TODAY, expectedWeeklyHours: 18.75 } }).ok, true);
  assert.equal(employeeOf(probe, T, id).terms.length, 2, 'the change path fabricates period #2 dated ' + TODAY);
});
await t('K02', 'ELIGIBLE CORRECTION 37.5 -> 18.75 with reason "Feilregistrert arbeidstid": ok, SAME single period, identity (validFrom) 2026-08-01 unchanged, start date unchanged, current terms read 18.75', () => {
  const { store, id, e } = liveCase();
  assert.deepEqual(correctableTermsPeriodOf(e()).validFrom, '2026-08-01');
  const r = apply(store, fix(id));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(e().terms.length, 1); assert.equal(e().terms[0].validFrom, '2026-08-01'); assert.equal(startDateOf(e()), '2026-08-01');
  assert.equal(e().terms[0].expectedWeeklyHours, 18.75); assert.equal(currentTermsOf(e(), TODAY).expectedWeeklyHours, 18.75);
  assert.ok(Object.isFrozen(e().terms[0]), 'the re-issued period is a frozen record like every other');
});
await t('K03', 'OTHER TERMS PRESERVED: every field except expectedWeeklyHours is value-identical (role, Fast, deltid, 50, Timelønn 210, Arbeidstid etter vaktplan, ingen, 1 måned, pause, all keys)', () => {
  const { store, id, e } = liveCase();
  const before = snap(e().terms[0]);
  apply(store, fix(id));
  const after = snap(e().terms[0]);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.deepEqual(Object.keys(after).sort(), TERMS_FIELDS.slice().sort());
  assert.deepEqual(Object.assign({}, after, { expectedWeeklyHours: 37.5 }), before);
  assert.equal(after.employmentForm, 'fast'); assert.equal(after.employmentType, 'deltid'); assert.equal(after.percentage, 50); assert.deepEqual(after.compensation, { model: 'timelonn', hourlyRate: 210 });
  assert.equal(after.workingTimeArrangement, 'Arbeidstid etter vaktplan'); assert.equal(after.probation, 'ingen'); assert.equal(after.noticePeriod, '1 måned'); assert.equal(after.role, 'butikkmedarbeider');
});
await t('K04', 'AUDIT: one entry appended to employee.termsCorrections { at (injected now), byUid (actor uid), reason (trimmed), periodValidFrom, changes [{ field, before, after }] }; a second correction appends (never rewrites the first)', () => {
  const { store, id, e } = liveCase();
  const r = apply(store, fix(id, { reason: '  ' + REASON + '  ' }));
  assert.deepEqual(snap(e().termsCorrections), [{ at: NOW, byUid: 'u-admin', reason: REASON, periodValidFrom: '2026-08-01', changes: [{ field: 'expectedWeeklyHours', before: 37.5, after: 18.75 }] }]);
  assert.deepEqual(snap(r.correction), snap(e().termsCorrections[0]));
  const r2 = apply(store, { kind: 'correctCurrentTerms', ansattId: id, periodValidFrom: '2026-08-01', reason: 'Feil timelønn', terms: { compensation: { model: 'timelonn', hourlyRate: 215 } }, expected: { compensation: { hourlyRate: 210, model: 'timelonn' } } }, null, NOW + 60000);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(e().termsCorrections.length, 2);
  assert.deepEqual(snap(e().termsCorrections[0].changes), [{ field: 'expectedWeeklyHours', before: 37.5, after: 18.75 }]);
  assert.deepEqual(snap(e().termsCorrections[1]), { at: NOW + 60000, byUid: 'u-admin', reason: 'Feil timelønn', periodValidFrom: '2026-08-01', changes: [{ field: 'compensation', before: { model: 'timelonn', hourlyRate: 210 }, after: { model: 'timelonn', hourlyRate: 215 } }] });
});
await t('K05', 'NO FAKE PERIOD: count 1 before and after, no period dated today, no validTo stored anywhere, start 2026-08-01', () => {
  const { store, id, e } = liveCase();
  assert.equal(e().terms.length, 1);
  apply(store, fix(id));
  assert.equal(e().terms.length, 1); assert.ok(!e().terms.some((x) => x.validFrom === TODAY)); assert.ok(!('validTo' in e().terms[0])); assert.equal(startDateOf(e()), '2026-08-01');
});
await t('K06', 'CONTRACT DRAFT COHERENCE: the draft that existed BEFORE the correction stores no term values (snapshot null, termsPeriodRef null) and renders from live canonical terms -> after correction Step-2 inputs and the preview say 18.75, no 37.5 anywhere in the rendered draft; the draft object itself is untouched, still utkast, nothing frozen', () => {
  const { store, id, e } = liveCase();
  const draftBefore = snap(draftVersionOf(e()));
  assert.equal(draftBefore.snapshot, null); assert.equal(draftBefore.termsPeriodRef, null);
  assert.equal(hoursRow(blocksForVersion(null, { employee: e(), profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS })), '37.5 timer per uke');
  apply(store, fix(id));
  assert.equal(inputsOf(e()).terms.expectedWeeklyHours, 18.75);
  const blocks = blocksForVersion(draftVersionOf(e()), { employee: e(), profile: PROFILE, onDate: TODAY, roleLabels: ROLE_LABELS });
  assert.equal(hoursRow(blocks), '18.75 timer per uke');
  assert.ok(!/37[.,]5/.test(JSON.stringify(blocks)), 'no stale 37.5 in the rendered draft');
  assert.deepEqual(snap(draftVersionOf(e())), draftBefore);
  assert.equal(e().contractVersions.length, 1); assert.equal(e().contractVersions[0].status, 'utkast');
  const rows02 = blocks.find((b) => b.n === '02').rows; const row = (k) => (rows02.find((r) => r[0] === k) || [])[1];
  assert.equal(row('Ansettelsesform'), 'Fast'); assert.equal(row('Stillingsprosent'), '50 %');
});
await t('K07', 'RELEASE -005 holds: employmentForm fast and employmentType deltid stay two distinct facts through a correction; a scope value is refused as a form value and an unknown scope value is refused; neither refusal mutates the period', () => {
  const { store, id, e } = liveCase();
  apply(store, fix(id));
  assert.equal(e().terms[0].employmentForm, 'fast'); assert.equal(e().terms[0].employmentType, 'deltid');
  assert.equal(apply(store, { kind: 'correctCurrentTerms', ansattId: id, periodValidFrom: '2026-08-01', reason: 'x', terms: { employmentForm: 'deltid' }, expected: { employmentForm: 'fast' } }).code, 'EMPLOYMENTFORM_INVALID');
  assert.equal(apply(store, { kind: 'correctCurrentTerms', ansattId: id, periodValidFrom: '2026-08-01', reason: 'x', terms: { employmentType: 'heltid' }, expected: { employmentType: 'deltid' } }).code, 'EMPLOYMENTTYPE_INVALID');
  assert.equal(e().terms[0].employmentForm, 'fast'); assert.equal(e().terms[0].employmentType, 'deltid'); assert.equal(e().terms.length, 1);
});
await t('K08', 'TRUE LATER CHANGE still uses history: after the correction appendTerms (2026-11-01, 60 %, 22.5 t) creates period #2; corrected period #1 stays byte-identical at 18.75; ordering by validFrom; the audit is untouched; only the NEW latest period is now correctable', () => {
  const { store, id, e } = liveCase();
  apply(store, fix(id));
  const p1 = snap(e().terms[0]); const audit = snap(e().termsCorrections);
  assert.equal(apply(store, { kind: 'appendTerms', ansattId: id, terms: { validFrom: '2026-11-01', percentage: 60, expectedWeeklyHours: 22.5 } }).ok, true);
  assert.equal(e().terms.length, 2); assert.deepEqual(snap(e().terms[0]), p1); assert.equal(e().terms[0].expectedWeeklyHours, 18.75);
  assert.deepEqual(e().terms.map((x) => x.validFrom), ['2026-08-01', '2026-11-01']);
  assert.deepEqual(snap(e().termsCorrections), audit);
  assert.equal(correctableTermsPeriodOf(e()).validFrom, '2026-11-01');
  assert.equal(currentTermsOf(e(), '2026-10-15').expectedWeeklyHours, 18.75); assert.equal(currentTermsOf(e(), '2026-11-15').expectedWeeklyHours, 22.5);
});
await t('K09', 'HISTORICAL PERIOD BLOCK: correcting the superseded period -> TERMS_CORRECTION_PERIOD_SUPERSEDED; an unknown period -> TERMS_CORRECTION_PERIOD_UNKNOWN; record byte-identical after both', () => {
  const { store, id, e } = liveCase();
  apply(store, fix(id));
  apply(store, { kind: 'appendTerms', ansattId: id, terms: { validFrom: '2026-11-01', percentage: 60 } });
  const before = snap(e());
  assert.equal(apply(store, fix(id, { expected: { expectedWeeklyHours: 18.75 }, terms: { expectedWeeklyHours: 20 } })).code, 'TERMS_CORRECTION_PERIOD_SUPERSEDED');
  assert.equal(apply(store, fix(id, { periodValidFrom: '2026-07-01' })).code, 'TERMS_CORRECTION_PERIOD_UNKNOWN');
  assert.equal(apply(store, fix(id, { periodValidFrom: undefined })).code, 'TERMS_CORRECTION_PERIOD_UNKNOWN');
  assert.deepEqual(snap(e()), before);
});
await t('K10', 'FROZEN/SIGNED BLOCK: a ready employee is frozen through the accepted contract op; correcting the frozen period -> TERMS_PERIOD_FROZEN_IN_CONTRACT, canonical terms and the frozen snapshot unchanged, correctableTermsPeriodOf null; the declared (v1-unreachable) signert state is locked the same way', () => {
  const { store, id, e } = liveCase();
  apply(store, { kind: 'completeCurrentTerms', ansattId: id, terms: { workplace: 'Four Season Gjøvik', scheduleChangeHandling: '14 dager', paymentInterval: 'manedlig' } });
  apply(store, { kind: 'updateContact', ansattId: id, contact: { address: { street: 'Storgata 1', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1990-01-01' } });
  assert.ok(contractReadinessOf(inputsOf(e())).ready, JSON.stringify(contractReadinessOf(inputsOf(e())).missing));
  const fz = cOp(store, { kind: 'freezeVersion', ansattId: id });
  assert.equal(fz.ok, true, JSON.stringify(fz));
  assert.equal(fz.version.snapshot.terms.expectedWeeklyHours, 37.5);
  const before = snap(e());
  assert.equal(correctableTermsPeriodOf(e()), null);
  assert.equal(apply(store, fix(id)).code, 'TERMS_PERIOD_FROZEN_IN_CONTRACT');
  assert.deepEqual(snap(e()), before);
  assert.equal(hoursRow(renderContractBlocks(e().contractVersions[0].snapshot, { frozen: true, frozenAt: NOW })), '37.5 timer per uke');
  // declared signed state (no v1 op reaches it) — constructed directly to prove the lock is status-generic, not frozen-only
  const s2 = liveCase({ draft: false });
  const emp = s2.e();
  emp.contractVersions = [{ contractVersionId: 'kv-x-1', status: 'signert', termsPeriodRef: '2026-08-01', snapshot: {} }];
  assert.equal(correctableTermsPeriodOf(emp), null);
  assert.equal(apply(s2.store, fix(s2.id)).code, 'TERMS_PERIOD_FROZEN_IN_CONTRACT');
  assert.equal(s2.e().terms[0].expectedWeeklyHours, 37.5);
});
await t('K11', 'AN EDITABLE DRAFT GRANTS NOTHING: a draft never unlocks a superseded period, never unlocks a frozen period (frozen + "nytt utkast pågår"), and is itself never mutated by a refused correction', () => {
  const { store, id, e } = liveCase();
  apply(store, { kind: 'appendTerms', ansattId: id, terms: { validFrom: '2026-11-01', percentage: 60 } });
  assert.ok(draftVersionOf(e()));
  assert.equal(apply(store, fix(id)).code, 'TERMS_CORRECTION_PERIOD_SUPERSEDED');
  const s2 = liveCase();
  apply(s2.store, { kind: 'completeCurrentTerms', ansattId: s2.id, terms: { workplace: 'Four Season Gjøvik', scheduleChangeHandling: '14 dager', paymentInterval: 'manedlig' } });
  apply(s2.store, { kind: 'updateContact', ansattId: s2.id, contact: { address: { street: 'Storgata 1', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1990-01-01' } });
  assert.equal(cOp(s2.store, { kind: 'freezeVersion', ansattId: s2.id }).ok, true);
  assert.equal(cOp(s2.store, { kind: 'startDraft', ansattId: s2.id }).ok, true);   // amendment draft on top of the frozen version
  const before = snap(s2.e());
  assert.equal(apply(s2.store, fix(s2.id)).code, 'TERMS_PERIOD_FROZEN_IN_CONTRACT');
  assert.deepEqual(snap(s2.e()), before);
});
await t('K12', 'EMPTY/MALFORMED correction refused with exact codes and ZERO mutation: no field, no change, empty/blank/overlong reason, NaN/string/0/169 hours, unsupported field, validFrom, cleared value, blank field (completion job), stale or missing expected, ended employee, no clock, no actor uid, no capability', () => {
  const { store, id, e } = liveCase();
  const before = snap(e());
  const cases = [
    [fix(id, { terms: {} }), 'NO_TERMS'],
    [fix(id, { terms: undefined }), 'NO_TERMS'],
    [fix(id, { terms: { expectedWeeklyHours: 37.5 } }), 'TERMS_CORRECTION_NO_CHANGE'],
    [fix(id, { reason: '' }), 'CORRECTION_REASON_REQUIRED'],
    [fix(id, { reason: '   ' }), 'CORRECTION_REASON_REQUIRED'],
    [fix(id, { reason: undefined }), 'CORRECTION_REASON_REQUIRED'],
    [fix(id, { reason: 'x'.repeat(201) }), 'CORRECTION_REASON_TOO_LONG'],
    [fix(id, { terms: { expectedWeeklyHours: NaN } }), 'EXPECTEDWEEKLYHOURS_INVALID'],
    [fix(id, { terms: { expectedWeeklyHours: '18.75' } }), 'EXPECTEDWEEKLYHOURS_INVALID'],
    [fix(id, { terms: { expectedWeeklyHours: 0 } }), 'EXPECTEDWEEKLYHOURS_INVALID'],
    [fix(id, { terms: { expectedWeeklyHours: 169 } }), 'EXPECTEDWEEKLYHOURS_INVALID'],
    [fix(id, { terms: { foo: 1 } }), 'TERMS_FIELD_NOT_ALLOWED:foo'],
    [fix(id, { terms: { validFrom: '2026-09-01' } }), 'TERMS_FIELD_NOT_ALLOWED:validFrom'],
    [fix(id, { terms: { expectedWeeklyHours: null } }), 'TERMS_CORRECTION_VALUE_REQUIRED:expectedWeeklyHours'],
    [fix(id, { terms: { employmentBasis: 'Vikariat' }, expected: { employmentBasis: null } }), 'TERMS_CORRECTION_FIELD_BLANK:employmentBasis'],
    [fix(id, { expected: { expectedWeeklyHours: 40 } }), 'TERMS_CORRECTION_STALE:expectedWeeklyHours'],
    [fix(id, { expected: undefined }), 'TERMS_CORRECTION_STALE:expectedWeeklyHours'],
    [fix(id, { terms: { percentage: 150 }, expected: { percentage: 50 } }), 'PERCENTAGE_INVALID'],
    [fix(id, { terms: { compensation: { model: 'timelonn', hourlyRate: -1 } }, expected: { compensation: { model: 'timelonn', hourlyRate: 210 } } }), 'COMPENSATION_INVALID'],
    [fix(id, { terms: { noticePeriod: 42 }, expected: { noticePeriod: '1 måned' } }), 'TERMS_VALUE_INVALID:noticePeriod'],
    [fix(id, { terms: { role: ' ' }, expected: { role: 'butikkmedarbeider' } }), 'ROLE_REQUIRED'],
  ];
  for (const [op, code] of cases) assert.equal(apply(store, op).code, code, JSON.stringify(op.terms) + ' ' + JSON.stringify(op.reason));
  assert.deepEqual(snap(e().terms), before.terms);
  // now the clock / actor / capability refusals on a fresh record
  const s2 = liveCase(); const b2 = snap(s2.e());
  assert.equal(applyEmployeeOperation({ store: s2.store, tenantId: T, actor: ACTOR, op: fix(s2.id) }).code, 'CORRECTION_TIME_REQUIRED');
  assert.equal(apply(s2.store, fix(s2.id), Object.assign({}, ACTOR, { uid: '' })).code, 'CORRECTION_ACTOR_REQUIRED');
  assert.equal(apply(s2.store, fix(s2.id), Object.assign({}, ACTOR, { canEditEmployment: false })).code, 'NOT_AUTHORIZED');
  assert.deepEqual(snap(s2.e()), b2);
  const s3 = liveCase();
  assert.equal(apply(s3.store, { kind: 'endEmployee', ansattId: s3.id, endDate: '2026-09-30' }).ok, true);
  const b3 = snap(s3.e());
  assert.equal(correctableTermsPeriodOf(s3.e()), null);
  assert.equal(apply(s3.store, fix(s3.id)).code, 'TERMS_CORRECTION_EMPLOYEE_ENDED');
  assert.deepEqual(snap(s3.e()), b3);
});
await t('K13', 'DOWNSTREAM after correction: completeness law unchanged (no missing chip invented), Vaktplan projection keeps Timelønn 210, a compensation correction flows to the derived planning projection on the SAME period (no second copy)', () => {
  const { store, id, e } = liveCase();
  apply(store, fix(id));
  assert.deepEqual(missingInfoOf(e(), TODAY), ['mangler adresse', 'mangler kontrakt']);
  assert.deepEqual(compensationProjectionOf(e(), TODAY), { model: 'timelonn', plannedHourlyRate: 210 });
  const people = vaktplanPeopleFrom(store, T, TODAY);
  assert.equal(people.length, 1); assert.equal(people[0].name, 'Test Ansatt 01'); assert.deepEqual(people[0].compensation, { model: 'timelonn', plannedHourlyRate: 210 });
  apply(store, { kind: 'correctCurrentTerms', ansattId: id, periodValidFrom: '2026-08-01', reason: 'Feil timelønn', terms: { compensation: { model: 'timelonn', hourlyRate: 215 } }, expected: { compensation: { model: 'timelonn', hourlyRate: 210 } } });
  assert.deepEqual(compensationProjectionOf(e(), TODAY), { model: 'timelonn', plannedHourlyRate: 215 }); assert.equal(e().terms.length, 1);
});
await t('K14', 'INITIAL-PERIOD COMPLETION REGRESSION: completeCurrentTerms still fills blanks on the original period and still refuses any populated overwrite; correction refuses blanks (TERMS_CORRECTION_FIELD_BLANK) — the two actions stay distinct', () => {
  const store = { [T]: {} };
  const c = apply(store, { kind: 'createEmployee', name: 'Test Ansatt 09', startDate: '2026-08-01', role: 'butikkmedarbeider' });
  assert.equal(apply(store, { kind: 'correctCurrentTerms', ansattId: c.ansattId, periodValidFrom: '2026-08-01', reason: 'x', terms: { percentage: 50 }, expected: { percentage: null } }).code, 'TERMS_CORRECTION_FIELD_BLANK:percentage');
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { percentage: 50, expectedWeeklyHours: 37.5 } }).ok, true);
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { expectedWeeklyHours: 18.75 } }).code, 'TERMS_VALUE_ALREADY_SET:expectedWeeklyHours');
  assert.equal(apply(store, { kind: 'correctCurrentTerms', ansattId: c.ansattId, periodValidFrom: '2026-08-01', reason: REASON, terms: { expectedWeeklyHours: 18.75 }, expected: { expectedWeeklyHours: 37.5 } }).ok, true);
  assert.equal(apply(store, { kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { noticePeriod: '1 måned' } }).ok, true, 'completion still fills a remaining blank after a correction');
  const e = employeeOf(store, T, c.ansattId);
  assert.equal(e.terms.length, 1); assert.equal(e.terms[0].expectedWeeklyHours, 18.75); assert.equal(e.terms[0].noticePeriod, '1 måned'); assert.equal(e.termsCorrections.length, 1);
});

// ---- persistence: the ONE canonical document carries the audit; one transaction per correction ----
function makeFakeFs() {
  const docs = new Map(); const writes = [];
  const colOf = (p) => p.split('/').slice(0, -1).join('/'); const idOf = (p) => p.split('/').pop();
  const applyW = (w) => { for (const [kind, p, d] of w) { writes.push([kind, p, JSON.parse(JSON.stringify(d))]); if (kind === 'set') docs.set(p, JSON.parse(JSON.stringify(d))); else docs.set(p, Object.assign({}, docs.get(p), JSON.parse(JSON.stringify(d)))); } };
  const api = {
    doc: (p) => ({ path: p }), serverTimestamp: () => ({ __st: true }), newId: () => 'AuToId00000000000001',
    listen: () => () => {},
    runTransaction: async (fn) => { const w = []; const tx = { get: async (ref) => ({ exists: docs.has(ref.path), data: docs.get(ref.path) }), set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]) }; const out = await fn(tx); applyW(w); return out; },
    batch: () => { const w = []; return { set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]), commit: async () => applyW(w) }; },
  };
  const readAnsatte = () => { const out = []; for (const [p, d] of docs) if (colOf(p) === 'tenants/' + T + '/ansatte') out.push(Object.assign({ id: idOf(p) }, d)); return out; };
  return { api, docs, writes, readAnsatte };
}
await t('ADAPTER', 'normalize/write: termsCorrections is read back from e360 (absent -> []), written ONLY once non-empty (uncorrected documents keep their e360 key set), lastOp correctCurrentTerms, legacy timelonn re-projected from the corrected current period', () => {
  const legacyOnly = normalizeAnsatt('a1', { navn: 'X', stilling: 'kasse', timelonn: 200, opprettet: '2026-01-05T08:00:00.000Z' });
  assert.deepEqual(legacyOnly.termsCorrections, []);
  const { store, id, e } = liveCase({ draft: false });
  const w0 = ansattWriteFor('completeCurrentTerms', e(), { [E360_KEY]: { rev: 3 } }, NOW, TODAY);
  assert.ok(!('termsCorrections' in w0[E360_KEY]), 'no empty audit field written');
  apply(store, { kind: 'correctCurrentTerms', ansattId: id, periodValidFrom: '2026-08-01', reason: 'Feil timelønn', terms: { compensation: { model: 'timelonn', hourlyRate: 215 } }, expected: { compensation: { model: 'timelonn', hourlyRate: 210 } } });
  const w = ansattWriteFor('correctCurrentTerms', e(), { [E360_KEY]: { rev: 3 } }, NOW, TODAY);
  assert.equal(w[E360_KEY].lastOp, 'correctCurrentTerms'); assert.equal(w[E360_KEY].rev, 4); assert.equal(w.timelonn, 215); assert.equal(w.stilling, 'butikkmedarbeider');
  assert.equal(w[E360_KEY].termsCorrections.length, 1); assert.equal(w[E360_KEY].terms.length, 1);
  const back = normalizeAnsatt(id, Object.assign({ navn: 'Test Ansatt 01' }, w));
  assert.deepEqual(back.termsCorrections, snap(e().termsCorrections));
});
await t('ADAPTER-TX', 'production adapter end-to-end on a fake datastore: correction = ONE transaction update on tenants/T/ansatte/{id} (e360 + legacy projection), audit byUid = the signed-in admin uid, rev +1; a later appendTerms keeps the audit; a superseded-period correction rejects CORE_REFUSED with coreResult TERMS_CORRECTION_PERIOD_SUPERSEDED and writes nothing', async () => {
  const F = makeFakeFs();
  const ADM = { uid: 'uid-admin-1', tenantId: T, accessRole: 'admin', ansattId: null, accessEnabled: true };
  const A = createManagementAdapters({ fs: F.api, tenantId: T, membership: ADM, range: { from: '2026-09-01', to: '2026-10-31' }, readAnsatte: F.readAnsatte, defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: POLICY, nowMs: () => NOW });
  const c = await A.employees.apply({ kind: 'createEmployee', name: 'Test Ansatt 01', startDate: '2026-08-01', role: 'butikkmedarbeider' });
  await A.employees.apply({ kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentType: 'deltid', employmentForm: 'fast', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 210 }, expectedWeeklyHours: 37.5, noticePeriod: '1 måned' } });
  const path = 'tenants/' + T + '/ansatte/' + c.ansattId;
  const rev0 = F.docs.get(path)[E360_KEY].rev; const n0 = F.writes.length;
  const r = await A.employees.apply({ kind: 'correctCurrentTerms', ansattId: c.ansattId, periodValidFrom: '2026-08-01', reason: REASON, terms: { expectedWeeklyHours: 18.75 }, expected: { expectedWeeklyHours: 37.5 } });
  assert.equal(r.ok, true);
  assert.equal(F.writes.length - n0, 1); assert.equal(F.writes[n0][0], 'update'); assert.equal(F.writes[n0][1], path);
  const d = F.docs.get(path)[E360_KEY];
  assert.equal(d.rev, rev0 + 1); assert.equal(d.lastOp, 'correctCurrentTerms'); assert.equal(d.terms.length, 1); assert.equal(d.terms[0].validFrom, '2026-08-01'); assert.equal(d.terms[0].expectedWeeklyHours, 18.75); assert.equal(d.startDate, '2026-08-01');
  assert.deepEqual(d.termsCorrections, [{ at: NOW, byUid: 'uid-admin-1', reason: REASON, periodValidFrom: '2026-08-01', changes: [{ field: 'expectedWeeklyHours', before: 37.5, after: 18.75 }] }]);
  assert.equal(F.docs.get(path).timelonn, 210);
  await A.employees.apply({ kind: 'appendTerms', ansattId: c.ansattId, terms: { validFrom: '2026-11-01', percentage: 60 } });
  assert.equal(F.docs.get(path)[E360_KEY].termsCorrections.length, 1, 'audit survives the next write of the same document');
  const n1 = F.writes.length; const docBefore = snap(F.docs.get(path));
  let rej = null; try { await A.employees.apply({ kind: 'correctCurrentTerms', ansattId: c.ansattId, periodValidFrom: '2026-08-01', reason: REASON, terms: { expectedWeeklyHours: 20 }, expected: { expectedWeeklyHours: 18.75 } }); } catch (x) { rej = x; }
  assert.ok(rej && rej.code === 'CORE_REFUSED' && rej.coreResult && rej.coreResult.code === 'TERMS_CORRECTION_PERIOD_SUPERSEDED', String(rej && rej.code));
  assert.equal(F.writes.length, n1); assert.deepEqual(snap(F.docs.get(path)), docBefore);
  assert.ok(F.writes.every(([, p]) => /^tenants\/four-season-as\/ansatte\//.test(p)), 'no write outside the canonical ansatte home (no vakter, no second registry)');
  A.dispose();
});
await t('VIEW-LAW', 'management-employees-view.mjs: "Korriger gjeldende arbeidsforhold" is its own action (not the completion form), gated by the shared core eligibility, sends correctCurrentTerms with periodValidFrom + reason + expected, locks Gjelder fra, warns feilregistrering-only and points real changes to a new period; the change form is hidden while correcting; audit notes render in the period history', () => {
  const v = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');
  assert.ok(v.includes("const correctable = canEditEmployment(actor) ? correctableTermsPeriodOf(e) : null;"));
  assert.ok(v.includes("btn('Korriger gjeldende arbeidsforhold', 'btn secondary'") && v.includes("text: 'Korriger gjeldende arbeidsforhold'"));
  assert.ok(v.includes("apply({ kind: 'correctCurrentTerms', ansattId: e.ansattId, periodValidFrom: t.validFrom, reason: reason.value, terms: next, expected }"));
  assert.ok(v.includes("form.appendChild(field('Begrunnelse (påkrevd)', reason));") && v.includes("form.appendChild(field('Gjelder fra (beholdes)', vf));"));
  assert.ok(v.includes("'Bare for feilregistrering:") && v.includes("btn('Dette er en reell endring – registrer ny periode'"));
  assert.ok(v.includes("(!completion || arbeidChangeOpen) && !arbeidCorrectOpen"));
  assert.ok(v.includes("cls: 'bits emp-corr'"));
  const arbeid = v.slice(v.indexOf('  function drawArbeid(e, cur) {'), v.indexOf('    const hist = el(', v.indexOf('  function drawArbeid(e, cur) {')));
  assert.equal((arbeid.match(/textInput\(todayWd, null, 'date'\)/g) || []).length, 1, 'correction never offers a date: only the genuine new period defaults to today');
  assert.ok(!/kind: 'correctCurrentTerms'[^\n]*validFrom:/.test(v), 'the correction op never carries a new validFrom');
});

for (const l of lines) console.log(l);
console.log('MANAGEMENT_CURRENT_PERIOD_CORRECTION_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
