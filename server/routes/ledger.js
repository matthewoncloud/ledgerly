import { HttpError } from '../http.js';
import { transaction } from '../db.js';
import {
  LIMITS, DATA_VERSION, loadLedger, sanitizeSettings, writeSettings, validateBusiness, validateVehicle, validateEntry,
  insertBusiness, updateBusiness, insertVehicle, insertEntry, updateEntry, insertEntries, assertEntryRefs,
  replaceLedger, entryExists,
} from '../ledger.js';

const BIG = { bodyLimit: 25 * 1024 * 1024 }; // restores and bulk inserts can be large
const notFound = (what) => new HttpError(404, `That ${what} was not found.`);
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

/** Ledger API. Every handler only ever touches rows where user_id is the signed-in user. */
export function ledgerRoutes(router, { db }) {
  // ----- Everything at once -----
  router.get('/api/data', (ctx) => loadLedger(db, ctx.user.id));

  router.put('/api/data', (ctx) => replaceLedger(db, ctx.user.id, ctx.body), BIG);

  router.get('/api/export', (ctx) => {
    const data = loadLedger(db, ctx.user.id);
    const day = new Date().toISOString().slice(0, 10);
    ctx.res.setHeader('Content-Disposition', `attachment; filename="ledgerly-backup-${day}.json"`);
    return { app: 'ledgerly', version: DATA_VERSION, exportedAt: new Date().toISOString(), ...data };
  });

  // ----- Settings -----
  router.put('/api/settings', (ctx) => {
    const settings = sanitizeSettings(ctx.body);
    writeSettings(db, ctx.user.id, settings);
    return { settings };
  });

  // ----- Businesses -----
  router.post('/api/businesses', (ctx) => {
    const b = validateBusiness(ctx.body, { requireId: false });
    return transaction(db, () => {
      if (count(db, 'SELECT COUNT(*) AS n FROM businesses WHERE user_id = ?', ctx.user.id) >= LIMITS.businesses) {
        throw new HttpError(409, `You can have at most ${LIMITS.businesses} businesses.`);
      }
      try {
        insertBusiness(db, ctx.user.id, b);
      } catch (err) {
        if (/UNIQUE|PRIMARY KEY/.test(err.message)) throw new HttpError(409, 'That business already exists.');
        throw err;
      }
      ctx.status = 201;
      return { business: b };
    });
  });

  router.put('/api/businesses/:id', (ctx) => transaction(db, () => updateBusiness(db, ctx.user.id, ctx.params.id, ctx.body)));

  router.delete('/api/businesses/:id', (ctx) => transaction(db, () => {
    const uid = ctx.user.id;
    if (!db.prepare('SELECT 1 FROM businesses WHERE user_id = ? AND id = ?').get(uid, ctx.params.id)) throw notFound('business');
    if (count(db, 'SELECT COUNT(*) AS n FROM businesses WHERE user_id = ?', uid) <= 1) {
      throw new HttpError(409, 'You need at least one business. Add another business before deleting this one.');
    }
    const deletedEntries = count(db, 'SELECT COUNT(*) AS n FROM entries WHERE user_id = ? AND business_id = ?', uid, ctx.params.id);
    db.prepare('DELETE FROM businesses WHERE user_id = ? AND id = ?').run(uid, ctx.params.id); // entries cascade
    return { ok: true, deletedEntries };
  }));

  // ----- Vehicles -----
  router.post('/api/vehicles', (ctx) => {
    const v = validateVehicle(ctx.body, { requireId: false });
    return transaction(db, () => {
      if (count(db, 'SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?', ctx.user.id) >= LIMITS.vehicles) {
        throw new HttpError(409, `You can have at most ${LIMITS.vehicles} vehicles.`);
      }
      try {
        insertVehicle(db, ctx.user.id, v);
      } catch (err) {
        if (/UNIQUE|PRIMARY KEY/.test(err.message)) throw new HttpError(409, 'That vehicle already exists.');
        throw err;
      }
      ctx.status = 201;
      return { vehicle: v };
    });
  });

  router.put('/api/vehicles/:id', (ctx) => {
    const v = validateVehicle({ ...ctx.body, id: ctx.params.id });
    const { changes } = db.prepare('UPDATE vehicles SET name = ?, fuel = ?, business_pct = ?, updated_at = ? WHERE user_id = ? AND id = ?')
      .run(v.name, v.fuel, v.businessPct, Date.now(), ctx.user.id, v.id);
    if (!changes) throw notFound('vehicle');
    return { vehicle: v };
  });

  router.delete('/api/vehicles/:id', (ctx) => transaction(db, () => {
    const uid = ctx.user.id;
    if (!db.prepare('SELECT 1 FROM vehicles WHERE user_id = ? AND id = ?').get(uid, ctx.params.id)) throw notFound('vehicle');
    if (count(db, 'SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?', uid) <= 1) throw new HttpError(409, 'You need at least one vehicle.');
    if (count(db, 'SELECT COUNT(*) AS n FROM entries WHERE user_id = ? AND vehicle_id = ?', uid, ctx.params.id)) {
      throw new HttpError(409, 'Vehicles with mileage trips can’t be deleted.');
    }
    db.prepare('DELETE FROM vehicles WHERE user_id = ? AND id = ?').run(uid, ctx.params.id);
    return { ok: true };
  }));

  // ----- Transactions -----
  router.post('/api/entries', (ctx) => {
    const e = validateEntry(ctx.body);
    return transaction(db, () => {
      assertEntryRefs(db, ctx.user.id, e);
      if (entryExists(db, ctx.user.id, e.id)) throw new HttpError(409, 'That transaction already exists.');
      if (count(db, 'SELECT COUNT(*) AS n FROM entries WHERE user_id = ?', ctx.user.id) >= LIMITS.entries) {
        throw new HttpError(409, `You can have at most ${LIMITS.entries.toLocaleString('en')} transactions.`);
      }
      insertEntry(db, ctx.user.id, e);
      ctx.status = 201;
      return { entry: e };
    });
  });

  router.post('/api/entries/bulk', (ctx) => transaction(db, () => {
    const added = insertEntries(db, ctx.user.id, ctx.body.entries);
    if (count(db, 'SELECT COUNT(*) AS n FROM entries WHERE user_id = ?', ctx.user.id) > LIMITS.entries) {
      throw new HttpError(409, `You can have at most ${LIMITS.entries.toLocaleString('en')} transactions.`);
    }
    return { added };
  }), BIG);

  router.put('/api/entries/:id', (ctx) => {
    const e = validateEntry({ ...ctx.body, id: ctx.params.id });
    return transaction(db, () => {
      assertEntryRefs(db, ctx.user.id, e);
      if (!updateEntry(db, ctx.user.id, e)) throw notFound('transaction');
      return { entry: e };
    });
  });

  router.delete('/api/entries/:id', (ctx) => {
    const { changes } = db.prepare('DELETE FROM entries WHERE user_id = ? AND id = ?').run(ctx.user.id, ctx.params.id);
    if (!changes) throw notFound('transaction');
    return { ok: true };
  });

  router.delete('/api/entries', (ctx) => {
    const { changes } = db.prepare('DELETE FROM entries WHERE user_id = ?').run(ctx.user.id);
    return { deleted: Number(changes) };
  });
}
