// employee-production-bridge.test.mjs
// EMPLOYEE PRODUCTION BRIDGE — proofs A..J of SIRRHA-CCODE-EMPLOYEE-PRODUCTION-BRIDGE-LOCAL-BUILD-RELEASE-001.
// Node built-ins only. Run: node employee-production-bridge.test.mjs   (exit 0 = all pass)
//
// SCOPE: the pure entry/adapter bridge and the shell's use of it. Product truth (clock, schedule,
// employment) stays proven by the existing batteries, re-run unchanged. Source guards match single
// lines only, so they are line-ending independent.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateProductionIdentity, resolveEmployeeEntry, validateAdapters, denialMessage,
  PRODUCTION_IDENTITY_FIELDS, EMPLOYEE_SURFACE_ROLES, ENTRY_MODES, ADAPTER_CONTRACT, DENIAL,
} from './employee-production-bridge.mjs';
import { ownShifts, isUsableMembership, ETR2A_POLICY } from './employee-shell-core.mjs';
import { ownShiftsForMembership } from './employee-schedule-week.mjs';
import { buildFourSeasonSchedule, FOUR_SEASON_TENANT, FOUR_SEASON_MEMBERSHIPS } from './employee-schedule-fixture.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const shellSrc = read('./employee-shell-ui.mjs');
const htmlSrc = read('./employee-shell.html');
const bridgeSrc = read('./employee-production-bridge.mjs');
const strip = (s) => s.replace(/\/\/.*$/gm, '');
const T = FOUR_SEASON_TENANT.tenantId;
const VALID = { uid: 'auth-abc', tenantId: T, accessRole: 'employee', ansattId: 'ans-maria', accessEnabled: true };
const prod = (identity, extra) => resolveEmployeeEntry(Object.assign({ mode: 'production', identity, expectedTenantId: T }, extra || {}));
const mountHead = shellSrc.slice(shellSrc.indexOf('export function mountEmployeeShell('), shellSrc.indexOf('  function goChooser()'));
const landing = shellSrc.slice(shellSrc.indexOf('// ---- Landing:'), shellSrc.indexOf('export function mountEmployeePreview('));
const routeFn = shellSrc.slice(shellSrc.indexOf('  function route(uid)'), shellSrc.indexOf('  function goNoAccess()'));
const chooserFn = shellSrc.slice(shellSrc.indexOf('  function goChooser()'), shellSrc.indexOf('  function route(uid)'));
const deniedFn = shellSrc.slice(shellSrc.indexOf('  function goDenied(code)'), shellSrc.indexOf('  function goChooser()'));
// Runtime modules = every .mjs in the employee/management/schedule product that is not a test.
const runtimeModules = fs.readdirSync(new URL('./', import.meta.url))
  .filter((f) => /\.mjs$/.test(f) && !/\.test\.mjs$/.test(f) && /^(employee-|management-|schedule-core)/.test(f));

// ---- A: production cannot route through DEFAULT_UID -------------------------------------------
t('A1', 'production entry with no identity is denied (never the default review identity)', () => {
  const r = prod(undefined);
  assert.equal(r.kind, 'denied'); assert.equal(r.mode, 'production'); assert.equal(r.code, DENIAL.IDENTITY_MISSING);
  assert.ok(!('membership' in r) && !('defaultUid' in r));
});
t('A2', 'shell: DEFAULT_UID is read only inside the preview branch; the old unconditional route(DEFAULT_UID) landing is gone', () => {
  assert.ok(!shellSrc.includes('route(DEFAULT_UID)'), 'route(DEFAULT_UID) must not exist');
  const uses = strip(shellSrc).split('\n').filter((l) => l.includes('DEFAULT_UID') && !l.includes('const DEFAULT_UID'));
  assert.equal(uses.length, 1, 'exactly one runtime read of DEFAULT_UID');
  assert.ok(uses[0].includes("MODE === 'preview' ? { memberships: FIXTURE_MEMBERSHIPS, defaultUid: DEFAULT_UID } : undefined"), uses[0]);
  assert.ok(landing.includes("if (entry.kind === 'preview') route(entry.defaultUid);"));
  assert.ok(landing.includes("else if (entry.kind === 'production' && adapterCheck.ok) goToday(entry.membership);"));
  assert.ok(landing.includes("else goDenied(entry.kind === 'denied' ? entry.code : DENIAL.ADAPTERS_MISSING);"));
});

// ---- B: production cannot route through chooser authority --------------------------------------
t('B1', 'production ignores any preview configuration handed to it (no implicit fallback)', () => {
  const r = resolveEmployeeEntry({ mode: 'production', identity: undefined, expectedTenantId: T, preview: { memberships: FOUR_SEASON_MEMBERSHIPS, defaultUid: 'uid-maria' } });
  assert.equal(r.kind, 'denied'); assert.equal(r.code, DENIAL.IDENTITY_MISSING);
  const r2 = resolveEmployeeEntry({ mode: 'production', identity: VALID, expectedTenantId: T, preview: { memberships: FOUR_SEASON_MEMBERSHIPS, defaultUid: 'uid-maria' } });
  assert.equal(r2.kind, 'production'); assert.equal(r2.membership.uid, 'auth-abc');
});
t('B2', 'shell: route() and goChooser() refuse outside preview; the identity button is not a switch in production', () => {
  assert.ok(routeFn.includes("if (MODE !== 'preview') return goDenied(DENIAL.CHOOSER_PREVIEW_ONLY);"));
  assert.ok(chooserFn.includes("if (MODE !== 'preview') return current ? goToday(current) : goDenied(DENIAL.CHOOSER_PREVIEW_ONLY);"));
  assert.ok(shellSrc.includes("idb.hidden = false; idb.onclick = MODE === 'preview' ? goChooser : null;"));
  assert.ok(shellSrc.includes("idb.setAttribute('aria-label', MODE === 'preview' ? 'Bytt ansatt' : 'Innlogget');"));
  assert.ok(!/FIXTURE_USERS|FIXTURE_MEMBERSHIPS|resolveRouting/.test(strip(deniedFn)), 'the denied panel touches no fixture identity');
});
t('B3', 'shell: the Ledelse doorway and the fixture manager actor are preview-only', () => {
  assert.ok(shellSrc.includes("if (MODE !== 'preview') return tabs;"));
  assert.equal((shellSrc.match(/if \(MODE !== 'preview' \|\| !canOpenVaktplan\(FOUR_SEASON_MANAGER_ACTOR\)\) return goChooser\(\);/g) || []).length, 2);
});

// ---- C: missing identity fails closed -----------------------------------------------------------
t('C1', 'null / undefined identity -> IDENTITY_MISSING', () => {
  for (const v of [null, undefined]) { const r = validateProductionIdentity(v, { expectedTenantId: T }); assert.equal(r.ok, false); assert.equal(r.code, DENIAL.IDENTITY_MISSING); }
});

// ---- D: malformed identity fails closed ---------------------------------------------------------
t('D1', 'non-object / missing or wrongly typed fields -> IDENTITY_MALFORMED; missing ansattId -> IDENTITY_ANSATT_MISSING', () => {
  const bad = ['auth-abc', 42, true, [VALID], {}, { ...VALID, uid: '' }, { ...VALID, uid: 7 }, { ...VALID, tenantId: '' },
    { ...VALID, accessRole: '' }, { ...VALID, accessEnabled: 'true' }, { ...VALID, accessEnabled: 1 }, { ...VALID, ansattId: '' }, { ...VALID, ansattId: 5 }];
  for (const b of bad) { const r = validateProductionIdentity(b, { expectedTenantId: T }); assert.equal(r.ok, false, JSON.stringify(b)); assert.equal(r.code, DENIAL.IDENTITY_MALFORMED, JSON.stringify(b)); }
  for (const b of [{ ...VALID, ansattId: null }, (() => { const c = { ...VALID }; delete c.ansattId; return c; })()]) {
    const r = validateProductionIdentity(b, { expectedTenantId: T }); assert.equal(r.ok, false); assert.equal(r.code, DENIAL.IDENTITY_ANSATT_MISSING);
  }
});
t('D2', 'a mount without an expected tenant fails closed (configuration is not optional)', () => {
  for (const o of [undefined, {}, { expectedTenantId: '' }, { expectedTenantId: 7 }]) { const r = validateProductionIdentity(VALID, o); assert.equal(r.ok, false); assert.equal(r.code, DENIAL.CONFIG_TENANT_MISSING); }
});
t('D3', 'tenant mismatch fails closed before enabled/role are considered', () => {
  const r = validateProductionIdentity({ ...VALID, tenantId: 'other-tenant', accessEnabled: false, accessRole: 'viewer' }, { expectedTenantId: T });
  assert.equal(r.ok, false); assert.equal(r.code, DENIAL.IDENTITY_TENANT_MISMATCH);
});

// ---- E: accessEnabled=false fails closed --------------------------------------------------------
t('E1', 'accessEnabled false -> IDENTITY_DISABLED (correct tenant and role)', () => {
  const r = validateProductionIdentity({ ...VALID, accessEnabled: false }, { expectedTenantId: T });
  assert.equal(r.ok, false); assert.equal(r.code, DENIAL.IDENTITY_DISABLED);
  assert.equal(prod({ ...VALID, accessEnabled: false }).code, DENIAL.IDENTITY_DISABLED);
});

// ---- F: wrong accessRole fails closed -----------------------------------------------------------
t('F1', 'roles outside the employee surface set are refused; employee and admin (with ansattId) pass', () => {
  for (const role of ['viewer', 'regnskap', 'manager', 'staff', 'EMPLOYEE', 'owner']) {
    const r = validateProductionIdentity({ ...VALID, accessRole: role }, { expectedTenantId: T }); assert.equal(r.ok, false, role); assert.equal(r.code, DENIAL.IDENTITY_ROLE_INVALID, role);
  }
  assert.deepEqual([...EMPLOYEE_SURFACE_ROLES], ['employee', 'admin']);
  for (const role of EMPLOYEE_SURFACE_ROLES) assert.equal(validateProductionIdentity({ ...VALID, accessRole: role }, { expectedTenantId: T }).ok, true, role);
  assert.equal(validateProductionIdentity(VALID, { expectedTenantId: T, allowedRoles: ['employee'] }).ok, true);
  assert.equal(validateProductionIdentity({ ...VALID, accessRole: 'admin' }, { expectedTenantId: T, allowedRoles: ['employee'] }).code, DENIAL.IDENTITY_ROLE_INVALID);
});

// ---- G: a valid identity reaches only its own employee context ----------------------------------
t('G1', 'membership is exactly the five authority fields, frozen; claims/email/foreign roles are dropped', () => {
  const r = validateProductionIdentity({ ...VALID, claims: { role: 'admin', tenantId: 'other' }, email: 'x@y', role: 'admin', displayName: 'X' }, { expectedTenantId: T });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.membership).sort(), [...PRODUCTION_IDENTITY_FIELDS].sort());
  assert.deepEqual(r.membership, { uid: 'auth-abc', tenantId: T, accessRole: 'employee', ansattId: 'ans-maria', accessEnabled: true });
  assert.ok(Object.isFrozen(r.membership));
  assert.ok(isUsableMembership(r.membership), 'usable by the existing core routing helpers');
});
t('G2', 'own-shift projection from the validated membership yields only that ansattId, in the expected tenant', () => {
  const m = prod(VALID).membership;
  const schedule = buildFourSeasonSchedule('2026-09-25', ETR2A_POLICY.timezone);
  const mine = ownShiftsForMembership(schedule, m);
  assert.ok(mine.length > 0, 'the review identity has shifts in the fixture');
  for (const s of mine) assert.equal(s.projection.ansattId, 'ans-maria');
  const flat = Object.values(schedule[T]).map((p) => ({ ansattId: p.ansattId }));
  assert.ok(ownShifts(flat, m).every((s) => s.ansattId === 'ans-maria'));
  const other = prod({ ...VALID, ansattId: 'ans-aboud' }).membership;
  assert.ok(ownShiftsForMembership(schedule, other).every((s) => s.projection.ansattId === 'ans-aboud'));
  assert.equal(prod({ ...VALID, tenantId: 'another-store' }).kind, 'denied');
});
t('G3', 'shell: the actor handed to the core operations carries the validated accessEnabled, not a literal', () => {
  assert.ok(shellSrc.includes('accessEnabled: m.accessEnabled === true, tenantId: m.tenantId'));
  assert.ok(!shellSrc.includes('accessEnabled: true, tenantId: m.tenantId'));
});

// ---- H: explicit preview mode still works ---------------------------------------------------------
t('H1', 'preview entry is explicit and returns the fixture chooser inputs; misconfigured or unnamed modes are denied', () => {
  const p = resolveEmployeeEntry({ mode: 'preview', preview: { memberships: FOUR_SEASON_MEMBERSHIPS, defaultUid: 'uid-maria' } });
  assert.equal(p.kind, 'preview'); assert.equal(p.defaultUid, 'uid-maria'); assert.equal(p.memberships, FOUR_SEASON_MEMBERSHIPS);
  assert.equal(resolveEmployeeEntry({ mode: 'preview' }).code, DENIAL.PREVIEW_CONFIG_INVALID);
  for (const mode of [undefined, null, '', 'prod', 'PRODUCTION', 'demo', 0]) { const r = resolveEmployeeEntry({ mode }); assert.equal(r.kind, 'denied', String(mode)); assert.equal(r.code, DENIAL.MODE_INVALID, String(mode)); }
  assert.equal(resolveEmployeeEntry().code, DENIAL.MODE_INVALID);
  assert.deepEqual([...ENTRY_MODES], ['production', 'preview']);
});
t('H2', 'shell/page: two structurally distinct doors; the preview page names preview; no default mode in mount', () => {
  assert.ok(shellSrc.includes("export function mountEmployeePreview(root) { return mountEmployeeShell(root, { mode: 'preview' }); }"));
  assert.ok(shellSrc.includes('export function mountEmployeeProduction(root, { identity, expectedTenantId, adapters } = {}) {'));
  assert.ok(shellSrc.includes("return mountEmployeeShell(root, { mode: 'production', identity, expectedTenantId, adapters });"));
  assert.ok(htmlSrc.includes('.then((m) => m.mountEmployeePreview(root))'));
  assert.ok(!htmlSrc.includes('m.mountEmployeeShell(root)'), 'the page no longer calls the generic mount');
  assert.ok(mountHead.includes("const MODE = opts.mode === 'preview' || opts.mode === 'production' ? opts.mode : null;"));
  assert.ok(mountHead.includes("ADAPTERS = MODE === 'preview' ? createPreviewAdapters() : (adapterCheck.ok ? opts.adapters : null);"));
  assert.equal((shellSrc.match(/createPreviewAdapters\(\)/g) || []).length, 2, 'declared once, bound once (preview only)');
  assert.ok(htmlSrc.includes("get('emp') === '1'"), 'preview page keeps its explicit ?emp=1 gate');
});
t('H3', 'preview keeps ONE schedule truth and ONE attendance truth behind the seams (no second store)', () => {
  assert.equal((shellSrc.match(/function scheduleStore\(\) \{ return ADAPTERS\.schedule\.store\(\); \}/g) || []).length, 1);
  assert.equal((shellSrc.match(/function employeeStore\(\) \{ return ADAPTERS\.employees\.store\(\); \}/g) || []).length, 1);
  assert.equal((shellSrc.match(/function previewScheduleStore\(\)/g) || []).length, 1);
  assert.equal((shellSrc.match(/function previewEmployeeStore\(\)/g) || []).length, 1);
  assert.equal((shellSrc.match(/^let attendanceStore = null;/gm) || []).length, 1);
  assert.equal((shellSrc.match(/attendanceStore = ADAPTERS \? ADAPTERS\.attendance : new Map\(\);/g) || []).length, 1);
  assert.ok(!/const attendanceStore/.test(shellSrc));
  const stores = strip(shellSrc).split('\n').filter((l) => /SCHEDULE_STORE = /.test(l) && !/let SCHEDULE_STORE/.test(l));
  assert.equal(stores.length, 2, 'seeded only inside previewScheduleStore (normal + scale set)');
  const empSeeds = strip(shellSrc).split('\n').filter((l) => /EMPLOYEE_STORE = /.test(l) && !/let EMPLOYEE_STORE/.test(l));
  assert.equal(empSeeds.length, 1, 'employee store seeded only inside previewEmployeeStore');
  // clock/break writers unchanged: attendance is written only from successful core results
  // S4 foundation: the three employee writers go through ONE persistence seam; the preview Map path is the
  // single direct set() inside persistAttendance (unchanged preview behaviour); production uses commit().
  assert.equal((shellSrc.match(/(?<!function )persistAttendance\(attId, res, rerun\)/g) || []).length, 3, 'three call sites (definition excluded)');
  assert.equal((shellSrc.match(/function persistAttendance\(attId, res, rerun\)/g) || []).length, 1);
  assert.equal((shellSrc.match(/attendanceStore\.set\(attId, res\.attendance\)/g) || []).length, 1);
  assert.ok(shellSrc.includes("if (attendanceStore && typeof attendanceStore.commit === 'function') {"));
});

// ---- I: zero Firebase initialization in employee runtime modules -------------------------------
t('I1', 'no firebase / initializeApp / firestore / auth SDK reference in any employee runtime module or the preview page', () => {
  assert.ok(runtimeModules.length >= 15, 'module list resolved: ' + runtimeModules.length);
  // S4 foundation: employee-production-adapters.mjs is the GOVERNED adapter (REV3 paths); it still imports no SDK
  // and never initializes anything — its datastore access is the injected `fs` capability only.
  const re = /initializeApp|from ['"]firebase|require\(['"]firebase|getAuth|onAuthStateChanged|signInWith|getIdToken|firebase\./i;
  for (const f of runtimeModules) assert.ok(!re.test(strip(read('./' + f))), f + ' references the Firebase SDK');
  const adapterSrc = strip(read('./employee-production-adapters.mjs'));
  assert.ok(!/^\s*import .*firebase/m.test(adapterSrc) && !/initializeApp|firestore\(|getFirestore|collection\(|onSnapshot\(|serverTimestamp\(\)\s*[^;]*firebase/.test(adapterSrc), 'adapter imports/initializes no Firebase');
  assert.ok(/fs\.doc\(|fs\.listen\(|fs\.runTransaction\(|fs\.batch\(|fs\.serverTimestamp\(/.test(adapterSrc), 'adapter uses only the injected capability');
  const htmlNoComments = htmlSrc.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/<script[^>]*src=["'][^"']*firebase/i.test(htmlNoComments), 'preview page loads no Firebase script');
  assert.ok(!/firebase\.|initializeApp\(|gstatic\.com\/firebasejs/i.test(strip(htmlNoComments)), 'preview page calls no Firebase API');
  assert.ok(runtimeModules.includes('employee-production-bridge.mjs'));
});

// ---- J: no speculative network / Firestore adapter -----------------------------------------------
t('J1', 'no fetch/XHR/WebSocket/Firestore call shape in runtime modules; the bridge is import-free and defines a contract only', () => {
  // Network primitives are forbidden everywhere. Firestore call SHAPES are forbidden in every module except the
  // governed adapter (REV3 accepted exact paths), where they must be the injected capability (fs./tx./b.) only.
  const netRe = /fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB/;
  const shapeRe = /\.collection\(|onSnapshot|runTransaction|\.doc\(/;
  for (const f of runtimeModules) {
    const s = strip(read('./' + f));
    assert.ok(!netRe.test(s), f + ' contains a network/storage primitive');
    if (f !== 'employee-production-adapters.mjs') assert.ok(!shapeRe.test(s), f + ' contains a Firestore call shape');
  }
  const adapterCode = strip(read('./employee-production-adapters.mjs'));
  const shapes = adapterCode.match(/\b[A-Za-z_]+\.(doc|runTransaction|batch|listen|serverTimestamp)\(/g) || [];
  assert.ok(shapes.length > 0 && shapes.every((s) => /^(fs|tx|b)\./.test(s)), 'adapter datastore calls are injected-capability calls only: ' + shapes.filter((s) => !/^(fs|tx|b)\./.test(s)).join(','));
  assert.ok(!/\.collection\(|onSnapshot\(/.test(adapterCode), 'adapter never touches a Firestore SDK surface directly');
  assert.ok(!/^\s*import\s/m.test(bridgeSrc), 'bridge has no imports');
  assert.deepEqual(JSON.parse(JSON.stringify(ADAPTER_CONTRACT)), { schedule: ['store'], attendance: ['get', 'set', 'has'], employees: ['store'] });
  assert.ok(!/['"`]tenants\/|['"`]memberships['"`]|['"`]ansatte['"`]|['"`]vakter['"`]|['"`]attendance['"`]\s*\)|\.collection\(/.test(strip(bridgeSrc)), 'bridge names no production path literal');
});
t('J2', 'validateAdapters fails closed on any missing seam method and accepts a complete set', () => {
  const full = { schedule: { store: () => ({}) }, attendance: new Map(), employees: { store: () => ({}) } };
  assert.deepEqual(validateAdapters(full), { ok: true, missing: [] });
  assert.equal(validateAdapters(undefined).ok, false);
  assert.deepEqual(validateAdapters({}).missing, ['schedule', 'attendance', 'employees']);
  assert.deepEqual(validateAdapters({ ...full, attendance: { get() {}, set() {} } }).missing, ['attendance.has']);
  assert.deepEqual(validateAdapters({ ...full, schedule: {} }).missing, ['schedule.store']);
});
t('J3', 'denial wording is neutral Norwegian and never echoes identifiers', () => {
  for (const c of Object.values(DENIAL)) { const m = denialMessage(c); assert.ok(typeof m === 'string' && m.length > 10, c); assert.ok(!/uid|ansatt-|auth-|tenant-|undefined|null/i.test(m.replace(/ansattsiden|ansatt ennå/gi, '')), c + ': ' + m); }
  assert.ok(deniedFn.includes('denialMessage(code)') && deniedFn.includes("idb.hidden = true") && deniedFn.includes('nav.hidden = true'));
});

for (const l of lines) console.log(l);
console.log('EMPLOYEE_PRODUCTION_BRIDGE_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
