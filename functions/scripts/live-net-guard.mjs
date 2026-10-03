// live-net-guard.mjs — BID-2C NETWORK BOUNDARY for the LOCAL live smoke process ONLY (the test suites keep the zero-
// non-loopback guard in test/net-guard.mjs). Allowlist, not blocklist: exactly the Google endpoints the installed
// libraries need for an impersonated-ADC Firestore + Cloud Storage session, all on TLS/443:
//   oauth2.googleapis.com          google-auth-library 11.1.0  UserRefreshClient -> /token (refresh of the source user credential)
//   iamcredentials.googleapis.com  google-auth-library 11.1.0  Impersonated -> :generateAccessToken (runtime SA token)
//   firestore.googleapis.com       @google-cloud/firestore 9.3.0 / @grpc/grpc-js 1.14.5 (gRPC over HTTP/2)
//   storage.googleapis.com         @google-cloud/storage 8.2.0 (JSON API + uploads)
// Everything else is refused before a socket opens: IP literals (incl. the metadata server 169.254.169.254),
// metadata.google.internal, loopback (live never talks to an emulator), plain http, non-443 ports, BankID hosts and any
// other internet host. Every attempt is recorded by host name only (no URLs, no headers) for the evidence file.
// ONE exception to "no IP literal" (EXEC-015 defect: grpc-js resolves firestore.googleapis.com itself via
// dns.promises.lookup and then net.connect()s to the RESOLVED IP): an IP is connectable at the socket layers
// (net.connect / tls.connect) only if THIS process learned it from a guarded DNS lookup of an allowlisted hostname AND
// the port is exactly 443 AND it is a public address. Loopback / link-local (metadata) / private addresses are never
// learned and never connectable, whatever DNS answers. URL layers (fetch / http / https / http2) still refuse every IP.
// Layers: global fetch, http/https.request+get, net.connect/createConnection, tls.connect, http2.connect, dns.lookup.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import dns from 'node:dns';

export const LIVE_ALLOWED_HOSTS = Object.freeze(['oauth2.googleapis.com', 'iamcredentials.googleapis.com', 'firestore.googleapis.com', 'storage.googleapis.com']);
export const LIVE_ALLOWED_PORT = 443;
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f:]*:[0-9a-f:]*\]?)$/i;

const normIp = (h) => String(h == null ? '' : h).trim().toLowerCase().replace(/^\[|\]$/g, '');
// Loopback, unspecified, link-local (169.254.0.0/16 = metadata server), RFC1918 / CGNAT / unique-local, v4-mapped forms.
export function isNeverAllowedIp(host) {
  let ip = normIp(host);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip); if (mapped) ip = mapped[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 127 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return ip === '' || ip === '::' || ip === '::1' || /^fe[89ab]/.test(ip) || /^f[cd]/.test(ip) || ip.startsWith('::ffff:');
}

export function isAllowedLiveHost(host, port, protocol) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || IP_LITERAL.test(h)) return false;
  if (!LIVE_ALLOWED_HOSTS.includes(h)) return false;
  if (protocol && protocol !== 'https:') return false;
  const p = port == null || port === '' ? LIVE_ALLOWED_PORT : Number(port);
  return p === LIVE_ALLOWED_PORT;
}

const targetOf = (a, b) => {
  // (url | options | host, [options|port])
  if (typeof a === 'string' || a instanceof URL) { try { const u = new URL(String(a)); return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : ''), protocol: u.protocol }; } catch (e) { return { host: a, port: typeof b === 'number' ? b : (b && b.port), protocol: null }; } }
  if (a && typeof a === 'object') return { host: a.hostname || a.host || null, port: a.port, protocol: a.protocol || null };
  if (typeof a === 'number') return { host: b && typeof b === 'string' ? b : (b && b.host) || null, port: a, protocol: null };
  return { host: null, port: null, protocol: null };
};

let installed = null;
export function installLiveNetGuard() {
  if (installed) return installed;
  const attempts = {}; const blocked = []; const resolved = {};   // resolved: ip -> allowlisted hostname it was learned from (this process only)
  const learn = (hostname, res) => { for (const x of Array.isArray(res) ? res : [res]) { const ip = normIp(x && typeof x === 'object' ? x.address : x); if (ip && IP_LITERAL.test(ip) && !isNeverAllowedIp(ip)) resolved[ip] = String(hostname).toLowerCase(); } };
  const isLearnedIp = (via, t) => { const ip = normIp(t.host); return (via === 'net.connect' || via === 'tls.connect') && IP_LITERAL.test(ip) && !isNeverAllowedIp(ip) && Object.prototype.hasOwnProperty.call(resolved, ip) && t.port != null && t.port !== '' && Number(t.port) === LIVE_ALLOWED_PORT; };
  const note = (host, ok, via) => { const k = String(host || '?').toLowerCase(); attempts[k] = attempts[k] || { allowed: 0, blocked: 0 }; attempts[k][ok ? 'allowed' : 'blocked'] += 1; if (!ok) blocked.push({ host: k, via }); };
  const decide = (via, t) => { const ok = isAllowedLiveHost(t.host, t.port, t.protocol) || isLearnedIp(via, t); note(t.host, ok, via); if (!ok) throw Object.assign(new Error('NETWORK_REFUSED_BY_LIVE_ALLOWLIST: ' + String(t.host)), { code: 'NETWORK_REFUSED_BY_LIVE_ALLOWLIST', host: String(t.host) }); };
  const wrap = (mod, name, via) => { const orig = mod[name]; mod[name] = function (...args) { decide(via, targetOf(args[0], args[1])); return orig.apply(this, args); }; };
  const f = globalThis.fetch;
  globalThis.fetch = async (input, init) => { decide('fetch', targetOf(typeof input === 'string' || input instanceof URL ? input : input && input.url)); return f(input, init); };
  wrap(http, 'request', 'http.request'); wrap(http, 'get', 'http.get');       // plain http to an allowed host is refused by protocol (see isAllowedLiveHost)
  wrap(https, 'request', 'https.request'); wrap(https, 'get', 'https.get');
  wrap(net, 'connect', 'net.connect'); net.createConnection = net.connect;
  wrap(tls, 'connect', 'tls.connect');
  wrap(http2, 'connect', 'http2.connect');
  const lookup = dns.lookup;
  dns.lookup = function (hostname, ...rest) {
    const ok = isAllowedLiveHost(hostname, LIVE_ALLOWED_PORT, null); note(hostname, ok, 'dns.lookup');
    if (!ok) { const cb = rest[rest.length - 1]; const err = Object.assign(new Error('NETWORK_REFUSED_BY_LIVE_ALLOWLIST: ' + hostname), { code: 'NETWORK_REFUSED_BY_LIVE_ALLOWLIST', host: hostname }); if (typeof cb === 'function') { process.nextTick(() => cb(err)); return; } throw err; }
    const cb = rest[rest.length - 1];
    if (typeof cb === 'function') rest[rest.length - 1] = function (err, address) { if (!err) learn(hostname, address); return cb.apply(this, arguments); };
    return lookup.call(this, hostname, ...rest);
  };
  const plookup = dns.promises.lookup;
  dns.promises.lookup = async function (hostname, ...rest) { const ok = isAllowedLiveHost(hostname, LIVE_ALLOWED_PORT, null); note(hostname, ok, 'dns.promises.lookup'); if (!ok) throw Object.assign(new Error('NETWORK_REFUSED_BY_LIVE_ALLOWLIST: ' + hostname), { code: 'NETWORK_REFUSED_BY_LIVE_ALLOWLIST', host: hostname }); const r = await plookup.call(this, hostname, ...rest); learn(hostname, r); return r; };
  installed = { allowlist: [...LIVE_ALLOWED_HOSTS], port: LIVE_ALLOWED_PORT, attempts, blocked, resolved };
  return installed;
}
