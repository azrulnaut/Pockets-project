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
  stmts,
} = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FUND_ID = 1;
const DIM_ACCOUNTS = 1;
const DIM_PURPOSE = 2;

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
  const slices = getSlicesForDimensionValue(dvId, DIM_PURPOSE, FUND_ID);
  res.json(slices);
});

// ---------------------------------------------------------------------------
// GET /api/purposes/:id/slices
// ---------------------------------------------------------------------------
app.get('/api/purposes/:id/slices', (req, res) => {
  const dvId = parseInt(req.params.id);
  const slices = getSlicesForDimensionValue(dvId, DIM_ACCOUNTS, FUND_ID);
  res.json(slices);
});

// ---------------------------------------------------------------------------
// POST /api/accounts  { label }
// ---------------------------------------------------------------------------
app.post('/api/accounts', (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'label required' });
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO dimension_values (dimension_id, label) VALUES (?, ?)')
      .run(DIM_ACCOUNTS, label.trim());
    res.json({ id: lastInsertRowid, label: label.trim() });
  } catch (e) {
    res.status(409).json({ error: 'Label already exists' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/purposes  { label }
// ---------------------------------------------------------------------------
app.post('/api/purposes', (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'label required' });
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO dimension_values (dimension_id, label) VALUES (?, ?)')
      .run(DIM_PURPOSE, label.trim());
    res.json({ id: lastInsertRowid, label: label.trim() });
  } catch (e) {
    res.status(409).json({ error: 'Label already exists' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/accounts/:id  { label }
// ---------------------------------------------------------------------------
app.patch('/api/accounts/:id', (req, res) => {
  const dvId = parseInt(req.params.id);
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'label required' });
  try {
    db.prepare('UPDATE dimension_values SET label = ? WHERE id = ? AND dimension_id = ?').run(
      label.trim(),
      dvId,
      DIM_ACCOUNTS
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'Label already exists' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/purposes/:id  { label }
// ---------------------------------------------------------------------------
app.patch('/api/purposes/:id', (req, res) => {
  const dvId = parseInt(req.params.id);
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'label required' });
  try {
    db.prepare('UPDATE dimension_values SET label = ? WHERE id = ? AND dimension_id = ?').run(
      label.trim(),
      dvId,
      DIM_PURPOSE
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'Label already exists' });
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

  const currentTotal = db
    .prepare(
      `SELECT COALESCE(SUM(s.amount), 0) AS total
       FROM allocation_slices s
       JOIN slice_dimensions sd ON sd.slice_id = s.id AND sd.dimension_value_id = ?
       WHERE s.fund_id = ?`
    )
    .get(accountDvId, FUND_ID).total;

  const delta = newTotal - currentTotal;

  const purposes = getDimensionTotals(DIM_PURPOSE, FUND_ID);

  // For each purpose, compute how much is available in OTHER accounts (donatable)
  const donatableStmt = db.prepare(
    `SELECT COALESCE(SUM(s.amount), 0) AS donatable
     FROM allocation_slices s
     JOIN slice_dimensions sd1 ON sd1.slice_id = s.id AND sd1.dimension_value_id = ?
     WHERE s.fund_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM slice_dimensions sd2
         WHERE sd2.slice_id = s.id AND sd2.dimension_value_id = ?
       )`
  );

  const purposesWithDonatable = purposes.map((p) => ({
    ...p,
    donatable: donatableStmt.get(p.id, FUND_ID, accountDvId).donatable,
  }));

  res.json({ delta, currentTotal, newTotal, purposes: purposesWithDonatable });
});

// ---------------------------------------------------------------------------
// POST /api/accounts/:id/rebalance
// { transfers: [{ purposeId, portion }] }  (amounts in cents)
// ---------------------------------------------------------------------------
app.post('/api/accounts/:id/rebalance', (req, res) => {
  const accountDvId = parseInt(req.params.id);
  const { transfers } = req.body;

  if (!Array.isArray(transfers) || transfers.length === 0) {
    return res.status(400).json({ error: 'transfers array required' });
  }
  for (const t of transfers) {
    if (!Number.isInteger(t.purposeId) || !Number.isInteger(t.portion) || t.portion <= 0) {
      return res.status(400).json({ error: 'each transfer needs purposeId and positive portion' });
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

  // Validate source has enough
  const sourceTotal = db
    .prepare(
      `SELECT COALESCE(SUM(s.amount), 0) AS total
       FROM allocation_slices s
       JOIN slice_dimensions sd ON sd.slice_id = s.id AND sd.dimension_value_id = ?
       WHERE s.fund_id = ?`
    )
    .get(sourcePurposeId, FUND_ID).total;

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
