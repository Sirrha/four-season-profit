// employee-schedule-fixture.mjs
// FOUR SEASON three-week DEMO schedule (previous / current / next ISO week around an INJECTED
// anchor workDate). Demo data for the first real product review — NOT an authoritative employee
// schedule, NOT an HR record, NOT a persistence contract. Synthetic technical ids, first names and
// ordinary role labels only: no contact data, real auth UIDs, PINs, personnummer, bank data or
// capacity/health-style attributes. Every projection carries EXACTLY the ten frozen ETR-2c fields;
// tenant and shiftId are container/path identity (never fields). No draft/unpublished state exists.

import { tenantLocalHMToUtcMs } from './employee-shell-core.mjs';
import { isoWeekMonday, addDays } from './employee-schedule-week.mjs';

export const FOUR_SEASON_TENANT = Object.freeze({ tenantId: 'four-season', label: 'Four Season' });
export const ROLE_LABELS = Object.freeze({ 'daglig-leder': 'Daglig leder', 'butikksjef': 'Butikksjef', 'butikkmedarbeider': 'Butikkmedarbeider' });
export const FOUR_SEASON_PEOPLE = Object.freeze([
  { uid: 'uid-maria',  ansattId: 'ans-maria',  name: 'Maria',  roleKey: 'butikkmedarbeider' }, // default review identity
  { uid: 'uid-aboud',  ansattId: 'ans-aboud',  name: 'Aboud',  roleKey: 'butikkmedarbeider' },
  { uid: 'uid-yussef', ansattId: 'ans-yussef', name: 'Yussef', roleKey: 'butikkmedarbeider' },
  { uid: 'uid-athar',  ansattId: 'ans-athar',  name: 'Athar',  roleKey: 'butikksjef' },
  { uid: 'uid-herish', ansattId: 'ans-herish', name: 'Herish', roleKey: 'daglig-leder' },
]);
export const FOUR_SEASON_MEMBERSHIPS = Object.freeze(FOUR_SEASON_PEOPLE.map((p) => Object.freeze({
  uid: p.uid, tenantId: FOUR_SEASON_TENANT.tenantId, accessRole: 'employee', ansattId: p.ansattId, accessEnabled: true,
})));
const ROLE_OF = {}; for (const p of FOUR_SEASON_PEOPLE) ROLE_OF[p.ansattId] = p.roleKey;

// Build the tenant-keyed container { 'four-season': { [shiftId]: projection } }. Pure & deterministic
// for a given (anchorWorkDate, timezone). The anchor day always carries an assigned Maria shift so the
// Today card and the schedule agree on the review day; her days off / short / overnight / cancelled
// shifts are laid out relative to that day within the current week.
export function buildFourSeasonSchedule(anchorWorkDate, timezone) {
  const monday = isoWeekMonday(anchorWorkDate);
  const prevMon = addDays(monday, -7), nextMon = addDays(monday, 7);
  const createdAt = tenantLocalHMToUtcMs(addDays(prevMon, -7), '09:00', timezone); // one authoring instant for all
  const shifts = {};
  let openSeq = 0;
  function mk(ansattId, workDate, fromHM, toHM, status) {
    const start = tenantLocalHMToUtcMs(workDate, fromHM, timezone);
    const endDate = toHM < fromHM ? addDays(workDate, 1) : workDate;   // overnight ends on the next local day
    const end = tenantLocalHMToUtcMs(endDate, toHM, timezone);
    const id = ansattId ? 'fs-' + workDate + '-' + ansattId : 'fs-' + workDate + '-open-' + (++openSeq);
    shifts[id] = {
      ansattId: ansattId || null, plannedStartAt: start, plannedEndAt: end, workDate,
      roleKey: ansattId ? ROLE_OF[ansattId] : null, status: status || (ansattId ? 'assigned' : 'open'),
      revision: 1, createdByUid: 'uid-herish', createdAt, updatedAt: createdAt,
    };
  }
  const day = (mon, i) => addDays(mon, i);
  const todayIdx = Math.round((Date.UTC(...anchorWorkDate.split('-').map((v, k) => k === 1 ? Number(v) - 1 : Number(v))) - Date.UTC(...monday.split('-').map((v, k) => k === 1 ? Number(v) - 1 : Number(v)))) / 86400000);
  const rel = (k) => day(monday, (todayIdx + k) % 7);

  // ---- Maria (full-time) — CURRENT week, laid out relative to the anchor day ----
  mk('ans-maria', rel(0), '12:00', '20:00');                 // today: full shift (clock card)
  /* rel(1): day off */
  mk('ans-maria', rel(2), '22:00', '02:00');                 // overnight stocktaking (ends next local day)
  /* rel(3): day off */
  mk('ans-maria', rel(4), '10:00', '14:00');                 // short shift
  mk('ans-maria', rel(5), '09:00', '13:00', 'cancelled');    // cancelled — never workable
  mk('ans-maria', rel(6), '07:00', '15:00');                 // full shift
  // ---- Maria — PREVIOUS week (incl. the week-seam shift Sunday 22:00 -> Monday 02:00) ----
  for (const i of [0, 1, 2, 3, 4]) mk('ans-maria', day(prevMon, i), '07:00', '15:00');
  mk('ans-maria', day(prevMon, 6), '22:00', '02:00');        // seam: previous Sunday -> current Monday
  // ---- Maria — NEXT week ----
  for (const i of [0, 1, 3, 4]) mk('ans-maria', day(nextMon, i), '12:00', '20:00');
  mk('ans-maria', day(nextMon, 2), '10:00', '14:00');

  // ---- Aboud (part-time): days off are the other half of what a schedule communicates ----
  mk('ans-aboud', day(prevMon, 1), '16:00', '20:00'); mk('ans-aboud', day(prevMon, 5), '10:00', '18:00');
  mk('ans-aboud', day(monday, 0), '16:00', '20:00');  mk('ans-aboud', day(monday, 3), '16:00', '20:00'); mk('ans-aboud', day(monday, 5), '10:00', '18:00');
  mk('ans-aboud', day(nextMon, 2), '16:00', '20:00'); mk('ans-aboud', day(nextMon, 5), '10:00', '18:00');
  // ---- Yussef (part-time) ----
  mk('ans-yussef', day(prevMon, 2), '16:00', '21:00'); mk('ans-yussef', day(prevMon, 6), '12:00', '18:00');
  mk('ans-yussef', day(monday, 1), '16:00', '21:00');  mk('ans-yussef', day(monday, 4), '16:00', '21:00'); mk('ans-yussef', day(monday, 6), '12:00', '18:00');
  mk('ans-yussef', day(nextMon, 1), '16:00', '21:00'); mk('ans-yussef', day(nextMon, 6), '12:00', '18:00');
  // ---- Athar (butikksjef) ----
  for (const mon of [prevMon, monday, nextMon]) { mk('ans-athar', day(mon, 0), '08:00', '16:00'); mk('ans-athar', day(mon, 2), '08:00', '16:00'); mk('ans-athar', day(mon, 4), '08:00', '16:00'); }
  // ---- Herish (daglig leder) ----
  for (const mon of [prevMon, monday, nextMon]) { mk('ans-herish', day(mon, 1), '09:00', '17:00'); mk('ans-herish', day(mon, 3), '09:00', '17:00'); }
  // ---- one OPEN (unassigned) shift in the current week: must never render as anyone's own ----
  mk(null, day(monday, 5), '12:00', '16:00');

  return { [FOUR_SEASON_TENANT.tenantId]: shifts };
}
