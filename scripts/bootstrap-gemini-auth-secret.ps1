param(
  [string]$Namespace = "n8n-openai-gateway",
  [string]$DeploymentName = "n8n-openai-cli-gateway",
  [string]$ContainerName = "gateway",
  [string]$SecretName = "n8n-openai-cli-gateway-gemini-auth",
  [string]$PodName = "",
  [string]$SourceDir = "",
  [string]$GeminiHome = "/var/lib/gateway-home/.gemini",
  [switch]$Overwrite
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $Overwrite) {
  kubectl get secret $SecretName -n $Namespace *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Secret $SecretName already exists in namespace $Namespace. Nothing changed."
    Write-Host "Pass -Overwrite only when you intentionally want to refresh the stored Gemini auth Secret."
    exit 0
  }
}

$files = @(
  "oauth_creds.json",
  "google_accounts.json",
  "installation_id",
  "settings.json",
  "state.json",
  "trustedFolders.json",
  "projects.json"
)

$stageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("gemini-auth-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stageDir | Out-Null

try {
  if ($SourceDir) {
    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
      throw "Source directory not found: $SourceDir"
    }

    foreach ($file in $files) {
      $sourceFile = Join-Path $SourceDir $file
      if (Test-Path -LiteralPath $sourceFile -PathType Leaf) {
        Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $stageDir $file)
      }
    }
  }
  else {
    if (-not $PodName) {
      $PodName = kubectl get pods -n $Namespace -l "app=$DeploymentName" -o jsonpath='{.items[0].metadata.name}'
    }

    if (-not $PodName) {
      throw "Unable to find a pod for deployment $DeploymentName in namespace $Namespace."
    }

    foreach ($file in $files) {
      $remoteFile = "$GeminiHome/$file"
      $exists = kubectl exec -n $Namespace $PodName -c $ContainerName -- sh -lc "test -f '$remoteFile' && echo yes || true"
      if ($exists -match "yes") {
        $content = kubectl exec -n $Namespace $PodName -c $ContainerName -- sh -lc "cat '$remoteFile'"
        $destination = Join-Path $stageDir $file
        [System.IO.File]::WriteAllText($destination, [string]::Join("`n", $content))
      }
    }
  }

  $oauthFile = Join-Path $stageDir "oauth_creds.json"
  if (-not (Test-Path -LiteralPath $oauthFile -PathType Leaf)) {
    throw "oauth_creds.json was not found in the selected source. Nothing was written."
  }

  $secretArgs = @("create", "secret", "generic", $SecretName, "-n", $Namespace)
  foreach ($file in Get-ChildItem -LiteralPath $stageDir -File) {
    $secretArgs += "--from-file=$($file.Name)=$($file.FullName)"
  }
  & kubectl @secretArgs

  Write-Host "Created secret $SecretName in namespace $Namespace."
  Write-Host "Restart the deployment to reseed an empty PVC:"
  Write-Host "kubectl rollout restart deployment/$DeploymentName -n $Namespace"
}
finally {
  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }
}
