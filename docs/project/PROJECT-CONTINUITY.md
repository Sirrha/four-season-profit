# Sormena Project Continuity Record

**Sormena / Four Season Profit**

| | |
|---|---|
| Version | 1.1 |
| Snapshot | 2026-08-05 |
| Classification | Internal project record — contains no secrets |
| Suggested repository path | `docs/project/PROJECT-CONTINUITY.md` |

> **Recovery principle:** a future developer should be able to understand the
> verified state, find the governing decisions, and identify the exact next
> authorized action without relying on a chat transcript.

---

## 1. Purpose

This document preserves the verified state, architecture, governance, security
boundaries, completed milestones, open risks, and exact next step for the
Sormena / Four Season Profit project. Its purpose is to make the project
recoverable and understandable even if the current conversation, device, or
developer context is unavailable.

This record must never contain passwords, PINs, access tokens, API keys,
private keys, recovery codes, or personal employee data.

---

## 2. Canonical system state

| Item | Verified state |
|---|---|
| Canonical repository | `github.com/Sirrha/four-season-profit` |
| Production domain | `sormena.no` |
| Branch | `main` |
| **Gate 3A deployed application baseline** | `8170cf05082bfca83f16545f6eda32b6b09c10d2` |
| Parent commit | `b87e28d5a224837ee82fa5066740d05809564a48` |
| Commit subject | Land Gate 3A Auth scaffolding, dormant and unwired |
| GitHub Pages deployment | Run #233, successful |
| Production runtime observation | Case 20 / P13 passed by Herish on the deployed commit |
| Migration sanity baseline | 10 / 1 / 2 — see §5 |
| Gate 3A | Fully closed |
| Gate 3B | Not begun |
| Runtime isolation | Parked; must be refreshed before Gate 3C |
| Next authorized design step | Route A credential-distribution design |

> **The baseline above is not necessarily the current HEAD.** It is the last
> commit whose application source was deployed, observed in production and
> accepted. The repository may since have received later approved
> documentation or project commits — including the commit that introduced this
> file — which advance `main` without changing the deployed application source.
>
> **The live current HEAD must be established from Git at recovery time**, not
> read from this document. See §12.

---

## 3. Project purpose and current scope

Sormena is the business application for Four Season Profit. The current
development arc is building a secure employee identity and time-registration
foundation while preserving the live PIN-based workflow until the new
authentication path is deliberately activated.

The immediate product goal is a secure first version of Timeregistrering.

### Employee V1

- Secure employee sign-in.
- Access only to the employee's own records.
- Register date, start time, end time, break, and optional note.
- Automatic hour calculation.
- View personal monthly totals and shift history.
- Request correction of a recent entry.

### Admin / owner V1

- View all employees' registrations.
- Add and correct shifts.
- Identify missing or invalid registrations.
- View employee and monthly totals.
- Approve registrations while preserving history.
- Maintain employee status without destructive deletion.

### Explicitly deferred future module

Åpne vakter / open shifts and shift exchange is accepted as a future product
direction, but it is not part of the current implementation scope. The future
workflow may allow an admin to publish an open shift or an employee to offer an
assigned shift for takeover, with eligibility checks, notifications, approval,
and complete transfer history.

---

## 4. Working roles and change governance

| Role | Responsibility |
|---|---|
| Herish | Product owner, final decision-maker, production observer, and bridge between workspaces |
| Sirrha | Maintains canonical state and sequence, reviews prompts and evidence, catches drift, and writes exact handoffs |
| Soren | Architecture analysis and complete prompt drafting; does not authorize execution |
| Claude Code / C-Code | Inspects or executes only approved prompts; must stop rather than improvise |

### Governance rules

1. One next action is authorized at a time.
2. A C-Code prompt is reviewed as a complete artifact before execution.
3. If a C-Code prompt needs correction, Soren integrates the correction and
   returns a full clean prompt.
4. Repository proof, deployment proof, and runtime proof are separate
   obligations.
5. Claims must be tied to observed or command-produced evidence.
6. Destructive actions require exact path, identity, and postcondition checks.
7. No new gate begins automatically when the previous gate closes.
8. Never use a whole-file token assertion to prove a block-scoped or
   operation-scoped invariant. Scope the inspected region, or verify the exact
   operation.

---

## 5. Architecture summary

### Delivery

- The application is maintained in the canonical GitHub repository.
- The production site is served through GitHub Pages at `sormena.no`.
- The main application is currently concentrated in `index.html`.
- GitHub Pages deployment run #233 successfully built and deployed commit
  `8170cf05082bfca83f16545f6eda32b6b09c10d2`.

### Commit-time migration invariant — MANDATORY CHECK

The purchases-to-expenses mirror migration is guarded by three grep counts that
must be verified on **every** commit, including commits unrelated to the
migration itself.

```
grep -c "if(WRITE_TO_PURCHASES)"  index.html  → 10
grep -c "dbAll('purchases')"      index.html  →  1
grep -c "dbFind('purchases'"      index.html  →  2
```

- These are **commit-time safety checks**, not diagnostics.
- They protect the purchases / expenses mirror migration.
- They must remain at **10 / 1 / 2** unless a separately approved migration
  deliberately changes them.
- **Older notes showing a value of 9 are superseded.** The verified current
  baseline is 10.
- A mismatch requires **STOP and investigation**, never automatic correction.
  A changed count means either an unintended edit to the migration surface or
  an approved migration step — and which one it is must be established before
  proceeding.

### Authentication state

- The existing PIN login remains the only live identity path at the Gate 3A
  closure point.
- Gate 3A added Firebase Auth identity machinery as dormant and unwired
  scaffolding.
- No new email/password interface was visible in production.
- No new Auth submit control or Auth error surface appeared.
- An existing valid PIN successfully opened the application during
  case 20 / P13.

### Dormant Gate 3A elements

The deployed source contains the foundations needed for later activation,
including:

- identity generation and settlement state;
- a guarded identity pipeline;
- guarded entry to tenant data;
- signed-out teardown and explicit-logout teardown as separate routines;
- a `#main-app` hide path;
- a hidden credential container;
- dormant error classifications, including `AUTHZ_CLAIM_ERROR` and
  `IDENTITY_LOAD_ERROR`;
- a 30-second identity timeout settlement path;
- no observer registration, Auth handler wiring, or credential-submit behavior
  at Gate 3A.

### Known data relationships to preserve

Current source analysis has identified the employee and shift relationship as
central:

- employee records are held in the `ansatte` area;
- shift/time records are held in `vakter`;
- `vakter.ansattId` links a shift to the employee document identity;
- employee history must remain connected when an employee becomes inactive.

Known employee fields include name, job title, hourly wage, address, email,
bank account, national identity number, notes, active/inactive status, and
creation timestamp. Known shift fields include employee ID, date, start time,
end time, registered hours, and note. **These fields must be re-verified
against current source before any schema migration.**

---

## 6. Gate 3A closure record

### Implementation

| Evidence | Value |
|---|---|
| Commit | `8170cf05082bfca83f16545f6eda32b6b09c10d2` |
| Parent | `b87e28d5a224837ee82fa5066740d05809564a48` |
| Subject | Land Gate 3A Auth scaffolding, dormant and unwired |
| Changed files | Modified `index.html`; added `docs/architecture/auth-m2-gate3a-decision-record.md` |
| Commit size | 234 insertions, 0 deletions |
| `index.html` blob | `b5c028c3fc93b645e3c55fd15f76f12c9ebfc548` |
| Decision-record blob | `a79582af6b7c8c69b72eb2b27d366921911bac1f` |

### Verification

- Static review confirmed the approved dormant and unwired scope.
- **Twelve protected legacy functions were proven byte-identical** during the
  Gate 3A audit, by extraction and SHA-256 comparison against a pre-edit
  snapshot: `initFirebase`, `startListeners`, `settleStartup`, `stopListeners`,
  `resetLocalCollections`, `showStartupError`, `retryStartup`, `checkPin`,
  `checkLoginSession`, `onLoginUserChange`, `pinDelete`, `logoutUser`.
- The migration sanity baseline remained at 10 / 1 / 2 throughout.
- Local HEAD and origin/main were confirmed level at the exact commit.
- GitHub Pages run #233 completed successfully for branch `main` and commit
  `8170cf0`.
- Build, report-build-status, and deploy jobs succeeded.
- Herish personally completed one production observation on the deployed
  commit: normal login screen, valid PIN success, no visible email/password
  fields, no new submit control, no new Auth error surface, and normal
  application behavior.

### Evidence cleanup

Two temporary Gate 3A audit exports were verified twice against pinned line
counts, byte counts, MD5, and SHA-256 values, then deleted in the same shell as
their final revalidation. Both paths were confirmed absent, including symlink
checks. The repository remained unchanged before and after cleanup.

The deleted evidence exports must not be treated as recoverable artifacts.
Their verified conclusions are preserved in the commit, decision record,
deployment record, and this continuity document.

### Maintenance note

GitHub displayed a Node.js 20 deprecation annotation during the Pages workflow.
It did not block the successful build or deployment and is recorded as future
maintenance, not as a Gate 3A finding.

---

## 7. Important architectural decisions already made

1. Gate 3A is dormant scaffolding only; no Auth observer, handler, or submit
   behavior is wired.
2. Existing PIN login must remain unchanged until a separately authorized
   activation gate.
3. `SIGNED_OUT` is an outcome, not stored coordinator state.
4. Identity pipeline success may enter tenant data only after binding checks
   succeed.
5. The identity pipeline itself must not call canonical signed-out teardown; a
   future observer-null path handles that lifecycle.
6. Explicit logout and signed-out teardown remain separate routines.
7. The hidden credential container remains inert and invisible at Gate 3A.
8. Timeout settles `IDENTITY_LOAD_ERROR`; it is not represented by the literal
   `timeout` inside the Gate 3A block.
9. Gate 3B must define how a settled timeout outcome reaches the user,
   including hung token refresh or employee-record reads.

Tracked decision source: `docs/architecture/auth-m2-gate3a-decision-record.md`

---

## 8. Security and privacy boundaries

### Repository-safe information

The repository may contain architecture, workflow, schema names, gate status,
hashes, deployment references, and recovery procedures that do not reveal
secrets.

### Never store in this document or repository

- passwords or temporary passwords;
- employee PINs;
- access or refresh tokens;
- API keys or private keys;
- Firebase service-account material;
- two-factor recovery codes;
- full national identity numbers;
- bank account details;
- private employee records;
- screenshots containing credentials or personal data.

### Employee-history protection — ALREADY IMPLEMENTED

The following protections are **shipped behavior**, not future requirements.
They were implemented at parent commit
`b87e28d5a224837ee82fa5066740d05809564a48` and **retained unchanged by Gate
3A**:

- destructive employee deletion is **unconditionally neutralized**;
- the ordinary delete control has been **removed** from the employee UI;
- inactive status is the normal employee-departure path;
- historical shifts and their links to employee records are preserved;
- duplicate employee names produce a **warning requiring deliberate review**
  before saving.

Do not re-implement these. Verify their continued presence before any change
that touches employee records.

### Still required

- Deactivation must prevent future access without breaking history — see §9.
- Any future administrative hard-deletion capability, if ever introduced, would
  require its own design and gate.

---

## 9. Open risks and design questions

### Must be resolved before or during Gate 3B

- How Route A credentials are created, delivered, recovered, rotated, and
  revoked.
- How a Firebase Auth identity binds to exactly one employee record.
- What an employee sees when identity loading times out or fails.
- How observer registration and signed-out teardown are activated safely.
- How current PIN users coexist with the new identity path during transition.
- How deactivation prevents future access without breaking history.

#### Parked observation — guard settlement paths

`authGuardedTenantDataEntry` returns `null` on three paths: superseded
generation, missing identity binding, and UID mismatch.

- These paths are **unreachable from the present identity-pipeline success tail
  by construction** — generation is freshly checked, and `currentUser` and the
  bound UID are assigned immediately before the guard is called.
- A future Gate 3B observer, or an alternate call path, could reach them.
- Such a path could leave the attempt **unsettled until the 30-second
  timeout**.
- Gate 3B must decide whether those paths remain impossible, settle explicitly,
  or are consumed through another defined mechanism.

This is **not a Gate 3A defect**. It is a design question created by future
wiring.

### Must be resolved before employee self-service

- Employee queries must retrieve only the signed-in employee's records; full
  collection loading followed by browser filtering is not sufficient for the
  employee portal.
- Decide the source of truth for worked time: start/end/break versus manually
  entered total hours.
- Define overnight-shift, overlap, zero-duration, negative-duration, and
  unusually long-shift rules.
- Define correction and approval behavior.
- Define whether and when hourly wage snapshots are stored so later wage
  changes do not rewrite historical labour cost.

### Later product decisions

- Locked payroll periods and reopening reasons.
- Audit trail presentation.
- Payroll and accounting exports.
- Overtime and supplement rules.
- Open shifts, shift takeover, direct exchange, and notifications.

---

## 10. Deferred work and required sequence

1. Route A credential-distribution design
2. Gate 3B design and controlled implementation
3. Refresh and reopen the parked runtime-isolation design
4. Gate 3C work and test matrix
5. Secure employee-only reads and authorization rules
6. Employee Timeregistrering V1
7. Admin / owner Timeregistrering V1
8. Production testing and acceptance

Gate 3B changes the runtime coupling, so the parked isolation design must be
refreshed against the post-3B application before Gate 3C.

> **Do not skip Route A and do not begin Gate 3B automatically.**

---

## 11. Exact next authorized step

The next project action is **design work only**:

> Define Route A credential distribution for employee onboarding, first access,
> password creation or temporary credential handling, identity-to-employee
> binding, recovery, deactivation, departure, and owner/admin responsibilities.

No implementation, credential creation, production mutation, or Gate 3B
execution is authorized by this continuity record.

---

## 12. Recovery and continuation checklist

### Repository state

This document does not name the current HEAD. Establish it from Git.

- [ ] Confirm the repository remote is `github.com/Sirrha/four-season-profit`.
- [ ] Confirm branch `main`.
- [ ] Confirm local HEAD and the **authoritative server-side `main`** are level
      at the current approved repository state. The local remote-tracking ref
      alone is not sufficient — query the server.
- [ ] Confirm the worktree and index are clean.
- [ ] Confirm that commit `8170cf05082bfca83f16545f6eda32b6b09c10d2` **exists
      in the ancestry of current `main`**:
      `git merge-base --is-ancestor 8170cf05082bfca83f16545f6eda32b6b09c10d2 main`
- [ ] Until a later approved application change exists, confirm the committed
      `index.html` blob remains
      `b5c028c3fc93b645e3c55fd15f76f12c9ebfc548`:
      `git rev-parse main:index.html`
- [ ] Determine any later authorized commits from the **newest approved
      continuity record and Git history**, not from this section.
- [ ] Confirm the migration sanity baseline is 10 / 1 / 2 (§5).
- [ ] Read `docs/architecture/auth-m2-gate3a-decision-record.md`.
- [ ] Confirm Gate 3A is closed and Gate 3B has not begun.
- [ ] Confirm the latest approved next step from the newest continuity record.

> A HEAD ahead of the Gate 3A baseline is expected and normal — documentation
> and project commits advance `main` without changing deployed application
> source. What matters is that the baseline is an ancestor and that the
> `index.html` blob is unchanged until an approved application change exists.

### Deployment verification procedure

Repository state does not establish what is being served. To prove deployment,
follow the full chain:

1. Confirm the authoritative server-side `refs/heads/main` on the `origin`
   remote — the local `origin/main` remote-tracking ref is not sufficient.
2. Open the repository's **GitHub Pages settings**.
3. Follow the **latest / last-deployed** run link.
4. Confirm the **workflow run identity** (run number).
5. Confirm the **exact deployed commit**.
6. Confirm **`build`** succeeded.
7. Confirm **`report-build-status`** succeeded.
8. Confirm **`deploy`** succeeded.
9. Confirm the **Pages environment** and the **production target**.

> **Deployment proof does not establish runtime behavior.** Runtime acceptance
> requires a separate production observation.

### Evidence discipline

- [ ] Do not infer runtime acceptance from source or deployment evidence alone.
- [ ] Never use a whole-file token assertion to prove a block-scoped or
      operation-scoped invariant. Scope the inspected region, or verify the
      exact operation.
- [ ] Do not expose or store secrets in prompts, logs, screenshots, or
      repository documents.
- [ ] Stop on any mismatch rather than improvising.

---

## 13. Private owner recovery record — maintain outside GitHub

A separate encrypted owner-only record should identify, **without copying
secrets into this file**:

- GitHub account and organization ownership;
- Firebase project ownership and billing owner;
- domain registrar and DNS provider;
- deployment account ownership;
- recovery email addresses;
- location of two-factor recovery codes;
- location of password-manager entries;
- who is authorized to recover each system;
- emergency steps if the primary phone or computer is lost.

This private record must be backed up securely in at least two independent
locations.

---

## 14. Document maintenance

Update this continuity record after each major gate, production migration,
architecture change, or ownership/access change. Do not update it for trivial
edits.

Each update should record:

- new version and date;
- previous and current deployed commit;
- gates opened or closed;
- new evidence;
- changed risks or decisions;
- exact next authorized step.

### Version history

| Version | Date | Summary |
|---|---|---|
| 1.0 | 2026-08-05 | Initial continuity snapshot after full Gate 3A closure |
| 1.1 | 2026-08-05 | Added the commit-time purchases/expenses migration invariant (10 / 1 / 2) with STOP-on-mismatch rule and supersession of the older value 9; recorded the parent-commit employee-history protections as already shipped and retained by Gate 3A; added the parked Gate 3B guard-settlement observation; added the full deployment-verification procedure with the runtime-acceptance boundary; recorded that twelve protected functions were proven byte-identical; added the block-scoped-invariant rule to governance and the recovery checklist; reframed §2's commit row as the deployed application baseline rather than current HEAD, and replaced §12's HEAD-equality requirement with ancestry and blob-identity checks so the document does not falsify itself when committed; corrected §10 to restore the canonical order, placing the runtime-isolation refresh and Gate 3C before employee-only reads and the Timeregistrering pages |

---

*Sormena Project Continuity · Internal · Version 1.1*
