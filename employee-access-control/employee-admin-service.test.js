'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmployee, saveEmployee } = require('./employee-admin-service');

const actor = { employeeId: 'P2PUF7638', role: 'SUPER_ADMIN' };
const input = {
  employee_id: '1511255', employee_name: 'ARUN V', designation: 'Executive',
  role: 'EMPLOYEE', status: 'ACTIVE', region: 'SOUTH KL', area: 'KOCHI',
  anchor_zone: 'KOCHI CENTRAL', allowed_tabs: ['Executive Dashboard', 'Report Center']
};

test('validates employee and required geographic scope', () => {
  const e = normalizeEmployee(input, actor);
  assert.equal(e.employeeId, '1511255');
  assert.deepEqual(e.allowedTabs, ['Executive Dashboard', 'Report Center']);
  assert.throws(() => normalizeEmployee({ ...input, area: '' }, actor), /Anchor Zone requires an Area/);
});

test('only Super Admin can grant ADMIN and SUPER_ADMIN is reserved', () => {
  assert.throws(() => normalizeEmployee({ ...input, role: 'ADMIN' }, { employeeId: 'EMP1', role: 'ADMIN' }), /Only Super Admin/);
  assert.throws(() => normalizeEmployee({ ...input, employee_id: 'OTHER', role: 'SUPER_ADMIN' }, actor), /reserved/);
});

test('protected Super Admin cannot be deactivated or managed by another admin', () => {
  assert.throws(() => normalizeEmployee({ ...input, employee_id: 'P2PUF7638', status: 'INACTIVE' }, actor), /must remain ACTIVE/);
  assert.throws(() => normalizeEmployee({ ...input, employee_id: 'P2PUF7638' }, { employeeId: 'ADMIN1', role: 'ADMIN' }), /Only Super Admin/);
});

test('ordinary Admin cannot demote an existing Admin account', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT employee_id, role, status FROM employees')) {
        return { rows: [{ employee_id: 'ADMIN002', role: 'ADMIN', status: 'ACTIVE' }] };
      }
      return { rows: [] };
    },
    release: () => calls.push({ sql: 'RELEASE' })
  };
  const pool = { connect: async () => client };
  await assert.rejects(
    () => saveEmployee(pool, { ...input, employee_id: 'ADMIN002', role: 'EMPLOYEE' }, { employeeId: 'ADMIN001', role: 'ADMIN' }),
    /Only Super Admin may manage an existing Admin account/
  );
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(!calls.some(call => call.sql.includes('INSERT INTO employees')));
});

test('rejects invalid dates and empty tabs', () => {
  assert.throws(() => normalizeEmployee({ ...input, effective_from: '2026-12-01', effective_to: '2026-11-01' }, actor), /Effective To/);
  assert.throws(() => normalizeEmployee({ ...input, allowed_tabs: [] }, actor), /At least one allowed tab/);
});

test('inactive employee session revocation is included in transaction', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT employee_id, role, status FROM employees')) return { rows: [] };
      return { rows: [] };
    },
    release: () => calls.push({ sql: 'RELEASE' })
  };
  const pool = { connect: async () => client };
  const result = await saveEmployee(pool, { ...input, status: 'INACTIVE' }, actor);
  assert.equal(result.created, true);
  assert.ok(calls.some(c => c.sql.includes('UPDATE employee_sessions')));
  assert.ok(calls.some(c => c.sql === 'COMMIT'));
  assert.equal(calls.at(-1).sql, 'RELEASE');
});


test('accepts every role in the Employee Master template', () => {
  for (const role of ['EMPLOYEE', 'ADMIN', 'SUPER_ADMIN', 'REGIONAL_MANAGER', 'AREA_MANAGER', 'ANCHOR_ZONE_MANAGER']) {
    const employeeId = role === 'SUPER_ADMIN' ? 'P2PUF7638' : '1511255';
    const result = normalizeEmployee({ ...input, employee_id: employeeId, role, status: 'ACTIVE' }, actor);
    assert.equal(result.role, role);
  }
});
