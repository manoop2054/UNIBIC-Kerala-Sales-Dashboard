const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const { Pool } = require("pg");
const draftPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 }) : null;

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
  let m = raw.match(/^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})/);
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  m = raw.match(/^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})$/);
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
          cfa: find(["LocationCode","Location Code","Location_Code","CFA","Warehouse","Branch","Site"])
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
      const key = item + "|" + date + "|" + (cfa || "ALL");
      const old = aggregate.get(key) || { itemId: item, date, month, cfa: cfa || "ALL", quantity: 0, amount: 0, amountAvailable: false, rows: 0 };
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
  const payload = { success: true, data: Array.from(aggregate.values()), rows: rowCount, matchedRows, aggregateRows: aggregate.size, loadedAt: new Date().toISOString(), dateCoverage: { from: minDate, to: maxDate }, detected: stats.detected, headers: stats.headers, sourceBytes: stats.sourceBytes };
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
    if (Date.now() - stat.mtimeMs < 6 * 60 * 60 * 1000) return JSON.parse(await fs.promises.readFile(cache, "utf8"));
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

const TO_STATE_FILE = path.join(CACHE_DIR, "open-to-state.json");
let toStateWrite = Promise.resolve();
async function readToState() { try { return JSON.parse(await fs.promises.readFile(TO_STATE_FILE, "utf8")); } catch (e) { if (e.code === "ENOENT") return []; throw e; } }
app.get("/api/mbq/open-to", async (req, res) => { try { await fs.promises.mkdir(CACHE_DIR, { recursive: true }); res.setHeader("Cache-Control", "no-store"); res.json({ success: true, data: await readToState() }); } catch (error) { res.status(500).json({ success: false, error: "Could not read Open TO state", detail: error.message }); } });
app.put("/api/mbq/open-to", express.json({ limit: "5mb" }), async (req, res) => { try { if (!Array.isArray(req.body && req.body.data)) return res.status(400).json({ success: false, error: "data must be an array" }); await fs.promises.mkdir(CACHE_DIR, { recursive: true }); const data = req.body.data; toStateWrite = toStateWrite.then(() => fs.promises.writeFile(TO_STATE_FILE, JSON.stringify(data), "utf8")); await toStateWrite; res.json({ success: true, count: data.length, savedAt: new Date().toISOString() }); } catch (error) { res.status(500).json({ success: false, error: "Could not save Open TO state", detail: error.message }); } });
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
