#!/usr/bin/env pwsh
# Updates the pre-built dotnetup executables in eng/dotnetup/ when source files change.
# Default: Builds current platform first (blocking), then other RIDs in background.
# Use -Rid <rid> to build only a specific RID.
# Use -All to build all RIDs sequentially (no background jobs).

param(
    [string]$Rid,
    [switch]$All,
    [switch]$Force,
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$DotnetupSrcDir = Join-Path $RepoRoot "src\Installer\dotnetup"
$LibrarySrcDir = Join-Path $RepoRoot "src\Installer\Microsoft.Dotnet.Installation"
$DotnetupProject = Join-Path $DotnetupSrcDir "dotnetup.csproj"
$OutputBaseDir = Join-Path $PSScriptRoot "dotnetup"

$AllRids = @("win-x64", "win-arm64", "linux-x64", "linux-arm64", "osx-x64", "osx-arm64")

# Determine current platform RID
function Get-CurrentRid {
    if ($env:OS -eq "Windows_NT") {
        $arch = $env:PROCESSOR_ARCHITECTURE
        return if ($arch -eq "ARM64") { "win-arm64" } else { "win-x64" }
    } elseif ($IsMacOS) {
        $arch = & uname -m
        return if ($arch -eq "arm64") { "osx-arm64" } else { "osx-x64" }
    } else {
        $arch = & uname -m
        return if ($arch -eq "aarch64") { "linux-arm64" } else { "linux-x64" }
    }
}

# Compute hash of source file metadata (fast - uses timestamps, not content)
function Get-SourceHash {
    $files = @()
    $files += Get-ChildItem -Path $DotnetupSrcDir -Recurse -File -Include "*.cs", "*.csproj", "*.resx" -ErrorAction SilentlyContinue
    $files += Get-ChildItem -Path $LibrarySrcDir -Recurse -File -Include "*.cs", "*.csproj" -ErrorAction SilentlyContinue
    
    if ($files.Count -eq 0) {
        return $null
    }
    
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hashInput = ($files | Sort-Object FullName | ForEach-Object { 
        "$($_.FullName):$($_.LastWriteTimeUtc.Ticks):$($_.Length)" 
    }) -join "|"
    
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($hashInput)
    $hash = $sha.ComputeHash($bytes)
    return [BitConverter]::ToString($hash) -replace '-', ''
}

# Build for a single RID
function Build-DotnetupForRid {
    param([string]$TargetRid)
    
    $outputDir = Join-Path $OutputBaseDir $TargetRid
    $hashFile = Join-Path $outputDir ".sourcehash"
    $exeName = if ($TargetRid -like "win-*") { "dotnetup.exe" } else { "dotnetup" }
    $exePath = Join-Path $outputDir $exeName
    
    $currentHash = Get-SourceHash
    $storedHash = if (Test-Path $hashFile) { Get-Content $hashFile -Raw } else { $null }
    
    $needsRebuild = $Force -or (-not (Test-Path $exePath)) -or ($currentHash -ne $storedHash)
    
    if (-not $needsRebuild) {
        if ($Verbose) {
            Write-Host "dotnetup ($TargetRid) is up to date."
        }
        return $true
    }
    
    if ($Verbose) {
        Write-Host "Building dotnetup for $TargetRid..."
    }
    
    # Ensure output directory exists
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
    
    # Build
    $publishArgs = @(
        "publish", $DotnetupProject,
        "-c", "Release",
        "-r", $TargetRid,
        "--self-contained",
        "-p:PublishSingleFile=true",
        "-p:IncludeNativeLibrariesForSelfExtract=true",
        "-o", $outputDir
    )
    
    if (-not $Verbose) {
        $publishArgs += "-v", "quiet", "--nologo"
    }
    
    & dotnet @publishArgs
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to build dotnetup for $TargetRid"
        return $false
    }
    
    # Store the hash
    $currentHash | Out-File -FilePath $hashFile -NoNewline
    
    if ($Verbose) {
        Write-Host "dotnetup ($TargetRid) built successfully."
    }
    return $true
}

# Check if dotnet is available - if not, we can't rebuild
$dotnetCmd = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnetCmd) {
    if ($Verbose) {
        Write-Host "dotnet SDK not available, using existing dotnetup executables."
    }
    exit 0
}

# Determine which RIDs to build
$currentRid = Get-CurrentRid
$ridsTouild = @()
if ($Rid) {
    # Explicit RID specified - build only that one
    $ridsTouild = @($Rid)
} elseif ($All) {
    # -All specified - build all RIDs sequentially (no background)
    $ridsTouild = $AllRids
} else {
    # Default: build current RID first, then others in background
    $ridsTouild = @($currentRid)
}

# Build for each target RID (current platform or explicit -Rid)
$allSucceeded = $true
foreach ($targetRid in $ridsTouild) {
    $result = Build-DotnetupForRid -TargetRid $targetRid
    if (-not $result) {
        $allSucceeded = $false
    }
}

# If default mode (no -Rid, no -All), spawn background jobs for other RIDs
if (-not $Rid -and -not $All) {
    $otherRids = $AllRids | Where-Object { $_ -ne $currentRid }
    foreach ($targetRid in $otherRids) {
        $scriptPath = $PSCommandPath
        $args = @("-Rid", $targetRid)
        if ($Force) { $args += "-Force" }
        if ($Verbose) { $args += "-Verbose" }
        
        if ($Verbose) {
            Write-Host "Starting background build for $targetRid..."
        }
        Start-Job -ScriptBlock {
            param($script, $arguments)
            & $script @arguments
        } -ArgumentList $scriptPath, $args | Out-Null
    }
}

if (-not $allSucceeded) {
    exit 1
}
