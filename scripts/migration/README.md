# Sormena Phase 4 — Data migration script

Copies data from `four-season-as` Firebase project (root collections) to `sormena-prod` (under `tenants/four-season-as/...` namespace).

## Prerequisites

Two service-account JSON keys must exist at:

- `C:\Users\gamme\credentials\four-season-as-key.json` (source)
- `C:\Users\gamme\credentials\sormena-prod-key.json` (destination)

These are NEVER committed (covered by repo `.gitignore`).

## Install

```
cd scripts/migration
npm install
```

## Run

Four modes, each saves a JSON report to `<repo-root>/migration-reports/`:

```
npm run dry-run               # Count source docs per collection. No writes.
npm run subset -- --collection=vakter   # Copy ONE collection (low-risk warm-up).
npm run full                  # Copy all 11 collections + _meta.
npm run verify                # Count match + sample field check on high-risk collections.
```

Or invoke `node migrate.js` directly:

```
node migrate.js --mode=dry-run
node migrate.js --mode=subset --collection=vakter
node migrate.js --mode=full
node migrate.js --mode=verify
```

Exit code 0 on `PASS`/`INFO`; nonzero on `FAIL` or unhandled error.

## What it copies

- All 11 data collections: `ansatte`, `bankTransactions`, `dagsalg`, `innboks`, `leverandorer`, `payments`, `products`, `purchases`, `sales`, `svinn`, `vakter`
- `_meta` collection (migration sentinels) — copied from source root to `tenants/four-season-as/_meta/...` in destination per Phase 1 Q1 lock

Document IDs are preserved exactly (uses `.doc(id).set(data)`, never `.add(data)`).

## High-risk collections (sampled in `verify` mode)

- `products` (1,072 docs — biggest by count)
- `purchases` (invoice records — sensitive financial data)
- `dagsalg` (POS daily totals — sensitive financial data)
- `innboks` (PDFs as base64 — verified via MD5 hash of `data` field, not by printing content)
