'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('GSV cache retains Region Name and Area Name source headers for scoped filtering', () => {
  const fields = serverSource.match(/const GSV_FIELDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(fields, 'GSV_FIELDS declaration must exist');
  for (const field of ['Region Name', 'REGION NAME', 'Region_Name', 'REGION_NAME',
                       'Area Name', 'AREA NAME', 'Area_Name', 'AREA_NAME']) {
    assert.ok(fields[1].includes("'" + field + "'"), 'GSV_FIELDS must include ' + field);
  }

  const normalize = serverSource.match(/function normalizeRow\(r\) \{([\s\S]*?)\n\}/);
  assert.ok(normalize, 'normalizeRow function must exist');
  assert.match(normalize[1], /REGION:\s*getVal\(\['REGION','Region','region','Region Name','REGION NAME','Region_Name','REGION_NAME'\]\)/);
  assert.match(normalize[1], /Area:\s*getVal\(\['Area','Area Name','AREA NAME','Area_Name','AREA_NAME'\]\)/);
});
