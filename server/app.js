import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import {
  Router, HttpError, parseCookies, serializeCookie, readJson, sendJson, redirect, setSecurityHeaders, createStaticServer,
} from './http.js';
import { SESSION_COOKIE, createSession, getSession, deleteSession, purgeExpiredSessions } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { ledgerRoutes } from './routes/ledger.js';
import { adminRoutes } from './routes/admin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const DEFAULT_BODY_LIMIT = 256 * 1024;

export function createApp(config, { logger = console } = {}) {
  const db = openDatabase(config.dbPath);
  const router = new Router();
  const serveStatic = createStaticServer(PUBLIC_DIR);

  const clientIp = (req) => {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  };
  const isHttps = (req) => {
    if (config.cookieSecure === 'true') return true;
    if (config.cookieSecure === 'false') return false;
    if (req.socket.encrypted) return true;
    return config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  };
  const sessionCookie = (req, token, maxAge) =>
    serializeCookie(SESSION_COOKIE, token, { maxAge, secure: isHttps(req), httpOnly: true, sameSite: 'Lax' });

  const deps = {
    db,
    config,
    startSession(ctx, userId) {
      const token = createSession(db, userId, { days: config.sessionDays, userAgent: ctx.req.headers['user-agent'] });
      ctx.res.setHeader('Set-Cookie', sessionCookie(ctx.req, token, config.sessionDays * 86400));
    },
    endSession(ctx) {
      deleteSession(db, ctx.cookies[SESSION_COOKIE]);
      ctx.res.setHeader('Set-Cookie', sessionCookie(ctx.req, '', 0));
    },
  };

  router.get('/api/health', () => {
    db.prepare('SELECT 1').get();
    return { status: 'ok', version: VERSION };
  }, { auth: false });
  authRoutes(router, deps);
  ledgerRoutes(router, deps);
  adminRoutes(router, deps);

  async function handleApi(req, res, url, cookies) {
    const match = router.match(req.method, url.pathname);
    if (!match) throw new HttpError(404, 'Not found.');
    if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
    const { route, params } = match;

    const mutating = !['GET', 'HEAD'].includes(req.method);
    if (mutating) {
      // CSRF protection: browsers label cross-site requests, and a JSON content type can't be sent
      // cross-origin without a CORS preflight (which this server never approves).
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        throw new HttpError(415, 'Requests must be sent as JSON (Content-Type: application/json).');
      }
    }

    const session = getSession(db, cookies[SESSION_COOKIE], { days: config.sessionDays });
    if (route.options.auth !== false && !session) throw new HttpError(401, 'Please sign in.');
    if (route.options.admin && !session.user.isAdmin) throw new HttpError(403, 'Only administrators can do that.');
    if (session?.renewed) res.setHeader('Set-Cookie', sessionCookie(req, cookies[SESSION_COOKIE], config.sessionDays * 86400));

    const body = mutating ? await readJson(req, route.options.bodyLimit || DEFAULT_BODY_LIMIT) : {};
    if (mutating && (body === null || typeof body !== 'object' || Array.isArray(body))) {
      throw new HttpError(400, 'The request body must be a JSON object.');
    }
    const ctx = {
      req, res, params, body, cookies, session,
      user: session?.user || null,
      query: url.searchParams,
      ip: clientIp(req),
      status: 200,
    };
    const result = await route.handler(ctx);
    if (!res.headersSent) sendJson(res, ctx.status, result ?? { ok: true });
  }

  function handlePage(req, res, url, cookies) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }
    const signedIn = () => !!getSession(db, cookies[SESSION_COOKIE], { days: config.sessionDays });
    const p = url.pathname;
    let served = false;
    if (p === '/' || p === '/index.html') {
      if (!signedIn()) return redirect(res, '/login');
      served = serveStatic(req, res, '/index.html');
    } else if (p === '/login' || p === '/login.html') {
      if (signedIn()) return redirect(res, '/');
      served = serveStatic(req, res, '/login.html');
    } else if (p === '/favicon.ico') {
      served = serveStatic(req, res, '/assets/favicon.svg');
    } else if (p.startsWith('/assets/')) {
      served = serveStatic(req, res, p);
    }
    if (served) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    setSecurityHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, cookies);
      else handlePage(req, res, url, cookies);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.extra.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
        if (!res.headersSent) sendJson(res, err.status, { error: err.message });
      } else {
        logger.error(`[error] ${req.method} ${url.pathname}:`, err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server.' });
      }
    } finally {
      if (config.logRequests) logger.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;

  purgeExpiredSessions(db);
  const cleanup = setInterval(() => purgeExpiredSessions(db), 60 * 60_000);
  cleanup.unref();

  return {
    server,
    db,
    close() {
      clearInterval(cleanup);
      return new Promise((resolve) => {
        server.close(() => {
          try { db.close(); } catch { /* already closed */ }
          resolve();
        });
        server.closeAllConnections?.();
      });
    },
  };
}
