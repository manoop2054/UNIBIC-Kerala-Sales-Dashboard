const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const XLSX = require("xlsx");

const SOH_URL = process.env.SOH_SHARE_URL || "https://github.com/manoop2054/UNIBIC-Kerala-Sales-Dashboard/releases/download/v1.0/LIVE.STOCK.xlsb";
const SOH_SHEET = process.env.SOH_SHEET_NAME || "LIVE STOCK REPORT";
const CACHE_DIR = path.join(os.tmpdir(), "mbq-live-data");
let sohLoadPromise = null;
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
