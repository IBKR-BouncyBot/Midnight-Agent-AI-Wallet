$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $projectRoot '.tools/compact/versions/0.31.1/x86_64-unknown-linux-musl'
$archive = Join-Path $target 'artifact.zip'
New-Item -ItemType Directory -Force $target | Out-Null
$url = 'https://github.com/midnightntwrk/compact/releases/download/compactc-v0.31.1/compactc_v0.31.1_x86_64-unknown-linux-musl.zip'
$expected = 'e291b4bab4d4e857707008f8b1c25c2b8e0c843f6c737d0ee6c0d9ac69a6bbfb'
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $url -OutFile $archive }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Compiler archive checksum mismatch. Do not execute it.'
}
$linuxTarget = '/mnt/' + $target.Substring(0,1).ToLowerInvariant() + $target.Substring(2).Replace('\','/')
& wsl -d Ubuntu-24.04 --cd $linuxTarget -- unzip -o artifact.zip
if ($LASTEXITCODE -ne 0) { throw 'Compiler extraction failed' }
& wsl -d Ubuntu-24.04 --cd $linuxTarget -- chmod +x compactc compactc.bin zkir zkir-v3
if ($LASTEXITCODE -ne 0) { throw 'Compiler permissions failed' }
& wsl -d Ubuntu-24.04 --cd $linuxTarget -- ./compactc --version
if ($LASTEXITCODE -ne 0) { throw 'Compiler verification failed' }

