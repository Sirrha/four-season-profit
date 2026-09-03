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
import { tenantWorkDate } from './employee-shell-core.mjs';

const WD_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TENANT_TIMEZONE = 'Europe/Oslo';
export const BIRTHDATE_FLOOR = '1900-01-01';
const POSTAL_RE = /^\d{4}$/;
export const ADDRESS_MISSING = 'Ikke registrert';
const r2 = (v) => Math.round(v * 100) / 100;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
function keysOutside(obj, allowed) { for (const k of Object.keys(obj)) if (!allowed.includes(k)) return k; return null; }

// Employment-terms fields. The first ten are the accepted Employee 360 foundation set and are
// REUSED unchanged by the contract flow (Sirrha C3: existing equivalent fields win over
// duplication — workingTimeArrangement, probation, noticePeriod and workplace already exist and
// are NOT duplicated; C2: workplace stays here, never on the employee record). The last five are
// the genuinely missing contract-relevant EMPLOYMENT facts (they have history that matters, so
// they belong in the terms period, not in a contract object).
export const TERMS_FIELDS = ['validFrom', 'role', 'employmentType', 'percentage', 'compensation', 'workplace', 'expectedWeeklyHours', 'workingTimeArrangement', 'probation', 'noticePeriod',
  'breaksArrangement', 'scheduleChangeHandling', 'employmentBasis', 'employmentEndDate', 'paymentInterval'];
const NEW_TERMS_FIELDS = ['breaksArrangement', 'scheduleChangeHandling', 'employmentBasis', 'employmentEndDate', 'paymentInterval'];
export const EMPLOYMENT_TYPES = ['fast', 'deltid', 'tilkalling', 'midlertidig'];
export const PAYMENT_INTERVALS = ['manedlig', 'hver-14-dag'];
const DOC_FIELDS = ['name', 'category', 'date', 'source', 'note'];
export const DOC_CATEGORIES = ['kontrakt', 'tillegg', 'attest', 'annet'];
// address + birthDate are owner-approved canonical person facts (Identity/Company-facts
// refinement). Sensitive identifiers (fødselsnummer, kontonummer) are NOT contact fields and
// stay rejected — they activate only after a later Login/Security gate.
const CONTACT_FIELDS = ['email', 'phone', 'address', 'birthDate'];

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

// ---- CANONICAL ADDRESS: ONE structured object at employee.contact.address ---------------------
// { street, postalCode, city } — postalCode is a STRING so a leading zero ("0150") survives.
// A pre-shape local record holding a free-text string is REPRESENTED (never parsed, never
// guessed) as empty structured fields plus `legacyText`, a verbatim transcription aid that no
// renderer or formatter may read and that the first successful structured save clears.
export function normalizeAddress(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return value.trim() === '' ? null : { street: '', postalCode: '', city: '', legacyText: value };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {
    street: typeof value.street === 'string' ? value.street : '',
    postalCode: typeof value.postalCode === 'string' ? value.postalCode : '',
    city: typeof value.city === 'string' ? value.city : '',
  };
  if (typeof value.legacyText === 'string' && value.legacyText !== '') out.legacyText = value.legacyText;
  return out;
}
export function addressIsComplete(value) {
  const a = normalizeAddress(value);
  return !!(a && nonEmpty(a.street) && POSTAL_RE.test(a.postalCode) && nonEmpty(a.city));
}
// THE ONE shared address derivation — Employee 360 display, contract draft/preview and
// Print/PDF all call this single formatter. Never reads legacyText; never emits a partial line.
export function formatAddress(value, missingMarker) {
  const a = normalizeAddress(value);
  if (!addressIsComplete(a)) return missingMarker == null ? ADDRESS_MISSING : missingMarker;
  return a.street + ', ' + a.postalCode + ' ' + a.city;
}
// Owner-supplied address patch. Trim is the ONLY normalization: no case rewriting, reordering,
// guessing, city lookup or postal-registry autofill. Rejection never mutates the record.
function validateAddressPatch(v) {
  if (v == null) return { ok: true, value: null };
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: 'ADDRESS_INVALID' };
  const bad = keysOutside(v, ['street', 'postalCode', 'city']);   // legacyText is never owner-writable
  if (bad) return { ok: false, code: 'ADDRESS_FIELD_NOT_ALLOWED:' + bad };
  const street = typeof v.street === 'string' ? v.street.trim() : '';
  const postalCode = typeof v.postalCode === 'string' ? v.postalCode.trim() : '';
  const city = typeof v.city === 'string' ? v.city.trim() : '';
  if (!nonEmpty(street)) return { ok: false, code: 'ADDRESS_STREET_REQUIRED' };
  if (!POSTAL_RE.test(postalCode)) return { ok: false, code: 'ADDRESS_POSTALCODE_INVALID' };
  if (!nonEmpty(city)) return { ok: false, code: 'ADDRESS_CITY_REQUIRED' };
  return { ok: true, value: { street, postalCode, city } };        // legacyText cleared by construction
}

// ---- BIRTHDATE TRUTH INVARIANT ---------------------------------------------------------------
// Real calendar date (31.02 is rejected, NEVER JS-normalized into another day), >= 1900-01-01,
// and strictly before the TENANT-LOCAL (Europe/Oslo) today. No coercion, clamping, day/month
// swapping or century guessing anywhere on the path. Storage stays the existing ISO work-date.
export function birthDateProblem(v, todayWd) {
  if (typeof v !== 'string' || !WD_RE.test(v)) return 'BIRTHDATE_INVALID';
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return 'BIRTHDATE_INVALID';
  if (v < BIRTHDATE_FLOOR) return 'BIRTHDATE_BEFORE_1900';
  if (typeof todayWd === 'string' && WD_RE.test(todayWd) && v >= todayWd) return 'BIRTHDATE_FUTURE';
  return null;
}
export function isValidBirthDate(v, todayWd) { return birthDateProblem(v, todayWd) === null; }

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
      contact: { email: null, phone: null, address: null, birthDate: null },
      status: 'active', endedAt: null,
      terms: [freezeTerms({ validFrom: s.validFrom, role: p.roleKey, employmentType: s.employmentType, percentage: s.percentage, compensation: comp, workplace: 'Four Season', expectedWeeklyHours: null, workingTimeArrangement: null, probation: null, noticePeriod: null, breaksArrangement: null, scheduleChangeHandling: null, employmentBasis: null, employmentEndDate: null, paymentInterval: null })],
      documents: s.kontrakt ? [{ docId: 'doc-' + p.ansattId + '-1', name: 'Arbeidskontrakt', category: 'kontrakt', date: s.validFrom, source: 'registrert manuelt', note: null }] : [],
      contractVersions: [],          // append-only; written ONLY by the contract operation boundary
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
  if (!addressIsComplete(employee.contact && employee.contact.address)) out.push('mangler adresse');
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
export function applyEmployeeOperation({ store, tenantId, actor, op, now, timezone }) {
  if (!store || typeof store !== 'object') return { ok: false, code: 'NO_STORE' };
  if (typeof tenantId !== 'string' || !tenantId || !Object.prototype.hasOwnProperty.call(store, tenantId)) return { ok: false, code: 'TENANT_UNKNOWN' };
  const tenant = store[tenantId];
  if (!tenant || typeof tenant !== 'object') return { ok: false, code: 'TENANT_UNKNOWN' };
  if (!canEditEmployment(actor)) return { ok: false, code: 'NOT_AUTHORIZED' };
  if (!op || typeof op !== 'object') return { ok: false, code: 'NO_OPERATION' };
  // Tenant-local (Europe/Oslo) today — never a naive UTC shortcut that moves the birth-date
  // boundary around midnight. Derived from the injected `now`; the core still reads no clock.
  const todayWd = Number.isFinite(now) ? tenantWorkDate(now, timezone || TENANT_TIMEZONE) : null;

  if (op.kind === 'createEmployee') {
    // Exactly THREE required semantic facts: navn + startdato + stilling/rolle.
    if (!nonEmpty(op.name)) return { ok: false, code: 'NAME_REQUIRED' };
    if (!WD_RE.test(op.startDate || '')) return { ok: false, code: 'STARTDATE_INVALID' };
    if (!nonEmpty(op.role)) return { ok: false, code: 'ROLE_REQUIRED' };
    // Optional contact facts at CREATE go through the SAME validators as update (never UI-only).
    let createAddress = null, createBirthDate = null;
    if (op.contact && typeof op.contact === 'object') {
      if ('address' in op.contact) {
        const a = validateAddressPatch(op.contact.address);
        if (!a.ok) return { ok: false, code: a.code };
        createAddress = a.value;
      }
      if (op.contact.birthDate != null && op.contact.birthDate !== '') {
        const problem = birthDateProblem(op.contact.birthDate, todayWd);
        if (problem) return { ok: false, code: problem };
        createBirthDate = op.contact.birthDate;
      }
    }
    const slug = op.name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ansatt';
    let ansattId = 'ans-' + slug, n = 1;
    while (Object.prototype.hasOwnProperty.call(tenant, ansattId)) { n += 1; ansattId = 'ans-' + slug + '-' + n; }
    const emp = {
      ansattId, name: op.name.trim(),
      contact: { email: null, phone: null, address: createAddress, birthDate: createBirthDate },
      status: 'active', endedAt: null,
      terms: [freezeTerms({ validFrom: op.startDate, role: op.role, employmentType: null, percentage: null, compensation: null, workplace: null, expectedWeeklyHours: null, workingTimeArrangement: null, probation: null, noticePeriod: null, breaksArrangement: null, scheduleChangeHandling: null, employmentBasis: null, employmentEndDate: null, paymentInterval: null })],
      documents: [],
      contractVersions: [],
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
      if (!(k in patch) || k === 'address') continue;
      if (!(patch[k] === null || typeof patch[k] === 'string')) return { ok: false, code: 'CONTACT_VALUE_INVALID' };
    }
    // Validate EVERYTHING before mutating anything: a rejected patch leaves the canonical
    // record byte/value unchanged for the attempted field mutation.
    let addressValue;
    if ('address' in patch) {
      const a = validateAddressPatch(patch.address);
      if (!a.ok) return { ok: false, code: a.code };
      addressValue = a.value;
    }
    if ('birthDate' in patch && patch.birthDate !== null && patch.birthDate !== '') {
      const problem = birthDateProblem(patch.birthDate, todayWd);
      if (problem) return { ok: false, code: problem };
    }
    for (const k of CONTACT_FIELDS) {
      if (!(k in patch)) continue;
      if (k === 'address') { emp.contact.address = addressValue; continue; }
      emp.contact[k] = (patch[k] === '' ? null : patch[k]);
    }
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

  if (op.kind === 'completeCurrentTerms') {
    // Completing BLANKS on the LATEST period (the contract flow filling in facts that were left
    // unknown at quick-create). This is NOT a history rewrite and it can never touch a frozen
    // contract: it fails closed if the period is referenced by any frozen contract version, and
    // it refuses to overwrite an already-set value — that requires appendTerms (a new period).
    const input = op.terms;
    if (!input || typeof input !== 'object') return { ok: false, code: 'NO_TERMS' };
    const bad = keysOutside(input, TERMS_FIELDS.filter((f) => f !== 'validFrom'));
    if (bad) return { ok: false, code: 'TERMS_FIELD_NOT_ALLOWED:' + bad };
    const idx = emp.terms.length - 1;
    const base = emp.terms[idx];
    if ((emp.contractVersions || []).some((v) => v.status === 'godkjent_frosset' && v.termsPeriodRef === base.validFrom)) {
      return { ok: false, code: 'TERMS_PERIOD_FROZEN_IN_CONTRACT' };
    }
    if ('compensation' in input && !validCompensation(input.compensation)) return { ok: false, code: 'COMPENSATION_INVALID' };
    if ('percentage' in input && input.percentage != null && !(Number.isFinite(input.percentage) && input.percentage > 0 && input.percentage <= 100)) return { ok: false, code: 'PERCENTAGE_INVALID' };
    if ('employmentType' in input && input.employmentType != null && !EMPLOYMENT_TYPES.includes(input.employmentType)) return { ok: false, code: 'EMPLOYMENTTYPE_INVALID' };
    if ('paymentInterval' in input && input.paymentInterval != null && !PAYMENT_INTERVALS.includes(input.paymentInterval)) return { ok: false, code: 'PAYMENTINTERVAL_INVALID' };
    const snap = {};
    for (const f of TERMS_FIELDS) snap[f] = base[f];
    for (const f of Object.keys(input)) {
      if (input[f] == null || input[f] === '') continue;
      if (base[f] != null) { if (base[f] !== input[f]) return { ok: false, code: 'TERMS_VALUE_ALREADY_SET:' + f }; continue; }
      snap[f] = input[f];
    }
    const rec = freezeTerms(snap);
    emp.terms = emp.terms.slice(0, idx).concat([rec]);
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
