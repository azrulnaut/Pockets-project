'use strict';

const express = require('express');
const path = require('path');
const {
  db,
  syncFundTotal,
  getDimensionTotals,
  getSlicesForDimensionValue,
  executeAccountRebalance,
  executePurposeTransfer,
} = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FUND_ID = 1;
const DIM_ACCOUNTS = 1;
const DIM_PURPOSE = 2;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function getAccountTotal(accountDvId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(s.amount), 0) AS total
       FROM allocation_slices s
       JOIN slice_dimensions sd ON sd.slice_id = s.id AND sd.dimension_value_id = ?
       WHERE s.fund_id = ?`
    )
    .get(accountDvId, FUND_ID).total;
}

function getPurposeTotal(purposeDvId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(s.amount), 0) AS total
       FROM allocation_slices s
       JOIN slice_dimensions sd ON sd.slice_id = s.id AND sd.dimension_value_id = ?
       WHERE s.fund_id = ?`
    )
    .get(purposeDvId, FUND_ID).total;
}

// ---------------------------------------------------------------------------
// GET /api/state
// ---------------------------------------------------------------------------
app.get('/api/state', (req, res) => {
  const fund = db.prepare('SELECT id, name, total_amount FROM funds WHERE id = ?').get(FUND_ID);
  const accounts = getDimensionTotals(DIM_ACCOUNTS, FUND_ID);
  const purposes = getDimensionTotals(DIM_PURPOSE, FUND_ID);
  res.json({ fund, accounts, purposes });
});

// ---------------------------------------------------------------------------
// GET /api/accounts/:id/slices
// ---------------------------------------------------------------------------
app.get('/api/accounts/:id/slices', (req, res) => {
  const dvId = parseInt(req.params.id);
  res.json(getSlicesForDimensionValue(dvId, DIM_PURPOSE, FUND_ID));
});

// ---------------------------------------------------------------------------
// GET /api/purposes/:id/slices
// ---------------------------------------------------------------------------
app.get('/api/purposes/:id/slices', (req, res) => {
  const dvId = parseInt(req.params.id);
  res.json(getSlicesForDimensionValue(dvId, DIM_ACCOUNTS, FUND_ID));
});

// ---------------------------------------------------------------------------
// POST /api/accounts  { label }
// ---------------------------------------------------------------------------
app.post('/api/accounts', (req, res) => {
  const { label } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'label required' });
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO dimension_values (dimension_id, label) VALUES (?, ?)')
      .run(DIM_ACCOUNTS, label.trim());
    res.json({ id: lastInsertRowid, label: label.trim() });
  } catch {
    res.status(409).json({ error: 'Label already exists' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/purposes  { label }
// ---------------------------------------------------------------------------
app.post('/api/purposes', (req, res) => {
  const { label } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'label required' });
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO dimension_values (dimension_id, label) VALUES (?, ?)')
      .run(DIM_PURPOSE, label.trim());
    res.json({ id: lastInsertRowid, label: label.trim() });
  } catch {
    res.status(409).json({ error: 'Label already exists' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/accounts/:id  { label }
// ---------------------------------------------------------------------------
app.patch('/api/accounts/:id', (req, res) => {
  const dvId = parseInt(req.params.id);
  const { label } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'label required' });
  try {
    db.prepare('UPDATE dimension_values SET label = ? WHERE id = ? AND dimension_id = ?').run(
      label.trim(), dvId, DIM_ACCOUNTS
    );
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Label already exists' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/purposes/:id  { label }
// ---------------------------------------------------------------------------
app.patch('/api/purposes/:id', (req, res) => {
  const dvId = parseInt(req.params.id);
  const { label } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'label required' });
  try {
    db.prepare('UPDATE dimension_values SET label = ? WHERE id = ? AND dimension_id = ?').run(
      label.trim(), dvId, DIM_PURPOSE
    );
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Label already exists' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/accounts/:id  — deletes all slices tagged with this account first
// ---------------------------------------------------------------------------
app.delete('/api/accounts/:id', (req, res) => {
  const dvId = parseInt(req.params.id);
  try {
    db.transaction(() => {
      db.prepare(
        'DELETE FROM allocation_slices WHERE id IN (SELECT slice_id FROM slice_dimensions WHERE dimension_value_id = ?)'
      ).run(dvId);
      db.prepare('DELETE FROM dimension_values WHERE id = ? AND dimension_id = ?').run(dvId, DIM_ACCOUNTS);
      syncFundTotal(FUND_ID);
    })();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/purposes/:id  — deletes all slices tagged with this purpose first
// ---------------------------------------------------------------------------
app.delete('/api/purposes/:id', (req, res) => {
  const dvId = parseInt(req.params.id);
  try {
    db.transaction(() => {
      db.prepare(
        'DELETE FROM allocation_slices WHERE id IN (SELECT slice_id FROM slice_dimensions WHERE dimension_value_id = ?)'
      ).run(dvId);
      db.prepare('DELETE FROM dimension_values WHERE id = ? AND dimension_id = ?').run(dvId, DIM_PURPOSE);
      syncFundTotal(FUND_ID);
    })();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/accounts/:id/rebalance-candidates?newTotal=N
// ---------------------------------------------------------------------------
app.get('/api/accounts/:id/rebalance-candidates', (req, res) => {
  const accountDvId = parseInt(req.params.id);
  const newTotal = parseInt(req.query.newTotal);

  if (isNaN(newTotal) || newTotal < 0) {
    return res.status(400).json({ error: 'newTotal must be a non-negative integer (cents)' });
  }

  const currentTotal = getAccountTotal(accountDvId);
  const delta = newTotal - currentTotal;

  // For each purpose, get overall total AND amount specifically within this account
  const currentInAccountStmt = db.prepare(
    `SELECT COALESCE(SUM(s.amount), 0) AS total
     FROM allocation_slices s
     JOIN slice_dimensions sd1 ON sd1.slice_id = s.id AND sd1.dimension_value_id = ?
     JOIN slice_dimensions sd2 ON sd2.slice_id = s.id AND sd2.dimension_value_id = ?
     WHERE s.fund_id = ?`
  );

  const allPurposes = getDimensionTotals(DIM_PURPOSE, FUND_ID).map((p) => ({
    ...p,
    currentInAccount: currentInAccountStmt.get(accountDvId, p.id, FUND_ID).total,
  }));

  // For negative delta: only show purposes this account actually has money in
  res.json({ delta, currentTotal, newTotal, purposes: allPurposes });
});

// ---------------------------------------------------------------------------
// POST /api/accounts/:id/rebalance
// { newTotal: N, transfers: [{ purposeId, portion }] }  (all amounts in cents)
// ---------------------------------------------------------------------------
app.post('/api/accounts/:id/rebalance', (req, res) => {
  const accountDvId = parseInt(req.params.id);
  const { newTotal } = req.body;
  const transfers = Array.isArray(req.body.transfers) ? req.body.transfers : [];

  if (!Number.isInteger(newTotal) || newTotal < 0) {
    return res.status(400).json({ error: 'newTotal must be a non-negative integer (cents)' });
  }

  for (const t of transfers) {
    if (!Number.isInteger(t.purposeId) || !Number.isInteger(t.portion) || t.portion === 0) {
      return res.status(400).json({ error: 'each transfer needs purposeId and non-zero integer portion' });
    }
  }

  const currentTotal = getAccountTotal(accountDvId);
  const delta = newTotal - currentTotal;

  // Net signed sum of all portions must equal delta
  const portionSum = transfers.reduce((s, t) => s + t.portion, 0);
  if (portionSum !== delta) {
    return res.status(400).json({
      error: `Portions net sum (${portionSum}) must equal delta (${delta})`,
    });
  }

  // Validate reductions don't exceed what the account holds for each purpose
  const currentInAccountStmt = db.prepare(
    `SELECT COALESCE(SUM(s.amount), 0) AS total
     FROM allocation_slices s
     JOIN slice_dimensions sd1 ON sd1.slice_id = s.id AND sd1.dimension_value_id = ?
     JOIN slice_dimensions sd2 ON sd2.slice_id = s.id AND sd2.dimension_value_id = ?
     WHERE s.fund_id = ?`
  );
  for (const t of transfers.filter(t => t.portion < 0)) {
    const avail = currentInAccountStmt.get(accountDvId, t.purposeId, FUND_ID).total;
    if (-t.portion > avail) {
      return res.status(400).json({
        error: `Reduction of ${-t.portion} exceeds available ${avail} for purposeId ${t.purposeId}`,
      });
    }
  }

  try {
    const newFundTotal = executeAccountRebalance(accountDvId, transfers, FUND_ID);
    res.json({ ok: true, fundTotal: newFundTotal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/purposes/:id/transfer
// { targetPurposeId, amount }  (amount in cents)
// ---------------------------------------------------------------------------
app.post('/api/purposes/:id/transfer', (req, res) => {
  const sourcePurposeId = parseInt(req.params.id);
  const { targetPurposeId, amount } = req.body;

  if (!Number.isInteger(targetPurposeId) || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'targetPurposeId and positive amount required' });
  }
  if (sourcePurposeId === targetPurposeId) {
    return res.status(400).json({ error: 'source and target must differ' });
  }

  const sourceTotal = getPurposeTotal(sourcePurposeId);
  if (amount > sourceTotal) {
    return res.status(400).json({ error: `Insufficient balance: ${sourceTotal} cents available` });
  }

  try {
    executePurposeTransfer(sourcePurposeId, targetPurposeId, amount, FUND_ID);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
