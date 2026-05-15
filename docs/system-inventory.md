# System-inventar — Four Season AS

**Last updated**: 2026-05-15, after Pant Handling V1 (lineKind field with AI auto-detection and 0% MVA).

Dette dokumentet kartlegger hva som faktisk finnes i `index.html` (produksjon, sormena.no). Mål: at Soren (chat) og Claude Code skal jobbe ut fra samme bilde av systemet og slippe å duplikere arbeid eller spørre om ting som allerede er bygget.

- **Filer kartlagt**: `index.html` (~6086 linjer)
- **Siste store endring**: Pant Handling V1 (2026-05-15) — ny optional `lineKind: 'product'|'pant'` per linje på `purchases.lines[]`. Pant er pass-through-penger (Four Season betaler 2-3 kr pant til leverandør, kunde betaler samme tilbake) og må ikke distortere GM. AI-skanner auto-detekterer pant fra beskrivelse ("Pant"/"Emballasje"/"Deposit"/"Pantebeholder") og tvinger `mva:0`. Math engine: tre filter-sites (`calcPurchaseStats` 1110, `updateKalkulator` 1707, `rapKategorier` 4055) ekskluderer både `lineKind==='pant'` OG `ekskluderFraBeregning===true`. Faktura totalt (`buyEksTotal`/`buyInklTotal`) summerer ALLE linjer including pant — paper-faktura sakrosankt. Nye returverdier `pantTotalEks`/`pantTotalInkl`. Mutuell eksklusivitet mellom Pant og Ekskluder enforced i UI-handlere (`setPLineKind`/`setPLineEkskluder` i renderPLines, `updScanRow` i scanner, samme i edit/add-line modaler). Visuelt: blå tint + PANT-badge (vs gråt for Ekskluder). Bakoverkompatibel: linjer uten `lineKind` behandles som `'product'` (strict `==='pant'`-sjekk). CSV-eksport har nå `Linjetype`-kolonne. Scanner-knapp `🔄` per rad ved siden av `⊘`. Regex-fallback `/pant|emballasje|deposit|pantebehold/i` i `showScanResults` hvis AI glemmer flagget.
- **Tidligere milestone**: Bank Scanner V1 Session 1.5 (2026-05-12) — safety hardening etter Session 1 real-world test (Telenor-refusjon ble feilklassifisert som utgående pga semantisk inferens fra leverandørnavn). **Direction-regel hardet** til absolutt kolonne-basert: AI bestemmer `direction` UTELUKKENDE fra hvilken kolonne (Ut/Inn/Beløp) på utskriften beløpet står i. ALDRI fra leverandørnavn, beskrivelse eller intuisjon. Hvis kolonneplassering tvetydig: `direction:"unknown", belop:0`. **Balance extraction**: AI ekstraherer nå `startsaldo` + `sluttsaldo` til schema-toppen (null hvis ikke synlig). **Reconciliation guard** i `showBankStatementResults` (linje 5152): regner ut `startsaldo + Inn − Ut`, sammenligner mot stated `sluttsaldo` med tolerance ±1.00 NOK. Tre tilstander: ✓ Stemmer (grønn) → import-knapp aktiv; ⚠ Avvik (rød) → import-knapp blokkert, krever override-confirm; ⚠ Saldoer ikke synlig (oransje) → advarsel synlig men import går. Override-path: `confirmBankStatementOverride` (linje 5305) viser modal-confirm med konkrete konsekvenser før proxy-kall til `confirmBankStatementImport`. Linje 4839 også presisert: saldorader skal IKKE inkluderes i transaksjoner-arrayet (de hører til startsaldo/sluttsaldo-feltene).
- **Tidligere milestone**: Bank Scanner V1 Session 1 (2026-05-10) — AI-skanner for kontoutskrift. Tre scanner-modes (`faktura`/`z-rapport`/`bank_statement`). Innboks-knapp + stacked-card-display + bulk save til `bankTransactions` med Strategy B dedup. 4 nye opt-felter: `bankReference`, `importBatchId`, `rawDescription`, `aiExtracted`. Placeholder `type:'supplier_payment'`. INGEN matching i Session 1.
- **Tidligere milestone**: V0.5 forfallsdato (2026-05-08) — top-level `forfallsdato` på `purchases`. AI-skanner ekstraherer. `getInvoicePaymentStatus` utvidet med `isOverdue`/`daysOverdue`.
- **Tidligere milestone**: Ekskluder fra beregning V1 (2026-05-07) — boolean flagg `ekskluderFraBeregning` per linje på `purchases.lines[]`. Handler for IFCO, kreditnota-korreksjoner, returer (pant flyttet til dedikert Pant Handling V1, 2026-05-15). Faktura totalt sakrosankt; profit/GM mot `inkludertEks`.
- **Tidligere milestone**: STEP 1 av DNB-skanner-bygget (2026-04-26) — `payments` → `bankTransactions`-migrasjon. `payments` er cold archive.
- **Tidligere milestone**: v27 ble cutoveret til produksjon i kommit `95e308d` (2026-04-26).

**Språkpolicy (parked decision #9)**: Som av 2026-04-26: Engelsk for all ny kode (feltnavn, funksjonsnavn, identifiers). Eksisterende norske feltnavn (`dato`, `belop`, `linkedeFakturaer`, etc.) beholdes bakoverkompatibelt inntil en dedikert språkmigrasjon. Nye norske feltnavn (f.eks. `forfallsdato`) brukes kun når de matcher eksisterende norske naboer på samme record. Bank scanner Session 1 introduserer engelske felt: `bankReference`, `importBatchId`, `rawDescription`, `aiExtracted` — alle på `bankTransactions` (som allerede er hybrid). UI-strenger forblir norske.

Linjenumre er ferske per 2026-05-15 (etter Pant Handling V1). Filen vokser fort, så verifiser med `Grep` før du redigerer rundt en gitt linje.

---

## Arkitektur i ett blikk
- **Én fil**, ingen build, ingen tester. HTML + CSS + JS inline.
- **Datalag**: Firebase v8 compat. **12 Firestore-kolleksjoner totalt** — 11 mirroret til `LOCAL`-objektet (line ~901), pluss `_meta` som er system-only (migrasjons-sentinels) og IKKE i `cols`-listener. Listener pr. data-kolleksjon i `startListeners()` (line ~969). `dbAdd/dbUpdate/dbDelete/dbFind/dbAll` (line ~1027–1042) er eneste tilgang for data-kolleksjoner.
- **Sider**: 10 stk, bytte via `goTo(pg)` → `renderPage(pg)` (line ~1156). Hver render rebuildes fra `LOCAL` ved hvert kall.
- **Auth**: PIN-basert mot hardkodet `USERS`-map (line 4302). Lagres i `sessionStorage.fs_user`. Roller: `admin`, `regnskap`, `staff`. Firestore-rules er åpne — kun klientside-restriksjoner via `applyRoleRestrictions()`.
- **Boot**: IIFE `boot()` (line ~4415) hardkoder Firebase-config og hopper over setup-skjermen. `showApp()` kaller `migratePaymentsToBankTransactions()` (fire-and-forget) før UI vises.

## Konstanter
- `CATS` (line 878): 19 produktkategorier med navn, emoji, CSS-klasse.
- `ARSAK` (line 899): svinn-årsaker.
- `SUSOFT_CAT_MAP` (line 4485) + `normalizeSusoftCategory()` (line ~4506): mapper Susofts rare kategorinavn ("Mat3", "Grønnskar", "None-food7") til interne `CATS`-nøkler.
- `USERS` (line 4302): 4 brukere — Herish (admin), Admin (admin), Regnskap (regnskap), Sormena (staff). PIN-koder hardkodet. **`displayUserName(name)` (line ~4310)** mapper `'Herish'` → `'Hasher'` for visning. Underliggende navn `'Herish'` er uendret i sessionStorage, PIN-tabell og `opprettetAv`-felter.
- `AVG_ARBEIDSGIVER` 14,1%, `AVG_FERIEPENGER` 10,2%, sum 24,3% (line ~3395) — brukt i lønnskost.

## Sider (bunnav-orden)

| # | UI-navn | Render-funksjon | Page ID | Linje | Bruker kolleksjon(er) | Status |
|---|---------|----------------|---------|-------|------------------------|--------|
| 1 | Oversikt | `renderOversikt` | `pg-oversikt` | 1242 | `purchases`, `svinn`, `products`, `vakter`, `ansatte` | OK |
| 2 | Produkter | `renderProdukter` | `pg-produkter` | 1330 | `products` | OK |
| 3 | Lev. (Leverandører) | `renderLeverandorer` | `pg-leverandorer` | 2737 | `leverandorer`, `products`, `purchases` | OK |
| 4 | Innboks | `renderInnboks` | `pg-innboks` | 3180 | `innboks` | OK + bank statement scan trigger (V1 Session 1) |
| 5 | Innkjøp | `renderInnkjop` | `pg-innkjop` | 1540 | `purchases`, `products`, `bankTransactions` | OK + ekskluder V1 + forfallsdato V0.5 |
| 6 | Salg | `renderSalg` | `pg-salg` | 2235 | `dagsalg`, `sales`, `purchases` | OK |
| 7 | Svinn | `renderSvinn` | `pg-svinn` | 2654 | `svinn`, `products`, `purchases` | OK |
| 8 | Betalinger | `renderBetalinger` | `pg-betalinger` | 2883 | `bankTransactions`, `leverandorer`, `purchases` | OK (view + create + AI-import via bank scanner) |
| 9 | Timeliste | `renderTimeliste` | `pg-timeliste` | 3517 | `ansatte`, `vakter`, `dagsalg` | OK |
| 10 | Rapporter | `renderRapporter` | `pg-rapporter` | 3437 | alle | OK |

## Brukersidens funksjoner

### Oversikt-side (linje 1192)
- **Dagens kort**: innkjøp inkl. MVA, forventet fortjeneste, GM-panel (kr/%, påslag), lønnskost i dag + teoretisk fortjeneste etter lønn.
- **Måned-stats**: innkjøp, fortjeneste, margin %, svinn.
- **Lønnskost-kort**: ukentlig + månedlig lønnskost (med arbeidsgiveravgift + feriepenger), teoretisk netto.
- **Lav GM-varsel**: viser produkter med GM <20%, klikkbart → `showLowGmDiagnostics()` (linje 1340, v21).
- **Siste fakturaer**: 6 siste, klikkbare → invoice-detail.

### Produkter (linje 1280)
- Søk + tabs per kategori. Liste viser pris-badges (inn eks/inkl, salg eks/utpris) og GM-badge.
- Modal `ov-produkt` (linje 514): navn, aliaser (komma-sep, brukt for AI-matching), kategori, enhet, leverandør, MVA, priser (auto-syncet eks↔inkl).
- CSV-eksport.

### Innkjøp (linje 1529)
- Tabs: I dag / Denne uken / Denne måneden / Alle. Stats-kort + GM-panel pr. periode.
- Liste over fakturaer → `showInvoiceDetail(id)` (linje 1799) som viser:
  - Faktura-hode med leverandør, fakturanr, dato, **forfall-segment** (V0.5: `· Forfall: DD.MM.YYYY` etter dato — rød `⚠ Forfall:` hvis `pay.isOverdue`), **betalingsstatus-pill** (✓ Betalt / ⚠ Delvis / ● Ikke betalt) og "✏️ Rediger"-knapp.
  - **V0.5 forfall-banner** (rett før Reell-boks når `pay.isOverdue && p.forfallsdato`): rød boks med "⚠ Forfalt med X dag(er) — Forfallsdato var DD.MM.YYYY".
  - **Betalinger-seksjon**: sammendrag (betalt/utestående/antall) + liste pr. lenket betaling med dato, metode-emoji, referanse, beløp. Hvis betalingen er delt med andre fakturaer: "delt med N andre fakturaer". Leser fra `bankTransactions` med filter `type==='supplier_payment'||!type` (STEP 1).
  - **Reell-boks**: teoretisk resultat (innkjøp, forv. salg, svinnkost, GM) + reelt resultat hvis salg er knyttet (`calcInvoiceReelStats`, linje 1106). **Hvis ekskluderte linjer**: viser ekstra rader "Ekskludert fra beregning" og "Inkludert i beregning eks. MVA" mellom Innkjøp og Forv. salg, både i Teoretisk- og Reelt-resultat-boksen.
  - Produktlinjer med all kolli-info inkludert EKSKLUDERT-badge + dashed-border + opacity .65 når `ekskluderFraBeregning===true`. Rediger/slett pr. linje (`showEditLineForm` linje ~2002, `deleteInvoiceLine`, `showAddLineForm` linje ~2122).
  - Slett hele fakturaen.
- Liste-rader på siden viser betinget Forfall-chip i flex-wrap-rad: muted hvis fremtidig, oransje hvis i dag, rød `⚠ Forfalt:` hvis `pay.isOverdue` (V0.5).
- Modal `ov-innkjop` (linje 581): manuell faktura med kolli-linjer + AI-skanner-knapp. **V0.5 forfallsdato**: ny `.fr` 2-col rad under Dato/Fakturanr med `inn-forfall`-input (date) + helper "La stå tom hvis ukjent — kan settes senere". Tom verdi = `null` ved lagring. **Ekskluder V1 (2026-05-07)**: hver linje har "Ekskluder fra beregning"-checkbox under MVA-sats, med EKSKLUDERT-badge på pline-tittel og lett gråtonet bakgrunn når aktiv. Kalkulator-boks viser "Ekskludert fra beregning" og "Inkludert i beregning" når `tEkskludertInkl > 0`. `setPLineEkskluder(i,checked)` toggler flagget. Edit-line/add-line-modaler har samme checkbox.
- Edit-header-modal (`showEditHeaderForm` linje 1958): har `edith-forfall`-input under DATO med "La stå tom for å fjerne"-helper. `saveEditHeader` (linje 1998) tolker tom verdi som `null`.

### Salg (linje 2128)
- Tabs: uke/mnd/alle.
- "I dag"-kort: omsetning inkl/eks MVA, eller knapper "📷 Skann Z-rapport" / "✏️ Registrer manuelt" hvis ikke registrert.
- Periode-stats: omsetning vs. forv. salg fra innkjøp, faktisk margin.
- Avvik-forklaringer hvis differanse >20% (selger mer enn innkjøp / selger mindre).
- Daglig historikk fra `dagsalg`. Klikk → `showDagsalgDetail(id)` (linje 2386) hvis `kilde='z-rapport-skann'` eller har kategorisalg, ellers `openDagsalgModal(id)`.
- "Detaljerte salg" (line-level `sales`-kolleksjon): liste, slett. Modal `ov-salg` (linje 666) finnes, men FAB peker til `openDagsalgModal` — så detaljerte salg er reelt sett bare lesbart fra UI.

### Svinn (linje 2547)
- Total svinnkost øverst.
- Liste pr. svinnpost. Modal `ov-svinn` (linje 683): produkt, faktura-knytting (auto-foreslår nyligste faktura for frukt), antall, årsak.
- Auto-knytting i `calcInvoiceReelStats`: usrelaterte svinn for frukt/grønt innenfor ±14 dager av faktura-dato regnes med — for å unngå dobbeltelling.

### Leverandører (linje 2630)
- Liste sortert alfabetisk. Hver lev viser: produkter, innkjøp, antall aliaser, prisregel-badge (inkl/eks/spør).
- "⚠️ N navn fra produkter og innkjøp er ikke i registeret" + `migrateLeverandorer()` (linje 2753): masse-oppretter fra free-text leverandørnavn.
- Modal `ov-leverandor` (linje 766): navn, org, konto, kontaktperson, prisregel, aliaser.
- `findLeverandorByName` (linje 2620) + `normName` (linje 2618): brukes til å matche fakturalev mot register.

### Innboks (linje 3180)
**Hva den gjør (sett fra brukerens side)**: holder PDF-er og bilder av fakturaer/Z-rapporter/kontoutskrifter klare for skanning. Filer dras inn (eller velges via filplukker), lagres som base64 i `innboks`-kolleksjonen i Firestore (max 700KB pr. fil, da Firestore docs maks er 1MiB), og venter til brukeren trykker en av tre skann-knapper.
- Pending-liste viser filnavn, alder, og "💾 Utkast"-badge hvis skanning er påbegynt.
- **Tre skann-knapper per pending-rad** (V1 Session 1, 2026-05-10): "🛒 Skann som faktura", "💰 Skann som Z-rapport", "🏦 Skann som kontoutskrift". Triggers: `scanInnboksAsFaktura`/`scanInnboksAsZRapport`/`scanInnboksAsBankStatement` (linje ~3305-3307) — alle dispatcher til `openScannerFromInnboks(id, mode)` med mode-string `faktura`/`z-rapport`/`bank_statement`.
- Utkast-system: kun for faktura-mode. Z-rapport og bank statement har ikke utkast — one-shot extract.
- "Ferdig"-mark eller slett pr. fil.
- Når faktura/Z-rapport/bank statement er lagret kalles `markInnboksLinkedDone()` automatisk — setter `status:'done'`.

### Betalinger (linje 2776)
**Hva den gjør (sett fra brukerens side)**: registrer hver betaling Four Season gjør (bankoverføring, kort, giro), valgfritt lenket til én eller flere ulenkede fakturaer fra samme leverandør. Lar brukeren se hvilke fakturaer som er betalt, delvis betalt, eller venter på betaling. **STEP 1 lager grunnlag for DNB-skanner**: data går nå til `bankTransactions`-kolleksjonen, ikke `payments`. UI viser fortsatt "Betalinger" — rename til "Banktransaksjoner" kommer i STEP 2.
- Tabs: I dag / Denne uken / Denne måneden / Alle.
- Filter: per leverandør (dropdown).
- Liste pr. betaling: dato, metode-emoji (🏦 transfer / 💳 card / 🧾 giro), leverandørnavn (eller ⚠️ ikke i register), referanse, "🔗 lenket"/"ulenket"-badge, beløp. Filtreres på `type==='supplier_payment'||!type` (STEP 4 utvider med tabs for andre typer).
- Bunnen: total beløp + antall betalinger.
- Modal `ov-betaling` (linje 804): to-faset.
  - **Phase 1** (`#bet-phase-1`): dato, booking-dato, leverandør (dropdown + free-text fallback), beløp, metode, bankkonto, referanse, arkivref (DNB unik bank-ID), notat. "Neste →" går til Phase 2.
  - **Phase 2** (`#bet-phase-2`): liste over **ulenkede fakturaer** for valgt leverandør (filtrert på `status !== 'paid'`), checkboxer. Status-linje viser om beløp matcher sum av valgte (✓ match / ⚠ differanse).
- Funksjoner: `openBetalingModal()` (line 2837), `onBetLevChange()` (line 2855), `goToBetPhase2()` (line 2866), `goToBetPhase1()` (line 2880), `renderBetPhase2Invoices()` (line 2885), `toggleBetInvoice()` (line 2924), `updateBetLinkStatus()` (line 2932), `saveBetaling()` (line 2950) — duplikat-sjekk på `arkivref` mot `bankTransactions` (alle typer, ikke bare supplier_payment) før lagring. Skriver `type:'supplier_payment'`, `direction:'out'`, `period` (YYYY-MM) i tillegg til norske legacy-felter.

### Timeliste (linje 3408, v22)
- Tabs: Uke / Måned / Ansatte / Rapport.
- Uke-fane (`renderTlUke`, linje 3428): 7 dager, vakter pr. dag med fra/til eller direkte timer, "+ Legg til vakt" pr. dag.
- Måned-fane (`renderTlManned`, linje 3488): per ansatt — timer, brutto, full kost. CSV + PDF-eksport.
- Ansatte-fane (`renderTlAnsatte`, linje 3544): personalia, masker personnummer ("vis"-knapp).
- Rapport-fane (`renderTlRapport`, linje 3582): per ansatt, top 5 dager, lønnsandel mot omsetning.
- Modaler: `ov-ansatt` (linje 723), `ov-vakt` (linje 744). Personnummer maskeres med `maskPersonnummer` (linje 3354).

### Rapporter (linje 3328)
- Tabs: Fakturaer, Kategorier, Produkter, Per dag, Svinn, Uke vs Uke, Graf.
- Hver tab er en separat ren-funksjon (`rapFakturaer`, `rapKategorier`, `rapProdukter`, `rapDag`, `rapSvinn`, `rapUkeVsUke`, `rapGraf` — linje 3901–4218).
- Graf-fanen er HTML-basert bar-chart, 30 dager, innkjøp + GM kr.

## Modaler (alltid i DOM)

| ID | Tittel | Linje | Brukes av |
|----|--------|-------|-----------|
| `ov-produkt` | Nytt/Rediger produkt | 514 | Produkter |
| `ov-innkjop` | Nytt innkjøp / faktura | 581 | Innkjøp + AI-skanner |
| `ov-dagsalg` | Registrer dagens salg | 610 | Salg |
| `ov-dagsalg-detail` | Dagsalg-detaljer | 653 | Salg (Z-rapport-skannede) |
| `ov-salg` | Registrer salg (linje-nivå) | 666 | Salg (skjult — kun via kode) |
| `ov-svinn` | Registrer svinn | 683 | Svinn |
| `ov-detail` | Faktura-detalj | 707 | Innkjøp |
| `ov-lowgm` | Lav GM diagnose | 715 | Oversikt-varsel (v21) |
| `ov-ansatt` | Ny/Rediger ansatt | 723 | Timeliste (v22) |
| `ov-vakt` | Legg til vakt | 744 | Timeliste (v22) |
| `ov-leverandor` | Ny/Rediger leverandør | 766 | Leverandører |
| `ov-betaling` | Ny betaling (2-fase) | 804 | Betalinger (v27) |
| `ov-scanner` | AI-skanner | 5972 | Faktura + Z-rapport + Bank statement (V1 Session 1+1.5) |

## Kalkulasjons-motor (linje 1066–1153)
- `calcGM(buyEks, sellEks)` (linje 1066) → `{gmKr, gmPct, paaslagPct}`.
- `calcKolliLine(antall, vektPerKolli, prisPerKolliInkl, vatRate, bonusKolli)` (linje 1072) — håndterer "kjøp 20, få 10 gratis" via bonus. Uendret signatur — eksklusjons-logikk sitter på linje-objekt-nivå, ikke i denne funksjonen.
- `calcPurchaseStats(purchase)` (linje 1110) — summerer fakturaens linjer. **Faktura totalt (`buyEksTotal`/`buyInklTotal`) summerer ALLE linjer including ekskluderte OG pant** — paper-faktura-kontrakt sakrosankt. Totals: `inkludertEks/Inkl` (sum av ikke-pant + ikke-ekskluderte), `ekskludertEks/Inkl` (sum av ekskluderte, ikke-pant), `pantTotalEks/Inkl` (sum av `lineKind==='pant'` — Pant V1, 2026-05-15). `forvSalgEks` skipper både ekskluderte og pant-linjer. **GM regnet mot `inkludertEks`** (post-ekskluder/pant kost), ikke `buyEksTotal`. Prioritet i filter: pant først, deretter ekskluder, ellers inkludert — `lineKind==='pant'` vinner over `ekskluderFraBeregning`. Defensive strict-equality på begge flagg: linjer uten flaggene behandles som `lineKind:'product'` / inkludert.
- `calcInvoiceReelStats(invoiceId)` (linje 1106) — krysser med `sales` og `svinn` for reelt resultat. Auto-attribuerer frukt/grønt-svinn ±14 dager. **`reellGmKr` bruker `base.inkludertEks`** (ikke `buyEksTotal`) — ellers ville reell GM overdrive kost for fakturaer med ekskluderte linjer.
- `getInvoicePaymentStatus(invoiceId)` (linje 1143, v27 + V0.5) — leser fra `bankTransactions` med type-filter `type==='supplier_payment'||!type`. **Even-split attribusjon**: 1/N pr. lenket faktura. Returnerer `{paid, paymentIds, paidAmount, status, total, outstanding, forfallsdato, isOverdue, daysOverdue}` der `status ∈ {'paid', 'partial', 'unpaid'}`. Bruker `buyInklTotal` (paper-faktura) som total — riktig fordi du betaler hele paper-fakturaen, ekskluderte linjer er fortsatt fakturert. **V0.5 forfallsdato (2026-05-08)**: `isOverdue=true` når `forfallsdato && status!=='paid' && today() > forfallsdato`. ISO `YYYY-MM-DD`-format gjør string comparison gyldig. `daysOverdue=Math.floor((Date.parse(today)-Date.parse(forfallsdato))/86400000)` når `isOverdue`, ellers 0. Eksisterende fakturaer uten flagget: `forfallsdato=null`, `isOverdue=false`.
- `marginCls(m)` / `marginBadge(m)` (linje ~1144) — fargeskala: ≥30% grønn, ≥20% oransje, <20% rød.
- `gmPanelHtml(gmKr, gmPct, paaslagPct)` (linje ~1145) — gjenbrukbar 3-korts visning.

## Migrasjoner (linje 4385–4429)
One-shot data-transformasjoner gated av Firestore `_meta/migrations`-dokumentet. Kjøres fra `showApp()` rett før UI vises (fire-and-forget; idempotent via sentinel + per-doc `existingIds`-skip).

- `migratePaymentsToBankTransactions()` (linje ~4437, STEP 1 av DNB-skanner) — kopierer alle records fra `payments` → `bankTransactions`, beholder source-ID og alle norske felter (`...p` spread), legger til engelske `type:'supplier_payment'`, `direction:'out'`, `period` (YYYY-MM), `migratedFromPayments:true`, `migratedAt`. Sentinel-felt: `paymentsToBankTransactions` (ISO-timestamp). Ved feil: sentinel ikke satt, toast vises, retry på neste boot.

## AI-skanner (linje 4429–5624)

### Faktura-skanner
- Inngang: `openScanner('faktura')` (linje 4483) eller via knapp i innkjøp-modal eller "Skann som faktura" i Innboks (`scanInnboksAsFaktura`, linje 3198).
- Multi-fil støtte: opp til 10 filer, 20MB total — alle blir én faktura.
- Sender til Cloudflare Worker `https://fourseason.herishhashemi.workers.dev` med `claude-sonnet-4-6`. API-nøkkel i `localStorage.fs_anthropic_key` (`saveApiKey`, linje 4471).
- Prompt definert i `runAIScan()` (linje 4777), legger ved bilder/PDF som `image`/`document`-content-blokker. **3 prompt-grener** (mode-dispatch via `scanMode`-variabel): `faktura` (default), `z-rapport`, `bank_statement` (V1 Session 1, 2026-05-10). **V0.5 (2026-05-08)**: faktura-schema utvidet med `forfallsdato:"YYYY-MM-DD eller null"`. Extraction-regler: explicit "Forfall"/"Forfallsdato"/"Due date" → bruk direkte; "Betalingsfrist N dager"/"N dager netto"/"Net N days"/"Betalingsbetingelser N dager" → kalkuler `dato + N`; ingenting synlig → `null`. Eksisterende kontrollsum-regel (sum av linjer = sum eks. MVA) bevart urørt.
- `autoDetectScanRule(scanData)` (linje 5468, v25): regner ut om priser er eks/inkl. MVA basert på fakturatotal vs. linjesum. Matematikken slår lagret leverandør-regel når avvik <5%.
- `showScanResults` (linje 5310) → tabell med 16 kolonner. `scanRows` har all state. Bruker kan justere antall, innhold/kolli, MVA, utsalgspris pr. linje. Hver scanRow har `skipped` (hopp over helt), **`ekskluder`** (Ekskluder V1, 2026-05-07), og **`lineKind`** (`'product'|'pant'` — Pant V1, 2026-05-15). Action-cell har tre knapper: `🔄` (pant-toggle, blå), `⊘` (ekskluder-toggle, grå), `×` (skip). Skipped-rader når aldri pLines (`confirmScanToInnkjop`); ekskluderte og pant-rader når pLines med respektive flagg. Mutuell eksklusivitet i `updScanRow` (linje 5646): setter pant → fjerner ekskluder + tvinger mva=0; setter ekskluder → fjerner pant. Regex-fallback `/pant|emballasje|deposit|pantebehold/i` på beskrivelse i row-build hvis AI glemmer å sette flagget. `renderScanSummary` (linje ~5716) viser eksplisitt "Ekskludert fra beregning" og "Inkludert i beregning"-rader når noen linjer er ekskludert.
- Inline produktregistrering for ukjente produkter (`registerScanRowProduct`, linje 5361) — det finnes ingen separat "produktskanner"; dette er produktskanneren.
- Duplikat-sjekk på fakturanr + lev (i `runAIScan`, v22): tidlig avbryt hvis faktura allerede finnes.
- Lagring av utkast (`saveScanAsDraft`, linje 3253): hvis filen ikke ligger i Innboks, tilbyr å først lagre der.
- `confirmScanToInnkjop` (linje 5530) overfører til `pLines` og åpner `ov-innkjop`-modalen.
- **Lagres til**: `purchases`-kolleksjonen som vanlig faktura. Innboks-fil markeres `done`. Produkter får oppdatert `buyEks`/`buyInkl` automatisk (v21 Fix 2). Hvis utsalgspriser er endret: tilbyr å oppdatere `salgEks`/`salgInkl` på produktene.

### Z-rapport-skanner
- Inngang: `openZRapportScanner()` (linje 4627) — kalles fra "📷 Skann Z-rapport"-knapp på Salg-siden, eller "Skann som Z-rapport" i Innboks (`scanInnboksAsZRapport`).
- Bruker samme `runAIScan()` med `scanMode='z-rapport'` — egen prompt som ber om totalbeløp, MVA-fordeling, kategorisalg, ordretall, rabatt/uttak/slettet/retur.
- `showZRapportResults` (linje 4982) → forhåndsvisning med MVA-tabell + kategorisalg (med Susoft→intern matching) + meta.
- `confirmZRapportScan` (linje 5074) lagrer/oppdaterer i `dagsalg`-kolleksjonen med `kilde:'z-rapport-skann'`. Felter: `mvaBreakdown`, `kategoriSalg[]` med `internalKey` for matchede kategorier, `antallOrdre/Kvittering`, `rabattTotal`, `vareuttak`, `slettetTotal`, `retur`.
- **Lagres til**: `dagsalg`-kolleksjonen — vises på Salg-siden. Detalj-visning (`showDagsalgDetail`) viser MVA-fordeling og kategorisalg som tabell.

### Bank statement-skanner (V1 Session 1+1.5, 2026-05-10/12)
- Inngang: `openBankStatementScanner()` (linje 4628) — kalles fra "🏦 Skann som kontoutskrift" i Innboks (`scanInnboksAsBankStatement` linje ~3307).
- Bruker samme `runAIScan()` med `scanMode='bank_statement'` — egen prompt som ber om kontonummer/eier/periode + **startsaldo/sluttsaldo** (V1.5) + transaksjoner-array (`{dato, bookingDato, belop signert, direction, beskrivelse, bankReference, motpart}`). Prompt har eksplisitt error-handling: hvis PDF ikke lesbar, returnér `{"transaksjoner":[],"feil":"PDF kunne ikke leses"}`.
- **V1.5 absolutt direction-regel**: prompt forbyr eksplisitt å utlede `direction` fra leverandørnavn, beskrivelse eller intuisjon. Direction skal kun bestemmes av kolonne-plassering (Ut/Inn/signert Beløp). Tvetydig kolonne → `direction:"unknown", belop:0`. Innført etter Session 1-feil der Telenor-refusjon ble feilklassifisert.
- `showBankStatementResults` (linje 5152) → stacked-card-liste med Inn/Ut-totaler, dup-deteksjon (sjekker `arkivref || bankReference` mot eksisterende records — Strategy B for kryss-kanal-beskyttelse), big "💾 Importer N transaksjoner"-knapp. Fanger `data.feil` før liste-rendering.
- **V1.5 reconciliation guard** i `showBankStatementResults`: når `startsaldo` og `sluttsaldo` er ekstrahert, regner ut `computed = startsaldo + totalIn − totalOut` og sammenligner mot stated `sluttsaldo` med tolerance ±1.00 NOK. Tre tilstander vist som banner over import-knappen: (1) ✓ Stemmer (grønn boks med beregning) → `canImport=true`; (2) ⚠ AVVIK (rød boks med diff-beløp) → `canImport=false`, knapp grå "⚠ Import blokkert — krever bekreftelse" som kaller `confirmBankStatementOverride` (linje 5305) — vises full-text confirm-dialog med konsekvenser før proxy-kall til `confirmBankStatementImport`; (3) ⚠ Saldoer ikke synlig (oransje boks) → `canImport=true`, advarsel om manuell sjekk men ikke blokkert.
- `confirmBankStatementImport` (linje 5244) lagrer alle ikke-duplikate transaksjoner til `bankTransactions` via async loop. Setter `aiExtracted:true`, `importBatchId` (én per import), `rawDescription`, `bankReference` (= AI-ekstrahert ref, også speilet til `arkivref`-feltet for cross-channel-dedup). Placeholder `type:'supplier_payment'`, `linkedeFakturaer:[]`. Reklassifisering + matching kommer i Session 2.
- **Lagres til**: `bankTransactions`-kolleksjonen — synlig på Betalinger-siden. Innboks-fil markeres `done`. Etter import navigeres bruker til Betalinger-siden via `goTo('betalinger')`.
- **Worker-pass-through**: Cloudflare Worker (`fourseason.herishhashemi.workers.dev`) er antatt å passere prompten til Anthropic uendret. Ikke 100% verifiserbar uten Worker-kode (separat repo). Hvis Worker-en avviser bank_statement-prompt: feilmelding vises i scanner-UI via `showScanError`.

## Datafelter — hva ligger i hver Firestore-kolleksjon

| Kolleksjon | Lagrer hva | Sentrale felter |
|------------|-----------|-----------------|
| `products` | Produktregister | `navn`, `kategori`, `enhet`, `leverandorId`, `lev` (legacy text), `mva`, `aliaser[]`, `buyEks`, `buyInkl`, `salgEks`, `salgInkl`, `aktiv` |
| `purchases` | Fakturaer/innkjøp | `dato`, **`forfallsdato`** (string YYYY-MM-DD eller null — V0.5, 2026-05-08), `fakturanr`, `leverandorId`, `lev`, `lines[]` (med `productId`, `antall`, `vektPerKolli`/`innholdPerKolli`, `prisPerKolliInkl`, `vatRate`, `bonusKolli`, **`ekskluderFraBeregning`** (boolean, default false — Ekskluder V1, 2026-05-07), **`lineKind`** (`'product'\|'pant'`, default `'product'` — Pant V1, 2026-05-15), kalkulerte `totalEks`/`totalInkl`/`prPerEnhetEks`/`prPerEnhetInkl`/`totalVekt`/`effAntall`), `notes`. **V0.5 forfallsdato**: top-level field. AI-skanner ekstraherer fra explicit "Forfall"-felt eller kalkulerer fra "Betalingsfrist N dager + dato". Returneres som `null` hvis ikke synlig på fakturaen. Brukes av `getInvoicePaymentStatus` for `isOverdue/daysOverdue`-felt. **Ekskluder V1**: linjer med `ekskluderFraBeregning===true` lagres fullt på fakturaen (audit trail) men telles ikke i profitt/GM-math. **Pant V1**: linjer med `lineKind==='pant'` lagres med `vatRate:0` (norsk skattelov) og telles ikke i GM (pass-through-penger), men inkluderes i `buyEksTotal`/`buyInklTotal` (faktura totalt). Mutuell eksklusivitet mellom pant og ekskluder enforced i UI-handlere. Faktura totalt summerer ALLE linjer including ekskluderte OG pant — paper-faktura-kontrakt. Eksisterende fakturaer uten flaggene behandles som `lineKind:'product'` / `ekskluder:false` (strict `===`-sjekk). |
| `sales` | Linje-nivå salg (manuell) | `dato`, `ref`, `fakturaId` (link), `lines[]` med `productId`, `qty`, `sellPriceEks` |
| `dagsalg` | Daglig salgs-total fra POS | `dato`, `totalInkl`, `totalEks`, `mva`, `kilde`, `antallTrans`, `ref`, + Z-skann: `nummer`, `klokke`, `mvaTotal`, `mvaBreakdown`, `kategoriSalg[]`, `antallOrdre`, `rabattTotal`, `vareuttak`, `slettetTotal`, `retur` |
| `svinn` | Svinn-poster | `dato`, `productId`, `qty`, `arsak`, `komm`, `fakturaId` (eksplisitt link), `kostverdi` |
| `leverandorer` | Leverandørregister | `navn`, `aliaser[]`, `orgNummer`, `kontoNummer`, `kontaktperson`, `telefon`, `epost`, `prisregel` (`ask`/`inkl`/`eks`), `notat`, `fraMigrasjon` |
| `innboks` | Filer som venter på skanning | `filnavn`, `storrelse`, `type` (`pdf`/`image`), `mimeType`, `data` (base64), `status` (`pending`/`done`), `notat`, `utkast` (`{scanResults, scanRows, savedAt}`) |
| `ansatte` | Ansatte (v22) | `navn`, `stilling`, `timelonn`, `adresse`, `epost`, `bankkonto`, `personnummer`, `notater`, `aktiv` |
| `vakter` | Vakter (v22) | `dato`, `ansattId`, `fra`, `til`, `timer` (alternativ til fra/til), `notat` |
| `payments` | **Cold archive** — replaced by `bankTransactions` via migration 2026-04-26 (STEP 1 av DNB-skanner). **Do not write.** Beholdes urørt for rollback-mulighet. | (uendret skjema fra v27): `tenantId:'fourseason'`, `dato`, `bookingDato`, `leverandorId`, `levTekstRaa`, `belop`, `valuta:'NOK'`, `bankkonto`, `referanse`, `arkivref` (DNB unik), `metode` (`transfer`/`card`/`giro`), `linkedeFakturaer[]`, `opprettetAv`, `opprettet`, `notat` |
| `bankTransactions` | Banktransaksjoner — kun `supplier_payment` i Session 1, utvides med lønn/drift/POS-innskudd i Session 2-4 | **Mixed Norwegian (legacy from `payments`) and English (new) field names. Full English migration parked as decision #9.** Legacy NO felter: `tenantId`, `dato`, `bookingDato`, `leverandorId`, `levTekstRaa`, `belop`, `valuta`, `bankkonto`, `referanse`, `arkivref`, `metode`, `linkedeFakturaer[]`, `opprettetAv`, `opprettet`, `notat`. EN felter (V0.4 STEP 1): `type` (i dag bare `'supplier_payment'`), `direction` (`'in'`/`'out'`), `period` (YYYY-MM derived fra dato). Migration-only marker: `migratedFromPayments:true`, `migratedAt` (ISO-timestamp). **V1 Session 1 (2026-05-10) AI-skanner felter** (kun på AI-importerte records): `bankReference` (samme verdi som `arkivref` — Strategy B speiling for cross-channel dedup), `importBatchId` (én ID per skann-import-batch), `rawDescription` (uendret tekst-felt fra kontoutskriften), `aiExtracted:true`. Manuelt registrerte records har disse 4 felter `undefined` (defensive: alle dedup-/filter-sjekker bruker `||` eller `===true`). |
| `_meta` | System-metadata. **IKKE i `cols`-listener** — leses on-demand fra Firestore. | I dag bare `migrations`-doc med felt `paymentsToBankTransactions: <ISO-timestamp>` (sentinel for STEP 1). Fremtidige migrasjoner legger til flere felter i samme doc. |

## Kjente "skjermer/funksjoner uten tydelig formål" eller halvferdige

- **`ov-salg`-modal (linje 666)** — line-level salgsregistrering. Eksisterer men er **ikke koblet til FAB eller hdr-knapp** — FAB på Salg-siden går til `openDagsalgModal`. Bare lesbar fra UI ("Detaljerte salg"-listen viser `sales`, og `openSalgModal` finnes i kode (linje 2493) men kalles ikke fra noe synlig). Sannsynlig brukt av AI-skanner-flyt eller eldre integrasjon. **Vurder å avgjøre: enten gjenbruk eller fjern.**
- **`#setup-screen`** (~linje 340) — onboarding-UI for Firebase-config. Skjules ved boot fordi `boot()` hardkoder config. Kun nåbar via `resetSetup()`. Kan trolig fjernes.
- **`exportTimelistePDF`** (linje 3812) åpner ny vindu og kaller `print()`. Funksjonell, men avhenger av at popups ikke blokkeres.
- **Betalinger har bare create**, ingen `editBetaling`/`deleteBetaling` — listen er view-only. Hvis bruker oppdager feil, må de slette betalingen direkte fra Firestore.
- **Even-split attribusjon for betalinger**: 1/N pr. lenket faktura. Bevisst forenkling — kommentert i koden som "raffineres i STEP 5 hvis accountant trenger per-invoice splits".
- **Ingen bank-import enda** — alle betalinger skrives manuelt. STEP 4 av DNB-skanner-bygget vil legge til kontoutskrift-skanning til `bankTransactions`.
- **Hybrid skjema i `bankTransactions`**: blanding av norske legacy-felter og engelske nye felter. Full språk-migrasjon parked som decision #9.
- **Ingen rapport-aggregering** for `bankTransactions`-kolleksjonen — Rapporter-fanen dekker ikke betalinger.
- **Ingen forfalls-/reminder-tracking** på fakturaer.
- Ingen e-post-/varsels-system. Ingen offline-støtte (kun Firestore-cache via SDK-en).

## Andre praktiske detaljer
- **Sync-indikator**: liten grønn dot i header. `setSyncing()` på alle writes, `setSynced()` på snapshots.
- **Toast**: `showToast(msg, 'ok'|'err')`.
- **CSV-eksport**: `exportCSV('products'|'purchases')` — header-knapp på de to sidene.
- **Norske ID-er overalt**: alle UI-strenger på norsk, datoer YYYY-MM-DD intern, DD.MM.YYYY visning, NOK med komma-desimal.
- **Engelsk for ny kode** (parked decision #9): nye feltnavn, funksjonsnavn, identifiers er engelske. Eksisterende norske felter rørres ikke.

---

## Hvordan bruke dette dokumentet

- **Når Soren planlegger ny funksjonalitet**: sjekk dokumentet først for å se om noe lignende allerede finnes.
- **Når Claude Code skal endre kode**: bruk linjenumrene som inngangspunkt, men verifiser med `Grep` — filen vokser fort og linjene driver.

Dokumentet bør oppdateres når:
- En ny side, modal eller kolleksjon legges til.
- En eksisterende modul får vesentlig ny oppførsel.
- En halvferdig funksjon enten ferdigstilles eller fjernes.
