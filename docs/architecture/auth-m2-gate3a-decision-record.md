# Gate 3A — Decision Record

Governing authority for the Gate 3A implementation, alongside
`docs/architecture/auth-m2-startup-gating.md` Section 3.

This record resolves scope questions the architecture document leaves open at
Gate 3A. It does not amend the behavioural specification.

## Decisions

1. **Both teardown routines land dormant** — the explicit-logout routine and
   the signed-out teardown routine, as distinct artifacts. This satisfies
   §3.16's requirement that both teardown flows land, without wiring either.

2. **No error-action control, wired action behavior, observer callback
   wrapper, callback registration or externally reachable invocation lands.**
   Internal calls among dormant routines are permitted only where required by
   the tracked behavioural authority. The only landed action-like UI element is
   the inert future-submit control with `type="button"` and no handler.

3. **Auth-client construction at page boot remains deferred to Gate 3B**,
   notwithstanding §3.4's permissive "MAY". §3.16 omits it from the Gate 3A
   enumeration, and construction at boot would add an executing SDK call to
   the production boot path.

4. **Dormant Auth call expressions are permitted, but no Auth call executes at
   Gate 3A.** Expressions such as `getIdTokenResult(true)` and `signOut()`
   appear only inside uninvoked routine bodies. No top-level Auth-handle
   construction, initializer, getter invocation or boot-path evaluation is
   introduced.

5. **The "submit control" requirement is interpreted at Gate 3A as an inert
   future-submit action control** landing with `type="button"`, with no
   semantic `<form>` element and no handler. Its label and semantic conversion
   belong to Gate 3B. This narrows the existing "hidden email/password form"
   and "submit control" wording.

6. **`SIGNED_OUT` is an outcome carried through the source-defined
   generation-bound settlement path, not a separately stored application
   state.** No new `SIGNED_OUT` variable, symbolic constant or coordinator-state
   field is introduced. Producing that outcome does not invoke the signed-out
   teardown routine. Canonical signed-out teardown remains reserved for later
   `onAuthStateChanged(null)` wiring at Gate 3B. At Gate 3A the dormant teardown
   may reveal only the existing outer `#login-screen`; the hidden Firebase
   credential container remains `display:none` until Gate 3B.

7. **The final post-await check includes the settle-once latch, and the
   guarded-entry outcome is preserved.** §3.12a requires that any later
   completion return without mutating state. A generation check alone cannot
   detect a timeout settlement, because settlement does not increment the
   generation. The last generation recheck preceding the success tail is
   therefore `gen !== authGeneration || authAttemptSettled`. On success the
   identity pipeline constructs `currentUser`, assigns the bound UID, evaluates
   the guarded tenant-data entry, and settles with the guard's returned
   outcome — so the guarded-entry result is never discarded, and `ready` is
   never settled before every success condition is satisfied.

8. **`SIGNED_OUT` classification is limited to the two conditions the tracked
   table defines.** Only `user-disabled` — "account disabled" — and
   `user-token-expired` — "session expired" — map to `SIGNED_OUT`.
   `invalid-user-token` and `user-not-found` are not established by the tracked
   classification and fall through to `IDENTITY_LOAD_ERROR` under the "unknown
   or unrecognised" default, which offers retry without asserting an
   authorization verdict. The design classifies by condition, not by error
   code; no token may be added by inference.

9. **Timeout consumption is deferred to Gate 3B.** The tracked architecture
   specifies no return-value, resolver, promise-race, deferred-object or
   callback-delivery protocol by which the dormant identity pipeline exposes a
   timer-won outcome. At Gate 3A the 30-second timer settles the current
   generation-bound latch with `IDENTITY_LOAD_ERROR` and no delivery mechanism
   is added. Gate 3B must establish how that settled timeout outcome reaches
   the user, including the case where token refresh or the `ansatte` read never
   completes and the identity-pipeline promise therefore remains pending.

## Production-safe UI decisions

- Hiding mechanism: inline `style="display:none"`. No new CSS rule is added.
  No identified tracked form-specific or login-region structural selector
  automatically targets the new controls. Inherited, universal, external,
  `!important` and browser-controlled effects remain outside static proof and
  are covered by runtime acceptance.
- DOM placement: last child of `.login-card`. No identified relevant
  positional selector targets the login region.
- `#login-error` is untouched at Gate 3A. The reuse-versus-separate-node
  decision belongs to Gate 3B.

## Evidential limit

Rendered equivalence of the login screen cannot be established statically. The
residual settles only at Browser Test Matrix case 20, after deployment.
