// Release an account's registered phone so its owner can sign in on a new one.
// Usage: node scripts/reset-device.js <email or user id>
try { process.loadEnvFile(); } catch { /* use the real environment */ }

const who = process.argv[2];
if (!who) { console.error('Usage: node scripts/reset-device.js <email or user id>'); process.exit(1); }

const { resetDevice } = await import('../server/routes/account.js');
const { pool } = await import('../server/db.js');
try {
  console.log(await resetDevice(who));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
