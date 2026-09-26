// employee-production-bridge.mjs
// EMPLOYEE PRODUCTION BRIDGE — PURE, IMPORT-FREE. No DOM, no network, no Firebase, no storage,
// no clock. This module decides HOW the employee product is entered:
//
//   production  — the shell is mounted with ONE externally supplied, already-resolved identity
//                 (the shared production login resolves it from top-level memberships; this
//                 module never resolves, fetches or infers identity itself). Fail-closed on
//                 anything absent, malformed, disabled, wrong-role or wrong-tenant.
//   preview     — the explicit LOCAL owner-review mode: the fixture chooser and the default
//                 review identity exist ONLY here and are never consulted in production.
//
// Authority shape (frozen architecture REV2): membership = { uid, tenantId, accessRole, ansattId,
// accessEnabled }. Custom claims, e-mail, display name, URL parameters and browser storage are
// never authority. The bridge returns EXACTLY the five fields — any extra property on the
// supplied identity (token claims, labels, roles from other systems) is dropped.
//
// Data adapters: the shell reads/writes its ONE schedule truth, ONE attendance truth and the
// employee (Min ansettelse) truth through the adapter contract below. Preview binds the existing
// in-memory fixture stores; production adapters are NOT implemented here (no production path,
// query or write shape is invented) — only the contract that a later, separately governed
// adapter build must satisfy.

export const PRODUCTION_IDENTITY_FIELDS = Object.freeze(['uid', 'tenantId', 'accessRole', 'ansattId', 'accessEnabled']);
export const ENTRY_MODES = Object.freeze(['production', 'preview']);
// Roles that may enter the EMPLOYEE surface with their own employee context. Both require a
// bound ansattId: an admin without an ansattId has no "own day" and is refused here (the
// management surface is a different door, not reachable through this bridge).
export const EMPLOYEE_SURFACE_ROLES = Object.freeze(['employee', 'admin']);

export const DENIAL = Object.freeze({
  MODE_INVALID: 'MODE_INVALID',
  IDENTITY_MISSING: 'IDENTITY_MISSING',
  IDENTITY_MALFORMED: 'IDENTITY_MALFORMED',
  IDENTITY_ANSATT_MISSING: 'IDENTITY_ANSATT_MISSING',
  IDENTITY_TENANT_MISMATCH: 'IDENTITY_TENANT_MISMATCH',
  IDENTITY_DISABLED: 'IDENTITY_DISABLED',
  IDENTITY_ROLE_INVALID: 'IDENTITY_ROLE_INVALID',
  CONFIG_TENANT_MISSING: 'CONFIG_TENANT_MISSING',
  ADAPTERS_MISSING: 'ADAPTERS_MISSING',
  PREVIEW_CONFIG_INVALID: 'PREVIEW_CONFIG_INVALID',
  CHOOSER_PREVIEW_ONLY: 'CHOOSER_PREVIEW_ONLY',
});

function nonEmptyString(v) { return typeof v === 'string' && v.length > 0; }
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/**
 * Validate an externally supplied production identity for the employee surface.
 * Returns { ok: true, membership } with EXACTLY the five authority fields (frozen), or
 * { ok: false, code } — never throws, never falls back, never reads anything but its arguments.
 * Evaluation order is normative: presence → shape → configuration → tenant → enabled → role.
 */
export function validateProductionIdentity(identity, options) {
  const opts = isPlainObject(options) ? options : {};
  if (identity === null || identity === undefined) return { ok: false, code: DENIAL.IDENTITY_MISSING };
  if (!isPlainObject(identity)) return { ok: false, code: DENIAL.IDENTITY_MALFORMED };
  if (!nonEmptyString(identity.uid)) return { ok: false, code: DENIAL.IDENTITY_MALFORMED };
  if (!nonEmptyString(identity.tenantId)) return { ok: false, code: DENIAL.IDENTITY_MALFORMED };
  if (!nonEmptyString(identity.accessRole)) return { ok: false, code: DENIAL.IDENTITY_MALFORMED };
  if (typeof identity.accessEnabled !== 'boolean') return { ok: false, code: DENIAL.IDENTITY_MALFORMED };
  if (identity.ansattId === null || identity.ansattId === undefined) return { ok: false, code: DENIAL.IDENTITY_ANSATT_MISSING };
  if (!nonEmptyString(identity.ansattId)) return { ok: false, code: DENIAL.IDENTITY_MALFORMED };
  if (!nonEmptyString(opts.expectedTenantId)) return { ok: false, code: DENIAL.CONFIG_TENANT_MISSING };
  if (identity.tenantId !== opts.expectedTenantId) return { ok: false, code: DENIAL.IDENTITY_TENANT_MISMATCH };
  if (identity.accessEnabled !== true) return { ok: false, code: DENIAL.IDENTITY_DISABLED };
  const roles = Array.isArray(opts.allowedRoles) ? opts.allowedRoles : EMPLOYEE_SURFACE_ROLES;
  if (!roles.includes(identity.accessRole)) return { ok: false, code: DENIAL.IDENTITY_ROLE_INVALID };
  const membership = Object.freeze({
    uid: identity.uid, tenantId: identity.tenantId, accessRole: identity.accessRole,
    ansattId: identity.ansattId, accessEnabled: true,
  });
  return { ok: true, membership };
}

/**
 * Resolve how the shell is entered.
 *   { mode: 'production', identity, expectedTenantId }        -> { kind: 'production', membership } | { kind: 'denied', mode, code }
 *   { mode: 'preview', preview: { memberships, defaultUid } } -> { kind: 'preview', memberships, defaultUid } | { kind: 'denied', mode, code }
 *   anything else                                              -> { kind: 'denied', mode, code: MODE_INVALID }
 * In production the `preview` argument is never read: there is no implicit fallback.
 */
export function resolveEmployeeEntry(input) {
  const inp = isPlainObject(input) ? input : {};
  if (inp.mode === 'production') {
    const v = validateProductionIdentity(inp.identity, { expectedTenantId: inp.expectedTenantId, allowedRoles: inp.allowedRoles });
    if (!v.ok) return { kind: 'denied', mode: 'production', code: v.code };
    return { kind: 'production', membership: v.membership };
  }
  if (inp.mode === 'preview') {
    const p = inp.preview;
    if (!isPlainObject(p) || !Array.isArray(p.memberships) || !nonEmptyString(p.defaultUid)) {
      return { kind: 'denied', mode: 'preview', code: DENIAL.PREVIEW_CONFIG_INVALID };
    }
    return { kind: 'preview', memberships: p.memberships, defaultUid: p.defaultUid };
  }
  return { kind: 'denied', mode: inp.mode === undefined ? 'undefined' : String(inp.mode), code: DENIAL.MODE_INVALID };
}

// ---- Data-adapter contract (seams only; no implementation of any production adapter) ----------
// schedule.store()  -> the ONE tenant-keyed schedule container the core operations project/mutate
// attendance        -> get(attendanceId) / set(attendanceId, record) / has(attendanceId); records are
//                      written ONLY from successful core-operation results (clockIn/clockOut/breaks)
// employees.store() -> the ONE employee (Min ansettelse) store read through employeeOf/currentTermsOf
export const ADAPTER_CONTRACT = Object.freeze({
  schedule: Object.freeze(['store']),
  attendance: Object.freeze(['get', 'set', 'has']),
  employees: Object.freeze(['store']),
});

/** Structural check of an adapter set against the contract. Fail-closed: any missing method fails. */
export function validateAdapters(adapters) {
  const missing = [];
  if (!isPlainObject(adapters)) return { ok: false, missing: Object.keys(ADAPTER_CONTRACT) };
  for (const key of Object.keys(ADAPTER_CONTRACT)) {
    const a = adapters[key];
    if (!a || typeof a !== 'object') { missing.push(key); continue; }
    for (const fn of ADAPTER_CONTRACT[key]) if (typeof a[fn] !== 'function') missing.push(key + '.' + fn);
  }
  return missing.length ? { ok: false, missing } : { ok: true, missing };
}

/** Owner-facing wording for the fail-closed panel. Neutral; never leaks identifiers. */
export function denialMessage(code) {
  switch (code) {
    case DENIAL.IDENTITY_MISSING: return 'Du er ikke logget inn. Logg inn for å se din dag og din plan.';
    case DENIAL.IDENTITY_DISABLED: return 'Tilgangen din er deaktivert. Kontakt daglig leder.';
    case DENIAL.IDENTITY_ROLE_INVALID: return 'Kontoen din har ikke tilgang til ansattsiden.';
    case DENIAL.IDENTITY_TENANT_MISMATCH: return 'Kontoen din tilhører ikke denne arbeidsplassen.';
    case DENIAL.IDENTITY_ANSATT_MISSING: return 'Kontoen din er ikke koblet til en ansatt ennå. Kontakt daglig leder.';
    case DENIAL.ADAPTERS_MISSING: return 'Ansattsiden er ikke koblet til produksjonsdata ennå.';
    case DENIAL.CHOOSER_PREVIEW_ONLY: return 'Bytte av ansatt er ikke tilgjengelig her.';
    default: return 'Kunne ikke bekrefte identiteten din. Prøv å logge inn på nytt.';
  }
}
