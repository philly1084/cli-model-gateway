import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PREFLIGHT_SCRIPT = path.join(REPO_ROOT, "scripts", "check-k8s-dist-overlays.mjs");

test("Kubernetes dist overlay preflight accepts the checked-in manifests", () => {
  const result = runPreflight(path.join(REPO_ROOT, "kubernetes"));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed/);
});

test("Kubernetes dist overlay preflight rejects ConfigMap code mounted under app dist", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nuts-k8s-preflight-"));
  try {
    await writeFile(
      path.join(directory, "deployment.yaml"),
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: unsafe-overlay
spec:
  selector:
    matchLabels:
      app: unsafe-overlay
  template:
    metadata:
      labels:
        app: unsafe-overlay
    spec:
      containers:
        - name: gateway
          image: example.invalid/gateway@sha256:deadbeef
          volumeMounts:
            - name: runtime-code
              mountPath: /app/dist/jobs/router.js
              subPath: router.js
      volumes:
        - name: runtime-code
          configMap:
            name: runtime-code-hotfix
`,
      "utf8",
    );

    const result = runPreflight(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime-code-hotfix/);
    assert.match(result.stderr, /\/app\/dist\/jobs\/router\.js/);
    assert.match(result.stderr, /forbidden/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runPreflight(target: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [PREFLIGHT_SCRIPT, target], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
