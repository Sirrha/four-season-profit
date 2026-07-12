# Bank Transaction Subsystem — As-Is Map

**Status:** Evidence-based description of the bank-reconciliation subsystem in `index.html` as it exists at commit `7349874`. This is a MAP, not a plan. Where the code contradicts itself, both sides are documented and left unresolved. Line numbers refer to `index.html`.

**Read-only:** producing this document changed no code.

---

## 0. Baseline (sanity invariants)

| grep | count |
|---|---|
| `grep -c "if(WRITE_TO_PURCHASES)" index.html` | **10** |
| `grep -c "dbAll('purchases')" index.html` | **1** |
| `grep -c "dbFind('purchases'" index.html` | **2** |

`WRITE_TO_PURCHASES` is declared at **line 1375**: `const WRITE_TO_PURCHASES=false;` — the purchases-mirror collection is gate-disabled in production. The expense mirror (`expenses` collection) is the D8 source of truth (comment at 4695, 4802–4803).

---

## 1. The bankTransaction record

The authoritative shape is minted by the AI-import path (`payload`, **8762–8789**). Later workflows add reverse-link fields. Every field:

| Field | Type | Written by (fn @ line) | Read by | Meaning |
|---|---|---|---|---|
| `id` | string | AI import `uid()` @ 8761,8763 (Firestore doc id replaces on `dbAdd`) | everywhere via `dbFind('bankTransactions',id)` | tx identity |
| `tenantId` | string `'fourseason'` | 8764 | tenant scoping | fixed tenant tag |
| `dato` | `YYYY-MM-DD` | 8765 | status/render, `saveBrLink` amount base indirectly | transaction date |
| `bookingDato` | `YYYY-MM-DD` | 8766 | render | bank booking date |
| `leverandorId` | string (empty at import) | 8767 (`''`) | `inferSupplierFromTx` (3753 checks `tx.leverandorId`) | supplier link — **never populated at import**, only via inference |
| `levTekstRaa` | string | 8768 (`tx.motpart`) | `inferSupplierFromTx` haystack (3755) | raw counterparty text |
| `belop` | number (abs, 2dp) | 8769 | `getBankTxStatus` (indirectly), `computeRemainder` (3901), `saveBrLink` (3591) | **absolute** amount; sign lives only in `direction` |
| `valuta` | `'NOK'` | 8770 | render | currency |
| `bankkonto` | string | 8771 (`data.kontonummer`) | render | account number the statement is for |
| `referanse` | string (`''`) | 8772 | — | reserved, unused |
| `arkivref` | string | 8773 (`ref`) | render (3719) | bank archive ref |
| `bankReference` | string | 8774 (`ref`) | — | duplicate of arkivref |
| `metode` | string `'transfer'` | 8775 (hardcoded) | — | **hardcoded**, never classified |
| `linkedeFakturaer` | string[] of `linkedPurchaseId` | **`saveBrLink` 3604**, **`removeBrLink` 3631**, **`saveAllocations` 4063**; init `[]` @ 8776 | **`getBankTxStatus` 3490** (green), `getLinkedInvoicesForTx` 3565 | invoice ids linked to this tx |
| `linkedAllocations` | object[] `{invoiceId,amountApplied,type,leverandorId,source,note}` | **`saveBrLink` 3604**, **`removeBrLink` 3631**, **`saveAllocations` 4063**; init `[]` @ 8777 | `computeRemainder`/`isFullyAllocated` (3900–3908), `getDraftAllocs` seed (3890) | per-allocation amounts driving "balansert" |
| `linkedDocumentIds` | string[] | **`linkDocumentToBankTx` 4194**, **`unlinkDocumentFromBankTx` 4310** | `renderDocumentsSection` (via docs), NOT read by status | uploaded document ids |
| `documentedExpenseId` | string (expense id) | **`submitReceiptExpense` 4485**, **`submitPaidInvoice` 4624** | **`getBankTxStatus` 3495** (green) | expense id that "settles" the tx (receipt/paid-card path) |
| `documentedAt` | ISO string | `submitReceiptExpense` 4485, `submitPaidInvoice` 4624 | — | when documented |
| `opprettetAv` | string | 8778 | — | who imported |
| `opprettet` | ISO string | 8779 | sort in `getLatestImportBatch` (3514) | import timestamp |
| `notat` | string | 8780 | — | free note |
| `type` | string `'supplier_payment'` | 8781 (hardcoded) | **not read anywhere** (grep `tx.type` → no hits) | dead/aspirational type tag |
| `direction` | `'in'`\|`'out'`\|`'unknown'` | 8782 (`dir`, from AI column or belop sign @ 8760) | **`getBankTxStatus` 3496**, render (5818), summary (5657) | flow direction |
| `period` | string | 8783 | grouping | statement period |
| `statementId` | string | 8784 | scoping to a statement | parent statement |
| `importBatchId` | string | 8786 | `getLatestImportBatch` (3512) | import batch |
| `rawDescription` | string | 8787 (`tx.beskrivelse`) | `inferSupplierFromTx` haystack (3755), `getTxDisplayDescription` | raw line text |
| `aiExtracted` | bool | 8788 | `getLatestImportBatch` filter (3512) | AI-imported flag |

**Fields written by more than one path** (contract-critical):
- `linkedeFakturaer` + `linkedAllocations` — written together by **three** functions: `saveBrLink` (3604), `removeBrLink` (3631), `saveAllocations` (4063). Two of these (saveBrLink, saveAllocations) are *writers* with **different amountApplied math** (see §4.4 vs §4.5).
- `linkedDocumentIds` — written by `linkDocumentToBankTx` (4194) and `unlinkDocumentFromBankTx` (4310).
- `documentedExpenseId` + `documentedAt` — written by `submitReceiptExpense` (4485) and `submitPaidInvoice` (4624).

---

## 2. Status derivation — what makes a row green

`getBankTxStatus` (**3489–3498**), quoted in full:

```js
function getBankTxStatus(tx){
  const hasLinks=Array.isArray(tx.linkedeFakturaer)&&tx.linkedeFakturaer.length>0;
  if(hasLinks)return 'matched';
  // V2C.5.2c.2: a documented direct expense (receipt) completes reconciliation —
  // deliberate divergence from bare credit/refund/review allocations, which stay
  // unmatched/review (DESIGN-010 D4). A card purchase IS the tx; documenting it settles it.
  if(tx.documentedExpenseId)return 'matched';
  if(tx.direction==='in'||tx.direction==='unknown')return 'review';
  return 'unmatched';
}
```

Conditions per status:
- **`'matched'`** (green) — EITHER `linkedeFakturaer.length>0` (3490–3491) OR `documentedExpenseId` truthy (3495).
- **`'review'`** (orange "Klar for gjennomgang") — no links/no doc AND `direction` is `'in'` or `'unknown'` (3496).
- **`'unmatched'`** (red "Ikke matchet") — no links/no doc AND `direction==='out'` (fallthrough 3497).

**Status is DERIVED, never stored — confirmed.** No `status` field exists on the tx record (§1 has none), and every consumer computes it live: filter (5767), summary (`getBankReconSummary` 3504), row render (5816). The label map is at 5823: `{matched:'Matchet',unmatched:'Ikke matchet',review:'Klar for gjennomgang'}`.

**Two INDEPENDENT rules produce `'matched'`:**
1. `linkedeFakturaer` non-empty (invoice-linked / allocation path).
2. `documentedExpenseId` set (receipt / paid-card path).

These are checked in sequence and never cross-checked. A tx can be green by rule 2 while `linkedeFakturaer` is empty — and the koblinger panel (§8) reads only `linkedeFakturaer`. No third rule was found. Neither rule consults `linkedAllocations` amounts, so **green is independent of balance** (§3).

---

## 3. Balance derivation — what makes a row "balansert"

`computeRemainder` + `isFullyAllocated` (**3900–3908**):

```js
function computeRemainder(tx,allocs){
  const belop=Math.abs(Number(tx.belop)||0);
  const allocated=(allocs||[]).reduce((sum,a)=>sum+(Number(a.amountApplied)||0),0);
  return belop-allocated;
}
function isFullyAllocated(tx,allocs){
  return Math.abs(computeRemainder(tx,allocs))<=0.01;
}
```

It sums **`linkedAllocations[].amountApplied`** (via draft allocs seeded from `tx.linkedAllocations`, `getDraftAllocs` 3890) against `Math.abs(tx.belop)`. Tolerance ±0.01. The "✓ Fullt fordelt" / "Resterende" / overflow UI is `renderRemainderSection` (3950–3974). The save button is gated by `isFullyAllocated(tx,draftAllocs)` (3735).

**Relationship between GREEN and BALANSERT — they are driven by different fields and CAN disagree:**
- GREEN ← `linkedeFakturaer.length>0` **or** `documentedExpenseId` (3490,3495).
- BALANSERT ← `Σ linkedAllocations.amountApplied ≈ |belop|` (3902,3907).

**Concrete divergent state from the code:** `submitReceiptExpense` (4485) sets `documentedExpenseId` but writes **nothing** to `linkedAllocations`. So a receipt-documented tx is **green** (rule 2) yet `computeRemainder` returns the full `|belop|` as remaining → **not balanced**. The receipt path simply never enters the allocation UI, so the balance concept is silently bypassed. Conversely, a partial hand-built allocation set that does not sum to `|belop|` can never be saved (`saveAllocations` guard 4048), so "balanced but not green" cannot be *committed* — but a draft can be balanced (button enabled) before any `linkedeFakturaer` write lands.

---

## 4. The workflows — every path that settles a transaction

### 4.1 Invoice registration — `submitInvoiceRegistration` (4726)

- **Entry:** "Registrer" button on a document row (`v2c5-2a-register-btn`, built at 4646 → `openInvoiceRegistrationModal` 4700). Modal `#v2c5-2a-modal` (1011).
- **Modal fields:** Leverandør*, Faktura nr*, Beløp inkl. MVA*, Fakturadato*, Forfallsdato, MVA (free amount), KID, Notat (1016–1029). **No category field.**
- **Creates:** expense record `expenseKind:'purchase_invoice'` (4774), deterministic id `'mirror-'+newId` (4804–4805). `linkedPurchaseId:newId` (4786). `categoryId:null,categoryLabel:null` (4785). Also `linkDocumentToInvoice(docId,newId)` (4807, doc→invoice).
- **Writes onto the tx:** as of commit `7349874`, **`await saveBrLink(txId,newId)` (4808)** — this now writes `linkedeFakturaer=[newId]` + a full-amount `linkedAllocations` entry (see §4.5). Before that commit it wrote **nothing** to the tx.
- **Resulting status:** `'matched'` via rule 1 (linkedeFakturaer non-empty), AND balanced (single alloc = full `|belop|`).
- **linkedAllocations entry:** yes — via saveBrLink, `amountApplied = belop/1 = |belop|`.
- **Guard:** hard duplicate block on `leverandorId + normalized invoiceNumber` (4742–4765). `WRITE_TO_PURCHASES`-gated purchases mirror is a no-op in prod (4794–4801).

### 4.2 Receipt / direct expense — `submitReceiptExpense` (4454) — *first full mapping*

- **Entry:** receipt/kvittering action → `openReceiptExpenseModal(txId,docId)` (4377). Modal `#v2c5-2c2-modal` (1037).
- **Modal fields (markup 1042–1052):** Beskrivelse* (`v2c5-2c2-merchant`), Forhandler/leverandør picker (`v2c5-2c2-lev`), Dato*, Beløp inkl. MVA* (prefilled = `|tx.belop|`, 4392), **Kategori\*** (`v2c5-2c2-category`), MVA (free amount, optional), Notat.
- **CATEGORY: yes, but only two options.** `openReceiptExpenseModal` populates the select from `DEFAULT_EXPENSE_TAXONOMY['misc']` **only** (4384–4386) = `[{drivstoff},{annet}]` (1691–1694), with `drivstoff` preselected. The full 12-kind taxonomy (§6) is NOT offered here. A merchant's `defaultCategoryId` can override the selection (4418–4420).
- **MVA:** a free-form kr **amount** field (`vatAmount`, 4461), NOT a rate/sats. `totalExVat=Math.max(0,total-vatAmount)` (4474).
- **Creates:** expense via `buildExpenseDocFromOperatingForm` (4472) then augmented: `expenseKind:'misc'` (4473), `source:'v2c5.2c.2_receipt'`, `processingLevel:'receipt'`, `linkedBankTransactionId:txId`, `linkedDocumentId:docId` (4480–4481). Written via `dbAdd('expenses',record)` → **random Firestore id** (4483). Also `dbUpdate('documents',docId,{linkedExpenseId:expId})` (4484).
- **Writes onto the tx:** `dbUpdate('bankTransactions',txId,{documentedExpenseId:expId,documentedAt:now})` (4485). **Does NOT write `linkedeFakturaer` or `linkedAllocations`.**
- **Resulting status:** `'matched'` via rule 2 only. **Not balanced** (§3), and the koblinger panel shows empty (§8).
- **linkedAllocations entry:** none.

### 4.3 Paid invoice (card-paid) — `submitPaidInvoice` (~4590) (4624 write)

- **Entry:** paid-by-card action → `openPaidInvoiceModal(txId,docId)` (4504). Modal `#v2c5-2c3-modal` (1060).
- **Modal fields (1066–1082):** Leverandør/forhandler, Fakturanr*, KID, Fakturadato*, **Kategori** (optional), Dokumentbeløp* (from PDF), Bankbetalt beløp* (card charge), MVA (free amount), Notat. Has a rounding-diff display (`updatePaidRoundingDisplay`) and a mismatch check (`runInvoiceMismatchCheck`).
- **CATEGORY:** same `DEFAULT_EXPENSE_TAXONOMY['misc']` two-option list, plus a "— Ingen kategori —" blank (4509–4511). Optional (no `*`).
- **Creates:** expense `expenseKind:'misc'` (4611), `source:'v2c5.2c.3_paid_invoice'`, `processingLevel:'paid_invoice'`, keeps invoice identity (`invoiceNumber`, `kid`, `documentAmount`, `roundingDiff`, `paidByCard:true`), `linkedPurchaseId` stays null → **no debt** (4618–4620). `dbAdd('expenses',record)` → **random id** (4622). `dbUpdate('documents',docId,{linkedExpenseId:expId})` (4623).
- **Writes onto the tx:** `dbUpdate('bankTransactions',txId,{documentedExpenseId:expId,documentedAt:now})` (4624). No `linkedeFakturaer`/`linkedAllocations`.
- **Resulting status:** `'matched'` via rule 2. Not balanced.
- **Difference from 4.2:** preserves invoice identity (nr/KID/dato) and separates document amount from bank-paid amount (rounding diff); receipt (4.2) has no invoice identity and forces amount == `|tx.belop|`. Both set `expenseKind:'misc'` and both settle via `documentedExpenseId`.

### 4.4 Picker allocation — `selectPickerInvoice` (3821) + `saveAllocations` (4038)

- **Entry:** clicking a picker result row (`renderPickerResultRow` onclick 3810) on an unmatched/review tx; "Lagre denne transaksjonen" button (3736) → `saveAllocations`.
- **`selectPickerInvoice` (3821–3844):** pushes a **draft** alloc into `window._brAllocs[txId]` (via `getDraftAllocs` 3886); writes NOTHING to the DB; re-renders. `amountApplied = Math.min(invoiceTotal, Math.max(0,remainder))` (3834).
- **`saveAllocations` (4038–4070):** filters zero-amount allocs (4043), requires `isFullyAllocated` (4048), then `dbUpdate('bankTransactions',txId,{linkedeFakturaer:invoiceIds,linkedAllocations:cleanAllocs})` (4063). `invoiceIds` = only `invoice_payment` allocs (4052–4054). Clears draft (4067).
- **Supported allocation `type` values (all found):**
  - `invoice_payment` — `selectPickerInvoice` (3838), also saveBrLink/removeBrLink (3598,3625).
  - `supplier_credit` — `addCreditAllocation` (3999).
  - `expected_refund` — `addRefundAllocation` (4014).
  - `unapplied_review` — `addReviewAllocation` (4031).
  - The last three set `invoiceId:null` and `amountApplied:remainder` (fills the balance). Only `invoice_payment` allocs land in `linkedeFakturaer`, so a tx settled purely by credit/refund/review is **balanced but NOT green** (no `linkedeFakturaer`, no `documentedExpenseId`) — it stays `review`/`unmatched`. This is called out as deliberate in the 3492–3494 comment.

### 4.5 `saveBrLink` (3579) — canonical single-invoice linker

- Whole-invoice linker: pushes `invoiceId` to `linkedeFakturaer` (3589) and rebuilds `linkedAllocations` with **even split** `amountApplied = belop / current.length` (3592). For one invoice that is the full `|belop|` → green + balanced by construction.
- Guards: dup-link check `current.includes(invoiceId)` (3585). Writes at 3604. Toast "Kobling lagret ✓" (3605) + `renderBetalinger()` (3607).
- **Reused by:** the candidate-suggestion click (3679) and now invoice registration (4808).

### 4.6 Complete writer list (`dbUpdate('bankTransactions'`) — authoritative

| Line | Function | Fields written | Covered in |
|---|---|---|---|
| 3604 | `saveBrLink` | `linkedeFakturaer`, `linkedAllocations` | §4.5 |
| 3631 | `removeBrLink` | `linkedeFakturaer`, `linkedAllocations` | (unlink; mirror of 4.5) |
| 4063 | `saveAllocations` | `linkedeFakturaer`, `linkedAllocations` | §4.4 |
| 4194 | `linkDocumentToBankTx` | `linkedDocumentIds` | §1 (doc upload) |
| 4310 | `unlinkDocumentFromBankTx` | `linkedDocumentIds` | §1 (doc unlink) |
| 4485 | `submitReceiptExpense` | `documentedExpenseId`, `documentedAt` | §4.2 |
| 4624 | `submitPaidInvoice` | `documentedExpenseId`, `documentedAt` | §4.3 |

All seven writers are accounted for by §4.1–§4.5 plus the two document-link helpers. No writer sets a `status` field (confirming §2). `removeBrLink` (3631) is the only pure "un-settle" that rebuilds allocations for the remaining invoices.

---

## 5. The expense record

`expenseKind` values assigned in code (grep `expenseKind:`):

| Value | Created by | Category/konto/MVA | Links to tx? | Id style |
|---|---|---|---|---|
| `purchase_invoice` | `submitInvoiceRegistration` (4774); `shadowCreateExpense` (9656); operating form (9877/10070 via `kind`) | `categoryId:null` at register (4785); MVA free amount | `linkedBankTransactionId:txId` (4783) | **`mirror-<id>`** deterministic (4804) |
| `misc` | `submitReceiptExpense` (4473); `submitPaidInvoice` (4611) | category from `misc` taxonomy (drivstoff/annet); MVA free amount | `linkedBankTransactionId:txId` (4481,4620) | **random `dbAdd` id** (4483,4622) |
| (other kinds `rent`/`utility`/`salary`/… ) | operating-expense form `buildExpenseDocFromOperatingForm` (9870) with `kind` (9877/10070) | full taxonomy per kind | varies | varies |

**Two id styles, two paths — confirmed:**
- **Deterministic `mirror-<id>`** — invoice registration (4804–4805), matching `shadowCreateExpense` convention.
- **Random `dbAdd` id** (e.g. `DpBy48OEf88xNCg12C11`) — receipt (4483) and paid-invoice (4622) paths.

This is why a `documentedExpenseId` value looks like a "document id" — it is a random Firestore expense id, format-indistinguishable from a document id, and unrelated to the `mirror-` id an invoice registration would produce for the same tx.

The full expense enum/vocabulary lives at 1608–1629 (`EXPENSE_KINDS`, `EXPENSE_KIND_LABELS`, `OPERATIONAL_STATUS`, `ACCOUNTANT_STATUS`, `MISSING_REASONS`, `VAT_STATUS`).

---

## 6. Categories, konto and MVA (the accounting question)

**Categories: YES, a taxonomy exists — but it is barely wired into the bank paths.**

- `DEFAULT_EXPENSE_TAXONOMY` (**1635–1695**) defines category lists for 12 expense kinds: `purchase_invoice:[]` (empty), `rent`, `utility`, `salary`, `vat_tax` (MVA-termin, Forskuddsskatt), `bank_fee` (Kortgebyr, Kontogebyr, Transaksjon), `accounting_fee`, `insurance`, `subscription`, `service`, `equipment_purchase`, `misc` (Drivstoff, Annet).
- `CATS` (**1240–1259**) is a **separate, product** category set (Frukt, Grønnsaker, Røyk/Tobakk, …) for the grocery inventory — NOT expense accounting.
- **In the bank workflows, only `misc` is surfaced.** Receipt (4384) and paid-invoice (4509) modals both read `DEFAULT_EXPENSE_TAXONOMY['misc']` = two options. Invoice registration captures **no** category (`categoryId:null` 4785). So in practice a reconciled tx carries at most "Drivstoff" or "Annet", or nothing.
- Leverandører can carry a `defaultCategoryId` (4418, 4447, 4543) applied when picked.

**Konto (ledger account code): DOES NOT EXIST.** Grep for `kontoCode|accountCode|hovedbok|ledgerAccount` → **zero hits**. Every `konto`-named field is a **bank account number** (`bankkonto` at 3525, 6000, 6719, 8771). No expense or transaction carries a chart-of-accounts / hovedbok code. **This is a critical finding for the Fiken-replacement goal: there is no account-code layer today.**

**MVA (VAT): two disconnected representations.**
- **Purchase/innkjøp product lines** use a real **rate** dropdown `vatRate ∈ {0,15,25}` (2236–2239, 2750–2752) fed into `calcKolliLine` (1488).
- **Bank-path expenses** (register/receipt/paid) capture MVA only as a **free-form kr amount** (`vatAmount`/`vat`), never a rate — receipt 4461, paid 4595, register 4771. `totalExVat` is derived by subtraction. There is a `VAT_STATUS=['normal','vatUnknown','vatNotApplicable']` enum (1629) but the bank paths set `vatStatus:'normal'` (register 4780) without validation.

---

## 7. Transaction types the model does NOT handle

**There is no transaction-type classification.** The AI import hardcodes `type:'supplier_payment'` on every row (8781) and that field is **never read** (grep `tx.type` → no functional hits). The AI prompt classifies **only `direction`** (in/out/unknown) strictly by statement column, and is explicitly forbidden from inferring type from description (8225–8236). `metode` is hardcoded `'transfer'` (8775).

Consequence for non-invoice, non-receipt transactions:

| Tx kind | What happens today |
|---|---|
| Internal transfer (Kontoregulering) | No type tag. If `direction==='out'` → `unmatched` (red); if `in`/`unknown` → `review`. No dedicated close path. |
| Cash deposit (incoming) | `direction==='in'` → `review`. Stuck in review unless force-allocated. |
| Bank fee / Kortgebyr | `direction==='out'` → `unmatched`. A `bank_fee` taxonomy exists (1658–1662) but no bank-path UI surfaces it; only closable by fabricating a `misc` receipt or a credit/review allocation. |
| Interest / Rente | Same as above — no path. |
| Tax / MVA payment | `vat_tax` taxonomy exists (1654–1657) but unreachable from the bank screen; `out` → `unmatched`. |
| Incoming customer payment | `direction==='in'` → `review`; the credit/refund/review allocation types (§4.4) are the only close mechanism, none of which is semantically "customer sale settled". |

**Honest answer: for anything that is not an invoice payment or a card receipt, no first-class settlement path exists.** The only generic escape hatches are `addReviewAllocation` (parks the amount as `unapplied_review`, balances but stays non-green) and `addCreditAllocation`/`addRefundAllocation` (supplier-scoped, require an inferred supplier). None of these produces a "matched" state or records a category/konto for the transaction.

---

## 8. Known contradictions and integrity gaps

1. **Green-but-empty-panel.** `getBankTxStatus` can return `matched` via `documentedExpenseId` (3495) while `linkedeFakturaer` is empty. The matched expand panel builds invoice cards from `getLinkedInvoicesForTx` (3564–3569), which reads **only** `linkedeFakturaer` → renders "Ingen koblinger funnet" (3664) on a green row. The `documentedExpenseId` expense is never surfaced as a kobling. (The row's KVITTERING still shows via `renderDocumentsSection` 3665, but not as an invoice link.)

2. **Two independent 'matched' rules never reconcile with balance.** Rule 1 (`linkedeFakturaer`) and rule 2 (`documentedExpenseId`) are checked in sequence (3490,3495) and neither consults `linkedAllocations`. A rule-2 (receipt) match is green but `computeRemainder` still reports the full amount outstanding (§3). Green and balansert are computed from different fields and can disagree with no reconciliation.

3. **Two allocation writers with divergent `amountApplied` math.** `saveBrLink` splits evenly `belop/n` (3592); the picker path uses `min(invoiceTotal, remainder)` (3834). For a single full-amount invoice they agree; for multi-invoice or partial cases they produce different per-alloc numbers for the same conceptual link. Both write the same field with the same object shape (3595–3602 vs 3835–3842), so the divergence is silent.

4. **Two expense id styles from two paths.** `mirror-<id>` (invoice registration, 4804) vs random `dbAdd` id (receipt/paid, 4483/4622). A `documentedExpenseId` therefore cannot be assumed to match the `mirror-` id of an invoice registered against the same tx — the two documentation paths can both touch one tx and produce two unrelated expense records.

5. **Misleading register toast.** `submitInvoiceRegistration` shows "Faktura registrert ✓ — velg den i listen for å allokere" (4808→4809 region, the `showToast` after the new `saveBrLink` call). Since commit `7349874` `saveBrLink` **already allocates** the tx, so the instruction to go allocate it manually is now inaccurate/stale.

6. **`type` and `metode` are dead/hardcoded.** `type:'supplier_payment'` (8781) and `metode:'transfer'` (8775) are stamped on every imported tx and never read — they imply a classification the code does not actually perform (§7).

7. **`bankReference` duplicates `arkivref`.** Both set to `ref` (8773–8774); one is redundant.

8. **`leverandorId` on tx is import-empty and never back-filled.** Set to `''` at import (8767); the app relies on `inferSupplierFromTx` name-matching (3752–3762) at read time instead, so supplier identity on a tx is recomputed heuristically every render rather than stored.

9. **Category coverage gap.** A full 12-kind expense taxonomy exists (1635) but the bank workflows only ever offer `misc`'s two options, and invoice registration offers none (§6). Reconciled transactions are effectively uncategorized for accounting purposes.

10. **No konto layer at all** (§6) — the single largest gap relative to replacing Fiken.

---

## 9. Open questions for the contract session (human design decisions)

1. **What does "done"/"matched" mean?** Should green be derived from **one** source of truth, or continue to have two independent rules (invoice-linked vs receipt-documented)? Should a balanced-but-non-green allocation (credit/refund/review) count as "done"?
2. **Should the koblinger panel show `documentedExpenseId` expenses?** Today a receipt-documented (green) tx reads "Ingen koblinger funnet". Is a receipt supposed to appear in a "Koblede fakturaer" panel at all, or should that panel be renamed/reframed for receipts?
3. **Should green and balansert be unified,** or are they intentionally orthogonal (settled vs fully-allocated)? If unified, which field wins?
4. **Transaction typing:** should imports classify transfer / fee / interest / tax / customer-payment, and should each get a first-class close path? What is "done" for an internal transfer that has no counterparty invoice?
5. **Categories & konto:** for the Fiken-replacement goal, should every reconciled tx require a category, and should categories map to konto (chart-of-accounts) codes? The taxonomy exists but is unreachable from the bank screen and carries no konto.
6. **MVA representation:** reconcile the two MVA models — rate-based (innkjøp) vs free-amount (bank paths) — into one, so VAT reporting is possible.
7. **Expense id convention:** one id style (deterministic vs random) so a tx's documented expense is discoverable/joinable without heuristics.
