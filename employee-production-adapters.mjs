// employee-production-adapters.mjs
// PRODUCTION DATA ADAPTERS for the employee surface (S4 foundation). ZERO Firebase imports and ZERO
// initialization: every datastore capability is INJECTED by the single production host (index.html
// after S2b-2/S3) as `fs` (see FS_CAPABILITY). No network is opened by this module itself.
//
// Truth model (Freeze 003 / S4 REV3):
//   tenants/{T}/shifts/{shiftId}            layer A — planned schedule (frozen ten fields + server stamps)
//   tenants/{T}/attendance/{attendanceId}   layer B — attendance (accepted employee-shell-core record)
//   tenants/{T}/employeeSelf/{ansattId}     least-privilege Min ansettelse projection (admin-written)
//   …/events/{eventId}                       create-only truthful audit events (core event objects, JSON-normalised)
// `vakter` (layer C, payable) is NEVER addressed: s4Path() refuses every path outside the three S4
// collections, so a legacy write cannot even be constructed here.
//
// Every business decision is made by the ACCEPTED cores (employee-shell-core operations; schedule-core
// validators; management-schedule-core applyScheduleOperation). This module only (1) mirrors server
// snapshots into the shapes the shell already consumes, (2) persists {projection + event} exactly as the
// core produced them, with REV3 revision / server-timestamp discipline, and (3) never applies optimistic
// local state: mirrors change only when the server confirms through a snapshot.

import { applyScheduleOperation } from './management-schedule-core.mjs';
import { validateAssignmentChange } from './schedule-core.mjs';
import { attendanceIdFor, eventIdFor } from './employee-shell-core.mjs';
import { projectEmployeeSelf, employeeSelfToShellEmployee, validateEmployeeSelfDoc } from './employee-self-projection.mjs';

export const S4_COLLECTIONS = Object.freeze(['shifts', 'attendance', 'employeeSelf']);
export const FS_CAPABILITY = Object.freeze(['doc', 'listen', 'runTransaction', 'batch', 'serverTimestamp']);
export const ADAPTER_ERROR = Object.freeze({
  PERMISSION_DENIED: 'PERMISSION_DENIED', UNAVAILABLE: 'UNAVAILABLE', STALE_REVISION: 'STALE_REVISION',
  NO_ATTENDANCE: 'NO_ATTENDANCE', NO_SHIFT: 'NO_SHIFT', DISPOSED: 'DISPOSED', NOT_CURRENT: 'NOT_CURRENT',
  PRODUCTION_WRITE_VIA_COMMIT: 'PRODUCTION_WRITE_VIA_COMMIT', PATH_FORBIDDEN: 'PATH_FORBIDDEN',
  CORE_REFUSED: 'CORE_REFUSED', CAPABILITY_MISSING: 'CAPABILITY_MISSING', PROJECTION_INVALID: 'PROJECTION_INVALID',
});
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export function adapterError(code, detail) {
  const e = new Error(detail ? code + ':' + detail : code);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}
/** Map a datastore error to the small adapter vocabulary. Unknown codes pass through. */
export function mapFsError(e) {
  const raw = String((e && (e.code || e.name || e.message)) || 'unknown');
  if (/permission-denied|PERMISSION_DENIED/i.test(raw)) return ADAPTER_ERROR.PERMISSION_DENIED;
  if (/unavailable|deadline-exceeded|network|failed-precondition|aborted/i.test(raw)) return ADAPTER_ERROR.UNAVAILABLE;
  return raw;
}
/** The ONLY path builder. Refuses anything outside the three S4 collections (and their events). */
export function s4Path(tenantId, col, id, sub, subId) {
  if (typeof tenantId !== 'string' || !ID_RE.test(tenantId)) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, 'tenant');
  if (!S4_COLLECTIONS.includes(col)) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, String(col));
  let p = 'tenants/' + tenantId + '/' + col;
  if (id !== undefined) { if (typeof id !== 'string' || !ID_RE.test(id)) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, 'id'); p += '/' + id; }
  if (sub !== undefined) {
    if (id === undefined || sub !== 'events') throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, String(sub));
    p += '/events';
    if (subId !== undefined) { if (typeof subId !== 'string' || !ID_RE.test(subId)) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, 'eventId'); p += '/' + subId; }
  }
  return p;
}
/** Core event objects may carry `undefined` (e.g. changed.note.before); Firestore rejects it. Normal removal only. */
export function normalizeEvent(ev) { return JSON.parse(JSON.stringify(ev)); }
export function stripServerFields(d) { const c = Object.assign({}, d); delete c.serverCreatedAt; delete c.serverUpdatedAt; return c; }
export function validateFsCapability(fs) {
  const missing = [];
  if (!fs || typeof fs !== 'object') return { ok: false, missing: [...FS_CAPABILITY] };
  for (const k of FS_CAPABILITY) if (typeof fs[k] !== 'function') missing.push(k);
  return { ok: missing.length === 0, missing };
}

// ---- shared admin writer (employee factory + management Vaktplan factory) -------------------------------------
// The management-schedule-core boundary decides; this only persists projection + truthful event inside ONE transaction.
// Body is the accepted employee-factory adminWrite, unchanged; every free variable is bound through `ctx`.
function makeAdminWriter(ctx) {
  const { fs, T, nowMs, policy, deps, adminActor, assertLive, rejectMapped, st, evRef } = ctx;
  return async function adminWrite(kind, shiftId, buildOp) {
    assertLive();
    return fs.runTransaction(async (tx) => {
      const now = nowMs();
      let id = shiftId, existing = null;
      if (kind === 'create') {
        // collision-safe id law (newShiftIdFor): first free of base, base-2, base-3 … proven by tx reads
        const base = 'mg-' + buildOp.workDate + '-' + (buildOp.ansattId != null ? buildOp.ansattId : 'manko');
        id = base; let n = 1;
        for (;;) { const s = await tx.get(fs.doc(s4Path(T, 'shifts', id))); if (!s.exists) break; n += 1; id = base + '-' + n; if (n > 50) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'ID_SPACE'); }
      } else {
        const s = await tx.get(fs.doc(s4Path(T, 'shifts', id)));
        if (!s.exists) throw adapterError(ADAPTER_ERROR.NO_SHIFT);
        existing = stripServerFields(s.data);
      }
      let attExists = false;
      if (existing && existing.ansattId !== null) {
        const a = await tx.get(fs.doc(s4Path(T, 'attendance', attendanceIdFor(id, existing.ansattId))));
        attExists = !!(a && a.exists);
      }
      const store = { [T]: existing ? { [id]: existing } : {} };
      const resolveAssignee = typeof deps.resolveAssignee === 'function' ? deps.resolveAssignee : (a) => (typeof a === 'string' && a ? { status: 'FOUND', tenantId: T, ansattId: a } : { status: 'NOT_FOUND' });
      let res;
      if (kind === 'assign') {
        const patch = buildOp.ansattId == null ? { status: 'open', ansattId: null } : { status: 'assigned', ansattId: buildOp.ansattId };
        const v = validateAssignmentChange({
          actor: adminActor(), scope: { tenantId: T, shiftId: id }, existing, patch, now, policy,
          context: { proposedAssigneeResolution: patch.ansattId ? resolveAssignee(patch.ansattId) : undefined, attendanceExistsForCurrentAssignee: existing.ansattId !== null ? attExists : undefined },
        });
        res = v.ok ? { ok: true, shiftId: id, projection: v.projection, event: v.event } : v;
      } else {
        res = applyScheduleOperation({
          store, tenantId: T, actor: adminActor(), op: Object.assign({ kind }, buildOp, kind === 'create' ? {} : { shiftId: id }), now, policy,
          deps: { resolveAssignee, attendanceExistsFor: () => attExists },
        });
        // applyScheduleOperation mints its own id from the in-memory store; production uses the tx-proven id above
        if (res.ok && kind === 'create') res = Object.assign({}, res, { shiftId: id });
      }
      if (!res.ok) throw adapterError(res.code);
      const p = res.projection;
      const ev = normalizeEvent(res.event);
      if (ev.eventId !== eventIdFor(id, p.revision)) ev.eventId = eventIdFor(id, p.revision);   // id law bound to the persisted document id
      const ref = fs.doc(s4Path(T, 'shifts', id));
      if (kind === 'create') tx.set(ref, Object.assign({}, p, { serverCreatedAt: st(), serverUpdatedAt: st() }));
      else tx.update(ref, Object.assign({}, p, { serverUpdatedAt: st() }));
      tx.set(evRef('shifts', id, ev), ev);
      return { ok: true, shiftId: id, projection: p, event: ev };
    }).catch(rejectMapped);
  };

}

// ---- shared attendance committer (employee factory + Ledelse management adapters) -------------------------------
// Body is the accepted employee-factory commit(res, opts), unchanged; free variables bound through `ctx`.
export function makeAttendanceCommitter(ctx) {
  const { fs, T, st, evRef, assertLive, rejectMapped } = ctx;
  return function commit(res, opts) {
    const op = opts || {};
    if (!res || res.ok !== true || !res.attendance || !res.event) return Promise.reject(adapterError(ADAPTER_ERROR.CORE_REFUSED, res && res.code));
    try { assertLive(); } catch (e) { return Promise.reject(e); }
    const rec = res.attendance;
    let ref;
    try { ref = fs.doc(s4Path(T, 'attendance', rec.attendanceId)); } catch (e) { return Promise.reject(e); }
    if (op.create === true || rec.revision === 1) {
      const b = fs.batch();
      b.set(ref, Object.assign({}, rec, { serverCreatedAt: st(), serverUpdatedAt: st() }));
      b.set(evRef('attendance', rec.attendanceId, res.event), normalizeEvent(res.event));
      return b.commit().then(() => ({ ok: true, retried: false, attendance: rec, event: res.event })).catch(rejectMapped);
    }
    return fs.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap || !snap.exists) throw adapterError(ADAPTER_ERROR.NO_ATTENDANCE);
      const current = stripServerFields(snap.data);
      let use = res, retried = false;
      if (current.revision !== rec.revision - 1) {
        // stale: the record moved since the UI ran the core. ONE re-run against the server record, then fail visibly.
        if (typeof op.rerun !== 'function') throw adapterError(ADAPTER_ERROR.STALE_REVISION, String(current.revision));
        const r2 = op.rerun(current);
        retried = true;
        if (!r2 || r2.ok !== true || !r2.attendance || !r2.event) throw adapterError(ADAPTER_ERROR.STALE_REVISION, r2 && r2.code ? r2.code : String(current.revision));
        if (r2.attendance.revision !== current.revision + 1) throw adapterError(ADAPTER_ERROR.STALE_REVISION, 'rerun');
        use = r2;
      }
      tx.update(ref, Object.assign({}, use.attendance, { serverUpdatedAt: st() }));
      tx.set(evRef('attendance', use.attendance.attendanceId, use.event), normalizeEvent(use.event));
      return { ok: true, retried, attendance: use.attendance, event: use.event };
    }).catch(rejectMapped);
  };

}
// ---- shared employeeSelf writer (admin-only projection; derived from the canonical record only) -----------------
// FAIL-CLOSED LAW (initial-registration closeout): nothing is projected to employeeSelf for an employee whose real
// employment baseline has not been registered. Two independent checks, both at this writer (the only employeeSelf
// persistence path), never only in a caller or the UI:
//   (1) the supplied record carries the old-register marker (legacy.hasE360 === false) -> refused before any read;
//   (2) the RAW canonical ansatte document is read INSIDE the write transaction: no stored employment block (or no period
//       in it) -> refused; and the projected start date must be the stored one, so a stale / hand-built record cannot
//       project the period that is only derived from the old register (its creation date) even after someone else has
//       registered the employment.
// A refusal writes nothing anywhere. Refusal: CORE_REFUSED:INITIAL_REGISTRATION_REQUIRED (+ coreResult), the same stable
// code the employee and contract operations use; a start-date mismatch is PROJECTION_INVALID:sourceMismatch.
function baselineRequiredError() {
  const err = adapterError(ADAPTER_ERROR.CORE_REFUSED, 'INITIAL_REGISTRATION_REQUIRED');
  err.coreResult = { ok: false, code: 'INITIAL_REGISTRATION_REQUIRED' };
  return err;
}
export function makeEmployeeSelfWriter(ctx) {
  const { fs, T, st, assertLive, rejectMapped } = ctx;
  return function writeEmployeeSelf(ansattId, employee, opt) {
    try { assertLive(); } catch (e) { return Promise.reject(e); }
    if (employee && employee.legacy && employee.legacy.hasE360 === false) return Promise.reject(baselineRequiredError());
    if (employee && typeof employee.ansattId === 'string' && employee.ansattId !== ansattId) return Promise.reject(adapterError(ADAPTER_ERROR.PROJECTION_INVALID, 'ansattId'));
    const p = projectEmployeeSelf(employee, opt && opt.onDate);
    if (!p) return Promise.reject(adapterError(ADAPTER_ERROR.PROJECTION_INVALID, 'employee'));
    const doc = Object.assign({}, p, { derivedAt: null, sourceRevision: opt && Number.isInteger(opt.sourceRevision) ? opt.sourceRevision : null });
    const v = validateEmployeeSelfDoc(doc);
    if (!v.ok) return Promise.reject(adapterError(ADAPTER_ERROR.PROJECTION_INVALID, v.code));
    let ref, src;
    try { ref = fs.doc(s4Path(T, 'employeeSelf', ansattId)); src = fs.doc('tenants/' + T + '/ansatte/' + ansattId); } catch (e) { return Promise.reject(e); }
    return fs.runTransaction(async (tx) => {
      const s = await tx.get(src);
      const raw = s && s.exists ? s.data : null;
      const base = raw && raw.e360 && typeof raw.e360 === 'object' ? raw.e360 : null;
      if (!base || !Array.isArray(base.terms) || base.terms.length === 0) throw baselineRequiredError();
      const storedStart = typeof base.startDate === 'string' && base.startDate ? base.startDate : (base.terms[0] && base.terms[0].validFrom) || null;
      if (p.startDate !== storedStart) throw adapterError(ADAPTER_ERROR.PROJECTION_INVALID, 'sourceMismatch');
      tx.set(ref, Object.assign({}, doc, { derivedAt: st() }));
      return { ok: true, projection: p };
    }).catch(rejectMapped);
  };

}

/**
 * createProductionAdapters({ fs, tenantId, membership, isCurrent, nowMs, policy, onError, deps })
 *   fs          injected datastore capability: doc(path)→ref · listen(spec, onDocs, onError)→unsubscribe
 *               (spec = { col, where:[[f,op,v]…], orderBy?:[f,dir] } | { doc }) · runTransaction(async tx=>…)
 *               (tx.get(ref)→{exists,data}, tx.set(ref,data), tx.update(ref,data)) · batch()→{set,update,commit()} ·
 *               serverTimestamp()→sentinel
 *   membership  the ONE resolved identity { uid, tenantId, accessRole, ansattId, accessEnabled } (bridge-validated)
 *   isCurrent   host generation guard (S2b-2 authGeneration); a stale adapter ignores callbacks and refuses writes
 *   nowMs       injected clock (default Date.now)
 *   policy      ETR2A_POLICY (the single accepted policy object)
 *   onError     host callback ({ scope, code }) for listener errors (never throws into the shell)
 *   deps        optional admin deps: resolveAssignee(ansattId) → { status:'FOUND', tenantId, ansattId } | { status:'NOT_FOUND' }
 * Returns the bridge ADAPTER_CONTRACT shape { schedule, attendance, employees } plus start/dispose/listenerCount,
 * schedule.claim / schedule.admin.*, attendance.commit, employeeSelf.write.
 */
export function createProductionAdapters(options) {
  const o = options || {};
  const cap = validateFsCapability(o.fs);
  if (!cap.ok) throw adapterError(ADAPTER_ERROR.CAPABILITY_MISSING, cap.missing.join(','));
  const fs = o.fs;
  const T = o.tenantId;
  const m = o.membership || {};
  if (typeof T !== 'string' || !ID_RE.test(T)) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, 'tenant');
  if (typeof m.uid !== 'string' || !m.uid || m.tenantId !== T || typeof m.ansattId !== 'string' || !ID_RE.test(m.ansattId)) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'membership');
  const MY = m.ansattId, UID = m.uid, ROLE = m.accessRole;
  const isCurrent = typeof o.isCurrent === 'function' ? o.isCurrent : () => true;
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : () => Date.now();
  const policy = o.policy;
  const onError = typeof o.onError === 'function' ? o.onError : () => {};
  const deps = o.deps || {};
  let disposed = false;
  const live = () => !disposed && isCurrent();
  const assertLive = () => { if (disposed) throw adapterError(ADAPTER_ERROR.DISPOSED); if (!isCurrent()) throw adapterError(ADAPTER_ERROR.NOT_CURRENT); };
  const subs = [];
  const st = () => fs.serverTimestamp();
  const evRef = (col, parentId, ev) => fs.doc(s4Path(T, col, parentId, 'events', ev.eventId));
  const rejectMapped = (e) => Promise.reject(e && e.code && Object.values(ADAPTER_ERROR).includes(e.code) ? e : adapterError(mapFsError(e), e && e.message));
  const selfActor = () => ({ uid: UID, accessRole: ROLE, ansattId: MY, accessEnabled: true, tenantId: T });
  const adminActor = () => ({ uid: UID, accessRole: 'admin', ansattId: MY, accessEnabled: true, tenantId: T });

  // ---- mirrors (server-confirmed only) ----
  const shiftSources = { own: new Map(), open: new Map() };
  const container = { [T]: {} };                       // ONE schedule truth (shell projects it unchanged)
  function rebuildShifts() {
    const next = {};
    for (const src of [shiftSources.open, shiftSources.own]) for (const [id, p] of src) next[id] = p;
    container[T] = next;
  }
  const attendance = new Map();                        // own records only; changed ONLY by snapshots
  const employees = { [T]: {} };
  let started = false;

  function listen(spec, apply) {
    const un = fs.listen(spec,
      (docs) => { if (!live()) return; apply(Array.isArray(docs) ? docs : []); },
      (err) => { if (!live()) return; onError({ scope: spec.col || spec.doc, code: mapFsError(err) }); });
    subs.push(typeof un === 'function' ? un : () => {});
  }
  function start() {
    assertLive();
    if (started) return;
    started = true;
    listen({ col: s4Path(T, 'shifts'), where: [['ansattId', '==', MY]] }, (docs) => {
      shiftSources.own = new Map(docs.filter((d) => d.exists !== false).map((d) => [d.id, stripServerFields(d.data)])); rebuildShifts();
    });
    listen({ col: s4Path(T, 'shifts'), where: [['status', '==', 'open'], ['ansattId', '==', null]], orderBy: ['plannedStartAt', 'asc'] }, (docs) => {
      shiftSources.open = new Map(docs.filter((d) => d.exists !== false).map((d) => [d.id, stripServerFields(d.data)])); rebuildShifts();
    });
    listen({ col: s4Path(T, 'attendance'), where: [['ansattId', '==', MY]] }, (docs) => {
      attendance.clear();
      for (const d of docs) if (d.exists !== false) attendance.set(d.id, stripServerFields(d.data));
    });
    listen({ doc: s4Path(T, 'employeeSelf', MY) }, (docs) => {
      const d = docs[0];
      const next = {};
      if (d && d.exists !== false && d.data && validateEmployeeSelfDoc(Object.assign({}, d.data, { derivedAt: null })).ok) {
        const emp = employeeSelfToShellEmployee(MY, d.data);
        if (emp) next[MY] = emp;
      }
      employees[T] = next;
    });
  }
  function dispose() {
    disposed = true;
    for (const un of subs.splice(0)) { try { un(); } catch (e) { /* one failing unsubscribe must not abort the sweep */ } }
    shiftSources.own = new Map(); shiftSources.open = new Map(); container[T] = {}; attendance.clear(); employees[T] = {};
  }
  function listenerCount() { return subs.length; }

  // ---- schedule: reads + Ta vakten + admin operations (all through the accepted cores) ----
  function claim(shiftId) {
    try { assertLive(); } catch (e) { return Promise.reject(e); }
    let ref;
    try { ref = fs.doc(s4Path(T, 'shifts', shiftId)); } catch (e) { return Promise.reject(e); }
    return fs.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap || !snap.exists) throw adapterError(ADAPTER_ERROR.NO_SHIFT);
      const existing = stripServerFields(snap.data);
      const now = nowMs();
      const res = applyScheduleOperation({
        store: { [T]: { [shiftId]: existing } }, tenantId: T, actor: null,
        op: { kind: 'claim', shiftId, ansattId: MY }, now, policy,
        deps: { resolveAssignee: (a) => (a === MY ? { status: 'FOUND', tenantId: T, ansattId: a } : { status: 'NOT_FOUND' }) },
      });
      if (!res.ok) throw adapterError(res.code);
      const p = res.projection;
      const ev = normalizeEvent({
        eventId: eventIdFor(shiftId, p.revision), type: 'shift_assignment_changed', actorUid: UID, actorRole: ROLE, at: now, revision: p.revision,
        changed: { status: { before: existing.status, after: p.status }, ansattId: { before: existing.ansattId, after: p.ansattId } },
      });
      tx.update(ref, { status: p.status, ansattId: p.ansattId, revision: p.revision, updatedAt: p.updatedAt, serverUpdatedAt: st() });
      tx.set(evRef('shifts', shiftId, ev), ev);
      return { ok: true, shiftId, projection: p, event: ev };
    }).catch(rejectMapped);
  }
  const adminWrite = makeAdminWriter({ fs, T, nowMs, policy, deps, adminActor, assertLive, rejectMapped, st, evRef });
  const admin = {
    create: (op) => adminWrite('create', null, op),                 // { workDate, ansattId|null, fromHM, toHM, roleKey }
    revise: (shiftId, op) => adminWrite('revise', shiftId, op),     // { fromHM, toHM }
    assign: (shiftId, ansattId) => adminWrite('assign', shiftId, { ansattId }),   // null = unassign (open)
    cancel: (shiftId) => adminWrite('cancel', shiftId, {}),
  };

  // ---- attendance: reads from the mirror; writes ONLY through commit(res) ----
  const commit = makeAttendanceCommitter({ fs, T, st, evRef, assertLive, rejectMapped });
  const attendanceSeam = {
    get: (id) => attendance.get(id),
    has: (id) => attendance.has(id),
    values: () => attendance.values(),
    set: () => { throw adapterError(ADAPTER_ERROR.PRODUCTION_WRITE_VIA_COMMIT); },   // never optimistic; the shell uses commit()
    commit,
  };

  // ---- employeeSelf: admin-written projection (anti-fork: derived from the canonical record only) ----
  const writeEmployeeSelf = makeEmployeeSelfWriter({ fs, T, st, assertLive, rejectMapped });

  return {
    schedule: { store: () => container, claim, admin },
    attendance: attendanceSeam,
    employees: { store: () => employees },
    employeeSelf: { write: writeEmployeeSelf, project: projectEmployeeSelf },
    start, dispose, listenerCount,
    identity: Object.freeze({ tenantId: T, ansattId: MY, uid: UID, accessRole: ROLE }),
  };
}

// ---- MANAGEMENT VAKTPLAN ADAPTER (production Vaktplan bridge) ------------------------------------------------
// Admin-only. ONE bounded listener: tenants/{T}/shifts where workDate is inside [range.from, range.to] (single-field
// range, no composite index). Mirror = the same raw-projection container shape the accepted cores/view consume.
// Writes reuse the accepted admin writer above (same transactions, same truthful events). People (legacy `ansatte`,
// document id = ansattId) are host-supplied and used ONLY for assignee resolution. `vakter` is unconstructible here
// (s4Path law). onChange() lets a host redraw when a server snapshot changed the mirror.
export function createManagementScheduleAdapters(options) {
  const o = options || {};
  const cap = validateFsCapability(o.fs);
  if (!cap.ok) throw adapterError(ADAPTER_ERROR.CAPABILITY_MISSING, cap.missing.join(','));
  const fs = o.fs;
  const T = o.tenantId;
  const m = o.membership || {};
  if (typeof T !== 'string' || !ID_RE.test(T)) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, 'tenant');
  if (typeof m.uid !== 'string' || !m.uid || m.tenantId !== T || m.accessRole !== 'admin' || m.accessEnabled !== true) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'membership');
  const ANS = typeof m.ansattId === 'string' && ID_RE.test(m.ansattId) ? m.ansattId : null;
  const UID = m.uid;
  let range = o.range || {};
  const WD_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof range.from !== 'string' || typeof range.to !== 'string' || !WD_RE.test(range.from) || !WD_RE.test(range.to) || range.from > range.to) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'range');
  const isCurrent = typeof o.isCurrent === 'function' ? o.isCurrent : () => true;
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : () => Date.now();
  const policy = o.policy;
  const onError = typeof o.onError === 'function' ? o.onError : () => {};
  const people = (Array.isArray(o.people) ? o.people : []).filter((p) => p && typeof p.ansattId === 'string' && ID_RE.test(p.ansattId));
  const deps = { resolveAssignee: typeof o.resolveAssignee === 'function' ? o.resolveAssignee : (a) => (people.some((p) => p.ansattId === a) ? { status: 'FOUND', tenantId: T, ansattId: a } : { status: 'NOT_FOUND' }) };
  let disposed = false;
  const live = () => !disposed && isCurrent();
  const assertLive = () => { if (disposed) throw adapterError(ADAPTER_ERROR.DISPOSED); if (!isCurrent()) throw adapterError(ADAPTER_ERROR.NOT_CURRENT); };
  const subs = [];
  const st = () => fs.serverTimestamp();
  const evRef = (col, parentId, ev) => fs.doc(s4Path(T, col, parentId, 'events', ev.eventId));
  const rejectMapped = (e) => Promise.reject(e && e.code && Object.values(ADAPTER_ERROR).includes(e.code) ? e : adapterError(mapFsError(e), e && e.message));
  const adminActor = () => ({ uid: UID, accessRole: 'admin', ansattId: ANS, accessEnabled: true, tenantId: T });
  const container = { [T]: {} };                       // ONE schedule truth for the management view (raw projections by shiftId)
  const watchers = new Set();
  const notify = () => { for (const cb of Array.from(watchers)) { try { cb(); } catch (e) { /* a failing watcher must not break the mirror */ } } };
  let started = false;
  function subscribe() {
    const un = fs.listen({ col: s4Path(T, 'shifts'), where: [['workDate', '>=', range.from], ['workDate', '<=', range.to]] },
      (docs) => { if (!live()) return; const next = {}; for (const d of (Array.isArray(docs) ? docs : [])) if (d.exists !== false) next[d.id] = stripServerFields(d.data); container[T] = next; notify(); },
      (err) => { if (!live()) return; onError({ scope: 'shifts', code: mapFsError(err) }); });
    subs.push(typeof un === 'function' ? un : () => {});
  }
  function start() {
    assertLive();
    if (started) return;
    started = true;
    subscribe();
  }
  // Re-window the ONE bounded listener (Vaktplan navigation outside the loaded window). Same query law, new bounds;
  // the mirror is replaced by the next snapshot; nothing else changes.
  function setRange(next) {
    assertLive();
    const n = next || {};
    if (typeof n.from !== 'string' || typeof n.to !== 'string' || !WD_RE.test(n.from) || !WD_RE.test(n.to) || n.from > n.to) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'range');
    if (n.from === range.from && n.to === range.to) return false;
    range = { from: n.from, to: n.to };
    if (started) { for (const un of subs.splice(0)) { try { un(); } catch (e) { /* sweep */ } } subscribe(); }
    return true;
  }
  function dispose() {
    disposed = true;
    for (const un of subs.splice(0)) { try { un(); } catch (e) { /* one failing unsubscribe must not abort the sweep */ } }
    container[T] = {}; watchers.clear();
  }
  function listenerCount() { return subs.length; }
  function onChange(cb) { if (typeof cb !== 'function') return () => {}; watchers.add(cb); return () => { watchers.delete(cb); }; }
  const adminWrite = makeAdminWriter({ fs, T, nowMs, policy, deps, adminActor, assertLive, rejectMapped, st, evRef });
  const admin = {
    create: (op) => adminWrite('create', null, op),                 // { workDate, ansattId|null, fromHM, toHM, roleKey }
    revise: (shiftId, op) => adminWrite('revise', shiftId, op),     // { fromHM, toHM }
    assign: (shiftId, ansattId) => adminWrite('assign', shiftId, { ansattId }),   // null = unassign (open)
    cancel: (shiftId) => adminWrite('cancel', shiftId, {}),
  };
  return {
    schedule: { store: () => container, admin },
    people: () => people.slice(),
    start, dispose, listenerCount, onChange, setRange,
    currentRange: () => ({ from: range.from, to: range.to }),
    range: Object.freeze({ from: range.from, to: range.to }),
    identity: Object.freeze({ tenantId: T, ansattId: ANS, uid: UID, accessRole: 'admin' }),
  };
}
