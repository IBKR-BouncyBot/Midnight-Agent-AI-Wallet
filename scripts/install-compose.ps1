$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $projectRoot '.tools/docker-compose'
New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
Invoke-WebRequest 'https://github.com/docker/compose/releases/download/v5.7.0/docker-compose-linux-x86_64' -OutFile $target
if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne '7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2') {
    throw 'Docker Compose checksum mismatch. Do not execute it.'
}
$linuxTarget = '/mnt/' + $target.Substring(0,1).ToLowerInvariant() + $target.Substring(2).Replace('\','/')
& wsl -d Ubuntu-24.04 -- chmod +x $linuxTarget
if ($LASTEXITCODE -ne 0) { throw 'Compose permissions failed' }
& wsl -d Ubuntu-24.04 -- $linuxTarget version
if ($LASTEXITCODE -ne 0) { throw 'Compose verification failed' }

