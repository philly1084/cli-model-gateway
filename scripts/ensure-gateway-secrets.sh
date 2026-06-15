#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="n8n-openai-gateway"
SECRET_NAME="n8n-openai-cli-gateway-secrets"
N8N_VALUE="${N8N_API_KEY:-}"
ADMIN_VALUE="${ADMIN_API_KEY:-}"
GROQ_VALUE="${GROQ_API_KEY:-}"
OPENROUTER_VALUE="${OPENROUTER_API_KEY:-}"
DEEPSEEK_VALUE="${DEEPSEEK_API_KEY:-}"
MOONSHOT_VALUE="${MOONSHOT_API_KEY:-}"
KIMI_CODE_VALUE="${KIMI_CODE_API_KEY:-}"

usage() {
  cat <<'EOF'
Usage:
  N8N_API_KEY=... ADMIN_API_KEY=... ./scripts/ensure-gateway-secrets.sh [options]

Options:
  --namespace NAME             Kubernetes namespace. Default: n8n-openai-gateway
  --secret-name NAME           Gateway Secret name. Default: n8n-openai-cli-gateway-secrets
  --n8n-api-key VALUE          Value for missing n8nApiKey
  --admin-api-key VALUE        Value for missing adminApiKey
  --groq-api-key VALUE         Value for missing groqApiKey
  --openrouter-api-key VALUE   Value for missing openrouterApiKey
  --deepseek-api-key VALUE     Value for missing deepseekApiKey
  --moonshot-api-key VALUE     Value for missing moonshotApiKey
  --kimi-code-api-key VALUE    Value for missing kimiApiKey
  --help                       Show this help

This helper never overwrites existing Secret keys. It creates the Secret when
missing, or patches only keys that are absent.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    --secret-name)
      SECRET_NAME="${2:-}"
      shift 2
      ;;
    --n8n-api-key)
      N8N_VALUE="${2:-}"
      shift 2
      ;;
    --admin-api-key)
      ADMIN_VALUE="${2:-}"
      shift 2
      ;;
    --groq-api-key)
      GROQ_VALUE="${2:-}"
      shift 2
      ;;
    --openrouter-api-key)
      OPENROUTER_VALUE="${2:-}"
      shift 2
      ;;
    --deepseek-api-key)
      DEEPSEEK_VALUE="${2:-}"
      shift 2
      ;;
    --moonshot-api-key)
      MOONSHOT_VALUE="${2:-}"
      shift 2
      ;;
    --kimi-code-api-key)
      KIMI_CODE_VALUE="${2:-}"
      shift 2
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

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

secret_exists() {
  kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" >/dev/null 2>&1
}

secret_has_key() {
  local key="$1"
  [[ -n "$(kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" -o "jsonpath={.data.$key}" 2>/dev/null || true)" ]]
}

stage_value() {
  local key="$1"
  local value="$2"
  local file="$tmp_dir/$key"
  printf "%s" "$value" > "$file"
  STAGED_KEYS+=("$key")
  STAGED_FILES+=("$file")
}

require_value() {
  local key="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "$key is missing from Secret $SECRET_NAME and no replacement value was provided." >&2
    exit 1
  fi
}

declare -a STAGED_KEYS=()
declare -a STAGED_FILES=()

if ! secret_exists; then
  require_value "n8nApiKey" "$N8N_VALUE"
  require_value "adminApiKey" "$ADMIN_VALUE"

  stage_value "n8nApiKey" "$N8N_VALUE"
  stage_value "adminApiKey" "$ADMIN_VALUE"
  [[ -n "$GROQ_VALUE" ]] && stage_value "groqApiKey" "$GROQ_VALUE"
  [[ -n "$OPENROUTER_VALUE" ]] && stage_value "openrouterApiKey" "$OPENROUTER_VALUE"
  [[ -n "$DEEPSEEK_VALUE" ]] && stage_value "deepseekApiKey" "$DEEPSEEK_VALUE"
  [[ -n "$MOONSHOT_VALUE" ]] && stage_value "moonshotApiKey" "$MOONSHOT_VALUE"
  [[ -n "$KIMI_CODE_VALUE" ]] && stage_value "kimiApiKey" "$KIMI_CODE_VALUE"

  create_args=()
  for i in "${!STAGED_KEYS[@]}"; do
    create_args+=("--from-file=${STAGED_KEYS[$i]}=${STAGED_FILES[$i]}")
  done

  kubectl create secret generic "$SECRET_NAME" -n "$NAMESPACE" "${create_args[@]}"
  echo "Created Secret $SECRET_NAME in namespace $NAMESPACE."
  exit 0
fi

if secret_has_key "n8nApiKey"; then
  echo "Keeping existing n8nApiKey."
else
  require_value "n8nApiKey" "$N8N_VALUE"
  stage_value "n8nApiKey" "$N8N_VALUE"
fi

if secret_has_key "adminApiKey"; then
  echo "Keeping existing adminApiKey."
else
  require_value "adminApiKey" "$ADMIN_VALUE"
  stage_value "adminApiKey" "$ADMIN_VALUE"
fi

if secret_has_key "groqApiKey"; then
  echo "Keeping existing groqApiKey."
elif [[ -n "$GROQ_VALUE" ]]; then
  stage_value "groqApiKey" "$GROQ_VALUE"
fi

if secret_has_key "openrouterApiKey"; then
  echo "Keeping existing openrouterApiKey."
elif [[ -n "$OPENROUTER_VALUE" ]]; then
  stage_value "openrouterApiKey" "$OPENROUTER_VALUE"
fi

if secret_has_key "deepseekApiKey"; then
  echo "Keeping existing deepseekApiKey."
elif [[ -n "$DEEPSEEK_VALUE" ]]; then
  stage_value "deepseekApiKey" "$DEEPSEEK_VALUE"
fi

if secret_has_key "moonshotApiKey"; then
  echo "Keeping existing moonshotApiKey."
elif [[ -n "$MOONSHOT_VALUE" ]]; then
  stage_value "moonshotApiKey" "$MOONSHOT_VALUE"
fi

if secret_has_key "kimiApiKey"; then
  echo "Keeping existing kimiApiKey."
elif [[ -n "$KIMI_CODE_VALUE" ]]; then
  stage_value "kimiApiKey" "$KIMI_CODE_VALUE"
fi

if [[ "${#STAGED_KEYS[@]}" -eq 0 ]]; then
  echo "Secret $SECRET_NAME already has all requested keys. Nothing changed."
  exit 0
fi

patch_file="$tmp_dir/patch.json"
{
  printf '{"data":{'
  for i in "${!STAGED_KEYS[@]}"; do
    encoded="$(base64 < "${STAGED_FILES[$i]}" | tr -d '\n')"
    [[ "$i" -gt 0 ]] && printf ','
    printf '"%s":"%s"' "${STAGED_KEYS[$i]}" "$encoded"
  done
  printf '}}'
} > "$patch_file"

kubectl patch secret "$SECRET_NAME" -n "$NAMESPACE" --type=merge --patch-file "$patch_file"
echo "Patched only missing keys on Secret $SECRET_NAME in namespace $NAMESPACE."
