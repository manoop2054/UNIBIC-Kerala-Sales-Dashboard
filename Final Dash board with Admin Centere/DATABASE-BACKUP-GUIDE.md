# PostgreSQL external backup — Windows

This guide creates a **private local dump** of the Employee Access Control PostgreSQL database. It does not upload database contents to GitHub.

## Before running
1. Download the GitHub repository ZIP onto the external hard disk, or copy this backup folder to the external disk.
2. Install PostgreSQL command-line tools on the Windows PC so `pg_dump.exe` and `pg_restore.exe` are available in PATH.
3. Open PowerShell in this backup folder. Use a trusted PC and an external disk with enough free space.
4. Make sure you have the correct production `DATABASE_URL` from Render's secure environment settings. Do not paste it into chat, GitHub, a document, or a screenshot.

## Run the backup
From PowerShell in this folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\backup-database.ps1
```

When prompted, enter the production `DATABASE_URL`; the prompt hides typed input. The script creates `Database-Backup\unibic-postgres-YYYY-MM-DD_HH-mm-ss.dump`, checks that `pg_restore --list` can read the dump, and writes a SHA256 checksum file.

**Keep `Database-Backup` off GitHub.** The dump may contain employee personal data, roles, permissions, audit records and other private business information. Store it only on a protected external disk; keep a second copy in a separate secure location.

## Important limitations
- The script must be run by you on your Windows computer; it is stored here but has not been executed against production from GitHub.
- A dump is verified as readable, not as successfully restored. A full disaster-recovery test requires restoring it into a separate empty/test database and checking the application before any production restore.
- Never run a restore over the live database unless you have explicitly confirmed the target database and accepted that restore can overwrite existing data.
