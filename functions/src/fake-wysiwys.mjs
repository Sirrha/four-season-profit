// fake-wysiwys.mjs — BID-1 component D. DETERMINISTIC in-memory stand-in for BankID Signing WYSIWYS V1 (PAdES).
// NO NETWORK. Models the documented lifecycle closely enough that BID-2 can swap in the real client without changing
// signing truth (developer.bankid.no, retrieved 2026-09-29):
//   - one sign order per signer (serial signing: order #2 input = order #1 output);
//   - POST create -> signId + UI url; GET status -> orderState ORDER_RECEIVED | USER_SIGNING | REJECTED | FAILED |
//     TIMED_OUT | SIGN_COMPLETED, unknown order -> not found (404);
//   - DELETE = "Delete sign order and download signing results": DESTRUCTIVE, one-shot; a second DELETE is not found;
//   - timeoutSeconds only limits the time until the user STARTS signing (-> TIMED_OUT);
//   - hard ceiling: creation -> collection must not exceed 2 hours (order gone afterwards);
//   - optional silent callback to redirectUrl (no documented payload/auth -> the consumer must re-GET);
//   - result: signingResults[{ padesSignedPdf (base64), signedDocumentSha256, unsignedDocumentSha256 }] + signerInfo JWT;
//   - NO signer restriction: anyone who completes the BankID session becomes the signer.
// The "signed PDF" is the input bytes plus an appended, clearly labelled FAKE marker comment — never a real signature.
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';

export const ORDER_STATES = Object.freeze(['ORDER_RECEIVED', 'USER_SIGNING', 'REJECTED', 'FAILED', 'TIMED_OUT', 'SIGN_COMPLETED']);
export const FINAL_ORDER_STATES = Object.freeze(['REJECTED', 'FAILED', 'TIMED_OUT', 'SIGN_COMPLETED']);
export const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const MAX_PDF_BASE64 = 41943040;
const sha = (b) => createHash('sha256').update(b).digest('hex');

export function createFakeWysiwys({ clock, signingKey, kid, issuer, alg, onCallback }) {
  const orders = new Map();
  const requests = [];     // every request the service made (inspection only)
  let seq = 0;
  const now = () => clock();
  const live = (o) => o && now() - o.createdAt <= TWO_HOURS_MS;
  function lazyTimeout(o) {
    if (o.state === 'ORDER_RECEIVED' && now() - o.createdAt > o.timeoutSeconds * 1000) settle(o, 'TIMED_OUT');
  }
  function settle(o, state) {
    o.state = state;
    if (o.requestCallback && o.redirectUrl && typeof onCallback === 'function') {
      // silent callback: the consumer learns only that "something happened" — it must GET the authoritative state
      onCallback({ url: o.redirectUrl + (o.redirectUrl.includes('?') ? '&' : '?') + 'sign_id=' + o.signId, signId: o.signId });
    }
  }
  const api = {
    // POST /v1/signdoc/pades
    async createSignOrder(req) {
      requests.push({ op: 'create', at: now(), req: { orderName: req && req.orderName, merchantWorkflowState: req && req.merchantWorkflowState, redirectUrl: req && req.redirectUrl } });
      if (!req || typeof req.orderName !== 'string' || !req.orderName) return { ok: false, httpStatus: 400, code: 'orderName' };
      if (typeof req.addVisualSeals !== 'boolean') return { ok: false, httpStatus: 400, code: 'addVisualSeals' };
      if (!Array.isArray(req.documents) || req.documents.length < 1 || req.documents.length > 30) return { ok: false, httpStatus: 400, code: 'documents' };
      const b64 = req.documents[0] && req.documents[0].pdf;
      if (typeof b64 !== 'string' || !b64 || b64.length > MAX_PDF_BASE64) return { ok: false, httpStatus: 413, code: 'pdf' };
      const input = Buffer.from(b64, 'base64');
      if (input.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, httpStatus: 400, code: 'NOT_A_PDF' };
      if (req.useConversion === true && input.includes(Buffer.from('%FAKE-PADES-SIGNATURE'))) return { ok: false, httpStatus: 400, code: 'CONVERSION_OF_SIGNED_PDF' };
      requests[requests.length - 1].inputSha256 = sha(input);
      seq += 1;
      const signId = 'fake-sign-' + String(seq).padStart(4, '0');
      const o = { signId, createdAt: now(), state: 'ORDER_RECEIVED', input, timeoutSeconds: Number.isFinite(req.timeoutSeconds) ? req.timeoutSeconds : 1800,
        redirectUrl: req.redirectUrl || null, requestCallback: req.requestCallback === true, requestSignerInfo: !!(req.resultContent && req.resultContent.requestSignerInfo),
        workflow: req.merchantWorkflowState || 'NO_WORKFLOW', signer: null, output: null };
      orders.set(signId, o);
      return { ok: true, signId, url: 'https://fake-wysiwys.invalid/nb/' + signId };
    },
    // GET /v1/signdoc/pades?sign_id=
    async getOrderState(signId) {
      requests.push({ op: 'get', at: now(), signId });
      const o = orders.get(signId);
      if (!o || !live(o)) { if (o) orders.delete(signId); return { found: false, httpStatus: 404 }; }
      lazyTimeout(o);
      return { found: true, orderState: o.state };
    },
    // DELETE /v1/signdoc/pades?sign_id=  (download + delete; destructive, one-shot)
    async downloadAndDeleteResult(signId) {
      requests.push({ op: 'delete', at: now(), signId });
      const o = orders.get(signId);
      if (!o || !live(o)) { if (o) orders.delete(signId); return { found: false, httpStatus: 404 }; }
      lazyTimeout(o);
      orders.delete(signId);
      if (o.state !== 'SIGN_COMPLETED') return { found: true, signId, orderState: o.state, signingResults: [] };
      return {
        found: true, signId, orderState: o.state,
        signingResults: [{ padesSignedPdf: o.output.toString('base64'), signedDocumentSha256: sha(o.output), unsignedDocumentSha256: sha(o.input), description: 'contract' }],
        signerInfo: o.requestSignerInfo ? o.signerInfo : undefined,
      };
    },
  };
  // ---- test controls: what the human does in the BankID UI (never part of the provider contract) ----
  const control = {
    userOpens(signId) { const o = orders.get(signId); if (!o) throw new Error('no order'); lazyTimeout(o); if (o.state === 'ORDER_RECEIVED') o.state = 'USER_SIGNING'; return o.state; },
    async userSigns(signId, person, extraClaims) {
      const o = orders.get(signId); if (!o) throw new Error('no order'); lazyTimeout(o);
      if (o.state === 'ORDER_RECEIVED') o.state = 'USER_SIGNING';
      if (o.state !== 'USER_SIGNING') return o.state;
      const iat = Math.floor(now() / 1000);
      o.signerInfo = await new SignJWT(Object.assign({ name: person.name, given_name: person.given_name, family_name: person.family_name, birthdate: person.birthdate,
        signature_quality: person.signature_quality || 'QES', cert_issuer: 'FAKE BankID Test CA' }, extraClaims || {}))
        .setProtectedHeader({ alg, kid }).setSubject(person.sub).setIssuer(issuer).setIssuedAt(iat).setNotBefore(iat).setExpirationTime(iat + 600).sign(signingKey);
      o.output = Buffer.concat([o.input, Buffer.from('\n%FAKE-PADES-SIGNATURE ' + signId + ' sub=' + person.sub + ' (BID-1 fake, not a signature)\n', 'latin1')]);
      o.signer = person.sub;
      settle(o, 'SIGN_COMPLETED');
      return o.state;
    },
    userRejects(signId) { const o = orders.get(signId); lazyTimeout(o); if (o.state === 'ORDER_RECEIVED' || o.state === 'USER_SIGNING') settle(o, 'REJECTED'); return o.state; },
    providerFails(signId) { const o = orders.get(signId); settle(o, 'FAILED'); return o.state; },
    forget(signId) { orders.delete(signId); },
    has(signId) { return orders.has(signId); },
    requests,
  };
  return { api, control };
}
