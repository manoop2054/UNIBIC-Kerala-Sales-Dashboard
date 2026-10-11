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
        res.status(400).json({ error: `${label} URL is not configured in environment variables` });
        return;
    }

    const client = fileUrl.startsWith('https') ? https : http;

    const request = (url) => {
        client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (fileRes) => {
            if ([301, 302, 303, 307].includes(fileRes.statusCode)) {
                if (fileRes.headers.location) {
                    return request(fileRes.headers.location);
                }
            }

            if (fileRes.statusCode !== 200) {
                res.status(500).json({ error: `Failed to download ${label}, status: ${fileRes.statusCode}` });
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
                    // Use options to reduce memory overhead
                    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, bookVBA: false });
                    const sheetName = workbook.SheetNames[0];
                    const sheet = workbook.Sheets[sheetName];
                    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
                    
                    if (rows.length === 0) {
                        res.json({ data: [] });
                        return;
                    }

                    // Convert array of arrays to array of objects efficiently
                    const headers = rows[0];
                    const dataRows = [];
                    for (let i = 1; i < rows.length; i++) {
                        let rowObj = {};
                        let hasVal = false;
                        for (let j = 0; j < headers.length; j++) {
                            let val = rows[i][j];
                            if (val !== '' && val !== null && val !== undefined) {
                                hasVal = true;
                            }
                            rowObj[headers[j] || `Col_${j}`] = val;
                        }
                        if (hasVal) dataRows.push(rowObj);
                    }

                    console.log(`${label} parsed successfully: ${dataRows.length} rows`);
                    res.json({ data: dataRows });
                } catch (err) {
                    console.error(`Error parsing ${label} excel:`, err.message);
                    res.status(500).json({ error: `Error parsing ${label} file` });
                }
            });
        }).on('error', (err) => {
            console.error(`${label} Download Error:`, err.message);
            res.status(500).json({ error: `Error loading ${label} file` });
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
    console.log(`UNIBIC Kerala Sales Command Center listening on ${PORT}`);
});
