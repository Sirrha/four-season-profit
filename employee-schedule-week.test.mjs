// employee-schedule-week.test.mjs
// EMPLOYEE WEEK SCHEDULE — pure week/fixture/read-boundary tests. Node built-ins only.
// All dates/timezones INJECTED. Run: node employee-schedule-week.test.mjs (also under TZ=...).

import assert from 'node:assert/strict';
import {
  addDays, isoWeekMonday, isoWeekNumber, isOvernight, weekFor, ownShiftsForMembership, todayShiftOf, nextUpcomingShift,
  todayShiftsOf, heroShiftFor,
} from './employee-schedule-week.mjs';
import { buildFourSeasonSchedule, FOUR_SEASON_MEMBERSHIPS, FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE } from './employee-schedule-fixture.mjs';
import { SHIFT_STATUSES } from './schedule-core.mjs';
import { tenantLocalHMToUtcMs, startOfTenantLocalDayUtcMs, endOfTenantLocalDayUtcMs, tenantWorkDate } from './employee-shell-core.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }
const TZ = 'Europe/Oslo';
const FROZEN = ['ansattId', 'plannedStartAt', 'plannedEndAt', 'workDate', 'roleKey', 'status', 'revision', 'createdByUid', 'createdAt', 'updatedAt'];
const mem = (ansattId) => FOUR_SEASON_MEMBERSHIPS.find((m) => m.ansattId === ansattId);
const sh = (id, ansattId, workDate, from, to, status, tz = TZ) => {
  const endDate = to < from ? addDays(workDate, 1) : workDate;
  return { shiftId: id, projection: { ansattId, plannedStartAt: tenantLocalHMToUtcMs(workDate, from, tz), plannedEndAt: tenantLocalHMToUtcMs(endDate, to, tz), workDate, roleKey: null, status: status || 'assigned', revision: 1, createdByUid: 'u', createdAt: 0, updatedAt: 0 } };
};

// ---- calendar math ----
t('W1', 'addDays crosses month and year boundaries', () => { assert.equal(addDays('2026-08-31', 1), '2026-09-01'); assert.equal(addDays('2026-12-31', 1), '2027-01-01'); assert.equal(addDays('2026-03-01', -1), '2026-02-28'); assert.equal(addDays('2028-03-01', -1), '2028-02-29'); });
t('W2', 'isoWeekMonday: Monday-first, Sunday belongs to the preceding Monday', () => { assert.equal(isoWeekMonday('2026-08-26'), '2026-08-24'); assert.equal(isoWeekMonday('2026-08-24'), '2026-08-24'); assert.equal(isoWeekMonday('2026-08-30'), '2026-08-24'); assert.equal(isoWeekMonday('2026-08-31'), '2026-08-31'); });
t('W3', 'isoWeekNumber matches ISO-8601 (incl. year edges)', () => { assert.equal(isoWeekNumber('2026-08-26'), 35); assert.equal(isoWeekNumber('2026-01-01'), 1); assert.equal(isoWeekNumber('2027-01-01'), 53); assert.equal(isoWeekNumber('2024-12-30'), 1); });
t('W4', 'weekFor returns exactly seven consecutive days Monday..Sunday for any anchor', () => {
  for (const anchor of ['2026-08-24', '2026-08-26', '2026-08-30']) {
    const w = weekFor(anchor, TZ, [], null);
    assert.equal(w.days.length, 7); assert.equal(w.monday, '2026-08-24'); assert.equal(w.sunday, '2026-08-30');
    for (let i = 0; i < 7; i++) assert.equal(w.days[i].workDate, addDays('2026-08-24', i));
    assert.ok(w.days.every((d) => d.shifts.length === 0 && d.isToday === false));
  }
});
t('W5', 'today is marked exactly once, only from the injected todayWorkDate', () => { const w = weekFor('2026-08-26', TZ, [], '2026-08-28'); assert.deepEqual(w.days.map((d) => d.isToday), [false, false, false, false, true, false, false]); assert.ok(weekFor('2026-08-26', TZ, [], '2026-09-02').days.every((d) => !d.isToday)); });

// ---- placement / overnight / sorting ----
t('W6', 'shift is placed by workDate, not by start instant; overnight stays on its workDate only', () => {
  const s = sh('a', 'x', '2026-08-28', '22:00', '02:00');
  const w = weekFor('2026-08-26', TZ, [s], null);
  assert.equal(w.days[4].shifts.length, 1); assert.equal(w.days[5].shifts.length, 0);
  assert.equal(w.days[4].shifts[0].overnight, true); assert.equal(isOvernight(s.projection, TZ), true);
  assert.equal(isOvernight(sh('b', 'x', '2026-08-28', '07:00', '15:00').projection, TZ), false);
  assert.equal(tenantWorkDate(s.projection.plannedEndAt, TZ), '2026-08-29');
});
t('W7', 'shifts within a day are sorted by plannedStartAt regardless of input order', () => {
  const w = weekFor('2026-08-26', TZ, [sh('late', 'x', '2026-08-26', '16:00', '20:00'), sh('early', 'x', '2026-08-26', '07:00', '11:00')], null);
  assert.deepEqual(w.days[2].shifts.map((s) => s.shiftId), ['early', 'late']);
});
t('W8', 'week-seam shift (Sunday 22:00 -> Monday 02:00) appears exactly once, in the previous week only', () => {
  const seam = sh('seam', 'x', '2026-08-23', '22:00', '02:00');
  const prev = weekFor('2026-08-19', TZ, [seam], null), cur = weekFor('2026-08-26', TZ, [seam], null);
  assert.equal(prev.days[6].shifts.length, 1); assert.equal(prev.days[6].shifts[0].overnight, true);
  assert.equal(cur.days.reduce((n, d) => n + d.shifts.length, 0), 0);
});
t('W9', 'cancelled shift is retained on its day with status cancelled (never re-labelled)', () => {
  const w = weekFor('2026-08-26', TZ, [sh('c', 'x', '2026-08-29', '09:00', '13:00', 'cancelled')], null);
  assert.equal(w.days[5].shifts[0].projection.status, 'cancelled');
});
t('W10', 'nextUpcomingShift picks the earliest assigned shift strictly after now; cancelled/open never qualify', () => {
  const list = [sh('past', 'x', '2026-08-25', '07:00', '15:00'), sh('canc', 'x', '2026-08-27', '07:00', '15:00', 'cancelled'), sh('open', null, '2026-08-27', '08:00', '12:00', 'open'), sh('next', 'x', '2026-08-28', '10:00', '14:00'), sh('later', 'x', '2026-08-29', '10:00', '14:00')];
  const now = tenantLocalHMToUtcMs('2026-08-26', '13:00', TZ);
  assert.equal(nextUpcomingShift(list, now).shiftId, 'next');
  assert.equal(nextUpcomingShift(list, tenantLocalHMToUtcMs('2026-08-29', '10:00', TZ)), null);
  assert.equal(todayShiftOf(list, '2026-08-27'), null); assert.equal(todayShiftOf(list, '2026-08-28').shiftId, 'next');
});
t('W11', 'Europe/Oslo DST weeks (2026-03-29 start, 2026-10-25 end) stay seven days with correct placement/overnight', () => {
  for (const [anchor, sunday] of [['2026-03-25', '2026-03-29'], ['2026-10-21', '2026-10-25']]) {
    const sat = addDays(sunday, -1);
    const w = weekFor(anchor, TZ, [sh('sat', 'x', sat, '22:00', '02:00'), sh('sun', 'x', sunday, '08:00', '16:00')], null);
    assert.equal(w.days.length, 7); assert.equal(w.days[6].workDate, sunday);
    assert.equal(w.days[5].shifts[0].overnight, true); assert.equal(w.days[6].shifts[0].overnight, false);
    assert.equal(tenantWorkDate(w.days[5].shifts[0].projection.plannedEndAt, TZ), sunday);
    assert.equal(w.days[6].shifts[0].projection.plannedEndAt - w.days[6].shifts[0].projection.plannedStartAt, 8 * 3600000);
  }
});

// ---- fixture shape ----
const ANCHOR = '2026-08-26';
const schedule = buildFourSeasonSchedule(ANCHOR, TZ);
const tenant = schedule[FOUR_SEASON_TENANT.tenantId];
t('F1', 'container is tenant-keyed with exactly one tenant; ids unique; projections carry EXACTLY the ten frozen fields', () => {
  assert.deepEqual(Object.keys(schedule), ['four-season']);
  const ids = Object.keys(tenant); assert.ok(ids.length > 20); assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) { assert.deepEqual(Object.keys(tenant[id]).sort(), FROZEN.slice().sort(), id); assert.ok(!('tenantId' in tenant[id]) && !('shiftId' in tenant[id])); }
});
t('F2', 'every projection: status in SHIFT_STATUSES, start within its workDate local day, end > start, revision 1', () => {
  for (const [id, p] of Object.entries(tenant)) {
    assert.ok(SHIFT_STATUSES.includes(p.status), id);
    const s0 = startOfTenantLocalDayUtcMs(p.workDate, TZ), s1 = endOfTenantLocalDayUtcMs(p.workDate, TZ, 0);
    assert.ok(p.plannedStartAt >= s0 && p.plannedStartAt < s1, id + ' start on workDate');
    assert.ok(p.plannedEndAt > p.plannedStartAt, id + ' end after start'); assert.equal(p.revision, 1);
    assert.ok(p.ansattId === null || typeof p.ansattId === 'string', id);
    if (p.status === 'open') assert.equal(p.ansattId, null); else assert.ok(typeof p.ansattId === 'string' && p.ansattId);
  }
});
t('F3', 'no draft/unpublished/publication marker anywhere in the fixture', () => { const txt = JSON.stringify(schedule).toLowerCase(); for (const w of ['draft', 'unpublished', 'published', 'publish']) assert.ok(!txt.includes(w), w); });
t('F4', 'deterministic: same anchor/timezone builds identical containers', () => { assert.deepEqual(buildFourSeasonSchedule(ANCHOR, TZ), schedule); });

// ---- Maria review shape (current week) ----
const maria = ownShiftsForMembership(schedule, mem('ans-maria'));
const curWeek = weekFor(ANCHOR, TZ, maria, ANCHOR);
t('M1', 'Maria has an assigned shift on the anchor day for every weekday anchor (Today card coherence)', () => {
  for (let i = 0; i < 7; i++) { const a = addDays('2026-08-24', i); const own = ownShiftsForMembership(buildFourSeasonSchedule(a, TZ), mem('ans-maria')); assert.ok(todayShiftOf(own, a), a); }
});
t('M2', 'Maria current week: >=2 days with no assigned shift, >=1 short (<=4h), >=1 full (>=7h), exactly one overnight, exactly one cancelled', () => {
  const dayHasAssigned = curWeek.days.map((d) => d.shifts.some((s) => s.projection.status === 'assigned'));
  assert.ok(dayHasAssigned.filter((x) => !x).length >= 2, 'days off');
  const all = curWeek.days.flatMap((d) => d.shifts);
  const hours = (s) => (s.projection.plannedEndAt - s.projection.plannedStartAt) / 3600000;
  assert.ok(all.some((s) => s.projection.status === 'assigned' && hours(s) <= 4), 'short');
  assert.ok(all.some((s) => s.projection.status === 'assigned' && hours(s) >= 7), 'full');
  assert.equal(all.filter((s) => s.overnight).length, 1, 'one overnight'); assert.equal(all.filter((s) => s.projection.status === 'cancelled').length, 1, 'one cancelled');
});
t('M3', 'Maria has the week-seam shift: previous Sunday 22:00 -> current Monday 02:00, visible once in previous week only', () => {
  const prev = weekFor(addDays(ANCHOR, -7), TZ, maria, ANCHOR);
  const sun = prev.days[6].shifts.filter((s) => s.overnight);
  assert.equal(sun.length, 1); assert.equal(tenantWorkDate(sun[0].projection.plannedEndAt, TZ), curWeek.monday);
  assert.ok(!curWeek.days[0].shifts.some((s) => s.shiftId === sun[0].shiftId));
});
t('M4', 'previous, current and next week all contain Maria content', () => { for (const off of [-7, 0, 7]) assert.ok(weekFor(addDays(ANCHOR, off), TZ, maria, null).days.some((d) => d.shifts.length > 0), String(off)); });
t('M5', 'next upcoming from a Maria anchor-day afternoon is a later assigned shift and agrees with the week view', () => {
  const now = tenantLocalHMToUtcMs(ANCHOR, '13:00', TZ); const nx = nextUpcomingShift(maria, now);
  assert.ok(nx && nx.projection.status === 'assigned' && nx.projection.plannedStartAt > now);
  assert.ok(weekFor(nx.projection.workDate, TZ, maria, null).days.some((d) => d.shifts.some((s) => s.shiftId === nx.shiftId)));
});

// ---- tenant-first / own-only read boundary ----
t('R1', 'own shifts are tenant-first then own ansattId only; open shift never included; others never included', () => {
  assert.ok(maria.length > 0); assert.ok(maria.every((s) => s.projection.ansattId === 'ans-maria' && s.projection.status !== 'open'));
  const aboud = ownShiftsForMembership(schedule, mem('ans-aboud')); assert.ok(aboud.length > 0); assert.ok(aboud.every((s) => s.projection.ansattId === 'ans-aboud'));
  assert.ok(!maria.some((s) => aboud.some((b) => b.shiftId === s.shiftId)));
  assert.ok(Object.values(tenant).some((p) => p.status === 'open'));
  for (const p of FOUR_SEASON_PEOPLE) assert.ok(ownShiftsForMembership(schedule, mem(p.ansattId)).every((s) => s.projection.ansattId === p.ansattId));
});
t('R2', 'wrong tenant / disabled / missing ansattId / admin-without-ansattId membership -> [] (fail-closed, tenant before ansattId)', () => {
  const m = mem('ans-maria');
  assert.deepEqual(ownShiftsForMembership(schedule, Object.assign({}, m, { tenantId: 'other-tenant' })), []);
  assert.deepEqual(ownShiftsForMembership(schedule, Object.assign({}, m, { accessEnabled: false })), []);
  assert.deepEqual(ownShiftsForMembership(schedule, Object.assign({}, m, { ansattId: null })), []);
  assert.deepEqual(ownShiftsForMembership(schedule, Object.assign({}, m, { accessRole: 'admin', ansattId: null })), []);
  assert.deepEqual(ownShiftsForMembership(schedule, null), []); assert.deepEqual(ownShiftsForMembership(null, m), []);
});
t('R3', 'an admin membership with an ansattId still sees only its OWN shifts (own-only pinned beyond canReadShift)', () => {
  const m = Object.assign({}, mem('ans-herish'), { accessRole: 'admin' }); const own = ownShiftsForMembership(schedule, m);
  assert.ok(own.length > 0); assert.ok(own.every((s) => s.projection.ansattId === 'ans-herish'));
});
t('R4', 'fixture privacy: only synthetic technical ids and first names; no contact/auth/health-style attributes', () => {
  const txt = JSON.stringify({ FOUR_SEASON_PEOPLE, FOUR_SEASON_MEMBERSHIPS, schedule }).toLowerCase();
  for (const w of ['@', 'phone', 'telefon', 'pin', 'personnummer', 'bank', 'konto', 'capacity', 'kapasitet', 'health', 'helse', 'sick', 'syk']) assert.ok(!txt.includes(w), w);
  for (const p of FOUR_SEASON_PEOPLE) { assert.ok(/^[A-Za-z]+$/.test(p.name)); assert.ok(p.uid.startsWith('uid-') && p.ansattId.startsWith('ans-')); }
});

// ---- HERO SELECTION (B1/B2/B3) — constructed inputs + injected attendance lookup ----
const D0 = '2026-08-26', DM1 = '2026-08-25';
const at = (wd, hm) => tenantLocalHMToUtcMs(wd, hm, TZ);
const mkLookup = (map) => (shiftId) => (Object.prototype.hasOwnProperty.call(map, shiftId) ? map[shiftId] : null);
const split = [sh('am', 'x', D0, '07:00', '11:00'), sh('pm', 'x', D0, '13:00', '17:00'), sh('canc', 'x', D0, '18:00', '20:00', 'cancelled'), sh('tmrw', 'x', '2026-08-27', '09:00', '15:00')];
t('H1', 'active overnight attendance after midnight wins the hero, flagged ongoingFromPriorDay, even when today has shifts', () => {
  const list = [sh('night', 'x', DM1, '22:00', '02:00')].concat(split);
  const h = heroShiftFor(list, { nowMs: at(D0, '00:30'), todayWorkDate: D0, lookup: mkLookup({ night: { status: 'clocked_in', breakState: 'working' } }) });
  assert.equal(h.kind, 'active'); assert.equal(h.entry.shiftId, 'night'); assert.equal(h.ongoingFromPriorDay, true); assert.equal(h.attendance.status, 'clocked_in');
  const hb = heroShiftFor(list, { nowMs: at(D0, '08:00'), todayWorkDate: D0, lookup: mkLookup({ night: { status: 'clocked_in', breakState: 'on_break' } }) });
  assert.equal(hb.kind, 'active'); assert.equal(hb.entry.shiftId, 'night', 'on_break is still the active shift and beats the current-window shift');
});
t('H2', 'current planned window beats the later same-day shift; multiplicity cue counts the other shift', () => {
  const h = heroShiftFor(split, { nowMs: at(D0, '09:00'), todayWorkDate: D0, lookup: mkLookup({}) });
  assert.equal(h.kind, 'current'); assert.equal(h.entry.shiftId, 'am'); assert.equal(h.othersToday, 1); assert.equal(h.ongoingFromPriorDay, false);
});
t('H3', 'next upcoming today: between the two shifts the pm shift is selected; before both, the am shift', () => {
  assert.equal(heroShiftFor(split, { nowMs: at(D0, '12:00'), todayWorkDate: D0, lookup: mkLookup({}) }).entry.shiftId, 'pm');
  const h = heroShiftFor(split, { nowMs: at(D0, '06:00'), todayWorkDate: D0, lookup: mkLookup({}) }); assert.equal(h.kind, 'upcoming'); assert.equal(h.entry.shiftId, 'am');
});
t('H4', 'most recently completed today is the fallback (planned end passed, or attendance clocked_out) and is not actionable', () => {
  const h = heroShiftFor(split, { nowMs: at(D0, '18:30'), todayWorkDate: D0, lookup: mkLookup({}) });
  assert.equal(h.kind, 'completed'); assert.equal(h.entry.shiftId, 'pm');
  const h2 = heroShiftFor([sh('one', 'x', D0, '07:00', '11:00')], { nowMs: at(D0, '12:00'), todayWorkDate: D0, lookup: mkLookup({ one: { status: 'clocked_out' } }) });
  assert.equal(h2.kind, 'completed'); assert.equal(h2.attendance.status, 'clocked_out');
});
t('H5', 'cancelled-only day and open shifts -> free hero; cancelled/open never selected in any step', () => {
  const list = [sh('c1', 'x', D0, '09:00', '13:00', 'cancelled'), sh('o1', null, D0, '12:00', '16:00', 'open')];
  for (const hm of ['08:00', '10:00', '14:00', '23:00']) { const h = heroShiftFor(list, { nowMs: at(D0, hm), todayWorkDate: D0, lookup: mkLookup({ c1: { status: 'clocked_in' }, o1: { status: 'clocked_in' } }) }); assert.equal(h.kind, 'free', hm); assert.equal(h.entry, null); assert.equal(h.othersToday, 0); }
  assert.deepEqual(todayShiftsOf(list, D0), []);
});
t('H6', 'injected lookup: called per assigned shiftId, missing/non-function lookup treated as no attendance; pure (no store)', () => {
  const seen = []; const lk = (id) => { seen.push(id); return null; };
  const h = heroShiftFor(split, { nowMs: at(D0, '09:00'), todayWorkDate: D0, lookup: lk });
  assert.equal(h.kind, 'current'); assert.ok(seen.includes('am') && seen.includes('pm') && seen.includes('tmrw') && !seen.includes('canc'));
  assert.equal(heroShiftFor(split, { nowMs: at(D0, '09:00'), todayWorkDate: D0 }).kind, 'current');
  assert.equal(heroShiftFor(split, { nowMs: at(D0, '09:00'), todayWorkDate: D0, lookup: 'nope' }).kind, 'current');
});
t('H7', 'todayShiftsOf: sorted by start, assigned only, exact workDate; split-day list drives the multiplicity cue', () => {
  const l = todayShiftsOf([split[1], split[0], split[2], split[3]], D0); assert.deepEqual(l.map((s) => s.shiftId), ['am', 'pm']);
  assert.equal(heroShiftFor(split, { nowMs: at(D0, '06:00'), todayWorkDate: D0, lookup: mkLookup({}) }).othersToday, 1);
  assert.equal(heroShiftFor([split[0]], { nowMs: at(D0, '06:00'), todayWorkDate: D0, lookup: mkLookup({}) }).othersToday, 0);
});
t('H8', 'active attendance on today\'s later shift beats the earlier shift\'s window; result is deterministic', () => {
  const lk = mkLookup({ pm: { status: 'clocked_in', breakState: 'working' } });
  const a = heroShiftFor(split, { nowMs: at(D0, '09:00'), todayWorkDate: D0, lookup: lk }), b = heroShiftFor(split, { nowMs: at(D0, '09:00'), todayWorkDate: D0, lookup: lk });
  assert.equal(a.kind, 'active'); assert.equal(a.entry.shiftId, 'pm'); assert.deepEqual(a, b);
});
t('H9', 'missingRegistration: ended planned shift with NO attendance flags true; completed-with-attendance, active-after-end, current, upcoming and free never do', () => {
  const one = [sh('one', 'x', D0, '07:00', '11:00')];
  const none = heroShiftFor(one, { nowMs: at(D0, '12:00'), todayWorkDate: D0, lookup: mkLookup({}) });
  assert.equal(none.kind, 'completed'); assert.equal(none.attendance, null); assert.equal(none.missingRegistration, true);
  const out = heroShiftFor(one, { nowMs: at(D0, '12:00'), todayWorkDate: D0, lookup: mkLookup({ one: { status: 'clocked_out' } }) });
  assert.equal(out.kind, 'completed'); assert.equal(out.missingRegistration, false, 'completed WITH attendance is not missing');
  const still = heroShiftFor(one, { nowMs: at(D0, '12:00'), todayWorkDate: D0, lookup: mkLookup({ one: { status: 'clocked_in', breakState: 'working' } }) });
  assert.equal(still.kind, 'active'); assert.equal(still.missingRegistration, false, 'active attendance after planned end keeps the active (finishable) state');
  const cur = heroShiftFor(one, { nowMs: at(D0, '09:00'), todayWorkDate: D0, lookup: mkLookup({}) });
  assert.equal(cur.kind, 'current'); assert.equal(cur.missingRegistration, false);
  const up = heroShiftFor(one, { nowMs: at(D0, '06:00'), todayWorkDate: D0, lookup: mkLookup({}) });
  assert.equal(up.kind, 'upcoming'); assert.equal(up.missingRegistration, false);
  const free = heroShiftFor([], { nowMs: at(D0, '12:00'), todayWorkDate: D0, lookup: mkLookup({}) });
  assert.equal(free.kind, 'free'); assert.equal(free.missingRegistration, false);
  // manager-entered day (attested) on an ended shift counts as registered, not missing
  const att = heroShiftFor(one, { nowMs: at(D0, '12:00'), todayWorkDate: D0, lookup: mkLookup({ one: { status: 'attested' } }) });
  assert.equal(att.kind, 'completed'); assert.equal(att.missingRegistration, false);
});

console.log(lines.join('\n'));
console.log('SCHEDULE_WEEK_TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
