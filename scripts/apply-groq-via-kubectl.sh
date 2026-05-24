#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="n8n-openai-gateway"
CONFIGMAP_NAME="n8n-openai-cli-gateway-config"
DEPLOYMENT_NAME="n8n-openai-cli-gateway"
SECRET_NAME="n8n-openai-cli-gateway-groq"
GROQ_API_KEY=""
OVERWRITE_SECRET="false"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/apply-groq-via-kubectl.sh --groq-api-key YOUR_KEY [--namespace n8n-openai-gateway]

What it does:
  1. Fetches the current providers.yaml from the gateway ConfigMap
  2. Appends the Groq provider block if it is not already present
  3. Applies the updated ConfigMap back to the cluster
  4. Creates the Groq secret, or fills GROQ_API_KEY only if it is missing
  5. Injects GROQ_API_KEY into the gateway deployment
  6. Restarts the deployment and waits for rollout

Existing secret values are preserved by default. Pass --overwrite-secret only
when you intentionally want to rotate GROQ_API_KEY.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --groq-api-key)
      GROQ_API_KEY="${2:-}"
      shift 2
      ;;
    --namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    --overwrite-secret)
      OVERWRITE_SECRET="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$GROQ_API_KEY" ]]; then
  echo "--groq-api-key is required." >&2
  usage >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
providers_file="$tmp_dir/providers.yaml"

echo "Fetching current providers config from namespace $NAMESPACE..."
kubectl get configmap "$CONFIGMAP_NAME" \
  -n "$NAMESPACE" \
  -o jsonpath='{.data.providers\.yaml}' > "$providers_file"

if ! grep -q '^  - id: groq-api$' "$providers_file"; then
  cat >> "$providers_file" <<'EOF'

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
      # Preview models from Groq docs. Uncomment if you want them exposed.
      # - id: meta-llama/llama-4-scout-17b-16e-instruct
      #   providerModel: meta-llama/llama-4-scout-17b-16e-instruct
      # - id: qwen/qwen3-32b
      #   providerModel: qwen/qwen3-32b
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
EOF
  echo "Appended Groq provider block to providers.yaml."
else
  echo "Groq provider block already present in providers.yaml."
fi

echo "Applying updated ConfigMap..."
kubectl create configmap "$CONFIGMAP_NAME" \
  -n "$NAMESPACE" \
  --from-file=providers.yaml="$providers_file" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

echo "Ensuring Groq secret without overwriting existing values..."
if kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
  existing_key="$(
    kubectl get secret "$SECRET_NAME" \
      -n "$NAMESPACE" \
      -o jsonpath='{.data.GROQ_API_KEY}' 2>/dev/null || true
  )"

  if [[ -n "$existing_key" && "$OVERWRITE_SECRET" != "true" ]]; then
    echo "Keeping existing GROQ_API_KEY in secret/$SECRET_NAME."
  else
    groq_patch_file="$tmp_dir/groq-secret-patch.json"
    groq_encoded="$(printf "%s" "$GROQ_API_KEY" | base64 | tr -d '\n')"
    printf '{"data":{"GROQ_API_KEY":"%s"}}' "$groq_encoded" > "$groq_patch_file"
    kubectl patch secret "$SECRET_NAME" -n "$NAMESPACE" --type=merge --patch-file "$groq_patch_file"
  fi
else
  groq_key_file="$tmp_dir/GROQ_API_KEY"
  printf "%s" "$GROQ_API_KEY" > "$groq_key_file"
  kubectl create secret generic "$SECRET_NAME" \
    -n "$NAMESPACE" \
    --from-file=GROQ_API_KEY="$groq_key_file"
fi

echo "Injecting GROQ_API_KEY into deployment..."
kubectl set env deployment/"$DEPLOYMENT_NAME" \
  -n "$NAMESPACE" \
  --containers=gateway \
  --from=secret/"$SECRET_NAME"

echo "Restarting deployment so the new ConfigMap is picked up..."
kubectl rollout restart deployment/"$DEPLOYMENT_NAME" -n "$NAMESPACE"
kubectl rollout status deployment/"$DEPLOYMENT_NAME" -n "$NAMESPACE" --timeout=180s

echo
echo "Groq has been applied. Check the exposed models with:"
echo "kubectl exec -n $NAMESPACE deploy/$DEPLOYMENT_NAME -- curl -s http://localhost:8080/v1/models -H 'x-api-key: YOUR_N8N_API_KEY'"
