'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = null;
const expandedAccounts = new Set();
const expandedPurposes = new Set();
const sliceCache = {};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function fmt(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseDollars(str) {
  const v = parseFloat(str);
  if (isNaN(v) || v < 0) return null;
  return Math.round(v * 100);
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), 3500);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------------------------------------------------------------------------
// Load state & render
// ---------------------------------------------------------------------------
async function loadState() {
  try {
    state = await api('GET', '/api/state');
    render();
  } catch (e) {
    showToast('Failed to load state: ' + e.message);
  }
}

function render() {
  if (!state) return;
  document.getElementById('fund-name').textContent = state.fund.name;
  document.getElementById('fund-total').textContent = fmt(state.fund.total_amount);
  renderDimension('accounts-list', state.accounts, 'a', expandedAccounts, renderAccountRow);
  renderDimension('purposes-list', state.purposes, 'p', expandedPurposes, renderPurposeRow);
}

function renderDimension(containerId, items, prefix, expandedSet, rowFn) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'slice-row empty';
    empty.textContent = 'None yet — click + Add to create one.';
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const key = `${prefix}-${item.id}`;

    const row = document.createElement('div');
    row.className = 'dv-row';
    row.onclick = () => toggleExpand(key, prefix, item.id);
    row.innerHTML = `
      <span class="toggle">${expandedSet.has(key) ? '▼' : '▶'}</span>
      <span class="label">${esc(item.label)}</span>
      <span class="amount">${fmt(item.total)}</span>
      <span class="actions" onclick="event.stopPropagation()">${rowFn(item)}</span>
    `;
    container.appendChild(row);

    if (expandedSet.has(key)) {
      const slices = sliceCache[key];
      const sliceContainer = document.createElement('div');
      sliceContainer.className = 'slices-container';

      if (!slices) {
        sliceContainer.innerHTML = '<div class="slice-row empty">Loading…</div>';
      } else if (slices.length === 0) {
        sliceContainer.innerHTML = '<div class="slice-row empty">No slices.</div>';
      } else {
        for (const s of slices) {
          const sr = document.createElement('div');
          sr.className = 'slice-row';
          sr.innerHTML = `
            <span class="slice-label">${esc(s.other_label || '(untagged)')}</span>
            <span class="slice-amount">${fmt(s.amount)}</span>
          `;
          sliceContainer.appendChild(sr);
        }
      }
      container.appendChild(sliceContainer);
    }
  }
}

function renderAccountRow(item) {
  return `
    <button class="btn-edit" onclick="openEditModal('account',${item.id},'${esc(item.label)}')">Edit</button>
    <button class="btn-action" onclick="openRebalanceModal(${item.id},'${esc(item.label)}',${item.total})">Rebal.</button>
  `;
}

function renderPurposeRow(item) {
  return `
    <button class="btn-edit" onclick="openEditModal('purpose',${item.id},'${esc(item.label)}')">Edit</button>
  `;
}

// ---------------------------------------------------------------------------
// Expand / collapse
// ---------------------------------------------------------------------------
async function toggleExpand(key, prefix, dvId) {
  const expandedSet = prefix === 'a' ? expandedAccounts : expandedPurposes;
  if (expandedSet.has(key)) {
    expandedSet.delete(key);
    delete sliceCache[key];
    render();
    return;
  }
  expandedSet.add(key);
  render();
  try {
    const apiPath = prefix === 'a' ? `/api/accounts/${dvId}/slices` : `/api/purposes/${dvId}/slices`;
    sliceCache[key] = await api('GET', apiPath);
  } catch (e) {
    sliceCache[key] = [];
    showToast('Failed to load slices: ' + e.message);
  }
  render();
}

// ---------------------------------------------------------------------------
// XSS helper
// ---------------------------------------------------------------------------
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------
function openModal(title, bodyHTML, actionsHTML) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  document.getElementById('modal-actions').innerHTML = actionsHTML;
  document.getElementById('modal-overlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

// ---------------------------------------------------------------------------
// Add modal
// ---------------------------------------------------------------------------
function openAddModal(type) {
  const label = type === 'account' ? 'Account' : 'Purpose';
  openModal(
    `Add ${label}`,
    `<div class="form-row">
       <label>Name</label>
       <input id="add-label" type="text" placeholder="${label} name">
     </div>`,
    `<button class="btn-cancel" onclick="closeModal()">Cancel</button>
     <button class="btn-primary" onclick="submitAdd('${type}')">Add</button>`
  );
  setTimeout(() => document.getElementById('add-label')?.focus(), 50);
}

async function submitAdd(type) {
  const label = document.getElementById('add-label').value.trim();
  if (!label) return showToast('Name is required');
  try {
    await api('POST', type === 'account' ? '/api/accounts' : '/api/purposes', { label });
    closeModal();
    await loadState();
  } catch (e) {
    showToast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Edit modal (rename + delete)
// ---------------------------------------------------------------------------
function openEditModal(type, id, currentLabel) {
  const label = type === 'account' ? 'Account' : 'Purpose';
  openModal(
    `Edit ${label}: ${currentLabel}`,
    `<div class="form-row">
       <label>Name</label>
       <input id="edit-label" type="text" value="${esc(currentLabel)}">
     </div>`,
    `<div class="modal-actions-split">
       <button class="btn-danger" onclick="confirmDelete('${type}',${id},'${esc(currentLabel)}')">Delete ${label}</button>
       <div style="display:flex;gap:10px">
         <button class="btn-cancel" onclick="closeModal()">Cancel</button>
         <button class="btn-primary" onclick="submitEdit('${type}',${id})">Save</button>
       </div>
     </div>`
  );
  setTimeout(() => { const inp = document.getElementById('edit-label'); if (inp) { inp.focus(); inp.select(); } }, 50);
}

async function submitEdit(type, id) {
  const label = document.getElementById('edit-label').value.trim();
  if (!label) return showToast('Name is required');
  try {
    await api('PATCH', type === 'account' ? `/api/accounts/${id}` : `/api/purposes/${id}`, { label });
    Object.keys(sliceCache).forEach(k => delete sliceCache[k]);
    closeModal();
    await loadState();
  } catch (e) {
    showToast(e.message);
  }
}

async function confirmDelete(type, id, label) {
  if (!confirm(`Delete "${label}"?\n\nThis will permanently delete all its slices.`)) return;
  try {
    await api('DELETE', type === 'account' ? `/api/accounts/${id}` : `/api/purposes/${id}`);
    const key = (type === 'account' ? 'a' : 'p') + '-' + id;
    expandedAccounts.delete(key); expandedPurposes.delete(key);
    Object.keys(sliceCache).forEach(k => delete sliceCache[k]);
    closeModal();
    await loadState();
  } catch (e) {
    showToast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Rebalance modal
// ---------------------------------------------------------------------------
let rebalState = null;

function openRebalanceModal(accountId, accountLabel, currentTotal) {
  rebalState = { accountId, accountLabel, currentTotal, candidates: null };

  openModal(
    `Rebalance: ${accountLabel}`,
    `<div class="info-box">Current total: <strong>${fmt(currentTotal)}</strong></div>
     <div class="form-row">
       <label>New total ($)</label>
       <input id="rebal-new-total" type="number" min="0" step="0.01"
              value="${(currentTotal / 100).toFixed(2)}">
     </div>
     <div id="rebal-candidates"><div class="info-box">Loading…</div></div>`,
    `<button class="btn-cancel" onclick="closeModal()">Cancel</button>
     <button class="btn-primary" id="rebal-confirm" onclick="submitRebalance()" disabled>Confirm</button>`
  );

  setTimeout(async () => {
    const inp = document.getElementById('rebal-new-total');
    if (!inp) return;
    inp.focus(); inp.select();
    // Sync delta on every keystroke (no fetch needed — just recompute delta locally)
    inp.addEventListener('input', onRebalTotalInput);
    // Fetch purposes once
    await fetchAndRenderCandidates(currentTotal);
  }, 50);
}

// Called when new-total input changes: updates delta in state, refreshes remainder
function onRebalTotalInput() {
  const cents = parseDollars(document.getElementById('rebal-new-total')?.value);
  if (cents === null || !rebalState.candidates) return;
  rebalState.candidates.delta    = cents - rebalState.currentTotal;
  rebalState.candidates.newTotal = cents;
  updateRebalRemainder();
}

// Fetch all purposes (with currentInAccount) for this account; render the grid
async function fetchAndRenderCandidates(newTotal) {
  try {
    const data = await api(
      'GET',
      `/api/accounts/${rebalState.accountId}/rebalance-candidates?newTotal=${newTotal}`
    );
    rebalState.candidates = data;
    renderCandidates(data);
  } catch (e) {
    const el = document.getElementById('rebal-candidates');
    if (el) el.innerHTML = `<div class="info-box">Error: ${esc(e.message)}</div>`;
  }
}

// Render the +/− purpose grid and remainder row
function renderCandidates(data) {
  const { delta, purposes } = data;
  const cand = document.getElementById('rebal-candidates');
  if (!cand) return;

  if (!purposes || purposes.length === 0) {
    cand.innerHTML = '<div class="info-box">No purposes defined yet — add some first.</div>';
    const btn = document.getElementById('rebal-confirm');
    if (btn) btn.disabled = true;
    return;
  }

  let html = '<div class="purpose-grid">';
  for (const p of purposes) {
    html += `
      <div class="purpose-grid-row row-plus" id="pgr-${p.id}" data-mode="+">
        <span class="pg-label">${esc(p.label)}</span>
        <span class="pg-current">${fmt(p.currentInAccount)}</span>
        <div class="mode-btns">
          <button class="mode-btn mode-plus active" onclick="setRowMode(${p.id},'+')">+</button>
          <button class="mode-btn mode-minus"       onclick="setRowMode(${p.id},'-')">−</button>
        </div>
        <input type="number" min="0" step="0.01" value="" placeholder="0.00"
               data-purpose-id="${p.id}"
               data-max-decrease="${(p.currentInAccount / 100).toFixed(2)}"
               oninput="updateRebalRemainder()">
      </div>`;
  }
  html += '</div>';

  const absDelta = Math.abs(delta);
  const sign = delta < 0 ? '−' : delta > 0 ? '+' : '';
  html += `<div class="remainder-row ${delta === 0 ? 'zero' : 'nonzero'}" id="rebal-remainder-row">
    <span class="rem-label">Remaining to commit</span>
    <span class="rem-value" id="rebal-remainder">${sign}${fmt(absDelta)}</span>
  </div>`;

  cand.innerHTML = html;
  updateRebalRemainder();
}

// Toggle +/− mode on a purpose row
function setRowMode(purposeId, mode) {
  const row = document.getElementById(`pgr-${purposeId}`);
  if (!row) return;
  const current = row.dataset.mode;
  const next = current === mode ? '' : mode;
  row.dataset.mode = next;
  row.classList.toggle('row-plus',  next === '+');
  row.classList.toggle('row-minus', next === '-');
  row.querySelector('.mode-plus').classList.toggle('active',  next === '+');
  row.querySelector('.mode-minus').classList.toggle('active', next === '-');
  updateRebalRemainder();
}

// Returns the signed cent change for one purpose row
function getSignedChange(row) {
  const mode = row.dataset.mode;
  if (!mode) return 0;
  const amount = Math.round(parseFloat(row.querySelector('input').value || 0) * 100);
  if (amount <= 0) return 0;
  return mode === '+' ? amount : -amount;
}

// Recompute and display remainder; enable Confirm when remainder === 0
function updateRebalRemainder() {
  const rows = document.querySelectorAll('.purpose-grid-row[id^="pgr-"]');
  let netChange = 0;
  for (const row of rows) netChange += getSignedChange(row);

  const delta     = rebalState.candidates?.delta ?? 0;
  const remainder = delta - netChange;

  const remEl = document.getElementById('rebal-remainder');
  const rowEl = document.getElementById('rebal-remainder-row');
  if (remEl) {
    const sign = remainder < 0 ? '−' : remainder > 0 ? '+' : '';
    remEl.textContent = sign + fmt(Math.abs(remainder));
  }
  if (rowEl) rowEl.className = 'remainder-row ' + (remainder === 0 ? 'zero' : 'nonzero');
  const btn = document.getElementById('rebal-confirm');
  if (btn) btn.disabled = remainder !== 0;
}

// Collect signed transfers and submit
async function submitRebalance() {
  const rows = document.querySelectorAll('.purpose-grid-row[id^="pgr-"]');
  const transfers = [];
  for (const row of rows) {
    const signed = getSignedChange(row);
    if (signed !== 0) {
      transfers.push({ purposeId: parseInt(row.querySelector('input').dataset.purposeId), portion: signed });
    }
  }

  const newTotal = rebalState.candidates?.newTotal;
  if (newTotal == null) return showToast('Invalid state — please reopen the modal');

  try {
    await api('POST', `/api/accounts/${rebalState.accountId}/rebalance`, { newTotal, transfers });
    Object.keys(sliceCache).forEach(k => delete sliceCache[k]);
    closeModal();
    await loadState();
  } catch (e) {
    showToast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Deposit / Spend modal
// ---------------------------------------------------------------------------
function openDepositSpendModal(mode) {
  const accounts = state?.accounts || [];
  if (accounts.length === 0) return showToast('Add an account first');

  const isDeposit = mode === 'deposit';
  const eligible  = isDeposit ? accounts : accounts.filter(a => a.total > 0);
  if (eligible.length === 0) return showToast('No accounts with balance to spend from');

  const accountOptions = eligible
    .map(a => `<option value="${a.id}" data-total="${a.total}">${esc(a.label)} (${fmt(a.total)})</option>`)
    .join('');

  openModal(
    isDeposit ? 'Deposit' : 'Spend',
    `<div class="form-row">
       <label>Amount ($)</label>
       <input id="ds-amount" type="number" min="0.01" step="0.01" placeholder="0.00">
     </div>
     <div class="form-row">
       <label>${isDeposit ? 'To account' : 'From account'}</label>
       <select id="ds-account">${accountOptions}</select>
     </div>`,
    `<button class="btn-cancel" onclick="closeModal()">Cancel</button>
     <button class="btn-primary" onclick="loadDepositSpendCandidates('${mode}')">Continue →</button>`
  );
  setTimeout(() => document.getElementById('ds-amount')?.focus(), 50);
}

async function loadDepositSpendCandidates(mode) {
  const amountCents = parseDollars(document.getElementById('ds-amount')?.value);
  if (!amountCents || amountCents <= 0) return showToast('Enter a valid amount');

  const select       = document.getElementById('ds-account');
  const accountId    = parseInt(select.value);
  const currentTotal = parseInt(select.options[select.selectedIndex].dataset.total);
  const accountLabel = select.options[select.selectedIndex].text.replace(/ \(.*\)$/, '');

  const isDeposit = mode === 'deposit';
  if (!isDeposit && amountCents > currentTotal) {
    return showToast(`Cannot spend more than ${fmt(currentTotal)}`);
  }

  const newTotal = isDeposit ? currentTotal + amountCents : currentTotal - amountCents;
  rebalState = { accountId, accountLabel, currentTotal, candidates: null };

  document.getElementById('modal-title').textContent =
    isDeposit ? `Deposit → ${accountLabel}` : `Spend ← ${accountLabel}`;
  document.getElementById('modal-body').innerHTML =
    `<div class="info-box">
       ${isDeposit ? 'Depositing' : 'Spending'}: <strong>${fmt(amountCents)}</strong>
       &nbsp;·&nbsp; New total: ${fmt(newTotal)}
     </div>
     <div id="rebal-candidates"><div class="info-box">Loading…</div></div>`;
  document.getElementById('modal-actions').innerHTML =
    `<button class="btn-cancel" onclick="closeModal()">Cancel</button>
     <button class="btn-primary" id="rebal-confirm" onclick="submitRebalance()" disabled>Confirm</button>`;

  try {
    const data = await api('GET', `/api/accounts/${accountId}/rebalance-candidates?newTotal=${newTotal}`);
    rebalState.candidates = data;
    renderCandidates(data);
  } catch (e) {
    showToast(e.message);
    closeModal();
  }
}

// ---------------------------------------------------------------------------
// Account Transfer modal
// ---------------------------------------------------------------------------
function openTransferAccountModal() {
  const accounts = state?.accounts || [];
  if (accounts.length < 2) return showToast('Need at least 2 accounts to transfer between');

  const opts = accounts
    .map(a => `<option value="${a.id}" data-total="${a.total}">${esc(a.label)} (${fmt(a.total)})</option>`)
    .join('');

  openModal(
    'Transfer Between Accounts',
    `<div class="form-row">
       <label>From account</label>
       <select id="ta-source">${opts}</select>
     </div>
     <div class="form-row">
       <label>To account</label>
       <select id="ta-target">${opts}</select>
     </div>`,
    `<button class="btn-cancel" onclick="closeModal()">Cancel</button>
     <button class="btn-primary" onclick="loadTransferCandidates()">Continue →</button>`
  );
  // Default target to second account so source ≠ target on open
  setTimeout(() => {
    const t = document.getElementById('ta-target');
    if (t && t.options.length > 1) t.selectedIndex = 1;
  }, 50);
}

async function loadTransferCandidates() {
  const srcSel = document.getElementById('ta-source');
  const tgtSel = document.getElementById('ta-target');
  const sourceId    = parseInt(srcSel.value);
  const targetId    = parseInt(tgtSel.value);
  const sourceTotal = parseInt(srcSel.options[srcSel.selectedIndex].dataset.total);
  const sourceLabel = srcSel.options[srcSel.selectedIndex].text.replace(/ \(.*\)$/, '');
  const targetLabel = tgtSel.options[tgtSel.selectedIndex].text.replace(/ \(.*\)$/, '');

  if (sourceId === targetId) return showToast('Source and target must be different accounts');
  if (sourceTotal <= 0) return showToast(`${sourceLabel} has no balance to transfer`);

  document.getElementById('modal-title').textContent = `Transfer: ${sourceLabel} → ${targetLabel}`;
  document.getElementById('modal-body').innerHTML = `
    <div class="info-box">
      From <strong>${esc(sourceLabel)}</strong> (${fmt(sourceTotal)})
      &nbsp;→&nbsp; <strong>${esc(targetLabel)}</strong>
    </div>
    <div id="acct-transfer-candidates"><div class="info-box">Loading…</div></div>`;
  document.getElementById('modal-actions').innerHTML = `
    <button class="btn-cancel" onclick="closeModal()">Cancel</button>
    <button class="btn-primary" id="acct-transfer-confirm"
            onclick="submitAccountTransfer(${sourceId},${targetId})" disabled>Confirm</button>`;

  try {
    // Reuse rebalance-candidates endpoint — we only need currentInAccount per purpose
    const data = await api('GET', `/api/accounts/${sourceId}/rebalance-candidates?newTotal=${sourceTotal}`);
    const eligible = data.purposes.filter(p => p.currentInAccount > 0);
    renderTransferCandidates(eligible);
  } catch (e) {
    showToast(e.message);
    closeModal();
  }
}

function renderTransferCandidates(purposes) {
  const cand = document.getElementById('acct-transfer-candidates');
  if (!cand) return;

  if (purposes.length === 0) {
    cand.innerHTML = '<div class="info-box">No allocated purposes in this account to transfer.</div>';
    return;
  }

  let html = '<div class="purpose-grid">';
  for (const p of purposes) {
    html += `
      <div class="purpose-grid-row row-plus" id="tpgr-${p.id}">
        <span class="pg-label">${esc(p.label)}</span>
        <span class="pg-current">${fmt(p.currentInAccount)}</span>
        <input type="number" min="0" step="0.01" max="${(p.currentInAccount / 100).toFixed(2)}"
               value="" placeholder="0.00"
               data-purpose-id="${p.id}"
               oninput="updateTransferTotal()">
      </div>`;
  }
  html += '</div>';
  html += `<div class="remainder-row nonzero" id="acct-transfer-total-row">
    <span class="rem-label">Total to transfer</span>
    <span class="rem-value" id="acct-transfer-total">$0.00</span>
  </div>`;

  cand.innerHTML = html;
}

function updateTransferTotal() {
  const inputs = document.querySelectorAll('[id^="tpgr-"] input[type="number"]');
  let total = 0;
  for (const inp of inputs) total += Math.round(parseFloat(inp.value || 0) * 100);

  const el  = document.getElementById('acct-transfer-total');
  const row = document.getElementById('acct-transfer-total-row');
  const btn = document.getElementById('acct-transfer-confirm');
  if (el)  el.textContent = fmt(total);
  if (row) row.className = 'remainder-row ' + (total > 0 ? 'zero' : 'nonzero');
  if (btn) btn.disabled = total <= 0;
}

async function submitAccountTransfer(sourceId, targetId) {
  const inputs = document.querySelectorAll('[id^="tpgr-"] input[type="number"]');
  const transfers = [];
  for (const inp of inputs) {
    const portion = Math.round(parseFloat(inp.value || 0) * 100);
    if (portion > 0) transfers.push({ purposeId: parseInt(inp.dataset.purposeId), portion });
  }
  if (transfers.length === 0) return showToast('Enter at least one amount to transfer');

  try {
    await api('POST', `/api/accounts/${sourceId}/transfer`, { targetAccountId: targetId, transfers });
    Object.keys(sliceCache).forEach(k => delete sliceCache[k]);
    closeModal();
    await loadState();
  } catch (e) {
    showToast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
loadState();
