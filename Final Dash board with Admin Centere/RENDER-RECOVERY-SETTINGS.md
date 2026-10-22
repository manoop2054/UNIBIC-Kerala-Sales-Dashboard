# Render + Neon Recovery Record (non-secret)

Captured: 2026-10-22

## Production Render web service
- Service name: `UNIBIC-Kerala-Sales-Dashboard`
- Service ID: `srv-db5hvrlckfvc73a9kllg`
- Workspace ID: `tea-db5g2q59fdbs73coh380`
- URL: https://unibic-kerala-sales-dashboard.onrender.com
- Repository: https://github.com/manoop2054/UNIBIC-Kerala-Sales-Dashboard
- Deploy branch: `main`
- Runtime: Node
- Root directory: repository root
- Build command: `npm install`
- Start command: `npm start`
- Region: Oregon
- Plan: Free
- Auto deploy: enabled on commit
- Health-check path: not configured
- Production code commit before backup-folder changes: `22dbb3464faa1c170dee25e3e333e381a4d0754a`
- Current backup-folder commit: `4c6a5d6a57b8f7a507c34bfd97b0a03e4ef4aee3`

## Neon PostgreSQL backup marker
- Project name: `unibic-employee-access`
- Project ID: `spring-hall-67770831`
- Primary/default branch: `production`
- Branch ID: `br-noisy-grass-ar73yjr9`
- Manual snapshot created: `UNIBIC full dashboard backup 2026-10-22`
- Snapshot ID: `snap-lucky-darkness-aruk3eep`
- Snapshot creation time: `2026-10-22T02:13:57Z`
- Note: This is a Neon-managed cloud snapshot, not a database dump saved to the external hard disk. The project had no manual snapshots listed before this snapshot, and no automatic snapshot schedule was configured when checked.

## Must be stored separately and securely
Do not add secret values to this public repository. Keep a secure offline copy of:
- Render environment variable names and their secret values, especially `DATABASE_URL`
- Any passwords, API keys, tokens or external service credentials
- A downloadable PostgreSQL export/dump if an external-disk copy is required
- Business Excel/XLSB/CSV source files used by the dashboard

## Recovery warning
The source-code backup plus Neon snapshot materially improves recovery, but an external database dump and secure secret/configuration record are still needed before the backup can be called a complete, independently restorable A-to-Z backup.
