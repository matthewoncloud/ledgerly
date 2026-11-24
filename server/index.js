import { loadConfig } from './config.js';
import { createApp, VERSION } from './app.js';

let config;
let app;
try {
  config = loadConfig();
  app = createApp(config);
} catch (err) {
  console.error(`Ledgerly could not start: ${err.message}`);
  process.exit(1);
}

app.server.listen(config.port, config.host, () => {
  const { port } = app.server.address();
  console.log(`Ledgerly ${VERSION} listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
  console.log(`Database: ${config.dbPath}`);
  if (config.allowRegistration !== null) console.log(`Sign-ups ${config.allowRegistration ? 'open' : 'closed'} (ALLOW_REGISTRATION)`);
});

app.server.on('error', (err) => {
  console.error(`Ledgerly could not listen on port ${config.port}: ${err.message}`);
  process.exit(1);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
