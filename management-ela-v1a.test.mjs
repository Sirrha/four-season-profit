// management-ela-v1a.test.mjs — EMPLOYEE LIFECYCLE & ACCESS V1, milestone ELA-V1a: end-employment hardening.
// Node built-ins only; a FAKE injected datastore for the adapters and a minimal DOM shim for the rendered Employee 360
// view (the real browser flow is additionally proven in the scratch headless harness, ela-proofs.mjs). Synthetic people.
// Proves: the canonical end transition records WHO (actor uid at the operation boundary) and WHEN (injected now);
// history/attendance/exceptions/employeeSelf untouched; invalid / repeated / unregistered refused; the UI requires an
// explicit in-page confirmation, states that ACCESS is a separate authority (never claims to revoke it), exposes no
// Tilgang control and reads no memberships; an ended record without a date shows a neutral fallback.
// Run: node management-ela-v1a.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyEmployeeOperation, seedFourSeasonEmployees, employeeOf, lacksEmploymentBaseline, termsWithRanges } from './management-employees-core.mjs';
import { createManagementAdapters, normalizeAnsatt, ansattWriteFor, E360_KEY } from './management-production-adapters.mjs';
import { ADAPTER_ERROR } from './employee-production-adapters.mjs';
import { ETR2A_POLICY as POLICY, tenantLocalHMToUtcMs } from './employee-shell-core.mjs';
import { FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MANAGER_ACTOR, FOUR_SEASON_CONTRACT_PROFILE } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }

const T = FOUR_SEASON_TENANT.tenantId, TZ = POLICY.timezone;
const MGR = FOUR_SEASON_MANAGER_ACTOR;
const TODAY = '2026-10-09';
const NOW = tenantLocalHMToUtcMs(TODAY, '12:00', TZ);
const END = '2026-09-30';
const seedE = () => seedFourSeasonEmployees(FOUR_SEASON_PEOPLE, T);
const applyE = (store, op, over) => applyEmployeeOperation(Object.assign({ store, tenantId: T, actor: MGR, op, now: NOW, timezone: TZ }, over || {}));
const J = (v) => JSON.stringify(v);

// ---------------------------------------------------------------- core ----
await t('L01', 'CORE: an active registered employee is ended with a valid date -> status ended, endedAt exact, endedByUid = the actor at the boundary, endedRecordedAt = the injected now; terms / documents / contract versions / corrections unchanged', () => {
  const store = seedE(); const emp = employeeOf(store, T, 'ans-athar');
  const hist = J([emp.terms, emp.documents, emp.contractVersions, emp.termsCorrections || null, emp.contact]);
  const r = applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: END });
  assert.equal(r.ok, true, r.code);
  assert.equal(emp.status, 'ended'); assert.equal(emp.endedAt, END);
  assert.equal(emp.endedByUid, 'uid-herish'); assert.equal(emp.endedRecordedAt, NOW);
  assert.equal(J([emp.terms, emp.documents, emp.contractVersions, emp.termsCorrections || null, emp.contact]), hist);
  assert.ok(employeeOf(store, T, 'ans-athar') === emp, 'never deleted');
});
await t('L02', 'CORE: an invalid end date is refused and nothing changes (no status, no audit)', () => {
  const store = seedE(); const before = J(store);
  for (const bad of ['', '30.09.2026', '2026-9-30', null, undefined, 20260930]) assert.equal(applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: bad }).code, 'ENDDATE_INVALID', String(bad));
  assert.equal(J(store), before);
});
await t('L03', 'CORE: ending an already-ended employee is refused (ALREADY_ENDED) and leaves endedAt / endedByUid / endedRecordedAt exactly as first recorded — no duplicate history', () => {
  const store = seedE(); const emp = employeeOf(store, T, 'ans-athar');
  assert.equal(applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: END }).ok, true);
  const snap = J(emp);
  const r = applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: '2026-10-05' }, { actor: Object.assign({}, MGR, { uid: 'uid-other-admin' }), now: NOW + 86400000 });
  assert.equal(r.code, 'ALREADY_ENDED'); assert.equal(J(emp), snap);
});
await t('L04', 'CORE: the audit cannot be fabricated — an actor without uid or a missing operation instant is refused before any mutation', () => {
  const store = seedE(); const before = J(store);
  assert.equal(applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: END }, { actor: Object.assign({}, MGR, { uid: '' }) }).code, 'ACTOR_UID_REQUIRED');
  assert.equal(applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: END }, { now: undefined }).code, 'NOW_REQUIRED');
  assert.equal(applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: END }, { actor: { accessEnabled: true, canEditEmployment: false } }).code, 'NOT_AUTHORIZED');
  assert.equal(J(store), before);
});
await t('L05', 'CORE: a new or seeded ACTIVE record carries endedByUid / endedRecordedAt = null (no fabricated audit); after the end they are set', () => {
  const store = seedE();
  for (const e of Object.values(store[T])) { assert.equal(e.status, 'active'); assert.equal(e.endedByUid, null); assert.equal(e.endedRecordedAt, null); }
  const c = applyE(store, { kind: 'createEmployee', name: 'Ny Person', startDate: '2026-10-01', role: 'kasse' });
  assert.equal(c.ok, true); assert.equal(c.employee.endedByUid, null); assert.equal(c.employee.endedRecordedAt, null);
});

// ------------------------------------------------------------ adapters ----
const ADM = { uid: 'uid-admin-ela', tenantId: T, accessRole: 'admin', ansattId: 'AdminAnsatt000000001', accessEnabled: true };
const REG = 'Registrert0000000001', LEG = 'LegacyOnly0000000002', OLD = 'InactiveLeg000000003';
const P = (col, id) => 'tenants/' + T + '/' + col + '/' + id;
const legacyDoc = (over) => Object.assign({ navn: 'Test Ansatt', stilling: 'butikkmedarbeider', timelonn: 210, adresse: 'Testveien 1', epost: 't@example.test', bankkonto: '00001122334', personnummer: '99999912345', notater: 'privat', aktiv: true, opprettet: '2026-06-20T09:15:00.000Z' }, over || {});
const termsOf = (validFrom) => ({ validFrom, role: 'butikkmedarbeider', employmentType: 'deltid', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 200 }, workplace: '4Seasons ferske varer', expectedWeeklyHours: 18.75, workingTimeArrangement: null, probation: null, noticePeriod: '1 måned', breaksArrangement: null, scheduleChangeHandling: null, employmentBasis: null, employmentEndDate: null, paymentInterval: null, employmentForm: 'fast' });
const e360Of = () => ({ name: 'Registrert Ansatt', status: 'active', endedAt: null, startDate: '2026-02-02', contact: { email: null, phone: null, address: null, birthDate: null }, terms: [termsOf('2026-02-02')], documents: [{ docId: 'doc-1', name: 'Arbeidskontrakt', category: 'kontrakt', date: '2026-02-02', source: 'registrert manuelt', note: null }], contractVersions: [], rev: 1, updatedAt: NOW - 86400000, lastOp: 'registerInitialEmployment' });
function makeFakeFs() {
  const docs = new Map(); const writes = [];
  const colOf = (p) => p.split('/').slice(0, -1).join('/'); const idOf = (p) => p.split('/').pop();
  const apply = (w) => { for (const [kind, p, d] of w) { writes.push({ kind, path: p }); if (kind === 'set') docs.set(p, JSON.parse(J(d))); else { if (!docs.has(p)) throw Object.assign(new Error('not-found'), { code: 'not-found' }); docs.set(p, Object.assign({}, docs.get(p), JSON.parse(J(d)))); } } };
  const api = {
    doc: (p) => ({ path: p }), serverTimestamp: () => ({ __st: true }), newId: () => 'AuToId00000000000001', listen: () => () => {},
    runTransaction: async (fn) => { const w = []; const tx = { get: async (ref) => ({ exists: docs.has(ref.path), data: docs.get(ref.path) }), set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]) }; const r = await fn(tx); apply(w); return r; },
    batch: () => { const w = []; return { set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]), commit: async () => { apply(w); } }; },
  };
  const readAnsatte = () => { const out = []; for (const [p, d] of docs) if (colOf(p) === 'tenants/' + T + '/ansatte') out.push(Object.assign({}, d, { id: idOf(p) })); return out; };
  return { api, docs, writes, readAnsatte, seed: (p, d) => docs.set(p, JSON.parse(J(d))) };
}
function world() {
  const F = makeFakeFs();
  F.seed(P('ansatte', REG), legacyDoc({ navn: 'Registrert Ansatt', [E360_KEY]: e360Of() }));
  F.seed(P('ansatte', LEG), legacyDoc({ navn: 'Gammel Aktiv' }));
  F.seed(P('ansatte', OLD), legacyDoc({ navn: 'Gammel Inaktiv', aktiv: false }));
  F.seed(P('attendance', 'sh-1_' + REG), { attendanceId: 'sh-1_' + REG, shiftId: 'sh-1', ansattId: REG, workDate: '2026-10-08', status: 'clocked_out', revision: 1 });
  F.seed(P('attendanceExceptions', 'mci-sh-2_' + REG), { exceptionId: 'mci-sh-2_' + REG, type: 'MISSING_CLOCK_IN', ansattId: REG, shiftId: 'sh-2', status: 'open', revision: 1 });
  F.seed(P('employeeSelf', REG), { name: 'Registrert Ansatt', role: 'butikkmedarbeider', employmentType: 'deltid', percentage: 50, workplace: '4Seasons ferske varer', startDate: '2026-02-02', expectedWeeklyHours: 18.75, hasContract: true, derivedAt: 1, sourceRevision: 1 });
  const M = createManagementAdapters({ fs: F.api, tenantId: T, membership: ADM, range: { from: '2026-09-01', to: '2026-10-31' }, readAnsatte: F.readAnsatte, defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: POLICY, nowMs: () => NOW });
  M.start();
  const others = () => J(['attendance', 'attendanceExceptions', 'employeeSelf'].map((c) => Array.from(F.docs.entries()).filter(([p]) => p.startsWith('tenants/' + T + '/' + c + '/'))));
  return { F, M, others };
}
await t('L06', 'ADAPTERS: endEmployee persists ONE update on the canonical ansatte document — e360.status ended, endedAt exact, endedByUid = membership uid, endedRecordedAt = nowMs = updatedAt, rev+1, lastOp endEmployee, legacy aktiv=false; terms / documents / contractVersions / contact / startDate / opprettet / private legacy fields byte-identical; attendance, attendanceExceptions and employeeSelf untouched', async () => {
  const { F, M, others } = world();
  const before = F.docs.get(P('ansatte', REG)); const o0 = others();
  const r = await M.employees.apply({ kind: 'endEmployee', ansattId: REG, endDate: END });
  assert.equal(r.ok, true);
  const d = F.docs.get(P('ansatte', REG)); const e = d[E360_KEY];
  assert.equal(e.status, 'ended'); assert.equal(e.endedAt, END); assert.equal(e.endedByUid, ADM.uid); assert.equal(e.endedRecordedAt, NOW);
  assert.equal(e.updatedAt, NOW); assert.equal(e.rev, 2); assert.equal(e.lastOp, 'endEmployee'); assert.equal(d.aktiv, false);
  for (const k of ['terms', 'documents', 'contractVersions', 'contact', 'startDate', 'name']) assert.equal(J(e[k]), J(before[E360_KEY][k]), 'e360.' + k);
  for (const k of ['opprettet', 'navn', 'stilling', 'timelonn', 'adresse', 'epost', 'bankkonto', 'personnummer', 'notater']) assert.equal(d[k], before[k], 'legacy ' + k);
  assert.equal(F.writes.length, 1); assert.equal(F.writes[0].kind, 'update'); assert.equal(F.writes[0].path, P('ansatte', REG));
  assert.equal(others(), o0);
  const rec = M.employees.store()[T][REG];
  assert.equal(rec.status, 'ended'); assert.equal(rec.endedAt, END); assert.equal(rec.endedByUid, ADM.uid); assert.equal(rec.endedRecordedAt, NOW);   // read back through normalizeAnsatt
  assert.ok(!M.employees.people().some((p) => p.ansattId === REG), 'ended employee leaves the planning people list');
});
await t('L07', 'ADAPTERS: a second endEmployee is refused with the core result ALREADY_ENDED and writes nothing; an invalid date writes nothing', async () => {
  const { F, M } = world();
  await M.employees.apply({ kind: 'endEmployee', ansattId: REG, endDate: END });
  const snap = J(Array.from(F.docs.entries())); const n = F.writes.length;
  await assert.rejects(M.employees.apply({ kind: 'endEmployee', ansattId: REG, endDate: '2026-10-05' }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED && e.coreResult && e.coreResult.code === 'ALREADY_ENDED');
  await assert.rejects(M.employees.apply({ kind: 'endEmployee', ansattId: REG, endDate: 'x' }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED && e.coreResult && e.coreResult.code === 'ENDDATE_INVALID');
  assert.equal(J(Array.from(F.docs.entries())), snap); assert.equal(F.writes.length, n);
});
await t('L08', 'ADAPTERS: an ACTIVE old-register employee (no e360) is still refused — endEmployee never manufactures a baseline (INITIAL_REGISTRATION_REQUIRED, zero writes); the inactive old-register record stays read-only history', async () => {
  const { F, M } = world(); const snap = J(Array.from(F.docs.entries()));
  for (const id of [LEG, OLD]) await assert.rejects(M.employees.apply({ kind: 'endEmployee', ansattId: id, endDate: END }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED && e.coreResult && e.coreResult.code === 'INITIAL_REGISTRATION_REQUIRED');
  assert.equal(J(Array.from(F.docs.entries())), snap); assert.equal(F.writes.length, 0);
  const old = M.employees.store()[T][OLD];
  assert.ok(lacksEmploymentBaseline(old)); assert.equal(old.status, 'ended'); assert.equal(old.endedAt, null); assert.equal(old.endedByUid, null); assert.equal(old.endedRecordedAt, null);
});
await t('L09', 'WRITE SHAPE: an active record never carries endedByUid / endedRecordedAt in the stored block; an ended record carries exactly the recorded values; normalizeAnsatt ignores malformed audit values', () => {
  const active = normalizeAnsatt(REG, legacyDoc({ [E360_KEY]: e360Of() }));
  const wA = ansattWriteFor('updateContact', active, legacyDoc({ [E360_KEY]: e360Of() }), NOW, TODAY)[E360_KEY];
  assert.ok(!('endedByUid' in wA) && !('endedRecordedAt' in wA));
  const ended = Object.assign({}, active, { status: 'ended', endedAt: END, endedByUid: 'uid-x', endedRecordedAt: NOW });
  const wE = ansattWriteFor('endEmployee', ended, legacyDoc({ [E360_KEY]: e360Of() }), NOW, TODAY);
  assert.equal(wE[E360_KEY].endedByUid, 'uid-x'); assert.equal(wE[E360_KEY].endedRecordedAt, NOW); assert.equal(wE.aktiv, false); assert.ok(!('opprettet' in wE));
  const bad = normalizeAnsatt(REG, legacyDoc({ [E360_KEY]: Object.assign(e360Of(), { status: 'ended', endedAt: END, endedByUid: 7, endedRecordedAt: '123' }) }));
  assert.equal(bad.endedByUid, null); assert.equal(bad.endedRecordedAt, null); assert.equal(bad.endedAt, END);
});

// ----------------------------------------------------------- rendered view ----
// Minimal DOM shim: enough of the DOM surface the Employee 360 view uses (createElement, textContent, className/classList,
// attributes, style, value, append/remove, click + listeners, querySelector with tag / .class / #id / [attr=val] and
// descendant chains). Not a browser; the real rendering is proven headless in the scratch harness.
class ShimNode {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this._cls = ''; this.style = { cssText: '', display: '' }; this.dataset = {}; this.listeners = {}; this._text = ''; this.value = ''; this.disabled = false; this.checked = false; this.selectedIndex = 0; }
  get className() { return this._cls; } set className(v) { this._cls = String(v); }
  get classList() { const s = this; const list = () => s._cls.split(/\s+/).filter(Boolean); return { contains: (c) => list().includes(c), add: (c) => { if (!list().includes(c)) s._cls = list().concat([c]).join(' '); }, remove: (c) => { s._cls = list().filter((x) => x !== c).join(' '); }, toggle: (c, f) => { const has = list().includes(c); const want = f === undefined ? !has : !!f; if (want && !has) s._cls = list().concat([c]).join(' '); if (!want && has) s._cls = list().filter((x) => x !== c).join(' '); return want; } }; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; } set textContent(v) { this.children = []; this._text = String(v); }
  get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = String(v); }
  get firstChild() { return this.children[0] || null; } get lastChild() { return this.children[this.children.length - 1] || null; } get childElementCount() { return this.children.length; } get childNodes() { return this.children.slice(); }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.children.push(n); this._text = ''; return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) { this.children.splice(i, 1); n.parentNode = null; } return n; }
  insertBefore(n, ref) { if (!ref) return this.appendChild(n); if (n.parentNode) n.parentNode.removeChild(n); const i = this.children.indexOf(ref); n.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, n); return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'class') this._cls = String(v); if (k === 'disabled') this.disabled = true; if (k === 'id') this.attrs.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; if (k === 'disabled') this.disabled = false; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatchEvent(ev) { ev.target = ev.target || this; for (const f of (this.listeners[ev.type] || [])) f(ev); return true; }
  click() { if (this.disabled || 'disabled' in this.attrs) return; this.dispatchEvent({ type: 'click' }); }
  focus() {} blur() {} setSelectionRange() {} scrollIntoView() {}
  matches(sel) { return matchCompound(this, sel.trim()); }
  querySelectorAll(sel) { const out = []; for (const one of sel.split(',')) { const parts = tokenize(one.trim()); walk(this, (n) => { if (n !== this && matchChain(n, parts)) out.push(n); }); } return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { width: 1, height: 1, top: 0, left: 0 }; }
}
function walk(n, fn) { for (const c of n.children) { fn(c); walk(c, fn); } }
function tokenize(sel) { const parts = []; let cur = ''; let q = null; for (const ch of sel) { if (q) { cur += ch; if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; } if (ch === ' ' || ch === '>') { if (cur) parts.push(cur); cur = ''; continue; } cur += ch; } if (cur) parts.push(cur); return parts; }
function matchCompound(n, comp) {
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:([\^$*]?=)"?([^"\]]*)"?)?\]/g; let m; let any = false;
  while ((m = re.exec(comp))) {
    any = true;
    if (m[1]) { if (n.tagName !== m[1].toUpperCase()) return false; }
    else if (m[2]) { if (!n.classList.contains(m[2])) return false; }
    else if (m[3]) { if (n.attrs.id !== m[3]) return false; }
    else if (m[4]) { const v = n.getAttribute(m[4]); if (v === null) return false; if (m[5] === '=' && v !== m[6]) return false; if (m[5] === '^=' && !v.startsWith(m[6])) return false; if (m[5] === '$=' && !v.endsWith(m[6])) return false; if (m[5] === '*=' && !v.includes(m[6])) return false; }
  }
  return any;
}
function matchChain(n, parts) { let node = n; for (let i = parts.length - 1; i >= 0; i--) { if (i === parts.length - 1) { if (!matchCompound(node, parts[i])) return false; node = node.parentNode; continue; } while (node && !matchCompound(node, parts[i])) node = node.parentNode; if (!node) return false; node = node.parentNode; } return true; }
globalThis.document = { createElement: (t) => new ShimNode(t), createTextNode: (s) => { const n = new ShimNode('#text'); n._text = String(s); return n; }, body: new ShimNode('body'), activeElement: null, getElementById: () => null };
globalThis.window = globalThis;
globalThis.Event = class { constructor(type) { this.type = type; } };
const { renderEmployeesView } = await import('./management-employees-view.mjs');
const viewSrc = fs.readFileSync(new URL('./management-employees-view.mjs', import.meta.url), 'utf8');

function mountView(store, applyOperation) {
  const root = new ShimNode('div');
  renderEmployeesView(root, { employeeStore: store, scheduleStore: { [T]: {} }, tenantId: T, tenantLabel: 'Test', roleLabels: {}, actor: MGR, contractProfile: FOUR_SEASON_CONTRACT_PROFILE, payrollStore: null, nowMs: NOW, timezone: TZ, onOpenVaktplanFor: () => {}, onBack: () => {}, applyOperation, applyContract: undefined, onCompanyProfileChanged: () => {}, privateFields: null });
  const btnByText = (text) => root.querySelectorAll('button').find((b) => b.textContent.trim() === text) || null;
  const open = (name) => { const b = root.querySelector('button[aria-label="Åpne ansattkort for ' + name + '"]'); if (!b) throw new Error('no row for ' + name); b.click(); };
  const section = (label) => { const b = root.querySelectorAll('button[role=tab]').find((x) => x.textContent === label); if (!b) throw new Error('no section ' + label); b.click(); };
  const facts = () => { const o = {}; for (const r of root.querySelectorAll('.emp-fact')) o[r.querySelector('.k').textContent] = r.querySelector('.v').textContent; return o; };
  const header = () => { const h = root.querySelector('.plan-head .sub'); return h ? h.textContent : (root.textContent || ''); };
  const endCard = () => root.querySelectorAll('.card.emp-form').find((c) => (c.querySelector('.kicker') || {}).textContent === 'Avslutt arbeidsforhold') || null;
  const confirmBox = () => root.querySelector('.emp-end-confirm');
  const buttons = () => root.querySelectorAll('button').map((b) => b.textContent.trim());
  return { root, btnByText, open, section, facts, header, endCard, confirmBox, buttons, text: () => root.textContent };
}
const syncApply = (store) => ({ op }) => applyEmployeeOperation({ store, tenantId: T, actor: MGR, op, now: NOW, timezone: TZ });
const NAME = 'Athar';   // fixture person (seed) — active, registered
const athar = (store) => employeeOf(store, T, 'ans-athar');
const ACCESS_SENTENCE = 'Tilgang til Sormena styres separat og må være slått av før arbeidsforholdet avsluttes.';

await t('L10', 'VIEW: Arbeidsforhold shows the end card with the access-separation sentence; pressing "Registrer som sluttet" does NOT end the employee — it opens an in-page confirmation naming the employee, the selected end date, that history is kept, that the employee is marked ended, and that access is separate and must be off', () => {
  const store = seedE(); const v = mountView(store, syncApply(store));
  v.open(athar(store).name); v.section('Arbeidsforhold');
  const card = v.endCard(); assert.ok(card, 'end card present for an active registered employee');
  assert.ok(card.textContent.includes(ACCESS_SENTENCE), 'access-separation sentence on the card');
  assert.equal(v.confirmBox(), null);
  const date = card.querySelector('input[type=date]'); assert.ok(date); date.value = END;
  v.btnByText('Registrer som sluttet').click();
  assert.equal(athar(store).status, 'active', 'first press must not end the employee');
  const cf = v.confirmBox(); assert.ok(cf, 'confirmation opened');
  const txt = cf.textContent;
  assert.ok(txt.includes('Registrer ' + athar(store).name + ' som sluttet 30. september 2026?'), 'question names employee + date: ' + txt);
  assert.ok(txt.includes('Historikk, vakter og dokumenter beholdes.'), 'history kept');
  assert.ok(txt.includes('Den ansatte merkes som sluttet fra denne datoen.'), 'marked ended');
  assert.ok(txt.includes(ACCESS_SENTENCE) && txt.includes('Denne handlingen slår ikke av tilgang.'), 'access is separate, nothing is revoked');
  assert.ok(!/tilgang(en)? (er|ble) (nå )?(slått av|deaktivert|fjernet)/i.test(v.text()), 'never claims access was disabled');
  assert.ok(cf.querySelectorAll('button').map((b) => b.textContent).includes('Ja, registrer som sluttet') && cf.querySelectorAll('button').map((b) => b.textContent).includes('Avbryt'));
  const d2 = v.endCard().querySelector('input[type=date]'); assert.equal(d2.value, END); assert.ok(d2.hasAttribute('disabled'), 'the date is locked while confirming');
});
await t('L11', 'VIEW: "Avbryt" closes the confirmation without any change; an empty / malformed date never opens it (plain refusal text)', () => {
  const store = seedE(); const v = mountView(store, syncApply(store)); const before = J(store);
  v.open(athar(store).name); v.section('Arbeidsforhold');
  v.endCard().querySelector('input[type=date]').value = END; v.btnByText('Registrer som sluttet').click(); assert.ok(v.confirmBox());
  v.btnByText('Avbryt').click(); assert.equal(v.confirmBox(), null); assert.equal(J(store), before); assert.ok(v.btnByText('Registrer som sluttet'));
  v.endCard().querySelector('input[type=date]').value = ''; v.btnByText('Registrer som sluttet').click();
  assert.equal(v.confirmBox(), null); assert.ok(v.text().includes('Oppgi en gyldig sluttdato.')); assert.equal(J(store), before);
});
await t('L12', 'VIEW: only "Ja, registrer som sluttet" sends endEmployee (synchronous boundary): the employee is ended with the confirmed date, endedByUid / endedRecordedAt recorded, the header and Oversikt read "Sluttet 30. september 2026", "Avslutning registrert" shows the audit instant, and the end card is gone', () => {
  const store = seedE(); const calls = []; const v = mountView(store, (a) => { calls.push(a.op.kind); return syncApply(store)(a); });
  v.open(athar(store).name); v.section('Arbeidsforhold');
  v.endCard().querySelector('input[type=date]').value = END; v.btnByText('Registrer som sluttet').click();
  assert.deepEqual(calls, []);
  v.btnByText('Ja, registrer som sluttet').click();
  assert.deepEqual(calls, ['endEmployee']);
  const e = athar(store); assert.equal(e.status, 'ended'); assert.equal(e.endedAt, END); assert.equal(e.endedByUid, MGR.uid); assert.equal(e.endedRecordedAt, NOW);
  assert.equal(v.confirmBox(), null); assert.equal(v.endCard(), null, 'no end card for an ended employee');
  assert.ok(v.header().includes('Sluttet 30. september 2026'), v.header());
  v.section('Oversikt'); const f = v.facts();
  assert.equal(f.Status, 'Sluttet 30. september 2026'); assert.equal(f['Avslutning registrert'], '9. oktober 2026 kl. 12:00');
});
await t('L13', 'VIEW: with an ASYNC boundary (production adapters shape) the confirm control is disabled while the request is in flight (no double submit); a refusal keeps the confirmation open with the mapped message, success closes it', async () => {
  const store = seedE(); let resolve; let n = 0;
  const v = mountView(store, (a) => { n += 1; return new Promise((res) => { resolve = () => res(syncApply(store)(a)); }); });
  v.open(athar(store).name); v.section('Arbeidsforhold');
  v.endCard().querySelector('input[type=date]').value = END; v.btnByText('Registrer som sluttet').click();
  const yes = v.btnByText('Ja, registrer som sluttet'); yes.click();
  assert.equal(n, 1);
  const yes2 = v.btnByText('Ja, registrer som sluttet'); assert.ok(yes2 && yes2.hasAttribute('disabled'), 'disabled while in flight');
  yes2.click(); assert.equal(n, 1, 'second press ignored');
  resolve(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(athar(store).status, 'ended'); assert.equal(v.confirmBox(), null);
  // refusal path: an already-ended employee via a direct second request keeps the UI truthful
  const store2 = seedE(); applyE(store2, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: END }); athar(store2).status = 'active';   // force the card open on a store the boundary will refuse
  const v2 = mountView(store2, () => Promise.resolve({ ok: false, code: 'ALREADY_ENDED' }));
  v2.open(athar(store2).name); v2.section('Arbeidsforhold'); v2.endCard().querySelector('input[type=date]').value = END; v2.btnByText('Registrer som sluttet').click(); v2.btnByText('Ja, registrer som sluttet').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(v2.confirmBox(), 'confirmation stays open after a refusal'); assert.ok(v2.text().includes('Den ansatte er allerede registrert som sluttet.'));
  assert.ok(!v2.btnByText('Ja, registrer som sluttet').hasAttribute('disabled'), 're-enabled after settle');
});
await t('L14', 'VIEW: an ended record WITHOUT a stored end date (old-register aktiv=false, no e360) reads "Sluttet – dato ikke registrert" in the card header and the Status row (never "Sluttet " + blank, never a date from opprettet); the list row says "Sluttet"', () => {
  const store = { [T]: {} };
  const rec = normalizeAnsatt(OLD, legacyDoc({ navn: 'Gammel Inaktiv', aktiv: false, opprettet: '2026-06-20T09:15:00.000Z' }));
  store[T][OLD] = rec; assert.equal(rec.endedAt, null);
  const v = mountView(store, syncApply(store));
  const row = v.root.querySelector('button[aria-label="Åpne ansattkort for Gammel Inaktiv"]'); assert.ok(row); assert.ok(row.textContent.includes('Sluttet') && !row.textContent.includes('juni'));
  v.open('Gammel Inaktiv');
  assert.ok(v.header().includes('Sluttet – dato ikke registrert'), v.header());
  assert.ok(!/Sluttet\s*(–\s*$|undefined|null|20\. juni)/.test(v.header()));
  assert.equal(v.facts().Status, 'Sluttet – dato ikke registrert'); assert.ok(!('Avslutning registrert' in v.facts()));
  assert.equal(v.endCard(), null);
});
await t('L15', 'VIEW: no Tilgang control exists on any section of an active or ended card, and the view source reads no memberships / accessEnabled', () => {
  const store = seedE(); const v = mountView(store, syncApply(store)); v.open(athar(store).name);
  for (const s of ['Oversikt', 'Arbeidsforhold', 'Kontrakt & dokumenter', 'Lønn & økonomi']) { v.section(s); assert.ok(!v.buttons().some((b) => /tilgang|^slå (av|på)/i.test(b)), s + ': ' + v.buttons().filter((b) => /tilgang|slå/i.test(b)).join(',')); assert.ok(!/Tilgang:\s*(På|Av)/.test(v.text()), s); }
  assert.ok(!/memberships|accessEnabled|employeeAuthLock/.test(viewSrc), 'view reads no membership authority');
  assert.ok(viewSrc.includes("'Tilgang til Sormena styres separat og må være slått av før arbeidsforholdet avsluttes.'"));
});
await t('L16', '(static) the end card and its confirmation remain gated by canEditEmployment(actor) && status === active; the confirm sends exactly kind endEmployee through the same operation boundary (applyOperation or the core)', () => {
  assert.ok(viewSrc.includes("    if (canEditEmployment(actor) && e.status === 'active') {\n      // AVSLUTT ARBEIDSFORHOLD (ELA-V1a)"));
  assert.ok(viewSrc.includes("applyEnd({ kind: 'endEmployee', ansattId: e.ansattId, endDate: endConfirm.endDate })"));
  assert.ok(viewSrc.includes("const run = typeof applyOperation === 'function' ? applyOperation : applyEmployeeOperation;\n    let res; try { res = run({ store: employeeStore, tenantId, actor, op, now: Date.now(), timezone }); } catch (e) { settle(coreErr(e)); return; }\n    if (res && typeof res.then === 'function') { draw(); res.then(settle, (e) => settle(coreErr(e))); } else settle(res);\n  }"));
  assert.equal((viewSrc.match(/kind: 'endEmployee'/g) || []).length, 1, 'exactly one sender');
});

// ---- corrective pass (SIRRHA-CCODE-SORMENA-ELA-V1A-CORRECTIVE-LOCAL-008) ---------------------------------------------
// A: end date before the REGISTERED canonical start (first terms period's validFrom) is refused before any mutation.
// B: an ended employee's latest open-ended period is DISPLAYED through endedAt — stored terms are never touched.
const coreSrc = fs.readFileSync(new URL('./management-employees-core.mjs', import.meta.url), 'utf8');
const START = '2022-08-01';   // seed: ans-athar first period validFrom (the registered canonical start)
const periodsOf = (v) => v.root.querySelectorAll('.emp-period .rg').map((x) => x.textContent);
await t('L17', 'CORE: an end date BEFORE the registered canonical start is refused (ENDDATE_BEFORE_START) with zero mutation — status, endedAt, audit, terms all untouched; never inferred from legacy opprettet', () => {
  const store = seedE(); assert.equal(athar(store).terms[0].validFrom, START); const before = J(store);
  for (const d of ['2022-07-31', '2021-12-31', '2000-01-01']) { const r = applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: d }); assert.equal(r.ok, false); assert.equal(r.code, 'ENDDATE_BEFORE_START', d); }
  assert.equal(J(store), before); const e = athar(store); assert.equal(e.status, 'active'); assert.equal(e.endedAt, null); assert.equal(e.endedByUid, null); assert.equal(e.endedRecordedAt, null);
});
await t('L18', 'CORE: an end date EQUAL to the registered start is allowed (one-day employment): ended, endedAt = start, audit recorded', () => {
  const store = seedE(); const r = applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: START });
  assert.equal(r.ok, true); const e = athar(store); assert.equal(e.status, 'ended'); assert.equal(e.endedAt, START); assert.equal(e.endedByUid, MGR.uid); assert.equal(e.endedRecordedAt, NOW);
});
await t('L19', 'CORE: an end date AFTER the registered start is allowed (the day after, and a later year)', () => {
  for (const d of ['2022-08-02', END]) { const store = seedE(); const r = applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: d }); assert.equal(r.ok, true, d); assert.equal(athar(store).endedAt, d); }
});
await t('L20', 'CORE: the start truth is the FIRST period\'s validFrom even after later periods were appended (same truth as registeredStartDateOf / first registration); the refusal is ordered before any mutation in source', () => {
  const store = seedE(); const a = applyE(store, { kind: 'appendTerms', ansattId: 'ans-athar', terms: { validFrom: '2026-01-01', percentage: 80 } }); assert.equal(a.ok, true);
  assert.equal(athar(store).terms.length, 2); const before = J(store);
  const r = applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: '2022-07-31' }); assert.equal(r.code, 'ENDDATE_BEFORE_START'); assert.equal(J(store), before);
  const mid = applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: '2024-06-30' }); assert.equal(mid.code, 'ENDDATE_BEFORE_LATER_PERIOD', 'integrity (011): after the registered start but before a later period is refused'); assert.equal(J(store), before);
  const i = coreSrc.indexOf("if (op.endDate < start) return { ok: false, code: 'ENDDATE_BEFORE_START' };"); const m = coreSrc.indexOf("emp.status = 'ended'; emp.endedAt = op.endDate;");
  assert.ok(i > 0 && m > i, 'refusal precedes the mutation'); assert.ok(coreSrc.includes('const start = registeredStartDateOf(emp);')); const blk = coreSrc.slice(coreSrc.indexOf("if (op.kind === 'endEmployee')"), coreSrc.indexOf("if (op.kind === 'addDocument')")).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); assert.ok(!/opprettet/.test(blk), 'never legacy opprettet (code, comments excluded)');
});
await t('L21', 'ADAPTERS: end before the registered start is refused at the production boundary (CORE_REFUSED / ENDDATE_BEFORE_START) with ZERO writes; equal-to-start then persists exactly one update', async () => {
  const { F, M, others } = world(); const snap = J(Array.from(F.docs.entries())); const o0 = others();
  assert.equal(M.employees.store()[T][REG].terms[0].validFrom, '2026-02-02');
  await assert.rejects(M.employees.apply({ kind: 'endEmployee', ansattId: REG, endDate: '2026-02-01' }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED && e.coreResult && e.coreResult.code === 'ENDDATE_BEFORE_START');
  assert.equal(J(Array.from(F.docs.entries())), snap); assert.equal(F.writes.length, 0); assert.equal(M.employees.store()[T][REG].status, 'active');
  const r = await M.employees.apply({ kind: 'endEmployee', ansattId: REG, endDate: '2026-02-02' }); assert.equal(r.ok, true);
  assert.equal(F.writes.length, 1); const e = F.docs.get(P('ansatte', REG))[E360_KEY]; assert.equal(e.status, 'ended'); assert.equal(e.endedAt, '2026-02-02'); assert.equal(others(), o0);
});
await t('L22', 'VIEW: a date before the registered start never opens the confirmation — the first press shows the mapped refusal and nothing changes; a boundary refusal with that code keeps the confirmation open with the same text', async () => {
  const store = seedE(); const calls = []; const v = mountView(store, (a) => { calls.push(a.op.kind); return syncApply(store)(a); }); const before = J(store);
  v.open(athar(store).name); v.section('Arbeidsforhold');
  v.endCard().querySelector('input[type=date]').value = '2022-07-31'; v.btnByText('Registrer som sluttet').click();
  assert.equal(v.confirmBox(), null, 'no confirmation for an impossible date'); assert.ok(v.text().includes('Sluttdatoen kan ikke være før registrert startdato.'), v.text().slice(0, 200));
  assert.deepEqual(calls, []); assert.equal(J(store), before); assert.ok(v.endCard(), 'end card still there');
  v.endCard().querySelector('input[type=date]').value = START; v.btnByText('Registrer som sluttet').click();
  assert.ok(v.confirmBox(), 'equal-to-start opens the confirmation'); assert.ok(!v.text().includes('Sluttdatoen kan ikke være'), 'stale refusal cleared');
  v.btnByText('Ja, registrer som sluttet').click(); assert.deepEqual(calls, ['endEmployee']); assert.equal(athar(store).endedAt, START);
  const store2 = seedE(); const v2 = mountView(store2, () => Promise.resolve({ ok: false, code: 'ENDDATE_BEFORE_START' }));
  v2.open(athar(store2).name); v2.section('Arbeidsforhold'); v2.endCard().querySelector('input[type=date]').value = END; v2.btnByText('Registrer som sluttet').click(); v2.btnByText('Ja, registrer som sluttet').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(v2.confirmBox(), 'stays open'); assert.ok(v2.text().includes('Sluttdatoen kan ikke være før registrert startdato.')); assert.equal(athar(store2).status, 'active');
});
await t('L23', 'VIEW: after the end, Perioder shows the latest otherwise-open period as "<validFrom> – <endedAt>" (no "løpende"); an earlier period keeps its derived range; stored terms and derived validTo are byte-identical before/after', () => {
  const store = seedE(); applyE(store, { kind: 'appendTerms', ansattId: 'ans-athar', terms: { validFrom: '2026-01-01', percentage: 80 } });
  const v = mountView(store, syncApply(store)); v.open(athar(store).name); v.section('Arbeidsforhold');
  assert.deepEqual(periodsOf(v), ['1. januar 2026 – løpende', '1. august 2022 – 1. januar 2026'], 'active: latest period is open');
  const termsBefore = J(athar(store).terms); const rangesBefore = J(termsWithRanges(athar(store)));
  v.endCard().querySelector('input[type=date]').value = END; v.btnByText('Registrer som sluttet').click(); v.btnByText('Ja, registrer som sluttet').click();
  assert.equal(athar(store).status, 'ended');
  assert.deepEqual(periodsOf(v), ['1. januar 2026 – 30. september 2026', '1. august 2022 – 1. januar 2026'], 'ended: latest period displays through endedAt');
  assert.ok(!v.text().includes('løpende'), 'no "løpende" anywhere on an ended card');
  assert.equal(J(athar(store).terms), termsBefore, 'terms not mutated for display'); assert.equal(J(termsWithRanges(athar(store))), rangesBefore, 'derived validTo of the latest period is still null');
  assert.equal(termsWithRanges(athar(store))[0].validTo, null);
  // a single-period employee reads the same way
  const s1 = seedE(); applyE(s1, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: END }); const v1 = mountView(s1, syncApply(s1)); v1.open(athar(s1).name); v1.section('Arbeidsforhold');
  assert.deepEqual(periodsOf(v1), ['1. august 2022 – 30. september 2026']);
});
await t('L24', 'VIEW: an ended registered record WITHOUT a stored end date manufactures nothing — Perioder reads "<validFrom> – sluttet – dato ikke registrert", header/Status keep the neutral fallback; an ACTIVE record still reads "løpende"', () => {
  const store = seedE(); const e = athar(store); e.status = 'ended'; e.endedAt = null;   // defensive shape (the core always stores endedAt)
  const v = mountView(store, syncApply(store)); v.open(e.name); v.section('Arbeidsforhold');
  assert.deepEqual(periodsOf(v), ['1. august 2022 – sluttet – dato ikke registrert']); assert.ok(!v.text().includes('løpende'));
  assert.ok(v.header().includes('Sluttet – dato ikke registrert')); v.section('Oversikt'); assert.equal(v.facts().Status, 'Sluttet – dato ikke registrert'); assert.ok(!('Avslutning registrert' in v.facts()));
  const s2 = seedE(); const v2 = mountView(s2, syncApply(s2)); v2.open(athar(s2).name); v2.section('Arbeidsforhold'); assert.deepEqual(periodsOf(v2), ['1. august 2022 – løpende']);
});
await t('L25', '(static) exactly one "løpende" renderer remains, guarded by status/endedAt; the view pre-check and the core law use the same first-period start truth; no validTo is written anywhere in core/view/adapters', () => {
  assert.equal((viewSrc.match(/'løpende'/g) || []).length, 1, 'one quoted renderer literal');
  assert.ok(viewSrc.includes("const endTxt = r.validTo ? fmtDate(r.validTo) : (e.status === 'ended' ? (e.endedAt ? fmtDate(e.endedAt) : 'sluttet – dato ikke registrert') : 'løpende');"));
  assert.ok(viewSrc.includes("if (v < startDateOf(e)) { errMsg = opError('ENDDATE_BEFORE_START'); draw(); return; }"));
  assert.ok(viewSrc.includes("if (code === 'ENDDATE_BEFORE_START') return 'Sluttdatoen kan ikke være før registrert startdato.';"));
  const adSrc = fs.readFileSync(new URL('./management-production-adapters.mjs', import.meta.url), 'utf8');
  for (const [n, src] of [['core', coreSrc], ['view', viewSrc], ['adapters', adSrc]]) assert.ok(!/\.validTo\s*=[^=]/.test(src), n + ' never assigns validTo');
});

// ---- chronology integrity (SIRRHA-CCODE-SORMENA-ELA-V1A-INTEGRITY-LOCAL-011) ------------------------------------------
// The end date must be on/after EVERY canonical terms period's validFrom (= the latest period's start). Refused, never
// rewritten: terms history is not auto-closed, deleted or moved to make an end fit.
const LATER_MSG = 'Sluttdatoen kan ikke være før en senere registrert arbeidsperiode. Velg en sluttdato på eller etter siste periodes startdato.';
const withLater = (validFroms) => { const store = seedE(); for (const vf of validFroms) { const a = applyE(store, { kind: 'appendTerms', ansattId: 'ans-athar', terms: { validFrom: vf, percentage: 80 } }); assert.equal(a.ok, true, vf); } return store; };
await t('L26', 'CORE: multi-period employee — an end date after the registered start but BEFORE a later period\'s validFrom is refused (ENDDATE_BEFORE_LATER_PERIOD) with zero mutation; holds for two and three periods and for a date equal to the FIRST start', () => {
  const s2 = withLater(['2026-08-01']); assert.deepEqual(athar(s2).terms.map((t) => t.validFrom), [START, '2026-08-01']); const b2 = J(s2);
  for (const d of ['2026-06-01', '2026-07-31', START, '2024-01-01']) { const r = applyE(s2, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: d }); assert.equal(r.ok, false, d); assert.equal(r.code, 'ENDDATE_BEFORE_LATER_PERIOD', d); }
  assert.equal(J(s2), b2); const e = athar(s2); assert.equal(e.status, 'active'); assert.equal(e.endedAt, null); assert.equal(e.endedByUid, null); assert.equal(e.endedRecordedAt, null); assert.equal(e.terms.length, 2);
  const s3 = withLater(['2024-01-01', '2026-08-01']); const b3 = J(s3);
  for (const d of ['2023-06-01', '2025-01-01', '2026-07-31']) assert.equal(applyE(s3, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: d }).code, 'ENDDATE_BEFORE_LATER_PERIOD', d);
  assert.equal(applyE(s3, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: '2022-07-31' }).code, 'ENDDATE_BEFORE_START', 'before the registered start keeps its own code');
  assert.equal(J(s3), b3);
});
await t('L27', 'CORE: an end date EQUAL to the latest period\'s validFrom is allowed — ended, endedAt exact, audit recorded; the two stored periods are byte-identical and the latest derived validTo stays null', () => {
  const store = withLater(['2026-08-01']); const termsBefore = J(athar(store).terms);
  const r = applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: '2026-08-01' }); assert.equal(r.ok, true);
  const e = athar(store); assert.equal(e.status, 'ended'); assert.equal(e.endedAt, '2026-08-01'); assert.equal(e.endedByUid, MGR.uid); assert.equal(e.endedRecordedAt, NOW);
  assert.equal(J(e.terms), termsBefore); assert.equal(e.terms.length, 2); assert.equal(termsWithRanges(e)[0].validTo, null); assert.equal(termsWithRanges(e)[0].validFrom, '2026-08-01');
});
await t('L28', 'CORE: an end date AFTER the latest period\'s validFrom is allowed (day after, and later); terms untouched', () => {
  for (const d of ['2026-08-02', END]) { const store = withLater(['2026-08-01']); const termsBefore = J(athar(store).terms); const r = applyE(store, { kind: 'endEmployee', ansattId: 'ans-athar', endDate: d }); assert.equal(r.ok, true, d); assert.equal(athar(store).endedAt, d); assert.equal(J(athar(store).terms), termsBefore); }
});
await t('L29', 'ADAPTERS: with a later period persisted, an end before it is refused at the production boundary (CORE_REFUSED / ENDDATE_BEFORE_LATER_PERIOD) with ZERO writes — ansatte (e360 terms/audit/contracts/documents + legacy fields), attendance, attendanceExceptions, employeeSelf and shifts byte-identical; equal-to-latest then persists one update', async () => {
  const { F, M, others } = world();
  F.seed(P('shifts', 'sh-9'), { shiftId: 'sh-9', ansattId: REG, workDate: '2026-10-20', status: 'assigned', revision: 1 });
  const a = await M.employees.apply({ kind: 'appendTerms', ansattId: REG, terms: { validFrom: '2026-08-01', percentage: 60 } }); assert.equal(a.ok, true);
  assert.deepEqual(M.employees.store()[T][REG].terms.map((t) => t.validFrom), ['2026-02-02', '2026-08-01']);
  const snap = J(Array.from(F.docs.entries())); const n = F.writes.length; const o0 = others();
  for (const d of ['2026-06-01', '2026-02-02', '2026-07-31']) await assert.rejects(M.employees.apply({ kind: 'endEmployee', ansattId: REG, endDate: d }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED && e.coreResult && e.coreResult.code === 'ENDDATE_BEFORE_LATER_PERIOD', d);
  assert.equal(J(Array.from(F.docs.entries())), snap, 'nothing written anywhere'); assert.equal(F.writes.length, n); assert.equal(others(), o0);
  assert.equal(J(F.docs.get(P('shifts', 'sh-9'))), J({ shiftId: 'sh-9', ansattId: REG, workDate: '2026-10-20', status: 'assigned', revision: 1 }));
  const rec0 = M.employees.store()[T][REG]; assert.equal(rec0.status, 'active'); assert.equal(rec0.terms.length, 2);
  const r = await M.employees.apply({ kind: 'endEmployee', ansattId: REG, endDate: '2026-08-01' }); assert.equal(r.ok, true);
  assert.equal(F.writes.length, n + 1); const e = F.docs.get(P('ansatte', REG))[E360_KEY]; assert.equal(e.status, 'ended'); assert.equal(e.endedAt, '2026-08-01'); assert.equal(e.terms.length, 2); assert.equal(e.lastOp, 'endEmployee');
});
await t('L30', 'VIEW: with a later period, a date before it never opens the confirmation (first press shows the period refusal, nothing sent, store unchanged); equal-to-latest opens it and completes; Perioder then reads through endedAt; a boundary refusal with that code keeps the confirmation open with the same text', async () => {
  const store = withLater(['2026-08-01']); const calls = []; const v = mountView(store, (a) => { calls.push(a.op.kind); return syncApply(store)(a); }); const before = J(store);
  v.open(athar(store).name); v.section('Arbeidsforhold');
  assert.deepEqual(periodsOf(v), ['1. august 2026 – løpende', '1. august 2022 – 1. august 2026']);
  v.endCard().querySelector('input[type=date]').value = '2026-06-01'; v.btnByText('Registrer som sluttet').click();
  assert.equal(v.confirmBox(), null, 'no confirmation'); assert.ok(v.text().includes(LATER_MSG), v.text().slice(0, 300)); assert.deepEqual(calls, []); assert.equal(J(store), before); assert.ok(v.endCard());
  v.endCard().querySelector('input[type=date]').value = '2026-08-01'; v.btnByText('Registrer som sluttet').click();
  assert.ok(v.confirmBox(), 'equal-to-latest opens the confirmation'); assert.ok(!v.text().includes(LATER_MSG), 'stale refusal cleared');
  v.btnByText('Ja, registrer som sluttet').click(); assert.deepEqual(calls, ['endEmployee']); assert.equal(athar(store).endedAt, '2026-08-01');
  assert.deepEqual(periodsOf(v), ['1. august 2026 – 1. august 2026', '1. august 2022 – 1. august 2026']); assert.ok(!v.text().includes('løpende'));
  const s2 = withLater(['2026-08-01']); const v2 = mountView(s2, () => Promise.resolve({ ok: false, code: 'ENDDATE_BEFORE_LATER_PERIOD' }));
  v2.open(athar(s2).name); v2.section('Arbeidsforhold'); v2.endCard().querySelector('input[type=date]').value = END; v2.btnByText('Registrer som sluttet').click(); v2.btnByText('Ja, registrer som sluttet').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(v2.confirmBox(), 'stays open'); assert.ok(v2.text().includes(LATER_MSG)); assert.equal(athar(s2).status, 'active');
});
await t('L31', '(static) the integrity guard is ordered before the mutation and compares canonical terms only: the endEmployee block never reads opprettet, never assigns/splices/filters terms, never writes validTo; the view pre-check and refusal text are pinned', () => {
  const blk = coreSrc.slice(coreSrc.indexOf("if (op.kind === 'endEmployee')"), coreSrc.indexOf("if (op.kind === 'addDocument')"));
  const code = blk.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const g = code.indexOf("if (emp.terms.some((t) => op.endDate < t.validFrom)) return { ok: false, code: 'ENDDATE_BEFORE_LATER_PERIOD' };"); const m = code.indexOf("emp.status = 'ended'; emp.endedAt = op.endDate;");
  assert.ok(g > 0 && m > g, 'guard precedes the mutation');
  assert.ok(!/opprettet/.test(code)); assert.ok(!/emp\.terms\s*=|\.splice\(|\.pop\(|\.shift\(|validTo|\.filter\(/.test(code), 'terms history is never rewritten in endEmployee');
  assert.ok(viewSrc.includes("if (e.terms.some((t) => v < t.validFrom)) { errMsg = opError('ENDDATE_BEFORE_LATER_PERIOD'); draw(); return; }"));
  assert.ok(viewSrc.includes("if (code === 'ENDDATE_BEFORE_LATER_PERIOD') return '" + LATER_MSG + "';"));
});

console.log(lines.join('\n'));
console.log('MANAGEMENT_ELA_V1A_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
