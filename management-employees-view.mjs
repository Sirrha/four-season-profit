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
  canViewEmployees, canViewCompensation, canEditEmployment, EMPLOYMENT_TYPES, DOC_CATEGORIES,
} from './management-employees-core.mjs';

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

export function renderEmployeesView(root, { employeeStore, scheduleStore, tenantId, tenantLabel, roleLabels, actor, nowMs, timezone, onOpenVaktplanFor, onBack }) {
  if (!root) return;
  const todayWd = tenantWorkDate(nowMs, timezone);
  let page = 'list';           // 'list' | 'new' | 'card'
  let selectedId = null;
  let section = 'oversikt';
  let query = '';
  let errMsg = '';
  let formMsg = '';

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
    if (code === 'NOT_AUTHORIZED') return 'Du har ikke tilgang til å endre arbeidsforhold.';
    return 'Kunne ikke lagre (' + code + ').';
  }
  function apply(op, after) {
    const res = applyEmployeeOperation({ store: employeeStore, tenantId, actor, op, now: Date.now() });
    if (res.ok) { errMsg = ''; if (typeof after === 'function') after(res); } else { errMsg = opError(res.code); }
    draw();
  }
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
    search.appendChild(btn('Ny ansatt', 'btn primary', () => { page = 'new'; errMsg = ''; formMsg = ''; draw(); }));
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
      const m = missingInfoOf(e, todayWd);
      if (m.length) row.appendChild(miss(m));
      row.addEventListener('click', () => { selectedId = e.ansattId; section = 'oversikt'; page = 'card'; errMsg = ''; draw(); });
      card.appendChild(row);
    }
    root.appendChild(card);
    if (typeof onBack === 'function') root.appendChild(btn('← Tilbake', 'btn tertiary', onBack));
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
    card.appendChild(el('div', { cls: 'cue-line', text: 'Resten (stillingsprosent, lønnsgrunnlag, kontrakt) kan fylles ut senere. Ansatte uten disse vises som ufullstendige.' }));
    card.appendChild(el('div', { cls: 'vp-err', text: errMsg }));
    const acts = el('div', { cls: 'vp-actions' });
    acts.appendChild(btn('Opprett ansatt', 'btn primary', () => {
      apply({ kind: 'createEmployee', name: name.value, startDate: start.value, role: role.value }, (res) => { selectedId = res.ansattId; section = 'oversikt'; page = 'card'; });
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
      card.appendChild(factRow('Forventede timer per uke', cur.expectedWeeklyHours != null ? fmtH(cur.expectedWeeklyHours) : 'Ikke registrert'));
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
      form.appendChild(field('Forventede timer per uke', hours));
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

  function drawKontrakt(e) {
    const card = el('div', { cls: 'card' });
    card.appendChild(el('div', { cls: 'kicker', text: 'Kontrakt & dokumenter' }));
    card.appendChild(factRow('Kontraktstatus', contractStatusOf(e) === 'finnes' ? 'Finnes' : 'Mangler'));
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
    else drawCard();
  }

  draw();
}
