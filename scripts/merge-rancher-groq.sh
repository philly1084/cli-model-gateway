#!/usr/bin/env bash
set -euo pipefail

INPUT_PATH="kubernetes/rancher-install.yaml"
OUTPUT_PATH="kubernetes/rancher-install-groq.yaml"
GROQ_API_KEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)
      INPUT_PATH="$2"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="$2"
      shift 2
      ;;
    --groq-api-key)
      GROQ_API_KEY="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--input path] [--output path] [--groq-api-key key]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$INPUT_PATH" ]]; then
  echo "Input file not found: $INPUT_PATH" >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

cat > "$TMP_FILE" <<'EOF'
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
EOF

awk \
  -v groq_provider_file="$TMP_FILE" \
  '
  BEGIN {
    provider_added = 0
    provider_exists = 0
    env_added = 0
    env_exists = 0
    inside_providers = 0
    saw_admin_env = 0
  }
  {
    line = $0

    if (line ~ /^  providers.yaml: \|$/) {
      inside_providers = 1
    }
    if (line ~ /^[[:space:]]*- id:[[:space:]]*groq-api[[:space:]]*$/) {
      provider_exists = 1
    }
    if (line ~ /^[[:space:]]*- name:[[:space:]]*GROQ_API_KEY[[:space:]]*$/) {
      env_exists = 1
    }
    if (!env_exists && line ~ /^            - name: ADMIN_API_KEY$/) {
      saw_admin_env = 1
    }

    if (inside_providers && !provider_exists && !provider_added && line ~ /^      - id: deepseek-api$/) {
      while ((getline provider_line < groq_provider_file) > 0) {
        print provider_line
      }
      close(groq_provider_file)
      provider_added = 1
    }

    print line

    if (saw_admin_env && !env_exists && !env_added && line ~ /^                  key: adminApiKey$/) {
      print "            - name: GROQ_API_KEY"
      print "              valueFrom:"
      print "                secretKeyRef:"
      print "                  name: n8n-openai-cli-gateway-secrets"
      print "                  key: groqApiKey"
      print "                  optional: true"
      env_added = 1
      saw_admin_env = 0
    }
  }
  END {
    if (!env_exists && !env_added) {
      print "Failed to add GROQ_API_KEY env entry." > "/dev/stderr"
      exit 1
    }
    if (!provider_exists && !provider_added) {
      print "Failed to add Groq provider block before deepseek-api." > "/dev/stderr"
      exit 1
    }
  }
  ' "$INPUT_PATH" > "$OUTPUT_PATH"

echo "Wrote merged Groq Rancher manifest to $OUTPUT_PATH"
if [[ -n "$GROQ_API_KEY" ]]; then
  echo "Did not write the Groq API key into YAML. Add it safely with scripts/ensure-gateway-secrets.sh."
fi
