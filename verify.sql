-- ============================================================
-- VERIFICATION SCRIPT
-- Runs the 8 verification steps from the plan end-to-end.
-- Execute with: sqlite3 verify.db < verify.sql
-- ============================================================

PRAGMA foreign_keys = ON;

-- Load schema and seed data
.read schema.sql

-- ============================================================
-- Step 1: Confirm seed dimensions
-- ============================================================
SELECT 'Step 1 - Seed dimensions:';
SELECT id, name, is_balancing, allows_multiple FROM dimensions;

-- ============================================================
-- Step 2: Add fund ($1000 = 100000 cents) and Purpose values
-- ============================================================
INSERT INTO funds (name, total_amount) VALUES ('Main Fund', 100000);

INSERT INTO dimension_values (dimension_id, label) VALUES
    (1, 'Checking'),
    (1, 'Savings'),
    (2, 'Rent'),
    (2, 'Food'),
    (2, 'Transport');

-- ============================================================
-- Step 3: Add slices
--   Rent $500 / Checking  → Purpose=Rent(id=3), Accounts=Checking(id=1)
--   Food $300 / Savings   → Purpose=Food(id=4),  Accounts=Savings(id=2)
--   Transport $200 / Checking → Purpose=Transport(id=5), Accounts=Checking(id=1)
-- ============================================================
INSERT INTO allocation_slices (fund_id, amount) VALUES (1, 50000); -- Rent $500
INSERT INTO slice_dimensions (slice_id, dimension_value_id) VALUES (1, 3); -- Purpose=Rent
INSERT INTO slice_dimensions (slice_id, dimension_value_id) VALUES (1, 1); -- Accounts=Checking

INSERT INTO allocation_slices (fund_id, amount) VALUES (1, 30000); -- Food $300
INSERT INTO slice_dimensions (slice_id, dimension_value_id) VALUES (2, 4); -- Purpose=Food
INSERT INTO slice_dimensions (slice_id, dimension_value_id) VALUES (2, 2); -- Accounts=Savings

INSERT INTO allocation_slices (fund_id, amount) VALUES (1, 20000); -- Transport $200
INSERT INTO slice_dimensions (slice_id, dimension_value_id) VALUES (3, 5); -- Purpose=Transport
INSERT INTO slice_dimensions (slice_id, dimension_value_id) VALUES (3, 1); -- Accounts=Checking

-- ============================================================
-- Step 4: Summary query — expect Rent 50000, Food 30000, Transport 20000
-- ============================================================
SELECT 'Step 4 - Purpose totals (should be Rent=50000, Food=30000, Transport=20000):';
SELECT dv.label, COALESCE(SUM(s.amount), 0) AS total
FROM   dimension_values  dv
LEFT JOIN slice_dimensions  sd ON sd.dimension_value_id = dv.id
LEFT JOIN allocation_slices s  ON s.id = sd.slice_id AND s.fund_id = 1
WHERE  dv.dimension_id = 2
GROUP  BY dv.id;

-- ============================================================
-- Step 5: Rebalance — Rent → $600 (delta = +10000)
--   Donor: Food slice (id=2), portion = 10000
--   No existing slice tagged both Rent+Savings, so use Option B.
-- ============================================================
SELECT 'Step 5 - Executing rebalance (Rent +10000, Food -10000):';
BEGIN;

-- Shrink Food slice
UPDATE allocation_slices SET amount = amount - 10000, updated_at = datetime('now') WHERE id = 2;

-- New slice: Rent $10000 / Savings (inherit Savings tag, swap Purpose to Rent)
-- Use MAX(id) to capture the new slice id within the transaction (safe; no concurrent writes).
-- In app code, capture last_insert_rowid() after the INSERT and bind it as a parameter instead.
INSERT INTO allocation_slices (fund_id, amount) VALUES (1, 10000);
INSERT INTO slice_dimensions (slice_id, dimension_value_id)
    SELECT (SELECT MAX(id) FROM allocation_slices), dimension_value_id
    FROM   slice_dimensions
    WHERE  slice_id = 2
      AND  dimension_value_id NOT IN (
               SELECT id FROM dimension_values WHERE dimension_id = 2
           );
INSERT INTO slice_dimensions (slice_id, dimension_value_id)
    VALUES ((SELECT MAX(id) FROM allocation_slices), 3); -- Purpose=Rent

-- Clean up zero-amount slices (Food is 20000 so no cleanup needed here)
DELETE FROM allocation_slices WHERE amount = 0;

COMMIT;

-- ============================================================
-- Step 6: Summary — expect Rent=60000, Food=20000, Transport=20000
-- ============================================================
SELECT 'Step 6 - Purpose totals after rebalance (should be Rent=60000, Food=20000, Transport=20000):';
SELECT dv.label, COALESCE(SUM(s.amount), 0) AS total
FROM   dimension_values  dv
LEFT JOIN slice_dimensions  sd ON sd.dimension_value_id = dv.id
LEFT JOIN allocation_slices s  ON s.id = sd.slice_id AND s.fund_id = 1
WHERE  dv.dimension_id = 2
GROUP  BY dv.id;

SELECT 'Step 6 - Sum should equal 100000:';
SELECT SUM(s.amount) AS grand_total FROM allocation_slices s WHERE s.fund_id = 1;

-- ============================================================
-- Step 7: FK RESTRICT blocks DELETE on a dimension row
-- ============================================================
SELECT 'Step 7 - Attempting to DELETE dimension (should be blocked by FK RESTRICT):';
DELETE FROM dimensions WHERE id = 1;
-- SQLite with foreign_keys=ON will raise: FOREIGN KEY constraint failed

-- ============================================================
-- Step 8: FK RESTRICT blocks DELETE on a dimension value in use
-- ============================================================
SELECT 'Step 8 - Attempting to DELETE dimension_value in use (should be blocked):';
DELETE FROM dimension_values WHERE id = 1; -- Accounts=Checking, referenced by slices
-- SQLite with foreign_keys=ON will raise: FOREIGN KEY constraint failed
