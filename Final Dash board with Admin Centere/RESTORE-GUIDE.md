# Final Dash board with Admin Centere — Backup & Recovery

## Snapshot identity
- Repository: `manoop2054/UNIBIC-Kerala-Sales-Dashboard`
- Source branch: `main`
- Source commit: `22dbb3464faa1c170dee25e3e333e381a4d0754a`
- Production URL: https://unibic-kerala-sales-dashboard.onrender.com
- Production deployment observed live on 2026-10-22: `dep-dbcmuj8u01pc73bguppg`

## Included source snapshot
The `Source/` subfolder contains copies of the main dashboard HTML, `server.js`, `package.json`, `.gitignore`, and the Admin Center/access-control UI, routes, PostgreSQL adapter, authentication, employee admin service, import validation, resource catalog and schema. See `BACKUP-MANIFEST.json` for exact source paths, sizes and Git blob IDs.

## Restore source files after PC / hard-disk failure
1. On a replacement PC, install Git and a supported Node.js LTS version.
2. Download the repository ZIP from GitHub, or copy this entire folder to your external hard disk/pen drive.
3. Copy the files in `Source/` back to their original repository-relative paths, using `BACKUP-MANIFEST.json`.
4. Run `npm install` in the project root using `package.json`.
5. Restore the database from the separate database dump.
6. Configure required runtime environment variables from the separately stored secure record.
7. Test locally first. Do not deploy to production until the restored copy has been verified.

## IMPORTANT: this is not yet a complete A-to-Z disaster-recovery set
This folder snapshots source code. To complete recovery, separately export and securely store:

- **Neon/PostgreSQL database:** schema and data, including employee master, roles, permissions, geographic scopes and relevant audit history. Use a verified Neon backup/branch or `pg_dump` workflow and confirm the dump can be read/restored.
- **Render service settings:** service ID, repository/branch, build command, start command, health-check path and auto-deploy setting.
- **Secrets:** `DATABASE_URL`, passwords, API keys and tokens in an encrypted password manager or encrypted offline file. Never commit secret values to this public GitHub repository.
- **Business files:** source Excel/XLSB/CSV files used by the dashboard, copied to a separate secure disk.
- **Second copy:** download the repository ZIP or this folder to an external hard disk/pen drive and keep it separate from the computer.

## Security warning
This GitHub repository is public. Do not upload employee spreadsheets, database dumps, credentials, session tokens, `.env` files or confidential business data here.
