// employee-shell-ui.mjs
// ETR-1 fixture membership routing + ETR-2a Today/Clocking (fixture-only, mobile-first).
// Synthetic data only. No real names, emails, UIDs, ansattIds, passwords, personnummer,
// or bank details. No network, no Firebase, no Firestore. Authority + clock transitions
// come ONLY from the pure core model. All fixture-derived text is rendered via textContent
// / created elements — never via innerHTML — so fixture values can never become markup.
// The UI reads the clock (Date.now()) and INJECTS it into the pure model; validators
// themselves never read a clock (see employee-shell-core.mjs). Fixture proof only (G3).

import {
  resolveRouting, selectMembership,
  ETR2A_POLICY, attendanceIdFor,
  clockIn, clockOut, reasonRequiredForClock,
  tenantWorkDate, fmtTenantHM, tenantLocalHMToUtcMs, computeClockTimes,
  startBreak, endBreak, declareBreak, reasonRequiredForBreak,
} from './employee-shell-core.mjs';

const POLICY = ETR2A_POLICY;

// ---- Synthetic identities / memberships (unchanged from ETR-1) ---------------
export const FIXTURE_USERS = [
  { uid: 'uid-tom', label: 'TEST: Tom — 0 aktive medlemskap' },
  { uid: 'uid-ida', label: 'TEST: Ida — 1 aktivt medlemskap' },
  { uid: 'uid-per', label: 'TEST: Per — 2 aktive medlemskap' },
];
export const FIXTURE_MEMBERSHIPS = [
  { uid: 'uid-tom', tenantId: 'tenant-alpha', accessRole: 'employee', ansattId: 'ansatt-101', accessEnabled: false },
  { uid: 'uid-ida', tenantId: 'tenant-alpha', accessRole: 'employee', ansattId: 'ansatt-102', accessEnabled: true },
  { uid: 'uid-per', tenantId: 'tenant-alpha', accessRole: 'employee', ansattId: 'ansatt-103', accessEnabled: true },
  { uid: 'uid-per', tenantId: 'tenant-beta', accessRole: 'employee', ansattId: 'ansatt-204', accessEnabled: true },
  { uid: 'uid-annen', tenantId: 'tenant-alpha', accessRole: 'employee', ansattId: 'ansatt-999', accessEnabled: true },
];
export const TENANT_LABELS = { 'tenant-alpha': 'Butikk Alpha (TEST)', 'tenant-beta': 'Kafé Beta (TEST)' };
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

// ---- Today's fixture planned shifts (one per routable ansattId), TODAY -------
// B8: workDate and planned instants are derived from the tenant policy timezone via
// the pure core helpers, NOT from host Date getters, so a device in another timezone
// still shows the correct tenant business day / local time.
const TZ = POLICY.timezone;
function todayShiftFor(ansattId, tenantId) {
  const wd = tenantWorkDate(Date.now(), TZ);
  const nowMs = Date.now();
  return {
    shiftId: 'shift-' + ansattId + '-' + wd,
    ansattId, tenantId,
    plannedStartAt: tenantLocalHMToUtcMs(wd, '12:00', TZ),
    plannedEndAt: tenantLocalHMToUtcMs(wd, '20:00', TZ),
    workDate: wd, status: 'assigned', revision: 1,
    createdByUid: 'fixture-admin', createdAt: nowMs, updatedAt: nowMs,
  };
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
    root.appendChild(el('div', {
      text: 'LOKAL TEST / FIKTIV identitet — dette er IKKE en ekte innlogging.',
      style: 'background:#fee;border:1px solid #f99;color:#900;padding:8px 10px;border-radius:8px;font-size:13px;margin-bottom:14px',
    }));
    root.appendChild(el('h2', { text: 'Velg testidentitet', style: 'font-size:18px;margin:0 0 10px' }));
    const sel = el('select', { style: 'width:100%;max-width:360px;padding:10px;font-size:15px;margin-bottom:12px' });
    sel.appendChild(el('option', { text: '— Velg fiktiv bruker —', attrs: { value: '' } }));
    for (const u of FIXTURE_USERS) sel.appendChild(el('option', { text: u.label, attrs: { value: u.uid } }));
    sel.addEventListener('change', () => { if (sel.value) route(sel.value); });
    root.appendChild(sel);
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
    root.appendChild(backBtn('Tilbake til testidentitet', goChooser));
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
    root.appendChild(backBtn('Tilbake til testidentitet', goChooser));
  }

  // ---- TODAY / CLOCKING (mobile-first landing) ------------------------------
  function goToday(membership) {
    clear(root);
    const shift = todayShiftFor(membership.ansattId, membership.tenantId);
    const attId = attendanceIdFor(shift.shiftId, membership.ansattId);
    const att = attendanceStore.get(attId) || null;   // L1: two reads (shift + attendance), no query

    // header + greeting
    const now = new Date();
    root.appendChild(el('div', { text: 'SORMENA', style: 'font-weight:800;letter-spacing:1px;color:#2e7d46;font-size:16px' }));
    root.appendChild(el('div', { text: 'I dag · ' + now.toLocaleDateString('nb-NO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }), style: 'color:#666;font-size:13px;margin-bottom:14px' }));

    // Today's shift card
    const card = el('div', { style: 'border:1px solid #dfe6df;border-radius:12px;padding:16px;background:#f6fff6;margin-bottom:16px' });
    card.appendChild(el('div', { text: 'Dagens vakt', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#2e7d46;font-weight:700;margin-bottom:6px' }));
    card.appendChild(el('div', { text: tenantLabel(shift.tenantId), style: 'font-weight:700;font-size:15px' }));
    card.appendChild(el('div', { text: 'Planlagt: ' + fmtHM(shift.plannedStartAt) + '–' + fmtHM(shift.plannedEndAt), style: 'font-size:14px;color:#333;margin-top:2px' }));
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
    root.appendChild(linkBtn('Min jobb & økonomi →', () => goMyWork(membership)));
    root.appendChild(linkBtn('Se hele planen →', () => goSchedulePlaceholder(membership)));
    root.appendChild(backBtn('Bytt arbeidsplass / identitet', goChooser));
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
      const scope = { tenantId: membership.tenantId };   // P2-2/P2-3: structural tenant/path scope, mandatory
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
    clear(root);
    root.appendChild(el('h2', { text: 'Min jobb & økonomi', style: 'font-size:18px;margin:0 0 10px' }));
    root.appendChild(el('div', {
      text: 'Plassholder (ETR-2a). Den personlige jobb- og økonomiportalen bygges senere. Ingen lønn, skatt, feriepenger, dokumenter eller økonomitall vises her ennå.',
      style: 'padding:14px;border:1px dashed #bbb;border-radius:8px;background:#fafafa;color:#555;font-size:14px',
    }));
    root.appendChild(backBtn('← Tilbake til i dag', () => goToday(membership)));
  }

  function goSchedulePlaceholder(membership) {
    clear(root);
    root.appendChild(el('h2', { text: 'Hele planen', style: 'font-size:18px;margin:0 0 10px' }));
    root.appendChild(el('div', {
      text: 'Plassholder (ETR-2a). Flerdags-/historikkvisning bygges ikke i denne delen.',
      style: 'padding:14px;border:1px dashed #bbb;border-radius:8px;background:#fafafa;color:#555;font-size:14px',
    }));
    root.appendChild(backBtn('← Tilbake til i dag', () => goToday(membership)));
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

  goChooser();
}
