// ===== Configuration from environment (.env is loaded by server.js) =====
const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return v;
}

export const config = {
  production: env.NODE_ENV === 'production',
  port: Number(env.PORT) || 5173,
  baseUrl: (env.PUBLIC_BASE_URL || env.BASE_URL || 'http://localhost:5173').replace(/\/$/, ''),
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),
  googleClientId: required('GOOGLE_CLIENT_ID'),
  adminEmails: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  supportContact: env.SUPPORT_CONTACT || '',
  // Owner absorbs Paynow fees: tiles show "Free". Set to a label such as "2.5%" to show a fee instead.
  feeLabel: env.FEE_LABEL || 'Free',
  paynow: {
    id: env.PAYNOW_INTEGRATION_ID || '',
    key: env.PAYNOW_INTEGRATION_KEY || '',
    mode: env.PAYNOW_MODE === 'live' ? 'live' : 'test',
    testAuthEmail: env.PAYNOW_TEST_AUTHEMAIL || env.PAYNOW_EMAIL || '',
    // Visa/Mastercard stays "Coming soon" until the merchant account is verified.
    cardsEnabled: env.PAYNOW_CARDS_ENABLED === 'true',
  },
  runJobs: env.RUN_JOBS !== 'false',
  // Per-IP limit on Google sign-in / phone moves per 10 min. Mobile carriers share IPs (CGNAT), so keep it generous.
  authRateLimit: Number(env.AUTH_RATE_LIMIT) || 100,
};

if (config.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
