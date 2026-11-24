// Ledgerly web app. All data lives on the server (see /server); this file renders it and sends
// each change to the API. Changes are applied to the screen straight away and saved in the
// background, in order. If a save fails, the latest data is reloaded from the server.

const DATA_VERSION = 4;
const THEME_KEY = 'ledgerly.theme'; // cached in the browser only so the right theme shows before data loads
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Earnings categories are shared by every business; expense categories belong to each business.
const EARNINGS_CATEGORIES = ['Payments', 'Tips & bonuses', 'Refunds', 'Other earnings'];
const LEGACY_EARNINGS = { 'Earnings': 'Payments', 'Other income': 'Other earnings' };
const MILEAGE_CATEGORY = 'Motor vehicle (km rates)';
// Inland Revenue (NZ) kilometre rates per km, keyed by the year the income year starts (1 April).
// Tier 1: business share of the first 14,000 km a vehicle travels in the income year (fixed + running costs).
// Tier 2: business share of any travel beyond 14,000 km (running costs only).
// Source: IRD kilometre rates pages and operational statements OS 19/04 (KM 2023 – KM 2026).
const IRD_URL = 'https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/types-of-business-expenses/claiming-vehicle-expenses/kilometre-rates-2025-2026';
const TIER1_KM = 14000;
const FUEL_TYPES = { petrol: 'Petrol', diesel: 'Diesel', hybrid: 'Petrol hybrid', electric: 'Electric' };
const IRD_RATES = {
  2022: { petrol: [0.95, 0.34], diesel: [0.95, 0.34], hybrid: [0.95, 0.20], electric: [0.95, 0.11] },
  2023: { petrol: [1.04, 0.35], diesel: [1.04, 0.35], hybrid: [1.04, 0.21], electric: [1.04, 0.12] },
  2024: { petrol: [1.17, 0.37], diesel: [1.26, 0.35], hybrid: [0.86, 0.21], electric: [1.08, 0.19] },
  2025: { petrol: [1.20, 0.37], diesel: [1.30, 0.38], hybrid: [0.90, 0.24], electric: [1.22, 0.23] },
};
const IRD_YEARS = Object.keys(IRD_RATES).map(Number).sort((a, b) => a - b);
const FALLBACK_CATEGORY = 'Other expenses';
const TEMPLATES = {
  general: { label: 'Any kind of business', cats: ['Equipment', 'Software & subscriptions', 'Phone & internet', 'Advertising & marketing', 'Travel', 'Bank & card fees', 'Other expenses'] },
  rideshare: { label: 'Ride share & delivery', cats: ['Insurance', 'Phone & internet', 'Software & subscriptions', 'Fuel', 'Vehicle repairs & servicing', 'Parking & tolls', 'Licences & fees', 'Cleaning & supplies', 'Bank & card fees', 'Other expenses'] },
  youtube: { label: 'YouTube & content creation', cats: ['Equipment', 'Software & subscriptions', 'Music & stock footage', 'Editing & freelancers', 'Advertising & promotion', 'Props & supplies', 'Phone & internet', 'Travel', 'Other expenses'] },
  freelance: { label: 'Freelance & online work', cats: ['Software & subscriptions', 'Equipment', 'Phone & internet', 'Platform fees', 'Training & courses', 'Advertising & marketing', 'Bank & card fees', 'Other expenses'] },
};
const BUSINESS_COLORS = ['#0e9384', '#e11d48', '#7a5af8', '#4338ca', '#15803d', '#ca8504', '#c11574', '#475467'];
// Description keywords → likely expense categories (the first one the business has wins).
const CATEGORY_RULES = [
  [/insur/, ['Insurance']],
  [/\bphone|mobile|moblie|internet|broadband|\bsim\b|wi-?fi/, ['Phone & internet']],
  [/logmate|software|subscri|\bapp\b|adobe|canva|notion|spotify|netflix|icloud|google|dropbox|microsoft|zoom|hosting|domain/, ['Software & subscriptions']],
  [/fuel|petrol|diesel|charging/, ['Fuel']],
  [/repair|servic|\bmot\b|\bwof\b|tyre|tire|garage/, ['Vehicle repairs & servicing']],
  [/park|toll|congestion|ulez/, ['Parking & tolls']],
  [/camera|\bmic\b|microphone|laptop|computer|monitor|\blens|lighting|tripod|keyboard|headphone|ipad|tablet|desk|chair/, ['Equipment']],
  [/music|stock|footage|epidemic|artlist|envato/, ['Music & stock footage']],
  [/editor|editing|thumbnail|freelancer|designer|\bva\b/, ['Editing & freelancers']],
  [/advert|\bads?\b|promot|marketing|boost/, ['Advertising & promotion', 'Advertising & marketing']],
  [/upwork|fiverr|platform fee|commission/, ['Platform fees']],
  [/course|training|udemy|coaching|\bbook/, ['Training & courses']],
  [/travel|train|flight|hotel|taxi|\bbus\b/, ['Travel']],
  [/licen|badge|permit|\brego\b|registration|\bruc\b|road user/, ['Licences & fees']],
  [/clean|wash/, ['Cleaning & supplies']],
  [/prop|costume|supplies/, ['Props & supplies', 'Cleaning & supplies']],
  [/bank|card fee|stripe|paypal|\bfees?\b/, ['Bank & card fees', 'Platform fees', 'Licences & fees']],
];

const TYPE_LABEL = { income: 'Earnings', expense: 'Expense', mileage: 'Mileage', percent: 'Shared bill' };
const TYPE_ICON = { income: 'in', expense: 'out', mileage: 'car', percent: 'percent' };

const DEFAULT_SETTINGS = {
  ownerName: '',
  currency: '$',
  kmRates: {},           // your own kilometre rates, by income year and fuel type
  lastVehicleId: null,
  taxRate: 20,
  taxYearStart: '04-01',
  theme: 'system',
  period: 'tax-this',
  customFrom: '',
  customTo: '',
  business: 'all',
  lastBusinessId: null,
  onboardingDismissed: false,
  visitedReports: false,
  visitedBusinesses: false,
  lastBackup: null,
};

const state = {
  user: null,
  loaded: false,
  businesses: [],
  vehicles: [],
  entries: [],
  settings: { ...DEFAULT_SETTINGS },
  route: 'dashboard',
  tx: { q: '', kind: 'all', category: 'all', sort: 'desc' },
  chartView: 'chart',
  rateYear: null,
};

// ---------- Helpers ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fromDate = (dt) => ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
const todayStr = () => fromDate(new Date());
const addDays = (s, n) => { const dt = toDate(s); dt.setDate(dt.getDate() + n); return fromDate(dt); };
const monthKey = (s) => s.slice(0, 7);
const fmtDate = (s) => toDate(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const monthName = (key, style = 'long') => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: style, year: 'numeric' });
};
const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const plural = (n, word, many = word + 's') => `${n.toLocaleString('en-GB')} ${n === 1 ? word : many}`;
const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function money(n, { sign = false } = {}) {
  const body = state.settings.currency + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n < 0) return '−' + body;
  return sign && n > 0 ? '+' + body : body;
}
function compactMoney(v) {
  const c = state.settings.currency;
  if (v >= 1000) return c + (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'K';
  return c + Math.round(v);
}
const fmtKm = (n) => n.toLocaleString('en-GB', { maximumFractionDigits: 1 });

// ---------- Businesses ----------
const bizById = (id) => state.businesses.find((b) => b.id === id);
const bizName = (id) => bizById(id)?.name || 'Unknown business';
const initials = (name) => (name.trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('') || '?').toUpperCase();
const avatar = (b, size = '') => `<span class="avatar ${size}" style="--c:${b.color}" aria-hidden="true">${esc(initials(b.name))}</span>`;
const allAvatar = (size = '') => `<span class="avatar ${size}" style="--c:#334155" aria-hidden="true"><svg class="i" style="width:12px;height:12px"><use href="#i-layers"/></svg></span>`;
const selectedBiz = () => (state.settings.business === 'all' ? null : bizById(state.settings.business));
const nextColor = () => BUSINESS_COLORS.find((c) => !state.businesses.some((b) => b.color === c)) || BUSINESS_COLORS[state.businesses.length % BUSINESS_COLORS.length];

function defaultBusinesses() {
  const make = (name, color, template) => ({ id: uid(), name, color, categories: [...TEMPLATES[template].cats] });
  return [make('Ride Share', '#0e9384', 'rideshare'), make('YouTube', '#e11d48', 'youtube'), make('Online Freelance', '#7a5af8', 'freelance')];
}
function cleanCategories(list) {
  const out = [];
  for (const raw of list || []) {
    const c = String(raw || '').trim().slice(0, 40);
    if (c && c !== MILEAGE_CATEGORY && !out.some((x) => sameText(x, c))) out.push(c);
  }
  return out.length ? out : [FALLBACK_CATEGORY];
}
function normalizeBusiness(b, i) {
  if (!b || !String(b.name || '').trim()) return null;
  return {
    id: String(b.id || uid()),
    name: String(b.name).trim().slice(0, 40),
    color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : BUSINESS_COLORS[i % BUSINESS_COLORS.length],
    categories: cleanCategories(b.categories),
  };
}

// ---------- Vehicles & IRD kilometre rates ----------
const vehicleById = (id) => state.vehicles.find((v) => v.id === id);
const newVehicle = (name = 'My car', fuel = 'hybrid') => ({ id: uid(), name, fuel, businessPct: 100 });
function normalizeVehicle(v) {
  if (!v) return null;
  return {
    id: String(v.id || uid()),
    name: String(v.name || '').trim().slice(0, 40) || 'My car',
    fuel: FUEL_TYPES[v.fuel] ? v.fuel : 'petrol',
    businessPct: Math.min(100, Math.max(1, num(v.businessPct) || 100)),
  };
}
// NZ income year (1 April – 31 March), named by the year it starts in. Tiers reset each income year.
const incomeYearOf = (date) => { const y = +date.slice(0, 4); return date.slice(5) >= '04-01' ? y : y - 1; };
const incomeYearName = (y) => `${y}–${String(y + 1).slice(2)}`;
const provisionalBase = (year) => IRD_YEARS.filter((y) => y < year).pop() ?? IRD_YEARS[0];
// Rates for an income year and fuel type: your own figures, IRD's published rates, or — because IRD
// only publishes a year's rates after it ends — the latest published year as a provisional estimate.
function ratesFor(year, fuel) {
  const own = state.settings.kmRates?.[year]?.[fuel];
  if (own) return { t1: own[0], t2: own[1], source: 'custom', year };
  const base = IRD_RATES[year] ? year : provisionalBase(year);
  const [t1, t2] = IRD_RATES[base][fuel];
  return { t1, t2, source: base === year ? 'ird' : 'provisional', year, basedOn: base };
}
// Business km that get Tier 1: the business share of the first 14,000 km (e.g. 60% use → 8,400 km).
const tier1Cap = (v) => TIER1_KM * v.businessPct / 100;
function splitTiers(priorKm, km, v) {
  const t1 = Math.max(0, Math.min(km, tier1Cap(v) - priorKm));
  return { t1, t2: km - t1 };
}
const tierAmount = (split, rates) => round2(split.t1 * rates.t1 + split.t2 * rates.t2);

// Each trip's claim depends on the vehicle's earlier trips that income year, so claims are worked
// out together in date order and cached until the data next changes (see touch() and saveSettings()).
let dataVersion = 0;
let claimCache = null;
function mileageClaims() {
  if (claimCache && claimCache.version === dataVersion && claimCache.count === state.entries.length) return claimCache.map;
  const map = new Map();
  const used = new Map();
  for (const e of byDate(state.entries)) {
    if (e.type !== 'mileage') continue;
    const v = vehicleById(e.vehicleId) || state.vehicles[0];
    const year = incomeYearOf(e.date);
    const key = `${v.id}|${year}`;
    const prior = used.get(key) || 0;
    const split = splitTiers(prior, e.km, v);
    const rates = ratesFor(year, v.fuel);
    used.set(key, prior + e.km);
    map.set(e.id, { ...split, rates, vehicle: v, year, amount: tierAmount(split, rates) });
  }
  claimCache = { version: dataVersion, count: state.entries.length, map };
  return map;
}
const claimFor = (e) => mileageClaims().get(e.id);
function tierParts(split, rates) {
  const parts = [];
  if (split.t1 || !split.t2) parts.push(`${fmtKm(split.t1)} km × ${money(rates.t1)} (Tier 1)`);
  if (split.t2) parts.push(`${fmtKm(split.t2)} km × ${money(rates.t2)} (Tier 2)`);
  return parts.join(' + ');
}
function rateSourceLabel(rates) {
  if (rates.source === 'provisional') return `provisional · ${incomeYearName(rates.basedOn)} IRD rates`;
  if (rates.source === 'custom') return `your ${incomeYearName(rates.year)} rates`;
  return `IRD ${incomeYearName(rates.year)} rates`;
}

// ---------- Money maths ----------
const isIncome = (e) => e.type === 'income';
const incomeOf = (e) => (isIncome(e) ? e.amount : 0);
function expenseOf(e) {
  switch (e.type) {
    case 'expense': return e.amount;
    case 'mileage': return claimFor(e)?.amount ?? 0;
    case 'percent': return round2(e.bill * e.percent / 100);
    default: return 0;
  }
}
function totals(list) {
  const t = { income: 0, expense: 0, km: 0, mileageClaim: 0, inCount: 0, outCount: 0 };
  for (const e of list) {
    if (isIncome(e)) { t.income += e.amount; t.inCount++; } else { t.expense += expenseOf(e); t.outCount++; }
    if (e.type === 'mileage') { t.km += e.km; t.mileageClaim += expenseOf(e); }
  }
  t.income = round2(t.income);
  t.expense = round2(t.expense);
  t.mileageClaim = round2(t.mileageClaim);
  t.profit = round2(t.income - t.expense);
  t.count = t.inCount + t.outCount;
  return t;
}
const keptPct = (t) => (t.income > 0 ? Math.max(0, Math.min(100, (t.profit / t.income) * 100)) : 0);
function detailOf(e) {
  if (e.type === 'mileage') {
    const c = claimFor(e);
    return c ? `${c.vehicle.name} · ${tierParts(c, c.rates)}${c.rates.source === 'provisional' ? ' · provisional rate' : ''}` : `${fmtKm(e.km)} km`;
  }
  if (e.type === 'percent') return `${fmtKm(e.percent)}% of ${money(e.bill)}`;
  return '';
}

// ---------- Categories ----------
function categoryPool(type, bizId) {
  if (type === 'income') return EARNINGS_CATEGORIES;
  if (type === 'mileage') return [MILEAGE_CATEGORY];
  return bizById(bizId)?.categories || [FALLBACK_CATEGORY];
}
function guessCategory(type, name, bizId) {
  if (type === 'mileage') return MILEAGE_CATEGORY;
  const n = (name || '').toLowerCase().trim();
  const earning = type === 'income';
  const pool = categoryPool(type, bizId);
  if (n) {
    const prev = [...state.entries].reverse().find((e) =>
      e.businessId === bizId && isIncome(e) === earning && e.type !== 'mileage' && e.name.toLowerCase() === n);
    if (prev && pool.includes(prev.category)) return prev.category;
  }
  if (earning) return /tip|bonus/.test(n) ? 'Tips & bonuses' : /refund/.test(n) ? 'Refunds' : 'Payments';
  if (n) {
    for (const [re, candidates] of CATEGORY_RULES) {
      if (!re.test(n)) continue;
      const hit = candidates.find((c) => pool.includes(c));
      if (hit) return hit;
    }
    // Match the user's own categories by keyword, e.g. "Camera gear" for "New camera".
    const own = pool.find((c) => c !== FALLBACK_CATEGORY &&
      c.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && n.includes(w)));
    if (own) return own;
  }
  return pool.includes(FALLBACK_CATEGORY) ? FALLBACK_CATEGORY : pool[pool.length - 1];
}

// ---------- Server sync ----------
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function api(method, path, body, { keepalive = false } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      keepalive,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Can’t reach the server. Check your connection.', 0);
  }
  if (res.status === 401) {
    location.replace('/login');
    throw new ApiError('Your session has ended. Please sign in again.', 401);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error || `The server returned an error (${res.status}).`, res.status);
  return data;
}

// Saves run one after another so they reach the server in the order they were made.
let saveQueue = Promise.resolve();
let pendingSaves = 0;
let syncState = 'saved'; // saved | saving | error
function setSyncState(s) {
  syncState = s;
  const el = $('#savedNote');
  if (!el) return;
  el.classList.toggle('saving', s === 'saving');
  el.classList.toggle('error', s === 'error');
  el.textContent = `${plural(state.businesses.length, 'business', 'businesses')} · ${{ saved: 'all changes saved', saving: 'saving…', error: 'not saved' }[s]}`;
}
/** Sends one change to the server. Resolves to the response, or null if it failed (already reported). */
function persist(method, path, body) {
  pendingSaves++;
  setSyncState('saving');
  const run = saveQueue.then(() => api(method, path, body));
  saveQueue = run.catch(() => {});
  return run.then(
    (data) => { if (--pendingSaves === 0 && syncState !== 'error') setSyncState('saved'); return data; },
    (err) => { pendingSaves--; reportSaveError(err); return null; },
  );
}
let reloading = null;
function reportSaveError(err) {
  if (err.status === 401) return;
  setSyncState('error');
  showToast(`Couldn’t save: ${err.message}`);
  // Show what the server really has, so the screen never pretends something was saved.
  reloading ??= saveQueue.then(() => reloadData()).catch(() => {}).finally(() => { reloading = null; });
}

// Settings change often (filters, dates…), so they are batched and saved shortly after.
let settingsTimer = null;
function saveSettings() {
  dataVersion++;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(flushSettings, 500);
}
function flushSettings({ keepalive = false } = {}) {
  if (!settingsTimer) return Promise.resolve();
  clearTimeout(settingsTimer);
  settingsTimer = null;
  if (keepalive) return api('PUT', '/settings', state.settings, { keepalive: true }).catch(() => {});
  return persist('PUT', '/settings', state.settings);
}
window.addEventListener('pagehide', () => flushSettings({ keepalive: true }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSettings({ keepalive: true }); });

/** Marks the in-memory data as changed (clears cached mileage claims). */
const touch = () => { dataVersion++; };
const ledgerPayload = () => ({ businesses: state.businesses, vehicles: state.vehicles, entries: state.entries, settings: state.settings });
/** Replaces everything on the server with what is in memory, then reloads it. */
async function replaceAllOnServer() {
  touch();
  const ok = await persist('PUT', '/data', ledgerPayload());
  if (ok) await reloadData().catch(() => {});
  return !!ok;
}

function normalize(e) {
  if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !TYPE_LABEL[e.type]) return null;
  const biz = bizById(e.businessId) || state.businesses[0];
  const out = { id: e.id || uid(), businessId: biz.id, type: e.type, date: e.date, name: String(e.name || '').slice(0, 80) };
  if (Number.isSafeInteger(e.createdAt)) out.createdAt = e.createdAt;
  if (e.type === 'income' || e.type === 'expense') out.amount = round2(num(e.amount));
  if (e.type === 'mileage') { out.km = num(e.km ?? e.miles); out.vehicleId = (vehicleById(e.vehicleId) || state.vehicles[0]).id; }
  if (e.type === 'percent') { out.percent = num(e.percent); out.bill = round2(num(e.bill)); }
  let cat = String(e.category || '').trim().slice(0, 40);
  if (e.type === 'income') {
    cat = LEGACY_EARNINGS[cat] || cat;
    if (!EARNINGS_CATEGORIES.includes(cat)) cat = guessCategory('income', out.name, biz.id);
  } else if (e.type === 'mileage') {
    cat = MILEAGE_CATEGORY;
  } else if (!cat || cat === MILEAGE_CATEGORY) {
    cat = guessCategory(e.type, out.name, biz.id);
  } else {
    const existing = biz.categories.find((c) => sameText(c, cat));
    if (existing) cat = existing; else biz.categories.push(cat); // keep categories found in older data
  }
  out.category = cat;
  out.note = String(e.note || '').slice(0, 200);
  return out;
}
// Loads saved data or a backup. Older data had no businesses, so all of it goes into "Ride Share".
function applyData(data) {
  const obj = Array.isArray(data) ? {} : data;
  const rawEntries = Array.isArray(data) ? data : data.entries || [];
  const settings = { ...DEFAULT_SETTINGS, ...(obj.settings || {}) };
  delete settings.businessName;
  delete settings.mileageRate;
  settings.kmRates = { ...(settings.kmRates || {}) };
  if ((obj.version || 1) < 4) {
    // Earlier versions defaulted to UK settings; kilometre rates follow New Zealand's IRD.
    if (settings.currency === '£') settings.currency = '$';
    if (settings.taxYearStart === '04-06') settings.taxYearStart = '04-01';
  }
  state.settings = settings;
  state.vehicles = (Array.isArray(obj.vehicles) ? obj.vehicles : []).map(normalizeVehicle).filter(Boolean);
  if (!state.vehicles.length) state.vehicles = [newVehicle()];
  state.businesses = (Array.isArray(data.businesses) ? data.businesses : []).map(normalizeBusiness).filter(Boolean);
  const legacy = !state.businesses.length;
  if (legacy) state.businesses = defaultBusinesses();
  state.entries = [];
  state.entries = rawEntries.map((e) => normalize(legacy ? { ...e, businessId: state.businesses[0].id } : e)).filter(Boolean);
  if (settings.business !== 'all' && !bizById(settings.business)) settings.business = 'all';
}
/** Loads the signed-in user's data from the server. */
async function reloadData() {
  const data = await api('GET', '/data');
  const viewPrefs = { business: state.settings.business, period: state.settings.period };
  const unsaved = settingsTimer ? { ...state.settings } : null;
  applyData({ ...data, version: DATA_VERSION });
  // Keep the current screen's filters if only a reload (not the first load), and any settings not yet sent.
  if (state.loaded) Object.assign(state.settings, viewPrefs, unsaved);
  if (state.settings.business !== 'all' && !bizById(state.settings.business)) state.settings.business = 'all';
  touch();
  cacheTheme();
  if (state.loaded) render();
  setSyncState(pendingSaves ? 'saving' : 'saved');
}

// Sample data from the original spreadsheet (April–August 2026), all for the Ride Share business.
function sampleData() {
  const biz = state.businesses.find((b) => b.name === 'Ride Share') || state.businesses[0];
  const out = [];
  let month;
  const d = (day) => ymd(2026, month, day);
  const add = (e) => out.push({ businessId: biz.id, ...e });
  const I = (day, name, amount) => add({ type: 'income', date: d(day), name, amount });
  const E = (day, name, amount) => add({ type: 'expense', date: d(day), name, amount });
  const M = (day, km) => add({ type: 'mileage', date: d(day), name: 'Business mileage', km });
  const P = (day, name, percent, bill) => add({ type: 'percent', date: d(day), name, percent, bill });

  month = 4;
  E(1, 'Logmate', 10.99); E(2, 'Insurance', 30.37); M(5, 218); I(6, 'Uber', 260.67);
  E(9, 'Insurance', 30.37); P(11, 'Mobile bill', 90, 42.5); M(5, 231); I(13, 'Uber', 293.51);
  E(16, 'Insurance', 30.37); I(20, 'Uber', 500.21); E(23, 'Insurance', 30.37);
  I(27, 'Uber', 350.33); E(30, 'Insurance', 30.37);

  month = 5;
  E(1, 'Logmate', 10.99); E(7, 'Insurance', 30.37); P(12, 'Mobile bill', 90, 44); I(12, 'Uber', 615.63);
  E(14, 'Insurance', 30.37); I(18, 'Uber', 513.56); E(21, 'Insurance', 30.37); I(25, 'Bolt', 34.85);
  I(26, 'Uber', 407.67); E(28, 'Insurance', 30.37);

  month = 6;
  E(1, 'Logmate', 10.99); I(1, 'Bolt', 152.66); I(2, 'Uber', 363.17); E(4, 'Insurance', 30.37);
  I(8, 'Bolt', 144.87); I(9, 'Uber', 497.34); P(11, 'Mobile bill', 90, 44); E(11, 'Insurance', 30.37);
  I(15, 'Bolt', 153.77); I(16, 'Uber', 294.09); E(18, 'Insurance', 30.37); I(22, 'Bolt', 8.66);
  I(23, 'Uber', 286.37); E(25, 'Insurance', 30.37); I(29, 'Bolt', 99.75); I(30, 'Uber', 150.92);

  month = 7;
  E(1, 'Logmate', 10.99); E(2, 'Insurance', 30.37); I(6, 'Bolt', 140.73); I(7, 'Uber', 221.63);
  E(9, 'Insurance', 30.37); P(12, 'Mobile bill', 90, 44); I(13, 'Bolt', 101.84); I(14, 'Uber', 344.62);
  E(16, 'Insurance', 30.37); I(20, 'Bolt', 197.05); I(21, 'Uber', 363.13); E(23, 'Insurance', 30.37);
  I(27, 'Bolt', 206.57); I(28, 'Uber', 224.72); E(30, 'Insurance', 30.37);

  month = 8;
  E(1, 'Logmate', 10.99); I(3, 'Bolt', 120.46); I(4, 'Uber', 314.75); E(6, 'Insurance', 30.37);
  I(11, 'Bolt', 118.83); I(11, 'Uber', 419.6); E(12, 'Insurance', 30.37); P(12, 'Mobile bill', 90, 44);

  return out.map(normalize);
}

// ---------- Theme ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = state.settings.theme;
  document.documentElement.dataset.theme = t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t;
}
function cacheTheme() {
  try { localStorage.setItem(THEME_KEY, state.settings.theme); } catch { /* storage disabled */ }
}
darkQuery.addEventListener('change', () => { if (state.settings.theme === 'system') { applyTheme(); render(); } });

// ---------- Periods & scope ----------
function taxYearStartDate(year) {
  const [m, d] = state.settings.taxYearStart.split('-').map(Number);
  return ymd(year, m, d);
}
function taxYearOf(date) {
  const y = +date.slice(0, 4);
  return date >= taxYearStartDate(y) ? y : y - 1;
}
function taxYearRange(y) {
  return { from: taxYearStartDate(y), to: addDays(taxYearStartDate(y + 1), -1) };
}
const taxYearName = (y) => state.settings.taxYearStart === '01-01' ? String(y) : `${y}/${String(y + 1).slice(2)}`;
const endOfMonth = (y, m) => fromDate(new Date(y, m, 0));

function periodOptions() {
  const ty = taxYearOf(todayStr());
  return [
    ['tax-this', `This tax year (${taxYearName(ty)})`],
    ['tax-last', `Last tax year (${taxYearName(ty - 1)})`],
    ['month-this', 'This month'],
    ['month-last', 'Last month'],
    ['last-3', 'Last 3 months'],
    ['all', 'All time'],
    ['custom', 'Custom dates…'],
  ];
}
function periodRange() {
  const t = todayStr();
  const y = +t.slice(0, 4), m = +t.slice(5, 7);
  switch (state.settings.period) {
    case 'tax-this': return taxYearRange(taxYearOf(t));
    case 'tax-last': return taxYearRange(taxYearOf(t) - 1);
    case 'month-this': return { from: ymd(y, m, 1), to: endOfMonth(y, m) };
    case 'month-last': { const dt = new Date(y, m - 2, 1); return { from: fromDate(dt), to: endOfMonth(dt.getFullYear(), dt.getMonth() + 1) }; }
    case 'last-3': return { from: fromDate(new Date(y, m - 3, 1)), to: endOfMonth(y, m) };
    case 'custom': return { from: state.settings.customFrom || null, to: state.settings.customTo || null };
    default: return { from: null, to: null };
  }
}
function periodLabel() {
  const { from, to } = periodRange();
  if (!from && !to) return 'All time';
  if (from && to) return `${fmtDate(from)} – ${fmtDate(to)}`;
  return from ? `From ${fmtDate(from)}` : `Up to ${fmtDate(to)}`;
}
const scopeLabel = () => selectedBiz()?.name || 'All businesses';
// Every transaction in the chosen dates, across all businesses.
function periodEntries() {
  const { from, to } = periodRange();
  return state.entries.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
}
// The chosen dates and the chosen business.
function scopedEntries() {
  const biz = state.settings.business;
  return periodEntries().filter((e) => biz === 'all' || e.businessId === biz);
}
// Oldest first; entries on the same day keep the order they were added.
const byDate = (list) => [...list].sort((a, b) => a.date.localeCompare(b.date));

function monthlyRows(list) {
  const { from, to } = periodRange();
  const keys = list.map((e) => monthKey(e.date)).sort();
  const nowKey = monthKey(todayStr());
  let start = from ? monthKey(from) : keys[0] || nowKey;
  let end = to ? monthKey(to) : keys[keys.length - 1] || nowKey;
  if (end > nowKey) end = keys.length && keys[keys.length - 1] > nowKey ? keys[keys.length - 1] : nowKey;
  if (start > end) start = end;
  const rows = [];
  let [y, m] = start.split('-').map(Number);
  while (rows.length < 240) {
    const key = `${y}-${pad(m)}`;
    rows.push({ key, ...totals(list.filter((e) => monthKey(e.date) === key)) });
    if (key >= end) break;
    if (++m > 12) { m = 1; y++; }
  }
  return rows;
}

// ---------- Router & shell ----------
const ROUTES = {
  dashboard: { title: 'Dashboard', render: viewDashboard },
  transactions: { title: 'Transactions', render: viewTransactions },
  businesses: { title: 'Businesses', render: viewBusinesses },
  reports: { title: 'Reports', render: viewReports },
  settings: { title: 'Settings', render: viewSettings },
};
function readRoute() {
  const r = location.hash.replace(/^#\/?/, '');
  state.route = ROUTES[r] ? r : 'dashboard';
}
window.addEventListener('hashchange', () => { readRoute(); render(); $('#view').focus({ preventScroll: true }); window.scrollTo(0, 0); });

function greeting() {
  const h = new Date().getHours();
  const g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return state.settings.ownerName ? `${g}, ${state.settings.ownerName}` : g;
}

function renderShell() {
  const { route, settings } = state;
  $$('[data-route]').forEach((a) => {
    const on = a.dataset.route === route;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#ownerName').textContent = settings.ownerName || state.user?.username || 'Your workspace';
  $('#userLabel').textContent = settings.ownerName ? state.user?.username || '' : '';
  setSyncState(syncState);
  $('#pageTitle').textContent = route === 'dashboard' ? greeting() : ROUTES[route].title;
  document.title = `${ROUTES[route].title} · Ledgerly`;

  const biz = selectedBiz();
  $('#pageSub').textContent = {
    dashboard: `Here's how ${biz ? biz.name + ' is' : 'your businesses are'} doing · ${periodLabel()}`,
    transactions: `${scopeLabel()} · ${periodLabel()}`,
    reports: `${scopeLabel()} · ${periodLabel()}`,
    businesses: `Earnings and expenses for each business · ${periodLabel()}`,
    settings: 'Manage your preferences and data',
  }[route];

  $('#bizControl').hidden = route === 'settings' || route === 'businesses';
  $('#periodControl').hidden = route === 'settings';
  const bizSel = $('#bizSelect');
  bizSel.innerHTML = `<option value="all">All businesses</option>` +
    state.businesses.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  bizSel.value = settings.business;

  const sel = $('#periodSelect');
  sel.innerHTML = periodOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  sel.value = settings.period;
  $('#customRange').hidden = route === 'settings' || settings.period !== 'custom';
  $('#customFrom').value = settings.customFrom;
  $('#customTo').value = settings.customTo;
  $$('.affix.cur').forEach((el) => { el.textContent = settings.currency; });

  $('#sideBiz').innerHTML = `<h3>Your businesses</h3>` +
    [{ id: 'all', name: 'All businesses' }, ...state.businesses].map((b) => `
      <button type="button" data-action="view-biz" data-biz="${esc(b.id)}" aria-pressed="${settings.business === b.id}">
        ${b.id === 'all' ? allAvatar('sm') : avatar(b, 'sm')}<span>${esc(b.name)}</span>
      </button>`).join('');
}

let chartObserver;
function render() {
  if (!state.loaded) return;
  renderShell();
  if (chartObserver) { chartObserver.disconnect(); chartObserver = null; }
  $('#view').innerHTML = ROUTES[state.route].render();
  if (state.route === 'transactions') renderTxTable();
  if (state.route === 'settings' && state.user?.isAdmin) mountAdmin();
  mountChart();
}

function setBusinessScope(id) {
  state.settings.business = id === 'all' || bizById(id) ? id : 'all';
  state.tx.category = 'all';
  saveSettings();
}
$('#bizSelect').addEventListener('change', (e) => { setBusinessScope(e.target.value); render(); });
$('#periodSelect').addEventListener('change', (e) => {
  state.settings.period = e.target.value;
  if (e.target.value === 'custom' && !state.settings.customFrom) {
    state.settings.customFrom = taxYearRange(taxYearOf(todayStr())).from;
    state.settings.customTo = todayStr();
  }
  saveSettings(); render();
});
['customFrom', 'customTo'].forEach((id) => $('#' + id).addEventListener('change', (e) => {
  state.settings[id] = e.target.value;
  saveSettings(); render();
}));

// ---------- Shared bits ----------
const info = (text) => `<span class="info" tabindex="0" aria-label="${esc(text)}">${icon('info')}<span class="tip" aria-hidden="true">${esc(text)}</span></span>`;

function emptyState({ title, text, actions = '' }) {
  return `<div class="empty"><div class="empty-icon">${icon('wallet')}</div><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="actions">${actions}</div></div>`;
}
const newTxButton = (label = 'Add a transaction', bizId = '', cls = 'btn btn-primary') =>
  `<button class="${cls}" type="button" data-action="new-tx" ${bizId ? `data-biz="${esc(bizId)}"` : ''}>${icon('plus')} ${esc(label)}</button>`;
const allTimeButton = `<button class="btn" type="button" data-action="all-time">Show all time</button>`;

function txIcon(e) {
  return `<span class="tx-icon ${isIncome(e) ? 'in' : 'out'}" title="${TYPE_LABEL[e.type]}">${icon(TYPE_ICON[e.type])}</span>`;
}
function amountCell(e) {
  return isIncome(e)
    ? `<span class="amt in">${money(e.amount, { sign: true })}</span>`
    : `<span class="amt">−${money(expenseOf(e))}</span>`;
}
const showBizColumn = () => state.settings.business === 'all' && state.businesses.length > 1;

function breakdown(items, color, total) {
  if (!items.length) return '<p class="muted" style="margin:0">Nothing recorded in this period yet.</p>';
  return `<ul class="bars">${items.map(([name, value]) => {
    const pct = total > 0 ? (value / total) * 100 : 0;
    return `<li><div class="bar-top"><span class="name">${esc(name)}</span><span class="val">${money(value)}<small>${pct < 1 && pct > 0 ? '<1' : Math.round(pct)}%</small></span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(2)}%;background:var(${color})"></div></div></li>`;
  }).join('')}</ul>`;
}
function groupSum(list, keyFn, valFn, limit) {
  const map = new Map();
  for (const e of list) {
    const k = keyFn(e);
    map.set(k, round2((map.get(k) || 0) + valFn(e)));
  }
  let items = [...map].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (limit && items.length > limit) {
    const rest = round2(items.slice(limit - 1).reduce((s, [, v]) => s + v, 0));
    items = [...items.slice(0, limit - 1), ['Everything else', rest]];
  }
  return items;
}
const sourceName = (e) => e.name.trim() || 'Unnamed';

function keptMeter(t) {
  const kept = keptPct(t);
  return `<div class="meter-track" role="img" aria-label="Kept ${Math.round(kept)}% of earnings after expenses"><div class="meter-fill" style="width:${kept.toFixed(1)}%"></div></div>`;
}

// ---------- Dashboard ----------
function viewDashboard() {
  if (!state.entries.length) {
    return `<div class="card">${emptyState({
      title: 'Welcome to Ledgerly',
      text: 'Keep track of what each of your businesses earns and spends. Start by adding your first payment or expense — it takes a few seconds.',
      actions: newTxButton('Add your first transaction') + '<button class="btn" type="button" data-action="load-sample">Try with sample data</button>',
    })}</div>${businessesSection(periodEntries())}`;
  }

  const biz = selectedBiz();
  const list = scopedEntries();
  const t = totals(list);
  const kept = keptPct(t);
  const taxEstimate = round2(Math.max(0, t.profit) * state.settings.taxRate / 100);
  const recent = byDate(list).reverse().slice(0, 6);
  const showBiz = showBizColumn();

  return `
    ${onboarding()}
    <div class="grid dash-top">
      <section class="card hero" aria-label="Net profit">
        <div class="label">${biz ? `${avatar(biz, 'sm')} ${esc(biz.name)} · net profit` : `${allAvatar('sm')} Combined net profit · all businesses`}
          ${info(biz ? `Earnings minus expenses for ${biz.name}. This is usually the figure you pay tax on.` : 'Earnings minus expenses for all your businesses added together. This is usually the figure you pay tax on.')}</div>
        <div class="hero-value${t.profit < 0 ? ' negative' : ''}">${money(t.profit)}</div>
        <div class="equation"><strong>${money(t.income)}</strong> earnings − <strong>${money(t.expense)}</strong> expenses</div>
        <div class="meter">
          ${keptMeter(t)}
          <div class="meter-text">${t.income > 0
            ? `You kept <strong>${Math.round(kept)}p</strong> of every ${esc(state.settings.currency)}1 you earned after expenses.`
            : 'Add the payments you receive to see how much you keep.'}</div>
        </div>
      </section>
      <div class="tiles">
        ${tile({ label: 'Earnings', value: money(t.income), sub: plural(t.inCount, 'payment'), swatch: '--in',
          tip: 'Everything you were paid, before any expenses are taken off. Also called gross income or turnover.' })}
        ${tile({ label: 'Expenses', value: money(t.expense), sub: plural(t.outCount, 'expense'), swatch: '--out',
          tip: 'Business costs you can take off your earnings, including mileage and the work share of shared bills.' })}
        ${tile({ label: 'Mileage claimed', value: money(t.mileageClaim), sub: `${fmtKm(t.km)} business km`, iconName: 'car',
          tip: 'Business kilometres at Inland Revenue kilometre rates (Tier 1, then Tier 2 after the 14,000 km threshold). Included in Expenses.' })}
        ${tile({ label: 'Put aside for tax', value: money(taxEstimate), sub: `${state.settings.taxRate}% of profit · <a href="#/settings">change</a>`, iconName: 'wallet',
          tip: 'A simple savings guide so tax time is not a surprise. It is an estimate only, not tax advice.' })}
      </div>
    </div>

    ${biz ? '' : businessesSection(periodEntries())}

    <div class="grid dash-row">
      <section class="card">
        <div class="card-head">
          <div><h2>Earnings vs expenses</h2><p>Month by month · ${esc(scopeLabel())}</p></div>
          <div class="segmented" role="group" aria-label="Display as">
            <button type="button" data-action="chart-view" data-view="chart" aria-pressed="${state.chartView === 'chart'}">${icon('chart')}<span class="visually-hidden">Chart</span></button>
            <button type="button" data-action="chart-view" data-view="table" aria-pressed="${state.chartView === 'table'}">${icon('table')}<span class="visually-hidden">Table</span></button>
          </div>
        </div>
        <div class="card-body">
          ${state.chartView === 'chart' ? `
            <div class="legend" style="margin-bottom:10px"><span><i class="swatch" style="background:var(--in)"></i>Earnings</span><span><i class="swatch" style="background:var(--out)"></i>Expenses</span></div>
            <div class="chart" id="monthChart"></div>` : monthlyTable(list)}
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Where your money goes</h2><p>Expenses by category</p></div></div>
        <div class="card-body">${breakdown(groupSum(list.filter((e) => !isIncome(e)), (e) => e.category, expenseOf, 6), '--out', t.expense)}</div>
      </section>
    </div>

    <div class="grid dash-row">
      <section class="card">
        <div class="card-head">
          <div><h2>Recent transactions</h2><p>The latest activity in this period</p></div>
          <a class="btn btn-sm" href="#/transactions">View all ${icon('arrow-right')}</a>
        </div>
        <div class="card-body" style="padding:8px 0 4px">
          ${recent.length ? `<table class="tx recent"><tbody>${recent.map((e) => `
            <tr class="row" data-id="${e.id}" tabindex="0">
              <td><div class="tx-name">${txIcon(e)}<div><strong>${esc(e.name)}</strong>
                <small>${fmtDate(e.date)}${showBiz ? ` · ${esc(bizName(e.businessId))}` : ''} · ${esc(e.category)}</small></div></div></td>
              <td class="r">${amountCell(e)}</td>
            </tr>`).join('')}</tbody></table>`
            : emptyState({
              title: biz ? `Nothing for ${biz.name} yet` : 'Nothing in this period',
              text: biz ? 'Add the first payment or expense for this business.' : 'There are no transactions for the dates you picked.',
              actions: newTxButton('Add a transaction', biz?.id) + (biz ? '' : allTimeButton),
            })}
        </div>
      </section>
      <div class="stack">
        <section class="card">
          <div class="card-head"><div><h2>Who pays you</h2><p>Earnings by payer</p></div></div>
          <div class="card-body">${breakdown(groupSum(list.filter(isIncome), sourceName, incomeOf, 6), '--in', t.income)}</div>
        </section>
        ${tiersCard()}
      </div>
    </div>`;
}

// Progress through the 14,000 km Tier 1 threshold for each vehicle (all businesses share a vehicle's threshold).
// Hidden unless the business (or businesses) being viewed has mileage trips in this income year.
function tiersCard() {
  const { to } = periodRange();
  const year = incomeYearOf(to && to < todayStr() ? to : todayStr());
  const scope = state.settings.business;
  const yearTrips = state.entries.filter((e) => e.type === 'mileage' && incomeYearOf(e.date) === year);
  const scopedTrips = yearTrips.filter((e) => scope === 'all' || e.businessId === scope);
  if (!scopedTrips.length) return '';
  const vehicles = state.vehicles.filter((v) => scopedTrips.some((e) => e.vehicleId === v.id));
  const rows = vehicles.map((v) => {
    // The Tier 1 limit belongs to the vehicle, so progress counts trips from every business.
    const km = yearTrips.filter((e) => e.vehicleId === v.id).reduce((s, e) => s + e.km, 0);
    const mine = scopedTrips.filter((e) => e.vehicleId === v.id);
    const otherKm = km - mine.reduce((s, e) => s + e.km, 0);
    const claim = round2(mine.reduce((s, e) => s + expenseOf(e), 0));
    const cap = tier1Cap(v);
    const t1 = Math.min(km, cap);
    const t2 = Math.max(0, km - cap);
    const r = ratesFor(year, v.fuel);
    const pct = cap > 0 ? (t1 / cap) * 100 : 100;
    return `<li>
      <div class="tier-top"><span class="name">${icon('car')}${esc(v.name)} <span class="pill">${FUEL_TYPES[v.fuel]}</span></span><strong>${money(claim)}</strong></div>
      <div class="tier-track" role="img" aria-label="${esc(`${fmtKm(t1)} of ${fmtKm(cap)} Tier 1 kilometres used`)}"><div class="tier-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="tier-text">${t2
        ? `Tier 1 limit of ${fmtKm(cap)} km reached · ${fmtKm(t2)} km at Tier 2 (${money(r.t2)}/km)`
        : `${fmtKm(t1)} of ${fmtKm(cap)} km at Tier 1 (${money(r.t1)}/km) · ${fmtKm(cap - t1)} km left before Tier 2 (${money(r.t2)}/km)`}${
        scope !== 'all' && otherKm > 0 ? ` · includes ${fmtKm(otherKm)} km from your other businesses` : ''}</div>
    </li>`;
  }).join('');
  const r = ratesFor(year, vehicles[0].fuel);
  return `<section class="card">
    <div class="card-head">
      <div><h2>Kilometre rate tiers ${info('IRD Tier 1 covers the business share of the first 14,000 km a vehicle travels in the income year; Tier 2 (running costs only) covers the rest. Trips from all your businesses count towards the same vehicle limit.')}</h2>
        <p>${incomeYearName(year)} income year · ${esc(rateSourceLabel(r))}</p></div>
      <a class="btn btn-sm" href="#/settings">Vehicles</a>
    </div>
    <div class="card-body"><ul class="tier-list">${rows}</ul></div>
  </section>`;
}

function tile({ label, value, sub, tip, swatch, iconName }) {
  return `<section class="card tile">
    ${iconName ? `<span class="tile-icon">${icon(iconName)}</span>` : ''}
    <div class="label">${swatch ? `<i class="swatch" style="background:var(${swatch})"></i>` : ''}${esc(label)} ${info(tip)}</div>
    <div class="tile-value">${value}</div>
    <div class="tile-sub">${sub}</div>
  </section>`;
}

// Profit for each business, plus the combined total.
function businessesSection(list) {
  const all = totals(list);
  const cards = state.businesses.map((b) => {
    const t = totals(list.filter((e) => e.businessId === b.id));
    return `<article class="biz-card">
      <div class="biz-head">${avatar(b)}<div><h3>${esc(b.name)}</h3><small>${plural(t.count, 'transaction')}</small></div>
        <button class="btn btn-sm btn-ghost" type="button" data-action="view-biz" data-biz="${esc(b.id)}" aria-label="View ${esc(b.name)}">View ${icon('arrow-right')}</button></div>
      <div class="biz-profit${t.profit < 0 ? ' negative' : ''}">${money(t.profit)}<small>${t.profit < 0 ? 'Net loss' : 'Net profit'}</small></div>
      <div class="biz-stats">
        <div><span><i class="swatch" style="background:var(--in)"></i>Earnings</span><strong>${money(t.income)}</strong></div>
        <div><span><i class="swatch" style="background:var(--out)"></i>Expenses</span><strong>${money(t.expense)}</strong></div>
      </div>
      ${t.count ? `<div class="meter">${keptMeter(t)}<div class="meter-text">${t.income > 0 ? `Kept ${Math.round(keptPct(t))}% after expenses` : 'No earnings yet in this period'}</div></div>`
        : `<div class="actions">${newTxButton('Add first transaction', b.id, 'btn btn-sm')}</div>`}
    </article>`;
  }).join('');
  return `<section class="card biz-section" aria-label="Profit by business">
    <div class="card-head">
      <div><h2>Profit by business</h2><p>Each business is tracked separately · ${periodLabel()}</p></div>
      <button class="btn btn-sm" type="button" data-action="add-biz">${icon('plus')} Add business</button>
    </div>
    <div class="biz-grid">${cards}</div>
    <div class="combined">
      <span>All businesses combined</span>
      <span>Earnings <strong>${money(all.income)}</strong></span>
      <span>Expenses <strong>${money(all.expense)}</strong></span>
      <span class="net">Net profit <strong class="${all.profit < 0 ? 'negative' : ''}">${money(all.profit)}</strong></span>
    </div>
  </section>`;
}

function onboarding() {
  if (state.settings.onboardingDismissed) return '';
  const steps = [
    { done: state.entries.some(isIncome), html: '<button type="button" data-action="new-tx" data-type="income">Add some earnings</button>' },
    { done: state.entries.some((e) => !isIncome(e)), html: '<button type="button" data-action="new-tx" data-type="expense">Add an expense</button>' },
    { done: state.settings.visitedBusinesses, html: '<a href="#/businesses">Set up your businesses</a>' },
    { done: state.settings.visitedReports, html: '<a href="#/reports">See your profit &amp; loss</a>' },
    { done: !!state.settings.lastBackup, html: '<button type="button" data-action="backup">Back up your data</button>' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return `<section class="card onboarding" aria-label="Getting started">
    <div><h2>Getting started · ${doneCount} of ${steps.length} done</h2><p>A few quick steps to get the most out of Ledgerly. Everything is saved to your account automatically.</p></div>
    <button class="icon-btn" type="button" data-action="dismiss-onboarding" aria-label="Hide getting started">${icon('x')}</button>
    <ol class="steps">${steps.map((s, i) => `<li class="${s.done ? 'done' : ''}"><span class="step-num">${s.done ? icon('check') : i + 1}</span><span class="step-text">${s.html}</span></li>`).join('')}</ol>
  </section>`;
}

function monthlyTable(list) {
  const rows = monthlyRows(list);
  const t = totals(list);
  return `<div class="table-wrap"><table class="simple">
    <thead><tr><th>Month</th><th>Earnings</th><th>Expenses</th><th>Profit</th><th>Km</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${monthName(r.key)}</td><td>${money(r.income)}</td><td>${money(r.expense)}</td><td>${money(r.profit)}</td><td>${fmtKm(r.km)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td>${money(t.income)}</td><td>${money(t.expense)}</td><td>${money(t.profit)}</td><td>${fmtKm(t.km)}</td></tr></tfoot>
  </table></div>`;
}

// ---------- Chart ----------
function niceScale(maxV) {
  if (maxV <= 0) return { max: 100, step: 25 };
  const raw = maxV / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(maxV / step) * step, step };
}
function barPath(x, y, w, h) {
  if (h <= 0.5) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}

function mountChart() {
  const host = $('#monthChart');
  if (!host) return;
  const rows = monthlyRows(scopedEntries());
  const draw = () => drawChart(host, rows);
  draw();
  let lastWidth = host.clientWidth;
  chartObserver = new ResizeObserver(() => {
    if (Math.abs(host.clientWidth - lastWidth) > 2) { lastWidth = host.clientWidth; draw(); }
  });
  chartObserver.observe(host);
}

function drawChart(host, rows) {
  const W = Math.max(280, host.clientWidth), H = 280;
  const m = { t: 10, r: 4, b: 30, l: 52 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const { max, step } = niceScale(Math.max(0, ...rows.map((r) => Math.max(r.income, r.expense))));
  const y = (v) => m.t + ph - (v / max) * ph;
  const band = pw / rows.length;
  const bw = Math.max(3, Math.min(24, (band * 0.72 - 2) / 2));
  const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(pw / 48))));

  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="group" aria-label="Monthly earnings and expenses">`;
  for (let v = 0; v <= max + 1e-9; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    s += `<line class="${v === 0 ? 'base-line' : 'grid-line'}" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
    s += `<text class="tick" x="${m.l - 10}" y="${yy}" text-anchor="end" dominant-baseline="middle" aria-hidden="true">${esc(compactMoney(v))}</text>`;
  }
  rows.forEach((r, i) => {
    s += `<rect class="band" data-i="${i}" x="${m.l + band * i + 2}" y="${m.t}" width="${Math.max(0, band - 4)}" height="${ph}" rx="6"/>`;
  });
  rows.forEach((r, i) => {
    const cx = m.l + band * i + band / 2;
    const base = y(0);
    s += `<path fill="var(--in)" d="${barPath(cx - 1 - bw, y(r.income), bw, base - y(r.income))}"/>`;
    s += `<path fill="var(--out)" d="${barPath(cx + 1, y(r.expense), bw, base - y(r.expense))}"/>`;
    if (i % every === 0) {
      const showYear = i === 0 || r.key.endsWith('-01');
      const [yr, mo] = r.key.split('-').map(Number);
      const lbl = new Date(yr, mo - 1, 1).toLocaleDateString('en-GB', { month: 'short' }) + (showYear ? ` ${String(yr).slice(2)}` : '');
      s += `<text class="tick" x="${cx}" y="${H - 8}" text-anchor="middle" aria-hidden="true">${esc(lbl)}</text>`;
    }
  });
  // Focusable hit areas (bigger than the bars) so hover and keyboard both get the tooltip.
  rows.forEach((r, i) => {
    s += `<rect class="hit" data-i="${i}" tabindex="0" role="img"
      aria-label="${esc(monthName(r.key))}: earnings ${esc(money(r.income))}, expenses ${esc(money(r.expense))}, profit ${esc(money(r.profit))}"
      x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/>`;
  });
  host.innerHTML = s + '</svg><div class="chart-tip" aria-hidden="true"></div>';

  const tip = $('.chart-tip', host);
  const show = (i) => {
    const r = rows[i];
    $$('.band', host).forEach((b) => b.classList.toggle('active', +b.dataset.i === i));
    tip.innerHTML = `<div class="tip-title">${esc(monthName(r.key))}</div>
      <div class="tip-row"><i class="line-key" style="background:var(--in)"></i><strong>${esc(money(r.income))}</strong><span>Earnings</span></div>
      <div class="tip-row"><i class="line-key" style="background:var(--out)"></i><strong>${esc(money(r.expense))}</strong><span>Expenses</span></div>
      <div class="tip-net"><span>Profit</span><strong>${esc(money(r.profit))}</strong></div>`;
    const scale = host.clientWidth / W;
    const cx = (m.l + band * i + band / 2) * scale;
    const tw = tip.offsetWidth;
    let left = cx + band * scale / 2 + 6;
    if (left + tw > host.clientWidth) left = cx - band * scale / 2 - 6 - tw;
    tip.style.transform = `translate(${Math.max(0, left)}px, ${m.t + 8}px)`;
    tip.classList.add('show');
  };
  const hide = () => { tip.classList.remove('show'); $$('.band', host).forEach((b) => b.classList.remove('active')); };
  $$('.hit', host).forEach((h) => {
    const i = +h.dataset.i;
    h.addEventListener('pointerenter', () => show(i));
    h.addEventListener('focus', () => show(i));
    h.addEventListener('pointerleave', hide);
    h.addEventListener('blur', hide);
  });
}

// ---------- Transactions ----------
function viewTransactions() {
  const scoped = state.settings.business === 'all' ? state.entries : state.entries.filter((e) => e.businessId === state.settings.business);
  const used = [...new Set(scoped.map((e) => e.category))].sort((a, b) => a.localeCompare(b));
  if (state.tx.category !== 'all' && !used.includes(state.tx.category)) state.tx.category = 'all';
  return `<section class="card">
    <div class="filters">
      <div class="search">${icon('search')}<label class="visually-hidden" for="txSearch">Search transactions</label>
        <input class="input" type="search" id="txSearch" placeholder="Search description or note" value="${esc(state.tx.q)}"></div>
      <div class="segmented" role="group" aria-label="Show">
        ${[['all', 'All'], ['in', 'Earnings'], ['out', 'Expenses']].map(([v, l]) =>
          `<button type="button" data-action="tx-kind" data-kind="${v}" aria-pressed="${state.tx.kind === v}">${l}</button>`).join('')}
      </div>
      <label class="visually-hidden" for="txCategory">Category</label>
      <select class="input" id="txCategory">
        <option value="all">All categories</option>
        ${used.map((c) => `<option ${state.tx.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <label class="visually-hidden" for="txSort">Sort</label>
      <select class="input" id="txSort" style="min-width:150px">
        <option value="desc" ${state.tx.sort === 'desc' ? 'selected' : ''}>Newest first</option>
        <option value="asc" ${state.tx.sort === 'asc' ? 'selected' : ''}>Oldest first</option>
      </select>
      <span class="count" id="txCount"></span>
      <button class="btn btn-sm" type="button" data-action="export-csv">${icon('download')} Export</button>
    </div>
    <div id="txTable"></div>
  </section>`;
}

function filteredTx() {
  const q = state.tx.q.trim().toLowerCase();
  let list = scopedEntries().filter((e) =>
    (state.tx.kind === 'all' || (state.tx.kind === 'in') === isIncome(e)) &&
    (state.tx.category === 'all' || e.category === state.tx.category) &&
    (!q || [e.name, e.note, e.category, bizName(e.businessId)].some((s) => s.toLowerCase().includes(q))));
  list = byDate(list);
  return state.tx.sort === 'desc' ? list.reverse() : list;
}

function renderTxTable(flashId) {
  const host = $('#txTable');
  if (!host) return;
  const list = filteredTx();
  const biz = selectedBiz();
  const showBiz = showBizColumn();
  const cols = showBiz ? 7 : 6;
  const filtersOn = state.tx.q || state.tx.kind !== 'all' || state.tx.category !== 'all';
  $('#txCount').textContent = plural(list.length, 'transaction');

  if (!list.length) {
    host.innerHTML = state.entries.length === 0
      ? emptyState({ title: 'No transactions yet', text: 'Add earnings or an expense and it will show up here.', actions: newTxButton() })
      : filtersOn
        ? emptyState({ title: 'No matches', text: 'Nothing matches your search or filters. Try clearing them.', actions: '<button class="btn" type="button" data-action="clear-filters">Clear filters</button>' })
        : emptyState({
          title: biz ? `Nothing for ${biz.name} in this period` : 'Nothing in this period',
          text: biz ? 'Add a payment or expense for this business, or pick different dates.' : 'There are no transactions for the dates you picked.',
          actions: newTxButton('Add a transaction', biz?.id) + allTimeButton,
        });
    return;
  }

  const groups = new Map();
  for (const e of list) {
    const k = monthKey(e.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  let body = '';
  for (const [k, items] of groups) {
    const t = totals(items);
    body += `<tr class="group"><td colspan="${cols}">${monthName(k)}
      <span class="group-sum">Earnings <b>${money(t.income)}</b> · Expenses <b>${money(t.expense)}</b> · Profit <b>${money(t.profit)}</b></span></td></tr>`;
    for (const e of items) {
      const b = bizById(e.businessId);
      const detail = [detailOf(e), e.note].filter(Boolean).map(esc).join(' · ');
      body += `<tr class="row${e.id === flashId ? ' flash' : ''}" data-id="${e.id}" tabindex="0"
        aria-label="${esc(`${e.name}, ${b.name}, ${fmtDate(e.date)}, ${isIncome(e) ? 'earnings' : 'expense'} ${money(isIncome(e) ? e.amount : expenseOf(e))}. Press Enter to edit.`)}">
        <td class="c-date">${fmtDate(e.date)}</td>
        <td><div class="tx-name">${txIcon(e)}<div><strong>${esc(e.name)}</strong>${detail ? `<small>${detail}</small>` : ''}${showBiz ? `<small class="m-only">${esc(b.name)}</small>` : ''}</div>
          <div class="m-amt">${amountCell(e)}<small class="muted" style="display:block;font-size:12px">${fmtDate(e.date)}</small></div></div></td>
        ${showBiz ? `<td class="c-biz"><span class="biz-tag">${avatar(b, 'sm')}${esc(b.name)}</span></td>` : ''}
        <td class="c-cat"><span class="pill">${esc(e.category)}</span></td>
        <td class="r c-in">${isIncome(e) ? `<span class="amt in">${money(e.amount, { sign: true })}</span>` : '<span class="amt zero">—</span>'}</td>
        <td class="r c-out">${!isIncome(e) ? `<span class="amt">${money(expenseOf(e))}</span>` : '<span class="amt zero">—</span>'}</td>
        <td class="c-actions">
          <button class="icon-btn" type="button" data-action="edit" aria-label="Edit ${esc(e.name)}" title="Edit">${icon('edit')}</button>
          <button class="icon-btn dup" type="button" data-action="dup" aria-label="Duplicate ${esc(e.name)}" title="Duplicate">${icon('copy')}</button>
          <button class="icon-btn danger" type="button" data-action="delete" aria-label="Delete ${esc(e.name)}" title="Delete">${icon('trash')}</button>
        </td>
      </tr>`;
    }
  }
  const t = totals(list);
  host.innerHTML = `<div class="table-wrap"><table class="tx">
    <thead><tr><th class="c-date">Date</th><th>Description</th>${showBiz ? '<th class="c-biz">Business</th>' : ''}<th class="c-cat">Category</th>
      <th class="r c-in">Earnings</th><th class="r c-out">Expense</th><th class="c-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td class="c-date">Total</td><td>Profit ${money(t.profit)}</td>${showBiz ? '<td class="c-biz"></td>' : ''}<td class="c-cat"></td>
      <td class="r c-in amt">${money(t.income)}</td><td class="r c-out amt">${money(t.expense)}</td><td class="c-actions"></td></tr></tfoot>
  </table></div>`;

  if (flashId) $(`tr[data-id="${flashId}"]`, host)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- Businesses page ----------
function viewBusinesses() {
  if (!state.settings.visitedBusinesses) { state.settings.visitedBusinesses = true; saveSettings(); }
  const list = periodEntries();
  const all = totals(list);
  const cards = state.businesses.map((b) => {
    const t = totals(list.filter((e) => e.businessId === b.id));
    const lifetime = state.entries.filter((e) => e.businessId === b.id).length;
    const shown = b.categories.slice(0, 8);
    return `<article class="card biz-card">
      <div class="biz-head">${avatar(b, 'lg')}<div><h3>${esc(b.name)}</h3><small>${plural(lifetime, 'transaction')} in total</small></div>
        <button class="icon-btn" type="button" data-action="edit-biz" data-biz="${esc(b.id)}" aria-label="Edit ${esc(b.name)}" title="Edit business">${icon('edit')}</button></div>
      <div class="biz-stats">
        <div><span>Earnings</span><strong>${money(t.income)}</strong></div>
        <div><span>Expenses</span><strong>${money(t.expense)}</strong></div>
        <div><span>Profit</span><strong class="${t.profit < 0 ? 'negative' : ''}">${money(t.profit)}</strong></div>
      </div>
      <div>
        <div class="sub-label">${plural(b.categories.length, 'expense category', 'expense categories')}</div>
        <div class="cat-chips">${shown.map((c) => `<span class="pill">${esc(c)}</span>`).join('')}${b.categories.length > shown.length ? `<span class="pill">+${b.categories.length - shown.length} more</span>` : ''}</div>
      </div>
      <div class="actions">
        <button class="btn btn-sm" type="button" data-action="edit-biz" data-biz="${esc(b.id)}">${icon('edit')} Edit &amp; categories</button>
        <button class="btn btn-sm" type="button" data-action="view-biz" data-biz="${esc(b.id)}">View dashboard</button>
        ${newTxButton('Transaction', b.id, 'btn btn-sm btn-ghost')}
      </div>
    </article>`;
  }).join('');
  return `<div class="section-head">
      <div><h2>Your businesses</h2><p>Each business keeps its own earnings, expenses and expense categories. Combined net profit for this period: <strong class="${all.profit < 0 ? 'negative' : ''}">${money(all.profit)}</strong></p></div>
      <button class="btn btn-primary" type="button" data-action="add-biz">${icon('plus')} Add business</button>
    </div>
    <div class="grid biz-manage">${cards}
      <button class="card biz-card add" type="button" data-action="add-biz">
        <span class="tile-icon">${icon('plus')}</span><span><strong>Add another business</strong>Track a new side hustle separately</span>
      </button>
    </div>`;
}

// ---------- Reports ----------
function plRows(list) {
  const t = totals(list);
  const incomeLines = groupSum(list.filter(isIncome), sourceName, incomeOf);
  const expenseLines = groupSum(list.filter((e) => !isIncome(e)), (e) => e.category, expenseOf);
  const line = ([name, v], extra = '') => `<tr class="line"><td>${esc(name)}${extra}</td><td class="r">${money(v)}</td></tr>`;
  return `
    <tr class="section"><td>Earnings</td><td></td></tr>
    ${incomeLines.map((l) => line(l)).join('') || '<tr class="line"><td>No earnings recorded</td><td class="r">—</td></tr>'}
    <tr class="subtotal"><td>Total earnings</td><td class="r">${money(t.income)}</td></tr>
    <tr class="section"><td>Allowable expenses</td><td></td></tr>
    ${expenseLines.map((l) => line(l, l[0] === MILEAGE_CATEGORY ? `<small>${fmtKm(t.km)} km · ${esc(kmTierSummary(list))}</small>` : '')).join('') || '<tr class="line"><td>No expenses recorded</td><td class="r">—</td></tr>'}
    <tr class="subtotal"><td>Total expenses</td><td class="r">${money(t.expense)}</td></tr>`;
}
function kmTierSummary(list) {
  let t1 = 0, t2 = 0;
  for (const e of list) { const c = e.type === 'mileage' && claimFor(e); if (c) { t1 += c.t1; t2 += c.t2; } }
  return `Tier 1 ${fmtKm(t1)} km, Tier 2 ${fmtKm(t2)} km`;
}
function provisionalNote(list) {
  const c = list.map((e) => e.type === 'mileage' && claimFor(e)).find((x) => x && x.rates.source === 'provisional');
  return c ? ` Vehicle claims for ${incomeYearName(c.year)} use IRD's ${incomeYearName(c.rates.basedOn)} kilometre rates until the ${incomeYearName(c.year)} rates are published — update them in Settings when they are.` : '';
}
const netLabel = (profit) => (profit < 0 ? 'Net loss' : 'Net profit');
const negCls = (n) => (n < 0 ? ' negative' : '');

function viewReports() {
  if (!state.settings.visitedReports) { state.settings.visitedReports = true; saveSettings(); }
  const biz = selectedBiz();
  const list = scopedEntries();
  const t = totals(list);
  const taxEstimate = round2(Math.max(0, t.profit) * state.settings.taxRate / 100);
  let statement;

  if (!list.length) {
    statement = emptyState({ title: 'Nothing to report yet', text: 'There are no transactions for the business and dates you picked.', actions: newTxButton('Add a transaction', biz?.id) + allTimeButton });
  } else if (biz) {
    statement = `<table class="pl"><tbody>
        ${plRows(list)}
        <tr class="net"><td>${netLabel(t.profit)} (taxable income)</td><td class="r${negCls(t.profit)}">${money(t.profit)}</td></tr>
      </tbody></table>`;
  } else {
    const rows = state.businesses.map((b) => ({ b, list: list.filter((e) => e.businessId === b.id) }));
    statement = `
      <table class="simple by-biz">
        <thead><tr><th>Business</th><th>Earnings</th><th>Expenses</th><th>Profit</th></tr></thead>
        <tbody>${rows.map(({ b, list: l }) => {
          const bt = totals(l);
          return `<tr><td><span class="biz-tag">${avatar(b, 'sm')}${esc(b.name)}</span></td><td>${money(bt.income)}</td><td>${money(bt.expense)}</td><td class="${negCls(bt.profit)}">${money(bt.profit)}</td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr><td>All businesses</td><td>${money(t.income)}</td><td>${money(t.expense)}</td><td class="${negCls(t.profit)}">${money(t.profit)}</td></tr></tfoot>
      </table>
      <table class="pl"><tbody>
        ${rows.filter((r) => r.list.length).map(({ b, list: l }) => {
          const bt = totals(l);
          return `<tr class="biz-heading"><td colspan="2"><span class="biz-tag">${avatar(b, 'sm')}${esc(b.name)}</span></td></tr>
            ${plRows(l)}
            <tr class="biz-net"><td>${netLabel(bt.profit)} · ${esc(b.name)}</td><td class="r${negCls(bt.profit)}">${money(bt.profit)}</td></tr>`;
        }).join('')}
        <tr class="spacer"><td colspan="2"></td></tr>
        <tr class="net"><td>Combined ${netLabel(t.profit).toLowerCase()} · all businesses</td><td class="r${negCls(t.profit)}">${money(t.profit)}</td></tr>
      </tbody></table>`;
  }

  return `<div class="grid reports">
    <section class="card statement" aria-label="Profit and loss statement">
      <div class="statement-head">
        <div><h2>Profit and loss</h2><p>${esc(scopeLabel())} · ${esc(periodLabel())}</p></div>
        <div class="no-print" style="display:flex;gap:8px">
          <button class="btn btn-sm" type="button" data-action="print">${icon('printer')} Print</button>
          <button class="btn btn-sm" type="button" data-action="export-csv">${icon('download')} Export</button>
        </div>
      </div>
      ${statement}
      ${list.length ? `<p class="note">Prepared from ${plural(list.length, 'transaction')} recorded in Ledgerly. Keep receipts for your expenses in case you are asked for them.${provisionalNote(list)}</p>` : ''}
    </section>
    <div class="stack">
      <section class="card callout">
        <span class="tile-icon">${icon('wallet')}</span>
        <div>
          <h3>Suggested amount to put aside for tax${biz ? ` · ${esc(biz.name)}` : ''}</h3>
          <div class="big">${money(taxEstimate)}</div>
          <p>${state.settings.taxRate}% of your ${money(Math.max(0, t.profit))} ${biz ? '' : 'combined '}profit. This is a rough savings guide, not tax advice — <a href="#/settings">change the percentage</a>.</p>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Monthly summary</h2><p>${esc(scopeLabel())} · totals for each month</p></div></div>
        <div class="card-body" style="padding-top:8px">${monthlyTable(list)}</div>
      </section>
    </div>
  </div>`;
}

// ---------- Settings ----------
function viewSettings() {
  const s = state.settings;
  const opt = (v, l, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  return `<div class="settings stack">
    <section class="card">
      <div class="card-head"><div><h2>You</h2><p>Personal details used around the app.</p></div></div>
      <div class="card-body" style="padding:8px 0 0">
        <div class="setting"><div><h3><label for="s-name">Your name</label> <span class="muted" style="font-weight:400">(optional)</span></h3><p>Used to greet you on the dashboard.</p></div>
          <input class="input" id="s-name" data-setting="ownerName" maxlength="40" value="${esc(s.ownerName)}" placeholder="e.g. Sam"></div>
        <div class="setting"><div><h3><label for="s-ty">Tax year starts</label></h3><p>The NZ income year runs 1 April – 31 March. Kilometre-rate tiers always follow the NZ income year.</p></div>
          <select class="input" id="s-ty" data-setting="taxYearStart">
            ${opt('04-01', '1 April (NZ income year)', s.taxYearStart)}${opt('01-01', '1 January (calendar year)', s.taxYearStart)}
          </select></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Businesses &amp; categories</h2><p>Add businesses and manage each one's expense categories.</p></div></div>
      <div class="card-body" style="padding:8px 0 0">
        <div class="setting"><div><h3>${plural(state.businesses.length, 'business', 'businesses')}</h3><p>${state.businesses.map((b) => esc(b.name)).join(', ')}</p></div>
          <div class="actions"><a class="btn" href="#/businesses">${icon('briefcase')} Manage businesses</a></div></div>
      </div>
    </section>
    ${vehiclesSettings()}
    <section class="card">
      <div class="card-head"><div><h2>Money</h2><p>How amounts are worked out and shown.</p></div></div>
      <div class="card-body" style="padding:8px 0 0">
        <div class="setting"><div><h3><label for="s-cur">Currency symbol</label></h3></div>
          <select class="input" id="s-cur" data-setting="currency">
            ${['$', '£', '€', '₹', 'R', 'kr'].map((c) => opt(c, c, s.currency)).join('')}
          </select></div>
        <div class="setting"><div><h3><label for="s-tax">Put aside for tax</label></h3><p>Percentage of profit to save for your tax bill. Used for the estimates on your dashboard and reports.</p></div>
          <div class="input-affix has-right"><span class="affix right">%</span><input class="input num" type="number" step="1" min="0" max="100" id="s-tax" data-setting="taxRate" value="${s.taxRate}"></div></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Appearance</h2></div></div>
      <div class="card-body" style="padding:8px 0 0">
        <div class="setting"><div><h3><label for="s-theme">Theme</label></h3><p>“Automatic” follows your device setting.</p></div>
          <select class="input" id="s-theme" data-setting="theme">${opt('system', 'Automatic', s.theme)}${opt('light', 'Light', s.theme)}${opt('dark', 'Dark', s.theme)}</select></div>
        <div class="setting"><div><h3>Getting started guide</h3><p>Show the checklist on your dashboard.</p></div>
          <div class="actions"><button class="btn" type="button" data-action="show-onboarding" ${s.onboardingDismissed ? '' : 'disabled'}>Show guide</button></div></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Your data</h2><p>Your data is stored on this Ledgerly server and is private to your account. Download a backup now and then to keep your own copy.</p></div></div>
      <div class="card-body" style="padding:8px 0 0">
        <div class="setting"><div><h3>Back up &amp; restore</h3><p>Includes all businesses, categories and transactions. Last backup: ${s.lastBackup ? esc(fmtDate(s.lastBackup)) : 'never'}</p></div>
          <div class="actions">
            <button class="btn" type="button" data-action="backup">${icon('download')} Back up</button>
            <button class="btn" type="button" data-action="restore">${icon('upload')} Restore</button>
          </div></div>
        <div class="setting"><div><h3>Export to spreadsheet</h3><p>Download all ${plural(state.entries.length, 'transaction')} as a CSV file for Excel, Google Sheets or your accountant.</p></div>
          <div class="actions"><button class="btn" type="button" data-action="export-all">${icon('download')} Export CSV</button></div></div>
        <div class="setting"><div><h3>Sample data</h3><p>Replace everything with three example businesses and a few months of sample Ride Share transactions.</p></div>
          <div class="actions"><button class="btn" type="button" data-action="load-sample">Load sample data</button></div></div>
        <div class="setting"><div><h3>Delete all transactions</h3><p>Permanently remove every transaction from your account. Your businesses and categories are kept.</p></div>
          <div class="actions"><button class="btn btn-danger" type="button" data-action="clear-all">${icon('trash')} Delete all</button></div></div>
      </div>
    </section>
    ${accountSettings()}
    ${state.user?.isAdmin ? adminSettingsCard() : ''}
  </div>`;
}

// ---------- Account ----------
function accountSettings() {
  const u = state.user || {};
  return `<section class="card" id="account">
    <div class="card-head">
      <div><h2>Account</h2><p>Signed in as <strong>${esc(u.username)}</strong>${u.isAdmin ? ' · administrator' : ''}</p></div>
      <button class="btn btn-sm" type="button" data-action="logout">${icon('logout')} Sign out</button>
    </div>
    <div class="card-body" style="padding:8px 0 0">
      <form class="setting" id="passwordForm" novalidate>
        <div><h3>Change password</h3><p>You’ll stay signed in here. Your other devices will be signed out.</p></div>
        <div class="field-stack">
          <input type="text" name="username" autocomplete="username" value="${esc(u.username)}" hidden>
          <label class="visually-hidden" for="pw-current">Current password</label>
          <input class="input" type="password" id="pw-current" name="currentPassword" autocomplete="current-password" placeholder="Current password" maxlength="200">
          <label class="visually-hidden" for="pw-new">New password</label>
          <input class="input" type="password" id="pw-new" name="newPassword" autocomplete="new-password" placeholder="New password (8+ characters)" maxlength="200">
          <button class="btn" type="submit">Update password</button>
        </div>
      </form>
      <form class="setting" id="deleteAccountForm" novalidate>
        <div><h3>Delete my account</h3><p>Permanently deletes your account and all of your businesses and transactions from this server. Download a backup first if you want to keep a copy.</p></div>
        <div class="field-stack">
          <label class="visually-hidden" for="del-password">Your password</label>
          <input class="input" type="password" id="del-password" name="password" autocomplete="current-password" placeholder="Confirm with your password" maxlength="200">
          <button class="btn btn-danger" type="submit">${icon('trash')} Delete my account</button>
        </div>
      </form>
    </div>
  </section>`;
}

async function logout() {
  await flushSettings();
  await saveQueue;
  try { await api('POST', '/auth/logout', {}); } catch { /* signed out anyway */ }
  location.replace('/login');
}

async function submitPasswordForm(f) {
  const currentPassword = f.elements.currentPassword.value;
  const newPassword = f.elements.newPassword.value;
  if (!currentPassword) { showToast('Enter your current password.'); f.elements.currentPassword.focus(); return; }
  if (newPassword.length < 8) { showToast('Your new password needs at least 8 characters.'); f.elements.newPassword.focus(); return; }
  try {
    await api('PUT', '/auth/password', { currentPassword, newPassword });
    f.reset();
    showToast('Password updated — other devices have been signed out');
  } catch (err) {
    showToast(err.message);
  }
}

async function submitDeleteAccount(f) {
  const password = f.elements.password.value;
  if (!password) { showToast('Enter your password to confirm.'); f.elements.password.focus(); return; }
  if (!confirm('Delete your account and all of its data? This can’t be undone.')) return;
  try {
    await api('POST', '/auth/delete-account', { password });
    location.replace('/login');
  } catch (err) {
    showToast(err.message);
  }
}

// ---------- Server administration (admins only) ----------
function adminSettingsCard() {
  return `<section class="card" id="admin">
    <div class="card-head">
      <div><h2>Server administration</h2><p>Manage who can use this Ledgerly server. Administrators can’t see anyone else’s businesses or transactions.</p></div>
      <button class="btn btn-sm" type="button" data-action="admin-refresh">Refresh</button>
    </div>
    <div class="card-body" style="padding:8px 0 0" id="adminBody"><p class="muted" style="padding:0 20px 16px">Loading users…</p></div>
  </section>`;
}

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never');

async function mountAdmin() {
  const host = $('#adminBody');
  if (!host) return;
  let users, settings;
  try {
    [{ users }, settings] = await Promise.all([api('GET', '/admin/users'), api('GET', '/admin/settings')]);
  } catch (err) {
    host.innerHTML = `<p class="muted" style="padding:0 20px 16px">Couldn’t load users: ${esc(err.message)}</p>`;
    return;
  }
  if (!$('#adminBody')) return; // navigated away meanwhile
  const rows = users.map((u) => {
    const me = u.id === state.user.id;
    return `<tr>
      <td><strong>${esc(u.username)}</strong>${me ? ' <span class="pill">You</span>' : ''}<small class="muted" style="display:block">Joined ${esc(fmtTime(u.createdAt))}</small></td>
      <td>${u.isAdmin ? 'Administrator' : 'User'}</td>
      <td>${esc(fmtTime(u.lastLoginAt))}</td>
      <td class="admin-actions">
        <button class="btn btn-sm" type="button" data-action="admin-reset-password" data-user-id="${u.id}" data-username="${esc(u.username)}">Reset password</button>
        <button class="btn btn-sm" type="button" data-action="admin-toggle-admin" data-user-id="${u.id}" data-make-admin="${!u.isAdmin}">${u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
        ${me ? '' : `<button class="icon-btn danger" type="button" data-action="admin-delete-user" data-user-id="${u.id}" data-username="${esc(u.username)}" aria-label="Delete ${esc(u.username)}" title="Delete user">${icon('trash')}</button>`}
      </td>
    </tr>`;
  }).join('');
  host.innerHTML = `
    <div class="setting"><div><h3><label for="a-reg">New sign-ups</label></h3>
      <p>${settings.registrationLocked ? 'Set by the <code>ALLOW_REGISTRATION</code> environment variable on this server.' : 'Let anyone who can reach this server create their own account.'}</p></div>
      <select class="input" id="a-reg" data-admin="registration" ${settings.registrationLocked ? 'disabled' : ''}>
        <option value="closed" ${settings.registrationOpen ? '' : 'selected'}>Closed — admins add users</option>
        <option value="open" ${settings.registrationOpen ? 'selected' : ''}>Open to anyone</option>
      </select></div>
    <div class="admin-users table-wrap"><table class="simple">
      <thead><tr><th>User</th><th>Role</th><th>Last sign-in</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <form class="setting" id="addUserForm" novalidate>
      <div><h3>Add a user</h3><p>Give them the username and temporary password. They can change the password in Settings after signing in.</p></div>
      <div class="field-stack">
        <label class="visually-hidden" for="nu-name">Username or email</label>
        <input class="input" id="nu-name" name="username" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64" placeholder="Username or email">
        <label class="visually-hidden" for="nu-pass">Temporary password</label>
        <input class="input" id="nu-pass" name="password" type="password" autocomplete="new-password" maxlength="200" placeholder="Temporary password (8+ characters)">
        <label class="check"><input type="checkbox" name="isAdmin"> Make them an administrator</label>
        <button class="btn" type="submit">${icon('plus')} Add user</button>
      </div>
    </form>`;
}

async function adminCall(method, path, body, success) {
  try {
    await api(method, path, body);
    if (success) showToast(success);
  } catch (err) {
    showToast(err.message);
  }
  await mountAdmin();
}

async function submitAddUser(f) {
  const username = f.elements.username.value.trim();
  const password = f.elements.password.value;
  if (!username) { showToast('Enter a username for the new user.'); f.elements.username.focus(); return; }
  if (password.length < 8) { showToast('The temporary password needs at least 8 characters.'); f.elements.password.focus(); return; }
  await adminCall('POST', '/admin/users', { username, password, isAdmin: f.elements.isAdmin.checked }, `Added ${username}`);
}

function adminResetPassword(id, username) {
  const password = prompt(`New password for ${username} (at least 8 characters). They will be signed out everywhere.`);
  if (password === null) return;
  if (password.length < 8) { alert('Passwords need at least 8 characters.'); return; }
  adminCall('PUT', `/admin/users/${id}`, { password }, `Password for ${username} updated`);
}

async function adminToggleAdmin(id, makeAdmin) {
  if (!makeAdmin && id === state.user.id && !confirm('Remove your own administrator access?')) return;
  await adminCall('PUT', `/admin/users/${id}`, { isAdmin: makeAdmin }, makeAdmin ? 'Administrator added' : 'Administrator access removed');
  if (id === state.user.id && !makeAdmin) {
    state.user.isAdmin = false;
    render();
  }
}

function adminDeleteUser(id, username) {
  if (!confirm(`Delete ${username} and all of their businesses and transactions? This can’t be undone.`)) return;
  adminCall('DELETE', `/admin/users/${id}`, undefined, `Deleted ${username}`);
}

async function setRegistration(open) {
  await adminCall('PUT', '/admin/settings', { registrationOpen: open }, open ? 'Sign-ups are now open' : 'Sign-ups are now closed');
}

function vehiclesSettings() {
  const year = state.rateYear ?? incomeYearOf(todayStr());
  const lastYear = Math.max(incomeYearOf(todayStr()), IRD_YEARS[IRD_YEARS.length - 1]);
  const years = [];
  for (let y = lastYear; y >= IRD_YEARS[0]; y--) years.push(y);
  const tripCount = (v) => state.entries.filter((e) => e.type === 'mileage' && e.vehicleId === v.id).length;
  const vehicleRows = state.vehicles.map((v) => {
    const n = tripCount(v);
    const locked = n > 0 || state.vehicles.length === 1;
    return `<tr>
      <td><input class="input" data-vehicle="${v.id}" data-vfield="name" maxlength="40" value="${esc(v.name)}" aria-label="Vehicle name"></td>
      <td><select class="input" data-vehicle="${v.id}" data-vfield="fuel" aria-label="Fuel type for ${esc(v.name)}">
        ${Object.entries(FUEL_TYPES).map(([k, l]) => `<option value="${k}" ${v.fuel === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td class="num-cell"><div class="input-affix has-right"><span class="affix right">%</span>
        <input class="input num" type="number" min="1" max="100" step="1" data-vehicle="${v.id}" data-vfield="businessPct" value="${v.businessPct}" aria-label="Business use for ${esc(v.name)}"></div></td>
      <td class="muted">${plural(n, 'trip')}</td>
      <td><button class="icon-btn danger" type="button" data-action="delete-vehicle" data-vehicle-id="${v.id}" ${locked ? 'disabled' : ''}
        title="${locked ? (n ? 'Vehicles with trips can’t be deleted' : 'You need at least one vehicle') : 'Delete vehicle'}" aria-label="Delete ${esc(v.name)}">${icon('trash')}</button></td>
    </tr>`;
  }).join('');
  const rateRows = Object.entries(FUEL_TYPES).map(([k, l]) => {
    const r = ratesFor(year, k);
    return `<tr><td>${l}</td>
      <td class="num-cell"><div class="input-affix"><span class="affix">${esc(state.settings.currency)}</span><input class="input num" type="number" min="0" step="0.01" data-rate-fuel="${k}" data-rate-tier="0" value="${r.t1.toFixed(2)}" aria-label="${l} Tier 1 rate"></div></td>
      <td class="num-cell"><div class="input-affix"><span class="affix">${esc(state.settings.currency)}</span><input class="input num" type="number" min="0" step="0.01" data-rate-fuel="${k}" data-rate-tier="1" value="${r.t2.toFixed(2)}" aria-label="${l} Tier 2 rate"></div></td>
    </tr>`;
  }).join('');
  return `<section class="card" id="vehicles">
    <div class="card-head">
      <div><h2>Vehicles &amp; kilometre rates</h2><p>Mileage is claimed at Inland Revenue (IRD) kilometre rates, in two tiers. <a href="${IRD_URL}" target="_blank" rel="noopener">About IRD kilometre rates</a></p></div>
      <button class="btn btn-sm" type="button" data-action="add-vehicle">${icon('plus')} Add vehicle</button>
    </div>
    <div class="card-body">
      <div class="table-wrap"><table class="simple vtable">
        <thead><tr><th>Vehicle</th><th>Fuel type</th><th>Business use</th><th>Trips</th><th><span class="visually-hidden">Delete</span></th></tr></thead>
        <tbody>${vehicleRows}</tbody>
      </table></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Business use is the percentage from your logbook (a 90-day logbook can be used for up to three years). Tier 1 applies to the first ${fmtKm(TIER1_KM)} km × business use % of each vehicle's business kilometres in an income year; Tier 2 applies after that.</p>
      <div class="note-box">${icon('info')}<span>Kilometre rates already include fuel, insurance, registration, WOF, repairs and depreciation for that vehicle. If you claim kilometres, don't also add those vehicle costs as separate expenses.</span></div>

      <div class="sub-head">
        <h3><label for="rateYear">Rates for the</label></h3>
        <select class="input" id="rateYear" style="width:auto">${years.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${incomeYearName(y)} income year</option>`).join('')}</select>
        <span style="flex:1"></span>
        <button class="btn btn-sm" type="button" data-action="reset-rates" ${state.settings.kmRates[year] ? '' : 'disabled'}>Reset to IRD rates</button>
      </div>
      <p class="muted" id="rateStatus" style="font-size:13px;margin:0 0 8px">${rateStatus(year)}</p>
      <div class="table-wrap"><table class="simple vtable">
        <thead><tr><th>Fuel type</th><th>Tier 1 per km</th><th>Tier 2 per km</th></tr></thead>
        <tbody>${rateRows}</tbody>
      </table></div>
    </div>
  </section>`;
}
function rateStatus(year) {
  const edited = Object.keys(state.settings.kmRates[year] || {}).length > 0;
  if (IRD_RATES[year]) return `Official IRD rates for ${incomeYearName(year)}${edited ? ', with your changes' : ''}.`;
  return `IRD hasn't published ${incomeYearName(year)} rates yet — they're released after the income year ends. Until then the ${incomeYearName(provisionalBase(year))} rates are used as an estimate${edited ? ' (with your changes)' : ''}. Enter the official rates here once IRD publishes them.`;
}

$('#view').addEventListener('change', (e) => {
  if (e.target.dataset.admin === 'registration') { setRegistration(e.target.value === 'open'); return; }
  const vid = e.target.dataset.vehicle;
  if (vid) {
    const v = vehicleById(vid);
    const field = e.target.dataset.vfield;
    if (field === 'name') v.name = e.target.value.trim().slice(0, 40) || v.name;
    if (field === 'fuel') v.fuel = e.target.value;
    if (field === 'businessPct') v.businessPct = Math.min(100, Math.max(1, num(e.target.value) || 100));
    e.target.value = v[field];
    touch();
    persist('PUT', `/vehicles/${encodeURIComponent(v.id)}`, v);
    showToast(`${v.name} saved`);
    return;
  }
  if (e.target.id === 'rateYear') { state.rateYear = +e.target.value; render(); return; }
  const fuel = e.target.dataset.rateFuel;
  if (fuel) {
    const year = state.rateYear ?? incomeYearOf(todayStr());
    const cur = ratesFor(year, fuel);
    const pair = [cur.t1, cur.t2];
    pair[+e.target.dataset.rateTier] = round2(Math.max(0, num(e.target.value)));
    e.target.value = pair[+e.target.dataset.rateTier].toFixed(2);
    const yearRates = { ...(state.settings.kmRates[year] || {}) };
    const ird = IRD_RATES[year]?.[fuel];
    if (ird && ird[0] === pair[0] && ird[1] === pair[1]) delete yearRates[fuel]; else yearRates[fuel] = pair;
    const all = { ...state.settings.kmRates, [year]: yearRates };
    if (!Object.keys(yearRates).length) delete all[year];
    state.settings.kmRates = all;
    saveSettings();
    $('#rateStatus').textContent = rateStatus(year);
    $('[data-action="reset-rates"]').disabled = !all[year];
    showToast(`${FUEL_TYPES[fuel]} rates for ${incomeYearName(year)} saved`);
    return;
  }
  const key = e.target.dataset.setting;
  if (key) {
    let v = e.target.value;
    if (key === 'taxRate') v = Math.min(100, Math.max(0, num(v)));
    if (key === 'ownerName') v = v.trim();
    state.settings[key] = v;
    if (key === 'theme') { applyTheme(); cacheTheme(); }
    saveSettings();
    // Only redraw the page when a value shown on it changed, so keyboard focus isn't lost.
    if (key === 'currency') render(); else renderShell();
    showToast('Settings saved');
    return;
  }
  if (e.target.id === 'txCategory') { state.tx.category = e.target.value; renderTxTable(); }
  if (e.target.id === 'txSort') { state.tx.sort = e.target.value; renderTxTable(); }
});
$('#view').addEventListener('input', (e) => {
  if (e.target.id === 'txSearch') { state.tx.q = e.target.value; renderTxTable(); }
});
$('#view').addEventListener('submit', async (e) => {
  const handlers = { passwordForm: submitPasswordForm, deleteAccountForm: submitDeleteAccount, addUserForm: submitAddUser };
  const handler = handlers[e.target.id];
  if (!handler) return;
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try { await handler(e.target); } finally { if (btn?.isConnected) btn.disabled = false; }
});

// ---------- Transaction editor ----------
const dlg = $('#txDialog');
const form = $('#txForm');
const F = form.elements;
let editingId = null;
let categoryTouched = false;
const currentType = () => F.type.value;
// Read/write the chosen business via :checked (a lone radio's .value isn't its checked state).
const currentBiz = () => $('input[name="businessId"]:checked', form)?.value || state.businesses[0].id;
function setBizOption(id) {
  $$('input[name="businessId"]', form).forEach((r) => { r.checked = r.value === id; });
}
function renderBizOptions(selectedId) {
  $('#bizOptions').innerHTML = state.businesses.map((b) => `
    <label><input type="radio" name="businessId" value="${esc(b.id)}"><span class="biz-option">${avatar(b, 'sm')}${esc(b.name)}</span></label>`).join('') +
    `<button class="link-btn" type="button" id="txAddBiz">${icon('plus')}New business</button>`;
  setBizOption(selectedId);
}

function syncForm() {
  const type = currentType();
  const bizId = currentBiz();
  $$('[data-show]', form).forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(type); });
  $('#nameLabel').textContent = { income: 'Who paid you?', expense: 'What did you pay for?', mileage: 'What was the trip for?', percent: 'Which bill is it?' }[type];
  F.name.placeholder = { income: 'e.g. Uber, YouTube AdSense, a client', expense: 'e.g. Insurance, Adobe, new microphone', mileage: 'e.g. Business mileage', percent: 'e.g. Mobile bill, Broadband' }[type];
  $('#amountLabel').textContent = type === 'income' ? 'Amount received' : 'Amount paid';
  const pool = categoryPool(type, bizId);
  const keep = categoryTouched && pool.includes(F.category.value) ? F.category.value : guessCategory(type, F.name.value, bizId);
  F.category.innerHTML = pool.map((c) => `<option>${esc(c)}</option>`).join('');
  F.category.value = keep;
  F.category.disabled = type === 'mileage';
  const canAdd = type === 'expense' || type === 'percent';
  $('#newCatToggle').hidden = !canAdd;
  if (!canAdd) closeNewCategory();
  $('#categoryHelp').textContent = type === 'mileage' ? 'Claimed at IRD kilometre rates as a motor vehicle expense.'
    : canAdd ? `Categories for ${bizName(bizId)}.` : 'Suggested from the description.';
  clearErrors();
  updateSummary();
}

function readTx() {
  const e = { businessId: currentBiz(), type: currentType(), date: F.date.value, name: F.name.value.trim(), category: F.category.value, note: F.note.value.trim() };
  if (e.type === 'income' || e.type === 'expense') e.amount = round2(num(F.amount.value));
  if (e.type === 'mileage') { e.km = num(F.km.value); e.vehicleId = F.vehicle.value; e.category = MILEAGE_CATEGORY; }
  if (e.type === 'percent') { e.bill = round2(num(F.bill.value)); e.percent = num(F.percent.value); }
  return e;
}

function validate(e) {
  const errs = [];
  if (!e.name) errs.push('name');
  if (!e.date) errs.push('date');
  if ((e.type === 'income' || e.type === 'expense') && !(e.amount > 0)) errs.push('amount');
  if (e.type === 'mileage' && !(e.km > 0)) errs.push('km');
  if (e.type === 'percent') { if (!(e.bill > 0)) errs.push('bill'); if (!(e.percent > 0 && e.percent <= 100)) errs.push('percent'); }
  return errs;
}
function clearErrors() { $$('.field.invalid', form).forEach((f) => f.classList.remove('invalid')); }

function updateSummary() {
  const e = readTx();
  const box = $('#txSummary');
  const to = ` for <strong class="biz-name">${esc(bizName(e.businessId))}</strong>`;
  if (e.type === 'income') {
    box.innerHTML = `<span class="tx-icon in">${icon('in')}</span><div>This adds <strong>${money(e.amount || 0)}</strong> to your earnings${to}.</div>`;
  } else if (e.type === 'mileage') {
    const p = previewMileage(e);
    box.innerHTML = `<span class="tx-icon out">${icon('car')}</span><div>${esc(tierParts(p.split, p.rates))} = <strong>${money(p.amount)}</strong> added to your expenses${to}.</div>`;
    const left = Math.max(0, tier1Cap(p.v) - p.prior);
    $('#tierInfo').innerHTML = `<strong>${esc(p.v.name)}</strong> · ${FUEL_TYPES[p.v.fuel]} · ${esc(rateSourceLabel(p.rates))}: Tier 1 ${money(p.rates.t1)}/km, Tier 2 ${money(p.rates.t2)}/km.<br>
      ${left > 0 ? `${fmtKm(left)} km left at the Tier 1 rate in the ${incomeYearName(p.year)} income year before this trip.` : `The Tier 1 limit for ${incomeYearName(p.year)} has been reached, so this trip uses the Tier 2 rate.`}<br>
      <span class="muted">Kilometre rates already cover fuel, insurance, registration, WOF, repairs and depreciation for this vehicle — don't also claim those separately.</span>`;
  } else {
    const v = expenseOf({ ...e, bill: e.bill || 0, percent: e.percent || 0, amount: e.amount || 0 });
    const how = e.type === 'percent' ? `${fmtKm(e.percent || 0)}% of ${money(e.bill || 0)} = ` : '';
    box.innerHTML = `<span class="tx-icon out">${icon(TYPE_ICON[e.type])}</span><div>${esc(how)}<strong>${money(v)}</strong> added to your expenses${to}.</div>`;
  }
}

// What a trip would be worth: km already driven in that vehicle's income year (excluding the trip
// being edited) decides how much of it still gets the Tier 1 rate.
function previewMileage(e) {
  const v = vehicleById(e.vehicleId) || state.vehicles[0];
  const date = e.date || todayStr();
  const year = incomeYearOf(date);
  const prior = state.entries
    .filter((x) => x.type === 'mileage' && x.id !== editingId && x.vehicleId === v.id && incomeYearOf(x.date) === year && x.date <= date)
    .reduce((sum, x) => sum + x.km, 0);
  const split = splitTiers(prior, e.km || 0, v);
  const rates = ratesFor(year, v.fuel);
  return { v, year, prior, split, rates, amount: tierAmount(split, rates) };
}

function defaultBusinessId(preferred) {
  if (preferred && bizById(preferred)) return preferred;
  if (selectedBiz()) return state.settings.business;
  if (bizById(state.settings.lastBusinessId)) return state.settings.lastBusinessId;
  return state.businesses[0].id;
}

function openTx(entry = null, { duplicate = false, type, businessId } = {}) {
  if (!state.loaded) return;
  form.reset();
  clearErrors();
  closeNewCategory();
  editingId = entry && !duplicate ? entry.id : null;
  categoryTouched = !!entry;
  renderBizOptions(entry?.businessId || defaultBusinessId(businessId));
  F.type.value = entry?.type || type || 'income';
  F.date.value = duplicate ? todayStr() : entry?.date || todayStr();
  F.name.value = entry?.name || '';
  F.amount.value = entry?.amount ?? '';
  F.km.value = entry?.km ?? '';
  F.vehicle.innerHTML = state.vehicles.map((v) => `<option value="${v.id}">${esc(v.name)} (${FUEL_TYPES[v.fuel]})</option>`).join('');
  F.vehicle.value = vehicleById(entry?.vehicleId)?.id || vehicleById(state.settings.lastVehicleId)?.id || state.vehicles[0].id;
  F.bill.value = entry?.bill ?? '';
  F.percent.value = entry?.percent ?? 90;
  F.note.value = entry?.note || '';
  $('#nameList').innerHTML = [...new Set(state.entries.map((e) => e.name))].sort().map((n) => `<option value="${esc(n)}">`).join('');
  syncForm();
  if (entry) F.category.value = entry.category;
  $('#txTitle').textContent = editingId ? 'Edit transaction' : duplicate ? 'Duplicate transaction' : 'New transaction';
  $('#txDelete').hidden = !editingId;
  $('#txAnother').hidden = !!editingId;
  $('#txSave').textContent = editingId ? 'Save changes' : 'Save';
  updateSummary();
  if (!dlg.open) dlg.showModal();
  (editingId ? F.name : duplicate ? F.date : $('input[name="type"]:checked', form)).focus();
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'type' || e.target.name === 'businessId') syncForm();
  if (e.target.name === 'category') categoryTouched = true;
  if (e.target.name === 'name' && !editingId) autofill();
});
form.addEventListener('input', (e) => {
  e.target.closest('.field')?.classList.remove('invalid');
  if (e.target.name === 'name' && !categoryTouched && currentType() !== 'mileage') {
    F.category.value = guessCategory(currentType(), F.name.value, currentBiz());
  }
  updateSummary();
});

// Picking a description used before (for the same business) fills in its last amount.
function autofill() {
  const type = currentType();
  const bizId = currentBiz();
  const name = F.name.value.trim().toLowerCase();
  const last = byDate(state.entries).reverse().find((e) => e.businessId === bizId && e.type === type && e.name.toLowerCase() === name);
  if (!last) return;
  if (!categoryTouched && categoryPool(type, bizId).includes(last.category)) F.category.value = last.category;
  if (type === 'income' || type === 'expense') { if (!F.amount.value) F.amount.value = last.amount; }
  if (type === 'percent') { if (!F.bill.value) F.bill.value = last.bill; F.percent.value = last.percent; }
  updateSummary();
}

// Add a new expense category to the chosen business without leaving the form.
function closeNewCategory() {
  $('#newCatRow').hidden = true;
  $('#f-newcat').value = '';
  $('#newCatErr').style.display = 'none';
}
function addCategoryInline() {
  const name = $('#f-newcat').value.trim();
  const err = $('#newCatErr');
  const biz = bizById(currentBiz());
  if (!name) { err.textContent = 'Type a name for the new category.'; err.style.display = 'block'; $('#f-newcat').focus(); return; }
  if (sameText(name, MILEAGE_CATEGORY)) { err.textContent = 'That name is reserved for mileage.'; err.style.display = 'block'; return; }
  const existing = biz.categories.find((c) => sameText(c, name));
  if (!existing) {
    biz.categories.push(name);
    persist('PUT', `/businesses/${encodeURIComponent(biz.id)}`, { name: biz.name, color: biz.color, categories: biz.categories });
  }
  categoryTouched = true;
  syncForm();
  F.category.value = existing || name;
  closeNewCategory();
  F.category.focus();
  showToast(existing ? `“${existing}” already exists — selected it` : `Added “${name}” to ${biz.name}`);
}
$('#newCatToggle').addEventListener('click', () => { $('#newCatRow').hidden = false; $('#f-newcat').focus(); });
$('#newCatCancel').addEventListener('click', () => { closeNewCategory(); $('#newCatToggle').focus(); });
$('#newCatAdd').addEventListener('click', addCategoryInline);
$('#f-newcat').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addCategoryInline(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNewCategory(); $('#newCatToggle').focus(); }
});

form.addEventListener('click', (e) => {
  const dateChip = e.target.closest('[data-date]');
  if (dateChip) { F.date.value = addDays(todayStr(), +dateChip.dataset.date); F.date.closest('.field').classList.remove('invalid'); }
  const pctChip = e.target.closest('[data-pct]');
  if (pctChip) { F.percent.value = pctChip.dataset.pct; F.percent.closest('.field').classList.remove('invalid'); updateSummary(); }
  if (e.target.closest('#txAddBiz')) {
    openBiz(null, { after: (b) => { renderBizOptions(b.id); syncForm(); } });
  }
  if (e.target.closest('[data-close]')) dlg.close();
});
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

let addAnother = false;
$('#txAnother').addEventListener('click', () => { addAnother = true; form.requestSubmit(); });

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const another = addAnother;
  addAnother = false;
  const data = readTx();
  const errs = validate(data);
  clearErrors();
  if (errs.length) {
    errs.forEach((name) => $(`[data-field="${name}"]`, form)?.classList.add('invalid'));
    $(`[data-field="${errs[0]}"] .input`, form)?.focus();
    return;
  }
  let id;
  state.settings.lastBusinessId = data.businessId;
  if (data.type === 'mileage') state.settings.lastVehicleId = data.vehicleId;
  if (editingId) {
    id = editingId;
    const i = state.entries.findIndex((x) => x.id === id);
    if (i >= 0) {
      state.entries[i] = normalize({ ...data, id, createdAt: state.entries[i].createdAt });
      persist('PUT', entryPath(id), state.entries[i]);
    }
    showToast('Changes saved');
  } else {
    const entry = normalize({ ...data, id: uid(), createdAt: Date.now() });
    id = entry.id;
    state.entries.push(entry);
    persist('POST', '/entries', entry);
    showToast(`Added “${entry.name}” to ${bizName(entry.businessId)} · ${isIncome(entry) ? money(entry.amount, { sign: true }) : '−' + money(expenseOf(entry))}`, () => {
      state.entries = state.entries.filter((x) => x.id !== id);
      touch(); render();
      persist('DELETE', entryPath(id));
    });
  }
  // Make sure the saved entry is visible with the current business and dates.
  const saved = state.entries.find((x) => x.id === id);
  const { from, to } = periodRange();
  if ((from && saved.date < from) || (to && saved.date > to)) state.settings.period = 'all';
  if (selectedBiz() && saved.businessId !== state.settings.business) setBusinessScope('all');
  touch();
  saveSettings();
  render();
  if (state.route === 'transactions') renderTxTable(id);
  if (another) {
    const keepType = currentType(), keepDate = F.date.value, keepBiz = currentBiz();
    openTx(null, { type: keepType, businessId: keepBiz });
    F.date.value = keepDate;
    F.name.focus();
  } else {
    dlg.close();
  }
});

$('#txDelete').addEventListener('click', () => { const id = editingId; dlg.close(); deleteEntry(id); });

const entryPath = (id) => `/entries/${encodeURIComponent(id)}`;
function deleteEntry(id) {
  const idx = state.entries.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const [entry] = state.entries.splice(idx, 1);
  touch(); render();
  persist('DELETE', entryPath(id));
  showToast(`Deleted “${entry.name}”`, () => {
    state.entries.splice(Math.min(idx, state.entries.length), 0, entry);
    touch(); render();
    persist('POST', '/entries', entry);
    if (state.route === 'transactions') renderTxTable(entry.id);
  });
}

// ---------- Business editor ----------
const bdlg = $('#bizDialog');
const bform = $('#bizForm');
let draft = null;       // { id, name, color, cats: [{ name, orig }] }
let afterBizSave = null;

$('#b-template').innerHTML = Object.entries(TEMPLATES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('');

function openBiz(biz, { after } = {}) {
  afterBizSave = after || null;
  draft = biz
    ? { id: biz.id, name: biz.name, color: biz.color, cats: biz.categories.map((c) => ({ name: c, orig: c })) }
    : { id: null, name: '', color: nextColor(), cats: TEMPLATES.general.cats.map((c) => ({ name: c, orig: null })) };
  $('#bizTitle').textContent = biz ? `Edit ${biz.name}` : 'Add a business';
  $('#b-name').value = draft.name;
  $('#b-template').value = 'general';
  $('#templateField').hidden = !!biz;
  $('#bizDelete').hidden = !biz;
  $('#bizSave').textContent = biz ? 'Save changes' : 'Add business';
  $('#b-newcat').value = '';
  $('[data-field="bizName"]', bform).classList.remove('invalid');
  hideBizCatErr();
  $('#colorOptions').innerHTML = BUSINESS_COLORS.map((c, i) => `
    <label><input type="radio" name="bizColor" value="${c}" ${c === draft.color ? 'checked' : ''} aria-label="Colour ${i + 1}">
      <span class="color-dot" style="background:${c}">${icon('check')}</span></label>`).join('');
  renderCatList();
  bdlg.showModal();
  $('#b-name').focus();
}

function usage(cat) {
  return draft.id ? state.entries.filter((e) => e.businessId === draft.id && !isIncome(e) && e.category === cat).length : 0;
}
function renderCatList() {
  $('#catList').innerHTML = draft.cats.map((c, i) => {
    const n = c.orig ? usage(c.orig) : 0;
    return `<li>
      <input class="input" data-cat-index="${i}" value="${esc(c.name)}" maxlength="40" aria-label="Category name">
      <span class="usage">${c.orig && draft.id ? (n ? plural(n, 'use') : 'Unused') : 'New'}</span>
      <button class="icon-btn danger" type="button" data-cat-remove="${i}" aria-label="Remove ${esc(c.name)}" title="Remove">${icon('trash')}</button>
    </li>`;
  }).join('') + `<li class="locked"><strong>${MILEAGE_CATEGORY}</strong><span>Used automatically for mileage</span></li>`;
}
function showBizCatErr(msg) { const el = $('#bizCatErr'); el.textContent = msg; el.style.display = 'block'; }
function hideBizCatErr() { $('#bizCatErr').style.display = 'none'; }

function addBizCategory() {
  const name = $('#b-newcat').value.trim();
  if (!name) { showBizCatErr('Type a name for the new category.'); $('#b-newcat').focus(); return; }
  if (sameText(name, MILEAGE_CATEGORY) || draft.cats.some((c) => sameText(c.name, name))) { showBizCatErr(`“${name}” is already in the list.`); return; }
  hideBizCatErr();
  draft.cats.push({ name, orig: null });
  renderCatList();
  $('#b-newcat').value = '';
  $('#b-newcat').focus();
  $('#catList').scrollTop = $('#catList').scrollHeight;
}

$('#catList').addEventListener('input', (e) => {
  const i = e.target.dataset.catIndex;
  if (i !== undefined) draft.cats[+i].name = e.target.value;
});
$('#catList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cat-remove]');
  if (!btn) return;
  draft.cats.splice(+btn.dataset.catRemove, 1);
  renderCatList();
});
$('#bizCatAdd').addEventListener('click', addBizCategory);
$('#b-newcat').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBizCategory(); } });
$('#catList').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) e.preventDefault(); });
$('#b-template').addEventListener('change', (e) => {
  draft.cats = TEMPLATES[e.target.value].cats.map((c) => ({ name: c, orig: null }));
  renderCatList();
});
$('#colorOptions').addEventListener('change', (e) => { draft.color = e.target.value; });
$('#b-name').addEventListener('input', () => $('[data-field="bizName"]', bform).classList.remove('invalid'));
bform.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) bdlg.close(); });
bdlg.addEventListener('click', (e) => { if (e.target === bdlg) bdlg.close(); });

bform.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = $('#b-name').value.trim();
  const nameField = $('[data-field="bizName"]', bform);
  if (!name || state.businesses.some((b) => b.id !== draft.id && sameText(b.name, name))) {
    $('#bizNameErr').textContent = name ? 'You already have a business with that name.' : 'Please give your business a name.';
    nameField.classList.add('invalid');
    $('#b-name').focus();
    return;
  }
  // Build the final list (merging duplicates) and remember where each original category ended up.
  const finalCats = [];
  const renamed = new Map();
  for (const c of draft.cats) {
    const n = c.name.trim().slice(0, 40);
    if (!n || sameText(n, MILEAGE_CATEGORY)) continue;
    let kept = finalCats.find((x) => sameText(x, n));
    if (!kept) { kept = n; finalCats.push(n); }
    if (c.orig) renamed.set(c.orig, kept);
  }

  let biz, moved = 0;
  if (draft.id) {
    biz = bizById(draft.id);
    for (const e of state.entries) {
      if (e.businessId !== biz.id || isIncome(e) || e.type === 'mileage') continue;
      if (renamed.has(e.category)) { e.category = renamed.get(e.category); continue; }
      if (!finalCats.includes(e.category)) { e.category = FALLBACK_CATEGORY; moved++; }
    }
    if ((moved || !finalCats.length) && !finalCats.includes(FALLBACK_CATEGORY)) finalCats.push(FALLBACK_CATEGORY);
    Object.assign(biz, { name, color: draft.color, categories: finalCats });
    // The server applies the same renames to the stored transactions.
    persist('PUT', `/businesses/${encodeURIComponent(biz.id)}`, { ...biz, renames: Object.fromEntries(renamed) });
  } else {
    if (!finalCats.length) finalCats.push(FALLBACK_CATEGORY);
    biz = { id: uid(), name, color: draft.color, categories: finalCats };
    state.businesses.push(biz);
    persist('POST', '/businesses', biz);
  }
  touch();
  bdlg.close();
  render();
  showToast(draft.id
    ? `${biz.name} updated${moved ? ` · ${plural(moved, 'transaction')} moved to “${FALLBACK_CATEGORY}”` : ''}`
    : `${biz.name} added — you can now record its earnings and expenses`);
  afterBizSave?.(biz);
});

$('#bizDelete').addEventListener('click', () => {
  const biz = bizById(draft.id);
  if (!biz) return;
  if (state.businesses.length === 1) { alert('You need at least one business. Add another business before deleting this one.'); return; }
  const count = state.entries.filter((e) => e.businessId === biz.id).length;
  if (!confirm(count ? `Delete “${biz.name}” and its ${plural(count, 'transaction')}?` : `Delete “${biz.name}”?`)) return;
  const snapshot = { businesses: [...state.businesses], entries: [...state.entries], business: state.settings.business };
  state.businesses = state.businesses.filter((b) => b.id !== biz.id);
  state.entries = state.entries.filter((e) => e.businessId !== biz.id);
  if (state.settings.business === biz.id) { state.settings.business = 'all'; saveSettings(); }
  touch();
  persist('DELETE', `/businesses/${encodeURIComponent(biz.id)}`);
  bdlg.close();
  render();
  showToast(`Deleted “${biz.name}”`, () => {
    state.businesses = snapshot.businesses;
    state.entries = snapshot.entries;
    state.settings.business = snapshot.business;
    render();
    replaceAllOnServer();
  });
});

// ---------- Global actions ----------
document.addEventListener('click', (e) => {
  if (e.target.closest('dialog')) return;
  const el = e.target.closest('[data-action]');
  const row = e.target.closest('tr.row[data-id]');
  if (!el && row) { openTx(state.entries.find((x) => x.id === row.dataset.id)); return; }
  if (!el) return;
  const id = el.closest('[data-id]')?.dataset.id;
  const entry = id && state.entries.find((x) => x.id === id);
  switch (el.dataset.action) {
    case 'new-tx': openTx(null, { type: el.dataset.type, businessId: el.dataset.biz }); break;
    case 'edit': openTx(entry); break;
    case 'dup': openTx(entry, { duplicate: true }); break;
    case 'delete': deleteEntry(id); break;
    case 'view-biz':
      setBusinessScope(el.dataset.biz);
      if (['dashboard', 'transactions', 'reports'].includes(state.route)) render();
      else location.hash = '#/dashboard';
      break;
    case 'add-biz': openBiz(null); break;
    case 'add-vehicle': {
      const v = newVehicle(`Vehicle ${state.vehicles.length + 1}`, 'petrol');
      state.vehicles.push(v);
      touch(); render();
      persist('POST', '/vehicles', v);
      $(`[data-vehicle="${v.id}"][data-vfield="name"]`)?.select();
      showToast('Vehicle added — give it a name and fuel type');
      break;
    }
    case 'delete-vehicle': {
      const v = vehicleById(el.dataset.vehicleId);
      if (!v || state.vehicles.length === 1 || state.entries.some((x) => x.type === 'mileage' && x.vehicleId === v.id)) return;
      state.vehicles = state.vehicles.filter((x) => x !== v);
      touch(); render(); showToast(`Deleted “${v.name}”`);
      persist('DELETE', `/vehicles/${encodeURIComponent(v.id)}`);
      break;
    }
    case 'reset-rates': {
      const year = state.rateYear ?? incomeYearOf(todayStr());
      const all = { ...state.settings.kmRates };
      delete all[year];
      state.settings.kmRates = all;
      saveSettings(); render(); showToast(`${incomeYearName(year)} rates reset to IRD's`);
      break;
    }
    case 'edit-biz': openBiz(bizById(el.dataset.biz)); break;
    case 'tx-kind': state.tx.kind = el.dataset.kind; $$('[data-action="tx-kind"]').forEach((b) => b.setAttribute('aria-pressed', b === el)); renderTxTable(); break;
    case 'clear-filters': state.tx = { ...state.tx, q: '', kind: 'all', category: 'all' }; render(); break;
    case 'all-time': state.settings.period = 'all'; saveSettings(); render(); break;
    case 'chart-view': state.chartView = el.dataset.view; render(); break;
    case 'dismiss-onboarding': state.settings.onboardingDismissed = true; saveSettings(); render(); showToast('Guide hidden — you can bring it back in Settings'); break;
    case 'show-onboarding': state.settings.onboardingDismissed = false; saveSettings(); location.hash = '#/dashboard'; break;
    case 'print': window.print(); break;
    case 'export-csv': exportCsv(state.route === 'transactions' ? filteredTx() : byDate(scopedEntries()), false); break;
    case 'export-all': exportCsv(byDate(state.entries), true); break;
    case 'backup': backup(); break;
    case 'restore': $('#restoreFile').click(); break;
    case 'load-sample':
      if (state.entries.length && !confirm('Replace all your businesses and transactions with the sample data?')) return;
      state.businesses = defaultBusinesses();
      if (!state.vehicles.length) state.vehicles = [newVehicle()];
      state.entries = [];
      state.entries = sampleData();
      state.settings.business = 'all';
      touch(); render();
      replaceAllOnServer().then((ok) => { if (ok) showToast('Sample data loaded'); });
      break;
    case 'clear-all': {
      if (!confirm('Delete all of your transactions? Your businesses and categories will be kept.')) return;
      const backupEntries = state.entries;
      state.entries = [];
      touch(); render();
      persist('DELETE', '/entries');
      showToast('All transactions deleted', () => {
        state.entries = backupEntries;
        touch(); render();
        persist('POST', '/entries/bulk', { entries: backupEntries });
      });
      break;
    }
    case 'logout': logout(); break;
    case 'admin-refresh': mountAdmin(); break;
    case 'admin-reset-password': adminResetPassword(+el.dataset.userId, el.dataset.username); break;
    case 'admin-toggle-admin': adminToggleAdmin(+el.dataset.userId, el.dataset.makeAdmin === 'true'); break;
    case 'admin-delete-user': adminDeleteUser(+el.dataset.userId, el.dataset.username); break;
  }
});

document.addEventListener('keydown', (e) => {
  const row = e.target.closest?.('tr.row[data-id]');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openTx(state.entries.find((x) => x.id === row.dataset.id));
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (!typing && !dlg.open && !bdlg.open && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openTx();
  }
});

// ---------- Export / backup ----------
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet apps treating text as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function exportCsv(list, everything) {
  if (!list.length) { showToast('Nothing to export for this selection'); return; }
  const rows = [['Date', 'Business', 'Type', 'Description', 'Category', 'Details', 'Earnings', 'Expense', 'Km', 'Note']];
  for (const e of list) {
    rows.push([e.date, bizName(e.businessId), TYPE_LABEL[e.type], e.name, e.category, detailOf(e),
      isIncome(e) ? e.amount.toFixed(2) : '', !isIncome(e) ? expenseOf(e).toFixed(2) : '', e.type === 'mileage' ? e.km : '', e.note]);
  }
  rows.push([]);
  const ids = [...new Set(list.map((e) => e.businessId))];
  for (const id of ids.length > 1 ? ids : []) {
    const bt = totals(list.filter((e) => e.businessId === id));
    rows.push(['', bizName(id), '', 'Total', '', `Net profit ${bt.profit.toFixed(2)}`, bt.income.toFixed(2), bt.expense.toFixed(2)]);
  }
  const t = totals(list);
  rows.push(['', ids.length > 1 ? 'All businesses' : bizName(ids[0]), '', 'Total', '', `Net profit ${t.profit.toFixed(2)}`, t.income.toFixed(2), t.expense.toFixed(2)]);
  const slug = (everything ? 'all' : `${selectedBiz()?.name || 'all-businesses'}-${state.settings.period}`).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  download(`ledgerly-${slug}-${todayStr()}.csv`, '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  showToast(`Exported ${plural(list.length, 'transaction')}`);
}
function backup() {
  state.settings.lastBackup = todayStr();
  saveSettings();
  download(`ledgerly-backup-${todayStr()}.json`, JSON.stringify({
    app: 'ledgerly', version: DATA_VERSION, businesses: state.businesses, vehicles: state.vehicles, entries: state.entries, settings: state.settings,
  }, null, 2), 'application/json');
  render();
  showToast('Backup downloaded — keep it somewhere safe');
}
$('#restoreFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const raw = Array.isArray(data) ? data : data.entries || [];
    const count = raw.filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && TYPE_LABEL[e.type]).length;
    const bizCount = Array.isArray(data.businesses) ? data.businesses.length : 0;
    if (!count && !bizCount) throw new Error('no businesses or transactions were found in that file');
    if (!confirm(`Replace everything in your account with the ${plural(count, 'transaction')} in “${file.name}”?`)) return;
    const lastBackup = state.settings.lastBackup;
    applyData(data);
    state.settings.lastBackup = state.settings.lastBackup || lastBackup;
    applyTheme(); cacheTheme(); touch(); render();
    if (await replaceAllOnServer()) {
      showToast(`Restored ${plural(state.businesses.length, 'business', 'businesses')} and ${plural(state.entries.length, 'transaction')}`);
    }
  } catch (err) {
    alert('Sorry, that file could not be restored: ' + err.message);
  }
});

// ---------- Toast ----------
let toastTimer, toastUndo;
function showToast(msg, undo) {
  $('#toastMsg').textContent = msg;
  toastUndo = undo;
  $('#toastUndo').hidden = !undo;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), undo ? 7000 : 3500);
}
$('#toastUndo').addEventListener('click', () => {
  toastUndo?.();
  toastUndo = null;
  $('#toast').classList.remove('show');
});

// ---------- Start ----------
async function start() {
  applyTheme();
  readRoute();
  $('#view').innerHTML = '<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>Loading your data…</div>';
  try {
    const [me] = await Promise.all([api('GET', '/auth/me'), reloadData()]);
    state.user = me.user;
    state.loaded = true;
    applyTheme();
    render();
  } catch (err) {
    if (err.status === 401) return; // on the way to the sign-in page
    $('#view').innerHTML = `<div class="card">${emptyState({
      title: 'Couldn’t load your data',
      text: err.message,
      actions: '<button class="btn btn-primary" type="button" id="retryLoad">Try again</button>',
    })}</div>`;
    $('#retryLoad').addEventListener('click', start);
  }
}
start();
