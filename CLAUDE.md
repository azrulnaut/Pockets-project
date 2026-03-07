# CLAUDE.md — Project Documentation

## Project Overview

SQLite schema for a mobile app that partitions fund amounts into atomic slices, each tagged with dimension values across multiple dimensions (e.g. Accounts, Purpose, Notes).

## File Structure

| File | Purpose |
|---|---|
| `schema.sql` | DDL: all tables, indexes, and seed data. Run once on DB init. |
| `queries.sql` | All app query patterns and the full rebalance workflow (Steps 1–5). |
| `verify.sql` | End-to-end verification script for manual testing. |
| `server.js` | Express REST API server (all routes). |
| `db.js` | DB init, schema load, seed, query helpers, transaction functions. |
| `public/index.html` | Single-page UI shell. |
| `public/style.css` | Minimal styles. |
| `public/app.js` | Frontend JS: fetch calls, DOM rendering, modals. |
| `package.json` | Node dependencies: express, better-sqlite3. |

## Key Design Decisions

- **Amounts are integers** (cents / smallest currency unit) to avoid floating-point rounding.
- **Three system dimensions** (`Accounts`, `Purpose`, `Notes`) are seeded with explicit IDs (1, 2, 3) so app code can reference them as constants. They are never modified by the user.
- **`PRAGMA foreign_keys = ON`** must be set on every SQLite connection — it is off by default.
- **`INSERT OR IGNORE`** on seed data makes initialisation idempotent.

## Constraint Layers

| Constraint | Layer | Reason |
|---|---|---|
| `amount >= 0` CHECK | DB | Zero allowed mid-transaction; zero-amount slices deleted after rebalance |
| `(dimension_id, label)` UNIQUE | DB | Data integrity |
| `(slice_id, dimension_value_id)` UNIQUE | DB | Prevents duplicates |
| Dimensions are read-only to users | App | No DELETE/INSERT on `dimensions` exposed in UI |
| Single-value per non-multiple dimension | App | UX enforces via radio (single) vs checkbox (multiple) pickers |
| Balancing dimension totals = fund total | App | Enforced via rebalance workflow + post-commit validation |

## Schema Summary

```
funds
  └── allocation_slices  (fund_id → funds.id CASCADE)
        └── slice_dimensions  (slice_id → allocation_slices.id CASCADE)
              └── dimension_values  (dimension_value_id → dimension_values.id RESTRICT)
                    └── dimensions  (dimension_id → dimensions.id RESTRICT)
```

- Deleting a fund cascades to slices and their tags.
- Deleting a dimension value is blocked (RESTRICT) if any slice references it — the app prompts the user to re-tag or delete referencing slices first.
- Deleting a dimension row is blocked (RESTRICT) even via direct DB access.

## Rebalance Workflow

Triggered when the user edits the total for a balancing dimension value.

1. **Compute delta** — `delta = new_target_total − current_total_for_dv`
2. **Present candidates** — query other dimension values; app filters by ability to donate/receive
3. **Find slices** — fetch slices for the chosen donor dimension value, ordered by amount DESC
4. **Execute transfer** — inside a `BEGIN/COMMIT` transaction:
   - Shrink donor slice by `portion`
   - Either grow an existing target slice (Option A) or create a new one inheriting the donor's other dimension tags (Option B)
   - Delete any zero-amount donor slice
5. **Post-commit validation** — app queries `SUM(amount)` for the balancing dimension and alerts if it doesn't equal `funds.total_amount`

### Option B — new slice id capture

After `INSERT INTO allocation_slices`, capture the new row id **before** inserting into `slice_dimensions`:
- **App code**: use `last_insert_rowid()` / the driver's insert-id method and bind it as `:new_slice_id`
- **Raw SQL script**: use `(SELECT MAX(id) FROM allocation_slices)` inside the same transaction

## Running the Verification Script

```bash
# Requires sqlite3 CLI
sqlite3 verify.db < schema.sql   # initialise
sqlite3 verify.db < verify.sql   # run all 8 verification steps
```

Expected results:
- Step 1: Accounts, Purpose, Notes seeded
- Step 4: Rent=50000, Food=30000, Transport=20000; sum=100000
- Step 6: Rent=60000, Food=20000, Transport=20000; sum=100000
- Steps 7 & 8: FK RESTRICT errors (expected and correct)

## Web Prototype

Stack: Node.js + Express + better-sqlite3, vanilla JS frontend.

```bash
npm install
node server.js     # → http://localhost:3000
```

- `db.js` opens `app.db`, runs `schema.sql` once (if tables absent), seeds default fund.
- All amounts are cents (integers). Frontend divides by 100 for display, multiplies on send.
- `executeAccountRebalance(accountDvId, transfers, fundId)` — wrapped in a better-sqlite3 transaction; shrinks donor slices then grows/creates target slice (Option A/B).
- `executePurposeTransfer(sourcePurposeId, targetPurposeId, amount, fundId)` — moves money between purposes, fund total unchanged.
- `syncFundTotal()` — called after every write; sets `funds.total_amount = SUM(slices.amount)`.

### API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/state` | Fund total, accounts with totals, purposes with totals |
| GET | `/api/accounts/:id/slices` | Expanded slice breakdown for one account |
| GET | `/api/purposes/:id/slices` | Expanded slice breakdown for one purpose |
| POST | `/api/accounts` | Add account `{ label }` |
| POST | `/api/purposes` | Add purpose `{ label }` |
| PATCH | `/api/accounts/:id` | Rename account `{ label }` |
| PATCH | `/api/purposes/:id` | Rename purpose `{ label }` |
| GET | `/api/accounts/:id/rebalance-candidates?newTotal=N` | Delta + purposes with donatable amounts |
| POST | `/api/accounts/:id/rebalance` | Execute rebalance `{ transfers: [{purposeId, portion}] }` |
| POST | `/api/purposes/:id/transfer` | Transfer between purposes `{ targetPurposeId, amount }` |

## Workflow for Future Changes

1. Edit schema/query/verify files as needed.
2. Claude will commit and push to the `main` branch on GitHub automatically when asked.
3. The GitHub repo is: **azrulnaut/financial-allocations-db**
