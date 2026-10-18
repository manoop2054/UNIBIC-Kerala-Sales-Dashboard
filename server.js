const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 10000;
const DASHBOARD = path.join(__dirname, 'UNIBIC_Kerala_Sales_Command_Center_FINAL_PATCHED.html');
const CACHE_DIR = path.join(os.tmpdir(), 'unibic-sales-cache');
const GSV_URL = process.env.GSV_SHARE_URL || 'https://github.com/manoop2054/UNIBIC-Kerala-Sales-Dashboard/releases/download/v1.0/KL.LIVE.GSV.LINK-MANOOB.xlsx';
const SOH_URL = process.env.SOH_SHARE_URL || 'https://github.com/manoop2054/UNIBIC-Kerala-Sales-Dashboard/releases/download/v1.0/LIVE.STOCK.xlsb';
const GSV_SHEET = process.env.GSV_SHEET_NAME || 'ACX_Sales_Register';
const SOH_SHEET = process.env.SOH_SHEET_NAME || 'LIVE STOCK REPORT';

// UPDATED: Added all Excel header variations (QuantityinCBD, Discounts, AssesableValue, LocationCode etc.)
const GSV_FIELDS = new Set([
  'PostingDate','Posting Date','Date','Invoice Date','GSV IN LAKH','GSV','GSV Amount',
  'AmountToCustomer','Amount To Customer','Amount','QuantityinCBO','QuantityinCBD','Quantity in CBO','CBB','CBO','QuantityinBox',
  'QuantityinPcs','Quantity in Pcs','Qty PCS','Quantity','INDV_discount','INDV Discount','Discount',
  'INDV Amount','Return_Invoices','Return Invoice','Return Invoices','DBR_Code','DBR Code',
  'Sell_to_Customer_No','Customer_Account','Billed_to_Code','DBR_Name','DBR Name',
  'Sell_to_Customer_Name','Customer_Name','Customer','Billed_to_Name','Ship_to_Name',
  'ItemId','Item ID','Item Code','ItemCode','Description','Item Description','Invoice_No',
  'Invoice No','Invoice','Order_No','Order No','Order','NKAM_ABM','ABM','ABM Name','NKAM / ABM',
  'AnchorName','Anchor','Brand','BrandName','REGION','Region','region','AreaCode','Area Code','Area','Ship_to_Code',
  'Ship to Code','ShipCode','Customer_Posting_Group','Customer Posting Group','ExternalDocNo',
  'External Doc No','External Document No','MRP_Price','MRP Price','MRP','GST_Base_Amount',
  'GST Base Amount','GST_Base','DBR / Customer Code','Customer / DBR Name','Available Shelf Life %',
  'Unit_Price','UNIT PRICE','Unit Price','UNIT_PRICE','UnitPrice',
  'Line_Discount_Percent','Line Discount Percent','LineDiscountPercent','Scheme_Discount',
  'Scheme Discount','Scheme_Discount_Percent','Scheme Discount Percent','Discount_Percent','Discount Percent',
  'AssesableValue','AssessableValue','Assesable Value','LocationCode','Location Code','Location_Code',
  'AnchorZoneName','Anchor Zone Name','ANCHOR ZONENAME','Anchor Zone','AnchorZone'
]);

const inFlight = new Map();
const gsvStatus = { stage: 'idle', rows: 0, startedAt: null, updatedAt: null, error: null };
app.get('/', (req, res) => res.sendFile(DASHBOARD));
app.get('/health', (req, res) => res.json({ ok: true, service: 'UNIBIC Sales Dashboard API' }));
app.get('/api/gsv/status', (req, res) => res.json({ ...gsvStatus, inProgress: inFlight.has('gsv-compact.json') }));

app.get('/api/gsv/summary', async (req, res) => {
  try {
    await getCache('gsv-compact.json', buildGsvCache);
    res.json({
      success: true,
      service: 'UNIBIC Sales Dashboard API',
      status: 'running',
      gsvRows: gsvStatus.rows,
      gsvLoadedAt: gsvStatus.updatedAt,
      loading: false,
      error: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      service: 'UNIBIC Sales Dashboard API',
      status: 'error',
      gsvRows: gsvStatus.rows,
      loading: false,
      error: error.message
    });
  }
});

function downloadToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many download redirects'));
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, response => {
      if ([301,302,303,307,308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(downloadToFile(new URL(response.headers.location, url).toString(), dest, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error('Download returned HTTP ' + response.statusCode));
      }
      const out = fs.createWriteStream(dest);
      response.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      response.on('error', reject);
    });
    request.setTimeout(180000, () => request.destroy(new Error('Download timed out')));
    request.on('error', reject);
  });
}

function cellValue(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(x => x.text || '').join('');
    if (Object.prototype.hasOwnProperty.call(value, 'result')) return cellValue(value.result);
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return value.text;
    if (Object.prototype.hasOwnProperty.call(value, 'hyperlink')) return value.text || value.hyperlink;
    return '';
  }
  return value;
}

// AUTOMATIC EXCEL COLUMN NORMALIZER FUNCTION
function normalizeRow(r) {
  if (!r) return {};
  const getVal = (keys) => {
    for (let k of keys) {
      if (r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') return r[k];
    }
    return '';
  };
  return {
    ...r,
    Invoice_No: getVal(['Invoice_No','Invoice No','Invoice']),
    ItemId: getVal(['ItemId','Item ID','ItemCode','Item Code']),
    QuantityinCBO: getVal(['QuantityinCBD','QuantityinCBO','Quantity in CBO','CBO','CBB','QuantityinBox']) || 0,
    Description: getVal(['Description','Item Description']),
    MRP_Price: getVal(['MRP_Price','MRP Price','MRP']) || 0,
    Unit_Price: getVal(['Unit_Price','Unit Price','UnitPrice']) || 0,
    Discount_Percent: getVal(['Discount_Percent','Discount Percent']) || 0,
    Line_Discount_Percent: getVal(['Line_Discount_Percent','Line Discount Percent']) || 0,
    AmountToCustomer: getVal(['AmountToCustomer','Amount To Customer']) || 0,
    AssesableValue: getVal(['AssesableValue','AssessableValue','Assesable Value']) || 0,
    LocationCode: getVal(['LocationCode','Location Code','Location_Code']),
    INDV_discount: getVal(['INDV_discount','INDV Discount']) || 0,
    Scheme_Discount: getVal(['Scheme_Discount','Scheme Discount']) || 0,
    Scheme_Discount_Percent: getVal(['Scheme_Discount_Percent','Scheme Discount Percent']) || 0,
    PostingDate: getVal(['PostingDate','Posting Date','Date','Invoice Date']),
    AnchorZoneName: getVal(['AnchorZoneName','Anchor Zone Name','ANCHOR ZONENAME','Anchor Zone','AnchorZone'])
  };
}

async function buildGsvCache(cachePath) {
  gsvStatus.stage = 'downloading workbook'; gsvStatus.rows = 0; gsvStatus.startedAt = new Date().toISOString(); gsvStatus.updatedAt = gsvStatus.startedAt; gsvStatus.error = null;
  console.log('GSV status: downloading source workbook');
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const source = path.join(CACHE_DIR, 'gsv-source.xlsx');
  const temp = cachePath + '.tmp';
  await downloadToFile(GSV_URL, source);
  gsvStatus.stage = 'processing workbook'; gsvStatus.updatedAt = new Date().toISOString();
  console.log('GSV status: download complete; processing worksheet', GSV_SHEET);
  const output = fs.createWriteStream(temp, { encoding: 'utf8' });
  let first = true, header = null, selectedColumns = null, rowCount = 0, selectedSheetFound = false;
  // Batch serialized rows so the streaming writer does not await two file writes per row.
  let outputBatch = [];
  const write = chunk => new Promise((resolve, reject) => {
    if (output.write(chunk)) resolve();
    else { output.once('drain', resolve); output.once('error', reject); }
  });

  try {
    await write('{"data":[');
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
      sharedStrings: 'cache', hyperlinks: 'ignore', worksheets: 'emit', styles: 'ignore'
    });
    for await (const sheet of reader) {
      if (sheet.name !== GSV_SHEET) continue;
      selectedSheetFound = true;
      for await (const row of sheet) {
        const values = row.values || [];
        if (!header) {
          header = values.map(v => String(cellValue(v) ?? '').trim());
          // Preselect relevant worksheet columns once instead of scanning every Excel column for every row.
          selectedColumns = [];
          for (let i = 1; i < header.length; i++) {
            const key = header[i];
            if (key && GSV_FIELDS.has(key)) selectedColumns.push({ index: i, key });
          }
          continue;
        }
        const rawObj = {};
        let hasRawField = false;
        for (const column of selectedColumns) {
          const value = cellValue(values[column.index]);
          if (value !== undefined && value !== null && value !== '') {
            rawObj[column.key] = value;
            hasRawField = true;
          }
        }
        if (!hasRawField) continue;

        // Clean & Normalize each row before writing JSON
        const obj = normalizeRow(rawObj);

        outputBatch.push((first ? '' : ',') + JSON.stringify(obj));
        first = false;
        rowCount++;
        // Write in chunks of 1,000 rows instead of awaiting disk output for every row.
        if (outputBatch.length >= 1000) {
          await write(outputBatch.join(''));
          outputBatch = [];
        }
        if (rowCount % 10000 === 0) {
          if (outputBatch.length) {
            await write(outputBatch.join(''));
            outputBatch = [];
          }
          gsvStatus.rows = rowCount;
          gsvStatus.updatedAt = new Date().toISOString();
          console.log('GSV processing rows:', rowCount);
        }
      }
      break;
    }
    if (!selectedSheetFound) throw new Error('GSV worksheet not found: ' + GSV_SHEET);
    if (outputBatch.length) await write(outputBatch.join(''));
    await write(']}');
    await new Promise((resolve, reject) => output.end(err => err ? reject(err) : resolve()));
    await fs.promises.rename(temp, cachePath);
    gsvStatus.stage = 'ready'; gsvStatus.rows = rowCount; gsvStatus.updatedAt = new Date().toISOString(); gsvStatus.error = null;
    console.log('GSV compact cache ready:', rowCount, 'rows');
  } catch (error) {
    gsvStatus.stage = 'failed'; gsvStatus.updatedAt = new Date().toISOString(); gsvStatus.error = error.message;
    output.destroy();
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function getCache(name, builder) {
  const cachePath = path.join(CACHE_DIR, name);
  try { await fs.promises.access(cachePath); return cachePath; } catch (_) {}
  if (!inFlight.has(name)) {
    inFlight.set(name, builder(cachePath).finally(() => inFlight.delete(name)));
  }
  await inFlight.get(name);
  return cachePath;
}

async function buildSohCache(cachePath) {
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const source = path.join(CACHE_DIR, 'soh-source.xlsb');
  const temp = cachePath + '.tmp';
  await downloadToFile(SOH_URL, source);
  const workbook = XLSX.readFile(source, { cellDates: true });
  const sheetName = workbook.SheetNames.includes(SOH_SHEET) ? SOH_SHEET : workbook.SheetNames[0];
  if (!sheetName) throw new Error('No worksheet found in SOH workbook');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  await fs.promises.writeFile(temp, JSON.stringify({ data: rows }));
  await fs.promises.rename(temp, cachePath);
  console.log('SOH cache ready:', rows.length, 'rows from', sheetName);
}

const gzipInFlight = new Map();

async function ensureGzipCache(file) {
  const gzipPath = file + '.gz';
  try { await fs.promises.access(gzipPath); return gzipPath; } catch (_) {}
  if (!gzipInFlight.has(file)) {
    const temp = gzipPath + '.tmp';
    gzipInFlight.set(file, pipeline(
      fs.createReadStream(file),
      zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED }),
      fs.createWriteStream(temp)
    ).then(async () => {
      await fs.promises.rename(temp, gzipPath);
      return gzipPath;
    }).catch(async error => {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      throw error;
    }).finally(() => gzipInFlight.delete(file)));
  }
  return gzipInFlight.get(file);
}

async function sendJsonCache(req, res, file) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(req.headers['accept-encoding'] || ''));
  if (acceptsGzip) {
    try {
      const gzipPath = await ensureGzipCache(file);
      res.setHeader('Content-Encoding', 'gzip');
      res.sendFile(gzipPath, error => {
        if (error && !res.headersSent) res.status(500).json({ error: 'Unable to read compressed cached data' });
      });
      return;
    } catch (error) {
      console.warn('Gzip cache unavailable; serving JSON without compression:', error.message);
    }
  }
  res.sendFile(file, error => {
    if (error && !res.headersSent) res.status(500).json({ error: 'Unable to read cached data' });
  });
}

app.get(['/api/gsv', '/api/live-gsv'], async (req, res) => {
  try { await sendJsonCache(req, res, await getCache('gsv-compact.json', buildGsvCache)); }
  catch (error) {
    console.error('GSV load failed:', error.stack || error.message);
    res.status(500).json({ error: 'GSV processing failed', detail: error.message });
  }
});

app.get(['/api/soh', '/api/live-soh'], async (req, res) => {
  try { await sendJsonCache(req, res, await getCache('soh.json', buildSohCache)); }
  catch (error) {
    console.error('SOH load failed:', error.stack || error.message);
    res.status(500).json({ error: 'SOH processing failed', detail: error.message });
  }
});

app.listen(PORT, () => {
  console.log('Server running on', PORT);
  // Warm caches in the background after the HTTP listener is ready. Keep the large GSV
  // and LIVE SOH workbook processing sequential to reduce peak memory on small Render plans.
  setTimeout(() => {
    getCache('gsv-compact.json', buildGsvCache)
      .then(file => ensureGzipCache(file))
      .then(() => {
        console.log('GSV cache warmed and compressed');
        return getCache('soh.json', buildSohCache);
      })
      .then(file => ensureGzipCache(file))
      .then(() => console.log('SOH cache warmed and compressed'))
      .catch(error => console.error('Background cache warm-up failed:', error.message));
  }, 1000);
});