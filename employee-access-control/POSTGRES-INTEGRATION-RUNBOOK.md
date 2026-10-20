# Employee Access Control — PostgreSQL integration runbook

## Current state
This branch is isolated from main. The PostgreSQL schema, Super Admin policy helper, Employee Master row validator, and Node test workflow are preparatory. The validator forces employee ID `P2PUF7638` to `SUPER_ADMIN`/`ACTIVE` only when the authenticated actor is that same Super Admin, rejects ordinary Admin attempts to import an `ADMIN` role, detects duplicate IDs and invalid required fields, and treats `All Access` as a label rather than a permission grant. The PostgreSQL schema now also includes database triggers that block deletion/demotion/disablement of `P2PUF7638` and prevent per-resource permission mutations for that identity. Static regression tests check these protections; they do not replace executing the schema against a real PostgreSQL instance.

The validator is not yet connected to a database-backed upload route. No login/session route, employee import API, endpoint enforcement, or Render setting is live. Do not merge or deploy this branch until the checklist below is complete.

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
- ACCESS_CONTROL_ADMIN_TOKEN: high-entropy bootstrap credential for the initial Admin login. Set only in the hosting provider's secret environment; do not commit it or send it in chat.
- NODE_ENV=production: enables secure-cookie behavior when HTTPS is used.

Use a unique generated admin token, keep it in a password manager, and rotate it after the initial Admin session has been established. Do not use the dashboard URL, an employee ID, or a human-chosen short password as the token.

## Activation gates — all are mandatory
1. Add the PostgreSQL driver and connection pool without changing the dashboard's existing data-loading logic.
2. Integrate login/session routes and verify HttpOnly, SameSite=Strict, HTTPS-only cookies in production.
3. Mount `employee-master-import-validation.js` behind the authenticated Admin API; the route must pass the actor ID from the verified server-side session, not from the request body. Implement the employee master import and permission-update APIs with database transactions and audit records. Validate file type, size, required headers, duplicate IDs, allowed statuses, and scope values. Never accept client-supplied permission claims as authoritative.
4. Reconcile every sidebar tab and every Report Center report key against the actual dashboard HTML.
5. Apply server-side authorization to every protected GSV, SOH, target, claims, chatbot, report, and export endpoint. A check that only hides UI controls is not authorization.
6. Filter returned rows using the resource's assigned Region, Area, and Anchor Zone on the server. Do not trust geography values supplied by the browser; derive them from trusted query/data context.
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
