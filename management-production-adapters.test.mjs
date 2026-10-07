// management-production-adapters.test.mjs — unit battery for the Ledelse production adapters (node built-ins only).
// Proves, against a FAKE injected datastore: canonical ansatte document is the ONE employee home (read normalisation of
// legacy-only and e360 documents; every Employee 360 / contract operation is ONE transaction on that same document with
// legacy projections synced), Ny ansatt = ONE auto-id document, bounded shifts + attendance reads with re-windowing,
// attendance writes only through the accepted commit, tenant contract profile document, employeeSelf projection writer,
// listener accounting, generation/dispose refusals, and that NO write ever addresses legacy `vakter`.
// Run: node management-production-adapters.test.mjs
import assert from 'node:assert/strict';
import { createManagementAdapters, normalizeAnsatt, ansattWriteFor, legacySkeleton, ansattePath, contractProfilePath, E360_KEY } from './management-production-adapters.mjs';
import { ADAPTER_ERROR, s4Path } from './employee-production-adapters.mjs';
import { ETR2A_POLICY as POLICY, managerManualEntry, tenantLocalHMToUtcMs, tenantWorkDate } from './employee-shell-core.mjs';
import { FOUR_SEASON_CONTRACT_PROFILE } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }

const T = 'four-season-as', TZ = POLICY.timezone;
const today = tenantWorkDate(Date.now(), TZ);
const ADM = { uid: 'uid-admin-1', tenantId: T, accessRole: 'admin', ansattId: 'Ij7AmknF9ZDAdWgwQGJi', accessEnabled: true };
const LEG = 'Kx9mQ2vT7pLa4RcW1nZb';
const RANGE = { from: '2026-09-01', to: '2026-10-31' };

function makeFakeFs() {
  const docs = new Map(); const listeners = []; const writes = []; const state = { unsubscribed: 0, ids: 0 };
  const ST = { __serverTimestamp: true };
  const colOf = (p) => p.split('/').slice(0, -1).join('/'); const idOf = (p) => p.split('/').pop();
  const matches = (spec, p, d) => {
    if (spec.doc) return p === spec.doc;
    if (colOf(p) !== spec.col) return false;
    for (const [f, op, v] of spec.where || []) { const val = d[f] === undefined ? null : d[f]; if (op === '==') { if (val !== v) return false; } else if (op === '>=') { if (!(val >= v)) return false; } else if (op === '<=') { if (!(val <= v)) return false; } else throw new Error('op'); }
    return true;
  };
  const docsFor = (spec) => { if (spec.doc) return [{ id: idOf(spec.doc), exists: docs.has(spec.doc), data: docs.get(spec.doc) }]; const out = []; for (const [p, d] of docs) if (matches(spec, p, d)) out.push({ id: idOf(p), exists: true, data: d }); return out; };
  const apply = (w) => { for (const [kind, p, d] of w) { writes.push(p); if (kind === 'set') docs.set(p, JSON.parse(JSON.stringify(d))); else { if (!docs.has(p)) throw Object.assign(new Error('not-found'), { code: 'not-found' }); docs.set(p, Object.assign({}, docs.get(p), JSON.parse(JSON.stringify(d)))); } } };
  const api = {
    doc: (p) => ({ path: p }), serverTimestamp: () => ST,
    newId: (col) => { state.ids += 1; state.lastCol = col; return 'AuToId' + String(state.ids).padStart(14, '0'); },
    listen: (spec, onDocs, onErr) => { const l = { spec, onDocs, onErr, active: true }; listeners.push(l); return () => { l.active = false; state.unsubscribed += 1; }; },
    runTransaction: async (fn) => { const w = []; const tx = { get: async (ref) => ({ exists: docs.has(ref.path), data: docs.get(ref.path) }), set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]) }; const out = await fn(tx); apply(w); return out; },
    batch: () => { const w = []; return { set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]), commit: async () => { apply(w); } }; },
  };
  const emit = () => { for (const l of listeners) if (l.active) l.onDocs(docsFor(l.spec)); };
  const seed = (p, d) => docs.set(p, JSON.parse(JSON.stringify(d)));
  // host-mirror stand-in: the canonical ansatte documents as LOCAL.ansatte holds them ({ id, ...data })
  const readAnsatte = () => { const out = []; for (const [p, d] of docs) if (colOf(p) === 'tenants/' + T + '/ansatte') out.push(Object.assign({ id: idOf(p) }, d)); return out; };
  return { api, docs, listeners, writes, state, emit, seed, readAnsatte, ST };
}
const legacyDoc = (over) => Object.assign({ navn: 'Mr Testperson', stilling: 'butikkmedarbeider', timelonn: 210, adresse: 'Storgata 1, 2815 Gjøvik', epost: 'mr@example.test', bankkonto: '1234.56.78903', personnummer: '01019012345', notater: 'privat', aktiv: true, opprettet: '2026-09-01T08:00:00.000Z' }, over || {});
const build = (F, extra) => createManagementAdapters(Object.assign({ fs: F.api, tenantId: T, membership: ADM, range: RANGE, readAnsatte: F.readAnsatte, defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: POLICY }, extra || {}));
const onlyAllowed = (F) => F.writes.every((p) => /^tenants\/four-season-as\/(ansatte|shifts|attendance|employeeSelf|_meta)\//.test(p));

const REG_START = '2026-06-01';
const REG_TERMS = () => ({ role: 'butikkmedarbeider', employmentForm: 'fast', employmentType: 'fast', percentage: 100, compensation: { model: 'timelonn', hourlyRate: 210 }, expectedWeeklyHours: 37.5, workplace: '4Seasons ferske varer', noticePeriod: '1 måned' });
// Initial-registration hardening: an old-register document has no stored baseline, so every ordinary operation is refused
// with zero writes until registerInitialEmployment has run. The ordinary-operation tests below register first.
const refusedBeforeRegistration = async (F, p) => { const n = F.writes.length; const before = JSON.stringify(Array.from(F.docs.entries())); await assert.rejects(p, (e) => e.code === ADAPTER_ERROR.CORE_REFUSED && /INITIAL_REGISTRATION_REQUIRED/.test(e.message) && e.coreResult && e.coreResult.code === 'INITIAL_REGISTRATION_REQUIRED'); assert.equal(F.writes.length, n, 'zero writes on refusal'); assert.equal(JSON.stringify(Array.from(F.docs.entries())), before, 'no document changed'); };
const registerFirst = (M, id) => M.employees.apply({ kind: 'registerInitialEmployment', ansattId: id, startDate: REG_START, terms: REG_TERMS() });

await t('M01', 'factory: admin-only membership, range, newId + readAnsatte capability required (fail closed)', () => {
  const F = makeFakeFs();
  assert.throws(() => build(F, { membership: { ...ADM, accessRole: 'employee' } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => build(F, { membership: { ...ADM, accessEnabled: false } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => build(F, { membership: { ...ADM, tenantId: 'other' } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => build(F, { range: { from: '2026-10-31', to: '2026-09-01' } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  assert.throws(() => build(F, { fs: Object.assign({}, F.api, { newId: undefined }) }), (e) => e.code === ADAPTER_ERROR.CAPABILITY_MISSING);
  assert.throws(() => build(F, { readAnsatte: null }), (e) => e.code === ADAPTER_ERROR.CAPABILITY_MISSING);
  assert.throws(() => ansattePath(T, 'bad/id'), (e) => e.code === ADAPTER_ERROR.PATH_FORBIDDEN);
  assert.throws(() => s4Path(T, 'vakter', 'x'), (e) => e.code === ADAPTER_ERROR.PATH_FORBIDDEN);
  const M = build(F); assert.equal(M.identity.accessRole, 'admin'); assert.equal(M.identity.ansattId, ADM.ansattId); assert.equal(M.listenerCount(), 0);
});
await t('M02', 'normalizeAnsatt: a legacy-only document yields a complete Employee 360 record (role/rate/start from legacy current fields, contact from epost/adresse, status from aktiv; sensitive legacy fields never copied)', () => {
  const r = normalizeAnsatt(LEG, legacyDoc());
  assert.equal(r.ansattId, LEG); assert.equal(r.name, 'Mr Testperson'); assert.equal(r.status, 'active');
  assert.equal(r.terms.length, 1); assert.equal(r.terms[0].validFrom, '2026-09-01'); assert.equal(r.terms[0].role, 'butikkmedarbeider'); assert.deepEqual(r.terms[0].compensation, { model: 'timelonn', hourlyRate: 210 });
  assert.equal(r.contact.email, 'mr@example.test'); assert.equal(r.contact.address.legacyText, 'Storgata 1, 2815 Gjøvik'); assert.equal(r.contact.address.city, ''); assert.equal(r.contact.birthDate, null);   // accepted core law: legacy free text is never parsed into a structured address
  assert.equal(r.legacy.hasE360, false); assert.ok(!('personnummer' in r) && !('bankkonto' in r) && !JSON.stringify(r).includes('01019012345'));
  const ended = normalizeAnsatt('x', legacyDoc({ aktiv: false, timelonn: 0, stilling: '' }));
  assert.equal(ended.status, 'ended'); assert.equal(ended.terms[0].role, null); assert.equal(ended.terms[0].compensation, null);
  const bare = normalizeAnsatt('y', {}); assert.equal(bare.name, '(uten navn)'); assert.equal(bare.terms.length, 1);
});
await t('M03', 'normalizeAnsatt: an e360 block is authoritative for Employee 360 facts; legacy fields still name the person', () => {
  const d = legacyDoc({ [E360_KEY]: { status: 'active', startDate: '2026-02-01', contact: { email: null, phone: '99999999', address: null, birthDate: '1990-05-05' }, terms: [{ validFrom: '2026-02-01', role: 'kasse', employmentType: 'deltid', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 199 } }], documents: [{ documentId: 'd1', category: 'kontrakt' }], contractVersions: [], rev: 3 } });
  const r = normalizeAnsatt(LEG, d);
  assert.equal(r.terms[0].role, 'kasse'); assert.equal(r.terms[0].employmentType, 'deltid'); assert.equal(r.terms[0].percentage, 50); assert.equal(r.terms[0].workplace, null);
  assert.equal(r.contact.phone, '99999999'); assert.equal(r.contact.email, null); assert.equal(r.contact.birthDate, '1990-05-05'); assert.equal(r.documents.length, 1); assert.equal(r.legacy.hasE360, true);
});
await t('M04', 'start: employee store rebuilt from the host mirror (no second listener for ansatte); THREE bounded listeners (shifts + attendance + attendance exceptions) with the SAME workDate range; people() = active only; dispose -> 0', () => {
  const F = makeFakeFs(); F.seed(ansattePath(T, LEG), legacyDoc()); F.seed(ansattePath(T, 'InAkT1vE0000000000ab'), legacyDoc({ navn: 'Inaktiv', aktiv: false })); F.seed(ansattePath(T, 'NoAktivField00000000'), { navn: 'Uten Aktivfelt', stilling: '' });
  const M = build(F); let changes = 0; M.onChange(() => { changes += 1; });
  M.start(); M.start();
  assert.equal(M.listenerCount(), 3); assert.equal(F.listeners.length, 3);
  assert.deepEqual(F.listeners.map((l) => l.spec.col).sort(), [s4Path(T, 'attendance'), s4Path(T, 'attendanceExceptions'), s4Path(T, 'shifts')]);
  for (const l of F.listeners) assert.deepEqual(l.spec.where, [['workDate', '>=', RANGE.from], ['workDate', '<=', RANGE.to]]);
  assert.ok(!F.listeners.some((l) => /ansatte/.test(l.spec.col)), 'no ansatte listener');
  const st = M.employees.store()[T]; assert.deepEqual(Object.keys(st).sort(), ['InAkT1vE0000000000ab', 'Kx9mQ2vT7pLa4RcW1nZb', 'NoAktivField00000000']);
  assert.deepEqual(M.employees.people().map((p) => p.name).sort(), ['Mr Testperson', 'Uten Aktivfelt']);
  assert.ok(changes >= 1);
  M.dispose(); assert.equal(M.listenerCount(), 0); assert.equal(F.state.unsubscribed, 3); assert.deepEqual(M.employees.store()[T], {});
});
await t('M05', 'updateContact: REFUSED with zero writes before first registration; after it ONE transaction on the canonical ansatte document — e360 block (rev 2) + legacy epost/adresse synced; untouched legacy fields (bankkonto, personnummer, notater, navn) not rewritten; store reflects the persisted state', async () => {
  const F = makeFakeFs(); F.seed(ansattePath(T, LEG), legacyDoc()); const M = build(F); M.start();
  const contactOp = () => ({ kind: 'updateContact', ansattId: LEG, contact: { email: 'ny@example.test', phone: '40000000', address: { street: 'Nyveien 2', postalCode: '2816', city: 'Gjøvik' } } });
  await refusedBeforeRegistration(F, M.employees.apply(contactOp()));
  assert.ok(!(E360_KEY in F.docs.get(ansattePath(T, LEG))), 'no stored baseline was created by the refused contact update');
  await registerFirst(M, LEG);
  const r = await M.employees.apply(contactOp());
  assert.equal(r.ok, true); assert.equal(r.ansattId, LEG);
  assert.deepEqual(F.writes, [ansattePath(T, LEG), ansattePath(T, LEG)]);
  const d = F.docs.get(ansattePath(T, LEG));
  assert.equal(d[E360_KEY].startDate, REG_START); assert.equal(d[E360_KEY].terms[0].validFrom, REG_START);
  assert.equal(d[E360_KEY].rev, 2); assert.equal(d[E360_KEY].contact.phone, '40000000'); assert.equal(d[E360_KEY].lastOp, 'updateContact');
  assert.equal(d.epost, 'ny@example.test'); assert.equal(d.adresse, 'Nyveien 2, 2816 Gjøvik');
  assert.equal(d.bankkonto, '1234.56.78903'); assert.equal(d.personnummer, '01019012345'); assert.equal(d.notater, 'privat'); assert.equal(d.navn, 'Mr Testperson'); assert.equal(d.stilling, 'butikkmedarbeider'); assert.equal(d.timelonn, 210);
  const rec = M.employees.store()[T][LEG]; assert.equal(rec.contact.phone, '40000000'); assert.equal(rec.legacy.hasE360, true);
  await assert.rejects(M.employees.apply({ kind: 'updateContact', ansattId: 'ghost0000000000000000', contact: { phone: '1' } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED && /EMPLOYEE_UNKNOWN/.test(e.message));
  await assert.rejects(M.employees.apply({ kind: 'updateContact', ansattId: LEG, contact: { personnummer: 'x' } }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED && /CONTACT_FIELD_NOT_ALLOWED/.test(e.message));
});
await t('M06', 'createEmployee (Ny ansatt): exactly ONE new document under tenants/{T}/ansatte with a Firestore auto-id (never the core slug), full legacy skeleton + e360; appears in the store and in people()', async () => {
  const F = makeFakeFs(); const M = build(F); M.start();
  const r = await M.employees.apply({ kind: 'createEmployee', name: 'Ny Person', startDate: '2026-10-01', role: 'kasse', contact: { address: { street: 'Gata 3', postalCode: '2815', city: 'Gjøvik' } } });
  assert.equal(r.ok, true); assert.match(r.ansattId, /^AuToId\d{14}$/); assert.equal(r.employee.ansattId, r.ansattId);
  assert.equal(F.state.lastCol, ansattePath(T)); assert.deepEqual(F.writes, [ansattePath(T, r.ansattId)]);
  const d = F.docs.get(ansattePath(T, r.ansattId));
  for (const k of ['navn', 'stilling', 'timelonn', 'adresse', 'epost', 'bankkonto', 'personnummer', 'notater', 'aktiv', 'opprettet']) assert.ok(k in d, 'legacy field ' + k);
  assert.equal(d.navn, 'Ny Person'); assert.equal(d.stilling, 'kasse'); assert.equal(d.aktiv, true); assert.equal(d.timelonn, 0); assert.equal(d.adresse, 'Gata 3, 2815 Gjøvik'); assert.equal(d.bankkonto, ''); assert.equal(d.personnummer, '');
  assert.equal(d[E360_KEY].rev, 1); assert.equal(d[E360_KEY].terms[0].validFrom, '2026-10-01'); assert.equal(d[E360_KEY].startDate, '2026-10-01');
  assert.ok(!Array.from(F.docs.keys()).some((p) => /ans-ny-person/.test(p)), 'no slug-id document');
  assert.equal(Array.from(F.docs.keys()).filter((p) => p.startsWith(ansattePath(T) + '/')).length, 1);
  assert.ok(M.employees.store()[T][r.ansattId]); assert.ok(M.employees.people().some((p) => p.ansattId === r.ansattId && p.roleKey === 'kasse'));
  await assert.rejects(M.employees.apply({ kind: 'createEmployee', name: '', startDate: '2026-10-01', role: 'kasse' }), (e) => /NAME_REQUIRED/.test(e.message));
});
await t('M07', 'appendTerms / endEmployee: both REFUSED with zero writes before first registration; after it terms history persists in e360 while the legacy current projection (stilling, timelonn, aktiv) follows the accepted current terms', async () => {
  const F = makeFakeFs(); F.seed(ansattePath(T, LEG), legacyDoc()); const M = build(F); M.start();
  const appendOp = () => ({ kind: 'appendTerms', ansattId: LEG, terms: { validFrom: '2026-09-15', role: 'skiftleder', compensation: { model: 'timelonn', hourlyRate: 240 }, employmentType: 'fast', percentage: 100 } });
  await refusedBeforeRegistration(F, M.employees.apply(appendOp()));
  await refusedBeforeRegistration(F, M.employees.apply({ kind: 'endEmployee', ansattId: LEG, endDate: '2026-10-31' }));
  assert.equal(F.docs.get(ansattePath(T, LEG)).aktiv, true); assert.ok(!(E360_KEY in F.docs.get(ansattePath(T, LEG))));
  await registerFirst(M, LEG);
  await M.employees.apply(appendOp());
  let d = F.docs.get(ansattePath(T, LEG));
  assert.equal(d[E360_KEY].terms.length, 2); assert.equal(d[E360_KEY].terms[0].validFrom, REG_START); assert.equal(d.stilling, 'skiftleder'); assert.equal(d.timelonn, 240); assert.equal(d.aktiv, true); assert.equal(d[E360_KEY].rev, 2);
  const r2 = await M.employees.apply({ kind: 'endEmployee', ansattId: LEG, endDate: '2026-10-31' });
  d = F.docs.get(ansattePath(T, LEG));
  assert.equal(r2.ok, true); assert.equal(d.aktiv, false); assert.equal(d[E360_KEY].status, 'ended'); assert.equal(d[E360_KEY].endedAt, '2026-10-31'); assert.equal(d[E360_KEY].rev, 3);
  assert.equal(M.employees.store()[T][LEG].status, 'ended'); assert.ok(!M.employees.people().some((p) => p.ansattId === LEG));
  assert.ok(F.writes.every((p) => p === ansattePath(T, LEG)));
});
await t('M08', 'applyContract: startDraft / freezeVersion REFUSED with zero writes before first registration; after it startDraft persists a contract version in e360 on the same document; freezeVersion NOT_READY rejects with the core result (missing facts) and writes nothing', async () => {
  const F = makeFakeFs(); F.seed(ansattePath(T, LEG), legacyDoc()); const M = build(F); M.start();
  const profile = JSON.parse(JSON.stringify(FOUR_SEASON_CONTRACT_PROFILE));
  await refusedBeforeRegistration(F, M.employees.applyContract({ kind: 'startDraft', ansattId: LEG }, profile, { onDate: today }));
  await refusedBeforeRegistration(F, M.employees.applyContract({ kind: 'freezeVersion', ansattId: LEG }, profile, { onDate: today }));
  await registerFirst(M, LEG);
  const r = await M.employees.applyContract({ kind: 'startDraft', ansattId: LEG }, profile, { onDate: today });
  assert.equal(r.ok, true); assert.equal(r.version.status, 'utkast');
  const d = F.docs.get(ansattePath(T, LEG)); assert.equal(d[E360_KEY].contractVersions.length, 1); assert.equal(d[E360_KEY].contractVersions[0].contractVersionId, 'kv-' + LEG + '-1');
  const n = F.writes.length;
  await assert.rejects(M.employees.applyContract({ kind: 'freezeVersion', ansattId: LEG }, profile, { onDate: today }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED && e.coreResult && e.coreResult.code === 'NOT_READY' && Array.isArray(e.coreResult.missing) && e.coreResult.missing.length > 0);
  assert.equal(F.writes.length, n, 'no write on refusal');
  assert.equal(M.employees.store()[T][LEG].contractVersions.length, 1);
});
await t('M09', 'attendance: bounded management-wide read mirrors in-range records for every employee; set() is refused (production writes only via commit); commit of an accepted manager manual entry writes attendance + event paths only', async () => {
  const F = makeFakeFs(); F.seed(ansattePath(T, LEG), legacyDoc());
  F.seed(s4Path(T, 'attendance', 'a-in'), { attendanceId: 'a-in', ansattId: 'someone-else', workDate: '2026-09-10', revision: 1, status: 'attested', serverCreatedAt: F.ST, serverUpdatedAt: F.ST });
  F.seed(s4Path(T, 'attendance', 'a-out'), { attendanceId: 'a-out', ansattId: LEG, workDate: '2027-01-10', revision: 1, status: 'attested' });
  const M = build(F); M.start(); F.emit();
  assert.ok(M.attendance.has('a-in') && !M.attendance.has('a-out')); assert.equal(M.attendance.get('a-in').serverCreatedAt, undefined);
  assert.throws(() => M.attendance.set('x', {}), (e) => e.code === ADAPTER_ERROR.PRODUCTION_WRITE_VIA_COMMIT);
  const actor = { uid: ADM.uid, accessRole: 'admin', ansattId: ADM.ansattId, accessEnabled: true, tenantId: T, canManageSchedule: true, canViewOwnSchedule: false, canViewEmployeeCore: true, canViewEmployeeCompensation: true, canEditEmployment: true };
  const wd = '2026-09-12';
  const res = managerManualEntry({ actor, existing: null, shift: null, ansattId: LEG, workDate: wd, declaredStartAt: tenantLocalHMToUtcMs(wd, '09:00', TZ), declaredEndAt: tenantLocalHMToUtcMs(wd, '15:00', TZ), declaredBreakMinutesTotal: 30, employment: { startDate: '2026-09-01', endDate: null }, reasonCode: 'RETROACTIVE_ENTRY', reasonNote: 'test', scope: { tenantId: T } }, Date.now(), POLICY);
  assert.equal(res.ok, true, 'manual entry core: ' + res.code);
  const before = F.writes.length;
  const c = await M.attendance.commit(res, { create: true });
  assert.equal(c.ok, true);
  const w = F.writes.slice(before);
  assert.equal(w.length, 2); assert.ok(w.every((p) => p.startsWith(s4Path(T, 'attendance'))), w.join(','));
  F.emit(); assert.ok(M.attendance.has(res.attendance.attendanceId));
});
await t('M10', 'setRange / ensureRange: all three bounded listeners are re-windowed (never a fourth); ensureRange only widens; an inside window is a no-op', () => {
  const F = makeFakeFs(); const M = build(F); M.start();
  assert.equal(M.ensureRange({ from: '2026-09-07', to: '2026-09-13' }), false); assert.equal(F.listeners.length, 3);
  assert.equal(M.ensureRange({ from: '2026-08-01', to: '2026-08-31' }), true);
  assert.deepEqual(M.currentRange(), { from: '2026-08-01', to: '2026-10-31' });
  assert.equal(F.listeners.filter((l) => l.active).length, 3); assert.equal(F.state.unsubscribed, 3); assert.equal(M.listenerCount(), 3);
  for (const l of F.listeners.filter((l) => l.active)) assert.deepEqual(l.spec.where, [['workDate', '>=', '2026-08-01'], ['workDate', '<=', '2026-10-31']]);
  assert.equal(M.setRange({ from: '2026-08-01', to: '2026-10-31' }), false);
  assert.throws(() => M.setRange({ from: 'x', to: 'y' }), (e) => e.code === ADAPTER_ERROR.CORE_REFUSED);
  M.dispose(); assert.equal(F.listeners.filter((l) => l.active).length, 0);
});
await t('M11', 'contractProfile: load() falls back to the tenant default when _meta/contractProfile is absent, save() writes exactly that document, load() then reads the stored profile (owner edits survive)', async () => {
  const F = makeFakeFs(); const M = build(F); M.start();
  const p = await M.contractProfile.load();
  assert.equal(p.tenantId, T); assert.equal(p.employer.name, 'Four Season AS'); assert.equal(p.companyFacts.pension.applies, true);
  p.companyFacts.pension = { applies: true, provider: 'Storebrand' };
  await M.contractProfile.save();
  assert.deepEqual(F.writes, [contractProfilePath(T)]);
  const stored = F.docs.get(contractProfilePath(T)); assert.equal(stored.companyFacts.pension.provider, 'Storebrand'); assert.equal(stored.updatedByUid, ADM.uid);
  const M2 = build(F); M2.start(); const p2 = await M2.contractProfile.load(); assert.equal(p2.companyFacts.pension.provider, 'Storebrand'); assert.equal(M2.contractProfile.get(), p2);
});
await t('M12', 'employeeSelf.write is REFUSED with zero writes before first registration (old title / creation date never projected); after it, it projects ONLY the limited employee-readable facts from the canonical record (no compensation/contact/ids) to tenants/{T}/employeeSelf/{ansattId}', async () => {
  const F = makeFakeFs(); F.seed(ansattePath(T, LEG), legacyDoc()); const M = build(F); M.start();
  await refusedBeforeRegistration(F, M.employeeSelf.write(LEG, M.employees.store()[T][LEG], { onDate: today }));
  assert.ok(!F.docs.has(s4Path(T, 'employeeSelf', LEG)), 'no employeeSelf document');
  await registerFirst(M, LEG);
  const r = await M.employeeSelf.write(LEG, M.employees.store()[T][LEG], { onDate: today });
  assert.equal(r.ok, true);
  assert.deepEqual(F.writes, [ansattePath(T, LEG), s4Path(T, 'employeeSelf', LEG)]);
  const d = F.docs.get(s4Path(T, 'employeeSelf', LEG));
  assert.equal(d.name, 'Mr Testperson'); assert.equal(d.role, 'butikkmedarbeider'); assert.equal(d.startDate, REG_START); assert.ok(!JSON.stringify(d).includes('2026-09-01'), 'the old creation date is not projected');
  for (const k of ['compensation', 'hourlyRate', 'timelonn', 'bankkonto', 'personnummer', 'contact', 'email', 'ansattId', 'terms']) assert.ok(!(k in d), 'forbidden field ' + k);
});
await t('M13', 'ansattWriteFor / legacySkeleton: only the projections a kind touches are written (updateContact never rewrites stilling/timelonn/navn; endEmployee only aktiv + e360)', () => {
  const rec = normalizeAnsatt(LEG, legacyDoc());
  const w1 = ansattWriteFor('updateContact', rec, legacyDoc(), 1, today); assert.deepEqual(Object.keys(w1).sort(), ['adresse', E360_KEY, 'epost'].sort());
  const w2 = ansattWriteFor('endEmployee', Object.assign({}, rec, { status: 'ended', endedAt: today }), legacyDoc(), 1, today); assert.deepEqual(Object.keys(w2).sort(), ['aktiv', E360_KEY].sort()); assert.equal(w2.aktiv, false);
  const w3 = ansattWriteFor('contract:startDraft', rec, legacyDoc(), 1, today); assert.deepEqual(Object.keys(w3), [E360_KEY]);
  const sk = legacySkeleton(Date.UTC(2026, 8, 26)); assert.deepEqual(Object.keys(sk).sort(), ['adresse', 'aktiv', 'bankkonto', 'epost', 'navn', 'notater', 'opprettet', 'personnummer', 'stilling', 'timelonn']);
  assert.equal(w1[E360_KEY].rev, 1); const w4 = ansattWriteFor('updateContact', rec, { [E360_KEY]: { rev: 7 } }, 1, today); assert.equal(w4[E360_KEY].rev, 8);
});
await t('M14', 'superseded generation / disposed: every write and re-window is refused; snapshots are ignored; NOTHING is ever written under legacy vakter across the whole battery shape', async () => {
  const F = makeFakeFs(); F.seed(ansattePath(T, LEG), legacyDoc()); let cur = true; const M = build(F, { isCurrent: () => cur }); M.start();
  cur = false; F.emit();
  await assert.rejects(M.employees.apply({ kind: 'updateContact', ansattId: LEG, contact: { phone: '1' } }), (e) => e.code === ADAPTER_ERROR.NOT_CURRENT);
  await assert.rejects(M.employees.applyContract({ kind: 'startDraft', ansattId: LEG }, {}), (e) => e.code === ADAPTER_ERROR.NOT_CURRENT);
  await assert.rejects(M.contractProfile.save(), (e) => e.code === ADAPTER_ERROR.NOT_CURRENT);
  assert.throws(() => M.setRange({ from: '2026-01-01', to: '2026-12-31' }), (e) => e.code === ADAPTER_ERROR.NOT_CURRENT);
  cur = true; M.dispose();
  await assert.rejects(M.employees.apply({ kind: 'updateContact', ansattId: LEG, contact: { phone: '1' } }), (e) => e.code === ADAPTER_ERROR.DISPOSED);
  await assert.rejects(M.schedule.admin.cancel('x'), (e) => e.code === ADAPTER_ERROR.DISPOSED);
  assert.equal(F.writes.length, 0);
  assert.ok(onlyAllowed(F));
});

for (const l of lines) console.log(l);
console.log('MANAGEMENT_PRODUCTION_ADAPTERS_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
