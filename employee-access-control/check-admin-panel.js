'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const file = path.join(__dirname, 'admin-panel-preview.html');
const html = fs.readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) throw new Error('No inline scripts found in Admin Center HTML.');
let checked = 0;
for (const match of scripts) {
  const source = match[1].trim();
  if (!source) continue;
  new vm.Script(source, { filename: file + ':inline-script-' + (++checked) });
}
console.log('Admin Center inline script syntax: OK (' + checked + ' scripts)');
