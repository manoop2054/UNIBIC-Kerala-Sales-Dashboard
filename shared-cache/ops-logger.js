"use strict";

const crypto = require("crypto");
const util = require("util");

function installOpsLogging({ service, app }) {
  const marker = Symbol.for("unibic.ops.logger.installed");
  if (!console[marker]) {
    for (const level of ["log", "info", "warn", "error"]) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        const now = new Date();
        const ist = new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        }).format(now);
        const message = util.format(...args);
        original(`[${now.toISOString()}] [${ist} IST] [${level.toUpperCase()}] [${service}] [PID:${process.pid}] ${message}`);
      };
    }
    Object.defineProperty(console, marker, { value: true });
  }

  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    const started = process.hrtime.bigint();
    res.setHeader("X-Request-ID", requestId);
    if (req.path.startsWith("/api/")) {
      // Keep successful API polling out of Render logs. Log only failed requests.
      res.on("finish", () => {
        if (res.statusCode < 400) return;
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        console.error("API ERROR", JSON.stringify({
          requestId, method: req.method, path: req.path, status: res.statusCode,
          durationMs: Number(durationMs.toFixed(1))
        }));
      });
    }
    next();
  });

  return {
    runId: () => crypto.randomUUID(),
    service
  };
}

module.exports = { installOpsLogging };
