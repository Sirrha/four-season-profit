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

## Proven Current State

Facts established by the read-only recon, with `index.html` line numbers at commit `6ce8c6f`. These describe the app **as it is today**, before any M2 change.

- **The Firebase Auth SDK is absent.** Only three SDK scripts load (lines 10–12): `firebase-app.js`, `firebase-firestore.js`, `firebase-storage.js` (v8.10.1). There is no `firebase-auth.js`, and no `firebase.auth` / `onAuthStateChanged` / `getAuth` / `signIn` usage anywhere. (The CLAUDE.md claim that `firebase-auth.js` is loaded is incorrect.)
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

Everything below this line is **target architecture** — the state M2 will build. It is not present in the source today.

---

## Security and Startup Invariants

**Initialization invariant (behavior-based).** The following may happen freely because they perform no data access:

- Firebase App may initialize.
- Firebase Auth may attach and resolve.
- The Firestore and Storage client objects may be constructed, **provided construction performs no access**.

**No** Firestore read, listener attach, write, Storage access, migration, or tenant-data operation may occur until **all** of the following have succeeded, in order:

a. a Firebase user exists;
b. token claims have been force-refreshed (`getIdTokenResult(true)`) and validated;
c. `tenants/four-season-as/ansatte/{ansattId}` exists, is active, and has a valid `navn`;
d. `currentUser` has been constructed from the above.

**Non-hang invariant.** Every terminal state leaves the loading spinner and shows a retry-or-logout screen. No state may leave the spinner visible indefinitely. No partially initialized application may be shown.

---

## Target State Machine

`firebase.auth().onAuthStateChanged` is the single startup driver.

```
BOOTING
  → CHECK_SESSION
      → SIGNED_OUT            (no Firebase user; show login)
      → SIGNING_IN            (credentials submitted, or session restored)
  → VALIDATING_CLAIMS         (getIdTokenResult(true) + validate)
  → RESOLVING_EMPLOYEE        (single .get() of ansatte/{ansattId})
  → LOADING_TENANT_DATA       (17-listener coordinator, 30s timeout)
  → APP_READY                 (show #main-app; no migrations)
```

Terminal states (each leaves the spinner and shows the appropriate screen):

- **AUTH_ERROR** — sign-in failed; stay on login; allow another attempt.
- **AUTHZ_CLAIM_ERROR** — claims or ansatte record invalid; show the account-not-ready message; offer logout; start no listeners and load no tenant data.
- **DATA_LISTENER_ERROR** — a listener reported an explicit error; show a retry screen naming the collection and error code where safe.
- **STARTUP_TIMEOUT** — 30 seconds elapsed without completion; show a retry screen.

---

## Identity and Claims

**Claims validation.** After a Firebase user exists, force-refresh the token (`getIdTokenResult(true)`) and require exactly:

- `tenantId === 'four-season-as'`
- `role` is exactly `'admin'` or `'employee'`
- `ansattId` is a non-empty string

Any failure routes to **AUTHZ_CLAIM_ERROR**. No listeners and no migrations may start.

**Claim-role → application-role mapping.**

- Firebase claim `admin` → application role `admin`.
- Firebase claim `employee` → application role `staff`.

During M2, an authenticated employee receives the existing `staff` experience. The legacy `regnskap` role is not a Firebase claim role and exists only in the PIN code path, which is powerless after the cutover (see *PIN Cutover*).

---

## Employee Resolution

In the **RESOLVING_EMPLOYEE** state, after claims are valid and before any of the 17 main listeners start, read exactly one document:

```
tenants/four-season-as/ansatte/{ansattId}
```

Use a single `.get()`, **not** a listener. (This is consistent with M1: each account's claim `ansattId` equals that person's `ansatte` document id, and `ansatte` documents carry `navn` and `aktiv`.)

Validate:

- the document exists;
- `aktiv !== false` (the app's existing active convention);
- `navn` is a non-empty string;
- the record is suitable for constructing application identity.

Any failure routes to **AUTHZ_CLAIM_ERROR**.

**`currentUser` construction.** From a valid claim and a valid `ansatte` document, construct the derived application identity:

- `name` = `ansatte.navn` (human-readable)
- `ansattId` = the validated claim `ansattId` (equals the document id)
- `role` = `admin` if the claim role is `admin`, otherwise `staff` (for claim `employee`)
- `email` = the Firebase user's email
- the visible header identity includes the human name and a clear **Admin** or **Ansatt** role label

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

After the Slice 3 cutover:

- Firebase Auth persistence is the sole session-restoration mechanism. On reload, `onAuthStateChanged` fires with the restored user → silent `SIGNING_IN` → `VALIDATING_CLAIMS` → … → `APP_READY`, with no re-login.
- `sessionStorage['fs_user']` may not authorize, restore, or identify a user.
- `currentUser` is a derived object only.

**Logout order:**

1. `firebase.auth().signOut()`
2. unsubscribe all listeners
3. invalidate the current startup generation
4. clear `currentUser`
5. remove any legacy `fs_user` value
6. show **SIGNED_OUT**

---

## PIN Cutover

**Slices 0–2:** the existing PIN flow remains unchanged, because the Firebase Auth cutover has not yet occurred. `USERS`, `checkPin()`, and `checkLoginSession()` drive login exactly as today.

**Slice 3 (complete security cutover):** Firebase Auth plus validated claims and the resolved `ansatte` identity become the only permitted runtime identity. From this slice on, PIN:

- cannot authenticate;
- cannot authorize;
- cannot restore identity;
- cannot start listeners;
- cannot access application data.

Recovery after Slice 3 is **git revert plus redeploy**, not a PIN bypass. (Rules remain open, so a reverted build's PIN path works again for recovery.)

**Slice 4 (cosmetic and dead-code cleanup only):** remove the obsolete PIN UI, handlers, text, session behavior, and now-unreachable code. No security-critical PIN restriction may be deferred from Slice 3 to Slice 4 — Slice 3 must already make PIN fully powerless; Slice 4 only tidies up.

---

## User-Facing Error Distinction

Two distinct authentication-related error experiences:

**AUTH_ERROR** — incorrect email/password or a Firebase sign-in failure. Remain on the login screen; allow another sign-in attempt.

**AUTHZ_CLAIM_ERROR** — claims or the `ansatte` record are invalid. Show:

> "Kontoen din er ikke klar for Sormena. Kontakt Herish."

Provide a logout action. Start no listeners and load no tenant data.

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

- **Files:** `index.html` (add the `onAuthStateChanged` driver; email/password login UI; claims validation; `ansatte/{ansattId}` resolution; `currentUser` construction; auth-gated `startListeners`; Firebase session restoration; new logout order; make PIN powerless for identity/data).
- **Behavior change:** the real cutover — tenant-data access now requires a signed-in, valid-claim, resolved-employee user; PIN can no longer authenticate, authorize, restore identity, start listeners, or reach data.
- **Risk:** highest — this is where a mistake could hang startup or lock users out.
- **Browser verification:** the full browser test matrix below, in Chrome.
- **Rollback:** git revert + redeploy to the Slice 2 state (PIN login works; rules are still open).
- **Deployment GO/STOP:** GO only when every matrix case passes; STOP on any spinner-hang, any valid user denied, any invalid user admitted, or any PIN path still reaching data.

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
| 17 | Post-Slice-3 PIN attempt | PIN cannot authenticate/authorize/start listeners/reach data |
| 18 | Duplicate Auth callback / rapid retry | one listener set, one showApp (generation + latch guards) |
| 19 | Stale callback from an older generation | ignored (generation mismatch) |

---

## Rollback Plan

- Slices 0, 1, 2, 4 roll back by reverting the single `index.html` change for that slice.
- Slice 3 rolls back by **git revert + redeploy** to the Slice 2 state. Because Firestore/Storage rules remain open throughout M2, the reverted build's PIN login and data flow work immediately — there is no rules-driven lockout to recover from.
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

- **GO** to implement, slice by slice, when: the startup driver is the single `onAuthStateChanged`; the initialization invariant holds (no data access before user + validated claims + resolved active employee + constructed `currentUser`); the coordinator guarantees exactly one terminal outcome with a 30-second bound and no indefinite spinner; migrations are removed from startup; and the PIN is fully powerless for identity/data at Slice 3.
- **STOP** (do not proceed to the next slice) if: any valid user is denied or any invalid user is admitted; the spinner can hang; a partially initialized app can show; `startListeners` can run before the invariant is satisfied; a migration can run on the startup path; the PIN can still reach data after Slice 3; or any change would introduce employee-visible authorization differences (that belongs to M3) or rules tightening (that belongs to M7).
