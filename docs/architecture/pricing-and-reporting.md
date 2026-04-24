# Pricing and Reporting Architecture Decisions

**Status:** Locked. Decided 2026-04-24 by Herish Hashemi with Sirrha and Soren.

**Scope:** How the Four Season profit app handles prices, profit calculations, historical reporting, and corrections to historical data. Any future feature that reads or writes price data must respect these rules.

---

## 1. The Three Layers

The system exposes price-related data through three distinct read paths. All three read from the same underlying sources &mdash; they are lenses, not duplicate storage.

| Layer | Source | Purpose | Stability |
|---|---|---|---|
| **Dagens** | Produktregister (current values) | Today's prices, today's margins, live operational decisions ("should I raise this price?") | Changes when register prices change |
| **Frosset** | Invoice lines (snapshot fields) | "Did this invoice actually make money?" Bank reconciliation. Monthly reports. | Stable forever, except via explicit correction (Rule B, §5) |
| **Price history** | Invoice lines, aggregated by canonical productId over time | Budgeting, seasonal patterns, supplier comparison, "price of tomater in September" | Grows monotonically as archive expands; no rewrite of past data |

Reports declare which lens they use. The UI makes that obvious to the user.

---

## 2. Invoice Line Data Model

Fields marked FROZEN are copied in at the moment the invoice is recorded and do not track later register changes.

| Field | Type | Source | Mutability |
|---|---|---|---|
| `tenantId` | ref | Set at invoice intake from session context | Set once; not correctable |
| `productId` | ref | Alias resolution at invoice intake | Set on intake; correctable via Rule B |
| `supplierId` | ref | Invoice header | Set on intake; correctable via Rule B |
| `invoiceDate` | date | Invoice header | Set on intake; correctable via Rule B |
| `quantity` | num | Invoice line | Set on intake; correctable via Rule B |
| `unit` (kg, box, piece, etc) | enum | Invoice line or register | Set on intake; correctable via Rule B |
| `buyPriceExVAT` | decimal | Supplier invoice | FROZEN &mdash; correctable only via Rule B |
| `sellPriceAtPurchase` | decimal | Register price on `invoiceDate` | FROZEN &mdash; correctable only via Rule B |
| `VATRateAtPurchase` | decimal | Register VAT on `invoiceDate` | FROZEN &mdash; correctable only via Rule B |
| `backfilled` | boolean | True if frozen fields were backfilled at migration, not truly snapshotted at intake | Set once; never changes |
| `correctionLog` | array | Append-only log (§5) | Append-only; never edited or deleted |

`sellPriceCurrent` is **not** stored on the line. It is resolved at read-time by joining on `productId` (scoped by `tenantId`) against the current Produktregister. **Dagens** reports consume it; **frosset** reports ignore it entirely.

---

## 3. Multi-Tenant Scaffolding

Every top-level entity (invoice, invoice line, product, supplier, correction log entry, user, and future bank transaction) carries a `tenantId`. Default value for all current data: `fourseason`.

Every query filters by `tenantId`. No cross-tenant reads exist in the v27 feature set.

This is infrastructure only. Multi-tenant UI (tenant switcher, cross-tenant admin) is explicitly out of scope for v27 and will be addressed as a separate project later.

---

## 4. Profit Calculations

**Frosset profit (historical)**

```
profit_frosset = (sellPriceAtPurchase - buyPriceExVAT - VAT on sellPriceAtPurchase) * quantity
```

Answers "did this invoice make money?" Does not change when register prices change.

**Dagens profit (current-state view)**

```
profit_dagens = (sellPriceCurrent - buyPriceExVAT - VAT on sellPriceCurrent) * quantity
```

Answers "what would margin be if I bought this today at same cost, at today's selling price?" Useful for spotting drift.

---

## 5. Rule B &mdash; Correction Policy for Frosset Data

Frozen fields are immutable under normal operation. Real-world data-entry errors happen &mdash; typos, stale register prices, missed promos, wrong units. The system exposes an explicit correction path.

### Requirements

Every correction to a frozen field MUST capture:

1. **Timestamp** (when)
2. **Actor identity** (who)
3. **Reason category** from a constrained list:
   - Typo / data-entry error
   - Register price was stale/wrong on invoiceDate
   - Missed promo price
   - Wrong unit selection
   - Wrong supplier or product match
   - Other (requires a note)
4. **Old value**
5. **New value**
6. **Optional free-text note**

### Audit trail

Corrections stored as append-only `correctionLog` on the invoice line. Never deleted, never silently overwritten. UI shows a visual indicator on corrected lines; full log viewable on demand.

### Gate: unique staff PINs before activation

Rule B corrections MUST NOT be enabled in production until every staff member who handles invoices has a distinct PIN. Shared PINs make the audit trail unreliable, which is worse than no audit trail.

Until this gate is passed, corrections to historical lines are not possible in the UI. The only way to fix errors is to re-enter the invoice or live with them.

### Discipline

Corrections are for errors. They are not a way to rewrite history because prices moved. If you want "what would margin be at today's prices", use **dagens**. Do not correct a frozen field.

---

## 6. Report Taxonomy

| Report | Lens | Why |
|---|---|---|
| Invoice profit (single invoice) | frosset | Prices that were true then |
| Bank reconciliation (v27) | frosset | Actual cash vs. expected profit at the time |
| Monthly category totals | frosset | Stable month-over-month |
| Per-invoice fruit/veg breakdown | frosset | Spot specific underperforming invoices |
| Margin warnings (lav GM) | dagens | Live, actionable |
| Produktregister overview | dagens | Current decisions |
| Operational dashboard (today) | dagens | Live state of the business |
| Price history charts (v28+) | price history | Aggregate over time for one productId |
| Supplier comparison (v28+) | price history | Same productId grouped by supplier over time |
| Seasonal patterns (v28+) | price history | Requires 12+ months of archive |

---

## 7. Prerequisites

### 7.1 Product identity through aliases

Every invoice line MUST resolve to a canonical `productId` in Produktregister (scoped by `tenantId`). Different suppliers name the same product differently ("5 kg klase tomater" vs. "Tomat klase rod 5kg" vs. typos). The existing alias system (Apr 22 work) is the mechanism. Unresolved lines are flagged and block reporting completeness until assigned.

### 7.2 Unit normalization

Every product declares a base unit (kg or piece) and a conversion from supplier-invoice format. Price history compares per-base-unit, never per supplier-line. Without this, "258 kr for 5 kg box" and "110 kr for 2 kg bag" cannot be compared meaningfully.

### 7.3 Unique staff PINs

Rule B audit trail is only honest if each staff member logs in with a distinct PIN. This is a hard gate for §5 activation.

---

## 8. Migration and Backfill

Existing invoice lines (as of 2026-04-24) do not have `sellPriceAtPurchase` or `VATRateAtPurchase` fields. At migration time:

1. If register history as-of `invoiceDate` is available, backfill from that.
2. Otherwise, backfill from **current** Produktregister values and set `backfilled: true` on the line.
3. The UI surfaces `backfilled: true` lines with a light visual marker so users know the frosset value is approximate.
4. Invoices recorded **after** migration are frozen from live register data and do not carry the `backfilled` flag.

---

## 9. Build Order Implications

- **v27 (Bank module)** consumes the **frosset** lens only. A frosset-only API is exposed and used.
- **v27 carries `tenantId` through the entire schema.** Tenant switching UI deferred.
- **Rule B is gated on unique-PIN deployment.** The UI for corrections stays hidden/disabled until the gate is cleared.
- **v28+ (Price history)** is a read-only layer. Does not block v27.
- **Existing reports** that today mix selling-price semantics implicitly must declare their lens and migrate to read `sellPriceAtPurchase` where historical.

---

## 10. Out of Scope

- Suggested pricing automation (auto-raising selling prices when buy cost rises)
- Multi-tenant UI/admin (schema is ready; user-facing controls are later)
- Sell-side promo/discount engine
- External accountant direct access (framed in v27 plan, built when multi-tenant UI lands)

---

*Locked 2026-04-24. Revisions require explicit invalidation of this document and build-time implications reassessed.*
