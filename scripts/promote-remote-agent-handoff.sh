#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/promote-remote-agent-handoff.sh <immutable-image> [--apply]

The default is a server-side dry run. --apply requires:
  ALLOW_PROD_WRITE=yes
  HUMAN_APPROVED=yes
  CHANGE_TICKET=<non-empty id>

Accepted image forms:
  ghcr.io/philly1084/cli-model-gateway:sha-<40 hex commit>
  ghcr.io/philly1084/cli-model-gateway@sha256:<64 hex digest>
EOF
}

image="${1:-}"
mode="${2:---dry-run}"
namespace="${ROUTER_NAMESPACE:-n8n-openai-gateway}"
deployment="${ROUTER_DEPLOYMENT:-n8n-openai-cli-gateway}"
container="gateway"
overlay="remote-cli-tail-hotfix"

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

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required." >&2
  exit 2
fi

current_image="$(kubectl get deployment "${deployment}" -n "${namespace}" \
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
echo "current_image=${current_image}"
echo "requested_image=${image}"
echo "rollback=kubectl rollout undo deployment/${deployment} -n ${namespace}"
echo "note=the ${overlay} ConfigMap is retained but unmounted until post-canary cleanup"

if [[ "${mode}" == "--dry-run" ]]; then
  kubectl patch deployment "${deployment}" -n "${namespace}" \
    --type=strategic \
    --patch "${patch}" \
    --dry-run=server \
    -o name
  echo "decision=dry_run_pass"
  exit 0
fi

if [[ "${ALLOW_PROD_WRITE:-}" != "yes" \
  || "${HUMAN_APPROVED:-}" != "yes" \
  || -z "${CHANGE_TICKET:-}" ]]; then
  echo "Production apply requires ALLOW_PROD_WRITE=yes, HUMAN_APPROVED=yes, and CHANGE_TICKET." >&2
  exit 3
fi

echo "change_ticket=${CHANGE_TICKET}"
kubectl patch deployment "${deployment}" -n "${namespace}" \
  --type=strategic \
  --patch "${patch}"
kubectl rollout status "deployment/${deployment}" -n "${namespace}" --timeout=300s

actual_image="$(kubectl get deployment "${deployment}" -n "${namespace}" \
  -o "jsonpath={.spec.template.spec.containers[?(@.name=='${container}')].image}")"
if [[ "${actual_image}" != "${image}" ]]; then
  echo "Rollout image mismatch: expected ${image}, received ${actual_image}." >&2
  exit 1
fi

mounts="$(kubectl get deployment "${deployment}" -n "${namespace}" \
  -o "jsonpath={range .spec.template.spec.containers[?(@.name=='${container}')].volumeMounts[*]}{.name}={.mountPath}{'\n'}{end}")"
volumes="$(kubectl get deployment "${deployment}" -n "${namespace}" \
  -o "jsonpath={range .spec.template.spec.volumes[*]}{.name}{'\n'}{end}")"
if grep -Eq "(^|=)${overlay}(=|$)|=/app/dist/" <<<"${mounts}" \
  || grep -Fxq "${overlay}" <<<"${volumes}"; then
  echo "The code-shadow overlay is still active after rollout." >&2
  exit 1
fi

echo "verified_image=${actual_image}"
echo "verified_overlay=absent"
echo "decision=rollout_pass_pending_agent_canaries"
