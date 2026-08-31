// management-employees-core.mjs
// EMPLOYEE 360 / ANSATTSIDE CORE — PURE. No DOM, no clock read, no storage, no network.
// Governing: SOREN-SIRRHA-EMPLOYEE-360-ANSATTSIDE-FIRST-REAL-PRODUCT-DESIGN-001 + Sirrha
// corrections C1-C3. ONE EMPLOYEE, ONE HOME — SAME TRUTH, DIFFERENT DOORWAY:
// - Employment terms are an ORDERED IMMUTABLE list (frozen records, append-only). validTo is
//   DERIVED from the next period's validFrom — never stored, never mutated onto older records.
// - The FIRST terms period's validFrom IS the employee start date (no second start-date truth).
// - Compensation is stored ONCE, inside employment terms. Vaktplan's planning compensation is a
//   DERIVED projection of the CURRENT terms (vaktplanPeopleFrom) — never a stored second copy.
// - Legacy payable ansatte.timelonn (index.html) is never read, written, mirrored or displayed.
// - Incomplete employees are VALID; missing-info markers are derived from missing fields.
// - NO sensitive national/financial identifiers (no fødselsnummer/bank/tax-card/next-of-kin
//   fields exist), no uid/account link, document METADATA only (file/blob/url keys fail closed).
// Local in-memory fixture model — refresh may re-seed; no persistence claim, no production auth.

import { tenantShiftsOf, durationHoursOf, scopeDaysOf, shiftsForEmployee } from './management-schedule-core.mjs';

const WD_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (v) => Math.round(v * 100) / 100;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
function keysOutside(obj, allowed) { for (const k of Object.keys(obj)) if (!allowed.includes(k)) return k; return null; }

export const TERMS_FIELDS = ['validFrom', 'role', 'employmentType', 'percentage', 'compensation', 'workplace', 'expectedWeeklyHours', 'workingTimeArrangement', 'probation', 'noticePeriod'];
export const EMPLOYMENT_TYPES = ['fast', 'deltid', 'tilkalling'];
const DOC_FIELDS = ['name', 'category', 'date', 'source', 'note'];
export const DOC_CATEGORIES = ['kontrakt', 'tillegg', 'attest', 'annet'];
const CONTACT_FIELDS = ['email', 'phone'];

// Terms compensation shape (stored ONCE, here): { model:'timelonn', hourlyRate } or
// { model:'fastlonn', monthlySalary } or null/absent (derived unknown; never zero).
function validCompensation(c) {
  if (c == null) return true;
  if (typeof c !== 'object') return false;
  if (c.model === 'timelonn') return Number.isFinite(c.hourlyRate) && c.hourlyRate > 0 && keysOutside(c, ['model', 'hourlyRate']) === null;
  if (c.model === 'fastlonn') return Number.isFinite(c.monthlySalary) && c.monthlySalary > 0 && keysOutside(c, ['model', 'monthlySalary']) === null;
  return false;
}
function freezeTerms(t) { if (t.compensation) Object.freeze(t.compensation); return Object.freeze(t); }

// ---- capability gates (production-compatible SHAPE only; UI hiding is not authorization) ----
export function canViewEmployees(actor) { return !!(actor && actor.accessEnabled === true && actor.canViewEmployeeCore === true); }
export function canViewCompensation(actor) { return !!(actor && actor.accessEnabled === true && actor.canViewEmployeeCompensation === true); }
export function canEditEmployment(actor) { return !!(actor && actor.accessEnabled === true && actor.canEditEmployment === true); }

// ---- store: { [tenantId]: { [ansattId]: employee } } (tenant-explicit; ansattId tenant-scoped) --
// Seeds the five review employees. person.compensation on the fixture people list is SEED INPUT
// consumed exactly once here into the first terms period; runtime Vaktplan reads the derived
// terms projection, never the person field. Contact stays blank (C2). Deterministic demo dates.
export function seedFourSeasonEmployees(people, tenantId) {
  const SEED = {
    'ans-maria': { validFrom: '2023-03-01', employmentType: 'fast', percentage: 100, kontrakt: true },
    'ans-aboud': { validFrom: '2024-06-15', employmentType: 'deltid', percentage: 40, kontrakt: false },
    'ans-yussef': { validFrom: '2025-01-10', employmentType: 'deltid', percentage: null, kontrakt: false },
    'ans-athar': { validFrom: '2022-08-01', employmentType: 'fast', percentage: 100, kontrakt: true },
    'ans-herish': { validFrom: '2021-01-01', employmentType: 'fast', percentage: 100, kontrakt: false },
  };
  const tenant = {};
  for (const p of (Array.isArray(people) ? people : [])) {
    const s = SEED[p.ansattId] || { validFrom: '2026-01-01', employmentType: null, percentage: null, kontrakt: false };
    let comp = null;
    const c = p.compensation;
    if (c && c.model === 'timelonn' && Number.isFinite(c.plannedHourlyRate) && c.plannedHourlyRate > 0) comp = { model: 'timelonn', hourlyRate: c.plannedHourlyRate };
    if (c && c.model === 'fastlonn' && Number.isFinite(c.plannedMonthlySalary) && c.plannedMonthlySalary > 0) comp = { model: 'fastlonn', monthlySalary: c.plannedMonthlySalary };
    tenant[p.ansattId] = {
      ansattId: p.ansattId, name: p.name,
      contact: { email: null, phone: null },
      status: 'active', endedAt: null,
      terms: [freezeTerms({ validFrom: s.validFrom, role: p.roleKey, employmentType: s.employmentType, percentage: s.percentage, compensation: comp, workplace: 'Four Season', expectedWeeklyHours: null, workingTimeArrangement: null, probation: null, noticePeriod: null })],
      documents: s.kontrakt ? [{ docId: 'doc-' + p.ansattId + '-1', name: 'Arbeidskontrakt', category: 'kontrakt', date: s.validFrom, source: 'registrert manuelt', note: null }] : [],
    };
  }
  return { [tenantId]: tenant };
}

export function employeesOf(store, tenantId) {
  if (!store || typeof store !== 'object' || typeof tenantId !== 'string' || !tenantId) return [];
  const tenant = Object.prototype.hasOwnProperty.call(store, tenantId) ? store[tenantId] : null;
  if (!tenant || typeof tenant !== 'object') return [];
  return Object.keys(tenant).map((k) => tenant[k]).sort((a, b) => a.name.localeCompare(b.name, 'nb'));
}
export function employeeOf(store, tenantId, ansattId) {
  if (!store || typeof store !== 'object' || typeof tenantId !== 'string' || !tenantId) return null;
  const tenant = Object.prototype.hasOwnProperty.call(store, tenantId) ? store[tenantId] : null;
  if (!tenant || typeof ansattId !== 'string' || !Object.prototype.hasOwnProperty.call(tenant, ansattId)) return null;
  return tenant[ansattId];
}

// ---- pure derivations -----------------------------------------------------------------------
// Start date IS the first terms period's validFrom (single truth, C1).
export function startDateOf(employee) { return employee.terms[0].validFrom; }
// Current terms = latest validFrom on/before onDate; null when onDate precedes the first period.
export function currentTermsOf(employee, onDate) {
  let cur = null;
  for (const t of employee.terms) { if (t.validFrom <= onDate) cur = t; else break; }
  return cur;
}
// Newest first, with DERIVED validTo (next period's validFrom; latest is open-ended null).
export function termsWithRanges(employee) {
  return employee.terms.map((t, i) => ({
    terms: t, validFrom: t.validFrom,
    validTo: i + 1 < employee.terms.length ? employee.terms[i + 1].validFrom : null,
  })).reverse();
}
export function contractStatusOf(employee) { return employee.documents.some((d) => d.category === 'kontrakt') ? 'finnes' : 'mangler'; }
// Missing-info markers are DERIVED from missing fields — never stored flags. Missing is valid.
export function missingInfoOf(employee, onDate) {
  const t = currentTermsOf(employee, onDate) || employee.terms[employee.terms.length - 1];
  const out = [];
  if (!t || t.employmentType == null) out.push('mangler stillingstype');
  if (!t || t.percentage == null) out.push('mangler arbeidsprosent');
  if (!t || t.compensation == null) out.push('mangler lønnsgrunnlag');
  if (contractStatusOf(employee) === 'mangler') out.push('mangler kontrakt');
  return out;
}
// Vaktplan planning-compensation PROJECTION of the CURRENT terms (derived, never stored twice).
export function compensationProjectionOf(employee, onDate) {
  const t = currentTermsOf(employee, onDate);
  const c = t && t.compensation;
  if (c && c.model === 'timelonn' && Number.isFinite(c.hourlyRate) && c.hourlyRate > 0) return { model: 'timelonn', plannedHourlyRate: c.hourlyRate };
  if (c && c.model === 'fastlonn' && Number.isFinite(c.monthlySalary) && c.monthlySalary > 0) return { model: 'fastlonn', plannedMonthlySalary: c.monthlySalary };
  return null;   // Vaktplan derives its established unknown/missing behavior (never zero)
}
// Person-like rows for the EXISTING Vaktplan surface: ACTIVE employees only; roleKey = current
// role; compensation = derived projection of current employment terms. THE rewire (design H).
export function vaktplanPeopleFrom(store, tenantId, onDate) {
  return employeesOf(store, tenantId).filter((e) => e.status === 'active').map((e) => {
    const t = currentTermsOf(e, onDate) || e.terms[0];
    const person = { ansattId: e.ansattId, name: e.name, roleKey: t ? t.role : null };
    const comp = compensationProjectionOf(e, onDate);
    if (comp) person.compensation = comp;
    return person;
  });
}

// ---- schedule reuse (delegates to the existing shared truth path; never a 2nd calculation) --
export function plannedHoursForEmployee(scheduleContainer, tenantId, ansattId, scope) {
  const inScope = new Set(scopeDaysOf(scope));
  let h = 0;
  for (const s of tenantShiftsOf(scheduleContainer, tenantId)) {
    if (s.projection.ansattId !== ansattId || s.projection.status !== 'assigned') continue;
    if (!inScope.has(s.projection.workDate)) continue;
    h += durationHoursOf(s.projection);
  }
  return r2(h);
}
export function upcomingShiftsForEmployee(scheduleContainer, tenantId, ansattId, actor, nowMs, limit) {
  return shiftsForEmployee(scheduleContainer, tenantId, ansattId, actor)
    .filter((s) => s.projection.status === 'assigned' && s.projection.plannedStartAt > nowMs)
    .slice(0, limit || 3);
}

// ---- THE single employee operation boundary -------------------------------------------------
// All employee mutations flow through here; view code never mutates arrays/objects directly.
// Fail-closed on tenant/actor/capability/shape. No delete path exists (end, never delete).
export function applyEmployeeOperation({ store, tenantId, actor, op, now }) {
  if (!store || typeof store !== 'object') return { ok: false, code: 'NO_STORE' };
  if (typeof tenantId !== 'string' || !tenantId || !Object.prototype.hasOwnProperty.call(store, tenantId)) return { ok: false, code: 'TENANT_UNKNOWN' };
  const tenant = store[tenantId];
  if (!tenant || typeof tenant !== 'object') return { ok: false, code: 'TENANT_UNKNOWN' };
  if (!canEditEmployment(actor)) return { ok: false, code: 'NOT_AUTHORIZED' };
  if (!op || typeof op !== 'object') return { ok: false, code: 'NO_OPERATION' };

  if (op.kind === 'createEmployee') {
    // Exactly THREE required semantic facts: navn + startdato + stilling/rolle.
    if (!nonEmpty(op.name)) return { ok: false, code: 'NAME_REQUIRED' };
    if (!WD_RE.test(op.startDate || '')) return { ok: false, code: 'STARTDATE_INVALID' };
    if (!nonEmpty(op.role)) return { ok: false, code: 'ROLE_REQUIRED' };
    const slug = op.name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ansatt';
    let ansattId = 'ans-' + slug, n = 1;
    while (Object.prototype.hasOwnProperty.call(tenant, ansattId)) { n += 1; ansattId = 'ans-' + slug + '-' + n; }
    const emp = {
      ansattId, name: op.name.trim(),
      contact: { email: null, phone: null },
      status: 'active', endedAt: null,
      terms: [freezeTerms({ validFrom: op.startDate, role: op.role, employmentType: null, percentage: null, compensation: null, workplace: null, expectedWeeklyHours: null, workingTimeArrangement: null, probation: null, noticePeriod: null })],
      documents: [],
    };
    tenant[ansattId] = emp;
    return { ok: true, ansattId, employee: emp };
  }

  const ansattId = op.ansattId;
  const emp = typeof ansattId === 'string' && Object.prototype.hasOwnProperty.call(tenant, ansattId) ? tenant[ansattId] : null;
  if (!emp) return { ok: false, code: 'EMPLOYEE_UNKNOWN' };

  if (op.kind === 'updateContact') {
    const patch = op.contact;
    if (!patch || typeof patch !== 'object') return { ok: false, code: 'NO_PATCH' };
    const bad = keysOutside(patch, CONTACT_FIELDS);
    if (bad) return { ok: false, code: 'CONTACT_FIELD_NOT_ALLOWED:' + bad };
    for (const k of CONTACT_FIELDS) {
      if (!(k in patch)) continue;
      if (!(patch[k] === null || typeof patch[k] === 'string')) return { ok: false, code: 'CONTACT_VALUE_INVALID' };
    }
    for (const k of CONTACT_FIELDS) if (k in patch) emp.contact[k] = (patch[k] === '' ? null : patch[k]);
    return { ok: true, ansattId, employee: emp };            // terms history untouched (tested)
  }

  if (op.kind === 'appendTerms') {
    const input = op.terms;
    if (!input || typeof input !== 'object') return { ok: false, code: 'NO_TERMS' };
    const bad = keysOutside(input, TERMS_FIELDS);
    if (bad) return { ok: false, code: 'TERMS_FIELD_NOT_ALLOWED:' + bad };
    if (!WD_RE.test(input.validFrom || '')) return { ok: false, code: 'VALIDFROM_INVALID' };
    if (emp.terms.some((t) => t.validFrom === input.validFrom)) return { ok: false, code: 'TERMS_DUPLICATE_VALIDFROM' };  // fail closed; never overwrite
    if ('compensation' in input && !validCompensation(input.compensation)) return { ok: false, code: 'COMPENSATION_INVALID' };
    if ('percentage' in input && input.percentage != null && !(Number.isFinite(input.percentage) && input.percentage > 0 && input.percentage <= 100)) return { ok: false, code: 'PERCENTAGE_INVALID' };
    if ('employmentType' in input && input.employmentType != null && !EMPLOYMENT_TYPES.includes(input.employmentType)) return { ok: false, code: 'EMPLOYMENTTYPE_INVALID' };
    // FULL SNAPSHOT (C1): carry the latest period's facts forward, override the provided keys.
    // Earlier records are frozen and are NEVER touched; validTo stays derived at read time.
    const base = emp.terms[emp.terms.length - 1];
    const snap = {};
    for (const f of TERMS_FIELDS) snap[f] = (f in input) ? input[f] : base[f];
    snap.validFrom = input.validFrom;
    if (!nonEmpty(snap.role)) return { ok: false, code: 'ROLE_REQUIRED' };
    const rec = freezeTerms(snap);
    emp.terms = emp.terms.concat([rec]).sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
    return { ok: true, ansattId, terms: rec, employee: emp };
  }

  if (op.kind === 'endEmployee') {
    if (!WD_RE.test(op.endDate || '')) return { ok: false, code: 'ENDDATE_INVALID' };
    if (emp.status === 'ended') return { ok: false, code: 'ALREADY_ENDED' };
    emp.status = 'ended'; emp.endedAt = op.endDate;          // never delete; history remains inspectable
    return { ok: true, ansattId, employee: emp };
  }

  if (op.kind === 'addDocument') {
    const d = op.doc;
    if (!d || typeof d !== 'object') return { ok: false, code: 'NO_DOC' };
    const bad = keysOutside(d, DOC_FIELDS);                   // file/blob/url/payload keys fail closed
    if (bad) return { ok: false, code: 'DOC_FIELD_NOT_ALLOWED:' + bad };
    if (!nonEmpty(d.name)) return { ok: false, code: 'DOC_NAME_REQUIRED' };
    if (!DOC_CATEGORIES.includes(d.category)) return { ok: false, code: 'DOC_CATEGORY_INVALID' };
    let n = emp.documents.length + 1, docId = 'doc-' + ansattId + '-' + n;
    while (emp.documents.some((x) => x.docId === docId)) { n += 1; docId = 'doc-' + ansattId + '-' + n; }
    const doc = { docId, name: d.name.trim(), category: d.category, date: WD_RE.test(d.date || '') ? d.date : null, source: nonEmpty(d.source) ? d.source.trim() : 'registrert manuelt', note: nonEmpty(d.note) ? d.note.trim() : null };
    emp.documents = emp.documents.concat([doc]);
    return { ok: true, ansattId, doc, employee: emp };
  }

  if (op.kind === 'removeDocument') {
    const before = emp.documents.length;
    emp.documents = emp.documents.filter((x) => x.docId !== op.docId);
    if (emp.documents.length === before) return { ok: false, code: 'DOC_UNKNOWN' };
    return { ok: true, ansattId, employee: emp };
  }

  return { ok: false, code: 'UNKNOWN_OPERATION' };
}
