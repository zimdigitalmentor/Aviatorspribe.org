// Aviator Tracker server: `npm start` (or `node server.js`)
// Serves ./public and the /api routes on one origin (http://localhost:5173 in development).
import { networkInterfaces } from 'node:os';

try { process.loadEnvFile(); } catch { /* no .env file: use the real environment */ }

const { config } = await import('./server/config.js');
const { migrate } = await import('./server/db.js');
const { createApp } = await import('./server/app.js');
const { startJobs } = await import('./server/jobs.js');

await migrate();
if (config.runJobs) startJobs();

createApp().listen(config.port, '0.0.0.0', () => {
  console.log(`\n  Aviator Tracker running (Paynow ${config.paynow.mode} mode):\n`);
  console.log(`  Local:    http://localhost:${config.port}`);
  if (!config.production) {
    for (const nets of Object.values(networkInterfaces())) {
      for (const n of nets || []) {
        if (n.family === 'IPv4' && !n.internal) console.log(`  Network:  http://${n.address}:${config.port}`);
      }
    }
    console.log('\n  Google sign-in only works on origins listed in the Cloud Console (localhost or your HTTPS domain).\n');
  }
});
