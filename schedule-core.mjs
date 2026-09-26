// schedule-core.mjs
// ETR-2c — PLANNED-SCHEDULE CORE / ENGINE. PURE MODEL ONLY. Dependency-free except
// for a ONE-WAY import of shared pure primitives from employee-shell-core.mjs.
// Governing: SOREN-SIRRHA-ETR2-FINAL-ARCHITECTURE-FREEZE-003 + ADDENDUM-004-REV4
//   + SOREN-SIRRHA-ETR2C-NEXT-SLICE-DESIGN-RECOMMENDATION-008 (final design + T1-T129).
//
// IDENTITY (engine-wide): ScheduleScope { tenantId, shiftId } is STRUCTURAL PATH
// identity. The target planned-shift projection carries NO canonical tenantId/shiftId
// field. Every shift-event id derives from scope.shiftId + revision. No validator
// derives authority from a caller-authored identity data field; a legacy shiftId field
// may be inspected for equality/integrity ONLY (never used to derive output).
//
// DEPENDENCY DIRECTION: schedule-core.mjs -> employee-shell-core.mjs ONLY. This module
// never imports the reverse edge and never imports/invokes the legacy createShift /
// reviseShift / shiftRevisionState helpers or the legacy shift_revision machinery.
//
// PURE: no I/O, no storage, no network, no clock read, no ambient/global mutable state.
// actor, scope, now, policy, context are ALL injected.

import {
  ok, err, isFiniteInstant, scheduleScopeError, eventIdFor,
  startOfTenantLocalDayUtcMs, endOfTenantLocalDayUtcMs,
} from './employee-shell-core.mjs';

// ---- Enums / field sets -----------------------------------------------------
export const SHIFT_STATUSES = ['open', 'assigned', 'cancelled'];
const CREATE_STATUSES = ['open', 'assigned'];            // cancelled-at-creation refused
const BUSINESS_FIELDS = ['ansattId', 'plannedStartAt', 'plannedEndAt', 'workDate', 'roleKey', 'status'];
const REVISE_FIELDS = ['plannedStartAt', 'plannedEndAt', 'roleKey'];
const ASSIGNMENT_FIELDS = ['status', 'ansattId'];
// Event id type names. NB: 'shift_assigned' / 'shift_reassigned' MUST NOT exist (T58).
const EVT_CREATED = 'shift_created';
const EVT_REVISED = 'shift_revised';
const EVT_ASSIGNMENT = 'shift_assignment_changed';
const EVT_CANCELLED = 'shift_cancelled';

// ---- Shared structural helpers ----------------------------------------------
// Full ScheduleScope + actor authority, evaluated in the frozen order (§5):
//   1 structural scope (scheduleScopeError) 2 actor enabled/admin/tenant-match.
function scopeThenActorError(actor, scope) {
  const se = scheduleScopeError(scope);                 // SCOPE-1..4 (MISSING_SCOPE / SCOPE_TENANT_INVALID / SCOPE_SHIFT_INVALID)
  if (se) return se;
  if (!actor || typeof actor !== 'object' || actor.accessEnabled !== true) return 'ACTOR_NOT_ENABLED'; // T75
  if (actor.accessRole !== 'admin') return 'NOT_ADMIN';                                                 // T76 / T78-T82
  if (typeof actor.tenantId !== 'string' || !actor.tenantId) return 'MISSING_ACTOR_TENANT';
  if (actor.tenantId !== scope.tenantId) return 'CROSS_TENANT';                                         // T77 (SCOPE-5)
  return null;
}
// Legacy identity integrity ONLY (never used to derive output). A target projection has
// no shiftId/tenantId field; a legacy `existing.shiftId` may be present for equality.
function legacyIdentityError(existing, scope) {
  if (existing && typeof existing === 'object') {
    if ('shiftId' in existing && existing.shiftId !== scope.shiftId) return 'SHIFT_SCOPE_MISMATCH'; // T89-analog
    if ('tenantId' in existing && existing.tenantId !== scope.tenantId) return 'TENANT_SCOPE_MISMATCH';
  }
  return null;
}
// Reject caller-authored keys outside the allowed set (identity + derived + event fields
// are therefore all rejected uniformly). Returns offending key or null.
function keysOutside(obj, allowed) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return k;
  return null;
}
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

// cancelShift has NO supported mutation patch channel. The conceptual signature omits `patch`,
// but a JS caller can still pass an input object carrying an extra `patch` property. Inspect the
// RAW caller input SOLELY to detect and reject any non-empty unsupported cancel patch, fail-closed,
// BEFORE any derived output — this never makes `patch` a supported cancel mutation interface and no
// patch field ever influences output. (Governing T63/T64/T95, consistent with T97.)
function unsupportedCancelPatchError(input) {
  if (!input || typeof input !== 'object') return null;
  const patch = input.patch;
  if (patch === undefined || patch === null) return null;      // no patch channel used — normal cancel
  if (typeof patch !== 'object') return 'CANCEL_PATCH_NOT_SUPPORTED';
  const keys = Object.keys(patch);
  if (keys.length === 0) return null;                          // empty object is not a mutation attempt
  return 'CANCEL_PATCH_NOT_SUPPORTED:' + keys[0];             // any non-empty unsupported patch fails closed
}

// plannedStartAt must belong to the tenant-local workDate; plannedEndAt strictly after
// start and MAY fall on the next local day (overnight). Uses the injected timezone.
function plannedTimeError(startAt, endAt, workDate, policy) {
  if (!isFiniteInstant(startAt) || !isFiniteInstant(endAt)) return 'PLANNED_NOT_FINITE';   // T-structural
  const dayStart = startOfTenantLocalDayUtcMs(workDate, policy.timezone);
  const nextMidnight = endOfTenantLocalDayUtcMs(workDate, policy.timezone, 0);             // start of next local day
  if (!(startAt >= dayStart && startAt < nextMidnight)) return 'PLANNED_START_NOT_ON_WORKDATE'; // T18 / T40
  if (endAt <= startAt) return 'END_BEFORE_START';                                          // T16 / T41 (overnight end allowed, T17/T42)
  return null;
}

// Assignee resolution: injected cross-object fact. FOUND + same-tenant + exact ansattId.
function assigneeResolutionError(resolution, proposedAnsattId, scopeTenantId) {
  if (!resolution || typeof resolution !== 'object') return 'ASSIGNEE_RESOLUTION_REQUIRED'; // T71 / T72 (absent)
  if (resolution.status !== 'FOUND') return 'ASSIGNEE_NOT_RESOLVED';                         // NOT_FOUND / UNKNOWN (T20 / T71 / T72)
  if (resolution.tenantId !== scopeTenantId) return 'ASSIGNEE_CROSS_TENANT';                 // T21
  if (resolution.ansattId !== proposedAnsattId) return 'ASSIGNEE_MISMATCH';                  // T22 / T57
  return null;
}

// ---- Projection + event builders --------------------------------------------
// Target projection carries NO canonical tenantId/shiftId field. A legacy identity field
// on a prior `existing` may be inspected for equality (legacyIdentityError) but must never
// be carried into output — strip it from any spread-derived projection (T88/T90/T91).
function stripIdentity(p) {
  if ('shiftId' in p) delete p.shiftId;
  if ('tenantId' in p) delete p.tenantId;
  return p;
}
function buildEvent(type, scope, revision, actor, now, changed) {
  return {
    eventId: eventIdFor(scope.shiftId, revision),   // T85 / T112: id from scope.shiftId + revision
    type,
    actorUid: actor.uid,                            // T101
    actorRole: actor.accessRole,                    // T102 resolved from actor, never self-claimed
    at: now,                                         // T103
    revision,                                        // T103 == new projection revision
    changed,
  };
}

// ---- Changed-map correctness (T110/T111) ------------------------------------
// Every key in `changed` must reflect a real before!=after; every business field that
// actually changed must be present. Pure predicate reused by tests + callers.
export function shiftChangedMapError(before, after, changed) {
  for (const k of Object.keys(changed)) {
    if (before[k] === after[k]) return err('CHANGED_MAP_SPURIOUS:' + k);        // T110 contains a non-change
    if (changed[k].before !== before[k] || changed[k].after !== after[k]) return err('CHANGED_MAP_WRONG:' + k);
  }
  for (const k of BUSINESS_FIELDS) {
    if (before[k] !== after[k] && !(k in changed)) return err('CHANGED_MAP_MISSING:' + k); // T111 omits a change
  }
  return ok({});
}

// =====================================================================
// validateCreateShift — C1 / §6.3
// =====================================================================
export function validateCreateShift({ actor, scope, proposed, now, policy, context }) {
  const ae = scopeThenActorError(actor, scope);
  if (ae) return err(ae);
  if (!proposed || typeof proposed !== 'object') return err('NO_PROPOSAL');
  // caller-authored identity / derived fields rejected uniformly (T23/T24/T86/T87)
  const bad = keysOutside(proposed, BUSINESS_FIELDS);
  if (bad) return err('PROPOSAL_FIELD_NOT_ALLOWED:' + bad);
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');
  // creation uniqueness at the identity — shiftExistsAtScope MUST be exactly false
  if (!context || typeof context !== 'object') return err('CONTEXT_REQUIRED');
  if (context.shiftExistsAtScope === true) return err('SHIFT_ALREADY_EXISTS');               // T25 / T26
  if (context.shiftExistsAtScope !== false) return err('SHIFT_EXISTENCE_UNKNOWN');           // T27 (unknown/missing)
  // structural proposal validation
  const status = proposed.status;
  if (!CREATE_STATUSES.includes(status)) return err('STATUS_INVALID_FOR_CREATE');            // T15 cancelled / bad enum
  if (status === 'open') {
    if (proposed.ansattId !== null) return err('OPEN_REQUIRES_NULL_ANSATT');                 // T13
  } else { // assigned
    if (!isNonEmptyString(proposed.ansattId)) return err('ASSIGNED_REQUIRES_ANSATT');        // T14 null / T19 empty
  }
  const roleKey = ('roleKey' in proposed) ? proposed.roleKey : null;
  if (!(roleKey === null || typeof roleKey === 'string')) return err('ROLEKEY_INVALID');
  if (typeof proposed.workDate !== 'string' || !proposed.workDate) return err('WORKDATE_INVALID');
  const pte = plannedTimeError(proposed.plannedStartAt, proposed.plannedEndAt, proposed.workDate, policy);
  if (pte) return err(pte);                                                                   // T16 / T17 / T18
  // required context fact: assignee resolution when a non-null assignee is proposed
  if (status === 'assigned') {
    const are = assigneeResolutionError(context.proposedAssigneeResolution, proposed.ansattId, scope.tenantId);
    if (are) return err(are);                                                                 // T20 / T21 / T22 / T72
  }
  // derived construction — no tenantId/shiftId field
  const projection = {
    ansattId: status === 'open' ? null : proposed.ansattId,
    plannedStartAt: proposed.plannedStartAt,
    plannedEndAt: proposed.plannedEndAt,
    workDate: proposed.workDate,
    roleKey,
    status,
    revision: 1,                                     // T34
    createdByUid: actor.uid,                          // T32
    createdAt: now,                                   // T33
    updatedAt: now,                                   // T33
  };
  const changed = {};                                 // T29 all six business fields, before:null; T30 excludes derived
  for (const f of BUSINESS_FIELDS) changed[f] = { before: null, after: projection[f] };
  const event = buildEvent(EVT_CREATED, scope, 1, actor, now, changed);
  return ok({ projection, event });
}

// =====================================================================
// validateReviseShift — C2 / §6.3
// =====================================================================
export function validateReviseShift({ actor, scope, existing, patch, now, policy, context }) {
  const ae = scopeThenActorError(actor, scope);
  if (ae) return err(ae);
  const le = legacyIdentityError(existing, scope);
  if (le) return err(le);
  if (!existing || typeof existing !== 'object') return err('NO_SHIFT');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');
  if (existing.status === 'cancelled') return err('SHIFT_CANCELLED');                          // T66 terminal
  if (!patch || typeof patch !== 'object') return err('NO_PATCH');
  const bad = keysOutside(patch, REVISE_FIELDS);
  if (bad) return err('PATCH_FIELD_NOT_ALLOWED:' + bad);                                       // T43/T44/T45/T92/T93/T97
  const proposed = Object.assign({}, existing, patch);
  const changed = {};
  for (const f of REVISE_FIELDS) if (patch[f] !== undefined && existing[f] !== patch[f]) changed[f] = { before: existing[f], after: patch[f] };
  if (Object.keys(changed).length === 0) return err('NO_CHANGE');                              // T38 / T39
  if ('roleKey' in patch && !(patch.roleKey === null || typeof patch.roleKey === 'string')) return err('ROLEKEY_INVALID');
  // times must remain valid + on the immutable workDate (T40/T41/T42)
  if ('plannedStartAt' in changed || 'plannedEndAt' in changed) {
    const pte = plannedTimeError(proposed.plannedStartAt, proposed.plannedEndAt, existing.workDate, policy);
    if (pte) return err(pte);
  }
  const revision = existing.revision + 1;
  const projection = stripIdentity(Object.assign({}, existing, patch, { revision, updatedAt: now })); // preserves createdByUid/createdAt
  const event = buildEvent(EVT_REVISED, scope, revision, actor, now, changed);                // T35 / T36
  return ok({ projection, event });
}

// =====================================================================
// validateAssignmentChange — C3 / §6.3
// =====================================================================
export function validateAssignmentChange({ actor, scope, existing, patch, now, policy, context }) {
  const ae = scopeThenActorError(actor, scope);
  if (ae) return err(ae);
  const le = legacyIdentityError(existing, scope);
  if (le) return err(le);
  if (!existing || typeof existing !== 'object') return err('NO_SHIFT');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');
  // STEP 4 — STRUCTURAL validation of the patch ONLY, in the accepted order: patch object/shape -> whitelist
  // -> explicit status enum -> explicit ansattId structural form (string | null; non-null MUST be a non-empty
  // string). The RESULTING status/ansattId pair coherence is NOT a structural patch property (it depends on
  // the carried-forward existing state) and is evaluated at STEP 6, after required context is established.
  if (!patch || typeof patch !== 'object') return err('NO_PATCH');
  const bad = keysOutside(patch, ASSIGNMENT_FIELDS);
  if (bad) return err('PATCH_FIELD_NOT_ALLOWED:' + bad);                                       // T52/T53/T54/T94/T97
  if ('status' in patch && !(patch.status === 'open' || patch.status === 'assigned')) return err('STATUS_INVALID_FOR_ASSIGNMENT'); // cannot cancel via assignment
  // explicit non-null ansattId must be the accepted non-empty-string form (same structural code/predicate as the
  // create path, T14/T19). '' / non-string / undefined reject HERE — never reaching STEP-5 context, terminal,
  // pair coherence, NO_CHANGE, attendance blocking or output. (T56 empty branch; STRUCTURAL-ANSATT-PROOF-1/2)
  if ('ansattId' in patch && patch.ansattId !== null && !isNonEmptyString(patch.ansattId)) return err('ASSIGNED_REQUIRES_ANSATT');
  const nextStatus = ('status' in patch) ? patch.status : existing.status;
  const nextAnsatt = ('ansattId' in patch) ? patch.ansattId : existing.ansattId;
  // STEP 5 — required context facts, exactly where required, established BEFORE any step-6 invariant.
  // Frozen relative order: proposed-assignee resolution FIRST, then current-assignee attendance.
  //   resolution required IFF the patch EXPLICITLY contains ansattId AND it is a non-null, structurally valid
  //     non-empty string. A carried-forward existing assignee (no ansattId key) demands NO resolution
  //     (PREDICATE-PROOF-1); an explicit valid non-null patch.ansattId DOES (PREDICATE-PROOF-2); an explicit
  //     ansattId:null demands none. An explicit '' / non-string value never reaches here (STEP-4 structural
  //     rejection above), so no resolution requirement is ever invented for it.
  //   attendance required IFF existing.ansattId is non-null (T67). Nothing else is demanded or invented.
  // (ORDER-PROOF-E/F/G/H/I/J)
  const explicitProposedAssignee = ('ansattId' in patch) && patch.ansattId !== null; // non-null here == structurally valid non-empty string (STEP 4)
  if (explicitProposedAssignee) {                                                              // T56/T57/T71
    const are = assigneeResolutionError(context && context.proposedAssigneeResolution, patch.ansattId, scope.tenantId);
    if (are) return err(are);
  }
  let curAtt = false;
  if (existing.ansattId !== null) {                                                            // current non-null (T67)
    const av = context ? context.attendanceExistsForCurrentAssignee : undefined;
    if (av === undefined) return err('ATTENDANCE_FACT_REQUIRED');
    if (av !== true && av !== false) return err('ATTENDANCE_FACT_UNKNOWN');
    curAtt = av;
  }
  // STEP 6 — business/transition invariants, only after all required context facts are established.
  // Frozen order: terminal -> resulting pair coherence -> NO_CHANGE -> attendance blocking -> derivation.
  if (existing.status === 'cancelled') return err('SHIFT_CANCELLED');                          // terminal (T66)
  // resulting pair must be coherent: assigned<->non-empty string, open<->null (T55). An explicit invalid non-null
  // ansattId was already rejected structurally at STEP 4; this guards the carried-forward/derived pair only.
  if (nextStatus === 'assigned') { if (!isNonEmptyString(nextAnsatt)) return err('INCOHERENT_ASSIGNMENT'); }
  else if (nextStatus === 'open') { if (nextAnsatt !== null) return err('INCOHERENT_ASSIGNMENT'); }
  else return err('STATUS_INVALID_FOR_ASSIGNMENT');                                            // carried-forward non-enum status (fail closed)
  const changed = {};
  if (nextStatus !== existing.status) changed.status = { before: existing.status, after: nextStatus };
  if (nextAnsatt !== existing.ansattId) changed.ansattId = { before: existing.ansattId, after: nextAnsatt };
  if (Object.keys(changed).length === 0) return err('NO_CHANGE');                              // T50 / T51
  if (curAtt === true) return err('ATTENDANCE_BLOCKS_CHANGE');                                 // attendance blocks change (T65-analog)
  const revision = existing.revision + 1;
  const projection = stripIdentity(Object.assign({}, existing, { status: nextStatus, ansattId: nextAnsatt, revision, updatedAt: now }));
  const event = buildEvent(EVT_ASSIGNMENT, scope, revision, actor, now, changed);
  return ok({ projection, event });
}

// =====================================================================
// validateCancelShift — C4 / §6.3
// =====================================================================
export function validateCancelShift(input) {
  const { actor, scope, existing, now, context } = input; // conceptual contract: no supported `patch` channel
  const ae = scopeThenActorError(actor, scope);
  if (ae) return err(ae);
  const le = legacyIdentityError(existing, scope);
  if (le) return err(le);
  if (!existing || typeof existing !== 'object') return err('NO_SHIFT');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');
  // STEP 4 (structural validation of caller-supplied input): reject any unsupported non-empty cancel
  // `patch` HERE — after steps 1-3 (scope/actor/legacy identity) and the existing/now structural checks,
  // but BEFORE step-5 context, before step-6 terminal/attendance business invariants, and before output.
  // Fail closed at every step: a later business/context failure must never mask this structural tampering.
  const pe = unsupportedCancelPatchError(input);                                               // T63/T64/T95/T97 + ORDER-PROOF-A/B
  if (pe) return err(pe);
  // STEP 5 — required context facts, exactly where required. When the CURRENT assignee is non-null,
  // establish attendanceExistsForCurrentAssignee BEFORE any step-6 business invariant, so a missing/UNKNOWN
  // fact is not masked by the terminal SHIFT_CANCELLED invariant. When ansattId is null, no attendance
  // context is required or invented. (T65/T68 + ORDER-PROOF-C/D)
  let cancelAtt = false;
  if (existing.ansattId !== null) {
    const av = context ? context.attendanceExistsForCurrentAssignee : undefined;
    if (av === undefined) return err('ATTENDANCE_FACT_REQUIRED');
    if (av !== true && av !== false) return err('ATTENDANCE_FACT_UNKNOWN');                    // UNKNOWN / non-boolean (T68)
    cancelAtt = av;
  }
  // STEP 6 — business/transition invariants, only after the required context is established.
  if (existing.status === 'cancelled') return err('SHIFT_CANCELLED');                          // terminal (T66)
  if (cancelAtt === true) return err('ATTENDANCE_BLOCKS_CHANGE');                              // attendance blocks cancel (T65)
  const revision = existing.revision + 1;
  const projection = stripIdentity(Object.assign({}, existing, { status: 'cancelled', revision, updatedAt: now })); // preserves the rest
  const changed = { status: { before: existing.status, after: 'cancelled' } };                 // T59 changed = { status } only
  const event = buildEvent(EVT_CANCELLED, scope, revision, actor, now, changed);
  return ok({ projection, event });
}

// =====================================================================
// canReadShift — slice-local read authority (admin-write / employee-read-own-assigned).
// Governing: Recommendation-008 §8 [R3] + T83/T84. Pure predicate; no I/O.
// =====================================================================
export function canReadShift({ actor, scope, projection }) {
  const se = scheduleScopeError(scope);
  if (se) return err(se);
  if (!actor || typeof actor !== 'object' || actor.accessEnabled !== true) return err('ACTOR_NOT_ENABLED');
  if (typeof actor.tenantId !== 'string' || actor.tenantId !== scope.tenantId) return err('CROSS_TENANT'); // T84 other tenant
  if (actor.accessRole === 'admin') return ok({ read: true });
  // employee: own assigned shift only — ownership is readable from the shift alone (T128)
  if (!projection || typeof projection !== 'object') return err('NO_SHIFT');
  if (projection.ansattId !== actor.ansattId) return err('NOT_OWN_SHIFT');                     // T84 other employee
  return ok({ read: true });
}
