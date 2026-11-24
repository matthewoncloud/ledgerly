import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };
export const SESSION_COOKIE = 'ledgerly_session';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

// Used when a username doesn't exist, so failed logins take the same time either way.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(db, userId, { days, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), userId, now, now + days * 86400_000, String(userAgent || '').slice(0, 200));
  return token;
}

/** Looks up a session and its user. Sessions slide: they are extended once half their lifetime has passed. */
export function getSession(db, token, { days }) {
  if (!token || token.length > 200) return null;
  const tokenHash = hashToken(token);
  const row = db.prepare(`
    SELECT s.token_hash, s.expires_at, u.id, u.username, u.is_admin, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(tokenHash);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  const lifetime = days * 86400_000;
  let renewed = false;
  if (row.expires_at - now < lifetime / 2) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + lifetime, tokenHash);
    renewed = true;
  }
  return {
    tokenHash,
    renewed,
    user: { id: row.id, username: row.username, isAdmin: !!row.is_admin, createdAt: row.created_at },
  };
}

export function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

/** Fixed-window rate limiter kept in memory (fine for a single self-hosted instance). */
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  /** Records a hit; returns seconds to wait if the key is over its limit, otherwise 0. */
  hit(key) {
    const now = Date.now();
    let rec = this.hits.get(key);
    if (!rec || rec.reset <= now) {
      rec = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, rec);
    }
    rec.count++;
    if (this.hits.size > 10_000) this.prune(now);
    return rec.count > this.max ? Math.ceil((rec.reset - now) / 1000) : 0;
  }

  reset(key) {
    this.hits.delete(key);
  }

  prune(now = Date.now()) {
    for (const [k, rec] of this.hits) if (rec.reset <= now) this.hits.delete(k);
  }
}
