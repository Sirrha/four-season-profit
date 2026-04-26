# System-inventar — Four Season AS

**Last updated**: 2026-04-26, after v27→prod cutover.

Dette dokumentet kartlegger hva som faktisk finnes i `index.html` (produksjon, sormena.no). Mål: at Soren (chat) og Claude Code skal jobbe ut fra samme bilde av systemet og slippe å duplikere arbeid eller spørre om ting som allerede er bygget.

- **Filer kartlagt**: `index.html` (~5692 linjer)
- **Siste store endring**: v27 ble cutoveret til produksjon i kommit `95e308d` (2026-04-26). Tidligere `four-season-v27.html` er slettet — det er nå én produksjonsfil.

Linjenumre er ferske per cutover-datoen. Filen vokser fort, så verifiser med `Grep` før du redigerer rundt en gitt linje.

---

## Arkitektur i ett blikk
- **Én fil**, ingen build, ingen tester. HTML + CSS + JS inline.
- **Datalag**: Firebase v8 compat. **10 Firestore-kolleksjoner** mirroret til `LOCAL`-objektet (line 894). Listener pr. kolleksjon i `startListeners()` (line 962). `dbAdd/dbUpdate/dbDelete/dbFind/dbAll` (line 1020–1035) er eneste tilgang.
- **Sider**: 10 stk, bytte via `goTo(pg)` → `renderPage(pg)` (line 1149–1187). Hver render rebuildes fra `LOCAL` ved hvert kall.
- **Auth**: PIN-basert mot hardkodet `USERS`-map (line 4243). Lagres i `sessionStorage.fs_user`. Roller: `admin`, `regnskap`, `staff`. Firestore-rules er åpne — kun klientside-restriksjoner via `applyRoleRestrictions()`.
- **Boot**: IIFE `boot()` (line 4356) hardkoder Firebase-config og hopper over setup-skjermen.

## Konstanter
- `CATS` (line 868): 19 produktkategorier med navn, emoji, CSS-klasse.
- `ARSAK` (line 889): svinn-årsaker.
- `SUSOFT_CAT_MAP` (line 4383) + `normalizeSusoftCategory()` (line 4404): mapper Susofts rare kategorinavn ("Mat3", "Grønnskar", "None-food7") til interne `CATS`-nøkler.
- `USERS` (line 4243): 4 brukere — Herish (admin), Admin (admin), Regnskap (regnskap), Sormena (staff). PIN-koder hardkodet. **`displayUserName(name)` (line 4251)** mapper `'Herish'` → `'Hasher'` for visning. Underliggende navn `'Herish'` er uendret i sessionStorage, PIN-tabell og `opprettetAv`-felter.
- `AVG_ARBEIDSGIVER` 14,1%, `AVG_FERIEPENGER` 10,2%, sum 24,3% (line 3337–3339) — brukt i lønnskost.

## Sider (bunnav-orden)

| # | UI-navn | Render-funksjon | Page ID | Linje | Bruker kolleksjon(er) | Status |
|---|---------|----------------|---------|-------|------------------------|--------|
| 1 | Oversikt | `renderOversikt` | `pg-oversikt` | 1192 | `purchases`, `svinn`, `products`, `vakter`, `ansatte` | OK |
| 2 | Produkter | `renderProdukter` | `pg-produkter` | 1280 | `products` | OK |
| 3 | Lev. (Leverandører) | `renderLeverandorer` | `pg-leverandorer` | 2627 | `leverandorer`, `products`, `purchases` | OK |
| 4 | Innboks | `renderInnboks` | `pg-innboks` | 3064 | `innboks` | OK |
| 5 | Innkjøp | `renderInnkjop` | `pg-innkjop` | 1490 | `purchases`, `products`, `payments` | OK |
| 6 | Salg | `renderSalg` | `pg-salg` | 2125 | `dagsalg`, `sales`, `purchases` | OK |
| 7 | Svinn | `renderSvinn` | `pg-svinn` | 2544 | `svinn`, `products`, `purchases` | OK |
| 8 | Betalinger | `renderBetalinger` | `pg-betalinger` | 2773 | `payments`, `leverandorer`, `purchases` | OK (view + create) |
| 9 | Timeliste | `renderTimeliste` | `pg-timeliste` | 3399 | `ansatte`, `vakter`, `dagsalg` | OK |
| 10 | Rapporter | `renderRapporter` | `pg-rapporter` | 3319 | alle | OK |

## Brukersidens funksjoner

### Oversikt-side (linje 1192)
- **Dagens kort**: innkjøp inkl. MVA, forventet fortjeneste, GM-panel (kr/%, påslag), lønnskost i dag + teoretisk fortjeneste etter lønn.
- **Måned-stats**: innkjøp, fortjeneste, margin %, svinn.
- **Lønnskost-kort**: ukentlig + månedlig lønnskost (med arbeidsgiveravgift + feriepenger), teoretisk netto.
- **Lav GM-varsel**: viser produkter med GM <20%, klikkbart → `showLowGmDiagnostics()` (linje 1337, v21).
- **Siste fakturaer**: 6 siste, klikkbare → invoice-detail.

### Produkter (linje 1280)
- Søk + tabs per kategori. Liste viser pris-badges (inn eks/inkl, salg eks/utpris) og GM-badge.
- Modal `ov-produkt` (linje 514): navn, aliaser (komma-sep, brukt for AI-matching), kategori, enhet, leverandør, MVA, priser (auto-syncet eks↔inkl).
- CSV-eksport.

### Innkjøp (linje 1490)
- Tabs: I dag / Denne uken / Denne måneden / Alle. Stats-kort + GM-panel pr. periode.
- Liste over fakturaer → `showInvoiceDetail(id)` (linje 1735) som viser:
  - Faktura-hode med leverandør, fakturanr, dato, **betalingsstatus-pill** (✓ Betalt / ⚠ Delvis / ● Ikke betalt) og "✏️ Rediger"-knapp.
  - **Betalinger-seksjon**: sammendrag (betalt/utestående/antall) + liste pr. lenket betaling med dato, metode-emoji, referanse, beløp. Hvis betalingen er delt med andre fakturaer: "delt med N andre fakturaer".
  - **Reell-boks**: teoretisk resultat (innkjøp, forv. salg, svinnkost, GM) + reelt resultat hvis salg er knyttet (`calcInvoiceReelStats`, linje 1085).
  - Produktlinjer med all kolli-info, rediger/slett pr. linje (`showEditLineForm`, `deleteInvoiceLine`, `showAddLineForm`).
  - Slett hele fakturaen.
- Modal `ov-innkjop` (linje 581): manuell faktura med kolli-linjer + AI-skanner-knapp.

### Salg (linje 2125)
- Tabs: uke/mnd/alle.
- "I dag"-kort: omsetning inkl/eks MVA, eller knapper "📷 Skann Z-rapport" / "✏️ Registrer manuelt" hvis ikke registrert.
- Periode-stats: omsetning vs. forv. salg fra innkjøp, faktisk margin.
- Avvik-forklaringer hvis differanse >20% (selger mer enn innkjøp / selger mindre).
- Daglig historikk fra `dagsalg`. Klikk → `showDagsalgDetail(id)` (linje 2383) hvis `kilde='z-rapport-skann'` eller har kategorisalg, ellers `openDagsalgModal(id)`.
- "Detaljerte salg" (line-level `sales`-kolleksjon): liste, slett. Modal `ov-salg` (linje 666) finnes, men FAB peker til `openDagsalgModal` — så detaljerte salg er reelt sett bare lesbart fra UI.

### Svinn (linje 2544)
- Total svinnkost øverst.
- Liste pr. svinnpost. Modal `ov-svinn` (linje 683): produkt, faktura-knytting (auto-foreslår nyligste faktura for frukt), antall, årsak.
- Auto-knytting i `calcInvoiceReelStats`: usrelaterte svinn for frukt/grønt innenfor ±14 dager av faktura-dato regnes med — for å unngå dobbeltelling.

### Leverandører (linje 2627)
- Liste sortert alfabetisk. Hver lev viser: produkter, innkjøp, antall aliaser, prisregel-badge (inkl/eks/spør).
- "⚠️ N navn fra produkter og innkjøp er ikke i registeret" + `migrateLeverandorer()` (linje 2750): masse-oppretter fra free-text leverandørnavn.
- Modal `ov-leverandor` (linje 766): navn, org, konto, kontaktperson, prisregel, aliaser.
- `findLeverandorByName` (linje 2617) + `normName` (linje 2615): brukes til å matche fakturalev mot register.

### Innboks (linje 3064)
**Hva den gjør (sett fra brukerens side)**: holder PDF-er og bilder av fakturaer/Z-rapporter klare for skanning. Filer dras inn (eller velges via filplukker), lagres som base64 i `innboks`-kolleksjonen i Firestore (max 700KB pr. fil, da Firestore docs maks er 1MiB), og venter til brukeren trykker "Skann som faktura" eller "Skann som Z-rapport".
- Pending-liste viser filnavn, alder, og "💾 Utkast"-badge hvis skanning er påbegynt.
- Utkast-system (`saveScanAsDraft`, linje 3244 og `openScannerFromInnboks`, linje 3192): `it.utkast` har `scanResults` + `scanRows` + `savedAt`. "Fortsett utkast (X/Y)" laster det inn i scanneren igjen.
- "Ferdig"-mark eller slett pr. fil.
- Når faktura er lagret kalles `markInnboksLinkedDone()` (linje 3305) automatisk — fjerner utkastet og setter `status:'done'`.

### Betalinger (linje 2773)
**Hva den gjør (sett fra brukerens side)**: registrer hver betaling Four Season gjør (bankoverføring, kort, giro), valgfritt lenket til én eller flere ulenkede fakturaer fra samme leverandør. Lar brukeren se hvilke fakturaer som er betalt, delvis betalt, eller venter på betaling.
- Tabs: I dag / Denne uken / Denne måneden / Alle.
- Filter: per leverandør (dropdown).
- Liste pr. betaling: dato, metode-emoji (🏦 transfer / 💳 card / 🧾 giro), leverandørnavn (eller ⚠️ ikke i register), referanse, "🔗 lenket"/"ulenket"-badge, beløp.
- Bunnen: total beløp + antall betalinger.
- Modal `ov-betaling` (linje 804): to-faset.
  - **Phase 1** (`#bet-phase-1`): dato, booking-dato, leverandør (dropdown + free-text fallback), beløp, metode, bankkonto, referanse, arkivref (DNB unik bank-ID), notat. "Neste →" går til Phase 2.
  - **Phase 2** (`#bet-phase-2`): liste over **ulenkede fakturaer** for valgt leverandør (filtrert på `status !== 'paid'`), checkboxer. Status-linje viser om beløp matcher sum av valgte (✓ match / ⚠ differanse).
- Funksjoner: `openBetalingModal()` (line 2833), `onBetLevChange()` (line 2851), `goToBetPhase2()` (line 2862), `goToBetPhase1()` (line 2876), `renderBetPhase2Invoices()` (line 2881), `toggleBetInvoice()` (line 2920), `updateBetLinkStatus()` (line 2928), `saveBetaling()` (line 2946) — duplikat-sjekk på `arkivref` før lagring.

### Timeliste (linje 3399, v22)
- Tabs: Uke / Måned / Ansatte / Rapport.
- Uke-fane (`renderTlUke`, linje 3419): 7 dager, vakter pr. dag med fra/til eller direkte timer, "+ Legg til vakt" pr. dag.
- Måned-fane (`renderTlManned`, linje 3479): per ansatt — timer, brutto, full kost. CSV + PDF-eksport.
- Ansatte-fane (`renderTlAnsatte`, linje 3535): personalia, masker personnummer ("vis"-knapp).
- Rapport-fane (`renderTlRapport`, linje 3573): per ansatt, top 5 dager, lønnsandel mot omsetning.
- Modaler: `ov-ansatt` (linje 723), `ov-vakt` (linje 744). Personnummer maskeres med `maskPersonnummer` (linje 3345).

### Rapporter (linje 3319)
- Tabs: Fakturaer, Kategorier, Produkter, Per dag, Svinn, Uke vs Uke, Graf.
- Hver tab er en separat ren-funksjon (`rapFakturaer`, `rapKategorier`, `rapProdukter`, `rapDag`, `rapSvinn`, `rapUkeVsUke`, `rapGraf` — linje 3892–4209).
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
| `ov-scanner` | AI-skanner | 5581 | Faktura + Z-rapport |

## Kalkulasjons-motor (linje 1054–1132)
- `calcGM(buyEks, sellEks)` → `{gmKr, gmPct, paaslagPct}`.
- `calcKolliLine(antall, vektPerKolli, prisPerKolliInkl, vatRate, bonusKolli)` — håndterer "kjøp 20, få 10 gratis" via bonus.
- `calcPurchaseStats(purchase)` — summerer fakturaens linjer, regner forventet salg fra `products[].salgEks`.
- `calcInvoiceReelStats(invoiceId)` — krysser med `sales` og `svinn` for reelt resultat. Auto-attribuerer frukt/grønt-svinn ±14 dager.
- `getInvoicePaymentStatus(invoiceId)` (linje 1110, v27) — krysser `payments[].linkedeFakturaer`. **Even-split attribusjon**: 1/N pr. lenket faktura. Returnerer `{paid, paymentIds, paidAmount, status, total, outstanding}` der `status ∈ {'paid', 'partial', 'unpaid'}`. Kommentar i kode flagger at split skal raffineres hvis regnskap trenger per-faktura splits.
- `marginCls(m)` / `marginBadge(m)` (linje 1121–1122) — fargeskala: ≥30% grønn, ≥20% oransje, <20% rød.
- `gmPanelHtml(gmKr, gmPct, paaslagPct)` (linje 1123) — gjenbrukbar 3-korts visning.

## AI-skanner (linje 4377–5572)

### Faktura-skanner
- Inngang: `openScanner('faktura')` (linje 4431) eller via knapp i innkjøp-modal eller "Skann som faktura" i Innboks (`scanInnboksAsFaktura`, linje 3189).
- Multi-fil støtte: opp til 10 filer, 20MB total — alle blir én faktura.
- Sender til Cloudflare Worker `https://fourseason.herishhashemi.workers.dev` med `claude-sonnet-4-6`. API-nøkkel i `localStorage.fs_anthropic_key` (`saveApiKey`, linje 4419).
- Prompt definert i `runAIScan()` (linje 4609), legger ved bilder/PDF som `image`/`document`-content-blokker.
- `autoDetectScanRule(scanData)` (linje 5416, v25): regner ut om priser er eks/inkl. MVA basert på fakturatotal vs. linjesum. Matematikken slår lagret leverandør-regel når avvik <5%.
- `showScanResults` (linje 4942) → tabell med 16 kolonner. `scanRows` har all state. Bruker kan justere antall, innhold/kolli, MVA, utsalgspris pr. linje.
- Inline produktregistrering for ukjente produkter (`registerScanRowProduct`, linje 5309) — det finnes ingen separat "produktskanner"; dette er produktskanneren.
- Duplikat-sjekk på fakturanr + lev (i `runAIScan`, v22): tidlig avbryt hvis faktura allerede finnes.
- Lagring av utkast (`saveScanAsDraft`, linje 3244): hvis filen ikke ligger i Innboks, tilbyr å først lagre der.
- `confirmScanToInnkjop` (linje 5478) overfører til `pLines` og åpner `ov-innkjop`-modalen.
- **Lagres til**: `purchases`-kolleksjonen som vanlig faktura. Innboks-fil markeres `done`. Produkter får oppdatert `buyEks`/`buyInkl` automatisk (v21 Fix 2). Hvis utsalgspriser er endret: tilbyr å oppdatere `salgEks`/`salgInkl` på produktene.

### Z-rapport-skanner
- Inngang: `openZRapportScanner()` (linje 4460) — kalles fra "📷 Skann Z-rapport"-knapp på Salg-siden, eller "Skann som Z-rapport" i Innboks (`scanInnboksAsZRapport`, linje 3190).
- Bruker samme `runAIScan()` med `scanMode='z-rapport'` — egen prompt som ber om totalbeløp, MVA-fordeling, kategorisalg, ordretall, rabatt/uttak/slettet/retur.
- `showZRapportResults` (linje 4790) → forhåndsvisning med MVA-tabell + kategorisalg (med Susoft→intern matching) + meta.
- `confirmZRapportScan` (linje 4882) lagrer/oppdaterer i `dagsalg`-kolleksjonen med `kilde:'z-rapport-skann'`. Felter: `mvaBreakdown`, `kategoriSalg[]` med `internalKey` for matchede kategorier, `antallOrdre/Kvittering`, `rabattTotal`, `vareuttak`, `slettetTotal`, `retur`.
- **Lagres til**: `dagsalg`-kolleksjonen — vises på Salg-siden. Detalj-visning (`showDagsalgDetail`, linje 2383) viser MVA-fordeling og kategorisalg som tabell.

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
| `payments` | Betalinger (v27) | `tenantId:'fourseason'`, `dato`, `bookingDato`, `leverandorId`, `levTekstRaa`, `belop`, `valuta:'NOK'`, `bankkonto`, `referanse`, `arkivref` (DNB unik), `metode` (`transfer`/`card`/`giro`), `linkedeFakturaer[]`, `opprettetAv`, `opprettet`, `notat` |

## Kjente "skjermer/funksjoner uten tydelig formål" eller halvferdige

- **`ov-salg`-modal (linje 666)** — line-level salgsregistrering. Eksisterer men er **ikke koblet til FAB eller hdr-knapp** — FAB på Salg-siden går til `openDagsalgModal`. Bare lesbar fra UI ("Detaljerte salg"-listen viser `sales`, og `openSalgModal` finnes i kode (linje 2490) men kalles ikke fra noe synlig). Sannsynlig brukt av AI-skanner-flyt eller eldre integrasjon. **Vurder å avgjøre: enten gjenbruk eller fjern.**
- **`#setup-screen`** (~linje 340) — onboarding-UI for Firebase-config. Skjules ved boot fordi `boot()` hardkoder config. Kun nåbar via `resetSetup()`. Kan trolig fjernes.
- **`exportTimelistePDF`** (linje 3803) åpner ny vindu og kaller `print()`. Funksjonell, men avhenger av at popups ikke blokkeres.
- **Betalinger har bare create**, ingen `editBetaling`/`deleteBetaling` — listen er view-only. Hvis bruker oppdager feil, må de slette betalingen direkte fra Firestore.
- **Even-split attribusjon for betalinger**: 1/N pr. lenket faktura. Bevisst forenkling — kommentert i koden som "raffineres i STEP 5 hvis accountant trenger per-invoice splits".
- **Ingen bank-import** for betalinger — alle skrives manuelt. Egen kontoutskrift-app er planlagt separat.
- **Ingen rapport-aggregering** for `payments`-kolleksjonen — Rapporter-fanen dekker ikke betalinger.
- **Ingen forfalls-/reminder-tracking** på fakturaer.
- Ingen e-post-/varsels-system. Ingen offline-støtte (kun Firestore-cache via SDK-en).

## Andre praktiske detaljer
- **Sync-indikator**: liten grønn dot i header. `setSyncing()` på alle writes, `setSynced()` på snapshots.
- **Toast**: `showToast(msg, 'ok'|'err')`.
- **CSV-eksport**: `exportCSV('products'|'purchases')` — header-knapp på de to sidene.
- **Norske ID-er overalt**: alle UI-strenger på norsk, datoer YYYY-MM-DD intern, DD.MM.YYYY visning, NOK med komma-desimal.

---

## Hvordan bruke dette dokumentet

- **Når Soren planlegger ny funksjonalitet**: sjekk dokumentet først for å se om noe lignende allerede finnes.
- **Når Claude Code skal endre kode**: bruk linjenumrene som inngangspunkt, men verifiser med `Grep` — filen vokser fort og linjene driver.

Dokumentet bør oppdateres når:
- En ny side, modal eller kolleksjon legges til.
- En eksisterende modul får vesentlig ny oppførsel.
- En halvferdig funksjon enten ferdigstilles eller fjernes.
