param(
  [string]$InputPath = "kubernetes/rancher-install.yaml",
  [string]$OutputPath = "kubernetes/rancher-install-groq.yaml",
  [string]$GroqApiKey = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InputPath)) {
  throw "Input file not found: $InputPath"
}

$content = Get-Content -LiteralPath $InputPath -Raw

$groqEnvBlock = @"
            - name: GROQ_API_KEY
              valueFrom:
                secretKeyRef:
                  name: n8n-openai-cli-gateway-secrets
                  key: groqApiKey
                  optional: true
"@

$groqProviderBlock = @"
      - id: groq-api
        type: openai
        description: Groq API - auto-discovers chat-usable models at startup
        baseUrl: https://api.groq.com/openai/v1
        apiKeyEnv: GROQ_API_KEY
        timeoutMs: 60000
        discovery:
          enabled: true
        models:
          - id: groq/compound
            providerModel: groq/compound
            fallbackModels:
              - gpt-5.4
              - kimi-for-coding
              - openai/gpt-oss-20b
          - id: groq/compound-mini
            providerModel: groq/compound-mini
            fallbackModels:
              - gpt-5.4
              - kimi-for-coding
              - openai/gpt-oss-20b
          - id: openai/gpt-oss-120b
            providerModel: openai/gpt-oss-120b
            fallbackModels:
              - gpt-5.4
              - kimi-for-coding
              - openai/gpt-oss-20b
          - id: openai/gpt-oss-20b
            providerModel: openai/gpt-oss-20b
            fallbackModels:
              - gpt-5.4
              - kimi-for-coding
              - llama-3.1-8b-instant
          - id: llama-3.3-70b-versatile
            providerModel: llama-3.3-70b-versatile
            fallbackModels:
              - gpt-5.4
              - kimi-for-coding
          - id: llama-3.1-8b-instant
            providerModel: llama-3.1-8b-instant
"@

if ($content -notmatch '(?m)^\s*- name:\s*GROQ_API_KEY\s*$') {
  $content = [regex]::Replace(
    $content,
    '(?ms)^(\s*- name:\s*ADMIN_API_KEY\s*\r?\n\s*valueFrom:\s*\r?\n\s*secretKeyRef:\s*\r?\n\s*name:\s*n8n-openai-cli-gateway-secrets\s*\r?\n\s*key:\s*adminApiKey\s*)$',
    "`$1`r`n$groqEnvBlock",
    1
  )
}

if ($content -notmatch '(?m)^\s*- id:\s*groq-api\s*$') {
  $content = [regex]::Replace(
    $content,
    '(?m)^(\s*- id:\s*deepseek-api\s*)$',
    "$groqProviderBlock`r`n`$1",
    1
  )
}

if ($content -notmatch '(?m)^\s*- name:\s*GROQ_API_KEY\s*$') {
  throw "Failed to add GROQ_API_KEY env entry."
}
if ($content -notmatch '(?m)^\s*- id:\s*groq-api\s*$') {
  throw "Failed to add Groq provider block before deepseek-api."
}

Set-Content -LiteralPath $OutputPath -Value $content -NoNewline
Write-Host "Wrote merged Groq Rancher manifest to $OutputPath"
if ($GroqApiKey) {
  Write-Host "Did not write the Groq API key into YAML. Add it safely with scripts/ensure-gateway-secrets.ps1."
}
