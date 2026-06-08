<#
Helper script to set ExecutionPolicy for CurrentUser and optionally run `npm i`.
Usage:
  powershell -ExecutionPolicy Bypass -File .\scripts\fix-npm-executionpolicy.ps1 -RunNpm
Or run without `-RunNpm` to only set the policy.
#>
param(
    [switch]$RunNpm
)

Write-Host "Setting ExecutionPolicy for CurrentUser to RemoteSigned..."
try {
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force -ErrorAction Stop
    Write-Host "ExecutionPolicy set to RemoteSigned for CurrentUser."
} catch {
    Write-Host "Failed to set ExecutionPolicy: $_"
    exit 1
}

if ($RunNpm) {
    Write-Host "Running npm install (npm i)..."
    npm i
} else {
    Write-Host "To run npm install with this script, call:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\fix-npm-executionpolicy.ps1 -RunNpm"
}
