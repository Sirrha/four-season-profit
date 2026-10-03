// adc-identity.mjs — BID-2C STRUCTURAL identity check of the local Application Default Credentials BEFORE any cloud call.
// The live smoke may run ONLY as the impersonated runtime service account (BANKID_PREPROD_RUNTIME.serviceAccount), i.e.
// the ADC file that `gcloud auth application-default login --impersonate-service-account=<SA>` writes:
//   { type: 'impersonated_service_account', service_account_impersonation_url: '.../<SA>:generateAccessToken',
//     delegates: [], source_credentials: { type: 'authorized_user', client_id, client_secret, refresh_token } }
// Only SAFE STRUCTURAL fields are read and reported (type, target email, presence, path). Secret fields are never
// copied, logged or returned. No network: this is a file read + shape check. The file location is the SAME well-known
// location google-auth-library resolves (Windows: %APPDATA%\gcloud\application_default_credentials.json; otherwise
// $HOME/.config/gcloud/...), so what we verify is what the Admin SDK will use. A caller-supplied path is not accepted.
import fs from 'node:fs';
import path from 'node:path';
import { BANKID_PREPROD_RUNTIME } from './preprod-config.mjs';

export const ADC_FILE = 'application_default_credentials.json';
export const ADC_SECRET_FIELDS = Object.freeze(['refresh_token', 'access_token', 'client_secret', 'client_id', 'private_key', 'private_key_id', 'token', 'id_token']);
const verified = new WeakSet();
export function isVerifiedAdcIdentity(a) { return !!a && typeof a === 'object' && verified.has(a); }
const result = (ok, code, safe) => Object.freeze(Object.assign({ ok, code }, safe || {}));

// google-auth-library 11.x (_getWellKnownFile): APPDATA on Windows, else HOME/.config. No CLOUDSDK_CONFIG support there,
// which is exactly why CLOUDSDK_CONFIG is refused in live mode (it would make gcloud and the SDK disagree).
export function adcWellKnownPath(env, platform) {
  const e = env || {};
  const dir = platform === 'win32' ? (e.APPDATA ? path.join(e.APPDATA, 'gcloud') : null) : (e.HOME ? path.join(e.HOME, '.config', 'gcloud') : null);
  return dir ? path.join(dir, ADC_FILE) : null;
}

// Pure shape check of an already-parsed ADC document. Returns { ok:true, type, serviceAccount, sourceType } or
// { ok:false, code } — never the document itself, never a secret value.
export function inspectAdcJson(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return result(false, 'ADC_UNPARSEABLE');
  const type = typeof json.type === 'string' ? json.type : '';
  if (type === 'authorized_user') return result(false, 'ADC_DIRECT_USER_REFUSED', { type });                 // plain `gcloud auth application-default login` (no impersonation)
  if (type === 'service_account') return result(false, 'ADC_SERVICE_ACCOUNT_KEY_REFUSED', { type });         // a downloaded key: never part of this flow
  if (type === 'external_account' || type === 'external_account_authorized_user') return result(false, 'ADC_TYPE_REFUSED', { type });
  if (type !== 'impersonated_service_account') return result(false, 'ADC_TYPE_REFUSED', { type: type || null });
  if (Object.prototype.hasOwnProperty.call(json, 'private_key')) return result(false, 'ADC_SERVICE_ACCOUNT_KEY_REFUSED', { type });
  const url = typeof json.service_account_impersonation_url === 'string' ? json.service_account_impersonation_url : '';
  const m = /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(url);
  if (!m) return result(false, 'ADC_IMPERSONATION_URL_INVALID', { type });
  const serviceAccount = m[1];
  if (serviceAccount !== BANKID_PREPROD_RUNTIME.serviceAccount) return result(false, 'ADC_IMPERSONATION_TARGET_MISMATCH', { type, serviceAccount });
  if (Array.isArray(json.delegates) && json.delegates.length) return result(false, 'ADC_DELEGATION_CHAIN_REFUSED', { type, serviceAccount, delegates: json.delegates.length });
  const src = json.source_credentials;
  if (!src || typeof src !== 'object') return result(false, 'ADC_SOURCE_CREDENTIALS_MISSING', { type, serviceAccount });
  if (src.type !== 'authorized_user') return result(false, 'ADC_SOURCE_TYPE_REFUSED', { type, serviceAccount, sourceType: typeof src.type === 'string' ? src.type : null });
  if (Object.prototype.hasOwnProperty.call(src, 'private_key')) return result(false, 'ADC_SERVICE_ACCOUNT_KEY_REFUSED', { type, serviceAccount });
  if (typeof src.refresh_token !== 'string' || !src.refresh_token) return result(false, 'ADC_SOURCE_INCOMPLETE', { type, serviceAccount });   // presence only; value never leaves this function
  return result(true, 'ADC_IMPERSONATED_OK', { type, serviceAccount, sourceType: 'authorized_user' });
}

// Reads the well-known ADC file for (env, platform) and returns a SAFE identity record. The record is registered as
// verified only when ok === true; live-smoke-gate requires a registered record (identity, not shape).
export function readAdcIdentity({ env, platform, fsImpl } = {}) {
  const f = fsImpl || fs;
  const p = adcWellKnownPath(env, platform || process.platform);
  if (!p) return result(false, 'ADC_LOCATION_UNRESOLVABLE', { present: false, path: null });
  if (!f.existsSync(p)) return result(false, 'ADC_ABSENT', { present: false, path: p });
  let json;
  try { json = JSON.parse(f.readFileSync(p, 'utf8')); } catch (e) { return result(false, 'ADC_UNPARSEABLE', { present: true, path: p }); }
  const r = inspectAdcJson(json);
  const safe = { present: true, path: p };
  for (const k of ['type', 'serviceAccount', 'sourceType', 'delegates']) if (r[k] !== undefined) safe[k] = r[k];
  const out = result(r.ok, r.code, safe);
  if (out.ok) verified.add(out);
  return out;
}
