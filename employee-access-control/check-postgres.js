'use strict';

// Safe diagnostic: verifies a DATABASE_URL connection without printing secrets.
// Run only against the intended Employee Access Control PostgreSQL database.
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not configured.');
    process.exitCode = 2;
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 1000
  });

  try {
    const result = await pool.query(`
      SELECT current_database() AS database_name,
             current_user AS role_name,
             to_regclass('public.employees') AS employees_table,
             to_regclass('public.employee_permissions') AS permissions_table,
             to_regclass('public.employee_sessions') AS sessions_table,
             to_regclass('public.access_audit_log') AS audit_table
    `);
    const row = result.rows[0];
    console.log('PostgreSQL connection: OK');
    console.log('Database:', row.database_name);
    console.log('Role:', row.role_name);
    const schemaReady = Boolean(row.employees_table && row.permissions_table && row.sessions_table && row.audit_table);
    console.log('Employee Access Control schema:', schemaReady ? 'PRESENT' : 'NOT INITIALIZED');
    if (!schemaReady) process.exitCode = 3;
  } catch (error) {
    // Never log connection strings or raw driver errors; messages may contain host details.
    console.error('PostgreSQL connection check failed. Verify DATABASE_URL and Neon network settings.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('PostgreSQL connection check failed unexpectedly.');
  process.exitCode = 1;
});
