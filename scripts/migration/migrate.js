#!/usr/bin/env node
// Sormena Phase 4 migration: four-season-as → sormena-prod (tenant-namespaced).
// Usage: node migrate.js --mode=<dry-run|subset|full|verify> [--collection=<name>]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ── Constants ─────────────────────────────────────────────
const OLD_KEY_PATH = 'C:\\Users\\gamme\\credentials\\four-season-as-key.json';
const NEW_KEY_PATH = 'C:\\Users\\gamme\\credentials\\sormena-prod-key.json';
const TENANT_ID = 'four-season-as';
const COLLECTIONS = [
  'ansatte', 'bankTransactions', 'dagsalg', 'innboks', 'leverandorer',
  'payments', 'products', 'purchases', 'sales', 'svinn', 'vakter'
];
const HIGH_RISK_COLLECTIONS = ['products', 'purchases', 'dagsalg', 'innboks'];
const META_COLLECTION = '_meta';
const REPORTS_DIR = path.join(__dirname, '..', '..', 'migration-reports');
const SAMPLE_SIZE = 10;
const PROGRESS_EVERY = 100;

// ── CLI parsing ───────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function usage() {
  console.error('Usage: node migrate.js --mode=<dry-run|subset|full|verify> [--collection=<name>]');
  console.error('  --mode=dry-run    Count source docs per collection. No writes.');
  console.error('  --mode=subset     Copy ONE collection (requires --collection=<name>).');
  console.error('  --mode=full       Copy all collections + _meta to tenant-namespaced paths.');
  console.error('  --mode=verify     Count match + sample field check on high-risk collections.');
  process.exit(2);
}

// ── Helpers ───────────────────────────────────────────────
function ts() { return new Date().toISOString(); }
function log(msg) { console.log('[' + ts() + '] ' + msg); }
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

function canonical(obj) {
  // Deterministic JSON representation: sort object keys recursively so that
  // JSON.stringify gives a comparable string regardless of original key order.
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonical);
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = canonical(obj[k]);
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function saveReport(modeName, reportObj) {
  ensureReportsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(REPORTS_DIR, `${modeName}-${stamp}.json`);
  fs.writeFileSync(filename, JSON.stringify(reportObj, null, 2), 'utf8');
  return filename;
}

function sampleArray(arr, n) {
  if (arr.length <= n) return arr.slice();
  // Fisher-Yates shuffle of indices, take first n. Pseudo-random is fine for sampling.
  const idx = arr.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).map(i => arr[i]);
}

// ── Firestore setup ───────────────────────────────────────
function loadKey(keyPath) {
  if (!fs.existsSync(keyPath)) {
    console.error('ERROR: credentials file not found at: ' + keyPath);
    console.error('Generate a service-account JSON in the Firebase Console and save it to this path.');
    process.exit(3);
  }
  try {
    return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch (e) {
    console.error('ERROR: could not parse credentials JSON at ' + keyPath + ': ' + e.message);
    process.exit(3);
  }
}

function setupFirestore() {
  const oldKey = loadKey(OLD_KEY_PATH);
  const newKey = loadKey(NEW_KEY_PATH);
  const oldApp = initializeApp({ credential: cert(oldKey) }, 'old');
  const newApp = initializeApp({ credential: cert(newKey) }, 'new');
  return {
    oldDb: getFirestore(oldApp),
    newDb: getFirestore(newApp),
    oldProjectId: oldKey.project_id,
    newProjectId: newKey.project_id
  };
}

function tenantCol(newDb, col) {
  return newDb.collection('tenants').doc(TENANT_ID).collection(col);
}

// ── Copy a single document ────────────────────────────────
async function copyDocument(oldDoc, targetCollection) {
  try {
    // Preserve doc ID exactly via .doc(id).set(data) — never .add(data).
    await targetCollection.doc(oldDoc.id).set(oldDoc.data());
    return { success: true, docId: oldDoc.id };
  } catch (e) {
    if (e.code === 7 || /permission/i.test(e.message)) {
      return { success: false, docId: oldDoc.id, error: 'permission-denied: ' + e.message };
    }
    return { success: false, docId: oldDoc.id, error: e.message };
  }
}

// ── Copy a single collection (used by subset and full) ────
async function copyCollection(oldDb, newDb, col) {
  const colStart = Date.now();
  const sourceSnap = await oldDb.collection(col).get();
  const sourceCount = sourceSnap.size;
  log(`Copying ${col} (${sourceCount} docs)...`);
  const target = tenantCol(newDb, col);
  const failed = [];
  let copied = 0;
  for (const doc of sourceSnap.docs) {
    const r = await copyDocument(doc, target);
    if (r.success) copied++;
    else failed.push({ docId: r.docId, error: r.error });
    if (copied > 0 && copied % PROGRESS_EVERY === 0) {
      log(`  ${col}: ${copied}/${sourceCount} copied...`);
    }
  }
  // Verify destination count via re-read
  const destSnap = await target.get();
  const destCount = destSnap.size;
  const match = (destCount === sourceCount) && (failed.length === 0);
  const result = {
    sourceCount,
    destinationCount: destCount,
    copied,
    skipped: 0,
    failed,
    match,
    durationMs: Date.now() - colStart
  };
  if (match) {
    log(`✓ ${col}: ${copied} copied (verified ${destCount} in destination, ${result.durationMs}ms)`);
  } else {
    log(`✗ ${col}: ${copied} copied, ${failed.length} failed, dest=${destCount} (MISMATCH)`);
  }
  return result;
}

// ── Mode 1: dry-run ───────────────────────────────────────
async function runDryRun(oldDb) {
  log('=== DRY RUN — counting source docs, no writes ===');
  const startMs = Date.now();
  const report = {
    mode: 'dry-run',
    startTime: ts(),
    sourceProject: 'four-season-as',
    destinationProject: 'sormena-prod',
    tenantId: TENANT_ID,
    collections: {},
    _meta: {}
  };
  let totalDocs = 0;
  for (const col of COLLECTIONS) {
    const snap = await oldDb.collection(col).get();
    const n = snap.size;
    report.collections[col] = { sourceCount: n };
    totalDocs += n;
    log(`  ${col}: ${n}`);
  }
  const metaSnap = await oldDb.collection(META_COLLECTION).get();
  report._meta = {
    sourcePath: `${META_COLLECTION}/<docs>`,
    destinationPath: `tenants/${TENANT_ID}/${META_COLLECTION}/<docs>`,
    sourceCount: metaSnap.size
  };
  totalDocs += metaSnap.size;
  log(`  _meta: ${metaSnap.size}`);
  log(`TOTAL: ${totalDocs} documents`);
  report.endTime = ts();
  report.durationMs = Date.now() - startMs;
  report.totals = { totalDocs };
  report.verdict = 'INFO';
  return report;
}

// ── Mode 2: subset ────────────────────────────────────────
async function runSubset(oldDb, newDb, col) {
  if (!COLLECTIONS.includes(col) && col !== META_COLLECTION) {
    console.error('ERROR: unknown collection: ' + col);
    console.error('Valid: ' + COLLECTIONS.concat([META_COLLECTION]).join(', '));
    process.exit(4);
  }
  log(`=== SUBSET — copying single collection: ${col} ===`);
  const startMs = Date.now();
  const report = {
    mode: 'subset',
    startTime: ts(),
    sourceProject: 'four-season-as',
    destinationProject: 'sormena-prod',
    tenantId: TENANT_ID,
    collections: {},
    _meta: null
  };
  const result = await copyCollection(oldDb, newDb, col);
  report.collections[col] = result;
  report.totals = {
    totalDocs: result.sourceCount,
    totalCopied: result.copied,
    totalSkipped: 0,
    totalFailed: result.failed.length,
    allMatched: result.match
  };
  report.endTime = ts();
  report.durationMs = Date.now() - startMs;
  report.verdict = result.match ? 'PASS' : 'FAIL';
  return report;
}

// ── Mode 3: full ──────────────────────────────────────────
async function runFull(oldDb, newDb) {
  log('=== FULL — copying all 11 collections + _meta ===');
  const startMs = Date.now();
  const report = {
    mode: 'full',
    startTime: ts(),
    sourceProject: 'four-season-as',
    destinationProject: 'sormena-prod',
    tenantId: TENANT_ID,
    collections: {},
    _meta: {}
  };
  let totalDocs = 0, totalCopied = 0, totalFailed = 0;
  let allMatched = true;
  for (const col of COLLECTIONS) {
    const r = await copyCollection(oldDb, newDb, col);
    report.collections[col] = r;
    totalDocs += r.sourceCount;
    totalCopied += r.copied;
    totalFailed += r.failed.length;
    if (!r.match) {
      log(`STOP: ${col} mismatch — aborting before next collection. Partial report will be saved.`);
      report.endTime = ts();
      report.durationMs = Date.now() - startMs;
      report.totals = { totalDocs, totalCopied, totalSkipped: 0, totalFailed, allMatched: false };
      report.verdict = 'FAIL';
      return report;
    }
  }
  // _meta — explicit handling per Phase 1 Q1 lock.
  // Source: oldDb root collection '_meta'. Destination: tenants/four-season-as/_meta.
  log(`Copying _meta...`);
  const metaStart = Date.now();
  const metaSnap = await oldDb.collection(META_COLLECTION).get();
  const metaTarget = tenantCol(newDb, META_COLLECTION);
  const metaFailed = [];
  let metaCopied = 0;
  for (const doc of metaSnap.docs) {
    try {
      await metaTarget.doc(doc.id).set(doc.data());
      metaCopied++;
      log(`  _meta/${doc.id}: copied`);
    } catch (e) {
      metaFailed.push({ docId: doc.id, error: e.message });
      log(`  _meta/${doc.id}: FAILED — ${e.message}`);
    }
  }
  const metaDestSnap = await metaTarget.get();
  const metaMatch = (metaDestSnap.size === metaSnap.size) && (metaFailed.length === 0);
  report._meta = {
    sourcePath: `${META_COLLECTION}/<docs>`,
    destinationPath: `tenants/${TENANT_ID}/${META_COLLECTION}/<docs>`,
    sourceCount: metaSnap.size,
    destinationCount: metaDestSnap.size,
    copied: metaCopied,
    failed: metaFailed,
    match: metaMatch,
    durationMs: Date.now() - metaStart
  };
  totalDocs += metaSnap.size;
  totalCopied += metaCopied;
  totalFailed += metaFailed.length;
  if (!metaMatch) allMatched = false;
  report.endTime = ts();
  report.durationMs = Date.now() - startMs;
  report.totals = { totalDocs, totalCopied, totalSkipped: 0, totalFailed, allMatched };
  report.verdict = allMatched ? 'PASS' : 'FAIL';
  log(`=== FULL done — ${totalCopied}/${totalDocs} copied in ${report.durationMs}ms — verdict: ${report.verdict} ===`);
  return report;
}

// ── Mode 4: verify ────────────────────────────────────────
async function runVerify(oldDb, newDb) {
  log('=== VERIFY — count match + sample field check ===');
  const startMs = Date.now();
  const report = {
    mode: 'verify',
    startTime: ts(),
    sourceProject: 'four-season-as',
    destinationProject: 'sormena-prod',
    tenantId: TENANT_ID,
    collections: {},
    _meta: {},
    sampleVerifications: {}
  };
  let allCountsMatch = true;
  const sampleMismatches = [];

  // Count check for all 11 collections.
  for (const col of COLLECTIONS) {
    const oldSnap = await oldDb.collection(col).get();
    const newSnap = await tenantCol(newDb, col).get();
    const match = oldSnap.size === newSnap.size;
    if (!match) allCountsMatch = false;
    report.collections[col] = {
      sourceCount: oldSnap.size,
      destinationCount: newSnap.size,
      match
    };
    log(`  ${col}: source=${oldSnap.size}, dest=${newSnap.size} — ${match ? '✓' : '✗'}`);
  }

  // _meta count check.
  const metaOldSnap = await oldDb.collection(META_COLLECTION).get();
  const metaNewSnap = await tenantCol(newDb, META_COLLECTION).get();
  const metaMatch = metaOldSnap.size === metaNewSnap.size;
  if (!metaMatch) allCountsMatch = false;
  report._meta = {
    sourcePath: `${META_COLLECTION}/<docs>`,
    destinationPath: `tenants/${TENANT_ID}/${META_COLLECTION}/<docs>`,
    sourceCount: metaOldSnap.size,
    destinationCount: metaNewSnap.size,
    match: metaMatch
  };
  log(`  _meta: source=${metaOldSnap.size}, dest=${metaNewSnap.size} — ${metaMatch ? '✓' : '✗'}`);

  // Sample field verification for high-risk collections.
  for (const col of HIGH_RISK_COLLECTIONS) {
    const oldSnap = await oldDb.collection(col).get();
    const samples = sampleArray(oldSnap.docs, SAMPLE_SIZE);
    const sampleResults = [];
    log(`  Sampling ${samples.length} docs from ${col}...`);
    for (const oldDoc of samples) {
      const newDocSnap = await tenantCol(newDb, col).doc(oldDoc.id).get();
      if (!newDocSnap.exists) {
        sampleMismatches.push({
          collection: col, docId: oldDoc.id, field: '<entire doc>',
          sourceValue: '<present>', destValue: '<MISSING>'
        });
        sampleResults.push({ docId: oldDoc.id, match: false, reason: 'destination doc missing' });
        continue;
      }
      const oldData = oldDoc.data();
      const newData = newDocSnap.data();
      let docMatch = true;
      let reason = null;
      if (col === 'innboks') {
        // Compare MD5 hash of base64 data field — never print the data itself.
        const oldHash = oldData.data ? md5(oldData.data) : null;
        const newHash = newData.data ? md5(newData.data) : null;
        if (oldHash !== newHash) {
          docMatch = false;
          reason = `innboks data hash mismatch`;
          sampleMismatches.push({
            collection: col, docId: oldDoc.id, field: 'data (md5)',
            sourceValue: oldHash, destValue: newHash
          });
        }
        // Compare non-blob fields too.
        const cmpOld = { ...oldData }; delete cmpOld.data;
        const cmpNew = { ...newData }; delete cmpNew.data;
        if (!deepEqual(cmpOld, cmpNew)) {
          docMatch = false;
          reason = (reason ? reason + '; ' : '') + 'non-data fields differ';
          sampleMismatches.push({
            collection: col, docId: oldDoc.id, field: '<non-data fields>',
            sourceValue: cmpOld, destValue: cmpNew
          });
        }
      } else {
        if (!deepEqual(oldData, newData)) {
          docMatch = false;
          reason = 'document fields differ';
          // Report the specific differing top-level fields.
          const allKeys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
          for (const k of allKeys) {
            if (!deepEqual(oldData[k], newData[k])) {
              sampleMismatches.push({
                collection: col, docId: oldDoc.id, field: k,
                sourceValue: oldData[k], destValue: newData[k]
              });
            }
          }
        }
      }
      sampleResults.push({ docId: oldDoc.id, match: docMatch, reason });
    }
    const matchedCount = sampleResults.filter(r => r.match).length;
    report.sampleVerifications[col] = {
      sampled: samples.length,
      matched: matchedCount,
      mismatched: samples.length - matchedCount,
      details: sampleResults
    };
    log(`    ${col}: ${matchedCount}/${samples.length} samples match`);
  }

  report.endTime = ts();
  report.durationMs = Date.now() - startMs;
  report.totals = {
    allCountsMatch,
    sampleMismatchCount: sampleMismatches.length,
    sampleMismatches
  };
  report.verdict = (allCountsMatch && sampleMismatches.length === 0) ? 'PASS' : 'FAIL';
  log(`=== VERIFY done — verdict: ${report.verdict} ===`);
  return report;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (!args.mode) usage();
  const mode = args.mode;
  if (!['dry-run', 'subset', 'full', 'verify'].includes(mode)) usage();
  if (mode === 'subset' && !args.collection) {
    console.error('ERROR: --mode=subset requires --collection=<name>');
    usage();
  }

  log(`Sormena migration script — mode=${mode}`);
  const { oldDb, newDb, oldProjectId, newProjectId } = setupFirestore();
  log(`Source project: ${oldProjectId}`);
  log(`Destination project: ${newProjectId}`);
  log(`Tenant ID: ${TENANT_ID}`);

  let report;
  try {
    if (mode === 'dry-run')      report = await runDryRun(oldDb);
    else if (mode === 'subset')  report = await runSubset(oldDb, newDb, args.collection);
    else if (mode === 'full')    report = await runFull(oldDb, newDb);
    else if (mode === 'verify')  report = await runVerify(oldDb, newDb);
  } catch (e) {
    log(`UNHANDLED ERROR: ${e.message}`);
    console.error(e.stack);
    const partial = report || {
      mode, startTime: ts(),
      sourceProject: 'four-season-as', destinationProject: 'sormena-prod', tenantId: TENANT_ID,
      error: e.message, stack: e.stack
    };
    partial.endTime = ts();
    partial.verdict = 'FAIL';
    const fn = saveReport(mode + '-error', partial);
    log(`Partial report saved: ${fn}`);
    process.exit(1);
  }

  const fn = saveReport(mode, report);
  log(`Report saved: ${fn}`);
  if (report.verdict === 'FAIL') {
    log('VERDICT: FAIL — see report for details');
    process.exit(1);
  }
  log(`VERDICT: ${report.verdict}`);
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
