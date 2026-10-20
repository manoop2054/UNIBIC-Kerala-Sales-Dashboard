# UNIBIC Employee Access Control (isolated setup)

Status: **Phase 1 schema and setup notes only — not live, not connected to Render, and not enforcing permissions yet.**

## Intended flow

1. Admin authenticates using a protected credential configured outside GitHub.
2. Admin uploads the Employee Master from their own computer.
3. The service validates the spreadsheet and upserts employee ID/name/status and permitted Region, Area and Anchor Zone.
4. Admin assigns permissions separately for sidebar tabs and each Report Center report, including view/filter/export/print.
5. Backend checks the authenticated employee, active status, resource permission and Region → Area → Anchor Zone scope on every protected API request.
6. Setting an employee to INACTIVE revokes that employee's sessions.

## Storage design

- Cloudflare D1: employee records, permissions, session hashes and audit log.
- Employee Master files must **not** be committed to GitHub, even in a private repository. The admin should upload the file through the authenticated Admin Panel.
- Secrets/passwords must be configured in the runtime secret store; never commit them in this repository.
- Do not use browser localStorage as the authority for access control.
- Do not rely on Render's temporary filesystem for employee records or permissions.

## Before activation

- Create a Cloudflare D1 database and apply `schema.sql`.
- Decide and configure the secure authentication mechanism and Admin identity using runtime secrets.
- Build and test the authenticated upload/admin API.
- Integrate the authorization check into Render APIs for GSV, SOH, chatbot, reports and exports.
- Add the Admin Panel without changing existing dashboard behavior.
- Test direct API calls, inactive users, expired/revoked sessions, export permissions, and geographic boundaries.
- Take fresh timestamped backups of production `server.js` and dashboard HTML before integration.
- Deploy only after tests pass; then verify the live deployment and confirm rollback instructions.

## Resource-key convention (proposal)

Use stable keys such as `tab.executive-dashboard`, `tab.report-center`,
`report-center.live-soh-cfa-wise`, and `report-center.indv-invoice-details`.
The final list must be reconciled with the actual sidebar and Report Center headings before enforcing permissions.

Geographic access scope is limited to Region → Area → Anchor Zone. DBR/customer-level permission is not required and must not be added.

## Important

This directory is preparatory code and documentation only. No current production API or dashboard UI has been changed by adding these files.
