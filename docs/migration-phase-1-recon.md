# Migration Phase 1 — Reconnaissance Report

**Migration**: Firebase project `four-season-as` → `sormena-prod`, with all data namespaced under `tenants/{tenantId}/...` (default `tenantId = four-season-as`).

**Date**: 2026-05-24
**Scope**: READ-ONLY code reconnaissance. No edits to `index.html`, no commits, no Firebase Console changes.
**Output**: This file (`docs/migration-phase-1-recon.md`) — only artifact produced.

---

## Migration target state (as of 2026-05-24)

**`sormena-prod` Firebase project — already provisioned in Firebase Console**:
- **Project ID**: `sormena-prod`
- **Project number**: `606244090266`
- **Firestore**: enabled, region **`europe-west3`** (Frankfurt)
- **Security rules**: tenant-namespaced, wide-open
  ```
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /tenants/{tenantId}/{document=**} {
        allow read, write: if true;
      }
    }
  }
  ```
- **Storage**: not yet enabled (deferred per Storage Foundation V1 separate workstream)
- **Auth**: not configured (PIN-based app auth stays as-is)

**Implication for migration**: the "create new project" step that the prior recon listed as a risk-LOW manual prerequisite is **DONE**. Migration can proceed directly to the code refactor + data copy phases. The target rules already enforce the `tenants/{tenantId}/...` namespace — any write outside that path will fail in the new project, which is a useful guardrail during refactor (any missed call site that bypasses `tenantPath()` would error loudly instead of silently writing to the wrong place).

**Region note**: `europe-west3` (Frankfurt). If the source project `four-season-as` is in a different region (likely `europe-west3` too based on setup-screen text L398, but **not verified** against the live console), cross-region copy adds latency but no functional issue for a 2 MB one-shot copy.

---

## Data inventory (already completed — for sizing context)

**Total**: 1,181 documents across 11 collections, ~2 MB on disk.

| Collection | Doc count | Notes |
|---|---|---|
| products | 1,072 | Biggest by count — but each doc is small (product registry) |
| purchases | (remaining ~100 split across the other 10) | |
| sales | | |
| svinn | | |
| leverandorer | | |
| dagsalg | | |
| innboks | **9** | **~152 KB each (base64-encoded PDFs embedded in doc)** — single biggest per-doc payload in the dataset |
| ansatte | | |
| vakter | | |
| payments | | Cold archive per `migratePaymentsToBankTransactions` |
| bankTransactions | | |

**Implication for migration**:
- **Total payload is trivial** (2 MB). A naive sequential copy via the Firebase Admin SDK or a browser-side script would complete in seconds, not minutes.
- **Innboks is the long pole**: 9 × ~152 KB ≈ ~1.4 MB of the ~2 MB total. The base64 PDFs blow past the typical Firestore "keep docs small" guideline but stay under the 1 MiB hard cap (note the `INNBOKS_MAX_BYTES=700*1024` enforcement at L3242 — leaves headroom for the ~33% base64 overhead). **Storage Foundation V1 is the right long-term home** for those blobs, but for migration purposes they just need to copy as-is. No special handling.
- **No collection-group queries, no compound indexes** (per recon section B.4) — copy is a flat read+write per collection.
- **Cutover window** (the only true risk) is short because of small data: rules-flip on old project + copy + cutover commit can all happen in <5 minutes.

---

## A. Firebase config locations

**Live config** — `index.html` L4604–4620, inside `boot()` IIFE:

```js
(function boot(){
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyD50BbCtsGxK2hManB_qKi26XgfmklLvNY",
    authDomain: "four-season-as.firebaseapp.com",
    projectId: "four-season-as",
    storageBucket: "four-season-as.firebasestorage.app",
    messagingSenderId: "493084444890",
    appId: "1:493084444890:web:36c371b894f0bfb594fde3"
  };
  document.getElementById('setup-screen').classList.add('hidden');
  localStorage.setItem('fs_fb_config', JSON.stringify(FIREBASE_CONFIG));
  if(!checkLoginSession()){
    document.getElementById('login-screen').classList.remove('hidden');
  }
  initFirebase(FIREBASE_CONFIG);
})();
```

**`initFirebase`** — L1006–1022:

```js
function initFirebase(cfg){
  ...
  let app;
  try{app=firebase.app()}catch(e){app=firebase.initializeApp(cfg)}
  db=firebase.firestore(app);
  ...
  startListeners();
  ...
}
```

**All `four-season-as` string occurrences** (grep, literal):

| Line | Context | Risk |
|---|---|---|
| 392 | `Klikk «Add project», gi det et navn (f.eks. <code>four-season-as</code>)` | Legacy setup-screen UI text. Visible only via `resetSetup()`. **Cosmetic — would say "four-season-as" forever after migration unless updated, but never seen by the user in normal flow.** |
| 432 | `authDomain: "four-season-as.firebaseapp.com",` | Inside `<textarea>` placeholder for legacy setup screen. Cosmetic. |
| 433 | `projectId: "four-season-as",` | Same — placeholder text. |
| 434 | `storageBucket: "four-season-as.appspot.com",` | Same — placeholder text. Note the **`.appspot.com`** suffix here vs **`.firebasestorage.app`** at L4609. The legacy placeholder uses the older bucket naming convention; the live config uses the newer. Trivia, not functional. |
| 4607 | `authDomain: "four-season-as.firebaseapp.com",` | **LIVE config — must change to `sormena-prod.firebaseapp.com`.** |
| 4608 | `projectId: "four-season-as",` | **LIVE config — must change to `sormena-prod`.** |
| 4609 | `storageBucket: "four-season-as.firebasestorage.app",` | **LIVE config — must change.** Storage SDK is not loaded today; bucket field is unused in code. |

**Confirmation**: only ONE live `FIREBASE_CONFIG` object exists (L4605–4612). L430–437 is placeholder text inside the legacy setup screen `<textarea>` (hidden on boot via L4613 `setup-screen.classList.add('hidden')`).

**Strings to update for cutover**:
- **3 mandatory string changes** (L4607 / L4608 / L4609): swap `four-season-as` → `sormena-prod` / `sormena-prod.firebaseapp.com` / `sormena-prod.firebasestorage.app`.
- **3 mandatory value changes** (L4606 `apiKey`, L4610 `messagingSenderId`, L4611 `appId`): pull from `sormena-prod` Firebase Console → Project Settings → Your apps → Web app config. Project number `606244090266` will appear as the `messagingSenderId`.
- **3 cosmetic** (L392 / L433 / L434): update for hygiene only.

---

## B. All Firestore call sites — full inventory

### B.1 Direct `db.collection('<name>')` (hardcoded collection names) — 15 sites

| Line | Snippet | Operation |
|---|---|---|
| 1572 | `db.collection('products').doc(newId).set({...data,id:newId,opprettet:today()})` | products.set |
| 1854 | `db.collection('purchases').doc(newId).set({...})` | purchases.set (saveInnkjop) |
| 2054 | `db.collection('purchases').doc(id).delete()` | purchases.delete (deletePurchase) |
| 2605 | `db.collection('dagsalg').doc(newId).set(data)` | dagsalg.set |
| 2773 | `db.collection('sales').doc(newId).set({...})` | sales.set |
| 2841 | `db.collection('svinn').doc(newId).set({...})` | svinn.set |
| 3233 | `db.collection('bankTransactions').doc(newId).set(payment)` | bankTransactions.set |
| 3266 | `db.collection('innboks').doc(id).set({...})` | innboks.set (handleInnboksFiles) |
| 3510 | `db.collection('innboks').doc(newId).set({...})` | innboks.set (saveScanAsDraft) |
| 4628 | `db.collection('_meta').doc('migrations')` | _meta.ref (migration sentinel) |
| 4639 | `db.collection('bankTransactions').get()` | bankTransactions.get (migration) |
| 4647 | `db.collection('bankTransactions').doc(p.id).set({...})` | bankTransactions.set (migration) |
| 5336 | `db.collection('dagsalg').doc(newId).set(payload)` | dagsalg.set (z-rapport scan) |
| 5487 | `db.collection('bankTransactions').doc(newId).set(payload)` | bankTransactions.set (bank import) |
| 5940 | `db.collection('products').doc(newId).set(data).then(...)` | products.set (scan inline new product) |

### B.2 Parameterized `db.collection(col)` (4 sites, all inside helpers) — L1025–1097

| Line | Snippet | Operation |
|---|---|---|
| 1029 | `listeners[col]=db.collection(col).onSnapshot(...)` | Listener loop, 11 collections |
| 1087 | `const ref=db.collection(col).doc()` | dbAdd helper |
| 1093 | `await db.collection(col).doc(id).update(data)` | dbUpdate helper |
| 1097 | `await db.collection(col).doc(id).delete()` | dbDelete helper |

### B.3 Helper wrappers (read-side, pure LOCAL — no Firestore)

| Line | Helper | Behavior |
|---|---|---|
| 1099 | `dbFind(col,id)` | `LOCAL[col].find(...)` — RAM only |
| 1100 | `dbAll(col)` | `LOCAL[col]||[]` — RAM only |

### B.4 Totals

- **Total `db.collection(...)` call sites**: **19** (15 hardcoded + 4 parameterized helpers).
- **Total Firestore write/read operations** (`.set` / `.update` / `.delete` / `.get` / `.onSnapshot`): **21** (per ripgrep count).
- **Query operators** (`.where`, `.orderBy`, `.limit`, `.startAt`, `.endAt`, `.startAfter`, `.endBefore`): **0** found. **No client-side queries — everything filters from `LOCAL` arrays in memory after `onSnapshot` mirrors the full collection.** Significant simplifier for migration: no compound indexes to migrate.
- **`FieldValue` / `Timestamp` references**: **0** found. All timestamps are plain ISO strings via `new Date().toISOString()`. No special Firestore types to migrate.

### B.5 Refactor surface estimate

If we introduce a single tenant-aware helper `tenantCol(col)` that returns `db.collection('tenants').doc(tenantId).collection(col)`:

- **4 helper functions** (lines 1029, 1087, 1093, 1097) cover **80%+ of writes** by call volume — `dbAdd`/`dbUpdate`/`dbDelete`/`startListeners`.
- **15 direct `db.collection('name').doc(...).set(...)` sites** bypass the helpers and each need a search-and-replace.
- **0 query operators** = nothing complex to refactor on the read side; just the listener path needs tenant-namespacing.

**Plain refactor count**: 19 call sites. **Complexity per site**: trivial (textual replacement of `db.collection(X)` with `tenantCol(X)` or equivalent). **Total estimated change**: ~25 line edits if a helper is introduced; ~40 if every site is expanded inline.

---

## C. Collections referenced in code

### C.1 Collections listened to (`startListeners` L1027)

```js
const cols=['products','purchases','sales','svinn','leverandorer','dagsalg','innboks','ansatte','vakter','payments','bankTransactions'];
```

11 collections subscribed via `onSnapshot`.

### C.2 LOCAL state (L957)

```js
let LOCAL={products:[],purchases:[],sales:[],svinn:[],leverandorer:[],dagsalg:[],innboks:[],ansatte:[],vakter:[],payments:[],bankTransactions:[]};
```

Same 11 collections — exact match with listener set.

### C.3 Cross-reference findings

| Collection | In LOCAL | In `cols` listener | Written by `db.collection('name')` | Notes |
|---|---|---|---|---|
| products | ✓ | ✓ | ✓ (1572, 5940) | Plus updates via `dbUpdate` helper |
| purchases | ✓ | ✓ | ✓ (1854, 2054) | Plus updates via helper |
| sales | ✓ | ✓ | ✓ (2773) | |
| svinn | ✓ | ✓ | ✓ (2841) | |
| leverandorer | ✓ | ✓ | only via `dbAdd`/`dbUpdate` helpers | |
| dagsalg | ✓ | ✓ | ✓ (2605, 5336) | |
| innboks | ✓ | ✓ | ✓ (3266, 3510) | |
| ansatte | ✓ | ✓ | only via `dbAdd`/`dbUpdate` helpers | |
| vakter | ✓ | ✓ | only via `dbAdd`/`dbUpdate` helpers | |
| payments | ✓ | ✓ | NEVER written by code | Legacy cold archive — read-only after `migratePaymentsToBankTransactions` migration. |
| bankTransactions | ✓ | ✓ | ✓ (3233, 4647, 5487) | |
| **_meta** | ✗ | ✗ | ✓ (4628) | **Special: migration-sentinel collection, NOT mirrored to LOCAL.** Single doc `_meta/migrations`. Used by `migratePaymentsToBankTransactions` to gate one-shot data transforms. |

**Findings**:
- **`payments`**: in LOCAL + listener but no write paths. Confirmed legacy by `migratePaymentsToBankTransactions` (L4626) which copies payments → bankTransactions on first boot post-migration. Per CLAUDE.md L92: "`payments` is cold archive."
- **`_meta`**: present in Firestore but NOT mirrored to LOCAL and NOT in the `cols` listener — by design (system-only, not data). **Migration must explicitly copy or recreate this doc** to prevent re-running migrations against the new project. Cross-reference with data inventory: 1,181 docs across the 11 named collections — `_meta` is in addition to that count.

**Decision still open**: should `_meta/migrations` live at the project root in `sormena-prod` (matching the source) or be tenant-scoped under `tenants/four-season-as/_meta/migrations`? The new project's wide-open rules (per "Migration target state" above) ONLY allow reads/writes under `tenants/{tenantId}/...` — so **root-level `_meta` would be blocked by rules in the new project**. Decision is effectively made by the rules: **tenant-scope `_meta`** to live under `tenants/four-season-as/_meta/migrations`. This requires either (a) updating the migration code's path to read `tenantCol('_meta')` instead of `db.collection('_meta')`, or (b) loosening the rule to allow root-level `_meta`. (a) is cleaner.

---

## D. Real-time listeners — full inventory

**Single listener setup site**: `startListeners()` L1025–1043:

```js
function startListeners(){
  listenersReady=0;
  const cols=['products','purchases','sales','svinn','leverandorer','dagsalg','innboks','ansatte','vakter','payments','bankTransactions'];
  cols.forEach(col=>{
    listeners[col]=db.collection(col).onSnapshot(snap=>{
      LOCAL[col]=snap.docs.map(d=>({id:d.id,...d.data()}));
      listenersReady++;
      if(listenersReady>=cols.length){
        showApp();
      } else {
        renderIfActive(col);
      }
      renderIfActive(col);
      setSynced();
    },err=>{
      showToast('Firebase-feil: '+err.message,'err');
    });
  });
}
```

**Total `.onSnapshot` calls in entire file**: **1** (the loop above).

**Nested listeners / listener-within-listener**: **none** — one snapshot listener per top-level collection, flatly attached at boot. No collection-group queries, no nested subcollection listeners. Clean.

**Listener lifecycle**: stored in `let listeners={}` global (L1005). Never unsubscribed in normal app flow — they live for the page lifetime. No teardown call for tenant-switching (irrelevant for V1 since `tenantId` is constant per deployment).

**Implication for migration**: changing the listener path requires changing one location (L1029); the entire collection mirror re-syncs on next boot.

---

## E. Service worker / PWA cache

**Grep for `serviceWorker | manifest.json | caches. | workbox | service-worker`** in `index.html`: **0 matches**.

**Repo file scan**: no `service-worker.js`, no `manifest.json`, no `sw.js` in repo. Root listing shows only `docs/`, `CLAUDE.md`, `CNAME`, `index.html`.

**Confirmation**: **Sormena is NOT a PWA**. Single-file web app served from GitHub Pages. No service worker installed, no web app manifest, no offline cache, no install-to-home-screen.

**Implication for migration**: **zero PWA cache to invalidate** on cutover. Users pick up the new `FIREBASE_CONFIG` on their next hard refresh after the deploy commit lands on `main`. Major simplifier — no `?v=...` cachebust, no SW unregister-then-reinstall dance, no stale-cache-points-at-old-project risk.

---

## F. Cloudflare Worker Firebase check

**What I can verify from `index.html`** — single fetch call to the Worker, L5065:

```js
var resp = await fetch('https://fourseason.herishhashemi.workers.dev', {
  method: 'POST',
  headers: {'Content-Type':'application/json', 'x-api-key':apiKey},
  body: reqBody
});
```

Request body (constructed L5059–5063):
```js
var reqBody = JSON.stringify({
  model: 'claude-sonnet-4-6',
  max_tokens: 16000,
  messages: [{role:'user', content:contentItems}]
});
```

**No Firebase identifier (no `projectId`, no `four-season-as`, no `storageBucket`, no Firestore reference) is sent in the request body or headers.** Only the user's Anthropic `x-api-key` header travels with the call.

**What I CANNOT verify**: the Worker's source code itself. Per CLAUDE.md, the Worker forwards to `api.anthropic.com` with `stream:true` forced on the upstream call (Bank Scanner V1 Session 1.6 notes), but the actual Worker JS lives in a separate Cloudflare dashboard / repo not present in this codebase.

**The user's brief states the Worker code "is in this conversation history" — but it is not** (only the Worker URL and behavior contract are referenced in CLAUDE.md and prior recon work). To definitively answer item F, the Worker source must be fetched from the Cloudflare dashboard.

**Most likely outcome** (given the request shape, the URL pattern, and the established design contract): the Worker is a thin Anthropic proxy that does not touch Firebase. **No expected Firebase coupling.** But this is inference, not verification. **Flag for explicit confirmation before cutover.**

---

## G. Rollback confidence assessment

### G.1 Git state

```
On branch main
Your branch is up to date with 'origin/main'.
nothing to commit, working tree clean

ab93a6f feat(innkjop): bankaxept level 1 — paid-at-delivery detection + UI for AI scanner + manual entry form
99bda54 feat(innkjop): math verification V1 — AI math cross-check + always-render Auto-regel + dual eks/inkl sum avviker
5acaf3a feat(innkjop): matcher fix V1.1 — always-visible edit buttons + editable product names
de21006 feat(innkjop): matcher fix V1 — inline rename + treat-as-new for wrong AI fuzzy matches
bb1679b feat(bank): Session 1.6 — SSE streaming for AI scanner (fix 524 on long scans)
```

**Clean working tree, linear history, `ab93a6f` is the rollback target** for any single-commit migration revert. `git revert <commit>` would cleanly restore the previous config.

### G.2 Reversibility per migration phase

| Migration action | Reversible via | Status / Risk |
|---|---|---|
| Edit `FIREBASE_CONFIG` in `index.html` | `git revert <commit>` + redeploy | LOW — minutes |
| Add `tenantCol()` helper + refactor 15+ call sites | `git revert <commit>` + redeploy | LOW — minutes |
| Create new Firebase project `sormena-prod` in Console | Manual Console delete | **DONE** (2026-05-24). Project number 606244090266, region europe-west3, tenant-namespaced rules already in place. |
| **Copy Firestore data from `four-season-as` to `sormena-prod`** | Re-copy or delete docs in target project; **source project is read during copy, never written**. | LOW — ~2 MB total, sub-minute copy time. |
| **Cutover commit** (point `main` at new config) | `git revert <commit>` + redeploy | LOW for code — but users between cutover and revert wrote to NEW project; those writes get orphaned in `sormena-prod` and would not appear in `four-season-as`. **This is the only window of asymmetric risk.** Small data + no PWA cache reduces the window to ~minutes. |
| Delete old `four-season-as` project | One-time, irreversible after Firebase's 30-day grace period | **DO NOT DO IN V1.** Recommend keeping old project parked indefinitely as cold backup. |

### G.3 Confirmation per brief

- **Old project `four-season-as` will be untouched throughout migration**: ✓ confirmed in plan. No writes to old project should occur once the cutover commit lands.
- **No irreversible actions in the plan until "delete old project" — explicitly deferred**: ✓.
- **No automatic / async / background process writes to Firestore from `index.html` that wouldn't be caught by changing `FIREBASE_CONFIG`**: ✓. All writes flow through the single `db` global that `initFirebase` populates.

### G.4 Risks NOT in the migration plan that surfaced during recon

1. **Cutover write-orphan window**: between the moment `main` deploys with the new config and the moment users hard-refresh, both old and new projects could receive writes from different browser tabs (one with cached old `index.html`, one with new). Mitigation: schedule cutover at low-traffic time, ensure all users hard-refresh, or freeze Firestore rules on `four-season-as` to `read: if true; write: if false;` at cutover moment (forces all writes to fail loudly on stale tabs rather than silently land in the wrong project). **Window is short** because no PWA cache and small data — practically a few minutes.

2. **`_meta` migration sentinel collision + rule path**: `_meta` today is at the root of `four-season-as`. The new project's rules ONLY allow paths under `tenants/{tenantId}/...`, so a verbatim copy of `_meta/migrations` to the new project root would be **invisible to the app** (read-blocked by rules). Two options:
   - **(a)** Code change: update `migratePaymentsToBankTransactions` to use `tenantCol('_meta')` instead of `db.collection('_meta')` (preferred — keeps rules tight).
   - **(b)** Rules change: loosen rules to allow root-level `_meta`.
   **(a) is cleaner.** Data-copy script must copy the doc to `tenants/four-season-as/_meta/migrations`, NOT to root `_meta/migrations`.
   
   If the sentinel is NOT carried over (intentionally or not), `migratePaymentsToBankTransactions` re-fires on first boot against the new project. The code comment at L1049 asserts idempotency ("sentinel + per-doc skip, so concurrent tabs are safe") — so re-running is harmless against the copied `payments` collection, but burns Firestore reads/writes unnecessarily.

3. **PIN-based auth has no Firebase-Auth dependency** (per CLAUDE.md, hardcoded `USERS` map + `sessionStorage`). Sessions survive a config swap. No re-login required at cutover.

4. **`localStorage.fs_fb_config`** (set at L4614) — a stale browser cache of the old config. The boot code at L4604–4619 hardcodes the live config into `FIREBASE_CONFIG` and passes it directly to `initFirebase`, IGNORING `localStorage.fs_fb_config` (the localStorage write is one-way). So localStorage doesn't pollute the next boot. **No issue.** But: the legacy setup screen `resetSetup()` path reads from `localStorage.fs_fb_config` — if anyone ever hits that path, they'd see the OLD config. Probably not user-reachable, but worth noting.

5. **`localStorage.fs_anthropic_key`** (per CLAUDE.md) — survives a config swap, no impact.

---

## H. External dependencies

### H.1 GitHub Pages / deployment

- **CNAME file** (repo root): contents = `sormena.no`. Custom domain pointed at GitHub Pages.
- **No `firebase.json` / `.firebaserc` / `firebase.config.json`** — Firebase Hosting is NOT used.
- **Deploy = `git push origin main`** per CLAUDE.md.

### H.2 External fetches from `index.html`

Grep for `fetch( | XMLHttpRequest | herishhashemi | workers.dev | googleapis | api.anthropic`:

| Line | Endpoint | Purpose |
|---|---|---|
| 7 | `https://fonts.googleapis.com/css2?family=Sora&family=DM+Mono` | Google Fonts CSS — read-only stylesheet load. No Firebase coupling. |
| 5065 | `https://fourseason.herishhashemi.workers.dev` | Cloudflare Worker proxy → Anthropic. No Firebase coupling (see F). |

**No direct calls to Google Drive APIs, no `googleapis.com/drive` references, no other backend services.** Anthropic is the only external write target.

### H.3 Firebase SDK script imports

L10–12:
```html
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
```

Note: `firebase-auth.js` is loaded but `firebase.auth()` is never called (per CLAUDE.md, auth is PIN-based against hardcoded `USERS` map). The script tag is dead weight — safe to leave or remove during migration as a separate cleanup task.

---

## I. Code structure assessment for refactor

### I.1 `db` global

- Defined: L958, `let db=null; // Firestore instance`
- Assigned: L1014, `db=firebase.firestore(app)` (inside `initFirebase`)
- Read: 19 call sites (see B.1 + B.2)

**Single global pattern is friendly to refactor.** Replacing the `db.collection(X)` calls with a `tenantCol(X)` helper is mechanical.

### I.2 Proposed minimal-touch refactor pattern (sketch — NOT applied)

```js
const TENANT_ID = 'four-season-as';

function tenantCol(col){
  return db.collection('tenants').doc(TENANT_ID).collection(col);
}
```

Then replace `db.collection(X)` → `tenantCol(X)` at all 19 sites. Plus the listener loop's `db.collection(col)` → `tenantCol(col)`. Plus the helpers (dbAdd/dbUpdate/dbDelete) use `tenantCol(col)` internally.

**Note**: this is just an illustration of the refactor surface — actual design is Phase 2, NOT this report's scope.

### I.3 Refactor complexity rating

- **Files to touch**: **1** (`index.html`).
- **Call sites to change**: **19** (15 hardcoded + 4 in helpers).
- **Tests to update**: **0** (no test suite exists per CLAUDE.md).
- **Build steps to update**: **0** (no build system).
- **Complexity**: **2/5** — purely mechanical, no query/index reshape, no async surprise. The hardcoded migration function `migratePaymentsToBankTransactions` (L4626–4659) is the most subtle site because it does both `.get()` AND `.set()` and uses raw `existingIds.has(p.id)` dedup logic — needs careful read-through but no structural change.

**Concerns** that elevate complexity beyond "trivial 1/5":
- The `_meta` doc (L4628) — must be tenant-scoped to satisfy the new project's rules (see G.4 #2).
- The migration sentinel logic implicitly assumes one project per "world" — re-running migrations on a fresh project could double-process if the data-copy step doesn't carry `_meta` over correctly to the tenant-scoped path.
- The legacy setup screen (`resetSetup()` path, L385–440) has its own `firebase.initializeApp(cfg)` call path via `handleSetupSubmit` (not read in detail, but inferred from L4614 `localStorage.setItem('fs_fb_config', JSON.stringify(FIREBASE_CONFIG))`). If `resetSetup()` is reachable post-migration, it must also be updated — OR explicitly disabled/removed during migration as cleanup. Recommend the latter (acknowledged-legacy per CLAUDE.md L60).

---

## J. Current git state

```
Branch:           main
Working tree:     clean (apart from this untracked recon doc)
Origin sync:      up to date with origin/main
Latest commit:    ab93a6f feat(innkjop): bankaxept level 1
Branches:         main only (no feature branches, no work-in-progress)
```

**Recent commit history** (last 5):
```
ab93a6f feat(innkjop): bankaxept level 1 — paid-at-delivery detection + UI for AI scanner + manual entry form
99bda54 feat(innkjop): math verification V1 — AI math cross-check + always-render Auto-regel + dual eks/inkl sum avviker
5acaf3a feat(innkjop): matcher fix V1.1 — always-visible edit buttons + editable product names
de21006 feat(innkjop): matcher fix V1 — inline rename + treat-as-new for wrong AI fuzzy matches
bb1679b feat(bank): Session 1.6 — SSE streaming for AI scanner (fix 524 on long scans)
```

**No branches to merge / abandon. No uncommitted work. Clean baseline.** `ab93a6f` is the rollback target.

---

## Open questions surfaced during recon

1. **`_meta` path strategy**: tenant-scope it (`tenants/four-season-as/_meta/migrations`) — effectively answered by the new project's rules (root-level `_meta` is rule-blocked). Confirm this is the chosen approach. Affects (a) the migration code change and (b) the data-copy script's target path.
2. **Cloudflare Worker source verification**: needed to definitively answer F. Recommend Herish paste the Worker source (or grant Drive/dashboard access) before declaring the Worker project-agnostic.
3. **Cutover write-orphan window strategy**: rules-flip-then-copy-then-cutover, or YOLO-and-coordinate-hard-refresh? With ~2 MB data the rules-flip approach buys maybe 60 seconds of write-freeze for a much cleaner cutover. Recommend the rules-flip approach.
4. **Legacy setup screen**: keep it (update to tenant-aware) or remove it during migration as a cleanup task? Listed in CLAUDE.md as legacy but reachable via `resetSetup()`.
5. **Storage migration timing**: the broader Storage Foundation V1 plan (separate workstream) involves adding `firebase-storage.js`. Project migration should happen FIRST (so Storage gets enabled in `sormena-prod` from day one, never in `four-season-as`). Confirmed by current state: Storage is not enabled in `sormena-prod` yet, so the order is naturally correct.
6. **`firebase-auth.js` script tag**: harmless dead weight, but if we're touching the script imports anyway, drop it as part of the migration commit.
7. **`localStorage.fs_fb_config`** (L4614): the boot path hardcodes the live config and ignores localStorage on read. But the value persists in users' browsers indefinitely. Harmless today; could become a future footgun. Consider removing the `setItem` call entirely as cleanup (it's vestigial from the legacy setup-screen architecture).

---

## Concerns / risks flagged that weren't in the migration plan

1. **`_meta` is invisible to LOCAL + rule-blocked at root in new project**. The plan must explicitly call out tenant-scoping the `_meta` collection — otherwise migrations re-run silently or fail with permission errors that the user doesn't see (the migration is fire-and-forget per L1049 comment, no UI feedback).
2. **Asymmetric writes during cutover window** — the only true risk vector. Plan should specify a freeze-at-cutover strategy (rules flip on old project) or a documented "tell users to hard-refresh" coordination step. With only 2 MB data + no PWA cache, the cleanest sequence is: rules-freeze on old → fast copy → push cutover commit → unfreeze rules on new (always already open) → users hard-refresh on their next action.
3. **Cosmetic strings at L392 / L433 / L434** in the legacy setup screen would still say "four-season-as" after migration. Trivial, but should be updated for hygiene if the setup screen survives.
4. **Worker source unverified** (item F). The recon brief asserts the Worker code "is in this conversation history" but it isn't — this report verifies only the request shape from `index.html`, not the Worker implementation. Flag for explicit confirmation.
5. **No PWA / no service worker / no manifest** — confirmed positive surprise. Cutover requires only a hard refresh; no cache invalidation gymnastics.
6. **Zero query operators, zero FieldValue uses, zero compound indexes** — confirmed positive surprise. No index migration step needed in `sormena-prod`.
7. **`payments` cold archive** — should be included in the data copy for audit trail completeness. Per data inventory, exact count not broken out separately (part of the ~100 docs outside `products`). On `sormena-prod`: either skip the migration via copying `_meta/migrations` sentinel (tenant-scoped), or accept that it re-runs idempotently against the copied `payments` collection.

---

## Refactor surface summary (one-line answer to the build-prep question)

**1 file**, **19 call sites**, **0 query rewrites**, **0 index rewrites**, **0 build/test changes**, **0 PWA cache invalidations**, **~2 MB data to copy** (sub-minute), **target project already provisioned**. **Complexity: 2/5.**

The refactor is dominated by mechanical search-and-replace once a `tenantCol(col)` helper is added. The novel risks are operational (cutover window + `_meta` tenant-scoping), not code.

---

## What was NOT done in this recon (per safety rules)

- No file edits to `index.html`
- No commits
- No Firebase Console changes (target project pre-provisioned by Herish before this recon)
- No edits to existing docs (`CLAUDE.md`, `docs/system-inventory.md`, `docs/architecture/*` left untouched)
- No git branch changes (stayed on `main`)
- No migration scripts run
- No `git add` / `git push` of this recon file

**Only artifact produced**: this file (`docs/migration-phase-1-recon.md`).
