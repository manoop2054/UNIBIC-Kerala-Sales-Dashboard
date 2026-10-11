const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));

// Helper to extract Google Drive File ID
function getDriveFileId(url) {
    if (!url) return null;
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

// Direct Download Link Generator with confirm=t for large files
function getDirectDownloadUrl(shareUrl) {
    const fileId = getDriveFileId(shareUrl);
    if (!fileId) return shareUrl;
    return `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
}

// Download Excel file handler
async function fetchExcelBuffer(shareUrl, label) {
    const downloadUrl = getDirectDownloadUrl(shareUrl);
    console.log(`${label} Direct Download URL: ${downloadUrl}`);
    
    const response = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
    });

    console.log(`${label} Response Status: ${response.status}, Content-Type: ${response.headers['content-type']}`);
    return response.data;
}

// API Routes for Excel files
app.get('/api/gsv', async (req, res) => {
    try {
        const data = await fetchExcelBuffer(process.env.GSV_SHARE_URL, 'GSV');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(data);
    } catch (error) {
        console.error('GSV Load Error:', error.message);
        res.status(500).send('Error loading GSV file');
    }
});

app.get('/api/soh', async (req, res) => {
    try {
        const data = await fetchExcelBuffer(process.env.SOH_SHARE_URL, 'SOH');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(data);
    } catch (error) {
        console.error('SOH Load Error:', error.message);
        res.status(500).send('Error loading SOH file');
    }
});

app.listen(PORT, () => {
    console.log(`UNIBIC Kerala Sales Command Center listening on ${PORT}`);
});
