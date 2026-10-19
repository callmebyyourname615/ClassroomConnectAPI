// Apply this additive migration only; unrelated pending migrations stay pending.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { reportRequestsSchema } = require('../dist/report-requests/report-requests.schema');

(async () => {
  if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST))
    throw new Error('This helper is restricted to the local database. Use the normal migration workflow for remote environments.');
  const db = new Client({ host: process.env.DB_HOST, port: +process.env.DB_PORT,
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query('SELECT pg_advisory_xact_lock($1)', [1791781000]);
    await db.query(reportRequestsSchema);
    await db.query(`INSERT INTO typeorm_migrations(timestamp,name)
      SELECT $1::bigint,$2::varchar WHERE NOT EXISTS(SELECT 1 FROM typeorm_migrations WHERE name=$2::varchar)`,
    [1791781000000, 'CreateOfficialReportRequests1791781000000']);
    await db.query('COMMIT');
    console.log('Official report request table, indexes and migration record are ready. Existing school data is unchanged.');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await db.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
