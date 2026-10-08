# Application-only promotion proposal

Status: prepared and tested. The operator must obtain explicit approval for preservation mode and the Kimi startup change before live use; publication alone is not deployment approval. Existing full-promotion scripts and their validation rules remain unchanged.

## Exact mutation

The Kubernetes JSON Patch contains a resourceVersion test and two replacements:

1. The gateway container image becomes a canonical `ghcr.io/philly1084/cli-model-gateway@sha256:...` release.
2. The Kimi bootstrap command becomes a check of the existing executable and exact installed package version. Isolated Python reads package metadata with `-I -S -B`; it does not launch Kimi, install, upgrade, initialize site packages or write bytecode.

All bootstrap image references and running image config digests, the mounted immutable provider ConfigMap name/UID/resourceVersion/content hash, deployment spec, unrelated metadata, node identity and existing credentials remain bound to the reviewed baseline. No Secret contents or provider values are written to review artifacts. Gemini executable and auth-file presence are prerequisites; auth contents are never read.

## Evidence and rejection gates

The release proof binds raw OCI root/index bytes to the ARM64 manifest and image-config digest. Actual `gh attestation verify` remains mandatory for dry-run, apply and rollback, restricted to the repository build workflow, main branch, exact source commit and hosted runner. There is no unsigned-image or local-image target exception.

The operator must already have the canonical release and rollback/bootstrap images cached on the exact deployment node. The inventory helper only runs existing `k3s crictl inspecti`; the proof helper only reads existing containerd content. Neither downloads images. Node-cache identities are checked before and after admission and after rollout.

Server-side dry-run must produce exactly the reviewed patch. Fresh state, package metadata and cache observations are checked immediately before application. A JSON Patch resourceVersion test protects the deployment write. Admission changes, unrelated deployment changes, provider replacement/content drift, image mismatches, unexpected ownership, multiple pods, incomplete rollouts or changed tool prerequisites cause refusal.

## Operator sequence after approval

Use an existing trusted execution route for authenticated `gh`, private Kubernetes operations and node-local inventory. `GH_EXECUTABLE`, `KUBECTL_EXECUTABLE`, `IMAGE_INVENTORY_EXECUTABLE` and `K3S_EXECUTABLE` select executable paths; they are not shell command strings. This proposal does not install tools or create remote-access credentials. An approved operator adapter still needs to be reviewed because authenticated gh is currently on MSI while Kubernetes/cache access is on the primary server.

1. Complete the normal reviewed main-branch CI publication and obtain its canonical attested digest and exact source commit. PR build artifacts are insufficient.
2. With the exact canonical image already available through the approved release workflow, run `node scripts/build-application-release-proof.mjs <canonical-image@digest> <source-commit> <new-proof-file>` on the node. Review its reported SHA-256.
3. Run `node scripts/promote-application-preserving-state.mjs capture --baseline <new-baseline-file>`. Review the returned baseline SHA-256 and deployment scope. Capture reads live state; it does not patch it.
4. Run the promoter in `dry-run` mode with `--baseline`, `--baseline-sha256`, `--release` and `--release-sha256`. Both hashes are required and must identify the reviewed artifacts.
5. Only after approval and a successful dry-run, use the same arguments with `apply`, a new `--receipt` path, and `ALLOW_PROD_WRITE=yes`, `HUMAN_APPROVED=yes`, `CHANGE_TICKET=<approved-reference>`.
6. Verify real router health and bounded application acceptance separately. A successful rollout does not establish model/provider or Brain end-to-end acceptance.

## Rollback and limits

Rollback uses the matching receipt, the same reviewed artifacts and provenance gates. By default it restores the original gateway image while retaining the check-only Kimi command. Restoring the original startup command requires both `--restore-original-startup yes` and `ACKNOWLEDGE_STARTUP_UPGRADE=yes`, because that command can upgrade the persistent Kimi package. Neither rollback path restores PVC contents or claims to do so.

A receipt is written before mutation and remains `needs-verification` if the client or postchecks fail. The tool never automatically applies another change after a failed verification. A failed or partially completed rollout needs operator review: the strict normal rollback requires one stable ready owned pod and an otherwise matching post-promotion state. A terminating old pod may temporarily prevent that check even after Kubernetes reports rollout success. Do not weaken these gates to force recovery; prepare a separately reviewed recovery patch if the stable-state prerequisites cannot be met.

Kubernetes observations across objects and filesystem metadata are not a distributed transaction. ResourceVersion, immutable content, exact image checks and repeated observations detect drift, but do not freeze the PVC or prevent independent concurrent writers. Package metadata checks establish version and presence, not a complete filesystem-integrity proof.

## Validation

The offline Linux ARM64 run passed all 126 tests, with zero failures or skips: 77 existing release/promotion/canary tests and 49 new preservation tests. Coverage includes pure contract validation, digest-chain corruption, provenance rejection, drift/admission denial, image-cache identity, approval gates, interrupted-apply receipts, both rollback policies, actual isolated Python execution, and the real CLI wired to fake kubectl/gh/k3s executables. Tests used no network and no production credentials, with a read-only nonroot container, dropped capabilities and no-new-privileges. Existing full-promotion behavior remains covered by its unchanged tests.

These are offline tests. Live capture, actual operator adapters, canonical release preparation, authenticated server dry-run, deployment, real provider requests and Brain acceptance remain outstanding.
