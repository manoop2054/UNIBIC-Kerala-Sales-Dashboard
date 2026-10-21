'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const files = [
  path.join(__dirname, 'admin-panel-preview.html'),
  path.join(__dirname, '..', 'UNIBIC_Kerala_Sales_Command_Center_FINAL_PATCHED.html')
];
let checked = 0;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  if (!scripts.length) throw new Error('No inline scripts found in ' + file);
  for (const match of scripts) {
    const source = match[1].trim();
    if (!source) continue;
    new vm.Script(source, { filename: file + ':inline-script-' + (++checked) });
  }
}
console.log('Admin Center and dashboard inline script syntax: OK (' + checked + ' scripts)');
