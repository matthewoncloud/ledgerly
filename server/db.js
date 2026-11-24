import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/*
 * Every table that holds ledger data is keyed by (user_id, id) and every foreign key includes
 * user_id, so a row can only ever reference rows that belong to the same user — data separation
 * is enforced by the database itself, not just by the queries.
 *
 * Migrations run in order and are tracked with PRAGMA user_version. Never edit a migration that
 * has shipped; add a new one to the end of the list instead.
 */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE user_settings (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data       TEXT    NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE businesses (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id         TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    color      TEXT    NOT NULL,
    categories TEXT    NOT NULL DEFAULT '[]',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE vehicles (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id           TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    fuel         TEXT    NOT NULL,
    business_pct REAL    NOT NULL DEFAULT 100,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE entries (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT    NOT NULL,
    business_id TEXT    NOT NULL,
    type        TEXT    NOT NULL CHECK (type IN ('income', 'expense', 'mileage', 'percent')),
    date        TEXT    NOT NULL,
    name        TEXT    NOT NULL DEFAULT '',
    category    TEXT    NOT NULL DEFAULT '',
    amount      REAL,
    km          REAL,
    vehicle_id  TEXT,
    bill        REAL,
    percent     REAL,
    note        TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id, business_id) REFERENCES businesses(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, vehicle_id)  REFERENCES vehicles(user_id, id)
  );
  CREATE INDEX entries_user_date ON entries(user_id, date);
  CREATE INDEX entries_user_vehicle ON entries(user_id, vehicle_id);

  CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      throw new Error(
        `The data directory "${dir}" is not writable (${err.code || err.message}). ` +
        'If you are using a Docker bind mount, make sure it is owned by UID 1000, e.g. `sudo chown -R 1000:1000 ./data`.',
      );
    }
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Runs fn inside a transaction; rolls back if it throws. Not re-entrant. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getAppSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setAppSetting(db, key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
