const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const { Pool } = require("pg");
// Use explicit libpq-compatible secure SSL semantics for both isolated MBQ databases.
function mbqVerifiedDatabaseUrl(value) {
  const parsed = new URL(value);
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed.toString();
}
const draftPool = process.env.DATABASE_URL ? new Pool({ connectionString: mbqVerifiedDatabaseUrl(process.env.DATABASE_URL), ssl: { rejectUnauthorized: true }, max: 5 }) : null;
const masterPool = process.env.MBQ_MASTER_DATABASE_URL ? new Pool({ connectionString: mbqVerifiedDatabaseUrl(process.env.MBQ_MASTER_DATABASE_URL), ssl: { rejectUnauthorized: true }, max: 3 }) : null;
const MBQ_MASTER_UPLOAD_PIN = process.env.MBQ_MASTER_UPLOAD_PIN || "";

const SOH_URL = process.env.SOH_SHARE_URL || "https://github.com/manoop2054/UNIBIC-Kerala-Sales-Dashboard/releases/download/v1.0/LIVE.STOCK.xlsb";
const SOH_SHEET = process.env.SOH_SHEET_NAME || "LIVE STOCK REPORT";
const CACHE_DIR = path.join(os.tmpdir(), "mbq-live-data");
let sohLoadPromise = null;

const GSV_URL = process.env.GSV_SHARE_URL || "https://github.com/manoop2054/UNIBIC-Kerala-Sales-Dashboard/releases/download/v1.0/KL.LIVE.GSV.LINK-MANOOB.xlsx";
const GSV_SHEET = process.env.GSV_SHEET_NAME || "ACX_Sales_Register";
let gsvLoadPromise = null;
let gsvLoadError = null;
function gsvNorm(v) { return String(v == null ? "" : v).trim().toLowerCase().replace(/[^a-z0-9]/g, ""); }
function gsvCellValue(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map(x => x.text || "").join("");
    if (Object.prototype.hasOwnProperty.call(value, "result")) return gsvCellValue(value.result);
    if (Object.prototype.hasOwnProperty.call(value, "text")) return value.text;
    return "";
  }
  return value;
}
function gsvDateISO(value) {
  if (value == null || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getUTCFullYear() + "-" + String(value.getUTCMonth() + 1).padStart(2, "0") + "-" + String(value.getUTCDate()).padStart(2, "0");
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  }
  const raw = String(value).trim();
  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function gsvDateMonth(value) { return gsvDateISO(value).slice(0, 7); }
function gsvCfa(value) {
  const v = String(value || "").toUpperCase();
  if (/\bALU\b/.test(v)) return "ALU";
  if (/\bPAY\b/.test(v)) return "PAY";
  if (/\bTVD\b/.test(v)) return "TVD";
  return "";
}
async function buildMbqGsvAggregate() {
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const source = path.join(CACHE_DIR, "KL.LIVE.GSV.LINK-MANOOB.xlsx");
  const cache = path.join(CACHE_DIR, "gsv-aggregate.json");
  const tmp = cache + ".tmp";
  console.log("MBQ GSV: downloading source workbook");
  await downloadToFile(GSV_URL, source);
  const stats = { sourceBytes: (await fs.promises.stat(source)).size, sheet: GSV_SHEET };
  const aggregate = new Map();
  let headers = null, indexes = null, rowCount = 0, matchedRows = 0, sheetFound = false;
  let minDate = "", maxDate = "";
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, { sharedStrings: "cache", hyperlinks: "ignore", worksheets: "emit", styles: "ignore" });
  for await (const sheet of reader) {
    if (sheet.name !== GSV_SHEET) continue;
    sheetFound = true;
    for await (const row of sheet) {
      const values = row.values || [];
      if (!headers) {
        headers = values.map(v => String(gsvCellValue(v) ?? "").trim());
        const find = aliases => { for (const alias of aliases) { const i = headers.findIndex(h => gsvNorm(h) === gsvNorm(alias)); if (i > 0) return i; } return -1; };
        indexes = {
          item: find(["ItemId","Item ID","ItemCode","Item Code","FG Code","Product Code","Item No"]),
          date: find(["PostingDate","Posting Date","Date","Invoice Date"]),
          qty: find(["QuantityinCBD","QuantityinCBO","Quantity in CBO","CBO","CBB","QuantityinBox","Quantity"]),
          amount: find(["AmountToCustomer","Amount To Customer","GSV Amount","GSV","GSV IN LAKH","AssesableValue","AssessableValue","Amount"]),
          cfa: find(["LocationCode","Location Code","Location_Code","CFA","Warehouse","Branch","Site"]),
          dbrCode: find(["Ship To Code","ShipToCode","Ship To Customer Code","Customer Code","CustomerCode","Debtor Code","Customer Id","Account Code"]),
          dbrName: find(["Ship To Name","ShipToName","Customer Name","CustomerName","Debtor Name","Account Name"])
        };
        stats.headers = headers.filter(Boolean);
        stats.detected = Object.fromEntries(Object.entries(indexes).map(([k,i]) => [k, i > 0 ? headers[i] : null]));
        if (indexes.item < 1 || indexes.date < 1 || indexes.qty < 1) throw new Error("GSV required columns not detected. Headers: " + headers.filter(Boolean).join(", "));
        continue;
      }
      rowCount++;
      const get = i => i > 0 ? gsvCellValue(values[i]) : "";
      const item = String(get(indexes.item) ?? "").trim().toUpperCase().replace(/\s+/g, "");
      const date = gsvDateISO(get(indexes.date));
      const month = date.slice(0, 7);
      const qty = Number(String(get(indexes.qty) ?? "").replace(/,/g, ""));
      const amountRaw = indexes.amount > 0 ? Number(String(get(indexes.amount) ?? "").replace(/,/g, "")) : NaN;
      if (!item || !date || !month || !Number.isFinite(qty)) continue;
      const cfa = indexes.cfa > 0 ? gsvCfa(get(indexes.cfa)) : "";
      const dbrCode = indexes.dbrCode > 0 ? String(get(indexes.dbrCode) ?? "").trim() : "";
      const dbrName = indexes.dbrName > 0 ? String(get(indexes.dbrName) ?? "").trim() : "";
      const key = item + "|" + date + "|" + (cfa || "ALL") + "|" + dbrCode;
      const old = aggregate.get(key) || { itemId: item, date, month, cfa: cfa || "ALL", dbrCode, dbrName, quantity: 0, amount: 0, amountAvailable: false, rows: 0 };
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
      old.quantity += qty;
      if (Number.isFinite(amountRaw)) { old.amount += amountRaw; old.amountAvailable = true; }
      old.rows++;
      aggregate.set(key, old);
      matchedRows++;
      if (rowCount % 20000 === 0) console.log("MBQ GSV progress:", rowCount, "rows");
    }
    break;
  }
  if (!sheetFound) throw new Error("GSV worksheet not found: " + GSV_SHEET);
  if (!indexes || !aggregate.size) throw new Error("GSV workbook contained no usable item/month/quantity records");
  const payload = { success: true, schemaVersion: 3, data: Array.from(aggregate.values()), rows: rowCount, matchedRows, aggregateRows: aggregate.size, loadedAt: new Date().toISOString(), dateCoverage: { from: minDate, to: maxDate }, detected: stats.detected, headers: stats.headers, sourceBytes: stats.sourceBytes };
  await fs.promises.writeFile(tmp, JSON.stringify(payload), "utf8");
  await fs.promises.rename(tmp, cache);
  console.log("MBQ GSV ready:", JSON.stringify({ rows: rowCount, matchedRows, aggregateRows: aggregate.size, detected: stats.detected }));
  gsvLoadError = null;
  return payload;
}
async function readMbqGsvCache() {
  const cache = path.join(CACHE_DIR, "gsv-aggregate.json");
  try {
    const stat = await fs.promises.stat(cache);
    if (Date.now() - stat.mtimeMs < 6 * 60 * 60 * 1000) {
      const cached = JSON.parse(await fs.promises.readFile(cache, "utf8"));
      if (cached.schemaVersion === 3 && Array.isArray(cached.data) && cached.data.every(row => row && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || "")))) return cached;
      console.log("MBQ GSV cache schema outdated; rebuilding with posting dates");
    }
  } catch (_) {}
  if (gsvLoadError && !gsvLoadPromise) throw new Error(gsvLoadError);
  if (!gsvLoadPromise) {
    gsvLoadPromise = buildMbqGsvAggregate().catch(error => {
      gsvLoadError = error.message || String(error);
      console.error("MBQ GSV load failed:", error.stack || error.message);
      return null;
    }).finally(() => { gsvLoadPromise = null; });
  }
  throw Object.assign(new Error("GSV data is loading"), { loading: true });
}

function downloadToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error("Too many download redirects"));
    https.get(url, { headers: { "User-Agent": "MBQ-Smart-Indent-Dashboard" } }, response => {
      if ([301,302,303,307,308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(downloadToFile(new URL(response.headers.location, url).toString(), dest, redirects + 1));
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error("SOH download HTTP " + response.statusCode)); }
      const out = fs.createWriteStream(dest);
      response.pipe(out); out.on("finish", () => out.close(resolve)); out.on("error", reject); response.on("error", reject);
    }).on("error", reject);
  });
}
async function loadSohRows() {
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const cache = path.join(CACHE_DIR, "soh.json");
  try { const st = await fs.promises.stat(cache); if (Date.now() - st.mtimeMs < 30 * 60 * 1000) return JSON.parse(await fs.promises.readFile(cache, "utf8")); } catch (_) {}
  if (!sohLoadPromise) sohLoadPromise = (async () => {
    const source = path.join(CACHE_DIR, "LIVE.STOCK.xlsb");
    await downloadToFile(SOH_URL, source);
    const wb = XLSX.readFile(source, { cellDates: true });
    const sheetName = wb.SheetNames.includes(SOH_SHEET) ? SOH_SHEET : wb.SheetNames[0];
    if (!sheetName) throw new Error("No worksheet found in LIVE SOH workbook");
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
    await fs.promises.writeFile(cache, JSON.stringify({ data: rows, sheet: sheetName, rows: rows.length, loadedAt: new Date().toISOString() }));
    console.log("MBQ LIVE SOH loaded:", rows.length, "rows from", sheetName);
    return { data: rows, sheet: sheetName, rows: rows.length, loadedAt: new Date().toISOString() };
  })().finally(() => { sohLoadPromise = null; });
  return sohLoadPromise;
}

const app = express();
const PORT = process.env.PORT || 10000;

const prototypeFile = path.join(
  __dirname,
  "MBQ_Smart_Indent_Control_Tower_Updated_Prototype7.html"
);


app.get("/api/mbq/gsv", async (req, res) => {
  try {
    const result = await readMbqGsvCache();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(result);
  } catch (error) {
    if (error.loading) return res.status(202).json({ success: false, loading: true, message: "GSV workbook is being processed; retry shortly." });
    res.status(500).json({ success: false, loading: false, error: "GSV load failed", detail: gsvLoadError || error.message });
  }
});

app.get("/api/mbq/soh", async (req, res) => {
  try {
    const result = await loadSohRows();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("MBQ LIVE SOH load failed:", error.stack || error.message);
    res.status(500).json({ success: false, error: "LIVE SOH load failed", detail: error.message });
  }
});

// Shared official MBQ master workbook. Read access is open to dashboard viewers;
// only replacing the single shared workbook requires the dedicated upload PIN.
app.get("/api/mbq/master-workbook", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ master storage is not configured" });
  try {
    const result = await masterPool.query("SELECT file_name, payload, source_file_size, uploaded_at FROM public.mbq_master_workbook WHERE id=1");
    if (!result.rowCount) return res.json({ success: true, workbook: null });
    const row = result.rows[0];
    res.json({ success: true, workbook: { fileName: row.file_name, payload: row.payload, sourceFileSize: Number(row.source_file_size || 0), uploadedAt: row.uploaded_at } });
  } catch (error) {
    console.error("MBQ shared master read failed:", error.message);
    res.status(500).json({ success: false, error: "Could not load shared MBQ master workbook" });
  }
});
app.post("/api/mbq/master-workbook", express.json({ limit: "100mb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ master storage is not configured" });
  if (!MBQ_MASTER_UPLOAD_PIN) return res.status(503).json({ success: false, error: "MBQ master upload PIN is not configured" });
  if (String(req.get("X-MBQ-Master-Pin") || "") !== MBQ_MASTER_UPLOAD_PIN)
    return res.status(401).json({ success: false, error: "Upload PIN is missing or incorrect" });
  try {
    const b = req.body || {};
    const fileName = String(b.fileName || "").trim().slice(0, 255);
    const size = Number(b.fileSize || 0);
    const payload = b.payload;
    if (!fileName || !payload || typeof payload !== "object" || Array.isArray(payload) ||
        !payload.sheets || typeof payload.sheets !== "object" || !Array.isArray(payload.salesRows))
      return res.status(400).json({ success: false, error: "A valid parsed MBQ workbook is required" });
    if (!Number.isFinite(size) || size <= 0 || size > 25 * 1024 * 1024)
      return res.status(413).json({ success: false, error: "Master Excel file limit is 25 MB" });
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") > 90 * 1024 * 1024)
      return res.status(413).json({ success: false, error: "Parsed workbook data exceeds the 90 MB storage limit" });
    const result = await masterPool.query(
      "INSERT INTO public.mbq_master_workbook(id,file_name,payload,source_file_size,uploaded_at) VALUES(1,$1,$2::jsonb,$3,NOW()) ON CONFLICT(id) DO UPDATE SET file_name=EXCLUDED.file_name,payload=EXCLUDED.payload,source_file_size=EXCLUDED.source_file_size,uploaded_at=NOW() RETURNING file_name,source_file_size,uploaded_at",
      [fileName, json, size]
    );
    const row = result.rows[0];
    res.status(200).json({ success: true, workbook: { fileName: row.file_name, sourceFileSize: Number(row.source_file_size || 0), uploadedAt: row.uploaded_at } });
  } catch (error) {
    console.error("MBQ shared master upload failed:", error.message);
    res.status(500).json({ success: false, error: "Could not save shared MBQ master workbook" });
  }
});

// Shared MBQ drafts: PostgreSQL storage keeps drafts available across browsers and devices.
async function ensureDraftTable() {
  if (!draftPool) throw new Error("Shared draft storage is not configured (DATABASE_URL missing)");
  await draftPool.query(`CREATE TABLE IF NOT EXISTS mbq_shared_drafts (
    id BIGSERIAL PRIMARY KEY, draft_type TEXT NOT NULL, draft_name TEXT NOT NULL,
    file_name TEXT, content_type TEXT, file_size BIGINT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
let draftTableReady = null;
function readyDrafts() {
  if (!draftTableReady) {
    draftTableReady = ensureDraftTable().catch(error => {
      // Do not cache a rejected initialization promise: transient PostgreSQL/Neon
      // authentication timeouts must be recoverable on the next request.
      draftTableReady = null;
      throw error;
    });
  }
  return draftTableReady;
}
const MBQ_DRAFTS_PIN = process.env.MBQ_DRAFTS_PIN || "";
app.use("/api/mbq/drafts", (req, res, next) => {
  if (!MBQ_DRAFTS_PIN) return res.status(503).json({ success: false, error: "Shared draft access PIN is not configured" });
  if (String(req.get("X-MBQ-Drafts-Pin") || "") !== MBQ_DRAFTS_PIN) return res.status(401).json({ success: false, error: "Shared draft access PIN is missing or incorrect" });
  next();
});
app.get("/api/mbq/drafts", async (req, res) => {
  try {
    await readyDrafts();
    const type = String(req.query.type || "").slice(0, 100);
    const result = type
      ? await draftPool.query("SELECT id, draft_type, draft_name, file_name, content_type, file_size, created_at, updated_at, payload->>'month' AS month, CASE WHEN jsonb_typeof(payload->'lines')='array' THEN jsonb_array_length(payload->'lines') ELSE 0 END AS line_count FROM mbq_shared_drafts WHERE draft_type=$1 ORDER BY updated_at DESC LIMIT 100", [type])
      : await draftPool.query("SELECT id, draft_type, draft_name, file_name, content_type, file_size, created_at, updated_at FROM mbq_shared_drafts ORDER BY updated_at DESC LIMIT 100");
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, drafts: result.rows });
  } catch (error) { res.status(500).json({ success: false, error: "Could not load shared drafts", detail: error.message }); }
});
app.get("/api/mbq/drafts/:id", async (req, res) => {
  try {
    await readyDrafts();
    const result = await draftPool.query("SELECT id, draft_type, draft_name, file_name, content_type, file_size, payload, created_at, updated_at FROM mbq_shared_drafts WHERE id=$1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ success: false, error: "Draft not found" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, draft: result.rows[0] });
  } catch (error) { res.status(500).json({ success: false, error: "Could not open draft", detail: error.message }); }
});
app.post("/api/mbq/drafts", express.json({ limit: "40mb" }), async (req, res) => {
  try {
    await readyDrafts();
    const b = req.body || {};
    if (!String(b.type || "").trim() || !String(b.name || "").trim() || !b.payload || typeof b.payload !== "object")
      return res.status(400).json({ success: false, error: "type, name and payload are required" });
    const size = Number(b.fileSize || 0);
    if (size > 25 * 1024 * 1024) return res.status(413).json({ success: false, error: "Draft file limit is 25 MB" });
    const result = await draftPool.query(
      "INSERT INTO mbq_shared_drafts(draft_type,draft_name,file_name,content_type,file_size,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id,draft_type,draft_name,file_name,file_size,created_at,updated_at",
      [String(b.type).slice(0,100),String(b.name).trim().slice(0,200),b.fileName ? String(b.fileName).slice(0,255) : null,b.contentType ? String(b.contentType).slice(0,150) : null,Number.isFinite(size) ? size : 0,JSON.stringify(b.payload)]
    );
    res.status(201).json({ success: true, draft: result.rows[0] });
  } catch (error) { res.status(500).json({ success: false, error: "Could not save shared draft", detail: error.message }); }
});
app.put("/api/mbq/drafts/:id", express.json({ limit: "40mb" }), async (req, res) => {
  try {
    await readyDrafts();
    const b = req.body || {};
    if (!String(b.name || "").trim() || !b.payload || typeof b.payload !== "object") return res.status(400).json({ success: false, error: "name and payload are required" });
    const result = await draftPool.query(
      "UPDATE mbq_shared_drafts SET draft_name=$1,file_name=$2,content_type=$3,file_size=$4,payload=$5::jsonb,updated_at=NOW() WHERE id=$6 RETURNING id,draft_type,draft_name,file_name,file_size,created_at,updated_at",
      [String(b.name).trim().slice(0,200),b.fileName ? String(b.fileName).slice(0,255) : null,b.contentType ? String(b.contentType).slice(0,150) : null,Number(b.fileSize || 0),JSON.stringify(b.payload),req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, error: "Draft not found" });
    res.json({ success: true, draft: result.rows[0] });
  } catch (error) { res.status(500).json({ success: false, error: "Could not update shared draft", detail: error.message }); }
});
app.delete("/api/mbq/drafts/:id", async (req, res) => {
  try {
    await readyDrafts();
    const result = await draftPool.query("DELETE FROM mbq_shared_drafts WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ success: false, error: "Draft not found" });
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) { res.status(500).json({ success: false, error: "Could not delete draft", detail: error.message }); }
});

// Shared MBQ uploads and Open TO records are stored only in the dedicated MBQ database.
app.get("/api/mbq/shared-upload/:category", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  const category = String(req.params.category || "");
  if (!["monthly-indent", "open-po-report", "production-settings"].includes(category)) return res.status(400).json({ success: false, error: "Unsupported upload category" });
  try {
    const result = await masterPool.query("SELECT file_name,payload,source_file_size,uploaded_at,uploaded_by FROM public.mbq_shared_uploads WHERE category=$1", [category]);
    if (!result.rowCount) return res.json({ success: true, upload: null });
    const row = result.rows[0];
    res.json({ success: true, upload: { fileName: row.file_name, payload: row.payload, sourceFileSize: Number(row.source_file_size || 0), uploadedAt: row.uploaded_at, uploadedBy: row.uploaded_by } });
  } catch (error) {
    console.error("MBQ shared upload read failed:", error.message);
    res.status(500).json({ success: false, error: "Could not load shared MBQ upload" });
  }
});
app.put("/api/mbq/shared-upload/:category", express.json({ limit: "90mb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  if (!MBQ_MASTER_UPLOAD_PIN || String(req.get("X-MBQ-Master-Pin") || "") !== MBQ_MASTER_UPLOAD_PIN) return res.status(401).json({ success: false, error: "Upload PIN is missing or incorrect" });
  const category = String(req.params.category || "");
  if (!["monthly-indent", "open-po-report", "production-settings"].includes(category)) return res.status(400).json({ success: false, error: "Unsupported upload category" });
  try {
    const b = req.body || {}, fileName = String(b.fileName || "").trim().slice(0,255), size = Number(b.fileSize || 0), payload = b.payload;
    if (!fileName || payload == null || !Number.isFinite(size) || size < 0) return res.status(400).json({ success: false, error: "A valid file name, size and parsed payload are required" });
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") > 90 * 1024 * 1024) return res.status(413).json({ success: false, error: "Parsed upload exceeds the 90 MB storage limit" });
    const result = await masterPool.query("INSERT INTO public.mbq_shared_uploads(category,file_name,payload,source_file_size,uploaded_at) VALUES($1,$2,$3::jsonb,$4,NOW()) ON CONFLICT(category) DO UPDATE SET file_name=EXCLUDED.file_name,payload=EXCLUDED.payload,source_file_size=EXCLUDED.source_file_size,uploaded_at=NOW() RETURNING file_name,source_file_size,uploaded_at", [category,fileName,json,size]);
    res.json({ success: true, upload: { fileName: result.rows[0].file_name, sourceFileSize: Number(result.rows[0].source_file_size || 0), uploadedAt: result.rows[0].uploaded_at } });
  } catch (error) {
    console.error("MBQ shared upload save failed:", error.message);
    res.status(500).json({ success: false, error: "Could not save shared MBQ upload" });
  }
});
app.get("/api/mbq/open-to", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  try {
    const result = await masterPool.query("SELECT payload FROM public.mbq_shared_uploads WHERE category='open-to-state'");
    res.json({ success: true, data: result.rowCount && Array.isArray(result.rows[0].payload) ? result.rows[0].payload : [] });
  } catch (error) { res.status(500).json({ success: false, error: "Could not read shared Open TO state", detail: error.message }); }
});
app.put("/api/mbq/open-to", express.json({ limit: "20mb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  if (!Array.isArray(req.body && req.body.data)) return res.status(400).json({ success: false, error: "data must be an array" });
  try {
    const json = JSON.stringify(req.body.data);
    if (Buffer.byteLength(json, "utf8") > 20 * 1024 * 1024) return res.status(413).json({ success: false, error: "Open TO data exceeds the 20 MB limit" });
    await masterPool.query("INSERT INTO public.mbq_shared_uploads(category,file_name,payload,source_file_size,uploaded_at) VALUES('open-to-state','Open TO records',$1::jsonb,$2,NOW()) ON CONFLICT(category) DO UPDATE SET payload=EXCLUDED.payload,source_file_size=EXCLUDED.source_file_size,uploaded_at=NOW()", [json, Buffer.byteLength(json, "utf8")]);
    res.json({ success: true, count: req.body.data.length, savedAt: new Date().toISOString() });
  } catch (error) { res.status(500).json({ success: false, error: "Could not save shared Open TO state", detail: error.message }); }
});
// Shared manual CFA allocation overrides: same values are restored on every dashboard device.
app.get("/api/mbq/cfa-allocation", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  try {
    const result = await masterPool.query("SELECT payload FROM public.mbq_shared_uploads WHERE category='cfa-allocation-state'");
    const data = result.rowCount && result.rows[0].payload && typeof result.rows[0].payload === "object" ? result.rows[0].payload : {};
    res.json({ success: true, data });
  } catch (error) { res.status(500).json({ success: false, error: "Could not load shared CFA allocation", detail: error.message }); }
});
app.put("/api/mbq/cfa-allocation", express.json({ limit: "10mb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  const data = req.body && req.body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return res.status(400).json({ success: false, error: "data must be an allocation object" });
  try {
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, "utf8") > 10 * 1024 * 1024) return res.status(413).json({ success: false, error: "CFA allocation data exceeds the 10 MB limit" });
    await masterPool.query("INSERT INTO public.mbq_shared_uploads(category,file_name,payload,source_file_size,uploaded_at) VALUES('cfa-allocation-state','CFA Allocation', $1::jsonb,$2,NOW()) ON CONFLICT(category) DO UPDATE SET payload=EXCLUDED.payload,source_file_size=EXCLUDED.source_file_size,uploaded_at=NOW()", [json, Buffer.byteLength(json, "utf8")]);
    res.json({ success: true, count: Object.keys(data).length, savedAt: new Date().toISOString() });
  } catch (error) { res.status(500).json({ success: false, error: "Could not save shared CFA allocation", detail: error.message }); }
});

app.get("/api/mbq/status", (req, res) => res.json({ service: "MBQ Smart Indent Dashboard", liveSohEndpoint: "/api/mbq/soh" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "MBQ Smart Indent Dashboard" });
});

app.get("/", (req, res) => {
  if (!fs.existsSync(prototypeFile)) {
    return res.status(404).send("MBQ prototype HTML file not found.");
  }

  res.sendFile(prototypeFile);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MBQ Smart Indent Dashboard running on port ${PORT}`);
});