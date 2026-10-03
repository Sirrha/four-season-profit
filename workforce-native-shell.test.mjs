// WORKFORCE NATIVE SHELL + PRINTABLE CONTRACT (release 018) — static proof over the host page.
// The management workspace renders between the real Sormena header and bottom nav; every new style is scoped to
// body.wf-open (set ONLY while the management workspace is open), so Min ansattside and employee-shell.css are untouched.
// Browser-level proof (layout, listeners, real print engine) lives in the scratch harness (ns-proofs.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function t(id, name, fn) { try { fn(); passed++; console.log('PASS  ' + id + '  ' + name); } catch (e) { failed++; console.log('FAIL  ' + id + '  ' + name + '  ::  ' + (e && e.message)); } }
const fnBody = (name) => { const i = html.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0, j = html.indexOf('{', i); const s = j; for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}') { d--; if (d === 0) break; } } return html.slice(s, j + 1); };
const cssStart = html.indexOf('/* ── WORKFORCE NATIVE SHELL (release 018)');
const cssEnd = html.indexOf('.ld-logo{', cssStart);
const css = html.slice(cssStart, cssEnd);
const printAt = css.indexOf('@media print{');
const screenCss = css.slice(0, printAt), printCss = css.slice(printAt);

t('WN01', 'footer entry unchanged: ONE #navWorkforceBtn "Workforce" in the former Timeliste slot -> authOpenLedelse(); no Timeliste / Ansatte / Ledelse footer item; Workforce is not under Mer', () => {
  const nav = html.slice(html.indexOf('<nav class="bnav">'), html.indexOf('</nav>', html.indexOf('<nav class="bnav">')));
  const labels = [...nav.matchAll(/<span class="nl">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Oversikt', 'Produkter', 'Innboks', 'Innkjøp', 'Salg', 'Økonomi', 'Workforce', 'Rapporter', 'Mer']);
  assert.equal(nav.split('id="navWorkforceBtn"').length - 1, 1);
  assert.ok(/id="navWorkforceBtn" data-door="workforce" style="display:none" onclick="authOpenLedelse\(\)"/.test(nav));
  assert.ok(!/data-pg="timeliste"/.test(nav));
  const mer = html.slice(html.indexOf('<div class="ov" id="ov-mer">'), html.indexOf('<!-- Ny utgift'));
  assert.ok(!/Workforce|authOpenLedelse/.test(mer));
});
t('WN02', 'opening keeps the Sormena shell: authOpenLedelse calls authWorkforceShell(true) and no longer hides #main-app; guards, adapters and mount door unchanged', () => {
  const b = fnBody('authOpenLedelse');
  assert.ok(b.includes('authWorkforceShell(true)'));
  assert.ok(!b.includes('hideMainApp()'));
  assert.ok(b.includes("currentUser.role!=='admin'") && b.includes("authMembership.accessRole!=='admin'") && b.includes('ad.createManagementAdapters(') && b.includes('ui.mountLedelseProduction('));
  assert.ok(b.indexOf('authEmployeeCss(true)') < b.indexOf('authWorkforceShell(true)') && b.indexOf('authWorkforceShell(true)') < b.indexOf('ui.mountLedelseProduction('));
});
t('WN03', 'authWorkforceShell: toggles body.wf-open (+ html.wf-root); on -> Workforce is the only active footer item and the title is "Workforce"; off -> title and footer highlight restored from currentPage (incl. Mer pages); no auth / tenant / listener work', () => {
  const b = fnBody('authWorkforceShell');
  assert.ok(b.includes("document.body.classList.toggle('wf-open',!!on)") && b.includes("document.documentElement.classList.toggle('wf-root',!!on)"));
  assert.ok(b.includes("document.querySelectorAll('.nb').forEach(b=>b.classList.remove('active'))"));
  assert.ok(b.includes("getElementById('navWorkforceBtn')") && b.includes("title.textContent='Workforce'"));
  assert.ok(b.includes('pageTitles[pg]||pg') && b.includes("'.nb[data-pg=\"'+pg+'\"]'") && b.includes("['leverandorer','svinn','betalinger','bankkonti'].includes(pg)"));
  assert.ok(!/firebase|authResolve|startListeners|stopListeners|signIn|TENANT_ID|authGeneration/.test(b));
});
t('WN04', 'leaving: goTo() closes an open workspace FIRST (authCloseLedelse) and then navigates; authLeaveLedelse always removes the shell class; every teardown path still goes through authLeaveLedelse', () => {
  const g = fnBody('goTo');
  assert.ok(g.indexOf('if(ldHost)authCloseLedelse();') >= 0 && g.indexOf('if(ldHost)authCloseLedelse();') < g.indexOf("document.querySelectorAll('.page')"));
  const l = fnBody('authLeaveLedelse');
  assert.ok(l.indexOf('authWorkforceShell(false)') > l.indexOf('if(!h)return') && l.indexOf('authWorkforceShell(false)') < l.indexOf('h.adapters.dispose()'));
  assert.ok(fnBody('authLeaveManagement').includes('authLeaveLedelse()') && fnBody('authCloseLedelse').includes('authLeaveLedelse()') && fnBody('authLedelseToMinAnsattside').includes('authLeaveLedelse()'));
  assert.ok(/document\.querySelectorAll\('\.nb'\)\.forEach\(b=>b\.addEventListener\('click',\(\)=>\{if\(b\.dataset\.pg && b\.dataset\.pg!=='mer'\)goTo\(b\.dataset\.pg\);\}\)\)/.test(html), 'footer click wiring unchanged');
});
t('WN05', 'Workforce stays in the footer while open (admin + management surface; no "!ldHost" condition); Min ansattside switch still needs a bound ansattId', () => {
  const b = fnBody('authUpdateEmployeeControls');
  assert.ok(b.includes("wf.style.display=admin&&ACTIVE_SURFACE==='management'?'':'none'"));
  assert.ok(b.includes("ldEmp.style.display=ldHost&&own?'':'none'"));
});
t('WN06', 'SCOPING: every selector of the new block starts with body.wf-open (print: body.wf-open / html.wf-root / @page fscontract); the shared employee-shell.css carries no wf-open rule (Min ansattside renders from it unchanged)', () => {
  assert.ok(cssStart > 0 && cssEnd > cssStart && printAt > 0);
  const stripped = screenCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [...stripped.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',')).map((x) => x.trim()).filter(Boolean);
  assert.ok(sels.length >= 20, 'selector count ' + sels.length);
  for (const s of sels) assert.ok(s.startsWith('body.wf-open'), 'unscoped selector: ' + s);
  const pBody = printCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^@media print\{/, '').replace(/@page fscontract\{[\s\S]*?\}\}\}?/, '');
  const pSels = [...pBody.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',')).map((x) => x.trim()).filter(Boolean);
  assert.ok(pSels.length >= 15);
  for (const s of pSels) assert.ok(s.startsWith('body.wf-open') || s === 'html.wf-root', 'unscoped print selector: ' + s);
  const shellCss = fs.readFileSync(path.join(HERE, 'employee-shell.css'), 'utf8');
  assert.ok(!/wf-open|wf-root/.test(shellCss), 'the shared employee stylesheet carries no Workforce-shell rule');
});
t('WN07', 'native chrome: pages, FAB and header add/export are hidden while open; header fixed; the white Sormena bar, host label, "Tilbake til Sormena", host "Logg ut" and the employee tab bar are display:none; Sormena tokens (primary, Sora, --bg #f0efeb, --r 12px) mapped onto the workspace tokens', () => {
  assert.ok(screenCss.includes('body.wf-open #main-app .page,body.wf-open #fabBtn,body.wf-open #hdrAddBtn,body.wf-open #hdrExpBtn{display:none!important}'));
  assert.ok(screenCss.includes('body.wf-open .hdr{position:fixed;top:0;left:0;right:0}'));
  assert.ok(screenCss.includes('body.wf-open #employee-host>header.top,body.wf-open #emp-nav,body.wf-open #emp-host-label,body.wf-open #ld-host-back,body.wf-open #emp-host-back,body.wf-open .emp-hostbar>.emp-hostbtn:not(#ld-host-emp){display:none!important}'));
  for (const tok of ['--bg:#f0efeb', '--r:12px', '--green:var(--primary)', '--green-deep:var(--primary)', '--shadow:var(--sh)', "font-family:'Sora',sans-serif"]) assert.ok(screenCss.includes(tok), tok);
  assert.ok(screenCss.includes('body.wf-open .ov .btn-g{border:1.5px solid var(--border)}'), 'Sormena sheet buttons protected from the .btn collision');
});
t('WN08', 'PRINT removes chrome FROM LAYOUT (display:none, never visibility): everything outside #employee-host, the host bar, top bar, employee nav, Workforce tabs and every non-contract sibling of the contract pages; paddings zeroed; white root background', () => {
  assert.ok(printCss.includes('body.wf-open>:not(#employee-host){display:none!important}'));
  assert.ok(printCss.includes('body.wf-open .emp-hostbar,body.wf-open #employee-host>header.top,body.wf-open #emp-nav,body.wf-open .lede-tabs{display:none!important}'));
  assert.ok(printCss.includes('body.wf-open .lede-content>:not(.fs-a4),body.wf-open #emp-root>:not(.lede-frame):not(.fs-a4){display:none!important}'));
  assert.ok(printCss.includes('body.wf-open #employee-host{padding:0!important;min-height:0!important}') && printCss.includes('body.wf-open #employee-host .wrap{padding:0!important;margin:0!important;max-width:none!important}') && printCss.includes('body.wf-open{padding:0!important;background:#fff!important;min-height:0!important}') && printCss.includes('html.wf-root{background:#fff!important}'));
  assert.ok(!/visibility/.test(printCss));
});
t('WN09', 'PRINT contract flow: continuous document (no forced sheet break, no sheet padding), per-sheet footer + continuation header removed, tables / parties / signature block never split, headings stay with their content, real page numbers via the named A4 page; NO font-size reduction anywhere in the print block', () => {
  assert.ok(printCss.includes('page:fscontract') && printCss.includes('break-after:auto!important') && printCss.includes('padding:0!important'));
  assert.ok(printCss.includes('body.wf-open #employee-host .fs-a4~.fs-a4 .fs-head,body.wf-open #employee-host .fs-a4~.fs-a4 .fs-cont,body.wf-open #employee-host .fs-foot{display:none!important}'));
  assert.ok(/\.fs-rows,[^{]*\.fs-parties,[^{]*\.fs-signs,[^{]*\{break-inside:avoid/.test(printCss) && printCss.includes('.fs-sec{break-after:avoid'));
  assert.ok(/@page fscontract\{size:A4;margin:12mm 12mm 15mm;@bottom-center\{content:"Side " counter\(page\) " av " counter\(pages\)/.test(printCss));
  const sizes = [...printCss.matchAll(/font-size:([^;}]+)/g)].map((m) => m[1]);
  assert.deepEqual(sizes, ['8.5pt'], 'only the page-number margin box sets a size');
});
t('WN10', 'the shell block and the open/leave functions touch no private employee field; the contract view still prints through window.print() only; legacy Timeliste code is untouched', () => {
  const body = fnBody('authOpenLedelse') + fnBody('authLeaveLedelse');
  assert.ok(!/personnummer|bankkonto/.test(css + body));
  assert.equal(fs.readFileSync(path.join(HERE, 'management-employees-view.mjs'), 'utf8').split('window.print()').length - 1, 2);
  assert.ok(html.includes('<div class="page" id="pg-timeliste"></div>') && html.includes('function renderTimeliste(){') && html.includes('function sumLonnskostForPeriode('), 'legacy Timeliste code untouched');
});
t('WN11', 'ANSATTE SEARCH ROW (018A): the search field stays (view still renders textInput "Søk ansatt …" + "Ny ansatt" in .vp-search); the scoped rule gives the action its natural width so the field is not starved, and the stray bottom margin of the field is cleared so both sit on one line; nothing else in the row is restyled', () => {
  const view = fs.readFileSync(path.join(HERE, 'management-employees-view.mjs'), 'utf8');
  assert.ok(view.includes("const input = textInput(query, 'Søk ansatt …');") && view.includes("input.setAttribute('aria-label', 'Søk ansatt');") && view.includes("search.appendChild(btn('Ny ansatt', 'btn primary'"));
  assert.ok(screenCss.includes('body.wf-open #employee-host .vp-search .btn{width:auto;flex:0 0 auto;margin:0;white-space:nowrap}'));
  assert.ok(screenCss.includes('body.wf-open #employee-host .vp-search input{margin:0}'));
  assert.equal(screenCss.split('.vp-search').length - 1, 2, 'exactly two rules touch the search row');
});
console.log('WORKFORCE_NATIVE_SHELL_TESTS: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
