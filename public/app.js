'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = null;
const expandedAccounts = new Set();
const expandedPurposes = new Set();
const sliceCache = {};  // key: "a-<id>" or "p-<id>" → slice array

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

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
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
    [state] = await Promise.all([
      api('GET', '/api/state'),
    ]);
    render();
    renderHistory();
  } catch (e) {
    showToast('Failed to load state: ' + e.message);
  }
}

async function renderHistory() {
  try {
    const history = await api('GET', '/api/history');
    const list = document.getElementById('history-list');
    if (!history.length) {
      list.innerHTML = '<div class="history-empty">No rebalances yet.</div>';
      return;
    }
    list.innerHTML = history.map(h => {
      if (h.type === 'account_rebalance') {
        const sign = h.delta > 0 ? '+' : '';
        const details = h.transfers
          .map(t => `${t.purposeLabel}: ${h.delta > 0 ? '+' : '−'}${fmt(t.portion)}`)
          .join(' &nbsp;·&nbsp; ');
        return `<div class="history-row rebalance">
          <div class="h-time">${fmtTime(h.timestamp)}</div>
          <div class="h-main">Account Rebalance — ${esc(h.accountLabel)} &nbsp; ${fmt(h.oldTotal)} → ${fmt(h.newTotal)} &nbsp;(${sign}${fmt(h.delta)})</div>
          <div class="h-detail">${details}</div>
        </div>`;
      } else {
        return `<div class="history-row transfer">
          <div class="h-time">${fmtTime(h.timestamp)}</div>
          <div class="h-main">Purpose Transfer — ${esc(h.fromLabel)} → ${esc(h.toLabel)} &nbsp; ${fmt(h.amount)}</div>
        </div>`;
      }
    }).join('');
  } catch (e) {
    // silently ignore history errors
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
    row.dataset.key = key;
    row.onclick = () => toggleExpand(key, prefix, item.id);
    row.innerHTML = `
      <span class="toggle">${expandedSet.has(key) ? '▼' : '▶'}</span>
      <span class="label">${esc(item.label)}</span>
      <span class="amount">${fmt(item.total)}</span>
      <span class="actions" onclick="event.stopPropagation()">
        ${rowFn(item)}
      </span>
    `;
    container.appendChild(row);

    if (expandedSet.has(key)) {
      const slices = sliceCache[key];
      const sliceContainer = document.createElement('div');
      sliceContainer.className = 'slices-container';
      sliceContainer.id = `slices-${key}`;

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
    <button class="btn-edit" onclick="openEditModal('account', ${item.id}, '${esc(item.label)}')">Edit</button>
    <button class="btn-action" onclick="openRebalanceModal(${item.id}, '${esc(item.label)}', ${item.total})">Rebal.</button>
  `;
}

function renderPurposeRow(item) {
  return `
    <button class="btn-edit" onclick="openEditModal('purpose', ${item.id}, '${esc(item.label)}')">Edit</button>
    <button class="btn-action" onclick="openTransferModal(${item.id}, '${esc(item.label)}', ${item.total})">Transfer</button>
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
    const apiPath = prefix === 'a'
      ? `/api/accounts/${dvId}/slices`
      : `/api/purposes/${dvId}/slices`;
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const path = type === 'account' ? '/api/accounts' : '/api/purposes';
  try {
    await api('POST', path, { label });
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
       <button class="btn-danger" onclick="confirmDelete('${type}', ${id}, '${esc(currentLabel)}')">Delete ${label}</button>
       <div style="display:flex;gap:10px">
         <button class="btn-cancel" onclick="closeModal()">Cancel</button>
         <button class="btn-primary" onclick="submitEdit('${type}', ${id})">Save</button>
       </div>
     </div>`
  );
  setTimeout(() => {
    const inp = document.getElementById('edit-label');
    if (inp) { inp.focus(); inp.select(); }
  }, 50);
}

async function submitEdit(type, id) {
  const label = document.getElementById('edit-label').value.trim();
  if (!label) return showToast('Name is required');
  const path = type === 'account' ? `/api/accounts/${id}` : `/api/purposes/${id}`;
  try {
    await api('PATCH', path, { label });
    Object.keys(sliceCache).forEach(k => delete sliceCache[k]);
    closeModal();
    await loadState();
  } catch (e) {
    showToast(e.message);
  }
}

async function confirmDelete(type, id, label) {
  const noun = type === 'account' ? 'account' : 'purpose';
  if (!confirm(`Delete "${label}"?\n\nThis will permanently delete all its slices.`)) return;
  const path = type === 'account' ? `/api/accounts/${id}` : `/api/purposes/${id}`;
  try {
    await api('DELETE', path);
    // Remove from expanded sets and cache
    const key = (type === 'account' ? 'a' : 'p') + '-' + id;
    expandedAccounts.delete(key);
    expandedPurposes.delete(key);
    delete sliceCache[key];
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
    `<div class="info-box">
       Current total: <strong>${fmt(currentTotal)}</strong>
     </div>
     <div class="form-row">
       <label>New total ($)</label>
       <input id="rebal-new-total" type="number" min="0" step="0.01"
              value="${(currentTotal / 100).toFixed(2)}">
     </div>
     <div id="rebal-candidates"></div>`,
    `<button class="btn-cancel" onclick="closeModal()">Cancel</button>
     <button class="btn-primary" id="rebal-confirm" onclick="submitRebalance()" disabled>Confirm</button>`
  );

  // Wire up debounced input handler after DOM is ready
  setTimeout(() => {
    const inp = document.getElementById('rebal-new-total');
    if (!inp) return;
    inp.focus();
    inp.select();
    inp.addEventListener('input', debounce(rebalTotalChanged, 400));
  }, 50);
}

async function rebalTotalChanged() {
  const inp = document.getElementById('rebal-new-total');
  const cents = parseDollars(inp?.value);
  const cand = document.getElementById('rebal-candidates');
  if (!cand) return;

  if (cents === null) {
    cand.innerHTML = '';
    return;
  }
  if (cents === rebalState.currentTotal) {
    cand.innerHTML = '<div class="info-box">No change.</div>';
    document.getElementById('rebal-confirm').disabled = true;
    return;
  }

  cand.innerHTML = '<div class="info-box">Loading…</div>';

  try {
    const data = await api(
      'GET',
      `/api/accounts/${rebalState.accountId}/rebalance-candidates?newTotal=${cents}`
    );
    rebalState.candidates = data;
    renderCandidates(data);
  } catch (e) {
    cand.innerHTML = `<div class="info-box">Error: ${esc(e.message)}</div>`;
  }
}

function renderCandidates(data) {
  const { delta, purposes } = data;
  const cand = document.getElementById('rebal-candidates');

  if (delta === 0) {
    cand.innerHTML = '<div class="info-box">No change.</div>';
    document.getElementById('rebal-confirm').disabled = true;
    return;
  }

  const absDelta = Math.abs(delta);
  const sign = delta > 0 ? '+' : '−';
  const action = delta > 0 ? 'Add to' : 'Reduce from';
  const availKey = delta > 0 ? null : 'currentInAccount'; // for delta<0, cap per row

  let html = `<div class="info-box">
    Delta: <strong>${sign}${fmt(absDelta)}</strong>
    &nbsp;—&nbsp; ${delta > 0 ? 'Distribute additions across purposes' : 'Distribute reductions across purposes (max = current in account)'}
  </div>`;

  if (purposes.length === 0) {
    cand.innerHTML = html + '<div class="info-box">No eligible purposes.</div>';
    document.getElementById('rebal-confirm').disabled = true;
    return;
  }

  html += '<div class="purpose-grid">';
  for (const p of purposes) {
    const maxVal = delta < 0 ? (p.currentInAccount / 100).toFixed(2) : '';
    const maxAttr = delta < 0 ? `max="${maxVal}"` : '';
    const availLabel = delta > 0
      ? `total: ${fmt(p.total)}`
      : `in account: ${fmt(p.currentInAccount)}`;
    html += `
      <div class="purpose-grid-row">
        <span class="pg-label">${esc(p.label)}</span>
        <span class="pg-avail">${availLabel}</span>
        <input type="number" min="0" step="0.01" value="0" ${maxAttr}
               data-purpose-id="${p.id}"
               oninput="updateRebalRemainder()">
      </div>`;
  }
  html += '</div>';

  html += `<div class="remainder-row nonzero" id="rebal-remainder-row">
    <span class="rem-label">Remaining to allocate</span>
    <span class="rem-value" id="rebal-remainder">${fmt(absDelta)}</span>
  </div>`;

  cand.innerHTML = html;
  updateRebalRemainder();
}

function updateRebalRemainder() {
  const inputs = document.querySelectorAll('.purpose-grid-row input[type="number"]');
  let allocated = 0;
  for (const inp of inputs) {
    allocated += Math.round(parseFloat(inp.value || 0) * 100);
  }
  const absDelta = Math.abs(rebalState.candidates?.delta || 0);
  const remainder = absDelta - allocated;

  const remEl = document.getElementById('rebal-remainder');
  const rowEl = document.getElementById('rebal-remainder-row');
  if (remEl) remEl.textContent = fmt(Math.max(0, remainder));
  if (rowEl) {
    rowEl.className = 'remainder-row ' + (remainder === 0 ? 'zero' : 'nonzero');
  }

  const confirmBtn = document.getElementById('rebal-confirm');
  if (confirmBtn) confirmBtn.disabled = remainder !== 0;
}

async function submitRebalance() {
  const inputs = document.querySelectorAll('.purpose-grid-row input[type="number"]');
  const transfers = [];
  for (const inp of inputs) {
    const portion = Math.round(parseFloat(inp.value || 0) * 100);
    if (portion > 0) {
      transfers.push({ purposeId: parseInt(inp.dataset.purposeId), portion });
    }
  }
  if (transfers.length === 0) return showToast('No transfers specified');

  const newTotal = parseDollars(document.getElementById('rebal-new-total')?.value);
  if (newTotal === null) return showToast('Invalid new total');

  try {
    await api('POST', `/api/accounts/${rebalState.accountId}/rebalance`, {
      newTotal,
      transfers,
    });
    Object.keys(sliceCache).forEach(k => delete sliceCache[k]);
    closeModal();
    await loadState();
  } catch (e) {
    showToast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Purpose Transfer modal
// ---------------------------------------------------------------------------
let transferState = null;

function openTransferModal(purposeId, purposeLabel, currentTotal) {
  if (currentTotal <= 0) {
    return showToast(`${purposeLabel} has no balance to transfer`);
  }
  transferState = { purposeId, purposeLabel, currentTotal };

  const otherPurposes = (state?.purposes || []).filter(p => p.id !== purposeId);
  if (otherPurposes.length === 0) {
    return showToast('No other purposes to transfer to. Add another purpose first.');
  }

  const options = otherPurposes
    .map(p => `<option value="${p.id}">${esc(p.label)}</option>`)
    .join('');

  openModal(
    `Transfer from: ${purposeLabel}`,
    `<div class="info-box">
       Available: <strong>${fmt(currentTotal)}</strong>
     </div>
     <div class="form-row">
       <label>Amount ($)</label>
       <input id="transfer-amount" type="number" min="0.01" step="0.01"
              max="${(currentTotal / 100).toFixed(2)}" placeholder="0.00">
     </div>
     <div class="form-row">
       <label>To purpose</label>
       <select id="transfer-target">${options}</select>
     </div>`,
    `<button class="btn-cancel" onclick="closeModal()">Cancel</button>
     <button class="btn-primary" onclick="submitTransfer()">Transfer</button>`
  );
  setTimeout(() => document.getElementById('transfer-amount')?.focus(), 50);
}

async function submitTransfer() {
  const amountInput = document.getElementById('transfer-amount').value;
  const targetPurposeId = parseInt(document.getElementById('transfer-target').value);
  const amount = parseDollars(amountInput);

  if (amount === null || amount <= 0) return showToast('Enter a valid amount');
  if (amount > transferState.currentTotal) {
    return showToast(`Max transferable: ${fmt(transferState.currentTotal)}`);
  }

  try {
    await api('POST', `/api/purposes/${transferState.purposeId}/transfer`, {
      targetPurposeId,
      amount,
    });
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
