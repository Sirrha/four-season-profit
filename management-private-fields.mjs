// management-private-fields.mjs — PRIVATE employee fields (release 019): fødselsnummer + bankkonto.
// Pure, import-free. The two values live ONLY on the canonical admin-only document tenants/{T}/ansatte/{ansattId} in the
// EXISTING legacy fields `personnummer` and `bankkonto` (no parallel e360 copy, no migration, no duplication). They are
// never part of the normalized Employee 360 record, the employee list, Oversikt, Vaktplan, payroll, the employeeSelf
// projection or any signing metadata. A contract version may carry its OWN copy (release 019B-R2: management-contract-core
// OPTIONAL_PRIVATE_FIELDS): a new draft's optional Fødselsnummer / Kontonummer fields are prefilled once from here, are
// then edited or cleared on the draft only, and a non-empty field is frozen into that version's snapshot.
// Validation is deliberately STRUCTURAL only (exactly 11 digits): no date / checksum rule that could reject a legitimate
// D-number, H-number or special account form. Nothing here logs, and no result object ever carries a rejected value.

export const PRIVATE_FIELD_KEYS = Object.freeze(['personnummer', 'bankkonto']);
export const PRIVATE_FIELD_LABELS = Object.freeze({ personnummer: 'Fødselsnummer', bankkonto: 'Bankkonto' });
export const PRIVATE_FIELD_ERROR = Object.freeze({
  personnummer: 'PERSONNUMMER_INVALID', bankkonto: 'BANKKONTO_INVALID',
  EMPTY: 'PRIVATE_FIELDS_NO_CHANGE', UNKNOWN: 'PRIVATE_FIELD_UNKNOWN',
});
const DOT = '•';
const isKey = (k) => PRIVATE_FIELD_KEYS.includes(k);
// separators a person types: spaces for both; the customary dots of a written account number (1234.56.78903) for bankkonto
const strip = (key, s) => (key === 'bankkonto' ? s.replace(/[\s.]/g, '') : s.replace(/\s/g, ''));

// Typed input -> { ok:true, value:'<11 digits>' } | { ok:false, code }. The rejected input is never echoed.
export function validatePrivateField(key, input) {
  if (!isKey(key)) return { ok: false, code: PRIVATE_FIELD_ERROR.UNKNOWN };
  if (typeof input !== 'string') return { ok: false, code: PRIVATE_FIELD_ERROR[key] };
  const v = strip(key, input);
  if (!/^\d{11}$/.test(v)) return { ok: false, code: PRIVATE_FIELD_ERROR[key] };
  return { ok: true, value: v };
}

// Patch { personnummer?, bankkonto? } (typed strings) -> { ok:true, write:{ only the provided keys, digits } } |
// { ok:false, code, field }. An absent / blank entry means "leave unchanged" — an existing value is never cleared or
// replaced implicitly. Unknown keys are refused.
export function validatePrivatePatch(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  for (const k of Object.keys(p)) if (!isKey(k)) return { ok: false, code: PRIVATE_FIELD_ERROR.UNKNOWN, field: null };
  const write = {};
  for (const k of PRIVATE_FIELD_KEYS) {
    if (!(k in p) || p[k] == null || (typeof p[k] === 'string' && p[k].trim() === '')) continue;
    const r = validatePrivateField(k, p[k]);
    if (!r.ok) return { ok: false, code: r.code, field: k };
    write[k] = r.value;
  }
  if (!Object.keys(write).length) return { ok: false, code: PRIVATE_FIELD_ERROR.EMPTY, field: null };
  return { ok: true, write };
}

// Stored value (possibly legacy free text such as "1234.56.78903") -> 11 digits, or null when it is not that shape.
export function storedDigits(key, raw) {
  if (!isKey(key) || typeof raw !== 'string') return null;
  const v = raw.replace(/[\s.]/g, '');
  return /^\d{11}$/.test(v) ? v : null;
}
const present = (raw) => typeof raw === 'string' && raw.trim() !== '';

// Masked presentation. Returns { present, regular, masked } — NEVER the value. A regular fødselsnummer keeps its
// birth-date part (already an employee/contract fact) and hides the five-digit personnummer; a regular account shows
// only its last five digits; an irregular legacy value reveals nothing.
export function maskPrivateField(key, raw) {
  if (!isKey(key) || !present(raw)) return { present: false, regular: false, masked: null };
  const d = storedDigits(key, raw);
  if (!d) return { present: true, regular: false, masked: DOT.repeat(11) };
  return { present: true, regular: true, masked: key === 'personnummer' ? d.slice(0, 6) + ' ' + DOT.repeat(5) : DOT.repeat(4) + ' ' + DOT.repeat(2) + ' ' + d.slice(6) };
}

// Full presentation after an explicit reveal: 6+5 for fødselsnummer, 4.2.5 for an account; an irregular legacy value is
// shown exactly as stored (trimmed).
export function formatPrivateField(key, raw) {
  if (!isKey(key) || !present(raw)) return null;
  const d = storedDigits(key, raw);
  if (!d) return raw.trim();
  return key === 'personnummer' ? d.slice(0, 6) + ' ' + d.slice(6) : d.slice(0, 4) + ' ' + d.slice(4, 6) + ' ' + d.slice(6);
}
