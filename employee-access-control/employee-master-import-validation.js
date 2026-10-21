'use strict';

// Pure validation/normalization for Employee Master rows.
// This module does not write to the database and must be called only by an
// authenticated, server-side import route. Unknown roles receive least privilege.
const { SUPER_ADMIN_EMPLOYEE_ID, SUPER_ADMIN_ROLE } = require('./super-admin-policy');

const REQUIRED_HEADERS = Object.freeze([
  'Employee_ID', 'Employee_Name', 'Designation', 'Role',
  'Region', 'Area', 'Allowed_Tabs', 'Status'
]);
const VALID_STATUS = new Set(['ACTIVE', 'INACTIVE']);
const VALID_ACCESS_ROLES = new Set([
  'SUPER_ADMIN', 'ADMIN', 'REGIONAL_MANAGER', 'AREA_MANAGER',
  'ANCHOR_ZONE_MANAGER', 'EMPLOYEE'
]);

function clean(value) {
  return String(value == null ? '' : value).trim();
}
function key(value) {
  return clean(value).toLowerCase().replace(/[\s_-]+/g, '');
}
function headerMap(headers) {
  const map = new Map();
  for (const header of headers || []) {
    const normalized = key(header);
    if (normalized && !map.has(normalized)) map.set(normalized, clean(header));
  }
  return map;
}
function validateEmployeeMaster(headers, rawRows, options = {}) {
  // actorEmployeeId must come from a verified server-side session, never the uploaded workbook.
  const actorEmployeeId = clean(options.actorEmployeeId).toUpperCase();
  const actorIsSuperAdmin = actorEmployeeId === SUPER_ADMIN_EMPLOYEE_ID;
  const errors = [];
  const warnings = [];
  const normalizedHeaders = headerMap(headers);
  const missingHeaders = REQUIRED_HEADERS.filter(h => !normalizedHeaders.has(key(h)));
  if (missingHeaders.length) {
    return {
      ok: false, rows: [], errors: [{ row: 1, employeeId: '', message: 'Missing required headers: ' + missingHeaders.join(', ') }],
      warnings, summary: { accepted: 0, rejected: (rawRows || []).length, missingHeaders }
    };
  }

  const get = (row, header) => {
    const actual = normalizedHeaders.get(key(header));
    return clean(row && (row[actual] !== undefined ? row[actual] :
      Object.keys(row || {}).find(k => key(k) === key(header)) !== undefined
        ? row[Object.keys(row).find(k => key(k) === key(header))]
        : ''));
  };
  const seen = new Set();
  const accepted = [];
  for (let i = 0; i < (rawRows || []).length; i++) {
    const row = rawRows[i] || {};
    const excelRow = i + 2;
    const employeeId = get(row, 'Employee_ID');
    const name = get(row, 'Employee_Name');
    const designation = get(row, 'Designation');
    const rawRole = get(row, 'Role').toUpperCase().replace(/[\s-]+/g, '_');
    const region = get(row, 'Region');
    const area = get(row, 'Area');
    const anchorZone = get(row, 'Anchor_Zone');
    const dbrId = get(row, 'DBR_ID');
    const dbrName = get(row, 'DBR_Name');
    const allowedTabs = get(row, 'Allowed_Tabs');
    const rawStatus = get(row, 'Status').toUpperCase();
    const effectiveFrom = get(row, 'Effective_From');
    const effectiveTo = get(row, 'Effective_To');
    const remarks = get(row, 'Remarks');

    if (![employeeId, name, designation, rawRole, region, allowedTabs, rawStatus].every(Boolean)) {
      errors.push({ row: excelRow, employeeId, message: 'Employee_ID, Employee_Name, Designation, Region, Area, Allowed_Tabs and Status are required.' });
      continue;
    }
    if (anchorZone && !area) {
      errors.push({ row: excelRow, employeeId, message: 'Anchor_Zone requires Area to be specified.' });
      continue;
    }

    const idKey = employeeId.toUpperCase();
    if (seen.has(idKey)) {
      errors.push({ row: excelRow, employeeId, message: 'Duplicate Employee_ID in this upload.' });
      continue;
    }
    seen.add(idKey);
    if (!VALID_STATUS.has(rawStatus)) {
      errors.push({ row: excelRow, employeeId, message: 'Status must be ACTIVE or INACTIVE.' });
      continue;
    }
    if (effectiveFrom && Number.isNaN(Date.parse(effectiveFrom))) {
      errors.push({ row: excelRow, employeeId, message: 'Effective_From is not a valid date.' });
      continue;
    }
    if (effectiveTo && Number.isNaN(Date.parse(effectiveTo))) {
      errors.push({ row: excelRow, employeeId, message: 'Effective_To is not a valid date.' });
      continue;
    }
    if (effectiveFrom && effectiveTo && Date.parse(effectiveTo) < Date.parse(effectiveFrom)) {
      errors.push({ row: excelRow, employeeId, message: 'Effective_To must not be earlier than Effective_From.' });
      continue;
    }

    const isProtected = employeeId.toUpperCase() === SUPER_ADMIN_EMPLOYEE_ID;
    if (isProtected && !actorIsSuperAdmin) {
      errors.push({ row: excelRow, employeeId, message: 'Only the authenticated Super Admin can include or update the protected Super Admin record.' });
      continue;
    }
    if (rawRole === 'SUPER_ADMIN' && !isProtected) {
      errors.push({ row: excelRow, employeeId, message: 'SUPER_ADMIN is reserved exclusively for the protected employee ID.' });
      continue;
    }
    if (rawRole === 'ADMIN' && !actorIsSuperAdmin) {
      errors.push({ row: excelRow, employeeId, message: 'Only the authenticated Super Admin can grant the ADMIN role.' });
      continue;
    }
    let role;
    if (isProtected) {
      role = SUPER_ADMIN_ROLE;
      if (rawStatus !== 'ACTIVE') warnings.push({ row: excelRow, employeeId, message: 'Protected Super Admin status forced to ACTIVE.' });
      if (rawRole !== SUPER_ADMIN_ROLE) warnings.push({ row: excelRow, employeeId, message: 'Protected Super Admin role forced to SUPER_ADMIN.' });
    } else if (VALID_ACCESS_ROLES.has(rawRole)) {
      role = rawRole;
    } else {
      role = 'EMPLOYEE';
      warnings.push({ row: excelRow, employeeId, message: 'Unrecognized Role "' + get(row, 'Role') + '" mapped to EMPLOYEE (least privilege); keep Designation in its own column.' });
    }

    if (/^ALL ACCESS$/i.test(allowedTabs)) {
      warnings.push({ row: excelRow, employeeId, message: 'All Access is treated as a display label only; resource permissions must be granted separately by an authorized Admin.' });
    }

    accepted.push({
      employeeId, employeeName: name, designation, role,
      region, area, anchorZone, dbrId, dbrName, allowedTabs,
      status: isProtected ? 'ACTIVE' : rawStatus,
      effectiveFrom: effectiveFrom || null,
      effectiveTo: effectiveTo || null,
      remarks,
      protectedSuperAdmin: isProtected
    });
  }
  return {
    ok: errors.length === 0,
    rows: accepted,
    errors,
    warnings,
    summary: { accepted: accepted.length, rejected: errors.length, missingHeaders: [] }
  };
}

module.exports = { REQUIRED_HEADERS, VALID_STATUS, VALID_ACCESS_ROLES, validateEmployeeMaster };
