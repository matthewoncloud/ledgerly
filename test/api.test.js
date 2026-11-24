import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

let app;
let base;
let tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-test-'));
  const config = loadConfig({ port: 0, host: '127.0.0.1', dbPath: path.join(tmp, 'test.db'), allowRegistration: null }, {});
  app = createApp(config, { logger: { log() {}, error: console.error } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A tiny cookie-keeping client, one per simulated browser. */
function client() {
  let cookie = '';
  async function call(method, url, body, { headers = {} } = {}) {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (u, o) => call('GET', u, undefined, o),
    post: (u, b = {}, o) => call('POST', u, b, o),
    put: (u, b = {}, o) => call('PUT', u, b, o),
    del: (u, b, o) => call('DELETE', u, b, o),
    raw: call,
    get cookie() { return cookie; },
  };
}

const alice = client();
const bob = client();
const carol = client();
let aliceData;

test('health check and first-run config', async () => {
  const anon = client();
  assert.equal((await anon.get('/api/health')).data.status, 'ok');
  const cfg = await anon.get('/api/auth/config');
  assert.deepEqual(cfg.data, { setupRequired: true, registrationOpen: false });
});

test('pages redirect to login when signed out', async () => {
  const anon = client();
  const res = await anon.get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  assert.equal((await anon.get('/login')).status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('API requires a session', async () => {
  const anon = client();
  assert.equal((await anon.get('/api/data')).status, 401);
  assert.equal((await anon.post('/api/entries', {})).status, 401);
});

test('first user becomes admin; sign-ups are then closed', async () => {
  const res = await alice.post('/api/auth/register', { username: 'alice', password: 'correct horse' });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.isAdmin, true);
  assert.ok(alice.cookie.startsWith('ledgerly_session='));
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);

  const blocked = await bob.post('/api/auth/register', { username: 'bob', password: 'password123' });
  assert.equal(blocked.status, 403);
});

test('new accounts start with a business and a vehicle', async () => {
  const res = await alice.get('/api/data');
  assert.equal(res.status, 200);
  assert.equal(res.data.businesses.length, 1);
  assert.equal(res.data.vehicles.length, 1);
  assert.deepEqual(res.data.entries, []);
  aliceData = res.data;
});

test('admin can open sign-ups; non-admins cannot use admin routes', async () => {
  assert.equal((await alice.put('/api/admin/settings', { registrationOpen: true })).data.registrationOpen, true);
  const res = await bob.post('/api/auth/register', { username: 'bob', password: 'password123' });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.isAdmin, false);
  assert.equal((await bob.get('/api/admin/users')).status, 403);
  assert.equal((await bob.put('/api/admin/settings', { registrationOpen: false })).status, 403);
  const dup = await client().post('/api/auth/register', { username: 'BOB', password: 'password123' });
  assert.equal(dup.status, 409);
});

test('login, wrong password and logout', async () => {
  const c = client();
  assert.equal((await c.post('/api/auth/login', { username: 'alice', password: 'nope-nope' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'nobody', password: 'nope-nope' })).status, 401);
  const ok = await c.post('/api/auth/login', { username: 'ALICE', password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/auth/me')).data.user.username, 'alice');
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('CSRF: non-JSON and cross-site writes are rejected', async () => {
  const form = await alice.raw('POST', '/api/entries', undefined, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  const cross = await alice.post('/api/entries', {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403);
});

test('creating, editing and deleting transactions', async () => {
  const biz = aliceData.businesses[0];
  const vehicle = aliceData.vehicles[0];
  const income = { id: 'inc1', businessId: biz.id, type: 'income', date: '2026-05-01', name: 'Client', category: 'Payments', amount: 100.456 };
  const r1 = await alice.post('/api/entries', income);
  assert.equal(r1.status, 201);
  assert.equal(r1.data.entry.amount, 100.46);
  assert.equal((await alice.post('/api/entries', income)).status, 409);

  const trip = { id: 'trip1', businessId: biz.id, type: 'mileage', date: '2026-05-02', name: 'Trip', km: 42, vehicleId: vehicle.id };
  assert.equal((await alice.post('/api/entries', trip)).status, 201);
  const bill = { id: 'bill1', businessId: biz.id, type: 'percent', date: '2026-05-03', name: 'Phone', category: 'Phone & internet', bill: 50, percent: 90 };
  assert.equal((await alice.post('/api/entries', bill)).status, 201);

  assert.equal((await alice.put('/api/entries/inc1', { ...income, amount: 200 })).data.entry.amount, 200);
  assert.equal((await alice.post('/api/entries', { ...income, id: 'bad', date: '2026-02-30' })).status, 400);
  assert.equal((await alice.post('/api/entries', { ...income, id: 'bad', type: 'gift' })).status, 400);
  assert.equal((await alice.post('/api/entries', { ...income, id: 'bad', amount: -5 })).status, 400);

  const data = (await alice.get('/api/data')).data;
  assert.deepEqual(data.entries.map((e) => e.id), ['inc1', 'trip1', 'bill1']);
  assert.equal(data.entries[1].category, 'Motor vehicle (km rates)');
});

test('data separation: users cannot see or touch each other’s data', async () => {
  const bobData = (await bob.get('/api/data')).data;
  assert.equal(bobData.entries.length, 0, 'bob sees none of alice’s transactions');
  assert.notEqual(bobData.businesses[0].id, aliceData.businesses[0].id);

  const aliceBiz = aliceData.businesses[0].id;
  const aliceVehicle = aliceData.vehicles[0].id;
  // Bob can't edit, delete or attach things to alice's records.
  assert.equal((await bob.put('/api/entries/inc1', { id: 'inc1', businessId: bobData.businesses[0].id, type: 'income', date: '2026-01-01', amount: 1 })).status, 404);
  assert.equal((await bob.del('/api/entries/inc1')).status, 404);
  assert.equal((await bob.post('/api/entries', { id: 'x1', businessId: aliceBiz, type: 'income', date: '2026-01-01', amount: 1 })).status, 400);
  assert.equal((await bob.post('/api/entries', { id: 'x2', businessId: bobData.businesses[0].id, type: 'mileage', date: '2026-01-01', km: 5, vehicleId: aliceVehicle })).status, 400);
  assert.equal((await bob.put(`/api/businesses/${aliceBiz}`, { name: 'Hacked', categories: [] })).status, 404);
  assert.equal((await bob.del(`/api/businesses/${aliceBiz}`)).status, 404);
  assert.equal((await bob.put(`/api/vehicles/${aliceVehicle}`, { name: 'Hacked', fuel: 'petrol' })).status, 404);
  assert.equal((await bob.del(`/api/vehicles/${aliceVehicle}`)).status, 404);

  // The same ids can exist for both users without clashing.
  const same = await bob.post('/api/entries', { id: 'inc1', businessId: bobData.businesses[0].id, type: 'income', date: '2026-01-01', amount: 7 });
  assert.equal(same.status, 201);
  // Bob wiping his data leaves alice's alone.
  assert.equal((await bob.del('/api/entries')).data.deleted, 1);
  assert.equal((await alice.get('/api/data')).data.entries.length, 3);
  const aliceEntry = (await alice.get('/api/data')).data.entries.find((e) => e.id === 'inc1');
  assert.equal(aliceEntry.amount, 200);
});

test('business editor renames and removes categories on existing transactions', async () => {
  const biz = aliceData.businesses[0];
  const res = await alice.put(`/api/businesses/${biz.id}`, {
    name: 'Consulting', color: '#0e9384', categories: ['Telecoms', 'Equipment'], renames: { 'Phone & internet': 'Telecoms' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.moved, 0);
  let data = (await alice.get('/api/data')).data;
  assert.equal(data.entries.find((e) => e.id === 'bill1').category, 'Telecoms');

  const res2 = await alice.put(`/api/businesses/${biz.id}`, { name: 'Consulting', color: '#0e9384', categories: ['Equipment'], renames: {} });
  assert.equal(res2.data.moved, 1);
  assert.deepEqual(res2.data.business.categories, ['Equipment', 'Other expenses']);
  data = (await alice.get('/api/data')).data;
  assert.equal(data.entries.find((e) => e.id === 'bill1').category, 'Other expenses');
});

test('vehicle and business delete rules', async () => {
  const vehicle = aliceData.vehicles[0];
  assert.equal((await alice.del(`/api/vehicles/${vehicle.id}`)).status, 409, 'last vehicle');
  const v2 = await alice.post('/api/vehicles', { id: 'v2', name: 'Van', fuel: 'diesel', businessPct: 60 });
  assert.equal(v2.status, 201);
  assert.equal((await alice.del(`/api/vehicles/${vehicle.id}`)).status, 409, 'vehicle with trips');
  assert.equal((await alice.del('/api/vehicles/v2')).status, 200);

  const biz = aliceData.businesses[0];
  assert.equal((await alice.del(`/api/businesses/${biz.id}`)).status, 409, 'last business');
  assert.equal((await alice.post('/api/businesses', { id: 'b2', name: 'Shop', color: '#e11d48', categories: ['Stock'] })).status, 201);
  assert.equal((await alice.post('/api/entries', { id: 'shop1', businessId: 'b2', type: 'expense', date: '2026-06-01', name: 'Boxes', category: 'Stock', amount: 9 })).status, 201);
  const del = await alice.del('/api/businesses/b2');
  assert.equal(del.data.deletedEntries, 1);
  assert.equal((await alice.get('/api/data')).data.entries.some((e) => e.id === 'shop1'), false);
});

test('settings are sanitised and stored per user', async () => {
  const res = await alice.put('/api/settings', { ownerName: 'Alice', taxRate: 25, theme: 'dark', evil: '<script>', kmRates: { 2025: { petrol: [1, 0.5], rocket: [9, 9] } } });
  assert.deepEqual(res.data.settings, { ownerName: 'Alice', taxRate: 25, theme: 'dark', kmRates: { 2025: { petrol: [1, 0.5] } } });
  assert.equal((await alice.get('/api/data')).data.settings.ownerName, 'Alice');
  assert.equal((await bob.get('/api/data')).data.settings.ownerName, undefined);
});

test('restore replaces everything and keeps transaction order', async () => {
  const backup = (await alice.get('/api/export')).data;
  assert.equal(backup.app, 'ledgerly');
  const payload = {
    businesses: [{ id: 'r1', name: 'Restored', color: '#7a5af8', categories: ['A'] }],
    vehicles: [{ id: 'rv', name: 'Car', fuel: 'electric', businessPct: 80 }],
    entries: [
      { id: 'e2', businessId: 'r1', type: 'income', date: '2026-04-02', name: 'Second', amount: 2 },
      { id: 'e1', businessId: 'r1', type: 'income', date: '2026-04-02', name: 'First', amount: 1 },
    ],
    settings: { ownerName: 'Restored Alice' },
  };
  assert.equal((await alice.put('/api/data', payload)).status, 200);
  let data = (await alice.get('/api/data')).data;
  assert.deepEqual(data.entries.map((e) => e.id), ['e2', 'e1']);
  assert.equal(data.settings.ownerName, 'Restored Alice');

  // Invalid restores change nothing.
  const broken = { ...payload, entries: [{ id: 'z', businessId: 'missing', type: 'income', date: '2026-01-01', amount: 1 }] };
  assert.equal((await alice.put('/api/data', broken)).status, 400);
  assert.equal((await alice.get('/api/data')).data.entries.length, 2);

  // Put the original data back.
  assert.equal((await alice.put('/api/data', backup)).status, 200);
  data = (await alice.get('/api/data')).data;
  assert.deepEqual(data.entries.map((e) => e.id), backup.entries.map((e) => e.id));
});

test('bulk insert (undo of “delete all”)', async () => {
  const before = (await alice.get('/api/data')).data.entries;
  assert.equal((await alice.del('/api/entries')).data.deleted, before.length);
  assert.equal((await alice.post('/api/entries/bulk', { entries: before })).data.added, before.length);
  assert.deepEqual((await alice.get('/api/data')).data.entries.map((e) => e.id), before.map((e) => e.id));
});

test('changing password signs out other sessions', async () => {
  const other = client();
  await other.post('/api/auth/login', { username: 'bob', password: 'password123' });
  assert.equal((await bob.put('/api/auth/password', { currentPassword: 'wrong-pass', newPassword: 'newpassword1' })).status, 400);
  assert.equal((await bob.put('/api/auth/password', { currentPassword: 'password123', newPassword: 'short' })).status, 400);
  assert.equal((await bob.put('/api/auth/password', { currentPassword: 'password123', newPassword: 'newpassword1' })).status, 200);
  assert.equal((await bob.get('/api/auth/me')).status, 200, 'current session kept');
  assert.equal((await other.get('/api/auth/me')).status, 401, 'other session revoked');
});

test('admin manages users without seeing their data', async () => {
  const created = await alice.post('/api/admin/users', { username: 'carol', password: 'carolpass1' });
  assert.equal(created.status, 201);
  const list = (await alice.get('/api/admin/users')).data.users;
  assert.deepEqual(list.map((u) => u.username), ['alice', 'bob', 'carol']);
  assert.ok(list.every((u) => !('password_hash' in u) && !('passwordHash' in u)));

  assert.equal((await carol.post('/api/auth/login', { username: 'carol', password: 'carolpass1' })).status, 200);
  const carolId = created.data.user.id;
  assert.equal((await alice.put(`/api/admin/users/${carolId}`, { password: 'resetpass1' })).status, 200);
  assert.equal((await carol.get('/api/auth/me')).status, 401, 'password reset signs the user out');

  const aliceId = list[0].id;
  assert.equal((await alice.put(`/api/admin/users/${aliceId}`, { isAdmin: false })).status, 409, 'last admin');
  assert.equal((await alice.del(`/api/admin/users/${aliceId}`)).status, 409, 'cannot delete self');
  assert.equal((await alice.del(`/api/admin/users/${carolId}`)).status, 200);
  assert.equal((await carol.post('/api/auth/login', { username: 'carol', password: 'resetpass1' })).status, 401);
});

test('deleting an account removes all of its data', async () => {
  await bob.post('/api/entries', { id: 'b-e1', businessId: (await bob.get('/api/data')).data.businesses[0].id, type: 'income', date: '2026-01-01', amount: 5 });
  assert.equal((await bob.post('/api/auth/delete-account', { password: 'wrong' })).status, 400);
  assert.equal((await bob.post('/api/auth/delete-account', { password: 'newpassword1' })).status, 200);
  assert.equal((await bob.get('/api/data')).status, 401);
  const left = app.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE id = 'b-e1'").get().n;
  assert.equal(left, 0);
  assert.equal((await alice.post('/api/auth/delete-account', { password: 'correct horse' })).status, 200, 'only user left, so the admin may leave');
});

test('login is rate limited', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 12; i++) last = await c.post('/api/auth/login', { username: 'ratelimited', password: 'wrong-password' });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});
