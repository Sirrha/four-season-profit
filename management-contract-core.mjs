// management-contract-core.mjs
// CONTRACT FOUNDATION INCREMENT 1 — PURE. No DOM, no clock read, no storage, no network.
// Governing: SOREN-SIRRHA-EMPLOYEE-360-CONTRACT-AND-PAYROLL-HANDOFF-DESIGN-001 + Sirrha
// corrections C1-C4.
//
// THE CONTRACT IS A DOORWAY, NOT A STORE. Employment facts (role, %, compensation, workplace,
// working-time arrangement, breaks, schedule changes, probation, notice, payment interval) live
// ONLY in the employment-terms period; person facts live ONLY on the employee record. A contract
// version stores only what has no other home — identity, provenance, status — plus, AT FREEZE, a
// value SNAPSHOT of everything the rendered agreement contains.
//
// C1: no tax-card / signer identifier is collected, modelled or rendered as a placeholder — those
//     belong to a later signing boundary. Fødselsnummer and kontonummer (release 019B-R2) are
//     OPTIONAL CONTRACT FIELDS of the draft version itself (see OPTIONAL_PRIVATE_FIELDS): the two
//     facts that DO live on the contract version, because they are what THIS agreement says —
//     non-empty = part of the agreement, empty = omitted. C4: readiness is a TEMPLATE
//     fact ("alle malfelter utfylt"), never a claim of legal completeness or compliance.
// FREEZE IS LOAD-BEARING: after freeze the agreement renders from the snapshot only — live terms
// are never re-dereferenced, so changing employment terms afterwards cannot move a frozen version.
// SIGNING: v1 has NO reachable sent/signed/cancelled state and no provider call. The adapter and
// artifact shapes exist as declarations only; nothing local can populate them.

import { startDateOf, currentTermsOf, formatAddress, addressIsComplete, isValidBirthDate } from './management-employees-core.mjs';

export const CONTRACT_STATUS = Object.freeze({ DRAFT: 'utkast', FROZEN: 'godkjent_frosset' });
// Declared future states — NOT reachable in v1 (no local operation can enter them).
export const FUTURE_CONTRACT_STATUS = Object.freeze({ SENT: 'sendt_til_signering', SIGNED: 'signert', CANCELLED: 'avbrutt', SUPERSEDED: 'erstattet' });
export const CONTRACT_KINDS = Object.freeze({ AGREEMENT: 'avtale', AMENDMENT: 'endringsavtale' });

// Provider boundary — SHAPE ONLY (design §4.3 / release K). No implementation, no vendor, no
// network, no callable success path in v1. Declared so a later increment consumes an existing
// contract instead of inventing one.
export const SIGNING_ADAPTER_CONTRACT = Object.freeze({
  createSigningOrder: 'not-implemented-in-v1',
  ingestStatusEvent: 'not-implemented-in-v1',
  retrieveSignedArtifact: 'not-implemented-in-v1',
  cancelSigningOrder: 'not-implemented-in-v1',
});

// TEMPLATE FIELD MANIFEST — what the local Four Season test agreement needs, and WHERE each fact
// lives. `source` names the canonical home; nothing here is stored a second time.
// secure:true / collectible:false entries are declared so the manifest knows they exist for a
// future signing flow — v1 collects none of them and renders no placeholder for them (C1).
export const TEMPLATE_FIELDS = Object.freeze([
  { key: 'name', label: 'Navn', source: 'employee' },
  { key: 'address', label: 'Adresse', source: 'employee' },
  { key: 'birthDate', label: 'Fødselsdato', source: 'employee' },
  { key: 'startDate', label: 'Startdato', source: 'terms' },
  { key: 'role', label: 'Stilling', source: 'terms' },
  { key: 'workplace', label: 'Arbeidssted', source: 'terms' },
  // Ansettelsesform reads the DISTINCT canonical form fact (terms.employmentForm: fast|midlertidig) — never the
  // employment-scope field terms.employmentType (deltid/heltid …), which is a different fact (release -005).
  { key: 'employmentForm', label: 'Ansettelsesform', source: 'terms' },
  { key: 'employmentBasis', label: 'Grunnlag for midlertidig ansettelse', source: 'terms', requiredWhen: 'midlertidig' },
  { key: 'employmentEndDate', label: 'Sluttdato for midlertidig ansettelse', source: 'terms', requiredWhen: 'midlertidig' },
  { key: 'percentage', label: 'Stillingsprosent', source: 'terms' },
  { key: 'workingTimeArrangement', label: 'Arbeidstidsordning', source: 'terms' },
  { key: 'expectedWeeklyHours', label: 'Avtalt arbeidstid (timer per uke)', source: 'terms' },
  { key: 'breaksArrangement', label: 'Pauseordning', source: 'terms' },
  { key: 'scheduleChangeHandling', label: 'Endring av vaktplan', source: 'terms' },
  { key: 'probation', label: 'Prøvetid', source: 'terms' },
  { key: 'noticePeriod', label: 'Oppsigelsestid', source: 'terms' },
  { key: 'compensation', label: 'Lønnsgrunnlag', source: 'terms' },
  { key: 'paymentInterval', label: 'Utbetalingsintervall', source: 'terms' },
  { key: 'employer', label: 'Arbeidsgiver', source: 'profile' },
  { key: 'representative', label: 'Arbeidsgivers representant', source: 'profile' },
  // Structured company facts — ONE Four Season truth required by the sealed template.
  // pension/yrkesskadeforsikring: applies=true requires a provider/insurer name for readiness;
  // applies=false is a complete answer; applies=null is unconfirmed. Tariffavtale: applies=true
  // requires agreement details. Unconfirmed/incomplete facts block freeze — never invented.
  { key: 'salaryPaymentArrangement', label: 'Utbetalingsdato/-ordning', source: 'profile' },
  { key: 'pensionArrangement', label: 'Pensjonsordning', source: 'profile' },
  { key: 'occupationalInjuryInsurance', label: 'Yrkesskadeforsikring', source: 'profile' },
  { key: 'tariffavtale', label: 'Tariffavtale', source: 'profile' },
]);
// Declared future SECURE fields — never collected, never rendered in v1 (C1).
export const FUTURE_SECURE_FIELDS = Object.freeze([
  { key: 'taxCard', secure: true, collectible: false },
]);
// OPTIONAL PRIVATE CONTRACT FIELDS (release 019B-R2) — the two formerly declared-only secure fields, now real, optional
// inputs of the contract draft (step 1: Fødselsnummer, Kontonummer). Never a template requirement (not in
// TEMPLATE_FIELDS, never part of readiness). The value is stored ON THE DRAFT VERSION (`privateFields`), is prefilled
// ONCE — when the version is created — from the employee's private master value (`prefillFrom`, handed in by the caller
// as `privateValues`), and from then on belongs to this agreement only: editing or clearing it never touches the
// employee's master data, and a later master change never touches the draft. Non-empty = rendered and frozen into the
// snapshot; empty = omitted entirely.
export const OPTIONAL_PRIVATE_FIELDS = Object.freeze([
  { key: 'fodselsnummer', label: 'Fødselsnummer', secure: true, collectible: true, optional: true, prefillFrom: 'personnummer', invalidCode: 'PERSONNUMMER_INVALID' },
  { key: 'bankkonto', label: 'Bankkonto for lønnsutbetaling', secure: true, collectible: true, optional: true, prefillFrom: 'bankkonto', invalidCode: 'BANKKONTO_INVALID' },
]);
const PRIVATE_KEYS = OPTIONAL_PRIVATE_FIELDS.map((f) => f.key);
const privDigits = (v) => (typeof v === 'string' && /^\d{11}$/.test(v) ? v : null);   // structural only: exactly 11 digits
// Typed text -> 11 digits: spaces are accepted for both, the customary dots (1234.56.78903) for the account.
const privNormalize = (key, v) => (key === 'bankkonto' ? v.replace(/[\s.]/g, '') : v.replace(/\s/g, ''));
// The private values a version carries, as { fodselsnummer?, bankkonto? } (11 digits; absent = empty). A DRAFT reads its
// own editable fields; a FROZEN version reads its own snapshot. Never the employee's master data.
export function privateFieldsOf(version) {
  const src = !version ? null : (version.status === CONTRACT_STATUS.FROZEN ? (version.snapshot && version.snapshot.privateFields) : version.privateFields);
  const out = {};
  for (const k of PRIVATE_KEYS) { const d = privDigits(src && src[k]); if (d) out[k] = d; }
  return out;
}
// Readable presentation of the stored 11 digits: DDMMYY 12345 and 1234.56.78903.
export function formatContractPrivateField(key, digits) {
  const d = privDigits(digits);
  if (!d || !PRIVATE_KEYS.includes(key)) return '';
  return key === 'fodselsnummer' ? d.slice(0, 6) + ' ' + d.slice(6) : d.slice(0, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6);
}

const PAYMENT_LABELS = { 'manedlig': 'Månedlig', 'hver-14-dag': 'Hver 14. dag' };

// Gather the agreement's inputs BY REFERENCE READ from their canonical homes. Pure; stores
// nothing. Used for a draft preview and as the value source at freeze.
// The optional private contract fields come from the employee's current DRAFT version only. With both fields empty (or
// no draft) the returned object has no privateFields key at all — identical to the inputs before the fields existed.
export function contractInputsFor({ employee, profile, onDate, roleLabels }) {
  const terms = currentTermsOf(employee, onDate) || employee.terms[employee.terms.length - 1];
  const c = terms && terms.compensation;
  const contact = employee.contact || {};
  // Address enters the agreement ONLY through the one shared formatter, and only when the
  // structured fact is complete — never a partial line, never the unformatted transcription
  // aid held for owner re-entry (this module has no access path to it at all). An invalid stored
  // birthDate (e.g. a pre-invariant year 7919 record) is treated as missing so readiness fails
  // closed on it rather than printing an impossible date.
  const addressLine = addressIsComplete(contact.address) ? formatAddress(contact.address) : null;
  const birthDate = isValidBirthDate(contact.birthDate, onDate) ? contact.birthDate : null;
  const privateFields = privateFieldsOf(draftVersionOf(employee));
  const inputs = {
    person: { name: employee.name, email: contact.email || null, phone: contact.phone || null, address: addressLine, birthDate },
    termsPeriodRef: terms ? terms.validFrom : null,
    startDate: startDateOf(employee),
    terms: terms ? {
      role: terms.role,
      roleLabel: roleLabels && terms.role && roleLabels[terms.role] ? roleLabels[terms.role] : terms.role,
      workplace: terms.workplace, employmentType: terms.employmentType,
      employmentForm: terms.employmentForm === undefined ? null : terms.employmentForm,
      employmentBasis: terms.employmentBasis, employmentEndDate: terms.employmentEndDate,
      percentage: terms.percentage, workingTimeArrangement: terms.workingTimeArrangement,
      expectedWeeklyHours: terms.expectedWeeklyHours, breaksArrangement: terms.breaksArrangement,
      scheduleChangeHandling: terms.scheduleChangeHandling, probation: terms.probation,
      noticePeriod: terms.noticePeriod, paymentInterval: terms.paymentInterval,
      compensation: c ? Object.assign({}, c) : null,
    } : null,
    employer: profile ? Object.assign({}, profile.employer) : null,
    representative: profile ? Object.assign({}, profile.representative) : null,
    companyFacts: profile && profile.companyFacts ? JSON.parse(JSON.stringify(profile.companyFacts)) : {},
    signingPlace: profile && profile.signingPlace != null ? profile.signingPlace : null,
    clauses: profile ? profile.clauses.map((x) => ({ key: x.key, title: x.title, text: x.text, version: x.version, bullets: x.bullets ? x.bullets.slice() : null })) : [],
    templateVersion: profile ? profile.templateVersion : null,
  };
  if (Object.keys(privateFields).length) inputs.privateFields = privateFields;
  return inputs;
}

function valueForField(key, inputs) {
  if (key === 'name') return inputs.person.name;
  if (key === 'address') return inputs.person.address;
  if (key === 'birthDate') return inputs.person.birthDate;
  if (key === 'startDate') return inputs.startDate;
  if (key === 'employer') return inputs.employer && inputs.employer.name;
  if (key === 'representative') return inputs.representative && inputs.representative.name;
  const facts = inputs.companyFacts || {};
  if (key === 'salaryPaymentArrangement') return facts.salaryPaymentArrangement;
  // Structured company facts: an explicit Nei is a COMPLETE answer; Ja is complete only with
  // the provider/insurer/agreement detail; null applies = unconfirmed = missing.
  if (key === 'pensionArrangement') {
    const p = facts.pension || {};
    return p.applies === false ? 'Nei' : (p.applies === true ? (p.provider || null) : null);
  }
  if (key === 'occupationalInjuryInsurance') {
    const y = facts.occupationalInjuryInsurance || {};
    return y.applies === false ? 'Nei' : (y.applies === true ? (y.insurer || null) : null);
  }
  if (key === 'tariffavtale') {
    const ta = facts.tariffavtale || {};
    return ta.applies === false ? 'Nei' : (ta.applies === true ? (ta.agreementName || null) : null);
  }
  return inputs.terms ? inputs.terms[key] : null;
}
// DERIVED readiness — never stored. Returns the missing template facts by label, plus an honest
// label. "Avtale klar for gjennomgang" (C4/G): a template fact, NOT a legal-completeness or
// signature claim.
export function contractReadinessOf(inputs) {
  const midlertidig = inputs.terms && inputs.terms.employmentForm === 'midlertidig';
  const required = TEMPLATE_FIELDS.filter((f) => !f.requiredWhen || (f.requiredWhen === 'midlertidig' && midlertidig));
  const missing = [];
  for (const f of required) {
    const v = valueForField(f.key, inputs);
    const empty = v == null || v === '' || (typeof v === 'object' && !Object.keys(v).length);
    if (empty) missing.push({ key: f.key, label: f.label, source: f.source });
  }
  const ready = missing.length === 0;
  return {
    total: required.length, filled: required.length - missing.length, missing, ready,
    label: ready ? 'Alle malfelter utfylt – avtale klar for gjennomgang'
      : missing.length + (missing.length === 1 ? ' ting gjenstår' : ' ting gjenstår'),
    note: 'Dette er en malfaktavsjekk, ikke en juridisk fullstendighetsvurdering.',
  };
}

// ---- v2 presentation helpers (pure) ---------------------------------------------------------
// Readable org.nr spacing for display; storage stays digit-normalized.
function fmtOrgnr(orgnr) {
  const d = String(orgnr == null ? '' : orgnr).replace(/\s+/g, '');
  return /^\d{9}$/.test(d) ? d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6) : String(orgnr == null ? '' : orgnr);
}
// Human units for prøvetid/oppsigelse: a bare stored number renders with the template's month
// unit ("6" -> "6 måneder"); free text ("Ingen", "14 dager", "1 måned") passes through unchanged.
function humanDuration(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+([.,]\d+)?$/.test(s)) { const n = Number(s.replace(',', '.')); return n === 1 ? '1 måned' : s + ' måneder'; }
  return s;
}
// Break value: a bare stored number means minutes ("30" -> "30 minutter"); meaningful free
// text ("30 minutter ubetalt pause per vakt over 5,5 timer") passes through untouched.
function humanMinutes(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+([.,]\d+)?$/.test(s)) { const n = Number(s.replace(',', '.')); return n === 1 ? '1 minutt' : s + ' minutter'; }
  return s;
}
const MISSING = 'Ikke registrert';                 // canonical fact not yet entered
const UNCONFIRMED = 'Ikke bekreftet';              // company fact not yet confirmed by owner
function capFirstWord(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
// Document date display DD.MM.YYYY (pure string transform of the stored ISO work date).
function fmtDocDate(wd) {
  const s = String(wd == null ? '' : wd);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : s;
}

// Renderable agreement as PURE DATA blocks (the view paints them). `source` is 'draft' (live
// canonical values) or 'frozen' (the version's own snapshot — never re-dereferenced). Layout,
// sectioning and wording follow the sealed FOUR-SEASON-ANSETTELSESAVTALE-v2-VISUAL-FREEZE
// authority: 14 numbered sections over two A4 pages, employer/employee panels, visual signature
// areas only (no signing action), per-page footer. All text flows from `inputs`, so a frozen
// version renders from its own snapshot and later profile/template edits cannot move it.
export function renderContractBlocks(inputs, opts) {
  const o = opts || {};
  const t = inputs.terms || {};
  const emp = inputs.employer || {};
  const facts = inputs.companyFacts || {};
  const person = inputs.person || {};
  // Optional private contract fields (release 019B-R2): rendered ONLY from the inputs / frozen snapshot; an empty field
  // renders no line at all.
  const priv = inputs.privateFields || {};
  const fnr = privDigits(priv.fodselsnummer), konto = privDigits(priv.bankkonto);
  const val = (v, fallback) => (v == null || v === '' ? (fallback || MISSING) : String(v));
  const clause = (key) => inputs.clauses.find((c) => c.key === key) || null;
  const ctext = (key) => { const c = clause(key); return c ? c.text : null; };
  const orgLine = 'Org.nr. ' + fmtOrgnr(emp.orgnr) + ' · ' + val(emp.address);
  const comp = t.compensation
    ? (t.compensation.model === 'timelonn' ? 'kr ' + t.compensation.hourlyRate + ' per time' : 'kr ' + t.compensation.monthlySalary + ' per måned')
    : MISSING;
  const midlertidig = t.employmentForm === 'midlertidig';
  const pay = PAYMENT_LABELS[t.paymentInterval] || t.paymentInterval;
  const oppgaver = clause('oppgaver');
  const pen = facts.pension || {};
  const yrk = facts.occupationalInjuryInsurance || {};
  const ta = facts.tariffavtale || {};
  const pensionText = pen.applies === true ? 'Ja – ' + (pen.provider || 'leverandør ikke bekreftet')
    : pen.applies === false ? 'Nei' : UNCONFIRMED;
  const yrkText = yrk.applies === true ? 'Ja – ' + (yrk.insurer || 'forsikringsselskap ikke bekreftet')
    : yrk.applies === false ? 'Nei' : UNCONFIRMED;
  const taText = ta.applies === true ? 'Ja – ' + (ta.agreementName || 'avtaledetaljer ikke bekreftet') + (ta.parties ? ' (' + ta.parties + ')' : '')
    : ta.applies === false ? 'Nei' : UNCONFIRMED;

  const blocks = [
    { kind: 'docHeader',
      title: 'ANSETTELSESAVTALE',
      subtitle: 'Arbeidsavtale mellom ' + val(emp.name) + ' og arbeidstaker',
      badge: o.frozen ? 'GODKJENT OG FROSSET – IKKE ELEKTRONISK SIGNERT' : 'UTKAST – IKKE SIGNERT',
      orgLine, contLine: 'ANSETTELSESAVTALE · ' + val(emp.name) },
    { kind: 'note', text: o.frozen ? 'Godkjent og frosset lokal versjon. Ikke elektronisk signert.' : 'UTKAST — ikke signert' },
    { kind: 'numbered', n: '01', title: 'Partene' },
    { kind: 'parties',
      employer: [
        ['Firma', val(emp.name)],
        ['Organisasjonsnummer', fmtOrgnr(emp.orgnr) || MISSING],
        ['Adresse', val(emp.address)],
        ['Nærmeste overordnet', val(emp.nearestSuperior)],
      ],
      employee: [
        ['Navn', val(person.name)],
        ['Fødselsdato', person.birthDate ? fmtDocDate(person.birthDate) : MISSING],
      ].concat(fnr ? [['Fødselsnummer', formatContractPrivateField('fodselsnummer', fnr)]] : []).concat([
        ['Adresse', val(person.address)],
        ['Telefon', val(person.phone)],
        ['E-post', val(person.email)],
      ]) },
    { kind: 'numbered', n: '02', title: 'Ansettelsesforholdet', rows: [
      ['Stilling', val(t.roleLabel || t.role)],
      ['Tiltredelsesdato', inputs.startDate ? fmtDocDate(inputs.startDate) : MISSING],
      ['Arbeidssted', val(t.workplace)],
      ['Ansettelsesform', t.employmentForm ? capFirstWord(t.employmentForm) : MISSING],
      ['Stillingsprosent', t.percentage != null ? t.percentage + ' %' : MISSING],
      ['Evt. sluttdato', midlertidig ? (t.employmentEndDate ? fmtDocDate(t.employmentEndDate) : MISSING) : 'Ikke aktuell'],
    ].concat(midlertidig ? [['Grunnlag for midlertidighet', val(t.employmentBasis)]] : []),
      text: ctext('flyttbarhet') },
    { kind: 'numbered', n: '03', title: 'Arbeidsoppgaver',
      text: oppgaver ? oppgaver.text : null, bullets: oppgaver && oppgaver.bullets ? oppgaver.bullets : null },
    { kind: 'numbered', n: '04', title: 'Arbeidstid og arbeidsplan', textFirst: true, text: ctext('arbeidstid'), rows: [
      ['Avtalt arbeidstid', t.expectedWeeklyHours != null ? t.expectedWeeklyHours + ' timer per uke' : MISSING],
      ['Pause', humanMinutes(t.breaksArrangement) || MISSING],
      ['Vaktendringer', val(t.scheduleChangeHandling)],
      ['Arbeid utover avtalt tid', 'Etter gjeldende regler'],
    ] },
    { kind: 'numbered', n: '05', title: 'Prøvetid', rows: [
      ['Prøvetid', humanDuration(t.probation) || MISSING],
      ['Oppsigelse i prøvetid', '14 dager ved avtalt prøvetid'],
    ], text: ctext('provetid') },
    { kind: 'numbered', n: '06', title: 'Lønn og godtgjørelser', rows: [
      ['Lønnsform', t.compensation ? (t.compensation.model === 'timelonn' ? 'Timelønn' : 'Fastlønn') : MISSING],
      ['Lønn ved tiltredelse', comp],
      ['Utbetaling', (pay ? String(pay) : MISSING) + ' – ' + (facts.salaryPaymentArrangement || 'dato/ordning ' + UNCONFIRMED.toLowerCase())],
    ].concat(konto ? [['Bankkonto for lønnsutbetaling', formatContractPrivateField('bankkonto', konto)]] : []).concat([
      ['Faste tillegg', 'Ikke registrert i denne versjonen'],
    ]), text: ctext('lonn') },
    { kind: 'pageBreak' },
    { kind: 'numbered', n: '07', title: 'Ferie og feriepenger', text: ctext('ferie') },
    { kind: 'numbered', n: '08', title: 'Oppsigelse', rows: [
      ['Ordinær oppsigelsesfrist', humanDuration(t.noticePeriod) || MISSING],
      ['Oppsigelse fra arbeidstaker', 'Skriftlig'],
    ], text: ctext('oppsigelse') },
    { kind: 'numbered', n: '09', title: 'Opplæring og kompetanseutvikling', text: ctext('opplaering') },
    { kind: 'numbered', n: '10', title: 'Pensjon, forsikringer og andre sosiale ytelser', rows: [
      ['Pensjonsordning', pensionText],
      ['Yrkesskadeforsikring', yrkText],
    ], text: ctext('pensjon') },
    { kind: 'numbered', n: '11', title: 'Tariffavtale', rows: [
      ['Virksomheten er bundet av tariffavtale', taText],
    ] },
    { kind: 'numbered', n: '12', title: 'Taushetsplikt', text: ctext('taushet') },
    { kind: 'numbered', n: '13', title: 'Avtalens dokumenter og endringer', text: ctext('dokumenter') },
    { kind: 'numbered', n: '14', title: 'Godkjenning og underskrift', text: ctext('godkjenning') },
    { kind: 'signatures',
      place: val(inputs.signingPlace, '—'),
      // SIGNATURE DATE (release -007A): nobody has signed in v1, so the date is always blank — for a draft AND for an
      // approved/frozen version. frozenAt is management approval metadata (shown in Kontrakt & dokumenter), never a
      // signature date; the agreement body must read the same before and after freeze. Real signer dates belong to a
      // future signing release (SIGNING_ADAPTER_CONTRACT / signedArtifactMeta), not to opts.frozenAt.
      date: '—',
      left: { caption: 'ARBEIDSTAKER', name: val(person.name) },
      right: { caption: 'FOR ' + val(emp.name).toUpperCase(), name: val(inputs.representative && inputs.representative.name) } },
    { kind: 'docFooter', line: orgLine, brand: val(emp.name) + ' · Ansettelsesavtale' },
  ];
  blocks.push({ kind: 'note', text: 'Elektronisk signering med BankID kommer.' });
  blocks.push({ kind: 'note', text: 'Mal ' + val(inputs.templateVersion, '—') + '. Ikke juridisk kvalitetssikret – malen krever endelig juridisk gjennomgang før reell bruk og signering.' });
  return blocks;
}

export function contractVersionsOf(employee) { return (employee && employee.contractVersions) || []; }
export function latestContractVersion(employee) { const v = contractVersionsOf(employee); return v.length ? v[v.length - 1] : null; }
export function draftVersionOf(employee) { return contractVersionsOf(employee).find((v) => v.status === CONTRACT_STATUS.DRAFT) || null; }
// DERIVED contract status for Employee 360 — never a stored flag.
export function contractStateOf(employee) {
  const versions = contractVersionsOf(employee);
  if (!versions.length) return { state: 'mangler', label: 'Mangler arbeidsavtale', latest: null };
  const draft = draftVersionOf(employee);
  const frozen = versions.filter((v) => v.status === CONTRACT_STATUS.FROZEN);
  if (frozen.length) {
    const last = frozen[frozen.length - 1];
    return { state: 'frosset', label: 'Godkjent og frosset – ikke signert' + (draft ? ' · nytt utkast pågår' : ''), latest: last, draft: draft || null };
  }
  return { state: 'utkast', label: 'Utkast pågår', latest: draft, draft };
}

// ---- THE single contract operation boundary ------------------------------------------------
// Kinds: startDraft | setPrivateFields | freezeVersion | discardDraft. No kind can produce a sent/signed/cancelled
// state — those constants exist but no transition writes them (S5 respected by construction).
// freezeVersion is ONE-WAY (utkast -> godkjent_frosset, same contractVersionId); there is no unfreeze and no op edits
// a frozen version — a later change is a new version (startDraft after a frozen version = endringsavtale).
// Order-independent JSON identity of a plain value (JSON semantics: undefined keys drop out), used to compare the
// reviewed agreement inputs with the freshly derived ones.
// PRIVATE CONTRACT FIELDS (release 019B-R2): startDraft PREFILLS the new version from `privateValues` (the employee's
// master { fodselsnummer, bankkonto }, read by the caller) — only structurally valid values, only at creation.
// setPrivateFields edits the DRAFT's own fields: a blank value clears the field (= omitted from the agreement), any
// other value must be exactly 11 digits after removing spaces (and dots for the account); the refusal names the field,
// never the typed text. Nothing here writes or reads the master data afterwards. freezeVersion freezes the draft's
// values exactly; if they differ from the reviewed inputs the refusal is PRIVATE_FIELDS_CHANGED (no value in it).
function canonJson(v) {
  const norm = (x) => (Array.isArray(x) ? x.map(norm) : x && typeof x === 'object' ? Object.keys(x).sort().reduce((o, k) => { o[k] = norm(x[k]); return o; }, {}) : x);
  return JSON.stringify(norm(JSON.parse(JSON.stringify(v === undefined ? null : v))));
}
export function applyContractOperation({ store, tenantId, actor, op, profile, now, onDate, roleLabels, requireReviewedInputs, privateValues }) {
  if (!store || typeof store !== 'object') return { ok: false, code: 'NO_STORE' };
  if (typeof tenantId !== 'string' || !tenantId || !Object.prototype.hasOwnProperty.call(store, tenantId)) return { ok: false, code: 'TENANT_UNKNOWN' };
  const tenant = store[tenantId];
  if (!actor || actor.accessEnabled !== true || actor.canEditEmployment !== true) return { ok: false, code: 'NOT_AUTHORIZED' };
  if (!op || typeof op !== 'object') return { ok: false, code: 'NO_OPERATION' };
  const emp = typeof op.ansattId === 'string' && Object.prototype.hasOwnProperty.call(tenant, op.ansattId) ? tenant[op.ansattId] : null;
  if (!emp) return { ok: false, code: 'EMPLOYEE_UNKNOWN' };
  // HARD LAW (initial-registration hardening): no contract operation of any kind for an employee whose employment has no
  // stored baseline (old-register record). A contract version would be built on — and its write would store — the period
  // that is only derived from old-register fields. First registration must happen first.
  if (emp.legacy && emp.legacy.hasE360 === false) return { ok: false, code: 'INITIAL_REGISTRATION_REQUIRED' };
  if (!Array.isArray(emp.contractVersions)) emp.contractVersions = [];

  if (op.kind === 'startDraft') {
    if (draftVersionOf(emp)) return { ok: false, code: 'DRAFT_EXISTS' };
    if (!profile) return { ok: false, code: 'PROFILE_REQUIRED' };
    const n = emp.contractVersions.length + 1;
    const frozenBefore = emp.contractVersions.some((v) => v.status === CONTRACT_STATUS.FROZEN);
    const version = {
      contractVersionId: 'kv-' + emp.ansattId + '-' + n,
      kind: frozenBefore ? CONTRACT_KINDS.AMENDMENT : CONTRACT_KINDS.AGREEMENT,
      templateVersion: profile.templateVersion,
      status: CONTRACT_STATUS.DRAFT,
      createdAt: now, frozenAt: null,
      supersedes: null, supersededBy: null,
      termsPeriodRef: null, snapshot: null,
      signedArtifactMeta: null, signingTransaction: null,   // future shapes; unreachable in v1
    };
    // one-time prefill of the optional private contract fields (key present only when something was prefilled)
    const prefill = {};
    for (const k of PRIVATE_KEYS) { const d = privDigits(privateValues && privateValues[k]); if (d) prefill[k] = d; }
    if (Object.keys(prefill).length) version.privateFields = prefill;
    emp.contractVersions = emp.contractVersions.concat([version]);
    return { ok: true, version };
  }

  // Exact-version targeting (release -007): when the caller names the version it reviewed, a frozen (or otherwise
  // non-draft) version is refused deterministically — a retried/double freeze never touches or duplicates it.
  if ((op.kind === 'freezeVersion' || op.kind === 'discardDraft' || op.kind === 'setPrivateFields') && op.contractVersionId != null) {
    const target = emp.contractVersions.find((v) => v.contractVersionId === op.contractVersionId);
    if (!target) return { ok: false, code: 'VERSION_UNKNOWN' };
    if (op.kind === 'freezeVersion' && target.status === CONTRACT_STATUS.FROZEN) return { ok: false, code: 'ALREADY_FROZEN' };
    if (target.status !== CONTRACT_STATUS.DRAFT) return { ok: false, code: 'VERSION_NOT_DRAFT' };
  }

  if (op.kind === 'setPrivateFields') {
    const draft = draftVersionOf(emp);
    if (!draft) return { ok: false, code: 'NO_DRAFT' };
    if (op.contractVersionId == null || op.contractVersionId !== draft.contractVersionId) return { ok: false, code: 'VERSION_UNKNOWN' };
    const fields = op.fields;
    const keys = fields && typeof fields === 'object' && !Array.isArray(fields) ? Object.keys(fields) : [];
    if (!keys.length || keys.some((k) => !PRIVATE_KEYS.includes(k))) return { ok: false, code: 'PRIVATE_FIELDS_INVALID' };
    const next = privateFieldsOf(draft);
    for (const k of keys) {
      const raw = fields[k];
      if (raw == null || (typeof raw === 'string' && raw.trim() === '')) { delete next[k]; continue; }   // blank = not part of this agreement
      const d = typeof raw === 'string' ? privDigits(privNormalize(k, raw)) : null;
      if (!d) return { ok: false, code: OPTIONAL_PRIVATE_FIELDS.find((f) => f.key === k).invalidCode, field: k };
      next[k] = d;
    }
    const version = Object.assign({}, draft);
    if (Object.keys(next).length) version.privateFields = next; else delete version.privateFields;
    emp.contractVersions = emp.contractVersions.map((v) => (v === draft ? version : v));
    return { ok: true, version };
  }

  if (op.kind === 'discardDraft') {
    const draft = draftVersionOf(emp);
    if (!draft) return { ok: false, code: 'NO_DRAFT' };
    emp.contractVersions = emp.contractVersions.filter((v) => v !== draft);   // only a draft may be removed
    return { ok: true };
  }

  if (op.kind === 'freezeVersion') {
    const draft = draftVersionOf(emp);
    if (!draft) return { ok: false, code: 'NO_DRAFT' };
    if (!profile) return { ok: false, code: 'PROFILE_REQUIRED' };
    const inputs = contractInputsFor({ employee: emp, profile, onDate, roleLabels });
    const readiness = contractReadinessOf(inputs);
    if (!readiness.ready) return { ok: false, code: 'NOT_READY', missing: readiness.missing };
    // FREEZE WHAT WAS REVIEWED (release -007): the owner approves the exact agreement content shown when the approval
    // was opened. The inputs are re-derived here from the authoritative records; any drift since review fails closed.
    // A production boundary passes requireReviewedInputs so a freeze without a named version + reviewed inputs is refused.
    if (requireReviewedInputs && (op.contractVersionId == null || !op.expectedInputs || typeof op.expectedInputs !== 'object')) return { ok: false, code: 'FREEZE_REVIEW_REQUIRED' };
    if (op.expectedInputs != null && canonJson(inputs) !== canonJson(op.expectedInputs)) {
      // Only the private contract fields differ from the review -> their own refusal, with no value in it.
      const bare = (x) => { const c = JSON.parse(JSON.stringify(x)); if (c && typeof c === 'object') delete c.privateFields; return c; };
      return { ok: false, code: canonJson(bare(inputs)) === canonJson(bare(op.expectedInputs)) ? 'PRIVATE_FIELDS_CHANGED' : 'CONTRACT_INPUTS_CHANGED' };
    }
    // FREEZE = copy by value. JSON round-trip guarantees no live reference survives into the
    // snapshot, so later terms/profile edits cannot move this version.
    const snapshot = JSON.parse(JSON.stringify(inputs));
    const prevFrozen = emp.contractVersions.filter((v) => v.status === CONTRACT_STATUS.FROZEN);
    // The draft's editable private fields live on in the snapshot only (inputs.privateFields); the frozen version keeps
    // no second, editable-looking copy, so a blank/blank version has exactly the shape it always had.
    const base = Object.assign({}, draft); delete base.privateFields;
    const frozen = Object.freeze(Object.assign(base, {
      status: CONTRACT_STATUS.FROZEN, frozenAt: now,
      termsPeriodRef: inputs.termsPeriodRef,
      snapshot: Object.freeze(snapshot),
      supersedes: prevFrozen.length ? prevFrozen[prevFrozen.length - 1].contractVersionId : null,
    }));
    emp.contractVersions = emp.contractVersions.map((v) => (v === draft ? frozen : v));
    return { ok: true, version: frozen };
  }

  return { ok: false, code: 'UNKNOWN_OPERATION' };
}

// ---- Company-contract facts operation boundary ----------------------------------------------
// Pension / yrkesskadeforsikring / tariffavtale are ONE shared Four Season truth configured
// once in management — never re-entered per employee, never duplicated into a contract draft.
// This mutates the RUNTIME company-contract profile only (local/demo architecture — no
// production/Firebase persistence in this release). applies: true/false/null (Ja/Nei/
// unconfirmed); an explicit Nei clears the dependent detail. Fails closed on bad shapes,
// missing capability, or a frozen (seed) profile.
export function applyCompanyContractOperation({ profile, actor, op }) {
  if (!profile || typeof profile !== 'object' || !profile.companyFacts || typeof profile.companyFacts !== 'object') return { ok: false, code: 'NO_PROFILE' };
  if (Object.isFrozen(profile.companyFacts)) return { ok: false, code: 'PROFILE_FROZEN' };
  if (!actor || actor.accessEnabled !== true || actor.canEditEmployment !== true) return { ok: false, code: 'NOT_AUTHORIZED' };
  if (!op || typeof op !== 'object') return { ok: false, code: 'NO_OPERATION' };
  const okApplies = (a) => a === true || a === false || a === null;
  const okText = (v) => v == null || typeof v === 'string';
  const norm = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const f = profile.companyFacts;
  if (op.kind === 'setPension') {
    if (!okApplies(op.applies)) return { ok: false, code: 'APPLIES_INVALID' };
    if (!okText(op.provider)) return { ok: false, code: 'PROVIDER_INVALID' };
    f.pension = { applies: op.applies, provider: op.applies === true ? norm(op.provider) : null };
    return { ok: true, fact: f.pension };
  }
  if (op.kind === 'setOccupationalInjuryInsurance') {
    if (!okApplies(op.applies)) return { ok: false, code: 'APPLIES_INVALID' };
    if (!okText(op.insurer)) return { ok: false, code: 'INSURER_INVALID' };
    f.occupationalInjuryInsurance = { applies: op.applies, insurer: op.applies === true ? norm(op.insurer) : null };
    return { ok: true, fact: f.occupationalInjuryInsurance };
  }
  if (op.kind === 'setSalaryPaymentArrangement') {
    // Same shared salaryPaymentArrangement truth as before — owner-editable, never invented.
    // Employee-level paymentInterval stays a separate employment fact; the renderer combines
    // the two without duplicate storage.
    if (!okText(op.arrangement)) return { ok: false, code: 'ARRANGEMENT_INVALID' };
    f.salaryPaymentArrangement = norm(op.arrangement);
    return { ok: true, fact: f.salaryPaymentArrangement };
  }
  if (op.kind === 'setTariffavtale') {
    if (!okApplies(op.applies)) return { ok: false, code: 'APPLIES_INVALID' };
    if (!okText(op.agreementName) || !okText(op.parties)) return { ok: false, code: 'AGREEMENT_INVALID' };
    f.tariffavtale = { applies: op.applies, agreementName: op.applies === true ? norm(op.agreementName) : null, parties: op.applies === true ? norm(op.parties) : null };
    return { ok: true, fact: f.tariffavtale };
  }
  return { ok: false, code: 'UNKNOWN_OPERATION' };
}

// Render source selector: a frozen version renders from ITS OWN snapshot; a draft renders from
// live canonical values. Frozen rendering never touches live terms or the tenant profile.
export function blocksForVersion(version, { employee, profile, onDate, roleLabels }) {
  if (version && version.status === CONTRACT_STATUS.FROZEN) return renderContractBlocks(version.snapshot, { frozen: true, frozenAt: version.frozenAt });
  return renderContractBlocks(contractInputsFor({ employee, profile, onDate, roleLabels }), { frozen: false });
}
