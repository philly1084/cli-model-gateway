#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";

const MANIFEST_EXTENSIONS = new Set([".yaml", ".yml"]);

async function collectManifestFiles(inputs) {
  const files = [];

  async function visit(input) {
    const resolved = path.resolve(input);
    const entry = await stat(resolved);
    if (entry.isDirectory()) {
      const children = await readdir(resolved, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        await visit(path.join(resolved, child.name));
      }
      return;
    }

    if (entry.isFile() && MANIFEST_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      files.push(resolved);
    }
  }

  for (const input of inputs) {
    await visit(input);
  }
  return files;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getConfigMapSource(volume) {
  const direct = asRecord(volume.configMap);
  if (Object.keys(direct).length > 0) {
    return typeof direct.name === "string" ? direct.name : "<unnamed ConfigMap>";
  }

  const projected = asRecord(volume.projected);
  const names = asArray(projected.sources)
    .map((source) => asRecord(asRecord(source).configMap).name)
    .filter((name) => typeof name === "string");
  return names.length > 0 ? names.join(",") : null;
}

export function findForbiddenDistOverlays(manifest, file, documentIndex) {
  const root = asRecord(manifest);
  if (root.kind !== "Deployment") {
    return [];
  }

  const metadata = asRecord(root.metadata);
  const spec = asRecord(asRecord(asRecord(root.spec).template).spec);
  const configMapVolumes = new Map();
  for (const value of asArray(spec.volumes)) {
    const volume = asRecord(value);
    const source = getConfigMapSource(volume);
    if (typeof volume.name === "string" && source) {
      configMapVolumes.set(volume.name, source);
    }
  }

  const containers = [
    ...asArray(spec.initContainers),
    ...asArray(spec.containers),
    ...asArray(spec.ephemeralContainers),
  ];
  const findings = [];
  for (const value of containers) {
    const container = asRecord(value);
    for (const mountValue of asArray(container.volumeMounts)) {
      const mount = asRecord(mountValue);
      if (typeof mount.name !== "string" || typeof mount.mountPath !== "string") {
        continue;
      }
      const configMap = configMapVolumes.get(mount.name);
      if (!configMap) {
        continue;
      }
      const normalizedMountPath = path.posix.normalize(mount.mountPath);
      if (normalizedMountPath !== "/app/dist" && !normalizedMountPath.startsWith("/app/dist/")) {
        continue;
      }
      findings.push({
        file,
        documentIndex,
        deployment: typeof metadata.name === "string" ? metadata.name : "<unnamed Deployment>",
        container: typeof container.name === "string" ? container.name : "<unnamed container>",
        mountPath: mount.mountPath,
        volume: mount.name,
        configMap,
      });
    }
  }
  return findings;
}

export async function checkKubernetesDistOverlays(inputs) {
  const files = await collectManifestFiles(inputs);
  if (files.length === 0) {
    throw new Error("No Kubernetes YAML manifests were found to inspect.");
  }

  const findings = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const documents = parseAllDocuments(source);
    for (const [documentIndex, document] of documents.entries()) {
      if (document.errors.length > 0) {
        const details = document.errors.map((error) => error.message).join("; ");
        throw new Error(`${file} document ${documentIndex + 1} is invalid YAML: ${details}`);
      }
      findings.push(...findForbiddenDistOverlays(document.toJS(), file, documentIndex + 1));
    }
  }

  return { files, findings };
}

async function main() {
  const inputs = process.argv.slice(2);
  const targets = inputs.length > 0 ? inputs : [path.resolve(process.cwd(), "kubernetes")];
  const result = await checkKubernetesDistOverlays(targets);
  if (result.findings.length > 0) {
    for (const finding of result.findings) {
      console.error(
        `${finding.file} document ${finding.documentIndex}: Deployment ${finding.deployment} ` +
        `container ${finding.container} mounts ConfigMap ${finding.configMap} via volume ` +
        `${finding.volume} at ${finding.mountPath}`,
      );
    }
    throw new Error("ConfigMap-backed code overlays under /app/dist are forbidden.");
  }

  console.log(`Kubernetes dist overlay preflight passed (${result.files.length} manifest files).`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
