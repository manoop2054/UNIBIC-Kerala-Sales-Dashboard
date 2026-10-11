const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 10000;
const DASHBOARD = path.join(__dirname, 'UNIBIC_Kerala_Sales_Command_Center_FULL_FINAL.html');
const CACHE_DIR = path.join(os.tmpdir(), 'unibic-sales-cache');
const GSV_URL = process.env.GSV_SHARE_URL || 'https://github.com/manoop2054/UNIBIC-Kerala-Sales-Dashboard/releases/download/v1.0/KL.LIVE.GSV.LINK-MANOOB.xlsx';
const SOH_URL = process.env.SOH_SHARE_URL || 'https://github.com/manoop2054/UNIBIC-Kerala-Sales-Dashboard/releases/download/v1.0/LIVE.STOCK.xlsb';
const GSV_SHEET = process.env.GSV_SHEET_NAME || 'ACX_Sales_Register';
const SOH_SHEET = process.env.SOH_SHEET_NAME || 'LIVE STOCK REPORT';

const GSV_FIELDS = new Set([
  'PostingDate','Posting Date','Date','Invoice Date','GSV IN LAKH','GSV','GSV Amount',
  'AmountToCustomer','Amount To Customer','Amount','QuantityinCBO','Quantity in CBO','CBB','CBO',
  'QuantityinPcs','Quantity in Pcs','Qty PCS','Quantity','INDV_discount','INDV Discount','Discount',
  'INDV Amount','Return_Invoices','Return Invoice','Return Invoices','DBR_Code','DBR Code',
  'Sell_to_Customer_No','Customer_Account','Billed_to_Code','DBR_Name','DBR Name',
  'Sell_to_Customer_Name','Customer_Name','Customer','Billed_to_Name','Ship_to_Name',
  'ItemId','Item ID','Item Code','ItemCode','Description','Item Description','Invoice_No',
  'Invoice No','Invoice','Order_No','Order No','Order','NKAM_ABM','ABM','ABM Name','NKAM / ABM',
  'AnchorName','Anchor','Brand','BrandName','REGION','Region','region','AreaCode','Area Code','Area','Ship_to_Code',
  'Ship to Code','ShipCode','Customer_Posting_Group','Customer Posting Group','ExternalDocNo',
  'External Doc No','External Document No','MRP_Price','MRP Price','MRP','GST_Base_Amount',
  'GST Base Amount','GST_Base','DBR / Customer Code','Customer / DBR Name','Available Shelf Life %'
]);

const inFlight = new Map();
app.get('/', (req, res) => res.sendFile(DASHBOARD));
app.get('/health', (req, res) => res.json({ ok: true, service: 'UNIBIC Sales Dashboard API' }));

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

async function buildGsvCache(cachePath) {
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const source = path.join(CACHE_DIR, 'gsv-source.xlsx');
  const temp = cachePath + '.tmp';
  await downloadToFile(GSV_URL, source);
  const output = fs.createWriteStream(temp, { encoding: 'utf8' });
  let first = true, header = null, rowCount = 0, selectedSheetFound = false;
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
          continue;
        }
        const obj = {};
        for (let i = 1; i < values.length; i++) {
          const key = header[i];
          if (!key || !GSV_FIELDS.has(key)) continue;
          const value = cellValue(values[i]);
          if (value !== undefined && value !== null && value !== '') obj[key] = value;
        }
        if (!Object.keys(obj).length) continue;
        if (!first) await write(',');
        await write(JSON.stringify(obj));
        first = false;
        rowCount++;
      }
      break;
    }
    if (!selectedSheetFound) throw new Error('GSV worksheet not found: ' + GSV_SHEET);
    await write(']}');
    await new Promise((resolve, reject) => output.end(err => err ? reject(err) : resolve()));
    await fs.promises.rename(temp, cachePath);
    console.log('GSV compact cache ready:', rowCount, 'rows');
  } catch (error) {
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

function sendJsonCache(res, file) {
  res.type('application/json');
  res.sendFile(file, error => {
    if (error && !res.headersSent) res.status(500).json({ error: 'Unable to read cached data' });
  });
}

app.get(['/api/gsv', '/api/live-gsv'], async (req, res) => {
  try { sendJsonCache(res, await getCache('gsv-compact.json', buildGsvCache)); }
  catch (error) {
    console.error('GSV load failed:', error.stack || error.message);
    res.status(500).json({ error: 'GSV processing failed', detail: error.message });
  }
});

app.get(['/api/soh', '/api/live-soh'], async (req, res) => {
  try { sendJsonCache(res, await getCache('soh.json', buildSohCache)); }
  catch (error) {
    console.error('SOH load failed:', error.stack || error.message);
    res.status(500).json({ error: 'SOH processing failed', detail: error.message });
  }
});

app.listen(PORT, () => console.log('Server running on', PORT));
