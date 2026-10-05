// employee-identity-polish.test.mjs — employee-facing identity presentation (first real-employee pilot corrections).
// Node built-ins only; source-level guards in the style of employee-page-qa.test.mjs. The rendered result (name present,
// fallback, labels on I dag / Plan / Min ansettelse, no management route) is proven in the scratch headless harness
// (ei-proofs.mjs) against the Auth + Firestore emulators.
// Run: node employee-identity-polish.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TENANT_LABELS, EMPLOYEE_NAME_FALLBACK } from './employee-shell-ui.mjs';
import { EMPLOYEE_SELF_FIELDS, EMPLOYEE_SELF_DOC_FIELDS, EMPLOYEE_SELF_FORBIDDEN, employeeSelfToShellEmployee, projectEmployeeSelf, validateEmployeeSelfDoc } from './employee-self-projection.mjs';

let passed = 0, failed = 0; const lines = [];
function t(id, name, fn) { try { fn(); passed++; lines.push('PASS  ' + id + '  ' + name); } catch (e) { failed++; lines.push('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message ? e.message : e)); } }
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = read('./employee-shell-ui.mjs');
const html = read('./index.html');
const adapters = read('./employee-production-adapters.mjs');
const bridge = read('./employee-production-bridge.mjs');
const code = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const SHOP = '4Seasons ferske varer';

t('EI01', 'the production tenant id has a DISPLAY label: TENANT_LABELS maps four-season-as -> "4Seasons ferske varer"; tenantLabel() is the only way the shell prints a tenant, and it falls back to the raw id only for an unmapped tenant', () => {
  assert.equal(TENANT_LABELS['four-season-as'], SHOP);
  assert.ok(shell.includes("function tenantLabel(t) { return Object.prototype.hasOwnProperty.call(TENANT_LABELS, t) ? TENANT_LABELS[t] : t; }"));
  // every place the shell renders a tenant in text goes through tenantLabel(); the raw membership.tenantId is never concatenated into text
  const raw = code(shell).split('\n').filter((l) => /(text:|textContent\s*=|createTextNode\()/.test(l) && /\.tenantId\b/.test(l) && !/tenantLabel\(/.test(l));
  assert.deepEqual(raw, []);
});
t('EI02', 'display only: the tenant id itself is untouched — paths, membership checks and the host tenant constant still use four-season-as; the label string appears in no path / query / membership expression', () => {
  assert.ok(/const TENANT_ID\s*=\s*['"]four-season-as['"]/.test(html), 'host tenant constant unchanged');
  for (const src of [adapters, bridge]) assert.ok(!src.includes(SHOP) && !/TENANT_LABELS|tenantLabel/.test(src), 'adapters / bridge never see the display label');
  const uses = code(shell).split('\n').filter((l) => l.includes('TENANT_LABELS'));
  assert.equal(uses.length, 2, 'declared once, read once (tenantLabel)');
  assert.ok(!/s4Path\([^)]*tenantLabel|doc\([^)]*tenantLabel|where\([^)]*tenantLabel/.test(shell));
});
t('EI03', 'top dark employee bar reads "4Seasons ferske varer · ansatt" (markup and the reset on leaving Workforce); the old "Four Season AS · ansatt" text is gone; the management workspace label is unchanged', () => {
  assert.ok(html.includes('<span id="emp-host-label">' + SHOP + ' · ansatt</span>'));
  assert.ok(html.includes("if(lab)lab.textContent='" + SHOP + " · ansatt';"));
  assert.ok(!html.includes('Four Season AS · ansatt'));
  assert.ok(html.includes("if(lab)lab.textContent='Four Season AS · Ledelse';"), 'management label not touched');
  assert.ok(html.includes('<button type="button" class="emp-hostbtn" onclick="logoutUser()">Logg ut</button>'), 'Logg ut stays in the bar');
});
t('EI04', 'main employee header: Sormena on the left, the identity chip on the right shows the employee\'s OWN name; the name comes from personFor() = the employee store, which in production holds only the own employeeSelf projection', () => {
  const head = html.slice(html.indexOf('<header class="top">'), html.indexOf('</header>', html.indexOf('<header class="top">')));
  assert.ok(head.indexOf('Sormena</div>') > 0 && head.indexOf('id="emp-identity"') > head.indexOf('Sormena</div>'));
  assert.ok(shell.includes("const shown = person && typeof person.name === 'string' && person.name.trim() ? person.name.trim() : EMPLOYEE_NAME_FALLBACK;"));
  assert.ok(shell.includes('if (nm) nm.textContent = shown;') && shell.includes('if (av) av.textContent = shown.charAt(0).toUpperCase();'));
  assert.ok(shell.includes("const e = ADAPTERS ? employeeOf(employeeStore(), membership.tenantId, membership.ansattId) : null;"));
  assert.ok(shell.includes("return MODE === 'preview' ? (FOUR_SEASON_PEOPLE.find((p) => p.ansattId === membership.ansattId) || null) : null;"), 'fixture people only in preview');
  // production employee store = ONE own document listener
  assert.ok(adapters.includes("listen({ doc: s4Path(T, 'employeeSelf', MY) }, (docs) => {"));
  assert.ok(adapters.includes('const emp = employeeSelfToShellEmployee(MY, d.data);'));
  const emp = employeeSelfToShellEmployee('ansatt-x', { name: 'Test Ansatt 01', role: null, employmentType: null, percentage: null, workplace: null, startDate: null, expectedWeeklyHours: null, hasContract: false, derivedAt: null, sourceRevision: 1 });
  assert.equal(emp.name, 'Test Ansatt 01');
});
t('EI05', 'the "?" is gone: it was the identity chip\'s placeholder for a missing name, not a help control (no click behaviour in production); a missing / blank own projection now shows the neutral "Ansatt" with initial "A" — never "?", an empty name, the tenant id, the uid or the e-mail', () => {
  assert.equal(EMPLOYEE_NAME_FALLBACK, 'Ansatt');
  const chrome = shell.slice(shell.indexOf('  function setChrome(membership, view) {'), shell.indexOf('  function greetingFor(nowMs) {'));
  assert.ok(!chrome.includes("'?'") && !chrome.includes("''"), 'no "?" / empty-name branch left in the identity chip');
  assert.ok(chrome.includes("idb.onclick = MODE === 'preview' ? goChooser : null;"), 'production: the chip has no action');
  assert.ok(!/\.uid|\.email|tenantId/.test(chrome.replace('personFor(membership)', '')), 'the chip never reads uid / e-mail / tenant id');
  assert.ok(!/id="[^"]*help|class="[^"]*help|>\?<\/button>/.test(html.slice(html.indexOf('<div id="employee-host">'), html.indexOf('<main class="wrap"><div id="emp-root">'))), 'no separate help control exists in the employee header');
});
t('EI06', 'no e-mail / uid as an employee display identity in the host either: an EMPLOYEE identity no longer triggers the ansatte name lookup at sign-in (its in-memory name is the neutral "Ansatt"); the admin path keeps its lookup unchanged', () => {
  assert.ok(html.includes("const name=chosen.accessRole==='admin'?await authResolveDisplayName(user,chosen.ansattId):'Ansatt';"));
  assert.equal(html.split('authResolveDisplayName(').length - 1, 2, 'one definition + one (admin-only) call');
  assert.equal(html.split("tenantCol('ansatte').doc(String(ansattId||'')).get()").length - 1, 1, 'the single-document name lookup exists only inside authResolveDisplayName');
});
t('EI07', 'no full-ansatte read and no management listener for an employee: the employee adapters and bridge never name ansatte / vakter / payroll / contractProfile; the employee surface still starts exactly its four own-scoped listeners; the 17 management listeners stay behind the admin-only guard', () => {
  for (const src of [code(adapters).slice(code(adapters).indexOf('export function createProductionAdapters'), code(adapters).indexOf('export function createManagementScheduleAdapters')), code(bridge)])
    assert.ok(!/ansatte|vakter|payroll|contractProfile/.test(src));
  const emp = adapters.slice(adapters.indexOf('export function createProductionAdapters'), adapters.indexOf('export function createManagementScheduleAdapters'));
  assert.equal((emp.match(/^\s+listen\(\{/gm) || []).length, 4, 'four listeners');
  assert.ok(html.includes("if(currentUser.role!=='admin')return null;          // S4 host: the management door is admin-only; an employee identity never starts the 17 listeners"));
  assert.equal(html.split('startListeners();').length - 1, 1, 'one guarded caller');
  assert.ok(html.includes("if(role==='employee'){") && html.includes('authEnterEmployeeSurface(gen,authMembership);'));
});
t('EI08', 'ordinary employee has no Workforce and no management-return route: the Workforce footer entry and "Tilbake til Sormena" are shown only for an admin; opening the workspace and returning to management both require the admin role', () => {
  assert.ok(html.includes("if(wf)wf.style.display=admin&&ACTIVE_SURFACE==='management'?'':'none';"));
  assert.ok(html.includes("if(back)back.style.display=admin&&ACTIVE_SURFACE==='employee'?'':'none';"));
  assert.ok(html.includes("if(!currentUser||currentUser.role!=='admin'||ACTIVE_SURFACE!=='management'||ldHost)return null;"));
  assert.ok(html.includes('id="emp-host-back" style="display:none"') && html.includes('id="navWorkforceBtn" data-door="workforce" style="display:none"'));
});
t('EI09', 'employee page behaviour intact: navigation is still I dag / Plan / Jobb & økonomi; Plan passes the display label to the schedule view (Uke/Måned) and Ledige vakter; Min ansettelse subtitle uses the same label; employeeSelf projection shape is unchanged (eight display fields + two audit fields, none sensitive)', () => {
  for (const s of ['<button type="button" data-nav="today">I dag</button>', '<button type="button" data-nav="plan">Plan</button>', '<button type="button" data-nav="work">Jobb &amp; økonomi</button>']) assert.ok(html.includes(s), s);
  assert.ok(shell.includes('membership, tenantLabel: tenantLabel(membership.tenantId), shifts,'));
  assert.ok(shell.includes("row.appendChild(el('div', { cls: 'm', text: tenantLabel(membership.tenantId) }));"));
  assert.ok(shell.includes("wrap.appendChild(el('div', { text: (e ? e.name + ' · ' : '') + tenantLabel(membership.tenantId), style: 'color:#5f6b62;font-size:14px;margin-bottom:10px' }));"));
  assert.deepEqual([...EMPLOYEE_SELF_FIELDS], ['name', 'role', 'employmentType', 'percentage', 'workplace', 'startDate', 'expectedWeeklyHours', 'hasContract']);
  assert.deepEqual([...EMPLOYEE_SELF_DOC_FIELDS], ['name', 'role', 'employmentType', 'percentage', 'workplace', 'startDate', 'expectedWeeklyHours', 'hasContract', 'derivedAt', 'sourceRevision']);
  for (const k of ['personnummer', 'bankkonto', 'timelonn', 'email', 'phone', 'notes', 'address']) assert.ok(EMPLOYEE_SELF_FORBIDDEN.includes(k), k);
  assert.equal(typeof projectEmployeeSelf, 'function'); assert.equal(typeof validateEmployeeSelfDoc, 'function');
});
t('EI10', 'top bar layout (presentation only): the bar content is aligned with the centered page column (same 16px inset, max width --wrap) instead of the window edge; the label never wraps or shrinks; on screens too narrow for label + buttons the buttons move to a second row, right-aligned; the Workforce-workspace override of the bar is unchanged', () => {
  assert.ok(html.includes(".emp-hostbar{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;align-items:center;padding:6px max(16px,calc((100% - var(--wrap,1120px))/2 + 16px));background:#1b2b20;color:#fff;font-size:12px;"));
  assert.ok(html.includes('.emp-hostbar .sp{flex:1}#emp-host-label{white-space:nowrap}'));
  assert.ok(html.includes('body.wf-open .emp-hostbar{background:transparent;color:var(--warn);padding:8px 16px 0;min-height:0;font-family:inherit;justify-content:flex-end;max-width:var(--wrap);margin:0 auto}'), 'workspace override untouched');
  assert.ok(read('./employee-shell.css').includes('--wrap:1120px;'), 'the column width the fallback mirrors');
  assert.ok(html.includes('<div class="emp-hostbar"><span id="emp-host-label">4Seasons ferske varer · ansatt</span><span class="sp"></span>'), 'markup order unchanged: label, spacer, notice, buttons');
});

for (const l of lines) console.log(l);
console.log('EMPLOYEE_IDENTITY_POLISH_TESTS: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
