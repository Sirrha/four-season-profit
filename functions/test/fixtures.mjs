// fixtures.mjs — SYNTHETIC frozen contract for BID-1 proofs. Built through the ACCEPTED cores exactly like the owner flow
// (create -> complete terms -> contact -> Avtaleoppsett -> startDraft -> reviewed freeze). Never Herish's live data.
// No national identity number anywhere; all persons are fictitious.
import { applyEmployeeOperation, employeeOf } from '../../management-employees-core.mjs';
import { applyContractOperation, contractInputsFor, draftVersionOf } from '../../management-contract-core.mjs';
import { FOUR_SEASON_CONTRACT_PROFILE, ROLE_LABELS } from '../../employee-schedule-fixture.mjs';

export const T = 'four-season-as';
export const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);   // 2026-09-29 14:00 Oslo (fixed; generator never reads a clock)
export const TODAY = '2026-09-29';
export const ADMIN_UID = 'uid-admin-herish';          // designated employer representative (local fixture only)
export const OTHER_ADMIN_UID = 'uid-admin-other';     // admin who is NOT the designated signer
export const EMPLOYEE_UID = 'uid-employee-01';
export const OTHER_EMPLOYEE_UID = 'uid-employee-02';
const ACTOR = { uid: ADMIN_UID, accessRole: 'admin', ansattId: null, accessEnabled: true, tenantId: T, canManageSchedule: true, canViewOwnSchedule: false, canViewEmployeeCore: true, canViewEmployeeCompensation: true, canEditEmployment: true };
const snap = (v) => JSON.parse(JSON.stringify(v));
export const profileOf = (over) => Object.assign(snap(FOUR_SEASON_CONTRACT_PROFILE), { companyFacts: { salaryPaymentArrangement: 'Den 15. hver måned', pension: { applies: true, provider: 'Storebrand' }, occupationalInjuryInsurance: { applies: true, insurer: 'Gjensidige' }, tariffavtale: { applies: false } } }, over || {});

// Returns { store, ansattId, employee(), version (deep copy of the frozen version as stored) }
export function frozenEmployee1(over) {
  const o = over || {};
  const store = { [T]: {} };
  const ap = (op) => { const r = applyEmployeeOperation({ store, tenantId: T, actor: ACTOR, op, now: NOW }); if (!r.ok) throw new Error('fixture op ' + op.kind + ' ' + r.code); return r; };
  const c = ap({ kind: 'createEmployee', name: o.name || 'Test Ansatt 01', startDate: '2026-08-01', role: 'butikkmedarbeider' });
  ap({ kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentType: 'deltid', percentage: 50, compensation: { model: 'timelonn', hourlyRate: o.hourlyRate || 210 }, expectedWeeklyHours: o.hours || 18.75, noticePeriod: '1 måned' } });
  ap({ kind: 'completeCurrentTerms', ansattId: c.ansattId, terms: { employmentForm: 'fast', workplace: 'Four Season Gjøvik', workingTimeArrangement: 'Arbeidstid etter vaktplan', probation: 'ingen', breaksArrangement: '30', scheduleChangeHandling: 'Vaktplan varsles 14 dager før', paymentInterval: 'manedlig' } });
  ap({ kind: 'updateContact', ansattId: c.ansattId, contact: { address: { street: 'Storgata 1', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1995-04-12', phone: '40000000', email: 'test01@example.test' } });
  const profile = profileOf();
  const cOp = (op, extra) => { const r = applyContractOperation(Object.assign({ store, tenantId: T, actor: ACTOR, op, profile, now: NOW, onDate: TODAY, roleLabels: ROLE_LABELS }, extra || {})); if (!r.ok) throw new Error('fixture contract ' + op.kind + ' ' + r.code); return r; };
  cOp({ kind: 'startDraft', ansattId: c.ansattId });
  const employee = () => employeeOf(store, T, c.ansattId);
  if (o.freeze !== false) {
    const draft = draftVersionOf(employee());
    cOp({ kind: 'freezeVersion', ansattId: c.ansattId, contractVersionId: draft.contractVersionId, expectedInputs: snap(contractInputsFor({ employee: employee(), profile, onDate: TODAY, roleLabels: ROLE_LABELS })) }, { requireReviewedInputs: true });
  }
  const versions = employee().contractVersions;
  return { store, ansattId: c.ansattId, employee, version: snap(versions[versions.length - 1]) };
}
