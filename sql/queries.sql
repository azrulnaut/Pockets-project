-- ============================================================
-- QUERY PATTERNS
-- ============================================================

-- Current totals by dimension value (summary screen)
-- Replace :fund_id and :dimension_id with actual values.
SELECT dv.id, dv.label, COALESCE(SUM(s.amount), 0) AS total
FROM   dimension_values  dv
LEFT JOIN slice_dimensions  sd ON sd.dimension_value_id = dv.id
LEFT JOIN allocation_slices s  ON s.id = sd.slice_id AND s.fund_id = :fund_id
WHERE  dv.dimension_id = :dimension_id
GROUP  BY dv.id;

-- Cross-dimension breakdown
SELECT dv1.label AS dim1, dv2.label AS dim2, SUM(s.amount) AS total
FROM   allocation_slices s
JOIN   slice_dimensions sd1 ON sd1.slice_id = s.id
JOIN   dimension_values dv1 ON dv1.id = sd1.dimension_value_id AND dv1.dimension_id = :dim1_id
JOIN   slice_dimensions sd2 ON sd2.slice_id = s.id
JOIN   dimension_values dv2 ON dv2.id = sd2.dimension_value_id AND dv2.dimension_id = :dim2_id
WHERE  s.fund_id = :fund_id
GROUP  BY dv1.id, dv2.id;

-- ============================================================
-- REBALANCE WORKFLOW
-- ============================================================

-- Step 2: Present donor/recipient candidates
-- App filters results: delta>0 → show only current_total >= abs(delta); delta<0 → show all.
SELECT dv.id, dv.label, COALESCE(SUM(s.amount), 0) AS current_total
FROM   dimension_values dv
LEFT JOIN slice_dimensions  sd ON sd.dimension_value_id = dv.id
LEFT JOIN allocation_slices s  ON s.id = sd.slice_id AND s.fund_id = :fund_id
WHERE  dv.dimension_id = :dimension_id
  AND  dv.id != :target_dv_id
GROUP  BY dv.id;

-- Step 3: Find slices to adjust for a chosen donor dimension value
SELECT s.id, s.amount
FROM   allocation_slices s
JOIN   slice_dimensions  sd ON sd.slice_id = s.id
WHERE  sd.dimension_value_id = :donor_dv_id
  AND  s.fund_id = :fund_id
ORDER  BY s.amount DESC;

-- Step 4: Execute transfer (run inside a transaction)
BEGIN;

-- Shrink donor slice
UPDATE allocation_slices
SET    amount = amount - :portion, updated_at = datetime('now')
WHERE  id = :donor_slice_id;

-- Option A: existing target slice (same tag combination already exists)
UPDATE allocation_slices
SET    amount = amount + :portion, updated_at = datetime('now')
WHERE  id = :target_slice_id;

-- Option B: new target slice (inherit donor's other dimension tags, swap target dimension value)
-- In app code: capture new_slice_id = last_insert_rowid() after this INSERT,
-- then bind it as :new_slice_id in the two slice_dimensions inserts below.
INSERT INTO allocation_slices (fund_id, amount) VALUES (:fund_id, :portion);
INSERT INTO slice_dimensions (slice_id, dimension_value_id)
    SELECT :new_slice_id, dimension_value_id
    FROM   slice_dimensions
    WHERE  slice_id = :donor_slice_id
      AND  dimension_value_id NOT IN (
               SELECT id FROM dimension_values WHERE dimension_id = :rebalancing_dimension_id
           );
INSERT INTO slice_dimensions (slice_id, dimension_value_id)
    VALUES (:new_slice_id, :target_dv_id);

-- Clean up zero-amount donor slice
DELETE FROM allocation_slices WHERE id = :donor_slice_id AND amount = 0;

COMMIT;

-- Step 5: Post-commit validation (app layer)
-- Result must equal funds.total_amount; alert user if not.
SELECT SUM(s.amount) AS dimension_total
FROM   allocation_slices s
JOIN   slice_dimensions  sd ON sd.slice_id = s.id
JOIN   dimension_values  dv ON dv.id = sd.dimension_value_id
WHERE  s.fund_id = :fund_id
  AND  dv.dimension_id = :balancing_dimension_id;
