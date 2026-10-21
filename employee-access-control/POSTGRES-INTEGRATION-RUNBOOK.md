# Employee Access Control — PostgreSQL integration runbook

## Current state
This branch is isolated from main. The PostgreSQL schema, Super Admin policy helper, Employee Master row validator, and Node test workflow are preparatory. The validator forces employee ID `P2PUF7638` to `SUPER_ADMIN`/`ACTIVE` only when the authenticated actor is that same Super Admin, rejects ordinary Admin attempts to import an `ADMIN` role, detects duplicate IDs and invalid required fields, and treats `All Access` as a label rather than a permission grant. The PostgreSQL schema now also includes database triggers that block deletion/demotion/disablement of `P2PUF7638` and prevent per-resource permission mutations for that identity. Static regression tests check these protections; they do not replace executing the schema against a real PostgreSQL instance.

The feature branch now includes database-backed login/session APIs, Employee Master create/update and JSON/file import APIs, audited password reset and granular permission-update APIs, a one-off CLI bootstrap script, dashboard session-guard middleware for GSV/SOH/chat routes, and a session-protected Target/Claims shared-upload proxy. The branch also contains dashboard login wiring, but no end-to-end login has been verified against a real PostgreSQL database. These are feature-branch code only: production `main` does not mount this access-control server implementation. Geographic filtering depends on the source rows containing trusted Region/Area/Anchor Zone fields; the SOH CFA/Warehouse mapping is not yet verified. Export/print action enforcement and complete endpoint-by-endpoint authorization still require review and tests. Do not merge or deploy this branch until the checklist below is complete.

Run the branch tests with `npm test`. A GitHub Actions workflow has been added to run the tests on changes to the access-control files; confirm its actual run result in the Actions tab before claiming tests pass.

## Database
Use a persistent PostgreSQL database. The server expects a standard DATABASE_URL connection string when the PostgreSQL adapter is integrated. Keep credentials in the hosting provider's environment-secret settings, never in GitHub files, screenshots, the employee spreadsheet, or browser storage.

Apply `employee-access-control/postgres-schema.sql` to a dedicated PostgreSQL database after review. It creates:
- employee identity/status/password hash records
- independent View / Filter / Export / Print permissions per resource
- independent Region → Area → Anchor Zone scope rows per resource
- hashed session identifiers, expiry and revocation fields
- an access audit log
- database-level protection triggers for the permanent Super Admin identity

The schema's protection triggers are defense-in-depth; they do not authenticate a caller or replace authorization and audit checks in application APIs. The protected identity must be seeded/updated only through a controlled, authenticated bootstrap procedure with employee ID `P2PUF7638`, role `SUPER_ADMIN`, and status `ACTIVE`. Do not create a public setup endpoint.

Do not apply the older `schema.sql` to PostgreSQL; it is a Cloudflare D1/SQLite-style schema.

## Required secrets and runtime settings
- DATABASE_URL: private connection string for the persistent PostgreSQL database.
- SUPER_ADMIN_INITIAL_PASSWORD: temporary strong password set only in a trusted one-off shell when running `npm run access-control:bootstrap`; never set it as a permanent public app setting or commit it.
- NODE_ENV=production: enables Secure cookies when HTTPS is used.

The bootstrap is a CLI command, not an HTTP endpoint. It only inserts `P2PUF7638` if the record does not already exist, sets role `SUPER_ADMIN` and status `ACTIVE`, and writes an audit event. After the one-time command succeeds, remove `SUPER_ADMIN_INITIAL_PASSWORD` from the shell/service environment. Never use an employee ID as a password.

## Activation gates — all are mandatory
1. Add the PostgreSQL driver and connection pool without changing the dashboard's existing data-loading logic.
2. Run the dashboard login flow against the real PostgreSQL database; verify HttpOnly, SameSite=Strict, HTTPS-only cookies in production and verify logout/session revocation, expiry, and inactive-account rejection.
3. Review and test the Employee Master create/update and JSON import APIs. The JSON import route accepts pre-parsed rows; the file route parses XLSX/CSV directly with a 5 MB request limit. Both validate headers/duplicates/statuses, write accepted rows in one transaction, and write audit records. The permission-update API supports independent View/Filter/Export/Print flags and Region/Area/Anchor Zone scopes; verify it with integration tests. Do not treat the `Allowed_Tabs` column as a complete permission model. Password reset revokes the target employee's active sessions.
4. Reconcile every sidebar tab and every Report Center report key against the actual dashboard HTML.
5. Audit every protected GSV, SOH, target, claims, chatbot, report, and export endpoint individually. The branch currently attaches session guards to GSV/SOH/chat routes and protects Target/Claims reads through a session/permission-checked proxy; verify each path with direct API tests. Report/export/print actions must enforce their own permissions server-side; hiding UI controls is not authorization.
6. Verify row filtering using trusted Region, Area, and Anchor Zone values on the server. Test region-wide, area-wide, and exact-zone assignments against real source rows. The current row matcher fails closed when Region is missing; validate the source headers and prove no out-of-scope rows are returned. Do not trust geography values supplied by the browser. SOH CFA/Warehouse-to-geography mapping remains a blocker until a trusted mapping is supplied and tested.
7. Ensure an INACTIVE employee is rejected on every request and all sessions are revoked in the same database transaction as the status change.
8. Add integration tests for active/inactive users, missing permissions, cross-resource leakage, mismatched geography, export/print restrictions, expiry, logout/revocation, malformed uploads, and direct API requests.
9. Take and verify fresh timestamped backups of production server.js and UNIBIC_Kerala_Sales_Command_Center_FINAL_PATCHED.html.
10. Deploy to a staging service first, run the full test checklist, and only then consider production activation.

## Rollback
Do not merge the feature branch until database connectivity, tests, and endpoint-by-endpoint enforcement have been verified. If a later production deployment fails, roll back the application commit to the verified prior version. Do not delete the database as a rollback step.

## Privacy and operational limits
- Do not upload real employee data to GitHub.
- Do not add DBR/customer-level access restrictions; the requested geographic scope is Region → Area → Anchor Zone.
- Do not claim access control is live until the Render server and all protected routes have been verified.
