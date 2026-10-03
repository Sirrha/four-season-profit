// run-live-smoke.mjs — BID-2C LOCAL live-smoke runner (NOT a Cloud Function; runs on the owner's PC under a separately
// authorized execution release). ONE bounded synthetic smoke run against the REAL preprod project through the impersonated
// runtime service account, with every gate evaluated locally BEFORE the Admin SDK is even imported.
// Usage (from functions/):  node scripts/run-live-smoke.mjs --run-id smoke-<id>
// The ONLY caller input is the run id. No tenant / employee / contract / path / bucket / project / region / PDF /
// credential-path argument exists; anything else on the command line is refused. Credentials: Application Default
// Credentials from the standard gcloud location ONLY (impersonated_service_account for the runtime SA, verified
// structurally first); GOOGLE_APPLICATION_CREDENTIALS / CLOUDSDK_CONFIG / GCE_METADATA_* are refused. Network: the
// allowlist in scripts/live-net-guard.mjs, installed before the Google libraries load. Evidence: <repo>/live-smoke-evidence/
// <runId>-<finishedAt>.evidence.json (redacted, non-secret). One run id = one attempt: <runId>.consumed.json is created
// exclusively after the local gates and before any network path, and is never removed. Nothing is ever deleted; the ADC is revoked by the OWNER
// afterwards (gcloud auth application-default revoke) — not by this script.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRunId, runPreprodSmoke, SMOKE_TENANT } from '../src/preprod-smoke.mjs';
import { BANKID_PREPROD_RUNTIME, TargetRefused } from '../src/preprod-config.mjs';
import { LIVE_SMOKE_AUTHORIZATION, issueLiveSmokeGrant } from '../src/live-smoke-gate.mjs';
import { readAdcIdentity } from '../src/adc-identity.mjs';
import { installLiveNetGuard } from './live-net-guard.mjs';
import { buildEvidence, writeEvidence, consumeLiveRun } from '../src/live-smoke-evidence.mjs';
import { verifySharedPackage } from './package-shared.mjs';

export const RUNNER_VERSION = 'sormena-live-smoke-runner/1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_DIR = path.resolve(HERE, '..', '..', 'live-smoke-evidence');
const refuse = (code, detail) => { throw new TargetRefused(code, detail); };

// argv (after node + script): exactly `--run-id <id>` or `--run-id=<id>`; everything else is refused by name.
export function parseRunnerArgs(argv) {
  const a = [...(argv || [])];
  let runId = null;
  while (a.length) {
    const x = a.shift();
    if (x === '--run-id') { if (runId !== null || !a.length) refuse('RUN_ID_ARGUMENT_INVALID'); runId = a.shift(); }
    else if (typeof x === 'string' && x.startsWith('--run-id=')) { if (runId !== null) refuse('RUN_ID_ARGUMENT_INVALID'); runId = x.slice('--run-id='.length); }
    else refuse('UNEXPECTED_ARGUMENT', String(x).slice(0, 40));
  }
  if (runId === null) refuse('RUN_ID_ARGUMENT_REQUIRED', '--run-id smoke-<id>');
  return assertRunId(runId);
}

// Everything that must hold BEFORE any Google library is loaded. Pure/local: env + ADC file + code constant.
// `authorization` is injectable for the local proof only; main() never passes it (module constant).
export function assertLivePreflight({ env, runId, platform, fsImpl, authorization } = {}) {
  const e = env || {};
  if (e.SORMENA_SIGNING_ADAPTER_MODE !== 'live') refuse('LIVE_MODE_REQUIRED', 'SORMENA_SIGNING_ADAPTER_MODE=' + (e.SORMENA_SIGNING_ADAPTER_MODE == null ? '<unset>' : String(e.SORMENA_SIGNING_ADAPTER_MODE)));
  const adc = readAdcIdentity({ env: e, platform: platform || process.platform, fsImpl });
  try { return { adc, grant: issueLiveSmokeGrant({ env: e, runId, adcIdentity: adc, authorization }) }; }   // throws TargetRefused on the first failed gate
  catch (err) { err.adc = adc; throw err; }   // the safe ADC record still goes into the evidence of a refused run
}

export async function main({ argv, env, platform, evidenceDir, log } = {}) {
  const out = log || ((s) => console.log(s));
  const startedAt = new Date().toISOString();
  let runId = null, adc = null, grant = null, target = null, guard = null, result = null;
  try {
    runId = parseRunnerArgs(argv || process.argv.slice(2));
    const pf = assertLivePreflight({ env: env || process.env, runId, platform });
    adc = pf.adc; grant = pf.grant; target = { projectId: grant.projectId, projectNumber: grant.projectNumber, region: grant.region, databaseId: grant.databaseId, bucket: grant.bucket };
    verifySharedPackage({ requireRoot: true });   // the smoke must run the packaged modules that match the repository root
    out('LIVE SMOKE ' + runId + ' | release ' + grant.releaseId + ' | project ' + grant.projectId + ' | bucket ' + grant.bucket + ' | as ' + grant.serviceAccount);
    // ONE-SHOT (-016A): every local gate has passed and nothing network-shaped exists yet. From this line on the run id is
    // consumed forever (create-only marker, never removed) — whatever happens next. An already consumed run id stops here.
    const consumed = consumeLiveRun(evidenceDir || EVIDENCE_DIR, { runId, releaseId: grant.releaseId, startedAt, projectId: grant.projectId, serviceAccount: grant.serviceAccount });
    out('CONSUMED ' + runId + ' | ' + consumed.path);
    // Boundary first, libraries second: nothing Google-shaped is loaded before the allowlist is in place.
    process.env.METADATA_SERVER_DETECTION = 'none';
    guard = installLiveNetGuard();
    const { initializeApp, applicationDefault } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const { getStorage } = await import('firebase-admin/storage');
    const app = initializeApp({ credential: applicationDefault(), projectId: grant.projectId, storageBucket: grant.bucket }, 'live-smoke-' + runId);
    const db = getFirestore(app); db.settings({ ignoreUndefinedProperties: true });
    const bucket = getStorage(app).bucket(grant.bucket);
    result = await runPreprodSmoke({ app, db, bucket, env: env || process.env, runId, adcIdentity: adc });
    for (const s of result.steps || []) out((s.ok ? 'PASS ' : 'FAIL ') + s.id + ' | ' + s.name);
    if (result.refused) out('REFUSED ' + result.refused + (result.detail ? ' | ' + result.detail : ''));
    try { await app.delete(); } catch (e) { /* handles only */ }
  } catch (e) {
    if (e && e.adc && !adc) adc = e.adc;
    result = { ok: false, refused: e && e.code || 'RUNNER_ERROR', detail: String(e && (e.detail || e.message) || e).slice(0, 300), steps: (result && result.steps) || [] };
    out('REFUSED ' + result.refused + ' | ' + result.detail);
  }
  const finishedAt = new Date().toISOString();
  const evidence = buildEvidence({ runId: runId || 'smoke-invalid', releaseId: grant ? grant.releaseId : (LIVE_SMOKE_AUTHORIZATION.releaseId || null), startedAt, finishedAt, target, serviceAccount: BANKID_PREPROD_RUNTIME.serviceAccount, adc, netGuard: guard, result, runner: { version: RUNNER_VERSION, tenant: SMOKE_TENANT, platform: platform || process.platform } });
  const written = writeEvidence(evidenceDir || EVIDENCE_DIR, evidence);
  out('EVIDENCE ' + written.path + ' | redactions ' + written.redactions + ' | ' + written.final);
  out('LIVE_SMOKE_RESULT ' + written.final);
  return { ok: result && result.ok === true, runId, evidencePath: written.path, final: written.final };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((r) => process.exit(r.ok ? 0 : 1), (e) => { console.log('RUNNER_FATAL ' + String(e && e.code || e && e.message || e).slice(0, 200)); process.exit(2); });
}
