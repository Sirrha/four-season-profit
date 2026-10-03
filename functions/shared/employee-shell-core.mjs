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
  graceHours: 6,                  // OD-5 ratified 2026-09-25 (HERISH-SIRRHA-S4-OWNER-RATIFICATIONS-FREEZE-001): an overnight shift stays on its workDate; declared times / the one-shot edit are allowed until 06:00 local the next morning (was 0)
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
// 3B-FOUNDATION §6: the manual (no-shift) namespace gets its OWN constructor; attendanceIdFor
// above is NOT weakened — its "shiftId required" contract is correct for shift-keyed attendance
// and stays frozen. Deterministic: the same employee-day always resolves to the same id, so a
// second manual entry for that day becomes a correction (revision+1), never a duplicate record.
// The 'manual-' prefix is disjoint from '<shiftId>_<ansattId>' and from the minted
// 'mg-<workDate>-<ansattId>' shift ids (proved against the live generators, not by inspection).
export function manualAttendanceIdFor(workDate, ansattId) {
  if (typeof workDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return null; // fail closed
  if (typeof ansattId !== 'string' || ansattId.length === 0) return null;
  return 'manual-' + workDate + '-' + ansattId;
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
  // 3B-FOUNDATION §5: once management has ATTESTED a day, an employee clock event on that record
  // would interleave receipts with assertions. The resolution path is a manager correction, not a
  // competing stream. Checked before the generic duplicate refusal so the reason is named.
  if (existing && existing.status === 'attested') return err('ATTESTERT_AV_LEDELSE');
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
// 3B-FOUNDATION §4 amends this allowlist in BOTH directions:
//   ADD    declaredBreakMinutesTotal — the field daySummaryFor actually reads. As built, a
//          manager "break correction" wrote approvedBreakMinutesTotal, which the derivation
//          never consults, so manager break corrections were silently ineffective. This repairs
//          that latent defect as well as enabling the new capability.
//   REMOVE approvedBreakMinutesTotal — approval values are written by approve() ONLY. A
//          correction ASSERTS truth; an approval ENDORSES it. One field, one writer.
// Observed times, ownership, stable identity, shift linkage/snapshot, counters, revision, event
// history, approval provenance, status and any arbitrary field remain never caller-mutable.
const MANAGER_CORRECTABLE = ['declaredStartAt', 'declaredEndAt', 'note', 'declaredBreakMinutesTotal'];
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
  // 3B-FOUNDATION §4: the manager's break write is the DECLARED total (the derivation input).
  // Integer, non-negative, and strictly less than the effective worked span — an explicit 0 is
  // valid and settles the break; a deduction that swallows the span is refused here rather than
  // being left for daySummaryFor's fail-closed branch to silently absorb.
  if ('declaredBreakMinutesTotal' in changed) {
    const v = proposed.declaredBreakMinutesTotal;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return err('DECLARED_BREAK_INVALID');
    const spanErr = breakWithinSpan(v, proposed.declaredStartAt, proposed.declaredEndAt);
    if (spanErr) return err(spanErr);
    // Mirrors declareBreak's own rule: a total cannot be declared while a break is still open.
    // Scoped to this NEW field only — the frozen correction behavior for declared times on a
    // live record is deliberately left exactly as built (C28/C29).
    if (existing.breakState === 'on_break') return err('BREAK_OPEN');
  }
  if (policy.managerCorrectionRequiresReason && !isReasonValid('manager', reasonCode, reasonNote, policy)) return err('REASON_REQUIRED'); // C28
  // provenance derived from authorized actor/time; revision monotonic
  // declarationSource marks WHO asserted the declared facts now standing on this record; it is
  // the semantic switch daySummaryFor consults (the event still carries who/why). Stamping it on
  // a clock-origin correction changes no derivation: CASE 4 additionally requires that no
  // observed receipt exists, so cases 1-3 keep their existing behavior exactly.
  const attendance = Object.assign({}, existing, changedValues(changed), { declarationSource: 'manager', revision: existing.revision + 1, updatedAt: now });
  // 3B-FOUNDATION §8 (revision binding): approval attaches to the revision it approved and
  // NEVER floats onto a later correction. Correcting an approved record clears the approval
  // fields into the new revision and returns the day to its legitimate pre-approval state —
  // management-attested truth to 'attested', completed clock truth to 'clocked_out'. No clock
  // fact is fabricated to do this, and the prior approval EVENT is retained as history.
  if (existing.status === 'approved') {
    attendance.approvedStartAt = null; attendance.approvedEndAt = null;
    attendance.approvedByUid = null; attendance.approvedAt = null;
    attendance.approvedBreakMinutesTotal = null;
    attendance.status = existing.declarationSource === 'manager' && existing.observedClockInAt == null ? 'attested' : 'clocked_out';
  }
  const event = mkEvent('manager_correction', attendance, actor, now, reasonCode, reasonNote, changed);
  return ok({ attendance, event });
}
function changedValues(changed) {
  const out = {};
  for (const k of Object.keys(changed)) out[k] = changed[k].after;
  return out;
}
// Break must be an integer, non-negative and STRICTLY less than the worked span; an explicit 0
// is valid and settles the break. Returns an error code string, or null when acceptable.
function breakWithinSpan(minutes, startAt, endAt) {
  if (!isFiniteInstant(startAt) || !isFiniteInstant(endAt)) return null;   // span unknown here
  if (minutes * MINUTE_MS >= (endAt - startAt)) return 'BREAK_EXCEEDS_SPAN';
  return null;
}

// ---- MANAGER MANUAL ENTRY (3B-FOUNDATION §§1/5/6/8) --------------------------
// The admin-scoped assertion that a day WAS worked when no clock receipt exists. It writes
// DECLARED facts only and stamps declarationSource='manager', which is the single mechanical
// carrier of the authorization boundary that lets daySummaryFor's CASE 4 stand alone.
//
// SOURCE-REALITY NOTE (recorded, not worked around): the built model has NO 'assigned'
// ATTENDANCE record — 'assigned' is a SHIFT status (createShift), and a planned shift with no
// clock-in has no attendance row at all. CASE M1 is therefore "a shift exists, no attendance
// does": pass the shift and the record is shift-keyed and carries its plannedSnapshot. CASE M2
// passes no shift and is manual-keyed with plannedSnapshot null. Both are born 'attested'.
// Correcting an existing record is NOT this operation — that is managerCorrection.
//
// ATOMIC: both endpoints and an explicit break, or the whole entry is refused by name. Nothing
// is mutated on rejection (every path here is pure and returns a fresh object only on success).
export function managerManualEntry({ actor, existing, shift, ansattId, workDate, declaredStartAt, declaredEndAt, declaredBreakMinutesTotal, employment, reasonCode, reasonNote, scope }, now, policy) {
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');
  if (!policy || typeof policy !== 'object') return err('POLICY_REQUIRED');
  // admin scope, via the SAME contract every later transition uses (B7 + P2-2).
  const se = laterScopeError(actor, existing || null, ['admin'], false, scope);
  if (se) return err(se);
  if (typeof ansattId !== 'string' || !ansattId) return err('ANSATT_REQUIRED');
  if (typeof workDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return err('WORKDATE_INVALID');
  // 3B-FOUNDATION §2 CASE 6 / §8: never overwrite a live receipt stream, and never silently
  // convert an existing record — a second entry for the same employee-day is a CORRECTION.
  if (existing) {
    if (existing.status === 'clocked_in' || existing.breakState === 'on_break') return err('OEKT_PAAGAAR');
    return err('ATTENDANCE_EXISTS');       // caller routes to managerCorrection (revision+1)
  }
  // employment range. The facts are INJECTED (same discipline as policy/scope) so this module
  // keeps its zero-import property and no parallel employee source is created here.
  if (!employment || typeof employment !== 'object') return err('EMPLOYMENT_REQUIRED');
  if (typeof employment.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(employment.startDate)) return err('EMPLOYMENT_REQUIRED');
  if (workDate < employment.startDate) return err('BEFORE_EMPLOYMENT_START');
  if (typeof employment.endDate === 'string' && employment.endDate && workDate > employment.endDate) return err('AFTER_EMPLOYMENT_END');
  // declared pair: complete, finite, ordered, and placed on the workDate by the frozen rule
  // (an overnight entry belongs WHOLE to its workDate; nothing is split across days/months).
  if (!isFiniteInstant(declaredStartAt) || !isFiniteInstant(declaredEndAt)) return err('DECLARED_NOT_FINITE');
  if (declaredEndAt <= declaredStartAt) return err('END_BEFORE_START');
  for (const v of [declaredStartAt, declaredEndAt]) {
    if (!withinTenantWorkDay(v, workDate, policy)) return err('DECLARED_OUTSIDE_WORKDATE');
  }
  if (typeof declaredBreakMinutesTotal !== 'number' || !Number.isInteger(declaredBreakMinutesTotal) || declaredBreakMinutesTotal < 0) return err('DECLARED_BREAK_INVALID');
  const spanErr = breakWithinSpan(declaredBreakMinutesTotal, declaredStartAt, declaredEndAt);
  if (spanErr) return err(spanErr);
  // reason discipline: the same 'manager' reason contract managerCorrection already enforces.
  if (policy.managerCorrectionRequiresReason && !isReasonValid('manager', reasonCode, reasonNote, policy)) return err('REASON_REQUIRED');

  let attendanceId, shiftId, plannedSnapshot, plannedShiftRevision;
  if (shift) {                                    // CASE M1 — a planned shift exists
    if (typeof shift.shiftId !== 'string' || !shift.shiftId) return err('NO_SHIFT');
    if (shift.ansattId !== ansattId) return err('NOT_OWN_SHIFT');
    if (shift.workDate !== workDate) return err('SHIFT_WORKDATE_MISMATCH');
    attendanceId = attendanceIdFor(shift.shiftId, ansattId);
    if (!attendanceId) return err('NO_SHIFT');
    shiftId = shift.shiftId;
    plannedSnapshot = { startAt: shift.plannedStartAt, endAt: shift.plannedEndAt };
    plannedShiftRevision = shift.revision;
  } else {                                        // CASE M2 — no shift that day at all
    attendanceId = manualAttendanceIdFor(workDate, ansattId);
    if (!attendanceId) return err('WORKDATE_INVALID');
    shiftId = null; plannedSnapshot = null; plannedShiftRevision = null;
  }
  const attendance = {
    attendanceId, shiftId, ansattId, createdByUid: actor.uid,
    workDate,
    plannedSnapshot, plannedShiftRevision,
    observedClockInAt: null, observedClockOutAt: null,   // NEVER fabricated: no receipt exists
    declaredStartAt, declaredEndAt,
    approvedStartAt: null, approvedEndAt: null, approvedByUid: null, approvedAt: null,
    status: 'attested',                                  // never 'clocked_out' — nobody clocked out
    employeeEditCount: 0, employeeEditDeadline: editDeadlineFor(now, workDate, policy),
    breakState: 'working', openBreakStartedAt: null,
    observedBreakMinutesTotal: 0, declaredBreakMinutesTotal,
    approvedBreakMinutesTotal: null, breakCount: 0,
    declarationSource: 'manager',                        // the authorization carrier (§1)
    revision: 1, createdAt: now, updatedAt: now,
  };
  const event = mkEvent('manager_manual_entry', attendance, actor, now, reasonCode, reasonNote, {
    declaredStartAt: { before: null, after: declaredStartAt },
    declaredEndAt: { before: null, after: declaredEndAt },
    declaredBreakMinutesTotal: { before: null, after: declaredBreakMinutesTotal },
    status: { before: null, after: 'attested' },
  });
  return ok({ attendance, event });
}

// ---- APPROVAL (admin only; sets approved* + approvedBy/At) -------------------
export function approve({ actor, existing, approvedStartAt, approvedEndAt, scope }, now, policy) {
  if (!existing) return err('NO_ATTENDANCE');
  if (!isFiniteInstant(now)) return err('NOW_NOT_FINITE');                           // P2-4
  const se = laterScopeError(actor, existing, ['admin'], false, scope);              // B7 admin role + P2-2 mandatory tenant scope
  if (se) return err(se);
  if (!isFiniteInstant(approvedStartAt) || !isFiniteInstant(approvedEndAt)) return err('APPROVED_TIMES_REQUIRED');
  if (approvedEndAt < approvedStartAt) return err('END_BEFORE_START');
  // sane bound around the planned snapshot (C37). 3B-FOUNDATION §7: the envelope is anchored to
  // the PLAN when a plan existed, and to the record's own workDate when plannedSnapshot is null
  // (a no-plan manual record). Approval always has an envelope; no synthetic plan is invented.
  if (existing.plannedSnapshot) {
    const lo = existing.plannedSnapshot.startAt - 24 * HOUR_MS;
    const hi = existing.plannedSnapshot.endAt + 24 * HOUR_MS;
    if (approvedStartAt < lo || approvedEndAt > hi) return err('APPROVED_OUT_OF_BOUND');
  } else if (!withinTenantWorkDay(approvedStartAt, existing.workDate, policy) || !withinTenantWorkDay(approvedEndAt, existing.workDate, policy)) {
    return err('APPROVED_OUT_OF_BOUND');
  }
  // 3B-FOUNDATION §8: TWO explicit chains keyed on STATUS — no bypass flag. 'attested' is
  // reachable only through admin-scoped management operations, so a clock-origin record can
  // never enter the attested chain; the separation is carried by the state machine, not by a
  // field an operation could set. The clocked_out chain below is semantically unchanged.
  if (existing.status === 'clocked_out') {
    // B6/P2-1: status alone is not trusted. The completion facts must be structurally present,
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
  } else if (existing.status === 'attested') {
    // The admission chain: admin scope (already applied), manager-asserted source, a complete
    // finite ordered declared pair inside the workDate, and an explicit break total.
    if (existing.declarationSource !== 'manager') return err('NOT_MANAGER_DECLARED');
    for (const f of ['declaredStartAt', 'declaredEndAt']) {
      if (!isFiniteInstant(existing[f])) return err('INCOMPLETE_ATTENDANCE:' + f);
      if (!withinTenantWorkDay(existing[f], existing.workDate, policy)) return err('DECLARED_OUTSIDE_WORKDATE');
    }
    if (existing.declaredEndAt < existing.declaredStartAt) return err('MALFORMED_DECLARED_INTERVAL');
    if (!Number.isInteger(existing.declaredBreakMinutesTotal) || existing.declaredBreakMinutesTotal < 0) return err('INCOMPLETE_ATTENDANCE:declaredBreakMinutesTotal');
  } else {
    return err('NOT_CLOCKED_OUT');   // every other status refuses exactly as before
  }
  // 3B-FOUNDATION §4: approve() is now the ONLY writer of approvedBreakMinutesTotal — it ENDORSES
  // the break that was actually deducted (declared supersedes observed, never added). This is a
  // record of what approval endorsed; it is never a derivation input.
  const endorsedBreak = Number.isInteger(existing.declaredBreakMinutesTotal) && existing.declaredBreakMinutesTotal >= 0
    ? existing.declaredBreakMinutesTotal
    : (typeof existing.observedBreakMinutesTotal === 'number' && existing.observedBreakMinutesTotal > 0 ? existing.observedBreakMinutesTotal : 0);
  const attendance = Object.assign({}, existing, {
    approvedStartAt, approvedEndAt, approvedByUid: actor.uid, approvedAt: now,
    approvedBreakMinutesTotal: endorsedBreak,
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

// ---- Source-aware day summary ("Dagen din", Slice003) ------------------------
// PURE derivation over the EXISTING attendance projection only. Governing:
// SOREN-SIRRHA-EMPLOYEE-DAY-TRUTH-FORGOTTEN-REGISTRATIONS-DESIGN-001 + Sirrha Slice003 freeze.
//  - start/end source = material-difference rule: declaredStartAt (resp. declaredEndAt) is the
//    effective value ONLY when it differs from observedClockInAt (resp. observedClockOutAt);
//    otherwise the observed instant is effective and no declaration provenance is claimed
//    (the projection defaults declared* to the observed instant, so equality is unprovable).
//  - break deduction = declaredBreakMinutesTotal when non-null, else observedBreakMinutesTotal;
//    the two are NEVER added. An open break suppresses any total.
//  - total only when effective start AND effective end exist and breakState !== 'on_break';
//    arithmetic on stored ABSOLUTE instants (works across midnight; no rollover logic here);
//    the FINAL net duration is floored to whole minutes, never rounded up.
//  - label: 'Oppgitt arbeidstid' if any material declared start/end or a declared break total,
//    else 'Registrert arbeidstid'. No approval/payroll/economic truth is read or produced.
//  - No event timestamps or completed break intervals are fabricated; updatedAt is NOT a receipt.
export function daySummaryFor({ attendance }) {
  if (!attendance || typeof attendance !== 'object') return null;
  const a = attendance;
  const obsIn = isFiniteInstant(a.observedClockInAt) ? a.observedClockInAt : null;
  const obsOut = isFiniteInstant(a.observedClockOutAt) ? a.observedClockOutAt : null;
  const decIn = isFiniteInstant(a.declaredStartAt) ? a.declaredStartAt : null;
  const decOut = isFiniteInstant(a.declaredEndAt) ? a.declaredEndAt : null;
  // 3B-FOUNDATION CASE 4 (the ONLY amendment to this selection): a complete declared pair with
  // NO observed receipt at all stands on its own IFF the record was stamped by an admin-scoped
  // management assertion (declarationSource === 'manager'). Employee declarations never stand
  // alone — the employee path cannot set this marker — so a forgotten registration still reads
  // as "no answer" until management acts. Cases 1-3 and the open-session case are untouched
  // below: a legacy record has no declarationSource, so `attested` is false and the original
  // expressions apply verbatim.
  const attested = a.declarationSource === 'manager' && obsIn == null && obsOut == null && decIn != null && decOut != null;
  const startDeclared = attested || (obsIn != null && decIn != null && decIn !== obsIn);
  const endDeclared = attested || (obsOut != null && decOut != null && decOut !== obsOut);
  const start = attested ? decIn : (obsIn == null ? null : (startDeclared ? decIn : obsIn));
  const end = attested ? decOut : (obsOut == null ? null : (endDeclared ? decOut : obsOut));
  const onBreak = a.breakState === 'on_break';
  const declaredBreak = (Number.isInteger(a.declaredBreakMinutesTotal) && a.declaredBreakMinutesTotal >= 0) ? a.declaredBreakMinutesTotal : null;
  const observedBreak = (typeof a.observedBreakMinutesTotal === 'number' && Number.isFinite(a.observedBreakMinutesTotal) && a.observedBreakMinutesTotal > 0) ? a.observedBreakMinutesTotal : 0;
  const breakCount = Number.isInteger(a.breakCount) && a.breakCount > 0 ? a.breakCount : 0;
  let breakRow;
  if (onBreak) breakRow = { kind: 'open', sinceAt: isFiniteInstant(a.openBreakStartedAt) ? a.openBreakStartedAt : null, observedMinutes: observedBreak, count: breakCount };
  else if (declaredBreak != null) breakRow = { kind: 'declared', minutes: declaredBreak, observedMinutes: observedBreak, count: breakCount };
  else if (observedBreak > 0 || breakCount > 0) breakRow = { kind: 'observed', minutes: observedBreak, count: breakCount };
  else breakRow = { kind: 'none', minutes: 0, count: 0 };
  const anyDeclared = startDeclared || endDeclared || declaredBreak != null;
  let total = null;
  if (start != null && end != null && !onBreak) {
    const deduction = declaredBreak != null ? declaredBreak : observedBreak;
    const net = Math.floor((end - start) / MINUTE_MS - deduction);          // final net floored, never rounded up
    // N1: an internally inconsistent day (deduction exceeds the gross span) yields NO total — fail closed,
    // never clamp to zero and never expose a substitute flag; Start/Pause/Slutt facts remain visible.
    if (net >= 0) total = { minutes: net, hours: Math.floor(net / 60), mins: net % 60, deductionMinutes: deduction, label: anyDeclared ? 'Oppgitt arbeidstid' : 'Registrert arbeidstid' };
  }
  return {
    start: { at: start, source: startDeclared ? 'declared' : 'observed', observedAt: obsIn },
    end: { at: end, source: endDeclared ? 'declared' : 'observed', observedAt: obsOut },
    breakRow, onBreak, anyDeclared, total,
  };
}

// ---- State-driven primary action (PRESENTATION-ONLY emphasis selector) -------
// Governing: SOREN-SIRRHA-STATE-DRIVEN-PRIMARY-CTA-DESIGN-REVIEW-001 +
// SIRRHA-SOREN-STATE-DRIVEN-PRIMARY-CTA-ACCEPTANCE-002.
// GREEN = the primary normal next action Sormena expects from the employee NOW.
// Green decides EMPHASIS ONLY, never availability: availability stays with the
// existing attendance transitions; this selector stores nothing, mutates nothing,
// creates no state/event/projection, and is willing to return null (no green).
// finishWindowMinutes is PRESENTATION policy — independent of varianceToleranceMinutes.
export const PRIMARY_ACTION_POLICY = Object.freeze({ finishWindowMinutes: 10 });

// Binding precedence (fail closed; absolute-instant comparisons, so overnight
// shifts need no wall-clock special case):
//   1. open break                                      -> 'avslutt_pause' (unconditional, incl. inside/after the finish window)
//   2. not clocked in + existing model permits clock-in -> 'stemple_inn'
//   3. clocked in, no open break, now within/after the finish window
//      (10 min before the CURRENT planned end, NOT plannedSnapshot)
//                                                       -> 'stemple_ut' (stays green at/after planned end while clocked in)
//   4. clocked in, before the window, break genuinely expected and not yet taken/declared
//                                                       -> 'start_pause'
//   5. any other / undetermined                         -> null (no green)
// clockInPermitted is the EXISTING availability verdict, computed by the caller
// from the existing rules; this selector never re-derives or widens availability.
export function primaryActionFor({ attendance, shift, clockInPermitted, now, policy }) {
  if (!isFiniteInstant(now)) return null;
  if (!policy || typeof policy !== 'object') return null;
  if (attendance == null) return clockInPermitted === true ? 'stemple_inn' : null;
  if (typeof attendance !== 'object') return null;
  if (attendance.status !== 'clocked_in') return null;               // clocked_out / unknown / malformed -> no green
  if (attendance.breakState === 'on_break') return 'avslutt_pause';  // precedence 1
  if (attendance.breakState !== 'working') return null;              // fail-closed on unknown break state
  const plannedEndAt = (shift && typeof shift === 'object' && isFiniteInstant(shift.plannedEndAt)) ? shift.plannedEndAt : null;
  if (plannedEndAt == null) return null;                             // window undeterminable -> no green
  if (now >= plannedEndAt - PRIMARY_ACTION_POLICY.finishWindowMinutes * MINUTE_MS) return 'stemple_ut'; // precedence 3
  if (policy.breakMode === 'none') return null;                      // no break expected under this mode
  const expected = policy.expectedBreakMinutes;
  if (typeof expected !== 'number' || !Number.isFinite(expected) || expected <= 0) return null;
  const breakAddressed =
    (Number.isInteger(attendance.breakCount) && attendance.breakCount > 0) ||
    (typeof attendance.observedBreakMinutesTotal === 'number' && attendance.observedBreakMinutesTotal > 0) ||
    attendance.declaredBreakMinutesTotal != null;                    // an explicit declaration (incl. 0) settles the break
  return breakAddressed ? null : 'start_pause';                      // precedence 4 / 5
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
  // 3B-FOUNDATION §7: plannedSnapshot === null is a VALUE with meaning ("no planned source
  // existed"), not malformation. The invariant's meaning is preserved and extended: whatever the
  // planned provenance was at birth — including "none" — is immutable. null==null passes;
  // null->value, value->null and unequal non-null snapshots all still refuse.
  const a = existing.plannedSnapshot, b = proposed.plannedSnapshot;
  if (a === null || b === null) {
    if (a !== b) return err('OWNERSHIP_IMMUTABLE:plannedSnapshot');
  } else if (!a || !b || a.startAt !== b.startAt || a.endAt !== b.endAt) {
    return err('OWNERSHIP_IMMUTABLE:plannedSnapshot');
  }
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
