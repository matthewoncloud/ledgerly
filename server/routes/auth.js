import { HttpError } from '../http.js';
import { transaction, getAppSetting } from '../db.js';
import { hashPassword, verifyPassword, burnPasswordCheck, createSession, deleteSession, RateLimiter } from '../auth.js';
import { seedNewUser } from '../ledger.js';

export const USERNAME_RULE = 'Usernames are 3–64 characters with no spaces (an email address works too).';
const USERNAME_RE = /^[^\s\p{C}]{3,64}$/u;

export function cleanUsername(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!USERNAME_RE.test(s)) throw new HttpError(400, USERNAME_RULE);
  return s;
}

export function checkPassword(v) {
  if (typeof v !== 'string' || v.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  if (v.length > 200) throw new HttpError(400, 'Passwords can be at most 200 characters.');
  return v;
}

export const userCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const adminCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n;
export const registrationOpen = (db, config) => config.allowRegistration ?? getAppSetting(db, 'registrationOpen', false);

/** Creates a user with a starter business and vehicle. Returns the new user's id. */
export function createUser(db, { username, passwordHash, isAdmin }) {
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(username, passwordHash, isAdmin ? 1 : 0, Date.now());
    const id = Number(lastInsertRowid);
    seedNewUser(db, id);
    return id;
  } catch (err) {
    if (/UNIQUE constraint failed: users\.username/.test(err.message)) throw new HttpError(409, 'That username is already taken.');
    throw err;
  }
}

const publicUser = (u) => ({ id: u.id, username: u.username, isAdmin: !!(u.isAdmin ?? u.is_admin), createdAt: u.createdAt ?? u.created_at });

export function authRoutes(router, { db, config, startSession, endSession }) {
  const loginByIp = new RateLimiter({ windowMs: 15 * 60_000, max: 30 });
  const loginByName = new RateLimiter({ windowMs: 15 * 60_000, max: 10 });
  const registerByIp = new RateLimiter({ windowMs: 60 * 60_000, max: 10 });
  const tooMany = (wait) => new HttpError(429, `Too many attempts. Please try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.`, { retryAfter: wait });

  router.get('/api/auth/config', () => ({
    setupRequired: userCount(db) === 0,
    registrationOpen: !!registrationOpen(db, config),
  }), { auth: false });

  router.post('/api/auth/register', async (ctx) => {
    const wait = registerByIp.hit(ctx.ip);
    if (wait) throw tooMany(wait);
    const username = cleanUsername(ctx.body.username);
    const passwordHash = await hashPassword(checkPassword(ctx.body.password));
    const user = transaction(db, () => {
      const first = userCount(db) === 0;
      if (!first && !registrationOpen(db, config)) {
        throw new HttpError(403, 'Sign-ups are closed on this server. Ask the administrator to create an account for you.');
      }
      // The very first account administers the server.
      const id = createUser(db, { username, passwordHash, isAdmin: first });
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    });
    startSession(ctx, user.id);
    ctx.status = 201;
    return { user: publicUser(user) };
  }, { auth: false });

  router.post('/api/auth/login', async (ctx) => {
    const username = typeof ctx.body.username === 'string' ? ctx.body.username.trim().slice(0, 64) : '';
    const password = typeof ctx.body.password === 'string' ? ctx.body.password.slice(0, 200) : '';
    const nameKey = username.toLowerCase();
    const wait = Math.max(loginByIp.hit(ctx.ip), loginByName.hit(nameKey));
    if (wait) throw tooMany(wait);
    const user = username && db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      await burnPasswordCheck(password);
      throw new HttpError(401, 'Incorrect username or password.');
    }
    if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(401, 'Incorrect username or password.');
    loginByName.reset(nameKey);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
    startSession(ctx, user.id);
    return { user: publicUser(user) };
  }, { auth: false });

  router.post('/api/auth/logout', (ctx) => {
    endSession(ctx);
    return { ok: true };
  }, { auth: false });

  router.get('/api/auth/me', (ctx) => ({ user: ctx.user }));

  router.put('/api/auth/password', async (ctx) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id);
    if (!(await verifyPassword(String(ctx.body.currentPassword || ''), row.password_hash))) {
      throw new HttpError(400, 'Your current password is not correct.');
    }
    const hash = await hashPassword(checkPassword(ctx.body.newPassword));
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, ctx.user.id);
      // Sign out everywhere else.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(ctx.user.id, ctx.session.tokenHash);
    });
    return { ok: true };
  });

  router.post('/api/auth/delete-account', async (ctx) => {
    const row = db.prepare('SELECT password_hash, is_admin FROM users WHERE id = ?').get(ctx.user.id);
    if (!(await verifyPassword(String(ctx.body.password || ''), row.password_hash))) {
      throw new HttpError(400, 'That password is not correct.');
    }
    transaction(db, () => {
      if (row.is_admin && adminCount(db) === 1 && userCount(db) > 1) {
        throw new HttpError(409, 'You are the only administrator. Make another user an administrator before deleting your account.');
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(ctx.user.id);
    });
    endSession(ctx);
    return { ok: true };
  });
}

export { publicUser, deleteSession };
