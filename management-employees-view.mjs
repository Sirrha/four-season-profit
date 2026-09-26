// management-employees-view.mjs
// EMPLOYEE 360 / ANSATTSIDE — management Ansatte list, Ny ansatt (three fields only) and the
// five-section Ansattkort. Reads ONE employee store and the SAME shared schedule store the
// Vaktplan and employee views use; every mutation flows through the single operation boundary
// in management-employees-core.mjs (applyEmployeeOperation) — this view never mutates a record.
// Employment terms are immutable: a change APPENDS a period and prior periods render unchanged
// with DERIVED date ranges. Missing information is derived and shown honestly (never invented,
// never zero). Document METADATA only — no upload/storage/download/preview anywhere.
// PLANNED/EMPLOYMENT LAYER ONLY: no payroll history, no legacy ansatte.timelonn, no vakter.
// All data-derived text via textContent. Stacked sections stay readable on narrow viewports.

import { fmtTenantHM, tenantWorkDate } from './employee-shell-core.mjs';
import { isOvernight } from './employee-schedule-week.mjs';
import {
  employeesOf, employeeOf, startDateOf, currentTermsOf, termsWithRanges, contractStatusOf,
  missingInfoOf, applyEmployeeOperation, plannedHoursForEmployee, upcomingShiftsForEmployee,
  normalizeAddress,
  canViewEmployees, canViewCompensation, canEditEmployment, EMPLOYMENT_TYPES, DOC_CATEGORIES,
  PAYMENT_INTERVALS,
} from './management-employees-core.mjs';
import {
  CONTRACT_STATUS, contractInputsFor, contractReadinessOf, blocksForVersion,
  contractVersionsOf, draftVersionOf, contractStateOf, applyContractOperation,
  applyCompanyContractOperation,
} from './management-contract-core.mjs';
import { payrollProjectionForEmployee } from './management-payroll-core.mjs';

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
function fmtDate(wd) {
  if (!wd) return '–';
  const [y, m, d] = wd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('nb-NO', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}
function dayLabel(wd) {
  const [y, m, d] = wd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('nb-NO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}
function capFirst(s) { return s.replace(/^./, (c) => c.toUpperCase()); }
const SECTIONS = [
  { key: 'oversikt', label: 'Oversikt' },
  { key: 'arbeid', label: 'Arbeidsforhold' },
  { key: 'kontrakt', label: 'Kontrakt & dokumenter' },
  { key: 'lonn', label: 'Lønn & økonomi' },
  { key: 'tid', label: 'Tid & vaktplan' },
];

export function renderEmployeesView(root, { employeeStore, scheduleStore, tenantId, tenantLabel, roleLabels, actor, contractProfile, payrollStore, nowMs, timezone, onOpenVaktplanFor, onBack }) {
  if (!root) return;
  const todayWd = tenantWorkDate(nowMs, timezone);
  let page = 'list';           // 'list' | 'new' | 'card' | 'contract' | 'preview'
  let selectedId = null;
  let section = 'oversikt';
  let query = '';
  let errMsg = '';
  let step = 1;                // contract flow step 1..4 (resumable; state lives in the store)
  let previewVersionId = null; // which version the preview page renders (null = live draft)
  let companySetupOpen = false; // Avtaleoppsett editor: collapsed summary by default (UI state only)
  let companyDraft = null;      // transient unsaved editor values; the ONE truth stays contractProfile

  const fmtHM = (t) => fmtTenantHM(t, timezone);
  const roleOf = (k) => (roleLabels && k && roleLabels[k] ? roleLabels[k] : k || '–');
  const fmtKr = (v) => 'kr ' + Math.round(v).toLocaleString('nb-NO');
  const fmtH = (h) => h.toLocaleString('nb-NO', { maximumFractionDigits: 2 }) + ' t';
  const monthScope = () => ({ kind: 'month', year: Number(todayWd.slice(0, 4)), month: Number(todayWd.slice(5, 7)) });

  function opError(code) {
    if (code === 'NAME_REQUIRED') return 'Navn må fylles ut.';
    if (code === 'STARTDATE_INVALID') return 'Oppgi en gyldig startdato.';
    if (code === 'ROLE_REQUIRED') return 'Velg en stilling/rolle.';
    if (code === 'VALIDFROM_INVALID') return 'Oppgi en gyldig «gjelder fra»-dato.';
    if (code === 'TERMS_DUPLICATE_VALIDFROM') return 'Det finnes allerede en periode som gjelder fra denne datoen.';
    if (code === 'COMPENSATION_INVALID') return 'Lønnsgrunnlaget må være et positivt beløp.';
    if (code === 'PERCENTAGE_INVALID') return 'Stillingsprosent må være mellom 1 og 100.';
    if (code === 'EMPLOYMENTTYPE_INVALID') return 'Ugyldig stillingstype.';
    if (code === 'ENDDATE_INVALID') return 'Oppgi en gyldig sluttdato.';
    if (code === 'ALREADY_ENDED') return 'Den ansatte er allerede registrert som sluttet.';
    if (code === 'DOC_NAME_REQUIRED') return 'Dokumentet må ha et navn.';
    if (code === 'DOC_CATEGORY_INVALID') return 'Velg en gyldig kategori.';
    if (code === 'BIRTHDATE_INVALID') return 'Ugyldig dato.';
    if (code === 'BIRTHDATE_FUTURE') return 'Fødselsdato kan ikke være i fremtiden.';
    if (code === 'BIRTHDATE_BEFORE_1900') return 'Fødselsdato kan ikke være før 1900.';
    if (code === 'ADDRESS_STREET_REQUIRED') return 'Gateadresse må fylles ut.';
    if (code === 'ADDRESS_POSTALCODE_INVALID') return 'Postnummer må være fire siffer.';
    if (code === 'ADDRESS_CITY_REQUIRED') return 'Poststed må fylles ut.';
    if (code === 'NOT_AUTHORIZED') return 'Du har ikke tilgang til å endre arbeidsforhold.';
    return 'Kunne ikke lagre (' + code + ').';
  }
  function apply(op, after) {
    const res = applyEmployeeOperation({ store: employeeStore, tenantId, actor, op, now: Date.now() });
    if (res.ok) { errMsg = ''; if (typeof after === 'function') after(res); } else { errMsg = opError(res.code); }
    draw();
  }
  function applyC(op, after) {
    const res = applyContractOperation({ store: employeeStore, tenantId, actor, op, profile: contractProfile, now: Date.now(), onDate: todayWd, roleLabels });
    if (res.ok) { errMsg = ''; if (typeof after === 'function') after(res); }
    else if (res.code === 'NOT_READY') errMsg = 'Kan ikke fryses ennå: ' + res.missing.map((m) => m.label).join(', ') + ' mangler.';
    else if (res.code === 'TERMS_PERIOD_FROZEN_IN_CONTRACT') errMsg = 'Perioden er låst av en frosset avtale. Legg til en ny periode i stedet.';
    else errMsg = opError(res.code);
    draw();
  }
  const inputsFor = (e) => contractInputsFor({ employee: e, profile: contractProfile, onDate: todayWd, roleLabels });
  const readinessFor = (e) => contractReadinessOf(inputsFor(e));
  function btn(label, cls, onClick) {
    const b = el('button', { cls, text: label, attrs: { type: 'button' } });
    b.addEventListener('click', onClick);
    return b;
  }
  function field(label, input) {
    const wrap = el('div');
    wrap.appendChild(el('label', { text: label }));
    wrap.appendChild(input);
    return wrap;
  }
  function textInput(value, placeholder, type) {
    return el('input', { attrs: Object.assign({ type: type || 'text' }, value != null ? { value } : {}, placeholder ? { placeholder } : {}) });
  }
  function selectInput(options, value) {
    const s = el('select');
    for (const o of options) {
      const opt = el('option', { text: o.label, attrs: { value: o.value } });
      if (o.value === value) opt.setAttribute('selected', 'selected');
      s.appendChild(opt);
    }
    return s;
  }
  const roleOptions = () => {
    const keys = roleLabels ? Object.keys(roleLabels) : [];
    return keys.map((k) => ({ value: k, label: roleLabels[k] }));
  };
  function miss(list) {
    const wrap = el('div', { cls: 'emp-miss' });
    for (const m of list) wrap.appendChild(el('span', { cls: 'mtag', text: m }));
    return wrap;
  }
  function head(title, sub) {
    const h = el('div', { cls: 'plan-head' });
    const ht = el('div');
    ht.appendChild(el('h1', { text: title }));
    if (sub) ht.appendChild(el('div', { cls: 'sub', text: sub }));
    h.appendChild(ht);
    return h;
  }

  // ---- ANSATTE LIST ----
  function drawList() {
    root.appendChild(head('Ansatte', tenantLabel + ' · arbeidsforhold og ansattkort'));
    const search = el('div', { cls: 'vp-search' });
    const input = textInput(query, 'Søk ansatt …');
    input.setAttribute('aria-label', 'Søk ansatt');
    input.addEventListener('input', () => { query = input.value; draw(); const f = root.querySelector('.vp-search input'); if (f) { f.focus(); const v = f.value; f.setSelectionRange(v.length, v.length); } });
    search.appendChild(input);
    if (query.trim() !== '') search.appendChild(btn('Nullstill', 'clr', () => { query = ''; draw(); }));
    search.appendChild(btn('Ny ansatt', 'btn primary', () => { page = 'new'; errMsg = ''; draw(); }));
    root.appendChild(search);

    const q = query.trim().toLowerCase();
    const list = employeesOf(employeeStore, tenantId).filter((e) => !q || e.name.toLowerCase().includes(q));
    const card = el('div', { cls: 'card' });
    if (!list.length) card.appendChild(el('div', { style: 'color:var(--faint);font-size:14px', text: 'Ingen ansatte å vise.' }));
    for (const e of list) {
      const t = currentTermsOf(e, todayWd) || e.terms[e.terms.length - 1];
      const row = el('button', { cls: 'emp-row', attrs: { type: 'button', 'aria-label': 'Åpne ansattkort for ' + e.name } });
      const top = el('div', { cls: 'top' });
      top.appendChild(el('div', { cls: 'nm', text: e.name }));
      top.appendChild(el('span', { cls: 'st' + (e.status === 'active' ? ' on' : ''), text: e.status === 'active' ? 'Aktiv' : 'Sluttet' }));
      row.appendChild(top);
      const bits = [roleOf(t ? t.role : null)];
      if (t && t.employmentType) bits.push(t.employmentType);
      if (t && t.percentage != null) bits.push(t.percentage + ' %');
      row.appendChild(el('div', { cls: 'sub', text: bits.join(' · ') }));
      const m = missingInfoOf(e, todayWd).slice();
      const cs = contractStateOf(e);
      if (cs.state === 'mangler') m.push('mangler arbeidsavtale');
      else if (cs.state === 'utkast') m.push('arbeidsavtale er utkast');
      if (m.length) row.appendChild(miss(m));
      row.addEventListener('click', () => { selectedId = e.ansattId; section = 'oversikt'; page = 'card'; errMsg = ''; draw(); });
      card.appendChild(row);
    }
    root.appendChild(card);
    if (canEditEmployment(actor)) drawCompanyFacts();
    if (typeof onBack === 'function') root.appendChild(btn('← Tilbake', 'btn tertiary', onBack));
  }

  // ---- COMPANY-CONTRACT FACTS — configured ONCE for Four Season, reused in every agreement.
  // Management-surface summary of the ONE shared truth (contractProfile.companyFacts); the
  // agreement document itself still renders from the core's blocks. `complete` mirrors the
  // core readiness semantics for the four shared facts.
  function companyFactSummary() {
    const f = (contractProfile && contractProfile.companyFacts) || {};
    const pen = f.pension || {}, yrk = f.occupationalInjuryInsurance || {}, ta = f.tariffavtale || {};
    const s = (applies, detail, miss) => (applies === true ? 'Ja – ' + (detail || miss) : applies === false ? 'Nei' : 'Ikke bekreftet');
    return {
      rows: [
        ['Pensjonsordning', s(pen.applies, pen.provider, 'leverandør ikke bekreftet')],
        ['Yrkesskadeforsikring', s(yrk.applies, yrk.insurer, 'forsikringsselskap ikke bekreftet')],
        ['Tariffavtale', s(ta.applies, ta.agreementName, 'avtaledetaljer ikke bekreftet')],
        ['Lønnsutbetaling – dato/ordning', f.salaryPaymentArrangement || 'Ikke bekreftet'],
      ],
      complete: !(pen.applies == null || (pen.applies === true && !pen.provider)
        || yrk.applies == null || (yrk.applies === true && !yrk.insurer)
        || ta.applies == null || (ta.applies === true && !ta.agreementName)
        || !f.salaryPaymentArrangement),
    };
  }
  // Collapsed compact summary by default; the full editor opens only via "Rediger avtaleoppsett".
  // Dependent detail fields render ONLY while the controlling answer is Ja. Unsaved editor values
  // live in the transient companyDraft; saving goes through the shared operation boundary.
  function drawCompanyFacts() {
    const sum = companyFactSummary();
    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker neutral', text: 'Avtaleoppsett – Four Season (felles for alle ansatte)' }));
    if (!companySetupOpen) {
      for (const r of sum.rows) card.appendChild(factRow(r[0], r[1]));
      if (!sum.complete) card.appendChild(el('div', { cls: 'cue-line', text: 'Ufullstendige selskapsopplysninger blokkerer frysing av avtaler.' }));
      card.appendChild(btn('Rediger avtaleoppsett', 'btn secondary', () => { companySetupOpen = true; companyDraft = null; errMsg = ''; draw(); }));
      root.appendChild(card);
      return;
    }
    card.className = 'card emp-form';
    const f = (contractProfile && contractProfile.companyFacts) || {};
    if (!companyDraft) {
      const pen = f.pension || {}, yrk = f.occupationalInjuryInsurance || {}, ta = f.tariffavtale || {};
      const enc = (a) => (a === true ? 'ja' : a === false ? 'nei' : '');
      companyDraft = { pen: enc(pen.applies), penProv: pen.provider || '', yrk: enc(yrk.applies), yrkIns: yrk.insurer || '', ta: enc(ta.applies), taName: ta.agreementName || '', taParties: ta.parties || '', salary: f.salaryPaymentArrangement || '' };
    }
    const d = companyDraft;
    card.appendChild(el('div', { cls: 'cue-line', text: 'Settes én gang og gjenbrukes i alle arbeidsavtaler. Ubekreftede fakta vises ærlig i avtalen og blokkerer frysing.' }));
    const jaNei = (v, key) => {
      const s = selectInput([{ value: '', label: 'Ikke bekreftet' }, { value: 'ja', label: 'Ja' }, { value: 'nei', label: 'Nei' }], v);
      s.addEventListener('change', () => { companyDraft[key] = s.value; draw(); });
      return s;
    };
    const bound = (input, key) => { input.addEventListener('input', () => { companyDraft[key] = input.value; }); return input; };
    card.appendChild(field('Pensjonsordning', jaNei(d.pen, 'pen')));
    if (d.pen === 'ja') card.appendChild(field('Pensjonsleverandør', bound(textInput(d.penProv, 'pensjonsleverandør/institusjon'), 'penProv')));
    card.appendChild(field('Yrkesskadeforsikring', jaNei(d.yrk, 'yrk')));
    if (d.yrk === 'ja') card.appendChild(field('Forsikringsselskap', bound(textInput(d.yrkIns, 'forsikringsselskap'), 'yrkIns')));
    card.appendChild(field('Tariffavtale', jaNei(d.ta, 'ta')));
    if (d.ta === 'ja') {
      card.appendChild(field('Tariffavtale – avtalenavn', bound(textInput(d.taName, 'avtalenavn'), 'taName')));
      card.appendChild(field('Tariffavtale – parter (valgfritt)', bound(textInput(d.taParties, 'parter'), 'taParties')));
    }
    card.appendChild(field('Lønnsutbetaling – dato/ordning', bound(textInput(d.salary, 'f.eks. den 25. i hver måned'), 'salary')));
    card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
    const acts = el('div', { cls: 'vp-actions' });
    acts.appendChild(btn('Lagre avtaleoppsett', 'btn primary', () => {
      const parse = (s) => (s === 'ja' ? true : s === 'nei' ? false : null);
      const ops = [
        { kind: 'setPension', applies: parse(d.pen), provider: d.penProv },
        { kind: 'setOccupationalInjuryInsurance', applies: parse(d.yrk), insurer: d.yrkIns },
        { kind: 'setTariffavtale', applies: parse(d.ta), agreementName: d.taName, parties: d.taParties },
        { kind: 'setSalaryPaymentArrangement', arrangement: d.salary },
      ];
      for (const op of ops) {
        const res = applyCompanyContractOperation({ profile: contractProfile, actor, op });
        if (!res.ok) { errMsg = opError(res.code); draw(); return; }
      }
      errMsg = ''; companySetupOpen = false; companyDraft = null; draw();
    }));
    acts.appendChild(btn('Lukk', 'btn tertiary', () => { companySetupOpen = false; companyDraft = null; errMsg = ''; draw(); }));
    card.appendChild(acts);
    card.appendChild(el('div', { cls: 'vp-note', text: 'Lagres kun lokalt i denne forhåndsvisningen – ingen produksjonslagring i denne versjonen.' }));
    root.appendChild(card);
  }

  // Read-only inherited company facts inside the Contract flow (steps 3–4). Same ONE truth;
  // "Fullfør selskapsopplysninger" reveals the same single shared editor — no per-employee copy.
  function inheritedFactsCard() {
    const sum = companyFactSummary();
    const c = el('div', { cls: 'card' });
    c.appendChild(el('div', { cls: 'kicker neutral', text: 'Felles opplysninger fra Four Season' }));
    for (const r of sum.rows) c.appendChild(factRow(r[0], r[1]));
    if (!sum.complete) {
      c.appendChild(el('div', { cls: 'cue-line', text: 'Selskapsopplysningene er ufullstendige og blokkerer frysing av avtalen.' }));
      c.appendChild(btn('Fullfør selskapsopplysninger', 'btn secondary', () => { page = 'list'; companySetupOpen = true; companyDraft = null; errMsg = ''; draw(); }));
    } else {
      c.appendChild(el('div', { cls: 'vp-note', text: 'Hentes fra det felles avtaleoppsettet og gjelder alle ansatte.' }));
    }
    root.appendChild(c);
  }

  // ---- NY ANSATT (exactly three required fields) ----
  function drawNew() {
    root.appendChild(head('Ny ansatt', 'Bare navn, startdato og stilling kreves nå'));
    const card = el('div', { cls: 'card emp-form' });
    const name = textInput('', 'Fornavn');
    const start = textInput(todayWd, null, 'date');
    const role = selectInput(roleOptions(), 'butikkmedarbeider');
    card.appendChild(field('Navn', name));
    card.appendChild(field('Startdato', start));
    card.appendChild(field('Stilling', role));
    // Optional continuation — creation never depends on it (design §1.1).
    const contLab = el('label', { cls: 'emp-check' });
    const contChk = el('input', { attrs: { type: 'checkbox' } });
    contLab.appendChild(contChk);
    contLab.appendChild(document.createTextNode('Fullfør arbeidsavtale nå'));
    card.appendChild(contLab);
    card.appendChild(el('div', { cls: 'cue-line', text: 'Resten (stillingsprosent, lønnsgrunnlag, arbeidsavtale) kan fylles ut senere. Ansatte uten disse vises som ufullstendige.' }));
    card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
    const acts = el('div', { cls: 'vp-actions' });
    acts.appendChild(btn('Opprett ansatt', 'btn primary', () => {
      const wantContract = contChk.checked;
      apply({ kind: 'createEmployee', name: name.value, startDate: start.value, role: role.value }, (res) => {
        // Employee creation SUCCEEDS FIRST; the contract flow only opens afterwards.
        selectedId = res.ansattId; section = 'kontrakt';
        if (wantContract) { step = 1; page = 'contract'; if (!draftVersionOf(res.employee)) applyContractOperation({ store: employeeStore, tenantId, actor, op: { kind: 'startDraft', ansattId: res.ansattId }, profile: contractProfile, now: Date.now(), onDate: todayWd, roleLabels }); }
        else page = 'card';
      });
    }));
    acts.appendChild(btn('Avbryt', 'btn tertiary', () => { page = 'list'; errMsg = ''; draw(); }));
    card.appendChild(acts);
    root.appendChild(card);
  }

  // ---- ANSATTKORT ----
  function drawCard() {
    const e = employeeOf(employeeStore, tenantId, selectedId);
    if (!e) { page = 'list'; return drawList(); }
    const cur = currentTermsOf(e, todayWd) || e.terms[e.terms.length - 1];
    root.appendChild(head(e.name, roleOf(cur ? cur.role : null) + ' · ' + (e.status === 'active' ? 'Aktiv' : 'Sluttet ' + fmtDate(e.endedAt))));
    const back = btn('← Alle ansatte', 'btn tertiary', () => { page = 'list'; errMsg = ''; draw(); });
    back.style.cssText = 'width:auto;padding:4px 0;min-height:0;margin-bottom:10px';
    root.appendChild(back);

    const seg = el('div', { cls: 'seg emp-seg', attrs: { role: 'tablist', 'aria-label': 'Seksjon' } });
    for (const s of SECTIONS) {
      const b = el('button', { text: s.label, cls: section === s.key ? 'on' : '', attrs: { type: 'button', role: 'tab', 'aria-selected': section === s.key ? 'true' : 'false' } });
      b.addEventListener('click', () => { section = s.key; errMsg = ''; draw(); });
      seg.appendChild(b);
    }
    root.appendChild(seg);

    if (section === 'oversikt') drawOversikt(e, cur);
    else if (section === 'arbeid') drawArbeid(e, cur);
    else if (section === 'kontrakt') drawKontrakt(e);
    else if (section === 'lonn') drawLonn(e, cur);
    else drawTid(e);
  }

  function factRow(label, value) {
    const r = el('div', { cls: 'emp-fact' });
    r.appendChild(el('div', { cls: 'k', text: label }));
    r.appendChild(el('div', { cls: 'v', text: value }));
    return r;
  }

  function drawOversikt(e, cur) {
    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker', text: 'Oversikt' }));
    card.appendChild(factRow('Status', e.status === 'active' ? 'Aktiv' : 'Sluttet ' + fmtDate(e.endedAt)));
    card.appendChild(factRow('Stilling', roleOf(cur ? cur.role : null)));
    card.appendChild(factRow('Stillingstype', cur && cur.employmentType ? cur.employmentType : 'Ikke registrert'));
    card.appendChild(factRow('Stillingsprosent', cur && cur.percentage != null ? cur.percentage + ' %' : 'Ikke registrert'));
    card.appendChild(factRow('Startdato', fmtDate(startDateOf(e))));
    let comp = 'Ikke registrert';
    if (canViewCompensation(actor) && cur && cur.compensation) {
      comp = cur.compensation.model === 'timelonn' ? fmtKr(cur.compensation.hourlyRate) + ' per time' : fmtKr(cur.compensation.monthlySalary) + ' per måned';
    } else if (!canViewCompensation(actor)) comp = 'Skjult';
    card.appendChild(factRow('Lønnsgrunnlag', comp));
    card.appendChild(factRow('Kontrakt', contractStatusOf(e) === 'finnes' ? 'Registrert' : 'Mangler'));
    const wkHours = plannedHoursForEmployee(scheduleStore, tenantId, e.ansattId, { kind: 'week', anchorWorkDate: todayWd });
    card.appendChild(factRow('Planlagte timer denne uken', fmtH(wkHours)));
    const up = upcomingShiftsForEmployee(scheduleStore, tenantId, e.ansattId, actor, nowMs, 1);
    card.appendChild(factRow('Neste vakt', up.length
      ? capFirst(dayLabel(up[0].projection.workDate)) + ' · ' + fmtHM(up[0].projection.plannedStartAt) + '–' + fmtHM(up[0].projection.plannedEndAt)
      : 'Ingen planlagte vakter'));
    const m = missingInfoOf(e, todayWd);
    if (m.length) { card.appendChild(el('div', { cls: 'cue-line', text: 'Mangler informasjon:' })); card.appendChild(miss(m)); }
    card.appendChild(el('div', { cls: 'vp-note', text: 'Fravær, ferie og tilgang kommer senere.' }));
    root.appendChild(card);
  }

  function drawArbeid(e, cur) {
    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker', text: 'Gjeldende arbeidsforhold' }));
    if (cur) {
      card.appendChild(factRow('Gjelder fra', fmtDate(cur.validFrom)));
      card.appendChild(factRow('Stilling', roleOf(cur.role)));
      card.appendChild(factRow('Stillingstype', cur.employmentType || 'Ikke registrert'));
      card.appendChild(factRow('Stillingsprosent', cur.percentage != null ? cur.percentage + ' %' : 'Ikke registrert'));
      card.appendChild(factRow('Arbeidssted', cur.workplace || 'Ikke registrert'));
      card.appendChild(factRow('Avtalt arbeidstid', cur.expectedWeeklyHours != null ? fmtH(cur.expectedWeeklyHours) + ' per uke' : 'Ikke registrert'));
      card.appendChild(factRow('Arbeidstidsordning', cur.workingTimeArrangement || 'Ikke registrert'));
      card.appendChild(factRow('Prøvetid', cur.probation || 'Ikke registrert'));
      card.appendChild(factRow('Oppsigelsestid', cur.noticePeriod || 'Ikke registrert'));
    }
    card.appendChild(el('div', { cls: 'vp-note', text: 'Dette er arbeidsforholdet slik det er registrert her – ikke en juridisk fullstendig arbeidsavtale.' }));
    root.appendChild(card);

    if (canEditEmployment(actor) && e.status === 'active') {
      const form = el('div', { cls: 'card emp-form' });
      form.appendChild(el('div', { cls: 'kicker', text: 'Ny periode (endring)' }));
      form.appendChild(el('div', { cls: 'cue-line', text: 'En endring lagres som en ny periode. Tidligere perioder endres aldri.' }));
      const vf = textInput(todayWd, null, 'date');
      const role = selectInput(roleOptions(), cur ? cur.role : null);
      const type = selectInput([{ value: '', label: 'Ikke registrert' }].concat(EMPLOYMENT_TYPES.map((x) => ({ value: x, label: x }))), cur && cur.employmentType ? cur.employmentType : '');
      const pct = textInput(cur && cur.percentage != null ? String(cur.percentage) : '', 'f.eks. 60', 'number');
      const compModel = selectInput([{ value: '', label: 'Ikke registrert' }, { value: 'timelonn', label: 'Timelønn' }, { value: 'fastlonn', label: 'Fastlønn' }], cur && cur.compensation ? cur.compensation.model : '');
      const compVal = textInput(cur && cur.compensation ? String(cur.compensation.model === 'timelonn' ? cur.compensation.hourlyRate : cur.compensation.monthlySalary) : '', 'beløp', 'number');
      const hours = textInput(cur && cur.expectedWeeklyHours != null ? String(cur.expectedWeeklyHours) : '', 'f.eks. 37.5', 'number');
      const notice = textInput(cur && cur.noticePeriod ? cur.noticePeriod : '', 'f.eks. 1 måned');
      form.appendChild(field('Gjelder fra', vf));
      form.appendChild(field('Stilling', role));
      form.appendChild(field('Stillingstype', type));
      form.appendChild(field('Stillingsprosent', pct));
      form.appendChild(field('Lønnsgrunnlag', compModel));
      form.appendChild(field('Beløp (kr per time / per måned)', compVal));
      form.appendChild(field('Avtalt arbeidstid (timer per uke)', hours));
      form.appendChild(field('Oppsigelsestid', notice));
      form.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      form.appendChild(btn('Lagre ny periode', 'btn primary', () => {
        const terms = { validFrom: vf.value, role: role.value };
        terms.employmentType = type.value || null;
        terms.percentage = pct.value === '' ? null : Number(pct.value);
        terms.expectedWeeklyHours = hours.value === '' ? null : Number(hours.value);
        terms.noticePeriod = notice.value.trim() || null;
        if (compModel.value === 'timelonn') terms.compensation = { model: 'timelonn', hourlyRate: Number(compVal.value) };
        else if (compModel.value === 'fastlonn') terms.compensation = { model: 'fastlonn', monthlySalary: Number(compVal.value) };
        else terms.compensation = null;
        apply({ kind: 'appendTerms', ansattId: e.ansattId, terms });
      }));
      root.appendChild(form);
    }

    const hist = el('div', { cls: 'card' });
    hist.appendChild(el('div', { cls: 'kicker neutral', text: 'Perioder (nyeste først)' }));
    for (const r of termsWithRanges(e)) {
      const b = el('div', { cls: 'emp-period' });
      b.appendChild(el('div', { cls: 'rg', text: fmtDate(r.validFrom) + ' – ' + (r.validTo ? fmtDate(r.validTo) : 'løpende') }));
      const bits = [roleOf(r.terms.role)];
      if (r.terms.employmentType) bits.push(r.terms.employmentType);
      if (r.terms.percentage != null) bits.push(r.terms.percentage + ' %');
      if (canViewCompensation(actor) && r.terms.compensation) {
        bits.push(r.terms.compensation.model === 'timelonn' ? fmtKr(r.terms.compensation.hourlyRate) + '/t' : fmtKr(r.terms.compensation.monthlySalary) + '/mnd');
      }
      b.appendChild(el('div', { cls: 'bits', text: bits.join(' · ') }));
      hist.appendChild(b);
    }
    root.appendChild(hist);

    if (canEditEmployment(actor) && e.status === 'active') {
      const endCard = el('div', { cls: 'card emp-form' });
      endCard.appendChild(el('div', { cls: 'kicker neutral', text: 'Avslutt arbeidsforhold' }));
      const ed = textInput(todayWd, null, 'date');
      endCard.appendChild(field('Sluttdato', ed));
      endCard.appendChild(el('div', { cls: 'cue-line', text: 'Den ansatte slettes aldri – historikk og vakter forblir synlige.' }));
      endCard.appendChild(btn('Registrer som sluttet', 'btn secondary danger', () => apply({ kind: 'endEmployee', ansattId: e.ansattId, endDate: ed.value })));
      root.appendChild(endCard);
    }
  }

  // ---- CONTRACT FLOW: four resumable steps. Every field writes to its CANONICAL home through
  // the employee operation boundary (contact -> employee record, employment facts -> terms).
  // The contract version stores none of these values; the flow is a doorway, not a store. ----
  function stepBar(e) {
    const bar = el('div', { cls: 'emp-steps' });
    const labels = ['Person & arbeidssted', 'Arbeidsforhold', 'Lønn & vilkår', 'Gjennomgang'];
    labels.forEach((l, i) => {
      const n = i + 1;
      const b = el('button', { cls: 'st' + (step === n ? ' on' : ''), text: n + '. ' + l, attrs: { type: 'button' } });
      b.addEventListener('click', () => { step = n; errMsg = ''; draw(); });
      bar.appendChild(b);
    });
    return bar;
  }
  function termsPatchFrom(fields) {
    const patch = {};
    for (const k of Object.keys(fields)) {
      const v = fields[k]();
      if (v === '' || v == null) continue;
      patch[k] = v;
    }
    return patch;
  }
  function saveTerms(e, patch, nextStep) {
    if (!Object.keys(patch).length) { step = nextStep; errMsg = ''; draw(); return; }
    apply({ kind: 'completeCurrentTerms', ansattId: e.ansattId, terms: patch }, () => { step = nextStep; });
  }
  function drawContractFlow() {
    const e = employeeOf(employeeStore, tenantId, selectedId);
    if (!e) { page = 'list'; return drawList(); }
    const cur = currentTermsOf(e, todayWd) || e.terms[e.terms.length - 1];
    const rd = readinessFor(e);
    root.appendChild(head('Arbeidsavtale', e.name + ' · ' + rd.label));
    const back = btn('← Til ansattkortet', 'btn tertiary', () => { page = 'card'; section = 'kontrakt'; errMsg = ''; draw(); });
    back.style.cssText = 'width:auto;padding:4px 0;min-height:0;margin-bottom:10px';
    root.appendChild(back);
    root.appendChild(stepBar(e));
    const card = el('div', { cls: 'card emp-form' });

    if (step === 1) {
      card.appendChild(el('div', { cls: 'kicker', text: '1. Person & arbeidssted' }));
      // ONE canonical address truth, three owner-facing fields. A pre-shape free-text value is
      // shown verbatim, read-only, as a transcription aid — never auto-copied into the fields.
      const adr = normalizeAddress(e.contact.address) || { street: '', postalCode: '', city: '' };
      const street = textInput(adr.street || '', 'f.eks. Storgata 20');
      const postal = textInput(adr.postalCode || '', 'f.eks. 2815');
      const city = textInput(adr.city || '', 'f.eks. Gjøvik');
      const bd = textInput(e.contact.birthDate || '', null, 'date');
      const email = textInput(e.contact.email || '', 'valgfri e-post');
      const phone = textInput(e.contact.phone || '', 'valgfritt telefonnummer');
      const wp = textInput(cur && cur.workplace ? cur.workplace : '', 'f.eks. 4Seasons ferske varer');
      if (cur && cur.workplace) wp.setAttribute('readonly', 'readonly');
      card.appendChild(field('Gateadresse', street));
      card.appendChild(field('Postnummer', postal));
      card.appendChild(field('Poststed', city));
      if (adr.legacyText) {
        const lt = el('div', { cls: 'cue-line' });
        lt.appendChild(el('span', { text: 'Tidligere adresse (uformatert): ' }));
        lt.appendChild(el('span', { text: adr.legacyText }));
        card.appendChild(lt);
      }
      card.appendChild(field('Fødselsdato', bd));
      card.appendChild(field('E-post (valgfri)', email));
      card.appendChild(field('Telefon (valgfri)', phone));
      card.appendChild(field('Arbeidssted', wp));
      // SECURITY-DEFERRED design elements: future placement only. Disabled, non-collecting,
      // never persisted — they activate only after the Login/Security module.
      const locked = (label) => {
        const i = textInput('', 'Aktiveres etter sikkerhetsmodul');
        i.setAttribute('disabled', 'disabled');
        i.setAttribute('aria-disabled', 'true');
        const w = field(label, i);
        w.className = 'emp-locked';
        return w;
      };
      card.appendChild(locked('Fødselsnummer'));
      card.appendChild(locked('Kontonummer'));
      card.appendChild(el('div', { cls: 'vp-note', text: 'Arbeidssted lagres i arbeidsforholdet, ikke som en egen kopi på ansattkortet. Fødselsnummer og kontonummer samles ikke inn nå – feltene aktiveres først etter sikkerhetsmodulen.' }));
      card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      card.appendChild(btn('Lagre og fortsett', 'btn primary', () => {
        const anyAddress = street.value.trim() !== '' || postal.value.trim() !== '' || city.value.trim() !== '';
        const patch = { email: email.value.trim() || null, phone: phone.value.trim() || null, birthDate: bd.value || null };
        if (anyAddress) patch.address = { street: street.value, postalCode: postal.value, city: city.value };
        const res = applyEmployeeOperation({ store: employeeStore, tenantId, actor, op: { kind: 'updateContact', ansattId: e.ansattId, contact: patch }, now: Date.now(), timezone });
        if (!res.ok) { errMsg = opError(res.code); draw(); return; }
        saveTerms(e, termsPatchFrom({ workplace: () => (cur && cur.workplace ? '' : wp.value.trim()) }), 2);
      }));
    } else if (step === 2) {
      card.appendChild(el('div', { cls: 'kicker', text: '2. Arbeidsforhold' }));
      const type = selectInput([{ value: '', label: 'Velg …' }].concat(EMPLOYMENT_TYPES.map((x) => ({ value: x, label: x }))), cur && cur.employmentType ? cur.employmentType : '');
      const basis = textInput(cur && cur.employmentBasis ? cur.employmentBasis : '', 'kun ved midlertidig ansettelse');
      const endD = textInput(cur && cur.employmentEndDate ? cur.employmentEndDate : '', null, 'date');
      const pct = textInput(cur && cur.percentage != null ? String(cur.percentage) : '', 'f.eks. 60', 'number');
      const wta = textInput(cur && cur.workingTimeArrangement ? cur.workingTimeArrangement : '', 'f.eks. dagtid og kveld etter vaktplan');
      const hrs = textInput(cur && cur.expectedWeeklyHours != null ? String(cur.expectedWeeklyHours) : '', 'f.eks. 22.5', 'number');
      const brk = textInput(cur && cur.breaksArrangement ? cur.breaksArrangement : '', 'f.eks. 30 min ubetalt pause per vakt over 5,5 t');
      const sch = textInput(cur && cur.scheduleChangeHandling ? cur.scheduleChangeHandling : '', 'f.eks. vaktplan varsles 14 dager før');
      const prb = textInput(cur && cur.probation ? cur.probation : '', 'f.eks. 6 måneder / ingen');
      const notice = textInput(cur && cur.noticePeriod ? cur.noticePeriod : '', 'f.eks. 1 måned');
      card.appendChild(field('Ansettelsesform', type));
      card.appendChild(field('Grunnlag for midlertidighet', basis));
      card.appendChild(field('Varighet til (midlertidig)', endD));
      card.appendChild(field('Stillingsprosent', pct));
      card.appendChild(field('Arbeidstidsordning', wta));
      card.appendChild(field('Avtalt arbeidstid (timer per uke)', hrs));
      card.appendChild(field('Pauseordning', brk));
      card.appendChild(field('Endring av vaktplan', sch));
      card.appendChild(field('Prøvetid', prb));
      card.appendChild(field('Oppsigelsestid', notice));
      card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      card.appendChild(btn('Lagre og fortsett', 'btn primary', () => saveTerms(e, termsPatchFrom({
        employmentType: () => type.value, employmentBasis: () => basis.value.trim(), employmentEndDate: () => endD.value,
        percentage: () => (pct.value === '' ? '' : Number(pct.value)), workingTimeArrangement: () => wta.value.trim(),
        expectedWeeklyHours: () => (hrs.value === '' ? '' : Number(hrs.value)), breaksArrangement: () => brk.value.trim(),
        scheduleChangeHandling: () => sch.value.trim(), probation: () => prb.value.trim(), noticePeriod: () => notice.value.trim(),
      }), 3)));
    } else if (step === 3) {
      card.appendChild(el('div', { cls: 'kicker', text: '3. Lønn & vilkår' }));
      const model = selectInput([{ value: '', label: 'Velg …' }, { value: 'timelonn', label: 'Timelønn' }, { value: 'fastlonn', label: 'Fastlønn' }], cur && cur.compensation ? cur.compensation.model : '');
      const amount = textInput(cur && cur.compensation ? String(cur.compensation.model === 'timelonn' ? cur.compensation.hourlyRate : cur.compensation.monthlySalary) : '', 'beløp', 'number');
      const interval = selectInput([{ value: '', label: 'Velg …' }].concat(PAYMENT_INTERVALS.map((x) => ({ value: x, label: x === 'manedlig' ? 'Månedlig' : 'Hver 14. dag' }))), cur && cur.paymentInterval ? cur.paymentInterval : '');
      card.appendChild(field('Lønnsgrunnlag', model));
      card.appendChild(field('Beløp (kr per time / per måned)', amount));
      card.appendChild(field('Utbetalingsintervall', interval));
      card.appendChild(el('div', { cls: 'vp-note', text: 'Ferie/feriepenger, tariff og taushetsplikt kommer fra malens standardtekster. Overtid og tillegg beregnes ikke i denne versjonen.' }));
      card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      card.appendChild(btn('Lagre og fortsett', 'btn primary', () => {
        const patch = termsPatchFrom({ paymentInterval: () => interval.value });
        if (model.value && amount.value !== '' && !(cur && cur.compensation)) {
          patch.compensation = model.value === 'timelonn' ? { model: 'timelonn', hourlyRate: Number(amount.value) } : { model: 'fastlonn', monthlySalary: Number(amount.value) };
        }
        saveTerms(e, patch, 4);
      }));
    } else {
      card.appendChild(el('div', { cls: 'kicker', text: '4. Gjennomgang' }));
      card.appendChild(el('div', { style: 'font-weight:800;font-size:15px', text: rd.label }));
      card.appendChild(el('div', { cls: 'vp-note', text: rd.note }));
      if (rd.missing.length) card.appendChild(miss(rd.missing.map((m) => m.label)));
      card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      const acts = el('div', { cls: 'vp-actions' });
      acts.appendChild(btn('Forhåndsvis avtalen', 'btn secondary', () => { previewVersionId = null; page = 'preview'; errMsg = ''; draw(); }));
      if (draftVersionOf(e) && rd.ready) {
        acts.appendChild(btn('Godkjenn og frys versjon', 'btn primary', () => applyC({ kind: 'freezeVersion', ansattId: e.ansattId }, () => { page = 'card'; section = 'kontrakt'; })));
      }
      // Explicit draft-save exposure: the draft already lives in the employee store (resumable,
      // proven) — this action just closes the flow without freezing, keeping the draft.
      if (draftVersionOf(e)) {
        acts.appendChild(btn('Lagre utkast og lukk', 'btn tertiary', () => { page = 'card'; section = 'kontrakt'; errMsg = ''; draw(); }));
      }
      card.appendChild(acts);
      card.appendChild(el('div', { cls: 'vp-note', text: 'Elektronisk signering med BankID kommer.' }));
    }
    root.appendChild(card);
    if (step >= 3) inheritedFactsCard();
  }

  function drawPreview() {
    const e = employeeOf(employeeStore, tenantId, selectedId);
    if (!e) { page = 'list'; return drawList(); }
    const version = previewVersionId ? contractVersionsOf(e).find((v) => v.contractVersionId === previewVersionId) : null;
    const blocks = blocksForVersion(version, { employee: e, profile: contractProfile, onDate: todayWd, roleLabels });
    root.appendChild(head('Arbeidsavtale', e.name + ' · ' + (version
      ? 'Frosset versjon ' + version.contractVersionId + ' – historisk og uforanderlig'
      : 'Utkast – redigerbart, ikke frosset')));
    const back = btn('← Tilbake', 'btn tertiary', () => { page = version ? 'card' : 'contract'; if (version) section = 'kontrakt'; errMsg = ''; draw(); });
    back.style.cssText = 'width:auto;padding:4px 0;min-height:0;margin-bottom:10px';
    root.appendChild(back);
    // Skriv ut / Lagre som PDF — ONE renderer, ONE contract truth: both actions print exactly
    // the rendered pages below via the browser (PDF = the print dialog's "Lagre som PDF").
    // Printing mutates nothing — no freeze, no status change, no second document pipeline.
    const pa = el('div', { cls: 'vp-actions' });
    pa.appendChild(btn('Skriv ut', 'btn secondary', () => window.print()));
    pa.appendChild(btn('Lagre som PDF', 'btn secondary', () => window.print()));
    root.appendChild(pa);
    root.appendChild(el('div', { cls: 'vp-note', text: 'PDF lages ærlig via utskriftsdialogen: velg «Lagre som PDF» som skriver. Utskriften inneholder kun selve avtalen.' }));
    // Four Season Ansettelsesavtale v2 — two A4 pages after the sealed visual freeze. Pure paint
    // of the core's data blocks; the exact Four Season logo is a static asset, never redrawn.
    const header = blocks.find((b) => b.kind === 'docHeader');
    const footer = blocks.find((b) => b.kind === 'docFooter');
    const notes = blocks.filter((b) => b.kind === 'note');
    const pages = [[]];
    for (const b of blocks) {
      if (b.kind === 'docHeader' || b.kind === 'docFooter' || b.kind === 'note') continue;
      if (b.kind === 'pageBreak') { pages.push([]); continue; }
      pages[pages.length - 1].push(b);
    }
    function fsRows(rows) {
      const wrap = el('div', { cls: 'fs-rows' });
      for (const r of rows) {
        const row = el('div', { cls: 'fs-row' });
        row.appendChild(el('div', { cls: 'k', text: r[0] }));
        row.appendChild(el('div', { cls: 'v', text: r[1] }));
        wrap.appendChild(row);
      }
      return wrap;
    }
    function fsHead(pg, first) {
      const h = el('div', { cls: 'fs-head' });
      h.appendChild(el('img', { cls: 'fs-logo', attrs: { src: './four-season-logo.gif', alt: 'Four Season AS' } }));
      h.appendChild(el('div', { cls: 'fs-orgline', text: header ? header.orgLine : '' }));
      pg.appendChild(h);
      if (first) {
        pg.appendChild(el('h2', { cls: 'fs-title', text: header ? header.title : 'ANSETTELSESAVTALE' }));
        const sub = el('div', { cls: 'fs-subrow' });
        sub.appendChild(el('span', { cls: 'fs-sub', text: header ? header.subtitle : '' }));
        sub.appendChild(el('span', { cls: 'fs-badge', text: header ? header.badge : '' }));
        pg.appendChild(sub);
      } else {
        pg.appendChild(el('div', { cls: 'fs-cont', text: header ? header.contLine : '' }));
      }
    }
    pages.forEach((pageBlocks, i) => {
      const pg = el('div', { cls: 'fs-a4' });
      fsHead(pg, i === 0);
      for (const b of pageBlocks) {
        if (b.kind === 'numbered') {
          const sh = el('div', { cls: 'fs-sec' });
          sh.appendChild(el('span', { cls: 'n', text: b.n }));
          sh.appendChild(el('span', { text: b.title }));
          pg.appendChild(sh);
          // Sealed v2 order: tables first, clause text after — except sections whose intro
          // paragraph precedes the table (textFirst) and pure-clause sections.
          const clauseP = b.text ? el('p', { cls: 'fs-cl', text: b.text }) : null;
          if (clauseP && (b.textFirst || !b.rows)) pg.appendChild(clauseP);
          if (b.bullets) {
            const ul = el('ul', { cls: 'fs-ul' });
            for (const li of b.bullets) ul.appendChild(el('li', { text: li }));
            pg.appendChild(ul);
          }
          if (b.rows) pg.appendChild(fsRows(b.rows));
          if (clauseP && !b.textFirst && b.rows) pg.appendChild(clauseP);
        } else if (b.kind === 'parties') {
          const pr = el('div', { cls: 'fs-parties' });
          const mk = (cap, rows, extra) => {
            const box = el('div', { cls: 'fs-party' + (extra ? ' ' + extra : '') });
            box.appendChild(el('div', { cls: 'cap', text: cap }));
            for (const r of rows) {
              const line = el('div', { cls: 'ln' });
              line.appendChild(el('span', { cls: 'k', text: r[0] + ': ' }));
              line.appendChild(el('span', { cls: 'v', text: r[1] }));
              box.appendChild(line);
            }
            return box;
          };
          pr.appendChild(mk('ARBEIDSGIVER', b.employer, 'gray'));
          pr.appendChild(mk('ARBEIDSTAKER', b.employee));
          pg.appendChild(pr);
        } else if (b.kind === 'signatures') {
          pg.appendChild(fsRows([['Sted', b.place], ['Dato', b.date]]));
          const sg = el('div', { cls: 'fs-signs' });
          for (const side of [b.left, b.right]) {
            const c = el('div', { cls: 'fs-sign' });
            c.appendChild(el('div', { cls: 'cap', text: side.caption }));
            c.appendChild(el('div', { cls: 'nm', text: side.name }));
            c.appendChild(el('div', { cls: 'sig', text: 'Signatur' }));
            sg.appendChild(c);
          }
          pg.appendChild(sg);
        }
      }
      const ft = el('div', { cls: 'fs-foot' });
      ft.appendChild(el('span', { text: footer ? footer.brand : '' }));
      ft.appendChild(el('span', { text: 'Side ' + (i + 1) + ' av ' + pages.length }));
      pg.appendChild(ft);
      root.appendChild(pg);
    });
    const fine = el('div', { cls: 'card emp-doc-view' });
    for (const n of notes) fine.appendChild(el('div', { cls: 'note' + (n.text.indexOf('UTKAST') === 0 ? ' draft' : ''), text: n.text }));
    root.appendChild(fine);
  }

  function drawKontrakt(e) {
    // Contract projection — derived from the SAME contractVersion truth, never a stored flag.
    const cs = contractStateOf(e);
    const rd = readinessFor(e);
    const cc = el('div', { cls: 'card' });
    cc.appendChild(el('div', { cls: 'kicker', text: 'Arbeidsavtale' }));
    cc.appendChild(factRow('Status', cs.label));
    if (cs.latest) {
      cc.appendChild(factRow('Siste versjon', cs.latest.contractVersionId + ' · ' + cs.latest.kind));
      if (cs.latest.frozenAt) cc.appendChild(factRow('Frosset', new Date(cs.latest.frozenAt).toLocaleDateString('nb-NO')));
      cc.appendChild(factRow('Mal', cs.latest.templateVersion));
    }
    if (cs.state !== 'frosset') cc.appendChild(factRow('Malfelter', rd.label));
    const acts = el('div', { cls: 'vp-actions' });
    if (canEditEmployment(actor) && e.status === 'active') {
      if (cs.state === 'mangler') acts.appendChild(btn('Fullfør arbeidsavtale', 'btn primary', () => applyC({ kind: 'startDraft', ansattId: e.ansattId }, () => { step = 1; page = 'contract'; })));
      else if (cs.draft) acts.appendChild(btn('Fortsett utkast', 'btn primary', () => { step = 1; page = 'contract'; errMsg = ''; draw(); }));
      else if (cs.state === 'frosset') acts.appendChild(btn('Ny endringsavtale', 'btn secondary', () => applyC({ kind: 'startDraft', ansattId: e.ansattId }, () => { step = 1; page = 'contract'; })));
    }
    if (cs.latest) acts.appendChild(btn('Forhåndsvis', 'btn secondary', () => { previewVersionId = cs.latest.status === CONTRACT_STATUS.FROZEN ? cs.latest.contractVersionId : null; page = 'preview'; errMsg = ''; draw(); }));
    cc.appendChild(acts);
    cc.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
    const versions = contractVersionsOf(e);
    if (versions.length) {
      cc.appendChild(el('div', { cls: 'kicker neutral', style: 'margin-top:10px', text: 'Versjonshistorikk' }));
      for (const v of versions.slice().reverse()) {
        const row = el('div', { cls: 'emp-period' });
        row.appendChild(el('div', { cls: 'rg', text: v.contractVersionId + ' · ' + (v.status === CONTRACT_STATUS.FROZEN ? 'Godkjent og frosset – historisk og uforanderlig' : 'Utkast – redigerbart') }));
        row.appendChild(el('div', { cls: 'bits', text: [v.kind, 'mal ' + v.templateVersion, v.frozenAt ? new Date(v.frozenAt).toLocaleDateString('nb-NO') : null, v.supersedes ? 'erstatter ' + v.supersedes : null].filter(Boolean).join(' · ') }));
        // Every historical version stays viewable (and printable from the preview) — a frozen
        // version renders from its own snapshot, a draft from live canonical facts.
        const vb = btn('Vis', 'btn tertiary', () => { previewVersionId = v.status === CONTRACT_STATUS.FROZEN ? v.contractVersionId : null; page = 'preview'; errMsg = ''; draw(); });
        vb.style.cssText = 'width:auto;padding:2px 12px;min-height:0;margin-top:4px';
        row.appendChild(vb);
        cc.appendChild(row);
      }
    }
    cc.appendChild(el('div', { cls: 'vp-note', text: 'Elektronisk signering med BankID kommer. Ingen versjon her er elektronisk signert, og malen er ikke juridisk kvalitetssikret.' }));
    root.appendChild(cc);

    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker neutral', text: 'Andre dokumenter' }));
    card.appendChild(factRow('Kontraktdokument registrert', contractStatusOf(e) === 'finnes' ? 'Ja' : 'Nei'));
    if (!e.documents.length) card.appendChild(el('div', { style: 'color:var(--faint);font-size:14px', text: 'Ingen dokumenter registrert.' }));
    for (const d of e.documents) {
      const row = el('div', { cls: 'emp-doc' });
      const l = el('div');
      l.appendChild(el('div', { cls: 'nm', text: d.name }));
      l.appendChild(el('div', { cls: 'meta', text: [d.category, d.date ? fmtDate(d.date) : null, d.source].filter(Boolean).join(' · ') }));
      row.appendChild(l);
      if (canEditEmployment(actor)) row.appendChild(btn('Fjern', 'btn tertiary', () => apply({ kind: 'removeDocument', ansattId: e.ansattId, docId: d.docId })));
      card.appendChild(row);
    }
    card.appendChild(el('div', { cls: 'vp-note', text: 'Kun opplysninger om dokumentene registreres her. Selve filene lagres ikke i denne versjonen – ingen opplasting, nedlasting eller visning.' }));
    root.appendChild(card);

    if (canEditEmployment(actor)) {
      const form = el('div', { cls: 'card emp-form' });
      form.appendChild(el('div', { cls: 'kicker neutral', text: 'Registrer dokumentopplysning' }));
      const nm = textInput('', 'f.eks. Arbeidskontrakt');
      const cat = selectInput(DOC_CATEGORIES.map((c) => ({ value: c, label: c })), 'kontrakt');
      const dt = textInput(todayWd, null, 'date');
      const src = textInput('registrert manuelt', 'kilde');
      form.appendChild(field('Navn', nm));
      form.appendChild(field('Kategori', cat));
      form.appendChild(field('Dato', dt));
      form.appendChild(field('Kilde', src));
      form.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      form.appendChild(btn('Registrer', 'btn primary', () => apply({ kind: 'addDocument', ansattId: e.ansattId, doc: { name: nm.value, category: cat.value, date: dt.value, source: src.value } })));
      root.appendChild(form);
    }
  }

  function drawLonn(e, cur) {
    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker', text: 'Lønn & økonomi' }));
    if (!canViewCompensation(actor)) {
      card.appendChild(el('div', { style: 'color:var(--muted);font-size:14px', text: 'Du har ikke tilgang til lønnsopplysninger.' }));
      root.appendChild(card); return;
    }
    const c = cur && cur.compensation;
    card.appendChild(el('div', { cls: 'kicker neutral', text: 'Lønnsgrunnlag (arbeidsforhold)' }));
    if (c) {
      card.appendChild(factRow('Modell', c.model === 'timelonn' ? 'Timelønn' : 'Fastlønn'));
      card.appendChild(factRow(c.model === 'timelonn' ? 'Timesats' : 'Månedslønn', c.model === 'timelonn' ? fmtKr(c.hourlyRate) + ' per time' : fmtKr(c.monthlySalary) + ' per måned'));
      card.appendChild(factRow('Gjelder fra', fmtDate(cur.validFrom)));
    } else {
      card.appendChild(miss(['mangler lønnsgrunnlag']));
      card.appendChild(el('div', { style: 'color:var(--muted);font-size:13px', text: 'Registrer lønnsgrunnlag under Arbeidsforhold. Vaktplanen viser kostnad som ukjent til det er registrert – aldri null.' }));
    }
    card.appendChild(el('div', { cls: 'vp-note', text: 'Dette er lønnsgrunnlaget i arbeidsforholdet – ikke lønnshistorikk, ikke utbetalt lønn og ikke ferdig lønnsoppgjør. Feriepenger, overtid og tillegg beregnes ikke i denne versjonen. Vaktplanen henter samme grunnlag herfra.' }));
    root.appendChild(card);

    // ---- MONTHLY PACKAGE PROJECTION — the SAME package truth as the Lønnsgrunnlag surface,
    // filtered to this employee. Employee 360 recomputes nothing: every number below is read
    // out of the frozen package snapshot.
    if (payrollStore) {
      const pc = el('div', { cls: 'card' });
      pc.appendChild(el('div', { cls: 'kicker neutral', text: 'Lønnsgrunnlag (månedspakke)' }));
      const periodId = todayWd.slice(0, 7);
      const proj = payrollProjectionForEmployee(payrollStore, tenantId, e.ansattId, periodId)
        || payrollProjectionForEmployee(payrollStore, tenantId, e.ansattId, null);
      if (!proj) {
        pc.appendChild(el('div', { style: 'color:var(--faint);font-size:14px', text: 'Ingen godkjent månedspakke ennå.' }));
      } else {
        pc.appendChild(factRow('Periode', proj.periodLabel + ' · v' + proj.version));
        pc.appendChild(factRow('Status', proj.status));
        pc.appendChild(factRow('Godkjente timer', fmtH(proj.approvedHours)));
        pc.appendChild(factRow('Faktisk (oppgitt) tid', fmtH(proj.actualHours)));
        if (proj.sentAt) pc.appendChild(factRow('Markert sendt', new Date(proj.sentAt).toLocaleDateString('nb-NO') + ' · ' + proj.sentChannel));
      }
      pc.appendChild(el('div', { cls: 'vp-note', text: 'Hentet fra den felles månedspakken – ingen egen beregning her.' }));
      root.appendChild(pc);
    }
  }

  function drawTid(e) {
    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker', text: 'Tid & vaktplan' }));
    const wk = plannedHoursForEmployee(scheduleStore, tenantId, e.ansattId, { kind: 'week', anchorWorkDate: todayWd });
    const mo = plannedHoursForEmployee(scheduleStore, tenantId, e.ansattId, monthScope());
    card.appendChild(factRow('Planlagte timer denne uken', fmtH(wk)));
    card.appendChild(factRow('Planlagte timer denne måneden', fmtH(mo)));
    const up = upcomingShiftsForEmployee(scheduleStore, tenantId, e.ansattId, actor, nowMs, 3);
    card.appendChild(el('div', { cls: 'kicker neutral', style: 'margin-top:10px', text: 'Kommende vakter' }));
    if (!up.length) card.appendChild(el('div', { style: 'color:var(--faint);font-size:14px', text: 'Ingen planlagte vakter framover.' }));
    for (const s of up) {
      const p = s.projection;
      const row = el('div', { cls: 'shift' });
      row.appendChild(el('div', { cls: 't', text: capFirst(dayLabel(p.workDate)) + ' · ' + fmtHM(p.plannedStartAt) + '–' + fmtHM(p.plannedEndAt) + (isOvernight(p, timezone) ? ' (til neste dag)' : '') }));
      card.appendChild(row);
    }
    if (typeof onOpenVaktplanFor === 'function') {
      card.appendChild(btn('Åpne i Vaktplan', 'btn secondary', () => onOpenVaktplanFor(e.name)));
    }
    card.appendChild(el('div', { cls: 'vp-note', text: 'Vakter endres i Vaktplan. Her vises samme planlagte tid som i vaktplanen og de ansattes egen plan.' }));
    root.appendChild(card);
  }

  function draw() {
    clear(root);
    if (!canViewEmployees(actor)) {
      root.appendChild(el('div', { cls: 'card', text: 'Du har ikke tilgang til ansattopplysninger.' }));
      if (typeof onBack === 'function') root.appendChild(btn('← Tilbake', 'btn tertiary', onBack));
      return;
    }
    if (page === 'list') drawList();
    else if (page === 'new') drawNew();
    else if (page === 'contract') drawContractFlow();
    else if (page === 'preview') drawPreview();
    else drawCard();
  }

  draw();
}
