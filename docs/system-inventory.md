# System-inventar — Four Season AS

**Last updated**: 2026-04-26, after STEP 1 of DNB-skanner (payments → bankTransactions migration).

Dette dokumentet kartlegger hva som faktisk finnes i `index.html` (produksjon, sormena.no). Mål: at Soren (chat) og Claude Code skal jobbe ut fra samme bilde av systemet og slippe å duplikere arbeid eller spørre om ting som allerede er bygget.

- **Filer kartlagt**: `index.html` (~5744 linjer)
- **Siste store endring**: STEP 1 av DNB-skanner-bygget (2026-04-26) — `payments` → `bankTransactions`-migrasjon med engelske tilleggsfelter (`type`, `direction`, `period`). `payments` er nå cold archive — ingen nye writes dit.
- **Tidligere milestone**: v27 ble cutoveret til produksjon i kommit `95e308d` (2026-04-26). Tidligere `four-season-v27.html` er slettet — det er nå én produksjonsfil.

**Språkpolicy (parked decision #9)**: Som av 2026-04-26: Engelsk for all ny kode (feltnavn, funksjonsnavn, identifiers). Eksisterende norske feltnavn (`dato`, `belop`, `linkedeFakturaer`, etc.) beholdes bakoverkompatibelt inntil en dedikert språkmigrasjon. Resultatet er midlertidig hybrid skjema i `bankTransactions`. UI-strenger forblir norske.

Linjenumre er ferske per 2026-04-26 (etter STEP 1). Filen vokser fort, så verifiser med `Grep` før du redigerer rundt en gitt linje.

---

## Arkitektur i ett blikk
- **Én fil**, ingen build, ingen tester. HTML + CSS + JS inline.
- **Datalag**: Firebase v8 compat. **12 Firestore-kolleksjoner totalt** — 11 mirroret til `LOCAL`-objektet (line 894), pluss `_meta` som er system-only (migrasjons-sentinels) og IKKE i `cols`-listener. Listener pr. data-kolleksjon i `startListeners()` (line 962). `dbAdd/dbUpdate/dbDelete/dbFind/dbAll` (line 1020–1035) er eneste tilgang for data-kolleksjoner.
- **Sider**: 10 stk, bytte via `goTo(pg)` → `renderPage(pg)` (line 1149–1187). Hver render rebuildes fra `LOCAL` ved hvert kall.
- **Auth**: PIN-basert mot hardkodet `USERS`-map (line 4252). Lagres i `sessionStorage.fs_user`. Roller: `admin`, `regnskap`, `staff`. Firestore-rules er åpne — kun klientside-restriksjoner via `applyRoleRestrictions()`.
- **Boot**: IIFE `boot()` (line 4365) hardkoder Firebase-config og hopper over setup-skjermen. `showApp()` kaller `migratePaymentsToBankTransactions()` (fire-and-forget) før UI vises.

## Konstanter
- `CATS` (line 868): 19 produktkategorier med navn, emoji, CSS-klasse.
- `ARSAK` (line 889): svinn-årsaker.
- `SUSOFT_CAT_MAP` (line 4435) + `normalizeSusoftCategory()` (line 4456): mapper Susofts rare kategorinavn ("Mat3", "Grønnskar", "None-food7") til interne `CATS`-nøkler.
- `USERS` (line 4252): 4 brukere — Herish (admin), Admin (admin), Regnskap (regnskap), Sormena (staff). PIN-koder hardkodet. **`displayUserName(name)` (line 4260)** mapper `'Herish'` → `'Hasher'` for visning. Underliggende navn `'Herish'` er uendret i sessionStorage, PIN-tabell og `opprettetAv`-felter.
- `AVG_ARBEIDSGIVER` 14,1%, `AVG_FERIEPENGER` 10,2%, sum 24,3% (line 3346–3348) — brukt i lønnskost.

## Sider (bunnav-orden)

| # | UI-navn | Render-funksjon | Page ID | Linje | Bruker kolleksjon(er) | Status |
|---|---------|----------------|---------|-------|------------------------|--------|
| 1 | Oversikt | `renderOversikt` | `pg-oversikt` | 1192 | `purchases`, `svinn`, `products`, `vakter`, `ansatte` | OK |
| 2 | Produkter | `renderProdukter` | `pg-produkter` | 1280 | `products` | OK |
| 3 | Lev. (Leverandører) | `renderLeverandorer` | `pg-leverandorer` | 2630 | `leverandorer`, `products`, `purchases` | OK |
| 4 | Innboks | `renderInnboks` | `pg-innboks` | 3073 | `innboks` | OK |
| 5 | Innkjøp | `renderInnkjop` | `pg-innkjop` | 1493 | `purchases`, `products`, `bankTransactions` | OK |
| 6 | Salg | `renderSalg` | `pg-salg` | 2128 | `dagsalg`, `sales`, `purchases` | OK |
| 7 | Svinn | `renderSvinn` | `pg-svinn` | 2547 | `svinn`, `products`, `purchases` | OK |
| 8 | Betalinger | `renderBetalinger` | `pg-betalinger` | 2776 | `bankTransactions`, `leverandorer`, `purchases` | OK (view + create) |
| 9 | Timeliste | `renderTimeliste` | `pg-timeliste` | 3408 | `ansatte`, `vakter`, `dagsalg` | OK |
| 10 | Rapporter | `renderRapporter` | `pg-rapporter` | 3328 | alle | OK |

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

### Innkjøp (linje 1493)
- Tabs: I dag / Denne uken / Denne måneden / Alle. Stats-kort + GM-panel pr. periode.
- Liste over fakturaer → `showInvoiceDetail(id)` (linje 1738) som viser:
  - Faktura-hode med leverandør, fakturanr, dato, **betalingsstatus-pill** (✓ Betalt / ⚠ Delvis / ● Ikke betalt) og "✏️ Rediger"-knapp.
  - **Betalinger-seksjon**: sammendrag (betalt/utestående/antall) + liste pr. lenket betaling med dato, metode-emoji, referanse, beløp. Hvis betalingen er delt med andre fakturaer: "delt med N andre fakturaer". Leser fra `bankTransactions` med filter `type==='supplier_payment'||!type` (STEP 1).
  - **Reell-boks**: teoretisk resultat (innkjøp, forv. salg, svinnkost, GM) + reelt resultat hvis salg er knyttet (`calcInvoiceReelStats`, linje 1087).
  - Produktlinjer med all kolli-info, rediger/slett pr. linje (`showEditLineForm`, `deleteInvoiceLine`, `showAddLineForm`).
  - Slett hele fakturaen.
- Modal `ov-innkjop` (linje 581): manuell faktura med kolli-linjer + AI-skanner-knapp.

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

### Innboks (linje 3073)
**Hva den gjør (sett fra brukerens side)**: holder PDF-er og bilder av fakturaer/Z-rapporter klare for skanning. Filer dras inn (eller velges via filplukker), lagres som base64 i `innboks`-kolleksjonen i Firestore (max 700KB pr. fil, da Firestore docs maks er 1MiB), og venter til brukeren trykker "Skann som faktura" eller "Skann som Z-rapport".
- Pending-liste viser filnavn, alder, og "💾 Utkast"-badge hvis skanning er påbegynt.
- Utkast-system (`saveScanAsDraft`, linje 3253 og `openScannerFromInnboks`, linje 3201): `it.utkast` har `scanResults` + `scanRows` + `savedAt`. "Fortsett utkast (X/Y)" laster det inn i scanneren igjen.
- "Ferdig"-mark eller slett pr. fil.
- Når faktura er lagret kalles `markInnboksLinkedDone()` (linje 3314) automatisk — fjerner utkastet og setter `status:'done'`.

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
| `ov-scanner` | AI-skanner | 5633 | Faktura + Z-rapport |

## Kalkulasjons-motor (linje 1056–1135)
- `calcGM(buyEks, sellEks)` (linje 1056) → `{gmKr, gmPct, paaslagPct}`.
- `calcKolliLine(antall, vektPerKolli, prisPerKolliInkl, vatRate, bonusKolli)` (linje 1062) — håndterer "kjøp 20, få 10 gratis" via bonus.
- `calcPurchaseStats(purchase)` (linje 1077) — summerer fakturaens linjer, regner forventet salg fra `products[].salgEks`.
- `calcInvoiceReelStats(invoiceId)` (linje 1087) — krysser med `sales` og `svinn` for reelt resultat. Auto-attribuerer frukt/grønt-svinn ±14 dager.
- `getInvoicePaymentStatus(invoiceId)` (linje 1112, v27) — leser fra `bankTransactions` med type-filter `type==='supplier_payment'||!type`. **Even-split attribusjon**: 1/N pr. lenket faktura. Returnerer `{paid, paymentIds, paidAmount, status, total, outstanding}` der `status ∈ {'paid', 'partial', 'unpaid'}`. Kommentar i kode flagger at split skal raffineres hvis regnskap trenger per-faktura splits.
- `marginCls(m)` / `marginBadge(m)` (linje 1124–1125) — fargeskala: ≥30% grønn, ≥20% oransje, <20% rød.
- `gmPanelHtml(gmKr, gmPct, paaslagPct)` (linje 1126) — gjenbrukbar 3-korts visning.

## Migrasjoner (linje 4385–4429)
One-shot data-transformasjoner gated av Firestore `_meta/migrations`-dokumentet. Kjøres fra `showApp()` rett før UI vises (fire-and-forget; idempotent via sentinel + per-doc `existingIds`-skip).

- `migratePaymentsToBankTransactions()` (linje 4387, STEP 1 av DNB-skanner) — kopierer alle records fra `payments` → `bankTransactions`, beholder source-ID og alle norske felter (`...p` spread), legger til engelske `type:'supplier_payment'`, `direction:'out'`, `period` (YYYY-MM), `migratedFromPayments:true`, `migratedAt`. Sentinel-felt: `paymentsToBankTransactions` (ISO-timestamp). Ved feil: sentinel ikke satt, toast vises, retry på neste boot.

## AI-skanner (linje 4429–5624)

### Faktura-skanner
- Inngang: `openScanner('faktura')` (linje 4483) eller via knapp i innkjøp-modal eller "Skann som faktura" i Innboks (`scanInnboksAsFaktura`, linje 3198).
- Multi-fil støtte: opp til 10 filer, 20MB total — alle blir én faktura.
- Sender til Cloudflare Worker `https://fourseason.herishhashemi.workers.dev` med `claude-sonnet-4-6`. API-nøkkel i `localStorage.fs_anthropic_key` (`saveApiKey`, linje 4471).
- Prompt definert i `runAIScan()` (linje 4661), legger ved bilder/PDF som `image`/`document`-content-blokker.
- `autoDetectScanRule(scanData)` (linje 5468, v25): regner ut om priser er eks/inkl. MVA basert på fakturatotal vs. linjesum. Matematikken slår lagret leverandør-regel når avvik <5%.
- `showScanResults` (linje 4994) → tabell med 16 kolonner. `scanRows` har all state. Bruker kan justere antall, innhold/kolli, MVA, utsalgspris pr. linje.
- Inline produktregistrering for ukjente produkter (`registerScanRowProduct`, linje 5361) — det finnes ingen separat "produktskanner"; dette er produktskanneren.
- Duplikat-sjekk på fakturanr + lev (i `runAIScan`, v22): tidlig avbryt hvis faktura allerede finnes.
- Lagring av utkast (`saveScanAsDraft`, linje 3253): hvis filen ikke ligger i Innboks, tilbyr å først lagre der.
- `confirmScanToInnkjop` (linje 5530) overfører til `pLines` og åpner `ov-innkjop`-modalen.
- **Lagres til**: `purchases`-kolleksjonen som vanlig faktura. Innboks-fil markeres `done`. Produkter får oppdatert `buyEks`/`buyInkl` automatisk (v21 Fix 2). Hvis utsalgspriser er endret: tilbyr å oppdatere `salgEks`/`salgInkl` på produktene.

### Z-rapport-skanner
- Inngang: `openZRapportScanner()` (linje 4512) — kalles fra "📷 Skann Z-rapport"-knapp på Salg-siden, eller "Skann som Z-rapport" i Innboks (`scanInnboksAsZRapport`, linje 3199).
- Bruker samme `runAIScan()` med `scanMode='z-rapport'` — egen prompt som ber om totalbeløp, MVA-fordeling, kategorisalg, ordretall, rabatt/uttak/slettet/retur.
- `showZRapportResults` (linje 4842) → forhåndsvisning med MVA-tabell + kategorisalg (med Susoft→intern matching) + meta.
- `confirmZRapportScan` (linje 4934) lagrer/oppdaterer i `dagsalg`-kolleksjonen med `kilde:'z-rapport-skann'`. Felter: `mvaBreakdown`, `kategoriSalg[]` med `internalKey` for matchede kategorier, `antallOrdre/Kvittering`, `rabattTotal`, `vareuttak`, `slettetTotal`, `retur`.
- **Lagres til**: `dagsalg`-kolleksjonen — vises på Salg-siden. Detalj-visning (`showDagsalgDetail`, linje 2386) viser MVA-fordeling og kategorisalg som tabell.

## Datafelter — hva ligger i hver Firestore-kolleksjon

| Kolleksjon | Lagrer hva | Sentrale felter |
|------------|-----------|-----------------|
| `products` | Produktregister | `navn`, `kategori`, `enhet`, `leverandorId`, `lev` (legacy text), `mva`, `aliaser[]`, `buyEks`, `buyInkl`, `salgEks`, `salgInkl`, `aktiv` |
| `purchases` | Fakturaer/innkjøp | `dato`, `fakturanr`, `leverandorId`, `lev`, `lines[]` (med `productId`, `antall`, `vektPerKolli`/`innholdPerKolli`, `prisPerKolliInkl`, `vatRate`, `bonusKolli`, kalkulerte `totalEks`/`totalInkl`/`prPerEnhetEks`/`prPerEnhetInkl`/`totalVekt`), `notes` |
| `sales` | Linje-nivå salg (manuell) | `dato`, `ref`, `fakturaId` (link), `lines[]` med `productId`, `qty`, `sellPriceEks` |
| `dagsalg` | Daglig salgs-total fra POS | `dato`, `totalInkl`, `totalEks`, `mva`, `kilde`, `antallTrans`, `ref`, + Z-skann: `nummer`, `klokke`, `mvaTotal`, `mvaBreakdown`, `kategoriSalg[]`, `antallOrdre`, `rabattTotal`, `vareuttak`, `slettetTotal`, `retur` |
| `svinn` | Svinn-poster | `dato`, `productId`, `qty`, `arsak`, `komm`, `fakturaId` (eksplisitt link), `kostverdi` |
| `leverandorer` | Leverandørregister | `navn`, `aliaser[]`, `orgNummer`, `kontoNummer`, `kontaktperson`, `telefon`, `epost`, `prisregel` (`ask`/`inkl`/`eks`), `notat`, `fraMigrasjon` |
| `innboks` | Filer som venter på skanning | `filnavn`, `storrelse`, `type` (`pdf`/`image`), `mimeType`, `data` (base64), `status` (`pending`/`done`), `notat`, `utkast` (`{scanResults, scanRows, savedAt}`) |
| `ansatte` | Ansatte (v22) | `navn`, `stilling`, `timelonn`, `adresse`, `epost`, `bankkonto`, `personnummer`, `notater`, `aktiv` |
| `vakter` | Vakter (v22) | `dato`, `ansattId`, `fra`, `til`, `timer` (alternativ til fra/til), `notat` |
| `payments` | **Cold archive** — replaced by `bankTransactions` via migration 2026-04-26 (STEP 1 av DNB-skanner). **Do not write.** Beholdes urørt for rollback-mulighet. | (uendret skjema fra v27): `tenantId:'fourseason'`, `dato`, `bookingDato`, `leverandorId`, `levTekstRaa`, `belop`, `valuta:'NOK'`, `bankkonto`, `referanse`, `arkivref` (DNB unik), `metode` (`transfer`/`card`/`giro`), `linkedeFakturaer[]`, `opprettetAv`, `opprettet`, `notat` |
| `bankTransactions` | Banktransaksjoner — kun `supplier_payment` i STEP 1, utvides med lønn/drift/POS-innskudd i STEP 4 av DNB-skanner | **Mixed Norwegian (legacy from `payments`) and English (new) field names. Full English migration parked as decision #9.** Legacy NO felter: `tenantId`, `dato`, `bookingDato`, `leverandorId`, `levTekstRaa`, `belop`, `valuta`, `bankkonto`, `referanse`, `arkivref`, `metode`, `linkedeFakturaer[]`, `opprettetAv`, `opprettet`, `notat`. Nye EN felter: `type` (i dag bare `'supplier_payment'`), `direction` (`'out'`), `period` (YYYY-MM derived fra dato). Migration-only marker: `migratedFromPayments:true`, `migratedAt` (ISO-timestamp). |
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
