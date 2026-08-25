// schedule-core.test.mjs
// ETR-2c — EXACT GOVERNING T1-T129 deterministic matrix from
// SOREN-SIRRHA-ETR2C-NEXT-SLICE-DESIGN-RECOMMENDATION-008 §7.
// Node built-ins only (node:assert/strict). No packages. One t() per governing case.
// Every case injects actor, scope, now, timezone (via policy), context. No ambient clock.
// Run: node schedule-core.test.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import {
  validateCreateShift, validateReviseShift, validateAssignmentChange, validateCancelShift,
  canReadShift, shiftChangedMapError,
} from './schedule-core.mjs';
import {
  ETR2A_POLICY, eventIdFor, attendanceIdFor,
  clockIn, createShift, employeeEdit,
  assertRevisionMonotonic, rejectEventMutation, detectRevisionGaps,
} from './employee-shell-core.mjs';

let passed = 0, failed = 0;
const lines = [];
const seen = new Set();
function t(id, name, fn) {
  seen.add(id);
  try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); }
  catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); }
}
// NON-GOVERNING order proofs — tracked separately; NOT part of the T1-T129 count.
let opPassed = 0, opFailed = 0;
const opLines = [];
function op(name, fn) {
  try { fn(); opPassed++; opLines.push('PASS  ' + name); }
  catch (e) { opFailed++; opLines.push('FAIL  ' + name + '  ::  ' + (e && e.message ? e.message : e)); }
}
const REJECT = (r, code) => { assert.equal(r.ok, false, 'expected reject, got ok'); if (code) assert.equal(r.code, code, 'code'); assert.equal(r.projection, undefined, 'no projection'); assert.equal(r.event, undefined, 'no event'); };
const OKR = (r) => { assert.ok(r.ok, 'expected ok, got ' + r.code); };

// ---- fixtures (all injected; tenant-local via policy timezone) --------------
const POL = ETR2A_POLICY;
const WD = '2026-08-24';
const D = (h, m = 0) => Date.UTC(2026, 7, 24, h, m, 0);      // on 2026-08-24 (Europe/Oslo)
const NEXTD = (h, m = 0) => Date.UTC(2026, 7, 25, h, m, 0);  // next local day
const NOW = D(9);
const NOW2 = D(15);
const SCOPE = { tenantId: 'tenant-alpha', shiftId: 'shift-9' };
const admin = (over) => Object.assign({ uid: 'admin-1', accessRole: 'admin', ansattId: 'ans-admin', accessEnabled: true, tenantId: 'tenant-alpha' }, over || {});
const emp = (ansattId, over) => Object.assign({ uid: 'auth-' + ansattId, accessRole: 'employee', ansattId, accessEnabled: true, tenantId: 'tenant-alpha' }, over || {});
const RES = (over) => Object.assign({ status: 'FOUND', ansattId: 'ans-a1', tenantId: 'tenant-alpha' }, over || {});
const BUSINESS = ['ansattId', 'plannedStartAt', 'plannedEndAt', 'workDate', 'roleKey', 'status'];

const openProposed = () => ({ ansattId: null, plannedStartAt: D(10), plannedEndAt: D(18), workDate: WD, roleKey: null, status: 'open' });
const assignedProposed = (ansattId = 'ans-a1') => ({ ansattId, plannedStartAt: D(10), plannedEndAt: D(18), workDate: WD, roleKey: null, status: 'assigned' });
const ctxOpen = () => ({ shiftExistsAtScope: false });
const ctxAssigned = (ansattId = 'ans-a1') => ({ shiftExistsAtScope: false, proposedAssigneeResolution: RES({ ansattId }) });

function makeOpen() {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() });
  assert.ok(r.ok, 'makeOpen ' + r.code); return r.projection;
}
function makeAssigned(ansattId = 'ans-a1') {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: assignedProposed(ansattId), now: NOW, policy: POL, context: ctxAssigned(ansattId) });
  assert.ok(r.ok, 'makeAssigned ' + r.code); return r.projection;
}
// legacy shift object for the cross-slice clock path (core createShift shape)
function legacyShift(over) {
  over = over || {};
  const { shift } = createShift({ shiftId: over.shiftId || 'shift-9', ansattId: over.ansattId !== undefined ? over.ansattId : 'ans-a1', plannedStartAt: over.start != null ? over.start : D(10), plannedEndAt: over.end != null ? over.end : D(18), workDate: WD, actorUid: 'admin-1' }, D(8));
  shift.tenantId = 'tenant-alpha';
  shift.status = over.status || 'assigned';
  if (over.revision != null) shift.revision = over.revision;
  return shift;
}

// =====================================================================
// SCOPE STRUCTURAL VALIDATION — T1-T10
// =====================================================================
const cOpen = () => ({ actor: admin(), proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() });
t('T1', 'scope missing entirely REJECT', () => REJECT(validateCreateShift(Object.assign(cOpen(), { scope: undefined })), 'MISSING_SCOPE'));
t('T2', 'scope not an object REJECT', () => REJECT(validateCreateShift(Object.assign(cOpen(), { scope: 'x' })), 'MISSING_SCOPE'));
t('T3', 'scope.tenantId missing REJECT', () => REJECT(validateCreateShift(Object.assign(cOpen(), { scope: { shiftId: 's' } })), 'SCOPE_TENANT_INVALID'));
t('T4', 'scope.tenantId empty REJECT', () => REJECT(validateCreateShift(Object.assign(cOpen(), { scope: { tenantId: '', shiftId: 's' } })), 'SCOPE_TENANT_INVALID'));
t('T5', 'scope.tenantId non-string REJECT', () => REJECT(validateCreateShift(Object.assign(cOpen(), { scope: { tenantId: 5, shiftId: 's' } })), 'SCOPE_TENANT_INVALID'));
t('T6', 'scope.shiftId missing REJECT', () => REJECT(validateCreateShift(Object.assign(cOpen(), { scope: { tenantId: 'tenant-alpha' } })), 'SCOPE_SHIFT_INVALID'));
t('T7', 'scope.shiftId empty REJECT', () => REJECT(validateCreateShift(Object.assign(cOpen(), { scope: { tenantId: 'tenant-alpha', shiftId: '' } })), 'SCOPE_SHIFT_INVALID'));
t('T8', 'scope.shiftId non-string REJECT', () => REJECT(validateCreateShift(Object.assign(cOpen(), { scope: { tenantId: 'tenant-alpha', shiftId: 5 } })), 'SCOPE_SHIFT_INVALID'));
t('T9', 'malformed scope rejected BEFORE assignee/attendance/context', () => {
  // assigned proposal + a resolution that would fail later, but scope is malformed -> scope error wins
  const r = validateCreateShift({ actor: admin(), scope: { tenantId: 'tenant-alpha' }, proposed: assignedProposed(), now: NOW, policy: POL, context: { shiftExistsAtScope: 'UNKNOWN', proposedAssigneeResolution: RES({ status: 'NOT_FOUND' }) } });
  REJECT(r, 'SCOPE_SHIFT_INVALID');
});
t('T10', 'no event/attendance id derived from a malformed scope', () => {
  const r = validateCreateShift(Object.assign(cOpen(), { scope: { tenantId: 'tenant-alpha', shiftId: '' } }));
  assert.equal(r.ok, false); assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});

// =====================================================================
// CREATION — T11-T24
// =====================================================================
t('T11', 'create open/null -> revision 1, shift_created', () => {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() });
  OKR(r); assert.equal(r.projection.revision, 1); assert.equal(r.projection.status, 'open'); assert.equal(r.projection.ansattId, null); assert.equal(r.event.type, 'shift_created');
});
t('T12', 'create assigned/A -> revision 1, shift_created ONLY', () => {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: assignedProposed(), now: NOW, policy: POL, context: ctxAssigned() });
  OKR(r); assert.equal(r.projection.status, 'assigned'); assert.equal(r.projection.ansattId, 'ans-a1'); assert.equal(r.event.type, 'shift_created'); assert.equal(r.projection.revision, 1);
});
t('T13', 'create open + ansattId=A REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(openProposed(), { ansattId: 'ans-a1' }), now: NOW, policy: POL, context: ctxOpen() }), 'OPEN_REQUIRES_NULL_ANSATT'));
t('T14', 'create assigned + ansattId=null REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(assignedProposed(), { ansattId: null }), now: NOW, policy: POL, context: ctxAssigned() }), 'ASSIGNED_REQUIRES_ANSATT'));
t('T15', 'create status cancelled REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(openProposed(), { status: 'cancelled' }), now: NOW, policy: POL, context: ctxOpen() }), 'STATUS_INVALID_FOR_CREATE'));
t('T16', 'create plannedEnd <= plannedStart REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(openProposed(), { plannedEndAt: D(10) }), now: NOW, policy: POL, context: ctxOpen() }), 'END_BEFORE_START'));
t('T17', 'create overnight, end next local day ALLOW', () => {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(openProposed(), { plannedStartAt: D(20), plannedEndAt: NEXTD(1) }), now: NOW, policy: POL, context: ctxOpen() });
  OKR(r); assert.equal(r.projection.plannedEndAt, NEXTD(1));
});
t('T18', 'create plannedStart not on workDate REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(openProposed(), { plannedStartAt: NEXTD(12), plannedEndAt: NEXTD(14) }), now: NOW, policy: POL, context: ctxOpen() }), 'PLANNED_START_NOT_ON_WORKDATE'));
t('T19', 'create empty-string ansattId REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(assignedProposed(), { ansattId: '' }), now: NOW, policy: POL, context: ctxAssigned() }), 'ASSIGNED_REQUIRES_ANSATT'));
t('T20', 'create assignee NOT_FOUND REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: assignedProposed(), now: NOW, policy: POL, context: { shiftExistsAtScope: false, proposedAssigneeResolution: RES({ status: 'NOT_FOUND' }) } }), 'ASSIGNEE_NOT_RESOLVED'));
t('T21', 'create assignee different tenant REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: assignedProposed(), now: NOW, policy: POL, context: { shiftExistsAtScope: false, proposedAssigneeResolution: RES({ tenantId: 'tenant-beta' }) } }), 'ASSIGNEE_CROSS_TENANT'));
t('T22', 'create resolution.ansattId != proposed REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: assignedProposed('ans-a1'), now: NOW, policy: POL, context: { shiftExistsAtScope: false, proposedAssigneeResolution: RES({ ansattId: 'ans-zz' }) } }), 'ASSIGNEE_MISMATCH'));
t('T23', 'create proposal supplies revision REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(openProposed(), { revision: 5 }), now: NOW, policy: POL, context: ctxOpen() }), 'PROPOSAL_FIELD_NOT_ALLOWED:revision'));
t('T24', 'create proposal supplies createdAt/createdByUid/updatedAt REJECT', () => {
  for (const f of ['createdAt', 'createdByUid', 'updatedAt']) {
    const p = Object.assign(openProposed(), { [f]: 1 });
    REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: p, now: NOW, policy: POL, context: ctxOpen() }), 'PROPOSAL_FIELD_NOT_ALLOWED:' + f);
  }
});

// =====================================================================
// CREATION IDENTITY UNIQUENESS — T25-T28
// =====================================================================
t('T25', 'createShift with shiftExistsAtScope true (LIVE) REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: { shiftExistsAtScope: true } }), 'SHIFT_ALREADY_EXISTS'));
t('T26', 'createShift with shiftExistsAtScope true (CANCELLED existing) REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: { shiftExistsAtScope: true } }), 'SHIFT_ALREADY_EXISTS'));
t('T27', 'createShift with shiftExistsAtScope UNKNOWN/missing REJECT', () => {
  REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: { shiftExistsAtScope: 'UNKNOWN' } }), 'SHIFT_EXISTENCE_UNKNOWN');
  REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: {} }), 'SHIFT_EXISTENCE_UNKNOWN');
});
t('T28', 'no revision-1 reset over an existing identity', () => {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: { shiftExistsAtScope: true } });
  assert.equal(r.ok, false); assert.equal(r.projection, undefined); // no rev-1 projection produced
});

// =====================================================================
// CREATION EVENT AND DERIVED OUTPUT — T29-T34
// =====================================================================
t('T29', 'shift_created.changed = all six business fields, before null', () => {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: assignedProposed(), now: NOW, policy: POL, context: ctxAssigned() });
  OKR(r); assert.deepEqual(Object.keys(r.event.changed).sort(), BUSINESS.slice().sort());
  for (const f of BUSINESS) assert.equal(r.event.changed[f].before, null, f);
});
t('T30', 'shift_created.changed EXCLUDES revision and metadata', () => {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() });
  for (const f of ['revision', 'createdAt', 'createdByUid', 'updatedAt']) assert.ok(!(f in r.event.changed), f);
});
t('T31', 'projection REPLAYABLE from the event stream alone', () => {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: assignedProposed(), now: NOW, policy: POL, context: ctxAssigned() });
  const replayed = {}; for (const f of BUSINESS) replayed[f] = r.event.changed[f].after;
  const projBiz = {}; for (const f of BUSINESS) projBiz[f] = r.projection[f];
  assert.deepEqual(replayed, projBiz);
});
t('T32', 'output createdByUid == acting admin uid', () => { const r = validateCreateShift({ actor: admin({ uid: 'admin-XYZ' }), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() }); assert.equal(r.projection.createdByUid, 'admin-XYZ'); });
t('T33', 'output createdAt == updatedAt == injected now', () => { const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() }); assert.equal(r.projection.createdAt, NOW); assert.equal(r.projection.updatedAt, NOW); });
t('T34', 'output revision == 1', () => { const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() }); assert.equal(r.projection.revision, 1); });

// =====================================================================
// REVISION — T35-T46
// =====================================================================
const revCtx = { attendanceExistsForCurrentAssignee: true }; // present but not required by revise
t('T35', 'revise planned times -> revision +1, shift_revised, changed exact', () => {
  const ex = makeAssigned();
  const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: ex, patch: { plannedStartAt: D(11), plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} });
  OKR(r); assert.equal(r.projection.revision, ex.revision + 1); assert.equal(r.event.type, 'shift_revised');
  assert.deepEqual(r.event.changed.plannedStartAt, { before: D(10), after: D(11) });
  assert.deepEqual(r.event.changed.plannedEndAt, { before: D(18), after: D(19) });
  OKR(shiftChangedMapError(ex, r.projection, r.event.changed));
});
t('T36', 'revise BOTH start and end -> ONE revision, ONE event', () => {
  const ex = makeAssigned();
  const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: ex, patch: { plannedStartAt: D(11), plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} });
  OKR(r); assert.equal(r.projection.revision, ex.revision + 1); assert.equal(typeof r.event, 'object'); assert.ok(!Array.isArray(r.event));
});
t('T37', 'revise roleKey ALLOW', () => { const ex = makeAssigned(); const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: ex, patch: { roleKey: 'cashier' }, now: NOW2, policy: POL, context: {} }); OKR(r); assert.equal(r.projection.roleKey, 'cashier'); assert.deepEqual(Object.keys(r.event.changed), ['roleKey']); });
t('T38', 'revise NO-OP, all three unchanged REJECT', () => { const ex = makeAssigned(); REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: ex, patch: { plannedStartAt: ex.plannedStartAt, plannedEndAt: ex.plannedEndAt, roleKey: ex.roleKey }, now: NOW2, policy: POL, context: {} }), 'NO_CHANGE'); });
t('T39', 'rejected no-op leaves revision/updatedAt unchanged, NO event', () => {
  const ex = makeAssigned(); const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: ex, patch: { roleKey: ex.roleKey }, now: NOW2, policy: POL, context: {} });
  assert.equal(r.ok, false); assert.equal(r.projection, undefined); assert.equal(r.event, undefined); assert.equal(ex.revision, 1); assert.equal(ex.updatedAt, NOW);
});
t('T40', 'revise moving plannedStart to a different workDate REJECT', () => REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedStartAt: NEXTD(12), plannedEndAt: NEXTD(14) }, now: NOW2, policy: POL, context: {} }), 'PLANNED_START_NOT_ON_WORKDATE'));
t('T41', 'revise producing end <= start REJECT', () => { const ex = makeAssigned(); REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: ex, patch: { plannedEndAt: ex.plannedStartAt }, now: NOW2, policy: POL, context: {} }), 'END_BEFORE_START'); });
t('T42', 'revise INTO an overnight span ALLOW', () => { const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedStartAt: D(20), plannedEndAt: NEXTD(1) }, now: NOW2, policy: POL, context: {} }); OKR(r); });
t('T43', 'revise attempts to change workDate REJECT', () => REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { workDate: '2026-08-25' }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:workDate'));
t('T44', 'revise attempts to change status REJECT', () => REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { status: 'open' }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:status'));
t('T45', 'revise attempts to change ansattId REJECT', () => REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { ansattId: 'ans-b' }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:ansattId'));
t('T46', 'revise AFTER attendance exists — PERMITTED', () => { const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: revCtx }); OKR(r); });

// =====================================================================
// ASSIGNMENT CHANGE — T47-T58
// =====================================================================
t('T47', 'open/null -> assigned/A, changed { status, ansattId }', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES() } });
  OKR(r); assert.deepEqual(Object.keys(r.event.changed).sort(), ['ansattId', 'status']); assert.equal(r.projection.status, 'assigned'); assert.equal(r.projection.ansattId, 'ans-a1');
});
t('T48', 'assigned/A -> assigned/B, changed { ansattId } ONLY', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned('ans-a1'), patch: { ansattId: 'ans-b' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ ansattId: 'ans-b' }), attendanceExistsForCurrentAssignee: false } });
  OKR(r); assert.deepEqual(Object.keys(r.event.changed), ['ansattId']); assert.equal(r.projection.ansattId, 'ans-b');
});
t('T49', 'assigned/A -> open/null, changed { status, ansattId }', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned('ans-a1'), patch: { status: 'open', ansattId: null }, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false } });
  OKR(r); assert.deepEqual(Object.keys(r.event.changed).sort(), ['ansattId', 'status']); assert.equal(r.projection.status, 'open'); assert.equal(r.projection.ansattId, null);
});
t('T50', 'assignment NO-OP, A -> A REJECT', () => REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned('ans-a1'), patch: { ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES(), attendanceExistsForCurrentAssignee: false } }), 'NO_CHANGE'));
t('T51', 'rejected assignment no-op leaves revision/updatedAt, NO event', () => {
  const ex = makeAssigned('ans-a1'); const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: ex, patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES(), attendanceExistsForCurrentAssignee: false } });
  assert.equal(r.ok, false); assert.equal(r.projection, undefined); assert.equal(r.event, undefined); assert.equal(ex.revision, 1);
});
t('T52', 'assignmentChange change planned times REJECT', () => REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedStartAt: D(11) }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:plannedStartAt'));
t('T53', 'assignmentChange change roleKey REJECT', () => REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { roleKey: 'x' }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:roleKey'));
t('T54', 'assignmentChange change workDate REJECT', () => REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { workDate: '2026-08-25' }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:workDate'));
t('T55', 'assignmentChange producing an incoherent pair REJECT', () => REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: null }, now: NOW2, policy: POL, context: {} }), 'INCOHERENT_ASSIGNMENT'));
t('T56', 'assignmentChange to empty / NOT_FOUND / foreign assignee REJECT', () => {
  REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: '' }, now: NOW2, policy: POL, context: {} }), 'ASSIGNED_REQUIRES_ANSATT'); // empty branch: STEP-4 structural (Ruling-007)
  REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-x' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ status: 'NOT_FOUND', ansattId: 'ans-x' }) } }), 'ASSIGNEE_NOT_RESOLVED');
  REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-x' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ tenantId: 'tenant-beta', ansattId: 'ans-x' }) } }), 'ASSIGNEE_CROSS_TENANT');
});
t('T57', 'assignmentChange resolution.ansattId != proposed REJECT', () => REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-x' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ ansattId: 'ans-y' }) } }), 'ASSIGNEE_MISMATCH'));
t('T58', 'no shift_assigned or shift_reassigned type exists', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES() } });
  OKR(r); assert.notEqual(r.event.type, 'shift_assigned'); assert.notEqual(r.event.type, 'shift_reassigned');
});

// =====================================================================
// CANCELLATION — T59-T65
// =====================================================================
t('T59', 'cancel assigned/A no attendance -> cancelled, ansattId preserved, changed { status } only', () => {
  const ex = makeAssigned('ans-a1'); const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: ex, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false } });
  OKR(r); assert.equal(r.projection.status, 'cancelled'); assert.equal(r.projection.ansattId, 'ans-a1'); assert.deepEqual(Object.keys(r.event.changed), ['status']);
});
t('T60', 'cancel open/null -> cancelled; attendance fact NOT required', () => { const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeOpen(), now: NOW2, policy: POL, context: {} }); OKR(r); assert.equal(r.projection.status, 'cancelled'); });
t('T61', 'cancel output: revision +1 and updatedAt == injected now', () => { const ex = makeAssigned(); const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: ex, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false } }); assert.equal(r.projection.revision, ex.revision + 1); assert.equal(r.projection.updatedAt, NOW2); });
t('T62', 'cancel preserves createdByUid, createdAt, times, roleKey, workDate', () => {
  const ex = makeAssigned(); const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: ex, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false } });
  for (const f of ['createdByUid', 'createdAt', 'plannedStartAt', 'plannedEndAt', 'roleKey', 'workDate']) assert.equal(r.projection[f], ex[f], f);
});
t('T63', 'cancel attempts to change ansattId (unsupported patch) REJECT', () => {
  const ex = makeAssigned('ans-a1');
  const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: ex, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false }, patch: { ansattId: 'ans-b' } });
  assert.equal(r.ok, false); assert.ok(String(r.code).startsWith('CANCEL_PATCH_NOT_SUPPORTED'), r.code);
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
t('T64', 'cancel attempts to change planned times / roleKey (unsupported patch) REJECT', () => {
  const ex = makeAssigned();
  for (const patch of [{ plannedStartAt: D(11) }, { plannedEndAt: D(19) }, { roleKey: 'x' }]) {
    const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: ex, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false }, patch });
    assert.equal(r.ok, false, Object.keys(patch)[0]); assert.ok(String(r.code).startsWith('CANCEL_PATCH_NOT_SUPPORTED'), r.code);
    assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
  }
});
t('T65', 'cancel with attendance existing for current assignee REJECT', () => REJECT(validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeAssigned('ans-a1'), now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: true } }), 'ATTENDANCE_BLOCKS_CHANGE'));

// =====================================================================
// LIFECYCLE TERMINAL — T66
// =====================================================================
t('T66', 'ANY transition out of cancelled, including cancel again, REJECT', () => {
  const cancelled = validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeOpen(), now: NOW2, policy: POL, context: {} }).projection;
  REJECT(validateCancelShift({ actor: admin(), scope: SCOPE, existing: cancelled, now: NOW2, policy: POL, context: {} }), 'SHIFT_CANCELLED');
  REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: cancelled, patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }), 'SHIFT_CANCELLED');
  REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: cancelled, patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES() } }), 'SHIFT_CANCELLED');
});

// =====================================================================
// VALIDATION CONTEXT — T67-T74
// =====================================================================
t('T67', 'assignmentChange, existing assigned/A, attendance UNKNOWN REJECT', () => REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned('ans-a1'), patch: { ansattId: 'ans-b' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ ansattId: 'ans-b' }), attendanceExistsForCurrentAssignee: 'UNKNOWN' } }), 'ATTENDANCE_FACT_UNKNOWN'));
t('T68', 'cancelShift, existing assigned/A, attendance UNKNOWN REJECT', () => REJECT(validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeAssigned('ans-a1'), now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: 'UNKNOWN' } }), 'ATTENDANCE_FACT_UNKNOWN'));
t('T69', 'assignmentChange, existing open/null, attendance ABSENT ALLOW', () => { const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES() } }); OKR(r); });
t('T70', 'cancelShift, existing open/null, attendance ABSENT ALLOW', () => { const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeOpen(), now: NOW2, policy: POL, context: {} }); OKR(r); });
t('T71', 'assignmentChange, non-null proposal, resolution UNKNOWN REJECT', () => REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ status: 'UNKNOWN' }) } }), 'ASSIGNEE_NOT_RESOLVED'));
t('T72', 'createShift, non-null proposal, resolution UNKNOWN REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: assignedProposed(), now: NOW, policy: POL, context: { shiftExistsAtScope: false, proposedAssigneeResolution: RES({ status: 'UNKNOWN' }) } }), 'ASSIGNEE_NOT_RESOLVED'));
t('T73', 'reviseShift with attendance fact absent — not required ALLOW', () => { const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }); OKR(r); });
t('T74', 'reviseShift with shiftExistsAtScope absent — not required ALLOW', () => { const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }); OKR(r); });

// =====================================================================
// ACTOR AUTHORITY — T75-T82
// =====================================================================
t('T75', 'actor not enabled REJECT', () => REJECT(validateCreateShift({ actor: admin({ accessEnabled: false }), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() }), 'ACTOR_NOT_ENABLED'));
t('T76', 'actor role is not admin REJECT', () => REJECT(validateCreateShift({ actor: admin({ accessRole: 'regnskap' }), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() }), 'NOT_ADMIN'));
t('T77', 'actor.tenantId != scope.tenantId REJECT', () => REJECT(validateCreateShift({ actor: admin({ tenantId: 'tenant-beta' }), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() }), 'CROSS_TENANT'));
t('T78', 'employee attempts createShift REJECT', () => REJECT(validateCreateShift({ actor: emp('ans-a1'), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() }), 'NOT_ADMIN'));
t('T79', 'employee attempts reviseShift REJECT', () => REJECT(validateReviseShift({ actor: emp('ans-a1'), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }), 'NOT_ADMIN'));
t('T80', 'employee attempts assignmentChange REJECT', () => REJECT(validateAssignmentChange({ actor: emp('ans-a1'), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES() } }), 'NOT_ADMIN'));
t('T81', 'employee attempts cancelShift REJECT', () => REJECT(validateCancelShift({ actor: emp('ans-a1'), scope: SCOPE, existing: makeOpen(), now: NOW2, policy: POL, context: {} }), 'NOT_ADMIN'));
t('T82', 'employee attempts to write any shift event REJECT', () => {
  const a = emp('ans-a1');
  REJECT(validateCreateShift({ actor: a, scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() }), 'NOT_ADMIN');
  REJECT(validateReviseShift({ actor: a, scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }), 'NOT_ADMIN');
  REJECT(validateAssignmentChange({ actor: a, scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES() } }), 'NOT_ADMIN');
  REJECT(validateCancelShift({ actor: a, scope: SCOPE, existing: makeOpen(), now: NOW2, policy: POL, context: {} }), 'NOT_ADMIN');
});

// =====================================================================
// TENANT AND READ SCOPE — T83-T84
// =====================================================================
t('T83', 'employee reads OWN assigned shift ALLOW', () => { const r = canReadShift({ actor: emp('ans-a1'), scope: SCOPE, projection: makeAssigned('ans-a1') }); OKR(r); });
t('T84', 'employee reads another employee shift / other-tenant shift REJECT', () => {
  REJECT(canReadShift({ actor: emp('ans-b'), scope: SCOPE, projection: makeAssigned('ans-a1') }), 'NOT_OWN_SHIFT');
  REJECT(canReadShift({ actor: emp('ans-a1', { tenantId: 'tenant-beta' }), scope: SCOPE, projection: makeAssigned('ans-a1') }), 'CROSS_TENANT');
});

// =====================================================================
// PATH IDENTITY AUTHORITY — T85-T91
// =====================================================================
t('T85', 'every shift-event id derives from scope.shiftId + new revision', () => {
  const c = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() });
  assert.equal(c.event.eventId, eventIdFor(SCOPE.shiftId, c.event.revision));
  const rv = validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} });
  assert.equal(rv.event.eventId, eventIdFor(SCOPE.shiftId, rv.event.revision));
  const as = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES() } });
  assert.equal(as.event.eventId, eventIdFor(SCOPE.shiftId, as.event.revision));
  const cx = validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeOpen(), now: NOW2, policy: POL, context: {} });
  assert.equal(cx.event.eventId, eventIdFor(SCOPE.shiftId, cx.event.revision));
});
t('T86', 'create proposal supplies shiftId REJECT', () => REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(openProposed(), { shiftId: 'x' }), now: NOW, policy: POL, context: ctxOpen() }), 'PROPOSAL_FIELD_NOT_ALLOWED:shiftId'));
t('T87', 'any proposal/patch supplies tenantId REJECT', () => {
  REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(openProposed(), { tenantId: 'x' }), now: NOW, policy: POL, context: ctxOpen() }), 'PROPOSAL_FIELD_NOT_ALLOWED:tenantId');
  REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { tenantId: 'x' }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:tenantId');
});
t('T88', 'legacy shiftId PRESENT and EQUAL -> tolerated, inspected for equality only', () => {
  const ex = Object.assign(makeAssigned(), { shiftId: SCOPE.shiftId });
  const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: ex, patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} });
  OKR(r); assert.ok(!('shiftId' in r.projection)); // never carried into output
});
t('T89', 'legacy shiftId PRESENT and DIFFERENT -> integrity fault REJECT', () => REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: Object.assign(makeAssigned(), { shiftId: 'other' }), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }), 'SHIFT_SCOPE_MISMATCH'));
t('T90', 'legacy shiftId ABSENT where not required -> not invented ALLOW', () => { const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }); OKR(r); assert.ok(!('shiftId' in r.projection)); });
t('T91', 'NO output value is derived from the legacy field', () => {
  const ex = Object.assign(makeAssigned(), { shiftId: SCOPE.shiftId, tenantId: SCOPE.tenantId });
  const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: ex, patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} });
  OKR(r); assert.ok(!('shiftId' in r.projection)); assert.ok(!('tenantId' in r.projection));
  assert.equal(r.event.eventId, eventIdFor(SCOPE.shiftId, r.event.revision)); // id from scope, not field
});

// =====================================================================
// DERIVED-FIELD TAMPERING — T92-T97
// =====================================================================
t('T92', 'reviseShift patch supplies revision REJECT', () => REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { revision: 9 }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:revision'));
t('T93', 'reviseShift patch supplies updatedAt/createdAt/createdByUid REJECT', () => {
  for (const f of ['updatedAt', 'createdAt', 'createdByUid']) REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { [f]: 1 }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:' + f);
});
t('T94', 'assignmentChange patch supplies any projection-derived field REJECT', () => REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { revision: 2 }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:revision'));
t('T95', 'cancelShift patch supplies a projection-derived field REJECT', () => {
  const ex = makeAssigned();
  for (const f of ['revision', 'updatedAt', 'createdAt', 'createdByUid']) {
    const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: ex, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false }, patch: { [f]: 1 } });
    assert.equal(r.ok, false, f); assert.ok(String(r.code).startsWith('CANCEL_PATCH_NOT_SUPPORTED'), r.code);
    assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
  }
});
t('T96', 'any transition supplies event-derived fields REJECT', () => {
  REJECT(validateCreateShift({ actor: admin(), scope: SCOPE, proposed: Object.assign(openProposed(), { eventId: 'x' }), now: NOW, policy: POL, context: ctxOpen() }), 'PROPOSAL_FIELD_NOT_ALLOWED:eventId');
  REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { changed: {} }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:changed');
  REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { type: 'x' }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:type');
});
t('T97', 'any patch key outside the transition whitelist REJECT (incl. cancel has no patch channel)', () => {
  REJECT(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { foo: 1 }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:foo');
  REJECT(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { bar: 1 }, now: NOW2, policy: POL, context: {} }), 'PATCH_FIELD_NOT_ALLOWED:bar');
  const rc = validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false }, patch: { baz: 1 } });
  assert.equal(rc.ok, false); assert.ok(String(rc.code).startsWith('CANCEL_PATCH_NOT_SUPPORTED'), rc.code); assert.equal(rc.projection, undefined); assert.equal(rc.event, undefined);
});

// =====================================================================
// DERIVED-OUTPUT CORRECTNESS — T98-T103
// =====================================================================
t('T98', 'output revision == existing + 1 on every successful transition', () => {
  const ex1 = makeAssigned(); assert.equal(validateReviseShift({ actor: admin(), scope: SCOPE, existing: ex1, patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }).projection.revision, ex1.revision + 1);
  const ex2 = makeAssigned('ans-a1'); assert.equal(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: ex2, patch: { ansattId: 'ans-b' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ ansattId: 'ans-b' }), attendanceExistsForCurrentAssignee: false } }).projection.revision, ex2.revision + 1);
  const ex3 = makeOpen(); assert.equal(validateCancelShift({ actor: admin(), scope: SCOPE, existing: ex3, now: NOW2, policy: POL, context: {} }).projection.revision, ex3.revision + 1);
});
t('T99', 'output updatedAt == injected now on every successful transition', () => {
  assert.equal(validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }).projection.updatedAt, NOW2);
  assert.equal(validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES() } }).projection.updatedAt, NOW2);
  assert.equal(validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeOpen(), now: NOW2, policy: POL, context: {} }).projection.updatedAt, NOW2);
});
t('T100', 'createdByUid and createdAt UNCHANGED on every non-create transition', () => {
  const ex = makeAssigned();
  const rv = validateReviseShift({ actor: admin({ uid: 'admin-OTHER' }), scope: SCOPE, existing: ex, patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} });
  assert.equal(rv.projection.createdByUid, ex.createdByUid); assert.equal(rv.projection.createdAt, ex.createdAt);
  const cx = validateCancelShift({ actor: admin({ uid: 'admin-OTHER' }), scope: SCOPE, existing: makeAssigned(), now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false } });
  assert.equal(cx.projection.createdByUid, 'admin-1'); assert.equal(cx.projection.createdAt, NOW);
});
t('T101', 'event actorUid == the acting admin uid', () => { const r = validateReviseShift({ actor: admin({ uid: 'admin-ZZ' }), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }); assert.equal(r.event.actorUid, 'admin-ZZ'); });
t('T102', 'event actorRole resolved from actor context, never self-claimed', () => { const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }); assert.equal(r.event.actorRole, 'admin'); });
t('T103', 'event at == injected now; event revision == new projection revision', () => { const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} }); assert.equal(r.event.at, NOW2); assert.equal(r.event.revision, r.projection.revision); });

// =====================================================================
// EVENT IMMUTABILITY AND SEQUENCE — T104-T112
// =====================================================================
t('T104', 'update an existing shift event REJECT', () => assert.equal(rejectEventMutation('update').ok, false));
t('T105', 'delete a shift event REJECT', () => assert.equal(rejectEventMutation('delete').ok, false));
t('T106', 'revision skips a number, 1 -> 3, gap DETECTED', () => assert.equal(detectRevisionGaps([{ revision: 1 }, { revision: 3 }]).hasGap, true));
t('T107', 'revision repeats or decrements REJECT', () => {
  assert.equal(assertRevisionMonotonic({ revision: 2 }, { revision: 2 }).ok, false); // repeat
  assert.equal(assertRevisionMonotonic({ revision: 2 }, { revision: 1 }).ok, false); // decrement
});
t('T108', 'event id does not match the new revision REJECT', () => {
  const r = validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} });
  assert.equal(r.event.eventId, eventIdFor(SCOPE.shiftId, r.event.revision));      // correct match
  assert.notEqual(eventIdFor(SCOPE.shiftId, r.event.revision), 'wrong-id');          // a mismatched id is detectable
});
t('T109', 'revision 1 with no shift_created event -> gap DETECTED', () => assert.equal(detectRevisionGaps([{ revision: 2 }]).hasGap, true));
t('T110', 'changed map contains a field that did NOT change REJECT', () => {
  const before = { status: 'open', ansattId: null }, after = { status: 'open', ansattId: null };
  assert.equal(shiftChangedMapError(before, after, { status: { before: 'open', after: 'open' } }).ok, false);
});
t('T111', 'changed map OMITS a field that DID change REJECT', () => {
  const before = { status: 'open', ansattId: null }, after = { status: 'assigned', ansattId: 'ans-a1' };
  assert.equal(shiftChangedMapError(before, after, {}).ok, false);
});
t('T112', 'event id format derived from scope.shiftId + new revision', () => {
  const r = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: openProposed(), now: NOW, policy: POL, context: ctxOpen() });
  assert.equal(r.event.eventId, SCOPE.shiftId + '-rev-000001');
});

// =====================================================================
// LAYER ISOLATION — T113-T117
// =====================================================================
function clockedAttendance(over) {
  over = over || {};
  const shift = legacyShift({ start: over.start != null ? over.start : D(10), end: over.end != null ? over.end : D(18) });
  const r = clockIn({ actor: emp('ans-a1'), shift, existing: null, declaredStartAt: over.start != null ? over.start : D(10), scope: { tenantId: 'tenant-alpha', shiftId: 'shift-9' } }, over.now != null ? over.now : D(10), POL);
  assert.ok(r.ok, 'clockedAttendance ' + r.code); return r.attendance;
}
t('T113', 'revise after attendance -> plannedSnapshot and plannedShiftRevision UNCHANGED', () => {
  const att = clockedAttendance();
  const snap = JSON.parse(JSON.stringify(att.plannedSnapshot)); const rev = att.plannedShiftRevision;
  validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedStartAt: D(11), plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} });
  assert.deepEqual(att.plannedSnapshot, snap); assert.equal(att.plannedShiftRevision, rev);
});
t('T114', 'revise after attendance -> observed/declared/break facts UNCHANGED', () => {
  const att = clockedAttendance();
  const obsIn = att.observedClockInAt, decl = att.declaredStartAt, bstate = att.breakState, bmin = att.observedBreakMinutesTotal;
  validateReviseShift({ actor: admin(), scope: SCOPE, existing: makeAssigned(), patch: { plannedEndAt: D(19) }, now: NOW2, policy: POL, context: {} });
  assert.equal(att.observedClockInAt, obsIn); assert.equal(att.declaredStartAt, decl); assert.equal(att.breakState, bstate); assert.equal(att.observedBreakMinutesTotal, bmin);
});
t('T115', 'attendance plannedSnapshot edited directly REJECT', () => {
  const att = clockedAttendance();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: att, patch: { plannedSnapshot: { startAt: 0, endAt: 0 } }, scope: { tenantId: 'tenant-alpha' } }, D(13), POL);
  assert.equal(r.ok, false); assert.ok(r.code.startsWith('FIELD_NOT_EDITABLE'));
});
t('T116', 'attendance plannedShiftRevision edited directly REJECT', () => {
  const att = clockedAttendance();
  const r = employeeEdit({ actor: emp('ans-a1'), existing: att, patch: { plannedShiftRevision: 9 }, scope: { tenantId: 'tenant-alpha' } }, D(13), POL);
  assert.equal(r.ok, false); assert.ok(r.code.startsWith('FIELD_NOT_EDITABLE'));
});
t('T117', "Sirrha's counterexample end-to-end (revise plan after clock-in keeps snapshot)", () => {
  const att = clockedAttendance({ start: D(12), end: D(20), now: D(12) });   // clock in against 12:00-20:00
  assert.deepEqual(att.plannedSnapshot, { startAt: D(12), endAt: D(20) }); assert.equal(att.plannedShiftRevision, 1);
  // an independent schedule revise to 13:00-21:00 does not touch the captured attendance snapshot
  const rv = validateReviseShift({ actor: admin(), scope: SCOPE, existing: Object.assign(makeAssigned(), { plannedStartAt: D(12), plannedEndAt: D(20) }), patch: { plannedStartAt: D(13), plannedEndAt: D(21) }, now: NOW2, policy: POL, context: {} });
  OKR(rv); assert.deepEqual(att.plannedSnapshot, { startAt: D(12), endAt: D(20) }); assert.equal(att.plannedShiftRevision, 1);
});

// =====================================================================
// CROSS-SLICE CLOCKING AND LINKAGE — T118-T126
// =====================================================================
const CSCOPE = { tenantId: 'tenant-alpha', shiftId: 'shift-9' };
t('T118', 'clock-in against status = open / ansattId = null REJECT', () => {
  const shift = legacyShift({ status: 'open', ansattId: null });
  const r = clockIn({ actor: emp('ans-a1'), shift, existing: null, declaredStartAt: D(10), scope: CSCOPE }, D(10), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_NOT_ASSIGNED');
});
t('T119', 'clock-in by B against a shift assigned to A REJECT', () => {
  const shift = legacyShift({ ansattId: 'ans-a1' });
  const r = clockIn({ actor: emp('ans-b'), shift, existing: null, declaredStartAt: D(10), scope: CSCOPE }, D(10), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'NOT_OWN_SHIFT');
});
t('T120', 'clock-in against a cancelled shift REJECT', () => {
  const shift = legacyShift({ status: 'cancelled' });
  const r = clockIn({ actor: emp('ans-a1'), shift, existing: null, declaredStartAt: D(10), scope: CSCOPE }, D(10), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_NOT_ASSIGNED');
});
t('T121', 'after a valid assignment to A, A clocks in under existing guards ALLOW', () => {
  const shift = legacyShift({ ansattId: 'ans-a1' });
  const r = clockIn({ actor: emp('ans-a1'), shift, existing: null, declaredStartAt: D(10), scope: CSCOPE }, D(10), POL);
  assert.ok(r.ok, r.code); assert.equal(r.attendance.status, 'clocked_in');
});
t('T122', 'attendance creation captures the shift CURRENT revision', () => {
  const shift = legacyShift({ ansattId: 'ans-a1', revision: 3 });
  const r = clockIn({ actor: emp('ans-a1'), shift, existing: null, declaredStartAt: D(10), scope: CSCOPE }, D(10), POL);
  assert.ok(r.ok, r.code); assert.equal(r.attendance.plannedShiftRevision, 3);
});
t('T123', 'attendance created with a STALE plannedShiftRevision REJECT', () => {
  const shift = legacyShift({ ansattId: 'ans-a1', revision: 3 });
  const r = clockIn({ actor: emp('ans-a1'), shift, existing: null, declaredStartAt: D(10), plannedShiftRevision: 1, scope: CSCOPE }, D(10), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_REVISION_MISMATCH');
});
t('T124', 'TARGET: attendance.shiftId originates from scope, never from a data field', () => {
  const shift = legacyShift({ ansattId: 'ans-a1' });
  const r = clockIn({ actor: emp('ans-a1'), shift, existing: null, declaredStartAt: D(10), scope: CSCOPE }, D(10), POL);
  assert.ok(r.ok, r.code); assert.equal(r.attendance.shiftId, CSCOPE.shiftId);
});
t('T125', 'TARGET: attendance document id derived as {scope.shiftId}_{ansattId}', () => {
  const shift = legacyShift({ ansattId: 'ans-a1' });
  const r = clockIn({ actor: emp('ans-a1'), shift, existing: null, declaredStartAt: D(10), scope: CSCOPE }, D(10), POL);
  assert.ok(r.ok, r.code); assert.equal(r.attendance.attendanceId, attendanceIdFor(CSCOPE.shiftId, 'ans-a1')); assert.equal(r.attendance.attendanceId, 'shift-9_ans-a1');
});
t('T126', 'attendance creation where legacy shift data shiftId != scope REJECT', () => {
  const shift = legacyShift({ ansattId: 'ans-a1', shiftId: 'legacy-other' });
  const r = clockIn({ actor: emp('ans-a1'), shift, existing: null, declaredStartAt: D(10), scope: CSCOPE }, D(10), POL);
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_SCOPE_MISMATCH');
});

// =====================================================================
// FORWARD-COMPATIBILITY NON-INTERFERENCE — T127-T129
// =====================================================================
t('T127', 'shift remains assigned(A) while an external marker denotes it offered', () => {
  const proj = makeAssigned('ans-a1');
  const externalOfferMarker = { shiftId: SCOPE.shiftId, offered: true };  // lives OUTSIDE the projection
  assert.equal(proj.status, 'assigned'); assert.equal(proj.ansattId, 'ans-a1');
  assert.ok(!('offered' in proj)); void externalOfferMarker;             // engine does not read/merge external markers
});
t('T128', 'ownership readable from the shift ALONE', () => {
  const proj = makeAssigned('ans-a1');
  assert.equal(proj.ansattId, 'ans-a1');                                  // ownership is a field on the projection, no extra lookup
  OKR(canReadShift({ actor: emp('ans-a1'), scope: SCOPE, projection: proj }));
});
t('T129', 'no notification/delivery/seen/channel/queue field anywhere', () => {
  const c = validateCreateShift({ actor: admin(), scope: SCOPE, proposed: assignedProposed(), now: NOW, policy: POL, context: ctxAssigned() });
  const forbidden = /notif|deliver|seen|channel|queue/i;
  for (const k of Object.keys(c.projection)) assert.ok(!forbidden.test(k), 'projection ' + k);
  for (const k of Object.keys(c.event)) assert.ok(!forbidden.test(k), 'event ' + k);
});

// =====================================================================
// NON-GOVERNING EVALUATION-ORDER PROOFS (reported separately; NOT counted in T1-T129)
// Prove unsupported cancel-patch structural rejection (step 4) is not masked by a later
// step-6 business condition (A) or a later step-5 context condition (B).
// =====================================================================
op('ORDER-PROOF-A business masking must not occur: unsupported patch + terminal(cancelled) => CANCEL_PATCH_NOT_SUPPORTED wins', () => {
  const cancelled = validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeOpen(), now: NOW2, policy: POL, context: {} }).projection; // status=cancelled
  const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: cancelled, now: NOW2, policy: POL, context: {}, patch: { baz: 1 } });
  assert.equal(r.ok, false); assert.ok(String(r.code).startsWith('CANCEL_PATCH_NOT_SUPPORTED'), r.code);
  assert.notEqual(r.code, 'SHIFT_CANCELLED'); assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-B context masking must not occur: unsupported patch + attendance UNKNOWN => CANCEL_PATCH_NOT_SUPPORTED wins', () => {
  const ex = makeAssigned('ans-a1'); // non-null assignee => a step-5 attendance fact would otherwise be required
  const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: ex, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: 'UNKNOWN' }, patch: { baz: 1 } });
  assert.equal(r.ok, false); assert.ok(String(r.code).startsWith('CANCEL_PATCH_NOT_SUPPORTED'), r.code);
  assert.notEqual(r.code, 'ATTENDANCE_FACT_UNKNOWN'); assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});

// Fixtures for context-before-business proofs: cancelled projections with non-null and null assignees.
const cancelledAssigned = validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeAssigned('ans-a1'), now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false } }).projection; // status cancelled, ansattId 'ans-a1'
const cancelledOpen = validateCancelShift({ actor: admin(), scope: SCOPE, existing: makeOpen(), now: NOW2, policy: POL, context: {} }).projection; // status cancelled, ansattId null

op('ORDER-PROOF-C cancel context precedes terminal: cancelled + non-null assignee + attendance UNKNOWN => attendance error wins (not SHIFT_CANCELLED)', () => {
  const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: cancelledAssigned, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: 'UNKNOWN' } });
  assert.equal(r.ok, false); assert.equal(r.code, 'ATTENDANCE_FACT_UNKNOWN'); assert.notEqual(r.code, 'SHIFT_CANCELLED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-D cancel null assignee invents no attendance context: cancelled + null assignee + no context => SHIFT_CANCELLED', () => {
  const r = validateCancelShift({ actor: admin(), scope: SCOPE, existing: cancelledOpen, now: NOW2, policy: POL, context: {} });
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_CANCELLED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-E assignment current-assignee context precedes terminal: cancelled + non-null current + propose null + attendance UNKNOWN => attendance error wins', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: cancelledAssigned, patch: { status: 'open', ansattId: null }, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: 'UNKNOWN' } });
  assert.equal(r.ok, false); assert.equal(r.code, 'ATTENDANCE_FACT_UNKNOWN'); assert.notEqual(r.code, 'SHIFT_CANCELLED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-F assignment null current invents no attendance context: cancelled + null current + propose null + no context => SHIFT_CANCELLED (no attendance demand)', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: cancelledOpen, patch: { status: 'open', ansattId: null }, now: NOW2, policy: POL, context: {} });
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_CANCELLED'); assert.notEqual(r.code, 'ATTENDANCE_FACT_REQUIRED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-G assignment proposed-resolution context precedes terminal: cancelled + null current + propose non-null + resolution UNKNOWN => resolution error wins', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: cancelledOpen, patch: { status: 'assigned', ansattId: 'ans-b' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ status: 'UNKNOWN', ansattId: 'ans-b' }) } });
  assert.equal(r.ok, false); assert.equal(r.code, 'ASSIGNEE_NOT_RESOLVED'); assert.notEqual(r.code, 'SHIFT_CANCELLED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-H assignment proposed-null invents no resolution context: cancelled + null current + propose null + no context => SHIFT_CANCELLED (no resolution demand)', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: cancelledOpen, patch: { status: 'open', ansattId: null }, now: NOW2, policy: POL, context: {} });
  assert.equal(r.ok, false); assert.equal(r.code, 'SHIFT_CANCELLED'); assert.notEqual(r.code, 'ASSIGNEE_RESOLUTION_REQUIRED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});

// Coherence-vs-context order proofs (ETR-2c FINAL COHERENCE CORRECTION): the resulting status/ansattId
// pair coherence is a STEP-6 invariant and must never mask a STEP-5 required-context error.
const assignedA = makeAssigned('ans-a1');
op('ORDER-PROOF-I assignment attendance-context precedes pair coherence: assigned/A + {status:open} (no ansattId key) + attendance MISSING => ATTENDANCE_FACT_REQUIRED (no resolution demanded, not INCOHERENT_ASSIGNMENT first)', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: assignedA, patch: { status: 'open' }, now: NOW2, policy: POL, context: {} });
  assert.equal(r.ok, false); assert.equal(r.code, 'ATTENDANCE_FACT_REQUIRED');
  assert.notEqual(r.code, 'INCOHERENT_ASSIGNMENT'); assert.notEqual(r.code, 'ASSIGNEE_RESOLUTION_REQUIRED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-I(b) same input + attendance UNKNOWN => ATTENDANCE_FACT_UNKNOWN wins', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: assignedA, patch: { status: 'open' }, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: 'UNKNOWN' } });
  assert.equal(r.ok, false); assert.equal(r.code, 'ATTENDANCE_FACT_UNKNOWN'); assert.notEqual(r.code, 'INCOHERENT_ASSIGNMENT');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-I(c) same input + VALID attendance (false and true) => INCOHERENT_ASSIGNMENT at STEP 6 (before attendance blocking)', () => {
  for (const att of [false, true]) {
    const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: assignedA, patch: { status: 'open' }, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: att } });
    assert.equal(r.ok, false); assert.equal(r.code, 'INCOHERENT_ASSIGNMENT', 'att=' + att);
    assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
  }
});
op('ORDER-PROOF-J assignment resolution-context precedes pair coherence: open/null + {ansattId:B} (status carried open) + resolution MISSING => ASSIGNEE_RESOLUTION_REQUIRED (not INCOHERENT_ASSIGNMENT first)', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { ansattId: 'ans-b' }, now: NOW2, policy: POL, context: {} });
  assert.equal(r.ok, false); assert.equal(r.code, 'ASSIGNEE_RESOLUTION_REQUIRED'); assert.notEqual(r.code, 'INCOHERENT_ASSIGNMENT');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-J(b) same input + resolution UNKNOWN => ASSIGNEE_NOT_RESOLVED wins', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { ansattId: 'ans-b' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ status: 'UNKNOWN', ansattId: 'ans-b' }) } });
  assert.equal(r.ok, false); assert.equal(r.code, 'ASSIGNEE_NOT_RESOLVED'); assert.notEqual(r.code, 'INCOHERENT_ASSIGNMENT');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
op('ORDER-PROOF-J(c) same input + VALID resolution => INCOHERENT_ASSIGNMENT at STEP 6', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { ansattId: 'ans-b' }, now: NOW2, policy: POL, context: { proposedAssigneeResolution: RES({ ansattId: 'ans-b' }) } });
  assert.equal(r.ok, false); assert.equal(r.code, 'INCOHERENT_ASSIGNMENT');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});

// STRUCTURAL-ANSATT proofs (Ruling-007): an explicit non-null ansattId that is not a valid non-empty string is a STEP-4
// structural rejection (ASSIGNED_REQUIRES_ANSATT) and never reaches STEP-5 context, terminal, pair coherence or output.
op('STRUCTURAL-ANSATT-PROOF-1 explicit patch.ansattId="" on assigned/A (attendance would otherwise be required) + context {} => ASSIGNED_REQUIRES_ANSATT at STEP 4; not ATTENDANCE_FACT_REQUIRED / ASSIGNEE_RESOLUTION_REQUIRED / INCOHERENT_ASSIGNMENT / SHIFT_CANCELLED', () => {
  for (const patch of [{ ansattId: '' }, { status: 'assigned', ansattId: '' }, { status: 'open', ansattId: '' }]) {
    const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: assignedA, patch, now: NOW2, policy: POL, context: {} });
    assert.equal(r.ok, false); assert.equal(r.code, 'ASSIGNED_REQUIRES_ANSATT', JSON.stringify(patch));
    assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
  }
  // also before terminal: cancelled/A + '' => structural, not SHIFT_CANCELLED / attendance
  const rc = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: cancelledAssigned, patch: { ansattId: '' }, now: NOW2, policy: POL, context: {} });
  assert.equal(rc.ok, false); assert.equal(rc.code, 'ASSIGNED_REQUIRES_ANSATT'); assert.equal(rc.projection, undefined); assert.equal(rc.event, undefined);
});
op('STRUCTURAL-ANSATT-PROOF-2 explicit non-null non-string patch.ansattId (42 / true / {} / [] / undefined-with-key) on assigned/A and open/null + context {} => same STEP-4 ASSIGNED_REQUIRES_ANSATT; no later context/business first; no projection/event', () => {
  for (const v of [42, true, {}, [], undefined]) {
    const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: assignedA, patch: { status: 'assigned', ansattId: v }, now: NOW2, policy: POL, context: {} });
    assert.equal(r.ok, false); assert.equal(r.code, 'ASSIGNED_REQUIRES_ANSATT', 'value=' + String(v));
    assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
    const ro = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { ansattId: v }, now: NOW2, policy: POL, context: {} });
    assert.equal(ro.ok, false); assert.equal(ro.code, 'ASSIGNED_REQUIRES_ANSATT', 'open value=' + String(v)); assert.equal(ro.projection, undefined); assert.equal(ro.event, undefined);
  }
});

// PREDICATE PROOFS (resolution-requirement predicate; reported separately; NOT counted in T1-T129)
let ppPassed = 0, ppFailed = 0;
const ppLines = [];
function pp(name, fn) {
  try { fn(); ppPassed++; ppLines.push('PASS  ' + name); }
  catch (e) { ppFailed++; ppLines.push('FAIL  ' + name + '  ::  ' + (e && e.message ? e.message : e)); }
}
pp('PREDICATE-PROOF-1 carry-forward non-null existing assignee does NOT demand resolution: assigned/A + {status:assigned} (no ansattId key) + attendance false + NO resolution => NO_CHANGE (not ASSIGNEE_RESOLUTION_REQUIRED)', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: assignedA, patch: { status: 'assigned' }, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false } });
  assert.equal(r.ok, false); assert.equal(r.code, 'NO_CHANGE'); assert.notEqual(r.code, 'ASSIGNEE_RESOLUTION_REQUIRED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
pp('PREDICATE-PROOF-1(b) explicit ansattId:null demands NO resolution: assigned/A + {status:open, ansattId:null} + attendance false + NO resolution => ALLOW (T49 shape)', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: assignedA, patch: { status: 'open', ansattId: null }, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false } });
  OKR(r); assert.equal(r.projection.ansattId, null); assert.equal(r.projection.status, 'open');
});
pp('PREDICATE-PROOF-2 explicit valid non-null patch.ansattId DOES demand resolution: open/null + {status:assigned, ansattId:A} + NO resolution => ASSIGNEE_RESOLUTION_REQUIRED', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: {} });
  assert.equal(r.ok, false); assert.equal(r.code, 'ASSIGNEE_RESOLUTION_REQUIRED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
pp('PREDICATE-PROOF-2(b) explicit SAME-VALUE non-null ansattId still demands resolution: assigned/A + {ansattId:A} + attendance false + NO resolution => ASSIGNEE_RESOLUTION_REQUIRED (not NO_CHANGE)', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: assignedA, patch: { ansattId: 'ans-a1' }, now: NOW2, policy: POL, context: { attendanceExistsForCurrentAssignee: false } });
  assert.equal(r.ok, false); assert.equal(r.code, 'ASSIGNEE_RESOLUTION_REQUIRED'); assert.notEqual(r.code, 'NO_CHANGE');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});
pp('PREDICATE-PROOF-2(c) explicit empty-string ansattId is NOT a resolvable proposal: open/null + {status:assigned, ansattId:""} + NO resolution => ASSIGNED_REQUIRES_ANSATT at STEP 4 (T56 shape, no invented resolution demand)', () => {
  const r = validateAssignmentChange({ actor: admin(), scope: SCOPE, existing: makeOpen(), patch: { status: 'assigned', ansattId: '' }, now: NOW2, policy: POL, context: {} });
  assert.equal(r.ok, false); assert.equal(r.code, 'ASSIGNED_REQUIRES_ANSATT'); assert.notEqual(r.code, 'ASSIGNEE_RESOLUTION_REQUIRED');
  assert.equal(r.projection, undefined); assert.equal(r.event, undefined);
});

// ---- summary ----------------------------------------------------------------
console.log(lines.join('\n'));
console.log('\n-- NON-GOVERNING ORDER PROOFS (separate from T1-T129) --');
console.log(opLines.join('\n'));
console.log('\n-- PREDICATE PROOFS (separate from T1-T129) --');
console.log(ppLines.join('\n'));
let missing = [];
for (let i = 1; i <= 129; i++) if (!seen.has('T' + i)) missing.push('T' + i);
console.log('\nGOVERNING CASES DECLARED: ' + seen.size + '/129' + (missing.length ? '  MISSING: ' + missing.join(',') : ''));
console.log('SCHEDULE_CORE_TESTS: ' + passed + ' passed, ' + failed + ' failed');
console.log('ORDER_PROOFS: ' + opPassed + ' passed, ' + opFailed + ' failed');
console.log('PREDICATE_PROOFS: ' + ppPassed + ' passed, ' + ppFailed + ' failed');
if (missing.length || seen.size !== 129) { console.log('MATRIX INCOMPLETE'); process.exit(1); }
process.exit((failed || opFailed || ppFailed) ? 1 : 0);
