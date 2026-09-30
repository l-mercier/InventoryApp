const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const db = require('./db');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const session = require('express-session');
const sharp = require('sharp');

// Same DATA_DIR convention as db.js — in production this points at a mounted persistent
// disk so uploaded photos survive redeploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// Buffered in memory (photos are capped at 5MB below) rather than written to disk as-is,
// since every upload is re-encoded by sharp before it's saved — see the route handler.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => cb(null, ALLOWED_PHOTO_TYPES.has(file.mimetype)),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Item photos are snapshots of physical gear, not graphics needing transparency, so every
// format is flattened to a resized JPEG — except GIF, passed through untouched since it may
// be animated and sharp would collapse it to a single frame.
async function saveItemPhoto(id, file) {
  // clear out any previous photo for this id first — a re-upload can change format/extension
  // (e.g. a prior .gif replaced by a new JPEG-encoded photo), which would otherwise leave an
  // orphaned file behind since the filename is no longer a fixed `${id}${ext}`.
  for (const existing of fs.readdirSync(UPLOADS_DIR)) {
    if (existing.startsWith(`${id}.`)) fs.unlinkSync(path.join(UPLOADS_DIR, existing));
  }
  if (file.mimetype === 'image/gif') {
    const filename = `${id}.gif`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
    return filename;
  }
  const filename = `${id}.jpg`;
  const resized = await sharp(file.buffer)
    .rotate() // apply EXIF orientation before stripping metadata
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), resized);
  return filename;
}

const TYPE_PRESETS = [
  'wire roll',
  'cable',
  'speaker',
  'microphone',
  'computer/micro-controller',
  'electronics',
  'instrument',
  'diverse'
];

const PROJECT_PRESETS = [
  'general',
  'Fish String Theory',
  '333 Hz',
  'Conversation Metabolite',
  'Fish Heart'
];

// "Outside" is a reserved pseudo-project representing personal use — it must only be
// reachable through the Move endpoint (which captures who has it), never typed in
// directly, or the borrower-traceability guarantee silently breaks.
const OUTSIDE_PROJECT = 'Outside';
function isReservedProjectName(name) {
  return typeof name === 'string' && name.trim().toLowerCase() === OUTSIDE_PROJECT.toLowerCase();
}

// A shared password gates the whole app for the team. If APP_PASSWORD isn't set (e.g. local
// dev), the login wall is skipped entirely so the app behaves exactly as before.
const APP_PASSWORD = process.env.APP_PASSWORD || null;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
if (!APP_PASSWORD) {
  console.warn('APP_PASSWORD not set — running without a login wall (fine for local dev, not for a shared/public deployment).');
}

const app = express();
app.set('trust proxy', 1); // required for secure cookies behind a TLS-terminating proxy (Render, etc.)
app.use(cors());
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

app.get('/login', (req, res) => {
  if (!APP_PASSWORD || req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (!APP_PASSWORD || req.body.password === APP_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.use((req, res, next) => {
  if (!APP_PASSWORD || req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
});

// no-cache (not no-store): browsers/Cloudflare still keep a local copy but must
// revalidate with the server on every request (a cheap 304 when unchanged), instead of
// serving a stale cached file for hours after a deploy — Cloudflare's default edge cache
// TTL for static extensions is 4h absent an explicit Cache-Control from the origin.
const staticOpts = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
app.use(express.static(path.join(__dirname, 'public'), staticOpts));
app.use('/uploads', express.static(UPLOADS_DIR, staticOpts));

// respond to favicon requests to avoid noisy 404s when no favicon is present
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/types', (req, res) => {
  const itemTypes = Array.from(new Set(db.all().map((item) => String(item.type || '').trim()).filter(Boolean)));
  const types = Array.from(new Set([...TYPE_PRESETS, ...db.types(), ...itemTypes]));
  res.json(types);
});

// The custom (user-added) types only — used by the manage-types UI to decide which
// entries can show a delete button (built-in presets and types only present because an
// item currently uses them are not deletable here).
app.get('/api/types/custom', (req, res) => {
  res.json(db.types());
});

app.post('/api/types', (req, res) => {
  const { name } = req.body || {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'Name required' });
  const list = db.addType(trimmed);
  res.status(201).json(list);
});

app.post('/api/types/delete', (req, res) => {
  const { name } = req.body || {};
  const list = db.deleteType(name);
  if (list === null) return res.status(404).json({ error: 'Not a custom type' });
  res.json(list);
});

app.get('/api/locations', (req, res) => {
  res.json(db.locations());
});

app.post('/api/locations', (req, res) => {
  const { name, site } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const list = db.addLocation(name, site);
  res.status(201).json(list);
});

app.post('/api/locations/delete', (req, res) => {
  const { name } = req.body || {};
  const list = db.deleteLocation(name);
  if (list === null) return res.status(404).json({ error: 'Not found' });
  res.json(list);
});

app.post('/api/locations/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  const updated = db.reorderLocations(order);
  res.json(updated);
});

app.get('/api/viz/:project', (req, res) => {
  res.json(db.getVizData(req.params.project));
});

app.put('/api/viz/:project', (req, res) => {
  const { layout, connections, splits, legend } = req.body || {};
  const saved = db.saveVizData(req.params.project, { layout, connections, splits, legend });
  res.json(saved);
});

app.get('/api/projects', (req, res) => {
  const itemProjects = Array.from(new Set(db.all().map((item) => String(item.project || '').trim()).filter(Boolean)));
  const projects = Array.from(new Set([...PROJECT_PRESETS, ...db.projects(), ...itemProjects]));
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const { name } = req.body || {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'Name required' });
  if (isReservedProjectName(trimmed)) return res.status(400).json({ error: '"Outside" is reserved' });
  const list = db.addProject(trimmed);
  res.status(201).json(list);
});

function toNumberOr(defaultValue, value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function normalizeItemInput(input) {
  const amount = Math.max(0, toNumberOr(0, input.amount));
  const needed = Math.max(0, toNumberOr(amount, input.needed));
  return {
    id: input.id || nanoid(8),
    name: input.name || 'Unnamed',
    storagePlace: input.storagePlace || 'general',
    amount,
    needed,
    comments: input.comments || '',
    type: input.type || 'unknown',
    project: input.project || 'general',
    photo: input.photo || null
  };
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

function parseBatchCsv(csvText) {
  const lines = String(csvText || '').replace(/\r\n?/g, '\n').split('\n');
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (!nonEmpty.length) return { project: '', rows: [] };
  const project = parseCsvLine(nonEmpty[0])[0] || 'general';
  const rows = [];
  for (let i = 1; i < nonEmpty.length; i += 1) {
    const cols = parseCsvLine(nonEmpty[i]);
    if (!cols[0]) continue;
    const first = cols[0].toLowerCase();
    if (first === 'item name' || first === 'name' || first === 'project name') continue;
    const itemName = cols[0];
    const amount = toNumberOr(0, cols[1]);
    const needed = toNumberOr(amount, cols[2]);
    const comments = cols.slice(3).join(',').trim();
    rows.push({ itemName, amount, needed, comments });
  }
  return { project, rows };
}

app.get('/api/items', (req, res) => {
  const items = db.all();
  res.json(items);
});

app.post('/api/items', (req, res) => {
  if (isReservedProjectName((req.body || {}).project)) {
    return res.status(400).json({ error: 'Use "Move item" to send stock Outside' });
  }
  const item = normalizeItemInput(req.body || {});
  db.add(item);
  res.status(201).json(item);
});

app.post('/api/items/import-csv', (req, res) => {
  const { csvText } = req.body || {};
  if (!csvText || typeof csvText !== 'string') {
    return res.status(400).json({ error: 'csvText is required' });
  }
  const parsed = parseBatchCsv(csvText);
  if (!parsed.rows.length) return res.status(400).json({ error: 'No item rows found in CSV' });
  if (isReservedProjectName(parsed.project)) {
    return res.status(400).json({ error: 'Use "Move item" to send stock Outside' });
  }

  const created = [];
  for (const row of parsed.rows) {
    const item = normalizeItemInput({
      name: row.itemName,
      project: parsed.project,
      amount: row.amount,
      needed: row.needed,
      comments: row.comments,
      storagePlace: 'general',
      type: 'unknown'
    });
    created.push(db.add(item));
  }

  res.status(201).json({ project: parsed.project, createdCount: created.length, items: created });
});

app.put('/api/items/:id', (req, res) => {
  const id = req.params.id;
  if (isReservedProjectName((req.body || {}).project)) {
    return res.status(400).json({ error: 'Use "Move item" to send stock Outside' });
  }
  const updated = db.update(id, req.body);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

app.post('/api/items/:id/photo',
  upload.single('photo'),
  async (req, res) => {
    const id = req.params.id;
    const item = db.get(id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No valid photo uploaded (allowed: JPEG, PNG, WEBP, GIF, max 5MB)' });
    let filename;
    try {
      filename = await saveItemPhoto(id, req.file);
    } catch (err) {
      return res.status(400).json({ error: 'Could not process this image' });
    }
    const updated = db.update(id, { photo: `/uploads/${filename}` });
    res.json(updated);
  },
  (err, req, res, next) => {
    // multer errors (e.g. file too large) — return a friendly 400 instead of a 500
    res.status(400).json({ error: err.message || 'Upload failed' });
  }
);

app.delete('/api/items/:id', (req, res) => {
  const id = req.params.id;
  const removed = db.delete(id);
  if (!removed) return res.status(404).json({ error: 'Not found' });
  res.json(removed);
});

// Support environments where DELETE may be blocked (some proxies or clients).
// Provide a POST-based delete endpoint as a fallback.
app.post('/api/items/:id/delete', (req, res) => {
  const id = req.params.id;
  const removed = db.delete(id);
  if (!removed) return res.status(404).json({ error: 'Not found' });
  res.json(removed);
});

// Unified movement endpoint — replaces the old borrow/return/transfer/loan-creation routes.
// Moves `amount` units of an item to `project` (a real project name, or the reserved
// "Outside" pseudo-project for personal use). If a same-name+type record already exists at
// the destination, merges into it instead of spawning a duplicate row; otherwise renames
// the record in place (full move) or splits off a new record (partial move). Moving to
// Outside requires a borrower name and logs an audit entry via db.addLoan.
app.post('/api/items/:id/move', (req, res) => {
  const id = req.params.id;
  const { amount, project, borrower, expectedReturn, notes } = req.body || {};
  const targetProject = typeof project === 'string' ? project.trim() : '';
  const moveAmount = Number(amount);

  if (!targetProject) return res.status(400).json({ error: 'Destination required' });
  if (!Number.isFinite(moveAmount) || moveAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero' });
  }

  const item = db.get(id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (targetProject === item.project) {
    return res.status(400).json({ error: 'Item is already in that project' });
  }

  const currentAmount = Number(item.amount) || 0;
  if (moveAmount > currentAmount) {
    return res.status(400).json({ error: 'Not enough stock to move' });
  }

  const isOutside = targetProject === OUTSIDE_PROJECT;
  const borrowerName = typeof borrower === 'string' ? borrower.trim() : '';
  if (isOutside && !borrowerName) {
    return res.status(400).json({ error: 'Borrower name required' });
  }

  const fullMove = moveAmount === currentAmount;
  // an existing record for the same item already at the destination — merge into it
  // instead of spawning a duplicate row. Matched on name+type; storagePlace is
  // deliberately excluded (shelf location, not item identity).
  const destMatch = db.all().find((i) =>
    i.id !== id && i.project === targetProject && i.name === item.name && i.type === item.type
  );

  let kind, result, sourceDeleted = false;

  if (destMatch) {
    kind = 'merge';
    result = db.update(destMatch.id, { amount: (Number(destMatch.amount) || 0) + moveAmount });
    if (fullMove) {
      db.delete(id);
      sourceDeleted = true;
    } else {
      db.update(id, { amount: currentAmount - moveAmount });
    }
  } else if (fullMove) {
    kind = 'rename';
    result = db.update(id, { project: targetProject });
  } else {
    kind = 'split';
    db.update(id, { amount: currentAmount - moveAmount });
    result = db.add({
      id: nanoid(8),
      name: item.name,
      storagePlace: item.storagePlace,
      amount: moveAmount,
      needed: moveAmount,
      comments: item.comments || '',
      type: item.type,
      project: targetProject,
      photo: item.photo || null,
      splitFrom: id,
      splitAmount: moveAmount
    });
  }

  if (isOutside) {
    db.addLoan({
      id: nanoid(8),
      itemId: result.id,
      itemName: item.name,
      borrower: borrowerName,
      quantity: moveAmount,
      loanedAt: new Date().toISOString(),
      expectedReturn: expectedReturn || null,
      returnedAt: null,
      notes: notes || ''
    });
  }

  res.json({ kind, result, sourceDeleted });
});

app.get('/api/loans', (req, res) => {
  res.json(db.loans());
});

app.post('/api/loans/:id/return', (req, res) => {
  const loan = db.loans().find((l) => l.id === req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  if (loan.returnedAt) return res.status(400).json({ error: 'Loan already returned' });
  const updatedLoan = db.returnLoan(req.params.id, { returnedAt: new Date().toISOString() });
  res.json({ loan: updatedLoan });
});

function startServer(port) {
  const server = app.listen(port, () => console.log('Server running on', port));

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is in use, trying ${nextPort}`);
      startServer(nextPort);
      return;
    }

    throw error;
  });
}

startServer(Number(process.env.PORT) || 3000);
