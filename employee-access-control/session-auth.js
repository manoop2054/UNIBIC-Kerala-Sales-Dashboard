'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = 'eac_session';
const SESSION_TTL_HOURS = 12;
const PASSWORD_MIN_LENGTH = 12;
const SUPER_ADMIN_ID = 'P2PUF7638';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 1024) {
    throw new Error('Password must be between 12 and 1024 characters.');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return 'scrypt$16384$8$1$' + salt.toString('base64url') + '$' + Buffer.from(derived).toString('base64url');
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (N !== 16384 || r !== 8 || p !== 1) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch (_) { return false; }
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = Buffer.from(await scrypt(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 }));
  return crypto.timingSafeEqual(actual, expected);
}

function extractSessionToken(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = part.slice(separator + 1).trim();
      return /^[A-Za-z0-9_-]{40,64}$/.test(value) ? value : '';
    }
  }
  return '';
}

function sessionCookie(token, secure = !['development', 'test'].includes(process.env.NODE_ENV)) {
  return SESSION_COOKIE + '=' + token +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + (SESSION_TTL_HOURS * 60 * 60) +
    (secure ? '; Secure' : '');
}

function clearSessionCookie(secure = !['development', 'test'].includes(process.env.NODE_ENV)) {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' +
    (secure ? '; Secure' : '');
}

async function createSession(pool, employee) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const role = String(employee.role || '').toUpperCase();
  const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';
  await pool.query(
    `INSERT INTO employee_sessions (session_id_hash, employee_id, is_admin, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 hour'))`,
    [tokenHash, employee.employee_id, isAdmin, SESSION_TTL_HOURS]
  );
  return { token, tokenHash };
}

async function authenticateCredentials(pool, employeeIdInput, password) {
  const employeeId = String(employeeIdInput || '').trim().toUpperCase();
  if (!employeeId || typeof password !== 'string' || !password || password.length > 1024) return null;
  const result = await pool.query(
    `SELECT employee_id, employee_name, designation, role, status, password_hash
     FROM employees WHERE employee_id = $1 LIMIT 1`,
    [employeeId]
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== 'ACTIVE' || !employee.password_hash) return null;
  if (!await verifyPassword(password, employee.password_hash)) return null;
  const session = await createSession(pool, employee);
  return {
    token: session.token,
    user: {
      employeeId: employee.employee_id,
      employeeName: employee.employee_name,
      designation: employee.designation || '',
      role: employee.role
    }
  };
}

async function resolveSession(pool, token) {
  if (!token) return null;
  const tokenHash = sha256(token);
  const result = await pool.query(
    `SELECT s.session_id_hash, e.employee_id, e.employee_name, e.designation, e.role
     FROM employee_sessions s
     JOIN employees e ON e.employee_id = s.employee_id
     WHERE s.session_id_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND e.status = 'ACTIVE'
     LIMIT 1`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionHash: row.session_id_hash,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    designation: row.designation || '',
    role: row.role,
    isAdmin: ['ADMIN', 'SUPER_ADMIN'].includes(String(row.role).toUpperCase())
  };
}

async function revokeSession(pool, token) {
  if (!token) return false;
  const result = await pool.query(
    'UPDATE employee_sessions SET revoked_at = NOW() WHERE session_id_hash = $1 AND revoked_at IS NULL',
    [sha256(token)]
  );
  return Number(result.rowCount || 0) > 0;
}

async function bootstrapProtectedSuperAdmin(pool, input) {
  // This function is used only by the one-off CLI bootstrap script, never an HTTP route.
  const password = input && input.password || process.env.SUPER_ADMIN_INITIAL_PASSWORD;
  const employeeName = String(input && input.employee_name || process.env.SUPER_ADMIN_NAME || 'Manoob').trim().slice(0, 200);
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT employee_id FROM employees WHERE employee_id = $1 FOR UPDATE',
      [SUPER_ADMIN_ID]
    );
    if (existing.rows.length) {
      throw new Error('Protected Super Admin already exists; bootstrap is permanently closed.');
    }
    await client.query(
      `INSERT INTO employees (employee_id, employee_name, designation, role, status, password_hash, updated_at)
       VALUES ($1, $2, $3, 'SUPER_ADMIN', 'ACTIVE', $4, NOW())`,
      [SUPER_ADMIN_ID, employeeName || 'Manoob', 'Super Admin', passwordHash]
    );
    await client.query(
      `INSERT INTO access_audit_log (actor_employee_id, actor_is_admin, action, target_employee_id, details_json)
       VALUES ($1, TRUE, 'SUPER_ADMIN_BOOTSTRAPPED', $1, '{"method":"one-time-env-token"}'::jsonb)`,
      [SUPER_ADMIN_ID]
    );
    await client.query('COMMIT');
    return { employeeId: SUPER_ADMIN_ID, role: 'SUPER_ADMIN', status: 'ACTIVE' };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  SESSION_COOKIE, SESSION_TTL_HOURS, PASSWORD_MIN_LENGTH, SUPER_ADMIN_ID,
  sha256, safeEqualText, hashPassword, verifyPassword, extractSessionToken,
  sessionCookie, clearSessionCookie, createSession, authenticateCredentials,
  resolveSession, revokeSession, bootstrapProtectedSuperAdmin
};
