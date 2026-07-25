# Auth M1 — Custom-Claims Provisioning Design

**Status:** Design agreed from a review cycle (Herish + independent reviewer). Not yet executed. This document is the source of truth for the M1 provisioning run; the script does not exist yet.

**Scope:** M1 sets Firebase Auth **custom claims** on five pre-created accounts in project `sormena-prod`. M1 changes **no app behaviour** — the app does not read claims until M2. Sections marked **[PROPOSAL — review]** are implementation detail I added on top of the agreed spec; everything else encodes the spec exactly.

Prompt of record: `SORMENA-AUTH-M1-DESIGN-DOC-001`.

---

## 1. Context

- **App:** Sormena — single-file `index.html`, Firestore project `sormena-prod`, tenant `four-season-as`.
- **Today:** No Firebase Auth. The PIN map is a UI curtain only. Firestore and Storage rules are open (`allow read, write: if true`).
- **M0 (`ff1c1b9`):** Put the open rules under version control (`.firebaserc`, `firebase.json`, `firestore.rules`, `storage.rules`). No behavioural change.
- **M1 (this doc):** Set Firebase Auth custom claims on the five accounts. **No app behaviour changes** — nothing in `index.html` reads claims yet.
- **M2 (later):** App gains real login + password reset and begins reading claims; rules tighten.

M1 is deliberately inert from the user's point of view. Its only observable effect is that `getUserByEmail(...).customClaims` returns the intended object for each of the five accounts.

---

## 2. Identity Map (authoritative)

Emails + roles only. `ansattId` is **not** hard-coded here — it is resolved at runtime by exact `navn` match against the `ansatte` collection (§4).

| Email | navn | role |
|---|---|---|
| `herishhashemi@gmail.com` | Herish Hashemi | `admin` |
| `belinbelin134@gmail.com` | Athar Abdulalim | `employee` |
| `aboudalkreman@gmail.com` | Aboud Alkreman | `employee` |
| `mariasirota9@gmail.com` | Maria Syrota | `employee` |
| `yuossefahmd202@gmail.com` | Yussef Ahmad | `employee` |

**Every claim written:** `{ role, tenantId: 'four-season-as', ansattId }`.

- Admins **carry `ansattId` too** — they register hours like everyone else. `role` is the only field that differs between admin and employee.
- **Do not "fix" the Maria name/email mismatch.** navn is `Syrota` (Y); email is `sirota` (I). This divergence is intentional and must be preserved verbatim.
- **Retire legacy PIN identities:** `Admin`, `Regnskap`, `Sormena`. These are UI-curtain identities only; they get no Auth account and no claim.

---

## 3. Credential Validation (gate before anything else)

The script aborts unless **all** of the following are true:

- `GOOGLE_APPLICATION_CREDENTIALS` is set; the file **exists and is readable**.
- `project_id === 'sormena-prod'`.
- `client_email === 'firebase-adminsdk-fbsvc@sormena-prod.iam.gserviceaccount.com'`.
- The private key / credential contents are **never printed**. The only credential fields ever logged are `project_id` and `client_email`.

Additional constraints:

- **No hard-coded key path** anywhere in the script — the credential is located exclusively via `GOOGLE_APPLICATION_CREDENTIALS`.
- The provisioning tool has **its own `package.json` and its own `firebase-admin` dependency**. It does **not** reuse `scripts/migration/node_modules`.

**[PROPOSAL — review]** Tool lives in its own directory (suggested `scripts/auth-provision/`) with a self-contained `package.json` pinning a single explicit `firebase-admin` version, so the M1 run cannot silently inherit a different SDK version from the migration tooling.

---

## 4. `ansattId` Resolution

- At runtime, match `ansatte.navn` **exactly** (string equality, no normalisation, no fuzzy match).
- The identity map **never** contains a hard-coded id.
- **Ambiguous** (more than one `ansatte` doc with that navn) or **missing** (zero docs) → **abort loudly.**

This is deliberate: it converts a silent wrong-claim (someone gets another person's `ansattId`) into a loud, visible failure that stops the run.

---

## 5. Preflight (all five, always)

Preflight **always runs for all five identities regardless of `--only`.** It **reports every failure it finds, then aborts with zero writes** — it does not stop at the first failure.

Checks:

1. Each `navn` resolves to **exactly one** `ansatte` doc.
2. Each resolved doc has `aktiv !== false`.
3. All five resolved `ansattId` are **unique**.
4. All five emails are **unique**.
5. All five Firebase Auth users **exist** (`getUserByEmail`).
6. Current claims are **read** for all five.

If any account already has **non-empty** claims → **abort unless `--allow-overwrite`.** When claims already exist, show **current vs proposed claims side by side** so the operator sees exactly what would change.

---

## 6. Execution Modes & Flags

- **Default = dry run.** Writes nothing without `--confirm`.
- **`--only=<email>`** limits the **WRITE only** — never the preflight. Preflight is always all five.
- **Idempotent.** Re-running with the same inputs converges to the same state and does not corrupt or duplicate claims.

**[PROPOSAL — review]** Flag summary the script accepts in provisioning mode:

| Flag | Effect |
|---|---|
| _(none)_ | Full preflight + dry-run diff for all five. No writes. |
| `--confirm` | Perform the writes after the write-gate (§7) passes. |
| `--only=<email>` | Restrict the write set to one account. Preflight + post-write verification still cover all five. |
| `--allow-overwrite` | Permit overwriting a **selected write target** whose existing non-empty claims differ from proposed. Applies to write targets only — it never waives an untouched-account mismatch (see *Account classification* below). |

Rollback mode (§10) uses a **disjoint** flag set and rejects combination with the above.

### Account classification during a run

After all five accounts are assessed (§5) but **before** any snapshot (§7) or any write, each identity is classified. The rules differ for accounts the run intends to write versus those an `--only` run deliberately leaves alone.

**TARGET accounts** — all five in a normal run; only the `--only` selection in an `--only` run:

| Current claims | Outcome |
|---|---|
| `== proposed` | no-op |
| empty | eligible to write |
| `!= proposed`, non-empty | require `--allow-overwrite` |

**UNTOUCHED accounts** — the non-selected accounts in an `--only` run:

| Current claims | Outcome |
|---|---|
| `== proposed` | acceptable |
| empty | acceptable — staged provisioning is valid; empty is **not** a mismatch |
| `!= proposed`, non-empty | **ABORT UNCONDITIONALLY** |

Rules:

- `--allow-overwrite` applies **only** to selected write targets; it **never** waives an untouched-account mismatch.
- On an untouched-account mismatch, the tool prints the account email, its current claims, and its proposed claims, then aborts with **exit code 4**.
- The abort occurs **before** any rollback snapshot is created and before any write — so no snapshot exists and no claim has changed.
- **Rationale:** the tool already reads and assesses all five identities. Proceeding while knowingly leaving an untouched account in an unexpected non-empty state — and still reporting success — would misreport the authorization state. That must be a loud stop.

**Implementation note (for the code step):** this classification must run after the full five-person assessment and before snapshot creation or any write. The exact function location may follow the code structure; the behaviour and ordering are mandatory, the location is not.

---

## 7. Hard Rollback Write-Gate (strict order)

Before the **first** `setCustomUserClaims`, these steps run **in this exact order**. Any failure aborts with **zero claims changed**:

1. Full five-person preflight (§5) passes.
2. Build the **exact previous-claims snapshot** for all five, in memory.
3. Write a **timestamped snapshot JSON OUTSIDE the repo** — `~/sormena-provision/rollback/`.
4. **Read it back** from disk.
5. Verify read-back equals the in-memory snapshot by **canonical / structural JSON equality** — `JSON.stringify(JSON.parse(readBack)) === JSON.stringify(inMemory)`, **not** byte-for-byte comparison.

Only **after step 5 succeeds** may the first `setCustomUserClaims` run.

Rationale: the rollback artifact must be proven durable and re-readable *before* any live state is mutated, so a crash mid-write always has a verified restore point on disk.

---

## 8. Snapshot Format

Self-identifying, so a wrong file cannot silently be used as a rollback source:

```json
{
  "schemaVersion": 1,
  "projectId": "sormena-prod",
  "tenantId": "four-season-as",
  "createdAt": "<ISO timestamp>",
  "entries": [
    {
      "email": "<email>",
      "uid": "<auth uid>",
      "navn": "<navn>",
      "previousClaims": { },
      "proposedClaims": { "role": "<role>", "tenantId": "four-season-as", "ansattId": "<id>" },
      "capturedAt": "<ISO timestamp>"
    }
  ]
}
```

`previousClaims` is `{}` where the account genuinely had no claims — an empty object is a meaningful, restorable value, not a null.

---

## 9. Post-Write Verification (all five, always)

Runs **always for all five, even under `--only`.**

- Re-read all five via `getUserByEmail`.
- **WRITTEN** accounts → stored claims **==** proposed claims.
- **UNTOUCHED** accounts → stored claims **==** captured previous claims (proves they were not touched).
- Emit **PASS/FAIL per account, labelled WRITTEN or UNTOUCHED**, plus an **overall verdict**.
- **Non-zero exit on any FAIL.**

---

## 10. Executable Rollback Mode

```
node provision.js --rollback=<abs snapshot path> --confirm-rollback
```

- **Reject combining** with `--confirm`, `--only`, or `--allow-overwrite`.
- Runs the **same exact credential validation** as §3.
- **Validate the snapshot file:**
  - `schemaVersion === 1`
  - `projectId` and `tenantId` match the approved values
  - `createdAt` is a valid ISO timestamp
  - **exactly 5 entries**
  - unique emails, unique uids
  - emails match the approved map (§2) **exactly**
  - `previousClaims` and `proposedClaims` are **plain objects** (not null, not array)
- **Validate against LIVE state:** each email resolves to an Auth user **and** live `uid === snapshot uid`. A mismatch means the account was deleted and recreated → **abort.** Never restore claims onto a different identity.
- Print the **restoration plan**. **Dry run by default;** `--confirm-rollback` restores the **exact `previousClaims`** (including `{}` where genuinely empty).
- Re-read all five, emit **PASS/FAIL + verdict.**
- Rollback **does not delete Auth accounts** — that is a manual Firebase Console action (Authentication → delete user). This is stated here so no one expects the script to do it.

---

## 11. What M1 Verification Is (and Is Not)

- **M1 verification = Admin SDK readback** — the `getUserByEmail` comparison in §9.
- Browser `getIdTokenResult(true)` is **M2**, after Auth login exists in the app. It is out of scope for M1 because the app has no login flow yet.

---

## 12. Account Creation & Credential Handling

- The five Auth accounts are **created manually in the Firebase Console** (Authentication → Add user) **before** the script runs — preflight (§5, check 5) requires they already exist.
- **Password policy [PROPOSAL — review]:** create each account with a long random temporary password (≥16 chars, generated per account). Passwords set at creation are placeholders only; they are not the credentials anyone logs in with.
- **No credential distribution in M1.** Logins are handed out in **M2**, when the app supports login and password reset. M1 never emails, prints, or otherwise distributes a usable credential.

---

## 13. Key Lifecycle

- The `sormena-prod` service-account key (id `9f6f830e1be2489ad73969d88c7e34ad40159747`) is used **only** for this provisioning run.
- It is **revoked** in Google Cloud IAM (Service Accounts → Keys) **once verification passes.**
- If a key is ever needed again, a **new** key is generated — this one is not reused after revocation.

---

## 14. Known Limitation (stated honestly)

The **UNTOUCHED** assertion (§9) compares against claims **captured at preflight**. It assumes **no other process mutates those accounts mid-run.** This is valid for a **single-operator manual M1** and is the operating assumption for this milestone. It would not hold if a second operator or automated process ran concurrently against the same accounts — out of scope for M1.

---

## 15. Open Questions / Decisions Still Required Before Execution

- **Break-glass second admin — required before M7.** A second admin account must exist before the app depends on claims for access control, so a single lost/locked Gmail account cannot lock everyone out of admin. It must be an **independent account, not a Gmail `+alias`** of Herish's address (an alias shares the same underlying login and defeats the purpose). Not part of M1; flagged so it is not forgotten.
- **Athar's role.** `employee` for M1 by **deliberate decision.** Revisitable later without a schema change — role is a single claim field.
- **[PROPOSAL — review] Tool location & naming.** Confirm the provisioning tool directory (`scripts/auth-provision/`) and entry filename (`provision.js`, as referenced by the rollback command in §10) before the script is written.
- **[PROPOSAL — review] Password-policy exact minimum.** Confirm the temporary-password length/rules in §12 are acceptable, or override.
