const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'UNIBIC_Kerala_Sales_Command_Center_FULL_FINAL.html'));
});

function getDriveFileId(url) {
    if (!url) return null;
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

function fetchDriveFile(fileId, res, label) {
    // Direct Google Drive download endpoint with force confirm
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

    const request = (url) => {
        https.get(url, (driveRes) => {
            // Handle HTTP redirects (301, 302, 303, 307)
            if ([301, 302, 303, 307].includes(driveRes.statusCode)) {
                if (driveRes.headers.location) {
                    return request(driveRes.headers.location);
                }
            }

            console.log(`${label} Response Status: ${driveRes.statusCode}, Content-Type: ${driveRes.headers['content-type']}`);
            
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${label}.xlsx"`);
            
            driveRes.pipe(res);
        }).on('error', (err) => {
            console.error(`${label} Error:`, err.message);
            res.status(500).send(`Error loading ${label} file`);
        });
    };

    request(downloadUrl);
}

function processRequest(shareUrl, res, label) {
    const fileId = getDriveFileId(shareUrl);
    if (!fileId) {
        res.status(400).send(`${label} URL is invalid`);
        return;
    }
    fetchDriveFile(fileId, res, label);
}

app.get(['/api/gsv', '/api/live-gsv'], (req, res) => {
    processRequest(process.env.GSV_SHARE_URL, res, 'GSV');
});

app.get(['/api/soh', '/api/live-soh'], (req, res) => {
    processRequest(process.env.SOH_SHARE_URL, res, 'SOH');
});

app.listen(PORT, () => {
    console.log(`UNIBIC Kerala Sales Command Center listening on ${PORT}`);
});
