// management-production-adapters.mjs
// PRODUCTION ADAPTERS FOR THE LEDELSE WORKSPACE (Oversikt | Vaktplan | Ansatte | Lønn & økonomi). ZERO Firebase
// imports and ZERO initialization: the single production host injects the datastore capability (`fs`, see
// FS_CAPABILITY in employee-production-adapters.mjs, plus `newId(collectionPath)` for canonical employee creation).
//
// Canonical authorities (binding):
//   tenants/{T}/ansatte/{ansattId}        THE employee/employment home. The Firestore document id IS ansattId
//                                         everywhere (memberships, shifts, attendance, employeeSelf). Legacy flat
//                                         fields (navn, stilling, timelonn, adresse, epost, bankkonto, personnummer,
//                                         notater, aktiv, opprettet) stay as backward-compatible current
//                                         projections; accepted Employee 360 state lives ADDITIVELY in the SAME
//                                         document under `e360` (contact, status, terms history, documents,
//                                         contract versions). Never a second registry.
//   tenants/{T}/shifts                    planned work (reused management schedule adapter).
//   tenants/{T}/attendance                actual / manager-attested time (bounded management read + accepted commit).
//   tenants/{T}/employeeSelf/{ansattId}   derived, limited employee projection (accepted writer; never the master).
//   tenants/{T}/_meta/contractProfile     tenant company-contract facts (owner-editable Avtaleoppsett); admin-only.
// `vakter` is never addressed (s4Path law) and no legacy field is migrated or deleted here.
//
// Every business decision is made by the ACCEPTED cores (management-employees-core applyEmployeeOperation,
// management-contract-core applyContractOperation, schedule/attendance cores through the reused adapters). This
// module only normalises documents into the read shapes the accepted views consume and persists the cores' results
// atomically (one transaction per operation, legacy projections updated in the same write).

import {
  createManagementScheduleAdapters, makeAttendanceCommitter, makeEmployeeSelfWriter,
  validateFsCapability, adapterError, mapFsError, ADAPTER_ERROR, s4Path, stripServerFields,
} from './employee-production-adapters.mjs';
import { applyEmployeeOperation, normalizeAddress, formatAddress, currentTermsOf, lacksEmploymentBaseline } from './management-employees-core.mjs';
import { applyContractOperation } from './management-contract-core.mjs';
import { PRIVATE_FIELD_KEYS, validatePrivatePatch, maskPrivateField, storedDigits } from './management-private-fields.mjs';

export const E360_KEY = 'e360';
export const LEGACY_FIELDS = Object.freeze(['navn', 'stilling', 'timelonn', 'adresse', 'epost', 'bankkonto', 'personnummer', 'notater', 'aktiv', 'opprettet']);
const WD_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const TERMS_KEYS = ['validFrom', 'role', 'employmentType', 'percentage', 'compensation', 'workplace', 'expectedWeeklyHours', 'workingTimeArrangement', 'probation', 'noticePeriod', 'breaksArrangement', 'scheduleChangeHandling', 'employmentBasis', 'employmentEndDate', 'paymentInterval', 'employmentForm'];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const freezeTerms = (t) => { if (t && t.compensation) Object.freeze(t.compensation); return Object.freeze(t); };

export function ansattePath(tenantId, id) {
  if (typeof tenantId !== 'string' || !ID_RE.test(tenantId)) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, 'tenant');
  if (id !== undefined && (typeof id !== 'string' || !ID_RE.test(id))) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, 'ansattId');
  return 'tenants/' + tenantId + '/ansatte' + (id === undefined ? '' : '/' + id);
}
export function contractProfilePath(tenantId) {
  if (typeof tenantId !== 'string' || !ID_RE.test(tenantId)) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, 'tenant');
  return 'tenants/' + tenantId + '/_meta/contractProfile';
}

// ---- READ SHAPE: legacy ansatte document (+ optional e360 block) -> accepted Employee 360 record ----------------
// Pure. A legacy-only document yields a complete record: one terms period derived from the legacy current fields
// (stilling -> role, timelonn -> compensation timelonn, opprettet -> validFrom; unknowns stay null = "ufullstendig",
// never invented). When an `e360` block exists it is authoritative for the Employee 360 facts.
export function normalizeAnsatt(id, d) {
  const src = d && typeof d === 'object' ? d : {};
  const e = src[E360_KEY] && typeof src[E360_KEY] === 'object' ? src[E360_KEY] : null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const legacyRole = str(src.stilling);
  const legacyRate = Number.isFinite(src.timelonn) && src.timelonn > 0 ? src.timelonn : null;
  const opprettetWd = typeof src.opprettet === 'string' && WD_RE.test(src.opprettet.slice(0, 10)) ? src.opprettet.slice(0, 10) : null;
  const startDate = e && typeof e.startDate === 'string' && WD_RE.test(e.startDate) ? e.startDate : opprettetWd;
  let terms;
  if (e && Array.isArray(e.terms) && e.terms.length) {
    terms = e.terms.map((t) => { const o = {}; for (const k of TERMS_KEYS) o[k] = t && t[k] !== undefined ? clone(t[k]) : null; return freezeTerms(o); });
  } else {
    const o = {}; for (const k of TERMS_KEYS) o[k] = null;
    o.validFrom = startDate || '2026-01-01';   // legacy document without any date: explicit placeholder (reported as incomplete by the product)
    o.role = legacyRole; o.compensation = legacyRate ? { model: 'timelonn', hourlyRate: legacyRate } : null;
    terms = [freezeTerms(o)];
  }
  const ec = e && e.contact && typeof e.contact === 'object' ? e.contact : null;
  const legacyAddress = str(src.adresse);
  const contact = {
    email: ec && 'email' in ec ? (ec.email === '' ? null : ec.email) : str(src.epost),
    phone: ec && 'phone' in ec ? (ec.phone === '' ? null : ec.phone) : str(src.telefon),
    address: ec && 'address' in ec ? clone(ec.address) : (legacyAddress ? normalizeAddress(legacyAddress) : null),
    birthDate: ec && 'birthDate' in ec ? ec.birthDate : null,
  };
  const status = e && (e.status === 'active' || e.status === 'ended') ? e.status : (src.aktiv === false ? 'ended' : 'active');
  return {
    ansattId: id,
    name: str(src.navn) || (e && str(e.name)) || '(uten navn)',
    contact,
    status,
    endedAt: e && typeof e.endedAt === 'string' ? e.endedAt : null,
    terms,
    documents: e && Array.isArray(e.documents) ? clone(e.documents) : [],
    contractVersions: e && Array.isArray(e.contractVersions) ? clone(e.contractVersions) : [],
    termsCorrections: e && Array.isArray(e.termsCorrections) ? clone(e.termsCorrections) : [],   // release -006 correction audit (append-only)
    legacy: Object.freeze({ hasE360: !!e, aktiv: src.aktiv !== false, opprettet: src.opprettet || null }),
  };
}

// ---- WRITE SHAPE: accepted record -> ansatte document fields (e360 block + legacy projections touched by the op) --
// Legacy current fields are re-projected ONLY for the facts the operation changed, so old Timeliste/economy readers
// never drift from the Employee 360 truth and untouched legacy values (bankkonto, personnummer, notater …) are never
// rewritten. `e360.rev` is a monotonic counter used by the mirror to detect the write.
export function ansattWriteFor(kind, rec, prev, nowMs, todayWd) {
  const prevE = prev && prev[E360_KEY] && typeof prev[E360_KEY] === 'object' ? prev[E360_KEY] : null;
  const e360 = {
    name: rec.name, contact: clone(rec.contact), status: rec.status, endedAt: rec.endedAt || null,
    startDate: rec.terms[0].validFrom, terms: clone(rec.terms), documents: clone(rec.documents), contractVersions: clone(rec.contractVersions),
    rev: (prevE && Number.isInteger(prevE.rev) ? prevE.rev : 0) + 1, updatedAt: nowMs, lastOp: kind,
  };
  // correction audit rides in the SAME block; written only once one exists, so uncorrected documents keep their shape
  if (Array.isArray(rec.termsCorrections) && rec.termsCorrections.length) e360.termsCorrections = clone(rec.termsCorrections);
  const out = { [E360_KEY]: e360 };
  const t = currentTermsOf(rec, todayWd) || rec.terms[rec.terms.length - 1];
  // registerInitialEmployment (first registration of an old-register employee) follows the same projection law: the
  // legacy current fields mirror the canonical terms the admin just submitted; `opprettet` is never written.
  const touchesTerms = kind === 'createEmployee' || kind === 'appendTerms' || kind === 'completeCurrentTerms' || kind === 'correctCurrentTerms' || kind === 'registerInitialEmployment';
  if (kind === 'createEmployee' || kind === 'updateContact') {
    out.epost = rec.contact.email || '';
    const a = rec.contact.address;
    out.adresse = a ? (a.legacyText && !a.street && !a.postalCode && !a.city ? a.legacyText : formatAddress(a, '')) : '';
  }
  if (kind === 'createEmployee') { out.navn = rec.name; out.aktiv = rec.status === 'active'; }
  if (touchesTerms && t) {
    if (typeof t.role === 'string' && t.role) out.stilling = t.role;
    if (t.compensation && t.compensation.model === 'timelonn' && Number.isFinite(t.compensation.hourlyRate)) out.timelonn = t.compensation.hourlyRate;
  }
  if (kind === 'endEmployee') out.aktiv = false;
  return out;
}
// Legacy skeleton for a NEW canonical document (Ny ansatt): the source-verified legacy fields exist from day one so the
// old Timeliste/economy can read the employee exactly like every existing one.
export function legacySkeleton(nowMs) {
  return { navn: '', stilling: '', timelonn: 0, adresse: '', epost: '', bankkonto: '', personnummer: '', notater: '', aktiv: true, opprettet: new Date(nowMs).toISOString() };
}

// ---- factory -------------------------------------------------------------------------------------------------
// createManagementAdapters({ fs, tenantId, membership, range, readAnsatte, defaultContractProfile, isCurrent, nowMs,
//                            policy, onError })
//   fs                    host capability (+ newId(collectionPath) -> string)
//   membership            the ONE resolved ADMIN membership (accessRole admin, accessEnabled true)
//   range                 { from, to } YYYY-MM-DD window for shifts AND attendance reads (setRange re-windows both)
//   readAnsatte           () -> array of { id, ...legacy fields } — the host's already-live canonical employee mirror
//                         (LOCAL.ansatte); no second listener. refresh() rebuilds the Employee 360 read store from it.
//   defaultContractProfile tenant company-contract facts used when tenants/{T}/_meta/contractProfile does not exist
export function createManagementAdapters(options) {
  const o = options || {};
  const cap = validateFsCapability(o.fs);
  if (!cap.ok) throw adapterError(ADAPTER_ERROR.CAPABILITY_MISSING, cap.missing.join(','));
  if (typeof o.fs.newId !== 'function') throw adapterError(ADAPTER_ERROR.CAPABILITY_MISSING, 'newId');
  const fs = o.fs;
  const T = o.tenantId;
  const m = o.membership || {};
  if (typeof T !== 'string' || !ID_RE.test(T)) throw adapterError(ADAPTER_ERROR.PATH_FORBIDDEN, 'tenant');
  if (typeof m.uid !== 'string' || !m.uid || m.tenantId !== T || m.accessRole !== 'admin' || m.accessEnabled !== true) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'membership');
  if (typeof o.readAnsatte !== 'function') throw adapterError(ADAPTER_ERROR.CAPABILITY_MISSING, 'readAnsatte');
  const ANS = typeof m.ansattId === 'string' && ID_RE.test(m.ansattId) ? m.ansattId : null;
  const UID = m.uid;
  const isCurrent = typeof o.isCurrent === 'function' ? o.isCurrent : () => true;
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : () => Date.now();
  const policy = o.policy;
  const TZ = policy && policy.timezone ? policy.timezone : 'Europe/Oslo';
  const onError = typeof o.onError === 'function' ? o.onError : () => {};
  let range = o.range || {};
  if (typeof range.from !== 'string' || typeof range.to !== 'string' || !WD_RE.test(range.from) || !WD_RE.test(range.to) || range.from > range.to) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'range');
  let disposed = false;
  const live = () => !disposed && isCurrent();
  const assertLive = () => { if (disposed) throw adapterError(ADAPTER_ERROR.DISPOSED); if (!isCurrent()) throw adapterError(ADAPTER_ERROR.NOT_CURRENT); };
  const st = () => fs.serverTimestamp();
  const evRef = (col, parentId, ev) => fs.doc(s4Path(T, col, parentId, 'events', ev.eventId));
  const rejectMapped = (e) => Promise.reject(e && e.code && Object.values(ADAPTER_ERROR).includes(e.code) ? e : adapterError(mapFsError(e), e && e.message));
  const adminActor = () => ({ uid: UID, accessRole: 'admin', ansattId: ANS, accessEnabled: true, tenantId: T, canManageSchedule: true, canViewOwnSchedule: false, canViewEmployeeCore: true, canViewEmployeeCompensation: true, canEditEmployment: true });
  const todayWd = () => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs()));
  const watchers = new Set();
  const notify = () => { for (const cb of Array.from(watchers)) { try { cb(); } catch (e) { /* a failing watcher must not break the mirrors */ } } };

  // ---- employees: canonical ansatte -> Employee 360 read store (host mirror, no second listener) ----
  const employees = { [T]: {} };
  const people = () => Object.keys(employees[T]).map((k) => employees[T][k]).filter((e) => e.status === 'active').map((e) => (lacksEmploymentBaseline(e)
    ? { ansattId: e.ansattId, name: e.name, roleKey: null, unregistered: true }   // old-register title is not a role (see vaktplanPeopleFrom)
    : { ansattId: e.ansattId, name: e.name, roleKey: (currentTermsOf(e, todayWd()) || e.terms[0]).role || null }));
  function refresh() {
    const next = {};
    for (const d of (o.readAnsatte() || [])) {
      if (!d || typeof d.id !== 'string' || !ID_RE.test(d.id)) continue;
      next[d.id] = normalizeAnsatt(d.id, d);
    }
    employees[T] = next;
    notify();
    return Object.keys(next).length;
  }
  // wait (bounded) until the host mirror reflects a written revision, then refresh
  function settled(id, rev, ms) {
    const t0 = Date.now();
    return new Promise((res) => {
      const tick = () => {
        const d = (o.readAnsatte() || []).find((x) => x && x.id === id);
        const r = d && d[E360_KEY] && Number.isInteger(d[E360_KEY].rev) ? d[E360_KEY].rev : 0;
        if (r >= rev || Date.now() - t0 > (ms || 4000) || !live()) { refresh(); res(r >= rev); return; }
        setTimeout(tick, 40);
      };
      tick();
    });
  }
  // PERSISTENCE INVARIANT (initial-registration hardening), independent of the cores' own guards: a document WITHOUT a
  // stored employment block may receive that block from exactly ONE operation kind, registerInitialEmployment. It is
  // evaluated on the RAW document read inside the transaction, before the core runs and again immediately before the
  // write, so neither a stale mirror nor a direct adapter call nor a future operation kind can serialize the period that
  // normalizeAnsatt only derives from the old register.
  const rawHasBaseline = (raw) => !!(raw && raw[E360_KEY] && typeof raw[E360_KEY] === 'object');
  function refuseWithoutBaseline(raw, kind) {
    if (rawHasBaseline(raw) || kind === 'registerInitialEmployment') return;
    const err = adapterError(ADAPTER_ERROR.CORE_REFUSED, 'INITIAL_REGISTRATION_REQUIRED');
    err.coreResult = { ok: false, code: 'INITIAL_REGISTRATION_REQUIRED' };
    throw err;
  }
  function applyEmployee(op) {
    try { assertLive(); } catch (e) { return Promise.reject(e); }
    if (!op || typeof op !== 'object') return Promise.reject(adapterError(ADAPTER_ERROR.CORE_REFUSED, 'NO_OPERATION'));
    const isCreate = op.kind === 'createEmployee';
    let writtenRev = 0;
    return fs.runTransaction(async (tx) => {
      let id, prev = null;
      if (isCreate) { id = fs.newId(ansattePath(T)); if (typeof id !== 'string' || !ID_RE.test(id)) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'NEW_ID'); }
      else {
        id = op.ansattId;
        let ref; try { ref = fs.doc(ansattePath(T, id)); } catch (e) { throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'EMPLOYEE_UNKNOWN'); }
        const s = await tx.get(ref);
        if (!s || !s.exists) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'EMPLOYEE_UNKNOWN');
        prev = s.data;
        refuseWithoutBaseline(prev, op.kind);
      }
      const tenant = {}; if (prev) tenant[id] = normalizeAnsatt(id, prev);
      const now = nowMs();
      const res = applyEmployeeOperation({ store: { [T]: tenant }, tenantId: T, actor: adminActor(), op, now, timezone: TZ });
      if (!res.ok) { const err = adapterError(ADAPTER_ERROR.CORE_REFUSED, res.code); err.coreResult = res; throw err; }
      const rec = isCreate ? Object.assign({}, res.employee, { ansattId: id }) : res.employee;   // production id = Firestore document id (the core's slug id is never persisted)
      const write = ansattWriteFor(op.kind, rec, prev, now, todayWd());
      writtenRev = write[E360_KEY].rev;
      const ref = fs.doc(ansattePath(T, id));
      if (isCreate) tx.set(ref, Object.assign(legacySkeleton(now), write)); else { refuseWithoutBaseline(prev, op.kind); tx.update(ref, write); }
      return { ok: true, ansattId: id, employee: rec, kind: op.kind };
    }).then(async (r) => { await settled(r.ansattId, writtenRev); return r; }).catch((e) => (e && e.coreResult ? Promise.reject(e) : rejectMapped(e)));
  }
  // ONE tenant-profile derivation (defaults + stored _meta/contractProfile document), shared by contractProfile.load() and
  // the freeze transaction so both read company facts the same way.
  function profileFrom(d) {
    const base = clone(o.defaultContractProfile || { tenantId: T, templateVersion: null, employer: {}, representative: {}, signingPlace: null, companyFacts: {} });
    base.tenantId = T;
    return d && typeof d === 'object' && d.companyFacts ? Object.assign(base, clone(d), { tenantId: T }) : base;
  }
  function applyContract(op, profile, extra) {
    try { assertLive(); } catch (e) { return Promise.reject(e); }
    if (!op || typeof op !== 'object' || typeof op.ansattId !== 'string') return Promise.reject(adapterError(ADAPTER_ERROR.CORE_REFUSED, 'NO_OPERATION'));
    let writtenRev = 0;
    return fs.runTransaction(async (tx) => {
      let ref; try { ref = fs.doc(ansattePath(T, op.ansattId)); } catch (e) { throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'EMPLOYEE_UNKNOWN'); }
      const s = await tx.get(ref);
      if (!s || !s.exists) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'EMPLOYEE_UNKNOWN');
      const prev = s.data;
      refuseWithoutBaseline(prev, 'contract:' + op.kind);   // no contract operation before first registration
      // FREEZE reads the AUTHORITATIVE tenant profile inside the same transaction (release -007): the browser's in-memory
      // profile is never the snapshot source, and the core refuses any drift from the reviewed inputs.
      const freeze = op.kind === 'freezeVersion';
      let prof = profile;
      if (freeze) { const ps = await tx.get(fs.doc(contractProfilePath(T))); prof = profileFrom(ps && ps.exists ? ps.data : null); }
      const tenant = { [op.ansattId]: normalizeAnsatt(op.ansattId, prev) };
      const now = nowMs();
      const x = extra || {};
      // Release 019B-R2: a NEW contract version is prefilled ONCE with the employee's private master values, read from the
      // SAME transaction read of the employee document. From then on the draft's own fields are the agreement's truth: no
      // other contract operation reads the master values, and none ever writes them.
      const privateValues = op.kind === 'startDraft' ? { fodselsnummer: storedDigits('personnummer', privateRaw(prev, 'personnummer')), bankkonto: storedDigits('bankkonto', privateRaw(prev, 'bankkonto')) } : undefined;
      const res = applyContractOperation({ store: { [T]: tenant }, tenantId: T, actor: adminActor(), op, profile: prof, now, onDate: x.onDate || todayWd(), roleLabels: x.roleLabels, requireReviewedInputs: freeze, privateValues });
      if (!res.ok) { const err = adapterError(ADAPTER_ERROR.CORE_REFUSED, res.code); err.coreResult = res; throw err; }
      const rec = tenant[op.ansattId];
      const write = ansattWriteFor('contract:' + op.kind, rec, prev, now, todayWd());
      writtenRev = write[E360_KEY].rev;
      refuseWithoutBaseline(prev, 'contract:' + op.kind);
      tx.update(ref, write);
      return Object.assign({}, res, { ansattId: op.ansattId, employee: rec });
    }).then(async (r) => { await settled(r.ansattId, writtenRev); return r; }).catch((e) => (e && e.coreResult ? Promise.reject(e) : rejectMapped(e)));
  }

  // ---- PRIVATE employee fields (release 019): fødselsnummer + bankkonto --------------------------------------------
  // The EXISTING legacy fields `personnummer` / `bankkonto` on the canonical admin-only ansatte document are the one
  // home (no e360 copy, no migration). They are NOT part of normalizeAnsatt's record, so nothing that reads the Employee
  // 360 store (list, search, Oversikt, Vaktplan, payroll, employeeSelf) can carry them. The ONE exception (release
  // 019B-R2) is a contract version: applyContract prefills a NEW draft's optional Fødselsnummer / Kontonummer fields from
  // them once, after which the draft (and later its frozen snapshot) holds its own copy. Three operations:
  //   maskedPrivateEmployeeFields(id)  sync, from the host mirror: { key: { present, regular, masked } } — never a value
  //   readPrivateEmployeeFields(id)    explicit reveal / edit: ONE authoritative read of the document; resolves
  //                                    { personnummer, bankkonto } (11 digits, the stored text if irregular, or null)
  //   updatePrivateEmployeeFields(id, patch)  ONE transaction that updates ONLY the provided private keys (validated,
  //                                    digits only); no e360 / rev / legacy projection is touched. Resolves
  //                                    { ok, ansattId, fields:[keys] } — never a value. Errors carry codes only.
  const privateRaw = (d, k) => (d && typeof d[k] === 'string' && d[k].trim() !== '' ? d[k] : null);
  function maskedPrivateEmployeeFields(ansattId) {
    const d = (o.readAnsatte() || []).find((x) => x && x.id === ansattId) || null;
    const out = {};
    for (const k of PRIVATE_FIELD_KEYS) out[k] = maskPrivateField(k, privateRaw(d, k));
    return out;
  }
  function readPrivateEmployeeFields(ansattId) {
    try { assertLive(); } catch (e) { return Promise.reject(e); }
    let ref; try { ref = fs.doc(ansattePath(T, ansattId)); } catch (e) { return Promise.reject(adapterError(ADAPTER_ERROR.CORE_REFUSED, 'EMPLOYEE_UNKNOWN')); }
    return fs.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s || !s.exists) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'EMPLOYEE_UNKNOWN');
      const out = {};
      for (const k of PRIVATE_FIELD_KEYS) { const raw = privateRaw(s.data, k); out[k] = raw === null ? null : (storedDigits(k, raw) || raw.trim()); }
      return out;
    }).then((r) => { assertLive(); return r; }).catch((e) => (e && e.detail === 'EMPLOYEE_UNKNOWN' ? Promise.reject(e) : rejectMapped(e)));
  }
  function updatePrivateEmployeeFields(ansattId, patch) {
    try { assertLive(); } catch (e) { return Promise.reject(e); }
    const v = validatePrivatePatch(patch);
    if (!v.ok) { const err = adapterError(ADAPTER_ERROR.CORE_REFUSED, v.code); err.coreResult = { ok: false, code: v.code, field: v.field }; return Promise.reject(err); }
    let ref; try { ref = fs.doc(ansattePath(T, ansattId)); } catch (e) { return Promise.reject(adapterError(ADAPTER_ERROR.CORE_REFUSED, 'EMPLOYEE_UNKNOWN')); }
    const keys = Object.keys(v.write);
    return fs.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s || !s.exists) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'EMPLOYEE_UNKNOWN');
      tx.update(ref, v.write);   // ONLY the provided private keys — nothing else on the document is written
      return { ok: true, ansattId, fields: keys };
    }).then(async (r) => {
      // wait (bounded) until the host mirror shows the write so the masked view is fresh; no value leaves this closure
      const t0 = Date.now();
      await new Promise((res) => { const tick = () => { const d = (o.readAnsatte() || []).find((x) => x && x.id === ansattId); if ((d && keys.every((k) => d[k] === v.write[k])) || Date.now() - t0 > 4000 || !live()) { res(); return; } setTimeout(tick, 40); }; tick(); });
      notify();
      return r;
    }).catch((e) => (e && (e.coreResult || e.detail === 'EMPLOYEE_UNKNOWN') ? Promise.reject(e) : rejectMapped(e)));
  }

  // ---- company contract profile (tenant config document) ----
  let profileObj = null;
  const contractProfile = {
    get: () => profileObj,
    load: () => {
      try { assertLive(); } catch (e) { return Promise.reject(e); }
      return fs.runTransaction(async (tx) => { const s = await tx.get(fs.doc(contractProfilePath(T))); return s && s.exists ? s.data : null; })
        .then((d) => { profileObj = profileFrom(d); return profileObj; })
        .catch((e) => { profileObj = profileFrom(null); onError({ scope: 'contractProfile', code: mapFsError(e) }); return profileObj; });
    },
    save: () => {
      try { assertLive(); } catch (e) { return Promise.reject(e); }
      if (!profileObj) return Promise.reject(adapterError(ADAPTER_ERROR.CORE_REFUSED, 'NO_PROFILE'));
      const b = fs.batch();
      b.set(fs.doc(contractProfilePath(T)), Object.assign(clone(profileObj), { tenantId: T, updatedAt: nowMs(), updatedByUid: UID }));
      return b.commit().then(() => ({ ok: true })).catch(rejectMapped);
    },
  };

  // ---- schedule: reused management schedule adapter (S4 shifts only) ----
  const schedule = createManagementScheduleAdapters({ fs, tenantId: T, membership: m, people: [], range, isCurrent, nowMs, policy, onError,
    resolveAssignee: (a) => (employees[T][a] && employees[T][a].status === 'active' ? { status: 'FOUND', tenantId: T, ansattId: a } : { status: 'NOT_FOUND' }) });
  schedule.onChange(() => notify());

  // ---- attendance: bounded management read + the accepted commit (admin manual entry / correction / approval) ----
  const attendance = new Map();
  const attSubs = [];
  function attSubscribe() {
    const un = fs.listen({ col: s4Path(T, 'attendance'), where: [['workDate', '>=', range.from], ['workDate', '<=', range.to]] },
      (docs) => { if (!live()) return; attendance.clear(); for (const d of (Array.isArray(docs) ? docs : [])) if (d.exists !== false) attendance.set(d.id, stripServerFields(d.data)); notify(); },
      (err) => { if (!live()) return; onError({ scope: 'attendance', code: mapFsError(err) }); });
    attSubs.push(typeof un === 'function' ? un : () => {});
  }
  const commit = makeAttendanceCommitter({ fs, T, st, evRef, assertLive, rejectMapped });
  const attendanceSeam = {
    get: (id) => attendance.get(id), has: (id) => attendance.has(id), values: () => attendance.values(),
    set: () => { throw adapterError(ADAPTER_ERROR.PRODUCTION_WRITE_VIA_COMMIT); },
    commit,
  };
  const writeEmployeeSelf = makeEmployeeSelfWriter({ fs, T, st, assertLive, rejectMapped });

  let started = false;
  function start() { assertLive(); if (started) return; started = true; refresh(); schedule.start(); attSubscribe(); }
  function setRange(next) {
    assertLive();
    const n = next || {};
    if (typeof n.from !== 'string' || typeof n.to !== 'string' || !WD_RE.test(n.from) || !WD_RE.test(n.to) || n.from > n.to) throw adapterError(ADAPTER_ERROR.CORE_REFUSED, 'range');
    if (n.from === range.from && n.to === range.to) return false;
    range = { from: n.from, to: n.to };
    if (started) { for (const un of attSubs.splice(0)) { try { un(); } catch (e) { /* sweep */ } } attSubscribe(); }
    schedule.setRange(range);
    return true;
  }
  // widen instead of replace: keeps already-loaded weeks while covering a newly visible one
  function ensureRange(vis) {
    const v = vis || {};
    if (typeof v.from !== 'string' || typeof v.to !== 'string' || !WD_RE.test(v.from) || !WD_RE.test(v.to)) return false;
    if (v.from >= range.from && v.to <= range.to) return false;
    return setRange({ from: v.from < range.from ? v.from : range.from, to: v.to > range.to ? v.to : range.to });
  }
  function dispose() {
    disposed = true;
    for (const un of attSubs.splice(0)) { try { un(); } catch (e) { /* sweep */ } }
    schedule.dispose();
    attendance.clear(); employees[T] = {}; watchers.clear();
  }
  function listenerCount() { return schedule.listenerCount() + attSubs.length; }
  function onChange(cb) { if (typeof cb !== 'function') return () => {}; watchers.add(cb); return () => { watchers.delete(cb); }; }

  return {
    schedule: { store: schedule.schedule.store, admin: schedule.schedule.admin },
    attendance: attendanceSeam,
    employees: { store: () => employees, refresh, apply: applyEmployee, applyContract, people, privateFields: Object.freeze({ masked: maskedPrivateEmployeeFields, read: readPrivateEmployeeFields, update: updatePrivateEmployeeFields }) },
    employeeSelf: { write: writeEmployeeSelf },
    contractProfile,
    start, dispose, listenerCount, onChange, setRange, ensureRange,
    currentRange: () => ({ from: range.from, to: range.to }),
    identity: Object.freeze({ tenantId: T, ansattId: ANS, uid: UID, accessRole: 'admin' }),
  };
}
