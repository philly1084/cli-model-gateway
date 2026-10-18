[CmdletBinding()]
param(
    [string]$OutputDir = (Join-Path $env:USERPROFILE '.cli-model-gateway/agent-keys'),
    [switch]$Force,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use the .sh script on non-Windows systems.' }
Get-Command git -ErrorAction Stop | Out-Null
$outputPath = [IO.Path]::GetFullPath($OutputDir)
$probe = $outputPath
while (-not (Test-Path -LiteralPath $probe -PathType Container)) {
    $probe = Split-Path -Parent $probe
}
# Fail closed on junctions/symlinks, including ancestor junctions.
$ancestor = $probe
while ($ancestor) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Output path must not traverse a junction or symbolic link.'
    }
    $ancestor = Split-Path -Parent $ancestor
}
$previousErrorAction = $ErrorActionPreference
try {
    # Windows PowerShell treats redirected native stderr as PowerShell errors.
    $ErrorActionPreference = 'Continue'
    $inside = & git -C $probe rev-parse --is-inside-work-tree 2>$null
} finally {
    $ErrorActionPreference = $previousErrorAction
}
if ($inside -eq 'true') { throw 'Refusing output inside a git work tree' }
$files = @('age-key.txt', 'keys.sops.json', 'checker.sops.json')
foreach ($file in $files) {
    if ((Test-Path -LiteralPath (Join-Path $outputPath $file)) -and -not $Force) {
        throw 'Output exists; use -Force to replace the complete key set'
    }
}
if ($ValidateOnly) { Write-Output "Validated output directory: $outputPath"; exit 0 }
Get-Command sops, age-keygen -ErrorAction Stop | Out-Null
function Protect-Directory([string]$Path) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}
[IO.Directory]::CreateDirectory($outputPath) | Out-Null
Protect-Directory $outputPath
$scratch = Join-Path $outputPath ('.generate.' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
Protect-Directory $scratch
try {
    $identity = Join-Path $scratch 'age-key.txt'
    try {
        $ErrorActionPreference = 'Continue'
        & age-keygen -o $identity 2>$null
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($LASTEXITCODE -ne 0) { throw 'age-keygen failed' }
    $recipient = & age-keygen -y $identity
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read age recipient' }
    foreach ($name in @('keys', 'checker')) {
        $bytes = [byte[]]::new(32)
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $rng.GetBytes($bytes)
            $encoded = [Convert]::ToBase64String($bytes)
            $document = if ($name -eq 'keys') { @{ keys = @{ data = $encoded } } } else { @{ macKey = $encoded } }
            $plain = Join-Path $scratch "$name.json"
            [IO.File]::WriteAllText($plain, ($document | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
            & sops --encrypt --age $recipient --input-type json --output-type json --output (Join-Path $scratch "$name.sops.json") $plain
            if ($LASTEXITCODE -ne 0) { throw 'SOPS encryption failed' }
        } finally {
            $rng.Dispose()
            [Array]::Clear($bytes, 0, $bytes.Length)
            $encoded = $null
            $document = $null
            if ($plain -and (Test-Path -LiteralPath $plain)) { Remove-Item -LiteralPath $plain -Force }
        }
    }
    foreach ($file in $files) {
        $destination = Join-Path $outputPath $file
        if ($Force -and (Test-Path -LiteralPath $destination -PathType Leaf)) {
            [IO.File]::Delete($destination)
        }
        [IO.File]::Move((Join-Path $scratch $file), $destination)
    }
    Write-Output "Age public recipient: $recipient"
    foreach ($file in $files) { Write-Output (Join-Path $outputPath $file) }
    $quoted = $outputPath.Replace("'", "''")
    Write-Output "kubectl create secret generic cli-model-gateway-agent-keys --from-file=keys.sops.json='$quoted/keys.sops.json' --from-file=checker.sops.json='$quoted/checker.sops.json' --from-file=age-key.txt='$quoted/age-key.txt'"
} finally {
    # Delete only the known files in this script's private scratch directory.
    foreach ($file in @('keys.json', 'checker.json') + $files) {
        $target = Join-Path $scratch $file
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    }
    [IO.Directory]::Delete($scratch)
}
