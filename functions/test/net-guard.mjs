// net-guard.mjs — P13: every outbound network attempt that is not loopback is BLOCKED and recorded.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';

export const blocked = [];
const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i;
const hostOf = (a) => {
  if (typeof a === 'string') { try { return new URL(a).hostname; } catch (e) { return a; } }
  if (a instanceof URL) return a.hostname;
  if (a && typeof a === 'object') return a.hostname || a.host || null;
  return null;
};
function guard(name, orig) {
  return function (...args) {
    const h = hostOf(args[0]);
    if (h && !LOOPBACK.test(String(h).replace(/:\d+$/, ''))) { blocked.push({ via: name, host: h }); throw new Error('NETWORK_BLOCKED_IN_BID1: ' + h); }
    return orig.apply(this, args);
  };
}
export function installNetGuard() {
  if (globalThis.__bid1NetGuard) return;
  globalThis.__bid1NetGuard = true;
  const f = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const h = hostOf(typeof input === 'string' || input instanceof URL ? input : input && input.url);
    if (h && !LOOPBACK.test(h)) { blocked.push({ via: 'fetch', host: h }); throw new Error('NETWORK_BLOCKED_IN_BID1: ' + h); }
    return f(input, init);
  };
  for (const [mod, name] of [[http, 'http'], [https, 'https']]) { mod.request = guard(name + '.request', mod.request); mod.get = guard(name + '.get', mod.get); }
  const c = net.connect; net.connect = guard('net.connect', c); net.createConnection = net.connect;
  tls.connect = guard('tls.connect', tls.connect);
  http2.connect = guard('http2.connect', http2.connect);   // gRPC (Firestore Admin SDK) path
}
