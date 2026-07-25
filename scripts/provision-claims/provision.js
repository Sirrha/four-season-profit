#!/usr/bin/env node
'use strict';

/*
 * Sormena Auth M1 - Custom-Claims Provisioning Tool
 *
 * SOURCE OF TRUTH: docs/architecture/auth-m1-provisioning.md (committed 4a3ce17, pushed).
 * This tool implements that document. Section references (SS3, SS5, ...) point at it.
 *
 * What it does: sets Firebase Auth custom claims { role, tenantId, ansattId } on the five
 * approved accounts, or restores a snapshot. It NEVER creates or deletes Auth accounts,
 * never distributes credentials, never touches Firestore data (it only READS `ansatte`),
 * and never prints secrets.
 *
 * Default mode is DRY RUN. Nothing is written without --confirm (provision) or
 * --confirm-rollback (rollback).
 *
 * Exit codes:
 *   0  success
 *   1  credential validation failed (SS3)
 *   2  usage / flag error
 *   4  preflight failed (SS5) - includes ansattId resolution (SS4) and overwrite gate
 *   5  post-write / post-rollback verification failed (SS9)
 *   6  hard rollback write-gate failed (SS7) - snapshot not durable; zero claims changed
 *   7  rollback snapshot / live-identity validation failed (SS10)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');

/* ------------------------------------------------------------------ constants */

const EXPECTED_PROJECT_ID = 'sormena-prod';
const EXPECTED_CLIENT_EMAIL = 'firebase-adminsdk-fbsvc@sormena-prod.iam.gserviceaccount.com';
const TENANT_ID = 'four-season-as';
const SCHEMA_VERSION = 1;

// SS2 Identity map: emails + roles ONLY. `navn` is the resolution key for ansattId (SS4).
// NO ansattId is hard-coded here - it is resolved at runtime by exact `ansatte.navn` match.
const IDENTITY_MAP = [
  { email: 'herishhashemi@gmail.com', navn: 'Herish Hashemi',  role: 'admin' },
  { email: 'belinbelin134@gmail.com', navn: 'Athar Abdulalim', role: 'employee' },
  { email: 'aboudalkreman@gmail.com', navn: 'Aboud Alkreman',  role: 'employee' },
  { email: 'mariasirota9@gmail.com',  navn: 'Maria Syrota',    role: 'employee' },
  { email: 'yuossefahmd202@gmail.com', navn: 'Yussef Ahmad',   role: 'employee' },
];

const ROLLBACK_DIR = path.join(os.homedir(), 'sormena-provision', 'rollback');

/* ------------------------------------------------------------------ tiny utils */

function die(code, msg) {
  console.error('\nABORT (' + code + '): ' + msg);
  process.exit(code);
}

function line() { console.log('----------------------------------------------------------'); }

// Order-independent structural equality for claim objects (SS9 comparisons).
function canonical(obj) {
  return JSON.stringify(sortKeys(obj));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
function claimsEqual(a, b) { return canonical(a || {}) === canonical(b || {}); }
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isEmptyClaims(v) { return !v || Object.keys(v).length === 0; }

function proposedClaimsFor(person, ansattId) {
  // Uniform shape for every account; admins carry ansattId too (SS2). Fully deterministic -
  // contains NO timestamp or other nondeterministic value.
  return { role: person.role, tenantId: TENANT_ID, ansattId: ansattId };
}

/* ------------------------------------------------------------------ arg parsing */

function parseArgs(argv) {
  const a = {
    confirm: false, only: null, allowOverwrite: false,
    rollback: null, confirmRollback: false,
  };
  for (const raw of argv) {
    if (raw === '--confirm') a.confirm = true;
    else if (raw === '--allow-overwrite') a.allowOverwrite = true;
    else if (raw === '--confirm-rollback') a.confirmRollback = true;
    else if (raw.startsWith('--only=')) a.only = raw.slice('--only='.length).trim().toLowerCase();
    else if (raw.startsWith('--rollback=')) a.rollback = raw.slice('--rollback='.length).trim();
    else die(2, 'unknown argument: ' + raw);
  }
  return a;
}

/* ------------------------------------------------------------------ SS3 credential validation */

function validateCredential() {
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!gac) die(1, 'GOOGLE_APPLICATION_CREDENTIALS is not set.');
  // No hard-coded key path anywhere - the credential is located ONLY via the env var above.
  if (!fs.existsSync(gac)) die(1, 'credential file does not exist at GOOGLE_APPLICATION_CREDENTIALS.');
  let raw;
  try { raw = fs.readFileSync(gac, 'utf8'); }
  catch (e) { die(1, 'credential file is not readable.'); }
  let cred;
  try { cred = JSON.parse(raw); }
  catch (e) { die(1, 'credential file is not valid JSON.'); }

  if (cred.project_id !== EXPECTED_PROJECT_ID)
    die(1, 'project_id mismatch. expected ' + EXPECTED_PROJECT_ID + ', got ' + cred.project_id + '.');
  if (cred.client_email !== EXPECTED_CLIENT_EMAIL)
    die(1, 'client_email mismatch. expected ' + EXPECTED_CLIENT_EMAIL + ', got ' + cred.client_email + '.');

  // Only ever print these two non-secret fields. NEVER print private_key or file contents.
  console.log('Credential validated:');
  console.log('  project_id  : ' + cred.project_id);
  console.log('  client_email: ' + cred.client_email);
  return cred;
}

function initAdmin(cred) {
  admin.initializeApp({ credential: admin.credential.cert(cred) });
  return { auth: admin.auth(), db: admin.firestore() };
}

/* ------------------------------------------------------------------ SS4 + SS5 preflight */

// Read ONLY navn / aktiv / id from `ansatte`. Never reads or prints personnummer, timelonn,
// bankkonto or any other field.
async function loadAnsatte(db) {
  // Tenant-scoped path: tenants/<TENANT_ID>/ansatte (mirrors index.html tenantCol()).
  // A root-level db.collection('ansatte') would read the wrong / empty location.
  const snap = await db
    .collection('tenants')
    .doc(TENANT_ID)
    .collection('ansatte')
    .get();
  return snap.docs.map(function (d) {
    return { id: d.id, navn: d.get('navn'), aktiv: d.get('aktiv') };
  });
}

// Full five-person preflight. Runs for ALL FIVE regardless of --only. Collects EVERY failure,
// returns them all so the caller can print them and abort with zero writes.
async function runPreflight(db, auth) {
  const ansatte = await loadAnsatte(db);
  const records = [];
  const failures = [];

  for (const person of IDENTITY_MAP) {
    const rec = {
      email: person.email, navn: person.navn, role: person.role,
      ansattId: null, aktiv: null, uid: null, previousClaims: null, resolved: false,
    };

    // P1 - navn resolves to exactly one ansatte doc (SS4: ambiguous/missing -> abort loudly).
    const hits = ansatte.filter(function (a) { return a.navn === person.navn; });
    if (hits.length === 0) {
      failures.push('[P1] ' + person.navn + ' (' + person.email + '): no ansatte doc matches navn.');
    } else if (hits.length > 1) {
      failures.push('[P1] ' + person.navn + ' (' + person.email + '): ' + hits.length +
        ' ansatte docs match navn (ambiguous). ids: ' + hits.map(function (h) { return h.id; }).join(', '));
    } else {
      rec.ansattId = hits[0].id;
      rec.aktiv = hits[0].aktiv;
      rec.resolved = true;
      // P2 - resolved doc must be aktiv !== false.
      if (hits[0].aktiv === false)
        failures.push('[P2] ' + person.navn + ': ansatte doc ' + hits[0].id + ' is aktiv===false.');
    }

    // P5 - Firebase Auth user must exist. P6 - read current claims.
    try {
      const u = await auth.getUserByEmail(person.email);
      rec.uid = u.uid;
      rec.previousClaims = u.customClaims || {};
    } catch (e) {
      failures.push('[P5] ' + person.email + ': no Firebase Auth user (' + (e.code || e.message) + ').');
    }

    records.push(rec);
  }

  // P3 - all five resolved ansattId unique.
  const ids = records.map(function (r) { return r.ansattId; }).filter(Boolean);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length)
    failures.push('[P3] resolved ansattId values are not unique across the five identities.');

  // P4 - all five emails unique.
  const emails = IDENTITY_MAP.map(function (p) { return p.email; });
  if (new Set(emails).size !== emails.length)
    failures.push('[P4] emails are not unique in the identity map.');

  return { records: records, failures: failures };
}

/* ------------------------------------------------------------------ SS7 snapshot write-gate */

function buildSnapshot(records) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: EXPECTED_PROJECT_ID,
    tenantId: TENANT_ID,
    createdAt: now,
    entries: records.map(function (r) {
      return {
        email: r.email,
        uid: r.uid,
        navn: r.navn,
        previousClaims: r.previousClaims || {},
        proposedClaims: proposedClaimsFor({ role: r.role }, r.ansattId),
        capturedAt: now,
      };
    }),
  };
}

// SS7 strict order. Any failure here exits 6 with ZERO claims changed (this runs before the
// first setCustomUserClaims). Returns the snapshot path once durability is proven.
function writeGateSnapshot(snapshot) {
  // step 3 - write timestamped snapshot OUTSIDE the repo.
  try { fs.mkdirSync(ROLLBACK_DIR, { recursive: true }); }
  catch (e) { die(6, 'could not create rollback dir ' + ROLLBACK_DIR + ': ' + e.message); }

  const stamp = snapshot.createdAt.replace(/[:.]/g, '-');
  const snapPath = path.join(ROLLBACK_DIR, 'claims-snapshot-' + stamp + '.json');
  const inMemStr = JSON.stringify(snapshot, null, 2);

  try { fs.writeFileSync(snapPath, inMemStr, { encoding: 'utf8' }); }
  catch (e) { die(6, 'could not write snapshot ' + snapPath + ': ' + e.message); }

  // step 4 - read it back from disk.
  let readBack;
  try { readBack = fs.readFileSync(snapPath, 'utf8'); }
  catch (e) { die(6, 'could not read snapshot back from ' + snapPath + ': ' + e.message); }

  // step 5 - canonical / structural equality (NOT byte-for-byte).
  let ok = false;
  try { ok = JSON.stringify(JSON.parse(readBack)) === JSON.stringify(snapshot); }
  catch (e) { die(6, 'snapshot read-back is not parseable JSON: ' + e.message); }
  if (!ok) die(6, 'snapshot read-back does not structurally equal the in-memory snapshot.');

  console.log('Rollback snapshot written and verified: ' + snapPath);
  return snapPath;
}

/* ------------------------------------------------------------------ SS6 + SS7 + SS9 provision mode */

async function provisionMode(args) {
  if (args.only) {
    const known = IDENTITY_MAP.some(function (p) { return p.email === args.only; });
    if (!known) die(2, '--only email is not in the approved identity map: ' + args.only);
  }

  const cred = validateCredential();
  const svc = initAdmin(cred);

  line();
  console.log('PREFLIGHT (all five, always - SS5)');
  line();
  const pf = await runPreflight(svc.db, svc.auth);

  if (pf.failures.length > 0) {
    console.log('\nPreflight FAILED. Every failure is listed below. Zero writes performed.\n');
    pf.failures.forEach(function (f) { console.log('  ' + f); });
    die(4, pf.failures.length + ' preflight failure(s).');
  }
  console.log('All six preflight checks passed for all five identities.');

  // Attach proposed claims and classify each identity.
  pf.records.forEach(function (r) {
    r.proposedClaims = proposedClaimsFor({ role: r.role }, r.ansattId);
    r.inTarget = !args.only || r.email === args.only;         // SS6: --only scopes WRITE only
    r.alreadyCorrect = claimsEqual(r.previousClaims, r.proposedClaims); // idempotent no-op
    r.needsOverwrite = r.inTarget && !r.alreadyCorrect && !isEmptyClaims(r.previousClaims);
    // SS6 untouched-account integrity: a NON-target account (only possible under --only) whose
    // existing NON-EMPTY claims differ from proposed is an unexpected authorization state.
    // Empty claims on an untouched account are acceptable (staged provisioning), NOT a mismatch.
    r.untouchedMismatch = !r.inTarget && !r.alreadyCorrect && !isEmptyClaims(r.previousClaims);
  });

  // SS6 untouched-account integrity gate. Runs after the full five-person assessment and
  // BEFORE any snapshot creation or write. It aborts UNCONDITIONALLY - --allow-overwrite
  // applies only to write targets and NEVER waives an untouched-account mismatch.
  const untouchedMismatches = pf.records.filter(function (r) { return r.untouchedMismatch; });
  if (untouchedMismatches.length > 0) {
    console.log('\nUNTOUCHED-ACCOUNT INTEGRITY VIOLATION. These non-target accounts hold non-empty');
    console.log('claims that differ from their proposed claims. Hard stop: no snapshot, no write,');
    console.log('no claim changed. --allow-overwrite does not apply to untouched accounts.');
    untouchedMismatches.forEach(function (r) {
      console.log('\n  ' + r.email);
      console.log('    current : ' + JSON.stringify(r.previousClaims));
      console.log('    proposed: ' + JSON.stringify(r.proposedClaims));
    });
    die(4, untouchedMismatches.length + ' untouched-account mismatch(es). Aborted before any snapshot or write.');
  }

  // SS5 overwrite gate: targeted accounts whose existing NON-EMPTY claims differ from proposed
  // require --allow-overwrite. Show current vs proposed side by side.
  const overwrites = pf.records.filter(function (r) { return r.needsOverwrite; });
  if (overwrites.length > 0) {
    console.log('\nThe following targeted account(s) already have non-empty claims that differ from proposed:');
    overwrites.forEach(function (r) {
      console.log('\n  ' + r.navn + ' <' + r.email + '>');
      console.log('    current : ' + JSON.stringify(r.previousClaims));
      console.log('    proposed: ' + JSON.stringify(r.proposedClaims));
    });
    if (!args.allowOverwrite)
      die(4, overwrites.length + ' account(s) would be overwritten. Re-run with --allow-overwrite to proceed.');
    console.log('\n--allow-overwrite is set: these will be overwritten.');
  }

  // Show the full plan (all five).
  line();
  console.log('PLAN (' + (args.confirm ? 'WRITE' : 'DRY RUN - no writes') + ')');
  line();
  pf.records.forEach(function (r) {
    let action;
    if (!r.inTarget) action = 'skip (not in --only target)';
    else if (r.alreadyCorrect) action = 'no-op (already equals proposed)';
    else action = args.confirm ? 'WRITE' : 'would write';
    console.log('  ' + r.navn + ' <' + r.email + '>  id=' + r.ansattId + '  role=' + r.role + '  -> ' + action);
  });

  if (!args.confirm) {
    console.log('\nDRY RUN complete. No claims changed. Re-run with --confirm to write.');
    process.exit(0);
  }

  // SS7 write-gate BEFORE any setCustomUserClaims.
  line();
  console.log('WRITE-GATE (SS7)');
  line();
  const snapshot = buildSnapshot(pf.records);
  const snapPath = writeGateSnapshot(snapshot);

  // Perform writes (only targeted, not-already-correct accounts).
  const toWrite = pf.records.filter(function (r) { return r.inTarget && !r.alreadyCorrect; });
  line();
  console.log('WRITING ' + toWrite.length + ' account(s)');
  line();
  for (const r of toWrite) {
    await svc.auth.setCustomUserClaims(r.uid, r.proposedClaims);
    r.written = true;
    console.log('  wrote ' + r.navn + ' <' + r.email + '>');
  }

  // SS9 post-write verification - ALWAYS all five.
  const verdict = await verifyAll(svc.auth, pf.records, function (r) { return !!r.written; });
  console.log('\nRollback snapshot for this run: ' + snapPath);
  process.exit(verdict ? 0 : 5);
}

// SS9 - re-read all five; WRITTEN must equal proposed, UNTOUCHED must equal captured previous.
async function verifyAll(auth, records, wasWritten) {
  line();
  console.log('POST-WRITE VERIFICATION (all five, always - SS9)');
  line();
  let allPass = true;
  for (const r of records) {
    const u = await auth.getUserByEmail(r.email);
    const stored = u.customClaims || {};
    const written = wasWritten(r);
    const expected = written ? r.proposedClaims : r.previousClaims;
    const pass = claimsEqual(stored, expected);
    if (!pass) allPass = false;
    console.log('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + (written ? 'WRITTEN  ' : 'UNTOUCHED') +
      '  ' + r.navn + ' <' + r.email + '>');
    if (!pass) {
      console.log('        stored  : ' + JSON.stringify(stored));
      console.log('        expected: ' + JSON.stringify(expected));
    }
  }
  console.log('\nOVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
  return allPass;
}

/* ------------------------------------------------------------------ SS10 rollback mode */

async function rollbackMode(args) {
  // Reject combining with provision-only flags.
  if (args.confirm || args.only || args.allowOverwrite)
    die(2, '--rollback cannot be combined with --confirm, --only, or --allow-overwrite.');

  const cred = validateCredential();

  // Load + validate the snapshot file.
  if (!path.isAbsolute(args.rollback)) die(7, '--rollback path must be absolute.');
  if (!fs.existsSync(args.rollback)) die(7, 'snapshot file does not exist: ' + args.rollback);
  let snap;
  try { snap = JSON.parse(fs.readFileSync(args.rollback, 'utf8')); }
  catch (e) { die(7, 'snapshot file is not valid JSON: ' + e.message); }

  const errs = [];
  if (snap.schemaVersion !== SCHEMA_VERSION) errs.push('schemaVersion !== ' + SCHEMA_VERSION);
  if (snap.projectId !== EXPECTED_PROJECT_ID) errs.push('projectId mismatch');
  if (snap.tenantId !== TENANT_ID) errs.push('tenantId mismatch');
  if (typeof snap.createdAt !== 'string' || isNaN(Date.parse(snap.createdAt))) errs.push('createdAt is not a valid ISO timestamp');
  if (!Array.isArray(snap.entries) || snap.entries.length !== 5) errs.push('entries must be exactly 5');

  if (Array.isArray(snap.entries)) {
    const emails = snap.entries.map(function (e) { return e.email; });
    const uids = snap.entries.map(function (e) { return e.uid; });
    if (new Set(emails).size !== emails.length) errs.push('snapshot emails are not unique');
    if (new Set(uids).size !== uids.length) errs.push('snapshot uids are not unique');
    // Emails must match the approved map EXACTLY (same set of five).
    const approved = new Set(IDENTITY_MAP.map(function (p) { return p.email; }));
    if (emails.length !== approved.size || !emails.every(function (e) { return approved.has(e); }))
      errs.push('snapshot emails do not match the approved identity map exactly');
    snap.entries.forEach(function (e) {
      if (!isPlainObject(e.previousClaims)) errs.push(e.email + ': previousClaims is not a plain object');
      if (!isPlainObject(e.proposedClaims)) errs.push(e.email + ': proposedClaims is not a plain object');
    });
  }
  if (errs.length > 0) {
    console.log('\nSnapshot validation FAILED:\n');
    errs.forEach(function (e) { console.log('  ' + e); });
    die(7, errs.length + ' snapshot validation error(s).');
  }
  console.log('Snapshot header + entries validated (' + args.rollback + ').');

  const svc = initAdmin(cred);

  // Validate LIVE: each email resolves to an Auth user AND live uid === snapshot uid.
  line();
  console.log('LIVE IDENTITY CHECK (SS10)');
  line();
  const liveErrs = [];
  for (const e of snap.entries) {
    try {
      const u = await svc.auth.getUserByEmail(e.email);
      if (u.uid !== e.uid)
        liveErrs.push(e.email + ': live uid ' + u.uid + ' !== snapshot uid ' + e.uid + ' (account deleted/recreated).');
      else console.log('  ok  ' + e.email + '  uid=' + e.uid);
    } catch (err) {
      liveErrs.push(e.email + ': no live Auth user (' + (err.code || err.message) + ').');
    }
  }
  if (liveErrs.length > 0) {
    console.log('');
    liveErrs.forEach(function (x) { console.log('  ' + x); });
    die(7, 'live identity check failed. Never restore onto a different identity.');
  }

  // Restoration plan.
  line();
  console.log('RESTORATION PLAN (' + (args.confirmRollback ? 'RESTORE' : 'DRY RUN - no writes') + ')');
  line();
  snap.entries.forEach(function (e) {
    console.log('  ' + e.navn + ' <' + e.email + '>  restore previousClaims: ' + JSON.stringify(e.previousClaims));
  });

  if (!args.confirmRollback) {
    console.log('\nDRY RUN complete. No claims changed. Re-run with --confirm-rollback to restore.');
    console.log('Note: rollback does NOT delete Auth accounts. Removing an account is a manual');
    console.log('Firebase Console action (Authentication -> delete user).');
    process.exit(0);
  }

  // Restore EXACT previousClaims (including {} where genuinely empty).
  line();
  console.log('RESTORING');
  line();
  for (const e of snap.entries) {
    await svc.auth.setCustomUserClaims(e.uid, e.previousClaims);
    console.log('  restored ' + e.navn + ' <' + e.email + '>');
  }

  // Re-read all five, PASS/FAIL + verdict.
  line();
  console.log('POST-ROLLBACK VERIFICATION (all five)');
  line();
  let allPass = true;
  for (const e of snap.entries) {
    const u = await svc.auth.getUserByEmail(e.email);
    const stored = u.customClaims || {};
    const pass = claimsEqual(stored, e.previousClaims);
    if (!pass) allPass = false;
    console.log('  [' + (pass ? 'PASS' : 'FAIL') + ']  ' + e.navn + ' <' + e.email + '>');
    if (!pass) {
      console.log('        stored  : ' + JSON.stringify(stored));
      console.log('        expected: ' + JSON.stringify(e.previousClaims));
    }
  }
  console.log('\nOVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
  console.log('\nNote: rollback does NOT delete Auth accounts. Removing an account is a manual');
  console.log('Firebase Console action (Authentication -> delete user).');
  process.exit(allPass ? 0 : 5);
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('Sormena Auth M1 provisioning tool');
  console.log('Design: docs/architecture/auth-m1-provisioning.md\n');
  if (args.rollback) await rollbackMode(args);
  else await provisionMode(args);
}

main().catch(function (e) {
  console.error('\nUNEXPECTED ERROR: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
