// run-all.mjs — runs the BID-1 node batteries (each in its own process). The emulator proof runs separately under
// `firebase emulators:exec` with firebase.signing.local.json (see test/emulator/bid1-emulator.proof.mjs).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of ['bid1-pdf.test.mjs', 'bid1-signing.test.mjs', 'bid2a-preprod.test.mjs', 'bid2b-packaging-smoke.test.mjs', 'bid2c-live-prep.test.mjs']) {
  try { const out = execFileSync(process.execPath, [path.join(HERE, f)], { encoding: 'utf8' }); console.log(out.trim().split('\n').pop()); }
  catch (e) { failed += 1; console.log((e.stdout || '').toString().trim().split('\n').filter((l) => /^FAIL|_TESTS:/.test(l)).join('\n')); }
}
process.exit(failed ? 1 : 0);
