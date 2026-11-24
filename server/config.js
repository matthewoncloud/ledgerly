import path from 'node:path';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v).trim());
const isSet = (v) => v !== undefined && String(v).trim() !== '';

/** Reads configuration from environment variables. `overrides` is used by the tests. */
export function loadConfig(overrides = {}, env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const config = {
    port: Number(env.PORT || 8080),
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbPath: isSet(env.DATABASE_PATH) ? path.resolve(env.DATABASE_PATH) : path.join(dataDir, 'ledgerly.db'),
    // null = not forced; admins can open or close sign-ups from the Settings page.
    allowRegistration: isSet(env.ALLOW_REGISTRATION) ? truthy(env.ALLOW_REGISTRATION) : null,
    sessionDays: Math.max(1, Number(env.SESSION_DAYS || 30)),
    trustProxy: isSet(env.TRUST_PROXY) ? truthy(env.TRUST_PROXY) : false,
    cookieSecure: String(env.COOKIE_SECURE || 'auto').toLowerCase(), // auto | true | false
    logRequests: isSet(env.LOG_REQUESTS) ? truthy(env.LOG_REQUESTS) : false,
    ...overrides,
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`PORT must be a number between 0 and 65535 (got "${env.PORT}")`);
  }
  if (!['auto', 'true', 'false'].includes(config.cookieSecure)) {
    throw new Error('COOKIE_SECURE must be "auto", "true" or "false"');
  }
  return config;
}
