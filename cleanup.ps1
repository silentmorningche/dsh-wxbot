<#
  One-shot cleanup for dsh-wxbot.

  DRY RUN BY DEFAULT: prints what it would remove and stops. Pass -Apply to delete.

  ---------------------------------------------------------------------------------------------
  WHY THIS FILE IS ASCII-ONLY
  The first version was UTF-8 without a BOM, with Chinese comments and messages. This machine runs
  Windows PowerShell 5.1, which decodes a BOM-less script as ANSI: the Chinese bytes were mangled,
  a string terminator was destroyed, and the script died with "string is missing the terminator"
  before executing a single statement. Keeping the script ASCII makes its parsing independent of
  both the console code page and the host's default encoding. The Chinese explanation lives in the
  chat and in README.md, not in here.
  ---------------------------------------------------------------------------------------------

  Two unrelated groups of leftovers:

  1) Abandoned DSH sessions. They were created while the plugin's session id and creation metadata
     were still being worked out. They are inert, but they occupy space and show up in the GUI's
     "ungrouped" bucket.

  2) Scaffolding inside this package: retired tombstones and scratch files.

  Deliberately NOT touched: .state/ (credentials and runtime state) and .acl-recovery/ (the file
  permission diagnostic report, which is useful evidence if this session is sent as feedback).
#>
[CmdletBinding()]
param(
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$sessionRoot = 'C:\Users\<user>\.dsh\sessions'
$packageDir = $PSScriptRoot

# --- 1. abandoned sessions ----------------------------------------------------------------------
# Only `weixin*` directories that do NOT contain `v2`. The live conversation is named
# `weixin~003Av2~003A...`; that `v2` segment came from a deliberate migration, so this filter is
# the guard that protects it. Do not rewrite this condition.
$sessions = @()
if (Test-Path -LiteralPath $sessionRoot) {
  $sessions = @(
    Get-ChildItem -LiteralPath $sessionRoot -Recurse -Directory |
      Where-Object { $_.Name -like 'weixin*' -and $_.Name -notlike 'weixin*v2*' }
  )
}

# --- 2. retired files inside the package --------------------------------------------------------
$relativeFiles = @(
  'src/store.js',                 # retired: ilink-client.js already owns persistence
  'src/redact.js',                # retired: ilink-client.js already owns redaction
  'verify/load-probe.js',         # the probe that crashed a live profile; tombstone only
  'docs/_scan_part1.py',          # scratch
  'docs/SYNTAX-AUDIT-part1.md',   # scratch review notes
  'docs/SYNTAX-AUDIT-part3.md',
  'docs/SYNTAX-AUDIT-part4.md',
  'check.mjs',                    # temporary self-check scripts (no longer needed)
  'check.cmd',
  'check-profile.mjs',
  'check-profile.cmd'
)

$files = @(
  $relativeFiles |
    ForEach-Object { Join-Path $packageDir $_ } |
    Where-Object { Test-Path -LiteralPath $_ }
)

Write-Output ("=== abandoned sessions: {0} ===" -f $sessions.Count)
if ($sessions.Count -eq 0) { Write-Output '  (none)' }
$sessions | ForEach-Object { Write-Output ('  ' + $_.FullName) }

Write-Output ''
Write-Output ("=== retired package files: {0} ===" -f $files.Count)
if ($files.Count -eq 0) { Write-Output '  (none)' }
$files | ForEach-Object { Write-Output ('  ' + $_) }

if (-not $Apply) {
  Write-Output ''
  Write-Output 'DRY RUN - nothing was removed. Re-run with -Apply to delete the items listed above:'
  Write-Output ("  & '{0}' -Apply" -f $PSCommandPath)
  exit 0
}

foreach ($dir in $sessions) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force }
foreach ($file in $files) { Remove-Item -LiteralPath $file -Force }

Write-Output ''
Write-Output ("REMOVED {0} session directories and {1} files." -f $sessions.Count, $files.Count)
