// management-private-fields.test.mjs — release 019: fødselsnummer + bankkonto as MANAGEMENT-ONLY private fields.
// Node built-ins only; a FAKE injected datastore. Every value in this file is obviously synthetic (no real person,
// no real account). Browser behaviour (masked DOM, Vis / Skjul, remasking on navigation) is proven in the scratch
// headless harness (pf-proofs.mjs); the rules boundary in the emulator proof (run-private-fields.mjs).
// Run: node management-private-fields.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_FIELD_KEYS, validatePrivateField, validatePrivatePatch, storedDigits, maskPrivateField, formatPrivateField } from './management-private-fields.mjs';
import { createManagementAdapters, normalizeAnsatt, ansattWriteFor, legacySkeleton, E360_KEY } from './management-production-adapters.mjs';
import { ADAPTER_ERROR } from './employee-production-adapters.mjs';
import { ETR2A_POLICY as POLICY } from './employee-shell-core.mjs';
import { employeesOf, employeeOf, vaktplanPeopleFrom, missingInfoOf } from './management-employees-core.mjs';
import { projectEmployeeSelf, validateEmployeeSelfDoc, EMPLOYEE_SELF_FORBIDDEN } from './employee-self-projection.mjs';
import { contractInputsFor, renderContractBlocks, TEMPLATE_FIELDS, OPTIONAL_PRIVATE_FIELDS } from './management-contract-core.mjs';
import { FOUR_SEASON_CONTRACT_PROFILE } from './employee-schedule-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0; const lines = [];
async function t(id, desc, fn) { try { await fn(); passed += 1; lines.push('PASS  ' + id + '  ' + desc); } catch (e) { failed += 1; lines.push('FAIL  ' + id + '  ' + desc + '  ::  ' + (e && e.message ? e.message : e)); } }

// SYNTHETIC values only: an impossible birth date (day 99) and an all-pattern account.
const PNR = '99999912345', PNR2 = '99999954321';
const KTO = '00001122334', KTO2 = '00009988776';
const SECRETS = [PNR, PNR2, KTO, KTO2, '12345', '54321', '22334', '88776'];
const hasSecret = (s, list) => (list || [PNR, PNR2, KTO, KTO2]).some((v) => String(s).includes(v));

const T = 'four-season-as';
const ADM = { uid: 'uid-admin-1', tenantId: T, accessRole: 'admin', ansattId: 'Ij7AmknF9ZDAdWgwQGJi', accessEnabled: true };
const A1 = 'Kx9mQ2vT7pLa4RcW1nZb', A2 = 'Zz8nR3wU6qMb5SdX2oYc';
const RANGE = { from: '2026-09-01', to: '2026-10-31' };
function makeFakeFs() {
  const docs = new Map(); const writes = []; const reads = [];
  const colOf = (p) => p.split('/').slice(0, -1).join('/'); const idOf = (p) => p.split('/').pop();
  const apply = (w) => { for (const [kind, p, d] of w) { writes.push({ kind, path: p, data: JSON.parse(JSON.stringify(d)) }); if (kind === 'set') docs.set(p, JSON.parse(JSON.stringify(d))); else { if (!docs.has(p)) throw Object.assign(new Error('not-found'), { code: 'not-found' }); docs.set(p, Object.assign({}, docs.get(p), JSON.parse(JSON.stringify(d)))); } } };
  let failNext = null;
  const api = {
    doc: (p) => ({ path: p }), serverTimestamp: () => ({ __st: true }), newId: () => 'AuToId00000000000001',
    listen: () => () => {},
    runTransaction: async (fn) => { if (failNext) { const e = failNext; failNext = null; throw e; } const w = []; const tx = { get: async (ref) => { reads.push(ref.path); return { exists: docs.has(ref.path), data: docs.get(ref.path) }; }, set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]) }; const r = await fn(tx); apply(w); return r; },
    batch: () => { const w = []; return { set: (ref, d) => w.push(['set', ref.path, d]), update: (ref, d) => w.push(['update', ref.path, d]), commit: async () => { apply(w); } }; },
  };
  const readAnsatte = () => { const out = []; for (const [p, d] of docs) if (colOf(p) === 'tenants/' + T + '/ansatte') out.push(Object.assign({ id: idOf(p) }, d)); return out; };
  return { api, docs, writes, reads, readAnsatte, seed: (p, d) => docs.set(p, JSON.parse(JSON.stringify(d))), failWith: (e) => { failNext = e; } };
}
const legacyDoc = (over) => Object.assign({ navn: 'Test Ansatt 01', stilling: 'butikkmedarbeider', timelonn: 210, adresse: 'Testveien 1, 2815 Gjøvik', epost: 'test01@example.test', bankkonto: '', personnummer: '', notater: 'n', aktiv: true, opprettet: '2026-09-01T08:00:00.000Z' }, over || {});
const build = (F, extra) => createManagementAdapters(Object.assign({ fs: F.api, tenantId: T, membership: ADM, range: RANGE, readAnsatte: F.readAnsatte, defaultContractProfile: FOUR_SEASON_CONTRACT_PROFILE, policy: POLICY }, extra || {}));
const P = (id) => 'tenants/' + T + '/ansatte/' + id;
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

await t('PF01', 'A. fødselsnummer normalize/validate: exactly 11 digits after removing spaces; 10 / 12 digits, letters, dots, empty, non-strings refused with PERSONNUMMER_INVALID; the result never echoes the rejected input; NO date or checksum rule (a synthetic day-99 value and a D-number-shaped value both pass)', () => {
  assert.deepEqual(validatePrivateField('personnummer', PNR), { ok: true, value: PNR });
  assert.deepEqual(validatePrivateField('personnummer', ' 999999 12345 '), { ok: true, value: PNR });
  assert.deepEqual(validatePrivateField('personnummer', '9 9 9 9 9 9 1 2 3 4 5'), { ok: true, value: PNR });
  assert.equal(validatePrivateField('personnummer', '41019912345').ok, true, 'D-number shaped (day + 40)');
  for (const bad of ['9999991234', '999999123456', '99999912 34x', '999999.12345', '', '   ', 'abcdefghijk', null, undefined, 99999912345, {}]) {
    const r = validatePrivateField('personnummer', bad);
    assert.deepEqual(r, { ok: false, code: 'PERSONNUMMER_INVALID' }, String(bad));
  }
  assert.deepEqual(validatePrivateField('fodselsdato', PNR), { ok: false, code: 'PRIVATE_FIELD_UNKNOWN' });
});
await t('PF02', 'B. bankkonto normalize/validate: exactly 11 digits after removing spaces and the customary dots (0000.11.22334); anything else refused with BANKKONTO_INVALID; no MOD-11 rule', () => {
  assert.deepEqual(validatePrivateField('bankkonto', KTO), { ok: true, value: KTO });
  assert.deepEqual(validatePrivateField('bankkonto', '0000 11 22334'), { ok: true, value: KTO });
  assert.deepEqual(validatePrivateField('bankkonto', '0000.11.22334'), { ok: true, value: KTO });
  for (const bad of ['0000112233', '000011223344', '0000-11-22334', 'NO9386011117947', '', null, 1122334]) assert.deepEqual(validatePrivateField('bankkonto', bad), { ok: false, code: 'BANKKONTO_INVALID' }, String(bad));
});
await t('PF03', 'patch validation: blank / absent = leave unchanged (never clears or replaces implicitly); an all-blank patch -> PRIVATE_FIELDS_NO_CHANGE; unknown keys refused; the first invalid field is named, its value is not', () => {
  assert.deepEqual(validatePrivatePatch({ personnummer: '999999 12345' }), { ok: true, write: { personnummer: PNR } });
  assert.deepEqual(validatePrivatePatch({ personnummer: '', bankkonto: '0000.11.22334' }), { ok: true, write: { bankkonto: KTO } });
  assert.deepEqual(validatePrivatePatch({ personnummer: PNR, bankkonto: KTO }), { ok: true, write: { personnummer: PNR, bankkonto: KTO } });
  for (const empty of [{}, null, undefined, { personnummer: '', bankkonto: '  ' }, { personnummer: null }]) assert.deepEqual(validatePrivatePatch(empty), { ok: false, code: 'PRIVATE_FIELDS_NO_CHANGE', field: null });
  const bad = validatePrivatePatch({ personnummer: PNR, bankkonto: '123' });
  assert.deepEqual(bad, { ok: false, code: 'BANKKONTO_INVALID', field: 'bankkonto' }); assert.ok(!hasSecret(JSON.stringify(bad)));
  assert.deepEqual(validatePrivatePatch({ navn: 'x' }), { ok: false, code: 'PRIVATE_FIELD_UNKNOWN', field: null });
  assert.deepEqual(validatePrivatePatch({ personnummer: PNR, timelonn: 999 }), { ok: false, code: 'PRIVATE_FIELD_UNKNOWN', field: null });
  assert.deepEqual([...PRIVATE_FIELD_KEYS], ['personnummer', 'bankkonto']);
});
await t('PF04', 'C/D. masked by default: fødselsnummer shows the birth-date part and five dots, an account shows only its last five digits, a missing value is not present, an irregular legacy value reveals nothing; the mask object never contains the value', () => {
  const m1 = maskPrivateField('personnummer', PNR);
  assert.deepEqual(m1, { present: true, regular: true, masked: '999999 •••••' }); assert.ok(!JSON.stringify(m1).includes('12345'));
  const m2 = maskPrivateField('bankkonto', '0000.11.22334');
  assert.deepEqual(m2, { present: true, regular: true, masked: '•••• •• 22334' }); assert.ok(!JSON.stringify(m2).includes('0000') && !JSON.stringify(m2).includes('11 '));
  for (const none of ['', '   ', null, undefined, 0]) assert.deepEqual(maskPrivateField('personnummer', none), { present: false, regular: false, masked: null });
  const odd = maskPrivateField('bankkonto', 'IBAN NO93 8601');
  assert.deepEqual(odd, { present: true, regular: false, masked: '•'.repeat(11) });
  assert.equal(storedDigits('bankkonto', '0000 11 22334'), KTO); assert.equal(storedDigits('personnummer', '123'), null);
  assert.equal(formatPrivateField('personnummer', PNR), '999999 12345'); assert.equal(formatPrivateField('bankkonto', KTO), '0000 11 22334');
  assert.equal(formatPrivateField('bankkonto', ' odd value '), 'odd value'); assert.equal(formatPrivateField('personnummer', ''), null);
});
await t('PF05', 'adapter.masked(): sync projection from the host mirror — presence + mask only, no value, for every employee; unknown employee = not present', () => {
  const F = makeFakeFs(); F.seed(P(A1), legacyDoc({ personnummer: PNR, bankkonto: '0000.11.22334' })); F.seed(P(A2), legacyDoc({ navn: 'Test Ansatt 02' }));
  const M = build(F); M.start();
  const a = M.employees.privateFields.masked(A1);
  assert.deepEqual(a, { personnummer: { present: true, regular: true, masked: '999999 •••••' }, bankkonto: { present: true, regular: true, masked: '•••• •• 22334' } });
  assert.ok(!hasSecret(JSON.stringify(a)));
  assert.deepEqual(M.employees.privateFields.masked(A2), { personnummer: { present: false, regular: false, masked: null }, bankkonto: { present: false, regular: false, masked: null } });
  assert.equal(M.employees.privateFields.masked('nope').personnummer.present, false);
  assert.equal(F.writes.length, 0); assert.ok(Object.isFrozen(M.employees.privateFields));
  M.dispose();
});
await t('PF06', 'E. adapter.read(): explicit reveal = ONE authoritative read of that employee document; resolves the two values (digits; legacy dotted account normalised; null when missing); unknown employee refused; a disposed / superseded adapter refuses; zero writes', async () => {
  const F = makeFakeFs(); F.seed(P(A1), legacyDoc({ personnummer: PNR, bankkonto: '0000.11.22334' })); F.seed(P(A2), legacyDoc());
  const M = build(F); M.start();
  const n0 = F.reads.length;
  assert.deepEqual(await M.employees.privateFields.read(A1), { personnummer: PNR, bankkonto: KTO });
  assert.deepEqual(F.reads.slice(n0), [P(A1)]);
  assert.deepEqual(await M.employees.privateFields.read(A2), { personnummer: null, bankkonto: null });
  const e1 = await rejects(M.employees.privateFields.read('missing')); assert.equal(e1.code, ADAPTER_ERROR.CORE_REFUSED); assert.equal(e1.detail, 'EMPLOYEE_UNKNOWN');
  const e2 = await rejects(M.employees.privateFields.read('bad/id')); assert.equal(e2.detail, 'EMPLOYEE_UNKNOWN');
  assert.equal(F.writes.length, 0);
  let current = true; const M2 = build(F, { isCurrent: () => current }); M2.start(); current = false;
  assert.equal((await rejects(M2.employees.privateFields.read(A1))).code, ADAPTER_ERROR.NOT_CURRENT);
  M.dispose(); assert.equal((await rejects(M.employees.privateFields.read(A1))).code, ADAPTER_ERROR.DISPOSED);
});
await t('PF07', 'J/K. adapter.update(): ONE transaction, ONE update on the canonical document whose payload has ONLY the provided private keys (digits); every other field of the document — navn, stilling, timelonn, adresse, epost, notater, aktiv, opprettet and the whole e360 block incl. rev — is byte-identical; the result carries field names only', async () => {
  const F = makeFakeFs();
  const e360 = { name: 'Test Ansatt 01', status: 'active', startDate: '2026-08-01', contact: { email: null, phone: '40000000', address: null, birthDate: '1995-04-12' }, terms: [{ validFrom: '2026-08-01', role: 'butikkmedarbeider' }], documents: [], contractVersions: [], rev: 7, updatedAt: 1, lastOp: 'updateContact' };
  F.seed(P(A1), legacyDoc({ [E360_KEY]: e360 }));
  const before = JSON.parse(JSON.stringify(F.docs.get(P(A1))));
  const M = build(F); M.start();
  const r = await M.employees.privateFields.update(A1, { personnummer: '999999 12345', bankkonto: '0000.11.22334' });
  assert.deepEqual(r, { ok: true, ansattId: A1, fields: ['personnummer', 'bankkonto'] }); assert.ok(!hasSecret(JSON.stringify(r)));
  assert.equal(F.writes.length, 1); assert.equal(F.writes[0].kind, 'update'); assert.equal(F.writes[0].path, P(A1));
  assert.deepEqual(F.writes[0].data, { personnummer: PNR, bankkonto: KTO });
  const after = F.docs.get(P(A1));
  for (const k of Object.keys(before)) if (k !== 'personnummer' && k !== 'bankkonto') assert.deepEqual(after[k], before[k], k);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort()); assert.equal(after[E360_KEY].rev, 7); assert.equal(after[E360_KEY].lastOp, 'updateContact');
  // one field only: the other private field is not touched at all
  const r2 = await M.employees.privateFields.update(A1, { bankkonto: KTO2, personnummer: '' });
  assert.deepEqual(r2.fields, ['bankkonto']); assert.deepEqual(F.writes[1].data, { bankkonto: KTO2 }); assert.equal(F.docs.get(P(A1)).personnummer, PNR);
  assert.equal(M.employees.privateFields.masked(A1).bankkonto.masked, '•••• •• 88776');
  M.dispose();
});
await t('PF08', 'update refusals write NOTHING: invalid values, all-blank, unknown key, unknown employee, disposed adapter; a datastore failure maps to the adapter vocabulary', async () => {
  const F = makeFakeFs(); F.seed(P(A1), legacyDoc({ personnummer: PNR }));
  const M = build(F); M.start();
  const cases = [[{ personnummer: '123' }, 'PERSONNUMMER_INVALID', 'personnummer'], [{ bankkonto: 'abc' }, 'BANKKONTO_INVALID', 'bankkonto'], [{}, 'PRIVATE_FIELDS_NO_CHANGE', null], [{ personnummer: ' ' }, 'PRIVATE_FIELDS_NO_CHANGE', null], [{ navn: 'x' }, 'PRIVATE_FIELD_UNKNOWN', null]];
  for (const [patch, code, field] of cases) { const e = await rejects(M.employees.privateFields.update(A1, patch)); assert.equal(e.code, ADAPTER_ERROR.CORE_REFUSED); assert.deepEqual(e.coreResult, { ok: false, code, field }); }
  const eu = await rejects(M.employees.privateFields.update('missing', { personnummer: PNR2 })); assert.equal(eu.detail, 'EMPLOYEE_UNKNOWN');
  F.failWith(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
  const ep = await rejects(M.employees.privateFields.update(A1, { personnummer: PNR2 })); assert.equal(ep.code, ADAPTER_ERROR.PERMISSION_DENIED);
  assert.equal(F.writes.length, 0); assert.equal(F.docs.get(P(A1)).personnummer, PNR);
  M.dispose(); assert.equal((await rejects(M.employees.privateFields.update(A1, { personnummer: PNR2 }))).code, ADAPTER_ERROR.DISPOSED);
});
await t('PF09', 'P. no value in any error / result string: every rejection (validation, unknown employee, datastore failure) and every success object is serialised (message, code, detail, coreResult, stack, JSON) and contains neither typed nor stored value', async () => {
  const F = makeFakeFs(); F.seed(P(A1), legacyDoc({ personnummer: PNR, bankkonto: KTO }));
  const M = build(F); M.start();
  const ser = (e) => [e && e.message, e && e.code, e && e.detail, e && e.stack, JSON.stringify(e), JSON.stringify(e && e.coreResult), String(e)].join(' | ');
  const outs = [];
  outs.push(ser(await rejects(M.employees.privateFields.update(A1, { personnummer: PNR2 + '9' }))));
  outs.push(ser(await rejects(M.employees.privateFields.update(A1, { bankkonto: KTO2 + 'x' }))));
  outs.push(ser(await rejects(M.employees.privateFields.update('missing', { personnummer: PNR2, bankkonto: KTO2 }))));
  F.failWith(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
  outs.push(ser(await rejects(M.employees.privateFields.update(A1, { personnummer: PNR2, bankkonto: KTO2 }))));
  outs.push(JSON.stringify(await M.employees.privateFields.update(A1, { personnummer: PNR2, bankkonto: KTO2 })));
  outs.push(JSON.stringify(M.employees.privateFields.masked(A1)).replace(/88776/g, ''));   // the mask legitimately shows the account's last five
  for (const o of outs) assert.ok(!hasSecret(o), o.slice(0, 120));
  M.dispose();
});
await t('PF10', 'L. list / search / Oversikt / Vaktplan / payroll inputs carry neither value: the normalized record, the whole Employee 360 store, employeesOf, employeeOf, vaktplanPeopleFrom, adapters.employees.people() and missingInfoOf are serialised and contain no private key and no private value; the store is unchanged by a private update', async () => {
  const F = makeFakeFs(); F.seed(P(A1), legacyDoc({ personnummer: PNR, bankkonto: KTO })); F.seed(P(A2), legacyDoc({ navn: 'Test Ansatt 02', personnummer: PNR2, bankkonto: '0000.99.88776' }));
  const rec = normalizeAnsatt(A1, F.docs.get(P(A1)));
  assert.ok(!('personnummer' in rec) && !('bankkonto' in rec));
  const M = build(F); M.start();
  const store = M.employees.store();
  const blobs = [JSON.stringify(rec), JSON.stringify(store), JSON.stringify(employeesOf(store, T)), JSON.stringify(employeeOf(store, T, A1)), JSON.stringify(vaktplanPeopleFrom(store, T)), JSON.stringify(M.employees.people()), JSON.stringify(employeesOf(store, T).map((e) => missingInfoOf(e, '2026-10-03')))];
  for (const b of blobs) { assert.ok(!hasSecret(b)); assert.ok(!/personnummer|bankkonto/.test(b)); assert.ok(!b.includes('0000.99.88776')); }
  const snap = JSON.stringify(store);
  await M.employees.privateFields.update(A1, { personnummer: PNR2 });
  M.employees.refresh();
  assert.equal(JSON.stringify(M.employees.store()), snap, 'a private update is invisible to the Employee 360 store');
  M.dispose();
});
await t('PF11', 'no employee/contract operation ever writes a private field: ansattWriteFor for every operation kind has neither key; Ny ansatt creates them EMPTY (never invented); updateContact / contract operations on a document that holds values leave them untouched (since release 019B-R2 a NEW contract draft holds its own prefilled copy under contractVersions[].privateFields — the only place in the e360 block)', async () => {
  const rec = normalizeAnsatt(A1, legacyDoc({ personnummer: PNR, bankkonto: KTO }));
  for (const kind of ['createEmployee', 'updateContact', 'appendTerms', 'completeCurrentTerms', 'correctCurrentTerms', 'endEmployee', 'addDocument', 'contract:startDraft', 'contract:freezeVersion']) {
    const w = ansattWriteFor(kind, rec, null, 1, '2026-10-03');
    assert.ok(!('personnummer' in w) && !('bankkonto' in w), kind); assert.ok(!hasSecret(JSON.stringify(w)), kind);
  }
  const sk = legacySkeleton(1); assert.equal(sk.personnummer, ''); assert.equal(sk.bankkonto, '');
  const F = makeFakeFs(); F.seed(P(A1), legacyDoc({ personnummer: PNR, bankkonto: KTO }));
  const M = build(F); M.start();
  // initial-registration hardening: on an old-register document both operations are refused with ZERO writes until the
  // employment has been registered; the first write is therefore the registration itself (e360 + accepted projections).
  for (const p of [M.employees.apply({ kind: 'updateContact', ansattId: A1, contact: { phone: '40000001' } }), M.employees.applyContract({ kind: 'startDraft', ansattId: A1 }, FOUR_SEASON_CONTRACT_PROFILE, {})]) await assert.rejects(p, (e) => /INITIAL_REGISTRATION_REQUIRED/.test(e.message));
  assert.equal(F.writes.length, 0);
  await M.employees.apply({ kind: 'registerInitialEmployment', ansattId: A1, startDate: '2026-06-01', terms: { role: 'butikkmedarbeider', employmentForm: 'fast', employmentType: 'fast', percentage: 100, compensation: { model: 'timelonn', hourlyRate: 210 }, expectedWeeklyHours: 37.5, workplace: '4Seasons ferske varer', noticePeriod: '1 måned' } });
  await M.employees.apply({ kind: 'updateContact', ansattId: A1, contact: { phone: '40000001' } });
  await M.employees.applyContract({ kind: 'startDraft', ansattId: A1 }, M.contractProfile.get() || FOUR_SEASON_CONTRACT_PROFILE, {});
  assert.equal(F.writes.length, 3);
  for (const w of F.writes) assert.ok(!('personnummer' in w.data) && !('bankkonto' in w.data));
  for (const w of F.writes.slice(1)) assert.deepEqual(Object.keys(w.data).filter((k) => k !== E360_KEY && k !== 'epost' && k !== 'adresse'), []);
  assert.ok(!hasSecret(JSON.stringify(F.writes[0].data)), 'first registration carries no private value');
  assert.ok(!hasSecret(JSON.stringify(F.writes[1].data)), 'updateContact carries no private value');
  assert.equal(F.docs.get(P(A1)).personnummer, PNR); assert.equal(F.docs.get(P(A1)).bankkonto, KTO);
  const e360 = F.docs.get(P(A1))[E360_KEY];
  assert.deepEqual(e360.contractVersions[0].privateFields, { fodselsnummer: PNR, bankkonto: KTO }, 'the new draft is prefilled with its own copy');
  assert.ok(!hasSecret(JSON.stringify(Object.assign({}, e360, { contractVersions: e360.contractVersions.map((v) => Object.assign({}, v, { privateFields: undefined })) }))), 'nowhere else in the e360 block');
  M.dispose();
});
await t('PF12', 'M. employeeSelf never contains them: the projection of a record (even one POISONED with both keys) has neither key nor value; both names are in EMPLOYEE_SELF_FORBIDDEN; the validator refuses a document that carries either; the adapter projection writer path is derived from the normalized record only', async () => {
  for (const k of ['personnummer', 'bankkonto', 'bankAccount']) assert.ok(EMPLOYEE_SELF_FORBIDDEN.includes(k), k);
  const rec = normalizeAnsatt(A1, legacyDoc({ personnummer: PNR, bankkonto: KTO }));
  const poisoned = Object.assign({}, rec, { personnummer: PNR, bankkonto: KTO });
  for (const r of [rec, poisoned]) {
    const p = projectEmployeeSelf(r, '2026-10-03');
    const s = JSON.stringify(p); assert.ok(!hasSecret(s)); assert.ok(!/personnummer|bankkonto/.test(s));
  }
  const doc = Object.assign({}, projectEmployeeSelf(rec, '2026-10-03'), { derivedAt: null, sourceRevision: 1 });
  assert.equal(validateEmployeeSelfDoc(doc).ok, true, 'clean projection is valid');
  for (const k of ['personnummer', 'bankkonto']) { const v = validateEmployeeSelfDoc(Object.assign({}, doc, { [k]: k === 'personnummer' ? PNR : KTO })); assert.equal(v.ok, false, k + ' accepted by the employeeSelf validator'); }
  const F = makeFakeFs(); F.seed(P(A1), legacyDoc({ personnummer: PNR, bankkonto: KTO }));
  const M = build(F); M.start();
  // closeout law: no projection before first registration (zero writes); the adapter test therefore registers first
  await assert.rejects(M.employeeSelf.write(A1, M.employees.store()[T][A1], { onDate: '2026-10-03', sourceRevision: 1 }), (e) => /INITIAL_REGISTRATION_REQUIRED/.test(e.message));
  assert.equal(F.writes.length, 0);
  await M.employees.apply({ kind: 'registerInitialEmployment', ansattId: A1, startDate: '2026-06-01', terms: { role: 'butikkmedarbeider', employmentForm: 'fast', employmentType: 'fast', percentage: 100, compensation: { model: 'timelonn', hourlyRate: 210 }, expectedWeeklyHours: 37.5, workplace: '4Seasons ferske varer', noticePeriod: '1 måned' } });
  const wr = await M.employeeSelf.write(A1, M.employees.store()[T][A1], { onDate: '2026-10-03', sourceRevision: 1 });
  assert.equal(wr.ok, true); assert.equal(F.writes.length, 2); assert.equal(F.writes[1].path, 'tenants/' + T + '/employeeSelf/' + A1);
  assert.deepEqual(Object.keys(F.writes[1].data).sort(), ['derivedAt', 'employmentType', 'expectedWeeklyHours', 'hasContract', 'name', 'percentage', 'role', 'sourceRevision', 'startDate', 'workplace']);
  for (const w of F.writes) assert.ok(!hasSecret(JSON.stringify(w.data)) && !/personnummer|bankkonto/.test(JSON.stringify(w.data)), w.path);
  M.dispose();
  const empSrc = ['employee-production-adapters.mjs', 'employee-production-bridge.mjs', 'employee-myjob.mjs', 'employee-schedule-view.mjs', 'employee-schedule-week.mjs', 'employee-schedule-month.mjs', 'employee-shell-core.mjs'].map((f) => fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
  assert.ok(!/personnummer|bankkonto|privateFields/.test(empSrc), 'the employee self-service modules never name the private fields');
});
await t('PF13', 'Q. contract unchanged: contractInputsFor + renderContractBlocks give byte-identical output for the same employee with and without the private values on the document; neither value is a template field (since release 019B-R2 they are OPTIONAL_PRIVATE_FIELDS of the contract draft — proven in management-contract-private-fields.test.mjs); a frozen snapshot produced through the adapter with both contract fields CLEARED holds neither value', async () => {
  assert.ok(!TEMPLATE_FIELDS.some((f) => /personnummer|bankkonto|fodselsnummer|bankAccount/i.test(f.key)));
  assert.deepEqual(OPTIONAL_PRIVATE_FIELDS.map((f) => [f.key, f.secure, f.optional]), [['fodselsnummer', true, true], ['bankkonto', true, true]]);
  const e360 = { name: 'Test Ansatt 01', status: 'active', startDate: '2026-08-01', contact: { email: null, phone: '40000000', address: { street: 'Testveien 1', postalCode: '2815', city: 'Gjøvik' }, birthDate: '1995-04-12' }, terms: [{ validFrom: '2026-08-01', role: 'butikkmedarbeider', employmentType: 'deltid', employmentForm: 'fast', percentage: 50, compensation: { model: 'timelonn', hourlyRate: 210 }, workplace: 'Four Season Gjøvik', expectedWeeklyHours: 18.75, workingTimeArrangement: 'Arbeidstid etter vaktplan', probation: 'ingen', noticePeriod: '1 måned', breaksArrangement: '30', scheduleChangeHandling: 'Varsles 14 dager før', paymentInterval: 'manedlig' }], documents: [], contractVersions: [], rev: 3 };
  const profile = JSON.parse(JSON.stringify(FOUR_SEASON_CONTRACT_PROFILE)); profile.companyFacts = { salaryPaymentArrangement: 'Den 15. hver måned', pension: { applies: true, provider: 'Testpensjon' }, occupationalInjuryInsurance: { applies: true, insurer: 'Testforsikring' }, tariffavtale: { applies: false, agreementName: null, parties: null } };
  const render = (d) => { const emp = normalizeAnsatt(A1, d); const inputs = contractInputsFor({ employee: emp, profile, onDate: '2026-10-03', roleLabels: {} }); return JSON.stringify({ inputs, blocks: renderContractBlocks(inputs, {}) }); };
  const without = render(legacyDoc({ [E360_KEY]: e360 }));
  const withP = render(legacyDoc({ [E360_KEY]: e360, personnummer: PNR, bankkonto: KTO }));
  assert.equal(withP, without); assert.ok(!hasSecret(withP));
  const F = makeFakeFs(); F.seed(P(A1), legacyDoc({ [E360_KEY]: e360, personnummer: PNR, bankkonto: KTO })); F.seed('tenants/' + T + '/_meta/contractProfile', profile);
  const M = build(F); M.start(); await M.contractProfile.load();
  const started = await M.employees.applyContract({ kind: 'startDraft', ansattId: A1 }, M.contractProfile.get(), {});
  const vid = M.employees.store()[T][A1].contractVersions[0].contractVersionId;
  await M.employees.applyContract({ kind: 'setPrivateFields', ansattId: A1, contractVersionId: vid, fields: { fodselsnummer: '', bankkonto: '' } }, M.contractProfile.get(), {});
  const emp = M.employees.store()[T][A1];
  const inputs = contractInputsFor({ employee: emp, profile: M.contractProfile.get(), onDate: undefined, roleLabels: undefined });
  let frozen = null; try { frozen = await M.employees.applyContract({ kind: 'freezeVersion', ansattId: A1, contractVersionId: vid, expectedInputs: JSON.parse(JSON.stringify(inputs)) }, M.contractProfile.get(), {}); } catch (e) { frozen = e; }
  const stored = F.docs.get(P(A1));
  assert.ok(started && started.ok); assert.equal(frozen && frozen.ok, true, 'freeze executed'); assert.equal(stored[E360_KEY].contractVersions[0].status, 'godkjent_frosset'); assert.ok(stored[E360_KEY].contractVersions[0].snapshot);
  assert.ok(!hasSecret(JSON.stringify(stored[E360_KEY])), 'no private value inside e360 / contract versions / snapshot');
  assert.ok(!/personnummer|bankkonto/.test(JSON.stringify(stored[E360_KEY])));
  assert.equal(stored.personnummer, PNR); assert.equal(stored.bankkonto, KTO);
  M.dispose();
});
await t('PF14', 'R. signing / BankID input unchanged: no file under functions/ (src, scripts, index) reads either field — the only mention is the evidence REDACTION key list; in functions/shared only the byte-exact packaged contract core names them (release 019B-R2 optional contract fields = document content); the signing packaging manifest lists no private-field module; live smoke authorization stays closed', () => {
  const root = path.join(HERE, 'functions');
  const files = [];
  for (const d of ['src', 'shared', 'scripts']) for (const f of fs.readdirSync(path.join(root, d))) if (/\.mjs$/.test(f)) files.push(path.join(d, f));
  files.push('index.mjs');
  const hits = [];
  for (const f of files) { const src = fs.readFileSync(path.join(root, f), 'utf8'); src.split('\n').forEach((line, i) => { if (/personnummer|bankkonto|management-private-fields|privateFields/.test(line)) hits.push(f.replace(/\\/g, '/') + ':' + (i + 1) + ':' + line.trim().slice(0, 60)); }); }
  const own = hits.filter((h) => !h.startsWith('shared/management-contract-core.mjs:'));
  assert.equal(own.length, 1, JSON.stringify(own));
  assert.ok(own[0].startsWith('src/live-smoke-evidence.mjs:') && own[0].includes('SECRET_KEYS'), own[0]);
  assert.equal(fs.readFileSync(path.join(root, 'shared', 'management-contract-core.mjs'), 'utf8'), fs.readFileSync(path.join(HERE, 'management-contract-core.mjs'), 'utf8'));
  const manifest = fs.readFileSync(path.join(root, 'shared', 'MANIFEST.json'), 'utf8');
  assert.ok(!/private-fields/.test(manifest));
  const gate = fs.readFileSync(path.join(root, 'src', 'live-smoke-gate.mjs'), 'utf8');
  assert.ok(gate.includes('export const LIVE_SMOKE_AUTHORIZATION = Object.freeze({ authorized: false, releaseId: null, runId: null });'));
  assert.ok(fs.readFileSync(path.join(root, 'src', 'preprod-config.mjs'), 'utf8').includes('export const LIVE_CLOUD_WRITES_AUTHORIZED = false;'));
});
await t('PF15', 'O (static). view render safety: the card renders values only through text nodes of span.pv; the masked projection is the only source while masked; no dataset / title / id / hidden input carries a value; edit inputs start EMPTY with autocomplete off; no Copy control; no console output, toast or alert in the private code; any navigation remasks (privSync in draw)', () => {
  const view = fs.readFileSync(path.join(HERE, 'management-employees-view.mjs'), 'utf8');
  const a = view.indexOf('  function drawPrivate(e) {'), b = view.indexOf('  function drawTid(e) {');
  assert.ok(a > 0 && b > a);
  const body = view.slice(a, b).replace(/^\s*\/\/.*$/gm, '');
  assert.ok(body.includes("if (!privateFields || !canEditEmployment(actor) || !canViewCompensation(actor)) return;"));
  assert.ok(body.includes("text: !info.present ? 'Ikke registrert' : (shown != null ? shown : info.masked)"));
  assert.equal(body.split('privateFields.read(').length - 1, 1, 'ONE read call, inside the Vis handler');
  assert.ok(body.indexOf('privateFields.read(') > body.indexOf("btn(shown != null ? 'Skjul' : 'Vis'"));
  assert.ok(!/dataset|\.title\s*=|setAttribute\('(title|value|data-value|id|name)'|type: 'hidden'|innerHTML|console\.|showToast|alert\(|clipboard|Kopier/.test(body));
  assert.ok(body.includes("priv.draft = { personnummer: '', bankkonto: '' }") && body.includes("const i = textInput(priv.draft[k] || '', placeholder);"), 'edit starts empty');
  assert.ok(body.includes("['autocomplete', 'off']") && body.includes("['inputmode', 'numeric']") && body.includes("['spellcheck', 'false']"));
  assert.ok(body.includes("priv = privBlank(); priv.key = key; priv.ok = 'Person- og lønnsopplysninger er lagret.';"), 'generic success + full reset (remask)');
  assert.ok(body.includes("'Kunne ikke lagre. Prøv igjen.'") && body.includes("'Kunne ikke hente opplysningen. Prøv igjen.'"));
  assert.ok(view.includes('    privSync();   // release 019: any navigation remasks the private fields\n    clear(root);'));
  assert.ok(view.includes("const privKeyNow = () => page + '|' + (selectedId || '') + '|' + section;"));
  assert.ok(view.includes('    drawPrivate(e);\n  }\n'), 'placed at the end of the Lønn & økonomi section');
  const list = view.slice(view.indexOf('  function drawList() {'), view.indexOf('  function companyFactSummary() {'));
  assert.ok(!/privateFields|personnummer|bankkonto/.test(list), 'the employee list never touches the private fields');
  const shell = fs.readFileSync(path.join(HERE, 'employee-shell-ui.mjs'), 'utf8');
  assert.equal(shell.split('privateFields').length - 1, 3, 'one seam line in the management mount only');
  assert.ok(shell.includes("privateFields: MODE === 'management' && ADAPTERS.employees && ADAPTERS.employees.privateFields ? ADAPTERS.employees.privateFields : undefined,"));
  const idx = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
  const wf = idx.slice(idx.indexOf('function authWorkforceShell('), idx.indexOf('function authCloseLedelse('));
  assert.ok(!/personnummer|bankkonto|privateFields/.test(wf), 'the native shell does not handle private fields');
});
await t('PF16', 'fixtures are synthetic and nothing sensitive is logged: this test and the pure module contain no console call on a value; the adapter private block has no console / onError with a value', () => {
  const adapters = fs.readFileSync(path.join(HERE, 'management-production-adapters.mjs'), 'utf8');
  const a = adapters.indexOf('  // ---- PRIVATE employee fields (release 019)'), b = adapters.indexOf('  // ---- company contract profile (tenant config document) ----');
  const block = adapters.slice(a, b);
  assert.ok(a > 0 && b > a && !/console\.|onError\(/.test(block));
  assert.ok(block.includes('tx.update(ref, v.write);'));
  assert.equal(block.split('tx.update(').length - 1, 1); assert.equal(block.split('tx.set(').length - 1, 0);
  const pure = fs.readFileSync(path.join(HERE, 'management-private-fields.mjs'), 'utf8');
  assert.ok(!/console\.|import /.test(pure.replace(/^\s*\/\/.*$/gm, '')));
  assert.ok(PNR.startsWith('999999') && KTO.startsWith('0000'), 'synthetic fixtures');
});

for (const l of lines) console.log(l);
console.log('MANAGEMENT_PRIVATE_FIELDS_TESTS: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
