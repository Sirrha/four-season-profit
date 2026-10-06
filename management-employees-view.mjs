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
  normalizeAddress, correctableTermsPeriodOf, needsInitialRegistration, lacksEmploymentBaseline,
  canViewEmployees, canViewCompensation, canEditEmployment, EMPLOYMENT_TYPES, EMPLOYMENT_FORMS, DOC_CATEGORIES,
  PAYMENT_INTERVALS,
} from './management-employees-core.mjs';
import {
  CONTRACT_STATUS, contractInputsFor, contractReadinessOf, blocksForVersion,
  contractVersionsOf, draftVersionOf, contractStateOf, applyContractOperation,
  applyCompanyContractOperation, privateFieldsOf, formatContractPrivateField,
} from './management-contract-core.mjs';
import { payrollProjectionForEmployee } from './management-payroll-core.mjs';
import { validatePrivatePatch, validatePrivateField, formatPrivateField } from './management-private-fields.mjs';   // release 019: pure validation / presentation of the two private fields

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

export function renderEmployeesView(root, { employeeStore, scheduleStore, tenantId, tenantLabel, roleLabels, actor, contractProfile, payrollStore, nowMs, timezone, onOpenVaktplanFor, onBack, applyOperation, applyContract, onCompanyProfileChanged, privateFields }) {
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
  let arbeidChangeOpen = false;  // Arbeidsforhold: the genuine "Ny periode (endring)" form is collapsed while the ONE initial period still qualifies for completion (UI state only)
  let arbeidCorrectOpen = false; // Arbeidsforhold: the "Korriger gjeldende arbeidsforhold" form (feilregistrering, same period) is open (UI state only)
  let freezeConfirm = null;      // Step 4: { contractVersionId, inputs } captured when "Godkjenn og frys versjon" is pressed — the exact content under review (UI state only)
  let freezeBusy = false;        // a freeze request is in flight: the confirm control is disabled (no double submit)
  // PRIVATE CONTRACT FIELDS (release 019B-R2) — the values themselves live on the contract DRAFT (core op setPrivateFields).
  // `privSeen` is UI state only: the identity (version id + exact field values) of the draft the preview last showed.
  // While the draft holds a private value, "Godkjenn og frys versjon" is offered only when the draft still equals what was
  // previewed; any later edit of the two fields changes the identity and requires a new preview.
  let privSeen = null;
  let corrDraft = null;          // transient typed correction values kept across a refused save's redraw; the ONE truth stays the terms
  let regDraft = null;           // first registration: { id, v } typed values kept across a refused save's redraw (UI state only, never persisted)
  let companyDraft = null;      // transient unsaved editor values; the ONE truth stays contractProfile
  // PRIVATE FIELDS (release 019) — UI state only, never persisted. `priv.shown[k]` holds a full value ONLY while the
  // manager has pressed «Vis» for that field; `priv.draft` holds typed values ONLY while the edit form is open. Any
  // navigation (other employee, other section, list, contract, preview) resets everything to masked (privSync in draw);
  // leaving the Ansatte tab or Workforce discards this closure altogether.
  const privBlank = () => ({ key: null, shown: { personnummer: null, bankkonto: null }, edit: false, draft: null, busy: false, err: '', ok: '' });
  let priv = privBlank();
  const privKeyNow = () => page + '|' + (selectedId || '') + '|' + section;
  function privSync() { const k = privKeyNow(); if (priv.key !== k) { priv = privBlank(); priv.key = k; } }

  const fmtHM = (t) => fmtTenantHM(t, timezone);
  const roleOf = (k) => (roleLabels && k && roleLabels[k] ? roleLabels[k] : k || '–');
  const fmtKr = (v) => 'kr ' + Math.round(v).toLocaleString('nb-NO');
  const fmtH = (h) => h.toLocaleString('nb-NO', { maximumFractionDigits: 2 }) + ' t';
  const monthScope = () => ({ kind: 'month', year: Number(todayWd.slice(0, 4)), month: Number(todayWd.slice(5, 7)) });

  // Before first registration the old register's title / wage are UNCONFIRMED orientation, never shown as current truth:
  // header, list and summaries use this neutral label instead of the derived role.
  const UNREGISTERED_LABEL = 'Arbeidsforhold ikke registrert';
  const roleLineOf = (e, t) => (lacksEmploymentBaseline(e) ? UNREGISTERED_LABEL : roleOf(t ? t.role : null));
  const FIRST_REG_LABELS = { role: 'Stilling', employmentForm: 'Ansettelsesform', employmentType: 'Stillingstype', percentage: 'Stillingsprosent', compensation: 'Lønnsgrunnlag', expectedWeeklyHours: 'Avtalt arbeidstid', workplace: 'Arbeidssted', noticePeriod: 'Oppsigelsestid' };
  function opError(code) {
    if (code === 'INITIAL_REGISTRATION_REQUIRED') return 'Arbeidsforholdet må registreres først. Gå til «Arbeidsforhold» og velg «Registrer arbeidsforhold».';
    if (code === 'INITIAL_REGISTRATION_NOT_AVAILABLE') return 'Arbeidsforholdet er allerede registrert. Bruk fullføring, korrigering eller ny periode.';
    if (code === 'INITIAL_REGISTRATION_INACTIVE') return 'Den ansatte er ikke aktiv. Arbeidsforhold kan bare opprettes for aktive ansatte.';
    if (code === 'STARTDATE_FUTURE') return 'Faktisk startdato kan ikke være fram i tid.';
    if (typeof code === 'string' && code.startsWith('INITIAL_TERMS_REQUIRED:')) return (FIRST_REG_LABELS[code.slice(23)] || 'Opplysningen') + ' må fylles ut for å opprette arbeidsforholdet.';
    if (code === 'PAYMENTINTERVAL_INVALID') return 'Ugyldig utbetalingsintervall.';
    if (typeof code === 'string' && code.startsWith('TERMS_VALUE_INVALID')) return 'En av opplysningene har ugyldig verdi.';
    if (code === 'NAME_REQUIRED') return 'Navn må fylles ut.';
    if (code === 'STARTDATE_INVALID') return 'Oppgi en gyldig startdato.';
    if (code === 'ROLE_REQUIRED') return 'Velg en stilling/rolle.';
    if (code === 'VALIDFROM_INVALID') return 'Oppgi en gyldig «gjelder fra»-dato.';
    if (code === 'TERMS_DUPLICATE_VALIDFROM') return 'Det finnes allerede en periode som gjelder fra denne datoen.';
    if (typeof code === 'string' && code.startsWith('TERMS_VALUE_ALREADY_SET')) return 'Denne opplysningen er allerede registrert i perioden. Er den feilregistrert, rett den med «Korriger gjeldende arbeidsforhold» under Arbeidsforhold. En reell endring lagres som en ny periode.';
    if (code === 'CORRECTION_REASON_REQUIRED') return 'Skriv en kort begrunnelse for korrigeringen.';
    if (code === 'CORRECTION_REASON_TOO_LONG') return 'Begrunnelsen kan være på høyst 200 tegn.';
    if (code === 'TERMS_CORRECTION_NO_CHANGE') return 'Ingen verdier er endret. Endre verdien som var feilregistrert.';
    if (code === 'TERMS_CORRECTION_PERIOD_SUPERSEDED' || code === 'TERMS_CORRECTION_PERIOD_UNKNOWN') return 'Bare perioden som gjelder nå kan korrigeres. Tidligere perioder endres aldri.';
    if (code === 'TERMS_CORRECTION_EMPLOYEE_ENDED') return 'Arbeidsforholdet er avsluttet og kan ikke korrigeres.';
    if (typeof code === 'string' && code.startsWith('TERMS_CORRECTION_STALE')) return 'Opplysningene er endret i mellomtiden. Åpne korrigeringen på nytt.';
    if (typeof code === 'string' && code.startsWith('TERMS_CORRECTION_VALUE_REQUIRED')) return 'En korrigering må ha en verdi. Feltet kan ikke tømmes.';
    if (code === 'EXPECTEDWEEKLYHOURS_INVALID') return 'Avtalt arbeidstid må være et tall over 0 og høyst 168 timer per uke.';
    if (code === 'TERMS_PERIOD_FROZEN_IN_CONTRACT') return 'Perioden er låst av en frosset avtale. Legg til en ny periode i stedet.';
    if (code === 'NO_TERMS') return 'Ingenting nytt å fylle ut.';
    if (code === 'COMPENSATION_INVALID') return 'Lønnsgrunnlaget må være et positivt beløp.';
    if (code === 'PERCENTAGE_INVALID') return 'Stillingsprosent må være mellom 1 og 100.';
    if (code === 'EMPLOYMENTTYPE_INVALID') return 'Ugyldig stillingstype.';
    if (code === 'EMPLOYMENTFORM_INVALID') return 'Ugyldig ansettelsesform.';
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
    if (code === 'ALREADY_FROZEN') return 'Denne versjonen er allerede godkjent og frosset.';
    if (code === 'CONTRACT_INPUTS_CHANGED') return 'Avtalen er endret siden du åpnet godkjenningen. Se gjennom avtalen på nytt før du fryser.';
    if (code === 'FREEZE_REVIEW_REQUIRED') return 'Åpne godkjenningen på nytt og bekreft versjonen som skal fryses.';
    if (code === 'NO_DRAFT') return 'Det finnes ikke noe utkast å fryse.';
    if (code === 'VERSION_UNKNOWN' || code === 'VERSION_NOT_DRAFT') return 'Denne avtaleversjonen er ikke et utkast og kan ikke endres.';
    if (code === 'PERSONNUMMER_INVALID') return 'Fødselsnummer må være nøyaktig 11 siffer.';
    if (code === 'BANKKONTO_INVALID') return 'Kontonummer må være nøyaktig 11 siffer.';
    if (code === 'PRIVATE_FIELDS_CHANGED') return 'Fødselsnummer eller kontonummer i avtalen er endret siden gjennomgangen. Åpne forhåndsvisningen og se gjennom avtalen på nytt før du fryser.';
    if (code === 'PRIVATE_FIELDS_INVALID') return 'Feltene kunne ikke lagres. Prøv igjen.';
    if (code === 'PRIVATE_FIELDS_NO_CHANGE') return 'Ingen ny verdi er skrevet inn. Fyll ut feltet som skal registreres eller erstattes.';
    return 'Kunne ikke lagre (' + code + ').';
  }
  // Production operation seams (Ledelse integration): a host may supply `applyOperation` / `applyContract`, which
  // receive the SAME argument objects this view has always handed to the cores and may resolve asynchronously
  // (one transaction on the canonical ansatte document). Without them the accepted in-memory behaviour is unchanged.
  const coreErr = (e) => (e && e.coreResult) ? e.coreResult : { ok: false, code: e && e.code ? e.code : 'UNKNOWN' };
  function apply(op, after) {
    const settle = (res) => { if (res && res.ok) { errMsg = ''; if (typeof after === 'function') after(res); } else { errMsg = opError(res && res.code ? res.code : 'UNKNOWN'); } draw(); };
    const run = typeof applyOperation === 'function' ? applyOperation : applyEmployeeOperation;
    let res; try { res = run({ store: employeeStore, tenantId, actor, op, now: Date.now(), timezone }); } catch (e) { settle(coreErr(e)); return; }
    if (res && typeof res.then === 'function') res.then(settle, (e) => settle(coreErr(e))); else settle(res);
  }
  function applyC(op, after) {
    const settle = (res) => {
      freezeBusy = false;
      if (res && (res.code === 'CONTRACT_INPUTS_CHANGED' || res.code === 'ALREADY_FROZEN' || res.code === 'NOT_READY')) freezeConfirm = null;
      if (res && res.code === 'PRIVATE_FIELDS_CHANGED') { freezeConfirm = null; privSeen = null; }   // a new preview is required
      if (res && res.ok) { errMsg = ''; if (typeof after === 'function') after(res); }
      else if (res && res.code === 'NOT_READY') errMsg = 'Kan ikke fryses ennå: ' + (res.missing || []).map((m) => m.label).join(', ') + ' mangler.';
      else if (res && res.code === 'TERMS_PERIOD_FROZEN_IN_CONTRACT') errMsg = 'Perioden er låst av en frosset avtale. Legg til en ny periode i stedet.';
      else errMsg = opError(res && res.code ? res.code : 'UNKNOWN');
      draw();
    };
    const run = typeof applyContract === 'function' ? applyContract : applyContractOperation;
    let res; try { res = run({ store: employeeStore, tenantId, actor, op, profile: contractProfile, now: Date.now(), onDate: todayWd, roleLabels }); } catch (e) { settle(coreErr(e)); return; }
    if (res && typeof res.then === 'function') res.then(settle, (e) => settle(coreErr(e))); else settle(res);
  }
  const CPRIV = [
    { key: 'fodselsnummer', label: 'Fødselsnummer', vkey: 'personnummer', short: 'fødselsnummer' },
    { key: 'bankkonto', label: 'Kontonummer', vkey: 'bankkonto', short: 'kontonummer' },
  ];
  const privNames = (pf) => CPRIV.filter((f) => pf[f.key]).map((f) => f.short).join(' og ');
  const privIdOf = (e) => { const d = draftVersionOf(e); return d ? d.contractVersionId + '|' + JSON.stringify(privateFieldsOf(d)) : ''; };
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
  // ANSETTELSESFORM (terms.employmentForm: fast | midlertidig) is a DISTINCT canonical fact from the employment-scope
  // field shown as "Stillingstype" (terms.employmentType: deltid …). Neither is ever derived from the other (release -005).
  const FORM_LABELS = { fast: 'Fast', midlertidig: 'Midlertidig' };
  const formLabel = (v) => (v ? (FORM_LABELS[v] || capFirst(String(v))) : 'Ikke registrert');
  const CORR_LABELS = { role: 'Stilling', employmentForm: 'Ansettelsesform', employmentType: 'Stillingstype', percentage: 'Stillingsprosent', compensation: 'Lønnsgrunnlag', expectedWeeklyHours: 'Avtalt arbeidstid', noticePeriod: 'Oppsigelsestid' };
  const corrValue = (f, v) => {
    if (v == null) return 'Ikke registrert';
    if (f === 'expectedWeeklyHours') return fmtH(v);
    if (f === 'percentage') return v + ' %';
    if (f === 'role') return roleOf(v);
    if (f === 'employmentForm') return formLabel(v);
    if (f === 'compensation') return !canViewCompensation(actor) ? 'Skjult' : (v.model === 'timelonn' ? fmtKr(v.hourlyRate) + ' per time' : fmtKr(v.monthlySalary) + ' per måned');
    return String(v);
  };
  const corrChangeText = (ch) => (CORR_LABELS[ch.field] || ch.field) + ' ' + corrValue(ch.field, ch.before) + ' → ' + corrValue(ch.field, ch.after);
  const formOptions = (blank) => [{ value: '', label: blank }].concat(EMPLOYMENT_FORMS.map((x) => ({ value: x, label: FORM_LABELS[x] || x })));
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
      const bits = [roleLineOf(e, t)];
      if (t && t.employmentType) bits.push(t.employmentType);
      if (t && t.percentage != null) bits.push(t.percentage + ' %');
      row.appendChild(el('div', { cls: 'sub', text: bits.join(' · ') }));
      const m = missingInfoOf(e, todayWd).slice();
      if (needsInitialRegistration(e)) m.unshift('registrer arbeidsforhold');
      const cs = contractStateOf(e);
      if (cs.state === 'mangler') m.push('mangler arbeidsavtale');
      else if (cs.state === 'utkast') m.push('arbeidsavtale er utkast');
      if (m.length) row.appendChild(miss(m));
      row.addEventListener('click', () => { selectedId = e.ansattId; section = 'oversikt'; page = 'card'; errMsg = ''; arbeidChangeOpen = false; arbeidCorrectOpen = false; corrDraft = null; draw(); });
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
        if (typeof onCompanyProfileChanged === 'function') { try { onCompanyProfileChanged(contractProfile); } catch (err) { /* host persistence concern */ } }
      }
      errMsg = ''; companySetupOpen = false; companyDraft = null; draw();
    }));
    acts.appendChild(btn('Lukk', 'btn tertiary', () => { companySetupOpen = false; companyDraft = null; errMsg = ''; draw(); }));
    card.appendChild(acts);
    card.appendChild(el('div', { cls: 'vp-note', text: typeof onCompanyProfileChanged === 'function' ? 'Lagres som felles avtaleoppsett for virksomheten og gjelder alle ansatte.' : 'Lagres kun lokalt i denne forhåndsvisningen – ingen produksjonslagring i denne versjonen.' }));
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
        if (wantContract) { step = 1; page = 'contract'; if (!draftVersionOf(res.employee)) applyC({ kind: 'startDraft', ansattId: res.ansattId }); }
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
    root.appendChild(head(e.name, roleLineOf(e, cur) + ' · ' + (e.status === 'active' ? 'Aktiv' : 'Sluttet ' + fmtDate(e.endedAt))));
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
    const unreg = lacksEmploymentBaseline(e);   // old-register values are not shown as current facts
    card.appendChild(factRow('Stilling', unreg ? 'Ikke registrert' : roleOf(cur ? cur.role : null)));
    card.appendChild(factRow('Stillingstype', cur && cur.employmentType ? cur.employmentType : 'Ikke registrert'));
    card.appendChild(factRow('Stillingsprosent', cur && cur.percentage != null ? cur.percentage + ' %' : 'Ikke registrert'));
    card.appendChild(factRow('Startdato', unreg ? 'Ikke registrert' : fmtDate(startDateOf(e))));   // an old-register date is never shown as the employment start
    let comp = 'Ikke registrert';
    if (canViewCompensation(actor) && cur && cur.compensation && !unreg) {
      comp = cur.compensation.model === 'timelonn' ? fmtKr(cur.compensation.hourlyRate) + ' per time' : fmtKr(cur.compensation.monthlySalary) + ' per måned';
    } else if (!canViewCompensation(actor)) comp = 'Skjult';
    card.appendChild(factRow('Lønnsgrunnlag', comp));
    const csO = contractStateOf(e);
    card.appendChild(factRow('Kontrakt', csO.state === 'frosset' ? csO.label : csO.state === 'utkast' ? 'Utkast pågår' : (contractStatusOf(e) === 'finnes' ? 'Registrert' : 'Mangler')));
    const wkHours = plannedHoursForEmployee(scheduleStore, tenantId, e.ansattId, { kind: 'week', anchorWorkDate: todayWd });
    card.appendChild(factRow('Planlagte timer denne uken', fmtH(wkHours)));
    const up = upcomingShiftsForEmployee(scheduleStore, tenantId, e.ansattId, actor, nowMs, 1);
    card.appendChild(factRow('Neste vakt', up.length
      ? capFirst(dayLabel(up[0].projection.workDate)) + ' · ' + fmtHM(up[0].projection.plannedStartAt) + '–' + fmtHM(up[0].projection.plannedEndAt)
      : 'Ingen planlagte vakter'));
    const m = missingInfoOf(e, todayWd);
    if (m.length) { card.appendChild(el('div', { cls: 'cue-line', text: 'Mangler informasjon:' })); card.appendChild(miss(m)); }
    // Contact details are stored with the employment, so they cannot be saved before it is registered: say so here instead
    // of offering an editor that could only be refused (the only contact editor is step 1 of the contract flow, withheld too).
    if (unreg && canEditEmployment(actor)) card.appendChild(el('div', { cls: 'cue-line emp-contact-gate', text: 'Registrer arbeidsforholdet først. Kontaktopplysninger kan oppdateres etterpå.' }));
    card.appendChild(el('div', { cls: 'vp-note', text: 'Fravær, ferie og tilgang kommer senere.' }));
    root.appendChild(card);
  }

  // INITIAL COMPLETION ELIGIBILITY (accepted semantics reused, no new law): eligible iff (1) exactly ONE period exists (the
  // starting period is the first AND current one; no later period), (2) that period is not referenced by a frozen contract
  // (the same lock completeCurrentTerms enforces), and (3) at least one completable term is still blank — the same fields the
  // accepted completeness law (missingInfoOf: stillingstype/arbeidsprosent/lønnsgrunnlag) and the contract template read
  // (avtalt arbeidstid, oppsigelsestid). Once complete, or once a second period exists, only the genuine-change form is offered.
  const COMPLETABLE_TERMS = ['employmentType', 'percentage', 'compensation', 'expectedWeeklyHours', 'noticePeriod'];
  function initialCompletionTarget(e) {
    if (!e || !Array.isArray(e.terms) || e.terms.length !== 1) return null;
    const t = e.terms[0];
    if ((e.contractVersions || []).some((v) => v.status === 'godkjent_frosset' && v.termsPeriodRef === t.validFrom)) return null;
    const missing = COMPLETABLE_TERMS.filter((f) => t[f] == null);
    return missing.length ? { terms: t, missing } : null;
  }
  function initialCompletionEligible(e) { return initialCompletionTarget(e) !== null; }
  // ---- REGISTRER ARBEIDSFORHOLD — first registration of an employee from the old register -----------------------------
  // Shown INSTEAD of the ordinary Arbeidsforhold editors while an active employee has no stored employment baseline. The
  // admin states the real start date and the real facts explicitly; every field starts EMPTY (nothing is prefilled from
  // the old register — its values are shown once, as labelled orientation only). Nothing is written by opening the screen;
  // "Opprett arbeidsforhold" sends ONE operation (registerInitialEmployment). Afterwards the ordinary editors take over.
  function drawFirstRegistration(e) {
    const hint = e.terms[0] || {};
    const card = el('div', { cls: 'card emp-firstreg-state' });
    card.appendChild(el('div', { cls: 'kicker', text: 'Gjeldende arbeidsforhold' }));
    card.appendChild(el('div', { style: 'font-weight:800;font-size:15px', text: 'Arbeidsforholdet er ikke registrert ennå' }));
    card.appendChild(el('div', { cls: 'cue-line', text: e.name + ' kommer fra det gamle ansattregisteret, og arbeidsforholdet har ennå ikke fått noen historikk her.' + (e.status === 'active' ? '' : ' Den ansatte er ikke aktiv, så arbeidsforhold kan ikke opprettes her.') }));
    const bits = [];
    if (hint.role) bits.push('stilling «' + hint.role + '»');
    if (canViewCompensation(actor) && hint.compensation && hint.compensation.model === 'timelonn') bits.push('timelønn ' + fmtKr(hint.compensation.hourlyRate));
    const opp = e.legacy && typeof e.legacy.opprettet === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.legacy.opprettet) ? e.legacy.opprettet.slice(0, 10) : null;
    if (opp) bits.push('lagt inn i gammelt system ' + fmtDate(opp));
    if (bits.length) card.appendChild(el('div', { cls: 'vp-note emp-legacy-hint', text: 'Ubekreftede opplysninger fra gammelt register – kun til orientering: ' + bits.join(' · ') + '. De er ikke arbeidsforholdets historikk.' }));
    root.appendChild(card);
    if (!canEditEmployment(actor) || !needsInitialRegistration(e)) return;   // an inactive old-register employee sees the status only
    const d = regDraft && regDraft.id === e.ansattId ? regDraft.v : {};
    const form = el('div', { cls: 'card emp-form emp-firstreg' });
    form.appendChild(el('div', { cls: 'kicker', text: 'Registrer arbeidsforhold' }));
    form.appendChild(el('div', { cls: 'cue-line', text: 'Oppgi den faktiske datoen arbeidsforholdet startet og vilkårene som gjelder. Datoen den ansatte ble lagt inn i det gamle systemet brukes ikke som startdato.' }));
    const pick = (list, blank) => [{ value: '', label: blank }].concat(list);
    const start = textInput(d.start || '', null, 'date'); start.setAttribute('max', todayWd);
    const role = selectInput(pick(roleOptions(), 'Velg …'), d.role || '');
    const formSel = selectInput(formOptions('Velg …'), d.form || '');
    const type = selectInput(pick(EMPLOYMENT_TYPES.map((x) => ({ value: x, label: x })), 'Velg …'), d.type || '');
    const pct = textInput(d.pct || '', 'f.eks. 60', 'number');
    const compModel = selectInput([{ value: '', label: 'Velg …' }, { value: 'timelonn', label: 'Timelønn' }, { value: 'fastlonn', label: 'Fastlønn' }], d.compModel || '');
    const compVal = textInput(d.compVal || '', 'beløp', 'number');
    const hours = textInput(d.hours || '', 'f.eks. 37.5', 'number');
    const wp = textInput(d.wp || '', 'f.eks. 4Seasons ferske varer');
    const notice = textInput(d.notice || '', 'f.eks. 1 måned');
    const wta = textInput(d.wta || '', 'valgfritt – f.eks. dagtid og kveld etter vaktplan');
    const prb = textInput(d.prb || '', 'valgfritt – f.eks. 6 måneder / ingen');
    const interval = selectInput([{ value: '', label: 'Ikke registrert' }].concat(PAYMENT_INTERVALS.map((x) => ({ value: x, label: x === 'manedlig' ? 'Månedlig' : 'Hver 14. dag' }))), d.interval || '');
    form.appendChild(field('Faktisk startdato', start));
    form.appendChild(field('Stilling', role));
    form.appendChild(field('Ansettelsesform', formSel));
    form.appendChild(field('Stillingstype', type));
    form.appendChild(field('Stillingsprosent', pct));
    form.appendChild(field('Lønnsgrunnlag', compModel));
    form.appendChild(field('Beløp (kr per time / per måned)', compVal));
    form.appendChild(field('Avtalt arbeidstid (timer per uke)', hours));
    form.appendChild(field('Arbeidssted', wp));
    form.appendChild(field('Oppsigelsestid', notice));
    form.appendChild(field('Arbeidstidsordning (valgfritt)', wta));
    form.appendChild(field('Prøvetid (valgfritt)', prb));
    form.appendChild(field('Utbetalingsintervall (valgfritt)', interval));
    form.appendChild(el('div', { cls: 'vp-note', text: 'Det opprettes én periode som gjelder fra startdatoen. Senere endringer registreres som nye perioder.' }));
    form.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
    form.appendChild(btn('Opprett arbeidsforhold', 'btn primary', () => {
      regDraft = { id: e.ansattId, v: { start: start.value, role: role.value, form: formSel.value, type: type.value, pct: pct.value, compModel: compModel.value, compVal: compVal.value, hours: hours.value, wp: wp.value, notice: notice.value, wta: wta.value, prb: prb.value, interval: interval.value } };
      const terms = {
        role: role.value || null, employmentForm: formSel.value || null, employmentType: type.value || null,
        percentage: pct.value === '' ? null : Number(pct.value), expectedWeeklyHours: hours.value === '' ? null : Number(hours.value),
        workplace: wp.value.trim() || null, noticePeriod: notice.value.trim() || null,
        compensation: compModel.value === 'timelonn' ? { model: 'timelonn', hourlyRate: Number(compVal.value) } : compModel.value === 'fastlonn' ? { model: 'fastlonn', monthlySalary: Number(compVal.value) } : null,
      };
      if (wta.value.trim()) terms.workingTimeArrangement = wta.value.trim();
      if (prb.value.trim()) terms.probation = prb.value.trim();
      if (interval.value) terms.paymentInterval = interval.value;
      apply({ kind: 'registerInitialEmployment', ansattId: e.ansattId, startDate: start.value, terms }, () => { regDraft = null; });
    }));
    root.appendChild(form);
    root.appendChild(el('div', { cls: 'vp-note', text: 'Fullføring, korrigering, ny periode, arbeidsavtale og avslutning blir tilgjengelig når arbeidsforholdet er opprettet.' }));
  }
  function drawArbeid(e, cur) {
    if (lacksEmploymentBaseline(e)) return drawFirstRegistration(e);   // no derived period, completion, correction, new period or end before a real baseline exists
    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker', text: 'Gjeldende arbeidsforhold' }));
    if (cur) {
      card.appendChild(factRow('Gjelder fra', fmtDate(cur.validFrom)));
      card.appendChild(factRow('Stilling', roleOf(cur.role)));
      card.appendChild(factRow('Ansettelsesform', formLabel(cur.employmentForm)));
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

    // ---- INITIAL PERIOD COMPLETION vs GENUINE CHANGE (owner decision 2026-09-27) --------------------------------
    // A newly created employee has ONE open starting period with blanks. Filling those blanks later COMPLETES that same
    // period (core op completeCurrentTerms: latest period, blanks only, validFrom untouched, frozen-contract periods
    // refused, already-set values refused). Only a genuine later change creates period #2 (appendTerms, 'Ny periode').
    const completion = canEditEmployment(actor) && e.status === 'active' && initialCompletionEligible(e) ? initialCompletionTarget(e) : null;
    const correctable = canEditEmployment(actor) ? correctableTermsPeriodOf(e) : null;
    if (completion && !arbeidCorrectOpen) {
      const t = completion.terms;
      const form = el('div', { cls: 'card emp-form' });
      form.appendChild(el('div', { cls: 'kicker', text: 'Fullfør eksisterende arbeidsforhold' }));
      form.appendChild(el('div', { cls: 'cue-line', text: 'Fyller ut det som mangler i perioden som gjelder fra ' + fmtDate(t.validFrom) + '. Startdatoen beholdes, og det opprettes ingen ny periode. Opplysninger som allerede er registrert, rettes med «Korriger gjeldende arbeidsforhold» hvis de er feilregistrert; en reell endring lagres som en ny periode.' }));
      const lock = (input) => { input.setAttribute('disabled', 'disabled'); input.setAttribute('aria-disabled', 'true'); return input; };
      const vf = lock(textInput(fmtDate(t.validFrom), null, 'text'));
      const role = lock(selectInput(roleOptions(), t.role));
      const type = selectInput([{ value: '', label: 'Ikke registrert' }].concat(EMPLOYMENT_TYPES.map((x) => ({ value: x, label: x }))), t.employmentType || '');
      if (t.employmentType) lock(type);
      const pct = textInput(t.percentage != null ? String(t.percentage) : '', 'f.eks. 60', 'number');
      if (t.percentage != null) lock(pct);
      const compModel = selectInput([{ value: '', label: 'Ikke registrert' }, { value: 'timelonn', label: 'Timelønn' }, { value: 'fastlonn', label: 'Fastlønn' }], t.compensation ? t.compensation.model : '');
      const compVal = textInput(t.compensation ? String(t.compensation.model === 'timelonn' ? t.compensation.hourlyRate : t.compensation.monthlySalary) : '', 'beløp', 'number');
      if (t.compensation) { lock(compModel); lock(compVal); }
      const hours = textInput(t.expectedWeeklyHours != null ? String(t.expectedWeeklyHours) : '', 'f.eks. 37.5', 'number');
      if (t.expectedWeeklyHours != null) lock(hours);
      const notice = textInput(t.noticePeriod ? t.noticePeriod : '', 'f.eks. 1 måned');
      if (t.noticePeriod) lock(notice);
      form.appendChild(field('Gjelder fra (startdato, beholdes)', vf));
      form.appendChild(field('Stilling', role));
      form.appendChild(field('Stillingstype', type));
      form.appendChild(field('Stillingsprosent', pct));
      form.appendChild(field('Lønnsgrunnlag', compModel));
      form.appendChild(field('Beløp (kr per time / per måned)', compVal));
      form.appendChild(field('Avtalt arbeidstid (timer per uke)', hours));
      form.appendChild(field('Oppsigelsestid', notice));
      form.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      form.appendChild(btn('Fullfør arbeidsforhold', 'btn primary', () => {
        // ONLY blanks travel: the core refuses to overwrite a set value, so set fields are locked above and never sent.
        const patch = {};
        if (t.employmentType == null && type.value) patch.employmentType = type.value;
        if (t.percentage == null && pct.value !== '') patch.percentage = Number(pct.value);
        if (t.compensation == null && compModel.value === 'timelonn') patch.compensation = { model: 'timelonn', hourlyRate: Number(compVal.value) };
        else if (t.compensation == null && compModel.value === 'fastlonn') patch.compensation = { model: 'fastlonn', monthlySalary: Number(compVal.value) };
        if (t.expectedWeeklyHours == null && hours.value !== '') patch.expectedWeeklyHours = Number(hours.value);
        if (t.noticePeriod == null && notice.value.trim()) patch.noticePeriod = notice.value.trim();
        if (!Object.keys(patch).length) { errMsg = opError('NO_TERMS'); draw(); return; }
        apply({ kind: 'completeCurrentTerms', ansattId: e.ansattId, terms: patch });
      }));
      root.appendChild(form);
      // the genuine-change path stays reachable, but is secondary until the starting period is established
      if (!arbeidChangeOpen) {
        const openChange = btn('Registrer en senere endring (ny periode)', 'btn tertiary', () => { arbeidChangeOpen = true; errMsg = ''; draw(); });
        root.appendChild(openChange);
      }
    }
    // ---- CORRECTION OF A FEILREGISTRERING (release -006) — NOT a change ------------------------------------------------
    // Rectifies already-registered values of the CURRENT period in place (core op correctCurrentTerms: latest period only,
    // validFrom/identity untouched, no successor, not referenced by a non-draft contract, reason required, audited in
    // e360.termsCorrections). A real later change stays "Ny periode (endring)". Only populated terms are offered; blanks
    // belong to completion. The contract draft stores no term values, so it reads the corrected value on its next render.
    if (correctable && !arbeidCorrectOpen) {
      const entry = el('div', { cls: 'card' });
      entry.appendChild(el('div', { cls: 'cue-line', text: 'Er en registrert verdi i perioden som gjelder nå feil? Rett feilregistreringen uten å lage en ny periode.' }));
      entry.appendChild(btn('Korriger gjeldende arbeidsforhold', 'btn secondary', () => { arbeidCorrectOpen = true; corrDraft = null; errMsg = ''; draw(); }));
      root.appendChild(entry);
    }
    if (correctable && arbeidCorrectOpen) {
      const t = correctable;
      const dv = (k, fallback) => (corrDraft && k in corrDraft ? corrDraft[k] : fallback);
      const form = el('div', { cls: 'card emp-form' });
      form.appendChild(el('div', { cls: 'kicker', text: 'Korriger gjeldende arbeidsforhold' }));
      form.appendChild(el('div', { cls: 'cue-line', text: 'Bare for feilregistrering: retter verdier som ble registrert feil i perioden som gjelder fra ' + fmtDate(t.validFrom) + '. Perioden og startdatoen beholdes, og det opprettes ingen ny periode. Korrigeringen lagres med begrunnelse, tidspunkt og hvem som rettet.' }));
      form.appendChild(el('div', { cls: 'cue-line', text: 'Er det en reell endring i arbeidsforholdet fra en bestemt dato, skal den registreres som en ny periode i stedet.' }));
      const vf = textInput(fmtDate(t.validFrom), null, 'text');
      vf.setAttribute('disabled', 'disabled'); vf.setAttribute('aria-disabled', 'true');
      const role = selectInput(roleOptions(), dv('role', t.role));
      const formSel = t.employmentForm ? selectInput(formOptions('').slice(1), dv('employmentForm', t.employmentForm)) : null;
      const type = t.employmentType ? selectInput(EMPLOYMENT_TYPES.map((x) => ({ value: x, label: x })), dv('employmentType', t.employmentType)) : null;
      const pct = t.percentage != null ? textInput(dv('percentage', String(t.percentage)), null, 'number') : null;
      const compModel = t.compensation ? selectInput([{ value: 'timelonn', label: 'Timelønn' }, { value: 'fastlonn', label: 'Fastlønn' }], dv('compModel', t.compensation.model)) : null;
      const compVal = t.compensation ? textInput(dv('compVal', String(t.compensation.model === 'timelonn' ? t.compensation.hourlyRate : t.compensation.monthlySalary)), null, 'number') : null;
      const hours = t.expectedWeeklyHours != null ? textInput(dv('expectedWeeklyHours', String(t.expectedWeeklyHours)), null, 'number') : null;
      const notice = t.noticePeriod ? textInput(dv('noticePeriod', t.noticePeriod), null) : null;
      const reason = textInput(dv('reason', ''), 'f.eks. Feilregistrert arbeidstid');
      reason.setAttribute('maxlength', '200');
      form.appendChild(field('Gjelder fra (beholdes)', vf));
      form.appendChild(field('Stilling', role));
      if (formSel) form.appendChild(field('Ansettelsesform', formSel));
      if (type) form.appendChild(field('Stillingstype', type));
      if (pct) form.appendChild(field('Stillingsprosent', pct));
      if (compModel) { form.appendChild(field('Lønnsgrunnlag', compModel)); form.appendChild(field('Beløp (kr per time / per måned)', compVal)); }
      if (hours) form.appendChild(field('Avtalt arbeidstid (timer per uke)', hours));
      if (notice) form.appendChild(field('Oppsigelsestid', notice));
      form.appendChild(field('Begrunnelse (påkrevd)', reason));
      form.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      const acts = el('div', { cls: 'vp-actions' });
      acts.appendChild(btn('Lagre korrigering', 'btn primary', () => {
        // ONLY the values that differ travel, each with the value the owner saw (compare-and-set in the core).
        corrDraft = { role: role.value, reason: reason.value };
        const next = {};
        if (role.value !== t.role) next.role = role.value;
        if (formSel) { corrDraft.employmentForm = formSel.value; if (formSel.value !== t.employmentForm) next.employmentForm = formSel.value; }
        if (type) { corrDraft.employmentType = type.value; if (type.value !== t.employmentType) next.employmentType = type.value; }
        if (pct) { corrDraft.percentage = pct.value; const v = pct.value === '' ? null : Number(pct.value); if (v !== t.percentage) next.percentage = v; }
        if (compModel) {
          corrDraft.compModel = compModel.value; corrDraft.compVal = compVal.value;
          const amt = compVal.value === '' ? NaN : Number(compVal.value);
          const c = compModel.value === 'timelonn' ? { model: 'timelonn', hourlyRate: amt } : { model: 'fastlonn', monthlySalary: amt };
          const was = t.compensation.model === 'timelonn' ? t.compensation.hourlyRate : t.compensation.monthlySalary;
          if (c.model !== t.compensation.model || amt !== was) next.compensation = c;
        }
        if (hours) { corrDraft.expectedWeeklyHours = hours.value; const v = hours.value === '' ? null : Number(hours.value); if (v !== t.expectedWeeklyHours) next.expectedWeeklyHours = v; }
        if (notice) { corrDraft.noticePeriod = notice.value; const v = notice.value.trim() || null; if (v !== t.noticePeriod) next.noticePeriod = v; }
        if (!Object.keys(next).length) { errMsg = opError('TERMS_CORRECTION_NO_CHANGE'); draw(); return; }
        const expected = {};
        for (const k of Object.keys(next)) expected[k] = t[k];
        apply({ kind: 'correctCurrentTerms', ansattId: e.ansattId, periodValidFrom: t.validFrom, reason: reason.value, terms: next, expected }, () => { arbeidCorrectOpen = false; corrDraft = null; });
      }));
      acts.appendChild(btn('Avbryt korrigering', 'btn tertiary', () => { arbeidCorrectOpen = false; corrDraft = null; errMsg = ''; draw(); }));
      form.appendChild(acts);
      form.appendChild(btn('Dette er en reell endring – registrer ny periode', 'btn tertiary', () => { arbeidCorrectOpen = false; corrDraft = null; arbeidChangeOpen = true; errMsg = ''; draw(); }));
      root.appendChild(form);
    }
    if (canEditEmployment(actor) && e.status === 'active' && (!completion || arbeidChangeOpen) && !arbeidCorrectOpen) {
      const form = el('div', { cls: 'card emp-form' });
      form.appendChild(el('div', { cls: 'kicker', text: 'Ny periode (endring)' }));
      form.appendChild(el('div', { cls: 'cue-line', text: 'En endring lagres som en ny periode. Tidligere perioder endres aldri.' }));
      const vf = textInput(todayWd, null, 'date');
      const role = selectInput(roleOptions(), cur ? cur.role : null);
      const type = selectInput([{ value: '', label: 'Ikke registrert' }].concat(EMPLOYMENT_TYPES.map((x) => ({ value: x, label: x }))), cur && cur.employmentType ? cur.employmentType : '');
      const formSel = selectInput(formOptions('Ikke registrert'), cur && cur.employmentForm ? cur.employmentForm : '');
      const pct = textInput(cur && cur.percentage != null ? String(cur.percentage) : '', 'f.eks. 60', 'number');
      const compModel = selectInput([{ value: '', label: 'Ikke registrert' }, { value: 'timelonn', label: 'Timelønn' }, { value: 'fastlonn', label: 'Fastlønn' }], cur && cur.compensation ? cur.compensation.model : '');
      const compVal = textInput(cur && cur.compensation ? String(cur.compensation.model === 'timelonn' ? cur.compensation.hourlyRate : cur.compensation.monthlySalary) : '', 'beløp', 'number');
      const hours = textInput(cur && cur.expectedWeeklyHours != null ? String(cur.expectedWeeklyHours) : '', 'f.eks. 37.5', 'number');
      const notice = textInput(cur && cur.noticePeriod ? cur.noticePeriod : '', 'f.eks. 1 måned');
      form.appendChild(field('Gjelder fra', vf));
      form.appendChild(field('Stilling', role));
      form.appendChild(field('Ansettelsesform', formSel));
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
        terms.employmentForm = formSel.value || null;
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
      if (r.terms.employmentForm) bits.push(formLabel(r.terms.employmentForm));
      if (r.terms.employmentType) bits.push(r.terms.employmentType);
      if (r.terms.percentage != null) bits.push(r.terms.percentage + ' %');
      if (canViewCompensation(actor) && r.terms.compensation) {
        bits.push(r.terms.compensation.model === 'timelonn' ? fmtKr(r.terms.compensation.hourlyRate) + '/t' : fmtKr(r.terms.compensation.monthlySalary) + '/mnd');
      }
      b.appendChild(el('div', { cls: 'bits', text: bits.join(' · ') }));
      // correction audit (release -006): every feilregistrering fix of this period stays visible — never a silent rewrite
      for (const c of (e.termsCorrections || []).filter((x) => x.periodValidFrom === r.validFrom)) {
        b.appendChild(el('div', { cls: 'bits emp-corr', text: 'Korrigert ' + fmtDate(tenantWorkDate(c.at, timezone)) + ': ' + c.changes.map(corrChangeText).join('; ') + ' · «' + c.reason + '»' }));
      }
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
      b.addEventListener('click', () => { step = n; errMsg = ''; freezeConfirm = null; draw(); });
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
    if (lacksEmploymentBaseline(e)) { page = 'card'; section = 'arbeid'; return drawCard(); }   // the contract flow (incl. its contact step) is never drawn before first registration
    const rd = readinessFor(e);
    root.appendChild(head('Arbeidsavtale', e.name + ' · ' + rd.label));
    const back = btn('← Til ansattkortet', 'btn tertiary', () => { page = 'card'; section = 'kontrakt'; errMsg = ''; freezeConfirm = null; draw(); });
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
      // FØDSELSNUMMER + KONTONUMMER (release 019B-R2): the two formerly locked placeholders are now real, OPTIONAL fields of
      // THIS contract draft. They show the draft's own values (prefilled once from Person- og lønnsopplysninger when the
      // version was created), may be edited or cleared, and are saved with "Lagre og fortsett" through the contract
      // boundary (setPrivateFields) — never onto the employee's master data. Non-empty = part of the agreement; empty =
      // omitted. The value is set as the input's live value only (no attribute, dataset or title carries it).
      const draft1 = draftVersionOf(e);
      const pf1 = privateFieldsOf(draft1);
      const privIn = {};
      if (draft1) {
        for (const f of CPRIV) {
          const i = textInput(null, '11 siffer (valgfritt)');
          for (const [a, v] of [['autocomplete', 'off'], ['autocorrect', 'off'], ['autocapitalize', 'off'], ['spellcheck', 'false'], ['inputmode', 'numeric'], ['maxlength', '20'], ['data-lpignore', 'true'], ['data-1p-ignore', 'true']]) i.setAttribute(a, v);
          i.value = formatContractPrivateField(f.key, pf1[f.key]);
          privIn[f.key] = i;
          card.appendChild(field(f.label, i));
        }
      }
      card.appendChild(el('div', { cls: 'vp-note', text: 'Arbeidssted lagres i arbeidsforholdet, ikke som en egen kopi på ansattkortet. Fødselsnummer og kontonummer er valgfrie: de hentes fra Person- og lønnsopplysninger når tilgjengelig, og endringer her gjelder bare denne avtalen. Et tomt felt tas ikke med i avtalen.' }));
      const err1 = el('div', { cls: 'vp-err', text: errMsg });
      card.appendChild(err1);
      card.appendChild(btn('Lagre og fortsett', 'btn primary', () => {
        // private fields first: blank = clear, otherwise exactly 11 digits; a refusal names the field only and keeps the form as typed
        err1.textContent = '';
        const privPatch = {};
        for (const f of CPRIV) {
          const i = privIn[f.key];
          if (!i) continue;
          if (i.value.trim() === '') { if (pf1[f.key]) privPatch[f.key] = ''; continue; }
          const r = validatePrivateField(f.vkey, i.value);
          if (!r.ok) { err1.textContent = opError(r.code); return; }
          if (r.value !== pf1[f.key]) privPatch[f.key] = r.value;
        }
        const anyAddress = street.value.trim() !== '' || postal.value.trim() !== '' || city.value.trim() !== '';
        const patch = { email: email.value.trim() || null, phone: phone.value.trim() || null, birthDate: bd.value || null };
        if (anyAddress) patch.address = { street: street.value, postalCode: postal.value, city: city.value };
        const wpPatch = termsPatchFrom({ workplace: () => (cur && cur.workplace ? '' : wp.value.trim()) });
        const next = () => saveTerms(e, wpPatch, 2);
        apply({ kind: 'updateContact', ansattId: e.ansattId, contact: patch }, () => {
          if (Object.keys(privPatch).length) applyC({ kind: 'setPrivateFields', ansattId: e.ansattId, contractVersionId: draft1.contractVersionId, fields: privPatch }, next);
          else next();
        });
      }));
    } else if (step === 2) {
      card.appendChild(el('div', { cls: 'kicker', text: '2. Arbeidsforhold' }));
      // Ansettelsesform binds to the canonical FORM fact (terms.employmentForm) — never initialised from, nor written to,
      // the employment-scope field (terms.employmentType: deltid …), which keeps living under Arbeidsforhold.
      const type = selectInput(formOptions('Velg …'), cur && cur.employmentForm ? cur.employmentForm : '');
      const basis = textInput(cur && cur.employmentBasis ? cur.employmentBasis : '', 'kun ved midlertidig ansettelse');
      const endD = textInput(cur && cur.employmentEndDate ? cur.employmentEndDate : '', null, 'date');
      // Temporary-only facts are active ONLY while Ansettelsesform = midlertidig; for fast they are disabled, never required
      // and never sent (so they can never fail validation or be entered as though they applied).
      const syncTemp = () => { const on = type.value === 'midlertidig'; for (const i of [basis, endD]) { if (on) { i.removeAttribute('disabled'); i.removeAttribute('aria-disabled'); } else { i.setAttribute('disabled', 'disabled'); i.setAttribute('aria-disabled', 'true'); } } };
      type.addEventListener('change', syncTemp); syncTemp();
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
        employmentForm: () => type.value, employmentBasis: () => (type.value === 'midlertidig' ? basis.value.trim() : ''), employmentEndDate: () => (type.value === 'midlertidig' ? endD.value : ''),
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
      // Private contract fields (release 019B-R2): no controls and no values here — only a note, and the rule that a draft
      // holding such a value is approved from what the preview showed (same version, same values).
      const pf4 = privateFieldsOf(draftVersionOf(e));
      const hasPriv = Object.keys(pf4).length > 0;
      const previewed = !hasPriv || privSeen === privIdOf(e);
      if (hasPriv) card.appendChild(el('div', { cls: 'cue-line emp-priv-note', text: previewed
        ? 'Avtalen inneholder registrerte personopplysninger (' + privNames(pf4) + '), slik de ble vist i forhåndsvisningen.'
        : 'Avtalen inneholder registrerte personopplysninger (' + privNames(pf4) + '). Kontroller forhåndsvisningen før godkjenning – åpne «Forhåndsvis avtalen».' }));
      card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
      const acts = el('div', { cls: 'vp-actions' });
      acts.appendChild(btn('Forhåndsvis avtalen', 'btn secondary', () => { previewVersionId = null; page = 'preview'; errMsg = ''; draw(); }));
      // GODKJENN OG FRYS (release -007): pressing the action captures the EXACT agreement inputs now on screen and opens an
      // in-page confirmation; only "Ja, godkjenn og frys" sends freezeVersion with that version id + reviewed inputs. The core
      // re-derives completeness and the inputs from the authoritative records inside the transaction and refuses any drift.
      const draftV = draftVersionOf(e);
      const confirming = !!(freezeConfirm && draftV && freezeConfirm.contractVersionId === draftV.contractVersionId);
      if (draftV && rd.ready && !confirming && previewed) {
        acts.appendChild(btn('Godkjenn og frys versjon', 'btn primary', () => { freezeConfirm = { contractVersionId: draftV.contractVersionId, inputs: JSON.parse(JSON.stringify(inputsFor(e))) }; errMsg = ''; draw(); }));
      }
      // Explicit draft-save exposure: the draft already lives in the employee store (resumable,
      // proven) — this action just closes the flow without freezing, keeping the draft.
      if (draftVersionOf(e)) {
        acts.appendChild(btn('Lagre utkast og lukk', 'btn tertiary', () => { page = 'card'; section = 'kontrakt'; errMsg = ''; draw(); }));
      }
      card.appendChild(acts);
      if (confirming && rd.ready) {
        const cf = el('div', { cls: 'emp-freeze-confirm' });
        cf.appendChild(el('div', { cls: 'kicker', text: 'Bekreft godkjenning av ' + draftV.contractVersionId }));
        cf.appendChild(el('div', { cls: 'cue-line', text: 'Denne nøyaktige versjonen låses slik avtalen er vist nå, og kan ikke redigeres etterpå.' }));
        cf.appendChild(el('div', { cls: 'cue-line', text: 'Senere endringer krever en ny avtaleversjon. Den frosne versjonen endres aldri.' }));
        cf.appendChild(el('div', { cls: 'cue-line', text: 'Dette signerer IKKE avtalen. Elektronisk signering med BankID kommer senere.' }));
        const ca = el('div', { cls: 'vp-actions' });
        const yes = btn('Ja, godkjenn og frys', 'btn primary', () => {
          if (freezeBusy || !freezeConfirm) return;
          freezeBusy = true; yes.setAttribute('disabled', 'disabled'); yes.setAttribute('aria-disabled', 'true');
          const fc = freezeConfirm;
          applyC({ kind: 'freezeVersion', ansattId: e.ansattId, contractVersionId: fc.contractVersionId, expectedInputs: fc.inputs }, () => { freezeConfirm = null; previewVersionId = null; page = 'card'; section = 'kontrakt'; });
        });
        if (freezeBusy) { yes.setAttribute('disabled', 'disabled'); yes.setAttribute('aria-disabled', 'true'); }
        ca.appendChild(yes);
        ca.appendChild(btn('Avbryt', 'btn tertiary', () => { freezeConfirm = null; errMsg = ''; draw(); }));
        cf.appendChild(ca);
        card.appendChild(cf);
      }
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
      ? 'Godkjent og frosset versjon ' + version.contractVersionId + ' – ikke signert, historisk og uforanderlig'
      : 'Utkast – redigerbart, ikke frosset')));
    const back = btn('← Tilbake', 'btn tertiary', () => { page = version ? 'card' : 'contract'; if (version) section = 'kontrakt'; errMsg = ''; draw(); });
    back.style.cssText = 'width:auto;padding:4px 0;min-height:0;margin-bottom:10px';
    root.appendChild(back);
    // A DRAFT preview with private contract fields records exactly what it showed (release 019B-R2); screen-only notice.
    if (!version) {
      const pfP = privateFieldsOf(draftVersionOf(e));
      if (Object.keys(pfP).length) {
        privSeen = privIdOf(e);
        root.appendChild(el('div', { cls: 'vp-note emp-priv-note', text: 'Denne avtalen inneholder ' + privNames(pfP) + '. Kontroller opplysningene under – de låses i avtalen når den fryses.' }));
      }
    }
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
      if (cs.latest.frozenAt) cc.appendChild(factRow('Frosset', fmtDate(tenantWorkDate(cs.latest.frozenAt, timezone)) + ' kl. ' + fmtHM(cs.latest.frozenAt)));
      cc.appendChild(factRow('Mal', cs.latest.templateVersion));
    }
    if (cs.state !== 'frosset') cc.appendChild(factRow('Malfelter', rd.label));
    const acts = el('div', { cls: 'vp-actions' });
    if (canEditEmployment(actor) && e.status === 'active') {
      if (needsInitialRegistration(e)) cc.appendChild(el('div', { cls: 'cue-line emp-firstreg-gate', text: 'Registrer arbeidsforholdet under «Arbeidsforhold» før arbeidsavtalen opprettes.' }));   // a contract draft would store the old-register period
      else if (cs.state === 'mangler') acts.appendChild(btn('Fullfør arbeidsavtale', 'btn primary', () => applyC({ kind: 'startDraft', ansattId: e.ansattId }, () => { step = 1; page = 'contract'; })));
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
        row.appendChild(el('div', { cls: 'rg', text: v.contractVersionId + ' · ' + (v.status === CONTRACT_STATUS.FROZEN ? 'Godkjent og frosset – ikke signert · historisk og uforanderlig' : 'Utkast – redigerbart') }));
        const vPriv = privateFieldsOf(v);   // which private fields the version holds — names only, never a value
        row.appendChild(el('div', { cls: 'bits', text: [v.kind, 'mal ' + v.templateVersion, v.frozenAt ? new Date(v.frozenAt).toLocaleDateString('nb-NO') : null, v.supersedes ? 'erstatter ' + v.supersedes : null, Object.keys(vPriv).length ? 'inneholder ' + privNames(vPriv) : null].filter(Boolean).join(' · ') }));
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

    if (canEditEmployment(actor) && !lacksEmploymentBaseline(e)) {
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
    const c = lacksEmploymentBaseline(e) ? null : (cur && cur.compensation);   // an old-register wage is orientation (shown under Arbeidsforhold), not the lønnsgrunnlag
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
    drawPrivate(e);
  }

  // ---- PERSON- OG LØNNSOPPLYSNINGER (release 019): fødselsnummer + bankkonto, management only -----------------------
  // Masked by default from the adapter's masked projection (no value reaches this view). «Vis» performs ONE dedicated
  // read and shows that field until «Skjul» or any navigation. The edit form starts EMPTY (an existing value is never
  // pre-filled into the page); a blank field is left unchanged; saving remasks and reports a generic message only.
  // No value is ever placed in an attribute, id, dataset, title, aria label, hidden element, toast, error or log.
  function drawPrivate(e) {
    if (!privateFields || !canEditEmployment(actor) || !canViewCompensation(actor)) return;
    const stale = (k) => priv.key !== k || selectedId !== e.ansattId;
    const card = el('div', { cls: 'card emp-private' });
    card.appendChild(el('div', { cls: 'kicker', text: 'Person- og lønnsopplysninger' }));
    let m = null; try { m = privateFields.masked(e.ansattId); } catch (x) { m = null; }
    const LABEL = { personnummer: 'Fødselsnummer', bankkonto: 'Bankkonto' };
    for (const k of ['personnummer', 'bankkonto']) {
      const info = m && m[k] ? m[k] : { present: false, masked: null, regular: false };
      const row = el('div', { cls: 'emp-fact' });
      row.appendChild(el('div', { cls: 'k', text: LABEL[k] }));
      const v = el('div', { cls: 'v' });
      const shown = priv.shown[k];
      v.appendChild(el('span', { cls: 'pv', text: !info.present ? 'Ikke registrert' : (shown != null ? shown : info.masked) }));
      if (info.present && !priv.edit) {
        const t = btn(shown != null ? 'Skjul' : 'Vis', 'btn tertiary', () => {
          if (priv.busy) return;
          if (priv.shown[k] != null) { priv.shown[k] = null; priv.err = ''; draw(); return; }
          const key = priv.key; priv.busy = true; priv.err = ''; priv.ok = '';
          privateFields.read(e.ansattId).then((r) => {
            if (stale(key)) return;
            priv.busy = false;
            priv.shown[k] = r && r[k] != null ? formatPrivateField(k, r[k]) : null;
            draw();
          }, () => { if (stale(key)) return; priv.busy = false; priv.err = 'Kunne ikke hente opplysningen. Prøv igjen.'; draw(); });
        });
        t.setAttribute('aria-label', (shown != null ? 'Skjul ' : 'Vis ') + LABEL[k].toLowerCase());
        t.style.cssText = 'display:inline;width:auto;min-height:0;padding:0 0 0 12px;margin:0';
        v.appendChild(t);
      }
      row.appendChild(v);
      card.appendChild(row);
      if (info.present && !info.regular) card.appendChild(el('div', { cls: 'vp-note', text: LABEL[k] + ' er registrert i et uvanlig format. Erstatt verdien med 11 siffer.' }));
    }
    if (!priv.edit) {
      card.appendChild(el('div', { cls: 'vp-err', text: priv.err }));
      if (priv.ok) card.appendChild(el('div', { cls: 'cue-line emp-private-ok', text: priv.ok }));
      const acts = el('div', { cls: 'vp-actions' });
      acts.appendChild(btn('Rediger person- og lønnsopplysninger', 'btn secondary', () => { priv.shown = { personnummer: null, bankkonto: null }; priv.edit = true; priv.draft = { personnummer: '', bankkonto: '' }; priv.err = ''; priv.ok = ''; draw(); }));
      card.appendChild(acts);
      card.appendChild(el('div', { cls: 'vp-note', text: 'Bare ledelsen ser disse opplysningene. De vises maskert til du velger «Vis», og de er ikke synlige for den ansatte, i ansattlisten eller i vaktplanen. En ny arbeidsavtale henter dem som forslag i feltene Fødselsnummer og Kontonummer; der kan de endres eller fjernes for den avtalen.' }));
      root.appendChild(card);
      return;
    }
    const form = el('div', { cls: 'emp-form' });
    const mk = (k, placeholder) => {
      const i = textInput(priv.draft[k] || '', placeholder);
      for (const [a, val] of [['autocomplete', 'off'], ['autocorrect', 'off'], ['autocapitalize', 'off'], ['spellcheck', 'false'], ['inputmode', 'numeric'], ['maxlength', '20'], ['data-lpignore', 'true'], ['data-1p-ignore', 'true']]) i.setAttribute(a, val);
      i.addEventListener('input', () => { priv.draft[k] = i.value; });
      return i;
    };
    const fPnr = mk('personnummer', '11 siffer');
    const fKto = mk('bankkonto', '11 siffer');
    form.appendChild(field('Fødselsnummer (11 siffer)', fPnr));
    if (m && m.personnummer.present) form.appendChild(el('div', { cls: 'vp-note', text: 'Et fødselsnummer er allerede registrert. La feltet stå tomt for å beholde det – en ny verdi erstatter det.' }));
    form.appendChild(field('Bankkonto (11 siffer)', fKto));
    if (m && m.bankkonto.present) form.appendChild(el('div', { cls: 'vp-note', text: 'Et kontonummer er allerede registrert. La feltet stå tomt for å beholde det – en ny verdi erstatter det.' }));
    form.appendChild(el('div', { cls: 'vp-err', text: priv.err }));
    const acts = el('div', { cls: 'vp-actions' });
    const save = btn('Lagre', 'btn primary', () => {
      if (priv.busy) return;
      const patch = {};
      if (fPnr.value.trim() !== '') patch.personnummer = fPnr.value;
      if (fKto.value.trim() !== '') patch.bankkonto = fKto.value;
      const chk = validatePrivatePatch(patch);
      if (!chk.ok) { priv.err = opError(chk.code); draw(); return; }
      const key = priv.key; priv.busy = true; priv.err = ''; save.disabled = true;
      privateFields.update(e.ansattId, patch).then(() => {
        if (stale(key)) return;
        priv = privBlank(); priv.key = key; priv.ok = 'Person- og lønnsopplysninger er lagret.';
        draw();
      }, (x) => {
        if (stale(key)) return;
        priv.busy = false;
        const c = x && x.coreResult && x.coreResult.code ? x.coreResult.code : null;
        priv.err = c ? opError(c) : 'Kunne ikke lagre. Prøv igjen.';
        draw();
      });
    });
    acts.appendChild(save);
    acts.appendChild(btn('Avbryt', 'btn tertiary', () => { const key = priv.key; priv = privBlank(); priv.key = key; draw(); }));
    form.appendChild(acts);
    card.appendChild(form);
    root.appendChild(card);
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
    privSync();   // release 019: any navigation remasks the private fields
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
  // Ledelse integration: a production host redraws from the live employee store when a server snapshot changes it.
  return { redraw: draw };
}
