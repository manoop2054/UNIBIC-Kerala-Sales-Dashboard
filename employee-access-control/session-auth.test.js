'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('./session-auth');

test('hashes passwords with unique salts and verifies only the matching password', async () => {
  const first = await auth.hashPassword('correct-horse-battery-staple-2026');
  const second = await auth.hashPassword('correct-horse-battery-staple-2026');
  assert.notEqual(first, second);
  assert.equal(await auth.verifyPassword('correct-horse-battery-staple-2026', first), true);
  assert.equal(await auth.verifyPassword('incorrect-password', first), false);
  assert.equal(await auth.verifyPassword('correct-horse-battery-staple-2026', 'plain-text-password'), false);
});

test('requires a strong minimum password length', async () => {
  await assert.rejects(() => auth.hashPassword('short'), /between 12 and 1024/);
});

test('session cookie is HttpOnly, SameSite Strict, and Secure in production', () => {
  const cookie = auth.sessionCookie('abc_DEF-0123456789', true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  assert.equal(auth.clearSessionCookie(true).includes('Max-Age=0'), true);
});

test('extracts only the expected session cookie and rejects malformed tokens', () => {
  assert.equal(auth.extractSessionToken('other=x; eac_session=Abcdefghijklmnopqrstuvwxyz_0123456789-ABCDEFG'), 'Abcdefghijklmnopqrstuvwxyz_0123456789-ABCDEFG');
  assert.equal(auth.extractSessionToken('eac_session=short'), '');
  assert.equal(auth.extractSessionToken('other=validtoken123456789012345678901234567890'), '');
});

test('session IDs are stored as SHA-256 hashes, never as raw tokens', async () => {
  let call;
  const pool = { query: async (sql, params) => { call = { sql, params }; return { rowCount: 1, rows: [] }; } };
  const session = await auth.createSession(pool, { employee_id: 'EMP001', role: 'EMPLOYEE' });
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.tokenHash, auth.sha256(session.token));
  assert.notEqual(call.params[0], session.token);
  assert.equal(call.params[1], 'EMP001');
  assert.equal(call.params[2], false);
});

test('credential login fails closed for inactive, missing-password, or wrong-password accounts', async () => {
  const pool = { query: async () => ({ rows: [{ employee_id: 'EMP001', status: 'INACTIVE', password_hash: await auth.hashPassword('correct-horse-battery-staple-2026') }] }) };
  assert.equal(await auth.authenticateCredentials(pool, 'EMP001', 'correct-horse-battery-staple-2026'), null);
  assert.equal(await auth.authenticateCredentials(pool, 'EMP001', 'wrong-password'), null);
  assert.equal(await auth.authenticateCredentials({ query: async () => ({ rows: [] }) }, 'MISSING', 'any-password-123'), null);
});

test('session resolution requires active, unexpired, unrevoked employee rows', async () => {
  let params;
  const pool = { query: async (_sql, values) => { params = values; return { rows: [{
    session_id_hash: auth.sha256('session-token'), employee_id: 'P2PUF7638',
    employee_name: 'Manoob', designation: 'Super Admin', role: 'SUPER_ADMIN'
  }] }; } };
  const resolved = await auth.resolveSession(pool, 'session-token');
  assert.equal(params[0], auth.sha256('session-token'));
  assert.notEqual(params[0], 'session-token');
  assert.equal(resolved.employeeId, 'P2PUF7638');
  assert.equal(resolved.isAdmin, true);
});

test('revokes sessions by token hash, not raw token', async () => {
  let params;
  const pool = { query: async (_sql, values) => { params = values; return { rowCount: 1 }; } };
  assert.equal(await auth.revokeSession(pool, 'session-token'), true);
  assert.equal(params[0], auth.sha256('session-token'));
});
