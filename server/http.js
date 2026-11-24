import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** A tiny router: `router.get('/api/things/:id', handler)`. Handlers return a value to send as JSON. */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const keys = [];
    const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler, options });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; }
      });
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key || key in out) continue;
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[key] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path: p = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${p}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(new HttpError(413, 'That request is too large.'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'That request is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (err) => { if (!failed) { failed = true; reject(err); } });
  });
}

export async function readJson(req, limit) {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export function setSecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

export function sendJson(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves files from `root`, with ETags so browsers revalidate cheaply. Returns false if not found. */
export function createStaticServer(root) {
  const cache = new Map(); // path -> { mtimeMs, etag, body, type }
  return function serveStatic(req, res, pathname, { status = 200 } = {}) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return false; }
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) return false;
    let stat;
    try { stat = fs.statSync(file); } catch { return false; }
    if (!stat.isFile()) return false;

    let entry = cache.get(file);
    if (!entry || entry.mtimeMs !== stat.mtimeMs) {
      const body = fs.readFileSync(file);
      entry = {
        mtimeMs: stat.mtimeMs,
        body,
        etag: `"${crypto.createHash('sha1').update(body).digest('base64url')}"`,
        type: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      };
      cache.set(file, entry);
    }
    const headers = { 'Content-Type': entry.type, ETag: entry.etag, 'Cache-Control': 'no-cache' };
    if (status === 200 && req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    res.writeHead(status, { ...headers, 'Content-Length': entry.body.length });
    res.end(req.method === 'HEAD' ? undefined : entry.body);
    return true;
  };
}
