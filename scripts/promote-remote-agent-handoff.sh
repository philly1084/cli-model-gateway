#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/promote-remote-agent-handoff.sh <immutable-image> [--apply]

The default is a server-side dry run. --apply requires:
  ALLOW_PROD_WRITE=yes
  HUMAN_APPROVED=yes
  CHANGE_TICKET=<ticket id>

Ticket ids are 2-128 characters, start with a letter or digit, and contain only
letters, digits, periods, underscores, colons, slashes, or hyphens.

Both modes first read the current live gateway ConfigMap and require the exact
Kimi K3 CLI session bridge contract. The script never replaces providers.yaml.

Accepted image forms:
  ghcr.io/philly1084/cli-model-gateway:sha-<40 hex commit>
  ghcr.io/philly1084/cli-model-gateway@sha256:<64 hex digest>
EOF
}

image="${1:-}"
mode="${2:---dry-run}"
namespace="${ROUTER_NAMESPACE:-n8n-openai-gateway}"
deployment="${ROUTER_DEPLOYMENT:-n8n-openai-cli-gateway}"
configmap="${ROUTER_CONFIGMAP:-n8n-openai-cli-gateway-config}"
container="gateway"
overlay="remote-cli-tail-hotfix"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_bin="${NODE_EXECUTABLE:-node}"
kubectl_bin="${KUBECTL_EXECUTABLE:-kubectl}"

if [[ -z "${image}" || "${image}" == "--help" || "${image}" == "-h" ]]; then
  usage
  exit 2
fi

if [[ ! "${image}" =~ ^ghcr\.io/philly1084/cli-model-gateway:sha-[0-9a-f]{40}$ \
  && ! "${image}" =~ ^ghcr\.io/philly1084/cli-model-gateway@sha256:[0-9a-f]{64}$ ]]; then
  echo "Refusing a mutable or unexpected router image: ${image}" >&2
  exit 2
fi

if [[ "${mode}" != "--dry-run" && "${mode}" != "--apply" ]]; then
  usage
  exit 2
fi

if ! command -v "${kubectl_bin}" >/dev/null 2>&1; then
  echo "kubectl is required (resolved ${kubectl_bin})." >&2
  exit 2
fi

if ! command -v "${node_bin}" >/dev/null 2>&1; then
  echo "Node.js is required (resolved ${node_bin})." >&2
  exit 2
fi

preflight_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "${preflight_dir}"
}
trap cleanup EXIT
providers_file="${preflight_dir}/providers.yaml"

if ! "${kubectl_bin}" get configmap "${configmap}" -n "${namespace}" \
  -o "jsonpath={.data.providers\\.yaml}" >"${providers_file}"; then
  echo "Unable to read providers.yaml from live ConfigMap ${configmap}." >&2
  exit 1
fi
if [[ ! -s "${providers_file}" ]]; then
  echo "Live ConfigMap ${configmap} has no non-empty providers.yaml." >&2
  exit 1
fi
if ! "${node_bin}" "${script_dir}/check-kimi-k3-provider-config.mjs" "${providers_file}"; then
  echo "Refusing promotion: live ConfigMap ${configmap} does not satisfy the Kimi K3 CLI gate." >&2
  exit 1
fi

current_image="$("${kubectl_bin}" get deployment "${deployment}" -n "${namespace}" \
  -o "jsonpath={.spec.template.spec.containers[?(@.name=='${container}')].image}")"
if [[ -z "${current_image}" ]]; then
  echo "Unable to resolve the current ${container} image." >&2
  exit 1
fi

patch="$(cat <<EOF
spec:
  template:
    spec:
      containers:
        - name: ${container}
          image: ${image}
          volumeMounts:
            - name: ${overlay}
              mountPath: /app/dist/jobs/remote-cli-tool-manager.js
              \$patch: delete
      volumes:
        - name: ${overlay}
          \$patch: delete
EOF
)"

echo "namespace=${namespace}"
echo "deployment=${deployment}"
echo "providers_configmap=${configmap}"
echo "verified_kimi_model=k3"
echo "current_image=${current_image}"
echo "requested_image=${image}"
echo "rollback=kubectl rollout undo deployment/${deployment} -n ${namespace}"
echo "note=the ${overlay} ConfigMap is retained but unmounted until post-canary cleanup"

"${kubectl_bin}" patch deployment "${deployment}" -n "${namespace}" \
  --type=strategic \
  --patch "${patch}" \
  --dry-run=server \
  -o name

if [[ "${mode}" == "--dry-run" ]]; then
  echo "decision=dry_run_pass"
  exit 0
fi

if [[ "${ALLOW_PROD_WRITE:-}" != "yes" \
  || "${HUMAN_APPROVED:-}" != "yes" \
  || ! "${CHANGE_TICKET:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$ ]]; then
  echo "Production apply requires ALLOW_PROD_WRITE=yes, HUMAN_APPROVED=yes, and a non-whitespace CHANGE_TICKET id." >&2
  exit 3
fi

echo "change_ticket=${CHANGE_TICKET}"
"${kubectl_bin}" patch deployment "${deployment}" -n "${namespace}" \
  --type=strategic \
  --patch "${patch}"
"${kubectl_bin}" rollout status "deployment/${deployment}" -n "${namespace}" --timeout=300s

actual_image="$("${kubectl_bin}" get deployment "${deployment}" -n "${namespace}" \
  -o "jsonpath={.spec.template.spec.containers[?(@.name=='${container}')].image}")"
if [[ "${actual_image}" != "${image}" ]]; then
  echo "Rollout image mismatch: expected ${image}, received ${actual_image}." >&2
  exit 1
fi

mounts="$("${kubectl_bin}" get deployment "${deployment}" -n "${namespace}" \
  -o "jsonpath={range .spec.template.spec.containers[?(@.name=='${container}')].volumeMounts[*]}{.name}={.mountPath}{'\n'}{end}")"
volumes="$("${kubectl_bin}" get deployment "${deployment}" -n "${namespace}" \
  -o "jsonpath={range .spec.template.spec.volumes[*]}{.name}{'\n'}{end}")"
if grep -Eq "(^|=)${overlay}(=|$)|=/app/dist/" <<<"${mounts}" \
  || grep -Fxq "${overlay}" <<<"${volumes}"; then
  echo "The code-shadow overlay is still active after rollout." >&2
  exit 1
fi

echo "verified_image=${actual_image}"
echo "verified_overlay=absent"
echo "decision=rollout_pass_pending_agent_canaries"
