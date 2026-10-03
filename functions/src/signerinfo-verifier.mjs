// signerinfo-verifier.mjs — BID-1 component E. Verifies a WYSIWYS signerInfo JWT BEFORE any claim is trusted, then
// returns a MINIMIZED evidence object. Issuer/JWKS/algorithms/audience are injected: current BankID docs do not publish
// the exact JWKS URL, algorithm or aud (BID-2 onboarding items) — nothing here is invented.
// Never kept: the raw JWT (only its sha256), BankID PID (OID 2.16.578.1.61.2.3), national identity number
// (OID 2.16.578.1.61.2.4), or any other claim.
import { jwtVerify, createLocalJWKSet, errors as joseErrors } from 'jose';
import { createHash } from 'node:crypto';

export const EVIDENCE_FIELDS = Object.freeze(['sub', 'name', 'birthdate', 'signature_quality', 'cert_issuer', 'iss', 'jwtVerifiedAt', 'tokenSha256']);
const QUALITIES = ['QES', 'AES'];

function codeOf(e) {
  if (e instanceof joseErrors.JWTExpired) return 'JWT_EXPIRED';
  if (e instanceof joseErrors.JWTClaimValidationFailed) return e.claim === 'nbf' ? 'JWT_NOT_YET_VALID' : e.claim === 'iss' ? 'JWT_ISSUER_INVALID' : e.claim === 'aud' ? 'JWT_AUDIENCE_INVALID' : 'JWT_CLAIM_INVALID:' + e.claim;
  if (e instanceof joseErrors.JWSSignatureVerificationFailed) return 'JWT_SIGNATURE_INVALID';
  if (e instanceof joseErrors.JWKSNoMatchingKey) return 'JWT_KEY_UNKNOWN';
  if (e instanceof joseErrors.JOSEAlgNotAllowed) return 'JWT_ALG_NOT_ALLOWED';
  if (e instanceof joseErrors.JWSInvalid || e instanceof joseErrors.JWTInvalid) return 'JWT_MALFORMED';
  return 'JWT_INVALID';
}

// config: { jwks (JSON Web Key Set object), issuer (string), algorithms (string[]), audience? , clockToleranceSec? }
export async function verifySignerInfo(jwt, config, nowMs) {
  const c = config || {};
  if (typeof jwt !== 'string' || !jwt) return { ok: false, code: 'JWT_MISSING' };
  if (!c.jwks || !Array.isArray(c.jwks.keys) || !c.jwks.keys.length) return { ok: false, code: 'JWKS_NOT_CONFIGURED' };
  if (typeof c.issuer !== 'string' || !c.issuer) return { ok: false, code: 'ISSUER_NOT_CONFIGURED' };
  if (!Array.isArray(c.algorithms) || !c.algorithms.length) return { ok: false, code: 'ALGORITHMS_NOT_CONFIGURED' };
  if (!Number.isFinite(nowMs)) return { ok: false, code: 'CLOCK_REQUIRED' };
  let payload;
  try {
    ({ payload } = await jwtVerify(jwt, createLocalJWKSet(c.jwks), {
      issuer: c.issuer, algorithms: c.algorithms, audience: c.audience || undefined,
      currentDate: new Date(nowMs), clockTolerance: Number.isFinite(c.clockToleranceSec) ? c.clockToleranceSec : 0,
    }));
  } catch (e) { return { ok: false, code: codeOf(e) }; }
  if (typeof payload.exp !== 'number') return { ok: false, code: 'JWT_EXP_MISSING' };   // exp is mandatory for evidence
  for (const k of ['sub', 'name', 'birthdate', 'cert_issuer']) if (typeof payload[k] !== 'string' || !payload[k].trim()) return { ok: false, code: 'CLAIM_MISSING:' + k };
  if (!QUALITIES.includes(payload.signature_quality)) return { ok: false, code: 'CLAIM_INVALID:signature_quality' };
  return {
    ok: true,
    evidence: {
      sub: payload.sub, name: payload.name, birthdate: payload.birthdate, signature_quality: payload.signature_quality,
      cert_issuer: payload.cert_issuer, iss: payload.iss, jwtVerifiedAt: nowMs,
      tokenSha256: createHash('sha256').update(jwt).digest('hex'),
    },
  };
}

// CONSERVATIVE identity match: exact equality after Unicode NFC + trim + whitespace collapse + locale lower-case for the
// full name, and exact birth date. No fuzzy matching, no initials, no transliteration. Anything else -> identity_review.
export const normalizeName = (s) => String(s == null ? '' : s).normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('nb-NO');
export function matchSignerIdentity(evidence, expected, policy) {
  const reasons = [];
  const allowed = (policy && policy.allowedQualities) || ['QES'];
  if (!evidence) return { matched: false, reasons: ['NO_EVIDENCE'] };
  if (!expected || !expected.name || !expected.birthdate) reasons.push('EXPECTED_IDENTITY_INCOMPLETE');
  else {
    if (normalizeName(evidence.name) !== normalizeName(expected.name)) reasons.push('NAME_MISMATCH');
    if (evidence.birthdate !== expected.birthdate) reasons.push('BIRTHDATE_MISMATCH');
  }
  if (!allowed.includes(evidence.signature_quality)) reasons.push('SIGNATURE_QUALITY_NOT_ACCEPTED');
  return { matched: reasons.length === 0, reasons };
}
