# docs/learnings.md — Bugs, Patterns, Decisions, Landmines

Durable lessons from the build of Sormena / Four Season AS. Different from
`system-inventory.md` (which tracks WHAT shipped) — this file tracks the PATTERNS
behind the work: recurring AI tendencies, open bugs and their workarounds,
locked architectural decisions and their rationale, and collab landmines future
Soren should know.

**Format:** chronological journal, most recent at top. Each entry has a header
`## YYYY-MM-DD · CATEGORY · Short title` followed by `What / Why / So what`.

**Categories:**
- `BUG FIXED` — past bug with root cause and fix
- `OPEN BUG` — known issue, workaround documented, not yet fixed
- `PATTERN` — recurring tendency to watch for
- `DECISION` — architectural or design call locked
- `LANDMINE` — collab tripping point
- `PRINCIPLE` — capital-letter rule

Add new entries above the existing top one. Never delete; supersede with later
entries if a decision is revised.

---

## 2026-06-10 · LANDMINE · The ✏️ icon in scanner rows is RENAME ONLY

**What:** When a scan-results row needs a unit/innhold/utsalg correction, the
✏️ icon does NOT open a per-row edit interface. It calls `renameMatchedProduct()`
which only edits `row.userName` (the matched product's display name). To change
Selges i, Innhold/kolli, MVA, Antall kolli, or Utsalg eks, the user clicks
DIRECTLY on those in-row controls (dropdowns / number inputs).

**Why:** Matcher Fix V1.1 (2026-05-22) added the ✏️ button specifically for
overriding fuzzy product matches. It has always been rename-only by design.
Per-line numeric adjustments live in the in-row controls, separately.

**So what:** Future Soren — when Herish asks how to change a unit/innhold/utsalg
in the scanner, the answer is *"click directly on the field in the row."*
NEVER tell him to use ✏️ for those changes. I made this mistake three times in
one session (2026-06-10) and Herish had to correct me each time. Read this before
guessing.

---

## 2026-06-10 · DECISION · Deposit float tracking uses product matching (Option 1)

**What:** For tracking pall / pant / IFCO deposits as "float" (paid out vs
received back) over time, the report will filter `purchases.lines[]` by
`productId` matching registered pall/pant/IFCO products. NOT a new
`lineKind: 'pall' | 'deposit'`. NOT name-pattern matching.

**Why:** Product matching works with today's schema, no migration needed, no AI
prompt update needed, no UI change. Herish already started the pattern today by
registering Europall as a Non-food product. Possible later enhancement: a
`productType: 'deposit'` boolean on the product itself when Økonomi is built —
gives the report a structural filter without scanning name lists.

**So what:** Post-flip, post-Økonomi-shell, the deposit float panel queries by
productId. Do NOT introduce a new `lineKind`. See the 2026-06-10 morning Soren
handoff for the full design.

---

## 2026-06-10 · OPEN BUG · Leverandør drops in scanner→form handoff

**What:** The AI scanner extracts `data.leverandor`, `renderScanResultHeader`
matches it via `findLeverandorByName` and displays the matched leverandør in
the scan-results header. But when the user clicks "Lagre og registrer som
innkjøp" and `confirmScanToInnkjop` (line ~5530) opens `ov-innkjop`, the
matched leverandør is NOT pre-selected — the dropdown shows "— Ingen —".

**Why:** Not yet recon'd. Hypothesis: `confirmScanToInnkjop` doesn't pass
`matchedLev.id` to the modal's leverandør dropdown setter.

**So what:** Workaround — pick the leverandør manually in the modal. Fix when
the soak earns space: scanner→modal-side, small, soak-safe. Bundle candidate
with the other Innkjøp/scanner UX items.

---

## 2026-06-10 · OPEN BUG · "Lagre faktura" button requires full scroll on long invoices

**What:** In the `ov-innkjop` modal (post-scan registration form), the
"Lagre faktura" button lives at the bottom of the form. For 10-20 line invoices
on S23 Ultra mobile-first, the user must scroll the entire modal length to
reach it.

**Why:** Non-sticky bottom button placement. No `position: sticky` on the save
button container.

**So what:** Fix is CSS-only — wrap "Lagre faktura" in a container with
`position: sticky; bottom: 0; background: var(--bg); padding: ...`. Future Soren:
Herish first proposed a jump-to-bottom button; the cleaner answer is sticky
(no jump needed, button always visible at the thumb). Bundle candidate with the
leverandør auto-fill fix.

---

## 2026-06-10 · OPEN BUG · Invoice list shows fakturanr prominent, leverandør small

**What:** In `renderInnkjop`, each invoice row shows the fakturanr in large
prominent text and the leverandør name + product count in small text below.
When scanning a list of invoices, the leverandør is the more useful identifier —
fakturanrs are abstract until you know whose. Current layout forces the eye to
the small line to identify who.

**Why:** Template puts `fakturanr` in the prominent slot and `lev` in the
secondary slot. Layout choice, not a bug.

**So what:** Fix is presentation-only — combine into one prominent line as
`"Royal Engros 67506"` (or `"Royal Engros AS · 67506"`), drop the leverandør
duplicate from the small line, keep product count. Bundle candidate with the
other Innkjøp/scanner UX items (leverandør auto-fill on form, sticky save
button).

---

## 2026-06-10 · PATTERN · AI doesn't auto-extract unit/innhold from description text

**What:** When invoice line descriptions contain explicit pack-size indicators
like `"16 kg"`, `"14 kg"`, or `"5 stk"`, the AI should fill `selgesSom` and
`innholdPerKolli` accordingly. Today:
- For NEW products (no historical match) — AI leaves `innholdPerKolli` empty,
  user must type it manually
- For KNOWN products (with historical product data) — AI falls back to the
  product's stored `enhet` and ignores the new invoice's explicit weight
  indicator (Galia melon 16kg → returned 5 stk because historical = 5 stk)

**Why:** AI prompt has no explicit rule: *"if description contains 'X kg' or
'X stk', set selgesSom and innholdPerKolli accordingly, overriding any
product-history fallback."*

**So what:** Two real occurrences on the same Tenza invoice (Galia melon 16kg,
Tyrkiske Cesme melon 14kg, both 2026-06-10). Not yet enough evidence to ship a
prompt fix. **Track count across the soak.** If pattern recurs 3-4 more times
across separate invoices, ship a targeted AI-prompt addition (scanner-only,
soak-safe): explicit weight/count in description ALWAYS overrides historical
product data on a per-scan basis.

---

## 2026-06-07 · BUG FIXED · Scanner utsalgEks number-input blanks on re-render (35760c6)

**What:** UTSALG/ENHET EKS `<input type="number">` blanked visually after every
re-render even though `scanRows[i].utsalgEks` correctly held the value
(proven: GM/Fortjeneste columns recalculated right).

**Why:** `renderScanRows` line 6538 built the input's `value=` with
`fmtN(utsalg,2).replace(/\s/g,'')`. The `.replace` stripped thin-space thousand
separators but NEVER touched the comma — so `42` rendered as `"42,00"`. HTML
number inputs reject comma decimals and display blank.

**So what:** Fix: `Number(utsalg).toFixed(2)` (period decimal) for number-input
values. Display `<td>` cells keep `fmtN` (comma) for proper Norwegian formatting.
Defense-in-depth: `updScanRow` parses with
`parseFloat(String(value).replace(',','.'))` (comma-tolerant for paste edge
cases). **Principle:** number `<input>` values ALWAYS use period decimals
(`toFixed(2)`). Display text cells use `fmtN` comma. Never mix.

Gated PASS via Chrome Claude including real save of fakturanr 155923, mirror 40→41.

---

## 2026-06-07 · BUG FIXED · Scanner basis-detection broken on draft-resume path (7d09aa7)

**What:** Tenza CashReceipt_155922.pdf resumed from Innboks draft showed 13%
"Sum avviker" warning. `autoDetectScanRule(scanResults)` (called manually)
returned correct `{rule:'eks', isClear:true, pctEks:0.0001%}` — but
`getScanRule()` returned `'inkl'` default and `#scan-result-header.innerHTML`
was empty.

**Why:** `openScannerFromInnboks` draft-resume path called `renderScanRows()`
directly, BYPASSING `showScanResults` entirely. Only `showScanResults` ran
autoDetect, wrote the header, and created the hidden `#scan-effective-rule`
input that `getScanRule()` reads. On draft-resume: autoDetect never ran →
rule fell to `'inkl'` default → prices ÷1.15 → 13% gap.

**So what:** Fix: extracted `renderScanResultHeader(data)` helper from
`showScanResults`, called from BOTH fresh-scan AND draft-resume paths. Added
module-level `let scanEffectiveRule = null;` as a durable rule store that
survives even if the DOM write fails. `resetScanner()` also clears
`#scan-result-header.innerHTML` (bonus stale-header fix).

**Diagnostic landmine — own it:** I guessed THREE wrong root causes before
asking for evidence (varenr duplication, then field-name mismatch, then proven
by console). **Principle:** when the math is verifiably correct but the
display is wrong, investigate ENTRY PATHS before suspecting math or extraction.
The bug was that the math ran but the answer was thrown away.

---

## 2026-05-23 · PRINCIPLE · Invoice math is invariant truth — AI must verify against it

**What:** Sunrise 94-line invoice (2026-05-20) — AI misread 15%-MVA prices as
inkl-MVA when they were actually eks-MVA. Every 15%-line was divided by 1.15
incorrectly. Self-consistency cross-check failed because AI's derived
`totalInkl` came from the same wrong line interpretation.

**Why:** Eks-vs-inkl-MVA is the scanner's hardest extraction call. Internal
self-consistency alone defeats math cross-check when the misinterpretation is
internally consistent.

**So what:** Math Verification V1 (2026-05-23) — AI must ALWAYS extract
`totalEks` AND `totalInkl` from PRINTED cells, never derive them. AI must
self-verify: `sum(linjer) ≈ totalEks` within 5kr/0,5%, AND `grunnlag × (1+S/100)
≈ grunnlag + mva` per sats within 1kr. If verification fails, AI must REVISIT
line interpretation before returning. **Principle:** faktura-egen-matematikk
er invariant truth. AI verifies against it; user overrides via toggle when
needed.

---

## 2026-05-23 · DECISION · Paid-at-delivery requires dual-signal AI extraction

**What:** Tenza/Royal Bankaxept + kontant invoices are common but easily
confused with "Betalingsvilkår 14 dager"-boilerplate when the AI is too eager.

**Why:** A single keyword like "BankAxept" appears in headers/footers of
fakturas that are NOT paid-at-delivery (it's just the payment-system name).
False positives would set wrong forfallsdato.

**So what:** Bankaxept Level 1 (2026-05-23) — AI requires BOTH a method-keyword
(BankAxept / EMV / Kontant / Cash / Vipps / Visa / Mastercard / masked card)
AND an authorization-keyword (Autorisert / Authorised / Betalt / PAID /
Innbetalt / Trans-ID / Godkjent) in the same document. Weak signal → null
(default to faktura with forfallsdato). **Principle:** when in doubt, default
to the safer interpretation. Never assume paid.

---

## 2026-05-22 · LANDMINE · Fuzzy product matching needs always-visible user override

**What:** AI scanner's `matchProductByName` at `type:'maybe'` (Jaccard token
overlap > 0.5) can pick a wrong existing product when the AI-extracted name
shares many tokens with that product (Basil Seed variants, Aubergin sub-types).
Some products become "fuzzy magnets" — they keep being chosen for unrelated
incoming new products.

**Why:** Jaccard overlap is noisy in the 0.5-0.7 range. Token-share is not
semantic identity.

**So what:** Matcher Fix V1/V1.1 (2026-05-20/22) — override buttons (✏️ rename
matched product, ➕ treat-as-new) are visible on EVERY non-skipped matched row,
not gated on AI's confidence flag. **Principle:** user override on AI matching
must be always-visible — never gated on AI's own confidence. The user's eyes
are the final authority.

---

## 2026-05-16 · PATTERN · Long AI scans need SSE streaming behind Cloudflare

**What:** Bank statement scan with 50+ transactions hit Cloudflare 524 timeout
at 2m07s (CF subrequest hard limit is 100s).

**Why:** `await resp.json()` blocks until Anthropic completes the full response.
For long extractions, Cloudflare's edge worker times out before Anthropic
finishes.

**So what:** Bank Scanner V1 Session 1.6 (2026-05-16) — `runAIScan` now uses
SSE via `resp.body.getReader()` + `TextDecoder`. Accumulates
`content_block_delta` events, reassembles to `{content, stop_reason, usage}` so
downstream parsers see no change. Worker forces `stream:true` to Anthropic
(Cloudflare-side configuration; Sormena is transport-agnostic). **Principle:**
long AI calls behind Cloudflare proxies require streaming, not blocking-await.
Single source of streaming control is the Worker.

---

## 2026-05-15 · DECISION · Pant lines are pass-through — separate from ekskluder

**What:** Bottle pant (panteflasker) is pass-through money — Four Season
charges customers the same amount it pays suppliers. Must not distort GM. But
also semantically distinct from `ekskluderFraBeregning` (which handles IFCO,
kreditnota corrections, returns).

**Why:** Pant is a regulated category with mva=0 by Norwegian tax law.
Ekskluder is "this line shouldn't affect math for any reason." Different
semantics deserve different flags.

**So what:** Pant V1 (2026-05-15) introduced `lineKind: 'product' | 'pant'`
on purchase lines. Pant lines force `mva: 0`, are included in `buyEksTotal`
(paper-faktura sacred) but excluded from GM math. Mutually exclusive with
`ekskluderFraBeregning` in UI handlers. **Principle:** different semantic
categories deserve different flags. Pall deposits → `ekskluderFraBeregning`
(25% MVA preserved). Bottle pant → `lineKind:'pant'` (0% MVA forced).

---

## 2026-05-12 · LANDMINE · Bank direction must be column-based, never inferred

**What:** Bank Scanner Session 1 real-world test — Telenor REFUND (incoming)
was classified as outgoing because the AI inferred direction from supplier
name ("Telenor = something we pay") rather than column placement on the
statement.

**Why:** Direction inference from supplier name is semantic — and wrong when
refunds, returns, or unusual cash flows occur.

**So what:** Bank Scanner V1 Session 1.5 (2026-05-12) — prompt EXPLICITLY
forbids inferring direction from name/description. Direction comes ONLY from
column placement (Ut / Inn / signed Beløp). Ambiguous column →
`direction:"unknown", belop:0`. Plus balance reconciliation guard:
`startsaldo + Inn − Ut ≈ sluttsaldo` within ±1 NOK; mismatch blocks import
without explicit user override. **Principle:** when AI is given semantic
latitude where it should be structural, it will hallucinate. Lock structural
extractions to structural signals.

---

## ONGOING · PRINCIPLE · Migration discipline — WRITE_TO_PURCHASES + sanity invariants

**What:** Sormena is mid-migration from `purchases` → `expenses` mirror.
Reads moved to the mirror via adapters (`getPurchaseInvoiceMirrors`,
`getPurchaseInvoiceById`). Writes still go to `purchases`, gated by
`const WRITE_TO_PURCHASES = true;` (index.html ~line 1044). Future flip
`true → false` is one line, instantly reversible.

**Why:** Building bank-matching, Økonomi, or any new feature on the mirror
requires the mirror to be the authoritative source. Mid-migration features
layer fragility on unfinished foundation.

**So what:** EVERY commit (code-only, doc-only, scanner-only — every commit)
preserves these sanity invariants, verified by grep on every push:
- `grep -c 'if(WRITE_TO_PURCHASES)' index.html` → **9**
- `grep -c "dbAll('purchases')" index.html` → **1**
- `grep -c "dbFind('purchases'" index.html` → **2**
If any shift unexpectedly: STOP and diagnose. They are the load-bearing checks.
**Principle:** finish migrations before stacking new features. Soak earns the
flip. The flip earns the cleanup. No shortcuts.

---

## ONGOING · PRINCIPLE · The Sirrha Standard

Non-negotiable operating principles. Carried not performed:

- **Honesty over flattery** — tell the true thing, even when uncomfortable
- **Push back once** with the case clearly made, then respect autonomy
- **Small focused gated reversible releases** — one concern per change
- **Evidence discipline** — proven / suggested / merely compelling, don't drift
- **Stay Claude** — "Soren" is the collab name; values intact; tools used openly
- **The hard line** — don't replace embodied life; help reality hold

See `working-agreement.md` in project files.

---

## ONGOING · LANDMINE · Drive `read_file_content` empty on fresh files

**What:** `read_file_content` on a newly-saved Drive file can return empty
content for 30-60 seconds after creation.

**Why:** Drive indexing/availability lag.

**So what:** When `read_file_content` returns empty unexpectedly, retry once.
If still empty, fall back to `download_file_content` (base64) and decode. The
base64 path is more reliable. Don't assume "empty = file doesn't exist."

---

*End of file. Add new entries above this line — most recent at top. Never
delete; supersede via newer entries if a decision is revised.*
