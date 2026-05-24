param(
  [string]$Namespace = "n8n-openai-gateway",
  [string]$ConfigMapName = "n8n-openai-cli-gateway-config",
  [string]$DeploymentName = "n8n-openai-cli-gateway",
  [string]$SecretName = "n8n-openai-cli-gateway-groq",
  [string]$GroqApiKey = "",
  [switch]$OverwriteSecret
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$groqProviderBlock = @"
  - id: groq-api
    type: cli
    description: Groq API via curl using Groq production chat models
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
    responseCommand:
      executable: sh
      args:
        - -lc
        - |
          REQUEST_JSON="$(cat)"
          HAS_TOOLS="$(
            printf "%s" "$REQUEST_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const req=JSON.parse(d);const tools=Array.isArray(req.tools)?req.tools:[];process.stdout.write(tools.length>0?"1":"0");}catch{process.stdout.write("0");}});'
          )"
          if [ "$HAS_TOOLS" = "1" ]; then
            echo "Groq CLI provider does not reliably support gateway-managed tool turns. Retry with fallback." >&2
            exit 86
          fi
          PAYLOAD="$(
            printf "%s" "$REQUEST_JSON" | node -e 'let d="";const maxChars=Number(process.env.GROQ_MAX_PROMPT_CHARS||120000);process.stdin.on("data",c=>d+=c).on("end",()=>{const norm=v=>typeof v==="string"?v:JSON.stringify(v??"");try{const req=JSON.parse(d);const rawMsgs=Array.isArray(req.messages)?req.messages:[];const allowedRoles=new Set(["system","user","assistant","tool"]);const msgs=rawMsgs.map(m=>{const role=allowedRoles.has(String(m&&m.role||""))?String(m.role):"user";const content=norm(m&&Object.prototype.hasOwnProperty.call(m,"content")?m.content:"").trim();if(!content)return null;const out={role,content};if(role==="tool"&&m&&typeof m==="object"&&typeof m.tool_call_id==="string"&&m.tool_call_id){out.tool_call_id=m.tool_call_id;}if(role==="assistant"&&m&&typeof m==="object"&&Array.isArray(m.tool_calls)&&m.tool_calls.length>0){out.tool_calls=m.tool_calls;}return out;}).filter(Boolean);let total=0;const kept=[];for(let i=msgs.length-1;i>=0;i--){const msg=msgs[i];const cost=msg.content.length+msg.role.length+32;if(kept.length>0&&total+cost>maxChars) continue;kept.unshift(msg);total+=cost;}const firstSystem=msgs.find(m=>m.role==="system");if(firstSystem&&!kept.some(m=>m.role==="system")&&(total+firstSystem.content.length+32)<=maxChars){kept.unshift(firstSystem);total+=firstSystem.content.length+32;}if(kept.length===0){const fallback=(typeof req.prompt==="string"?req.prompt:norm(req.prompt)).trim();kept.push({role:"user",content:fallback.slice(-maxChars)||"Hello"});}process.stdout.write(JSON.stringify({model:"{{provider_model}}",messages:kept,stream:false}));}catch{process.stdout.write(JSON.stringify({model:"{{provider_model}}",messages:[{role:"user",content:"Hello"}],stream:false}));}});'
          )"
          printf "%s" "$PAYLOAD" | curl -fsS https://api.groq.com/openai/v1/chat/completions \
            -H "Authorization: Bearer $GROQ_API_KEY" \
            -H "Content-Type: application/json" \
            --data-binary @- | \
            node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const out={output_text:"",tool_calls:[],finish_reason:"stop"};try{const res=JSON.parse(d);const choice=Array.isArray(res.choices)&&res.choices[0]&&typeof res.choices[0]==="object"?res.choices[0]:{};const msg=choice.message&&typeof choice.message==="object"?choice.message:{};const extractText=(content)=>{if(typeof content==="string") return content.trim();if(Array.isArray(content)){return content.map(part=>{if(typeof part==="string") return part;if(part&&typeof part==="object"){if(typeof part.text==="string") return part.text;if(typeof part.content==="string") return part.content;}return "";}).filter(Boolean).join("\n").trim();}if(content&&typeof content==="object"){if(typeof content.text==="string") return content.text.trim();if(typeof content.content==="string") return content.content.trim();}return "";};const content=extractText(msg.content);const toolCalls=Array.isArray(msg.tool_calls)?msg.tool_calls.map((call,i)=>{if(!call||typeof call!=="object") return null;const fn=call.function&&typeof call.function==="object"?call.function:{};const name=typeof fn.name==="string"?fn.name.trim():"";if(!name) return null;const args=typeof fn.arguments==="string"?fn.arguments:JSON.stringify(fn.arguments??{});return {id:typeof call.id==="string"&&call.id?call.id:`call_${i+1}`,name,arguments:args};}).filter(Boolean):[];const finish=typeof choice.finish_reason==="string"&&choice.finish_reason?choice.finish_reason:(toolCalls.length>0?"tool_calls":"stop");out.output_text=content;out.tool_calls=toolCalls;out.finish_reason=finish;}catch(e){out.output_text=d.trim();}process.stdout.write(JSON.stringify(out));});'
      input: request_json_stdin
      output: json_contract
      timeoutMs: 120000
    auth:
      statusCommand:
        executable: sh
        args:
          - -lc
          - |
            test -n "${GROQ_API_KEY:-}" || { echo '{"ok":false,"error":"GROQ_API_KEY not set"}'; exit 1; }
            curl -fsS https://api.groq.com/openai/v1/models \
              -H "Authorization: Bearer $GROQ_API_KEY" >/dev/null
            echo '{"ok":true}'
        timeoutMs: 15000
"@

$providersYaml = kubectl get configmap $ConfigMapName -n $Namespace -o jsonpath='{.data.providers\.yaml}'
if (-not $providersYaml) {
  throw "providers.yaml was empty or could not be fetched from ConfigMap $ConfigMapName in namespace $Namespace"
}

$groqBlockPattern = '(?ms)^  - id: groq-api\r?\n.*?(?=^  - id: |\z)'
if ($providersYaml -match $groqBlockPattern) {
  $updatedProvidersYaml = [regex]::Replace($providersYaml, $groqBlockPattern, $groqProviderBlock + "`n")
  Write-Host "Replaced existing groq-api block."
} else {
  $updatedProvidersYaml = $providersYaml.TrimEnd("`r", "`n") + "`r`n`r`n" + $groqProviderBlock + "`r`n"
  Write-Host "Appended groq-api block."
}

$tmpFile = [System.IO.Path]::GetTempFileName()
$secretStageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("groq-secret-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $secretStageDir | Out-Null
try {
  Set-Content -LiteralPath $tmpFile -Value $updatedProvidersYaml -NoNewline

  kubectl create configmap $ConfigMapName `
    -n $Namespace `
    --from-file=providers.yaml=$tmpFile `
    --dry-run=client `
    -o yaml | kubectl apply -f -

  if ($GroqApiKey) {
    kubectl get secret $SecretName -n $Namespace *> $null
    $secretExists = $LASTEXITCODE -eq 0

    if ($secretExists) {
      $secretJson = kubectl get secret $SecretName -n $Namespace -o json
      $secret = $secretJson | ConvertFrom-Json
      $hasGroqKey = $false
      if ($null -ne $secret.data) {
        $hasGroqKey = $secret.data.PSObject.Properties.Name -contains "GROQ_API_KEY"
      }

      if ($hasGroqKey -and -not $OverwriteSecret) {
        Write-Host "Keeping existing GROQ_API_KEY in secret/$SecretName."
      } else {
        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($GroqApiKey))
        $patchFile = Join-Path $secretStageDir "groq-secret-patch.json"
        @{ data = @{ GROQ_API_KEY = $encoded } } | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $patchFile -NoNewline
        kubectl patch secret $SecretName -n $Namespace --type=merge --patch-file $patchFile
      }
    } else {
      $groqKeyFile = Join-Path $secretStageDir "GROQ_API_KEY"
      [System.IO.File]::WriteAllText($groqKeyFile, $GroqApiKey)
      kubectl create secret generic $SecretName `
        -n $Namespace `
        --from-file=GROQ_API_KEY=$groqKeyFile
    }

    kubectl set env deployment/$DeploymentName `
      -n $Namespace `
      --containers=gateway `
      --from=secret/$SecretName
  }

  kubectl rollout restart deployment/$DeploymentName -n $Namespace
  kubectl rollout status deployment/$DeploymentName -n $Namespace --timeout=180s
} finally {
  Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $secretStageDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Retest with:"
Write-Host "kubectl exec -n $Namespace deploy/$DeploymentName -- sh -lc 'curl -s http://localhost:8080/v1/chat/completions -H ""Content-Type: application/json"" -H ""x-api-key: `$N8N_API_KEY"" -d ""{`"model`":`"llama-3.3-70b-versatile`",`"messages`":[{`"role`":`"user`",`"content`":`"Reply with exactly hello`"}]}""'"
