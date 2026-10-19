// Apply only the new additive Montessori migration, without running unrelated pending migrations.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { montessoriSchema } = require('../src/montessori/montessori.schema');
const name = 'CreateMontessoriReports1791780000000';
(async () => {
  if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST))
    throw new Error(
      'This helper is restricted to the local development database. Use the normal migration workflow for remote environments.',
    );
  const client = new Client({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [1791780000]);
    await client.query(montessoriSchema);
    await client.query(
      'INSERT INTO typeorm_migrations(timestamp,name) SELECT $1::bigint,$2::varchar WHERE NOT EXISTS (SELECT 1 FROM typeorm_migrations WHERE name=$2::varchar)',
      [1791780000000, name],
    );
    await client.query('COMMIT');
    console.log(
      'Montessori tables, indexes and migration record are ready. Existing report data is unchanged.',
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
