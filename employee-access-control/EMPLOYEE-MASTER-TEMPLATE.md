# Employee Master Upload Template — sample only

This is a header-only template. Add employee records locally before uploading through the future authenticated Admin Center. Never commit a filled employee master to GitHub.

Required columns:
- Employee_ID: unique company employee ID
- Employee_Name: employee's official name
- Designation: job title
- Role: ADMIN, REGIONAL_MANAGER, AREA_MANAGER, or SALES_EXECUTIVE
- Region: official Region name from dashboard source data
- Area: official Area name from dashboard source data
- Anchor_Zone: official Anchor Zone name from dashboard source data
- Status: ACTIVE or INACTIVE

Important:
- Do not use sample/fabricated Region, Area, or Anchor Zone values.
- Do not put passwords, OTPs, tokens, or other credentials in this file.
- Per-tab and per-report permissions are assigned separately in the Admin Center; they are not represented by one Allowed_Tabs field.
- DBR/customer-level scope is not required.
- This template is not an upload endpoint and is not connected to production.
