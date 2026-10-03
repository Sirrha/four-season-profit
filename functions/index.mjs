// index.mjs — BID-1 Cloud Functions 2nd gen ENTRY SKELETON (LOCAL/EMULATOR ONLY; NOT DEPLOYED, NOT DEPLOYABLE AS-IS).
// Future runtime (Sirrha ruling D1): Firebase Cloud Functions 2nd gen + Admin SDK + Secret Manager, in a SEPARATE
// non-production Firebase project for BankID preprod. In BID-1:
//   - the provider is the FAKE WYSIWYS adapter only (any other SORMENA_SIGNING_PROVIDER value refuses to start);
//   - the secret provider is disabled (throws) — no BankID client id/secret exists or is read;
//   - there is no real BankID client, token endpoint or network call anywhere in this package;
//   - the shared contract modules are consumed from functions/shared/ — byte-exact copies of the approved root modules
//     produced by scripts/package-shared.mjs with a provenance manifest (BID-2B); a stale/corrupt copy is refused at start.
// The HTTP adapter below maps requests to the transport-agnostic handlers; the local proofs call the handlers directly.
import { onRequest } from 'firebase-functions/v2/https';
import { createSigningHandlers } from './src/signing-handlers.mjs';
import { createDisabledSecretProvider } from './src/stores.mjs';
import { SIGNING_FUNCTION_OPTIONS, resolveSigningTarget, BANKID_PREPROD } from './src/preprod-config.mjs';
import { verifySharedPackage } from './scripts/package-shared.mjs';

// BID-2B: the packaged shared modules must match their manifest (and, where the repository root is present, the root
// sources themselves) — otherwise nothing starts. Deployed runtime = integrity check; developer machine = staleness check.
export function assertSharedPackageFresh() { return verifySharedPackage({}); }

// BID-2A: the ONE place the future deployment options come from — region from the canonical config (never the platform default region),
// private invoker. The cloud target is resolved explicitly from the environment and must equal BANKID_PREPROD.
export const FUNCTION_OPTIONS = SIGNING_FUNCTION_OPTIONS;
export { resolveSigningTarget, BANKID_PREPROD };

export const secrets = createDisabledSecretProvider();

export function assertBid1Environment(env) {
  const p = (env || process.env).SORMENA_SIGNING_PROVIDER;
  if (p !== 'fake') throw Object.assign(new Error('BID1_FAKE_PROVIDER_ONLY'), { code: 'BID1_FAKE_PROVIDER_ONLY' });
}

// buildHandlers(deps) is used by the emulator proof with real Admin SDK stores + the fake provider.
export function buildHandlers(deps) { assertBid1Environment(deps.env); assertSharedPackageFresh(); return createSigningHandlers(deps); }

// HTTP skeleton: POST /{action} with { tenantId, ... } and "Authorization: Bearer <Firebase ID token>".
// Not exported as a deployable function in BID-1 (no `export const signing = ...`): calling makeHttpFunction requires
// injected dependencies and the fake-provider environment.
export function makeHttpFunction(deps) {
  const handlers = buildHandlers(deps);
  resolveSigningTarget(deps.env);   // fail closed before any handler exists: explicit preprod project + bucket, production refused
  return onRequest(FUNCTION_OPTIONS, async (req, resp) => {
    const action = String(req.path || '').replace(/^\/+/, '');
    const idToken = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const body = req.body || {};
    let out;
    if (action === 'bankid/return') out = await handlers.bankidReturn({ query: req.query, silent: req.method === 'POST' });
    else if (typeof handlers[action] === 'function' && action !== 'bankidReturn') out = await handlers[action](Object.assign({}, body, { idToken }));
    else out = { status: 404, body: { code: 'UNKNOWN_ACTION' } };
    if (out.status === 302) { resp.redirect(302, out.body.location); return; }
    if (out.body && out.body.bytes) { resp.status(out.status).set('Content-Type', 'application/pdf').send(Buffer.from(out.body.bytes)); return; }
    resp.status(out.status).json(out.body);
  });
}
