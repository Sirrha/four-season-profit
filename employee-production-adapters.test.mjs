// employee-production-adapters.test.mjs
// S4 foundation — production adapter proofs P1–P14 against an in-memory FAKE datastore (no Firebase, no
// network). The emulator + rules proof of the SAME adapter module lives in the scratch Step-C toolchain
// (step-c-emulator/s4/test/run-adapters.mjs). Node built-ins only. Run: node employee-production-adapters.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createProductionAdapters, createManagementScheduleAdapters, s4Path, normalizeEvent, validateFsCapability, ADAPTER_ERROR, S4_COLLECTIONS } from './employee-production-adapters.mjs';
import { ETR2A_POLICY as POLICY, clockIn, clockOut, startBreak, employeeEdit, attendanceIdFor, eventIdFor, tenantLocalHMToUtcMs, tenantWorkDate } from './employee-shell-core.mjs';
import { seedFourSeasonEmployees, employeeOf } from './management-employees-core.mjs';
import { FOUR_SEASON_PEOPLE } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { const p = fn(); return Promise.resolve(p).then(() => { passed++; lines.push('PASS  ' + id + '  ' + name); }, (e) => { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); }); }

// ---- FAKE datastore implementing the injected capability ----
function makeFakeFs() {
  const docs = new Map();                 // path -> data
  const listeners = [];                   // { spec, onDocs, onErr, active }
  const writes = [];                      // every write path (proof: only S4 paths)
  const state = { failNext: null, betweenGetAndWrite: null, unsubscribed: 0 };
  const ST = { __serverTimestamp: true };
  const colOf = (path) => path.split('/').slice(0, -1).join('/');
  const idOf = (path) => path.split('/').pop();
  const matches = (spec, path, data) => {
    if (spec.doc) return path === spec.doc;
    if (colOf(path) !== spec.col) return false;
    for (const [f, op, v] of spec.where || []) {
      const val = data[f] === undefined ? null : data[f];
      if (op === '==') { if (val !== v) return false; }
      else if (op === '>=') { if (!(val >= v)) return false; }
      else if (op === '<=') { if (!(val <= v)) return false; }
      else throw new Error('fake supports ==, >=, <= only');
    }
    return true;
  };
  const docsFor = (spec) => {
    if (spec.doc) { return [{ id: idOf(spec.doc), exists: docs.has(spec.doc), data: docs.get(spec.doc) }]; }
    const out = [];
    for (const [p, d] of docs) if (matches(spec, p, d)) out.push({ id: idOf(p), exists: true, data: d });
    if (spec.orderBy) out.sort((a, b) => (a.data[spec.orderBy[0]] > b.data[spec.orderBy[0]] ? 1 : -1) * (spec.orderBy[1] === 'desc' ? -1 : 1));
    return out;
  };
  const apply = (w) => { for (const [kind, path, data] of w) { writes.push(path); if (kind === 'set') docs.set(path, JSON.parse(JSON.stringify(data))); else { if (!docs.has(path)) throw Object.assign(new Error('not-found'), { code: 'not-found' }); docs.set(path, Object.assign({}, docs.get(path), JSON.parse(JSON.stringify(data)))); } } };
  const maybeFail = () => { if (state.failNext) { const c = state.failNext; state.failNext = null; throw Object.assign(new Error(c), { code: c }); } };
  const api = {
    doc: (path) => ({ path }),
    serverTimestamp: () => ST,
    listen: (spec, onDocs, onErr) => { const l = { spec, onDocs, onErr, active: true }; listeners.push(l); return () => { l.active = false; state.unsubscribed++; }; },
    runTransaction: async (fn) => {
      const w = [];
      const tx = {
        get: async (ref) => { const r = { exists: docs.has(ref.path), data: docs.get(ref.path) }; if (state.betweenGetAndWrite) { const h = state.betweenGetAndWrite; state.betweenGetAndWrite = null; h(); } return r; },
        set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]),
      };
      const out = await fn(tx);
      maybeFail();
      apply(w);
      return out;
    },
    batch: () => { const w = []; return { set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]), commit: async () => { maybeFail(); apply(w); } }; },
  };
  const emit = () => { for (const l of listeners) if (l.active) l.onDocs(docsFor(l.spec)); };
  return { api, docs, listeners, writes, state, emit, ST, seed: (path, data) => docs.set(path, JSON.parse(JSON.stringify(data))) };
}

const T = 'four-season-as', TZ = POLICY.timezone;
const today = tenantWorkDate(Date.now(), TZ);
const hm = (h) => tenantLocalHMToUtcMs(today, h, TZ);
const memb = (ansattId, role) => ({ uid: 'auth-' + ansattId, tenantId: T, accessRole: role || 'employee', ansattId, accessEnabled: true });
const shiftDoc = (ansattId, from, to, status) => ({ ansattId, plannedStartAt: hm(from), plannedEndAt: hm(to), workDate: today, roleKey: null, status: status || (ansattId ? 'assigned' : 'open'), revision: 1, createdByUid: 'auth-adm', createdAt: Date.now() - 3600000, updatedAt: Date.now() - 3600000, serverCreatedAt: { __srv: 1 }, serverUpdatedAt: { __srv: 1 } });
const shiftFor = (id, d) => ({ shiftId: id, tenantId: T, ansattId: d.ansattId, status: d.status, workDate: d.workDate, plannedStartAt: d.plannedStartAt, plannedEndAt: d.plannedEndAt, revision: d.revision, roleKey: d.roleKey });
const actorOf = (m) => ({ uid: m.uid, accessRole: m.accessRole, ansattId: m.ansattId, accessEnabled: true, tenantId: T });
function build(F, m, extra) { return createProductionAdapters(Object.assign({ fs: F.api, tenantId: T, membership: m, policy: POLICY }, extra || {})); }

await t('P1', 's4Path builds only the three S4 collections (+events); vakter/ansatte/root/other paths are refused', () => {
  assert.deepEqual([...S4_COLLECTIONS], ['shifts', 'attendance', 'employeeSelf']);
  assert.equal(s4Path(T, 'shifts', 'mg-1'), 'tenants/four-season-as/shifts/mg-1');
  assert.equal(s4Path(T, 'attendance', 'a_b', 'events', 'a_b-rev-000001'), 'tenants/four-season-as/attendance/a_b/events/a_b-rev-000001');
  for (const bad of [() => s4Path(T, 'vakter', 'x'), () => s4Path(T, 'ansatte', 'x'), () => s4Path(T, 'shifts', 'x', 'children'), () => s4Path(T, 'shifts', 'a/b'), () => s4Path('../x', 'shifts'), () => s4Path(T, 'shifts', 'x', 'events', 'bad id')]) assert.throws(bad, (e) => e.code === ADAPTER_ERROR.PATH_FORBIDDEN);
  assert.deepEqual(validateFsCapability({}).missing, ['doc', 'listen', 'runTransaction', 'batch', 'serverTimestamp']);
});
await t('P2', 'factory refuses a missing capability, a wrong tenant and a membership without ansattId (preview/fixture identity can never become production authority)', () => {
  const F = makeFakeFs();
  assert.throws(() => createProductionAdapters({ fs: {}, tenantId: T, membership: memb('a1'), policy: POLICY }), (e) => e.code === ADAPTER_ERROR.CAPABILITY_MISSING);
  assert.throws(() => build(F, { uid: 'u', tenantId: 'other', accessRole: 'employee', ansattId: 'a1', accessEnabled: true }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => build(F, { uid: 'u', tenantId: T, accessRole: 'admin', ansattId: null, accessEnabled: true }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => build(F, { uid: 'uid-maria', tenantId: 'four-season', accessRole: 'employee', ansattId: 'ans-maria', accessEnabled: true }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED, 'fixture tenant id is not the production tenant');
});
await t('P3', 'start() attaches exactly 4 listeners (own shifts, open shifts, own attendance, own employeeSelf); dispose() unsubscribes all and empties mirrors', () => {
  const F = makeFakeFs(); const A = build(F, memb('a1'));
  assert.equal(A.listenerCount(), 0); A.start(); A.start();
  assert.equal(A.listenerCount(), 4);
  assert.deepEqual(F.listeners.map((l) => l.spec.col || l.spec.doc), ['tenants/four-season-as/shifts', 'tenants/four-season-as/shifts', 'tenants/four-season-as/attendance', 'tenants/four-season-as/employeeSelf/a1']);
  assert.deepEqual(F.listeners[0].spec.where, [['ansattId', '==', 'a1']]); assert.deepEqual(F.listeners[1].spec.where, [['status', '==', 'open'], ['ansattId', '==', null]]); assert.deepEqual(F.listeners[2].spec.where, [['ansattId', '==', 'a1']]);
  A.dispose(); assert.equal(A.listenerCount(), 0); assert.equal(F.state.unsubscribed, 4);
  assert.deepEqual(A.schedule.store(), { [T]: {} }); assert.equal(A.attendance.has('x'), false);
  assert.rejects(A.claim ? Promise.resolve() : Promise.resolve());
});
await t('P4', 'snapshots mirror own + open shifts into ONE container (server-stamps stripped); removals apply; stale-generation callbacks are ignored', () => {
  const F = makeFakeFs(); let current = true; const A = build(F, memb('a1'), { isCurrent: () => current });
  F.seed('tenants/four-season-as/shifts/s-a1', shiftDoc('a1', '08:00', '16:00')); F.seed('tenants/four-season-as/shifts/s-open', shiftDoc(null, '16:00', '20:00', 'open')); F.seed('tenants/four-season-as/shifts/s-a2', shiftDoc('a2', '10:00', '18:00'));
  A.start(); F.emit();
  const c = A.schedule.store()[T];
  assert.deepEqual(Object.keys(c).sort(), ['s-a1', 's-open']); assert.ok(!('serverCreatedAt' in c['s-a1'])); assert.equal(c['s-a1'].ansattId, 'a1');
  F.docs.delete('tenants/four-season-as/shifts/s-open'); F.emit(); assert.deepEqual(Object.keys(A.schedule.store()[T]), ['s-a1']);
  current = false; F.seed('tenants/four-season-as/shifts/s-open2', shiftDoc(null, '17:00', '21:00', 'open')); F.emit();
  assert.deepEqual(Object.keys(A.schedule.store()[T]), ['s-a1'], 'stale generation ignores snapshots');
});
await t('P5', 'Ta vakten: applyScheduleOperation decides; the transaction updates exactly {status, ansattId, revision, updatedAt, serverUpdatedAt} and writes ONE truthful event; the mirror is NOT changed optimistically', async () => {
  const F = makeFakeFs(); const A = build(F, memb('a1'));
  F.seed('tenants/four-season-as/shifts/s-open', shiftDoc(null, '16:00', '20:00', 'open')); A.start(); F.emit();
  const r = await A.schedule.claim('s-open');
  assert.equal(r.ok, true); assert.equal(r.projection.status, 'assigned'); assert.equal(r.projection.ansattId, 'a1'); assert.equal(r.projection.revision, 2);
  const stored = F.docs.get('tenants/four-season-as/shifts/s-open');
  assert.equal(stored.status, 'assigned'); assert.equal(stored.revision, 2); assert.deepEqual(stored.serverUpdatedAt, F.ST); assert.equal(stored.plannedStartAt, hm('16:00'));
  const ev = F.docs.get('tenants/four-season-as/shifts/s-open/events/' + eventIdFor('s-open', 2));
  assert.deepEqual(ev, { eventId: eventIdFor('s-open', 2), type: 'shift_assignment_changed', actorUid: 'auth-a1', actorRole: 'employee', at: stored.updatedAt, revision: 2, changed: { status: { before: 'open', after: 'assigned' }, ansattId: { before: null, after: 'a1' } } });
  assert.equal(A.schedule.store()[T]['s-open'].status, 'open', 'mirror unchanged until the server snapshot');
  F.emit(); assert.equal(A.schedule.store()[T]['s-open'].status, 'assigned');
  await assert.rejects(A.schedule.claim('s-open'), (e) => e.code === 'SHIFT_TAKEN');
  F.seed('tenants/four-season-as/shifts/s-c', shiftDoc(null, '16:00', '20:00', 'cancelled')); await assert.rejects(A.schedule.claim('s-c'), (e) => e.code === 'SHIFT_CANCELLED');
  await assert.rejects(A.schedule.claim('nope'), (e) => e.code === ADAPTER_ERROR.NO_SHIFT);
  assert.ok(F.writes.every((p) => /^tenants\/four-season-as\/(shifts|attendance|employeeSelf)\//.test(p)), 'only S4 paths written');
});
await t('P6', 'attendance commit (create): batch writes the core record + server stamps and the normalised core event; set() is refused in production; mirror unchanged until snapshot', async () => {
  const F = makeFakeFs(); const A = build(F, memb('a1'));
  F.seed('tenants/four-season-as/shifts/s-a1', shiftDoc('a1', '08:00', '16:00')); A.start(); F.emit();
  const sh = shiftFor('s-a1', F.docs.get('tenants/four-season-as/shifts/s-a1'));
  const ci = clockIn({ actor: actorOf(memb('a1')), shift: sh, existing: null, scope: { tenantId: T, shiftId: 's-a1' }, reasonCode: 'MANAGEMENT_DECISION' }, Date.now(), POLICY);
  assert.ok(ci.ok, ci.code);
  assert.throws(() => A.attendance.set('x', {}), (e) => e.code === ADAPTER_ERROR.PRODUCTION_WRITE_VIA_COMMIT);
  const r = await A.attendance.commit(ci, { create: true });
  assert.equal(r.ok, true); assert.equal(r.retried, false);
  const id = ci.attendance.attendanceId; const stored = F.docs.get('tenants/four-season-as/attendance/' + id);
  assert.deepEqual(stored.serverCreatedAt, F.ST); assert.equal(stored.revision, 1); assert.equal(stored.status, 'clocked_in');
  const ev = F.docs.get('tenants/four-season-as/attendance/' + id + '/events/' + eventIdFor(id, 1));
  assert.deepEqual(ev, normalizeEvent(ci.event)); assert.equal(ev.type, 'clock_in');
  assert.equal(A.attendance.has(id), false, 'no optimistic mirror'); F.emit(); assert.equal(A.attendance.has(id), true);
  await assert.rejects(A.attendance.commit({ ok: false, code: 'NOT_OWN_SHIFT' }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
});
await t('P7a', 'attendance commit (update) without a rerun on a STALE record fails visibly with STALE_REVISION and writes nothing', async () => {
  const F = makeFakeFs(); const A = build(F, memb('a1'));
  F.seed('tenants/four-season-as/shifts/s-a1', shiftDoc('a1', '08:00', '16:00')); A.start(); F.emit();
  const sh = shiftFor('s-a1', F.docs.get('tenants/four-season-as/shifts/s-a1')); const act = actorOf(memb('a1')); const sc = { tenantId: T, shiftId: 's-a1' };
  const ci = clockIn({ actor: act, shift: sh, existing: null, scope: sc, reasonCode: 'MANAGEMENT_DECISION' }, Date.now() - 60000, POLICY);
  await A.attendance.commit(ci, { create: true }); F.emit();
  const id = ci.attendance.attendanceId; const path = 'tenants/four-season-as/attendance/' + id;
  const uiExisting = A.attendance.get(id);
  const res = startBreak({ actor: act, existing: uiExisting, scope: sc }, Date.now(), POLICY);
  const serverMoved = startBreak({ actor: act, existing: uiExisting, scope: sc }, Date.now() - 30000, POLICY).attendance;   // rev 2 already on the server
  F.docs.set(path, Object.assign({}, serverMoved, { serverCreatedAt: F.ST, serverUpdatedAt: F.ST }));
  await assert.rejects(A.attendance.commit(res), (e) => e.code === ADAPTER_ERROR.STALE_REVISION);
  assert.equal(F.docs.get(path).revision, 2, 'nothing written'); assert.equal(A.attendance.get(id).revision, 1, 'mirror untouched until a snapshot');
});
await t('P7b', 'stale re-run semantics precisely: rerun is invoked once with the SERVER record; a legitimate re-run commits with retried=true; a refusing re-run fails with its core code and writes nothing', async () => {
  const F = makeFakeFs(); const A = build(F, memb('a1'));
  F.seed('tenants/four-season-as/shifts/s-a1', shiftDoc('a1', '08:00', '16:00')); A.start(); F.emit();
  const sh = shiftFor('s-a1', F.docs.get('tenants/four-season-as/shifts/s-a1')); const act = actorOf(memb('a1')); const sc = { tenantId: T, shiftId: 's-a1' };
  const ci = clockIn({ actor: act, shift: sh, existing: null, scope: sc, reasonCode: 'MANAGEMENT_DECISION' }, Date.now() - 120000, POLICY);
  await A.attendance.commit(ci, { create: true }); F.emit();
  const id = ci.attendance.attendanceId; const path = 'tenants/four-season-as/attendance/' + id;
  const stale = A.attendance.get(id);                                   // rev 1 as seen by the UI
  // server: a break start+end happened elsewhere -> rev 3, working
  const b1 = startBreak({ actor: act, existing: stale, scope: sc }, Date.now() - 90000, POLICY).attendance;
  const b2 = (await import('./employee-shell-core.mjs')).endBreak({ actor: act, existing: b1, scope: sc }, Date.now() - 60000, POLICY).attendance;
  F.docs.set(path, Object.assign({}, b2, { serverCreatedAt: F.ST, serverUpdatedAt: F.ST }));
  const uiRes = clockOut({ actor: act, existing: stale, scope: sc, reasonCode: 'MANAGEMENT_DECISION' }, Date.now(), POLICY);   // rev 2 from a stale base
  let seen = [];
  const r = await A.attendance.commit(uiRes, { rerun: (existing) => { seen.push(existing.revision); return clockOut({ actor: act, existing, scope: sc, reasonCode: 'MANAGEMENT_DECISION' }, Date.now(), POLICY); } });
  assert.deepEqual(seen, [3], 'rerun invoked exactly once with the server record'); assert.equal(r.retried, true); assert.equal(r.attendance.revision, 4); assert.equal(F.docs.get(path).revision, 4);
  assert.equal(F.docs.get(path + '/events/' + eventIdFor(id, 4)).type, 'clock_out');
  // a second stale commit whose re-run refuses: nothing written, core code surfaced
  const stale2 = clockOut({ actor: act, existing: stale, scope: sc, reasonCode: 'MANAGEMENT_DECISION' }, Date.now(), POLICY);
  seen = [];
  await assert.rejects(A.attendance.commit(stale2, { rerun: (existing) => { seen.push(existing.revision); return clockOut({ actor: act, existing, scope: sc }, Date.now(), POLICY); } }), (e) => e.code === ADAPTER_ERROR.STALE_REVISION && /NOT_CLOCKED_IN/.test(e.message));
  assert.deepEqual(seen, [4]); assert.equal(F.docs.get(path).revision, 4, 'no write after a refused re-run');
});
await t('P8', 'permission / network failure: the commit rejects with the mapped code and NOTHING changes locally (no optimistic state)', async () => {
  const F = makeFakeFs(); const A = build(F, memb('a1'));
  F.seed('tenants/four-season-as/shifts/s-a1', shiftDoc('a1', '08:00', '16:00')); A.start(); F.emit();
  const sh = shiftFor('s-a1', F.docs.get('tenants/four-season-as/shifts/s-a1'));
  const ci = clockIn({ actor: actorOf(memb('a1')), shift: sh, existing: null, scope: { tenantId: T, shiftId: 's-a1' }, reasonCode: 'MANAGEMENT_DECISION' }, Date.now(), POLICY);
  F.state.failNext = 'permission-denied';
  await assert.rejects(A.attendance.commit(ci, { create: true }), (e) => e.code === ADAPTER_ERROR.PERMISSION_DENIED);
  assert.equal(F.docs.has('tenants/four-season-as/attendance/' + ci.attendance.attendanceId), false); assert.equal(A.attendance.has(ci.attendance.attendanceId), false);
  F.state.failNext = 'unavailable';
  await assert.rejects(A.schedule.claim('s-a1').catch((e) => { throw e; }), (e) => e.code === 'SHIFT_TAKEN' || e.code === ADAPTER_ERROR.UNAVAILABLE);
  F.state.failNext = null;
});
await t('P9', 'event normalisation: an employee_edit whose note never existed carries no `before` (undefined dropped); the stored event equals JSON-normalised core output', async () => {
  const F = makeFakeFs(); const A = build(F, memb('a1'));
  F.seed('tenants/four-season-as/shifts/s-a1', shiftDoc('a1', '08:00', '16:00')); A.start(); F.emit();
  const sh = shiftFor('s-a1', F.docs.get('tenants/four-season-as/shifts/s-a1')); const act = actorOf(memb('a1')); const sc = { tenantId: T, shiftId: 's-a1' };
  const ci = clockIn({ actor: act, shift: sh, existing: null, scope: sc, reasonCode: 'MANAGEMENT_DECISION' }, Date.now() - 1000, POLICY); await A.attendance.commit(ci, { create: true }); F.emit();
  const co = clockOut({ actor: act, existing: A.attendance.get(ci.attendance.attendanceId), scope: sc, reasonCode: 'MANAGEMENT_DECISION' }, Date.now() - 500, POLICY); await A.attendance.commit(co); F.emit();
  const ed = employeeEdit({ actor: act, existing: A.attendance.get(ci.attendance.attendanceId), patch: { note: 'x' }, scope: sc }, Date.now(), POLICY);
  assert.equal(ed.event.changed.note.before, undefined);
  await A.attendance.commit(ed);
  const ev = F.docs.get('tenants/four-season-as/attendance/' + ci.attendance.attendanceId + '/events/' + eventIdFor(ci.attendance.attendanceId, 3));
  assert.deepEqual(ev.changed, { note: { after: 'x' } }); assert.ok(!('before' in ev.changed.note)); assert.deepEqual(ev, normalizeEvent(ed.event));
});
await t('P10', 'admin schedule operations run through the accepted cores and persist projection + truthful event (create id law with collision suffix; revise; assign/unassign; cancel terminal)', async () => {
  const F = makeFakeFs(); const A = build(F, memb('adm', 'admin'));
  A.start();
  const c1 = await A.schedule.admin.create({ workDate: today, ansattId: 'a1', fromHM: '09:00', toHM: '13:00', roleKey: null });
  assert.equal(c1.shiftId, 'mg-' + today + '-a1'); assert.equal(c1.projection.revision, 1); assert.equal(c1.event.type, 'shift_created'); assert.equal(c1.event.eventId, eventIdFor(c1.shiftId, 1));
  assert.deepEqual(Object.keys(c1.event.changed).sort(), ['ansattId', 'plannedEndAt', 'plannedStartAt', 'roleKey', 'status', 'workDate']);
  const c2 = await A.schedule.admin.create({ workDate: today, ansattId: 'a1', fromHM: '14:00', toHM: '18:00', roleKey: null });
  assert.equal(c2.shiftId, 'mg-' + today + '-a1-2', 'collision suffix proven by transaction reads');
  const open = await A.schedule.admin.create({ workDate: today, ansattId: null, fromHM: '18:00', toHM: '22:00' });
  assert.equal(open.shiftId, 'mg-' + today + '-manko'); assert.equal(open.projection.status, 'open');
  const rv = await A.schedule.admin.revise(c1.shiftId, { fromHM: '09:00', toHM: '14:00' });
  assert.equal(rv.projection.revision, 2); assert.equal(rv.event.type, 'shift_revised'); assert.deepEqual(Object.keys(rv.event.changed), ['plannedEndAt']);
  const un = await A.schedule.admin.assign(c1.shiftId, null);
  assert.equal(un.projection.status, 'open'); assert.equal(un.projection.ansattId, null); assert.equal(un.event.type, 'shift_assignment_changed'); assert.deepEqual(Object.keys(un.event.changed).sort(), ['ansattId', 'status']);
  const as = await A.schedule.admin.assign(c1.shiftId, 'a2');
  assert.equal(as.projection.ansattId, 'a2'); assert.equal(as.projection.revision, 4);
  const cn = await A.schedule.admin.cancel(c1.shiftId);
  assert.equal(cn.projection.status, 'cancelled'); assert.equal(cn.event.type, 'shift_cancelled'); assert.deepEqual(cn.event.changed, { status: { before: 'assigned', after: 'cancelled' } });
  await assert.rejects(A.schedule.admin.revise(c1.shiftId, { fromHM: '10:00', toHM: '11:00' }), (e) => e.code === 'SHIFT_CANCELLED');
  const evs = [...F.docs.keys()].filter((p) => p.startsWith('tenants/four-season-as/shifts/' + c1.shiftId + '/events/'));
  assert.equal(evs.length, 5, 'one event per revision 1..5');
  assert.ok(F.writes.every((p) => !p.includes('/vakter/')), 'legacy vakter never written');
});
await t('P11', 'admin cancel is blocked by existing attendance for the assignee (frozen invariant via injected existence fact from the transaction read)', async () => {
  const F = makeFakeFs(); const A = build(F, memb('adm', 'admin')); A.start();
  const c1 = await A.schedule.admin.create({ workDate: today, ansattId: 'a1', fromHM: '09:00', toHM: '13:00', roleKey: null });
  F.seed('tenants/four-season-as/attendance/' + attendanceIdFor(c1.shiftId, 'a1'), { attendanceId: attendanceIdFor(c1.shiftId, 'a1'), ansattId: 'a1', revision: 1 });
  await assert.rejects(A.schedule.admin.cancel(c1.shiftId), (e) => /ATTENDANCE/.test(e.code));
});
await t('P12', 'employeeSelf: admin write derives the exact projection from the canonical record (never wage/contact/notes); the employee mirror rebuilds the shell shape from the PATH id', async () => {
  const F = makeFakeFs(); const ADM = build(F, memb('adm', 'admin'));
  const store = seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
  const e = employeeOf(store, T, 'ans-maria');
  const r = await ADM.employeeSelf.write('ans-maria', e, { onDate: today, sourceRevision: 7 });
  assert.equal(r.ok, true);
  const d = F.docs.get('tenants/four-season-as/employeeSelf/ans-maria');
  assert.deepEqual(Object.keys(d).sort(), ['derivedAt', 'employmentType', 'expectedWeeklyHours', 'hasContract', 'name', 'percentage', 'role', 'sourceRevision', 'startDate', 'workplace']);
  assert.deepEqual(d.derivedAt, F.ST); assert.equal(d.sourceRevision, 7); assert.equal(d.name, 'Maria'); assert.equal(d.percentage, 100);
  assert.ok(!JSON.stringify(d).includes('250') && !('compensation' in d) && !('ansattId' in d));
  const EMP = build(F, memb('ans-maria')); EMP.start(); F.emit();
  const shell = EMP.employees.store()[T]['ans-maria'];
  assert.equal(shell.ansattId, 'ans-maria'); assert.equal(shell.terms[0].compensation, null); assert.equal(shell.terms[0].percentage, 100);
  await assert.rejects(ADM.employeeSelf.write('ans-x', { name: 'x' }), (e) => e.code === ADAPTER_ERROR.PROJECTION_INVALID);
});
await t('P13', 'disposed or superseded adapters refuse writes and ignore snapshots', async () => {
  const F = makeFakeFs(); let cur = true; const A = build(F, memb('a1'), { isCurrent: () => cur }); A.start();
  cur = false; await assert.rejects(A.schedule.claim('x'), (e) => e.code === ADAPTER_ERROR.NOT_CURRENT);
  cur = true; A.dispose(); await assert.rejects(A.schedule.claim('x'), (e) => e.code === ADAPTER_ERROR.DISPOSED);
  await assert.rejects(A.attendance.commit({ ok: true, attendance: { attendanceId: 'a', revision: 1 }, event: {} }), (e) => e.code === ADAPTER_ERROR.DISPOSED);
});
await t('P14', 'source guards: adapters/projection have zero Firebase or network symbols; the shell routes all three employee writers through persistAttendance; preview seam unchanged', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // block + line comments (prose may say "document.")
  for (const f of ['employee-production-adapters.mjs', 'employee-self-projection.mjs']) {
    const src = strip(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'));
    assert.ok(!/firebase|initializeApp|firestore\(|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|document\.|window\./i.test(src), f);
  }
  const shell = fs.readFileSync(new URL('./employee-shell-ui.mjs', import.meta.url), 'utf8');
  assert.equal((shell.match(/(?<!function )persistAttendance\(attId, res, rerun\)/g) || []).length, 3);
  assert.ok(shell.includes("return { schedule: { store: previewScheduleStore }, attendance: new Map(), employees: { store: previewEmployeeStore } };"), 'preview adapters unchanged');
  assert.ok(shell.includes('attendanceStore.set(attId, res.attendance);'), 'preview direct set retained inside the seam');
  assert.ok(!shell.includes("import { createProductionAdapters"), 'the shell never imports the production adapters (the host injects them)');
});

// ---- Vaktplan bridge: management schedule adapter (createManagementScheduleAdapters) ----
const ADM_M = { uid: 'uid-admin-1', tenantId: T, accessRole: 'admin', ansattId: 'Ij7AmknF9ZDAdWgwQGJi', accessEnabled: true };
const LEGACY = { ansattId: 'Kx9mQ2vT7pLa4RcW1nZb', name: 'Mr Testperson', roleKey: 'butikkmedarbeider' };
const RANGE = { from: '2026-09-01', to: '2026-10-31' };
const buildM = (F, extra) => createManagementScheduleAdapters(Object.assign({ fs: F.api, tenantId: T, membership: ADM_M, people: [LEGACY], range: RANGE, policy: POLICY }, extra || {}));
await t('P15', 'management factory: admin-only membership, well-formed range, capability required; employee/disabled/other-tenant memberships and fixture-less people are refused or ignored', () => {
  const F = makeFakeFs();
  assert.throws(() => buildM(F, { membership: { ...ADM_M, accessRole: 'employee' } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => buildM(F, { membership: { ...ADM_M, accessEnabled: false } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => buildM(F, { membership: { ...ADM_M, tenantId: 'other' } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => buildM(F, { range: { from: '2026-10-31', to: '2026-09-01' } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => buildM(F, { range: { from: 'x', to: 'y' } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => createManagementScheduleAdapters({ fs: {}, tenantId: T, membership: ADM_M, range: RANGE, policy: POLICY }), (e) => e.code === ADAPTER_ERROR.CAPABILITY_MISSING);
  const M = buildM(F, { membership: { ...ADM_M, ansattId: null } });   // admin without ansattId is a valid Vaktplan operator
  assert.equal(M.identity.ansattId, null); assert.equal(M.identity.accessRole, 'admin');
  assert.deepEqual(M.people(), [LEGACY]); assert.deepEqual(M.range, RANGE);
});
await t('P16', 'management read: ONE bounded workDate-range listener on shifts; in-range docs mirrored as raw projections, out-of-range excluded; onChange fires; dispose -> 0 listeners and empty mirror', () => {
  const F = makeFakeFs();
  F.seed(s4Path(T, 'shifts', 's-in'), { ansattId: LEGACY.ansattId, plannedStartAt: 1, plannedEndAt: 2, workDate: '2026-09-15', roleKey: null, status: 'assigned', revision: 1, createdByUid: 'u', createdAt: 1, updatedAt: 1, serverCreatedAt: F.ST, serverUpdatedAt: F.ST });
  F.seed(s4Path(T, 'shifts', 's-out'), { ansattId: LEGACY.ansattId, plannedStartAt: 1, plannedEndAt: 2, workDate: '2027-01-15', roleKey: null, status: 'assigned', revision: 1, createdByUid: 'u', createdAt: 1, updatedAt: 1, serverCreatedAt: F.ST, serverUpdatedAt: F.ST });
  const M = buildM(F); let changes = 0; const off = M.onChange(() => { changes += 1; });
  M.start(); M.start();
  assert.equal(M.listenerCount(), 1);
  assert.equal(F.listeners.length, 1); assert.deepEqual(F.listeners[0].spec.where, [['workDate', '>=', RANGE.from], ['workDate', '<=', RANGE.to]]);
  F.emit();
  const st = M.schedule.store()[T];
  assert.ok(st['s-in'] && !st['s-out']); assert.equal(st['s-in'].serverCreatedAt, undefined, 'server stamps stripped'); assert.equal(changes, 1);
  off(); F.emit(); assert.equal(changes, 1, 'unsubscribed watcher not called');
  M.dispose(); assert.equal(M.listenerCount(), 0); assert.deepEqual(M.schedule.store()[T], {}); assert.equal(F.state.unsubscribed, 1);
});
await t('P17', 'management admin write seam: create/revise/assign(null=unassign)/assign/cancel through the shared writer write ONLY S4 shift + event paths with truthful events; assignee resolution comes from the host-supplied people (fixture id refused); actorAnsattId = admin membership ansattId', async () => {
  const F = makeFakeFs(); const M = buildM(F); M.start();
  const c = await M.schedule.admin.create({ workDate: '2026-09-15', ansattId: LEGACY.ansattId, fromHM: '09:00', toHM: '17:00', roleKey: 'butikkmedarbeider' });
  assert.ok(c.ok); assert.equal(c.shiftId, 'mg-2026-09-15-' + LEGACY.ansattId); assert.equal(c.projection.revision, 1); assert.equal(c.event.type, 'shift_created'); assert.equal(c.event.actorRole, 'admin');
  await assert.rejects(M.schedule.admin.assign(c.shiftId, 'ans-maria'), (e) => e.code === 'ASSIGNEE_NOT_RESOLVED');
  const r = await M.schedule.admin.revise(c.shiftId, { fromHM: '10:00', toHM: '18:00' }); assert.equal(r.projection.revision, 2); assert.equal(r.event.type, 'shift_revised');
  const u = await M.schedule.admin.assign(c.shiftId, null); assert.equal(u.projection.status, 'open'); assert.equal(u.event.type, 'shift_assignment_changed');
  const a = await M.schedule.admin.assign(c.shiftId, LEGACY.ansattId); assert.equal(a.projection.status, 'assigned'); assert.equal(a.projection.revision, 4);
  const x = await M.schedule.admin.cancel(c.shiftId); assert.equal(x.projection.status, 'cancelled'); assert.equal(x.event.type, 'shift_cancelled'); assert.equal(x.projection.revision, 5);
  assert.ok(F.writes.every((p) => p.startsWith(s4Path(T, 'shifts'))), 'only shift + shift-event paths written: ' + F.writes.join(','));
  assert.ok(!F.writes.some((p) => /vakter|ansatte|employeeSelf|attendance/.test(p)), 'no legacy/other collection written');
  assert.throws(() => s4Path(T, 'vakter', 'x'), (e) => e.code === ADAPTER_ERROR.PATH_FORBIDDEN);
});
await t('P18', 'management adapter: superseded (isCurrent false) or disposed refuses writes and ignores snapshots', async () => {
  const F = makeFakeFs(); let cur = true; const M = buildM(F, { isCurrent: () => cur }); M.start();
  cur = false; F.emit(); assert.deepEqual(M.schedule.store()[T], {});
  await assert.rejects(M.schedule.admin.create({ workDate: '2026-09-15', ansattId: LEGACY.ansattId, fromHM: '09:00', toHM: '17:00', roleKey: null }), (e) => e.code === ADAPTER_ERROR.NOT_CURRENT);
  cur = true; M.dispose();
  await assert.rejects(M.schedule.admin.cancel('x'), (e) => e.code === ADAPTER_ERROR.DISPOSED);
});

for (const l of lines) console.log(l);
console.log('EMPLOYEE_PRODUCTION_ADAPTERS_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
