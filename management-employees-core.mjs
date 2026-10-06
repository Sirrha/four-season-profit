// management-employees-core.mjs
// EMPLOYEE 360 / ANSATTSIDE CORE — PURE. No DOM, no clock read, no storage, no network.
// Governing: SOREN-SIRRHA-EMPLOYEE-360-ANSATTSIDE-FIRST-REAL-PRODUCT-DESIGN-001 + Sirrha
// corrections C1-C3. ONE EMPLOYEE, ONE HOME — SAME TRUTH, DIFFERENT DOORWAY:
// - Employment terms are an ORDERED IMMUTABLE list (frozen records, append-only). validTo is
//   DERIVED from the next period's validFrom — never stored, never mutated onto older records. Only the LATEST period
//   may be re-issued in place: completeCurrentTerms (fill blanks) and correctCurrentTerms (audited feilregistrering fix).
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
  'breaksArrangement', 'scheduleChangeHandling', 'employmentBasis', 'employmentEndDate', 'paymentInterval', 'employmentForm'];
const NEW_TERMS_FIELDS = ['breaksArrangement', 'scheduleChangeHandling', 'employmentBasis', 'employmentEndDate', 'paymentInterval'];
// TWO DISTINCT canonical employment facts on the SAME terms period (owner law, release
// SIRRHA-CCODE-SORMENA-CONTRACT-ANSETTELSESFORM-SEPARATION-LOCAL-005):
//   employmentType = ARBEIDSOMFANG — the existing "stillingstype" scope fact (deltid / tilkalling …). Its stored meaning is
//                    kept for compatibility; existing values are never rewritten. The legacy list still admits
//                    'fast'/'midlertidig' so pre-separation records stay valid — new form facts never go here.
//   employmentForm = ANSETTELSESFORM — fast | midlertidig (permanent vs temporary). ADDITIVE field; never derived from
//                    employmentType and never overwriting it. Grunnlag/sluttdato for midlertidig belong to this fact.
export const EMPLOYMENT_TYPES = ['fast', 'deltid', 'tilkalling', 'midlertidig'];
export const EMPLOYMENT_FORMS = ['fast', 'midlertidig'];
export const PAYMENT_INTERVALS = ['manedlig', 'hver-14-dag'];
const DOC_FIELDS = ['name', 'category', 'date', 'source', 'note'];
export const DOC_CATEGORIES = ['kontrakt', 'tillegg', 'attest', 'annet'];
// The canonical baseline an admin must state explicitly at FIRST REGISTRATION of an old-register employee (start date is
// required separately). Other terms fields may be given too; none is ever inherited from the old register.
export const INITIAL_REGISTRATION_REQUIRED = Object.freeze(['role', 'employmentForm', 'employmentType', 'percentage', 'compensation', 'expectedWeeklyHours', 'workplace', 'noticePeriod']);
// True while an employee has NO stored employment baseline: its single period is only DERIVED from the old register and
// is orientation, never history. (Records without the old-register marker — preview fixtures, new employees — are false.)
export function lacksEmploymentBaseline(employee) { return !!(employee && employee.legacy && employee.legacy.hasE360 === false); }
// True while first registration is the next step: no stored baseline AND the employee is active.
export function needsInitialRegistration(employee) { return lacksEmploymentBaseline(employee) && employee.status === 'active'; }
// The one stable refusal of every operation that is not the first registration, for an employee without a stored baseline.
export const INITIAL_REGISTRATION_REQUIRED_CODE = 'INITIAL_REGISTRATION_REQUIRED';
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
      terms: [freezeTerms({ validFrom: s.validFrom, role: p.roleKey, employmentType: s.employmentType, percentage: s.percentage, compensation: comp, workplace: 'Four Season', expectedWeeklyHours: null, workingTimeArrangement: null, probation: null, noticePeriod: null, breaksArrangement: null, scheduleChangeHandling: null, employmentBasis: null, employmentEndDate: null, paymentInterval: null, employmentForm: null })],
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
// The REGISTERED employment start, or null while the employment is not registered: for an old-register employee the first
// period is only derived and its date is the old record's creation date — never an employment start. Payroll and the
// planning month estimate use this (membership, "Startet i perioden", payload), so that date decides nothing there.
export function registeredStartDateOf(employee) { return lacksEmploymentBaseline(employee) ? null : startDateOf(employee); }
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
  if (contractStatusOf(employee) === 'mangler' && !hasApprovedContractVersion(employee)) out.push('mangler kontrakt');
  return out;
}
// A management-approved (frozen) contract version means the contract is no longer "missing" (release -007). Derived from the
// SAME contractVersions list the contract projection reads; a draft does not count. contractStatusOf stays the manually
// registered document fact (it also feeds the employee self-projection, which must not read an unsigned freeze as a contract).
export function hasApprovedContractVersion(employee) {
  return (employee && Array.isArray(employee.contractVersions) ? employee.contractVersions : []).some((v) => v && v.status === 'godkjent_frosset');
}
// Vaktplan planning-compensation PROJECTION of the CURRENT terms (derived, never stored twice).
export function compensationProjectionOf(employee, onDate) {
  // Before first registration the only "terms" are derived from the old register: its hourly wage is unconfirmed
  // orientation, never a planning input. No projection -> Vaktplan's established unknown state ("mangler lønnsgrunnlag").
  if (lacksEmploymentBaseline(employee)) return null;
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
    // Before first registration the old-register title is not a role: roleKey null + `unregistered` (display shows the
    // neutral label). The person stays assignable; a shift created for them stores roleKey null, never the old title.
    const unreg = lacksEmploymentBaseline(e);
    const person = { ansattId: e.ansattId, name: e.name, roleKey: unreg ? null : (t ? t.role : null) };
    if (unreg) person.unregistered = true;
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

// ---- CURRENT-PERIOD CORRECTION (release -006) -------------------------------------------------
// A period is locked for correction once ANY non-draft contract version references it: the frozen version completeCurrentTerms
// already guards, plus the declared (v1-unreachable) sent/signed/cancelled/superseded states. A draft never unlocks anything.
function periodLockedByContract(emp, validFrom) {
  return (emp.contractVersions || []).some((v) => v.status !== 'utkast' && v.termsPeriodRef === validFrom);
}
// THE correction eligibility (view and core share it): an ACTIVE employee's LATEST period (no successor) that no non-draft
// contract version references. Historical/superseded periods are never offered and are refused by the core.
export function correctableTermsPeriodOf(employee) {
  if (!employee || employee.status !== 'active' || !Array.isArray(employee.terms) || !employee.terms.length) return null;
  const t = employee.terms[employee.terms.length - 1];
  return periodLockedByContract(employee, t.validFrom) ? null : t;
}
const cloneValue = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const canonValue = (v) => (v && typeof v === 'object' ? JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]])) : JSON.stringify(v == null ? null : v));
const sameValue = (a, b) => canonValue(a) === canonValue(b);
const TERMS_TEXT_FIELDS = ['workplace', 'workingTimeArrangement', 'probation', 'noticePeriod', 'breaksArrangement', 'scheduleChangeHandling', 'employmentBasis'];
// Value law for a corrected (non-blank) term; the enum/range checks are the ones appendTerms/completeCurrentTerms apply,
// plus a numeric check for weekly hours (0 < h <= 168) so a malformed number can never replace a registered one.
function termsValueProblem(f, v) {
  if (f === 'role') return nonEmpty(v) ? null : 'ROLE_REQUIRED';
  if (f === 'employmentType') return EMPLOYMENT_TYPES.includes(v) ? null : 'EMPLOYMENTTYPE_INVALID';
  if (f === 'employmentForm') return EMPLOYMENT_FORMS.includes(v) ? null : 'EMPLOYMENTFORM_INVALID';
  if (f === 'paymentInterval') return PAYMENT_INTERVALS.includes(v) ? null : 'PAYMENTINTERVAL_INVALID';
  if (f === 'percentage') return Number.isFinite(v) && v > 0 && v <= 100 ? null : 'PERCENTAGE_INVALID';
  if (f === 'expectedWeeklyHours') return Number.isFinite(v) && v > 0 && v <= 168 ? null : 'EXPECTEDWEEKLYHOURS_INVALID';
  if (f === 'compensation') return validCompensation(v) ? null : 'COMPENSATION_INVALID';
  if (f === 'employmentEndDate') return typeof v === 'string' && WD_RE.test(v) ? null : 'EMPLOYMENTENDDATE_INVALID';
  if (TERMS_TEXT_FIELDS.includes(f)) return nonEmpty(v) ? null : 'TERMS_VALUE_INVALID:' + f;
  return 'TERMS_FIELD_NOT_ALLOWED:' + f;
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
      terms: [freezeTerms({ validFrom: op.startDate, role: op.role, employmentType: null, percentage: null, compensation: null, workplace: null, expectedWeeklyHours: null, workingTimeArrangement: null, probation: null, noticePeriod: null, breaksArrangement: null, scheduleChangeHandling: null, employmentBasis: null, employmentEndDate: null, paymentInterval: null, employmentForm: null })],
      documents: [],
      contractVersions: [],
    };
    tenant[ansattId] = emp;
    return { ok: true, ansattId, employee: emp };
  }

  const ansattId = op.ansattId;
  const emp = typeof ansattId === 'string' && Object.prototype.hasOwnProperty.call(tenant, ansattId) ? tenant[ansattId] : null;
  if (!emp) return { ok: false, code: 'EMPLOYEE_UNKNOWN' };

  // HARD LAW (initial-registration hardening): for an employee without a stored employment baseline the ONLY operation
  // is registerInitialEmployment. Every other kind — contact, completion, correction, new period, end, documents, and any
  // kind added later — is refused here, because persisting its result would store the derived old-register period as
  // history. Checked before any kind-specific code, so no kind can reach a mutation.
  if (lacksEmploymentBaseline(emp) && op.kind !== 'registerInitialEmployment') return { ok: false, code: INITIAL_REGISTRATION_REQUIRED_CODE };

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

  if (op.kind === 'registerInitialEmployment') {
    // FIRST REGISTRATION of an employee that so far exists only in the old register (record marker legacy.hasE360 === false:
    // its single period is DERIVED at read time from old bootstrap fields and has never been stored as employment history).
    // The admin states the REAL start date and the REAL employment facts explicitly; nothing is taken over from the derived
    // period. Result: exactly ONE stored period, validFrom = the submitted start date. One-time: once a stored baseline
    // exists this operation is refused and completion / correction / new-period laws apply. Not an append, not a completion.
    if (!emp.legacy || emp.legacy.hasE360 !== false) return { ok: false, code: 'INITIAL_REGISTRATION_NOT_AVAILABLE' };
    if (emp.status !== 'active') return { ok: false, code: 'INITIAL_REGISTRATION_INACTIVE' };
    if ((emp.contractVersions || []).length || (emp.documents || []).length || (emp.termsCorrections || []).length) return { ok: false, code: 'INITIAL_REGISTRATION_NOT_AVAILABLE' };
    const sd = op.startDate;
    const realDate = typeof sd === 'string' && WD_RE.test(sd) && !Number.isNaN(Date.parse(sd + 'T12:00:00Z')) && new Date(sd + 'T12:00:00Z').toISOString().slice(0, 10) === sd;
    if (!realDate || sd < BIRTHDATE_FLOOR) return { ok: false, code: 'STARTDATE_INVALID' };
    if (todayWd && sd > todayWd) return { ok: false, code: 'STARTDATE_FUTURE' };   // the person is already an active employee
    const input = op.terms;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'NO_TERMS' };
    const bad = keysOutside(input, TERMS_FIELDS.filter((f) => f !== 'validFrom'));
    if (bad) return { ok: false, code: 'TERMS_FIELD_NOT_ALLOWED:' + bad };
    const blankIn = (f) => input[f] == null || input[f] === '';
    for (const f of INITIAL_REGISTRATION_REQUIRED) if (blankIn(f)) return { ok: false, code: 'INITIAL_TERMS_REQUIRED:' + f };
    for (const f of Object.keys(input)) {
      if (blankIn(f)) continue;
      const problem = termsValueProblem(f, input[f]);
      if (problem) return { ok: false, code: problem };
    }
    const snap = {};
    for (const f of TERMS_FIELDS) snap[f] = (f in input) && !blankIn(f) ? (f === 'compensation' ? Object.assign({}, input[f]) : input[f]) : null;
    snap.validFrom = sd;
    const rec = freezeTerms(snap);
    emp.terms = [rec];                                                    // exactly one period; the derived one is not kept
    emp.legacy = Object.freeze(Object.assign({}, emp.legacy, { hasE360: true }));
    return { ok: true, ansattId, terms: rec, employee: emp };
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
    if ('employmentForm' in input && input.employmentForm != null && !EMPLOYMENT_FORMS.includes(input.employmentForm)) return { ok: false, code: 'EMPLOYMENTFORM_INVALID' };
    // FULL SNAPSHOT (C1): carry the latest period's facts forward, override the provided keys.
    // Earlier records are frozen and are NEVER touched; validTo stays derived at read time.
    const base = emp.terms[emp.terms.length - 1];
    const snap = {};
    for (const f of TERMS_FIELDS) snap[f] = (f in input) ? input[f] : (base[f] === undefined ? null : base[f]);
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
    if ('employmentForm' in input && input.employmentForm != null && !EMPLOYMENT_FORMS.includes(input.employmentForm)) return { ok: false, code: 'EMPLOYMENTFORM_INVALID' };
    if ('paymentInterval' in input && input.paymentInterval != null && !PAYMENT_INTERVALS.includes(input.paymentInterval)) return { ok: false, code: 'PAYMENTINTERVAL_INVALID' };
    const snap = {};
    for (const f of TERMS_FIELDS) snap[f] = base[f] === undefined ? null : base[f];
    for (const f of Object.keys(input)) {
      if (input[f] == null || input[f] === '') continue;
      if (base[f] != null) { if (base[f] !== input[f]) return { ok: false, code: 'TERMS_VALUE_ALREADY_SET:' + f }; continue; }
      snap[f] = input[f];
    }
    const rec = freezeTerms(snap);
    emp.terms = emp.terms.slice(0, idx).concat([rec]);
    return { ok: true, ansattId, terms: rec, employee: emp };
  }

  if (op.kind === 'correctCurrentTerms') {
    // CORRECTION IS NOT CHANGE (release -006). Rectifies an erroneously REGISTERED value on the CURRENT (latest) period in
    // place: same period, same validFrom, no new period — nothing changed in the real employment. A genuine later change
    // stays appendTerms. Only already-set values are corrected (blanks are completeCurrentTerms' job); the caller states the
    // values it saw (`expected`, compare-and-set) and a reason; every correction appends ONE audit entry to
    // emp.termsCorrections (when/who/why/period/before/after). Eligibility = correctableTermsPeriodOf (shared with the view).
    const input = op.terms;
    if (!input || typeof input !== 'object' || !Object.keys(input).length) return { ok: false, code: 'NO_TERMS' };
    const bad = keysOutside(input, TERMS_FIELDS.filter((f) => f !== 'validFrom'));
    if (bad) return { ok: false, code: 'TERMS_FIELD_NOT_ALLOWED:' + bad };
    if (!nonEmpty(op.reason)) return { ok: false, code: 'CORRECTION_REASON_REQUIRED' };
    if (op.reason.trim().length > 200) return { ok: false, code: 'CORRECTION_REASON_TOO_LONG' };
    if (emp.status !== 'active') return { ok: false, code: 'TERMS_CORRECTION_EMPLOYEE_ENDED' };
    const idx = emp.terms.length - 1;
    const base = emp.terms[idx];
    if (op.periodValidFrom !== base.validFrom) return { ok: false, code: emp.terms.some((t) => t.validFrom === op.periodValidFrom) ? 'TERMS_CORRECTION_PERIOD_SUPERSEDED' : 'TERMS_CORRECTION_PERIOD_UNKNOWN' };
    if (periodLockedByContract(emp, base.validFrom)) return { ok: false, code: 'TERMS_PERIOD_FROZEN_IN_CONTRACT' };
    if (!Number.isFinite(now)) return { ok: false, code: 'CORRECTION_TIME_REQUIRED' };
    if (!nonEmpty(actor.uid)) return { ok: false, code: 'CORRECTION_ACTOR_REQUIRED' };
    const expected = op.expected && typeof op.expected === 'object' ? op.expected : {};
    const changes = [];
    for (const f of Object.keys(input)) {
      const v = input[f];
      if (v == null || v === '') return { ok: false, code: 'TERMS_CORRECTION_VALUE_REQUIRED:' + f };
      if (base[f] == null) return { ok: false, code: 'TERMS_CORRECTION_FIELD_BLANK:' + f };
      const problem = termsValueProblem(f, v);
      if (problem) return { ok: false, code: problem };
      if (!(f in expected) || !sameValue(base[f], expected[f])) return { ok: false, code: 'TERMS_CORRECTION_STALE:' + f };
      if (!sameValue(base[f], v)) changes.push({ field: f, before: cloneValue(base[f]), after: cloneValue(v) });
    }
    if (!changes.length) return { ok: false, code: 'TERMS_CORRECTION_NO_CHANGE' };
    const snap = {};
    for (const f of TERMS_FIELDS) snap[f] = base[f] === undefined ? null : base[f];
    for (const c of changes) snap[c.field] = cloneValue(c.after);
    const rec = freezeTerms(snap);
    emp.terms = emp.terms.slice(0, idx).concat([rec]);
    const correction = { at: now, byUid: actor.uid, reason: op.reason.trim(), periodValidFrom: base.validFrom, changes };
    emp.termsCorrections = (Array.isArray(emp.termsCorrections) ? emp.termsCorrections : []).concat([correction]);
    return { ok: true, ansattId, terms: rec, correction, employee: emp };
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
