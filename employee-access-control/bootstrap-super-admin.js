'use strict';

// One-off operator-invoked bootstrap. This is deliberately not an HTTP endpoint.
// Set DATABASE_URL and SUPER_ADMIN_INITIAL_PASSWORD in the trusted shell environment,
// run once, then remove SUPER_ADMIN_INITIAL_PASSWORD from that environment.
const { getAccessControlPool, initializeAccessControlDatabase } = require('./postgres-db');
const { bootstrapProtectedSuperAdmin } = require('./session-auth');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured in this trusted shell.');
  if (!process.env.SUPER_ADMIN_INITIAL_PASSWORD) throw new Error('SUPER_ADMIN_INITIAL_PASSWORD must be configured in this trusted shell.');
  await initializeAccessControlDatabase();
  const pool = getAccessControlPool();
  try {
    const result = await bootstrapProtectedSuperAdmin(pool, {
      employee_name: process.env.SUPER_ADMIN_NAME || 'Manoob',
      password: process.env.SUPER_ADMIN_INITIAL_PASSWORD
    });
    console.log('Protected Super Admin created:', result.employeeId, result.role, result.status);
    console.log('Remove SUPER_ADMIN_INITIAL_PASSWORD from the shell/service environment now.');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Super Admin bootstrap failed:', error.message || 'Unexpected error');
  process.exitCode = 1;
});
