param(
  [string]$Namespace = "n8n-openai-gateway",
  [string]$SecretName = "n8n-openai-cli-gateway-secrets",
  [string]$N8nApiKey = $env:N8N_API_KEY,
  [string]$AdminApiKey = $env:ADMIN_API_KEY,
  [string]$GroqApiKey = $env:GROQ_API_KEY,
  [string]$OpenRouterApiKey = $env:OPENROUTER_API_KEY,
  [string]$DeepSeekApiKey = $env:DEEPSEEK_API_KEY,
  [string]$MoonshotApiKey = $env:MOONSHOT_API_KEY,
  [string]$KimiCodeApiKey = $env:KIMI_CODE_API_KEY
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-GatewaySecretExists {
  & kubectl get secret $SecretName -n $Namespace *> $null
  return $LASTEXITCODE -eq 0
}

function Get-ExistingSecretKeys {
  $keys = @{}
  $json = & kubectl get secret $SecretName -n $Namespace -o json
  $secret = $json | ConvertFrom-Json
  if ($null -ne $secret.data) {
    foreach ($property in $secret.data.PSObject.Properties) {
      $keys[$property.Name] = $true
    }
  }
  return $keys
}

function Require-Value {
  param(
    [string]$Key,
    [string]$Value
  )

  if ([string]::IsNullOrEmpty($Value)) {
    throw "$Key is missing from Secret $SecretName and no replacement value was provided."
  }
}

function New-SecretFile {
  param(
    [string]$Directory,
    [string]$Key,
    [string]$Value
  )

  $path = Join-Path $Directory $Key
  [System.IO.File]::WriteAllText($path, $Value)
  return $path
}

function Add-StagedValue {
  param(
    [hashtable]$Staged,
    [string]$Key,
    [string]$Value
  )

  $Staged[$Key] = $Value
}

$stageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("gateway-secrets-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stageDir | Out-Null

try {
  $desired = [ordered]@{
    n8nApiKey = $N8nApiKey
    adminApiKey = $AdminApiKey
    groqApiKey = $GroqApiKey
    openrouterApiKey = $OpenRouterApiKey
    deepseekApiKey = $DeepSeekApiKey
    moonshotApiKey = $MoonshotApiKey
    kimiApiKey = $KimiCodeApiKey
  }

  $staged = @{}

  if (-not (Test-GatewaySecretExists)) {
    Require-Value -Key "n8nApiKey" -Value $N8nApiKey
    Require-Value -Key "adminApiKey" -Value $AdminApiKey

    foreach ($entry in $desired.GetEnumerator()) {
      if (-not [string]::IsNullOrEmpty($entry.Value)) {
        Add-StagedValue -Staged $staged -Key $entry.Key -Value $entry.Value
      }
    }

    $createArgs = @("create", "secret", "generic", $SecretName, "-n", $Namespace)
    foreach ($entry in $staged.GetEnumerator()) {
      $file = New-SecretFile -Directory $stageDir -Key $entry.Key -Value $entry.Value
      $createArgs += "--from-file=$($entry.Key)=$file"
    }

    & kubectl @createArgs
    Write-Host "Created Secret $SecretName in namespace $Namespace."
    exit 0
  }

  $existingKeys = Get-ExistingSecretKeys

  foreach ($requiredKey in @("n8nApiKey", "adminApiKey")) {
    if ($existingKeys.ContainsKey($requiredKey)) {
      Write-Host "Keeping existing $requiredKey."
      continue
    }

    $value = [string]$desired[$requiredKey]
    Require-Value -Key $requiredKey -Value $value
    Add-StagedValue -Staged $staged -Key $requiredKey -Value $value
  }

  foreach ($optionalKey in @("groqApiKey", "openrouterApiKey", "deepseekApiKey", "moonshotApiKey", "kimiApiKey")) {
    if ($existingKeys.ContainsKey($optionalKey)) {
      Write-Host "Keeping existing $optionalKey."
      continue
    }

    $value = [string]$desired[$optionalKey]
    if (-not [string]::IsNullOrEmpty($value)) {
      Add-StagedValue -Staged $staged -Key $optionalKey -Value $value
    }
  }

  if ($staged.Count -eq 0) {
    Write-Host "Secret $SecretName already has all requested keys. Nothing changed."
    exit 0
  }

  $patchData = @{}
  foreach ($entry in $staged.GetEnumerator()) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($entry.Value)
    $patchData[$entry.Key] = [Convert]::ToBase64String($bytes)
  }

  $patchFile = Join-Path $stageDir "patch.json"
  @{ data = $patchData } | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $patchFile -NoNewline

  & kubectl patch secret $SecretName -n $Namespace --type=merge --patch-file $patchFile
  Write-Host "Patched only missing keys on Secret $SecretName in namespace $Namespace."
}
finally {
  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }
}
