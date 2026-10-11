const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));

function getDriveFileId(url) {
    if (!url) return null;
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

function fetchExcel(shareUrl, res, label) {
    const fileId = getDriveFileId(shareUrl);
    if (!fileId) {
        res.status(400).send(`${label} URL is invalid`);
        return;
    }
    
    const downloadUrl = `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
    
    https.get(downloadUrl, (driveRes) => {
        // Handle Google Drive redirects
        if (driveRes.statusCode === 302 || driveRes.statusCode === 301) {
            https.get(driveRes.headers.location, (redirectRes) => {
                handleResponse(redirectRes, res, label);
            }).on('error', (err) => {
                console.error(`${label} Redirect Error:`, err.message);
                res.status(500).send(`Error loading ${label} file`);
            });
            return;
        }
        handleResponse(driveRes, res, label);
    }).on('error', (err) => {
        console.error(`${label} Error:`, err.message);
        res.status(500).send(`Error loading ${label} file`);
    });
}

function handleResponse(driveRes, res, label) {
    console.log(`${label} Response Status: ${driveRes.statusCode}, Content-Type: ${driveRes.headers['content-type']}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    driveRes.pipe(res);
}

app.get('/api/gsv', (req, res) => {
    fetchExcel(process.env.GSV_SHARE_URL, res, 'GSV');
});

app.get('/api/soh', (req, res) => {
    fetchExcel(process.env.SOH_SHARE_URL, res, 'SOH');
});

app.listen(PORT, () => {
    console.log(`UNIBIC Kerala Sales Command Center listening on ${PORT}`);
});
