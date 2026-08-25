// employee-shell-core.mjs
// ETR-1 — PURE MODEL ONLY. Dependency-free. No DOM, no network, no Firebase.
// Implements the accepted multi-tenant authority shape:
//   membership = { uid, tenantId, accessRole, ansattId, accessEnabled }
// Authority derives ONLY from membership objects passed in. This module never
// reads users/{uid}, email, display name, custom claims, PIN role, or tenant
// labels for authority. Fail-closed everywhere.
//
// Governing design: SOREN-SIRRHA-MULTI-TENANT-IDENTITY-AND-CONSOLIDATED-S1R-DESIGN-001.
// ETR-2a additions governed by SOREN-SIRRHA-ETR2-FINAL-ARCHITECTURE-FREEZE-003.

/**
 * Structural usability of a membership record for this slice.
 * Requires the five fields with correct types. ansattId may be a non-empty
 * string OR null (an admin membership may legitimately carry no ansattId);
 * any other ansattId shape is treated as malformed -> not usable.
 */
export function isUsableMembership(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.uid !== 'string' || m.uid.length === 0) return false;
  if (typeof m.tenantId !== 'string' || m.tenantId.length === 0) return false;
  if (typeof m.accessRole !== 'string' || m.accessRole.length === 0) return false;
  if (typeof m.accessEnabled !== 'boolean') return false;
  if (!(m.ansattId === null || typeof m.ansattId === 'string')) return false;
  return true;
}

/**
 * Eligible memberships for a requested uid:
 *  - structurally usable, AND
 *  - membership.uid === requestedUid (UID isolation), AND
 *  - accessEnabled === true.
 * Returns [] for a non-string/empty uid or non-array input (fail-closed).
 */
export function eligibleMemberships(memberships, requestedUid) {
  if (typeof requestedUid !== 'string' || requestedUid.length === 0) return [];
  if (!Array.isArray(memberships)) return [];
  return memberships.filter(
    (m) => isUsableMembership(m) && m.uid === requestedUid && m.accessEnabled === true
  );
}

/**
 * Deterministic routing from a requested uid + membership set:
 *   0 eligible -> { kind: 'no-access', uid }
 *   1 eligible -> { kind: 'direct', membership, eligible }
 *   2+ eligible -> { kind: 'picker', memberships, eligible }
 * `eligible` is included so a door selection can be constrained to it.
 */
export function resolveRouting(memberships, requestedUid) {
  const eligible = eligibleMemberships(memberships, requestedUid);
  const uid = typeof requestedUid === 'string' ? requestedUid : null;
  if (eligible.length === 0) return { kind: 'no-access', uid, eligible };
  if (eligible.length === 1) return { kind: 'direct', membership: eligible[0], eligible };
  return { kind: 'picker', memberships: eligible, eligible };
}

/**
 * Door/workplace selection. May select ONLY one of the already-eligible
 * memberships, identified by tenantId. No arbitrary tenantId can create
 * authority: a tenantId not present in `eligible` returns null. Ambiguous
 * (more than one eligible membership for the same tenantId) also returns null
 * (fail-closed).
 */
export function selectMembership(eligible, tenantId) {
  if (!Array.isArray(eligible)) return null;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
  const matches = eligible.filter(
    (m) => isUsableMembership(m) && m.accessEnabled === true && m.tenantId === tenantId
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The ansattId to scope own-shift reads to: the selected membership's ansattId
 * if it is a non-empty string, else null (fail-closed).
 */
export function usableAnsattId(selectedMembership) {
  if (!selectedMembership || typeof selectedMembership !== 'object') return null;
  const a = selectedMembership.ansattId;
  return typeof a === 'string' && a.length > 0 ? a : null;
}

/**
 * Own shifts for the selected membership. Uses ONLY selectedMembership.ansattId.
 * If there is no usable ansattId, returns [] (empty / fail-closed). Never falls
 * back to any other identifier.
 */
export function ownShifts(shifts, selectedMembership) {
  const ansattId = usableAnsattId(selectedMembership);
  if (!ansattId) return [];
  if (!Array.isArray(shifts)) return [];
  return shifts.filter((s) => s && typeof s === 'object' && s.ansattId === ansattId);
}

// =====================================================================
// ETR-2a — CLOCK PATH (fixture-only, pure model). No breaks (ETR-2b).
// Governing: SOREN-SIRRHA-ETR2-FINAL-ARCHITECTURE-FREEZE-003.
// FOUR-LAYER TIME: planned / observed / declared / approved — never collapsed.
// Every validator is a PURE function of injected (actor, existing, proposed,
// now, policy). No Date.now(), host timezone, DOM, storage, or network is read
// inside any validator. Instants are epoch-milliseconds (numbers).
// This client model is a SPECIFICATION for later Firestore rules, never
// production enforcement (G3).
// =====================================================================

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;

// ---- Fixture policy (PROVISIONAL Four Season values; Herish may change any) --
export const ETR2A_POLICY = Object.freeze({
  _PROVISIONAL: true,
  timezone: 'Europe/Oslo',
  declarationToleranceMinutes: 5,
  varianceToleranceMinutes: 15,
  employeeEditMode: 'once',       // 'never' | 'once' | 'untilApproved'
  editCutoffMode: 'tenantLocalDay',
  graceHours: 0,                  // preserves Herish's midnight rule exactly
  employeeMayAdjustTime: true,
  employeeClockingEnabled: true,
  managerCorrectionRequiresReason: true,
  maxEditWindowHours: 36,         // rule-enforced upper bound on the edit deadline
  // ETR-2b break policy (PROVISIONAL Four Season business settings, not invariants):
  breakMode: 'trackedStartEnd',   // 'trackedStartEnd' | 'fixedAutoDeduct' | 'manualTotal' | 'none'
  expectedBreakMinutes: 30,
  breakVarianceToleranceMinutes: 5,
  // reason codes: machine keys only; labels are UI concern; appliesTo/requiresNote
  reasonCodes: Object.freeze({
    FORGOT_CLOCK_IN:       { appliesTo: ['clock_in'], requiresNote: false },
    LATE_ARRIVAL:          { appliesTo: ['clock_in'], requiresNote: false },
    MANAGEMENT_DECISION:   { appliesTo: ['clock_in', 'clock_out', 'manager', 'break'], requiresNote: false },
    OTHER:                 { appliesTo: ['clock_in', 'clock_out', 'manager', 'break'], requiresNote: true },
    FORGOT_CLOCK_OUT:      { appliesTo: ['clock_out'], requiresNote: false },
    LEFT_EARLY:            { appliesTo: ['clock_out'], requiresNote: false },
    SICK_DEPARTURE:        { appliesTo: ['clock_out'], requiresNote: false },
    COVERED_FOR_COLLEAGUE: { appliesTo: ['clock_in', 'clock_out'], requiresNote: false },
    APP_UNAVAILABLE:       { appliesTo: ['clock_in', 'clock_out'], requiresNote: false },
    RETROACTIVE_ENTRY:     { appliesTo: ['manager'], requiresNote: false },
    // ETR-2b break reason codes (appliesTo 'break')
    FORGOT_BREAK_START:        { appliesTo: ['break'], requiresNote: false },
    FORGOT_BREAK_END:          { appliesTo: ['break'], requiresNote: false },
    EXTENDED_BREAK:            { appliesTo: ['break'], requiresNote: false },
    WORK_RELATED_INTERRUPTION: { appliesTo: ['break'], requiresNote: false },
    PERSONAL_REASON:           { appliesTo: ['break'], requiresNote: false },
  }),
});

// Exported for the ETR-2c schedule-core engine (one-way import). Pure result shapes.
export function ok(x) { return Object.assign({ ok: true }, x); }
export function err(code) { return { ok: false, code }; }

// ---- Deterministic identity -------------------------------------------------
export function attendanceIdFor(shiftId, ansattId) {
  if (typeof shiftId !== 'string' || shiftId.length === 0) return null; // shiftId REQUIRED, never null
  if (typeof ansattId !== 'string' || ansattId.length === 0) return null;
  return shiftId + '_' + ansattId;
}
export function eventIdFor(attendanceId, revision) {
  return attendanceId + '-rev-' + String(revision).padStart(6, '0');
}

// ---- Tenant-local day math (pure: uses the INJECTED timezone, not host) ------
// Uses Intl with an explicit timeZone; deterministic for a given instant/zone,
// and never reads Date.now() or the host timezone.
function zoneOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  const hour = m.hour === '24' ? '00' : m.hour;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +hour, +m.minute, +m.second);
  return asUTC - utcMs;
}
function localWallToUtcMs(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let inst = guess - zoneOffsetMs(guess, timeZone);
  const off2 = zoneOffsetMs(inst, timeZone);
  const inst2 = guess - off2;
  return inst2; // one refinement handles DST edges
}
export function startOfTenantLocalDayUtcMs(workDate, timeZone) {
  const [y, mo, d] = String(workDate).split('-').map(Number);
  return localWallToUtcMs(y, mo, d, 0, 0, timeZone);
}
export function endOfTenantLocalDayUtcMs(workDate, timeZone, graceHours) {
  const [y, mo, d] = String(workDate).split('-').map(Number);
  const nextMidnight = localWallToUtcMs(y, mo, d + 1, 0, 0, timeZone); // Date.UTC normalises day overflow
  return nextMidnight + (graceHours || 0) * HOUR_MS;
}

// ---- Tenant-timezone display/parse helpers (B8) -----------------------------
// Pure: derive the tenant business day/wall-time from the INJECTED timezone, never
// the host timezone. The UI must use these instead of host Date getters so a device
// in another zone cannot build the wrong workDate or local declared time.
export function tenantWorkDate(nowMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const m = {};
  for (const p of dtf.formatToParts(new Date(nowMs))) m[p.type] = p.value;
  return m.year + '-' + m.month + '-' + m.day;
}
export function fmtTenantHM(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-GB', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' });
  const m = {};
  for (const p of dtf.formatToParts(new Date(instantMs))) m[p.type] = p.value;
  const hh = m.hour === '24' ? '00' : m.hour;
  return String(hh).padStart(2, '0') + ':' + m.minute;
}
export function tenantLocalHMToUtcMs(workDate, hm, timeZone) {
  const [y, mo, d] = String(workDate).split('-').map(Number);
  const [h, mi] = String(hm).split(':').map(Number);
  return localWallToUtcMs(y, mo, d, h, mi, timeZone);
}
// The single injected action instant IS the observed fact; declared defaults to it.
// A client dialog must never display a stale earlier preview as the recorded observed
// timestamp (B9). observedAt always equals the one injected now.
export function computeClockTimes({ nowMs, declaredHM, workDate, timezone, mayAdjust }) {
  const observedAt = nowMs;
  let declaredAt = observedAt;
  if (mayAdjust === true && typeof declaredHM === 'string' && /^\d{2}:\d{2}$/.test(declaredHM)) {
    declaredAt = tenantLocalHMToUtcMs(workDate, declaredHM, timezone);
  }
  return { observedAt, declaredAt };
}

// ---- Fail-closed declared-time sanity (B2), shared by every transition -------
// Exported for the ETR-2c schedule-core engine (one-way import).
export function isFiniteInstant(v) { return typeof v === 'number' && Number.isFinite(v); }
function withinTenantWorkDay(v, workDate, policy) {
  const s = startOfTenantLocalDayUtcMs(workDate, policy.timezone);
  const e = endOfTenantLocalDayUtcMs(workDate, policy.timezone, policy.graceHours);
  return v >= s && v <= e;
}
// Deterministic edit deadline (B4): tenant-local-day cutoff (+grace) but never past
// createdAt + maxEditWindowHours (hard cap; grace can NOT extend beyond it). Unknown
// cutoff mode fails closed (deadline == createdAt -> any later edit is closed).
function editDeadlineFor(createdAt, workDate, policy) {
  if (policy.editCutoffMode !== 'tenantLocalDay') return createdAt;
  const cutoff = endOfTenantLocalDayUtcMs(workDate, policy.timezone, policy.graceHours || 0);
  const cap = createdAt + (policy.maxEditWindowHours || 0) * HOUR_MS;
  return Math.min(cutoff, cap);
}
// P2-2/P2-3: structural tenant/path scope is MANDATORY and fail-closed. The caller
// injects the request-path tenant as scope.tenantId (in production, the Firestore
// document path). No tenantId is stored on attendance as an authority shortcut; the
// shift's own tenant is never the authority mechanism. Both scope.tenantId and
// actor.tenantId must be present, non-empty and equal.
function scopeTenantError(actor, scope) {
  if (!scope || typeof scope !== 'object') return 'MISSING_SCOPE';
  if (typeof scope.tenantId !== 'string' || !scope.tenantId) return 'SCOPE_TENANT_INVALID';
  if (typeof actor.tenantId !== 'string' || !actor.tenantId) return 'MISSING_ACTOR_TENANT';
  if (actor.tenantId !== scope.tenantId) return 'CROSS_TENANT';
  return null;
}
// ETR-2c: DISTINCT full ScheduleScope structural validator (tenantId + shiftId), used
// ONLY by clockIn (attendance identity) and the four schedule validators. It is kept
// separate from the tenant-only contract above so the later attendance transitions
// (clockOut/employeeEdit/managerCorrection/approve/breaks) never accidentally require
// scope.shiftId. Structural validation ONLY; actor-tenant match is applied by the caller
// AFTER this, so a malformed scope can never reach id derivation (SCOPE-1..4, SCOPE-6).
// Returns an error code string, or null when structurally valid.
export function scheduleScopeError(scope) {
  if (!scope || typeof scope !== 'object') return 'MISSING_SCOPE';                        // SCOPE-1
  if (typeof scope.tenantId !== 'string' || !scope.tenantId) return 'SCOPE_TENANT_INVALID'; // SCOPE-2
  if (typeof scope.shiftId !== 'string' || !scope.shiftId) return 'SCOPE_SHIFT_INVALID';    // SCOPE-3
  return null;
}
// Shared actor/role/tenant scope contract for LATER transitions (B7 + P2-2). Tenant stays
// STRUCTURAL. requireOwn enforces ownership for employee-owned transitions. Scope is
// mandatory on every later transition.
function laterScopeError(actor, existing, allowedRoles, requireOwn, scope) {
  if (!actor || typeof actor !== 'object' || actor.accessEnabled !== true) return 'ACTOR_NOT_ENABLED';
  if (!allowedRoles.includes(actor.accessRole)) return requireOwn ? 'ROLE_NOT_ALLOWED' : 'NOT_ADMIN';
  if (requireOwn) {
    if (typeof actor.ansattId !== 'string' || !actor.ansattId) return 'ACTOR_NO_ANSATTID';
    if (existing && actor.ansattId !== existing.ansattId) return 'NOT_OWN';
  }
  return scopeTenantError(actor, scope);
}

// ---- Two-threshold reason logic ---------------------------------------------
export function reasonRequiredForClock(kind, { declaredAt, observedAt, plannedAt, policy }) {
  const declarationDeviationMin = Math.abs(declaredAt - observedAt) / MINUTE_MS;
  const varianceMin = Math.abs(declaredAt - plannedAt) / MINUTE_MS;
  const required =
    declarationDeviationMin > policy.declarationToleranceMinutes ||
    varianceMin > policy.varianceToleranceMinutes;
  return { required, declarationDeviationMin, varianceMin };
}
export function isReasonValid(kind, reasonCode, reasonNote, policy) {
  if (typeof reasonCode !== 'string' || !reasonCode) return false;
  const cfg = policy.reasonCodes[reasonCode];
  if (!cfg) return false;                       // not in the tenant's set (C19)
  if (!cfg.appliesTo.includes(kind)) return false; // wrong appliesTo (B16-analog / clock)
  if (cfg.requiresNote && !(typeof reasonNote === 'string' && reasonNote.trim().length > 0)) return false; // OTHER note (C20)
  return true;
}

// ---- Shift (planned) + independent append-only revision events --------------
export function createShift({ shiftId, ansattId, plannedStartAt, plannedEndAt, workDate, actorUid }, now) {
  if (typeof shiftId !== 'string' || !shiftId) return err('SHIFT_ID_REQUIRED');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');                                          // P2-4
  if (!isFiniteInstant(plannedStartAt) || !isFiniteInstant(plannedEndAt)) return err('PLANNED_NOT_FINITE'); // P2-5
  if (plannedEndAt < plannedStartAt) return err('END_BEFORE_START');                                 // P2-5 ordered
  const shift = {
    shiftId, ansattId, plannedStartAt, plannedEndAt, workDate,
    status: 'assigned', revision: 1,
    createdByUid: actorUid, createdAt: now, updatedAt: now,
  };
  const event = {
    type: 'shift_revision', shiftId, revision: 1, actorUid, at: now,
    changed: {
      plannedStartAt: { before: null, after: plannedStartAt },
      plannedEndAt: { before: null, after: plannedEndAt },
      status: { before: null, after: 'assigned' },
    },
  };
  return { shift, events: [event] };
}
// B1: explicit mutable-field whitelist. Any key outside it (shiftId, workDate,
// createdBy/At, revision, or arbitrary) is REJECTED, never silently applied. Every
// accepted change is represented in the revision event; a no-op fabricates nothing.
const SHIFT_MUTABLE = ['plannedStartAt', 'plannedEndAt', 'status', 'ansattId'];
export function reviseShift(shift, events, patch, now, actorUid) {
  if (!patch || typeof patch !== 'object') return err('NO_PATCH');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');                                          // P2-4
  for (const k of Object.keys(patch)) {
    if (!SHIFT_MUTABLE.includes(k)) return err('SHIFT_FIELD_NOT_MUTABLE:' + k);
  }
  const changed = {};
  const applied = {};
  for (const k of SHIFT_MUTABLE) {
    if (k in patch && patch[k] !== shift[k]) { changed[k] = { before: shift[k], after: patch[k] }; applied[k] = patch[k]; }
  }
  if (Object.keys(changed).length === 0) return err('NO_CHANGE');
  const newShift = Object.assign({}, shift, applied, { revision: shift.revision + 1, updatedAt: now });
  // P2-5: planned instants must be finite and ordered; no NaN/Infinity may enter the
  // projection or the append-only revision history, and no invalid event is emitted.
  if (!isFiniteInstant(newShift.plannedStartAt) || !isFiniteInstant(newShift.plannedEndAt)) return err('PLANNED_NOT_FINITE');
  if (newShift.plannedEndAt < newShift.plannedStartAt) return err('END_BEFORE_START');
  const event = { type: 'shift_revision', shiftId: shift.shiftId, revision: newShift.revision, actorUid, at: now, changed };
  return ok({ shift: newShift, event, events: events.concat([event]) });
}
// Reconstruct the planned state as of a given revision (prior revisions remain
// retrievable — S3). Folds the append-only revision events up to `revision`.
export function shiftRevisionState(events, revision) {
  let plannedStartAt = null, plannedEndAt = null, status = null;
  for (const ev of events) {
    if (ev.revision > revision) continue;
    if (ev.changed.plannedStartAt) plannedStartAt = ev.changed.plannedStartAt.after;
    if (ev.changed.plannedEndAt) plannedEndAt = ev.changed.plannedEndAt.after;
    if (ev.changed.status) status = ev.changed.status.after;
  }
  return { plannedStartAt, plannedEndAt, status };
}
// Any update/delete of an event (shift_revision or attendance event) is rejected.
export function rejectEventMutation(op) { return err('EVENT_IMMUTABLE:' + (op || 'mutate')); }

// ---- Event constructor (create-only) ----------------------------------------
function mkEvent(type, att, actor, now, reasonCode, reasonNote, changed) {
  return {
    eventId: eventIdFor(att.attendanceId, att.revision),
    type,
    attendanceId: att.attendanceId,
    revision: att.revision,
    actorUid: actor.uid,
    actorRole: actor.accessRole,
    actorAnsattId: (typeof actor.ansattId === 'string' && actor.ansattId) ? actor.ansattId : null,
    at: now,                      // server/injected time
    reasonCode: reasonCode || null,
    reasonNote: reasonNote || null,
    changed: changed || {},
  };
}
function diffMap(before, after, keys) {
  const changed = {};
  for (const k of keys) if (before[k] !== after[k]) changed[k] = { before: before[k], after: after[k] };
  return changed;
}

// ---- CLOCK IN (attendance create) -------------------------------------------
export function clockIn({ actor, shift, existing, declaredStartAt, reasonCode, reasonNote, plannedShiftRevision, scope }, now, policy) {
  if (!policy || policy.employeeClockingEnabled !== true) return err('CLOCKING_DISABLED');          // C9
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');                                           // P2-4
  if (!actor || typeof actor !== 'object' || actor.accessEnabled !== true) return err('ACTOR_NOT_ENABLED'); // T8
  if (actor.accessRole !== 'employee' && actor.accessRole !== 'admin') return err('ROLE_NOT_ALLOWED');
  if (typeof actor.ansattId !== 'string' || !actor.ansattId) return err('ACTOR_NO_ANSATTID');       // admin w/o ansattId (T23)
  // P2-3: structural tenant scope is REQUIRED before any ansattId comparison; ansattId
  // alone never establishes tenant authority, and the shift's own tenant is not the
  // authority mechanism.
  const se = scopeTenantError(actor, scope);
  if (se) return err(se);                                                                            // MISSING_SCOPE / SCOPE_TENANT_INVALID / MISSING_ACTOR_TENANT / CROSS_TENANT (C3)
  // ETR-2c: attendance identity is AUTHORITATIVE from scope.shiftId. Require it structurally
  // here (kept after the tenant-scope check so existing cross-tenant/scope error codes are
  // preserved); a malformed scope.shiftId never reaches id derivation below.
  if (typeof scope.shiftId !== 'string' || !scope.shiftId) return err('SCOPE_SHIFT_INVALID');
  if (!shift || typeof shift.shiftId !== 'string' || !shift.shiftId) return err('NO_SHIFT');        // C7 shiftId required
  // ETR-2c: legacy shift.shiftId is inspected for equality/integrity ONLY, never authority.
  if (shift.shiftId !== scope.shiftId) return err('SHIFT_SCOPE_MISMATCH');                           // T126
  if (shift.status !== 'assigned') return err('SHIFT_NOT_ASSIGNED');                                 // C8 cancelled / open (T118/T120)
  if (shift.ansattId !== actor.ansattId) return err('NOT_OWN_SHIFT');                                // C2 (after tenant scope)
  if (existing) return err('DUPLICATE_ATTENDANCE');                                                  // C4 deterministic id exists
  if (plannedShiftRevision != null && plannedShiftRevision !== shift.revision) return err('SHIFT_REVISION_MISMATCH'); // S5

  const observedClockInAt = now;                          // server/injected; immutable
  const declared = (declaredStartAt == null) ? now : declaredStartAt;
  if (declared !== observedClockInAt && policy.employeeMayAdjustTime !== true) return err('TIME_ADJUST_NOT_ALLOWED'); // C22
  // B2: fail-closed declared-time sanity. A reason can never rescue an impossible or
  // out-of-bound instant. Applied here at creation, not only in later edits.
  if (!isFiniteInstant(declared)) return err('DECLARED_NOT_FINITE');
  if (!withinTenantWorkDay(declared, shift.workDate, policy)) return err('DECLARED_OUTSIDE_WORKDATE');

  const rr = reasonRequiredForClock('clock_in', { declaredAt: declared, observedAt: observedClockInAt, plannedAt: shift.plannedStartAt, policy });
  if (rr.required && !isReasonValid('clock_in', reasonCode, reasonNote, policy)) return err('REASON_REQUIRED'); // C15/C19/C20

  const attendanceId = attendanceIdFor(scope.shiftId, actor.ansattId); // ETR-2c: authoritative from scope.shiftId (T124/T125)
  if (!attendanceId) return err('NO_SHIFT');
  const deadline = editDeadlineFor(now, shift.workDate, policy); // B4: cutoff capped by maxEditWindowHours

  const attendance = {
    attendanceId, shiftId: scope.shiftId, ansattId: actor.ansattId, createdByUid: actor.uid, // ETR-2c: attendance.shiftId from scope
    workDate: shift.workDate,
    plannedSnapshot: { startAt: shift.plannedStartAt, endAt: shift.plannedEndAt },
    plannedShiftRevision: shift.revision,
    observedClockInAt, observedClockOutAt: null,
    declaredStartAt: declared, declaredEndAt: null,
    approvedStartAt: null, approvedEndAt: null, approvedByUid: null, approvedAt: null,
    status: 'clocked_in', employeeEditCount: 0, employeeEditDeadline: deadline,
    // ETR-2b break projection (Freeze 003 §3.3). Observed break history lives in the
    // append-only break_start/break_end events; these are derived current-state fields.
    breakState: 'working', openBreakStartedAt: null,
    observedBreakMinutesTotal: 0, declaredBreakMinutesTotal: null,
    approvedBreakMinutesTotal: null, breakCount: 0,
    revision: 1, createdAt: now, updatedAt: now,
  };
  const event = mkEvent('clock_in', attendance, actor, now, reasonCode, reasonNote, {
    observedClockInAt: { before: null, after: observedClockInAt },
    declaredStartAt: { before: null, after: declared },
  });
  return ok({ attendance, event, reason: rr });
}

// ---- CLOCK OUT ---------------------------------------------------------------
export function clockOut({ actor, existing, declaredEndAt, reasonCode, reasonNote, scope }, now, policy) {
  if (!existing) return err('NO_ATTENDANCE');
  if (existing.status !== 'clocked_in') return err('NOT_CLOCKED_IN');                 // C5 (no clock-in) / C6 (second clock-out)
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');                            // P2-4
  const se = laterScopeError(actor, existing, ['employee', 'admin'], true, scope);    // B7 role+own + P2-2 mandatory tenant scope
  if (se) return err(se);
  // P3: observed clock-out (now) can never precede the immutable observed clock-in.
  // existing.observedClockInAt must be a finite fact; a rejection here produces no
  // revision, event, mutation, or observed/provenance fact. Equality is allowed.
  if (!isFiniteInstant(existing.observedClockInAt)) return err('OBSERVED_IN_NOT_FINITE');
  if (now < existing.observedClockInAt) return err('CLOCK_OUT_BEFORE_CLOCK_IN');
  // ETR-2b: cannot clock out while a break is open. The employee must end the break
  // first; never silently auto-close and never synthesize a break_end here.
  if (existing.breakState === 'on_break') return err('BREAK_OPEN');
  const observedClockOutAt = now;                        // server/injected; immutable
  const declared = (declaredEndAt == null) ? now : declaredEndAt;
  if (declared !== observedClockOutAt && policy.employeeMayAdjustTime !== true) return err('TIME_ADJUST_NOT_ALLOWED');
  if (!isFiniteInstant(declared)) return err('DECLARED_NOT_FINITE');                  // B2
  if (!withinTenantWorkDay(declared, existing.workDate, policy)) return err('DECLARED_OUTSIDE_WORKDATE'); // B2
  if (existing.declaredStartAt != null && declared < existing.declaredStartAt) return err('END_BEFORE_START'); // B2 impossible interval
  const rr = reasonRequiredForClock('clock_out', { declaredAt: declared, observedAt: observedClockOutAt, plannedAt: existing.plannedSnapshot.endAt, policy });
  if (rr.required && !isReasonValid('clock_out', reasonCode, reasonNote, policy)) return err('REASON_REQUIRED');
  const attendance = Object.assign({}, existing, {
    observedClockOutAt, declaredEndAt: declared, status: 'clocked_out',
    revision: existing.revision + 1, updatedAt: now,
  });
  const event = mkEvent('clock_out', attendance, actor, now, reasonCode, reasonNote, {
    observedClockOutAt: { before: null, after: observedClockOutAt },
    declaredEndAt: { before: null, after: declared },
  });
  return ok({ attendance, event, reason: rr });
}

// ---- EMPLOYEE EDIT (declared times / note only; once; pre-approval; in window)
const EMPLOYEE_EDITABLE = ['declaredStartAt', 'declaredEndAt', 'note'];
// Employees never delete attendance in any state (T9), by design: there is no
// delete transition in this model. Exposed as a constant for explicit testing.
export const EMPLOYEE_MAY_DELETE = false;
const EMPLOYEE_EDITABLE_STATUSES = ['clocked_in', 'clocked_out'];
export function employeeEdit({ actor, existing, patch, reasonCode, reasonNote, scope }, now, policy) {
  if (!existing) return err('NO_ATTENDANCE');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');                            // P2-4
  const se = laterScopeError(actor, existing, ['employee', 'admin'], true, scope);    // B7 role+own + P2-2 mandatory tenant scope
  if (se) return err(se);
  if (existing.status === 'approved') return err('ALREADY_APPROVED');                 // T6 / C34
  if (!EMPLOYEE_EDITABLE_STATUSES.includes(existing.status)) return err('STATUS_NOT_EDITABLE'); // T21 unrecognised status fail-closed
  if (!patch || typeof patch !== 'object') return err('NO_PATCH');
  for (const k of Object.keys(patch)) {
    if (!EMPLOYEE_EDITABLE.includes(k)) return err('FIELD_NOT_EDITABLE:' + k);        // T11-T15 tamper (ansattId/workDate/observed/approval/deadline...)
  }
  const proposed = Object.assign({}, existing, patch);
  const changed = diffMap(existing, proposed, EMPLOYEE_EDITABLE);
  if (Object.keys(changed).length === 0) return err('NO_CHANGE');                     // B3: no-op consumes no allowance/revision/event
  // B4: policy modes actually enforced (not just advertised).
  const mode = policy.employeeEditMode;
  if (mode === 'never') return err('EDIT_DISABLED');
  else if (mode === 'once') { if (existing.employeeEditCount >= 1) return err('EDIT_LIMIT'); } // T5
  else if (mode === 'untilApproved') { /* repeated edits allowed while not approved (blocked above) */ }
  else return err('EDIT_MODE_INVALID');                                              // unsupported policy fails closed
  if (now >= existing.employeeEditDeadline) return err('EDIT_WINDOW_CLOSED');          // T7 / T24 strictly-before boundary
  // declared times must stay finite and within the immutable workDate local day (+grace) (T16 / B2)
  for (const f of ['declaredStartAt', 'declaredEndAt']) {
    const v = proposed[f];
    if (v != null && !isFiniteInstant(v)) return err('DECLARED_NOT_FINITE');
    if (v != null && !withinTenantWorkDay(v, existing.workDate, policy)) return err('DECLARED_OUTSIDE_WORKDATE');
  }
  if (proposed.declaredEndAt != null && proposed.declaredStartAt != null && proposed.declaredEndAt < proposed.declaredStartAt) return err('END_BEFORE_START');
  // B3: an edit that changes a declared time cannot bypass the two-threshold reason
  // model. Recompute declared-vs-observed and declared-vs-planned for each changed
  // side; a valid machine reason is required where the applicable threshold is exceeded.
  const kindsNeedingReason = [];
  if ('declaredStartAt' in changed) {
    const rr = reasonRequiredForClock('clock_in', { declaredAt: proposed.declaredStartAt, observedAt: existing.observedClockInAt, plannedAt: existing.plannedSnapshot.startAt, policy });
    if (rr.required) kindsNeedingReason.push('clock_in');
  }
  if ('declaredEndAt' in changed) {
    let required;
    if (existing.observedClockOutAt != null) {
      required = reasonRequiredForClock('clock_out', { declaredAt: proposed.declaredEndAt, observedAt: existing.observedClockOutAt, plannedAt: existing.plannedSnapshot.endAt, policy }).required;
    } else {
      required = (Math.abs(proposed.declaredEndAt - existing.plannedSnapshot.endAt) / MINUTE_MS) > policy.varianceToleranceMinutes;
    }
    if (required) kindsNeedingReason.push('clock_out');
  }
  for (const k of kindsNeedingReason) {
    if (!isReasonValid(k, reasonCode, reasonNote, policy)) return err('REASON_REQUIRED');
  }
  const attendance = Object.assign({}, proposed, { employeeEditCount: existing.employeeEditCount + 1, revision: existing.revision + 1, updatedAt: now });
  const event = mkEvent('employee_edit', attendance, actor, now, reasonCode, reasonNote, changed);
  return ok({ attendance, event });
}

// ---- MANAGER CORRECTION (admin only; never touches observed; reasoned) -------
// B5: manager authority is broad but TYPED, not an open denylist. Only these business
// fields are correctable. Observed times, ownership, stable identity, shift linkage/
// snapshot, counters, revision, event history, approval provenance, status and any
// arbitrary field are never caller-mutable through the generic correction patch.
// ETR-2b: approvedBreakMinutesTotal is an admin-only APPROVED fact; adding it here (and
// NOT to EMPLOYEE_EDITABLE) lets an admin establish/correct it while employees cannot.
const MANAGER_CORRECTABLE = ['declaredStartAt', 'declaredEndAt', 'note', 'approvedBreakMinutesTotal'];
export function managerCorrection({ actor, existing, patch, reasonCode, reasonNote, scope }, now, policy) {
  if (!existing) return err('NO_ATTENDANCE');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');                           // P2-4
  const se = laterScopeError(actor, existing, ['admin'], false, scope);              // B7 admin role + P2-2 mandatory tenant scope
  if (se) return err(se);
  if (!patch || typeof patch !== 'object') return err('NO_PATCH');
  for (const k of Object.keys(patch)) {
    if (!MANAGER_CORRECTABLE.includes(k)) return err('FIELD_NOT_CORRECTABLE:' + k);   // status/counters/observed/arbitrary all rejected
  }
  const proposed = Object.assign({}, existing, patch);
  const changed = diffMap(existing, proposed, MANAGER_CORRECTABLE);
  if (Object.keys(changed).length === 0) return err('NO_CHANGE');                     // no-op fabricates no revision/event
  // corrected declared times must pass the same fail-closed sanity (B2/B5)
  for (const f of ['declaredStartAt', 'declaredEndAt']) {
    if (f in changed) {
      const v = proposed[f];
      if (!isFiniteInstant(v)) return err('DECLARED_NOT_FINITE');
      if (!withinTenantWorkDay(v, existing.workDate, policy)) return err('DECLARED_OUTSIDE_WORKDATE');
    }
  }
  if (proposed.declaredEndAt != null && proposed.declaredStartAt != null && proposed.declaredEndAt < proposed.declaredStartAt) return err('END_BEFORE_START');
  // ETR-2b: approvedBreakMinutesTotal (admin-only) must be a finite non-negative integer.
  if ('approvedBreakMinutesTotal' in changed) {
    const v = proposed.approvedBreakMinutesTotal;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return err('APPROVED_BREAK_INVALID');
  }
  if (policy.managerCorrectionRequiresReason && !isReasonValid('manager', reasonCode, reasonNote, policy)) return err('REASON_REQUIRED'); // C28
  // provenance derived from authorized actor/time; revision monotonic
  const attendance = Object.assign({}, existing, changedValues(changed), { revision: existing.revision + 1, updatedAt: now });
  const event = mkEvent('manager_correction', attendance, actor, now, reasonCode, reasonNote, changed);
  return ok({ attendance, event });
}
function changedValues(changed) {
  const out = {};
  for (const k of Object.keys(changed)) out[k] = changed[k].after;
  return out;
}

// ---- APPROVAL (admin only; sets approved* + approvedBy/At) -------------------
export function approve({ actor, existing, approvedStartAt, approvedEndAt, scope }, now, policy) {
  if (!existing) return err('NO_ATTENDANCE');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');                           // P2-4
  const se = laterScopeError(actor, existing, ['admin'], false, scope);              // B7 admin role + P2-2 mandatory tenant scope
  if (se) return err(se);
  if (!isFiniteInstant(approvedStartAt) || !isFiniteInstant(approvedEndAt)) return err('APPROVED_TIMES_REQUIRED');
  if (approvedEndAt < approvedStartAt) return err('END_BEFORE_START');
  // sane bound around the planned snapshot (C37)
  const lo = existing.plannedSnapshot.startAt - 24 * HOUR_MS;
  const hi = existing.plannedSnapshot.endAt + 24 * HOUR_MS;
  if (approvedStartAt < lo || approvedEndAt > hi) return err('APPROVED_OUT_OF_BOUND');
  // B6: cannot approve an incomplete attendance — clock-out must have happened.
  if (existing.status !== 'clocked_out') return err('NOT_CLOCKED_OUT');
  // P2-1: status alone is not trusted. The completion facts must be structurally present,
  // finite, correctly ordered and within the workDate bounds; a malformed projection is
  // never approvable.
  for (const f of ['observedClockInAt', 'observedClockOutAt', 'declaredStartAt', 'declaredEndAt']) {
    if (!isFiniteInstant(existing[f])) return err('INCOMPLETE_ATTENDANCE:' + f);
  }
  if (existing.observedClockOutAt < existing.observedClockInAt) return err('MALFORMED_OBSERVED_INTERVAL');
  if (existing.declaredEndAt < existing.declaredStartAt) return err('MALFORMED_DECLARED_INTERVAL');
  for (const f of ['declaredStartAt', 'declaredEndAt']) {
    if (!withinTenantWorkDay(existing[f], existing.workDate, policy)) return err('DECLARED_OUTSIDE_WORKDATE');
  }
  const attendance = Object.assign({}, existing, {
    approvedStartAt, approvedEndAt, approvedByUid: actor.uid, approvedAt: now,
    status: 'approved', revision: existing.revision + 1, updatedAt: now,
  });
  const event = mkEvent('approval', attendance, actor, now, null, null, {
    approvedStartAt: { before: existing.approvedStartAt, after: approvedStartAt },
    approvedEndAt: { before: existing.approvedEndAt, after: approvedEndAt },
    status: { before: existing.status, after: 'approved' },
  });
  return ok({ attendance, event });
}

// =====================================================================
// ETR-2b — BREAK PATH (fixture-only). break_start / break_end are OBSERVATION
// transitions (no variance gate); declareBreak() is the DECLARED transition that
// carries the two-threshold break-variance gate (declared vs expected). Governing:
// Freeze 003 §3 + SIRRHA-CCODE-ETR2B-PREBUILD-DESIGN-RULING-001.
// =====================================================================
// Break variance is evaluated ONLY on the declaration (declared vs expected), never
// per intermediate break_end (multiple sequential breaks are frozen behavior).
export function reasonRequiredForBreak(declaredBreakMinutesTotal, policy) {
  const varianceMin = Math.abs(declaredBreakMinutesTotal - policy.expectedBreakMinutes);
  return { required: varianceMin > policy.breakVarianceToleranceMinutes, varianceMin };
}

// START BREAK — observation transition. Observed start = the single injected now.
export function startBreak({ actor, existing, scope }, now, policy) {
  if (!existing) return err('NO_ATTENDANCE');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');                            // P2-4 parity
  const se = laterScopeError(actor, existing, ['employee', 'admin'], true, scope);    // reuse P2-2 scope + role + own
  if (se) return err(se);
  if (!policy || policy.breakMode === 'none') return err('BREAK_DISABLED');           // B18
  if (existing.status !== 'clocked_in') return err('NOT_CLOCKED_IN');                 // B2 (no attendance) / B3 (clocked_out)
  if (existing.breakState === 'on_break') return err('BREAK_ALREADY_OPEN');           // B4
  if (existing.breakState !== 'working') return err('BREAK_STATE_INVALID');           // fail-closed
  const observedBreakStartAt = now;                     // server/injected; client cannot supply (B12)
  const attendance = Object.assign({}, existing, {
    breakState: 'on_break', openBreakStartedAt: observedBreakStartAt,
    revision: existing.revision + 1, updatedAt: now,
  });
  const event = mkEvent('break_start', attendance, actor, now, null, null, {
    observedBreakStartAt: { before: null, after: observedBreakStartAt },
    breakState: { before: 'working', after: 'on_break' },
  });
  return ok({ attendance, event });
}

// END BREAK — observation transition. Observed end = the single injected now.
// NO expected-total variance check here (design ruling §5A).
export function endBreak({ actor, existing, scope }, now, policy) {
  if (!existing) return err('NO_ATTENDANCE');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');
  const se = laterScopeError(actor, existing, ['employee', 'admin'], true, scope);
  if (se) return err(se);
  if (!policy || policy.breakMode === 'none') return err('BREAK_DISABLED');           // B18
  if (existing.status !== 'clocked_in') return err('NOT_CLOCKED_IN');
  if (existing.breakState !== 'on_break') return err('BREAK_NOT_OPEN');               // B5
  if (!isFiniteInstant(existing.openBreakStartedAt)) return err('OPEN_BREAK_NOT_FINITE'); // chronology/integrity
  if (now < existing.openBreakStartedAt) return err('BREAK_END_BEFORE_START');        // chronology; equality allowed
  const observedBreakEndAt = now;
  const segmentMinutes = Math.round((observedBreakEndAt - existing.openBreakStartedAt) / MINUTE_MS); // deterministic minute rule
  const attendance = Object.assign({}, existing, {
    breakState: 'working', openBreakStartedAt: null,
    observedBreakMinutesTotal: existing.observedBreakMinutesTotal + segmentMinutes,   // B9 (recomputed each break_end)
    breakCount: existing.breakCount + 1,                                              // B6 (completed pair only)
    revision: existing.revision + 1, updatedAt: now,
  });
  const event = mkEvent('break_end', attendance, actor, now, null, null, {
    observedBreakEndAt: { before: null, after: observedBreakEndAt },
    observedBreakMinutesTotal: { before: existing.observedBreakMinutesTotal, after: attendance.observedBreakMinutesTotal },
    breakState: { before: 'on_break', after: 'working' },
  });
  return ok({ attendance, event });
}

// DEDICATED EMPLOYEE BREAK DECLARATION — the DECLARED transition (design ruling §2/§5B).
// Sets declaredBreakMinutesTotal and appends an employee_declaration event; carries the
// two-threshold break-variance gate (DECLARED vs EXPECTED). Never widens employeeEdit,
// never writes observed or approved break facts.
const BREAK_DECLARABLE_STATUSES = ['clocked_in', 'clocked_out'];
export function declareBreak({ actor, existing, declaredBreakMinutesTotal, reasonCode, reasonNote, scope }, now, policy) {
  if (!existing) return err('NO_ATTENDANCE');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');
  const se = laterScopeError(actor, existing, ['employee', 'admin'], true, scope);
  if (se) return err(se);
  if (!policy || policy.breakMode === 'none') return err('BREAK_DISABLED');           // B18 (fail-closed parity with startBreak/endBreak)
  if (existing.status === 'approved') return err('ALREADY_APPROVED');
  if (!BREAK_DECLARABLE_STATUSES.includes(existing.status)) return err('STATUS_NOT_DECLARABLE'); // fail-closed
  if (existing.breakState === 'on_break') return err('BREAK_OPEN');                   // cannot declare a total while a break is open
  // explicit finite, non-negative, integer-minute contract
  if (typeof declaredBreakMinutesTotal !== 'number' || !Number.isInteger(declaredBreakMinutesTotal) || declaredBreakMinutesTotal < 0) return err('DECLARED_BREAK_INVALID');
  if (existing.declaredBreakMinutesTotal === declaredBreakMinutesTotal) return err('NO_CHANGE'); // no-op fabricates nothing
  // two-threshold gate: DECLARED total vs EXPECTED (B13-B16); observed is never substituted.
  const rr = reasonRequiredForBreak(declaredBreakMinutesTotal, policy);
  if (rr.required && !isReasonValid('break', reasonCode, reasonNote, policy)) return err('REASON_REQUIRED'); // B14 / B16
  const attendance = Object.assign({}, existing, {
    declaredBreakMinutesTotal, revision: existing.revision + 1, updatedAt: now,
  });
  const event = mkEvent('employee_declaration', attendance, actor, now, reasonCode, reasonNote, {
    declaredBreakMinutesTotal: { before: existing.declaredBreakMinutesTotal, after: declaredBreakMinutesTotal },
  });
  return ok({ attendance, event });
}

// ---- Pure invariant predicates (used directly by tests + future rules) -------
export function assertObservedImmutable(existing, proposed) {
  if (existing.observedClockInAt != null && proposed.observedClockInAt !== existing.observedClockInAt) return err('OBSERVED_IN_IMMUTABLE');
  if (existing.observedClockOutAt != null && proposed.observedClockOutAt !== existing.observedClockOutAt) return err('OBSERVED_OUT_IMMUTABLE');
  return ok({});
}
export function assertApprovalFieldsAdminOnly(actorRole, existing, proposed) {
  const APPROVAL = ['approvedStartAt', 'approvedEndAt', 'approvedByUid', 'approvedAt'];
  const touched = APPROVAL.some((k) => proposed[k] !== existing[k]);
  if (touched && actorRole !== 'admin') return err('APPROVAL_ADMIN_ONLY');
  return ok({});
}
export function assertOwnershipImmutable(existing, proposed) {
  for (const k of ['ansattId', 'shiftId', 'workDate', 'attendanceId', 'plannedShiftRevision']) {
    if (proposed[k] !== existing[k]) return err('OWNERSHIP_IMMUTABLE:' + k);
  }
  const a = existing.plannedSnapshot, b = proposed.plannedSnapshot;
  if (!a || !b || a.startAt !== b.startAt || a.endAt !== b.endAt) return err('OWNERSHIP_IMMUTABLE:plannedSnapshot');
  return ok({});
}
export function assertRevisionMonotonic(existing, proposed) {
  if (proposed.revision !== existing.revision + 1) return err('REVISION_NOT_MONOTONIC'); // C30/C31
  return ok({});
}
export function eventIdMatchesRevision(event) {
  return event.eventId === eventIdFor(event.attendanceId, event.revision); // C32
}
// Detect gaps in an event stream: revisions must be 1..N contiguous (C33).
export function detectRevisionGaps(events) {
  const revs = events.map((e) => e.revision).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 0; i < revs.length; i++) {
    const expected = i + 1;
    if (revs[i] !== expected) { gaps.push(expected); break; }
  }
  return { hasGap: gaps.length > 0, gaps };
}

// ---- Landing (Today/Clocking) reads from exactly TWO documents, no query (L1)
export function landingReads(shiftId, ansattId) {
  const attendanceId = attendanceIdFor(shiftId, ansattId);
  return {
    query: false,
    reads: [
      { kind: 'shift', id: shiftId },
      { kind: 'attendance', id: attendanceId },
    ],
  };
}
