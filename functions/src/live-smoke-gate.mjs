// live-smoke-gate.mjs — BID-2C: the ONLY way a real-cloud (live) write can be authorized, and it authorizes exactly ONE
// bounded smoke run — never a general live mode. A later, separately authorized execution release sets
// LIVE_SMOKE_AUTHORIZATION to { authorized: true, releaseId: '<that release MID>', runId: 'smoke-<id>' }; nothing else
// in the code base changes. Every gate below must pass, in order, before a grant exists:
//   1. the -010/-011 gates: explicit preprod project + bucket + region, production refused, smoke enabled, mode 'live'
//   2. SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED === 'true'                (operator intent, per shell)
//   3. code-level authorization: authorized === true                 (release ruling, in source)
//   4. the run id equals the ONE authorized run id                   (bounded: one grant = one run)
//   5. SORMENA_LIVE_SMOKE_RELEASE_ID equals the authorized release id (operator echoes the ruling)
//   6. no emulator-shaped environment variable                       (live and emulator never mix)
//   7. no credential bypass (GOOGLE_APPLICATION_CREDENTIALS, CLOUDSDK_CONFIG, GCE_METADATA_*)
//   8. a VERIFIED impersonated-ADC identity record for the runtime service account (adc-identity.mjs)
// GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT alone never authorize anything (they are only checked for agreement in -010).
import { BANKID_PREPROD, BANKID_PREPROD_RUNTIME, LIVE_CLOUD_WRITES_AUTHORIZED, TargetRefused, resolveSigningTarget, emulatorEnvKeys, credentialBypassKeys, registerLiveSmokeGrant } from './preprod-config.mjs';
import { isVerifiedAdcIdentity } from './adc-identity.mjs';

// DEFAULT = NOT AUTHORIZED. The execution release edits this literal (and only this literal) for one run.
// History (both run ids are CONSUMED and must never be authorized again — enforced by test V01):
//   smoke-live0001  EXEC-015  2026-10-03  FAIL before step A (network guard refused Firestore's resolved IP)
//   smoke-live0002  EXEC-016  2026-10-03  PASS (14/14 steps)
// 2026-10-03: authorization CLOSED by SIRRHA-CCODE-SORMENA-BANKID-POST-SMOKE-AUTHORIZATION-CLOSURE-017B. No run is authorized.
export const LIVE_SMOKE_AUTHORIZATION = Object.freeze({ authorized: false, releaseId: null, runId: null });
export const CONSUMED_LIVE_SMOKE_RUN_IDS = Object.freeze(['smoke-live0001', 'smoke-live0002']);
export const RELEASE_ID_PATTERN = /^SIRRHA-CCODE-[A-Z0-9-]{8,120}$/;
export const SMOKE_RUN_ID = /^smoke-[a-z0-9]{4,32}$/;
const refuse = (code, detail) => { throw new TargetRefused(code, detail); };

// Validates the SHAPE of an authorization literal: a sloppy flip ("authorized: true" without a bounded run id or a
// release id) must not authorize anything.
export function assertAuthorizationShape(auth) {
  const a = auth || {};
  if (a.authorized !== true) refuse('LIVE_CLOUD_WRITES_NOT_AUTHORIZED', 'LIVE_CLOUD_WRITES_AUTHORIZED=false and LIVE_SMOKE_AUTHORIZATION.authorized=false');
  if (typeof a.releaseId !== 'string' || !RELEASE_ID_PATTERN.test(a.releaseId)) refuse('LIVE_SMOKE_AUTHORIZATION_MALFORMED', 'releaseId');
  if (typeof a.runId !== 'string' || !SMOKE_RUN_ID.test(a.runId)) refuse('LIVE_SMOKE_AUTHORIZATION_MALFORMED', 'runId');
  if (CONSUMED_LIVE_SMOKE_RUN_IDS.includes(a.runId)) refuse('LIVE_SMOKE_RUN_ALREADY_CONSUMED', a.runId + ' is a consumed run id and can never be authorized again');
  return a;
}

// Issues the grant or throws TargetRefused. `authorization` is injectable ONLY so the gate order can be proven locally;
// preprod-smoke.mjs and the runner always use the module constant.
export function issueLiveSmokeGrant({ env, runId, adcIdentity, authorization } = {}) {
  const e = env || {};
  const auth = authorization === undefined ? LIVE_SMOKE_AUTHORIZATION : authorization;
  const target = resolveSigningTarget(e);
  if (e.SORMENA_SIGNING_REGION !== BANKID_PREPROD.region) refuse(e.SORMENA_SIGNING_REGION ? 'REGION_MISMATCH' : 'REGION_MISSING', String(e.SORMENA_SIGNING_REGION));
  if (e.SORMENA_PREPROD_SMOKE_ENABLED !== 'true') refuse('SMOKE_NOT_ENABLED', 'SORMENA_PREPROD_SMOKE_ENABLED must be exactly "true"');
  if (e.SORMENA_SIGNING_ADAPTER_MODE !== 'live') refuse('LIVE_MODE_REQUIRED', 'SORMENA_SIGNING_ADAPTER_MODE=' + (e.SORMENA_SIGNING_ADAPTER_MODE == null ? '<unset>' : String(e.SORMENA_SIGNING_ADAPTER_MODE)));
  if (e.SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED !== 'true') refuse('LIVE_WRITE_NOT_AUTHORIZED', 'SORMENA_LIVE_CLOUD_WRITE_AUTHORIZED must be exactly "true"');
  if (LIVE_CLOUD_WRITES_AUTHORIZED) refuse('GENERAL_LIVE_SWITCH_REFUSED', 'the smoke never runs under a general live switch');   // defense in depth: BID-2C keeps the general switch false
  assertAuthorizationShape(auth);
  if (typeof runId !== 'string' || !SMOKE_RUN_ID.test(runId)) refuse('SMOKE_RUN_ID_INVALID', String(runId).slice(0, 40));
  if (runId !== auth.runId) refuse('LIVE_SMOKE_RUN_ID_NOT_AUTHORIZED', runId + ' is not the authorized run id');
  if (e.SORMENA_LIVE_SMOKE_RELEASE_ID !== auth.releaseId) refuse('LIVE_SMOKE_RELEASE_ID_MISMATCH', 'SORMENA_LIVE_SMOKE_RELEASE_ID must echo the authorizing release id');
  const emu = emulatorEnvKeys(e); if (emu.length) refuse('EMULATOR_ENV_IN_LIVE_MODE', emu.join(','));
  const byp = credentialBypassKeys(e); if (byp.length) refuse(byp[0] === 'GOOGLE_APPLICATION_CREDENTIALS' ? 'SA_KEY_PATH_REFUSED' : 'CREDENTIAL_BYPASS_REFUSED', byp.join(','));
  if (!isVerifiedAdcIdentity(adcIdentity)) refuse(adcIdentity && adcIdentity.code && adcIdentity.ok === false ? adcIdentity.code : 'ADC_IDENTITY_NOT_VERIFIED', adcIdentity && adcIdentity.serviceAccount ? String(adcIdentity.serviceAccount) : 'structural ADC check has not passed');
  if (adcIdentity.serviceAccount !== BANKID_PREPROD_RUNTIME.serviceAccount) refuse('ADC_IMPERSONATION_TARGET_MISMATCH', adcIdentity.serviceAccount);
  return registerLiveSmokeGrant({ scope: 'preprod-smoke', releaseId: auth.releaseId, runId, projectId: target.projectId, projectNumber: target.projectNumber, region: target.region, databaseId: target.databaseId, bucket: target.bucket, serviceAccount: adcIdentity.serviceAccount, issuedAt: new Date().toISOString() });
}
