// Give an account days of access without a Paynow payment (e.g. paid in cash). Stacks on any time left.
// Usage: node scripts/grant-access.js <email or user id> [days=30]
try { process.loadEnvFile(); } catch { /* use the real environment */ }

const [who, days = '30'] = process.argv.slice(2);
if (!who) { console.error('Usage: node scripts/grant-access.js <email or user id> [days=30]'); process.exit(1); }

const { grantAccess } = await import('../server/routes/account.js');
const { pool } = await import('../server/db.js');
try {
  console.log(await grantAccess(who, Number(days)));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
