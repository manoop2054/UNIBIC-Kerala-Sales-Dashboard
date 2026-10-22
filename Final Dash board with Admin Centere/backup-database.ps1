# Run this on a trusted Windows PC. It writes the dump beside this script.
# Never commit the resulting Database-Backup folder to public GitHub.
$ErrorActionPreference = 'Stop'

$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) {
  throw "pg_dump was not found. Install PostgreSQL command-line tools first, then reopen PowerShell."
}

$backupDir = Join-Path $PSScriptRoot "Database-Backup"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$dumpPath = Join-Path $backupDir "unibic-postgres-$stamp.dump"

$secureUrl = Read-Host "Enter production DATABASE_URL (input is hidden)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
try {
  $plainUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

try {
  if ([string]::IsNullOrWhiteSpace($plainUrl) -or $plainUrl -notmatch '^postgres(ql)?://') {
    throw "The value does not look like a PostgreSQL connection URL."
  }
  $env:DATABASE_URL = $plainUrl
  & $pgDump.Source --format=custom --no-owner --no-acl --file="$dumpPath" "$env:DATABASE_URL"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dumpPath) -or (Get-Item $dumpPath).Length -eq 0) {
    throw "pg_dump failed or produced an empty file. Do not treat this backup as complete."
  }

  $listOutput = & (Join-Path (Split-Path $pgDump.Source) "pg_restore.exe") --list "$dumpPath" 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "pg_restore could not read the dump. Do not treat this backup as verified."
  }
  $hash = Get-FileHash -Algorithm SHA256 -Path $dumpPath
  "$($hash.Hash)  $(Split-Path $dumpPath -Leaf)" | Set-Content -Encoding ascii "$dumpPath.sha256"
  Write-Host ""
  Write-Host "DATABASE DUMP CREATED AND READ-CHECK PASSED" -ForegroundColor Green
  Write-Host "Dump: $dumpPath"
  Write-Host "SHA256: $($hash.Hash)"
  Write-Host "Copy the entire Database-Backup folder to a second external drive."
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  $plainUrl = $null
  $secureUrl = $null
}
