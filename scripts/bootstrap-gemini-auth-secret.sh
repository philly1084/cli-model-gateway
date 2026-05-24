#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="n8n-openai-gateway"
DEPLOYMENT_NAME="n8n-openai-cli-gateway"
CONTAINER_NAME="gateway"
SECRET_NAME="n8n-openai-cli-gateway-gemini-auth"
SOURCE_DIR=""
POD_NAME=""
GEMINI_HOME="/var/lib/gateway-home/.gemini"
OVERWRITE_SECRET="false"
FILES=(
  oauth_creds.json
  google_accounts.json
  installation_id
  settings.json
  state.json
  trustedFolders.json
  projects.json
)

usage() {
  cat <<'EOF'
Usage:
  ./scripts/bootstrap-gemini-auth-secret.sh [options]

Options:
  --namespace NAME        Kubernetes namespace. Default: n8n-openai-gateway
  --deployment NAME       Deployment name used to discover a pod. Default: n8n-openai-cli-gateway
  --container NAME        Container name to read from. Default: gateway
  --secret-name NAME      Secret to create/update. Default: n8n-openai-cli-gateway-gemini-auth
  --pod NAME              Read Gemini auth directly from this pod instead of auto-discovery
  --source-dir PATH       Read Gemini auth from a local directory instead of Kubernetes
  --gemini-home PATH      Remote Gemini auth directory. Default: /var/lib/gateway-home/.gemini
  --overwrite             Replace the Secret if it already exists
  --help                  Show this help

Examples:
  ./scripts/bootstrap-gemini-auth-secret.sh
  ./scripts/bootstrap-gemini-auth-secret.sh --source-dir "$HOME/.gemini"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    --deployment)
      DEPLOYMENT_NAME="${2:-}"
      shift 2
      ;;
    --container)
      CONTAINER_NAME="${2:-}"
      shift 2
      ;;
    --secret-name)
      SECRET_NAME="${2:-}"
      shift 2
      ;;
    --pod)
      POD_NAME="${2:-}"
      shift 2
      ;;
    --source-dir)
      SOURCE_DIR="${2:-}"
      shift 2
      ;;
    --gemini-home)
      GEMINI_HOME="${2:-}"
      shift 2
      ;;
    --overwrite)
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

if [[ "$OVERWRITE_SECRET" != "true" ]] && kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "Secret $SECRET_NAME already exists in namespace $NAMESPACE. Nothing changed."
  echo "Pass --overwrite only when you intentionally want to refresh the stored Gemini auth Secret."
  exit 0
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
stage_dir="$tmp_dir/gemini"
mkdir -p "$stage_dir"

copy_local_files() {
  if [[ ! -d "$SOURCE_DIR" ]]; then
    echo "Source directory not found: $SOURCE_DIR" >&2
    exit 1
  fi

  for file in "${FILES[@]}"; do
    if [[ -f "$SOURCE_DIR/$file" ]]; then
      cp "$SOURCE_DIR/$file" "$stage_dir/$file"
    fi
  done
}

discover_pod() {
  if [[ -n "$POD_NAME" ]]; then
    return
  fi

  POD_NAME="$(
    kubectl get pods \
      -n "$NAMESPACE" \
      -l "app=$DEPLOYMENT_NAME" \
      -o jsonpath='{.items[0].metadata.name}'
  )"

  if [[ -z "$POD_NAME" ]]; then
    echo "Unable to find a pod for deployment $DEPLOYMENT_NAME in namespace $NAMESPACE." >&2
    exit 1
  fi
}

copy_pod_files() {
  discover_pod

  for file in "${FILES[@]}"; do
    remote_file="$GEMINI_HOME/$file"
    if kubectl exec -n "$NAMESPACE" "$POD_NAME" -c "$CONTAINER_NAME" -- sh -lc "test -f '$remote_file'" >/dev/null 2>&1; then
      kubectl exec -n "$NAMESPACE" "$POD_NAME" -c "$CONTAINER_NAME" -- sh -lc "cat '$remote_file'" > "$stage_dir/$file"
    fi
  done
}

if [[ -n "$SOURCE_DIR" ]]; then
  copy_local_files
else
  copy_pod_files
fi

if [[ ! -f "$stage_dir/oauth_creds.json" ]]; then
  echo "oauth_creds.json was not found in the selected source. Nothing was written." >&2
  exit 1
fi

secret_args=()
for file_path in "$stage_dir"/*; do
  [[ -f "$file_path" ]] || continue
  secret_args+=(--from-file="$(basename "$file_path")=$file_path")
done

kubectl create secret generic "$SECRET_NAME" \
  -n "$NAMESPACE" \
  "${secret_args[@]}"

echo "Created secret $SECRET_NAME in namespace $NAMESPACE."
echo "Restart the deployment to reseed an empty PVC:"
echo "kubectl rollout restart deployment/$DEPLOYMENT_NAME -n $NAMESPACE"
