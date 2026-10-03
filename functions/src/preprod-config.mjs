// preprod-config.mjs — BID-2A: THE canonical, non-secret identity of the BankID PREPROD cloud environment, and the
// fail-closed target gate every real-cloud-shaped adapter must pass BEFORE it may write.
// Governing: SIRRHA-CCODE-SORMENA-BANKID-BID2A-PREPROD-RESOURCE-BINDING-LOCAL-010 (resource identity manually verified by
// the owner). No secret lives here; BankID client credentials will come from Secret Manager in a later release.
//
// LAW: no "current/default project" behaviour, no fallback between projects. The signing target must be named
// EXPLICITLY and must equal BANKID_PREPROD exactly; any production project is refused by name, whatever else matches.

export const BANKID_PREPROD = Object.freeze({
  environment: 'preprod',
  projectId: 'sormena-bankid-preprod',
  projectNumber: '1070284705326',
  region: 'europe-west1',
  firestoreDatabase: '(default)',
  signingArtifactBucket: 'sormena-bankid-preprod-signing-artifacts',
});

// BID-2C: the deployed least-privilege runtime identity (no key exists; reached ONLY through impersonated ADC —
// the owner account holds roles/iam.serviceAccountTokenCreator on this service account). Runtime roles: project
// roles/datastore.user; bucket-only roles/storage.objectCreator + roles/storage.objectViewer (NO objects.delete).
export const BANKID_PREPROD_RUNTIME = Object.freeze({
  serviceAccount: 'sormena-signing-runtime@sormena-bankid-preprod.iam.gserviceaccount.com',
  impersonationUrl: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sormena-signing-runtime@sormena-bankid-preprod.iam.gserviceaccount.com:generateAccessToken',
});

// Projects that must never be a signing target. sormena-prod = production (out of scope); four-season-as = the
// pre-migration legacy production project (still referenced in historical docs).
export const FORBIDDEN_PROJECTS = Object.freeze(['sormena-prod', 'four-season-as']);

// BID-2A release gate: the adapters are production-shaped, but real-cloud (non-emulator) writes are NOT authorized for
// ORDINARY application code. This general switch stays false: BID-2C deliberately did NOT flip it. The only live path
// is a narrowly scoped, single-run SMOKE GRANT (live-smoke-gate.mjs) that assertAdapterBinding accepts in place of it.
export const LIVE_CLOUD_WRITES_AUTHORIZED = false;

// Live-smoke grants: opaque frozen objects minted ONLY by live-smoke-gate.issueLiveSmokeGrant after every env, code-
// authorization and ADC-identity gate passed. Ordinary code cannot forge one (WeakSet identity, not a shape check).
const liveGrants = new WeakSet();
export function isLiveSmokeGrant(g) { return !!g && typeof g === 'object' && liveGrants.has(g); }
export function registerLiveSmokeGrant(g) { const f = Object.freeze(g); liveGrants.add(f); return f; }   // single caller: live-smoke-gate.mjs (enforced by test)

// Any emulator-shaped environment variable in live mode is refused outright (FIRESTORE_EMULATOR_HOST,
// FIREBASE_STORAGE_EMULATOR_HOST, STORAGE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_EMULATOR_HUB, ...).
export const EMULATOR_ENV_KEY = /EMULATOR/i;
export function emulatorEnvKeys(env) { return Object.keys(env || {}).filter((k) => EMULATOR_ENV_KEY.test(k) && String((env || {})[k] || '').trim() !== ''); }
// Local credential configuration that would bypass the intended impersonated-ADC model (a service-account key path,
// a relocated gcloud config dir, a metadata-server override) is refused in live mode.
export const CREDENTIAL_BYPASS_KEYS = Object.freeze(['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG', 'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']);
export function credentialBypassKeys(env) { return CREDENTIAL_BYPASS_KEYS.filter((k) => String((env || {})[k] || '').trim() !== ''); }

export class TargetRefused extends Error {
  constructor(code, detail) { super(code + (detail ? ': ' + detail : '')); this.code = code; this.detail = detail || null; }
}
const refuse = (code, detail) => { throw new TargetRefused(code, detail); };
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Validates an explicit target description. Throws TargetRefused (fail closed) on the first problem.
// Production is checked FIRST so a production identity is always reported as such, never as a generic mismatch.
export function assertPreprodTarget(t) {
  const x = t || {};
  const fields = ['projectId', 'projectNumber', 'bucket', 'region', 'databaseId'];
  for (const f of fields) if (FORBIDDEN_PROJECTS.some((p) => str(x[f]) === p || str(x[f]).startsWith(p + '.') || str(x[f]).startsWith(p + '-'))) refuse('PRODUCTION_PROJECT_REFUSED', f + '=' + str(x[f]));
  if (!str(x.projectId)) refuse('PROJECT_ID_MISSING');
  if (str(x.projectId) !== BANKID_PREPROD.projectId) refuse('PROJECT_MISMATCH', str(x.projectId));
  if (x.projectNumber != null && String(x.projectNumber) !== BANKID_PREPROD.projectNumber) refuse('PROJECT_NUMBER_MISMATCH', String(x.projectNumber));
  if ('bucket' in x && str(x.bucket) !== BANKID_PREPROD.signingArtifactBucket) refuse(str(x.bucket) ? 'BUCKET_MISMATCH' : 'BUCKET_MISSING', str(x.bucket));
  if ('region' in x && str(x.region) !== BANKID_PREPROD.region) refuse(str(x.region) ? 'REGION_MISMATCH' : 'REGION_MISSING', str(x.region));
  if ('databaseId' in x && str(x.databaseId || '(default)') !== BANKID_PREPROD.firestoreDatabase) refuse('DATABASE_MISMATCH', str(x.databaseId));
  return Object.freeze({ projectId: BANKID_PREPROD.projectId, projectNumber: BANKID_PREPROD.projectNumber, region: BANKID_PREPROD.region, databaseId: BANKID_PREPROD.firestoreDatabase, bucket: BANKID_PREPROD.signingArtifactBucket });
}

// Resolves the signing target from a runtime environment WITHOUT defaults:
//  - SORMENA_SIGNING_PROJECT_ID and SORMENA_SIGNING_BUCKET are REQUIRED (explicit naming; never inferred);
//  - every project signal the platform exposes (GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT, FIREBASE_CONFIG.projectId) that is
//    present must AGREE with the explicit one — a disagreement is refused, never "resolved";
//  - any production identity anywhere in those signals is refused.
export function resolveSigningTarget(env) {
  const e = env || {};
  let fbProject = null;
  if (e.FIREBASE_CONFIG) { try { fbProject = JSON.parse(e.FIREBASE_CONFIG).projectId || null; } catch (err) { refuse('FIREBASE_CONFIG_UNPARSEABLE'); } }
  const signals = { SORMENA_SIGNING_PROJECT_ID: str(e.SORMENA_SIGNING_PROJECT_ID), GCLOUD_PROJECT: str(e.GCLOUD_PROJECT), GOOGLE_CLOUD_PROJECT: str(e.GOOGLE_CLOUD_PROJECT), 'FIREBASE_CONFIG.projectId': str(fbProject) };
  for (const [k, v] of Object.entries(signals)) if (v && FORBIDDEN_PROJECTS.includes(v)) refuse('PRODUCTION_PROJECT_REFUSED', k + '=' + v);
  if (FORBIDDEN_PROJECTS.some((p) => str(e.SORMENA_SIGNING_BUCKET).startsWith(p))) refuse('PRODUCTION_PROJECT_REFUSED', 'SORMENA_SIGNING_BUCKET=' + str(e.SORMENA_SIGNING_BUCKET));
  const explicit = signals.SORMENA_SIGNING_PROJECT_ID;
  if (!explicit) refuse('PROJECT_ID_MISSING', 'SORMENA_SIGNING_PROJECT_ID is required (no default project)');
  for (const [k, v] of Object.entries(signals)) if (v && v !== explicit) refuse('PROJECT_CONFLICT', k + '=' + v + ' vs SORMENA_SIGNING_PROJECT_ID=' + explicit);
  if (!('SORMENA_SIGNING_BUCKET' in e)) refuse('BUCKET_MISSING', 'SORMENA_SIGNING_BUCKET is required');
  return assertPreprodTarget({ projectId: explicit, bucket: e.SORMENA_SIGNING_BUCKET, region: e.SORMENA_SIGNING_REGION || BANKID_PREPROD.region });
}

// The Admin SDK app/Firestore/bucket actually handed to an adapter must match the validated target (checked before any
// write). mode 'emulator' additionally requires loopback emulator hosts; mode 'live' is refused unless the caller holds
// a live-smoke grant (BID-2C) — the general LIVE_CLOUD_WRITES_AUTHORIZED switch stays false.
export function assertAdapterBinding(args) {
  const a = args || {};
  const { target, appProjectId, databaseId, bucketName, mode, env, liveGrant } = a;
  // A field the caller PASSES is always checked — an undefined/empty value is a refusal, never "not applicable"
  // (an Admin app initialised without a project id must not slip through).
  const has = (k) => Object.prototype.hasOwnProperty.call(a, k);
  const t = assertPreprodTarget(target);
  if (has('appProjectId')) { if (FORBIDDEN_PROJECTS.includes(appProjectId)) refuse('PRODUCTION_PROJECT_REFUSED', 'app=' + appProjectId); if (appProjectId !== t.projectId) refuse('PROJECT_MISMATCH', 'app=' + appProjectId); }
  if (has('databaseId') && (databaseId || '(default)') !== t.databaseId) refuse('DATABASE_MISMATCH', databaseId);
  if (has('bucketName') && bucketName !== t.bucket) refuse(FORBIDDEN_PROJECTS.some((p) => String(bucketName).startsWith(p)) ? 'PRODUCTION_PROJECT_REFUSED' : 'BUCKET_MISMATCH', bucketName);
  const ev = env || {};
  const loop = (h) => typeof h === 'string' && /^(127\.0\.0\.1|localhost):\d+$/.test(h);
  if (mode === 'emulator') {
    if (has('databaseId') && !loop(ev.FIRESTORE_EMULATOR_HOST)) refuse('EMULATOR_HOST_REQUIRED', 'FIRESTORE_EMULATOR_HOST');
    if (has('bucketName') && !loop(ev.FIREBASE_STORAGE_EMULATOR_HOST) && !loop(ev.STORAGE_EMULATOR_HOST)) refuse('EMULATOR_HOST_REQUIRED', 'FIREBASE_STORAGE_EMULATOR_HOST');
  } else if (mode === 'live') {
    if (!LIVE_CLOUD_WRITES_AUTHORIZED && !isLiveSmokeGrant(liveGrant)) refuse('LIVE_CLOUD_WRITES_NOT_AUTHORIZED', 'no general authorization and no live-smoke grant');
    if (emulatorEnvKeys(ev).length) refuse('EMULATOR_ENV_IN_LIVE_MODE', emulatorEnvKeys(ev).join(','));
    if (has('bucketName') && liveGrant && liveGrant.bucket !== bucketName) refuse('BUCKET_MISMATCH', 'grant=' + liveGrant.bucket + ' vs ' + bucketName);
  } else refuse('ADAPTER_MODE_REQUIRED', String(mode));
  return t;
}

// Cloud Functions 2nd gen options for the future signing endpoints — region explicit, never a default (us-central1).
export const SIGNING_FUNCTION_OPTIONS = Object.freeze({ region: BANKID_PREPROD.region, cors: false, invoker: 'private' });
