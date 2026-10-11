const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'UNIBIC_Kerala_Sales_Command_Center_FULL_FINAL.html'));
});

function fetchFileFromUrl(fileUrl, res, label) {
    if (!fileUrl) {
        res.status(400).send(`${label} URL is not configured in environment variables`);
        return;
    }

    const client = fileUrl.startsWith('https') ? https : http;

    const request = (url) => {
        client.get(url, (fileRes) => {
            // Handle HTTP redirects (301, 302, 303, 307) commonly used by GitHub
            if ([301, 302, 303, 307].includes(fileRes.statusCode)) {
                if (fileRes.headers.location) {
                    return request(fileRes.headers.location);
                }
            }

            console.log(`${label} Response Status: ${fileRes.statusCode}`);
            
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${label}.xlsx"`);
            
            fileRes.pipe(res);
        }).on('error', (err) => {
            console.error(`${label} Error:`, err.message);
            res.status(500).send(`Error loading ${label} file`);
        });
    };

    request(fileUrl);
}

app.get(['/api/gsv', '/api/live-gsv'], (req, res) => {
    fetchFileFromUrl(process.env.GSV_SHARE_URL, res, 'GSV');
});

app.get(['/api/soh', '/api/live-soh'], (req, res) => {
    fetchFileFromUrl(process.env.SOH_SHARE_URL, res, 'SOH');
});

app.listen(PORT, () => {
    console.log(`UNIBIC Kerala Sales Command Center listening on ${PORT}`);
});
