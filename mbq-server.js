const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

const prototypeFile = path.join(
  __dirname,
  "MBQ_Smart_Indent_Control_Tower_Updated_Prototype7.html"
);

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
