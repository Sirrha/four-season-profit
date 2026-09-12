// employee-myjob.mjs
// EMPLOYEE PAGE V1 — "Min ansettelse" PRESENTATION helper
// (Sirrha EMPLOYEE-PAGE-V1-JOBB-OG-OKONOMI-FINISH-BUILD-RELEASE-001).
// PURE and import-free. The shell reads the canonical employee truth at the call site
// (employeeOf → currentTermsOf / startDateOf / contractStatusOf) and hands the facts here; this
// module only turns them into deterministic display rows. No store, no write, no ambient clock,
// and no monetary fact of any kind: compensation is never read, never passed through.

export const IKKE_REGISTRERT = 'Ikke registrert';
export const SCOPE_LINE = 'Lønn, skatt, feriepenger og dokumenter er ikke tilgjengelig i denne versjonen.';
// Owner-facing labels for the canonical EMPLOYMENT_TYPES keys (presentation only).
export const EMPLOYMENT_TYPE_LABELS = Object.freeze({ fast: 'Fast', deltid: 'Deltid', tilkalling: 'Tilkalling', midlertidig: 'Midlertidig' });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ISO workDate -> DD.MM.YYYY; anything else -> null (never guessed).
export function nbDate(iso) {
  if (typeof iso !== 'string' || !ISO_DATE.test(iso)) return null;
  return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
}

export function fmtHoursPerWeek(h) {
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) return null;
  return h.toLocaleString('nb-NO', { maximumFractionDigits: 2 }) + ' t per uke';
}

// THE rows. `terms` = the employee's CURRENT employment terms (or null), `startDate` = the
// canonical start date, `contractStatus` = 'finnes' | 'mangler' (or null), `roleLabels` = the
// tenant's role label map. Every missing canonical value renders as IKKE_REGISTRERT; the
// "Forventet timer per uke" row exists only when that fact exists.
export function minAnsettelseFra({ terms, startDate, contractStatus, roleLabels }) {
  const t = terms && typeof terms === 'object' ? terms : null;
  const labels = roleLabels && typeof roleLabels === 'object' ? roleLabels : {};
  const row = (key, label, value) => ({ key, label, value: value == null || value === '' ? IKKE_REGISTRERT : String(value), missing: value == null || value === '' });
  const rows = [];
  rows.push(row('stilling', 'Stilling', t && t.role ? (labels[t.role] || t.role) : null));
  rows.push(row('stillingstype', 'Stillingstype', t && t.employmentType ? (EMPLOYMENT_TYPE_LABELS[t.employmentType] || t.employmentType) : null));
  rows.push(row('stillingsprosent', 'Stillingsprosent', t && typeof t.percentage === 'number' && Number.isFinite(t.percentage) ? t.percentage + ' %' : null));
  rows.push(row('arbeidssted', 'Arbeidssted', t && t.workplace ? t.workplace : null));
  rows.push(row('ansatt_fra', 'Ansatt fra', nbDate(startDate)));
  if (t && t.expectedWeeklyHours != null) rows.push(row('forventet_timer', 'Forventet timer per uke', fmtHoursPerWeek(t.expectedWeeklyHours)));
  const hasContract = contractStatus === 'finnes';
  rows.push({ key: 'arbeidsavtale', label: 'Arbeidsavtale', value: hasContract ? 'Registrert' : 'Mangler', missing: !hasContract });
  const missingCount = rows.filter((r) => r.missing).length;
  return { rows, missingCount, complete: missingCount === 0 };
}
