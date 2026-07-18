#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/promote-remote-agent-handoff.sh <digest-pinned-image> [--apply]

The default is a server-side dry run. --apply requires:
  ALLOW_PROD_WRITE=yes
  HUMAN_APPROVED=yes
  CHANGE_TICKET=<ticket id>

Ticket ids are 2-128 characters, start with a letter or digit, and contain only
letters, digits, periods, underscores, colons, slashes, or hyphens.

Both modes require a signed GitHub build-provenance attestation from the
canonical main branch, the exact live Codex/Kimi remote-agent provider contract, and the exact
known Deployment mount/volume shape. Promotion creates or reuses a
content-addressed immutable providers ConfigMap and points the new pod template
at that snapshot.

Accepted image form:
  ghcr.io/philly1084/cli-model-gateway@sha256:<64 hex digest>
EOF
}

image="${1:-}"
mode="${2:---dry-run}"
namespace="${ROUTER_NAMESPACE:-n8n-openai-gateway}"
deployment="${ROUTER_DEPLOYMENT:-n8n-openai-cli-gateway}"
configmap="${ROUTER_CONFIGMAP:-n8n-openai-cli-gateway-config}"
container="gateway"
provider_volume="providers-config"
overlay="remote-cli-tail-hotfix"
overlay_mount_path="/app/dist/jobs/remote-cli-tool-manager.js"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_bin="${NODE_EXECUTABLE:-node}"
kubectl_bin="${KUBECTL_EXECUTABLE:-kubectl}"
gh_bin="${GH_EXECUTABLE:-gh}"
provenance_repository="${ROUTER_PROVENANCE_REPOSITORY:-philly1084/cli-model-gateway}"
provenance_workflow="${ROUTER_PROVENANCE_WORKFLOW:-philly1084/cli-model-gateway/.github/workflows/build.yml}"

if [[ -z "${image}" || "${image}" == "--help" || "${image}" == "-h" ]]; then
  usage
  exit 2
fi

if [[ ! "${image}" =~ ^ghcr\.io/philly1084/cli-model-gateway@sha256:[0-9a-f]{64}$ ]]; then
  echo "Refusing a mutable, non-digest, or unexpected router image: ${image}" >&2
  exit 2
fi

if [[ "${mode}" != "--dry-run" && "${mode}" != "--apply" ]]; then
  usage
  exit 2
fi

for executable in "${kubectl_bin}" "${node_bin}" "${gh_bin}"; do
  if ! command -v "${executable}" >/dev/null 2>&1; then
    echo "Required executable is unavailable: ${executable}." >&2
    exit 2
  fi
done

verified_source_ref=""
verify_signed_provenance() {
  local source_ref="refs/heads/main"
  if "${gh_bin}" attestation verify "oci://${image}" \
    --repo "${provenance_repository}" \
    --signer-workflow "${provenance_workflow}" \
    --source-ref "${source_ref}" \
    --deny-self-hosted-runners >/dev/null 2>&1; then
    verified_source_ref="${source_ref}"
    return 0
  fi
  echo "Refusing promotion: no trusted signed build provenance from the canonical main branch verifies this image digest." >&2
  return 1
}

if ! verify_signed_provenance; then
  exit 1
fi

preflight_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "${preflight_dir}"
}
trap cleanup EXIT
providers_file="${preflight_dir}/providers.yaml"
preapply_providers_file="${preflight_dir}/providers.preapply.yaml"
prepatch_providers_file="${preflight_dir}/providers.prepatch.yaml"
postapply_providers_file="${preflight_dir}/providers.postapply.yaml"
snapshot_manifest_file="${preflight_dir}/provider-snapshot.manifest.json"
snapshot_observed_file="${preflight_dir}/provider-snapshot.observed.json"
snapshot_resource_version=""
snapshot_image=""

read_configmap_snapshot() {
  local destination="$1"
  local label="$2"
  local resource_version_before=""
  local resource_version_after=""

  if ! resource_version_before="$("${kubectl_bin}" get configmap "${configmap}" -n "${namespace}" \
    -o "jsonpath={.metadata.resourceVersion}")"; then
    echo "Unable to read ${label} ConfigMap resourceVersion from ${configmap}." >&2
    return 1
  fi
  if ! "${kubectl_bin}" get configmap "${configmap}" -n "${namespace}" \
    -o "jsonpath={.data.providers\\.yaml}" >"${destination}"; then
    echo "Unable to read ${label} providers.yaml from live ConfigMap ${configmap}." >&2
    return 1
  fi
  if ! resource_version_after="$("${kubectl_bin}" get configmap "${configmap}" -n "${namespace}" \
    -o "jsonpath={.metadata.resourceVersion}")"; then
    echo "Unable to reread ${label} ConfigMap resourceVersion from ${configmap}." >&2
    return 1
  fi
  if [[ -z "${resource_version_before}" || "${resource_version_before}" != "${resource_version_after}" ]]; then
    echo "Live ConfigMap ${configmap} changed while reading the ${label} remote-agent provider snapshot." >&2
    return 1
  fi
  if [[ ! -s "${destination}" ]]; then
    echo "Live ConfigMap ${configmap} has no non-empty providers.yaml." >&2
    return 1
  fi
  if ! "${node_bin}" "${script_dir}/check-remote-agent-provider-config.mjs" "${destination}"; then
    echo "Refusing promotion: ${label} ConfigMap ${configmap} does not satisfy the Codex/Kimi remote-agent gate." >&2
    return 1
  fi
  snapshot_resource_version="${resource_version_after}"
}

read_deployment_snapshot() {
  local label="$1"
  local phase="$2"
  local expected_provider_configmap="$3"
  local expected_image="${4:-}"
  local destination="${preflight_dir}/deployment-${label}.json"
  local validation=""

  if ! "${kubectl_bin}" get deployment "${deployment}" -n "${namespace}" -o json >"${destination}"; then
    echo "Unable to read the ${label} Deployment." >&2
    return 1
  fi
  if ! validation="$("${node_bin}" "${script_dir}/check-remote-agent-promotion-deployment.mjs" \
    "${destination}" "${namespace}" "${deployment}" "${expected_provider_configmap}" "${phase}" "${expected_image}")"; then
    echo "Refusing promotion: ${label} Deployment mount/volume contract differs from the expected release shape." >&2
    return 1
  fi
  IFS=$'\t' read -r snapshot_resource_version snapshot_image <<<"${validation}"
  if [[ -z "${snapshot_resource_version}" || -z "${snapshot_image}" ]]; then
    echo "Unable to resolve the ${label} Deployment resourceVersion or image." >&2
    return 1
  fi
}

verify_snapshot_file() {
  local file="$1"
  "${node_bin}" "${script_dir}/remote-agent-promotion-config-snapshot.mjs" verify \
    "${file}" "${providers_file}" "${image}" "${namespace}" "${configmap}" >/dev/null
}

read_existing_snapshot() {
  : >"${snapshot_observed_file}"
  "${kubectl_bin}" get configmap "${provider_snapshot}" -n "${namespace}" \
    --ignore-not-found -o json >"${snapshot_observed_file}"
}

preflight_provider_snapshot() {
  if ! read_existing_snapshot; then
    echo "Unable to inspect immutable provider snapshot ${provider_snapshot}." >&2
    return 1
  fi
  if [[ -s "${snapshot_observed_file}" ]]; then
    verify_snapshot_file "${snapshot_observed_file}"
    return
  fi
  "${kubectl_bin}" create --dry-run=server -f "${snapshot_manifest_file}" -o name >/dev/null
}

ensure_provider_snapshot() {
  if ! read_existing_snapshot; then
    echo "Unable to inspect immutable provider snapshot ${provider_snapshot}." >&2
    return 1
  fi
  if [[ -s "${snapshot_observed_file}" ]]; then
    verify_snapshot_file "${snapshot_observed_file}"
    return
  fi
  "${kubectl_bin}" create -f "${snapshot_manifest_file}" -o name >/dev/null
  read_existing_snapshot
  if [[ ! -s "${snapshot_observed_file}" ]]; then
    echo "Immutable provider snapshot ${provider_snapshot} was not readable after creation." >&2
    return 1
  fi
  verify_snapshot_file "${snapshot_observed_file}"
}

json_string() {
  "${node_bin}" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

if ! read_configmap_snapshot "${providers_file}" "initial"; then
  exit 1
fi
initial_config_resource_version="${snapshot_resource_version}"

if ! provider_snapshot="$("${node_bin}" "${script_dir}/remote-agent-promotion-config-snapshot.mjs" build \
  "${providers_file}" "${image}" "${namespace}" "${configmap}" "${snapshot_manifest_file}")"; then
  echo "Unable to construct the immutable provider ConfigMap snapshot." >&2
  exit 1
fi
if ! preflight_provider_snapshot; then
  echo "Refusing promotion: immutable provider snapshot preflight failed." >&2
  exit 1
fi

if ! read_deployment_snapshot "initial" "before" "${configmap}"; then
  exit 1
fi
deployment_resource_version="${snapshot_resource_version}"
current_image="${snapshot_image}"
deployment_resource_version_json="$(json_string "${deployment_resource_version}")"
image_json="$(json_string "${image}")"
provider_snapshot_json="$(json_string "${provider_snapshot}")"

patch="$(cat <<EOF
metadata:
  resourceVersion: ${deployment_resource_version_json}
spec:
  template:
    spec:
      containers:
        - name: ${container}
          image: ${image_json}
          volumeMounts:
            - mountPath: ${overlay_mount_path}
              \$patch: delete
      initContainers:
        - name: gemini-bootstrap
          image: ${image_json}
        - name: kimi-bootstrap
          image: ${image_json}
        - name: gemini-auth-bootstrap
          image: ${image_json}
      volumes:
        - name: ${provider_volume}
          configMap:
            name: ${provider_snapshot_json}
        - name: ${overlay}
          \$patch: delete
EOF
)"

echo "namespace=${namespace}"
echo "deployment=${deployment}"
echo "providers_configmap=${configmap}"
echo "provider_snapshot=${provider_snapshot}"
echo "verified_kimi_model=k3"
echo "verified_source_ref=${verified_source_ref}"
echo "current_image=${current_image}"
echo "requested_image=${image}"
echo "rollback=kubectl rollout undo deployment/${deployment} -n ${namespace}"
echo "note=source ConfigMap and ${overlay} are retained; promoted pods mount the immutable content-addressed provider snapshot"

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

if ! read_configmap_snapshot "${preapply_providers_file}" "pre-apply"; then
  exit 1
fi
if [[ "${snapshot_resource_version}" != "${initial_config_resource_version}" ]] \
  || ! cmp -s -- "${providers_file}" "${preapply_providers_file}"; then
  echo "Refusing promotion: live Kimi provider ConfigMap changed after the server-side dry run." >&2
  exit 1
fi

if ! read_deployment_snapshot "pre-apply" "before" "${configmap}"; then
  exit 1
fi
if [[ "${snapshot_resource_version}" != "${deployment_resource_version}" \
  || "${snapshot_image}" != "${current_image}" ]]; then
  echo "Refusing promotion: Deployment ${deployment} changed after the server-side dry run." >&2
  exit 1
fi

if ! ensure_provider_snapshot; then
  echo "Refusing promotion: immutable provider snapshot creation or verification failed." >&2
  exit 1
fi

if ! read_configmap_snapshot "${prepatch_providers_file}" "pre-patch"; then
  exit 1
fi
if [[ "${snapshot_resource_version}" != "${initial_config_resource_version}" ]] \
  || ! cmp -s -- "${providers_file}" "${prepatch_providers_file}"; then
  echo "Refusing promotion: live Kimi provider ConfigMap changed before the Deployment patch." >&2
  exit 1
fi

if ! read_deployment_snapshot "pre-patch" "before" "${configmap}"; then
  exit 1
fi
if [[ "${snapshot_resource_version}" != "${deployment_resource_version}" \
  || "${snapshot_image}" != "${current_image}" ]]; then
  echo "Refusing promotion: Deployment ${deployment} changed before the guarded patch." >&2
  exit 1
fi

echo "change_ticket=${CHANGE_TICKET}"
"${kubectl_bin}" patch deployment "${deployment}" -n "${namespace}" \
  --type=strategic \
  --patch "${patch}"
"${kubectl_bin}" rollout status "deployment/${deployment}" -n "${namespace}" --timeout=300s

if ! read_deployment_snapshot "post-apply" "after" "${provider_snapshot}" "${image}"; then
  exit 1
fi
actual_image="${snapshot_image}"

if ! read_existing_snapshot || [[ ! -s "${snapshot_observed_file}" ]] \
  || ! verify_snapshot_file "${snapshot_observed_file}"; then
  echo "Immutable provider snapshot ${provider_snapshot} failed post-rollout verification." >&2
  exit 1
fi

if ! read_configmap_snapshot "${postapply_providers_file}" "post-apply"; then
  exit 1
fi
if [[ "${snapshot_resource_version}" != "${initial_config_resource_version}" ]] \
  || ! cmp -s -- "${providers_file}" "${postapply_providers_file}"; then
  echo "The live Kimi provider ConfigMap changed during router promotion." >&2
  exit 1
fi

echo "verified_image=${actual_image}"
echo "verified_bootstrap_images=${actual_image}"
echo "verified_provider_snapshot=${provider_snapshot}"
echo "verified_overlay=absent"
echo "decision=rollout_pass_pending_agent_canaries"
