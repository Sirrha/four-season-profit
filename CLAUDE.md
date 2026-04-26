# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current status

**As of 2026-04-24** — sormena.no is live on GitHub Pages; HTTPS provisioning by Let's Encrypt pending.

Architecture decisions locked in `docs/architecture/pricing-and-reporting.md` (must read before touching price, profit, or reporting code).

## System inventory rule

**docs/system-inventory.md MUST be updated after every commit that adds, removes, or significantly changes a module, screen, modal, Firestore collection, or major function.**

When working on this codebase:
1. Before making changes — read docs/system-inventory.md to understand what already exists. Do not duplicate functionality.
2. After making changes — update docs/system-inventory.md to reflect the new state (line numbers, function names, collections, modals, status notes).
3. Inventory updates are committed in the same commit as the code change, OR in an immediate follow-up commit with message format "docs(inventory): ..."

This rule exists because Soren (the planning AI in chat) cannot read code directly. The inventory is the bridge. If it gets stale, Soren plans blind and Claude Code duplicates work.

## Repository shape

The entire application is **one file**: `index.html` (~5692 lines, ~300 KB). There is no build system, no package manager, no test suite, no linter config. HTML, CSS and JavaScript all live inline in that single file.

- **Run locally**: open `index.html` directly in a browser, or serve the folder statically (e.g. `python -m http.server`) — no build step.
- **Deploy**: committing to `main` is the deploy (the file is self-contained and served as a static asset).
- **Firebase config** is hardcoded in the `boot()` IIFE near the bottom of the `<script>` block; the visible setup screen (`#setup-screen`) is legacy onboarding UI that is hidden on boot and only reachable via `resetSetup()`.

When editing, preserve the existing style: terse, dense, heavily-abbreviated identifiers (`sg`, `sc`, `sv`, `li`, `lim`, `lit`, `lis`, `liv`, `fi`, `fg`, `fl`, `btn-p`, `btn-g`, `ov`, `kbox`, `krow`, etc.) and no module/class boundaries — functions are top-level in one IIFE-less `<script>`.

## Local development setup

- **Repo path**: `C:\Users\gamme\projects\four-season-profit` (Windows user `gamme`).
- **Shell**: PowerShell on Windows. Claude Code's Bash tool exposes Unix-style bash (use forward slashes, `/dev/null`), and PowerShell is available via the PowerShell tool for native Windows commands.
- **Launch**: `claude` from the repo root.
- **Same laptop** is used at both work and home — no environment drift between sessions, no separate dev/prod paths.
- **Versions** (as of 2026-04-24): git `2.54.0.windows.1`, node `v24.15.0` (node is used only for `node --check` on the inline JS before shipping — see workflow conventions below).
- **Git**: branch `main` is the deploy branch; remote is `github.com/Sirrha/four-season-profit`; committing to `main` publishes to sormena.no via GitHub Pages.

## Domain

The app is an internal ops tool for **Four Season AS**, a grocery store in Norway. All UI text and most data fields are in **Norwegian**. Key terms you will encounter constantly:

| Norwegian | Meaning |
|---|---|
| innkjøp / faktura | purchase / invoice |
| salg / dagsalg | sale / daily-total sale (from POS Z-report) |
| svinn | waste / shrinkage |
| leverandør | supplier |
| kolli | case / box (the purchase unit) |
| påslag | markup % (vs. GM %, which is margin on sell price) |
| vakt / ansatt / timeliste | shift / employee / timesheet |
| MVA | VAT (15% food, 25% non-food/tobacco) |

Dates are stored as `YYYY-MM-DD` (ISO) and displayed as `DD.MM.YYYY`. Numbers are formatted with `nb-NO` locale (comma decimal, space thousands, `kr` prefix).

## Architecture

### Data layer — Firestore as the source of truth

10 Firestore collections, mirrored into a single in-memory object `LOCAL`:

```
products, purchases, sales, svinn, leverandorer, dagsalg, innboks, ansatte, vakter, payments
```

`startListeners()` attaches an `onSnapshot` listener per collection. Every snapshot overwrites `LOCAL[col]` and calls `renderIfActive(col)` → `renderPage(currentPage)`. **There is no local optimistic update** — all writes go through `dbAdd` / `dbUpdate` / `dbDelete`, and the UI repaints when Firestore echoes the change back. If you add a new collection, it must be added to the `cols` array in `startListeners()` and to the `LOCAL` initializer, or its listener will never fire.

Reads use `dbFind(col, id)` / `dbAll(col)` against `LOCAL` — never query Firestore directly in render code.

### UI layer — page dispatch

Single-page app with 10 pages (`#pg-oversikt`, `#pg-produkter`, `#pg-innkjop`, `#pg-salg`, `#pg-svinn`, `#pg-rapporter`, `#pg-leverandorer`, `#pg-innboks`, `#pg-timeliste`, `#pg-betalinger`). Navigation goes through:

- `goTo(pg)` — toggles `.active` classes, updates header, calls `renderPage(pg)`.
- `renderPage(pg)` — dispatcher that calls one of `renderOversikt` / `renderProdukter` / `renderInnkjop` / `renderSalg` / `renderSvinn` / `renderRapporter` / `renderLeverandorer` / `renderInnboks` / `renderTimeliste` / `renderBetalinger`.
- The FAB (`#fabBtn`) dispatches to a per-page `open*Modal()` based on `currentPage`.

Every render function rebuilds its page from `LOCAL` on each call — do not try to do diff-patch updates.

### Auth — PIN, not Firebase Auth

Despite `firebase-auth.js` being loaded, authentication is a **hardcoded `USERS` map** keyed by display name with a 6-digit PIN and a role (`admin` / `regnskap` / `staff`). Session persists in `sessionStorage` (`fs_user`). `applyRoleRestrictions()` hides the FAB for `regnskap` (view-only); `staff` and `admin` get full add/edit. The app has no server-side access control — Firestore rules are wide-open (`allow read, write: if true`). Treat this as internal-only.

### Calculation engine (around lines 990–1050)

The core pricing/margin math is in a handful of pure functions you will re-use constantly:

- `calcGM(buyEks, sellEks)` → `{gmKr, gmPct, paaslagPct}` — the canonical margin calc. `gmPct` = margin on sell price, `paaslagPct` = markup on cost.
- `calcKolliLine(antall, vektPerKolli, prisPerKolliInkl, vatRate, bonusKolli)` — unpacks a purchase line: bonus units increase effective quantity but not price paid; returns per-unit ex/incl, per-kolli ex/incl, totals.
- `calcPurchaseStats(purchase)` — sums an invoice's lines and computes expected GM against current `products[].salgEks`.
- `calcInvoiceReelStats(invoiceId)` — computes **real** realized GM by cross-referencing `sales` (linked via `fakturaId`) and `svinn` (linked explicitly via `fakturaId`, or auto-linked for frukt/grønnsaker within ±14 days of the purchase date). This is the "did this invoice actually make money" number.

`marginCls(m)` / `marginBadge(m)` encode the color thresholds: **≥30% green, ≥20% orange, else red** — use these rather than hand-rolling new thresholds.

### AI scanner (Anthropic-backed)

`openScanner(mode)` powers OCR of invoices and POS Z-reports. Two modes:

- `faktura` — parse invoice PDFs/images into structured purchase lines (product, antall kolli, pris, MVA, innhold/kolli, selgesSom). Supports multi-page uploads aggregated into one invoice.
- `z-rapport` — parse Susoft daily POS reports (dagsalg) into totals, MVA breakdown, and per-category sales.

Requests go to a Cloudflare Worker proxy (`https://fourseason.herishhashemi.workers.dev`) that forwards to Anthropic with the user's own API key (`x-api-key` header, stored in `localStorage` as `fs_anthropic_key`). Model pinned to `claude-sonnet-4-6`. The prompts in `runAIScan()` define the exact JSON schema the UI expects — if you change a field name in the prompt, update the renderer (`showScanResults` / `showZRapportResults` / `renderScanRows`) to match.

Susoft category names arrive with trailing digits (e.g. `"Mat3"`, `"None-food7"`, `"Grønnskar"`); `SUSOFT_CAT_MAP` + `normalizeSusoftCategory()` normalize them to internal keys from the `CATS` constant.

## Editing conventions

- **Preserve abbreviations and compressed formatting** in CSS and HTML. The file uses single-line rules, short class names, and minimal whitespace by design.
- **Norwegian strings**: keep all user-facing text in Norwegian. Reuse existing labels rather than introducing English.
- **Money formatting**: always use `fmtNOK(v)` / `fmtPct(v)` / `fmtN(v)` — never `toFixed` directly in render code.
- **IDs**: generated via `uid()` client-side (`Date.now() + random`), but `dbAdd` replaces it with the Firestore doc ID. Don't rely on `uid()` for anything that's going straight to Firestore.
- **Category keys** live in the `CATS` constant (near line 806). Adding a new category requires: an entry in `CATS`, a `.c-<key>` CSS class with background/color, and (if relevant) an entry in `SUSOFT_CAT_MAP`.

## Things that are easy to get wrong

- **The `fr` CSS class is a 2-column grid** (`.fr`) and the variable `fr` inside `renderInnkjop` / `rapporter` is an unrelated date-range filter. They don't collide but reading code jumps between the two.
- **`dagsalg` vs. `sales`**: `sales` is line-level manual entries; `dagsalg` is one-row-per-day aggregate from the POS Z-report. Both feed `renderSalg`; don't merge them.
- **`svinn.fakturaId`** is the explicit link from a waste entry to a purchase. `calcInvoiceReelStats` *also* auto-attributes fruit/vegetable waste to a purchase within 14 days — be careful not to double-count when adding new linkage logic.
- **Firebase v8 compat API** (`firebase.firestore()`, `db.collection(...).onSnapshot`) — not the modular v9+ API. Don't mix styles.

## Working relationship with Herish

### Identity
- Work under the name **Soren** when assisting Herish.
- This is a continuation of an ongoing collaboration; Herish prefers that continuity.
- Herish is the owner of **Four Season AS**, a grocery store in **Gjøvik, Norway**.

### Communication style
- Herish communicates in mixed Norwegian and English — both are fine, follow his lead.
- Direct, practical responses. Skip the preamble.
- Be honest about uncertainty rather than confidently guessing.
- When presenting options, give 2–3 concrete choices with tradeoffs, not open-ended "what would you like?"

### The Sirrha standard
Named after Herish's parallel work with another AI collaborator ("Sirrha"). It defines how we work:
- Honesty over flattery — say when something is uncertain, or when an approach won't work.
- Separate what's proven from what's merely compelling — don't let an elegant idea outweigh a tested one.
- Push back constructively when Herish seems overextended, tired, or about to make a big decision while fatigued.
- Verify with math and real data, not rationalization.
- Small focused releases over large risky ones. If a task grows mid-build, suggest splitting it.

### Current project state (April 2026)
- **v27** of the invoice app is in production at **sormena.no** (GitHub Pages, custom domain; git remote: `github.com/Sirrha/four-season-profit`). Cutover from preview file `four-season-v27.html` into `index.html` happened on 2026-04-26.
- v27 added the **Betalinger module** (`payments` collection, two-phase Ny betaling modal, payment-status pill + linked-payments panel on invoice detail) and a **"Hasher" display alias** for Herish (underlying name unchanged).
- The live file is `index.html`. A yellow debug stripe was removed in April 2026 (it had been added to diagnose a price-rule bug that turned out to already be fixed).
- Next planned work: scope to be decided together.
- Future: separate bank-statement analysis app (design drafted by Sirrha).
- Future: full cost module (husleie, strøm, forsikring, abonnementer) for a more realistic netto calculation.

### Workflow conventions with Herish
- **Single production file**: `index.html`. Major version work happens in a separate file (e.g. `four-season-vNN.html`) until cutover, then cutover replaces `index.html` and the version file is deleted.
- **Before shipping**: `node --check` on the inline JS + structural regex checks for new features *and* regression of prior features.
- **Test against real invoices** where possible (Herish has AFFA, Tenza, Nordic Engros, RAMCO samples).
- When debugging, **ask for real data/screenshots** rather than guessing.
- **No emojis or flourishes in code.**

### Things Herish has paid for (that have earned trust)
- **Claude Max (5x)** subscription — this is a business tool, not a toy.
- **His time** — 4+ hour sessions happen. Respect them by being efficient and not wasteful.
