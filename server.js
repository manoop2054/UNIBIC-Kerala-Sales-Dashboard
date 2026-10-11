const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'UNIBIC_Kerala_Sales_Command_Center_FULL_FINAL.html'));
});

function fetchAndParseExcel(fileUrl, res, label) {
    if (!fileUrl) {
        res.status(400).json({ error: `${label} URL is not configured` });
        return;
    }

    const client = fileUrl.startsWith('https') ? https : http;

    const request = (url) => {
        const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (fileRes) => {
            if ([301, 302, 303, 307].includes(fileRes.statusCode)) {
                if (fileRes.headers.location) return request(fileRes.headers.location);
            }

            if (fileRes.statusCode !== 200) {
                console.error(`${label} status error: ${fileRes.statusCode}`);
                res.status(500).json({ error: `Failed status: ${fileRes.statusCode}` });
                return;
            }

            let chunks = [];
            let totalLength = 0;
            fileRes.on('data', (chunk) => {
                chunks.push(chunk);
                totalLength += chunk.length;
            });

            fileRes.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks, totalLength);
                    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
                    const sheetName = workbook.SheetNames[0];
                    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
                    
                    console.log(`${label} success: ${rows.length} rows`);
                    res.json({ data: rows });
                } catch (err) {
                    console.error(`Error parsing ${label}:`, err.message);
                    res.status(500).json({ error: `Parsing error` });
                }
            });
        });

        req.setTimeout(60000, () => { // 60 seconds timeout extension
            req.destroy();
            console.error(`${label} download timeout`);
            res.status(500).json({ error: `Download timeout` });
        });

        req.on('error', (err) => {
            console.error(`${label} Error:`, err.message);
            res.status(500).json({ error: `Download error` });
        });
    };

    request(fileUrl);
}

app.get(['/api/gsv', '/api/live-gsv'], (req, res) => {
    fetchAndParseExcel(process.env.GSV_SHARE_URL, res, 'GSV');
});

app.get(['/api/soh', '/api/live-soh'], (req, res) => {
    fetchAndParseExcel(process.env.SOH_SHARE_URL, res, 'SOH');
});

app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});
