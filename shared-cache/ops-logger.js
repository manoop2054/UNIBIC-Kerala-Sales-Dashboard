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
      console.info("HTTP REQUEST START", JSON.stringify({
        requestId, method: req.method, path: req.path, ip: req.ip || "unknown"
      }));
      res.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
        console[level]("HTTP REQUEST END", JSON.stringify({
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
