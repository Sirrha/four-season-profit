// employee-self-projection.mjs
// MIN ANSETTELSE — least-privilege employee-readable projection (S4 foundation; OD-4 ratified
// 2026-09-25, HERISH-SIRRHA-S4-OWNER-RATIFICATIONS-FREEZE-001). PURE: no DOM, no network, no clock.
//
// ONE employee truth: the projection is DERIVED from the canonical employee record through the
// SAME helpers the management surfaces use (management-employees-core: currentTermsOf / startDateOf /
// contractStatusOf) and is written only by the management (admin) path. Employees never write it.
// The shell consumes it back through employeeSelfToShellEmployee(), which rebuilds exactly the
// in-memory shape employee-myjob's Min ansettelse already renders — no UI change.
//
// Production document: tenants/{tenantId}/employeeSelf/{ansattId}  (ansattId = PATH identity, never a field)
//   business: name, role, employmentType, percentage, workplace, startDate, expectedWeeklyHours, hasContract
//   audit:    derivedAt (server timestamp, written by the adapter), sourceRevision (int|null)
// NEVER present: compensation/wage/timelonn, bank account, personnummer, management notes, contact,
// birth date, contract text, non-displayed term fields.

import { currentTermsOf, startDateOf, contractStatusOf } from './management-employees-core.mjs';

export const EMPLOYEE_SELF_FIELDS = Object.freeze(['name', 'role', 'employmentType', 'percentage', 'workplace', 'startDate', 'expectedWeeklyHours', 'hasContract']);
export const EMPLOYEE_SELF_AUDIT_FIELDS = Object.freeze(['derivedAt', 'sourceRevision']);
export const EMPLOYEE_SELF_DOC_FIELDS = Object.freeze([...EMPLOYEE_SELF_FIELDS, ...EMPLOYEE_SELF_AUDIT_FIELDS]);
export const EMPLOYMENT_TYPES = Object.freeze(['fast', 'deltid', 'tilkalling', 'midlertidig']);
// Names that must never appear in an employee-readable document (defensive list; hasOnly is the real gate).
export const EMPLOYEE_SELF_FORBIDDEN = Object.freeze(['compensation', 'hourlyRate', 'monthlySalary', 'timelonn', 'wage', 'bankkonto', 'bankAccount', 'personnummer', 'notater', 'notes', 'contact', 'birthDate', 'address', 'email', 'phone', 'contractVersions', 'documents', 'terms', 'endedAt', 'ansattId']);

const WD_RE = /^\d{4}-\d{2}-\d{2}$/;
const isWd = (v) => typeof v === 'string' && WD_RE.test(v);
const strOrNull = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Derive the projection from the canonical employee record as of `onDate` (tenant work date).
 * Missing facts stay null (rendered as "Ikke registrert" by the accepted UI); nothing is invented.
 */
export function projectEmployeeSelf(employee, onDate) {
  if (!employee || typeof employee !== 'object' || !Array.isArray(employee.terms) || employee.terms.length === 0) return null;
  const t = isWd(onDate) ? currentTermsOf(employee, onDate) : null;
  const pct = t && typeof t.percentage === 'number' && Number.isFinite(t.percentage) && t.percentage >= 0 && t.percentage <= 100 ? t.percentage : null;
  const ewh = t && typeof t.expectedWeeklyHours === 'number' && Number.isFinite(t.expectedWeeklyHours) && t.expectedWeeklyHours >= 0 ? t.expectedWeeklyHours : null;
  const startDate = isWd(startDateOf(employee)) ? startDateOf(employee) : null;
  return Object.freeze({
    name: typeof employee.name === 'string' ? employee.name : '',
    role: t ? strOrNull(t.role) : null,
    employmentType: t && EMPLOYMENT_TYPES.includes(t.employmentType) ? t.employmentType : null,
    percentage: pct,
    workplace: t ? strOrNull(t.workplace) : null,
    startDate,
    expectedWeeklyHours: ewh,
    hasContract: contractStatusOf(employee) === 'finnes',
  });
}

/** Structural validation of an employeeSelf document (as read or about to be written). Fail-closed. */
export function validateEmployeeSelfDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, code: 'DOC_MALFORMED' };
  const keys = Object.keys(doc);
  for (const k of keys) if (!EMPLOYEE_SELF_DOC_FIELDS.includes(k)) return { ok: false, code: 'FIELD_FORBIDDEN:' + k };
  for (const k of EMPLOYEE_SELF_DOC_FIELDS) if (!(k in doc)) return { ok: false, code: 'FIELD_MISSING:' + k };
  if (typeof doc.name !== 'string') return { ok: false, code: 'NAME_INVALID' };
  if (!(doc.role === null || typeof doc.role === 'string')) return { ok: false, code: 'ROLE_INVALID' };
  if (!(doc.employmentType === null || EMPLOYMENT_TYPES.includes(doc.employmentType))) return { ok: false, code: 'EMPLOYMENT_TYPE_INVALID' };
  if (!(doc.percentage === null || (typeof doc.percentage === 'number' && Number.isFinite(doc.percentage) && doc.percentage >= 0 && doc.percentage <= 100))) return { ok: false, code: 'PERCENTAGE_INVALID' };
  if (!(doc.workplace === null || typeof doc.workplace === 'string')) return { ok: false, code: 'WORKPLACE_INVALID' };
  if (!(doc.startDate === null || isWd(doc.startDate))) return { ok: false, code: 'STARTDATE_INVALID' };
  if (!(doc.expectedWeeklyHours === null || (typeof doc.expectedWeeklyHours === 'number' && Number.isFinite(doc.expectedWeeklyHours) && doc.expectedWeeklyHours >= 0))) return { ok: false, code: 'EXPECTED_HOURS_INVALID' };
  if (typeof doc.hasContract !== 'boolean') return { ok: false, code: 'HASCONTRACT_INVALID' };
  if (!(doc.sourceRevision === null || Number.isInteger(doc.sourceRevision))) return { ok: false, code: 'SOURCE_REVISION_INVALID' };
  return { ok: true };
}

/**
 * Rebuild the in-memory employee shape the accepted shell consumes (employeeOf → currentTermsOf /
 * startDateOf / contractStatusOf → minAnsettelseFra). Only the projected facts are present; every
 * other field is the honest empty value. ansattId comes from the PATH, never from the document.
 */
export function employeeSelfToShellEmployee(ansattId, doc) {
  if (typeof ansattId !== 'string' || !ansattId || !doc || typeof doc !== 'object') return null;
  const terms = {
    validFrom: isWd(doc.startDate) ? doc.startDate : null,
    role: strOrNull(doc.role),
    employmentType: EMPLOYMENT_TYPES.includes(doc.employmentType) ? doc.employmentType : null,
    percentage: typeof doc.percentage === 'number' ? doc.percentage : null,
    compensation: null,
    workplace: strOrNull(doc.workplace),
    expectedWeeklyHours: typeof doc.expectedWeeklyHours === 'number' ? doc.expectedWeeklyHours : null,
    workingTimeArrangement: null, probation: null, noticePeriod: null, breaksArrangement: null,
    scheduleChangeHandling: null, employmentBasis: null, employmentEndDate: null, paymentInterval: null,
  };
  return {
    ansattId,
    name: typeof doc.name === 'string' ? doc.name : '',
    contact: { email: null, phone: null, address: null, birthDate: null },
    status: 'active', endedAt: null,
    terms: [terms],
    documents: doc.hasContract === true ? [{ docId: 'self-kontrakt', name: 'Arbeidskontrakt', category: 'kontrakt', date: terms.validFrom, source: 'projeksjon', note: null }] : [],
    contractVersions: [],
  };
}
