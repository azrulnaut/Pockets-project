# CLAUDE.md — Project Documentation

## Project Overview

SQLite schema for a mobile app that partitions fund amounts into atomic slices, each tagged with dimension values across multiple dimensions (e.g. Accounts, Purpose, Notes).

## File Structure

| File | Purpose |
|---|---|
| `sql/schema.sql` | DDL: all tables, indexes, and seed data. Run once on DB init. |
| `sql/queries.sql` | All app query patterns and the full rebalance workflow (Steps 1–5). |
| `sql/verify.sql` | End-to-end verification script for manual testing. |
| `src/server.js` | Express REST API server (all routes). |
| `src/db.js` | DB init, schema load, seed, query helpers, transaction functions. |
| `public/index.html` | Single-page UI shell. |
| `public/style.css` | Minimal styles. |
| `public/app.js` | Frontend JS: fetch calls, DOM rendering, modals. |
| `data/` | Runtime SQLite DB files (gitignored). |
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
- Deleting a dimension value first deletes all slices that reference it, then removes the value.
- Deleting a dimension row is blocked (RESTRICT) even via direct DB access.

## Running the Verification Script

```bash
# Requires sqlite3 CLI
sqlite3 data/verify.db < sql/schema.sql   # initialise
sqlite3 data/verify.db < sql/verify.sql   # run all 8 verification steps
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
node src/server.js     # → http://localhost:3000
```

- `src/db.js` opens `data/app.db`, runs `sql/schema.sql` once (if tables absent), seeds default fund.
- All amounts are cents (integers). Frontend divides by 100 for display, multiplies on send.
- `syncFundTotal()` — called after every write; sets `funds.total_amount = SUM(slices.amount)`.

### Transaction Functions (src/db.js)

| Function | Description |
|---|---|
| `executeAccountRebalance(accountDvId, transfers, fundId)` | Applies signed portions to account slices. `portion > 0` grows/creates; `portion < 0` shrinks/deletes. Other accounts untouched. Fund total changes by net delta. |
| `executeAccountTransfer(sourceAccountDvId, targetAccountDvId, transfers, fundId)` | Moves money between accounts preserving purpose tags. Fund total unchanged. |
| `executePurposeTransfer(sourcePurposeId, targetPurposeId, amount, fundId)` | Re-tags existing slices from one purpose to another. Fund total unchanged. |

### API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/state` | Fund total, all accounts with totals, all purposes with totals |
| GET | `/api/accounts/:id/slices` | Expanded slice breakdown for one account |
| GET | `/api/purposes/:id/slices` | Expanded slice breakdown for one purpose |
| POST | `/api/accounts` | Add account `{ label }` |
| POST | `/api/purposes` | Add purpose `{ label }` |
| PATCH | `/api/accounts/:id` | Rename account `{ label }` |
| PATCH | `/api/purposes/:id` | Rename purpose `{ label }` |
| DELETE | `/api/accounts/:id` | Delete account and all its slices |
| DELETE | `/api/purposes/:id` | Delete purpose and all its slices |
| GET | `/api/accounts/:id/rebalance-candidates?newTotal=N` | All purposes with `currentInAccount`; delta computed from newTotal |
| POST | `/api/accounts/:id/rebalance` | Execute rebalance `{ newTotal, transfers: [{purposeId, portion}] }` — portions are signed |
| POST | `/api/accounts/:id/transfer` | Transfer between accounts `{ targetAccountId, transfers: [{purposeId, portion}] }` |
| POST | `/api/purposes/:id/transfer` | Transfer between purposes `{ targetPurposeId, amount }` |

### Rebalance Logic

Account rebalancing operates only on the target account's slices — no other account is ever modified.

- **`transfers`** is an array of `{ purposeId, portion }` where `portion` is a **signed integer** (cents).
  - `portion > 0` → grow or create the `(account + purpose)` slice; fund total increases.
  - `portion < 0` → shrink or delete the `(account + purpose)` slice; fund total decreases.
- **`sum(portions) === delta`** is validated server-side (`delta = newTotal − currentTotal`).
- **`delta = 0`** is valid — allows redistribution of purposes within an account without changing its total.
- Negative portions are capped at `currentInAccount` for that purpose (validated server-side).

### Account Transfer Logic

- Transfers `portion` cents of a given purpose from source account to target account.
- Each `portion` must be ≤ `currentInAccount` for the source.
- Fund total is unchanged (net zero operation).
- Purpose tags are preserved on the target (e.g. Checking/Rent → Savings/Rent).

### UI Actions

| Action | Trigger | Description |
|---|---|---|
| Rebalance | [Rebal.] on account row | Adjust account total and/or redistribute purposes. [+]/[−] toggle per purpose row; [+] active by default. |
| Deposit | ↓ Deposit button | Enter delta amount + target account → purpose distribution screen. |
| Transfer | ⇄ Transfer button | Pick source + target account → purpose grid showing source's allocations. |
| Spend | ↑ Spend button | Enter delta amount + source account → purpose distribution screen. |
| Edit | [Edit] on any row | Rename or delete the account/purpose (delete cascades to its slices). |

## UI v2 (Branch: `ui-v2`)

A parallel UI experiment that shares the same Express backend and all `/api/...` routes.

| Item | Detail |
|---|---|
| Branch | `ui-v2` |
| Server entry | `src/server-v2.js` |
| Static files | `public-v2/` |
| Default port | `3001` (override with `PORT_V2` env var) |
| Run command | `npm run start:v2` → `http://localhost:3001` |

Only `src/server-v2.js` and `public-v2/` are branch-specific. All backend logic (`src/db.js`, `sql/`) is shared with `main`.

## Workflow for Future Changes

1. Edit schema/query/verify files as needed.
2. Claude will commit and push to the `main` branch on GitHub automatically when asked.
3. The GitHub repo is: **azrulnaut/Pockets-project**
