// employee-shell-core.test.mjs
// ETR-1 core model tests. Node built-ins only (node:assert/strict). No packages.
// Run: node employee-shell-core.test.mjs   (exit 0 = all pass, 1 = any fail)

import assert from 'node:assert/strict';
import {
  resolveRouting,
  eligibleMemberships,
  selectMembership,
  ownShifts,
} from './employee-shell-core.mjs';

let passed = 0;
let failed = 0;
const lines = [];
function t(name, fn) {
  try {
    fn();
    passed++;
    lines.push('PASS  ' + name);
  } catch (e) {
    failed++;
    lines.push('FAIL  ' + name + '  ::  ' + (e && e.message ? e.message : e));
  }
}

// Synthetic memberships (no real data).
const mOneA = { uid: 'U_ONE', tenantId: 't-alpha', accessRole: 'employee', ansattId: 'ans-a1', accessEnabled: true };
const mManyA = { uid: 'U_MANY', tenantId: 't-alpha', accessRole: 'employee', ansattId: 'ans-a2', accessEnabled: true };
const mManyB = { uid: 'U_MANY', tenantId: 't-beta', accessRole: 'employee', ansattId: 'ans-b7', accessEnabled: true };
const mDisabled = { uid: 'U_ZERO', tenantId: 't-alpha', accessRole: 'employee', ansattId: 'ans-z9', accessEnabled: false };
const mOther = { uid: 'U_OTHER', tenantId: 't-alpha', accessRole: 'employee', ansattId: 'ans-o3', accessEnabled: true };
const mNoAnsatt = { uid: 'U_ADMIN', tenantId: 't-alpha', accessRole: 'admin', ansattId: null, accessEnabled: true };

const ALL = [mOneA, mManyA, mManyB, mDisabled, mOther, mNoAnsatt];

const shifts = [
  { id: 's1', ansattId: 'ans-a1', dato: '2026-08-20', fra: '08:00', til: '12:00' },
  { id: 's2', ansattId: 'ans-a2', dato: '2026-08-20', fra: '09:00', til: '15:00' },
  { id: 's3', ansattId: 'ans-b7', dato: '2026-08-21', fra: '10:00', til: '18:00' },
  { id: 's4', ansattId: 'ans-o3', dato: '2026-08-21', fra: '07:00', til: '11:00' },
  { id: 's5', ansattId: 'ans-a1', dato: '2026-08-22', timer: 5 },
];

// 1. zero memberships -> no-access
t('1 zero memberships -> no-access', () => {
  assert.equal(resolveRouting([], 'U_ONE').kind, 'no-access');
  assert.equal(resolveRouting(ALL, 'U_NOBODY').kind, 'no-access');
});

// 2. one enabled exact-UID membership -> direct
t('2 one enabled exact-UID -> direct', () => {
  const r = resolveRouting(ALL, 'U_ONE');
  assert.equal(r.kind, 'direct');
  assert.equal(r.membership.tenantId, 't-alpha');
  assert.equal(r.membership.ansattId, 'ans-a1');
});

// 3. multiple enabled exact-UID memberships -> picker
t('3 multiple enabled exact-UID -> picker', () => {
  const r = resolveRouting(ALL, 'U_MANY');
  assert.equal(r.kind, 'picker');
  assert.equal(r.memberships.length, 2);
});

// 4. disabled membership is ignored
t('4 disabled membership ignored', () => {
  assert.equal(eligibleMemberships(ALL, 'U_ZERO').length, 0);
  assert.equal(resolveRouting(ALL, 'U_ZERO').kind, 'no-access');
});

// 5. membership belonging to a different UID never leaks into eligibility
t('5 different-UID never leaks', () => {
  const elig = eligibleMemberships(ALL, 'U_ONE');
  assert.equal(elig.length, 1);
  assert.ok(elig.every((m) => m.uid === 'U_ONE'));
});

// 6. door selection cannot select a tenant not present in eligible memberships
t('6 door selection constrained to eligible tenants', () => {
  const r = resolveRouting(ALL, 'U_MANY');
  assert.equal(selectMembership(r.eligible, 't-gamma'), null); // not eligible -> null
  const sel = selectMembership(r.eligible, 't-beta');
  assert.ok(sel && sel.tenantId === 't-beta' && sel.ansattId === 'ans-b7');
});

// 7. own shifts include only selected membership ansattId
t('7 own shifts scoped to selected ansattId', () => {
  const r = resolveRouting(ALL, 'U_MANY');
  const selA = selectMembership(r.eligible, 't-alpha'); // ans-a2
  const own = ownShifts(shifts, selA);
  assert.equal(own.length, 1);
  assert.ok(own.every((s) => s.ansattId === 'ans-a2'));
});

// 8. missing/null ansattId returns zero own shifts
t('8 null ansattId -> zero own shifts', () => {
  assert.equal(ownShifts(shifts, mNoAnsatt).length, 0);
  assert.equal(ownShifts(shifts, { ansattId: '' }).length, 0);
  assert.equal(ownShifts(shifts, {}).length, 0);
});

// 9. same human fixture with two memberships -> different own-shift sets (per-membership ansattId)
t('9 per-membership ansattId yields different own-shift sets', () => {
  const r = resolveRouting(ALL, 'U_MANY');
  const selA = selectMembership(r.eligible, 't-alpha'); // ans-a2
  const selB = selectMembership(r.eligible, 't-beta'); // ans-b7
  const ownA = ownShifts(shifts, selA).map((s) => s.id).sort();
  const ownB = ownShifts(shifts, selB).map((s) => s.id).sort();
  assert.deepEqual(ownA, ['s2']);
  assert.deepEqual(ownB, ['s3']);
  assert.notDeepEqual(ownA, ownB);
});

console.log(lines.join('\n'));
console.log('\nETR1_CORE_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
