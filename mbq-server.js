const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const { Pool } = require("pg");
const sharedCache = require("./shared-cache/read-from-neon");
const sharedCacheControl = require("./shared-cache/manual-control");
const { getAccessControlPool } = require("./employee-access-control/postgres-db");
const { authenticateCredentials, resolveSession, revokeSession, extractSessionToken, sessionCookie, clearSessionCookie, SUPER_ADMIN_ID } = require("./employee-access-control/session-auth");
// Use explicit libpq-compatible secure SSL semantics for both isolated MBQ databases.
function mbqVerifiedDatabaseUrl(value) {
  const parsed = new URL(value);
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed.toString();
}
const draftPool = process.env.DATABASE_URL ? new Pool({ connectionString: mbqVerifiedDatabaseUrl(process.env.DATABASE_URL), ssl: { rejectUnauthorized: true }, max: 5 }) : null;
const masterPool = process.env.MBQ_MASTER_DATABASE_URL ? new Pool({ connectionString: mbqVerifiedDatabaseUrl(process.env.MBQ_MASTER_DATABASE_URL), ssl: { rejectUnauthorized: true }, max: 3 }) : null;
const MBQ_MASTER_UPLOAD_PIN = process.env.MBQ_MASTER_UPLOAD_PIN || "";

const SOH_SHEET = process.env.SOH_SHEET_NAME || "LIVE STOCK REPORT";
const CACHE_DIR = path.join(os.tmpdir(), "mbq-live-data");
let sohLoadPromise = null;

const GSV_SHEET = process.env.GSV_SHEET_NAME || "ACX_Sales_Register";
let githubReleaseMetadataCache = { expiresAt: 0, release: null };
function githubReleaseMetadata() {
  if (githubReleaseMetadataCache.expiresAt > Date.now() && githubReleaseMetadataCache.release) return Promise.resolve(githubReleaseMetadataCache.release);
  return new Promise((resolve, reject) => {
    const request = https.get("https://api.github.com/repos/manoop2054/UNIBIC-Kerala-Sales-Dashboard/releases/latest", {
      headers: { "User-Agent": "UNIBIC-Dashboard-Data-Metadata", "Accept": "application/vnd.github+json" }
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error("GitHub latest release API HTTP " + response.statusCode);
          const release = JSON.parse(body);
          if (!Array.isArray(release.assets)) throw new Error("Latest GitHub release has no assets");
          githubReleaseMetadataCache = { expiresAt: Date.now() + 60 * 1000, release };
          resolve(release);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error("GitHub metadata timeout")));
    request.on("error", reject);
  });
}
async function githubReleaseAssetUrl(name) {
  const release = await githubReleaseMetadata();
  const asset = release.assets.find(item => item.name === name);
  if (!asset || !asset.browser_download_url) throw new Error("Latest GitHub release " + release.tag_name + " is missing asset " + name);
  return asset.browser_download_url;
}
async function githubReleaseAssetTimes() {
  try {
    const release = await githubReleaseMetadata();
    const byName = Object.fromEntries(release.assets.map(asset => [asset.name, asset.created_at]));
    const fmt = value => value ? new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true
    }).format(new Date(value)) + " IST" : "Unavailable";
    return "GitHub Release: " + release.tag_name + " | GitHub Last Upload | GSV: " +
      fmt(byName["KL.LIVE.GSV.LINK-MANOOB.xlsx"]) + " | LIVE SOH: " + fmt(byName["LIVE.STOCK.xlsb"]);
  } catch (error) {
    return "GitHub release metadata unavailable: " + error.message;
  }
}

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
async function buildMbqGsvAggregateFromGitHub() {
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const source = path.join(CACHE_DIR, "KL.LIVE.GSV.LINK-MANOOB.xlsx");
  const cache = path.join(CACHE_DIR, "gsv-aggregate.json");
  const tmp = cache + ".tmp";
  console.log("MBQ GSV: downloading source workbook");
  await downloadToFileWithRetry(await githubReleaseAssetUrl("KL.LIVE.GSV.LINK-MANOOB.xlsx"), source, 3);
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
          dbrCode: find(["Ship Code","ShipCode","Ship To Code","ShipToCode","Ship To Customer Code","DBR Code","DBRCode","Customer Code","CustomerCode","Debtor Code","Customer Id","Account Code"]),
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
      if (rowCount % 20000 === 0) console.log("MBQ GSV progress:", rowCount, "rows", "|", await githubReleaseAssetTimes());
    }
    break;
  }
  if (!sheetFound) throw new Error("GSV worksheet not found: " + GSV_SHEET);
  if (!indexes || !aggregate.size) throw new Error("GSV workbook contained no usable item/month/quantity records");
  const payload = { success: true, schemaVersion: 4, data: Array.from(aggregate.values()), rows: rowCount, matchedRows, aggregateRows: aggregate.size, loadedAt: new Date().toISOString(), dateCoverage: { from: minDate, to: maxDate }, detected: stats.detected, headers: stats.headers, sourceBytes: stats.sourceBytes, source: "github" };
  await fs.promises.writeFile(tmp, JSON.stringify(payload), "utf8");
  await fs.promises.rename(tmp, cache);
  console.log("MBQ GSV ready:", JSON.stringify({ rows: rowCount, matchedRows, aggregateRows: aggregate.size, detected: stats.detected }), "|", await githubReleaseAssetTimes());
  gsvLoadError = null;
  return payload;
}
async function buildMbqGsvAggregate() {
  if (sharedCache.isConfigured && await isSharedCacheEnabled()) {
    try {
      const result = await sharedCache.readMbqGsvAggregate();
      console.log("DATA SOURCE: NEON CACHE | MBQ GSV:", result.rows, "source rows,", result.aggregateRows, "aggregate rows | NEON CACHE UPDATED:", result.loadedAt || "unknown", "|", await githubReleaseAssetTimes());
      return result;
    } catch (error) {
      console.warn("MBQ GSV Neon cache unavailable; using existing GitHub loader:", error.message);
    }
  }
  return buildMbqGsvAggregateFromGitHub();
}

async function readMbqGsvCache() {
  const cache = path.join(CACHE_DIR, "gsv-aggregate.json");
  const useNeon = sharedCache.isConfigured && await isSharedCacheEnabled();
  const expectedSource = useNeon ? "neon-shared-cache" : "github";
  const activeVersion = useNeon ? await sharedCache.getActiveDatasetVersion('gsv').catch(error => { console.warn('MBQ GSV Neon version check failed:', error.message); return null; }) : null;
  try {
    const stat = await fs.promises.stat(cache);
    const cached = JSON.parse(await fs.promises.readFile(cache, "utf8"));
    const cachedSource = cached.source === "neon-shared-cache" ? "neon-shared-cache" : "github";
    const cacheTtl = 15 * 60 * 1000;
    if (cachedSource === expectedSource && (!useNeon || (activeVersion && cached.refreshId === activeVersion.refreshId)) && Date.now() - stat.mtimeMs < cacheTtl) {
      if (cached.schemaVersion === 4 && Array.isArray(cached.data) && cached.data.every(row => row && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || "")))) return cached;
      console.log("MBQ GSV cache schema outdated; rebuilding with posting dates");
    }
  } catch (_) {}
  if (!gsvLoadPromise) {
    gsvLoadError = null;
    gsvLoadPromise = buildMbqGsvAggregate().then(async result => {
      // Persist Neon results to the same local cache used by subsequent API requests.
      // Without this write, every request after the loading response re-queries Neon.
      if (result && result.source === "neon-shared-cache") {
        await fs.promises.mkdir(CACHE_DIR, { recursive: true });
        const tmp = cache + ".tmp";
        await fs.promises.writeFile(tmp, JSON.stringify(result), "utf8");
        await fs.promises.rename(tmp, cache);
      }
      return result;
    }).catch(error => {
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
async function downloadToFileWithRetry(url, dest, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.promises.rm(dest, { force: true });
      await downloadToFile(url, dest);
      const stat = await fs.promises.stat(dest);
      if (!stat.size) throw new Error("Downloaded GSV workbook is empty");
      return;
    } catch (error) {
      lastError = error;
      console.error("MBQ GSV download attempt " + attempt + "/" + maxAttempts + " failed:", error.message || error);
      await fs.promises.rm(dest, { force: true }).catch(() => {});
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
    }
  }
  throw lastError || new Error("GSV workbook download failed");
}

async function loadSohRows() {
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const cache = path.join(CACHE_DIR, "soh.json");
  const useNeon = sharedCache.isConfigured && await isSharedCacheEnabled();
  const expectedSource = useNeon ? "neon-shared-cache" : "github";
  const activeVersion = useNeon ? await sharedCache.getActiveDatasetVersion("soh").catch(error => { console.warn("MBQ LIVE SOH Neon version check failed:", error.message); return null; }) : null;
  try {
    const st = await fs.promises.stat(cache);
    const cached = JSON.parse(await fs.promises.readFile(cache, "utf8"));
    const cachedSource = cached.source === "neon-shared-cache" ? "neon-shared-cache" : "github";
    const cacheTtl = 15 * 60 * 1000;
    if (cachedSource === expectedSource && (!useNeon || (activeVersion && cached.refreshId === activeVersion.refreshId)) && Date.now() - st.mtimeMs < cacheTtl) return cached;
  } catch (_) {}
  if (!sohLoadPromise) sohLoadPromise = (async () => {
    if (sharedCache.isConfigured && await isSharedCacheEnabled()) {
      try {
        const shared = await sharedCache.readMbqSohRows();
        const payload = { ...shared, source: "neon-shared-cache" };
        await fs.promises.writeFile(cache, JSON.stringify(payload));
        console.log("DATA SOURCE: NEON CACHE | MBQ LIVE SOH:", payload.rows, "rows | NEON CACHE UPDATED:", payload.loadedAt || "unknown", "|", await githubReleaseAssetTimes());
        return payload;
      } catch (error) {
        console.warn("MBQ LIVE SOH Neon cache unavailable; using existing GitHub loader:", error.message);
      }
    }
    const source = path.join(CACHE_DIR, "LIVE.STOCK.xlsb");
    await downloadToFile(await githubReleaseAssetUrl("LIVE.STOCK.xlsb"), source);
    const wb = XLSX.readFile(source, { cellDates: true });
    const sheetName = wb.SheetNames.includes(SOH_SHEET) ? SOH_SHEET : wb.SheetNames[0];
    if (!sheetName) throw new Error("No worksheet found in LIVE SOH workbook");
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
    await fs.promises.writeFile(cache, JSON.stringify({ data: rows, sheet: sheetName, rows: rows.length, loadedAt: new Date().toISOString() }));
    console.log("DATA SOURCE: GITHUB LATEST RELEASE | MBQ LIVE SOH loaded:", rows.length, "rows from", sheetName, "| CACHE UPDATED:", new Date().toISOString(), "|", await githubReleaseAssetTimes());
    return { data: rows, sheet: sheetName, rows: rows.length, loadedAt: new Date().toISOString(), source: "github" };
  })().finally(() => { sohLoadPromise = null; });
  return sohLoadPromise;
}

const app = express();
const PORT = process.env.PORT || 10000;

// Respect the shared endpoint's global ON/OFF switch before opening a Neon
// database connection. If control status cannot be verified, fail closed and
// continue through the existing GitHub loader.
async function isSharedCacheEnabled() {
  try {
    const status = await sharedCacheControl.getStatus();
    return status.enabled === true;
  } catch (error) {
    console.warn("MBQ shared cache control status unavailable; using GitHub loader:", error.message);
    return false;
  }
}

const prototypeFile = path.join(
  __dirname,
  "MBQ_Smart_Indent_Control_Tower_Updated_Prototype7.html"
);




const mbqLoginAttempts = new Map();
const MBQ_ALLOWED_TABS = ["overview","indent","suggest","stock","totracker","advanced","allocation","distributor","peak","loading","flash","reports","excelview","settings","manualindent"];
let mbqAccessTableReady = null;
async function ensureMbqAccessTable(pool) {
  if (!mbqAccessTableReady) {
    mbqAccessTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS mbq_employee_tab_access (
        employee_id TEXT PRIMARY KEY REFERENCES employees(employee_id) ON DELETE CASCADE,
        allowed_tabs TEXT[] NOT NULL DEFAULT '{}',
        can_upload_excel BOOLEAN NOT NULL DEFAULT FALSE,
        updated_by TEXT REFERENCES employees(employee_id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(error => { mbqAccessTableReady = null; throw error; });
  }
  await mbqAccessTableReady;
}
function mbqIsSuperAdmin(user) {
  return String(user.role || "").toUpperCase() === "SUPER_ADMIN" &&
    String(user.employeeId || "").toUpperCase() === SUPER_ADMIN_ID;
}
async function mbqGetAccess(pool,user) {
  await ensureMbqAccessTable(pool);
  if (mbqIsSuperAdmin(user)) return { allowedTabs: MBQ_ALLOWED_TABS, canUploadExcel: true };
  const r = await pool.query("SELECT allowed_tabs, can_upload_excel FROM mbq_employee_tab_access WHERE employee_id=$1", [user.employeeId]);
  const row = r.rows[0];
  return {
    allowedTabs: row ? (row.allowed_tabs || []).filter(tab => MBQ_ALLOWED_TABS.includes(tab)) : [],
    canUploadExcel: Boolean(row && row.can_upload_excel)
  };
}
async function mbqPublicUser(pool,user) {
  const employeeId = String(user.employeeId || user.employee_id || "");
  const access = await mbqGetAccess(pool,user);
  return {
    employeeId,
    maskedEmployeeId: employeeId.length > 5 ? employeeId.slice(0, 2) + "*****" + employeeId.slice(-2) : "*****",
    employeeName: user.employeeName || user.employee_name || "",
    designation: user.designation || "",
    role: String(user.role || "").toUpperCase(),
    allowedTabs: access.allowedTabs,
    canUploadExcel: access.canUploadExcel
  };
}
async function mbqRequireSuperAdmin(req,res) {
  const pool = getAccessControlPool();
  if (!pool) { res.status(503).json({ success:false,error:"Employee database is not configured." }); return null; }
  try {
    const user = await resolveSession(pool, extractSessionToken(req.headers.cookie));
    if (!user) { res.status(401).json({ success:false,error:"Employee login required." }); return null; }
    if (!mbqIsSuperAdmin(user)) { res.status(403).json({ success:false,error:"Super Admin access required." }); return null; }
    await ensureMbqAccessTable(pool);
    return { pool, user };
  } catch (error) {
    console.error("MBQ permission administration check failed:",error.message);
    res.status(503).json({ success:false,error:"Unable to verify MBQ administrator access." });
    return null;
  }
}
app.get("/api/mbq/admin/employee-access", async (req,res) => {
  res.setHeader("Cache-Control","no-store");
  const auth = await mbqRequireSuperAdmin(req,res); if(!auth)return;
  try {
    const r = await auth.pool.query(`
      SELECT e.employee_id,e.employee_name,e.designation,e.role,e.status,
             COALESCE(a.allowed_tabs,'{}'::text[]) AS allowed_tabs,
             COALESCE(a.can_upload_excel,FALSE) AS can_upload_excel
      FROM employees e
      LEFT JOIN mbq_employee_tab_access a ON a.employee_id=e.employee_id
      WHERE e.status='ACTIVE'
      ORDER BY CASE WHEN UPPER(e.role)='SUPER_ADMIN' THEN 0 WHEN UPPER(e.role)='ADMIN' THEN 1 ELSE 2 END,e.employee_name
    `);
    res.json({success:true,tabs:MBQ_ALLOWED_TABS,employees:r.rows});
  } catch(error) {
    console.error("MBQ employee access list failed:",error.message);
    res.status(500).json({success:false,error:"Could not load employee access list."});
  }
});
app.put("/api/mbq/admin/employee-access/:employeeId", express.json({limit:"20kb"}), async(req,res) => {
  res.setHeader("Cache-Control","no-store");
  const auth = await mbqRequireSuperAdmin(req,res); if(!auth)return;
  const employeeId=String(req.params.employeeId||"").trim().toUpperCase();
  const requested=Array.isArray(req.body && req.body.allowedTabs)?req.body.allowedTabs:[];
  const allowedTabs=[...new Set(requested.filter(tab=>MBQ_ALLOWED_TABS.includes(tab)))];
  const canUploadExcel=Boolean(req.body && req.body.canUploadExcel);
  if(!employeeId || employeeId===SUPER_ADMIN_ID) return res.status(400).json({success:false,error:"Protected Super Admin permissions cannot be changed."});
  try {
    const employee=await auth.pool.query("SELECT employee_id FROM employees WHERE employee_id=$1 AND status='ACTIVE'",[employeeId]);
    if(!employee.rowCount) return res.status(404).json({success:false,error:"Active employee not found."});
    await auth.pool.query(`
      INSERT INTO mbq_employee_tab_access(employee_id,allowed_tabs,can_upload_excel,updated_by,updated_at)
      VALUES($1,$2::text[],$3,$4,NOW())
      ON CONFLICT(employee_id) DO UPDATE SET allowed_tabs=EXCLUDED.allowed_tabs,can_upload_excel=EXCLUDED.can_upload_excel,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `,[employeeId,allowedTabs,canUploadExcel,auth.user.employeeId]);
    res.json({success:true,employeeId,allowedTabs,canUploadExcel});
  } catch(error) {
    console.error("MBQ employee access save failed:",error.message);
    res.status(500).json({success:false,error:"Could not save MBQ permissions."});
  }
});
app.post("/api/mbq/auth/login", express.json({ limit: "10kb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const ip = String(req.ip || req.socket.remoteAddress || "unknown").slice(0, 100);
  const now = Date.now();
  let attempt = mbqLoginAttempts.get(ip);
  if (!attempt || now - attempt.start >= 10 * 60 * 1000) { attempt = { start: now, count: 0 }; mbqLoginAttempts.set(ip, attempt); }
  if (attempt.count >= 10) return res.status(429).json({ success: false, error: "Too many login attempts. Try again in 10 minutes." });
  attempt.count++;
  const pool = getAccessControlPool();
  if (!pool) return res.status(503).json({ success: false, error: "Employee database is not configured." });
  try {
    const result = await authenticateCredentials(pool, req.body && req.body.employee_id, req.body && req.body.password);
    if (!result) return res.status(401).json({ success: false, error: "Employee ID or password is incorrect, or the account is inactive." });
    const user = await mbqPublicUser(pool,result.user);
    if (!user.allowedTabs.length) {
      await revokeSession(pool,result.token);
      return res.status(403).json({ success:false,accessPending:true,error:"MBQ access has not been assigned by Super Admin." });
    }
    mbqLoginAttempts.delete(ip);
    res.setHeader("Set-Cookie", sessionCookie(result.token));
    return res.json({ success: true, user });
  } catch (error) {
    console.error("MBQ employee login failed:", error.message);
    return res.status(503).json({ success: false, error: "Unable to complete login securely." });
  }
});
app.get("/api/mbq/auth/me", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const pool = getAccessControlPool();
  if (!pool) return res.status(503).json({ authenticated: false, error: "Employee database is not configured." });
  try {
    const user = await resolveSession(pool, extractSessionToken(req.headers.cookie));
    if (!user) return res.status(401).json({ authenticated: false });
    const publicUser = await mbqPublicUser(pool,user);
    if (!publicUser.allowedTabs.length) return res.status(403).json({ authenticated: true, accessPending: true, user: publicUser });
    return res.json({ authenticated: true, user: publicUser });
  } catch (error) {
    console.error("MBQ employee session check failed:", error.message);
    return res.status(503).json({ authenticated: false, error: "Unable to verify employee session." });
  }
});
app.post("/api/mbq/auth/logout", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", clearSessionCookie());
  const pool = getAccessControlPool();
  if (!pool) return res.json({ success: true });
  try {
    await revokeSession(pool, extractSessionToken(req.headers.cookie));
    return res.json({ success: true });
  } catch (_) {
    return res.status(503).json({ success: false, error: "Browser session cleared; server-side revocation could not be confirmed." });
  }
});
// API access is checked on every request; MBQ does not apply Region/Area/Anchor scopes.
app.use("/api/mbq", async (req, res, next) => {
  if (req.path === "/status" || req.path === "/employee-db-check" || req.path.startsWith("/auth/") || req.path.startsWith("/admin/")) return next();
  res.setHeader("Cache-Control", "no-store");
  const pool = getAccessControlPool();
  if (!pool) return res.status(503).json({ success: false, error: "Employee database is not configured." });
  try {
    const user = await resolveSession(pool, extractSessionToken(req.headers.cookie));
    if (!user) return res.status(401).json({ success: false, error: "Employee login required." });
    const access = await mbqGetAccess(pool,user);
    if (!access.allowedTabs.length) return res.status(403).json({ success:false,error:"MBQ tab access has not been assigned." });
    const p=req.path.toLowerCase();
    const method=req.method.toUpperCase();
    if ((p.startsWith("/master-workbook") || p.startsWith("/shared-upload") || (p.startsWith("/drafts") && method!=="GET")) && !access.canUploadExcel && !mbqIsSuperAdmin(user)) {
      return res.status(403).json({success:false,error:"Excel upload permission is required."});
    }
    const required = p.startsWith("/soh") ? ["stock"] :
      p.startsWith("/open-to") ? ["totracker"] :
      p.startsWith("/cfa-allocation") ? ["allocation"] :
      p.startsWith("/peak") ? ["peak"] :
      p.startsWith("/master-workbook") ? ["excelview","settings"] :
      p.startsWith("/shared-upload") ? ["excelview","indent","allocation","settings"] :
      p.startsWith("/drafts") ? ["excelview","indent","settings"] :
      p.startsWith("/gsv") ? ["overview","indent","suggest","flash","reports","excelview"] :
      MBQ_ALLOWED_TABS;
    if (!mbqIsSuperAdmin(user) && !required.some(tab=>access.allowedTabs.includes(tab))) {
      return res.status(403).json({success:false,error:"Your MBQ tab permission does not allow this data."});
    }
    req.mbqUser=user;
    req.mbqAccess=access;
    return next();
  } catch (_) {
    return res.status(503).json({ success: false, error: "Unable to verify MBQ employee session." });
  }
});

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
app.delete("/api/mbq/drafts", async (req, res) => {
  try {
    await readyDrafts();
    const type = String(req.query.type || "").slice(0, 100);
    if (!type) return res.status(400).json({ success: false, error: "Draft type is required" });
    const result = await draftPool.query("DELETE FROM mbq_shared_drafts WHERE draft_type=$1", [type]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, deletedCount: result.rowCount, type });
  } catch (error) {
    res.status(500).json({ success: false, error: "Could not delete shared drafts", detail: error.message });
  }
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
    // Backward compatibility: older cached dashboard builds submit an empty PUT to remove the Fill Rate report.
    const emptyFillRateRemoval = category === "open-po-report" && !fileName && size === 0 && payload && typeof payload === "object" && Array.isArray(payload.rows) && payload.rows.length === 0 && Array.isArray(payload.headers) && payload.headers.length === 0;
    if (emptyFillRateRemoval) {
      await masterPool.query("DELETE FROM public.mbq_shared_uploads WHERE category=$1", [category]);
      return res.json({ success: true, removed: true, category, compatibility: true });
    }
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
// Explicit shared-upload removal: separate from upload validation so an empty
// file name/size can never be mistaken for a new workbook upload.
app.delete("/api/mbq/shared-upload/:category", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  if (!MBQ_MASTER_UPLOAD_PIN || String(req.get("X-MBQ-Master-Pin") || "") !== MBQ_MASTER_UPLOAD_PIN) return res.status(401).json({ success: false, error: "Upload PIN is missing or incorrect" });
  const category = String(req.params.category || "");
  if (!["open-po-report", "monthly-indent"].includes(category)) return res.status(400).json({ success: false, error: "Removal is not enabled for this upload category" });
  try {
    await masterPool.query("DELETE FROM public.mbq_shared_uploads WHERE category=$1", [category]);
    res.json({ success: true, removed: true, category });
  } catch (error) {
    console.error("MBQ shared upload removal failed:", error.message);
    res.status(500).json({ success: false, error: "Could not remove shared Fill Rate Report" });
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

// Shared Peak Planner manual indents, persisted centrally for all dashboard users.
app.get("/api/mbq/peak-manual-indent", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  try {
    const result = await masterPool.query("SELECT payload FROM public.mbq_shared_uploads WHERE category='peak-manual-indent'");
    const payload = result.rowCount && result.rows[0].payload && typeof result.rows[0].payload === "object" ? result.rows[0].payload : {};
    const data = Array.isArray(payload.submissions) ? payload : { legacyEntries: payload, submissions: [] };
    res.json({ success: true, data });
  } catch (error) { res.status(500).json({ success: false, error: "Could not load Peak Planner manual indents", detail: error.message }); }
});
app.put("/api/mbq/peak-manual-indent", express.json({ limit: "10mb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  const data = req.body && req.body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return res.status(400).json({ success: false, error: "data must be a manual indent object" });
  try {
    for (const [key, value] of Object.entries(data)) {
      if (key.length > 500 || !Number.isFinite(Number(value)) || Number(value) < 0) return res.status(400).json({ success: false, error: "Invalid manual indent entry" });
    }
    const current = await masterPool.query("SELECT payload FROM public.mbq_shared_uploads WHERE category='peak-manual-indent'");
    const prior = current.rowCount && current.rows[0].payload && typeof current.rows[0].payload === "object" ? current.rows[0].payload : {};
    const legacyEntries = Array.isArray(prior.submissions) ? (prior.legacyEntries || {}) : prior;
    const submissions = Array.isArray(prior.submissions) ? prior.submissions : [];
    const payload = JSON.stringify({ legacyEntries: { ...legacyEntries, ...data }, submissions });
    if (Buffer.byteLength(payload, "utf8") > 10 * 1024 * 1024) return res.status(413).json({ success: false, error: "Peak Planner manual indents exceed the 10 MB limit" });
    await masterPool.query("INSERT INTO public.mbq_shared_uploads AS stored(category,file_name,payload,source_file_size,uploaded_at) VALUES('peak-manual-indent','Peak Planner Manual Indents',$1::jsonb,$2,NOW()) ON CONFLICT(category) DO UPDATE SET payload=EXCLUDED.payload,source_file_size=EXCLUDED.source_file_size,uploaded_at=NOW()", [payload, Buffer.byteLength(payload, "utf8")]);
    res.json({ success: true, count: Object.keys(data).length, savedAt: new Date().toISOString() });
  } catch (error) { res.status(500).json({ success: false, error: "Could not save legacy Peak Planner manual indents", detail: error.message }); }
});
app.post("/api/mbq/peak-manual-indent", express.json({ limit: "10mb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  const b = req.body && req.body.submission;
  if (!b || typeof b !== "object" || Array.isArray(b)) return res.status(400).json({ success: false, error: "submission object is required" });
  const month = String(b.month || ""), cfa = String(b.cfa || "").toUpperCase();
  const fromDate = String(b.fromDate || ""), toDate = String(b.toDate || ""), submissionDate = String(b.submissionDate || "");
  if (!/^\d{4}-\d{2}$/.test(month) || !["TVD", "PAY", "ALU"].includes(cfa) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) ||
      fromDate.slice(0, 7) !== month || toDate.slice(0, 7) !== month || toDate < fromDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(submissionDate)) {
    return res.status(400).json({ success: false, error: "Valid month, CFA, submission date and same-month indent period are required" });
  }
  if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 2000) return res.status(400).json({ success: false, error: "At least one SKU Group row is required" });
  const seen = new Set(), rows = [];
  for (const row of b.rows) {
    const group = String(row && row.group || "").trim(), qty = Number(row && row.qty);
    if (!group || group.length > 200 || !Number.isFinite(qty) || qty <= 0 || seen.has(group)) return res.status(400).json({ success: false, error: "Invalid or duplicate SKU Group quantity" });
    seen.add(group);
    rows.push({ group, qty });
  }
  const actor=req.mbqUser||{};
  const submission = {
    id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10),
    month, cfa, fromDate, toDate, submissionDate, rows, submittedAt: new Date().toISOString(),
    employeeId:String(actor.employeeId||actor.employee_id||""),employeeName:String(actor.employeeName||actor.employee_name||"").slice(0,200),
    submittedByRole:String(actor.role||"").toUpperCase(),editHistory:[]
  };
  try {
    const json = JSON.stringify(submission);
    const result = await masterPool.query(
      "INSERT INTO public.mbq_shared_uploads(category,file_name,payload,source_file_size,uploaded_at) VALUES('peak-manual-indent','Peak Planner Manual Indent',jsonb_build_object('legacyEntries','{}'::jsonb,'submissions',jsonb_build_array($1::jsonb)),$2,NOW()) " +
      "ON CONFLICT(category) DO UPDATE SET payload=CASE " +
      "WHEN jsonb_typeof(stored.payload->'submissions')='array' THEN jsonb_set(stored.payload,'{submissions}',stored.payload->'submissions' || jsonb_build_array($1::jsonb),true) " +
      "ELSE jsonb_build_object('legacyEntries',stored.payload,'submissions',jsonb_build_array($1::jsonb)) END, " +
      "source_file_size=stored.source_file_size+EXCLUDED.source_file_size,uploaded_at=NOW() RETURNING payload",
      [json, Buffer.byteLength(json, "utf8")]
    );
    res.status(201).json({ success: true, submission, data: result.rows[0].payload });
  } catch (error) {
    console.error("Peak Planner manual-indent submission failed:", error.message);
    res.status(500).json({ success: false, error: "Could not save Peak Planner manual-indent submission" });
  }
});

app.put("/api/mbq/peak-manual-indent/:submissionId", express.json({ limit: "10mb" }), async (req,res) => {
  res.setHeader("Cache-Control","no-store");
  const actor=req.mbqUser||{},role=String(actor.role||"").toUpperCase();
  if(!["ADMIN","SUPER_ADMIN"].includes(role)) return res.status(403).json({success:false,error:"Only Admin or Super Admin can edit saved manual indents."});
  if(!masterPool) return res.status(503).json({success:false,error:"Shared MBQ storage is not configured"});
  const id=String(req.params.submissionId||""),incoming=req.body&&req.body.rows;
  if(!id||!Array.isArray(incoming)||!incoming.length||incoming.length>2000) return res.status(400).json({success:false,error:"Valid submission rows are required."});
  const seen=new Set(),rows=[];
  for(const row of incoming){const group=String(row&&row.group||"").trim(),qty=Number(row&&row.qty);if(!group||group.length>200||!Number.isFinite(qty)||qty<=0||seen.has(group))return res.status(400).json({success:false,error:"Invalid or duplicate SKU Group quantity."});seen.add(group);rows.push({group,qty});}
  const client=await masterPool.connect();
  try{
    await client.query("BEGIN");
    const current=await client.query("SELECT payload FROM public.mbq_shared_uploads WHERE category='peak-manual-indent' FOR UPDATE");
    const payload=current.rowCount&&current.rows[0].payload&&typeof current.rows[0].payload==="object"?current.rows[0].payload:{};
    const submissions=Array.isArray(payload.submissions)?payload.submissions:[];
    const index=submissions.findIndex(x=>String(x.id||"")===id);
    if(index<0){await client.query("ROLLBACK");return res.status(404).json({success:false,error:"Saved submission not found."});}
    const prior=submissions[index];if(prior.legacy){await client.query("ROLLBACK");return res.status(400).json({success:false,error:"Legacy entries cannot be edited."});}
    const editedAt=new Date().toISOString(),employeeId=String(actor.employeeId||actor.employee_id||""),employeeName=String(actor.employeeName||actor.employee_name||"").slice(0,200);
    submissions[index]={...prior,rows,editedAt,editedByEmployeeId:employeeId,editedByEmployeeName:employeeName,editHistory:[...(Array.isArray(prior.editHistory)?prior.editHistory:[]),{editedAt,employeeId,employeeName,role,previousRows:prior.rows||[],newRows:rows}]};
    const next={legacyEntries:payload.legacyEntries&&typeof payload.legacyEntries==="object"?payload.legacyEntries:{},submissions},json=JSON.stringify(next);
    await client.query("UPDATE public.mbq_shared_uploads SET payload=$1::jsonb,source_file_size=$2,uploaded_at=NOW() WHERE category='peak-manual-indent'",[json,Buffer.byteLength(json,"utf8")]);
    await client.query("COMMIT");res.json({success:true,submission:submissions[index],data:next});
  }catch(error){try{await client.query("ROLLBACK");}catch(_){}console.error("Peak Planner manual-indent edit failed:",error.message);res.status(500).json({success:false,error:"Could not update saved manual indent."});}
  finally{client.release();}
});
app.get("/api/mbq/peak-abm-manual", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  try {
    const result = await masterPool.query("SELECT payload FROM public.mbq_shared_uploads WHERE category='peak-abm-manual'");
    const payload = result.rowCount && result.rows[0].payload && typeof result.rows[0].payload === "object" ? result.rows[0].payload : {};
    res.json({ success: true, data: payload });
  } catch (error) {
    console.error("Peak ABM manual quantity read failed:", error.message);
    res.status(500).json({ success: false, error: "Could not load Peak ABM manual quantities" });
  }
});
app.get("/api/mbq/peak-abm-manual-history", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  try {
    const result = await masterPool.query("SELECT payload FROM public.mbq_shared_uploads WHERE category='peak-abm-manual-history'");
    const history = result.rowCount && Array.isArray(result.rows[0].payload) ? result.rows[0].payload : [];
    res.json({ success: true, history });
  } catch (error) {
    console.error("Peak ABM manual history read failed:", error.message);
    res.status(500).json({ success: false, error: "Could not load Manual Qty history" });
  }
});
app.put("/api/mbq/peak-abm-manual", express.json({ limit: "2mb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!masterPool) return res.status(503).json({ success: false, error: "Shared MBQ storage is not configured" });
  const data = req.body && req.body.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length > 2000) return res.status(400).json({ success: false, error: "Manual Qty data must be an object with at most 2000 entries" });
  for (const [key, value] of Object.entries(data)) {
    if (key.length > 500 || !/^\d{4}-\d{2}\|(TVD|PAY|ALU)\|.+$/.test(key) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 100000000) {
      return res.status(400).json({ success: false, error: "Invalid Peak ABM manual quantity entry" });
    }
  }
  let client;
  try {
    client = await masterPool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["peak-abm-manual-history"]);
    const current = await client.query("SELECT payload FROM public.mbq_shared_uploads WHERE category='peak-abm-manual' FOR UPDATE");
    const prior = current.rowCount && current.rows[0].payload && typeof current.rows[0].payload === "object" ? current.rows[0].payload : {};
    const next = { ...prior, ...data };
    const payload = JSON.stringify(next);
    if (Buffer.byteLength(payload, "utf8") > 2 * 1024 * 1024) {
      await client.query("ROLLBACK");
      return res.status(413).json({ success: false, error: "Peak ABM manual quantities exceed the 2 MB limit" });
    }
    const actor = req.mbqUser || null;
    const actorName = actor ? String(actor.employeeName || actor.employee_name || actor.employeeId || actor.employee_id || "Authenticated User") : "Authenticated User";
    const savedAt = new Date().toISOString();
    const history = Object.entries(data).reduce((rows, [key, value]) => {
      const oldValue = Object.prototype.hasOwnProperty.call(prior, key) && Number.isFinite(Number(prior[key])) ? Number(prior[key]) : null;
      const newValue = Number(value);
      if (oldValue === newValue) return rows;
      const [month, cfa, ...groupParts] = key.split("|");
      rows.push({ savedAt, user: actorName, month, cfa, skuGroup: groupParts.join("|"), previousQty: oldValue, newQty: newValue });
      return rows;
    }, []);
    await client.query(
      "INSERT INTO public.mbq_shared_uploads(category,file_name,payload,source_file_size,uploaded_at) VALUES('peak-abm-manual','Peak ABM Manual Quantities',$1::jsonb,$2,NOW()) ON CONFLICT(category) DO UPDATE SET payload=EXCLUDED.payload,source_file_size=EXCLUDED.source_file_size,uploaded_at=NOW()",
      [payload, Buffer.byteLength(payload, "utf8")]
    );
    if (history.length) {
      const historyJson = JSON.stringify(history);
      await client.query(
        "INSERT INTO public.mbq_shared_uploads AS stored(category,file_name,payload,source_file_size,uploaded_at) VALUES('peak-abm-manual-history','Peak ABM Manual Qty History',$1::jsonb,$2,NOW()) ON CONFLICT(category) DO UPDATE SET payload=(CASE WHEN jsonb_typeof(stored.payload)='array' THEN stored.payload ELSE '[]'::jsonb END) || EXCLUDED.payload,source_file_size=stored.source_file_size+EXCLUDED.source_file_size,uploaded_at=NOW()",
        [historyJson, Buffer.byteLength(historyJson, "utf8")]
      );
    }
    await client.query("COMMIT");
    res.json({ success: true, count: Object.keys(data).length, historyCount: history.length, savedAt });
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch (_) {} }
    console.error("Peak ABM manual quantity save failed:", error.message);
    res.status(500).json({ success: false, error: "Could not save Peak ABM manual quantities and history" });
  } finally {
    if (client) client.release();
  }
});
app.get("/api/mbq/status", (req, res) => res.json({ service: "MBQ Smart Indent Dashboard", liveSohEndpoint: "/api/mbq/soh" }));

app.get("/api/mbq/employee-db-check", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const employeeDb = getAccessControlPool();
  if (!employeeDb) return res.status(503).json({ configured: false, connected: false, message: "Employee database connection is not configured" });
  try {
    await employeeDb.query("SELECT 1");
    return res.json({ configured: true, connected: true, check: "SELECT 1", message: "Employee database connection successful" });
  } catch (error) {
    console.error("MBQ employee database connectivity check failed:", error.message);
    return res.status(503).json({ configured: true, connected: false, message: "Employee database connection failed; check Render environment configuration" });
  }
});

// Protected Super Admin control for the same shared Neon cache used by Kerala dashboard.
sharedCacheControl.mount(app, {
  middleware: express.json({ limit: "2kb" }),
  authorize: async (req, res) => Boolean(await mbqRequireSuperAdmin(req, res))
});

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