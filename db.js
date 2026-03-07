'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, 'app.db'));
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Initialize schema only if tables don't exist yet
const tableExists = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='funds'")
  .get();

if (!tableExists) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}

// Seed default fund (idempotent)
db.prepare(
  "INSERT OR IGNORE INTO funds (id, name, total_amount) VALUES (1, 'My Fund', 0)"
).run();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function syncFundTotal(fundId = 1) {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM allocation_slices WHERE fund_id = ?'
    )
    .get(fundId);
  db.prepare('UPDATE funds SET total_amount = ? WHERE id = ?').run(row.total, fundId);
  return row.total;
}

function getDimensionTotals(dimId, fundId = 1) {
  return db
    .prepare(
      `SELECT dv.id, dv.label, COALESCE(SUM(s.amount), 0) AS total
       FROM dimension_values dv
       LEFT JOIN slice_dimensions sd ON sd.dimension_value_id = dv.id
       LEFT JOIN allocation_slices s ON s.id = sd.slice_id AND s.fund_id = ?
       WHERE dv.dimension_id = ?
       GROUP BY dv.id, dv.label
       ORDER BY dv.label`
    )
    .all(fundId, dimId);
}

function getSlicesForDimensionValue(dvId, otherDimId, fundId = 1) {
  // Correlated subqueries avoid duplicate rows from the multi-tag LEFT JOIN
  return db
    .prepare(
      `SELECT s.id, s.amount,
         (SELECT dv.label FROM slice_dimensions sd2
          JOIN dimension_values dv ON dv.id = sd2.dimension_value_id
          WHERE sd2.slice_id = s.id AND dv.dimension_id = ?
          LIMIT 1) AS other_label,
         (SELECT dv.id FROM slice_dimensions sd2
          JOIN dimension_values dv ON dv.id = sd2.dimension_value_id
          WHERE sd2.slice_id = s.id AND dv.dimension_id = ?
          LIMIT 1) AS other_dv_id
       FROM allocation_slices s
       JOIN slice_dimensions sd1 ON sd1.slice_id = s.id AND sd1.dimension_value_id = ?
       WHERE s.fund_id = ?
       ORDER BY s.amount DESC`
    )
    .all(otherDimId, otherDimId, dvId, fundId);
}

// Prepared statements used inside transactions
const stmts = {
  findSliceByTwoDvs: db.prepare(
    `SELECT s.id, s.amount FROM allocation_slices s
     JOIN slice_dimensions sd1 ON sd1.slice_id = s.id AND sd1.dimension_value_id = :a
     JOIN slice_dimensions sd2 ON sd2.slice_id = s.id AND sd2.dimension_value_id = :b
     WHERE s.fund_id = :f LIMIT 1`
  ),
  findDonorSlices: db.prepare(
    `SELECT s.id, s.amount FROM allocation_slices s
     JOIN slice_dimensions sd1 ON sd1.slice_id = s.id AND sd1.dimension_value_id = :purposeId
     WHERE s.fund_id = :fundId
       AND NOT EXISTS (
         SELECT 1 FROM slice_dimensions sd2
         WHERE sd2.slice_id = s.id AND sd2.dimension_value_id = :accountDvId
       )
     ORDER BY s.amount DESC`
  ),
  findSlicesForPurpose: db.prepare(
    `SELECT s.id, s.amount FROM allocation_slices s
     JOIN slice_dimensions sd ON sd.slice_id = s.id AND sd.dimension_value_id = ?
     WHERE s.fund_id = ?
     ORDER BY s.amount DESC`
  ),
  findSlicesForAccount: db.prepare(
    `SELECT s.id, s.amount FROM allocation_slices s
     JOIN slice_dimensions sd ON sd.slice_id = s.id AND sd.dimension_value_id = ?
     WHERE s.fund_id = ?
     ORDER BY s.amount DESC`
  ),
  getAccountDvOnSlice: db.prepare(
    `SELECT sd.dimension_value_id AS dvId
     FROM slice_dimensions sd
     JOIN dimension_values dv ON dv.id = sd.dimension_value_id
     WHERE sd.slice_id = ? AND dv.dimension_id = 1
     LIMIT 1`
  ),
  getTagsExcluding: db.prepare(
    `SELECT dimension_value_id FROM slice_dimensions
     WHERE slice_id = ? AND dimension_value_id != ?`
  ),
  insertSlice: db.prepare(
    'INSERT INTO allocation_slices (fund_id, amount) VALUES (?, ?)'
  ),
  insertSliceDim: db.prepare(
    'INSERT OR IGNORE INTO slice_dimensions (slice_id, dimension_value_id) VALUES (?, ?)'
  ),
  addToSlice: db.prepare(
    'UPDATE allocation_slices SET amount = amount + ? WHERE id = ?'
  ),
  deleteSlice: db.prepare('DELETE FROM allocation_slices WHERE id = ?'),
};

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

const executeAccountRebalance = db.transaction((accountDvId, transfers, fundId = 1) => {
  for (const { purposeId, portion } of transfers) {
    // Shrink donor slices (same purpose, different account)
    let remaining = portion;
    const donors = stmts.findDonorSlices.all({
      purposeId,
      fundId,
      accountDvId,
    });
    for (const donor of donors) {
      if (remaining <= 0) break;
      const take = Math.min(donor.amount, remaining);
      if (take === donor.amount) {
        stmts.deleteSlice.run(donor.id);
      } else {
        stmts.addToSlice.run(-take, donor.id);
      }
      remaining -= take;
    }
    // remaining > 0 → new money; fund total will grow after syncFundTotal

    // Grow or create target slice (accountDvId + purposeId)
    const target = stmts.findSliceByTwoDvs.get({ a: accountDvId, b: purposeId, f: fundId });
    if (target) {
      stmts.addToSlice.run(portion, target.id);
    } else {
      const { lastInsertRowid } = stmts.insertSlice.run(fundId, portion);
      stmts.insertSliceDim.run(lastInsertRowid, accountDvId);
      stmts.insertSliceDim.run(lastInsertRowid, purposeId);
    }
  }
  return syncFundTotal(fundId);
});

const executePurposeTransfer = db.transaction(
  (sourcePurposeId, targetPurposeId, amount, fundId = 1) => {
    let remaining = amount;
    const sources = stmts.findSlicesForPurpose.all(sourcePurposeId, fundId);

    for (const source of sources) {
      if (remaining <= 0) break;
      const take = Math.min(source.amount, remaining);

      const accountRow = stmts.getAccountDvOnSlice.get(source.id);
      if (accountRow) {
        const target = stmts.findSliceByTwoDvs.get({
          a: accountRow.dvId,
          b: targetPurposeId,
          f: fundId,
        });
        if (target) {
          stmts.addToSlice.run(take, target.id);
        } else {
          // Option B: inherit all tags from source except sourcePurposeId, add targetPurposeId
          const otherTags = stmts.getTagsExcluding.all(source.id, sourcePurposeId);
          const { lastInsertRowid } = stmts.insertSlice.run(fundId, take);
          for (const tag of otherTags) {
            stmts.insertSliceDim.run(lastInsertRowid, tag.dimension_value_id);
          }
          stmts.insertSliceDim.run(lastInsertRowid, targetPurposeId);
        }
      }

      if (take === source.amount) {
        stmts.deleteSlice.run(source.id);
      } else {
        stmts.addToSlice.run(-take, source.id);
      }
      remaining -= take;
    }
    // Fund total unchanged for purpose transfer
  }
);

module.exports = {
  db,
  syncFundTotal,
  getDimensionTotals,
  getSlicesForDimensionValue,
  executeAccountRebalance,
  executePurposeTransfer,
  stmts,
};
