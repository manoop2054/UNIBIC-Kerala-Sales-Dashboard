
'use strict';

const express = require('express');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const app = express();
app.disable('x-powered-by');
app.use(express.static(__dirname, {
  index: false,
  etag: true,
  maxAge: '5m'
}));

const PORT = Number(process.env.PORT || 3000);
const GSV_SHEET = process.env.GSV_SHEET || 'ACX_Sales_Register';
const SOH_SHEET = process.env.SOH_SHEET || 'LIVE STOCK REPORT';

const WAREHOUSES = new Set([
  'ALU CFA', 'ALU-CFA', 'PAY-CFA', 'PAY-DMG',
  'TVD-CFA', 'TVD-DMG', 'HYD PLANT', 'HYD PLANT1',
  'HYD-P', 'BLR1', 'BLR4'
]);

let gsvRows = [];
let sohRows = [];
let gsvLoadedAt = null;
let sohLoadedAt = null;
let gsvLoading = false;
let sohLoading = false;
let lastErrors = { gsv: null, soh: null };

function downloadUrl(raw) {
  const u = new URL(raw);
  u.searchParams.set('download', '1');
  return u.toString();
}

async function fetchToTemp(raw, label) {
  if (!raw) {
    throw new Error(`${label}_SHARE_URL environment variable is not set`);
  }

  const url = downloadUrl(raw);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  if (!res.ok) {
    throw new Error(
      `${label} download failed: HTTP ${res.status}. ` +
      `Check the SharePoint download link and permissions.`
    );
  }

  const type = (res.headers.get('content-type') || '').toLowerCase();

  if (
    type.includes('text/html') ||
    type.includes('application/json')
  ) {
    throw new Error(
      `${label} link returned a web page instead of an Excel file. ` +
      `SharePoint may require a different download link or authentication.`
    );
  }

  const extension = label === 'SOH' ? 'xlsb' : 'xlsx';
  const filename = path.join(
    os.tmpdir(),
    `unibic-${label.toLowerCase()}-${Date.now()}-${Math.random()
      .toString(16).slice(2)}.${extension}`
  );

  try {
    if (!res.body) throw new Error('Empty response from SharePoint');

    await pipeline(
      Readable.fromWeb(res.body),
      fs.createWriteStream(filename)
    );

    const stat = await fs.promises.stat(filename);
    if (stat.size === 0) {
      throw new Error('Downloaded file is empty');
    }

    return filename;
  } catch (e) {
    await fs.promises.unlink(filename).catch(() => {});
    throw e;
  }
}

function rowToObject(headers, values) {
  const obj = {};

  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] ?? '').trim();
    if (!h) continue;

    const v = values[i];

    obj[h] =
      v && typeof v === 'object' && 'text' in v
        ? v.text
        : v && typeof v === 'object' && 'result' in v
          ? v.result
          : (v ?? '');
  }

  return obj;
}

async function loadGSV() {
  if (gsvLoading) return;
  gsvLoading = true;

  let file;

  try {
    file = await fetchToTemp(process.env.GSV_SHARE_URL, 'GSV');

    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(file, {
      worksheets: 'emit',
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      entries: 'ignore'
    });

    let foundSheet = false;
    const fresh = [];

    for await (const worksheet of workbook) {
      if (worksheet.name !== GSV_SHEET) continue;

      foundSheet = true;
      let headers = null;

      for await (const row of worksheet) {
        const vals = row.values.slice(1);

        if (row.number === 1) {
          headers = vals.map(v => v == null ? '' : String(v).trim());
          continue;
        }

        if (!headers) continue;

        const obj = rowToObject(headers, vals);

        if (Object.values(obj).some(v => v !== '' && v != null)) {
          fresh.push(obj);
        }
      }
    }

    if (!foundSheet) {
      throw new Error(`GSV sheet "${GSV_SHEET}" was not found`);
    }

    gsvRows = fresh;
    gsvLoadedAt = new Date().toISOString();
    lastErrors.gsv = null;

    console.log(`GSV loaded: ${gsvRows.length} rows at ${gsvLoadedAt}`);
  } catch (e) {
    lastErrors.gsv = e.message;
    console.error('GSV load failed:', e.message);
  } finally {
    if (file) await fs.promises.unlink(file).catch(() => {});
    gsvLoading = false;
  }
}

function norm(v) {
  return String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

async function loadSOH() {
  if (sohLoading) return;
  sohLoading = true;

  let file;

  try {
    file = await fetchToTemp(process.env.SOH_SHARE_URL, 'SOH');

    const wb = XLSX.readFile(file, {
      cellDates: true,
      dense: false
    });

    const sheet = wb.Sheets[SOH_SHEET];

    if (!sheet) {
      throw new Error(`SOH sheet "${SOH_SHEET}" was not found`);
    }

    const all = XLSX.utils.sheet_to_json(sheet, {
      defval: '',
      raw: false
    });

    sohRows = all.filter(r => {
      const warehouse = norm(
        r.WAREHOUSE || r.Warehouse || r.WAREHOUSE_NAME
      );

      const type = norm(
        r.TYPE || r.Type || r.STOCKTYPE || r['STOCK TYPE']
      );

      return WAREHOUSES.has(warehouse) &&
        (type === 'SOH' || type === 'INTRANSIT');
    });

    sohLoadedAt = new Date().toISOString();
    lastErrors.soh = null;

    console.log(`SOH loaded: ${sohRows.length} rows at ${sohLoadedAt}`);
  } catch (e) {
    lastErrors.soh = e.message;
    console.error('SOH load failed:', e.message);
  } finally {
    if (file) await fs.promises.unlink(file).catch(() => {});
    sohLoading = false;
  }
}

app.get('/api/gsv', (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!gsvLoadedAt && lastErrors.gsv) {
    return res.status(503).json({
      success: false,
      error: lastErrors.gsv,
      data: []
    });
  }

  res.json(gsvRows);
});

app.get('/api/gsv/summary', (req, res) => {
  res.json({
    success: Boolean(gsvLoadedAt),
    service: 'UNIBIC Cloud ERP Bridge',
    status: 'running',
    gsvRows: gsvRows.length,
    gsvLoadedAt,
    loading: gsvLoading,
    error: lastErrors.gsv
  });
});

app.get('/api/live-soh', (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!sohLoadedAt && lastErrors.soh) {
    return res.status(503).json({
      success: false,
      error: lastErrors.soh,
      data: []
    });
  }

  const totalMainCBB = sohRows.reduce((sum, r) => {
    return sum +
      (Number(String(r.TOTAL_MAIN_QRT ?? '0').replace(/,/g, '')) || 0);
  }, 0);

  res.json({
    success: Boolean(sohLoadedAt),
    data: sohRows,
    totalMainCBB,
    loadedAt: sohLoadedAt,
    loading: sohLoading,
    error: lastErrors.soh
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    gsvRows: gsvRows.length,
    sohRows: sohRows.length,
    gsvLoadedAt,
    sohLoadedAt,
    errors: lastErrors
  });
});

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'UNIBIC_Kerala_Sales_Command_Center_FULL_FINAL.html')
  );
});

app.get('/refresh-data', async (req, res) => {
  if (
    process.env.REFRESH_KEY &&
    req.query.key !== process.env.REFRESH_KEY
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await Promise.all([loadGSV(), loadSOH()]);

  res.json({
    success: !lastErrors.gsv && !lastErrors.soh,
    gsvRows: gsvRows.length,
    sohRows: sohRows.length,
    errors: lastErrors
  });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`UNIBIC Kerala Sales Command Center listening on ${PORT}`);

  await Promise.all([loadGSV(), loadSOH()]);

  setInterval(() => {
    loadGSV();
    loadSOH();
  }, 15 * 60 * 1000).unref();
});
