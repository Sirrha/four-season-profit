// employee-shell-ui.mjs
// ETR-1 membership routing + ETR-2a Today/Clocking + ETR-2b breaks + employee week schedule
// (local demo, mobile-first). Demo identities are the Four Season first names with SYNTHETIC
// technical ids only: no emails, real auth UIDs, passwords/PINs, personnummer, bank or contact
// details. No network, no Firebase, no Firestore. Authority + clock transitions come ONLY from
// the pure core model. All data-derived text is rendered via textContent / created elements —
// never via innerHTML — so data values can never become markup. The UI reads the clock
// (Date.now()) and INJECTS it into the pure model; validators never read a clock (G3).

import {
  resolveRouting, selectMembership,
  ETR2A_POLICY, attendanceIdFor,
  clockIn, clockOut, reasonRequiredForClock,
  tenantWorkDate, fmtTenantHM, tenantLocalHMToUtcMs, computeClockTimes,
  startBreak, endBreak, declareBreak, reasonRequiredForBreak,
  daySummaryFor, primaryActionFor,
} from './employee-shell-core.mjs';
import { buildFourSeasonSchedule, FOUR_SEASON_TENANT, FOUR_SEASON_PEOPLE, FOUR_SEASON_MEMBERSHIPS, ROLE_LABELS } from './employee-schedule-fixture.mjs';
import { ownShiftsForMembership, todayShiftOf, nextUpcomingShift, isOvernight, heroShiftFor, weekFor } from './employee-schedule-week.mjs';
import { renderScheduleView } from './employee-schedule-view.mjs';

const POLICY = ETR2A_POLICY;

// ---- Demo identities / memberships (Four Season; Maria is the default review identity) ----
export const FIXTURE_USERS = FOUR_SEASON_PEOPLE.map((p) => ({ uid: p.uid, label: p.name }));
export const FIXTURE_MEMBERSHIPS = FOUR_SEASON_MEMBERSHIPS;
export const TENANT_LABELS = { [FOUR_SEASON_TENANT.tenantId]: FOUR_SEASON_TENANT.label };
const DEFAULT_UID = 'uid-maria';
function tenantLabel(t) { return Object.prototype.hasOwnProperty.call(TENANT_LABELS, t) ? TENANT_LABELS[t] : t; }

// ETR-1 read-only "Mine vakter" fixtures retained (historical shifts, display only).
export const FIXTURE_SHIFTS = [
  { id: 'v-01', ansattId: 'ansatt-102', dato: '2026-08-18', fra: '08:00', til: '14:00', notat: 'Morgenvakt' },
  { id: 'v-03', ansattId: 'ansatt-103', dato: '2026-08-18', fra: '10:00', til: '18:00', notat: '' },
  { id: 'v-04', ansattId: 'ansatt-204', dato: '2026-08-19', fra: '16:00', til: '22:00', notat: 'Kveld' },
];

// Reason labels (fixture only; the KEY is the stored identity, per Freeze 003 §6.2).
const REASON_LABELS = {
  FORGOT_CLOCK_IN: 'Glemte å stemple inn', LATE_ARRIVAL: 'Kom for sent',
  MANAGEMENT_DECISION: 'Ledelsesbeslutning', OTHER: 'Annet (krever notat)',
  FORGOT_CLOCK_OUT: 'Glemte å stemple ut', LEFT_EARLY: 'Gikk tidlig',
  SICK_DEPARTURE: 'Syk – dro hjem', COVERED_FOR_COLLEAGUE: 'Dekket for kollega',
  APP_UNAVAILABLE: 'Appen var utilgjengelig',
  // ETR-2b break reason labels
  FORGOT_BREAK_START: 'Glemte å starte pause', FORGOT_BREAK_END: 'Glemte å avslutte pause',
  EXTENDED_BREAK: 'Forlenget pause', WORK_RELATED_INTERRUPTION: 'Arbeidsrelatert avbrudd',
  PERSONAL_REASON: 'Personlig årsak',
};

// ---- Single shared schedule truth (Today AND Min plan read the same projections) ---------
// B8: workDate and planned instants are derived from the tenant policy timezone via the pure
// core helpers, NOT from host Date getters. The three-week demo schedule is rebuilt from the
// tenant-local "today" anchor on every read (pure + deterministic => identical shiftIds on every
// visit, so attendance keys never drift). Tenant is fixed by the membership BEFORE any ansattId
// filtering (ownShiftsForMembership); the frozen projection carries no tenantId/shiftId field.
const TZ = POLICY.timezone;
function ownScheduleFor(membership) {
  const wd = tenantWorkDate(Date.now(), TZ);
  return { workDate: wd, shifts: ownShiftsForMembership(buildFourSeasonSchedule(wd, TZ), membership) };
}
// Clock-path packaging (unchanged contract): clockIn inspects shift.shiftId for equality with
// scope.shiftId only; the projection itself stays the frozen ten fields.
function clockShiftFrom(entry, membership) {
  return Object.assign({ shiftId: entry.shiftId, tenantId: membership.tenantId }, entry.projection);
}
function fmtDayShort(workDate) {
  const [y, m, d] = workDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('nb-NO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}

// In-memory attendance store (fixture only; keyed by deterministic attendanceId).
const attendanceStore = new Map();

// ---- Safe DOM helpers -------------------------------------------------------
function el(tag, opts) {
  const node = document.createElement(tag);
  if (opts) {
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.cls) node.className = opts.cls;
    if (opts.attrs) for (const k of Object.keys(opts.attrs)) node.setAttribute(k, String(opts.attrs[k]));
    if (opts.style) node.style.cssText = opts.style;
  }
  return node;
}
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
function fmtHM(instant) { return fmtTenantHM(instant, TZ); } // B8: tenant-timezone, not host
function actorFromMembership(m) {
  return { uid: m.uid, accessRole: m.accessRole, ansattId: m.ansattId, accessEnabled: true, tenantId: m.tenantId };
}

// ---- Shell ------------------------------------------------------------------
export function mountEmployeeShell(root) {
  if (!root) return;

  function goChooser() {
    clear(root);
    const wrap = el('div', { cls: 'card', style: 'max-width:520px' });
    wrap.appendChild(el('h2', { text: 'Hvem er du?' }));
    wrap.appendChild(el('div', { text: 'Velg navnet ditt for å se din dag og din plan.', style: 'color:#5f6b62;font-size:14px;margin-bottom:14px' }));
    for (const u of FIXTURE_USERS) {
      const b = el('button', { cls: 'btn secondary', text: u.label, attrs: { type: 'button' }, style: 'text-align:left;padding:14px 16px' });
      b.addEventListener('click', () => route(u.uid));
      wrap.appendChild(b);
    }
    root.appendChild(wrap);
  }

  function route(uid) {
    const r = resolveRouting(FIXTURE_MEMBERSHIPS, uid);
    if (r.kind === 'no-access') return goNoAccess();
    if (r.kind === 'direct') return goToday(r.membership);
    return goPicker(r.eligible);
  }

  function goNoAccess() {
    clear(root);
    root.appendChild(el('div', {
      text: 'Ingen tilgang. Denne kontoen har ingen aktive medlemskap. Kontakt administrator.',
      style: 'padding:14px;border:1px solid #ddd;border-radius:8px;background:#fafafa',
    }));
    root.appendChild(backBtn('Bytt ansatt', goChooser));
  }

  function goPicker(eligible) {
    clear(root);
    root.appendChild(el('h2', { text: 'Velg arbeidsplass', style: 'font-size:18px;margin:0 0 10px' }));
    for (const m of eligible) {
      const b = el('button', {
        text: tenantLabel(m.tenantId) + ' — ' + m.accessRole,
        style: 'display:block;width:100%;max-width:360px;text-align:left;padding:12px;margin-bottom:8px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;font-size:15px',
      });
      b.addEventListener('click', () => { const sel = selectMembership(eligible, m.tenantId); if (sel) goToday(sel); else goNoAccess(); });
      root.appendChild(b);
    }
    root.appendChild(backBtn('Bytt ansatt', goChooser));
  }

  // ---- SORMENA EMPLOYEE HOME (Visual Slice 001) ---------------------------------------------
  // Hero / next shift / week strip all derive from ownScheduleFor(membership) (one shared truth).
  // Attendance is READ through a lookup into the existing attendanceStore; writers stay in the dialogs.
  let current = null;
  function setChrome(membership, view) {
    const person = FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId);
    const idb = document.getElementById('emp-identity');
    if (idb) {
      idb.hidden = false; idb.onclick = goChooser;
      const av = idb.querySelector('.av'), nm = idb.querySelector('.nm');
      if (av) av.textContent = person ? person.name.charAt(0) : '?';
      if (nm) nm.textContent = person ? person.name : '';
      idb.setAttribute('aria-label', 'Bytt ansatt');
    }
    const nav = document.getElementById('emp-nav');
    if (nav) {
      nav.hidden = false;
      for (const b of nav.querySelectorAll('button[data-nav]')) {
        const k = b.getAttribute('data-nav');
        if (k === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        b.onclick = () => { if (k === 'today') goToday(current); else if (k === 'plan') goSchedule(current); else goMyWork(current); };
      }
    }
  }
  function greetingFor(nowMs) {
    const h = parseInt(fmtHM(nowMs).slice(0, 2), 10);          // tenant-local hour
    return h < 10 ? 'God morgen' : h < 17 ? 'God dag' : 'God kveld';
  }
  function goToday(membership) {
    current = membership; clear(root); setChrome(membership, 'today');
    const { workDate, shifts } = ownScheduleFor(membership);
    const nowMs = Date.now();
    const lookup = (shiftId) => attendanceStore.get(attendanceIdFor(shiftId, membership.ansattId)) || null;
    const hero = heroShiftFor(shifts, { nowMs, todayWorkDate: workDate, lookup });
    const person = FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId);
    const fmtDur = (m) => (m >= 60 ? Math.floor(m / 60) + ' t ' + (m % 60 ? (m % 60) + ' min' : '') : m + ' min').trim();

    // two deliberate compositions from one DOM: single column on phone, main/side columns on desktop (CSS grid)
    const home = el('div', { cls: 'home' }); const main = el('div', { cls: 'col-main' }); const side = el('div', { cls: 'col-side' });
    home.appendChild(main); home.appendChild(side); root.appendChild(home);

    const g = el('div', { cls: 'greet' });
    g.appendChild(el('h1', { text: greetingFor(nowMs) + (person ? ', ' + person.name : '') }));
    g.appendChild(el('div', { cls: 'date', text: new Date(nowMs).toLocaleDateString('nb-NO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }) }));
    main.appendChild(g);

    // ---- hero (selection unchanged; presentation is state-driven) ----
    const entry = hero.entry; const p = entry ? entry.projection : null; const att = hero.attendance;
    const started = !!p && nowMs >= p.plannedStartAt;
    const ended = !!p && nowMs >= p.plannedEndAt;
    let mood = 'calm';                                   // calm | attn | work | pause | done | free
    if (hero.kind === 'free') mood = 'free';
    else if (att && att.status === 'clocked_in') mood = att.breakState === 'on_break' ? 'pause' : 'work';
    else if (att && att.status === 'clocked_out') mood = 'done';
    else if (hero.kind === 'completed') mood = 'done';
    else if (started && !ended) mood = 'attn';           // window running, not clocked in => attention, not calm green
    const card = el('div', { cls: 'card hero ' + mood });
    if (mood === 'free') {
      card.appendChild(el('div', { cls: 'kicker neutral', text: 'I dag' }));
      card.appendChild(el('div', { cls: 'title', text: 'Fri i dag' }));
      card.appendChild(el('div', { cls: 'sub', text: 'Ingen planlagt vakt hos ' + tenantLabel(membership.tenantId) + '. Nyt dagen.' }));
      main.appendChild(card);
    } else {
      card.appendChild(el('div', { cls: 'kicker' + (mood === 'attn' || mood === 'pause' ? ' amber' : mood === 'done' ? ' neutral' : ''), text: hero.ongoingFromPriorDay ? 'Pågående vakt' : mood === 'done' ? 'Dagens vakt · fullført' : 'Dagens vakt' }));
      const hg = el('div', { cls: 'hero-grid' }); const txt = el('div', { cls: 'txt' }); hg.appendChild(txt);
      txt.appendChild(el('div', { cls: 'title', text: fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, TZ) ? ' (til neste dag)' : '') }));
      txt.appendChild(el('div', { cls: 'sub', text: tenantLabel(membership.tenantId) + (ROLE_LABELS[p.roleKey] ? ' · ' + ROLE_LABELS[p.roleKey] : '') + (hero.ongoingFromPriorDay ? ' · startet ' + fmtDayShort(p.workDate) : '') }));
      // human lead line per state
      if (mood === 'calm' && !started) txt.appendChild(el('div', { cls: 'lead', text: 'Vakten starter kl. ' + fmtHM(p.plannedStartAt) + (p.plannedStartAt - nowMs < 12 * 3600000 ? ' · om ' + fmtDur(Math.round((p.plannedStartAt - nowMs) / 60000)) : '') }));
      if (mood === 'attn') { txt.appendChild(el('div', { cls: 'lead', text: 'Vakten startet kl. ' + fmtHM(p.plannedStartAt) })); txt.appendChild(el('div', { cls: 'note', text: 'Ikke stemplet inn ennå.' })); }
      if (mood === 'work' && !ended) txt.appendChild(el('div', { cls: 'lead', text: 'Ca. ' + fmtDur(Math.max(1, Math.round((p.plannedEndAt - nowMs) / 60000))) + ' til planlagt slutt' }));
      if (mood === 'work' && ended) txt.appendChild(el('div', { cls: 'lead', text: 'Planlagt slutt er passert' }));
      if (mood === 'done') txt.appendChild(el('div', { cls: 'lead', text: 'Takk for i dag.' }));
      // status pill (authoritative text)
      let stateText = 'Ikke stemplet inn', stateCls = 'status' + (mood === 'attn' ? ' attn' : '');
      if (att && att.status === 'clocked_in') { stateText = 'Stemplet inn kl. ' + fmtHM(att.observedClockInAt); stateCls = 'status on'; }
      else if (att && att.status === 'clocked_out') { stateText = 'Stemplet ut'; }   // Slice003: all start/end meaning lives in Dagen din
      else if (hero.kind === 'completed') { stateText = 'Planlagt vakt er over'; }
      if (att && att.breakState === 'on_break') { stateText = 'På pause siden kl. ' + fmtHM(att.openBreakStartedAt); stateCls = 'status pause'; }
      const st = el('div', { cls: stateCls }); st.appendChild(el('span', { cls: 'dot' })); st.appendChild(el('span', { text: stateText })); txt.appendChild(st);
      // (the former observed-break cue-line is replaced by the source-aware Dagen din block below)
      // planned-window progress: ring on desktop (CSS shows it), bar on mobile; only while the window runs
      const span = p.plannedEndAt - p.plannedStartAt;
      if (started && !ended && span > 0 && mood !== 'done') {
        const pct = Math.max(0, Math.min(100, Math.round(((nowMs - p.plannedStartAt) / span) * 100)));
        const ring = el('div', { cls: 'ring', attrs: { 'aria-hidden': 'true' } }); const rw = el('div', { cls: 'ring-wrap' });
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 88 88');
        const mk = (c) => { const o = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); o.setAttribute('cx', '44'); o.setAttribute('cy', '44'); o.setAttribute('r', '38'); o.setAttribute('class', c); return o; };
        const track = mk('track'); const val = mk('val'); const C = 2 * Math.PI * 38; val.setAttribute('stroke-dasharray', C.toFixed(1)); val.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(1));
        svg.appendChild(track); svg.appendChild(val); rw.appendChild(svg); rw.appendChild(el('div', { cls: 'pct', text: pct + ' %' })); ring.appendChild(rw); hg.appendChild(ring);
        const pr = el('div', { cls: 'prog bar-only' }); const bar = el('div', { cls: 'bar' }); bar.appendChild(el('div', { cls: 'fill', style: 'width:' + pct + '%' })); pr.appendChild(bar);
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-label', 'Planlagt tid');
        txt.appendChild(pr);
        txt.appendChild(el('div', { cls: 'cue-line', text: pct + ' % av planlagt vakt er gått' }));
      }
      card.appendChild(hg);
      if (hero.othersToday > 0) card.appendChild(el('div', { cls: 'cue-line', text: 'Du har også en vakt til i dag – se Plan.' }));
      main.appendChild(card);

      // ---- state-driven primary action: GREEN = emphasis only, NEVER availability ----
      // Which buttons exist is unchanged (existing availability rules below); the pure
      // selector only decides which ONE (if any) gets the existing green-primary styling.
      const acts = el('div', { cls: 'actions' });
      const shift = clockShiftFrom(entry, membership);
      const attId = attendanceIdFor(shift.shiftId, membership.ansattId);
      const breaksOn = POLICY.breakMode !== 'none';
      const actionable = hero.kind === 'active' || hero.kind === 'current' || hero.kind === 'upcoming';
      const primary = primaryActionFor({
        attendance: att, shift, now: nowMs, policy: POLICY,
        clockInPermitted: !att && actionable && POLICY.employeeClockingEnabled === true,
      });
      const emph = (key, capsLabel, label, onClick) =>
        btn(primary === key ? capsLabel : label, primary === key ? 'primary' : 'secondary', onClick);
      if (!att && actionable) {
        acts.appendChild(emph('stemple_inn', 'STEMPLE INN', 'Stemple inn', () => openClockDialog(membership, shift, attId, 'in')));
      } else if (att && att.status === 'clocked_in') {
        if (att.breakState === 'on_break') {
          acts.appendChild(emph('avslutt_pause', 'AVSLUTT PAUSE', 'Avslutt pause', () => openBreakDialog(membership, shift, attId, 'break_end')));
        } else {
          if (breaksOn) acts.appendChild(emph('start_pause', 'START PAUSE', 'Start pause', () => openBreakDialog(membership, shift, attId, 'break_start')));
          acts.appendChild(emph('stemple_ut', 'STEMPLE UT', 'Stemple ut', () => openClockDialog(membership, shift, attId, 'out')));
        }
      } else if (att && att.status === 'clocked_out') {
        acts.appendChild(el('div', { cls: 'done-line', text: 'Vakten er fullført for i dag.' }));
      }
      main.appendChild(acts);

      // ---- DAGEN DIN (Slice003): source-aware day summary from the existing projection, rendered only with attendance ----
      const ds = att ? daySummaryFor({ attendance: att }) : null;
      if (ds) {
        const sc = el('div', { cls: 'card' });
        sc.appendChild(el('div', { cls: 'kicker', text: 'Dagen din' }));
        const rowOf = (label, primary, tag, secondary) => {
          const r = el('div', { cls: 'row', style: 'padding:8px 0;border-top:1px solid #eef0ec' });
          r.appendChild(el('div', { text: label, style: 'color:#5f6b62;font-size:13px;font-weight:600;min-width:52px' }));
          const right = el('div', { style: 'text-align:right' });
          const line = el('div', { style: 'display:flex;gap:8px;align-items:baseline;justify-content:flex-end' });
          line.appendChild(el('span', { text: primary, style: 'font-weight:800;font-size:16px' }));
          if (tag) line.appendChild(el('span', { cls: 'tag', text: tag }));
          right.appendChild(line);
          if (secondary) right.appendChild(el('div', { cls: 'cue-line', text: secondary, style: 'margin-top:2px' }));
          r.appendChild(right);
          return r;
        };
        // START
        if (ds.start.at != null) {
          if (ds.start.source === 'declared') sc.appendChild(rowOf('Start', fmtHM(ds.start.at), 'Oppgitt av deg', 'Registrert kl. ' + fmtHM(ds.start.observedAt)));
          else sc.appendChild(rowOf('Start', fmtHM(ds.start.at), 'Stemplet inn', null));
        }
        // BREAK
        if (ds.breakRow.kind === 'open') sc.appendChild(rowOf('Pause', 'Pågår siden ' + (ds.breakRow.sinceAt != null ? fmtHM(ds.breakRow.sinceAt) : '–'), null, null));
        else if (ds.breakRow.kind === 'declared') sc.appendChild(rowOf('Pause', ds.breakRow.minutes + ' min', 'Oppgitt av deg', (ds.breakRow.observedMinutes > 0 || ds.breakRow.count > 0) ? 'Registrert ' + ds.breakRow.observedMinutes + ' min' + (ds.breakRow.count > 0 ? ' (' + ds.breakRow.count + (ds.breakRow.count === 1 ? ' pause)' : ' pauser)') : '') : null));
        else if (ds.breakRow.kind === 'observed') sc.appendChild(rowOf('Pause', ds.breakRow.minutes + ' min', 'Registrert', ds.breakRow.count > 0 ? ds.breakRow.count + (ds.breakRow.count === 1 ? ' pause' : ' pauser') : null));
        // END
        if (ds.end.at != null) {
          if (ds.end.source === 'declared') sc.appendChild(rowOf('Slutt', fmtHM(ds.end.at), 'Oppgitt av deg', 'Registrert kl. ' + fmtHM(ds.end.observedAt)));
          else sc.appendChild(rowOf('Slutt', fmtHM(ds.end.at), 'Stemplet ut', null));
        } else {
          sc.appendChild(rowOf('Slutt', '–', null, ds.onBreak ? null : 'Ikke stemplet ut ennå'));
        }
        // TOTAL (only when the helper exposes a complete total)
        if (ds.total) {
          const tr = el('div', { cls: 'row', style: 'padding:12px 0 2px;border-top:1px solid #eef0ec;margin-top:2px' });
          tr.appendChild(el('div', { text: ds.total.label, style: 'font-weight:700;font-size:14px' }));
          tr.appendChild(el('div', { text: (ds.total.hours > 0 ? ds.total.hours + ' t ' : '') + ds.total.mins + ' min', style: 'font-weight:800;font-size:20px;color:#175330' }));
          sc.appendChild(tr);
        }
        // existing forgotten-break affordance, relocated beside the break truth (identical handler/condition)
        if (breaksOn && att && (att.status === 'clocked_in' || att.status === 'clocked_out') && att.breakState !== 'on_break') {
          sc.appendChild(btn('Glemt en pause? Registrer pausetid', 'tertiary', () => openDeclareBreakDialog(membership, shift, attId)));
        }
        main.appendChild(sc);
      }
    }

    // ---- next shift (same own-schedule array) ----
    const after = entry && hero.kind !== 'completed' ? Math.max(nowMs, p.plannedStartAt) : nowMs;
    const nx = nextUpcomingShift(shifts, after);
    const nc = el('div', { cls: 'card next' });
    if (nx) {
      const q = nx.projection; const [, qm, qd] = q.workDate.split('-').map(Number);
      const cal = el('div', { cls: 'cal', attrs: { 'aria-hidden': 'true' } });
      cal.appendChild(el('div', { cls: 'm', text: ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'][qm - 1] }));
      cal.appendChild(el('div', { cls: 'd', text: String(qd) }));
      cal.appendChild(el('div', { cls: 'w', text: fmtDayShort(q.workDate).split(' ')[0].slice(0, 3) }));
      nc.appendChild(cal);
      const body = el('div', { cls: 'body' });
      body.appendChild(el('div', { cls: 'kicker', text: 'Neste vakt' }));
      body.appendChild(el('div', { cls: 'when', text: fmtDayShort(q.workDate).replace(/^./, (c) => c.toUpperCase()) }));
      body.appendChild(el('div', { cls: 'meta', text: fmtHM(q.plannedStartAt) + '–' + fmtHM(q.plannedEndAt) + ' · ' + tenantLabel(membership.tenantId) + (ROLE_LABELS[q.roleKey] ? ' · ' + ROLE_LABELS[q.roleKey] : '') }));
      if (isOvernight(q, TZ)) {
        const nt = el('span', { cls: 'night' });
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'); path.setAttribute('fill', 'currentColor'); svg.appendChild(path);
        nt.appendChild(svg); nt.appendChild(el('span', { text: 'Nattvakt · slutter neste dag' })); body.appendChild(nt);
      }
      nc.appendChild(body);
    } else {
      const body = el('div', { cls: 'body' });
      body.appendChild(el('div', { cls: 'kicker neutral', text: 'Neste vakt' }));
      body.appendChild(el('div', { cls: 'meta', text: 'Ingen flere planlagte vakter i denne perioden.' }));
      nc.appendChild(body);
    }
    side.appendChild(nc);

    // ---- this week: mini calendar strip (phone) + vertical summary (desktop), same array ----
    const week = weekFor(workDate, TZ, shifts, workDate);
    const wc = el('div', { cls: 'card' });
    const wr = el('div', { cls: 'row' });
    wr.appendChild(el('div', { cls: 'kicker neutral', text: 'Denne uken · uke ' + week.weekNumber }));
    const seeAll = el('button', { cls: 'btn tertiary', text: 'Se hele planen →', style: 'width:auto;padding:4px 0;min-height:0', attrs: { type: 'button' } }); seeAll.addEventListener('click', () => goSchedule(membership)); wr.appendChild(seeAll);
    wc.appendChild(wr);
    const WD = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
    const strip = el('div', { cls: 'strip' }); const list = el('div', { cls: 'wlist' });
    week.days.forEach((d, i) => {
      const assigned = d.shifts.filter((s) => s.projection.status === 'assigned');
      const cancelledOnly = d.shifts.length > 0 && assigned.length === 0;
      const stateCls = assigned.length ? ' work' : cancelledOnly ? ' cancel' : '';
      const num = String(parseInt(d.workDate.slice(8), 10));
      const aria = WD[i] + ' ' + d.workDate + (d.isToday ? ', i dag' : '') + ': ' + (assigned.length ? 'vakt' : cancelledOnly ? 'avlyst' : 'fri');
      const cell = el('div', { cls: 'day' + stateCls + (d.isToday ? ' today' : ''), attrs: { 'aria-label': aria } });
      cell.appendChild(el('div', { cls: 'wd', text: WD[i] })); cell.appendChild(el('div', { cls: 'num', text: num }));
      cell.appendChild(el('div', { cls: 'st', text: assigned.length ? fmtHM(assigned[0].projection.plannedStartAt) : cancelledOnly ? 'Avlyst' : 'Fri' }));
      strip.appendChild(cell);
      const row = el('div', { cls: 'wrow' + stateCls + (d.isToday ? ' today' : ''), attrs: { 'aria-label': aria } });
      const dn = el('div', { cls: 'dn' }); dn.appendChild(el('div', { cls: 'wd', text: WD[i] })); dn.appendChild(el('div', { cls: 'num', text: num })); row.appendChild(dn);
      const lab = el('div', { cls: 'lab' });
      if (assigned.length) { const a = assigned[0].projection; lab.appendChild(document.createTextNode(fmtHM(a.plannedStartAt) + '–' + fmtHM(a.plannedEndAt) + (isOvernight(a, TZ) ? ' (til neste dag)' : ''))); lab.appendChild(el('small', { text: tenantLabel(membership.tenantId) + (ROLE_LABELS[a.roleKey] ? ' · ' + ROLE_LABELS[a.roleKey] : '') + (assigned.length > 1 ? ' · +' + (assigned.length - 1) + ' vakt' : '') })); }
      else lab.appendChild(document.createTextNode(cancelledOnly ? fmtHM(d.shifts[0].projection.plannedStartAt) + '–' + fmtHM(d.shifts[0].projection.plannedEndAt) : 'Fri'));
      row.appendChild(lab);
      row.appendChild(el('span', { cls: 'tag', text: d.isToday ? 'I dag' : assigned.length ? 'Vakt' : cancelledOnly ? 'Avlyst' : 'Fri' }));
      list.appendChild(row);
    });
    wc.appendChild(strip); wc.appendChild(list);
    side.appendChild(wc);
  }
  function goTodaySlice1(membership) {
    current = membership; clear(root); setChrome(membership, 'today');
    const { workDate, shifts } = ownScheduleFor(membership);
    const nowMs = Date.now();
    const lookup = (shiftId) => attendanceStore.get(attendanceIdFor(shiftId, membership.ansattId)) || null;
    const hero = heroShiftFor(shifts, { nowMs, todayWorkDate: workDate, lookup });
    const person = FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId);

    const g = el('div', { cls: 'greet' });
    g.appendChild(el('h1', { text: greetingFor(nowMs) + (person ? ', ' + person.name : '') }));
    g.appendChild(el('div', { cls: 'date', text: new Date(nowMs).toLocaleDateString('nb-NO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }) }));
    root.appendChild(g);

    // ---- hero ----
    const entry = hero.entry; const p = entry ? entry.projection : null; const att = hero.attendance;
    const card = el('div', { cls: 'card hero' + (hero.kind === 'free' ? ' free' : '') });
    if (hero.kind === 'free') {
      card.appendChild(el('div', { cls: 'kicker neutral', text: 'Dagens vakt' }));
      card.appendChild(el('div', { cls: 'title', text: 'Fri i dag' }));
      card.appendChild(el('div', { cls: 'sub', text: 'Ingen planlagt vakt hos ' + tenantLabel(membership.tenantId) + '.' }));
      root.appendChild(card);
    } else {
      card.appendChild(el('div', { cls: 'kicker', text: hero.ongoingFromPriorDay ? 'Pågående vakt' : hero.kind === 'completed' ? 'Dagens vakt · fullført' : 'Dagens vakt' }));
      card.appendChild(el('div', { cls: 'title', text: fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, TZ) ? ' (til neste dag)' : '') }));
      card.appendChild(el('div', { cls: 'sub', text: tenantLabel(membership.tenantId) + (ROLE_LABELS[p.roleKey] ? ' · ' + ROLE_LABELS[p.roleKey] : '') + (hero.ongoingFromPriorDay ? ' · startet ' + fmtDayShort(p.workDate) : '') }));
      let stateText = 'Ikke stemplet inn', stateCls = 'status';
      if (att && att.status === 'clocked_in') { stateText = 'Stemplet inn kl. ' + fmtHM(att.observedClockInAt); stateCls = 'status on'; }
      else if (att && att.status === 'clocked_out') { stateText = 'Stemplet ut kl. ' + fmtHM(att.observedClockOutAt) + ' (inn ' + fmtHM(att.observedClockInAt) + ')'; }
      else if (hero.kind === 'completed') { stateText = 'Planlagt vakt er over'; }
      if (att && att.breakState === 'on_break') { stateText = 'På pause siden kl. ' + fmtHM(att.openBreakStartedAt); stateCls = 'status pause'; }
      const st = el('div', { cls: stateCls }); st.appendChild(el('span', { cls: 'dot' })); st.appendChild(el('span', { text: stateText })); card.appendChild(st);
      if (att && att.breakState !== 'on_break' && att.observedBreakMinutesTotal > 0) card.appendChild(el('div', { cls: 'cue-line', text: 'Observert pausetid: ' + att.observedBreakMinutesTotal + ' min (' + att.breakCount + ' pauser)' }));
      // schedule-window progress (planned window only; never worked/payable time)
      const span = p.plannedEndAt - p.plannedStartAt;
      if (nowMs < p.plannedStartAt) {
        const m = Math.round((p.plannedStartAt - nowMs) / 60000);
        card.appendChild(el('div', { cls: 'cue-line', text: 'Planlagt start om ' + (m >= 60 ? Math.floor(m / 60) + ' t ' + (m % 60) + ' min' : m + ' min') + '.' }));
      } else if (nowMs < p.plannedEndAt && span > 0) {
        const pct = Math.max(0, Math.min(100, Math.round(((nowMs - p.plannedStartAt) / span) * 100)));
        const m = Math.round((p.plannedEndAt - nowMs) / 60000);
        const pr = el('div', { cls: 'prog' }); const bar = el('div', { cls: 'bar' }); const fill = el('div', { cls: 'fill', style: 'width:' + pct + '%' }); bar.appendChild(fill); pr.appendChild(bar);
        pr.appendChild(el('div', { cls: 'lbl', text: 'Planlagt vakt: ' + pct + ' % av tiden er gått · ' + (m >= 60 ? Math.floor(m / 60) + ' t ' + (m % 60) + ' min' : m + ' min') + ' igjen til planlagt slutt' }));
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-label', 'Planlagt vakt');
        card.appendChild(pr);
      } else if (hero.kind !== 'completed') {
        card.appendChild(el('div', { cls: 'cue-line', text: 'Planlagt slutt er passert.' }));
      }
      if (hero.othersToday > 0) card.appendChild(el('div', { cls: 'cue-line', text: 'Du har også en vakt til i dag – se Plan.' }));
      root.appendChild(card);

      // ---- exactly ONE primary action ----
      const shift = clockShiftFrom(entry, membership);
      const attId = attendanceIdFor(shift.shiftId, membership.ansattId);
      const breaksOn = POLICY.breakMode !== 'none';
      const actionable = hero.kind === 'active' || hero.kind === 'current' || hero.kind === 'upcoming';
      if (!att && actionable) {
        root.appendChild(btn('STEMPLE INN', 'primary', () => openClockDialog(membership, shift, attId, 'in')));
      } else if (att && att.status === 'clocked_in') {
        if (att.breakState === 'on_break') {
          root.appendChild(btn('AVSLUTT PAUSE', 'primary', () => openBreakDialog(membership, shift, attId, 'break_end')));
        } else if (breaksOn) {
          root.appendChild(btn('START PAUSE', 'primary', () => openBreakDialog(membership, shift, attId, 'break_start')));
          root.appendChild(btn('Stemple ut', 'secondary', () => openClockDialog(membership, shift, attId, 'out')));
        } else {
          root.appendChild(btn('STEMPLE UT', 'primary', () => openClockDialog(membership, shift, attId, 'out')));
        }
      } else if (att && att.status === 'clocked_out') {
        root.appendChild(el('div', { cls: 'cue-line', text: 'Vakten er fullført for i dag.', style: 'text-align:center;color:#175330;font-weight:700;padding:10px 0' }));
      }
      if (breaksOn && att && (att.status === 'clocked_in' || att.status === 'clocked_out') && att.breakState !== 'on_break') {
        root.appendChild(btn('Glemt en pause? Registrer pausetid', 'tertiary', () => openDeclareBreakDialog(membership, shift, attId)));
      }
    }

    // ---- next shift (same own-schedule array) ----
    const after = entry && hero.kind !== 'completed' ? Math.max(nowMs, p.plannedStartAt) : nowMs;
    const nx = nextUpcomingShift(shifts, after);
    const nc = el('div', { cls: 'card next' });
    nc.appendChild(el('div', { cls: 'kicker neutral', text: 'Neste vakt' }));
    if (nx) {
      const q = nx.projection;
      nc.appendChild(el('div', { cls: 'when', text: fmtDayShort(q.workDate).replace(/^./, (c) => c.toUpperCase()) + ' · ' + fmtHM(q.plannedStartAt) + '–' + fmtHM(q.plannedEndAt) + (isOvernight(q, TZ) ? ' (til neste dag)' : '') }));
      nc.appendChild(el('div', { cls: 'meta', text: tenantLabel(membership.tenantId) + (ROLE_LABELS[q.roleKey] ? ' · ' + ROLE_LABELS[q.roleKey] : '') }));
    } else {
      nc.appendChild(el('div', { cls: 'meta', text: 'Ingen flere planlagte vakter i denne perioden.' }));
    }
    root.appendChild(nc);

    // ---- current week strip (Mon–Sun, same array) ----
    const week = weekFor(workDate, TZ, shifts, workDate);
    const wc = el('div', { cls: 'card' });
    const wr = el('div', { cls: 'row' });
    wr.appendChild(el('div', { cls: 'kicker neutral', text: 'Denne uken · uke ' + week.weekNumber }));
    const seeAll = el('button', { cls: 'btn tertiary', text: 'Se hele planen →', style: 'width:auto;padding:4px 0;min-height:0' }); seeAll.addEventListener('click', () => goSchedule(membership)); wr.appendChild(seeAll);
    wc.appendChild(wr);
    const strip = el('div', { cls: 'strip' });
    const WD = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
    week.days.forEach((d, i) => {
      const assigned = d.shifts.filter((s) => s.projection.status === 'assigned');
      const cancelledOnly = d.shifts.length > 0 && assigned.length === 0;
      const cell = el('div', { cls: 'day' + (assigned.length ? ' work' : cancelledOnly ? ' cancel' : '') + (d.isToday ? ' today' : '') });
      cell.appendChild(el('div', { cls: 'wd', text: WD[i] }));
      cell.appendChild(el('div', { cls: 'num', text: String(parseInt(d.workDate.slice(8), 10)) }));
      cell.appendChild(el('div', { cls: 'st', text: assigned.length ? fmtHM(assigned[0].projection.plannedStartAt) : cancelledOnly ? 'Avlyst' : 'Fri' }));
      cell.setAttribute('aria-label', WD[i] + ' ' + d.workDate + (d.isToday ? ', i dag' : '') + ': ' + (assigned.length ? 'vakt' : cancelledOnly ? 'avlyst' : 'fri'));
      strip.appendChild(cell);
    });
    wc.appendChild(strip);
    root.appendChild(wc);
  }
  function btn(label, kind, onClick) {
    const b = el('button', { cls: 'btn ' + kind, text: label, attrs: { type: 'button' } });
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- previous scaffold Today (kept intact for the clock/break dialog return path contract; not routed) ----
  function goTodayLegacy(membership) {
    clear(root);
    const { workDate, shifts } = ownScheduleFor(membership);       // same truth as Min plan
    const todayEntry = todayShiftOf(shifts, workDate);
    const nowMs = Date.now();
    const upcoming = nextUpcomingShift(shifts, nowMs);

    // header + greeting
    const now = new Date(nowMs);
    const person = FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId);
    root.appendChild(el('div', { text: 'SORMENA', style: 'font-weight:800;letter-spacing:1px;color:#2e7d46;font-size:16px' }));
    root.appendChild(el('div', { text: (person ? 'Hei, ' + person.name + ' · ' : '') + 'I dag · ' + now.toLocaleDateString('nb-NO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }), style: 'color:#666;font-size:13px;margin-bottom:14px' }));

    // no shift today: coherent day-off card, no clock actions
    if (!todayEntry) {
      const off = el('div', { style: 'border:1px solid #dfe6df;border-radius:12px;padding:16px;background:#fff;margin-bottom:16px' });
      off.appendChild(el('div', { text: 'Dagens vakt', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#2e7d46;font-weight:700;margin-bottom:6px' }));
      off.appendChild(el('div', { text: 'Fri i dag', style: 'font-weight:700;font-size:15px' }));
      off.appendChild(el('div', { text: upcomingText(upcoming), style: 'font-size:13px;color:#555;margin-top:8px' }));
      root.appendChild(off);
      root.appendChild(linkBtn('Se hele planen →', () => goSchedule(membership)));
      root.appendChild(linkBtn('Min jobb & økonomi →', () => goMyWork(membership)));
      root.appendChild(backBtn('Bytt ansatt', goChooser));
      return;
    }

    const shift = clockShiftFrom(todayEntry, membership);
    // ETR-2c: attendance id derives from the authoritative scope.shiftId; the deterministic fixture
    // shiftId IS the scope.shiftId seed, so this equals the id clockIn produces — on every visit.
    const attId = attendanceIdFor(shift.shiftId, membership.ansattId);
    const att = attendanceStore.get(attId) || null;   // L1: two reads (shift + attendance), no query

    // Today's shift card
    const card = el('div', { style: 'border:1px solid #dfe6df;border-radius:12px;padding:16px;background:#f6fff6;margin-bottom:16px' });
    card.appendChild(el('div', { text: 'Dagens vakt', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#2e7d46;font-weight:700;margin-bottom:6px' }));
    card.appendChild(el('div', { text: tenantLabel(shift.tenantId) + (ROLE_LABELS[shift.roleKey] ? ' · ' + ROLE_LABELS[shift.roleKey] : ''), style: 'font-weight:700;font-size:15px' }));
    card.appendChild(el('div', { text: 'Planlagt: ' + fmtHM(shift.plannedStartAt) + '–' + fmtHM(shift.plannedEndAt) + (isOvernight(todayEntry.projection, TZ) ? ' (til neste dag)' : ''), style: 'font-size:14px;color:#333;margin-top:2px' }));
    let stateText = 'Ikke stemplet inn';
    if (att && att.status === 'clocked_in') stateText = 'Stemplet inn kl. ' + fmtHM(att.observedClockInAt);
    else if (att && att.status === 'clocked_out') stateText = 'Stemplet ut kl. ' + fmtHM(att.observedClockOutAt) + ' (inn ' + fmtHM(att.observedClockInAt) + ')';
    card.appendChild(el('div', { text: 'Status: ' + stateText, style: 'font-size:13px;color:#555;margin-top:8px' }));
    if (att && att.breakState === 'on_break') {
      card.appendChild(el('div', { text: 'På pause siden kl. ' + fmtHM(att.openBreakStartedAt), style: 'font-size:13px;color:#6a5acd;font-weight:600;margin-top:4px' }));
    } else if (att && att.observedBreakMinutesTotal > 0) {
      // OBSERVED total shown as reference only (never auto-substituted for a declaration)
      card.appendChild(el('div', { text: 'Observert pausetid: ' + att.observedBreakMinutesTotal + ' min (' + att.breakCount + ' pauser)', style: 'font-size:12px;color:#888;margin-top:4px' }));
    }
    card.appendChild(el('div', { text: upcomingText(upcoming), style: 'font-size:12px;color:#777;margin-top:8px' }));
    root.appendChild(card);

    // dominant action(s) — break state machine (Freeze 003 §3.4)
    const breaksOn = POLICY.breakMode !== 'none';
    if (!att) {
      root.appendChild(bigBtn('STEMPLE INN', '#2e7d46', () => openClockDialog(membership, shift, attId, 'in')));
    } else if (att.status === 'clocked_in') {
      if (att.breakState === 'on_break') {
        // clock-out hidden/blocked while on_break, consistent with core BREAK_OPEN
        root.appendChild(bigBtn('AVSLUTT PAUSE', '#b8860b', () => openBreakDialog(membership, shift, attId, 'break_end')));
      } else {
        if (breaksOn) root.appendChild(bigBtn('START PAUSE', '#6a5acd', () => openBreakDialog(membership, shift, attId, 'break_start')));
        root.appendChild(bigBtn('STEMPLE UT', '#b8860b', () => openClockDialog(membership, shift, attId, 'out')));
      }
    } else {
      root.appendChild(el('div', { text: 'Vakten er fullført for i dag.', style: 'text-align:center;color:#2e7d46;font-weight:600;padding:12px' }));
    }

    // break declaration entry (only when there is an attendance and no break is open)
    if (breaksOn && att && (att.status === 'clocked_in' || att.status === 'clocked_out') && att.breakState !== 'on_break') {
      root.appendChild(linkBtn('Registrer pausetid →', () => openDeclareBreakDialog(membership, shift, attId)));
    }

    // secondary entry points
    root.appendChild(linkBtn('Se hele planen →', () => goSchedule(membership)));
    root.appendChild(linkBtn('Min jobb & økonomi →', () => goMyWork(membership)));
    root.appendChild(backBtn('Bytt ansatt', goChooser));
  }

  // "Neste vakt" text shared by the Today card and the day-off card (same source as Min plan).
  function upcomingText(entry) {
    if (!entry) return 'Ingen flere planlagte vakter i denne perioden.';
    const p = entry.projection;
    return 'Neste vakt: ' + fmtDayShort(p.workDate) + ' ' + fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, TZ) ? ' (til neste dag)' : '');
  }

  function openClockDialog(membership, shift, attId, kind) {
    clear(root);
    const previewMs = Date.now();
    const plannedAt = kind === 'in' ? shift.plannedStartAt : shift.plannedEndAt;
    root.appendChild(el('h2', { text: kind === 'in' ? 'Stemple inn' : 'Stemple ut', style: 'font-size:18px;margin:0 0 4px' }));
    root.appendChild(el('div', { text: tenantLabel(shift.tenantId) + ' · planlagt ' + fmtHM(plannedAt), style: 'font-size:13px;color:#666;margin-bottom:12px' }));

    // B9: this is a live PREVIEW, not the recorded observed fact. The observed
    // timestamp is captured from the single injected action instant on confirmation.
    root.appendChild(el('div', { text: 'Nå (forhåndsvisning): ' + fmtHM(previewMs) + ' — faktisk observert tidspunkt registreres når du bekrefter.', style: 'font-size:12px;color:#888;margin-bottom:8px' }));

    // declared time (defaults to the observed action time; editable if policy permits)
    root.appendChild(el('label', { text: 'Faktisk ' + (kind === 'in' ? 'start' : 'slutt') + ':', style: 'display:block;font-size:13px;margin-bottom:4px' }));
    const timeInput = el('input', { attrs: { type: 'time', value: fmtHM(previewMs) }, style: 'padding:8px;font-size:15px;margin-bottom:12px' });
    if (POLICY.employeeMayAdjustTime !== true) timeInput.disabled = true;
    let declaredEdited = false;
    timeInput.addEventListener('input', () => { declaredEdited = true; });
    root.appendChild(timeInput);

    // reason select (only codes valid for this kind) + note
    const reasonKind = kind === 'in' ? 'clock_in' : 'clock_out';
    root.appendChild(el('label', { text: 'Årsak (kreves ved avvik):', style: 'display:block;font-size:13px;margin-bottom:4px' }));
    const reasonSel = el('select', { style: 'width:100%;max-width:360px;padding:8px;font-size:15px;margin-bottom:8px' });
    reasonSel.appendChild(el('option', { text: '— Ingen —', attrs: { value: '' } }));
    for (const key of Object.keys(POLICY.reasonCodes)) {
      const cfg = POLICY.reasonCodes[key];
      if (cfg.appliesTo.includes(reasonKind)) reasonSel.appendChild(el('option', { text: REASON_LABELS[key] || key, attrs: { value: key } }));
    }
    root.appendChild(reasonSel);
    const noteInput = el('input', { attrs: { type: 'text', placeholder: 'Notat (kreves ved «Annet»)' }, style: 'width:100%;max-width:360px;padding:8px;font-size:14px;margin-bottom:10px' });
    root.appendChild(noteInput);

    const errBox = el('div', { style: 'color:#a33;font-size:13px;min-height:18px;margin-bottom:8px' });
    root.appendChild(errBox);

    const submit = el('button', { text: kind === 'in' ? 'Bekreft innstempling' : 'Bekreft utstempling', style: 'width:100%;max-width:360px;padding:12px;border:0;border-radius:10px;background:#2e7d46;color:#fff;font-size:15px;font-weight:700;cursor:pointer' });
    submit.addEventListener('click', () => {
      // B9: ONE injected action instant is both the observed fact and (by default) the
      // declared time. computeClockTimes never treats an earlier preview as observed.
      const { observedAt, declaredAt } = computeClockTimes({
        nowMs: Date.now(),
        declaredHM: declaredEdited ? timeInput.value : undefined,
        workDate: shift.workDate, timezone: TZ, mayAdjust: POLICY.employeeMayAdjustTime,
      });
      const now = observedAt;
      const declared = declaredAt;
      const reasonCode = reasonSel.value || null;
      const reasonNote = (noteInput.value || '').trim() || null;
      const actor = actorFromMembership(membership);
      const scope = { tenantId: membership.tenantId, shiftId: shift.shiftId };   // ETR-2c: full ScheduleScope — scope.shiftId is authority; the fixture shift.shiftId seeds it (equal packaging)
      let res;
      if (kind === 'in') {
        res = clockIn({ actor, shift, existing: attendanceStore.get(attId), declaredStartAt: declared, reasonCode, reasonNote, scope }, now, POLICY);
      } else {
        res = clockOut({ actor, existing: attendanceStore.get(attId), declaredEndAt: declared, reasonCode, reasonNote, scope }, now, POLICY);
      }
      if (res.ok) { attendanceStore.set(attId, res.attendance); goToday(membership); return; }
      if (res.code === 'REASON_REQUIRED') {
        const rr = reasonRequiredForClock(reasonKind, { declaredAt: declared, observedAt: now, plannedAt, policy: POLICY });
        errBox.textContent = 'Årsak kreves (avvik ' + Math.round(rr.declarationDeviationMin) + ' min fra registrert / ' + Math.round(rr.varianceMin) + ' min fra planlagt). Velg en gyldig årsak' + (reasonCode === 'OTHER' ? ' og skriv et notat.' : '.');
      } else {
        errBox.textContent = 'Kunne ikke registrere: ' + res.code;
      }
    });
    root.appendChild(submit);
    root.appendChild(backBtn('Avbryt', () => goToday(membership)));
  }

  // ETR-2b: minimal START/END BREAK confirm dialog. Observed break time = the single
  // injected instant on confirm; no reason prompt here (variance lives on declaration).
  function openBreakDialog(membership, shift, attId, kind) {
    clear(root);
    const previewMs = Date.now();
    const isStart = kind === 'break_start';
    root.appendChild(el('h2', { text: isStart ? 'Start pause' : 'Avslutt pause', style: 'font-size:18px;margin:0 0 4px' }));
    root.appendChild(el('div', { text: tenantLabel(shift.tenantId), style: 'font-size:13px;color:#666;margin-bottom:12px' }));
    root.appendChild(el('div', { text: 'Nå (forhåndsvisning): ' + fmtHM(previewMs) + ' — faktisk observert tidspunkt registreres når du bekrefter.', style: 'font-size:12px;color:#888;margin-bottom:8px' }));
    const errBox = el('div', { style: 'color:#a33;font-size:13px;min-height:18px;margin-bottom:8px' });
    root.appendChild(errBox);
    const submit = el('button', { text: isStart ? 'Bekreft pausestart' : 'Bekreft pauseslutt', style: 'width:100%;max-width:360px;padding:12px;border:0;border-radius:10px;background:#6a5acd;color:#fff;font-size:15px;font-weight:700;cursor:pointer' });
    submit.addEventListener('click', () => {
      const now = Date.now();   // single injected action instant = observed break time
      const actor = actorFromMembership(membership);
      const scope = { tenantId: membership.tenantId };
      const existing = attendanceStore.get(attId);
      const res = isStart
        ? startBreak({ actor, existing, scope }, now, POLICY)
        : endBreak({ actor, existing, scope }, now, POLICY);
      if (res.ok) { attendanceStore.set(attId, res.attendance); goToday(membership); return; }
      errBox.textContent = 'Kunne ikke registrere: ' + res.code;
    });
    root.appendChild(submit);
    root.appendChild(backBtn('Avbryt', () => goToday(membership)));
  }

  // ETR-2b: dedicated employee break DECLARATION. Observed total is shown as reference
  // only; the declared minutes are an explicit employee entry (never auto-filled from
  // observed). Reason prompt follows B13-B16 via the core variance gate.
  function openDeclareBreakDialog(membership, shift, attId) {
    clear(root);
    const att = attendanceStore.get(attId);
    root.appendChild(el('h2', { text: 'Registrer pausetid', style: 'font-size:18px;margin:0 0 4px' }));
    root.appendChild(el('div', { text: tenantLabel(shift.tenantId) + ' · forventet ' + POLICY.expectedBreakMinutes + ' min', style: 'font-size:13px;color:#666;margin-bottom:8px' }));
    root.appendChild(el('div', { text: 'Observert (kun referanse): ' + (att ? att.observedBreakMinutesTotal : 0) + ' min', style: 'font-size:12px;color:#888;margin-bottom:8px' }));
    root.appendChild(el('label', { text: 'Din oppgitte totale pausetid (minutter):', style: 'display:block;font-size:13px;margin-bottom:4px' }));
    const minInput = el('input', { attrs: { type: 'number', min: '0', step: '1', placeholder: 'minutter' }, style: 'width:100%;max-width:360px;padding:8px;font-size:15px;margin-bottom:12px' });
    root.appendChild(minInput);
    root.appendChild(el('label', { text: 'Årsak (kreves ved avvik):', style: 'display:block;font-size:13px;margin-bottom:4px' }));
    const reasonSel = el('select', { style: 'width:100%;max-width:360px;padding:8px;font-size:15px;margin-bottom:8px' });
    reasonSel.appendChild(el('option', { text: '— Ingen —', attrs: { value: '' } }));
    for (const key of Object.keys(POLICY.reasonCodes)) {
      const cfg = POLICY.reasonCodes[key];
      if (cfg.appliesTo.includes('break')) reasonSel.appendChild(el('option', { text: REASON_LABELS[key] || key, attrs: { value: key } }));
    }
    root.appendChild(reasonSel);
    const noteInput = el('input', { attrs: { type: 'text', placeholder: 'Notat (kreves ved «Annet»)' }, style: 'width:100%;max-width:360px;padding:8px;font-size:14px;margin-bottom:10px' });
    root.appendChild(noteInput);
    const errBox = el('div', { style: 'color:#a33;font-size:13px;min-height:18px;margin-bottom:8px' });
    root.appendChild(errBox);
    const submit = el('button', { text: 'Bekreft pausetid', style: 'width:100%;max-width:360px;padding:12px;border:0;border-radius:10px;background:#2e7d46;color:#fff;font-size:15px;font-weight:700;cursor:pointer' });
    submit.addEventListener('click', () => {
      const now = Date.now();
      const raw = (minInput.value || '').trim();
      if (raw === '' || !/^\d+$/.test(raw)) { errBox.textContent = 'Oppgi et helt antall minutter (0 eller mer).'; return; }
      const declaredBreakMinutesTotal = parseInt(raw, 10);
      const reasonCode = reasonSel.value || null;
      const reasonNote = (noteInput.value || '').trim() || null;
      const actor = actorFromMembership(membership);
      const scope = { tenantId: membership.tenantId };
      const res = declareBreak({ actor, existing: attendanceStore.get(attId), declaredBreakMinutesTotal, reasonCode, reasonNote, scope }, now, POLICY);
      if (res.ok) { attendanceStore.set(attId, res.attendance); goToday(membership); return; }
      if (res.code === 'REASON_REQUIRED') {
        const rr = reasonRequiredForBreak(declaredBreakMinutesTotal, POLICY);
        errBox.textContent = 'Årsak kreves (avvik ' + Math.round(rr.varianceMin) + ' min fra forventet ' + POLICY.expectedBreakMinutes + ' min). Velg en gyldig årsak' + (reasonCode === 'OTHER' ? ' og skriv et notat.' : '.');
      } else {
        errBox.textContent = 'Kunne ikke registrere: ' + res.code;
      }
    });
    root.appendChild(submit);
    root.appendChild(backBtn('Avbryt', () => goToday(membership)));
  }

  function goMyWork(membership) {
    current = membership; setChrome(membership, 'work');
    clear(root);
    const wrap = el('div', { cls: 'card', style: 'max-width:640px' });
    wrap.appendChild(el('div', { cls: 'kicker neutral', text: 'Jobb & økonomi' }));
    wrap.appendChild(el('h2', { text: 'Kommer senere' }));
    wrap.appendChild(el('div', { text: 'Lønn, skatt, feriepenger, dokumenter og økonomitall vises ikke her ennå.', style: 'color:#5f6b62;font-size:14px' }));
    root.appendChild(wrap);
    root.appendChild(backBtn('← Tilbake til i dag', () => goToday(membership)));
  }

  // ---- MIN PLAN (read-only week view; same membership, same schedule truth, clock state untouched) ----
  function goSchedule(membership) {
    current = membership; setChrome(membership, 'plan');
    const { shifts } = ownScheduleFor(membership);
    renderScheduleView(root, {
      membership, tenantLabel: tenantLabel(membership.tenantId), shifts,
      nowMs: Date.now(), timezone: TZ, roleLabels: ROLE_LABELS,
      onBack: () => goToday(membership),
    });
  }

  // ---- shared button builders ----
  function bigBtn(label, color, onClick) {
    const b = el('button', { text: label, style: 'display:block;width:100%;max-width:360px;padding:18px;margin:6px 0 14px;border:0;border-radius:14px;background:' + color + ';color:#fff;font-size:18px;font-weight:800;cursor:pointer' });
    b.addEventListener('click', onClick);
    return b;
  }
  function linkBtn(label, onClick) {
    const b = el('button', { text: label, style: 'display:block;width:100%;max-width:360px;text-align:left;padding:12px;margin-bottom:8px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;font-size:14px' });
    b.addEventListener('click', onClick);
    return b;
  }
  function backBtn(label, onClick) {
    const b = el('button', { text: label, style: 'margin-top:10px;padding:10px 14px;border:1px solid #999;border-radius:8px;background:#fff;cursor:pointer;font-size:13px' });
    b.addEventListener('click', onClick);
    return b;
  }

  route(DEFAULT_UID);   // land on the default review identity (Maria); "Bytt ansatt" opens the chooser
}
