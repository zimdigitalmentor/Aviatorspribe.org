// ===== Express app: PWA + /api on one origin =====
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { HttpError } from './auth.js';
import account from './routes/account.js';
import payments from './routes/payments.js';
import trackers from './routes/trackers.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');

// Hashes of index.html's inline scripts (splash timer, font loader) so CSP can allow exactly those.
// Browsers hash the text after normalising line endings, so CRLF checkouts must be normalised too.
const inlineHashes = [...readFileSync(join(PUBLIC, 'index.html'), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(([, src]) => `'sha256-${crypto.createHash('sha256').update(src.replace(/\r\n?/g, '\n')).digest('base64')}'`);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);                                // behind Render/Railway/Fly HTTPS proxy

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", 'https://accounts.google.com/gsi/client', ...inlineHashes],
        'style-src': ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style', 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'https://*.googleusercontent.com'],
        'connect-src': ["'self'", 'https://accounts.google.com/gsi/'],
        'frame-src': ['https://accounts.google.com/gsi/'],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': config.production ? [] : null,
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },  // Google sign-in popup
    strictTransportSecurity: config.production,
  }));

  app.use(cookieParser());
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/api/config', (_req, res) => res.json({
    googleClientId: config.googleClientId, supportContact: config.supportContact, paynowMode: config.paynow.mode,
  }));
  app.use('/api', account, payments, trackers);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Not found')));

  app.use(express.static(PUBLIC, {
    setHeaders(res, file) {
      res.set('Cache-Control', 'no-cache');
      if (file.endsWith('sw.js')) res.set('Service-Worker-Allowed', '/');
    },
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.code === '23505' && err.constraint === 'devices_one_active_per_user') {
      err = new HttpError(403, 'device_mismatch', 'This account is registered to another phone');
    }
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'bad_json', 'Invalid JSON');
    if (!(err instanceof HttpError)) {
      console.error(`[${req.method} ${req.originalUrl}]`, err);
      err = new HttpError(500, 'server_error', 'Something went wrong');
    }
    res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  });

  return app;
}
