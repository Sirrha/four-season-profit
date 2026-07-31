# Auth M2 — Firebase Authentication & Safe Startup Gating

**Status:** Design agreed; not yet implemented. This document is the source of truth for the M2 work. No application code has changed yet.

**Prompt of record:** `SORMENA-AUTH-M2-DESIGN-DOC-001`. Baseline recon: `SORMENA-AUTH-M2-STARTUP-RECON-001` (read-only, against `index.html` at commit `6ce8c6f`).

---

## Purpose

M1 set Firebase Auth custom claims (`{ role, tenantId, ansattId }`) on the six approved accounts; those claims are live and verified but **inert** — nothing in the app reads them. M2 makes the app authenticate against Firebase Auth, read those claims, resolve the employee, and gate all tenant-data access behind a safe, non-hanging startup sequence. M2 replaces the PIN curtain as the runtime identity, without touching Firestore/Storage rules.

## Scope

- **In scope:** loading the Firebase Auth SDK; an `onAuthStateChanged`-driven startup state machine; claims validation; employee-document resolution; a generation-scoped, timeout-bounded listener coordinator that can never hang; removal of the six startup migrations; a real logout; and a complete PIN cutover so PIN can no longer authenticate, authorize, restore identity, start listeners, or reach data.
- **Out of scope:** see *Non-Goals* and *Milestone Roadmap*. Firestore/Storage rules stay open for all of M2.

---

## Proven Current State — M2 baseline, as of pre-Slice 0

*This section records the source state proven at the M2 baseline, at commit `6ce8c6f`, before any slice shipped. It is a dated record and is not updated as slices land. Where a statement has been superseded by shipped work, the superseding slice is named inline. For live state, see the Implementation Slices section and Section 3.*

Facts established by the read-only recon, with `index.html` line numbers at commit `6ce8c6f`. These describe the app at the M2 baseline, before any M2 slice shipped.

- **The Firebase Auth SDK is absent.** Only three SDK scripts load (lines 10–12): `firebase-app.js`, `firebase-firestore.js`, `firebase-storage.js` (v8.10.1). There is no `firebase-auth.js`, and no `firebase.auth` / `onAuthStateChanged` / `getAuth` / `signIn` usage anywhere. (The CLAUDE.md claim that `firebase-auth.js` is loaded is incorrect.) **Superseded by Slice 0 (`95e2b20`):** the `firebase-auth.js` script tag now loads, and `typeof firebase.auth === "function"` is confirmed live in production. No Auth API is called until Gate 3B.
- **Startup sequence.** `boot()` is an IIFE at the bottom of the inline script (line 7903) that runs synchronously at parse time (there is no `DOMContentLoaded` listener). It calls `checkLoginSession()` (7913 → def 7880), reveals the login screen if not logged in (7914), then calls `initFirebase(FIREBASE_CONFIG)` (7916). `initFirebase()` (def 1379) reveals the loading screen, constructs `db=firebase.firestore(app)` and `storage=firebase.storage(app)` (1386–1387), then calls `startListeners()` (1389).
- **`startListeners()` has exactly one real caller** — `initFirebase()` at ~line 1389. The two other textual matches (4325, 8235) are comments, not calls.
- **17-collection completion gate.** `startListeners()` (def 1551) defines a 17-entry `cols` array (1554: `products, purchases, sales, svinn, leverandorer, dagsalg, innboks, ansatte, vakter, payments, bankTransactions, bankStatements, bankAccounts, expenses, recurring_templates, expense_taxonomy, documents`) and attaches one `onSnapshot` per collection (1556). Readiness is tracked by a bare boolean map `firstSnapshotSeen` (1396).
- **`showApp()` runs only after all 17 first-success snapshots.** The completion check (1561–1565) marks each collection's first snapshot, and only when `cols.every(c => firstSnapshotSeen[c])` is true does it call `showApp()` (def 1576). `showApp()` hides the loading screen (1579) and shows `#main-app` (1580). Re-entry is guarded by `_appShown` (1575).
- **The listener error callback only shows a toast and never settles readiness.** The `onSnapshot` error handler (1569–1571) calls `showToast('Firebase-feil: '+err.message,'err')` and does nothing else — it does not mark the collection, hide the spinner, or resolve completion.
- **Therefore one failed or silent listener can leave the spinner visible indefinitely.** If any one of the 17 collections errors (or never delivers a first snapshot), its `firstSnapshotSeen` flag is never set, `cols.every(...)` never becomes true, `showApp()` is never called, and `#loading-screen` is never hidden. There is no timeout and no fallback.
- **All 17 collections currently load before the PIN is entered.** The listeners attach and populate `LOCAL` during `initFirebase`/`startListeners`, independent of login. The login screen (`#login-screen`, element at 600, `z-index:9990`) is a cosmetic overlay over an app that has already loaded its data. (Rules are `allow read, write: if true`, so the reads succeed with no auth.)
- **Six migrations/backfills run inside `showApp()` before the PIN identity check.** Lines 1582–1587, before the `if(!currentUser)` branch at 1588, fire-and-forget: `migratePaymentsToBankTransactions()`, `ensureExpenseTaxonomySeed(TENANT_ID)`, `backfillPurchasesToExpenses()`, `dedupeMigratedExpenseMirrors()`, `backfillMirrorPaymentFields()`, `backfillBankAccounts()`. They are idempotent and sentinel-gated (they no-op in production today), but they execute before any identity exists.
- **Legacy identity model.** `USERS` map (7790–7795) holds four PIN identities (`Herish`/`Admin`/`Regnskap`/`Sormena`) with roles `admin`/`regnskap`/`staff`. `currentUser` is a JS global (7800) plus `sessionStorage['fs_user']`. `checkPin()` (7829) writes both on a PIN match (7836–7837); `checkLoginSession()` (7880) restores `currentUser` from `sessionStorage`; `logoutUser()` (7855) clears the global and sessionStorage (7857–7858) but nothing else.
- **`currentUser` role and audit-stamp read sites.** Role is read at 1588 (login gate), 1922 (`applyRoleRestrictions`), and 7868–7869. `currentUser.name` is stamped onto writes at 4370, 5018, 6501, 9322, 9379.

Everything below this line is **target architecture** — the state M2 builds. Slices 0, 1 and 2 have shipped; Slice 3 has not. See *Implementation Slices* for what is live.

---

## Security and Startup Invariants

**Initialization invariant (behavior-based).** The following may happen freely because they perform no data access:

- Firebase App may initialize.
- Firebase Auth may attach and resolve.
- The Firestore and Storage client objects may be constructed, **provided construction performs no access**.

The initialization invariant has three tiers:

1. Before a Firebase user exists and token claims have been force-refreshed and validated:
   no Firestore read, listener, write, Storage access, migration, or tenant-data operation
   may occur.

2. After the Firebase user and claims are validated, exactly one pre-identity Firestore
   operation is permitted: a single `.get()` of
   `tenants/four-season-as/ansatte/{normalizedAnsattId}` — never a listener. This is the read that
   discovers and validates the employee record.

3. Until that ansatte document is validated — it exists, `aktiv !== false`, and `navn` is
   non-empty after trimming — and `currentUser` has been constructed, no other Firestore read, listener,
   write, Storage access, migration, or tenant-data operation may occur. The 17 collection
   listeners attach only after `currentUser` exists.

**Non-hang invariant.** Every terminal state exits the loading spinner and presents an actionable blocking screen; no state may leave the spinner visible indefinitely, and no partially initialized application may be shown. During Slice 1, startup failure and timeout screens provide retry. Firebase logout is added in Slice 3, once Firebase Auth owns the session; after the Auth cutover, applicable terminal states provide retry or logout.

---

## Target State Machine

`firebase.auth().onAuthStateChanged` is the single startup driver.

```
BOOTING
  → CHECK_SESSION
      → SIGNED_OUT            (no Firebase user; show login)
      → SIGNING_IN            (credentials submitted, or session restored)
  → VALIDATING_CLAIMS         (getIdTokenResult(true) + validate)
  → RESOLVING_EMPLOYEE        (single .get() of ansatte/{normalizedAnsattId})
  → LOADING_TENANT_DATA       (17-listener coordinator, 30s timeout)
  → APP_READY                 (show #main-app; no migrations)
```

Terminal states (each leaves the spinner and shows the appropriate screen):

- **AUTH_ERROR** — sign-in failed; stay on login; allow another attempt.
- **AUTHZ_CLAIM_ERROR** — claims or ansatte record invalid; show the account-not-ready message; offer logout; start no listeners and load no tenant data.
- **DATA_LISTENER_ERROR** — a listener reported an explicit error; show a retry screen naming the collection and error code where safe.
- **STARTUP_TIMEOUT** — 30 seconds elapsed without completion; show a retry screen.
- **IDENTITY_LOAD_ERROR** — the identity question could not be answered: transport failure, offline, timeout, or `unavailable` during the token refresh or the `ansatte` read, or the 30-second identity timeout elapsed. Show a retry screen; retry reruns the full identity pipeline. Start no listeners. This is not an authorization verdict.
- **SIGNED_OUT** — no Firebase user. Reveal `#login-screen` with the sign-in form. Established canonically by `onAuthStateChanged(null)` (§3.13b), never asserted by a logout handler.
- **Logout failure surface** — `firebase.auth().signOut()` rejected while the logout attempt owned the current Auth generation. The Firebase session remains live. Tenant UI stays hidden, listeners stay stopped, and the user receives a retry action that calls `signOut()` again. This condition MUST NOT be shown as `SIGNED_OUT`.

---

## Identity and Claims

**Claims validation.** After a Firebase user exists, force-refresh the token (`getIdTokenResult(true)`) and require exactly:

- `tenantId === 'four-season-as'`
- `role` is exactly `'admin'` or `'employee'`
- `ansattId` is a non-empty string

A definitive negative — the token was obtained and its claims are absent, malformed, or wrong — routes to **AUTHZ_CLAIM_ERROR**; no listeners and no migrations may start. A failure to obtain an answer — transport failure, offline, timeout, or `unavailable` — routes to **IDENTITY_LOAD_ERROR** with retry, per §3.11. An expired, disabled, or invalid Auth session routes to **SIGNED_OUT**.

**Claim-role → application-role mapping.**

- Firebase claim `admin` → application role `admin`.
- Firebase claim `employee` → application role `staff`.

During M2, an authenticated employee receives the existing `staff` experience. The legacy `regnskap` role is not a Firebase claim role and exists only in the PIN code path, which is powerless after the cutover (see *PIN Cutover*).

---

## Employee Resolution

In the **RESOLVING_EMPLOYEE** state, after claims are valid and before any of the 17 main listeners start, read exactly one document:

```
tenants/four-season-as/ansatte/{normalizedAnsattId}
```

Use a single `.get()`, **not** a listener. (This is consistent with M1: each account's claim `ansattId` equals that person's `ansatte` document id, and `ansatte` documents carry `navn` and `aktiv`.)

Validate:

- the document exists;
- `aktiv !== false` (the app's existing active convention);
- `navn` is a non-empty string after trimming;
- the record is suitable for constructing application identity.

Failure classification follows §3.11. A **definitive negative** — the document is absent, `aktiv === false`, or `navn` is empty after trimming — routes to **AUTHZ_CLAIM_ERROR**, with no retry, because retrying cannot change the answer. An **inability to obtain an answer** — a transport failure, offline, timeout, or `unavailable` on the `.get()` — routes to **IDENTITY_LOAD_ERROR** with a retry action. A transport failure MUST NOT be reported as an invalid account.

**Normalization.** `normalizedAnsattId` MUST equal `claims.ansattId.trim()` and `normalizedNavn` MUST equal `employee.navn.trim()`. The document read MUST use `normalizedAnsattId`. Untrimmed values MUST NOT be used for identity binding, document paths, UI identity, or audit metadata.

**`currentUser` construction.** From a valid claim and a valid `ansatte` document, construct the derived application identity:

- `name` = `normalizedNavn` — the trimmed `ansatte.navn`, human-readable
- `ansattId` = `normalizedAnsattId` — the trimmed claim value, which equals the document id
- `role` = `admin` if the claim role is `admin`, otherwise `staff` (for claim `employee`)
- `email` = the Firebase user's email — a derived convenience field only. It is not authoritative, is not used for authorization or employee lookup, is not required for startup, and a missing email does not reject identity.
- the visible header identity shows `normalizedNavn` and the mapped role label **Admin** or **Ansatt**. After Gate 3B the Auth identity pipeline owns `#current-user-btn` and updates the header after successful identity resolution and before listeners start. Gate 3A may add the helper dormant; Gate 3B wires it.

**Authoritative identity** is exactly: the Firebase UID binding, `normalizedAnsattId`, `normalizedNavn`, and the mapped application role. No other field participates in authentication, authorization, or employee resolution.

Existing audit stamps continue to read `currentUser.name`, which must be the human-readable `ansatte.navn`. The raw `ansattId` must never be used as the display name or audit-stamp name.

---

## Listener Startup Coordinator

The bare `firstSnapshotSeen` completion mechanism is replaced by a 30-second startup coordinator.

**Per collection**, maintain:

- state: `pending` | `ready` | `failed`
- the collection's unsubscribe function

**Required behavior:**

- a collection's first successful snapshot → `ready`;
- all 17 `ready` → **APP_READY** (call `showApp()` once);
- the first explicit listener error → immediate **DATA_LISTENER_ERROR**;
- the error view identifies the failing collection and its error code where safe;
- 30 seconds without completion → **STARTUP_TIMEOUT** (the timeout applies only when the listeners neither all succeed nor explicitly fail — e.g. a silent network stall);
- the spinner is hidden on `ready`-complete, failure, and timeout — never left up;
- On APP_READY, the successful attempt's listeners remain subscribed and continue driving live rendering. On DATA_LISTENER_ERROR or STARTUP_TIMEOUT, the entire attempt is unsubscribed.

A single terminal latch guarantees exactly one outcome, and the existing `_appShown` re-entry guard is retained so `showApp()` runs at most once.

### Slice 1 Coordinator Failure Semantics

The `startupGeneration` token governs which callbacks may act:

- **Attempt start:** `startListeners()` increments `startupGeneration` and captures the new value as the attempt's generation. Every listener registered in that attempt closes over it.

- **Successful settlement — APP_READY:** `settleStartup('ready')` sets the terminal latch, clears the timeout, hides the loading state, and calls `showApp()` once. It does not increment `startupGeneration`; the successful listeners must retain their generation so their callbacks continue passing the generation guard and driving live rendering after APP_READY.

- **Error or timeout settlement:** `settleStartup('error'|'timeout')` sets the terminal latch, immediately increments `startupGeneration`, clears the timeout, unsubscribes every listener of the failed attempt, and shows the blocking retry state. Incrementing the generation invalidates callbacks already queued before unsubscribe completed. Those callbacks carry the old generation and are rejected before they can mutate `LOCAL` or render after failure.

- **Callback guard:** every snapshot-success callback, listener-error callback, and timeout callback begins with:

  `if (gen !== startupGeneration) return;`

  This permits callbacks from the current successful attempt while rejecting callbacks from failed, timed-out, or superseded attempts.

- **Synchronous registration failure:** the complete 17-listener registration loop runs inside a `try/catch` within `startListeners()`. Any synchronous throw routes through the same `settleStartup('error', detail)` path as an asynchronous listener failure. A partial registration therefore clears its timeout, invalidates its generation, unsubscribes every listener already registered, cannot expose partial `LOCAL`, and shows the unified retry state.

- **LOCAL reset:** attempt initialization resets every collection with `LOCAL[col] = []`. No collection key may be deleted because `dbFind()` assumes every `LOCAL` collection exists as an array.

- **Successful listener retention:** after APP_READY, the successful attempt's listeners remain subscribed and continue updating `LOCAL` and driving live rendering.

- **Slice 1 UI scope:** startup error and timeout states provide retry only. Firebase logout on startup failure is deferred to Slice 3, when Firebase Auth owns the session. Slice 1 must not wire the legacy PIN logout path into the startup error UI.

---

## Retry and Recovery

A monotonically increasing `startupGeneration` token scopes each startup attempt and defeats stale callbacks.

**Every startup attempt (initial and each retry) must:**

- increment `startupGeneration`;
- unsubscribe every listener from the previous attempt;
- capture the current generation in every success and error callback;
- ignore any callback whose captured generation no longer matches the current `startupGeneration`;
- reseed all 17 collection states to `pending`;
- reset the terminal latch;
- cancel any previous timeout;
- safely clear or replace the partial `LOCAL[col]` arrays left by the failed attempt (so a retry cannot render half-loaded data);
- arm exactly one new 30-second timeout;
- create exactly one new listener set;
- allow exactly one terminal result;
- call `showApp()` exactly once.

Retry from **DATA_LISTENER_ERROR** or **STARTUP_TIMEOUT** starts a new generation **without** requiring the user to sign in again (the Firebase session is untouched).

---

## Migration Handling

Remove these six automatic calls from `showApp()`/startup:

- `migratePaymentsToBankTransactions()`
- `ensureExpenseTaxonomySeed(TENANT_ID)`
- `backfillPurchasesToExpenses()`
- `dedupeMigratedExpenseMirrors()`
- `backfillMirrorPaymentFields()`
- `backfillBankAccounts()`

Keep the underlying functions unchanged and dormant (definitions and any existing `window.*` exposure stay as-is; only the automatic startup calls are removed). This is safe because all six are complete, idempotent, and sentinel-gated in production — they no-op today.

Do not create a maintenance panel, button, migration UI, or automatic replacement path. Any future manual execution requires a separately reviewed procedure. Employees must never trigger migrations; after removal, the startup path contains no migration call at all.

---

## Session and Logout

After the Gate 3B cutover:

- Firebase Auth persistence is the sole session-restoration mechanism. On reload, `onAuthStateChanged` fires with the restored user → silent `SIGNING_IN` → `VALIDATING_CLAIMS` → … → `APP_READY`, with no re-login.
- `sessionStorage['fs_user']` may not authorize, restore, or identify a user.
- `currentUser` is a derived object only.

**Logout.** §3.13 is authoritative for both signed-out flows and MUST be followed in preference to any summary here.

Explicit logout is a *request*, not the signed-out state. It blocks further user action, invalidates the current Auth attempt, hides tenant UI and stops listeners **before** calling `firebase.auth().signOut()`, and then lets `onAuthStateChanged(null)` establish the canonical `SIGNED_OUT` state. The logout handler MUST NOT set `SIGNED_OUT` itself. A `signOut()` rejection owned by the current Auth generation surfaces a recoverable logout-failure surface with retry; it does not clear identity, restore tenant UI, or claim the user is signed out.

The canonical teardown — listener stop, generation invalidation, UI hiding, identity clearing, `fs_user` removal, 17-collection reset, coordinator reset, `_appShown = false`, `#login-screen` reveal — is specified in order at §3.13b.

---

## PIN Cutover

**Slices 0–2 and Gate 3A:** the existing PIN flow remains unchanged, because the Firebase Auth cutover has not yet occurred. `USERS`, `checkPin()`, and `checkLoginSession()` drive login exactly as today. Gate 3A ships dormant scaffolding to production alongside a fully working PIN login; §3.16 requires this and P13 proves it.

**Gate 3B (complete security cutover):** Firebase Auth plus validated claims and the resolved `ansatte` identity become the only permitted runtime identity. From this gate on, PIN:

- cannot authenticate;
- cannot authorize;
- cannot restore identity;
- cannot start listeners;
- cannot access application data.

Recovery from a failed Gate 3B is a local revert or reset, not a PIN bypass. Gate 3B is committed but not pushed, so production remains on Gate 3A with PIN login working. Rules remain open throughout M2, so every reverted or reset recovery build retains a working PIN path. See the Rollback Plan for the four recovery cases.

**Slice 4 (cosmetic and dead-code cleanup only):** remove the obsolete PIN UI, handlers, text, session behavior, and now-unreachable code. No security-critical PIN restriction may be deferred from Slice 3 to Slice 4 — Slice 3 must already make PIN fully powerless; Slice 4 only tidies up.

---

## User-Facing Error Distinction

Four distinct authentication-related error experiences:

**AUTH_ERROR** — incorrect email/password or a Firebase sign-in failure. Remain on the login screen; allow another sign-in attempt.

**AUTHZ_CLAIM_ERROR** — claims or the `ansatte` record are invalid. Show:

> "Kontoen din er ikke klar for Sormena. Kontakt Herish."

Provide a logout action. Start no listeners and load no tenant data.

**IDENTITY_LOAD_ERROR** — the account could not be verified because the connection failed, not because it is invalid. Show:

> "Kunne ikke koble til serveren. Sjekk internettforbindelsen og prøv igjen."

Retry button: **"Prøv igjen"** — reruns the full identity pipeline. Start no listeners. Do not tell the user to contact Herish; nothing is wrong with the account.

**Logout failure** — `signOut()` rejected and the Firebase session is still live. Show:

> "Utloggingen mislyktes. Du er fortsatt innlogget. Prøv igjen."

Retry button: **"Prøv å logge ut igjen"** — calls `signOut()` again. Tenant UI stays hidden and listeners stay stopped.

The instruction to contact Herish remains exclusive to definitive `AUTHZ_CLAIM_ERROR`.

---

## Implementation Slices

Each slice changes only `index.html`. Slices are independently revertible.

### Slice 0 — Load the Firebase Auth SDK (inert)

- **Files:** `index.html` (add the `firebase-auth.js` v8.10.1 `<script>` alongside the existing three at lines 10–12).
- **Behavior change:** none — nothing calls `firebase.auth` yet.
- **Risk:** negligible (one additional CDN script).
- **Browser verification:** `firebase.auth` is defined in the console; the app boots and behaves exactly as before.
- **Rollback:** remove the added `<script>` line.
- **Deployment GO/STOP:** GO if boot is unchanged and `firebase.auth` is defined; STOP if the added script errors or alters boot.

### Slice 1 — Listener coordinator, 30-second timeout, startupGeneration (Auth still bypassed, PIN unchanged)

- **Files:** `index.html` (rewrite the `startListeners()` completion/error/timeout logic; add the coordinator, timeout, generation token, and retry/reset; keep the current single caller).
- **Behavior change:** a failed or stalled listener now produces a `DATA_LISTENER_ERROR` or `STARTUP_TIMEOUT` screen with retry, instead of an indefinite spinner. Normal boot is unchanged.
- **Risk:** low–moderate (touches the hot startup path).
- **Browser verification:** normal boot reaches the app; a simulated listener error shows `DATA_LISTENER_ERROR` + working retry; a forced short timeout shows `STARTUP_TIMEOUT`; retry starts a new generation with a single listener set and a single `showApp()`.
- **Rollback:** revert the function to the `firstSnapshotSeen` version.
- **Deployment GO/STOP:** GO if normal boot is clean and both error paths recover; STOP on any spinner-hang, double `showApp()`, or duplicate listeners.

### Slice 2 — Remove the six migration calls from startup (functions remain dormant)

- **Files:** `index.html` (delete the six calls at 1582–1587; leave the function definitions and any `window.*` exposure intact).
- **Behavior change:** startup performs zero migration writes.
- **Risk:** low (all six no-op in production).
- **Browser verification:** the network tab shows no migration writes on boot; the dormant functions still exist.
- **Rollback:** revert (re-add the six calls).
- **Deployment GO/STOP:** GO if boot issues no migration writes and the app is otherwise unchanged; STOP if any dependent behavior regresses.

### Slice 3 — Complete Firebase Auth cutover

- **Files:** `index.html`, across four gates — see §3.16 for the authoritative gate structure. **3A** adds dormant scaffolding: the guarded tenant-data entry, identity pipeline, Auth generation state, settle-once latch, both teardown flows, the `#main-app` hide path, and a hidden email/password form inside `#login-screen`. **3B** wires the cutover: removes the listener bypasses, repoints `retryStartup`, cuts the PIN `currentUser` writes, registers `onAuthStateChanged` as sole startup driver, and swaps `#login-screen` visibility. **3C** is browser verification, **3D** is the production push.
- **Behavior change:** the real cutover — tenant-data access now requires a signed-in, valid-claim, resolved-employee user; PIN can no longer authenticate, authorize, restore identity, start listeners, or reach data.
- **Risk:** highest — this is where a mistake could hang startup or lock users out.
- **Browser verification:** the full browser test matrix below, in Chrome.
- **Rollback:** four cases, per §3.16. **3A defective** — revert 3A and push, returning production to Slice 2. **3B local failure** — revert or reset the unpushed 3B commit; nothing is deployed, and production remains on 3A. **3D deployed failure** — revert the 3B cutover commit and push, returning production to 3A: dormant Auth scaffolding with PIN login fully functional. **Complete retreat** — revert 3A as well, only if a full return to Slice 2 is required. All recovery states have working PIN login because rules stay open.
- **Deployment GO/STOP:** per gate. **3A** — GO if the app behaves identically including PIN login, `node --check` passes, sanity is 10/1/2, and protected internals show a clean diff; STOP on any behavior change at all, since 3A is defined as dormant. **3B** — no deployment decision; 3B is a local commit only. **3D** — GO only when every Gate 3C matrix case passes and PF1–PF6 returned go; STOP on any spinner-hang, any valid user denied, any invalid user admitted, or any PIN path still reaching data.

### Slice 4 — Legacy PIN cosmetic and dead-code cleanup only

- **Files:** `index.html` (remove obsolete PIN UI, handlers, text, session behavior, and unreachable code).
- **Behavior change:** cosmetic/dead-code only; no security behavior changes (Slice 3 already made PIN powerless).
- **Risk:** moderate (touching shared UI/handlers).
- **Browser verification:** login, session restore, and logout still behave as in Slice 3; no orphaned PIN handlers or references remain.
- **Rollback:** revert.
- **Deployment GO/STOP:** GO if Slice 3 behavior is preserved and no dead reference remains; STOP if any removal alters auth behavior (that would mean a Slice 3 gap).

---

## Browser Test Matrix

| # | Case | Expected |
|---|---|---|
| 1 | Herish admin login | signed in; application role `admin`; FAB visible; header shows navn + Admin |
| 2 | Athar Abdulalim login | signed in; role `staff`; audit stamps show navn |
| 3 | Aboud Alkreman login | signed in; role `staff` |
| 4 | Maria Syrota login | signed in; role `staff` |
| 5 | Yussef Ahmad login | signed in; role `staff` |
| 6 | Anastasiia Doroshenko login | signed in; role `staff` |
| 7 | Wrong password | AUTH_ERROR; stay on login; retry allowed; no listeners |
| 8 | Missing claims | AUTHZ_CLAIM_ERROR; account-not-ready message + logout; no data |
| 9 | Wrong tenant claim | AUTHZ_CLAIM_ERROR |
| 10 | Missing/empty ansattId claim | AUTHZ_CLAIM_ERROR |
| 11 | Missing/inactive ansatte document, or empty/invalid `navn` | AUTHZ_CLAIM_ERROR (RESOLVING_EMPLOYEE fails) |
| 12 | Listener error (simulate denied/bad collection) | DATA_LISTENER_ERROR naming the collection; retry; spinner gone |
| 13 | Startup timeout (force a 30s stall) | STARTUP_TIMEOUT; retry; spinner gone |
| 14 | Retry after failure | new generation; exactly one listener set; single showApp; LOCAL cleared |
| 15 | Logout and reload | signOut → SIGNED_OUT; reload lands on login; no auto-data-load |
| 16 | Firebase session restoration | reload while signed in → silent re-auth → APP_READY; no re-login |
| 17 | Post-Gate-3B PIN attempt | PIN cannot authenticate/authorize/start listeners/reach data |
| 18 | Duplicate Auth callback / rapid retry | one listener set, one showApp (generation + latch guards) |
| 19 | Stale callback from an older generation | ignored (generation mismatch) |
| 20 | Gate 3A deployed to production | PIN login works exactly as before; no Auth behavior; app identical (P13) |
| 21 | Sign out, then sign in again as the same user | full startup completes and `#main-app` is visible (P10 — the `_appShown` reset) |
| 22 | User switch A → B without reload | A's listeners stopped, `LOCAL` reset, `#main-app` hidden; B resolves through the full identity pipeline; exactly one listener set (§3.12b) |
| 23 | `signOut()` rejects | recoverable logout-failure surface with retry; **not** SIGNED_OUT; identity intact; tenant UI stays hidden; listeners stay stopped (§3.13a) |
| 24 | Offline during claims refresh or the `ansatte` read | IDENTITY_LOAD_ERROR with retry; **not** AUTHZ_CLAIM_ERROR; no listeners |
| 25 | Identity resolution stalls for 30 s | IDENTITY_LOAD_ERROR — the identity timeout, distinct from case 13's listener timeout; retry reruns the full identity pipeline |

---

## Rollback Plan

- Slices 0, 1, 2, 4 roll back by reverting the single `index.html` change for that slice.
- Slice 3 recovers per gate, because §3.16 splits it into a pushed Gate 3A, a Gate 3B committed locally and not pushed, and a Gate 3D push.
  - **Gate 3A defective:** revert the 3A commit and push. Production returns to the Slice 2 state.
  - **Gate 3B fails locally:** revert or reset the unpushed 3B commit. Nothing was deployed; production remains on Gate 3A with PIN login working. No push is involved in this recovery.
  - **Gate 3D deployed and failing:** revert the 3B cutover commit and push. Production returns to Gate 3A — dormant Auth scaffolding, PIN login fully functional.
  - **Complete retreat to Slice 2:** revert Gate 3A as well, only if returning all the way is required.
  - Because Firestore/Storage rules remain open throughout M2, every recovery state has working PIN login and data flow immediately. There is no rules-driven lockout to recover from.
- The generation token and single terminal latch mean a mid-startup failure never leaves duplicate listeners or a half-shown app; a retry (or a reload) always starts a clean attempt.

---

## Non-Goals

- Tightening Firestore or Storage rules (that is M7).
- Rewriting or re-provisioning claims (M2 reads the existing claims only).
- Using service-account keys.
- New employee-specific UI or views (that is M3).
- Multi-tenant routing.
- Migration redesign or any migration/maintenance UI.

Firestore and Storage rules remain unchanged and open through all of M2.

---

## Milestone Roadmap

- **M2** — Firebase authentication and safe startup gating (this document).
- **M3** — employee-facing authorization and narrower employee views.
- **M7** — Firestore and Storage rules tightening.

Rules remain open through all of M2; the app authenticates and reads claims but does not yet depend on server-side enforcement.

---

## Implementation GO/STOP Criteria

- **GO** to implement, slice by slice, when: the startup driver is the single `onAuthStateChanged`; the initialization invariant holds (no data access before user + validated claims + resolved active employee + constructed `currentUser`); the coordinator guarantees exactly one terminal outcome with a 30-second bound and no indefinite spinner; migrations are removed from startup; and the PIN is fully powerless for identity/data at Gate 3B.
- **STOP** (do not proceed to the next slice) if: any valid user is denied or any invalid user is admitted; the spinner can hang; a partially initialized app can show; `startListeners` can run before the invariant is satisfied; a migration can run on the startup path; the PIN can still reach data after Gate 3B (PIN remains fully functional after Gate 3A by design — see §3.16); or any change would introduce employee-visible authorization differences (that belongs to M3) or rules tightening (that belongs to M7).

## Section 3 — Slice 3: Auth cutover

### 3.1 Objective

Make `onAuthStateChanged` the sole driver of application startup. After Slice 3, no tenant data is read without a validated Firebase Auth session, and the PIN system ceases to exist as a data-access path.

### 3.2 Security invariant

No tenant-data listener may attach and no Firestore read may occur before all of the following exist:

- a live Firebase Auth user;
- validated custom claims;
- a validated employee document;
- a constructed application `currentUser` bound to that user's UID.

At the moment of listener attachment, all four MUST hold simultaneously, and the attempt MUST own the current Auth generation. Any path that could attach listeners without satisfying all of these is a defect, regardless of how it is reached.

Exactly one Firestore operation is permitted before `currentUser` exists:

```
tenants/four-season-as/ansatte/{normalizedAnsattId}.get()
```

No other read, no listener, no write, and no Storage network access may occur in that window.

### 3.3 Boundary

Slice 3 changes when and under what conditions listeners start. It does not change what the listeners do, how snapshots are handled, how the startup coordinator settles, or how errors are surfaced once the app is running.

Firestore and Storage rules remain OPEN throughout. Rules tightening is out of scope for M2, and revert therefore remains a complete recovery path at every gate.

### 3.4 Client construction versus tenant access

Client construction and tenant access are separate concerns and are separated in the code.

- The App, Firestore, Storage and Auth clients MAY be constructed before identity exists.
- Construction performs no tenant access. Constructing a client is not reading data.
- Storage client construction is allowed; Storage network operations are not. Holding a Storage reference is inert; uploading, downloading or listing is tenant access and is forbidden before identity.
- `initFirebase` continues to construct clients. The only change to `initFirebase` is the removal of its listener-start call at line 1407. Nothing else in the function changes.

### 3.5 Guarded tenant-data entry

A single guarded entry function is the only means by which tenant data listeners are started. Raw `startListeners()` has exactly one executable caller in the file: the guard.

The guard evaluates only four conditions: Auth-generation freshness, live Firebase user, application identity binding, and UID match. It never evaluates claim validity or employee-document validity.

Evaluation order is normative. Generation freshness is checked first so that a superseded attempt cannot mutate anything before later checks run.

**1. Calling attempt belongs to a superseded Auth generation.**
Silent return. No listeners started, no UI mutation, no state written, no error surfaced.

**2. No live Firebase user.**
`SIGNED_OUT`.

**3. Live Firebase user, no application identity binding, current Auth generation.**
Do not start listeners. Do not surface an error. The guard's obligation is to ensure that exactly one current identity-resolution attempt owns that live UID, and to create no duplicate pipeline. If a current-generation attempt already owns this UID, the guard returns and that attempt drives resolution. Only if no attempt owns it is one started, and exactly one.

The guard MUST NOT invoke the identity pipeline unconditionally, and MUST NOT re-enter itself. A missing binding means resolution is in progress or has not yet begun; it is not a condition the guard resolves by calling downward.

**4. Live Firebase UID differs from the UID bound to `currentUser`.**
Return silently. The observer generation for the live UID owns identity replacement and resolution (§3.12b). The guard does not perform the switch, does not tear down, and does not surface an error.

**5. All four conditions satisfied — live user, constructed `currentUser`, UID match, current generation.**
Start listeners.

A missing or mismatched binding is not an authorization failure. It means identity resolution has not completed, or a newer callback owns the session and its pipeline will drive.

Invalid claims and invalid employee data are rejected by the identity pipeline before `currentUser` is constructed (§3.8, §3.10, §3.11). By the time the guard runs, an existing `currentUser` is by construction already valid. `AUTHZ_CLAIM_ERROR` is not a guarded-entry outcome.

### 3.6 Retry model

Model 1. Listener retry reuses the already-resolved identity and does not re-run claims validation or the employee document read.

Identity resolution and data-loading recovery are separate concerns, and the two retry paths are distinct: identity retry re-runs the full identity pipeline; listener retry reuses the resolved identity and re-enters through the guard (§3.12). Both retry paths and the initial success path delegate through the guard. No caller bypasses it.

### 3.7 Proof obligations P1–P6

**P1** — whole-file `.onSnapshot(` count remains exactly 1 inside `startListeners`.

**P2** — `startListeners` has exactly one executable caller, the guarded entry. Remove `initFirebase`'s raw call and repoint `retryStartup`.

**P3** — boot cannot reveal main-app or start listeners outside validated identity. Remove the old `checkLoginSession` startup branch.

**P4** — disconnect `currentUser` writes in `checkPin` and `checkLoginSession`. PIN/sessionStorage cannot construct authoritative identity.

**P5** — the only pre-`currentUser` Firestore operation is the single normalized `ansatte` document get. No other read, listener, write or Storage network operation.

**P6** — every continuation after `getIdTokenResult(true)` and `ansatte.get()` rechecks Auth generation before mutating state or continuing.

Easily overlooked — verify these three explicitly rather than by inspection of the obvious sites:

- **P2's `retryStartup` repoint.** The bypasses in `initFirebase` and boot are conspicuous; `retryStartup`'s call is the one that gets missed, and missing it leaves a live path that starts listeners with no guard.
- **P4's line-8000 site.** `checkPin` is the expected place to look. The `checkLoginSession` write is the second one and is easy to leave behind.
- **P6 generally.** Every `await` is a suspension point at which the session may have changed. A continuation that resumes without rechecking generation can mutate state on behalf of a user who is no longer signed in.

### 3.8 Claims validation

Claims are read via `getIdTokenResult(true)` to force a fresh token rather than trusting a cached one.

Validation is against exact literals, in claim vocabulary:

- `tenantId` MUST equal `'four-season-as'`;
- `role` MUST equal `'admin'` or `'employee'`;
- `ansattId` MUST be a non-empty string after trimming.

Validation operates on claim vocabulary, not application vocabulary. The mapping to application roles happens after validation (§3.9), never before it.

### 3.9 Role mapping and the Regnskap decision

After claims validate, the claim role maps to the application role:

- `'admin'` → `admin`
- `'employee'` → `staff`

Regnskap is retired. The shared Regnskap PIN is retired along with the rest of the PIN system. There is no current dependency on it — it was provisioned but never used. No replacement claim value is introduced now; `role` accepts exactly `'admin'` and `'employee'` and nothing else.

A future personal, view-only accountant role is separate scope. It would be a per-person account with its own claim value, not a shared credential, and it is not designed, reserved, or partially implemented in this slice.

### 3.10 Employee document validation and normalization

`ansattId` is the authoritative employee binding. There is no name or email cross-check.

The employee document is read at `tenantCol('ansatte').doc(normalizedAnsattId).get()` — the single permitted pre-`currentUser` Firestore operation (§3.2, P5) — and MUST satisfy:

- the document exists;
- `aktiv !== false`;
- `navn` is non-empty after trimming.

Normalization is part of identity construction, not only of validation:

- `normalizedAnsattId` MUST equal `claims.ansattId.trim()`;
- `normalizedNavn` MUST equal `employee.navn.trim()`.

The `ansatte` document read MUST use `normalizedAnsattId`. `currentUser.ansattId` MUST use `normalizedAnsattId`. `currentUser.name` MUST use `normalizedNavn`.

Untrimmed values MUST NOT be used for identity binding, document paths, UI identity, or audit metadata. A claim value such as `" abc123 "` passes a trimmed non-empty check and then resolves to a document path that does not exist; normalizing only at the validation step would allow this.

### 3.11 Failure classification

The governing distinction is between a definitive negative answer and an inability to obtain an answer.

- A definitive negative — claims present and wrong, employee document absent, employee inactive, `navn` empty after trim — is `AUTHZ_CLAIM_ERROR`. The surface directs the user to contact Herish. There is no retry, because retrying cannot change the answer.
- An inability to answer is `IDENTITY_LOAD_ERROR` with a retry action.

| Rejection | Classification |
|---|---|
| Retryable transport failure — offline, timeout, `unavailable` | `IDENTITY_LOAD_ERROR` |
| Belonging to a superseded generation | Silent return |
| Session expired or account disabled | `SIGNED_OUT` |
| Invalid identity data | `AUTHZ_CLAIM_ERROR` |
| Unknown or unrecognised | `IDENTITY_LOAD_ERROR` |

An unknown error maps to `IDENTITY_LOAD_ERROR` as the safe default: it offers retry without asserting an authorization verdict the application cannot justify. No new generic failure state is introduced. Every failure path terminates in one of the four defined outcomes above.

Logging. Unknown errors are logged for diagnosis. Logs MUST NOT contain ID tokens, raw token results, custom claims, or any other secret. Log the classification and a non-sensitive error identifier only.

Teardown runs only if the failing continuation owns the current Auth generation.

### 3.12 Auth-generation lifecycle

Two generation systems, deliberately separate. Identity state is controlled by the Auth generation. Tenant-data loading state is controlled by `startupGeneration`. Conflating them is what the separation exists to prevent.

Deterministic increment rule. If the callback UID equals the UID bound to an already-constructed `currentUser`, the callback is an idempotent no-op. If the same UID fires while identity resolution is unfinished and no `currentUser` binding exists, it starts one new Auth generation and supersedes the earlier unfinished attempt. Otherwise the generation increments exactly once, at entry.

Generation check after every await. Every continuation resuming after `getIdTokenResult(true)`, after `ansatte.get()`, or after any other suspension point MUST recheck the Auth generation before mutating state or continuing (P6). An `await` is a point at which the session may have changed.

Required behavior by case:

| Case | Required behavior |
|---|---|
| Initial signed-in callback | Increment generation once at entry; run the full identity pipeline; on success construct `currentUser` and delegate to the guard |
| Sign-out during any `await` | The continuation resumes, finds its generation superseded, and returns silently without mutating state. This applies independently at each suspension point |
| Same UID, identity already resolved | Idempotent no-op — regardless of whether listeners are loading, ready, failed, timed out, or awaiting listener retry. Listener recovery belongs to the guard and the `DATA_LISTENER_ERROR` / `STARTUP_TIMEOUT` retry path, not to the Auth observer |
| Same UID, identity unresolved, no binding | Start one new Auth generation; supersede the earlier unfinished attempt |
| User switch, A to B | See §3.12b. B's callback increments the Auth generation exactly once and captures it; A's session is fully torn down; B resolves through the full identity pipeline. Cleanup MUST NOT re-increment the Auth generation after B captured it |
| Stale continuation | Silent return. A stale-generation continuation may not settle, mutate, tear down, or surface anything |
| Current-generation failure after a prior running session | Handled per §3.13c. Teardown primitives are reused, but the state is `AUTHZ_CLAIM_ERROR` or `IDENTITY_LOAD_ERROR` — never `SIGNED_OUT`, because the Auth session is still live |
| Identity timeout | Bounded at 30 seconds, generation-guarded. A timeout belonging to a superseded generation returns silently |
| Identity retry | Re-runs the full identity pipeline: fresh token, claims validation, employee document read, normalization |
| Listener retry | Reuses the resolved identity; re-enters through the guard; does not re-run the identity pipeline |

#### 3.12a Settle-once latch

Each Auth-generation identity attempt MUST have exactly one terminal settlement. The attempt MUST maintain a generation-bound settled latch and a timeout handle.

The first current-generation outcome wins: success, `AUTHZ_CLAIM_ERROR`, `IDENTITY_LOAD_ERROR`, `SIGNED_OUT`, timeout.

On settlement the timeout MUST be cancelled: if the identity timeout handle exists, call `clearTimeout` on it, then clear the reference. Assigning the reference to null does not cancel a pending timer.

Any later completion, rejection, or timeout for the same attempt MUST return without mutating state. A stale-generation attempt MUST NOT settle the current attempt and MUST return silently.

Without this, a read resolving at 29.9 seconds constructs `currentUser`, and the timeout firing at 30 seconds then presents `IDENTITY_LOAD_ERROR` after a successful resolution.

#### 3.12b User switch, A to B

Fires when `onAuthStateChanged` delivers UID B while `currentUser` is bound to UID A. Steps execute in this order:

1. B's callback increments the Auth generation exactly once and captures the resulting value. Every subsequent step in this sequence, and every continuation of B's identity pipeline, tests against the captured value.
2. Stop A's tenant listeners — `stopListeners()`.
3. Invalidate `startupGeneration` by incrementing it. Do not touch the Auth generation.
4. Hide `#main-app` and all transitional tenant UI — loading UI and startup-error UI included.
5. Clear A's identity — `currentUser = null`, bound UID = null.
6. Reset all 17 `LOCAL` collections.
7. Reset coordinator attempt state — `startupState`, `startupSettled`, and `startupTimer`. If `startupTimer` exists, cancel it with `clearTimeout(startupTimer)`, then clear the `startupTimer` reference. Assigning null alone does not cancel the timer.
8. Set `_appShown = false`.
9. Resolve B through the full identity pipeline — fresh token via `getIdTokenResult(true)`, claims validation, normalized `ansatte` read, employee validation, `currentUser` construction, then delegation to the guard.

The cleanup in steps 2–8 MUST NOT re-increment the Auth generation. B captured it at step 1. Any further increment during cleanup would make B's own continuations test as stale, and B's pipeline would silently self-invalidate — leaving a live authenticated user with no identity, no listeners, and no error surface.

Step 4 precedes step 5 for the same reason as §3.13b: the five audit-stamp sites read `currentUser.name`, and hiding tenant UI before clearing identity removes any window for a null dereference.

### 3.13 Signed-out flows

Sign-out has two entry points with different responsibilities. They are not interchangeable.

#### 3.13a Explicit logout request

The logout request is a request. It does not itself establish the signed-out state.

1. Prevent additional user actions. Disable the logout control and block further tenant-UI interaction.
2. Invalidate the current Auth attempt. Increment the Auth generation. If the identity timeout handle exists, cancel it with `clearTimeout`, then clear the reference. Any in-flight identity attempt settles stale and returns silently (§3.12a).
3. Hide tenant UI and stop listeners immediately. `#main-app` hidden, `stopListeners()` called. This is the security action and does not wait on the network.
4. Call `firebase.auth().signOut()`.
5. Allow `onAuthStateChanged(null)` to settle the canonical `SIGNED_OUT` state via §3.13b. The logout handler MUST NOT set `SIGNED_OUT` itself.

`signOut()` rejection. If `signOut()` rejects while the logout attempt still owns the current Auth generation:

- the application MUST NOT claim `SIGNED_OUT`;
- `currentUser` and the bound UID MUST remain intact;
- tenant UI MUST remain hidden;
- tenant listeners MUST remain stopped;
- the user MUST be shown a recoverable logout-failure surface with a retry action;
- retry MUST call `firebase.auth().signOut()` again;
- retry MUST NOT use the identity-retry or listener-retry paths;
- the application MUST NOT automatically restore tenant UI or restart listeners.

Only a later `onAuthStateChanged(null)` callback may establish canonical `SIGNED_OUT`. A rejection from a stale generation returns silently.

#### 3.13b Observer null branch — canonical signed-out teardown

Fires on `onAuthStateChanged(null)`, whether from explicit logout, session expiry, a disabled account, or sign-out in another tab. MUST be idempotent and MUST execute synchronously with no awaits, so no user action can interleave mid-teardown.

1. Stop listeners — `stopListeners()`. Idempotent; safe when none attached.
2. Invalidate generations by incrementing the Auth generation and `startupGeneration`. If `startupTimer` exists, cancel it with `clearTimeout(startupTimer)`, then clear the `startupTimer` reference. Clear the settle-once latch. Generation counters are monotonically advanced, never reset — assigning a prior value would make a superseded continuation appear current and let it settle after teardown.
3. Hide tenant and transitional UI — `#main-app` hidden, loading UI hidden, startup-error UI hidden.
4. Clear identity — `currentUser = null`, bound UID = null.
5. Remove `fs_user`.
6. Reset all 17 `LOCAL` collections.
7. Clear coordinator attempt state — `startupState`, `startupSettled`, and `startupTimer`. If `startupTimer` still exists at this point, cancel it with `clearTimeout(startupTimer)` before clearing the reference. These are attempt state, not generation counters, and are cleared rather than advanced.
8. Set `_appShown = false`.
9. Reveal `#login-screen` with the Firebase sign-in form.

Ordering rationale:

- 1 before 6 — a queued snapshot must not write into reset `LOCAL` collections. Snapshot handlers MUST additionally be generation-guarded so a late callback from a torn-down generation is a no-op.
- 2 before everything that follows — invalidation first means nothing can re-attach behind the teardown.
- 3 before 4 — the five audit-stamp sites read `currentUser.name`. Hiding tenant UI before clearing identity removes any window for a null dereference.
- Step 8 is load-bearing. `showApp()` returns immediately when `_appShown` is true. Without this reset, logout followed by a successful login leaves `#main-app` hidden permanently.
- 8 before 9 — the coordinator must never be reset into a state readable as ready with identity.

Broad modal cleanup is out of scope. Hiding `#main-app` is the required security action; no modal-surface sweep without a source-evidenced map of the modal surface.

#### 3.13c Current-generation identity-failure teardown

If claims validation, employee validation, or identity loading fails for the current Auth generation after a prior successful running session, the application MUST:

1. Stop tenant listeners.
2. Invalidate `startupGeneration` by incrementing it.
3. Hide `#main-app` and all transitional tenant UI.
4. Clear `currentUser` and the bound UID.
5. Reset all 17 `LOCAL` collections.
6. Clear coordinator attempt state — `startupState`, `startupSettled`, and `startupTimer`. If `startupTimer` exists, cancel it with `clearTimeout(startupTimer)`, then clear the reference. Assigning null alone does not cancel the timer.
7. Set `_appShown = false`.
8. Display `AUTHZ_CLAIM_ERROR` or `IDENTITY_LOAD_ERROR` according to §3.11.

This is mandatory, not optional. A running session whose identity has become invalid MUST NOT continue to display tenant data or hold tenant listeners.

The Firebase Auth session remains live unless Auth itself reports a signed-out or invalid-session state. Clearing application identity is an application-layer action and MUST NOT be misclassified as `SIGNED_OUT`. The user is still authenticated; the application has determined it cannot authorize them or cannot resolve who they are.

Generation counters are advanced, never reset to a prior value (§3.13b step 2).

Two consequences worth stating, both consistent with the rest of the document:

- Because step 4 clears the binding, a subsequent `onAuthStateChanged` callback for the same UID finds no binding and therefore starts a new Auth generation and a full identity pipeline (§3.12) rather than no-opping. Identity retry after this teardown works.
- These steps are idempotent, so the same path may serve a fresh sign-in that fails validation before any session was running. In that case the steps are no-ops and only step 8 has visible effect.

### 3.14 Signed-out UI

- `#login-screen` is the signed-out container.
- Its outer container, logo, subtitle, card and `#login-error` are reusable.
- The PIN selector/keypad region is replaced by Firebase email/password inputs and a submit control.
- `SIGNED_OUT` reveals `#login-screen` containing that form.

`#main-app` has only a `display='block'` set and no hide path. Slice 3 adds one, dormant in 3A, first exercised in 3B.

The Firebase form is added hidden alongside the still-live PIN region in 3A. The PIN region is not removed or hidden until 3B. Because 3A is a pushed commit, replacing the PIN region in 3A would break PIN login in production on deploy and 3A would not be dormant. Sequence: add hidden (3A), then swap visibility and cut PIN (3B).

### 3.15 Production preflight — PF1–PF6

Run immediately before Gate 3B. Any single failure is a NO-GO. There is no PIN fallback after cutover; a broken account means that person cannot enter the app at all.

| | Check | Run by |
|---|---|---|
| PF1 | All six Auth accounts exist and are enabled | C-Code (prod) |
| PF2 | Claims per account: `tenantId === 'four-season-as'`, `role ∈ {'admin','employee'}`, `ansattId` non-empty after trim | C-Code (prod) |
| PF3 | Each claim `ansattId` resolves to an existing `ansatte` doc, `aktiv !== false`, non-empty trimmed `navn` | C-Code (prod) |
| PF4 | Live: `typeof firebase.auth === 'function'`, plus `onAuthStateChanged`, `signInWithEmailAndPassword`, `signOut`, `getIdTokenResult` | Chrome Claude |
| PF5 | Sanity baseline 10/1/2 | C-Code (grep) |
| PF6 | Firestore and Storage rules confirmed still OPEN | C-Code |

PF3 is the join between M1's claims and live tenant data, and nothing has re-verified it since provisioning.

### 3.16 Gate structure

#### Gate 3A — dormant scaffolding, pushed

Lands: guarded tenant-data entry, identity pipeline, generation state, settle-once latch, both teardown flows, the `#main-app` hide path, and the Firebase email/password form added hidden inside `#login-screen`.

Nothing is wired. No `onAuthStateChanged` registration. The PIN boot path and PIN keypad remain fully live and functional.

Proofs: `node --check`; sanity 10/1/2; grep counts of new symbols; protected-internals diff clean; live app behaves identically, including PIN login.

#### Gate 3B — cutover wiring

PIN dies here. Store closed, Herish present.

- Remove the listener bypass at ~1407 (`initFirebase`).
- Remove the listener bypass at ~8029–8032 (boot), including the old `checkLoginSession` startup branch.
- Repoint `retryStartup` (~1707) from raw `startListeners()` to the guarded tenant-data entry. This is a repoint, not a removal.
- Cut the `currentUser` writes at ~7952 (`checkPin`) and ~8000 (`checkLoginSession`).
- Register `onAuthStateChanged` as sole startup driver.
- Swap `#login-screen` visibility: PIN region out, Firebase form in.
- `startListeners` ends with exactly one executable caller — the guard.

Apply, `node --check`, local commit. NO PUSH.

Pushing main is deploying. A broken Auth cutover would lock six people out of a live business system with no PIN fallback. Gate 3B therefore creates a local tested commit but does not push it. The push is the separate deployment decision deferred to Gate 3D.

#### Gate 3C — local browser matrix

Against `python -m http.server` on the un-pushed working tree, in Chrome. **The Browser Test Matrix is authoritative for the case list.** Gate 3C runs it in full rather than restating a subset here; maintaining a second case list here would create another source of drift.

Cases 20–25 were added because Section 3 introduced behavior the original matrix predates: Gate 3A dormancy, the sign-out-then-same-user lockout path, user switch A→B, `signOut()` rejection, identity-load failure as distinct from authorization failure, and the identity timeout as distinct from the listener timeout.

Gate 3C passes only when every matrix case passes.

#### Gate 3D — tested-commit push

Herish present. Push (deploy), then verify live on sormena.no: Herish's account first, then one employee account, then confirm all six sign in. Rules remain OPEN, so `git revert` and push is the recovery path throughout.

### 3.17 Protected regions

| Region | Rule | Proof |
|---|---|---|
| Slice 1 coordinator internals — `startListeners()`, `settleStartup()`, `stopListeners()`, `resetLocalCollections()`, `showStartupError()`, listener callbacks, timeout and settlement behavior | Byte-identical | `git diff` shows zero changed lines in these functions |
| `retryStartup` | Narrow permitted change: its single listener-entry call is repointed to the guarded entry. Nothing else in the function changes | Reviewed call-site diff |
| Migrations block | Untouched — not re-added to `showApp`, not relocated | grep position unchanged |
| Auth SDK script block (Slice 0) | Untouched | grep |
| Firestore and Storage rules | Stay OPEN through all of M2 | PF6 |
| `WRITE_TO_PURCHASES` / mirror migration | Untouched | Sanity 10/1/2 on every commit |

### 3.18 Proof obligations P7–P13

**P7** — after 3B, `startListeners` has exactly one executable caller in the file, and it is the guard.

**P8** — zero remaining `currentUser` writes on the PIN path.

**P9** — the `#main-app` hide path exists and is reachable only from teardown. Three teardown entry points are permitted and no others: explicit logout (§3.13a step 3), observer-null canonical teardown (§3.13b step 3), and current-generation identity-failure teardown (§3.13c step 3).

**P10** — sign-out then sign-in as the same user completes a full startup with `#main-app` visible. Verified in 3C, not by inspection.

**P11** — Slice 1 coordinator internals remain byte-identical except for the explicitly reviewed `retryStartup` call-site repoint.

**P12** — `_appShown === false` is observable after teardown completes.

**P13** — the pushed 3A commit leaves PIN login fully functional in production.
