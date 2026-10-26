// ===== PostgreSQL pool, transactions and migrations =====
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// Return NUMERIC as a string ("10.00") so money never passes through floats.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl);
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: local || /sslmode=disable/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
  max: 10,
});

export const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside BEGIN/COMMIT, rolling back on any error. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), 'migrations');

/** Apply every migrations/*.sql file not yet recorded, in filename order. */
export async function migrate() {
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(MIGRATIONS, f), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    console.log(`  migrated ${f}`);
  }
}
