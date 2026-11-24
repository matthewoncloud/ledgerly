import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { transaction } from './db.js';

/*
 * Validation and storage for a user's ledger: businesses, vehicles, entries (transactions) and
 * settings. Every query here is scoped by user_id.
 */

export const DATA_VERSION = 4;
export const ENTRY_TYPES = ['income', 'expense', 'mileage', 'percent'];
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric'];
export const MILEAGE_CATEGORY = 'Motor vehicle (km rates)';
export const FALLBACK_CATEGORY = 'Other expenses';
const GENERAL_CATEGORIES = ['Equipment', 'Software & subscriptions', 'Phone & internet', 'Advertising & marketing', 'Travel', 'Bank & card fees', 'Other expenses'];

export const LIMITS = { businesses: 100, vehicles: 50, entries: 200_000, categories: 200 };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

export const newId = () => crypto.randomBytes(9).toString('base64url');
const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const bad = (msg) => { throw new HttpError(400, msg); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function str(v, max, label, { required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') bad(`${label} must be text.`);
  const s = String(v).trim().slice(0, max);
  if (required && !s) bad(`${label} is required.`);
  return s;
}

function amount(v, label, { max = 1e12 } = {}) {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) bad(`${label} must be a number between 0 and ${max.toLocaleString('en')}.`);
  return n;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function id(v, label = 'id') {
  if (typeof v !== 'string' || !ID_RE.test(v)) bad(`${label} is missing or invalid.`);
  return v;
}

function isoDate(v) {
  const m = typeof v === 'string' && DATE_RE.exec(v);
  if (!m) bad('Date must be in YYYY-MM-DD format.');
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) bad('That date does not exist.');
  return v;
}

export function cleanCategories(list) {
  if (list !== undefined && !Array.isArray(list)) bad('Categories must be a list.');
  const out = [];
  for (const raw of list || []) {
    if (typeof raw !== 'string') continue;
    const c = raw.trim().slice(0, 40);
    if (c && !sameText(c, MILEAGE_CATEGORY) && !out.some((x) => sameText(x, c))) out.push(c);
    if (out.length >= LIMITS.categories) break;
  }
  return out.length ? out : [FALLBACK_CATEGORY];
}

// ---------- Validation ----------

export function validateBusiness(input, { requireId = true } = {}) {
  if (!isObj(input)) bad('Business details are missing.');
  return {
    id: requireId ? id(input.id, 'Business id') : (input.id ? id(input.id, 'Business id') : newId()),
    name: str(input.name, 40, 'Business name', { required: true }),
    color: COLOR_RE.test(input.color) ? input.color.toLowerCase() : '#4338ca',
    categories: cleanCategories(input.categories),
  };
}

export function validateVehicle(input, { requireId = true } = {}) {
  if (!isObj(input)) bad('Vehicle details are missing.');
  const pct = amount(input.businessPct ?? 100, 'Business use', { max: 100 });
  return {
    id: requireId ? id(input.id, 'Vehicle id') : (input.id ? id(input.id, 'Vehicle id') : newId()),
    name: str(input.name, 40, 'Vehicle name') || 'My car',
    fuel: FUEL_TYPES.includes(input.fuel) ? input.fuel : bad('Fuel type must be petrol, diesel, hybrid or electric.'),
    businessPct: Math.min(100, Math.max(1, pct || 100)),
  };
}

export function validateEntry(input) {
  if (!isObj(input)) bad('Transaction details are missing.');
  const type = ENTRY_TYPES.includes(input.type) ? input.type : bad('Transaction type is invalid.');
  const e = {
    id: id(input.id, 'Transaction id'),
    businessId: id(input.businessId, 'Business'),
    type,
    date: isoDate(input.date),
    name: str(input.name, 80, 'Description'),
    category: str(input.category, 40, 'Category'),
    note: str(input.note, 200, 'Note'),
    amount: null, km: null, vehicleId: null, bill: null, percent: null,
    createdAt: Number.isSafeInteger(input.createdAt) && input.createdAt > 0 ? input.createdAt : null,
  };
  if (type === 'income' || type === 'expense') e.amount = round2(amount(input.amount, 'Amount'));
  if (type === 'mileage') {
    e.km = amount(input.km, 'Kilometres', { max: 1e7 });
    e.vehicleId = id(input.vehicleId, 'Vehicle');
    e.category = MILEAGE_CATEGORY;
  }
  if (type === 'percent') {
    e.bill = round2(amount(input.bill, 'Bill amount'));
    e.percent = amount(input.percent, 'Work percentage', { max: 100 });
  }
  if (!e.category) e.category = type === 'income' ? 'Payments' : FALLBACK_CATEGORY;
  return e;
}

// Settings are interface preferences. Unknown keys are dropped; the browser fills in defaults.
const SETTING_TYPES = {
  ownerName: 'string', currency: 'string', taxRate: 'number', taxYearStart: 'string', theme: 'string',
  period: 'string', customFrom: 'string', customTo: 'string', business: 'string',
  lastBusinessId: 'nullableString', lastVehicleId: 'nullableString', lastBackup: 'nullableString',
  onboardingDismissed: 'boolean', visitedReports: 'boolean', visitedBusinesses: 'boolean', kmRates: 'kmRates',
};

export function sanitizeSettings(input) {
  if (!isObj(input)) bad('Settings must be an object.');
  const out = {};
  for (const [key, kind] of Object.entries(SETTING_TYPES)) {
    const v = input[key];
    if (v === undefined) continue;
    if (kind === 'string' && typeof v === 'string') out[key] = v.slice(0, 100);
    else if (kind === 'nullableString' && (v === null || typeof v === 'string')) out[key] = v === null ? null : v.slice(0, 100);
    else if (kind === 'number' && Number.isFinite(v)) out[key] = v;
    else if (kind === 'boolean' && typeof v === 'boolean') out[key] = v;
    else if (kind === 'kmRates' && isObj(v)) out[key] = sanitizeKmRates(v);
  }
  return out;
}

function sanitizeKmRates(v) {
  const out = {};
  for (const [year, fuels] of Object.entries(v)) {
    if (!/^\d{4}$/.test(year) || !isObj(fuels)) continue;
    const yearRates = {};
    for (const [fuel, pair] of Object.entries(fuels)) {
      if (!FUEL_TYPES.includes(fuel) || !Array.isArray(pair) || pair.length !== 2) continue;
      if (pair.every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) yearRates[fuel] = [pair[0], pair[1]];
    }
    if (Object.keys(yearRates).length) out[year] = yearRates;
  }
  return out;
}

// ---------- Reading ----------

const businessOut = (r) => ({ id: r.id, name: r.name, color: r.color, categories: JSON.parse(r.categories) });
const vehicleOut = (r) => ({ id: r.id, name: r.name, fuel: r.fuel, businessPct: r.business_pct });

function entryOut(r) {
  const e = { id: r.id, businessId: r.business_id, type: r.type, date: r.date, name: r.name, category: r.category, note: r.note, createdAt: r.created_at };
  if (r.type === 'income' || r.type === 'expense') e.amount = r.amount;
  if (r.type === 'mileage') { e.km = r.km; e.vehicleId = r.vehicle_id; }
  if (r.type === 'percent') { e.bill = r.bill; e.percent = r.percent; }
  return e;
}

export function readSettings(db, userId) {
  const row = db.prepare('SELECT data FROM user_settings WHERE user_id = ?').get(userId);
  return row ? JSON.parse(row.data) : {};
}

export function loadLedger(db, userId) {
  return {
    version: DATA_VERSION,
    businesses: db.prepare('SELECT * FROM businesses WHERE user_id = ? ORDER BY position, created_at').all(userId).map(businessOut),
    vehicles: db.prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY position, created_at').all(userId).map(vehicleOut),
    // Insertion order matters: the app keeps same-day transactions in the order they were added.
    entries: db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY created_at, rowid').all(userId).map(entryOut),
    settings: readSettings(db, userId),
  };
}

export const businessExists = (db, userId, bizId) =>
  !!db.prepare('SELECT 1 FROM businesses WHERE user_id = ? AND id = ?').get(userId, bizId);
export const vehicleExists = (db, userId, vehicleId) =>
  !!db.prepare('SELECT 1 FROM vehicles WHERE user_id = ? AND id = ?').get(userId, vehicleId);
export const entryExists = (db, userId, entryId) =>
  !!db.prepare('SELECT 1 FROM entries WHERE user_id = ? AND id = ?').get(userId, entryId);

// ---------- Writing ----------

export function writeSettings(db, userId, settings) {
  db.prepare(`INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(userId, JSON.stringify(settings), Date.now());
}

export function insertBusiness(db, userId, b, position) {
  const now = Date.now();
  const pos = position ?? (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM businesses WHERE user_id = ?').get(userId).p);
  db.prepare('INSERT INTO businesses (user_id, id, name, color, categories, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, b.id, b.name, b.color, JSON.stringify(b.categories), pos, now, now);
}

export function insertVehicle(db, userId, v, position) {
  const now = Date.now();
  const pos = position ?? (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM vehicles WHERE user_id = ?').get(userId).p);
  db.prepare('INSERT INTO vehicles (user_id, id, name, fuel, business_pct, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, v.id, v.name, v.fuel, v.businessPct, pos, now, now);
}

export function insertEntry(db, userId, e, createdAt) {
  const now = Date.now();
  db.prepare(`INSERT INTO entries (user_id, id, business_id, type, date, name, category, amount, km, vehicle_id, bill, percent, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, e.id, e.businessId, e.type, e.date, e.name, e.category, e.amount, e.km, e.vehicleId, e.bill, e.percent, e.note, e.createdAt ?? createdAt ?? now, now);
}

export function updateEntry(db, userId, e) {
  return db.prepare(`UPDATE entries SET business_id = ?, type = ?, date = ?, name = ?, category = ?, amount = ?, km = ?, vehicle_id = ?,
      bill = ?, percent = ?, note = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
    .run(e.businessId, e.type, e.date, e.name, e.category, e.amount, e.km, e.vehicleId, e.bill, e.percent, e.note, Date.now(), userId, e.id).changes;
}

/** Checks that a transaction only points at this user's own business and vehicle. */
export function assertEntryRefs(db, userId, e) {
  if (!businessExists(db, userId, e.businessId)) bad('That business does not exist.');
  if (e.type === 'mileage' && !vehicleExists(db, userId, e.vehicleId)) bad('That vehicle does not exist.');
}

export function insertEntries(db, userId, list) {
  if (!Array.isArray(list)) bad('Transactions must be a list.');
  if (list.length > LIMITS.entries) bad(`You can add at most ${LIMITS.entries.toLocaleString('en')} transactions at once.`);
  const entries = list.map(validateEntry);
  const seen = new Set();
  const bizIds = new Set(db.prepare('SELECT id FROM businesses WHERE user_id = ?').all(userId).map((r) => r.id));
  const vehicleIds = new Set(db.prepare('SELECT id FROM vehicles WHERE user_id = ?').all(userId).map((r) => r.id));
  for (const e of entries) {
    if (seen.has(e.id)) bad('The same transaction appears twice.');
    seen.add(e.id);
    if (!bizIds.has(e.businessId)) bad('A transaction refers to a business that does not exist.');
    if (e.type === 'mileage' && !vehicleIds.has(e.vehicleId)) bad('A mileage trip refers to a vehicle that does not exist.');
  }
  const base = Date.now() - entries.length;
  entries.forEach((e, i) => insertEntry(db, userId, e, base + i));
  return entries.length;
}

/**
 * Saves a business's name, colour and categories. With `renames` (the business editor), existing
 * transactions follow renamed categories and any whose category was removed move to "Other expenses".
 */
export function updateBusiness(db, userId, bizId, input) {
  const b = validateBusiness({ ...input, id: bizId });
  const renames = isObj(input.renames) ? input.renames : null;
  let moved = 0;
  const cats = [...b.categories];
  if (renames) {
    const rows = db.prepare(`SELECT id, category FROM entries WHERE user_id = ? AND business_id = ? AND type IN ('expense', 'percent')`).all(userId, bizId);
    const setCategory = db.prepare('UPDATE entries SET category = ?, updated_at = ? WHERE user_id = ? AND id = ?');
    const now = Date.now();
    for (const r of rows) {
      if (Object.hasOwn(renames, r.category) && typeof renames[r.category] === 'string') {
        const target = cats.find((c) => sameText(c, renames[r.category]));
        if (target) {
          if (target !== r.category) setCategory.run(target, now, userId, r.id);
          continue;
        }
      }
      if (!cats.includes(r.category)) {
        setCategory.run(FALLBACK_CATEGORY, now, userId, r.id);
        moved++;
      }
    }
    if (moved && !cats.includes(FALLBACK_CATEGORY)) cats.push(FALLBACK_CATEGORY);
  }
  const changes = db.prepare('UPDATE businesses SET name = ?, color = ?, categories = ?, updated_at = ? WHERE user_id = ? AND id = ?')
    .run(b.name, b.color, JSON.stringify(cats), Date.now(), userId, bizId).changes;
  if (!changes) throw new HttpError(404, 'That business was not found.');
  return { business: { ...b, categories: cats }, moved };
}

/** Replaces everything a user has (used by restore-from-backup and sample data). */
export function replaceLedger(db, userId, data) {
  if (!isObj(data)) bad('Data must be an object.');
  const { businesses = [], vehicles = [], entries = [] } = data;
  if (!Array.isArray(businesses) || !businesses.length) bad('At least one business is required.');
  if (!Array.isArray(vehicles) || !vehicles.length) bad('At least one vehicle is required.');
  if (businesses.length > LIMITS.businesses) bad(`You can have at most ${LIMITS.businesses} businesses.`);
  if (vehicles.length > LIMITS.vehicles) bad(`You can have at most ${LIMITS.vehicles} vehicles.`);
  const bizList = businesses.map((b) => validateBusiness(b));
  const vehicleList = vehicles.map((v) => validateVehicle(v));
  if (new Set(bizList.map((b) => b.id)).size !== bizList.length) bad('The same business appears twice.');
  if (new Set(vehicleList.map((v) => v.id)).size !== vehicleList.length) bad('The same vehicle appears twice.');
  const settings = data.settings === undefined ? readSettings(db, userId) : sanitizeSettings(data.settings);

  return transaction(db, () => {
    db.prepare('DELETE FROM entries WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM vehicles WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM businesses WHERE user_id = ?').run(userId);
    bizList.forEach((b, i) => insertBusiness(db, userId, b, i));
    vehicleList.forEach((v, i) => insertVehicle(db, userId, v, i));
    const count = insertEntries(db, userId, entries);
    writeSettings(db, userId, settings);
    return { businesses: bizList.length, vehicles: vehicleList.length, entries: count };
  });
}

/** Gives a new account a starting business and vehicle. Call inside a transaction. */
export function seedNewUser(db, userId) {
  insertBusiness(db, userId, { id: newId(), name: 'My business', color: '#4338ca', categories: GENERAL_CATEGORIES }, 0);
  insertVehicle(db, userId, { id: newId(), name: 'My car', fuel: 'petrol', businessPct: 100 }, 0);
  writeSettings(db, userId, {});
}
