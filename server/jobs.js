// ===== Background jobs: poll pending payments, expire stale ones, renewal reminders =====
import cron from 'node-cron';
import { query } from './db.js';
import { pollPayment } from './paynow.js';

/** Pending payments 30 s – 15 min old; every minute for the first 3 min, then every 2 min. */
export async function pollPending() {
  const { rows } = await query(
    `SELECT * FROM payments
     WHERE status = 'pending' AND poll_url IS NOT NULL
       AND created_at < now() - interval '30 seconds' AND created_at > now() - interval '15 minutes'
       AND (created_at > now() - interval '3 minutes' OR last_polled_at IS NULL
            OR last_polled_at < now() - interval '2 minutes')
     ORDER BY created_at LIMIT 50`);
  for (const p of rows) await pollPayment(p);
}

export async function expireStale() {
  await query(`UPDATE payments SET status = 'expired', updated_at = now()
               WHERE status = 'pending' AND created_at < now() - interval '15 minutes'`);
  await query(`DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day'`);
}

/** Users whose access ends within 48 h. Hook an email/SMS sender in here when one is chosen. */
export async function expiryReminders() {
  const { rows } = await query(
    `SELECT u.email, max(s.expires_at) AS expires_at FROM subscriptions s JOIN users u ON u.id = s.user_id
     GROUP BY u.id, u.email HAVING max(s.expires_at) BETWEEN now() AND now() + interval '48 hours'`);
  for (const r of rows) console.log(`[reminder] ${r.email} expires ${r.expires_at.toISOString()}`);
}

const safe = (name, fn) => () => fn().catch((err) => console.error(`[job ${name}]`, err.message));

export function startJobs() {
  cron.schedule('* * * * *', safe('poll', async () => { await pollPending(); await expireStale(); }), { noOverlap: true });
  cron.schedule('0 9 * * *', safe('reminders', expiryReminders), { timezone: 'Africa/Harare' });
}
