UNIBIC Kerala Sales Command Center — Render starter

IMPORTANT: This is a cloud-adaptation draft, not a verified live deployment. The HTML file is copied unchanged from the existing FULL_FINAL dashboard. The backend uses environment variables for SharePoint URLs so private/company links are not stored in GitHub.

Files:
- server.js
- package.json
- UNIBIC_Kerala_Sales_Command_Center_FULL_FINAL.html

Before deploying:
1. Keep this repository PRIVATE. Never upload the original Excel workbooks or SharePoint links.
2. In Render, set environment variables:
   GSV_SHARE_URL = share link for KL LIVE GSV LINK-MANOOB.xlsx
   SOH_SHARE_URL = share link for LIVE STOCK...xlsb
   GSV_SHEET = ACX_Sales_Register
   SOH_SHEET = LIVE STOCK REPORT
   REFRESH_KEY = a long random secret (optional; protects manual refresh endpoint)
3. Verify each SharePoint link can download the Excel file directly without an interactive sign-in. If the server receives an HTML login/share page instead, this simple link-based method will not work; authenticated Microsoft Graph/SharePoint access will be needed.
4. Do not assume Render Free can handle this workbook. GSV is ~146 MB and 119,408 rows; workbook parsing and JSON-in-memory may exceed free-tier RAM/time limits. Test with actual files before relying on it for sales operations. A paid instance or a preprocessed data store may be necessary.
5. The LIVE SOH sheet's exact header names for warehouse/type should be verified against the workbook. The code expects WAREHOUSE and TYPE (with a few aliases), and the dashboard expects fields including ITEMID, DESCRIPTION, TOTAL_MAIN_QRT, UNITS, TOTALQTYINUNITS, QUARANTINEUNITS, EXPIRY_DATE, SHELFLIFE, REMAININGSHELFLIFE.

Endpoints:
- /api/gsv
- /api/gsv/summary
- /api/live-soh
- /health
- /refresh-data?key=YOUR_REFRESH_KEY (only protected if REFRESH_KEY is set)
