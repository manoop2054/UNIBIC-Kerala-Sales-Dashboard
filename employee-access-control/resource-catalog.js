'use strict';

// Canonical resource IDs must match the dashboard's data-tab attributes.
// Report Center is a top-level resource; subreport controls are a separate follow-up mapping.
const RESOURCES = Object.freeze({
  'tab.executive': ['executive dashboard', 'executive'],
  'tab.target': ['target vs achievement', 'target achievement', 'target'],
  'tab.sales': ['sales analysis', 'sales'],
  'tab.item': ['item intelligence', 'item'],
  'tab.dbr': ['dcr from leap', 'dcr', 'claims'],
  'tab.invoice': ['invoice customer', 'invoice / customer', 'invoice'],
  'tab.soh': ['live soh', 'soh', 'live stock'],
  'tab.alerts': ['alerts', 'discount returns'],
  'tab.reports': ['report center', 'reports', 'report'],
  'tab.admincenter': ['admin center', 'admin panel'],
  'tab.upload': ['monthly upload', 'data management', 'upload'],
  'tab.targetworking': ['target management', 'target working'],
  'report.gsv': ['gsv report', 'sales gsv report'],
  'report.target-achievement': ['target vs achievement report', 'target achievement report'],
  'report.dbr-wise': ['dbr-wise report', 'dbr wise report'],
  'report.area-wise': ['area-wise report', 'area wise report'],
  'report.zone-wise': ['zone-wise report', 'zone wise report'],
  'report.anchor-zone-wise': ['anchor zone-wise report', 'anchor zone wise report'],
  'report.customer-wise': ['customer-wise report', 'customer wise report'],
  'report.live-soh-cfa-wise': ['live soh cfa wise', 'live soh – cfa wise', 'live soh cfa-wise'],
  'report.discount-returns': ['discount & returns', 'discount and returns'],
  'report.stock': ['stock report'],
  'report.export-all': ['excel export all reports', 'excel export']
});

const ALIAS_TO_RESOURCE = new Map();
for (const [resourceKey, aliases] of Object.entries(RESOURCES)) {
  ALIAS_TO_RESOURCE.set(normalizeAlias(resourceKey), resourceKey);
  for (const alias of aliases) ALIAS_TO_RESOURCE.set(normalizeAlias(alias), resourceKey);
}

function normalizeAlias(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeResourceKey(value) {
  const key = String(value == null ? '' : value).trim();
  const normalized = normalizeAlias(key);
  const result = ALIAS_TO_RESOURCE.get(normalized);
  if (!result) throw new Error('Unknown dashboard resource: ' + key);
  return result;
}

function normalizeResourceList(values) {
  if (!Array.isArray(values)) throw new Error('Allowed tabs must be an array');
  const result = [...new Set(values.map(normalizeResourceKey))];
  if (!result.length) throw new Error('At least one allowed dashboard resource is required');
  return result;
}

module.exports = { RESOURCES, normalizeAlias, normalizeResourceKey, normalizeResourceList };
