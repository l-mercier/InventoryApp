const fs = require('fs');
const path = require('path');

// In production (Render, etc.) DATA_DIR points at a mounted persistent disk so the
// data file and uploaded photos survive redeploys. Defaults to this repo for local dev.
const DATA_DIR = process.env.DATA_DIR || __dirname;

const DB_PATHS = [
  path.join(DATA_DIR, 'data', 'db.json'),
  path.join(DATA_DIR, 'db.json')
];

function getDbFile() {
  for (const p of DB_PATHS) if (fs.existsSync(p)) return p;
  // prefer data/db.json as default location
  return DB_PATHS[0];
}

function read() {
  try {
    const file = getDbFile();
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { items: [], locations: [] };
  }
}

function write(data) {
  const file = getDbFile();
  // ensure directory exists for preferred path
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // keep a single rolling backup of the last-known-good file before overwriting it
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch (e) { /* best-effort */ }
  }
  // atomic write: write to a temp file then rename, so a crash mid-write can never
  // leave db.json truncated/corrupt (rename is atomic on the same filesystem)
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, file);
}

function ensure() {
  const file = getDbFile();
  if (!fs.existsSync(file)) write({ items: [], locations: [{ name: 'general', site: 'default' }], vizData: {}, loans: [], projects: [], types: [] });
  else {
    const data = read();
    let changed = false;
    if (!Array.isArray(data.items)) { data.items = []; changed = true; }
    else {
      // migrate items: total -> needed, drop spare/qtyOnSite/availability (superseded by
      // the amount/needed pair). Idempotent — items already migrated are left untouched.
      data.items = data.items.map((item) => {
        const alreadyMigrated = item.needed !== undefined && item.spare === undefined
          && item.qtyOnSite === undefined && item.availability === undefined;
        if (alreadyMigrated) return item;
        changed = true;
        const amount = Number(item.amount) || 0;
        const needed = Number.isFinite(Number(item.total)) ? Math.max(0, Number(item.total)) : amount;
        const { spare, qtyOnSite, total, availability, ...rest } = item;
        return { ...rest, amount, needed };
      });
    }
    // migrate locations: allow old array of strings
    if (!Array.isArray(data.locations)) { data.locations = [{ name: 'general', site: 'default' }]; changed = true; }
    else {
      if (data.locations.length && typeof data.locations[0] === 'string') {
        data.locations = data.locations.map(n => ({ name: n, site: 'default' }));
        changed = true;
      } else {
        // ensure objects have name and site
        data.locations = data.locations.map(l => ({ name: l.name || String(l), site: l.site || 'default' }));
      }
    }
    if (!data.vizData || typeof data.vizData !== 'object') { data.vizData = {}; changed = true; }
    if (!Array.isArray(data.loans)) { data.loans = []; changed = true; }
    if (!Array.isArray(data.projects)) { data.projects = []; changed = true; }
    if (!Array.isArray(data.types)) { data.types = []; changed = true; }
    if (changed) write(data);
  }
}

ensure();

module.exports = {
  all() { return read().items; },
  get(id) { return read().items.find(i => i.id === id); },
  add(item) {
    const data = read();
    data.items.push(item);
    write(data);
    return item;
  },
  update(id, patch) {
    const data = read();
    const idx = data.items.findIndex(i => i.id === id);
    if (idx === -1) return null;
    data.items[idx] = { ...data.items[idx], ...patch };
    write(data);
    return data.items[idx];
  },
  delete(id) {
    const data = read();
    const idx = data.items.findIndex(i => i.id === id);
    if (idx === -1) return null;
    const removed = data.items.splice(idx, 1)[0];
    write(data);
    return removed;
  },
  // schematic (viz) data — shared across collaborators, keyed by project name
  getVizData(project) {
    const data = read();
    return data.vizData[project] || { layout: {}, connections: [], splits: {}, legend: [] };
  },
  saveVizData(project, vizData) {
    const data = read();
    data.vizData[project] = {
      layout: vizData.layout || {},
      connections: Array.isArray(vizData.connections) ? vizData.connections : [],
      splits: vizData.splits || {},
      legend: Array.isArray(vizData.legend) ? vizData.legend : []
    };
    write(data);
    return data.vizData[project];
  },
  // personal loans (traceability for equipment checked out outside of any project)
  loans() { return read().loans; },
  addLoan(loan) {
    const data = read();
    data.loans.push(loan);
    write(data);
    return loan;
  },
  returnLoan(id, patch) {
    const data = read();
    const idx = data.loans.findIndex(l => l.id === id);
    if (idx === -1) return null;
    data.loans[idx] = { ...data.loans[idx], ...patch };
    write(data);
    return data.loans[idx];
  },
  // projects helpers
  projects() { return read().projects; },
  addProject(name) {
    const data = read();
    if (!data.projects.includes(name)) data.projects.push(name);
    write(data);
    return data.projects;
  },
  // types helpers
  types() { return read().types; },
  addType(name) {
    const data = read();
    if (!data.types.includes(name)) data.types.push(name);
    write(data);
    return data.types;
  },
  deleteType(name) {
    const data = read();
    const idx = data.types.indexOf(name);
    if (idx === -1) return null;
    data.types.splice(idx, 1);
    write(data);
    return data.types;
  },
  // locations helpers
  locations() { return read().locations; },
  addLocation(name, site) {
    const data = read();
    if (!data.locations.find(l => l.name === name)) data.locations.push({ name, site: site || 'default' });
    write(data);
    return data.locations;
  },
  deleteLocation(name) {
    const data = read();
    const idx = data.locations.findIndex(l => l.name === name);
    if (idx === -1) return null;
    data.locations.splice(idx, 1);
    write(data);
    return data.locations;
  },
  reorderLocations(newOrder) {
    const data = read();
    // newOrder is array of names in desired order
    const map = new Map(data.locations.map(l => [l.name, l]));
    data.locations = newOrder.map(n => map.get(n)).filter(Boolean);
    write(data);
    return data.locations;
  },
  updateLocation(name, patch) {
    const data = read();
    const idx = data.locations.findIndex(l => l.name === name);
    if (idx === -1) return null;
    data.locations[idx] = { ...data.locations[idx], ...patch };
    write(data);
    return data.locations[idx];
  }
};
