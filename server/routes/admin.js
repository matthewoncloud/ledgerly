import { HttpError } from '../http.js';
import { transaction, setAppSetting } from '../db.js';
import { hashPassword } from '../auth.js';
import { cleanUsername, checkPassword, createUser, adminCount, registrationOpen, publicUser } from './auth.js';

/** Server administration: user accounts and sign-up policy. Admins never see other users' ledgers. */
export function adminRoutes(router, { db, config }) {
  const admin = { admin: true };
  const findUser = (id) => {
    const user = Number.isSafeInteger(+id) ? db.prepare('SELECT * FROM users WHERE id = ?').get(+id) : null;
    if (!user) throw new HttpError(404, 'That user was not found.');
    return user;
  };

  router.get('/api/admin/users', () => ({
    users: db.prepare('SELECT id, username, is_admin, created_at, last_login_at FROM users ORDER BY created_at').all()
      .map((u) => ({ ...publicUser(u), lastLoginAt: u.last_login_at })),
  }), admin);

  router.post('/api/admin/users', async (ctx) => {
    const username = cleanUsername(ctx.body.username);
    const passwordHash = await hashPassword(checkPassword(ctx.body.password));
    const user = transaction(db, () => {
      const id = createUser(db, { username, passwordHash, isAdmin: ctx.body.isAdmin === true });
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    });
    ctx.status = 201;
    return { user: publicUser(user) };
  }, admin);

  router.put('/api/admin/users/:id', async (ctx) => {
    const user = findUser(ctx.params.id);
    const passwordHash = ctx.body.password !== undefined ? await hashPassword(checkPassword(ctx.body.password)) : null;
    transaction(db, () => {
      if (typeof ctx.body.isAdmin === 'boolean') {
        if (!ctx.body.isAdmin && user.is_admin && adminCount(db) === 1) {
          throw new HttpError(409, 'There must be at least one administrator.');
        }
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(ctx.body.isAdmin ? 1 : 0, user.id);
      }
      if (passwordHash) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // sign them out everywhere
      }
    });
    return { user: publicUser(findUser(user.id)) };
  }, admin);

  router.delete('/api/admin/users/:id', (ctx) => {
    const user = findUser(ctx.params.id);
    if (user.id === ctx.user.id) throw new HttpError(409, 'You can’t delete your own account here. Use “Delete my account” instead.');
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // all their data cascades
    return { ok: true };
  }, admin);

  router.get('/api/admin/settings', () => ({
    registrationOpen: !!registrationOpen(db, config),
    registrationLocked: config.allowRegistration !== null,
  }), admin);

  router.put('/api/admin/settings', (ctx) => {
    if (typeof ctx.body.registrationOpen === 'boolean') {
      if (config.allowRegistration !== null) {
        throw new HttpError(409, 'Sign-ups are set by the ALLOW_REGISTRATION environment variable on this server.');
      }
      setAppSetting(db, 'registrationOpen', ctx.body.registrationOpen);
    }
    return { registrationOpen: !!registrationOpen(db, config), registrationLocked: config.allowRegistration !== null };
  }, admin);
}
