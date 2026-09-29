async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const tbody = document.querySelector('#sheet tbody');
const refreshBtn = document.getElementById('refresh');
const undoBtn = document.getElementById('undoAction');
const redoBtn = document.getElementById('redoAction');
const importCsvBtn = document.getElementById('importCsv');
const showVizBtn = document.getElementById('showViz');
const menuVizBtn = document.getElementById('menuViz');
const vizClearConnectionsBtn = document.getElementById('vizClearConnections');
const moveBtn = document.getElementById('moveSelected');
const menuLoansBtn = document.getElementById('menuLoans');
const showAdd = document.getElementById('showAdd');
const addForm = document.getElementById('addForm');
const moveForm = document.getElementById('moveForm');
const moveProjectSelect = document.getElementById('moveProject');
const moveOutsideFields = document.getElementById('moveOutsideFields');
const moveItemsEl = document.getElementById('moveItems');
const moveBorrowerInput = document.getElementById('moveBorrower');
const moveExpectedReturnInput = document.getElementById('moveExpectedReturn');
const moveNotesInput = document.getElementById('moveNotes');
const moveConfirm = document.getElementById('moveConfirm');
const moveCancel = document.getElementById('moveCancel');
const exportCsvBtn = document.getElementById('exportCsv');
const neededInput = document.getElementById('needed');
const loansView = document.getElementById('loansView');
const loansList = document.getElementById('loansList');
const loansFilterBorrower = document.getElementById('loansFilterBorrower');
const loansShowReturned = document.getElementById('loansShowReturned');
const loansViewClose = document.getElementById('loansViewClose');
const vizForm = document.getElementById('vizForm');
const vizProjectSelect = document.getElementById('vizProject');
const vizResetBtn = document.getElementById('vizReset');
const vizCloseBtn = document.getElementById('vizClose');
const vizStage = document.getElementById('vizStage');
const vizWires = document.getElementById('vizWires');
const vizNodes = document.getElementById('vizNodes');
const vizConnections = document.getElementById('vizConnections');
const filterProject = document.getElementById('filterProject');
const typeSelect = document.getElementById('type');
const storageSelect = document.getElementById('storage');
const menuToggle = document.getElementById('menuToggle');
const topMenu = document.getElementById('topMenu');
const menuRemove = document.getElementById('menuRemove');
const menuAddLocation = document.getElementById('menuAddLocation');
const menuAddProject = document.getElementById('menuAddProject');
const menuTypes = document.getElementById('menuTypes');
const menuLogout = document.getElementById('menuLogout');
const typesView = document.getElementById('typesView');
const typesList = document.getElementById('typesList');
const typesAddForm = document.getElementById('typesAddForm');
const typesAddName = document.getElementById('typesAddName');
const typesViewClose = document.getElementById('typesViewClose');
const addFormTitle = document.getElementById('addFormTitle');
const commentsInput = document.getElementById('comments');
const photoInput = document.getElementById('photo');
const photoPreview = document.getElementById('photoPreview');
const importForm = document.getElementById('importForm');
const importCsvFile = document.getElementById('importCsvFile');
const importConfirm = document.getElementById('importConfirm');
const importCancel = document.getElementById('importCancel');
const deleteForm = document.getElementById('deleteForm');
const deleteList = document.getElementById('deleteList');
const deleteConfirm = document.getElementById('deleteConfirm');
const deleteCancel = document.getElementById('deleteCancel');

let editId = null;

let items = [];
let locationsArr = [];
let projectOptions = [];
let undoStack = [];
let redoStack = [];
let moveDraft = [];
let loans = [];
let deleteDraft = [];
let sortKey = null;
let sortDir = 1; // 1 ascending, -1 descending

const DEFAULT_COLUMN_ORDER = ['name','project','storagePlace','amount','type','comments'];
let columnOrder = DEFAULT_COLUMN_ORDER.slice();

// load persisted sort and column order from localStorage
try {
  const sKey = localStorage.getItem('sortKey');
  const sDir = localStorage.getItem('sortDir');
  if (sKey) sortKey = sKey;
  if (sDir) sortDir = Number(sDir) || 1;
  const savedCols = localStorage.getItem('columnOrder');
  if (savedCols) {
    const parsed = JSON.parse(savedCols);
    if (Array.isArray(parsed) && parsed.length) columnOrder = parsed;
  }
} catch (e) { /* ignore */ }

// Drop stale columns from a previously persisted order (e.g. the removed 'availability'
// column), then ensure any newly added default columns exist.
if (sortKey === 'availability') sortKey = null;
columnOrder = columnOrder.filter((k) => DEFAULT_COLUMN_ORDER.includes(k));
for (const key of DEFAULT_COLUMN_ORDER) {
  if (!columnOrder.includes(key)) columnOrder.push(key);
}

function saveSort() {
  try { localStorage.setItem('sortKey', sortKey || ''); localStorage.setItem('sortDir', String(sortDir)); } catch(e){}
}
function saveColumnOrder() { try { localStorage.setItem('columnOrder', JSON.stringify(columnOrder)); } catch(e){} }

function setSort(key) {
  if (sortKey === key) sortDir = -sortDir;
  else { sortKey = key; sortDir = 1; }
  saveSort();
  render();
}

function updateHeaderIndicators() {
  const headers = document.querySelectorAll('th.sortable');
  headers.forEach(h => {
    const key = h.dataset.key;
    const ind = h.querySelector('.sort-indicator');
    if (!ind) return;
    if (key === sortKey) ind.textContent = sortDir === 1 ? '▲' : '▼';
    else ind.textContent = '';
  });
}

function cloneItem(item) {
  return item ? JSON.parse(JSON.stringify(item)) : null;
}

function syncHistoryButtons() {
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

// Visualizer is now a separate module `visualizer.js`.
// Create and wire it below after initial load so it can call back into this app.
let Visualizer = null;
function getItemsForVisualizer() { return items; }
function getProjectOptionsForVisualizer() { return projectOptions; }
function setVizVisible(visible) { if (vizForm) vizForm.classList.toggle('hidden', !visible); }

// Visualizer operations live entirely in the visualizer.js module; it wires its own
// listeners once loaded (see the `window load` handler below).

function pushHistory(entry) {
  undoStack.push(entry);
  redoStack = [];
  syncHistoryButtons();
}

async function restoreItemSnapshot(snapshot) {
  if (!snapshot) return;
  const { id, ...rest } = snapshot;
  await api(`/api/items/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rest) });
}

async function deleteItem(id) {
  try {
    await api(`/api/items/${id}`, { method: 'DELETE' });
    return;
  } catch (err) {
    // fallback to POST based delete endpoint (server supports /api/items/:id/delete)
    try {
      await api(`/api/items/${id}/delete`, { method: 'POST' });
      return;
    } catch (err2) {
      // rethrow original error for upstream handling
      throw err;
    }
  }
}

async function runHistoryEntry(entry, direction) {
  if (entry.kind === 'move-group') {
    const entries = direction === 'undo' ? [...entry.entries].reverse() : entry.entries;
    for (const e of entries) {
      if (direction === 'undo') {
        if (e.moveKind === 'rename') {
          await restoreItemSnapshot(e.sourceBefore);
        } else if (e.moveKind === 'split') {
          await deleteItem(e.result.id);
          await restoreItemSnapshot(e.sourceBefore);
        } else if (e.moveKind === 'merge') {
          // subtract back off only the amount this move added, rather than restoring a
          // stale full snapshot that could clobber unrelated changes made since
          await api(`/api/items/${e.result.id}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ amount: Math.max(0, (Number(e.result.amount) || 0) - e.amount) })
          });
          if (e.sourceDeleted) {
            await api('/api/items', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(e.sourceBefore)
            });
          } else {
            await restoreItemSnapshot(e.sourceBefore);
          }
        }
      } else {
        const body = { amount: e.amount, project: e.targetProject };
        if (e.isOutside) Object.assign(body, { borrower: e.borrower, expectedReturn: e.expectedReturn, notes: e.notes });
        const response = await api(`/api/items/${e.sourceBefore.id}/move`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
        });
        // Replaying a move can produce a different result (new record id, different
        // merge target) than the original — update the entry in place so a later undo
        // of this same redone entry targets the right record, not a stale/deleted one.
        e.result = response.result;
        e.moveKind = response.kind;
        e.sourceDeleted = response.sourceDeleted;
      }
    }
    return;
  }

  if (entry.kind === 'create') {
    if (direction === 'undo') {
      await deleteItem(entry.item.id);
    } else {
      await api('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry.item)
      });
    }
    return;
  }

  if (entry.kind === 'bulk-delete') {
    const entries = direction === 'undo' ? [...entry.entries].reverse() : entry.entries;
    for (const e of entries) {
      if (direction === 'undo') {
        // recreate item from snapshot
        await api('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(e.item)
        });
      } else {
        // redo delete
        await deleteItem(e.item.id);
      }
    }
    return;
  }

  if (entry.kind === 'update') {
    if (direction === 'undo') await restoreItemSnapshot(entry.before);
    else await restoreItemSnapshot(entry.after);
  }
}

async function undoLastAction() {
  const entry = undoStack.pop();
  if (!entry) return;
  try {
    await runHistoryEntry(entry, 'undo');
    redoStack.push(entry);
    syncHistoryButtons();
    await load();
  } catch (err) {
    undoStack.push(entry);
    syncHistoryButtons();
    alert('Could not undo the last action');
    console.error(err);
  }
}

async function redoLastAction() {
  const entry = redoStack.pop();
  if (!entry) return;
  try {
    await runHistoryEntry(entry, 'redo');
    undoStack.push(entry);
    syncHistoryButtons();
    await load();
  } catch (err) {
    redoStack.push(entry);
    syncHistoryButtons();
    alert('Could not redo the last action');
    console.error(err);
  }
}

async function load() {
  // load presets first
  try {
    const presets = await api('/api/types');
    if (typeSelect) {
      typeSelect.innerHTML = '';
      for (const t of presets) {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        typeSelect.appendChild(opt);
      }
    }
  } catch (e) {
    console.warn('Could not load type presets', e);
  }
  // load locations
  try {
    const locs = await api('/api/locations');
    locationsArr = locs;
    if (storageSelect) {
      storageSelect.innerHTML = '';
      for (const l of locs) {
        const opt = document.createElement('option'); opt.value = l.name; opt.textContent = l.name;
        storageSelect.appendChild(opt);
      }
    }
    // populate the locations list in the menu
    const locationsList = document.getElementById('locationsList');
    if (locationsList) {
      locationsList.innerHTML = '';
      // group by site
      const groups = {};
      for (const loc of locs) {
        const site = loc.site || 'default';
        groups[site] = groups[site] || [];
        groups[site].push(loc);
      }
      for (const site of Object.keys(groups)) {
        const h = document.createElement('div'); h.className = 'locSite'; h.textContent = site;
        locationsList.appendChild(h);
        for (const loc of groups[site]) {
          const row = document.createElement('div'); row.className = 'locRow';
          row.innerHTML = `<button type="button" class="locName" data-name="${loc.name}">${loc.name}</button>
            <button type="button" class="locUp" data-name="${loc.name}">▲</button>
            <button type="button" class="locDown" data-name="${loc.name}">▼</button>
            <button type="button" class="locDelete" data-name="${loc.name}">✕</button>`;
          locationsList.appendChild(row);
        }
      }
    }
  } catch (e) {
    console.warn('Could not load locations', e);
  }
  // load projects
  try {
    const projects = await api('/api/projects');
    projectOptions = projects.slice();
    if (Visualizer) Visualizer.populateVisualizerProjects();
    if (filterProject) {
      // preserve whatever project the user had filtered to — rebuilding the options
      // below would otherwise silently reset the select back to "all" every time
      const previousFilter = filterProject.value;
      // keep 'all' option
      filterProject.innerHTML = '<option value="all">All projects</option>';
      for (const p of projects) {
        const opt = document.createElement('option'); opt.value = p; opt.textContent = p;
        filterProject.appendChild(opt);
      }
      if (previousFilter && (previousFilter === 'all' || projects.includes(previousFilter))) {
        filterProject.value = previousFilter;
      }
    }
    const projectSelect = document.getElementById('project');
    if (projectSelect) {
      projectSelect.innerHTML = '';
      for (const p of projects) {
        const opt = document.createElement('option'); opt.value = p; opt.textContent = p;
        projectSelect.appendChild(opt);
      }
    }
  } catch (e) { console.warn('Could not load projects', e); }
  items = await api('/api/items');
  try { loans = await api('/api/loans'); } catch (e) { console.warn('Could not load loans', e); }
  renderHeader();
  render();
  if (Visualizer && vizForm && !vizForm.classList.contains('hidden')) Visualizer.renderVisualizer();
  syncHistoryButtons();
}

function renderHeader() {
  const headerRow = document.querySelector('#sheet thead tr');
  if (!headerRow) return;
  // fixed first two columns
  headerRow.innerHTML = '';
  const thEmpty = document.createElement('th'); headerRow.appendChild(thEmpty);
  const thEdit = document.createElement('th'); thEdit.textContent = 'Edit'; headerRow.appendChild(thEdit);
  const thPhoto = document.createElement('th'); thPhoto.textContent = 'Photo'; headerRow.appendChild(thPhoto);
  // add dynamic columns in columnOrder
  for (const key of columnOrder) {
    const th = document.createElement('th');
    th.className = 'sortable';
    th.dataset.key = key;
    th.draggable = true;
    const labelMap = { name: 'Name', project: 'Project', storagePlace: 'Storage', amount: 'Amount', type: 'Type', comments: 'Comments' };
    th.innerHTML = `${labelMap[key] || key} <span class="sort-indicator"></span>`;
    // click sorting
    th.addEventListener('click', (e) => { if (e.target.closest('button')) return; setSort(th.dataset.key); });
    // drag handlers
    th.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', th.dataset.key); ev.dataTransfer.effectAllowed = 'move'; });
    th.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; th.classList.add('drag-over'); });
    th.addEventListener('dragleave', () => { th.classList.remove('drag-over'); });
    th.addEventListener('drop', (ev) => {
      ev.preventDefault(); th.classList.remove('drag-over');
      const fromKey = ev.dataTransfer.getData('text/plain');
      const toKey = th.dataset.key;
      if (fromKey && toKey && fromKey !== toKey) {
        const idxFrom = columnOrder.indexOf(fromKey);
        const idxTo = columnOrder.indexOf(toKey);
        if (idxFrom !== -1 && idxTo !== -1) {
          columnOrder.splice(idxFrom, 1);
          columnOrder.splice(idxTo, 0, fromKey);
          saveColumnOrder();
          renderHeader();
          render();
        }
      }
    });
    headerRow.appendChild(th);
  }
}

function render() {
  const filter = filterProject.value;
  tbody.innerHTML = '';
  // prepare sorted+filtered list
  let list = items.slice();
  if (sortKey) {
    list.sort((a, b) => {
      const A = a[sortKey];
      const B = b[sortKey];
      if (sortKey === 'amount') return ((Number(A) || 0) - (Number(B) || 0)) * sortDir;
      const sa = (A === undefined || A === null) ? '' : String(A).toLowerCase();
      const sb = (B === undefined || B === null) ? '' : String(B).toLowerCase();
      if (sa < sb) return -1 * sortDir;
      if (sa > sb) return 1 * sortDir;
      return 0;
    });
  }

  for (const it of list) {
    if (filter !== 'all' && it.project !== filter) continue;
    const tr = document.createElement('tr');
    // fixed columns
    const tdCheck = document.createElement('td'); tdCheck.innerHTML = `<input data-id="${it.id}" type="checkbox">`; tr.appendChild(tdCheck);
    const tdEdit = document.createElement('td'); tdEdit.innerHTML = `<button class="editBtn" data-id="${it.id}">Edit</button>`; tr.appendChild(tdEdit);
    const tdPhoto = document.createElement('td');
    if (it.photo) tdPhoto.innerHTML = `<img src="${it.photo}" class="thumb" alt="">`;
    tr.appendChild(tdPhoto);
    // dynamic columns according to columnOrder
    for (const key of columnOrder) {
      const td = document.createElement('td');
      if (key === 'name') td.textContent = it.name || '';
      else if (key === 'project') td.textContent = it.project || '';
      else if (key === 'storagePlace') {
        if (it.project === OUTSIDE_PROJECT) {
          // physical shelf location is meaningless once an item is out on personal
          // loan — show when it left instead, from the matching open loan record
          const loan = loans.find((l) => l.itemId === it.id && !l.returnedAt);
          td.textContent = loan ? `Away since ${new Date(loan.loanedAt).toLocaleDateString()}` : 'Away';
          td.classList.add('qty-short');
        } else {
          td.textContent = it.storagePlace || '';
        }
      }
      else if (key === 'amount') {
        const amt = Number(it.amount) || 0;
        if (!window.InventoryUtil.hasQuantityGoal(it.project)) {
          // "general" (default storage pool) and "Prototyping" (not a fixed build) don't
          // track a "needed" quantity — just show the plain count.
          td.textContent = String(amt);
        } else {
          const needed = Number.isFinite(Number(it.needed)) ? Number(it.needed) : amt;
          td.textContent = `${amt}/${needed}`;
          if (amt < needed) td.classList.add('qty-short');
        }
      }
      else if (key === 'type') td.textContent = it.type || '';
      else if (key === 'comments') td.textContent = it.comments || '';
      else td.textContent = it[key] || '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  updateHeaderIndicators();
}

function selectedIds() {
  return Array.from(document.querySelectorAll('#sheet tbody input[type=checkbox]:checked')).map(cb => cb.dataset.id);
}

function selectedItems() {
  return selectedIds().map((id) => items.find((item) => item.id === id)).filter(Boolean);
}

function csvEscape(value) {
  const str = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Exports a project's fixed requirements list (name, type, needed quantity) — ignores
// current on-hand amounts and any loans/moves in progress, per design.
function exportProjectCsv() {
  const project = filterProject.value;
  if (!project || project === 'all') return alert('Select a specific project first');
  const rows = items.filter((it) => it.project === project);
  const neededOf = (it) => (Number.isFinite(Number(it.needed)) ? Number(it.needed) : (Number(it.amount) || 0));
  const lines = [['name', 'type', 'quantity'], ...rows.map((it) => [it.name || '', it.type || '', neededOf(it)])];
  const csv = lines.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.replace(/[^a-z0-9-_]+/gi, '_')}-requirements.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

refreshBtn.addEventListener('click', load);
undoBtn.addEventListener('click', undoLastAction);
redoBtn.addEventListener('click', redoLastAction);
filterProject.addEventListener('change', render);
if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportProjectCsv);

// top menu toggle + actions
menuToggle.addEventListener('click', () => topMenu.classList.toggle('hidden'));

menuRemove.addEventListener('click', (e) => {
  const ids = selectedIds();
  if (!ids.length) return alert('Select items');
  // build list preview
  const rows = ids.map((id) => {
    const it = items.find(x => x.id === id);
    if (!it) return `<div style="padding:6px;border-bottom:1px solid #f2f4f6">Missing item ${id}</div>`;
    return `<div style="padding:6px;border-bottom:1px solid #f2f4f6"><strong>${it.name || it.id}</strong> — ${it.amount || 0} • ${it.project || 'general'}</div>`;
  }).join('');
  if (deleteList) deleteList.innerHTML = rows;
  deleteDraft = ids.slice();
  if (deleteForm) deleteForm.classList.remove('hidden');
  topMenu.classList.add('hidden');
});

// cancel and confirm handlers for delete modal
if (deleteCancel) deleteCancel.addEventListener('click', () => {
  deleteDraft = [];
  if (deleteForm) deleteForm.classList.add('hidden');
});

if (deleteConfirm) deleteConfirm.addEventListener('click', async () => {
  if (!deleteDraft.length) return;
  const entries = [];
  for (const id of deleteDraft) {
    const before = cloneItem(items.find((item) => item.id === id));
    try {
      await deleteItem(id);
      entries.push({ kind: 'delete', item: before });
    } catch (err) {
      console.warn('Could not delete item', id, err);
    }
  }
  if (entries.length) pushHistory({ kind: 'bulk-delete', entries });
  deleteDraft = [];
  if (deleteForm) deleteForm.classList.add('hidden');
  // optimistically update client-side state so table reflects deletions immediately
  try {
    const deletedIds = new Set(entries.map(e => e.item && e.item.id).filter(Boolean));
    if (deletedIds.size) {
      items = items.filter(i => !deletedIds.has(i.id));
      render();
    }
  } catch (err) { console.warn('Could not update client state after delete', err); }
  // refresh from server but don't crash the UI if it fails
  try { await load(); } catch (err) { console.warn('Could not reload after delete', err); }
});

menuAddLocation.addEventListener('click', async () => {
  const name = prompt('New location name');
  if (!name) return;
  const site = prompt('Site/group for this location (optional)', 'default');
  await api('/api/locations', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name, site }) });
  topMenu.classList.add('hidden');
  await load();
});

if (menuAddProject) {
  menuAddProject.addEventListener('click', async () => {
    const name = prompt('New project name');
    if (!name) return;
    await api('/api/projects', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name }) });
    topMenu.classList.add('hidden');
    await load();
  });
}

async function renderTypesList() {
  if (!typesList) return;
  let allTypes = [];
  let customTypes = [];
  try {
    [allTypes, customTypes] = await Promise.all([api('/api/types'), api('/api/types/custom')]);
  } catch (e) {
    console.warn('Could not load types', e);
  }
  const customSet = new Set(customTypes);
  if (!allTypes.length) {
    typesList.innerHTML = '<div class="loans-empty">No types yet.</div>';
    return;
  }
  typesList.innerHTML = '';
  for (const t of allTypes.slice().sort()) {
    const row = document.createElement('div');
    row.className = 'type-row';
    if (customSet.has(t)) {
      row.innerHTML = `<span>${t}</span><button type="button" data-remove-type="${t}">Delete</button>`;
    } else {
      row.innerHTML = `<span>${t}</span><span class="type-builtin-tag">built-in</span>`;
    }
    typesList.appendChild(row);
  }
}

if (menuTypes) {
  menuTypes.addEventListener('click', async () => {
    topMenu.classList.add('hidden');
    if (typesView) typesView.classList.remove('hidden');
    await renderTypesList();
  });
}

if (typesViewClose) {
  typesViewClose.addEventListener('click', () => {
    if (typesView) typesView.classList.add('hidden');
  });
}

if (typesAddForm) {
  typesAddForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = typesAddName.value.trim();
    if (!name) return;
    await api('/api/types', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    typesAddName.value = '';
    await renderTypesList();
    await load();
  });
}

if (typesList) {
  typesList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-remove-type]');
    if (!btn) return;
    const name = btn.dataset.removeType;
    if (!confirm(`Delete type "${name}"? Items already using it keep it, and it will reappear here until none do.`)) return;
    try {
      await api('/api/types/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    } catch (err) {
      alert('Could not delete this type');
      return;
    }
    await renderTypesList();
    await load();
  });
}

if (menuLogout) {
  menuLogout.addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  });
}

// click handler for location buttons in the menu (event delegation)
// handlers for location menu actions (delegated)
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.locName');
  if (b) {
    const name = b.dataset.name;
    if (storageSelect) storageSelect.value = name;
    topMenu.classList.add('hidden');
    return;
  }
  const up = e.target.closest('.locUp');
  if (up) {
    const name = up.dataset.name;
    await reorderLocation(name, -1);
    return;
  }
  const down = e.target.closest('.locDown');
  if (down) {
    const name = down.dataset.name;
    await reorderLocation(name, 1);
    return;
  }
  const del = e.target.closest('.locDelete');
  if (del) {
    const name = del.dataset.name;
    if (!confirm(`Delete storage location "${name}"? Items already using it keep it as a plain label.`)) return;
    await api('/api/locations/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    await load();
    return;
  }
});

async function reorderLocation(name, dir) {
  // build current order
  const order = locationsArr.map(l => l.name);
  const idx = order.indexOf(name);
  if (idx === -1) return;
  const to = idx + dir;
  if (to < 0 || to >= order.length) return;
  const swapped = [...order];
  const tmp = swapped[to]; swapped[to] = swapped[idx]; swapped[idx] = tmp;
  await api('/api/locations/reorder', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ order: swapped }) });
  await load();
}

const OUTSIDE_PROJECT = 'Outside';

if (moveBtn) {
  moveBtn.addEventListener('click', () => {
    const currentItems = selectedItems();
    if (!currentItems.length) return alert('Select items');
    moveDraft = currentItems.map((item) => ({ item: cloneItem(item), amount: Number(item.amount) || 0 }));
    if (moveProjectSelect) {
      moveProjectSelect.innerHTML = '';
      for (const p of projectOptions) {
        if (p === OUTSIDE_PROJECT) continue; // avoid a duplicate — appended once below
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        moveProjectSelect.appendChild(opt);
      }
      const outsideOpt = document.createElement('option');
      outsideOpt.value = OUTSIDE_PROJECT;
      outsideOpt.textContent = `${OUTSIDE_PROJECT} (personal)`;
      moveProjectSelect.appendChild(outsideOpt);
    }
    if (moveBorrowerInput) moveBorrowerInput.value = '';
    if (moveExpectedReturnInput) moveExpectedReturnInput.value = '';
    if (moveNotesInput) moveNotesInput.value = '';
    if (moveOutsideFields) moveOutsideFields.classList.toggle('hidden', moveProjectSelect && moveProjectSelect.value !== OUTSIDE_PROJECT);
    if (moveItemsEl) {
      moveItemsEl.innerHTML = '';
      for (const draft of moveDraft) {
        const row = document.createElement('div');
        row.className = 'transfer-row';
        row.innerHTML = `
          <div>
            <strong>${draft.item.name || 'Unnamed item'}</strong>
            <small>Currently here: ${draft.amount}</small>
          </div>
          <label>Quantity <input type="number" min="1" max="${draft.amount}" value="${draft.amount}" data-move-id="${draft.item.id}"></label>
        `;
        moveItemsEl.appendChild(row);
      }
    }
    if (moveForm) moveForm.classList.remove('hidden');
  });
}

if (moveProjectSelect) {
  moveProjectSelect.addEventListener('change', () => {
    if (moveOutsideFields) moveOutsideFields.classList.toggle('hidden', moveProjectSelect.value !== OUTSIDE_PROJECT);
  });
}

if (moveCancel) {
  moveCancel.addEventListener('click', () => {
    moveDraft = [];
    if (moveForm) moveForm.classList.add('hidden');
  });
}

if (moveConfirm) {
  moveConfirm.addEventListener('click', async () => {
    const targetProject = moveProjectSelect ? moveProjectSelect.value : '';
    if (!targetProject) return alert('Choose a destination');
    const isOutside = targetProject === OUTSIDE_PROJECT;
    const borrower = moveBorrowerInput ? moveBorrowerInput.value.trim() : '';
    if (isOutside && !borrower) return alert('Enter a borrower name');
    const expectedReturn = moveExpectedReturnInput ? moveExpectedReturnInput.value : '';
    const notes = moveNotesInput ? moveNotesInput.value : '';

    // validate every row before sending any request, so a late error can't leave an
    // un-undoable partially-applied batch
    const rows = [];
    for (const draft of moveDraft) {
      const input = moveItemsEl ? moveItemsEl.querySelector(`input[data-move-id="${draft.item.id}"]`) : null;
      const amount = Number(input ? input.value : draft.amount);
      if (!Number.isFinite(amount) || amount <= 0) return alert(`Invalid quantity for ${draft.item.name}`);
      if (amount > draft.amount) return alert(`${draft.item.name} only has ${draft.amount} available`);
      if (targetProject === draft.item.project) return alert(`${draft.item.name} is already in ${targetProject}`);
      rows.push({ draft, amount });
    }

    const entries = [];
    for (const { draft, amount } of rows) {
      const body = { amount, project: targetProject };
      if (isOutside) Object.assign(body, { borrower, expectedReturn, notes });
      const response = await api(`/api/items/${draft.item.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      entries.push({
        sourceBefore: draft.item,
        result: response.result,
        moveKind: response.kind,
        sourceDeleted: response.sourceDeleted,
        amount,
        targetProject,
        isOutside,
        borrower,
        expectedReturn,
        notes
      });
    }
    pushHistory({ kind: 'move-group', entries });
    moveDraft = [];
    if (moveForm) moveForm.classList.add('hidden');
    await load();
  });
}

function renderLoans() {
  if (!loansList) return;
  const borrowerFilter = (loansFilterBorrower && loansFilterBorrower.value || '').trim().toLowerCase();
  const showReturned = loansShowReturned ? loansShowReturned.checked : false;
  const list = loans
    .filter((loan) => showReturned || !loan.returnedAt)
    .filter((loan) => !borrowerFilter || (loan.borrower || '').toLowerCase().includes(borrowerFilter))
    .slice()
    .sort((a, b) => new Date(b.loanedAt) - new Date(a.loanedAt));

  if (!list.length) {
    loansList.innerHTML = '<div class="loans-empty">No loans to show.</div>';
    return;
  }

  loansList.innerHTML = '';
  for (const loan of list) {
    const row = document.createElement('div');
    row.className = 'loan-row';
    const loanedDate = loan.loanedAt ? new Date(loan.loanedAt).toLocaleDateString() : '';
    const expected = loan.expectedReturn ? ` · Expected back: ${loan.expectedReturn}` : '';
    const returned = loan.returnedAt ? ` · Returned: ${new Date(loan.returnedAt).toLocaleDateString()}` : '';
    row.innerHTML = `
      <div class="loan-main">
        <strong>${loan.itemName || 'Unnamed item'} × ${loan.quantity}</strong>
        <div class="loan-meta">${loan.borrower} · Loaned: ${loanedDate}${expected}${returned}${loan.notes ? ` · ${loan.notes}` : ''}</div>
      </div>
      <div>
        <span class="loan-badge ${loan.returnedAt ? 'returned' : 'active'}">${loan.returnedAt ? 'returned' : 'active'}</span>
        ${!loan.returnedAt ? `<button type="button" data-return-loan="${loan.id}">Mark returned</button>` : ''}
      </div>
    `;
    loansList.appendChild(row);
  }
}

if (menuLoansBtn) {
  menuLoansBtn.addEventListener('click', () => {
    topMenu.classList.add('hidden');
    renderLoans();
    if (loansView) loansView.classList.remove('hidden');
  });
}

if (loansViewClose) {
  loansViewClose.addEventListener('click', () => {
    if (loansView) loansView.classList.add('hidden');
  });
}

if (loansFilterBorrower) loansFilterBorrower.addEventListener('input', renderLoans);
if (loansShowReturned) loansShowReturned.addEventListener('change', renderLoans);

if (loansList) {
  loansList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-return-loan]');
    if (!btn) return;
    await api(`/api/loans/${btn.dataset.returnLoan}/return`, { method: 'POST' });
    await load();
    renderLoans();
  });
}

showAdd.addEventListener('click', () => addForm.classList.toggle('hidden'));

// when opening add form explicitly, reset edit mode
showAdd.addEventListener('click', () => {
  editId = null;
  if (addFormTitle) addFormTitle.textContent = 'Add Item';
  document.getElementById('name').value = '';
  document.getElementById('amount').value = 1;
  if (neededInput) neededInput.value = 1;
  if (commentsInput) commentsInput.value = '';
  if (photoInput) photoInput.value = '';
  if (photoPreview) { photoPreview.src = ''; photoPreview.classList.add('hidden'); }
});

document.getElementById('addCancel').addEventListener('click', () => addForm.classList.add('hidden'));

document.getElementById('addSubmit').addEventListener('click', async () => {
  const name = document.getElementById('name').value;
  const storage = document.getElementById('storage').value;
  const amount = Number(document.getElementById('amount').value) || 0;
  const needed = neededInput ? (Number(neededInput.value) || amount) : amount;
  const type = document.getElementById('type').value;
  const project = document.getElementById('project').value || 'general';
  const comments = commentsInput ? commentsInput.value : '';
  let savedId = editId;
  if (editId) {
    const before = cloneItem(items.find((item) => item.id === editId));
    const after = await api(`/api/items/${editId}`, { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ name, storagePlace: storage, amount, needed, comments, type, project }) });
    pushHistory({ kind: 'update', before, after: cloneItem(after) });
    editId = null;
    if (addFormTitle) addFormTitle.textContent = 'Add Item';
  } else {
    const created = await api('/api/items', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name, storagePlace: storage, amount, needed, comments, type, project }) });
    pushHistory({ kind: 'create', item: cloneItem(created) });
    savedId = created.id;
  }
  const photoFile = photoInput && photoInput.files ? photoInput.files[0] : null;
  if (photoFile && savedId) {
    const formData = new FormData();
    formData.append('photo', photoFile);
    try {
      await fetch(`/api/items/${savedId}/photo`, { method: 'POST', body: formData });
    } catch (e) { console.warn('Photo upload failed', e); }
  }
  addForm.classList.add('hidden');
  await load();
});

// handle clicks on edit buttons in the table (event delegation)
tbody.addEventListener('click', (e) => {
  const btn = e.target.closest('.editBtn');
  if (!btn) return;
  const id = btn.dataset.id;
  const item = items.find(x => x.id === id);
  if (!item) return alert('Item not found');
  // populate form
  document.getElementById('name').value = item.name || '';
  document.getElementById('amount').value = item.amount || 0;
  if (neededInput) neededInput.value = Number.isFinite(Number(item.needed)) ? item.needed : (item.amount || 0);
  document.getElementById('type').value = item.type || '';
  document.getElementById('storage').value = item.storagePlace || '';
  document.getElementById('project').value = item.project || 'general';
  if (commentsInput) commentsInput.value = item.comments || '';
  if (photoInput) photoInput.value = '';
  if (photoPreview) {
    if (item.photo) { photoPreview.src = item.photo; photoPreview.classList.remove('hidden'); }
    else { photoPreview.src = ''; photoPreview.classList.add('hidden'); }
  }
  editId = id;
  if (addFormTitle) addFormTitle.textContent = 'Edit Item';
  addForm.classList.remove('hidden');
});

if (importCsvBtn) {
  importCsvBtn.addEventListener('click', () => {
    if (importCsvFile) importCsvFile.value = '';
    if (importForm) importForm.classList.remove('hidden');
  });
}

if (importCancel) {
  importCancel.addEventListener('click', () => {
    if (importForm) importForm.classList.add('hidden');
    if (importCsvFile) importCsvFile.value = '';
  });
}

if (importConfirm) {
  importConfirm.addEventListener('click', async () => {
    const file = importCsvFile && importCsvFile.files ? importCsvFile.files[0] : null;
    if (!file) return alert('Choose a CSV file first');
    const csvText = await file.text();
    const result = await api('/api/items/import-csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csvText })
    });
    if (importForm) importForm.classList.add('hidden');
    if (importCsvFile) importCsvFile.value = '';
    await load();
    alert(`Imported ${result.createdCount || 0} items for project ${result.project || ''}`);
  });
}

load().catch(err => console.error(err));

// header interactions handled in renderHeader() — ensure header is rendered now
renderHeader();
saveColumnOrder();

// Initialize visualizer module when available
window.addEventListener('load', () => {
  try {
    if (window.InventoryVisualizer && window.InventoryUtil) {
      const viz = window.InventoryVisualizer.create({
        vizForm,
        vizProjectSelect,
        vizResetBtn,
        vizCloseBtn,
        vizStage,
        vizWires,
        vizNodes,
        vizConnections,
        getItems: getItemsForVisualizer,
        getProjectOptions: getProjectOptionsForVisualizer,
        setVizVisible,
        itemLabel: window.InventoryUtil.itemLabel,
        segmentLabel: window.InventoryUtil.segmentLabel,
        sideLabel: window.InventoryUtil.sideLabel
      });
      Visualizer = viz;
      // wire buttons
      if (showVizBtn) showVizBtn.addEventListener('click', () => Visualizer.openVisualizer());
      if (menuVizBtn) menuVizBtn.addEventListener('click', () => { topMenu.classList.add('hidden'); Visualizer.openVisualizer(); });
      if (vizClearConnectionsBtn) vizClearConnectionsBtn.addEventListener('click', () => Visualizer.clearVisualizerConnections());
      // populate projects
      Visualizer.populateVisualizerProjects();
    }
  } catch (e) { console.warn('Visualizer init failed', e); }
});
